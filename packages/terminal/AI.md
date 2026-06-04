# AI Guide for @bun-win32/terminal

How to use this package. Everything below is reachable from `@bun-win32/terminal` alone. Bun + Windows only. This file is the complete surface — an agent should not need to read source to use it.

## What it is

An extreme-performance terminal engine. Two surfaces share one zero-allocation, single-write core:

- **`Term`** — a 24-bit RGB framebuffer drawn as Unicode block glyphs (games, video, procedural scenes).
- **`CharTerm`** — a character-cell grid with box/shade glyphs and bold (TUIs, dashboards, CLIs).

Drive a surface yourself (`buildFrame`/`present`), or hand a spec to **`run`** / **`runText`** for a managed loop (live, plus headless `CAPTURE_PNG` and `BENCH` modes from env).

## Mental model (read this first)

- **`Term` has two grids.** A character grid `columns × rows` (fixed) and a pixel grid `width × height` where `width = columns × pixelW`, `height = rows × pixelH`. `pixelW × pixelH` per mode: `half`/`ascii` 1×2, `quad` 2×2, `sextant` 2×3, `octant`/`braille` 2×4. You draw in **pixels**; the renderer packs each cell's sub-pixels into one glyph + two colours.
- **Write pixels, then present.** Fill `surface.pixels` (a `Uint8Array`, length `width*height*3`, row-major RGB) directly for raw throughput, or use the draw methods. Then `present()` (live) or `buildFrame()` + `frameBytes()` (headless / custom sink).
- **Frames are diffed.** Only cells whose emitted bytes changed are re-sent; the SGR pen persists across frames. A static frame costs ~3 bytes. You never clear the screen yourself.
- **The framebuffer persists between frames** — `present()` does not clear it. Call `clear()` (or overwrite every pixel) each frame for animation.

## Capability → API

| Need | Use |
| --- | --- |
| Pixel framebuffer | `new Term(columns, rows, { mode?, diff?, depth?, dither?, threshold? })` → write `surface.pixels` or `setPixel`/`addPixel`/`blendPixel` |
| Shapes | `line` `rect` `fillRect` `circle` `fillCircle` `addCircle` (soft additive glow) `blit`; `clip(x,y,w,h)` / `noClip()` |
| Text / HUD (pixel) | `surface.text(x,y,str,r,g,b,scale?,shadow?)`, `surface.plate(x,y,w,h,alpha?)`, `Term.textWidth(str,scale?)` |
| TUI cells | `new CharTerm(columns, rows)` → `put` `text` `fillRect` `shadeRect` `hline` `vline` `box`, with `BOX`/`BLOCK` glyphs |
| Sub-cell detail | `mode`: `half`(default) `quad` `sextant` `octant` `braille` `ascii` — pixels/cell, low→high: 2,4,6,8,8,2 |
| Fewer bytes/frame | `depth`: `truecolor`(default) `256` `16`; `diff`: `exact`(default) `threshold` `none` |
| Smooth low-colour | `dither: 'ordered'` — Bayer dithering on `16`/`256` (kills banding; no effect at `truecolor`; default `none`) |
| Run an app | `run(spec)` (pixel) / `runText(spec)` (char) — live loop + `CAPTURE_PNG`/`BENCH` |
| Present a frame | `surface.present({ sync?, sink? })` — `sync` = tear-free (DEC 2026), `sink` = redirect bytes (record / socket) |
| Input (live loop) | `spec.onKey(key, surface)`; `spec.mouse: true` → `surface.mouse.{x,y,down,wheel,inside,active,sequence}`; `spec.onFocus`, `spec.onPaste` |
| Partial redraw | `surface.markDamage(x,y,w,h)` before `present()` (caller contract: rest is unchanged); `clearDamage()` to cancel |
| Raw session | `new ConsoleSession({mouse?,title?})` + `new ConsoleInput({focus?,key?,paste?,pointer?,resize?})` (`poll()` per frame) + `createFrameWaiter()` |
| Headless image | `surface.toPNG()` → PNG bytes; `encodePNG(rgb, w, h)` |
| Feature discovery | `CAPABILITIES` (modes/diffs/depths/dithers/features/options); `detectCapabilities()`; `detectConsoleSize()` |

