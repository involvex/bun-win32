/**
 * DNS Forensics Dashboard
 *
 * Produces a comprehensive forensic report for one or more domains: system
 * resolver configuration, name validity, full record sweeps across every
 * common type, per-query timing, IPv4/IPv6 reachability hints, and email/CAA
 * posture inferred from TXT records. Every field is formatted in aligned
 * tables with human-readable TTLs.
 *
 * Usage:
 *   bun run example/dns-forensics.ts                  # defaults
 *   bun run example/dns-forensics.ts microsoft.com    # one target
 *   bun run example/dns-forensics.ts a.com b.com c.com
 *
 * APIs demonstrated:
 *   - DnsQueryConfig                (configured DNS server list, host name)
 *   - DnsValidateName_W             (RFC-style DNS name validation)
 *   - DnsQuery_W                    (synchronous lookup by name + type)
 *   - DnsRecordListFree             (free returned record linked list)
 *   - DnsNameCompare_W              (case-insensitive trailing-dot-aware compare)
 *
 * Run: bun run example/dns-forensics.ts
 */

import { read, toArrayBuffer, type Pointer } from 'bun:ffi';

import Dnsapi, { DnsConfigType, DnsFreeType, DnsNameFormat, DnsQueryOption, DnsType } from '../index';

Dnsapi.Preload();

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const GREY = '\x1b[90m';

interface RecordEntry {
  display: string;
  raw: string;
  ttl: number;
  type: number;
  typeName: string;
}

interface QueryResult {
  durationMs: number;
  records: RecordEntry[];
  status: number;
}

const QUERY_TYPES: Array<{ code: number; name: string }> = [
  { code: DnsType.DNS_TYPE_A, name: 'A' },
  { code: DnsType.DNS_TYPE_AAAA, name: 'AAAA' },
  { code: DnsType.DNS_TYPE_CNAME, name: 'CNAME' },
  { code: DnsType.DNS_TYPE_NS, name: 'NS' },
  { code: DnsType.DNS_TYPE_SOA, name: 'SOA' },
  { code: DnsType.DNS_TYPE_MX, name: 'MX' },
  { code: DnsType.DNS_TYPE_TEXT, name: 'TXT' },
  { code: DnsType.DNS_TYPE_SRV, name: 'SRV' },
  { code: DnsType.DNS_TYPE_PTR, name: 'PTR' },
];

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

function ttlLabel(ttl: number): string {
  if (ttl >= 86400) {
    const days = ttl / 86400;
    return `${days.toFixed(days < 10 ? 1 : 0)}d`;
  }
  if (ttl >= 3600) return `${(ttl / 3600).toFixed(1).replace(/\.0$/, '')}h`;
  if (ttl >= 60) return `${Math.round(ttl / 60)}m`;
  return `${ttl}s`;
}

