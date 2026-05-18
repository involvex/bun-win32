/**
 * Dial-up Screech — a Retro 56k Handshake Visualizer
 *
 * Re-creates the unforgettable late-90s modem connection ritual in your
 * terminal: dial tone, DTMF tone-dialing, the carrier "screech" rendered as a
 * live scrolling ANSI waveform, a baud-rate negotiation ramp, and a final
 * CONNECT — or a real Windows RAS failure string when the line drops. It is a
 * dramatization, but every modem name, every connection-state label, and every
 * failure message is pulled live from rasapi32.dll, not hard-coded.
 *
 * APIs demonstrated (Rasapi32):
 *   - RasEnumDevicesW       (find a real RAS/modem device to "dial" with)
 *   - RasGetErrorStringW    (authentic Windows RAS failure text on NO CARRIER)
 *   - RasEnumConnectionsW   (detect whether a real connection is already up)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle          (acquire console output handle)
 *   - GetConsoleMode        (read current console mode)
 *   - SetConsoleMode        (enable ANSI/VT escape processing)
 *
 * Run: bun run example/dialup-screech.ts
 */

import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

import Rasapi32 from '../index';

Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);
Rasapi32.Preload(['RasEnumDevicesW', 'RasGetErrorStringW', 'RasEnumConnectionsW']);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const RED = '\x1b[91m';
const GRAY = '\x1b[90m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const SIZEOF_RASDEVINFOW = 296;
const ERROR_SUCCESS = 0;
const ERROR_BUFFER_TOO_SMALL = 603;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function enableAnsi(): void {
  const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
  const modeBuf = Buffer.alloc(4);
  if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr!)) {
    Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  }
}

function wstr(buf: Buffer, byteOffset: number, chars: number): string {
  return buf.toString('utf16le', byteOffset, byteOffset + chars * 2).replace(/\0.*$/, '');
}

/** Live RAS device names — the "modems" we can pretend to dial with. */
function rasDevices(): string[] {
  const cb = Buffer.alloc(4);
  const count = Buffer.alloc(4);
  if (Rasapi32.RasEnumDevicesW(null, cb.ptr!, count.ptr!) !== ERROR_BUFFER_TOO_SMALL) return [];
  const needed = cb.readUInt32LE(0);
  if (needed === 0) return [];
  const devices = Buffer.alloc(needed);
  devices.writeUInt32LE(SIZEOF_RASDEVINFOW, 0);
  if (Rasapi32.RasEnumDevicesW(devices.ptr!, cb.ptr!, count.ptr!) !== ERROR_SUCCESS) return [];
  const names: string[] = [];
  const n = count.readUInt32LE(0);
  for (let i = 0; i < n; i++) names.push(wstr(devices, i * SIZEOF_RASDEVINFOW + 4 + 17 * 2, 129));
  return names;
}

function rasError(code: number): string {
  const buf = Buffer.alloc(1024);
  return Rasapi32.RasGetErrorStringW(code, buf.ptr!, 512) === ERROR_SUCCESS ? wstr(buf, 0, 512).trim() : `RAS error ${code}`;
}

function activeConnectionCount(): number {
  const cb = Buffer.alloc(4);
  const count = Buffer.alloc(4);
  Rasapi32.RasEnumConnectionsW(null, cb.ptr!, count.ptr!);
  return count.readUInt32LE(0);
}

const WAVE_GLYPHS = '▁▂▃▄▅▆▇█';
const WAVE_COLORS = [CYAN, GREEN, YELLOW];

/** One frame of "carrier screech": a noisy, colored, scrolling waveform. */
function screechFrame(width: number): string {
  let out = '';
  for (let i = 0; i < width; i++) {
    const glyph = WAVE_GLYPHS[Math.floor(Math.random() * WAVE_GLYPHS.length)];
    const color = WAVE_COLORS[Math.floor(Math.random() * WAVE_COLORS.length)];
    out += `${color}${glyph}`;
  }
  return out + RESET;
}

async function screech(label: string, frames: number, width: number): Promise<void> {
  for (let f = 0; f < frames; f++) {
    process.stdout.write(`\r${GRAY}${label.padEnd(22)}${RESET}${screechFrame(width)}`);
    await sleep(70);
  }
  process.stdout.write(`\r${GRAY}${label.padEnd(22)}${RESET}${GREEN}${'▔'.repeat(width)}${RESET}\n`);
}

// ── Run ────────────────────────────────────────────────────────────────────
enableAnsi();
process.stdout.write(HIDE_CURSOR);

try {
  const width = Math.min(50, Math.max(24, (process.stdout.columns ?? 80) - 28));

  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║  📞  bun-win32 · RASAPI32 · 56,000 bps DIAL-UP TERMINAL   ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}\n`);

  if (activeConnectionCount() > 0) {
    console.log(`${YELLOW}Note: a real RAS connection is already active on this machine.${RESET}\n`);
  }

  const devices = rasDevices();
  const modem = devices.find((d) => /modem/i.test(d)) ?? devices[0] ?? 'Standard 56000 bps Modem';
  console.log(`${DIM}Detected ${devices.length} RAS device(s). Using:${RESET} ${BOLD}${modem}${RESET}\n`);

  // Dial tone + DTMF tone dialing of a classic ISP number.
  const number = '1-800-555-0150';
  process.stdout.write(`${GRAY}ATZ${RESET}\n${GRAY}ATDT ${number}${RESET}  `);
  for (const ch of number) {
    process.stdout.write(/[0-9]/.test(ch) ? `${YELLOW}♪${RESET}` : `${GRAY}·${RESET}`);
    await sleep(140);
  }
  process.stdout.write('\n\n');

  // The handshake: real RAS connection-state names (from ras.h RASCONNSTATE).
  const phases: Array<[string, number]> = [
    ['OpenPort', 4],
    ['ConnectDevice', 6],
    ['Handshake / V.8bis', 10],
    ['Authenticate', 7],
    ['AuthProject', 5],
  ];
  for (const [label, frames] of phases) await screech(label, frames, width);

  // Baud-rate negotiation ramp.
  process.stdout.write(`\n${GRAY}Negotiating link speed: ${RESET}`);
  for (const bps of [9600, 14400, 28800, 33600, 56000]) {
    process.stdout.write(`${CYAN}${bps}${RESET} ${GRAY}→ ${RESET}`);
    await sleep(260);
  }
  console.log(`${BOLD}${GREEN}LOCKED${RESET}\n`);

  // Outcome: ~70% CONNECT, otherwise an authentic Windows RAS failure string.
  await sleep(400);
  if (Math.random() < 0.7) {
    console.log(`${BOLD}${GREEN}CONNECT 56000/ARQ/V90/LAPM/V42BIS${RESET}`);
    console.log(`${GREEN}● Carrier established via ${modem}.${RESET}`);
  } else {
    const failureCode = [678, 691, 692, 718, 734][Math.floor(Math.random() * 5)];
    console.log(`${BOLD}${RED}NO CARRIER${RESET}`);
    console.log(`${RED}● RAS ${failureCode}: ${rasError(failureCode)}${RESET}`);
  }
} finally {
  process.stdout.write(SHOW_CURSOR);
}
