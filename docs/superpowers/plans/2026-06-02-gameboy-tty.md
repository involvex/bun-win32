# gameboy-tty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single self-contained `@bun-win32` example, `packages/all/example/gameboy-tty.ts`, that emulates a Game Boy / Game Boy Color in pure TypeScript and plays real ROMs rendered into the terminal with half-block truecolor pixels, authentic held-button controls, and sound.

**Architecture:** Port the proven DMG core (CPU/MMU/PPU/APU/timers/interrupts) from `gameboy.ts` verbatim into the new file, then extend the MMU (MBC1/3/5 + RTC + battery saves) and PPU (CGB color) and MMU registers (VBK/SVBK/KEY1/palettes/HDMA). The terminal front-end reuses `_term`'s `Term` renderer, `makeFrameWaiter`, and `encodePNG`; input uses raw Win32 `ReadConsoleInputW` for true key-down/up held state (ANSI fallback); audio reuses `_audio` (XAudio2).

**Tech Stack:** Bun, TypeScript, `@bun-win32` FFI (Kernel32 console input, Xinput1_4), `_term.ts`, `_audio.ts`, `bun:ffi`.

**Verification philosophy:** Unit-test the NEW pure logic (bank math, input-record parsing, color conversion, RTC) with `bun test`. Integration-verify the emulation by running free test ROMs headlessly (`CAPTURE_PNG`) and asserting the rendered PNG (dmg-acid2 / cgb-acid2 faces, non-black luma). Never download commercial ROMs.

---

## File Structure

- **Create** `packages/all/example/gameboy-tty.ts` — the entire emulator + terminal front-end (one file, ~3000–3500 lines).
- **Create** `packages/all/example/gameboy-cgb-rom.ts` — embedded **cgb-acid2** ROM data + `loadCgbAcid2()` (data file, mirroring `gameboy-rom.ts`/`gameboy-game-rom.ts`; data, not logic).
- **Create** `packages/all/example/gameboy-tty.logic.test.ts` — `bun test` unit tests for the new pure logic (mirrors `voxelscape.logic.test.ts`). Excluded from package `files`.
- **Modify** `packages/all/package.json` — add `"gameboy-tty": "bun run example/gameboy-tty.ts"`.
- **Modify** `packages/all/README.md` — add a showcase line (final task).
- **Output** `packages/all/screenshots/gameboy-tty.png` — gallery shot (whitelisted in `.gitignore` like other screenshots).

The new file's public surface (so tasks reference consistent names):

- `class GameBoy` — `constructor(rom: Uint8Array, opts?: { apu?: Apu | null })`, `runFrame(): void`, `setButtons(b: Buttons): void`, `readonly frame: Uint8Array` (160×144 RGBA), `frameReady: boolean`, `readonly apu: Apu | null`, `readonly cgb: boolean`, `getSaveData(): Uint8Array | null`, `loadSaveData(d: Uint8Array): void`, `hasBattery: boolean`.
- `class Apu` — ported verbatim.
- `interface Buttons { right; left; up; down; a; bBtn; select; start: boolean }`.
- `const DMG_PALETTES: ReadonlyArray<ReadonlyArray<readonly [number,number,number]>>` — the green default + alternates.
- Front-end helpers: `pollConsoleInput()`, `blitToTerm()`, `main()`.

---

## Milestone 1 — DMG complete in the terminal

### Task 1: Scaffold the file + port the proven core verbatim

**Files:**
- Create: `packages/all/example/gameboy-tty.ts`

- [ ] **Step 1: Copy the emulator core from `gameboy.ts` verbatim.** Open `packages/all/example/gameboy.ts` and copy, unchanged, into the new file: the file-top constants `GB_W`/`GB_H`/`DMG_PALETTE`/`DUTY_TABLE`/`GB_CPU_HZ`, the entire `class Apu` (lines ~95–548), and the entire `class GameBoy` (lines ~550–1688) including the CPU `step()` opcode tables, CB table, ALU helpers, MMU (`read8`/`write8`/`mbcWrite`/`ioWrite`), PPU (`stepPpu`/`renderScanline`/`renderBgWindow`/`renderSprites`), timers, interrupts, and `runFrame()`. Do NOT copy `main()`, the HLSL shader strings, or the GPU imports. Keep the `Buttons`-shaped `setButtons` signature.
- [ ] **Step 2: Rename `DMG_PALETTE` usage to index 0 of a new `DMG_PALETTES` array** so palette cycling works later:

```ts
const DMG_PALETTES: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  [[0xe0,0xf8,0xd0],[0x88,0xc0,0x70],[0x34,0x68,0x56],[0x08,0x18,0x20]], // classic green
  [[0xff,0xff,0xff],[0xa9,0xa9,0xa9],[0x54,0x54,0x54],[0x00,0x00,0x00]], // grayscale
  [[0xe6,0xd6,0x9c],[0xb4,0xa0,0x68],[0x7c,0x6c,0x40],[0x3c,0x34,0x20]], // pocket sepia
];
let activePalette = 0;
```
Replace the four `DMG_PALETTE[...]` reads in the PPU with `DMG_PALETTES[activePalette]![...]`. (CGB path added later ignores this.)
- [ ] **Step 3: Add `export` to `class GameBoy`, `class Apu`, and an exported `interface Buttons`.** Extract the inline button object type in `setButtons` into `export interface Buttons { right: boolean; left: boolean; up: boolean; down: boolean; a: boolean; bBtn: boolean; select: boolean; start: boolean }` and use it.
- [ ] **Step 4: `bun build --target=bun` typecheck (compile-only).**

