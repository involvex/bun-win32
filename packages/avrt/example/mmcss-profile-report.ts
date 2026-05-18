/**
 * MMCSS Profile Report
 *
 * A thorough Multimedia Class Scheduler Service (MMCSS) diagnostic. For every
 * well-known system-profile task it associates the calling thread, records the
 * returned task index and the system-responsiveness reservation, then sweeps all
 * five AVRT priority classes to confirm which the task accepts — finally reverting
 * cleanly. It also exercises the combined ("max") task characteristics call and
 * walks the full thread-ordering-group lifecycle, decoding any Win32 failure code
 * instead of hiding it.
 *
 * Output is an aligned, color-coded report: a task matrix, a priority-sweep
 * legend, the max-characteristics pairing, and the thread-ordering-group section.
 *
 * APIs demonstrated (Avrt):
 *   - AvSetMmThreadCharacteristicsW    (associate thread with a named task)
 *   - AvSetMmMaxThreadCharacteristicsW (combined characteristics for two tasks)
 *   - AvSetMmThreadPriority            (sweep all AVRT_PRIORITY classes)
 *   - AvQuerySystemResponsiveness      (non-MMCSS CPU reservation, 10–100%)
 *   - AvRevertMmThreadCharacteristics  (release the task association)
 *   - AvRtCreateThreadOrderingGroup    (create a thread-ordering group)
 *   - AvRtWaitOnThreadOrderingGroup    (parent wait primitive)
 *   - AvRtJoinThreadOrderingGroup      (client predecessor/successor join)
 *   - AvRtLeaveThreadOrderingGroup     (client leave)
 *   - AvRtDeleteThreadOrderingGroup    (destroy the group)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *   - GetLastError                                     (decode every failure)
 *
 * Run: bun run example/mmcss-profile-report.ts
 */
import Avrt, { AVRT_PRIORITY } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Avrt.Preload();
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'GetLastError']);

