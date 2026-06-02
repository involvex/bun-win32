# Interactive Terminal Demos — Design Spec

**Date:** 2026-06-02
**Status:** Approved (build all 5, per-demo aesthetic direction)

## Goal

Push the limits of what a terminal can do. Five **interactive** truecolor terminal
demos built on the existing `_term.ts` engine, each blowing the user away with
visual quality *and* 60 FPS performance. Each targets a distinct interaction
modality and a distinct rendering technique. No cliché (no matrix rain, no
plasma, no bouncing logo).

The existing terminal demos (`blackhole-tty`, `galaxy-tty`, `mandel-dive`,
`flowfield`, `torus-knot`, `fluid-ink`, `reaction`, `cinema`, `clawd`) are all
**passive**. These five are the first **interactive** ones.

## The Engine (`./_term`) — what build agents must use

`runDemo(spec)` drives everything. Key facts (verified by reading `_term.ts`):

- **Framebuffer:** `t.W = cols`, `t.H = rows*2` pixels (each terminal cell is two
  stacked half-block pixels). `t.buf` is `Uint8Array` RGB, length `W*H*3`.
- **Pixel ops:** `t.setPixel(x,y,r,g,b)`, `t.addPixel` (additive), `t.blendPixel(x,y,r,g,b,a)`,
  `t.clear(r,g,b)`, `t.plate(x,y,w,h,a)` (dark panel), `t.text(px,py,str,r,g,b,scale,shadow)`,
  `Term.textWidth(str,scale)`.
- **Math/color helpers exported:** `clamp, clamp01, lerp, smoothstep, fract, TAU,
  aces, hsv(h,s,v)->[r,g,b], mulberry32(seed)->()=>n, hash2(x,y)`.
- **Input (LIVE mode only):**
  - `mouse: true` in spec enables xterm SGR mouse. Then read each frame:
    `t.mouseX, t.mouseY` (pixel coords, 0-indexed clamped), `t.mouseDown` (left held),
    `t.mouseInside`, `t.mouseActive` (any event seen), `t.mouseSeq` (++ per event),
    `t.wheel` (accumulated ticks ±1 — **read AND reset it yourself each frame**).
  - `onKey(key, t)`: `'up'|'down'|'left'|'right'`, `'space'` (also toggles built-in
    pause), printable chars lowercased, `'q'`/`ESC`/Ctrl-C exit. ENTER and BACKSPACE
    arrive as raw chars — handle `'\r'`/`'\n'` and `'\x7f'`/`'\b'` inside the onData
    char path (they are passed to `onKey` lowercased; verify which code arrives by
    testing, and treat charCode 127/8 as backspace, 13/10 as enter).
- **Frame callback:** `frame(t, time, dt, frameNo)`. `time` = accumulated sim
  seconds (pauses on space), `dt` = clamped delta (0 when paused), `frameNo` = counter.
- **Capture/bench (DETERMINISTIC, no input):**
  - `CAPTURE_PNG=path` → render one frame at `CAPTURE_T` (default 4s) to PNG.
  - `CAPTURE_FRAMES=n` → n PNGs (path.0.png …) spread over `[0, CAPTURE_T]`.
  - `CAPTURE_FPS`, `TERM_COLS`, `TERM_ROWS` for reproducible output.
  - `BENCH=1 BENCH_FRAMES=600` → prints `{demo,fps,msPerFrame,...}` JSON, measures
    sim+buildFrame ceiling (no terminal I/O).
  - `DEMO_DURATION_MS=ms` → auto-exit live mode (for CI smoke runs).

## Shared conventions (ALL five demos MUST follow)

1. **File:** `packages/all/example/<name>.ts`. Single file. ESM. `import { ... } from './_term'`.
2. **Determinism:** all randomness via `mulberry32(seed)`. All motion from `time`/`dt`.
   Never `Date.now()`/`Math.random()`. This makes capture/bench reproducible.
3. **Attract mode (CRITICAL):** input does NOT fire in capture/bench mode, so each
   demo MUST animate compellingly with zero input, driven purely by `time`. When no
   input has occurred (`!t.mouseActive` and no key yet, or idle for ~3s), run a
   scripted "attract" performance so (a) `CAPTURE_PNG` shows a rich, full frame and
   (b) the demo looks alive the instant it launches. As soon as the user interacts,
   hand control to them; resume attract after a few idle seconds.
