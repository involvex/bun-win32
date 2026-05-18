/**
 * Crash Report Forensics
 *
 * A complete, aligned forensic walk of every Windows Error Reporting (WER)
 * report still on this machine. It opens all four WER report stores (per-user
 * queue/archive and machine-wide queue/archive), counts the reports in each,
 * measures the on-disk footprint, and enumerates every report key — the
 * descriptive bucket string WER assigns each crash/hang/event — then attempts
 * to pull each report's event name from its V2 metadata record. The output is
 * a structured dossier with human-readable sizes, per-store breakdowns, and a
 * grand-total summary. Everything is read-only; nothing is uploaded or purged.
 *
 * APIs demonstrated (Wer):
 *   - WerStoreOpen / WerStoreClose            (open/close a report store)
 *   - WerStoreGetReportCount                  (reports in the store)
 *   - WerStoreGetSizeOnDisk                   (store footprint, bytes)
 *   - WerStoreGetFirstReportKey / ...NextReportKey  (enumerate report keys)
 *   - WerStoreQueryReportMetadataV2           (per-report metadata record)
 *   - WerFreeString                           (release a returned key string)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/crash-report-forensics.ts
 */
import { read, toArrayBuffer, type Pointer } from 'bun:ffi';

import Wer, { REPORT_STORE_TYPES } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Wer.Preload(['WerStoreOpen', 'WerStoreClose', 'WerStoreGetReportCount', 'WerStoreGetSizeOnDisk', 'WerStoreGetFirstReportKey', 'WerStoreGetNextReportKey', 'WerStoreQueryReportMetadataV2', 'WerFreeString']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

const STD_OUTPUT_HANDLE = -11;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr!)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[38;2;90;220;130m';
const RED = '\x1b[38;2;240;110;110m';
const YELLOW = '\x1b[38;2;235;205;100m';
const CYAN = '\x1b[38;2;120;200;255m';
const VIOLET = '\x1b[38;2;190;150;255m';

const S_OK = 0;
const ERROR_INSUFFICIENT_BUFFER = 0x8007007a | 0;

const hex = (hr: number) => '0x' + (hr >>> 0).toString(16).toUpperCase().padStart(8, '0');

// WER report keys are paths whose final segment is `<Category>_<sub>_<hash>_…`.
// The leading token is the fault bucket family (Kernel, AppCrash, APPCRASH,
// BlueScreen, LiveKernelEvent, …) — a reliable classification with no struct
// decoding required.
function categoryOf(key: string): string {
  const leaf = key.split(/[\\/]/).pop() ?? key;
  const token = leaf.split('_')[0];
  return token || '(uncategorized)';
}

function humanBytes(n: bigint): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(n);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

// Decodes a NUL-terminated UTF-16LE run out of a buffer we own.
function decodeWide(buf: Buffer, byteOffset: number, maxChars: number): string {
  let end = byteOffset;
  const limit = Math.min(buf.length - 1, byteOffset + maxChars * 2);
  while (end < limit && buf.readUInt16LE(end) !== 0) end += 2;
  return buf.subarray(byteOffset, end).toString('utf16le');
}

// Decodes a NUL-terminated UTF-16LE string WER allocated and handed back by
// pointer (the same idiom the shipped `dnsapi` examples use for API-owned
// return strings).
function readWideAt(stringPtr: Pointer, maxBytes = 1024): string {
  const buf = Buffer.from(toArrayBuffer(stringPtr, 0, maxBytes));
  let end = buf.length;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf.readUInt16LE(i) === 0) {
      end = i;
      break;
    }
  }
  return buf.subarray(0, end).toString('utf16le');
}

interface ReportRow {
  key: string;
  eventName: string;
  category: string;
}

interface StoreResult {
  opened: boolean;
  openHr: number;
  count: number;
  sizeOnDisk: bigint;
  rows: ReportRow[];
}

// WER_REPORT_METADATA_V2 begins with WER_REPORT_SIGNATURE, whose first field
// is `WCHAR EventName[...]` at offset 0 — the one field readable without
// depending on the full (large, alignment-sensitive) record layout.
const METADATA_BUFFER_BYTES = 64 * 1024;
const metadataBuf = Buffer.alloc(METADATA_BUFFER_BYTES);

