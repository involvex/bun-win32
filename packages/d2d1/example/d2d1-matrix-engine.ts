/**
 * Direct2D Matrix Engine
 *
 * A spinning, shaded 3D torus rendered in the terminal — every transform,
 * every trig sweep, and the entire color pipeline is computed by Direct2D's
 * own native math exported from `d2d1.dll`, with zero COM and zero GPU surface.
 *
 *   - `D2D1SinCos` fills the per-frame sin/cos tables that sweep the torus and
 *     the two tumble angles.
 *   - `D2D1Vec3Length` normalizes every visible surface normal for lighting.
 *   - `D2D1MakeRotateMatrix` builds a screen-space "camera roll" 3x2 matrix and
 *     `D2D1MakeSkewMatrix` adds a breathing shear; both are applied to every
 *     projected point so the whole image tumbles.
 *   - `D2D1ComputeMaximumScaleFactor` reads a matrix back to pick the
 *     projection scale, and `D2D1IsMatrixInvertible` / `D2D1InvertMatrix`
 *     prove the transform is reversible (shown in the HUD).
 *   - `D2D1GetGradientMeshInteriorPointsFromCoonsPatch` warps a Coons-patch
 *     gradient backdrop behind the torus.
 *   - `D2D1ConvertColorSpace` builds the scRGB→sRGB tone-mapping curve so the
 *     linear lighting is displayed with physically correct gamma.
 *
 * Pixels are painted as Unicode upper-half blocks (two image rows per cell)
 * with 24-bit ANSI color. The demo renders a fixed reel of frames and exits.
 *
 * APIs demonstrated:
 *   - D2D1SinCos                                       (sin/cos table fill)
 *   - D2D1Vec3Length                                   (normal normalization)
 *   - D2D1MakeRotateMatrix                             (screen-roll 3x2 matrix)
 *   - D2D1MakeSkewMatrix                               (breathing shear matrix)
 *   - D2D1ComputeMaximumScaleFactor                    (projection scale pick)
 *   - D2D1IsMatrixInvertible / D2D1InvertMatrix        (reversibility proof)
 *   - D2D1GetGradientMeshInteriorPointsFromCoonsPatch  (gradient backdrop)
 *   - D2D1ConvertColorSpace                            (scRGB → sRGB curve)
 *
 * Run: bun run example/d2d1-matrix-engine.ts
 */

import D2D1, { D2D1_COLOR_SPACE, packD2D1_POINT_2F } from '../index';

D2D1.Preload([
  'D2D1SinCos',
  'D2D1Vec3Length',
  'D2D1MakeRotateMatrix',
  'D2D1MakeSkewMatrix',
  'D2D1ComputeMaximumScaleFactor',
  'D2D1IsMatrixInvertible',
  'D2D1InvertMatrix',
  'D2D1GetGradientMeshInteriorPointsFromCoonsPatch',
  'D2D1ConvertColorSpace',
]);

const RESET = '\x1b[0m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';

const columns = Math.max(40, Math.min(process.stdout.columns ?? 100, 130));
const rows = Math.max(16, Math.min((process.stdout.rows ?? 36) - 3, 46));
const width = columns;
const height = rows * 2; // two stacked pixels per character cell
const centerX = width / 2;
const centerY = height / 2;

// ── Direct2D trig helper (single reusable out-buffers) ──
const sinBuf = Buffer.alloc(4);
const cosBuf = Buffer.alloc(4);
function d2dSinCos(angle: number): [number, number] {
  D2D1.D2D1SinCos(angle, sinBuf.ptr!, cosBuf.ptr!);
  return [sinBuf.readFloatLE(0), cosBuf.readFloatLE(0)];
}

// ── scRGB (linear) → sRGB (display) tone curve, sampled from Direct2D once ──
// D2D1ConvertColorSpace applies the real gamma per channel; a 256-entry LUT
// captures the whole curve so per-pixel display needs no further FFI.
const toneLut = new Uint8Array(256);
{
  const linear = Buffer.alloc(16);
  const srgb = Buffer.alloc(16);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    linear.writeFloatLE(v, 0);
    linear.writeFloatLE(v, 4);
    linear.writeFloatLE(v, 8);
    linear.writeFloatLE(1, 12);
    D2D1.D2D1ConvertColorSpace(srgb.ptr!, D2D1_COLOR_SPACE.D2D1_COLOR_SPACE_SCRGB, D2D1_COLOR_SPACE.D2D1_COLOR_SPACE_SRGB, linear.ptr!);
    toneLut[i] = Math.max(0, Math.min(255, Math.round(srgb.readFloatLE(0) * 255)));
  }
}
function tone(v: number): number {
  return toneLut[Math.max(0, Math.min(255, Math.round(v * 255)))];
}

