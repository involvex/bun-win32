/**
 * Network Aurora — every TCP/UDP connection on the machine flowing as light
 *
 * A live, glanceable visualization of the OS networking stack: each active
 * connection (TCP v4/v6, UDP v4/v6) becomes a band of particles arcing from a
 * glowing "this machine" anchor at the center of a borderless 1280x900 window
 * to a position on the outer ring whose angle is determined by a stable hash
 * of the remote IP and port. ~60 fps GDI+ render loop; the network state is
 * resampled once per second via the IP Helper API. The hook: you can watch
 * every byte of traffic that leaves your machine arc across the sky.
 *
 * Pipeline:
 *
 *   1. User32.RegisterClassExW + CreateWindowExW       — borderless WS_POPUP window
 *   2. Dwmapi.DwmSetWindowAttribute                    — Mica backdrop + dark mode
 *   3. Gdiplus.GdiplusStartup + GdipCreateBitmapFromScan0 — 32bpp ARGB offscreen bitmap
 *   4. Iphlpapi.GetExtendedTcpTable (AF_INET + AF_INET6) — owner-PID TCP tables
 *      Iphlpapi.GetExtendedUdpTable (AF_INET + AF_INET6) — owner-PID UDP tables
 *   5. Hash remote endpoint → outer-ring angle θ; spawn one particle stream per
 *      connection that flows from the center along a randomized Bezier
 *      to the outer point on the ring, fading to alpha 0 at the end.
 *   6. Kernel32.OpenProcess + Psapi.GetModuleBaseNameW — owner process name cache
 *   7. Each frame: clear → draw aurora bands → composite glow → blit to HDC.
 *   8. ESC / Q / window close exits cleanly.
 *
 * APIs demonstrated:
 *   - Iphlpapi.GetExtendedTcpTable                     (IPv4 + IPv6 owner-PID tables)
 *   - Iphlpapi.GetExtendedUdpTable                     (IPv4 + IPv6 owner-PID tables)
 *   - Kernel32.OpenProcess / Kernel32.CloseHandle      (per-PID handle for lookup)
 *   - Psapi.GetModuleBaseNameW                         (executable base name)
 *   - User32.RegisterClassExW / CreateWindowExW        (borderless top-level window)
 *   - User32.SetWindowLongPtrW                         (late-bind the WndProc)
 *   - User32.PeekMessageW / TranslateMessage / DispatchMessageW — non-blocking pump
 *   - User32.GetDC / ReleaseDC / GetSystemMetrics / DestroyWindow
 *   - Dwmapi.DwmSetWindowAttribute                     (Mica + immersive dark mode)
 *   - Gdiplus.GdiplusStartup / GdiplusShutdown
 *   - Gdiplus.GdipCreateBitmapFromScan0 / GdipGetImageGraphicsContext
 *   - Gdiplus.GdipSetSmoothingMode / GdipSetTextRenderingHint
 *   - Gdiplus.GdipGraphicsClear / GdipFillRectangle / GdipFillEllipse
 *   - Gdiplus.GdipCreateSolidFill / GdipCreatePen1 / GdipDrawBezier
 *   - Gdiplus.GdipCreateFontFamilyFromName / GdipCreateFont / GdipDrawString
 *   - Gdiplus.GdipCreateFromHDC / GdipDrawImageRectI / GdipDeleteGraphics
 *
 * MIB_TCPROW_OWNER_PID (24 bytes, x64):
 *   +0x00  dwState        UINT32  (TCP state, MIB_TCP_STATE_*)
 *   +0x04  dwLocalAddr    UINT32  (IPv4 address, network byte order)
 *   +0x08  dwLocalPort    UINT32  (port in low 16 bits, network byte order)
 *   +0x0C  dwRemoteAddr   UINT32  (IPv4 address, network byte order)
 *   +0x10  dwRemotePort   UINT32  (port in low 16 bits, network byte order)
 *   +0x14  dwOwningPid    UINT32  (owning process ID)
 *
 * MIB_UDPROW_OWNER_PID (12 bytes, x64):
 *   +0x00  dwLocalAddr    UINT32
 *   +0x04  dwLocalPort    UINT32
 *   +0x08  dwOwningPid    UINT32
 *
 * MIB_TCP6ROW_OWNER_PID (56 bytes, x64):
 *   +0x00  ucLocalAddr    UCHAR[16]
 *   +0x10  dwLocalScopeId UINT32
 *   +0x14  dwLocalPort    UINT32
 *   +0x18  ucRemoteAddr   UCHAR[16]
 *   +0x28  dwRemoteScopeId UINT32
 *   +0x2C  dwRemotePort   UINT32
 *   +0x30  dwState        UINT32
 *   +0x34  dwOwningPid    UINT32
 *
 * MIB_UDP6ROW_OWNER_PID (28 bytes, x64):
 *   +0x00  ucLocalAddr    UCHAR[16]
 *   +0x10  dwLocalScopeId UINT32
 *   +0x14  dwLocalPort    UINT32
 *   +0x18  dwOwningPid    UINT32
 *
 * Controls:
 *   - ESC / Q              quit
 *
 * Run: bun run example/network-aurora.ts
 */

import { FFIType, JSCallback, type Pointer } from 'bun:ffi';

