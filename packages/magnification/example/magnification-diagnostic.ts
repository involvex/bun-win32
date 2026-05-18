/**
 * Magnification Diagnostic
 *
 * A complete, read-only audit of the Windows Magnification subsystem and the
 * geometry a full-screen magnifier would operate on. It initializes the
 * magnifier runtime, then reports the live full-screen transform (zoom factor
 * and pan offsets), decodes the active full-screen color-effect matrix into a
 * human-readable verdict (identity / grayscale / inverted / custom), maps the
 * physical + virtual screen geometry via User32, and lists the filter-mode and
 * magnifier-window-style constants the API exposes. Nothing is modified.
 *
 * APIs demonstrated (Magnification):
 *   - MagInitialize                 (create the magnifier runtime objects)
 *   - MagGetFullscreenTransform     (current zoom factor + pan offsets)
 *   - MagGetFullscreenColorEffect   (current 5x5 screen color matrix)
 *   - MagGetInputTransform          (pen/touch input remapping state)
 *   - MagGetImageScalingCallback    (legacy custom-scaling hook pointer)
 *   - MagUninitialize               (tear down the magnifier runtime objects)
 *
 * APIs demonstrated (User32, cross-package):
 *   - GetSystemMetrics              (primary + virtual screen geometry)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode (enable ANSI output)
 *
 * Run: bun run example/magnification-diagnostic.ts
 */

import Magnification, { FilterMode, MS_CLIPAROUNDCURSOR, MS_INVERTCOLORS, MS_SHOWMAGNIFIEDCURSOR, WC_MAGNIFIER } from '../index';
import User32, { SystemMetric } from '@bun-win32/user32';
import Kernel32, { STD_HANDLE } from '@bun-win32/kernel32';

Magnification.Preload(['MagInitialize', 'MagGetFullscreenTransform', 'MagGetFullscreenColorEffect', 'MagGetInputTransform', 'MagGetImageScalingCallback', 'MagUninitialize']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const RED = '\x1b[91m';
const WHITE = '\x1b[97m';
const BLUE = '\x1b[94m';

const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | 0x0004); // ENABLE_VIRTUAL_TERMINAL_PROCESSING
}

const W = 64;
const line = (ch: string) => ch.repeat(W);
function header(title: string): void {
  console.log(`\n${BOLD}${CYAN}┌${line('─')}┐${RESET}`);
  console.log(`${BOLD}${CYAN}│${RESET} ${BOLD}${WHITE}${title.padEnd(W - 2)}${RESET} ${BOLD}${CYAN}│${RESET}`);
  console.log(`${BOLD}${CYAN}└${line('─')}┘${RESET}`);
}
function row(label: string, value: string): void {
  console.log(`  ${DIM}${label.padEnd(26)}${RESET} ${value}`);
}
const okTag = (b: number) => (b !== 0 ? `${GREEN}OK${RESET}` : `${RED}FAILED${RESET}`);

console.log(`${BOLD}${WHITE}\n  Windows Magnification Diagnostic${RESET}`);
console.log(`  ${DIM}magnification.dll · ${new Date().toISOString()}${RESET}`);

// ── Runtime ────────────────────────────────────────────────────────────────
header('Runtime');
const initialized = Magnification.MagInitialize();
row('MagInitialize', okTag(initialized));
if (!initialized) {
  console.error(`\n${RED}  Magnification runtime unavailable. Aborting.${RESET}`);
  process.exit(1);
}
row('Library', `${WHITE}magnification.dll${RESET} ${DIM}(lazy-bound via Bun FFI)${RESET}`);

// ── Full-screen transform ──────────────────────────────────────────────────
header('Full-Screen Transform');
const magLevelBuf = Buffer.alloc(4);
const xOffBuf = Buffer.alloc(4);
const yOffBuf = Buffer.alloc(4);
const gotTransform = Magnification.MagGetFullscreenTransform(magLevelBuf.ptr, xOffBuf.ptr, yOffBuf.ptr);
row('MagGetFullscreenTransform', okTag(gotTransform));
if (gotTransform) {
  const magLevel = magLevelBuf.readFloatLE(0);
  const xOffset = xOffBuf.readInt32LE(0);
  const yOffset = yOffBuf.readInt32LE(0);
  const zoomTag = magLevel <= 1.0001 ? `${GREEN}no magnification (1.00x)${RESET}` : `${YELLOW}${magLevel.toFixed(2)}x active${RESET}`;
  row('Magnification factor', `${WHITE}${magLevel.toFixed(4)}${RESET}  ${zoomTag}`);
  row('Pan offset (x, y)', `${WHITE}${xOffset}, ${yOffset}${RESET} ${DIM}px (unmagnified, vs. primary monitor)${RESET}`);
}

