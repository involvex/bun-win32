/**
 * Offline trainer for digit-oracle (one-off; NOT shipped, NOT run at demo time).
 *
 * Rasterizes the OS's own TrueType digit glyphs (0-9) across several font faces,
 * weights, sizes, with random shift / scale / rotation / thickness augmentation,
 * via GDI (CreateDIBSection + CreateFontW + TextOutW) into 28x28 grayscale samples.
 * Then trains a vanilla SGD 784->128->10 MLP (ReLU + softmax/cross-entropy) in pure
 * TypeScript and emits example/digit-oracle.weights.ts (base64 of the raw Float32
 * weights). Zero external dataset dependency, fully reproducible in-repo.
 *
 * Run: bun run packages/all/example/digit-oracle.train.ts
 */
import { FFIType, read, type Pointer } from 'bun:ffi';
import { GDI32 } from '../index';

const N_IN = 784;
const N_HID = 128;
const N_OUT = 10;
const GRID = 28;

// ── GDI offscreen DIB to rasterize a centered digit glyph at a chosen size ───────
const DIB_W = 64;
const DIB_H = 64;
const memDC = GDI32.CreateCompatibleDC(0n);
// BITMAPINFOHEADER (40 bytes) — 32bpp top-down DIB.
const bmi = Buffer.alloc(40);
bmi.writeUInt32LE(40, 0); // biSize
bmi.writeInt32LE(DIB_W, 4); // biWidth
bmi.writeInt32LE(-DIB_H, 8); // biHeight (negative = top-down)
bmi.writeUInt16LE(1, 12); // biPlanes
bmi.writeUInt16LE(32, 14); // biBitCount
bmi.writeUInt32LE(0, 16); // biCompression = BI_RGB
const ppBits = Buffer.alloc(8);
const dib = GDI32.CreateDIBSection(memDC, bmi.ptr!, 0 /* DIB_RGB_COLORS */, ppBits.ptr!, 0n, 0);
const bitsPtr = Number(ppBits.readBigUInt64LE(0)) as Pointer;
GDI32.SelectObject(memDC, dib);
GDI32.SetBkMode(memDC, 2 /* OPAQUE */);
GDI32.SetBkColor(memDC, 0x000000); // black background
GDI32.SetTextColor(memDC, 0xffffff); // white text
GDI32.SetTextAlign(memDC, 0 /* TA_LEFT|TA_TOP */);

const FONTS = ['Segoe UI', 'Arial', 'Calibri', 'Tahoma', 'Verdana', 'Times New Roman', 'Consolas'];
const wide = (s: string): Buffer => Buffer.from(`${s}\0`, 'utf16le');
const fontNameBufs = FONTS.map((f) => wide(f));

