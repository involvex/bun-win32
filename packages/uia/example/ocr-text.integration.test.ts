/**
 * ocr-text — READ TEXT OUT OF RAW PIXELS (Windows.Media.Ocr). The last-resort way to perceive a surface that
 * exposes NO accessibility tree: a <canvas>/WebGL app, a game, a video frame, a remote-desktop session, a chart,
 * a scanned document, an image. ocrBitmap recognizes any RGB bitmap; ocrWindow captures a window's live pixels
 * via WGC (even occluded/GPU/background) and OCRs them; ocrScreen does a screen region. Each word/line comes
 * back with a SCREEN-pixel bounding box, so the agent can postClick recognized text on a surface UIA can't see.
 *
 * Proof (deterministic, no private content): render a known string with GDI into an off-screen bitmap, OCR it,
 * and assert the words come back with sane bounding boxes.
 *
 * bun test is broken repo-wide for FFI; runnable harness:
 * Run: bun run example/ocr-text.integration.test.ts
 */
import Gdi32 from '@bun-win32/gdi32';
import { ocrAvailable, ocrBitmap, uia } from '@bun-win32/uia';
import User32 from '@bun-win32/user32';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

const WIDTH = 900;
const HEIGHT = 160;
const PHRASE = 'The quick brown fox 2026';

/** Render PHRASE in large black text on white into a top-down RGB bitmap, via GDI (no window, no privacy). */
function renderText(): { rgb: Uint8Array; width: number; height: number; originX: number; originY: number } {
  const screenDC = User32.GetDC(0n);
  const memoryDC = Gdi32.CreateCompatibleDC(screenDC);
  const bitmap = Gdi32.CreateCompatibleBitmap(screenDC, WIDTH, HEIGHT);
  const previousBitmap = Gdi32.SelectObject(memoryDC, bitmap);
  const faceName = Buffer.from('Segoe UI\0', 'utf16le');
  const font = Gdi32.CreateFontW(-72, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 4, 0, faceName.ptr!);
  const previousFont = Gdi32.SelectObject(memoryDC, font);
  Gdi32.SetBkColor(memoryDC, 0x00ff_ffff); // white background
  Gdi32.SetTextColor(memoryDC, 0x0000_0000); // black text
  const rect = Buffer.alloc(16);
  rect.writeInt32LE(0, 0);
  rect.writeInt32LE(0, 4);
  rect.writeInt32LE(WIDTH, 8);
  rect.writeInt32LE(HEIGHT, 12);
  const text = Buffer.from(`${PHRASE}\0`, 'utf16le');
  Gdi32.ExtTextOutW(memoryDC, 20, 40, 0x0000_0002 /* ETO_OPAQUE: fill rect with bkcolor, then draw */, rect.ptr!, text.ptr!, PHRASE.length, null);
  Gdi32.GdiFlush();

  const header = Buffer.alloc(40); // BITMAPINFOHEADER
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(WIDTH, 4);
  header.writeInt32LE(-HEIGHT, 8); // top-down
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  const bgra = Buffer.alloc(WIDTH * HEIGHT * 4);
  Gdi32.GetDIBits(memoryDC, bitmap, 0, HEIGHT, bgra.ptr!, header.ptr!, 0);

  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let source = 0, target = 0; source < bgra.length; source += 4, target += 3) {
    rgb[target] = bgra[source + 2]!;
    rgb[target + 1] = bgra[source + 1]!;
    rgb[target + 2] = bgra[source]!;
  }

  Gdi32.SelectObject(memoryDC, previousFont);
  Gdi32.SelectObject(memoryDC, previousBitmap);
  Gdi32.DeleteObject(font);
  Gdi32.DeleteObject(bitmap);
  Gdi32.DeleteDC(memoryDC);
  User32.ReleaseDC(0n, screenDC);
  return { rgb, width: WIDTH, height: HEIGHT, originX: 0, originY: 0 };
}

uia.initialize();
try {
  if (!ocrAvailable()) {
    console.log('  (no OCR language pack installed — skipping; install one via Settings → Language)');
    console.log('\nSKIPPED — Windows.Media.Ocr has no language pack on this machine.');
    process.exit(0);
  }
  const bitmap = renderText();
  const result = await ocrBitmap(bitmap);
  const recognized = result.text.toUpperCase().replace(/\s+/g, ' ').trim();
  console.log(`  OCR read: ${JSON.stringify(result.text)}`);

  for (const token of ['QUICK', 'BROWN', 'FOX', '2026']) {
    assert(recognized.includes(token), `recognized ${JSON.stringify(token)} from the rendered pixels`);
  }
  const words = result.lines.flatMap((line) => line.words);
  assert(words.length > 0 && words.every((word) => word.bounds.width > 0 && word.bounds.height > 0), `every word has a non-empty bounding box (${words.length} words) — postClickable`);
  const first = words.find((word) => word.text.toUpperCase().includes('QUICK'));
  assert(first !== undefined && first.bounds.x >= 0 && first.bounds.x < WIDTH && first.bounds.y >= 0 && first.bounds.y < HEIGHT, `the word box is inside the image (${first ? `${first.bounds.x},${first.bounds.y}` : 'n/a'})`);
} finally {
  uia.uninitialize();
}

console.log(failures === 0 ? '\nPASS — read text out of raw pixels with per-word bounding boxes (Windows.Media.Ocr).' : `\nFAILED — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
