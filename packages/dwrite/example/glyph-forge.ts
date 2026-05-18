/**
 * Glyph Forge — antialiased text rasterized purely through FFI
 *
 * Takes a line of text, walks it all the way down the DirectWrite font stack
 * over hand-driven COM vtables, and asks DirectWrite's own rasterizer to bake
 * the string into a sub-pixel ClearType alpha texture entirely in memory. The
 * coverage texture is then painted into the terminal as Unicode half-blocks
 * with a 24-bit color gradient — two texel rows per character cell. No window,
 * no GDI, no bitmap file: DirectWrite renders the glyphs, Bun reads back the
 * raw alpha bytes, nothing touches the disk.
 *
 * Pipeline (every step is a COM vtable call except DWriteCreateFactory):
 *
 *   1. DWriteCreateFactory                       — the one flat dwrite.dll export
 *   2. IDWriteFactory::GetSystemFontCollection   — installed font collection
 *   3. IDWriteFontCollection::FindFamilyName     — locate the requested family
 *   4. IDWriteFontCollection::GetFontFamily      — open the family
 *   5. IDWriteFontFamily::GetFirstMatchingFont   — pick weight/style/stretch
 *   6. IDWriteFont::CreateFontFace               — physical font face
 *   7. IDWriteFontFace::GetMetrics               — designUnitsPerEm
 *   8. IDWriteFontFace::GetGlyphIndices          — codepoints → glyph ids
 *   9. IDWriteFontFace::GetDesignGlyphMetrics    — per-glyph advances
 *  10. IDWriteFactory::CreateGlyphRunAnalysis    — rasterize the glyph run
 *  11. IDWriteGlyphRunAnalysis::GetAlphaTextureBounds — texel rectangle
 *  12. IDWriteGlyphRunAnalysis::CreateAlphaTexture     — read back coverage
 *
 * APIs demonstrated (Dwrite):
 *   - DWriteCreateFactory                  (bootstrap the DirectWrite factory)
 *   - IDWriteFactory::GetSystemFontCollection / CreateGlyphRunAnalysis
 *   - IDWriteFontCollection::FindFamilyName / GetFontFamily
 *   - IDWriteFontFamily::GetFirstMatchingFont
 *   - IDWriteFont::CreateFontFace
 *   - IDWriteFontFace::GetMetrics / GetGlyphIndices / GetDesignGlyphMetrics
 *   - IDWriteGlyphRunAnalysis::GetAlphaTextureBounds / CreateAlphaTexture
 *   - IUnknown::Release                    (release every COM object)
 *
 * Run: bun run example/glyph-forge.ts [text...]
 */

import { CFunction, FFIType, type Pointer, read } from 'bun:ffi';

import Dwrite, { DWRITE_FACTORY_TYPE } from '../index';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';

const S_OK = 0;

// __uuidof(IDWriteFactory)
const IID_IDWriteFactory = 'b859ee5a-d838-4b5b-a2e8-1adc7d93db48';

// IUnknown / IDWriteFactory vtable slots (dwrite.h declaration order).
const IUNKNOWN_RELEASE = 2;
const FACTORY_GETSYSTEMFONTCOLLECTION = 3;
const FACTORY_CREATEGLYPHRUNANALYSIS = 23;
const FONTCOLLECTION_GETFONTFAMILY = 4;
const FONTCOLLECTION_FINDFAMILYNAME = 5;
const FONTFAMILY_GETFIRSTMATCHINGFONT = 7;
const FONT_CREATEFONTFACE = 13;
const FONTFACE_GETMETRICS = 8;
const FONTFACE_GETDESIGNGLYPHMETRICS = 10;
const FONTFACE_GETGLYPHINDICES = 11;
const GRA_GETALPHATEXTUREBOUNDS = 3;
const GRA_CREATEALPHATEXTURE = 4;

// DWRITE_FONT_WEIGHT / STRETCH / STYLE
const DWRITE_FONT_WEIGHT_BOLD = 700;
const DWRITE_FONT_STRETCH_NORMAL = 5;
const DWRITE_FONT_STYLE_NORMAL = 0;

