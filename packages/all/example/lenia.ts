/**
 * Lenia — continuous cellular automata, alive on your GPU, in pure TypeScript.
 *
 * Bert Chan's Lenia is a smooth generalization of Conway's Game of Life: instead
 * of a binary grid stepped by counting 8 neighbours, a CONTINUOUS float field in
 * [0,1] is convolved each step with a smooth radial "bump" kernel (a Gaussian ring),
 * and the neighbourhood sum U is run through a Gaussian GROWTH mapping
 * G(U) = 2·exp(-(U-mu)^2 / (2·sigma^2)) - 1, added back to the field and clamped.
 * The result is not pixels turning on and off — it is luminous, gliding, breathing
 * micro-organisms ("orbium") that self-organize, crawl, rotate and survive, exactly
 * like the real continuous-CA lifeforms. Nothing is precomputed or faked: the field
 * lives in two ping-ponged R32_FLOAT textures on the real ID3D11Device, every step
 * is an HLSL compute shader that does the full radial convolution + growth update,
 * and a final full-screen pixel pass maps the field through a lush teal → green →
 * gold → white ramp with a soft bloom so the colony glows under a microscope.
 *
 * Distinct from the Gray-Scott reaction-diffusion and Physarum slime demos here:
 * this is true continuous-state CA driven by a convolution KERNEL + growth function,
 * not a two-chemical PDE and not agent trails.
 *
 * Pipeline (per displayed frame, several sub-steps):
 *   1. STEP compute pass [numthreads(16,16,1)] — for each cell, convolve the field
 *      with the smooth Gaussian-ring kernel over a (2R+1)^2 toroidal window (kernel
 *      weights live in a StructuredBuffer SRV), compute the normalized potential U,
 *      apply the Gaussian growth G(U), integrate (field += dt·G), clamp to [0,1],
 *      write the next field UAV.  Ping-pong A↔B.
 *   2. COLORIZE full-screen PS — sample the final field (linear, upsampled to the
 *      monitor), add a small-radius glow, map intensity through the color ramp with
 *      a wet specular sheen + vignette, tonemap + gamma.
 *   A GDI HUD reads "Lenia · continuous CA · <fps> fps · <GPU>".
 *
 * Fills the PRIMARY MONITOR (GetSystemMetrics SM_CXSCREEN/SM_CYSCREEN), borderless.
 * SPACE re-seeds a fresh colony · ESC quits · honors DEMO_DURATION_MS for self-exit.
 *
 * Engine / @bun-win32 APIs (all via ./_gpu.ts, hand-walked D3D11 COM vtables over
 * Bun FFI): createWindow, createDevice, compile, makeComputeShader/makeVertexShader/
 * makePixelShader, makeStructuredBuffer (kernel weights SRV), makeTexture (R32_FLOAT
 * UAV+SRV ping-pong), makeConstantBuffer/updateConstantBuffer, makeSampler, csSet,
 * dispatch, vsSet/psSet, setRenderTargets/setViewport/clear, drawFullscreenTriangle,
 * present, comRelease, vcall — plus User32 GetSystemMetrics and GDI32 CreateFontW/
 * TextOutW for the HUD, and captureBackBuffer for self-verification.
 *
 * Run: bun run packages/all/example/lenia.ts
 */

import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import { FFIType } from 'bun:ffi';

import { GDI32, User32 } from '../index';
import { SystemMetric } from '@bun-win32/user32';
import {
  CTX_CS_SET_SHADER_RESOURCES,
  CTX_CS_SET_UNORDERED_ACCESS_VIEWS,
  CTX_PS_SET_SHADER_RESOURCES,
  D3D11_FILTER_MIN_MAG_MIP_LINEAR,
  D3D11_TEXTURE_ADDRESS_CLAMP,
  DXGI_FORMAT_R32_FLOAT,
  clear,
  comRelease,
  compile,
  createDevice,
  createWindow,
  csSet,
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
  setRenderTargets,
  setViewport,
  updateConstantBuffer,
  vcall,
  vsSet,
  type TextureResult,
} from './_gpu';
import { captureBackBuffer, formatGrid } from './_snapshot';
import * as hud from './_hud';