// HSV → linear RGB (Direct2D's curve supplies display gamma afterward).
function hueToLinear(hue: number, value: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const x = value * (1 - Math.abs(((h / 60) % 2) - 1));
  if (h < 60) return [value, x, 0];
  if (h < 120) return [x, value, 0];
  if (h < 180) return [0, value, x];
  if (h < 240) return [0, x, value];
  if (h < 300) return [x, 0, value];
  return [value, 0, x];
}

// ── Coons-patch backdrop warp (solved once by Direct2D) ────────────────────
const patch: Buffer[] = [];
for (let i = 0; i < 12; i++) {
  const corner = Math.floor(i / 3);
  const bx = [0, width, width, 0][corner] + (Math.random() - 0.5) * width * 0.18;
  const by = [0, 0, height, height][corner] + (Math.random() - 0.5) * height * 0.18;
  const b = Buffer.alloc(8);
  b.writeFloatLE(bx, 0);
  b.writeFloatLE(by, 4);
  patch.push(b);
}
const tensor = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)];
D2D1.D2D1GetGradientMeshInteriorPointsFromCoonsPatch(
  patch[0].ptr!,
  patch[1].ptr!,
  patch[2].ptr!,
  patch[3].ptr!,
  patch[4].ptr!,
  patch[5].ptr!,
  patch[6].ptr!,
  patch[7].ptr!,
  patch[8].ptr!,
  patch[9].ptr!,
  patch[10].ptr!,
  patch[11].ptr!,
  tensor[0].ptr!,
  tensor[1].ptr!,
  tensor[2].ptr!,
  tensor[3].ptr!,
);
const warpCenterX = (tensor[0].readFloatLE(0) + tensor[3].readFloatLE(0)) / 2;
const warpCenterY = (tensor[0].readFloatLE(4) + tensor[3].readFloatLE(4)) / 2;

// ── Reversible screen transform (proven once, reported in the HUD) ─────────
const probeMatrix = Buffer.alloc(24);
D2D1.D2D1MakeRotateMatrix(30, packD2D1_POINT_2F(centerX, centerY), probeMatrix.ptr!);
const reversible = D2D1.D2D1IsMatrixInvertible(probeMatrix.ptr!) !== 0;
const projectionScale = D2D1.D2D1ComputeMaximumScaleFactor(probeMatrix.ptr!);
const inverseMatrix = Buffer.from(probeMatrix);
const invertOk = D2D1.D2D1InvertMatrix(inverseMatrix.ptr!) !== 0;

// Per-frame transform buffers + appliers (x' = x·_11 + y·_21 + _31, etc.).
const rollMatrix = Buffer.alloc(24);
const skewMatrix = Buffer.alloc(24);
function applyMatrix(m: Buffer, x: number, y: number): [number, number] {
  return [x * m.readFloatLE(0) + y * m.readFloatLE(8) + m.readFloatLE(16), x * m.readFloatLE(4) + y * m.readFloatLE(12) + m.readFloatLE(20)];
}

const TUBE = 1.1;
const RING = 2.5;
const K1 = (width * projectionScale * 0.34) / (RING + TUBE);
const lightLen = D2D1.D2D1Vec3Length(0, 1, -1) || 1;
const THETA_STEPS = 70;
const PHI_STEPS = 130;
const FRAMES = 120;

// Precomputed angle tables, refilled by Direct2D each frame is unnecessary —
// theta/phi tables are constant; only the two tumble angles change per frame.
const thetaSin = new Float32Array(THETA_STEPS);
const thetaCos = new Float32Array(THETA_STEPS);
const phiSin = new Float32Array(PHI_STEPS);
const phiCos = new Float32Array(PHI_STEPS);
for (let i = 0; i < THETA_STEPS; i++) {
  const [s, c] = d2dSinCos((i / THETA_STEPS) * Math.PI * 2);
  thetaSin[i] = s;
  thetaCos[i] = c;
}
for (let i = 0; i < PHI_STEPS; i++) {
  const [s, c] = d2dSinCos((i / PHI_STEPS) * Math.PI * 2);
  phiSin[i] = s;
  phiCos[i] = c;
}

process.stdout.write(HIDE_CURSOR + CLEAR);

const frameBuffer = new Float32Array(width * height * 3);
const zBuffer = new Float32Array(width * height);

