/**
 * Live Security Posture HUD
 *
 * A continuously refreshing Windows Security Center heads-up display. Every tick
 * it re-polls WscGetSecurityProviderHealth for each provider category and paints
 * a grid of colored status tiles plus an overall SECURE / AT RISK banner derived
 * from the aggregate health — a real-time Defender / firewall / UAC posture
 * monitor in pure TypeScript FFI, no shelling out to `Get-MpComputerStatus`.
 *
 * APIs demonstrated (Wscapi):
 *   - WscGetSecurityProviderHealth   (per-provider + aggregate health, polled live)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/security-dashboard.ts
 */
import Wscapi, { WSC_SECURITY_PROVIDER, WSC_SECURITY_PROVIDER_HEALTH } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Wscapi.Preload(['WscGetSecurityProviderHealth']);
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
const GREEN = '\x1b[38;2;90;220;130m';
const RED = '\x1b[38;2;240;85;85m';
const YELLOW = '\x1b[38;2;235;205;100m';
const CYAN = '\x1b[38;2;120;200;255m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';

const TILES: [string, WSC_SECURITY_PROVIDER][] = [
  ['FIREWALL', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_FIREWALL],
  ['ANTIVIRUS', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_ANTIVIRUS],
  ['AUTO-UPDATE', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_AUTOUPDATE_SETTINGS],
  ['INET ZONES', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_INTERNET_SETTINGS],
  ['UAC', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_USER_ACCOUNT_CONTROL],
  ['WSC SVC', WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_SERVICE],
];

function colorFor(code: number): string {
  if (code === WSC_SECURITY_PROVIDER_HEALTH.WSC_SECURITY_PROVIDER_HEALTH_GOOD) return GREEN;
  if (code === WSC_SECURITY_PROVIDER_HEALTH.WSC_SECURITY_PROVIDER_HEALTH_POOR) return RED;
  return YELLOW; // NOTMONITORED / SNOOZE
}

function labelFor(code: number): string {
  return (WSC_SECURITY_PROVIDER_HEALTH[code] ?? 'UNKNOWN').replace('WSC_SECURITY_PROVIDER_HEALTH_', '');
}

function renderTile(name: string, code: number, pulse: boolean): string[] {
  const c = colorFor(code);
  const fill = code === WSC_SECURITY_PROVIDER_HEALTH.WSC_SECURITY_PROVIDER_HEALTH_GOOD ? '█' : code === WSC_SECURITY_PROVIDER_HEALTH.WSC_SECURITY_PROVIDER_HEALTH_POOR ? '▒' : '▓';
  const glyph = pulse ? fill : code === WSC_SECURITY_PROVIDER_HEALTH.WSC_SECURITY_PROVIDER_HEALTH_GOOD ? '▓' : fill;
  const inner = glyph.repeat(15);
  return [`${c}┌───────────────┐${RESET}`, `${c}│${inner}│${RESET}`, `${c}│ ${BOLD}${name.padEnd(13)}${RESET}${c}│${RESET}`, `${c}│ ${labelFor(code).padEnd(13).slice(0, 13)} │${RESET}`, `${c}└───────────────┘${RESET}`];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TICKS = 12;

process.stdout.write(HIDE_CURSOR + CLEAR);
try {
  for (let tick = 0; tick < TICKS; tick++) {
    const pulse = tick % 2 === 0;
    let out = HOME;
    out += `${BOLD}${CYAN}╔═ LIVE SECURITY POSTURE ═════════════════════════════════╗${RESET}\n`;

    const tiles = TILES.map(([name, value]) => {
      const buf = Buffer.alloc(4);
      Wscapi.WscGetSecurityProviderHealth(value, buf.ptr);
      return renderTile(name, buf.readInt32LE(0), pulse);
    });

    // Lay out tiles 3 across.
    for (let row = 0; row < tiles.length; row += 3) {
      const group = tiles.slice(row, row + 3);
      for (let line = 0; line < 5; line++) {
        out += '  ' + group.map((t) => t[line]).join('  ') + '\n';
      }
      out += '\n';
    }

    const agg = Buffer.alloc(4);
    const aggHr = Wscapi.WscGetSecurityProviderHealth(WSC_SECURITY_PROVIDER.WSC_SECURITY_PROVIDER_ALL, agg.ptr);
    const aggCode = agg.readInt32LE(0);
    const secure = aggHr === 0 && aggCode === WSC_SECURITY_PROVIDER_HEALTH.WSC_SECURITY_PROVIDER_HEALTH_GOOD;
    const banner = secure ? `${GREEN}${BOLD}  ●  SYSTEM SECURE  ●  ${RESET}` : `${RED}${BOLD}  ▲  AT RISK — ${labelFor(aggCode)}  ▲  ${RESET}`;
    out += `${BOLD}${CYAN}╠═════════════════════════════════════════════════════════╣${RESET}\n`;
    out += `   ${banner}   ${DIM}tick ${tick + 1}/${TICKS}  ·  refresh ${(tick * 0.4).toFixed(1)}s${RESET}\n`;
    out += `${BOLD}${CYAN}╚═════════════════════════════════════════════════════════╝${RESET}\n`;
    out += `${DIM}   Polled live from Windows Security Center via WscGetSecurityProviderHealth${RESET}`;

    process.stdout.write(out);
    await sleep(400);
  }
  process.stdout.write('\n');
} finally {
  process.stdout.write(SHOW_CURSOR);
}
