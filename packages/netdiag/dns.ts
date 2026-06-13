import { type Pointer, toArrayBuffer } from 'bun:ffi';

import { ipv4FromU32, ipv6FromBytes } from './addr';
import { DnsType } from './constants';
import { Dnsapi, readWideAt, Ws2_32 } from './win32';

const DNS_QUERY_STANDARD = 0x0000_0000;
const DNS_FREE_RECORD_LIST = 0x0000_0001; // DnsFreeType.DnsFreeRecordList
const AF_INET = 0x0000_0002;
const AF_INET6 = 0x0000_0017;

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'PTR' | 'SOA' | 'SRV' | 'TXT';

export type DnsRecord =
  | { type: 'A'; address: string; ttl: number }
  | { type: 'AAAA'; address: string; ttl: number }
  | { type: 'CNAME'; name: string; ttl: number }
  | { type: 'MX'; preference: number; exchange: string; ttl: number }
  | { type: 'NS'; name: string; ttl: number }
  | { type: 'PTR'; name: string; ttl: number }
  | { type: 'SOA'; primary: string; admin: string; serial: number; refresh: number; retry: number; expire: number; minimumTtl: number; ttl: number }
  | { type: 'SRV'; priority: number; weight: number; port: number; target: string; ttl: number }
  | { type: 'TXT'; strings: string[]; ttl: number };

export interface LookupResult {
  ipv4: string[];
  ipv6: string[];
}

const RECORD_TYPE_VALUES: Record<RecordType, number> = {
  A: DnsType.DNS_TYPE_A,
  AAAA: DnsType.DNS_TYPE_AAAA,
  CNAME: DnsType.DNS_TYPE_CNAME,
  MX: DnsType.DNS_TYPE_MX,
  NS: DnsType.DNS_TYPE_NS,
  PTR: DnsType.DNS_TYPE_PTR,
  SOA: DnsType.DNS_TYPE_SOA,
  SRV: DnsType.DNS_TYPE_SRV,
  TXT: DnsType.DNS_TYPE_TEXT,
};

let winsockReady = false;
function ensureWinsock(): void {
  if (winsockReady) return;
  Ws2_32.WSAStartup(0x0202, Buffer.allocUnsafeSlow(0x0198).ptr);
  winsockReady = true;
}

function readWidePointer(pointer: number): string {
  return pointer === 0 ? '' : readWideAt(Buffer.from(toArrayBuffer(pointer as Pointer, 0, 0x0400)), 0);
}

// DNS_RECORD data union (x64): each per-type payload begins at +32; wide-string fields are SEPARATELY-allocated pointers.
function decodeRecord(addr: Pointer, type: RecordType, ttl: number): DnsRecord {
  const node = Buffer.from(toArrayBuffer(addr, 0, 72)); // header(32) + largest fixed payload (SOA)
  switch (type) {
    case 'A':
      return { type, address: ipv4FromU32(node.readUInt32LE(32)), ttl };
    case 'AAAA':
      return { type, address: ipv6FromBytes(node, 32), ttl };
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return { type, name: readWidePointer(Number(node.readBigUInt64LE(32))), ttl };
    case 'MX':
      return { type, exchange: readWidePointer(Number(node.readBigUInt64LE(32))), preference: node.readUInt16LE(40), ttl };
    case 'SRV':
      return { type, target: readWidePointer(Number(node.readBigUInt64LE(32))), priority: node.readUInt16LE(40), weight: node.readUInt16LE(42), port: node.readUInt16LE(44), ttl };
    case 'SOA':
      return {
        type,
        primary: readWidePointer(Number(node.readBigUInt64LE(32))),
        admin: readWidePointer(Number(node.readBigUInt64LE(40))),
        serial: node.readUInt32LE(48),
        refresh: node.readUInt32LE(52),
        retry: node.readUInt32LE(56),
        expire: node.readUInt32LE(60),
        minimumTtl: node.readUInt32LE(64),
        ttl,
      };
    case 'TXT': {
      const count = node.readUInt32LE(32);
      const array = Buffer.from(toArrayBuffer(addr, 0, 40 + count * 8)); // dwStringCount@32, pStringArray@40
      const strings: string[] = [];
      for (let index = 0; index < count; index++) strings.push(readWidePointer(Number(array.readBigUInt64LE(40 + index * 8))));
      return { type, strings, ttl };
    }
  }
}