## Full API

### `class Term` — pixel framebuffer
Fields: `pixels` (Uint8Array `w*h*3`, writable), `width` `height` (pixels), `columns` `rows` (readonly cells), `aspect` (=w/h), `mode` `diff` `depth` `dither` `threshold` (mutable, inspectable), `mouse` (`MouseState`, coords in **pixels**).
- `clear(r=0, g=0, b=0)` — fill the framebuffer with one colour.
- `setPixel(x, y, r, g, b)` — write one pixel, bounds-checked, clamped 0..255.
- `addPixel(x, y, r, g, b)` — additive blend into one pixel (clamps high end).
- `blendPixel(x, y, r, g, b, alpha)` — alpha-over (alpha≤0 no-op, ≥1 overwrite).
- `plate(x, y, w, h, alpha=0.55)` — darken a rect toward black (HUD backdrop).
- `clip(x, y, w, h)` / `noClip()` — restrict the shape methods to a sub-rect.
- `line(x0, y0, x1, y1, r, g, b)` — 1px Bresenham. respects clip.
- `rect(x, y, w, h, r, g, b)` / `fillRect(x, y, w, h, r, g, b)` — outline / filled. respect clip.
- `circle(cx, cy, radius, r, g, b)` / `fillCircle(cx, cy, radius, r, g, b)` — outline / filled disk. respect clip.
- `addCircle(cx, cy, radius, r, g, b, intensity=1)` — **soft additive radial splat** (bloom / glow / particle); centre brightest, quadratic falloff to 0 at radius; saturates; respects clip. Stack for light accumulation.
- `blit(srcRgb, srcW, srcH, dstX, dstY)` — copy a tightly packed RGB image. respects clip.
- `text(x, y, str, r, g, b, scale=1, shadow=true): number` — 5×7 font; returns advance width in px; `shadow` draws a 1px black offset.
- `static textWidth(str, scale=1): number` — `str.length * 6 * scale`.
- `markDamage(x, y, w, h)` — limit next `buildFrame` to cells overlapping this **PIXEL** rect (calls union; one-shot; ignored on a full repaint). `clearDamage()` cancels.
- `buildFrame(): number` — build diffed frame into the internal buffer (no I/O); returns byte length. `frameBytes(): Uint8Array` — view of the last build.
- `present(options?: { sync?, sink? })` — build then flush to stdout (or `sink`).
- `reconfigure({ mode?, diff?, depth?, dither?, threshold? })` — change settings live; reallocates `pixels` only if the pixel grid resizes; forces a full repaint (redraw at the new `width × height`).
- `invalidate()` — force the next frame to fully repaint. `toPNG(): Uint8Array` — encode the framebuffer.

### `class CharTerm` — character-cell TUI grid
Fields: `characters` (Int32Array code points), `foreground` `background` (Int32Array packed `0xRRGGBB`), `bold` (Uint8Array 0/1) — all writable directly; `columns` `rows` `aspect` (readonly); `mouse` (`MouseState`, coords in **cells**). `RGB` = `[r, g, b]`.
- `clear(bgR=0, bgG=0, bgB=0)` — every cell → space, default fg `0xc8c8d0`, given bg, bold off.
- `put(x, y, glyph: string|number, fg: RGB, bg?: RGB, bold=false)` — one glyph (string → first code point).
- `text(x, y, str, fg: RGB, bg?: RGB, bold=false)` — string left-to-right, one cell per code point.
- `fillRect(x, y, w, h, bg: RGB)` — fill background, clear glyphs to spaces.
- `shadeRect(x, y, w, h, r, g, b, alpha)` — blend background toward a colour, keep glyphs.
- `hline(x, y, w, glyph, fg, bg?)` / `vline(x, y, h, glyph, fg, bg?)` — runs of one glyph.
- `box(x, y, w, h, style: 'double'|'rounded'|'sharp', fg: RGB, bg?: RGB)` — outline (w,h ≥ 2).
- `markDamage(x, y, w, h)` — **CELL** rect (union, one-shot). `clearDamage()`. `buildFrame()` / `frameBytes()` / `present()` / `invalidate()` as `Term`.
- `rasterize(cellW?, cellH?): { width, height, pixels }` — render the grid to an RGB image (block/shade/box glyphs procedural, latin from 6×10 font). `toPNG()`.

