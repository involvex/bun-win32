/**
 * DNS Resolution Tree
 *
 * Resolves multiple domains across many record types (A, AAAA, MX, NS, TXT,
 * SOA, CNAME, CAA, SRV) and renders the results as an animated Unicode tree.
 * Each branch fades in as records arrive, with record types colorized for
 * quick visual scanning and TTLs displayed alongside.
 *
 * APIs demonstrated:
 *   - DnsQuery_W                    (lookup by name + record type)
 *   - DnsRecordListFree             (release the linked list of records)
 *
 * DNS_RECORD layout (x64, 32-byte header):
 *   +0x00: pNext        (PDNS_RECORD)
 *   +0x08: pName        (LPWSTR)
 *   +0x10: wType        (WORD)
 *   +0x12: wDataLength  (WORD)
 *   +0x14: Flags        (DWORD bit field)
 *   +0x18: dwTtl        (DWORD)
 *   +0x1C: dwReserved   (DWORD)
 *   +0x20: Data union (varies by wType)
 *
 * Run: bun run example/dns-tree.ts
 */

import { read, toArrayBuffer, type Pointer } from 'bun:ffi';

import Dnsapi, { DnsFreeType, DnsQueryOption, DnsType } from '../index';

Dnsapi.Preload(['DnsQuery_W', 'DnsRecordListFree']);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const COLOR: Record<string, string> = {
  AAAA: '\x1b[36m',
  A: '\x1b[33m',
  CAA: '\x1b[37m',
  CNAME: '\x1b[35m',
  HEAD: '\x1b[1;97m',
  MX: '\x1b[91m',
  NS: '\x1b[92m',
  SOA: '\x1b[94m',
  SRV: '\x1b[96m',
  TXT: '\x1b[93m',
};

interface ParsedRecord {
  ttl: number;
  type: number;
  typeName: string;
  display: string;
}

const TYPE_NAMES: Record<number, string> = {
  [DnsType.DNS_TYPE_A]: 'A',
  [DnsType.DNS_TYPE_AAAA]: 'AAAA',
  [DnsType.DNS_TYPE_CAA]: 'CAA',
  [DnsType.DNS_TYPE_CNAME]: 'CNAME',
  [DnsType.DNS_TYPE_MX]: 'MX',
  [DnsType.DNS_TYPE_NS]: 'NS',
  [DnsType.DNS_TYPE_PTR]: 'PTR',
  [DnsType.DNS_TYPE_SOA]: 'SOA',
  [DnsType.DNS_TYPE_SRV]: 'SRV',
  [DnsType.DNS_TYPE_TEXT]: 'TXT',
};

function readWideString(addr: number | bigint, maxBytes = 1024): string {
  const value = typeof addr === 'bigint' ? Number(addr) : addr;
  if (!value) return '';
  const buf = Buffer.from(toArrayBuffer(value as Pointer, 0, maxBytes));
  let end = buf.length;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf.readUInt16LE(i) === 0) {
      end = i;
      break;
    }
  }
  return buf.subarray(0, end).toString('utf16le');
}

function formatIpv4(buf: Buffer, offset: number): string {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

function formatIpv6(buf: Buffer, offset: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push(buf.readUInt16BE(offset + i * 2).toString(16));
  }
  return groups
    .join(':')
    .replace(/(?:^|:)(?:0(?::|$)){2,}/, '::')
    .replace(/:{3,}/, '::');
}

// Record header is fixed 32 bytes; data union is bounded by wDataLength + a few
// extra bytes for the union envelope. Read the header first to learn the size,
// then read just enough additional bytes to parse the type-specific payload.
function parseRecord(addr: Pointer): { record: ParsedRecord; next: Pointer | null } {
  const head = Buffer.from(toArrayBuffer(addr, 0, 32));
  const pNext = Number(head.readBigUInt64LE(0));
  const wType = head.readUInt16LE(16);
  const wDataLength = head.readUInt16LE(18);
  const dwTtl = head.readUInt32LE(24);
  const typeName = TYPE_NAMES[wType] ?? `TYPE${wType}`;

  // Data union sizes by type (header + payload + a small safety pad)
  const dataReadSize = (() => {
    switch (wType) {
      case DnsType.DNS_TYPE_A:
        return 40;
      case DnsType.DNS_TYPE_AAAA:
        return 48;
      case DnsType.DNS_TYPE_CNAME:
      case DnsType.DNS_TYPE_NS:
      case DnsType.DNS_TYPE_PTR:
        return 48;
      case DnsType.DNS_TYPE_MX:
        return 48;
      case DnsType.DNS_TYPE_SRV:
        return 56;
      case DnsType.DNS_TYPE_SOA:
        return 72;
      case DnsType.DNS_TYPE_TEXT:
        return 40 + Math.min(wDataLength, 64);
      case DnsType.DNS_TYPE_CAA:
        return 56;
      default:
        return 32;
    }
  })();

  const buf = Buffer.from(toArrayBuffer(addr, 0, dataReadSize));

  let display = '';
  switch (wType) {
    case DnsType.DNS_TYPE_A:
      display = formatIpv4(buf, 32);
      break;
    case DnsType.DNS_TYPE_AAAA:
      display = formatIpv6(buf, 32);
      break;
    case DnsType.DNS_TYPE_CNAME:
    case DnsType.DNS_TYPE_NS:
    case DnsType.DNS_TYPE_PTR:
      display = readWideString(buf.readBigUInt64LE(32));
      break;
    case DnsType.DNS_TYPE_MX: {
      const exchange = readWideString(buf.readBigUInt64LE(32));
      const preference = buf.readUInt16LE(40);
      display = `${String(preference).padStart(3)} ${exchange}`;
      break;
    }
    case DnsType.DNS_TYPE_SRV: {
      const target = readWideString(buf.readBigUInt64LE(32));
      const priority = buf.readUInt16LE(40);
      const weight = buf.readUInt16LE(42);
      const port = buf.readUInt16LE(44);
      display = `${priority}/${weight} :${port} ${target}`;
      break;
    }
    case DnsType.DNS_TYPE_SOA: {
      const primary = readWideString(buf.readBigUInt64LE(32));
      const admin = readWideString(buf.readBigUInt64LE(40));
      const serial = buf.readUInt32LE(48);
      display = `${primary} admin=${admin} serial=${serial}`;
      break;
    }
    case DnsType.DNS_TYPE_TEXT: {
      const count = buf.readUInt32LE(32);
      const parts: string[] = [];
      const usable = Math.min(count, Math.floor((dataReadSize - 40) / 8), 8);
      for (let i = 0; i < usable; i++) {
        const strPtr = buf.readBigUInt64LE(40 + i * 8);
        parts.push(`"${readWideString(strPtr)}"`);
      }
      display = parts.join(' ');
      break;
    }
    default:
      display = `(${wDataLength} bytes)`;
  }

  return {
    next: pNext !== 0 ? (pNext as Pointer) : null,
    record: { display, ttl: dwTtl, type: wType, typeName },
  };
}

