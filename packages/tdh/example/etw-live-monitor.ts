/**
 * Live ETW Event Monitor — a real-time X-ray of the running OS
 *
 * Opens a real **real-time** Event Tracing for Windows session, subscribes to
 * the kernel process/thread/image provider, and renders a live, color-coded
 * feed of everything the operating system is doing right now — every process
 * that starts or exits, every image that loads — decoded from raw binary
 * EVENT_RECORDs entirely through FFI. A live histogram of event activity
 * updates in place beneath the stream.
 *
 * This is the headline TDH demo: advapi32 drives the ETW session, and tdh.dll
 * turns each opaque event blob into a named, human-readable record. No PerfView,
 * no xperf, no native addon — just Bun FFI.
 *
 * Real-time ETW sessions require an elevated process (same as logman / xperf /
 * PerfView). If not elevated, the program explains how to relaunch and exits
 * cleanly without error.
 *
 * APIs demonstrated (Tdh):
 *   - TdhEnumerateProviders     (resolve a provider GUID by name, no hardcoding)
 *   - TdhGetEventInformation    (decode each EVENT_RECORD → provider/task/opcode)
 *
 * APIs demonstrated (Advapi32, cross-package):
 *   - StartTraceW               (create the real-time logger session)
 *   - EnableTraceEx2            (attach the kernel-process provider)
 *   - OpenTraceW                (open the real-time stream + install callbacks)
 *   - ProcessTrace              (pump events; blocks, drives the callbacks)
 *   - CloseTrace / ControlTraceW(tear the session down)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run (elevated): bun run example/etw-live-monitor.ts
 */
import { JSCallback, toArrayBuffer, type Pointer } from 'bun:ffi';

import Tdh from '../index';
import Advapi32 from '@bun-win32/advapi32';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

const ERROR_SUCCESS = 0;
const ERROR_ACCESS_DENIED = 5;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_INSUFFICIENT_BUFFER = 122;

const WNODE_FLAG_TRACED_GUID = 0x0002_0000;
const EVENT_TRACE_REAL_TIME_MODE = 0x0000_0100;
const EVENT_CONTROL_CODE_ENABLE_PROVIDER = 1;
const EVENT_TRACE_CONTROL_STOP = 1;
const TRACE_LEVEL_VERBOSE = 5;
const PROCESS_TRACE_MODE_REAL_TIME = 0x0000_0100;
const PROCESS_TRACE_MODE_EVENT_RECORD = 0x1000_0000;
const INVALID_PROCESSTRACE_HANDLE = 0xffff_ffff_ffff_ffffn;

