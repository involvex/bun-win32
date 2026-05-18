/**
 * Terminal Cinema
 *
 * Synthesizes an animated RGB plasma as a real, uncompressed AVI video file on
 * disk using the Video for Windows AVIFile API, then reopens that file and
 * "plays" it back inside the terminal. Each frame is decoded through a GETFRAME
 * object and rendered with 24-bit ANSI color using the upper-half-block trick
 * (one character cell shows two vertical pixels: foreground = top pixel,
 * background = bottom pixel), so the picture has full color and double the
 * vertical resolution. Nothing here is faked — the pixels you see were written
 * to a .avi and read back out, frame by frame, over FFI.
 *
 * APIs demonstrated (Avifil32):
 *   - AVIFileInit / AVIFileExit      (library lifecycle)
 *   - AVIFileOpenW                   (create + reopen the .avi container)
 *   - AVIFileCreateStreamW           (add a video stream)
 *   - AVIStreamSetFormat             (declare a 24-bpp BI_RGB frame format)
 *   - AVIStreamWrite                 (encode synthesized frames)
 *   - AVIFileGetStream               (locate the video stream on read)
 *   - AVIStreamGetFrameOpen          (open a frame decompressor for 24-bit RGB)
 *   - AVIStreamGetFrame              (decode one frame to a packed DIB)
 *   - AVIStreamGetFrameClose         (release the decompressor)
 *   - AVIStreamStart / AVIStreamLength (frame range)
 *   - AVIStreamRelease / AVIFileRelease (refcount cleanup)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode (enable ANSI VT output)
 *   - SetConsoleTitleW               (set the window title)
 *
 * Run: bun run example/terminal-cinema.ts
 */
import { toArrayBuffer } from 'bun:ffi';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import Avifil32, { OpenFileFlags, StreamType, AviIndexFlags } from '../index';
import Kernel32, { STD_HANDLE, ConsoleMode } from '@bun-win32/kernel32';

Avifil32.Preload([
  'AVIFileInit',
  'AVIFileExit',
  'AVIFileOpenW',
  'AVIFileCreateStreamW',
  'AVIStreamSetFormat',
  'AVIStreamWrite',
  'AVIStreamRelease',
  'AVIFileRelease',
  'AVIFileGetStream',
  'AVIStreamStart',
  'AVIStreamLength',
  'AVIStreamGetFrameOpen',
  'AVIStreamGetFrame',
  'AVIStreamGetFrameClose',
]);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'SetConsoleTitleW']);

// One character cell renders two stacked pixels, so the pixel grid is sized to
// the terminal: full width, double the visible rows.
const columns = Math.max(24, Math.min(process.stdout.columns ?? 100, 120));
const rows = Math.max(8, Math.min((process.stdout.rows ?? 32) - 3, 40));
const gridWidth = columns;
const gridHeight = rows * 2;
const fps = 30;
const totalFrames = 90;
const loops = 2;

const stride = (gridWidth * 3 + 3) & ~3; // BI_RGB rows are 4-byte aligned
const frameBytes = stride * gridHeight;

const aviPath = join(tmpdir(), `bun-avifil32-cinema-${process.pid}.avi`);
rmSync(aviPath, { force: true });

const RESET = '\x1b[0m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';
const HOME = '\x1b[H';

function wide(text: string): Buffer {
  return Buffer.from(text + '\0', 'utf16le');
}

function fail(api: string, hr: number): never {
  throw new Error(`${api} failed: 0x${(hr >>> 0).toString(16).padStart(8, '0')}`);
}

