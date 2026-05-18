/**
 * LDAP Directory Diagnostic
 *
 * An exhaustive, fully offline report for the Windows LDAP client. It opens an
 * ldap session block (no network is touched — ldap_init is lazy), dumps the
 * connection-block options before and after negotiating LDAP v3, decomposes a
 * realistic distinguished name into its relative components, demonstrates the
 * two-call sizing pattern for binary filter-element escaping, and prints the
 * complete LDAP result-code reference table with each code's human-readable
 * text and its mapped Win32 error. Every value is shown in an aligned,
 * colorized table.
 *
 * Everything here is deterministic and requires no LDAP server.
 *
 * APIs demonstrated:
 *   - ldap_initW                   (allocate a session/connection block)
 *   - ldap_get_optionW             (read connection-block options)
 *   - ldap_set_optionW             (negotiate LDAP protocol version 3)
 *   - ldap_explode_dnW             (split a DN into RDN components)
 *   - ldap_dn2ufnW                 (DN -> user-friendly name)
 *   - ldap_escape_filter_elementW  (escape raw bytes for a search filter)
 *   - ldap_err2stringW             (result code -> message string)
 *   - LdapMapErrorToWin32          (LDAP error -> Win32 error code)
 *   - LdapGetLastError             (thread-local last LDAP error)
 *   - ldap_value_freeW             (free ldap_explode_dnW output)
 *   - ldap_memfreeW                (free ldap_dn2ufnW output)
 *   - ldap_unbind                  (release the session block)
 *
 * Run: bun run example/directory-diagnostic.ts
 */

import { type Pointer, toArrayBuffer } from 'bun:ffi';

import Wldap32, { LdapOption, LdapRetcode } from '../index';

Wldap32.Preload([
  'ldap_initW',
  'ldap_get_optionW',
  'ldap_set_optionW',
  'ldap_explode_dnW',
  'ldap_dn2ufnW',
  'ldap_escape_filter_elementW',
  'ldap_err2stringW',
  'LdapMapErrorToWin32',
  'LdapGetLastError',
  'ldap_value_freeW',
  'ldap_memfreeW',
  'ldap_unbind',
]);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const GREY = '\x1b[90m';

const LDAP_SUCCESS = 0;

function readWideString(addr: number | bigint, maxBytes = 2048): string {
  const value = typeof addr === 'bigint' ? Number(addr) : addr;
  if (!value) return '';
  const buffer = Buffer.from(toArrayBuffer(value as Pointer, 0, maxBytes));
  let end = buffer.length;
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    if (buffer.readUInt16LE(index) === 0) {
      end = index;
      break;
    }
  }
  return buffer.subarray(0, end).toString('utf16le');
}

function wide(text: string): Buffer {
  return Buffer.from(text + '\0', 'utf16le');
}

