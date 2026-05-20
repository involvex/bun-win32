/**
 * Wallpaper Forge — Procedurally generate a beautiful wallpaper and set it as
 * your real Windows desktop background, in TypeScript, in one file.
 *
 * Your script just changed your wallpaper. Not a preview. Not a render.
 * The actual `SPI_SETDESKWALLPAPER` system call. Five presets, number-key
 * switchable, each rendered fresh at primary-monitor resolution through GDI+
 * and saved out as a PNG via the platform's image encoders. A small Mica-backed
 * status window shows the freshly-generated thumbnail and the path on disk.
 *
 * Pipeline:
 *
 *   1. Gdiplus.GdiplusStartup                              — bring up GDI+
 *   2. User32.GetSystemMetrics                             — discover primary monitor size
 *   3. GdipGetImageEncoders + walk ImageCodecInfo          — locate the PNG CLSID
 *   4. GdipCreateBitmapFromScan0 (32bpp ARGB, monitor size) — offscreen canvas
 *   5. GdipGetImageGraphicsContext                         — Graphics over the bitmap
 *   6. Render the active preset (Aurora / Voronoi / Synthwave / Particles / Waves)
 *        — gradient brushes, paths, polygons, ellipses, deterministic LCG noise
 *   7. GdipDrawString                                      — corner watermark
 *   8. GdipSaveImageToFile                                 — encode + write PNG
 *   9. User32.SystemParametersInfoW(SPI_SETDESKWALLPAPER…) — *the* desktop swap
 *  10. Render a downscaled thumbnail for the status window
 *  11. Status window: Mica/acrylic backdrop, dark mode, rounded corners,
 *        thumbnail of the current wallpaper + caption + key-help line
 *  12. Keys 1..5 swap presets and re-forge, R re-rolls the current preset,
 *        D paints a flat blue-gray "default" wallpaper so you can restore,
 *        ESC quits and leaves the desktop alone
 *
 * APIs demonstrated (User32):
 *   - RegisterClassExW / CreateWindowExW / DestroyWindow / UnregisterClassW
 *   - SystemParametersInfoW (SPI_SETDESKWALLPAPER + SPIF_UPDATEINIFILE|SENDWININICHANGE)
 *   - GetSystemMetrics (SM_CXSCREEN, SM_CYSCREEN for full-monitor canvas)
 *   - ShowWindow / UpdateWindow / SetLayeredWindowAttributes
 *   - InvalidateRect / BeginPaint / EndPaint / DefWindowProcW
 *   - GetMessageW / TranslateMessage / DispatchMessageW / PostQuitMessage
 *   - SetWindowTextW (live caption updates as you switch presets)
 *
 * APIs demonstrated (Dwmapi):
 *   - DwmExtendFrameIntoClientArea (extend the glass over the whole client area)
 *   - DwmSetWindowAttribute:
 *       DWMWA_USE_IMMERSIVE_DARK_MODE
 *       DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND
 *       DWMWA_SYSTEMBACKDROP_TYPE     = DWMSBT_TRANSIENTWINDOW (Mica/acrylic)
 *
 * APIs demonstrated (Gdiplus):
 *   - GdiplusStartup / GdiplusShutdown
 *   - GdipCreateBitmapFromScan0 (32bpp ARGB, both wallpaper and thumbnail)
 *   - GdipGetImageGraphicsContext / GdipGraphicsClear
 *   - GdipSetSmoothingMode / GdipSetTextRenderingHint
 *   - GdipCreateLineBrushFromRectWithAngle / GdipSetLineColors  (multi-stop gradient)
 *   - GdipCreateSolidFill / GdipCreatePen1 / GdipDeleteBrush / GdipDeletePen
 *   - GdipCreatePath / GdipAddPathPolygon / GdipClosePathFigure / GdipFillPath /
 *     GdipDeletePath
 *   - GdipFillRectangle / GdipFillEllipse / GdipDrawLine / GdipDrawPolygon
 *   - GdipCreateFontFamilyFromName / GdipCreateFont / GdipCreateStringFormat /
 *     GdipSetStringFormatAlign / GdipSetStringFormatLineAlign / GdipDrawString
 *   - GdipGetImageEncodersSize / GdipGetImageEncoders     (PNG CLSID lookup)
 *   - GdipSaveImageToFile                                 (PNG encode to disk)
 *   - GdipDrawImageRectI                                  (thumbnail blit)
 *   - GdipCreateHBITMAPFromBitmap                         (status-window blit path)
 *
 * APIs demonstrated (GDI32):
 *   - CreateCompatibleDC / SelectObject / BitBlt / DeleteObject / DeleteDC
 *
 * APIs demonstrated (Shcore / Kernel32):
 *   - Shcore.SetProcessDpiAwareness — render at native pixel size, not virtualized
 *   - Kernel32 referenced (Preload is touched to keep the binding warm)
 *
 * Controls:
 *   - 1   Aurora            — multi-stop vertical gradient + soft auroral ribbons
 *   - 2   Voronoi           — cellular jewel-tone tiling with thin edge contours
 *   - 3   Synthwave Grid    — sun + perspective grid receding to a violet horizon
 *   - 4   Particle Field    — thousands of glowing particles, deep navy backdrop
 *   - 5   Wavy Lines        — flowing sine ribbons in a sunset palette
 *   - R   re-roll the active preset (new seed, new wallpaper)
 *   - D   paint and apply a flat blue-gray default wallpaper (easy restore)
 *   - ESC quit, leave the wallpaper in place
 *
 * Output: %LOCALAPPDATA%\bun-win32-wallpaper.png
 *
 * Run: bun run example/wallpaper-forge.ts
 */

import { JSCallback, read, type Pointer } from 'bun:ffi';
import { join } from 'node:path';

