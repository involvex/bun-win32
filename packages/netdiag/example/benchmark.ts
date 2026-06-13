/**
 * benchmark — the "every sample is a syscall, not a spawn" number generator.
 *
 * Median ns/op (Bun.nanoseconds, warm-up, DFG-verified) for each hot path, the
 * samples/sec each implies, and the honest multiple over spawning `route print`.
 * These are the only numbers the README quotes.
 *
 * APIs demonstrated:
 *   - routes / tcpConnections / neighbors / interfaceCounters / sendEcho (iphlpapi)
 *
 * Run: bun run example/benchmark.ts
 */

import { numberOfDFGCompiles } from 'bun:jsc';

import { interfaceCounters, neighbors, routes, sendEcho, tcpConnections } from '../index';

function bench(name: string, fn: () => number, iters: number, warmup: number): { name: string; ns: number; dfg: number } {
  let sink = 0;
  for (let i = 0; i < warmup; i++) sink += fn();
  const samples: number[] = [];
  for (let trial = 0; trial < 5; trial++) {
    const start = Bun.nanoseconds();
    for (let i = 0; i < iters; i++) sink += fn();
    samples.push((Bun.nanoseconds() - start) / iters);
  }
  samples.sort((a, b) => a - b);
  if (sink === Number.MIN_SAFE_INTEGER) console.log(sink);
  return { name, ns: samples[2], dfg: numberOfDFGCompiles(fn) };
}

const LOOPBACK = 0x0100_007f;
const results = [
  bench('routes() poll+decode', () => routes('all').length, 5_000, 50_000),
  bench('tcpConnections() poll', () => tcpConnections().length, 5_000, 50_000),
  bench('neighbors() poll+decode', () => neighbors('all').length, 5_000, 30_000),
  bench('IcmpSendEcho 127.0.0.1', () => sendEcho(LOOPBACK, 0, 1000, 32).roundTripMs + 1, 2_000, 2_000),
  bench('interfaceCounters() poll', () => interfaceCounters().length, 2_000, 10_000),
];

// Spawn baseline: time an actual `route print` child process (median of 3).
const spawnSamples: number[] = [];
for (let i = 0; i < 3; i++) {
  const start = Bun.nanoseconds();
  Bun.spawnSync(['route', 'print']);
  spawnSamples.push(Bun.nanoseconds() - start);
}
spawnSamples.sort((a, b) => a - b);
const spawnNs = spawnSamples[1];

console.log('\n  operation                   ns/op      samples/sec   DFG');
console.log('  ───────────────────────────────────────────────────────');
for (const result of results) {
  console.log(
    `  ${result.name.padEnd(24)} ${result.ns.toFixed(0).padStart(9)}   ${Math.round(1_000_000_000 / result.ns)
      .toLocaleString('en-US')
      .padStart(12)}   ${result.dfg}`,
  );
}
console.log(`\n  route print spawn: ${(spawnNs / 1e6).toFixed(1)} ms = ${Math.round(1_000_000_000 / spawnNs)} spawns/sec`);
console.log(`  routes() polls ~${Math.round(spawnNs / results[0].ns).toLocaleString('en-US')}× faster than spawning route print.\n`);
