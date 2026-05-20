/**
 * WebAuthn Orbs — watch a real Windows Hello passkey ceremony unfold as glowing orbs
 *
 * A flagship showcase for `@bun-win32/all`: drives an end-to-end FIDO2 WebAuthn
 * ceremony against the Windows platform authenticator (Windows Hello) and
 * visualizes every phase as a constellation of glowing orbs in a borderless,
 * dark-mode, DWM-Mica window. Every byte of every WebAuthn struct is
 * hand-assembled in TypeScript and pushed through `bun:ffi` — no native build
 * step, no Electron, no third-party crypto. The Hello biometric/PIN dialog
 * fires for real and the resulting attestation + assertion are decoded straight
 * out of native memory.
 *
 * The visual: eight orbs arranged in a circle around the window center, each
 * representing one phase of the ceremony. As each phase completes, its orb
 * ignites with a radial gradient, emits a short-lived particle burst, and a
 * curved beam connects it to the next orb. The active phase pulses; finished
 * phases glow steadily; pending phases stay dim. When the ceremony reaches the
 * blocking `WebAuthNAuthenticatorMakeCredential` call, the render timer is
 * paused (Hello pumps its own modal UI loop) and a final "Verifying with
 * Windows Hello…" frame is painted, then the call is issued. When it returns,
 * the timer resumes, the credential id is rendered as a 4x4 colored dot
 * identicon, and the ceremony continues through assertion and signature decode.
 *
 * Phases (one orb each):
 *   [a]  challenge       — 32 random bytes via Bcrypt.BCryptGenRandom
 *   [b]  rp + user       — relying-party + random user entity
 *   [c]  client data     — clientDataJSON + SHA-256 with Bcrypt.BCryptHash
 *   [d]  make credential — WebAuthn.WebAuthNAuthenticatorMakeCredential (Hello prompts)
 *   [e]  decode attest.  — AAGUID + COSE alg + signature counter from native memory
 *   [f]  new challenge   — fresh 32 random bytes for the assertion
 *   [g]  get assertion   — WebAuthn.WebAuthNAuthenticatorGetAssertion (Hello prompts)
 *   [h]  verify signature — decode bytes + bind back to the issued credential id
 *
 * Controls:
 *   ESC       quit the demo at any time
 *
 * Run: bun run example/webauthn-orbs.ts
 *
 * Requires: a machine with Windows Hello configured (face / fingerprint / PIN).
 *           On a machine without Hello, MakeCredential returns NotSupportedError
 *           and the demo paints the failure on the orb instead of locking up.
 *
 * APIs demonstrated (Webauthn):
 *   - WebAuthNAuthenticatorMakeCredential     (register a passkey via Hello)
 *   - WebAuthNAuthenticatorGetAssertion       (sign a challenge with the passkey)
 *   - WebAuthNFreeCredentialAttestation       (release the attestation)
 *   - WebAuthNFreeAssertion                   (release the assertion)
 *   - WebAuthNGetErrorName                    (decode any failure HRESULT)
 *
 * APIs demonstrated (Bcrypt):
 *   - BCryptGenRandom                         (cryptographic random bytes)
 *   - BCryptHash                              (one-shot SHA-256)
 *
 * APIs demonstrated (User32):
 *   - RegisterClassExW / CreateWindowExW / DestroyWindow / UnregisterClassW
 *   - SetWindowLongPtrW / DefWindowProcW
 *   - PeekMessageW / TranslateMessage / DispatchMessageW / PostQuitMessage
 *   - ShowWindow / UpdateWindow / GetDC / ReleaseDC / GetSystemMetrics
 *
 * APIs demonstrated (Dwmapi):
 *   - DwmSetWindowAttribute with DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_MAINWINDOW
 *   - DwmSetWindowAttribute with DWMWA_USE_IMMERSIVE_DARK_MODE
 *
 * APIs demonstrated (Gdiplus):
 *   - GdiplusStartup / GdiplusShutdown
 *   - GdipCreateBitmapFromScan0 (offscreen 32bpp ARGB)
 *   - GdipGetImageGraphicsContext / GdipCreateFromHDC / GdipDrawImageRectI
 *   - GdipSetSmoothingMode / GdipSetTextRenderingHint
 *   - GdipGraphicsClear / GdipFillEllipse / GdipFillRectangle
 *   - GdipCreateSolidFill / GdipCreateLineBrushFromRectWithAngle / GdipDeleteBrush
 *   - GdipCreatePen1 / GdipDrawLine / GdipDeletePen
 *   - GdipCreateFontFamilyFromName / GdipCreateFont / GdipDrawString
 *   - GdipCreateStringFormat / GdipSetStringFormatAlign / GdipSetStringFormatLineAlign
 *
 * APIs demonstrated (Kernel32):
 *   - Kernel32.GetCurrentProcess / Kernel32.ReadProcessMemory (decode attestation)
 *   - Kernel32.GetModuleHandleW (HINSTANCE for the class)
 */

import { JSCallback } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';

import { Bcrypt, Dwmapi, Gdiplus, Kernel32, User32, Webauthn } from '../index';
import { BCRYPT_SHA256_ALG_HANDLE, BCryptGenRandomFlags } from '@bun-win32/bcrypt';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit, FontStyle } from '@bun-win32/gdiplus';
import { ExtendedWindowStyles, PeekMessageRemoveFlag, ShowWindowCommand, SystemMetric, VirtualKey, WindowLongIndex, WindowStyles } from '@bun-win32/user32';
import {
  WEBAUTHN_API_CURRENT_VERSION,
  WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
  WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM,
  WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_1,
  WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_1,
  WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
  WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256,
  WEBAUTHN_COSE_ALGORITHM_RSASSA_PKCS1_V1_5_WITH_SHA256,
  WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
  WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
  WEBAUTHN_HASH_ALGORITHM_SHA_256,
  WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
  WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
  WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
} from '@bun-win32/webauthn';

// ──────────────────────────────────────────────────────────────────────────────
// Win32 message + constants
// ──────────────────────────────────────────────────────────────────────────────

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_QUIT = 0x0012;
const WM_ERASEBKGND = 0x0014;
const MSG_SIZE_BYTES = 48;

const WINDOW_WIDTH = 1000;
const WINDOW_HEIGHT = 640;
const FRAME_BUDGET_MS = 16;

const RP_ID = 'bun-win32.test';
const RP_NAME = 'bun-win32 — WebAuthn Orbs';
const USER_DISPLAY_NAME = 'WebAuthn Orbs Demo';
const USER_NAME = 'orbs@bun-win32.test';

// ──────────────────────────────────────────────────────────────────────────────
// Small utilities
// ──────────────────────────────────────────────────────────────────────────────

const encodeWide = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');

const argb = (alpha: number, red: number, green: number, blue: number): number =>
  (((alpha & 0xff) << 24) | ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)) >>> 0;