import { Dwmapi, GDI32, Gdiplus, Kernel32, Shcore, User32 } from '../index';
import { SystemBackdropType, WindowAttribute, WindowCornerPreference } from '@bun-win32/dwmapi';
import {
  FillMode,
  FontStyle,
  PixelFormat32bppARGB,
  SmoothingMode,
  Status,
  StringAlignment,
  TextRenderingHint,
  Unit,
  WrapMode,
} from '@bun-win32/gdiplus';
import { ExtendedWindowStyles, ShowWindowCommand, SystemMetric, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { ProcessDpiAwareness } from '@bun-win32/shcore';

// ── Constants the bound enums don't yet cover ─────────────────────────────────
const WM_DESTROY = 0x0002;
const WM_PAINT = 0x000f;
const WM_ERASEBKGND = 0x0014;
const WM_KEYDOWN = 0x0100;
const WM_RBUTTONDOWN = 0x0204;
const WM_NCHITTEST = 0x0084;
const WM_CLOSE = 0x0010;
const HTCAPTION = 2n;
const SRCCOPY = 0x00cc0020;
const LWA_ALPHA = 0x02;

// SystemParametersInfo: SPI_SETDESKWALLPAPER is 0x0014, flags below force the
// change to be persisted to the user ini hive and broadcast to the shell.
const SPI_SETDESKWALLPAPER = 0x0014;
const SPIF_UPDATEINIFILE = 0x01;
const SPIF_SENDWININICHANGE = 0x02;

const STATUS_WIDTH = 540;
const STATUS_HEIGHT = 360;
const THUMBNAIL_WIDTH = 480;
const THUMBNAIL_HEIGHT = 270;
const THUMBNAIL_X = 30;
const THUMBNAIL_Y = 18;

const NULL_PTR = null as unknown as Pointer;
const encode = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');
const argb = (a: number, r: number, g: number, b: number): number =>
  (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;

function checkStatus(status: number, where: string): void {
  if (status !== Status.Ok) {
    throw new Error(`${where} failed: ${Status[status] ?? 'unknown'} (${status})`);
  }
}

/**
 * Reads a NUL-terminated UTF-16LE C string out of an arbitrary native buffer at
 * `offset`, dereferencing the wchar_t* pointer stored there. Used to read the
 * MIME-type field of the GDI+ ImageCodecInfo entries during PNG CLSID lookup.
 */
function readWideStringAtPointer(buffer: Buffer, pointerOffset: number, maxChars = 256): string {
  const pointer = read.ptr(buffer.ptr!, pointerOffset) as Pointer;
  if (!pointer) return '';
  let out = '';
  for (let i = 0; i < maxChars; i++) {
    const code = read.u16(pointer, i * 2);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

// ── Deterministic per-seed pseudorandom (LCG) ────────────────────────────────
function makeRng(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function hsvToRgb(hueDegrees: number, saturation: number, value: number): [number, number, number] {
  const h = ((hueDegrees % 360) + 360) % 360;
  const c = value * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = value - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// ── Preset registry ──────────────────────────────────────────────────────────
const PRESETS = [
  { id: 1, key: '1', name: 'Aurora' },
  { id: 2, key: '2', name: 'Voronoi' },
  { id: 3, key: '3', name: 'Synthwave Grid' },
  { id: 4, key: '4', name: 'Particle Field' },
  { id: 5, key: '5', name: 'Wavy Lines' },
] as const;

type PresetId = typeof PRESETS[number]['id'];

// ── DPI awareness so the wallpaper renders at native pixels ─────────────────
try {
  Shcore.SetProcessDpiAwareness(ProcessDpiAwareness.PROCESS_PER_MONITOR_DPI_AWARE);
} catch {
  // Already set or not available on this OS — non-fatal.
}

// Touch Kernel32 so the import isn't tree-shaken out (and to verify the binding).
void Kernel32.GetTickCount;

// ── Bring up GDI+ ────────────────────────────────────────────────────────────
Gdiplus.Preload();
const gdiplusTokenBuffer = Buffer.alloc(8);
const startupInput = Buffer.alloc(16);
startupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
checkStatus(Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr, startupInput.ptr, null), 'GdiplusStartup');
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

// ── Locate the PNG encoder CLSID once and reuse it for every save ────────────
function locatePngEncoderClsid(): Buffer {
  const numEncodersBuffer = Buffer.alloc(4);
  const totalBytesBuffer = Buffer.alloc(4);
  checkStatus(Gdiplus.GdipGetImageEncodersSize(numEncodersBuffer.ptr, totalBytesBuffer.ptr), 'GdipGetImageEncodersSize');
  const encoderCount = numEncodersBuffer.readUInt32LE(0);
  const totalBytes = totalBytesBuffer.readUInt32LE(0);
  const encoderListBuffer = Buffer.alloc(totalBytes);
  checkStatus(Gdiplus.GdipGetImageEncoders(encoderCount, totalBytes, encoderListBuffer.ptr), 'GdipGetImageEncoders');
  // ImageCodecInfo x64 layout: 16 (CLSID) + 16 (FormatID) + 5*ptr (40) + 4*dword (16) + 2*ptr (16) = 104.
  const ENTRY_SIZE = 104;
  const MIME_PTR_OFFSET = 16 + 16 + 4 * 8;
  for (let i = 0; i < encoderCount; i++) {
    const entryOffset = i * ENTRY_SIZE;
    const mime = readWideStringAtPointer(encoderListBuffer, entryOffset + MIME_PTR_OFFSET, 32);
    if (mime === 'image/png') {
      return Buffer.from(encoderListBuffer.subarray(entryOffset, entryOffset + 16));
    }
  }
  throw new Error('PNG encoder CLSID not found in installed image encoders');
}
const pngClsid = locatePngEncoderClsid();

// ── Discover primary monitor resolution ──────────────────────────────────────
const wallpaperWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN) || 1920;
const wallpaperHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN) || 1080;

// ── Output path: %LOCALAPPDATA%\bun-win32-wallpaper.png ─────────────────────
const localAppData = process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.';
const wallpaperPath = join(localAppData, 'bun-win32-wallpaper.png');

// ── Reusable thumbnail bitmap (for the status-window preview) ───────────────
const thumbnailBitmapBuffer = Buffer.alloc(8);
checkStatus(
  Gdiplus.GdipCreateBitmapFromScan0(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, 0, PixelFormat32bppARGB, null, thumbnailBitmapBuffer.ptr),
  'GdipCreateBitmapFromScan0 (thumbnail)',
);
const thumbnailBitmap = thumbnailBitmapBuffer.readBigUInt64LE(0);

const thumbnailGraphicsBuffer = Buffer.alloc(8);
checkStatus(
  Gdiplus.GdipGetImageGraphicsContext(thumbnailBitmap, thumbnailGraphicsBuffer.ptr),
  'GdipGetImageGraphicsContext (thumbnail)',
);
const thumbnailGraphics = thumbnailGraphicsBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetSmoothingMode(thumbnailGraphics, SmoothingMode.SmoothingModeAntiAlias);

// ── Font assets for the status window and the wallpaper watermark ──────────
const captionFamilyBuffer = Buffer.alloc(8);
checkStatus(
  Gdiplus.GdipCreateFontFamilyFromName(encode('Segoe UI').ptr, 0n, captionFamilyBuffer.ptr),
  'GdipCreateFontFamilyFromName (Segoe UI)',
);
const captionFamily = captionFamilyBuffer.readBigUInt64LE(0);

const captionFontBuffer = Buffer.alloc(8);
checkStatus(
  Gdiplus.GdipCreateFont(captionFamily, 14.0, FontStyle.FontStyleRegular, Unit.UnitPixel, captionFontBuffer.ptr),
  'GdipCreateFont (caption)',
);
const captionFont = captionFontBuffer.readBigUInt64LE(0);

const titleFontBuffer = Buffer.alloc(8);
checkStatus(
  Gdiplus.GdipCreateFont(captionFamily, 18.0, FontStyle.FontStyleBold, Unit.UnitPixel, titleFontBuffer.ptr),
  'GdipCreateFont (title)',
);
const titleFont = titleFontBuffer.readBigUInt64LE(0);

const watermarkFontBuffer = Buffer.alloc(8);
const watermarkFontSize = Math.max(18, Math.round(wallpaperHeight * 0.018));
checkStatus(
  Gdiplus.GdipCreateFont(captionFamily, watermarkFontSize, FontStyle.FontStyleRegular, Unit.UnitPixel, watermarkFontBuffer.ptr),
  'GdipCreateFont (watermark)',
);
const watermarkFont = watermarkFontBuffer.readBigUInt64LE(0);

const stringFormatBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipCreateStringFormat(0, 0, stringFormatBuffer.ptr), 'GdipCreateStringFormat');
const stringFormat = stringFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(stringFormat, StringAlignment.StringAlignmentNear);
Gdiplus.GdipSetStringFormatLineAlign(stringFormat, StringAlignment.StringAlignmentNear);

const farFormatBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipCreateStringFormat(0, 0, farFormatBuffer.ptr), 'GdipCreateStringFormat (far)');
const farFormat = farFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(farFormat, StringAlignment.StringAlignmentFar);
Gdiplus.GdipSetStringFormatLineAlign(farFormat, StringAlignment.StringAlignmentFar);

// ── Helpers to issue GDI+ draws against an arbitrary Graphics handle ────────
function fillRect(graphics: bigint, color: number, x: number, y: number, width: number, height: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(graphics, brush, x, y, width, height);
  Gdiplus.GdipDeleteBrush(brush);
}

function fillEllipse(graphics: bigint, color: number, cx: number, cy: number, rx: number, ry: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillEllipse(graphics, brush, cx - rx, cy - ry, rx * 2, ry * 2);
  Gdiplus.GdipDeleteBrush(brush);
}

function drawLine(graphics: bigint, color: number, width: number, x1: number, y1: number, x2: number, y2: number): void {
  const penBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(color, width, Unit.UnitPixel, penBuffer.ptr);
  const pen = penBuffer.readBigUInt64LE(0);
  Gdiplus.GdipDrawLine(graphics, pen, x1, y1, x2, y2);
  Gdiplus.GdipDeletePen(pen);
}

function fillPolygon(graphics: bigint, color: number, points: number[]): void {
  const polyBuffer = Buffer.alloc(points.length * 4);
  for (let i = 0; i < points.length; i++) polyBuffer.writeFloatLE(points[i]!, i * 4);
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillPolygon(graphics, brush, polyBuffer.ptr, points.length / 2, FillMode.FillModeAlternate);
  Gdiplus.GdipDeleteBrush(brush);
}

function fillVerticalGradient(graphics: bigint, x: number, y: number, w: number, h: number, topColor: number, bottomColor: number): void {
  const rect = Buffer.alloc(16);
  rect.writeFloatLE(x, 0);
  rect.writeFloatLE(y, 4);
  rect.writeFloatLE(w, 8);
  rect.writeFloatLE(h, 12);
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateLineBrushFromRectWithAngle(rect.ptr, topColor, bottomColor, 90.0, 1, WrapMode.WrapModeTile, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(graphics, brush, x, y, w, h);
  Gdiplus.GdipDeleteBrush(brush);
}

function drawWatermark(graphics: bigint, text: string, w: number, h: number): void {
  const layoutRect = Buffer.alloc(16);
  const marginX = Math.round(w * 0.015);
  const marginY = Math.round(h * 0.02);
  layoutRect.writeFloatLE(marginX, 0);
  layoutRect.writeFloatLE(marginY, 4);
  layoutRect.writeFloatLE(w - marginX * 2, 8);
  layoutRect.writeFloatLE(h - marginY * 2, 12);

  // Soft shadow underneath the watermark for legibility on any palette.
  const shadowBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(argb(140, 0, 0, 0), shadowBrushBuffer.ptr);
  const shadowBrush = shadowBrushBuffer.readBigUInt64LE(0);
  const shadowRect = Buffer.alloc(16);
  shadowRect.writeFloatLE(marginX + 2, 0);
  shadowRect.writeFloatLE(marginY + 2, 4);
  shadowRect.writeFloatLE(w - marginX * 2, 8);
  shadowRect.writeFloatLE(h - marginY * 2, 12);
  const textBuffer = encode(text);
  Gdiplus.GdipDrawString(graphics, textBuffer.ptr, -1, watermarkFont, shadowRect.ptr, farFormat, shadowBrush);
  Gdiplus.GdipDeleteBrush(shadowBrush);

  const textBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(argb(220, 235, 240, 255), textBrushBuffer.ptr);
  const textBrush = textBrushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipDrawString(graphics, textBuffer.ptr, -1, watermarkFont, layoutRect.ptr, farFormat, textBrush);
  Gdiplus.GdipDeleteBrush(textBrush);
}

// ── Preset renderers ────────────────────────────────────────────────────────
//
// Each renderer paints into a passed-in Graphics handle that covers `width` x
// `height` pixels. The same renderer paints both the full-resolution wallpaper
// and the status-window thumbnail (just at a different size), so every preset
// scales naturally.

function renderAurora(graphics: bigint, width: number, height: number, seed: number): void {
  // Vertical 3-stop background: navy → purple → orange.
  fillVerticalGradient(graphics, 0, 0, width, height * 0.55, argb(255, 0x0a, 0x0a, 0x2a), argb(255, 0x4a, 0x1a, 0x6e));
  fillVerticalGradient(graphics, 0, height * 0.55, width, height * 0.45, argb(255, 0x4a, 0x1a, 0x6e), argb(255, 0xff, 0x86, 0x3a));

  const rng = makeRng(seed);

  // Soft auroral ribbons: many thin overlapping curved bands of varying hue.
  const ribbonCount = 9;
  for (let i = 0; i < ribbonCount; i++) {
    const hue = 140 + i * 18 + rng() * 30;
    const [r, g, b] = hsvToRgb(hue, 0.55, 1.0);
    const alpha = 38 + Math.floor(rng() * 32);
    const amplitude = height * (0.05 + rng() * 0.08);
    const baseY = height * (0.18 + i * 0.07 + rng() * 0.03);
    const samples = 96;
    const points: number[] = [];
    points.push(0, height);
    for (let s = 0; s <= samples; s++) {
      const x = (s / samples) * width;
      const phase = (s / samples) * Math.PI * 2 * (1.5 + rng() * 0.5) + i;
      const y = baseY + Math.sin(phase) * amplitude + Math.sin(phase * 0.5) * amplitude * 0.6;
      points.push(x, y);
    }
    points.push(width, height);
    fillPolygon(graphics, argb(alpha, r, g, b), points);
  }

  // Sparse "stars" near the top.
  for (let i = 0; i < 220; i++) {
    const x = rng() * width;
    const y = rng() * height * 0.45;
    const size = 1 + rng() * 2;
    fillEllipse(graphics, argb(180 + Math.floor(rng() * 60), 255, 255, 255), x, y, size, size);
  }
}

function renderVoronoi(graphics: bigint, width: number, height: number, seed: number): void {
  // Dark backdrop, then jewel-tone Voronoi tiling rasterized via blocks for
  // performance — each block is colored by its nearest site and then thin edge
  // contours are stamped along block boundaries that change owners.
  fillRect(graphics, argb(255, 0x10, 0x12, 0x22), 0, 0, width, height);

  const rng = makeRng(seed);
  const siteCount = 28;
  const sites: Array<{ x: number; y: number; color: number }> = [];
  for (let i = 0; i < siteCount; i++) {
    const hue = (i * 360) / siteCount + rng() * 25;
    const [r, g, b] = hsvToRgb(hue, 0.6, 0.85);
    sites.push({
      x: rng() * width,
      y: rng() * height,
      color: argb(255, r, g, b),
    });
  }

  const blockSize = Math.max(12, Math.round(Math.min(width, height) / 60));
  const cols = Math.ceil(width / blockSize);
  const rows = Math.ceil(height / blockSize);
  const owners = new Int32Array(cols * rows);

  for (let row = 0; row < rows; row++) {
    const cy = row * blockSize + blockSize / 2;
    for (let col = 0; col < cols; col++) {
      const cx = col * blockSize + blockSize / 2;
      let bestIndex = 0;
      let bestDist = Infinity;
      for (let i = 0; i < sites.length; i++) {
        const dx = cx - sites[i]!.x;
        const dy = cy - sites[i]!.y;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          bestIndex = i;
        }
      }
      owners[row * cols + col] = bestIndex;
      fillRect(graphics, sites[bestIndex]!.color, col * blockSize, row * blockSize, blockSize + 1, blockSize + 1);
    }
  }

  // Edge contours: trace block boundaries where owner changes, draw a thin
  // semi-transparent line — produces a stained-glass leading effect.
  const edgeColor = argb(140, 16, 18, 30);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const me = owners[row * cols + col]!;
      if (col + 1 < cols && owners[row * cols + col + 1]! !== me) {
        const x = (col + 1) * blockSize;
        drawLine(graphics, edgeColor, 1.4, x, row * blockSize, x, (row + 1) * blockSize);
      }
      if (row + 1 < rows && owners[(row + 1) * cols + col]! !== me) {
        const y = (row + 1) * blockSize;
        drawLine(graphics, edgeColor, 1.4, col * blockSize, y, (col + 1) * blockSize, y);
      }
    }
  }
}

