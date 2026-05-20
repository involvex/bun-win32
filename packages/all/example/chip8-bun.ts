/**
 * CHIP-8 — a complete 1970s-era 8-bit virtual CPU running in Bun + Win32 FFI.
 *
 * This file is a from-scratch CHIP-8 interpreter wired straight into a real
 * Win32 window. The 64×32 monochrome display is scaled 10× into a 32-bit ARGB
 * GDI+ framebuffer, blitted to the window every frame with SetDIBitsToDevice;
 * the 16-key hex keypad is wired through WM_KEYDOWN / WM_KEYUP on the physical
 * 1234 / QWER / ASDF / ZXCV block; and the CHIP-8 sound timer gates a real
 * IXAudio2 source voice playing a looping square-wave beeper through the COM
 * vtable. The window is borderless with the Desktop Window Manager mica
 * backdrop in immersive dark mode.
 *
 * The CHIP-8 CPU implemented here is the canonical 1977 spec:
 *
 *   - 4 KiB of RAM. Programs load at 0x200; addresses 0x000-0x04F hold the
 *     standard 16 × 5-byte hex font sprites used by the FX29 opcode.
 *   - 16 × 8-bit general-purpose registers V0-VF. VF doubles as the carry /
 *     collision flag for ADD/SUB/SHR/SHL/DRW.
 *   - A 16-bit index register I, a 16-bit program counter PC, and a 16-entry
 *     return-address stack with an 8-bit SP.
 *   - Two 60 Hz countdown timers: the delay timer DT and the sound timer ST.
 *     ST > 0 makes the audio beep audible.
 *   - 64×32 monochrome framebuffer. Sprites are XOR-drawn (DXYN) and collision
 *     sets VF.
 *   - 16-key hex keypad, polled by EX9E/EXA1 and blockingly read by FX0A.
 *   - All 35 documented opcodes are implemented (see executeInstruction).
 *
 * The built-in ROM is a hand-written 48-byte "Bun Bouncer" that bounces a
 * small sprite off the four walls of the display forever. The program tests
 * almost every primitive needed by the rest of the instruction set: register
 * loads, ADD VX,VY (which wraps and updates VF), the SNE compare, sprite
 * draws with collision, the delay timer, and unconditional jumps. F2 toggles
 * the ROM to the famous public-domain IBM Logo program (also embedded inline
 * as a byte array), which uses the same DXYN sprite engine to draw "IBM".
 *
 * APIs demonstrated (User32):
 *   - RegisterClassExW / UnregisterClassW         (custom WndProc + class atom)
 *   - CreateWindowExW                             (borderless WS_POPUP host)
 *   - SetTimer / KillTimer                        (~60 Hz frame tick)
 *   - GetMessageW / TranslateMessage / DispatchMessageW
 *   - DefWindowProcW                              (fallthrough)
 *   - GetDC / ReleaseDC                           (per-frame device context)
 *   - BeginPaint / EndPaint                       (WM_PAINT handler)
 *   - ShowWindow / UpdateWindow / DestroyWindow / PostQuitMessage
 *   - GetSystemMetrics                            (screen centering)
 *
 * APIs demonstrated (GDI32):
 *   - SetDIBitsToDevice                           (blit the framebuffer)
 *
 * APIs demonstrated (Gdiplus):
 *   - GdiplusStartup / GdiplusShutdown            (engine lifecycle)
 *   - GdipCreateBitmapFromScan0                   (32bpp ARGB bitmap over Buffer)
 *   - GdipGetImageGraphicsContext                 (Graphics on the bitmap)
 *   - GdipSetSmoothingMode / GdipSetTextRenderingHint
 *   - GdipCreateSolidFill / GdipFillRectangle / GdipFillEllipse
 *   - GdipCreateFontFamilyFromName / GdipCreateFont / GdipCreateStringFormat
 *   - GdipSetStringFormatAlign / GdipSetStringFormatLineAlign / GdipDrawString
 *   - GdipDeleteBrush / GdipDeleteFont / GdipDeleteFontFamily / GdipDeleteStringFormat
 *   - GdipDeleteGraphics / GdipDisposeImage
 *
 * APIs demonstrated (Dwmapi):
 *   - DwmSetWindowAttribute with DWMWA_USE_IMMERSIVE_DARK_MODE
 *   - DwmSetWindowAttribute with DWMWA_SYSTEMBACKDROP_TYPE   (mica)
 *
 * APIs demonstrated (Kernel32):
 *   - GetModuleHandleW                            (hInstance for the class)
 *
 * APIs demonstrated (Xaudio2_9, all COM vtable except the bootstrap):
 *   - XAudio2Create                               (the flat xaudio2_9.dll export)
 *   - IXAudio2::CreateMasteringVoice              (default endpoint)
 *   - IXAudio2::CreateSourceVoice                 (16-bit mono PCM voice)
 *   - IXAudio2SourceVoice::SubmitSourceBuffer     (looping square-wave buffer)
 *   - IXAudio2SourceVoice::Start / Stop           (gated by the sound timer)
 *   - IXAudio2Voice::DestroyVoice                 (voice teardown)
 *   - IUnknown::Release                           (engine teardown)
 *
 * Keyboard:
 *
 *   CHIP-8 hex keypad      Physical keyboard
 *      1 2 3 C                1 2 3 4
 *      4 5 6 D                Q W E R
 *      7 8 9 E                A S D F
 *      A 0 B F                Z X C V
 *
 *   ESC = quit · SPACE = pause/resume · F1 = reset CPU · F2 = swap ROM
 *
 * Run: bun run example/chip8-bun.ts
 */

import { CFunction, FFIType, JSCallback, type Pointer, read } from 'bun:ffi';