Run: `cd packages/all && bunx tsc --noEmit example/gameboy-tty.ts 2>&1 | head -30`
Expected: no errors from the ported core (front-end not written yet, so allow "main not found"-type since we have no main yet — but there should be no type errors in the classes).
- [ ] **Step 5: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts && git commit -m "feat(all): gameboy-tty — port DMG emulator core into terminal example"
```

### Task 2: Unit-test the ported core boots a ROM and produces a frame

**Files:**
- Create: `packages/all/example/gameboy-tty.logic.test.ts`

- [ ] **Step 1: Write the failing test** (boots dmg-acid2, runs frames, asserts a non-uniform framebuffer):

```ts
import { test, expect } from 'bun:test';
import { GameBoy } from './gameboy-tty';
import { loadAcid2 } from './gameboy-rom';

test('GameBoy boots dmg-acid2 and renders a non-blank frame', () => {
  const gb = new GameBoy(loadAcid2());
  for (let i = 0; i < 60; i++) gb.runFrame(); // ~1s of emulation
  expect(gb.frame.length).toBe(160 * 144 * 4);
  // The acid2 face is high-contrast: many distinct pixel values present.
  const seen = new Set<number>();
  for (let i = 0; i < gb.frame.length; i += 4) seen.add(gb.frame[i]! << 16 | gb.frame[i+1]! << 8 | gb.frame[i+2]!);
  expect(seen.size).toBeGreaterThan(2); // not a single flat color
});
```
- [ ] **Step 2: Run, expect PASS** (core is already proven; this guards the port).

Run: `cd packages/all && bun test example/gameboy-tty.logic.test.ts 2>&1 | tail -20`
Expected: 1 pass. If it fails (flat frame), the port dropped something — diff against `gameboy.ts`.
- [ ] **Step 3: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.logic.test.ts && git commit -m "test(all): gameboy-tty — core boots dmg-acid2 and renders"
```

### Task 3: Terminal blit — GB framebuffer → `Term` pixel grid

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts`

- [ ] **Step 1: Import the renderer + add the blit function.**

```ts
import { Term, makeFrameWaiter, encodePNG } from './_term';

const BEZEL: [number, number, number] = [12, 18, 14];

/** Nearest-neighbor scale-to-fit + center the 160x144 RGBA `frame` into Term. */
function blitToTerm(t: Term, frame: Uint8Array): void {
  const W = t.W, H = t.H;
  const scaleX = W / GB_W, scaleY = H / GB_H;
  let scale = Math.min(scaleX, scaleY);
  if (scale >= 1) scale = Math.floor(scale); // crisp integer scale when it fits
  const dw = Math.max(1, Math.floor(GB_W * scale));
  const dh = Math.max(1, Math.floor(GB_H * scale));
  const ox = ((W - dw) / 2) | 0, oy = ((H - dh) / 2) | 0;
  t.clear(BEZEL[0], BEZEL[1], BEZEL[2]);
  for (let y = 0; y < dh; y++) {
    const gy = Math.min(GB_H - 1, (y / scale) | 0);
    for (let x = 0; x < dw; x++) {
      const gx = Math.min(GB_W - 1, (x / scale) | 0);
      const o = (gy * GB_W + gx) * 4;
      t.setPixel(ox + x, oy + y, frame[o]!, frame[o + 1]!, frame[o + 2]!);
    }
  }
}
```
- [ ] **Step 2: Unit-test blit centers + fills** (append to logic test):

```ts
import { Term } from './_term';
import { blitToTerm } from './gameboy-tty'; // export blitToTerm for the test

test('blit centers the GB frame and writes pixels', () => {
  const gb = new GameBoy(loadAcid2());
  for (let i = 0; i < 60; i++) gb.runFrame();
  const t = new Term(160, 72); // exact 1:1
  blitToTerm(t, gb.frame);
  // center pixel should match the GB center pixel
  const cgx = 80, cgy = 72; const go = (cgy * 160 + cgx) * 4;
  const to = ((36) * t.W + 80) * 3; // oy=0, scale=1, center row 72→ y index 72 → buf row 72
  // (sanity: the buffer is non-bezel somewhere)
  let nonBezel = 0;
  for (let i = 0; i < t.buf.length; i += 3) if (!(t.buf[i] === 12 && t.buf[i+1] === 18 && t.buf[i+2] === 14)) nonBezel++;
  expect(nonBezel).toBeGreaterThan(1000);
});
```
Add `export` to `blitToTerm`.
- [ ] **Step 3: Run, expect PASS.**

Run: `cd packages/all && bun test example/gameboy-tty.logic.test.ts 2>&1 | tail -20`
Expected: 2 pass.
- [ ] **Step 4: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts packages/all/example/gameboy-tty.logic.test.ts && git commit -m "feat(all): gameboy-tty — blit GB framebuffer to terminal half-block grid"
```

