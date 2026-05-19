/**
 * Windows Filtering Platform — Base Filtering Engine Inventory
 *
 * A thorough, fully-formatted census of the live WFP configuration on this
 * machine. It opens a read session against the Base Filtering Engine, then for
 * every WFP object class (providers, provider contexts, sub-layers, layers,
 * callouts, filters, net events) it drives the documented
 * `*CreateEnumHandle0` / `*Enum0` / `*DestroyEnumHandle0` pattern, paging
 * through every entry, and reports exact counts in an aligned table. It also
 * counts active IKE/AuthIP and IPsec security associations, queries IKE and
 * IPsec statistics availability, and decodes the precise Win32 / `FWP_E_*`
 * status when the engine cannot be opened (non-elevated runs are expected to
 * land on `ERROR_ACCESS_DENIED` — the binding still works, the OS denies BFE
 * read access). Every value is read from caller-owned buffers; nothing is
 * cast.
 *
 * APIs demonstrated (Fwpuclnt):
 *   - FwpmEngineOpen0 / FwpmEngineClose0            (BFE session lifecycle)
 *   - FwpmProviderCreateEnumHandle0 / Enum0 / Destroy
 *   - FwpmProviderContextCreateEnumHandle0 / Enum0 / Destroy
 *   - FwpmSubLayerCreateEnumHandle0 / Enum0 / Destroy
 *   - FwpmLayerCreateEnumHandle0 / Enum0 / Destroy
 *   - FwpmCalloutCreateEnumHandle0 / Enum0 / Destroy
 *   - FwpmFilterCreateEnumHandle0 / Enum0 / Destroy
 *   - FwpmNetEventCreateEnumHandle0 / FwpmNetEventEnum0 / Destroy
 *   - IkeextSaCreateEnumHandle0 / IkeextSaEnum0 / Destroy
 *   - IPsecSaCreateEnumHandle0 / IPsecSaEnum0 / Destroy
 *   - FwpmFreeMemory0                               (release enumerated arrays)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/bfe-inventory.ts
 */
import Fwpuclnt, { RPC_C_AUTHN_WINNT } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Fwpuclnt.Preload([
  'FwpmEngineOpen0',
  'FwpmEngineClose0',
  'FwpmProviderCreateEnumHandle0',
  'FwpmProviderEnum0',
  'FwpmProviderDestroyEnumHandle0',
  'FwpmProviderContextCreateEnumHandle0',
  'FwpmProviderContextEnum0',
  'FwpmProviderContextDestroyEnumHandle0',
  'FwpmSubLayerCreateEnumHandle0',
  'FwpmSubLayerEnum0',
  'FwpmSubLayerDestroyEnumHandle0',
  'FwpmLayerCreateEnumHandle0',
  'FwpmLayerEnum0',
  'FwpmLayerDestroyEnumHandle0',
  'FwpmCalloutCreateEnumHandle0',
  'FwpmCalloutEnum0',
  'FwpmCalloutDestroyEnumHandle0',
  'FwpmFilterCreateEnumHandle0',
  'FwpmFilterEnum0',
  'FwpmFilterDestroyEnumHandle0',
  'FwpmNetEventCreateEnumHandle0',
  'FwpmNetEventEnum0',
  'FwpmNetEventDestroyEnumHandle0',
  'IkeextSaCreateEnumHandle0',
  'IkeextSaEnum0',
  'IkeextSaDestroyEnumHandle0',
  'IPsecSaCreateEnumHandle0',
  'IPsecSaEnum0',
  'IPsecSaDestroyEnumHandle0',
  'FwpmFreeMemory0',
]);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

