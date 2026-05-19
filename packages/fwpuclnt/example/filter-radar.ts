/**
 * Windows Filtering Platform — Live Filter-Engine Radar
 *
 * A real-time animated console dashboard that sweeps the live Base Filtering
 * Engine. A rotating radar beam paints each WFP object class (filters,
 * callouts, layers, sub-layers, providers, IKE/IPsec SAs) as it passes;
 * shimmering gradient bars show relative scale, a scrolling sparkline tracks
 * the total filter count over time, and a heartbeat re-queries the engine
 * every frame — so every sweep is a fresh batch of real FFI round-trips into
 * `fwpuclnt.dll`, not a cached snapshot. If the engine denies access (the
 * expected non-elevated outcome) the radar degrades into a pulsing
 * "ACCESS DENIED" beacon while still proving the binding works.
 *
 * APIs demonstrated (Fwpuclnt):
 *   - FwpmEngineOpen0 / FwpmEngineClose0
 *   - FwpmFilterCreateEnumHandle0 / FwpmFilterEnum0 / FwpmFilterDestroyEnumHandle0
 *   - FwpmCalloutCreateEnumHandle0 / FwpmCalloutEnum0 / FwpmCalloutDestroyEnumHandle0
 *   - FwpmLayerCreateEnumHandle0 / FwpmLayerEnum0 / FwpmLayerDestroyEnumHandle0
 *   - FwpmSubLayerCreateEnumHandle0 / FwpmSubLayerEnum0 / FwpmSubLayerDestroyEnumHandle0
 *   - FwpmProviderCreateEnumHandle0 / FwpmProviderEnum0 / FwpmProviderDestroyEnumHandle0
 *   - IkeextSaCreateEnumHandle0 / IkeextSaEnum0 / IkeextSaDestroyEnumHandle0
 *   - IPsecSaCreateEnumHandle0 / IPsecSaEnum0 / IPsecSaDestroyEnumHandle0
 *   - FwpmFreeMemory0
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/filter-radar.ts
 */
import Fwpuclnt, { RPC_C_AUTHN_WINNT } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Fwpuclnt.Preload([
  'FwpmEngineOpen0',
  'FwpmEngineClose0',
  'FwpmFilterCreateEnumHandle0',
  'FwpmFilterEnum0',
  'FwpmFilterDestroyEnumHandle0',
  'FwpmCalloutCreateEnumHandle0',
  'FwpmCalloutEnum0',
  'FwpmCalloutDestroyEnumHandle0',
  'FwpmLayerCreateEnumHandle0',
  'FwpmLayerEnum0',
  'FwpmLayerDestroyEnumHandle0',
  'FwpmSubLayerCreateEnumHandle0',
  'FwpmSubLayerEnum0',
  'FwpmSubLayerDestroyEnumHandle0',
  'FwpmProviderCreateEnumHandle0',
  'FwpmProviderEnum0',
  'FwpmProviderDestroyEnumHandle0',
  'IkeextSaCreateEnumHandle0',
  'IkeextSaEnum0',
  'IkeextSaDestroyEnumHandle0',
  'IPsecSaCreateEnumHandle0',
  'IPsecSaEnum0',
  'IPsecSaDestroyEnumHandle0',
  'FwpmFreeMemory0',
]);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

const STD_OUTPUT_HANDLE = -11;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ERROR_SUCCESS = 0;

const out = (s: string) => process.stdout.write(s);
const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

/** Page through one object class and return its total count (-1 on failure). */
function count(engineHandle: bigint, create: (e: bigint, h: Buffer) => number, enumFn: (e: bigint, h: bigint, n: number, en: Buffer, rt: Buffer) => number, destroy: (e: bigint, h: bigint) => number): number {
  const hBuf = Buffer.alloc(8);
  if (create(engineHandle, hBuf) !== ERROR_SUCCESS) return -1;
  const h = hBuf.readBigUInt64LE(0);
  const BATCH = 512;
  const entriesOut = Buffer.alloc(8);
  const numReturned = Buffer.alloc(4);
  let total = 0;
  for (;;) {
    if (enumFn(engineHandle, h, BATCH, entriesOut, numReturned) !== ERROR_SUCCESS) break;
    const got = numReturned.readUInt32LE(0);
    total += got;
    if (entriesOut.readBigUInt64LE(0) !== 0n) Fwpuclnt.FwpmFreeMemory0(entriesOut.ptr);
    if (got < BATCH) break;
  }
  destroy(engineHandle, h);
  return total;
}

