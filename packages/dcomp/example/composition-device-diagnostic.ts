/**
 * DirectComposition Device Diagnostic
 *
 * A thorough, aligned probe of the Microsoft DirectComposition flat surface.
 * It creates a real DirectComposition device with no rendering device
 * (DCompositionCreateDevice2 accepts a NULL renderer for a device-only object),
 * proves it is a live COM object by reading its IUnknown vtable refcount,
 * mints a composition surface handle, and then reads the Windows compositor
 * clock end to end: the CREATED / CONFIRMED / COMPLETED frame ids and the
 * COMPOSITION_FRAME_STATS (start / target / period) for the latest frame,
 * decoded from QPC ticks into real milliseconds and an effective refresh rate.
 * Everything is read-only and runs windowless.
 *
 * APIs demonstrated (Dcomp):
 *   - DCompositionCreateDevice2        (create a device-only DComp device)
 *   - DCompositionCreateSurfaceHandle  (mint a composition surface handle)
 *   - DCompositionGetFrameId           (latest frame id, per status)
 *   - DCompositionGetStatistics        (COMPOSITION_FRAME_STATS for a frame)
 *   - DCompositionBoostCompositorClock (request a higher refresh rate)
 *   - DllCanUnloadNow                  (COM in-proc-server liveness)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *   - QueryPerformanceFrequency / CloseHandle         (QPC tick → ms)
 *
 * Run: bun run example/composition-device-diagnostic.ts
 */
import { CFunction, FFIType, type Pointer, read } from 'bun:ffi';

import Dcomp, { COMPOSITIONOBJECT_ALL_ACCESS, COMPOSITION_FRAME_ID_TYPE } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Dcomp.Preload(['DCompositionCreateDevice2', 'DCompositionCreateSurfaceHandle', 'DCompositionGetFrameId', 'DCompositionGetStatistics', 'DCompositionBoostCompositorClock', 'DllCanUnloadNow']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'QueryPerformanceFrequency', 'CloseHandle']);