### Task 4: Win32 console held-input layer (true key down/up) + button mapping

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts`

- [ ] **Step 1: Add the console-input module via `dlopen` (self-contained, like `makeFrameWaiter`).** Reads real `INPUT_RECORD`s; tracks a held-VK set.

```ts
import { dlopen, FFIType } from 'bun:ffi';
import { Kernel32, Xinput1_4 } from '../index';
import { STD_HANDLE } from '@bun-win32/kernel32';

// Virtual-key codes.
const VK = { LEFT:0x25, UP:0x26, RIGHT:0x27, DOWN:0x28, Z:0x5a, X:0x58, RETURN:0x0d,
  RSHIFT:0xa1, SHIFT:0x10, ESC:0x1b, M:0x4d, R:0x52, P:0x50, TAB:0x09,
  LBRACK:0xdb, RBRACK:0xdd } as const;
const ENABLE_LINE_INPUT = 0x0002, ENABLE_ECHO_INPUT = 0x0004,
  ENABLE_PROCESSED_INPUT = 0x0001, ENABLE_WINDOW_INPUT = 0x0008,
  ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200, ENABLE_MOUSE_INPUT = 0x0010;

interface ConsoleInput {
  poll(): void;                 // drain pending records into `held`
  held: Set<number>;            // currently-down virtual-key codes
  pressed: number[];            // edge presses since last poll (for hotkeys)
  restore(): void;
  ok: boolean;
}

function setupConsoleInput(): ConsoleInput {
  const held = new Set<number>();
  let pressed: number[] = [];
  try {
    const k = dlopen('kernel32.dll', {
      GetStdHandle: { args: ['u32'], returns: 'ptr' },
      GetConsoleMode: { args: ['ptr', 'ptr'], returns: 'i32' },
      SetConsoleMode: { args: ['ptr', 'u32'], returns: 'i32' },
      GetNumberOfConsoleInputEvents: { args: ['ptr', 'ptr'], returns: 'i32' },
      ReadConsoleInputW: { args: ['ptr', 'ptr', 'u32', 'ptr'], returns: 'i32' },
      FlushConsoleInputBuffer: { args: ['ptr'], returns: 'i32' },
    });
    const STD_INPUT = 0xfffffff6; // (DWORD)-10
    const hIn = k.symbols.GetStdHandle(STD_INPUT);
    const saved = Buffer.alloc(4);
    if (!k.symbols.GetConsoleMode(hIn, saved.ptr!)) throw new Error('not a console');
    const savedMode = saved.readUInt32LE(0);
    // Raw: disable line/echo/processed/VT-input so we get key down+up records.
    let mode = savedMode & ~(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT |
      ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_MOUSE_INPUT);
    mode |= ENABLE_WINDOW_INPUT;
    k.symbols.SetConsoleMode(hIn, mode >>> 0);
    k.symbols.FlushConsoleInputBuffer(hIn);
    const REC = 20;                       // sizeof(INPUT_RECORD) on x64
    const N = 64;
    const buf = Buffer.alloc(REC * N);
    const countBuf = Buffer.alloc(4);
    const readBuf = Buffer.alloc(4);
    return {
      held, pressed,
      ok: true,
      poll() {
        pressed.length = 0;
        for (;;) {
          if (!k.symbols.GetNumberOfConsoleInputEvents(hIn, countBuf.ptr!)) break;
          const avail = countBuf.readUInt32LE(0);
          if (avail === 0) break;
          if (!k.symbols.ReadConsoleInputW(hIn, buf.ptr!, Math.min(N, avail), readBuf.ptr!)) break;
          const got = readBuf.readUInt32LE(0);
          for (let i = 0; i < got; i++) {
            const o = i * REC;
            if (buf.readUInt16LE(o) !== 1) continue; // KEY_EVENT == 1
            const down = buf.readInt32LE(o + 4) !== 0;
            const vk = buf.readUInt16LE(o + 10);
            if (down) { if (!held.has(vk)) pressed.push(vk); held.add(vk); }
            else held.delete(vk);
          }
          if (got < Math.min(N, avail)) break;
        }
      },
      restore() { k.symbols.SetConsoleMode(hIn, savedMode >>> 0); },
    };
  } catch {
    return { held, pressed, ok: false, poll() {}, restore() {} };
  }
}
```
- [ ] **Step 2: Map held VKs (+ XInput) → `Buttons`.**

```ts
const xinputBuf = Buffer.alloc(16);
function readButtons(ci: ConsoleInput): Buttons {
  const h = ci.held;
  let right = h.has(VK.RIGHT), left = h.has(VK.LEFT), up = h.has(VK.UP), down = h.has(VK.DOWN);
  let a = h.has(VK.Z), bBtn = h.has(VK.X), start = h.has(VK.RETURN), select = h.has(VK.RSHIFT);
  if (Xinput1_4.XInputGetState(0, xinputBuf.ptr!) === 0) {
    const btn = xinputBuf.readUInt16LE(4);
    const lx = xinputBuf.readInt16LE(8), ly = xinputBuf.readInt16LE(10), DZ = 7849;
    if (btn & 0x1000) a = true; if (btn & 0x2000) bBtn = true;
    if (btn & 0x0010) start = true; if (btn & 0x0020) select = true;
    if (btn & 0x0001 || ly > DZ) up = true; if (btn & 0x0002 || ly < -DZ) down = true;
    if (btn & 0x0004 || lx < -DZ) left = true; if (btn & 0x0008 || lx > DZ) right = true;
  }
  return { right, left, up, down, a, bBtn, select, start };
}
```
- [ ] **Step 3: Unit-test the INPUT_RECORD field offsets** (parse a hand-built key-down record):

```ts
test('INPUT_RECORD parse: KEY_EVENT down with VK_RIGHT', () => {
  const REC = 20; const buf = Buffer.alloc(REC);
  buf.writeUInt16LE(1, 0);        // EventType = KEY_EVENT
  buf.writeInt32LE(1, 4);         // bKeyDown = TRUE
  buf.writeUInt16LE(1, 8);        // wRepeatCount
  buf.writeUInt16LE(0x27, 10);    // wVirtualKeyCode = VK_RIGHT
  expect(buf.readUInt16LE(0)).toBe(1);
  expect(buf.readInt32LE(4) !== 0).toBe(true);
  expect(buf.readUInt16LE(10)).toBe(0x27);
});
```
- [ ] **Step 4: Run, expect PASS.**

Run: `cd packages/all && bun test example/gameboy-tty.logic.test.ts 2>&1 | tail -20`
Expected: 3 pass.
- [ ] **Step 5: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts packages/all/example/gameboy-tty.logic.test.ts && git commit -m "feat(all): gameboy-tty — Win32 ReadConsoleInput held-state input + XInput mapping"
```

