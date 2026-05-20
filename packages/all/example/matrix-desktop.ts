/**
 * Matrix Desktop — Digital rain falls on your real desktop.
 *
 * Creates a fullscreen, topmost, click-through layered overlay sized to the
 * primary monitor and rains cascading green katakana down it in real time. The
 * overlay sits on top of every other window — your wallpaper, your editor, your
 * browser — and composites through 32-bit premultiplied alpha so the screen
 * beneath remains untouched. `WS_EX_TRANSPARENT` lets mouse clicks pass through
 * to whatever is underneath, so you can keep working while the Matrix falls.
 *
 * The render pipeline is built from scratch on top of FFI primitives:
 *
 *   1. At startup, each character of an 80-glyph pool (katakana + digits +
 *      Latin + a few symbols) is rasterized once into a small 14×16 PARGB
 *      bitmap by GDI+ (`GdipDrawString`). The bitmap is locked with
 *      `GdipBitmapLockBits`, and the alpha channel of each pixel is copied out
 *      as a `Uint8Array` glyph mask. From that point on the runtime never calls
 *      back into GDI+ — every frame is pure JS, just blending precomputed
 *      8-bit masks into a giant premultiplied ARGB framebuffer.
 *
 *   2. A single screen-sized DIB section is allocated with `CreateDIBSection`
 *      and selected into a memory DC. We capture the raw pixel pointer GDI
 *      hands back and wrap it in a `Uint32Array` via `toArrayBuffer`, so the
 *      JS frame writes go straight to GDI-owned memory with zero copies.
 *
 *   3. Each frame (~30 fps): advance ~140 independent column states (head
 *      position, fall speed, trail length, glyph rotation), then for every
 *      column draw the trailing tail in fading green (premultiplied) and the
 *      head glyph in bright white-green with a 1-pixel halo. Pixels above and
 *      below the trail remain fully transparent — the desktop shows through.
 *
 *   4. `UpdateLayeredWindow` blits the framebuffer with `AC_SRC_ALPHA` so the
 *      per-pixel premultiplied alpha drives the composition. The DWM picks it
 *      up and the rain visibly hovers above every other window.
 *
 * Sound is a real XAudio2 source voice playing a 5-second pre-rendered drone:
 * three detuned sine layers (60 Hz, 90 Hz, 122 Hz) modulated by a slow LFO,
 * submitted once with `LoopCount = XAUDIO2_LOOP_INFINITE` so the voice loops
 * indefinitely on the engine thread with no further JS involvement. ESC quits
 * cleanly: `KillTimer`, `DestroyWindow`, `UnregisterClassW`, `DeleteObject`,
 * `DestroyVoice`, `Release`.
 *
 * APIs demonstrated (User32):
 *   - GetSystemMetrics                  (primary monitor width/height)
 *   - RegisterClassExW, CreateWindowExW (WS_POPUP + WS_EX_LAYERED|TOPMOST|
 *                                        TRANSPARENT|TOOLWINDOW = click-through
 *                                        topmost overlay)
 *   - UpdateLayeredWindow               (per-pixel ARGB compositing per frame)
 *   - SetTimer / KillTimer              (~33 ms frame tick)
 *   - GetMessageW / TranslateMessage / DispatchMessageW (message loop)
 *   - DefWindowProcW + JSCallback       (custom WndProc)
 *   - GetAsyncKeyState                  (ESC polling)
 *   - GetDC / ReleaseDC                 (screen DC for the layered window)
 *   - DestroyWindow, UnregisterClassW   (clean teardown)
 *
 * APIs demonstrated (GDI32):
 *   - CreateCompatibleDC                (memory DC backing the layered window)
 *   - CreateDIBSection                  (one 32-bit ARGB top-down DIB,
 *                                        screen-sized, raw pixel pointer
 *                                        written from JS each frame)
 *   - SelectObject                      (bind the DIB into the memory DC)
 *   - DeleteObject, DeleteDC            (release GDI resources on exit)
 *
 * APIs demonstrated (Gdiplus):
 *   - GdiplusStartup / GdiplusShutdown  (init the GDI+ subsystem)
 *   - GdipCreateBitmapFromScan0         (a small PARGB scratch bitmap per glyph)
 *   - GdipGetImageGraphicsContext       (graphics context bound to the bitmap)
 *   - GdipSetSmoothingMode /
 *     GdipSetTextRenderingHint          (high-quality antialiased glyph edges)
 *   - GdipGraphicsClear                 (zero the scratch bitmap between glyphs)
 *   - GdipCreateFontFamilyFromName /
 *     GdipCreateFont /
 *     GdipCreateStringFormat            (typography for the pool characters)
 *   - GdipCreateSolidFill               (white brush, tinted at composite time)
 *   - GdipDrawString                    (rasterize one glyph into the bitmap)
 *   - GdipBitmapLockBits /
 *     GdipBitmapUnlockBits              (read raw pixel data into JS)
 *   - GdipDeleteBrush, GdipDeleteFont,
 *     GdipDeleteFontFamily,
 *     GdipDeleteStringFormat,
 *     GdipDeleteGraphics,
 *     GdipDisposeImage                  (release GDI+ handles)
 *
 * APIs demonstrated (Xaudio2_9):
 *   - XAudio2Create                     (boot IXAudio2 engine via flat export)
 *   - IXAudio2::CreateMasteringVoice    (open the default endpoint)
 *   - IXAudio2::CreateSourceVoice       (16-bit mono PCM voice)
 *   - IXAudio2SourceVoice::SubmitSourceBuffer / Start
 *                                       (one infinitely-looping drone buffer)
 *   - IXAudio2Voice::DestroyVoice / IUnknown::Release  (teardown)
 *
 * APIs demonstrated (Kernel32):
 *   - Sleep                             (yield on exit before process.exit)
 *
 * Run: bun run example/matrix-desktop.ts
 *      ESC quits.
 */