const queryOut = Buffer.allocUnsafeSlow(8);

/** Query DNS directly (DnsQuery_W) for a typed record set — arbitrary record types, beyond node:dns's fixed list. */
export function resolve<T extends RecordType>(name: string, type: T): Extract<DnsRecord, { type: T }>[];
export function resolve(name: string): Extract<DnsRecord, { type: 'A' }>[];
export function resolve(name: string, type: RecordType = 'A'): DnsRecord[] {
  const typeValue = RECORD_TYPE_VALUES[type];
  const wide = Buffer.allocUnsafeSlow((name.length + 1) * 2);
  wide.writeUInt16LE(0, wide.write(name, 'utf16le'));
  const status = Dnsapi.DnsQuery_W(wide.ptr, typeValue, DNS_QUERY_STANDARD, null, queryOut.ptr, null);
  if (status !== 0) return [];
  const head = Number(queryOut.readBigUInt64LE(0));
  if (head === 0) return [];
  const records: DnsRecord[] = [];
  try {
    let current = head;
    while (current !== 0) {
      const node = Buffer.from(toArrayBuffer(current as Pointer, 0, 32));
      if (node.readUInt16LE(16) === typeValue) records.push(decodeRecord(current as Pointer, type, node.readUInt32LE(24)));
      current = Number(node.readBigUInt64LE(0));
    }
  } finally {
    Dnsapi.DnsRecordListFree(head as Pointer, DNS_FREE_RECORD_LIST);
  }
  return records;
}

function ipv6ToArpa(ip: string): string {
  ensureWinsock();
  const bytes = Buffer.allocUnsafeSlow(16);
  const wide = Buffer.allocUnsafeSlow((ip.length + 1) * 2);
  wide.writeUInt16LE(0, wide.write(ip, 'utf16le'));
  if (Ws2_32.InetPtonW(AF_INET6, wide.ptr, bytes.ptr) !== 1) throw new Error(`invalid IPv6 address "${ip}"`);
  let name = '';
  for (let index = 15; index >= 0; index--) name += `${(bytes[index] & 0x0f).toString(16)}.${(bytes[index] >> 4).toString(16)}.`;
  return `${name}ip6.arpa`;
}

/** Reverse-resolve an IP to PTR names (in-addr.arpa / ip6.arpa). */
export function reverse(ip: string): string[] {
  const queryName = ip.includes(':') ? ipv6ToArpa(ip) : `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  return resolve(queryName, 'PTR').map((record) => record.name);
}

/** The SYSTEM resolver (getaddrinfo) — honors the hosts file and the full resolution policy; a different answer from resolve(). */
export function lookup(name: string): LookupResult {
  ensureWinsock();
  const result: LookupResult = { ipv4: [], ipv6: [] };
  const resultPointer = Buffer.allocUnsafeSlow(8);
  const nameBuffer = Buffer.allocUnsafeSlow(name.length + 1); // getaddrinfo is the ANSI (LPCSTR) variant
  nameBuffer.write(name, 'latin1');
  nameBuffer[name.length] = 0;
  if (Ws2_32.getaddrinfo(nameBuffer.ptr, null, null, resultPointer.ptr) !== 0) return result;
  const head = Number(resultPointer.readBigUInt64LE(0));
  try {
    let nodePointer = head;
    while (nodePointer !== 0) {
      const node = Buffer.from(toArrayBuffer(nodePointer as Pointer, 0, 48)); // ADDRINFOA
      const addressPointer = Number(node.readBigUInt64LE(32));
      if (addressPointer !== 0) {
        const sockaddr = Buffer.from(toArrayBuffer(addressPointer as Pointer, 0, 28));
        if (node.readInt32LE(4) === AF_INET) result.ipv4.push(ipv4FromU32(sockaddr.readUInt32LE(4)));
        else if (node.readInt32LE(4) === AF_INET6) result.ipv6.push(ipv6FromBytes(sockaddr, 8));
      }
      nodePointer = Number(node.readBigUInt64LE(40));
    }
  } finally {
    Ws2_32.freeaddrinfo(head as Pointer);
  }
  return result;
}