function rasterGlyph(digit: number, size: number, weight: number, italic: number, escapement: number, fontIdx: number): Float32Array {
  const font = GDI32.CreateFontW(
    -size, 0, escapement, escapement, weight, italic, 0, 0,
    0 /* DEFAULT_CHARSET */, 0, 0, 4 /* ANTIALIASED_QUALITY */, 0, fontNameBufs[fontIdx]!.ptr!,
  );
  const prev = GDI32.SelectObject(memDC, font);
  const ch = wide(String(digit));
  const x = 16;
  const y = 6;
  // Clear the whole DIB with an opaque black rectangle, then draw the glyph white.
  const rect = Buffer.alloc(16);
  rect.writeInt32LE(0, 0);
  rect.writeInt32LE(0, 4);
  rect.writeInt32LE(DIB_W, 8);
  rect.writeInt32LE(DIB_H, 12);
  GDI32.ExtTextOutW(memDC, 0, 0, 2 /* ETO_OPAQUE */, rect.ptr!, null, 0, null);
  GDI32.TextOutW(memDC, x, y, ch.ptr!, 1);
  GDI32.SelectObject(memDC, prev);
  GDI32.DeleteObject(font);

  // Read DIB pixels (BGRA), reduce to grayscale intensity in the 64x64 buffer.
  const big = new Float32Array(DIB_W * DIB_H);
  let minX = DIB_W;
  let minY = DIB_H;
  let maxX = -1;
  let maxY = -1;
  for (let yy = 0; yy < DIB_H; yy += 1) {
    for (let xx = 0; xx < DIB_W; xx += 1) {
      const off = (yy * DIB_W + xx) * 4;
      const b = read.u8(bitsPtr, off);
      const g = read.u8(bitsPtr, off + 1);
      const r = read.u8(bitsPtr, off + 2);
      const v = (r + g + b) / (3 * 255);
      big[yy * DIB_W + xx] = v;
      if (v > 0.18) {
        if (xx < minX) minX = xx;
        if (xx > maxX) maxX = xx;
        if (yy < minY) minY = yy;
        if (yy > maxY) maxY = yy;
      }
    }
  }
  // Center-of-mass crop → resample into 20x20 box centered in 28x28 (MNIST convention).
  const out = new Float32Array(N_IN);
  if (maxX < minX) return out; // blank glyph
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const scale = 20 / Math.max(bw, bh);
  const ow = bw * scale;
  const oh = bh * scale;
  const offX = (28 - ow) / 2;
  const offY = (28 - oh) / 2;
  for (let py = 0; py < 28; py += 1) {
    for (let px = 0; px < 28; px += 1) {
      // Map this 28-grid cell back into the source bbox (bilinear).
      const sx = minX + ((px - offX) / scale);
      const sy = minY + ((py - offY) / scale);
      if (sx < 0 || sy < 0 || sx >= DIB_W - 1 || sy >= DIB_H - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const a = big[y0 * DIB_W + x0]!;
      const bb = big[y0 * DIB_W + x0 + 1]!;
      const c = big[(y0 + 1) * DIB_W + x0]!;
      const d = big[(y0 + 1) * DIB_W + x0 + 1]!;
      out[py * 28 + px] = a * (1 - fx) * (1 - fy) + bb * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }
  }
  // Recenter by center of mass (so all samples are centroid-aligned like MNIST).
  return recenter(out);
}

function recenter(img: Float32Array): Float32Array {
  let sum = 0;
  let cx = 0;
  let cy = 0;
  for (let y = 0; y < 28; y += 1) {
    for (let x = 0; x < 28; x += 1) {
      const v = img[y * 28 + x]!;
      sum += v;
      cx += x * v;
      cy += y * v;
    }
  }
  if (sum < 1e-4) return img;
  cx /= sum;
  cy /= sum;
  const dx = Math.round(13.5 - cx);
  const dy = Math.round(13.5 - cy);
  if (dx === 0 && dy === 0) return img;
  const out = new Float32Array(N_IN);
  for (let y = 0; y < 28; y += 1) {
    for (let x = 0; x < 28; x += 1) {
      const sx = x - dx;
      const sy = y - dy;
      if (sx >= 0 && sx < 28 && sy >= 0 && sy < 28) out[y * 28 + x] = img[sy * 28 + sx]!;
    }
  }
  return out;
}

// ── Build a labeled training set with augmentation ───────────────────────────────
console.log('Rasterizing synthetic digit glyphs via GDI...');
const samples: Float32Array[] = [];
const labels: number[] = [];
let s = 0xc0ffee >>> 0;
const rand = (): number => {
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
  return s / 0x1_0000_0000;
};
const PER_DIGIT = 1400;
for (let digit = 0; digit < 10; digit += 1) {
  for (let k = 0; k < PER_DIGIT; k += 1) {
    const fontIdx = Math.floor(rand() * FONTS.length);
    const size = 34 + Math.floor(rand() * 14); // 34..47 px tall in 64-DIB
    const weight = rand() < 0.5 ? 400 : 700;
    const italic = rand() < 0.18 ? 1 : 0;
    const escapement = Math.round((rand() - 0.5) * 280); // small rotation (tenths of deg)
    let img = rasterGlyph(digit, size, weight, italic, escapement, fontIdx);
    img = jitter(img, rand);
    samples.push(img);
    labels.push(digit);
  }
  process.stdout.write(`  digit ${digit} done\r`);
}
console.log(`\nGenerated ${samples.length} samples.`);

// Small pixel-space jitter: translate a few px + add light noise + thickness via blur.
function jitter(img: Float32Array, rnd: () => number): Float32Array {
  const dx = Math.round((rnd() - 0.5) * 4);
  const dy = Math.round((rnd() - 0.5) * 4);
  const out = new Float32Array(N_IN);
  for (let y = 0; y < 28; y += 1) {
    for (let x = 0; x < 28; x += 1) {
      const sx = x - dx;
      const sy = y - dy;
      if (sx >= 0 && sx < 28 && sy >= 0 && sy < 28) out[y * 28 + x] = img[sy * 28 + sx]!;
    }
  }
  // Optional dilation (thicker strokes) ~30% of the time — closer to mouse input.
  if (rnd() < 0.35) {
    const d = new Float32Array(N_IN);
    for (let y = 0; y < 28; y += 1) {
      for (let x = 0; x < 28; x += 1) {
        let m = out[y * 28 + x]!;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx >= 0 && nx < 28 && ny >= 0 && ny < 28) m = Math.max(m, out[ny * 28 + nx]! * 0.85);
          }
        }
        d[y * 28 + x] = m;
      }
    }
    return d;
  }
  return out;
}

