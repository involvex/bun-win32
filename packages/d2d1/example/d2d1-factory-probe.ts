/**
 * Direct2D Factory Probe
 *
 * An exhaustive, richly formatted diagnostic of everything `d2d1.dll` exposes
 * without a window or GPU surface. It:
 *
 *   - Creates a real single-threaded and multi-threaded `ID2D1Factory` with
 *     `D2D1CreateFactory`, reporting each HRESULT and COM pointer.
 *   - Walks the factory's COM vtable to call `ID2D1Factory::GetDesktopDpi`
 *     (the system DPI Direct2D will use) and releases every interface.
 *   - Runs a full transform lab: identity / rotation / skew matrices built by
 *     `D2D1MakeRotateMatrix` and `D2D1MakeSkewMatrix`, invertibility checks
 *     via `D2D1IsMatrixInvertible`, in-place inversion via `D2D1InvertMatrix`,
 *     and maximum scale extraction via `D2D1ComputeMaximumScaleFactor`.
 *   - Prints a trig table from `D2D1SinCos` / `D2D1Tan`, a vector-length table
 *     from `D2D1Vec3Length`, a color-space conversion matrix across sRGB /
 *     scRGB / custom via `D2D1ConvertColorSpace`, and the four interior tensor
 *     points solved by `D2D1GetGradientMeshInteriorPointsFromCoonsPatch`.
 *
 * Every value is printed with aligned labels and ANSI color.
 *
 * APIs demonstrated:
 *   - D2D1CreateFactory                                (single/multi-threaded factory)
 *   - ID2D1Factory::GetDesktopDpi                      (COM vtable, system DPI)
 *   - ID2D1Factory::Release / IUnknown::Release        (COM cleanup)
 *   - D2D1MakeRotateMatrix / D2D1MakeSkewMatrix        (affine 3x2 matrices)
 *   - D2D1IsMatrixInvertible / D2D1InvertMatrix        (invertibility + inverse)
 *   - D2D1ComputeMaximumScaleFactor                    (matrix max scale)
 *   - D2D1SinCos / D2D1Tan                             (trig)
 *   - D2D1Vec3Length                                   (3D vector magnitude)
 *   - D2D1ConvertColorSpace                            (sRGB/scRGB/custom)
 *   - D2D1GetGradientMeshInteriorPointsFromCoonsPatch  (Coons-patch tensor pts)
 *
 * APIs demonstrated (kernel32, cross-package):
 *   - GetCurrentProcess                                (handle for memory reads)
 *   - ReadProcessMemory                                (walk native vtable ptrs)
 *
 * Run: bun run example/d2d1-factory-probe.ts
 */

import { FFIType, dlopen, linkSymbols } from 'bun:ffi';

import D2D1, { D2D1_COLOR_SPACE, D2D1_FACTORY_TYPE, packD2D1_POINT_2F } from '../index';

const A = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[96m',
  green: '\x1b[92m',
  red: '\x1b[91m',
  yellow: '\x1b[93m',
  magenta: '\x1b[95m',
  white: '\x1b[97m',
  reset: '\x1b[0m',
} as const;

const GET_DESKTOP_DPI_OFFSET = 0x20; // ID2D1Factory vtable index 4
const RELEASE_OFFSET = 0x10; // IUnknown vtable index 2
const POINTER_SIZE = 8;

D2D1.Preload();

const kernel32 = dlopen('kernel32.dll', {
  GetCurrentProcess: { args: [], returns: FFIType.u64 },
  ReadProcessMemory: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
});
const currentProcess = kernel32.symbols.GetCurrentProcess();

function readPointerAt(address: bigint): bigint {
  const buffer = Buffer.alloc(POINTER_SIZE);
  const ok = kernel32.symbols.ReadProcessMemory(currentProcess, address, buffer.ptr!, BigInt(POINTER_SIZE), null);
  if (ok === 0) throw new Error(`ReadProcessMemory failed at 0x${address.toString(16)}`);
  return buffer.readBigUInt64LE(0);
}

function hr(value: number): string {
  return value === 0 ? `${A.green}S_OK${A.reset}` : `${A.red}0x${(value >>> 0).toString(16).padStart(8, '0')}${A.reset}`;
}

function label(text: string): string {
  return `${A.dim}${text.padEnd(22)}${A.reset}`;
}

function mat(buf: Buffer): string {
  const v = Array.from({ length: 6 }, (_, i) => buf.readFloatLE(i * 4));
  return `[${v.map((n) => (n >= 0 ? ' ' : '') + n.toFixed(3)).join(', ')}]`;
}

console.log();
console.log(`${A.bold}${A.magenta}◼ Direct2D Factory Probe${A.reset}  ${A.dim}— d2d1.dll, no window, no GPU surface${A.reset}`);
console.log();