// Enable ANSI escape processing so the 24-bit color codes render.
const stdoutHandle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const savedModeBuffer = Buffer.alloc(4);
let restoreConsoleMode = false;
if (Kernel32.GetConsoleMode(stdoutHandle, savedModeBuffer.ptr)) {
  const previousMode = savedModeBuffer.readUInt32LE(0);
  Kernel32.SetConsoleMode(stdoutHandle, previousMode | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  restoreConsoleMode = true;
}
Kernel32.SetConsoleTitleW(wide('Terminal Cinema — @bun-win32/avifil32').ptr);

Avifil32.AVIFileInit();

// ── Encode: synthesize a plasma animation into a real .avi ──────────────────
const writeFilePtr = Buffer.alloc(8);
let hr = Avifil32.AVIFileOpenW(writeFilePtr.ptr, wide(aviPath).ptr, OpenFileFlags.OF_CREATE | OpenFileFlags.OF_WRITE, null);
if (hr !== 0) fail('AVIFileOpenW (write)', hr);
const writeFile = writeFilePtr.readBigUInt64LE(0);

// AVISTREAMINFOW on x64 is 204 bytes; rcFrame (4 LONGs) begins at offset 52.
const streamInfo = Buffer.alloc(204);
streamInfo.writeUInt32LE(StreamType.streamtypeVIDEO, 0); // fccType
streamInfo.writeUInt32LE(0, 4); // fccHandler (0 = uncompressed)
streamInfo.writeUInt32LE(1, 20); // dwScale
streamInfo.writeUInt32LE(fps, 24); // dwRate  (frames/sec = dwRate / dwScale)
streamInfo.writeUInt32LE(frameBytes, 40); // dwSuggestedBufferSize
streamInfo.writeInt32LE(gridWidth, 60); // rcFrame.right
streamInfo.writeInt32LE(gridHeight, 64); // rcFrame.bottom

const writeStreamPtr = Buffer.alloc(8);
hr = Avifil32.AVIFileCreateStreamW(writeFile, writeStreamPtr.ptr, streamInfo.ptr);
if (hr !== 0) fail('AVIFileCreateStreamW', hr);
const writeStream = writeStreamPtr.readBigUInt64LE(0);

// BITMAPINFOHEADER: 24-bpp, BI_RGB, bottom-up.
function makeBitmapInfoHeader(): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(gridWidth, 4); // biWidth
  header.writeInt32LE(gridHeight, 8); // biHeight (> 0 = bottom-up)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(24, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(frameBytes, 20); // biSizeImage
  return header;
}

hr = Avifil32.AVIStreamSetFormat(writeStream, 0, makeBitmapInfoHeader().ptr, 40);
if (hr !== 0) fail('AVIStreamSetFormat', hr);

const pixels = Buffer.alloc(frameBytes);
for (let frame = 0; frame < totalFrames; frame++) {
  const t = frame * 0.13;
  for (let y = 0; y < gridHeight; y++) {
    // Store bottom-up so the decoded image is upright.
    const rowBase = (gridHeight - 1 - y) * stride;
    for (let x = 0; x < gridWidth; x++) {
      const v = Math.sin(x * 0.18 + t) + Math.sin(y * 0.22 - t) + Math.sin((x + y) * 0.12 + t) + Math.sin(Math.sqrt(x * x + y * y) * 0.16 - t);
      const offset = rowBase + x * 3;
      pixels[offset] = Math.floor(128 + 127 * Math.sin(v * Math.PI)); // Blue
      pixels[offset + 1] = Math.floor(128 + 127 * Math.sin(v * Math.PI + 2.094)); // Green
      pixels[offset + 2] = Math.floor(128 + 127 * Math.sin(v * Math.PI + 4.188)); // Red
    }
  }
  hr = Avifil32.AVIStreamWrite(writeStream, frame, 1, pixels.ptr, frameBytes, AviIndexFlags.AVIIF_KEYFRAME, null, null);
  if (hr !== 0) fail(`AVIStreamWrite (frame ${frame})`, hr);
}

Avifil32.AVIStreamRelease(writeStream);
Avifil32.AVIFileRelease(writeFile);

