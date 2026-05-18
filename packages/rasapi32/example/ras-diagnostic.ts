/**
 * RAS Subsystem Diagnostic
 *
 * A complete Remote Access Service report: every RAS-capable device (modems,
 * VPN/WAN miniports), every phone-book entry, every active dial-up/VPN
 * connection with live status and byte/frame statistics, and an exhaustive,
 * auto-generated RAS error-code reference table. All buffers are sized with
 * the classic two-call NULL-buffer pattern and parsed straight out of the
 * native RASDEVINFOW / RASENTRYNAMEW / RASCONNW / RASCONNSTATUSW / RAS_STATS
 * structures. Output is fully formatted with aligned columns and ANSI color.
 *
 * APIs demonstrated (Rasapi32):
 *   - RasEnumDevicesW             (RAS-capable devices: type + name)
 *   - RasEnumEntriesW             (phone-book entries: name, scope, path)
 *   - RasEnumConnectionsW         (active dial-up/VPN connections)
 *   - RasGetConnectStatusW        (per-connection state + device)
 *   - RasGetConnectionStatistics  (bytes/frames/bps/duration counters)
 *   - RasGetErrorStringW          (full RAS error-code reference table)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle                (acquire console output handle)
 *   - GetConsoleMode              (read current console mode)
 *   - SetConsoleMode              (enable ANSI/VT escape processing)
 *
 * Run: bun run example/ras-diagnostic.ts
 */

import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

import Rasapi32 from '../index';

Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);
Rasapi32.Preload(['RasEnumDevicesW', 'RasEnumEntriesW', 'RasEnumConnectionsW', 'RasGetConnectStatusW', 'RasGetConnectionStatistics', 'RasGetErrorStringW']);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const RED = '\x1b[91m';
const GRAY = '\x1b[90m';

// Sizes of the WINVER-current RAS structures on x64 (see ras.h).
const SIZEOF_RASDEVINFOW = 296; // dwSize + WCHAR[17] + WCHAR[129]
const SIZEOF_RASENTRYNAMEW = 1048; // dwSize + WCHAR[257] + dwFlags + WCHAR[261]
const SIZEOF_RASCONNW = 1392; // through guidCorrelationId (WINVER >= 0x600)
const SIZEOF_RASCONNSTATUSW = 608; // through rasconnsubstate (WINVER >= 0x601)
const SIZEOF_RAS_STATS = 60; // 15 x DWORD

const ERROR_SUCCESS = 0;
const ERROR_BUFFER_TOO_SMALL = 603;

// RASCONNSTATE values that matter for a human-readable summary (ras.h).
const connStateNames = new Map<number, string>([
  [0x2000, 'Connected'], // RASCS_Connected = RASCS_DONE
  [0x2001, 'Disconnected'], // RASCS_Disconnected
  [0x1000, 'Interactive'], // RASCS_Interactive = RASCS_PAUSED
  [0, 'OpenPort'],
  [5, 'Authenticate'],
  [10, 'AuthProject'],
  [14, 'Authenticated'],
]);

function enableAnsi(): void {
  const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
  const modeBuf = Buffer.alloc(4);
  if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr!)) {
    Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  }
}

/** Read a NUL-terminated UTF-16LE string of at most `chars` code units. */
function wstr(buf: Buffer, byteOffset: number, chars: number): string {
  return buf.toString('utf16le', byteOffset, byteOffset + chars * 2).replace(/\0.*$/, '');
}

function rule(title: string): void {
  console.log(`\n${BOLD}${CYAN}── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}${RESET}`);
}

function rasError(code: number): string {
  const buf = Buffer.alloc(1024);
  // RasGetErrorStringW returns ERROR_SUCCESS and fills a wide string for
  // any code in the RAS range; non-RAS codes return a non-zero error.
  return Rasapi32.RasGetErrorStringW(code, buf.ptr!, 512) === ERROR_SUCCESS ? wstr(buf, 0, 512) : `Win32 error ${code}`;
}

enableAnsi();

console.log(`${BOLD}RAS Subsystem Diagnostic${RESET}`);
console.log(`${GRAY}${new Date().toISOString()} — rasapi32.dll via Bun FFI${RESET}`);

// ── RAS-capable devices ────────────────────────────────────────────────────
rule('RAS-Capable Devices');
{
  const cb = Buffer.alloc(4);
  const count = Buffer.alloc(4);
  // First pass: NULL buffer → required byte count comes back in `cb`.
  let status = Rasapi32.RasEnumDevicesW(null, cb.ptr!, count.ptr!);
  if (status === ERROR_BUFFER_TOO_SMALL && cb.readUInt32LE(0) > 0) {
    const devices = Buffer.alloc(cb.readUInt32LE(0));
    devices.writeUInt32LE(SIZEOF_RASDEVINFOW, 0); // RASDEVINFOW[0].dwSize
    status = Rasapi32.RasEnumDevicesW(devices.ptr!, cb.ptr!, count.ptr!);
    const n = count.readUInt32LE(0);
    if (status === ERROR_SUCCESS) {
      console.log(`${DIM}${'#'.padEnd(4)}${'Device Type'.padEnd(20)}Device Name${RESET}`);
      for (let i = 0; i < n; i++) {
        const base = i * SIZEOF_RASDEVINFOW;
        const type = wstr(devices, base + 4, 17);
        const name = wstr(devices, base + 4 + 17 * 2, 129);
        console.log(`${GRAY}${String(i + 1).padEnd(4)}${RESET}${YELLOW}${type.padEnd(20)}${RESET}${name}`);
      }
      console.log(`${DIM}${n} device(s).${RESET}`);
    } else {
      console.log(`${RED}RasEnumDevicesW failed: ${rasError(status)}${RESET}`);
    }
  } else {
    console.log(`${DIM}No RAS-capable devices reported.${RESET}`);
  }
}

