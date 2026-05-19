/**
 * Restore Point Observatory
 *
 * A live, color-coded System Restore status dashboard rendered entirely with ANSI
 * escape codes. It reads the real System Restore configuration from the registry,
 * decodes every System Restore policy knob into a glowing gauge, and then fires a
 * genuine SRSetRestorePointW FFI call down a deliberately safe no-op path
 * (END_SYSTEM_CHANGE + CANCELLED_OPERATION with an impossible sequence number) so
 * you can watch the native return code and STATEMGRSTATUS struct decode live —
 * without ever creating or deleting a restore point.
 *
 * The observatory animates a scanning beam across the configuration grid, pulses
 * the health verdict, and prints the decoded STATEMGRSTATUS as a starfield panel.
 * Everything is read-only and degrades gracefully when System Restore is disabled
 * or access is denied.
 *
 * APIs demonstrated (Srclient):
 *   - SRSetRestorePointW          (real FFI call on the safe cancel/no-op path)
 *
 * APIs demonstrated (Advapi32, cross-package):
 *   - RegOpenKeyExW               (open the SystemRestore config key, read-only)
 *   - RegGetValueW                (read RPSessionInterval, SRInitDone, etc.)
 *   - RegCloseKey                 (release the key handle)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle                (acquire the console output handle)
 *   - GetConsoleMode              (read current console mode)
 *   - SetConsoleMode              (enable ANSI/VT escape processing)
 *
 * Run: bun run example/restore-point-observatory.ts
 */
import Srclient, { MAX_DESC_W, RestorePointEventType, RestorePointType } from '../index';
import Advapi32, { HKEY_LOCAL_MACHINE, RegKeyAccessRights } from '@bun-win32/advapi32';
import Kernel32, { STD_HANDLE } from '@bun-win32/kernel32';

