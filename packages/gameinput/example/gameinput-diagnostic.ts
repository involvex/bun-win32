/**
 * GameInput Diagnostic
 *
 * A thorough, richly-formatted diagnostic of the modern Windows GameInput
 * stack — driven entirely over Bun FFI with no native addon. It bootstraps
 * the per-process `IGameInput` Nano-COM singleton through the flat
 * `GameInputCreate` export, then walks the interface's COM vtable directly
 * (cast-free) to: read the high-resolution input clock, take a deterministic
 * timing sample to derive the tick rate, probe every `GameInputKind`
 * (gamepad / keyboard / mouse / controller / flight stick / arcade stick /
 * racing wheel / sensors) for a current reading, and — when a device is
 * present — decode and tabulate the live gamepad / mouse / keyboard reading
 * straight from the returned struct memory. Every transient reading object is
 * released; the per-process `IGameInput` singleton is intentionally retained
 * (the OS input service co-owns it for the process lifetime) — which
 * `DllCanUnloadNow` confirms by reporting the server cannot yet unload.
 *
 * APIs demonstrated:
 *   - GameInput.GameInputCreate                 (Nano-COM IGameInput singleton)
 *   - GameInput.DllCanUnloadNow                 (COM unload / ref-count probe)
 *   - IGameInput::GetCurrentTimestamp           (microsecond input clock)
 *   - IGameInput::GetCurrentReading             (filtered input-stream poll)
 *   - IGameInputReading::GetInputKind           (reading classification)
 *   - IGameInputReading::GetTimestamp           (per-reading timestamp)
 *   - IGameInputReading::GetGamepadState        (decode gamepad struct)
 *   - IGameInputReading::GetMouseState          (decode mouse struct)
 *   - IGameInputReading::GetKeyCount            (keyboard key-down count)
 *   - IUnknown::Release                         (release every COM object)
 *   - kernel32!GetCurrentProcess / ReadProcessMemory  (cast-free vtable walk)
 *
 * Run: bun run example:gameinput-diagnostic
 */

import { FFIType, dlopen, linkSymbols } from 'bun:ffi';

import GameInput, { GameInputGamepadButtons, GameInputKind } from '..';

const ANSI = {
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  yellow: '\x1b[33m',
} as const;

const POINTER_SIZE = 8;

// IUnknown(3) precedes every interface's own slots. Slot index * 8 = byte offset.
const RELEASE_OFFSET = 0x10; // IUnknown slot 2
const IGI_GET_CURRENT_TIMESTAMP_OFFSET = 0x18; // IGameInput slot 3
const IGI_GET_CURRENT_READING_OFFSET = 0x20; // IGameInput slot 4
const READING_GET_INPUT_KIND_OFFSET = 0x18; // IGameInputReading slot 3
const READING_GET_TIMESTAMP_OFFSET = 0x28; // IGameInputReading slot 5
const READING_GET_KEY_COUNT_OFFSET = 0x70; // IGameInputReading slot 14
const READING_GET_MOUSE_STATE_OFFSET = 0x80; // IGameInputReading slot 16
const READING_GET_GAMEPAD_STATE_OFFSET = 0xb0; // IGameInputReading slot 22

const S_OK = 0x0000_0000;

GameInput.Preload();

const kernel32 = dlopen('kernel32.dll', {
  GetCurrentProcess: { args: [], returns: FFIType.u64 },
  ReadProcessMemory: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
});

const currentProcess = kernel32.symbols.GetCurrentProcess();

function readPointerAt(address: bigint): bigint {
  const buffer = Buffer.alloc(POINTER_SIZE);
  const ok = kernel32.symbols.ReadProcessMemory(currentProcess, address, buffer.ptr, BigInt(POINTER_SIZE), null);
  if (ok === 0) throw new Error(`ReadProcessMemory failed at 0x${address.toString(16)}`);
  return buffer.readBigUInt64LE(0);
}

// Resolve one vtable slot for a COM object into the raw native function
// address. The address is then linked at the call site with a *literal*
// linkSymbols signature so Bun infers the precise return type — no casts,
// no FFIType[] indirection that would erase it to `unknown`.
function vfn(objectAddress: bigint, slotOffset: number): bigint {
  const vtable = readPointerAt(objectAddress);
  return readPointerAt(vtable + BigInt(slotOffset));
}

