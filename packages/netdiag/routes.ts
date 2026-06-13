import { decodeSockaddr } from './addr';
import { addressFamilyValue, type AddressFamilyName } from './constants';
import { Iphlpapi, mibTable } from './win32';

// MIB_IPFORWARD_TABLE2 { ULONG NumEntries; MIB_IPFORWARD_ROW2 Table[] } — rows 8-aligned.
const TABLE_FIRST_ROW = 8;
// MIB_IPFORWARD_ROW2 (x64, netioapi.h) — stride verified end-to-end vs `route print` (S4.3).
const ROW_SIZE = 104;
const ROW_INTERFACE_INDEX = 8;
const ROW_DESTINATION_PREFIX = 12; // IP_ADDRESS_PREFIX.Prefix (SOCKADDR_INET)
const ROW_PREFIX_LENGTH = 40; // IP_ADDRESS_PREFIX.PrefixLength (UINT8)
const ROW_NEXT_HOP = 44; // SOCKADDR_INET
const ROW_METRIC = 84;
const ROW_PROTOCOL = 88;
const ROW_LOOPBACK = 92;
const ROW_ORIGIN = 100;

const ROUTE_PROTOCOL_NAMES: ReadonlyMap<number, string> = new Map([
  [1, 'other'],
  [2, 'local'],
  [3, 'static'],
  [4, 'icmp'],
  [10, 'rip'],
  [13, 'ospf'],
  [14, 'bgp'],
]);

const ROUTE_ORIGIN_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'manual'],
  [1, 'well-known'],
  [2, 'dhcp'],
  [3, 'router-advertisement'],
  [4, '6to4'],
]);

export interface Route {
  destinationPrefix: { address: string; length: number };
  nextHop: string;
  interfaceIndex: number;
  metric: number;
  protocol: string;
  loopback: boolean;
  origin: string;
  family: 'ipv4' | 'ipv6' | 'unknown';
}

/** The IPv4 + IPv6 routing table over GetIpForwardTable2 (replaces the wmic-dependent default-gateway). */
export function routes(family: AddressFamilyName = 'all'): Route[] {
  const familyValue = addressFamilyValue(family);
  return mibTable(
    (tablePointer) => Iphlpapi.GetIpForwardTable2(familyValue, tablePointer),
    TABLE_FIRST_ROW,
    ROW_SIZE,
    (table, row) => {
      const prefix = decodeSockaddr(table, row + ROW_DESTINATION_PREFIX);
      const nextHop = decodeSockaddr(table, row + ROW_NEXT_HOP);
      return {
        destinationPrefix: { address: prefix.address, length: table.readUInt8(row + ROW_PREFIX_LENGTH) },
        nextHop: nextHop.address,
        interfaceIndex: table.readUInt32LE(row + ROW_INTERFACE_INDEX),
        metric: table.readUInt32LE(row + ROW_METRIC),
        protocol: ROUTE_PROTOCOL_NAMES.get(table.readUInt32LE(row + ROW_PROTOCOL)) ?? 'other',
        loopback: table.readUInt8(row + ROW_LOOPBACK) !== 0,
        origin: ROUTE_ORIGIN_NAMES.get(table.readUInt32LE(row + ROW_ORIGIN)) ?? 'unknown',
        family: prefix.family,
      };
    },
  );
}

/** The next hop of the lowest-metric default route (0.0.0.0/0 or ::/0) — the locale-proof default-gateway replacement. */
export function defaultGateway(family: AddressFamilyName = 'ipv4'): string | undefined {
  let best: Route | undefined;
  for (const route of routes(family)) {
    if (route.destinationPrefix.length !== 0) continue;
    if (route.nextHop === '' || route.nextHop === '0.0.0.0' || route.nextHop === '::') continue;
    if (best === undefined || route.metric < best.metric) best = route;
  }
  return best?.nextHop;
}