// ── Split train / test ───────────────────────────────────────────────────────────
const idx = [...samples.keys()];
for (let i = idx.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rand() * (i + 1));
  [idx[i], idx[j]] = [idx[j]!, idx[i]!];
}
const testCount = 1500;
const testIdx = idx.slice(0, testCount);
const trainIdx = idx.slice(testCount);

// ── MLP weights ────────────────────────────────────────────────────────────────
const W1 = new Float32Array(N_IN * N_HID);
const b1 = new Float32Array(N_HID);
const W2 = new Float32Array(N_HID * N_OUT);
const b2 = new Float32Array(N_OUT);
// He / Xavier init.
const sc1 = Math.sqrt(2 / N_IN);
const sc2 = Math.sqrt(2 / N_HID);
for (let i = 0; i < W1.length; i += 1) W1[i] = (rand() * 2 - 1) * sc1;
for (let i = 0; i < W2.length; i += 1) W2[i] = (rand() * 2 - 1) * sc2;

const h = new Float32Array(N_HID);
const logits = new Float32Array(N_OUT);
const probs = new Float32Array(N_OUT);
const dh = new Float32Array(N_HID);

function forward(x: Float32Array): void {
  for (let j = 0; j < N_HID; j += 1) {
    let acc = b1[j]!;
    const base = j; // W1 stored [in][hid] => index in*N_HID + j
    for (let i = 0; i < N_IN; i += 1) acc += x[i]! * W1[i * N_HID + base]!;
    h[j] = acc > 0 ? acc : 0;
  }
  for (let o = 0; o < N_OUT; o += 1) {
    let acc = b2[o]!;
    for (let j = 0; j < N_HID; j += 1) acc += h[j]! * W2[j * N_OUT + o]!;
    logits[o] = acc;
  }
  let mx = -Infinity;
  for (let o = 0; o < N_OUT; o += 1) if (logits[o]! > mx) mx = logits[o]!;
  let sum = 0;
  for (let o = 0; o < N_OUT; o += 1) {
    const e = Math.exp(logits[o]! - mx);
    probs[o] = e;
    sum += e;
  }
  for (let o = 0; o < N_OUT; o += 1) probs[o] = probs[o]! / sum;
}