function renderSynthwaveGrid(graphics: bigint, width: number, height: number, seed: number): void {
  const horizonY = height * 0.55;

  // Sky: deep indigo → violet → magenta.
  fillVerticalGradient(graphics, 0, 0, width, horizonY, argb(255, 0x0a, 0x06, 0x2a), argb(255, 0xff, 0x35, 0x91));

  // Ground: dark purple → near-black.
  fillVerticalGradient(graphics, 0, horizonY, width, height - horizonY, argb(255, 0x1a, 0x05, 0x35), argb(255, 0x05, 0x02, 0x12));

  // Sun: striped disc above the horizon.
  const sunRadius = height * 0.22;
  const sunCx = width / 2;
  const sunCy = horizonY - sunRadius * 0.1;
  fillEllipse(graphics, argb(255, 0xff, 0xc6, 0x4a), sunCx, sunCy, sunRadius, sunRadius);
  fillEllipse(graphics, argb(255, 0xff, 0x6a, 0x3a), sunCx, sunCy + sunRadius * 0.55, sunRadius * 0.85, sunRadius * 0.6);
  // Sun stripes (cutting horizontal voids).
  const stripeCount = 6;
  for (let i = 0; i < stripeCount; i++) {
    const t = i / stripeCount;
    const stripeY = sunCy + sunRadius * (0.15 + t * 0.85);
    const stripeH = sunRadius * (0.05 + t * 0.04);
    fillRect(graphics, argb(255, 0x1a, 0x05, 0x35), sunCx - sunRadius, stripeY, sunRadius * 2, stripeH);
  }

  // Perspective grid receding to the vanishing point.
  const gridColor = argb(220, 0xff, 0x2e, 0xa0);
  const vanishX = width / 2;
  const vanishY = horizonY;
  const verticalLines = 32;
  for (let i = -verticalLines; i <= verticalLines; i++) {
    const xFar = vanishX + i * (width * 0.012);
    const xNear = vanishX + i * (width * 0.18);
    drawLine(graphics, gridColor, 1.4, xFar, vanishY, xNear, height);
  }
  const horizontalLines = 16;
  for (let i = 1; i <= horizontalLines; i++) {
    const t = i / horizontalLines;
    // Use a fast-then-slow ease for that classic receding feel.
    const eased = t * t;
    const y = vanishY + (height - vanishY) * eased;
    drawLine(graphics, gridColor, 1.6, 0, y, width, y);
  }

  // Distant mountain silhouette.
  const rng = makeRng(seed);
  const mountainPoints: number[] = [0, horizonY];
  const segs = 36;
  for (let s = 0; s <= segs; s++) {
    const x = (s / segs) * width;
    const y = horizonY - height * (0.04 + rng() * 0.08);
    mountainPoints.push(x, y);
  }
  mountainPoints.push(width, horizonY);
  fillPolygon(graphics, argb(220, 0x18, 0x05, 0x30), mountainPoints);

  // A few subtle stars high in the sky.
  for (let i = 0; i < 80; i++) {
    const x = rng() * width;
    const y = rng() * horizonY * 0.6;
    fillEllipse(graphics, argb(180, 255, 255, 255), x, y, 1.2, 1.2);
  }
}