const clamp = (value: number, lo: number, hi: number): number => (value < lo ? lo : value > hi ? hi : value);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function checkStatus(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} failed: ${Status[status]} (${status})`);
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const currentProcess = Kernel32.GetCurrentProcess();

/** Copy `size` bytes from any in-process address into a fresh local Buffer. */
function readNativeMemory(address: bigint, size: number): Buffer {
  const out = Buffer.alloc(size);
  if (address !== 0n && size > 0) Kernel32.ReadProcessMemory(currentProcess, address, out.ptr!, BigInt(size), 0n);
  return out;
}

/** Read a NUL-terminated UTF-16LE string starting at an arbitrary address. */
function readWideStringAt(address: bigint, maxChars = 256): string {
  if (address === 0n) return '';
  const bytes = readNativeMemory(address, maxChars * 2);
  let end = 0;
  while (end < bytes.length - 1 && bytes.readUInt16LE(end) !== 0) end += 2;
  return bytes.toString('utf16le', 0, end);
}

/** Look up the W3C name of a WebAuthn HRESULT — the DLL owns the wchar buffer. */
function webAuthnErrorName(hr: number): string {
  const pointer = Webauthn.WebAuthNGetErrorName(hr | 0);
  return (pointer ? readWideStringAt(BigInt(pointer)) : '') || '(none)';
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase model — one entry per orb
// ──────────────────────────────────────────────────────────────────────────────

interface Phase {
  id: string;
  label: string;
  sublabel: string;
  /** 0 = pending, 1 = running, 2 = succeeded, 3 = failed */
  state: 0 | 1 | 2 | 3;
  /** Time (ms since epoch) the phase entered the `running` state. */
  startedAt: number;
  /** Time (ms since epoch) the phase finished. */
  finishedAt: number;
  /** Free-form one-line detail to display under the orb after completion. */
  detail: string;
  /** Hue used for the orb's color (HSV, 0..1). */
  hue: number;
}

const phases: Phase[] = [
  { id: 'a', label: 'challenge', sublabel: '32 bytes', state: 0, startedAt: 0, finishedAt: 0, detail: '', hue: 0.58 },
  { id: 'b', label: 'rp + user', sublabel: 'entities', state: 0, startedAt: 0, finishedAt: 0, detail: '', hue: 0.52 },
  { id: 'c', label: 'client data', sublabel: 'sha-256', state: 0, startedAt: 0, finishedAt: 0, detail: '', hue: 0.46 },
  { id: 'd', label: 'make credential', sublabel: 'hello prompt', state: 0, startedAt: 0, finishedAt: 0, detail: '', hue: 0.08 },
  { id: 'e', label: 'attestation', sublabel: 'aaguid', state: 0, startedAt: 0, finishedAt: 0, detail: '', hue: 0.14 },
  { id: 'f', label: 'new challenge', sublabel: '32 bytes', state: 0, startedAt: 0, finishedAt: 0, detail: '', hue: 0.74 },
  { id: 'g', label: 'get assertion', sublabel: 'hello prompt', state: 0, startedAt: 0, finishedAt: 0, detail: '', hue: 0.84 },
  { id: 'h', label: 'verify signature', sublabel: 'decode', state: 0, startedAt: 0, finishedAt: 0, detail: '', hue: 0.92 },
];

// Circular layout: equally spaced around the window center, with the first orb
// at the top and proceeding clockwise.
const ORB_CENTER_X = WINDOW_WIDTH / 2;
const ORB_CENTER_Y = WINDOW_HEIGHT / 2 + 20;
const ORB_RADIUS_LAYOUT = 220;
const ORB_RADIUS = 38;

function orbPosition(index: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index / phases.length) * Math.PI * 2;
  return {
    x: ORB_CENTER_X + Math.cos(angle) * ORB_RADIUS_LAYOUT,
    y: ORB_CENTER_Y + Math.sin(angle) * ORB_RADIUS_LAYOUT,
  };
}

// Particle bursts emitted when a phase completes.
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bornAt: number;
  life: number;
  hue: number;
}
const particles: Particle[] = [];

function emitBurst(originX: number, originY: number, hue: number, count = 40): void {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const direction = Math.random() * Math.PI * 2;
    const speed = 80 + Math.random() * 220;
    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(direction) * speed,
      vy: Math.sin(direction) * speed,
      bornAt: now,
      life: 900 + Math.random() * 600,
      hue: hue + (Math.random() - 0.5) * 0.08,
    });
  }
}

// Captions painted at the bottom of the window. They scroll up as new ones land.
const captions: string[] = [];
function pushCaption(text: string): void {
  captions.push(text);
  while (captions.length > 5) captions.shift();
}

// Display state visible to the renderer (set as the ceremony advances).
let credentialIdHex = '';
let credentialIdBytes: Buffer | null = null;
let summaryLines: string[] = [];
let pausedForHello = false;

// ──────────────────────────────────────────────────────────────────────────────
// HSV → ARGB helper (h, s, v ∈ [0, 1]; alpha ∈ [0, 255]).
// ──────────────────────────────────────────────────────────────────────────────

function hsvToArgb(h: number, s: number, v: number, alpha = 0xff): number {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return argb(alpha, Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

// ──────────────────────────────────────────────────────────────────────────────
// Bootstrap GDI+
// ──────────────────────────────────────────────────────────────────────────────

Gdiplus.Preload();
Webauthn.Preload(['WebAuthNAuthenticatorMakeCredential', 'WebAuthNAuthenticatorGetAssertion', 'WebAuthNFreeCredentialAttestation', 'WebAuthNFreeAssertion', 'WebAuthNGetErrorName']);
Bcrypt.Preload(['BCryptGenRandom', 'BCryptHash']);
Kernel32.Preload(['GetCurrentProcess', 'GetModuleHandleW', 'ReadProcessMemory']);

const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
checkStatus(Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr, gdiplusStartupInput.ptr, null), 'GdiplusStartup');
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

// ──────────────────────────────────────────────────────────────────────────────
// Window class + window creation
// ──────────────────────────────────────────────────────────────────────────────

let shouldClose = false;

const wndProcCallback = new JSCallback(
  (hWnd: bigint, msg: number, wParam: number | bigint, lParam: number | bigint): bigint => {
    if (msg === WM_KEYDOWN) {
      const virtualKey = Number(wParam);
      if (virtualKey === VirtualKey.VK_ESCAPE) {
        shouldClose = true;
        User32.PostQuitMessage(0);
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
    if (msg === WM_ERASEBKGND) {
      // We blit a full-window bitmap every frame; no need for the default erase
      // (avoids a flash of the system background between paints).
      return 1n;
    }
    return BigInt(User32.DefWindowProcW(hWnd, msg, BigInt(wParam), BigInt(lParam)));
  },
  { args: ['u64', 'u32', 'u64', 'i64'], returns: 'i64' },
);

const className = encodeWide('BunWebAuthnOrbs');

// WNDCLASSEXW = 80 bytes on x64.
const wndClassBuffer = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuffer.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassView.setUint32(4, 0, true); // style
wndClassBuffer.writeBigUInt64LE(BigInt(wndProcCallback.ptr!), 8); // lpfnWndProc
wndClassView.setInt32(16, 0, true); // cbClsExtra
wndClassView.setInt32(20, 0, true); // cbWndExtra
wndClassBuffer.writeBigUInt64LE(0n, 24); // hInstance
wndClassBuffer.writeBigUInt64LE(0n, 32); // hIcon
wndClassBuffer.writeBigUInt64LE(0n, 40); // hCursor
wndClassBuffer.writeBigUInt64LE(0n, 48); // hbrBackground (NULL — we paint everything)
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
const windowX = Math.floor((screenWidth - WINDOW_WIDTH) / 2);
const windowY = Math.floor((screenHeight - WINDOW_HEIGHT) / 2);

const moduleHandle = Kernel32.GetModuleHandleW(null!);

const windowHandle = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_APPWINDOW,
  className.ptr,
  encodeWide('WebAuthn Orbs — bun-win32').ptr,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  windowX,
  windowY,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  0n,
  0n,
  moduleHandle,
  null,
);
if (!windowHandle) {
  console.error('CreateWindowExW failed');
  process.exit(1);
}

// DWM Mica + dark mode for the borderless window backdrop.
const backdropAttribute = Buffer.alloc(4);
backdropAttribute.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdropAttribute.ptr, 4);

const darkModeAttribute = Buffer.alloc(4);
darkModeAttribute.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, darkModeAttribute.ptr, 4);

User32.ShowWindow(windowHandle, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(windowHandle);
User32.SetWindowLongPtrW(windowHandle, WindowLongIndex.GWL_WNDPROC, BigInt(wndProcCallback.ptr!));

// ──────────────────────────────────────────────────────────────────────────────
// Offscreen GDI+ bitmap + graphics
// ──────────────────────────────────────────────────────────────────────────────

const bitmapHandleBuffer = Buffer.alloc(8);
checkStatus(
  Gdiplus.GdipCreateBitmapFromScan0(WINDOW_WIDTH, WINDOW_HEIGHT, 0, PixelFormat32bppARGB, null, bitmapHandleBuffer.ptr),
  'GdipCreateBitmapFromScan0',
);
const offscreenBitmap = bitmapHandleBuffer.readBigUInt64LE(0);

const offscreenGraphicsHandleBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipGetImageGraphicsContext(offscreenBitmap, offscreenGraphicsHandleBuffer.ptr), 'GdipGetImageGraphicsContext');
const offscreenGraphics = offscreenGraphicsHandleBuffer.readBigUInt64LE(0);

checkStatus(Gdiplus.GdipSetSmoothingMode(offscreenGraphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
checkStatus(Gdiplus.GdipSetTextRenderingHint(offscreenGraphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit), 'GdipSetTextRenderingHint');

const fontFamilyHandleBuffer = Buffer.alloc(8);
const fontFamilyName = encodeWide('Segoe UI');
checkStatus(Gdiplus.GdipCreateFontFamilyFromName(fontFamilyName.ptr, 0n, fontFamilyHandleBuffer.ptr), 'GdipCreateFontFamilyFromName');
const fontFamily = fontFamilyHandleBuffer.readBigUInt64LE(0);

function createFont(sizePx: number, style: FontStyle): bigint {
  const fontBuffer = Buffer.alloc(8);
  checkStatus(Gdiplus.GdipCreateFont(fontFamily, sizePx, style, Unit.UnitPixel, fontBuffer.ptr), `GdipCreateFont(${sizePx})`);
  return fontBuffer.readBigUInt64LE(0);
}

const titleFont = createFont(28, FontStyle.FontStyleBold);
const subtitleFont = createFont(14, FontStyle.FontStyleRegular);
const orbLabelFont = createFont(13, FontStyle.FontStyleBold);
const orbSublabelFont = createFont(11, FontStyle.FontStyleRegular);
const detailFont = createFont(10, FontStyle.FontStyleRegular);
const helloPromptFont = createFont(22, FontStyle.FontStyleBold);
const captionFont = createFont(12, FontStyle.FontStyleRegular);
const summaryFont = createFont(13, FontStyle.FontStyleRegular);

const centerStringFormatBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipCreateStringFormat(0, 0, centerStringFormatBuffer.ptr), 'GdipCreateStringFormat (center)');
const centerStringFormat = centerStringFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(centerStringFormat, StringAlignment.StringAlignmentCenter);
Gdiplus.GdipSetStringFormatLineAlign(centerStringFormat, StringAlignment.StringAlignmentCenter);

const leftStringFormatBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipCreateStringFormat(0, 0, leftStringFormatBuffer.ptr), 'GdipCreateStringFormat (left)');
const leftStringFormat = leftStringFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(leftStringFormat, StringAlignment.StringAlignmentNear);
Gdiplus.GdipSetStringFormatLineAlign(leftStringFormat, StringAlignment.StringAlignmentNear);

// Reusable rectangle buffer for GDI+ text/brush calls — written per-call.
const reusableRect = Buffer.alloc(16);
function writeRect(x: number, y: number, w: number, h: number): Pointer {
  reusableRect.writeFloatLE(x, 0);
  reusableRect.writeFloatLE(y, 4);
  reusableRect.writeFloatLE(w, 8);
  reusableRect.writeFloatLE(h, 12);
  return reusableRect.ptr;
}

// Brush + text helpers that own their handles for the call.
function fillRectArgb(graphics: bigint, x: number, y: number, w: number, h: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(graphics, brush, x, y, w, h);
  Gdiplus.GdipDeleteBrush(brush);
}

function fillEllipseArgb(graphics: bigint, x: number, y: number, w: number, h: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillEllipse(graphics, brush, x, y, w, h);
  Gdiplus.GdipDeleteBrush(brush);
}

function drawCenteredText(graphics: bigint, text: string, font: bigint, x: number, y: number, width: number, height: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  const wideText = encodeWide(text);
  const rectPtr = writeRect(x, y, width, height);
  Gdiplus.GdipDrawString(graphics, wideText.ptr, -1, font, rectPtr, centerStringFormat, brush);
  Gdiplus.GdipDeleteBrush(brush);
}

function drawLeftText(graphics: bigint, text: string, font: bigint, x: number, y: number, width: number, height: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  const wideText = encodeWide(text);
  const rectPtr = writeRect(x, y, width, height);
  Gdiplus.GdipDrawString(graphics, wideText.ptr, -1, font, rectPtr, leftStringFormat, brush);
  Gdiplus.GdipDeleteBrush(brush);
}

// ──────────────────────────────────────────────────────────────────────────────
// Orb + beam rendering
// ──────────────────────────────────────────────────────────────────────────────

function renderOrb(graphics: bigint, index: number, time: number): void {
  const phase = phases[index]!;
  const { x, y } = orbPosition(index);

  let brightness = 0.18; // pending — dim
  let hueShift = 0;
  let outerAlpha = 70;
  let coreAlpha = 210;
  if (phase.state === 1) {
    // Pulsing while running.
    const pulse = (Math.sin(time * 4) + 1) * 0.5;
    brightness = 0.55 + pulse * 0.35;
    outerAlpha = 130 + Math.round(pulse * 80);
    coreAlpha = 255;
    hueShift = 0.0;
  } else if (phase.state === 2) {
    brightness = 0.78;
    outerAlpha = 150;
    coreAlpha = 255;
  } else if (phase.state === 3) {
    brightness = 0.55;
    outerAlpha = 110;
    coreAlpha = 220;
    hueShift = -0.5; // shift toward red for failures
  }
  const orbHue = (phase.hue + hueShift + 1) % 1;

  // Halo: a stack of larger discs with falling alpha. Each one is fully filled
  // with a solid color — the alpha gradient is implicit in the layering.
  const haloLayers = [
    { radius: ORB_RADIUS * 2.6, alpha: Math.round(outerAlpha * 0.10) },
    { radius: ORB_RADIUS * 2.0, alpha: Math.round(outerAlpha * 0.20) },
    { radius: ORB_RADIUS * 1.5, alpha: Math.round(outerAlpha * 0.35) },
    { radius: ORB_RADIUS * 1.2, alpha: Math.round(outerAlpha * 0.55) },
  ];
  for (const layer of haloLayers) {
    fillEllipseArgb(
      graphics,
      x - layer.radius,
      y - layer.radius,
      layer.radius * 2,
      layer.radius * 2,
      hsvToArgb(orbHue, 0.85, brightness * 0.85, layer.alpha),
    );
  }

  // Body: bright disc.
  fillEllipseArgb(
    graphics,
    x - ORB_RADIUS,
    y - ORB_RADIUS,
    ORB_RADIUS * 2,
    ORB_RADIUS * 2,
    hsvToArgb(orbHue, 0.55, brightness, coreAlpha),
  );

  // Specular highlight on the upper-left for a "lit sphere" feel.
  const highlightRadius = ORB_RADIUS * 0.55;
  fillEllipseArgb(
    graphics,
    x - highlightRadius * 0.4 - ORB_RADIUS * 0.25,
    y - highlightRadius * 0.6 - ORB_RADIUS * 0.25,
    highlightRadius,
    highlightRadius * 0.7,
    argb(Math.min(255, Math.round(coreAlpha * 0.55)), 0xff, 0xff, 0xff),
  );

  // Inner ring (a thin outline using DrawEllipse via FillEllipse + smaller fill).
  fillEllipseArgb(
    graphics,
    x - ORB_RADIUS,
    y - ORB_RADIUS,
    ORB_RADIUS * 2,
    ORB_RADIUS * 2,
    argb(60, 0xff, 0xff, 0xff),
  );
  fillEllipseArgb(
    graphics,
    x - ORB_RADIUS + 2,
    y - ORB_RADIUS + 2,
    (ORB_RADIUS - 2) * 2,
    (ORB_RADIUS - 2) * 2,
    hsvToArgb(orbHue, 0.55, brightness, coreAlpha),
  );

  // ID badge: a small white letter inside the orb (a, b, c, …).
  drawCenteredText(graphics, phase.id, orbLabelFont, x - 20, y - 14, 40, 20, argb(255, 0xff, 0xff, 0xff));

  // Label band underneath the orb.
  const labelY = y + ORB_RADIUS + 8;
  drawCenteredText(graphics, phase.label, orbLabelFont, x - 110, labelY, 220, 16, argb(230, 0xff, 0xff, 0xff));
  drawCenteredText(graphics, phase.sublabel, orbSublabelFont, x - 110, labelY + 16, 220, 14, argb(150, 0xff, 0xff, 0xff));
  if (phase.detail) {
    drawCenteredText(graphics, phase.detail, detailFont, x - 130, labelY + 32, 260, 14, argb(180, 0xff, 0xc8, 0x88));
  }
}

function renderBeam(graphics: bigint, fromIndex: number, toIndex: number, brightness: number, hue: number): void {
  const a = orbPosition(fromIndex);
  const b = orbPosition(toIndex);
  const alpha = Math.round(clamp(brightness, 0, 1) * 255);
  if (alpha < 8) return;

  // Soft underlay: thicker, lower alpha.
  const penBufferOuter = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(hsvToArgb(hue, 0.55, 0.95, Math.round(alpha * 0.35)), 6.0, Unit.UnitPixel, penBufferOuter.ptr);
  const outerPen = penBufferOuter.readBigUInt64LE(0);
  Gdiplus.GdipDrawLine(graphics, outerPen, a.x, a.y, b.x, b.y);
  Gdiplus.GdipDeletePen(outerPen);

  // Bright core: thinner, full alpha.
  const penBufferInner = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(hsvToArgb(hue, 0.30, 1.0, alpha), 1.4, Unit.UnitPixel, penBufferInner.ptr);
  const innerPen = penBufferInner.readBigUInt64LE(0);
  Gdiplus.GdipDrawLine(graphics, innerPen, a.x, a.y, b.x, b.y);
  Gdiplus.GdipDeletePen(innerPen);
}

function renderParticles(graphics: bigint): void {
  const now = Date.now();
  const dt = 1 / 60;
  for (let i = particles.length - 1; i >= 0; i--) {
    const particle = particles[i]!;
    const age = now - particle.bornAt;
    if (age > particle.life) {
      particles.splice(i, 1);
      continue;
    }
    const lifeFraction = age / particle.life;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= 0.96;
    particle.vy *= 0.96;
    const size = lerp(4.5, 0.5, lifeFraction);
    const alpha = Math.round(lerp(255, 0, lifeFraction));
    fillEllipseArgb(
      graphics,
      particle.x - size / 2,
      particle.y - size / 2,
      size,
      size,
      hsvToArgb(particle.hue, 0.40, 1.0, alpha),
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Identicon: render the credential id as a 4x4 colored dot grid next to its orb.
// ──────────────────────────────────────────────────────────────────────────────

function renderIdenticon(graphics: bigint): void {
  if (!credentialIdBytes || credentialIdBytes.length < 4) return;
  // Position: just to the right of orb [d] (make credential).
  const { x, y } = orbPosition(3);
  const cellSize = 9;
  const cellGap = 2;
  const gridSize = 4;
  const baseX = x + ORB_RADIUS + 18;
  const baseY = y - ((cellSize + cellGap) * gridSize) / 2;

  drawLeftText(graphics, 'id', detailFont, baseX, baseY - 14, 100, 14, argb(180, 0xff, 0xff, 0xff));

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const sourceIndex = (gy * gridSize + gx) % credentialIdBytes.length;
      const byte = credentialIdBytes[sourceIndex] ?? 0;
      const hue = (byte / 256 + 0.65) % 1;
      const saturation = 0.45 + ((byte >> 2) & 0x0f) / 30;
      const value = 0.55 + ((byte >> 5) & 0x07) / 15;
      const color = hsvToArgb(hue, clamp(saturation, 0.2, 1), clamp(value, 0.3, 1), 230);
      fillRectArgb(graphics, baseX + gx * (cellSize + cellGap), baseY + gy * (cellSize + cellGap), cellSize, cellSize, color);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Frame composer
// ──────────────────────────────────────────────────────────────────────────────

function renderFrame(): void {
  // Background gradient: deep midnight to muted indigo.
  Gdiplus.GdipGraphicsClear(offscreenGraphics, argb(255, 10, 12, 22));

  const time = Date.now() / 1000;

  // Soft radial vignette using stacked semi-transparent rectangles.
  const vignetteBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateLineBrushFromRectWithAngle(
    writeRect(0, 0, WINDOW_WIDTH, WINDOW_HEIGHT),
    argb(255, 14, 18, 32),
    argb(255, 6, 7, 14),
    90.0,
    1,
    0,
    vignetteBrushBuffer.ptr,
  );
  const vignetteBrush = vignetteBrushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(offscreenGraphics, vignetteBrush, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
  Gdiplus.GdipDeleteBrush(vignetteBrush);

  // Title.
  drawCenteredText(offscreenGraphics, 'WebAuthn Orbs', titleFont, 0, 24, WINDOW_WIDTH, 36, argb(245, 0xff, 0xee, 0xd6));
  drawCenteredText(
    offscreenGraphics,
    'real FIDO2 ceremony · windows hello · pure bun ffi',
    subtitleFont,
    0,
    60,
    WINDOW_WIDTH,
    20,
    argb(170, 0xff, 0xff, 0xff),
  );
  drawCenteredText(
    offscreenGraphics,
    `RP: ${RP_ID}   ·   WebAuthn API v${WEBAUTHN_API_CURRENT_VERSION}   ·   esc to quit`,
    subtitleFont,
    0,
    82,
    WINDOW_WIDTH,
    18,
    argb(110, 0xff, 0xff, 0xff),
  );

  // Outer guide ring (very dim).
  const guideRingPen = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(argb(40, 0xff, 0xff, 0xff), 1.0, Unit.UnitPixel, guideRingPen.ptr);
  const guidePen = guideRingPen.readBigUInt64LE(0);
  // Draw as a circle by stroking many small line segments around the layout center.
  const SEGMENTS = 96;
  for (let i = 0; i < SEGMENTS; i++) {
    const angle1 = (i / SEGMENTS) * Math.PI * 2;
    const angle2 = ((i + 1) / SEGMENTS) * Math.PI * 2;
    const x1 = ORB_CENTER_X + Math.cos(angle1) * ORB_RADIUS_LAYOUT;
    const y1 = ORB_CENTER_Y + Math.sin(angle1) * ORB_RADIUS_LAYOUT;
    const x2 = ORB_CENTER_X + Math.cos(angle2) * ORB_RADIUS_LAYOUT;
    const y2 = ORB_CENTER_Y + Math.sin(angle2) * ORB_RADIUS_LAYOUT;
    Gdiplus.GdipDrawLine(offscreenGraphics, guidePen, x1, y1, x2, y2);
  }
  Gdiplus.GdipDeletePen(guidePen);

  // Beams between consecutive completed orbs.
  for (let i = 0; i < phases.length - 1; i++) {
    const phaseFrom = phases[i]!;
    const phaseTo = phases[i + 1]!;
    if (phaseFrom.state >= 2) {
      const brightness = phaseTo.state === 0 ? 0.45 : phaseTo.state === 1 ? 0.85 : 1.0;
      const hue = (phaseFrom.hue + phaseTo.hue) / 2;
      renderBeam(offscreenGraphics, i, i + 1, brightness, hue);
    }
  }

  // Particles (drawn under the orbs so an orb obscures particles that overlap it).
  renderParticles(offscreenGraphics);

  // Orbs.
  for (let i = 0; i < phases.length; i++) renderOrb(offscreenGraphics, i, time);

  // Identicon next to orb [d].
  renderIdenticon(offscreenGraphics);

  // Caption strip at the bottom.
  const captionBaseY = WINDOW_HEIGHT - 110;
  for (let i = 0; i < captions.length; i++) {
    const alpha = Math.round(120 + i * 25);
    drawLeftText(
      offscreenGraphics,
      captions[i] ?? '',
      captionFont,
      40,
      captionBaseY + i * 16,
      WINDOW_WIDTH - 80,
      18,
      argb(Math.min(255, alpha), 0xff, 0xff, 0xff),
    );
  }

  // Summary lines at the bottom-right after the ceremony completes.
  if (summaryLines.length > 0) {
    const lineHeight = 18;
    const summaryBaseY = WINDOW_HEIGHT - 30 - summaryLines.length * lineHeight;
    for (let i = 0; i < summaryLines.length; i++) {
      drawLeftText(
        offscreenGraphics,
        summaryLines[i] ?? '',
        summaryFont,
        WINDOW_WIDTH - 380,
        summaryBaseY + i * lineHeight,
        360,
        lineHeight,
        argb(220, 0xa0, 0xff, 0xc0),
      );
    }
  }

  // If we're frozen waiting on Hello, paint the prompt prominently in the center.
  if (pausedForHello) {
    fillRectArgb(offscreenGraphics, 0, ORB_CENTER_Y - 60, WINDOW_WIDTH, 80, argb(170, 0, 0, 0));
    drawCenteredText(
      offscreenGraphics,
      'Verifying with Windows Hello…',
      helloPromptFont,
      0,
      ORB_CENTER_Y - 50,
      WINDOW_WIDTH,
      36,
      argb(255, 0xff, 0xc8, 0x6e),
    );
    drawCenteredText(
      offscreenGraphics,
      'approve the system prompt to continue the ceremony',
      subtitleFont,
      0,
      ORB_CENTER_Y - 16,
      WINDOW_WIDTH,
      20,
      argb(200, 0xff, 0xff, 0xff),
    );
  }

  blitToWindow();
}

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

// ──────────────────────────────────────────────────────────────────────────────
// Win32 message pumping helper — drain pending messages without blocking.
// ──────────────────────────────────────────────────────────────────────────────

const messageBuffer = Buffer.alloc(MSG_SIZE_BYTES);
const messageDataView = new DataView(messageBuffer.buffer);

function pumpMessages(): void {
  while (User32.PeekMessageW(messageBuffer.ptr, 0n, 0, 0, PeekMessageRemoveFlag.PM_REMOVE)) {
    const messageId = messageDataView.getUint32(8, true);
    if (messageId === WM_QUIT) {
      shouldClose = true;
      break;
    }
    User32.TranslateMessage(messageBuffer.ptr);
    User32.DispatchMessageW(messageBuffer.ptr);
  }
}

function paintAndPump(frames = 1, frameDelayMs = FRAME_BUDGET_MS): void {
  for (let i = 0; i < frames; i++) {
    pumpMessages();
    if (shouldClose) return;
    renderFrame();
    if (frameDelayMs > 0) Bun.sleepSync(frameDelayMs);
  }
}

function startPhase(index: number, captionText: string): void {
  const phase = phases[index]!;
  phase.state = 1;
  phase.startedAt = Date.now();
  pushCaption(captionText);
}

function completePhase(index: number, detail: string): void {
  const phase = phases[index]!;
  phase.state = 2;
  phase.finishedAt = Date.now();
  phase.detail = detail;
  const { x, y } = orbPosition(index);
  emitBurst(x, y, phase.hue, 48);
}

function failPhase(index: number, detail: string): void {
  const phase = phases[index]!;
  phase.state = 3;
  phase.finishedAt = Date.now();
  phase.detail = detail;
  const { x, y } = orbPosition(index);
  emitBurst(x, y, 0.02, 32); // red-ish burst
}

// Drain the queue while waiting for the user to perceive the burst.
function holdFor(durationMs: number): void {
  const deadline = Date.now() + durationMs;
  while (!shouldClose && Date.now() < deadline) {
    pumpMessages();
    if (shouldClose) return;
    renderFrame();
    Bun.sleepSync(FRAME_BUDGET_MS);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// The ceremony — drive each phase, animating between calls.
// ──────────────────────────────────────────────────────────────────────────────

function runCeremony(): void {
  // Brief intro: render the empty constellation for a moment.
  pushCaption('booting webauthn ceremony…');
  holdFor(800);
  if (shouldClose) return;

  // Phase A: 32 random bytes of challenge via BCryptGenRandom.
  startPhase(0, '[a] generating 32 random bytes via BCryptGenRandom…');
  holdFor(220);
  if (shouldClose) return;

  const challenge = Buffer.alloc(32);
  const randomStatus = Bcrypt.BCryptGenRandom(0n, challenge.ptr!, challenge.length, BCryptGenRandomFlags.BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  if (randomStatus !== 0) {
    failPhase(0, `BCryptGenRandom → 0x${(randomStatus >>> 0).toString(16)}`);
    pushCaption('[a] failed — aborting ceremony');
    holdFor(2000);
    return;
  }
  completePhase(0, `${base64url(challenge).slice(0, 24)}…`);
  pushCaption(`[a] challenge = ${challenge.toString('hex').slice(0, 16)}…`);
  holdFor(450);
  if (shouldClose) return;

  // Phase B: relying party + user entity.
  startPhase(1, '[b] building relying-party + user entities…');
  holdFor(220);
  if (shouldClose) return;

  const userId = Buffer.alloc(16);
  Bcrypt.BCryptGenRandom(0n, userId.ptr!, userId.length, BCryptGenRandomFlags.BCRYPT_USE_SYSTEM_PREFERRED_RNG);

  const wideRpId = encodeWide(RP_ID);
  const wideRpName = encodeWide(RP_NAME);

  // WEBAUTHN_RP_ENTITY_INFORMATION: dwVersion@0 pwszId@8 pwszName@16 pwszIcon@24 (32 bytes)
  const rpEntity = Buffer.alloc(32);
  rpEntity.writeUInt32LE(WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION, 0);
  rpEntity.writeBigUInt64LE(BigInt(wideRpId.ptr!), 8);
  rpEntity.writeBigUInt64LE(BigInt(wideRpName.ptr!), 16);

  const wideUserName = encodeWide(USER_NAME);
  const wideUserDisplay = encodeWide(USER_DISPLAY_NAME);

  // WEBAUTHN_USER_ENTITY_INFORMATION: dwVersion@0 cbId@4 pbId@8 pwszName@16 pwszIcon@24 pwszDisplayName@32 (40 bytes)
  const userEntity = Buffer.alloc(40);
  userEntity.writeUInt32LE(WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION, 0);
  userEntity.writeUInt32LE(userId.length, 4);
  userEntity.writeBigUInt64LE(BigInt(userId.ptr!), 8);
  userEntity.writeBigUInt64LE(BigInt(wideUserName.ptr!), 16);
  userEntity.writeBigUInt64LE(BigInt(wideUserDisplay.ptr!), 32);

  completePhase(1, `user id ${userId.toString('hex').slice(0, 14)}…`);
  pushCaption(`[b] rp="${RP_ID}"  user=${USER_DISPLAY_NAME}`);
  holdFor(450);
  if (shouldClose) return;

  // Phase C: clientDataJSON + SHA-256 hash (Bcrypt one-shot).
  startPhase(2, '[c] computing SHA-256 over clientDataJSON via BCryptHash…');
  holdFor(220);
  if (shouldClose) return;

  const clientJson = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: base64url(challenge),
      origin: `https://${RP_ID}`,
      crossOrigin: false,
    }),
    'utf8',
  );

  const sha256Out = Buffer.alloc(32);
  const hashStatus = Bcrypt.BCryptHash(BCRYPT_SHA256_ALG_HANDLE, null, 0, clientJson.ptr!, clientJson.length, sha256Out.ptr!, sha256Out.length);
  if (hashStatus !== 0) {
    failPhase(2, `BCryptHash → 0x${(hashStatus >>> 0).toString(16)}`);
    pushCaption('[c] hash failed — aborting');
    holdFor(2000);
    return;
  }

  // The WebAuthn API does its own hashing — we only echo the algorithm. But we
  // computed the hash here on purpose to demonstrate that bcrypt is in the same
  // pipeline (and to provide a meaningful display detail).
  const wideHashAlgorithm = encodeWide(WEBAUTHN_HASH_ALGORITHM_SHA_256);

  // WEBAUTHN_CLIENT_DATA: dwVersion@0 cbClientDataJSON@4 pbClientDataJSON@8 pwszHashAlgId@16 (24 bytes)
  const clientData = Buffer.alloc(24);
  clientData.writeUInt32LE(WEBAUTHN_CLIENT_DATA_CURRENT_VERSION, 0);
  clientData.writeUInt32LE(clientJson.length, 4);
  clientData.writeBigUInt64LE(BigInt(clientJson.ptr!), 8);
  clientData.writeBigUInt64LE(BigInt(wideHashAlgorithm.ptr!), 16);

  completePhase(2, `${sha256Out.toString('hex').slice(0, 16)}…`);
  pushCaption(`[c] clientData ${clientJson.length}B  ·  sha-256 ${sha256Out.toString('hex').slice(0, 12)}…`);
  holdFor(450);
  if (shouldClose) return;

  // Phase D: WebAuthNAuthenticatorMakeCredential — the Hello prompt fires.
  startPhase(3, '[d] calling WebAuthNAuthenticatorMakeCredential — Hello prompt…');
  holdFor(300);
  if (shouldClose) return;

  // Build the COSE algorithm parameter list (ES256, RS256).
  const widePubKeyType = encodeWide(WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY);
  const algorithms = [WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256, WEBAUTHN_COSE_ALGORITHM_RSASSA_PKCS1_V1_5_WITH_SHA256];
  const algorithmParams = Buffer.alloc(24 * algorithms.length);
  algorithms.forEach((alg, i) => {
    algorithmParams.writeUInt32LE(WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION, i * 24 + 0);
    algorithmParams.writeBigUInt64LE(BigInt(widePubKeyType.ptr!), i * 24 + 8);
    algorithmParams.writeInt32LE(alg, i * 24 + 16);
  });
  // WEBAUTHN_COSE_CREDENTIAL_PARAMETERS: cCredentialParameters@0 pCredentialParameters@8 (16 bytes)
  const coseParameters = Buffer.alloc(16);
  coseParameters.writeUInt32LE(algorithms.length, 0);
  coseParameters.writeBigUInt64LE(BigInt(algorithmParams.ptr!), 8);

  // WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS V1 (64 bytes, mostly zeroed).
  const makeCredentialOptions = Buffer.alloc(64);
  makeCredentialOptions.writeUInt32LE(WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_1, 0);
  makeCredentialOptions.writeUInt32LE(60_000, 4); // dwTimeoutMilliseconds
  makeCredentialOptions.writeUInt32LE(WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM, 40);
  makeCredentialOptions.writeUInt32LE(1, 44); // bRequireResidentKey
  makeCredentialOptions.writeUInt32LE(WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED, 48);
  makeCredentialOptions.writeUInt32LE(WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE, 52);

  const attestationOut = Buffer.alloc(8);

  // Paint the "Verifying with Windows Hello…" overlay so the user knows the
  // window is intentionally frozen. Hello pumps its own UI loop, so we can't
  // animate during the call — paint one final frame with the overlay flag set
  // and pump messages a few times to flush the WM_PAINT queue.
  pausedForHello = true;
  paintAndPump(4, 8);

  const makeHr = Webauthn.WebAuthNAuthenticatorMakeCredential(
    windowHandle,
    rpEntity.ptr!,
    userEntity.ptr!,
    coseParameters.ptr!,
    clientData.ptr!,
    makeCredentialOptions.ptr!,
    attestationOut.ptr!,
  );

  pausedForHello = false;

  if (makeHr !== 0) {
    failPhase(3, `0x${(makeHr >>> 0).toString(16)} ${webAuthnErrorName(makeHr)}`);
    pushCaption('[d] MakeCredential failed — common causes: cancelled, timed out, no Hello configured');
    summaryLines = [
      'ceremony aborted',
      `make credential: 0x${(makeHr >>> 0).toString(16)} ${webAuthnErrorName(makeHr)}`,
      'try again on a machine with Windows Hello enabled',
    ];
    holdFor(4500);
    return;
  }

  // Decode the WEBAUTHN_CREDENTIAL_ATTESTATION (96 bytes minimum):
  //   dwVersion@0 pwszFormatType@8 cbAuthData@16 pbAuthData@24
  //   cbAttestation@32 pbAttestation@40 dwAttestationDecodeType@48
  //   pvAttestationDecode@56 cbAttestationObject@64 pbAttestationObject@72
  //   cbCredentialId@80 pbCredentialId@88
  const attestationAddress = attestationOut.readBigUInt64LE(0);
  const attestationHeader = readNativeMemory(attestationAddress, 96);
  const formatType = readWideStringAt(attestationHeader.readBigUInt64LE(8));
  const cbAuthData = attestationHeader.readUInt32LE(16);
  const authData = readNativeMemory(attestationHeader.readBigUInt64LE(24), cbAuthData);
  const cbAttObj = attestationHeader.readUInt32LE(64);
  const cbCredId = attestationHeader.readUInt32LE(80);
  credentialIdBytes = readNativeMemory(attestationHeader.readBigUInt64LE(88), cbCredId);
  credentialIdHex = credentialIdBytes.toString('hex').toUpperCase();

  completePhase(3, `fmt: ${formatType || 'none'}`);
  pushCaption(`[d] passkey minted  ·  ${cbAttObj}B attestation  ·  ${cbCredId}B credential id`);
  holdFor(700);
  if (shouldClose) {
    Webauthn.WebAuthNFreeCredentialAttestation(attestationAddress);
    return;
  }

  // Phase E: decode the attestation — flags, signature counter, AAGUID.
  startPhase(4, '[e] decoding attestation: aaguid, flags, signature counter…');
  holdFor(200);

  // Authenticator data layout:
  //   rpIdHash[32] flags[1] signCount[4 BE] aaguid[16] credIdLen[2 BE] credId[…] cose-pub[…]
  const flagsByte = authData[32] ?? 0;
  const signCount = authData.length >= 37 ? authData.readUInt32BE(33) : 0;
  const aaguid = authData.subarray(37, 53);
  const aaguidString = `${aaguid.subarray(0, 4).toString('hex')}-${aaguid.subarray(4, 6).toString('hex')}-${aaguid.subarray(6, 8).toString('hex')}-${aaguid.subarray(8, 10).toString('hex')}-${aaguid.subarray(10, 16).toString('hex')}`;

  const flagNames: string[] = [];
  if (flagsByte & 0x01) flagNames.push('UP');
  if (flagsByte & 0x04) flagNames.push('UV');
  if (flagsByte & 0x08) flagNames.push('BE');
  if (flagsByte & 0x10) flagNames.push('BS');
  if (flagsByte & 0x40) flagNames.push('AT');
  if (flagsByte & 0x80) flagNames.push('ED');

  completePhase(4, `aaguid ${aaguidString.slice(0, 8)}…`);
  pushCaption(`[e] flags=${flagNames.join('|') || 'none'}  ·  signCount=${signCount}  ·  aaguid=${aaguidString.slice(0, 18)}…`);
  holdFor(700);

  if (shouldClose) {
    Webauthn.WebAuthNFreeCredentialAttestation(attestationAddress);
    return;
  }

  // Phase F: fresh 32-byte challenge for the assertion.
  startPhase(5, '[f] generating a new 32-byte challenge for the assertion…');
  holdFor(200);

  const assertionChallenge = Buffer.alloc(32);
  const assertionRandomStatus = Bcrypt.BCryptGenRandom(0n, assertionChallenge.ptr!, assertionChallenge.length, BCryptGenRandomFlags.BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  if (assertionRandomStatus !== 0) {
    failPhase(5, `BCryptGenRandom → 0x${(assertionRandomStatus >>> 0).toString(16)}`);
    pushCaption('[f] failed to generate assertion challenge');
    Webauthn.WebAuthNFreeCredentialAttestation(attestationAddress);
    holdFor(2000);
    return;
  }
  completePhase(5, `${base64url(assertionChallenge).slice(0, 24)}…`);
  pushCaption(`[f] new challenge ${assertionChallenge.toString('hex').slice(0, 16)}…`);
  holdFor(450);
  if (shouldClose) {
    Webauthn.WebAuthNFreeCredentialAttestation(attestationAddress);
    return;
  }

  // Phase G: WebAuthNAuthenticatorGetAssertion — second Hello prompt.
  startPhase(6, '[g] calling WebAuthNAuthenticatorGetAssertion — second Hello prompt…');
  holdFor(300);

  const assertionClientJson = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: base64url(assertionChallenge),
      origin: `https://${RP_ID}`,
      crossOrigin: false,
    }),
    'utf8',
  );

  const assertionClientData = Buffer.alloc(24);
  assertionClientData.writeUInt32LE(WEBAUTHN_CLIENT_DATA_CURRENT_VERSION, 0);
  assertionClientData.writeUInt32LE(assertionClientJson.length, 4);
  assertionClientData.writeBigUInt64LE(BigInt(assertionClientJson.ptr!), 8);
  assertionClientData.writeBigUInt64LE(BigInt(wideHashAlgorithm.ptr!), 16);

  // WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS V1 (56 bytes, zeroed):
  // dwVersion@0 dwTimeout@4 CredentialList@8 Extensions@24 attachment@40 uv@44 flags@48.
  // An empty credential list performs a discoverable lookup by RP id.
  const getAssertionOptions = Buffer.alloc(56);
  getAssertionOptions.writeUInt32LE(WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_1, 0);
  getAssertionOptions.writeUInt32LE(60_000, 4);
  getAssertionOptions.writeUInt32LE(WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED, 44);

  const assertionOut = Buffer.alloc(8);

  // Reuse the wideRpId from phase B for the discoverable lookup.
  pausedForHello = true;
  paintAndPump(4, 8);

  const getHr = Webauthn.WebAuthNAuthenticatorGetAssertion(
    windowHandle,
    wideRpId.ptr!,
    assertionClientData.ptr!,
    getAssertionOptions.ptr!,
    assertionOut.ptr!,
  );

  pausedForHello = false;

  if (getHr !== 0) {
    failPhase(6, `0x${(getHr >>> 0).toString(16)} ${webAuthnErrorName(getHr)}`);
    pushCaption(`[g] GetAssertion failed: ${webAuthnErrorName(getHr)}`);
    summaryLines = [
      'ceremony partially complete',
      `passkey minted: ${credentialIdHex.slice(0, 16)}…`,
      `assertion failed: ${webAuthnErrorName(getHr)}`,
    ];
    Webauthn.WebAuthNFreeCredentialAttestation(attestationAddress);
    holdFor(4500);
    return;
  }

  completePhase(6, 'signed');
  pushCaption('[g] passkey signed the challenge');
  holdFor(450);
  if (shouldClose) {
    Webauthn.WebAuthNFreeAssertion(assertionOut.readBigUInt64LE(0));
    Webauthn.WebAuthNFreeCredentialAttestation(attestationAddress);
    return;
  }

  // Phase H: verify (decode) the assertion bytes and bind back to the credential.
  startPhase(7, '[h] decoding assertion: signature bytes + credential echo…');
  holdFor(220);

  // WEBAUTHN_ASSERTION layout (≥72 bytes):
  //   dwVersion@0 cbAuthenticatorData@4 pbAuthenticatorData@8 cbSignature@16 pbSignature@24
  //   Credential.dwVersion@32 cbCredId@36 pbCredId@40 …
  const assertionAddress = assertionOut.readBigUInt64LE(0);
  const assertion = readNativeMemory(assertionAddress, 72);
  const cbAssertionAuthData = assertion.readUInt32LE(4);
  const cbSignature = assertion.readUInt32LE(16);
  const signature = readNativeMemory(assertion.readBigUInt64LE(24), cbSignature);
  const echoedCredentialIdLen = assertion.readUInt32LE(36);
  const echoedCredentialId = readNativeMemory(assertion.readBigUInt64LE(40), echoedCredentialIdLen);

  const credentialMatch = echoedCredentialId.equals(credentialIdBytes ?? Buffer.alloc(0));

  completePhase(7, `sig ${cbSignature}B  ·  ${credentialMatch ? 'matches' : 'mismatch'}`);
  pushCaption(`[h] signature ${cbSignature}B (DER ECDSA/PKCS#1)  ·  authData ${cbAssertionAuthData}B`);
  holdFor(400);

  // Final summary.
  summaryLines = [
    'ceremony complete',
    `passkey id   ${credentialIdHex.slice(0, 22)}…`,
    `aaguid       ${aaguidString}`,
    `signature    ${cbSignature} bytes (${signature.toString('hex').slice(0, 12)}…)`,
    `credential   ${credentialMatch ? 'verified' : 'MISMATCH'}`,
  ];

  pushCaption('ceremony complete  ·  press esc to close the window');

  Webauthn.WebAuthNFreeAssertion(assertionAddress);
  Webauthn.WebAuthNFreeCredentialAttestation(attestationAddress);

  // Hold the final frame so the user can read the summary.
  holdFor(20_000);
}

