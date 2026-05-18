/**
 * Minifilter Altitude Radar
 *
 * A live, animated ANSI radar of the Windows file-system filter stack. Every
 * I/O on the machine flows through an ordered stack of minifilter instances,
 * ranked by "altitude" — the higher the altitude, the farther from the disk.
 * This visualizes that stack as an animated tower: each minifilter is a bar
 * placed at its real altitude, vendor-tinted, with a sweeping scan line
 * raking the stack and a pulsing readout of frame ids and instance counts.
 * Enumerating the Filter Manager requires elevation (the same restriction
 * `fltmc` carries); unelevated, the radar honestly renders an animated
 * access gate — the FFI call still executes and surfaces the exact HRESULT.
 *
 * APIs demonstrated (Fltlib):
 *   - FilterFindFirst / FilterFindNext / FilterFindClose          (minifilters)
 *   - FilterInstanceFindFirst / ...FindNext / ...FindClose        (altitudes)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/filter-radar.ts   (run elevated for the live stack)
 */
import Fltlib, { FILTER_INFORMATION_CLASS, INSTANCE_INFORMATION_CLASS } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Fltlib.Preload(['FilterFindFirst', 'FilterFindNext', 'FilterFindClose', 'FilterInstanceFindFirst', 'FilterInstanceFindNext', 'FilterInstanceFindClose']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

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
const RED = '\x1b[38;2;240;110;110m';
const YELLOW = '\x1b[38;2;235;205;100m';
const CYAN = '\x1b[38;2;120;200;255m';
const GREEN = '\x1b[38;2;90;220;130m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';

const S_OK = 0;
const ERROR_ACCESS_DENIED = 0x80070005 | 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hex = (hr: number) => '0x' + (hr >>> 0).toString(16).toUpperCase().padStart(8, '0');

const BUF_BYTES = 64 * 1024;
const dataBuf = Buffer.alloc(BUF_BYTES);
const bytesBuf = Buffer.alloc(4);
const findHandleBuf = Buffer.alloc(8);

interface Filter {
  name: string;
  frameId: number;
  numberOfInstances: number;
  altitude: number;
}

// Tint a bar by a stable hash of the minifilter name (vendor fingerprint).
function tint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const r = 90 + (h & 0x7f);
  const g = 90 + ((h >> 7) & 0x7f);
  const b = 120 + ((h >> 14) & 0x6f);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function topAltitude(filterName: string): number {
  const nameBuf = Buffer.from(filterName + '\0', 'utf16le');
  dataBuf.fill(0);
  let hr = Fltlib.FilterInstanceFindFirst(nameBuf.ptr!, INSTANCE_INFORMATION_CLASS.InstanceFullInformation, dataBuf.ptr!, BUF_BYTES, bytesBuf.ptr!, findHandleBuf.ptr!);
  if (hr !== S_OK) return 0;
  const hFind = findHandleBuf.readBigUInt64LE(0);
  let best = 0;
  for (;;) {
    const altLen = dataBuf.readUInt32LE(12);
    const altOff = dataBuf.readUInt32LE(16);
    best = Math.max(best, parseFloat(dataBuf.subarray(altOff, altOff + altLen).toString('utf16le')) || 0);
    dataBuf.fill(0);
    hr = Fltlib.FilterInstanceFindNext(hFind, INSTANCE_INFORMATION_CLASS.InstanceFullInformation, dataBuf.ptr!, BUF_BYTES, bytesBuf.ptr!);
    if (hr !== S_OK) break;
  }
  Fltlib.FilterInstanceFindClose(hFind);
  return best;
}

function enumerate(): { filters: Filter[]; hr: number } {
  const filters: Filter[] = [];
  dataBuf.fill(0);
  let hr = Fltlib.FilterFindFirst(FILTER_INFORMATION_CLASS.FilterFullInformation, dataBuf.ptr!, BUF_BYTES, bytesBuf.ptr!, findHandleBuf.ptr!);
  if (hr !== S_OK) return { filters, hr };
  const hFind = findHandleBuf.readBigUInt64LE(0);
  const read = () => {
    const frameId = dataBuf.readUInt32LE(4);
    const numberOfInstances = dataBuf.readUInt32LE(8);
    const nameLen = dataBuf.readUInt16LE(12);
    const name = dataBuf.subarray(14, 14 + nameLen).toString('utf16le');
    return { name, frameId, numberOfInstances, altitude: topAltitude(name) };
  };
  filters.push(read());
  for (;;) {
    dataBuf.fill(0);
    hr = Fltlib.FilterFindNext(hFind, FILTER_INFORMATION_CLASS.FilterFullInformation, dataBuf.ptr!, BUF_BYTES, bytesBuf.ptr!);
    if (hr !== S_OK) break;
    filters.push(read());
  }
  Fltlib.FilterFindClose(hFind);
  return { filters: filters.sort((a, b) => b.altitude - a.altitude), hr: S_OK };
}

const { filters, hr } = enumerate();

process.stdout.write(HIDE_CURSOR + CLEAR);
try {
  const FRAMES = 40;
  for (let frame = 0; frame < FRAMES; frame++) {
    const pulse = frame % 2 === 0;
    let out = HOME;
    out += `${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${RESET}\n`;
    out += `${BOLD}${CYAN}║   WINDOWS FILTER MANAGER  ·  MINIFILTER ALTITUDE RADAR               ║${RESET}\n`;
    out += `${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${RESET}\n\n`;

    if (hr !== S_OK) {
      const lit = pulse ? RED : YELLOW;
      const sweep = frame % 8;
      out += `  ${lit}${BOLD}▲  ACCESS GATE — ADMINISTRATOR REQUIRED${RESET}\n\n`;
      out += `  ${DIM}FilterFindFirst → ${hex(hr)}${(hr | 0) === ERROR_ACCESS_DENIED ? ' (HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED))' : ''}${RESET}\n`;
      out += `  ${DIM}The minifilter stack is readable only by an elevated caller — the${RESET}\n`;
      out += `  ${DIM}same wall \`fltmc\` hits. The FFI call executed and returned the exact${RESET}\n`;
      out += `  ${DIM}documented HRESULT; re-run elevated to see the live stack.${RESET}\n\n`;
      for (let i = 0; i < 9; i++) out += `  ${i === sweep ? `${lit}████████████████████████████████${RESET}` : `${DIM}░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░${RESET}`}\n`;
      process.stdout.write(out);
      await sleep(110);
      continue;
    }

    const maxAlt = Math.max(1, ...filters.map((f) => f.altitude));
    const scan = frame % (filters.length + 4);
    out += `  ${BOLD}${GREEN}${filters.length}${RESET} minifilters in the stack  ${DIM}· bar length ∝ altitude (distance from disk)${RESET}\n\n`;
    for (const [i, f] of filters.entries()) {
      const width = Math.max(1, Math.round((f.altitude / maxAlt) * 44));
      const swept = i === scan;
      const color = swept ? (pulse ? `${BOLD}${CYAN}` : `${BOLD}${YELLOW}`) : tint(f.name);
      const bar = (swept ? '▓' : '█').repeat(width);
      out += `  ${color}${f.altitude.toString().padStart(8)}${RESET} ${color}${bar}${RESET}\n`;
      out += `  ${DIM}${''.padStart(8)} ${f.name} · frame ${f.frameId} · ${f.numberOfInstances} inst${RESET}\n`;
    }
    out += `\n  ${DIM}top = highest altitude (closest to the app); bottom = closest to disk${RESET}\n`;
    process.stdout.write(out);
    await sleep(120);
  }
} finally {
  process.stdout.write(SHOW_CURSOR + '\n');
}
