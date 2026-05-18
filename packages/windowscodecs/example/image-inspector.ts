/**
 * Image Inspector
 *
 * Writes a small 24-bit BMP to a temp file, then walks the full Windows
 * Imaging Component decode pipeline against it: it opens a decoder from the
 * filename, pulls the first frame, queries dimensions / DPI / pixel format,
 * interrogates the decoder's codec info (friendly name, MIME types, container
 * format, capability flags), runs the frame through a 32bppBGRA format
 * converter, and computes channel statistics plus a colour histogram. Output
 * is a fully aligned, ANSI-coloured diagnostic report with an inline truecolor
 * thumbnail. Every WIC object is an opaque bigint handle read from an
 * out-parameter buffer — no casts anywhere.
 *
 * APIs demonstrated:
 *   - WICCreateImagingFactory_Proxy                      (bootstrap WIC)
 *   - IWICImagingFactory_CreateDecoderFromFilename_Proxy (open decoder)
 *   - IWICBitmapDecoder_GetFrameCount_Proxy              (frame count)
 *   - IWICBitmapDecoder_GetFrame_Proxy                   (first frame)
 *   - IWICBitmapDecoder_GetDecoderInfo_Proxy             (codec info object)
 *   - IWICComponentInfo_GetFriendlyName_Proxy            (codec name, sizing call)
 *   - IWICBitmapCodecInfo_GetMimeTypes_Proxy             (MIME types, sizing call)
 *   - IWICBitmapCodecInfo_GetContainerFormat_Proxy       (container GUID)
 *   - IWICBitmapCodecInfo_DoesSupportMultiframe_Proxy    (capability flag)
 *   - IWICBitmapCodecInfo_DoesSupportAnimation_Proxy     (capability flag)
 *   - IWICBitmapCodecInfo_DoesSupportLossless_Proxy      (capability flag)
 *   - IWICBitmapSource_GetSize_Proxy                     (pixel dimensions)
 *   - IWICBitmapSource_GetResolution_Proxy               (DPI)
 *   - IWICBitmapSource_GetPixelFormat_Proxy              (native pixel format)
 *   - IWICImagingFactory_CreateFormatConverter_Proxy     (create converter)
 *   - IWICFormatConverter_Initialize_Proxy               (→ 32bppBGRA)
 *   - IWICBitmapSource_CopyPixels_Proxy                  (read converted pixels)
 *   - WICMapGuidToShortName                              (GUID → friendly name)
 *
 * APIs demonstrated (ole32, cross-package):
 *   - CoInitialize                                       (init COM apartment)
 *
 * Run: bun run example/image-inspector.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Ole32 from '@bun-win32/ole32';

import WindowsCodecs, { WICBitmapDitherType, WICBitmapPaletteType, WICDecodeOptions, WINCODEC_SDK_VERSION } from '../index';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const RESET = '\x1b[0m';

const GENERIC_READ = 0x80000000;

function guid(data1: number, data2: number, data3: number, tail: number[]): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(data1 >>> 0, 0);
  buffer.writeUInt16LE(data2, 4);
  buffer.writeUInt16LE(data3, 6);
  for (let index = 0; index < 8; index++) buffer[8 + index] = tail[index]!;
  return buffer;
}

const GUID_WICPixelFormat32bppBGRA = guid(0x6fddc324, 0x4e03, 0x4bfe, [0xb1, 0x85, 0x3d, 0x77, 0x76, 0x8d, 0xc9, 0x0f]);

function check(label: string, hr: number): void {
  if (hr < 0) throw new Error(`${label} failed: 0x${(hr >>> 0).toString(16).padStart(8, '0')}`);
}

function take(slot: Buffer): bigint {
  return slot.readBigUInt64LE(0);
}

/** Two-call sizing pattern for the WCHAR-buffer codec-info getters. */
function readSized(call: (cch: number, buffer: Buffer | null, actual: Buffer) => number, label: string): string {
  const actual = Buffer.alloc(4);
  check(`${label} (size)`, call(0, null, actual));
  const count = actual.readUInt32LE(0);
  if (count === 0) return '';
  const text = Buffer.alloc(count * 2);
  check(label, call(count, text, actual));
  return text.toString('utf16le').replace(/\0.*$/, '');
}

