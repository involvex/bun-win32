/**
 * MMCSS Jitter Scope
 *
 * A live scheduling-jitter oscilloscope. The script runs a fixed-interval timing
 * loop and measures how far each wake-up drifts from its target period using
 * Bun's monotonic nanosecond clock. It runs the same loop twice: once on a plain
 * thread, then again after registering the thread with the Multimedia Class
 * Scheduler Service (MMCSS) "Pro Audio" task at AVRT_PRIORITY_CRITICAL — the same
 * mechanism low-latency audio engines use to fight scheduler jitter.
 *
 * Each phase paints a scrolling truecolor ANSI sparkline of per-iteration jitter
 * (green = tight, red = a missed deadline) plus a running min / avg / p99 / max
 * panel and the live system-responsiveness reservation read straight from MMCSS.
 *
 * APIs demonstrated (Avrt):
 *   - AvSetMmThreadCharacteristicsW   (join the "Pro Audio" MMCSS task)
 *   - AvSetMmThreadPriority           (raise to AVRT_PRIORITY_CRITICAL)
 *   - AvQuerySystemResponsiveness     (CPU % reserved for non-MMCSS work)
 *   - AvRevertMmThreadCharacteristics (leave the task, restore scheduling)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *   - GetLastError                                     (decode MMCSS failures)
 *
 * Run: bun run example/mmcss-jitter-scope.ts
 */
import Avrt, { AVRT_PRIORITY } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Avrt.Preload(['AvSetMmThreadCharacteristicsW', 'AvSetMmThreadPriority', 'AvQuerySystemResponsiveness', 'AvRevertMmThreadCharacteristics']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'GetLastError']);

// Enable ANSI escape processing on stdout (Windows Terminal / VS Code / ConPTY).
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
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const TARGET_MS = 4; // 4 ms period — a 250 Hz audio-style service tick
const SAMPLES_PER_PHASE = 600; // ~2.4 s of wall time per phase
const WINDOW = 70; // sparkline width in columns

function colorForJitter(jitterMs: number): string {
  // Green under a quarter period, yellow up to a full period, red beyond.
  if (jitterMs < TARGET_MS * 0.25) return '\x1b[38;2;80;220;120m';
  if (jitterMs < TARGET_MS) return '\x1b[38;2;230;200;90m';
  return '\x1b[38;2;235;90;90m';
}

function sparkline(values: number[], max: number): string {
  let out = '';
  for (const v of values) {
    const level = max <= 0 ? 0 : Math.min(SPARK.length - 1, Math.floor((v / max) * (SPARK.length - 1)));
    out += `${colorForJitter(v)}${SPARK[level]}`;
  }
  return out + RESET;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function runPhase(label: string, color: string, useMmcss: boolean): Promise<void> {
  let avrtHandle = 0n;
  let responsiveness = -1;

  if (useMmcss) {
    const taskIndex = Buffer.alloc(4); // must be 0 on first call
    const taskName = Buffer.from('Pro Audio\0', 'utf16le');
    avrtHandle = Avrt.AvSetMmThreadCharacteristicsW(taskName.ptr, taskIndex.ptr);
    if (avrtHandle === 0n) {
      console.log(`${color}${label}${RESET}  ${DIM}MMCSS join failed (GetLastError=${Kernel32.GetLastError()}) — running unboosted${RESET}`);
    } else {
      Avrt.AvSetMmThreadPriority(avrtHandle, AVRT_PRIORITY.AVRT_PRIORITY_CRITICAL);
      const respBuf = Buffer.alloc(4);
      if (Avrt.AvQuerySystemResponsiveness(avrtHandle, respBuf.ptr)) {
        responsiveness = respBuf.readUInt32LE(0);
      }
    }
  }

  const jitter: number[] = [];
  const ring: number[] = [];
  const targetNs = BigInt(TARGET_MS) * 1_000_000n;
  let next = BigInt(Math.trunc(Bun.nanoseconds())) + targetNs;

  for (let i = 0; i < SAMPLES_PER_PHASE; i++) {
    // Busy-wait to the deadline — this is how a real-time audio callback waits.
    let now = BigInt(Math.trunc(Bun.nanoseconds()));
    while (now < next) now = BigInt(Math.trunc(Bun.nanoseconds()));

    const driftMs = Number(now - next) / 1_000_000;
    const absJitter = Math.abs(driftMs);
    jitter.push(absJitter);
    ring.push(absJitter);
    if (ring.length > WINDOW) ring.shift();
    next += targetNs;

    if (i % 12 === 0 || i === SAMPLES_PER_PHASE - 1) {
      const sorted = [...jitter].sort((a, b) => a - b);
      const avg = jitter.reduce((s, v) => s + v, 0) / jitter.length;
      const scaleMax = Math.max(TARGET_MS, ...ring);
      const respText = responsiveness >= 0 ? `${responsiveness}% reserved for non-MMCSS` : useMmcss ? 'unavailable' : 'n/a (no MMCSS)';
      process.stdout.write(
        `\x1b[2K\r${color}${BOLD}${label}${RESET} ${sparkline(ring, scaleMax)} ` +
          `${DIM}min${RESET} ${sorted[0]!.toFixed(3)} ` +
          `${DIM}avg${RESET} ${avg.toFixed(3)} ` +
          `${DIM}p99${RESET} ${percentile(sorted, 99).toFixed(3)} ` +
          `${DIM}max${RESET} ${sorted[sorted.length - 1]!.toFixed(3)} ${DIM}ms${RESET}  ` +
          `${DIM}responsiveness:${RESET} ${respText}`,
      );
    }
    if (i % 30 === 0) await new Promise((r) => setTimeout(r, 0)); // yield to the loop
  }
  process.stdout.write('\n');

  if (avrtHandle !== 0n) Avrt.AvRevertMmThreadCharacteristics(avrtHandle);

  const sorted = [...jitter].sort((a, b) => a - b);
  const avg = jitter.reduce((s, v) => s + v, 0) / jitter.length;
  console.log(`  ${DIM}└─ ${jitter.length} samples · mean ${avg.toFixed(3)} ms · p99 ${percentile(sorted, 99).toFixed(3)} ms · ` + `worst ${sorted[sorted.length - 1]!.toFixed(3)} ms${RESET}\n`);
}

process.stdout.write(HIDE_CURSOR);
try {
  console.log(`${BOLD}MMCSS Jitter Scope${RESET} ${DIM}— ${TARGET_MS} ms target tick, ${SAMPLES_PER_PHASE} samples/phase${RESET}\n`);
  await runPhase('PLAIN  ', '\x1b[38;2;150;160;180m', false);
  await runPhase('MMCSS  ', '\x1b[38;2;120;200;255m', true);
  console.log(`${DIM}Tip: lower mean/p99 jitter under MMCSS means tighter, audio-grade scheduling.${RESET}`);
} finally {
  process.stdout.write(SHOW_CURSOR);
}
