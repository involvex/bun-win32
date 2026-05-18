/**
 * Font Observatory — a full DirectWrite typography census
 *
 * Walks the machine's entire installed font collection through DirectWrite's
 * COM object graph and prints an exhaustive, aligned diagnostic: every font
 * family, its localized name, the number of faces it ships, the weight/width
 * range those faces span, and italic / symbol classification — followed by a
 * weight-distribution histogram, a style breakdown, and a metrics spotlight
 * that reads the raw DWRITE_FONT_METRICS (units-per-em, ascent, descent, cap
 * height, x-height, line gap) for a handful of well-known families.
 *
 * Everything below DWriteCreateFactory is a hand-driven COM vtable call.
 *
 * APIs demonstrated (Dwrite):
 *   - DWriteCreateFactory                       (bootstrap the factory)
 *   - IDWriteFactory::GetSystemFontCollection   (installed font collection)
 *   - IDWriteFontCollection::GetFontFamilyCount / GetFontFamily / FindFamilyName
 *   - IDWriteFontFamily::GetFamilyNames         (localized family names)
 *   - IDWriteFontList::GetFontCount / GetFont   (enumerate faces)
 *   - IDWriteFont::GetWeight / GetStretch / GetStyle / GetSimulations
 *   - IDWriteFont::IsSymbolFont / GetMetrics    (classification + metrics)
 *   - IDWriteLocalizedStrings::FindLocaleName / GetStringLength / GetString
 *   - IUnknown::Release                         (release every COM object)
 *
 * Run: bun run example/font-observatory.ts
 */

import { CFunction, FFIType, type Pointer, read } from 'bun:ffi';

import Dwrite, { DWRITE_FACTORY_TYPE } from '../index';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const MAGENTA = '\x1b[95m';
const RED = '\x1b[91m';
const BLUE = '\x1b[94m';

const S_OK = 0;
const IID_IDWriteFactory = 'b859ee5a-d838-4b5b-a2e8-1adc7d93db48';

// IUnknown / DirectWrite vtable slots (dwrite.h declaration order).
const IUNKNOWN_RELEASE = 2;
const FACTORY_GETSYSTEMFONTCOLLECTION = 3;
const FONTCOLLECTION_GETFONTFAMILYCOUNT = 3;
const FONTCOLLECTION_GETFONTFAMILY = 4;
const FONTCOLLECTION_FINDFAMILYNAME = 5;
const FONTLIST_GETFONTCOUNT = 4;
const FONTLIST_GETFONT = 5;
const FONTFAMILY_GETFAMILYNAMES = 6;
const FONT_GETWEIGHT = 4;
const FONT_GETSTRETCH = 5;
const FONT_GETSTYLE = 6;
const FONT_ISSYMBOLFONT = 7;
const FONT_GETSIMULATIONS = 10;
const FONT_GETMETRICS = 11;

// DWRITE_FONT_SIMULATIONS bit flags.
const DWRITE_FONT_SIMULATIONS_BOLD = 0x1;
const DWRITE_FONT_SIMULATIONS_OBLIQUE = 0x2;
const LOCALIZEDSTRINGS_FINDLOCALENAME = 4;
const LOCALIZEDSTRINGS_GETSTRINGLENGTH = 7;
const LOCALIZEDSTRINGS_GETSTRING = 8;

const hex = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

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
 * Invoke COM vtable slot `slot` on `thisPtr`; CFunction memoized per signature.
 * Every method used here returns an HRESULT/count (32-bit) or void.
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

const release = (obj: bigint): void => void vcall(obj, IUNKNOWN_RELEASE, [], [], FFIType.u32);

function fail(label: string, hr: number): never {
  console.error(`${RED}${label} failed: ${hex(hr)}${RESET}`);
  process.exit(1);
}

/** Reads the preferred (en-us, else first) localized string from the object. */
function localizedString(strings: bigint): string {
  const localeBuffer = Buffer.from('en-us\0', 'utf16le');
  const indexOut = Buffer.alloc(4);
  const existsOut = Buffer.alloc(4);
  vcall(strings, LOCALIZEDSTRINGS_FINDLOCALENAME, [FFIType.ptr, FFIType.ptr, FFIType.ptr], [localeBuffer.ptr!, indexOut.ptr!, existsOut.ptr!]);
  const index = existsOut.readInt32LE(0) !== 0 ? indexOut.readUInt32LE(0) : 0;

  const lengthOut = Buffer.alloc(4);
  if (vcall(strings, LOCALIZEDSTRINGS_GETSTRINGLENGTH, [FFIType.u32, FFIType.ptr], [index, lengthOut.ptr!]) !== S_OK) return '';
  const length = lengthOut.readUInt32LE(0);
  const stringBuffer = Buffer.alloc((length + 1) * 2);
  if (vcall(strings, LOCALIZEDSTRINGS_GETSTRING, [FFIType.u32, FFIType.ptr, FFIType.u32], [index, stringBuffer.ptr!, length + 1]) !== S_OK) return '';
  return stringBuffer.toString('utf16le', 0, length * 2);
}