function formatGuid(buffer: Buffer): string {
  const hex = (start: number, length: number) => buffer.subarray(start, start + length).toString('hex');
  const swap = (start: number, length: number) =>
    buffer
      .subarray(start, start + length)
      .reverse()
      .toString('hex');
  return `{${swap(0, 4)}-${swap(4, 2)}-${swap(6, 2)}-${hex(8, 2)}-${hex(10, 6)}}`;
}

/** WICMapGuidToShortName covers container/metadata GUIDs; fall back to the raw GUID. */
function safeShortName(guidBuffer: Buffer): string {
  const actual = Buffer.alloc(4);
  if (WindowsCodecs.WICMapGuidToShortName(guidBuffer.ptr!, 0, null, actual.ptr!) < 0) return formatGuid(guidBuffer);
  const count = actual.readUInt32LE(0);
  if (count === 0) return formatGuid(guidBuffer);
  const name = Buffer.alloc(count * 2);
  if (WindowsCodecs.WICMapGuidToShortName(guidBuffer.ptr!, count, name.ptr!, actual.ptr!) < 0) return formatGuid(guidBuffer);
  return name.toString('utf16le').replace(/\0.*$/, '');
}

/** Build a deterministic 24-bit BMP (bottom-up, BGR, 4-byte-aligned rows). */
function buildSampleBmp(width: number, height: number): Buffer {
  const rowStride = (width * 3 + 3) & ~3;
  const pixelBytes = rowStride * height;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10); // bfOffBits
  buffer.writeUInt32LE(40, 14); // biSize
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26); // biPlanes
  buffer.writeUInt16LE(24, 28); // biBitCount
  buffer.writeUInt32LE(pixelBytes, 34); // biSizeImage
  buffer.writeInt32LE(3780, 38); // 96 DPI in pixels/metre
  buffer.writeInt32LE(3780, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowStride;
    for (let x = 0; x < width; x++) {
      const offset = row + x * 3;
      buffer[offset + 0] = Math.round((y / height) * 255); // blue
      buffer[offset + 1] = Math.round(((x + y) / (width + height)) * 255); // green
      buffer[offset + 2] = Math.round((x / width) * 255); // red
    }
  }
  return buffer;
}

const SAMPLE_WIDTH = 96;
const SAMPLE_HEIGHT = 64;
const samplePath = join(tmpdir(), 'bun-win32-wic-inspector.bmp');
await Bun.write(samplePath, buildSampleBmp(SAMPLE_WIDTH, SAMPLE_HEIGHT));

Ole32.CoInitialize(null);

const factorySlot = Buffer.alloc(8);
check('WICCreateImagingFactory_Proxy', WindowsCodecs.WICCreateImagingFactory_Proxy(WINCODEC_SDK_VERSION, factorySlot.ptr!));
const factory = take(factorySlot);

const filename = Buffer.from(samplePath + '\0', 'utf16le');
const decoderSlot = Buffer.alloc(8);
check('CreateDecoderFromFilename', WindowsCodecs.IWICImagingFactory_CreateDecoderFromFilename_Proxy(factory, filename.ptr!, null, GENERIC_READ, WICDecodeOptions.WICDecodeMetadataCacheOnDemand, decoderSlot.ptr!));
const decoder = take(decoderSlot);

const frameCount = Buffer.alloc(4);
check('GetFrameCount', WindowsCodecs.IWICBitmapDecoder_GetFrameCount_Proxy(decoder, frameCount.ptr!));

const frameSlot = Buffer.alloc(8);
check('GetFrame', WindowsCodecs.IWICBitmapDecoder_GetFrame_Proxy(decoder, 0, frameSlot.ptr!));
const frame = take(frameSlot);

const widthBuffer = Buffer.alloc(4);
const heightBuffer = Buffer.alloc(4);
check('GetSize', WindowsCodecs.IWICBitmapSource_GetSize_Proxy(frame, widthBuffer.ptr!, heightBuffer.ptr!));
const imageWidth = widthBuffer.readUInt32LE(0);
const imageHeight = heightBuffer.readUInt32LE(0);

