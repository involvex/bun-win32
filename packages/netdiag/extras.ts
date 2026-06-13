import { decodeSockaddr, ipv4FromU32 } from './addr';
import { ICMP_PACKET_TOO_BIG, ICMP_SUCCESS } from './constants';
import { resolveIPv4, sendEcho } from './ping';
import { Iphlpapi, Win32Error } from './win32';

const AF_INET = 0x0000_0002;
const IP_FLAG_DF = 0x02;
const SOCKADDR_INET_SIZE = 28;
const MIB_IPFORWARD_ROW2_SIZE = 104;
const ROW2_INTERFACE_INDEX = 8;
const ROW2_NEXT_HOP = 44; // SOCKADDR_INET
const ROW2_METRIC = 84;

export interface BestRoute {
  destination: string;
  sourceAddress: string;
  nextHop: string;
  interfaceIndex: number;
  metric: number;
}

export interface PathMtuResult {
  mtu: number;
  determined: boolean;
}

const bestRouteBuffer = Buffer.allocUnsafeSlow(MIB_IPFORWARD_ROW2_SIZE);
const bestSourceBuffer = Buffer.allocUnsafeSlow(SOCKADDR_INET_SIZE);
const destinationBuffer = Buffer.allocUnsafeSlow(SOCKADDR_INET_SIZE);

/**
 * Which interface, source IP, and next hop the kernel would use to reach a host
 * (GetBestRoute2) — IPv4. No incumbent does this without parsing `route print`.
 */
export function bestRoute(host: string): BestRoute {
  const destination = resolveIPv4(host);
  destinationBuffer.fill(0);
  destinationBuffer.writeUInt16LE(AF_INET, 0); // SOCKADDR_INET.si_family
  destinationBuffer.writeUInt32LE(destination, 4); // sin_addr (network order)
  const error = Iphlpapi.GetBestRoute2(null, 0, null, destinationBuffer.ptr, 0, bestRouteBuffer.ptr, bestSourceBuffer.ptr);
  if (error !== 0) throw new Win32Error(error);
  return {
    destination: ipv4FromU32(destination),
    sourceAddress: decodeSockaddr(bestSourceBuffer, 0).address,
    nextHop: decodeSockaddr(bestRouteBuffer, ROW2_NEXT_HOP).address,
    interfaceIndex: bestRouteBuffer.readUInt32LE(ROW2_INTERFACE_INDEX),
    metric: bestRouteBuffer.readUInt32LE(ROW2_METRIC),
  };
}

/**
 * Path-MTU discovery by binary-searching a Don't-Fragment ICMP payload: a hop
 * that must fragment replies IP_PACKET_TOO_BIG, a DF black-hole simply times out
 * — both shrink the upper bound, so the largest payload that round-trips is the
 * path MTU (payload + 28-byte IP+ICMP headers). No raw socket, no admin.
 */
export function pathMtu(host: string, options: { timeoutMs?: number } = {}): PathMtuResult {
  const destination = resolveIPv4(host);
  const timeoutMs = options.timeoutMs ?? 1500;
  let low = 0;
  let high = 1472; // 1500 MTU − 28 header
  let largestWorking = -1;
  while (low <= high) {
    const payload = (low + high) >> 1;
    const echo = sendEcho(destination, 128, timeoutMs, payload, IP_FLAG_DF);
    if (echo.replied && echo.status === ICMP_SUCCESS) {
      largestWorking = payload;
      low = payload + 1;
    } else if (echo.replied && echo.status === ICMP_PACKET_TOO_BIG) {
      high = payload - 1;
    } else {
      high = payload - 1; // timeout / DF black-hole → treat as too big (conservative)
    }
  }
  return largestWorking < 0 ? { mtu: 0, determined: false } : { mtu: largestWorking + 28, determined: true };
}