function query(name: string, typeCode: number, typeName: string): QueryResult {
  const wide = Buffer.from(name + '\0', 'utf16le');
  const out = Buffer.alloc(8);
  const start = performance.now();
  const status = Dnsapi.DnsQuery_W(wide.ptr, typeCode, DnsQueryOption.DNS_QUERY_STANDARD, null, out.ptr, null);
  const durationMs = performance.now() - start;

  if (status !== 0) return { durationMs, records: [], status };

  const head = read.ptr(out.ptr) as Pointer | null;
  if (!head) return { durationMs, records: [], status: 0 };

  const records: RecordEntry[] = [];
  let cur: Pointer | null = head;

  while (cur) {
    const header: Buffer = Buffer.from(toArrayBuffer(cur, 0, 32));
    const pNext: number = Number(header.readBigUInt64LE(0));
    const wType: number = header.readUInt16LE(16);
    const wDataLength: number = header.readUInt16LE(18);
    const ttl: number = header.readUInt32LE(24);

    if (wType === typeCode) {
      const dataSize = (() => {
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
            return 40 + Math.min(wDataLength, 128);
          default:
            return 32;
        }
      })();
      const buf = Buffer.from(toArrayBuffer(cur, 0, dataSize));

      let display = '';
      let raw = '';
      switch (wType) {
        case DnsType.DNS_TYPE_A:
          display = raw = formatIpv4(buf, 32);
          break;
        case DnsType.DNS_TYPE_AAAA:
          display = raw = formatIpv6(buf, 32);
          break;
        case DnsType.DNS_TYPE_CNAME:
        case DnsType.DNS_TYPE_NS:
        case DnsType.DNS_TYPE_PTR:
          display = raw = readWideString(buf.readBigUInt64LE(32));
          break;
        case DnsType.DNS_TYPE_MX: {
          const exchange = readWideString(buf.readBigUInt64LE(32));
          const pref = buf.readUInt16LE(40);
          display = `${String(pref).padStart(3)}  ${exchange}`;
          raw = `${pref} ${exchange}`;
          break;
        }
        case DnsType.DNS_TYPE_SRV: {
          const target = readWideString(buf.readBigUInt64LE(32));
          const priority = buf.readUInt16LE(40);
          const weight = buf.readUInt16LE(42);
          const port = buf.readUInt16LE(44);
          display = `prio=${priority} weight=${weight} port=${port}  ${target}`;
          raw = `${priority} ${weight} ${port} ${target}`;
          break;
        }
        case DnsType.DNS_TYPE_SOA: {
          const primary = readWideString(buf.readBigUInt64LE(32));
          const admin = readWideString(buf.readBigUInt64LE(40));
          const serial = buf.readUInt32LE(48);
          const refresh = buf.readUInt32LE(52);
          const retry = buf.readUInt32LE(56);
          const expire = buf.readUInt32LE(60);
          const minimum = buf.readUInt32LE(64);
          display = `${primary}  (admin ${admin})\n        serial=${serial}  refresh=${refresh}s  retry=${retry}s  expire=${expire}s  min=${minimum}s`;
          raw = `${primary} ${admin} ${serial}`;
          break;
        }
        case DnsType.DNS_TYPE_TEXT: {
          const count = buf.readUInt32LE(32);
          const parts: string[] = [];
          const usable = Math.min(count, Math.floor((dataSize - 40) / 8), 12);
          for (let i = 0; i < usable; i++) {
            const strPtr = buf.readBigUInt64LE(40 + i * 8);
            parts.push(readWideString(strPtr));
          }
          raw = parts.join('');
          display = parts.map((p) => `"${p}"`).join(' ');
          break;
        }
        default:
          display = `(${wDataLength}-byte payload)`;
          raw = display;
      }

      records.push({ display, raw, ttl, type: wType, typeName });
    }

    cur = pNext !== 0 ? (pNext as Pointer) : null;
  }

  Dnsapi.DnsRecordListFree(head, DnsFreeType.DnsFreeRecordList);
  return { durationMs, records, status: 0 };
}

function reportConfiguredServers(): { hostName: string; servers: string[] } {
  let hostName = '(unknown)';
  let servers: string[] = [];

  // Host name via DnsQueryConfig
  const hostBuf = Buffer.alloc(256);
  const hostLen = Buffer.alloc(4);
  hostLen.writeUInt32LE(256, 0);
  const hostStatus = Dnsapi.DnsQueryConfig(DnsConfigType.DnsConfigFullHostName_W, 0, null, null, hostBuf.ptr, hostLen.ptr);
  if (hostStatus === 0) {
    let end = 0;
    for (let i = 0; i + 1 < 256; i += 2) {
      if (hostBuf.readUInt16LE(i) === 0) {
        end = i;
        break;
      }
    }
    if (end > 0) hostName = hostBuf.subarray(0, end).toString('utf16le');
  }

  // DNS server list — first call with NULL buffer to learn required size
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(0, 0);
  Dnsapi.DnsQueryConfig(DnsConfigType.DnsConfigDnsServerList, 0, null, null, null, sizeBuf.ptr);
  const required = sizeBuf.readUInt32LE(0);

  if (required > 0) {
    const listBuf = Buffer.alloc(required);
    sizeBuf.writeUInt32LE(required, 0);
    const status = Dnsapi.DnsQueryConfig(DnsConfigType.DnsConfigDnsServerList, 0, null, null, listBuf.ptr, sizeBuf.ptr);
    if (status === 0) {
      // IP4_ARRAY: DWORD AddrCount followed by AddrCount * DWORD addresses
      const count = listBuf.readUInt32LE(0);
      for (let i = 0; i < count; i++) {
        const offset = 4 + i * 4;
        servers.push(`${listBuf[offset]}.${listBuf[offset + 1]}.${listBuf[offset + 2]}.${listBuf[offset + 3]}`);
      }
    }
  }

  return { hostName, servers };
}

function validateName(name: string): { code: number; verdict: string } {
  const wide = Buffer.from(name + '\0', 'utf16le');
  const code = Dnsapi.DnsValidateName_W(wide.ptr, DnsNameFormat.DnsNameDomain);
  // DnsValidateName returns 0 for valid; well-known non-zero codes describe specific issues.
  const verdicts: Record<number, string> = {
    0: 'valid RFC name',
    9560: 'non-RFC characters (still resolvable on most servers)',
    9563: 'numeric-only name',
    9564: 'invalid character in name',
    123: 'malformed (ERROR_INVALID_NAME)',
  };
  return { code, verdict: verdicts[code] ?? `code ${code}` };
}