const encodeWide = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');
const TRANSPARENT_BK = 1;
const VK_SPACE = 0x20;

// Kernel radius (cells). The convolution window is (2R+1)^2 taps. A larger R on a
// smaller sim grid yields BIG, smooth, rounded organisms that fill the screen.
const R = 17;
const STEP_GROUP = 16;

// Lenia parameters tuned for large, rounded, breathing/crawling cells with clear
// dark space between them (the localized "blob" regime, near orbium).
const MU = 0.155; // growth-function centre (target ring potential)
const SIGMA = 0.02; // growth-function width
const DT = 0.12; // integration step per sub-step
const SUBSTEPS = 2; // sim sub-steps per displayed frame

// ── Window sized to the PRIMARY MONITOR (the showcase capture grabs the whole
//    screen, so the demo must fill it). Sim runs at a downscaled grid for a
//    sensible organism scale + real-time convolution; the color pass upsamples.
const SCREEN_W = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN) || 1920;
const SCREEN_H = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN) || 1080;

// Small sim grid (preserving aspect) so each R-scaled organism upsamples to a
// big, luminous microscopic blob on screen; the kernel window stays affordable.
const SIM_H = 176;
const SIM_W = Math.max(1, Math.round((SIM_H * SCREEN_W) / SCREEN_H));

// ── Window + device ────────────────────────────────────────────────────────────
const win = createWindow({ title: 'Lenia — continuous cellular automata', width: SCREEN_W, height: SCREEN_H, borderless: true });
const { w: clientW, h: clientH } = win.clientSize();
const gpu = createDevice(win.hwnd, { width: clientW, height: clientH });

// ─────────────────────────────────────────────────────────────────────────────
// Precompute the smooth radial kernel weights (a Gaussian ring / "bump").
// The classic Lenia kernel is a smooth ring: K(r) = exp(-(r/Rn - kmu)^2 / (2 kw^2))
// for r in (0, R], normalized so the weights sum to 1. We flatten the (2R+1)^2
// window into a StructuredBuffer<float> SRV the compute shader reads.
// ─────────────────────────────────────────────────────────────────────────────
const KW = 2 * R + 1;
const kernel = new Float32Array(KW * KW);
{
  const kmu = 0.5; // ring centre (fraction of R) — single shell
  const kw = 0.18; // ring thickness
  let sum = 0;
  for (let dy = -R; dy <= R; dy += 1) {
    for (let dx = -R; dx <= R; dx += 1) {
      const r = Math.sqrt(dx * dx + dy * dy) / R; // normalized radius 0..~1.4
      let w = 0;
      if (r > 0 && r <= 1) {
        const e = (r - kmu) / kw;
        w = Math.exp(-0.5 * e * e);
      }
      kernel[(dy + R) * KW + (dx + R)] = w;
      sum += w;
    }
  }
  // Normalize so the convolution yields a potential U in [0,1].
  if (sum > 0) for (let i = 0; i < kernel.length; i += 1) kernel[i]! /= sum;
}
const kernelBytes = Buffer.from(kernel.buffer, 0, kernel.byteLength);
const kernelBuf = makeStructuredBuffer({ stride: 4, count: KW * KW, srv: true, initialData: kernelBytes });

// ─────────────────────────────────────────────────────────────────────────────
// HLSL
// ─────────────────────────────────────────────────────────────────────────────
const SIM_CB = `
cbuffer Sim : register(b0) {
  uint  uWidth; uint uHeight; uint uFrame; uint uSeed;
  float uMu; float uSigma; float uDt; float uPad0;
};
`;