import { Dwmapi, Gdiplus, Iphlpapi, Kernel32, Psapi, User32 } from '../index';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { FontStyle, PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { AddressFamily, TcpTableClass, UdpTableClass } from '@bun-win32/iphlpapi';
import { ProcessAccessRights } from '@bun-win32/kernel32';
import { ExtendedWindowStyles, PeekMessageRemoveFlag, ShowWindowCommand, SystemMetric, VirtualKey, WindowLongIndex, WindowStyles } from '@bun-win32/user32';

// ── Geometry + render constants ───────────────────────────────────────────────

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 900;
const CENTER_X = WINDOW_WIDTH / 2;
const CENTER_Y = WINDOW_HEIGHT / 2;
const OUTER_RADIUS = 380;
const INNER_RADIUS = 28;
const FRAME_BUDGET_MS = 16; // ~60 fps
const NETWORK_REFRESH_MS = 1000;

// ── Win32 message constants ──────────────────────────────────────────────────

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_QUIT = 0x0012;
const MSG_SIZE_BYTES = 48;

// ── TCP states (MIB_TCP_STATE) ───────────────────────────────────────────────

const TCP_STATE_CLOSED = 1;
const TCP_STATE_LISTEN = 2;
const TCP_STATE_SYN_SENT = 3;
const TCP_STATE_SYN_RCVD = 4;
const TCP_STATE_ESTABLISHED = 5;
const TCP_STATE_FIN_WAIT1 = 6;
const TCP_STATE_FIN_WAIT2 = 7;
const TCP_STATE_CLOSE_WAIT = 8;
const TCP_STATE_CLOSING = 9;
const TCP_STATE_LAST_ACK = 10;
const TCP_STATE_TIME_WAIT = 11;

const TCP_STATE_NAMES = new Map<number, string>([
  [TCP_STATE_CLOSED, 'CLOSED'],
  [TCP_STATE_LISTEN, 'LISTEN'],
  [TCP_STATE_SYN_SENT, 'SYN_SENT'],
  [TCP_STATE_SYN_RCVD, 'SYN_RCVD'],
  [TCP_STATE_ESTABLISHED, 'ESTABLISHED'],
  [TCP_STATE_FIN_WAIT1, 'FIN_WAIT1'],
  [TCP_STATE_FIN_WAIT2, 'FIN_WAIT2'],
  [TCP_STATE_CLOSE_WAIT, 'CLOSE_WAIT'],
  [TCP_STATE_CLOSING, 'CLOSING'],
  [TCP_STATE_LAST_ACK, 'LAST_ACK'],
  [TCP_STATE_TIME_WAIT, 'TIME_WAIT'],
]);

// ── Color palette (ARGB) ─────────────────────────────────────────────────────

const argb = (alpha: number, red: number, green: number, blue: number): number =>
  (((alpha & 0xff) << 24) | ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)) >>> 0;

const COLOR_ESTABLISHED = { red: 0x4d, green: 0xe0, blue: 0xff }; // cyan
const COLOR_LISTEN = { red: 0xff, green: 0xd9, blue: 0x47 }; // yellow
const COLOR_TRANSIENT = { red: 0xff, green: 0x9a, blue: 0x3c }; // orange (TIME_WAIT/CLOSE_WAIT/etc.)
const COLOR_UDP = { red: 0xc9, green: 0x7a, blue: 0xff }; // violet
const COLOR_FALLBACK = { red: 0x7c, green: 0x8c, blue: 0xa6 }; // muted grey-blue
const COLOR_ANCHOR = { red: 0xff, green: 0xff, blue: 0xff };

// ── Small helpers ────────────────────────────────────────────────────────────

const encodeWide = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');

