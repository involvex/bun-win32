# `_term` — a configurable, very fast pure-TypeScript terminal renderer

`_term.ts` turns the console into a 24-bit RGB framebuffer and streams diffed
frames over a single `process.stdout.write`. It now exposes **three orthogonal
axes** so the *same* engine can drive a quiet interactive CLI, a text UI, a 60fps
procedural scene, full-motion video, or a hyper-detailed game — and it does so at
**tens of thousands of frames per second** of frame production on Windows.

All defaults are unchanged: `new Term(cols, rows)` still gives a half-block,
truecolor, exactly-diffed renderer with an RGB stride-3 `buf`. Every one of the
21 existing demos renders byte-for-byte identical PNGs (verified).

---

## The three axes

```ts
new Term(cols, rows, { mode, diff, depth, threshold })
```

| Axis | Values | What it trades |
|------|--------|----------------|
| **mode** | `half` (1×2, default) · `quad` (2×2) · `sextant` (2×3) · `braille` (2×4) | CPU ↔ spatial resolution. Higher modes quantise each cell to two colours + the best Unicode glyph. |
| **diff** | `exact` (default) · `threshold` · `none` | `threshold` also skips cells that drifted ≤ N per channel — huge on coherent video/game frames. |
| **depth** | `truecolor` (default) · `256` · `16` | Bytes per frame. A 16-colour stream is ~⅓ the bytes and the fastest to both build and *display*. |

Set them per-`Term`, per-demo (`DemoSpec` fields), or at the CLI:

```sh
TERM_MODE=sextant TERM_DIFF=threshold TERM_THRESHOLD=18 bun run example/raycaster-term.ts
TERM_DEPTH=16 BENCH=1 bun run example/video-term.ts
```

The pixel grid follows the mode: `half`→`cols × rows·2`, `quad`→`cols·2 × rows·2`,
`sextant`→`cols·2 × rows·3`, `braille`→`cols·2 × rows·4`. Demos that read `t.W/t.H`
each frame get the extra resolution for free.

---

## What changed in the hot path

- **Precomputed decimal byte tables** (0–255) replace per-cell `int→string` +
  division in the colour emitter.
- **Combined fg+bg SGR**: when both change, one escape (`…38;2;…;48;2;…m`) sets
  both, halving per-cell escape overhead vs two sequences.
- **Specialised `emitHalfFast`** for the common truecolor+exact case keeps the
  unchanged-cell skip as cheap as before (no regression), while palette/threshold
  take a general path where their extra maths earns its keep.
- **15-bit LUTs** for both 256- and 16-colour quantisation → one table lookup per
  colour instead of branchy cube/grey logic.
- New public `frameBytes()` returns the built frame as a view, for recording or
  piping the stream elsewhere.

---

## Benchmarks (frame *production* — `bun run example/_term.bench.ts`)

"fps" is how fast the diffed byte stream is built; the terminal then consumes it,
so fewer bytes/frame (palette + threshold) also means a faster picture on screen.

### Default path (half / truecolor / exact), before → after

| Scenario | 120×40 | 200×60 | 320×100 |
|---|---|---|---|
| static (CLI idle) | 56k → **62k** | 40k → **40k** | 15.6k → **14.8k** |
| sparse 3% (TUI) | 18k → **30k** | 14.7k → **16.8k** | 6.2k → **6.4k** |
| full-frame video | 3088 → **3923** | 1285 → **1568** | 467 → **586** |

The static/UI cases were already far past 60fps; the win is on the full-change
path (+22–27%) plus the new options below.

### Config matrix on COHERENT motion (≈ real video/game), 200×60 cells

| mode | diff | depth | fps | KB/frame |
|---|---|---|---|---|
| half | exact | truecolor | 1,957 | 397 |
| half | threshold-18 | truecolor | 4,331 | 78 |
| half | exact | 256 | 6,047 | 41 |
| **half** | **exact** | **16** | **11,103** | **10** |
| sextant | threshold-18 | truecolor | 1,533 | 91 |
| braille | exact | 16 | 1,677 | 22 |

### Real video — Counter-Strike 2 capture decoded by ffmpeg into `_term`

`bun run example/video-term.ts` (BENCH measures the engine on real decoded frames):

| size | half/truecolor | half/256 | half/16 |
|---|---|---|---|
| 80×24 | 13,082 | — | **18,441** |
| 120×40 | 13,579 | — | 10,836 |
| 200×60 | 7,393 | 9,163 | 9,564 |

High-motion gameplay (every cell changes) still clears thousands of fps at
truecolor and ~tens of thousands at smaller sizes / 16-colour.

---

## Demos

| File | What it shows |
|---|---|
| `video-term.ts` | Real video files played in the terminal (ffmpeg → `_term`); BENCH/CAPTURE pre-decode for a clean number. |
| `term-dashboard.ts` | A super-interactive command-center TUI: mouse hover/click/wheel, arrow-nav menu, live chart, event log, cursor glow. The engine as a CLI framework. |
| `raycaster-term.ts` | A playable textured first-person raycaster (sextant mode) with minimap, sprites, fog — a real game. |
| `fineprint.ts` | A resolution test-card (Julia fractal + 1px vector art + small text). Run with each `TERM_MODE` to see the detail ladder. |
| `_term.bench.ts` | The benchmark above. |
| `_term.modes.test.ts` | Decodes the emitted byte stream and asserts exact glyphs/colours per mode (20 checks). |

---

## Verification

- `bun run example/_term.modes.test.ts` → 20 pass / 0 fail (glyph tables, 2-colour
  quantisation, threshold skip/repaint, palette emit).
- `bun run example/_term.selftest.ts` (CAPTURE/BENCH) → renders + benches clean.
- All 21 dependent demos produce **byte-identical** PNGs before/after the rewrite
  (default path is provably non-regressive).
- `bunx tsc --noEmit -p packages/all/tsconfig.json` → 0 errors.
- `gameboy-tty.logic.test.ts` (exact `buf` value assertions) → all pass.