// Seed compute pass: scatter smooth random orbium-like PATCHES of value-noise into
// the field. The ring kernel is normalized (sums to 1) so the convolution
// potential U is a local average; to ignite self-organization the seed must put
// down smooth, moderate-density texture whose local ring-averages straddle the
// growth centre mu, rather than solid discs (which over-saturate U → die-off).
const SEED_CS = `
${SIM_CB}
RWTexture2D<float> Field : register(u0);

// Cheap hash (Wang) for reproducible per-seed placement.
uint wang(uint s){ s^=2747636419u; s*=2654435769u; s^=s>>16; s*=2654435769u; s^=s>>16; s*=2654435769u; return s; }
float rnd(uint s){ return float(wang(s)) / 4294967295.0; }
float h2(float2 p){ return frac(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }
float vnoise(float2 p){
  float2 i = floor(p); float2 f = frac(p); f = f*f*(3.0 - 2.0*f);
  float a = h2(i), b = h2(i+float2(1,0)), c = h2(i+float2(0,1)), d = h2(i+float2(1,1));
  return lerp(lerp(a,b,f.x), lerp(c,d,f.x), f.y);
}

[numthreads(${STEP_GROUP},${STEP_GROUP},1)]
void main(uint3 id : SV_DispatchThreadID) {
  if (id.x >= uWidth || id.y >= uHeight) return;
  float2 p = float2(id.xy);
  float v = 0.0;
  float2 sd = float2(rnd(uSeed*7919u + 3u), rnd(uSeed*7919u + 11u)) * 100.0;
  // Scatter a modest number of soft patches filled with fine value-noise, leaving
  // dark space between them so isolated organisms can form and glide.
  [loop]
  for (uint i = 0u; i < 16u; i++) {
    uint b = i * 977u + uSeed * 131071u;
    float cx = rnd(b + 1u) * float(uWidth);
    float cy = rnd(b + 2u) * float(uHeight);
    float rad = float(${R}) * (1.3 + rnd(b + 3u) * 1.6);
    float2 d = p - float2(cx, cy);
    float dist = length(d);
    float falloff = saturate(1.0 - dist / rad);
    // Fine-grained smooth noise inside the patch, density biased so the local
    // ring-average lands a touch above mu — enough to grow, not so much it dies.
    float n = vnoise(p * 0.40 + sd + float2(b & 31u, (b >> 5) & 31u));
    float cell = smoothstep(0.45, 0.78, n) * (0.5 + 0.5 * vnoise(p * 0.8 + sd));
    v = max(v, falloff * falloff * cell);
  }
  Field[id.xy] = saturate(v);
}
`;

// Lenia step: convolve the field with the smooth radial kernel, apply the
// Gaussian growth function, integrate, clamp. Toroidal wrap so organisms glide
// off one edge and back on the other.
const STEP_CS = `
${SIM_CB}
Texture2D<float> Src : register(t0);
StructuredBuffer<float> Kernel : register(t1);
RWTexture2D<float> Dst : register(u0);

static const int RAD = ${R};
static const int KW = ${KW};

[numthreads(${STEP_GROUP},${STEP_GROUP},1)]
void main(uint3 id : SV_DispatchThreadID) {
  if (id.x >= uWidth || id.y >= uHeight) return;
  int2 c = int2(id.xy);
  int W = int(uWidth);
  int H = int(uHeight);

  // Convolution: weighted sum of the toroidal neighbourhood = the "potential" U.
  float U = 0.0;
  [loop]
  for (int ky = -RAD; ky <= RAD; ky++) {
    int sy = c.y + ky; sy = (sy + H) % H;
    int row = (ky + RAD) * KW;
    [loop]
    for (int kx = -RAD; kx <= RAD; kx++) {
      float w = Kernel[row + (kx + RAD)];
      if (w == 0.0) continue;
      int sx = c.x + kx; sx = (sx + W) % W;
      U += w * Src.Load(int3(sx, sy, 0));
    }
  }

  // Gaussian growth mapping centred at mu: G in [-1, 1].
  float g = U - uMu;
  float G = 2.0 * exp(-(g * g) / (2.0 * uSigma * uSigma)) - 1.0;

  // Integrate and clamp to the living range.
  float cur = Src.Load(int3(c, 0));
  float nxt = saturate(cur + uDt * G);
  Dst[c] = nxt;
}
`;