4. **Decouple internal resolution from terminal size.** Render the sim/scene at a
   fixed internal resolution or directly in pixel space, and reflow on `resize`
   (re-`init`). Read `t.W/t.H/t.aspect` every frame; never hardcode dimensions.
5. **No allocations in the hot loop.** Allocate typed arrays in `init`; reuse them.
   Precompute LUTs (trig, palettes) where it helps.
6. **HDR + ACES.** Accumulate light additively where appropriate and tonemap with
   `aces` for rich, non-clipped imagery. Use `hsv` for palettes.
7. **HUD — FPS IS MANDATORY (non-negotiable):** EVERY demo MUST visibly show its
   live FPS at all times. Half-block demos keep the default `runDemo` FPS HUD (do
   NOT set `drawHud:false`). Char-grid demos: `runTextDemo` ALWAYS renders an FPS
   readout (tasteful — e.g. top-right corner or a status/menu bar); there is no
   opt-out, and #6/#8 must integrate it into their UI chrome rather than hide it.
   Also put a one-line controls hint in `hud:` (e.g. `"DRAG TO STIR · SCROLL ZOOM"`).
8. **`import.meta.main` guard not required** (runDemo is the entry), but do NOT run
   any heavy work at module top level — only inside `init`/`frame`.
9. **Performance target:** `BENCH=1 TERM_COLS=160 TERM_ROWS=50` ≥ **90 fps**
   (aim ≥150 for the light ones). Live `targetFps: 60`.
10. **Verify by running, not by reading.** Each must pass:
    `CAPTURE_PNG=<scratch>/<name>.png CAPTURE_FRAMES=4 TERM_COLS=160 TERM_ROWS=50 bun run <name>.ts`
    producing 4 non-trivial PNGs (not blank/all-black), plus a clean `BENCH` run,
    plus `DEMO_DURATION_MS=1500 bun run <name>.ts` exiting cleanly.

## The five demos

### 1. `voxel-flight.ts` — fly over an infinite procedural world
- **Modality:** fly/walk. WASD or arrows move (forward/back/strafe), mouse-look
  (horizontal aim + pitch), scroll = altitude, shift = boost. Attract: auto-fly a
  smooth banking path over the terrain.
- **Technique:** Comanche-style voxel-space terrain raycasting. Per screen column,
  march outward over a procedural heightmap+colormap (fBm noise), maintain a
  per-column y-buffer / max-height occlusion for front-to-back fill and early-out.
  Project height to screen, fill column from horizon down. Atmospheric distance fog
  to a sky gradient, a sun disk with horizon glow, subtle cloud shadow.
- **Aesthetic:** golden-hour flight-sim. Warm sun, hazy blue distance, saturated
  near terrain (grass/rock/snow by altitude), soft fog. Cinematic, natural light.
- **Perf:** column raycast O(cols × depthSteps) with step growth + occlusion early-out.
  Should be very fast. Cap depth ~ a few hundred steps with increasing step size.
- **Accept:** capture shows recognizable lit 3D terrain + horizon + sun, not noise.

### 2. `inkwell.ts` — stir a real fluid with your cursor
- **Modality:** follows the mouse. Mouse motion injects velocity along the drag
  vector; holding the button injects luminous dye at the cursor; wheel changes dye
  hue. Attract: scripted invisible "cursor" traces flowing curves that inject dye.
- **Technique:** stable-fluids on a fixed grid (e.g. ~128×72): semi-Lagrangian
  advection, ~20–30 Jacobi pressure-projection iterations, vorticity confinement for
  swirl, dye field advected by velocity. Bilinear upsample grid → pixels. HDR
  additive dye glow + `aces`.
- **Aesthetic:** luminous ink in black void — deep blacks, saturated dye that blooms
  where dense, hue shifts with motion. Elegant, hypnotic.
- **Perf:** keep grid modest; Jacobi iteration count tuned to hold ≥90 bench fps.
- **Accept:** capture shows swirling colored dye structures with visible flow, bloom.

### 3. `powder.ts` — a falling-sand sandbox
- **Modality:** paint. Mouse paints the current material in a brush; `mouseDown`
  paints; number keys `1..8` select material; wheel = brush size; `c` clears.
  Attract: auto-pours alternating streams (sand, water, then drops fire onto oil).
