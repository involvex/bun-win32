/**
 * HID Rainforest - Every Human Interface Device on your machine becomes a living
 * plant swaying in a TypeScript rainforest.
 *
 * Enumerates every present HID device through the SetupAPI device-interface
 * surface (the HID interface class GUID is `{4D1E55B2-F16F-11CF-88CB-001111000030}`,
 * obtained at runtime through `HidD_GetHidGuid` so we never hard-code the GUID
 * bytes). For each discovered interface, the device path is read with
 * `SetupDiGetDeviceInterfaceDetailW` (which has the famously awkward two-call
 * sizing protocol, and the variable-length `SP_DEVICE_INTERFACE_DETAIL_DATA_W`
 * struct whose `cbSize` field must be set to 8 on x64 even though the buffer is
 * larger). The path is then opened with `Kernel32.CreateFileW` using no access
 * rights at all (which is enough to query `HidD_GetAttributes`,
 * `HidD_GetProductString`, `HidD_GetManufacturerString`) so we never need admin
 * and never compete with the device's real owner.
 *
 * Each device becomes a "plant":
 *   - A vertical Bezier stem grows from the bottom edge of the window. Two
 *     control points are perturbed every frame by an additive Perlin-style
 *     sine wave (per-plant phase + amplitude) so the stems sway like grass in
 *     a soft wind. The same low-frequency wave drives the curvature.
 *   - 4 - 8 leaves are attached at randomized heights along the stem. Each leaf
 *     is rendered as a rotated ellipse pointing perpendicular to the stem
 *     tangent at its attachment point.
 *   - Color is derived from a hash of the device's Vendor ID, so every vendor
 *     gets a distinct hue (Razer green, Logitech blue, Apple grey, etc.).
 *   - A small flower (filled disc + halo) caps the top of every stem, and the
 *     product name (truncated to ~16 characters) sits at the base.
 *
 * Periodic pulse: opening a HID device for actual input reads requires
 * `GENERIC_READ` + `FILE_FLAG_OVERLAPPED` + an event-driven `ReadFile` loop and
 * frequently fails on devices the OS or another process has already claimed
 * (mice, fingerprint readers, secure-input devices, etc.) - so this demo
 * deliberately does NOT attempt live reads. Instead, every plant has a
 * deterministic pulse interval seeded from its VID*PID, and when the clock
 * crosses it the plant glows briefly. This produces a believable "the
 * rainforest is alive" feeling without any of the read-permission flakiness.
 *
 * The window itself is a borderless ~1280x720 `WS_POPUP` with the Windows 11
 * Mica system backdrop, immersive dark mode, and rounded corners. Painting
 * happens at ~30 fps: a single 32-bit ARGB GDI+ bitmap is redrawn on every
 * `WM_TIMER` tick (the timer calls `InvalidateRect`, the resulting `WM_PAINT`
 * blits the bitmap to the window DC via `GdipCreateFromHDC` +
 * `GdipDrawImageRectI`). The background fills with pure black so the DWM
 * Mica backdrop bleeds through, then plants are painted on top.
 *
 * Drag from any point on the window (WM_NCHITTEST returns HTCAPTION). Press
 * ESC or right-click to quit. SetupDiDestroyDeviceInfoList is called on
 * teardown.
 *
 * APIs demonstrated:
 *   - Setupapi: SetupDiGetClassDevsW, SetupDiEnumDeviceInterfaces,
 *               SetupDiGetDeviceInterfaceDetailW, SetupDiDestroyDeviceInfoList
 *   - Hid:      HidD_GetHidGuid, HidD_GetAttributes, HidD_GetProductString,
 *               HidD_GetManufacturerString
 *   - Kernel32: CreateFileW, CloseHandle, GetLastError
 *   - Dwmapi:   DwmSetWindowAttribute (DWMSBT_MAINWINDOW Mica backdrop, dark
 *               mode, rounded corners), DwmExtendFrameIntoClientArea
 *   - User32:   RegisterClassExW, CreateWindowExW, ShowWindow, SetTimer,
 *               KillTimer, GetMessageW, DispatchMessageW, InvalidateRect,
 *               BeginPaint, EndPaint, GetDC, ReleaseDC, GetSystemMetrics,
 *               DestroyWindow, PostQuitMessage, DefWindowProcW
 *   - Gdiplus:  GdiplusStartup/Shutdown, GdipCreateBitmapFromScan0,
 *               GdipGetImageGraphicsContext, GdipSetSmoothingMode,
 *               GdipSetTextRenderingHint, GdipGraphicsClear, GdipCreatePen1,
 *               GdipCreateSolidFill, GdipCreatePath, GdipAddPathBezier,
 *               GdipFillPath, GdipDrawPath, GdipFillEllipse, GdipDrawString,
 *               GdipCreateFontFamilyFromName, GdipCreateFont,
 *               GdipCreateStringFormat, GdipCreateFromHDC, GdipDrawImageRectI
 *
 * Run: bun run example/hid-rainforest.ts
 */