// Full-screen-triangle vertex shader.
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

// Colorize: lush teal → green → gold → white ramp with a soft bloom + sheen,
// upsampled (linear) to the full monitor.
const PS = `
cbuffer C : register(b0) {
  float2 iSimRes;
  float2 iOutRes;
  float  iTime;
  float3 iPad;
};
Texture2D<float> Field : register(t0);
SamplerState Smp : register(s0);

float3 ramp(float t) {
  // Deep teal → emerald → green → gold → white-hot. Organic, luminous.
  t = saturate(t);
  float3 c0 = float3(0.01, 0.04, 0.06);   // near-black abyssal teal
  float3 c1 = float3(0.02, 0.22, 0.28);   // deep teal
  float3 c2 = float3(0.04, 0.48, 0.36);   // emerald
  float3 c3 = float3(0.45, 0.75, 0.20);   // lush green
  float3 c4 = float3(0.98, 0.80, 0.20);   // gold
  float3 c5 = float3(1.00, 0.99, 0.92);   // hot white
  float3 col;
  if (t < 0.16)      col = lerp(c0, c1, t / 0.16);
  else if (t < 0.36) col = lerp(c1, c2, (t - 0.16) / 0.20);
  else if (t < 0.56) col = lerp(c2, c3, (t - 0.36) / 0.20);
  else if (t < 0.80) col = lerp(c3, c4, (t - 0.56) / 0.24); // wide gold band
  else               col = lerp(c4, c5, (t - 0.80) / 0.20);
  return col;
}

// Two-radius ring blur of the field → a smooth glow value that radiates out from
// each luminous organism into the surrounding dark, so the bloom carries colour.
float2 bloom(float2 uv, float2 texel) {
  float near = 0.0, far = 0.0;
  [unroll] for (int i = 0; i < 8; i++) {
    float a = 6.2831853 * float(i) / 8.0;
    float2 dir = float2(cos(a), sin(a));
    near += Field.Sample(Smp, uv + dir * texel * 1.8);
    far  += Field.Sample(Smp, uv + dir * texel * 4.2);
  }
  return float2(near / 8.0, far / 8.0);
}

float4 main(float4 fp : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
  float2 texel = 1.0 / iSimRes;
  float v = Field.Sample(Smp, uv);
  float2 bl = bloom(uv, texel);

  // The orbium shell is a thin bright ridge in v. Map v through the ramp so a
  // cell's cross-section sweeps deep-teal → emerald → green → gold → white from
  // its dark edge to its glowing core.
  float t = saturate(pow(v, 0.8) * 1.3);
  float3 col = ramp(t);

  // Fake-3D membrane sheen: lit by the local field gradient so bodies look wet.
  float dx = Field.Sample(Smp, uv + float2(texel.x, 0)) - Field.Sample(Smp, uv - float2(texel.x, 0));
  float dy = Field.Sample(Smp, uv + float2(0, texel.y)) - Field.Sample(Smp, uv - float2(0, texel.y));
  float3 n = normalize(float3(-dx * 6.0, -dy * 6.0, 1.0));
  float3 L = normalize(float3(0.4, 0.55, 0.8));
  float diff = saturate(dot(n, L));
  float spec = pow(saturate(dot(reflect(-L, n), float3(0,0,1))), 40.0);
  col *= 0.55 + 0.6 * diff;
  col += spec * float3(0.85, 0.95, 1.0) * smoothstep(0.15, 0.5, v);

  // Colored bloom: the near halo glows emerald-green, the far halo a soft teal,
  // radiating from each organism into the dark gaps — gives the whole field depth.
  col += ramp(0.5) * pow(saturate(bl.x), 1.3) * 0.9;
  col += ramp(0.32) * pow(saturate(bl.y), 1.3) * 0.55;

  // Gold-white core flare on the very brightest membrane ridges.
  col += pow(saturate(v - 0.6) / 0.4, 2.5) * float3(1.0, 0.9, 0.62);

  // Inky abyssal background where nothing lives — strong negative space.
  float lit = max(v, max(bl.x, bl.y) * 0.8);
  col = lerp(float3(0.004, 0.012, 0.02), col, smoothstep(0.015, 0.12, lit));

  // Microscope vignette.
  float2 q = fp.xy / iOutRes;
  float vig = pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.20);
  col *= lerp(0.7, 1.07, vig);

  col = col / (col + 0.72);    // Reinhard tonemap
  col = pow(col, 1.0 / 2.2);   // gamma
  return float4(col, 1.0);
}
`;