function check(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} failed: ${Status[status]} (${status})`);
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

// FNV-1a 32-bit hash. Stable across runs, fast, and uniform enough to spread
// connection endpoints around the outer ring.
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

// Convert a network-order DWORD into "a.b.c.d". Per MSDN, dwLocalAddr is stored
// in network byte order so the IPv4 bytes are laid out from least-significant.
function formatIpv4(networkOrder: number): string {
  return `${networkOrder & 0xff}.${(networkOrder >>> 8) & 0xff}.${(networkOrder >>> 16) & 0xff}.${(networkOrder >>> 24) & 0xff}`;
}

// Convert a DWORD whose low 16 bits hold a network-order port into a host-order port.
function formatPortFromDword(dword: number): number {
  return ((dword & 0xff) << 8) | ((dword >>> 8) & 0xff);
}

// Render a 16-byte IPv6 address from a Buffer slice into compact form. We do
// not attempt to insert the "::" zero-run abbreviation; this is for display
// hashing only.
function formatIpv6(buffer: Buffer, offset: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    const word = (buffer.readUInt8(offset + i * 2) << 8) | buffer.readUInt8(offset + i * 2 + 1);
    groups.push(word.toString(16));
  }
  return groups.join(':');
}

// ── Bootstrap GDI+ ───────────────────────────────────────────────────────────

console.log('Network Aurora — booting GDI+…');

Gdiplus.Preload();
const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
check(Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr, gdiplusStartupInput.ptr, null), 'GdiplusStartup');
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

// ── Win32 window ─────────────────────────────────────────────────────────────

let shouldClose = false;

const wndProcCallback = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_KEYDOWN) {
      const virtualKey = Number(wParam);
      if (virtualKey === VirtualKey.VK_ESCAPE || virtualKey === 0x51 /* 'Q' */) {
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
    return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
  },
  { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
);

const className = encodeWide('NetworkAurora');

const wndClassBuffer = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuffer.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassView.setUint32(4, 0, true); // style
wndClassBuffer.writeBigUInt64LE(BigInt(wndProcCallback.ptr!), 8); // lpfnWndProc
wndClassView.setInt32(16, 0, true);
wndClassView.setInt32(20, 0, true);
wndClassBuffer.writeBigUInt64LE(0n, 24);
wndClassBuffer.writeBigUInt64LE(0n, 32);
wndClassBuffer.writeBigUInt64LE(0n, 40);
wndClassBuffer.writeBigUInt64LE(0n, 48);
wndClassBuffer.writeBigUInt64LE(0n, 56);
wndClassBuffer.writeBigUInt64LE(BigInt(className.ptr), 64);
wndClassBuffer.writeBigUInt64LE(0n, 72);

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
  encodeWide('Network Aurora').ptr,
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

// Mica backdrop + immersive dark mode through DWM.
const backdropAttribute = Buffer.alloc(4);
backdropAttribute.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdropAttribute.ptr, 4);

const darkModeAttribute = Buffer.alloc(4);
darkModeAttribute.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, darkModeAttribute.ptr, 4);

User32.ShowWindow(windowHandle, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(windowHandle);

// Bind WndProc late after the window exists (matches the demoscene reference).
User32.SetWindowLongPtrW(windowHandle, WindowLongIndex.GWL_WNDPROC, BigInt(wndProcCallback.ptr!));

// ── Offscreen GDI+ bitmap ────────────────────────────────────────────────────

const bitmapHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateBitmapFromScan0(WINDOW_WIDTH, WINDOW_HEIGHT, 0, PixelFormat32bppARGB, null, bitmapHandleBuffer.ptr), 'GdipCreateBitmapFromScan0');
const offscreenBitmap = bitmapHandleBuffer.readBigUInt64LE(0);

const offscreenGraphicsHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipGetImageGraphicsContext(offscreenBitmap, offscreenGraphicsHandleBuffer.ptr), 'GdipGetImageGraphicsContext');
const offscreenGraphics = offscreenGraphicsHandleBuffer.readBigUInt64LE(0);

check(Gdiplus.GdipSetSmoothingMode(offscreenGraphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
check(Gdiplus.GdipSetTextRenderingHint(offscreenGraphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit), 'GdipSetTextRenderingHint');

// Fonts.
const fontFamilyHandleBuffer = Buffer.alloc(8);
const fontFamilyName = encodeWide('Segoe UI');
check(Gdiplus.GdipCreateFontFamilyFromName(fontFamilyName.ptr, 0n, fontFamilyHandleBuffer.ptr), 'GdipCreateFontFamilyFromName');
const fontFamily = fontFamilyHandleBuffer.readBigUInt64LE(0);

function makeFont(sizePx: number, style: FontStyle): bigint {
  const buffer = Buffer.alloc(8);
  check(Gdiplus.GdipCreateFont(fontFamily, sizePx, style, Unit.UnitPixel, buffer.ptr), `GdipCreateFont(${sizePx})`);
  return buffer.readBigUInt64LE(0);
}

const titleFont = makeFont(22, FontStyle.FontStyleBold);
const labelFont = makeFont(14, FontStyle.FontStyleRegular);
const hudFont = makeFont(12, FontStyle.FontStyleRegular);

const leftFormatBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateStringFormat(0, 0, leftFormatBuffer.ptr), 'GdipCreateStringFormat');
const leftStringFormat = leftFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(leftStringFormat, StringAlignment.StringAlignmentNear);
Gdiplus.GdipSetStringFormatLineAlign(leftStringFormat, StringAlignment.StringAlignmentNear);

// Reusable rect buffer for text layout calls.
const reusableRect = Buffer.alloc(16);
function writeRect(x: number, y: number, w: number, h: number): Pointer {
  reusableRect.writeFloatLE(x, 0);
  reusableRect.writeFloatLE(y, 4);
  reusableRect.writeFloatLE(w, 8);
  reusableRect.writeFloatLE(h, 12);
  return reusableRect.ptr;
}

function fillRectArgb(graphics: bigint, x: number, y: number, width: number, height: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(graphics, brush, x, y, width, height);
  Gdiplus.GdipDeleteBrush(brush);
}

function fillEllipseArgb(graphics: bigint, x: number, y: number, width: number, height: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillEllipse(graphics, brush, x, y, width, height);
  Gdiplus.GdipDeleteBrush(brush);
}

function drawText(graphics: bigint, text: string, font: bigint, x: number, y: number, width: number, height: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  const wideText = encodeWide(text);
  const rectPtr = writeRect(x, y, width, height);
  Gdiplus.GdipDrawString(graphics, wideText.ptr, -1, font, rectPtr, leftStringFormat, brush);
  Gdiplus.GdipDeleteBrush(brush);
}

// ── Connection model ─────────────────────────────────────────────────────────

type ConnectionKind = 'tcp4' | 'tcp6' | 'udp4' | 'udp6';

interface Connection {
  key: string;          // stable identity for diffing across polls
  kind: ConnectionKind;
  state: number;        // TCP only; UDP uses 0
  localDisplay: string; // "a.b.c.d:port" or "[v6]:port"
  remoteDisplay: string;
  hashSeed: string;     // input to the angle hash
  pid: number;
  isListener: boolean;
}

interface AuroraBand {
  // Identity + classification
  connection: Connection;

  // Geometry — frozen at spawn so the band doesn't twitch each frame.
  endpointX: number;
  endpointY: number;
  controlAX: number;
  controlAY: number;
  controlBX: number;
  controlBY: number;

  // Color (per-band so transient states glow consistently across frames)
  baseRed: number;
  baseGreen: number;
  baseBlue: number;

  // Animation
  particles: Float32Array; // (progress, jitter, brightness) per particle, 3 floats each
  spawnAccumulator: number;
}

const PARTICLES_PER_BAND = 24;
const PARTICLE_FLOATS = 3;
const PARTICLE_SPEED = 0.42; // progress units per second

// Pick the band color from connection kind + state.
function colorForConnection(connection: Connection): { red: number; green: number; blue: number } {
  if (connection.kind === 'udp4' || connection.kind === 'udp6') return COLOR_UDP;
  if (connection.state === TCP_STATE_ESTABLISHED) return COLOR_ESTABLISHED;
  if (connection.state === TCP_STATE_LISTEN) return COLOR_LISTEN;
  if (
    connection.state === TCP_STATE_TIME_WAIT ||
    connection.state === TCP_STATE_CLOSE_WAIT ||
    connection.state === TCP_STATE_FIN_WAIT1 ||
    connection.state === TCP_STATE_FIN_WAIT2 ||
    connection.state === TCP_STATE_LAST_ACK ||
    connection.state === TCP_STATE_CLOSING
  ) return COLOR_TRANSIENT;
  return COLOR_FALLBACK;
}

function createBand(connection: Connection): AuroraBand {
  const seedHash = hashString(connection.hashSeed);
  // Map hash → angle in [0, 2π). Use 32-bit hash divided by 2^32.
  const angle = (seedHash / 0x1_0000_0000) * Math.PI * 2;
  // Listeners are anchored a touch inside the outer ring; transient/established
  // sit on the ring proper.
  const radius = connection.isListener ? OUTER_RADIUS * 0.86 : OUTER_RADIUS;
  const endpointX = CENTER_X + Math.cos(angle) * radius;
  const endpointY = CENTER_Y + Math.sin(angle) * radius;

  // Bezier control points: perpendicular wobble derived from the same hash so
  // each band has a unique but stable arc shape.
  const wobbleSign = (seedHash & 1) === 0 ? 1 : -1;
  const wobbleMagnitude = 80 + (seedHash >>> 8) % 140;
  const perpX = -Math.sin(angle) * wobbleMagnitude * wobbleSign;
  const perpY = Math.cos(angle) * wobbleMagnitude * wobbleSign;

  // Control A is one-third along the straight line, displaced perpendicular.
  // Control B is two-thirds along, displaced perpendicular the opposite way.
  const dx = endpointX - CENTER_X;
  const dy = endpointY - CENTER_Y;
  const controlAX = CENTER_X + dx * 0.33 + perpX;
  const controlAY = CENTER_Y + dy * 0.33 + perpY;
  const controlBX = CENTER_X + dx * 0.66 - perpX * 0.5;
  const controlBY = CENTER_Y + dy * 0.66 - perpY * 0.5;

  const baseColor = colorForConnection(connection);

  const particles = new Float32Array(PARTICLES_PER_BAND * PARTICLE_FLOATS);
  for (let i = 0; i < PARTICLES_PER_BAND; i++) {
    particles[i * PARTICLE_FLOATS + 0] = -1; // inactive until spawn
    particles[i * PARTICLE_FLOATS + 1] = 0;
    particles[i * PARTICLE_FLOATS + 2] = 0;
  }

  return {
    connection,
    endpointX,
    endpointY,
    controlAX,
    controlAY,
    controlBX,
    controlBY,
    baseRed: baseColor.red,
    baseGreen: baseColor.green,
    baseBlue: baseColor.blue,
    particles,
    spawnAccumulator: 0,
  };
}

// Sample a cubic Bezier defined by (p0, controlA, controlB, p1) at parameter t.
function bezierSample(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// ── IP Helper queries ────────────────────────────────────────────────────────

// Generic helper: call a sizing function with NULL, allocate, call again.
function loadExtendedTcpTable(addressFamily: number): Buffer | null {
  const sizeBuffer = Buffer.alloc(4);
  sizeBuffer.writeUInt32LE(0, 0);
  let result = Iphlpapi.GetExtendedTcpTable(null, sizeBuffer.ptr, 0, addressFamily, TcpTableClass.TCP_TABLE_OWNER_PID_ALL, 0);
  // Expected return: ERROR_INSUFFICIENT_BUFFER (122) or ERROR_BUFFER_OVERFLOW (111)
  // when sizing. NO_ERROR (0) implies no entries.
  if (result !== 122 && result !== 111 && result !== 0) return null;
  const size = sizeBuffer.readUInt32LE(0);
  if (size === 0) return Buffer.alloc(4); // empty table; 4 bytes for dwNumEntries=0
  const tableBuffer = Buffer.alloc(size);
  result = Iphlpapi.GetExtendedTcpTable(tableBuffer.ptr, sizeBuffer.ptr, 0, addressFamily, TcpTableClass.TCP_TABLE_OWNER_PID_ALL, 0);
  if (result !== 0) return null;
  return tableBuffer;
}

function loadExtendedUdpTable(addressFamily: number): Buffer | null {
  const sizeBuffer = Buffer.alloc(4);
  sizeBuffer.writeUInt32LE(0, 0);
  let result = Iphlpapi.GetExtendedUdpTable(null, sizeBuffer.ptr, 0, addressFamily, UdpTableClass.UDP_TABLE_OWNER_PID, 0);
  if (result !== 122 && result !== 111 && result !== 0) return null;
  const size = sizeBuffer.readUInt32LE(0);
  if (size === 0) return Buffer.alloc(4);
  const tableBuffer = Buffer.alloc(size);
  result = Iphlpapi.GetExtendedUdpTable(tableBuffer.ptr, sizeBuffer.ptr, 0, addressFamily, UdpTableClass.UDP_TABLE_OWNER_PID, 0);
  if (result !== 0) return null;
  return tableBuffer;
}

function parseTcp4(tableBuffer: Buffer, sink: Connection[]): void {
  // MIB_TCPTABLE_OWNER_PID: dwNumEntries (4) + MIB_TCPROW_OWNER_PID[] (24 bytes each)
  const entries = tableBuffer.readUInt32LE(0);
  for (let i = 0; i < entries; i++) {
    const rowOffset = 4 + i * 24;
    const state = tableBuffer.readUInt32LE(rowOffset);
    const localAddr = tableBuffer.readUInt32LE(rowOffset + 4);
    const localPortRaw = tableBuffer.readUInt32LE(rowOffset + 8);
    const remoteAddr = tableBuffer.readUInt32LE(rowOffset + 12);
    const remotePortRaw = tableBuffer.readUInt32LE(rowOffset + 16);
    const pid = tableBuffer.readUInt32LE(rowOffset + 20);

    const localPort = formatPortFromDword(localPortRaw);
    const remotePort = formatPortFromDword(remotePortRaw);
    const localIp = formatIpv4(localAddr);
    const remoteIp = formatIpv4(remoteAddr);
    const isListener = state === TCP_STATE_LISTEN;
    // Listeners have a zero remote endpoint; hash on local port + pid so
    // multiple listeners spread around the ring rather than piling up at 0.
    const hashSeed = isListener
      ? `LISTEN:${localIp}:${localPort}:${pid}`
      : `${remoteIp}:${remotePort}`;

    sink.push({
      key: `tcp4|${localIp}:${localPort}|${remoteIp}:${remotePort}|${pid}|${state}`,
      kind: 'tcp4',
      state,
      localDisplay: `${localIp}:${localPort}`,
      remoteDisplay: isListener ? '*:*' : `${remoteIp}:${remotePort}`,
      hashSeed,
      pid,
      isListener,
    });
  }
}

function parseTcp6(tableBuffer: Buffer, sink: Connection[]): void {
  // MIB_TCP6TABLE_OWNER_PID: dwNumEntries (4) + MIB_TCP6ROW_OWNER_PID[] (56 bytes each)
  const entries = tableBuffer.readUInt32LE(0);
  for (let i = 0; i < entries; i++) {
    const rowOffset = 4 + i * 56;
    const localIp = formatIpv6(tableBuffer, rowOffset + 0);
    const localPort = formatPortFromDword(tableBuffer.readUInt32LE(rowOffset + 20));
    const remoteIp = formatIpv6(tableBuffer, rowOffset + 24);
    const remotePort = formatPortFromDword(tableBuffer.readUInt32LE(rowOffset + 44));
    const state = tableBuffer.readUInt32LE(rowOffset + 48);
    const pid = tableBuffer.readUInt32LE(rowOffset + 52);

    const isListener = state === TCP_STATE_LISTEN;
    const hashSeed = isListener
      ? `LISTEN6:${localIp}:${localPort}:${pid}`
      : `${remoteIp}:${remotePort}`;

    sink.push({
      key: `tcp6|${localIp}:${localPort}|${remoteIp}:${remotePort}|${pid}|${state}`,
      kind: 'tcp6',
      state,
      localDisplay: `[${localIp}]:${localPort}`,
      remoteDisplay: isListener ? '*:*' : `[${remoteIp}]:${remotePort}`,
      hashSeed,
      pid,
      isListener,
    });
  }
}

function parseUdp4(tableBuffer: Buffer, sink: Connection[]): void {
  // MIB_UDPTABLE_OWNER_PID: dwNumEntries (4) + MIB_UDPROW_OWNER_PID[] (12 bytes each)
  const entries = tableBuffer.readUInt32LE(0);
  for (let i = 0; i < entries; i++) {
    const rowOffset = 4 + i * 12;
    const localAddr = tableBuffer.readUInt32LE(rowOffset);
    const localPort = formatPortFromDword(tableBuffer.readUInt32LE(rowOffset + 4));
    const pid = tableBuffer.readUInt32LE(rowOffset + 8);
    const localIp = formatIpv4(localAddr);

    sink.push({
      key: `udp4|${localIp}:${localPort}|${pid}`,
      kind: 'udp4',
      state: 0,
      localDisplay: `${localIp}:${localPort}`,
      remoteDisplay: '(datagram)',
      // UDP has no remote endpoint in this view; hash local + pid so each socket gets its own angle.
      hashSeed: `UDP4:${localIp}:${localPort}:${pid}`,
      pid,
      isListener: false,
    });
  }
}

function parseUdp6(tableBuffer: Buffer, sink: Connection[]): void {
  // MIB_UDP6TABLE_OWNER_PID: dwNumEntries (4) + MIB_UDP6ROW_OWNER_PID[] (28 bytes each)
  const entries = tableBuffer.readUInt32LE(0);
  for (let i = 0; i < entries; i++) {
    const rowOffset = 4 + i * 28;
    const localIp = formatIpv6(tableBuffer, rowOffset + 0);
    const localPort = formatPortFromDword(tableBuffer.readUInt32LE(rowOffset + 20));
    const pid = tableBuffer.readUInt32LE(rowOffset + 24);

    sink.push({
      key: `udp6|${localIp}:${localPort}|${pid}`,
      kind: 'udp6',
      state: 0,
      localDisplay: `[${localIp}]:${localPort}`,
      remoteDisplay: '(datagram)',
      hashSeed: `UDP6:${localIp}:${localPort}:${pid}`,
      pid,
      isListener: false,
    });
  }
}

function pollNetwork(): Connection[] {
  const connections: Connection[] = [];

  const tcp4 = loadExtendedTcpTable(AddressFamily.AF_INET);
  if (tcp4) parseTcp4(tcp4, connections);

  const tcp6 = loadExtendedTcpTable(AddressFamily.AF_INET6);
  if (tcp6) parseTcp6(tcp6, connections);

  const udp4 = loadExtendedUdpTable(AddressFamily.AF_INET);
  if (udp4) parseUdp4(udp4, connections);

  const udp6 = loadExtendedUdpTable(AddressFamily.AF_INET6);
  if (udp6) parseUdp6(udp6, connections);

  return connections;
}

// ── Process name cache (PID → executable base name) ──────────────────────────

const processNameCache = new Map<number, string>();
const processNameBuffer = Buffer.alloc(260 * 2); // 260 wchar_t

function lookupProcessName(pid: number): string {
  if (pid === 0) return 'System Idle';
  if (pid === 4) return 'System';
  const cached = processNameCache.get(pid);
  if (cached !== undefined) return cached;

  // PROCESS_QUERY_LIMITED_INFORMATION is enough for Win 8.1+ and works for most
  // processes including elevated ones running as the same user.
  const handle = Kernel32.OpenProcess(ProcessAccessRights.PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) {
    const fallback = `pid ${pid}`;
    processNameCache.set(pid, fallback);
    return fallback;
  }

  const length = Psapi.GetModuleBaseNameW(handle, 0n, processNameBuffer.ptr, 260);
  Kernel32.CloseHandle(handle);

  if (length <= 0) {
    const fallback = `pid ${pid}`;
    processNameCache.set(pid, fallback);
    return fallback;
  }
  const name = processNameBuffer.subarray(0, length * 2).toString('utf16le');
  processNameCache.set(pid, name);
  return name;
}

// ── Network state + diff ─────────────────────────────────────────────────────

const bandsByKey = new Map<string, AuroraBand>();
let lastNetworkPollMs = 0;
let lastNetworkPollDurationMs = 0;

interface SummaryCounts {
  total: number;
  tcp4: number;
  tcp6: number;
  udp4: number;
  udp6: number;
  established: number;
  listen: number;
  transient: number;
}

let lastSummary: SummaryCounts = { total: 0, tcp4: 0, tcp6: 0, udp4: 0, udp6: 0, established: 0, listen: 0, transient: 0 };

function refreshNetwork(): void {
  const pollStart = performance.now();
  const connections = pollNetwork();
  lastNetworkPollDurationMs = performance.now() - pollStart;

  const summary: SummaryCounts = { total: connections.length, tcp4: 0, tcp6: 0, udp4: 0, udp6: 0, established: 0, listen: 0, transient: 0 };
  const seenKeys = new Set<string>();

  for (const connection of connections) {
    seenKeys.add(connection.key);
    if (connection.kind === 'tcp4') summary.tcp4++;
    else if (connection.kind === 'tcp6') summary.tcp6++;
    else if (connection.kind === 'udp4') summary.udp4++;
    else if (connection.kind === 'udp6') summary.udp6++;

    if (connection.state === TCP_STATE_ESTABLISHED) summary.established++;
    else if (connection.state === TCP_STATE_LISTEN) summary.listen++;
    else if (
      connection.state === TCP_STATE_TIME_WAIT ||
      connection.state === TCP_STATE_CLOSE_WAIT ||
      connection.state === TCP_STATE_FIN_WAIT1 ||
      connection.state === TCP_STATE_FIN_WAIT2 ||
      connection.state === TCP_STATE_LAST_ACK ||
      connection.state === TCP_STATE_CLOSING
    ) summary.transient++;

    if (!bandsByKey.has(connection.key)) {
      bandsByKey.set(connection.key, createBand(connection));
    } else {
      // Keep the existing band (and its in-flight particles) but refresh the
      // connection reference so colors track state transitions if they ever
      // change without the key changing.
      bandsByKey.get(connection.key)!.connection = connection;
    }
  }

  // Drop bands whose connection has vanished from this poll.
  for (const key of bandsByKey.keys()) {
    if (!seenKeys.has(key)) bandsByKey.delete(key);
  }

  lastSummary = summary;
}

// ── Drawing the aurora ───────────────────────────────────────────────────────

function drawBackground(graphics: bigint): void {
  // Deep gradient base: vertical from near-black to a faint indigo.
  const skyRect = writeRect(0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
  const gradientBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateLineBrushFromRectWithAngle(skyRect, argb(255, 6, 8, 18), argb(255, 14, 12, 28), 90.0, 1, 0, gradientBuffer.ptr);
  const gradientBrush = gradientBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(graphics, gradientBrush, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
  Gdiplus.GdipDeleteBrush(gradientBrush);

  // Concentric guide rings, very faint.
  for (let ring = 0; ring < 4; ring++) {
    const ringRadius = OUTER_RADIUS - ring * 70;
    if (ringRadius < INNER_RADIUS) continue;
    const ringAlpha = 14 - ring * 2;
    const penBuffer = Buffer.alloc(8);
    Gdiplus.GdipCreatePen1(argb(ringAlpha, 0xff, 0xff, 0xff), 1.0, Unit.UnitPixel, penBuffer.ptr);
    const pen = penBuffer.readBigUInt64LE(0);
    // GDI+ has no GdipDrawEllipse with just a pen via this helper; emulate with
    // a transparent fill + outline by drawing two arcs. Cheapest is GdipDrawArc
    // but a thin ellipse via fill is also fine since we want a faint guide.
    // We instead draw it as a 1px outline by filling the ring as the difference
    // between two ellipses.
    fillEllipseArgb(graphics, CENTER_X - ringRadius, CENTER_Y - ringRadius, ringRadius * 2, ringRadius * 2, argb(ringAlpha, 0xff, 0xff, 0xff));
    fillEllipseArgb(graphics, CENTER_X - ringRadius + 1, CENTER_Y - ringRadius + 1, (ringRadius - 1) * 2, (ringRadius - 1) * 2, argb(255, 6, 8, 18));
    Gdiplus.GdipDeletePen(pen);
  }
}

function drawAnchor(graphics: bigint, beatPhase: number): void {
  // Outer halo layers (largest → smallest) that breathe with a slow sine wave.
  const breath = 0.6 + 0.4 * Math.sin(beatPhase * Math.PI * 2);
  const haloLayers = [
    { radius: 70 + breath * 6, alpha: 18 },
    { radius: 54 + breath * 4, alpha: 30 },
    { radius: 40 + breath * 3, alpha: 50 },
    { radius: 30, alpha: 100 },
    { radius: INNER_RADIUS, alpha: 220 },
  ];
  for (const layer of haloLayers) {
    fillEllipseArgb(
      graphics,
      CENTER_X - layer.radius,
      CENTER_Y - layer.radius,
      layer.radius * 2,
      layer.radius * 2,
      argb(layer.alpha, COLOR_ANCHOR.red, COLOR_ANCHOR.green, COLOR_ANCHOR.blue),
    );
  }

  // Center label.
  drawText(graphics, 'this machine', labelFont, CENTER_X - 50, CENTER_Y + INNER_RADIUS + 12, 100, 20, argb(180, 0xff, 0xff, 0xff));
}

function drawBands(graphics: bigint, deltaSeconds: number): void {
  // Spawn / advance / draw particles per band, then a thin spine line, then
  // the endpoint marker.
  for (const band of bandsByKey.values()) {
    // Spawn cadence: roughly one particle every 0.18 s for established/UDP, slower for listeners.
    const spawnInterval = band.connection.isListener ? 0.7 : (band.connection.kind === 'udp4' || band.connection.kind === 'udp6') ? 0.32 : 0.16;
    band.spawnAccumulator += deltaSeconds;
    while (band.spawnAccumulator >= spawnInterval) {
      band.spawnAccumulator -= spawnInterval;
      // Find a free particle slot.
      for (let i = 0; i < PARTICLES_PER_BAND; i++) {
        const offset = i * PARTICLE_FLOATS;
        if (band.particles[offset]! < 0) {
          band.particles[offset] = 0; // progress
          band.particles[offset + 1] = (Math.random() - 0.5) * 14; // perpendicular jitter
          band.particles[offset + 2] = 0.65 + Math.random() * 0.35; // brightness
          break;
        }
      }
    }

    // Spine — a thin translucent stroke connecting anchor to endpoint via the
    // same Bezier the particles ride. We pick a small alpha so it's a hint.
    const penBuffer = Buffer.alloc(8);
    const spineAlpha = band.connection.isListener ? 24 : 36;
    Gdiplus.GdipCreatePen1(argb(spineAlpha, band.baseRed, band.baseGreen, band.baseBlue), 1.0, Unit.UnitPixel, penBuffer.ptr);
    const spinePen = penBuffer.readBigUInt64LE(0);
    Gdiplus.GdipDrawBezier(graphics, spinePen, CENTER_X, CENTER_Y, band.controlAX, band.controlAY, band.controlBX, band.controlBY, band.endpointX, band.endpointY);
    Gdiplus.GdipDeletePen(spinePen);

    // Particles.
    if (!band.connection.isListener) {
      for (let i = 0; i < PARTICLES_PER_BAND; i++) {
        const offset = i * PARTICLE_FLOATS;
        const progress = band.particles[offset]!;
        if (progress < 0) continue;

        const nextProgress = progress + PARTICLE_SPEED * deltaSeconds;
        if (nextProgress >= 1) {
          band.particles[offset] = -1; // retire
          continue;
        }
        band.particles[offset] = nextProgress;

        const t = nextProgress;
        const baseX = bezierSample(CENTER_X, band.controlAX, band.controlBX, band.endpointX, t);
        const baseY = bezierSample(CENTER_Y, band.controlAY, band.controlBY, band.endpointY, t);

        // Perpendicular jitter — small lateral offset that gives the band a
        // ribbon-like wiggle instead of a clean curve.
        const jitterMagnitude = band.particles[offset + 1]!;
        const tangentX = bezierSample(CENTER_X, band.controlAX, band.controlBX, band.endpointX, Math.min(1, t + 0.01)) - baseX;
        const tangentY = bezierSample(CENTER_Y, band.controlAY, band.controlBY, band.endpointY, Math.min(1, t + 0.01)) - baseY;
        const tangentLength = Math.sqrt(tangentX * tangentX + tangentY * tangentY) || 1;
        const perpX = -tangentY / tangentLength;
        const perpY = tangentX / tangentLength;

        const particleX = baseX + perpX * jitterMagnitude * (1 - t);
        const particleY = baseY + perpY * jitterMagnitude * (1 - t);

        const brightness = band.particles[offset + 2]!;
        // Triangular envelope: fades in at start, fades out at end.
        const envelope = t < 0.15 ? t / 0.15 : (1 - t) / 0.85;
        const particleAlpha = Math.round(clamp(envelope * 220 * brightness, 0, 255));

        // Halo + core, two ellipses.
        const haloRadius = 5 + brightness * 3;
        fillEllipseArgb(
          graphics,
          particleX - haloRadius,
          particleY - haloRadius,
          haloRadius * 2,
          haloRadius * 2,
          argb(Math.round(particleAlpha * 0.35), band.baseRed, band.baseGreen, band.baseBlue),
        );
        const coreRadius = 2.4;
        fillEllipseArgb(
          graphics,
          particleX - coreRadius,
          particleY - coreRadius,
          coreRadius * 2,
          coreRadius * 2,
          argb(particleAlpha, band.baseRed, band.baseGreen, band.baseBlue),
        );
      }
    }

    // Endpoint marker — radius is larger for listeners (so they read as
    // static dots) and small for transient/connected endpoints.
    const endpointRadius = band.connection.isListener ? 5 : 3.5;
    const endpointAlpha = band.connection.isListener ? 220 : 200;
    fillEllipseArgb(
      graphics,
      band.endpointX - endpointRadius - 2,
      band.endpointY - endpointRadius - 2,
      (endpointRadius + 2) * 2,
      (endpointRadius + 2) * 2,
      argb(Math.round(endpointAlpha * 0.35), band.baseRed, band.baseGreen, band.baseBlue),
    );
    fillEllipseArgb(
      graphics,
      band.endpointX - endpointRadius,
      band.endpointY - endpointRadius,
      endpointRadius * 2,
      endpointRadius * 2,
      argb(endpointAlpha, band.baseRed, band.baseGreen, band.baseBlue),
    );
  }
}

function drawLegend(graphics: bigint): void {
  // Title in the top-left.
  drawText(graphics, 'Network Aurora', titleFont, 32, 24, 400, 32, argb(230, 0xff, 0xff, 0xff));
  drawText(graphics, 'every TCP/UDP connection flowing as light', labelFont, 32, 54, 460, 20, argb(160, 0xff, 0xff, 0xff));

  // Legend in the top-right.
  const swatches: { label: string; color: { red: number; green: number; blue: number } }[] = [
    { label: 'ESTABLISHED', color: COLOR_ESTABLISHED },
    { label: 'LISTEN', color: COLOR_LISTEN },
    { label: 'TIME_WAIT / CLOSE_WAIT', color: COLOR_TRANSIENT },
    { label: 'UDP', color: COLOR_UDP },
  ];
  const legendX = WINDOW_WIDTH - 260;
  let legendY = 24;
  for (const item of swatches) {
    fillEllipseArgb(graphics, legendX, legendY + 6, 10, 10, argb(255, item.color.red, item.color.green, item.color.blue));
    drawText(graphics, item.label, labelFont, legendX + 18, legendY, 240, 20, argb(200, 0xff, 0xff, 0xff));
    legendY += 22;
  }
}

function drawHud(graphics: bigint, frame: number, fps: number): void {
  // Per-connection counts.
  const summary = lastSummary;
  const hudLines = [
    `total ${summary.total}    TCPv4 ${summary.tcp4}    TCPv6 ${summary.tcp6}    UDPv4 ${summary.udp4}    UDPv6 ${summary.udp6}`,
    `established ${summary.established}    listen ${summary.listen}    transient ${summary.transient}`,
    `poll ${lastNetworkPollDurationMs.toFixed(1)} ms    frame ${frame}    ${fps.toFixed(1)} fps`,
    'esc to quit',
  ];
  let y = WINDOW_HEIGHT - 80;
  for (const line of hudLines) {
    drawText(graphics, line, hudFont, 32, y, WINDOW_WIDTH - 64, 18, argb(150, 0xff, 0xff, 0xff));
    y += 16;
  }
}

// Top-N table of connections grouped by remote endpoint to anchor the visual.
function drawTopTable(graphics: bigint): void {
  // Aggregate by (remote, kind) so the table has meaning.
  const counts = new Map<string, { count: number; sample: Connection }>();
  for (const band of bandsByKey.values()) {
    const key = `${band.connection.kind}|${band.connection.remoteDisplay}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { count: 1, sample: band.connection });
  }
  const sorted = Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, 12);

  const tableX = 32;
  let tableY = 96;
  drawText(graphics, 'top endpoints', labelFont, tableX, tableY, 360, 18, argb(200, 0xff, 0xff, 0xff));
  tableY += 22;
  for (const entry of sorted) {
    const proc = lookupProcessName(entry.sample.pid);
    const kindLabel = entry.sample.kind.toUpperCase();
    const remote = entry.sample.remoteDisplay.length > 32 ? entry.sample.remoteDisplay.slice(0, 31) + '…' : entry.sample.remoteDisplay;
    const line = `${entry.count.toString().padStart(2, ' ')}  ${kindLabel.padEnd(5)}  ${remote.padEnd(34)} ${proc}`;
    const stateColor = colorForConnection(entry.sample);
    // Mini dot indicates color category.
    fillEllipseArgb(graphics, tableX, tableY + 6, 6, 6, argb(220, stateColor.red, stateColor.green, stateColor.blue));
    drawText(graphics, line, hudFont, tableX + 12, tableY, 480, 16, argb(170, 0xff, 0xff, 0xff));
    tableY += 16;
  }
}

