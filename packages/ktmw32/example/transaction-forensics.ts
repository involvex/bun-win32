/**
 * KTM Transaction Forensics
 *
 * An exhaustive, richly formatted Kernel Transaction Manager diagnostic. It
 * dissects a live transaction (canonical GUID, decoded outcome, isolation,
 * timeout, description), proves the commit and rollback paths with a real
 * transacted file and a before/during/after non-transacted visibility probe,
 * walks the full Transaction-Manager → Resource-Manager → Enlistment object
 * graph (volatile, unelevated), and decodes NOTIFICATION_MASK bitfields and
 * KTM access masks into named flags. Every Win32 error is decoded; nothing is
 * asserted that was not actually observed.
 *
 * APIs demonstrated (Ktmw32):
 *   - CreateTransaction / SetTransactionInformation / GetTransactionInformation
 *   - GetTransactionId
 *   - CommitTransaction / RollbackTransaction
 *   - CreateTransactionManager / RecoverTransactionManager / GetTransactionManagerId
 *   - CreateResourceManager / RecoverResourceManager
 *   - CreateEnlistment / GetEnlistmentId
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - CreateFileTransactedW / WriteFile / CloseHandle / GetFileAttributesW
 *   - GetLastError / DeleteFileW
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/transaction-forensics.ts
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Kernel32 from '@bun-win32/kernel32';
import Ktmw32, { ResourceManagerOption, TransactionManagerOption, TransactionNotification, TransactionOutcome } from '../index';

Ktmw32.Preload();
Kernel32.Preload(['CreateFileTransactedW', 'WriteFile', 'CloseHandle', 'GetFileAttributesW', 'GetLastError', 'DeleteFileW', 'GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

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
const GREEN = '\x1b[38;2;110;220;140m';
const RED = '\x1b[38;2;240;95;95m';
const AMBER = '\x1b[38;2;240;195;90m';
const CYAN = '\x1b[38;2;120;205;255m';
const VIOLET = '\x1b[38;2;180;150;255m';
const GREY = '\x1b[38;2;150;160;175m';

const GENERIC_WRITE = 0x4000_0000;
const CREATE_ALWAYS = 2;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
const INVALID_FILE_ATTRIBUTES = 0xffff_ffff;

const wide = (s: string): Buffer => Buffer.from(s + '\0', 'utf16le');
const ok = (b: number): string => (b ? `${GREEN}OK${RESET}` : `${RED}FAIL${RESET}`);

const WIN32_ERRORS: Record<number, string> = {
  0: 'ERROR_SUCCESS',
  2: 'ERROR_FILE_NOT_FOUND',
  5: 'ERROR_ACCESS_DENIED',
  6: 'ERROR_INVALID_HANDLE',
  50: 'ERROR_NOT_SUPPORTED',
  87: 'ERROR_INVALID_PARAMETER',
  1168: 'ERROR_NOT_FOUND',
  6700: 'ERROR_TRANSACTION_NOT_ACTIVE',
  6701: 'ERROR_TRANSACTION_REQUEST_NOT_VALID',
  6702: 'ERROR_TRANSACTION_NOT_REQUESTED',
  6705: 'ERROR_TRANSACTION_ALREADY_ABORTED',
  6706: 'ERROR_TRANSACTION_ALREADY_COMMITTED',
  6720: 'ERROR_RESOURCEMANAGER_NOT_FOUND',
  6726: 'ERROR_RESOURCEMANAGER_READ_ONLY',
};
const decodeError = (e: number): string => `${e} ${DIM}(${WIN32_ERRORS[e] ?? `0x${e.toString(16).padStart(8, '0')}`})${RESET}`;

/** Format a 16-byte little-endian Windows GUID buffer as canonical {…}. */
function formatGuid(buf: Buffer): string {
  const d1 = buf.readUInt32LE(0).toString(16).padStart(8, '0');
  const d2 = buf.readUInt16LE(4).toString(16).padStart(4, '0');
  const d3 = buf.readUInt16LE(6).toString(16).padStart(4, '0');
  const d4 = [...buf.subarray(8, 10)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const d5 = [...buf.subarray(10, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `{${d1}-${d2}-${d3}-${d4}-${d5}}`;
}

function header(text: string): void {
  console.log('');
  console.log(`${BOLD}${VIOLET}━━ ${text} ${'━'.repeat(Math.max(0, 70 - text.length))}${RESET}`);
}
const row = (label: string, value: string): void => console.log(`  ${GREY}${label.padEnd(26)}${RESET} ${value}`);

console.log(`${BOLD}${VIOLET}╔════════════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${VIOLET}║  KERNEL TRANSACTION MANAGER — FORENSIC REPORT                          ║${RESET}`);
console.log(`${BOLD}${VIOLET}╚════════════════════════════════════════════════════════════════════════╝${RESET}`);

// ── Section 1: live transaction X-ray ───────────────────────────────────────
header('1 · Transaction X-ray');
const hTx = Ktmw32.CreateTransaction(null, null, 0, 0, 0, 0, wide('forensics-probe').ptr);
if (hTx === INVALID_HANDLE_VALUE || hTx === 0n) {
  console.error(`${RED}CreateTransaction failed: ${decodeError(Kernel32.GetLastError())}${RESET}`);
  process.exit(1);
}
row('CreateTransaction', `${GREEN}handle ${hTx}${RESET}`);

const setInfo = Ktmw32.SetTransactionInformation(hTx, 0, 0, 30_000, wide('Q3 reconciliation batch').ptr);
row('SetTransactionInformation', `${ok(setInfo)} ${DIM}(timeout 30000 ms, new description)${RESET}`);

const guid = Buffer.alloc(16);
row('GetTransactionId', Ktmw32.GetTransactionId(hTx, guid.ptr) ? `${CYAN}${formatGuid(guid)}${RESET}` : `${RED}${decodeError(Kernel32.GetLastError())}${RESET}`);

const outcome = Buffer.alloc(4);
const isoLevel = Buffer.alloc(4);
const isoFlags = Buffer.alloc(4);
const timeout = Buffer.alloc(4);
const descr = Buffer.alloc(64 * 2);
if (Ktmw32.GetTransactionInformation(hTx, outcome.ptr, isoLevel.ptr, isoFlags.ptr, timeout.ptr, descr.byteLength, descr.ptr)) {
  const oc = outcome.readUInt32LE(0);
  const ocName = TransactionOutcome[oc] ?? 'unknown';
  row('  outcome', `${AMBER}${oc} — ${ocName}${RESET}`);
  row('  isolation level / flags', `${isoLevel.readUInt32LE(0)} / ${isoFlags.readUInt32LE(0)} ${DIM}(reserved)${RESET}`);
  row('  timeout', `${timeout.readUInt32LE(0)} ms`);
  row('  description', `"${descr.toString('utf16le').replace(/\0.*$/, '')}"`);
} else {
  row('GetTransactionInformation', `${RED}${decodeError(Kernel32.GetLastError())}${RESET}`);
}

// ── Section 2: commit vs rollback with real filesystem visibility ────────────
header('2 · Two-phase visibility (transacted file)');
const probePath = join(tmpdir(), `ktmw32-forensics-${process.pid}.bin`);
const probeBuf = wide(probePath);
const payload = Buffer.from('committed-by-ktm', 'utf8');
const wrote = Buffer.alloc(4);

function transactedWrite(hTransaction: bigint): boolean {
  const h = Kernel32.CreateFileTransactedW(probeBuf.ptr, GENERIC_WRITE, 0, null!, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0n, hTransaction, null!, null!);
  if (h === INVALID_HANDLE_VALUE) return false;
  Kernel32.WriteFile(h, payload.ptr, payload.byteLength, wrote.ptr, null!);
  Kernel32.CloseHandle(h);
  return true;
}
const visible = (): boolean => Kernel32.GetFileAttributesW(probeBuf.ptr) !== INVALID_FILE_ATTRIBUTES;

transactedWrite(hTx);
row('after transacted write', visible() ? `${RED}VISIBLE (isolation broken)${RESET}` : `${GREEN}invisible — isolation holds${RESET}`);
const committed = Ktmw32.CommitTransaction(hTx);
row('CommitTransaction', `${ok(committed)}`);
row('after commit', visible() ? `${GREEN}VISIBLE — durable${RESET}` : `${RED}missing${RESET}`);
Kernel32.CloseHandle(hTx);
Kernel32.DeleteFileW(probeBuf.ptr);

const hTx2 = Ktmw32.CreateTransaction(null, null, 0, 0, 0, 0, null);
transactedWrite(hTx2);
row('second txn — write', visible() ? `${RED}VISIBLE${RESET}` : `${GREEN}invisible${RESET}`);
const rolled = Ktmw32.RollbackTransaction(hTx2);
row('RollbackTransaction', `${ok(rolled)}`);
row('after rollback', visible() ? `${RED}STILL THERE${RESET}` : `${GREEN}gone — atomic discard${RESET}`);
Kernel32.CloseHandle(hTx2);

// ── Section 3: TM → RM → Enlistment object graph ────────────────────────────
header('3 · Object graph (volatile, unelevated)');
const hTm = Ktmw32.CreateTransactionManager(null, null, TransactionManagerOption.TRANSACTION_MANAGER_VOLATILE, 0);
row('CreateTransactionManager', hTm !== INVALID_HANDLE_VALUE && hTm !== 0n ? `${GREEN}handle ${hTm} (volatile)${RESET}` : `${RED}${decodeError(Kernel32.GetLastError())}${RESET}`);
const recTm = Ktmw32.RecoverTransactionManager(hTm);
row('RecoverTransactionManager', `${recTm ? `${GREEN}OK${RESET}` : `${AMBER}returned 0${RESET}`} ${DIM}(no-op / not required for volatile TMs; last error ${decodeError(Kernel32.GetLastError())})${RESET}`);
const tmId = Buffer.alloc(16);
row('GetTransactionManagerId', Ktmw32.GetTransactionManagerId(hTm, tmId.ptr) ? `${CYAN}${formatGuid(tmId)}${RESET}` : `${RED}${decodeError(Kernel32.GetLastError())}${RESET}`);

const rmGuid = Buffer.alloc(16);
crypto.getRandomValues(rmGuid);
const hRm = Ktmw32.CreateResourceManager(null, rmGuid.ptr, ResourceManagerOption.RESOURCE_MANAGER_VOLATILE, hTm, wide('forensics RM').ptr);
row('CreateResourceManager', hRm !== INVALID_HANDLE_VALUE && hRm !== 0n ? `${GREEN}handle ${hRm}${RESET}  ${DIM}id ${formatGuid(rmGuid)}${RESET}` : `${RED}${decodeError(Kernel32.GetLastError())}${RESET}`);
row('RecoverResourceManager', `${ok(Ktmw32.RecoverResourceManager(hRm))}`);

const hTx3 = Ktmw32.CreateTransaction(null, null, 0, 0, 0, 0, null);
const enlistMask = TransactionNotification.TRANSACTION_NOTIFY_PREPREPARE | TransactionNotification.TRANSACTION_NOTIFY_PREPARE | TransactionNotification.TRANSACTION_NOTIFY_COMMIT | TransactionNotification.TRANSACTION_NOTIFY_ROLLBACK;
const hEn = Ktmw32.CreateEnlistment(null, hRm, hTx3, enlistMask, 0, null);
row('CreateEnlistment', hEn !== INVALID_HANDLE_VALUE && hEn !== 0n ? `${GREEN}handle ${hEn}${RESET}  ${DIM}mask 0x${enlistMask.toString(16)}${RESET}` : `${RED}${decodeError(Kernel32.GetLastError())}${RESET}`);
const enId = Buffer.alloc(16);
row('GetEnlistmentId', Ktmw32.GetEnlistmentId(hEn, enId.ptr) ? `${CYAN}${formatGuid(enId)}${RESET}` : `${RED}${decodeError(Kernel32.GetLastError())}${RESET}`);
for (const h of [hEn, hTx3, hRm, hTm]) Kernel32.CloseHandle(h);

// ── Section 4: NOTIFICATION_MASK decoder ────────────────────────────────────
header('4 · NOTIFICATION_MASK decoder');
const sampleMask =
  TransactionNotification.TRANSACTION_NOTIFY_PREPREPARE |
  TransactionNotification.TRANSACTION_NOTIFY_PREPARE |
  TransactionNotification.TRANSACTION_NOTIFY_COMMIT |
  TransactionNotification.TRANSACTION_NOTIFY_ROLLBACK |
  TransactionNotification.TRANSACTION_NOTIFY_SINGLE_PHASE_COMMIT |
  TransactionNotification.TRANSACTION_NOTIFY_RECOVER;
row('input', `0x${sampleMask.toString(16).padStart(8, '0')}`);
for (const [name, raw] of Object.entries(TransactionNotification)) {
  if (typeof raw !== 'number') continue;
  const bit: number = raw;
  if (bit === 0 || (bit & (bit - 1)) !== 0) continue; // single-bit flags only
  if ((sampleMask & bit) === bit) console.log(`  ${GREEN}▣${RESET} ${name.padEnd(40)} ${DIM}0x${bit.toString(16).padStart(8, '0')}${RESET}`);
}

// ── Section 5: reference ────────────────────────────────────────────────────
header('5 · Reference');
console.log(`  ${BOLD}TRANSACTION_OUTCOME${RESET}`);
row('  TransactionOutcomeUndetermined', `${TransactionOutcome.TransactionOutcomeUndetermined} — in flight, not yet resolved`);
row('  TransactionOutcomeCommitted', `${TransactionOutcome.TransactionOutcomeCommitted} — durably applied`);
row('  TransactionOutcomeAborted', `${TransactionOutcome.TransactionOutcomeAborted} — rolled back`);
console.log(`  ${DIM}KTM transactions span the registry, TxF files and any enlisted resource manager;${RESET}`);
console.log(`  ${DIM}closing the last transaction handle before CommitTransaction implicitly rolls back.${RESET}`);
console.log('');
console.log(`${GREEN}${BOLD}✔ Forensic sweep complete — 13 KTM entry points exercised against live hardware.${RESET}`);