const SESSION_NAME = 'BunTdhLiveMonitor';
const TARGET_PROVIDER = 'Microsoft-Windows-Kernel-Process';
const RUN_MS = 12_000;

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[91m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const BLUE = '\x1b[94m';
const MAGENTA = '\x1b[95m';
const CYAN = '\x1b[96m';
const GREY = '\x1b[90m';

// ── Enable ANSI escape processing ───────────────────────────────────────────
const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const modeBuffer = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuffer.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuffer.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

function readWide(buffer: Buffer, byteOffset: number): string {
  if (byteOffset <= 0 || byteOffset >= buffer.length) return '';
  let result = '';
  for (let i = byteOffset; i + 1 < buffer.length; i += 2) {
    const code = buffer.readUInt16LE(i);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

// ── 1. Resolve the provider GUID by name (via TDH, no hardcoded GUID) ────────
function resolveProviderGuid(name: string): Buffer | null {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(0, 0);
  if (Tdh.TdhEnumerateProviders(null, size.ptr) !== ERROR_INSUFFICIENT_BUFFER) return null;
  const buffer = Buffer.alloc(size.readUInt32LE(0));
  if (Tdh.TdhEnumerateProviders(buffer.ptr, size.ptr) !== ERROR_SUCCESS) return null;

  const count = buffer.readUInt32LE(0);
  for (let i = 0; i < count; i++) {
    const base = 8 + i * 24;
    const nameOffset = buffer.readUInt32LE(base + 20);
    if (readWide(buffer, nameOffset) === name) {
      return Buffer.from(buffer.subarray(base, base + 16)); // 16-byte GUID copy
    }
  }
  return null;
}

const providerGuid = resolveProviderGuid(TARGET_PROVIDER);
if (!providerGuid) {
  console.error(`Could not resolve provider "${TARGET_PROVIDER}".`);
  process.exit(1);
}

console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║                  Live ETW Monitor  ·  powered by TDH                 ║${RESET}`);
console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${RESET}`);
console.log(`${DIM}Provider: ${TARGET_PROVIDER}${RESET}\n`);

// ── 2. Build EVENT_TRACE_PROPERTIES and start a real-time session ───────────
// Layout (x64): WNODE_HEADER (48 B) + EVENT_TRACE_PROPERTIES tail = 120 B,
// followed by room for the logger name that StartTraceW copies in.
const PROPS_SIZE = 120;
const properties = Buffer.alloc(PROPS_SIZE + 512);
properties.writeUInt32LE(properties.length, 0); // Wnode.BufferSize
properties.writeUInt32LE(1, 40); // Wnode.ClientContext = 1 (QPC clock)
properties.writeUInt32LE(WNODE_FLAG_TRACED_GUID, 44); // Wnode.Flags
properties.writeUInt32LE(EVENT_TRACE_REAL_TIME_MODE, 64); // LogFileMode
properties.writeUInt32LE(0, 112); // LogFileNameOffset (none — real time)
properties.writeUInt32LE(PROPS_SIZE, 116); // LoggerNameOffset

const sessionNameW = Buffer.from(SESSION_NAME + '\0', 'utf16le');

function stopSessionByName(): void {
  const stopProps = Buffer.alloc(PROPS_SIZE + 512);
  stopProps.writeUInt32LE(stopProps.length, 0);
  stopProps.writeUInt32LE(PROPS_SIZE, 116);
  Advapi32.ControlTraceW(0n, sessionNameW.ptr, stopProps.ptr, EVENT_TRACE_CONTROL_STOP);
}

function explainElevationAndExit(): never {
  console.log(`${YELLOW}${BOLD}⚠  Real-time ETW requires an elevated process.${RESET}`);
  console.log(`${DIM}   Relaunch from an ${BOLD}Administrator${RESET}${DIM} terminal:${RESET}`);
  console.log(`${CYAN}     bun run example/etw-live-monitor.ts${RESET}`);
  console.log(`${DIM}   (This is the same requirement as logman, xperf, and PerfView.)${RESET}\n`);
  process.exit(0);
}

const sessionHandleBuffer = Buffer.alloc(8);
let startStatus = Advapi32.StartTraceW(sessionHandleBuffer.ptr, sessionNameW.ptr, properties.ptr);
if (startStatus === ERROR_ALREADY_EXISTS) {
  stopSessionByName();
  startStatus = Advapi32.StartTraceW(sessionHandleBuffer.ptr, sessionNameW.ptr, properties.ptr);
}

if (startStatus === ERROR_ACCESS_DENIED) {
  explainElevationAndExit();
}
if (startStatus !== ERROR_SUCCESS) {
  console.error(`StartTraceW failed with status ${startStatus}.`);
  process.exit(1);
}

const sessionHandle = sessionHandleBuffer.readBigUInt64LE(0);

// ── 3. Attach the provider at verbose level ─────────────────────────────────
const enableStatus = Advapi32.EnableTraceEx2(sessionHandle, providerGuid.ptr, EVENT_CONTROL_CODE_ENABLE_PROVIDER, TRACE_LEVEL_VERBOSE, 0n, 0n, 0, null!);
if (enableStatus === ERROR_ACCESS_DENIED) {
  stopSessionByName();
  explainElevationAndExit();
}
if (enableStatus !== ERROR_SUCCESS) {
  console.error(`EnableTraceEx2 failed with status ${enableStatus}.`);
  stopSessionByName();
  process.exit(1);
}

// ── 4. Decode + render state ────────────────────────────────────────────────
const histogram = new Map<string, number>();
let eventTotal = 0;
let lastRender = 0;
const recent: string[] = [];
const deadline = Date.now() + RUN_MS;

const teiSize = Buffer.alloc(4);
let teiBuffer = Buffer.alloc(8192);

function render(): void {
  const lines: string[] = [];
  lines.push(
    `${BOLD}${CYAN}● live${RESET}  ${DIM}events decoded:${RESET} ${GREEN}${eventTotal}${RESET}  ${DIM}distinct:${RESET} ${YELLOW}${histogram.size}${RESET}  ${DIM}${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s left${RESET}`,
  );
  lines.push('');
  for (const line of recent.slice(-10)) lines.push(line);
  lines.push('');
  lines.push(`${BOLD}${GREY}── activity by event ──────────────────────────────────────────────${RESET}`);
  const top = [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = top.length ? top[0]![1] : 1;
  for (const [key, value] of top) {
    const width = Math.max(1, Math.round((value / max) * 34));
    const bar = '█'.repeat(width);
    lines.push(`  ${CYAN}${key.padEnd(40, ' ').slice(0, 40)}${RESET} ${BLUE}${bar}${RESET} ${DIM}${value}${RESET}`);
  }
  // Home cursor + clear screen, then paint the frame.
  process.stdout.write('\x1b[H\x1b[2J' + lines.join('\n') + '\n');
}

function colorForOpcode(opcode: number): string {
  if (opcode === 1) return GREEN; // Start
  if (opcode === 2) return RED; // Stop / End
  if (opcode === 3 || opcode === 4) return MAGENTA; // DC start/end
  return BLUE;
}

// ── 5. EVENT_RECORD callback — decode via TdhGetEventInformation ────────────
const recordCallback = new JSCallback(
  (eventRecord: Pointer) => {
    if (!eventRecord) return;
    const header = new DataView(toArrayBuffer(eventRecord, 0, 0x70));
    const processId = header.getUint32(12, true);
    const eventId = header.getUint16(40, true); // EventDescriptor.Id
    const opcode = header.getUint8(45); // EventDescriptor.Opcode

    // Two-call sizing for TRACE_EVENT_INFO.
    teiSize.writeUInt32LE(0, 0);
    let status = Tdh.TdhGetEventInformation(eventRecord, 0, null, null, teiSize.ptr);
    const needed = teiSize.readUInt32LE(0);
    if (status === ERROR_INSUFFICIENT_BUFFER && needed > 0) {
      if (needed > teiBuffer.length) teiBuffer = Buffer.alloc(needed);
      teiSize.writeUInt32LE(teiBuffer.length, 0);
      status = Tdh.TdhGetEventInformation(eventRecord, 0, null, teiBuffer.ptr, teiSize.ptr);
    }

    let providerName = TARGET_PROVIDER;
    let taskName = '';
    let opcodeName = '';
    if (status === ERROR_SUCCESS) {
      providerName = readWide(teiBuffer, teiBuffer.readUInt32LE(52)) || providerName; // ProviderNameOffset
      taskName = readWide(teiBuffer, teiBuffer.readUInt32LE(68)); // TaskNameOffset
      opcodeName = readWide(teiBuffer, teiBuffer.readUInt32LE(72)); // OpcodeNameOffset
    }

    const shortProvider = providerName.replace(/^Microsoft-Windows-/, '');
    const label = `${shortProvider} · ${taskName || `Event ${eventId}`}${opcodeName ? `/${opcodeName}` : ''}`;
    histogram.set(label, (histogram.get(label) ?? 0) + 1);
    eventTotal++;

    const tint = colorForOpcode(opcode);
    recent.push(`  ${GREY}pid ${String(processId).padStart(6, ' ')}${RESET}  ${tint}${(taskName || `Event ${eventId}`).padEnd(22, ' ').slice(0, 22)}${RESET} ${DIM}${opcodeName || `op${opcode}`}${RESET}`);
    if (recent.length > 64) recent.splice(0, recent.length - 64);

    const now = Date.now();
    if (now - lastRender > 250) {
      lastRender = now;
      render();
    }
  },
  { args: ['ptr'], returns: 'void' },
);

// ── 6. BufferCallback — return FALSE past the deadline to stop ProcessTrace ──
const bufferCallback = new JSCallback(() => (Date.now() < deadline ? 1 : 0), { args: ['ptr'], returns: 'u32' });

// ── 7. EVENT_TRACE_LOGFILEW (x64, 448 B) + open the real-time stream ────────
const logfile = Buffer.alloc(448);
logfile.writeBigUInt64LE(BigInt(sessionNameW.ptr ?? 0), 8); // LoggerName
logfile.writeUInt32LE(PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD, 28); // ProcessTraceMode
logfile.writeBigUInt64LE(BigInt(bufferCallback.ptr ?? 0), 400); // BufferCallback
logfile.writeBigUInt64LE(BigInt(recordCallback.ptr ?? 0), 424); // EventRecordCallback

const traceHandle = Advapi32.OpenTraceW(logfile.ptr);
if (traceHandle === INVALID_PROCESSTRACE_HANDLE) {
  console.error('OpenTraceW failed.');
  stopSessionByName();
  process.exit(1);
}

console.log(`${DIM}Streaming for ${RUN_MS / 1000}s — start/stop processes to watch it move…${RESET}`);

// ── 8. Pump events (blocks until BufferCallback returns FALSE) ──────────────
const handleArray = Buffer.alloc(8);
handleArray.writeBigUInt64LE(traceHandle, 0);
const processStatus = Advapi32.ProcessTrace(handleArray.ptr, 1, null!, null!);

// ── 9. Tear down ────────────────────────────────────────────────────────────
Advapi32.CloseTrace(traceHandle);
stopSessionByName();
recordCallback.close();
bufferCallback.close();

render();
console.log('');
if (processStatus !== ERROR_SUCCESS) {
  console.log(`${DIM}ProcessTrace returned ${processStatus}.${RESET}`);
}
console.log(`${BOLD}${GREEN}✓ Captured ${eventTotal} live ETW events — decoded entirely through tdh.dll FFI.${RESET}\n`);
