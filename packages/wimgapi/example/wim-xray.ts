/**
 * WIM X-Ray
 *
 * A live, animated X-ray of a Windows image's file tree, driven entirely by
 * the real WIMGAPI imaging engine calling back into JavaScript.
 *
 * A `bun:ffi` JSCallback is registered with WIMRegisterMessageCallback, then
 * WIMApplyImage is invoked with `pszPath = NULL` and WIM_FLAG_NO_APPLY — the
 * documented "enumerate, don't extract" mode (this is exactly why pszPath is
 * typed `PCWSTR | NULL`). The engine walks every file and directory in the
 * image and fires WIM_MSG_PROCESS for each one; the callback streams those
 * paths into an animated truecolor dashboard — a scrolling file cascade, a
 * per-second throughput meter, a depth histogram, and a WIM_MSG_PROGRESS bar.
 * Nothing is written to disk; every glyph is a real file the WIM engine
 * reported, pulled through pure FFI.
 *
 * Pass a .wim to X-ray it read-only (no elevation needed). With no argument
 * it synthesizes and captures a tree instead (capture needs elevation).
 *
 * APIs demonstrated (Wimgapi):
 *   - WIMCreateFile               (open the .wim read-only / create one)
 *   - WIMLoadImage                (handle to the volume image to enumerate)
 *   - WIMRegisterMessageCallback  (FARPROC -> a bun:ffi JSCallback)
 *   - WIMApplyImage               (pszPath = NULL + WIM_FLAG_NO_APPLY)
 *   - WIMSetTemporaryPath / WIMCaptureImage  (no-argument synthesis path)
 *   - WIMUnregisterMessageCallback / WIMCloseHandle
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *   - GetLastError                (decode imaging failures)
 *
 * Run: bun run example/wim-xray.ts [path\to\image.wim]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FFIType, JSCallback, read, toArrayBuffer, type Pointer } from 'bun:ffi';

import Wimgapi, { WIMCompressionType, WIMCreationDisposition, WIMDesiredAccess, WIMFlag, WIMMessage, WIMMessageResult } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Wimgapi.Preload(['WIMCreateFile', 'WIMLoadImage', 'WIMRegisterMessageCallback', 'WIMApplyImage', 'WIMSetTemporaryPath', 'WIMCaptureImage', 'WIMUnregisterMessageCallback', 'WIMCloseHandle']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'GetLastError']);

const STD_OUTPUT_HANDLE = -11;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
const modeBuffer = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuffer.ptr!)) {
  Kernel32.SetConsoleMode(hStdout, modeBuffer.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CLEAR = '\x1b[2J';
const HOME = '\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const wide = (text: string): Buffer => Buffer.from(text + '\0', 'utf16le');
const heat = (t: number): string => `\x1b[38;2;${Math.round(60 + 195 * t)};${Math.round(120 + 90 * Math.sin(t * 3.14))};${Math.round(255 - 150 * t)}m`;

// Read a NUL-terminated UTF-16LE string out of native memory at `address`.
// The engine hands the path as a WPARAM (UINT_PTR); round-trip it through a
// cell so `read.ptr` yields an address we can bridge to a `Pointer`.
function readWideAt(address: bigint, maxChars = 520): string {
  if (address === 0n) return '';
  const cell = Buffer.alloc(8);
  cell.writeBigUInt64LE(address, 0);
  const raw = read.ptr(cell.ptr!, 0);
  if (!raw) return '';
  const base = raw as Pointer;
  const codeUnits: number[] = [];
  for (let i = 0; i < maxChars; i++) {
    const unit = read.u16(base, i * 2);
    if (unit === 0) break;
    codeUnits.push(unit);
  }
  return String.fromCharCode(...codeUnits);
}

const argument = process.argv[2];
const scratchDirectory = join(tmpdir(), `wim-xray-${process.pid}`);
const sourceDirectory = join(scratchDirectory, 'payload');

let filesSeen = 0;
let directoriesSeen = 0;
let deepest = 0;
let percent = 0;
const recent: string[] = [];
const depthHistogram = new Array<number>(16).fill(0);
const startTime = performance.now();
let lastRender = 0;
let renderingActive = false;

function render(force = false): void {
  const now = performance.now();
  if (!force && now - lastRender < 33) return;
  lastRender = now;
  const elapsed = (now - startTime) / 1000;
  const rate = elapsed > 0 ? Math.round((filesSeen + directoriesSeen) / elapsed) : 0;

  const lines: string[] = [];
  lines.push(`${BOLD}\x1b[38;2;120;205;255m  W I M   X - R A Y${RESET}${DIM}   live file-tree enumeration via the imaging engine${RESET}`);
  lines.push('');
  lines.push(
    `  ${DIM}entries${RESET} ${BOLD}${(filesSeen + directoriesSeen).toLocaleString()}${RESET}   ${DIM}files${RESET} ${filesSeen.toLocaleString()}   ${DIM}dirs${RESET} ${directoriesSeen.toLocaleString()}   ${DIM}rate${RESET} ${rate.toLocaleString()}/s   ${DIM}t${RESET} ${elapsed.toFixed(1)}s`,
  );

  const barWidth = 46;
  const filled = Math.round((percent / 100) * barWidth);
  lines.push(`  ${DIM}progress${RESET} [${heat(percent / 100)}${'█'.repeat(filled)}${RESET}${DIM}${'░'.repeat(barWidth - filled)}${RESET}] ${percent.toString().padStart(3)}%`);
  lines.push('');

  const maxDepth = Math.max(1, ...depthHistogram);
  lines.push(`  ${DIM}depth distribution${RESET}`);
  for (let d = 0; d < 12; d++) {
    if (depthHistogram[d] === 0 && d > deepest) break;
    const width = Math.round((depthHistogram[d] / maxDepth) * 40);
    lines.push(`   ${d.toString().padStart(2)} ${heat(d / 12)}${'▇'.repeat(width)}${RESET} ${DIM}${depthHistogram[d]}${RESET}`);
  }
  lines.push('');
  lines.push(`  ${DIM}most recent${RESET}`);
  for (let i = 0; i < recent.length; i++) {
    const tone = i / Math.max(1, recent.length);
    lines.push(`   ${heat(1 - tone)}${recent[i]}${RESET}`);
  }

  process.stdout.write(HOME + CLEAR + lines.join('\n') + '\n');
}

// The WIMMessageCallback: DWORD (DWORD msg, WPARAM, LPARAM, PVOID user).
const callback = new JSCallback(
  (messageId: number, wParam: bigint, lParam: bigint): number => {
    if (messageId === WIMMessage.WIM_MSG_PROCESS) {
      // wParam = (PWSTR) pszFullPath ; lParam = (PBOOL) pfProcessFile
      const fullPath = readWideAt(wParam);
      const isDirectory = !/\.[^\\/.]{1,8}$/.test(fullPath);
      if (isDirectory) directoriesSeen++;
      else filesSeen++;
      const depth = (fullPath.match(/\\/g) ?? []).length;
      deepest = Math.max(deepest, depth);
      if (depth < depthHistogram.length) depthHistogram[depth]++;
      const shown = fullPath.length > 72 ? '…' + fullPath.slice(-71) : fullPath;
      recent.unshift(shown);
      if (recent.length > 10) recent.pop();
      // Set *pfProcessFile = TRUE so the engine keeps walking the tree.
      if (lParam !== 0n) {
        const cell = Buffer.alloc(8);
        cell.writeBigInt64LE(lParam, 0);
        const raw = read.ptr(cell.ptr!, 0);
        if (raw) new DataView(toArrayBuffer(raw as Pointer, 0, 4)).setInt32(0, 1, true);
      }
      if (renderingActive) render();
      return WIMMessageResult.WIM_MSG_SUCCESS;
    }
    if (messageId === WIMMessage.WIM_MSG_PROGRESS) {
      percent = Number(wParam & 0xffffffffn);
      if (renderingActive) render();
      return WIMMessageResult.WIM_MSG_SUCCESS;
    }
    return WIMMessageResult.WIM_MSG_SUCCESS;
  },
  { args: [FFIType.u32, FFIType.u64, FFIType.i64, FFIType.ptr], returns: FFIType.u32 },
);

function finish(message: string, ok: boolean): void {
  renderingActive = false;
  render(true);
  process.stdout.write(SHOW_CURSOR);
  console.log(`\n${ok ? `${BOLD}\x1b[38;2;130;230;160m✓` : `${BOLD}\x1b[38;2;255;120;120m✗`} ${message}${RESET}`);
}

try {
  mkdirSync(scratchDirectory, { recursive: true });
  process.stdout.write(HIDE_CURSOR + CLEAR);

  let hWim = 0n;
  let hImage = 0n;
  let mode: 'enumerate' | 'capture' = 'enumerate';

  if (argument) {
    const openResult = Buffer.alloc(4);
    hWim = Wimgapi.WIMCreateFile(wide(argument).ptr!, WIMDesiredAccess.WIM_GENERIC_READ, WIMCreationDisposition.WIM_OPEN_EXISTING, 0, 0, openResult.ptr!);
    if (hWim === 0n) throw new Error(`WIMCreateFile failed for ${argument} — GetLastError=${Kernel32.GetLastError()}`);
    hImage = Wimgapi.WIMLoadImage(hWim, 1);
    if (hImage === 0n) throw new Error(`WIMLoadImage(#1) failed — GetLastError=${Kernel32.GetLastError()}`);
  } else {
    // No image supplied: synthesize a tree and X-ray a real capture instead.
    mode = 'capture';
    mkdirSync(sourceDirectory, { recursive: true });
    for (let d = 0; d < 5; d++) {
      const sub = join(sourceDirectory, `branch-${d}`, `leaf-${d}`);
      mkdirSync(sub, { recursive: true });
      for (let f = 0; f < 36; f++) writeFileSync(join(sub, `node-${f}.dat`), `payload ${d}.${f} ${'x'.repeat(900)}`);
    }
    const writeResult = Buffer.alloc(4);
    hWim = Wimgapi.WIMCreateFile(wide(join(scratchDirectory, 'xray.wim')).ptr!, WIMDesiredAccess.WIM_GENERIC_WRITE, WIMCreationDisposition.WIM_CREATE_ALWAYS, 0, WIMCompressionType.WIM_COMPRESS_XPRESS, writeResult.ptr!);
    if (hWim === 0n) throw new Error(`WIMCreateFile(write) failed — GetLastError=${Kernel32.GetLastError()}`);
    if (!Wimgapi.WIMSetTemporaryPath(hWim, wide(scratchDirectory).ptr!)) throw new Error(`WIMSetTemporaryPath failed — GetLastError=${Kernel32.GetLastError()}`);
  }

  // Register the JS callback as the engine's FARPROC message sink.
  if (Wimgapi.WIMRegisterMessageCallback(hWim, callback.ptr!, null) === 0xffffffff) {
    throw new Error(`WIMRegisterMessageCallback failed — GetLastError=${Kernel32.GetLastError()}`);
  }
  renderingActive = true;
  render(true);

  let succeeded = false;
  if (mode === 'enumerate') {
    // pszPath = NULL + WIM_FLAG_NO_APPLY: enumerate the tree, extract nothing.
    succeeded = Wimgapi.WIMApplyImage(hImage, null, WIMFlag.WIM_FLAG_NO_APPLY) !== 0;
  } else {
    const captured = Wimgapi.WIMCaptureImage(hWim, wide(sourceDirectory).ptr!, 0);
    succeeded = captured !== 0n;
    if (captured !== 0n) Wimgapi.WIMCloseHandle(captured);
  }
  const lastError = succeeded ? 0 : Kernel32.GetLastError();

  Wimgapi.WIMUnregisterMessageCallback(hWim, callback.ptr!);
  if (hImage !== 0n) Wimgapi.WIMCloseHandle(hImage);
  Wimgapi.WIMCloseHandle(hWim);

  if (succeeded) {
    finish(`X-ray complete — ${(filesSeen + directoriesSeen).toLocaleString()} entries enumerated through the WIM engine.`, true);
  } else if (lastError === 1314 && mode === 'capture') {
    finish('Capture needs elevation (ERROR_PRIVILEGE_NOT_HELD). Re-run elevated, or pass a .wim path to X-ray one read-only — no elevation required.', false);
    process.exitCode = 0;
  } else {
    finish(`${mode === 'enumerate' ? 'WIMApplyImage' : 'WIMCaptureImage'} failed — GetLastError=${lastError}`, false);
    process.exitCode = 1;
  }
} catch (error) {
  finish((error as Error).message, false);
  process.exitCode = 1;
} finally {
  callback.close();
  if (!argument) {
    try {
      rmSync(scratchDirectory, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