// ── Decode + play: read the .avi back, frame by frame, into the terminal ────
const readFilePtr = Buffer.alloc(8);
hr = Avifil32.AVIFileOpenW(readFilePtr.ptr, wide(aviPath).ptr, OpenFileFlags.OF_READ | OpenFileFlags.OF_SHARE_DENY_NONE, null);
if (hr !== 0) fail('AVIFileOpenW (read)', hr);
const readFile = readFilePtr.readBigUInt64LE(0);

const readStreamPtr = Buffer.alloc(8);
hr = Avifil32.AVIFileGetStream(readFile, readStreamPtr.ptr, StreamType.streamtypeVIDEO, 0);
if (hr !== 0) fail('AVIFileGetStream', hr);
const readStream = readStreamPtr.readBigUInt64LE(0);

const firstFrame = Avifil32.AVIStreamStart(readStream);
const frameCount = Avifil32.AVIStreamLength(readStream);

// Ask the decompressor for a known layout (24-bpp BI_RGB) so rendering is
// deterministic regardless of how the stream was stored.
const getFrame = Avifil32.AVIStreamGetFrameOpen(readStream, makeBitmapInfoHeader().ptr);
if (!getFrame) throw new Error('AVIStreamGetFrameOpen returned NULL — no decompressor available');

let interrupted = false;
function cleanup(): void {
  Avifil32.AVIStreamGetFrameClose(getFrame);
  Avifil32.AVIStreamRelease(readStream);
  Avifil32.AVIFileRelease(readFile);
  Avifil32.AVIFileExit();
  rmSync(aviPath, { force: true });
  process.stdout.write(SHOW_CURSOR + RESET + '\n');
  if (restoreConsoleMode) Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0));
}
process.on('SIGINT', () => {
  interrupted = true;
});

process.stdout.write(CLEAR + HIDE_CURSOR);

const frameInterval = 1000 / fps;
try {
  for (let loop = 0; loop < loops && !interrupted; loop++) {
    for (let i = 0; i < frameCount && !interrupted; i++) {
      const tick = Bun.nanoseconds();
      const dibPointer = Avifil32.AVIStreamGetFrame(getFrame, firstFrame + i);
      if (!dibPointer) continue;

      // Packed DIB: BITMAPINFOHEADER (40 bytes) then bottom-up BGR pixel rows.
      const dib = new Uint8Array(toArrayBuffer(dibPointer, 0, 40 + frameBytes));
      const lines: string[] = [];
      for (let cellRow = 0; cellRow < rows; cellRow++) {
        const topY = cellRow * 2;
        const bottomY = topY + 1;
        let line = '';
        let lastTop = -1;
        let lastBottom = -1;
        for (let x = 0; x < gridWidth; x++) {
          // Image is bottom-up: image row r lives at buffer row (height-1-r).
          const topOffset = 40 + (gridHeight - 1 - topY) * stride + x * 3;
          const bottomOffset = 40 + (gridHeight - 1 - bottomY) * stride + x * 3;
          const tr = dib[topOffset + 2]!;
          const tg = dib[topOffset + 1]!;
          const tb = dib[topOffset]!;
          const br = dib[bottomOffset + 2]!;
          const bg = dib[bottomOffset + 1]!;
          const bb = dib[bottomOffset]!;
          const topKey = (tr << 16) | (tg << 8) | tb;
          const bottomKey = (br << 16) | (bg << 8) | bb;
          if (topKey !== lastTop) {
            line += `\x1b[38;2;${tr};${tg};${tb}m`;
            lastTop = topKey;
          }
          if (bottomKey !== lastBottom) {
            line += `\x1b[48;2;${br};${bg};${bb}m`;
            lastBottom = bottomKey;
          }
          line += '▀'; // ▀ upper half block
        }
        lines.push(line + RESET);
      }
      process.stdout.write(HOME + lines.join('\n'));

      const elapsedMs = (Bun.nanoseconds() - tick) / 1e6;
      const sleepMs = frameInterval - elapsedMs;
      if (sleepMs > 0) await Bun.sleep(sleepMs);
    }
  }
} finally {
  cleanup();
}