function renderParticleField(graphics: bigint, width: number, height: number, seed: number): void {
  // Deep navy base.
  fillVerticalGradient(graphics, 0, 0, width, height, argb(255, 0x05, 0x07, 0x1a), argb(255, 0x12, 0x0c, 0x2c));

  const rng = makeRng(seed);
  const particleCount = Math.max(900, Math.floor((width * height) / 2200));

  // Cluster centers create local density variations.
  const clusters = 6;
  const clusterCenters: Array<{ x: number; y: number; hue: number }> = [];
  for (let i = 0; i < clusters; i++) {
    clusterCenters.push({
      x: rng() * width,
      y: rng() * height,
      hue: rng() * 360,
    });
  }

  for (let i = 0; i < particleCount; i++) {
    // Pick a cluster, then a Gaussian-ish offset from it.
    const cluster = clusterCenters[Math.floor(rng() * clusters)]!;
    const u1 = Math.max(1e-6, rng());
    const u2 = rng();
    const radius = Math.sqrt(-2 * Math.log(u1)) * (Math.min(width, height) * 0.16);
    const theta = u2 * Math.PI * 2;
    const x = cluster.x + Math.cos(theta) * radius;
    const y = cluster.y + Math.sin(theta) * radius;
    if (x < -10 || x > width + 10 || y < -10 || y > height + 10) continue;
    const [r, g, b] = hsvToRgb(cluster.hue + rng() * 60 - 30, 0.55, 1.0);
    const size = 0.6 + rng() * 2.4;
    fillEllipse(graphics, argb(60 + Math.floor(rng() * 140), r, g, b), x, y, size, size);
  }

  // A few brighter "halo" stars for focal anchors.
  for (let i = 0; i < 18; i++) {
    const cluster = clusterCenters[Math.floor(rng() * clusters)]!;
    const x = cluster.x + (rng() - 0.5) * width * 0.2;
    const y = cluster.y + (rng() - 0.5) * height * 0.2;
    const [r, g, b] = hsvToRgb(cluster.hue, 0.4, 1.0);
    for (let halo = 6; halo >= 1; halo--) {
      fillEllipse(graphics, argb(20 + halo * 8, r, g, b), x, y, halo * 1.6, halo * 1.6);
    }
    fillEllipse(graphics, argb(240, 240, 240, 255), x, y, 1.8, 1.8);
  }
}