function compareNames(a: string, b: string): boolean {
  const wa = Buffer.from(a + '\0', 'utf16le');
  const wb = Buffer.from(b + '\0', 'utf16le');
  return Dnsapi.DnsNameCompare_W(wa.ptr, wb.ptr) !== 0;
}

function formatSection(title: string, color: string, lines: string[]): void {
  console.log(`  ${color}${BOLD}${title}${RESET}`);
  if (lines.length === 0) {
    console.log(`    ${GREY}(none)${RESET}`);
    return;
  }
  for (const line of lines) console.log(line);
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

const cliArgs = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const TARGETS = cliArgs.length > 0 ? cliArgs : ['microsoft.com', 'github.com', 'cloudflare.com'];

console.log();
console.log(`  ${BOLD}DNS Forensics Dashboard${RESET}`);
console.log(`  ${GREY}Built on dnsapi.dll · DnsQuery_W / DnsQueryConfig / DnsValidateName_W${RESET}\n`);

const { hostName, servers } = reportConfiguredServers();

console.log(`  ${BOLD}Resolver Configuration${RESET}`);
console.log(`    ${padRight('Local hostname', 24)}${CYAN}${hostName}${RESET}`);
if (servers.length === 0) {
  console.log(`    ${padRight('Configured servers', 24)}${GREY}(none reported)${RESET}`);
} else {
  console.log(`    ${padRight('Configured servers', 24)}${CYAN}${servers.join(', ')}${RESET}`);
}
console.log();

for (const target of TARGETS) {
  const { code, verdict } = validateName(target);
  const verdictColor = code === 0 ? GREEN : YELLOW;

  console.log(`  ${BOLD}${MAGENTA}═══ ${target} ═══${RESET}`);
  console.log(`    ${padRight('Name validity', 24)}${verdictColor}${verdict}${RESET} ${GREY}(code ${code})${RESET}`);

  // Apex vs www comparison via DnsNameCompare_W
  const apexEqualsTrailingDot = compareNames(target, `${target}.`);
  console.log(`    ${padRight('Trailing-dot equiv.', 24)}${apexEqualsTrailingDot ? GREEN : RED}${apexEqualsTrailingDot ? 'yes' : 'no'}${RESET} ${GREY}(DnsNameCompare_W "${target}" vs "${target}.")${RESET}\n`);

  let totalRecords = 0;
  let totalDuration = 0;

  for (const { code: typeCode, name: typeName } of QUERY_TYPES) {
    const result = query(target, typeCode, typeName);
    totalDuration += result.durationMs;
    totalRecords += result.records.length;

    const timing = `${DIM}${result.durationMs.toFixed(1).padStart(6)}ms${RESET}`;

    if (result.records.length === 0) {
      const tag = result.status !== 0 ? `${GREY}status ${result.status}${RESET}` : `${GREY}no records${RESET}`;
      console.log(`    ${padRight(typeName, 6)} ${timing}   ${tag}`);
      continue;
    }

    formatSection(
      `${typeName}  ${timing}`,
      CYAN,
      result.records.map((r) => {
        const ttlText = `${GREY}${padRight(`ttl ${ttlLabel(r.ttl).padStart(5)}`, 11)}${RESET}`;
        return `        ${ttlText}  ${r.display}`;
      }),
    );
  }

  const spfRecords = (() => {
    const txt = query(target, DnsType.DNS_TYPE_TEXT, 'TXT').records;
    return txt.filter((r) => r.raw.toLowerCase().startsWith('v=spf1'));
  })();

  console.log();
  console.log(`    ${BOLD}Email & Trust Posture${RESET}`);
  console.log(`      ${padRight('SPF records', 22)}${spfRecords.length > 0 ? GREEN : YELLOW}${spfRecords.length > 0 ? 'present' : 'absent'}${RESET}`);
  for (const spf of spfRecords) {
    console.log(`        ${DIM}${spf.raw}${RESET}`);
  }

  const dmarcResult = query(`_dmarc.${target}`, DnsType.DNS_TYPE_TEXT, 'TXT');
  console.log(`      ${padRight('DMARC policy', 22)}${dmarcResult.records.length > 0 ? GREEN : YELLOW}${dmarcResult.records.length > 0 ? 'present' : 'absent'}${RESET}`);
  for (const r of dmarcResult.records) {
    console.log(`        ${DIM}${r.raw}${RESET}`);
  }

  console.log();
  console.log(`    ${DIM}Total: ${totalRecords} records across ${QUERY_TYPES.length} types in ${totalDuration.toFixed(1)}ms${RESET}`);
  console.log();
}

console.log(`  ${GREY}Tip: pass one or more domains as arguments to focus the report.${RESET}\n`);
