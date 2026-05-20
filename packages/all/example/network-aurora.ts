/**
 * Network Aurora — every TCP/UDP connection on the machine flowing as light
 *
 * A live, glanceable visualization of the OS networking stack: each active
 * connection (TCP v4/v6, UDP v4/v6) becomes a band of particles arcing from a
 * glowing "this machine" anchor at the center of a borderless 1280x900 window
 * to a position on the outer ring whose angle is determined by a stable hash
 * of the remote IP and port. ~60 fps GDI+ render loop; the network state is
 * resampled once per second via the IP Helper API. The hook: watch every byte
 * of traffic that leaves your machine arc across the sky.
 *
 * Pipeline:
 *
 *   1. Gdiplus.GdiplusStartup + GdipCreateBitmapFromScan0  — 32bpp ARGB bitmap
 *   2. User32.RegisterClassExW + CreateWindowExW           — borderless popup
 *   3. Dwmapi.DwmSetWindowAttribute                        — Mica + dark mode
 *   4. Each ~1 s: Iphlpapi.GetExtendedTcpTable(AF_INET/AF_INET6, TCP_TABLE_OWNER_PID_ALL)
 *                 Iphlpapi.GetExtendedUdpTable(AF_INET/AF_INET6, UDP_TABLE_OWNER_PID)
 *   5. Hash remote endpoint → angle θ on the outer ring; spawn a Bezier-flowing
 *      particle stream from the center to that endpoint. Listeners are static
 *      dots; UDP draws on the ring with no remote endpoint.
 *   6. Kernel32.OpenProcess + Psapi.GetModuleBaseNameW     — owner exe lookup
 *   7. Each frame: clear → bands → anchor → legend → HUD → blit to window HDC.
 *   8. ESC / Q / window close exits cleanly.
 *
 * Connection-state palette:
 *   ESTABLISHED                cyan
 *   LISTEN                     yellow (static dot, no remote)
 *   TIME_WAIT / CLOSE_WAIT     orange
 *   UDP                        violet
 *
 * APIs demonstrated:
 *   - Iphlpapi.GetExtendedTcpTable, Iphlpapi.GetExtendedUdpTable
 *   - Kernel32.OpenProcess / CloseHandle / GetModuleHandleW
 *   - Psapi.GetModuleBaseNameW
 *   - User32.RegisterClassExW / CreateWindowExW / DestroyWindow
 *   - User32.SetWindowLongPtrW, User32.PeekMessageW / Translate / Dispatch
 *   - User32.GetDC / ReleaseDC / GetSystemMetrics / ShowWindow / UpdateWindow
 *   - Dwmapi.DwmSetWindowAttribute (DWMWA_SYSTEMBACKDROP_TYPE + DARK_MODE)
 *   - Gdiplus.GdiplusStartup / Shutdown, GdipCreateBitmapFromScan0
 *   - Gdiplus.GdipGetImageGraphicsContext, GdipSetSmoothingMode, GdipGraphicsClear
 *   - Gdiplus.GdipCreateSolidFill / GdipFillEllipse / GdipFillRectangle
 *   - Gdiplus.GdipCreatePen1 / GdipDrawBezier, GdipCreateFromHDC / GdipDrawImageRectI
 *   - Gdiplus.GdipCreateFontFamilyFromName / GdipCreateFont / GdipDrawString
 *
 * MIB row layouts (x64):
 *   MIB_TCPROW_OWNER_PID  (24): dwState, dwLocalAddr, dwLocalPort,
 *                               dwRemoteAddr, dwRemotePort, dwOwningPid
 *   MIB_UDPROW_OWNER_PID  (12): dwLocalAddr, dwLocalPort, dwOwningPid
 *   MIB_TCP6ROW_OWNER_PID (56): ucLocalAddr[16], dwLocalScopeId, dwLocalPort,
 *                               ucRemoteAddr[16], dwRemoteScopeId, dwRemotePort,
 *                               dwState, dwOwningPid
 *   MIB_UDP6ROW_OWNER_PID (28): ucLocalAddr[16], dwLocalScopeId, dwLocalPort,
 *                               dwOwningPid
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

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 900;
const CENTER_X = WINDOW_WIDTH / 2;
const CENTER_Y = WINDOW_HEIGHT / 2;
const OUTER_RADIUS = 380;
const INNER_RADIUS = 28;
const FRAME_BUDGET_MS = 16;
const NETWORK_REFRESH_MS = 1000;

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_QUIT = 0x0012;

const TCP_LISTEN = 2;
const TCP_ESTABLISHED = 5;
const TCP_FIN_WAIT1 = 6;
const TCP_FIN_WAIT2 = 7;
const TCP_CLOSE_WAIT = 8;
const TCP_CLOSING = 9;
const TCP_LAST_ACK = 10;
const TCP_TIME_WAIT = 11;
const TRANSIENT_STATES = new Set([TCP_FIN_WAIT1, TCP_FIN_WAIT2, TCP_CLOSE_WAIT, TCP_CLOSING, TCP_LAST_ACK, TCP_TIME_WAIT]);

const argb = (alpha: number, red: number, green: number, blue: number): number =>
  (((alpha & 0xff) << 24) | ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)) >>> 0;

const COLOR_ESTABLISHED = { red: 0x4d, green: 0xe0, blue: 0xff };
const COLOR_LISTEN = { red: 0xff, green: 0xd9, blue: 0x47 };
const COLOR_TRANSIENT = { red: 0xff, green: 0x9a, blue: 0x3c };
const COLOR_UDP = { red: 0xc9, green: 0x7a, blue: 0xff };
const COLOR_FALLBACK = { red: 0x7c, green: 0x8c, blue: 0xa6 };

const encodeWide = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');
const check = (status: number, where: string): void => { if (status !== Status.Ok) throw new Error(`${where} failed: ${Status[status]} (${status})`); };
const clamp = (value: number, lo: number, hi: number): number => value < lo ? lo : value > hi ? hi : value;

// FNV-1a 32-bit hash — stable across runs, uniform enough to spread endpoints around the ring.
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

// IPv4 dwLocalAddr is stored in network byte order; bytes lay out from least-significant.
const formatIpv4 = (n: number): string => `${n & 0xff}.${(n >>> 8) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 24) & 0xff}`;
const portFromDword = (dword: number): number => ((dword & 0xff) << 8) | ((dword >>> 8) & 0xff);

function formatIpv6(buffer: Buffer, offset: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    const word = (buffer.readUInt8(offset + i * 2) << 8) | buffer.readUInt8(offset + i * 2 + 1);
    groups.push(word.toString(16));
  }
  return groups.join(':');
}

// ── Bootstrap GDI+ + window ──────────────────────────────────────────────────

console.log('Network Aurora — booting GDI+…');

Gdiplus.Preload();
const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0);
check(Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr, gdiplusStartupInput.ptr, null), 'GdiplusStartup');
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

let shouldClose = false;
const wndProcCallback = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_KEYDOWN) {
      const vk = Number(wParam);
      if (vk === VirtualKey.VK_ESCAPE || vk === 0x51 /* Q */) { shouldClose = true; User32.PostQuitMessage(0); return 0n; }
    }
    if (msg === WM_CLOSE) { shouldClose = true; User32.DestroyWindow(hWnd); return 0n; }
    if (msg === WM_DESTROY) { User32.PostQuitMessage(0); return 0n; }
    return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
  },
  { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
);

