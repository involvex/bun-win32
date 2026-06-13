/**
 * netwatch — a live full-screen network dashboard (the wow).
 *
 * Refreshes the socket→PID(+module) table, the route/ARP counts, and live
 * per-interface throughput each second — every table a sub-millisecond syscall,
 * never a process spawn. Headless: DEMO_FRAMES=N runs N frames then exits 0.
 *
 * APIs demonstrated:
 *   - throughput / tcpConnections / routes / neighbors (iphlpapi)
 *
 * Run: bun run example/netwatch.ts        ·        DEMO_FRAMES=5 bun run example/netwatch.ts
 */

import { neighbors, routes, tcpConnections, throughput } from '../index';

const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string): string => `\x1b[90m${text}\x1b[0m`;
const cyan = (text: string): string => `\x1b[36m${text}\x1b[0m`;

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1e6) return `${(bytesPerSec / 1e6).toFixed(2)} MB/s`;
  if (bytesPerSec >= 1e3) return `${(bytesPerSec / 1e3).toFixed(0)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

const targetFrames = Number(Bun.env.DEMO_FRAMES ?? 0); // 0 ⇒ run until Ctrl-C
const headless = targetFrames > 0;

if (!headless) {
  process.stdout.write('\x1b[?25l\x1b[2J'); // hide cursor + clear
  process.on('SIGINT', () => {
    process.stdout.write('\x1b[?25h\n');
    process.exit(0);
  });
}

let frame = 0;
let peakRx = 0;
while (targetFrames === 0 || frame < targetFrames) {
  const samples = await throughput(1000); // 1 s window
  const established = tcpConnections({ resolveNames: 'module' }).filter((connection) => connection.state === 'established');
  const routeCount = routes('all').length;
  const neighborCount = neighbors('all').length;
  const active = samples.filter((sample) => (sample.rxBytesPerSec > 200 || sample.txBytesPerSec > 200) && !/Filter|Driver|Scheduler|Netmon|MAC Layer|QoS/i.test(sample.name)).sort((a, b) => b.rxBytesPerSec - a.rxBytesPerSec);
  for (const sample of samples) peakRx = Math.max(peakRx, sample.rxBytesPerSec);

  let out = headless ? '' : '\x1b[H';
  out += `${bold('netdiag · netwatch')}  ${dim(`frame ${frame + 1}${headless ? `/${targetFrames}` : ''} · ${new Date().toLocaleTimeString()} · ${routeCount} routes · ${neighborCount} neighbors · ${established.length} established`)}\x1b[K\n\n`;
  out += `${bold('Throughput')}\x1b[K\n`;
  if (active.length === 0) out += `  ${dim('(idle)')}\x1b[K\n`;
  for (const sample of active.slice(0, 6)) out += `  ${sample.name.padEnd(26)} ${dim('rx')} ${formatRate(sample.rxBytesPerSec).padStart(10)}  ${dim('tx')} ${formatRate(sample.txBytesPerSec).padStart(10)}\x1b[K\n`;
  out += `\n${bold('Top connections → PID')}\x1b[K\n`;
  for (const connection of established.slice(0, 10)) out += `  ${`${connection.remoteAddress}:${connection.remotePort}`.padEnd(26)} ${dim(`pid ${String(connection.pid).padEnd(6)}`)} ${cyan(connection.processName ?? '')}\x1b[K\n`;
  out += headless ? '' : '\x1b[J';
  process.stdout.write(out);
  frame += 1;
}

if (!headless) process.stdout.write('\x1b[?25h\n');
else console.log(`\nnetwatch: ran ${targetFrames} frames · peak rx ${formatRate(peakRx)}`);
