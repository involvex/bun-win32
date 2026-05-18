/**
 * Screen Color Lab
 *
 * Drives the Windows full-screen magnifier's color pipeline to recolor the
 * ENTIRE desktop in real time — no overlay window, no screen capture, just a
 * 5x5 color-transform matrix handed straight to the OS compositor. The console
 * shows a live dashboard of the active matrix and a countdown while the whole
 * screen cycles through grayscale, photo-negative, sepia, and a protanopia
 * (red/green color-blindness) simulation, then restores the exact matrix that
 * was in effect before the demo started.
 *
 * The original matrix is captured up front and reapplied on normal exit and on
 * Ctrl+C, so the screen is always returned to how it was found.
 *
 * APIs demonstrated (Magnification):
 *   - MagInitialize                 (create the magnifier runtime objects)
 *   - MagGetFullscreenColorEffect   (capture the current screen color matrix)
 *   - MagSetFullscreenColorEffect   (recolor the entire desktop)
 *   - MagUninitialize               (tear down the magnifier runtime objects)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle                  (stdout handle for console mode)
 *   - GetConsoleMode / SetConsoleMode (enable ANSI escape processing)
 *   - SetConsoleTitleW              (set the console window title)
 *
 * MAGCOLOREFFECT layout: float transform[5][5], row-major, 100 bytes. A pixel
 * [R G B A 1] is multiplied by this matrix; row i is the contribution of input
 * channel i to each output channel (the GDI+ color-matrix convention).
 *
 * Run: bun run example/screen-color-lab.ts
 */

import Magnification from '../index';
import Kernel32, { STD_HANDLE } from '@bun-win32/kernel32';

Magnification.Preload(['MagInitialize', 'MagGetFullscreenColorEffect', 'MagSetFullscreenColorEffect', 'MagUninitialize']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'SetConsoleTitleW']);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const RED = '\x1b[91m';
const WHITE = '\x1b[97m';
const MAGENTA = '\x1b[95m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';
const HOME = '\x1b[H';

// Enable ANSI escape processing on the console (ConPTY-safe; never WriteConsoleW).
const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | 0x0004); // ENABLE_VIRTUAL_TERMINAL_PROCESSING
}
Kernel32.SetConsoleTitleW(Buffer.from('Screen Color Lab\0', 'utf16le').ptr);

const IDENTITY = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];

interface Effect {
  name: string;
  blurb: string;
  color: string;
  matrix: number[];
}