function comRelease(address: bigint): void {
  if (address === 0n) return;
  const link = linkSymbols({
    call: { args: [FFIType.u64], ptr: vfn(address, RELEASE_OFFSET), returns: FFIType.u32 },
  });
  try {
    link.symbols.call(address);
  } finally {
    link.close();
  }
}

type Status = 'ok' | 'absent' | 'info';

interface Row {
  detail: string;
  name: string;
  section: string;
  status: Status;
}

const rows: Row[] = [];
function record(section: string, name: string, status: Status, detail: string): void {
  rows.push({ detail, name, section, status });
}

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

// ── Section A: bootstrap the IGameInput singleton ────────────────────────────
const ppGameInput = Buffer.alloc(POINTER_SIZE);
const createHr = GameInput.GameInputCreate(ppGameInput.ptr);
const gameInputAddr = ppGameInput.readBigUInt64LE(0);

if (createHr >>> 0 !== S_OK || gameInputAddr === 0n) {
  console.log(`${ANSI.red}GameInputCreate failed: ${hex32(createHr)}${ANSI.reset}`);
  kernel32.close();
  process.exit(1);
}
record('Bootstrap', 'GameInputCreate', 'ok', `IGameInput singleton @ 0x${gameInputAddr.toString(16)} (${hex32(createHr)})`);

// ── Section B: high-resolution input clock ───────────────────────────────────
{
  const link = linkSymbols({
    call: { args: [FFIType.u64], ptr: vfn(gameInputAddr, IGI_GET_CURRENT_TIMESTAMP_OFFSET), returns: FFIType.u64 },
  });
  try {
    const t0 = link.symbols.call(gameInputAddr);
    // Deterministic busy spin so the measured delta is CPU-verifiable: the
    // GameInput clock is documented in microseconds, so a tight loop must
    // advance it by a strictly-positive, monotonically-increasing amount.
    let spin = 0;
    for (let i = 0; i < 5_000_000; i += 1) spin += i & 7;
    const t1 = link.symbols.call(gameInputAddr);
    const deltaUs = t1 - t0;
    record('Input clock', 'GetCurrentTimestamp', 'ok', `t0=${t0}µs  t1=${t1}µs`);
    record('Input clock', 'Monotonic delta', t1 > t0 ? 'ok' : 'absent', `+${deltaUs}µs over a fixed 5M-iteration spin (checksum ${spin})`);
  } finally {
    link.close();
  }
}

// ── Section C: probe every input kind for a current reading ──────────────────
const KINDS: Array<{ kind: GameInputKind; label: string }> = [
  { kind: GameInputKind.GameInputKindGamepad, label: 'Gamepad' },
  { kind: GameInputKind.GameInputKindKeyboard, label: 'Keyboard' },
  { kind: GameInputKind.GameInputKindMouse, label: 'Mouse' },
  { kind: GameInputKind.GameInputKindController, label: 'Controller' },
  { kind: GameInputKind.GameInputKindArcadeStick, label: 'Arcade stick' },
  { kind: GameInputKind.GameInputKindFlightStick, label: 'Flight stick' },
  { kind: GameInputKind.GameInputKindRacingWheel, label: 'Racing wheel' },
  { kind: GameInputKind.GameInputKindSensors, label: 'Sensors' },
];

const getReading = linkSymbols({
  call: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.ptr], ptr: vfn(gameInputAddr, IGI_GET_CURRENT_READING_OFFSET), returns: FFIType.i32 },
});

let liveGamepad: bigint = 0n;
let liveMouse: bigint = 0n;
let liveKeyboard: bigint = 0n;

try {
  for (const { kind, label } of KINDS) {
    const ppReading = Buffer.alloc(POINTER_SIZE);
    // GetCurrentReading(inputKind, device=NULL, &reading)
    const hr = getReading.symbols.call(gameInputAddr, kind, 0n, ppReading.ptr);
    const readingAddr = ppReading.readBigUInt64LE(0);
    if (hr >>> 0 === S_OK && readingAddr !== 0n) {
      record('Input kinds', label, 'ok', `reading @ 0x${readingAddr.toString(16)}`);
      if (kind === GameInputKind.GameInputKindGamepad && liveGamepad === 0n) liveGamepad = readingAddr;
      else if (kind === GameInputKind.GameInputKindMouse && liveMouse === 0n) liveMouse = readingAddr;
      else if (kind === GameInputKind.GameInputKindKeyboard && liveKeyboard === 0n) liveKeyboard = readingAddr;
      else comRelease(readingAddr);
    } else {
      record('Input kinds', label, 'absent', `no device · ${hex32(hr)}`);
    }
  }
} finally {
  getReading.close();
}