// ── Compile + create shaders ────────────────────────────────────────────────────
let seedCsCode: ReturnType<typeof compile> | undefined;
let stepCsCode: ReturnType<typeof compile> | undefined;
let vsCode: ReturnType<typeof compile> | undefined;
let psCode: ReturnType<typeof compile> | undefined;
let seedCs = 0n;
let stepCs = 0n;
let vs = 0n;
let ps = 0n;
try {
  seedCsCode = compile(SEED_CS, 'main', 'cs_5_0');
  stepCsCode = compile(STEP_CS, 'main', 'cs_5_0');
  vsCode = compile(VS, 'main', 'vs_5_0');
  psCode = compile(PS, 'main', 'ps_5_0');
  seedCs = makeComputeShader(seedCsCode);
  stepCs = makeComputeShader(stepCsCode);
  vs = makeVertexShader(vsCode);
  ps = makePixelShader(psCode);
} catch (err) {
  console.error(String((err as Error).message));
  process.exit(1);
}

// ── Ping-pong field textures: R32_FLOAT, UAV + SRV ──────────────────────────────
let fieldA: TextureResult = makeTexture({ w: SIM_W, h: SIM_H, format: DXGI_FORMAT_R32_FLOAT, uav: true, srv: true });
let fieldB: TextureResult = makeTexture({ w: SIM_W, h: SIM_H, format: DXGI_FORMAT_R32_FLOAT, uav: true, srv: true });

const sampLinear = makeSampler({ filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR, address: D3D11_TEXTURE_ADDRESS_CLAMP });

// Constant buffers.
const CB_SIM = 32; // 4×u32 + 4×float
const cbSim = makeConstantBuffer(CB_SIM);
const cbSimData = Buffer.alloc(CB_SIM);

const CB_COL = 32; // float2 sim, float2 out, float time, float3 pad
const cbCol = makeConstantBuffer(CB_COL);
const cbColData = Buffer.alloc(CB_COL);

// ── Unbind helpers (avoid UAV/SRV hazards between passes). Long-lived null
//    buffers so a GC pass can never invalidate a .ptr! mid-call. ────────────────
const nullArr1 = Buffer.alloc(8);
const nullArr2 = Buffer.alloc(16);
function clearCsUav(): void {
  vcall(gpu.context, CTX_CS_SET_UNORDERED_ACCESS_VIEWS, [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], [0, 1, nullArr1.ptr!, null], FFIType.void);
}
function clearCsSrv(): void {
  vcall(gpu.context, CTX_CS_SET_SHADER_RESOURCES, [FFIType.u32, FFIType.u32, FFIType.ptr], [0, 2, nullArr2.ptr!], FFIType.void);
}
function clearPsSrv(): void {
  vcall(gpu.context, CTX_PS_SET_SHADER_RESOURCES, [FFIType.u32, FFIType.u32, FFIType.ptr], [0, 1, nullArr1.ptr!], FFIType.void);
}

const groupsX = Math.ceil(SIM_W / STEP_GROUP);
const groupsY = Math.ceil(SIM_H / STEP_GROUP);

