/**
 * Magnify Lab — Live color matrix on your entire desktop.
 *
 * Pure-FFI demo: hand a 5x5 color-transform matrix straight to the Windows
 * Magnification compositor and recolor the ENTIRE desktop in real time. A
 * small always-on-top HUD window (rendered with GDI+) shows the active preset
 * name, the live 5x5 MAGCOLOREFFECT matrix, and a keyboard hint. Number keys
 * 1-8 jump directly to a preset, LEFT/RIGHT cycle, Q or ESC quit cleanly and
 * restore the identity matrix so the screen is left exactly as it was found.
 *
 * Presets: Identity / Grayscale (Rec. 709) / Sepia / Photo Negative /
 * Protanopia / Deuteranopia / Tritanopia / Hot Take.
 *
 * MAGCOLOREFFECT is `float transform[5][5]`, row-major, 100 bytes. Each pixel
 * vector [R G B A 1] is multiplied by this matrix; row i is the contribution
 * of input channel i to each output channel (the GDI+ color-matrix convention).
 *
 * DLLs exercised: Magnification, User32, Gdiplus, Kernel32. If the full-screen
 * color path is rejected (RDP, UIPI, sandbox) the example probes the transform
 * fallback and keeps the HUD running so the matrices remain inspectable.
 *
 * Run: bun run example/magnify-lab.ts
 */