function renderWavyLines(graphics: bigint, width: number, height: number, seed: number): void {
  // Sunset palette base.
  fillVerticalGradient(graphics, 0, 0, width, height * 0.6, argb(255, 0x2a, 0x07, 0x4a), argb(255, 0xff, 0x6e, 0x4a));
  fillVerticalGradient(graphics, 0, height * 0.6, width, height * 0.4, argb(255, 0xff, 0x6e, 0x4a), argb(255, 0xff, 0xd5, 0x8a));

  const rng = makeRng(seed);
  const ribbonCount = 38;
  const samples = 220;

  for (let i = 0; i < ribbonCount; i++) {
    const baseY = (i / ribbonCount) * height + (rng() - 0.5) * 30;
    const amplitude = 30 + rng() * (height * 0.06);
    const wavelength = width * (0.4 + rng() * 0.4);
    const phase = rng() * Math.PI * 2;
    const thickness = 6 + rng() * 18;
    const hue = 320 + i * 4 + rng() * 30;
    const [r, g, b] = hsvToRgb(hue, 0.55, 1.0);
    const alpha = 70 + Math.floor(rng() * 90);

    const topPoints: number[] = [];
    const bottomPoints: number[] = [];
    for (let s = 0; s <= samples; s++) {
      const x = (s / samples) * width;
      const wave = Math.sin((x / wavelength) * Math.PI * 2 + phase) * amplitude
        + Math.sin((x / (wavelength * 0.4)) * Math.PI * 2 + phase * 0.7) * amplitude * 0.3;
      const y = baseY + wave;
      topPoints.push(x, y - thickness / 2);
      bottomPoints.push(x, y + thickness / 2);
    }
    // Closed ribbon: top L→R, bottom R→L.
    const ribbon: number[] = [];
    for (let p = 0; p < topPoints.length; p += 2) ribbon.push(topPoints[p]!, topPoints[p + 1]!);
    for (let p = bottomPoints.length - 2; p >= 0; p -= 2) ribbon.push(bottomPoints[p]!, bottomPoints[p + 1]!);
    fillPolygon(graphics, argb(alpha, r, g, b), ribbon);
  }
}

function renderDefaultBlue(graphics: bigint, width: number, height: number): void {
  fillVerticalGradient(graphics, 0, 0, width, height, argb(255, 0x1f, 0x33, 0x55), argb(255, 0x0c, 0x1a, 0x2c));
}

