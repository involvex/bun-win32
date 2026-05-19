/**
 * Print Capabilities Report
 *
 * An exhaustive, richly-formatted diagnostic that interrogates every installed
 * printer's Print Schema. It enumerates the printer roster, then for the default
 * printer opens a Print Ticket provider, asks the driver for its full
 * PrintCapabilities document (a live Print Schema XML blob, no file touches
 * disk), and decodes every advertised Feature, its selectable Options, and every
 * numeric ParameterDef range into aligned tables. Schema-version support and
 * (on Windows 10 1703+) the richer PrintDeviceCapabilities surface are probed
 * too, with every HRESULT decoded by name.
 *
 * The Print Capabilities / Print Ticket buffers are exchanged through COM
 * `IStream` objects created with `SHCreateMemStream`; the produced XML is read
 * straight back out over the `IStream` vtable (Seek + Read) — pure FFI, no COM
 * apartment marshaling helpers.
 *
 * APIs demonstrated (Prntvpt):
 *   - PTQuerySchemaVersionSupport   (highest Print Schema version a printer supports)
 *   - PTOpenProvider                (open a Print Ticket provider for a queue)
 *   - PTGetPrintCapabilities        (driver-authored PrintCapabilities XML)
 *   - PTGetPrintDeviceCapabilities  (Win10 1703+ PrintDeviceCapabilities XML)
 *   - PTCloseProvider               (release the provider)
 *
 * APIs demonstrated (cross-package):
 *   - Ole32.CoInitialize                       (enter a COM apartment)
 *   - Shlwapi.SHCreateMemStream                (growable in-memory IStream)
 *   - Winspool.GetDefaultPrinterW/EnumPrintersW (printer roster + default)
 *   - Kernel32.GetStdHandle/Get|SetConsoleMode (enable ANSI VT processing)
 *
 * Run: bun run example/print-capabilities-report.ts
 */

import { CFunction, FFIType, type Pointer, read } from 'bun:ffi';

import Prntvpt, { E_PRINTTICKET_FORMAT, E_PRINTCAPABILITIES_FORMAT } from '../index';
import Kernel32 from '@bun-win32/kernel32';
import Ole32 from '@bun-win32/ole32';
import Shlwapi from '@bun-win32/shlwapi';
import Winspool from '@bun-win32/winspool';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const RED = '\x1b[91m';
const MAGENTA = '\x1b[95m';
const BLUE = '\x1b[94m';

const S_OK = 0;
const S_FALSE = 1;

// IStream / IUnknown vtable slots (objidl.h declaration order).
const ISTREAM_READ = 3;
const ISTREAM_SEEK = 5;
const IUNKNOWN_RELEASE = 2;
const STREAM_SEEK_SET = 0;
const STREAM_SEEK_END = 2;

// winspool printer enumeration scope + PRINTER_INFO_4W layout (x64).
const PRINTER_ENUM_LOCAL = 0x0000_0002;
const PRINTER_ENUM_CONNECTIONS = 0x0000_0004;
const PRINTER_INFO_4W_SIZE = 24; // pPrinterName(8) + pServerName(8) + Attributes(4)+pad

