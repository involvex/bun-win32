/**
 * Deadlock pair worker (helper for deadlock-detector.ts — not a standalone example).
 *
 * Each instance becomes the initial owner of its own named mutex, reports its
 * OS thread id to the parent, then blocks forever waiting on the *other*
 * worker's mutex. Two instances with mirrored (ownName/otherName) form a
 * textbook A↔B mutex deadlock between two real OS threads — exactly the
 * scenario the Wait Chain Traversal API is designed to surface.
 */
import { dlopen, FFIType } from 'bun:ffi';
import { parentPort, workerData } from 'node:worker_threads';

const { role, ownName, otherName } = workerData as { role: string; ownName: string; otherName: string };

const MUTEX_ALL_ACCESS = 0x001f_0001;
const INFINITE = 0xffff_ffff;

const k = dlopen('kernel32.dll', {
  CreateMutexW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.u64 },
  GetCurrentThreadId: { args: [], returns: FFIType.u32 },
  OpenMutexW: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.u64 },
  Sleep: { args: [FFIType.u32], returns: FFIType.void },
  WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
});

const ownNameBuf = Buffer.from(ownName + '\0', 'utf16le');
const otherNameBuf = Buffer.from(otherName + '\0', 'utf16le');

// Become the initial owner of our mutex (bInitialOwner = TRUE).
k.symbols.CreateMutexW(null, 1, ownNameBuf.ptr!);

parentPort!.postMessage({ role, tid: k.symbols.GetCurrentThreadId() });

// Give the peer time to create + own its mutex before we try to take it.
k.symbols.Sleep(600);

let hOther = k.symbols.OpenMutexW(MUTEX_ALL_ACCESS, 0, otherNameBuf.ptr!);
while (hOther === 0n) {
  k.symbols.Sleep(50);
  hOther = k.symbols.OpenMutexW(MUTEX_ALL_ACCESS, 0, otherNameBuf.ptr!);
}

// Block forever on the peer's mutex. The peer is simultaneously blocked on
// ours → genuine kernel deadlock. The parent process force-exits to tear this
// down, so this call intentionally never returns.
k.symbols.WaitForSingleObject(hOther, INFINITE);
