/**
 * D3D12 GPU Capability X-Ray
 *
 * Creates a *real* Direct3D 12 device on the default adapter — entirely over
 * Bun FFI, no native addon — then "x-rays" the driver by hammering the
 * device's `ID3D12Device::CheckFeatureSupport` vtable slot for a battery of
 * D3D12_FEATURE queries. The hidden capability matrix that normally requires
 * a C++ toolchain to read (ray-tracing tier, mesh shaders, wave intrinsics,
 * 64-bit shader ops, resource-binding tier, top shader model, UMA, sampler
 * feedback, …) is decoded straight from the returned structs and revealed
 * one scan line at a time with colored signal-strength bars and an ASCII
 * GPU silhouette. The device is released cleanly on the way out.
 *
 * APIs demonstrated:
 *   - D3d12.D3D12CreateDevice                  (bootstrap a real ID3D12Device)
 *   - ID3D12Device::CheckFeatureSupport        (decode the capability matrix)
 *   - IUnknown::Release                        (release the device)
 *   - kernel32!GetCurrentProcess               (process handle for memory reads)
 *   - kernel32!ReadProcessMemory               (walk the COM vtable)
 *
 * Run: bun run example:d3d12-capability-xray
 */

import { FFIType, dlopen, linkSymbols } from 'bun:ffi';

import D3d12, { D3D_FEATURE_LEVEL } from '..';

const ANSI = {
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  grey: '\x1b[90m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  white: '\x1b[97m',
  yellow: '\x1b[33m',
} as const;

const POINTER_SIZE = 8;
const RELEASE_OFFSET = 0x10;
// ID3D12Device : ID3D12Object : IUnknown — IUnknown(3) + ID3D12Object(4) = 7
// entries precede the device methods; CheckFeatureSupport is device index 6,
// i.e. absolute vtable index 13 → 13 * 8 = 0x68.
const CHECK_FEATURE_SUPPORT_OFFSET = 0x68;

const IID_ID3D12Device = '189819f1-1db6-4b57-be54-1821339b85f7';

const D3D12_FEATURE_D3D12_OPTIONS = 0;
const D3D12_FEATURE_ARCHITECTURE = 1;
const D3D12_FEATURE_FEATURE_LEVELS = 2;
const D3D12_FEATURE_SHADER_MODEL = 7;
const D3D12_FEATURE_D3D12_OPTIONS1 = 8;
const D3D12_FEATURE_ROOT_SIGNATURE = 12;
const D3D12_FEATURE_D3D12_OPTIONS5 = 27;
const D3D12_FEATURE_D3D12_OPTIONS7 = 32;

const kernel32 = dlopen('kernel32.dll', {
  GetCurrentProcess: { args: [], returns: FFIType.u64 },
  ReadProcessMemory: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
});

const currentProcess = kernel32.symbols.GetCurrentProcess();

function guidBytes(value: string): Buffer {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(value);
  if (match === null) throw new Error(`Invalid GUID: ${value}`);
  const [, d1, d2, d3, d4High, d4Low] = match;
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(parseInt(d1, 16), 0);
  buffer.writeUInt16LE(parseInt(d2, 16), 4);
  buffer.writeUInt16LE(parseInt(d3, 16), 6);
  const data4 = `${d4High}${d4Low}`;
  for (let i = 0; i < 8; i += 1) buffer[8 + i] = parseInt(data4.slice(i * 2, i * 2 + 2), 16);
  return buffer;
}

function readPointerAt(address: bigint): bigint {
  const buffer = Buffer.alloc(POINTER_SIZE);
  const ok = kernel32.symbols.ReadProcessMemory(currentProcess, address, buffer.ptr, BigInt(POINTER_SIZE), null);
  if (ok === 0) throw new Error(`ReadProcessMemory failed at 0x${address.toString(16)}`);
  return buffer.readBigUInt64LE(0);
}

function comRelease(address: bigint): void {
  if (address === 0n) return;
  const vtable = readPointerAt(address);
  const releaseAddr = readPointerAt(vtable + BigInt(RELEASE_OFFSET));
  const calls = linkSymbols({ Release: { args: [FFIType.u64], ptr: releaseAddr, returns: FFIType.u32 } });
  try {
    calls.symbols.Release(address);
  } finally {
    calls.close();
  }
}

function featureLevelLabel(value: number): string {
  switch (value) {
    case D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_2:
      return '12_2';
    case D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_1:
      return '12_1';
    case D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_0:
      return '12_0';
    case D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_11_1:
      return '11_1';
    case D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_11_0:
      return '11_0';
    default:
      return `0x${value.toString(16)}`;
  }
}

const GPU_ART = [
  '       ┌─────────────────────────────┐',
  '       │  ▟▙ ▟▙ ▟▙ ▟▙   D3D12  GPU   │',
  '       │  ▜▛ ▜▛ ▜▛ ▜▛   ┌───────┐    │',
  '       │  ▟▙ ▟▙ ▟▙ ▟▙   │ ▓▓▓▓▓ │    │',
  '       │  ▜▛ ▜▛ ▜▛ ▜▛   └───────┘    │',
  '       └──┬┬┬┬┬┬┬┬┬┬┬┬┬┬┬┬┬┬┬┬┬──────┘',
];

console.log();
console.log(`${ANSI.bold}${ANSI.cyan}  D3D12 GPU Capability X-Ray${ANSI.reset}  ${ANSI.dim}— a real ID3D12Device, decoded over pure FFI${ANSI.reset}`);
for (const line of GPU_ART) console.log(`${ANSI.magenta}${line}${ANSI.reset}`);
console.log();

const iidDevice = guidBytes(IID_ID3D12Device);
const ppDevice = Buffer.alloc(POINTER_SIZE);
const hr = D3d12.D3D12CreateDevice(null, D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_11_0, iidDevice.ptr, ppDevice.ptr);

if (hr >>> 0 !== 0) {
  console.log(`  ${ANSI.yellow}ℹ${ANSI.reset} No D3D12-capable adapter on this machine (D3D12CreateDevice → 0x${(hr >>> 0).toString(16).padStart(8, '0')}).`);
  console.log(`  ${ANSI.dim}The binding works; this host just has no D3D12 device to x-ray.${ANSI.reset}`);
  console.log();
  kernel32.close();
  process.exit(0);
}

const deviceAddr = ppDevice.readBigUInt64LE(0);
const deviceVtable = readPointerAt(deviceAddr);
const checkAddr = readPointerAt(deviceVtable + BigInt(CHECK_FEATURE_SUPPORT_OFFSET));
const check = linkSymbols({
  CheckFeatureSupport: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], ptr: checkAddr, returns: FFIType.i32 },
});