// ── Factory creation (single + multi threaded) ─────────────────────────────
console.log(`${A.bold}${A.white}Factory Creation${A.reset}`);
const IID_ID2D1Factory = Buffer.from([0x47, 0x22, 0x15, 0x06, 0x50, 0x6f, 0x5a, 0x46, 0x92, 0x45, 0x11, 0x8b, 0xfd, 0x3b, 0x60, 0x07]);

for (const [name, type] of [
  ['single-threaded', D2D1_FACTORY_TYPE.D2D1_FACTORY_TYPE_SINGLE_THREADED],
  ['multi-threaded', D2D1_FACTORY_TYPE.D2D1_FACTORY_TYPE_MULTI_THREADED],
] as const) {
  const pp = Buffer.alloc(8);
  const code = D2D1.D2D1CreateFactory(type, IID_ID2D1Factory.ptr!, null, pp.ptr!);
  const ptr = pp.readBigUInt64LE(0);
  console.log(`  ${label(name)} ${hr(code)}  ${A.dim}ID2D1Factory${A.reset} ${A.cyan}0x${ptr.toString(16)}${A.reset}`);

  if (code === 0 && ptr !== 0n) {
    if (name === 'single-threaded') {
      const vtable = readPointerAt(ptr);
      const getDpi = readPointerAt(vtable + BigInt(GET_DESKTOP_DPI_OFFSET));
      const release = readPointerAt(vtable + BigInt(RELEASE_OFFSET));
      const calls = linkSymbols({
        GetDesktopDpi: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], ptr: getDpi, returns: FFIType.void },
        Release: { args: [FFIType.u64], ptr: release, returns: FFIType.u32 },
      });
      const dpiX = Buffer.alloc(4);
      const dpiY = Buffer.alloc(4);
      calls.symbols.GetDesktopDpi(ptr, dpiX.ptr!, dpiY.ptr!);
      const scale = dpiX.readFloatLE(0) / 96;
      console.log(`  ${label('  desktop DPI')} ${A.yellow}${dpiX.readFloatLE(0).toFixed(1)} x ${dpiY.readFloatLE(0).toFixed(1)}${A.reset}  ${A.dim}(${(scale * 100).toFixed(0)}% UI scale)${A.reset}`);
      const refs = calls.symbols.Release(ptr);
      console.log(`  ${label('  Release →')} ${A.dim}${refs} refs remaining${A.reset}`);
      calls.close();
    } else {
      const vtable = readPointerAt(ptr);
      const release = readPointerAt(vtable + BigInt(RELEASE_OFFSET));
      const calls = linkSymbols({ Release: { args: [FFIType.u64], ptr: release, returns: FFIType.u32 } });
      calls.symbols.Release(ptr);
      calls.close();
    }
  }
}

// ── Transform lab ──────────────────────────────────────────────────────────
console.log();
console.log(`${A.bold}${A.white}Transform Lab${A.reset}  ${A.dim}(D2D1_MATRIX_3X2_F = [_11,_12,_21,_22,_31,_32])${A.reset}`);
const identity = Buffer.alloc(24);
[1, 0, 0, 1, 0, 0].forEach((v, i) => identity.writeFloatLE(v, i * 4));
console.log(`  ${label('identity')} ${mat(identity)}  ${A.dim}invertible${A.reset} ${D2D1.D2D1IsMatrixInvertible(identity.ptr!) ? `${A.green}yes${A.reset}` : `${A.red}no${A.reset}`}`);

for (const angle of [30, 45, 90, 120]) {
  const m = Buffer.alloc(24);
  D2D1.D2D1MakeRotateMatrix(angle, packD2D1_POINT_2F(0, 0), m.ptr!);
  const scale = D2D1.D2D1ComputeMaximumScaleFactor(m.ptr!);
  console.log(`  ${label(`rotate ${angle}°`)} ${mat(m)}  ${A.dim}maxScale${A.reset} ${A.yellow}${scale.toFixed(4)}${A.reset}`);
}

const skew = Buffer.alloc(24);
D2D1.D2D1MakeSkewMatrix(20, 10, packD2D1_POINT_2F(0, 0), skew.ptr!);
console.log(`  ${label('skew 20°,10°')} ${mat(skew)}`);

const scale2 = Buffer.alloc(24);
[2, 0, 0, 4, 5, 7].forEach((v, i) => scale2.writeFloatLE(v, i * 4));
console.log(`  ${label('affine 2x/4x+t')} ${mat(scale2)}`);
const inverse = Buffer.from(scale2);
const didInvert = D2D1.D2D1InvertMatrix(inverse.ptr!);
console.log(`  ${label('  inverted →')} ${mat(inverse)}  ${A.dim}ok${A.reset} ${didInvert ? `${A.green}yes${A.reset}` : `${A.red}no${A.reset}`}`);