const className = encodeWide('NetworkAurora');
const wndClassBuffer = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuffer.buffer);
wndClassView.setUint32(0, 80, true);
wndClassBuffer.writeBigUInt64LE(BigInt(wndProcCallback.ptr!), 8);
wndClassBuffer.writeBigUInt64LE(BigInt(className.ptr), 64);
if (!User32.RegisterClassExW(wndClassBuffer.ptr)) { console.error('RegisterClassExW failed'); process.exit(1); }

const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
const moduleHandle = Kernel32.GetModuleHandleW(null!);

const windowHandle = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_APPWINDOW,
  className.ptr,
  encodeWide('Network Aurora').ptr,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  Math.floor((screenWidth - WINDOW_WIDTH) / 2),
  Math.floor((screenHeight - WINDOW_HEIGHT) / 2),
  WINDOW_WIDTH, WINDOW_HEIGHT,
  0n, 0n, moduleHandle, null,
);
if (!windowHandle) { console.error('CreateWindowExW failed'); process.exit(1); }

// Mica backdrop + immersive dark mode.
const dwmDword = Buffer.alloc(4);
dwmDword.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, dwmDword.ptr, 4);
dwmDword.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, dwmDword.ptr, 4);

User32.ShowWindow(windowHandle, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(windowHandle);
User32.SetWindowLongPtrW(windowHandle, WindowLongIndex.GWL_WNDPROC, BigInt(wndProcCallback.ptr!));

// ── Offscreen GDI+ bitmap, fonts, helpers ───────────────────────────────────

const bitmapHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateBitmapFromScan0(WINDOW_WIDTH, WINDOW_HEIGHT, 0, PixelFormat32bppARGB, null, bitmapHandleBuffer.ptr), 'GdipCreateBitmapFromScan0');
const offscreenBitmap = bitmapHandleBuffer.readBigUInt64LE(0);

const graphicsHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipGetImageGraphicsContext(offscreenBitmap, graphicsHandleBuffer.ptr), 'GdipGetImageGraphicsContext');
const offscreenGraphics = graphicsHandleBuffer.readBigUInt64LE(0);
check(Gdiplus.GdipSetSmoothingMode(offscreenGraphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
check(Gdiplus.GdipSetTextRenderingHint(offscreenGraphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit), 'GdipSetTextRenderingHint');

const fontFamilyHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateFontFamilyFromName(encodeWide('Segoe UI').ptr, 0n, fontFamilyHandleBuffer.ptr), 'GdipCreateFontFamilyFromName');
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

const reusableRect = Buffer.alloc(16);
function writeRect(x: number, y: number, w: number, h: number): Pointer {
  reusableRect.writeFloatLE(x, 0); reusableRect.writeFloatLE(y, 4);
  reusableRect.writeFloatLE(w, 8); reusableRect.writeFloatLE(h, 12);
  return reusableRect.ptr;
}

function fillRect(g: bigint, x: number, y: number, w: number, h: number, color: number): void {
  const b = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, b.ptr);
  const brush = b.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(g, brush, x, y, w, h);
  Gdiplus.GdipDeleteBrush(brush);
}

function fillEllipse(g: bigint, x: number, y: number, w: number, h: number, color: number): void {
  const b = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, b.ptr);
  const brush = b.readBigUInt64LE(0);
  Gdiplus.GdipFillEllipse(g, brush, x, y, w, h);
  Gdiplus.GdipDeleteBrush(brush);
}

function drawText(g: bigint, text: string, font: bigint, x: number, y: number, w: number, h: number, color: number): void {
  const b = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, b.ptr);
  const brush = b.readBigUInt64LE(0);
  const wide = encodeWide(text);
  Gdiplus.GdipDrawString(g, wide.ptr, -1, font, writeRect(x, y, w, h), leftStringFormat, brush);
  Gdiplus.GdipDeleteBrush(brush);
}

// ── Connection + band data structures ────────────────────────────────────────

type ConnectionKind = 'tcp4' | 'tcp6' | 'udp4' | 'udp6';

interface Connection {
  key: string;
  kind: ConnectionKind;
  state: number;
  localDisplay: string;
  remoteDisplay: string;
  hashSeed: string;
  pid: number;
  isListener: boolean;
}

interface AuroraBand {
  connection: Connection;
  endpointX: number;
  endpointY: number;
  controlAX: number;
  controlAY: number;
  controlBX: number;
  controlBY: number;
  baseRed: number;
  baseGreen: number;
  baseBlue: number;
  // particle progress array (PARTICLES_PER_BAND × 3 floats: progress, jitter, brightness)
  particles: Float32Array;
  spawnAccumulator: number;
}

const PARTICLES_PER_BAND = 24;
const PARTICLE_FLOATS = 3;
const PARTICLE_SPEED = 0.42;

function colorForConnection(c: Connection): { red: number; green: number; blue: number } {
  if (c.kind === 'udp4' || c.kind === 'udp6') return COLOR_UDP;
  if (c.state === TCP_ESTABLISHED) return COLOR_ESTABLISHED;
  if (c.state === TCP_LISTEN) return COLOR_LISTEN;
  if (TRANSIENT_STATES.has(c.state)) return COLOR_TRANSIENT;
  return COLOR_FALLBACK;
}