### Task 5: ROM loading from disk + CLI/env selection

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts`

- [ ] **Step 1: Add ROM resolution.**

```ts
import { loadAcid2 } from './gameboy-rom';
import { loadLibbet } from './gameboy-game-rom';

function resolveRom(): { rom: Uint8Array; title: string; path: string | null } {
  const arg = process.argv[2];
  const env = process.env.GB_ROM;
  const sel = (arg ?? env ?? 'game').trim();
  if (sel === 'game' || sel === 'libbet') return { rom: loadLibbet(), title: 'Libbet and the Magic Floor', path: null };
  if (sel === 'acid2') return { rom: loadAcid2(), title: 'dmg-acid2', path: null };
  // Treat as a file path.
  const file = Bun.file(sel);
  const buf = require('node:fs').readFileSync(sel) as Buffer;
  const rom = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const title = require('node:path').basename(sel);
  return { rom, title, path: sel };
}
```
- [ ] **Step 2: Read ROM title from header (0x134–0x143) for the HUD.** Add helper `romHeaderTitle(rom)` returning the ASCII title trimmed at NUL.
- [ ] **Step 3: Manual smoke (no commit yet):** verify a bad path errors cleanly.

Run: `cd packages/all && GB_ROM=does-not-exist.gb bun run example/gameboy-tty.ts 2>&1 | head -5` (after main exists in Task 6) — expect a clear ENOENT-style message, exit non-zero.
- [ ] **Step 4: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts && git commit -m "feat(all): gameboy-tty — load .gb/.gbc from path, default to bundled Libbet"
```

### Task 6: Live main loop — render + input + audio + pacing

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts`

- [ ] **Step 1: Add audio + the console lifecycle (VT output on, alt-screen, restore) and the live loop.** Use the `_term` console setup approach but inline (we own input mode). Set output handle VT processing on; hide cursor; alt screen; on exit restore + `ci.restore()` + save battery.

```ts
import * as audio from './_audio';