const WEIGHT_NAMES: ReadonlyArray<readonly [number, string]> = [
  [100, 'Thin'],
  [200, 'ExtraLight'],
  [300, 'Light'],
  [350, 'SemiLight'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'SemiBold'],
  [700, 'Bold'],
  [800, 'ExtraBold'],
  [900, 'Black'],
  [950, 'ExtraBlack'],
];

const STRETCH_NAMES = ['Undefined', 'UltraCondensed', 'ExtraCondensed', 'Condensed', 'SemiCondensed', 'Normal', 'SemiExpanded', 'Expanded', 'ExtraExpanded', 'UltraExpanded'];
const STYLE_NAMES = ['Normal', 'Oblique', 'Italic'];

function weightName(weight: number): string {
  let best = WEIGHT_NAMES[0];
  for (const entry of WEIGHT_NAMES) if (Math.abs(entry[0] - weight) < Math.abs(best[0] - weight)) best = entry;
  return best[1];
}

interface FamilyInfo {
  name: string;
  faces: number;
  authored: number;
  minWeight: number;
  maxWeight: number;
  hasItalic: boolean;
  symbol: boolean;
  stretches: Set<number>;
}

// 1. Factory + 2. system font collection.
const factoryOut = Buffer.alloc(8);
const factoryHr = Dwrite.DWriteCreateFactory(DWRITE_FACTORY_TYPE.DWRITE_FACTORY_TYPE_SHARED, guid(IID_IDWriteFactory).ptr!, factoryOut.ptr!);
if (factoryHr !== S_OK) fail('DWriteCreateFactory', factoryHr);
const factory = factoryOut.readBigUInt64LE(0);

const collectionOut = Buffer.alloc(8);
const collectionHr = vcall(factory, FACTORY_GETSYSTEMFONTCOLLECTION, [FFIType.ptr, FFIType.i32], [collectionOut.ptr!, 0]);
if (collectionHr !== S_OK) fail('GetSystemFontCollection', collectionHr);
const collection = collectionOut.readBigUInt64LE(0);

const familyCount = vcall(collection, FONTCOLLECTION_GETFONTFAMILYCOUNT, [], [], FFIType.u32);

const families: FamilyInfo[] = [];
const weightHistogram = new Map<string, number>();
let totalFaces = 0;
let authoredFaces = 0;
let simulatedBold = 0;
let simulatedOblique = 0;
let italicFamilies = 0;
let symbolFamilies = 0;

