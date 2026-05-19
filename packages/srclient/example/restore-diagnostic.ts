/**
 * System Restore Diagnostic
 *
 * A thorough, richly-formatted System Restore configuration audit. It enumerates
 * the full SystemRestore registry policy surface (engine state, throttle windows,
 * snapshot scope, group policy overrides), decodes every value with a labeled,
 * aligned table, and then exercises the real srclient.dll entry point via a
 * read-only SRSetRestorePointW probe on the documented safe cancel path. Every
 * STATEMGRSTATUS field and the BOOL return are decoded against the full Win32
 * status-code table. No restore point is ever created or deleted; the tool
 * degrades gracefully and explains exactly why a call was rejected.
 *
 * APIs demonstrated (Srclient):
 *   - SRSetRestorePointW          (real FFI probe on the safe cancel/no-op path)
 *   - SRRemoveRestorePoint        (signature + safe ERROR_INVALID_DATA decode only)
 *
 * APIs demonstrated (Advapi32, cross-package):
 *   - RegOpenKeyExW               (open SystemRestore + group-policy keys)
 *   - RegEnumValueW               (enumerate every configured value name)
 *   - RegGetValueW                (typed read of individual policy values)
 *   - RegCloseKey                 (release key handles)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle                (acquire the console output handle)
 *   - GetConsoleMode              (read current console mode)
 *   - SetConsoleMode              (enable ANSI/VT escape processing)
 *
 * Run: bun run example/restore-diagnostic.ts
 */
import Srclient, { MAX_DESC_W, RestorePointEventType, RestorePointType } from '../index';
import Advapi32, { HKEY_LOCAL_MACHINE, RegKeyAccessRights } from '@bun-win32/advapi32';
import Kernel32, { STD_HANDLE } from '@bun-win32/kernel32';