import { CFunction, FFIType, JSCallback, type Pointer, toArrayBuffer } from 'bun:ffi';

import { GDI32, Gdiplus, Kernel32, User32, Xaudio2_9 } from '../index';
import { ExtendedWindowStyles, SystemMetric, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { PixelFormat32bppPARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit, FontStyle, ImageLockMode } from '@bun-win32/gdiplus';
import { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '@bun-win32/xaudio2_9';

const NULL = 0n;
const NULL_PTR = null as unknown as Pointer;

const encode = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');

// Window-message constants we care about.
const WM_DESTROY = 0x0002;
const WM_TIMER = 0x0113;
const WM_CLOSE = 0x0010;

// UpdateLayeredWindow flag: ULW_ALPHA = 0x02 (use the BLENDFUNCTION).
const ULW_ALPHA = 0x02;

// BI_RGB compression constant for CreateDIBSection.
const BI_RGB = 0;
// DIB_RGB_COLORS usage flag.
const DIB_RGB_COLORS = 0;

// Frame cadence.
const TIMER_ID = 1n;
const FRAME_INTERVAL_MS = 33; // ~30 fps

// Glyph cell geometry.
const GLYPH_WIDTH = 14;
const GLYPH_HEIGHT = 18;
const GLYPH_FONT_SIZE = 14; // Pixel-unit font size.

// IXAudio2 / IXAudio2Voice / IXAudio2SourceVoice vtable slots (xaudio2.h order).
const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATESOURCEVOICE = 5;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;
const IXAUDIO2VOICE_DESTROYVOICE = 18;
const IXAUDIO2SOURCEVOICE_START = 19;
const IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER = 21;

const XAUDIO2_DEFAULT_FREQ_RATIO = 2.0;
const XAUDIO2_LOOP_INFINITE = 255;
const AudioCategory_GameEffects = 6;

const DRONE_SAMPLE_RATE = 44_100;
const DRONE_DURATION_S = 5.0;
const DRONE_CHANNELS = 1;
const DRONE_BITS = 16;
const DRONE_BLOCK_ALIGN = (DRONE_CHANNELS * DRONE_BITS) / 8;

const vcallInvokers = new Map<string, ReturnType<typeof CFunction>>();

/**
 * Invokes COM vtable slot `slot` on interface pointer `thisPtr`. The implicit
 * `this` is prepended automatically; the bound `CFunction` is memoized per
 * `(method, signature)` so repeated calls don't pay the bind cost.
 */
function vcall(thisPtr: bigint, slot: number, argTypes: readonly FFIType[], args: readonly unknown[], returns: FFIType = FFIType.i32): number {
  const vtablePtr = Number(thisPtr) as Pointer;
  const vtableBuf = new BigUint64Array(toArrayBuffer(vtablePtr, 0, 8));
  const vtable = Number(vtableBuf[0]!) as Pointer;
  const methodBuf = new BigUint64Array(toArrayBuffer(vtable, slot * 8, 8));
  const method = Number(methodBuf[0]!) as Pointer;
  const key = `${method}|${returns}|${argTypes.join(',')}`;
  let invoke = vcallInvokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({ ptr: method, args: [FFIType.u64, ...argTypes], returns });
    vcallInvokers.set(key, invoke);
  }
  return invoke(thisPtr, ...args);
}

function checkGdiplus(status: number, where: string): void {
  if (status !== Status.Ok) {
    throw new Error(`${where} failed: ${Status[status]} (${status})`);
  }
}

// --- Primary-monitor metrics --------------------------------------------------

const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
const columnCount = Math.floor(screenWidth / GLYPH_WIDTH);
const rowCount = Math.ceil(screenHeight / GLYPH_HEIGHT) + 2;

console.log('Matrix Desktop');
console.log(`  Screen   : ${screenWidth}x${screenHeight}`);
console.log(`  Columns  : ${columnCount} columns (${GLYPH_WIDTH}px wide, ${GLYPH_HEIGHT}px line height)`);
console.log(`  Frame    : every ${FRAME_INTERVAL_MS} ms (~${Math.round(1000 / FRAME_INTERVAL_MS)} fps)`);
console.log('');
console.log('  ESC to quit.');
console.log('');

// --- Glyph pool ---------------------------------------------------------------

// Half-width katakana block (U+FF66..U+FF9D), digits, uppercase Latin, plus a
// handful of punctuation/symbols. Picked for the classic Matrix look — vertical
// strokes, dense glyph silhouettes, no kerning concerns.
const GLYPH_POOL: readonly string[] = [
  ...Array.from({ length: 56 }, (_, index) => String.fromCharCode(0xff66 + index)), // ｦ..ﾝ
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'A', 'B', 'C', 'D', 'E', 'F', 'Z', 'X', 'Y',
  '+', '*', '<', '>', '=', ':', '|', '/', '?',
];
const POOL_SIZE = GLYPH_POOL.length;

// --- GDI+ glyph rasterization ------------------------------------------------

Gdiplus.Preload();

const startupTokenBuffer = Buffer.alloc(8);
const startupInputBuffer = Buffer.alloc(16);
startupInputBuffer.writeUInt32LE(1, 0); // GdiplusVersion = 1
checkGdiplus(Gdiplus.GdiplusStartup(startupTokenBuffer.ptr!, startupInputBuffer.ptr!, null), 'GdiplusStartup');
const gdiplusToken = startupTokenBuffer.readBigUInt64LE(0);

/**
 * Rasterizes every character in `GLYPH_POOL` exactly once into a 14×16 PARGB
 * scratch bitmap, copies the alpha channel out into a per-glyph `Uint8Array`,
 * and returns the resulting glyph-mask table. Runtime rendering never touches
 * GDI+ again — every frame just blends these precomputed masks into the screen
 * framebuffer with a green tint.
 */
function precomputeGlyphMasks(): Uint8Array[] {
  // Scratch bitmap (PARGB, top-down — but origin doesn't matter; we read every
  // pixel anyway).
  const bitmapHandleBuffer = Buffer.alloc(8);
  checkGdiplus(Gdiplus.GdipCreateBitmapFromScan0(GLYPH_WIDTH, GLYPH_HEIGHT, 0, PixelFormat32bppPARGB, null, bitmapHandleBuffer.ptr!), 'GdipCreateBitmapFromScan0');
  const bitmap = bitmapHandleBuffer.readBigUInt64LE(0);

  const graphicsHandleBuffer = Buffer.alloc(8);
  checkGdiplus(Gdiplus.GdipGetImageGraphicsContext(bitmap, graphicsHandleBuffer.ptr!), 'GdipGetImageGraphicsContext');
  const graphics = graphicsHandleBuffer.readBigUInt64LE(0);

  checkGdiplus(Gdiplus.GdipSetSmoothingMode(graphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
  checkGdiplus(Gdiplus.GdipSetTextRenderingHint(graphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit), 'GdipSetTextRenderingHint');

  // White brush — we read out the alpha channel and re-tint at composite time.
  const brushBuffer = Buffer.alloc(8);
  checkGdiplus(Gdiplus.GdipCreateSolidFill(0xffffffff, brushBuffer.ptr!), 'GdipCreateSolidFill');
  const brush = brushBuffer.readBigUInt64LE(0);

  // Centered string format.
  const stringFormatBuffer = Buffer.alloc(8);
  checkGdiplus(Gdiplus.GdipCreateStringFormat(0, 0, stringFormatBuffer.ptr!), 'GdipCreateStringFormat');
  const stringFormat = stringFormatBuffer.readBigUInt64LE(0);
  Gdiplus.GdipSetStringFormatAlign(stringFormat, StringAlignment.StringAlignmentCenter);
  Gdiplus.GdipSetStringFormatLineAlign(stringFormat, StringAlignment.StringAlignmentCenter);

  // Try Consolas first — it has good katakana coverage and a tight monospaced
  // grid. Fall back to a generic family if the host doesn't have it.
  const fontFamilyBuffer = Buffer.alloc(8);
  const consolasName = encode('Consolas');
  let fontFamilyStatus = Gdiplus.GdipCreateFontFamilyFromName(consolasName.ptr!, 0n, fontFamilyBuffer.ptr!);
  if (fontFamilyStatus !== Status.Ok) {
    const fallbackName = encode('Segoe UI');
    fontFamilyStatus = Gdiplus.GdipCreateFontFamilyFromName(fallbackName.ptr!, 0n, fontFamilyBuffer.ptr!);
  }
  checkGdiplus(fontFamilyStatus, 'GdipCreateFontFamilyFromName');
  const fontFamily = fontFamilyBuffer.readBigUInt64LE(0);

  const fontBuffer = Buffer.alloc(8);
  checkGdiplus(Gdiplus.GdipCreateFont(fontFamily, GLYPH_FONT_SIZE, FontStyle.FontStyleRegular, Unit.UnitPixel, fontBuffer.ptr!), 'GdipCreateFont');
  const font = fontBuffer.readBigUInt64LE(0);

  // Layout rect covering the bitmap.
  const layoutRect = Buffer.alloc(16);
  layoutRect.writeFloatLE(0, 0);
  layoutRect.writeFloatLE(0, 4);
  layoutRect.writeFloatLE(GLYPH_WIDTH, 8);
  layoutRect.writeFloatLE(GLYPH_HEIGHT, 12);

  // GpRect for GdipBitmapLockBits.
  const lockRect = Buffer.alloc(16);
  lockRect.writeInt32LE(0, 0);
  lockRect.writeInt32LE(0, 4);
  lockRect.writeInt32LE(GLYPH_WIDTH, 8);
  lockRect.writeInt32LE(GLYPH_HEIGHT, 12);

  // BitmapData (x64): Width(4) + Height(4) + Stride(4) + PixelFormat(4) +
  // Scan0(8 ptr) + Reserved(8) = 32 bytes.
  const bitmapData = Buffer.alloc(32);

  const masks: Uint8Array[] = [];

  for (const character of GLYPH_POOL) {
    // Wipe the scratch bitmap to fully transparent before each draw.
    checkGdiplus(Gdiplus.GdipGraphicsClear(graphics, 0x00000000), 'GdipGraphicsClear');

    const text = encode(character);
    checkGdiplus(Gdiplus.GdipDrawString(graphics, text.ptr!, -1, font, layoutRect.ptr!, stringFormat, brush), 'GdipDrawString');

    // Lock the bitmap for read access, copy the alpha channel into a mask, unlock.
    checkGdiplus(Gdiplus.GdipBitmapLockBits(bitmap, lockRect.ptr!, ImageLockMode.ImageLockModeRead, PixelFormat32bppPARGB, bitmapData.ptr!), 'GdipBitmapLockBits');
    const stride = bitmapData.readInt32LE(8);
    const scan0 = Number(bitmapData.readBigUInt64LE(16)) as Pointer;
    const sourceView = new Uint8Array(toArrayBuffer(scan0, 0, Math.abs(stride) * GLYPH_HEIGHT));

    const mask = new Uint8Array(GLYPH_WIDTH * GLYPH_HEIGHT);
    const rowStride = Math.abs(stride);
    const topDown = stride > 0;
    for (let y = 0; y < GLYPH_HEIGHT; y += 1) {
      const sourceRow = topDown ? y * rowStride : (GLYPH_HEIGHT - 1 - y) * rowStride;
      const destRow = y * GLYPH_WIDTH;
      for (let x = 0; x < GLYPH_WIDTH; x += 1) {
        // PARGB layout in memory is little-endian B, G, R, A.
        mask[destRow + x] = sourceView[sourceRow + x * 4 + 3]!;
      }
    }
    masks.push(mask);

    checkGdiplus(Gdiplus.GdipBitmapUnlockBits(bitmap, bitmapData.ptr!), 'GdipBitmapUnlockBits');
  }

  // GDI+ teardown — every frame from here on is pure JS pixel math.
  Gdiplus.GdipDeleteBrush(brush);
  Gdiplus.GdipDeleteFont(font);
  Gdiplus.GdipDeleteFontFamily(fontFamily);
  Gdiplus.GdipDeleteStringFormat(stringFormat);
  Gdiplus.GdipDeleteGraphics(graphics);
  Gdiplus.GdipDisposeImage(bitmap);

  return masks;
}

const glyphMasks = precomputeGlyphMasks();
Gdiplus.GdiplusShutdown(gdiplusToken);
console.log(`  Glyphs   : ${glyphMasks.length} characters rasterized (Consolas ${GLYPH_FONT_SIZE}px, alpha-masked)`);

// --- Column rain state --------------------------------------------------------

/**
 * One falling column of glyphs. `headRow` is the floating-point row position of
 * the brightest leading character (can be negative when the column is queued to
 * fall in); `speed` is rows per frame; `length` is the trail length in glyph
 * cells. `glyphIndices` is a per-row pool index, sometimes rotated to give the
 * illusion of glyphs changing as they fall. `rotationCounter` ticks the
 * rotation cadence.
 */
interface RainColumn {
  headRow: number;
  speed: number;
  length: number;
  glyphIndices: Uint8Array;
  rotationCounter: number;
  rotationInterval: number;
  intensity: number;
}

function makeColumn(initialHeadRow: number): RainColumn {
  const length = 6 + Math.floor(Math.random() * 22);
  const glyphIndices = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) glyphIndices[i] = Math.floor(Math.random() * POOL_SIZE);
  return {
    headRow: initialHeadRow,
    speed: 0.3 + Math.random() * 0.9,
    length,
    glyphIndices,
    rotationCounter: 0,
    rotationInterval: 2 + Math.floor(Math.random() * 6),
    intensity: 0.7 + Math.random() * 0.3,
  };
}

const columns: RainColumn[] = [];
for (let c = 0; c < columnCount; c += 1) {
  // Stagger initial head positions so the rain looks like it's already falling
  // when the window appears.
  columns.push(makeColumn(-Math.random() * rowCount));
}

/**
 * Advances every column's head position by its speed and rotates a few trailing
 * glyphs to a fresh pool index each rotation interval. Once a column has fully
 * fallen off the bottom of the screen, it's recycled with fresh randomized
 * state above the top.
 */
function stepColumns(): void {
  for (let c = 0; c < columnCount; c += 1) {
    const column = columns[c]!;
    column.headRow += column.speed;
    column.rotationCounter += 1;
    if (column.rotationCounter >= column.rotationInterval) {
      column.rotationCounter = 0;
      // Rotate one or two random trail indices so glyphs visibly shimmer.
      const swaps = 1 + Math.floor(Math.random() * 2);
      for (let s = 0; s < swaps; s += 1) {
        const slot = Math.floor(Math.random() * column.length);
        column.glyphIndices[slot] = Math.floor(Math.random() * POOL_SIZE);
      }
    }
    if (column.headRow - column.length > rowCount) {
      columns[c] = makeColumn(-Math.random() * 6 - 1);
    }
  }
}

// --- Window class registration -----------------------------------------------

const className = encode('MatrixDesktopOverlay');

let overlayHwnd = NULL;
let shouldExit = false;

const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_TIMER) return 0n; // Real frame work happens in the main loop.
    if (msg === WM_CLOSE) {
      User32.DestroyWindow(hWnd);
      return 0n;
    }
    if (msg === WM_DESTROY) {
      User32.PostQuitMessage(0);
      return 0n;
    }
    return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
  },
  { args: ['u64', 'u32', 'u64', 'i64'], returns: 'i64' },
);