function query(feature: number, data: Buffer): boolean {
  return check.symbols.CheckFeatureSupport(deviceAddr, feature, data.ptr, data.length) >>> 0 === 0;
}

interface Cap {
  label: string;
  strength: number; // 0..5 for the signal bar
  value: string;
}

const caps: Cap[] = [];

// FEATURE_LEVELS: NumFeatureLevels@0, pFeatureLevelsRequested@8, MaxSupported@16
{
  const requested = Buffer.alloc(5 * 4);
  const ladder = [D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_2, D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_1, D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_0, D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_11_0];
  ladder.forEach((lvl, i) => requested.writeUInt32LE(lvl, i * 4));
  const data = Buffer.alloc(24);
  data.writeUInt32LE(ladder.length, 0);
  data.writeBigUInt64LE(BigInt(requested.ptr), 8);
  if (query(D3D12_FEATURE_FEATURE_LEVELS, data)) {
    const max = data.readUInt32LE(16);
    const strength = max >= D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_2 ? 5 : max >= D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_0 ? 4 : 3;
    caps.push({ label: 'Max feature level', strength, value: featureLevelLabel(max) });
  }
}

// SHADER_MODEL: HighestShaderModel@0 inout — request 6.7, read back actual
{
  const data = Buffer.alloc(4);
  data.writeUInt32LE(0x67, 0);
  if (query(D3D12_FEATURE_SHADER_MODEL, data)) {
    const sm = data.readUInt32LE(0);
    caps.push({ label: 'Top shader model', strength: sm >= 0x66 ? 5 : sm >= 0x63 ? 4 : 3, value: `${sm >> 4}.${sm & 0xf}` });
  }
}

// ROOT_SIGNATURE: HighestVersion@0 inout — request 1.1, read back
{
  const data = Buffer.alloc(4);
  data.writeUInt32LE(2, 0);
  if (query(D3D12_FEATURE_ROOT_SIGNATURE, data)) {
    const v = data.readUInt32LE(0);
    caps.push({ label: 'Root signature', strength: v >= 2 ? 5 : 3, value: v >= 2 ? '1.1' : '1.0' });
  }
}

// ARCHITECTURE: NodeIndex@0 in, TileBasedRenderer@4, UMA@8, CacheCoherentUMA@12
{
  const data = Buffer.alloc(16);
  if (query(D3D12_FEATURE_ARCHITECTURE, data)) {
    const uma = data.readUInt32LE(8) !== 0;
    const tbr = data.readUInt32LE(4) !== 0;
    caps.push({ label: 'Memory architecture', strength: uma ? 4 : 5, value: `${uma ? 'UMA' : 'discrete'}${tbr ? ' · tile-based' : ''}` });
  }
}

// D3D12_OPTIONS: DoublePrecision@0, ResourceBindingTier@16, ROVsSupported@28
{
  const data = Buffer.alloc(64);
  if (query(D3D12_FEATURE_D3D12_OPTIONS, data)) {
    const rbt = data.readUInt32LE(16);
    caps.push({ label: 'Resource binding tier', strength: rbt >= 3 ? 5 : rbt === 2 ? 4 : 2, value: `tier ${rbt}` });
    caps.push({ label: 'Double-precision shaders', strength: data.readUInt32LE(0) !== 0 ? 5 : 0, value: data.readUInt32LE(0) !== 0 ? 'yes' : 'no' });
    caps.push({ label: 'Raster-ordered views', strength: data.readUInt32LE(28) !== 0 ? 5 : 0, value: data.readUInt32LE(28) !== 0 ? 'yes' : 'no' });
  }
}