import { JSCallback, type Pointer } from 'bun:ffi';

import { Dwmapi, GDI32, Gdiplus, Hid, Kernel32, Setupapi, User32 } from '../index';
import { ExtendedWindowStyles, ShowWindowCommand, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { SystemBackdropType, WindowAttribute, WindowCornerPreference } from '@bun-win32/dwmapi';
import { FillMode, FontStyle, LineCap, PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { DIGCF, INVALID_HANDLE_VALUE } from '@bun-win32/setupapi';

// Win32 constants the package enums do not cover yet.
const WM_DESTROY = 0x0002;
const WM_PAINT = 0x000f;
const WM_TIMER = 0x0113;
const WM_ERASEBKGND = 0x0014;
const WM_KEYDOWN = 0x0100;
const WM_RBUTTONDOWN = 0x0204;
const WM_NCRBUTTONDOWN = 0x00a4;
const WM_NCHITTEST = 0x0084;
const HTCAPTION = 2n;
const CS_OWNDC = 0x0020;
const FILE_SHARE_READ = 0x0000_0001;
const FILE_SHARE_WRITE = 0x0000_0002;
const OPEN_EXISTING = 3;

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 720;
const TIMER_ID = 1n;
const FRAME_INTERVAL_MS = 33; // ~30 fps

const SP_DEVICE_INTERFACE_DATA_SIZE = 32;
const SP_DEVICE_INTERFACE_DETAIL_DATA_W_CBSIZE_X64 = 8;
const HIDD_ATTRIBUTES_SIZE = 12;
const PRODUCT_STRING_BYTES = 512;

const NULL_PTR = null as unknown as Pointer;
const encode = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');
const argb = (a: number, r: number, g: number, b: number): number => (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;

function check(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} failed: ${Status[status] ?? '?'} (${status})`);
}

function readWideString(buffer: Buffer, byteOffset: number, byteLength: number): string {
  if (byteLength <= 0) return '';
  return buffer.toString('utf16le', byteOffset, byteOffset + byteLength).replace(/\0.*$/, '').trim();
}

// HSV -> RGB ([0..360], [0..1], [0..1]) -> packed 8-bit channels.
function hsvToRgb(hueDegrees: number, saturation: number, value: number): [number, number, number] {
  const h = ((hueDegrees % 360) + 360) % 360;
  const c = value * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = value - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// ── Step 1: enumerate every HID device on the system ─────────────────────────

interface HidDevice {
  product: string;
  manufacturer: string;
  vendorId: number;
  productId: number;
  version: number;
  devicePath: string;
}

function enumerateHidDevices(): HidDevice[] {
  const guidBuffer = Buffer.alloc(16);
  Hid.HidD_GetHidGuid(guidBuffer.ptr!);

  const deviceInfoSet = Setupapi.SetupDiGetClassDevsW(guidBuffer.ptr!, null, 0n, DIGCF.PRESENT | DIGCF.DEVICEINTERFACE);
  if (deviceInfoSet === INVALID_HANDLE_VALUE) {
    throw new Error(`SetupDiGetClassDevsW failed (Win32 error ${Kernel32.GetLastError()}).`);
  }

  const discovered: HidDevice[] = [];

  try {
    for (let memberIndex = 0; ; memberIndex += 1) {
      const interfaceDataBuffer = Buffer.alloc(SP_DEVICE_INTERFACE_DATA_SIZE);
      interfaceDataBuffer.writeUInt32LE(SP_DEVICE_INTERFACE_DATA_SIZE, 0); // cbSize

      const enumerationOk = Setupapi.SetupDiEnumDeviceInterfaces(deviceInfoSet, null, guidBuffer.ptr!, memberIndex, interfaceDataBuffer.ptr!);
      if (!enumerationOk) break;

      // First call to size the variable-length detail data.
      const requiredSizeBuffer = Buffer.alloc(4);
      Setupapi.SetupDiGetDeviceInterfaceDetailW(deviceInfoSet, interfaceDataBuffer.ptr!, null, 0, requiredSizeBuffer.ptr!, null);

      const detailDataByteLength = requiredSizeBuffer.readUInt32LE(0);
      if (detailDataByteLength === 0) continue;

      const detailDataBuffer = Buffer.alloc(detailDataByteLength);
      // SP_DEVICE_INTERFACE_DETAIL_DATA_W cbSize is FIXED at 8 on x64 even
      // though the buffer itself is larger (DevicePath follows the cbSize field).
      detailDataBuffer.writeUInt32LE(SP_DEVICE_INTERFACE_DETAIL_DATA_W_CBSIZE_X64, 0);

      const detailOk = Setupapi.SetupDiGetDeviceInterfaceDetailW(deviceInfoSet, interfaceDataBuffer.ptr!, detailDataBuffer.ptr!, detailDataByteLength, null, null);
      if (!detailOk) continue;

      const devicePath = readWideString(detailDataBuffer, 4, detailDataByteLength - 4);
      if (!devicePath) continue;

      // Open the device with no access rights - HidD_* metadata queries do not
      // require GENERIC_READ; this avoids "access denied" on exclusive devices.
      const devicePathBuffer = encode(devicePath);
      const hDevice = Kernel32.CreateFileW(devicePathBuffer.ptr!, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL_PTR, OPEN_EXISTING, 0, 0n);
      if (hDevice === INVALID_HANDLE_VALUE) continue;

      try {
        const attributesBuffer = Buffer.alloc(HIDD_ATTRIBUTES_SIZE);
        attributesBuffer.writeUInt32LE(HIDD_ATTRIBUTES_SIZE, 0); // Size field
        let vendorId = 0, productId = 0, version = 0;
        if (Hid.HidD_GetAttributes(hDevice, attributesBuffer.ptr!)) {
          vendorId = attributesBuffer.readUInt16LE(4);
          productId = attributesBuffer.readUInt16LE(6);
          version = attributesBuffer.readUInt16LE(8);
        }

        const productBuffer = Buffer.alloc(PRODUCT_STRING_BYTES);
        const manufacturerBuffer = Buffer.alloc(PRODUCT_STRING_BYTES);
        const gotProduct = Hid.HidD_GetProductString(hDevice, productBuffer.ptr!, PRODUCT_STRING_BYTES);
        const gotManufacturer = Hid.HidD_GetManufacturerString(hDevice, manufacturerBuffer.ptr!, PRODUCT_STRING_BYTES);

        discovered.push({
          product: gotProduct ? readWideString(productBuffer, 0, PRODUCT_STRING_BYTES) || '(unnamed device)' : '(unnamed device)',
          manufacturer: gotManufacturer ? readWideString(manufacturerBuffer, 0, PRODUCT_STRING_BYTES) : '',
          vendorId,
          productId,
          version,
          devicePath,
        });
      } finally {
        Kernel32.CloseHandle(hDevice);
      }
    }
  } finally {
    Setupapi.SetupDiDestroyDeviceInfoList(deviceInfoSet);
  }

  return discovered;
}

// ── Step 2: turn devices into plants ─────────────────────────────────────────

interface Plant {
  product: string;
  manufacturer: string;
  vendorId: number;
  productId: number;
  baseX: number;
  baseY: number;
  stemHeight: number;
  hueDegrees: number;
  swayAmplitude: number;
  swayPhase: number;
  swayFrequency: number;
  leafCount: number;
  leafSeeds: Float32Array; // 0..1, one per leaf
  pulseIntervalMs: number;
  pulsePhaseOffsetMs: number;
}

function hashVendor(vendorId: number, productId: number): number {
  // Cheap deterministic mixing - good enough to spread VIDs across the hue wheel.
  let h = (vendorId * 2_654_435_761) ^ (productId * 40_503);
  h = (h ^ (h >>> 13)) * 1_274_126_177;
  h = h ^ (h >>> 16);
  return h >>> 0;
}

function buildPlants(devices: HidDevice[]): Plant[] {
  if (devices.length === 0) return [];

  // Sort by VID so plants from the same vendor stand together - looks like a grove.
  const sorted = devices.slice().sort((left, right) => {
    if (left.vendorId !== right.vendorId) return left.vendorId - right.vendorId;
    return left.productId - right.productId;
  });

  const plants: Plant[] = [];
  const sideMargin = 80;
  const groundY = WINDOW_HEIGHT - 70;
  const usableWidth = WINDOW_WIDTH - sideMargin * 2;

  // Avoid divide-by-zero for a single-device system.
  const spacing = sorted.length > 1 ? usableWidth / (sorted.length - 1) : 0;

  for (let plantIndex = 0; plantIndex < sorted.length; plantIndex += 1) {
    const device = sorted[plantIndex]!;
    const vendorHash = hashVendor(device.vendorId, device.productId);

    const leafCount = 4 + (vendorHash % 5); // 4..8 leaves
    const leafSeeds = new Float32Array(leafCount);
    for (let leafIndex = 0; leafIndex < leafCount; leafIndex += 1) {
      // Deterministic per-leaf attachment height (0..1, larger = higher up).
      const localHash = ((vendorHash + leafIndex * 0x9e3779b9) >>> 0) / 0xffff_ffff;
      leafSeeds[leafIndex] = 0.25 + localHash * 0.7;
    }

    const baseX = sorted.length > 1 ? sideMargin + spacing * plantIndex : WINDOW_WIDTH / 2;
    const stemHeight = 360 + ((vendorHash >>> 7) % 200); // 360 - 560 px
    const hueDegrees = (vendorHash >>> 11) % 360;

    plants.push({
      product: device.product,
      manufacturer: device.manufacturer,
      vendorId: device.vendorId,
      productId: device.productId,
      baseX,
      baseY: groundY,
      stemHeight,
      hueDegrees,
      swayAmplitude: 14 + ((vendorHash >>> 17) % 16), // 14 - 30 px lateral sway
      swayPhase: ((vendorHash >>> 3) % 360) * (Math.PI / 180),
      swayFrequency: 0.6 + ((vendorHash >>> 19) % 100) / 200, // 0.6 - 1.1 Hz
      leafCount,
      leafSeeds,
      // Pulse cadence 2 - 7 s, with a per-plant offset so they don't sync up.
      pulseIntervalMs: 2_000 + ((vendorHash >>> 5) % 5_000),
      pulsePhaseOffsetMs: ((vendorHash >>> 21) % 4_000),
    });
  }

  return plants;
}

// ── Step 3: enumerate up front, build plants ─────────────────────────────────

console.log('HID Rainforest -- enumerating Human Interface Devices...');
let devices: HidDevice[] = [];
try {
  devices = enumerateHidDevices();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`  Discovered ${devices.length} HID device(s):`);
for (const device of devices) {
  const vendorHex = device.vendorId.toString(16).padStart(4, '0').toUpperCase();
  const productHex = device.productId.toString(16).padStart(4, '0').toUpperCase();
  const owner = device.manufacturer ? device.manufacturer : '(no manufacturer)';
  console.log(`    [${vendorHex}:${productHex}]  ${device.product}  -  ${owner}`);
}
console.log('  Press ESC or right-click to quit.');

const plants = buildPlants(devices);

// ── Step 4: bring up GDI+ and allocate the offscreen ARGB bitmap ─────────────

Gdiplus.Preload();
const startupTokenBuffer = Buffer.alloc(8);
const startupInput = Buffer.alloc(16);
startupInput.writeUInt32LE(1, 0); // GdiplusVersion
check(Gdiplus.GdiplusStartup(startupTokenBuffer.ptr!, startupInput.ptr!, null), 'GdiplusStartup');
const gdiplusToken = startupTokenBuffer.readBigUInt64LE(0);

const bitmapHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateBitmapFromScan0(WINDOW_WIDTH, WINDOW_HEIGHT, 0, PixelFormat32bppARGB, null, bitmapHandleBuffer.ptr!), 'GdipCreateBitmapFromScan0');
const offscreenBitmap = bitmapHandleBuffer.readBigUInt64LE(0);

const graphicsHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipGetImageGraphicsContext(offscreenBitmap, graphicsHandleBuffer.ptr!), 'GdipGetImageGraphicsContext');
const offscreenGraphics = graphicsHandleBuffer.readBigUInt64LE(0);
check(Gdiplus.GdipSetSmoothingMode(offscreenGraphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
check(Gdiplus.GdipSetTextRenderingHint(offscreenGraphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit), 'GdipSetTextRenderingHint');

// Fonts: one for product captions (small), one for the HUD line (slightly larger).
const captionFamilyBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateFontFamilyFromName(encode('Segoe UI').ptr!, 0n, captionFamilyBuffer.ptr!), 'GdipCreateFontFamilyFromName');
const captionFamily = captionFamilyBuffer.readBigUInt64LE(0);

const captionFontBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateFont(captionFamily, 11.0, FontStyle.FontStyleRegular, Unit.UnitPixel, captionFontBuffer.ptr!), 'GdipCreateFont (caption)');
const captionFont = captionFontBuffer.readBigUInt64LE(0);

const hudFontBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateFont(captionFamily, 14.0, FontStyle.FontStyleRegular, Unit.UnitPixel, hudFontBuffer.ptr!), 'GdipCreateFont (hud)');
const hudFont = hudFontBuffer.readBigUInt64LE(0);

const centerStringFormatBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateStringFormat(0, 0, centerStringFormatBuffer.ptr!), 'GdipCreateStringFormat (center)');
const centerStringFormat = centerStringFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(centerStringFormat, StringAlignment.StringAlignmentCenter);
Gdiplus.GdipSetStringFormatLineAlign(centerStringFormat, StringAlignment.StringAlignmentCenter);

const leftStringFormatBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateStringFormat(0, 0, leftStringFormatBuffer.ptr!), 'GdipCreateStringFormat (left)');
const leftStringFormat = leftStringFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(leftStringFormat, StringAlignment.StringAlignmentNear);
Gdiplus.GdipSetStringFormatLineAlign(leftStringFormat, StringAlignment.StringAlignmentNear);

// Reusable RectF (4 floats = 16 bytes) buffer used by every GdipDrawString call.
const stringLayoutRectBuffer = Buffer.alloc(16);

function drawCenteredString(text: string, font: bigint, brush: bigint, cx: number, cy: number, halfWidth: number, halfHeight: number): void {
  stringLayoutRectBuffer.writeFloatLE(cx - halfWidth, 0);
  stringLayoutRectBuffer.writeFloatLE(cy - halfHeight, 4);
  stringLayoutRectBuffer.writeFloatLE(halfWidth * 2, 8);
  stringLayoutRectBuffer.writeFloatLE(halfHeight * 2, 12);
  Gdiplus.GdipDrawString(offscreenGraphics, encode(text).ptr!, -1, font, stringLayoutRectBuffer.ptr!, centerStringFormat, brush);
}

function drawLeftString(text: string, font: bigint, brush: bigint, x: number, y: number, width: number, height: number): void {
  stringLayoutRectBuffer.writeFloatLE(x, 0);
  stringLayoutRectBuffer.writeFloatLE(y, 4);
  stringLayoutRectBuffer.writeFloatLE(width, 8);
  stringLayoutRectBuffer.writeFloatLE(height, 12);
  Gdiplus.GdipDrawString(offscreenGraphics, encode(text).ptr!, -1, font, stringLayoutRectBuffer.ptr!, leftStringFormat, brush);
}

// ── Step 5: render one frame of the rainforest ───────────────────────────────

const startTimestampMs = performance.now();

function paintFrame(): void {
  // Clear to pure black so Mica bleeds through the DWM-extended frame.
  Gdiplus.GdipGraphicsClear(offscreenGraphics, argb(255, 0, 0, 0));

  const elapsedMs = performance.now() - startTimestampMs;
  const elapsedSeconds = elapsedMs / 1000;

  if (plants.length === 0) {
    // Empty-system fallback: there is at least always a keyboard normally, but
    // some sandboxed environments (CI, hyper-locked-down boxes) may surface none.
    const emptyBrushBuffer = Buffer.alloc(8);
    Gdiplus.GdipCreateSolidFill(argb(220, 200, 220, 255), emptyBrushBuffer.ptr!);
    const emptyBrush = emptyBrushBuffer.readBigUInt64LE(0);
    drawCenteredString('No HID devices found on this system. The rainforest is empty.', hudFont, emptyBrush, WINDOW_WIDTH / 2, WINDOW_HEIGHT / 2, WINDOW_WIDTH / 2 - 40, 40);
    Gdiplus.GdipDeleteBrush(emptyBrush);
    return;
  }

  // ── Sky-floor gradient suggestion: a thin band of muted glow at ground level.
  const groundY = plants[0]!.baseY;
  const groundRect = Buffer.alloc(16);
  groundRect.writeFloatLE(0, 0);
  groundRect.writeFloatLE(groundY - 60, 4);
  groundRect.writeFloatLE(WINDOW_WIDTH, 8);
  groundRect.writeFloatLE(WINDOW_HEIGHT - (groundY - 60), 12);
  const groundBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateLineBrushFromRectWithAngle(groundRect.ptr!, argb(20, 80, 120, 200), argb(110, 30, 50, 90), 90.0, 1, 0, groundBrushBuffer.ptr!);
  const groundBrush = groundBrushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(offscreenGraphics, groundBrush, 0, groundY - 60, WINDOW_WIDTH, WINDOW_HEIGHT - (groundY - 60));
  Gdiplus.GdipDeleteBrush(groundBrush);

  // ── Each plant: sway, paint stem (Bezier), leaves, flower, caption.
  for (const plant of plants) {
    // Per-plant wave: two coupled sines so the curve never quite repeats.
    const omega = plant.swayFrequency * 2 * Math.PI;
    const primary = Math.sin(omega * elapsedSeconds + plant.swayPhase);
    const secondary = Math.sin(omega * 0.61 * elapsedSeconds + plant.swayPhase * 1.7);
    const sway = primary * plant.swayAmplitude + secondary * plant.swayAmplitude * 0.45;

    // Pulse: deterministic blink every pulseIntervalMs, lasting 280 ms.
    const pulsePosition = (elapsedMs + plant.pulsePhaseOffsetMs) % plant.pulseIntervalMs;
    const pulseActive = pulsePosition < 280;
    const pulseIntensity = pulseActive ? Math.max(0, 1 - pulsePosition / 280) : 0;

    // Stem control points: base (anchored), low control (lean), high control
    // (lean further), tip (sway most).
    const tipX = plant.baseX + sway;
    const tipY = plant.baseY - plant.stemHeight;
    const controlOneX = plant.baseX + sway * 0.18;
    const controlOneY = plant.baseY - plant.stemHeight * 0.33;
    const controlTwoX = plant.baseX + sway * 0.7;
    const controlTwoY = plant.baseY - plant.stemHeight * 0.72;

    // Stem color: a deep saturated form of the vendor hue.
    const [stemR, stemG, stemB] = hsvToRgb(plant.hueDegrees, 0.55, 0.45);
    const stemAlpha = 220 + Math.round(pulseIntensity * 35);
    const stemPenBuffer = Buffer.alloc(8);
    Gdiplus.GdipCreatePen1(argb(stemAlpha, stemR, stemG, stemB), 3.5, Unit.UnitPixel, stemPenBuffer.ptr!);
    const stemPen = stemPenBuffer.readBigUInt64LE(0);
    Gdiplus.GdipSetPenStartCap(stemPen, LineCap.LineCapRound);
    Gdiplus.GdipSetPenEndCap(stemPen, LineCap.LineCapRound);

    // Build the Bezier path once so we can both stroke it (the stem itself) and
    // sample it analytically (for leaf attachments + the flower at the tip).
    const pathHandleBuffer = Buffer.alloc(8);
    Gdiplus.GdipCreatePath(FillMode.FillModeAlternate, pathHandleBuffer.ptr!);
    const stemPath = pathHandleBuffer.readBigUInt64LE(0);
    Gdiplus.GdipAddPathBezier(stemPath, plant.baseX, plant.baseY, controlOneX, controlOneY, controlTwoX, controlTwoY, tipX, tipY);
    Gdiplus.GdipDrawPath(offscreenGraphics, stemPen, stemPath);
    Gdiplus.GdipDeletePath(stemPath);
    Gdiplus.GdipDeletePen(stemPen);

    // ── Leaves ── sample the cubic Bezier at every leaf's attachment ratio.
    const [leafR, leafG, leafB] = hsvToRgb(plant.hueDegrees + 30, 0.7, 0.65);
    for (let leafIndex = 0; leafIndex < plant.leafCount; leafIndex += 1) {
      // Attachment height: 0 at base, 1 at tip. Add a tiny per-frame wiggle for life.
      const heightFraction = plant.leafSeeds[leafIndex]! + Math.sin(elapsedSeconds * 1.3 + leafIndex) * 0.005;
      const u = Math.max(0.05, Math.min(0.95, heightFraction));
      const oneMinusU = 1 - u;

      // Cubic Bezier evaluation: B(u) = (1-u)^3 P0 + 3(1-u)^2 u P1 + 3(1-u) u^2 P2 + u^3 P3.
      const b0 = oneMinusU * oneMinusU * oneMinusU;
      const b1 = 3 * oneMinusU * oneMinusU * u;
      const b2 = 3 * oneMinusU * u * u;
      const b3 = u * u * u;
      const attachX = b0 * plant.baseX + b1 * controlOneX + b2 * controlTwoX + b3 * tipX;
      const attachY = b0 * plant.baseY + b1 * controlOneY + b2 * controlTwoY + b3 * tipY;

      // Tangent (derivative). dB/du = 3(1-u)^2 (P1-P0) + 6(1-u)u (P2-P1) + 3u^2 (P3-P2).
      const t0 = 3 * oneMinusU * oneMinusU;
      const t1 = 6 * oneMinusU * u;
      const t2 = 3 * u * u;
      const tangentX = t0 * (controlOneX - plant.baseX) + t1 * (controlTwoX - controlOneX) + t2 * (tipX - controlTwoX);
      const tangentY = t0 * (controlOneY - plant.baseY) + t1 * (controlTwoY - controlOneY) + t2 * (tipY - controlTwoY);
      const tangentLength = Math.max(1e-3, Math.hypot(tangentX, tangentY));

      // Perpendicular to tangent (normalized) - this is the leaf's outward direction.
      const perpendicularX = -tangentY / tangentLength;
      const perpendicularY = tangentX / tangentLength;

      // Alternate leaves to the left and right of the stem.
      const sideSign = (leafIndex & 1) === 0 ? 1 : -1;
      const leafLength = 26 + (leafIndex * 3) % 18; // 26 - 44 px
      const leafWidth = 11 + (leafIndex * 2) % 6;

      // Leaf tip + base relative to the stem.
      const leafBaseX = attachX + perpendicularX * 4 * sideSign;
      const leafBaseY = attachY + perpendicularY * 4 * sideSign;
      const leafTipX = attachX + perpendicularX * leafLength * sideSign + (tangentX / tangentLength) * 8;
      const leafTipY = attachY + perpendicularY * leafLength * sideSign + (tangentY / tangentLength) * 8;

      // Render as a thin closed curve (4 control points) so it looks lance-shaped.
      const leafPathBuffer = Buffer.alloc(8);
      Gdiplus.GdipCreatePath(FillMode.FillModeAlternate, leafPathBuffer.ptr!);
      const leafPath = leafPathBuffer.readBigUInt64LE(0);
      const c1x = (leafBaseX + leafTipX) / 2 + perpendicularY * leafWidth * sideSign * 0.6;
      const c1y = (leafBaseY + leafTipY) / 2 - perpendicularX * leafWidth * sideSign * 0.6;
      const c2x = (leafBaseX + leafTipX) / 2 - perpendicularY * leafWidth * sideSign * 0.6;
      const c2y = (leafBaseY + leafTipY) / 2 + perpendicularX * leafWidth * sideSign * 0.6;
      Gdiplus.GdipAddPathBezier(leafPath, leafBaseX, leafBaseY, c1x, c1y, leafTipX, leafTipY, leafTipX, leafTipY);
      Gdiplus.GdipAddPathBezier(leafPath, leafTipX, leafTipY, c2x, c2y, leafBaseX, leafBaseY, leafBaseX, leafBaseY);
      Gdiplus.GdipClosePathFigure(leafPath);

      const leafBrushBuffer = Buffer.alloc(8);
      const leafAlpha = 220 + Math.round(pulseIntensity * 30);
      Gdiplus.GdipCreateSolidFill(argb(leafAlpha, leafR, leafG, leafB), leafBrushBuffer.ptr!);
      const leafBrush = leafBrushBuffer.readBigUInt64LE(0);
      Gdiplus.GdipFillPath(offscreenGraphics, leafBrush, leafPath);
      Gdiplus.GdipDeleteBrush(leafBrush);
      Gdiplus.GdipDeletePath(leafPath);
    }

    // ── Flower / bud at the tip. A pulsing halo when the device is "active".
    const [flowerR, flowerG, flowerB] = hsvToRgb(plant.hueDegrees + 180, 0.6, 1.0);
    const haloRadius = 14 + pulseIntensity * 22;
    if (pulseIntensity > 0) {
      const haloBuffer = Buffer.alloc(8);
      Gdiplus.GdipCreateSolidFill(argb(Math.round(140 * pulseIntensity), flowerR, flowerG, flowerB), haloBuffer.ptr!);
      const haloBrush = haloBuffer.readBigUInt64LE(0);
      Gdiplus.GdipFillEllipse(offscreenGraphics, haloBrush, tipX - haloRadius, tipY - haloRadius, haloRadius * 2, haloRadius * 2);
      Gdiplus.GdipDeleteBrush(haloBrush);
    }

    const budBuffer = Buffer.alloc(8);
    Gdiplus.GdipCreateSolidFill(argb(240, flowerR, flowerG, flowerB), budBuffer.ptr!);
    const budBrush = budBuffer.readBigUInt64LE(0);
    Gdiplus.GdipFillEllipse(offscreenGraphics, budBrush, tipX - 6, tipY - 6, 12, 12);
    Gdiplus.GdipDeleteBrush(budBrush);

    // Bright inner pip on the bud.
    const pipBuffer = Buffer.alloc(8);
    Gdiplus.GdipCreateSolidFill(argb(255, 255, 255, 255), pipBuffer.ptr!);
    const pipBrush = pipBuffer.readBigUInt64LE(0);
    Gdiplus.GdipFillEllipse(offscreenGraphics, pipBrush, tipX - 2.5, tipY - 2.5, 5, 5);
    Gdiplus.GdipDeleteBrush(pipBrush);

    // ── Caption near the ground, truncated to fit the column.
    const truncated = plant.product.length > 18 ? plant.product.slice(0, 16) + '..' : plant.product;
    const captionBrushBuffer = Buffer.alloc(8);
    Gdiplus.GdipCreateSolidFill(argb(190, 220, 230, 245), captionBrushBuffer.ptr!);
    const captionBrush = captionBrushBuffer.readBigUInt64LE(0);
    drawCenteredString(truncated, captionFont, captionBrush, plant.baseX, groundY + 28, 80, 18);
    Gdiplus.GdipDeleteBrush(captionBrush);
  }

  // ── HUD line at the top of the window. ──
  const hudBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(argb(220, 210, 225, 250), hudBrushBuffer.ptr!);
  const hudBrush = hudBrushBuffer.readBigUInt64LE(0);
  const hudText = `HID Rainforest  -  ${plants.length} device${plants.length === 1 ? '' : 's'}  -  ESC or right-click to quit`;
  drawLeftString(hudText, hudFont, hudBrush, 24, 18, WINDOW_WIDTH - 48, 28);
  Gdiplus.GdipDeleteBrush(hudBrush);
}

function presentFrame(hwnd: bigint): void {
  // Blit the offscreen ARGB bitmap to the window's client area with GdipDrawImageRectI.
  const targetDc = User32.GetDC(hwnd);
  if (!targetDc) return;
  const screenGraphicsBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateFromHDC(targetDc, screenGraphicsBuffer.ptr!) === Status.Ok) {
    const screenGraphics = screenGraphicsBuffer.readBigUInt64LE(0);
    Gdiplus.GdipDrawImageRectI(screenGraphics, offscreenBitmap, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
    Gdiplus.GdipDeleteGraphics(screenGraphics);
  }
  User32.ReleaseDC(hwnd, targetDc);
}

// ── Step 6: register window class + WndProc ──────────────────────────────────

const windowProcedure = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    switch (msg) {
      case WM_NCHITTEST:
        return HTCAPTION; // Drag from anywhere - we have no titlebar.

      case WM_ERASEBKGND:
        return 1n; // Skip default fill - the Mica backdrop is our background.

      case WM_TIMER:
        if (wParam === TIMER_ID) User32.InvalidateRect(hWnd, NULL_PTR, 0);
        return 0n;

      case WM_PAINT: {
        // PAINTSTRUCT is 72 bytes on x64.
        const paintStructBuffer = Buffer.alloc(72);
        const targetDc = User32.BeginPaint(hWnd, paintStructBuffer.ptr!);
        if (targetDc) {
          paintFrame();
          presentFrame(hWnd);
        }
        User32.EndPaint(hWnd, paintStructBuffer.ptr!);
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

const className = encode('BunWin32HidRainforest');
const windowClassBuffer = Buffer.alloc(80); // WNDCLASSEXW on x64.
const windowClassView = new DataView(windowClassBuffer.buffer);
windowClassView.setUint32(0, 80, true); // cbSize
windowClassView.setUint32(4, CS_OWNDC, true); // style
windowClassBuffer.writeBigUInt64LE(BigInt(windowProcedure.ptr!), 8); // lpfnWndProc
windowClassView.setInt32(16, 0, true); // cbClsExtra
windowClassView.setInt32(20, 0, true); // cbWndExtra
windowClassBuffer.writeBigUInt64LE(0n, 24); // hInstance
windowClassBuffer.writeBigUInt64LE(0n, 32); // hIcon
windowClassBuffer.writeBigUInt64LE(0n, 40); // hCursor (Windows supplies arrow)
windowClassBuffer.writeBigUInt64LE(0n, 48); // hbrBackground = NULL (Mica shows through)
windowClassBuffer.writeBigUInt64LE(0n, 56); // lpszMenuName
windowClassBuffer.writeBigUInt64LE(BigInt(className.ptr!), 64); // lpszClassName
windowClassBuffer.writeBigUInt64LE(0n, 72); // hIconSm

const classAtom = User32.RegisterClassExW(windowClassBuffer.ptr!);
if (!classAtom) {
  console.error('RegisterClassExW failed.');
  process.exit(1);
}

// ── Step 7: create the window centered on the primary monitor ────────────────

const screenWidth = User32.GetSystemMetrics(0); // SM_CXSCREEN
const screenHeight = User32.GetSystemMetrics(1); // SM_CYSCREEN
const windowX = Math.max(0, Math.floor((screenWidth - WINDOW_WIDTH) / 2));
const windowY = Math.max(0, Math.floor((screenHeight - WINDOW_HEIGHT) / 2));

const windowHandle = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_APPWINDOW,
  className.ptr!,
  encode('HID Rainforest').ptr!,
  WindowStyles.WS_POPUP,
  windowX,
  windowY,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  0n,
  0n,
  0n,
  null,
);

if (!windowHandle) {
  console.error('CreateWindowExW failed.');
  process.exit(1);
}

// ── Step 8: Mica backdrop + dark mode + rounded corners + extend frame ───────

const dwmAttributeBuffer = Buffer.alloc(4);

dwmAttributeBuffer.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, dwmAttributeBuffer.ptr!, 4);

dwmAttributeBuffer.writeInt32LE(WindowCornerPreference.DWMWCP_ROUND, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_WINDOW_CORNER_PREFERENCE, dwmAttributeBuffer.ptr!, 4);

dwmAttributeBuffer.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, dwmAttributeBuffer.ptr!, 4);

// MARGINS{ -1, -1, -1, -1 } extends the DWM frame across the whole client area
// so the Mica backdrop is visible behind every transparent pixel we paint.
const dwmMarginsBuffer = Buffer.alloc(16);
dwmMarginsBuffer.writeInt32LE(-1, 0);
dwmMarginsBuffer.writeInt32LE(-1, 4);
dwmMarginsBuffer.writeInt32LE(-1, 8);
dwmMarginsBuffer.writeInt32LE(-1, 12);
Dwmapi.DwmExtendFrameIntoClientArea(windowHandle, dwmMarginsBuffer.ptr!);

User32.ShowWindow(windowHandle, ShowWindowCommand.SW_SHOWNOACTIVATE);
User32.UpdateWindow(windowHandle);

if (!User32.SetTimer(windowHandle, TIMER_ID, FRAME_INTERVAL_MS, null)) {
  console.error('SetTimer failed.');
  User32.DestroyWindow(windowHandle);
  process.exit(1);
}

// ── Step 9: standard Win32 message loop ──────────────────────────────────────

const messageBuffer = Buffer.alloc(48);
while (true) {
  const result = User32.GetMessageW(messageBuffer.ptr!, 0n, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(messageBuffer.ptr!);
  User32.DispatchMessageW(messageBuffer.ptr!);
}

// ── Step 10: teardown ────────────────────────────────────────────────────────

Gdiplus.GdipDeleteStringFormat(leftStringFormat);
Gdiplus.GdipDeleteStringFormat(centerStringFormat);
Gdiplus.GdipDeleteFont(hudFont);
Gdiplus.GdipDeleteFont(captionFont);
Gdiplus.GdipDeleteFontFamily(captionFamily);
Gdiplus.GdipDeleteGraphics(offscreenGraphics);
Gdiplus.GdipDisposeImage(offscreenBitmap);
Gdiplus.GdiplusShutdown(gdiplusToken);
User32.UnregisterClassW(className.ptr!, 0n);
windowProcedure.close();
console.log('HID Rainforest closed.');