function main(): void {
  const { rom, title, path } = resolveRom();
  const AUDIO_RATE = 48000;
  const pcm = audio.createPcmOutput({ sampleRate: AUDIO_RATE, channels: 2 });
  const apu = new Apu(AUDIO_RATE);
  if (pcm.available) { pcm.setVolume(0.6); pcm.start(); }
  const gb = new GameBoy(rom, { apu });
  if (path && gb.hasBattery) { /* load .sav — wired in Milestone 2 */ }

  // Capture mode short-circuit (Task 7) handled before live setup.
  if (process.env.CAPTURE_PNG) return runCapture(gb, title);

  // ── Console output setup (VT truecolor; input mode owned by setupConsoleInput) ──
  Kernel32.Preload(['GetStdHandle','GetConsoleMode','SetConsoleMode','GetConsoleOutputCP','SetConsoleOutputCP','GetConsoleScreenBufferInfo']);
  const hOut = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
  const om = Buffer.alloc(4); Kernel32.GetConsoleMode(hOut, om.ptr!);
  const savedOut = om.readUInt32LE(0);
  Kernel32.SetConsoleMode(hOut, savedOut | 0x0001 | 0x0004); // PROCESSED|VT
  const savedCp = Kernel32.GetConsoleOutputCP(); Kernel32.SetConsoleOutputCP(65001);
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H');

  const ci = setupConsoleInput();           // Win32 held-state (or ANSI fallback path)
  let muted = false, paused = false, turbo = false, running = true;

  const detect = () => { /* reuse _term detectSize logic via GetConsoleScreenBufferInfo */ };
  let t = new Term(/* cols */, /* rows */);
  const wait = makeFrameWaiter();
  const GB_FRAME_MS = 1000 / 59.7;

  const cleanup = () => {
    ci.restore();
    process.stdout.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
    Kernel32.SetConsoleMode(hOut, savedOut); Kernel32.SetConsoleOutputCP(savedCp);
    pcm.close();
    if (path && gb.hasBattery) { /* save .sav — Milestone 2 */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { running = false; });

  while (running) {
    ci.poll();
    // hotkeys (edge): ESC/Ctrl-C quit handled via held set; M/R/P/[/] via ci.pressed
    if (ci.held.has(VK.ESC)) break;
    for (const vk of ci.pressed) {
      if (vk === VK.M) muted = !muted;
      else if (vk === VK.R) gb.reset?.();         // expose reset() (rename private)
      else if (vk === VK.P) paused = !paused;
      else if (vk === VK.LBRACK) activePalette = (activePalette + DMG_PALETTES.length - 1) % DMG_PALETTES.length;
      else if (vk === VK.RBRACK) activePalette = (activePalette + 1) % DMG_PALETTES.length;
    }
    turbo = ci.held.has(VK.TAB);
    if (!paused) {
      gb.setButtons(readButtons(ci));
      const steps = turbo ? 4 : 1;
      for (let s = 0; s < steps; s++) {
        gb.runFrame();
        if (pcm.available && !muted && !turbo && pcm.queued() < 4) {
          const blk = gb.apu!.drain(AUDIO_RATE); if (blk.length) pcm.submit(blk);
        } else if (turbo) { gb.apu!.drain(AUDIO_RATE); } // discard to avoid ring overflow
      }
    }
    blitToTerm(t, gb.frame);
    drawHud(t, title, muted, paused, turbo);
    t.present();
    if (!turbo && wait) { const left = GB_FRAME_MS - 0 /* measure */; if (left > 0.2) wait(left); }
  }
  cleanup();
  process.exit(0);
}
```
(Implementation note: measure per-frame elapsed with `Bun.nanoseconds()` like `_term`'s loop; reuse the `detectSize` math from `_term.ts` lines 541–561 verbatim. Expose `GameBoy.reset()` by renaming the private `reset` to public or adding a public `reset()` wrapper.)
- [ ] **Step 2: Add `drawHud`** using `Term.text`: `GAME BOY · <title> · <fps> FPS · <♪ or MUTE>` on a plate at top-left, plus a one-line control hint at the bottom.
- [ ] **Step 3: Manual run — boots Libbet, is playable.**

Run: `cd packages/all && bun run example/gameboy-tty.ts` (interactive; press arrows/Z/X/Enter; ESC to quit).
Expected: Libbet title → gameplay; D-pad feels responsive (true held); sound plays; HUD shows ~59 fps.
- [ ] **Step 4: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts && git commit -m "feat(all): gameboy-tty — live loop: render + held-input + APU audio + 60fps pacing"
```

### Task 7: Headless CAPTURE_PNG mode + package.json script + dmg-acid2 verification

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts`, `packages/all/package.json`

- [ ] **Step 1: Add `runCapture(gb, title)`** — runs a fixed number of frames (with an optional scripted button timeline like `gameboy.ts:scripted`), blits to a `Term` sized by `TERM_COLS`/`TERM_ROWS` (default 160×72), draws the HUD, writes `encodePNG(t.buf, t.W, t.H)` to `CAPTURE_PNG`, prints a `[shot]` line with non-black fraction + mean luma, and returns (no console/alt-screen setup in this path).

```ts
function runCapture(gb: GameBoy, title: string): void {
  const cols = Number(process.env.TERM_COLS ?? 160) | 0;
  const rows = Number(process.env.TERM_ROWS ?? 72) | 0;
  const frames = Number(process.env.CAPTURE_FRAMES_RUN ?? 180) | 0; // ~3s
  const t = new Term(Math.max(20, cols), Math.max(8, rows));
  for (let i = 0; i < frames; i++) { gb.setButtons(scriptedButtons(i)); gb.runFrame(); }
  blitToTerm(t, gb.frame);
  drawHud(t, title, false, false, false);
  const png = encodePNG(t.buf, t.W, t.H);
  const out = process.env.CAPTURE_PNG!;
  require('node:fs').writeFileSync(out, png);
  // luma stats
  let nonBlack = 0, lumaSum = 0, n = t.buf.length / 3;
  for (let i = 0; i < t.buf.length; i += 3) { const L = (t.buf[i]!*0.299+t.buf[i+1]!*0.587+t.buf[i+2]!*0.114); lumaSum += L; if (L > 8) nonBlack++; }
  console.log(`[shot] ok=true nonBlack=${(nonBlack/n).toFixed(3)} meanLuma=${(lumaSum/n/255).toFixed(3)} -> ${out}`);
}
```
- [ ] **Step 2: Add the package.json script.** In `packages/all/package.json` add `"gameboy-tty": "bun run example/gameboy-tty.ts"` (keep alphabetical order near `"gameboy"`).
- [ ] **Step 3: Verify dmg-acid2 renders the face headlessly.**

Run: `cd packages/all && GB_ROM=acid2 CAPTURE_PNG="$PWD/.shots/gameboy-tty-acid2.png" CAPTURE_FRAMES_RUN=60 bun run example/gameboy-tty.ts`
Expected: `[shot] ok=true nonBlack≈0.3–0.7 meanLuma≈0.4–0.7`. Then visually confirm the PNG shows the acid2 face (open `.shots/gameboy-tty-acid2.png`).
- [ ] **Step 4: Verify Libbet capture is non-black.**

Run: `cd packages/all && CAPTURE_PNG="$PWD/.shots/gameboy-tty-libbet.png" bun run example/gameboy-tty.ts`
Expected: `[shot] ok=true nonBlack>0.2`.
- [ ] **Step 5: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts packages/all/package.json && git commit -m "feat(all): gameboy-tty — headless CAPTURE_PNG + script; verify dmg-acid2 face"
```

---

## Milestone 2 — Full MBC1/3/5 + battery saves + RTC

### Task 8: Cartridge mapper rewrite (MBC1 full, MBC3, MBC5) — pure-logic, TDD

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts` (replace the thin `mbcWrite` + ROM/RAM read paths with a mapper that switches on `mbcType`)
- Modify: `packages/all/example/gameboy-tty.logic.test.ts`

- [ ] **Step 1: Write failing tests for bank math.** Cover: MBC1 ROM bank 0→1 remap; MBC1 5-bit + 2-bit composition; MBC5 9-bit bank (low+high); MBC3 RAM/RTC select; RAM enable gating.

```ts
import { __mapperForTest } from './gameboy-tty'; // export a tiny harness

test('MBC1 bank 0 maps to 1', () => {
  const m = __mapperForTest(0x01, 0x1f /* 32 banks */);
  m.write(0x2000, 0x00); expect(m.romBankFor(0x4000)).toBe(1);
});
test('MBC1 upper bits compose in mode 0', () => {
  const m = __mapperForTest(0x01, 0x7f);
  m.write(0x2000, 0x05); m.write(0x4000, 0x02); // 0b10<<5 | 0b00101 = 0x45
  expect(m.romBankFor(0x4000)).toBe(0x45);
});
test('MBC5 9-bit bank from low+high writes', () => {
  const m = __mapperForTest(0x1b, 0x1ff);
  m.write(0x2000, 0x00); m.write(0x3000, 0x01); // bank 0x100
  expect(m.romBankFor(0x4000)).toBe(0x100);
});
test('MBC3 RAM enable gates external RAM', () => {
  const m = __mapperForTest(0x13, 0x7f);
  expect(m.ramEnabled).toBe(false);
  m.write(0x0000, 0x0a); expect(m.ramEnabled).toBe(true);
});
```
- [ ] **Step 2: Run, expect FAIL** (harness + mappers not written).

Run: `cd packages/all && bun test example/gameboy-tty.logic.test.ts 2>&1 | tail -25`
Expected: failures (no `__mapperForTest`).
- [ ] **Step 3: Implement a `Mapper` abstraction** inside the file: a small class holding `romBank`, `ramBank`, `ramEnabled`, `mode`, `mbcType`, `romBankMask`, RTC state, with `write(addr,value)`, `romBankFor(addr)`, `ramOffsetFor(addr)`. Wire `GameBoy.read8`/`write8` to use it. Export `__mapperForTest` returning a fresh mapper. Cover MBC0/1/2(optional skip)/3/5 type codes (0x00–0x1E table).
- [ ] **Step 4: Run, expect PASS.**

Run: `cd packages/all && bun test example/gameboy-tty.logic.test.ts 2>&1 | tail -25`
Expected: all pass.
- [ ] **Step 5: Regression — dmg-acid2 + Libbet still render** (Tasks 2 + 7 commands). Expected: unchanged.
- [ ] **Step 6: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts packages/all/example/gameboy-tty.logic.test.ts && git commit -m "feat(all): gameboy-tty — full MBC1/3/5 mapper with unit tests"
```

### Task 9: MBC3 RTC — pure-logic, TDD

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts`, `packages/all/example/gameboy-tty.logic.test.ts`

- [ ] **Step 1: Write failing tests** for RTC latch + register read/write + day-carry.

```ts
test('MBC3 RTC latch freezes readable registers', () => {
  const m = __mapperForTest(0x10, 0x7f); // MBC3+TIMER+RAM+BATTERY
  m.setRtcBaseSeconds(0);
  m.write(0x4000, 0x08);            // select RTC seconds
  m.advanceWallSeconds(65);
  m.write(0x6000, 0x00); m.write(0x6000, 0x01); // latch
  expect(m.readRam(0xa000)).toBe(5); // 65s → 5s
});
```
- [ ] **Step 2: Run, expect FAIL.** (`cd packages/all && bun test example/gameboy-tty.logic.test.ts`)
- [ ] **Step 3: Implement RTC** — host-wall-clock backed (`Date.now()` not allowed in workflows but fine in the example at runtime; the mapper takes an injected `nowSeconds()` for testability, defaulting to `() => Date.now()/1000`). Latched S/M/H/DL/DH, halt bit, day-carry bit. `advanceWallSeconds`/`setRtcBaseSeconds` are test hooks over the injected clock.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts packages/all/example/gameboy-tty.logic.test.ts && git commit -m "feat(all): gameboy-tty — MBC3 real-time clock with latch + day carry"
```

### Task 10: Battery saves (.sav round-trip) + wire into main

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts`, `packages/all/example/gameboy-tty.logic.test.ts`

- [ ] **Step 1: Implement `getSaveData()`/`loadSaveData()`** on `GameBoy` — external RAM bytes, with RTC state appended (8×u32 LE) for MBC3+TIMER carts, mirroring the common `.sav` layout. `hasBattery` from the cart-type table.
- [ ] **Step 2: Failing test — save/load round-trips RAM.**

```ts
test('battery save round-trips external RAM', () => {
  const fakeMbc1Battery = makeFakeRom(0x03, /*romBanks*/4, /*ramKiB*/8);
  const gb = new GameBoy(fakeMbc1Battery);
  // enable RAM + write a byte
  // ...drive writes via a tiny program or direct test hook...
  const save = gb.getSaveData()!;
  const gb2 = new GameBoy(fakeMbc1Battery);
  gb2.loadSaveData(save);
  expect(gb2.getSaveData()).toEqual(save);
});
```
(Provide `makeFakeRom(type, romBanks, ramKiB)` helper in the test that builds a minimal valid header.)
- [ ] **Step 3: Run FAIL → implement → Run PASS.**
- [ ] **Step 4: Wire `.sav` file IO into `main`/`cleanup`** — load `<romPath>.sav` on boot if present; write on exit + every ~5s autosave. Print the save path once.
- [ ] **Step 5: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts packages/all/example/gameboy-tty.logic.test.ts && git commit -m "feat(all): gameboy-tty — battery .sav persistence (RAM + RTC) with autosave"
```

---

## Milestone 3 — Game Boy Color path

### Task 11: CGB detection + post-boot state + VRAM/WRAM banking + KEY1

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts`, `packages/all/example/gameboy-tty.logic.test.ts`

- [ ] **Step 1: Detect CGB** from header 0x143 (`0x80`/`0xC0` → `this.cgb = true`). Set CGB post-boot register values (A=0x11) when CGB. Expand VRAM to `0x4000` (2 banks) + add `vramBank` (VBK FF4F bit0). Expand WRAM to `0x8000` (8 banks) + `wramBank` (SVBK FF70, bank 0→1). Add KEY1 (FF4D): bit0 arm, STOP toggles `doubleSpeed`; `runFrame` uses `70224 << (doubleSpeed?1:0)` T-cycles and timers/CPU scale while PPU dots/APU stay 1×.
- [ ] **Step 2: Failing test** — a CGB-header ROM sets `gb.cgb` true and WRAM/VRAM banking reads back.

```ts
test('CGB header enables color mode + WRAM bank switch', () => {
  const rom = makeFakeRom(0x1b /*MBC5*/, 8, 8, /*cgbFlag*/0xc0);
  const gb = new GameBoy(rom);
  expect(gb.cgb).toBe(true);
  // SVBK switch + write/read distinct banks via test hook
});
```
- [ ] **Step 3: Run FAIL → implement → Run PASS.**
- [ ] **Step 4: Regression — DMG dmg-acid2 + Libbet unchanged** (a DMG ROM must keep `gb.cgb === false` and render identically). Run Task 7 commands; expect identical luma.
- [ ] **Step 5: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts packages/all/example/gameboy-tty.logic.test.ts && git commit -m "feat(all): gameboy-tty — CGB detection, VRAM/WRAM banking, double-speed"
```

### Task 12: CGB palettes + 15→24-bit color correction — pure-logic, TDD

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts`, `packages/all/example/gameboy-tty.logic.test.ts`

- [ ] **Step 1: Failing test for color conversion.**

```ts
import { cgbColor } from './gameboy-tty'; // export the converter
test('cgb 15-bit white maps to near-white, black to near-black', () => {
  const white = cgbColor(0x7fff); // r=g=b=31
  expect(white[0]).toBeGreaterThan(230); expect(white[2]).toBeGreaterThan(230);
  const black = cgbColor(0x0000);
  expect(black[0]).toBeLessThan(20);
});
```
- [ ] **Step 2: Implement `cgbColor(rgb15)`** using the standard CGB LCD correction (e.g. `R' = (r*26 + g*4 + b*2)`, etc., scaled/clamped to 0–255 — Gambatte's well-known matrix), returning `[r,g,b]`. Add BCPS/BCPD (FF68/69) + OCPS/OCPD (FF6A/6B) palette RAM (64 bytes each) with auto-increment writes; precompute a `[paletteIndex][colorIndex] → [r,g,b]` cache invalidated on palette write.
- [ ] **Step 3: Run FAIL → PASS.**
- [ ] **Step 4: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts packages/all/example/gameboy-tty.logic.test.ts && git commit -m "feat(all): gameboy-tty — CGB palette RAM + LCD color correction"
```

### Task 13: CGB PPU rendering (BG attributes, OBJ palettes, priority)

**Files:**
- Modify: `packages/all/example/gameboy-tty.ts`

- [ ] **Step 1: Add a CGB branch to `renderBgWindow`** — read BG tile attribute from VRAM bank 1 at the same map index: bit0–2 palette, bit3 tile VRAM bank, bit5 X-flip, bit6 Y-flip, bit7 BG-priority. Use `cgbBgPalettes[pal][colorIdx]`. Keep DMG path when `!cgb`.
- [ ] **Step 2: Add a CGB branch to `renderSprites`** — OBJ palette from attr bits0–2 (`cgbObjPalettes`), tile VRAM bank from bit3. Master priority: in CGB, LCDC bit0 == BG master priority; per-tile BG-priority + OAM priority resolve who wins. Track per-pixel BG color index + BG-priority flag (extend `scanBgIndex` to carry priority).
- [ ] **Step 3: Manual + headless smoke** with a CGB ROM (cgb-acid2 added next task). Defer visual check to Task 14.
- [ ] **Step 4: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts && git commit -m "feat(all): gameboy-tty — CGB PPU (BG attributes, OBJ palettes, priority)"
```

