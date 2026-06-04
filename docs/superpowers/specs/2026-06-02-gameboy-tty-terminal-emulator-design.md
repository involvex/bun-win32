# gameboy-tty — a Game Boy / Game Boy Color emulator that plays in the terminal

**Date:** 2026-06-02
**Status:** Approved (design), implementation staged
**Author:** brainstormed with the user

## Summary

A new `@bun-win32` example, `packages/all/example/gameboy-tty.ts`, that renders a
pure-TypeScript Game Boy (DMG) **and Game Boy Color (CGB)** emulator into the
terminal using half-block truecolor "pixels", with authentic held-button
controls, sound, and the ability to load and play real `.gb`/`.gbc` ROM files —
including the user's own legally-dumped cartridges.

It reuses the proven, screenshot-verified emulator core from the existing GPU
demo `gameboy.ts` (full SM83 CPU, scanline PPU, 4-channel APU, timers,
interrupts) by **porting it into a single self-contained file** and extending it
for Color and broader cartridges. The existing `gameboy.ts` GPU demo and its
gallery screenshot are left untouched (zero regression risk).

## Goals

- It feels like playing a Game Boy: smooth, low-latency, true held-button D-pad.
- Plays real ROMs the user supplies on the command line (`.gb` and `.gbc`).
- Windows-only, built entirely on `@bun-win32` FFI, performance-maximized.
- Sound via the existing APU → XAudio2.
- Fits the repo's example conventions: one file, a `package.json` script, and a
  deterministic `CAPTURE_PNG` headless gallery shot.

## Non-goals

- Not a cycle-perfect/sub-instruction-accurate emulator (the ported core is
  scanline-accurate, which passes dmg-acid2 and runs commercial games).
- No link cable / serial peripherals, no Super Game Boy borders, no save states
  in v1 (battery `.sav` only). Save states are a possible follow-up.
- No downloading of pirated commercial ROMs. See "ROM legality".

## ROM legality

Commercial ROMs (e.g. Pokémon) are copyrighted Nintendo IP and will **not** be
downloaded. Instead:

- Full **MBC3 + RTC** is implemented so the user's own legally-dumped Pokémon
  cartridge (R/B/Y are DMG MBC3; G/S/C are CGB MBC3+RTC) plays.
- Verification uses only free/legal ROMs: the already-bundled **dmg-acid2** (PPU
  acceptance test) and **Libbet and the Magic Floor** (zlib homebrew), plus an
  embedded **cgb-acid2** (MIT, by mattcurrie) as a built-in Color showcase.

## Architecture

One new file, `packages/all/example/gameboy-tty.ts`. Imports only shared engines
that other examples already use:

- `../index` — `Kernel32` (console input + handles), `Xinput1_4` (gamepad).
- `./_term` — `Term` (half-block truecolor framebuffer + diffed `present()`),
  `makeFrameWaiter` (precise 60fps pacing), `encodePNG` (headless capture).
- `./_audio` — `createPcmOutput` (XAudio2 stereo PCM).
- `./gameboy-rom` (`loadAcid2`), `./gameboy-game-rom` (`loadLibbet`) — bundled
  default/showcase ROMs. A new embedded `cgb-acid2` loader is added (either in
  this file or a small sibling data file; data file is acceptable as it is data,
  not logic, mirroring the existing ROM data files).

The emulator core (CPU/MMU/PPU/APU) lives **inside** `gameboy-tty.ts`, ported
verbatim from `gameboy.ts` then extended. This honors the "one file" request and
keeps the working GPU demo untouched.

### Components

1. **CPU (SM83/LR35902)** — ported as-is. 256 base + 256 CB opcodes, correct
   flags + cycle counts, interrupts, HALT. Identical for DMG and CGB.