// WNDCLASSEXW is 80 bytes on x64.
const wndClassBuffer = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuffer.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassView.setUint32(4, 0, true); // style
wndClassBuffer.writeBigUInt64LE(BigInt(wndProc.ptr!), 8); // lpfnWndProc
wndClassView.setInt32(16, 0, true); // cbClsExtra
wndClassView.setInt32(20, 0, true); // cbWndExtra
wndClassBuffer.writeBigUInt64LE(0n, 24); // hInstance
wndClassBuffer.writeBigUInt64LE(0n, 32); // hIcon
wndClassBuffer.writeBigUInt64LE(0n, 40); // hCursor
wndClassBuffer.writeBigUInt64LE(0n, 48); // hbrBackground (no background — fully transparent)
wndClassBuffer.writeBigUInt64LE(0n, 56); // lpszMenuName
wndClassBuffer.writeBigUInt64LE(BigInt(className.ptr!), 64); // lpszClassName
wndClassBuffer.writeBigUInt64LE(0n, 72); // hIconSm

const classAtom = User32.RegisterClassExW(wndClassBuffer.ptr!);
if (!classAtom) {
  console.error('RegisterClassExW failed');
  process.exit(1);
}

// --- Layered, topmost, click-through window covering the primary monitor -----

overlayHwnd = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_TOPMOST | ExtendedWindowStyles.WS_EX_LAYERED | ExtendedWindowStyles.WS_EX_TRANSPARENT | ExtendedWindowStyles.WS_EX_TOOLWINDOW | ExtendedWindowStyles.WS_EX_NOACTIVATE,
  className.ptr!,
  encode('Matrix Desktop').ptr!,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  0,
  0,
  screenWidth,
  screenHeight,
  NULL,
  NULL,
  NULL,
  NULL_PTR,
);

