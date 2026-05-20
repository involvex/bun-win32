/**
 * Time Machine — Rewind the last 30 seconds of your screen.
 *
 * A NVIDIA ShadowPlay / Apple QuickTime-replay style instant-replay recorder,
 * built end-to-end on top of `@bun-win32/all`. A small dark status window
 * lives in the top-right of the primary monitor, captures the desktop at ~10
 * frames per second into a 30-second ring buffer, and on the global hotkey
 * (`Ctrl+Alt+R`) instantly writes the most recent 30 seconds of frames as a
 * PNG flipbook (`replay-<timestamp>/frame-NNNN.png`) plus a manifest that an
 * existing video tool such as ffmpeg can re-assemble into an MP4. Recording
 * then resumes from a clean ring.
 *
 * The pipeline is intentionally pure FFI — no native compilation, no codecs
 * besides the GDI+ PNG encoder that ships with Windows, no third-party
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
 * │  │ 32bpp top-down BGRA    │         │  + GdipSaveImageToFile   │   │
 * │  └────────────────────────┘         │    (per-frame PNG)       │   │
 * │                                     └──────────────────────────┘   │
 * │                                                 │                  │
 * │                                                 ▼                  │
 * │                                       ┌──────────────────────────┐ │
 * │                                       │ replay-<timestamp>/      │ │
 * │                                       │   frame-NNNN.png  +      │ │
 * │                                       │   manifest.txt           │ │
 * │                                       └──────────────────────────┘ │
 * │                                                                    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Cross-package usage:
 *   - User32:  RegisterClassExW, CreateWindowExW, custom WndProc via JSCallback,
 *              RegisterHotKey / UnregisterHotKey (Ctrl+Alt+R), SetTimer,
 *              GetMessageW / TranslateMessage / DispatchMessageW message pump,
 *              BeginPaint / EndPaint / InvalidateRect / FillRect,
 *              GetDC / ReleaseDC, GetDesktopWindow, GetSystemMetrics.
 *   - GDI32:   CreateCompatibleDC, CreateCompatibleBitmap, SelectObject,
 *              SetStretchBltMode, StretchBlt (downscale-blit desktop → memDC),
 *              GetDIBits (extract 32bpp BGRA scanlines into a JS Buffer),
 *              CreateFontW, CreateSolidBrush, SetTextColor, SetBkMode,
 *              ExtTextOutW, DeleteObject, DeleteDC.
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
import { PixelFormat32bppRGB, Status } from '@bun-win32/gdiplus';

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

// ─── Encoders ─────────────────────────────────────────────────────────
// We write the replay as a numbered PNG flipbook plus a manifest text file.
// PNG was chosen over animated GIF because the GDI+ GIF encoder does not
// reliably support multi-frame SaveAdd from 32bpp BGRA source data — the
// first frame writes fine, then GenericError (1) on append.  PNG, in
// contrast, ships a rock-solid single-frame encoder in `gdiplus.dll` and
// produces playable artefacts that any video tool (ffmpeg, OBS) or
// frame-by-frame viewer can consume.
const PNG_MIME = 'image/png';

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
// expected by GdipCreateBitmapFromScan0 for PixelFormat32bppRGB.
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

// ─── PNG flipbook encoding ────────────────────────────────────────────
function findEncoderClsidByMime(mime: string): Buffer {
  // Enumerate installed GDI+ image encoders and locate the one whose MIME
  // type matches.  Returns a fresh 16-byte CLSID buffer owned by the caller.
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
    const encoderMime = readWcharPointer(encodersBuf, entryOffset + MIME_PTR_OFFSET);
    if (encoderMime === mime) {
      return Buffer.from(encodersBuf.subarray(entryOffset, entryOffset + 16));
    }
  }
  throw new Error(`Encoder for "${mime}" not found in GDI+ image encoder list`);
}

function saveRingToPngFlipbook(folder: string): { framesWritten: number; totalBytes: number; folder: string } {
  const frames = snapshotFrames();
  if (frames.length === 0) throw new Error('Ring buffer is empty; nothing to save');

  // Each PNG goes into a per-replay subdirectory along with a manifest file
  // describing the capture timing.  ffmpeg can re-assemble them into MP4 via:
  //   ffmpeg -framerate 10 -i frame-%04d.png -c:v libx264 -pix_fmt yuv420p out.mp4
  const fs = require('node:fs') as typeof import('node:fs');
  fs.mkdirSync(folder, { recursive: true });

  // Start a fresh GDI+ session for the encode pass.  Saving 300 frames takes
  // a few hundred milliseconds; the JS side is paused while it runs.
  const tokenBuf = Buffer.alloc(8);
  const startupInput = Buffer.alloc(16);
  startupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
  checkGdiplus(Gdiplus.GdiplusStartup(tokenBuf.ptr, startupInput.ptr, NULL_PTR), 'GdiplusStartup');
  const gdiplusToken = tokenBuf.readBigUInt64LE(0);

  const stride = CAPTURE_WIDTH * BYTES_PER_PIXEL;
  let totalBytes = 0;

  try {
    const pngClsid = findEncoderClsidByMime(PNG_MIME);

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const imgPtr = Buffer.alloc(8);
      checkGdiplus(
        Gdiplus.GdipCreateBitmapFromScan0(
          CAPTURE_WIDTH,
          CAPTURE_HEIGHT,
          stride,
          PixelFormat32bppRGB,
          frame.pixels.ptr,
          imgPtr.ptr,
        ),
        `GdipCreateBitmapFromScan0 (frame ${i})`,
      );
      const img = imgPtr.readBigUInt64LE(0);

      try {
        const frameName = `${folder}/frame-${i.toString().padStart(4, '0')}.png`;
        const frameNameWide = encode(frameName);
        checkGdiplus(
          Gdiplus.GdipSaveImageToFile(img, frameNameWide.ptr, pngClsid.ptr, NULL_PTR),
          `GdipSaveImageToFile (frame ${i})`,
        );
        try {
          const stat = fs.statSync(frameName);
          totalBytes += stat.size;
        } catch {
          // ignore, cosmetic
        }
      } finally {
        Gdiplus.GdipDisposeImage(img);
      }
    }

    // Write a manifest listing the per-frame timing so any post-processor
    // (ffmpeg, custom video writer, etc.) can reconstruct the timeline.
    const baseMs = frames[0]!.timestampMs;
    const lines: string[] = [
      '# Time Machine replay manifest',
      `# Captured ${frames.length} frames at ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}, ${CAPTURE_FPS} fps`,
      `# Each line:  frame_index   relative_ms   filename`,
      '',
    ];
    for (let i = 0; i < frames.length; i++) {
      const rel = frames[i]!.timestampMs - baseMs;
      lines.push(`${i.toString().padStart(4, ' ')}   ${rel.toString().padStart(6, ' ')}   frame-${i.toString().padStart(4, '0')}.png`);
    }
    lines.push('');
    lines.push('# Reassemble with ffmpeg:');
    lines.push(`#   ffmpeg -framerate ${CAPTURE_FPS} -i frame-%04d.png -c:v libx264 -pix_fmt yuv420p replay.mp4`);
    fs.writeFileSync(`${folder}/manifest.txt`, lines.join('\n'));
  } finally {
    Gdiplus.GdiplusShutdown(gdiplusToken);
  }

  return { framesWritten: frames.length, totalBytes, folder };
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
        const folder = `replay-${stamp}`;

        try {
          const startMs = Date.now();
          const result = saveRingToPngFlipbook(folder);
          const elapsed = Date.now() - startMs;
          const sizeMb = (result.totalBytes / (1024 * 1024)).toFixed(1);
          lastSavedMessage = `Saved ${result.framesWritten} frames → ${folder}/  (${sizeMb} MB, ${elapsed} ms)`;
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
console.log(`  Hotkey:     Ctrl + Alt + R  →  save replay-<timestamp>/`);
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
