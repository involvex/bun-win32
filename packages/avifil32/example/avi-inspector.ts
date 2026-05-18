/**
 * AVI Inspector
 *
 * A thorough Video for Windows container diagnostic. Opens an AVI file (pass a
 * path as the first argument, or one is synthesized so the demo always runs),
 * then reports every documented field: file-level capabilities and flags, a
 * full per-stream breakdown (type, codec FourCC, timing, rectangle, quality,
 * sample size, name), the decoded stream format header (BITMAPINFOHEADER for
 * video, WAVEFORMATEX for audio), and — for the first video stream — a decoded
 * color thumbnail plus per-channel pixel statistics. Every value is labeled and
 * column-aligned; flag bitmasks are expanded to their symbolic names.
 *
 * APIs demonstrated (Avifil32):
 *   - AVIFileInit / AVIFileExit       (library lifecycle)
 *   - AVIFileOpenW                    (open the container)
 *   - AVIFileInfoW                    (file-level metadata + flags)
 *   - AVIFileGetStream                (enumerate every stream)
 *   - AVIStreamInfoW                  (per-stream metadata)
 *   - AVIStreamStart / AVIStreamLength (sample range)
 *   - AVIStreamSampleToTime           (range → wall-clock duration)
 *   - AVIStreamReadFormat             (size query, then decoded format header)
 *   - AVIStreamGetFrameOpen           (open a 24-bit RGB decompressor)
 *   - AVIStreamGetFrame               (decode a representative frame)
 *   - AVIStreamGetFrameClose          (release the decompressor)
 *   - AVIStreamRelease / AVIFileRelease (refcount cleanup)
 *   - AVIFileCreateStreamW / AVIStreamSetFormat / AVIStreamWrite (sample file)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode (enable ANSI VT output)
 *
 * Run: bun run example/avi-inspector.ts [path-to.avi]
 */
import { toArrayBuffer } from 'bun:ffi';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, statSync } from 'node:fs';

import Avifil32, { OpenFileFlags, StreamType, AviIndexFlags, AviFileInfoFlags, AviStreamInfoFlags } from '../index';
import Kernel32, { STD_HANDLE, ConsoleMode } from '@bun-win32/kernel32';

Avifil32.Preload([
  'AVIFileInit',
  'AVIFileExit',
  'AVIFileOpenW',
  'AVIFileInfoW',
  'AVIFileGetStream',
  'AVIStreamInfoW',
  'AVIStreamStart',
  'AVIStreamLength',
  'AVIStreamSampleToTime',
  'AVIStreamReadFormat',
  'AVIStreamGetFrameOpen',
  'AVIStreamGetFrame',
  'AVIStreamGetFrameClose',
  'AVIStreamRelease',
  'AVIFileRelease',
  'AVIFileCreateStreamW',
  'AVIStreamSetFormat',
  'AVIStreamWrite',
]);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const YELLOW = '\x1b[93m';
const GREEN = '\x1b[92m';
const RESET = '\x1b[0m';
const WIDTH = 78;

function wide(text: string): Buffer {
  return Buffer.from(text + '\0', 'utf16le');
}

