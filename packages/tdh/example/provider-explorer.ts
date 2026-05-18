/**
 * ETW Provider & Event-Schema Explorer
 *
 * A thorough, no-privilege diagnostic that walks the Trace Data Helper to
 * answer "what is every instrumented subsystem on this machine, and what does
 * each event actually look like?" — entirely from FFI, with zero ETW session.
 *
 * It enumerates every ETW provider registered on the box, classifies each as
 * manifest- or MOF-based, then drills into a well-known provider:
 *   - its keyword / level / channel / task / opcode field metadata, and
 *   - its manifest event templates, decoding every property's in/out type.
 *
 * Output is a set of aligned, color-coded tables: a provider census, a
 * field-metadata breakdown, and a per-event property schema — the kind of
 * report you would otherwise need a kernel debugger or PerfView to produce.
 *
 * APIs demonstrated (Tdh):
 *   - TdhEnumerateProviders                 (every provider + GUID + schema source)
 *   - TdhEnumerateProviderFieldInformation  (keywords/levels/channels/tasks/opcodes)
 *   - TdhEnumerateManifestProviderEvents    (event templates declared in a manifest)
 *   - TdhGetManifestEventInformation        (full TRACE_EVENT_INFO for one event)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/provider-explorer.ts
 */
import Tdh, { EVENT_FIELD_TYPE, TDH_IN_TYPE, TDH_OUT_TYPE } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

const ERROR_SUCCESS = 0;
const ERROR_INSUFFICIENT_BUFFER = 122;

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const MAGENTA = '\x1b[95m';
const BLUE = '\x1b[94m';
const GREY = '\x1b[90m';

// Enable ANSI escape processing so colors render in legacy consoles too.
const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const modeBuffer = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuffer.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuffer.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

Tdh.Preload(['TdhEnumerateProviders', 'TdhEnumerateProviderFieldInformation', 'TdhEnumerateManifestProviderEvents', 'TdhGetManifestEventInformation']);

/** Read a NUL-terminated UTF-16LE string at byteOffset within buffer. */
function readWide(buffer: Buffer, byteOffset: number): string {
  if (byteOffset <= 0 || byteOffset >= buffer.length) return '';
  let result = '';
  for (let i = byteOffset; i + 1 < buffer.length; i += 2) {
    const code = buffer.readUInt16LE(i);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

/** Format a 16-byte little-endian GUID buffer as the canonical brace string. */
function formatGuid(buffer: Buffer, byteOffset: number): string {
  const d1 = buffer.readUInt32LE(byteOffset).toString(16).padStart(8, '0');
  const d2 = buffer
    .readUInt16LE(byteOffset + 4)
    .toString(16)
    .padStart(4, '0');
  const d3 = buffer
    .readUInt16LE(byteOffset + 6)
    .toString(16)
    .padStart(4, '0');
  const d4 = buffer.subarray(byteOffset + 8, byteOffset + 10).toString('hex');
  const d5 = buffer.subarray(byteOffset + 10, byteOffset + 16).toString('hex');
  return `{${d1}-${d2}-${d3}-${d4}-${d5}}`;
}

const inTypeName = new Map<number, string>(
  Object.entries(TDH_IN_TYPE)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [v as number, k]),
);
const outTypeName = new Map<number, string>(
  Object.entries(TDH_OUT_TYPE)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [v as number, k]),
);

/** Two-call sizing wrapper around a (buffer, *size) TDH enumerator. */
function sized(call: (buffer: Buffer | null, size: Buffer) => number): { status: number; buffer: Buffer } {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(0, 0);
  let status = call(null, size);
  const needed = size.readUInt32LE(0);
  if (status !== ERROR_INSUFFICIENT_BUFFER || needed === 0) return { status, buffer: Buffer.alloc(0) };
  const buffer = Buffer.alloc(needed);
  status = call(buffer, size);
  return { status, buffer };
}

console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║              ETW Provider & Event-Schema Explorer (TDH)              ║${RESET}`);
console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${RESET}\n`);

// ── 1. Provider census ──────────────────────────────────────────────────────
const providers = sized((b, s) => Tdh.TdhEnumerateProviders(b ? b.ptr : null, s.ptr));
if (providers.status !== ERROR_SUCCESS) {
  console.error(`TdhEnumerateProviders failed with status ${providers.status}`);
  process.exit(1);
}