if (!overlayHwnd) {
  console.error('CreateWindowExW failed');
  process.exit(1);
}

// --- DIB section: one screen-sized 32-bit ARGB bitmap, raw pixel access -------

const screenDC = User32.GetDC(NULL);
const memoryDC = GDI32.CreateCompatibleDC(screenDC);

// BITMAPINFOHEADER (40 bytes). biHeight is negated for a top-down DIB so row 0
// is at the top of the buffer.
const bitmapInfoHeader = Buffer.alloc(40);
bitmapInfoHeader.writeUInt32LE(40, 0); // biSize
bitmapInfoHeader.writeInt32LE(screenWidth, 4); // biWidth
bitmapInfoHeader.writeInt32LE(-screenHeight, 8); // biHeight (negative = top-down)
bitmapInfoHeader.writeUInt16LE(1, 12); // biPlanes
bitmapInfoHeader.writeUInt16LE(32, 14); // biBitCount
bitmapInfoHeader.writeUInt32LE(BI_RGB, 16); // biCompression
bitmapInfoHeader.writeUInt32LE(0, 20); // biSizeImage (0 OK for BI_RGB)
bitmapInfoHeader.writeInt32LE(0, 24); // biXPelsPerMeter
bitmapInfoHeader.writeInt32LE(0, 28); // biYPelsPerMeter
bitmapInfoHeader.writeUInt32LE(0, 32); // biClrUsed
bitmapInfoHeader.writeUInt32LE(0, 36); // biClrImportant

