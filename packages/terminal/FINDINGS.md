# Optimisation FINDINGS — `@bun-win32/terminal`

The §8 performance log. Every round states a hypothesis, the change, the measured
result, and the verdict (KEEP / REVERT). Bytes are sacred: every round is gated by
`frame.golden.test.ts` (a frozen FNV-1a hash of the wire stream across the full
mode × diff × depth × content matrix). Speed may move; emitted bytes may not.

## Method

- **Gate:** `bun run packages/terminal/frame.golden.test.ts` must stay green
  (hash `4a6e2109`). A round that changes the hash is wrong by construction and is
  reverted before it is even judged on speed.
- **Measure:** `.scratch/optbench.ts` — best-of-7, N=600, 200×60, JIT pre-warmed.
  Best-of-N because noise only ever *slows* a run, so the fastest observed time is
  the truest signal. Numbers are frame-production fps (build the diffed byte stream;
  no terminal I/O).
- **Regimes:** churn-bound (`VIDEO`, every cell re-emits — bound by the output
  buffer) and skip-bound (`STATIC`, the diff skips — bound by per-cell scanning).

## Baseline (pre-optimisation, commit before Round 1)

| scenario | fps |
| --- | ---: |
| half / truecolor / exact — VIDEO | 1975 |
| half / truecolor / exact — STATIC | 40250 |
| half / 16 / exact — VIDEO | 14890 |
| half / truecolor / threshold — VIDEO | 4965 |
| sextant / truecolor / exact — VIDEO | 1185 |
| sextant / 16 / exact — VIDEO | 2685 |
| quad / truecolor / exact — VIDEO | 1394 |

---

## Round 1 — single-reservation `setTruecolor` · KEEP

**Hypothesis.** On the churn path the per-cell escape fanned out into ~12
`putBytes`/`putDecimal`/`putByte` calls, each re-checking capacity and re-reading
`#position`. Collapsing to one `#ensureCapacity` for the worst-case escape (36 B)
plus direct writes through a local cursor should cut that overhead.

**Change.** `output.ts` — rewrote `setTruecolor` to reserve once, then inline-copy
the named byte-constants and the decimal LUT through a local `position`. Output
bytes unchanged.

**Result.**

| scenario | before | after | Δ |
| --- | ---: | ---: | ---: |
| half / tc / exact — VIDEO | 1975 | 2426 | **+23%** |
| half / tc / threshold — VIDEO | 4965 | 5523 | +11% |
| sextant / tc / exact — VIDEO | 1185 | 1335 | +13% |
| quad / tc / exact — VIDEO | 1394 | 1625 | +17% |

STATIC and palette paths flat (they don't call `setTruecolor`). Golden green.

## Round 2 — single-reservation `setPaletteColor` · KEEP (neutral)

**Hypothesis.** The same treatment should help the `256`/`16` churn paths.

**Change.** `output.ts` — same rewrite for `setPaletteColor`.

**Result.** Flat (15356 / 2616). Palette churn is bound by per-cell *analysis*
(quantisation + luma split), and the run-length pen already suppresses most escapes
when neighbouring cells share a quantised colour — so escape-emission was never the
bottleneck here. Byte-identical and removes the same call overhead, so kept for
consistency; no measurable win claimed.

## Round 3 — fused per-cell colour+glyph primitive · KEEP

**Hypothesis.** Each emitted cell still paid *two* capacity checks: one in the
colour call, one in `putBytes(glyph)`. Fusing colour-escape and glyph into a single
reservation removes a check and a call frame per cell.

**Change.** `output.ts` — extracted `#writeTruecolorEscape` / `#writePaletteEscape`
(shared with the setters, so no duplication) and added `emitCellTruecolor` /
`emitCellPalette`, which reserve `escape+glyph` once and write both. `pixel.ts` —
routed all four emit paths (half-fast, half-general, multi, ascii) through them and
deleted the now-dead `#emitColor`. Output bytes unchanged; two public methods added
(covered in `output.test.ts`).

**Result.**

| scenario | R1/R2 | after | Δ vs baseline |
| --- | ---: | ---: | ---: |
| half / tc / exact — VIDEO | 2426 | 2653 | **+34%** |
| quad / tc / exact — VIDEO | 1625 | 1740 | **+25%** |
| sextant / tc / exact — VIDEO | 1335 | 1426 | **+20%** |
| half / tc / threshold — VIDEO | 5523 | 5534 | +11% |
| half / 16 / exact — VIDEO | 15356 | 15474 | +4% |
| sextant / 16 / exact — VIDEO | 2616 | 2760 | +3% |

STATIC flat (skip path emits nothing). Golden green; full suite green.

---