interface Channel {
  name: string;
  read: (e: bigint) => number;
}
const CHANNELS: Channel[] = [
  {
    name: 'FILTERS',
    read: (e) =>
      count(
        e,
        (x, h) => Fwpuclnt.FwpmFilterCreateEnumHandle0(x, null, h.ptr),
        (x, h, n, en, rt) => Fwpuclnt.FwpmFilterEnum0(x, h, n, en.ptr, rt.ptr),
        (x, h) => Fwpuclnt.FwpmFilterDestroyEnumHandle0(x, h),
      ),
  },
  {
    name: 'CALLOUTS',
    read: (e) =>
      count(
        e,
        (x, h) => Fwpuclnt.FwpmCalloutCreateEnumHandle0(x, null, h.ptr),
        (x, h, n, en, rt) => Fwpuclnt.FwpmCalloutEnum0(x, h, n, en.ptr, rt.ptr),
        (x, h) => Fwpuclnt.FwpmCalloutDestroyEnumHandle0(x, h),
      ),
  },
  {
    name: 'LAYERS',
    read: (e) =>
      count(
        e,
        (x, h) => Fwpuclnt.FwpmLayerCreateEnumHandle0(x, null, h.ptr),
        (x, h, n, en, rt) => Fwpuclnt.FwpmLayerEnum0(x, h, n, en.ptr, rt.ptr),
        (x, h) => Fwpuclnt.FwpmLayerDestroyEnumHandle0(x, h),
      ),
  },
  {
    name: 'SUBLAYERS',
    read: (e) =>
      count(
        e,
        (x, h) => Fwpuclnt.FwpmSubLayerCreateEnumHandle0(x, null, h.ptr),
        (x, h, n, en, rt) => Fwpuclnt.FwpmSubLayerEnum0(x, h, n, en.ptr, rt.ptr),
        (x, h) => Fwpuclnt.FwpmSubLayerDestroyEnumHandle0(x, h),
      ),
  },
  {
    name: 'PROVIDERS',
    read: (e) =>
      count(
        e,
        (x, h) => Fwpuclnt.FwpmProviderCreateEnumHandle0(x, null, h.ptr),
        (x, h, n, en, rt) => Fwpuclnt.FwpmProviderEnum0(x, h, n, en.ptr, rt.ptr),
        (x, h) => Fwpuclnt.FwpmProviderDestroyEnumHandle0(x, h),
      ),
  },
  {
    name: 'IKE SAs',
    read: (e) =>
      count(
        e,
        (x, h) => Fwpuclnt.IkeextSaCreateEnumHandle0(x, null, h.ptr),
        (x, h, n, en, rt) => Fwpuclnt.IkeextSaEnum0(x, h, n, en.ptr, rt.ptr),
        (x, h) => Fwpuclnt.IkeextSaDestroyEnumHandle0(x, h),
      ),
  },
  {
    name: 'IPSEC SAs',
    read: (e) =>
      count(
        e,
        (x, h) => Fwpuclnt.IPsecSaCreateEnumHandle0(x, null, h.ptr),
        (x, h, n, en, rt) => Fwpuclnt.IPsecSaEnum0(x, h, n, en.ptr, rt.ptr),
        (x, h) => Fwpuclnt.IPsecSaDestroyEnumHandle0(x, h),
      ),
  },
];

const FRAMES = 90;
const SPARK = ' ▁▂▃▄▅▆▇█';
const history: number[] = [];

out('\x1b[?25l\x1b[2J'); // hide cursor, clear

const engineHandleBuf = Buffer.alloc(8);
const openStatus = Fwpuclnt.FwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, null, null, engineHandleBuf.ptr);
const engineHandle = openStatus === ERROR_SUCCESS ? engineHandleBuf.readBigUInt64LE(0) : 0n;

