/**
 * Windows Property System Diagnostic
 *
 * A comprehensive, richly-formatted audit of the Windows Property System
 * exposed by propsys.dll. Two sections:
 *
 *   1. Property Key Dictionary — resolves a roster of well-known canonical
 *      property names (System.Title, System.Photo.CameraModel, …) to their
 *      binary PROPERTYKEY (FMTID GUID + PID), then performs a three-way
 *      round-trip (name → key → "{FMTID} PID" → key) and verifies the raw
 *      20-byte key survives every hop.
 *   2. PROPVARIANT Conversion Matrix — builds PROPVARIANTs of several VT types
 *      and coerces them through the system's own PropVariantChangeType /
 *      PropVariantTo* readers, exercises a byte-buffer and string-vector
 *      PROPVARIANT round-trip, and shows the Explorer-grade
 *      PropVariantCompareEx comparator in two modes.
 *
 * Every value is printed in aligned, box-drawn tables with ✓/✗ status coloring.
 * All wide strings are read from caller-owned buffers or PCWSTR returns — no
 * pointer casts anywhere.
 *
 * APIs demonstrated (Propsys):
 *   - PSGetPropertyKeyFromName       (canonical name → PROPERTYKEY)
 *   - PSStringFromPropertyKey        (PROPERTYKEY → "{FMTID} PID" string)
 *   - PSPropertyKeyFromString        (string → PROPERTYKEY, reverse round-trip)
 *   - InitPropVariantFromBuffer      (raw bytes → VT_VECTOR|VT_UI1 PROPVARIANT)
 *   - InitPropVariantFromStringVector(string[] → VT_VECTOR|VT_LPWSTR)
 *   - PropVariantGetElementCount     (element count of a vector PROPVARIANT)
 *   - PropVariantToBuffer            (PROPVARIANT bytes → caller buffer)
 *   - PropVariantChangeType          (coerce a PROPVARIANT to another VARTYPE)
 *   - PropVariantToInt32             (PROPVARIANT → LONG)
 *   - PropVariantToDouble            (PROPVARIANT → DOUBLE)
 *   - PropVariantToBoolean           (PROPVARIANT → BOOL)
 *   - PropVariantToStringWithDefault (PROPVARIANT → PCWSTR, no allocation)
 *   - PropVariantCompareEx           (the comparator Windows Explorer uses)
 *
 * APIs demonstrated (cross-package):
 *   - Ole32.CoInitialize             (PSGetPropertyKeyFromName needs COM)
 *   - Kernel32.GetStdHandle / GetConsoleMode / SetConsoleMode (enable ANSI VT)
 *
 * Run: bun run example/property-system-diagnostic.ts
 */

import { read, type Pointer } from 'bun:ffi';

import Propsys, { PROPVAR_CHANGE_FLAGS, PROPVAR_COMPARE_FLAGS, PROPVAR_COMPARE_UNIT } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';
import Ole32 from '@bun-win32/ole32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const BLUE = '\x1b[94m';
const MAGENTA = '\x1b[95m';

// VARTYPE constants (wtypes.h) — only the ones this demo needs.
const VT_I4 = 3;
const VT_R8 = 5;
const VT_BOOL = 11;
const VT_LPWSTR = 31;

const S_OK = 0;
const PROPVARIANT_SIZE = 24; // x64: 8-byte header + 16-byte union.

Propsys.Preload();

// PSGetPropertyKeyFromName resolves names through the COM-based property schema,
// so the calling thread must have COM initialized first (otherwise every lookup
// fails with CO_E_NOTINITIALIZED, 0x800401F0).
Ole32.CoInitialize(null);

// Enable ANSI escape processing so colors render in Windows Terminal / VS Code.
const stdoutHandle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const savedModeBuffer = Buffer.alloc(4);
let restoreConsoleMode = false;
if (Kernel32.GetConsoleMode(stdoutHandle, savedModeBuffer.ptr)) {
  restoreConsoleMode = true;
  Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const wstr = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');

/** Reads a NUL-terminated UTF-16LE string starting at a native pointer. */
function readWideAtPointer(address: Pointer): string {
  let result = '';
  for (let offset = 0; offset < 0x20000; offset += 2) {
    const codeUnit = read.u16(address, offset);
    if (codeUnit === 0) break;
    result += String.fromCharCode(codeUnit);
  }
  return result;
}

/** Formats the 16-byte GUID at `buffer[offset]` as {XXXXXXXX-XXXX-…}. */
function formatGuid(buffer: Buffer, offset: number): string {
  const data1 = buffer.readUInt32LE(offset).toString(16).padStart(8, '0');
  const data2 = buffer
    .readUInt16LE(offset + 4)
    .toString(16)
    .padStart(4, '0');
  const data3 = buffer
    .readUInt16LE(offset + 6)
    .toString(16)
    .padStart(4, '0');
  const tail = [...buffer.subarray(offset + 8, offset + 16)].map((byte) => byte.toString(16).padStart(2, '0'));
  return `{${data1}-${data2}-${data3}-${tail.slice(0, 2).join('')}-${tail.slice(2).join('')}}`.toUpperCase();
}

const pad = (text: string, width: number): string => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));
const hexHr = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║${RESET}  ${BOLD}WINDOWS PROPERTY SYSTEM DIAGNOSTIC${RESET}  ${DIM}propsys.dll via Bun FFI${RESET}            ${BOLD}${CYAN}║${RESET}`);
console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════════════╝${RESET}\n`);

