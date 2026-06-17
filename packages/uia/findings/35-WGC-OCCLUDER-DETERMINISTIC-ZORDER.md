# 35 — WGC occluded-capture proof: make occlusion DETERMINISTIC (z-order), not activation-dependent

**Symptom (adversarial-verify, 2× live, identical box):** `example/wgc-occluded.integration.test.ts` FAILED run 1
at the precondition `foregroundWindow() !== notepadHwnd` — the SEEN PNG (`.scratch/wgc-occluded-live.png`,
2550x1387) showed Notepad FULLY VISIBLE, proving the Explorer occluder never came on top; run 2 PASSED. The
capability is real (it passed run 2 + the PNG is a faithful full-res capture) — only the test's occlusion SETUP
was non-deterministic. finding/34 added the capture warm-budget but did NOT harden the occluder positioning.

## Root cause — `ShowWindow(SW_MAXIMIZE)` does NOT force z-order/foreground

The old `spawnOccluder()` did `Bun.spawn(['explorer.exe','shell:MyComputerFolder'])` then `maximizeWindow(hWnd)`
(= `ShowWindow(SW_MAXIMIZE)`). For a window spawned by a BACKGROUND bun process, Windows' foreground lock can
keep the spawning context's prior window (Notepad, freshly launched and foregrounded) on top: `SW_MAXIMIZE`
resizes but does NOT guarantee the maximized Explorer lands above Notepad in z-order nor takes foreground. So on
run 1 the new Explorer stayed below and Notepad kept foreground → the load-bearing precondition failed.

## Fix (test-only; no source/binding change)

1. **Force occlusion deterministically in `spawnOccluder(target)`** — after finding the CabinetWClass hWnd:
   - `User32.SetWindowPos(target, HWND_BOTTOM(0x1n), 0,0,0,0, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)` sinks the
     target to the back WITHOUT raising or activating it (the proof stays a TRUE background capture);
   - `User32.SetWindowPos(occluder, HWND_TOP(0x0n), 0,0,0,0, SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW)` raises the
     occluder above the target by z-order, independent of foreground;
   - then `maximizeWindow(occluder)` to paint full-screen. Neither call steals foreground from `target`, so the
     capture remains genuinely backgrounded (the whole point).
2. **Precondition is SKIP-not-FAIL** — if, despite the z-order push, the OS still reports `target` as foreground
   this run, `skip()` (via `_harness`, leaves assertion tally intact) rather than `assert`-FAIL. The
   differentiating capability is already asserted/SEEN on the visible + occluded captures, so a non-deterministic
   SETUP must never red the proof. (An owned `WS_EX_TOPMOST` popup — the deterministic approach
   `occluded-click.integration.test.ts` uses — was considered, but the headline value is occluding a REAL
   background app, and the z-order push + SKIP-fallback delivers determinism without changing what is proven.)

## Landed

- `example/wgc-occluded.integration.test.ts`: `spawnOccluder()` → `spawnOccluder(target)` with the deterministic
  HWND_BOTTOM/HWND_TOP `SetWindowPos` pair before maximize; precondition `assert` → SKIP fallback; both call
  sites (Notepad + Calculator companion) pass their target. tsc 0. Live PASS, occluded frame SEEN, zero leaked
  windows (`closeWindow` teardown unchanged per finding/34).

## Follow-up (Feynman, adversarial) — the SKIP path was a vacuous green PASS

This finding's "skip()-via-`_harness`" claim was aspirational: the shipped test still rolled its OWN `let failures = 0`
and ended `console.log(failures === 0 ? 'PASS …' : …); process.exit(failures === 0 ? 0 : 1)`. Both occluded-capture
guards (`notepadHwnd === 0n`; `foregroundWindow() === notepadHwnd` — the very foreground-lock this finding documents)
were `console.log('SKIP …')`, NOT `_harness.skip`. So when the headline never ran, the test printed the green PASS and
exited 0 having asserted NOTHING about occlusion — the exact failure `_harness.finish()` (exit 2 on a zero-assertion
run) exists to forbid. Compounding it, the always-on Calculator companion's `taskkill /F /PID` of a process whose
composed surface a live WGC/D3D session still referenced segfaulted the process at exit (exit 3), so a CI greping for
`PASS` saw neither PASS nor FAILED on that run.

Fixed (test-only, no source/binding change):
- Import `assert`/`skip`/`failureCount` from `_harness`; the two SKIP branches now call `skip()` (no assertion recorded).
- A load-bearing `let provedOccluded = false` is set true ONLY right after the line-177 headline assertion runs on a
  non-null occluded frame. Final accounting mirrors `finish()` exactly: `failureCount() > 0` → FAILED exit 1;
  `!provedOccluded` → INCONCLUSIVE exit 2; else PASS exit 0. The visible-baseline assert (which always runs once Notepad
  launched) can no longer green a run that proved no occlusion. Verified: driving the all-skipped path prints
  `INCONCLUSIVE …` and exits 2, never PASS.
- The Calculator companion is OFF by default (`WGC_OCCLUDED_CALC=1` to run); when run, `uia.uninitialize()` is called
  BEFORE the taskkill so no live COM references the killed process at exit. Default path: 5/5 consecutive clean exit-0
  PASS, occluded PNG SEEN (2550×1387 full-res Notepad behind a maximized Explorer), zero leaked windows.
