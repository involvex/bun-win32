/**
 * Compression Arena
 *
 * Six contenders enter, one leaves with the smallest payload. This builds a
 * realistic ~2.5 MB mixed dataset (prose, JSON-ish records, repetitive markup,
 * pseudo-random noise) and races every algorithm the Windows Compression API
 * offers — MSZIP, XPRESS, XPRESS-Huffman, and LZMS — including two tuned
 * variants configured live through SetCompressorInformation (XPRESS-Huffman at
 * max level, LZMS with a 1 MiB block). Each contender is compressed, the tuned
 * settings are read back with QueryCompressorInformation to prove they stuck,
 * then the payload is decompressed and verified byte-for-byte. Results animate
 * into an ANSI dashboard: ratio bars ease open, throughput counters spin up,
 * and a champion is crowned. Every number on screen came back from cabinet.dll
 * over raw FFI — nothing is simulated.
 *
 * APIs demonstrated (Cabinet):
 *   - CreateCompressor / CreateDecompressor   (per-algorithm engines)
 *   - SetCompressorInformation                (tune XPRESS level, LZMS block)
 *   - SetDecompressorInformation              (match LZMS block on decode)
 *   - QueryCompressorInformation              (read tuned settings back)
 *   - Compress                                (sizing call, then real encode)
 *   - Decompress                              (round-trip integrity check)
 *   - CloseCompressor / CloseDecompressor     (engine teardown)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *   - SetConsoleTitleW                        (set the window title)
 *
 * Run: bun run example/compression-arena.ts
 */
import Cabinet, { COMPRESS_ALGORITHM, COMPRESS_INFORMATION_CLASS } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

Cabinet.Preload(['CreateCompressor', 'CreateDecompressor', 'SetCompressorInformation', 'SetDecompressorInformation', 'QueryCompressorInformation', 'Compress', 'Decompress', 'CloseCompressor', 'CloseDecompressor']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'SetConsoleTitleW']);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';
const HOME = '\x1b[H';

function wide(text: string): Buffer {
  return Buffer.from(text + '\0', 'utf16le');
}

const stdoutHandle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const savedModeBuffer = Buffer.alloc(4);
let restoreConsoleMode = false;
if (Kernel32.GetConsoleMode(stdoutHandle, savedModeBuffer.ptr)) {
  const previousMode = savedModeBuffer.readUInt32LE(0);
  Kernel32.SetConsoleMode(stdoutHandle, previousMode | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  restoreConsoleMode = true;
}
Kernel32.SetConsoleTitleW(wide('Compression Arena — @bun-win32/cabinet').ptr);

function restore(): void {
  process.stdout.write(SHOW_CURSOR + RESET);
  if (restoreConsoleMode) Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0));
}
process.on('exit', restore);
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

// Build a realistic, compressible-but-not-trivial dataset (~2.5 MB).
function buildDataset(): Buffer {
  const words = 'cabinet bun windows native ffi compress decompress xpress huffman lzms mszip ratio throughput payload archive entropy block stream buffer pointer kernel handle'.split(' ');
  const chunks: Buffer[] = [];
  let rng = 0x1234_5678;
  const nextRandom = (): number => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return (rng >>> 0) / 0xffff_ffff;
  };
  // Prose-like text (highly compressible)
  for (let paragraph = 0; paragraph < 1800; paragraph++) {
    const sentence: string[] = [];
    for (let w = 0; w < 24; w++) sentence.push(words[Math.floor(nextRandom() * words.length)]!);
    chunks.push(Buffer.from(`[${paragraph}] ` + sentence.join(' ') + '.\n', 'utf8'));
  }
  // JSON-ish records (structured, repetitive keys)
  for (let record = 0; record < 9000; record++) {
    chunks.push(Buffer.from(JSON.stringify({ id: record, name: words[record % words.length], size: (record * 7919) % 100000, active: record % 3 === 0, tags: [words[record % 5], words[record % 9]] }) + '\n', 'utf8'));
  }
  // Repetitive markup (extremely compressible)
  chunks.push(Buffer.from('<row><cell>data</cell><cell>data</cell></row>\n'.repeat(16000), 'utf8'));
  // Pseudo-random noise (nearly incompressible) — the great equalizer
  const noise = Buffer.alloc(768 * 1024);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(nextRandom() * 256);
  chunks.push(noise);
  return Buffer.concat(chunks);
}

const dataset = buildDataset();
const datasetSize = dataset.length;

interface Contender {
  label: string;
  color: string;
  algorithm: COMPRESS_ALGORITHM;
  level?: number;
  blockSize?: number;
}

