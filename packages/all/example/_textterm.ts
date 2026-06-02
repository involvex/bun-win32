/**
 * _textterm — a high-frame-rate TRUECOLOR character-grid terminal renderer, the
 * sibling of `_term.ts`. Where `_term` turns the console into a half-block RGB
 * framebuffer, this turns it into a grid of styled CHARACTER CELLS — each cell
 * carries a Unicode codepoint plus a 24-bit foreground and background colour and
 * a bold flag — which is the right substrate for TUIs, ASCII renderers and a
 * windowing desktop. Frames are produced by the same diffing byte-builder
 * discipline: only cells whose (char,fg,bg,bold) tuple changed are repainted, and
 * an SGR escape or a cursor move is emitted only when it actually changes, so a
 * mostly-static UI costs almost nothing and a fully-animated grid streams in a
 * single `process.stdout.write`. That is what keeps it comfortably above 60fps.
 *
 * Console setup/teardown mirrors `_term.ts` over @bun-win32/kernel32 FFI (VT
 * processing + UTF-8 code page + hidden cursor + alt-screen + autowrap-off + raw
 * mode + xterm SGR mouse), all restored on exit / SIGINT / uncaughtException.
 *
 * For headless verification the cell grid is rasterised to an RGB image and
 * written as a real PNG (reusing `encodePNG` from `_term`): ASCII printables come
 * from a compact embedded 6×10 bitmap font, while box-drawing, block and shading
 * glyphs are rasterised PROCEDURALLY by codepoint (lines / fills / partial-alpha
 * blends) so no giant atlas is hand-authored.
 *
 * Demos call `runTextDemo({ title, frame })`. Env knobs match `_term`:
 *   DEMO_DURATION_MS=<ms>     live mode auto-exit
 *   CAPTURE_PNG=<abs path>    render one deterministic frame to PNG and exit
 *   CAPTURE_T=<seconds>       sim time to advance to before capture   (default 4)
 *   CAPTURE_FPS=<n>           fixed sim timestep for capture/bench     (default 60)
 *   CAPTURE_FRAMES=<n>        write n PNGs (path.0.png …) across [0,CAPTURE_T]
 *   TERM_COLS / TERM_ROWS     force the grid size (deterministic capture)
 *   BENCH=1 [BENCH_FRAMES=n]  measure frame-production FPS, print JSON, exit
 */
import { Kernel32 } from '../index';
import { STD_HANDLE } from '@bun-win32/kernel32';
import { encodePNG, clamp, clamp01, lerp, smoothstep, fract, TAU, aces, hsv, mulberry32, hash2, makeFrameWaiter } from './_term';

// Re-export the shared helpers so demos can pull everything from one engine import.
export { encodePNG, clamp, clamp01, lerp, smoothstep, fract, TAU, aces, hsv, mulberry32, hash2 };

// ── Console mode flags ──────────────────────────────────────────────────────────
const ENABLE_PROCESSED_OUTPUT = 0x0001;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const CP_UTF8 = 65001;