// ── Full-screen color effect ───────────────────────────────────────────────
header('Full-Screen Color Effect');
const fxBuf = Buffer.alloc(100); // MAGCOLOREFFECT = float[5][5]
const gotFx = Magnification.MagGetFullscreenColorEffect(fxBuf.ptr);
row('MagGetFullscreenColorEffect', okTag(gotFx));
if (gotFx) {
  const m: number[] = [];
  for (let i = 0; i < 25; i++) m.push(fxBuf.readFloatLE(i * 4));

  const approx = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  const isIdentity = m.every((v, i) => approx(v, i % 6 === 0 ? 1 : 0));
  const diag = [m[0], m[6], m[12]];
  const isInverted = diag.every((v) => approx(v, -1));
  const isGrayscale = approx(m[0], m[1]) && approx(m[1], m[2]) && approx(m[5], m[6]) && approx(m[6], m[7]) && approx(m[10], m[11]) && approx(m[11], m[12]);

  let verdict: string;
  if (isIdentity) verdict = `${GREEN}Identity — colors are passed through untouched${RESET}`;
  else if (isInverted) verdict = `${YELLOW}Photo-negative — every channel inverted${RESET}`;
  else if (isGrayscale) verdict = `${WHITE}Grayscale — luminance projection${RESET}`;
  else verdict = `${YELLOW}Custom color transform in effect${RESET}`;
  row('Decoded verdict', verdict);

  const rowLabels = ['R', 'G', 'B', 'A', 'T'];
  console.log(`  ${DIM}transform[5][5]:${RESET}`);
  for (let r = 0; r < 5; r++) {
    const cells = [];
    for (let c = 0; c < 5; c++) {
      const v = m[r * 5 + c];
      const text = (v >= 0 ? ' ' : '') + v.toFixed(3);
      cells.push(v === 0 ? `${DIM}${text}${RESET}` : `${BLUE}${text}${RESET}`);
    }
    console.log(`    ${DIM}${rowLabels[r]}${RESET}  ${cells.join('  ')}`);
  }
}

// ── Input transform (pen / touch / mouse remapping) ────────────────────────
header('Input Transform');
const enabledBuf = Buffer.alloc(4);
const srcRect = Buffer.alloc(16); // RECT { LONG left, top, right, bottom }
const dstRect = Buffer.alloc(16);
const gotInput = Magnification.MagGetInputTransform(enabledBuf.ptr, srcRect.ptr, dstRect.ptr);
row('MagGetInputTransform', okTag(gotInput));
if (gotInput) {
  const enabled = enabledBuf.readInt32LE(0) !== 0;
  row('Input remapping', enabled ? `${YELLOW}ENABLED${RESET}` : `${GREEN}disabled${RESET}`);
  const fmtRect = (b: Buffer) => `${b.readInt32LE(0)}, ${b.readInt32LE(4)} → ${b.readInt32LE(8)}, ${b.readInt32LE(12)}`;
  row('Source rect (l,t→r,b)', `${WHITE}${fmtRect(srcRect)}${RESET}`);
  row('Dest rect (l,t→r,b)', `${WHITE}${fmtRect(dstRect)}${RESET}`);
}

// ── Legacy image-scaling callback ──────────────────────────────────────────
header('Image Scaling Callback (legacy)');
const callback = Magnification.MagGetImageScalingCallback(0n);
row('MagGetImageScalingCallback', callback === null ? `${DIM}none registered${RESET}` : `${WHITE}0x${callback.toString(16)}${RESET}`);
row('Status', `${DIM}deprecated since Windows 7; requires DWM off${RESET}`);

// ── Screen geometry (User32 cross-package) ─────────────────────────────────
header('Screen Geometry (User32)');
const cx = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const cy = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
const vx = User32.GetSystemMetrics(SystemMetric.SM_XVIRTUALSCREEN);
const vy = User32.GetSystemMetrics(SystemMetric.SM_YVIRTUALSCREEN);
const vcx = User32.GetSystemMetrics(SystemMetric.SM_CXVIRTUALSCREEN);
const vcy = User32.GetSystemMetrics(SystemMetric.SM_CYVIRTUALSCREEN);
const monitors = User32.GetSystemMetrics(SystemMetric.SM_CMONITORS);
const remote = User32.GetSystemMetrics(SystemMetric.SM_REMOTESESSION);
row('Primary monitor', `${WHITE}${cx} × ${cy}${RESET} px`);
row('Virtual screen origin', `${WHITE}${vx}, ${vy}${RESET} px`);
row('Virtual screen size', `${WHITE}${vcx} × ${vcy}${RESET} px ${DIM}(bounds of all monitors)${RESET}`);
row('Monitor count', `${WHITE}${monitors}${RESET}`);
row('Session type', remote ? `${YELLOW}remote (RDP)${RESET} ${DIM}— full-screen effects may not apply${RESET}` : `${GREEN}local console${RESET}`);

// ── API constants ──────────────────────────────────────────────────────────
header('API Constants');
row('Magnifier window class', `${WHITE}"${WC_MAGNIFIER}"${RESET}`);
row('FilterMode.EXCLUDE', `${WHITE}${FilterMode.MW_FILTERMODE_EXCLUDE}${RESET} ${DIM}(hide listed windows from magnification)${RESET}`);
row('FilterMode.INCLUDE', `${WHITE}${FilterMode.MW_FILTERMODE_INCLUDE}${RESET} ${DIM}(pre-Win7 only)${RESET}`);
row('MS_SHOWMAGNIFIEDCURSOR', `${WHITE}0x${MS_SHOWMAGNIFIEDCURSOR.toString(16).padStart(4, '0')}${RESET}`);
row('MS_CLIPAROUNDCURSOR', `${WHITE}0x${MS_CLIPAROUNDCURSOR.toString(16).padStart(4, '0')}${RESET}`);
row('MS_INVERTCOLORS', `${WHITE}0x${MS_INVERTCOLORS.toString(16).padStart(4, '0')}${RESET}`);

Magnification.MagUninitialize();
console.log(`\n  ${DIM}MagUninitialize called. Diagnostic complete — no settings were changed.${RESET}\n`);