const dpiX = Buffer.alloc(8);
const dpiY = Buffer.alloc(8);
check('GetResolution', WindowsCodecs.IWICBitmapSource_GetResolution_Proxy(frame, dpiX.ptr!, dpiY.ptr!));

const pixelFormatGuid = Buffer.alloc(16);
check('GetPixelFormat', WindowsCodecs.IWICBitmapSource_GetPixelFormat_Proxy(frame, pixelFormatGuid.ptr!));

const pixelInfoSlot = Buffer.alloc(8);
check('CreateComponentInfo', WindowsCodecs.IWICImagingFactory_CreateComponentInfo_Proxy(factory, pixelFormatGuid.ptr!, pixelInfoSlot.ptr!));
const pixelInfo = take(pixelInfoSlot);
const pixelFormatName = readSized((cch, buffer, actual) => WindowsCodecs.IWICComponentInfo_GetFriendlyName_Proxy(pixelInfo, cch, buffer ? buffer.ptr! : null, actual.ptr!), 'PixelFormat GetFriendlyName');

const decoderInfoSlot = Buffer.alloc(8);
check('GetDecoderInfo', WindowsCodecs.IWICBitmapDecoder_GetDecoderInfo_Proxy(decoder, decoderInfoSlot.ptr!));
const decoderInfo = take(decoderInfoSlot);

const codecName = readSized((cch, buffer, actual) => WindowsCodecs.IWICComponentInfo_GetFriendlyName_Proxy(decoderInfo, cch, buffer ? buffer.ptr! : null, actual.ptr!), 'GetFriendlyName');
const mimeTypes = readSized((cch, buffer, actual) => WindowsCodecs.IWICBitmapCodecInfo_GetMimeTypes_Proxy(decoderInfo, cch, buffer ? buffer.ptr! : null, actual.ptr!), 'GetMimeTypes');

const containerGuid = Buffer.alloc(16);
check('GetContainerFormat', WindowsCodecs.IWICBitmapCodecInfo_GetContainerFormat_Proxy(decoderInfo, containerGuid.ptr!));
const containerName = safeShortName(containerGuid);

const flag = Buffer.alloc(4);
check('DoesSupportMultiframe', WindowsCodecs.IWICBitmapCodecInfo_DoesSupportMultiframe_Proxy(decoderInfo, flag.ptr!));
const supportsMultiframe = flag.readInt32LE(0) !== 0;
check('DoesSupportAnimation', WindowsCodecs.IWICBitmapCodecInfo_DoesSupportAnimation_Proxy(decoderInfo, flag.ptr!));
const supportsAnimation = flag.readInt32LE(0) !== 0;
check('DoesSupportLossless', WindowsCodecs.IWICBitmapCodecInfo_DoesSupportLossless_Proxy(decoderInfo, flag.ptr!));
const supportsLossless = flag.readInt32LE(0) !== 0;

const converterSlot = Buffer.alloc(8);
check('CreateFormatConverter', WindowsCodecs.IWICImagingFactory_CreateFormatConverter_Proxy(factory, converterSlot.ptr!));
const converter = take(converterSlot);
check(
  'FormatConverter.Initialize',
  WindowsCodecs.IWICFormatConverter_Initialize_Proxy(converter, frame, GUID_WICPixelFormat32bppBGRA.ptr!, WICBitmapDitherType.WICBitmapDitherTypeNone, 0n, 0, WICBitmapPaletteType.WICBitmapPaletteTypeCustom),
);

const stride = imageWidth * 4;
const pixels = Buffer.alloc(stride * imageHeight);
check('CopyPixels', WindowsCodecs.IWICBitmapSource_CopyPixels_Proxy(converter, null, stride, pixels.length, pixels.ptr!));

let sumR = 0;
let sumG = 0;
let sumB = 0;
let minLuma = 255;
let maxLuma = 0;
const histogram = new Array<number>(8).fill(0);
const pixelCount = imageWidth * imageHeight;
for (let index = 0; index < pixels.length; index += 4) {
  const b = pixels[index + 0]!;
  const g = pixels[index + 1]!;
  const r = pixels[index + 2]!;
  sumB += b;
  sumG += g;
  sumR += r;
  const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  if (luma < minLuma) minLuma = luma;
  if (luma > maxLuma) maxLuma = luma;
  histogram[Math.min(7, luma >> 5)]!++;
}

