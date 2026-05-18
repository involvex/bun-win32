/**
 * Compositor Clock Scope
 *
 * A live oscilloscope of the Windows desktop compositor's own heartbeat,
 * straight from FFI. Each iteration parks the thread on
 * DCompositionWaitForCompositorClock until the compositor (DWM) ticks, then
 * timestamps the wake with QPC and reads the latest COMPLETED frame id. The
 * inter-tick interval is plotted as a scrolling truecolor ANSI waveform with a
 * running effective-refresh readout — you are watching the exact clock the
 * whole Windows desktop is composited against. Midway it asserts
 * DCompositionBoostCompositorClock so you can see the cadence shift live.
 *
 * APIs demonstrated (Dcomp):
 *   - DCompositionWaitForCompositorClock  (block until the next compositor tick)
 *   - DCompositionGetFrameId              (latest COMPLETED frame id)
 *   - DCompositionGetStatistics           (COMPOSITION_FRAME_STATS frame period)
 *   - DCompositionBoostCompositorClock    (request a higher refresh rate)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *   - QueryPerformanceFrequency / QueryPerformanceCounter  (tick timestamps)
 *
 * Run: bun run example/compositor-clock-scope.ts
 */
import Dcomp, { COMPOSITION_FRAME_ID_TYPE } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Dcomp.Preload(['DCompositionWaitForCompositorClock', 'DCompositionGetFrameId', 'DCompositionGetStatistics', 'DCompositionBoostCompositorClock']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'QueryPerformanceFrequency']);

const STD_OUTPUT_HANDLE = -11;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr!)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[38;2;120;200;255m';
const GREEN = '\x1b[38;2;90;220;130m';
const YELLOW = '\x1b[38;2;235;205;100m';
const VIOLET = '\x1b[38;2;195;150;255m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';

const STATUS_SUCCESS = 0;

const freqBuf = Buffer.alloc(8);
Kernel32.QueryPerformanceFrequency(freqBuf.ptr!);
const qpcFreq = Number(freqBuf.readBigUInt64LE(0)) || 1;

// count = 0 → wait purely on the compositor clock. handles is _In_reads_(count)
// so with count 0 it is never dereferenced; pass a zero-length scratch cell.
const noHandles = Buffer.alloc(8);
const frameIdBuf = Buffer.alloc(8);
// COMPOSITION_FRAME_STATS = { UINT64 startTime; UINT64 targetTime; UINT64 framePeriod; }
const statsBuf = Buffer.alloc(24);
const actualCountBuf = Buffer.alloc(4);

const WIDTH = 64;
const periods: number[] = []; // compositor frame period, ms
const SPARK = '▁▂▃▄▅▆▇█';

process.stdout.write(HIDE_CURSOR + CLEAR);

let boosted = false;
let lastFrameId = 0n;

try {
  const FRAMES = 90;
  for (let frame = 0; frame < FRAMES; frame++) {
    if (frame === 45 && !boosted) {
      Dcomp.DCompositionBoostCompositorClock(1);
      boosted = true;
    }

    // Pace to the real compositor tick when the clock is live; if the display
    // is occluded/off the call returns immediately with a graphics NTSTATUS,
    // so fall back to a ~16 ms timer to keep the scope smooth.
    const status = Dcomp.DCompositionWaitForCompositorClock(0, noHandles.ptr!, 60);
    if (status !== STATUS_SUCCESS) await new Promise((r) => setTimeout(r, 16));

    Dcomp.DCompositionGetFrameId(COMPOSITION_FRAME_ID_TYPE.COMPOSITION_FRAME_ID_COMPLETED, frameIdBuf.ptr!);
    const completedId = frameIdBuf.readBigUInt64LE(0);
    const advanced = lastFrameId === 0n ? 0n : completedId - lastFrameId;
    lastFrameId = completedId;

    // The compositor's true frame period comes from COMPOSITION_FRAME_STATS —
    // available even while WaitForCompositorClock is occluded.
    const statsHr = Dcomp.DCompositionGetStatistics(completedId, statsBuf.ptr!, 0, null, actualCountBuf.ptr!);
    if (statsHr === STATUS_SUCCESS) {
      const periodMs = (Number(statsBuf.readBigUInt64LE(16)) / qpcFreq) * 1000;
      if (periodMs > 0 && periodMs < 100) {
        periods.push(periodMs);
        if (periods.length > WIDTH) periods.shift();
      }
    }

    const recent = periods.slice(-30);
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    const hz = avg > 0 ? 1000 / avg : 0;
    const min = periods.length ? Math.min(...periods) : 0;
    const max = periods.length ? Math.max(...periods) : 0;
    const jitter = max - min;

    // Scale each period to a spark glyph against the observed min/max band.
    const lo = min || 0;
    const hi = max || 1;
    const wave = periods
      .map((v) => {
        const norm = hi > lo ? (v - lo) / (hi - lo) : 0.5;
        const idx = Math.min(SPARK.length - 1, Math.max(0, Math.round(norm * (SPARK.length - 1))));
        return `${v > avg * 1.3 ? YELLOW : CYAN}${SPARK[idx]}${RESET}`;
      })
      .join('');

    const clockText = status === STATUS_SUCCESS ? `${GREEN}STATUS_SUCCESS${RESET} ${DIM}(live tick)${RESET}` : `${YELLOW}0x${(status >>> 0).toString(16)}${RESET} ${DIM}(display occluded — period from stats)${RESET}`;

    let out = HOME;
    out += `${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${RESET}\n`;
    out += `${BOLD}${CYAN}║   DIRECTCOMPOSITION · COMPOSITOR CLOCK SCOPE                          ║${RESET}\n`;
    out += `${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${RESET}\n\n`;
    out += `  ${DIM}DCompositionWaitForCompositorClock${RESET}  ${clockText}\n`;
    out += `  ${DIM}Latest COMPLETED frame id${RESET}          ${VIOLET}#${completedId}${RESET} ${DIM}(+${advanced} since last sample)${RESET}\n\n`;
    out += `  ${BOLD}Compositor refresh${RESET}  ${GREEN}${hz.toFixed(2)} Hz${RESET}   ${DIM}(frame period ${avg.toFixed(3)} ms)${RESET}\n`;
    out += `  ${BOLD}Jitter${RESET}              ${jitter > 1 ? YELLOW : CYAN}${jitter.toFixed(3)} ms${RESET}   ${DIM}min ${min.toFixed(3)} / max ${max.toFixed(3)}${RESET}\n`;
    out += `  ${BOLD}Boost${RESET}               ${boosted ? `${GREEN}ON${RESET} ${DIM}(BoostCompositorClock(TRUE) asserted)${RESET}` : `${DIM}off${RESET}`}\n\n`;
    out += `  ${DIM}┌${'─'.repeat(WIDTH)}┐${RESET}\n`;
    out += `  ${DIM}│${RESET}${wave}${' '.repeat(Math.max(0, WIDTH - periods.length))}${DIM}│${RESET}\n`;
    out += `  ${DIM}└${'─'.repeat(WIDTH)}┘${RESET}\n`;
    out += `  ${DIM}each column = one compositor frame period; taller = longer frame${RESET}\n`;
    process.stdout.write(out);
  }
  if (boosted) Dcomp.DCompositionBoostCompositorClock(0);
} finally {
  process.stdout.write(SHOW_CURSOR + '\n');
}
