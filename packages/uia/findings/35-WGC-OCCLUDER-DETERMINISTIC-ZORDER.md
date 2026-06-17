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
  HWND_BOTTOM/HWND_TOP `SetWindowPos` pair before maximize; precondition `assert` → `skip()` fallback; both call
  sites (Notepad + Calculator companion) pass their target. tsc 0. Live PASS, occluded frame SEEN, zero leaked
  windows (`closeWindow` teardown unchanged per finding/34).
