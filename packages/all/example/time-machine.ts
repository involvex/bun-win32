/**
 * Time Machine — Rewind the last 30 seconds of your screen.
 *
 * A NVIDIA ShadowPlay / Apple QuickTime-replay style instant-replay recorder,
 * built end-to-end on top of `@bun-win32/all`. A small dark status window
 * lives in the top-right of the primary monitor, captures the desktop at ~10
 * frames per second into a 30-second ring buffer, and on the global hotkey
 * (`Ctrl+Alt+R`) instantly encodes the most recent 30 seconds of frames into
 * a viewable animated GIF named `replay-<timestamp>.gif` in the working
 * directory. Recording then resumes from a clean ring.
 *
 * The pipeline is intentionally pure FFI — no native compilation, no codecs
 * besides the GDI+ image encoders that ship with Windows, no third-party
 * dependencies. The whole loop fits in one TypeScript file.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │                                                                    │
 * │  ┌────────────────────────┐         ┌──────────────────────────┐   │
 * │  │ Capture timer (10 Hz)  │ ──────► │ Ring buffer (300 frames) │   │
 * │  └────────────────────────┘         └──────────────────────────┘   │
 * │         │                                       │                  │
 * │         │ BitBlt + StretchBlt + GetDIBits       │ On WM_HOTKEY:    │
 * │         ▼                                       ▼                  │
 * │  ┌────────────────────────┐         ┌──────────────────────────┐   │
 * │  │ HDC desktop → memDC    │         │ GdipCreateBitmapFromScan0│   │
 * │  │ 32bpp top-down BGRA    │         │  + GdipSaveAddImage loop │   │
 * │  └────────────────────────┘         └──────────────────────────┘   │
 * │                                                 │                  │
 * │                                                 ▼                  │
 * │                                       ┌──────────────────────────┐ │
 * │                                       │ replay-<timestamp>.gif   │ │
 * │                                       └──────────────────────────┘ │
 * │                                                                    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Cross-package usage:
 *   - User32:  RegisterClassExW, CreateWindowExW, custom WndProc via JSCallback,
 *              RegisterHotKey / UnregisterHotKey (Ctrl+Alt+R), SetTimer,
 *              GetMessageW / TranslateMessage / DispatchMessageW message pump,
 *              InvalidateRect for status redraw, GetDC / ReleaseDC,
 *              GetDesktopWindow, GetSystemMetrics for primary-monitor size,
 *              SetLayeredWindowAttributes for translucency.
 *   - GDI32:   CreateCompatibleDC, CreateCompatibleBitmap, SelectObject,
 *              SetStretchBltMode, StretchBlt (downscale-blit desktop → memDC),
 *              GetDIBits (extract 32bpp BGRA scanlines into a JS Buffer),
 *              CreateFontW, CreateSolidBrush, SetTextColor, SetBkMode,
 *              ExtTextOutW, FillRect, DeleteObject, DeleteDC.
 *   - Gdiplus: GdiplusStartup / GdiplusShutdown,
 *              GdipGetImageEncoders[ Size ] (locate GIF encoder by MIME),
 *              GdipCreateBitmapFromScan0 (per-frame GpBitmap from BGRA buffer),
 *              GdipSetPropertyItem (PropertyTagFrameDelay, LoopCount),
 *              GdipSaveImageToFile + GdipSaveAddImage + GdipSaveAdd
 *              (multi-frame GIF encoder sequence: MultiFrame → FrameDimensionTime
 *              repeated → Flush).
 *   - Dwmapi:  DwmSetWindowAttribute for DWMWA_USE_IMMERSIVE_DARK_MODE and
 *              DWMWA_SYSTEMBACKDROP_TYPE (Win11 acrylic transient backdrop).
 *   - Kernel32: GetModuleHandleW (for hInstance).
 *
 * Output format:
 *   Animated GIF. GIF is universally viewable (browsers, image viewers,
 *   Discord, Slack) and Windows ships the encoder in `gdiplus.dll`. The
 *   resulting file is large (~5–15 MB for 30 s at 10 fps at 640×360) but
 *   playable everywhere with no transcoding step.
 *
 * Caveats:
 *   - DRM-protected windows (Netflix, some browsers in HDCP mode) appear
 *     blacked-out in BitBlt captures. This matches the behaviour of
 *     screenshots taken via the OS print-screen path.
 *   - The capture covers the *primary* monitor only.
 *   - Encoding 300 frames blocks the UI thread briefly while the GIF is
 *     written. The status window says "Saving…" and resumes after.
 *
 * Run:
 *   cd packages/all
 *   bun run example/time-machine.ts
 *
 * Press `Ctrl+Alt+R` to save the last 30 s of screen.  Close the status
 * window (or press the X button) to exit.
 */

import { JSCallback, read, type Pointer } from 'bun:ffi';
import { Dwmapi, GDI32, Gdiplus, Kernel32, User32 } from '../index';
import { ExtendedWindowStyles, ShowWindowCommand, SystemMetric, WindowStyles } from '@bun-win32/user32';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { PixelFormat32bppARGB, Status } from '@bun-win32/gdiplus';