### `run(spec: AppSpec)` / `runText(spec: TextAppSpec)`
Live loop on the alternate screen, unless `CAPTURE_PNG` (→ PNG) or `BENCH=1` (→ JSON fps) is set. Both restore the console on exit/crash.
- **`AppSpec`** (pixel): `title` (req), `frame(surface, time, deltaTime, frame)` (req), `init?`, `resize?`, `onKey?(keyLowercased, surface)`, `onFocus?`, `onPaste?`, `mouse?`, `targetFps?` (default `Infinity` = uncapped), `mode?`/`diff?`/`depth?`/`dither?`/`threshold?`, `drawHud?` (default true), `hud?`, `sync?`, `pauseOnSpace?` (default true), `quitOnQ?` (default true), `captureT?`.
- **`TextAppSpec`** (char): same, minus mode/diff/depth/dither/pause/quitOnQ; `onKey?(key, surface)` is **case-preserved**; `drawFps?` (default true). No F-key cycling.
- Live keys (pixel `run`): ESC / Ctrl-C / `q` quit, Space pauses, **F2/F3/F4/F5** cycle mode / depth / diff / dither (surface reconfigures + demo re-inits). `runText`: Ctrl-C quits.

### Input types
- `KeyEvent`: `{ key, down, repeat, alt, ctrl, shift, virtualKeyCode }`. `key` = a typed character, or `esc` `enter` `tab` `space` `backspace` `delete` `insert` `home` `end` `pageup` `pagedown` `up` `down` `left` `right` `f1`..`f12`. `down` distinguishes press/release (FFI-only capability).
- `PointerEvent`: `{ cellX, cellY, down, button, motion, wheel }` (wheel +1/−1/0).
- `MouseState` (on `surface.mouse`): `{ x, y, down, inside, active, sequence, wheel }`. `sequence` increments per event; `wheel` accumulates (consumer may reset).

### Helpers (named exports)
- `encodePNG(rgb, w, h): Uint8Array` — RGB8 → PNG bytes.
- `detectConsoleSize(): { columns, rows }` — honours `TERM_COLS`/`TERM_ROWS`, else queries the buffer; leaves the bottom row free; clamps 20..400 × 8..200; falls back 120×40.
- `detectCapabilities(): { colorDepth, truecolor }` — from `COLORTERM`/`WT_SESSION` (conservative `256` when unknown).
- `createFrameWaiter(): ((ms) => void) | null` — high-res pacing wait (Win10 1803+). **May return `null`** on older Windows — null-check before calling.
- `BOX` — `{ double, rounded, sharp }`, each `{ tl, tr, bl, br, h, v, cross, teeUp, teeDown, teeLeft, teeRight }`.
- `BLOCK` — `{ full '█', upper '▀', lower '▄', left '▌', right '▐', light '░', medium '▒', dark '▓' }`.
- `CAPABILITIES` — `{ depths, diffs, dithers, modes, inputBackends, features, options }` manifest.
- Also exported: `ConsoleSession`, `ConsoleInput`. Types: `RGB`, `TermMode`, `TermDiff`, `TermDepth`, `TermDither`, `TermOptions`, `PresentOptions`, `MouseState`, `KeyEvent`, `PointerEvent`, `AppSpec`, `TextAppSpec`, `BoxStyle`, `DetectedCapabilities`.

## Recipes

### Game loop (60fps, key up/down, mouse, glow)
```ts
import { run } from '@bun-win32/terminal';

await run({
  title: 'Game', targetFps: 60, mouse: true,
  onKey: (key, surface) => { if (key === 'up') {/* … */} },
  frame: (surface, time, deltaTime, frame) => {
    surface.clear(8, 8, 16);
    surface.fillCircle(surface.width / 2, surface.height / 2, 6, 255, 200, 80);
    if (surface.mouse.down) surface.addCircle(surface.mouse.x, surface.mouse.y, 10, 255, 120, 40); // soft glow
  },
});
```