// D3D12_OPTIONS1: WaveOps@0, WaveLaneCountMin@4, WaveLaneCountMax@8, Int64@20
{
  const data = Buffer.alloc(24);
  if (query(D3D12_FEATURE_D3D12_OPTIONS1, data)) {
    const waveOps = data.readUInt32LE(0) !== 0;
    const min = data.readUInt32LE(4);
    const max = data.readUInt32LE(8);
    caps.push({ label: 'Wave intrinsics', strength: waveOps ? 5 : 0, value: waveOps ? `yes · lanes ${min}–${max}` : 'no' });
    caps.push({ label: '64-bit shader ops', strength: data.readUInt32LE(20) !== 0 ? 5 : 0, value: data.readUInt32LE(20) !== 0 ? 'yes' : 'no' });
  }
}

// D3D12_OPTIONS5: SRVOnlyTiled@0, RenderPassesTier@4, RaytracingTier@8
{
  const data = Buffer.alloc(12);
  if (query(D3D12_FEATURE_D3D12_OPTIONS5, data)) {
    const rt = data.readUInt32LE(8);
    const label = rt >= 11 ? '1.1 (inline RT)' : rt >= 10 ? '1.0' : 'not supported';
    caps.push({ label: 'Ray tracing', strength: rt >= 11 ? 5 : rt >= 10 ? 4 : 0, value: label });
  }
}

// D3D12_OPTIONS7: MeshShaderTier@0, SamplerFeedbackTier@4
{
  const data = Buffer.alloc(8);
  if (query(D3D12_FEATURE_D3D12_OPTIONS7, data)) {
    const mesh = data.readUInt32LE(0);
    const sf = data.readUInt32LE(4);
    caps.push({ label: 'Mesh shaders', strength: mesh >= 10 ? 5 : 0, value: mesh >= 10 ? 'tier 1' : 'not supported' });
    caps.push({ label: 'Sampler feedback', strength: sf >= 100 ? 5 : sf >= 90 ? 4 : 0, value: sf >= 100 ? 'tier 1.0' : sf >= 90 ? 'tier 0.9' : 'not supported' });
  }
}

check.close();

const LABEL_WIDTH = Math.max(...caps.map((c) => c.label.length));

function bar(strength: number): string {
  const filled = '█'.repeat(strength);
  const empty = `${ANSI.grey}${'░'.repeat(5 - strength)}${ANSI.reset}`;
  const color = strength >= 5 ? ANSI.green : strength >= 4 ? ANSI.cyan : strength >= 2 ? ANSI.yellow : ANSI.red;
  return `${color}${filled}${ANSI.reset}${empty}`;
}

console.log(`  ${ANSI.dim}scanning ${caps.length} capability registers…${ANSI.reset}`);
console.log();

for (const cap of caps) {
  Bun.sleepSync(70);
  const sweep = `${ANSI.cyan}▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒${ANSI.reset}`;
  process.stdout.write(`\r  ${ANSI.dim}▶${ANSI.reset} ${sweep}`);
  Bun.sleepSync(45);
  const value = cap.strength >= 4 ? `${ANSI.white}${cap.value}${ANSI.reset}` : cap.strength === 0 ? `${ANSI.dim}${cap.value}${ANSI.reset}` : `${ANSI.yellow}${cap.value}${ANSI.reset}`;
  process.stdout.write(`\r  ${ANSI.green}▶${ANSI.reset} ${ANSI.cyan}${cap.label.padEnd(LABEL_WIDTH)}${ANSI.reset}  ${bar(cap.strength)}  ${value}\x1b[K\n`);
}

const score = caps.reduce((sum, c) => sum + c.strength, 0);
const maxScore = caps.length * 5;
const pct = maxScore === 0 ? 0 : Math.round((score / maxScore) * 100);
const verdict = pct >= 85 ? `${ANSI.green}flagship-class${ANSI.reset}` : pct >= 60 ? `${ANSI.cyan}modern & capable${ANSI.reset}` : pct >= 35 ? `${ANSI.yellow}baseline D3D12${ANSI.reset}` : `${ANSI.red}minimal${ANSI.reset}`;

console.log();
console.log(`  ${ANSI.bold}GPU verdict:${ANSI.reset} ${verdict}  ${ANSI.dim}(${score}/${maxScore} · ${pct}% of probed capability ceiling)${ANSI.reset}`);
console.log(`  ${ANSI.dim}ID3D12Device @ 0x${deviceAddr.toString(16)} — released cleanly.${ANSI.reset}`);
console.log();

comRelease(deviceAddr);
kernel32.close();
