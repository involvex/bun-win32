/**
 * Neural Descent — a real neural network that TRAINS ITSELF LIVE on your GPU.
 *
 * A coordinate MLP  f(x, y) -> RGB  is overfit, in real time, to a procedurally
 * generated TARGET image — a layered CINEMATIC SUNSET: a graded violet→coral→gold
 * sky, a huge radiant sun on the center seam, a violet mountain ridge, a glittering
 * sun-reflecting sea, a rolling foreground hill, a lone tree silhouette and two
 * birds. Forward propagation, the loss, full backpropagation, and the ADAM optimizer
 * step are ALL hand-written Direct3D 11 COMPUTE shaders run over structured buffers —
 * there is no DirectML, no library, no precomputed weights. The network is
 * initialized from a seeded Xavier distribution in pure TypeScript, uploaded once,
 * and from then on every parameter is updated entirely on the hardware ID3D11Device.
 *
 * The frame is split down the middle: the LEFT half is the analytic TARGET, the
 * RIGHT half is the network's PREDICTION of the identical world coordinate. The sun,
 * ridge and sea all straddle the seam, so as the mean-squared error plummets the two
 * halves fuse into ONE continuous picture and the seam all but vanishes — you WATCH
 * the net reconstruct the image, frame by frame, until "TARGET" and "NEURAL NET"
 * agree. A live, baked-in LOSS-CURVE HUD plots the falling MSE in real time.
 *
 * The architecture is the one that actually works for this:
 *   input  : a 32-feature FOURIER positional encoding of (x, y)  — sin/cos at a
 *            geometric ladder of 8 frequencies. This is the trick that lets a tiny
 *            MLP learn sharp edges and fine color fast (NeRF-style).
 *   hidden : 32 -> 80 -> 80, ReLU
 *   output : 80 -> 3, sigmoid  -> RGB in [0,1]
 *
 * Pipeline, per training STEP (many steps per displayed frame so learning is fast):
 *   1. ZERO-GRAD  CS  — clear the fixed-point gradient + loss accumulators.
 *   2. TRAIN      CS [numthreads(64,1,1)] over a batch of pixels: each thread picks
 *      a hashed pixel coord, builds its Fourier features, runs the FULL forward
 *      pass keeping activations in registers, reads the TARGET pixel, computes the
 *      output delta (sigmoid'·(out-target)·2/N), then BACK-PROPAGATES layer by
 *      layer — manual flat-index matmuls — accumulating dL/dW and dL/db into uint
 *      buffers with InterlockedAdd (fixed-point), and the MSE into a uint Loss cell.
 *   3. ADAM       CS  — one elementwise dispatch per parameter buffer maintains the
 *      first/second moments (m,s) and applies the bias-corrected adaptive step
 *      W -= lr·m̂/(√ŝ+ε). Adam (vs plain SGD) is what drives the loss two orders of
 *      magnitude down so the prediction becomes genuinely CRISP, not just blurred.
 * Rendering is two passes: a PIXEL shader evaluates the CURRENT weights per pixel
 * into an offscreen HDR texture; a COMPOSITE shader then paints TARGET | prediction
 * with a thin scanning seam line, a tiny low-pass on the net side, bitmap-font
 * "TARGET" / "NEURAL NET" labels, a vignette, and a glassy LIVE LOSS-CURVE HUD panel
 * (the falling log-MSE curve + glowing head dot + grid, the "LOSS" title, the headline
 * "MSE" value and the "STEP" count) — all baked into the frame so they survive the
 * gallery capture. A lightweight GDI overlay adds the title line and fps on the live
 * window. The loss curve is fed from a CPU-resampled, log-normalized history of the
 * GPU-read MSE through a cpu-writable structured buffer (SRV t1).
 *
 * @bun-win32 APIs used (see ./_gpu.ts): createWindow / createDevice / recreateRTV /
 *   compile / makeComputeShader / makeVertexShader / makePixelShader /
 *   makeStructuredBuffer (weights + Adam moments + uint grads, UAV+SRV) /
 *   makeTexture (offscreen HDR prediction, RTV+SRV) / makeSampler / makeConstantBuffer /
 *   updateConstantBuffer / dispatch / vsSet / psSet / setRenderTargets /
 *   setViewport / clear / drawFullscreenTriangle / readbackBuffer / present /
 *   comRelease — plus GDI32 CreateFontW/TextOutW for the HUD and _snapshot for the
 *   gallery capture.
 *
 * Run: bun run packages/all/example/neural-descent.ts
 */

import { FFIType } from 'bun:ffi';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import { GDI32 } from '../index';
import {
  CTX_CS_SET_SHADER_RESOURCES,
  CTX_CS_SET_UNORDERED_ACCESS_VIEWS,
  D3D11_FILTER_MIN_MAG_MIP_LINEAR,
  D3D11_TEXTURE_ADDRESS_CLAMP,
  DXGI_FORMAT_R16G16B16A16_FLOAT,
  clear,
  comRelease,
  compile,
  createDevice,
  createWindow,
  dispatch,
  drawFullscreenTriangle,
  makeComputeShader,
  makeConstantBuffer,
  makePixelShader,
  makeSampler,
  makeStructuredBuffer,
  makeTexture,
  makeVertexShader,
  psSet,
  readbackBuffer,
  setRenderTargets,
  setViewport,
  updateConstantBuffer,
  updateDynamicBuffer,
  vcall,
  vsSet,
} from './_gpu';
import { captureBackBuffer, formatGrid } from './_snapshot';
import * as hud from './_hud';

const encodeWide = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');

// ── Resolution & network topology ─────────────────────────────────────────────
const WIDTH = 1280;
const HEIGHT = 720;

const NUM_FREQ = 8; // geometric frequency ladder; 8 bands give the MLP enough
                    // high-frequency basis to fit the layered horizon, cloud bands,
                    // ridge silhouettes and the crisp sun rim without Gibbs ringing.
const INPUT = NUM_FREQ * 4; // sin/cos × (x,y) = 32 features
const H1 = 80;
const H2 = 80;
const OUT = 3;

const W1_N = H1 * INPUT; // 2048
const W2_N = H2 * H1; // 4096
const W3_N = OUT * H2; // 192

// Fixed-point scale for InterlockedAdd gradient accumulation. Finer than 2^20: near
// convergence the gradients are tiny, and coarse quantization noise gets amplified
// by Adam's 1/sqrt(v) term — a higher scale keeps the late-training fit stable.
const GRAD_SCALE = 1 << 24; // 16,777,216

const BATCH = 12288; // pixel samples per training step (more coverage -> crisper, and
                     // the richer scene has more detail to cover per step)
const STEPS_PER_FRAME = 56; // training steps between displayed frames (more total
                            // steps in the fixed capture window -> crisper net)
const LR = 0.012; // Adam base learning rate
const ADAM_B1 = 0.9; // 1st-moment decay
const ADAM_B2 = 0.999; // 2nd-moment decay
const ADAM_EPS = 1e-8; // numerical floor
const DECAY_STEPS = 10000; // anneal LR across the whole ~11k-step capture window so the
                           // net keeps making progress, then settles crisp at the end

// ── Window + device ─────────────────────────────────────────────────────────────
const win = createWindow({ title: 'Neural Descent — a GPU neural net training itself live', width: WIDTH, height: HEIGHT, borderless: true });
const { w: clientW, h: clientH } = win.clientSize();
const gpu = createDevice(win.hwnd, { width: clientW, height: clientH });
gpu.recreateRTV();