// ── Blit the offscreen bitmap to the window HDC ──────────────────────────────

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

// ── Main loop ────────────────────────────────────────────────────────────────

console.log('Network Aurora running. ESC closes the window.');

// Prime the network poll once before the first frame.
refreshNetwork();
lastNetworkPollMs = Date.now();
console.log(`  initial poll: ${lastSummary.total} connections (TCPv4=${lastSummary.tcp4}, TCPv6=${lastSummary.tcp6}, UDPv4=${lastSummary.udp4}, UDPv6=${lastSummary.udp6})`);

const messageBuffer = Buffer.alloc(MSG_SIZE_BYTES);
const messageDataView = new DataView(messageBuffer.buffer);

let frameCount = 0;
let lastFrameMs = Date.now();
let fpsAverage = 60;

while (!shouldClose) {
  // Drain pending messages without blocking.
  while (User32.PeekMessageW(messageBuffer.ptr, 0n, 0, 0, PeekMessageRemoveFlag.PM_REMOVE)) {
    const messageId = messageDataView.getUint32(8, true);
    if (messageId === WM_QUIT) {
      shouldClose = true;
      break;
    }
    User32.TranslateMessage(messageBuffer.ptr);
    User32.DispatchMessageW(messageBuffer.ptr);
  }
  if (shouldClose) break;

  const now = Date.now();
  const deltaMs = now - lastFrameMs;
  const deltaSeconds = Math.max(0.001, deltaMs / 1000);
  lastFrameMs = now;
  if (deltaSeconds > 0) {
    const instantFps = 1 / deltaSeconds;
    fpsAverage = fpsAverage * 0.9 + instantFps * 0.1;
  }

  // Refresh the network table every NETWORK_REFRESH_MS.
  if (now - lastNetworkPollMs >= NETWORK_REFRESH_MS) {
    refreshNetwork();
    lastNetworkPollMs = now;
  }

  // Compose the frame.
  Gdiplus.GdipGraphicsClear(offscreenGraphics, argb(255, 8, 8, 18));
  drawBackground(offscreenGraphics);
  // beatPhase used by the anchor breathing — derive from wall clock (3 s cycle).
  const beatPhase = ((now % 3000) / 3000);
  drawBands(offscreenGraphics, deltaSeconds);
  drawAnchor(offscreenGraphics, beatPhase);
  drawLegend(offscreenGraphics);
  drawTopTable(offscreenGraphics);
  drawHud(offscreenGraphics, frameCount, fpsAverage);

  blitToWindow();

  frameCount++;

  // Frame pacing.
  const elapsedThisFrame = Date.now() - now;
  const sleepMs = FRAME_BUDGET_MS - elapsedThisFrame;
  if (sleepMs > 1) Bun.sleepSync(sleepMs);
}

// ── Teardown ────────────────────────────────────────────────────────────────

console.log('Cleaning up…');

Gdiplus.GdipDeleteStringFormat(leftStringFormat);
Gdiplus.GdipDeleteFont(titleFont);
Gdiplus.GdipDeleteFont(labelFont);
Gdiplus.GdipDeleteFont(hudFont);
Gdiplus.GdipDeleteFontFamily(fontFamily);
Gdiplus.GdipDeleteGraphics(offscreenGraphics);
Gdiplus.GdipDisposeImage(offscreenBitmap);
Gdiplus.GdiplusShutdown(gdiplusToken);

if (windowHandle) User32.DestroyWindow(windowHandle);
User32.UnregisterClassW(className.ptr, 0n);
wndProcCallback.close();

// Reference the table state name map so the lookup isn't dead-stripped by a
// future bundler. The map keeps the per-state debug-print contract clear.
void TCP_STATE_NAMES;

// Reference the unused state name constants in a way that survives strict
// unused-locals checks even if a future refactor removes their only usage.
void TCP_STATE_SYN_SENT;
void TCP_STATE_SYN_RCVD;

console.log('Done.');
