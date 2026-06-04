# TermOS Desktop Glow-Up — Design Spec

**Date:** 2026-06-03
**File:** `packages/terminal/example/desktop.ts` (single-file, extended in the current style)
**Goal:** Turn the terminal desktop demo into a jaw-dropping showcase — "how the hell is that TypeScript?" — by adding five new apps, real window management (maximize + resize), and a full visual glow-up, while keeping every frame deterministic (`time` + `mulberry32`) so headless `CAPTURE_PNG` captures reproduce.

## Constraints

- One self-contained file (`desktop.ts`), shared math from `_kit.ts` only. Preserves the "it's all in one file" wow and matches repo convention.
- Per-cell drawing via the `CharTerm` API (`put`/`text`/`fillRect`/`shadeRect`/`box`/`hline`/`vline`, truecolor + bold). No new engine APIs.
- All motion derived from `time`; all randomness from `mulberry32`. No `Date.now()`/`Math.random()`.
- Apps render strictly relative to their `wn.x/y/w/h` so resize/maximize reflow for free. Each app has a min width/height clamp.
- Bun-native, follows repo `AGENTS.md` (alphabetize, `#private`, no shortform names, no `as any`, surgical style). Match the existing prose-rich example comment style.

## Apps (8 total)

Existing, retained & polished: **Notepad**, **Video** (sunset clip), **Clock** (analog+digital).

New:

1. **Browser** (centerpiece). Tab strip (active tab + `×`), toolbar (`◀ ▶ ⟳` + address pill `🔒 termos.dev` + `☆ ⋮`), navigation progress sweep, and a scrollable rendered page: block-art hero banner, big heading, paragraph text, accent links + pill buttons, a row of cards, an inline block-art image. Auto-scrolls during attract; mouse-wheel scrolls when live. Reflows page width to the window.
2. **Terminal** (`charsh — ~/termos`). Types `neofetch` → ASCII TermOS logo + live system table (OS, shell, CPU `Bun`, resolution `cols×rows`, uptime, ANSI color-block row), then `cmatrix` → matrix rain rows. Blinking cursor, colorized output. Opaque inner screen.
3. **Music visualizer**. Animated block-art album cover, title/artist, scrubber, and a spectrum analyzer: gradient bars (`▁▂▃▄▅▆▇█` partials) with peak-hold caps + dimmer mirrored reflection; beat envelope pulses the window tint. Synthetic spectrum (sum of sines per bar × beat).
4. **System monitor**. CPU/GPU/MEM rows, each a big `%` + scrolling filled sparkline (green→amber→red by load) + a per-core bar grid. Values from smooth deterministic noise.
5. **3D viewport** (`Scene — torus.obj`). Real-time shaded rotating solid (torus or icosahedron), per-pixel depth buffer, Lambert + specular lighting → truecolor luminance ramp, on a dark grid floor. Small inner rect to stay cheap. Reuses repo 3D-math idioms.

## Window management

- `Win` gains: `maximized: boolean`, restore bounds `rx/ry/rw/rh`, `resizing` participation, and per-app `minW/minH`.
- **Maximize**: green traffic-light button OR double-click title bar → toggle fill of the desktop band (below menu bar, above dock) with a smooth animated expand; second toggle restores saved bounds.
- **Resize**: bottom-right corner grip glyph `◢`; press-drag in the corner cell region resizes, clamped to the app's `minW/minH` and the desktop bounds.
- Traffic lights: red = close-to-dock (restorable), yellow = minimize, green = maximize/restore.

## Scene glow-up

- **Wallpaper**: keep aurora; add volumetric light rays from the drifting light source, slow parallax bokeh particles (deterministic), tighter vignette.
- **Glass windows**: translucent body — `shadeRect` the body over the already-rendered wallpaper (~0.82) so aurora faintly bleeds through; frosted title highlight. Apps needing an opaque screen (Video/Terminal/3D) keep a solid inner panel; only the chrome is glass.
- **Menu bar** (new top strip):  `TermOS` · File Edit View … right-aligned wifi/battery/clock glyphs.
- **Dock**: hover-magnify (icons scale near the cursor), dimmer reflection row, running-dots, all 8 icons.

## Attract performance (~30s loop)

Re-choreographed cursor tour: glide in → open Browser, navigate (progress sweep + page scroll) → grab Browser corner and resize, then maximize full-screen to "read", then restore → focus Terminal, type `neofetch` → drag a window → type the Notepad sentence. Throughout: music bars dance, monitor graphs scroll, 3D solid spins, clock sweeps. Windows cascade-spawn in staggered waves so the `captureT=9` frame is a rich, arranged multi-window shot. Typing any key / moving the mouse hands control to the user (existing arbitration).

## Verification

- `CAPTURE_PNG=...png CAPTURE_T=<t>` at several timestamps (e.g. 3/6/9/15/22 s) rendered headless, then **visually inspected** (per `feedback_verify_demos_visually`).
- `BENCH=1` sanity for throughput.
- `tsc` clean. No new lint/audit surface (example file, not shipped).

## Out of scope

- Edge-drag resize (corner only). Real web/network. Real audio. Persisting documents. New engine/`CharTerm` APIs.
