/**
 * BitLocker Compliance Report
 *
 * A professional, exhaustively-formatted disk-security audit. It enumerates
 * every mounted volume on the system via Kernel32, classifies each by drive
 * type, then probes the BitLocker / Full Volume Encryption subsystem through
 * fveapi.dll for a protection-status read. fveapi.dll is the user-mode entry
 * point to kernel-mode BitLocker; opening a volume handle and most queries
 * require elevation (Administrator / SYSTEM). This report degrades gracefully:
 * when the FVE service rejects an unprivileged caller it reports the exact
 * HRESULT (E_INVALIDARG / E_ACCESSDENIED) instead of failing, and renders an
 * aligned, color-coded compliance table either way.
 *
 * APIs demonstrated (Fveapi):
 *   - FveOpenVolumeW              (open an FVE volume handle, read intent)
 *   - FveGetStatus               (query protection status into a buffer)
 *   - FveQuery                   (query conversion/encryption status)
 *   - FveCloseVolume             (release the FVE volume handle)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle               (acquire the console output handle)
 *   - GetConsoleMode             (read current console mode)
 *   - SetConsoleMode             (enable ANSI virtual-terminal processing)
 *   - SetConsoleTitleW           (set the window title)
 *   - GetLogicalDrives           (bitmask of mounted drive letters)
 *   - GetDriveTypeW              (classify a drive: fixed / removable / ...)
 *   - GetVolumeNameForVolumeMountPointW (resolve a drive to its volume GUID)
 *   - GetLastError               (last-error code on failure)
 *
 * Run: bun run example/bitlocker-compliance-report.ts
 */

import Fveapi from '../index';
import Kernel32, { STD_HANDLE } from '@bun-win32/kernel32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[91m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const BLUE = '\x1b[94m';
const CYAN = '\x1b[96m';

const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;

Fveapi.Preload(['FveOpenVolumeW', 'FveGetStatus', 'FveQuery', 'FveCloseVolume']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'SetConsoleTitleW', 'GetLogicalDrives', 'GetDriveTypeW', 'GetVolumeNameForVolumeMountPointW', 'GetLastError']);

// Enable ANSI escape processing on the console output handle.
const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const modeBuffer = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuffer.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuffer.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}
Kernel32.SetConsoleTitleW(Buffer.from('BitLocker Compliance Report\0', 'utf16le').ptr);

const DRIVE_TYPE_NAMES: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'NO_ROOT_DIR',
  2: 'REMOVABLE',
  3: 'FIXED',
  4: 'REMOTE',
  5: 'CD-ROM',
  6: 'RAM_DISK',
};

interface VolumeRow {
  letter: string;
  driveType: string;
  volumeGuid: string;
  openHr: number;
  protection: string;
  conversion: string;
  note: string;
}

function hr(code: number): string {
  return `0x${(code >>> 0).toString(16).padStart(8, '0')}`;
}

function describeHr(code: number): string {
  switch (code >>> 0) {
    case 0x00000000:
      return 'S_OK';
    case 0x80070057:
      return 'E_INVALIDARG (caller/context not accepted)';
    case 0x80070005:
      return 'E_ACCESSDENIED (elevation required)';
    case 0x80310000:
      return 'FVE_E_LOCKED_VOLUME';
    default:
      return 'see HRESULT';
  }
}

// Enumerate mounted drive letters from the logical-drives bitmask.
const driveMask = Kernel32.GetLogicalDrives();
const letters: string[] = [];
for (let bit = 0; bit < 26; bit++) {
  if (driveMask & (1 << bit)) letters.push(String.fromCharCode(65 + bit));
}

const rows: VolumeRow[] = [];