// CreateDIBSection writes a pointer to the raw pixel memory into ppvBits.
const ppvBitsBuffer = Buffer.alloc(8);
const dibBitmap = GDI32.CreateDIBSection(memoryDC, bitmapInfoHeader.ptr!, DIB_RGB_COLORS, ppvBitsBuffer.ptr!, NULL, 0);
if (!dibBitmap) {
  console.error('CreateDIBSection failed');
  process.exit(1);
}
GDI32.SelectObject(memoryDC, dibBitmap);

const pixelByteCount = screenWidth * screenHeight * 4;
const pixelAddress = Number(ppvBitsBuffer.readBigUInt64LE(0)) as Pointer;
const pixelView = new Uint32Array(toArrayBuffer(pixelAddress, 0, pixelByteCount));

// --- Frame compositor --------------------------------------------------------

/**
 * Composites one premultiplied-ARGB pixel into `pixelView` using the standard
 * `out = src + dst * (1 - srcAlpha)` over operator. The inputs are bytes 0–255;
 * we keep the math in plain ints. Inlined into the inner loop for speed.
 *
 * Here `dst` is always zero (we clear the framebuffer at the top of every
 * frame), so we simply write `src`. Kept as a documented helper for clarity.
 */
const writePremultipliedPixel = (offset: number, alpha: number, red: number, green: number, blue: number): void => {
  // Premultiplied ARGB packed as 0xAARRGGBB in little-endian memory.
  pixelView[offset] = ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0;
};