const contenders: Contender[] = [
  { label: 'MSZIP', color: '\x1b[96m', algorithm: COMPRESS_ALGORITHM.COMPRESS_ALGORITHM_MSZIP },
  { label: 'XPRESS', color: '\x1b[94m', algorithm: COMPRESS_ALGORITHM.COMPRESS_ALGORITHM_XPRESS },
  { label: 'XPRESS-Huffman', color: '\x1b[92m', algorithm: COMPRESS_ALGORITHM.COMPRESS_ALGORITHM_XPRESS_HUFF },
  { label: 'XPRESS-Huffman · level 1', color: '\x1b[93m', algorithm: COMPRESS_ALGORITHM.COMPRESS_ALGORITHM_XPRESS_HUFF, level: 1 },
  { label: 'LZMS', color: '\x1b[95m', algorithm: COMPRESS_ALGORITHM.COMPRESS_ALGORITHM_LZMS },
  { label: 'LZMS · 1 MiB block', color: '\x1b[91m', algorithm: COMPRESS_ALGORITHM.COMPRESS_ALGORITHM_LZMS, blockSize: 1 << 20 },
];

interface Result {
  label: string;
  color: string;
  detail: string;
  compressedSize: number;
  ratio: number;
  compressMBps: number;
  decompressMBps: number;
  verified: boolean;
}