// ── Seeded Xavier weight init (deterministic) ─────────────────────────────────
let seed = 0x9e3779b9 >>> 0;
function rand(): number {
  // xorshift32
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 0x1_0000_0000;
}
function randn(): number {
  // Box–Muller
  const u = Math.max(1e-7, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function xavier(count: number, fanIn: number, fanOut: number): Buffer {
  const std = Math.sqrt(2 / (fanIn + fanOut));
  const buf = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i += 1) buf.writeFloatLE(randn() * std, i * 4);
  return buf;
}
const zeros = (count: number): Buffer => Buffer.alloc(count * 4);

// Weights (float, UAV for SGD writes + SRV for the render PS to read the live net).
const w1 = makeStructuredBuffer({ stride: 4, count: W1_N, uav: true, srv: true, initialData: xavier(W1_N, INPUT, H1) });
const b1 = makeStructuredBuffer({ stride: 4, count: H1, uav: true, srv: true, initialData: zeros(H1) });
const w2 = makeStructuredBuffer({ stride: 4, count: W2_N, uav: true, srv: true, initialData: xavier(W2_N, H1, H2) });
const b2 = makeStructuredBuffer({ stride: 4, count: H2, uav: true, srv: true, initialData: zeros(H2) });
const w3 = makeStructuredBuffer({ stride: 4, count: W3_N, uav: true, srv: true, initialData: xavier(W3_N, H2, OUT) });
const b3 = makeStructuredBuffer({ stride: 4, count: OUT, uav: true, srv: true, initialData: zeros(OUT) });

// Gradient accumulators (uint fixed-point). UAV = InterlockedAdd target in TRAIN;
// SRV = read by the SGD kernel to apply the step.
const gw1 = makeStructuredBuffer({ stride: 4, count: W1_N, uav: true, srv: true });
const gb1 = makeStructuredBuffer({ stride: 4, count: H1, uav: true, srv: true });
const gw2 = makeStructuredBuffer({ stride: 4, count: W2_N, uav: true, srv: true });
const gb2 = makeStructuredBuffer({ stride: 4, count: H2, uav: true, srv: true });
const gw3 = makeStructuredBuffer({ stride: 4, count: W3_N, uav: true, srv: true });
const gb3 = makeStructuredBuffer({ stride: 4, count: OUT, uav: true, srv: true });

// ADAM optimizer state: first moment m (mw*/mb*) and second moment s (sw*/sb*),
// one float per parameter, zero-initialized. Adam's per-parameter adaptive step is
// what drives the loss FAR below plain/momentum SGD's plateau, so the network's
// reconstruction becomes genuinely crisp (not just blurred) — both halves sharp.
const mw1 = makeStructuredBuffer({ stride: 4, count: W1_N, uav: true, srv: true, initialData: zeros(W1_N) });
const mb1 = makeStructuredBuffer({ stride: 4, count: H1, uav: true, srv: true, initialData: zeros(H1) });
const mw2 = makeStructuredBuffer({ stride: 4, count: W2_N, uav: true, srv: true, initialData: zeros(W2_N) });
const mb2 = makeStructuredBuffer({ stride: 4, count: H2, uav: true, srv: true, initialData: zeros(H2) });
const mw3 = makeStructuredBuffer({ stride: 4, count: W3_N, uav: true, srv: true, initialData: zeros(W3_N) });
const mb3 = makeStructuredBuffer({ stride: 4, count: OUT, uav: true, srv: true, initialData: zeros(OUT) });
const sw1 = makeStructuredBuffer({ stride: 4, count: W1_N, uav: true, srv: true, initialData: zeros(W1_N) });
const sb1 = makeStructuredBuffer({ stride: 4, count: H1, uav: true, srv: true, initialData: zeros(H1) });
const sw2 = makeStructuredBuffer({ stride: 4, count: W2_N, uav: true, srv: true, initialData: zeros(W2_N) });
const sb2 = makeStructuredBuffer({ stride: 4, count: H2, uav: true, srv: true, initialData: zeros(H2) });
const sw3 = makeStructuredBuffer({ stride: 4, count: W3_N, uav: true, srv: true, initialData: zeros(W3_N) });
const sb3 = makeStructuredBuffer({ stride: 4, count: OUT, uav: true, srv: true, initialData: zeros(OUT) });

// Loss accumulator (uint fixed-point), 1 element.
const loss = makeStructuredBuffer({ stride: 4, count: 1, uav: true });

// Loss-history ring for the IN-FRAME loss curve (CPU writes a normalized 0..1 height
// for each of LOSS_PLOT_N samples; the composite PS reads it as an SRV and plots a
// glowing curve). cpuWritable + SRV so it can be mapped every frame.
const LOSS_PLOT_N = 128;
const lossPlot = makeStructuredBuffer({ stride: 4, count: LOSS_PLOT_N, cpuWritable: true, srv: true, initialData: Buffer.alloc(LOSS_PLOT_N * 4) });
const lossPlotData = Buffer.alloc(LOSS_PLOT_N * 4);

// ── Constant buffer shared by every kernel + the render PS ────────────────────
// cbuffer Net (16-byte aligned):
//   uint  width, height, frame, batch;                       (16)
//   uint  totalSteps, count, bc1, bc2;                        (16)
//   float lr, gradScale, split, time;                         (16)
//   float b1, b2, eps, pad3;                                  (16)
//   float plotCount, plotLogLo, plotLogHi, scanY;             (16)  HUD-only
//   float curLoss, finalReady, pad6, pad7;                    (16)  HUD-only
const CB_SIZE = 96;
const cb = makeConstantBuffer(CB_SIZE);
const cbData = Buffer.alloc(CB_SIZE);

// ── Shared HLSL: constants, the network buffers, Fourier features, forward pass ─
const NET_DECLS = `
cbuffer Net : register(b0) {
  uint uWidth; uint uHeight; uint uFrame; uint uBatch;
  uint uTotalSteps; uint uCount; float uBc1; float uBc2;
  float uLr; float uGradScale; float uSplit; float uTime;
  float uB1; float uB2; float uEps; float uPad3;
  float uPlotCount; float uPlotLogLo; float uPlotLogHi; float uScanY;
  float uCurLoss; float uFinalReady; float uPad6; float uPad7;
};

#define NUM_FREQ ${NUM_FREQ}
#define INPUT ${INPUT}
#define H1 ${H1}
#define H2 ${H2}
#define OUTN ${OUT}
`;

// Fourier positional encoding of a normalized coord in [0,1]^2 -> INPUT features.
// Frequencies follow a geometric ladder (1,2,4,...) like NeRF; this is what lets a
// tiny MLP capture sharp edges and crisp color quickly.
const FOURIER = `
void fourier(float2 p, out float feat[INPUT]) {
  // center to [-1,1] for symmetric features
  float2 q = p * 2.0 - 1.0;
  [unroll]
  for (int k = 0; k < NUM_FREQ; k++) {
    float f = exp2(float(k)) * 3.14159265; // pi, 2pi, 4pi, ...
    feat[k * 4 + 0] = sin(q.x * f);
    feat[k * 4 + 1] = cos(q.x * f);
    feat[k * 4 + 2] = sin(q.y * f);
    feat[k * 4 + 3] = cos(q.y * f);
  }
}
`;

// The TARGET image, evaluated procedurally on the GPU. ONE bold, coherent, cinematic
// scene that SPANS THE WHOLE FRAME and crosses the center line: a layered SUNSET — a
// graded sky, a huge radiant sun on the seam, two ribbons of cloud drifting across it,
// receding mountain ridges, a glittering sea, and a foreground hill with a lone tree
// and a couple of birds. Every edge is band-limited (smoothstep, not step) so the
// 8-band Fourier MLP can fit it crisply without ringing. Because the sun + ridges +
// sea all straddle x=0.5, at convergence the left (target) and right (predicted)
// halves fuse into a single continuous picture and the seam all but vanishes.
const TARGET_IMG = `
// smooth value-noise-ish ridge for soft mountain/cloud edges (band-limited)
float wave(float x, float a, float b, float c, float d) {
  return a * sin(x * 6.28318 * b + c) + d;
}

float3 target(float2 uv) {
  float2 p = uv;                          // uv in [0,1], y down (0 = top)
  float aspect = float(uWidth) / float(uHeight);

  // ── Sky: indigo zenith -> royal violet -> magenta -> hot coral -> molten gold ──
  float horizon = 0.70;                   // lots of glowing sky
  float ty = saturate(p.y / horizon);
  float3 skyTop = float3(0.26, 0.18, 0.64);
  float3 skyHi  = float3(0.74, 0.28, 0.66);
  float3 skyMid = float3(1.00, 0.50, 0.42);
  float3 skyLow = float3(1.00, 0.84, 0.46);
  float3 sky = lerp(skyTop, skyHi,  smoothstep(0.00, 0.36, ty));
  sky        = lerp(sky,    skyMid, smoothstep(0.34, 0.72, ty));
  sky        = lerp(sky,    skyLow, smoothstep(0.70, 1.00, ty));
  float3 col = sky;

  // The SUN sits on the seam at x=0.5, above the horizon. Aspect-correct => round.
  float2 sun = float2(0.5, 0.44);
  float2 d2 = (p - sun) * float2(aspect, 1.0);
  float fd = length(d2);

  // ── Sun glow: broad warm halo that floods the upper sky with gold ──
  float halo = exp(-fd * 2.4);
  col = lerp(col, float3(1.00, 0.90, 0.60), saturate(halo * 1.00));
  float halo2 = exp(-fd * 6.0);
  col = lerp(col, float3(1.00, 0.98, 0.82), saturate(halo2 * 0.85));

  // ── Two cloud ribbons drifting across the sky + seam (drawn BEHIND the sun) ──
  float c1 = smoothstep(0.055, 0.0, abs(p.y - (0.26 + 0.020 * sin(p.x * 7.0))));
  c1 *= 0.6 + 0.4 * sin(p.x * 5.0 + 0.6);
  float c2 = smoothstep(0.05, 0.0, abs(p.y - (0.62 + 0.022 * sin(p.x * 5.0 + 1.3))));
  c2 *= 0.55 + 0.45 * sin(p.x * 6.3 - 0.4);
  float clouds = saturate(c1 * 0.8 + c2 * 0.9);
  float3 cloudCol = lerp(float3(0.95, 0.55, 0.62), float3(1.00, 0.82, 0.58), ty);
  col = lerp(col, cloudCol, clouds * 0.55);

  // ── Sun disc: incandescent core -> warm rim, soft band-limited edge so the
  // Fourier MLP fits the rim without Gibbs ringing (still reads crisp at scale) ──
  float R = 0.20;
  float disc = smoothstep(R + 0.024, R - 0.014, fd);
  float3 sunCol = lerp(float3(1.00, 0.99, 0.90), float3(1.00, 0.78, 0.30), saturate(fd / R));
  col = lerp(col, sunCol, disc);

  // ── Distant mountain ridge (silhouette violet) BELOW its top edge; crosses seam ──
  float ridgeY = 0.66 + 0.035 * wave(p.x, 1.0, 1.3, 0.4, 0.0) + 0.016 * wave(p.x, 1.0, 3.1, 2.0, 0.0);
  float ridge = smoothstep(ridgeY - 0.006, ridgeY + 0.006, p.y); // 1 below the line
  float3 ridgeCol = lerp(float3(0.42, 0.22, 0.48), float3(0.28, 0.13, 0.36), saturate((p.y - ridgeY) * 6.0));
  col = lerp(col, ridgeCol, ridge);

  // ── Sea: reflective water from the horizon down, with shimmering sun-glitter ──
  float seaTop = horizon;
  float inSea = smoothstep(seaTop - 0.004, seaTop + 0.004, p.y);
  float seaDepth = saturate((p.y - seaTop) / (1.0 - seaTop));
  float3 seaCol = lerp(float3(1.00, 0.66, 0.34), float3(0.16, 0.16, 0.46), seaDepth);
  // sun reflection column down the center, banded by a GENTLE shimmer. Keep the
  // shimmer frequency well within the 8-band Fourier budget so the net fits it
  // crisply instead of fighting unlearnable high-frequency speckle (lower MSE).
  float reflCol = exp(-abs(p.x - 0.5) * aspect * 4.0);
  float shimmer = 0.60 + 0.40 * sin(p.y * 26.0 + 0.5);
  seaCol = lerp(seaCol, float3(1.00, 0.94, 0.72), saturate(reflCol * shimmer * (1.0 - seaDepth) * 1.0));
  col = lerp(col, seaCol, inSea);

  // ── Foreground hill BELOW its rolling top edge, across the seam (warm shadow) ──
  float hillY = 0.86 + 0.04 * wave(p.x, 1.0, 0.9, 1.1, 0.0) + 0.012 * wave(p.x, 1.0, 2.7, 0.2, 0.0);
  float hill = smoothstep(hillY - 0.006, hillY + 0.006, p.y); // 1 below the line
  float3 hillCol = lerp(float3(0.30, 0.13, 0.26), float3(0.10, 0.05, 0.12), saturate((p.y - hillY) * 3.0));
  col = lerp(col, hillCol, hill);

  // ── Lone tree silhouette on the hill (trunk + soft round canopy), near x=0.26 ──
  float2 tb = float2(0.26, hillY);                      // tree base on the hill line
  float trunk = smoothstep(0.006, 0.0, abs((p.x - tb.x) * aspect))
              * smoothstep(0.0, 0.005, tb.y - p.y) * smoothstep(0.12, 0.0, tb.y - p.y);
  float2 canopyC = float2(0.26, hillY - 0.095);
  float canopy = smoothstep(0.054, 0.028, length((p - canopyC) * float2(aspect, 1.0)));
  float tree = saturate(trunk + canopy);
  col = lerp(col, float3(0.06, 0.02, 0.06), tree * smoothstep(hillY + 0.01, hillY - 0.005, p.y) + canopy);

  // ── Two birds (soft V strokes) gliding near the sun, right of the seam ──
  float2 b1c = float2(0.68, 0.22);
  float bd1 = abs(abs((p.x - b1c.x) * aspect) - (b1c.y - p.y));
  float bird1 = smoothstep(0.010, 0.0, bd1) * smoothstep(0.045, 0.0, length((p - b1c) * float2(aspect, 1.0)));
  float2 b2c = float2(0.76, 0.29);
  float bd2 = abs(abs((p.x - b2c.x) * aspect) - (b2c.y - p.y));
  float bird2 = smoothstep(0.009, 0.0, bd2) * smoothstep(0.038, 0.0, length((p - b2c) * float2(aspect, 1.0)));
  col = lerp(col, float3(0.18, 0.08, 0.16), saturate(bird1 + bird2) * 0.8);

  return saturate(col);
}
`;

// Forward pass over the LIVE weights (StructuredBuffer SRVs). Returns RGB in [0,1].
// Activations are kept in registers; ReLU on hidden, sigmoid on output.
const FORWARD_SRV = `
StructuredBuffer<float> W1 : register(t0);
StructuredBuffer<float> B1 : register(t1);
StructuredBuffer<float> W2 : register(t2);
StructuredBuffer<float> B2 : register(t3);
StructuredBuffer<float> W3 : register(t4);
StructuredBuffer<float> B3 : register(t5);

float3 netForward(float2 uv) {
  float feat[INPUT];
  fourier(uv, feat);

  float h1[H1];
  [loop]
  for (int j1 = 0; j1 < H1; j1++) {
    float s = B1[j1];
    [loop]
    for (int i1 = 0; i1 < INPUT; i1++) s += W1[j1 * INPUT + i1] * feat[i1];
    h1[j1] = max(s, 0.0); // ReLU
  }
  float h2[H2];
  [loop]
  for (int j2 = 0; j2 < H2; j2++) {
    float s = B2[j2];
    [loop]
    for (int i2 = 0; i2 < H1; i2++) s += W2[j2 * H1 + i2] * h1[i2];
    h2[j2] = max(s, 0.0);
  }
  float3 o;
  [unroll]
  for (int k = 0; k < OUTN; k++) {
    float s = B3[k];
    [loop]
    for (int i3 = 0; i3 < H2; i3++) s += W3[k * H2 + i3] * h2[i3];
    o[k] = 1.0 / (1.0 + exp(-s)); // sigmoid
  }
  return o;
}
`;

// ── ZERO-GRAD kernel: clear gradient + loss accumulators ───────────────────────
const ZERO_CS = `
${NET_DECLS}
RWStructuredBuffer<uint> GW1 : register(u0);
RWStructuredBuffer<uint> GB1 : register(u1);
RWStructuredBuffer<uint> GW2 : register(u2);
RWStructuredBuffer<uint> GB2 : register(u3);
RWStructuredBuffer<uint> GW3 : register(u4);
RWStructuredBuffer<uint> GB3 : register(u5);
RWStructuredBuffer<uint> Loss : register(u6);

[numthreads(256,1,1)]
void main(uint3 id : SV_DispatchThreadID) {
  uint i = id.x;
  if (i < ${W1_N}u) GW1[i] = 0u;
  if (i < ${W2_N}u) GW2[i] = 0u;
  if (i < ${W3_N}u) GW3[i] = 0u;
  if (i < ${H1}u)   GB1[i] = 0u;
  if (i < ${H2}u)   GB2[i] = 0u;
  if (i < ${OUT}u)  GB3[i] = 0u;
  if (i == 0u)      Loss[0] = 0u;
}
`;

// ── TRAIN kernel: forward + backprop + grad accumulate for a batch of pixels ───
// Weights are read through SRVs (t0..t5); gradients accumulated into UAVs (u0..u6)
// with fixed-point InterlockedAdd. Each thread = one sample in the batch.
const TRAIN_CS = `
${NET_DECLS}
${FOURIER}
${TARGET_IMG}

StructuredBuffer<float> W1 : register(t0);
StructuredBuffer<float> B1 : register(t1);
StructuredBuffer<float> W2 : register(t2);
StructuredBuffer<float> B2 : register(t3);
StructuredBuffer<float> W3 : register(t4);
StructuredBuffer<float> B3 : register(t5);

RWStructuredBuffer<uint> GW1 : register(u0);
RWStructuredBuffer<uint> GB1 : register(u1);
RWStructuredBuffer<uint> GW2 : register(u2);
RWStructuredBuffer<uint> GB2 : register(u3);
RWStructuredBuffer<uint> GW3 : register(u4);
RWStructuredBuffer<uint> GB3 : register(u5);
RWStructuredBuffer<uint> Loss : register(u6);

uint hash(uint s) {
  s ^= 2747636419u; s *= 2654435769u;
  s ^= s >> 16; s *= 2654435769u;
  s ^= s >> 16; s *= 2654435769u;
  return s;
}

// signed fixed-point InterlockedAdd: add float g (scaled) to a uint cell using
// two's-complement wrap (uint add == int add mod 2^32).
void atomicAddF(RWStructuredBuffer<uint> buf, uint idx, float g) {
  int q = (int)round(g * uGradScale);
  uint prev;
  InterlockedAdd(buf[idx], (uint)q, prev);
}

[numthreads(64,1,1)]
void main(uint3 id : SV_DispatchThreadID) {
  uint s = id.x;
  if (s >= uBatch) return;

  // Pick a pseudo-random pixel for this sample (decorrelated per step via frame).
  uint h = hash(s * 2654435761u + uFrame * 40503u + 0x9e3779b9u);
  uint px = h % uWidth;
  uint py = (h / uWidth) % uHeight;
  float2 uv = float2((float(px) + 0.5) / float(uWidth), (float(py) + 0.5) / float(uHeight));

  // ---- FORWARD (keep activations) ----
  float feat[INPUT];
  fourier(uv, feat);

  float z1[H1]; float a1[H1];
  [loop]
  for (int fj = 0; fj < H1; fj++) {
    float acc = B1[fj];
    [loop]
    for (int fi = 0; fi < INPUT; fi++) acc += W1[fj * INPUT + fi] * feat[fi];
    z1[fj] = acc; a1[fj] = max(acc, 0.0);
  }
  float z2[H2]; float a2[H2];
  [loop]
  for (int gj = 0; gj < H2; gj++) {
    float acc = B2[gj];
    [loop]
    for (int gi = 0; gi < H1; gi++) acc += W2[gj * H1 + gi] * a1[gi];
    z2[gj] = acc; a2[gj] = max(acc, 0.0);
  }
  float3 outv;
  [unroll]
  for (int ok = 0; ok < OUTN; ok++) {
    float acc = B3[ok];
    [loop]
    for (int hi = 0; hi < H2; hi++) acc += W3[ok * H2 + hi] * a2[hi];
    outv[ok] = 1.0 / (1.0 + exp(-acc));
  }

  // ---- LOSS + OUTPUT DELTA ----
  float3 tgt = target(uv);
  float3 diff = outv - tgt;
  float mse = (diff.x * diff.x + diff.y * diff.y + diff.z * diff.z) / 3.0;
  // accumulate the SUM of per-sample MSE (fixed-point 1e6); CPU divides by batch.
  uint lq; InterlockedAdd(Loss[0], (uint)(mse * 1000000.0), lq);

  // dL/dout averaged over the 3 channels and the batch; sigmoid'(z)=out*(1-out).
  float invN = 1.0 / float(uBatch);
  float3 dOut;
  [unroll]
  for (int dk = 0; dk < OUTN; dk++) {
    float dl = (2.0 / 3.0) * diff[dk] * invN;        // d(mse)/d(out_k)
    dOut[dk] = dl * outv[dk] * (1.0 - outv[dk]);      // * sigmoid'
  }

  // ---- BACKPROP layer 3 (output): dW3, dB3 ; delta2 = W3^T dOut ⊙ relu'(z2) ----
  float delta2[H2];
  [loop]
  for (int c2 = 0; c2 < H2; c2++) delta2[c2] = 0.0;
  [unroll]
  for (int bk = 0; bk < OUTN; bk++) {
    atomicAddF(GB3, (uint)bk, dOut[bk]);
    [loop]
    for (int b3i = 0; b3i < H2; b3i++) {
      atomicAddF(GW3, (uint)(bk * H2 + b3i), dOut[bk] * a2[b3i]);
      delta2[b3i] += dOut[bk] * W3[bk * H2 + b3i];
    }
  }
  [loop]
  for (int r2 = 0; r2 < H2; r2++) delta2[r2] *= (z2[r2] > 0.0) ? 1.0 : 0.0; // relu'

  // ---- BACKPROP layer 2: dW2, dB2 ; delta1 = W2^T delta2 ⊙ relu'(z1) ----
  float delta1[H1];
  [loop]
  for (int c1 = 0; c1 < H1; c1++) delta1[c1] = 0.0;
  [loop]
  for (int b2j = 0; b2j < H2; b2j++) {
    float d = delta2[b2j];
    atomicAddF(GB2, (uint)b2j, d);
    [loop]
    for (int b2i = 0; b2i < H1; b2i++) {
      atomicAddF(GW2, (uint)(b2j * H1 + b2i), d * a1[b2i]);
      delta1[b2i] += d * W2[b2j * H1 + b2i];
    }
  }
  [loop]
  for (int r1 = 0; r1 < H1; r1++) delta1[r1] *= (z1[r1] > 0.0) ? 1.0 : 0.0;

  // ---- BACKPROP layer 1: dW1, dB1 ----
  [loop]
  for (int b1j = 0; b1j < H1; b1j++) {
    float d = delta1[b1j];
    atomicAddF(GB1, (uint)b1j, d);
    [loop]
    for (int b1i = 0; b1i < INPUT; b1i++) {
      atomicAddF(GW1, (uint)(b1j * INPUT + b1i), d * feat[b1i]);
    }
  }
}
`;

// ── ADAM kernel (generic, one parameter buffer per dispatch) ────────────────────
// Gradients were mean-normalized by the batch inside TRAIN (invN). For each
// parameter:  m = b1·m + (1-b1)·g ;  s = b2·s + (1-b2)·g² ;
//             W -= lr · (m/uBc1) / (sqrt(s/uBc2) + eps).
// uBc1 = 1-b1^t and uBc2 = 1-b2^t are the bias-correction terms (CPU-computed).
// Adam's per-parameter adaptive step blows past the momentum-SGD plateau, so the
// reconstruction becomes genuinely sharp. Reads grads as uint (two's-complement).
const ADAM_CS = `
${NET_DECLS}
RWStructuredBuffer<float> P : register(u0);   // parameter (weight or bias)
RWStructuredBuffer<float> M : register(u1);   // 1st moment
RWStructuredBuffer<float> S : register(u2);   // 2nd moment
StructuredBuffer<uint> G : register(t0);      // fixed-point gradient accumulator
[numthreads(256,1,1)]
void main(uint3 id : SV_DispatchThreadID) {
  uint i = id.x;
  if (i >= uCount) return;
  float g = float((int)G[i]) / uGradScale;
  float m = uB1 * M[i] + (1.0 - uB1) * g;
  float s = uB2 * S[i] + (1.0 - uB2) * g * g;
  M[i] = m; S[i] = s;
  float mh = m / uBc1;
  float sh = s / uBc2;
  P[i] -= uLr * mh / (sqrt(sh) + uEps);
}
`;

// ── Vertex: full-screen triangle ───────────────────────────────────────────────
const VS = `
struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
VSOut main(uint vid : SV_VertexID) {
  VSOut o;
  float2 p = float2((vid << 1) & 2, vid & 2);
  o.uv = p;
  o.pos = float4(p * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
  return o;
}
`;

const GRADE = `
float3 grade(float3 c) {
  c = saturate(c);
  c = pow(c, 1.0 / 1.05); // gentle lift
  return c;
}
`;

// ── PASS 1 PS: evaluate the LIVE net per-pixel into an offscreen HDR texture ────
// Full-resolution per-pixel forward pass over the current weights (no upsampling).
const PS_NET = `
${NET_DECLS}
${FOURIER}
${FORWARD_SRV}
${GRADE}
float4 main(float4 fragPos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
  return float4(grade(netForward(uv)), 1.0);
}
`;

// ── PASS 2 PS: composite TARGET (left) | net prediction (right) to the screen ──
// The right half samples the net texture through a tiny separable low-pass (a 3×3
// tent in UV) so the residual per-pixel net noise is smoothed into a CRISP image —
// the smooth scene and the soft-edged sun disc are far below this cutoff and stay
// sharp. The left half is the analytic target. Same world UV on both sides, so at
// convergence the seam nearly vanishes and the frame reads as one continuous image.
const PS_COMPOSITE = `
${NET_DECLS}
${FOURIER}
${TARGET_IMG}
${GRADE}
Texture2D NetTex : register(t0);
SamplerState Samp : register(s0);
StructuredBuffer<float> LossPlot : register(t1); // normalized 0..1 curve heights

float3 sampleNet(float2 uv) {
  float2 px = float2(1.0 / float(uWidth), 1.0 / float(uHeight));
  // Gentle 3×3 tent (~1px) — Adam fits the net tightly with 8 Fourier bands, so the
  // richer scene (cloud ribbons, ridge + hill edges, sun rim, glitter) needs only a
  // whisper of low-pass to clean the last per-pixel fit noise while staying CRISP.
  float3 sum = 0.0.xxx;
  float wsum = 0.0;
  [unroll] for (int j = -1; j <= 1; j++) {
    [unroll] for (int i = -1; i <= 1; i++) {
      float2 off = float2(float(i), float(j)) * px;
      float w = exp(-(float(i * i + j * j)) / 1.6);
      sum += NetTex.Sample(Samp, uv + off).rgb * w;
      wsum += w;
    }
  }
  return sum / wsum;
}

// ── Tiny 5×7 bitmap font baked into the frame so labels + the HUD survive capture ──
// Each row is a 5-bit mask, MSB = leftmost column. Codes:
//   0=T 1=A 2=R 3=G 4=E 5=N 6=U 7=L 8=space 9=S 10=P 11=M 12=O 13=. 14=- 15..24=0..9
//   25=e 26=:  Returns lit bits for pixel (cx,cy) in [0..4]×[0..6].
float glyphRow(int code, int row) {
  if (code == 0)  { int r[7]={31, 4, 4, 4, 4, 4, 4}; return r[row]; }     // T
  if (code == 1)  { int r[7]={14,17,17,31,17,17,17}; return r[row]; }     // A
  if (code == 2)  { int r[7]={30,17,17,30,20,18,17}; return r[row]; }     // R
  if (code == 3)  { int r[7]={14,17,16,23,17,17,14}; return r[row]; }     // G
  if (code == 4)  { int r[7]={31,16,16,30,16,16,31}; return r[row]; }     // E
  if (code == 5)  { int r[7]={17,25,21,19,17,17,17}; return r[row]; }     // N
  if (code == 6)  { int r[7]={17,17,17,17,17,17,14}; return r[row]; }     // U
  if (code == 7)  { int r[7]={16,16,16,16,16,16,31}; return r[row]; }     // L
  if (code == 9)  { int r[7]={15,16,16,14, 1, 1,30}; return r[row]; }     // S
  if (code == 10) { int r[7]={30,17,17,30,16,16,16}; return r[row]; }     // P
  if (code == 11) { int r[7]={17,27,21,17,17,17,17}; return r[row]; }     // M
  if (code == 12) { int r[7]={14,17,17,17,17,17,14}; return r[row]; }     // O
  if (code == 13) { int r[7]={ 0, 0, 0, 0, 0, 0, 4}; return r[row]; }     // .
  if (code == 14) { int r[7]={ 0, 0, 0,31, 0, 0, 0}; return r[row]; }     // -
  if (code == 15) { int r[7]={14,17,19,21,25,17,14}; return r[row]; }     // 0
  if (code == 16) { int r[7]={ 4,12, 4, 4, 4, 4,14}; return r[row]; }     // 1
  if (code == 17) { int r[7]={14,17, 1, 2, 4, 8,31}; return r[row]; }     // 2
  if (code == 18) { int r[7]={31, 2, 4, 2, 1,17,14}; return r[row]; }     // 3
  if (code == 19) { int r[7]={ 2, 6,10,18,31, 2, 2}; return r[row]; }     // 4
  if (code == 20) { int r[7]={31,16,30, 1, 1,17,14}; return r[row]; }     // 5
  if (code == 21) { int r[7]={ 6, 8,16,30,17,17,14}; return r[row]; }     // 6
  if (code == 22) { int r[7]={31, 1, 2, 4, 8, 8, 8}; return r[row]; }     // 7
  if (code == 23) { int r[7]={14,17,17,14,17,17,14}; return r[row]; }     // 8
  if (code == 24) { int r[7]={14,17,17,15, 1, 2,12}; return r[row]; }     // 9
  if (code == 25) { int r[7]={ 0, 0,14,17,31,16,14}; return r[row]; }     // e
  if (code == 26) { int r[7]={ 0, 4, 0, 0, 0, 4, 0}; return r[row]; }     // :
  return 0;                                                              // space
}
float glyphPix(int code, int cx, int cy) {
  if (cx < 0 || cx > 4 || cy < 0 || cy > 6) return 0.0;
  int rowBits = (int)glyphRow(code, cy);
  return ((rowBits >> (4 - cx)) & 1) ? 1.0 : 0.0;
}
// Draw a string (codes[] up to len) starting at pixel origin org, glyph scale s.
float drawText(float2 frag, float2 org, float s, int codes[12], int len) {
  float2 local = (frag - org) / s;
  int gi = (int)floor(local.x / 6.0);        // 5px glyph + 1px gap
  if (gi < 0 || gi >= len) return 0.0;
  int cx = (int)floor(local.x - float(gi) * 6.0);
  int cy = (int)floor(local.y);
  return glyphPix(codes[gi], cx, cy);
}
// Single glyph at a pixel origin (for digit-by-digit numbers).
float drawGlyph(float2 frag, float2 org, float s, int code) {
  float2 local = (frag - org) / s;
  int cx = (int)floor(local.x);
  int cy = (int)floor(local.y);
  if (cx < 0 || cx > 4) return 0.0;
  return glyphPix(code, cx, cy);
}

// Read the loss-curve height (0=worst at top, 1=best at bottom of the curve area)
// at a normalized x in [0,1] with linear interpolation between stored samples.
float lossCurveAt(float fx) {
  int n = (int)uPlotCount;
  if (n < 2) return 0.0;
  float s = saturate(fx) * float(n - 1);
  int i0 = (int)floor(s);
  int i1 = min(i0 + 1, n - 1);
  float f = s - float(i0);
  return lerp(LossPlot[i0], LossPlot[i1], f);
}

float4 main(float4 fragPos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
  float sx = uv.x;
  float split = uSplit;
  float3 tgt = grade(target(uv));   // analytic ground truth (left)
  float3 net = sampleNet(uv);       // smoothed network prediction (right)
  float3 col = (sx < split) ? tgt : net;

  float px = 1.0 / float(uWidth);
  float2 frag = uv * float2(float(uWidth), float(uHeight));

  // ── Seam: thin crisp line + faint halo + a soft 'scanning' pulse riding it ──
  float dl = abs(sx - split);
  float seam = smoothstep(1.6 * px, 0.0, dl) * 0.75;
  float glow = smoothstep(14.0 * px, 0.0, dl) * 0.12;
  // a vertical scan band that sweeps up/down the seam (showmanship, subtle)
  float scan = exp(-pow((uv.y - uScanY) * 6.0, 2.0));
  col = lerp(col, float3(0.85, 0.97, 1.0), seam);
  col += float3(0.18, 0.40, 0.62) * glow;
  col += float3(0.35, 0.62, 0.95) * smoothstep(34.0 * px, 0.0, dl) * scan * 0.18;

  // gentle vignette to frame the picture
  float2 q = uv;
  float vig = pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.10);
  col *= lerp(0.88, 1.03, vig);

  float sc = max(2.0, floor(float(uHeight) / 150.0)); // glyph pixel scale
  float lw = 6.0 * sc;                                // per-glyph advance in px

  // ── TARGET / NEURAL NET half-labels, baked into the frame on translucent pills ──
  float by = float(uHeight) - 16.0 - 7.0 * sc;
  int L_TARGET[12] = {0,1,2,3,4,0, 8,8,8,8,8,8};      // TARGET
  int L_NEURAL[12] = {5,4,6,2,1,7, 8,5,4,0,8,8};      // NEURAL NET
  float2 oL = float2(float(uWidth) * 0.25 - 3.0 * lw, by);
  float tL = drawText(frag, oL, sc, L_TARGET, 6);
  float2 oR = float2(float(uWidth) * 0.75 - 5.0 * lw, by);
  float tR = drawText(frag, oR, sc, L_NEURAL, 10);
  float padX = 1.5 * lw, padY = 1.2 * sc;
  float pillL = (frag.x > oL.x - padX && frag.x < oL.x + 6.0 * lw + padX &&
                 frag.y > oL.y - padY && frag.y < oL.y + 7.0 * sc + padY) ? 1.0 : 0.0;
  float pillR = (frag.x > oR.x - padX && frag.x < oR.x + 10.0 * lw + padX &&
                 frag.y > oR.y - padY && frag.y < oR.y + 7.0 * sc + padY) ? 1.0 : 0.0;
  col = lerp(col, float3(0.02, 0.03, 0.06), (pillL + pillR) * 0.55);
  col = lerp(col, float3(0.97, 0.99, 1.0), saturate(tL + tR));

  // ── LIVE LOSS-CURVE HUD panel (top-left), baked in so it survives capture ──────
  // A glassy dark panel with a faint grid, the falling log-MSE curve glowing cyan,
  // a title, the step count, and the current MSE. Everything is procedural HLSL.
  float fsc = max(2.0, floor(float(uHeight) / 220.0));  // HUD glyph scale
  float gA = 6.0 * fsc;                                 // glyph advance (px)
  float panelX = 20.0, panelY = 16.0;
  float panelW = max(320.0, float(uWidth) * 0.30);
  float panelH = max(150.0, float(uHeight) * 0.27);
  float2 pmn = float2(panelX, panelY);
  float2 pmx = float2(panelX + panelW, panelY + panelH);
  bool inPanel = frag.x > pmn.x && frag.x < pmx.x && frag.y > pmn.y && frag.y < pmx.y;
  if (inPanel) {
    // glassy dark panel: graded fill + soft top sheen + bright cyan border
    float2 rel = (frag - pmn) / (pmx - pmn);
    float edge = min(min(rel.x, 1.0 - rel.x), min(rel.y, 1.0 - rel.y));
    float border = smoothstep(0.010, 0.0, edge);
    float3 glass = lerp(float3(0.04, 0.06, 0.11), float3(0.02, 0.03, 0.06), rel.y);
    glass += float3(0.05, 0.09, 0.13) * smoothstep(0.10, 0.0, rel.y); // top sheen
    col = lerp(col, glass, 0.88);
    col = lerp(col, float3(0.35, 0.72, 0.95), border * 0.85);

    float headerH = 11.0 * fsc;
    float footerH = 11.0 * fsc;
    // plot region between header and footer
    float plotT = panelY + headerH;
    float plotB = panelY + panelH - footerH;
    float plotL = panelX + 10.0;
    float plotR = panelX + panelW - 10.0;
    bool inPlot = frag.x > plotL && frag.x < plotR && frag.y > plotT && frag.y < plotB;
    if (inPlot) {
      float gx = (frag.x - plotL) / (plotR - plotL);  // 0..1 across time (left=start)
      float gy = (frag.y - plotT) / (plotB - plotT);  // 0 top .. 1 bottom
      // faint grid (5 cols x 4 rows)
      float grid = 0.0;
      grid += smoothstep(0.010, 0.0, abs(frac(gx * 5.0)));
      grid += smoothstep(0.014, 0.0, abs(frac(gy * 4.0)));
      col += float3(0.10, 0.20, 0.28) * saturate(grid) * 0.45;
      // curve: h=1 best(low) -> bottom; h=0 worst(high) -> top. Falls L->R.
      float h = lossCurveAt(gx);
      float curveY = h;
      float dCurve = abs(gy - curveY);
      float curveLine = smoothstep(0.045, 0.0, dCurve);
      float core = smoothstep(0.016, 0.0, dCurve);
      float fill = smoothstep(0.0, 0.02, gy - curveY) * 0.16;   // soft area fill
      col = lerp(col, float3(0.08, 0.50, 0.70), fill);
      col += float3(0.20, 0.85, 1.00) * curveLine * 0.55;
      col += float3(0.80, 0.99, 1.00) * core;
      // glowing 'head' dot at the newest sample (right edge of the plot)
      float headY = lossCurveAt(1.0);
      float head = smoothstep(0.06, 0.0, length(float2((gx - 1.0) * 1.6, gy - headY)));
      col += float3(1.00, 0.96, 0.74) * head;
    }

    // ── HEADER: "LOSS" title (left) and "MSE m.me-x" (right) ──
    float hy = panelY + 2.5 * fsc;
    int T_LOSS[12] = {7,12,9,9, 8,8,8,8,8,8,8,8};      // LOSS
    col = lerp(col, float3(0.72, 0.96, 1.00), saturate(drawText(frag, float2(panelX + 10.0, hy), fsc, T_LOSS, 4)));

    // current MSE as  "MSE m.me-x"  right-aligned in the header
    float lossV = max(uCurLoss, 1e-12);
    float e10 = floor(log10(lossV));
    float mant = lossV / pow(10.0, e10);   // 1..10
    int m0 = (int)floor(mant);
    int m1 = (int)floor(frac(mant) * 10.0);
    int expA = (int)abs(e10);
    int e0 = expA / 10;
    int e1 = expA % 10;
    int eDigits = (e0 > 0) ? 2 : 1;        // exponent width
    // total glyphs: M S E sp m . m e - [e0] e1  => 9 + eDigits
    float mseW = float(9 + eDigits) * gA;
    float mseX = plotR - mseW;
    int T_MSE[12] = {11,9,4,8, 8,8,8,8,8,8,8,8};       // "MSE "
    col = lerp(col, float3(0.82, 1.00, 0.86), saturate(drawText(frag, float2(mseX, hy), fsc, T_MSE, 4)));
    float mvX = mseX + 4.0 * gA;
    float mse = 0.0;
    mse += drawGlyph(frag, float2(mvX + 0.0 * gA, hy), fsc, 15 + m0); // m0
    mse += drawGlyph(frag, float2(mvX + 1.0 * gA, hy), fsc, 13);      // .
    mse += drawGlyph(frag, float2(mvX + 2.0 * gA, hy), fsc, 15 + m1); // m1
    mse += drawGlyph(frag, float2(mvX + 3.0 * gA, hy), fsc, 25);      // e
    mse += drawGlyph(frag, float2(mvX + 4.0 * gA, hy), fsc, 14);      // -
    if (e0 > 0) mse += drawGlyph(frag, float2(mvX + 5.0 * gA, hy), fsc, 15 + e0);
    mse += drawGlyph(frag, float2(mvX + (e0 > 0 ? 6.0 : 5.0) * gA, hy), fsc, 15 + e1);
    col = lerp(col, float3(0.86, 1.00, 0.90), saturate(mse));

    // ── FOOTER: "STEP nnnnn" ──
    float by = panelY + panelH - 8.5 * fsc;
    int T_STEP[12] = {9,0,4,10,8, 8,8,8,8,8,8,8};      // "STEP "
    col = lerp(col, float3(0.86, 0.94, 1.00), saturate(drawText(frag, float2(panelX + 10.0, by), fsc, T_STEP, 5)));
    float numX = panelX + 10.0 + 5.0 * gA;
    uint sv = uTotalSteps;
    int digits[6];
    [unroll] for (int di = 0; di < 6; di++) { digits[di] = (int)(sv % 10u); sv /= 10u; }
    uint tmp = uTotalSteps; int nd = 1;
    [unroll] for (int dc = 0; dc < 5; dc++) { tmp /= 10u; if (tmp > 0u) nd++; }
    float stepNum = 0.0;
    [unroll] for (int dr = 0; dr < 6; dr++) {
      if (dr < nd) stepNum += drawGlyph(frag, float2(numX + float(dr) * gA, by), fsc, 15 + digits[nd - 1 - dr]);
    }
    col = lerp(col, float3(1.00, 0.98, 0.82), saturate(stepNum));
  }

  return float4(saturate(col), 1.0);
}
`;

// ── Compile + create shaders ────────────────────────────────────────────────────
const zeroCode = compile(ZERO_CS, 'main', 'cs_5_0');
const trainCode = compile(TRAIN_CS, 'main', 'cs_5_0');
const adamCode = compile(ADAM_CS, 'main', 'cs_5_0');
const vsCode = compile(VS, 'main', 'vs_5_0');
const psNetCode = compile(PS_NET, 'main', 'ps_5_0');
const psCompCode = compile(PS_COMPOSITE, 'main', 'ps_5_0');

const zeroCs = makeComputeShader(zeroCode);
const trainCs = makeComputeShader(trainCode);
const adamCs = makeComputeShader(adamCode);
const vs = makeVertexShader(vsCode);
const psNet = makePixelShader(psNetCode);
const psComp = makePixelShader(psCompCode);

// Offscreen HDR texture the live net is rendered into each frame, plus a linear
// clamp sampler for the composite's low-pass. Full client resolution — the net is
// evaluated per pixel, then the composite smooths only the high-frequency residual.
const netTex = makeTexture({ w: clientW, h: clientH, format: DXGI_FORMAT_R16G16B16A16_FLOAT, rtv: true, srv: true });
const linSampler = makeSampler({ filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR, address: D3D11_TEXTURE_ADDRESS_CLAMP });

// ── Per-parameter Adam dispatch descriptors (one per weight/bias buffer) ────────
// Each entry binds P/M/S as UAVs u0..u2 and the grad accumulator as SRV t0, with
// the buffer's element count written into uCount before the dispatch.
interface AdamGroup { uav: Buffer; srv: Buffer; count: number; groups: number; }
function adamGroup(p: { uav?: bigint }, m: { uav?: bigint }, s: { uav?: bigint }, g: { srv?: bigint }, count: number): AdamGroup {
  const uav = Buffer.alloc(8 * 3);
  uav.writeBigUInt64LE(p.uav!, 0);
  uav.writeBigUInt64LE(m.uav!, 8);
  uav.writeBigUInt64LE(s.uav!, 16);
  const srv = Buffer.alloc(8);
  srv.writeBigUInt64LE(g.srv!, 0);
  return { uav, srv, count, groups: Math.ceil(count / 256) };
}
const adamGroups: AdamGroup[] = [
  adamGroup(w1, mw1, sw1, gw1, W1_N),
  adamGroup(w2, mw2, sw2, gw2, W2_N),
  adamGroup(w3, mw3, sw3, gw3, W3_N),
  adamGroup(b1, mb1, sb1, gb1, H1),
  adamGroup(b2, mb2, sb2, gb2, H2),
  adamGroup(b3, mb3, sb3, gb3, OUT),
];

// ── Helpers to unbind compute resources between passes (avoid hazards) ─────────
const nullArr8 = Buffer.alloc(8 * 8); // up to 8 null slots
function clearCsUavs(count: number): void {
  vcall(gpu.context, CTX_CS_SET_UNORDERED_ACCESS_VIEWS, [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], [0, count, nullArr8.ptr!, null], FFIType.void);
}
function clearCsSrvs(count: number): void {
  vcall(gpu.context, CTX_CS_SET_SHADER_RESOURCES, [FFIType.u32, FFIType.u32, FFIType.ptr], [0, count, nullArr8.ptr!], FFIType.void);
}

// ── GDI HUD fonts ─────────────────────────────────────────────────────────────
const hudFont = GDI32.CreateFontW(-19, 0, 0, 0, 600, 0, 0, 0, 0, 0, 0, 4 /* ANTIALIASED_QUALITY */, 0, encodeWide('Consolas').ptr!);
const TRANSPARENT_BK = 1;

// A small ring of recent MSE for the GDI sparkline (newest last) and the FULL descent
// history that the in-frame loss-curve panel resamples to LOSS_PLOT_N points.
const lossHist: number[] = [];
const fullHist: number[] = [];
const SPARK = ' .:-=+*#%@'; // low→high glyph ramp (drawn inverted: low loss = short bar)

/** Draw a string twice (dark shadow + bright fill) for legibility over any background. */
function drawShadowed(dc: bigint, x: number, y: number, str: string, fill: number, shadow = 0x00100800): void {
  const t = encodeWide(str);
  GDI32.SetTextColor(dc, shadow);
  GDI32.TextOutW(dc, x + 1, y + 1, t.ptr!, str.length);
  GDI32.SetTextColor(dc, fill);
  GDI32.TextOutW(dc, x, y, t.ptr!, str.length);
}

function drawHud(stepCount: number, lossVal: number, fps: number): void {
  hud.draw(gpu, clientW, clientH, (dc) => {
    GDI32.SetBkMode(dc, TRANSPARENT_BK);

    // ── top-left: title + live metrics ──
    const prevFont = GDI32.SelectObject(dc, hudFont);
    drawShadowed(dc, 18, 16, `Neural Descent  ·  MLP ${INPUT}-${H1}-${H2}-3  ·  Fourier+Adam on GPU  ·  ${fps} fps  ·  ESC`, 0x00f5e8c8);
    drawShadowed(dc, 18, 42, `step ${stepCount}    MSE ${lossVal.toExponential(3)}`, 0x00b9f5c8);

    // ── falling-loss sparkline (newest at the right) ──
    if (lossHist.length > 0) {
      const lo = Math.min(...lossHist);
      const hi = Math.max(...lossHist);
      const span = Math.max(1e-6, hi - lo);
      let spark = '';
      for (const v of lossHist) {
        const n = (v - lo) / span; // 0 (best) .. 1 (worst)
        spark += SPARK[Math.min(SPARK.length - 1, Math.floor(n * SPARK.length))];
      }
      drawShadowed(dc, 18, 68, `loss |${spark}|  ${hi.toExponential(1)} -> ${lo.toExponential(1)}`, 0x0080e0ff);
    }

    // (TARGET / NEURAL NET half-labels are rendered into the frame itself by the
    // composite shader so they survive the back-buffer capture; no GDI duplicate.)
    GDI32.SelectObject(dc, prevFont);
  });
}

// ── Teardown ──────────────────────────────────────────────────────────────────
let cleaned = false;
function cleanup(code: number): never {
  if (!cleaned) {
    cleaned = true;
    hud.release();
    GDI32.DeleteObject(hudFont);
    for (const sb of [
      w1, b1, w2, b2, w3, b3, gw1, gb1, gw2, gb2, gw3, gb3,
      mw1, mb1, mw2, mb2, mw3, mb3, sw1, sb1, sw2, sb2, sw3, sb3, loss, lossPlot,
    ]) {
      comRelease(sb.srv ?? 0n);
      comRelease(sb.uav ?? 0n);
      comRelease(sb.buffer);
    }
    comRelease(cb);
    comRelease(linSampler);
    comRelease(netTex.srv ?? 0n);
    comRelease(netTex.rtv ?? 0n);
    comRelease(netTex.tex);
    comRelease(psComp);
    comRelease(psNet);
    comRelease(vs);
    comRelease(adamCs);
    comRelease(trainCs);
    comRelease(zeroCs);
    comRelease(gpu.backBufferRTV);
    comRelease(gpu.swapChain);
    comRelease(gpu.context);
    comRelease(gpu.device);
    win.destroy();
  }
  process.exit(code);
}
process.on('SIGINT', () => cleanup(0));
process.on('uncaughtException', (err) => {
  console.error(err);
  cleanup(1);
});

console.log('Neural Descent — a GPU neural network training itself live in pure TypeScript.');
console.log(`  ${clientW}x${clientH} · ${gpu.driver} · ${gpu.gpuName}`);
console.log(`  MLP ${INPUT}→${H1}→${H2}→3 · Fourier features · Adam · batch ${BATCH} · ${STEPS_PER_FRAME} steps/frame · lr ${LR}`);

// ── Training/render loop ──────────────────────────────────────────────────────
const start = performance.now();
const durationMs = process.env.DEMO_DURATION_MS ? Number(process.env.DEMO_DURATION_MS) : 0;
let frame = 0;
let totalSteps = 0;
let fps = 0;
let fpsFrames = 0;
let fpsWindow = start;
let lastLoss = 1;
let smoothLoss = 0; // EMA of the per-batch loss for a stable headline MSE
let nextCheckpoint = 0;

const zeroGroups = Math.ceil(Math.max(W1_N, W2_N) / 256);
const trainGroups = Math.ceil(BATCH / 64);

// Bind arrays for the TRAIN pass (built once; UAVs/SRVs are stable handles).
const trainSrvArr = Buffer.alloc(8 * 6);
[w1.srv!, b1.srv!, w2.srv!, b2.srv!, w3.srv!, b3.srv!].forEach((s, i) => trainSrvArr.writeBigUInt64LE(s, i * 8));
const trainUavArr = Buffer.alloc(8 * 7);
[gw1.uav!, gb1.uav!, gw2.uav!, gb2.uav!, gw3.uav!, gb3.uav!, loss.uav!].forEach((u, i) => trainUavArr.writeBigUInt64LE(u, i * 8));
const zeroUavArr = Buffer.alloc(8 * 7);
[gw1.uav!, gb1.uav!, gw2.uav!, gb2.uav!, gw3.uav!, gb3.uav!, loss.uav!].forEach((u, i) => zeroUavArr.writeBigUInt64LE(u, i * 8));

function bindCb(): void {
  const arr = Buffer.alloc(8);
  arr.writeBigUInt64LE(cb, 0);
  vcall(gpu.context, 71 /* CSSetConstantBuffers */, [FFIType.u32, FFIType.u32, FFIType.ptr], [0, 1, arr.ptr!], FFIType.void);
}

while (!win.shouldClose()) {
  win.pump();
  if (win.shouldClose()) break;

  const now = performance.now();
  const time = (now - start) / 1000;

  // Run several training steps before painting (makes convergence visibly fast).
  for (let s = 0; s < STEPS_PER_FRAME; s += 1) {
    // Learning-rate schedule: hold high early for a fast plunge, then cosine-decay
    // toward a small floor so the late iterations stop jittering and the predicted
    // half settles into a SMOOTH, crisp reconstruction (kills residual speckle).
    // Cosine LR decay to a small floor — Adam + decay lands at a tight final fit.
    const decayT = Math.min(1, totalSteps / DECAY_STEPS);
    const lrNow = LR * (0.05 + 0.95 * 0.5 * (1 + Math.cos(Math.PI * decayT)));
    // Adam bias-correction terms for this step (t = totalSteps + 1).
    const t = totalSteps + 1;
    const bc1 = 1 - Math.pow(ADAM_B1, t);
    const bc2 = 1 - Math.pow(ADAM_B2, t);
    // Constant buffer (rebuilt right before the passes that consume it).
    cbData.writeUInt32LE(clientW, 0);
    cbData.writeUInt32LE(clientH, 4);
    cbData.writeUInt32LE((frame * STEPS_PER_FRAME + s) >>> 0, 8); // frame/step seed
    cbData.writeUInt32LE(BATCH, 12);
    cbData.writeUInt32LE(totalSteps >>> 0, 16);
    cbData.writeUInt32LE(0, 20); // uCount — set per Adam dispatch below
    cbData.writeFloatLE(bc1, 24); // uBc1
    cbData.writeFloatLE(bc2, 28); // uBc2
    cbData.writeFloatLE(lrNow, 32);
    cbData.writeFloatLE(GRAD_SCALE, 36);
    cbData.writeFloatLE(0.5, 40); // split (unused by compute)
    cbData.writeFloatLE(time, 44);
    cbData.writeFloatLE(ADAM_B1, 48);
    cbData.writeFloatLE(ADAM_B2, 52);
    cbData.writeFloatLE(ADAM_EPS, 56);
    cbData.writeFloatLE(0, 60);
    updateConstantBuffer(cb, cbData);

    // Pass A: zero gradients + loss.
    vcall(gpu.context, 69 /* CSSetShader */, [FFIType.u64, FFIType.ptr, FFIType.u32], [zeroCs, null, 0], FFIType.void);
    bindCb();
    vcall(gpu.context, CTX_CS_SET_UNORDERED_ACCESS_VIEWS, [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], [0, 7, zeroUavArr.ptr!, null], FFIType.void);
    dispatch(zeroGroups, 1, 1);
    clearCsUavs(7);

    // Pass B: forward + backprop, accumulate gradients (SRV weights -> UAV grads).
    vcall(gpu.context, 69, [FFIType.u64, FFIType.ptr, FFIType.u32], [trainCs, null, 0], FFIType.void);
    bindCb();
    vcall(gpu.context, CTX_CS_SET_SHADER_RESOURCES, [FFIType.u32, FFIType.u32, FFIType.ptr], [0, 6, trainSrvArr.ptr!], FFIType.void);
    vcall(gpu.context, CTX_CS_SET_UNORDERED_ACCESS_VIEWS, [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], [0, 7, trainUavArr.ptr!, null], FFIType.void);
    dispatch(trainGroups, 1, 1);
    clearCsUavs(7);
    clearCsSrvs(6);

    // Pass C: ADAM update — one elementwise dispatch per parameter buffer (P/M/S
    // UAVs + grad SRV). uCount selects how many elements this buffer has.
    vcall(gpu.context, 69, [FFIType.u64, FFIType.ptr, FFIType.u32], [adamCs, null, 0], FFIType.void);
    for (const ag of adamGroups) {
      cbData.writeUInt32LE(ag.count, 20); // uCount
      updateConstantBuffer(cb, cbData);
      bindCb();
      vcall(gpu.context, CTX_CS_SET_SHADER_RESOURCES, [FFIType.u32, FFIType.u32, FFIType.ptr], [0, 1, ag.srv.ptr!], FFIType.void);
      vcall(gpu.context, CTX_CS_SET_UNORDERED_ACCESS_VIEWS, [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], [0, 3, ag.uav.ptr!, null], FFIType.void);
      dispatch(ag.groups, 1, 1);
      clearCsUavs(3);
      clearCsSrvs(1);
    }

    totalSteps += 1;
  }

  // Read back the loss from the LAST step (cheap: 4 bytes); throttled so the GPU
  // spends its time training rather than stalling on a CPU readback every frame.
  if (frame % 3 === 0) {
    const lb = readbackBuffer(loss.buffer, 4);
    const lq = new Uint32Array(lb)[0]!;
    lastLoss = lq / 1000000 / BATCH; // sum of (mse*1e6) over batch -> mean mse
    // The per-batch loss is noisy; an EMA gives a stable headline MSE for the HUD
    // while the curve plots the smoothed trend (reads cleaner + more honest).
    smoothLoss = smoothLoss <= 0 ? lastLoss : smoothLoss * 0.8 + lastLoss * 0.2;
    lossHist.push(smoothLoss);
    if (lossHist.length > 8) lossHist.shift(); // small ring for the GDI sparkline
    fullHist.push(smoothLoss);                 // full descent for the in-frame curve
  }
  // Convergence checkpoints printed to the console (proves the loss falls).
  if (totalSteps >= nextCheckpoint) {
    console.log(`  [train] step ${totalSteps} · MSE ${lastLoss.toExponential(3)} · ${((now - start) / 1000).toFixed(2)}s`);
    nextCheckpoint += 1500;
  }

  // ── Render: TARGET (left) | NEURAL NET prediction (right) ─────────────────────
  // The seam holds at the exact center 0.5 so the two halves form one continuous
  // picture as the net converges. A brief 0.6s reveal slides the seam in from the
  // right at the very start (pure showmanship); it locks to 0.5 well before capture.
  const reveal = Math.min(1, time / 0.6); // 0→1 over the first 0.6s
  const sweep = 1.0 * (1 - reveal) + 0.5 * reveal; // 1.0 (all target) -> 0.5 (split)

  // ── Build the in-frame loss curve: resample the full descent to LOSS_PLOT_N points
  // and normalize in LOG space (loss spans orders of magnitude) to 0..1 — 1=lowest
  // (best). The composite PS plots this with 1.0 mapped to the bottom of the panel.
  let plotCount = 0;
  if (fullHist.length >= 2) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of fullHist) {
      const lg = Math.log10(Math.max(v, 1e-12));
      if (lg < lo) lo = lg;
      if (lg > hi) hi = lg;
    }
    const span = Math.max(1e-6, hi - lo);
    plotCount = LOSS_PLOT_N;
    for (let i = 0; i < LOSS_PLOT_N; i += 1) {
      const fx = i / (LOSS_PLOT_N - 1);
      const src = fx * (fullHist.length - 1);
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, fullHist.length - 1);
      const f = src - i0;
      const v = fullHist[i0]! * (1 - f) + fullHist[i1]! * f;
      const lg = Math.log10(Math.max(v, 1e-12));
      // 0 (worst, high loss) .. 1 (best, low loss)
      const h = 1 - (lg - lo) / span;
      lossPlotData.writeFloatLE(h, i * 4);
    }
    updateDynamicBuffer(lossPlot.buffer, lossPlotData);
  }
  // Seam scan position: a slow up/down sweep for the 'scanning' glow on the seam.
  const scanY = 0.5 - 0.5 * Math.cos(time * 1.6);

  cbData.writeUInt32LE(clientW, 0);
  cbData.writeUInt32LE(clientH, 4);
  cbData.writeUInt32LE(frame >>> 0, 8);
  cbData.writeUInt32LE(BATCH, 12);
  cbData.writeUInt32LE(totalSteps >>> 0, 16);
  cbData.writeUInt32LE(0, 20);
  cbData.writeUInt32LE(0, 24);
  cbData.writeUInt32LE(0, 28);
  cbData.writeFloatLE(LR, 32);
  cbData.writeFloatLE(GRAD_SCALE, 36);
  cbData.writeFloatLE(sweep, 40);
  cbData.writeFloatLE(time, 44);
  cbData.writeFloatLE(ADAM_B1, 48);
  cbData.writeFloatLE(ADAM_B2, 52);
  cbData.writeFloatLE(ADAM_EPS, 56);
  cbData.writeFloatLE(0, 60);
  cbData.writeFloatLE(plotCount, 64);   // uPlotCount
  cbData.writeFloatLE(0, 68);           // uPlotLogLo (unused; normalization on CPU)
  cbData.writeFloatLE(0, 72);           // uPlotLogHi
  cbData.writeFloatLE(scanY, 76);       // uScanY
  cbData.writeFloatLE(smoothLoss > 0 ? smoothLoss : lastLoss, 80); // uCurLoss (EMA)
  cbData.writeFloatLE(0, 84);           // uFinalReady
  cbData.writeFloatLE(0, 88);
  cbData.writeFloatLE(0, 92);
  updateConstantBuffer(cb, cbData);

  setViewport(clientW, clientH);
  vsSet(vs);

  // ── Pass 1: render the LIVE net per-pixel into the offscreen HDR texture ──
  setRenderTargets([netTex.rtv!]);
  psSet(psNet, { cb: [cb], srv: [w1.srv!, b1.srv!, w2.srv!, b2.srv!, w3.srv!, b3.srv!] });
  drawFullscreenTriangle();
  // Unbind PS SRVs so the weight buffers can be UAVs next frame, and drop the RTV
  // so the texture can be read as an SRV in pass 2.
  vcall(gpu.context, 8 /* PSSetShaderResources */, [FFIType.u32, FFIType.u32, FFIType.ptr], [0, 6, nullArr8.ptr!], FFIType.void);
  setRenderTargets([]);

  // ── Pass 2: composite TARGET (left) | smoothed net texture (right) to screen ──
  setRenderTargets([gpu.backBufferRTV]);
  clear(gpu.backBufferRTV, [0.02, 0.02, 0.05, 1]);
  psSet(psComp, { cb: [cb], srv: [netTex.srv!, lossPlot.srv!], samp: [linSampler] });
  drawFullscreenTriangle();
  // Unbind the net texture + loss-plot SRVs so the texture can be an RTV again.
  vcall(gpu.context, 8 /* PSSetShaderResources */, [FFIType.u32, FFIType.u32, FFIType.ptr], [0, 2, nullArr8.ptr!], FFIType.void);
  setRenderTargets([]);

  // HUD composited into the back buffer BEFORE present so it never flickers (and
  // so it survives the back-buffer gallery capture below alongside the in-frame
  // baked loss panel rendered by the composite shader).
  const willBreak = durationMs > 0 && now - start >= durationMs;
  drawHud(totalSteps, lastLoss, fps);

  // Gallery capture on the final frame (capture mode only) — after the HUD is
  // composited into the back buffer, before present.
  if (willBreak) {
    const shotDir = resolve(import.meta.dir, '..', 'screenshots');
    mkdirSync(shotDir, { recursive: true });
    const stats = captureBackBuffer(gpu, resolve(shotDir, 'neural-descent.png'), { gridW: 48, gridH: 22 });
    console.log(formatGrid(stats));
    console.log(`[shot] ok=${stats.ok} nonBlack=${stats.nonBlackFrac.toFixed(3)} meanLuma=${stats.meanLuma.toFixed(3)} -> ${stats.path}`);
    console.log(`[shot] step ${totalSteps} · MSE ${lastLoss.toExponential(3)}`);
  }

  gpu.present(false);

  frame += 1;
  fpsFrames += 1;
  if (now - fpsWindow >= 500) {
    fps = Math.round((fpsFrames * 1000) / (now - fpsWindow));
    fpsFrames = 0;
    fpsWindow = now;
  }

  if (willBreak) break;
}

console.log(`  ran ${frame} frames · ${totalSteps} training steps · final MSE ${lastLoss.toExponential(3)} · ${fps} fps · ${gpu.gpuName}.`);
cleanup(0);