// The Matrix palette: head glyphs glow near-white-green, trail glyphs fade
// from saturated green to deep green to nothing. We bake the per-trail-step
// color table once and reuse it every frame for every column.
const HEAD_RED = 200;
const HEAD_GREEN = 255;
const HEAD_BLUE = 210;
const BODY_RED = 0;
const BODY_GREEN = 255;
const BODY_BLUE = 70;

/**
 * Stamps one glyph mask into the framebuffer at pixel `(originX, originY)` with
 * a premultiplied tint. `tintAlpha` is the overall intensity 0–1; the glyph's
 * own alpha mask modulates further per-pixel.
 */
function stampGlyph(originX: number, originY: number, glyphIndex: number, tintAlpha: number, tintRed: number, tintGreen: number, tintBlue: number): void {
  if (tintAlpha <= 0) return;
  const mask = glyphMasks[glyphIndex]!;
  // Premultiply the tint color by tintAlpha once.
  const tintA = tintAlpha;
  const preR = tintRed * tintA;
  const preG = tintGreen * tintA;
  const preB = tintBlue * tintA;
  for (let dy = 0; dy < GLYPH_HEIGHT; dy += 1) {
    const y = originY + dy;
    if (y < 0 || y >= screenHeight) continue;
    const rowOffset = y * screenWidth;
    const maskRow = dy * GLYPH_WIDTH;
    for (let dx = 0; dx < GLYPH_WIDTH; dx += 1) {
      const x = originX + dx;
      if (x < 0 || x >= screenWidth) continue;
      const maskAlpha = mask[maskRow + dx]!;
      if (maskAlpha === 0) continue;
      // Combine glyph alpha (0..255) with the precomputed tint multipliers.
      const alpha = Math.min(255, Math.round((maskAlpha * tintA) | 0));
      if (alpha === 0) continue;
      const red = Math.min(255, Math.round((maskAlpha * preR) / 255) | 0);
      const green = Math.min(255, Math.round((maskAlpha * preG) / 255) | 0);
      const blue = Math.min(255, Math.round((maskAlpha * preB) / 255) | 0);
      writePremultipliedPixel(rowOffset + x, alpha, red, green, blue);
    }
  }
}

/**
 * Renders every column's trail and head into the framebuffer. Pixels not
 * touched by any glyph stay at 0 — fully transparent — so the desktop bleeds
 * through.
 */
function renderFrame(): void {
  pixelView.fill(0);
  for (let c = 0; c < columnCount; c += 1) {
    const column = columns[c]!;
    const originX = c * GLYPH_WIDTH;
    const headRowInt = Math.floor(column.headRow);

    // Draw the trailing tail back from the head. The deepest trail glyphs are
    // nearly transparent, fading up to bright at the head.
    for (let trailIndex = column.length - 1; trailIndex >= 1; trailIndex -= 1) {
      const row = headRowInt - trailIndex;
      if (row < 0 || row >= rowCount) continue;
      // Trail fade curve: linear from 0 at the deepest cell to ~0.85 just
      // behind the head, attenuated by per-column intensity.
      const fade = 1 - trailIndex / column.length;
      const tintAlpha = fade * fade * column.intensity * 0.95;
      stampGlyph(originX, row * GLYPH_HEIGHT, column.glyphIndices[trailIndex]!, tintAlpha, BODY_RED, BODY_GREEN, BODY_BLUE);
    }

    // Draw the head glyph in bright white-green so it pops above the trail.
    const headRow = headRowInt;
    if (headRow >= 0 && headRow < rowCount) {
      stampGlyph(originX, headRow * GLYPH_HEIGHT, column.glyphIndices[0]!, Math.min(1, column.intensity * 1.15), HEAD_RED, HEAD_GREEN, HEAD_BLUE);
    }
  }
}

