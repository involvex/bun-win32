# PROJECTS — what to build on bun-win32

_Last updated 2026-06-09. A decision document: 14 product proposals built on the 117-package `@bun-win32` FFI surface, ranked by a feasibility-and-impact review, each verified against the bindings and demos already in this repo._

---

## Why `bun:ffi` on Windows changes the calculus

Every package here binds a Windows system DLL directly through `bun:ffi`: no build step, no `node-gyp`, no prebuilt-binary matrix, no marshaling layer. After the first call resolves a symbol via `dlopen`, every subsequent call is a direct native pointer invocation. That single property dissolves the dominant failure mode of the Node-on-Windows ecosystem — the install-time C toolchain — for an entire class of libraries.

The incumbent FFI lineage proves the wound is structural, not incidental. The classic `node-ffi` (`ffi`, last published 2018) cannot compile against modern V8 and is frozen with 247 open issues; its N-API successor `ffi-napi` still pulls 25,278 downloads/week yet last shipped 2021-03-18 and carries an open issue literally titled "PLEASE ARCHIVE THIS REPO" (https://github.com/node-ffi-napi/node-ffi-napi/issues/269). The **only** actively maintained general FFI addon, `koffi` (2,898,049/wk, https://api.npmjs.org/downloads/point/last-week/koffi), is still a native C++ addon with an install-time build/prebuild step and a single maintainer — painful enough that the ecosystem grew a dedicated Electron-pruning plugin and a per-platform repack (`koffi-cream`) just to cope with its 28–86MB bundled binaries. Against that, `bun:ffi` is built into the runtime (TinyCC-JIT'd bindings) and is officially benchmarked at "roughly 2-6x faster than Node.js FFI via Node-API" (https://bun.com/docs/api/ffi), with no marshaling layer added on top.

**Honest scoping, stated up front:** every proposal here is **Windows-only and Bun-only.** That is acceptable for three reasons. First, most of these pains are Windows-specific anyway — `node-gyp` is at its historical worst on Windows, the WMIC removal is a Windows event, and corporate-proxy TLS, Credential Manager, and the registry are Windows concepts. Second, several proposals have **no working alternative on any runtime** (real-time decoded ETW, an accessibility-tree query API, placeholder filesystems, non-browser passkeys). Third, the play is never "replace the cross-platform incumbent everywhere" — it is "be the definitive Windows backend that the incumbent serves worst," shipped as its own package the way `@bun-win32/terminal` already is. `bun:ffi` still carries an "experimental" docs label; this repo's 117 shipped packages and working demo corpus are the strongest available counter-evidence.

---

## The 14 proposals at a glance

| # | Project | Replaces / competes with | Their weekly downloads | Why we win | Effort |
|---|---------|--------------------------|------------------------|------------|--------|
| 1 | **bun-sysmon** — metrics + ETW/Event Log observability | systeminformation, pidusage, ps-tree, ps-list | ~20M/wk cluster (systeminformation 7.07M) | µs sampling, no shell, decoded ETW firehose npm has no rival for | medium |
| 2 | **bun-uia** — Playwright-for-Windows-desktop | @nut-tree-fork/nut-js, robotjs, iohook | 56,700/wk (orphaned nut.js) | accessibility-tree query+invoke; proven clicking Calculator | medium |
| 3 | **bun-netdiag** — syscall-grade network + WiFi | default-gateway, node-wifi, ping, net-ping | 9.78M/wk (default-gateway) | locale-proof binary structs, no-admin ICMP, no command injection | medium |
| 4 | **bun-gpu** — runtime-compiled D3D11 compute | gpu.js, gl, tfjs-node, webgpu | 15,972/wk (gpu.js); tfjs-node 110k | vendor-universal, ~30 working demos incl. a transformer | medium |
| 5 | **bun-media** — DXGI capture + ffmpeg-free transcode | fluent-ffmpeg, screenshot-desktop, ffmpeg-static | 1.98M/wk (fluent-ffmpeg) | 0-byte codec payload, GPU frame stream npm lacks | medium |
| 6 | **bun-shell** — toasts, tray, recycle bin, open | node-notifier, trash, open, default-browser | 108M/wk (open); node-notifier 5.68M | own-AUMID toasts, tray icons (npm monopoly), no SnoreToast.exe | medium |
| 7 | **bun-passkey** — Windows Hello / FIDO2 | (no npm path exists) | keytar 2.26M/wk (adjacent demand) | raises the real Hello prompt; capability monopoly | medium |
| 8 | **bun-keyring** — credential vault | keytar, @napi-rs/keyring, win-dpapi | 2,261,022/wk (keytar) | zero build, enterprise persist + attribute blob-chunking | small |
| 9 | **bun-winreg** — in-process typed Registry | winreg, regedit, @vscode/windows-registry | 994,607/wk (winreg) | µs reads, no chcp/spaces bug class, change-watching | small |
| 10 | **bun-conpty** — ConPTY host + console input | node-pty, @lydell/node-pty, blessed | 21.1M/wk (node-pty) | the "binary" is kernel32; key-up/repeat/mouse input plane | medium |
| 11 | **bun-wincerts** — CA-store reader + Authenticode | win-ca, @vscode/windows-ca-certs | 103,098/wk (win-ca) | zero install on locked-down boxes; verifier npm lacks | small |
| 12 | **bun-gamepad** — XInput + DirectInput + GameInput + HID | node-gamepad, xinput-ffi, node-hid | 301,616/wk (node-hid substrate) | all four stacks proven; non-exclusive HID open | medium |
| 13 | **bun-cloudfiles** — placeholder filesystem | (no npm package exists) | @parcel/watcher 26.6M/wk (adjacent) | literal capability monopoly; 20GB placeholders verified | medium |
| 14 | **bun-winsvc** — services, elevation, tasks | sudo-prompt, node-windows, os-service | 2.66M/wk (sudo-prompt); ~7M cluster | real SCM, runas hProcess, reboot-surviving tasks | medium |

---

## 1. bun-sysmon — native-speed metrics + live ETW/Event Log observability

**`bun-sysmon`: CPU/memory/disk/process/socket metrics via PDH, PSAPI, NtQuerySystemInformation, and iphlpapi, plus a decoded real-time ETW firehose and typed Event Log tailing — no PowerShell spawn, no `wmic`, microsecond sampling.**

**The gripe.** The ~20M/wk system-info cluster rests on spawning `wmic`/PowerShell or compiling `node-gyp`. Microsoft removed `wmic` in Windows 11 24H2/Server 2025, which hard-broke `pidusage` (4,458,787/wk), `pm2`, and `ps-tree` (3,345,462/wk, abandoned since 2018) (https://github.com/soyuka/pidusage/issues/183 + https://github.com/indexzero/ps-tree/issues/69). The universal "fix" is spawning `powershell.exe` — 100ms-class latency versus microsecond counters. `systeminformation` (7,065,100/wk) turned its command-string concatenation into a serial command-injection CVE factory: CVE-2025-68154 (up to CVSS 10) and CVE-2024-56334, both from concatenating a drive/SSID into PowerShell/cmd (https://github.com/advisories/GHSA-wphj-fx3q-84ch + https://advisories.gitlab.com/pkg/npm/systeminformation/CVE-2024-56334/). The native alternatives are no better: `ps-list`'s vendored `fastlist.exe` was flagged as a Trojan by BitDefender and breaks under `pkg` bundling (https://github.com/sindresorhus/ps-list/issues/42), and `@vscode/windows-process-tree` and `diskusage` run `node-gyp rebuild` on every install, breaking on each Node/Electron ABI bump (https://github.com/nodejs/node-gyp/issues/2807). Meanwhile the deeper layer — real-time ETW tracing and schema-aware Event Log consumption — has **no npm package at all** without a `node-gyp` ETW addon.

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| systeminformation | 7,065,100 | pure JS, spawns PowerShell | active | command-injection CVE class |
| pidusage | 4,458,787 | pure JS, spawns wmic→PS | stale | broke on 24H2 wmic removal |
| check-disk-space | 3,408,373 | pure JS, spawns PowerShell | stale (3yr) | per-check process spawn |
| ps-tree | 3,345,462 | pure JS, spawns wmic | abandoned (2018) | hard-broken on Server 2025 |
| ps-list | 1,621,894 | vendored fastlist.exe | active | AV-quarantined; dies under pkg |
| node-os-utils | 128,732 | PowerShell/WMI spawns | revived | weak Windows coverage |
| @vscode/windows-process-tree | 68,433 | node-gyp rebuild | active | toolchain on every install |
| diskusage | 55,361 | node-gyp rebuild (nan) | abandoned | breaks on every V8 bump |

**How we build it.** Packages: `@bun-win32/{pdh, psapi, ntdll, iphlpapi, kernel32, tdh, advapi32, wevtapi}`. Key APIs: `pdh:PdhAddEnglishCounterW`/`PdhCollectQueryData`/`PdhGetFormattedCounterValue`; `psapi:EnumProcesses`/`GetProcessMemoryInfo`; `ntdll:NtQuerySystemInformation`; `iphlpapi:GetExtendedTcpTable`; `kernel32:GlobalMemoryStatusEx`; `advapi32:StartTraceW`/`OpenTraceW`/`ProcessTrace`; `tdh:TdhGetEventInformation`/`TdhEnumerateProviders`; `wevtapi:EvtQuery`/`EvtNext`/`EvtRender`/`EvtFormatMessage`. All 17 are bound with exact export names. **MVP surface:** typed `SYSTEM_PROCESS_INFORMATION`/`MIB_TCPROW` parsers, ergonomic PDH wrappers, an `AsyncIterable` Event Log tail. De-risked by `packages/pdh/example/live-dashboard.ts`, `packages/psapi/example/process-forensics.ts`, `packages/all/example/process-xray.ts`, `packages/ntdll/example/system-internals.ts`, `packages/all/example/net-xray.ts`, `packages/all/example/etw-firehose.ts` (kernel-process ETW logger with non-admin fallback), plus `provider-explorer.ts` and `event-tail.ts`.

**Why we win.**
- No shell, no command-string concatenation → the systeminformation command-injection CVE class is structurally impossible.
- Microsecond direct-pointer sampling enables 1000Hz dashboards vs ~100ms `powershell.exe` spawns per metric.
- Reaches data shell-outs can't: per-process IO/handle counts, socket→PID via `GetExtendedTcpTable`, the full process tree in one `NtQuerySystemInformation` call.
- Locale-independent English PDH counter names; works inside single-file bundles where `ps-list`'s embedded exe dies.
- A decoded kernel/process ETW firehose plus a no-privilege provider/schema census — a Procmon-lite feed npm has no rival for — and a colorized Event Log tail with publisher message formatting.

**Risks & scope.** Windows-only; the cross-platform breadth is systeminformation's main value. Rate counters require careful two-sample deltas. Real-time ETW logger sessions (`StartTraceW`/`EnableTraceEx2`) **require elevation** — lead the marketing with the no-admin surface (PDH/psapi/ntdll/iphlpapi metrics + `wevtapi` tail) and position the kernel ETW firehose as an elevated-mode bonus; the shipped demo already auto-falls-back. `ProcessTrace` **blocks the event loop** while pumping — for a library `AsyncIterable`, run the real-time feed as a dedicated blocking pump or in a Worker that owns its session and posts serialized events (never share Buffer pointers across `worker_threads`). Keep `EvtSubscribe` push (foreign-thread hazard) out of the MVP; ship the proven `EvtQuery` PULL + polling tail.

**Effort & first milestone.** Medium — bindings and end-to-end demos already exist; remaining work is productizing. **First milestone:** a 1000Hz task-manager-in-the-terminal (CPU/mem/per-process IO + socket→PID) on the in-house terminal engine, plus a colorized live Event Log tail, both no-admin.

---

## 2. bun-uia — Playwright-for-Windows-desktop via UI Automation

**`bun-uia`: drive and test native Windows apps by querying the UI Automation tree and invoking controls by name — proven clicking Calculator — with no `node-gyp`, no global hooks, no paywalled prebuilds.**

**The gripe.** The desktop-automation cluster (~110k dl/wk) is entirely `node-gyp`/ABI pain. `robotjs` (12,738 stars) went unpublished from 2019-12-08 to 2026-03-11 — a 6.25-year gap — fragmenting into three diverged forks, with endless "module version mismatch even after rebuild" threads (https://registry.npmjs.org/robotjs + https://github.com/octalmage/robotjs/issues/244). `nut.js`'s maintainer burned out, pulled the public packages (the registry now 404s, breaking downstream apps like `jan`), and paywalled prebuilds — so the cluster's highest-download package is a 15-month-stale third-party republish, `@nut-tree-fork/nut-js` at 56,700/wk (https://api.npmjs.org/downloads/point/last-week/@nut-tree-fork%2Fnut-js + https://nutjs.dev/blog/i-give-up). `iohook` (1,006/wk) is dead with an ABI-frozen prebuild matrix. **None offer an accessibility-tree query API for E2E testing native apps** — exactly what the 2026 computer-use-agent wave needs.

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| @nut-tree-fork/nut-js | 56,700 | prebuilt libnut binaries | stale (15mo) | republish of paywalled upstream |
| @jitsi/robotjs | 14,869 | node-gyp + prebuilds | active (narrow) | one of three diverged forks |
| robotjs | 9,885 | node-gyp / prebuild | revived after 6.25yr | blind pixel/keystroke tool |
| iohook | 1,006 | per-ABI prebuild matrix | dead (2021) | uninstallable on modern runtimes |

**How we build it.** Packages: `@bun-win32/{uiautomationcore, combase, oleacc, user32}`. Key APIs: `uiautomationcore:UiaNodeFromHandle`/`UiaGetPatternProvider`/`UiaLookupId`; `oleacc:AccessibleObjectFromPoint`/`AccessibleObjectFromWindow`; `user32:EnumWindows`/`GetForegroundWindow`/`SendInput`/`PrintWindow`. **MVP surface:** element query by name/control-type via `CreateTrueCondition` + `FindAll` + a TypeScript filter (the proven workaround for the infeasible `CreatePropertyCondition` by-value-VARIANT segfault), `InvokePattern`, plus a `get_CurrentBoundingRectangle` + `SendInput` mouse-click fallback for controls lacking `InvokePattern`. The flagship proof is `packages/all/example/uia-automation.ts`, which launches Calculator, walks its live UIA tree via cast-free COM vtables, and physically clicks buttons to compute 5+3=8. Also de-risked by `packages/user32/example/focus-radar.ts`, `pattern-probe.ts`, and oleacc's `ui-tree-inspector.ts`/`accessibility-radar.ts`.

**Why we win.**
- Polling-by-design — sidesteps the `SetWinEventHook`/`UiaAddEvent` foreign-thread callback risk that destabilizes the C-addon cluster.
- An accessibility-driven E2E test driver and "click the button named X in app Y" automation — a capability the blind pixel-and-keystroke incumbents never offered at any build cost.
- Strict TypeScript element API versus robotjs's untyped JS and the forks' drifting `.d.ts` files; runs natively on Bun.
- `InvokePattern` proven physically clicking Calculator, plus `PrintWindow` screenshots for visual assertions.

**Risks & scope.** Windows-only, Bun-only. `CreatePropertyCondition` is **known infeasible** (by-value VARIANT segfault) — use `CreateTrueCondition` + `FindAll` + TS filter (documented in `uia-automation.ts`). `ValuePattern` is **not yet proven** — only `InvokePattern` is demonstrated; prove `ValuePattern` against Notepad before pitching, and use the already-bound `SendInput` for MVP text entry. The UIA activation chain (`CoCreateInstance`/`CoInitializeEx`/`CLSIDFromString`) is bound nowhere — the demo inline-`dlopen`s `combase.dll`; a shipping package should bind these into `@bun-win32/combase` (routine work). Drop `RoGetActivationFactory` from the API surface — it is the WinRT path, irrelevant to in-proc `CLSID_CUIAutomation`. Global keyboard listening via `SetWindowsHookExW` is foreign-thread-risky — use polling `GetAsyncKeyState`.

**Effort & first milestone.** Medium — the hard FFI trap is already solved; remaining cost is wait/retry/targeting **API design** atop a proven surface, not new bindings. **First milestone:** a `bun-uia` script that finds Notepad by window title, types into it via `SendInput`, reads the text back from the UIA value, and asserts — a real E2E round-trip.

---

## 3. bun-netdiag — syscall-grade network diagnostics + WiFi

**`bun-netdiag`: routing table, socket→PID map, ICMP ping, ARP table, and WiFi scan/connect via iphlpapi/wlanapi structs — no `netsh`/`ping.exe`/`wmic` scraping, no locale parsing, no command-injection surface.**

**The gripe.** The whole cluster is text-scrapers. `default-gateway` (9,783,061/wk) is GitHub-archived and its Windows path requires `wmic`, which Microsoft has removed from current Windows 11 (https://api.npmjs.org/downloads/point/last-week/default-gateway + https://github.com/silverwind/default-gateway). `node-wifi` parses locale-dependent `netsh` output, breaking on non-English Windows and returning wrong data on Windows 11 (https://github.com/friedrith/node-wifi/issues/143, #184). `ping` spawns `ping.exe` and breaks on French/Chinese locale output while flashing a CMD window in Electron; the only non-scraping option, `net-ping`/`raw-socket`, is a `node-gyp` addon that won't build on Node 20/24 and needs Administrator (https://github.com/danielzzz/node-ping/issues/65 + https://github.com/nospaceships/node-raw-socket/issues/87, #91).

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| default-gateway | 9,783,061 | spawns wmic via execa | archived | depends on removed wmic |
| ping | 180,511 | spawns ping.exe | active (capped) | locale parsing; CMD-window flash |
| node-wifi | 2,624 | spawns netsh | stale (2021) | locale/Win11 parser drift |
| local-devices | 2,668 | spawns arp -a | stale | Unix arp flags hardcoded |
| net-ping | 1,989 | node-gyp raw-socket | low-activity | won't build Node 20/24; needs admin |

**How we build it.** Packages: `@bun-win32/{iphlpapi, wlanapi, dnsapi, ws2_32}`. Key APIs: `iphlpapi:GetExtendedTcpTable`/`GetIpForwardTable2`/`GetIpNetTable2`/`IcmpSendEcho`/`GetAdaptersAddresses`; `wlanapi:WlanGetAvailableNetworkList`/`WlanScan`; `dnsapi:DnsQuery_W`. **MVP surface:** an ergonomic struct→JS-object wrapper layer over routing/ARP/socket tables, no-admin ICMP, and a polling WiFi scan. Three demos were executed live during review: `IcmpSendEcho` ping (no admin, status `IP_SUCCESS`), `packages/iphlpapi/example/network-diagnostic.ts` (real adapters/routes/DNS), and `packages/dnsapi/example/dns-forensics.ts` (real A/NS/SOA/MX/TXT). Also de-risked by `packages/all/example/net-xray.ts` (socket→PID), `packages/wlanapi/example/signal-monitor.ts`, and `packages/all/example/packet-sniffer.ts` (driverless capture without Npcap).

**Why we win.**
- WiFi/routing/ARP/ping returned as binary structs — locale-proof, Unicode-SSID-proof, no Win10-vs-Win11 parser drift, no command-injection surface because no shell is invoked.
- `IcmpSendEcho` needs **no Administrator and no `node-gyp`** (unlike raw sockets) and returns a structured reply — no `ping.exe` spawn, no CMD-window flash.
- `GetIpForwardTable2` reads the default gateway directly (replacing archived, wmic-dependent `default-gateway`); `GetExtendedTcpTable` gives per-process socket attribution.
- Sub-millisecond polling for live dashboards, impossible when every sample costs a process spawn.

**Risks & scope.** Windows-only — position as "the Windows backend done right," not a cross-platform drop-in. WiFi scan must stay on the proven polling pattern (`WlanScan` → ~4s sleep → `WlanGetAvailableNetworkList`); never `WlanRegisterNotification` (foreign-thread callback). `WlanConnect`/`WlanSetProfile` are bound and signature-correct but unexercised against a live AP — ship WiFi-connect as a flagged/beta feature and verify state by polling `WlanQueryInterface`. Drop mDNS/`DnsServiceBrowse` from the MVP (worker-thread completion callback). Scope the "no Administrator" claim strictly to ICMP ping — `packet-sniffer.ts`'s `SIO_RCVALL` raw capture explicitly requires admin.

**Effort & first milestone.** Medium, conservatively — bindings and demos already exist; the work is the struct-to-object wrapper layer. **First milestone:** a live route/ARP/socket→PID dashboard plus no-admin ping, refreshing at sub-millisecond sampling.

---

## 4. bun-gpu — runtime-compiled D3D11 compute and headless rendering

**`bun-gpu`: `gpu.run(hlslSource, buffers)` — compile HLSL at runtime with `d3dcompiler_47`, dispatch D3D11 compute on any GPU vendor (NVIDIA/AMD/Intel/WARP), read back typed buffers — kilobytes of TypeScript where the incumbents ship 266MB tarballs, 71MB wasm shims, or `node-gyp` ANGLE builds.**

**The gripe.** GPU compute in JS is a graveyard bracketed by abandonment and bloat. `gpu.js` (15,358 stars, 15,972/wk) is dead since Nov 2022, maintainers gone ("Is this project dead?" #807), and its Node GPU mode hard-depends on `headless-gl`, whose `prebuild-install || node-gyp rebuild` ANGLE build breaks on each new VS/Python/Node combination (https://api.npmjs.org/downloads/point/last-week/gpu.js; https://github.com/gpujs/gpu.js/issues/807; https://github.com/stackgl/headless-gl/issues/325). `tfjs-node` (110,266/wk) hasn't published since 2024-10-21 and is confirmed broken on Node 24 (https://api.npmjs.org/downloads/point/last-week/@tensorflow%2Ftfjs-node; https://github.com/tensorflow/tfjs/issues/8609). `onnxruntime-node` 1.26.0 wins by shipping 266,245,395 bytes unpacked — by itself over Vercel's 250MB serverless limit — plus a default CUDA postinstall download (https://registry.npmjs.org/onnxruntime-node/1.26.0). The official WebGPU path `@webgpu/dawn-node` was never published to npm (registry 404).

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| gpu.js | 15,972 | hard-deps headless-gl | dead (2022) | unbuildable native dep |
| gl (headless-gl) | 56,431 | prebuild / node-gyp ANGLE | semi-active | breaks on each VS/Node combo |
| @tensorflow/tfjs-node | 110,266 | node-pre-gyp | frozen | broken on Node 24 |
| webgpu (Dawn repack) | 42,039 | 71MB tarball + postinstall | tiny | pre-1.0; @webgpu/dawn-node is 404 |

**How we build it.** Packages: `@bun-win32/{d3d11, d3dcompiler_47, dxgi, dxcore}`. Key APIs: `d3d11:D3D11CreateDevice`; `d3dcompiler_47:D3DCompile`/`D3DReflect`/`D3DDisassemble`; `dxgi:CreateDXGIFactory1`; `dxcore:DXCoreCreateAdapterFactory`. The full `gpu.run` pipeline exists today in `packages/all/example/_gpu.ts` (~60KB): `createComputeDevice` (headless, no window), `compile`, `makeComputeShader`, `makeStructuredBuffer`, `csSet`, `dispatch`, `readbackBuffer`. **MVP surface:** extract that engine into a real package (the `@bun-win32/terminal` precedent), bake the documented HLSL traps into API guardrails. Proven by ~30 demos that import `_gpu`: `packages/all/example/neural-descent.ts` (GPU-trained MNIST), `nano-gpt.ts` (a running transformer), `pathtracer.ts`, `shader-doctor.ts`, `gpu-observatory.ts`, `adapter-report.ts`.

**Why we win.**
- Not a prototype: a substrate already proven by ~30 working demos including trained neural nets, a transformer, and a progressive path tracer — capability the dead gpu.js never reached.
- Vendor-universal: D3D11 runs on NVIDIA/AMD/Intel and falls back to WARP software — no CUDA toolkit, unlike `tfjs-node-gpu`.
- Full shader toolchain in-process (compile/reflect/disassemble, proven in `shader-doctor.ts`) for a Shadertoy-class dev loop and build-time HLSL validation.
- Ships the hardened cast-free COM vtable invoker as a public primitive — the enabling layer for every other COM-driven product here. Adapter introspection (VRAM, WDDM, compute-only adapters) via DXGI/DXCore included free.

**Why this is held back from #1:** serious GPU users live in Python/ONNX, and the gpu.js-refugee market narrows hard through the HLSL+Windows+Bun funnel.

**Risks & scope.** It is a compute **substrate**, not an ONNX/TF model runtime — position as the layer `onnxruntime` sits on, never a kernel-for-kernel replacement. HLSL, not WGSL/GLSL → porting friction; a transpile layer is future work. Documented in-repo traps need API guardrails: reject/escape backticks in shader source, warn on `noise`-in-`[unroll]` FXC compile time-bombs, keep `compile()` headless. Do **not** expose an `ID3DInclude` callback (foreign-thread/COM-callback) — do `#include` resolution as TS-side preprocessing. D3D12 is unproven in-repo — stay on D3D11 for v1. FXC caps shaders at SM 5.x (fine for D3D11 v1). Windows-only, Bun-only; publish readback-throughput benchmarks before performance claims.

**Effort & first milestone.** Medium — packaging already-proven code, not a feasibility bet. **First milestone:** `bun add @bun-win32/gpu` then a 10-line `gpu.run` that compiles a trivial HLSL kernel, dispatches on WARP, and reads back a typed buffer — "nothing compiles, runs on any GPU."

---

## 5. bun-media — DXGI screen capture + ffmpeg-free probe, thumbnail, transcode, record

**`bun-media`: continuous GPU-side desktop capture (frame stream with dirty rects, per-monitor/window capture, instant PNG screenshots) plus typed media probing, thumbnailing, transcode, and screen/webcam record-to-MP4 using Windows' in-box hardware-accelerated H.264/HEVC/AAC MFTs — zero codec payload, zero postinstall download, zero spawned binary.**

**The gripe.** Both halves of the media stack are rotten. **Capture:** `screenshot-desktop` (63,627/wk) copies a 2015-era self-compiling `.bat` to `%TEMP%` and round-trips every frame through `cmd.exe` + .NET + a temp PNG; Electron-asar ENOENT breakage dominates its tracker (https://api.npmjs.org/downloads/point/last-week/screenshot-desktop; github.com/bencevans/screenshot-desktop/issues/135). `node-screenshots` (24,461/wk) hasn't published since Dec 2024 and crashes Electron without a full-frame copy (https://github.com/napi-rs/napi-rs/issues/1346). Nobody offers continuous high-fps capture as an API. **Encoding:** `fluent-ffmpeg` is npm-deprecated with its repo archived May 2025 yet still pulls 1,981,676/wk (api.github.com/repos/fluent-ffmpeg/node-fluent-ffmpeg archived:true). Getting a binary means `ffmpeg-static`'s postinstall GitHub download (1,008,810/wk, fails behind proxies/CI), `ffprobe-static`'s 351,499,535-byte tarball, or the wasm exit that dropped Node support and caps files at 2GB (https://github.com/ffmpegwasm/ffmpeg.wasm/issues/897).

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| fluent-ffmpeg | 1,981,676 | spawns external ffmpeg | deprecated + archived | dead CLI-string generator |
| ffmpeg-static | 1,008,810 | postinstall binary download | active | fails behind proxies/CI; Lambda |
| ffprobe-static | 304,097 | 351MB all-platforms tarball | stale | 351,499,535-byte install |
| screenshot-desktop | 63,627 | bundled .bat via cmd.exe | active (frozen) | asar ENOENT; per-shot temp file |
| node-screenshots | 24,461 | napi prebuilds | stale (18mo) | Electron crash without copy |

**How we build it.** Packages: `@bun-win32/{dxgi, d3d11, mfreadwrite, mfplat, mf, ole32, gdiplus, gdi32, user32}`. Key APIs: `dxgi:CreateDXGIFactory1`; `d3d11:D3D11CreateDevice`; `mfreadwrite:MFCreateSourceReaderFromURL`/`MFCreateSinkWriterFromURL`; `mfplat:MFStartup`/`MFCreateMediaType`/`MFTEnumEx`/`MFCreateSample`/`MFCreateMemoryBuffer`; `ole32:CoInitialize`; `gdiplus:GdipSaveImageToFile`; `gdi32:BitBlt`/`CreateDIBSection`; `user32:PrintWindow`. **MVP surface:** ship screenshots/frame-streams first (extraction + API design over `packages/all/example/_capture.ts` DXGI duplication and `_snapshot.ts`), then recording after the SinkWriter spike. The decode half is fully de-risked: `packages/all/example/webcam.ts` drives the live `SourceReader` `ReadSample`/`Lock` loop on hardware, `media-library-dashboard.ts` reads real durations, `mft-transform-census.ts` enumerates installed codecs, and `mfreadwrite-factory-probe.ts` creates a live `IMFSinkWriter`.

**Why we win.**
- True scan-out frames via `IDXGIOutput1` duplication catch layered overlays/magnification GDI `BitBlt` cannot see; a frame **stream** with dirty-rect metadata and zero-copy mapped-buffer access, polled synchronously — exactly what 2026 computer-use agents need.
- 0 bytes of codec payload vs 48KB+80MB download / 351MB tarball / 64.7MB wasm; installs identically in proxied CI, Electron-alternative packaging, and Lambda.
- Hardware-accelerated in-box MFTs via direct pointer calls, not child-process stderr parsing.
- Headline capability no npm package offers dependency-free: screen-record-to-MP4 plus webcam-to-MP4 and frame-accurate thumbnails.

**Risks & scope.** **THE gating risk:** the `IMFSinkWriter` `AddStream`/`SetInputMediaType`/`BeginWriting`/`WriteSample`/`Finalize` loop is unproven (creation is proven; it is in-proc COM, so expected to work) — run a 1-week spike before committing the recording roadmap, honor the FFI struct GC-window rule (no awaits between buffer assembly and `WriteSample`), and remember vcall `argTypes` exclude `this`. **System-audio (loopback) recording is impossible** per repo ground truth (`IAudioClient` segfaults cross-apartment) — the only audio path is WinMM `waveIn` mic → AAC MFT; document "screen-record-to-MP4" as video-only or video+mic, never +system-audio. DXGI duplication is single-consumer and dies on display lock — the GDI/`PrintWindow` fallback is **mandatory**, including in CI where parallel agents collide. Bind `MFEnumDeviceSources` in `@bun-win32/mf` (~30-min gap). Frame-stream pacing must use the `@bun-win32/terminal` high-res waitable timer, not `Bun.sleep` (15.6ms quantization caps ~30fps). Windows-only, Bun-only.

**Effort & first milestone.** Medium — realistic only if recording ships after the spike. **First milestone:** a dependency-free continuous desktop frame stream → instant PNG screenshots, with the GDI fallback wired; then the SinkWriter write-loop spike gates record-to-MP4.

---

## 6. bun-shell — toasts, tray icons, recycle bin, shortcuts, and open

**`bun-shell`: real Action Center toasts (proven via WinRT activation), system-tray icons, recycle-bin-aware delete, `.lnk` shortcuts, autostart, and `ShellExecuteW` open via direct FFI — no bundled SnoreToast.exe/windows-trash.exe, no PowerShell cold-start, no NodeRT.**

**The gripe.** This cluster is "Windows shell integration by shelling out." `node-notifier` (5,681,778/wk, last published Feb 2022, 127 open issues) vendors `SnoreToast.exe` that brands toasts "SnoreToast," pollutes the Start Menu, is AV-flagged, and shipped OS command-injection CVE-2020-7789 that rippled into Jest (https://github.com/mikaelbr/node-notifier/issues/314 + https://github.com/advisories/GHSA-5fw9-fq32-wv5p). `trash` (151,751/wk) deletes files **unrecoverably** on Windows when no recycle bin exists because its vendored exe can't report `SHFileOperation` results (https://github.com/sindresorhus/trash/issues/107). `open` (108,289,307/wk) and `default-browser` (39,335,058/wk) spawn PowerShell/`reg.exe` per call and scrape localized stdout (https://github.com/PowerShell/PowerShell/issues/17734). `create-desktop-shortcuts` relies on VBScript, which Microsoft has scheduled for default-off in 2027 (https://woshub.com/disable-vbscript-windows/). Tray icons have **no maintained non-Electron npm answer** (`trayicon` 156/wk and `systray` 786/wk spawn .NET/Go sidecars).

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| open | 108,289,307 | spawns PowerShell/start | active | PowerShell cold-start latency |
| default-browser | 39,335,058 | scrapes reg.exe stdout | active | ProgId regex; localized output |
| node-notifier | 5,681,778 | vendored SnoreToast.exe | stale (2022) | branding, Start-Menu pollution, CVE |
| trash | 151,751 | vendored windows-trash.exe | active | silent permanent delete |
| create-desktop-shortcuts | 1,951 | wscript + VBScript | active | mechanism scheduled for removal |
| trayicon / systray | 156 / 786 | .NET / Go sidecar exe | stale | no non-Electron answer |

**How we build it.** Packages: `@bun-win32/{combase, shell32, advapi32, user32, ole32}`. Key APIs: `combase:RoActivateInstance`/`RoGetActivationFactory`/`WindowsCreateString`; `shell32:SetCurrentProcessExplicitAppUserModelID`/`SHFileOperationW`/`Shell_NotifyIconW`/`ShellExecuteExW`/`SHGetFileInfoW`; `user32:CreateWindowExW`/`RegisterClassExW`/`CreatePopupMenu`/`TrackPopupMenu`; `advapi32:RegSetKeyValueW`. The hardest piece is **already done**: `packages/combase/example/toast-notification.ts` raises a real Action Center toast via `RoActivateInstance(XmlDocument)` + `IToastNotifier::Show` through hand-walked vtables. `packages/shell32/example/recycle-bin-dive.ts` proves `SHQueryRecycleBinW`; `packages/user32/example/mouse-trail.ts` proves `CreateWindowExW` + `PeekMessage` pump.

**Why we win.**
- Toasts via real WinRT activation carry the app's own AUMID (`SetCurrentProcessExplicitAppUserModelID` bound) — killing the SnoreToast-branding and Start-Menu-pollution bug class, with no PowerShell and no bundled exe for AV to flag.
- Recycle bin via `SHFileOperationW` with real HRESULTs — fixes `trash`'s silent permanent-delete and batches natively instead of one exe spawn per 200 paths.
- Tray icons via `Shell_NotifyIconW` + `TrackPopupMenu` on an owned message pump — a capability that **does not exist on npm outside Electron**.
- Autostart via typed `RegSetKeyValueW` (no `reg.exe` scraping) and `ShellExecuteW` open with no PowerShell cold start for the 108M-dl/wk hot path.

**Risks & scope.** Windows-only, Bun-only. **Note the 108M/wk `open` figure is cross-platform demand** — a Bun-Windows package addresses a fraction of it. Toast activation callbacks fire on foreign WinRT threads — route activations via launch arguments or sequence-number polling, not handlers. `.lnk` creation (`IShellLinkW` + `IPropertyStore`) is unproven and must come **first**: an arbitrary AUMID only renders toasts if registered via a Start Menu shortcut carrying `System.AppUserModel.ID`; build the shortcut writer before the toast product, with a documented existing-AUMID fallback. `CoCreateInstance`/`CoInitializeEx`/`CLSIDFromString` are unbound — inline-`dlopen` `combase.dll` (precedented) or bind them properly. The tray MVP needs `NOTIFYICONDATAW` packing (~976B on x64) and an owned-window pump assembled into a shipped example (no tray example exists yet).

**Effort & first milestone.** Medium — the hardest item (WinRT toast) is done; remaining vtable work is simpler than shipped precedents. **First milestone:** a TypeScript one-liner that raises an own-AUMID toast (after the `.lnk`+`IPropertyStore` writer lands), plus a recycle-bin delete returning real HRESULTs.

---

## 7. bun-passkey — Windows Hello / FIDO2 passkeys for desktop & CLI apps

**`bun-passkey`: raise the real Windows Hello prompt for passkey registration and assertion from Bun — passwordless desktop and CLI auth with no browser and no native addon.**

**The gripe.** Passkeys outside the browser (desktop app login, a `gh auth`-style CLI sign-in) have **no zero-build npm path** — the Windows platform authenticator lives in `webauthn.dll` and is unreachable without an FFI binding. The adjacent secret-storage demand shows the scale of the passwordless pain: `keytar` (2,261,022/wk) is archived since Dec 2022 with never-to-be-fixed Windows bugs (first-letter-only reads, injected NUL bytes), and its `electron-rebuild`/`node-gyp` story is the canonical ABI horror (https://api.npmjs.org/downloads/point/last-week/keytar + https://github.com/atom/node-keytar/issues/213). Passkeys are the modern successor to the stored secret these libraries fight over. _(The keytar figure is adjacent-demand framing only — keytar is a secrets vault, not a direct passkey competitor.)_

**What we replace.** No direct npm competitor — this is a capability monopoly. The nearest reference points are browser-only WebAuthn flows and the abandoned secret-storage cluster.

**How we build it.** Package: `@bun-win32/webauthn` (plus `@bun-win32/{kernel32, user32}` for the parent HWND via `GetConsoleWindow`/`GetForegroundWindow` and for decoding DLL-returned structs via `ReadProcessMemory`). Key APIs: `webauthn:WebAuthNAuthenticatorMakeCredential`/`WebAuthNAuthenticatorGetAssertion`/`WebAuthNGetPlatformCredentialList`/`WebAuthNGetApiVersionNumber`/`WebAuthNCancelCurrentOperation`. **MVP surface:** a typed product wrapper (CBOR/attestation parsing, an options builder that hides the GC-window discipline) and CLI ergonomics. Proven end-to-end by `packages/webauthn/example/passkey-ceremony.ts` — hand-assembled WebAuthn structs raise the real Windows Hello prompt for full FIDO2 registration + assertion. During review, a headless diagnostic negotiated `webauthn.dll` API version 9, confirmed the platform authenticator available, and enumerated **12 real stored passkeys** (decoded RP + user identity from native memory).

**Why we win.**
- Raises the actual Windows Hello prompt (face/PIN/fingerprint/security-key) from a console Bun process — proven.
- Packages the hard part (hand-assembled WebAuthn structs plus the FFI struct-GC discipline) behind a typed API.
- Platform-credential enumeration and (caveated) cancellation bound.
- Zero build step — a capability monopoly versus a non-existent npm alternative.

**Risks & scope.** Windows-only, Bun-only — and **a forward-looking niche today**: non-browser passkey ceremonies on Bun are an early (if growing) market, so impact is rising-but-modest rather than a current mass wound. The FFI struct-GC window is a real trap — structs must be assembled immediately before the blocking `MakeCredential`/`GetAssertion` call (an await invalidates baked-in Buffer ptrs → `E_INVALIDARG`), and WebAuthn rejects `options=NULL`. The ceremony blocks the JS thread while the prompt is up. Soften "in-flight cancellation": `WebAuthNCancelCurrentOperation` cannot fire from the same blocking thread — position it as `GetCancellationId` + dialog/timeout-driven cancel, or prove a worker-process path. WinRT `KeyCredentialManager` (Hello beyond WebAuthn) is unbound.

**Effort & first milestone.** Medium — binding and proofs are done; remaining work is the typed product wrapper and CLI ergonomics. **First milestone:** a `bun-passkey register` / `bun-passkey login` CLI that completes a real Hello ceremony and persists the credential id.

---

## 8. bun-keyring — zero-build Windows credential vault

**`bun-keyring`: a fully-typed Credential Manager + DPAPI secrets library for Bun on Windows that replaces the abandoned keytar with `bun add` and nothing to compile.**

**The gripe.** `keytar` is the defining wound of npm secret storage: 2,261,022 downloads/week 3.5 years after GitHub archived the repo (Dec 15, 2022), with **no npm deprecation flag** — so millions of installs/week silently ride an unmaintained C++ addon (https://api.npmjs.org/downloads/point/last-week/keytar). On Windows it returns only the first letter of stored passwords and injects NUL bytes — never fixed, repo read-only (https://github.com/atom/node-keytar/issues/213, #358). VS Code removed its keytar shim in Sept 2023 explicitly because keytar is archived (https://github.com/microsoft/vscode/issues/115215). The Rust successor `@napi-rs/keyring` (247k/wk) still ships 12 optionalDependency platform binaries and inherits the Credential Manager blob-size limit that breaks JWT/SSO tokens (https://registry.npmjs.org/@napi-rs%2Fkeyring + https://github.com/docker/docker-credential-helpers/issues/190).

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| keytar | 2,261,022 | prebuild / node-gyp | abandoned (archived 2022) | first-letter reads; NUL bytes |
| @napi-rs/keyring | 247,142 | 12 prebuilt platform binaries | active | blob-size limit; binary matrix |
| @zowe/secrets-for-zowe-sdk | 261,845 | bundled prebuild + rebuild hook | active | postinstall rebuild fallback |
| @primno/dpapi | 7,580 | node-gyp .node | stale | bus-factor-one DPAPI |
| win-dpapi | 954 | node-gyp rebuild every install | abandoned (2020) | needs MSVC on every install |

**How we build it.** Packages: `@bun-win32/{advapi32, crypt32, ncrypt}`. Key APIs: `advapi32:CredWriteW`/`CredReadW`/`CredDeleteW`/`CredEnumerateW`/`CredFree`; `crypt32:CryptProtectData`/`CryptUnprotectData`; `ncrypt:NCryptProtectSecret` (+ the full DPAPI-NG trio). **MVP surface:** the wrapper layer, a `CREDENTIALW` codec, blob-chunking-via-attributes, and two proving examples. Live during review: `CredWriteW`→`CredReadW`→`CredFree`→`CredDeleteW` returned success with **byte-exact 43-byte password recovery** (the exact disproof of keytar's first-letter bug), and `CredEnumerateW` enumerated 71 real credentials. `packages/crypt32/example/secret-vault.ts` proves the `CryptProtectData`/`CryptUnprotectData` round-trip.

**Why we win.**
- Zero build step: no `node-gyp`, no MSVC/Python, no prebuild matrix, no postinstall — works under Bun's default `ignore-scripts` and in CI/WSL.
- Exposes what every wrapper hides: `CRED_PERSIST_ENTERPRISE` roaming, credential **attributes** (the documented workaround for the ~2,560-char blob limit that breaks JWT/SSO tokens), `CRED_TYPE` filtering, machine-vs-user DPAPI scope.
- Strict SAL-derived TS signatures fail misuse at compile time vs keytar's untyped promise wrappers.
- Native-speed bulk enumeration — each call a direct pointer invocation after first `dlopen`.

**Risks & scope.** Windows-only — concede cross-platform to keyring-rs forks; Bun-only. **"Absorbs keytar's 2.26M/wk" is hyperbolic** — keytar's installs are overwhelmingly cross-platform Electron/Node; the realistic wedge is Bun-on-Windows CLIs/agents/devtools. `CredFree` should be rebound `u64`+bigint (DLL-returned address) per the repo's dll-allocated-pointer convention. `secret-vault.ts` currently throws at runtime on `toArrayBuffer(bigint as Pointer, …)` and uses two no-cast-rule-violating casts — repair it with the proven `ReadProcessMemory` cast-free pattern before citing it. `CREDENTIALW` (80 bytes x64) embeds pointers to caller buffers — assemble immediately before `CredWriteW` with no intervening awaits. `NCryptProtectSecret` is unproven — build a DPAPI-NG round-trip demo before claiming it.

**Effort & first milestone.** Small — zero new bindings; the work is the wrapper, the codec, blob-chunking, two examples, and repairing `secret-vault.ts`. **First milestone:** a typed `set/get/delete/list` vault with a verified write→read→enumerate round-trip and JWT-sized blob chunking via attributes.

---

## 9. bun-winreg — in-process typed Windows Registry

**`bun-winreg`: direct-FFI Registry CRUD plus change-watching with no `reg.exe` spawn, no `cscript` VBScript, no `node-gyp` — typed `REG_*` values and microsecond reads.**

**The gripe.** `winreg` (994,607/wk) spawns `reg.exe` and scrapes stdout, so it breaks on values with spaces, on non-English code pages (forcing the `winreg-utf8` fork's `chcp 65001` hack), and under the "Prevent access to registry editing tools" Group Policy (https://api.npmjs.org/downloads/point/last-week/winreg + https://github.com/desktop/registry-js/blob/master/README.md). The native addons need `node-gyp`, and `@vscode/windows-registry` runs `node-gyp rebuild` on every install, exposes one read-only function, truncates values over 512 chars, and its users literally filed "Use FFI to avoid erroneous native code" (https://github.com/microsoft/vscode-windows-registry/issues/4, #31). Only `winreglib` (141/wk) offers change-watching today — the capability is effectively missing (https://api.npmjs.org/downloads/point/last-week/winreglib).

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| winreg | 994,607 | spawns reg.exe | stale (2023) | spaces/code-page bugs; GPO |
| regedit | 119,218 | spawns cscript + VBScript | active (slow) | .wsf can't run from asar |
| @vscode/windows-registry | 79,231 | node-gyp rebuild every install | active | one read-only fn; 512-char trunc |
| native-reg | 8,413 | prebuilds + node-gyp | npm-stale (2022) | install-script lockdown risk |
| winreglib | 141 | node-gyp .node | niche | read-only; negligible adoption |

**How we build it.** Package: `@bun-win32/advapi32` (zero new bindings — the full surface is shipped). Key APIs: `RegOpenKeyExW`/`RegGetValueW`/`RegSetKeyValueW`/`RegEnumKeyExW`/`RegEnumValueW`/`RegDeleteTreeW`/`RegNotifyChangeKeyValue`/`RegConnectRegistryW`, plus `RegCreateKeyExW`/`RegSetValueExW`/`RegDeleteKeyExW`/`RegCloseKey`. The watcher uses `kernel32:CreateEventW` + `WaitForSingleObject`, and transactions use `@bun-win32/ktmw32`'s `CreateTransaction`/`CommitTransaction`. **MVP surface:** typed `REG_MULTI_SZ`/`REG_BINARY`/`REG_QWORD` encode/decode helpers and an event-poll watcher. `packages/advapi32/example/registry-explorer.ts` proves `RegOpenKeyExW`/`RegQueryValueExW`/`RegEnumKeyExW`.

**Why we win.**
- No process spawn — microsecond reads vs child-process + stdout-scrape on every operation.
- UTF-16 W-APIs in/out kill the entire code-page/`chcp` bug class; no stdout parsing kills the spaces/complex-value bug class.
- Full type fidelity for `REG_MULTI_SZ`/`REG_BINARY`/`REG_QWORD` instead of string scraping; `RegNotifyChangeKeyValue` watching that only a 141-dl/wk lib offers.
- Calls the real API → works under the registry-tools Group Policy; immune to the npm install-script lockdown that threatens `node-gyp` packages.

**Risks & scope.** Bun-only is the main adoption ceiling. The watcher **must** use `fAsynchronous=TRUE` with a `CreateEventW` handle polled via `WaitForSingleObject(handle, 0)` on the JS thread (synchronous mode would block Bun's only thread); pass `REG_NOTIFY_THREAD_AGNOSTIC` (`0x1000_0000`). Write/delete paths and watching need proving examples (reads are proven) — build an HKCU round-trip (no elevation) and an event-poll watch demo. Soften the remote-registry differentiator: `RegConnectRegistryW` needs the target's Remote Registry service, disabled by default — bonus, not headline. HKLM writes require elevation (OS constraint, not a binding gap).

**Effort & first milestone.** Small — wrapper + examples over shipped bindings. **First milestone:** a live registry-watcher demo (its one "wow" moment) plus a typed HKCU CRUD round-trip across all `REG_*` types.

---

## 10. bun-conpty — dependency-free ConPTY host + console input

**`bun-conpty`: spawn and drive real PTY children via `CreatePseudoConsole` and read full console input (key up/down, mouse, resize) via `ReadConsoleInputW` — no `node-gyp`, no `winpty.dll`, no `conpty.node` for antivirus to eat.**

**The gripe.** `node-pty` (21,096,551/wk) still carries a `node-gyp` fallback and a decade of VS-Build-Tools/Windows-SDK failures, Electron ABI rebuild churn, asar-breaking `winpty.dll`, and antivirus eating `conpty.node` — a documented VS Code terminal-launch failure (https://api.npmjs.org/downloads/point/last-week/node-pty + https://github.com/nodejs/node-gyp/issues/3091 + https://code.visualstudio.com/docs/supporting/troubleshoot-terminal-launch). The fork economy proves the market pays to delete its build step: a 29-star prebuilt fork `@lydell/node-pty` absorbs 2,064,076/wk and a Bun/Rust rewrite `bun-pty` 78,637/wk (https://api.npmjs.org/downloads/point/last-week/@lydell%2Fnode-pty). At the widget layer, `blessed` (1,354,358/wk, last publish 2015) never supported Windows mouse events and `ink` dropped keypresses until v6.8, because Node stdin can't surface key-up/repeat/modifier state (https://github.com/chjj/blessed/issues/423 + https://github.com/vadimdemedes/ink/releases/tag/v7.0.0).

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| node-pty | 21,096,551 | prebuild / node-gyp fallback | active | AV-quarantine; ABI churn; winpty asar |
| @lydell/node-pty | 2,064,076 | prebuilt binaries | active (beta) | exists only to delete the build step |
| blessed | 1,354,358 | pure JS | abandoned (2015) | Windows mouse never worked |
| @homebridge/node-pty-prebuilt-multiarch | 53,493 | prebuild-install chain | active | thrice-re-forked prebuild lineage |

**How we build it.** Packages: `@bun-win32/{kernel32, terminal}`. Key APIs: `kernel32:CreatePseudoConsole`/`ResizePseudoConsole`/`ClosePseudoConsole`/`CreateProcessW`/`InitializeProcThreadAttributeList`/`UpdateProcThreadAttribute`/`ReadConsoleInputW`/`GetNumberOfConsoleInputEvents`, plus `CreatePipe`/`PeekNamedPipe`/`ReadFile`/`WriteFile`. The input plane is **battle-tested**: `@bun-win32/terminal` already ships `ReadConsoleInputW` input (`packages/terminal/input.ts`) and 27 demos, plus a high-res waitable-timer pacer (`packages/terminal/pacing.ts`). The `_gpu.ts`/`mouse-trail.ts` precedents prove the pump.

**Why we win.**
- The "native binary" is `kernel32.dll`, already on every Windows machine — no per-platform package matrix to age out (works where `@lydell`'s prebuilds and OpenTUI's Zig packages miss).
- ConPTY directly, with no `winpty.dll` asar problem and nothing for AV to quarantine.
- `ReadConsoleInputW` exposes the input plane **no stdin-based library can reach**: key-down and key-up, repeat counts, scan codes, full modifier state, mouse move/wheel/drag, resize — already proven in `@bun-win32/terminal`.
- Pairs with the high-resolution waitable-timer frame pacer that beats `Bun.sleep`'s 15.6ms quantum.

**Risks & scope.** Windows-only, Bun-only (not an Electron-embeddable replacement). The **CreatePseudoConsole host loop is the one major claim with no runnable example yet** — build the gating spike first: `CreatePipe` ×2 → `CreatePseudoConsole` → `InitializeProcThreadAttributeList`/`UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE)` → `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT` → `PeekNamedPipe`-gated `ReadFile` drain. Three traps: `STARTUPINFOEXW` is a manual ~112-byte buffer (not a bound type); the attribute list, HPCON-value buffer, and STARTUPINFOEX must stay live with no awaits before `CreateProcessW` (FFI struct GC); never blocking-`ReadFile` from the JS thread — gate on `PeekNamedPipe`, and keep draining during teardown or `ClosePseudoConsole` hangs. Soften "tens of thousands of fps" to the isolated renderer benchmark (~43–60k bench; live demos 90–14k fps). "Replaces blessed" overreaches — this replaces their **input layer**, not the widget toolkit.

**Effort & first milestone.** Medium — one new high-level package plus the gating example. **First milestone:** spawn `cmd.exe /c`, relay VT output, and assert an echo round-trip + exit code — a runnable PTY host.

---

## 11. bun-wincerts — Windows CA-store reader + Authenticode verifier

**`bun-wincerts`: enumerate the live Windows certificate store (for corporate-proxy TLS) and verify Authenticode signatures via `WinVerifyTrust` — in-process, typed, with no `roots.exe`, no PowerShell, no `node-gyp`.**

**The gripe.** Node ignores the Windows certificate store by default, so every CLI behind a corporate TLS-inspecting proxy dies with `SELF_SIGNED_CERT_IN_CHAIN` — and every npm fix is compromised. `win-ca` (103,098/wk) is deprecated in its own README, ships an N-API addon plus a `roots.exe` fallback that crashes with ENOBUFS on GitHub Actions, and pins a vulnerable `node-forge` (https://github.com/ukoloff/win-ca/issues/42, #48). `@vscode/windows-ca-certs` `node-gyp`-rebuilds with no prebuilds — and `node-gyp`'s own header fetch fails behind the very MITM proxies the package exists to fix (https://github.com/devm33/windows-ca-certs + https://github.com/nodejs/node-gyp/issues/1029). On the signing side there is essentially no npm Authenticode verifier: `electron-updater` shells out to PowerShell with a documented signature-bypass-to-RCE (https://blog.doyensec.com/2020/02/24/electron-updater-update-signature-bypass.html), and the `WinVerifyTrust` wrappers meant to replace it are micro-projects (`win-verify-signature` 616/wk, `@xan105/win-verify-trust` 16/wk) (https://api.npmjs.org/downloads/point/last-week/win-verify-signature).

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| win-ca | 103,098 | N-API addon + roots.exe | deprecated | vulnerable node-forge; CI crash |
| @vscode/windows-ca-certs | 20,255 | node-gyp rebuild, no prebuilds | active | node-gyp fetch blocked by proxy |
| windows-ca-certs (repack) | 11,942 | vendored win32 .node | active-ish | 0-star repack of MS addon |
| ssl-root-cas | 66,517 | pure JS, frozen CA snapshot | abandoned (2019) | stale roots; deleted repo |
| win-verify-signature | 616 | prebuild / node-gyp | active-ish | micro-project |

**How we build it.** Packages: `@bun-win32/{crypt32, wintrust}`. Key APIs: `crypt32:CertOpenStore`/`CertOpenSystemStoreW`/`CertEnumCertificatesInStore`/`CertGetCertificateChain`/`CertVerifyCertificateChainPolicy`/`CryptBinaryToStringW`; `wintrust:WinVerifyTrust`/`CryptCATAdminEnumCatalogFromHash`; `crypt32:CryptRetrieveTimeStamp` (bound in crypt32, **not** wintrust). **MVP surface:** a typed store reader (ROOT/CA/MY across CurrentUser, LocalMachine, and GPO/enterprise stores, with DER→PEM via `CryptBinaryToStringW` for `NODE_EXTRA_CA_CERTS`) plus the Authenticode verifier. All three proofs ran live during review: `packages/wintrust/example/authenticode-audit.ts` audited 12 System32 files at 150 files/sec with catalog fallback; `packages/crypt32/example/certificate-inspector.ts` enumerated MY/ROOT/CA and decoded subject/issuer/serial (surfacing a live Fiddler MITM root — the exact scenario pitched); `schannel-https.ts` completed a real TLS 1.2 handshake to example.com.

**Why we win.**
- Zero install script — immune to the npm install-script lockdown, installs with no compiler/Python/admin/SDK on exactly the locked-down corporate machine where the pain lives (and where `node-gyp`'s own TLS fetch fails).
- In-process store enumeration across user/machine/GPO stores with filtering and DER/PEM emission — no `roots.exe` child process.
- The Authenticode verifier npm effectively lacks: `WinVerifyTrust` with full `WINTRUST_DATA` control returning structured results that locale/PowerShell-profile/stdout-parsing cannot break — the exact failure classes behind electron-updater's RCE bypass.
- No `.node` ABI rebuilds per Electron — the chronic win-ca-in-VS-Code failure.

**Risks & scope.** Windows-only, Bun-only — and **`Node 22.15+ --use-system-ca erodes the CA-reading half**, so lead with the Authenticode verifier plus GPO/machine-store enumeration. Authenticode **signing is out of scope** (`mssign32` `SignerSignEx2` is unbound); verification, hashing, and timestamp checks only. `CertEnroll` is unbound. The timestamp/chain-policy slice of the verifier is bound-but-undemonstrated — new wrapper code (use `WTHelperProvDataFromStateData` → `WTHelperGetProvSignerFromChain` off the existing state handle). `WinVerifyTrust` with `WTD_REVOKE_*` does synchronous network I/O that blocks the JS thread — document, or offer a no-revocation fast mode. Do not replicate `certificate-inspector.ts`'s `as unknown as Pointer` cast.

**Effort & first milestone.** Small — a typed packaging layer over already-running example code; the only genuinely new code is the chain-policy/timestamp slice and DER→PEM emission. **First milestone:** dump the corporate ROOT/CA store to a PEM bundle for `NODE_EXTRA_CA_CERTS`, plus a structured `verify(exePath)` returning trust/signer/timestamp.

---

## 12. bun-gamepad — unified controller SDK (XInput + DirectInput + GameInput + raw HID)

**`bun-gamepad`: one typed polling API over every controller stack Windows has — XInput rumble/battery, DirectInput wheels/HOTAS, GameInput's microsecond clock, and raw HID for DualSense extras — frame-paced with `@bun-win32/terminal`'s high-res timer, with zero native builds and no exclusive-mode device locking.**

**The gripe.** The npm gamepad story is dead or wrong-layer. `node-gamepad` has been archived since 2017 with hardcoded per-device HID byte-offset JSON (nearly every modern pad unsupported), at 93/wk (https://github.com/carldanley/node-gamepad). `gamecontroller.js` is browser-only despite topping searches. The only real XInput option, `xinput-ffi`, is a 51-downloads/week single-maintainer lib that bundles koffi's multi-platform binaries and spawns PowerShell just to identify devices (https://api.npmjs.org/downloads/point/last-week/xinput-ffi). Everything else hand-parses raw HID reports over `node-hid` (301,616/wk substrate), which can't open devices in non-exclusive mode on Windows and carries the perennial `NODE_MODULE_VERSION` rebuild treadmill (https://github.com/node-hid/node-hid/issues/547, #209).

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| node-hid (substrate) | 301,616 | prebuild / node-gyp | active | exclusive-mode lock; ABI rebuilds |
| node-gamepad | 93 | node-hid + hardcoded byte maps | archived (2017) | unsupported on modern pads |
| xinput-ffi | 51 | koffi binaries + PowerShell | niche | shells out to identify devices |
| gamecontroller.js | 39 | browser Gamepad API only | stale | cannot read controllers from Node |

**How we build it.** Packages: `@bun-win32/{xinput1_4, xinput9_1_0, dinput8, gameinput, hid, terminal}` (add `@bun-win32/{setupapi, kernel32}` for HID device-path enumeration and handle opening). Key APIs: `xinput1_4:XInputGetState`/`XInputSetState`; `dinput8:DirectInput8Create`; `gameinput:GameInputCreate`; `hid:HidD_GetInputReport`/`HidD_SetOutputReport`. **All four stacks are individually proven:** `packages/xinput1_4/example/gamepad-radar.ts` (4-slot poll + battery + rumble), `packages/dinput8/example/controller-scope.ts` (full cast-free `IDirectInput8` vtable pipeline), `packages/gameinput/example/gameinput-diagnostic.ts` (µs input clock), `packages/hid/example/dualsense-radar.ts` (non-exclusive `CreateFileW` with `FILE_SHARE_READ|WRITE` — the direct answer to node-hid#547 — including the Bluetooth 0xA2-seeded CRC32 output reports), and `packages/all/example/gameboy.ts` uses XInput as live game input.

**Why we win.**
- Every XInput controller works **by construction** (real API, not reverse-engineered byte offsets); no exclusive-mode lockout.
- Polling architecture is the proven-safe pattern and exactly what game loops want; pairs with the terminal package's waitable-timer pacing for real 60fps input loops.
- All four stacks proven in shipped demos including the hard DualSense Bluetooth CRC path — nothing comparable exists in any JS runtime.
- Rumble, battery, and capability queries in one typed surface no incumbent offers.

**Risks & scope.** **The market is tiny** (node-gamepad 93/wk, xinput-ffi 51/wk) — value this as the **input layer of a Bun-on-Windows game stack** (terminal + audio + gpu), not a standalone adoption driver. Hotplug callbacks (`GameInput RegisterDeviceCallback`, `CM_Register_Notification`) are foreign-thread — use periodic re-enumeration. GameInput is Windows 11 in-box but Windows 10 needs the redistributable — wrap first `Load` in try/catch. Scope the raw-HID tier to known devices (DualSense/Edge) for v1; generalizing needs overlapped-`ReadFile` fallback (unproven in-repo). DirectInput force feedback (`CreateEffect`) is unproven — exclude from v1. The guide button requires an undocumented ordinal AGENTS.md forbids — permanent non-goal. Windows-only, Bun-only.

**Effort & first milestone.** Medium — all four stacks proven; remaining work is normalization glue + re-enumeration + packaging. **First milestone:** a unified `poll()` returning normalized state for an XInput pad, a DirectInput wheel, and a DualSense over Bluetooth, frame-paced at 60Hz.

---

## 13. bun-cloudfiles — OneDrive-style placeholder filesystem (projfs-lite)

**`bun-cloudfiles`: register a Cloud Files sync root and project zero-byte placeholder files that show full logical size in Explorer at zero disk cost — a virtual filesystem with no C++/Rust native module.**

**The gripe.** Projecting placeholder files (the OneDrive virtual-FS pattern: files that appear full-size in Explorer but occupy no disk) requires a C++ or Rust native module today — **there is no npm package for it at all**. The adjacent fs-watch cluster shows what the native-FS alternative costs: `@parcel/watcher` (26,635,469/wk) breaks with "No prebuild or local build found" across Netlify/Amplify and even Bun's installer (https://github.com/parcel-bundler/watcher/issues/152 + https://github.com/oven-sh/bun/issues/19282), and registry searches confirm zero npm packages for cloud-filter placeholder filesystems. The pain is the absolute **absence** of the capability.

**What we replace.** No npm competitor exists — this is a literal capability monopoly. The alternative is a signed C++/Rust CF provider, and the adjacent native-FS modules (`@parcel/watcher`, 26.6M/wk) demonstrate the build tax developers accept.

**How we build it.** Package: `@bun-win32/cldapi` (shipped, v1.0.0, all 36 exports bound). Key APIs: `cldapi:CfRegisterSyncRoot`/`CfCreatePlaceholders`/`CfSetPinState`/`CfHydratePlaceholder`/`CfUpdatePlaceholder`/`CfGetPlaceholderStateFromAttributeTag`. **MVP surface:** placeholder projection + pin/state management + OneDrive scripting + diagnostics. **Both proofs were executed live during review:** `packages/cldapi/example/cloud-mirage.ts` projected **20.56 GB of logical files at 0 bytes on disk** into a real sync root and unregistered cleanly (HRESULT 0x0); `packages/cldapi/example/placeholder-diagnostic.ts` produced a full provider/policy/pin-state report (57 GB logical / 0 B on disk). `audit.ts` reports 0 mismatches.

**Why we win.**
- Zero build step for a capability that otherwise demands a signed C++/Rust native module.
- Placeholder projection + pin-state proven on a real Cloud Files sync root, showing multi-GB zero-byte files in Explorer with full logical size.
- Typed `CF_*` flag and placeholder-state decoding versus hand-rolled struct offsets in a C addon.

**Risks & scope.** Windows-only, Bun-only (Windows 10 1709+). **The honest audience is small** — the population of developers who need placeholder projection *without* fetch-on-open hydration from Bun is vanishingly thin; this is a portfolio jewel and brand stunt, not an adoption engine. Full on-demand hydration (`CfConnectSyncRoot` + `CF_CALLBACK_REGISTRATION`) invokes callbacks on the Cloud Files filter's own threads (foreign-thread hazard) — so the product is placeholder projection + explicit pull, **not** a live fetch-on-open sync provider. Reframe the `CfHydratePlaceholder` differentiator honestly: it asks the filter to pull from a *connected* provider via FETCH_DATA callbacks, so it has no data source for Bun's self-projected placeholders (and serving it single-threaded would deadlock); both shipped examples correctly avoid it via `CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION` + `MARK_IN_SYNC`. Registering a sync root may require specific app/identity context to persist across reboots.

**Effort & first milestone.** Medium — the binding package, both proofs, and clean teardown already exist at v1.0.0; remaining work is the `bun-cloudfiles` product wrapper. **First milestone:** a one-call API that registers a sync root and projects a directory of multi-GB placeholders, visible full-size in Explorer at 0 bytes on disk, with clean unregister.

---

## 14. bun-winsvc — service control, UAC elevation, durable scheduled tasks

**`bun-winsvc`: manage Windows services through the SCM, elevate child processes with a real `ShellExecuteExW` "runas" process handle, and register reboot-surviving scheduled tasks — no bundled winsw.exe/nssm.exe, no PowerShell elevation, no `node-gyp`.**

**The gripe.** The most decayed corner of the Windows npm ecosystem, yet it moves ~7M/wk. `sudo-prompt` (2,664,144/wk) is deprecated and archived and elevates by writing a temp `.bat` and spawning `powershell Start-Process -Verb runAs` — breaks on `&` in usernames, shows "PowerShell" in the UAC dialog, can't stream stdio (https://github.com/electron/forge/issues/3803 + https://github.com/jorangreef/sudo-prompt/issues/97). `node-windows` is 4 years stuck in "1.0.0-beta" shipping a decade-old WinSW exe and a literal "SUPER AWFUL HACK" busy-wait (https://github.com/coreybutler/node-windows/issues/338, #266). `os-service` (true SCM) is a NAN addon that won't build on Node 20 (https://github.com/nospaceships/node-os-service/issues/55). `node-schedule`'s 4,475,783/wk buys in-process timers that vanish on reboot, plus leap-year and double-fire bugs (https://github.com/node-schedule/node-schedule/issues/225, #263).

**What we replace.**

| Package | Weekly dl | Install | Status | Core weakness |
|---------|-----------|---------|--------|---------------|
| node-schedule | 4,475,783 | pure JS in-process timers | stale | jobs vanish on crash/reboot |
| sudo-prompt | 2,664,144 | temp .bat + PowerShell runAs | deprecated + archived | username escaping; no stdio |
| @vscode/sudo-prompt | 1,664,297 | temp .bat + PowerShell runAs | active (minimal) | inherits original design limits |
| node-windows | 40,114 | bundled winsw.exe + busy-wait | stale (beta) | install silently fails on Win11 |
| winser | 3,327 | bundled nssm.exe | abandoned (2018) | known-broken bundled nssm |
| os-service | 59 | node-gyp (NAN) | abandoned | won't build on Node 20 |

**How we build it.** Packages: `@bun-win32/{advapi32, shell32, taskschd}` (add `@bun-win32/{kernel32, ole32}` for the elevation wait/exit-code and the taskschd COM path). Key APIs: `advapi32:OpenSCManagerW`/`CreateServiceW`/`StartServiceW`/`ControlServiceExW`/`QueryServiceStatusEx`/`ChangeServiceConfig2W` (+ open/enum/query/delete/close); `shell32:ShellExecuteExW`; `taskschd:DllGetClassObject`. **MVP surface:** service management + elevation + scheduling (not in-process hosting). `packages/taskschd/example/schedule-constellation.ts` performs a live `ITaskService` vtable walk (`DllGetClassObject` → `IClassFactory` → `Connect` → folder/task enumeration); `shell32` binds the full runas flow including `SEE_MASK_NOCLOSEPROCESS`.

**Why we win.**
- Elevation via `ShellExecuteExW` "runas" — no PowerShell spawn, no temp `.bat`, immune to username-escaping bugs, your own exe named in the UAC dialog, and a real `hProcess` back for `WaitForSingleObject` + `GetExitCodeProcess`.
- Full SCM management (delayed-auto-start, recovery actions, descriptions via `ChangeServiceConfig2W`) that no wrapper exposes, with no exe in the tarball.
- Task Scheduler delivers persistent, reboot-surviving, highest-privilege tasks — the durable counterpart to node-schedule's in-process timers.
- Strict TS for `SERVICE_STATUS`/`SHELLEXECUTEINFOW` vs stringly-typed argv fed to `schtasks`/PowerShell.

**Risks & scope.** **Hosting a long-running service IN Bun is risky-to-infeasible** — `StartServiceCtrlDispatcherW`'s ServiceMain/Handler arrive on SCM-owned foreign threads; scope strictly to service **management** + elevation + scheduling. The Task Scheduler write path is the genuine spike: `RegisterTaskDefinition`/`RegisterTask` take three 24-byte by-value VARIANTs (userId, password, sddl) — on x64 these pass as hidden pointers, **the same FFI pattern that killed UIA's `CreatePropertyCondition`** — so prototype task registration in a user folder with `TASK_LOGON_INTERACTIVE_TOKEN` before claiming the feature. Soften the stdio rhetoric: runas cannot redirect the elevated child's stdio (no handle inheritance across the elevation boundary) — the honest claim is the real `hProcess` for wait/exit-code, plus an optional named-pipe pattern. SCM/task mutations need admin — ship a read-only diagnostic as the professional demo and gate mutations behind an `IsUserAnAdmin` check. Call `CoInitializeEx` before `ShellExecuteExW`.

**Effort & first milestone.** Medium — service-management MVP is pure shipped surface; the COM write-side prototyping plus admin-gated example design is the real cost. **First milestone:** elevate a child with a real `hProcess` (wait + exit code), enumerate and configure a service via the SCM, and — after the VARIANT spike — register a reboot-surviving scheduled task.

---

## Sequencing & strategy

**Build first: bun-sysmon (#1), bun-uia (#2), bun-netdiag (#3).** All three top the ranking on the same combination — a current, Windows-specific daily wound; a feasibility that is effectively maxed (bindings and demos shipped, several APIs executed live during review); and a demo that lands. `bun-sysmon` rides the active `wmic`-removal breakage across a ~20M/wk cluster and adds a decoded ETW firehose npm has no answer for. `bun-uia` absorbs the orphaned nut.js demand with an accessibility-tree query API arriving exactly as computer-use agents need semantic desktop control. `bun-netdiag` is the most de-risked of all — ICMP, adapters, and DNS were all executed live on real hardware — and structurally kills the entire netsh-scraper bug class.

**Why these compound.** They share infrastructure that pays forward. `iphlpapi`'s `GetExtendedTcpTable` socket→PID attribution is core to both `bun-sysmon` and `bun-netdiag`. The cast-free COM vtable invoker that `bun-uia` hardens is the enabling primitive for every other COM-driven product in the portfolio — `bun-gpu`, `bun-media`, `bun-shell`, `bun-winsvc` all ride it. The terminal engine's high-res waitable-timer pacer underwrites `bun-media`'s frame stream, `bun-gamepad`'s 60fps loops, and `bun-conpty`. And `bun-sysmon`'s typed process/struct parsers seed the same patterns `bun-winsvc` and `bun-conpty` need. Two near-free "serious daily driver" wins — `bun-keyring` and `bun-winreg`, both **small** effort with zero new bindings and live-verified round-trips — make excellent fast follows that build trust without competing for the flagship slot.

**Each ships as its own package, exactly as `@bun-win32/terminal` did** — a higher-level product built on the bindings (or, for `bun-gpu`, an engine extracted from `packages/all/example/_gpu.ts`), with its own `example/`, `AI.md`, and the same audit/nullcheck/preflight gates. That is the proven path: the bindings are the foundation; these 14 are the buildings.