// DWRITE_RENDERING_MODE_NATURAL / DWRITE_MEASURING_MODE_NATURAL / DWRITE_TEXTURE_CLEARTYPE_3x1
const DWRITE_RENDERING_MODE_NATURAL = 4;
const DWRITE_MEASURING_MODE_NATURAL = 0;
const DWRITE_TEXTURE_CLEARTYPE_3x1 = 1;

const hex = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

/** Builds the 16-byte little-endian GUID layout COM expects from a REFIID. */
function guid(text: string): Buffer {
  const h = text.replace(/[{}-]/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i += 1) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}

const invokers = new Map<string, ReturnType<typeof CFunction>>();

/**
 * Invokes COM vtable slot `slot` on interface pointer `thisPtr`. The implicit
 * `this` is prepended as the first argument; the bound CFunction is memoized
 * per (method pointer, signature) so hot enumeration loops stay cheap. Every
 * method used here returns either an HRESULT/count (32-bit) or void.
 */
function vcall(thisPtr: bigint, slot: number, argTypes: readonly FFIType[], args: readonly unknown[], returns: FFIType = FFIType.i32): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const key = `${method}|${returns}|${argTypes.join(',')}`;
  let invoke = invokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({ ptr: Number(method) as Pointer, args: [FFIType.u64, ...argTypes], returns });
    invokers.set(key, invoke);
  }
  return invoke(thisPtr, ...args);
}

const liveObjects: bigint[] = [];

function need(label: string, hr: number): void {
  if (hr !== S_OK) {
    console.error(`${RED}${label} failed: ${hex(hr)}${RESET}`);
    for (const obj of liveObjects.reverse()) vcall(obj, IUNKNOWN_RELEASE, [], [], FFIType.u32);
    process.exit(1);
  }
}

/** Reads an out IDWrite* interface pointer that a method wrote into `slot`. */
function take(slot: Buffer): bigint {
  const ptr = slot.readBigUInt64LE(0);
  if (ptr !== 0n) liveObjects.push(ptr);
  return ptr;
}

const requested = process.argv.slice(2).join(' ').trim();
const text = requested.length > 0 ? requested : 'Bun ▸ DirectWrite';
const familyName = 'Segoe UI';

// 1. Factory.
const factoryOut = Buffer.alloc(8);
need('DWriteCreateFactory', Dwrite.DWriteCreateFactory(DWRITE_FACTORY_TYPE.DWRITE_FACTORY_TYPE_SHARED, guid(IID_IDWriteFactory).ptr!, factoryOut.ptr!));
const factory = take(factoryOut);

// 2. System font collection.
const collectionOut = Buffer.alloc(8);
need('GetSystemFontCollection', vcall(factory, FACTORY_GETSYSTEMFONTCOLLECTION, [FFIType.ptr, FFIType.i32], [collectionOut.ptr!, 0]));
const collection = take(collectionOut);

// 3. Locate the family (fall back to family 0 if the preferred one is absent).
const familyBuffer = Buffer.from(`${familyName}\0`, 'utf16le');
const familyIndex = Buffer.alloc(4);
const familyExists = Buffer.alloc(4);
need('FindFamilyName', vcall(collection, FONTCOLLECTION_FINDFAMILYNAME, [FFIType.ptr, FFIType.ptr, FFIType.ptr], [familyBuffer.ptr!, familyIndex.ptr!, familyExists.ptr!]));
const resolvedIndex = familyExists.readInt32LE(0) !== 0 ? familyIndex.readUInt32LE(0) : 0;

// 4. Open the family.
const familyOut = Buffer.alloc(8);
need('GetFontFamily', vcall(collection, FONTCOLLECTION_GETFONTFAMILY, [FFIType.u32, FFIType.ptr], [resolvedIndex, familyOut.ptr!]));
const family = take(familyOut);

