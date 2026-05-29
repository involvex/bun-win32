/**
 * Shader Forge — compile an HLSL ray-marcher at runtime and run it on your real GPU, from TypeScript.
 *
 * A borderless 1280x720 window fills with a living, breathing ray-marched scene: a glowing
 * rounded-box fractal floating in a hazy palette-cycling void, lit with a soft key light and
 * cheap soft shadows, fog that fades to a warm horizon, and a vignette that pulses with time.
 * Drag the mouse and the camera leans toward the cursor. None of this is precomputed — at
 * startup the program hands raw HLSL **source** to `d3dcompiler_47!D3DCompile`, which JITs it
 * to DXBC bytecode; that bytecode is uploaded straight into a real hardware `ID3D11Device`,
 * and every frame the GPU executes the shader over a single full-screen triangle, fed time +
 * resolution + mouse through a constant buffer and Present()ed via the DXGI swap chain. A GDI
 * HUD overlays "HLSL compiled at runtime · <ms> · <fps> fps · <GPU name>", composited into the
 * back buffer (via _hud) so it never flickers.
 *
 * Pipeline (each step):
 *   1. gpu.createWindow (WS_POPUP borderless, mandatory visibility fix)
 *   2. gpu.createDevice → real hardware ID3D11Device + DXGI swap chain (WARP fallback)
 *   3. gpu.compile the fullscreen-triangle VS (SV_VertexID, no vertex buffer) → DXBC
 *   4. gpu.compile the ray-marching PS (cbuffer b0) → DXBC  (compile timed for the HUD)
 *   5. gpu.makeVertexShader / makePixelShader / makeConstantBuffer
 *   6. per frame: updateConstantBuffer → setRenderTargets(backBufferRTV) → setViewport →
 *      clear → vsSet → psSet(cb) → drawFullscreenTriangle → hud.draw (GDI into back buffer)
 *      → g.present(false)
 *   7. release every COM object on exit
 *
 * APIs demonstrated:
 *   - D3dcompiler_47.D3DCompile  (runtime HLSL → DXBC, both stages — via gpu.compile)
 *   - ID3D11Device / ID3D11DeviceContext / IDXGISwapChain vtables (via the _gpu engine)
 *   - IDXGIDevice / IDXGIAdapter (GPU name)
 *   - GDI32  CreateFontW, SelectObject, SetTextColor, SetBkMode, TextOutW, DeleteObject
 *            (HUD glyphs, now composited into the back buffer through _hud)
 *
 * Run: bun run packages/all/example/shader-forge.ts
 */

import * as gpu from './_gpu';
import * as hud from './_hud';
import { GDI32 } from '../index';

const encode = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');

// ── HLSL source ──────────────────────────────────────────────────────────────
// Vertex shader: a single full-screen triangle from SV_VertexID — no vertex
// buffer, no input layout. uv is carried to the pixel stage.
const VS_SOURCE = `
struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
VSOut main(uint vid : SV_VertexID) {
  VSOut o;
  float2 p = float2((vid << 1) & 2, vid & 2);
  o.uv = p;
  o.pos = float4(p * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
  return o;
}
`;