// --- Persistent UpdateLayeredWindow argument structures ----------------------

const destPoint = Buffer.alloc(8);
destPoint.writeInt32LE(0, 0);
destPoint.writeInt32LE(0, 4);

const sizeBuffer = Buffer.alloc(8);
sizeBuffer.writeInt32LE(screenWidth, 0);
sizeBuffer.writeInt32LE(screenHeight, 4);

const sourcePoint = Buffer.alloc(8);
sourcePoint.writeInt32LE(0, 0);
sourcePoint.writeInt32LE(0, 4);

// BLENDFUNCTION (4 bytes): { BlendOp = AC_SRC_OVER (0), BlendFlags = 0,
// SourceConstantAlpha = 255, AlphaFormat = AC_SRC_ALPHA (1) }.
const blendFunction = Buffer.alloc(4);
blendFunction.writeUInt8(0, 0); // AC_SRC_OVER
blendFunction.writeUInt8(0, 1); // BlendFlags
blendFunction.writeUInt8(255, 2); // SourceConstantAlpha
blendFunction.writeUInt8(1, 3); // AC_SRC_ALPHA

function presentFrame(): void {
  User32.UpdateLayeredWindow(overlayHwnd, screenDC, destPoint.ptr!, sizeBuffer.ptr!, memoryDC, sourcePoint.ptr!, 0, blendFunction.ptr!, ULW_ALPHA);
}

// --- XAudio2 ambient drone ---------------------------------------------------

let audioReady = false;
let engine = 0n;
let masterVoice = 0n;
let sourceVoice = 0n;

// Pre-render a 5-second drone PCM and keep it alive for the entire program.
// Three detuned sine layers (60 Hz, 90 Hz, 122 Hz) plus a slow amplitude LFO
// give it that ominous low Matrix hum.
const droneSampleCount = Math.floor(DRONE_DURATION_S * DRONE_SAMPLE_RATE);
const dronePcm = Buffer.alloc(droneSampleCount * DRONE_BLOCK_ALIGN);
{
  const loopFundamental = 1 / DRONE_DURATION_S; // 1 cycle across the buffer
  for (let i = 0; i < droneSampleCount; i += 1) {
    const t = i / DRONE_SAMPLE_RATE;
    // Layer three detuned sines. Frequencies are tweaked to be exact integer
    // multiples of loopFundamental so the buffer loops without click.
    const f1 = Math.round(60 / loopFundamental) * loopFundamental;
    const f2 = Math.round(90 / loopFundamental) * loopFundamental;
    const f3 = Math.round(122 / loopFundamental) * loopFundamental;
    const layer1 = Math.sin(2 * Math.PI * f1 * t);
    const layer2 = Math.sin(2 * Math.PI * f2 * t) * 0.6;
    const layer3 = Math.sin(2 * Math.PI * f3 * t) * 0.4;
    // Slow LFO amplitude modulation (one full cycle across the buffer for
    // seamless loop), then a gentle fade in/out across the very ends — extra
    // insurance against any click on loop boundary.
    const lfo = 0.65 + 0.35 * Math.sin(2 * Math.PI * loopFundamental * t);
    const sample = (layer1 + layer2 + layer3) * lfo * 0.12;
    dronePcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * DRONE_BLOCK_ALIGN);
  }
}

