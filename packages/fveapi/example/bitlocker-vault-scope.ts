/**
 * BitLocker Vault Scope
 *
 * A live, animated disk-encryption "radar". Every mounted volume becomes a
 * sweeping scope row: the cursor sweeps a track while fveapi.dll is probed in
 * real time for that volume's BitLocker handle, and the track lights up green
 * (protected / vault sealed), red (unprotected), or amber (locked-out by the
 * FVE service — the expected unprivileged result). A pulsing lock glyph and a
 * scanning beam give it the feel of a security operations console — all driven
 * by raw FFI into Windows' kernel-mode BitLocker entry point. Read-only and
 * safe: it never modifies a volume, and it degrades to an amber "sealed by
 * policy" state when not elevated.
 *
 * APIs demonstrated (Fveapi):
 *   - FveOpenVolumeW              (open an FVE volume handle, read intent)
 *   - FveGetStatus               (query protection status into a buffer)
 *   - FveCloseVolume             (release the FVE volume handle)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle               (acquire the console output handle)
 *   - GetConsoleMode             (read current console mode)
 *   - SetConsoleMode             (enable ANSI virtual-terminal processing)
 *   - SetConsoleTitleW           (set the window title)
 *   - GetLogicalDrives           (bitmask of mounted drive letters)
 *   - GetVolumeNameForVolumeMountPointW (resolve a drive to its volume GUID)
 *
 * Run: bun run example/bitlocker-vault-scope.ts
 */

import Fveapi from '../index';
import Kernel32, { STD_HANDLE } from '@bun-win32/kernel32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';
const HOME = '\x1b[H';

const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const AMBER = '\x1b[93m';
const CYAN = '\x1b[96m';
const GREY = '\x1b[90m';

const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;

Fveapi.Preload(['FveOpenVolumeW', 'FveGetStatus', 'FveCloseVolume']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'SetConsoleTitleW', 'GetLogicalDrives', 'GetVolumeNameForVolumeMountPointW']);

const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const modeBuffer = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuffer.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuffer.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}
Kernel32.SetConsoleTitleW(Buffer.from('BitLocker Vault Scope\0', 'utf16le').ptr);

type State = 'sealed' | 'open' | 'policy';

interface Scope {
  letter: string;
  guid: string;
  state: State;
  detail: string;
}

// Resolve mounted volumes and probe each one through fveapi.dll.
function scanVolumes(): Scope[] {
  const driveMask = Kernel32.GetLogicalDrives();
  const scopes: Scope[] = [];

  for (let bit = 0; bit < 26; bit++) {
    if (!(driveMask & (1 << bit))) continue;
    const letter = String.fromCharCode(65 + bit);
    const mountPoint = `${letter}:\\`;

    const guidBuffer = Buffer.alloc(128 * 2);
    const resolved = Kernel32.GetVolumeNameForVolumeMountPointW(Buffer.from(mountPoint + '\0', 'utf16le').ptr, guidBuffer.ptr, 128);
    const guid = resolved ? guidBuffer.toString('utf16le').replace(/\0.*$/, '') : '';

    let state: State = 'policy';
    let detail = 'unresolved mount';

    if (resolved) {
      const fvePath = guid.replace(/\\$/, '');
      const handleOut = Buffer.alloc(8);
      handleOut.fill(0);
      const openHr = Fveapi.FveOpenVolumeW(Buffer.from(fvePath + '\0', 'utf16le').ptr, 0, handleOut.ptr);
      const hVolume = handleOut.readBigUInt64LE(0);

      if (openHr === 0 && hVolume !== 0n) {
        const statusBuffer = Buffer.alloc(64);
        statusBuffer.fill(0);
        const statusHr = Fveapi.FveGetStatus(hVolume, statusBuffer.ptr);
        Fveapi.FveCloseVolume(hVolume);
        if (statusHr === 0 && statusBuffer.readUInt32LE(0) === 1) {
          state = 'sealed';
          detail = 'BitLocker protection ON';
        } else if (statusHr === 0) {
          state = 'open';
          detail = 'BitLocker protection OFF';
        } else {
          state = 'policy';
          detail = `status HRESULT 0x${(statusHr >>> 0).toString(16)}`;
        }
      } else {
        state = 'policy';
        detail = openHr === -2147024891 ? 'sealed by policy (E_ACCESSDENIED)' : `FVE rejected probe 0x${(openHr >>> 0).toString(16)}`;
      }
    }

    scopes.push({ letter: `${letter}:`, guid: guid || '(none)', state, detail });
  }
  return scopes;
}