function renderPreset(graphics: bigint, width: number, height: number, presetId: PresetId, seed: number): void {
  Gdiplus.GdipGraphicsClear(graphics, argb(255, 0, 0, 0));
  Gdiplus.GdipSetSmoothingMode(graphics, SmoothingMode.SmoothingModeAntiAlias);
  Gdiplus.GdipSetTextRenderingHint(graphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit);
  switch (presetId) {
    case 1: renderAurora(graphics, width, height, seed); break;
    case 2: renderVoronoi(graphics, width, height, seed); break;
    case 3: renderSynthwaveGrid(graphics, width, height, seed); break;
    case 4: renderParticleField(graphics, width, height, seed); break;
    case 5: renderWavyLines(graphics, width, height, seed); break;
  }
}

// ── Forge: produce the wallpaper PNG, refresh the thumbnail, swap the desktop ──
let currentPresetId: PresetId = 1;
let currentSeed = Math.floor(Math.random() * 1_000_000) + 1;
let currentLabel = 'Aurora';

function forgeAndApply(presetId: PresetId, seed: number, label: string, options?: { skipDesktopApply?: boolean }): void {
  currentPresetId = presetId;
  currentSeed = seed;
  currentLabel = label;

  // Build the full-resolution wallpaper bitmap.
  const bitmapHandleBuffer = Buffer.alloc(8);
  checkStatus(
    Gdiplus.GdipCreateBitmapFromScan0(wallpaperWidth, wallpaperHeight, 0, PixelFormat32bppARGB, null, bitmapHandleBuffer.ptr),
    'GdipCreateBitmapFromScan0 (wallpaper)',
  );
  const wallpaperBitmap = bitmapHandleBuffer.readBigUInt64LE(0);

  const graphicsHandleBuffer = Buffer.alloc(8);
  checkStatus(
    Gdiplus.GdipGetImageGraphicsContext(wallpaperBitmap, graphicsHandleBuffer.ptr),
    'GdipGetImageGraphicsContext (wallpaper)',
  );
  const wallpaperGraphics = graphicsHandleBuffer.readBigUInt64LE(0);

  renderPreset(wallpaperGraphics, wallpaperWidth, wallpaperHeight, presetId, seed);

  // Subtle bottom-right watermark.
  const now = new Date();
  const pad = (n: number, w = 2): string => n.toString().padStart(w, '0');
  const timestamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  drawWatermark(wallpaperGraphics, `@bun-win32 · ${label} · ${timestamp}`, wallpaperWidth, wallpaperHeight);

  // Save the PNG to disk.
  const pathBuffer = encode(wallpaperPath);
  checkStatus(Gdiplus.GdipSaveImageToFile(wallpaperBitmap, pathBuffer.ptr, pngClsid.ptr, null), 'GdipSaveImageToFile');

  // Refresh the thumbnail by re-rendering the same scene into the smaller surface.
  renderPreset(thumbnailGraphics, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, presetId, seed);
  drawWatermark(thumbnailGraphics, `${label}`, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);

  // Tear down the wallpaper-sized GDI+ objects.
  Gdiplus.GdipDeleteGraphics(wallpaperGraphics);
  Gdiplus.GdipDisposeImage(wallpaperBitmap);

  // Set as the actual Windows desktop wallpaper (the magic moment).
  if (!options?.skipDesktopApply) {
    const ok = User32.SystemParametersInfoW(
      SPI_SETDESKWALLPAPER,
      0,
      pathBuffer.ptr,
      SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE,
    );
    if (!ok) {
      console.warn(`SystemParametersInfoW(SPI_SETDESKWALLPAPER) returned 0 — wallpaper may not have applied.`);
    } else {
      console.log(`  ✓ desktop wallpaper set to ${wallpaperPath}`);
    }
  }
}

