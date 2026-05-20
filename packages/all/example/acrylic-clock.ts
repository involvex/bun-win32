/**
 * Acrylic Clock - An iOS-quality desktop widget in TypeScript.
 *
 * A 400x400 borderless always-on-top widget that floats in the top-right
 * corner of the primary display, rendered against a Windows 11 acrylic
 * backdrop with native rounded corners. The face shows an analog clock with
 * smoothly sweeping hour, minute, and second hands - each frame samples the
 * fractional millisecond of `new Date()` so the hands glide rather than tick.
 *
 * The window is a regular WS_POPUP, but the Desktop Window Manager is
 * configured to extend the glass frame across the entire client area
 * (`DwmExtendFrameIntoClientArea` with -1 margins), apply the
 * `DWMSBT_TRANSIENTWINDOW` system backdrop (acrylic on Windows 11), and round
 * the corners via `DWMWA_WINDOW_CORNER_PREFERENCE`. Painting into the client
 * area with RGB(0,0,0) reveals the DWM backdrop blur underneath; antialiased
 * edges that fade to black therefore appear as a smooth translucency against
 * the acrylic. Immersive dark mode is enabled so the thin native border picks
 * up the system dark palette.
 *
 * Rendering runs at roughly 30 fps via SetTimer. The WM_PAINT handler reuses
 * a single 32-bpp ARGB GDI+ bitmap, redraws the face (thin outer ring, twelve
 * long ticks, forty-eight short ticks, four cardinal numerals, three hands
 * with rounded caps, a hub disc, and a hue-cycling tip on the second hand),
 * obtains an HBITMAP from the GDI+ image, and BitBlts it to the window's back
 * buffer in a single GDI call. A short glow burst fires for the first 200 ms
 * of every new second.
 *
 * The widget is draggable from anywhere on the face - WM_NCHITTEST returns
 * HTCAPTION universally so Windows handles the drag itself. Right-click
 * anywhere or press ESC to dismiss the widget.
 *
 * APIs demonstrated:
 *   - User32:  RegisterClassExW, CreateWindowExW, SetLayeredWindowAttributes,
 *              ShowWindow, SetTimer, GetMessageW, DispatchMessageW,
 *              InvalidateRect, BeginPaint, EndPaint, GetSystemMetrics,
 *              DestroyWindow, PostQuitMessage, DefWindowProcW
 *   - Dwmapi:  DwmExtendFrameIntoClientArea, DwmSetWindowAttribute
 *              (DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE,
 *               DWMWA_SYSTEMBACKDROP_TYPE)
 *   - Gdiplus: GdiplusStartup/Shutdown, GdipCreateBitmapFromScan0,
 *              GdipGetImageGraphicsContext, GdipSetSmoothingMode,
 *              GdipSetTextRenderingHint, GdipCreatePen1, GdipDrawLine,
 *              GdipDrawArc, GdipFillEllipse, GdipDrawString,
 *              GdipCreateHBITMAPFromBitmap, GdipGraphicsClear
 *   - GDI32:   CreateCompatibleDC, SelectObject, BitBlt, DeleteObject, DeleteDC
 *
 * Run: bun run example/acrylic-clock.ts
 */

