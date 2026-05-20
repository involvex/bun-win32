/**
 * Internal screenshot utility for the showcase. NOT a user-facing demo.
 *
 * Usage: bun ./example/_screenshot.ts <demo-name> [<delay-ms>]
 *
 * Launches `bun run example/<demo-name>.ts` in the background, waits `delay-ms`
 * (default 4000) for the demo to render, captures the entire primary monitor
 * via GDI BitBlt → Gdiplus PNG encoder, then terminates the demo and exits.
 *
 * Output: ./screenshots/<demo-name>.png
 */

import { spawn } from 'bun';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { GDI32, Gdiplus, User32 } from '../index';
import { Status } from '@bun-win32/gdiplus';
import { SystemMetric } from '@bun-win32/user32';

Gdiplus.Preload();

const demoName = process.argv[2];
const delayMs = Number.parseInt(process.argv[3] ?? '4000', 10);
if (!demoName) {
  console.error('usage: bun ./example/_screenshot.ts <demo-name> [delay-ms]');
  process.exit(1);
}

const screenshotsDir = resolve(import.meta.dir, '..', 'screenshots');
mkdirSync(screenshotsDir, { recursive: true });

const outputPath = resolve(screenshotsDir, `${demoName}.png`);
const demoPath = resolve(import.meta.dir, `${demoName}.ts`);

console.log(`[screenshot] launching ${demoName}…`);
const child = spawn({
  cmd: ['bun', 'run', demoPath],
  cwd: resolve(import.meta.dir, '..'),
  stdout: 'ignore',
  stderr: 'ignore',
  stdin: 'ignore',
});

console.log(`[screenshot] waiting ${delayMs} ms for render…`);
await Bun.sleep(delayMs);

console.log('[screenshot] capturing primary monitor…');

const width = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const height = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
console.log(`[screenshot] primary monitor is ${width}x${height}`);

const hdcScreen = User32.GetDC(0n);
if (!hdcScreen) {
  console.error('[screenshot] GetDC failed');
  child.kill();
  process.exit(2);
}

const hdcMem = GDI32.CreateCompatibleDC(hdcScreen);
const hBitmap = GDI32.CreateCompatibleBitmap(hdcScreen, width, height);
const oldObject = GDI32.SelectObject(hdcMem, hBitmap);

const SRCCOPY = 0x00cc0020;
GDI32.BitBlt(hdcMem, 0, 0, width, height, hdcScreen, 0, 0, SRCCOPY);

const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0);
const startupStatus = Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr!, gdiplusStartupInput.ptr!, null);
if (startupStatus !== Status.Ok) {
  console.error(`[screenshot] GdiplusStartup failed: ${startupStatus}`);
  GDI32.SelectObject(hdcMem, oldObject);
  GDI32.DeleteObject(hBitmap);
  GDI32.DeleteDC(hdcMem);
  User32.ReleaseDC(0n, hdcScreen);
  child.kill();
  process.exit(3);
}
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

const bitmapBuffer = Buffer.alloc(8);
const fromHbitmapStatus = Gdiplus.GdipCreateBitmapFromHBITMAP(hBitmap, 0n, bitmapBuffer.ptr!);
if (fromHbitmapStatus !== Status.Ok) {
  console.error(`[screenshot] GdipCreateBitmapFromHBITMAP failed: ${fromHbitmapStatus}`);
  Gdiplus.GdiplusShutdown(gdiplusToken);
  GDI32.SelectObject(hdcMem, oldObject);
  GDI32.DeleteObject(hBitmap);
  GDI32.DeleteDC(hdcMem);
  User32.ReleaseDC(0n, hdcScreen);
  child.kill();
  process.exit(4);
}
const gdiplusBitmap = bitmapBuffer.readBigUInt64LE(0);

// Well-known PNG encoder CLSID: 557CF402-1A04-11D3-9A73-0000F81EF32E
const pngClsid = Buffer.alloc(16);
pngClsid.writeUInt32LE(0x557cf402, 0);
pngClsid.writeUInt16LE(0x1a04, 4);
pngClsid.writeUInt16LE(0x11d3, 6);
pngClsid.set([0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e], 8);

const outputBuffer = Buffer.from(outputPath + '\0', 'utf16le');
const saveStatus = Gdiplus.GdipSaveImageToFile(gdiplusBitmap, outputBuffer.ptr!, pngClsid.ptr!, null);
if (saveStatus !== Status.Ok) {
  console.error(`[screenshot] GdipSaveImageToFile failed: ${saveStatus}`);
} else {
  console.log(`[screenshot] saved → ${outputPath}`);
}

Gdiplus.GdipDisposeImage(gdiplusBitmap);
Gdiplus.GdiplusShutdown(gdiplusToken);
GDI32.SelectObject(hdcMem, oldObject);
GDI32.DeleteObject(hBitmap);
GDI32.DeleteDC(hdcMem);
User32.ReleaseDC(0n, hdcScreen);

console.log('[screenshot] killing demo…');
child.kill();
await Bun.sleep(200);

process.exit(saveStatus === Status.Ok ? 0 : 6);
