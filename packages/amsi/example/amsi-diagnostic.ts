/**
 * AMSI Diagnostic Report
 *
 * A thorough Antimalware Scan Interface diagnostic. It initializes a context,
 * opens a correlation session, then runs a structured test matrix — empty
 * content, benign code, the EICAR probe via both AmsiScanString and
 * AmsiScanBuffer, a large padded buffer, and AmsiNotifyOperation — reporting
 * the decoded HRESULT, the decoded AMSI_RESULT, the malware / blocked-by-admin
 * classification, and the per-call latency. A reference section explains the
 * AMSI_RESULT code ranges and the AmsiResultIsMalware / AmsiResultIsBlockedByAdmin
 * predicates so the numbers are interpretable.
 *
 * The EICAR antivirus test string is assembled at runtime from fragments so
 * this source file is not itself quarantined.
 *
 * APIs demonstrated (Amsi):
 *   - AmsiInitialize       (create the HAMSICONTEXT)
 *   - AmsiOpenSession      (open a correlation session)
 *   - AmsiScanString       (scan UTF-16 string content)
 *   - AmsiScanBuffer       (scan a raw byte buffer)
 *   - AmsiNotifyOperation  (notify the provider of an operation)
 *   - AmsiCloseSession     (close the session)
 *   - AmsiUninitialize     (release the context)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/amsi-diagnostic.ts
 */
import Amsi, { AMSI_RESULT } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Amsi.Preload();
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
const YELLOW = '\x1b[38;2;235;205;100m';
const CYAN = '\x1b[38;2;120;200;255m';

const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('');

function decodeHResult(hr: number): string {
  const map: Record<number, string> = {
    0: 'S_OK',
    1: 'S_FALSE',
    [-2147024809]: 'E_INVALIDARG',
    [-2147467263]: 'E_NOTIMPL',
    [-2147467262]: 'E_NOINTERFACE',
    [-2147024882]: 'E_OUTOFMEMORY',
    [-2147418113]: 'E_UNEXPECTED',
  };
  return map[hr] ?? `0x${(hr >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function decodeResult(code: number): { name: string; color: string; malware: boolean; blocked: boolean } {
  const malware = code >= AMSI_RESULT.AMSI_RESULT_DETECTED;
  const blocked = code >= AMSI_RESULT.AMSI_RESULT_BLOCKED_BY_ADMIN_START && code <= AMSI_RESULT.AMSI_RESULT_BLOCKED_BY_ADMIN_END;
  let name = AMSI_RESULT[code] ?? `(custom ${code})`;
  if (blocked) name = `BLOCKED_BY_ADMIN(${code})`;
  const color = malware ? RED : blocked ? YELLOW : GREEN;
  return { name, color, malware, blocked };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

console.log(`${BOLD}${CYAN}AMSI Diagnostic Report${RESET}  ${DIM}Antimalware Scan Interface — amsi.dll${RESET}\n`);

const ctxBuf = Buffer.alloc(8);
const initHr = Amsi.AmsiInitialize(Buffer.from('bun-win32 amsi diagnostic\0', 'utf16le').ptr, ctxBuf.ptr);
console.log(`${BOLD}Context${RESET}`);
console.log(`  AmsiInitialize       → ${decodeHResult(initHr)}`);
if (initHr !== 0) {
  console.error('  AMSI provider unavailable; aborting.');
  process.exit(1);
}
const ctx = ctxBuf.readBigUInt64LE(0);
console.log(`  HAMSICONTEXT         → 0x${ctx.toString(16)}`);

const sessBuf = Buffer.alloc(8);
const openHr = Amsi.AmsiOpenSession(ctx, sessBuf.ptr);
const session = sessBuf.readBigUInt64LE(0);
console.log(`  AmsiOpenSession      → ${decodeHResult(openHr)}  HAMSISESSION 0x${session.toString(16)}\n`);

type Case = { name: string; api: 'string' | 'buffer' | 'notify'; content: string };
const cases: Case[] = [
  { name: 'empty string', api: 'string', content: '' },
  { name: 'benign script', api: 'string', content: 'export const sum = (a: number, b: number) => a + b;' },
  { name: 'base64 helper', api: 'string', content: 'const d = Buffer.from(x, "base64").toString();' },
  { name: 'EICAR (string)', api: 'string', content: EICAR },
  { name: 'EICAR (buffer)', api: 'buffer', content: EICAR },
  { name: 'EICAR + 4 KiB pad', api: 'buffer', content: EICAR + ' '.repeat(4096) },
  { name: 'EICAR (notify)', api: 'notify', content: EICAR },
];

console.log(`${BOLD}Scan Matrix${RESET}`);
console.log(`${DIM}${pad('Case', 22)}${pad('API', 10)}${pad('HRESULT', 12)}${pad('AMSI_RESULT', 24)}${pad('Class', 10)}Latency${RESET}`);

for (const c of cases) {
  const result = Buffer.alloc(4);
  const nameBuf = Buffer.from(c.name + '\0', 'utf16le');
  const t0 = Bun.nanoseconds();
  let hr = 0;
  if (c.api === 'string') {
    const wide = Buffer.from(c.content + '\0', 'utf16le');
    hr = Amsi.AmsiScanString(ctx, wide.ptr, nameBuf.ptr, session, result.ptr);
  } else if (c.api === 'buffer') {
    const bytes = Buffer.from(c.content, 'latin1');
    hr = Amsi.AmsiScanBuffer(ctx, bytes.ptr, bytes.byteLength, nameBuf.ptr, session, result.ptr);
  } else {
    const bytes = Buffer.from(c.content, 'latin1');
    hr = Amsi.AmsiNotifyOperation(ctx, bytes.ptr, bytes.byteLength, nameBuf.ptr, result.ptr);
  }
  const us = (Bun.nanoseconds() - t0) / 1000;
  const code = result.readInt32LE(0);
  const d = decodeResult(code);
  const clsText = d.malware ? 'MALWARE' : d.blocked ? 'BLOCKED' : 'clean';
  const cls = `${d.color}${pad(clsText, 10)}${RESET}`;
  console.log(`${pad(c.name, 22)}${pad(c.api, 10)}${pad(decodeHResult(hr), 12)}${d.color}${pad(d.name, 24)}${RESET}${cls}${DIM}${us.toFixed(1)} µs${RESET}`);
}

Amsi.AmsiCloseSession(ctx, session);
Amsi.AmsiUninitialize(ctx);
console.log(`\n  AmsiCloseSession + AmsiUninitialize → done\n`);

console.log(`${BOLD}AMSI_RESULT Reference${RESET}`);
console.log(`  ${GREEN}${pad('CLEAN', 26)}${RESET}${DIM}0      content is clean${RESET}`);
console.log(`  ${GREEN}${pad('NOT_DETECTED', 26)}${RESET}${DIM}1      no detection (research recommended)${RESET}`);
console.log(`  ${YELLOW}${pad('BLOCKED_BY_ADMIN 0x4000–0x4FFF', 26)}${RESET}${DIM} admin policy blocked the content${RESET}`);
console.log(`  ${RED}${pad('DETECTED', 26)}${RESET}${DIM}≥ 32768  malware — block it${RESET}`);
console.log(`\n${DIM}AmsiResultIsMalware(r)        ≙ r >= AMSI_RESULT_DETECTED\n` + `AmsiResultIsBlockedByAdmin(r) ≙ AMSI_RESULT_BLOCKED_BY_ADMIN_START <= r <= AMSI_RESULT_BLOCKED_BY_ADMIN_END${RESET}`);