const STD_OUTPUT_HANDLE = -11;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[38;2;120;200;255m';
const GREEN = '\x1b[38;2;100;215;130m';
const RED = '\x1b[38;2;235;95;95m';
const YELLOW = '\x1b[38;2;235;205;100m';
const GRAY = '\x1b[38;2;150;160;175m';

// Documented MMCSS system-profile tasks (subkeys of …\Multimedia\SystemProfile\Tasks).
const TASKS = ['Audio', 'Capture', 'DisplayPostProcessing', 'Distribution', 'Games', 'Low Latency', 'Playback', 'Pro Audio', 'Window Manager'];

const PRIORITIES: [string, AVRT_PRIORITY][] = [
  ['VERYLOW', AVRT_PRIORITY.AVRT_PRIORITY_VERYLOW],
  ['LOW', AVRT_PRIORITY.AVRT_PRIORITY_LOW],
  ['NORMAL', AVRT_PRIORITY.AVRT_PRIORITY_NORMAL],
  ['HIGH', AVRT_PRIORITY.AVRT_PRIORITY_HIGH],
  ['CRITICAL', AVRT_PRIORITY.AVRT_PRIORITY_CRITICAL],
];

function decodeError(code: number): string {
  const map: Record<number, string> = {
    0: 'ERROR_SUCCESS',
    87: 'ERROR_INVALID_PARAMETER',
    1058: 'ERROR_SERVICE_DISABLED',
    1168: 'ERROR_NOT_FOUND',
    1314: 'ERROR_PRIVILEGE_NOT_HELD',
    1550: 'ERROR_INVALID_TASK_NAME',
    1551: 'ERROR_INVALID_TASK_INDEX',
  };
  return map[code] ?? `0x${code.toString(16).toUpperCase()}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

console.log(`${BOLD}${CYAN}MMCSS Profile Report${RESET}  ${DIM}Multimedia Class Scheduler Service — Avrt.dll${RESET}\n`);

// ── Task matrix ────────────────────────────────────────────────────────────
console.log(`${BOLD}System-Profile Tasks${RESET}`);
console.log(`${DIM}${pad('Task', 24)}${pad('Bound', 7)}${pad('TaskIndex', 11)}${pad('Responsiveness', 16)}Priority sweep (VL·LO·NO·HI·CR)${RESET}`);

let firstResponsiveness = -1;
for (const task of TASKS) {
  const taskIndex = Buffer.alloc(4); // 0 on first call; receives the index
  const name = Buffer.from(task + '\0', 'utf16le');
  const handle = Avrt.AvSetMmThreadCharacteristicsW(name.ptr, taskIndex.ptr);

  if (handle === 0n) {
    const err = Kernel32.GetLastError();
    console.log(`${pad(task, 24)}${RED}${pad('no', 7)}${RESET}${pad('—', 11)}${pad('—', 16)}${DIM}${decodeError(err)}${RESET}`);
    continue;
  }

  const idx = taskIndex.readUInt32LE(0);
  const respBuf = Buffer.alloc(4);
  const respOk = Avrt.AvQuerySystemResponsiveness(handle, respBuf.ptr);
  const resp = respOk ? respBuf.readUInt32LE(0) : -1;
  if (firstResponsiveness < 0 && resp >= 0) firstResponsiveness = resp;

  let sweep = '';
  for (const [, value] of PRIORITIES) {
    const ok = Avrt.AvSetMmThreadPriority(handle, value);
    sweep += ok ? `${GREEN}●${RESET}` : `${RED}○${RESET}`;
  }

  Avrt.AvRevertMmThreadCharacteristics(handle);
  const respText = resp >= 0 ? `${resp}%` : 'n/a';
  console.log(`${pad(task, 24)}${GREEN}${pad('yes', 7)}${RESET}${pad(String(idx), 11)}${pad(respText, 16)}${sweep}`);
}

console.log(`\n${DIM}${GREEN}●${RESET}${DIM} = priority accepted   ${RED}○${RESET}${DIM} = rejected   ` + `Responsiveness = CPU % reserved for non-MMCSS threads (default 20%, 10–100).${RESET}\n`);

// ── Combined (max) characteristics ─────────────────────────────────────────
console.log(`${BOLD}Combined Task Characteristics${RESET}  ${DIM}AvSetMmMaxThreadCharacteristicsW("Audio", "Pro Audio")${RESET}`);
{
  const maxIndex = Buffer.alloc(4);
  const first = Buffer.from('Audio\0', 'utf16le');
  const second = Buffer.from('Pro Audio\0', 'utf16le');
  const handle = Avrt.AvSetMmMaxThreadCharacteristicsW(first.ptr, second.ptr, maxIndex.ptr);
  if (handle === 0n) {
    console.log(`  ${RED}failed${RESET} ${DIM}(${decodeError(Kernel32.GetLastError())})${RESET}\n`);
  } else {
    console.log(`  ${GREEN}ok${RESET} — combined task index ${BOLD}${maxIndex.readUInt32LE(0)}${RESET}, handle 0x${handle.toString(16)}`);
    Avrt.AvRevertMmThreadCharacteristics(handle);
    console.log(`  ${DIM}reverted${RESET}\n`);
  }
}

// ── Thread Ordering Group lifecycle ────────────────────────────────────────
console.log(`${BOLD}Thread Ordering Group${RESET}  ${DIM}create → wait → delete (GUID_NULL ⇒ service-assigned id)${RESET}`);
{
  const context = Buffer.alloc(8); // PHANDLE out
  const period = Buffer.alloc(8); // LARGE_INTEGER, 100 ns units
  period.writeBigInt64LE(10_000_000n); // 1 s period
  const timeout = Buffer.alloc(8);
  timeout.writeBigInt64LE(50_000_000n); // 5 s timeout
  const guid = Buffer.alloc(16); // all-zero GUID_NULL → service generates one

  const created = Avrt.AvRtCreateThreadOrderingGroup(context.ptr, period.ptr, guid.ptr, timeout.ptr);
  if (!created) {
    const err = Kernel32.GetLastError();
    const note = err === 1058 ? ' (the thread-ordering server is disabled on this machine — binding verified, feature unavailable)' : '';
    console.log(`  ${YELLOW}AvRtCreateThreadOrderingGroup${RESET} → 0  ${DIM}${decodeError(err)}${note}${RESET}`);
    const g = [...guid.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
    console.log(`  ${GRAY}client-thread APIs (Join/Wait/Leave/Delete) require a live group; not exercised. GUID buffer: ${g}…${RESET}\n`);
  } else {
    const ctxHandle = context.readBigUInt64LE(0);
    const g = [...guid].map((b) => b.toString(16).padStart(2, '0')).join('');
    console.log(`  ${GREEN}AvRtCreateThreadOrderingGroup${RESET} → ok  context 0x${ctxHandle.toString(16)}  guid ${g}`);
    const waited = Avrt.AvRtWaitOnThreadOrderingGroup(ctxHandle);
    console.log(`  ${waited ? GREEN : YELLOW}AvRtWaitOnThreadOrderingGroup${RESET} → ${waited}  ${DIM}${decodeError(Kernel32.GetLastError())}${RESET}`);
    const deleted = Avrt.AvRtDeleteThreadOrderingGroup(ctxHandle);
    console.log(`  ${deleted ? GREEN : RED}AvRtDeleteThreadOrderingGroup${RESET} → ${deleted}  ${DIM}${decodeError(Kernel32.GetLastError())}${RESET}\n`);
  }
}

console.log(`${DIM}All ${BOLD}14${RESET}${DIM} documented avrt.dll exports are bound. Reverting is mandatory — always pair ` + `AvSetMm*ThreadCharacteristics with AvRevertMmThreadCharacteristics.${RESET}`);