for (let i = 0; i < familyCount; i += 1) {
  const familyOut = Buffer.alloc(8);
  if (vcall(collection, FONTCOLLECTION_GETFONTFAMILY, [FFIType.u32, FFIType.ptr], [i, familyOut.ptr!]) !== S_OK) continue;
  const family = familyOut.readBigUInt64LE(0);

  const namesOut = Buffer.alloc(8);
  let name = `family #${i}`;
  if (vcall(family, FONTFAMILY_GETFAMILYNAMES, [FFIType.ptr], [namesOut.ptr!]) === S_OK) {
    const names = namesOut.readBigUInt64LE(0);
    name = localizedString(names) || name;
    release(names);
  }

  const faceCount = vcall(family, FONTLIST_GETFONTCOUNT, [], [], FFIType.u32);
  const info: FamilyInfo = {
    name,
    faces: faceCount,
    authored: 0,
    minWeight: Number.POSITIVE_INFINITY,
    maxWeight: Number.NEGATIVE_INFINITY,
    hasItalic: false,
    symbol: false,
    stretches: new Set<number>(),
  };

  for (let j = 0; j < faceCount; j += 1) {
    const fontOut = Buffer.alloc(8);
    if (vcall(family, FONTLIST_GETFONT, [FFIType.u32, FFIType.ptr], [j, fontOut.ptr!]) !== S_OK) continue;
    const font = fontOut.readBigUInt64LE(0);

    const weight = vcall(font, FONT_GETWEIGHT, [], [], FFIType.u32);
    const stretch = vcall(font, FONT_GETSTRETCH, [], [], FFIType.u32);
    const style = vcall(font, FONT_GETSTYLE, [], [], FFIType.u32);
    const isSymbol = vcall(font, FONT_ISSYMBOLFONT, [], [], FFIType.i32) !== 0;
    const simulations = vcall(font, FONT_GETSIMULATIONS, [], [], FFIType.u32);

    info.minWeight = Math.min(info.minWeight, weight);
    info.maxWeight = Math.max(info.maxWeight, weight);
    info.stretches.add(stretch);
    // style 2 is an authored italic; style 1 is usually a DirectWrite-synthesized oblique.
    if (style === 2 && (simulations & DWRITE_FONT_SIMULATIONS_OBLIQUE) === 0) info.hasItalic = true;
    if (isSymbol) info.symbol = true;

    if ((simulations & DWRITE_FONT_SIMULATIONS_BOLD) !== 0) simulatedBold += 1;
    if ((simulations & DWRITE_FONT_SIMULATIONS_OBLIQUE) !== 0) simulatedOblique += 1;
    if (simulations === 0) {
      info.authored += 1;
      authoredFaces += 1;
    }

    const bucket = weightName(weight);
    weightHistogram.set(bucket, (weightHistogram.get(bucket) ?? 0) + 1);
    totalFaces += 1;

    release(font);
  }

  if (info.hasItalic) italicFamilies += 1;
  if (info.symbol) symbolFamilies += 1;
  families.push(info);
  release(family);
}

families.sort((a, b) => a.name.localeCompare(b.name, 'en'));

// Metrics spotlight: read raw DWRITE_FONT_METRICS for a few notable families.
const SPOTLIGHT = ['Segoe UI', 'Consolas', 'Cascadia Mono', 'Arial', 'Times New Roman', 'Calibri'];
interface Spotlight {
  name: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  capHeight: number;
  xHeight: number;
}
const spotlights: Spotlight[] = [];

for (const target of SPOTLIGHT) {
  const familyBuffer = Buffer.from(`${target}\0`, 'utf16le');
  const indexOut = Buffer.alloc(4);
  const existsOut = Buffer.alloc(4);
  if (vcall(collection, FONTCOLLECTION_FINDFAMILYNAME, [FFIType.ptr, FFIType.ptr, FFIType.ptr], [familyBuffer.ptr!, indexOut.ptr!, existsOut.ptr!]) !== S_OK) continue;
  if (existsOut.readInt32LE(0) === 0) continue;

  const familyOut = Buffer.alloc(8);
  if (vcall(collection, FONTCOLLECTION_GETFONTFAMILY, [FFIType.u32, FFIType.ptr], [indexOut.readUInt32LE(0), familyOut.ptr!]) !== S_OK) continue;
  const family = familyOut.readBigUInt64LE(0);

  const fontOut = Buffer.alloc(8);
  if (vcall(family, FONTLIST_GETFONT, [FFIType.u32, FFIType.ptr], [0, fontOut.ptr!]) === S_OK) {
    const font = fontOut.readBigUInt64LE(0);
    const metrics = Buffer.alloc(20); // DWRITE_FONT_METRICS
    vcall(font, FONT_GETMETRICS, [FFIType.ptr], [metrics.ptr!], FFIType.void);
    spotlights.push({
      name: target,
      unitsPerEm: metrics.readUInt16LE(0),
      ascent: metrics.readUInt16LE(2),
      descent: metrics.readUInt16LE(4),
      lineGap: metrics.readInt16LE(6),
      capHeight: metrics.readUInt16LE(8),
      xHeight: metrics.readUInt16LE(10),
    });
    release(font);
  }
  release(family);
}

release(collection);
release(factory);

const bar = (value: number, max: number, width: number): string => {
  const filled = max <= 0 ? 0 : Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width));
  return `${'█'.repeat(filled)}${DIM}${'░'.repeat(width - filled)}${RESET}`;
};