// 5. Pick a concrete font (bold, upright, normal width).
const fontOut = Buffer.alloc(8);
need('GetFirstMatchingFont', vcall(family, FONTFAMILY_GETFIRSTMATCHINGFONT, [FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], [DWRITE_FONT_WEIGHT_BOLD, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, fontOut.ptr!]));
const font = take(fontOut);

// 6. Physical font face.
const faceOut = Buffer.alloc(8);
need('CreateFontFace', vcall(font, FONT_CREATEFONTFACE, [FFIType.ptr], [faceOut.ptr!]));
const fontFace = take(faceOut);

// 7. Font metrics → designUnitsPerEm (DWRITE_FONT_METRICS, 20 bytes, first field UINT16).
const fontMetrics = Buffer.alloc(20);
vcall(fontFace, FONTFACE_GETMETRICS, [FFIType.ptr], [fontMetrics.ptr!], FFIType.void);
const designUnitsPerEm = fontMetrics.readUInt16LE(0);

// 8. Codepoints → glyph indices. (Plane-0 text; one UTF-32 unit per JS char here.)
const codepoints = Array.from(text).map((ch) => ch.codePointAt(0) ?? 0x20);
const glyphCount = codepoints.length;
const codepointBuffer = Buffer.alloc(glyphCount * 4);
codepoints.forEach((cp, i) => codepointBuffer.writeUInt32LE(cp, i * 4));
const glyphIndices = Buffer.alloc(glyphCount * 2);
need('GetGlyphIndices', vcall(fontFace, FONTFACE_GETGLYPHINDICES, [FFIType.ptr, FFIType.u32, FFIType.ptr], [codepointBuffer.ptr!, glyphCount, glyphIndices.ptr!]));

// 9. Per-glyph design advances (DWRITE_GLYPH_METRICS, 28 bytes; advanceWidth @ +4 UINT32).
const glyphMetrics = Buffer.alloc(glyphCount * 28);
need('GetDesignGlyphMetrics', vcall(fontFace, FONTFACE_GETDESIGNGLYPHMETRICS, [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.i32], [glyphIndices.ptr!, glyphCount, glyphMetrics.ptr!, 0]));

let totalDesignAdvance = 0;
const designAdvances: number[] = [];
for (let i = 0; i < glyphCount; i += 1) {
  const advance = glyphMetrics.readUInt32LE(i * 28 + 4);
  designAdvances.push(advance);
  totalDesignAdvance += advance;
}

// Choose an em size so the rendered run is ~targetWidth physical pixels wide.
const targetWidth = Math.max(40, Math.min((process.stdout.columns ?? 100) - 2, 180));
const emSize = (targetWidth * designUnitsPerEm) / Math.max(1, totalDesignAdvance);

// glyphAdvances[] in DIPs (pixelsPerDip = 1, so DIPs == device pixels here).
const glyphAdvances = Buffer.alloc(glyphCount * 4);
designAdvances.forEach((adv, i) => glyphAdvances.writeFloatLE((adv / designUnitsPerEm) * emSize, i * 4));

// DWRITE_GLYPH_RUN — 48 bytes on x64.
//   +0  IDWriteFontFace* fontFace      +24 FLOAT const* glyphAdvances
//   +8  FLOAT fontEmSize               +32 DWRITE_GLYPH_OFFSET const* glyphOffsets
//   +12 UINT32 glyphCount              +40 BOOL isSideways
//   +16 UINT16 const* glyphIndices     +44 UINT32 bidiLevel
const glyphRun = Buffer.alloc(48);
glyphRun.writeBigUInt64LE(fontFace, 0);
glyphRun.writeFloatLE(emSize, 8);
glyphRun.writeUInt32LE(glyphCount, 12);
glyphRun.writeBigUInt64LE(BigInt(glyphIndices.ptr!), 16);
glyphRun.writeBigUInt64LE(BigInt(glyphAdvances.ptr!), 24);
glyphRun.writeBigUInt64LE(0n, 32); // glyphOffsets = NULL
glyphRun.writeInt32LE(0, 40); // isSideways = FALSE
glyphRun.writeUInt32LE(0, 44); // bidiLevel = 0