import { JSCallback, type Pointer } from 'bun:ffi';
import { Dwmapi, GDI32, Gdiplus, User32 } from '../index';
import { ExtendedWindowStyles, ShowWindowCommand, SystemMetric, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { SystemBackdropType, WindowAttribute, WindowCornerPreference } from '@bun-win32/dwmapi';
import { FontStyle, LineCap, PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';

// Win32 message and flag constants the package enums do not yet cover.
const WM_DESTROY = 0x0002;
const WM_PAINT = 0x000f;
const WM_TIMER = 0x0113;
const WM_ERASEBKGND = 0x0014;
const WM_KEYDOWN = 0x0100;
const WM_RBUTTONDOWN = 0x0204;
const WM_NCRBUTTONDOWN = 0x00a4;
const WM_NCHITTEST = 0x0084;
const HTCAPTION = 2n;
const SRCCOPY = 0x00cc0020;
const LWA_ALPHA = 0x02;
const CS_OWNDC = 0x0020;

const CLOCK_SIZE = 400;
const TIMER_ID = 1n;
const FRAME_INTERVAL_MS = 33; // ~30 fps

const NULL_PTR = null as unknown as Pointer;
const encode = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');
const argb = (a: number, r: number, g: number, b: number): number =>
  (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;

function check(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} failed: ${Status[status] ?? '?'} (${status})`);
}

function hsvToRgb(hueDegrees: number, saturation: number, value: number): [number, number, number] {
  const h = ((hueDegrees % 360) + 360) % 360;
  const c = value * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = value - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// ── GDI+ setup: one persistent ARGB bitmap, Graphics, font, string format ──
Gdiplus.Preload();
const startupTokenBuffer = Buffer.alloc(8);
const startupInput = Buffer.alloc(16);
startupInput.writeUInt32LE(1, 0);
check(Gdiplus.GdiplusStartup(startupTokenBuffer.ptr, startupInput.ptr, null), 'GdiplusStartup');
const gdiplusToken = startupTokenBuffer.readBigUInt64LE(0);

const bitmapHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateBitmapFromScan0(CLOCK_SIZE, CLOCK_SIZE, 0, PixelFormat32bppARGB, null, bitmapHandleBuffer.ptr), 'GdipCreateBitmapFromScan0');
const gdipBitmap = bitmapHandleBuffer.readBigUInt64LE(0);

const graphicsHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipGetImageGraphicsContext(gdipBitmap, graphicsHandleBuffer.ptr), 'GdipGetImageGraphicsContext');
const gdipGraphics = graphicsHandleBuffer.readBigUInt64LE(0);
check(Gdiplus.GdipSetSmoothingMode(gdipGraphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
check(Gdiplus.GdipSetTextRenderingHint(gdipGraphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit), 'GdipSetTextRenderingHint');

const fontFamilyBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateFontFamilyFromName(encode('Segoe UI Light').ptr, 0n, fontFamilyBuffer.ptr), 'GdipCreateFontFamilyFromName');
const fontFamily = fontFamilyBuffer.readBigUInt64LE(0);
const fontHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateFont(fontFamily, 22.0, FontStyle.FontStyleRegular, Unit.UnitPixel, fontHandleBuffer.ptr), 'GdipCreateFont');
const numeralFont = fontHandleBuffer.readBigUInt64LE(0);
const stringFormatBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateStringFormat(0, 0, stringFormatBuffer.ptr), 'GdipCreateStringFormat');
const stringFormat = stringFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(stringFormat, StringAlignment.StringAlignmentCenter);
Gdiplus.GdipSetStringFormatLineAlign(stringFormat, StringAlignment.StringAlignmentCenter);

// Reusable layout-rect buffer for GdipDrawString (RectF: 4 floats).
const stringLayoutRect = Buffer.alloc(16);

function drawHand(angle: number, length: number, width: number, color: number): void {
  const cx = CLOCK_SIZE / 2;
  const cy = CLOCK_SIZE / 2;
  const penBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(color, width, Unit.UnitPixel, penBuffer.ptr);
  const pen = penBuffer.readBigUInt64LE(0);
  Gdiplus.GdipSetPenStartCap(pen, LineCap.LineCapRound);
  Gdiplus.GdipSetPenEndCap(pen, LineCap.LineCapRound);
  const tail = Math.min(length * 0.18, 18);
  Gdiplus.GdipDrawLine(gdipGraphics, pen, cx - Math.cos(angle) * tail, cy - Math.sin(angle) * tail, cx + Math.cos(angle) * length, cy + Math.sin(angle) * length);
  Gdiplus.GdipDeletePen(pen);
}

function fillSolid(color: number, x: number, y: number, w: number, h: number): void {
  const buf = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, buf.ptr);
  const brush = buf.readBigUInt64LE(0);
  Gdiplus.GdipFillEllipse(gdipGraphics, brush, x, y, w, h);
  Gdiplus.GdipDeleteBrush(brush);
}

function paintFrame(): void {
  // Black background = transparent through the DWM-extended frame backdrop.
  Gdiplus.GdipGraphicsClear(gdipGraphics, argb(255, 0, 0, 0));

  const now = new Date();
  const ms = now.getMilliseconds();
  const fSecond = now.getSeconds() + ms / 1000;
  const fMinute = now.getMinutes() + fSecond / 60;
  const fHour = (now.getHours() % 12) + fMinute / 60;

  const cx = CLOCK_SIZE / 2;
  const cy = CLOCK_SIZE / 2;
  const outer = CLOCK_SIZE / 2 - 16;

  // Soft halo so the face reads as a disc rather than just a ring.
  fillSolid(argb(20, 200, 220, 255), cx - outer, cy - outer, outer * 2, outer * 2);

  // Outer ring.
  const ringPenBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(argb(110, 200, 220, 255), 1.4, Unit.UnitPixel, ringPenBuffer.ptr);
  const ringPen = ringPenBuffer.readBigUInt64LE(0);
  Gdiplus.GdipDrawArc(gdipGraphics, ringPen, cx - outer, cy - outer, outer * 2, outer * 2, 0, 360);
  Gdiplus.GdipDeletePen(ringPen);

  // Tick marks: 12 long (hours), 48 short (sub-hours).
  const longPenBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(argb(190, 230, 240, 255), 2.0, Unit.UnitPixel, longPenBuffer.ptr);
  const longPen = longPenBuffer.readBigUInt64LE(0);
  Gdiplus.GdipSetPenStartCap(longPen, LineCap.LineCapRound);
  Gdiplus.GdipSetPenEndCap(longPen, LineCap.LineCapRound);

  const shortPenBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(argb(90, 200, 220, 255), 1.0, Unit.UnitPixel, shortPenBuffer.ptr);
  const shortPen = shortPenBuffer.readBigUInt64LE(0);

  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const hour = i % 5 === 0;
    const innerR = hour ? outer - 14 : outer - 6;
    const pen = hour ? longPen : shortPen;
    Gdiplus.GdipDrawLine(gdipGraphics, pen, cx + ca * innerR, cy + sa * innerR, cx + ca * (outer - 2), cy + sa * (outer - 2));
  }
  Gdiplus.GdipDeletePen(longPen);
  Gdiplus.GdipDeletePen(shortPen);

  // Cardinal numerals: 12, 3, 6, 9.
  const numeralBuf = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(argb(220, 235, 245, 255), numeralBuf.ptr);
  const numeralBrush = numeralBuf.readBigUInt64LE(0);
  const nr = outer - 36;
  for (const [text, angle] of [['12', -Math.PI / 2], ['3', 0], ['6', Math.PI / 2], ['9', Math.PI]] as const) {
    const tx = cx + Math.cos(angle) * nr;
    const ty = cy + Math.sin(angle) * nr;
    stringLayoutRect.writeFloatLE(tx - 24, 0);
    stringLayoutRect.writeFloatLE(ty - 16, 4);
    stringLayoutRect.writeFloatLE(48, 8);
    stringLayoutRect.writeFloatLE(32, 12);
    Gdiplus.GdipDrawString(gdipGraphics, encode(text).ptr, -1, numeralFont, stringLayoutRect.ptr, stringFormat, numeralBrush);
  }
  Gdiplus.GdipDeleteBrush(numeralBrush);

  // 200 ms glow pulse at the start of every new second.
  if (ms < 200) {
    const burstAlpha = Math.round((1 - ms / 200) * 140);
    const burstR = 30 + (ms / 200) * 30;
    fillSolid(argb(burstAlpha, 180, 220, 255), cx - burstR, cy - burstR, burstR * 2, burstR * 2);
  }

  // Hands.
  drawHand((fHour / 12) * Math.PI * 2 - Math.PI / 2, outer * 0.5, 5.5, argb(235, 200, 230, 255));
  drawHand((fMinute / 60) * Math.PI * 2 - Math.PI / 2, outer * 0.78, 3.8, argb(230, 220, 200, 255));

  // Second hand with hue-cycling tip.
  const secondAngle = (fSecond / 60) * Math.PI * 2 - Math.PI / 2;
  const secondLength = outer * 0.88;
  const [tr, tg, tb] = hsvToRgb((fSecond / 60) * 360, 0.55, 1.0);
  drawHand(secondAngle, secondLength, 1.6, argb(220, tr, tg, tb));

  // Bright dot on the second-hand tip.
  const tipX = cx + Math.cos(secondAngle) * secondLength;
  const tipY = cy + Math.sin(secondAngle) * secondLength;
  fillSolid(argb(255, tr, tg, tb), tipX - 5, tipY - 5, 10, 10);

  // Center hub: dim outer disc with a dark inner pip.
  fillSolid(argb(220, 220, 230, 255), cx - 7, cy - 7, 14, 14);
  fillSolid(argb(255, 30, 35, 60), cx - 3, cy - 3, 6, 6);
}

function blitToWindow(targetDC: bigint): void {
  const hbitmapBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateHBITMAPFromBitmap(gdipBitmap, hbitmapBuffer.ptr, 0);
  const hbitmap = hbitmapBuffer.readBigUInt64LE(0);
  if (!hbitmap) return;
  const memoryDC = GDI32.CreateCompatibleDC(targetDC);
  const previousBitmap = GDI32.SelectObject(memoryDC, hbitmap);
  GDI32.BitBlt(targetDC, 0, 0, CLOCK_SIZE, CLOCK_SIZE, memoryDC, 0, 0, SRCCOPY);
  GDI32.SelectObject(memoryDC, previousBitmap);
  GDI32.DeleteDC(memoryDC);
  GDI32.DeleteObject(hbitmap);
}

// ── Window procedure ─────────────────────────────────────────────────────
const windowProcedure = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    switch (msg) {
      case WM_NCHITTEST:
        return HTCAPTION; // Drag from anywhere.

      case WM_ERASEBKGND:
        return 1n; // Suppress default fill; WM_PAINT paints everything.

      case WM_TIMER:
        if (wParam === TIMER_ID) User32.InvalidateRect(hWnd, NULL_PTR, 0);
        return 0n;

      case WM_PAINT: {
        const paintStruct = Buffer.alloc(72); // PAINTSTRUCT is 72 bytes on x64.
        const targetDC = User32.BeginPaint(hWnd, paintStruct.ptr);
        if (targetDC) {
          paintFrame();
          blitToWindow(targetDC);
        }
        User32.EndPaint(hWnd, paintStruct.ptr);
        return 0n;
      }

      case WM_KEYDOWN:
        if (wParam === BigInt(VirtualKey.VK_ESCAPE)) User32.DestroyWindow(hWnd);
        return 0n;

      case WM_RBUTTONDOWN:
      case WM_NCRBUTTONDOWN:
        User32.DestroyWindow(hWnd);
        return 0n;

      case WM_DESTROY:
        User32.KillTimer(hWnd, TIMER_ID);
        User32.PostQuitMessage(0);
        return 0n;

      default:
        return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
    }
  },
  { args: ['u64', 'u32', 'u64', 'i64'], returns: 'i64' },
);

// ── Register class with NULL background brush so DWM glass shows through ──
const className = encode('BunAcrylicClock');
const windowClass = Buffer.alloc(80); // WNDCLASSEXW on x64.
const windowClassView = new DataView(windowClass.buffer);
windowClassView.setUint32(0, 80, true); // cbSize
windowClassView.setUint32(4, CS_OWNDC, true);
windowClass.writeBigUInt64LE(BigInt(windowProcedure.ptr!), 8); // lpfnWndProc
windowClassView.setInt32(16, 0, true); // cbClsExtra
windowClassView.setInt32(20, 0, true); // cbWndExtra
windowClass.writeBigUInt64LE(0n, 24); // hInstance
windowClass.writeBigUInt64LE(0n, 32); // hIcon
windowClass.writeBigUInt64LE(0n, 40); // hCursor (Windows supplies arrow by default)
windowClass.writeBigUInt64LE(0n, 48); // hbrBackground = NULL
windowClass.writeBigUInt64LE(0n, 56); // lpszMenuName
windowClass.writeBigUInt64LE(BigInt(className.ptr), 64); // lpszClassName
windowClass.writeBigUInt64LE(0n, 72); // hIconSm

const classAtom = User32.RegisterClassExW(windowClass.ptr);
if (!classAtom) {
  console.error('Failed to register window class.');
  process.exit(1);
}

// ── Anchor the widget in the top-right of the primary monitor ────────────
const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const startX = screenWidth - CLOCK_SIZE - 40;
const startY = 40;

const windowHandle = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_TOPMOST | ExtendedWindowStyles.WS_EX_TOOLWINDOW | ExtendedWindowStyles.WS_EX_LAYERED,
  className.ptr,
  encode('Acrylic Clock').ptr,
  WindowStyles.WS_POPUP,
  startX,
  startY,
  CLOCK_SIZE,
  CLOCK_SIZE,
  0n,
  0n,
  0n,
  null,
);

if (!windowHandle) {
  console.error('Failed to create window.');
  process.exit(1);
}

// Layered with full opacity - per-pixel transparency comes from the DWM blur.
User32.SetLayeredWindowAttributes(windowHandle, 0, 255, LWA_ALPHA);

// ── DWM polish: dark mode, rounded corners, acrylic backdrop, full extend ─
const dwmAttribute = Buffer.alloc(4);

dwmAttribute.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, dwmAttribute.ptr, 4);

dwmAttribute.writeInt32LE(WindowCornerPreference.DWMWCP_ROUND, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_WINDOW_CORNER_PREFERENCE, dwmAttribute.ptr, 4);

dwmAttribute.writeInt32LE(SystemBackdropType.DWMSBT_TRANSIENTWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, dwmAttribute.ptr, 4);

// MARGINS{ -1, -1, -1, -1 } extends the DWM frame across the whole client.
const margins = Buffer.alloc(16);
margins.writeInt32LE(-1, 0);
margins.writeInt32LE(-1, 4);
margins.writeInt32LE(-1, 8);
margins.writeInt32LE(-1, 12);
Dwmapi.DwmExtendFrameIntoClientArea(windowHandle, margins.ptr);

User32.ShowWindow(windowHandle, ShowWindowCommand.SW_SHOWNOACTIVATE);
User32.UpdateWindow(windowHandle);

if (!User32.SetTimer(windowHandle, TIMER_ID, FRAME_INTERVAL_MS, null)) {
  console.error('Failed to start frame timer.');
  User32.DestroyWindow(windowHandle);
  process.exit(1);
}

console.log('Acrylic Clock floating in the top-right corner.');
console.log('  - Click and drag anywhere on the face to move it.');
console.log('  - Right-click or press ESC to dismiss.');

// ── Message loop ─────────────────────────────────────────────────────────
const messageBuffer = Buffer.alloc(48);
while (true) {
  const result = User32.GetMessageW(messageBuffer.ptr, 0n, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(messageBuffer.ptr);
  User32.DispatchMessageW(messageBuffer.ptr);
}

// ── Teardown ─────────────────────────────────────────────────────────────
Gdiplus.GdipDeleteStringFormat(stringFormat);
Gdiplus.GdipDeleteFont(numeralFont);
Gdiplus.GdipDeleteFontFamily(fontFamily);
Gdiplus.GdipDeleteGraphics(gdipGraphics);
Gdiplus.GdipDisposeImage(gdipBitmap);
Gdiplus.GdiplusShutdown(gdiplusToken);
User32.UnregisterClassW(className.ptr, 0n);
windowProcedure.close();
console.log('Goodbye.');
