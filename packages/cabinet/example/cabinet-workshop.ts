/**
 * Cabinet Workshop
 *
 * A complete, honest round trip through the Microsoft Cabinet format using only
 * raw FFI into cabinet.dll — no shelling out to makecab/expand. It authors a
 * workspace of varied source files, drives the File Compression Interface (FCI)
 * to pack them into a real .cab with MSZIP compression (every block of file
 * I/O, memory allocation, and temp-file handling serviced by JavaScript
 * callbacks), then re-opens that archive with the File Decompression Interface
 * (FDI), reads the cabinet header back through FDIIsCabinet, streams every
 * entry out via an FDICopy notification callback, and verifies each extracted
 * byte against the original. The result is a richly formatted diagnostic: a
 * cabinet header panel, a per-file manifest with decoded MS-DOS timestamps and
 * attribute flags, and an integrity ledger.
 *
 * APIs demonstrated (Cabinet — FCI, build):
 *   - FCICreate                 (cabinet context + 13 I/O / alloc callbacks)
 *   - FCIAddFile                (append a file with MSZIP compression)
 *   - FCIFlushCabinet           (finalize the .cab)
 *   - FCIDestroy                (release the FCI context)
 *
 * APIs demonstrated (Cabinet — FDI, inspect & extract):
 *   - FDICreate                 (decompression context + 7 I/O callbacks)
 *   - FDIIsCabinet              (validate + read FDICABINETINFO header)
 *   - FDICopy                   (enumerate + extract via notify callback)
 *   - FDIDestroy                (release the FDI context)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *   - SetConsoleTitleW          (set the window title)
 *
 * FDICABINETINFO layout (24 bytes):
 *   +0x00 long   cbCabinet     +0x04 USHORT cFolders   +0x06 USHORT cFiles
 *   +0x08 USHORT setID         +0x0a USHORT iCabinet    +0x0c BOOL   fReserve
 *   +0x10 BOOL   hasprev       +0x14 BOOL   hasnext
 *
 * FDINOTIFICATION layout (64 bytes, x64):
 *   +0x00 long cb  [+4 pad]  +0x08 char* psz1  +0x10 char* psz2  +0x18 char* psz3
 *   +0x20 void* pv  +0x28 INT_PTR hf  +0x30 USHORT date  +0x32 USHORT time
 *   +0x34 USHORT attribs  +0x36 USHORT setID  +0x38 USHORT iCabinet
 *   +0x3a USHORT iFolder  +0x3c FDIERROR fdie
 *
 * Run: bun run example/cabinet-workshop.ts
 */
import { CString, FFIType, JSCallback, type Pointer, toArrayBuffer, read } from 'bun:ffi';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Cabinet, { FDIERROR, TCOMP_TYPE } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

Cabinet.Preload(['FCICreate', 'FCIAddFile', 'FCIFlushCabinet', 'FCIDestroy', 'FDICreate', 'FDIIsCabinet', 'FDICopy', 'FDIDestroy']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'SetConsoleTitleW']);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const WHITE = '\x1b[97m';

function wide(text: string): Buffer {
  return Buffer.from(text + '\0', 'utf16le');
}

const stdoutHandle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const savedModeBuffer = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(stdoutHandle, savedModeBuffer.ptr)) {
  Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}
Kernel32.SetConsoleTitleW(wide('Cabinet Workshop — @bun-win32/cabinet').ptr);

// C runtime _open oflag bits used by FCI/FDI (MSVC <fcntl.h>)
const O_WRONLY = 0x0001;
const O_RDWR = 0x0002;
const O_CREAT = 0x0100;
const O_TRUNC = 0x0200;

// ---------------------------------------------------------------------------
// Shared file-handle table. FCI/FDI hand us opaque INT_PTR handles; we back
// them with real OS file descriptors and track each one's stream position so
// the seek callback can report absolute offsets.
// ---------------------------------------------------------------------------
const positions = new Map<number, number>();
const pins = new Map<Pointer, Buffer>();