2. **MMU** — extended. Address decode + the cartridge mappers:
   - **MBC0** (ROM only) — as-is.
   - **MBC1** — completed: RAM enable, 5-bit + 2-bit bank registers, mode 0/1,
     RAM banking, mode-1 bank-0/​upper-ROM remap for ≥1 MiB carts.
   - **MBC3** — new: 7-bit ROM bank (0→1), RAM bank 0–3 or RTC register select
     0x08–0x0C, RTC latch (0x6000–0x7FFF write 0→1), RTC registers
     (S/M/H/DL/DH with halt + day-carry), host-wall-clock backed with a
     persisted base offset.
   - **MBC5** — new: 9-bit ROM bank (low byte @2000–2FFF, high bit @3000–3FFF),
     RAM bank 0–15, RAM enable. (Rumble bit ignored.)
   - **Battery save** — carts with battery persist external RAM (and RTC) to
     `<rom>.sav` beside the ROM: loaded on boot, written on exit + periodic
     autosave.
   - **CGB registers** — VBK (VRAM bank), SVBK (WRAM bank), KEY1 (speed switch),
     BCPS/BCPD + OCPS/OCPD (palette RAM), HDMA1–5 (VRAM DMA), OPRI.
3. **PPU** — dual-mode:
   - **DMG path** — ported as-is (4 classic greens; selectable palette).
   - **CGB path** — new: per-tile BG attributes from VRAM bank 1 (palette/bank/
     X-flip/Y-flip/BG-priority), CGB OBJ attributes (8 OBJ palettes, tile VRAM
     bank), 8×4 BG + 8×4 OBJ 15-bit color palettes from palette RAM, master
     priority rules. 15-bit RGB → 24-bit via standard CGB LCD color correction
     so colors are vivid, not washed.
4. **APU** — ported as-is (square+sweep, square, wave, noise; frame sequencer;
   stereo resample to host rate). Feeds XAudio2.
5. **Timers / interrupts / DMA** — ported; OAM DMA as-is; HDMA/GDMA added for
   CGB (general transfer immediate; H-blank transfer 16 bytes per H-blank).
6. **Double-speed** — KEY1 bit0 armed + STOP toggles CPU speed; the frame loop
   runs ~140448 T-cycles/frame in double-speed (timers/serial/CPU scale; PPU
   dot clock and APU stay 1×).

### Terminal front-end

- **Render**: each emulated frame (~59.7 Hz) the core paints a 160×144 RGBA
  buffer; it is blitted into the `Term` pixel grid with integer scale-to-fit +
  centering + a tasteful dark console bezel. Native 1:1 is 160 cols × 72 rows;
  nearest-neighbor scaling covers any terminal size. `Term`'s diffing
  `present()` keeps throughput well above 60fps; `makeFrameWaiter` paces it.
- **Input — true held buttons**: `ReadConsoleInputW` on the std input handle put
  in raw mode (line input + echo + VT-input off) yields real KEY_DOWN/KEY_UP
  `INPUT_RECORD`s; a live keyboard-state set (keyed by virtual-key code) is the
  button state, exactly like a pad. Read non-blocking each frame via
  `GetNumberOfConsoleInputEvents` + `ReadConsoleInputW`. INPUT_RECORD is 20
  bytes on x64 (WORD EventType @0, pad, BOOL bKeyDown @4, WORD repeat @8, WORD
  vk @10, WORD scan @12, WCHAR @14, DWORD ctrl @16); KEY_EVENT = 1.
  - **XInput** gamepad OR'd in (controller 0), same mapping as `gameboy.ts`.
  - **Fallback**: if console input is unavailable (piped/SSH/headless), use the
    house ANSI autorepeat-decay latch (≈150 ms), matching `voxel-flight.ts`.
  - **VT output** stays enabled on the *output* handle (separate from input
    mode) so truecolor rendering is unaffected.
- **Controls**: arrows = D-pad, `Z` = A, `X` = B, `Enter` = Start,
  `RShift` = Select. Hotkeys: `Esc`/`Ctrl-C` quit, `M` mute, `R` reset,
  `Tab` turbo (fast-forward while held), `P` pause, `[`/`]` cycle DMG palette.
- **Audio**: the APU is drained each frame and submitted to XAudio2
  (`_audio.createPcmOutput`), the proven pattern from `gameboy.ts`; `M` mutes;
  silent if no endpoint.