// ── ANSI ────────────────────────────────────────────────────────────────────────
const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const MOUSE_ON = `${ESC}[?1003h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1003l${ESC}[?1006l`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const AUTOWRAP_OFF = `${ESC}[?7l`;
const AUTOWRAP_ON = `${ESC}[?7h`;
const HOME = `${ESC}[H`;
const CLEAR = `${ESC}[2J`;

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v;
};
const envNum = (k: string, d: number): number => {
  const v = env(k);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export type RGB = readonly [number, number, number];

// Pack three 0..255 channels into a single int key (also the diff key).
const pack = (r: number, g: number, b: number): number =>
  (((r < 0 ? 0 : r > 255 ? 255 : r) | 0) << 16) |
  (((g < 0 ? 0 : g > 255 ? 255 : g) | 0) << 8) |
  ((b < 0 ? 0 : b > 255 ? 255 : b) | 0);

// ── Embedded 6×10 bitmap font (human-readable source → packed at load) ───────────
// Each glyph is 10 rows of 6 columns ('#' = on). Lowercase has its own forms where
// helpful; missing lowercase falls back to uppercase. Only used by the PNG
// rasteriser — the live terminal draws the real Unicode glyphs.
const GLYPH_W = 6;
const GLYPH_H = 10;
const F: Record<string, string[]> = {
  ' ': ['      ', '      ', '      ', '      ', '      ', '      ', '      ', '      ', '      ', '      '],
  '!': ['  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '      ', '  ##  ', '  ##  ', '      '],
  '"': [' ## ##', ' ## ##', ' ## ##', '      ', '      ', '      ', '      ', '      ', '      ', '      '],
  '#': [' # #  ', ' # #  ', '######', ' # #  ', ' # #  ', '######', ' # #  ', ' # #  ', '      ', '      '],
  '$': ['  ##  ', ' #####', '# #   ', ' ###  ', '   # #', '##### ', '  ##  ', '      ', '      ', '      '],
  '%': ['##   #', '##  # ', '   #  ', '  #   ', ' #    ', '#  ## ', '  ## #', '      ', '      ', '      '],
  '&': [' ###  ', '#   # ', '#   # ', ' ###  ', '#  # #', '#   # ', ' ### #', '      ', '      ', '      '],
  "'": ['  ##  ', '  ##  ', '  ##  ', '      ', '      ', '      ', '      ', '      ', '      ', '      '],
  '(': ['   ## ', '  ##  ', ' ##   ', ' ##   ', ' ##   ', ' ##   ', '  ##  ', '   ## ', '      ', '      '],
  ')': [' ##   ', '  ##  ', '   ## ', '   ## ', '   ## ', '   ## ', '  ##  ', ' ##   ', '      ', '      '],
  '*': ['      ', '  #   ', '# # # ', ' ###  ', '# # # ', '  #   ', '      ', '      ', '      ', '      '],
  '+': ['      ', '  ##  ', '  ##  ', '######', '######', '  ##  ', '  ##  ', '      ', '      ', '      '],
  ',': ['      ', '      ', '      ', '      ', '      ', '      ', '  ##  ', '  ##  ', '  #   ', ' #    '],
  '-': ['      ', '      ', '      ', '######', '######', '      ', '      ', '      ', '      ', '      '],
  '.': ['      ', '      ', '      ', '      ', '      ', '      ', '      ', '  ##  ', '  ##  ', '      '],
  '/': ['     #', '    ##', '   ## ', '  ##  ', ' ##   ', '##    ', '#     ', '      ', '      ', '      '],
  '0': [' #### ', '#    #', '#   ##', '#  # #', '# #  #', '##   #', '#    #', ' #### ', '      ', '      '],
  '1': ['  ##  ', ' ###  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '######', '      ', '      '],
  '2': [' #### ', '#    #', '     #', '    # ', '  ##  ', ' #    ', '#     ', '######', '      ', '      '],
  '3': [' #### ', '#    #', '     #', '  ### ', '     #', '     #', '#    #', ' #### ', '      ', '      '],
  '4': ['   ## ', '  # # ', ' #  # ', '#   # ', '######', '    # ', '    # ', '    # ', '      ', '      '],
  '5': ['######', '#     ', '#     ', '##### ', '     #', '     #', '#    #', ' #### ', '      ', '      '],
  '6': [' #### ', '#    #', '#     ', '##### ', '#    #', '#    #', '#    #', ' #### ', '      ', '      '],
  '7': ['######', '     #', '    # ', '   #  ', '  #   ', '  #   ', '  #   ', '  #   ', '      ', '      '],
  '8': [' #### ', '#    #', '#    #', ' #### ', '#    #', '#    #', '#    #', ' #### ', '      ', '      '],
  '9': [' #### ', '#    #', '#    #', '#    #', ' #####', '     #', '#    #', ' #### ', '      ', '      '],
  ':': ['      ', '      ', '  ##  ', '  ##  ', '      ', '      ', '  ##  ', '  ##  ', '      ', '      '],
  ';': ['      ', '      ', '  ##  ', '  ##  ', '      ', '      ', '  ##  ', '  ##  ', '  #   ', ' #    '],
  '<': ['      ', '    ##', '  ##  ', '##    ', '##    ', '  ##  ', '    ##', '      ', '      ', '      '],
  '=': ['      ', '      ', '######', '######', '      ', '######', '######', '      ', '      ', '      '],
  '>': ['      ', '##    ', '  ##  ', '    ##', '    ##', '  ##  ', '##    ', '      ', '      ', '      '],
  '?': [' #### ', '#    #', '     #', '    # ', '  ##  ', '  ##  ', '      ', '  ##  ', '      ', '      '],
  '@': [' #### ', '#    #', '# ## #', '# ## #', '# ### ', '#     ', '#    #', ' #### ', '      ', '      '],
  A: [' #### ', '#    #', '#    #', '#    #', '######', '#    #', '#    #', '#    #', '      ', '      '],
  B: ['##### ', '#    #', '#    #', '##### ', '#    #', '#    #', '#    #', '##### ', '      ', '      '],
  C: [' #### ', '#    #', '#     ', '#     ', '#     ', '#     ', '#    #', ' #### ', '      ', '      '],
  D: ['####  ', '#   # ', '#    #', '#    #', '#    #', '#    #', '#   # ', '####  ', '      ', '      '],
  E: ['######', '#     ', '#     ', '##### ', '#     ', '#     ', '#     ', '######', '      ', '      '],
  F: ['######', '#     ', '#     ', '##### ', '#     ', '#     ', '#     ', '#     ', '      ', '      '],
  G: [' #### ', '#    #', '#     ', '#     ', '#  ###', '#    #', '#    #', ' #### ', '      ', '      '],
  H: ['#    #', '#    #', '#    #', '######', '#    #', '#    #', '#    #', '#    #', '      ', '      '],
  I: ['######', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '######', '      ', '      '],
  J: ['    ##', '     #', '     #', '     #', '     #', '#    #', '#    #', ' #### ', '      ', '      '],
  K: ['#    #', '#   # ', '#  #  ', '###   ', '#  #  ', '#   # ', '#    #', '#    #', '      ', '      '],
  L: ['#     ', '#     ', '#     ', '#     ', '#     ', '#     ', '#     ', '######', '      ', '      '],
  M: ['#    #', '##  ##', '# ## #', '# ## #', '#    #', '#    #', '#    #', '#    #', '      ', '      '],
  N: ['#    #', '##   #', '# #  #', '#  # #', '#   ##', '#    #', '#    #', '#    #', '      ', '      '],
  O: [' #### ', '#    #', '#    #', '#    #', '#    #', '#    #', '#    #', ' #### ', '      ', '      '],
  P: ['##### ', '#    #', '#    #', '##### ', '#     ', '#     ', '#     ', '#     ', '      ', '      '],
  Q: [' #### ', '#    #', '#    #', '#    #', '#    #', '#  # #', '#   # ', ' ### #', '      ', '      '],
  R: ['##### ', '#    #', '#    #', '##### ', '#  #  ', '#   # ', '#    #', '#    #', '      ', '      '],
  S: [' #### ', '#    #', '#     ', ' #### ', '     #', '     #', '#    #', ' #### ', '      ', '      '],
  T: ['######', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '      ', '      '],
  U: ['#    #', '#    #', '#    #', '#    #', '#    #', '#    #', '#    #', ' #### ', '      ', '      '],
  V: ['#    #', '#    #', '#    #', '#    #', '#    #', ' #  # ', ' #  # ', '  ##  ', '      ', '      '],
  W: ['#    #', '#    #', '#    #', '#    #', '# ## #', '# ## #', '##  ##', '#    #', '      ', '      '],
  X: ['#    #', '#    #', ' #  # ', '  ##  ', '  ##  ', ' #  # ', '#    #', '#    #', '      ', '      '],
  Y: ['#    #', '#    #', ' #  # ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '      ', '      '],
  Z: ['######', '     #', '    # ', '   #  ', '  #   ', ' #    ', '#     ', '######', '      ', '      '],
  '[': [' #### ', ' ##   ', ' ##   ', ' ##   ', ' ##   ', ' ##   ', ' ##   ', ' #### ', '      ', '      '],
  '\\': ['#     ', '##    ', ' ##   ', '  ##  ', '   ## ', '    ##', '     #', '      ', '      ', '      '],
  ']': [' #### ', '   ## ', '   ## ', '   ## ', '   ## ', '   ## ', '   ## ', ' #### ', '      ', '      '],
  '^': ['  ##  ', ' #  # ', '#    #', '      ', '      ', '      ', '      ', '      ', '      ', '      '],
  _: ['      ', '      ', '      ', '      ', '      ', '      ', '      ', '      ', '######', '######'],
  '`': [' ##   ', '  ##  ', '      ', '      ', '      ', '      ', '      ', '      ', '      ', '      '],
  a: ['      ', '      ', ' #### ', '     #', ' #####', '#    #', '#   ##', ' ### #', '      ', '      '],
  b: ['#     ', '#     ', '##### ', '#    #', '#    #', '#    #', '#    #', '##### ', '      ', '      '],
  c: ['      ', '      ', ' #### ', '#    #', '#     ', '#     ', '#    #', ' #### ', '      ', '      '],
  d: ['     #', '     #', ' #####', '#    #', '#    #', '#    #', '#    #', ' #####', '      ', '      '],
  e: ['      ', '      ', ' #### ', '#    #', '######', '#     ', '#    #', ' #### ', '      ', '      '],
  f: ['  ### ', ' #    ', '######', ' #    ', ' #    ', ' #    ', ' #    ', ' #    ', '      ', '      '],
  g: ['      ', '      ', ' #####', '#    #', '#    #', ' #####', '     #', '#    #', ' #### ', '      '],
  h: ['#     ', '#     ', '##### ', '#    #', '#    #', '#    #', '#    #', '#    #', '      ', '      '],
  i: ['  ##  ', '      ', ' ###  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '######', '      ', '      '],
  j: ['   ## ', '      ', '  ### ', '   ## ', '   ## ', '   ## ', '#  ## ', '#  ## ', ' ###  ', '      '],
  k: ['#     ', '#     ', '#   # ', '#  #  ', '###   ', '#  #  ', '#   # ', '#    #', '      ', '      '],
  l: [' ###  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '######', '      ', '      '],
  m: ['      ', '      ', '## ## ', '# # # ', '# # # ', '# # # ', '#   # ', '#   # ', '      ', '      '],
  n: ['      ', '      ', '##### ', '#    #', '#    #', '#    #', '#    #', '#    #', '      ', '      '],
  o: ['      ', '      ', ' #### ', '#    #', '#    #', '#    #', '#    #', ' #### ', '      ', '      '],
  p: ['      ', '      ', '##### ', '#    #', '#    #', '#    #', '##### ', '#     ', '#     ', '      '],
  q: ['      ', '      ', ' #####', '#    #', '#    #', '#    #', ' #####', '     #', '     #', '      '],
  r: ['      ', '      ', '# ### ', '##    ', '#     ', '#     ', '#     ', '#     ', '      ', '      '],
  s: ['      ', '      ', ' #####', '#     ', ' #### ', '     #', '     #', '##### ', '      ', '      '],
  t: [' #    ', ' #    ', '######', ' #    ', ' #    ', ' #    ', ' #   #', '  ### ', '      ', '      '],
  u: ['      ', '      ', '#    #', '#    #', '#    #', '#    #', '#   ##', ' ### #', '      ', '      '],
  v: ['      ', '      ', '#    #', '#    #', '#    #', ' #  # ', ' #  # ', '  ##  ', '      ', '      '],
  w: ['      ', '      ', '#   # ', '#   # ', '# # # ', '# # # ', '# # # ', ' # #  ', '      ', '      '],
  x: ['      ', '      ', '#    #', ' #  # ', '  ##  ', '  ##  ', ' #  # ', '#    #', '      ', '      '],
  y: ['      ', '      ', '#    #', '#    #', '#    #', ' #####', '     #', '#    #', ' #### ', '      '],
  z: ['      ', '      ', '######', '    # ', '   #  ', '  #   ', ' #    ', '######', '      ', '      '],
  '{': ['   ## ', '  ##  ', '  ##  ', '###   ', '  ##  ', '  ##  ', '  ##  ', '   ## ', '      ', '      '],
  '|': ['  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '      ', '      '],
  '}': [' ##   ', '  ##  ', '  ##  ', '   ###', '  ##  ', '  ##  ', '  ##  ', ' ##   ', '      ', '      '],
  '~': ['      ', '      ', ' ##   ', '# ## #', '   ## ', '      ', '      ', '      ', '      ', '      '],
};

const FONT: Map<number, Uint8Array> = new Map();
for (const [ch, rows] of Object.entries(F)) {
  const bits = new Uint8Array(GLYPH_W * GLYPH_H);
  for (let y = 0; y < GLYPH_H; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < GLYPH_W; x++) bits[y * GLYPH_W + x] = row[x] === '#' ? 1 : 0;
  }
  FONT.set(ch.codePointAt(0)!, bits);
}
// Lowercase fallback to uppercase for any letter without its own form.
for (let cc = 0x61; cc <= 0x7a; cc++) {
  if (!FONT.has(cc)) {
    const up = FONT.get(cc - 0x20);
    if (up) FONT.set(cc, up);
  }
}

// ── Box-drawing / block / shading codepoints (named for demos) ───────────────────
export const BOX = {
  rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  sharp: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
} as const;
export type BoxStyle = keyof typeof BOX;

export const BLOCK = {
  full: '█',
  upper: '▀',
  lower: '▄',
  left: '▌',
  right: '▐',
  light: '░',
  medium: '▒',
  dark: '▓',
} as const;

const SP = 0x20;

// ── The character-cell grid / renderer ───────────────────────────────────────────
export class CharTerm {
  readonly cols: number;
  readonly rows: number;
  readonly aspect: number; // cols / rows (cell aspect not applied — purely grid)

  // Parallel cell arrays — no per-cell objects, so no hot-loop allocation.
  readonly ch: Int32Array; // codepoint
  readonly fg: Int32Array; // packed RGB
  readonly bg: Int32Array; // packed RGB
  readonly bold: Uint8Array;

  // Mouse state (only populated when the demo opts in via `mouse: true`). Coords
  // are in CELL units (col,row) so char-grid demos hit-test directly.
  mouseX = -1;
  mouseY = -1;
  mouseDown = false;
  mouseInside = false;
  mouseActive = false;
  mouseSeq = 0;
  wheel = 0;

  private prevCh: Int32Array;
  private prevFg: Int32Array;
  private prevBg: Int32Array;
  private prevBold: Uint8Array;
  private firstFrame = true;
  private penFg = -1;
  private penBg = -1;
  private penBold = 0;

  private out = new Uint8Array(1 << 18);
  private outPos = 0;
  private utf8 = new Uint8Array(4);

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.aspect = cols / rows;
    const n = cols * rows;
    this.ch = new Int32Array(n).fill(SP);
    this.fg = new Int32Array(n).fill(0xc8c8d0);
    this.bg = new Int32Array(n); // 0 = black
    this.bold = new Uint8Array(n);
    this.prevCh = new Int32Array(n).fill(-1);
    this.prevFg = new Int32Array(n).fill(-1);
    this.prevBg = new Int32Array(n).fill(-1);
    this.prevBold = new Uint8Array(n).fill(255);
  }

  private inb(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  /** Reset every cell to space / default fg / black bg. */
  clear(bgR = 0, bgG = 0, bgB = 0): void {
    const bg = pack(bgR, bgG, bgB);
    this.ch.fill(SP);
    this.fg.fill(0xc8c8d0);
    this.bg.fill(bg);
    this.bold.fill(0);
  }

  /** Place one glyph. `ch` is a string (first codepoint used) or a codepoint. */
  put(x: number, y: number, ch: string | number, fg: RGB, bg?: RGB, bold = false): void {
    x |= 0;
    y |= 0;
    if (!this.inb(x, y)) return;
    const i = y * this.cols + x;
    this.ch[i] = typeof ch === 'number' ? ch : (ch.codePointAt(0) ?? SP);
    this.fg[i] = pack(fg[0], fg[1], fg[2]);
    if (bg) this.bg[i] = pack(bg[0], bg[1], bg[2]);
    this.bold[i] = bold ? 1 : 0;
  }

  /** Write a string left-to-right starting at (x,y). Iterates by codepoint. */
  text(x: number, y: number, str: string, fg: RGB, bg?: RGB, bold = false): void {
    x |= 0;
    y |= 0;
    if (y < 0 || y >= this.rows) return;
    const f = pack(fg[0], fg[1], fg[2]);
    const hasBg = bg !== undefined;
    const b = hasBg ? pack(bg[0], bg[1], bg[2]) : 0;
    const bd = bold ? 1 : 0;
    const cols = this.cols;
    let cx = x;
    for (const c of str) {
      if (cx >= 0 && cx < cols) {
        const i = y * cols + cx;
        this.ch[i] = c.codePointAt(0) ?? SP;
        this.fg[i] = f;
        if (hasBg) this.bg[i] = b;
        this.bold[i] = bd;
      }
      cx++;
    }
  }

  /** Fill a rectangle's background (and clear the glyphs to space). */
  fillRect(x: number, y: number, w: number, h: number, bg: RGB): void {
    const b = pack(bg[0], bg[1], bg[2]);
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.cols, (x | 0) + (w | 0));
    const y1 = Math.min(this.rows, (y | 0) + (h | 0));
    const cols = this.cols;
    for (let yy = y0; yy < y1; yy++) {
      let i = yy * cols + x0;
      for (let xx = x0; xx < x1; xx++, i++) {
        this.ch[i] = SP;
        this.bg[i] = b;
      }
    }
  }

  /** Blend a rectangle's background toward a colour (alpha 0..1). Keeps glyphs. */
  shadeRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void {
    if (a <= 0) return;
    const ia = a >= 1 ? 0 : 1 - a;
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.cols, (x | 0) + (w | 0));
    const y1 = Math.min(this.rows, (y | 0) + (h | 0));
    const cols = this.cols;
    const bgArr = this.bg;
    for (let yy = y0; yy < y1; yy++) {
      let i = yy * cols + x0;
      for (let xx = x0; xx < x1; xx++, i++) {
        const cur = bgArr[i];
        const cr = ((cur >> 16) & 255) * ia + r * a;
        const cg = ((cur >> 8) & 255) * ia + g * a;
        const cb = (cur & 255) * ia + b * a;
        bgArr[i] = pack(cr, cg, cb);
      }
    }
  }

  hline(x: number, y: number, w: number, ch: string, fg: RGB, bg?: RGB): void {
    const cp = ch.codePointAt(0) ?? SP;
    for (let i = 0; i < w; i++) this.put(x + i, y, cp, fg, bg);
  }
  vline(x: number, y: number, h: number, ch: string, fg: RGB, bg?: RGB): void {
    const cp = ch.codePointAt(0) ?? SP;
    for (let i = 0; i < h; i++) this.put(x, y + i, cp, fg, bg);
  }

  /** Draw a box outline (w,h are the full outer extent, ≥2). */
  box(x: number, y: number, w: number, h: number, style: BoxStyle, fg: RGB, bg?: RGB): void {
    if (w < 2 || h < 2) return;
    const s = BOX[style];
    const x2 = x + w - 1;
    const y2 = y + h - 1;
    this.put(x, y, s.tl, fg, bg);
    this.put(x2, y, s.tr, fg, bg);
    this.put(x, y2, s.bl, fg, bg);
    this.put(x2, y2, s.br, fg, bg);
    for (let i = x + 1; i < x2; i++) {
      this.put(i, y, s.h, fg, bg);
      this.put(i, y2, s.h, fg, bg);
    }
    for (let j = y + 1; j < y2; j++) {
      this.put(x, j, s.v, fg, bg);
      this.put(x2, j, s.v, fg, bg);
    }
  }

  // — frame emission (diff + run-length pen) —
  private ensure(n: number): void {
    if (this.outPos + n <= this.out.length) return;
    let cap = this.out.length * 2;
    while (cap < this.outPos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.out.subarray(0, this.outPos));
    this.out = nb;
  }
  private putByte(b: number): void {
    this.ensure(1);
    this.out[this.outPos++] = b;
  }
  private putAscii(s: string): void {
    this.ensure(s.length);
    const o = this.out;
    let p = this.outPos;
    for (let i = 0; i < s.length; i++) o[p++] = s.charCodeAt(i);
    this.outPos = p;
  }
  private _digits = new Uint8Array(12);
  private putUint(n: number): void {
    if (n < 0) n = 0;
    let len = 0;
    const d = this._digits;
    do {
      d[len++] = 48 + (n % 10);
      n = (n / 10) | 0;
    } while (n > 0);
    this.ensure(len);
    const o = this.out;
    let p = this.outPos;
    for (let i = len - 1; i >= 0; i--) o[p++] = d[i];
    this.outPos = p;
  }
  // Encode a single codepoint as UTF-8 into the output buffer.
  private putCodepoint(cp: number): void {
    if (cp < 0x80) {
      this.putByte(cp);
      return;
    }
    const u = this.utf8;
    let n: number;
    if (cp < 0x800) {
      u[0] = 0xc0 | (cp >> 6);
      u[1] = 0x80 | (cp & 0x3f);
      n = 2;
    } else if (cp < 0x10000) {
      u[0] = 0xe0 | (cp >> 12);
      u[1] = 0x80 | ((cp >> 6) & 0x3f);
      u[2] = 0x80 | (cp & 0x3f);
      n = 3;
    } else {
      u[0] = 0xf0 | (cp >> 18);
      u[1] = 0x80 | ((cp >> 12) & 0x3f);
      u[2] = 0x80 | ((cp >> 6) & 0x3f);
      u[3] = 0x80 | (cp & 0x3f);
      n = 4;
    }
    this.ensure(n);
    const o = this.out;
    let p = this.outPos;
    for (let i = 0; i < n; i++) o[p++] = u[i];
    this.outPos = p;
  }
  private emitSGR(fg: number, bg: number, bold: number): void {
    // Combine bold + fg + bg into one CSI ...m where it changes.
    this.putAscii(`${ESC}[`);
    let first = true;
    if (bold !== this.penBold) {
      this.putAscii(bold ? '1' : '22');
      this.penBold = bold;
      first = false;
    }
    if (fg !== this.penFg) {
      if (!first) this.putByte(59);
      this.putAscii('38;2;');
      this.putUint((fg >> 16) & 255);
      this.putByte(59);
      this.putUint((fg >> 8) & 255);
      this.putByte(59);
      this.putUint(fg & 255);
      this.penFg = fg;
      first = false;
    }
    if (bg !== this.penBg) {
      if (!first) this.putByte(59);
      this.putAscii('48;2;');
      this.putUint((bg >> 16) & 255);
      this.putByte(59);
      this.putUint((bg >> 8) & 255);
      this.putByte(59);
      this.putUint(bg & 255);
      this.penBg = bg;
      first = false;
    }
    this.putByte(109); // m
  }

  /** Build the diffed frame into the byte buffer (no I/O). Returns byte length. */
  buildFrame(): number {
    const { cols, rows, ch, fg, bg, bold, prevCh, prevFg, prevBg, prevBold } = this;
    this.outPos = 0;
    this.putAscii(HOME);
    let curRow = -1, curCol = -1;
    const first = this.firstFrame;
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const idx = base + c;
        const cch = ch[idx], cfg = fg[idx], cbg = bg[idx], cbd = bold[idx];
        if (!first && prevCh[idx] === cch && prevFg[idx] === cfg && prevBg[idx] === cbg && prevBold[idx] === cbd) continue;
        prevCh[idx] = cch;
        prevFg[idx] = cfg;
        prevBg[idx] = cbg;
        prevBold[idx] = cbd;
        if (curRow !== r || curCol !== c) {
          this.putAscii(`${ESC}[`);
          this.putUint(r + 1);
          this.putByte(59);
          this.putUint(c + 1);
          this.putByte(72); // H
          curRow = r;
          curCol = c;
        }
        if (cfg !== this.penFg || cbg !== this.penBg || cbd !== this.penBold) this.emitSGR(cfg, cbg, cbd);
        this.putCodepoint(cch === 0 ? SP : cch);
        curCol++;
        if (curCol >= cols) {
          curCol = -1;
          curRow = -1; // autowrap off → force a move next change
        }
      }
    }
    this.firstFrame = false;
    return this.outPos;
  }

  present(): void {
    this.buildFrame();
    process.stdout.write(this.out.subarray(0, this.outPos));
  }

  invalidate(): void {
    this.firstFrame = true;
    this.penFg = -1;
    this.penBg = -1;
    this.penBold = 0;
  }

  /** Rasterise the cell grid to a tightly-packed RGB image (cellW×cellH per cell). */
  rasterize(cellW = GLYPH_W + 1, cellH = GLYPH_H + 1): { rgb: Uint8Array; w: number; h: number } {
    const w = this.cols * cellW;
    const h = this.rows * cellH;
    const rgb = new Uint8Array(w * h * 3);
    // Background fill per cell first.
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const idx = r * this.cols + c;
        const bgv = this.bg[idx];
        const br = (bgv >> 16) & 255, bgg = (bgv >> 8) & 255, bb = bgv & 255;
        const px0 = c * cellW, py0 = r * cellH;
        for (let yy = 0; yy < cellH; yy++) {
          let o = ((py0 + yy) * w + px0) * 3;
          for (let xx = 0; xx < cellW; xx++) {
            rgb[o] = br;
            rgb[o + 1] = bgg;
            rgb[o + 2] = bb;
            o += 3;
          }
        }
      }
    }
    // Glyph foreground per cell.
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const idx = r * this.cols + c;
        const cp = this.ch[idx];
        if (cp === SP || cp === 0) continue;
        const fgv = this.fg[idx];
        const fr = (fgv >> 16) & 255, fgc = (fgv >> 8) & 255, fb = fgv & 255;
        this.rasterGlyph(rgb, w, c * cellW, r * cellH, cellW, cellH, cp, fr, fgc, fb);
      }
    }
    return { rgb, w, h };
  }

  // Rasterise one glyph into the image. ASCII printables use the bitmap font;
  // box/block/shading and a few extras are drawn procedurally by codepoint.
  private rasterGlyph(
    rgb: Uint8Array, imgW: number, px: number, py: number, cw: number, chh: number,
    cp: number, fr: number, fg: number, fb: number,
  ): void {
    const setA = (x: number, y: number, a: number): void => {
      if (a <= 0 || x < 0 || y < 0 || x >= imgW) return;
      const o = (y * imgW + x) * 3;
      if (a >= 1) {
        rgb[o] = fr;
        rgb[o + 1] = fg;
        rgb[o + 2] = fb;
      } else {
        const ia = 1 - a;
        rgb[o] = (rgb[o] * ia + fr * a) | 0;
        rgb[o + 1] = (rgb[o + 1] * ia + fg * a) | 0;
        rgb[o + 2] = (rgb[o + 2] * ia + fb * a) | 0;
      }
    };
    const fill = (x0: number, y0: number, x1: number, y1: number, a: number): void => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setA(px + x, py + y, a);
    };

    // Procedural glyphs first.
    switch (cp) {
      case 0x2588: // █ full block
        fill(0, 0, cw, chh, 1);
        return;
      case 0x2580: // ▀ upper half
        fill(0, 0, cw, chh >> 1, 1);
        return;
      case 0x2584: // ▄ lower half
        fill(0, chh >> 1, cw, chh, 1);
        return;
      case 0x258c: // ▌ left half
        fill(0, 0, cw >> 1, chh, 1);
        return;
      case 0x2590: // ▐ right half
        fill(cw >> 1, 0, cw, chh, 1);
        return;
      case 0x2591: // ░ light shade
        fill(0, 0, cw, chh, 0.25);
        return;
      case 0x2592: // ▒ medium shade
        fill(0, 0, cw, chh, 0.5);
        return;
      case 0x2593: // ▓ dark shade
        fill(0, 0, cw, chh, 0.75);
        return;
      case 0x2022: // • bullet
        fill((cw >> 1) - 1, (chh >> 1) - 1, (cw >> 1) + 1, (chh >> 1) + 1, 1);
        return;
    }

    // Box-drawing: detect by codepoint group and draw mid lines.
    const midX = cw >> 1;
    const midY = chh >> 1;
    const hbar = (a: number): void => { for (let x = 0; x < cw; x++) { setA(px + x, py + midY, a); } };
    const vbar = (a: number): void => { for (let y = 0; y < chh; y++) { setA(px + midX, py + y, a); } };
    const hLeft = (a: number): void => { for (let x = 0; x <= midX; x++) setA(px + x, py + midY, a); };
    const hRight = (a: number): void => { for (let x = midX; x < cw; x++) setA(px + x, py + midY, a); };
    const vUp = (a: number): void => { for (let y = 0; y <= midY; y++) setA(px + midX, py + y, a); };
    const vDown = (a: number): void => { for (let y = midY; y < chh; y++) setA(px + midX, py + y, a); };
    switch (cp) {
      case 0x2500: // ─
      case 0x2550: // ═
        hbar(1);
        return;
      case 0x2502: // │
      case 0x2551: // ║
        vbar(1);
        return;
      case 0x250c: // ┌
      case 0x2554: // ╔
      case 0x256d: // ╭
        hRight(1);
        vDown(1);
        return;
      case 0x2510: // ┐
      case 0x2557: // ╗
      case 0x256e: // ╮
        hLeft(1);
        vDown(1);
        return;
      case 0x2514: // └
      case 0x255a: // ╚
      case 0x2570: // ╰
        hRight(1);
        vUp(1);
        return;
      case 0x2518: // ┘
      case 0x255d: // ╝
      case 0x256f: // ╯
        hLeft(1);
        vUp(1);
        return;
      case 0x251c: // ├
        vbar(1);
        hRight(1);
        return;
      case 0x2524: // ┤
        vbar(1);
        hLeft(1);
        return;
      case 0x252c: // ┬
        hbar(1);
        vDown(1);
        return;
      case 0x2534: // ┴
        hbar(1);
        vUp(1);
        return;
      case 0x253c: // ┼
        hbar(1);
        vbar(1);
        return;
    }

    // ASCII / Latin from the bitmap font (centred in the cell).
    const bits = FONT.get(cp);
    if (!bits) {
      // Unknown glyph → small dot so it's visibly "something".
      fill(midX - 1, midY - 1, midX + 1, midY + 1, 0.6);
      return;
    }
    const offx = ((cw - GLYPH_W) >> 1);
    const offy = ((chh - GLYPH_H) >> 1);
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (bits[gy * GLYPH_W + gx]) setA(px + offx + gx, py + offy + gy, 1);
      }
    }
  }

  /** Encode the current grid to a PNG byte array. */
  toPNG(): Uint8Array {
    const { rgb, w, h } = this.rasterize();
    return encodePNG(rgb, w, h);
  }
}