// ── Section 1: Property Key Dictionary ──────────────────────────────────────
const canonicalNames = [
  'System.Title',
  'System.Author',
  'System.Comment',
  'System.Keywords',
  'System.Rating',
  'System.Size',
  'System.ItemNameDisplay',
  'System.DateModified',
  'System.FileExtension',
  'System.Music.Artist',
  'System.Music.AlbumTitle',
  'System.Photo.CameraModel',
  'System.Photo.DateTaken',
  'System.Media.Duration',
  'System.Document.PageCount',
  'System.Image.Dimensions',
];

console.log(`${BOLD}${BLUE}▌ Property Key Dictionary${RESET}  ${DIM}(name → key → "{FMTID} PID" → key)${RESET}\n`);
console.log(`${DIM}  ${pad('Canonical Name', 26)} ${pad('FMTID', 38)} ${pad('PID', 5)} RT${RESET}`);
console.log(`${DIM}  ${'─'.repeat(26)} ${'─'.repeat(38)} ${'─'.repeat(5)} ──${RESET}`);

let resolved = 0;
let roundTripped = 0;
for (const name of canonicalNames) {
  const keyBuffer = Buffer.alloc(20); // PROPERTYKEY = GUID(16) + DWORD pid(4)
  const hr = Propsys.PSGetPropertyKeyFromName(wstr(name).ptr, keyBuffer.ptr);
  if (hr !== S_OK) {
    console.log(`  ${pad(name, 26)} ${RED}${pad(`unresolved (${hexHr(hr)})`, 38)}${RESET}`);
    continue;
  }
  resolved += 1;
  const fmtid = formatGuid(keyBuffer, 0);
  const pid = keyBuffer.readUInt32LE(16);

  const keyStringBuffer = Buffer.alloc(256 * 2); // wide chars, caller-owned
  Propsys.PSStringFromPropertyKey(keyBuffer.ptr, keyStringBuffer.ptr, 256);
  const keyString = readWideAtPointer(keyStringBuffer.ptr);

  const reparsedKeyBuffer = Buffer.alloc(20);
  Propsys.PSPropertyKeyFromString(wstr(keyString).ptr, reparsedKeyBuffer.ptr);
  const ok = keyBuffer.equals(reparsedKeyBuffer);
  if (ok) roundTripped += 1;

  const status = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`  ${pad(name, 26)} ${YELLOW}${pad(fmtid, 38)}${RESET} ${pad(String(pid), 5)} ${status}`);
}
console.log(`\n  ${DIM}Resolved ${GREEN}${resolved}${RESET}${DIM}/${canonicalNames.length}, full round-trip ${GREEN}${roundTripped}${RESET}${DIM}/${resolved}.${RESET}\n`);

// ── Section 2: PROPVARIANT Conversion Matrix ────────────────────────────────
console.log(`${BOLD}${BLUE}▌ PROPVARIANT Conversion Matrix${RESET}  ${DIM}(one source value coerced across VARTYPEs)${RESET}\n`);

/** Builds a zeroed VT_LPWSTR PROPVARIANT wrapping `text` (no allocation). */
function makeStringPropVariant(text: string): { propVariant: Buffer; keep: Buffer } {
  const keep = wstr(text);
  const propVariant = Buffer.alloc(PROPVARIANT_SIZE);
  propVariant.writeUInt16LE(VT_LPWSTR, 0);
  propVariant.writeBigUInt64LE(BigInt(keep.ptr), 8);
  return { propVariant, keep };
}

const targets: { label: string; vt: number }[] = [
  { label: 'LONG (VT_I4)', vt: VT_I4 },
  { label: 'DOUBLE (VT_R8)', vt: VT_R8 },
  { label: 'BOOL (VT_BOOL)', vt: VT_BOOL },
  { label: 'string (VT_LPWSTR)', vt: VT_LPWSTR },
];
const fallback = wstr('—');

