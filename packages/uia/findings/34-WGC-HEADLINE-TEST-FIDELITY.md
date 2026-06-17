# 34 — WGC headline test: reliable target + non-destructive teardown (no session self-poison)

**Symptom (adversarial-verify, 3× live):** `example/wgc-occluded.integration.test.ts` FAILED its load-bearing
"see an occluded window" proof, then bricked Calculator for the rest of the session. Two root causes, both in
the TEST (the WGC capability itself is real — see finding/08), not in `wgc.ts` (slots verified).

## Root cause A — `taskkill /F /IM CalculatorApp.exe` wedges the app model

The old test force-killed Calculator by IMAGE NAME at cold-start (lines 89-90) and in `finally` (157-158).
Calculator is a single-instance PACKAGED app: `/F /IM` mid-activation leaves its `ActivationManager` wedged —
`tasklist` shows a headless `CalculatorApp.exe` ALIVE but `findWindow({title:'Calculator'})===0`. A later
`start calc` / `calculator:` protocol re-activates the zombie and never creates a titled window. Measured: the
break persisted the WHOLE session; `calc-delta-stable.integration.test.ts` then died "window {title:Calculator}
did not appear within 8000ms". **Never `taskkill /F /IM` a packaged single-instance app.**

## Root cause B — the WinUI Calculator surface is a fragile headline target

A GPU/DirectComposition surface can return blank within a short WGC poll, and the app model can be pre-wedged
from a prior session — so asserting the differentiating headline ON Calculator proves nothing on a poisoned box.

## Fix (test-only; no source/binding change)

1. **Headline target = classic Notepad**, not Calculator. Measured reliable: WGC captures it FULLY OCCLUDED
   (behind a maximized Explorer, not foreground, not minimized) at 2550x1387 with ~10.6M nonzero px, 20/20
   attempts in a tight loop. SEEN, not asserted (PNG written to `.scratch/wgc-occluded-live.png`).
2. **WinUI Calculator demoted to a best-effort companion that SKIPs (never FAILs)** when it can't launch or its
   surface comes back blank — a wedged app model degrades gracefully instead of bricking the suite.
3. **Cold-start guard:** if the target window stays `0n` after the launch loop, SKIP with a clear message.
4. **Warm budget 10→25 attempts** (×1500ms timeout + 300ms sleep): absorbs a rare DWM occluded-frame race where
   the visible baseline passes but the occluded poll briefly returns only uniform frames. 4/4 PASS after.

## Teardown trap — modern Notepad is ONE shared process (do NOT PID-kill it)

finding/31 says force-kill a spawned window by its owning PID. That is correct for Calculator (a separate
`CalculatorApp.exe` per window) but **WRONG for modern Notepad**: measured, a freshly-spawned Notepad window
shares its owning PID with EVERY other Notepad window (one big host process, ~190 threads, plus a tiny
launcher). `taskkill /F /PID <thatPid>` would nuke all the user's open Notepad windows. Because this test never
types into its Notepad, the buffer stays clean and a plain `closeWindow` (WM_CLOSE) raises no "Save?" dialog and
closes ONLY that one window. Verified: user's Notepad window count 14 before == 14 after, across 4 runs.

**Doctrine refinement to finding/31:** PID-force-kill is for per-window-process apps (Calculator) or DIRTY
single-process editors with no safe close. For a CLEAN window in a SHARED-process app, `closeWindow` is the
safe teardown — a shared-PID `taskkill /F /PID` is collateral damage, same class as `/F /IM`.

## Landed

- `example/wgc-occluded.integration.test.ts` rewritten (headline→Notepad, Calculator→SKIP-companion, cold-start
  + blank-surface SKIP guards, `closeWindow`-only Notepad teardown, no `taskkill /F /IM` anywhere). tsc 0.
  4/4 live PASS; occluded frame SEEN; zero leaked/collateral windows; Calculator no longer poisonable.