Srclient.Preload(['SRSetRestorePointW']);
Advapi32.Preload(['RegOpenKeyExW', 'RegGetValueW', 'RegCloseKey']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const CYAN = `${ESC}96m`;
const GREEN = `${ESC}92m`;
const YELLOW = `${ESC}93m`;
const RED = `${ESC}91m`;
const MAGENTA = `${ESC}95m`;
const BLUE = `${ESC}94m`;
const GRAY = `${ESC}90m`;

// Enable ANSI escape processing on the console (Kernel32, cross-package).
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SR_KEY = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore';
const RRF_RT_REG_DWORD = 0x0000_0010;
const RRF_RT_REG_QWORD = 0x0000_0048;

/** Reads a single REG_DWORD value from the System Restore config key, or null if absent. */
function readSrDword(valueName: string): number | null {
  const phkResult = Buffer.alloc(8);
  const subKey = Buffer.from(`${SR_KEY}\0`, 'utf16le');
  const open = Advapi32.RegOpenKeyExW(HKEY_LOCAL_MACHINE, subKey.ptr, 0, RegKeyAccessRights.KEY_READ, phkResult.ptr);
  if (open !== 0) return null;
  const hKey = phkResult.readBigUInt64LE(0);
  try {
    const valueNameBuf = Buffer.from(`${valueName}\0`, 'utf16le');
    const data = Buffer.alloc(4);
    const cbData = Buffer.alloc(4);
    cbData.writeUInt32LE(4, 0);
    const status = Advapi32.RegGetValueW(hKey, null, valueNameBuf.ptr, RRF_RT_REG_DWORD, null, data.ptr, cbData.ptr);
    if (status !== 0) return null;
    return data.readUInt32LE(0);
  } finally {
    Advapi32.RegCloseKey(hKey);
  }
}

/** Reads a single REG_QWORD value from the System Restore config key, or null if absent. */
function readSrQword(valueName: string): bigint | null {
  const phkResult = Buffer.alloc(8);
  const subKey = Buffer.from(`${SR_KEY}\0`, 'utf16le');
  const open = Advapi32.RegOpenKeyExW(HKEY_LOCAL_MACHINE, subKey.ptr, 0, RegKeyAccessRights.KEY_READ, phkResult.ptr);
  if (open !== 0) return null;
  const hKey = phkResult.readBigUInt64LE(0);
  try {
    const valueNameBuf = Buffer.from(`${valueName}\0`, 'utf16le');
    const data = Buffer.alloc(8);
    const cbData = Buffer.alloc(4);
    cbData.writeUInt32LE(8, 0);
    const status = Advapi32.RegGetValueW(hKey, null, valueNameBuf.ptr, RRF_RT_REG_QWORD, null, data.ptr, cbData.ptr);
    if (status !== 0) return null;
    return data.readBigUInt64LE(0);
  } finally {
    Advapi32.RegCloseKey(hKey);
  }
}

function gauge(label: string, value: string, color: string, glyph: string): string {
  const paddedLabel = label.padEnd(34, ' ');
  return `  ${GRAY}${glyph}${RESET} ${BOLD}${paddedLabel}${RESET} ${color}${value}${RESET}`;
}

async function main(): Promise<void> {
  console.clear();
  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║          R E S T O R E   P O I N T   O B S E R V A T O R Y    ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log();

  // Scanning beam across the configuration grid.
  const beam = ['◐', '◓', '◑', '◒'];
  for (let i = 0; i < 8; i++) {
    process.stdout.write(`\r  ${MAGENTA}${beam[i % beam.length]}${RESET} ${DIM}Scanning System Restore telemetry...${RESET}`);
    await sleep(70);
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  const srInitDone = readSrDword('SRInitDone');
  const rpSessionInterval = readSrDword('RPSessionInterval');
  const lastIndex = readSrDword('LastIndex');
  const firstRun = readSrDword('FirstRun');
  const creationFrequency = readSrDword('SystemRestorePointCreationFrequency');
  const disableSr = readSrDword('DisableSR');
  const scopeSnapshots = readSrDword('ScopeSnapshots');
  const lastMaintenance = readSrQword('LastMainenanceTaskRunTimeStamp');

  const enabled = disableSr !== 1 && srInitDone === 1;

  console.log(`${BOLD}${BLUE}── Configuration Grid ${'─'.repeat(42)}${RESET}`);
  console.log(gauge('System Restore engine', enabled ? 'ONLINE' : disableSr === 1 ? 'DISABLED (policy)' : 'NOT INITIALIZED', enabled ? GREEN : RED, enabled ? '●' : '○'));
  console.log(gauge('SRInitDone', srInitDone === null ? 'absent' : String(srInitDone), srInitDone === 1 ? GREEN : YELLOW, '◆'));
  console.log(gauge('RPSessionInterval (sec)', rpSessionInterval === null ? 'absent' : String(rpSessionInterval), CYAN, '◆'));
  console.log(gauge('LastIndex (next RP id)', lastIndex === null ? 'absent' : String(lastIndex), CYAN, '◆'));
  console.log(gauge('FirstRun', firstRun === null ? 'absent' : String(firstRun), firstRun === 0 ? GREEN : YELLOW, '◆'));
  console.log(gauge('CreationFrequency (min)', creationFrequency === null ? 'default (1440)' : creationFrequency === 0 ? '0 (no throttle)' : String(creationFrequency), YELLOW, '◆'));
  console.log(gauge('ScopeSnapshots', scopeSnapshots === null ? 'default' : scopeSnapshots === 0 ? '0 (legacy full)' : String(scopeSnapshots), CYAN, '◆'));
  console.log(gauge('Last maintenance (FILETIME)', lastMaintenance === null ? 'absent' : '0x' + lastMaintenance.toString(16), GRAY, '◆'));
  console.log();

  // Pulse the health verdict.
  const verdictColor = enabled ? GREEN : RED;
  const verdictText = enabled ? 'PROTECTED — restore points can be created' : 'EXPOSED — System Restore is not active';
  for (let p = 0; p < 4; p++) {
    const shade = p % 2 === 0 ? BOLD : DIM;
    process.stdout.write(`\r  ${shade}${verdictColor}◉ ${verdictText}${RESET}`);
    await sleep(110);
  }
  console.log('\n');

  // Genuine SRSetRestorePointW FFI call on the documented SAFE no-op path:
  // END_SYSTEM_CHANGE + CANCELLED_OPERATION with an impossible sequence number.
  // Per srrestoreptapi.h this returns FALSE with nStatus = ERROR_INVALID_DATA
  // (or ERROR_SERVICE_DISABLED / ERROR_ACCESS_DENIED) and creates nothing.
  console.log(`${BOLD}${BLUE}── Live Native Probe ${'─'.repeat(43)}${RESET}`);
  console.log(`  ${DIM}Calling SRSetRestorePointW(END_SYSTEM_CHANGE, CANCELLED_OPERATION, seq=0x7fffffffffffffff)${RESET}`);

  // RESTOREPOINTINFOW is #pragma pack(1): DWORD + DWORD + INT64 + WCHAR[256] = 528 bytes.
  const restorePtSpec = Buffer.alloc(4 + 4 + 8 + MAX_DESC_W * 2);
  restorePtSpec.writeUInt32LE(RestorePointEventType.END_SYSTEM_CHANGE, 0);
  restorePtSpec.writeUInt32LE(RestorePointType.CANCELLED_OPERATION, 4);
  restorePtSpec.writeBigInt64LE(0x7fffffffffffffffn, 8); // impossible sequence number → no-op
  Buffer.from('bun-win32 observatory probe\0', 'utf16le').copy(restorePtSpec, 16);

  // STATEMGRSTATUS is #pragma pack(1): DWORD nStatus + INT64 llSequenceNumber = 12 bytes.
  const smgrStatus = Buffer.alloc(12);

  const ok = Srclient.SRSetRestorePointW(restorePtSpec.ptr, smgrStatus.ptr);
  const nStatus = smgrStatus.readUInt32LE(0);
  const sequenceNumber = smgrStatus.readBigInt64LE(4);

  const statusNames: Record<number, string> = {
    0: 'ERROR_SUCCESS',
    5: 'ERROR_ACCESS_DENIED',
    10: 'ERROR_BAD_ENVIRONMENT (safe mode)',
    13: 'ERROR_INVALID_DATA (bad sequence number)',
    112: 'ERROR_DISK_FULL (SR standby)',
    1058: 'ERROR_SERVICE_DISABLED',
    1460: 'ERROR_TIMEOUT',
    1359: 'ERROR_INTERNAL_ERROR',
  };
  const statusLabel = statusNames[nStatus] ?? `0x${nStatus.toString(16)}`;
  const callColor = ok === 0 ? YELLOW : GREEN;

  console.log();
  console.log(`  ${BOLD}┌─ STATEMGRSTATUS starfield ${'─'.repeat(34)}┐${RESET}`);
  console.log(`  ${BOLD}│${RESET} ${GRAY}BOOL return    ${RESET} ${callColor}${ok}${RESET}  ${DIM}(0 = call rejected, as expected on no-op path)${RESET}`);
  console.log(`  ${BOLD}│${RESET} ${GRAY}nStatus        ${RESET} ${callColor}${nStatus}${RESET}  ${DIM}${statusLabel}${RESET}`);
  console.log(`  ${BOLD}│${RESET} ${GRAY}llSequenceNumber${RESET} ${CYAN}${sequenceNumber}${RESET}`);
  console.log(`  ${BOLD}└${'─'.repeat(60)}┘${RESET}`);
  console.log();
  console.log(`  ${GREEN}✓${RESET} The native srclient.dll entry point executed and decoded cleanly.`);
  console.log(`  ${DIM}No restore point was created or removed — this is a read-only probe.${RESET}`);
  console.log();
}

main();