// ── Seed a fresh colony into fieldA ──────────────────────────────────────────────
let seedCounter = 1;
function seed(): void {
  cbSimData.writeUInt32LE(SIM_W, 0);
  cbSimData.writeUInt32LE(SIM_H, 4);
  cbSimData.writeUInt32LE(0, 8);
  cbSimData.writeUInt32LE(seedCounter >>> 0, 12);
  cbSimData.writeFloatLE(MU, 16);
  cbSimData.writeFloatLE(SIGMA, 20);
  cbSimData.writeFloatLE(DT, 24);
  cbSimData.writeFloatLE(0, 28);
  updateConstantBuffer(cbSim, cbSimData);
  seedCounter += 1;
  clearCsSrv();
  csSet(seedCs, { cb: [cbSim], uav: [fieldA.uav!] });
  dispatch(groupsX, groupsY, 1);
  clearCsUav();
}
seed();

// ── GDI HUD ───────────────────────────────────────────────────────────────────
const hudFont = GDI32.CreateFontW(-18, 0, 0, 0, 600, 0, 0, 0, 0, 0, 0, 4, 0, encodeWide('Consolas').ptr!);
let fps = 0;
function drawHud(): void {
  hud.draw(gpu, clientW, clientH, (dc) => {
    const prevFont = GDI32.SelectObject(dc, hudFont);
    GDI32.SetBkMode(dc, TRANSPARENT_BK);
    const line = `Lenia · continuous cellular automata · ${fps} fps · ${gpu.gpuName} · SPACE reseed · ESC`;
    const text = encodeWide(line);
    const len = line.length;
    GDI32.SetTextColor(dc, 0x00100400);
    GDI32.TextOutW(dc, 19, 19, text.ptr!, len);
    GDI32.SetTextColor(dc, 0x0090f0c0); // warm teal-green (BGR)
    GDI32.TextOutW(dc, 18, 18, text.ptr!, len);
    GDI32.SelectObject(dc, prevFont);
  });
}

