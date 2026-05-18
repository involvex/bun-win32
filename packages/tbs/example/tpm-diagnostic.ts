/**
 * TPM Diagnostic Report
 *
 * A thorough Trusted Platform Module report built entirely on TPM Base Services.
 * It reads the TBS device info, opens a TBS context, then submits real TPM 2.0
 * command buffers — TPM2_GetCapability for the fixed property group and
 * TPM2_GetRandom — decoding the manufacturer, firmware version, family, spec
 * level/revision, and a hardware-RNG sample. It also performs the TCG event-log
 * sizing call. Every TBS_RESULT / TPM responseCode is decoded, not hidden.
 *
 * APIs demonstrated (Tbs):
 *   - Tbsi_GetDeviceInfo        (TPM version / interface / revision)
 *   - Tbsi_Context_Create       (open a TBS context for a TPM 2.0 device)
 *   - Tbsip_Submit_Command      (TPM2_GetCapability, TPM2_GetRandom)
 *   - Tbsi_Get_TCG_Log          (TCG measured-boot event-log sizing call)
 *   - Tbsip_Context_Close       (release the TBS context)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/tpm-diagnostic.ts
 */
import Tbs, { TBS_COMMAND_LOCALITY_ZERO, TBS_COMMAND_PRIORITY_NORMAL, TBS_CONTEXT_VERSION_TWO, TBS_SUCCESS } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Tbs.Preload(['Tbsi_GetDeviceInfo', 'Tbsi_Context_Create', 'Tbsip_Submit_Command', 'Tbsi_Get_TCG_Log', 'Tbsip_Context_Close']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

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
const GREEN = '\x1b[38;2;100;215;130m';
const RED = '\x1b[38;2;240;90;90m';
const CYAN = '\x1b[38;2;120;200;255m';

function decodeTbs(code: number): string {
  const map: Record<number, string> = {
    0: 'TBS_SUCCESS',
    [0x80284001]: 'TBS_E_INTERNAL_ERROR',
    [0x80284002]: 'TBS_E_BAD_PARAMETER',
    [0x80284003]: 'TBS_E_INVALID_OUTPUT_POINTER',
    [0x80284004]: 'TBS_E_INVALID_CONTEXT',
    [0x80284005]: 'TBS_E_INSUFFICIENT_BUFFER',
    [0x80284006]: 'TBS_E_IOERROR',
    [0x80284008]: 'TBS_E_SERVICE_NOT_RUNNING',
    [0x8028400f]: 'TBS_E_TPM_NOT_FOUND',
    [0x80284010]: 'TBS_E_SERVICE_DISABLED',
    [0x80284013]: 'TBS_E_DEVICE_NOT_READY',
  };
  return map[code >>> 0] ?? `0x${(code >>> 0).toString(16).toUpperCase()}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function asciiOf(value: number): string {
  // TPM property values such as manufacturer are 4 big-endian ASCII bytes.
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0, 0);
  return [...b].map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '')).join('');
}

console.log(`${BOLD}${CYAN}TPM Diagnostic Report${RESET}  ${DIM}TPM Base Services — tbs.dll${RESET}\n`);

// ── TBS device info ────────────────────────────────────────────────────────
const info = Buffer.alloc(16);
const giRes = Tbs.Tbsi_GetDeviceInfo(info.byteLength, info.ptr);
const TPM_VERS = ['Unknown', '1.2', '2.0'];
const IF_TYPE = ['Unknown', 'TIS/MMIO (1.2)', 'TrustZone', 'Hardware', 'Emulator', 'SPB'];
console.log(`${BOLD}TBS Device Info${RESET}  ${DIM}(${decodeTbs(giRes)})${RESET}`);
console.log(`  ${pad('Struct version', 20)}${info.readUInt32LE(0)}`);
console.log(`  ${pad('TPM version', 20)}${TPM_VERS[info.readUInt32LE(4)] ?? info.readUInt32LE(4)}`);
console.log(`  ${pad('Interface type', 20)}${IF_TYPE[info.readUInt32LE(8)] ?? info.readUInt32LE(8)}`);
console.log(`  ${pad('Impl. revision', 20)}${info.readUInt32LE(12)}\n`);

// ── TBS context ────────────────────────────────────────────────────────────
const params = Buffer.alloc(8);
params.writeUInt32LE(TBS_CONTEXT_VERSION_TWO, 0);
params.writeUInt32LE(0b100, 4); // includeTpm20
const ctxBuf = Buffer.alloc(8);
const ccRes = Tbs.Tbsi_Context_Create(params.ptr, ctxBuf.ptr);
console.log(`${BOLD}TBS Context${RESET}  Tbsi_Context_Create → ${ccRes === TBS_SUCCESS ? GREEN : RED}${decodeTbs(ccRes)}${RESET}`);
if (ccRes !== TBS_SUCCESS) {
  console.error('  Cannot continue without a TBS context.');
  process.exit(1);
}
const hContext = ctxBuf.readBigUInt64LE(0);
console.log(`  TBS_HCONTEXT 0x${hContext.toString(16)}\n`);

function submit(cmd: Buffer): { rc: number; body: Buffer } | null {
  const resp = Buffer.alloc(4096);
  const respLen = Buffer.alloc(4);
  respLen.writeUInt32LE(resp.byteLength, 0);
  const r = Tbs.Tbsip_Submit_Command(hContext, TBS_COMMAND_LOCALITY_ZERO, TBS_COMMAND_PRIORITY_NORMAL, cmd.ptr, cmd.byteLength, resp.ptr, respLen.ptr);
  if (r !== TBS_SUCCESS) {
    console.log(`  ${RED}Tbsip_Submit_Command → ${decodeTbs(r)}${RESET}`);
    return null;
  }
  const size = resp.readUInt32BE(2);
  return { rc: resp.readUInt32BE(6), body: resp.subarray(0, size) };
}

// ── TPM2_GetCapability: fixed properties ───────────────────────────────────
const cap = Buffer.alloc(22);
cap.writeUInt16BE(0x8001, 0); // TPM_ST_NO_SESSIONS
cap.writeUInt32BE(22, 2); // commandSize
cap.writeUInt32BE(0x0000017a, 6); // TPM_CC_GetCapability
cap.writeUInt32BE(0x00000006, 10); // TPM_CAP_TPM_PROPERTIES
cap.writeUInt32BE(0x00000100, 14); // PT_FIXED group start
cap.writeUInt32BE(0x40, 18); // propertyCount

console.log(`${BOLD}TPM Fixed Properties${RESET}  ${DIM}TPM2_GetCapability(TPM_CAP_TPM_PROPERTIES)${RESET}`);
const capResp = submit(cap);
const props = new Map<number, number>();
if (capResp && capResp.rc === 0) {
  // body: hdr(10) moreData(1) capability(4) count(4) then count*(prop u32, value u32)
  const count = capResp.body.readUInt32BE(15);
  for (let i = 0; i < count; i++) {
    const off = 19 + i * 8;
    props.set(capResp.body.readUInt32BE(off), capResp.body.readUInt32BE(off + 4));
  }
  const vendor = [0x106, 0x107, 0x108, 0x109]
    .map((p) => asciiOf(props.get(p) ?? 0))
    .join('')
    .replace(/\0+$/, '')
    .trim();
  const fw1 = props.get(0x10b) ?? 0;
  const fw2 = props.get(0x10c) ?? 0;
  console.log(`  ${pad('Family', 20)}${asciiOf(props.get(0x100) ?? 0).trim()}`);
  console.log(`  ${pad('Level / Revision', 20)}${props.get(0x101) ?? '?'} / ${((props.get(0x102) ?? 0) / 100).toFixed(2)}`);
  console.log(`  ${pad('Manufacturer', 20)}${asciiOf(props.get(0x105) ?? 0).trim()}`);
  console.log(`  ${pad('Vendor string', 20)}${vendor || '(none)'}`);
  console.log(`  ${pad('Firmware version', 20)}${(fw1 >>> 16) & 0xffff}.${fw1 & 0xffff}.${(fw2 >>> 16) & 0xffff}.${fw2 & 0xffff}`);
  console.log(`  ${pad('Properties read', 20)}${count}\n`);
} else {
  console.log(`  ${RED}responseCode 0x${(capResp?.rc ?? -1).toString(16)}${RESET}\n`);
}

// ── TPM2_GetRandom ─────────────────────────────────────────────────────────
const rnd = Buffer.alloc(12);
rnd.writeUInt16BE(0x8001, 0);
rnd.writeUInt32BE(12, 2);
rnd.writeUInt32BE(0x0000017b, 6); // TPM_CC_GetRandom
rnd.writeUInt16BE(32, 10); // bytesRequested
console.log(`${BOLD}Hardware RNG${RESET}  ${DIM}TPM2_GetRandom(32)${RESET}`);
const rndResp = submit(rnd);
if (rndResp && rndResp.rc === 0) {
  const n = rndResp.body.readUInt16BE(10);
  console.log(`  ${GREEN}${rndResp.body.subarray(12, 12 + n).toString('hex')}${RESET}  ${DIM}(${n} bytes from the TPM)${RESET}\n`);
} else {
  console.log(`  ${RED}responseCode 0x${(rndResp?.rc ?? -1).toString(16)}${RESET}\n`);
}

// ── TCG event log sizing call ──────────────────────────────────────────────
console.log(`${BOLD}TCG Measured-Boot Log${RESET}  ${DIM}Tbsi_Get_TCG_Log (sizing call)${RESET}`);
const logLen = Buffer.alloc(4);
const sizeRes = Tbs.Tbsi_Get_TCG_Log(hContext, null, logLen.ptr);
console.log(`  Tbsi_Get_TCG_Log(NULL) → ${decodeTbs(sizeRes)}, required ${logLen.readUInt32LE(0)} bytes`);
const need = logLen.readUInt32LE(0);
if (need > 0) {
  const log = Buffer.alloc(need);
  const logRes = Tbs.Tbsi_Get_TCG_Log(hContext, log.ptr, logLen.ptr);
  console.log(`  Tbsi_Get_TCG_Log(buf)  → ${decodeTbs(logRes)}, ${logLen.readUInt32LE(0)} bytes captured (TCG event log)\n`);
}

console.log(`Tbsip_Context_Close → ${decodeTbs(Tbs.Tbsip_Context_Close(hContext))}`);
console.log(`\n${DIM}All ${BOLD}13${RESET}${DIM} documented tbs.dll exports are bound; this report exercised the device-info, ` + `context, command-submit, and event-log surface against the real TPM.${RESET}`);