// ──────────────────────────────────────────────────────────────────────────────
// Drive the ceremony — runs synchronously so all FFI buffer addresses stay live
// (no awaits between struct assembly and the blocking calls).
// ──────────────────────────────────────────────────────────────────────────────

try {
  runCeremony();

  // After the ceremony either finishes or aborts, idle until the user closes.
  while (!shouldClose) {
    pumpMessages();
    if (shouldClose) break;
    renderFrame();
    Bun.sleepSync(FRAME_BUDGET_MS);
  }
} finally {
  // Tear down everything in reverse order.
  Gdiplus.GdipDeleteStringFormat(centerStringFormat);
  Gdiplus.GdipDeleteStringFormat(leftStringFormat);
  Gdiplus.GdipDeleteFont(titleFont);
  Gdiplus.GdipDeleteFont(subtitleFont);
  Gdiplus.GdipDeleteFont(orbLabelFont);
  Gdiplus.GdipDeleteFont(orbSublabelFont);
  Gdiplus.GdipDeleteFont(detailFont);
  Gdiplus.GdipDeleteFont(helloPromptFont);
  Gdiplus.GdipDeleteFont(captionFont);
  Gdiplus.GdipDeleteFont(summaryFont);
  Gdiplus.GdipDeleteFontFamily(fontFamily);
  Gdiplus.GdipDeleteGraphics(offscreenGraphics);
  Gdiplus.GdipDisposeImage(offscreenBitmap);
  Gdiplus.GdiplusShutdown(gdiplusToken);

  if (windowHandle) User32.DestroyWindow(windowHandle);
  User32.UnregisterClassW(className.ptr, 0n);
  wndProcCallback.close();
}
