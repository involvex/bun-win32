# @bun-win32/sysmon — AI surface contract

Everything below is reachable from `@bun-win32/sysmon` alone (the unscoped `bun-sysmon` package re-exports it 1:1). Bun + Windows only. This file is the complete surface — an agent should not need to read source to use the package; when it must, the last section says exactly which file.

## What it is

Native-speed Windows observability over direct `bun:ffi` calls into DLLs that ship in System32 — no PowerShell, no wmic, no WMI, no node-gyp, no vendored executables. Three kinds of API:

- **Snapshot functions** — synchronous, microsecond-class, return owned data (`memory()`, `processes()`, `tcpSockets()`, `smbios()`, …). Call them as often as you like; nothing is cached.
- **Samplers** — classes/helpers that hold the previous sample and compute deltas: `CpuSampler`, `ProcessSampler`, `NetSampler`, paced by `createTicker` (low-CPU, ~±0.5 ms) or `createSpinTicker` (true 1000 Hz, pegs a core), or driven by `watch()`.
- **Streams** — `tailEvents()` (Event Log, pull+poll AsyncIterable, no admin) and `EtwSession.run()` (real-time decoded ETW; requires elevation and BLOCKS the thread while pumping).

Everything except the ETW firehose and the Security event channel works without admin.

## Capability → API