function inspectStore(type: REPORT_STORE_TYPES): StoreResult {
  const result: StoreResult = { opened: false, openHr: 0, count: 0, sizeOnDisk: 0n, rows: [] };

  const storeHandleBuf = Buffer.alloc(8);
  const openHr = Wer.WerStoreOpen(type, storeHandleBuf.ptr!);
  result.openHr = openHr;
  if (openHr !== S_OK) return result;

  const hReportStore = storeHandleBuf.readBigUInt64LE(0);
  result.opened = true;

  const countBuf = Buffer.alloc(4);
  if (Wer.WerStoreGetReportCount(hReportStore, countBuf.ptr!) === S_OK) {
    result.count = countBuf.readUInt32LE(0);
  }

  const sizeBuf = Buffer.alloc(8);
  if (Wer.WerStoreGetSizeOnDisk(hReportStore, sizeBuf.ptr!) === S_OK) {
    result.sizeOnDisk = sizeBuf.readBigUInt64LE(0);
  }

  const keyPtrBuf = Buffer.alloc(8);
  let keyHr = Wer.WerStoreGetFirstReportKey(hReportStore, keyPtrBuf.ptr!);
  while (keyHr === S_OK) {
    // WER wrote a PCWSTR (pointer to its own string) into our 8-byte cell.
    // `read.ptr` returns that raw address; bridge it to a `Pointer` so we can
    // both decode it and hand the exact same pointer back to WerFreeString.
    const keyAddress = read.ptr(keyPtrBuf.ptr!, 0);
    if (!keyAddress) break;
    const keyPtr = keyAddress as Pointer;

    const key = readWideAt(keyPtr);

    // Best-effort: pull the event name from the V2 metadata record. The call
    // often returns ERROR_INSUFFICIENT_BUFFER for the file-name list (which we
    // do not request); EventName sits at offset 0 of the zeroed buffer we own,
    // so reading it is safe regardless of that shortfall.
    let eventName = '';
    metadataBuf.fill(0);
    const keyWide = Buffer.from(key + '\0', 'utf16le');
    const metaHr = Wer.WerStoreQueryReportMetadataV2(hReportStore, keyWide.ptr!, metadataBuf.ptr!);
    if (metaHr === S_OK || metaHr === ERROR_INSUFFICIENT_BUFFER) {
      eventName = decodeWide(metadataBuf, 0, 64);
    }

    result.rows.push({ key, eventName, category: categoryOf(key) });
    Wer.WerFreeString(keyPtr);

    keyHr = Wer.WerStoreGetNextReportKey(hReportStore, keyPtrBuf.ptr!);
  }

  Wer.WerStoreClose(hReportStore);
  return result;
}

const STORES: { label: string; type: REPORT_STORE_TYPES }[] = [
  { label: 'User · Queued (awaiting upload)', type: REPORT_STORE_TYPES.E_STORE_USER_QUEUE },
  { label: 'User · Archived (already sent)', type: REPORT_STORE_TYPES.E_STORE_USER_ARCHIVE },
  { label: 'Machine · Queued (awaiting upload)', type: REPORT_STORE_TYPES.E_STORE_MACHINE_QUEUE },
  { label: 'Machine · Archived (already sent)', type: REPORT_STORE_TYPES.E_STORE_MACHINE_ARCHIVE },
];

console.log(`\n${BOLD}${CYAN}╔═══════════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║          WINDOWS ERROR REPORTING  ·  CRASH REPORT FORENSICS           ║${RESET}`);
console.log(`${BOLD}${CYAN}╚═══════════════════════════════════════════════════════════════════════╝${RESET}\n`);

let grandReports = 0;
let grandBytes = 0n;

for (const store of STORES) {
  const r = inspectStore(store.type);

  if (!r.opened) {
    console.log(`${BOLD}${store.label}${RESET}`);
    console.log(`  ${YELLOW}store unavailable${RESET} ${DIM}(WerStoreOpen → ${hex(r.openHr)})${RESET}\n`);
    continue;
  }

  grandReports += r.count;
  grandBytes += r.sizeOnDisk;

  const heat = r.count === 0 ? GREEN : r.count < 10 ? YELLOW : RED;
  console.log(`${BOLD}${store.label}${RESET}`);
  console.log(`  ${DIM}Reports${RESET}      ${heat}${BOLD}${r.count}${RESET}`);
  console.log(`  ${DIM}On disk${RESET}      ${CYAN}${humanBytes(r.sizeOnDisk)}${RESET} ${DIM}(${r.sizeOnDisk} bytes)${RESET}`);

  if (r.rows.length > 0) {
    // Fault-family histogram — a thorough at-a-glance breakdown.
    const byCategory = new Map<string, number>();
    for (const row of r.rows) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
    const ranked = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
    const widest = Math.max(...ranked.map(([name]) => name.length));
    const peak = ranked[0][1];
    console.log(`  ${DIM}── fault families ──────────────────────────────────────────────────${RESET}`);
    for (const [name, n] of ranked) {
      const bar = '█'.repeat(Math.max(1, Math.round((n / peak) * 28)));
      console.log(`  ${VIOLET}${name.padEnd(widest)}${RESET} ${DIM}${String(n).padStart(4)}${RESET} ${CYAN}${bar}${RESET}`);
    }

    console.log(`  ${DIM}── most recent keys ────────────────────────────────────────────────${RESET}`);
    const shown = r.rows.slice(0, 12);
    for (const [index, row] of shown.entries()) {
      const ordinal = String(index + 1).padStart(3, ' ');
      const tag = row.eventName || row.category;
      const leaf = (row.key.split(/[\\/]/).pop() ?? row.key).slice(0, 78);
      console.log(`  ${DIM}${ordinal}.${RESET} ${VIOLET}${tag}${RESET}`);
      console.log(`       ${DIM}${leaf}${RESET}`);
    }
    if (r.rows.length > shown.length) {
      console.log(`  ${DIM}… and ${r.rows.length - shown.length} more report(s)${RESET}`);
    }
  }
  console.log('');
}

console.log(`${BOLD}${CYAN}─── SUMMARY ───────────────────────────────────────────────────────────${RESET}`);
console.log(`  ${DIM}Total reports on this machine${RESET}   ${BOLD}${grandReports === 0 ? GREEN : YELLOW}${grandReports}${RESET}`);
console.log(`  ${DIM}Total WER footprint${RESET}             ${BOLD}${CYAN}${humanBytes(grandBytes)}${RESET}`);
console.log(`  ${DIM}A clean machine reports 0 queued crashes — every entry here is a real${RESET}`);
console.log(`  ${DIM}fault Windows captured for diagnostic upload.${RESET}\n`);