const providerCount = providers.buffer.readUInt32LE(0);
interface ProviderRow {
  name: string;
  guid: string;
  guidBytes: Buffer;
  schemaSource: number;
}
const rows: ProviderRow[] = [];
for (let i = 0; i < providerCount; i++) {
  const base = 8 + i * 24; // skip NumberOfProviders + Reserved
  const guidBytes = providers.buffer.subarray(base, base + 16);
  const schemaSource = providers.buffer.readUInt32LE(base + 16);
  const nameOffset = providers.buffer.readUInt32LE(base + 20);
  rows.push({
    name: readWide(providers.buffer, nameOffset) || '(unnamed)',
    guid: formatGuid(providers.buffer, base),
    guidBytes: Buffer.from(guidBytes), // copy out — buffer is reused below
    schemaSource,
  });
}
rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

const manifestCount = rows.filter((r) => r.schemaSource === 0).length;
const mofCount = providerCount - manifestCount;
console.log(`${BOLD}Registered providers:${RESET} ${GREEN}${providerCount}${RESET}   ` + `${DIM}(${MAGENTA}${manifestCount}${RESET}${DIM} manifest · ${YELLOW}${mofCount}${RESET}${DIM} MOF/WBEM)${RESET}\n`);

console.log(`${BOLD}${GREY} #     SRC   PROVIDER                                              GUID${RESET}`);
console.log(`${GREY}${'─'.repeat(118)}${RESET}`);
const preview = rows.filter((r) => r.name !== '(unnamed)').slice(0, 28);
for (let i = 0; i < preview.length; i++) {
  const row = preview[i]!;
  const tag = row.schemaSource === 0 ? `${MAGENTA}MAN${RESET}` : `${YELLOW}MOF${RESET}`;
  const idx = String(i + 1).padStart(3, ' ');
  const name = row.name.length > 50 ? row.name.slice(0, 49) + '…' : row.name.padEnd(50, ' ');
  console.log(` ${GREY}${idx}${RESET}   ${tag}   ${CYAN}${name}${RESET}  ${DIM}${row.guid}${RESET}`);
}
console.log(`${GREY}${'─'.repeat(118)}${RESET}`);
console.log(`${DIM}…showing 28 of ${rows.length} named providers (alphabetical).${RESET}\n`);

// ── 2. Drill into a well-known provider ─────────────────────────────────────
const target = rows.find((r) => r.name === 'Microsoft-Windows-Kernel-Process') ?? rows.find((r) => r.schemaSource === 0 && r.name.startsWith('Microsoft-Windows-Kernel')) ?? rows.find((r) => r.schemaSource === 0 && r.name !== '(unnamed)')!;

console.log(`${BOLD}${CYAN}▼ Drill-down: ${target.name}${RESET}`);
console.log(`${DIM}  ${target.guid}${RESET}\n`);

const guidBuffer = target.guidBytes;
const fieldKinds: [EVENT_FIELD_TYPE, string][] = [
  [EVENT_FIELD_TYPE.EventKeywordInformation, 'Keywords'],
  [EVENT_FIELD_TYPE.EventLevelInformation, 'Levels'],
  [EVENT_FIELD_TYPE.EventChannelInformation, 'Channels'],
  [EVENT_FIELD_TYPE.EventTaskInformation, 'Tasks'],
  [EVENT_FIELD_TYPE.EventOpcodeInformation, 'Opcodes'],
];

for (const [fieldType, label] of fieldKinds) {
  const info = sized((b, s) => Tdh.TdhEnumerateProviderFieldInformation(guidBuffer.ptr, fieldType, b ? b.ptr : null, s.ptr));
  if (info.status !== ERROR_SUCCESS || info.buffer.length === 0) {
    console.log(`  ${BOLD}${label}${RESET} ${GREY}— none defined${RESET}`);
    continue;
  }
  const elementCount = info.buffer.readUInt32LE(0);
  console.log(`  ${BOLD}${BLUE}${label}${RESET} ${DIM}(${elementCount})${RESET}`);
  for (let i = 0; i < Math.min(elementCount, 10); i++) {
    const fieldBase = 8 + i * 16; // skip NumberOfElements + FieldType
    const nameOffset = info.buffer.readUInt32LE(fieldBase);
    const descOffset = info.buffer.readUInt32LE(fieldBase + 4);
    const value = info.buffer.readBigUInt64LE(fieldBase + 8);
    const fieldName = readWide(info.buffer, nameOffset);
    const description = readWide(info.buffer, descOffset);
    const valueText = `0x${value.toString(16)}`;
    console.log(`    ${GREEN}${fieldName.padEnd(28, ' ')}${RESET} ${GREY}${valueText.padEnd(20, ' ')}${RESET} ${DIM}${description}${RESET}`);
  }
  if (elementCount > 10) console.log(`    ${DIM}…and ${elementCount - 10} more${RESET}`);
  console.log('');
}