import { Gdiplus, Kernel32, Magnification, User32 } from '../index';
import { ExtendedWindowStyles, ShowWindowCommand, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { FontStyle, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { JSCallback } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';

const NULL_HANDLE = 0n;
const NULL_PTR = null as unknown as Pointer;

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_TIMER = 0x0113;
const WM_KEYDOWN = 0x0100;
const WM_PAINT = 0x000f;
const WM_ERASEBKGND = 0x0014;

const TIMER_ID = 1n;
const TICK_MS = 33;
const HUD_WIDTH = 340;
const HUD_HEIGHT = 220;

const encode = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');
const argb = (a: number, r: number, g: number, b: number): number => (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;

interface ColorPreset {
  readonly name: string;
  readonly tag: string;
  readonly accent: number;
  readonly matrix: Float32Array;
}

const matrix = (rows: number[][]): Float32Array => {
  const out = new Float32Array(25);
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) out[r * 5 + c] = rows[r]![c]!;
  return out;
};

const mkPreset = (name: string, tag: string, accent: number, rows: number[][]): ColorPreset => ({ name, tag, accent, matrix: matrix(rows) });

const PRESETS: ColorPreset[] = [
  mkPreset('Identity', 'pass-through', argb(255, 220, 220, 220),
    [[1, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]]),
  mkPreset('Grayscale', 'Rec. 709 luminance', argb(255, 240, 240, 240),
    [[0.2126, 0.2126, 0.2126, 0, 0], [0.7152, 0.7152, 0.7152, 0, 0], [0.0722, 0.0722, 0.0722, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]]),
  mkPreset('Sepia', 'warm vintage tone', argb(255, 255, 196, 96),
    [[0.393, 0.349, 0.272, 0, 0], [0.769, 0.686, 0.534, 0, 0], [0.189, 0.168, 0.131, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]]),
  mkPreset('Photo Negative', 'out = 1 - in', argb(255, 196, 96, 255),
    [[-1, 0, 0, 0, 0], [0, -1, 0, 0, 0], [0, 0, -1, 0, 0], [0, 0, 0, 1, 0], [1, 1, 1, 0, 1]]),
  mkPreset('Protanopia', 'red-blind simulation', argb(255, 240, 90, 90),
    [[0.567, 0.558, 0, 0, 0], [0.433, 0.442, 0.242, 0, 0], [0, 0, 0.758, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]]),
  mkPreset('Deuteranopia', 'green-blind simulation', argb(255, 130, 220, 110),
    [[0.625, 0.7, 0, 0, 0], [0.375, 0.3, 0.3, 0, 0], [0, 0, 0.7, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]]),
  mkPreset('Tritanopia', 'blue-blind simulation', argb(255, 110, 170, 240),
    [[0.95, 0, 0, 0, 0], [0.05, 0.433, 0.475, 0, 0], [0, 0.567, 0.525, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]]),
  mkPreset('Hot Take', 'high-contrast warm boost', argb(255, 255, 120, 60),
    [[1.3, 0.05, 0, 0, 0], [0.1, 1.05, 0, 0, 0], [0, 0.05, 0.85, 0, 0], [0, 0, 0, 1, 0], [0.05, 0, -0.05, 0, 1]]),
];

const IDENTITY_PRESET = PRESETS[0]!;

let currentIndex = 0;
let lastAppliedIndex = -1;
let fullscreenSupported = true;
let hudHwnd = NULL_HANDLE;

// Persistent 100-byte MAGCOLOREFFECT buffer; reused for every preset switch.
const colorEffectBuffer = Buffer.alloc(100);
function presetBuffer(preset: ColorPreset): Pointer {
  colorEffectBuffer.set(new Uint8Array(preset.matrix.buffer, preset.matrix.byteOffset, 100));
  return colorEffectBuffer.ptr;
}

function applyPreset(index: number): void {
  const ok = Magnification.MagSetFullscreenColorEffect(presetBuffer(PRESETS[index]!));
  if (ok) {
    lastAppliedIndex = index;
    fullscreenSupported = true;
  } else {
    fullscreenSupported = false;
  }
}

function jumpTo(index: number): void {
  if (index < 0 || index >= PRESETS.length) return;
  currentIndex = index;
  applyPreset(currentIndex);
  if (hudHwnd) User32.InvalidateRect(hudHwnd, NULL_PTR, 0);
}

function cycle(delta: number): void {
  jumpTo((currentIndex + delta + PRESETS.length) % PRESETS.length);
}

// ── GDI+ startup and persistent typography objects ────────────────────────
const gdiTokenBuffer = Buffer.alloc(8);
const gdiStartupInput = Buffer.alloc(16);
gdiStartupInput.writeUInt32LE(1, 0);
if (Gdiplus.GdiplusStartup(gdiTokenBuffer.ptr, gdiStartupInput.ptr, NULL_PTR) !== Status.Ok) {
  console.error('GdiplusStartup failed.');
  process.exit(1);
}
const gdiToken = gdiTokenBuffer.readBigUInt64LE(0);

function makeFont(family: bigint, size: number, style: FontStyle): bigint {
  const buf = Buffer.alloc(8);
  Gdiplus.GdipCreateFont(family, size, style, Unit.UnitPixel, buf.ptr);
  return buf.readBigUInt64LE(0);
}
function makeFormat(align: StringAlignment): bigint {
  const buf = Buffer.alloc(8);
  Gdiplus.GdipCreateStringFormat(0, 0, buf.ptr);
  const fmt = buf.readBigUInt64LE(0);
  Gdiplus.GdipSetStringFormatAlign(fmt, align);
  Gdiplus.GdipSetStringFormatLineAlign(fmt, StringAlignment.StringAlignmentNear);
  return fmt;
}

const fontFamilyBuffer = Buffer.alloc(8);
Gdiplus.GdipCreateFontFamilyFromName(encode('Consolas').ptr, 0n, fontFamilyBuffer.ptr);
const fontFamily = fontFamilyBuffer.readBigUInt64LE(0);
const fontTitle = makeFont(fontFamily, 18, FontStyle.FontStyleBold);
const fontSmall = makeFont(fontFamily, 11, FontStyle.FontStyleRegular);
const formatLeft = makeFormat(StringAlignment.StringAlignmentNear);
const formatRight = makeFormat(StringAlignment.StringAlignmentFar);

// Reusable scratch buffers for rectangles to avoid per-frame allocations.
const rectScratch = Buffer.alloc(16);
function setRect(x: number, y: number, w: number, h: number): Pointer {
  rectScratch.writeFloatLE(x, 0);
  rectScratch.writeFloatLE(y, 4);
  rectScratch.writeFloatLE(w, 8);
  rectScratch.writeFloatLE(h, 12);
  return rectScratch.ptr;
}

function withBrush(color: number, render: (brush: bigint) => void): void {
  const buf = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, buf.ptr);
  const brush = buf.readBigUInt64LE(0);
  render(brush);
  Gdiplus.GdipDeleteBrush(brush);
}

// ── HUD painting ──────────────────────────────────────────────────────────
function paintHud(hwnd: bigint): void {
  const clientRect = Buffer.alloc(16);
  if (!User32.GetClientRect(hwnd, clientRect.ptr)) return;
  const width = clientRect.readInt32LE(8) - clientRect.readInt32LE(0);
  const height = clientRect.readInt32LE(12) - clientRect.readInt32LE(4);
  if (width <= 0 || height <= 0) return;

  const hdc = User32.GetDC(hwnd);
  if (!hdc) return;

  const graphicsBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateFromHDC(hdc, graphicsBuffer.ptr) !== Status.Ok) {
    User32.ReleaseDC(hwnd, hdc);
    return;
  }
  const graphics = graphicsBuffer.readBigUInt64LE(0);
  Gdiplus.GdipSetSmoothingMode(graphics, SmoothingMode.SmoothingModeAntiAlias);
  Gdiplus.GdipSetTextRenderingHint(graphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit);

  const preset = PRESETS[currentIndex]!;

  Gdiplus.GdipGraphicsClear(graphics, argb(255, 16, 18, 28));

  // Accent strip at the top.
  withBrush(preset.accent, (brush) => Gdiplus.GdipFillRectangleI(graphics, brush, 0, 0, width, 4));

  // Title text.
  withBrush(argb(255, 245, 245, 250), (brush) => {
    const text = encode(`[${currentIndex + 1}/${PRESETS.length}]  ${preset.name}`);
    Gdiplus.GdipDrawString(graphics, text.ptr, -1, fontTitle, setRect(12, 12, width - 24, 24), formatLeft, brush);
  });

  // Tag (preset descriptor).
  withBrush(preset.accent, (brush) => {
    Gdiplus.GdipDrawString(graphics, encode(preset.tag).ptr, -1, fontSmall, setRect(12, 36, width - 24, 16), formatLeft, brush);
  });

  // 5x5 matrix grid.
  const gridTop = 60;
  const cellWidth = (width - 24) / 5;
  const cellHeight = 22;
  const cellColor = argb(255, 210, 215, 225);
  const zeroColor = argb(255, 88, 92, 105);

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const v = preset.matrix[row * 5 + col]!;
      const text = (v >= 0 ? ' ' : '') + v.toFixed(2);
      const color = v === 0 ? zeroColor : cellColor;
      withBrush(color, (brush) => {
        Gdiplus.GdipDrawString(graphics, encode(text).ptr, -1, fontSmall, setRect(12 + col * cellWidth, gridTop + row * cellHeight, cellWidth, cellHeight), formatRight, brush);
      });
    }
  }

  // Status line: applied / fallback.
  const statusColor = fullscreenSupported ? argb(255, 120, 220, 140) : argb(255, 240, 200, 100);
  const statusText = fullscreenSupported ? `applied to live desktop  (#${lastAppliedIndex + 1})` : 'fullscreen color path rejected — HUD only';
  withBrush(statusColor, (brush) => {
    Gdiplus.GdipDrawString(graphics, encode(statusText).ptr, -1, fontSmall, setRect(12, height - 36, width - 24, 14), formatLeft, brush);
  });

  // Keyboard hint.
  withBrush(argb(255, 150, 155, 170), (brush) => {
    Gdiplus.GdipDrawString(graphics, encode('1-8 jump   < >  cycle   Q/ESC quit').ptr, -1, fontSmall, setRect(12, height - 20, width - 24, 14), formatLeft, brush);
  });

  Gdiplus.GdipDeleteGraphics(graphics);
  User32.ReleaseDC(hwnd, hdc);
}