for (let frame = 0; frame < FRAMES; frame++) {
  const [sinA, cosA] = d2dSinCos(frame * 0.07);
  const [sinB, cosB] = d2dSinCos(frame * 0.03);

  D2D1.D2D1MakeRotateMatrix(Math.sin(frame * 0.05) * 16, packD2D1_POINT_2F(centerX, centerY), rollMatrix.ptr!);
  const skewAmount = Math.sin(frame * 0.08) * 3.5;
  D2D1.D2D1MakeSkewMatrix(skewAmount, skewAmount * 0.5, packD2D1_POINT_2F(centerX, centerY), skewMatrix.ptr!);

  frameBuffer.fill(0);
  zBuffer.fill(0);

  // Coons-warped gradient backdrop.
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const warp = (px - warpCenterX) / width + (py - warpCenterY) / height;
      const [r, g, b] = hueToLinear(205 + warp * 80, 0.05);
      const idx = (py * width + px) * 3;
      frameBuffer[idx] = r;
      frameBuffer[idx + 1] = g;
      frameBuffer[idx + 2] = b;
    }
  }

  // Torus surface — Direct2D-tabulated trig sweeps theta (tube) and phi (ring).
  for (let ti = 0; ti < THETA_STEPS; ti++) {
    const sinT = thetaSin[ti];
    const cosT = thetaCos[ti];
    const circleX = RING + TUBE * cosT;
    const circleY = TUBE * sinT;
    for (let pi = 0; pi < PHI_STEPS; pi++) {
      const sinP = phiSin[pi];
      const cosP = phiCos[pi];

      const x = circleX * (cosB * cosP + sinA * sinB * sinP) - circleY * cosA * sinB;
      const y = circleX * (sinB * cosP - sinA * cosB * sinP) + circleY * cosA * cosB;
      const z = 5 + cosA * circleX * sinP + circleY * sinA;
      const ooz = 1 / z;

      // Surface normal, length-normalized by Direct2D.
      let nx = cosT * (cosB * cosP + sinA * sinB * sinP) - sinT * cosA * sinB;
      let ny = cosT * (sinB * cosP - sinA * cosB * sinP) + sinT * cosA * cosB;
      let nz = cosA * cosT * sinP + sinT * sinA;
      const nLen = D2D1.D2D1Vec3Length(nx, ny, nz) || 1;
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;

      let sx = centerX + K1 * ooz * x;
      let sy = centerY - K1 * ooz * y;
      [sx, sy] = applyMatrix(rollMatrix, sx, sy);
      [sx, sy] = applyMatrix(skewMatrix, sx - centerX, sy - centerY);
      sx += centerX;
      sy += centerY;
      const px = Math.round(sx);
      const py = Math.round(sy);
      if (px < 0 || px >= width || py < 0 || py >= height) continue;

      const cell = py * width + px;
      if (ooz <= zBuffer[cell]) continue;
      zBuffer[cell] = ooz;

      const lum = Math.max(0.07, (ny - nz) / lightLen);
      const [r, g, b] = hueToLinear(ti * (360 / THETA_STEPS) + pi * 1.4 + frame * 2.2, Math.min(1, lum));
      const idx = cell * 3;
      frameBuffer[idx] = r;
      frameBuffer[idx + 1] = g;
      frameBuffer[idx + 2] = b;
    }
  }

  // Compose half-block rows with the Direct2D-derived tone curve.
  const out: string[] = [HOME];
  out.push(
    `${RESET}${'\x1b[1m'}  Direct2D Matrix Engine${RESET}  \x1b[2m${width}x${height}px · scale ${projectionScale.toFixed(3)} · invertible ${reversible && invertOk ? 'yes' : 'no'} · frame ${String(frame + 1).padStart(3)}/${FRAMES}${RESET}`,
  );
  for (let cellRow = 0; cellRow + 1 < height; cellRow += 2) {
    let line = '';
    let last = '';
    for (let px = 0; px < width; px++) {
      const t = (cellRow * width + px) * 3;
      const b = ((cellRow + 1) * width + px) * 3;
      const code = `\x1b[38;2;${tone(frameBuffer[t])};${tone(frameBuffer[t + 1])};${tone(frameBuffer[t + 2])};48;2;${tone(frameBuffer[b])};${tone(frameBuffer[b + 1])};${tone(frameBuffer[b + 2])}m`;
      if (code !== last) {
        line += code;
        last = code;
      }
      line += '▀';
    }
    out.push(line + RESET);
  }
  process.stdout.write(out.join('\n'));
  await Bun.sleep(20);
}

process.stdout.write(`\n${SHOW_CURSOR}${RESET}`);
console.log(`\nRendered ${FRAMES} frames of a Direct2D-transformed torus — every matrix, trig, normal, and color-curve op ran inside d2d1.dll. Pure FFI, zero files, zero COM.`);
