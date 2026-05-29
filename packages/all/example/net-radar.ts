/**
 * Net Radar — a live GPU radar of every TCP/UDP connection on THIS machine.
 *
 * A borderless 1280x720 window becomes a glowing sonar/radar scope. Every active
 * socket on the box is polled synchronously from the Windows IP Helper API
 * (GetExtendedTcpTable / GetExtendedUdpTable, the two-call sizing dance), hand-
 * parsed into rows, and plotted as a luminous blip. A blip's BEARING comes from a
 * stable FNV-1a hash of the remote IPv4 address (so the same host always lands at
 * the same angle), its RADIUS from a second hash mixed with the remote port, and
 * its COLOR from the TCP state — ESTABLISHED green, SYN amber, TIME_WAIT dim red,
 * UDP cyan. A rotating sweep gradient sweeps the scope; whenever the beam passes a
 * blip it flares, and brand-new connections punch out an expanding pulse ring.
 *
 * Remote IPs are reverse-resolved to hostnames in real time: Winsock is started
 * once (WSAStartup 2.2), then a SOCKADDR_IN is assembled per unseen remote address
 * and handed to getnameinfo() — instant, returning a name whenever the OS resolver
 * already has the PTR cached. For the rest, a strictly throttled, budget-capped
 * gethostbyaddr() does a real blocking reverse query (at most one per ~0.9 s, and
 * paused near a timed run's capture deadline) so a slow PTR never stalls the
 * render. Results are cached by address; the dotted IP shows until the name
 * arrives. Loopback / link-local / unspecified / LISTEN rows are skipped. To
 * guarantee the scope is never empty on an idle box, a handful of outbound
 * fetch()es to well-known hosts are kicked off at startup. The final summary
 * cross-checks one resolved name against Windows' own Resolve-DnsName resolver.
 *
 * Nothing is faked: the blips are your real sockets, the names are real PTR
 * records, and the scope is drawn entirely in a runtime-compiled HLSL pixel shader
 * reading a per-frame structured buffer over additive blending on the real
 * ID3D11Device. A GDI HUD + a console table list every parsed connection.
 *
 * @bun-win32 APIs used:
 *   Iphlpapi.GetExtendedTcpTable / GetExtendedUdpTable     (two-call sizing, hand-parsed rows)
 *   Ws2_32.WSAStartup / getnameinfo / gethostbyaddr / WSACleanup  (reverse DNS, caller-owned buffers)
 *   _gpu: createWindow / createDevice / compile / makeVertexShader / makePixelShader /
 *         makeStructuredBuffer (cpuWritable SRV) / updateDynamicBuffer / makeConstantBuffer /
 *         updateConstantBuffer / vsSet / psSet / drawFullscreenTriangle / present / comRelease
 *   _snapshot: captureBackBuffer / formatGrid   (gallery PNG + self-verification)
 *   GDI32 CreateFontW / TextOutW                (HUD)
 *
 * Run: bun run packages/all/example/net-radar.ts
 */

import { FFIType, read, type Pointer } from 'bun:ffi';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import { GDI32, Iphlpapi, User32, Ws2_32 } from '../index';
import {
  comRelease,
  compile,
  createDevice,
  createWindow,
  drawFullscreenTriangle,
  makeConstantBuffer,
  makePixelShader,
  makeSampler,
  makeStructuredBuffer,
  makeTexture,
  makeVertexShader,
  psSet,
  setRenderTargets,
  setViewport,
  clear,
  updateConstantBuffer,
  updateDynamicBuffer,
  vcall,
  vsSet,
  CTX_UPDATE_SUBRESOURCE,
  DXGI_FORMAT_B8G8R8A8_UNORM,
} from './_gpu';
import { captureBackBuffer, formatGrid } from './_snapshot';

const encodeWide = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');

const WIDTH = 1280;
const HEIGHT = 720;
const MAX_BLIPS = 512;

// ── Win32 / API constants ──────────────────────────────────────────────────────
const AF_INET = 2;
const TCP_TABLE_OWNER_PID_ALL = 5;
const UDP_TABLE_OWNER_PID = 1;
const ERROR_INSUFFICIENT_BUFFER = 122;
const NI_NUMERICSERV = 0x02; // we only want the host name, not the service

const tcpStateNames = new Map<number, string>([
  [1, 'CLOSED'],
  [2, 'LISTEN'],
  [3, 'SYN_SENT'],
  [4, 'SYN_RCVD'],
  [5, 'ESTABLISHED'],
  [6, 'FIN_WAIT1'],
  [7, 'FIN_WAIT2'],
  [8, 'CLOSE_WAIT'],
  [9, 'CLOSING'],
  [10, 'LAST_ACK'],
  [11, 'TIME_WAIT'],
  [12, 'DELETE_TCB'],
]);

// Render-side "kind" used to pick a color in the shader.
const KIND_ESTABLISHED = 0;
const KIND_SYN = 1;
const KIND_WAIT = 2;
const KIND_UDP = 3;
const KIND_OTHER = 4;

function stateToKind(state: number): number {
  switch (state) {
    case 5:
      return KIND_ESTABLISHED;
    case 3:
    case 4:
      return KIND_SYN;
    case 6:
    case 7:
    case 8:
    case 9:
    case 10:
    case 11:
    case 12:
      return KIND_WAIT;
    default:
      return KIND_OTHER;
  }
}

function ipFromU32(val: number): string {
  return `${val & 0xff}.${(val >>> 8) & 0xff}.${(val >>> 16) & 0xff}.${(val >>> 24) & 0xff}`;
}
function portFromNet(networkOrderPort: number): number {
  // Only the low 16 bits hold the port (network byte order).
  return (((networkOrderPort & 0xff) << 8) | ((networkOrderPort >>> 8) & 0xff)) & 0xffff;
}

// A remote IPv4 we should NOT plot (no meaningful "remote" target).
function isPlottableRemote(addr: number): boolean {
  if (addr === 0) return false; // 0.0.0.0 — unbound / listening
  const b0 = addr & 0xff;
  const b1 = (addr >>> 8) & 0xff;
  if (b0 === 127) return false; // 127.0.0.0/8 loopback
  if (b0 === 169 && b1 === 254) return false; // 169.254.0.0/16 link-local
  if (addr === 0xffffffff) return false; // 255.255.255.255 broadcast
  return true;
}

