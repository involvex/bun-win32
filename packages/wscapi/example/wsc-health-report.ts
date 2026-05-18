/**
 * Windows Security Center Health Report
 *
 * A thorough Windows Security Center (WSC) diagnostic. It queries the aggregate
 * health of every security provider category — firewall, automatic updates,
 * antivirus, antispyware, internet settings, User Account Control, and the WSC
 * service itself — individually and combined, decoding each WSC_SECURITY_PROVIDER_HEALTH
 * value into a colored pillar. It then probes the Windows Store antimalware URI
 * APIs and the COM-server unload state, decoding every HRESULT instead of hiding
 * a failure (E_NOTIMPL is expected when no Store antimalware context exists).
 *
 * APIs demonstrated (Wscapi):
 *   - WscGetSecurityProviderHealth   (aggregate health per provider bitmask)
 *   - WscQueryAntiMalwareUri         (ask the Store for the antimalware URI)
 *   - WscGetAntiMalwareUri           (retrieve the queried Store URI)
 *   - DllCanUnloadNow                (COM in-proc server unload state)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/wsc-health-report.ts
 */
import Wscapi, { WSC_SECURITY_PROVIDER, WSC_SECURITY_PROVIDER_HEALTH } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Wscapi.Preload(['WscGetSecurityProviderHealth', 'WscQueryAntiMalwareUri', 'WscGetAntiMalwareUri', 'DllCanUnloadNow']);
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

const PROVIDERS: [string, WSC_SECURITY_PROVIDER][] = [
  ['Firewall', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_FIREWALL],
  ['Automatic Updates', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_AUTOUPDATE_SETTINGS],
  ['Antivirus', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_ANTIVIRUS],
  ['Antispyware', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_ANTISPYWARE],
  ['Internet Settings', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_INTERNET_SETTINGS],
  ['User Account Control', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_USER_ACCOUNT_CONTROL],
  ['WSC Service', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_SERVICE],
];

function healthStyle(code: number): { label: string; color: string; pillar: string } {
  switch (code) {
    case WSC_SECURITY_PROVIDER_HEALTH.WSC_SECURITY_PROVIDER_HEALTH_GOOD:
      return { label: 'GOOD', color: GREEN, pillar: '████' };
    case WSC_SECURITY_PROVIDER_HEALTH.WSC_SECURITY_PROVIDER_HEALTH_NOTMONITORED:
      return { label: 'NOT MONITORED', color: YELLOW, pillar: '██░░' };
    case WSC_SECURITY_PROVIDER_HEALTH.WSC_SECURITY_PROVIDER_HEALTH_POOR:
      return { label: 'POOR', color: RED, pillar: '█░░░' };
    case WSC_SECURITY_PROVIDER_HEALTH.WSC_SECURITY_PROVIDER_HEALTH_SNOOZE:
      return { label: 'SNOOZE', color: YELLOW, pillar: '██░░' };
    default:
      return { label: `UNKNOWN(${code})`, color: DIM, pillar: '????' };
  }
}

function decodeHResult(hr: number): string {
  const map: Record<number, string> = {
    0: 'S_OK',
    1: 'S_FALSE',
    [-2147467263]: 'E_NOTIMPL',
    [-2147467259]: 'E_FAIL',
    [-2147024891]: 'E_ACCESSDENIED',
    [-2147024809]: 'E_INVALIDARG',
  };
  return map[hr] ?? `0x${(hr >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

console.log(`${BOLD}${CYAN}Windows Security Center Health Report${RESET}  ${DIM}wscapi.dll${RESET}\n`);

console.log(`${BOLD}Security Providers${RESET}`);
console.log(`${DIM}${pad('Provider', 24)}${pad('Pillar', 8)}${pad('Health', 16)}HRESULT${RESET}`);

for (const [name, value] of PROVIDERS) {
  const health = Buffer.alloc(4);
  const hr = Wscapi.WscGetSecurityProviderHealth(value, health.ptr);
  const code = health.readInt32LE(0);
  const s = healthStyle(code);
  console.log(`${pad(name, 24)}${s.color}${pad(s.pillar, 8)}${pad(s.label, 16)}${RESET}${DIM}${decodeHResult(hr)}${RESET}`);
}

const allBuf = Buffer.alloc(4);
const allHr = Wscapi.WscGetSecurityProviderHealth(WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_ALL, allBuf.ptr);
const allCode = allBuf.readInt32LE(0);
const allStyle = healthStyle(allCode);
console.log(`\n${BOLD}Aggregate (ALL)${RESET}  ${allStyle.color}${allStyle.pillar} ${allStyle.label}${RESET}  ${DIM}${decodeHResult(allHr)} — ` + `the health of the least-healthy category${RESET}`);
if (allHr === 1) console.log(`  ${YELLOW}WSC service not running → result forced to POOR (documented S_FALSE behavior)${RESET}`);

console.log(`\n${BOLD}Windows Store Antimalware URI${RESET}`);
const qHr = Wscapi.WscQueryAntiMalwareUri();
console.log(`  WscQueryAntiMalwareUri → ${decodeHResult(qHr)}`);
const uriPtrBuf = Buffer.alloc(8);
const gHr = Wscapi.WscGetAntiMalwareUri(uriPtrBuf.ptr);
const uriPtr = uriPtrBuf.readBigUInt64LE(0);
if (gHr === 0 && uriPtr !== 0n) {
  // Provider allocated a wide URI string; the out-pointer is non-null.
  console.log(`  WscGetAntiMalwareUri   → S_OK ${CYAN}(Store URI at 0x${uriPtr.toString(16)})${RESET}`);
} else {
  console.log(`  WscGetAntiMalwareUri   → ${decodeHResult(gHr)} ${DIM}(no Store antimalware context — expected off the Store/S-mode path)${RESET}`);
}

console.log(`\n${BOLD}COM Server${RESET}`);
console.log(`  DllCanUnloadNow → ${decodeHResult(Wscapi.DllCanUnloadNow())}\n`);

console.log(`${DIM}WSC tracks antivirus status as of Windows 10 1607; standalone antispyware is no longer tracked. ` + `S_FALSE from WscGetSecurityProviderHealth means the WSC service is stopped.${RESET}`);
