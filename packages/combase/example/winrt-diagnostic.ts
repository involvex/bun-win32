/**
 * Windows Runtime & HSTRING Diagnostic
 *
 * A comprehensive, richly-formatted audit of the Windows Runtime activation
 * core exposed by combase.dll. Five sections, every value labeled and aligned:
 *
 *   1. Runtime Thread State — RoInitialize result decoded, apartment id,
 *      error-propagation flag, and the RO_ERROR_REPORTING_FLAGS bitfield
 *      expanded bit by bit.
 *   2. HSTRING String Engine — for a roster of sample strings, builds an
 *      HSTRING and reports backing length vs JS length, emptiness, embedded
 *      nulls, and a raw-buffer round-trip with ✓/✗ verification.
 *   3. HSTRING Operations Matrix — concat, duplicate (verified via ordinal
 *      compare), substring, replace, and trim, each printed with its result.
 *   4. Fast-Pass & Preallocated Buffers — a stack-backed string reference
 *      (no heap, no delete) and a mutable preallocated buffer promoted into
 *      an immutable HSTRING.
 *   5. WinRT Activation Probe — RoGetActivationFactory against a roster of
 *      well-known runtime classes, reporting which the system can activate.
 *
 * Every wide string is read back from the HSTRING's own backing buffer — no
 * pointer casts beyond the documented Bun FFI address narrowing.
 *
 * APIs demonstrated (Combase):
 *   - RoInitialize / RoUninitialize          (Windows Runtime thread lifetime)
 *   - RoGetApartmentIdentifier               (process-unique apartment id)
 *   - IsErrorPropagationEnabled              (unhandled-error event state)
 *   - RoGetErrorReportingFlags               (RO_ERROR_REPORTING_FLAGS bits)
 *   - WindowsCreateString / WindowsDeleteString / WindowsGetStringLen
 *   - WindowsGetStringRawBuffer / WindowsIsStringEmpty
 *   - WindowsStringHasEmbeddedNull / WindowsCompareStringOrdinal
 *   - WindowsConcatString / WindowsDuplicateString / WindowsSubstring
 *   - WindowsReplaceString / WindowsTrimStringStart / WindowsTrimStringEnd
 *   - WindowsCreateStringReference           (stack-backed fast-pass string)
 *   - WindowsPreallocateStringBuffer / WindowsPromoteStringBuffer
 *   - RoGetActivationFactory                 (activatable runtime classes)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/winrt-diagnostic.ts
 */

import { CFunction, FFIType, type Pointer, read, toArrayBuffer } from 'bun:ffi';

import Combase, { RO_ERROR_REPORTING_FLAGS, RO_INIT_TYPE } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const BLUE = '\x1b[94m';
const MAGENTA = '\x1b[95m';

const S_OK = 0;
const S_FALSE = 1;
const RPC_E_CHANGED_MODE = 0x8001_0106;
const HSTRING_HEADER_SIZE = 24; // x64: union { PVOID; char[24]; }
const POINTER_SIZE = 8;

// IActivationFactory — every activatable runtime class exposes it.
const IID_IActivationFactory = '00000035-0000-0000-C000-000000000046';
const IUNKNOWN_RELEASE = 2;

Combase.Preload();

