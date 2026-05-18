/**
 * Plasma Forge
 *
 * Synthesizes a 512x512 RGBA plasma field entirely in memory, hands the raw
 * pixels to the Windows Imaging Component as an IWICBitmap, then asks WIC's
 * high-quality cubic scaler to resample it down to the exact terminal size.
 * The resampled pixels are read back and painted as Unicode half-blocks with
 * 24-bit ANSI color — two image rows per character cell. Every WIC object is
 * an opaque bigint token obtained from an out-parameter buffer; nothing is
 * cast, and no file ever touches the disk.
 *
 * APIs demonstrated:
 *   - WICCreateImagingFactory_Proxy               (bootstrap the WIC factory)
 *   - IWICImagingFactory_CreateBitmapFromMemory_Proxy (wrap a raw pixel buffer)
 *   - IWICImagingFactory_CreateBitmapScaler_Proxy (create a scaler)
 *   - IWICBitmapScaler_Initialize_Proxy           (high-quality cubic resample)
 *   - IWICBitmapSource_GetSize_Proxy              (confirm scaled dimensions)
 *   - IWICBitmapSource_CopyPixels_Proxy           (read resampled pixels back)
 *
 * APIs demonstrated (ole32, cross-package):
 *   - CoInitialize                                (initialize the COM apartment)
 *
 * Run: bun run example/plasma-forge.ts
 */

import Ole32 from '@bun-win32/ole32';

import WindowsCodecs, { WICBitmapInterpolationMode, WINCODEC_SDK_VERSION } from '../index';

const RESET = '\x1b[0m';

/** Pack a DEFINE_GUID(...) declaration into its 16-byte little-endian layout. */
function guid(data1: number, data2: number, data3: number, tail: number[]): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(data1 >>> 0, 0);
  buffer.writeUInt16LE(data2, 4);
  buffer.writeUInt16LE(data3, 6);
  for (let index = 0; index < 8; index++) buffer[8 + index] = tail[index]!;
  return buffer;
}

// GUID_WICPixelFormat32bppBGRA — 8 bits each, blue/green/red/alpha order.
const GUID_WICPixelFormat32bppBGRA = guid(0x6fddc324, 0x4e03, 0x4bfe, [0xb1, 0x85, 0x3d, 0x77, 0x76, 0x8d, 0xc9, 0x0f]);

function check(label: string, hr: number): void {
  if (hr < 0) throw new Error(`${label} failed: 0x${(hr >>> 0).toString(16).padStart(8, '0')}`);
}

/** Read an interface pointer that a WIC out-parameter wrote into `slot`. */
function take(slot: Buffer): bigint {
  return slot.readBigUInt64LE(0);
}

Ole32.CoInitialize(null);

const sourceWidth = 512;
const sourceHeight = 512;
const sourceStride = sourceWidth * 4;
const sourcePixels = Buffer.alloc(sourceStride * sourceHeight);

// Classic multi-wave plasma → HSV → BGRA. Pure math, no allocations per pixel.
for (let y = 0; y < sourceHeight; y++) {
  for (let x = 0; x < sourceWidth; x++) {
    const wave = Math.sin(x / 37.0) + Math.sin(y / 31.0) + Math.sin((x + y) / 41.0) + Math.sin(Math.sqrt((x - 256) ** 2 + (y - 256) ** 2) / 29.0);
    const hue = ((wave + 4) / 8) * 360;
    const saturation = 0.85;
    const value = 0.65 + 0.35 * Math.sin(wave * 1.7);
    const chroma = value * saturation;
    const huePrime = hue / 60;
    const second = chroma * (1 - Math.abs((huePrime % 2) - 1));
    const match = value - chroma;
    let red = 0;
    let green = 0;
    let blue = 0;
    if (huePrime < 1) [red, green, blue] = [chroma, second, 0];
    else if (huePrime < 2) [red, green, blue] = [second, chroma, 0];
    else if (huePrime < 3) [red, green, blue] = [0, chroma, second];
    else if (huePrime < 4) [red, green, blue] = [0, second, chroma];
    else if (huePrime < 5) [red, green, blue] = [second, 0, chroma];
    else [red, green, blue] = [chroma, 0, second];
    const offset = y * sourceStride + x * 4;
    sourcePixels[offset + 0] = Math.round((blue + match) * 255);
    sourcePixels[offset + 1] = Math.round((green + match) * 255);
    sourcePixels[offset + 2] = Math.round((red + match) * 255);
    sourcePixels[offset + 3] = 0xff;
  }
}