function createBand(connection: Connection): AuroraBand {
  // Stable hash → outer-ring angle. Listeners ride slightly inside the ring so
  // they read as anchored ports rather than as remote peers.
  const seedHash = hashString(connection.hashSeed);
  const angle = (seedHash / 0x1_0000_0000) * Math.PI * 2;
  const radius = connection.isListener ? OUTER_RADIUS * 0.86 : OUTER_RADIUS;
  const endpointX = CENTER_X + Math.cos(angle) * radius;
  const endpointY = CENTER_Y + Math.sin(angle) * radius;

  // Bezier control points: perpendicular wobble derived from the same hash so
  // each band has a unique but stable arc shape across re-polls.
  const wobbleSign = (seedHash & 1) === 0 ? 1 : -1;
  const wobble = 80 + ((seedHash >>> 8) % 140);
  const perpX = -Math.sin(angle) * wobble * wobbleSign;
  const perpY = Math.cos(angle) * wobble * wobbleSign;
  const dx = endpointX - CENTER_X;
  const dy = endpointY - CENTER_Y;

  const c = colorForConnection(connection);
  return {
    connection,
    endpointX, endpointY,
    controlAX: CENTER_X + dx * 0.33 + perpX,
    controlAY: CENTER_Y + dy * 0.33 + perpY,
    controlBX: CENTER_X + dx * 0.66 - perpX * 0.5,
    controlBY: CENTER_Y + dy * 0.66 - perpY * 0.5,
    baseRed: c.red, baseGreen: c.green, baseBlue: c.blue,
    particles: new Float32Array(PARTICLES_PER_BAND * PARTICLE_FLOATS).fill(-1),
    spawnAccumulator: 0,
  };
}

// Cubic Bezier sample along axis (p0=anchor, p1=ctrlA, p2=ctrlB, p3=endpoint).
function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// ── IP Helper queries ────────────────────────────────────────────────────────

// Two-call sizing pattern: NULL/0 → ERROR_INSUFFICIENT_BUFFER (122) or ERROR_BUFFER_OVERFLOW (111), allocate, retry.
function loadTable(family: number, kind: 'tcp' | 'udp'): Buffer | null {
  const sizeBuffer = Buffer.alloc(4);
  sizeBuffer.writeUInt32LE(0, 0);
  const tableClass = kind === 'tcp' ? TcpTableClass.TCP_TABLE_OWNER_PID_ALL : UdpTableClass.UDP_TABLE_OWNER_PID;
  const get = kind === 'tcp' ? Iphlpapi.GetExtendedTcpTable : Iphlpapi.GetExtendedUdpTable;
  let result = get(null, sizeBuffer.ptr, 0, family, tableClass, 0);
  if (result !== 122 && result !== 111 && result !== 0) return null;
  const size = sizeBuffer.readUInt32LE(0);
  if (size === 0) return Buffer.alloc(4);
  const tableBuffer = Buffer.alloc(size);
  result = get(tableBuffer.ptr, sizeBuffer.ptr, 0, family, tableClass, 0);
  return result === 0 ? tableBuffer : null;
}

function parseTcp4(buf: Buffer, sink: Connection[]): void {
  const entries = buf.readUInt32LE(0);
  for (let i = 0; i < entries; i++) {
    const off = 4 + i * 24;
    const state = buf.readUInt32LE(off);
    const localIp = formatIpv4(buf.readUInt32LE(off + 4));
    const localPort = portFromDword(buf.readUInt32LE(off + 8));
    const remoteIp = formatIpv4(buf.readUInt32LE(off + 12));
    const remotePort = portFromDword(buf.readUInt32LE(off + 16));
    const pid = buf.readUInt32LE(off + 20);
    const isListener = state === TCP_LISTEN;
    sink.push({
      key: `tcp4|${localIp}:${localPort}|${remoteIp}:${remotePort}|${pid}|${state}`,
      kind: 'tcp4', state, pid, isListener,
      localDisplay: `${localIp}:${localPort}`,
      remoteDisplay: isListener ? '*:*' : `${remoteIp}:${remotePort}`,
      hashSeed: isListener ? `LISTEN:${localIp}:${localPort}:${pid}` : `${remoteIp}:${remotePort}`,
    });
  }
}