const stdoutHandle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const savedModeBuffer = Buffer.alloc(4);
let restoreConsoleMode = false;
if (Kernel32.GetConsoleMode(stdoutHandle, savedModeBuffer.ptr!)) {
  restoreConsoleMode = true;
  Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const createdStrings: bigint[] = [];
const hex = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;
const tick = (ok: boolean): string => (ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);

function header(title: string): void {
  console.log();
  console.log(`${BOLD}${MAGENTA}══ ${title} ${'═'.repeat(Math.max(0, 60 - title.length))}${RESET}`);
  console.log();
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

function guid(text: string): Buffer {
  const hexDigits = text.replace(/[{}-]/g, '');
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(parseInt(hexDigits.slice(0, 8), 16), 0);
  buffer.writeUInt16LE(parseInt(hexDigits.slice(8, 12), 16), 4);
  buffer.writeUInt16LE(parseInt(hexDigits.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i += 1) buffer[8 + i] = parseInt(hexDigits.slice(16 + i * 2, 18 + i * 2), 16);
  return buffer;
}

/**
 * Creates a managed HSTRING (tracked for teardown). The empty string maps to
 * the canonical NULL HSTRING — pass NULL/0, per WindowsCreateString.
 */
function hstring(text: string): bigint {
  const out = Buffer.alloc(POINTER_SIZE);
  const source = text.length === 0 ? null : Buffer.from(text, 'utf16le').ptr!;
  const hr = Combase.WindowsCreateString(source, text.length, out.ptr!);
  if (hr !== S_OK) throw new Error(`WindowsCreateString failed (${hex(hr)})`);
  const handle = out.readBigUInt64LE(0);
  createdStrings.push(handle);
  return handle;
}

/** Reads an HSTRING back through its own immutable backing buffer. */
function readHString(handle: bigint): string {
  const lengthBuffer = Buffer.alloc(4);
  const bufferPointer = Combase.WindowsGetStringRawBuffer(handle, lengthBuffer.ptr!);
  if (bufferPointer === null) return '';
  const charCount = lengthBuffer.readUInt32LE(0);
  if (charCount === 0) return '';
  return new TextDecoder('utf-16').decode(new Uint8Array(toArrayBuffer(bufferPointer, 0, charCount * 2)));
}

function compare(a: bigint, b: bigint): number {
  const resultBuffer = Buffer.alloc(4);
  Combase.WindowsCompareStringOrdinal(a, b, resultBuffer.ptr!);
  return resultBuffer.readInt32LE(0);
}

/** Calls IUnknown::Release on a COM interface pointer via its vtable. */
function releaseObject(thisPtr: bigint): void {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const release = read.u64(Number(vtable) as Pointer, IUNKNOWN_RELEASE * 8);
  CFunction({ ptr: Number(release) as Pointer, args: [FFIType.u64], returns: FFIType.u32 })(thisPtr);
}

function runtimeThreadState(): void {
  header('1 · Windows Runtime Thread State');

  const initHr = Combase.RoInitialize(RO_INIT_TYPE.RO_INIT_MULTITHREADED);
  const initText =
    initHr === S_OK
      ? `${GREEN}S_OK${RESET} — runtime initialized`
      : initHr === S_FALSE
        ? `${YELLOW}S_FALSE${RESET} — already initialized on this thread`
        : initHr >>> 0 === RPC_E_CHANGED_MODE
          ? `${YELLOW}RPC_E_CHANGED_MODE${RESET} — thread already in another apartment`
          : `${RED}${hex(initHr)}${RESET}`;
  row('RoInitialize(MULTITHREADED)', initText);

  const apartmentBuffer = Buffer.alloc(8);
  const apartmentHr = Combase.RoGetApartmentIdentifier(apartmentBuffer.ptr!);
  row('RoGetApartmentIdentifier', apartmentHr === S_OK ? `${CYAN}${apartmentBuffer.readBigUInt64LE(0)}${RESET}` : `${RED}${hex(apartmentHr)}${RESET}`);

  const propagation = Combase.IsErrorPropagationEnabled();
  row('IsErrorPropagationEnabled', propagation !== 0 ? `${GREEN}TRUE${RESET}` : `${DIM}FALSE${RESET}`);

  const flagsBuffer = Buffer.alloc(4);
  const flagsHr = Combase.RoGetErrorReportingFlags(flagsBuffer.ptr!);
  if (flagsHr === S_OK) {
    const flags = flagsBuffer.readUInt32LE(0);
    row('RoGetErrorReportingFlags', `${CYAN}${hex(flags)}${RESET}`);
    for (const [name, bit] of Object.entries(RO_ERROR_REPORTING_FLAGS)) {
      if (typeof bit !== 'number' || bit === 0) continue;
      const on = (flags & bit) === bit;
      console.log(`    ${tick(on)} ${name.padEnd(40)} ${DIM}${hex(bit)}${RESET}`);
    }
  } else {
    row('RoGetErrorReportingFlags', `${RED}${hex(flagsHr)}${RESET}`);
  }
}

function stringEngine(): void {
  header('2 · HSTRING String Engine');

  console.log(`  ${BOLD}${'sample'.padEnd(26)} ${'len'.padStart(4)} ${'js'.padStart(4)} ${'empty'.padStart(6)} ${'embed\\0'.padStart(8)} round-trip${RESET}`);
  console.log(`  ${DIM}${'─'.repeat(72)}${RESET}`);

  const samples = ['Windows.Foundation', '日本語テキスト', '', 'a\0b', '🚀 emoji rocket', '   trim me   '];
  for (const sample of samples) {
    const handle = hstring(sample);
    const backingLength = Combase.WindowsGetStringLen(handle);
    const isEmpty = Combase.WindowsIsStringEmpty(handle) !== 0;

    const embedBuffer = Buffer.alloc(4);
    Combase.WindowsStringHasEmbeddedNull(handle, embedBuffer.ptr!);
    const hasEmbed = embedBuffer.readInt32LE(0) !== 0;

    const roundTrip = readHString(handle);
    const ok = roundTrip === sample;

    const label = JSON.stringify(sample);
    const shown = label.length > 26 ? `${label.slice(0, 25)}…` : label;
    console.log(`  ${shown.padEnd(26)} ${String(backingLength).padStart(4)} ${String(sample.length).padStart(4)} ${(isEmpty ? 'yes' : 'no').padStart(6)} ${(hasEmbed ? 'yes' : 'no').padStart(8)}    ${tick(ok)}`);
  }
}

function operationsMatrix(): void {
  header('3 · HSTRING Operations Matrix');

  const hello = hstring('Hello');
  const space = hstring(', ');
  const world = hstring('World');

  const concatOut = Buffer.alloc(POINTER_SIZE);
  Combase.WindowsConcatString(hello, space, concatOut.ptr!);
  const helloComma = concatOut.readBigUInt64LE(0);
  createdStrings.push(helloComma);
  const concatOut2 = Buffer.alloc(POINTER_SIZE);
  Combase.WindowsConcatString(helloComma, world, concatOut2.ptr!);
  const greeting = concatOut2.readBigUInt64LE(0);
  createdStrings.push(greeting);
  row('WindowsConcatString ×2', `${CYAN}"${readHString(greeting)}"${RESET}`);

  const dupOut = Buffer.alloc(POINTER_SIZE);
  Combase.WindowsDuplicateString(greeting, dupOut.ptr!);
  const dup = dupOut.readBigUInt64LE(0);
  createdStrings.push(dup);
  row('WindowsDuplicateString', `${tick(compare(greeting, dup) === 0)} ${DIM}ordinal-equal to source${RESET}`);

  const subOut = Buffer.alloc(POINTER_SIZE);
  Combase.WindowsSubstring(greeting, 7, subOut.ptr!);
  const sub = subOut.readBigUInt64LE(0);
  createdStrings.push(sub);
  row('WindowsSubstring(idx 7)', `${CYAN}"${readHString(sub)}"${RESET}`);

  const subLenOut = Buffer.alloc(POINTER_SIZE);
  Combase.WindowsSubstringWithSpecifiedLength(greeting, 0, 5, subLenOut.ptr!);
  const subLen = subLenOut.readBigUInt64LE(0);
  createdStrings.push(subLen);
  row('WindowsSubstring(0, len 5)', `${CYAN}"${readHString(subLen)}"${RESET}`);

  const replOut = Buffer.alloc(POINTER_SIZE);
  Combase.WindowsReplaceString(greeting, world, hstring('Bun'), replOut.ptr!);
  const replaced = replOut.readBigUInt64LE(0);
  createdStrings.push(replaced);
  row('WindowsReplaceString', `${CYAN}"${readHString(replaced)}"${RESET}`);

  const padded = hstring('***trim***');
  const star = hstring('*');
  const trimStartOut = Buffer.alloc(POINTER_SIZE);
  Combase.WindowsTrimStringStart(padded, star, trimStartOut.ptr!);
  const trimStart = trimStartOut.readBigUInt64LE(0);
  createdStrings.push(trimStart);
  const trimEndOut = Buffer.alloc(POINTER_SIZE);
  Combase.WindowsTrimStringEnd(trimStart, star, trimEndOut.ptr!);
  const trimmed = trimEndOut.readBigUInt64LE(0);
  createdStrings.push(trimmed);
  row('WindowsTrimStringStart/End', `${CYAN}"${readHString(trimmed)}"${RESET} ${DIM}from "***trim***"${RESET}`);

  console.log();
  const sorted = ['alpha', 'Alpha', 'beta', 'gamma'];
  console.log(`  ${DIM}WindowsCompareStringOrdinal across ${JSON.stringify(sorted)}${RESET}`);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const result = compare(hstring(sorted[i]), hstring(sorted[i + 1]));
    const sign = result < 0 ? '<' : result > 0 ? '>' : '=';
    console.log(`    "${sorted[i]}" ${BLUE}${sign}${RESET} "${sorted[i + 1]}"  ${DIM}(${result})${RESET}`);
  }
}

function fastPassAndBuffers(): void {
  header('4 · Fast-Pass & Preallocated Buffers');

  // Stack-backed fast-pass string: no heap allocation, no WindowsDeleteString.
  const fastText = 'fast-pass (no heap, no delete)';
  const fastSource = Buffer.from(`${fastText}\0`, 'utf16le');
  const fastHeader = Buffer.alloc(HSTRING_HEADER_SIZE);
  const fastOut = Buffer.alloc(POINTER_SIZE);
  const fastHr = Combase.WindowsCreateStringReference(fastSource.ptr!, fastText.length, fastHeader.ptr!, fastOut.ptr!);
  const fastHandle = fastOut.readBigUInt64LE(0);
  row('WindowsCreateStringReference', fastHr === S_OK ? `${tick(readHString(fastHandle) === fastText)} ${CYAN}"${readHString(fastHandle)}"${RESET}` : `${RED}${hex(fastHr)}${RESET}`);

  // Preallocate a mutable WCHAR buffer, fill it, then promote to an HSTRING.
  const promoteText = 'promoted-from-buffer';
  const charBufferOut = Buffer.alloc(POINTER_SIZE);
  const bufferHandleOut = Buffer.alloc(POINTER_SIZE);
  const preHr = Combase.WindowsPreallocateStringBuffer(promoteText.length, charBufferOut.ptr!, bufferHandleOut.ptr!);
  if (preHr === S_OK) {
    const writableAddress = charBufferOut.readBigUInt64LE(0);
    const writable = new Uint16Array(toArrayBuffer(Number(writableAddress) as Pointer, 0, (promoteText.length + 1) * 2));
    for (let i = 0; i < promoteText.length; i += 1) writable[i] = promoteText.charCodeAt(i);
    writable[promoteText.length] = 0;

    const bufferHandle = bufferHandleOut.readBigUInt64LE(0);
    const promotedOut = Buffer.alloc(POINTER_SIZE);
    const promoteHr = Combase.WindowsPromoteStringBuffer(bufferHandle, promotedOut.ptr!);
    const promoted = promotedOut.readBigUInt64LE(0);
    if (promoteHr === S_OK) createdStrings.push(promoted);
    row('WindowsPreallocate → Promote', promoteHr === S_OK ? `${tick(readHString(promoted) === promoteText)} ${CYAN}"${readHString(promoted)}"${RESET}` : `${RED}${hex(promoteHr)}${RESET}`);
  } else {
    row('WindowsPreallocateStringBuffer', `${RED}${hex(preHr)}${RESET}`);
  }

  // Allocate a buffer and abandon it via WindowsDeleteStringBuffer.
  const discardCharOut = Buffer.alloc(POINTER_SIZE);
  const discardHandleOut = Buffer.alloc(POINTER_SIZE);
  Combase.WindowsPreallocateStringBuffer(8, discardCharOut.ptr!, discardHandleOut.ptr!);
  const discardHr = Combase.WindowsDeleteStringBuffer(discardHandleOut.readBigUInt64LE(0));
  row('WindowsDeleteStringBuffer', `${tick(discardHr === S_OK)} ${DIM}preallocated buffer discarded${RESET}`);
}

function activationProbe(): void {
  header('5 · WinRT Activation Probe');

  const classes = [
    'Windows.Globalization.Calendar',
    'Windows.UI.Notifications.ToastNotificationManager',
    'Windows.Data.Json.JsonObject',
    'Windows.Security.Cryptography.CryptographicBuffer',
    'Windows.Foundation.Uri',
    'Windows.System.UserProfile.GlobalizationPreferences',
    'Windows.Devices.Geolocation.Geolocator',
    'Windows.Storage.AccessCache.StorageApplicationPermissions',
  ];
  const factoryIid = guid(IID_IActivationFactory);

  for (const runtimeClass of classes) {
    const factoryOut = Buffer.alloc(POINTER_SIZE);
    const hr = Combase.RoGetActivationFactory(hstring(runtimeClass), factoryIid.ptr!, factoryOut.ptr!);
    const ok = hr === S_OK;
    const status = ok ? `${GREEN}activatable${RESET}` : `${YELLOW}${hex(hr)}${RESET}`;
    console.log(`  ${tick(ok)} ${runtimeClass.padEnd(52)} ${status}`);
    if (ok) releaseObject(factoryOut.readBigUInt64LE(0));
  }
}

function main(): void {
  console.log();
  console.log(`${BOLD}${MAGENTA}  Windows Runtime & HSTRING Diagnostic${RESET} ${DIM}· combase.dll${RESET}`);

  runtimeThreadState();
  stringEngine();
  operationsMatrix();
  fastPassAndBuffers();
  activationProbe();

  for (const handle of createdStrings) Combase.WindowsDeleteString(handle);
  Combase.RoUninitialize();
  if (restoreConsoleMode) Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0));

  console.log();
  console.log(`  ${GREEN}Diagnostic complete.${RESET} ${DIM}${createdStrings.length} HSTRINGs created and released.${RESET}`);
  console.log();
}

main();