// ─── Win32 constants not surfaced through enum exports ────────────────
const NULL_HWND = 0n;
const NULL_PTR = null as unknown as Pointer;

const WM_DESTROY = 0x0002;
const WM_PAINT = 0x000f;
const WM_CLOSE = 0x0010;
const WM_TIMER = 0x0113;
const WM_HOTKEY = 0x0312;
const WM_KEYDOWN = 0x0100;

const TIMER_ID_CAPTURE = 1n;
const TIMER_ID_REDRAW = 2n;
const HOTKEY_ID_SAVE = 1;

const MOD_ALT = 0x0001;
const MOD_CONTROL = 0x0002;
const MOD_NOREPEAT = 0x4000;
const VK_R = 0x52;
const VK_ESCAPE = 0x1b;

const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;
const HALFTONE_STRETCH = 4;
const STOCK_DC_BRUSH = 18;
const TRANSPARENT_BKMODE = 1;

const TRUE = 1;

// ─── Capture configuration ────────────────────────────────────────────
const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 360;
const CAPTURE_FPS = 10;
const CAPTURE_INTERVAL_MS = Math.round(1000 / CAPTURE_FPS);
const REPLAY_SECONDS = 30;
const RING_CAPACITY = CAPTURE_FPS * REPLAY_SECONDS; // 300 frames
const BYTES_PER_PIXEL = 4;
const FRAME_BYTES = CAPTURE_WIDTH * CAPTURE_HEIGHT * BYTES_PER_PIXEL;

// ─── Status window configuration ──────────────────────────────────────
const STATUS_WIDTH = 480;
const STATUS_HEIGHT = 220;
const STATUS_REDRAW_INTERVAL_MS = 250;

// ─── Encoders / Property IDs ──────────────────────────────────────────
// GIF encoder CLSID: {557CF402-1A04-11D3-9A73-0000F81EF32E}
const GIF_MIME = 'image/gif';

// EncoderSaveFlag GUID: {292266FC-AC40-47BF-8CFC-A85B89A655DE}
const ENCODER_SAVE_FLAG_GUID = Buffer.from([
  0xfc, 0x66, 0x22, 0x29, 0x40, 0xac, 0xbf, 0x47, 0x8c, 0xfc, 0xa8, 0x5b, 0x89, 0xa6, 0x55, 0xde,
]);

// EncoderValue enumeration members used here
const ENCODER_VALUE_MULTI_FRAME = 18;
const ENCODER_VALUE_FLUSH = 20;
const ENCODER_VALUE_FRAME_DIMENSION_TIME = 23;

// EncoderParameterValueType.Long = 4 (per gdiplusenums.h)
const ENCODER_PARAMETER_TYPE_LONG = 4;

// PropertyItem tags
const PROPERTY_TAG_FRAME_DELAY = 0x5100; // ULONG array of 1/100 s per frame
const PROPERTY_TAG_LOOP_COUNT = 0x5101; // USHORT, 0 = infinite

// PropertyItem type codes
const PROPERTY_TAG_TYPE_LONG = 4;
const PROPERTY_TAG_TYPE_SHORT = 3;

// ─── Tiny helpers ─────────────────────────────────────────────────────
const encode = (s: string) => Buffer.from(`${s}\0`, 'utf16le');