console.log();
console.log(`${BOLD}${MAGENTA}  ╔════════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${MAGENTA}  ║${RESET}   ${BOLD}Font Observatory${RESET} ${DIM}— DirectWrite system typography census${RESET}        ${BOLD}${MAGENTA}║${RESET}`);
console.log(`${BOLD}${MAGENTA}  ╚════════════════════════════════════════════════════════════════════╝${RESET}`);
console.log();
console.log(
  `  ${DIM}families${RESET} ${CYAN}${BOLD}${families.length}${RESET}` +
    `   ${DIM}faces${RESET} ${CYAN}${BOLD}${totalFaces}${RESET}` +
    `   ${DIM}authored${RESET} ${GREEN}${authoredFaces}${RESET}` +
    `   ${DIM}avg faces/family${RESET} ${(totalFaces / Math.max(1, families.length)).toFixed(1)}` +
    `   ${DIM}with true italic${RESET} ${YELLOW}${italicFamilies}${RESET}` +
    `   ${DIM}symbol${RESET} ${YELLOW}${symbolFamilies}${RESET}`,
);
console.log(`  ${DIM}DirectWrite synthesizes the rest:${RESET} ${YELLOW}${simulatedBold}${RESET} ${DIM}bold-simulated +${RESET} ` + `${YELLOW}${simulatedOblique}${RESET} ${DIM}oblique-simulated faces (DWRITE_FONT_SIMULATIONS)${RESET}`);
console.log();

console.log(`  ${BOLD}Weight distribution${RESET} ${DIM}(faces across all families)${RESET}`);
const maxWeightCount = Math.max(1, ...[...weightHistogram.values()]);
for (const [, label] of WEIGHT_NAMES) {
  const count = weightHistogram.get(label) ?? 0;
  if (count === 0) continue;
  console.log(`    ${label.padEnd(11)} ${BLUE}${bar(count, maxWeightCount, 32)}${RESET} ${count.toString().padStart(4)}`);
}
console.log();

if (spotlights.length > 0) {
  console.log(`  ${BOLD}Metrics spotlight${RESET} ${DIM}(raw DWRITE_FONT_METRICS — design units, and as a fraction of em)${RESET}`);
  console.log(`    ${DIM}${'family'.padEnd(18)}${'units/em'.padStart(9)}${'ascent'.padStart(9)}${'descent'.padStart(9)}` + `${'lineGap'.padStart(9)}${'capH'.padStart(9)}${'xHeight'.padStart(9)}   ratios (asc/desc/cap/x)${RESET}`);
  for (const s of spotlights) {
    const r = (v: number): string => (v / s.unitsPerEm).toFixed(3);
    console.log(
      `    ${GREEN}${s.name.padEnd(18)}${RESET}${s.unitsPerEm.toString().padStart(9)}${s.ascent.toString().padStart(9)}` +
        `${s.descent.toString().padStart(9)}${s.lineGap.toString().padStart(9)}${s.capHeight.toString().padStart(9)}` +
        `${s.xHeight.toString().padStart(9)}   ${DIM}${r(s.ascent)} ${r(s.descent)} ${r(s.capHeight)} ${r(s.xHeight)}${RESET}`,
    );
  }
  console.log();
}

console.log(`  ${BOLD}All families${RESET} ${DIM}(alphabetical — name · faces · authored · weight range · width · flags)${RESET}`);
console.log(`  ${DIM}${'#'.padStart(4)}  ${'family'.padEnd(34)}${'faces'.padStart(6)}${'auth'.padStart(6)}  ` + `${'weight range'.padEnd(22)}${'width'.padEnd(16)}flags${RESET}`);

for (let i = 0; i < families.length; i += 1) {
  const f = families[i];
  const display = f.name.length > 33 ? `${f.name.slice(0, 32)}…` : f.name;
  const weightRange = f.minWeight === f.maxWeight ? weightName(f.minWeight) : `${weightName(f.minWeight)}→${weightName(f.maxWeight)}`;
  const widthList = [...f.stretches]
    .sort((a, b) => a - b)
    .map((s) => STRETCH_NAMES[s] ?? `#${s}`)
    .join(',');
  const width = widthList.length > 15 ? `${widthList.slice(0, 14)}…` : widthList;
  const flags = (f.hasItalic ? `${YELLOW}italic${RESET} ` : '') + (f.symbol ? `${MAGENTA}symbol${RESET}` : '');

  console.log(
    `  ${DIM}${i.toString().padStart(4)}${RESET}  ${CYAN}${display.padEnd(34)}${RESET}` + `${f.faces.toString().padStart(6)}${GREEN}${f.authored.toString().padStart(6)}${RESET}  ` + `${weightRange.padEnd(22)}${width.padEnd(16)}${flags}`,
  );
}

console.log();
console.log(`  ${GREEN}✓${RESET} ${DIM}${familyCount} families enumerated through dwrite.dll COM vtables — pure FFI, no GDI.${RESET}`);
console.log();