/** Enable ANSI escape processing so colors render in Windows Terminal / VS Code. */
function enableVirtualTerminal(): void {
  const STD_OUTPUT_HANDLE = 0xffff_fff5;
  const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
  const handle = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
  const mode = Buffer.alloc(4);
  if (Kernel32.GetConsoleMode(handle, mode.ptr!)) {
    Kernel32.SetConsoleMode(handle, mode.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  }
}

/** A NUL-terminated UTF-16LE buffer for an `LPCWSTR` / `PCWSTR` parameter. */
function wide(text: string): Buffer {
  return Buffer.from(text + '\0', 'utf16le');
}

/** Decodes the Print Ticket HRESULT space to a readable label. */
function hresultName(hr: number): string {
  const u = hr >>> 0;
  if (hr === S_OK) return 'S_OK';
  if (hr === S_FALSE) return 'S_FALSE';
  if (u === E_PRINTTICKET_FORMAT >>> 0) return 'E_PRINTTICKET_FORMAT';
  if (u === E_PRINTCAPABILITIES_FORMAT >>> 0) return 'E_PRINTCAPABILITIES_FORMAT';
  if (u === 0x8007_0005) return 'E_ACCESSDENIED';
  if (u === 0x8007_0002) return 'ERROR_FILE_NOT_FOUND';
  if (u === 0x8007_0709) return 'ERROR_INVALID_PRINTER_NAME';
  if (u === 0x8004_0003) return 'E_PRINTTICKET_FORMAT';
  if (u === 0x8007_0006) return 'E_HANDLE';
  if (u === 0x8007_000e) return 'E_OUTOFMEMORY';
  if (u === 0x8007_0057) return 'E_INVALIDARG';
  return `0x${u.toString(16).padStart(8, '0')}`;
}

const invokers = new Map<string, ReturnType<typeof CFunction>>();

/**
 * Invokes COM vtable slot `slot` on interface pointer `thisPtr`. The implicit
 * `this` is prepended; the bound CFunction is memoized per (method, signature).
 */
function vcall(thisPtr: bigint, slot: number, argTypes: readonly FFIType[], args: readonly unknown[]): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const key = `${method}|${argTypes.join(',')}`;
  let invoke = invokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({ ptr: Number(method) as Pointer, args: [FFIType.u64, ...argTypes], returns: FFIType.i32 });
    invokers.set(key, invoke);
  }
  return invoke(thisPtr, ...args) as number;
}

/** Reads the entire contents written into a memory `IStream` as a UTF-8 string. */
function streamToString(pStream: bigint): string {
  // Seek to the end to learn the total size, then rewind and read it all.
  const newPos = Buffer.alloc(8);
  vcall(pStream, ISTREAM_SEEK, [FFIType.i64, FFIType.u32, FFIType.ptr], [0n, STREAM_SEEK_END, newPos.ptr!]);
  const size = Number(newPos.readBigUInt64LE(0));
  vcall(pStream, ISTREAM_SEEK, [FFIType.i64, FFIType.u32, FFIType.ptr], [0n, STREAM_SEEK_SET, null]);
  if (size === 0) return '';
  const data = Buffer.alloc(size);
  const cbRead = Buffer.alloc(4);
  vcall(pStream, ISTREAM_READ, [FFIType.ptr, FFIType.u32, FFIType.ptr], [data.ptr!, size, cbRead.ptr!]);
  return data.toString('utf8', 0, cbRead.readUInt32LE(0));
}

/** Resolves the full default-printer name via the two-call sizing pattern. */
function defaultPrinterName(): string | null {
  const cch = Buffer.alloc(4);
  Winspool.GetDefaultPrinterW(null, cch.ptr!); // first call: required length
  const need = cch.readUInt32LE(0);
  if (need === 0) return null;
  const buffer = Buffer.alloc(need * 2);
  if (!Winspool.GetDefaultPrinterW(buffer.ptr!, cch.ptr!)) return null;
  return buffer.toString('utf16le').replace(/\0.*$/, '');
}

/** Enumerates installed printer queue names (PRINTER_INFO_4W, names only). */
function printerRoster(): string[] {
  const flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
  const needed = Buffer.alloc(4);
  const returned = Buffer.alloc(4);
  Winspool.EnumPrintersW(flags, null, 4, null, 0, needed.ptr!, returned.ptr!);
  const size = needed.readUInt32LE(0);
  if (size === 0) return [];
  const buffer = Buffer.alloc(size);
  if (!Winspool.EnumPrintersW(flags, null, 4, buffer.ptr!, size, needed.ptr!, returned.ptr!)) return [];
  const count = returned.readUInt32LE(0);
  const base = Number(buffer.ptr!);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const namePtr = Number(buffer.readBigUInt64LE(i * PRINTER_INFO_4W_SIZE));
    if (namePtr === 0) continue;
    const offset = namePtr - base; // strings live inside the same buffer
    if (offset < 0 || offset >= size) continue;
    let end = offset;
    while (end + 1 < size && buffer.readUInt16LE(end) !== 0) end += 2;
    names.push(buffer.toString('utf16le', offset, end));
  }
  return names;
}

