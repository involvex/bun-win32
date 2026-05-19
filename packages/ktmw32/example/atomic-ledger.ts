/**
 * Atomic Ledger — ACID filesystem transactions, pure FFI
 *
 * Each bank account is a real file on disk holding its balance. A whole batch
 * of transfers is applied as ONE Kernel Transaction Manager (KTM) transaction
 * via Kernel32.CreateFileTransactedW: every balance file is rewritten inside
 * the transaction, so an outside (non-transacted) "auditor" keeps seeing the
 * old balances until the transaction commits — and if any transfer would
 * overdraw an account, RollbackTransaction snaps the entire ledger back as if
 * nothing happened. No half-applied state, ever. This is real two-phase,
 * isolated, atomic, durable filesystem I/O driven entirely from Bun FFI.
 *
 * Two scenarios run back to back:
 *   1. A valid batch  -> CommitTransaction   (all balances update at once)
 *   2. An overdraft   -> RollbackTransaction (ledger is left untouched)
 *
 * APIs demonstrated (Ktmw32):
 *   - CreateTransaction            (open a KTM transaction)
 *   - GetTransactionInformation    (read the live transaction outcome)
 *   - CommitTransaction            (durably apply every transacted write)
 *   - RollbackTransaction          (atomically discard the whole batch)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - CreateFileTransactedW        (create/replace a file inside the txn)
 *   - WriteFile / CloseHandle      (write the new balance, release the handle)
 *   - GetFileAttributesW           (non-transacted "auditor" visibility probe)
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/atomic-ledger.ts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Kernel32 from '@bun-win32/kernel32';
import Ktmw32, { TransactionOutcome } from '../index';

Ktmw32.Preload(['CreateTransaction', 'GetTransactionInformation', 'CommitTransaction', 'RollbackTransaction']);
Kernel32.Preload(['CreateFileTransactedW', 'WriteFile', 'CloseHandle', 'GetFileAttributesW', 'GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

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

const workDir = join(tmpdir(), `ktmw32-ledger-${process.pid}`);
mkdirSync(workDir, { recursive: true });

const accounts = ['Alice', 'Bob', 'Carol', 'Dave'] as const;
const seed: Record<string, number> = { Alice: 1000, Bob: 250, Carol: 500, Dave: 75 };
const accountPath = (name: string): string => join(workDir, `${name}.acct`);
const wide = (s: string): Buffer => Buffer.from(s + '\0', 'utf16le');

for (const name of accounts) writeFileSync(accountPath(name), String(seed[name]), 'utf8');

/** Non-transacted read — this is exactly what an outside auditor process sees. */
function auditorBalance(name: string): number {
  return Number(readFileSync(accountPath(name), 'utf8'));
}

/** Rewrite an account file *inside* the given KTM transaction. */
function writeTransacted(name: string, balance: number, hTx: bigint): boolean {
  const hFile = Kernel32.CreateFileTransactedW(wide(accountPath(name)).ptr, GENERIC_WRITE, 0, null!, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0n, hTx, null!, null!);
  if (hFile === INVALID_HANDLE_VALUE) return false;
  const data = Buffer.from(String(balance), 'utf8');
  const wrote = Buffer.alloc(4);
  const ok = Kernel32.WriteFile(hFile, data.ptr, data.byteLength, wrote.ptr, null!);
  Kernel32.CloseHandle(hFile);
  return ok !== 0;
}