const scopes = scanVolumes();
const TRACK = 44;
const GLYPHS = ['◐', '◓', '◑', '◒'];

function colorFor(state: State): string {
  return state === 'sealed' ? GREEN : state === 'open' ? RED : AMBER;
}

function lockGlyph(state: State, pulse: number): string {
  if (state === 'sealed') return pulse % 2 === 0 ? '🔒' : '🔐';
  if (state === 'open') return '🔓';
  return '🛡';
}

let frame = 0;
const TOTAL_FRAMES = 96;

process.stdout.write(HIDE_CURSOR + CLEAR);

function render(): void {
  const beam = frame % (TRACK + 12);
  let out = HOME;
  out += `${BOLD}${CYAN}  ╔══════════════════════════════════════════════════════════════════╗${RESET}\n`;
  out += `${BOLD}${CYAN}  ║   B I T L O C K E R   V A U L T   S C O P E                      ║${RESET}\n`;
  out += `${BOLD}${CYAN}  ╚══════════════════════════════════════════════════════════════════╝${RESET}\n`;
  out += `${DIM}  fveapi.dll live probe · ${scopes.length} volume(s) · read-only${RESET}\n\n`;

  for (const scope of scopes) {
    const col = colorFor(scope.state);
    const spinner = GLYPHS[frame % GLYPHS.length];

    // Build the sweeping scope track.
    let track = '';
    for (let i = 0; i < TRACK; i++) {
      const distance = Math.abs(i - beam);
      if (distance === 0) track += `${col}█${RESET}`;
      else if (distance === 1) track += `${col}▓${RESET}`;
      else if (distance === 2) track += `${col}▒${RESET}`;
      else if (scope.state === 'sealed' && i % 3 === 0) track += `${GREEN}·${RESET}`;
      else track += `${GREY}·${RESET}`;
    }

    const lock = lockGlyph(scope.state, frame);
    out += `  ${col}${spinner}${RESET} ${BOLD}${scope.letter}${RESET}  ${lock}  [${track}]  ${col}${scope.state.toUpperCase()}${RESET}\n`;
    out += `       ${DIM}${scope.guid}${RESET}\n`;
    out += `       ${col}└─ ${scope.detail}${RESET}\n\n`;
  }

  const sealed = scopes.filter((s) => s.state === 'sealed').length;
  const open = scopes.filter((s) => s.state === 'open').length;
  const policy = scopes.filter((s) => s.state === 'policy').length;
  out += `  ${GREEN}● sealed ${sealed}${RESET}   ${RED}● open ${open}${RESET}   ${AMBER}● policy ${policy}${RESET}\n`;
  out += `  ${DIM}frame ${frame + 1}/${TOTAL_FRAMES}${RESET}\n`;
  process.stdout.write(out);
}

const timer = setInterval(() => {
  render();
  frame++;
  if (frame >= TOTAL_FRAMES) {
    clearInterval(timer);
    process.stdout.write(SHOW_CURSOR + '\n');
    if (sealedCount() === 0 && openCount() === 0) {
      console.log(`${DIM}  All scopes amber: fveapi.dll rejected unprivileged probes.`);
      console.log(`  Re-run from an elevated shell for live BitLocker status.${RESET}\n`);
    } else {
      console.log(`${CYAN}  Scope sweep complete.${RESET}\n`);
    }
  }
}, 70);

function sealedCount(): number {
  return scopes.filter((s) => s.state === 'sealed').length;
}
function openCount(): number {
  return scopes.filter((s) => s.state === 'open').length;
}

process.on('SIGINT', () => {
  clearInterval(timer);
  process.stdout.write(SHOW_CURSOR + RESET + '\n');
  process.exit(0);
});
