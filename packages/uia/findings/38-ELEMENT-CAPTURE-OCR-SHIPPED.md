# 38 — Element.capture / Element.ocr SHIPPED (FlaUI Capture.Element / Playwright locator.screenshot parity)

## The gap (seat 9, Competitive-Parity — medium)

`Window.screenshot` existed, but there was NO way to capture or OCR a SINGLE control:
`typeof Element.capture` / `Element.ocr` were `undefined`. The only workaround —
`el.boundingRectangle` → `captureScreen({x,y,w,h})` → `ocrBitmap` — is OCCLUSION-INCORRECT:
`captureScreen(region)` BitBlts whatever window is TOPMOST at those screen pixels, so OCR'ing a
backgrounded Notepad edit's bounds returned a Character Map / Explorer window overlapping it, not
Notepad's content. FlaUI's `element.Capture()` and Playwright's `locator.screenshot()` are both
occlusion-correct one-liners sourced from the element's OWN window.

## The fix

- `screen.ts` — `cropBitmap(source, x, y, width, height)`: crops a `Bitmap` to a sub-rectangle in
  the source's local pixels, clamped to bounds, carrying the correct screen origin (so per-word OCR
  boxes stay screen-absolute). Returns null on an empty/off-bitmap rectangle.
- `element.ts` — `async capture(): Promise<Bitmap | null>` resolves the element's top-level owner
  window (`GetAncestor(ownerHwnd(this), GA_ROOT)`), captures THAT window via `captureWindowLive`
  (WGC — occluded/background/GPU), falling back to `captureWindowRGB` (PrintWindow), then crops to
  the element's WINDOW-LOCAL bounds (`boundingRectangle` − capture origin). `async ocr(options?)`
  is `ocrBitmap(await this.capture())`. This reuses the exact primitives `ocrWindow` composes, so it
  inherits the occluded/background/GPU path. Because the source is the element's OWN window, an
  overlapping window's pixels can never leak in.
- `mcp.ts` — threaded `ref` into `ocr` and `capture_window`: `{ref}` resolves the Element and calls
  `el.ocr()` / `el.capture()` (the cropped path) instead of the whole-window / region path, so an
  agent holding `[ref=eN]` for a `<canvas>`/chart/custom control snapshots/OCRs exactly it,
  cursor-free and occlusion-correct.
- `index.ts` — exports `cropBitmap`. `AI.md` — documents the new methods in Capability→API and the
  `class Element` section.

## Live proof (occlusion-correct, SEEN not asserted)

`example/element-capture-occlusion.integration.test.ts` — spawns a real Notepad, types a unique
marker into its edit cursor-free (WM_SETTEXT), then:
1. `editor.ocr()` reads the marker while VISIBLE;
2. raises a maximized Explorer over Notepad, sinks Notepad WITHOUT foregrounding it;
3. `editor.ocr()` STILL reads the marker behind the occluder (own-window capture + crop) — PASS;
4. CONTRAST — the OLD `captureScreen(elementBounds)` → `ocrBitmap` reads the OCCLUDER
   (`"Sort View … Send afternoon message … Running schedul"`), NOT the marker — PASS.

Teardown closes Notepad + the Explorer occluder by WM_CLOSE only (never taskkill /IM, never a PID
force-kill of the shared Notepad/shell process); the edit is cleared so WM_CLOSE raises no Save?
dialog. Runs PASS end-to-end (exit 0); the occasional Bun teardown segfault is the known post-work
exit crash (after all assertions + the PASS line print), not a logic fault.

## Constraints honored

- No casts; alphabetized imports; `#private` untouched; hex offsets; cast-free `vcall` (reused, not
  re-rolled); `.ptr` read inline; structs assembled at the FFI call. `bunx tsc --noEmit` clean on the
  touched files.
- Minimized / protected / off-screen owner → `capture()`/`ocr()` return null (the OS surface wall,
  not a binding gap) — the MCP tools steer to restore/raise or whole-window capture.