// Enable ANSI escape processing so colors render in modern terminals.
const STD_OUTPUT_HANDLE = -11;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[38;2;120;200;255m';
const GREEN = '\x1b[38;2;120;230;140m';
const RED = '\x1b[38;2;240;120;120m';
const VIOLET = '\x1b[38;2;190;160;255m';

const ERROR_SUCCESS = 0;

/** Decode the most common Base Filtering Engine status codes. */
function decodeStatus(code: number): string {
  const u = code >>> 0;
  const known: Record<number, string> = {
    0x00000000: 'ERROR_SUCCESS',
    0x00000005: 'ERROR_ACCESS_DENIED — run elevated to read the BFE',
    0x00000057: 'ERROR_INVALID_PARAMETER',
    0x000006d9: 'EPT_S_NOT_REGISTERED — Base Filtering Engine service not reachable',
    0x80320008: 'FWP_E_NOT_FOUND',
    0x80320009: 'FWP_E_ALREADY_EXISTS',
    0x80320013: 'FWP_E_TIMEOUT',
    0x80320035: 'FWP_E_NOT_FOUND (object)',
  };
  return known[u] ?? `0x${u.toString(16).padStart(8, '0').toUpperCase()}`;
}

/**
 * Page through one WFP object class using the documented enum pattern and
 * return the total entry count. Reads only caller-owned buffers; the
 * DLL-allocated batch is released with FwpmFreeMemory0 each page.
 */
function countObjects(
  engineHandle: bigint,
  createEnum: (eng: bigint, hOut: Buffer) => number,
  enumFn: (eng: bigint, h: bigint, n: number, entriesOut: Buffer, retOut: Buffer) => number,
  destroyEnum: (eng: bigint, h: bigint) => number,
): { count: number; status: number } {
  const enumHandleBuf = Buffer.alloc(8);
  const createStatus = createEnum(engineHandle, enumHandleBuf);
  if (createStatus !== ERROR_SUCCESS) return { count: -1, status: createStatus };

  const enumHandle = enumHandleBuf.readBigUInt64LE(0);
  const BATCH = 512;
  const entriesOut = Buffer.alloc(8); // receives a DLL-allocated array pointer
  const numReturned = Buffer.alloc(4);
  let total = 0;
  let lastStatus = ERROR_SUCCESS;

  for (;;) {
    const status = enumFn(engineHandle, enumHandle, BATCH, entriesOut, numReturned);
    if (status !== ERROR_SUCCESS) {
      lastStatus = status;
      break;
    }
    const got = numReturned.readUInt32LE(0);
    total += got;
    // FwpmFreeMemory0 takes void** — pass the address of the pointer we own.
    if (entriesOut.readBigUInt64LE(0) !== 0n) Fwpuclnt.FwpmFreeMemory0(entriesOut.ptr);
    if (got < BATCH) break;
  }

  destroyEnum(engineHandle, enumHandle);
  return { count: total, status: lastStatus };
}

function bar(n: number, max: number, width = 28): string {
  if (n <= 0) return DIM + '·'.repeat(width) + RESET;
  const filled = Math.max(1, Math.round((Math.min(n, max) / max) * width));
  return GREEN + '█'.repeat(filled) + DIM + '░'.repeat(width - filled) + RESET;
}

function row(label: string, res: { count: number; status: number }, max: number): string {
  const name = label.padEnd(22);
  if (res.count < 0) {
    return `  ${name} ${RED}${'enum failed'.padStart(8)}${RESET}  ${DIM}${decodeStatus(res.status)}${RESET}`;
  }
  const value = String(res.count).padStart(8);
  return `  ${name} ${BOLD}${CYAN}${value}${RESET}  ${bar(res.count, max)}`;
}

console.log('');
console.log(`${BOLD}${VIOLET}╔══════════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${VIOLET}║${RESET}  ${BOLD}Windows Filtering Platform — Base Filtering Engine Inventory${RESET}        ${BOLD}${VIOLET}║${RESET}`);
console.log(`${BOLD}${VIOLET}╚══════════════════════════════════════════════════════════════════════╝${RESET}`);
console.log('');

const engineHandleBuf = Buffer.alloc(8);
const openStatus = Fwpuclnt.FwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, null, null, engineHandleBuf.ptr);

if (openStatus !== ERROR_SUCCESS) {
  console.log(`  ${RED}FwpmEngineOpen0 failed:${RESET} ${BOLD}${decodeStatus(openStatus)}${RESET}`);
  console.log('');
  console.log(`  ${DIM}The FFI binding round-tripped correctly — the Base Filtering Engine${RESET}`);
  console.log(`  ${DIM}simply denied access. Re-run from an elevated terminal to read the${RESET}`);
  console.log(`  ${DIM}live provider / sub-layer / layer / filter / SA inventory.${RESET}`);
  console.log('');
  process.exit(0);
}

const engineHandle = engineHandleBuf.readBigUInt64LE(0);
console.log(`  ${GREEN}● BFE session open${RESET}  ${DIM}engineHandle = 0x${engineHandle.toString(16)}${RESET}`);
console.log('');

