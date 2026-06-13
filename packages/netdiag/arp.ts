import { decodeSockaddr, macFromBytes } from './addr';
import { addressFamilyValue, type AddressFamilyName } from './constants';
import { Iphlpapi, mibTable } from './win32';

// MIB_IPNET_TABLE2 { ULONG NumEntries; MIB_IPNET_ROW2 Table[] } — rows 8-aligned.
const TABLE_FIRST_ROW = 8;
// MIB_IPNET_ROW2 (x64, netioapi.h) — stride verified end-to-end vs `arp -a` (S4.3).
const ROW_SIZE = 88;
const ROW_ADDRESS = 0; // SOCKADDR_INET
const ROW_INTERFACE_INDEX = 28;
const ROW_PHYSICAL_ADDRESS = 40;
const ROW_PHYSICAL_ADDRESS_LENGTH = 72;
const ROW_STATE = 76;
const ROW_FLAGS = 80; // bit0 IsRouter, bit1 IsUnreachable

const NEIGHBOR_STATE_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'unreachable'],
  [1, 'incomplete'],
  [2, 'probe'],
  [3, 'delay'],
  [4, 'stale'],
  [5, 'reachable'],
  [6, 'permanent'],
]);

export interface Neighbor {
  address: string;
  mac: string;
  interfaceIndex: number;
  state: string;
  isRouter: boolean;
  isUnreachable: boolean;
  family: 'ipv4' | 'ipv6' | 'unknown';
}

/** The typed neighbor (ARP + IPv6 ND) table over GetIpNetTable2 — richer than `arp -a` (reachability STATE, IPv6). */
export function neighbors(family: AddressFamilyName = 'all'): Neighbor[] {
  const familyValue = addressFamilyValue(family);
  return mibTable(
    (tablePointer) => Iphlpapi.GetIpNetTable2(familyValue, tablePointer),
    TABLE_FIRST_ROW,
    ROW_SIZE,
    (table, row) => {
      const address = decodeSockaddr(table, row + ROW_ADDRESS);
      const flags = table.readUInt8(row + ROW_FLAGS);
      return {
        address: address.address,
        mac: macFromBytes(table, row + ROW_PHYSICAL_ADDRESS, table.readUInt32LE(row + ROW_PHYSICAL_ADDRESS_LENGTH)),
        interfaceIndex: table.readUInt32LE(row + ROW_INTERFACE_INDEX),
        state: NEIGHBOR_STATE_NAMES.get(table.readUInt32LE(row + ROW_STATE)) ?? 'unknown',
        isRouter: (flags & 0x1) !== 0,
        isUnreachable: (flags & 0x2) !== 0,
        family: address.family,
      };
    },
  );
}

/** The classic IPv4-only ARP table view (a familiar `arp -a` shape over the modern API). */
export function arpTable(): Neighbor[] {
  return neighbors('ipv4');
}