function parseTcp6(buf: Buffer, sink: Connection[]): void {
  const entries = buf.readUInt32LE(0);
  for (let i = 0; i < entries; i++) {
    const off = 4 + i * 56;
    const localIp = formatIpv6(buf, off + 0);
    const localPort = portFromDword(buf.readUInt32LE(off + 20));
    const remoteIp = formatIpv6(buf, off + 24);
    const remotePort = portFromDword(buf.readUInt32LE(off + 44));
    const state = buf.readUInt32LE(off + 48);
    const pid = buf.readUInt32LE(off + 52);
    const isListener = state === TCP_LISTEN;
    sink.push({
      key: `tcp6|${localIp}:${localPort}|${remoteIp}:${remotePort}|${pid}|${state}`,
      kind: 'tcp6', state, pid, isListener,
      localDisplay: `[${localIp}]:${localPort}`,
      remoteDisplay: isListener ? '*:*' : `[${remoteIp}]:${remotePort}`,
      hashSeed: isListener ? `LISTEN6:${localIp}:${localPort}:${pid}` : `${remoteIp}:${remotePort}`,
    });
  }
}

function parseUdp4(buf: Buffer, sink: Connection[]): void {
  const entries = buf.readUInt32LE(0);
  for (let i = 0; i < entries; i++) {
    const off = 4 + i * 12;
    const localIp = formatIpv4(buf.readUInt32LE(off));
    const localPort = portFromDword(buf.readUInt32LE(off + 4));
    const pid = buf.readUInt32LE(off + 8);
    sink.push({
      key: `udp4|${localIp}:${localPort}|${pid}`,
      kind: 'udp4', state: 0, pid, isListener: false,
      localDisplay: `${localIp}:${localPort}`,
      remoteDisplay: '(datagram)',
      hashSeed: `UDP4:${localIp}:${localPort}:${pid}`,
    });
  }
}

function parseUdp6(buf: Buffer, sink: Connection[]): void {
  const entries = buf.readUInt32LE(0);
  for (let i = 0; i < entries; i++) {
    const off = 4 + i * 28;
    const localIp = formatIpv6(buf, off + 0);
    const localPort = portFromDword(buf.readUInt32LE(off + 20));
    const pid = buf.readUInt32LE(off + 24);
    sink.push({
      key: `udp6|${localIp}:${localPort}|${pid}`,
      kind: 'udp6', state: 0, pid, isListener: false,
      localDisplay: `[${localIp}]:${localPort}`,
      remoteDisplay: '(datagram)',
      hashSeed: `UDP6:${localIp}:${localPort}:${pid}`,
    });
  }
}

function pollNetwork(): Connection[] {
  const connections: Connection[] = [];
  const tcp4 = loadTable(AddressFamily.AF_INET, 'tcp'); if (tcp4) parseTcp4(tcp4, connections);
  const tcp6 = loadTable(AddressFamily.AF_INET6, 'tcp'); if (tcp6) parseTcp6(tcp6, connections);
  const udp4 = loadTable(AddressFamily.AF_INET, 'udp'); if (udp4) parseUdp4(udp4, connections);
  const udp6 = loadTable(AddressFamily.AF_INET6, 'udp'); if (udp6) parseUdp6(udp6, connections);
  return connections;
}

// PID → executable name (cached; OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) + GetModuleBaseNameW).
const processNameCache = new Map<number, string>();
const processNameBuffer = Buffer.alloc(260 * 2);

function lookupProcessName(pid: number): string {
  if (pid === 0) return 'System Idle';
  if (pid === 4) return 'System';
  const cached = processNameCache.get(pid);
  if (cached !== undefined) return cached;
  const handle = Kernel32.OpenProcess(ProcessAccessRights.PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) { const f = `pid ${pid}`; processNameCache.set(pid, f); return f; }
  const length = Psapi.GetModuleBaseNameW(handle, 0n, processNameBuffer.ptr, 260);
  Kernel32.CloseHandle(handle);
  const name = length > 0 ? processNameBuffer.subarray(0, length * 2).toString('utf16le') : `pid ${pid}`;
  processNameCache.set(pid, name);
  return name;
}

// ── Network state + diff ─────────────────────────────────────────────────────

const bandsByKey = new Map<string, AuroraBand>();
let lastPollDurationMs = 0;

interface SummaryCounts { total: number; tcp4: number; tcp6: number; udp4: number; udp6: number; established: number; listen: number; transient: number; }
let lastSummary: SummaryCounts = { total: 0, tcp4: 0, tcp6: 0, udp4: 0, udp6: 0, established: 0, listen: 0, transient: 0 };