// ── Render the status window's client area via the persistent thumbnail bitmap
function paintStatusWindow(targetDC: bigint): void {
  // Build a back-buffer the size of the window and paint into it; then blit to
  // the target DC. The DWM-extended frame means anything painted as ARGB(0,0,0)
  // is treated as transparent against the Mica/acrylic.
  const backBufferBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateBitmapFromScan0(STATUS_WIDTH, STATUS_HEIGHT, 0, PixelFormat32bppARGB, null, backBufferBuffer.ptr);
  const backBuffer = backBufferBuffer.readBigUInt64LE(0);

  const backGraphicsBuffer = Buffer.alloc(8);
  Gdiplus.GdipGetImageGraphicsContext(backBuffer, backGraphicsBuffer.ptr);
  const backGraphics = backGraphicsBuffer.readBigUInt64LE(0);
  Gdiplus.GdipSetSmoothingMode(backGraphics, SmoothingMode.SmoothingModeAntiAlias);
  Gdiplus.GdipSetTextRenderingHint(backGraphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit);

  // Black = treated as transparent against the DWM Mica/acrylic backdrop.
  Gdiplus.GdipGraphicsClear(backGraphics, argb(255, 0, 0, 0));

  // Thumbnail frame: 1px subtle outline so the preview reads as a bordered card.
  const frameColor = argb(80, 235, 240, 255);
  drawLine(backGraphics, frameColor, 1, THUMBNAIL_X - 1, THUMBNAIL_Y - 1, THUMBNAIL_X + THUMBNAIL_WIDTH, THUMBNAIL_Y - 1);
  drawLine(backGraphics, frameColor, 1, THUMBNAIL_X - 1, THUMBNAIL_Y + THUMBNAIL_HEIGHT, THUMBNAIL_X + THUMBNAIL_WIDTH, THUMBNAIL_Y + THUMBNAIL_HEIGHT);
  drawLine(backGraphics, frameColor, 1, THUMBNAIL_X - 1, THUMBNAIL_Y - 1, THUMBNAIL_X - 1, THUMBNAIL_Y + THUMBNAIL_HEIGHT);
  drawLine(backGraphics, frameColor, 1, THUMBNAIL_X + THUMBNAIL_WIDTH, THUMBNAIL_Y - 1, THUMBNAIL_X + THUMBNAIL_WIDTH, THUMBNAIL_Y + THUMBNAIL_HEIGHT);

  // Blit the persistent thumbnail bitmap into the back-buffer.
  Gdiplus.GdipDrawImageRectI(backGraphics, thumbnailBitmap, THUMBNAIL_X, THUMBNAIL_Y, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);

  // Title row.
  const titleBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(argb(240, 240, 245, 255), titleBrushBuffer.ptr);
  const titleBrush = titleBrushBuffer.readBigUInt64LE(0);
  const titleRect = Buffer.alloc(16);
  titleRect.writeFloatLE(THUMBNAIL_X, 0);
  titleRect.writeFloatLE(THUMBNAIL_Y + THUMBNAIL_HEIGHT + 14, 4);
  titleRect.writeFloatLE(STATUS_WIDTH - THUMBNAIL_X * 2, 8);
  titleRect.writeFloatLE(26, 12);
  const titleText = encode(`Preset: ${currentLabel}`);
  Gdiplus.GdipDrawString(backGraphics, titleText.ptr, -1, titleFont, titleRect.ptr, stringFormat, titleBrush);
  Gdiplus.GdipDeleteBrush(titleBrush);

  // Path row.
  const pathBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(argb(200, 200, 210, 230), pathBrushBuffer.ptr);
  const pathBrush = pathBrushBuffer.readBigUInt64LE(0);
  const pathRect = Buffer.alloc(16);
  pathRect.writeFloatLE(THUMBNAIL_X, 0);
  pathRect.writeFloatLE(THUMBNAIL_Y + THUMBNAIL_HEIGHT + 38, 4);
  pathRect.writeFloatLE(STATUS_WIDTH - THUMBNAIL_X * 2, 8);
  pathRect.writeFloatLE(20, 12);
  const pathDisplay = wallpaperPath.length > 64 ? '…' + wallpaperPath.slice(-63) : wallpaperPath;
  const pathText = encode(pathDisplay);
  Gdiplus.GdipDrawString(backGraphics, pathText.ptr, -1, captionFont, pathRect.ptr, stringFormat, pathBrush);
  Gdiplus.GdipDeleteBrush(pathBrush);

  // Help row.
  const helpBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(argb(160, 180, 190, 220), helpBrushBuffer.ptr);
  const helpBrush = helpBrushBuffer.readBigUInt64LE(0);
  const helpRect = Buffer.alloc(16);
  helpRect.writeFloatLE(THUMBNAIL_X, 0);
  helpRect.writeFloatLE(THUMBNAIL_Y + THUMBNAIL_HEIGHT + 60, 4);
  helpRect.writeFloatLE(STATUS_WIDTH - THUMBNAIL_X * 2, 8);
  helpRect.writeFloatLE(20, 12);
  const helpText = encode('1 Aurora · 2 Voronoi · 3 Synthwave · 4 Particles · 5 Waves · R reroll · D restore · ESC quit');
  Gdiplus.GdipDrawString(backGraphics, helpText.ptr, -1, captionFont, helpRect.ptr, stringFormat, helpBrush);
  Gdiplus.GdipDeleteBrush(helpBrush);

  // Now move it to the target DC via an HBITMAP + BitBlt.
  const hbitmapBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateHBITMAPFromBitmap(backBuffer, hbitmapBuffer.ptr, 0);
  const hbitmap = hbitmapBuffer.readBigUInt64LE(0);

  if (hbitmap) {
    const memoryDC = GDI32.CreateCompatibleDC(targetDC);
    const previousBitmap = GDI32.SelectObject(memoryDC, hbitmap);
    GDI32.BitBlt(targetDC, 0, 0, STATUS_WIDTH, STATUS_HEIGHT, memoryDC, 0, 0, SRCCOPY);
    GDI32.SelectObject(memoryDC, previousBitmap);
    GDI32.DeleteDC(memoryDC);
    GDI32.DeleteObject(hbitmap);
  }

  Gdiplus.GdipDeleteGraphics(backGraphics);
  Gdiplus.GdipDisposeImage(backBuffer);
}

// ── Window procedure ────────────────────────────────────────────────────────
let statusHwnd = 0n;

function regenerateAndRepaint(presetId: PresetId, label: string, options?: { skipDesktopApply?: boolean }): void {
  const seed = Math.floor(Math.random() * 1_000_000) + 1;
  forgeAndApply(presetId, seed, label, options);
  if (statusHwnd) {
    User32.SetWindowTextW(statusHwnd, encode(`Wallpaper Forge — ${label}`).ptr);
    User32.InvalidateRect(statusHwnd, NULL_PTR, 0);
  }
}

const windowProcedure = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    switch (msg) {
      case WM_NCHITTEST:
        return HTCAPTION;

      case WM_ERASEBKGND:
        return 1n;

      case WM_PAINT: {
        const paintStruct = Buffer.alloc(72); // PAINTSTRUCT is 72 bytes on x64.
        const targetDC = User32.BeginPaint(hWnd, paintStruct.ptr);
        if (targetDC) paintStatusWindow(targetDC);
        User32.EndPaint(hWnd, paintStruct.ptr);
        return 0n;
      }

      case WM_KEYDOWN: {
        const vk = Number(wParam);
        if (vk === VirtualKey.VK_ESCAPE) {
          User32.DestroyWindow(hWnd);
        } else if (vk === 0x52 /* R */) {
          regenerateAndRepaint(currentPresetId, currentLabel);
        } else if (vk === 0x44 /* D */) {
          // "Restore default": paint a flat blue-gray scene and apply it. The
          // user can use this as a quick visual reset before manually picking a
          // real wallpaper from Settings.
          const bitmapHandleBuffer = Buffer.alloc(8);
          Gdiplus.GdipCreateBitmapFromScan0(wallpaperWidth, wallpaperHeight, 0, PixelFormat32bppARGB, null, bitmapHandleBuffer.ptr);
          const wallpaperBitmap = bitmapHandleBuffer.readBigUInt64LE(0);
          const graphicsHandleBuffer = Buffer.alloc(8);
          Gdiplus.GdipGetImageGraphicsContext(wallpaperBitmap, graphicsHandleBuffer.ptr);
          const wallpaperGraphics = graphicsHandleBuffer.readBigUInt64LE(0);
          renderDefaultBlue(wallpaperGraphics, wallpaperWidth, wallpaperHeight);
          drawWatermark(wallpaperGraphics, '@bun-win32 · Default', wallpaperWidth, wallpaperHeight);
          const pathBuffer = encode(wallpaperPath);
          Gdiplus.GdipSaveImageToFile(wallpaperBitmap, pathBuffer.ptr, pngClsid.ptr, null);
          Gdiplus.GdipDeleteGraphics(wallpaperGraphics);
          Gdiplus.GdipDisposeImage(wallpaperBitmap);
          User32.SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, pathBuffer.ptr, SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE);
          renderDefaultBlue(thumbnailGraphics, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
          drawWatermark(thumbnailGraphics, 'Default', THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
          currentLabel = 'Default';
          User32.SetWindowTextW(hWnd, encode(`Wallpaper Forge — Default`).ptr);
          User32.InvalidateRect(hWnd, NULL_PTR, 0);
          console.log('  ✓ default blue-gray wallpaper applied (press 1–5 to forge again)');
        } else {
          for (const preset of PRESETS) {
            if (vk === preset.key.charCodeAt(0)) {
              regenerateAndRepaint(preset.id, preset.name);
              break;
            }
          }
        }
        return 0n;
      }

      case WM_RBUTTONDOWN:
        User32.DestroyWindow(hWnd);
        return 0n;

      case WM_CLOSE:
        User32.DestroyWindow(hWnd);
        return 0n;

      case WM_DESTROY:
        User32.PostQuitMessage(0);
        return 0n;

      default:
        return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
    }
  },
  { args: ['u64', 'u32', 'u64', 'i64'], returns: 'i64' },
);