// ── Console lifecycle (mirrors _term.ts) ─────────────────────────────────────────
interface ConsoleState {
  handle: bigint;
  savedMode: number;
  savedCp: number;
  restored: boolean;
  mouse: boolean;
}
let consoleState: ConsoleState | null = null;

const setupConsole = (title?: string, mouse = false): void => {
  Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'GetConsoleOutputCP', 'SetConsoleOutputCP', 'SetConsoleTitleW', 'GetConsoleScreenBufferInfo']);
  const handle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
  const modeBuf = Buffer.alloc(4);
  const gotMode = Kernel32.GetConsoleMode(handle, modeBuf.ptr) ? modeBuf.readUInt32LE(0) : 0;
  Kernel32.SetConsoleMode(handle, gotMode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  const savedCp = Kernel32.GetConsoleOutputCP();
  Kernel32.SetConsoleOutputCP(CP_UTF8);
  if (title) Kernel32.SetConsoleTitleW(Buffer.from(`${title}\0`, 'utf16le').ptr);
  consoleState = { handle, savedMode: gotMode, savedCp, restored: false, mouse };
  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR + AUTOWRAP_OFF + (mouse ? MOUSE_ON : '') + CLEAR + HOME);
};

const restoreConsole = (): void => {
  if (!consoleState || consoleState.restored) return;
  consoleState.restored = true;
  process.stdout.write((consoleState.mouse ? MOUSE_OFF : '') + RESET + AUTOWRAP_ON + SHOW_CURSOR + ALT_SCREEN_OFF);
  Kernel32.SetConsoleMode(consoleState.handle, consoleState.savedMode);
  Kernel32.SetConsoleOutputCP(consoleState.savedCp);
};