function refreshNetwork(): void {
  const pollStart = performance.now();
  const connections = pollNetwork();
  lastPollDurationMs = performance.now() - pollStart;

  const summary: SummaryCounts = { total: connections.length, tcp4: 0, tcp6: 0, udp4: 0, udp6: 0, established: 0, listen: 0, transient: 0 };
  const seen = new Set<string>();
  for (const c of connections) {
    seen.add(c.key);
    summary[c.kind]++;
    if (c.state === TCP_ESTABLISHED) summary.established++;
    else if (c.state === TCP_LISTEN) summary.listen++;
    else if (TRANSIENT_STATES.has(c.state)) summary.transient++;

    const existing = bandsByKey.get(c.key);
    if (existing) existing.connection = c;
    else bandsByKey.set(c.key, createBand(c));
  }
  // Drop bands whose connection has vanished from this poll.
  for (const key of Array.from(bandsByKey.keys())) {
    if (!seen.has(key)) bandsByKey.delete(key);
  }
  lastSummary = summary;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function drawBackground(g: bigint): void {
  const gradientBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateLineBrushFromRectWithAngle(writeRect(0, 0, WINDOW_WIDTH, WINDOW_HEIGHT), argb(255, 6, 8, 18), argb(255, 14, 12, 28), 90.0, 1, 0, gradientBuffer.ptr);
  const gradientBrush = gradientBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(g, gradientBrush, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
  Gdiplus.GdipDeleteBrush(gradientBrush);

  // Faint concentric guide rings — emulate stroke by filling outer disc minus inner disc.
  for (let ring = 0; ring < 4; ring++) {
    const r = OUTER_RADIUS - ring * 70;
    if (r < INNER_RADIUS) continue;
    const a = 14 - ring * 2;
    fillEllipse(g, CENTER_X - r, CENTER_Y - r, r * 2, r * 2, argb(a, 0xff, 0xff, 0xff));
    fillEllipse(g, CENTER_X - r + 1, CENTER_Y - r + 1, (r - 1) * 2, (r - 1) * 2, argb(255, 8, 10, 22));
  }
}

function drawAnchor(g: bigint, beatPhase: number): void {
  const breath = 0.6 + 0.4 * Math.sin(beatPhase * Math.PI * 2);
  const haloLayers = [
    { radius: 70 + breath * 6, alpha: 18 },
    { radius: 54 + breath * 4, alpha: 30 },
    { radius: 40 + breath * 3, alpha: 50 },
    { radius: 30, alpha: 100 },
    { radius: INNER_RADIUS, alpha: 220 },
  ];
  for (const layer of haloLayers) {
    fillEllipse(g, CENTER_X - layer.radius, CENTER_Y - layer.radius, layer.radius * 2, layer.radius * 2, argb(layer.alpha, 0xff, 0xff, 0xff));
  }
  drawText(g, 'this machine', labelFont, CENTER_X - 50, CENTER_Y + INNER_RADIUS + 12, 100, 20, argb(180, 0xff, 0xff, 0xff));
}

function drawBands(g: bigint, deltaSeconds: number): void {
  for (const band of Array.from(bandsByKey.values())) {
    const isUdp = band.connection.kind === 'udp4' || band.connection.kind === 'udp6';
    const spawnInterval = band.connection.isListener ? 0.7 : isUdp ? 0.32 : 0.16;
    band.spawnAccumulator += deltaSeconds;
    while (band.spawnAccumulator >= spawnInterval) {
      band.spawnAccumulator -= spawnInterval;
      for (let i = 0; i < PARTICLES_PER_BAND; i++) {
        const off = i * PARTICLE_FLOATS;
        if (band.particles[off]! < 0) {
          band.particles[off] = 0;
          band.particles[off + 1] = (Math.random() - 0.5) * 14;
          band.particles[off + 2] = 0.65 + Math.random() * 0.35;
          break;
        }
      }
    }

    // Faint spine connecting anchor → endpoint along the Bezier.
    const penBuffer = Buffer.alloc(8);
    Gdiplus.GdipCreatePen1(argb(band.connection.isListener ? 24 : 36, band.baseRed, band.baseGreen, band.baseBlue), 1.0, Unit.UnitPixel, penBuffer.ptr);
    const spinePen = penBuffer.readBigUInt64LE(0);
    Gdiplus.GdipDrawBezier(g, spinePen, CENTER_X, CENTER_Y, band.controlAX, band.controlAY, band.controlBX, band.controlBY, band.endpointX, band.endpointY);
    Gdiplus.GdipDeletePen(spinePen);

    if (!band.connection.isListener) {
      for (let i = 0; i < PARTICLES_PER_BAND; i++) {
        const off = i * PARTICLE_FLOATS;
        const progress = band.particles[off]!;
        if (progress < 0) continue;
        const t = progress + PARTICLE_SPEED * deltaSeconds;
        if (t >= 1) { band.particles[off] = -1; continue; }
        band.particles[off] = t;

        const baseX = bezier(CENTER_X, band.controlAX, band.controlBX, band.endpointX, t);
        const baseY = bezier(CENTER_Y, band.controlAY, band.controlBY, band.endpointY, t);
        const tangentX = bezier(CENTER_X, band.controlAX, band.controlBX, band.endpointX, Math.min(1, t + 0.01)) - baseX;
        const tangentY = bezier(CENTER_Y, band.controlAY, band.controlBY, band.endpointY, Math.min(1, t + 0.01)) - baseY;
        const tangentLength = Math.sqrt(tangentX * tangentX + tangentY * tangentY) || 1;
        const jitter = band.particles[off + 1]!;
        const x = baseX + (-tangentY / tangentLength) * jitter * (1 - t);
        const y = baseY + (tangentX / tangentLength) * jitter * (1 - t);

        const brightness = band.particles[off + 2]!;
        const envelope = t < 0.15 ? t / 0.15 : (1 - t) / 0.85;
        const alpha = Math.round(clamp(envelope * 220 * brightness, 0, 255));

        const haloRadius = 5 + brightness * 3;
        fillEllipse(g, x - haloRadius, y - haloRadius, haloRadius * 2, haloRadius * 2, argb(Math.round(alpha * 0.35), band.baseRed, band.baseGreen, band.baseBlue));
        fillEllipse(g, x - 2.4, y - 2.4, 4.8, 4.8, argb(alpha, band.baseRed, band.baseGreen, band.baseBlue));
      }
    }

    // Endpoint marker — listeners read as larger anchored dots.
    const endpointRadius = band.connection.isListener ? 5 : 3.5;
    const endpointAlpha = band.connection.isListener ? 220 : 200;
    fillEllipse(g, band.endpointX - endpointRadius - 2, band.endpointY - endpointRadius - 2, (endpointRadius + 2) * 2, (endpointRadius + 2) * 2, argb(Math.round(endpointAlpha * 0.35), band.baseRed, band.baseGreen, band.baseBlue));
    fillEllipse(g, band.endpointX - endpointRadius, band.endpointY - endpointRadius, endpointRadius * 2, endpointRadius * 2, argb(endpointAlpha, band.baseRed, band.baseGreen, band.baseBlue));
  }
}

function drawLegend(g: bigint): void {
  drawText(g, 'Network Aurora', titleFont, 32, 24, 400, 32, argb(230, 0xff, 0xff, 0xff));
  drawText(g, 'every TCP/UDP connection flowing as light', labelFont, 32, 54, 460, 20, argb(160, 0xff, 0xff, 0xff));

  const swatches: { label: string; color: { red: number; green: number; blue: number } }[] = [
    { label: 'ESTABLISHED', color: COLOR_ESTABLISHED },
    { label: 'LISTEN', color: COLOR_LISTEN },
    { label: 'TIME_WAIT / CLOSE_WAIT', color: COLOR_TRANSIENT },
    { label: 'UDP', color: COLOR_UDP },
  ];
  const legendX = WINDOW_WIDTH - 260;
  let legendY = 24;
  for (const item of swatches) {
    fillEllipse(g, legendX, legendY + 6, 10, 10, argb(255, item.color.red, item.color.green, item.color.blue));
    drawText(g, item.label, labelFont, legendX + 18, legendY, 240, 20, argb(200, 0xff, 0xff, 0xff));
    legendY += 22;
  }
}

function drawTopTable(g: bigint): void {
  // Aggregate bands by (kind, remote) so the table has visual weight.
  const counts = new Map<string, { count: number; sample: Connection }>();
  for (const band of Array.from(bandsByKey.values())) {
    const key = `${band.connection.kind}|${band.connection.remoteDisplay}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { count: 1, sample: band.connection });
  }
  const sorted = Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, 12);

  const tableX = 32;
  let tableY = 96;
  drawText(g, 'top endpoints', labelFont, tableX, tableY, 360, 18, argb(200, 0xff, 0xff, 0xff));
  tableY += 22;
  for (const entry of sorted) {
    const proc = lookupProcessName(entry.sample.pid);
    const kindLabel = entry.sample.kind.toUpperCase();
    const remote = entry.sample.remoteDisplay.length > 32 ? entry.sample.remoteDisplay.slice(0, 31) + '…' : entry.sample.remoteDisplay;
    const line = `${entry.count.toString().padStart(2, ' ')}  ${kindLabel.padEnd(5)}  ${remote.padEnd(34)} ${proc}`;
    const c = colorForConnection(entry.sample);
    fillEllipse(g, tableX, tableY + 6, 6, 6, argb(220, c.red, c.green, c.blue));
    drawText(g, line, hudFont, tableX + 12, tableY, 480, 16, argb(170, 0xff, 0xff, 0xff));
    tableY += 16;
  }
}

function drawHud(g: bigint, frame: number, fps: number): void {
  const s = lastSummary;
  const lines = [
    `total ${s.total}    TCPv4 ${s.tcp4}    TCPv6 ${s.tcp6}    UDPv4 ${s.udp4}    UDPv6 ${s.udp6}`,
    `established ${s.established}    listen ${s.listen}    transient ${s.transient}`,
    `poll ${lastPollDurationMs.toFixed(1)} ms    frame ${frame}    ${fps.toFixed(1)} fps`,
    'esc to quit',
  ];
  let y = WINDOW_HEIGHT - 80;
  for (const line of lines) {
    drawText(g, line, hudFont, 32, y, WINDOW_WIDTH - 64, 18, argb(150, 0xff, 0xff, 0xff));
    y += 16;
  }
}

function blitToWindow(): void {
  const windowDc = User32.GetDC(windowHandle);
  if (!windowDc) return;
  const windowGraphicsBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateFromHDC(windowDc, windowGraphicsBuffer.ptr) === Status.Ok) {
    const windowGraphics = windowGraphicsBuffer.readBigUInt64LE(0);
    Gdiplus.GdipDrawImageRectI(windowGraphics, offscreenBitmap, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
    Gdiplus.GdipDeleteGraphics(windowGraphics);
  }
  User32.ReleaseDC(windowHandle, windowDc);
}

// ── Main loop ────────────────────────────────────────────────────────────────

console.log('Network Aurora running. ESC closes the window.');
refreshNetwork();
let lastPollMs = Date.now();
console.log(`  initial poll: ${lastSummary.total} connections (TCPv4=${lastSummary.tcp4}, TCPv6=${lastSummary.tcp6}, UDPv4=${lastSummary.udp4}, UDPv6=${lastSummary.udp6})`);
fillRect(offscreenGraphics, 0, 0, 0, 0, 0); // touch fillRect so the helper isn't dead-stripped by future bundlers

const messageBuffer = Buffer.alloc(48);
const messageView = new DataView(messageBuffer.buffer);
let frameCount = 0;
let lastFrameMs = Date.now();
let fpsAverage = 60;

while (!shouldClose) {
  while (User32.PeekMessageW(messageBuffer.ptr, 0n, 0, 0, PeekMessageRemoveFlag.PM_REMOVE)) {
    if (messageView.getUint32(8, true) === WM_QUIT) { shouldClose = true; break; }
    User32.TranslateMessage(messageBuffer.ptr);
    User32.DispatchMessageW(messageBuffer.ptr);
  }
  if (shouldClose) break;

  const now = Date.now();
  const deltaMs = now - lastFrameMs;
  const deltaSeconds = Math.max(0.001, deltaMs / 1000);
  lastFrameMs = now;
  fpsAverage = fpsAverage * 0.9 + (1 / deltaSeconds) * 0.1;

  if (now - lastPollMs >= NETWORK_REFRESH_MS) {
    refreshNetwork();
    lastPollMs = now;
  }

  Gdiplus.GdipGraphicsClear(offscreenGraphics, argb(255, 8, 8, 18));
  drawBackground(offscreenGraphics);
  drawBands(offscreenGraphics, deltaSeconds);
  drawAnchor(offscreenGraphics, (now % 3000) / 3000);
  drawLegend(offscreenGraphics);
  drawTopTable(offscreenGraphics);
  drawHud(offscreenGraphics, frameCount, fpsAverage);
  blitToWindow();
  frameCount++;

  const elapsed = Date.now() - now;
  const sleepMs = FRAME_BUDGET_MS - elapsed;
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
console.log('Done.');