const STD_OUTPUT_HANDLE = -11;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr!)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[38;2;90;220;130m';
const RED = '\x1b[38;2;240;110;110m';
const YELLOW = '\x1b[38;2;235;205;100m';
const CYAN = '\x1b[38;2;120;200;255m';
const VIOLET = '\x1b[38;2;195;150;255m';

const S_OK = 0;
const IUNKNOWN_RELEASE = 2; // IUnknown vtable slot order: QueryInterface, AddRef, Release

// IID_IDCompositionDevice, as defined in dcomp.h.
const IID_IDCompositionDevice = 'C37EA93A-E7AA-450D-B16F-9746CB0407F3';

const hex = (hr: number) => '0x' + (hr >>> 0).toString(16).toUpperCase().padStart(8, '0');
const row = (label: string, value: string) => console.log(`  ${DIM}${label.padEnd(34)}${RESET} ${value}`);
const header = (text: string) => console.log(`\n${BOLD}${CYAN}── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}${RESET}`);

function guid(text: string): Buffer {
  const hexDigits = text.replace(/[{}-]/g, '');
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(parseInt(hexDigits.slice(0, 8), 16), 0);
  buffer.writeUInt16LE(parseInt(hexDigits.slice(8, 12), 16), 4);
  buffer.writeUInt16LE(parseInt(hexDigits.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i += 1) buffer[8 + i] = parseInt(hexDigits.slice(16 + i * 2, 18 + i * 2), 16);
  return buffer;
}

// Calls IUnknown::Release via the object's vtable (cast-free invoker pattern).
function releaseObject(thisPtr: bigint): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const release = read.u64(Number(vtable) as Pointer, IUNKNOWN_RELEASE * 8);
  return CFunction({ ptr: Number(release) as Pointer, args: [FFIType.u64], returns: FFIType.u32 })(thisPtr) as number;
}

console.log(`\n${BOLD}${CYAN}╔═══════════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║            MICROSOFT DIRECTCOMPOSITION · DEVICE DIAGNOSTIC            ║${RESET}`);
console.log(`${BOLD}${CYAN}╚═══════════════════════════════════════════════════════════════════════╝${RESET}`);

header('1 · Device creation (DCompositionCreateDevice2, no renderer)');

const iidBuf = guid(IID_IDCompositionDevice);
const deviceOut = Buffer.alloc(8);
const createHr = Dcomp.DCompositionCreateDevice2(null, iidBuf.ptr!, deviceOut.ptr!);
row('DCompositionCreateDevice2', createHr === S_OK ? `${GREEN}S_OK${RESET}` : `${RED}${hex(createHr)}${RESET}`);

let devicePtr = 0n;
if (createHr === S_OK) {
  devicePtr = deviceOut.readBigUInt64LE(0);
  row('IDCompositionDevice*', devicePtr !== 0n ? `${CYAN}0x${devicePtr.toString(16)}${RESET}` : `${RED}null${RESET}`);

  // Read the IUnknown vtable pointer to prove this is a real COM object.
  const vtable = read.u64(Number(devicePtr) as Pointer, 0);
  row('IUnknown vtable', `${VIOLET}0x${vtable.toString(16)}${RESET}`);
}

header('2 · COM in-proc-server liveness');
const canUnload = Dcomp.DllCanUnloadNow();
row('DllCanUnloadNow', canUnload === S_OK ? `${YELLOW}S_OK${RESET} ${DIM}(server idle)${RESET}` : `${GREEN}S_FALSE${RESET} ${DIM}(objects alive — expected)${RESET}`);

header('3 · Composition surface handle');
const surfaceOut = Buffer.alloc(8);
const surfaceHr = Dcomp.DCompositionCreateSurfaceHandle(COMPOSITIONOBJECT_ALL_ACCESS, null, surfaceOut.ptr!);
if (surfaceHr === S_OK) {
  const surfaceHandle = surfaceOut.readBigUInt64LE(0);
  row('DCompositionCreateSurfaceHandle', `${GREEN}S_OK${RESET}`);
  row('Surface HANDLE', `${CYAN}0x${surfaceHandle.toString(16)}${RESET}`);
  Kernel32.CloseHandle(surfaceHandle);
  row('CloseHandle', `${DIM}released${RESET}`);
} else {
  row('DCompositionCreateSurfaceHandle', `${RED}${hex(surfaceHr)}${RESET}`);
}

header('4 · Compositor clock — frame ids & statistics');

const freqBuf = Buffer.alloc(8);
Kernel32.QueryPerformanceFrequency(freqBuf.ptr!);
const qpcFreq = Number(freqBuf.readBigUInt64LE(0)) || 1;
const ticksToMs = (ticks: bigint) => (Number(ticks) / qpcFreq) * 1000;

const frameStages: { name: string; type: COMPOSITION_FRAME_ID_TYPE }[] = [
  { name: 'CREATED   (compositor started frame)', type: COMPOSITION_FRAME_ID_TYPE.COMPOSITION_FRAME_ID_CREATED },
  { name: 'CONFIRMED (CPU work + present done)', type: COMPOSITION_FRAME_ID_TYPE.COMPOSITION_FRAME_ID_CONFIRMED },
  { name: 'COMPLETED (GPU work done)', type: COMPOSITION_FRAME_ID_TYPE.COMPOSITION_FRAME_ID_COMPLETED },
];

let completedFrameId = 0n;
for (const stage of frameStages) {
  const frameIdBuf = Buffer.alloc(8);
  const hr = Dcomp.DCompositionGetFrameId(stage.type, frameIdBuf.ptr!);
  if (hr === S_OK) {
    const id = frameIdBuf.readBigUInt64LE(0);
    if (stage.type === COMPOSITION_FRAME_ID_TYPE.COMPOSITION_FRAME_ID_COMPLETED) completedFrameId = id;
    row(stage.name, `${CYAN}#${id}${RESET}`);
  } else {
    row(stage.name, `${RED}${hex(hr)}${RESET}`);
  }
}

// COMPOSITION_FRAME_STATS = { UINT64 startTime; UINT64 targetTime; UINT64 framePeriod; }
const statsBuf = Buffer.alloc(24);
const actualCountBuf = Buffer.alloc(4);
const statsHr = Dcomp.DCompositionGetStatistics(completedFrameId, statsBuf.ptr!, 0, null, actualCountBuf.ptr!);
if (statsHr === S_OK) {
  const startTime = statsBuf.readBigUInt64LE(0);
  const targetTime = statsBuf.readBigUInt64LE(8);
  const framePeriod = statsBuf.readBigUInt64LE(16);
  const periodMs = ticksToMs(framePeriod);
  row('frame start (QPC ticks)', `${CYAN}${startTime}${RESET}`);
  row('frame target (QPC ticks)', `${CYAN}${targetTime}${RESET}`);
  row('frame period', `${VIOLET}${periodMs.toFixed(3)} ms${RESET} ${DIM}(${framePeriod} ticks)${RESET}`);
  row('effective refresh', `${BOLD}${GREEN}${periodMs > 0 ? (1000 / periodMs).toFixed(2) : '—'} Hz${RESET}`);
  row('render targets in frame', `${CYAN}${actualCountBuf.readUInt32LE(0)}${RESET}`);
} else {
  row('DCompositionGetStatistics', `${YELLOW}${hex(statsHr)}${RESET} ${DIM}(needs Windows 11 build 22000+)${RESET}`);
}

header('5 · Compositor clock boost');
const boostOnHr = Dcomp.DCompositionBoostCompositorClock(1);
row('BoostCompositorClock(TRUE)', boostOnHr === S_OK ? `${GREEN}S_OK${RESET} ${DIM}(higher refresh requested)${RESET}` : `${YELLOW}${hex(boostOnHr)}${RESET}`);
const boostOffHr = Dcomp.DCompositionBoostCompositorClock(0);
row('BoostCompositorClock(FALSE)', boostOffHr === S_OK ? `${GREEN}S_OK${RESET} ${DIM}(boost released)${RESET}` : `${YELLOW}${hex(boostOffHr)}${RESET}`);

if (devicePtr !== 0n) {
  header('6 · Teardown');
  const refs = releaseObject(devicePtr);
  row('IDCompositionDevice::Release', `${GREEN}refcount → ${refs}${RESET}`);
}

console.log('');