function flagsFromOflag(oflag: number): string {
  if (oflag & O_CREAT) return oflag & O_TRUNC ? 'w+' : 'a+';
  if (oflag & (O_RDWR | O_WRONLY)) return 'r+';
  return 'r';
}
function fdOpen(path: string, oflag: number): bigint {
  const fd = openSync(path, flagsFromOflag(oflag));
  positions.set(fd, 0);
  return BigInt(fd);
}
function fdRead(hf: bigint, mem: Pointer, cb: number): number {
  const fd = Number(hf);
  const pos = positions.get(fd) ?? 0;
  if (cb === 0) return 0;
  const scratch = Buffer.alloc(cb);
  const got = readSync(fd, scratch, 0, cb, pos);
  positions.set(fd, pos + got);
  if (got > 0) new Uint8Array(toArrayBuffer(mem, 0, cb)).set(scratch.subarray(0, got));
  return got;
}
function fdWrite(hf: bigint, mem: Pointer, cb: number): number {
  const fd = Number(hf);
  const pos = positions.get(fd) ?? 0;
  if (cb === 0) return 0;
  const src = Buffer.from(new Uint8Array(toArrayBuffer(mem, 0, cb)));
  const put = writeSync(fd, src, 0, cb, pos);
  positions.set(fd, pos + put);
  return put;
}
function fdSeek(hf: bigint, dist: number, seektype: number): number {
  const fd = Number(hf);
  let pos = positions.get(fd) ?? 0;
  if (seektype === 0) pos = dist;
  else if (seektype === 1) pos += dist;
  else pos = fstatSync(fd).size + dist;
  positions.set(fd, pos);
  return pos;
}
function fdClose(hf: bigint): number {
  const fd = Number(hf);
  positions.delete(fd);
  closeSync(fd);
  return 0;
}
function heapAlloc(cb: number): Pointer {
  const block = Buffer.alloc(Math.max(1, cb));
  pins.set(block.ptr, block);
  return block.ptr;
}
function heapFree(p: Pointer): void {
  pins.delete(p);
}
function clearErr(errPtr: Pointer): void {
  new DataView(toArrayBuffer(errPtr, 0, 4)).setInt32(0, 0, true);
}

// ---------------------------------------------------------------------------
// Workspace + source files
// ---------------------------------------------------------------------------
const workspace = mkdtempSync(join(tmpdir(), 'cabinet-workshop-'));
const stageDir = join(workspace, 'stage');
const extractDir = join(workspace, 'extracted');
mkdirSync(stageDir);
mkdirSync(extractDir);

interface SourceFile {
  name: string;
  kind: string;
  bytes: Buffer;
}

function makeSources(): SourceFile[] {
  const readme = Buffer.from(
    ['# Cabinet Workshop', '', 'This archive was produced entirely through cabinet.dll FCI', 'callbacks driven from Bun via FFI. Every file you see was', 'compressed with MSZIP and verified on the way back out.', ''].join('\n').repeat(6),
    'utf8',
  );
  const telemetry = Buffer.from(JSON.stringify({ service: 'bun-win32', samples: Array.from({ length: 500 }, (_, i) => ({ t: i, cpu: (i * 31) % 100, rss: 4096 + ((i * 1313) % 65536), ok: i % 4 !== 0 })) }, null, 1), 'utf8');
  const csvRows = ['timestamp,sensor,value,unit'];
  for (let i = 0; i < 1500; i++) csvRows.push(`${1700000000 + i},sensor-${i % 12},${(Math.sin(i / 7) * 1000).toFixed(3)},mV`);
  const csv = Buffer.from(csvRows.join('\n'), 'utf8');
  const blob = Buffer.alloc(24 * 1024);
  let seed = 0x9e37_79b9;
  for (let i = 0; i < blob.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    blob[i] = seed & 0xff;
  }
  const changelog = Buffer.from('- fixed a thing\n- improved another thing\n- no user-visible changes\n'.repeat(400), 'utf8');
  return [
    { name: 'README.md', kind: 'markdown', bytes: readme },
    { name: 'telemetry.json', kind: 'json', bytes: telemetry },
    { name: 'timeseries.csv', kind: 'csv', bytes: csv },
    { name: 'payload.bin', kind: 'binary', bytes: blob },
    { name: 'CHANGELOG.txt', kind: 'text', bytes: changelog },
  ];
}