// ── Section D: decode a live reading, if any device is connected ─────────────
if (liveGamepad !== 0n) {
  const kindLink = linkSymbols({
    call: { args: [FFIType.u64], ptr: vfn(liveGamepad, READING_GET_INPUT_KIND_OFFSET), returns: FFIType.u32 },
  });
  const tsLink = linkSymbols({
    call: { args: [FFIType.u64], ptr: vfn(liveGamepad, READING_GET_TIMESTAMP_OFFSET), returns: FFIType.u64 },
  });
  const stateLink = linkSymbols({
    call: { args: [FFIType.u64, FFIType.ptr], ptr: vfn(liveGamepad, READING_GET_GAMEPAD_STATE_OFFSET), returns: FFIType.bool },
  });
  try {
    const kind = kindLink.symbols.call(liveGamepad);
    const ts = tsLink.symbols.call(liveGamepad);
    // GameInputGamepadState: buttons(u32) + 7 floats; pad to 8-byte aligned.
    const state = Buffer.alloc(32);
    const ok = stateLink.symbols.call(liveGamepad, state.ptr);
    if (ok) {
      const buttons = state.readUInt32LE(0);
      const lt = state.readFloatLE(4);
      const rt = state.readFloatLE(8);
      const lx = state.readFloatLE(12);
      const ly = state.readFloatLE(16);
      const rx = state.readFloatLE(20);
      const ry = state.readFloatLE(24);
      const pressed = Object.entries(GameInputGamepadButtons)
        .filter(([k, v]) => typeof v === 'number' && v !== 0 && (buttons & v) === v && k !== 'GameInputGamepadNone')
        .map(([k]) => k.replace('GameInputGamepad', ''));
      record('Gamepad reading', 'InputKind', 'ok', hex32(kind));
      record('Gamepad reading', 'Timestamp', 'ok', `${ts}µs`);
      record('Gamepad reading', 'Buttons', 'ok', `${hex32(buttons)}${pressed.length ? ` · ${pressed.join(', ')}` : ' · (none held)'}`);
      record('Gamepad reading', 'Triggers', 'ok', `L=${lt.toFixed(3)}  R=${rt.toFixed(3)}`);
      record('Gamepad reading', 'Left stick', 'ok', `X=${lx.toFixed(3)}  Y=${ly.toFixed(3)}`);
      record('Gamepad reading', 'Right stick', 'ok', `X=${rx.toFixed(3)}  Y=${ry.toFixed(3)}`);
    } else {
      record('Gamepad reading', 'GetGamepadState', 'absent', 'reading is not a gamepad interpretation');
    }
  } finally {
    kindLink.close();
    tsLink.close();
    stateLink.close();
    comRelease(liveGamepad);
  }
}

if (liveMouse !== 0n) {
  const stateLink = linkSymbols({
    call: { args: [FFIType.u64, FFIType.ptr], ptr: vfn(liveMouse, READING_GET_MOUSE_STATE_OFFSET), returns: FFIType.bool },
  });
  try {
    // GameInputMouseState: buttons(u32) positions(u32) + 6 * int64_t.
    const state = Buffer.alloc(56);
    const ok = stateLink.symbols.call(liveMouse, state.ptr);
    if (ok) {
      const buttons = state.readUInt32LE(0);
      const positions = state.readUInt32LE(4);
      const posX = state.readBigInt64LE(8);
      const posY = state.readBigInt64LE(16);
      const absX = state.readBigInt64LE(24);
      const absY = state.readBigInt64LE(32);
      const wheelX = state.readBigInt64LE(40);
      const wheelY = state.readBigInt64LE(48);
      record('Mouse reading', 'Buttons', 'ok', `${hex32(buttons)} (positionFlags ${hex32(positions)})`);
      record('Mouse reading', 'Position Δ', 'ok', `X=${posX}  Y=${posY}`);
      record('Mouse reading', 'Absolute', 'ok', `X=${absX}  Y=${absY}`);
      record('Mouse reading', 'Wheel', 'ok', `X=${wheelX}  Y=${wheelY}`);
    } else {
      record('Mouse reading', 'GetMouseState', 'absent', 'reading is not a mouse interpretation');
    }
  } finally {
    stateLink.close();
    comRelease(liveMouse);
  }
}