// Pixel shader: a palette-cycling ray-marched rounded-box fractal with cheap
// soft shadows, fog and a breathing vignette. Reads time/resolution/mouse from b0.
const PS_SOURCE = `
cbuffer Frame : register(b0) {
  float2 iResolution;
  float  iTime;
  float  pad0;
  float2 iMouse;
  float2 pad1;
};

float3 palette(float t) {
  float3 a = float3(0.55, 0.45, 0.55);
  float3 b = float3(0.45, 0.40, 0.45);
  float3 c = float3(1.0, 1.0, 1.0);
  float3 d = float3(0.10, 0.33, 0.67);
  return a + b * cos(6.28318 * (c * t + d));
}

float sdRoundBox(float3 p, float3 b, float r) {
  float3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float3x3 rotY(float a) {
  float s = sin(a); float c = cos(a);
  return float3x3(c, 0, s, 0, 1, 0, -s, 0, c);
}
float3x3 rotX(float a) {
  float s = sin(a); float c = cos(a);
  return float3x3(1, 0, 0, 0, c, -s, 0, s, c);
}

// Folded, animated rounded-box fractal — distance to the nearest surface.
float map(float3 p) {
  p = mul(rotY(iTime * 0.25), p);
  p = mul(rotX(iTime * 0.17), p);
  float scale = 1.0;
  float d = 1e9;
  [unroll]
  for (int i = 0; i < 4; i++) {
    p = abs(p) - float3(1.05, 1.05, 1.05);
    float dd = sdRoundBox(p, float3(0.62, 0.62, 0.62), 0.08) / scale;
    d = min(d, dd);
    p *= 1.7;
    scale *= 1.7;
    p = mul(rotY(0.5 + iTime * 0.05), p);
  }
  return d;
}

float3 calcNormal(float3 p) {
  float2 e = float2(0.0012, 0.0);
  return normalize(float3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)));
}

// Cheap soft shadow by tracking the closest approach to the surface.
float softShadow(float3 ro, float3 rd) {
  float res = 1.0;
  float t = 0.04;
  [loop]
  for (int i = 0; i < 28; i++) {
    float h = map(ro + rd * t);
    if (h < 0.0015) return 0.0;
    res = min(res, 9.0 * h / t);
    t += clamp(h, 0.02, 0.25);
    if (t > 9.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

float4 main(float4 fragPos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
  float2 res = max(iResolution, float2(1.0, 1.0));
  float2 p = (fragPos.xy * 2.0 - res) / res.y;
  p.y = -p.y;

  // Mouse drives a gentle camera lean.
  float2 m = (iMouse / res - 0.5) * 2.0;
  float yaw = m.x * 0.6 + iTime * 0.06;
  float pitch = m.y * 0.4 - 0.15;

  float3 ro = float3(0.0, 0.0, 5.2);
  ro = mul(rotY(yaw), ro);
  ro = mul(rotX(pitch), ro);
  float3 ww = normalize(-ro);
  float3 uu = normalize(cross(float3(0.0, 1.0, 0.0), ww));
  float3 vv = cross(ww, uu);
  float3 rd = normalize(p.x * uu + p.y * vv + 1.7 * ww);

  // March.
  float t = 0.0;
  float glow = 0.0;
  bool hit = false;
  [loop]
  for (int i = 0; i < 96; i++) {
    float3 pos = ro + rd * t;
    float d = map(pos);
    glow += 0.012 / (0.04 + d * d);
    if (d < 0.0015) { hit = true; break; }
    t += d;
    if (t > 14.0) break;
  }

  float3 sky = lerp(float3(0.02, 0.03, 0.06), float3(0.18, 0.10, 0.22), saturate(p.y * 0.5 + 0.5));
  sky += float3(0.35, 0.18, 0.08) * pow(saturate(1.0 - abs(p.y + 0.15)), 6.0); // warm horizon
  float3 col = sky;

  if (hit) {
    float3 pos = ro + rd * t;
    float3 n = calcNormal(pos);
    float3 lightDir = normalize(float3(0.6, 0.7, 0.4));
    float diff = saturate(dot(n, lightDir));
    float sh = softShadow(pos + n * 0.004, lightDir);
    float fres = pow(saturate(1.0 + dot(rd, n)), 3.0);
    float ao = saturate(1.0 - float(0) - t * 0.02);

    float3 base = palette(0.5 + 0.18 * length(pos) + iTime * 0.05);
    float3 lit = base * (0.18 + 0.9 * diff * sh);
    lit += fres * palette(iTime * 0.1 + 0.3) * 0.6;
    lit += base * pow(saturate(dot(reflect(rd, n), lightDir)), 32.0) * sh; // spec
    float fog = 1.0 - exp(-t * 0.10);
    col = lerp(lit, sky, fog);
  }

  // Volumetric glow halo.
  col += palette(iTime * 0.08 + 0.6) * glow * 0.5;

  // Breathing vignette + tone curve.
  float2 q = fragPos.xy / res;
  float vig = pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.25 + 0.05 * sin(iTime));
  col *= lerp(0.6, 1.05, vig);
  col = col / (col + 1.0);                 // Reinhard tonemap
  col = pow(col, 1.0 / 2.2);               // gamma
  return float4(col, 1.0);
}
`;

// ── Window + device + swap chain ──────────────────────────────────────────────
const WIDTH = 1280;
const HEIGHT = 720;

const win = gpu.createWindow({ title: 'Shader Forge — runtime HLSL on the GPU', width: WIDTH, height: HEIGHT, borderless: true });
const { w: clientW, h: clientH } = win.clientSize();
const g = gpu.createDevice(win.hwnd, { width: clientW, height: clientH });

// ── Compile both stages (timed for the HUD) ──────────────────────────────────
let vertexShader = 0n;
let pixelShader = 0n;
let vsCode: gpu.CompiledShader | null = null;
let psCode: gpu.CompiledShader | null = null;
let compileMs = 0;
try {
  const t0 = performance.now();
  vsCode = gpu.compile(VS_SOURCE, 'main', 'vs_5_0');
  psCode = gpu.compile(PS_SOURCE, 'main', 'ps_5_0');
  compileMs = performance.now() - t0;
  vertexShader = gpu.makeVertexShader(vsCode);
  pixelShader = gpu.makePixelShader(psCode);
} catch (err) {
  console.error(String((err as Error).message));
  if (vsCode) gpu.blobRelease(vsCode.blob);
  if (psCode) gpu.blobRelease(psCode.blob);
  gpu.comRelease(g.backBufferRTV);
  gpu.comRelease(g.swapChain);
  gpu.comRelease(g.context);
  gpu.comRelease(g.device);
  win.destroy();
  process.exit(1);
}