/** Distinct top-level Print Schema Feature names found in the document. */
function parseFeatures(xml: string): { name: string; options: string[] }[] {
  const features = new Map<string, Set<string>>();
  const featureRe = /<psf:Feature\s+name="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = featureRe.exec(xml)) !== null) {
    if (!features.has(m[1])) features.set(m[1], new Set());
  }
  // Attribute Options carry the selectable values; group them by nearest Feature.
  const tokenRe = /<psf:(Feature|Option)\s+name="([^"]+)"/g;
  let currentFeature: string | null = null;
  while ((m = tokenRe.exec(xml)) !== null) {
    if (m[1] === 'Feature') currentFeature = m[2];
    else if (currentFeature && m[2]) features.get(currentFeature)?.add(m[2]);
  }
  return [...features.entries()].map(([name, opts]) => ({ name, options: [...opts] })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Numeric ParameterDef names with their declared min/max where present. */
function parseParameters(xml: string): { name: string; min: string; max: string }[] {
  const out: { name: string; min: string; max: string }[] = [];
  const defRe = /<psf:ParameterDef\s+name="([^"]+)"[\s\S]*?<\/psf:ParameterDef>/g;
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(xml)) !== null) {
    const block = m[0];
    const min = /name="ps[fk]:MinValue"[^>]*>\s*<psf:Value[^>]*>([^<]*)/.exec(block);
    const max = /name="ps[fk]:MaxValue"[^>]*>\s*<psf:Value[^>]*>([^<]*)/.exec(block);
    out.push({ name: m[1], min: min ? min[1].trim() : '—', max: max ? max[1].trim() : '—' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const bar = (label: string) => `${BOLD}${BLUE}${'═'.repeat(2)}${RESET} ${BOLD}${label}${RESET}`;
const human = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

function main(): void {
  enableVirtualTerminal();
  const init = Ole32.CoInitialize(null);
  if (init !== S_OK && init !== S_FALSE) {
    console.error(`${RED}CoInitialize failed: ${hresultName(init)}${RESET}`);
    return;
  }

  console.log(`\n${BOLD}${MAGENTA}  PRINT CAPABILITIES REPORT${RESET}  ${DIM}prntvpt.dll · Print Schema${RESET}\n`);

  const roster = printerRoster();
  const def = defaultPrinterName();
  console.log(bar('Installed printers'));
  if (roster.length === 0) console.log(`  ${DIM}(none enumerated)${RESET}`);
  for (const name of roster) {
    const isDefault = def !== null && name === def;
    const marker = isDefault ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
    console.log(`  ${marker} ${isDefault ? BOLD : ''}${name}${RESET}${isDefault ? `  ${GREEN}(default)${RESET}` : ''}`);
  }
  console.log();

  if (def === null) {
    console.log(`${YELLOW}No default printer is configured — nothing to interrogate.${RESET}`);
    return;
  }

  console.log(bar(`Schema version · ${def}`));
  const maxVer = Buffer.alloc(4);
  const qhr = Prntvpt.PTQuerySchemaVersionSupport(wide(def).ptr!, maxVer.ptr!);
  if (qhr === S_OK) {
    console.log(`  Highest Print Schema version supported  ${BOLD}${CYAN}${maxVer.readUInt32LE(0)}${RESET}`);
  } else {
    console.log(`  ${YELLOW}PTQuerySchemaVersionSupport → ${hresultName(qhr)}${RESET}`);
  }
  const requestVersion = qhr === S_OK ? maxVer.readUInt32LE(0) || 1 : 1;
  console.log();

  const phProvider = Buffer.alloc(8);
  const ohr = Prntvpt.PTOpenProvider(wide(def).ptr!, requestVersion, phProvider.ptr!);
  if (ohr !== S_OK) {
    console.log(`${RED}PTOpenProvider failed: ${hresultName(ohr)}${RESET}`);
    return;
  }
  const hProvider = phProvider.readBigUInt64LE(0);

  // Ask the driver for its full PrintCapabilities document (NULL print ticket
  // = capabilities for the driver defaults).
  const capStream = BigInt(Shlwapi.SHCreateMemStream(null, 0));
  const errBstr = Buffer.alloc(8);
  const chr = Prntvpt.PTGetPrintCapabilities(hProvider, 0n, capStream, errBstr.ptr!);
  console.log(bar('PrintCapabilities'));
  console.log(`  PTGetPrintCapabilities → ${chr === S_OK ? GREEN : RED}${hresultName(chr)}${RESET}`);

  if (chr === S_OK) {
    const xml = streamToString(capStream);
    const features = parseFeatures(xml);
    const params = parseParameters(xml);
    console.log(`  Document size                           ${BOLD}${human(Buffer.byteLength(xml))}${RESET}`);
    console.log(`  Features advertised                     ${BOLD}${features.length}${RESET}`);
    console.log(`  Numeric parameters                      ${BOLD}${params.length}${RESET}\n`);

    console.log(`  ${BOLD}Feature${' '.repeat(34)}Options${RESET}`);
    console.log(`  ${DIM}${'─'.repeat(70)}${RESET}`);
    for (const f of features) {
      const label = f.name.padEnd(40).slice(0, 40);
      const opts = f.options.length === 0 ? `${DIM}—${RESET}` : `${CYAN}${f.options.length}${RESET} ${DIM}${f.options.slice(0, 4).join(', ')}${f.options.length > 4 ? ' …' : ''}${RESET}`;
      console.log(`  ${YELLOW}${label}${RESET}  ${opts}`);
    }
    if (params.length > 0) {
      console.log(`\n  ${BOLD}Parameter${' '.repeat(32)}Min${' '.repeat(10)}Max${RESET}`);
      console.log(`  ${DIM}${'─'.repeat(70)}${RESET}`);
      for (const p of params) {
        console.log(`  ${YELLOW}${p.name.padEnd(40).slice(0, 40)}${RESET}  ${p.min.padStart(8)}  ${p.max.padStart(12)}`);
      }
    }
  } else if (errBstr.readBigUInt64LE(0) !== 0n) {
    console.log(`  ${RED}driver error message present (BSTR)${RESET}`);
  }
  console.log();

  // PrintDeviceCapabilities — the richer surface added in Windows 10 1703.
  console.log(bar('PrintDeviceCapabilities (Win10 1703+)'));
  const devStream = BigInt(Shlwapi.SHCreateMemStream(null, 0));
  const dhr = Prntvpt.PTGetPrintDeviceCapabilities(hProvider, 0n, devStream, null);
  if (dhr === S_OK) {
    const xml = streamToString(devStream);
    console.log(`  PTGetPrintDeviceCapabilities → ${GREEN}S_OK${RESET}  (${human(Buffer.byteLength(xml))})`);
    console.log(`  Top-level elements: ${BOLD}${(xml.match(/<psf:Feature\s/g) || []).length}${RESET} features, ${BOLD}${(xml.match(/<psf:Property\s/g) || []).length}${RESET} properties`);
  } else {
    console.log(`  ${DIM}PTGetPrintDeviceCapabilities → ${hresultName(dhr)} (driver may not implement it)${RESET}`);
  }

  vcall(capStream, IUNKNOWN_RELEASE, [], []);
  vcall(devStream, IUNKNOWN_RELEASE, [], []);
  Prntvpt.PTCloseProvider(hProvider);
  console.log(`\n${GREEN}${BOLD}  ✓ Print Schema interrogation complete${RESET}\n`);
}

main();