const detectSize = (): { cols: number; rows: number } => {
  let cols = envNum('TERM_COLS', NaN);
  let rows = envNum('TERM_ROWS', NaN);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    const handle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
    const csbi = Buffer.alloc(22);
    if (Kernel32.GetConsoleScreenBufferInfo(handle, csbi.ptr)) {
      const view = new DataView(csbi.buffer);
      const w = view.getInt16(14, true) - view.getInt16(10, true) + 1;
      const h = view.getInt16(16, true) - view.getInt16(12, true) + 1;
      if (!Number.isFinite(cols)) cols = w;
      if (!Number.isFinite(rows)) rows = h;
    }
  }
  if (!Number.isFinite(cols)) cols = process.stdout.columns || 120;
  if (!Number.isFinite(rows)) rows = process.stdout.rows || 40;
  cols = Math.max(20, Math.min(cols | 0, 400));
  rows = Math.max(8, Math.min((rows | 0) - 1, 200));
  return { cols, rows };
};

// ── Demo runtime ─────────────────────────────────────────────────────────────────
export interface TextDemoSpec {
  title: string;
  /** One-line controls / credit caption (shown in the FPS status bar). */
  hud?: string;
  init?: (t: CharTerm) => void | Promise<void>;
  resize?: (t: CharTerm) => void | Promise<void>;
  frame: (t: CharTerm, time: number, dt: number, frame: number) => void;
  captureT?: number;
  targetFps?: number;
  onKey?: (key: string, t: CharTerm) => void;
  mouse?: boolean;
}