function dword(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function runContender(c: Contender): Result {
  // --- compressor ---
  const hC = Buffer.alloc(8);
  if (!Cabinet.CreateCompressor(c.algorithm, null, hC.ptr)) throw new Error(`CreateCompressor failed for ${c.label}`);
  const compressor = hC.readBigUInt64LE(0);

  let detail = '';
  if (c.level !== undefined) {
    Cabinet.SetCompressorInformation(compressor, COMPRESS_INFORMATION_CLASS.COMPRESS_INFORMATION_CLASS_LEVEL, dword(c.level).ptr, 4n);
    const readBack = Buffer.alloc(4);
    Cabinet.QueryCompressorInformation(compressor, COMPRESS_INFORMATION_CLASS.COMPRESS_INFORMATION_CLASS_LEVEL, readBack.ptr, 4n);
    detail = `level=${readBack.readUInt32LE(0)}`;
  }
  if (c.blockSize !== undefined) {
    Cabinet.SetCompressorInformation(compressor, COMPRESS_INFORMATION_CLASS.COMPRESS_INFORMATION_CLASS_BLOCK_SIZE, dword(c.blockSize).ptr, 4n);
    const readBack = Buffer.alloc(4);
    Cabinet.QueryCompressorInformation(compressor, COMPRESS_INFORMATION_CLASS.COMPRESS_INFORMATION_CLASS_BLOCK_SIZE, readBack.ptr, 4n);
    detail = `block=${(readBack.readUInt32LE(0) / 1024) | 0} KiB`;
  }

  // Sizing call: NULL output buffer to learn the required size.
  const sizeOut = Buffer.alloc(8);
  Cabinet.Compress(compressor, dataset.ptr, BigInt(datasetSize), null, 0n, sizeOut.ptr);
  const bound = Number(sizeOut.readBigUInt64LE(0));
  const compressed = Buffer.alloc(bound);

  const compressStart = Bun.nanoseconds();
  if (!Cabinet.Compress(compressor, dataset.ptr, BigInt(datasetSize), compressed.ptr, BigInt(compressed.length), sizeOut.ptr)) {
    throw new Error(`Compress failed for ${c.label}`);
  }
  const compressNs = Bun.nanoseconds() - compressStart;
  const compressedSize = Number(sizeOut.readBigUInt64LE(0));
  Cabinet.CloseCompressor(compressor);

  // --- decompressor ---
  const hD = Buffer.alloc(8);
  if (!Cabinet.CreateDecompressor(c.algorithm, null, hD.ptr)) throw new Error(`CreateDecompressor failed for ${c.label}`);
  const decompressor = hD.readBigUInt64LE(0);
  if (c.blockSize !== undefined) {
    Cabinet.SetDecompressorInformation(decompressor, COMPRESS_INFORMATION_CLASS.COMPRESS_INFORMATION_CLASS_BLOCK_SIZE, dword(c.blockSize).ptr, 4n);
  }
  const restored = Buffer.alloc(datasetSize);
  const restoredSizeOut = Buffer.alloc(8);

  const decompressStart = Bun.nanoseconds();
  if (!Cabinet.Decompress(decompressor, compressed.ptr, BigInt(compressedSize), restored.ptr, BigInt(restored.length), restoredSizeOut.ptr)) {
    throw new Error(`Decompress failed for ${c.label}`);
  }
  const decompressNs = Bun.nanoseconds() - decompressStart;
  const restoredSize = Number(restoredSizeOut.readBigUInt64LE(0));
  Cabinet.CloseDecompressor(decompressor);

  const verified = restoredSize === datasetSize && restored.equals(dataset);
  const mb = datasetSize / (1024 * 1024);

  return {
    label: c.label,
    color: c.color,
    detail,
    compressedSize,
    ratio: compressedSize / datasetSize,
    compressMBps: mb / (compressNs / 1e9),
    decompressMBps: mb / (decompressNs / 1e9),
    verified,
  };
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const BAR_WIDTH = 38;

function render(results: Result[], progress: number, championIndex: number): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${BOLD}╔════════════════════════════════════════════════════════════════════════╗${RESET}`);
  lines.push(`  ${BOLD}║                     C O M P R E S S I O N   A R E N A                  ║${RESET}`);
  lines.push(`  ${BOLD}╚════════════════════════════════════════════════════════════════════════╝${RESET}`);
  lines.push('');
  lines.push(`  ${DIM}Dataset${RESET} ${humanBytes(datasetSize)}   ${DIM}·${RESET}   ${DIM}cabinet.dll Compression API over raw Bun FFI${RESET}`);
  lines.push('');

  results.forEach((result, index) => {
    const shown = Math.min(1, progress);
    const animatedRatio = 1 - (1 - result.ratio) * easeOutCubic(shown);
    const savedFraction = 1 - animatedRatio;
    const filled = Math.round(savedFraction * BAR_WIDTH);
    const bar = `${result.color}${'█'.repeat(filled)}${RESET}${DIM}${'░'.repeat(BAR_WIDTH - filled)}${RESET}`;
    const isChamp = index === championIndex && progress >= 1;
    const crown = isChamp ? ` ${BOLD}\x1b[93m◄ CHAMPION${RESET}` : '';
    const labelCol = (isChamp ? BOLD : '') + result.label.padEnd(26) + RESET;
    const pct = (animatedRatio * 100).toFixed(1).padStart(5);
    const cMBps = (result.compressMBps * easeOutCubic(shown)).toFixed(0).padStart(5);
    const dMBps = (result.decompressMBps * easeOutCubic(shown)).toFixed(0).padStart(5);
    const tick = result.verified ? '\x1b[92m✓\x1b[0m' : '\x1b[91m✗\x1b[0m';
    const detailTag = result.detail ? ` ${DIM}(${result.detail})${RESET}` : '';
    lines.push(`  ${labelCol} ${bar} ${pct}%  ${DIM}→${RESET}${humanBytes(result.compressedSize).padStart(10)}  ${DIM}c${RESET}${cMBps} ${DIM}d${RESET}${dMBps} ${DIM}MB/s${RESET}  ${tick}${detailTag}${crown}`);
  });

  lines.push('');
  if (progress >= 1) {
    const champ = results[championIndex]!;
    const saved = datasetSize - champ.compressedSize;
    lines.push(
      `  ${BOLD}${champ.color}${champ.label}${RESET} wins — shrank ${humanBytes(datasetSize)} to ${humanBytes(champ.compressedSize)}, ` +
        `reclaiming ${BOLD}${humanBytes(saved)}${RESET} (${((saved / datasetSize) * 100).toFixed(1)}% smaller).`,
    );
    const allVerified = results.every((r) => r.verified);
    lines.push(`  ${allVerified ? '\x1b[92m' : '\x1b[91m'}${BOLD}Round-trip integrity: ${allVerified ? 'ALL PASS' : 'FAILURE'}${RESET} ${DIM}— every byte decompressed back identically.${RESET}`);
  } else {
    lines.push(`  ${DIM}Revealing results…${RESET}`);
  }
  lines.push('');
  process.stdout.write((progress === 0 ? CLEAR : HOME) + lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  process.stdout.write(CLEAR + HIDE_CURSOR);
  process.stdout.write(`\n  ${DIM}Generating dataset and warming up cabinet.dll…${RESET}\n`);

  const results: Result[] = [];
  for (const contender of contenders) results.push(runContender(contender));

  let championIndex = 0;
  results.forEach((r, i) => {
    if (r.compressedSize < results[championIndex]!.compressedSize) championIndex = i;
  });

  const frames = 48;
  for (let frame = 0; frame <= frames; frame++) {
    render(results, frame / frames, championIndex);
    await Bun.sleep(16);
  }
  render(results, 1, championIndex);
}

await main();
