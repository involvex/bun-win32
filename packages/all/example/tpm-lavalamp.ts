/**
 * TPM Lavalamp — Hardware-RNG-driven metaballs from your real TPM
 *
 * A meditative animated lavalamp made of soft, glowing metaballs whose
 * positions, velocities, and radii are seeded by raw bytes pulled directly
 * from this machine's TPM 2.0 hardware random number generator via TPM Base
 * Services. Every blob's initial state — and a periodic re-seeding of its
 * motion vectors — is genuine hardware entropy bouncing inside a borderless
 * Mica window.
 *
 * Pipeline:
 *   1. Tbs.Tbsi_Context_Create               — open a TPM 2.0 TBS context
 *   2. Tbs.Tbsip_Submit_Command              — TPM2_GetRandom (TPM_CC = 0x17B)
 *   3. Bcrypt.BCryptGenRandom                — graceful fallback if no TPM
 *   4. User32.RegisterClassExW / CreateWindowExW — borderless WS_POPUP, ~800×1000
 *   5. Dwmapi.DwmSetWindowAttribute          — Mica backdrop + immersive dark
 *   6. Gdiplus.GdiplusStartup                — host startup
 *   7. GdipCreateBitmapFromScan0             — 32bpp ARGB offscreen surface
 *   8. GdipCreatePath / GdipAddPathEllipse   — radial path per ball
 *   9. GdipCreatePathGradient                — soft falloff brush per ball
 *  10. GdipFillPath (additive layering)      — glowing metaball blend
 *  11. User32.SetTimer                       — 60 fps redraw
 *  12. User32.GetMessageW message loop        — TranslateMessage / Dispatch
 *  13. WndProc handles WM_TIMER, WM_KEYDOWN(ESC), WM_PAINT, WM_DESTROY
 *  14. Every 5 s: re-pull 16 fresh TPM bytes to perturb the velocity field
 *  15. ESC → PostQuitMessage → Tbsip_Context_Close, GdiplusShutdown
 *
 * APIs demonstrated (Tbs):
 *   - Tbsi_Context_Create / Tbsip_Submit_Command / Tbsip_Context_Close
 *
 * APIs demonstrated (Bcrypt — fallback path):
 *   - BCryptGenRandom with BCRYPT_USE_SYSTEM_PREFERRED_RNG
 *
 * APIs demonstrated (User32):
 *   - RegisterClassExW / CreateWindowExW / DestroyWindow / UnregisterClassW
 *   - ShowWindow / UpdateWindow / GetDC / ReleaseDC
 *   - GetMessageW / TranslateMessage / DispatchMessageW / PostQuitMessage
 *   - DefWindowProcW / SetTimer / KillTimer
 *   - GetSystemMetrics  (centering the window on the primary monitor)
 *
 * APIs demonstrated (Dwmapi):
 *   - DwmSetWindowAttribute with DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_MAINWINDOW
 *   - DwmSetWindowAttribute with DWMWA_USE_IMMERSIVE_DARK_MODE
 *
 * APIs demonstrated (Gdiplus):
 *   - GdiplusStartup / GdiplusShutdown
 *   - GdipCreateBitmapFromScan0 / GdipDisposeImage
 *   - GdipGetImageGraphicsContext / GdipCreateFromHDC / GdipDeleteGraphics
 *   - GdipGraphicsClear / GdipSetSmoothingMode / GdipSetCompositingMode
 *   - GdipCreatePath / GdipAddPathEllipse / GdipClosePathFigure / GdipDeletePath
 *   - GdipCreatePathGradient / GdipSetPathGradientCenterColor
 *   - GdipSetPathGradientSurroundColorsWithCount / GdipDeleteBrush
 *   - GdipFillPath / GdipFillRectangle / GdipCreateSolidFill
 *   - GdipDrawString / GdipCreateFontFamilyFromName / GdipCreateFont
 *   - GdipCreateStringFormat / GdipSetStringFormatAlign
 *   - GdipDrawImageRectI  (blit the offscreen bitmap to the window HDC)
 *
 * APIs demonstrated (Kernel32):
 *   - GetModuleHandleW  (HINSTANCE used by the window class)
 *
 * Controls:
 *   - ESC                  close cleanly
 *
 * Run: bun run example/tpm-lavalamp.ts
 */