// 10. Rasterize the glyph run.
const analysisOut = Buffer.alloc(8);
need(
  'CreateGlyphRunAnalysis',
  vcall(
    factory,
    FACTORY_CREATEGLYPHRUNANALYSIS,
    [FFIType.ptr, FFIType.f32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.f32, FFIType.f32, FFIType.ptr],
    [glyphRun.ptr!, 1.0, null, DWRITE_RENDERING_MODE_NATURAL, DWRITE_MEASURING_MODE_NATURAL, 0.0, 0.0, analysisOut.ptr!],
  ),
);
const analysis = take(analysisOut);

// 11. Texel bounds (RECT = 4 × INT32: left, top, right, bottom).
const bounds = Buffer.alloc(16);
need('GetAlphaTextureBounds', vcall(analysis, GRA_GETALPHATEXTUREBOUNDS, [FFIType.u32, FFIType.ptr], [DWRITE_TEXTURE_CLEARTYPE_3x1, bounds.ptr!]));
const left = bounds.readInt32LE(0);
const top = bounds.readInt32LE(4);
const right = bounds.readInt32LE(8);
const bottom = bounds.readInt32LE(12);
const width = right - left;
const height = bottom - top;
if (width <= 0 || height <= 0) {
  console.error(`${RED}DirectWrite produced an empty texture for this text.${RESET}`);
  for (const obj of liveObjects.reverse()) vcall(obj, IUNKNOWN_RELEASE, [], [], FFIType.u32);
  process.exit(1);
}

// 12. Read back the ClearType coverage (3 bytes per texel horizontally).
const stride = width * 3;
const texture = Buffer.alloc(stride * height);
need('CreateAlphaTexture', vcall(analysis, GRA_CREATEALPHATEXTURE, [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32], [DWRITE_TEXTURE_CLEARTYPE_3x1, bounds.ptr!, texture.ptr!, texture.length]));

for (const obj of liveObjects.reverse()) vcall(obj, IUNKNOWN_RELEASE, [], [], FFIType.u32);

/** Averaged ClearType coverage [0..255] for texel (x, y); 0 outside bounds. */
function coverage(x: number, y: number): number {
  if (x < 0 || x >= width || y < 0 || y >= height) return 0;
  const o = y * stride + x * 3;
  return (texture[o] + texture[o + 1] + texture[o + 2]) / 3;
}

/** Coverage → an RGB triple along a cyan→magenta gradient keyed by column. */
function shade(x: number, c: number): [number, number, number] {
  const t = width <= 1 ? 0 : x / (width - 1);
  const r = Math.round((60 + 195 * t) * (c / 255));
  const g = Math.round((230 - 150 * t) * (c / 255));
  const b = Math.round((180 + 75 * t) * (c / 255));
  return [r, g, b];
}

console.log();
console.log(`${BOLD}${CYAN}  Glyph Forge${RESET}${DIM} — DirectWrite rasterized "${text}" through pure FFI${RESET}`);
console.log(
  `  ${DIM}family${RESET} ${familyName}  ${DIM}emSize${RESET} ${emSize.toFixed(1)}px  ${DIM}glyphs${RESET} ${glyphCount}  ` + `${DIM}texture${RESET} ${width}×${height}  ${DIM}coverage bytes${RESET} ${texture.length.toLocaleString()}`,
);
console.log();

for (let y = 0; y < height; y += 2) {
  let line = '  ';
  for (let x = 0; x < width; x += 1) {
    const topCov = coverage(x, y);
    const bottomCov = y + 1 < height ? coverage(x, y + 1) : 0;
    const [tr, tg, tb] = shade(x, topCov);
    const [br, bg, bb] = shade(x, bottomCov);
    line += `\x1b[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m▀`;
  }
  console.log(line + RESET);
}

console.log();
console.log(`  ${GREEN}✓${RESET} ${DIM}Glyphs rasterized by dwrite.dll, alpha texture read back in-process — zero files, zero GDI.${RESET}`);
console.log();