import { Dwmapi, Gdiplus, GDI32, Kernel32, User32, Xaudio2_9 } from '../index';
import { ExtendedWindowStyles, ShowWindowCommand, SystemMetric, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { FontStyle, PixelFormat32bppPARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '@bun-win32/xaudio2_9';

// ─────────────────────────────────────────────────────────────────────────────
// Win32 message constants. None of these are exported as enums by user32 so we
// declare canonical values locally.
// ─────────────────────────────────────────────────────────────────────────────

const NULL_PTR = null as unknown as Pointer;

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_PAINT = 0x000f;
const WM_ERASEBKGND = 0x0014;
const WM_TIMER = 0x0113;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;

const VK_F1 = 0x70;
const VK_F2 = 0x71;

const FRAME_TIMER_ID = 1n;
const FRAME_INTERVAL_MS = 16; // ~60 Hz

const SRCCOPY = 0x00cc0020 as const;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;

void SRCCOPY; // kept for reference; SetDIBitsToDevice uses DIB_RGB_COLORS

// ─────────────────────────────────────────────────────────────────────────────
// CHIP-8 spec constants
// ─────────────────────────────────────────────────────────────────────────────

const CHIP8_DISPLAY_WIDTH = 64;
const CHIP8_DISPLAY_HEIGHT = 32;
const CHIP8_MEMORY_SIZE = 4096;
const CHIP8_REGISTER_COUNT = 16;
const CHIP8_STACK_DEPTH = 16;
const CHIP8_PROGRAM_START = 0x200;
const CHIP8_FONT_START = 0x000;
const CHIP8_CYCLES_PER_FRAME = 11; // ≈ 660 Hz at 60 fps
const CHIP8_TIMER_HZ = 60;

// 16 × 5-byte hex font, copied into RAM at 0x000-0x04F at boot. FX29 returns
// the address of the row for the digit in VX, used by ROMs to render scores.
const CHIP8_FONT_SET = new Uint8Array([
  0xf0, 0x90, 0x90, 0x90, 0xf0, // 0
  0x20, 0x60, 0x20, 0x20, 0x70, // 1
  0xf0, 0x10, 0xf0, 0x80, 0xf0, // 2
  0xf0, 0x10, 0xf0, 0x10, 0xf0, // 3
  0x90, 0x90, 0xf0, 0x10, 0x10, // 4
  0xf0, 0x80, 0xf0, 0x10, 0xf0, // 5
  0xf0, 0x80, 0xf0, 0x90, 0xf0, // 6
  0xf0, 0x10, 0x20, 0x40, 0x40, // 7
  0xf0, 0x90, 0xf0, 0x90, 0xf0, // 8
  0xf0, 0x90, 0xf0, 0x10, 0xf0, // 9
  0xf0, 0x90, 0xf0, 0x90, 0x90, // A
  0xe0, 0x90, 0xe0, 0x90, 0xe0, // B
  0xf0, 0x80, 0x80, 0x80, 0xf0, // C
  0xe0, 0x90, 0x90, 0x90, 0xe0, // D
  0xf0, 0x80, 0xf0, 0x80, 0xf0, // E
  0xf0, 0x80, 0xf0, 0x80, 0x80, // F
]);

// ─────────────────────────────────────────────────────────────────────────────
// Built-in ROM #1: "Bun Bouncer" — hand-written 48-byte bouncing-ball demo.
//
// Layout (every instruction is 2 bytes, big-endian; addresses are absolute):
//
//   0x200  60 20     LD V0, 32     ; ball X starts at the centre
//   0x202  61 10     LD V1, 16     ; ball Y starts at the centre
//   0x204  62 01     LD V2, 1      ; dx = +1
//   0x206  63 01     LD V3, 1      ; dy = +1
//   0x208  A2 2E     LD I, 0x22E   ; I -> 2-byte sprite at the program tail
//
//   0x20A  D0 12     DRW V0,V1,2   ; XOR-erase the old ball
//   0x20C  80 24     ADD V0,V2     ; X += dx (8-bit wrap)
//   0x20E  81 34     ADD V1,V3     ; Y += dy
//   0x210  40 38     SNE V0,56     ; if V0 == 56 (right edge), run next
//   0x212  62 FF     LD V2, 0xFF   ;   dx = -1
//   0x214  40 00     SNE V0,0      ; if V0 == 0 (left edge), run next
//   0x216  62 01     LD V2, 1      ;   dx = +1
//   0x218  41 1E     SNE V1,30     ; if V1 == 30 (bottom), run next
//   0x21A  63 FF     LD V3, 0xFF   ;   dy = -1
//   0x21C  41 00     SNE V1,0      ; if V1 == 0 (top), run next
//   0x21E  63 01     LD V3, 1      ;   dy = +1
//   0x220  D0 12     DRW V0,V1,2   ; XOR-draw the ball at the new position
//   0x222  66 04     LD V6, 4      ; delay = 4 → ~67 ms per step
//   0x224  F6 15     LD DT, V6     ; arm the delay timer
//   0x226  F6 07     LD V6, DT     ; sample DT
//   0x228  36 00     SE V6, 0      ; if V6 == 0, skip the wait jump
//   0x22A  12 26     JP 0x226      ;   else keep sampling
//   0x22C  12 0A     JP 0x20A      ; back to the top of the loop
//   0x22E  7E 7E     ; 2-row sprite: 01111110 / 01111110
// ─────────────────────────────────────────────────────────────────────────────
const BUN_BOUNCER_ROM = new Uint8Array([
  0x60, 0x20, 0x61, 0x10, 0x62, 0x01, 0x63, 0x01, 0xa2, 0x2e, 0xd0, 0x12, 0x80, 0x24, 0x81, 0x34, 0x40, 0x38, 0x62, 0xff, 0x40, 0x00, 0x62, 0x01, 0x41, 0x1e, 0x63, 0xff, 0x41, 0x00, 0x63, 0x01, 0xd0, 0x12, 0x66, 0x04, 0xf6, 0x15, 0xf6, 0x07, 0x36, 0x00, 0x12, 0x26, 0x12, 0x0a, 0x7e, 0x7e,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Built-in ROM #2: the public-domain IBM Logo, the canonical "hello world" of
// CHIP-8 ROMs. 132 bytes. Draws "IBM" in the upper-left corner then loops on
// 0x228 forever. Author unknown; circulated freely since the 1990s.
// ─────────────────────────────────────────────────────────────────────────────
const IBM_LOGO_ROM = new Uint8Array([
  0x00, 0xe0, 0xa2, 0x2a, 0x60, 0x0c, 0x61, 0x08, 0xd0, 0x1f, 0x70, 0x09, 0xa2, 0x39, 0xd0, 0x1f, 0xa2, 0x48, 0x70, 0x08, 0xd0, 0x1f, 0x70, 0x04, 0xa2, 0x57, 0xd0, 0x1f, 0x70, 0x08, 0xa2, 0x66, 0xd0, 0x1f, 0x70, 0x08, 0xa2, 0x75, 0xd0, 0x1f, 0x12, 0x28, 0xff, 0x00, 0xff, 0x00, 0x3c, 0x00, 0x3c, 0x00, 0x3c, 0x00, 0x3c, 0x00, 0xff, 0x00, 0xff, 0xff, 0x00, 0xff, 0x00, 0x38, 0x00, 0x3f, 0x00, 0x3f, 0x00, 0x38, 0x00, 0xff, 0x00, 0xff, 0x80, 0x00, 0xe0, 0x00, 0xe0, 0x00, 0x80, 0x00, 0x80, 0x00, 0xe0, 0x00, 0xe0, 0x00, 0x80, 0xf8, 0x00, 0xfc, 0x00, 0x3e, 0x00, 0x3f, 0x00, 0x3b, 0x00, 0x39, 0x00, 0xf8, 0x00, 0xf8, 0x03, 0x00, 0x07, 0x00, 0x0f, 0x00, 0xbf, 0x00, 0xfb, 0x00, 0xf3, 0x00, 0xe3, 0x00, 0x43, 0xe0, 0x00, 0xe0, 0x00, 0x80, 0x00, 0x80, 0x00, 0x80, 0x00, 0x80, 0x00, 0xe0, 0x00, 0xe0,
]);

interface Chip8Rom {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const ROMS: readonly Chip8Rom[] = [
  { name: 'Bun Bouncer (hand-written)', bytes: BUN_BOUNCER_ROM },
  { name: 'IBM Logo (1977, public domain)', bytes: IBM_LOGO_ROM },
];

// ─────────────────────────────────────────────────────────────────────────────
// CHIP-8 virtual machine state
// ─────────────────────────────────────────────────────────────────────────────

interface Chip8State {
  memory: Uint8Array;
  registers: Uint8Array; // V0..VF
  index: number; // I (12-bit really, stored in number)
  programCounter: number;
  stack: Uint16Array;
  stackPointer: number;
  delayTimer: number;
  soundTimer: number;
  display: Uint8Array; // 64*32 bytes; 0 or 1
  keypad: Uint8Array; // 16 bytes; 0 or 1
  waitingForKey: boolean;
  waitingKeyRegister: number;
  halted: boolean;
  haltReason: string;
  instructionCount: number;
  lastOpcode: number;
}

function createChip8(): Chip8State {
  const state: Chip8State = {
    memory: new Uint8Array(CHIP8_MEMORY_SIZE),
    registers: new Uint8Array(CHIP8_REGISTER_COUNT),
    index: 0,
    programCounter: CHIP8_PROGRAM_START,
    stack: new Uint16Array(CHIP8_STACK_DEPTH),
    stackPointer: 0,
    delayTimer: 0,
    soundTimer: 0,
    display: new Uint8Array(CHIP8_DISPLAY_WIDTH * CHIP8_DISPLAY_HEIGHT),
    keypad: new Uint8Array(16),
    waitingForKey: false,
    waitingKeyRegister: 0,
    halted: false,
    haltReason: '',
    instructionCount: 0,
    lastOpcode: 0,
  };
  state.memory.set(CHIP8_FONT_SET, CHIP8_FONT_START);
  return state;
}

function loadRom(state: Chip8State, rom: Uint8Array): void {
  state.memory.fill(0);
  state.memory.set(CHIP8_FONT_SET, CHIP8_FONT_START);
  state.memory.set(rom, CHIP8_PROGRAM_START);
  state.registers.fill(0);
  state.index = 0;
  state.programCounter = CHIP8_PROGRAM_START;
  state.stack.fill(0);
  state.stackPointer = 0;
  state.delayTimer = 0;
  state.soundTimer = 0;
  state.display.fill(0);
  state.waitingForKey = false;
  state.waitingKeyRegister = 0;
  state.halted = false;
  state.haltReason = '';
  state.instructionCount = 0;
  state.lastOpcode = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHIP-8 instruction decoder + executor — all 35 documented opcodes.
//
// CHIP-8 opcodes are 16-bit, big-endian. We decode the four nibbles up front
// and dispatch on the most significant. The instruction set is small enough
// that a switch on the top nibble + sub-switch on the remaining nibbles
// covers every documented case.
// ─────────────────────────────────────────────────────────────────────────────

function executeInstruction(state: Chip8State): void {
  if (state.halted) return;
  if (state.waitingForKey) {
    // FX0A: scan for the first key pressed; latch into VX and resume.
    for (let key = 0; key < 16; key += 1) {
      if (state.keypad[key] === 1) {
        state.registers[state.waitingKeyRegister] = key;
        state.waitingForKey = false;
        break;
      }
    }
    if (state.waitingForKey) return;
  }

  const programCounter = state.programCounter;
  if (programCounter + 1 >= CHIP8_MEMORY_SIZE) {
    state.halted = true;
    state.haltReason = `PC out of bounds: 0x${programCounter.toString(16)}`;
    return;
  }
  const opcodeHigh = state.memory[programCounter]!;
  const opcodeLow = state.memory[programCounter + 1]!;
  const opcode = (opcodeHigh << 8) | opcodeLow;
  state.lastOpcode = opcode;
  state.programCounter = (programCounter + 2) & 0x0fff;

  const topNibble = (opcode & 0xf000) >> 12;
  const x = (opcode & 0x0f00) >> 8;
  const y = (opcode & 0x00f0) >> 4;
  const n = opcode & 0x000f;
  const nn = opcode & 0x00ff;
  const nnn = opcode & 0x0fff;
  const v = state.registers;

  switch (topNibble) {
    case 0x0:
      if (opcode === 0x00e0) {
        // CLS — clear the display.
        state.display.fill(0);
      } else if (opcode === 0x00ee) {
        // RET — pop the return address off the stack.
        if (state.stackPointer === 0) {
          state.halted = true;
          state.haltReason = 'RET with empty stack';
          return;
        }
        state.stackPointer -= 1;
        state.programCounter = state.stack[state.stackPointer]! & 0x0fff;
      }
      // 0NNN (SYS NNN) is ignored on modern interpreters by convention.
      break;

    case 0x1:
      // 1NNN — JP NNN.
      state.programCounter = nnn;
      break;

    case 0x2:
      // 2NNN — CALL NNN.
      if (state.stackPointer >= CHIP8_STACK_DEPTH) {
        state.halted = true;
        state.haltReason = 'Stack overflow';
        return;
      }
      state.stack[state.stackPointer] = state.programCounter;
      state.stackPointer += 1;
      state.programCounter = nnn;
      break;

    case 0x3:
      // 3XNN — SE VX, NN (skip if equal).
      if (v[x] === nn) state.programCounter = (state.programCounter + 2) & 0x0fff;
      break;

    case 0x4:
      // 4XNN — SNE VX, NN (skip if not equal).
      if (v[x] !== nn) state.programCounter = (state.programCounter + 2) & 0x0fff;
      break;

    case 0x5:
      // 5XY0 — SE VX, VY.
      if (n === 0 && v[x] === v[y]) state.programCounter = (state.programCounter + 2) & 0x0fff;
      break;

    case 0x6:
      // 6XNN — LD VX, NN.
      v[x] = nn;
      break;

    case 0x7:
      // 7XNN — ADD VX, NN (no carry flag).
      v[x] = (v[x]! + nn) & 0xff;
      break;

    case 0x8: {
      // 8XY? — register arithmetic.
      const vx = v[x]!;
      const vy = v[y]!;
      switch (n) {
        case 0x0:
          v[x] = vy;
          break;
        case 0x1:
          v[x] = vx | vy;
          break;
        case 0x2:
          v[x] = vx & vy;
          break;
        case 0x3:
          v[x] = vx ^ vy;
          break;
        case 0x4: {
          const sum = vx + vy;
          v[x] = sum & 0xff;
          v[0xf] = sum > 0xff ? 1 : 0;
          break;
        }
        case 0x5:
          v[x] = (vx - vy) & 0xff;
          v[0xf] = vx >= vy ? 1 : 0;
          break;
        case 0x6:
          // Classic COSMAC behaviour shifts VY into VX; modern interpreters
          // (Octo, most emulators) shift VX in place. We follow the modern
          // convention because the Bun Bouncer doesn't depend on either and
          // the IBM Logo doesn't use SHR.
          v[x] = vx >> 1;
          v[0xf] = vx & 0x1;
          break;
        case 0x7:
          v[x] = (vy - vx) & 0xff;
          v[0xf] = vy >= vx ? 1 : 0;
          break;
        case 0xe:
          v[x] = (vx << 1) & 0xff;
          v[0xf] = (vx & 0x80) >> 7;
          break;
        default:
          // Undefined 8XY? — silently no-op so unusual ROMs still run.
          break;
      }
      break;
    }

    case 0x9:
      // 9XY0 — SNE VX, VY.
      if (n === 0 && v[x] !== v[y]) state.programCounter = (state.programCounter + 2) & 0x0fff;
      break;

    case 0xa:
      // ANNN — LD I, NNN.
      state.index = nnn;
      break;

    case 0xb:
      // BNNN — JP V0, NNN.
      state.programCounter = (nnn + v[0]!) & 0x0fff;
      break;

    case 0xc:
      // CXNN — RND VX, NN.
      v[x] = Math.floor(Math.random() * 256) & nn;
      break;

    case 0xd: {
      // DXYN — DRW VX, VY, N — XOR-blit an N-row, 8-column sprite from RAM[I]
      // onto the display starting at (VX, VY), wrapping at the edges. VF is
      // set to 1 if any on-pixel is turned off (a sprite collision).
      const startX = v[x]! % CHIP8_DISPLAY_WIDTH;
      const startY = v[y]! % CHIP8_DISPLAY_HEIGHT;
      v[0xf] = 0;
      for (let row = 0; row < n; row += 1) {
        const rowAddress = (state.index + row) & 0x0fff;
        const spriteByte = state.memory[rowAddress]!;
        const py = (startY + row) % CHIP8_DISPLAY_HEIGHT;
        for (let column = 0; column < 8; column += 1) {
          const spritePixel = (spriteByte >> (7 - column)) & 1;
          if (!spritePixel) continue;
          const px = (startX + column) % CHIP8_DISPLAY_WIDTH;
          const displayIndex = py * CHIP8_DISPLAY_WIDTH + px;
          if (state.display[displayIndex] === 1) v[0xf] = 1;
          state.display[displayIndex] ^= 1;
        }
      }
      break;
    }

    case 0xe:
      // EX9E / EXA1 — skip on key state.
      if (nn === 0x9e) {
        if (state.keypad[v[x]! & 0xf]! === 1) state.programCounter = (state.programCounter + 2) & 0x0fff;
      } else if (nn === 0xa1) {
        if (state.keypad[v[x]! & 0xf]! === 0) state.programCounter = (state.programCounter + 2) & 0x0fff;
      }
      break;

    case 0xf:
      switch (nn) {
        case 0x07:
          // FX07 — LD VX, DT.
          v[x] = state.delayTimer;
          break;
        case 0x0a:
          // FX0A — LD VX, K — block until any key is pressed.
          state.waitingForKey = true;
          state.waitingKeyRegister = x;
          break;
        case 0x15:
          state.delayTimer = v[x]!;
          break;
        case 0x18:
          state.soundTimer = v[x]!;
          break;
        case 0x1e:
          state.index = (state.index + v[x]!) & 0x0fff;
          break;
        case 0x29:
          // FX29 — LD F, VX — point I at the 5-byte font sprite for digit VX.
          state.index = (CHIP8_FONT_START + (v[x]! & 0xf) * 5) & 0x0fff;
          break;
        case 0x33: {
          // FX33 — LD B, VX — store the BCD of VX at I, I+1, I+2.
          const value = v[x]!;
          state.memory[state.index & 0x0fff] = Math.floor(value / 100);
          state.memory[(state.index + 1) & 0x0fff] = Math.floor((value % 100) / 10);
          state.memory[(state.index + 2) & 0x0fff] = value % 10;
          break;
        }
        case 0x55:
          // FX55 — LD [I], VX — store V0..VX into memory starting at I.
          for (let registerIndex = 0; registerIndex <= x; registerIndex += 1) {
            state.memory[(state.index + registerIndex) & 0x0fff] = v[registerIndex]!;
          }
          break;
        case 0x65:
          // FX65 — LD VX, [I] — load V0..VX from memory starting at I.
          for (let registerIndex = 0; registerIndex <= x; registerIndex += 1) {
            v[registerIndex] = state.memory[(state.index + registerIndex) & 0x0fff]!;
          }
          break;
        default:
          break;
      }
      break;

    default:
      // Unreachable — every top nibble 0x0..0xf is handled above.
      break;
  }

  state.instructionCount += 1;
}

function tickTimers(state: Chip8State): void {
  if (state.delayTimer > 0) state.delayTimer -= 1;
  if (state.soundTimer > 0) state.soundTimer -= 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Window + scaling constants
// ─────────────────────────────────────────────────────────────────────────────

const PIXEL_SCALE = 10;
const BEZEL_LEFT = 28;
const BEZEL_TOP = 28;
const BEZEL_RIGHT = 28;
const HUD_HEIGHT = 280;
const DISPLAY_PIXEL_WIDTH = CHIP8_DISPLAY_WIDTH * PIXEL_SCALE;   // 640
const DISPLAY_PIXEL_HEIGHT = CHIP8_DISPLAY_HEIGHT * PIXEL_SCALE; // 320

const WINDOW_WIDTH = BEZEL_LEFT + DISPLAY_PIXEL_WIDTH + BEZEL_RIGHT;     // 696
const WINDOW_HEIGHT = BEZEL_TOP + DISPLAY_PIXEL_HEIGHT + HUD_HEIGHT;     // 628

const encodeUtf16 = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');
const argb = (a: number, r: number, g: number, b: number): number => (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;

// ─────────────────────────────────────────────────────────────────────────────
// Gdiplus engine + framebuffer
// ─────────────────────────────────────────────────────────────────────────────

Gdiplus.Preload();

const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
if (Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr, gdiplusStartupInput.ptr, null) !== Status.Ok) {
  throw new Error('GdiplusStartup failed');
}
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

// 32-bit ARGB framebuffer, owned by us. GDI+ paints into it; we hand the same
// memory directly to GDI's SetDIBitsToDevice every frame.
const stride = WINDOW_WIDTH * 4;
const framebuffer = Buffer.alloc(stride * WINDOW_HEIGHT);

const bitmapHandleBuffer = Buffer.alloc(8);
if (
  Gdiplus.GdipCreateBitmapFromScan0(
    WINDOW_WIDTH,
    WINDOW_HEIGHT,
    stride,
    PixelFormat32bppPARGB,
    framebuffer.ptr,
    bitmapHandleBuffer.ptr,
  ) !== Status.Ok
) {
  throw new Error('GdipCreateBitmapFromScan0 failed');
}
const framebufferBitmap = bitmapHandleBuffer.readBigUInt64LE(0);

const graphicsHandleBuffer = Buffer.alloc(8);
if (Gdiplus.GdipGetImageGraphicsContext(framebufferBitmap, graphicsHandleBuffer.ptr) !== Status.Ok) {
  throw new Error('GdipGetImageGraphicsContext failed');
}
const graphics = graphicsHandleBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetSmoothingMode(graphics, SmoothingMode.SmoothingModeAntiAlias);
Gdiplus.GdipSetTextRenderingHint(graphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit);

// BITMAPINFOHEADER: negative biHeight → top-down DIB so our rows match the
// GDI+ coordinate system.
const bitmapInfoBuffer = Buffer.alloc(40);
bitmapInfoBuffer.writeUInt32LE(40, 0);
bitmapInfoBuffer.writeInt32LE(WINDOW_WIDTH, 4);
bitmapInfoBuffer.writeInt32LE(-WINDOW_HEIGHT, 8);
bitmapInfoBuffer.writeUInt16LE(1, 12);
bitmapInfoBuffer.writeUInt16LE(32, 14);
bitmapInfoBuffer.writeUInt32LE(BI_RGB, 16);
bitmapInfoBuffer.writeUInt32LE(0, 20);

// ─────────────────────────────────────────────────────────────────────────────
// A small toolkit of cached GDI+ resources.
// ─────────────────────────────────────────────────────────────────────────────

function makeSolidBrush(color: number): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, out.ptr);
  return out.readBigUInt64LE(0);
}

function makeFontFamily(name: string): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreateFontFamilyFromName(encodeUtf16(name).ptr, 0n, out.ptr);
  return out.readBigUInt64LE(0);
}

function makeFont(family: bigint, size: number, style: FontStyle): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreateFont(family, size, style, Unit.UnitPixel, out.ptr);
  return out.readBigUInt64LE(0);
}

function makeStringFormat(horizontal: StringAlignment, vertical: StringAlignment): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreateStringFormat(0, 0, out.ptr);
  const format = out.readBigUInt64LE(0);
  Gdiplus.GdipSetStringFormatAlign(format, horizontal);
  Gdiplus.GdipSetStringFormatLineAlign(format, vertical);
  return format;
}

const fontFamilyUi = makeFontFamily('Segoe UI');
const fontFamilyMono = makeFontFamily('Consolas');
const fontTitle = makeFont(fontFamilyUi, 16, FontStyle.FontStyleBold);
const fontHeader = makeFont(fontFamilyUi, 11, FontStyle.FontStyleBold);
const fontMono = makeFont(fontFamilyMono, 12, FontStyle.FontStyleRegular);
const fontMonoBold = makeFont(fontFamilyMono, 13, FontStyle.FontStyleBold);
const fontSmall = makeFont(fontFamilyUi, 10, FontStyle.FontStyleRegular);

const formatNearNear = makeStringFormat(StringAlignment.StringAlignmentNear, StringAlignment.StringAlignmentNear);
const formatCenterCenter = makeStringFormat(StringAlignment.StringAlignmentCenter, StringAlignment.StringAlignmentCenter);
const formatFarNear = makeStringFormat(StringAlignment.StringAlignmentFar, StringAlignment.StringAlignmentNear);

// Phosphor palette. CHIP-8 was a vector-display memory; on the COSMAC VIP it
// was just a black framebuffer with white pixels — but every emulator since
// the 80s has used a warm amber tint to evoke the era, so we do too.
const COLOR_BACKDROP = argb(255, 0x0a, 0x0c, 0x14);
const COLOR_DISPLAY_BG = argb(255, 0x14, 0x18, 0x22);
const COLOR_PIXEL_OFF = argb(255, 0x1c, 0x21, 0x2c);
const COLOR_PIXEL_GLOW = argb(80, 0xff, 0xb0, 0x40);
const COLOR_PIXEL_ON = argb(255, 0xff, 0xc8, 0x6e);
const COLOR_BEZEL = argb(255, 0x18, 0x1c, 0x26);
const COLOR_HUD_PANEL = argb(220, 0x1c, 0x20, 0x2e);
const COLOR_HUD_BORDER = argb(255, 0x44, 0x4c, 0x66);
const COLOR_TEXT = argb(255, 0xee, 0xee, 0xff);
const COLOR_TEXT_DIM = argb(220, 0xa8, 0xb0, 0xc8);
const COLOR_TEXT_ACCENT = argb(255, 0xff, 0xc8, 0x6e);
const COLOR_KEY_OFF = argb(255, 0x2a, 0x30, 0x42);
const COLOR_KEY_ON = argb(255, 0x9b, 0xa6, 0xff);
const COLOR_REG_BG = argb(255, 0x22, 0x27, 0x36);
const COLOR_BEEP_OFF = argb(180, 0x55, 0x5b, 0x70);
const COLOR_BEEP_ON = argb(255, 0xff, 0x5b, 0x6e);
const COLOR_PAUSE_BG = argb(180, 0x00, 0x00, 0x00);

const brushBackdrop = makeSolidBrush(COLOR_BACKDROP);
const brushDisplayBg = makeSolidBrush(COLOR_DISPLAY_BG);
const brushPixelOff = makeSolidBrush(COLOR_PIXEL_OFF);
const brushPixelGlow = makeSolidBrush(COLOR_PIXEL_GLOW);
const brushPixelOn = makeSolidBrush(COLOR_PIXEL_ON);
const brushBezel = makeSolidBrush(COLOR_BEZEL);
const brushHudPanel = makeSolidBrush(COLOR_HUD_PANEL);
const brushHudBorder = makeSolidBrush(COLOR_HUD_BORDER);
const brushText = makeSolidBrush(COLOR_TEXT);
const brushTextDim = makeSolidBrush(COLOR_TEXT_DIM);
const brushTextAccent = makeSolidBrush(COLOR_TEXT_ACCENT);
const brushKeyOff = makeSolidBrush(COLOR_KEY_OFF);
const brushKeyOn = makeSolidBrush(COLOR_KEY_ON);
const brushRegBg = makeSolidBrush(COLOR_REG_BG);
const brushBeepOff = makeSolidBrush(COLOR_BEEP_OFF);
const brushBeepOn = makeSolidBrush(COLOR_BEEP_ON);
const brushPauseBg = makeSolidBrush(COLOR_PAUSE_BG);

const tempRectBuffer = Buffer.alloc(16);

function drawText(
  text: string,
  font: bigint,
  brush: bigint,
  layoutX: number,
  layoutY: number,
  layoutWidth: number,
  layoutHeight: number,
  format: bigint,
): void {
  tempRectBuffer.writeFloatLE(layoutX, 0);
  tempRectBuffer.writeFloatLE(layoutY, 4);
  tempRectBuffer.writeFloatLE(layoutWidth, 8);
  tempRectBuffer.writeFloatLE(layoutHeight, 12);
  const encoded = encodeUtf16(text);
  Gdiplus.GdipDrawString(graphics, encoded.ptr, -1, font, tempRectBuffer.ptr, format, brush);
}

// ─────────────────────────────────────────────────────────────────────────────
// XAudio2 beeper. We synthesize a 100 ms square wave at ~440 Hz once at boot,
// queue it on a source voice with XAUDIO2_LOOP_INFINITE, and toggle Start/Stop
// based on whether the CHIP-8 sound timer is non-zero this frame. Volume is
// not modulated — the beeper is either on or off — which matches the COSMAC
// VIP behaviour exactly.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 44_100;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS = 16;
const AUDIO_BLOCK_ALIGN = (AUDIO_CHANNELS * AUDIO_BITS) / 8;
const BEEP_FREQUENCY = 440;
const BEEP_AMPLITUDE = 0.20; // gentle — runs in a loop forever

const beepSamples = SAMPLE_RATE / 10; // 100 ms loop
const beepPcm = Buffer.alloc(beepSamples * AUDIO_BLOCK_ALIGN);
for (let sampleIndex = 0; sampleIndex < beepSamples; sampleIndex += 1) {
  const phase = (sampleIndex * BEEP_FREQUENCY) / SAMPLE_RATE;
  const value = phase - Math.floor(phase) < 0.5 ? BEEP_AMPLITUDE : -BEEP_AMPLITUDE;
  beepPcm.writeInt16LE(Math.round(value * 32_000), sampleIndex * AUDIO_BLOCK_ALIGN);
}

const xaudioInvokers = new Map<string, ReturnType<typeof CFunction>>();

function vcall(thisPointer: bigint, slot: number, argTypes: readonly FFIType[], args: readonly unknown[], returns: FFIType = FFIType.i32): number {
  const vtable = read.u64(Number(thisPointer) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const key = `${method}|${returns}|${argTypes.join(',')}`;
  let invoke = xaudioInvokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({ ptr: Number(method) as Pointer, args: [FFIType.u64, ...argTypes], returns });
    xaudioInvokers.set(key, invoke);
  }
  return invoke(thisPointer, ...args);
}

const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATESOURCEVOICE = 5;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;
const IXAUDIO2VOICE_DESTROYVOICE = 18;
const IXAUDIO2SOURCEVOICE_START = 19;
const IXAUDIO2SOURCEVOICE_STOP = 20;
const IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER = 21;
const AudioCategory_GameEffects = 6;
const XAUDIO2_LOOP_INFINITE = 0xff;

const ppEngineBuffer = Buffer.alloc(8);
let xaudioEngine = 0n;
let xaudioMaster = 0n;
let xaudioSource = 0n;
let xaudioAvailable = false;
let beeperActive = false;

if (Xaudio2_9.XAudio2Create(ppEngineBuffer.ptr, 0, XAUDIO2_USE_DEFAULT_PROCESSOR) === S_OK) {
  xaudioEngine = ppEngineBuffer.readBigUInt64LE(0);

  const ppMasterBuffer = Buffer.alloc(8);
  if (
    vcall(
      xaudioEngine,
      IXAUDIO2_CREATEMASTERINGVOICE,
      [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32],
      [ppMasterBuffer.ptr, 0, 0, 0, null, null, AudioCategory_GameEffects],
    ) === S_OK
  ) {
    xaudioMaster = ppMasterBuffer.readBigUInt64LE(0);

    const waveFormatBuffer = Buffer.alloc(18);
    waveFormatBuffer.writeUInt16LE(1, 0);
    waveFormatBuffer.writeUInt16LE(AUDIO_CHANNELS, 2);
    waveFormatBuffer.writeUInt32LE(SAMPLE_RATE, 4);
    waveFormatBuffer.writeUInt32LE(SAMPLE_RATE * AUDIO_BLOCK_ALIGN, 8);
    waveFormatBuffer.writeUInt16LE(AUDIO_BLOCK_ALIGN, 12);
    waveFormatBuffer.writeUInt16LE(AUDIO_BITS, 14);
    waveFormatBuffer.writeUInt16LE(0, 16);

    const ppSourceBuffer = Buffer.alloc(8);
    if (
      vcall(
        xaudioEngine,
        IXAUDIO2_CREATESOURCEVOICE,
        [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        [ppSourceBuffer.ptr, waveFormatBuffer.ptr, 0, 2.0, null, null, null],
      ) === S_OK
    ) {
      xaudioSource = ppSourceBuffer.readBigUInt64LE(0);

      // XAUDIO2_BUFFER (48 bytes): Flags, AudioBytes, pAudioData@8, PlayBegin,
      // PlayLength, LoopBegin, LoopLength, LoopCount, pContext@40.
      const xaudioBuffer = Buffer.alloc(48);
      xaudioBuffer.writeUInt32LE(0, 0);
      xaudioBuffer.writeUInt32LE(beepPcm.length, 4);
      xaudioBuffer.writeBigUInt64LE(BigInt(beepPcm.ptr!), 8);
      xaudioBuffer.writeUInt32LE(0, 16);
      xaudioBuffer.writeUInt32LE(0, 20);
      xaudioBuffer.writeUInt32LE(0, 24);
      xaudioBuffer.writeUInt32LE(0, 28);
      xaudioBuffer.writeUInt32LE(XAUDIO2_LOOP_INFINITE, 32);
      xaudioBuffer.writeBigUInt64LE(0n, 40);

      if (
        vcall(
          xaudioSource,
          IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER,
          [FFIType.ptr, FFIType.ptr],
          [xaudioBuffer.ptr, null],
        ) === S_OK
      ) {
        xaudioAvailable = true;
      }
    }
  }
}

function setBeeperActive(shouldBeep: boolean): void {
  if (!xaudioAvailable) return;
  if (shouldBeep === beeperActive) return;
  if (shouldBeep) {
    vcall(xaudioSource, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]);
  } else {
    vcall(xaudioSource, IXAUDIO2SOURCEVOICE_STOP, [FFIType.u32, FFIType.u32], [0, 0]);
  }
  beeperActive = shouldBeep;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard mapping. CHIP-8 has a 4×4 hex keypad. We map it onto the physical
// 1234 / QWER / ASDF / ZXCV block so it's playable on any modern keyboard.
// ─────────────────────────────────────────────────────────────────────────────

const KEY_MAP: ReadonlyMap<number, number> = new Map<number, number>([
  ['1'.charCodeAt(0), 0x1],
  ['2'.charCodeAt(0), 0x2],
  ['3'.charCodeAt(0), 0x3],
  ['4'.charCodeAt(0), 0xc],
  ['Q'.charCodeAt(0), 0x4],
  ['W'.charCodeAt(0), 0x5],
  ['E'.charCodeAt(0), 0x6],
  ['R'.charCodeAt(0), 0xd],
  ['A'.charCodeAt(0), 0x7],
  ['S'.charCodeAt(0), 0x8],
  ['D'.charCodeAt(0), 0x9],
  ['F'.charCodeAt(0), 0xe],
  ['Z'.charCodeAt(0), 0xa],
  ['X'.charCodeAt(0), 0x0],
  ['C'.charCodeAt(0), 0xb],
  ['V'.charCodeAt(0), 0xf],
]);

const KEY_LABELS: ReadonlyArray<{ readonly hex: number; readonly physical: string }> = [
  { hex: 0x1, physical: '1' },
  { hex: 0x2, physical: '2' },
  { hex: 0x3, physical: '3' },
  { hex: 0xc, physical: '4' },
  { hex: 0x4, physical: 'Q' },
  { hex: 0x5, physical: 'W' },
  { hex: 0x6, physical: 'E' },
  { hex: 0xd, physical: 'R' },
  { hex: 0x7, physical: 'A' },
  { hex: 0x8, physical: 'S' },
  { hex: 0x9, physical: 'D' },
  { hex: 0xe, physical: 'F' },
  { hex: 0xa, physical: 'Z' },
  { hex: 0x0, physical: 'X' },
  { hex: 0xb, physical: 'C' },
  { hex: 0xf, physical: 'V' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Emulator state
// ─────────────────────────────────────────────────────────────────────────────

const chip8 = createChip8();
let activeRomIndex = 0;
let paused = false;
let resetRequested = false;
let swapRomRequested = false;
let timerSubFrameAccumulator = 0;

function applyRom(index: number): void {
  activeRomIndex = index;
  const rom = ROMS[index]!;
  loadRom(chip8, rom.bytes);
}

applyRom(0);

// ─────────────────────────────────────────────────────────────────────────────
// Renderer — paints the bezel, the 64×32 phosphor display, and the HUD panel
// every frame straight into the framebuffer.
// ─────────────────────────────────────────────────────────────────────────────

function renderFrame(): void {
  // 1) Full backdrop wipe.
  Gdiplus.GdipFillRectangle(graphics, brushBackdrop, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);

  // 2) Display bezel.
  Gdiplus.GdipFillRectangle(graphics, brushBezel, 0, 0, WINDOW_WIDTH, BEZEL_TOP + DISPLAY_PIXEL_HEIGHT + 8);
  Gdiplus.GdipFillRectangle(graphics, brushDisplayBg, BEZEL_LEFT, BEZEL_TOP, DISPLAY_PIXEL_WIDTH, DISPLAY_PIXEL_HEIGHT);

  // 3) 64×32 phosphor pixels with a soft 1-pixel halo for on-pixels.
  for (let py = 0; py < CHIP8_DISPLAY_HEIGHT; py += 1) {
    for (let px = 0; px < CHIP8_DISPLAY_WIDTH; px += 1) {
      const pixel = chip8.display[py * CHIP8_DISPLAY_WIDTH + px]!;
      const screenX = BEZEL_LEFT + px * PIXEL_SCALE;
      const screenY = BEZEL_TOP + py * PIXEL_SCALE;
      if (pixel === 1) {
        // Halo behind the lit cell.
        Gdiplus.GdipFillRectangle(graphics, brushPixelGlow, screenX - 1, screenY - 1, PIXEL_SCALE + 2, PIXEL_SCALE + 2);
        Gdiplus.GdipFillRectangle(graphics, brushPixelOn, screenX + 1, screenY + 1, PIXEL_SCALE - 2, PIXEL_SCALE - 2);
      } else {
        // A subtle off-pixel grid keeps the display from looking like an empty void.
        Gdiplus.GdipFillRectangle(graphics, brushPixelOff, screenX + 3, screenY + 3, PIXEL_SCALE - 6, PIXEL_SCALE - 6);
      }
    }
  }

  // 4) HUD panel — the diagnostics live below the display.
  const hudTop = BEZEL_TOP + DISPLAY_PIXEL_HEIGHT + 16;
  Gdiplus.GdipFillRectangle(graphics, brushHudPanel, 16, hudTop, WINDOW_WIDTH - 32, HUD_HEIGHT - 32);
  Gdiplus.GdipFillRectangle(graphics, brushHudBorder, 16, hudTop, WINDOW_WIDTH - 32, 1);
  Gdiplus.GdipFillRectangle(graphics, brushHudBorder, 16, hudTop + HUD_HEIGHT - 33, WINDOW_WIDTH - 32, 1);

  // Title strip.
  drawText('CHIP-8 · Bun + Win32 FFI', fontTitle, brushText, 28, hudTop + 8, 400, 22, formatNearNear);
  drawText(ROMS[activeRomIndex]!.name, fontSmall, brushTextAccent, 28, hudTop + 32, 400, 14, formatNearNear);
  drawText('ESC quit  ·  SPACE pause  ·  F1 reset  ·  F2 swap ROM', fontSmall, brushTextDim, WINDOW_WIDTH - 28 - 380, hudTop + 8, 380, 14, formatFarNear);
  drawText(`Frame ${frameCounter}  ·  ${chip8.instructionCount} instructions executed`, fontSmall, brushTextDim, WINDOW_WIDTH - 28 - 380, hudTop + 24, 380, 14, formatFarNear);

  // CPU state header.
  const cpuTop = hudTop + 58;
  drawText('CPU', fontHeader, brushTextDim, 28, cpuTop, 60, 16, formatNearNear);
  const programCounterText = `PC = 0x${chip8.programCounter.toString(16).padStart(3, '0').toUpperCase()}`;
  const indexText = `I  = 0x${chip8.index.toString(16).padStart(3, '0').toUpperCase()}`;
  const opcodeText = `Last opcode = 0x${chip8.lastOpcode.toString(16).padStart(4, '0').toUpperCase()}`;
  const stackText = `SP = ${chip8.stackPointer.toString().padStart(2, '0')}`;
  const delayText = `DT = ${chip8.delayTimer.toString().padStart(3, '0')}`;
  const soundText = `ST = ${chip8.soundTimer.toString().padStart(3, '0')}`;
  drawText(programCounterText, fontMonoBold, brushText, 28, cpuTop + 18, 140, 16, formatNearNear);
  drawText(indexText, fontMonoBold, brushText, 28, cpuTop + 36, 140, 16, formatNearNear);
  drawText(opcodeText, fontMono, brushTextAccent, 28, cpuTop + 54, 240, 16, formatNearNear);
  drawText(stackText, fontMono, brushText, 200, cpuTop + 18, 100, 16, formatNearNear);
  drawText(delayText, fontMono, brushText, 200, cpuTop + 36, 100, 16, formatNearNear);
  drawText(soundText, fontMono, brushText, 200, cpuTop + 54, 100, 16, formatNearNear);

  // Beeper indicator.
  const beepX = 300;
  const beepY = cpuTop + 16;
  Gdiplus.GdipFillEllipse(graphics, chip8.soundTimer > 0 ? brushBeepOn : brushBeepOff, beepX, beepY, 14, 14);
  drawText(
    chip8.soundTimer > 0 ? 'BEEP' : 'silent',
    fontMono,
    chip8.soundTimer > 0 ? brushTextAccent : brushTextDim,
    beepX + 22,
    beepY - 2,
    80,
    16,
    formatNearNear,
  );
  drawText(
    paused ? 'PAUSED' : 'running',
    fontMonoBold,
    paused ? brushBeepOn : brushTextAccent,
    beepX + 22,
    beepY + 18,
    80,
    16,
    formatNearNear,
  );

  // V-register grid: 16 cells (V0..VF) showing the current 8-bit value.
  const registerTop = cpuTop;
  const registerLeft = 380;
  drawText('REGISTERS', fontHeader, brushTextDim, registerLeft, registerTop, 100, 16, formatNearNear);
  const cellWidth = 56;
  const cellHeight = 22;
  for (let registerIndex = 0; registerIndex < 16; registerIndex += 1) {
    const column = registerIndex % 4;
    const row = Math.floor(registerIndex / 4);
    const cellX = registerLeft + column * (cellWidth + 6);
    const cellY = registerTop + 18 + row * (cellHeight + 4);
    Gdiplus.GdipFillRectangle(graphics, brushRegBg, cellX, cellY, cellWidth, cellHeight);
    const registerLabel = `V${registerIndex.toString(16).toUpperCase()}`;
    const registerValue = chip8.registers[registerIndex]!.toString(16).padStart(2, '0').toUpperCase();
    drawText(registerLabel, fontSmall, brushTextDim, cellX + 4, cellY + 4, 22, 14, formatNearNear);
    drawText(registerValue, fontMonoBold, brushText, cellX + 26, cellY + 3, 28, 16, formatNearNear);
  }

  // Keypad indicator — 4×4 grid of the CHIP-8 hex keys, illuminating on press.
  const keypadTop = registerTop + 4 * (cellHeight + 4) + 28;
  drawText('KEYPAD', fontHeader, brushTextDim, registerLeft, keypadTop, 100, 16, formatNearNear);
  const keyCellSize = 36;
  const keyCellSpacing = 4;
  for (let labelIndex = 0; labelIndex < KEY_LABELS.length; labelIndex += 1) {
    const label = KEY_LABELS[labelIndex]!;
    const column = labelIndex % 4;
    const row = Math.floor(labelIndex / 4);
    const cellX = registerLeft + column * (keyCellSize + keyCellSpacing);
    const cellY = keypadTop + 18 + row * (keyCellSize + keyCellSpacing);
    const isPressed = chip8.keypad[label.hex] === 1;
    Gdiplus.GdipFillRectangle(graphics, isPressed ? brushKeyOn : brushKeyOff, cellX, cellY, keyCellSize, keyCellSize);
    const hexText = label.hex.toString(16).toUpperCase();
    drawText(hexText, fontMonoBold, brushText, cellX, cellY + 4, keyCellSize, 16, formatCenterCenter);
    drawText(label.physical, fontSmall, isPressed ? brushText : brushTextDim, cellX, cellY + keyCellSize - 14, keyCellSize, 12, formatCenterCenter);
  }

  // Stack visualization on the right.
  const stackLeft = WINDOW_WIDTH - 28 - 200;
  const stackVisTop = cpuTop;
  drawText('STACK', fontHeader, brushTextDim, stackLeft, stackVisTop, 100, 16, formatNearNear);
  for (let slot = 0; slot < CHIP8_STACK_DEPTH; slot += 1) {
    const slotY = stackVisTop + 18 + slot * 12;
    const isOccupied = slot < chip8.stackPointer;
    const slotText = `${slot.toString().padStart(2, '0')}: 0x${chip8.stack[slot]!.toString(16).padStart(3, '0').toUpperCase()}`;
    drawText(slotText, fontMono, isOccupied ? brushTextAccent : brushTextDim, stackLeft, slotY, 200, 14, formatNearNear);
  }

  // Pause overlay across the display.
  if (paused) {
    Gdiplus.GdipFillRectangle(graphics, brushPauseBg, BEZEL_LEFT, BEZEL_TOP, DISPLAY_PIXEL_WIDTH, DISPLAY_PIXEL_HEIGHT);
    drawText('PAUSED — SPACE to resume', fontTitle, brushTextAccent, BEZEL_LEFT, BEZEL_TOP + DISPLAY_PIXEL_HEIGHT / 2 - 12, DISPLAY_PIXEL_WIDTH, 24, formatCenterCenter);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame tick: run N CHIP-8 cycles, decrement timers, gate the beeper, paint.
// ─────────────────────────────────────────────────────────────────────────────

let frameCounter = 0;

function tickFrame(): void {
  if (resetRequested) {
    applyRom(activeRomIndex);
    resetRequested = false;
  }
  if (swapRomRequested) {
    applyRom((activeRomIndex + 1) % ROMS.length);
    swapRomRequested = false;
  }

  if (!paused) {
    for (let cycleIndex = 0; cycleIndex < CHIP8_CYCLES_PER_FRAME; cycleIndex += 1) {
      executeInstruction(chip8);
      if (chip8.halted) break;
    }
    // Timers tick at 60 Hz; the frame timer is already 60 Hz so one decrement
    // per frame is correct.
    timerSubFrameAccumulator += 1;
    if (timerSubFrameAccumulator >= 1) {
      tickTimers(chip8);
      timerSubFrameAccumulator -= 1;
    }
  }

  setBeeperActive(!paused && chip8.soundTimer > 0);
  frameCounter += 1;
}

void CHIP8_TIMER_HZ; // referenced in docstring; silence unused-var lints.

// ─────────────────────────────────────────────────────────────────────────────
// Win32 window class + WndProc
// ─────────────────────────────────────────────────────────────────────────────

const className = encodeUtf16('Chip8BunHost');
const windowTitle = encodeUtf16('CHIP-8 · Bun + Win32 FFI');

const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    switch (msg) {
      case WM_ERASEBKGND:
        // We paint every pixel every frame, so suppress the default erase.
        return 1n;

      case WM_TIMER:
        if (wParam === FRAME_TIMER_ID) {
          tickFrame();
          renderFrame();
          const hdc = User32.GetDC(hWnd);
          if (hdc) {
            GDI32.SetDIBitsToDevice(
              hdc,
              0,
              0,
              WINDOW_WIDTH,
              WINDOW_HEIGHT,
              0,
              0,
              0,
              WINDOW_HEIGHT,
              framebuffer.ptr,
              bitmapInfoBuffer.ptr,
              DIB_RGB_COLORS,
            );
            User32.ReleaseDC(hWnd, hdc);
          }
        }
        return 0n;

      case WM_PAINT: {
        const paintStructBuffer = Buffer.alloc(80);
        const paintHdc = User32.BeginPaint(hWnd, paintStructBuffer.ptr);
        if (paintHdc) {
          GDI32.SetDIBitsToDevice(
            paintHdc,
            0,
            0,
            WINDOW_WIDTH,
            WINDOW_HEIGHT,
            0,
            0,
            0,
            WINDOW_HEIGHT,
            framebuffer.ptr,
            bitmapInfoBuffer.ptr,
            DIB_RGB_COLORS,
          );
        }
        User32.EndPaint(hWnd, paintStructBuffer.ptr);
        return 0n;
      }

      case WM_KEYDOWN: {
        const virtualKey = Number(wParam) & 0xff;
        if (virtualKey === VirtualKey.VK_ESCAPE) {
          User32.DestroyWindow(hWnd);
          return 0n;
        }
        if (virtualKey === VirtualKey.VK_SPACE) {
          paused = !paused;
          return 0n;
        }
        if (virtualKey === VK_F1) {
          resetRequested = true;
          return 0n;
        }
        if (virtualKey === VK_F2) {
          swapRomRequested = true;
          return 0n;
        }
        const hexKey = KEY_MAP.get(virtualKey);
        if (hexKey !== undefined) chip8.keypad[hexKey] = 1;
        return 0n;
      }

      case WM_KEYUP: {
        const virtualKey = Number(wParam) & 0xff;
        const hexKey = KEY_MAP.get(virtualKey);
        if (hexKey !== undefined) chip8.keypad[hexKey] = 0;
        return 0n;
      }

      case WM_CLOSE:
        User32.DestroyWindow(hWnd);
        return 0n;

      case WM_DESTROY:
        User32.PostQuitMessage(0);
        return 0n;
    }

    return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
  },
  {
    args: ['u64', 'u32', 'u64', 'i64'],
    returns: 'i64',
  },
);

// WNDCLASSEXW = 80 bytes on x64.
const windowClassBuffer = Buffer.alloc(80);
const windowClassView = new DataView(windowClassBuffer.buffer);
windowClassView.setUint32(0, 80, true); // cbSize
windowClassView.setUint32(4, 0x0020 | 0x0002 | 0x0001, true); // CS_OWNDC | CS_VREDRAW | CS_HREDRAW
windowClassBuffer.writeBigUInt64LE(BigInt(wndProc.ptr!), 8);

const hInstance = Kernel32.GetModuleHandleW(null!);
windowClassBuffer.writeBigUInt64LE(BigInt(hInstance), 24);
windowClassBuffer.writeBigUInt64LE(BigInt(className.ptr), 64);

const classAtom = User32.RegisterClassExW(windowClassBuffer.ptr);
if (!classAtom) throw new Error('RegisterClassExW failed');

const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
const windowX = Math.floor((screenWidth - WINDOW_WIDTH) / 2);
const windowY = Math.floor((screenHeight - WINDOW_HEIGHT) / 2);

const mainHwnd = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_APPWINDOW,
  className.ptr,
  windowTitle.ptr,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  windowX,
  windowY,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  0n,
  0n,
  hInstance,
  NULL_PTR,
);
if (!mainHwnd) throw new Error('CreateWindowExW failed');

// Dark chrome + mica backdrop.
const darkModeAttribute = Buffer.alloc(4);
darkModeAttribute.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(mainHwnd, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, darkModeAttribute.ptr, 4);

const backdropAttribute = Buffer.alloc(4);
backdropAttribute.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(mainHwnd, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdropAttribute.ptr, 4);

User32.ShowWindow(mainHwnd, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(mainHwnd);
User32.SetTimer(mainHwnd, FRAME_TIMER_ID, FRAME_INTERVAL_MS, null);

console.log('=============================================');
console.log('   CHIP-8  ·  Bun + Win32 FFI emulator');
console.log('=============================================');
console.log('');
console.log('  ROM: ' + ROMS[0]!.name);
console.log('  Display: 64x32 @ 10x scale (640x320)');
console.log('  CPU: ~660 Hz (11 cycles / 60 fps frame)');
console.log('  Audio: ' + (xaudioAvailable ? 'IXAudio2 looping 440 Hz square (beeper)' : 'XAudio2 unavailable in this environment'));
console.log('');
console.log('  Keypad:   1 2 3 4    ->   1 2 3 C');
console.log('            Q W E R    ->   4 5 6 D');
console.log('            A S D F    ->   7 8 9 E');
console.log('            Z X C V    ->   A 0 B F');
console.log('');
console.log('  ESC quit  ·  SPACE pause  ·  F1 reset  ·  F2 swap ROM');
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup + message pump
// ─────────────────────────────────────────────────────────────────────────────

let teardownComplete = false;

function teardown(): void {
  if (teardownComplete) return;
  teardownComplete = true;

  if (xaudioAvailable) {
    setBeeperActive(false);
    vcall(xaudioSource, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  }
  if (xaudioMaster !== 0n) vcall(xaudioMaster, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  if (xaudioEngine !== 0n) vcall(xaudioEngine, IUNKNOWN_RELEASE, [], [], FFIType.u32);

  for (const brush of [brushBackdrop, brushDisplayBg, brushPixelOff, brushPixelGlow, brushPixelOn, brushBezel, brushHudPanel, brushHudBorder, brushText, brushTextDim, brushTextAccent, brushKeyOff, brushKeyOn, brushRegBg, brushBeepOff, brushBeepOn, brushPauseBg]) {
    Gdiplus.GdipDeleteBrush(brush);
  }
  for (const font of [fontTitle, fontHeader, fontMono, fontMonoBold, fontSmall]) {
    Gdiplus.GdipDeleteFont(font);
  }
  Gdiplus.GdipDeleteFontFamily(fontFamilyUi);
  Gdiplus.GdipDeleteFontFamily(fontFamilyMono);
  for (const format of [formatNearNear, formatCenterCenter, formatFarNear]) {
    Gdiplus.GdipDeleteStringFormat(format);
  }
  Gdiplus.GdipDeleteGraphics(graphics);
  Gdiplus.GdipDisposeImage(framebufferBitmap);
  Gdiplus.GdiplusShutdown(gdiplusToken);

  User32.UnregisterClassW(className.ptr, hInstance);
  wndProc.close();

  console.log(`  CHIP-8 shut down cleanly after ${frameCounter} frames (${chip8.instructionCount} instructions).`);
}

process.on('SIGINT', () => {
  teardown();
  process.exit(0);
});

const messageBuffer = Buffer.alloc(48);
while (true) {
  const result = User32.GetMessageW(messageBuffer.ptr, 0n, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(messageBuffer.ptr);
  User32.DispatchMessageW(messageBuffer.ptr);
}

teardown();
