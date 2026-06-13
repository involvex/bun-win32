# BUN_NETDIAG — execution prompt

Paste the block below as a **`/goal`** in a fresh session set to **Opus 4.8, ultracode**. It drives the full build of `@bun-win32/netdiag` + `bun-netdiag` by following [`packages/netdiag/PLAN.html`](./PLAN.html) end to end. The plan is the spec; this prompt sets the mode, doctrine, risk-ordering, and finish line.

---

```
PRECONDITION: run THIS session as Opus 4.8 + ultracode. Verify /model + /effort first — hard precondition. Wrong → stop, tell user to switch.

Execute packages/netdiag/PLAN.html end to end: build, test, doc, publish @bun-win32/netdiag@1.0.0 + unscoped bun-netdiag@1.0.0 to npm. Plan IS the spec — read fully before coding, then follow phase by phase (0→15, incl 0b+10b). Track each phase w/ TaskCreate/TaskUpdate; commit after each (multi-agent repo git-clean's uncommitted). Never leave repo broken.

PRIME DIRECTIVES (override convenience):
- VERIFY, DON'T TRUST. Plan + its research + author = map, not territory. Re-verify every load-bearing fact at its source: struct offsets/strides from SDK header (x64-ABI-sensitive — TCP rows 24B OWNER_PID / 20B legacy / larger OWNER_MODULE), exports from dumpbin, nullability from SAL, every number vs OS ground truth (route print, netstat -ano, ping.exe, arp -a, nslookup). Plan wrong → source wins; fix + log to deviation ledger (S0.9).
- RESEARCH RELENTLESSLY, BEST AGENTS. Where plan says research (esp. Phase 0b intel) or a fact is load-bearing, fan out sub-agents (prefer Workflow). On EVERY spawn set model:'opus' explicitly (don't rely on inheritance); instruct each to run max ultracode rigor — exhaustive, adversarial, primary-source, trust no one. Non-Opus/non-ultracode sub-agent = bug, fix the spawn.
- OBEY AGENTS.md: no casts (only Number(ptr) as Pointer), alphabetize, no abbreviations, #private, hex w/ separators, Bun-native, conventional commits, tests never in test/. Run audit.ts + nullcheck.ts on any binding touched.
- PERF IS A GATE. Pitch = "every sample is a syscall, not a spawn" — sub-ms live dashboard. FORBIDDEN in any poll loop: per-poll Buffer.alloc, cached .ptr across alloc, bigint in decode, per-row toArrayBuffer. Reuse one growable buffer; one DataView over the table region; read .ptr inline. Every hot-path phase ends w/ a microbench (Bun.nanoseconds, 200k warmup, bun:jsc numberOfDFGCompiles>0 — Bun=JSC not V8). S14.6 gate (>10% vs S0.6b baseline OR a forbidden pattern) blocks release.
- GROUND TRUTH, UNELEVATED. No-admin ICMP is the flagship — run selftest in a NON-admin shell; every non-admin-gated assertion must pass. Cross-validate live; never trust selftest text.

HIGHEST-RISK (nail first, prove by running):
1. .ptr relocation + FFI struct GC window — read .ptr inline; no await between assembling a pointer-bearing struct and the sync call (Ph 2–6).
2. IcmpSendEcho: IP_OPTION_INFORMATION must be the 32-bit layout on x64 or echo fails — validate vs loopback (Ph 6).
3. TCP-row stride (above); pModuleName = offset-pointer into the out-buffer — compute each stride from SDK (Ph 5).
4. Table2 APIs self-allocate — FreeMibTable in finally or leak every poll (Ph 4).
5. Change-events/WiFi: overlapped-EVENT forms (NotifyAddrChange), NEVER foreign-thread callbacks (crash class); WlanConnect ships as a beta flag (Ph 8); ESTATS RTT needs admin-enable — read Rw.EnableCollection first, gate behind elevation (Ph 10b).

OPERATIONAL:
- Keep machine awake whole run (S0.2b SetThreadExecutionState bg proc); kill it as Phase 15's last act. Run may be unattended.
- Release = one OTP: dry-run all first, then request ONE npm OTP, publish in dep order: bumped binding pkg(s) → @bun-win32/netdiag → @bun-win32/all → bun-win32 → bun-netdiag. 402 after OTP burns the code.

FINISHED when: @bun-win32/netdiag@1.0.0 + bun-netdiag@1.0.0 live + installable; S15.7 clean-room passes (fresh temp dir outside repo: bun add bun-netdiag → defaultGateway() + no-admin ping('1.1.1.1') + tcpConnections() return real data, exit 0); @bun-win32/all (minor) + bun-win32 (patch) + any bumped binding pkg published; all gates green (tsc 0, audit/nullcheck unchanged, parity Appendix D every row proven-or-non-goal, perf gate, no-admin proof); final report w/ parity row→proof map, gripe→response list, benchmark table, deviation ledger. All spawns = Opus 4.8 ultracode.
```

---

## What it needs from you
- **One npm OTP** at Phase 15 (the only required human step; have the publish loop ready before sending it).
- **A non-elevated shell** for the S14.5 no-admin proof, plus an **admin shell** available for the Phase 10b #8 elevation check.
- **An unlocked, awake machine** for the full run (live-dashboard testing takes wall-clock time).

## Notes
- The canonical plan is `packages/netdiag/PLAN.html`. There is no root duplicate and no `/goal` stop-token typo for this target — paste the path as written.
- To gate the npm publish yourself, change the finish line to *"…stop after the Phase 15 pre-publish dry-run is green; do not request an OTP."*