- **Technique:** cellular grid at pixel resolution. Per frame, update bottom-up with
  alternating left/right scan to avoid directional bias. Materials & rules: SAND
  (falls, piles, displaces water), WATER (falls + spreads, flows), OIL (lighter than
  water, floats, flammable), FIRE (rises, ignites oil/plant, dies out, leaves
  smoke), LAVA (flows slow, ignites, + water → STONE), STONE/WALL (static), PLANT
  (grows into adjacent water, burns). Per-cell color jitter via `hash2` for texture.
- **Aesthetic:** tactile material palette — warm sand, translucent blue water,
  glowing fire/lava with emissive bloom, earthy stone, green plant. Cohesive, juicy.
- **Perf:** one O(W·H) pass/frame; W·H≈16k cells — fine. Use Int8/Uint8 cell grid +
  a velocity/extra Uint8 for water flow direction.
- **Accept:** capture shows piled materials with active physics (falling/spreading),
  fire/lava emissive.

### 4. `orbits.ts` — build galaxies with gravity
- **Modality:** click + fling. Click places a star; click-drag-release flings it
  with velocity proportional to the drag (slingshot, with an aiming line + ghost
  trail while dragging). Wheel = mass of next star. `g` toggles a central massive
  attractor. Attract: seeds a pre-built multi-body system that evolves into orbits.
- **Technique:** direct N-body gravity with softening (Plummer) and symplectic/
  leapfrog integration for stable orbits. Cap N (~200) — merge on close approach
  (mass-weighted, conserve momentum) into brighter bodies → accretion. Glowing
  motion-blur trails via a persistent additive buffer faded each frame. `aces`.
- **Aesthetic:** stars as hot HDR points (color by mass/speed: blue-hot heavy/fast →
  warm light), velvet-black space, luminous trails. Restrained, astronomical.
- **Perf:** O(N²) with N≤~200 is fine at 60fps. Trail buffer fade is O(W·H).
- **Accept:** capture shows multiple bodies on curved trajectories with glowing trails.

### 5. `glyphstorm.ts` — type and watch words come alive
- **Modality:** type. Printable keys append glyphs; each spawns a swarm of particles
  that flock into the 5×7 letterform at a target position; BACKSPACE dissolves the
  last glyph back into drifting sparks; ENTER starts a new line / bursts the current
  word outward; particles are gently attracted toward the cursor (mouse). Attract:
  auto-types a rotating set of words (e.g. `TERMINAL`, `60 FPS`, `CLAUDE CODE`),
  holds, then dissolves and types the next.
- **Technique:** particle system (few thousand). Each glyph’s target pixels come from
  the engine font (rasterize the 5×7 glyph into target points). Particles spring
  toward targets with damping + curl-noise drift; additive HDR rendering + bloom so
  letters glow as they coalesce. Color = per-word hue ramp.
- **Aesthetic:** neon constellation — glowing particles assembling into crisp
  luminous text on black, with motion trails. Kinetic, premium. (Neon used
  tastefully, not garish.)
- **Perf:** O(particles) springs; cap ~4–6k particles. Fine.
- **Accept:** capture shows readable glowing text formed from particles (attract mode
  has typed a word by `CAPTURE_T`).

### 6. `claude-tui.ts` — a living Claude Code UI (built on `_textterm.ts`)
- **Goal:** prove we can render real UIs in the terminal. A faithful, animated
  recreation of the Claude Code TUI — not a static mock.
- **Modality:** type. A bottom input box with `>` prompt + blinking cursor accepts
  typed chars (printable append, backspace deletes, enter "sends"). Arrows / wheel
  scroll the transcript. Mouse hover subtly highlights the hovered transcript row.
  Attract: auto-plays a scripted "session" — types a prompt char-by-char, shows the
  assistant streaming a reply token-by-token with a spinner ("✻ … esc to interrupt"),
  a bordered tool-use block (e.g. a `Read`/`Bash` call), a red/green unified diff,
  a TODO checklist filling in, then loops with a fresh prompt.
- **Render (char grid):** rounded box-drawing for the input + tool panels, the clay
  accent `(235,130,90)`, grays for chrome, syntax-highlighted code in a code block,
  diff coloring, a braille/dot spinner. Use `_textterm`'s box-draw + style cells.