function readWide(buffer: Uint8Array, byteOffset: number, maxChars: number): string {
  let result = '';
  for (let i = 0; i < maxChars; i++) {
    const code = buffer[byteOffset + i * 2]! | (buffer[byteOffset + i * 2 + 1]! << 8);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

function fourccToString(value: number): string {
  if (value === 0) return '(none)';
  let text = '';
  for (let shift = 0; shift < 32; shift += 8) {
    const code = (value >>> shift) & 0xff;
    text += code >= 32 && code < 127 ? String.fromCharCode(code) : ' ';
  }
  return text.trimEnd() || '(none)';
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return '0.000 s';
  const totalSeconds = milliseconds / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return minutes > 0 ? `${minutes}m ${seconds.toFixed(3)}s` : `${seconds.toFixed(3)} s`;
}

function decodeFlags(value: number, table: object): string {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(table)) {
    // Numeric enums also carry reverse number→name entries; keep only forward ones.
    if (typeof bit === 'number' && bit !== 0 && (value & bit) === bit) names.push(name);
  }
  return names.length ? names.join(' | ') : '(none)';
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(26)}${value}`;
}

function rule(title?: string): string {
  if (!title) return DIM + '─'.repeat(WIDTH) + RESET;
  const heading = ` ${title} `;
  const dashes = WIDTH - heading.length;
  const left = Math.max(2, Math.floor(dashes / 2));
  return DIM + '─'.repeat(left) + RESET + BOLD + CYAN + heading + RESET + DIM + '─'.repeat(Math.max(2, dashes - left)) + RESET;
}

function fail(api: string, hr: number): never {
  throw new Error(`${api} failed: 0x${(hr >>> 0).toString(16).padStart(8, '0')}`);
}

// Enable ANSI escape processing so colors render in modern terminals.
const stdoutHandle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const savedModeBuffer = Buffer.alloc(4);
let restoreConsoleMode = false;
if (Kernel32.GetConsoleMode(stdoutHandle, savedModeBuffer.ptr)) {
  Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  restoreConsoleMode = true;
}

Avifil32.AVIFileInit();

// ── Resolve the target file (use the CLI argument, else synthesize one) ─────
const argumentPath = process.argv[2];
let aviPath: string;
let synthesized = false;

if (argumentPath && existsSync(argumentPath)) {
  aviPath = argumentPath;
} else {
  if (argumentPath) console.log(`${YELLOW}"${argumentPath}" not found — synthesizing a sample clip.${RESET}\n`);
  synthesized = true;
  aviPath = join(tmpdir(), `bun-avifil32-sample-${process.pid}.avi`);
  rmSync(aviPath, { force: true });

  const sampleWidth = 160;
  const sampleHeight = 120;
  const sampleFps = 15;
  const sampleFrames = 30;
  const sampleStride = (sampleWidth * 3 + 3) & ~3;
  const sampleFrameBytes = sampleStride * sampleHeight;

  const filePtr = Buffer.alloc(8);
  let hr = Avifil32.AVIFileOpenW(filePtr.ptr, wide(aviPath).ptr, OpenFileFlags.OF_CREATE | OpenFileFlags.OF_WRITE, null);
  if (hr !== 0) fail('AVIFileOpenW (write)', hr);
  const file = filePtr.readBigUInt64LE(0);

  const streamInfo = Buffer.alloc(204);
  streamInfo.writeUInt32LE(StreamType.streamtypeVIDEO, 0);
  streamInfo.writeUInt32LE(0, 4);
  streamInfo.writeUInt32LE(1, 20); // dwScale
  streamInfo.writeUInt32LE(sampleFps, 24); // dwRate
  streamInfo.writeUInt32LE(sampleFrameBytes, 40); // dwSuggestedBufferSize
  streamInfo.writeInt32LE(sampleWidth, 60); // rcFrame.right
  streamInfo.writeInt32LE(sampleHeight, 64); // rcFrame.bottom
  // szName[64] WCHAR at offset 76.
  Buffer.from('Synthesized Gradient\0', 'utf16le').copy(streamInfo, 76);

  const streamPtr = Buffer.alloc(8);
  hr = Avifil32.AVIFileCreateStreamW(file, streamPtr.ptr, streamInfo.ptr);
  if (hr !== 0) fail('AVIFileCreateStreamW', hr);
  const stream = streamPtr.readBigUInt64LE(0);

  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0);
  bih.writeInt32LE(sampleWidth, 4);
  bih.writeInt32LE(sampleHeight, 8);
  bih.writeUInt16LE(1, 12);
  bih.writeUInt16LE(24, 14);
  bih.writeUInt32LE(0, 16);
  bih.writeUInt32LE(sampleFrameBytes, 20);
  hr = Avifil32.AVIStreamSetFormat(stream, 0, bih.ptr, 40);
  if (hr !== 0) fail('AVIStreamSetFormat', hr);

  const pixels = Buffer.alloc(sampleFrameBytes);
  for (let frame = 0; frame < sampleFrames; frame++) {
    for (let y = 0; y < sampleHeight; y++) {
      const rowBase = (sampleHeight - 1 - y) * sampleStride;
      for (let x = 0; x < sampleWidth; x++) {
        const offset = rowBase + x * 3;
        pixels[offset] = ((x * 255) / sampleWidth) | 0; // Blue ramps across
        pixels[offset + 1] = ((y * 255) / sampleHeight) | 0; // Green ramps down
        pixels[offset + 2] = ((frame * 255) / sampleFrames) | 0; // Red over time
      }
    }
    hr = Avifil32.AVIStreamWrite(stream, frame, 1, pixels.ptr, sampleFrameBytes, AviIndexFlags.AVIIF_KEYFRAME, null, null);
    if (hr !== 0) fail(`AVIStreamWrite (frame ${frame})`, hr);
  }

  Avifil32.AVIStreamRelease(stream);
  Avifil32.AVIFileRelease(file);
}

// ── Open and inspect ────────────────────────────────────────────────────────
const openFilePtr = Buffer.alloc(8);
let hr = Avifil32.AVIFileOpenW(openFilePtr.ptr, wide(aviPath).ptr, OpenFileFlags.OF_READ | OpenFileFlags.OF_SHARE_DENY_NONE, null);
if (hr !== 0) fail('AVIFileOpenW (read)', hr);
const aviFile = openFilePtr.readBigUInt64LE(0);

const fileInfo = Buffer.alloc(172); // sizeof(AVIFILEINFOW) on x64
hr = Avifil32.AVIFileInfoW(aviFile, fileInfo.ptr, fileInfo.byteLength);
if (hr !== 0) fail('AVIFileInfoW', hr);
const fileInfoView = new Uint8Array(fileInfo.buffer, fileInfo.byteOffset, fileInfo.byteLength);

const dwMaxBytesPerSec = fileInfo.readUInt32LE(0);
const fileFlags = fileInfo.readUInt32LE(4);
const dwStreams = fileInfo.readUInt32LE(12);
const fileBufferSize = fileInfo.readUInt32LE(16);
const fileWidth = fileInfo.readUInt32LE(20);
const fileHeight = fileInfo.readUInt32LE(24);
const fileScale = fileInfo.readUInt32LE(28);
const fileRate = fileInfo.readUInt32LE(32);
const fileLength = fileInfo.readUInt32LE(36);
const fileType = readWide(fileInfoView, 44, 64);

const sizeOnDisk = statSync(aviPath).size;

console.log();
console.log(rule('AVI INSPECTOR'));
console.log(`  ${BOLD}File${RESET}        ${aviPath}${synthesized ? `  ${DIM}(synthesized)${RESET}` : ''}`);
console.log(rule('File Header (AVIFILEINFO)'));
console.log(row('Size on disk', formatBytes(sizeOnDisk)));
console.log(row('Type', fileType || '(unspecified)'));
console.log(row('Streams', String(dwStreams)));
console.log(row('Frames', String(fileLength)));
console.log(row('Frame size', `${fileWidth} x ${fileHeight}`));
console.log(row('Timebase', fileScale > 0 ? `${(fileRate / fileScale).toFixed(3)} units/s (rate ${fileRate} / scale ${fileScale})` : `${fileRate} / ${fileScale}`));
console.log(row('Max data rate', `${formatBytes(dwMaxBytesPerSec)}/s`));
console.log(row('Suggested buffer', formatBytes(fileBufferSize)));
console.log(row('Flags', decodeFlags(fileFlags, AviFileInfoFlags)));

// ── Per-stream breakdown ────────────────────────────────────────────────────
for (let streamIndex = 0; streamIndex < dwStreams; streamIndex++) {
  const streamPtr = Buffer.alloc(8);
  // fccType = 0 → return the streamIndex-th stream of any type.
  hr = Avifil32.AVIFileGetStream(aviFile, streamPtr.ptr, 0, streamIndex);
  if (hr !== 0) {
    console.log(rule(`Stream ${streamIndex}`));
    console.log(`  ${YELLOW}AVIFileGetStream failed: 0x${(hr >>> 0).toString(16)}${RESET}`);
    continue;
  }
  const stream = streamPtr.readBigUInt64LE(0);

  const streamInfo = Buffer.alloc(204); // sizeof(AVISTREAMINFOW) on x64
  hr = Avifil32.AVIStreamInfoW(stream, streamInfo.ptr, streamInfo.byteLength);
  if (hr !== 0) {
    Avifil32.AVIStreamRelease(stream);
    continue;
  }
  const streamView = new Uint8Array(streamInfo.buffer, streamInfo.byteOffset, streamInfo.byteLength);

  const fccType = streamInfo.readUInt32LE(0);
  const fccHandler = streamInfo.readUInt32LE(4);
  const streamFlags = streamInfo.readUInt32LE(8);
  const dwScale = streamInfo.readUInt32LE(20);
  const dwRate = streamInfo.readUInt32LE(24);
  const dwStart = streamInfo.readUInt32LE(28);
  const dwLength = streamInfo.readUInt32LE(32);
  const dwSuggestedBufferSize = streamInfo.readUInt32LE(40);
  const dwQuality = streamInfo.readInt32LE(44);
  const dwSampleSize = streamInfo.readUInt32LE(48);
  const rcLeft = streamInfo.readInt32LE(52);
  const rcTop = streamInfo.readInt32LE(56);
  const rcRight = streamInfo.readInt32LE(60);
  const rcBottom = streamInfo.readInt32LE(64);
  const streamName = readWide(streamView, 76, 64);

  const typeText = fourccToString(fccType);
  const isVideo = fccType === StreamType.streamtypeVIDEO;
  const isAudio = fccType === StreamType.streamtypeAUDIO;
  const kind = isVideo ? 'video' : isAudio ? 'audio' : fccType === StreamType.streamtypeMIDI ? 'midi' : fccType === StreamType.streamtypeTEXT ? 'text' : typeText;

  const start = Avifil32.AVIStreamStart(stream);
  const length = Avifil32.AVIStreamLength(stream);
  const endMs = Avifil32.AVIStreamSampleToTime(stream, start + length);
  const startMs = Avifil32.AVIStreamSampleToTime(stream, start);
  const durationMs = endMs >= 0 && startMs >= 0 ? endMs - startMs : (length * dwScale * 1000) / Math.max(1, dwRate);

  console.log(rule(`Stream ${streamIndex}  ·  ${kind.toUpperCase()}`));
  console.log(row('Type / Handler', `${GREEN}${typeText}${RESET}  ·  codec ${GREEN}${fourccToString(fccHandler)}${RESET}`));
  if (streamName) console.log(row('Name', streamName));
  console.log(row('Rate', dwScale > 0 ? `${(dwRate / dwScale).toFixed(3)} ${isVideo ? 'fps' : 'samples/s'}  (${dwRate}/${dwScale})` : `${dwRate}/${dwScale}`));
  console.log(row('Samples', `${length}  (start ${start})`));
  console.log(row('Duration', formatDuration(durationMs)));
  console.log(row('Sample size', dwSampleSize === 0 ? 'variable (0)' : `${dwSampleSize} bytes`));
  console.log(row('Quality', dwQuality < 0 ? 'default (-1)' : `${dwQuality} / 10000`));
  console.log(row('Suggested buffer', formatBytes(dwSuggestedBufferSize)));
  if (isVideo) console.log(row('Frame rectangle', `(${rcLeft}, ${rcTop}) → (${rcRight}, ${rcBottom})`));
  console.log(row('Flags', decodeFlags(streamFlags, AviStreamInfoFlags)));

  // Decoded format header: size query first, then read.
  const formatSize = Buffer.alloc(4);
  Avifil32.AVIStreamReadFormat(stream, start, null, formatSize.ptr);
  const formatBytesNeeded = formatSize.readInt32LE(0);
  if (formatBytesNeeded > 0) {
    const format = Buffer.alloc(formatBytesNeeded);
    formatSize.writeInt32LE(formatBytesNeeded, 0);
    if (Avifil32.AVIStreamReadFormat(stream, start, format.ptr, formatSize.ptr) === 0) {
      if (isVideo && formatBytesNeeded >= 40) {
        // BITMAPINFOHEADER
        const biWidth = format.readInt32LE(4);
        const biHeight = format.readInt32LE(8);
        const biBitCount = format.readUInt16LE(14);
        const biCompression = format.readUInt32LE(16);
        const biSizeImage = format.readUInt32LE(20);
        console.log(row('Format', `BITMAPINFOHEADER (${formatBytesNeeded} bytes)`));
        console.log(row('  Dimensions', `${biWidth} x ${Math.abs(biHeight)} ${biHeight < 0 ? '(top-down)' : '(bottom-up)'}`));
        console.log(row('  Bit depth', `${biBitCount} bpp`));
        console.log(row('  Compression', biCompression === 0 ? 'BI_RGB (uncompressed)' : fourccToString(biCompression)));
        console.log(row('  Image bytes', formatBytes(biSizeImage)));
      } else if (isAudio && formatBytesNeeded >= 16) {
        // WAVEFORMATEX
        const wFormatTag = format.readUInt16LE(0);
        const nChannels = format.readUInt16LE(2);
        const nSamplesPerSec = format.readUInt32LE(4);
        const nAvgBytesPerSec = format.readUInt32LE(8);
        const wBitsPerSample = format.readUInt16LE(14);
        console.log(row('Format', `WAVEFORMATEX (${formatBytesNeeded} bytes)`));
        console.log(row('  Format tag', `0x${wFormatTag.toString(16).padStart(4, '0')}${wFormatTag === 1 ? ' (PCM)' : ''}`));
        console.log(row('  Channels', String(nChannels)));
        console.log(row('  Sample rate', `${nSamplesPerSec.toLocaleString()} Hz`));
        console.log(row('  Bit depth', `${wBitsPerSample}-bit`));
        console.log(row('  Data rate', `${formatBytes(nAvgBytesPerSec)}/s`));
      } else {
        console.log(row('Format', `${formatBytesNeeded} bytes (opaque)`));
      }
    }
  }

  // For video, decode a representative frame and show a colored thumbnail.
  if (isVideo && length > 0) {
    const requested = Buffer.alloc(40);
    requested.writeUInt32LE(40, 0);
    requested.writeInt32LE(rcRight > 0 ? rcRight : Math.max(1, fileWidth), 4);
    requested.writeInt32LE(rcBottom > 0 ? rcBottom : Math.max(1, fileHeight), 8);
    requested.writeUInt16LE(1, 12);
    requested.writeUInt16LE(24, 14);
    requested.writeUInt32LE(0, 16);

    const frameWidth = requested.readInt32LE(4);
    const frameHeight = requested.readInt32LE(8);
    const frameStride = (frameWidth * 3 + 3) & ~3;

    const getFrame = Avifil32.AVIStreamGetFrameOpen(stream, requested.ptr);
    if (getFrame) {
      const sampleAt = start + (length >> 1);
      const dibPointer = Avifil32.AVIStreamGetFrame(getFrame, sampleAt);
      if (dibPointer) {
        const dib = new Uint8Array(toArrayBuffer(dibPointer, 0, 40 + frameStride * frameHeight));
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let minLuma = 255;
        let maxLuma = 0;
        for (let y = 0; y < frameHeight; y++) {
          const rowBase = 40 + (frameHeight - 1 - y) * frameStride;
          for (let x = 0; x < frameWidth; x++) {
            const o = rowBase + x * 3;
            const b = dib[o]!;
            const g = dib[o + 1]!;
            const r = dib[o + 2]!;
            sumR += r;
            sumG += g;
            sumB += b;
            const luma = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
            if (luma < minLuma) minLuma = luma;
            if (luma > maxLuma) maxLuma = luma;
          }
        }
        const pixelCount = frameWidth * frameHeight;
        console.log(row('Decoded frame', `#${sampleAt}  ·  ${frameWidth} x ${frameHeight}`));
        console.log(row('  Mean RGB', `(${(sumR / pixelCount).toFixed(0)}, ${(sumG / pixelCount).toFixed(0)}, ${(sumB / pixelCount).toFixed(0)})`));
        console.log(row('  Luma range', `${minLuma} – ${maxLuma}`));

        // Colored thumbnail: downsample to a compact grid of half-block cells.
        const thumbColumns = Math.min(56, frameWidth);
        const thumbRows = Math.max(2, Math.min(18, Math.round((frameHeight / frameWidth) * thumbColumns * 0.5)));
        console.log(`  ${DIM}Thumbnail:${RESET}`);
        for (let cellRow = 0; cellRow < thumbRows; cellRow++) {
          let line = '    ';
          for (let cellCol = 0; cellCol < thumbColumns; cellCol++) {
            const sx = Math.floor((cellCol / thumbColumns) * frameWidth);
            const topImageY = Math.floor(((cellRow * 2) / (thumbRows * 2)) * frameHeight);
            const bottomImageY = Math.floor(((cellRow * 2 + 1) / (thumbRows * 2)) * frameHeight);
            const topOffset = 40 + (frameHeight - 1 - topImageY) * frameStride + sx * 3;
            const bottomOffset = 40 + (frameHeight - 1 - bottomImageY) * frameStride + sx * 3;
            line += `\x1b[38;2;${dib[topOffset + 2]!};${dib[topOffset + 1]!};${dib[topOffset]!}m` + `\x1b[48;2;${dib[bottomOffset + 2]!};${dib[bottomOffset + 1]!};${dib[bottomOffset]!}m▀`;
          }
          console.log(line + RESET);
        }
      }
      Avifil32.AVIStreamGetFrameClose(getFrame);
    }
  }

  Avifil32.AVIStreamRelease(stream);
}

console.log(rule());
Avifil32.AVIFileRelease(aviFile);
Avifil32.AVIFileExit();
if (synthesized) rmSync(aviPath, { force: true });
if (restoreConsoleMode) Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0));
console.log();
