# 43 — Interpolated real-cursor drag (SHIPPED)

## The bug

`input.ts:dragTo` teleported: `SetCursorPos(from)` → `LEFTDOWN` → `SetCursorPos(to)` → `LEFTUP`, with NO
WM_MOUSEMOVE between button-down and button-up. The OS will not register a drag until the pointer moves
≥ `SM_CXDRAG`/`SM_CYDRAG` (live this machine: 4px each) AFTER button-down, and HTML5/Chromium fire
`dragstart`/`dragover` only on the move stream between down and up. So every threshold-gated drag — HTML5/
Chromium drag-DROP, list reorder, slider thumb, canvas — silently no-op'd. All three real-drag entry points
inherited it: `input.ts:dragTo`, the MCP `drag` default (`mcp.ts`), and the Anthropic computer-use
`left_click_drag` (`computer.ts`).

The cursor-free posted path (`coords.ts:postDragToHwnd`) ALREADY interpolated 8 `WM_MOUSEMOVE` messages —
the team had proven interpolation is mandatory, but applied it only to the posted path (which cannot do an
OLE drag-DROP). The one path whose sole purpose is real drag-DROP was the one missing it.

## The fix

`dragTo(fromX, fromY, toX, toY, steps = 16)` now interpolates `steps` `SetCursorPos` moves between `LEFTDOWN`
and `LEFTUP`, mirroring the proven `postDragToHwnd` loop. Each `SetCursorPos` posts a `WM_MOUSEMOVE` to the
window under the cursor, crossing the 4px threshold and feeding the dragover stream. Behavior fix only —
signature is back-compatible (optional `steps`), so `mcp.ts:drag`, `computer.ts:left_click_drag`, and
`example/agent-loop.ts` inherit it with zero call-site edits.

## Proof

`example/drag-interpolated-stroke.integration.test.ts`: launch classic Windows Paint (default Pencil),
force it foreground (AttachThreadInput), VERIFY the canvas under the start point is white, drag the pencil
diagonally with the REAL cursor, and assert a black STROKE now exists at the diagonal MIDPOINT
(before: 0 dark px; after: ~34–37/144). A teleport leaves the midpoint blank. SEEN: a clean continuous
diagonal pencil line across the white canvas. A contended/occluded desktop is honestly SKIPPED, not failed.
Paint is force-killed by window PID in teardown.

## Harness lessons (re-confirmed dead-ends)

- A WH_MOUSE_LL hook does NOT observe `SetCursorPos`-generated (or even self-injected SendInput) moves when
  the same single-threaded Bun process both injects and pumps — not a valid proof harness here.
- A self-pumped own-process window COALESCES the move stream: the OS samples one `WM_MOUSEMOVE` at the final
  cursor position at pump time, not one per intermediate `SetCursorPos`. The interpolation is only observed
  by a SEPARATE app whose message loop pumps concurrently (e.g. Paint) — which is exactly the real use case.
- `User32.SetCursorPos` is bound non-configurable (`Object.defineProperty` from `Load`), so it cannot be
  monkey-patched/spied; prove behavior end-to-end against a real app instead.
- A real-cursor drag needs the target foregrounded; under concurrent agents fighting the foreground/desktop,
  the test self-skips (honest), not fails.