// ── Phone-book entries ─────────────────────────────────────────────────────
rule('Phone-book Entries');
{
  const cb = Buffer.alloc(4);
  const count = Buffer.alloc(4);
  let status = Rasapi32.RasEnumEntriesW(null, null, null, cb.ptr!, count.ptr!);
  const needed = cb.readUInt32LE(0);
  if (status === ERROR_BUFFER_TOO_SMALL && needed > 0) {
    const entries = Buffer.alloc(needed);
    entries.writeUInt32LE(SIZEOF_RASENTRYNAMEW, 0); // RASENTRYNAMEW[0].dwSize
    status = Rasapi32.RasEnumEntriesW(null, null, entries.ptr!, cb.ptr!, count.ptr!);
    const n = count.readUInt32LE(0);
    if (status === ERROR_SUCCESS && n > 0) {
      for (let i = 0; i < n; i++) {
        const base = i * SIZEOF_RASENTRYNAMEW;
        const name = wstr(entries, base + 4, 257);
        const flags = entries.readUInt32LE(base + 520);
        const path = wstr(entries, base + 524, 261);
        const scope = flags & 0x1 ? `${YELLOW}All Users${RESET}` : `${GREEN}Current User${RESET}`;
        console.log(`  ${BOLD}${name}${RESET}  (${scope}${GRAY})`);
        console.log(`    ${GRAY}${path}${RESET}`);
      }
      console.log(`${DIM}${n} entr${n === 1 ? 'y' : 'ies'}.${RESET}`);
    } else {
      console.log(`${DIM}No phone-book entries configured.${RESET}`);
    }
  } else {
    console.log(`${DIM}No phone-book entries configured.${RESET}`);
  }
}

// ── Active connections ─────────────────────────────────────────────────────
rule('Active Connections');
{
  const cb = Buffer.alloc(4);
  const count = Buffer.alloc(4);
  let status = Rasapi32.RasEnumConnectionsW(null, cb.ptr!, count.ptr!);
  const needed = cb.readUInt32LE(0);
  if (status === ERROR_BUFFER_TOO_SMALL && needed > 0) {
    const conns = Buffer.alloc(needed);
    conns.writeUInt32LE(SIZEOF_RASCONNW, 0); // RASCONNW[0].dwSize
    status = Rasapi32.RasEnumConnectionsW(conns.ptr!, cb.ptr!, count.ptr!);
    const n = status === ERROR_SUCCESS ? count.readUInt32LE(0) : 0;

    if (n === 0) {
      console.log(`${DIM}No active dial-up or VPN connections.${RESET}`);
    }

    for (let i = 0; i < n; i++) {
      const base = i * SIZEOF_RASCONNW;
      // RASCONNW: dwSize@0, hrasconn@8 (8-byte aligned handle), szEntryName@16
      const hrasconn = conns.readBigUInt64LE(base + 8);
      const entryName = wstr(conns, base + 16, 257);
      const deviceName = wstr(conns, base + 16 + 257 * 2 + 17 * 2, 129);
      console.log(`  ${BOLD}${GREEN}${entryName}${RESET} ${GRAY}via ${deviceName}${RESET}`);

      const stBuf = Buffer.alloc(SIZEOF_RASCONNSTATUSW);
      stBuf.writeUInt32LE(SIZEOF_RASCONNSTATUSW, 0); // RASCONNSTATUSW.dwSize
      if (Rasapi32.RasGetConnectStatusW(hrasconn, stBuf.ptr!) === ERROR_SUCCESS) {
        const state = stBuf.readUInt32LE(4);
        const err = stBuf.readUInt32LE(8);
        const label = connStateNames.get(state) ?? `0x${state.toString(16)}`;
        console.log(`    State: ${CYAN}${label}${RESET}${err ? `  ${RED}(${rasError(err)})${RESET}` : ''}`);
      }

      const stats = Buffer.alloc(SIZEOF_RAS_STATS);
      stats.writeUInt32LE(SIZEOF_RAS_STATS, 0); // RAS_STATS.dwSize
      if (Rasapi32.RasGetConnectionStatistics(hrasconn, stats.ptr!) === ERROR_SUCCESS) {
        const tx = stats.readUInt32LE(4);
        const rx = stats.readUInt32LE(8);
        const bps = stats.readUInt32LE(52);
        const secs = Math.floor(stats.readUInt32LE(56) / 1000);
        console.log(`    ${GRAY}TX ${tx.toLocaleString()} B · RX ${rx.toLocaleString()} B · ${bps.toLocaleString()} bps · up ${secs}s${RESET}`);
      }
    }
  } else {
    console.log(`${DIM}No active dial-up or VPN connections.${RESET}`);
  }
}

// ── RAS error reference ────────────────────────────────────────────────────
rule('RAS Error Reference (RASBASE 600+)');
{
  let shown = 0;
  for (let code = 600; code <= 760; code++) {
    const buf = Buffer.alloc(1024);
    if (Rasapi32.RasGetErrorStringW(code, buf.ptr!, 512) !== ERROR_SUCCESS) continue;
    const text = wstr(buf, 0, 512).trim();
    if (!text) continue;
    console.log(`  ${YELLOW}${String(code).padEnd(5)}${RESET}${GRAY}${text}${RESET}`);
    shown++;
  }
  console.log(`${DIM}${shown} documented RAS error code(s).${RESET}`);
}

console.log(`\n${BOLD}${GREEN}✓ RAS diagnostic complete.${RESET}`);