const sources = makeSources();
for (const file of sources) writeFileSync(join(stageDir, file.name), file.bytes);
const totalOriginal = sources.reduce((sum, file) => sum + file.bytes.length, 0);

const cabName = 'workshop.cab';
const cabDir = stageDir + '\\';
const cabPath = join(stageDir, cabName);

function rule(width = 78): string {
  return DIM + '─'.repeat(width) + RESET;
}
function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}
function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
function decodeDosDateTime(date: number, time: number): string {
  const day = date & 0x1f;
  const month = (date >> 5) & 0x0f;
  const year = ((date >> 9) & 0x7f) + 1980;
  const second = (time & 0x1f) * 2;
  const minute = (time >> 5) & 0x3f;
  const hour = (time >> 11) & 0x1f;
  const p2 = (n: number): string => n.toString().padStart(2, '0');
  return `${year}-${p2(month)}-${p2(day)} ${p2(hour)}:${p2(minute)}:${p2(second)}`;
}
function decodeAttribs(attribs: number): string {
  return [attribs & 0x01 ? 'R' : '-', attribs & 0x02 ? 'H' : '-', attribs & 0x04 ? 'S' : '-', attribs & 0x20 ? 'A' : '-', attribs & 0x80 ? 'U' : '-'].join('');
}

console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║                            C A B I N E T   W O R K S H O P                    ║${RESET}`);
console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════════════╝${RESET}`);
console.log(`${DIM}cabinet.dll FCI + FDI over raw Bun FFI · workspace ${workspace}${RESET}\n`);

console.log(`${BOLD}${WHITE}Source files${RESET}`);
console.log(rule());
console.log(`${DIM}${pad('  Name', 24)}${pad('Kind', 14)}${padLeft('Size', 14)}${RESET}`);
for (const file of sources) {
  console.log(`  ${pad(file.name, 22)}${pad(file.kind, 14)}${padLeft(humanBytes(file.bytes.length), 12)}`);
}
console.log(rule());
console.log(`  ${DIM}${sources.length} files · ${humanBytes(totalOriginal)} total${RESET}\n`);

// ---------------------------------------------------------------------------
// Phase 1 — FCI: build the cabinet
// ---------------------------------------------------------------------------
const erf = Buffer.alloc(12);

// CCAB: 8×u32 (0..31) · USHORT setID@32 · szDisk@34[256] · szCab@290[256] · szCabPath@546[256]
const ccab = Buffer.alloc(804);
ccab.writeUInt32LE(0x7fff_ffff, 0); // cb — maximum cabinet size
ccab.writeUInt32LE(0x7fff_ffff, 4); // cbFolderThresh — keep a single folder
ccab.writeUInt16LE(0xca5, 32); // setID
ccab.write(cabName + '\0', 290, 'latin1');
ccab.write(cabDir + '\0', 546, 'latin1');

let tempCounter = 0;
const fciCallbacks: JSCallback[] = [];
function fci<T extends (...args: never[]) => unknown>(fn: T, def: FFIFunctionDef): Pointer {
  const cb = new JSCallback(fn, def);
  fciCallbacks.push(cb);
  return cb.ptr!;
}
type FFIFunctionDef = { args: FFIType[]; returns: FFIType };