- **Aesthetic:** the real Claude Code look — dark, clay accent, restrained, crisp.
- **Perf:** transcript is mostly static → the engine's diff makes it nearly free;
  only the streaming line, spinner, and cursor change per frame. Trivially 60 fps.
- **Accept:** capture is unmistakably a Claude Code session (input box + cursor,
  streaming assistant text, a tool/diff block, todos), readable glyphs.

### 7. `chromascii.ts` — high-detail colored ASCII renderer (built on `_textterm.ts`)
- **Goal:** push char-grid rendering to the limit. Real-time, full-color ASCII with
  a luminance→glyph ramp AND edge-detected contour glyphs. Creative, high detail.
- **Modality:** orbit. Mouse drag rotates the object; scroll zooms; keys cycle the
  glyph ramp (`" .:-=+*#%@"`, blocks `░▒▓█`, custom) and palette. Attract: slow
  auto-rotation through a lit turntable.
- **Technique:** per CELL, raymarch/shade a 3D scene (a morphing metaball blob or a
  (p,q) torus knot SDF) with multi-light normal shading → map luminance to a fine
  character density ramp; run a Sobel pass on the luminance field to detect
  silhouettes/creases and overlay directional line glyphs (`/ \ | - _ ( )`) for an
  inked look; color each glyph in truecolor by normal/material/depth. Supersample
  (≥2×2) per cell for detail; render at the char-grid resolution.
- **Aesthetic:** hand-inked engraving meets neon — luminous shaded form, crisp
  contour lines, rich color ramp on black. High detail, nothing cheap.
