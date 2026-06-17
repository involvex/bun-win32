# 40 — Qt widget-tree regression test SHIPPED (toolkit-coverage gap closed)

## The gap (seat 6, Scenario-Coverage — medium)

The suite pins every other major desktop toolkit with a dedicated regression test —
WinForms (`dense-tree-budget`), WPF (`wpf-hwndwrapper-input`), WinUI (`click-winui-toggle`),
UWP (`uwp-content`), Electron/Chromium (`web-content`), Java (`jab-java-tree`) — but had
**NOTHING for Qt**. `grep -rln -iE 'Qt6|QWindowIcon|PySide|pyqt|QtWidget' example/*.ts` → exit 1;
`ls example/*qt*` → none. The only "Qt" string in the package was an aspirational mention in
findings/39 ("a wide Qt tree"), never an actual probe.

Qt is a tier-1 slice of the desktop — OBS, VLC, Telegram, KeePass, qBittorrent, Wireshark, and the
entire KDE stack. Its UIA bridge is **version-fragile** (Qt's sibling QML/Qt-Quick path already
fails to expose in some builds), so an untested toolkit this widely deployed was a real
silent-regression hazard: a future Qt that drops the QWidget→UIA bridge (as QML does) would go
unnoticed.

## The fix

- `example/qt-widget-tree.integration.test.ts` — spawns a REAL Qt `QWidget` window
  (`QPushButton.setAccessibleName('theQtButton')` + a `QLineEdit` + a `QCheckBox`), attaches,
  `snapshot(maxDepth:30)`, and asserts the Button/Edit/CheckBox surface as actionable refs through
  UIA, then that a cursor-free `Element.setValue` round-trips on the QLineEdit. Mirrors the
  jab-java-tree / wpf-hwndwrapper-input compile-or-skip discipline: detects a Qt python runtime
  (PySide6 / PyQt6 / PyQt5 — the widgets API is identical, only the import differs) and prints
  `skip(live)` + exits 0 when none is present. Closes the window (`closeWindow`) + force-kills the
  python process (`windowProcessId` → `taskkill`) in `finally`, and `rmdir`s the temp script dir.
- `package.json` — `example:qt-widget-tree` script (alphabetized). `AI.md` — a Qt toolkit-support
  line (read + drive via UIA, bridge is version-fragile, QML may expose nothing → OCR fallback).
  `README.md` — Qt added to the pinned-toolkit enumeration.

### Windows Store python (App Execution Alias) trap

A Windows Store python is reached through an App Execution Alias whose path (`…\WindowsApps\…\
python.exe`) is a zero-byte reparse point — **NOT Bun-spawnable** (`Bun.spawn` → ENOENT) and
`realpathSync` errors EACCES on it. The resolver handles it: when no plain python on PATH has a Qt
binding, it runs `cmd /c python <script>` (cmd DOES honor the alias) to read `sys.base_prefix`, then
spawns the real `python3.13.exe` (etc.) found under that prefix directly. Filters WindowsApps paths
out of the direct-`Bun.which` candidates so it never tries to spawn the alias.

## Live proof (real app, closed in finally)

`bun run example/qt-widget-tree.integration.test.ts`:

```
  Qt runtime: PySide6
  UIA snapshot: 11 nodes, 7 actionable refs
  ok: the QPushButton surfaces as an actionable Button ref named "theQtButton" (Qt UIA bridge alive)
  ok: the QLineEdit surfaces as an actionable Edit ref
  ok: the QCheckBox surfaces as an actionable CheckBox ref named "Enable Qt Thing"
  ok: the QLineEdit round-trips a cursor-free ValuePattern setValue ("qt-roundtrip-7421")

PASS — Qt widgets read + driven cursor-free via UIA (the toolkit is pinned against a bridge regression).
```

The refs include the title-bar non-client buttons (Minimize/Maximize/Close) + a System MenuItem, so
the assertions gate on the NAMED Button/Edit/CheckBox, not a raw role count.

## Constraints honored

- No casts; alphabetized imports; `.ptr` read inline at the FindWindowW call; structs (the title
  buffer) assembled at the FFI call. `bunx tsc --noEmit` clean (whole repo, exit 0). Bun-native
  (`Bun.which`/`Bun.write`/`Bun.spawn`/`Bun.$`). `example/*` is not in `files[]` (tests ship out of
  band, like every sibling toolkit test).
- The OS wall to document: Qt's QML/Qt-Quick (not QWidget) path may expose no UIA tree at all — the
  AI.md note steers to `ocr`/`click_text` there; this test pins the QWidget path that DOES bridge.