for (let frame = 0; frame < FRAMES; frame++) {
  const beam = (frame / FRAMES) * Math.PI * 2;
  out('\x1b[H');

  // Animated gradient title.
  const title = 'W F P   F I L T E R - E N G I N E   R A D A R';
  let head = '  ';
  for (let i = 0; i < title.length; i++) {
    const p = (i / title.length + frame / 18) % 1;
    head += rgb(Math.round(120 + 110 * Math.sin(p * 6.28)), Math.round(170 + 80 * Math.sin(p * 6.28 + 2)), 255) + title[i];
  }
  out(head + RESET + '\x1b[K\n');
  out(`  ${DIM}base filtering engine · live FFI sweep · frame ${String(frame + 1).padStart(2)}/${FRAMES}${RESET}\x1b[K\n\n`);

  if (engineHandle === 0n) {
    const pulse = 0.5 + 0.5 * Math.sin(frame / 3);
    const c = rgb(Math.round(120 + 135 * pulse), Math.round(40 + 30 * pulse), Math.round(40 + 30 * pulse));
    out(`  ${c}${BOLD}◉  ACCESS DENIED  ◉${RESET}\x1b[K\n\n`);
    out(`  ${DIM}The fwpuclnt.dll binding round-tripped correctly; the Base Filtering${RESET}\x1b[K\n`);
    out(`  ${DIM}Engine requires an elevated session for read access. Re-run as admin${RESET}\x1b[K\n`);
    out(`  ${DIM}to watch the live radar.${RESET}\x1b[K\n`);
    await Bun.sleep(70);
    continue;
  }

  const values = CHANNELS.map((ch) => ch.read(engineHandle));
  const max = Math.max(8, ...values.map((v) => (v > 0 ? v : 0)));
  history.push(values[0] > 0 ? values[0] : 0);
  if (history.length > 48) history.shift();

  CHANNELS.forEach((ch, i) => {
    const angle = (i / CHANNELS.length) * Math.PI * 2;
    let diff = Math.abs(((angle - beam) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    const lit = Math.max(0, 1 - diff / 0.9); // radar beam proximity glow
    const v = values[i];
    const width = 34;
    const filled = v <= 0 ? 0 : Math.max(1, Math.round((Math.min(v, max) / max) * width));

    let row = `  ${BOLD}${ch.name.padEnd(10)}${RESET}`;
    if (v < 0) {
      row += `${DIM}${'—'.repeat(width)}${RESET}  ${DIM}n/a${RESET}`;
    } else {
      let b = '';
      for (let x = 0; x < width; x++) {
        if (x < filled) {
          const t = x / width;
          const g = Math.round(120 + 135 * lit);
          b += rgb(Math.round(60 + 120 * t), g, Math.round(140 + 90 * (1 - t))) + '█';
        } else b += DIM + '·';
      }
      row += b + RESET + `  ${BOLD}${rgb(140, 230, 160)}${String(v).padStart(5)}${RESET}`;
    }
    out(row + '\x1b[K\n');
  });

  // Radar dial + filter-count sparkline.
  const dial = ['◐', '◓', '◑', '◒'][frame % 4];
  const spark = history.map((h) => SPARK[Math.min(8, Math.round((h / Math.max(1, ...history)) * 8))]).join('');
  out(`\n  ${rgb(120, 200, 255)}${dial}${RESET} sweep  ${DIM}filter history${RESET} ${rgb(140, 230, 160)}${spark}${RESET}\x1b[K\n`);
  out(`  ${DIM}Σ ${values.reduce((a, b) => a + (b > 0 ? b : 0), 0)} WFP objects observed this sweep${RESET}\x1b[K\n`);

  await Bun.sleep(70);
}

if (engineHandle !== 0n) Fwpuclnt.FwpmEngineClose0(engineHandle);
out('\x1b[?25h\n'); // restore cursor
console.log(`  ${rgb(140, 230, 160)}${BOLD}● Radar sweep complete — Base Filtering Engine released.${RESET}\n`);