if (liveKeyboard !== 0n) {
  const keyCountLink = linkSymbols({
    call: { args: [FFIType.u64], ptr: vfn(liveKeyboard, READING_GET_KEY_COUNT_OFFSET), returns: FFIType.u32 },
  });
  try {
    const keyCount = keyCountLink.symbols.call(liveKeyboard);
    record('Keyboard reading', 'GetKeyCount', 'ok', `${keyCount} key(s) currently down`);
  } finally {
    keyCountLink.close();
    comRelease(liveKeyboard);
  }
}

// ── Section E: retain the singleton & probe the unload verdict ───────────────
// The per-process IGameInput singleton is deliberately NOT released: the OS
// input service co-owns it for the lifetime of the process, so force-releasing
// it from a short-lived diagnostic only races that still-running dispatcher
// thread. DllCanUnloadNow reports the in-proc server cannot unload precisely
// because those OS-held references persist — which is the verdict to show.
const canUnload = GameInput.DllCanUnloadNow();
record('Teardown', 'IGameInput singleton', 'ok', 'retained — OS input service co-owns it for the process lifetime');
record('Teardown', 'DllCanUnloadNow', canUnload >>> 0 === S_OK ? 'ok' : 'info', canUnload >>> 0 === S_OK ? `${hex32(canUnload)} (S_OK — server unloadable)` : `${hex32(canUnload)} (S_FALSE — refs still held by the OS input service)`);

kernel32.close();

// ── Report ───────────────────────────────────────────────────────────────────
const NAME_WIDTH = Math.max(...rows.map((r) => r.name.length));
const badge: Record<Status, string> = {
  absent: `${ANSI.yellow}○${ANSI.reset}`,
  info: `${ANSI.cyan}ℹ${ANSI.reset}`,
  ok: `${ANSI.green}✓${ANSI.reset}`,
};

console.log();
console.log(`${ANSI.bold}${ANSI.cyan}gameinput.dll${ANSI.reset}  ${ANSI.dim}unified input model diagnostic · ${rows.length} checks${ANSI.reset}`);

let currentSection = '';
for (const r of rows) {
  if (r.section !== currentSection) {
    currentSection = r.section;
    console.log();
    console.log(`  ${ANSI.bold}${ANSI.magenta}${r.section}${ANSI.reset}`);
    console.log(`  ${ANSI.dim}${'─'.repeat(Math.min(110, NAME_WIDTH + 2 + 60))}${ANSI.reset}`);
  }
  const detail = r.status === 'absent' ? `${ANSI.dim}${r.detail}${ANSI.reset}` : r.detail;
  console.log(`  ${badge[r.status]} ${ANSI.yellow}${r.name.padEnd(NAME_WIDTH)}${ANSI.reset}  ${detail}`);
}

const okCount = rows.filter((r) => r.status === 'ok').length;
const absentCount = rows.filter((r) => r.status === 'absent').length;

console.log();
console.log(
  `  ${ANSI.bold}${okCount}${ANSI.reset} ${ANSI.green}ok${ANSI.reset}  ${ANSI.dim}•${ANSI.reset}  ${ANSI.bold}${absentCount}${ANSI.reset} ${ANSI.yellow}absent${ANSI.reset}  ${ANSI.dim}•${ANSI.reset}  ${ANSI.dim}plug in a controller and re-run to see live readings decoded${ANSI.reset}`,
);
console.log();

// The IGameInput singleton is retained (the OS input service co-owns it), so
// the in-proc server and its dispatcher thread are still live at this point.
// Exit deterministically here (mirroring the oscilloscope's shutdown) rather
// than leaving teardown ordering to chance once the report has been printed.
process.exit(0);