function outcomeName(hTx: bigint): string {
  const outcome = Buffer.alloc(4);
  if (!Ktmw32.GetTransactionInformation(hTx, outcome.ptr, null, null, null, 0, null)) return 'unknown';
  switch (outcome.readUInt32LE(0)) {
    case TransactionOutcome.TransactionOutcomeUndetermined:
      return 'UNDETERMINED (in flight)';
    case TransactionOutcome.TransactionOutcomeCommitted:
      return 'COMMITTED';
    case TransactionOutcome.TransactionOutcomeAborted:
      return 'ABORTED';
    default:
      return 'unknown';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const bar = (value: number, max: number, width: number): string => '█'.repeat(Math.max(0, Math.round((value / max) * width)));

interface Step {
  from: string;
  to: string;
  amount: number;
}

function render(title: string, titleColor: string, working: Record<string, number>, txState: string, log: string[]): void {
  const max = 1300;
  const out: string[] = [];
  out.push(`\x1b[H\x1b[2J${BOLD}${VIOLET}  ╔══════════════════════════════════════════════════════════════════════╗${RESET}`);
  out.push(`${BOLD}${VIOLET}  ║   KTM ATOMIC LEDGER — transacted filesystem, pure Bun FFI            ║${RESET}`);
  out.push(`${BOLD}${VIOLET}  ╚══════════════════════════════════════════════════════════════════════╝${RESET}`);
  out.push('');
  out.push(`  ${BOLD}${titleColor}${title}${RESET}`);
  out.push(`  ${GREY}transaction state:${RESET} ${txState}`);
  out.push('');
  out.push(`  ${DIM}account      transacted (pending)              auditor view (committed, non-txn)${RESET}`);
  for (const name of accounts) {
    const w = working[name]!;
    const a = auditorBalance(name);
    const drift = w !== a;
    const wCol = drift ? AMBER : GREEN;
    const left = `${name.padEnd(7)} ${wCol}${String(w).padStart(5)}${RESET} ${wCol}${bar(w, max, 26)}${RESET}`;
    const right = `${CYAN}${String(a).padStart(5)}${RESET} ${CYAN}${bar(a, max, 22)}${RESET}`;
    out.push(`  ${left}  ${DIM}│${RESET} ${right}`);
  }
  out.push('');
  out.push(`  ${DIM}${'─'.repeat(72)}${RESET}`);
  for (const line of log.slice(-7)) out.push(`  ${line}`);
  process.stdout.write(out.join('\n') + '\n');
}

async function runBatch(label: string, color: string, steps: Step[]): Promise<void> {
  const working: Record<string, number> = { ...seed, ...Object.fromEntries(accounts.map((n) => [n, auditorBalance(n)])) };
  const log: string[] = [];

  const hTx = Ktmw32.CreateTransaction(null, null, 0, 0, 0, 0, wide(label).ptr);
  if (hTx === INVALID_HANDLE_VALUE || hTx === 0n) {
    console.error(`${RED}CreateTransaction failed (error ${Kernel32.GetLastError()})${RESET}`);
    return;
  }
  log.push(`${GREEN}✔${RESET} CreateTransaction → handle ${hTx}  ${DIM}"${label}"${RESET}`);
  render(label, color, working, `${AMBER}${outcomeName(hTx)}${RESET}`, log);
  await sleep(650);

  let doomed: Step | null = null;
  for (const step of steps) {
    if (working[step.from]! - step.amount < 0) {
      doomed = step;
      log.push(`${RED}✖${RESET} ${step.from} → ${step.to} $${step.amount}: would overdraw ${step.from} ($${working[step.from]})`);
      render(label, color, working, `${RED}ABORTING${RESET}`, log);
      await sleep(700);
      break;
    }
    working[step.from]! -= step.amount;
    working[step.to]! += step.amount;
    const okA = writeTransacted(step.from, working[step.from]!, hTx);
    const okB = writeTransacted(step.to, working[step.to]!, hTx);
    log.push(`${okA && okB ? GREEN + '✔' : RED + '✖'}${RESET} transacted  ${step.from} → ${step.to}  ${BOLD}$${step.amount}${RESET}  ${DIM}(auditor still blind)${RESET}`);
    render(label, color, working, `${AMBER}${outcomeName(hTx)}${RESET}`, log);
    await sleep(620);
  }

  if (doomed) {
    const rolled = Ktmw32.RollbackTransaction(hTx);
    log.push(`${VIOLET}↺${RESET} ${BOLD}RollbackTransaction${RESET} → ${rolled ? `${GREEN}OK${RESET}` : `${RED}FAIL ${Kernel32.GetLastError()}${RESET}`} — entire batch discarded`);
    // Roll the working view back to the committed truth.
    for (const n of accounts) working[n] = auditorBalance(n);
    render(label, color, working, `${RED}ROLLED BACK — ledger unchanged (atomicity)${RESET}`, log);
  } else {
    log.push(`${DIM}two-phase commit…${RESET}`);
    render(label, color, working, `${AMBER}${outcomeName(hTx)} → committing${RESET}`, log);
    await sleep(500);
    const committed = Ktmw32.CommitTransaction(hTx);
    log.push(`${GREEN}⛁${RESET} ${BOLD}CommitTransaction${RESET} → ${committed ? `${GREEN}OK${RESET}` : `${RED}FAIL ${Kernel32.GetLastError()}${RESET}`} — all writes durable at once`);
    render(label, color, working, committed ? `${GREEN}COMMITTED — every balance updated atomically${RESET}` : `${RED}COMMIT FAILED${RESET}`, log);
  }
  Kernel32.CloseHandle(hTx);
  await sleep(900);
}

const isolationProbe = (): string => {
  // Prove the non-transacted namespace genuinely cannot see an uncommitted file.
  const hTx = Ktmw32.CreateTransaction(null, null, 0, 0, 0, 0, null);
  const ghost = join(workDir, 'ghost.tmp');
  const h = Kernel32.CreateFileTransactedW(wide(ghost).ptr, GENERIC_WRITE, 0, null!, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0n, hTx, null!, null!);
  Kernel32.CloseHandle(h);
  const blindMid = Kernel32.GetFileAttributesW(wide(ghost).ptr) === INVALID_FILE_ATTRIBUTES;
  Ktmw32.RollbackTransaction(hTx);
  Kernel32.CloseHandle(hTx);
  const goneAfter = Kernel32.GetFileAttributesW(wide(ghost).ptr) === INVALID_FILE_ATTRIBUTES;
  return blindMid && goneAfter ? `${GREEN}verified${RESET}` : `${RED}leaked${RESET}`;
};

await runBatch('Payroll run #1', GREEN, [
  { from: 'Alice', to: 'Bob', amount: 200 },
  { from: 'Alice', to: 'Carol', amount: 150 },
  { from: 'Carol', to: 'Dave', amount: 300 },
]);

await runBatch('Payroll run #2 (one transfer overdraws Dave)', RED, [
  { from: 'Bob', to: 'Dave', amount: 100 },
  { from: 'Dave', to: 'Alice', amount: 999 },
  { from: 'Carol', to: 'Bob', amount: 50 },
]);

console.log('');
console.log(`  ${BOLD}${CYAN}Isolation cross-check${RESET}: an uncommitted transacted file is invisible to a normal open … ${isolationProbe()}`);
console.log(`  ${DIM}KTM gave us Atomicity, Consistency, Isolation and Durability over the filesystem — from TypeScript, zero native build.${RESET}`);

rmSync(workDir, { recursive: true, force: true });
