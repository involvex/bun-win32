/**
 * ping — no-admin ICMP ping + traceroute to a host.
 *
 * Reads the reply from the ICMP_ECHO_REPLY struct (IcmpSendEcho) — no ping.exe
 * spawn, no localized-text parse, no CMD-window flash, no Administrator, no
 * node-gyp. Traceroute is a TTL ramp, not a raw socket.
 *
 * APIs demonstrated:
 *   - ping / traceroute (IcmpCreateFile + IcmpSendEcho, iphlpapi)
 *
 * Run: bun run example/ping.ts [host]   (default 1.1.1.1)
 */

import { ping, traceroute } from '../index';

const host = Bun.argv[2] ?? '1.1.1.1';

console.log(`\x1b[1mping ${host}\x1b[0m  \x1b[90m(no admin, no spawn)\x1b[0m`);
const reply = await ping(host);
console.log(reply.alive ? `  reply from ${reply.address}: ${reply.roundTripMs} ms · TTL=${reply.ttl} · ${reply.bytes} bytes` : `  \x1b[31m${reply.statusText}\x1b[0m (${reply.address})`);

console.log(`\n\x1b[1mtraceroute ${host}\x1b[0m  \x1b[90m(TTL ramp — no raw socket, no admin)\x1b[0m`);
for (const hop of await traceroute(host, { maxHops: 30, timeoutMs: 2000 })) {
  const rtt = hop.address === '*' ? '' : `${hop.roundTripMs} ms`;
  console.log(`  ${String(hop.ttl).padStart(2)}  ${hop.address.padEnd(18)} ${rtt.padStart(7)}  \x1b[90m${hop.statusText}\x1b[0m`);
}