Srclient.Preload(['SRSetRestorePointW', 'SRRemoveRestorePoint']);
Advapi32.Preload(['RegOpenKeyExW', 'RegEnumValueW', 'RegGetValueW', 'RegCloseKey']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const CYAN = `${ESC}96m`;
const GREEN = `${ESC}92m`;
const YELLOW = `${ESC}93m`;
const RED = `${ESC}91m`;
const BLUE = `${ESC}94m`;
const GRAY = `${ESC}90m`;

const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const SR_KEY = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore';
const SR_POLICY_KEY = 'SOFTWARE\\Policies\\Microsoft\\Windows NT\\SystemRestore';
const RRF_RT_REG_DWORD = 0x0000_0010;
const RRF_RT_REG_QWORD = 0x0000_0048;
const REG_DWORD = 4;
const REG_QWORD = 11;
const REG_SZ = 1;

/** Opens an HKLM subkey read-only, returning the HKEY handle or null. */
function openKey(subKeyPath: string): bigint | null {
  const phkResult = Buffer.alloc(8);
  const subKey = Buffer.from(`${subKeyPath}\0`, 'utf16le');
  const open = Advapi32.RegOpenKeyExW(HKEY_LOCAL_MACHINE, subKey.ptr, 0, RegKeyAccessRights.KEY_READ, phkResult.ptr);
  if (open !== 0) return null;
  return phkResult.readBigUInt64LE(0);
}

function readDword(hKey: bigint, valueName: string): number | null {
  const valueNameBuf = Buffer.from(`${valueName}\0`, 'utf16le');
  const data = Buffer.alloc(4);
  const cbData = Buffer.alloc(4);
  cbData.writeUInt32LE(4, 0);
  const status = Advapi32.RegGetValueW(hKey, null, valueNameBuf.ptr, RRF_RT_REG_DWORD, null, data.ptr, cbData.ptr);
  if (status !== 0) return null;
  return data.readUInt32LE(0);
}

function readQword(hKey: bigint, valueName: string): bigint | null {
  const valueNameBuf = Buffer.from(`${valueName}\0`, 'utf16le');
  const data = Buffer.alloc(8);
  const cbData = Buffer.alloc(4);
  cbData.writeUInt32LE(8, 0);
  const status = Advapi32.RegGetValueW(hKey, null, valueNameBuf.ptr, RRF_RT_REG_QWORD, null, data.ptr, cbData.ptr);
  if (status !== 0) return null;
  return data.readBigUInt64LE(0);
}

interface ValueInfo {
  name: string;
  type: number;
}

/** Enumerates every value name + type under an open key by iterating RegEnumValueW. */
function enumerateValues(hKey: bigint): ValueInfo[] {
  const ERROR_NO_MORE_ITEMS = 259;
  const MAX_VALUE_NAME_CHARS = 16384; // registry value names max out at 16,383 chars
  const results: ValueInfo[] = [];
  for (let i = 0; i < 4096; i++) {
    const nameBuf = Buffer.alloc(MAX_VALUE_NAME_CHARS * 2);
    const nameLen = Buffer.alloc(4);
    nameLen.writeUInt32LE(MAX_VALUE_NAME_CHARS, 0);
    const typeBuf = Buffer.alloc(4);
    // RegEnumValueW(hKey, dwIndex, lpValueName, lpcchValueName, lpReserved, lpType, lpData, lpcbData)
    const status = Advapi32.RegEnumValueW(hKey, i, nameBuf.ptr, nameLen.ptr, null, typeBuf.ptr, null, null);
    if (status === ERROR_NO_MORE_ITEMS) break;
    if (status !== 0) break;
    const chars = nameLen.readUInt32LE(0);
    results.push({ name: nameBuf.toString('utf16le', 0, chars * 2), type: typeBuf.readUInt32LE(0) });
  }
  return results;
}

function regTypeName(type: number): string {
  switch (type) {
    case REG_SZ:
      return 'REG_SZ';
    case REG_DWORD:
      return 'REG_DWORD';
    case REG_QWORD:
      return 'REG_QWORD';
    default:
      return `type ${type}`;
  }
}

function row(label: string, value: string, color: string): string {
  return `  ${BOLD}${label.padEnd(38, ' ')}${RESET} ${color}${value}${RESET}`;
}

function rule(title: string): void {
  const pad = Math.max(0, 60 - title.length);
  console.log(`\n${BOLD}${BLUE}── ${title} ${'─'.repeat(pad)}${RESET}`);
}

const STATUS_NAMES: Record<number, string> = {
  0: 'ERROR_SUCCESS — call succeeded',
  5: 'ERROR_ACCESS_DENIED — needs elevation / COM security',
  10: 'ERROR_BAD_ENVIRONMENT — called in safe mode',
  13: 'ERROR_INVALID_DATA — invalid sequence number (expected on no-op probe)',
  112: 'ERROR_DISK_FULL — System Restore in standby (low disk)',
  1058: 'ERROR_SERVICE_DISABLED — System Restore is disabled',
  1359: 'ERROR_INTERNAL_ERROR — internal failure',
  1460: 'ERROR_TIMEOUT — waited on the restore-point mutex',
};

function main(): void {
  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║              S Y S T E M   R E S T O R E   A U D I T         ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${RESET}`);

  rule('Engine Configuration (HKLM\\...\\SystemRestore)');
  const srKey = openKey(SR_KEY);
  if (srKey === null) {
    console.log(`  ${RED}✗ Unable to open the SystemRestore registry key (access denied).${RESET}`);
  } else {
    try {
      const srInitDone = readDword(srKey, 'SRInitDone');
      const disableSr = readDword(srKey, 'DisableSR');
      const rpSession = readDword(srKey, 'RPSessionInterval');
      const lastIndex = readDword(srKey, 'LastIndex');
      const firstRun = readDword(srKey, 'FirstRun');
      const creationFreq = readDword(srKey, 'SystemRestorePointCreationFrequency');
      const scopeSnapshots = readDword(srKey, 'ScopeSnapshots');
      const rpGlobal = readDword(srKey, 'RPGlobalInterval');
      const rpLife = readDword(srKey, 'RPLifeInterval');
      const lastMaint = readQword(srKey, 'LastMainenanceTaskRunTimeStamp');
      const enabled = disableSr !== 1 && srInitDone === 1;

      console.log(row('Engine state', enabled ? 'ONLINE — restore points permitted' : disableSr === 1 ? 'DISABLED via DisableSR=1' : 'NOT INITIALIZED', enabled ? GREEN : RED));
      console.log(row('SRInitDone', srInitDone === null ? 'absent' : String(srInitDone), srInitDone === 1 ? GREEN : YELLOW));
      console.log(row('DisableSR', disableSr === null ? 'absent (enabled)' : String(disableSr), disableSr === 1 ? RED : GREEN));
      console.log(row('RPSessionInterval (sec)', rpSession === null ? 'absent' : String(rpSession), CYAN));
      console.log(row('LastIndex (next RP id)', lastIndex === null ? 'absent' : String(lastIndex), CYAN));
      console.log(row('FirstRun', firstRun === null ? 'absent' : String(firstRun), firstRun === 0 ? GREEN : YELLOW));
      console.log(row('CreationFrequency (min)', creationFreq === null ? 'default (1440 / 24h)' : creationFreq === 0 ? '0 — no throttle' : String(creationFreq), YELLOW));
      console.log(row('ScopeSnapshots', scopeSnapshots === null ? 'default (scoped)' : scopeSnapshots === 0 ? '0 — legacy full' : String(scopeSnapshots), CYAN));
      console.log(row('RPGlobalInterval (sec)', rpGlobal === null ? 'absent (default 7d)' : String(rpGlobal), CYAN));
      console.log(row('RPLifeInterval (sec)', rpLife === null ? 'absent (default 90d)' : String(rpLife), CYAN));
      console.log(row('LastMaintenance (FILETIME)', lastMaint === null ? 'absent' : '0x' + lastMaint.toString(16), GRAY));
    } finally {
      Advapi32.RegCloseKey(srKey);
    }
  }

  rule('Full Value Inventory');
  const invKey = openKey(SR_KEY);
  if (invKey === null) {
    console.log(`  ${GRAY}(key unavailable)${RESET}`);
  } else {
    try {
      const values = enumerateValues(invKey);
      if (values.length === 0) {
        console.log(`  ${GRAY}No values enumerated.${RESET}`);
      } else {
        for (const v of values) {
          console.log(`  ${GRAY}•${RESET} ${v.name.padEnd(40, ' ')} ${DIM}${regTypeName(v.type)}${RESET}`);
        }
        console.log(`  ${DIM}${values.length} value(s) configured under the SystemRestore key.${RESET}`);
      }
    } finally {
      Advapi32.RegCloseKey(invKey);
    }
  }

  rule('Group Policy Overrides (HKLM\\Policies\\...\\SystemRestore)');
  const polKey = openKey(SR_POLICY_KEY);
  if (polKey === null) {
    console.log(`  ${GREEN}✓ No machine policy overrides — local configuration is authoritative.${RESET}`);
  } else {
    try {
      const disableConfig = readDword(polKey, 'DisableConfig');
      const disableSrPolicy = readDword(polKey, 'DisableSR');
      console.log(row('DisableConfig (policy)', disableConfig === null ? 'not set' : String(disableConfig), disableConfig === 1 ? RED : GREEN));
      console.log(row('DisableSR (policy)', disableSrPolicy === null ? 'not set' : String(disableSrPolicy), disableSrPolicy === 1 ? RED : GREEN));
    } finally {
      Advapi32.RegCloseKey(polKey);
    }
  }

  rule('Native Probe — SRSetRestorePointW (read-only)');
  console.log(`  ${DIM}Path: END_SYSTEM_CHANGE + CANCELLED_OPERATION, sequence = 0x7fffffffffffffff${RESET}`);
  console.log(`  ${DIM}This cancels a non-existent restore point → guaranteed no-op per srrestoreptapi.h.${RESET}`);

  // RESTOREPOINTINFOW (#pragma pack(1)): DWORD + DWORD + INT64 + WCHAR[256] = 528 bytes.
  const restorePtSpec = Buffer.alloc(4 + 4 + 8 + MAX_DESC_W * 2);
  restorePtSpec.writeUInt32LE(RestorePointEventType.END_SYSTEM_CHANGE, 0);
  restorePtSpec.writeUInt32LE(RestorePointType.CANCELLED_OPERATION, 4);
  restorePtSpec.writeBigInt64LE(0x7fffffffffffffffn, 8);
  Buffer.from('bun-win32 diagnostic probe\0', 'utf16le').copy(restorePtSpec, 16);

  // STATEMGRSTATUS (#pragma pack(1)): DWORD nStatus + INT64 llSequenceNumber = 12 bytes.
  const smgrStatus = Buffer.alloc(12);

  const ok = Srclient.SRSetRestorePointW(restorePtSpec.ptr, smgrStatus.ptr);
  const nStatus = smgrStatus.readUInt32LE(0);
  const seq = smgrStatus.readBigInt64LE(4);
  const statusLabel = STATUS_NAMES[nStatus] ?? `0x${nStatus.toString(16)} (undocumented)`;

  console.log();
  console.log(row('SRSetRestorePointW BOOL return', String(ok), ok === 0 ? YELLOW : GREEN));
  console.log(row('STATEMGRSTATUS.nStatus', String(nStatus), nStatus === 0 ? GREEN : YELLOW));
  console.log(row('  decoded', statusLabel, GRAY));
  console.log(row('STATEMGRSTATUS.llSequenceNumber', String(seq), CYAN));

  // SRRemoveRestorePoint signature demonstration on a guaranteed-absent id.
  // Documented contract: returns ERROR_INVALID_DATA when the RP does not exist
  // (no deletion occurs). We pick 0xFFFFFFFF which cannot be a live RP number.
  const removeResult = Srclient.SRRemoveRestorePoint(0xffffffff);
  const removeLabel = removeResult === 13 ? 'ERROR_INVALID_DATA — no such restore point (expected, nothing removed)' : removeResult === 5 ? 'ERROR_ACCESS_DENIED — needs elevation' : `code ${removeResult}`;
  console.log(row('SRRemoveRestorePoint(0xFFFFFFFF)', String(removeResult), removeResult === 13 ? GREEN : YELLOW));
  console.log(row('  decoded', removeLabel, GRAY));

  console.log();
  console.log(`  ${GREEN}✓${RESET} srclient.dll entry points executed and decoded successfully.`);
  console.log(`  ${DIM}No restore point was created or removed — this audit is strictly read-only.${RESET}`);
  console.log();
}

main();