// ── WndProc ───────────────────────────────────────────────────────────────
const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_KEYDOWN) {
      const vk = Number(wParam);
      if (vk === VirtualKey.VK_ESCAPE || vk === 0x51 /* 'Q' */) {
        User32.DestroyWindow(hWnd);
        return 0n;
      }
      if (vk === VirtualKey.VK_LEFT) {
        cycle(-1);
        return 0n;
      }
      if (vk === VirtualKey.VK_RIGHT) {
        cycle(1);
        return 0n;
      }
      // Top-row 1..8 → 0x31..0x38.
      if (vk >= 0x31 && vk <= 0x30 + PRESETS.length) {
        jumpTo(vk - 0x31);
        return 0n;
      }
      return 0n;
    }
    if ((msg === WM_TIMER && wParam === TIMER_ID) || msg === WM_PAINT) {
      paintHud(hWnd);
      if (msg === WM_PAINT) return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
      return 0n;
    }
    if (msg === WM_ERASEBKGND) return 1n; // paint the whole client area ourselves
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

// ── Bring up Magnification ───────────────────────────────────────────────
Kernel32.SetConsoleTitleW(encode('Magnify Lab').ptr);

console.log('=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=');
console.log('     MAGNIFY LAB — recolor your desktop');
console.log('=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=');
console.log('');
console.log('Click the HUD window once to give it focus, then:');
console.log('  1-8        jump to preset');
console.log('  Left/Right cycle');
console.log('  Q or ESC   quit (identity matrix is restored)');
console.log('');

if (!Magnification.MagInitialize()) {
  console.error('MagInitialize failed — Magnification runtime unavailable.');
  process.exit(1);
}