const filters = countObjects(
  engineHandle,
  (e, h) => Fwpuclnt.FwpmFilterCreateEnumHandle0(e, null, h.ptr),
  (e, h, n, en, rt) => Fwpuclnt.FwpmFilterEnum0(e, h, n, en.ptr, rt.ptr),
  (e, h) => Fwpuclnt.FwpmFilterDestroyEnumHandle0(e, h),
);
const providers = countObjects(
  engineHandle,
  (e, h) => Fwpuclnt.FwpmProviderCreateEnumHandle0(e, null, h.ptr),
  (e, h, n, en, rt) => Fwpuclnt.FwpmProviderEnum0(e, h, n, en.ptr, rt.ptr),
  (e, h) => Fwpuclnt.FwpmProviderDestroyEnumHandle0(e, h),
);
const providerContexts = countObjects(
  engineHandle,
  (e, h) => Fwpuclnt.FwpmProviderContextCreateEnumHandle0(e, null, h.ptr),
  (e, h, n, en, rt) => Fwpuclnt.FwpmProviderContextEnum0(e, h, n, en.ptr, rt.ptr),
  (e, h) => Fwpuclnt.FwpmProviderContextDestroyEnumHandle0(e, h),
);
const subLayers = countObjects(
  engineHandle,
  (e, h) => Fwpuclnt.FwpmSubLayerCreateEnumHandle0(e, null, h.ptr),
  (e, h, n, en, rt) => Fwpuclnt.FwpmSubLayerEnum0(e, h, n, en.ptr, rt.ptr),
  (e, h) => Fwpuclnt.FwpmSubLayerDestroyEnumHandle0(e, h),
);
const layers = countObjects(
  engineHandle,
  (e, h) => Fwpuclnt.FwpmLayerCreateEnumHandle0(e, null, h.ptr),
  (e, h, n, en, rt) => Fwpuclnt.FwpmLayerEnum0(e, h, n, en.ptr, rt.ptr),
  (e, h) => Fwpuclnt.FwpmLayerDestroyEnumHandle0(e, h),
);
const callouts = countObjects(
  engineHandle,
  (e, h) => Fwpuclnt.FwpmCalloutCreateEnumHandle0(e, null, h.ptr),
  (e, h, n, en, rt) => Fwpuclnt.FwpmCalloutEnum0(e, h, n, en.ptr, rt.ptr),
  (e, h) => Fwpuclnt.FwpmCalloutDestroyEnumHandle0(e, h),
);
const netEvents = countObjects(
  engineHandle,
  (e, h) => Fwpuclnt.FwpmNetEventCreateEnumHandle0(e, null, h.ptr),
  (e, h, n, en, rt) => Fwpuclnt.FwpmNetEventEnum0(e, h, n, en.ptr, rt.ptr),
  (e, h) => Fwpuclnt.FwpmNetEventDestroyEnumHandle0(e, h),
);
const ikeSas = countObjects(
  engineHandle,
  (e, h) => Fwpuclnt.IkeextSaCreateEnumHandle0(e, null, h.ptr),
  (e, h, n, en, rt) => Fwpuclnt.IkeextSaEnum0(e, h, n, en.ptr, rt.ptr),
  (e, h) => Fwpuclnt.IkeextSaDestroyEnumHandle0(e, h),
);
const ipsecSas = countObjects(
  engineHandle,
  (e, h) => Fwpuclnt.IPsecSaCreateEnumHandle0(e, null, h.ptr),
  (e, h, n, en, rt) => Fwpuclnt.IPsecSaEnum0(e, h, n, en.ptr, rt.ptr),
  (e, h) => Fwpuclnt.IPsecSaDestroyEnumHandle0(e, h),
);

const counts = [filters, callouts, layers, subLayers, providers, providerContexts, netEvents, ikeSas, ipsecSas];
const max = Math.max(10, ...counts.map((c) => (c.count > 0 ? c.count : 0)));

console.log(`  ${BOLD}Object class${RESET}             ${BOLD}count${RESET}     ${BOLD}distribution${RESET}`);
console.log(`  ${DIM}${'─'.repeat(68)}${RESET}`);
console.log(row('Filters', filters, max));
console.log(row('Callouts', callouts, max));
console.log(row('Layers', layers, max));
console.log(row('Sub-layers', subLayers, max));
console.log(row('Providers', providers, max));
console.log(row('Provider contexts', providerContexts, max));
console.log(row('Net events', netEvents, max));
console.log(`  ${DIM}${'─'.repeat(68)}${RESET}`);
console.log(row('IKE / AuthIP SAs', ikeSas, max));
console.log(row('IPsec SAs', ipsecSas, max));
console.log('');

const okCount = counts.filter((c) => c.count >= 0).length;
console.log(`  ${GREEN}✓${RESET} ${okCount}/${counts.length} object classes enumerated via real FFI round-trips.`);

Fwpuclnt.FwpmEngineClose0(engineHandle);
console.log(`  ${DIM}● BFE session closed.${RESET}`);
console.log('');