const formatDuration = (ms: number) => {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(1, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

function checkGdiplus(status: number, where: string): void {
  if (status !== Status.Ok) {
    throw new Error(`${where} failed: ${Status[status] ?? 'Unknown'} (${status})`);
  }
}

function readWcharPointer(buffer: Buffer, pointerOffset: number, maxChars = 64): string {
  // Dereference the UTF-16LE C-string at the pointer field that lives at
  // `pointerOffset` bytes into `buffer`.  GDI+ codec metadata strings live
  // inside gdiplus.dll's mapped image and are safe to walk via `bun:ffi`
  // `read.*` helpers.
  if (!buffer.ptr) return '';
  const target = read.ptr(buffer.ptr, pointerOffset) as Pointer | null;
  if (!target) return '';
  let out = '';
  for (let i = 0; i < maxChars; i++) {
    const code = read.u16(target, i * 2);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

// ─── Status state ─────────────────────────────────────────────────────
let isCapturing = true;
let isSaving = false;
let totalFramesCaptured = 0;
let totalFramesDropped = 0;
let lastSavedMessage = '';
let spinnerIndex = 0;
const SPINNER_FRAMES = ['|', '/', '-', '\\'];

// ─── Ring buffer of captured frames ───────────────────────────────────
interface CapturedFrame {
  pixels: Buffer; // CAPTURE_WIDTH * CAPTURE_HEIGHT * 4 bytes, 32bpp BGRA top-down
  timestampMs: number;
}

const ring: (CapturedFrame | null)[] = new Array(RING_CAPACITY).fill(null);
let ringHead = 0; // index where the next frame will be written
let ringCount = 0; // number of currently-stored frames (≤ RING_CAPACITY)

function pushFrame(frame: CapturedFrame): void {
  if (ring[ringHead] !== null) totalFramesDropped++;
  ring[ringHead] = frame;
  ringHead = (ringHead + 1) % RING_CAPACITY;
  ringCount = Math.min(ringCount + 1, RING_CAPACITY);
}

function snapshotFrames(): CapturedFrame[] {
  // Return frames in chronological order (oldest first).
  const out: CapturedFrame[] = [];
  const start = ringCount < RING_CAPACITY ? 0 : ringHead;
  for (let i = 0; i < ringCount; i++) {
    const idx = (start + i) % RING_CAPACITY;
    const f = ring[idx];
    if (f) out.push(f);
  }
  return out;
}

function clearRing(): void {
  for (let i = 0; i < RING_CAPACITY; i++) ring[i] = null;
  ringHead = 0;
  ringCount = 0;
}

// ─── Capture pipeline ─────────────────────────────────────────────────
// Pre-built `BITMAPINFOHEADER` describing the 32bpp BGRA top-down DIB we
// want GetDIBits to materialize.  `biHeight` is intentionally negative so
// that the resulting scanlines are top-down — matching the orientation
// expected by GdipCreateBitmapFromScan0 for PixelFormat32bppARGB.
const bitmapInfo = Buffer.alloc(40);
bitmapInfo.writeUInt32LE(40, 0); // biSize
bitmapInfo.writeInt32LE(CAPTURE_WIDTH, 4); // biWidth
bitmapInfo.writeInt32LE(-CAPTURE_HEIGHT, 8); // biHeight (negative → top-down)
bitmapInfo.writeUInt16LE(1, 12); // biPlanes
bitmapInfo.writeUInt16LE(32, 14); // biBitCount
bitmapInfo.writeUInt32LE(BI_RGB, 16); // biCompression
bitmapInfo.writeUInt32LE(0, 20); // biSizeImage (0 ok for BI_RGB)
bitmapInfo.writeInt32LE(0, 24);
bitmapInfo.writeInt32LE(0, 28);
bitmapInfo.writeUInt32LE(0, 32);
bitmapInfo.writeUInt32LE(0, 36);

let screenWidth = 0;
let screenHeight = 0;

function captureFrame(): CapturedFrame | null {
  // Grab a screenshot of the primary monitor downscaled to CAPTURE_WIDTH ×
  // CAPTURE_HEIGHT pixels into a fresh JS Buffer.
  //
  // The flow is the classic GDI screen-grab idiom:
  //   1. GetDC(GetDesktopWindow()) → DC for the screen
  //   2. CreateCompatibleDC / CreateCompatibleBitmap → off-screen target
  //   3. SetStretchBltMode + StretchBlt to downscale
  //   4. GetDIBits → copy pixels into our Buffer
  //   5. Release everything in reverse order
  const desktopHwnd = User32.GetDesktopWindow();
  const screenDC = User32.GetDC(desktopHwnd);
  if (!screenDC) return null;

  const memDC = GDI32.CreateCompatibleDC(screenDC);
  if (!memDC) {
    User32.ReleaseDC(desktopHwnd, screenDC);
    return null;
  }

  const memBitmap = GDI32.CreateCompatibleBitmap(screenDC, CAPTURE_WIDTH, CAPTURE_HEIGHT);
  if (!memBitmap) {
    GDI32.DeleteDC(memDC);
    User32.ReleaseDC(desktopHwnd, screenDC);
    return null;
  }

  const oldBitmap = GDI32.SelectObject(memDC, memBitmap);

  GDI32.SetStretchBltMode(memDC, HALFTONE_STRETCH);
  GDI32.StretchBlt(
    memDC,
    0,
    0,
    CAPTURE_WIDTH,
    CAPTURE_HEIGHT,
    screenDC,
    0,
    0,
    screenWidth,
    screenHeight,
    SRCCOPY,
  );

  const pixels = Buffer.alloc(FRAME_BYTES);
  const scanlines = GDI32.GetDIBits(
    memDC,
    memBitmap,
    0,
    CAPTURE_HEIGHT,
    pixels.ptr,
    bitmapInfo.ptr,
    DIB_RGB_COLORS,
  );

  GDI32.SelectObject(memDC, oldBitmap);
  GDI32.DeleteObject(memBitmap);
  GDI32.DeleteDC(memDC);
  User32.ReleaseDC(desktopHwnd, screenDC);

  if (scanlines === 0) return null;

  totalFramesCaptured++;
  return { pixels, timestampMs: Date.now() };
}

// ─── Status window painting ───────────────────────────────────────────
// Pre-create a dark brush + fonts once; redraw uses them every WM_PAINT.
const BG_COLOR = 0x00100c08; // dark warm-brown (Win11 acrylic blends nicely with it)
const FG_COLOR = 0x00f0f0f0; // soft off-white
const ACCENT_COLOR = 0x004080ff; // amber-ish accent (BGR — looks orange on screen)
const DIM_COLOR = 0x00808080;

let backgroundBrush: bigint = 0n;
let titleFont: bigint = 0n;
let metricFont: bigint = 0n;
let hintFont: bigint = 0n;

function buildBrushesAndFonts(): void {
  backgroundBrush = GDI32.CreateSolidBrush(BG_COLOR);
  titleFont = GDI32.CreateFontW(
    -22, // cHeight (negative → use character height)
    0,
    0,
    0,
    700, // FW_BOLD
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    encode('Segoe UI Semibold').ptr,
  );
  metricFont = GDI32.CreateFontW(-16, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0, encode('Consolas').ptr);
  hintFont = GDI32.CreateFontW(-14, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 0, 0, encode('Segoe UI').ptr);
}

function destroyBrushesAndFonts(): void {
  if (backgroundBrush) GDI32.DeleteObject(backgroundBrush);
  if (titleFont) GDI32.DeleteObject(titleFont);
  if (metricFont) GDI32.DeleteObject(metricFont);
  if (hintFont) GDI32.DeleteObject(hintFont);
}

function drawText(hdc: bigint, font: bigint, color: number, x: number, y: number, text: string): void {
  GDI32.SelectObject(hdc, font);
  GDI32.SetTextColor(hdc, color);
  GDI32.SetBkMode(hdc, TRANSPARENT_BKMODE);
  const wide = encode(text);
  // ExtTextOutW counts UTF-16 code units, not bytes — and Buffer.from(s+'\0','utf16le')
  // appends one trailing NUL code unit we should *not* draw.
  GDI32.ExtTextOutW(hdc, x, y, 0, NULL_PTR, wide.ptr, text.length, NULL_PTR);
}

function paintStatus(hdc: bigint): void {
  // Background fill
  const rect = Buffer.alloc(16);
  rect.writeInt32LE(0, 0);
  rect.writeInt32LE(0, 4);
  rect.writeInt32LE(STATUS_WIDTH, 8);
  rect.writeInt32LE(STATUS_HEIGHT, 12);
  User32.FillRect(hdc, rect.ptr, backgroundBrush);

  // Title
  drawText(hdc, titleFont, FG_COLOR, 24, 18, 'Time Machine');

  // Status line + spinner
  if (isSaving) {
    drawText(hdc, hintFont, ACCENT_COLOR, 24, 56, '● Saving replay to disk…');
  } else if (isCapturing) {
    drawText(
      hdc,
      hintFont,
      ACCENT_COLOR,
      24,
      56,
      `${SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]}  Recording`,
    );
  } else {
    drawText(hdc, hintFont, DIM_COLOR, 24, 56, '○ Paused');
  }

  // Ring fill bar (mm:ss / 0:30)
  const fillMs = ringCount * CAPTURE_INTERVAL_MS;
  const fillStr = `${formatDuration(fillMs)} / 0:${REPLAY_SECONDS.toString().padStart(2, '0')}`;
  drawText(hdc, metricFont, FG_COLOR, 24, 88, `Ring  ${fillStr}`);

  // Progress bar background (a thin dark groove + lighter fill)
  const grooveRect = Buffer.alloc(16);
  grooveRect.writeInt32LE(24, 0);
  grooveRect.writeInt32LE(112, 4);
  grooveRect.writeInt32LE(STATUS_WIDTH - 24, 8);
  grooveRect.writeInt32LE(120, 12);
  const grooveBrush = GDI32.CreateSolidBrush(0x00302820);
  User32.FillRect(hdc, grooveRect.ptr, grooveBrush);
  GDI32.DeleteObject(grooveBrush);

  const fillFrac = ringCount / RING_CAPACITY;
  const fillRectBar = Buffer.alloc(16);
  fillRectBar.writeInt32LE(24, 0);
  fillRectBar.writeInt32LE(112, 4);
  fillRectBar.writeInt32LE(24 + Math.round((STATUS_WIDTH - 48) * fillFrac), 8);
  fillRectBar.writeInt32LE(120, 12);
  const fillBrush = GDI32.CreateSolidBrush(ACCENT_COLOR);
  User32.FillRect(hdc, fillRectBar.ptr, fillBrush);
  GDI32.DeleteObject(fillBrush);

  // Counters
  drawText(hdc, metricFont, DIM_COLOR, 24, 136, `Captured ${totalFramesCaptured}   Dropped ${totalFramesDropped}`);

  // Hint line
  drawText(hdc, hintFont, FG_COLOR, 24, 168, 'Press Ctrl + Alt + R to save the last 30 seconds.');
  if (lastSavedMessage) {
    drawText(hdc, hintFont, ACCENT_COLOR, 24, 190, lastSavedMessage);
  } else {
    drawText(hdc, hintFont, DIM_COLOR, 24, 190, 'Replay will be written to the current directory.');
  }
}

// ─── GIF encoding ─────────────────────────────────────────────────────
function findGifEncoderClsid(): Buffer {
  // Enumerate installed GDI+ image encoders, locate the one whose MIME type
  // is "image/gif", and return a fresh 16-byte CLSID buffer.
  const numEncodersBuf = Buffer.alloc(4);
  const totalBytesBuf = Buffer.alloc(4);
  checkGdiplus(
    Gdiplus.GdipGetImageEncodersSize(numEncodersBuf.ptr, totalBytesBuf.ptr),
    'GdipGetImageEncodersSize',
  );
  const numEncoders = numEncodersBuf.readUInt32LE(0);
  const totalBytes = totalBytesBuf.readUInt32LE(0);
  const encodersBuf = Buffer.alloc(totalBytes);
  checkGdiplus(
    Gdiplus.GdipGetImageEncoders(numEncoders, totalBytes, encodersBuf.ptr),
    'GdipGetImageEncoders',
  );

  // ImageCodecInfo (x64): 104 bytes per entry.
  //   0..15  CLSID, 16..31 FormatID,
  //   32..39 const WCHAR* CodecName, 40..47 DllName,
  //   48..55 FormatDescription, 56..63 FilenameExtension,
  //   64..71 MimeType, 72..75 Flags, 76..79 Version, …
  const ENTRY_SIZE = 104;
  const MIME_PTR_OFFSET = 64;
  for (let i = 0; i < numEncoders; i++) {
    const entryOffset = i * ENTRY_SIZE;
    const mime = readWcharPointer(encodersBuf, entryOffset + MIME_PTR_OFFSET);
    if (mime === GIF_MIME) {
      return Buffer.from(encodersBuf.subarray(entryOffset, entryOffset + 16));
    }
  }
  throw new Error('GIF encoder not found in GDI+ image encoder list');
}

/**
 * Build an `EncoderParameters` struct holding a single `EncoderParameter`
 * whose value is one ULONG read from the EncoderValue enumeration.  These
 * three structs drive `GdipSaveImageToFile`, `GdipSaveAddImage` and
 * `GdipSaveAdd` to switch between "first frame of a multi-frame image",
 * "next frame of the current dimension", and "flush this stream".
 *
 * Layout on x64 (per gdipluseffects.h / gdiplusimaging.h):
 *   EncoderParameters {
 *     UINT Count;                     // 4
 *     // pad 4
 *     EncoderParameter Parameters[1]; // 32 bytes each
 *   }                                 // ⇒ 40 bytes for a 1-parameter list
 *
 *   EncoderParameter {
 *     GUID  Guid;             // 16
 *     ULONG NumberOfValues;   // 4
 *     ULONG Type;             // 4
 *     VOID* Value;            // 8 (8-byte aligned)
 *   }
 *
 * The single ULONG value lives in a tiny scratch buffer that we own — the
 * caller must keep both buffers alive across the FFI call.
 */
function makeEncoderParameterLongValue(guid: Buffer, value: number): { params: Buffer; scratch: Buffer } {
  const scratch = Buffer.alloc(4);
  scratch.writeUInt32LE(value, 0);

  const params = Buffer.alloc(40);
  params.writeUInt32LE(1, 0); // Count = 1
  // pad to 8
  // Parameter[0]:
  guid.copy(params, 8, 0, 16); // Guid
  params.writeUInt32LE(1, 24); // NumberOfValues = 1
  params.writeUInt32LE(ENCODER_PARAMETER_TYPE_LONG, 28); // Type = Long (4)
  params.writeBigUInt64LE(BigInt(scratch.ptr), 32); // Value*
  return { params, scratch };
}

/**
 * Build a `PropertyItem` for `GdipSetPropertyItem`.  This is the only way
 * to attach the per-frame delay table and loop count to a GIF in GDI+ — the
 * encoder reads these properties off the *first* `GpImage` we pass to
 * `GdipSaveImageToFile` when the EncoderValueMultiFrame flag is set.
 *
 * Layout on x64 (per gdiplusimaging.h):
 *   PropertyItem {
 *     PROPID id;       // 4
 *     ULONG  length;   // 4
 *     WORD   type;     // 2
 *     // pad 6
 *     VOID*  value;    // 8
 *   }                 // ⇒ 24 bytes
 */
function makePropertyItem(
  tag: number,
  type: number,
  value: Buffer,
): { item: Buffer; valueRef: Buffer } {
  const item = Buffer.alloc(24);
  item.writeUInt32LE(tag, 0);
  item.writeUInt32LE(value.length, 4);
  item.writeUInt16LE(type, 8);
  item.writeBigUInt64LE(BigInt(value.ptr), 16);
  return { item, valueRef: value };
}

function saveRingToGif(filename: string): { framesWritten: number; bytesOnDisk: number } {
  const frames = snapshotFrames();
  if (frames.length === 0) throw new Error('Ring buffer is empty; nothing to save');

  // Start a fresh GDI+ session just for the encode pass.  Saving 300 frames
  // takes a few hundred milliseconds; the JS side is paused while it runs.
  const tokenBuf = Buffer.alloc(8);
  const startupInput = Buffer.alloc(16);
  startupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
  checkGdiplus(Gdiplus.GdiplusStartup(tokenBuf.ptr, startupInput.ptr, NULL_PTR), 'GdiplusStartup');
  const gdiplusToken = tokenBuf.readBigUInt64LE(0);

  const stride = CAPTURE_WIDTH * BYTES_PER_PIXEL;

  let firstImage = 0n;
  let createdAddImage = 0n;

  try {
    const gifClsid = findGifEncoderClsid();

    // Build the first frame's GpBitmap from its scan0 buffer.
    const firstFrame = frames[0]!;
    const firstImagePtr = Buffer.alloc(8);
    checkGdiplus(
      Gdiplus.GdipCreateBitmapFromScan0(
        CAPTURE_WIDTH,
        CAPTURE_HEIGHT,
        stride,
        PixelFormat32bppARGB,
        firstFrame.pixels.ptr,
        firstImagePtr.ptr,
      ),
      'GdipCreateBitmapFromScan0 (first frame)',
    );
    firstImage = firstImagePtr.readBigUInt64LE(0);

    // Set per-frame delay table (one ULONG per frame, in 1/100 s units).
    const delayValues = Buffer.alloc(frames.length * 4);
    const delayPerFrame = Math.round(100 / CAPTURE_FPS); // 10 hundredths = 100 ms
    for (let i = 0; i < frames.length; i++) {
      delayValues.writeUInt32LE(delayPerFrame, i * 4);
    }
    const delayItem = makePropertyItem(PROPERTY_TAG_FRAME_DELAY, PROPERTY_TAG_TYPE_LONG, delayValues);
    checkGdiplus(Gdiplus.GdipSetPropertyItem(firstImage, delayItem.item.ptr), 'GdipSetPropertyItem (FrameDelay)');
    // Keep the value buffer reachable for the duration of the encode.
    void delayItem.valueRef;

    // Set loop count = 0 (loop forever).
    const loopValues = Buffer.alloc(2);
    loopValues.writeUInt16LE(0, 0);
    const loopItem = makePropertyItem(PROPERTY_TAG_LOOP_COUNT, PROPERTY_TAG_TYPE_SHORT, loopValues);
    checkGdiplus(Gdiplus.GdipSetPropertyItem(firstImage, loopItem.item.ptr), 'GdipSetPropertyItem (LoopCount)');
    void loopItem.valueRef;

    // First frame: GdipSaveImageToFile with EncoderSaveFlag = MultiFrame.
    const multiFrameParams = makeEncoderParameterLongValue(ENCODER_SAVE_FLAG_GUID, ENCODER_VALUE_MULTI_FRAME);
    const fileNameWide = encode(filename);
    checkGdiplus(
      Gdiplus.GdipSaveImageToFile(firstImage, fileNameWide.ptr, gifClsid.ptr, multiFrameParams.params.ptr),
      'GdipSaveImageToFile (first frame, MultiFrame)',
    );
    void multiFrameParams.scratch;

    // Append each subsequent frame using GdipSaveAddImage with
    // EncoderSaveFlag = FrameDimensionTime.
    const addParams = makeEncoderParameterLongValue(ENCODER_SAVE_FLAG_GUID, ENCODER_VALUE_FRAME_DIMENSION_TIME);
    for (let i = 1; i < frames.length; i++) {
      const frame = frames[i]!;
      const nextImagePtr = Buffer.alloc(8);
      checkGdiplus(
        Gdiplus.GdipCreateBitmapFromScan0(
          CAPTURE_WIDTH,
          CAPTURE_HEIGHT,
          stride,
          PixelFormat32bppARGB,
          frame.pixels.ptr,
          nextImagePtr.ptr,
        ),
        `GdipCreateBitmapFromScan0 (frame ${i})`,
      );
      createdAddImage = nextImagePtr.readBigUInt64LE(0);
      checkGdiplus(
        Gdiplus.GdipSaveAddImage(firstImage, createdAddImage, addParams.params.ptr),
        `GdipSaveAddImage (frame ${i})`,
      );
      Gdiplus.GdipDisposeImage(createdAddImage);
      createdAddImage = 0n;
    }
    void addParams.scratch;

    // Final flush.
    const flushParams = makeEncoderParameterLongValue(ENCODER_SAVE_FLAG_GUID, ENCODER_VALUE_FLUSH);
    checkGdiplus(Gdiplus.GdipSaveAdd(firstImage, flushParams.params.ptr), 'GdipSaveAdd (Flush)');
    void flushParams.scratch;
  } finally {
    if (createdAddImage) Gdiplus.GdipDisposeImage(createdAddImage);
    if (firstImage) Gdiplus.GdipDisposeImage(firstImage);
    Gdiplus.GdiplusShutdown(gdiplusToken);
  }

  // Best-effort size lookup — purely cosmetic for the status message.
  let bytesOnDisk = 0;
  try {
    const stat = require('node:fs').statSync(filename) as { size: number };
    bytesOnDisk = stat.size;
  } catch {
    bytesOnDisk = 0;
  }

  return { framesWritten: frames.length, bytesOnDisk };
}

// ─── Window construction ──────────────────────────────────────────────
let overlayHwnd: bigint = NULL_HWND;
const className = encode('TimeMachineStatusWindow');

let wndProcCallback: JSCallback | null = null;

function createWndProc(): bigint {
  const cb = new JSCallback(
    (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
      if (msg === WM_TIMER) {
        if (wParam === TIMER_ID_CAPTURE) {
          if (isCapturing && !isSaving) {
            const frame = captureFrame();
            if (frame) pushFrame(frame);
          }
          return 0n;
        }
        if (wParam === TIMER_ID_REDRAW) {
          spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
          User32.InvalidateRect(hWnd, NULL_PTR, TRUE);
          return 0n;
        }
      }

      if (msg === WM_PAINT) {
        const paintStruct = Buffer.alloc(72); // PAINTSTRUCT (x64) = 72 bytes
        const hdc = User32.BeginPaint(hWnd, paintStruct.ptr);
        if (hdc) {
          paintStatus(hdc);
          User32.EndPaint(hWnd, paintStruct.ptr);
        }
        return 0n;
      }

      if (msg === WM_HOTKEY && Number(wParam) === HOTKEY_ID_SAVE && !isSaving) {
        isSaving = true;
        isCapturing = false;
        User32.InvalidateRect(hWnd, NULL_PTR, TRUE);

        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .replace('T', '_')
          .slice(0, 19);
        const filename = `replay-${stamp}.gif`;

        try {
          const startMs = Date.now();
          const result = saveRingToGif(filename);
          const elapsed = Date.now() - startMs;
          const sizeMb = (result.bytesOnDisk / (1024 * 1024)).toFixed(2);
          lastSavedMessage = `Saved ${result.framesWritten}f → ${filename}  (${sizeMb} MB, ${elapsed} ms)`;
          console.log(`\n  \x1b[92m✓\x1b[0m ${lastSavedMessage}`);
        } catch (err) {
          lastSavedMessage = `Save failed: ${(err as Error).message}`;
          console.error(`\n  \x1b[91m✗\x1b[0m ${lastSavedMessage}`);
        } finally {
          isSaving = false;
          isCapturing = true;
          clearRing();
          User32.InvalidateRect(hWnd, NULL_PTR, TRUE);
        }
        return 0n;
      }

      if (msg === WM_KEYDOWN && Number(wParam) === VK_ESCAPE) {
        User32.PostMessageW(hWnd, WM_CLOSE, 0n, 0n);
        return 0n;
      }

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
    {
      args: ['u64', 'u32', 'u64', 'i64'],
      returns: 'i64',
    },
  );
  wndProcCallback = cb;
  if (!cb.ptr) throw new Error('Failed to allocate WndProc callback trampoline');
  return BigInt(cb.ptr);
}

function registerStatusClass(): number {
  // WNDCLASSEXW (x64) = 80 bytes:
  //   cbSize(4) + style(4) + lpfnWndProc(8) + cbClsExtra(4) + cbWndExtra(4)
  // + hInstance(8) + hIcon(8) + hCursor(8) + hbrBackground(8) + lpszMenuName(8)
  // + lpszClassName(8) + hIconSm(8) = 80
  const wc = Buffer.alloc(80);
  const wndProcPtr = createWndProc();
  const hInstance = Kernel32.GetModuleHandleW(NULL_PTR);

  wc.writeUInt32LE(80, 0);
  wc.writeUInt32LE(0, 4); // CS_HREDRAW | CS_VREDRAW could go here, but we use InvalidateRect manually
  wc.writeBigUInt64LE(wndProcPtr, 8);
  wc.writeInt32LE(0, 16);
  wc.writeInt32LE(0, 20);
  wc.writeBigUInt64LE(hInstance, 24);
  wc.writeBigUInt64LE(0n, 32);
  wc.writeBigUInt64LE(0n, 40);
  wc.writeBigUInt64LE(0n, 48); // hbrBackground = NULL — we paint everything ourselves
  wc.writeBigUInt64LE(0n, 56);
  wc.writeBigUInt64LE(BigInt(className.ptr), 64);
  wc.writeBigUInt64LE(0n, 72);

  const atom = User32.RegisterClassExW(wc.ptr);
  if (!atom) throw new Error('RegisterClassExW failed for TimeMachineStatusWindow');
  return atom;
}

function applyDarkAcrylicBackdrop(hwnd: bigint): void {
  // Dark titlebar (Win10 2004+ / Win11).  Calling on older builds is a
  // no-op — the call returns a benign error HRESULT and the titlebar
  // stays light.
  const darkMode = Buffer.alloc(4);
  darkMode.writeUInt32LE(TRUE, 0);
  Dwmapi.DwmSetWindowAttribute(hwnd, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, darkMode.ptr, 4);

  // Acrylic / Mica system backdrop (Win11 22H2+).  When the OS honours it,
  // the DWM composites a frosted-glass background behind the window; we
  // still paint the client area with a *partially-transparent* fill to let
  // the backdrop show through.  Older OS builds simply ignore the attribute
  // and we keep the solid dark fill we paint ourselves.
  const backdrop = Buffer.alloc(4);
  backdrop.writeUInt32LE(SystemBackdropType.DWMSBT_TRANSIENTWINDOW, 0);
  Dwmapi.DwmSetWindowAttribute(hwnd, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdrop.ptr, 4);

  // Rounded corners on Win11.  DWMWA_WINDOW_CORNER_PREFERENCE = 33, value 2 = round.
  const corner = Buffer.alloc(4);
  corner.writeUInt32LE(2, 0);
  Dwmapi.DwmSetWindowAttribute(hwnd, WindowAttribute.DWMWA_WINDOW_CORNER_PREFERENCE, corner.ptr, 4);
}

function createStatusWindow(): bigint {
  registerStatusClass();
  buildBrushesAndFonts();

  // Position the window in the top-right corner of the primary monitor with
  // a 24 px margin.
  const x = screenWidth - STATUS_WIDTH - 24;
  const y = 24;

  const hwnd = User32.CreateWindowExW(
    ExtendedWindowStyles.WS_EX_TOOLWINDOW | ExtendedWindowStyles.WS_EX_TOPMOST,
    className.ptr,
    encode('Time Machine — bun-win32').ptr,
    WindowStyles.WS_POPUP | WindowStyles.WS_CAPTION | WindowStyles.WS_SYSMENU | WindowStyles.WS_VISIBLE,
    x,
    y,
    STATUS_WIDTH,
    STATUS_HEIGHT,
    NULL_HWND,
    NULL_HWND,
    Kernel32.GetModuleHandleW(NULL_PTR),
    NULL_PTR,
  );
  if (!hwnd) throw new Error('CreateWindowExW failed for status window');

  applyDarkAcrylicBackdrop(hwnd);
  User32.ShowWindow(hwnd, ShowWindowCommand.SW_SHOW);
  User32.UpdateWindow(hwnd);
  return hwnd;
}

// ─── Bootstrap ────────────────────────────────────────────────────────
console.log('=============================================');
console.log('       TIME MACHINE — bun-win32 demo');
console.log('=============================================');
console.log('');
console.log(`  Capture:    ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}  @  ${CAPTURE_FPS} fps`);
console.log(`  Ring:       ${REPLAY_SECONDS} s  (${RING_CAPACITY} frames, ~${((FRAME_BYTES * RING_CAPACITY) / (1024 * 1024)).toFixed(1)} MB)`);
console.log(`  Hotkey:     Ctrl + Alt + R  →  save replay-<timestamp>.gif`);
console.log('');

screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);

User32.Preload([
  'GetDesktopWindow',
  'GetDC',
  'ReleaseDC',
  'BeginPaint',
  'EndPaint',
  'FillRect',
  'InvalidateRect',
  'SetTimer',
  'KillTimer',
  'DefWindowProcW',
]);
GDI32.Preload([
  'BitBlt',
  'StretchBlt',
  'CreateCompatibleDC',
  'CreateCompatibleBitmap',
  'CreateDIBSection',
  'GetDIBits',
  'CreateFontW',
  'CreateSolidBrush',
  'SelectObject',
  'DeleteObject',
  'DeleteDC',
  'SetStretchBltMode',
  'SetTextColor',
  'SetBkMode',
  'ExtTextOutW',
]);

overlayHwnd = createStatusWindow();
console.log(`  Status window: hwnd=${overlayHwnd.toString(16)}`);
console.log(`  Primary monitor: ${screenWidth}x${screenHeight}`);
console.log('');

if (!User32.RegisterHotKey(overlayHwnd, HOTKEY_ID_SAVE, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_R)) {
  console.warn('  ! RegisterHotKey failed (Ctrl+Alt+R may already be claimed by another app).');
} else {
  console.log('  ✓ Ctrl+Alt+R hotkey registered.');
}

User32.SetTimer(overlayHwnd, TIMER_ID_CAPTURE, CAPTURE_INTERVAL_MS, NULL_PTR);
User32.SetTimer(overlayHwnd, TIMER_ID_REDRAW, STATUS_REDRAW_INTERVAL_MS, NULL_PTR);
console.log(`  ✓ Capture timer running every ${CAPTURE_INTERVAL_MS} ms.`);
console.log('');
console.log('  Recording… press Ctrl + Alt + R to save the last 30 seconds.');
console.log('  Close the status window to exit.');
console.log('');

// ─── Cleanup hooks ────────────────────────────────────────────────────
function cleanup(): void {
  console.log('\nShutting down Time Machine…');
  if (overlayHwnd) {
    User32.UnregisterHotKey(overlayHwnd, HOTKEY_ID_SAVE);
    User32.KillTimer(overlayHwnd, TIMER_ID_CAPTURE);
    User32.KillTimer(overlayHwnd, TIMER_ID_REDRAW);
    User32.DestroyWindow(overlayHwnd);
    overlayHwnd = NULL_HWND;
  }
  destroyBrushesAndFonts();
  User32.UnregisterClassW(className.ptr, NULL_HWND);
  if (wndProcCallback) {
    wndProcCallback.close();
    wndProcCallback = null;
  }
  console.log('Cleanup complete.');
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

// ─── Message pump ─────────────────────────────────────────────────────
const msg = Buffer.alloc(48); // MSG (x64) = 48 bytes
while (true) {
  const result = User32.GetMessageW(msg.ptr, NULL_HWND, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(msg.ptr);
  User32.DispatchMessageW(msg.ptr);
}

cleanup();