| I want to… | Call |
| --- | --- |
| OS version / build (unshimmed) | `osInfo()` |
| Uptime / boot time | `uptimeMs()`, `bootTime()` |
| Computer / user / elevation | `computerName()`, `userName()`, `isElevated()` |
| RAM + commit (Task-Manager-named fields) | `memory()`, `performanceInfo()` |
| The whole process list in ONE syscall | `processes()` |
| One process's stats in the pidusage shape | `pidStats(pid)` / `pidStats(pids[])` |
| The process tree (ps-tree on wmic-less Windows) | `processTree(rootPid?)` |
| A process's exe path / IO / handle+GDI+USER counts | `processImagePath(pid)`, `processIoCounters(pid)`, `processObjectCounts(pid)` |
| Top-CPU processes at high rate | `new ProcessSampler().sample(limit)` |
| Per-core CPU% the way Task Manager computes it | `new CpuSampler().sample()` (raw: `cpuTimes()`, `systemTimes()`) |
| Live per-core CPU frequency | `cpuFrequency()` |
| Drives / free space (UNC-capable, quota-aware) | `drives()`, `diskSpace(path)` |
| Per-disk / per-process disk I/O | `diskIoCounters(ms)`, `processIoCounters(pid)` |
| Socket→PID tables, v4+v6, no netstat | `tcpSockets({family?, resolveProcessNames?})`, `udpSockets(…)` |
| Per-interface octets/errors/link speed | `interfaceCounters()`, `new NetSampler().sample()` |
| Any perfmon counter, locale-proof | `new CounterSet()`, `sampleCounters(paths, ms)` |
| Enumerate counter objects/instances, expand wildcards | `listCounterObjects()`, `listCounterItems(object)`, `expandCounterPath(wildcard)` |
| Per-process GPU% (Task Manager's GPU column) | `gpuUsageByProcess(ms)` |
| List / query / live-tail any Event Log channel | `channels()`, `queryEvents({channel,…})`, `tailEvents({channel,…})` |
| Format an event's publisher message | `formatMessage(providerName, eventHandle)` (queryEvents does it for you) |
| Census every ETW provider + its event schemas (no admin) | `etwProviders()`, `etwProviderSchema(guid)` |
| Stream decoded kernel events live (admin) | `new EtwSession().run(onEvent, {durationMs})` |
| Hardware identity without WMI (BIOS/board/RAM slots) | `smbios()` |
| AC/battery/power plan | `powerStatus()`, `batteryState()`, `powerScheme()` |
| Who is logged on (console/RDP, real names) | `sessions()` |
| Which processes hold a file open | `whoLocks(paths)` |
| Pace a loop at 1 ms without the 15.6 ms quantum | `createTicker(ms)`, `createSpinTicker(ms)`, `watch(fn, ms, onSample, {signal})` |
| Timestamp samples (QPC) | `monotonicMicroseconds()` |

## Full API

### system.ts
- `osInfo(): OsInfo` — `{build, major, minor, platformId, servicePack}` from RtlGetVersion (ignores compatibility shims).
- `uptimeMs(): number` — ms since boot incl. sleep (GetTickCount64).
- `bootTime(): Date` — kernel boot timestamp (NtQuerySystemInformation class 3).
- `computerName(): string` / `userName(): string`.
- `isElevated(): boolean` — BUILTIN\Administrators membership via CheckTokenMembership.
- `cpuLayout(): CpuLayout` — `{activeProcessorMask, allocationGranularity, logicalProcessorCount, pageSizeBytes, processorArchitecture, processorLevel, processorRevision}`; `logicalProcessorCount` covers ALL processor groups.

### memory.ts
- `memory(): MemoryStatus` — `{availablePageFileBytes, availablePhysicalBytes, availableVirtualBytes, memoryLoadPercent, totalPageFileBytes, totalPhysicalBytes, totalVirtualBytes}` (bigint byte fields). Task Manager mapping: `availablePhysicalBytes` = "Available" (free + standby), page-file fields = the commit limit/headroom.
- `performanceInfo(): PerformanceInfo` — `{commitLimitBytes, commitPeakBytes, commitTotalBytes, handleCount, kernelNonpagedBytes, kernelPagedBytes, pageSizeBytes, physicalAvailableBytes, physicalTotalBytes, processCount, systemCacheBytes, threadCount}` — includes the standby/commit numbers systeminformation hard-zeros on Windows.

### process.ts
- `processes(): ProcessInfo[]` — one NtQuerySystemInformation(class 5) call; per row `{basePriority, createTime: Date, handleCount, ioOtherBytes, ioOtherOperations, ioReadBytes, ioReadOperations, ioWriteBytes, ioWriteOperations, kernelTime: bigint, name, pageFaultCount, peakWorkingSetBytes, pid, ppid, privateBytes, sessionId, threadCount, userTime: bigint, virtualBytes, workingSetBytes}`. Times are 100 ns units; pid 0 = `Idle`, pid 4 = `System`.
- `pidStats(pid): PidStats` / `pidStats(pids: number[]): Record<number, PidStats>` — the pidusage shape `{cpu, ctime, elapsed, memory, pid, ppid, timestamp}`. `cpu` is the two-sample delta normalized by core count (Task Manager's definition: one pegged core on a 24-core box ≈ 4.2, not 100); the first call returns the since-start average. Throws for a dead pid (single form); the array form just omits it.
- `processTree(rootPid?): ProcessTreeNode` — `{children, process}`; no argument → a virtual root (pid −1) whose descendants are EVERY process (node count = snapshot length).
- `processImagePath(pid): string | null` — full exe path; null on access denied.
- `processIoCounters(pid): ProcessIoCounters | null` — `{otherBytes, otherOperations, readBytes, readOperations, writeBytes, writeOperations}` cumulative.
- `processObjectCounts(pid): ProcessObjectCounts | null` — `{gdiObjects, handleCount, userObjects}`.
- `class ProcessSampler` — `sample(limit = 25): ProcessSample[]` ranked by CPU% since the previous call; rows `{cpuPercent, name, pid, workingSetBytes}`. First call primes and returns [].

### cpu.ts
- `cpuTimes(): CpuTime[]` — cumulative per-core `{idle, kernel, user}` bigints (kernel INCLUDES idle — NT convention).
- `systemTimes(): SystemTimes` — whole-box `{idle, kernel, user}` (GetSystemTimes; kernel includes idle).
- `class CpuSampler` — `sample(): CpuSample` = `{perCore: number[], total, userFraction: number[]}` busy fractions 0..1 since the previous call. The SAME object/arrays are returned every call (zero-alloc) — copy if you keep history. First call returns zeros.
- `cpuFrequency(): CpuFrequency[]` — per-core `{currentMhz, limitMhz, maxMhz, number}` (power management's live throttle-aware clock, not the instantaneous turbo boost).

### disk.ts
- `drives(): DriveInfo[]` — `{availableBytes, driveType, driveTypeName, filesystem, freeBytes, label, path, serialNumber, totalBytes}`; unready drives report zeros instead of throwing.
- `diskSpace(path): DiskSpace` — `{availableBytes, freeBytes, totalBytes}` for any path INCLUDING UNC shares; `availableBytes` is quota-aware (can be < freeBytes).
- `diskIoCounters(sampleMs = 200): DiskIoRate[]` — per-PhysicalDisk `{instance, readBytesPerSecond, writeBytesPerSecond}` via PDH (synchronous: sleeps `sampleMs` between the two collects).

### net.ts
- `tcpSockets(options?: SocketOptions): NamedTcpSocket[]` — `{family, localAddress, localPort, pid, processName, remoteAddress, remotePort, state, stateName}`; `options.family` 4 (default) or 6; `options.resolveProcessNames` joins pid→exe basename (cached per call; `processName` is null otherwise or on access denied).
- `udpSockets(options?: SocketOptions): NamedUdpSocket[]` — `{family, localAddress, localPort, pid, processName}`.
- `interfaceCounters(): InterfaceCounter[]` — MIB_IF_ROW2 per interface: `{alias, description, inDiscards, inErrors, inOctets, inUcastPackets, interfaceIndex, interfaceLuid: bigint, mediaConnectState, mtu, operStatus, outDiscards, outErrors, outOctets, outUcastPackets, physicalAddress, receiveLinkSpeed, transmitLinkSpeed, type}`. Filter `operStatus === 1` for up interfaces.
- `class NetSampler` — `sample(): InterfaceRate[]` = `{alias, inBytesPerSecond, interfaceLuid, outBytesPerSecond}` for up interfaces since the previous call.

### counters.ts (PDH)
- `class CounterSet` — `add(path): CounterHandle` (ENGLISH path, locale-proof), `collect(): void`, `value(handle): number`, `dispose(): void`. Rate counters need TWO collects an interval apart; `value()` throws an explanatory error (not a raw hex) on the one-collect and too-close-collects mistakes.
- `sampleCounters(paths: string[], sampleMs = 200): Record<string, number>` — one-shot: open/collect-twice/read/dispose, the two-sample rule handled for you.
- `listCounterObjects(): string[]` / `listCounterItems(objectName): CounterItems` (`{counters, instances}`).
- `expandCounterPath(wildcardPath): string[]` — e.g. `\GPU Engine(*)\Utilization Percentage` → live `pid_NNNN_…` instances (paths come back with a `\\MACHINE` prefix; `CounterSet.add` wants the local form — strip `^\\\\[^\\]+`).
- `gpuUsageByProcess(sampleMs = 200): GpuProcessUsage[]` — `{engines, maxEnginePercent, pid, totalPercent}` sorted by `maxEnginePercent` (Task Manager's per-process GPU definition). [] with no GPU engine instances.

### eventlog.ts
- `channels(): string[]` — every event channel (~1000+).
- `queryEvents(options: QueryOptions): EventRecord[]` — `{channel, max?, rawOnly?, reverse?, xpath?}` → `{channel, computer, eventId, level, message, providerName, recordId, timeCreated, xml}`; newest-first by default; `message` is the publisher-formatted text (null when the provider has no metadata; skip formatting with `rawOnly`).
- `tailEvents(options: TailOptions): AsyncGenerator<EventRecord>` — `{channel, intervalMs?, signal?, systemFilter?}`; pull+poll on an EventRecordID watermark; `systemFilter` is a System[] predicate (e.g. `'Level <= 3'`) ANDed into the gate. Abort the signal to end.
- `formatMessage(providerName, eventHandle: bigint): string | null` — for advanced flows holding raw EVT_HANDLEs; publisher-metadata handles are cached per provider for the process lifetime.

### etw.ts
- `etwProviders(): EtwProvider[]` — `{guid, name, schemaSource}` (0 = manifest, decodable), sorted by name. No admin.
- `etwProviderSchema(guid): EtwEventSchema[]` — per template `{eventId, level, message, opcode, opcodeName, properties: EtwEventProperty[] ({inType, name, outType}), taskName, version}`. No admin; [] for MOF-only providers.
- `class EtwSession` — `new EtwSession(options?: EtwSessionOptions)` (`{providerGuid?, providerName?, sessionName?}`, default provider `Microsoft-Windows-Kernel-Process`). THROWS unelevated with an actionable message. `run(onEvent, options: EtwRunOptions): EtwRunResult` — `{durationMs}` only; BLOCKS the JS thread until the deadline (no timers/promises run); the event object passed to `onEvent` (`EtwEvent` = `{eventId, opcode, opcodeName, processId, providerName, taskName, threadId}`) is REUSED across callbacks — copy fields you keep. Returns `{eventCount, processTraceStatus}`. The session is always stopped in a finally.

### firmware.ts
- `smbios(): SmbiosInfo` — `{baseboard: SmbiosBaseboard, bios: SmbiosBios, memoryDevices: SmbiosMemoryDevice[], processors: SmbiosProcessor[], system: SmbiosSystem, version}`; per-slot RAM (`sizeBytes` 0 = empty slot), mixed-endian UUID handled, no WMI anywhere.

### power.ts
- `powerStatus(): PowerStatus` — `{acLine, batteryFlag, batteryPercent, secondsRemaining}` (`batteryPercent` null when unknown/no battery).
- `batteryState(): BatteryState` — `{acOnline, batteryPresent, charging, discharging, estimatedTimeSeconds, maxCapacity, rate, remainingCapacity}`; desktops report `batteryPresent: false`, no throw.
- `powerScheme(): PowerScheme` — `{guid, name}` (e.g. `Balanced`).

### sessions.ts
- `sessions(): SessionInfo[]` — `{clientName, domain, protocol, sessionId, state, stateName, stationName, userName}` (protocol 0 console / 2 RDP; state 0 = active).

### locks.ts
- `whoLocks(paths: string[]): FileLockHolder[]` — `{applicationName, applicationType, pid, serviceShortName}` via the Restart Manager.

### sampler.ts
- `createTicker(intervalMs): Ticker` — `{wait(), dispose()}` on a periodic high-resolution waitable timer; near-zero CPU, ~±0.5 ms wake latency (≈700 Hz real at a 1 ms target). Falls back to `Bun.sleepSync` pre-Windows-10-1803.
- `createSpinTicker(intervalMs): Ticker` — busy-spins on QPC to ABSOLUTE deadlines; sub-10 µs jitter, true 1000 Hz, pegs a core.
- `watch(fn, intervalMs, onSample, options?: WatchOptions): Promise<number>` — ticker-paced polling that yields a macrotask each tick (timers keep running); resolves with the sample count when `options.signal` aborts.
- `monotonicMicroseconds(): number` — QueryPerformanceCounter in µs.

### structs.ts (pure decoders — no FFI; unit-tested with byte fixtures)
`parseProcessSnapshot(buffer, bufferBase)`, `parseProcessorTimes(buffer, coreCount)`, `parseMemoryStatusEx(buffer)`, `parsePerformanceInfo(buffer)`, `parseTcpTable(buffer)` / `parseTcp6Table(buffer)` / `parseUdpTable(buffer)` / `parseUdp6Table(buffer)`, `parseInterfaceTable(buffer)`, `parseProviderEnumeration(buffer)`, `parseSmbios(buffer)`, `parseMultiSz(buffer, maxChars)`, `decodeUnicodeString(buffer, offset, byteLength)`, `decodeNulTerminatedUnicodeString(buffer, offset, maxChars)`, `filetimeToDate(low, high)`, `filetimeDeltaMs(a, b)`, `formatGuid(buffer, offset)` / `guidToBytes(value)`, `formatIpv4Address(value)` / `formatIpv6Address(buffer, offset)` / `formatNetworkPort(value)`, `TCP_STATE_NAMES`. Exported so you can decode kernel-filled buffers you fetched yourself.

Exported types not named above: `CounterHandle`, `CounterItems`, `CpuFrequency`, `CpuLayout`, `CpuSample`, `CpuTime`, `DiskIoRate`, `DiskSpace`, `DriveInfo`, `EtwEvent`, `EtwEventProperty`, `EtwEventSchema`, `EtwProvider`, `EtwRunOptions`, `EtwRunResult`, `EtwSessionOptions`, `EventRecord`, `FileLockHolder`, `GpuProcessUsage`, `InterfaceCounter`, `InterfaceRate`, `MemoryStatus`, `NamedTcpSocket`, `NamedUdpSocket`, `OsInfo`, `PerformanceCounts`, `PerformanceInfo`, `PidStats`, `PowerScheme`, `PowerStatus`, `BatteryState`, `ProcessInfo`, `ProcessIoCounters`, `ProcessObjectCounts`, `ProcessSample`, `ProcessTreeNode`, `QueryOptions`, `SessionInfo`, `SmbiosBaseboard`, `SmbiosBios`, `SmbiosInfo`, `SmbiosMemoryDevice`, `SmbiosProcessor`, `SmbiosSystem`, `SocketOptions`, `SystemTimes`, `TailOptions`, `TcpSocket`, `Ticker`, `UdpSocket`, `WatchOptions`.

## Recipes

Top-5 CPU processes, refreshed live:
```ts
import { ProcessSampler, createTicker } from '@bun-win32/sysmon';
const sampler = new ProcessSampler();
const ticker = createTicker(1000);
for (let i = 0; i < 5; i += 1) {
  ticker.wait();
  console.log(sampler.sample(5).map((row) => `${row.name} ${row.cpuPercent.toFixed(1)}%`).join(' · '));
}
ticker.dispose();
```

Kilohertz-class dashboard polling at near-zero CPU (the systeminformation `observe()` answer):
```ts
import { CpuSampler, watch } from '@bun-win32/sysmon';
const sampler = new CpuSampler();
const controller = new AbortController();
setTimeout(() => controller.abort(), 2_000);
let last = 0;
const count = await watch(() => sampler.sample().total, 1, (total) => { last = total; }, { signal: controller.signal });
console.log(`${count} samples in 2 s — last total ${(last * 100).toFixed(1)}%`);
```

Socket→process attribution:
```ts
import { tcpSockets } from '@bun-win32/sysmon';
for (const socket of tcpSockets({ resolveProcessNames: true }).filter((row) => row.state === 2)) {
  console.log(`${socket.localAddress}:${socket.localPort} ← ${socket.processName ?? `pid ${socket.pid}`}`);
}
```

Tail errors and warnings from the System channel (Security works the same, elevated):
```ts
import { tailEvents } from '@bun-win32/sysmon';
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);
for await (const record of tailEvents({ channel: 'System', systemFilter: 'Level <= 3', signal: controller.signal })) {
  console.log(`[${record.providerName}#${record.eventId}] ${record.message ?? record.xml.slice(0, 120)}`);
}
```

The ETW firehose with the no-admin fallback:
```ts
import { EtwSession, etwProviders, isElevated } from '@bun-win32/sysmon';
if (isElevated()) {
  const result = new EtwSession().run((event) => console.log(event.taskName, event.processId), { durationMs: 3_000 });
  console.log(`${result.eventCount} events`);
} else {
  console.log(`${etwProviders().length} providers enumerable without admin; the live stream needs an elevated shell`);
}
```

Is this process leaking handles?
```ts
import { processObjectCounts } from '@bun-win32/sysmon';
const before = processObjectCounts(process.pid)!;
// … run the suspect workload …
const after = processObjectCounts(process.pid)!;
console.log(`handles ${before.handleCount} → ${after.handleCount}, GDI ${before.gdiObjects} → ${after.gdiObjects}`);
```

Any perfmon counter, once:
```ts
import { sampleCounters } from '@bun-win32/sysmon';
console.log(sampleCounters(['\\Processor(_Total)\\% Processor Time', '\\Memory\\Available MBytes'], 250));
```

## Gotchas

- **PDH two-sample rule** — rate counters (`% …`, `…/sec`) return an error on the first `collect()`; collect, wait ≥ ~100 ms, collect again. `CounterSet.value` explains this instead of returning a hex status; `sampleCounters` handles it for you.
- **`EtwSession.run` BLOCKS the JS thread** — no timers, promises, or servers run until the deadline. That is why its only stop condition is `durationMs` (an AbortSignal could never fire). Real-time ETW also requires an elevated process; the census, schemas, and Event Log tail do not.
- **EvtSubscribe is deliberately not used** — its push callback fires on a foreign thread (a crash class under FFI). `tailEvents` is pull+poll on an EventRecordID watermark; latency is the poll interval, by design.
- **`Bun.sleep` quantizes to ~15.6 ms** on Windows (caps naive pollers at ~30–60 Hz). Pace with `createTicker` (~700 Hz real, near-zero CPU) or `createSpinTicker` (true 1000 Hz, pegs a core).
- **Samplers reuse their result objects/arrays** (`CpuSampler.sample`, the `EtwEvent` in `run`) — copy what you keep across iterations.
- **First sampler call primes** — `CpuSampler`/`ProcessSampler`/`NetSampler` return zeros/[] on the first call; deltas need two samples.
- **CPU% definitions** — `pidStats().cpu` and `ProcessSampler` percentages are normalized by logical core count (Task Manager's convention): one pegged core on a 24-core box reads ~4.2%, and the whole box sums to ~100%.
- **`memory()` vs Task Manager** — `availablePhysicalBytes` is "Available" (free + standby), not "Free"; commit numbers live in the page-file fields and `performanceInfo()`. Per-process: `workingSetBytes` is the Memory column's basis, `privateBytes` is "Commit size".
- **Buffer assembly is synchronous by contract** — every fetch assembles its buffer and calls immediately; never put an `await` between building an FFI argument buffer and the call (pointers can dangle).
- **Reading DLL-allocated memory**: copy before freeing — `Buffer.from(toArrayBuffer(pointer, 0, n).slice(0))`; a bare `Buffer.from(ArrayBuffer)` is a zero-copy VIEW that dangles (returns freed-heap garbage, not a crash) after `WTSFreeMemory`/`FreeMibTable`/`LocalFree`.
- **`cpuFrequency().currentMhz`** is power management's throttle-aware clock, not the instantaneous turbo boost (it reads max on an unclamped desktop).
- **Anything not wrapped here** is one `@bun-win32/{dll}` import away — the same `Preload`/destructure/FFI pattern this package uses; all 117 binding packages are on npm.

## Where to look (source)

`process.ts` — snapshot/tree/pidStats/imagePath/IO/object counts/ProcessSampler · `cpu.ts` — cpuTimes/CpuSampler/systemTimes/cpuFrequency · `memory.ts` — memory/performanceInfo · `system.ts` — osInfo/uptime/boot/names/elevation/cpuLayout · `disk.ts` — drives/diskSpace/diskIoCounters · `net.ts` — sockets/interfaceCounters/NetSampler · `counters.ts` — CounterSet/enumeration/wildcards/GPU%/sampleCounters · `eventlog.ts` — channels/query/tail/formatMessage · `etw.ts` — census/schemas/EtwSession · `firmware.ts` — smbios · `power.ts` — powerStatus/batteryState/powerScheme · `sessions.ts` — sessions · `locks.ts` — whoLocks · `sampler.ts` — tickers/watch/monotonicMicroseconds · `structs.ts` — every pure parser (byte-fixture-tested in `structs.test.ts`).