### TUI / CLI app
```ts
import { runText } from '@bun-win32/terminal';

await runText({
  title: 'Dashboard',
  onKey: (key) => { if (key === 'esc') process.exit(0); }, // Ctrl-C also quits
  frame: (surface) => {
    surface.clear(10, 10, 16);
    surface.box(1, 1, 30, 8, 'rounded', [120, 200, 255]);
    surface.text(3, 3, 'Hello, TUI', [255, 255, 255], undefined, true);
  },
});
```

### Drive a surface directly (e.g. pipe decoded video; smooth low-bandwidth)
```ts
import { Term } from '@bun-win32/terminal';

const surface = new Term(160, 50, { mode: 'half', depth: '16', dither: 'ordered' });
surface.pixels.set(rgbFrame);                          // length width*height*3
surface.present({ sink: bytes => socket.write(bytes) }); // or { sync: true } for tear-free stdout
```

### Headless render / benchmark (no terminal)
```sh
CAPTURE_PNG=out.png TERM_COLS=200 TERM_ROWS=60 bun run example/game.ts   # deterministic PNG
BENCH=1 TERM_MODE=octant TERM_DEPTH=16 TERM_DITHER=ordered bun run example/game.ts   # frame-production fps (JSON)
```

## Env knobs (override spec; empty string = unset)

| Var | Default | Meaning |
| --- | --- | --- |
| `TERM_MODE` | `half` | `ascii`/`braille`/`half`/`octant`/`quad`/`sextant` |
| `TERM_DEPTH` | `truecolor` | `16`/`256`/`truecolor` |
| `TERM_DIFF` | `exact` | `exact`/`none`/`threshold` |
| `TERM_DITHER` | `none` | `none`/`ordered` |
| `TERM_THRESHOLD` | `8` | per-channel drift for `diff:'threshold'` |
| `TERM_COLS` / `TERM_ROWS` | console size / `160`×`50` headless | grid in cells |
| `CAPTURE_PNG` | — | path → headless PNG; with `CAPTURE_T` (sec, `4`), `CAPTURE_FPS` (`60`), `CAPTURE_FRAMES` (`1`) |
| `BENCH` / `BENCH_FRAMES` | — / `600` | `BENCH=1` → headless fps JSON |
| `DEMO_DURATION_MS` | `0` | auto-exit the live loop after N ms (0 = run forever) |

## Notes / gotchas

- Windows only (Bun + Win32 console via `@bun-win32/kernel32`).
- `Term.mouse` coords are **pixels**; `CharTerm.mouse` coords are **cells**. `Term.markDamage` takes a **pixel** rect; `CharTerm.markDamage` a **cell** rect.
- `octant` is Unicode 16 (2024) — crisp 2×4 blocks, but needs a font with block octants (Windows Terminal 1.22+ / Cascadia Code 2404+); elsewhere it shows tofu. `sextant` (2×3) is the safe high-detail fallback.
- `dither` only changes `16`/`256`; `truecolor` ignores it. Dithering is deterministic per (colour, position), so identical frames still diff to nothing.
- `run`/`runText` default to **uncapped** fps; set a finite `targetFps` to pace with the high-res timer.
- `run`'s `onKey` receives the key **lowercased**; `runText`'s is **case-preserved**.
- Writing `surface.pixels[i] = v` directly does **not** clamp; `setPixel`/`add`/`blend` do. The console is restored on exit/crash; ESC and Ctrl-C always quit a live loop.

## Where to look (source)

| Find | Read |
| --- | --- |
| Public surface | `index.ts` |
| Pixel methods | `pixel.ts` (`class Term`) |
| Char methods | `char.ts` (`class CharTerm`) |
| App-loop spec | `loop.ts` (`AppSpec`, `TextAppSpec`) |
| Input shapes | `input.ts` |
| Runnable examples | `example/` (27 demos; `emberfield.ts` showcases octant + dither + `addCircle`) |