const LR = 0.06;
const EPOCHS = 22;
console.log('Training MLP 784->128->10...');
for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
  // Shuffle train order each epoch.
  for (let i = trainIdx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [trainIdx[i], trainIdx[j]] = [trainIdx[j]!, trainIdx[i]!];
  }
  let loss = 0;
  const lr = LR * (1 - epoch / (EPOCHS + 4));
  for (const si of trainIdx) {
    const x = samples[si]!;
    const y = labels[si]!;
    forward(x);
    loss += -Math.log(Math.max(probs[y]!, 1e-9));
    // Output bias grad + update b2: probs - onehot.
    for (let o = 0; o < N_OUT; o += 1) {
      const g = probs[o]! - (o === y ? 1 : 0);
      b2[o] = b2[o]! - lr * g;
    }
    // Hidden grad (uses the pre-update W2 below before W2 is written).
    for (let j = 0; j < N_HID; j += 1) {
      let acc = 0;
      for (let o = 0; o < N_OUT; o += 1) acc += (probs[o]! - (o === y ? 1 : 0)) * W2[j * N_OUT + o]!;
      dh[j] = h[j]! > 0 ? acc : 0;
    }
    // Update W2 (after using old values above is fine since we read W2 before writing it here).
    for (let j = 0; j < N_HID; j += 1) {
      const hv = h[j]!;
      if (hv === 0) continue;
      for (let o = 0; o < N_OUT; o += 1) {
        const g = probs[o]! - (o === y ? 1 : 0);
        W2[j * N_OUT + o] = W2[j * N_OUT + o]! - lr * g * hv;
      }
    }
    // Update W1,b1.
    for (let j = 0; j < N_HID; j += 1) {
      const g = dh[j]!;
      if (g === 0) continue;
      b1[j] = b1[j]! - lr * g;
      for (let i = 0; i < N_IN; i += 1) {
        const xv = x[i]!;
        if (xv !== 0) W1[i * N_HID + j] = W1[i * N_HID + j]! - lr * g * xv;
      }
    }
  }
  // Eval.
  let correct = 0;
  for (const ti of testIdx) {
    forward(samples[ti]!);
    let am = 0;
    for (let o = 1; o < N_OUT; o += 1) if (probs[o]! > probs[am]!) am = o;
    if (am === labels[ti]) correct += 1;
  }
  console.log(`  epoch ${epoch + 1}/${EPOCHS}  loss=${(loss / trainIdx.length).toFixed(4)}  test acc=${((100 * correct) / testIdx.length).toFixed(2)}%`);
}

// ── Bake weights → base64 of concatenated Float32 [W1,b1,W2,b2] ──────────────────
const flat = new Float32Array(W1.length + b1.length + W2.length + b2.length);
let off = 0;
flat.set(W1, off);
off += W1.length;
flat.set(b1, off);
off += b1.length;
flat.set(W2, off);
off += W2.length;
flat.set(b2, off);
const b64 = Buffer.from(flat.buffer).toString('base64');

// Also bake one reference test digit (the held-out sample for digit "3") so the demo
// can pre-stamp a recognizable glyph at startup and self-verify.
function pickRef(target: number): Float32Array {
  for (const ti of testIdx) {
    if (labels[ti] === target) {
      forward(samples[ti]!);
      let am = 0;
      for (let o = 1; o < N_OUT; o += 1) if (probs[o]! > probs[am]!) am = o;
      if (am === target && probs[target]! > 0.6) return samples[ti]!;
    }
  }
  return samples[testIdx.find((ti) => labels[ti] === target)!]!;
}
const ref3 = pickRef(3);
const ref7 = pickRef(7);
const ref3b64 = Buffer.from(ref3.buffer.slice(ref3.byteOffset, ref3.byteOffset + ref3.byteLength)).toString('base64');
const ref7b64 = Buffer.from(ref7.buffer.slice(ref7.byteOffset, ref7.byteOffset + ref7.byteLength)).toString('base64');

const fileContents = `/**
 * Baked MLP weights for digit-oracle (784->128->10), trained OFFLINE by
 * digit-oracle.train.ts on synthetic GDI-rasterized digit glyphs. Generated; do not
 * edit by hand. Layout of WEIGHTS_B64 (raw Float32 little-endian, concatenated):
 *   W1[${N_IN}*${N_HID}], b1[${N_HID}], W2[${N_HID}*${N_OUT}], b2[${N_OUT}].
 * REF3/REF7_B64 are two pre-classified 28x28 reference glyphs (Float32 length 784).
 */
export const N_IN = ${N_IN};
export const N_HID = ${N_HID};
export const N_OUT = ${N_OUT};
export const WEIGHTS_B64 = '${b64}';
export const REF3_B64 = '${ref3b64}';
export const REF7_B64 = '${ref7b64}';
`;
await Bun.write(`${import.meta.dir}/digit-oracle.weights.ts`, fileContents);
console.log(`Wrote digit-oracle.weights.ts (${(fileContents.length / 1024).toFixed(0)} KB text, ${flat.length} floats).`);

GDI32.DeleteObject(dib);
GDI32.DeleteDC(memDC);
console.log('Done.');