// ── Teardown ──────────────────────────────────────────────────────────────────
let cleaned = false;
function cleanup(code: number): never {
  if (!cleaned) {
    cleaned = true;
    // Unbind every CS/PS resource and the render target so the context holds no
    // dangling references to objects we are about to release.
    csSet(0n, {});
    clearCsUav();
    clearCsSrv();
    clearPsSrv();
    setRenderTargets([]);
    hud.release();
    GDI32.DeleteObject(hudFont);
    comRelease(sampLinear);
    comRelease(cbSim);
    comRelease(cbCol);
    comRelease(kernelBuf.srv ?? 0n);
    comRelease(kernelBuf.buffer);
    for (const f of [fieldA, fieldB]) {
      comRelease(f.uav ?? 0n);
      comRelease(f.srv ?? 0n);
      comRelease(f.tex);
    }
    comRelease(ps);
    comRelease(vs);
    comRelease(stepCs);
    comRelease(seedCs);
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

console.log('Lenia — continuous cellular automata growing on the GPU.');
console.log(`  ${SIM_W}x${SIM_H} sim · kernel R=${R} (${KW * KW} taps) · ${SUBSTEPS} substeps/frame · ${gpu.driver} · ${gpu.gpuName}`);
console.log(`  screen ${SCREEN_W}x${SCREEN_H} · SPACE reseed · ESC exit.`);

// ── Render loop ─────────────────────────────────────────────────────────────────
const startTime = performance.now();
const durationMs = process.env.DEMO_DURATION_MS ? Number(process.env.DEMO_DURATION_MS) : 0;
const selfshot = process.env.SELFSHOT === '1';
let frame = 0;
let fpsFrames = 0;
let fpsWindow = startTime;
let prevSpace = false;

while (!win.shouldClose()) {
  win.pump();
  if (win.shouldClose()) break;

  const now = performance.now();
  const time = (now - startTime) / 1000;

  // SPACE re-seeds (edge-triggered).
  const spaceNow = win.keyDown(VK_SPACE);
  if (spaceNow && !prevSpace) seed();
  prevSpace = spaceNow;

  // ── Lenia sub-steps: fieldA (SRV) + kernel → fieldB (UAV), then swap. ──────────
  cbSimData.writeUInt32LE(SIM_W, 0);
  cbSimData.writeUInt32LE(SIM_H, 4);
  cbSimData.writeUInt32LE(frame >>> 0, 8);
  cbSimData.writeUInt32LE(seedCounter >>> 0, 12);
  cbSimData.writeFloatLE(MU, 16);
  cbSimData.writeFloatLE(SIGMA, 20);
  cbSimData.writeFloatLE(DT, 24);
  cbSimData.writeFloatLE(0, 28);
  updateConstantBuffer(cbSim, cbSimData);

  for (let s = 0; s < SUBSTEPS; s += 1) {
    clearPsSrv();
    csSet(stepCs, { cb: [cbSim], srv: [fieldA.srv!, kernelBuf.srv!], uav: [fieldB.uav!] });
    dispatch(groupsX, groupsY, 1);
    clearCsUav();
    clearCsSrv();
    const tmp = fieldA;
    fieldA = fieldB;
    fieldB = tmp;
  }

  // ── Colorize fieldA → back buffer, upsampled to the full monitor. ──────────────
  cbColData.writeFloatLE(SIM_W, 0);
  cbColData.writeFloatLE(SIM_H, 4);
  cbColData.writeFloatLE(clientW, 8);
  cbColData.writeFloatLE(clientH, 12);
  cbColData.writeFloatLE(time, 16);
  cbColData.writeFloatLE(0, 20);
  cbColData.writeFloatLE(0, 24);
  cbColData.writeFloatLE(0, 28);
  updateConstantBuffer(cbCol, cbColData);

  setRenderTargets([gpu.backBufferRTV]);
  setViewport(clientW, clientH);
  clear(gpu.backBufferRTV, [0.005, 0.015, 0.025, 1]);
  vsSet(vs);
  psSet(ps, { cb: [cbCol], srv: [fieldA.srv!], samp: [sampLinear] });
  drawFullscreenTriangle();
  clearPsSrv();
  setRenderTargets([]);

  // ── HUD composited INTO the back buffer (after the scene, before present). ─────
  drawHud();
  setRenderTargets([]); // hud.draw leaves the back-buffer RTV bound; unbind before capture

  // ── Self-verification snapshot on the final frame, before present(). ───────────
  const lastFrame = durationMs > 0 && now - startTime >= durationMs;
  if (lastFrame && selfshot) {
    const shotDir = resolve(import.meta.dir, '..', 'screenshots');
    mkdirSync(shotDir, { recursive: true });
    const stats = captureBackBuffer(gpu, resolve(shotDir, 'lenia.selfcheck.png'), { gridW: 48, gridH: 22 });
    console.log(formatGrid(stats));
    console.log(`[shot] ok=${stats.ok} nonBlack=${stats.nonBlackFrac.toFixed(3)} meanLuma=${stats.meanLuma.toFixed(3)} -> ${stats.path}`);
  }

  // Present the composited frame (scene + HUD). On the terminal self-check frame the
  // back buffer is already captured to PNG and the window is about to be destroyed;
  // presenting right after the capture's CopyResource/Map of this HUD-composited frame
  // faults the driver, so skip the final present (the live HUD path is unaffected).
  if (!(lastFrame && selfshot)) gpu.present(false);

  frame += 1;
  fpsFrames += 1;
  if (now - fpsWindow >= 500) {
    fps = Math.round((fpsFrames * 1000) / (now - fpsWindow));
    fpsFrames = 0;
    fpsWindow = now;
  }

  if (lastFrame) break;
}

console.log(`  ran ${frame} frames over ${((performance.now() - startTime) / 1000).toFixed(2)}s (${fps} fps).`);
cleanup(0);
