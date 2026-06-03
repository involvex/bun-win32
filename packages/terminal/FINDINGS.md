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