function heading(title: string): void {
  console.log(`\n${BOLD}${CYAN}${title}${RESET}`);
  console.log(`${GREY}${'─'.repeat(title.length)}${RESET}`);
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

console.log(`${BOLD}${MAGENTA}╔══════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${MAGENTA}║            wldap32 — LDAP Directory Diagnostic               ║${RESET}`);
console.log(`${BOLD}${MAGENTA}╚══════════════════════════════════════════════════════════════╝${RESET}`);

// ── Session block ──────────────────────────────────────────────────────────
heading('Session / Connection Block');

const ld = Wldap32.ldap_initW(wide('ldap.example.com').ptr, 389);
if (ld === 0n) {
  console.error(`${RED}ldap_initW failed (LdapGetLastError = ${Wldap32.LdapGetLastError()})${RESET}`);
  process.exit(1);
}
row('Session handle', `${GREEN}0x${ld.toString(16)}${RESET}`);

// LDAP_OPT_* values that resolve to a single ULONG out-value.
const ulongOptions: Array<{ name: string; option: LdapOption }> = [
  { name: 'LDAP_OPT_VERSION', option: LdapOption.Version },
  { name: 'LDAP_OPT_SSL', option: LdapOption.Ssl },
  { name: 'LDAP_OPT_REFERRALS', option: LdapOption.Referrals },
  { name: 'LDAP_OPT_SIZELIMIT', option: LdapOption.SizeLimit },
  { name: 'LDAP_OPT_TIMELIMIT', option: LdapOption.TimeLimit },
  { name: 'LDAP_OPT_DEREF', option: LdapOption.Deref },
];

function readUlongOption(option: LdapOption): number | null {
  const out = Buffer.alloc(4);
  const status = Wldap32.ldap_get_optionW(ld, option, out.ptr);
  return status === LDAP_SUCCESS ? out.readUInt32LE(0) : null;
}

console.log(`\n  ${DIM}defaults assigned by ldap_initW:${RESET}`);
for (const { name, option } of ulongOptions) {
  const value = readUlongOption(option);
  row(name, value === null ? `${RED}unavailable${RESET}` : `${YELLOW}${value}${RESET}`);
}

// Negotiate LDAP v3 and prove the option took effect.
const desiredVersion = Buffer.alloc(4);
desiredVersion.writeUInt32LE(3, 0);
const setStatus = Wldap32.ldap_set_optionW(ld, LdapOption.Version, desiredVersion.ptr);
const negotiated = readUlongOption(LdapOption.Version);
console.log(`\n  ${DIM}after ldap_set_optionW(LDAP_OPT_VERSION, 3):${RESET}`);
row('ldap_set_optionW status', setStatus === LDAP_SUCCESS ? `${GREEN}LDAP_SUCCESS${RESET}` : `${RED}${setStatus}${RESET}`);
row('LDAP_OPT_VERSION', `${GREEN}${negotiated}${RESET}`);

// ── DN decomposition ───────────────────────────────────────────────────────
heading('Distinguished Name Decomposition');

const sampleDn = 'CN=Ada Lovelace,OU=Engineering,OU=People,DC=acme,DC=example,DC=com';
row('Input DN', `${CYAN}${sampleDn}${RESET}`);

for (const noTypes of [0, 1]) {
  const exploded = Wldap32.ldap_explode_dnW(wide(sampleDn).ptr, noTypes);
  if (!exploded) {
    row(`ldap_explode_dnW(notypes=${noTypes})`, `${RED}NULL${RESET}`);
    continue;
  }
  const components: string[] = [];
  for (let offset = 0; ; offset += 8) {
    const elementAddress = new BigUint64Array(toArrayBuffer(exploded, offset, 8))[0]!;
    if (elementAddress === 0n) break;
    components.push(readWideString(elementAddress));
  }
  Wldap32.ldap_value_freeW(exploded);
  row(`notypes=${noTypes}`, components.map((part) => `${YELLOW}${part}${RESET}`).join(`${GREY} ▸ ${RESET}`));
}

const ufnPointer = Wldap32.ldap_dn2ufnW(wide(sampleDn).ptr);
if (ufnPointer !== null) {
  row('ldap_dn2ufnW', `${GREEN}${readWideString(ufnPointer)}${RESET}`);
  Wldap32.ldap_memfreeW(ufnPointer);
}

// ── Binary filter-element escaping (two-call sizing) ────────────────────────
heading('Filter-Element Escaping');

// An objectGUID is raw binary; it must be escaped before going on the wire.
const objectGuid = Buffer.from([0x48, 0x26, 0xbf, 0x6c, 0xf0, 0x12, 0x34, 0x44]);
row('Raw bytes', `${CYAN}${objectGuid.toString('hex')}${RESET}`);

// First call with a NULL destination returns the required character count.
const requiredChars = Wldap32.ldap_escape_filter_elementW(objectGuid.ptr, objectGuid.length, null, 0);
row('Required buffer (chars)', `${YELLOW}${requiredChars}${RESET}`);

const escapeBuffer = Buffer.alloc((requiredChars + 1) * 2);
const escapeStatus = Wldap32.ldap_escape_filter_elementW(objectGuid.ptr, objectGuid.length, escapeBuffer.ptr, requiredChars + 1);
if (escapeStatus === LDAP_SUCCESS) {
  // Read straight from the buffer we own, truncating at the wide NUL.
  let end = escapeBuffer.length;
  for (let index = 0; index + 1 < escapeBuffer.length; index += 2) {
    if (escapeBuffer.readUInt16LE(index) === 0) {
      end = index;
      break;
    }
  }
  const escaped = escapeBuffer.subarray(0, end).toString('utf16le');
  row('Escaped (filter-safe)', `${GREEN}${escaped}${RESET}`);
  console.log(`  ${DIM}→ usable as (objectGUID=${escaped})${RESET}`);
} else {
  row('ldap_escape_filter_elementW', `${RED}status ${escapeStatus}${RESET}`);
}

// ── Full result-code reference ─────────────────────────────────────────────
heading('LDAP Result-Code Reference (ldap_err2stringW + Win32 mapping)');

const codeEntries = Object.entries(LdapRetcode)
  .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
  .sort((left, right) => left[1] - right[1]);

console.log(`  ${BOLD}${'Code'.padEnd(6)} ${'Name'.padEnd(26)} ${'Win32'.padEnd(7)} Message${RESET}`);
console.log(`  ${GREY}${'─'.repeat(72)}${RESET}`);
for (const [name, code] of codeEntries) {
  const messagePointer = Wldap32.ldap_err2stringW(code);
  const message = messagePointer === null ? '' : readWideString(messagePointer);
  const win32 = Wldap32.LdapMapErrorToWin32(code);
  const colour = code === 0 ? GREEN : code >= 0x50 ? RED : YELLOW;
  const codeText = `0x${code.toString(16).padStart(2, '0')}`;
  console.log(`  ${colour}${codeText.padEnd(6)}${RESET} ${name.padEnd(26)} ${GREY}${String(win32).padEnd(7)}${RESET} ${DIM}${message}${RESET}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
heading('Cleanup');
const unbindStatus = Wldap32.ldap_unbind(ld);
row('ldap_unbind', unbindStatus === LDAP_SUCCESS ? `${GREEN}LDAP_SUCCESS${RESET}` : `${RED}${unbindStatus}${RESET}`);
row('LdapGetLastError', `${GREY}${Wldap32.LdapGetLastError()}${RESET}`);
console.log();