// ── Stable hashing: remote addr → bearing, (addr,port) → radius ─────────────────
function fnv1a(bytes: number[]): number {
  let h = 0x811c9dc5 >>> 0;
  for (const b of bytes) {
    h ^= b & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function bearingForAddr(addr: number): number {
  const h = fnv1a([addr & 0xff, (addr >>> 8) & 0xff, (addr >>> 16) & 0xff, (addr >>> 24) & 0xff]);
  return (h / 0x1_0000_0000) * Math.PI * 2;
}
function radiusForAddrPort(addr: number, port: number): number {
  const h = fnv1a([
    (addr >>> 24) & 0xff,
    addr & 0xff,
    port & 0xff,
    (port >>> 8) & 0xff,
    (addr >>> 8) & 0xff,
  ]);
  // Keep blips in a well-spread annulus (0.42 .. 0.96 of the scope radius) so they
  // never pile up at the hub and stay clear of the bright center glow.
  return 0.42 + (h / 0x1_0000_0000) * 0.54;
}
// Stable per-connection angular jitter so many sockets to the SAME host fan out
// across a few degrees instead of stacking into one blob.
function jitterForPort(addr: number, port: number): number {
  const h = fnv1a([
    port & 0xff,
    (port >>> 8) & 0xff,
    (addr >>> 16) & 0xff,
    addr & 0xff,
  ]);
  return ((h / 0x1_0000_0000) - 0.5) * (Math.PI / 14); // +-~6.4 deg spread
}

// ── Reverse-DNS cache (resolve off the hot path; never repeatedly block) ────────
// Two-stage, both synchronous Winsock calls:
//   1. getnameinfo() — instant; returns a name only when the OS resolver already
//      has the PTR cached (otherwise it hands back the numeric form). Free to call.
//   2. gethostbyaddr() fallback — performs a REAL blocking reverse query for names
//      getnameinfo didn't have. It can take tens of ms (or time out after seconds
//      on a host with no PTR), so we run at most ONE per DNS_FALLBACK_MS — a rare
//      single-frame hitch the 1000+ fps headroom completely hides, never a stall.
interface DnsEntry {
  host: string | null; // resolved name, or null while pending / no PTR
  done: boolean; // getnameinfo + (optionally) gethostbyaddr have both been tried
}
const dnsCache = new Map<number, DnsEntry>();
const dnsFastQueue: number[] = []; // pending getnameinfo (instant)
const dnsSlowQueue: number[] = []; // pending gethostbyaddr (blocking, throttled)
const DNS_FALLBACK_MS = 900; // min gap between blocking fallback lookups
const DNS_SLOW_BUDGET = 12; // hard cap on total blocking lookups (each can take seconds)
let lastSlowResolve = -1e9;
let slowResolveCount = 0;
let slowResolvePaused = false; // set true near the capture deadline so it never overshoots

// Reusable scratch buffers (assembled immediately before each Winsock call).
function tryGetNameInfo(addr: number): string | null {
  // SOCKADDR_IN (16 bytes): sin_family u16=AF_INET@0, sin_port u16@2,
  // sin_addr = raw 4 bytes of the address @4 (NO byte swap), zero padding @8..15.
  const sa = Buffer.alloc(16);
  sa.writeUInt16LE(AF_INET, 0);
  sa.writeUInt16LE(0, 2);
  sa.writeUInt32LE(addr >>> 0, 4); // dwRemoteAddr is already network-order bytes
  const hostBuf = Buffer.alloc(256);
  const rc = Ws2_32.getnameinfo(sa.ptr!, 16, hostBuf.ptr!, 256, null, 0, NI_NUMERICSERV);
  if (rc !== 0) return null;
  const name = hostBuf.toString('ascii').replace(/\0.*$/, '');
  // getnameinfo hands back the dotted IP when it has no cached PTR — treat as miss.
  return name.length > 0 && name !== ipFromU32(addr) ? name : null;
}
function tryGetHostByAddr(addr: number): string | null {
  // gethostbyaddr(addr=4 raw network-order bytes, len=4, type=AF_INET).
  const raw = Buffer.alloc(4);
  raw.writeUInt32LE(addr >>> 0, 0);
  const hostentPtr = Ws2_32.gethostbyaddr(raw.ptr!, 4, AF_INET);
  if (!hostentPtr) return null;
  // HOSTENT (x64): h_name ptr@0, h_aliases@8, h_addrtype i16@16, h_length i16@18, h_addr_list@24.
  const namePtr = read.u64(Number(hostentPtr) as Pointer, 0);
  if (namePtr === 0n) return null;
  let name = '';
  for (let i = 0; i < 255; i += 1) {
    const b = read.u8(Number(namePtr) as Pointer, i);
    if (b === 0) break;
    name += String.fromCharCode(b);
  }
  return name.length > 0 && name !== ipFromU32(addr) ? name : null;
}
function ensureDns(addr: number): void {
  if (dnsCache.has(addr)) return;
  dnsCache.set(addr, { host: null, done: false });
  dnsFastQueue.push(addr);
}
function pumpDns(now: number, maxFast: number): void {
  // Stage 1: drain a few instant getnameinfo lookups.
  let n = 0;
  while (n < maxFast && dnsFastQueue.length > 0) {
    const addr = dnsFastQueue.shift()!;
    const entry = dnsCache.get(addr);
    if (!entry) continue;
    const name = tryGetNameInfo(addr);
    if (name) {
      entry.host = name;
      entry.done = true;
    } else {
      dnsSlowQueue.push(addr); // hand off to the throttled blocking fallback
    }
    n += 1;
  }
  // Stage 2: at most one blocking gethostbyaddr per DNS_FALLBACK_MS, hard-capped
  // and paused near the capture deadline (a single lookup can block for seconds).
  if (
    !slowResolvePaused &&
    slowResolveCount < DNS_SLOW_BUDGET &&
    dnsSlowQueue.length > 0 &&
    now - lastSlowResolve >= DNS_FALLBACK_MS
  ) {
    lastSlowResolve = now;
    slowResolveCount += 1;
    const addr = dnsSlowQueue.shift()!;
    const entry = dnsCache.get(addr);
    if (entry) {
      entry.host = tryGetHostByAddr(addr);
      entry.done = true;
    }
  }
}

// ── Connection model ────────────────────────────────────────────────────────────
interface Conn {
  key: string; // localAddr:localPort-remoteAddr:remotePort-proto
  remoteAddr: number;
  remotePort: number;
  localAddr: number;
  localPort: number;
  pid: number;
  kind: number;
  state: number; // TCP state, or -1 for UDP
  bornAt: number; // performance.now() when first seen — drives the pulse ring
}
const liveConns = new Map<string, Conn>();

// ── Poll the OS tables (synchronous, two-call sizing) ───────────────────────────
const sizeBuf = Buffer.alloc(4);

function pollTcp(now: number): void {
  sizeBuf.writeUInt32LE(0, 0);
  let rc = Iphlpapi.GetExtendedTcpTable(null, sizeBuf.ptr!, 0, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
  if (rc !== ERROR_INSUFFICIENT_BUFFER) return;
  const size = sizeBuf.readUInt32LE(0);
  if (size < 4) return;
  const table = Buffer.alloc(size);
  rc = Iphlpapi.GetExtendedTcpTable(table.ptr!, sizeBuf.ptr!, 0, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
  if (rc !== 0) return;

  // MIB_TCPTABLE_OWNER_PID: dwNumEntries u32@0, then N rows of 24 bytes:
  //   dwState@0 dwLocalAddr@4 dwLocalPort@8 dwRemoteAddr@12 dwRemotePort@16 dwOwningPid@20.
  const num = table.readUInt32LE(0);
  // Verify the stride matches the returned size (sanity guard on the layout).
  if (num * 24 + 4 > size) return;
  for (let i = 0; i < num; i += 1) {
    const o = 4 + i * 24;
    const state = table.readUInt32LE(o);
    const localAddr = table.readUInt32LE(o + 4);
    const localPort = portFromNet(table.readUInt32LE(o + 8));
    const remoteAddr = table.readUInt32LE(o + 12);
    const remotePort = portFromNet(table.readUInt32LE(o + 16));
    const pid = table.readUInt32LE(o + 20);
    if (state === 2) continue; // LISTEN — no remote target
    if (!isPlottableRemote(remoteAddr)) continue;
    const key = `${localAddr}:${localPort}-${remoteAddr}:${remotePort}-t`;
    const existing = liveConns.get(key);
    if (existing) {
      existing.state = state;
      existing.kind = stateToKind(state);
    } else {
      liveConns.set(key, {
        key,
        remoteAddr,
        remotePort,
        localAddr,
        localPort,
        pid,
        state,
        kind: stateToKind(state),
        bornAt: now,
      });
    }
    ensureDns(remoteAddr);
  }
}

function pollUdp(now: number): void {
  sizeBuf.writeUInt32LE(0, 0);
  let rc = Iphlpapi.GetExtendedUdpTable(null, sizeBuf.ptr!, 0, AF_INET, UDP_TABLE_OWNER_PID, 0);
  if (rc !== ERROR_INSUFFICIENT_BUFFER) return;
  const size = sizeBuf.readUInt32LE(0);
  if (size < 4) return;
  const table = Buffer.alloc(size);
  rc = Iphlpapi.GetExtendedUdpTable(table.ptr!, sizeBuf.ptr!, 0, AF_INET, UDP_TABLE_OWNER_PID, 0);
  if (rc !== 0) return;

  // MIB_UDPTABLE_OWNER_PID: dwNumEntries u32@0, then N rows of 12 bytes:
  //   dwLocalAddr@0 dwLocalPort@4 dwOwningPid@8.
  const num = table.readUInt32LE(0);
  if (num * 12 + 4 > size) return;
  for (let i = 0; i < num; i += 1) {
    const o = 4 + i * 12;
    const localAddr = table.readUInt32LE(o);
    const localPort = portFromNet(table.readUInt32LE(o + 4));
    const pid = table.readUInt32LE(o + 8);
    // UDP is connectionless: plot a blip keyed on (localAddr,localPort) so the
    // active listeners/senders still register on the scope as cyan.
    if (localAddr === 0) continue; // wildcard 0.0.0.0 bind — skip the duplicates
    if (!isPlottableRemote(localAddr)) continue;
    const key = `${localAddr}:${localPort}-u`;
    if (!liveConns.has(key)) {
      liveConns.set(key, {
        key,
        remoteAddr: localAddr, // hash off the local addr for placement
        remotePort: localPort,
        localAddr,
        localPort,
        pid,
        state: -1,
        kind: KIND_UDP,
        bornAt: now,
      });
    }
  }
}

// Drop connections that disappeared from the OS tables for a few seconds so the
// scope stays current (we age them out rather than clearing every poll).
function ageOut(now: number, seenKeys: Set<string>): void {
  for (const [key, conn] of liveConns) {
    if (!seenKeys.has(key) && now - conn.bornAt > 6000) liveConns.delete(key);
  }
}

// ── Window + device ─────────────────────────────────────────────────────────────
const win = createWindow({ title: 'Net Radar — live socket scope on the GPU', width: WIDTH, height: HEIGHT, borderless: true });
const { w: clientW, h: clientH } = win.clientSize();
const gpu = createDevice(win.hwnd, { width: clientW, height: clientH });
gpu.recreateRTV();

// Winsock for reverse DNS.
const wsaData = Buffer.alloc(408);
const wsaRc = Ws2_32.WSAStartup(0x0202, wsaData.ptr!);
if (wsaRc !== 0) console.log(`  WSAStartup failed (error ${wsaRc}) — names will show as raw IPs.`);

// ── Blip structured buffer (per-frame upload) ───────────────────────────────────
// struct Blip { float x; float y; uint kind; float pulse; float beam; float callout; float pad1,pad2; } = 32 bytes.
//   callout = 1.0 for the connections we also draw a hostname label for (shader adds
//   a tasteful tracking ring so the eye connects the blip to its text).
const BLIP_STRIDE = 32;
const blipBuf = makeStructuredBuffer({ stride: BLIP_STRIDE, count: MAX_BLIPS, srv: true, cpuWritable: true });
const blipData = Buffer.alloc(BLIP_STRIDE * MAX_BLIPS);

// ── Label/HUD overlay texture (real GDI text baked INTO the hero frame) ──────────
// We render the scope's title, the color-coded legend, and a staggered set of
// resolved-hostname labels (with leader lines back to their blips) into a top-down
// BGRA DIB section using GDI, then upload those bytes into a B8G8R8A8 texture each
// frame and composite it in the pixel shader. Because it lives in the back buffer,
// the captured PNG itself shows a fully *labeled*, alive radar — not just dots.
const OVR_W = clientW;
const OVR_H = clientH;
const ovrTex = makeTexture({ w: OVR_W, h: OVR_H, format: DXGI_FORMAT_B8G8R8A8_UNORM, srv: true });
const ovrSampler = makeSampler();
// BITMAPINFOHEADER (40 bytes) + top-down (negative height) 32bpp BGRA DIB.
const bmi = Buffer.alloc(40);
bmi.writeUInt32LE(40, 0); // biSize
bmi.writeInt32LE(OVR_W, 4); // biWidth
bmi.writeInt32LE(-OVR_H, 8); // biHeight (negative => top-down rows)
bmi.writeUInt16LE(1, 12); // biPlanes
bmi.writeUInt16LE(32, 14); // biBitCount
bmi.writeUInt32LE(0, 16); // biCompression = BI_RGB
const ovrBitsPtrBuf = Buffer.alloc(8); // receives the DIB pixel pointer
const ovrMemDC = GDI32.CreateCompatibleDC(0n);
const ovrDib = GDI32.CreateDIBSection(ovrMemDC, bmi.ptr!, 0 /* DIB_RGB_COLORS */, ovrBitsPtrBuf.ptr!, 0n, 0);
GDI32.SelectObject(ovrMemDC, ovrDib);
const ovrBitsPtr = ovrBitsPtrBuf.readBigUInt64LE(0);
const OVR_ROW_PITCH = OVR_W * 4;
GDI32.SetBkMode(ovrMemDC, 1 /* TRANSPARENT */);
GDI32.SetTextAlign(ovrMemDC, 0 /* TA_LEFT | TA_TOP */);

// Fonts baked into the overlay (DIB) — separate handles from the live-window HUD.
const ovrTitleFont = GDI32.CreateFontW(-24, 0, 0, 0, 800, 0, 0, 0, 0, 0, 0, 4, 0, encodeWide('Consolas').ptr!);
const ovrLabelFont = GDI32.CreateFontW(-16, 0, 0, 0, 700, 0, 0, 0, 0, 0, 0, 4, 0, encodeWide('Consolas').ptr!);
const ovrSmallFont = GDI32.CreateFontW(-13, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 4, 0, encodeWide('Consolas').ptr!);

// Clear the whole DIB to black (BitBlt BLACKNESS writes 0x00000000 BGRA). GDI text
// does not touch the alpha byte of a 32bpp DIB, so the shader composites the overlay
// by LUMINANCE (max RGB) rather than alpha — text pops, the black field stays clear.
const BLACKNESS = 0x00000042;
function clearOverlay(): void {
  GDI32.BitBlt(ovrMemDC, 0, 0, OVR_W, OVR_H, 0n, 0, 0, BLACKNESS);
}

// GDI text helper into the overlay DIB at (x,y) with a BGR color.
function ovrText(x: number, y: number, text: string, bgr: number): void {
  GDI32.SetTextColor(ovrMemDC, bgr);
  const w = encodeWide(text);
  GDI32.TextOutW(ovrMemDC, x, y, w.ptr!, text.length);
}
// Monospace Consolas advance is ~0.55em; good enough for layout without GetTextExtent.
function textWidthPx(text: string, emPx: number): number {
  return Math.ceil(text.length * emPx * 0.55);
}

// Upload the GDI-drawn DIB into the overlay texture for this frame.
function uploadOverlay(): void {
  GDI32.GdiFlush();
  vcall(
    gpu.context,
    CTX_UPDATE_SUBRESOURCE,
    [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32],
    [ovrTex.tex, 0, null, ovrBitsPtr, OVR_ROW_PITCH, 0],
    FFIType.void,
  );
}

// ── Constant buffer ──────────────────────────────────────────────────────────────
// cbuffer Radar : float time; float sweepAngle; uint connCount; float aspect;
//                 float2 res; float scopeR; float pad; (32 bytes)
const CB_SIZE = 32;
const cb = makeConstantBuffer(CB_SIZE);
const cbData = Buffer.alloc(CB_SIZE);

// ── HLSL ──────────────────────────────────────────────────────────────────────
const VS = `
struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
VSOut main(uint vid : SV_VertexID) {
  VSOut o;
  float2 p = float2((vid << 1) & 2, vid & 2);
  o.uv = p;                                   // 0..2
  o.pos = float4(p * float2(2.0,-2.0) + float2(-1.0,1.0), 0.0, 1.0);
  return o;
}
`;

const PS = `
cbuffer Radar : register(b0) {
  float uTime; float uSweep; uint uCount; float uAspect;
  float2 uRes; float uScopeR; float uPad;
};
struct Blip { float x; float y; uint kind; float pulse; float beam; float callout; float p1; float p2; };
StructuredBuffer<Blip> Blips : register(t0);
Texture2D    Overlay : register(t1);   // GDI-baked title / legend / hostname labels
SamplerState Samp    : register(s0);

static const float PI = 3.14159265;

float3 kindColor(uint k) {
  if (k == 0u) return float3(0.16, 1.00, 0.42);   // ESTABLISHED — vivid green
  if (k == 1u) return float3(1.00, 0.66, 0.10);   // SYN — hot amber
  if (k == 2u) return float3(1.00, 0.24, 0.30);   // TIME_WAIT/closing — red (dim weight)
  if (k == 3u) return float3(0.18, 0.86, 1.00);   // UDP — electric cyan
  return float3(0.82, 0.82, 0.98);                // other — pale
}
// per-state brightness weight (TIME_WAIT reads dimmer, ESTABLISHED/UDP pop)
float kindWeight(uint k) {
  if (k == 2u) return 0.55;   // TIME_WAIT — intentionally dim
  if (k == 1u) return 1.10;   // SYN
  return 1.0;
}

float4 main(float4 fragPos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
  // Center-origin coords, aspect-corrected so the scope is circular.
  float2 p = (fragPos.xy / uRes) * 2.0 - 1.0;     // -1..1
  p.x *= uAspect;
  float r = length(p);
  float ang = atan2(p.y, p.x);                    // -PI..PI
  float inside = smoothstep(uScopeR + 0.006, uScopeR - 0.006, r);

  // ── deep scope background: near-black outside, dark teal disc inside ──
  float3 col = float3(0.004, 0.010, 0.013);
  col += float3(0.003, 0.016, 0.020) * inside * (1.0 - r / uScopeR);   // faint radial fill
  // faint phosphor speckle so the disc reads as a CRT, not flat paint
  float spk = frac(sin(dot(floor(fragPos.xy / 2.0), float2(12.9898, 78.233))) * 43758.5453);
  col += float3(0.0, 0.012, 0.010) * inside * spk;

  // ── concentric range rings (thin, crisp) ──────────────────────────────────
  float ring = 0.0;
  [unroll]
  for (int i = 1; i <= 4; i++) {
    float rr = uScopeR * (float(i) / 4.0);
    ring += 0.052 / (abs(r - rr) * 420.0 + 1.0);
  }
  ring += 0.220 / (abs(r - uScopeR) * 200.0 + 1.0);     // bright outer rim
  col += float3(0.18, 1.10, 0.90) * ring;

  // ── cross-hair, 30-deg bearing ticks + 45-deg spokes ───────────────────────
  if (r < uScopeR) {
    float cross = 0.0;
    cross += 0.011 / (abs(p.y) * 320.0 + 1.0);
    cross += 0.011 / (abs(p.x) * 320.0 + 1.0);
    float spoke = abs(frac(ang / (PI / 4.0) + 0.5) - 0.5);
    cross += 0.008 / (spoke * 90.0 + 1.0) * smoothstep(0.0, 0.12, r);
    col += float3(0.10, 0.52, 0.47) * cross * inside;

    // bearing tick marks every 30 deg, hugging the outer rim
    float tick = abs(frac(ang / (PI / 6.0) + 0.5) - 0.5);
    float tickBand = smoothstep(uScopeR * 0.86, uScopeR * 0.96, r) * inside;
    col += float3(0.16, 0.98, 0.82) * (0.024 / (tick * 220.0 + 1.0)) * tickBand;
  }

  // ── rotating sweep: bold comet head + long phosphor afterglow ───────────────
  if (r < uScopeR) {
    float d = uSweep - ang;                          // signed lead
    d = d - floor(d / (2.0 * PI)) * (2.0 * PI);      // 0..2PI behind the beam
    float trail = exp(-d * 1.45);                    // long sodium-green afterglow
    float trail2 = exp(-d * 5.0);                    // bright inner comet tail
    float edge  = smoothstep(0.075, 0.0, d) * 2.4;   // crisp bright leading line
    float radialFade = smoothstep(0.0, uScopeR * 0.16, r); // dim at the hub
    float sweep = (trail * 0.85 + trail2 * 0.9 + edge) * radialFade * inside;
    col += float3(0.12, 1.00, 0.52) * sweep;
    // bright sweep tip sparkle riding the rim (the comet head)
    col += float3(0.45, 1.0, 0.70) * edge * smoothstep(uScopeR * 0.55, uScopeR, r) * inside;
  }

  // ── center hub glow (tight, so it reads as a pinpoint, not a flood) ──────────
  col += float3(0.12, 1.00, 0.58) * exp(-r * r * 900.0) * 1.25;
  col += float3(0.10, 0.90, 0.55) * exp(-r * r * 90.0) * 0.10;  // soft hub bloom

  // ── blips ──────────────────────────────────────────────────────────────────
  for (uint b = 0u; b < uCount; b++) {
    Blip bl = Blips[b];
    float2 bp = float2(bl.x, bl.y);
    float dist = length(p - bp);
    float3 bc = kindColor(bl.kind);
    float w  = kindWeight(bl.kind);

    // sharp luminous core + a contained soft halo; the sweep beam flares each blip
    float core = exp(-dist * dist * 5200.0);                 // tight hot point
    float halo = exp(-dist * dist * 360.0);                  // bounded soft glow
    float beamFlare = bl.beam;
    col += bc * w * (core * (2.8 + beamFlare * 5.0) + halo * (0.55 + beamFlare * 1.8));
    // white-hot center so bright blips bloom toward white before tonemap
    col += float3(0.9, 1.0, 0.95) * core * (0.95 + beamFlare * 1.8) * w;

    // tracking ring on called-out (labeled) connections so the eye links blip↔text
    if (bl.callout > 0.5) {
      float rr0 = 0.034;
      float cring = exp(-pow((dist - rr0) * 95.0, 2.0));
      col += bc * cring * (0.9 + beamFlare * 0.8);
      // a faint rotating reticle gap so the ring reads as an active "target lock"
      float ca = atan2(p.y - bp.y, p.x - bp.x);
      float gap = abs(frac((ca + uTime * 1.6) / (PI * 0.5)) - 0.5);
      col += bc * cring * smoothstep(0.10, 0.30, gap) * 0.6;
    }

    // expanding pulse ring for brand-new connections (fades over its first second)
    if (bl.pulse > 0.0) {
      float pr = bl.pulse * 0.18;
      float rr = exp(-pow((dist - pr) * 60.0, 2.0));
      col += bc * rr * (1.0 - bl.pulse) * 2.0;
    }
  }

  // ── tonemap + gamma + scanline-CRT vignette ──────────────────────────────────
  col = col / (col + 0.62);
  // soft horizontal scanlines for CRT feel (very subtle)
  float scan = 0.95 + 0.05 * sin(fragPos.y * 2.4);
  col *= scan;
  float vig = smoothstep(1.55, 0.10, r);
  col *= lerp(0.40, 1.0, vig);
  col = pow(saturate(col), 1.0 / 2.2);

  // ── composite the GDI-baked label overlay (title, legend, hostnames, leaders) ─
  // Drawn AFTER tonemap so text stays crisp & legible. The DIB is cleared to black
  // and text is bright, so luminance is the mask; we screen the colored text on top.
  float2 ouv = fragPos.xy / uRes;
  float4 ot = Overlay.Sample(Samp, ouv);
  float olum = max(ot.r, max(ot.g, ot.b));
  // screen blend: keeps the scope visible behind faint pixels, full color on glyphs
  col = 1.0 - (1.0 - col) * (1.0 - ot.rgb * smoothstep(0.04, 0.5, olum));
  col += ot.rgb * olum * 0.25;  // a touch of phosphor glow around the text

  return float4(col, 1.0);
}
`;

const vs = makeVertexShader(compile(VS, 'main', 'vs_5_0'));
const ps = makePixelShader(compile(PS, 'main', 'ps_5_0'));

// ── GDI HUD ─────────────────────────────────────────────────────────────────────
const hudFont = GDI32.CreateFontW(-16, 0, 0, 0, 600, 0, 0, 0, 0, 0, 0, 4, 0, encodeWide('Consolas').ptr!);
const smallFont = GDI32.CreateFontW(-13, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 4, 0, encodeWide('Consolas').ptr!);
function drawHud(fps: number, tcpN: number, udpN: number, resolved: number): void {
  const dc = User32.GetDC(win.hwnd);
  if (!dc) return;
  GDI32.SetBkMode(dc, 1 /* TRANSPARENT */);

  GDI32.SelectObject(dc, hudFont);
  const title = `NET RADAR · ${liveConns.size} sockets · ${tcpN} TCP / ${udpN} UDP · ${resolved} named · ${fps} fps · ESC`;
  const tw = encodeWide(title);
  GDI32.SetTextColor(dc, 0x00203010);
  GDI32.TextOutW(dc, 19, 15, tw.ptr!, title.length);
  GDI32.SetTextColor(dc, 0x0066ff66); // BGR green
  GDI32.TextOutW(dc, 18, 14, tw.ptr!, title.length);

  // Legend (color-coded states), top-right.
  GDI32.SelectObject(dc, smallFont);
  const legend: [string, number][] = [
    ['ESTABLISHED', 0x0066ff33],
    ['SYN', 0x002eb8ff],
    ['TIME_WAIT', 0x004d4dff],
    ['UDP', 0x00ffd94d],
  ];
  let lx = clientW - 150;
  let ly = 14;
  for (const [label, color] of legend) {
    const lw = encodeWide(label);
    GDI32.SetTextColor(dc, color);
    GDI32.TextOutW(dc, lx, ly, lw.ptr!, label.length);
    ly += 16;
  }

  // Bottom: a few resolved hostnames scrolling.
  let by = clientH - 18 * Math.min(8, liveConns.size) - 14;
  let shown = 0;
  GDI32.SetTextColor(dc, 0x0099ddaa);
  for (const conn of liveConns.values()) {
    if (shown >= 8) break;
    const dns = dnsCache.get(conn.remoteAddr);
    const name = dns?.host ?? ipFromU32(conn.remoteAddr);
    const proto = conn.state === -1 ? 'udp' : tcpStateNames.get(conn.state) ?? '?';
    const line = `${ipFromU32(conn.remoteAddr)}:${conn.remotePort}  ${proto.padEnd(12)} ${name}`;
    const lw = encodeWide(line);
    GDI32.TextOutW(dc, 18, by, lw.ptr!, line.length);
    by += 18;
    shown += 1;
  }

  User32.ReleaseDC(win.hwnd, dc);
}

// ── Overlay (baked-into-frame) labels ────────────────────────────────────────────
// Colors are 0x00BBGGRR (GDI COLORREF). Brighter than the HUD so they survive the
// shader's luminance-masked screen composite.
const OVR_TITLE = 0x0090ff90; // bright green
const OVR_DIM = 0x0080c090;
const OVR_LEGEND: [string, number, number][] = [
  ['ESTABLISHED', 0x0080ff66, KIND_ESTABLISHED],
  ['SYN/HANDSHAKE', 0x0044d0ff, KIND_SYN],
  ['TIME_WAIT', 0x006a6aff, KIND_WAIT],
  ['UDP', 0x00ffe874, KIND_UDP],
];
function legendBgr(kind: number): number {
  for (const [, c, k] of OVR_LEGEND) if (k === kind) return c;
  return 0x00d0d0e0;
}

interface LabelTarget {
  sx: number; // blip screen px
  sy: number;
  name: string; // hostname or dotted IP
  port: number;
  kind: number;
  significance: number; // higher = more worth labeling
}

// Draw the full overlay (title bar, legend, count, and N staggered hostname labels
// with leader lines back to their blips) into the DIB, then upload it as a texture.
function drawOverlay(targets: LabelTarget[], tcpN: number, udpN: number, resolved: number, fps: number): void {
  clearOverlay();

  // ── Title (top-left) ──────────────────────────────────────────────────────────
  GDI32.SelectObject(ovrMemDC, ovrTitleFont);
  ovrText(20, 12, 'NET RADAR', OVR_TITLE);
  GDI32.SelectObject(ovrMemDC, ovrSmallFont);
  ovrText(22, 46, 'live TCP/UDP socket scope · GPU/HLSL · real reverse-DNS', OVR_DIM);
  const sub = `${liveConns.size} sockets   ${tcpN} TCP / ${udpN} UDP   ${resolved} named   ${fps} fps`;
  ovrText(22, 64, sub, 0x00b0ffc8);

  // ── Legend (top-right) with filled color swatches ──────────────────────────────
  GDI32.SelectObject(ovrMemDC, ovrSmallFont);
  let lx = OVR_W - 210;
  let ly = 16;
  for (const [label, color] of OVR_LEGEND) {
    const brush = GDI32.CreateSolidBrush(color);
    const old = GDI32.SelectObject(ovrMemDC, brush);
    GDI32.PatBlt(ovrMemDC, lx, ly + 2, 12, 12, 0x00f00021 /* PATCOPY */);
    GDI32.SelectObject(ovrMemDC, old);
    GDI32.DeleteObject(brush);
    ovrText(lx + 20, ly, label, color);
    ly += 19;
  }

  // ── Hostname callouts to the margins (classic radar legend layout) ──────────────
  // Each labeled host is anchored to a clean stack of slots down the left or right
  // gutter (so the text never lands on a bright blip or overlaps a neighbour), with
  // a thin elbow leader line tracing back to its blip on the scope.
  GDI32.SelectObject(ovrMemDC, ovrLabelFont);
  const EM = 16;
  const ROWH = 28;
  const TOP_Y = 104; // below the title block
  const slotsPerSide = Math.floor((OVR_H - TOP_Y - 24) / ROWH);

  // Split targets by which gutter their blip is nearer, keep the strongest few each.
  const sorted = [...targets].sort((a, b) => b.significance - a.significance);
  const leftCol = sorted.filter((t) => t.sx < OVR_W * 0.5).slice(0, Math.min(5, slotsPerSide));
  const rightCol = sorted.filter((t) => t.sx >= OVR_W * 0.5).slice(0, Math.min(5, slotsPerSide));
  // Within each gutter, order top→bottom by the blip's own Y so leaders don't cross.
  leftCol.sort((a, b) => a.sy - b.sy);
  rightCol.sort((a, b) => a.sy - b.sy);

  const drawColumn = (col: LabelTarget[], onRight: boolean): void => {
    let slotY = TOP_Y;
    for (const t of col) {
      const text = `${t.name}:${t.port}`;
      const wpx = textWidthPx(text, EM);
      const lxp = onRight ? OVR_W - wpx - 22 : 22;
      const lyp = slotY;
      slotY += ROWH;
      const lineColor = legendBgr(t.kind);

      // A small dim tick beside the text so the gutter reads as a key column.
      const swatch = GDI32.CreateSolidBrush(lineColor);
      const oldB = GDI32.SelectObject(ovrMemDC, swatch);
      GDI32.PatBlt(ovrMemDC, onRight ? OVR_W - 12 : 4, lyp + 3, 6, 12, 0x00f00021 /* PATCOPY */);
      GDI32.SelectObject(ovrMemDC, oldB);
      GDI32.DeleteObject(swatch);

      // Elbow leader: blip → vertical drop to the slot's mid-line → into the gutter.
      const pen = GDI32.CreatePen(0 /* PS_SOLID */, 1, (lineColor & 0x00787878) | 0x00282828);
      const oldPen = GDI32.SelectObject(ovrMemDC, pen);
      const gutterX = onRight ? OVR_W - 18 : 18;
      const midY = lyp + 9;
      GDI32.MoveToEx(ovrMemDC, t.sx, t.sy, null);
      GDI32.LineTo(ovrMemDC, gutterX, t.sy);
      GDI32.LineTo(ovrMemDC, gutterX, midY);
      GDI32.SelectObject(ovrMemDC, oldPen);
      GDI32.DeleteObject(pen);

      ovrText(lxp, lyp, text, lineColor);
    }
  };
  drawColumn(leftCol, false);
  drawColumn(rightCol, true);

  uploadOverlay();
}

// ── Kick off live outbound connections so the scope is never empty ──────────────
const seedHosts = [
  'https://one.one.one.one/',
  'https://dns.google/',
  'https://www.cloudflare.com/',
  'https://example.com/',
  'https://www.microsoft.com/',
  'https://github.com/',
  'https://www.wikipedia.org/',
  'https://www.bing.com/',
  'https://www.apple.com/',
  'https://www.amazon.com/',
  'https://www.mozilla.org/',
  'https://www.youtube.com/',
  'https://www.reddit.com/',
  'https://www.stackoverflow.com/',
  'https://www.npmjs.com/',
  'https://nodejs.org/',
];
function seedConnections(): void {
  for (const url of seedHosts) {
    // Fire-and-forget; we only care that the socket exists for a moment.
    fetch(url, { method: 'GET' })
      .then(async (r) => {
        try {
          await r.arrayBuffer();
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* ignore — offline hosts simply won't appear */
      });
  }
}

// ── Teardown ─────────────────────────────────────────────────────────────────────
let cleaned = false;
function cleanup(code: number): never {
  if (!cleaned) {
    cleaned = true;
    try {
      Ws2_32.WSACleanup();
    } catch {
      /* ignore */
    }
    // Best-effort COM teardown — wrapped so a release race in the FFI layer can
    // never stop us from destroying the visible window and exiting cleanly.
    try {
      GDI32.DeleteObject(hudFont);
      GDI32.DeleteObject(smallFont);
      GDI32.DeleteObject(ovrTitleFont);
      GDI32.DeleteObject(ovrLabelFont);
      GDI32.DeleteObject(ovrSmallFont);
      GDI32.DeleteObject(ovrDib);
      GDI32.DeleteDC(ovrMemDC);
      comRelease(ovrSampler);
      comRelease(ovrTex.srv ?? 0n);
      comRelease(ovrTex.tex);
      comRelease(blipBuf.srv ?? 0n);
      comRelease(blipBuf.buffer);
      comRelease(cb);
      comRelease(ps);
      comRelease(vs);
      comRelease(gpu.backBufferRTV);
      comRelease(gpu.swapChain);
      comRelease(gpu.context);
      comRelease(gpu.device);
    } catch {
      /* ignore — process exit reclaims everything */
    }
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}
process.on('SIGINT', () => cleanup(0));
process.on('uncaughtException', (err) => {
  console.error(err);
  cleanup(1);
});

console.log('Net Radar — live TCP/UDP socket scope rendered on the GPU.');
console.log(`  ${clientW}x${clientH} · ${gpu.driver} · ${gpu.gpuName}`);
console.log('  Seeding a few outbound connections so the scope has live data...');
seedConnections();

// ── Render loop ──────────────────────────────────────────────────────────────────
const start = performance.now();
const durationMs = process.env.DEMO_DURATION_MS ? Number(process.env.DEMO_DURATION_MS) : 0;
const nullSrv = Buffer.alloc(16); // two null SRV slots to unbind (t0 blip + t1 overlay)

let frame = 0;
let fps = 0;
let fpsFrames = 0;
let fpsWindow = start;
let lastPoll = -1e9;
let lastTcpN = 0;
let lastUdpN = 0;
let consolePrinted = false;
let capturedThisRun = false;

while (!win.shouldClose()) {
  win.pump();
  if (win.shouldClose()) break;

  const now = performance.now();
  const time = (now - start) / 1000;

  // Poll the OS ~1/sec (and immediately on the first frame).
  if (now - lastPoll >= 1000) {
    lastPoll = now;
    const seen = new Set<string>();
    pollTcp(now);
    pollUdp(now);
    for (const k of liveConns.keys()) seen.add(k);
    ageOut(now, seen);
    // Count by proto for the HUD.
    lastTcpN = 0;
    lastUdpN = 0;
    for (const c of liveConns.values()) (c.state === -1 ? (lastUdpN += 1) : (lastTcpN += 1));
  }

  // Resolve names (instant getnameinfo every frame; one throttled blocking
  // gethostbyaddr per DNS_FALLBACK_MS). Stop the blocking fallback once we are
  // within 1.5s of a timed run's capture deadline so a slow PTR can never push
  // the gallery screenshot past its scheduled frame.
  if (durationMs > 0 && now - start >= durationMs - 1500) slowResolvePaused = true;
  pumpDns(now, time < 1.2 ? 8 : 3);

  // Radar sweep angle (one full revolution every ~3.2 s).
  const sweep = (time * (Math.PI * 2)) / 3.2;
  const aspect = clientW / clientH;
  const scopeR = 0.94;

  // ── Build the blip buffer for this frame ──────────────────────────────────────
  // Also collect a candidate label per UNIQUE remote host (we callout the most
  // significant N — preferring named, established, beam-lit connections).
  let count = 0;
  let resolvedCount = 0;
  // aspect-space (x,y) → back-buffer pixel coords (matches the PS's mapping).
  const toScreenX = (bx: number): number => (bx / aspect * 0.5 + 0.5) * clientW;
  const toScreenY = (by: number): number => (by * 0.5 + 0.5) * clientH;
  interface Cand extends LabelTarget {
    blipIndex: number;
  }
  const candByHost = new Map<number, Cand>();
  for (const conn of liveConns.values()) {
    if (count >= MAX_BLIPS) break;
    const bearing = bearingForAddr(conn.remoteAddr) + jitterForPort(conn.remoteAddr, conn.remotePort);
    const radNorm = radiusForAddrPort(conn.remoteAddr, conn.remotePort) * scopeR;
    // Aspect-corrected polar → the same -1..1 aspect space the PS uses.
    const x = Math.cos(bearing) * radNorm;
    const y = Math.sin(bearing) * radNorm;

    // How aligned the sweep beam is with this blip (for the per-blip flare).
    let dAng = sweep % (Math.PI * 2) - bearing;
    dAng = Math.atan2(Math.sin(dAng), Math.cos(dAng));
    const beam = Math.exp(-Math.abs(dAng) * 6.0);

    // New-connection pulse (0 → 1 over the first second of life).
    const age = (now - conn.bornAt) / 1000;
    const pulse = age < 1.0 ? age : 0.0;

    const o = count * BLIP_STRIDE;
    blipData.writeFloatLE(x, o);
    blipData.writeFloatLE(y, o + 4);
    blipData.writeUInt32LE(conn.kind >>> 0, o + 8);
    blipData.writeFloatLE(pulse, o + 12);
    blipData.writeFloatLE(beam, o + 16);
    blipData.writeFloatLE(0, o + 20); // callout flag — set later for labeled hosts
    blipData.writeFloatLE(0, o + 24);
    blipData.writeFloatLE(0, o + 28);

    const dns = dnsCache.get(conn.remoteAddr);
    if (dns?.host) resolvedCount += 1;

    // One label candidate per remote host (keep the most significant socket to it).
    const named = dns?.host ? 1 : 0;
    const stateBonus = conn.kind === KIND_ESTABLISHED ? 3 : conn.kind === KIND_SYN ? 2 : conn.kind === KIND_UDP ? 1 : 0;
    const significance = named * 100 + stateBonus * 10 + beam * 5 + radNorm;
    const prev = candByHost.get(conn.remoteAddr);
    if (!prev || significance > prev.significance) {
      candByHost.set(conn.remoteAddr, {
        blipIndex: count,
        sx: Math.round(toScreenX(x)),
        sy: Math.round(toScreenY(y)),
        name: dns?.host ?? ipFromU32(conn.remoteAddr),
        port: conn.remotePort,
        kind: conn.kind,
        significance,
      });
    }

    count += 1;
  }

  // Pick the top label candidates and flag their blips for a callout ring.
  const labelTargets = [...candByHost.values()].sort((a, b) => b.significance - a.significance).slice(0, 10);
  for (const t of labelTargets) {
    blipData.writeFloatLE(1, t.blipIndex * BLIP_STRIDE + 20); // callout = 1.0
  }
  updateDynamicBuffer(blipBuf.buffer, blipData);

  // Bake the overlay (title / legend / hostname labels + leaders) into a texture.
  drawOverlay(labelTargets, lastTcpN, lastUdpN, resolvedCount, fps);

  // ── Constant buffer (built immediately before the draw that consumes it) ──────
  cbData.writeFloatLE(time, 0);
  cbData.writeFloatLE(sweep % (Math.PI * 2), 4);
  cbData.writeUInt32LE(count >>> 0, 8);
  cbData.writeFloatLE(aspect, 12);
  cbData.writeFloatLE(clientW, 16);
  cbData.writeFloatLE(clientH, 20);
  cbData.writeFloatLE(scopeR, 24);
  cbData.writeFloatLE(0, 28);
  updateConstantBuffer(cb, cbData);

  // ── Render ────────────────────────────────────────────────────────────────────
  setRenderTargets([gpu.backBufferRTV]);
  setViewport(clientW, clientH);
  clear(gpu.backBufferRTV, [0, 0, 0, 1]);
  // The whole scope (rings, sweep, blips with accumulating glow) plus the baked
  // label overlay (t1) is composited inside the single fullscreen PS, so the blits
  // write opaque — no blend needed. t0 = blip buffer, t1 = GDI label texture.
  vsSet(vs);
  psSet(ps, { cb: [cb], srv: [blipBuf.srv!, ovrTex.srv!], samp: [ovrSampler] });
  drawFullscreenTriangle();
  // Unbind both SRVs so the structured buffer can be Map-discarded next frame.
  vcall(gpu.context, 8 /* PSSetShaderResources */, [FFIType.u32, FFIType.u32, FFIType.ptr], [0, 2, nullSrv.ptr!], FFIType.void);
  setRenderTargets([]);

  // One-time console dump of the parsed connection table (after PTR lookups settle).
  if (!consolePrinted && now - start > 3200 && liveConns.size > 0) {
    consolePrinted = true;
    console.log('\n  Parsed connections (remote, state, pid, resolved host):');
    console.log(`  ${'Remote'.padEnd(22)} ${'State'.padEnd(12)} ${'PID'.padEnd(7)} Host`);
    let shown = 0;
    for (const conn of liveConns.values()) {
      if (shown >= 18) break;
      const dns = dnsCache.get(conn.remoteAddr);
      const host = dns?.host ?? (dns?.done ? '(no PTR record)' : '(resolving...)');
      const proto = conn.state === -1 ? 'UDP' : tcpStateNames.get(conn.state) ?? '?';
      const remote = `${ipFromU32(conn.remoteAddr)}:${conn.remotePort}`;
      console.log(`  ${remote.padEnd(22)} ${proto.padEnd(12)} ${String(conn.pid).padEnd(7)} ${host}`);
      shown += 1;
    }
  }

  // ── Gallery capture on the last frame of a timed run ──────────────────────────
  const willBreak = durationMs > 0 && now - start >= durationMs;
  if (willBreak && !capturedThisRun) {
    capturedThisRun = true;
    const shotDir = resolve(import.meta.dir, '..', 'screenshots');
    mkdirSync(shotDir, { recursive: true });
    const stats = captureBackBuffer(gpu, resolve(shotDir, 'net-radar.png'), { gridW: 48, gridH: 22 });
    console.log(formatGrid(stats));
    console.log(`[shot] ok=${stats.ok} nonBlack=${stats.nonBlackFrac.toFixed(3)} meanLuma=${stats.meanLuma.toFixed(3)} -> ${stats.path}`);
  }

  gpu.present(false);
  drawHud(fps, lastTcpN, lastUdpN, resolvedCount);

  frame += 1;
  fpsFrames += 1;
  if (now - fpsWindow >= 500) {
    fps = Math.round((fpsFrames * 1000) / (now - fpsWindow));
    fpsFrames = 0;
    fpsWindow = now;
  }

  if (willBreak) break;
}

// ── Cross-check one of our getnameinfo() PTR results against the OS resolver ────
// Proves the reverse-DNS path returns the same name Windows' own resolver does.
let crossAddr = 0;
let crossHost = '';
for (const [addr, entry] of dnsCache) {
  if (entry.host) {
    crossAddr = addr;
    crossHost = entry.host;
    break;
  }
}
if (crossAddr !== 0) {
  const ip = ipFromU32(crossAddr);
  try {
    const proc = Bun.spawnSync(['powershell', '-NoProfile', '-Command', `(Resolve-DnsName -Type PTR -Name ${ip} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty NameHost)`]);
    const osName = proc.stdout.toString().trim();
    console.log('\n  Reverse-DNS cross-check:');
    console.log(`    ${ip}  →  getnameinfo(): ${crossHost}`);
    console.log(`    ${ip}  →  Resolve-DnsName: ${osName || '(no answer)'}`);
    console.log(`    match: ${osName.toLowerCase() === crossHost.toLowerCase() ? 'YES' : osName ? 'different (DNS round-robin / multi-PTR)' : 'OS resolver returned nothing'}`);
  } catch {
    console.log(`\n  Reverse-DNS cross-check skipped (Resolve-DnsName unavailable). getnameinfo gave ${ip} → ${crossHost}`);
  }
} else {
  console.log('\n  Reverse-DNS: no PTR records resolved for the current remotes (common for cloud/CDN IPs).');
}

console.log(`\n  ran ${frame} frames over ${((performance.now() - start) / 1000).toFixed(2)}s (${fps} fps) · ${liveConns.size} sockets · ${gpu.gpuName}`);
cleanup(0);