function query(name: string, type: number): ParsedRecord[] {
  const wide = Buffer.from(name + '\0', 'utf16le');
  const out = Buffer.alloc(8);
  const status = Dnsapi.DnsQuery_W(wide.ptr, type, DnsQueryOption.DNS_QUERY_STANDARD, null, out.ptr, null);
  if (status !== 0) return [];

  const head = read.ptr(out.ptr) as Pointer | null;
  if (!head) return [];

  const records: ParsedRecord[] = [];
  let current: Pointer | null = head;
  while (current) {
    const { record, next } = parseRecord(current);
    if (record.type === type) records.push(record);
    current = next;
  }

  Dnsapi.DnsRecordListFree(head, DnsFreeType.DnsFreeRecordList);
  return records;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function colorFor(typeName: string): string {
  return COLOR[typeName] ?? '\x1b[37m';
}

function formatTtl(ttl: number): string {
  if (ttl >= 86400) return `${(ttl / 86400).toFixed(1).replace(/\.0$/, '')}d`;
  if (ttl >= 3600) return `${(ttl / 3600).toFixed(1).replace(/\.0$/, '')}h`;
  if (ttl >= 60) return `${(ttl / 60).toFixed(0)}m`;
  return `${ttl}s`;
}

const RECORD_TYPES: Array<[string, number]> = [
  ['A', DnsType.DNS_TYPE_A],
  ['AAAA', DnsType.DNS_TYPE_AAAA],
  ['CNAME', DnsType.DNS_TYPE_CNAME],
  ['MX', DnsType.DNS_TYPE_MX],
  ['NS', DnsType.DNS_TYPE_NS],
  ['SOA', DnsType.DNS_TYPE_SOA],
  ['TXT', DnsType.DNS_TYPE_TEXT],
  ['CAA', DnsType.DNS_TYPE_CAA],
];

const DOMAINS = ['github.com', 'cloudflare.com', 'wikipedia.org', 'bun.sh'];

console.log();
console.log(`  ${BOLD}🌐 DNS Resolution Tree${RESET}`);
console.log(`  ${DIM}Walking ${RECORD_TYPES.length} record types across ${DOMAINS.length} domains via DnsQuery_W${RESET}\n`);

for (const domain of DOMAINS) {
  console.log(`  ${COLOR.HEAD}${domain}${RESET}`);

  const sections: Array<{ name: string; records: ParsedRecord[] }> = [];
  for (const [typeName, typeCode] of RECORD_TYPES) {
    const records = query(domain, typeCode);
    if (records.length > 0) sections.push({ name: typeName, records });
  }

  for (let s = 0; s < sections.length; s++) {
    const isLastSection = s === sections.length - 1;
    const sectionPrefix = isLastSection ? '└─' : '├─';
    const continuationPrefix = isLastSection ? '   ' : '│  ';
    const section = sections[s];
    const colorCode = colorFor(section.name);

    process.stdout.write(`  ${DIM}${sectionPrefix}${RESET} ${colorCode}${BOLD}${section.name}${RESET} ${DIM}(${section.records.length})${RESET}\n`);
    await delay(40);

    for (let r = 0; r < section.records.length; r++) {
      const isLastRecord = r === section.records.length - 1;
      const recordPrefix = isLastRecord ? '└─' : '├─';
      const record = section.records[r];
      const ttlLabel = `${DIM}ttl ${formatTtl(record.ttl).padStart(4)}${RESET}`;
      console.log(`  ${DIM}${continuationPrefix}${recordPrefix}${RESET} ${ttlLabel}  ${colorCode}${record.display}${RESET}`);
      await delay(25);
    }
  }

  if (sections.length === 0) {
    console.log(`  ${DIM}└─ (no records)${RESET}`);
  }
  console.log();
}

console.log(`  ${DIM}Tip: change DOMAINS or RECORD_TYPES in the source to explore other zones.${RESET}\n`);