// Constant buffer: 32 bytes (float2 res, float time, float pad, float2 mouse, float2 pad2) — 16-byte multiple.
const CB_SIZE = 32;
const constantBuffer = gpu.makeConstantBuffer(CB_SIZE);

// ── GDI HUD font ─────────────────────────────────────────────────────────────
const hudFont = GDI32.CreateFontW(-18, 0, 0, 0, 600, 0, 0, 0, 0, 0, 0, 4 /* ANTIALIASED_QUALITY */, 0, encode('Consolas').ptr!);
const TRANSPARENT_BK = 1;

console.log('Shader Forge — runtime-compiled HLSL ray-marcher running on the GPU.');
console.log(`  HLSL compiled in ${compileMs.toFixed(2)} ms · ${g.driver} · ${g.gpuName}`);
console.log('  Move the mouse to lean the camera · ESC to exit.');

// ── Render loop ──────────────────────────────────────────────────────────────
const startTime = performance.now();
const durationMs = process.env.DEMO_DURATION_MS ? Number(process.env.DEMO_DURATION_MS) : 0;
let frames = 0;
let fps = 0;
let fpsWindowStart = startTime;
const cbData = Buffer.alloc(CB_SIZE);

let cleanedUp = false;
function cleanup(code: number): never {
  if (!cleanedUp) {
    cleanedUp = true;
    hud.release();
    GDI32.DeleteObject(hudFont);
    gpu.comRelease(g.backBufferRTV);
    gpu.comRelease(constantBuffer);
    gpu.comRelease(pixelShader);
    gpu.comRelease(vertexShader);
    if (vsCode) gpu.blobRelease(vsCode.blob);
    if (psCode) gpu.blobRelease(psCode.blob);
    gpu.comRelease(g.swapChain);
    gpu.comRelease(g.context);
    gpu.comRelease(g.device);
    win.destroy();
  }
  process.exit(code);
}
process.on('SIGINT', () => cleanup(0));

function drawHud(): void {
  const line = `HLSL compiled at runtime · ${compileMs.toFixed(1)} ms · ${fps} fps · ${g.gpuName}`;
  const text = encode(line);
  const len = line.length;
  hud.draw(g, clientW, clientH, (dc) => {
    GDI32.SelectObject(dc, hudFont);
    GDI32.SetBkMode(dc, TRANSPARENT_BK);
    // Soft shadow then bright text for legibility over any frame.
    GDI32.SetTextColor(dc, 0x000000);
    GDI32.TextOutW(dc, 17, 17, text.ptr!, len);
    GDI32.SetTextColor(dc, 0x00f0e0c0); // BGR: warm cyan-white
    GDI32.TextOutW(dc, 16, 16, text.ptr!, len);
  });
}

while (!win.shouldClose()) {
  // Non-blocking message pump.
  win.pump();
  if (win.shouldClose()) break;

  const now = performance.now();
  const elapsed = (now - startTime) / 1000;
  const mouse = win.getMouse();

  // Build the constant buffer immediately before the call that consumes it.
  cbData.writeFloatLE(clientW, 0); // iResolution.x
  cbData.writeFloatLE(clientH, 4); // iResolution.y
  cbData.writeFloatLE(elapsed, 8); // iTime
  cbData.writeFloatLE(0, 12); // pad
  cbData.writeFloatLE(mouse.x, 16); // iMouse.x
  cbData.writeFloatLE(clientH - mouse.y, 20); // iMouse.y (flip to GL-style)
  cbData.writeFloatLE(0, 24);
  cbData.writeFloatLE(0, 28);
  gpu.updateConstantBuffer(constantBuffer, cbData);

  // Render the ray-marched scene into the back buffer.
  gpu.setRenderTargets([g.backBufferRTV]);
  gpu.setViewport(clientW, clientH);
  gpu.clear(g.backBufferRTV, [0.015, 0.02, 0.05, 1.0]);
  gpu.vsSet(vertexShader);
  gpu.psSet(pixelShader, { cb: [constantBuffer] });
  gpu.drawFullscreenTriangle();

  // Composite the GDI HUD into the back buffer BEFORE present (flicker-free).
  drawHud();

  g.present(false);

  // FPS accounting.
  frames += 1;
  if (now - fpsWindowStart >= 500) {
    fps = Math.round((frames * 1000) / (now - fpsWindowStart));
    frames = 0;
    fpsWindowStart = now;
  }

  if (durationMs > 0 && now - startTime >= durationMs) break;
}

cleanup(0);
