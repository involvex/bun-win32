/**
 * GameInput Oscilloscope
 *
 * A live, full-screen terminal "oscilloscope" wired straight into the modern
 * Windows GameInput stack over Bun FFI — no native addon, no game engine.
 * It bootstraps the `IGameInput` Nano-COM singleton via the flat
 * `GameInputCreate` export, then drives two scopes from real hardware
 * timestamps walked off the COM vtable:
 *
 *   • A microsecond clock trace: each frame samples
 *     `IGameInput::GetCurrentTimestamp` and scrolls the per-frame delta
 *     across the screen as a colored waveform — you are literally watching
 *     the OS input clock advance in real time, with the running rate shown
 *     in ticks/second.
 *   • A live gamepad panel: when a controller is connected, every analog
 *     stick / trigger axis and the full button mask are decoded from the
 *     `GameInputGamepadState` struct and rendered as live signal bars and a
 *     lit button grid. With no controller, it shows an idle "no signal"
 *     sweep so the demo is always visually alive.
 *
 * APIs demonstrated:
 *   - GameInput.GameInputCreate                 (Nano-COM IGameInput singleton)
 *   - IGameInput::GetCurrentTimestamp           (microsecond input clock trace)
 *   - IGameInput::GetCurrentReading             (poll the gamepad stream)
 *   - IGameInputReading::GetGamepadState        (decode live stick/button data)
 *   - IUnknown::Release                         (release every COM object)
 *   - kernel32!GetCurrentProcess / ReadProcessMemory  (cast-free vtable walk)
 *
 * Run: bun run example:gameinput-oscilloscope
 */

import { FFIType, dlopen, linkSymbols } from 'bun:ffi';

import GameInput, { GameInputGamepadButtons, GameInputKind } from '..';

const ANSI = {
  bold: '\x1b[1m',
  clear: '\x1b[2J',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  hide: '\x1b[?25l',
  home: '\x1b[H',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  show: '\x1b[?25h',
  yellow: '\x1b[33m',
} as const;

const POINTER_SIZE = 8;
const RELEASE_OFFSET = 0x10;
const IGI_GET_CURRENT_TIMESTAMP_OFFSET = 0x18;
const IGI_GET_CURRENT_READING_OFFSET = 0x20;
const READING_GET_GAMEPAD_STATE_OFFSET = 0xb0;

const S_OK = 0x0000_0000;
const FRAME_MS = 40;
const TRACE_WIDTH = Math.min(72, Math.max(40, (process.stdout.columns ?? 80) - 8));

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

// Resolve one vtable slot to its raw native function address. Linked at the
// call site with a *literal* linkSymbols signature so Bun infers the precise
// return type — no casts, no FFIType[] indirection that would erase it.
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

const ppGameInput = Buffer.alloc(POINTER_SIZE);
const createHr = GameInput.GameInputCreate(ppGameInput.ptr);
const gameInputAddr = ppGameInput.readBigUInt64LE(0);
if (createHr >>> 0 !== S_OK || gameInputAddr === 0n) {
  console.log(`${ANSI.red}GameInputCreate failed: 0x${(createHr >>> 0).toString(16)}${ANSI.reset}`);
  kernel32.close();
  process.exit(1);
}

const tsLink = linkSymbols({
  call: { args: [FFIType.u64], ptr: vfn(gameInputAddr, IGI_GET_CURRENT_TIMESTAMP_OFFSET), returns: FFIType.u64 },
});
const readingLink = linkSymbols({
  call: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.ptr], ptr: vfn(gameInputAddr, IGI_GET_CURRENT_READING_OFFSET), returns: FFIType.i32 },
});

const SPARK = ' ▁▂▃▄▅▆▇█';
function spark(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  return SPARK[Math.round(clamped * (SPARK.length - 1))];
}

function bar(label: string, value: number, lo: number, hi: number): string {
  const width = 28;
  const norm = (value - lo) / (hi - lo);
  const filled = Math.max(0, Math.min(width, Math.round(norm * width)));
  const color = norm > 0.66 ? ANSI.green : norm > 0.33 ? ANSI.yellow : ANSI.cyan;
  return `${ANSI.dim}${label.padEnd(8)}${ANSI.reset} ${color}${'█'.repeat(filled)}${ANSI.dim}${'·'.repeat(width - filled)}${ANSI.reset} ${value >= 0 ? ' ' : ''}${value.toFixed(3)}`;
}

const BUTTON_GRID: Array<{ name: string; flag: GameInputGamepadButtons }> = [
  { name: 'A', flag: GameInputGamepadButtons.GameInputGamepadA },
  { name: 'B', flag: GameInputGamepadButtons.GameInputGamepadB },
  { name: 'X', flag: GameInputGamepadButtons.GameInputGamepadX },
  { name: 'Y', flag: GameInputGamepadButtons.GameInputGamepadY },
  { name: 'LB', flag: GameInputGamepadButtons.GameInputGamepadLeftShoulder },
  { name: 'RB', flag: GameInputGamepadButtons.GameInputGamepadRightShoulder },
  { name: 'Menu', flag: GameInputGamepadButtons.GameInputGamepadMenu },
  { name: 'View', flag: GameInputGamepadButtons.GameInputGamepadView },
  { name: 'Up', flag: GameInputGamepadButtons.GameInputGamepadDPadUp },
  { name: 'Down', flag: GameInputGamepadButtons.GameInputGamepadDPadDown },
  { name: 'Left', flag: GameInputGamepadButtons.GameInputGamepadDPadLeft },
  { name: 'Right', flag: GameInputGamepadButtons.GameInputGamepadDPadRight },
];