const pad = (label: string) => (label + ' ').padEnd(22, '.');
const bool = (value: boolean) => (value ? `${GREEN}yes${RESET}` : `${DIM}no${RESET}`);

console.log(`${BOLD}${CYAN}╔══ Windows Imaging Component — Image Inspector ══╗${RESET}`);
console.log(`${DIM}Sample written to ${samplePath}${RESET}\n`);
console.log(`${BOLD}Source${RESET}`);
console.log(`  ${pad('File')} ${samplePath}`);
console.log(`  ${pad('On-disk size')} ${Bun.file(samplePath).size.toLocaleString()} bytes`);
console.log(`\n${BOLD}Codec${RESET}`);
console.log(`  ${pad('Friendly name')} ${YELLOW}${codecName}${RESET}`);
console.log(`  ${pad('MIME types')} ${mimeTypes}`);
console.log(`  ${pad('Container format')} ${containerName}`);
console.log(`  ${pad('Frames')} ${frameCount.readUInt32LE(0)}`);
console.log(`  ${pad('Multiframe')} ${bool(supportsMultiframe)}`);
console.log(`  ${pad('Animation')} ${bool(supportsAnimation)}`);
console.log(`  ${pad('Lossless')} ${bool(supportsLossless)}`);
console.log(`\n${BOLD}Frame 0${RESET}`);
console.log(`  ${pad('Dimensions')} ${imageWidth} x ${imageHeight} px`);
console.log(`  ${pad('Resolution')} ${dpiX.readDoubleLE(0).toFixed(1)} x ${dpiY.readDoubleLE(0).toFixed(1)} DPI`);
console.log(`  ${pad('Native pixel format')} ${pixelFormatName}`);
console.log(`  ${pad('Pixels analysed')} ${pixelCount.toLocaleString()} (via 32bppBGRA converter)`);
console.log(`\n${BOLD}Channel averages${RESET}`);
console.log(`  ${pad('Red')}   ${YELLOW}${(sumR / pixelCount).toFixed(1)}${RESET}`);
console.log(`  ${pad('Green')} ${GREEN}${(sumG / pixelCount).toFixed(1)}${RESET}`);
console.log(`  ${pad('Blue')}  ${CYAN}${(sumB / pixelCount).toFixed(1)}${RESET}`);
console.log(`  ${pad('Luminance range')} ${minLuma} – ${maxLuma}`);

console.log(`\n${BOLD}Luminance histogram${RESET}`);
const peak = Math.max(...histogram);
for (let bucket = 0; bucket < histogram.length; bucket++) {
  const width = Math.round((histogram[bucket]! / peak) * 40);
  console.log(`  ${String(bucket * 32).padStart(3)}–${String(bucket * 32 + 31).padStart(3)} ${CYAN}${'█'.repeat(width)}${RESET} ${histogram[bucket]}`);
}

console.log(`\n${BOLD}Thumbnail${RESET} ${DIM}(nearest-sampled half-blocks)${RESET}`);
const thumbWidth = 48;
const thumbHeight = 24;
for (let ty = 0; ty < thumbHeight; ty += 2) {
  let line = '  ';
  for (let tx = 0; tx < thumbWidth; tx++) {
    const sx = Math.floor((tx / thumbWidth) * imageWidth);
    const topY = Math.floor((ty / thumbHeight) * imageHeight);
    const botY = Math.floor(((ty + 1) / thumbHeight) * imageHeight);
    const topOffset = topY * stride + sx * 4;
    const botOffset = botY * stride + sx * 4;
    line += `\x1b[38;2;${pixels[topOffset + 2]};${pixels[topOffset + 1]};${pixels[topOffset + 0]};48;2;${pixels[botOffset + 2]};${pixels[botOffset + 1]};${pixels[botOffset + 0]}m▀`;
  }
  console.log(line + RESET);
}
console.log(`\n${BOLD}${CYAN}╚══ ${pixelCount.toLocaleString()} pixels decoded through windowscodecs.dll ══╝${RESET}`);