import { FFIType, JSCallback, type Pointer } from 'bun:ffi';

import { Bcrypt, Dwmapi, Gdiplus, Kernel32, Tbs, User32 } from '../index';
import { BCryptGenRandomFlags } from '@bun-win32/bcrypt';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { CompositingMode, FillMode, FontStyle, PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { ExtendedWindowStyles, ShowWindowCommand, SystemMetric, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { TBS_COMMAND_LOCALITY_ZERO, TBS_COMMAND_PRIORITY_NORMAL, TBS_CONTEXT_VERSION_TWO, TBS_SUCCESS } from '@bun-win32/tbs';

// ── Geometry + timing ────────────────────────────────────────────────────────

const WINDOW_WIDTH = 800;
const WINDOW_HEIGHT = 1000;
const BALL_COUNT = 8;
const FRAME_INTERVAL_MS = 16; // ~60 fps
const RESEED_INTERVAL_MS = 5_000; // re-pull 16 TPM bytes every 5 seconds

const TIMER_FRAME = 1n;
const TIMER_RESEED = 2n;

// Win32 message ids used by the window procedure.
const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_TIMER = 0x0113;

// ── Small utilities ──────────────────────────────────────────────────────────

const NULL = 0n;
const NULL_PTR = null as unknown as Pointer;

const encodeWide = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');

const argb = (alpha: number, red: number, green: number, blue: number): number =>
  (((alpha & 0xff) << 24) | ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)) >>> 0;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function check(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} failed: ${Status[status]} (${status})`);
}

// ── TPM 2.0 random source over TBS, with a Bcrypt fallback ───────────────────

let tpmContextHandle: bigint = 0n;
let usingTpm = false;

const tpmResponseBuffer = Buffer.alloc(512);
const tpmResponseLength = Buffer.alloc(4);

/**
 * Submit a TPM2_GetRandom command via Tbsip_Submit_Command and return the
 * payload bytes. Returns null on any TBS error or non-zero TPM responseCode.
 */
function tpmRandom(bytesRequested: number): Buffer | null {
  if (!tpmContextHandle) return null;
  const command = Buffer.alloc(12);
  command.writeUInt16BE(0x8001, 0); // TPM_ST_NO_SESSIONS
  command.writeUInt32BE(12, 2); // commandSize
  command.writeUInt32BE(0x0000_017b, 6); // TPM_CC_GetRandom
  command.writeUInt16BE(bytesRequested, 10); // bytesRequested
  tpmResponseLength.writeUInt32LE(tpmResponseBuffer.byteLength, 0);
  const tbsResult = Tbs.Tbsip_Submit_Command(
    tpmContextHandle,
    TBS_COMMAND_LOCALITY_ZERO,
    TBS_COMMAND_PRIORITY_NORMAL,
    command.ptr,
    command.byteLength,
    tpmResponseBuffer.ptr,
    tpmResponseLength.ptr,
  );
  if (tbsResult !== TBS_SUCCESS) return null;
  if (tpmResponseBuffer.readUInt32BE(6) !== 0) return null;
  const payloadSize = tpmResponseBuffer.readUInt16BE(10);
  return Buffer.from(tpmResponseBuffer.subarray(12, 12 + payloadSize));
}

/**
 * Try to open a TPM 2.0 TBS context. Returns true if the TPM is usable and
 * the first GetRandom call succeeds; false otherwise (we then fall back to
 * Bcrypt for the rest of the run).
 */
function tryOpenTpm(): boolean {
  const contextParams = Buffer.alloc(8);
  contextParams.writeUInt32LE(TBS_CONTEXT_VERSION_TWO, 0);
  contextParams.writeUInt32LE(0b100, 4); // requestRaw=0, includeTpm12=0, includeTpm20=1
  const handleBuffer = Buffer.alloc(8);
  const createResult = Tbs.Tbsi_Context_Create(contextParams.ptr, handleBuffer.ptr);
  if (createResult !== TBS_SUCCESS) return false;
  tpmContextHandle = handleBuffer.readBigUInt64LE(0);
  // Validate by issuing one real TPM2_GetRandom — some virtualized TPMs accept
  // context creation but reject command submission.
  const probe = tpmRandom(8);
  if (!probe) {
    Tbs.Tbsip_Context_Close(tpmContextHandle);
    tpmContextHandle = 0n;
    return false;
  }
  return true;
}

/** Fill `output` with cryptographic bytes from Bcrypt's system-preferred RNG. */
function bcryptRandom(output: Buffer): void {
  const status = Bcrypt.BCryptGenRandom(0n, output.ptr, output.byteLength, BCryptGenRandomFlags.BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  if (status !== 0) throw new Error(`BCryptGenRandom failed: NTSTATUS 0x${(status >>> 0).toString(16)}`);
}

/**
 * Request `byteCount` bytes from the TPM if we have one. If the TPM either
 * refuses or returns short, top up the buffer from Bcrypt. Always returns a
 * Buffer of exactly `byteCount` bytes.
 */
function hardwareRandom(byteCount: number): Buffer {
  if (usingTpm) {
    const fromTpm = tpmRandom(byteCount);
    if (fromTpm && fromTpm.length >= byteCount) return fromTpm.subarray(0, byteCount);
    if (fromTpm && fromTpm.length > 0) {
      const combined = Buffer.alloc(byteCount);
      fromTpm.copy(combined, 0, 0, Math.min(fromTpm.length, byteCount));
      const tail = Buffer.alloc(byteCount - fromTpm.length);
      bcryptRandom(tail);
      tail.copy(combined, fromTpm.length);
      return combined;
    }
  }
  const fallback = Buffer.alloc(byteCount);
  bcryptRandom(fallback);
  return fallback;
}

// ── Metaball model ───────────────────────────────────────────────────────────

interface Metaball {
  positionX: number;
  positionY: number;
  velocityX: number;
  velocityY: number;
  baseRadius: number;
}

/**
 * Build a fresh set of metaballs from a stream of raw random bytes. Each ball
 * consumes 6 bytes:
 *   - 2 bytes →   x ∈ [40, WINDOW_WIDTH-40]
 *   - 2 bytes →   y ∈ [WINDOW_HEIGHT*0.15, WINDOW_HEIGHT*0.85]
 *   - 1 byte  →  vx ∈ [-0.9, 0.9] px/frame
 *   - 1 byte  →  vy ∈ [-1.2, 1.2] px/frame, plus a slight downward bias
 * Radius is derived from the average of the first three bytes per ball so it
 * tracks the entropy stream itself.
 */
function spawnMetaballs(entropy: Buffer): Metaball[] {
  const balls: Metaball[] = [];
  for (let i = 0; i < BALL_COUNT; i++) {
    const offset = i * 6;
    const xRaw = entropy.readUInt16BE(offset) / 0xffff;
    const yRaw = entropy.readUInt16BE(offset + 2) / 0xffff;
    const vxRaw = (entropy.readUInt8(offset + 4) - 128) / 128; // -1..1
    const vyRaw = (entropy.readUInt8(offset + 5) - 128) / 128; // -1..1
    const radiusByte = (entropy.readUInt8(offset) + entropy.readUInt8(offset + 2) + entropy.readUInt8(offset + 4)) / 3;
    balls.push({
      positionX: 40 + xRaw * (WINDOW_WIDTH - 80),
      positionY: WINDOW_HEIGHT * 0.15 + yRaw * (WINDOW_HEIGHT * 0.70),
      velocityX: vxRaw * 0.9,
      velocityY: vyRaw * 1.2 + 0.15,
      baseRadius: 65 + (radiusByte / 255) * 70, // 65..135
    });
  }
  return balls;
}

/**
 * Mutate the existing balls' velocities using fresh hardware entropy. Two
 * bytes per ball: signed perturbations that blend with the current velocity.
 */
function perturbVelocities(balls: Metaball[], entropy: Buffer): void {
  for (let i = 0; i < balls.length; i++) {
    const ball = balls[i]!;
    const newVx = (entropy.readUInt8(i * 2) - 128) / 128;
    const newVy = (entropy.readUInt8(i * 2 + 1) - 128) / 128;
    ball.velocityX = ball.velocityX * 0.55 + newVx * 0.85;
    ball.velocityY = ball.velocityY * 0.55 + newVy * 1.1 + 0.15;
  }
}

/**
 * Apply one frame of lavalamp physics: drift + wall bounce + temperature
 * gradient. Hot bottom → balls accelerate upward and grow; cool top → balls
 * decelerate and shrink. Damped at the bounds so the system never explodes.
 */
function stepPhysics(balls: Metaball[]): void {
  for (const ball of balls) {
    ball.positionX += ball.velocityX;
    ball.positionY += ball.velocityY;

    // Wall bounce on the sides with a small damping factor.
    if (ball.positionX < 30) {
      ball.positionX = 30;
      ball.velocityX = Math.abs(ball.velocityX) * 0.85;
    } else if (ball.positionX > WINDOW_WIDTH - 30) {
      ball.positionX = WINDOW_WIDTH - 30;
      ball.velocityX = -Math.abs(ball.velocityX) * 0.85;
    }

    // Lavalamp loop: the bottom is "hot" — push balls up; the top is "cool"
    // — push them back down. Strength scales with how close they are to the
    // extreme so the middle of the lamp feels lazy.
    const yNormalized = ball.positionY / WINDOW_HEIGHT;
    if (yNormalized > 0.85) {
      const heat = (yNormalized - 0.85) / 0.15;
      ball.velocityY -= heat * 0.20;
      ball.velocityX += (Math.random() - 0.5) * 0.08;
    } else if (yNormalized < 0.15) {
      const chill = (0.15 - yNormalized) / 0.15;
      ball.velocityY += chill * 0.18;
      ball.velocityX += (Math.random() - 0.5) * 0.06;
    } else {
      // Mild center drift: gravity-like creep downwards so they don't all
      // pile at the top after a re-seed.
      ball.velocityY += 0.005;
    }

    // Hard floor / ceiling — bounce with strong damping.
    if (ball.positionY < 60) {
      ball.positionY = 60;
      ball.velocityY = Math.abs(ball.velocityY) * 0.8;
    } else if (ball.positionY > WINDOW_HEIGHT - 60) {
      ball.positionY = WINDOW_HEIGHT - 60;
      ball.velocityY = -Math.abs(ball.velocityY) * 0.8;
    }

    // Velocity cap so a noisy entropy update can never launch a ball.
    ball.velocityX = clamp(ball.velocityX, -2.5, 2.5);
    ball.velocityY = clamp(ball.velocityY, -2.5, 2.5);
  }
}

// ── Bootstrap: TPM source, GDI+, window, render targets ──────────────────────

console.log('TPM Lavalamp — booting…');

Tbs.Preload(['Tbsi_Context_Create', 'Tbsip_Submit_Command', 'Tbsip_Context_Close']);
Bcrypt.Preload(['BCryptGenRandom']);
Gdiplus.Preload();

usingTpm = tryOpenTpm();
if (usingTpm) {
  console.log('  RNG source: real TPM 2.0 via tbs.dll (Tbsi_Context_Create + TPM2_GetRandom).');
} else {
  console.log('  RNG source: bcrypt.dll BCryptGenRandom (no TPM available — using system-preferred RNG).');
}

const gdiplusStartupToken = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
check(Gdiplus.GdiplusStartup(gdiplusStartupToken.ptr, gdiplusStartupInput.ptr, null), 'GdiplusStartup');
const gdiplusToken = gdiplusStartupToken.readBigUInt64LE(0);

// Initial seed: 48 bytes drives 8 balls × 6 bytes each.
const initialEntropy = hardwareRandom(BALL_COUNT * 6);
const metaballs = spawnMetaballs(initialEntropy);

let lastReseedTimestampMs = Date.now();

// ── Window class + window ────────────────────────────────────────────────────

let shouldClose = false;

const windowProcedure = new JSCallback(
  (hWnd: bigint, msg: number, wParam: number | bigint, lParam: number | bigint): bigint => {
    if (msg === WM_KEYDOWN) {
      if (Number(wParam) === VirtualKey.VK_ESCAPE) {
        shouldClose = true;
        User32.PostQuitMessage(0);
        return 0n;
      }
    }
    if (msg === WM_TIMER) {
      const timerId = BigInt(wParam);
      if (timerId === TIMER_FRAME) {
        stepPhysics(metaballs);
        renderFrame();
        return 0n;
      }
      if (timerId === TIMER_RESEED) {
        const fresh = hardwareRandom(BALL_COUNT * 2);
        perturbVelocities(metaballs, fresh);
        lastReseedTimestampMs = Date.now();
        return 0n;
      }
    }
    if (msg === WM_CLOSE) {
      shouldClose = true;
      User32.DestroyWindow(hWnd);
      return 0n;
    }
    if (msg === WM_DESTROY) {
      User32.PostQuitMessage(0);
      return 0n;
    }
    return BigInt(User32.DefWindowProcW(hWnd, msg, BigInt(wParam), BigInt(lParam)));
  },
  { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
);

const className = encodeWide('BunTpmLavalampWindow');

// WNDCLASSEXW on x64 is 80 bytes (cbSize + style + lpfnWndProc + cbClsExtra +
// cbWndExtra + hInstance + hIcon + hCursor + hbrBackground + lpszMenuName +
// lpszClassName + hIconSm).
const wndClassBuffer = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuffer.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassView.setUint32(4, 0, true); // style
wndClassBuffer.writeBigUInt64LE(BigInt(windowProcedure.ptr!), 8); // lpfnWndProc
wndClassView.setInt32(16, 0, true); // cbClsExtra
wndClassView.setInt32(20, 0, true); // cbWndExtra
wndClassBuffer.writeBigUInt64LE(0n, 24); // hInstance
wndClassBuffer.writeBigUInt64LE(0n, 32); // hIcon
wndClassBuffer.writeBigUInt64LE(0n, 40); // hCursor
wndClassBuffer.writeBigUInt64LE(0n, 48); // hbrBackground
wndClassBuffer.writeBigUInt64LE(0n, 56); // lpszMenuName
wndClassBuffer.writeBigUInt64LE(BigInt(className.ptr), 64); // lpszClassName
wndClassBuffer.writeBigUInt64LE(0n, 72); // hIconSm

const classAtom = User32.RegisterClassExW(wndClassBuffer.ptr);
if (!classAtom) {
  console.error('RegisterClassExW failed');
  process.exit(1);
}

const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
const windowX = Math.max(0, Math.floor((screenWidth - WINDOW_WIDTH) / 2));
const windowY = Math.max(0, Math.floor((screenHeight - WINDOW_HEIGHT) / 2));

const moduleHandle = Kernel32.GetModuleHandleW(null!);

const windowHandle = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_APPWINDOW,
  className.ptr,
  encodeWide('TPM Lavalamp').ptr,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  windowX,
  windowY,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  NULL,
  NULL,
  moduleHandle,
  NULL_PTR,
);
if (!windowHandle) {
  console.error('CreateWindowExW failed');
  process.exit(1);
}

// Apply Mica backdrop + immersive dark mode through DWM.
const backdropAttribute = Buffer.alloc(4);
backdropAttribute.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdropAttribute.ptr, 4);

const darkModeAttribute = Buffer.alloc(4);
darkModeAttribute.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, darkModeAttribute.ptr, 4);

User32.ShowWindow(windowHandle, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(windowHandle);

// ── Offscreen GDI+ bitmap + Graphics ─────────────────────────────────────────

const bitmapHandleBuffer = Buffer.alloc(8);
check(
  Gdiplus.GdipCreateBitmapFromScan0(WINDOW_WIDTH, WINDOW_HEIGHT, 0, PixelFormat32bppARGB, null, bitmapHandleBuffer.ptr),
  'GdipCreateBitmapFromScan0',
);
const offscreenBitmap = bitmapHandleBuffer.readBigUInt64LE(0);

const offscreenGraphicsHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipGetImageGraphicsContext(offscreenBitmap, offscreenGraphicsHandleBuffer.ptr), 'GdipGetImageGraphicsContext');
const offscreenGraphics = offscreenGraphicsHandleBuffer.readBigUInt64LE(0);

check(Gdiplus.GdipSetSmoothingMode(offscreenGraphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
check(Gdiplus.GdipSetCompositingMode(offscreenGraphics, CompositingMode.CompositingModeSourceOver), 'GdipSetCompositingMode');
check(Gdiplus.GdipSetTextRenderingHint(offscreenGraphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit), 'GdipSetTextRenderingHint');

// Font + format for the tiny corner caption.
const fontFamilyHandleBuffer = Buffer.alloc(8);
const fontFamilyName = encodeWide('Segoe UI');
check(Gdiplus.GdipCreateFontFamilyFromName(fontFamilyName.ptr, 0n, fontFamilyHandleBuffer.ptr), 'GdipCreateFontFamilyFromName');
const fontFamily = fontFamilyHandleBuffer.readBigUInt64LE(0);

const captionFontBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateFont(fontFamily, 13, FontStyle.FontStyleRegular, Unit.UnitPixel, captionFontBuffer.ptr), 'GdipCreateFont(caption)');
const captionFont = captionFontBuffer.readBigUInt64LE(0);

const captionFormatBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateStringFormat(0, 0, captionFormatBuffer.ptr), 'GdipCreateStringFormat');
const captionFormat = captionFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(captionFormat, StringAlignment.StringAlignmentNear);
Gdiplus.GdipSetStringFormatLineAlign(captionFormat, StringAlignment.StringAlignmentNear);

// Reusable buffers so the hot path doesn't pressure the GC.
const reusableCaptionRect = Buffer.alloc(16);

// ── Render ───────────────────────────────────────────────────────────────────

/**
 * Map a normalized Y position (0 = top "cool", 1 = bottom "hot") into the
 * deep-purple → magenta → orange palette used for the metaballs' glow.
 */
function paletteForY(yNormalized: number): { r: number; g: number; b: number } {
  // Three-stop gradient in linear RGB-ish space:
  //   0.0  deep purple   (40, 18, 90)
  //   0.5  magenta       (210, 60, 150)
  //   1.0  orange-red    (255, 130, 50)
  const t = clamp(yNormalized, 0, 1);
  if (t < 0.5) {
    const u = t / 0.5;
    return {
      r: Math.round(lerp(40, 210, u)),
      g: Math.round(lerp(18, 60, u)),
      b: Math.round(lerp(90, 150, u)),
    };
  }
  const u = (t - 0.5) / 0.5;
  return {
    r: Math.round(lerp(210, 255, u)),
    g: Math.round(lerp(60, 130, u)),
    b: Math.round(lerp(150, 50, u)),
  };
}

/**
 * Draw a single metaball as a soft-edged radial gradient. We build a circular
 * path, wrap it in a path-gradient brush, then fill it. Multiple balls drawn
 * with SourceOver give an additive-looking bloom because the centers are
 * bright and the edges fade to fully transparent.
 */
function drawMetaball(graphics: bigint, ball: Metaball, hotness: number): void {
  // Hot balls (toward the bottom) puff up a bit, cool ones (toward the top)
  // shrink — classic lavalamp temperature behavior.
  const renderRadius = ball.baseRadius * lerp(0.78, 1.18, clamp(hotness, 0, 1));

  // Build a circular path centered on the ball.
  const pathHandleBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreatePath(FillMode.FillModeAlternate, pathHandleBuffer.ptr) !== Status.Ok) return;
  const ballPath = pathHandleBuffer.readBigUInt64LE(0);
  Gdiplus.GdipAddPathEllipse(
    ballPath,
    ball.positionX - renderRadius,
    ball.positionY - renderRadius,
    renderRadius * 2,
    renderRadius * 2,
  );
  Gdiplus.GdipClosePathFigure(ballPath);

  // Wrap the path in a path-gradient brush: center is bright, edge is alpha 0.
  const gradientBrushBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreatePathGradientFromPath(ballPath, gradientBrushBuffer.ptr) !== Status.Ok) {
    Gdiplus.GdipDeletePath(ballPath);
    return;
  }
  const gradientBrush = gradientBrushBuffer.readBigUInt64LE(0);

  const yNormalized = ball.positionY / WINDOW_HEIGHT;
  const color = paletteForY(yNormalized);
  // Brighten the center a touch toward white for the high-energy look.
  const centerColor = argb(
    220,
    Math.min(255, color.r + 60),
    Math.min(255, color.g + 30),
    Math.min(255, color.b + 20),
  );
  Gdiplus.GdipSetPathGradientCenterColor(gradientBrush, centerColor);

  // Surround color: fully transparent so each ball blends additively into the
  // others via SourceOver.
  const surroundColor = Buffer.alloc(4);
  surroundColor.writeUInt32LE(argb(0, color.r, color.g, color.b), 0);
  const surroundCount = Buffer.alloc(4);
  surroundCount.writeInt32LE(1, 0);
  Gdiplus.GdipSetPathGradientSurroundColorsWithCount(gradientBrush, surroundColor.ptr, surroundCount.ptr);

  Gdiplus.GdipFillPath(graphics, gradientBrush, ballPath);

  Gdiplus.GdipDeleteBrush(gradientBrush);
  Gdiplus.GdipDeletePath(ballPath);
}

/**
 * Paint the background gradient: deep blue-black at the top fading to a warm
 * dark plum at the bottom. The DWM Mica backdrop bleeds through subtly under
 * the alpha=0xff fill where we leave alpha slightly under 1.0; here we paint
 * the entire client region so the lavalamp reads as opaque.
 */
function paintBackground(graphics: bigint): void {
  Gdiplus.GdipGraphicsClear(graphics, argb(255, 8, 6, 18));

  // Subtle vertical gradient over the top quarter and bottom quarter to
  // suggest "cool" + "hot" zones without distracting from the balls.
  const topRect = Buffer.alloc(16);
  topRect.writeFloatLE(0, 0);
  topRect.writeFloatLE(0, 4);
  topRect.writeFloatLE(WINDOW_WIDTH, 8);
  topRect.writeFloatLE(WINDOW_HEIGHT * 0.35, 12);
  const topBrushBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateLineBrushFromRectWithAngle(topRect.ptr, argb(180, 18, 12, 40), argb(0, 8, 6, 18), 90.0, 1, 0, topBrushBuffer.ptr) === Status.Ok) {
    const topBrush = topBrushBuffer.readBigUInt64LE(0);
    Gdiplus.GdipFillRectangle(graphics, topBrush, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT * 0.35);
    Gdiplus.GdipDeleteBrush(topBrush);
  }

  const bottomRect = Buffer.alloc(16);
  bottomRect.writeFloatLE(0, 0);
  bottomRect.writeFloatLE(WINDOW_HEIGHT * 0.65, 4);
  bottomRect.writeFloatLE(WINDOW_WIDTH, 8);
  bottomRect.writeFloatLE(WINDOW_HEIGHT * 0.35, 12);
  const bottomBrushBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateLineBrushFromRectWithAngle(bottomRect.ptr, argb(0, 8, 6, 18), argb(200, 70, 18, 30), 90.0, 1, 0, bottomBrushBuffer.ptr) === Status.Ok) {
    const bottomBrush = bottomBrushBuffer.readBigUInt64LE(0);
    Gdiplus.GdipFillRectangle(graphics, bottomBrush, 0, WINDOW_HEIGHT * 0.65, WINDOW_WIDTH, WINDOW_HEIGHT * 0.35);
    Gdiplus.GdipDeleteBrush(bottomBrush);
  }
}

/**
 * Draw the bottom-left HUD: RNG source + seconds since last TPM read.
 */
function paintCaption(graphics: bigint): void {
  const sinceReseedSeconds = (Date.now() - lastReseedTimestampMs) / 1000;
  const source = usingTpm ? 'TPM 2.0 hardware RNG' : 'Bcrypt (system RNG fallback)';
  const text = `${source}   ·   last seed: ${sinceReseedSeconds.toFixed(1)} s ago   ·   esc to quit`;

  const wideText = encodeWide(text);
  reusableCaptionRect.writeFloatLE(20, 0);
  reusableCaptionRect.writeFloatLE(WINDOW_HEIGHT - 32, 4);
  reusableCaptionRect.writeFloatLE(WINDOW_WIDTH - 40, 8);
  reusableCaptionRect.writeFloatLE(24, 12);

  // Shadow then foreground for a touch of contrast against the Mica blur.
  const shadowBrushBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateSolidFill(argb(160, 0, 0, 0), shadowBrushBuffer.ptr) === Status.Ok) {
    const shadowBrush = shadowBrushBuffer.readBigUInt64LE(0);
    const shadowRect = Buffer.alloc(16);
    shadowRect.writeFloatLE(21, 0);
    shadowRect.writeFloatLE(WINDOW_HEIGHT - 31, 4);
    shadowRect.writeFloatLE(WINDOW_WIDTH - 40, 8);
    shadowRect.writeFloatLE(24, 12);
    Gdiplus.GdipDrawString(graphics, wideText.ptr, -1, captionFont, shadowRect.ptr, captionFormat, shadowBrush);
    Gdiplus.GdipDeleteBrush(shadowBrush);
  }
  const textBrushBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateSolidFill(argb(210, 0xff, 0xe8, 0xc8), textBrushBuffer.ptr) === Status.Ok) {
    const textBrush = textBrushBuffer.readBigUInt64LE(0);
    Gdiplus.GdipDrawString(graphics, wideText.ptr, -1, captionFont, reusableCaptionRect.ptr, captionFormat, textBrush);
    Gdiplus.GdipDeleteBrush(textBrush);
  }
}

/** Render one full lavalamp frame into the offscreen bitmap and blit. */
function renderFrame(): void {
  paintBackground(offscreenGraphics);

  // Draw balls from the coolest (top) to the hottest (bottom). Hotter balls
  // paint last so their warmth dominates the blend in the lower zone.
  const ordered = [...metaballs].sort((a, b) => a.positionY - b.positionY);
  for (const ball of ordered) {
    const yNormalized = ball.positionY / WINDOW_HEIGHT;
    drawMetaball(offscreenGraphics, ball, yNormalized);
  }

  paintCaption(offscreenGraphics);
  blitToWindow();
}

/** Copy the offscreen bitmap to the window's device context. */
function blitToWindow(): void {
  const windowDc = User32.GetDC(windowHandle);
  if (!windowDc) return;
  const windowGraphicsHandleBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateFromHDC(windowDc, windowGraphicsHandleBuffer.ptr) === Status.Ok) {
    const windowGraphics = windowGraphicsHandleBuffer.readBigUInt64LE(0);
    Gdiplus.GdipDrawImageRectI(windowGraphics, offscreenBitmap, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
    Gdiplus.GdipDeleteGraphics(windowGraphics);
  }
  User32.ReleaseDC(windowHandle, windowDc);
}

// ── Timers + message loop ────────────────────────────────────────────────────

const frameTimer = User32.SetTimer(windowHandle, TIMER_FRAME, FRAME_INTERVAL_MS, null);
const reseedTimer = User32.SetTimer(windowHandle, TIMER_RESEED, RESEED_INTERVAL_MS, null);
if (!frameTimer || !reseedTimer) {
  console.error('SetTimer failed for one of the lavalamp timers');
  User32.DestroyWindow(windowHandle);
  process.exit(1);
}

console.log('  Window open. ESC to quit.');

const messageBuffer = Buffer.alloc(48);
while (!shouldClose) {
  const status = User32.GetMessageW(messageBuffer.ptr, NULL, 0, 0);
  if (status <= 0) break;
  User32.TranslateMessage(messageBuffer.ptr);
  User32.DispatchMessageW(messageBuffer.ptr);
}

// ── Teardown ─────────────────────────────────────────────────────────────────

console.log('Cleaning up…');

User32.KillTimer(windowHandle, TIMER_FRAME);
User32.KillTimer(windowHandle, TIMER_RESEED);

Gdiplus.GdipDeleteStringFormat(captionFormat);
Gdiplus.GdipDeleteFont(captionFont);
Gdiplus.GdipDeleteFontFamily(fontFamily);
Gdiplus.GdipDeleteGraphics(offscreenGraphics);
Gdiplus.GdipDisposeImage(offscreenBitmap);
Gdiplus.GdiplusShutdown(gdiplusToken);

if (windowHandle) User32.DestroyWindow(windowHandle);
User32.UnregisterClassW(className.ptr, NULL);
windowProcedure.close();

if (tpmContextHandle) {
  Tbs.Tbsip_Context_Close(tpmContextHandle);
  tpmContextHandle = 0n;
}

console.log('Done.');