for (const letter of letters) {
  const mountPoint = `${letter}:\\`;
  const driveType = DRIVE_TYPE_NAMES[Kernel32.GetDriveTypeW(Buffer.from(mountPoint + '\0', 'utf16le').ptr)] ?? 'UNKNOWN';

  // Resolve the drive letter to its \\?\Volume{GUID}\ path.
  const guidBuffer = Buffer.alloc(128 * 2);
  const resolved = Kernel32.GetVolumeNameForVolumeMountPointW(Buffer.from(mountPoint + '\0', 'utf16le').ptr, guidBuffer.ptr, 128);
  const volumeGuid = resolved ? guidBuffer.toString('utf16le').replace(/\0.*$/, '') : '(unresolved)';

  const row: VolumeRow = {
    letter: mountPoint,
    driveType,
    volumeGuid,
    openHr: -1,
    protection: '-',
    conversion: '-',
    note: '',
  };

  if (resolved) {
    // fveapi expects the volume path without the trailing backslash.
    const fvePath = volumeGuid.replace(/\\$/, '');
    const pathBuffer = Buffer.from(fvePath + '\0', 'utf16le');
    const handleOut = Buffer.alloc(8);
    handleOut.fill(0);

    const openHr = Fveapi.FveOpenVolumeW(pathBuffer.ptr, 0, handleOut.ptr);
    row.openHr = openHr;
    const hVolume = handleOut.readBigUInt64LE(0);

    if (openHr === 0 && hVolume !== 0n) {
      const statusBuffer = Buffer.alloc(64);
      statusBuffer.fill(0);
      const statusHr = Fveapi.FveGetStatus(hVolume, statusBuffer.ptr);
      if (statusHr === 0) {
        const protectionValue = statusBuffer.readUInt32LE(0);
        row.protection = protectionValue === 1 ? 'ON' : protectionValue === 0 ? 'OFF' : `UNKNOWN(${protectionValue})`;
      } else {
        row.protection = `err ${hr(statusHr)}`;
      }

      const queryBuffer = Buffer.alloc(64);
      queryBuffer.fill(0);
      const queryHr = Fveapi.FveQuery(hVolume, queryBuffer.ptr);
      row.conversion = queryHr === 0 ? `code ${queryBuffer.readUInt32LE(0)}` : `err ${hr(queryHr)}`;

      Fveapi.FveCloseVolume(hVolume);
      row.note = 'FVE handle opened';
    } else {
      row.note = describeHr(openHr);
    }
  } else {
    row.note = `mount unresolved (GetLastError=${Kernel32.GetLastError()})`;
  }

  rows.push(row);
}

const W_LETTER = 6;
const W_TYPE = 11;
const W_GUID = 50;
const W_OPEN = 12;
const W_PROT = 14;

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

console.log('');
console.log(`${BOLD}${CYAN}  BitLocker / Full Volume Encryption — Compliance Report${RESET}`);
console.log(`${DIM}  fveapi.dll · read-only probe · ${new Date().toISOString()}${RESET}`);
console.log('');
console.log(`${BOLD}  ${pad('DRIVE', W_LETTER)} ${pad('TYPE', W_TYPE)} ${pad('VOLUME GUID', W_GUID)} ${pad('FveOpen', W_OPEN)} ${pad('PROTECTION', W_PROT)}${RESET}`);
console.log(`  ${DIM}${'-'.repeat(W_LETTER + W_TYPE + W_GUID + W_OPEN + W_PROT + 4)}${RESET}`);

let encrypted = 0;
let unprotected = 0;
let inaccessible = 0;

for (const row of rows) {
  const openText = row.openHr === 0 ? `${GREEN}${pad('S_OK', W_OPEN)}${RESET}` : `${YELLOW}${pad(hr(row.openHr), W_OPEN)}${RESET}`;

  let protColor = DIM;
  if (row.protection === 'ON') {
    protColor = GREEN;
    encrypted++;
  } else if (row.protection === 'OFF') {
    protColor = RED;
    unprotected++;
  } else {
    inaccessible++;
  }

  console.log(`  ${BLUE}${pad(row.letter, W_LETTER)}${RESET} ${pad(row.driveType, W_TYPE)} ${DIM}${pad(row.volumeGuid, W_GUID)}${RESET} ${openText} ${protColor}${pad(row.protection, W_PROT)}${RESET}`);
  console.log(`  ${DIM}${' '.repeat(W_LETTER + W_TYPE + 2)}└─ ${row.note}${row.conversion !== '-' ? ` · conversion: ${row.conversion}` : ''}${RESET}`);
}

console.log('');
console.log(`${BOLD}  Summary${RESET}`);
console.log(`  ${GREEN}● protected${RESET}     ${encrypted}`);
console.log(`  ${RED}● unprotected${RESET}   ${unprotected}`);
console.log(`  ${YELLOW}● inaccessible${RESET}  ${inaccessible}  ${DIM}(elevation or BitLocker not configured)${RESET}`);
console.log('');

if (inaccessible > 0 && encrypted === 0 && unprotected === 0) {
  console.log(`${DIM}  Note: fveapi.dll rejected unprivileged probes. Re-run from an elevated`);
  console.log(`  (Administrator) shell to obtain live protection status.${RESET}`);
  console.log('');
}