// Probe the color-effect path; on rejection, also probe the transform fallback.
if (Magnification.MagSetFullscreenColorEffect(presetBuffer(IDENTITY_PRESET))) {
  fullscreenSupported = true;
  lastAppliedIndex = 0;
  console.log('MagSetFullscreenColorEffect: OK — live desktop recoloring is active.');
} else {
  fullscreenSupported = false;
  if (Magnification.MagSetFullscreenTransform(1.0, 0, 0)) {
    Magnification.MagSetFullscreenTransform(1.0, 0, 0);
    console.warn('MagSetFullscreenColorEffect: REJECTED. Transform fallback works but color matrices are blocked.');
    console.warn('The HUD still demonstrates each 5x5 matrix; the desktop will not recolor.');
  } else {
    console.warn('Magnification full-screen APIs are blocked in this session (RDP / UIPI / sandbox).');
    console.warn('The HUD still demonstrates each 5x5 MAGCOLOREFFECT for inspection.');
  }
}

// ── Register the HUD window class and create the window ──────────────────
const className = encode('BunMagnifyLabHud');

// WNDCLASSEXW (x64, 80 bytes): cbSize, style, wndProc, cbClsExtra, cbWndExtra,
// hInstance, hIcon, hCursor, hbrBackground, lpszMenuName, lpszClassName, hIconSm.
// Default Windows cursor is used because hCursor is left NULL.
const wndClassBuf = Buffer.alloc(80);
new DataView(wndClassBuf.buffer).setUint32(0, 80, true); // cbSize
wndClassBuf.writeBigUInt64LE(BigInt(wndProc.ptr!), 8); // lpfnWndProc
wndClassBuf.writeBigUInt64LE(BigInt(className.ptr), 64); // lpszClassName

if (!User32.RegisterClassExW(wndClassBuf.ptr)) {
  console.error('RegisterClassExW failed.');
  Magnification.MagSetFullscreenColorEffect(presetBuffer(IDENTITY_PRESET));
  Magnification.MagUninitialize();
  process.exit(1);
}

const screenWidth = User32.GetSystemMetrics(0); // SM_CXSCREEN
const hudX = Math.max(8, screenWidth - HUD_WIDTH - 24);
const hudY = 24;

hudHwnd = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_TOPMOST | ExtendedWindowStyles.WS_EX_TOOLWINDOW,
  className.ptr, encode('Magnify Lab').ptr,
  WindowStyles.WS_POPUP | WindowStyles.WS_BORDER | WindowStyles.WS_VISIBLE,
  hudX, hudY, HUD_WIDTH, HUD_HEIGHT,
  NULL_HANDLE, NULL_HANDLE, NULL_HANDLE, NULL_PTR,
);

if (!hudHwnd) {
  console.error('CreateWindowExW failed.');
  User32.UnregisterClassW(className.ptr, NULL_HANDLE);
  Magnification.MagUninitialize();
  process.exit(1);
}

User32.ShowWindow(hudHwnd, ShowWindowCommand.SW_SHOWNORMAL);
User32.SetForegroundWindow(hudHwnd);
User32.SetFocus(hudHwnd);
User32.UpdateWindow(hudHwnd);

if (!User32.SetTimer(hudHwnd, TIMER_ID, TICK_MS, NULL_PTR)) {
  console.error('SetTimer failed.');
  User32.DestroyWindow(hudHwnd);
  User32.UnregisterClassW(className.ptr, NULL_HANDLE);
  Magnification.MagUninitialize();
  process.exit(1);
}

// ── Cleanup ──────────────────────────────────────────────────────────────
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  Magnification.MagSetFullscreenColorEffect(presetBuffer(IDENTITY_PRESET));
  if (hudHwnd) User32.KillTimer(hudHwnd, TIMER_ID);
  Magnification.MagUninitialize();
  Gdiplus.GdipDeleteStringFormat(formatLeft);
  Gdiplus.GdipDeleteStringFormat(formatRight);
  Gdiplus.GdipDeleteFont(fontTitle);
  Gdiplus.GdipDeleteFont(fontSmall);
  Gdiplus.GdipDeleteFontFamily(fontFamily);
  Gdiplus.GdiplusShutdown(gdiToken);
  User32.UnregisterClassW(className.ptr, NULL_HANDLE);
  wndProc.close();
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

// ── Message loop ─────────────────────────────────────────────────────────
const msgBuffer = Buffer.alloc(48);
while (true) {
  const got = User32.GetMessageW(msgBuffer.ptr, NULL_HANDLE, 0, 0);
  if (got <= 0) break;
  User32.TranslateMessage(msgBuffer.ptr);
  User32.DispatchMessageW(msgBuffer.ptr);
}

cleanup();
console.log('Magnify Lab exited cleanly — identity matrix restored.');