// FPS readout — ALWAYS drawn, top-right, coloured by performance. No opt-out.
const drawFps = (t: CharTerm, fps: number, hud?: string): void => {
  const fc: RGB = fps >= 60 ? [120, 255, 140] : fps >= 30 ? [255, 200, 90] : [255, 110, 110];
  const label = ` ${fps.toFixed(0).padStart(3)} FPS `;
  const x = Math.max(0, t.cols - label.length);
  t.fillRect(x, 0, label.length, 1, [22, 22, 30]);
  t.text(x, 0, label, fc, [22, 22, 30], true);
  if (hud) {
    const hx = Math.max(0, x - hud.length - 2);
    if (hx > 0) {
      t.fillRect(hx, 0, hud.length + 1, 1, [22, 22, 30]);
      t.text(hx, 0, hud, [150, 150, 165], [22, 22, 30]);
    }
  }
};

export async function runTextDemo(spec: TextDemoSpec): Promise<void> {
  const capturePath = env('CAPTURE_PNG');
  const bench = env('BENCH') === '1';
  const captureFps = envNum('CAPTURE_FPS', 60);
  const fixedDt = 1 / captureFps;

  // ── Capture: deterministic, headless, writes PNG(s) and exits ─────────────────
  if (capturePath) {
    const cols = Math.max(20, envNum('TERM_COLS', 160) | 0);
    const rows = Math.max(8, envNum('TERM_ROWS', 50) | 0);
    const t = new CharTerm(cols, rows);
    await spec.init?.(t);
    const captureT = envNum('CAPTURE_T', spec.captureT ?? 4);
    const nFrames = Math.max(1, envNum('CAPTURE_FRAMES', 1));
    const shots: number[] = [];
    for (let i = 0; i < nFrames; i++) shots.push(nFrames === 1 ? captureT : (captureT * i) / (nFrames - 1));
    const writeShot = async (idx: number): Promise<void> => {
      // Snapshot, overlay FPS only for the PNG, encode, restore.
      const sCh = t.ch.slice(), sFg = t.fg.slice(), sBg = t.bg.slice(), sBd = t.bold.slice();
      drawFps(t, captureFps, spec.hud);
      const png = t.toPNG();
      const path = nFrames === 1 ? capturePath : capturePath.replace(/(\.png)?$/i, `.${idx}.png`);
      await Bun.write(path, png);
      t.ch.set(sCh);
      t.fg.set(sFg);
      t.bg.set(sBg);
      t.bold.set(sBd);
    };
    let shot = 0;
    let time = 0;
    let frame = 0;
    const total = Math.max(1, Math.round(captureT / fixedDt));
    for (let f = 0; f <= total && shot < shots.length; f++) {
      spec.frame(t, time, f === 0 ? 0 : fixedDt, frame);
      while (shot < shots.length && time >= shots[shot] - 1e-9) {
        await writeShot(shot);
        shot++;
      }
      time += fixedDt;
      frame++;
    }
    while (shot < shots.length) {
      await writeShot(shot);
      shot++;
    }
    process.stdout.write(`captured ${nFrames} frame(s) → ${capturePath} (${cols}x${rows} cells)\n`);
    return;
  }

  // ── Bench: measure frame-production ceiling, print JSON, exit ──────────────────
  if (bench) {
    const cols = Math.max(20, envNum('TERM_COLS', 160) | 0);
    const rows = Math.max(8, envNum('TERM_ROWS', 50) | 0);
    const t = new CharTerm(cols, rows);
    await spec.init?.(t);
    const N = Math.max(60, envNum('BENCH_FRAMES', 600) | 0);
    for (let i = 0; i < 30; i++) {
      spec.frame(t, i * fixedDt, fixedDt, i);
      drawFps(t, 999, spec.hud);
      t.buildFrame();
    }
    const start = Bun.nanoseconds();
    for (let i = 0; i < N; i++) {
      spec.frame(t, i * fixedDt, fixedDt, i);
      drawFps(t, 999, spec.hud);
      t.buildFrame();
    }
    const secs = (Bun.nanoseconds() - start) / 1e9;
    const fps = N / secs;
    process.stdout.write(
      `${JSON.stringify({ demo: spec.title, fps: +fps.toFixed(1), msPerFrame: +((secs / N) * 1000).toFixed(3), frames: N, cols, rows })}\n`,
    );
    return;
  }

  // ── Live ──────────────────────────────────────────────────────────────────────
  setupConsole(spec.title, spec.mouse === true);
  const { cols, rows } = detectSize();
  let t = new CharTerm(cols, rows);
  await spec.init?.(t);

  let paused = false;
  let running = true;
  const stop = (): void => {
    running = false;
  };

  const ARROWS: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left' };
  const applyMouse = (b: number, col: number, row: number, release: boolean): void => {
    const motion = (b & 32) !== 0;
    const wheel = (b & 64) !== 0;
    const button = b & 3;
    t.mouseX = Math.max(0, Math.min(t.cols - 1, col - 1));
    t.mouseY = Math.max(0, Math.min(t.rows - 1, row - 1));
    t.mouseInside = true;
    t.mouseActive = true;
    t.mouseSeq++;
    if (wheel) t.wheel += button === 0 ? 1 : -1;
    else if (release) t.mouseDown = false;
    else if (!motion) t.mouseDown = button === 0;
  };

  const stdin = process.stdin;
  const onData = (data: Buffer): void => {
    const s = data.toString('latin1');
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      const code = s.charCodeAt(i);
      if (code === 27 && s[i + 1] === '[') {
        if (s[i + 2] === '<') {
          const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s.slice(i, i + 24));
          if (m) {
            applyMouse(+m[1], +m[2], +m[3], m[4] === 'm');
            i += m[0].length;
            continue;
          }
        }
        const arrow = ARROWS[s[i + 2]];
        if (arrow) {
          spec.onKey?.(arrow, t);
          i += 3;
          continue;
        }
        // Home/End/Delete CSI sequences (e.g. \x1b[3~) — consume to '~'.
        const seq = /^\x1b\[(\d+)~/.exec(s.slice(i, i + 8));
        if (seq) {
          const special: Record<string, string> = { '1': 'home', '4': 'end', '3': 'delete', '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end' };
          const k = special[seq[1]];
          if (k) spec.onKey?.(k, t);
          i += seq[0].length;
          continue;
        }
        // Home/End as \x1b[H / \x1b[F.
        if (s[i + 2] === 'H') { spec.onKey?.('home', t); i += 3; continue; }
        if (s[i + 2] === 'F') { spec.onKey?.('end', t); i += 3; continue; }
        i += 2;
        continue;
      }
      if (code === 3) {
        stop();
        return;
      }
      if (code === 27) {
        // Lone ESC: deliver as 'esc' so demos can use it (Ctrl-C still exits).
        spec.onKey?.('esc', t);
        i++;
        continue;
      }
      if (code === 13 || code === 10) {
        spec.onKey?.('enter', t);
        i++;
        continue;
      }
      if (code === 127 || code === 8) {
        spec.onKey?.('backspace', t);
        i++;
        continue;
      }
      if (code === 9) {
        spec.onKey?.('tab', t);
        i++;
        continue;
      }
      if (ch === ' ') {
        spec.onKey?.('space', t);
        i++;
        continue;
      }
      // Printable: deliver the raw character (NOT lowercased — TUIs need case).
      if (code >= 32) spec.onKey?.(ch, t);
      i++;
    }
  };
  let rawOn = false;
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(true);
      rawOn = true;
      stdin.resume();
      stdin.on('data', onData);
    } catch {
      /* not interactive — ignore */
    }
  }

  const durationMs = envNum('DEMO_DURATION_MS', 0);
  const cap = spec.targetFps ?? 60;
  const minFrameMs = cap > 0 ? 1000 / cap : 0;
  const frameWait = minFrameMs > 0 ? makeFrameWaiter() : null;

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (rawOn) {
      try {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
      } catch {
        /* ignore */
      }
    }
    restoreConsole();
  };
  process.on('SIGINT', () => {
    stop();
  });
  process.on('exit', cleanup);
  process.on('uncaughtException', (e) => {
    cleanup();
    console.error(e);
    process.exit(1);
  });

  const t0 = Bun.nanoseconds();
  let last = t0;
  let fpsEma = 60;
  let frame = 0;
  let simTime = 0;
  void paused;

  try {
    while (running) {
      const sz = detectSize();
      if (sz.cols !== t.cols || sz.rows !== t.rows) {
        t = new CharTerm(sz.cols, sz.rows);
        if (spec.resize) await spec.resize(t);
        else await spec.init?.(t);
        process.stdout.write(CLEAR + HOME);
      }

      const now = Bun.nanoseconds();
      let dt = (now - last) / 1e9;
      last = now;
      if (dt > 0.1) dt = 0.1;
      simTime += dt;
      const inst = dt > 0 ? 1 / dt : 999;
      fpsEma = fpsEma * 0.9 + inst * 0.1;

      spec.frame(t, simTime, dt, frame);
      drawFps(t, fpsEma, spec.hud);
      t.present();
      frame++;

      if (durationMs > 0 && (now - t0) / 1e6 >= durationMs) break;

      if (minFrameMs > 0) {
        const wait = minFrameMs - (Bun.nanoseconds() - now) / 1e6;
        if (wait > 0.2) {
          if (frameWait) frameWait(wait); // precise high-res wait — Bun.sleep quantizes to ~15.6ms on Windows (→ ~30fps)
          else await Bun.sleep(wait); // legacy fallback (pre-1803 Windows)
        }
      }
      // Yield via the check phase to drain stdin/resize I/O. NOT Bun.sleep(0): its
      // timer only fires on the next ~15.6ms Windows tick after the blocking wait
      // above, which would re-introduce the ~30fps quantization the timer just fixed.
      await new Promise<void>((r) => setImmediate(r));
    }
  } finally {
    cleanup();
  }
  if (env('FPS_REPORT') === '1') {
    const secs = (Bun.nanoseconds() - t0) / 1e9;
    process.stderr.write(`fps_report avg=${(frame / Math.max(1e-9, secs)).toFixed(1)} frames=${frame} secs=${secs.toFixed(2)}\n`);
  }
}