const pFilePlaced = fci(() => 0, { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 });
const pAlloc = fci((cb: number) => heapAlloc(cb), { args: [FFIType.u32], returns: FFIType.ptr });
const pFree = fci((p: Pointer) => heapFree(p), { args: [FFIType.ptr], returns: FFIType.void });
const pOpen = fci(
  (pszFile: Pointer, oflag: number, _pmode: number, errPtr: Pointer) => {
    clearErr(errPtr);
    return fdOpen(new CString(pszFile).toString(), oflag);
  },
  { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
);
const pRead = fci(
  (hf: bigint, mem: Pointer, cb: number, errPtr: Pointer) => {
    clearErr(errPtr);
    return fdRead(hf, mem, cb);
  },
  { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
);
const pWrite = fci(
  (hf: bigint, mem: Pointer, cb: number, errPtr: Pointer) => {
    clearErr(errPtr);
    return fdWrite(hf, mem, cb);
  },
  { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
);
const pClose = fci(
  (hf: bigint, errPtr: Pointer) => {
    clearErr(errPtr);
    return fdClose(hf);
  },
  { args: [FFIType.i64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
);
const pSeek = fci(
  (hf: bigint, dist: number, seektype: number, errPtr: Pointer) => {
    clearErr(errPtr);
    return fdSeek(hf, dist, seektype);
  },
  { args: [FFIType.i64, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
);
const pDelete = fci(
  (pszFile: Pointer, errPtr: Pointer) => {
    clearErr(errPtr);
    try {
      unlinkSync(new CString(pszFile).toString());
    } catch {}
    return 0;
  },
  { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
);
const pGetTempFile = fci(
  (namePtr: Pointer, cbName: number) => {
    const name = join(stageDir, `~wk${process.pid}_${tempCounter++}.tmp`);
    const encoded = Buffer.from(name + '\0', 'latin1');
    new Uint8Array(toArrayBuffer(namePtr, 0, cbName)).set(encoded.subarray(0, cbName));
    return 1;
  },
  { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
);
const pGetNextCab = fci(() => 1, { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 });
const pStatus = fci(() => 0, { args: [FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 });
const pGetOpenInfo = fci(
  (pszName: Pointer, pdate: Pointer, ptime: Pointer, pattribs: Pointer, errPtr: Pointer) => {
    clearErr(errPtr);
    const path = new CString(pszName).toString();
    const mtime = statSync(path).mtime;
    const dosDate = (((mtime.getFullYear() - 1980) & 0x7f) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate();
    const dosTime = (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1);
    new DataView(toArrayBuffer(pdate, 0, 2)).setUint16(0, dosDate, true);
    new DataView(toArrayBuffer(ptime, 0, 2)).setUint16(0, dosTime, true);
    new DataView(toArrayBuffer(pattribs, 0, 2)).setUint16(0, 0x20, true); // _A_ARCH
    return fdOpen(path, 0);
  },
  { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
);

console.log(`${BOLD}${WHITE}Phase 1 · FCI build${RESET}  ${DIM}(13 callbacks: alloc/free, open/read/write/close/seek/delete, temp, status…)${RESET}`);
console.log(rule());

const buildStart = Bun.nanoseconds();
const hfci = Cabinet.FCICreate(erf.ptr, pFilePlaced, pAlloc, pFree, pOpen, pRead, pWrite, pClose, pSeek, pDelete, pGetTempFile, ccab.ptr, null);
if (hfci === 0n) throw new Error(`FCICreate failed (erfOper=${erf.readInt32LE(0)})`);

for (const file of sources) {
  const sourcePath = Buffer.from(join(stageDir, file.name) + '\0', 'latin1');
  const storedName = Buffer.from(file.name + '\0', 'latin1');
  const added = Cabinet.FCIAddFile(hfci, sourcePath.ptr, storedName.ptr, 0, pGetNextCab, pStatus, pGetOpenInfo, TCOMP_TYPE.tcompTYPE_MSZIP);
  if (!added) throw new Error(`FCIAddFile(${file.name}) failed (erfOper=${erf.readInt32LE(0)})`);
  console.log(`  ${GREEN}+${RESET} ${pad(file.name, 22)} ${DIM}MSZIP${RESET}  ${padLeft(humanBytes(file.bytes.length), 12)} ${DIM}staged${RESET}`);
}

if (!Cabinet.FCIFlushCabinet(hfci, 0, pGetNextCab, pStatus)) throw new Error(`FCIFlushCabinet failed (erfOper=${erf.readInt32LE(0)})`);
Cabinet.FCIDestroy(hfci);
const buildMs = (Bun.nanoseconds() - buildStart) / 1e6;

const cabSize = statSync(cabPath).size;
console.log(rule());
console.log(`  ${BOLD}${cabName}${RESET} written · ${humanBytes(cabSize)} ${DIM}(from ${humanBytes(totalOriginal)}, ${((cabSize / totalOriginal) * 100).toFixed(1)}% of original)${RESET} ${DIM}in ${buildMs.toFixed(1)} ms${RESET}\n`);

// ---------------------------------------------------------------------------
// Phase 2 — FDI: validate + read the cabinet header
// ---------------------------------------------------------------------------
const erf2 = Buffer.alloc(12);
const fdiCallbacks: JSCallback[] = [];
function fdi<T extends (...args: never[]) => unknown>(fn: T, def: FFIFunctionDef): Pointer {
  const cb = new JSCallback(fn, def);
  fdiCallbacks.push(cb);
  return cb.ptr!;
}

const dAlloc = fdi((cb: number) => heapAlloc(cb), { args: [FFIType.u32], returns: FFIType.ptr });
const dFree = fdi((p: Pointer) => heapFree(p), { args: [FFIType.ptr], returns: FFIType.void });
const dOpen = fdi((pszFile: Pointer, oflag: number) => fdOpen(new CString(pszFile).toString(), oflag), { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i64 });
const dRead = fdi((hf: bigint, pv: Pointer, cb: number) => fdRead(hf, pv, cb), { args: [FFIType.i64, FFIType.ptr, FFIType.u32], returns: FFIType.u32 });
const dWrite = fdi((hf: bigint, pv: Pointer, cb: number) => fdWrite(hf, pv, cb), { args: [FFIType.i64, FFIType.ptr, FFIType.u32], returns: FFIType.u32 });
const dClose = fdi((hf: bigint) => fdClose(hf), { args: [FFIType.i64], returns: FFIType.i32 });
const dSeek = fdi((hf: bigint, dist: number, seektype: number) => fdSeek(hf, dist, seektype), { args: [FFIType.i64, FFIType.i32, FFIType.i32], returns: FFIType.i32 });

const hfdi = Cabinet.FDICreate(dAlloc, dFree, dOpen, dRead, dWrite, dClose, dSeek, -1, erf2.ptr);
if (hfdi === 0n) throw new Error('FDICreate failed');

const cabinfo = Buffer.alloc(24);
const probeHandle = fdOpen(cabPath, 0);
const isCab = Cabinet.FDIIsCabinet(hfdi, probeHandle, cabinfo.ptr);
fdClose(probeHandle);
if (!isCab) throw new Error('FDIIsCabinet reported the archive is not a cabinet');

const cbCabinet = cabinfo.readInt32LE(0);
const cFolders = cabinfo.readUInt16LE(4);
const cFiles = cabinfo.readUInt16LE(6);
const setID = cabinfo.readUInt16LE(8);
const iCabinet = cabinfo.readUInt16LE(10);
const fReserve = cabinfo.readInt32LE(12);
const hasprev = cabinfo.readInt32LE(16);
const hasnext = cabinfo.readInt32LE(20);

console.log(`${BOLD}${WHITE}Phase 2 · FDIIsCabinet${RESET}  ${DIM}header decoded from FDICABINETINFO${RESET}`);
console.log(rule());
const field = (label: string, value: string): string => `  ${DIM}${pad(label, 16)}${RESET}${WHITE}${value}${RESET}`;
console.log(field('cbCabinet', `${cbCabinet} bytes (${humanBytes(cbCabinet)})`));
console.log(field('cFolders', String(cFolders)) + '   ' + field('cFiles', String(cFiles)).trimStart());
console.log(field('setID', `0x${setID.toString(16)}`) + '   ' + field('iCabinet', String(iCabinet)).trimStart());
console.log(field('fReserve', fReserve ? 'yes' : 'no') + '   ' + field('hasprev', hasprev ? 'yes' : 'no').trimStart() + '   ' + field('hasnext', hasnext ? 'yes' : 'no').trimStart());
console.log(rule() + '\n');

// ---------------------------------------------------------------------------
// Phase 3 — FDICopy: enumerate + extract via the notification callback
// ---------------------------------------------------------------------------
interface ManifestEntry {
  name: string;
  size: number;
  modified: string;
  attribs: string;
}
const manifest: ManifestEntry[] = [];

// A single-folder cabinet stores files in the order FCIAddFile was called and
// FDICopy enumerates them in that same order, so the stored name for entry N is
// sources[N].name. All numeric metadata below is read straight from the live
// FDINOTIFICATION the cabinet hands back.
let copyIndex = 0;
const notify = new JSCallback(
  (fdint: number, pfdin: Pointer) => {
    if (fdint === 2) {
      // fdintCOPY_FILE — open the destination and record metadata
      const size = read.i32(pfdin, 0);
      const date = read.u16(pfdin, 0x30);
      const time = read.u16(pfdin, 0x32);
      const attribs = read.u16(pfdin, 0x34);
      const name = sources[copyIndex++]!.name;
      manifest.push({ name, size, modified: decodeDosDateTime(date, time), attribs: decodeAttribs(attribs) });
      return fdOpen(join(extractDir, name), O_WRONLY | O_CREAT | O_TRUNC);
    }
    if (fdint === 3) {
      // fdintCLOSE_FILE_INFO — close the handle we returned above
      fdClose(read.i64(pfdin, 0x28));
      return 1;
    }
    return 0;
  },
  { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i64 },
);

const cabNameBuf = Buffer.from(cabName + '\0', 'latin1');
const cabPathBuf = Buffer.from(cabDir + '\0', 'latin1');
const extractStart = Bun.nanoseconds();
const copied = Cabinet.FDICopy(hfdi, cabNameBuf.ptr, cabPathBuf.ptr, 0, notify.ptr!, null, null);
const extractMs = (Bun.nanoseconds() - extractStart) / 1e6;
const fdie = erf2.readInt32LE(0);
Cabinet.FDIDestroy(hfdi);

if (!copied) throw new Error(`FDICopy failed (fdie=${FDIERROR[fdie] ?? fdie})`);

// ---------------------------------------------------------------------------
// Manifest + integrity ledger
// ---------------------------------------------------------------------------
console.log(`${BOLD}${WHITE}Phase 3 · Extracted manifest${RESET}  ${DIM}names + sizes + MS-DOS timestamps + attribute flags${RESET}`);
console.log(rule());
console.log(`${DIM}  ${pad('#', 3)}${pad('Name', 20)}${padLeft('Size', 11)}  ${pad('Modified', 21)}${pad('Attr', 7)}Verify${RESET}`);

let allVerified = true;
manifest.forEach((entry, index) => {
  const original = sources.find((s) => s.name === entry.name)!.bytes;
  const extracted = readFileSync(join(extractDir, entry.name));
  const ok = extracted.length === original.length && extracted.equals(original);
  if (!ok) allVerified = false;
  const verdict = ok ? `${GREEN}✓ identical${RESET}` : `${RED}✗ MISMATCH${RESET}`;
  console.log(`  ${pad(String(index + 1), 3)}${pad(entry.name, 20)}${padLeft(humanBytes(entry.size), 11)}  ${pad(entry.modified, 21)}${pad(entry.attribs, 7)}${verdict}`);
});
console.log(rule());

const ratio = ((cabSize / totalOriginal) * 100).toFixed(1);
const spaceSaved = totalOriginal - cabSize;
console.log(`\n${BOLD}${WHITE}Summary${RESET}`);
console.log(rule());
console.log(`  ${DIM}Files round-tripped${RESET}   ${WHITE}${manifest.length} / ${sources.length}${RESET}   ${DIM}via${RESET} ${copied ? `${GREEN}FDICopy OK${RESET}` : `${RED}FDICopy FAIL${RESET}`}`);
console.log(`  ${DIM}Original → Cabinet${RESET}    ${WHITE}${humanBytes(totalOriginal)} → ${humanBytes(cabSize)}${RESET}   ${DIM}(${ratio}% of original, ${humanBytes(spaceSaved)} saved)${RESET}`);
console.log(`  ${DIM}FDIERROR${RESET}              ${WHITE}${FDIERROR[fdie] ?? fdie}${RESET}`);
console.log(`  ${DIM}Build / extract${RESET}       ${WHITE}${buildMs.toFixed(1)} ms / ${extractMs.toFixed(1)} ms${RESET}`);
console.log(`  ${DIM}Integrity${RESET}             ${allVerified ? `${GREEN}${BOLD}ALL FILES VERIFIED — every extracted byte matches the source${RESET}` : `${RED}${BOLD}INTEGRITY FAILURE${RESET}`}`);
console.log(rule() + '\n');

[...fciCallbacks, ...fdiCallbacks, notify].forEach((cb) => cb.close());
rmSync(workspace, { recursive: true, force: true });
if (savedModeBuffer.readUInt32LE(0)) Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0));
process.exit(allVerified ? 0 : 1);
