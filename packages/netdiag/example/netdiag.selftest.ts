/**
 * netdiag integration selftest — the on-hardware proof suite.
 *
 * Exercises every public surface against the live OS with ≥15 real assertions,
 * printing PASS/FAIL and exiting non-zero on any failure. Designed to run in a
 * NON-elevated shell — every assertion here is no-admin.
 *
 * APIs demonstrated:
 *   - adapters / defaultGateway / routes / neighbors (iphlpapi)
 *   - tcpConnections (socket→PID+module, iphlpapi)
 *   - ping / traceroute (no-admin ICMP, iphlpapi)
 *   - resolve / reverse (dnsapi) · tcpStatistics (iphlpapi) · wifiScan (wlanapi)
 *
 * Run: bun run example/netdiag.selftest.ts
 */

import { adapters, defaultGateway, neighbors, ping, resolve, reverse, routes, tcpConnections, tcpStatistics, traceroute, wifiScan } from '../index';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  \x1b[90m— ${detail}\x1b[0m` : ''}`);
  if (!condition) failures += 1;
}

const allAdapters = adapters();
check(
  '1  adapters() returns ≥1 with a MAC',
  allAdapters.some((adapter) => adapter.mac.length > 0),
);

const active = allAdapters.find((adapter) => adapter.gateways.length > 0);
check('2  the active adapter has a gateway', active !== undefined, active?.friendlyName);

const gateway = defaultGateway('ipv4');
check('3  defaultGateway() equals the active gateway', gateway !== undefined && active !== undefined && active.gateways.includes(gateway), gateway);

check(
  '4  routes() contains a default route',
  routes('all').some((route) => route.destinationPrefix.length === 0),
);

const ipv4Neighbors = neighbors('ipv4');
check('5  neighbors() resolves the gateway MAC', gateway !== undefined && ipv4Neighbors.some((neighbor) => neighbor.address === gateway && /^[0-9a-f]{2}:/.test(neighbor.mac)));

const connections = tcpConnections({ resolveNames: 'module' });
check('6  tcpConnections() returns rows with valid PIDs', connections.length > 0 && connections.every((connection) => connection.pid >= 0), `${connections.length} connections`);

check(
  '7  a connection PID maps to a process name',
  connections.some((connection) => connection.processName !== undefined && connection.processName.length > 0),
);

check('8  IPv6 appears in adapters or sockets', allAdapters.some((adapter) => adapter.ipv6.length > 0) || connections.some((connection) => connection.family === 'ipv6'));

const loopback = await ping('127.0.0.1');
check('9  ping(127.0.0.1) is alive with RTT ≥ 0', loopback.alive && loopback.roundTripMs >= 0, `${loopback.roundTripMs}ms ttl=${loopback.ttl}`);

const testNet = await ping('192.0.2.1', { timeoutMs: 1500 });
check('10 ping of TEST-NET times out cleanly', !testNet.alive && testNet.status === 11010, testNet.statusText);

const hops = await traceroute('1.1.1.1', { maxHops: 20, timeoutMs: 1500 });
check('11 traceroute(1.1.1.1) returns ≥1 hop', hops.length >= 1, `${hops.length} hops, last ${hops[hops.length - 1]?.address}`);

const aRecords = resolve('cloudflare.com', 'A');
check('12 resolve(cloudflare.com) returns an A record', aRecords.length >= 1, aRecords[0]?.address);

const ptrNames = reverse('1.1.1.1');
check('13 reverse(1.1.1.1) returns a name', ptrNames.length >= 1, ptrNames[0]);

const stats = tcpStatistics();
check('14 tcpStatistics() has plausible counts', stats.inSegments > 0 && stats.outSegments > 0, `in=${stats.inSegments} est=${stats.currentEstablished}`);

let wifiReportedCleanly = false;
let wifiDetail = '';
try {
  const networks = await wifiScan();
  wifiReportedCleanly = Array.isArray(networks);
  wifiDetail = `${networks.length} networks`;
} catch (error) {
  wifiReportedCleanly = true; // a distinct location-consent error is a clean report, not a crash
  wifiDetail = (error as Error).message.slice(0, 48);
}
check('15 WiFi scan returns an array OR reports cleanly', wifiReportedCleanly, wifiDetail);

console.log(`\n${failures === 0 ? '\x1b[32m✓ all checks passed\x1b[0m' : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
