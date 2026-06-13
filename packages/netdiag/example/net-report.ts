/**
 * net-report — a single-shot, richly formatted network diagnostic.
 *
 * Adapters, default gateway, routing table, socket→PID(+module) table, the
 * neighbor/ARP table, a DNS query, and protocol statistics — every line decoded
 * from a binary struct, no netsh/wmic/ping.exe/netstat spawn, no admin.
 *
 * APIs demonstrated:
 *   - adapters / defaultGateway / routes / neighbors (iphlpapi)
 *   - tcpConnections (socket→PID+module, iphlpapi)
 *   - resolve (dnsapi) · tcp/udp/ipStatistics + interfaceCounters (iphlpapi)
 *
 * Run: bun run example/net-report.ts
 */

import { adapters, defaultGateway, interfaceCounters, ipStatistics, neighbors, resolve, routes, tcpConnections, tcpStatistics, udpStatistics } from '../index';

const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string): string => `\x1b[90m${text}\x1b[0m`;
const cyan = (text: string): string => `\x1b[36m${text}\x1b[0m`;

console.log(`${bold('═══ netdiag report ═══')}${dim(`  ${new Date().toISOString()}`)}`);

console.log(bold('\nAdapters'));
for (const adapter of adapters()) {
  if (adapter.operStatus !== 'up' || (adapter.ipv4.length === 0 && adapter.ipv6.length === 0)) continue;
  console.log(`  ${cyan(adapter.friendlyName)} ${dim(`[${adapter.operStatus}] ${adapter.linkSpeedMbps} Mbps · mtu ${adapter.mtu}`)}`);
  console.log(`    ${dim('mac')} ${adapter.mac}  ${dim('ipv4')} ${adapter.ipv4.join(', ') || '—'}  ${dim('gw')} ${adapter.gateways.join(', ') || '—'}  ${dim('dns')} ${adapter.dnsServers.join(', ') || '—'}`);
  if (adapter.ipv6.length > 0) console.log(`    ${dim('ipv6')} ${adapter.ipv6.join(', ')}`);
}
console.log(`  ${bold('default gateway')}: ${defaultGateway('ipv4') ?? '—'}`);

console.log(`${bold('\nRoutes')}${dim(' (default + low-metric)')}`);
for (const route of routes('all')
  .filter((candidate) => candidate.destinationPrefix.length === 0)
  .slice(0, 6)) {
  console.log(`  ${`${route.destinationPrefix.address}/${route.destinationPrefix.length}`.padEnd(20)} → ${route.nextHop.padEnd(16)} ${dim(`if=${route.interfaceIndex} metric=${route.metric} ${route.protocol}`)}`);
}

const established = tcpConnections({ resolveNames: 'module' }).filter((connection) => connection.state === 'established');
console.log(`${bold('\nEstablished connections → PID')}${dim(` (${established.length} total)`)}`);
for (const connection of established.slice(0, 12)) {
  console.log(`  ${`${connection.remoteAddress}:${connection.remotePort}`.padEnd(26)} ${dim(`pid ${String(connection.pid).padEnd(6)}`)} ${connection.processName ?? ''}`);
}

const resolvedNeighbors = neighbors('ipv4').filter((neighbor) => /^[0-9a-f]{2}:/.test(neighbor.mac));
console.log(`${bold('\nNeighbors / ARP')}${dim(` (${resolvedNeighbors.length} resolved)`)}`);
for (const neighbor of resolvedNeighbors.slice(0, 8)) console.log(`  ${neighbor.address.padEnd(16)} ${neighbor.mac} ${dim(neighbor.state)}${neighbor.isRouter ? dim(' [router]') : ''}`);

console.log(bold('\nDNS'));
console.log(
  `  cloudflare.com A → ${cyan(
    resolve('cloudflare.com', 'A')
      .map((record) => record.address)
      .join(', '),
  )}`,
);
console.log(
  `  google.com MX   → ${resolve('google.com', 'MX')
    .map((record) => `${record.preference} ${record.exchange}`)
    .join(', ')}`,
);

const tcp = tcpStatistics();
const udp = udpStatistics();
const ip = ipStatistics();
console.log(bold('\nProtocol statistics'));
console.log(`  ${dim('tcp')} established=${tcp.currentEstablished} inSeg=${tcp.inSegments} outSeg=${tcp.outSegments} retrans=${tcp.retransmittedSegments} resets=${tcp.outResets}`);
console.log(`  ${dim('udp')} inDatagrams=${udp.inDatagrams} outDatagrams=${udp.outDatagrams} noPorts=${udp.noPorts}`);
console.log(`  ${dim('ip ')} inReceives=${ip.inReceives} outRequests=${ip.outRequests} inDiscards=${ip.inDiscards}`);

console.log(bold('\nInterface octets'));
for (const counters of interfaceCounters()) {
  if (counters.inOctets === 0 && counters.outOctets === 0) continue;
  if (!/^(Wi-Fi|Ethernet|Local Area)/.test(counters.name)) continue;
  console.log(`  ${counters.name.padEnd(20)} ${dim('in')} ${(counters.inOctets / 1e6).toFixed(0)} MB ${dim('out')} ${(counters.outOctets / 1e6).toFixed(0)} MB ${dim(`err ${counters.inErrors}/${counters.outErrors}`)}`);
}
console.log('');