// ── Register status-window class ─────────────────────────────────────────────
const className = encode('BunWallpaperForge');
const windowClass = Buffer.alloc(80);
const windowClassView = new DataView(windowClass.buffer);
windowClassView.setUint32(0, 80, true); // cbSize
windowClassView.setUint32(4, 0x0020, true); // style = CS_OWNDC
windowClass.writeBigUInt64LE(BigInt(windowProcedure.ptr!), 8); // lpfnWndProc
windowClassView.setInt32(16, 0, true); // cbClsExtra
windowClassView.setInt32(20, 0, true); // cbWndExtra
windowClass.writeBigUInt64LE(0n, 24); // hInstance
windowClass.writeBigUInt64LE(0n, 32); // hIcon
windowClass.writeBigUInt64LE(0n, 40); // hCursor
windowClass.writeBigUInt64LE(0n, 48); // hbrBackground = NULL
windowClass.writeBigUInt64LE(0n, 56); // lpszMenuName
windowClass.writeBigUInt64LE(BigInt(className.ptr), 64); // lpszClassName
windowClass.writeBigUInt64LE(0n, 72); // hIconSm

const classAtom = User32.RegisterClassExW(windowClass.ptr);
if (!classAtom) {
  console.error('Failed to register window class.');
  process.exit(1);
}

// ── Generate the first wallpaper and apply it before showing the window ─────
console.log('');
console.log(' Wallpaper Forge');
console.log(' ───────────────');
console.log(`  monitor: ${wallpaperWidth} x ${wallpaperHeight}`);
console.log(`  output:  ${wallpaperPath}`);
console.log('');
console.log('  Generating Aurora preset…');
regenerateAndRepaint(1, 'Aurora');

// ── Create the status window: top-right, sized 540x360, Mica-backed ─────────
const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const startX = Math.max(40, screenWidth - STATUS_WIDTH - 40);
const startY = 40;

statusHwnd = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_TOPMOST | ExtendedWindowStyles.WS_EX_LAYERED,
  className.ptr,
  encode(`Wallpaper Forge — ${currentLabel}`).ptr,
  WindowStyles.WS_POPUP,
  startX,
  startY,
  STATUS_WIDTH,
  STATUS_HEIGHT,
  0n,
  0n,
  0n,
  null,
);

if (!statusHwnd) {
  console.error('Failed to create status window.');
  process.exit(1);
}

// Layered with full opacity — alpha comes from the per-pixel DWM blend.
User32.SetLayeredWindowAttributes(statusHwnd, 0, 255, LWA_ALPHA);

// DWM hints: dark mode, rounded corners, Mica/acrylic backdrop, glass extends
// across the whole client area.
const dwmTrue = Buffer.alloc(4);
dwmTrue.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(statusHwnd, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, dwmTrue.ptr, 4);

const cornerPreference = Buffer.alloc(4);
cornerPreference.writeInt32LE(WindowCornerPreference.DWMWCP_ROUND, 0);
Dwmapi.DwmSetWindowAttribute(statusHwnd, WindowAttribute.DWMWA_WINDOW_CORNER_PREFERENCE, cornerPreference.ptr, 4);

const backdropType = Buffer.alloc(4);
backdropType.writeInt32LE(SystemBackdropType.DWMSBT_TRANSIENTWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(statusHwnd, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdropType.ptr, 4);

const margins = Buffer.alloc(16);
margins.writeInt32LE(-1, 0);
margins.writeInt32LE(-1, 4);
margins.writeInt32LE(-1, 8);
margins.writeInt32LE(-1, 12);
Dwmapi.DwmExtendFrameIntoClientArea(statusHwnd, margins.ptr);

User32.ShowWindow(statusHwnd, ShowWindowCommand.SW_SHOWNORMAL);
User32.UpdateWindow(statusHwnd);

console.log('');
console.log('  Status window is up. Try the number keys:');
console.log('    1 Aurora · 2 Voronoi · 3 Synthwave Grid · 4 Particle Field · 5 Wavy Lines');
console.log('    R = re-roll the current preset · D = restore default · ESC = quit');
console.log('');

// ── Message loop ────────────────────────────────────────────────────────────
const messageBuffer = Buffer.alloc(48);
while (true) {
  const result = User32.GetMessageW(messageBuffer.ptr, 0n, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(messageBuffer.ptr);
  User32.DispatchMessageW(messageBuffer.ptr);
}

// ── Teardown ────────────────────────────────────────────────────────────────
Gdiplus.GdipDeleteStringFormat(stringFormat);
Gdiplus.GdipDeleteStringFormat(farFormat);
Gdiplus.GdipDeleteFont(watermarkFont);
Gdiplus.GdipDeleteFont(titleFont);
Gdiplus.GdipDeleteFont(captionFont);
Gdiplus.GdipDeleteFontFamily(captionFamily);
Gdiplus.GdipDeleteGraphics(thumbnailGraphics);
Gdiplus.GdipDisposeImage(thumbnailBitmap);
Gdiplus.GdiplusShutdown(gdiplusToken);
User32.UnregisterClassW(className.ptr, 0n);
windowProcedure.close();

console.log('Goodbye. Your last forged wallpaper is still set — open Settings → Personalization to switch.');