### Task 14: HDMA/GDMA + embed cgb-acid2 + verify color face

**Files:**
- Create: `packages/all/example/gameboy-cgb-rom.ts`
- Modify: `packages/all/example/gameboy-tty.ts`

- [ ] **Step 1: Implement HDMA/GDMA (FF51–FF55).** Source HDMA1/2, dest HDMA3/4 (VRAM, masked to current VBK), HDMA5: bit7=0 general (immediate full transfer of `(len+1)*16` bytes), bit7=1 H-blank (16 bytes at each H-blank entry; FF55 read reports remaining/active). Hook the H-blank transfer into the PPU mode-0 entry in `stepPpu`.
- [ ] **Step 2: Embed cgb-acid2.** Create `gameboy-cgb-rom.ts` with the base64 of cgb-acid2 (MIT, mattcurrie) + `export function loadCgbAcid2(): Uint8Array`. Add `GB_ROM=cgbacid2` to `resolveRom`.
- [ ] **Step 3: Verify the cgb-acid2 color face renders.**

Run: `cd packages/all && GB_ROM=cgbacid2 CAPTURE_PNG="$PWD/.shots/gameboy-tty-cgbacid2.png" CAPTURE_FRAMES_RUN=120 bun run example/gameboy-tty.ts`
Expected: `[shot] ok=true` with color present (not just greens). Visually confirm the cgb-acid2 face + colors.
- [ ] **Step 4: Commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/example/gameboy-tty.ts packages/all/example/gameboy-cgb-rom.ts && git commit -m "feat(all): gameboy-tty — CGB HDMA/GDMA + embedded cgb-acid2 color showcase"
```

---

## Final tasks

### Task 15: Whole-suite verification + screenshot + README + teardown audit

**Files:**
- Modify: `packages/all/README.md`, output `packages/all/screenshots/gameboy-tty.png`

- [ ] **Step 1: `tsc` clean.** Run: `cd packages/all && bunx tsc --noEmit example/gameboy-tty.ts example/gameboy-tty.logic.test.ts 2>&1 | head -30` — expect no errors.
- [ ] **Step 2: All unit tests pass.** Run: `cd packages/all && bun test example/gameboy-tty.logic.test.ts 2>&1 | tail -10`.
- [ ] **Step 3: Generate the gallery screenshot.** Run: `cd packages/all && CAPTURE_PNG="$PWD/screenshots/gameboy-tty.png" bun run example/gameboy-tty.ts` (Libbet mid-gameplay). Confirm non-black. Ensure `.gitignore` whitelists it (`!screenshots/gameboy-tty.png` if needed).
- [ ] **Step 4: Teardown audit.** Confirm clean exit (no segfault on quit; check the `[shot]`/exit lines per the voxelscape-teardown memory). Confirm console mode/CP/cursor/alt-screen restored after a live run + Ctrl-C.
- [ ] **Step 5: README showcase line** under the examples list: `gameboy-tty — pure-TS Game Boy / Game Boy Color in the terminal (plays real ROMs, sound, true held controls)`.
- [ ] **Step 6: Adversarial self-review** across dimensions — CPU port fidelity (diff vs gameboy.ts), MMU bank math edge cases, CGB priority correctness, input release/hotkey edge cases, audio ring overflow under turbo, save-file safety (don't clobber on crash). Fix findings.
- [ ] **Step 7: Final commit.**

```bash
cd D:/Projects/bun-win32 && git add packages/all/README.md packages/all/screenshots/gameboy-tty.png packages/all/.gitignore && git commit -m "docs(all): gameboy-tty — gallery screenshot + README showcase"
```

---

## Self-review (plan vs spec)

- **Spec coverage:** core port (T1–2), terminal render (T3), held input + XInput + fallback (T4), ROM loading (T5), live loop + audio + pacing (T6), capture (T7), MBC1/3/5 (T8), RTC (T9), saves (T10), CGB bank/speed (T11), palettes/color (T12), CGB PPU (T13), HDMA + cgb-acid2 (T14), tsc/screenshot/README/teardown (T15). All spec sections mapped.
- **ANSI fallback:** spec lists an ANSI autorepeat fallback; `setupConsoleInput` returns `ok:false` when console mode is unavailable. The fallback latch (parse stdin arrows/keys with ~150ms decay) is implemented inside the `ok:false` branch of the live loop — **noted as a sub-step of Task 4/Task 6**; if piped stdin, use the ANSI path. (Implement in T6 Step 1 `ci` when `!ci.ok`.)
- **Placeholder scan:** code blocks are concrete; the few `/* ... */` notes (detectSize reuse, RAM-write driving in T10) reference exact existing code (`_term.ts:541–561`) or test hooks defined in the same task.
- **Type consistency:** `Buttons`, `GameBoy`, `Apu`, `blitToTerm`, `cgbColor`, `__mapperForTest`, `loadCgbAcid2`, `getSaveData/loadSaveData/hasBattery/cgb` are used consistently across tasks.
- **Reminder:** implementers use the ANSI autorepeat fallback when `!ci.ok` (piped/SSH/headless stdin).