const factorySlot = Buffer.alloc(8);
check('WICCreateImagingFactory_Proxy', WindowsCodecs.WICCreateImagingFactory_Proxy(WINCODEC_SDK_VERSION, factorySlot.ptr!));
const factory = take(factorySlot);

const bitmapSlot = Buffer.alloc(8);
check('CreateBitmapFromMemory', WindowsCodecs.IWICImagingFactory_CreateBitmapFromMemory_Proxy(factory, sourceWidth, sourceHeight, GUID_WICPixelFormat32bppBGRA.ptr!, sourceStride, sourcePixels.length, sourcePixels.ptr!, bitmapSlot.ptr!));
const bitmap = take(bitmapSlot);

const scalerSlot = Buffer.alloc(8);
check('CreateBitmapScaler', WindowsCodecs.IWICImagingFactory_CreateBitmapScaler_Proxy(factory, scalerSlot.ptr!));
const scaler = take(scalerSlot);

const columns = Math.max(16, Math.min(process.stdout.columns ?? 100, 160));
const rows = Math.max(8, (process.stdout.rows ?? 32) - 4);
const targetWidth = columns;
const targetHeight = rows * 2; // two stacked pixels per character row

check('IWICBitmapScaler_Initialize', WindowsCodecs.IWICBitmapScaler_Initialize_Proxy(scaler, bitmap, targetWidth, targetHeight, WICBitmapInterpolationMode.WICBitmapInterpolationModeHighQualityCubic));

const sizeWidth = Buffer.alloc(4);
const sizeHeight = Buffer.alloc(4);
check('IWICBitmapSource_GetSize', WindowsCodecs.IWICBitmapSource_GetSize_Proxy(scaler, sizeWidth.ptr!, sizeHeight.ptr!));
const scaledWidth = sizeWidth.readUInt32LE(0);
const scaledHeight = sizeHeight.readUInt32LE(0);

const targetStride = scaledWidth * 4;
const scaledPixels = Buffer.alloc(targetStride * scaledHeight);
check('IWICBitmapSource_CopyPixels', WindowsCodecs.IWICBitmapSource_CopyPixels_Proxy(scaler, null, targetStride, scaledPixels.length, scaledPixels.ptr!));

const lines: string[] = [];
for (let cellRow = 0; cellRow + 1 < scaledHeight; cellRow += 2) {
  let line = '';
  for (let x = 0; x < scaledWidth; x++) {
    const top = cellRow * targetStride + x * 4;
    const bottom = (cellRow + 1) * targetStride + x * 4;
    const tb = scaledPixels[top + 0];
    const tg = scaledPixels[top + 1];
    const tr = scaledPixels[top + 2];
    const bb = scaledPixels[bottom + 0];
    const bg = scaledPixels[bottom + 1];
    const br = scaledPixels[bottom + 2];
    line += `\x1b[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m▀`;
  }
  lines.push(line + RESET);
}

console.log(`\x1b[1mPlasma Forge\x1b[0m — 512x512 synthesized, WIC-resampled to ${scaledWidth}x${scaledHeight}`);
console.log(lines.join('\n'));
console.log(`${RESET}Rendered ${scaledWidth * scaledHeight} pixels through windowscodecs.dll — pure FFI, zero files.`);