- **ROM loading**: `bun run example/gameboy-tty.ts <path.gb|.gbc>` (or
  `GB_ROM=<path>`); default = bundled Libbet so it runs out of the box.
  `GB_ROM=acid2` / `GB_ROM=cgbacid2` select the built-in test ROMs.
- **Headless capture**: `CAPTURE_PNG=<path>` (+ optional `DEMO_DURATION_MS` and
  a scripted input timeline like `gameboy.ts`) renders a deterministic frame to
  PNG via `encodePNG`/`Term.toPNG()` and exits → `screenshots/gameboy-tty.png`.
- **`package.json`**: add `"gameboy-tty": "bun run example/gameboy-tty.ts"`.
- **HUD**: a compact status line (title · ROM · fps · ♪) drawn with `Term.text`,
  kept outside the screen rectangle.

## Data flow (one live frame)

1. Poll input (Win32 console held-state → keyboard set → GB buttons; OR XInput;
   handle hotkeys).
2. `gb.runFrame()` — steps CPU→timers→PPU→APU until VBlank; paints `gb.frame`.
3. Drain APU → submit PCM to XAudio2 (skip if muted/turbo-overrun).
4. Blit `gb.frame` (160×144 RGBA) → `Term` pixel buffer (scale + center + bezel).
5. Draw HUD; `term.present()` (diffed write).
6. `makeFrameWaiter` waits to hit ~59.7 Hz (turbo skips the wait + may frameskip).

## Error handling

- Missing/oversized/garbage ROM → clear message + exit non-zero; unknown mapper
  type → warn and fall back to flat ROM read (best effort) rather than crash.
- No audio endpoint → silent (createPcmOutput no-op), as in `gameboy.ts`.
- Console-input setup failure → ANSI fallback, demo still runs.
- Teardown restores console mode/CP/cursor/alt-screen; saves battery RAM; avoids
  the known heavy-teardown exit segfault by releasing in the proven order.

## Testing / verification

- **CPU**: already proven by `gameboy.ts`; spot-checked by running dmg-acid2.
- **PPU (DMG)**: `GB_ROM=acid2` capture must render the dmg-acid2 face (the same
  visual pass/fail the GPU demo uses), now via the terminal PNG.
- **PPU (CGB)**: `GB_ROM=cgbacid2` capture must render the cgb-acid2 color face.
- **MBC/save**: load a large MBC3/MBC5 + battery ROM (user-supplied or homebrew),
  confirm banks read correctly and `.sav` round-trips across runs.
- **Playability**: boot Libbet (and any user ROM), confirm responsive held-input
  movement and audio.
- **Headless**: `CAPTURE_PNG` produces a non-black PNG with expected luma; a
  small in-example logic check (button-bit mapping, INPUT_RECORD field offsets,
  MBC bank math) lives as `gameboy-tty.logic.test.ts` style asserts or an inline
  self-test guarded by an env flag, mirroring `voxelscape.logic.test.ts`.
- `tsc` clean; example loads without the GPU stack.

## Build staging (each a working, verifiable milestone)

1. **DMG complete** — port core + terminal render + Win32 held-input + audio +
   ROM loading + capture. Verifies on dmg-acid2 + Libbet (+ Pokémon R/B/Y class).
2. **Full MBC + saves** — complete MBC1, add MBC3(+RTC) + MBC5 + battery `.sav`.
3. **CGB color** — VBK/SVBK/KEY1/palettes/attributes/HDMA + color correction;
   embed + verify cgb-acid2.

## Risks / honest constraints

- Heaviest CGB titles at double-speed in pure TS, on a terminal, may dip below
  60fps; `Tab` turbo + optional frameskip mitigate. DMG games (incl. Pokémon
  R/B/Y) will be smooth.
- True held-input requires Windows Terminal/conhost (the project's target);
  piped/SSH stdin uses the ANSI fallback.
- Terminal must be reasonably large for 1:1 (160×72 cells); otherwise the image
  nearest-scales down (still playable, less crisp).
