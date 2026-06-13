/**
 * wifi-scan — a WiFi census with signal bars, decoded from wlanapi structs.
 *
 * Locale-proof and Unicode/emoji-SSID-proof (the bytes are read straight from
 * DOT11_SSID) — no netsh scraping, no Win11 field-order drift. Pass --fresh to
 * trigger a real WlanScan (~4 s settle) instead of the instant OS-cached list.
 *
 * APIs demonstrated:
 *   - wifiInterfaces / wifiConnection / wifiScan (wlanapi)
 *
 * Run: bun run example/wifi-scan.ts [--fresh]
 */

import { wifiConnection, wifiInterfaces, wifiScan } from '../index';

function signalBars(quality: number): string {
  const glyphs = '▁▂▃▄▅▆▇█';
  const level = Math.min(7, Math.max(0, Math.floor(quality / 12.5)));
  return glyphs.slice(0, level + 1).padEnd(8);
}

const interfaces = wifiInterfaces();
if (interfaces.length === 0) {
  console.log('No WiFi interface on this host (Ethernet-only).');
  process.exit(0);
}
for (const wireless of interfaces) console.log(`\x1b[36m${wireless.description}\x1b[0m  [${wireless.state}]`);

const connection = wifiConnection();
if (connection) {
  console.log(`\nConnected: \x1b[1m${connection.ssid}\x1b[0m  ${connection.signalQuality}%  ${connection.phyType}  ${connection.authAlgorithm}/${connection.cipherAlgorithm}  rx ${connection.rxRateMbps} Mbps  bssid ${connection.bssid}`);
}

const fresh = Bun.argv.includes('--fresh');
console.log(`\nVisible networks${fresh ? ' (fresh scan — waiting ~4 s)' : ' (cached)'}:`);
const networks = (await wifiScan({ triggerScan: fresh })).sort((a, b) => b.signalQuality - a.signalQuality);
for (const network of networks) {
  console.log(
    `  ${signalBars(network.signalQuality)} ${String(network.signalQuality).padStart(3)}%  ${(network.secured ? network.authAlgorithm : 'open').padEnd(10)} ${network.ssid}${network.connected ? ' \x1b[32m●\x1b[0m' : ''}${network.hasProfile ? ' \x1b[90m(saved)\x1b[0m' : ''}`,
  );
}