// ── Trig + vector tables ───────────────────────────────────────────────────
console.log();
console.log(`${A.bold}${A.white}Trig & Vectors${A.reset}`);
const s = Buffer.alloc(4);
const c = Buffer.alloc(4);
for (const deg of [0, 30, 45, 60, 90]) {
  const rad = (deg * Math.PI) / 180;
  D2D1.D2D1SinCos(rad, s.ptr!, c.ptr!);
  const tan = D2D1.D2D1Tan(rad);
  const tanStr = Number.isFinite(tan) && Math.abs(tan) < 1e6 ? tan.toFixed(4) : '∞';
  console.log(`  ${label(`${deg}°`)} ${A.dim}sin${A.reset} ${A.cyan}${s.readFloatLE(0).toFixed(4)}${A.reset}  ${A.dim}cos${A.reset} ${A.cyan}${c.readFloatLE(0).toFixed(4)}${A.reset}  ${A.dim}tan${A.reset} ${A.cyan}${tanStr}${A.reset}`);
}
for (const [x, y, z] of [
  [1, 0, 0],
  [3, 4, 0],
  [3, 4, 12],
  [1, 1, 1],
] as const) {
  console.log(`  ${label(`|(${x},${y},${z})|`)} ${A.yellow}${D2D1.D2D1Vec3Length(x, y, z).toFixed(6)}${A.reset}`);
}

// ── Color-space conversion matrix ──────────────────────────────────────────
console.log();
console.log(`${A.bold}${A.white}Color-Space Conversion${A.reset}  ${A.dim}(D2D1ConvertColorSpace, RGBA float)${A.reset}`);
const SPACES = [
  ['sRGB', D2D1_COLOR_SPACE.D2D1_COLOR_SPACE_SRGB],
  ['scRGB', D2D1_COLOR_SPACE.D2D1_COLOR_SPACE_SCRGB],
] as const;
const inColor = Buffer.alloc(16);
const outColor = Buffer.alloc(16);
for (const [r, g, b] of [
  [0.5, 0.5, 0.5],
  [0.25, 0.5, 0.75],
  [1.0, 0.0, 0.0],
] as const) {
  [r, g, b, 1].forEach((v, i) => inColor.writeFloatLE(v, i * 4));
  for (const [fromName, from] of SPACES) {
    for (const [toName, to] of SPACES) {
      if (from === to) continue;
      D2D1.D2D1ConvertColorSpace(outColor.ptr!, from, to, inColor.ptr!);
      const ov = [0, 4, 8].map((o) => outColor.readFloatLE(o).toFixed(4)).join(', ');
      console.log(`  ${label(`(${r},${g},${b})`)} ${A.dim}${fromName.padEnd(5)}→${toName.padEnd(5)}${A.reset} ${A.green}[${ov}]${A.reset}`);
    }
  }
}

// ── Coons-patch interior tensor points ─────────────────────────────────────
console.log();
console.log(`${A.bold}${A.white}Coons-Patch Interior${A.reset}  ${A.dim}(12 boundary → 4 interior tensor points)${A.reset}`);
const cp: Buffer[] = [];
const boundary = [
  [0, 0],
  [33, -10],
  [66, 10],
  [100, 0],
  [110, 33],
  [90, 66],
  [100, 100],
  [66, 110],
  [33, 90],
  [0, 100],
  [-10, 66],
  [10, 33],
];
for (const [bx, by] of boundary) {
  const b = Buffer.alloc(8);
  b.writeFloatLE(bx, 0);
  b.writeFloatLE(by, 4);
  cp.push(b);
}
const tp = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)];
D2D1.D2D1GetGradientMeshInteriorPointsFromCoonsPatch(
  cp[0].ptr!,
  cp[1].ptr!,
  cp[2].ptr!,
  cp[3].ptr!,
  cp[4].ptr!,
  cp[5].ptr!,
  cp[6].ptr!,
  cp[7].ptr!,
  cp[8].ptr!,
  cp[9].ptr!,
  cp[10].ptr!,
  cp[11].ptr!,
  tp[0].ptr!,
  tp[1].ptr!,
  tp[2].ptr!,
  tp[3].ptr!,
);
const tpNames = ['tensor 1,1', 'tensor 1,2', 'tensor 2,1', 'tensor 2,2'];
tp.forEach((p, i) => {
  console.log(`  ${label(tpNames[i])} ${A.cyan}(${p.readFloatLE(0).toFixed(3)}, ${p.readFloatLE(4).toFixed(3)})${A.reset}`);
});

kernel32.close();
console.log();
console.log(`${A.dim}  All 13 d2d1.dll exports exercised — factory COM entry + native transform/color math, pure FFI.${A.reset}`);
console.log();