const effects: Effect[] = [
  {
    name: 'Grayscale',
    blurb: 'Luminance-weighted desaturation (0.30 R, 0.59 G, 0.11 B)',
    color: WHITE,
    matrix: [0.3, 0.3, 0.3, 0, 0, 0.59, 0.59, 0.59, 0, 0, 0.11, 0.11, 0.11, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  },
  {
    name: 'Photo Negative',
    blurb: 'Inverts every channel: out = 1 - in',
    color: MAGENTA,
    matrix: [-1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  },
  {
    name: 'Sepia',
    blurb: 'Warm vintage tone mapping',
    color: YELLOW,
    matrix: [0.393, 0.349, 0.272, 0, 0, 0.769, 0.686, 0.534, 0, 0, 0.189, 0.168, 0.131, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  },
  {
    name: 'Protanopia Sim',
    blurb: 'Approximates red/green (red-blind) color vision',
    color: RED,
    matrix: [0.567, 0.558, 0, 0, 0, 0.433, 0.442, 0.242, 0, 0, 0, 0, 0.758, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  },
];

function toMatrixBuffer(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer); // 25 floats = 100 bytes
}

function renderMatrix(values: number[], accent: string): string {
  const rowLabels = ['R', 'G', 'B', 'A', 'T'];
  let out = '';
  for (let row = 0; row < 5; row++) {
    const cells: string[] = [];
    for (let col = 0; col < 5; col++) {
      const v = values[row * 5 + col];
      const text = (v >= 0 ? ' ' : '') + v.toFixed(3);
      const colored = v === 0 ? `${DIM}${text}${RESET}` : `${accent}${text}${RESET}`;
      cells.push(colored);
    }
    out += `   ${DIM}${rowLabels[row]}${RESET} │ ${cells.join('  ')} │\n`;
  }
  return out;
}

function bar(fraction: number, width: number, accent: string): string {
  const filled = Math.round(fraction * width);
  return `${accent}${'█'.repeat(filled)}${DIM}${'░'.repeat(width - filled)}${RESET}`;
}

// Capture whatever color matrix is currently applied so we can restore it.
const savedBuf = Buffer.alloc(100);
let canRestore = false;

function restore(): void {
  if (canRestore) {
    Magnification.MagSetFullscreenColorEffect(savedBuf.ptr);
  } else {
    Magnification.MagSetFullscreenColorEffect(toMatrixBuffer(IDENTITY).ptr);
  }
}

let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  restore();
  Magnification.MagUninitialize();
  process.stdout.write(SHOW_CURSOR + RESET + '\n');
}

process.on('SIGINT', () => {
  cleanup();
  process.stdout.write(`${DIM}Interrupted — screen restored.${RESET}\n`);
  process.exit(0);
});
process.on('exit', cleanup);

async function main(): Promise<void> {
  if (!Magnification.MagInitialize()) {
    console.error(`${RED}MagInitialize failed — the Magnification runtime is unavailable.${RESET}`);
    process.exit(1);
  }

  canRestore = Magnification.MagGetFullscreenColorEffect(savedBuf.ptr) !== 0;

  const probe = Magnification.MagSetFullscreenColorEffect(toMatrixBuffer(IDENTITY).ptr);
  if (!probe) {
    console.error(`${YELLOW}MagSetFullscreenColorEffect was rejected (common over RDP / in a session without a desktop compositor). Nothing was changed.${RESET}`);
    cleanup();
    process.exit(1);
  }

  process.stdout.write(CLEAR + HIDE_CURSOR);

  const HOLD_MS = 3000;
  const TICK_MS = 80;

  for (const effect of effects) {
    const applied = Magnification.MagSetFullscreenColorEffect(toMatrixBuffer(effect.matrix).ptr);
    const elapsedStart = Date.now();

    while (Date.now() - elapsedStart < HOLD_MS) {
      const elapsed = Date.now() - elapsedStart;
      const remaining = Math.max(0, HOLD_MS - elapsed);

      let screen = HOME;
      screen += `${BOLD}${CYAN}  ╔══════════════════════════════════════════════════════════╗${RESET}\n`;
      screen += `${BOLD}${CYAN}  ║${RESET}  ${BOLD}${WHITE}SCREEN COLOR LAB${RESET}  ${DIM}· the whole desktop is the canvas${RESET}      ${BOLD}${CYAN}║${RESET}\n`;
      screen += `${BOLD}${CYAN}  ╚══════════════════════════════════════════════════════════╝${RESET}\n\n`;
      screen += `   Effect   ${effect.color}${BOLD}${effect.name}${RESET}\n`;
      screen += `   ${DIM}${effect.blurb}${RESET}\n\n`;
      screen += `   ${DIM}MAGCOLOREFFECT — float transform[5][5]${RESET}\n`;
      screen += `   ${DIM}    ┌${'─'.repeat(46)}┐${RESET}\n`;
      screen += renderMatrix(effect.matrix, effect.color);
      screen += `   ${DIM}    └${'─'.repeat(46)}┘${RESET}\n\n`;
      screen += `   ${applied ? `${GREEN}● applied to live desktop${RESET}` : `${RED}● rejected${RESET}`}\n`;
      screen += `   next in  ${bar(remaining / HOLD_MS, 32, effect.color)} ${WHITE}${(remaining / 1000).toFixed(1)}s${RESET}  \n\n`;
      screen += `   ${DIM}Ctrl+C restores the original screen instantly.${RESET}     \n`;
      process.stdout.write(screen);

      await Bun.sleep(TICK_MS);
    }
  }

  process.stdout.write(`\n   ${GREEN}Restoring original screen colors…${RESET}\n`);
  cleanup();
}

await main();