const trace: number[] = [];
let lastTs = tsLink.symbols.call(gameInputAddr);
let frame = 0;
let running = true;
let totalDelta = 0n;

function shutdown(): void {
  if (!running) return;
  running = false;
  try {
    readingLink.close();
    tsLink.close();
    comRelease(gameInputAddr);
    kernel32.close();
  } catch {}
  process.stdout.write(`${ANSI.show}${ANSI.reset}\n`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.stdout.write(`${ANSI.hide}${ANSI.clear}`);

const timer = setInterval(() => {
  if (!running) return;
  frame += 1;

  // ── Sample the real microsecond input clock ──
  const ts = tsLink.symbols.call(gameInputAddr);
  const deltaUs = Number(ts - lastTs);
  lastTs = ts;
  totalDelta += BigInt(deltaUs);
  trace.push(deltaUs);
  if (trace.length > TRACE_WIDTH) trace.shift();

  const maxDelta = Math.max(1, ...trace);
  const waveform = trace.map((d) => spark(d / maxDelta)).join('');
  const avgUsPerFrame = Number(totalDelta) / frame;
  const ticksPerSec = avgUsPerFrame > 0 ? (1_000_000 / avgUsPerFrame) * (1000 / FRAME_MS) : 0;

  // ── Poll the gamepad stream ──
  const ppReading = Buffer.alloc(POINTER_SIZE);
  const hr = readingLink.symbols.call(gameInputAddr, GameInputKind.GameInputKindGamepad, 0n, ppReading.ptr);
  const readingAddr = ppReading.readBigUInt64LE(0);

  const lines: string[] = [];
  lines.push(`${ANSI.bold}${ANSI.cyan}╔═ GameInput Oscilloscope ═══════════════════════════════════════════════╗${ANSI.reset}`);
  lines.push(`${ANSI.dim} frame ${String(frame).padStart(5)}   ·   sampling IGameInput::GetCurrentTimestamp over Bun FFI${ANSI.reset}`);
  lines.push('');
  lines.push(`${ANSI.magenta} microsecond clock trace${ANSI.reset}  ${ANSI.dim}(per-frame Δ, peak ${maxDelta}µs)${ANSI.reset}`);
  lines.push(`  ${ANSI.green}${waveform}${ANSI.reset}`);
  lines.push(`  ${ANSI.dim}now=${ts}µs   rate≈${(ticksPerSec / 1_000_000).toFixed(3)}M ticks/s   total +${totalDelta}µs${ANSI.reset}`);
  lines.push('');

  if (hr >>> 0 === S_OK && readingAddr !== 0n) {
    const stateLink = linkSymbols({
      call: { args: [FFIType.u64, FFIType.ptr], ptr: vfn(readingAddr, READING_GET_GAMEPAD_STATE_OFFSET), returns: FFIType.bool },
    });
    try {
      const state = Buffer.alloc(32);
      const ok = stateLink.symbols.call(readingAddr, state.ptr);
      if (ok) {
        const buttons = state.readUInt32LE(0);
        const lt = state.readFloatLE(4);
        const rt = state.readFloatLE(8);
        const lx = state.readFloatLE(12);
        const ly = state.readFloatLE(16);
        const rx = state.readFloatLE(20);
        const ry = state.readFloatLE(24);
        lines.push(`${ANSI.magenta} gamepad signal bars${ANSI.reset}  ${ANSI.green}● live device${ANSI.reset}`);
        lines.push(`  ${bar('L-StickX', lx, -1, 1)}`);
        lines.push(`  ${bar('L-StickY', ly, -1, 1)}`);
        lines.push(`  ${bar('R-StickX', rx, -1, 1)}`);
        lines.push(`  ${bar('R-StickY', ry, -1, 1)}`);
        lines.push(`  ${bar('LTrigger', lt, 0, 1)}`);
        lines.push(`  ${bar('RTrigger', rt, 0, 1)}`);
        lines.push('');
        const grid = BUTTON_GRID.map(({ name, flag }) => {
          const lit = (buttons & flag) === flag;
          return lit ? `${ANSI.bold}${ANSI.green}[${name}]${ANSI.reset}` : `${ANSI.dim}(${name})${ANSI.reset}`;
        }).join(' ');
        lines.push(`  ${grid}`);
      }
    } finally {
      stateLink.close();
      comRelease(readingAddr);
    }
  } else {
    // Idle sweep so the scope is always alive even with no controller.
    const phase = frame % TRACE_WIDTH;
    const sweep = Array.from({ length: TRACE_WIDTH }, (_, i) => {
      const d = Math.abs(i - phase);
      return d < 3 ? spark((3 - d) / 3) : ' ';
    }).join('');
    lines.push(`${ANSI.magenta} gamepad signal${ANSI.reset}  ${ANSI.yellow}○ no controller connected — idle sweep${ANSI.reset}`);
    lines.push(`  ${ANSI.cyan}${sweep}${ANSI.reset}`);
    lines.push(`  ${ANSI.dim}plug in an Xbox / compatible controller to see live stick & button data${ANSI.reset}`);
  }

  lines.push('');
  lines.push(`${ANSI.dim} Ctrl+C to exit${ANSI.reset}`);

  process.stdout.write(`${ANSI.home}${lines.map((l) => l + '\x1b[K').join('\n')}\x1b[J`);

  if (frame >= 250) shutdown();
}, FRAME_MS);

// The interval keeps the event loop alive; the demo self-terminates after a
// fixed number of frames via shutdown() (or on Ctrl+C). It is not unref'd, so
// it renders correctly whether stdout is a TTY or a pipe.
void timer;