// Boot the engine — silently fall back to "no audio" if the host has no
// playback device.
const ppEngine = Buffer.alloc(8);
const createHr = Xaudio2_9.XAudio2Create(ppEngine.ptr!, 0, XAUDIO2_USE_DEFAULT_PROCESSOR);
if (createHr === S_OK) {
  engine = ppEngine.readBigUInt64LE(0);
  const ppMaster = Buffer.alloc(8);
  const masterHr = vcall(engine, IXAUDIO2_CREATEMASTERINGVOICE, [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32], [ppMaster.ptr!, 0, 0, 0, null, null, AudioCategory_GameEffects]);
  if (masterHr === S_OK) {
    masterVoice = ppMaster.readBigUInt64LE(0);

    // WAVEFORMATEX (18 bytes): WAVE_FORMAT_PCM mono 16-bit.
    const wfx = Buffer.alloc(18);
    wfx.writeUInt16LE(1, 0); // wFormatTag = WAVE_FORMAT_PCM
    wfx.writeUInt16LE(DRONE_CHANNELS, 2);
    wfx.writeUInt32LE(DRONE_SAMPLE_RATE, 4);
    wfx.writeUInt32LE(DRONE_SAMPLE_RATE * DRONE_BLOCK_ALIGN, 8);
    wfx.writeUInt16LE(DRONE_BLOCK_ALIGN, 12);
    wfx.writeUInt16LE(DRONE_BITS, 14);
    wfx.writeUInt16LE(0, 16);

    const ppSource = Buffer.alloc(8);
    const srcHr = vcall(engine, IXAUDIO2_CREATESOURCEVOICE, [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr], [ppSource.ptr!, wfx.ptr!, 0, XAUDIO2_DEFAULT_FREQ_RATIO, null, null, null]);
    if (srcHr === S_OK) {
      sourceVoice = ppSource.readBigUInt64LE(0);

      // XAUDIO2_BUFFER (48 bytes on x64). Loop the entire buffer infinitely:
      // PlayBegin/Length = 0/0 (entire buffer), LoopBegin = 0,
      // LoopLength = 0 (entire buffer), LoopCount = XAUDIO2_LOOP_INFINITE.
      const droneXBuffer = Buffer.alloc(48);
      droneXBuffer.writeUInt32LE(0, 0); // Flags (no END_OF_STREAM — we loop forever)
      droneXBuffer.writeUInt32LE(dronePcm.length, 4); // AudioBytes
      droneXBuffer.writeBigUInt64LE(BigInt(dronePcm.ptr!), 8); // pAudioData
      droneXBuffer.writeUInt32LE(0, 16); // PlayBegin
      droneXBuffer.writeUInt32LE(0, 20); // PlayLength (0 = whole buffer)
      droneXBuffer.writeUInt32LE(0, 24); // LoopBegin
      droneXBuffer.writeUInt32LE(0, 28); // LoopLength (0 = whole buffer)
      droneXBuffer.writeUInt32LE(XAUDIO2_LOOP_INFINITE, 32); // LoopCount
      droneXBuffer.writeBigUInt64LE(0n, 40); // pContext

      const submitHr = vcall(sourceVoice, IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER, [FFIType.ptr, FFIType.ptr], [droneXBuffer.ptr!, null]);
      if (submitHr === S_OK) {
        const startHr = vcall(sourceVoice, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]);
        if (startHr === S_OK) audioReady = true;
      }
    }
  }
}

if (audioReady) {
  console.log('  Audio    : XAudio2 drone @ 60+90+122 Hz, looping infinitely on the engine thread');
} else {
  console.log('  Audio    : disabled (no XAudio2 endpoint)');
}
console.log('');

// --- ESC polling --------------------------------------------------------------

function pollInput(): void {
  if ((User32.GetAsyncKeyState(VirtualKey.VK_ESCAPE) & 0x8000) !== 0) {
    shouldExit = true;
  }
}

// --- Tick + present -----------------------------------------------------------

function tickAndPresent(): void {
  pollInput();
  if (shouldExit) {
    User32.DestroyWindow(overlayHwnd);
    return;
  }
  stepColumns();
  renderFrame();
  presentFrame();
}

// First paint before the timer fires so the overlay isn't blank.
renderFrame();
presentFrame();

const timerHandle = User32.SetTimer(overlayHwnd, TIMER_ID, FRAME_INTERVAL_MS, NULL_PTR);
if (!timerHandle) {
  console.error('SetTimer failed');
  process.exit(1);
}

// --- Cleanup hook -------------------------------------------------------------

function teardown(): void {
  if (overlayHwnd && User32.IsWindow(overlayHwnd)) {
    User32.KillTimer(overlayHwnd, TIMER_ID);
  }
  if (audioReady) {
    vcall(sourceVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
    vcall(masterVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
    vcall(engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
    audioReady = false;
  }
  if (dibBitmap) GDI32.DeleteObject(dibBitmap);
  if (memoryDC) GDI32.DeleteDC(memoryDC);
  if (screenDC) User32.ReleaseDC(NULL, screenDC);
  if (overlayHwnd && User32.IsWindow(overlayHwnd)) User32.DestroyWindow(overlayHwnd);
  User32.UnregisterClassW(className.ptr!, NULL);
  wndProc.close();
}

process.on('SIGINT', () => {
  shouldExit = true;
  teardown();
  console.log('');
  console.log('  The desktop is real again.');
  console.log('');
  Kernel32.Sleep(20);
  process.exit(0);
});

// --- Message loop -------------------------------------------------------------

// We deliberately drive frames from this loop (not the WndProc) so we can poll
// GetAsyncKeyState and update state outside of dispatcher reentrancy. The
// WM_TIMER messages still wake us up promptly inside GetMessageW.
const msgBuffer = Buffer.alloc(48);
let lastTickAt = 0;
while (!shouldExit) {
  const result = User32.GetMessageW(msgBuffer.ptr!, NULL, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(msgBuffer.ptr!);
  User32.DispatchMessageW(msgBuffer.ptr!);
  const now = Date.now();
  if (now - lastTickAt >= FRAME_INTERVAL_MS - 4) {
    lastTickAt = now;
    tickAndPresent();
  }
}

teardown();

console.log('');
console.log('  The desktop is real again.');
console.log('');

// Ensure the process exits even if a stray ref is held by the FFI cache.
Kernel32.Sleep(50);
process.exit(0);