- **Perf:** the headline performance demo — per-cell raymarch with bounded steps,
  LUT-driven ramp, adaptive supersampling; must stay ≥60 fps live at full grid and
  report bench fps. Push it (it's the "absolute limits" demo).
- **Accept:** capture shows a recognizable, well-shaded 3D form rendered in varied
  colored characters with visible contour line work — not noise, not a flat blob.

### Engine: `_textterm.ts` — a character-grid renderer (foundation for #6 & #7)
A sibling to `_term.ts` that renders a grid of **styled character cells** instead of
half-block pixels. Built FIRST; its public API is frozen once verified.
- **Cell model:** per cell `{ char (codepoint), fg RGB, bg RGB, bold? }`. A
  `CharTerm` exposing `cols/rows`, `put(x,y,ch,fg,bg?,bold?)`, `text(x,y,str,fg,bg?)`,
  `box(x,y,w,h,style,fg,bg?)` (rounded/sharp/double box-drawing), `hline/vline`,
  `fillRect`, `clear()`. Same console setup as `_term` (Windows kernel32 VT + UTF-8 +
  alt-screen + hide cursor + raw mode + SGR mouse), same teardown/SIGINT safety.
- **Diffed output:** per-cell dirty diff (char+fg+bg key), single `stdout.write` per
  frame, run-length pen control — same performance discipline as `_term`.
- **Harness:** `runTextDemo(spec)` mirroring `runDemo` — `init/frame/onKey/mouse`,
  `time/dt/frameNo`, `targetFps`, `drawHud`, and the SAME env-var modes:
  `CAPTURE_PNG` (+`CAPTURE_FRAMES`/`CAPTURE_T`/`CAPTURE_FPS`), `BENCH`,
  `TERM_COLS/ROWS`, `DEMO_DURATION_MS`.
- **PNG capture (for headless verification):** rasterize the cell grid to an RGB
  image. ASCII printable from a compact embedded bitmap font (≈6×10); box-drawing,
  block (▀▄█▌▐), and shading (░▒▓) glyphs rasterized **procedurally** (draw
  lines/fills/partial blends by codepoint) so no huge atlas is hand-authored. Reuse
  `encodePNG` and helpers imported from `./_term`.
- **Ship `_textterm.selftest.ts`** (font atlas + box + shading + color ramp) like
  `_term.selftest.ts`, and a `CAPTURE_PNG` of it for verification.

### 8. `desktop.ts` — a windowing desktop environment in the terminal (on `_textterm.ts`)
- **Goal:** a mock macOS/Windows desktop — overlapping draggable windows with real
  title bars, a menu/task bar, soft shadows, z-order, focus — all interactive. The
  "we can render a whole OS" showcase.
- **Compositor:** a window manager layer over `CharTerm`. Each window: title bar
  (text title + traffic-light/min-max-close buttons), border, content region, drop
  shadow (darken the cells behind/below-right by blending bg toward black), z-order
  stack, focus highlight. Drag title bar to move; click to raise/focus; click a
  button to close/minimize. A top menu bar or bottom dock with a live clock and app
  launchers; an animated wallpaper (gradient + drifting shading-char texture).
- **Apps (windows):**
  - **Notepad** — editable multi-line text area with a real **blinking caret**;
    printable keys insert at caret; backspace/enter/arrows/home/end work; soft word
    wrap; the focused window receives keystrokes. This is the headline interaction.
  - **Video player** — a window playing a looping animated colored-ASCII "clip"
    (reuse the `chromascii` shading technique inside the content region) with a
    transport bar: play/pause button, a scrubber that advances, elapsed/total time.
  - **A third app** — a live analog/digital **Clock** or a faux **Terminal** window
    with a typing prompt (builder's choice; keep it tasteful and detailed).
- **Modality:** mouse (drag windows, click focus/buttons/dock) + keyboard (routed to
  focused Notepad). Attract: scripted — windows fade/scale in, a synthetic cursor
  glides over, drags a window, focuses Notepad and types a sentence (caret visible),
  the video plays and scrubs. Then loops.
- **Aesthetic:** clean modern OS — tasteful wallpaper, soft window shadows, subtle
  translucency feel via bg blending, a crisp accent. macOS- or Win11-flavored.
- **Perf:** mostly-static chrome → diff makes it cheap; only the focused window
  content, video region, clock, caret blink, and any dragged window change. 60 fps.
- **Accept:** capture shows multiple overlapping windows with title bars + shadows,
  a Notepad with visible caret/text, a video-player window with transport, a
  clock/terminal, and a dock/menu bar — unmistakably a desktop.

## Verification plan

1. **Per-demo self-verify (build agent):** runs CAPTURE (4 frames), BENCH, and a
   1.5s live smoke run; confirms PNGs are non-blank and fps ≥ target.
2. **Adversarial verify (independent agent):** opens the PNG filmstrip, tries to
   prove the demo is broken/empty/ugly/below-fps; reports defects.
3. **Human visual check (main loop):** I inspect the PNG filmstrips myself before
   declaring done (per project rule: verify visually, not numerically).
4. **Final sweep:** repo-wide `tsc` clean; the five files added with no regressions.

## Audit / improvement loop (after all 8 + engine are built & verified)
Four sequential rounds. Each round, a **fresh** agent per target reviews for
performance AND visual-quality improvements and implements them, then self-verifies
(capture + bench + smoke, no regressions). Rounds are sequential (round N+1 sees
round N's changes); within a round, targets run in parallel.
- File ownership is strict: each audit agent edits ONLY its one target file. The
  shared `_textterm.ts` engine is its own lane (single owner per round); demo agents
  must not touch it. This prevents index races and prevents an agent from running a
  demo whose engine another agent is mid-editing.
- Between rounds the coordinator (main loop) inspects PNG filmstrips visually and
  runs a repo-wide `tsc` sweep; regressions are fixed before the next round.

## Out of scope
- No audio. No GPU/FFI (these are pure-CPU terminal demos). No network.
- Avoid touching `_term.ts`; prefer handling raw chars in `onKey`. `_textterm.ts` is
  a NEW sibling engine (not a modification of `_term.ts`).

## File list (deliverables)
- `packages/all/example/_textterm.ts` (new char-grid engine) + `_textterm.selftest.ts`
- `packages/all/example/voxel-flight.ts`  (half-block, `_term`)
- `packages/all/example/inkwell.ts`        (half-block)
- `packages/all/example/powder.ts`         (half-block)
- `packages/all/example/orbits.ts`         (half-block)
- `packages/all/example/glyphstorm.ts`     (half-block)
- `packages/all/example/claude-tui.ts`     (char grid, `_textterm`)
- `packages/all/example/chromascii.ts`     (char grid, `_textterm`)
- `packages/all/example/desktop.ts`        (char grid, `_textterm`)