// ── 3. Event templates + per-event property schema ──────────────────────────
const events = sized((b, s) => Tdh.TdhEnumerateManifestProviderEvents(guidBuffer.ptr, b ? b.ptr : null, s.ptr));
if (events.status === ERROR_SUCCESS && events.buffer.length >= 8) {
  const eventCount = events.buffer.readUInt32LE(0);
  console.log(`  ${BOLD}${BLUE}Event templates${RESET} ${DIM}(${eventCount})${RESET}\n`);

  const shown = Math.min(eventCount, 8);
  for (let i = 0; i < shown; i++) {
    // EVENT_DESCRIPTOR EventDescriptorsArray[] starts at +8, each 16 bytes.
    const descBase = 8 + i * 16;
    const eventDescriptor = Buffer.from(events.buffer.subarray(descBase, descBase + 16));
    const eventId = eventDescriptor.readUInt16LE(0);
    const version = eventDescriptor.readUInt8(2);
    const level = eventDescriptor.readUInt8(4);
    const opcode = eventDescriptor.readUInt8(5);

    const tei = sized((b, s) => Tdh.TdhGetManifestEventInformation(guidBuffer.ptr, eventDescriptor.ptr, b ? b.ptr : null, s.ptr));
    const headerLine = `  ${BOLD}Event ${YELLOW}${eventId}${RESET}${BOLD} v${version}${RESET} ${GREY}level=${level} opcode=${opcode}${RESET}`;
    if (tei.status !== ERROR_SUCCESS || tei.buffer.length < 112) {
      console.log(`${headerLine}  ${DIM}(no manifest info: status ${tei.status})${RESET}`);
      continue;
    }
    const info = tei.buffer;
    const taskName = readWide(info, info.readUInt32LE(68));
    const opcodeName = readWide(info, info.readUInt32LE(72));
    const message = readWide(info, info.readUInt32LE(76));
    const topLevelCount = info.readUInt32LE(104);

    const taskTag = taskName ? ` ${MAGENTA}${taskName}${RESET}` : '';
    const opTag = opcodeName ? `${GREY}/${opcodeName}${RESET}` : '';
    console.log(`${headerLine}${taskTag}${opTag}`);
    if (message) console.log(`    ${DIM}“${message.length > 80 ? message.slice(0, 79) + '…' : message}”${RESET}`);
    if (topLevelCount === 0) {
      console.log(`    ${GREY}(no payload properties)${RESET}\n`);
      continue;
    }

    console.log(`    ${BOLD}${GREY}FIELD                          IN-TYPE                      OUT-TYPE${RESET}`);
    for (let p = 0; p < Math.min(topLevelCount, 12); p++) {
      const propBase = 112 + p * 24; // EventPropertyInfoArray
      const nameOffset = info.readUInt32LE(propBase + 4);
      const inType = info.readUInt16LE(propBase + 8);
      const outType = info.readUInt16LE(propBase + 10);
      const propName = readWide(info, nameOffset) || `(field ${p})`;
      const inLabel = inTypeName.get(inType)?.replace('TDH_INTYPE_', '') ?? `#${inType}`;
      const outLabel = outType === TDH_OUT_TYPE.TDH_OUTTYPE_NULL ? '—' : (outTypeName.get(outType)?.replace('TDH_OUTTYPE_', '') ?? `#${outType}`);
      console.log(`    ${GREEN}${propName.padEnd(30, ' ').slice(0, 30)}${RESET} ${CYAN}${inLabel.padEnd(28, ' ')}${RESET} ${BLUE}${outLabel}${RESET}`);
    }
    if (topLevelCount > 12) console.log(`    ${DIM}…and ${topLevelCount - 12} more fields${RESET}`);
    console.log('');
  }
  if (eventCount > shown) console.log(`  ${DIM}…and ${eventCount - shown} more event templates${RESET}\n`);
} else {
  console.log(`  ${GREY}No manifest event templates for this provider (status ${events.status}).${RESET}\n`);
}

console.log(`${BOLD}${GREEN}✓ Explored ${providerCount} providers — all decoding done through tdh.dll FFI.${RESET}\n`);
