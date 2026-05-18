/**
 * TPM Entropy Fountain
 *
 * A live visualization of hardware-true randomness. Every frame it submits a
 * real TPM2_GetRandom command to the Trusted Platform Module over TPM Base
 * Services and streams the bytes the silicon RNG returns into an animated
 * truecolor cascade, a live 0–255 byte-distribution histogram, and a running
 * Shannon-entropy estimate (bits/byte — a healthy hardware RNG hugs 8.0).
 * Nothing here is `Math.random()`: every glyph is entropy from the TPM chip,
 * pulled through pure FFI.
 *
 * APIs demonstrated (Tbs):
 *   - Tbsi_Context_Create     (open a TBS context for the TPM 2.0 device)
 *   - Tbsip_Submit_Command    (TPM2_GetRandom — hardware RNG)
 *   - Tbsip_Context_Close     (release the TBS context)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/tpm-entropy-fountain.ts
 */
import Tbs, { TBS_COMMAND_LOCALITY_ZERO, TBS_COMMAND_PRIORITY_NORMAL, TBS_CONTEXT_VERSION_TWO, TBS_SUCCESS } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Tbs.Preload(['Tbsi_Context_Create', 'Tbsip_Submit_Command', 'Tbsip_Context_Close']);
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
const CYAN = '\x1b[38;2;120;200;255m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';

const params = Buffer.alloc(8);
params.writeUInt32LE(TBS_CONTEXT_VERSION_TWO, 0);
params.writeUInt32LE(0b100, 4); // includeTpm20
const ctxBuf = Buffer.alloc(8);
if (Tbs.Tbsi_Context_Create(params.ptr, ctxBuf.ptr) !== TBS_SUCCESS) {
  console.error('Tbsi_Context_Create failed — no usable TPM 2.0 context');
  process.exit(1);
}
const hContext = ctxBuf.readBigUInt64LE(0);

const respBuf = Buffer.alloc(256);
const respLen = Buffer.alloc(4);

function tpmRandom(n: number): Buffer | null {
  const cmd = Buffer.alloc(12);
  cmd.writeUInt16BE(0x8001, 0); // TPM_ST_NO_SESSIONS
  cmd.writeUInt32BE(12, 2); // commandSize
  cmd.writeUInt32BE(0x0000017b, 6); // TPM_CC_GetRandom
  cmd.writeUInt16BE(n, 10); // bytesRequested
  respLen.writeUInt32LE(respBuf.byteLength, 0);
  if (Tbs.Tbsip_Submit_Command(hContext, TBS_COMMAND_LOCALITY_ZERO, TBS_COMMAND_PRIORITY_NORMAL, cmd.ptr, cmd.byteLength, respBuf.ptr, respLen.ptr) !== TBS_SUCCESS) return null;
  if (respBuf.readUInt32BE(6) !== 0) return null; // TPM responseCode
  const size = respBuf.readUInt16BE(10);
  return Buffer.from(respBuf.subarray(12, 12 + size));
}

const WIDTH = 56;
const histogram = new Float64Array(256);
let total = 0;

function rgb(b: number): string {
  // Map a byte to a smooth spectrum so the cascade shimmers.
  const h = (b / 255) * 300;
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  const [r, g, bl] = h < 60 ? [1, x, 0] : h < 120 ? [x, 1, 0] : h < 180 ? [0, 1, x] : h < 240 ? [0, x, 1] : [x, 0, 1];
  return `\x1b[38;2;${Math.round(r * 230 + 25)};${Math.round(g * 230 + 25)};${Math.round(bl * 230 + 25)}m`;
}

const GLYPHS = ' .:-=+*#%@█';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAMES = 60;

process.stdout.write(HIDE_CURSOR + CLEAR);
try {
  for (let frame = 0; frame < FRAMES; frame++) {
    const bytes = tpmRandom(WIDTH);
    if (!bytes) {
      console.log('TPM2_GetRandom failed mid-stream');
      break;
    }
    for (const b of bytes) {
      histogram[b]++;
      total++;
    }

    // Shannon entropy estimate over the running distribution.
    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      if (histogram[i]! > 0) {
        const p = histogram[i]! / total;
        entropy -= p * Math.log2(p);
      }
    }

    let out = HOME;
    out += `${BOLD}${CYAN}╔═ TPM ENTROPY FOUNTAIN ═══════════════════════════════════╗${RESET}\n`;
    const cascade = [...bytes].map((b) => `${rgb(b)}${GLYPHS[Math.floor((b / 256) * GLYPHS.length)]}`).join('');
    out += `  ${cascade}${RESET}\n`;
    out += `  ${[...bytes].map((b) => `${rgb(b)}${b.toString(16).padStart(2, '0')}`).join('')}${RESET}\n\n`;

    // 64-bucket histogram (4 byte-values per bucket), scaled to the peak.
    const buckets = new Array(64).fill(0);
    for (let i = 0; i < 256; i++) buckets[i >> 2] += histogram[i]!;
    const peak = Math.max(1, ...buckets);
    for (let row = 7; row >= 0; row--) {
      let line = '  ';
      for (let c = 0; c < 64; c++) {
        const h = (buckets[c] / peak) * 8;
        line += h > row + 0.5 ? `${rgb(c * 4)}█` : h > row ? `${rgb(c * 4)}▄` : ' ';
      }
      out += line + RESET + '\n';
    }
    out += `${BOLD}${CYAN}╠══════════════════════════════════════════════════════════╣${RESET}\n`;
    const bar = '█'.repeat(Math.round((entropy / 8) * 40)).padEnd(40, '░');
    out += `  ${BOLD}Shannon entropy${RESET} ${entropy.toFixed(4)} bits/byte  ${CYAN}[${bar}]${RESET}\n`;
    out += `  ${DIM}${total} bytes drawn from the hardware TPM RNG · frame ${frame + 1}/${FRAMES}${RESET}\n`;
    out += `${BOLD}${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}`;
    process.stdout.write(out);
    await sleep(60);
  }
  process.stdout.write('\n');
} finally {
  Tbs.Tbsip_Context_Close(hContext);
  process.stdout.write(SHOW_CURSOR);
}