for (const source of ['255', '3.14159', '-42', 'true']) {
  const { propVariant } = makeStringPropVariant(source);
  console.log(`  ${BOLD}source ${MAGENTA}"${source}"${RESET}${BOLD} (VT_LPWSTR)${RESET}`);
  for (const target of targets) {
    const dest = Buffer.alloc(PROPVARIANT_SIZE);
    const hr = Propsys.PropVariantChangeType(dest.ptr, propVariant.ptr, PROPVAR_CHANGE_FLAGS.PVCHF_DEFAULT, target.vt);
    let rendered: string;
    if (hr !== S_OK) {
      rendered = `${DIM}no coercion (${hexHr(hr)})${RESET}`;
    } else if (target.vt === VT_I4) {
      const out = Buffer.alloc(4);
      rendered = Propsys.PropVariantToInt32(dest.ptr, out.ptr) === S_OK ? `${GREEN}${out.readInt32LE(0)}${RESET}` : `${RED}—${RESET}`;
    } else if (target.vt === VT_R8) {
      const out = Buffer.alloc(8);
      rendered = Propsys.PropVariantToDouble(dest.ptr, out.ptr) === S_OK ? `${GREEN}${out.readDoubleLE(0)}${RESET}` : `${RED}—${RESET}`;
    } else if (target.vt === VT_BOOL) {
      const out = Buffer.alloc(4);
      rendered = Propsys.PropVariantToBoolean(dest.ptr, out.ptr) === S_OK ? `${GREEN}${out.readInt32LE(0) !== 0}${RESET}` : `${RED}—${RESET}`;
    } else {
      rendered = `${GREEN}${readWideAtPointer(Propsys.PropVariantToStringWithDefault(dest.ptr, fallback.ptr))}${RESET}`;
    }
    console.log(`    ${DIM}→${RESET} ${pad(target.label, 20)} ${rendered}`);
  }
  console.log('');
}

// Byte-buffer PROPVARIANT round-trip (VT_VECTOR | VT_UI1).
const payload = Buffer.from('Bun <-> propsys FFI', 'utf8');
const bufferPropVariant = Buffer.alloc(PROPVARIANT_SIZE);
if (Propsys.InitPropVariantFromBuffer(payload.ptr, payload.length, bufferPropVariant.ptr) === S_OK) {
  const count = Propsys.PropVariantGetElementCount(bufferPropVariant.ptr);
  const readBack = Buffer.alloc(payload.length);
  Propsys.PropVariantToBuffer(bufferPropVariant.ptr, readBack.ptr, payload.length);
  const intact = readBack.equals(payload);
  console.log(`  ${BOLD}InitPropVariantFromBuffer${RESET} ${DIM}(${payload.length} bytes)${RESET}  elements=${count}  round-trip ${intact ? `${GREEN}✓ identical${RESET}` : `${RED}✗ corrupted${RESET}`}`);
}

// String-vector PROPVARIANT (VT_VECTOR | VT_LPWSTR).
const vectorWords = ['propsys', 'bun', 'win32', 'ffi'];
const wordBuffers = vectorWords.map((word) => wstr(word));
const pointerArray = new BigUint64Array(wordBuffers.map((buffer) => BigInt(buffer.ptr)));
const vectorPropVariant = Buffer.alloc(PROPVARIANT_SIZE);
if (Propsys.InitPropVariantFromStringVector(pointerArray.ptr, vectorWords.length, vectorPropVariant.ptr) === S_OK) {
  const count = Propsys.PropVariantGetElementCount(vectorPropVariant.ptr);
  const match = count === vectorWords.length;
  console.log(`  ${BOLD}InitPropVariantFromStringVector${RESET} ${DIM}([${vectorWords.join(', ')}])${RESET}  PropVariantGetElementCount=${count} ${match ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`}`);
}

// Explorer's value comparator: natural vs. ordinal string ordering.
console.log(`\n${BOLD}${BLUE}▌ PropVariantCompareEx${RESET}  ${DIM}(the comparator Windows Explorer uses)${RESET}\n`);
const left = makeStringPropVariant('photo (2).jpg');
const right = makeStringPropVariant('photo (10).jpg');
const sign = (value: number): string => (value < 0 ? `${GREEN}before${RESET}` : value > 0 ? `${RED}after${RESET}` : `${YELLOW}equal${RESET}`);
const natural = Propsys.PropVariantCompareEx(left.propVariant.ptr, right.propVariant.ptr, PROPVAR_COMPARE_UNIT.PVCU_DEFAULT, PROPVAR_COMPARE_FLAGS.PVCF_DEFAULT);
const ordinal = Propsys.PropVariantCompareEx(left.propVariant.ptr, right.propVariant.ptr, PROPVAR_COMPARE_UNIT.PVCU_DEFAULT, PROPVAR_COMPARE_FLAGS.PVCF_USESTRCMP);
console.log(`  "photo (2).jpg"  vs  "photo (10).jpg"`);
console.log(`    ${pad('natural (StrCmpLogical)', 26)} → "photo (2).jpg" sorts ${sign(natural)}`);
console.log(`    ${pad('ordinal  (StrCmp)', 26)} → "photo (2).jpg" sorts ${sign(ordinal)}`);
console.log(`\n  ${DIM}Natural order treats "2" < "10"; ordinal compares code units so "1" < "2".${RESET}\n`);

if (restoreConsoleMode) Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0));
