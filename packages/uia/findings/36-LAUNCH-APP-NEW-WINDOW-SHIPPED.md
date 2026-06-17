# 36 — launch_app attaches to the NEW window it spawned, not a stale same-titled one (SHIPPED)

## Defect (high)

`launch_app {command, title}` did `Bun.spawn(command)` then `await uia.waitForWindow({title})`. `waitForWindow`
(events.ts) does `listWindows().find(predicate)` FIRST and returns immediately if ANY open window matches, and the
title predicate (events.ts `toPredicate`) is a case-insensitive SUBSTRING. So with the user's Notepad/browser/Explorer
already open, `launch_app {title:'Notepad'}` resolved the EXISTING window and reported `launched and attached` — driving
the wrong target with no error to recover from (worst case for an autonomous agent).

Live repro (this turn): pre-opened a Notepad, stamped `STALE_MARKER_…` via set_value, then `launch_app {title:'Notepad'}`
— the auto-snapshot showed the marker, i.e. it grabbed the OLD window.

## Fix (mcp.ts `launch_app` handler)

- Before spawning, snapshot already-open matches: `const before = new Set(uia.windows({includeUntitled:true}).filter(matchTarget).map(w => w.hWnd))`.
- Keep the `Bun.spawn(...).pid` so the direct-CreateProcess case can prefer its own pid.
- Replace the bare `await uia.waitForWindow(target)` with a bounded poll (64ms, `Bun.nanoseconds` deadline) that returns the
  first window matching `target` whose hWnd is NOT in `before`; when the $PATH spawn succeeded, prefer one whose
  `processId === child.pid`. UWP/ShellExecute reparent into a host process, so fall back to the not-in-before match.
- `matchTarget` mirrors events.ts `toPredicate` (substring/case-insensitive title, exact className) so the poll resolves
  exactly what waitForWindow would — just restricted to a genuinely new window.
- Description tightened: "waits for the NEWLY-appeared window THIS launch created … To gate on / attach to an ALREADY-open
  window use wait_for_window."

`wait_for_window {attach}` is unchanged and correct — it is a GATE that documents "Resolves immediately if one is already
open." Only `launch_app` conflated spawn with match-anything.

## Proof

`example/launch-app-new-window.integration.test.ts` — stamps a marker into a seed Notepad, launches a second Notepad with
the same substring title, asserts the attached snapshot does NOT carry the marker (different hWnd). PASS, both Notepads
closed in finally. `bunx tsc --noEmit` clean.
