/**
 * D3D12 Device Probe
 *
 * A thorough, flat-FFI diagnostic of everything `d3d12.dll` exports without
 * ever touching a device's COM vtable for the capability checks. It walks the
 * full feature-level ladder by calling `D3D12CreateDevice` with a NULL output
 * (the documented "does creation succeed?" probe — S_OK / S_FALSE both mean
 * yes), reports whether the debug layer and the SDK-configuration global
 * interface are reachable via `D3D12GetDebugInterface` / `D3D12GetInterface`,
 * and finishes with two real serialize → deserialize round-trips of an empty
 * root signature (both the classic and the versioned APIs), reading the
 * produced ID3DBlob back through its `GetBufferPointer` / `GetBufferSize`
 * vtable slots and re-parsing it. Every returned COM object is released.
 *
 * APIs demonstrated:
 *   - D3d12.D3D12CreateDevice                              (feature-level support probe)
 *   - D3d12.D3D12GetDebugInterface                         (ID3D12Debug availability)
 *   - D3d12.D3D12GetInterface                              (CLSID_D3D12SDKConfiguration)
 *   - D3d12.D3D12SerializeRootSignature                    (empty root signature → blob)
 *   - D3d12.D3D12CreateRootSignatureDeserializer           (blob → deserializer round-trip)
 *   - D3d12.D3D12SerializeVersionedRootSignature           (versioned root signature → blob)
 *   - D3d12.D3D12CreateVersionedRootSignatureDeserializer  (versioned round-trip)
 *   - ID3DBlob::GetBufferPointer / GetBufferSize           (read serialized bytes back)
 *   - IUnknown::Release                                    (release every COM object)
 *   - kernel32!GetCurrentProcess / ReadProcessMemory       (vtable pointer reads)
 *
 * Run: bun run example:d3d12-device-probe
 */

import { FFIType, dlopen, linkSymbols } from 'bun:ffi';

import D3d12, { D3D_FEATURE_LEVEL, D3D_ROOT_SIGNATURE_VERSION } from '..';

const ANSI = {
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  yellow: '\x1b[33m',
} as const;

const POINTER_SIZE = 8;
const RELEASE_OFFSET = 0x10;
const BLOB_GET_BUFFER_POINTER_OFFSET = 0x18;
const BLOB_GET_BUFFER_SIZE_OFFSET = 0x20;

const S_OK = 0x0000_0000;
const S_FALSE = 0x0000_0001;

const IID_ID3D12Debug = '344488b7-6846-474b-b989-f027448245e0';
const IID_ID3D12Device = '189819f1-1db6-4b57-be54-1821339b85f7';
const IID_ID3D12RootSignatureDeserializer = '34ab647b-3cc8-46ac-841b-c0965645c046';
const IID_ID3D12VersionedRootSignatureDeserializer = '7f91ce67-090c-4bb7-b78e-ed8ff2e31da0';
const CLSID_D3D12SDKConfiguration = '7cda6aca-a03e-49c8-9458-0334d20e07ce';
const IID_ID3D12SDKConfiguration = 'e9eb5314-33aa-42b2-a718-d77f58b1f1c7';

const FEATURE_LEVELS: Array<{ label: string; level: D3D_FEATURE_LEVEL }> = [
  { label: '12_2', level: D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_2 },
  { label: '12_1', level: D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_1 },
  { label: '12_0', level: D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_12_0 },
  { label: '11_1', level: D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_11_1 },
  { label: '11_0', level: D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_11_0 },
  { label: '1_0_CORE', level: D3D_FEATURE_LEVEL.D3D_FEATURE_LEVEL_1_0_CORE },
];

D3d12.Preload();

const kernel32 = dlopen('kernel32.dll', {
  GetCurrentProcess: { args: [], returns: FFIType.u64 },
  ReadProcessMemory: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
});

const currentProcess = kernel32.symbols.GetCurrentProcess();

type Status = 'ok' | 'fail' | 'info';

interface Row {
  detail: string;
  hr: number | null;
  name: string;
  section: string;
  status: Status;
}

const rows: Row[] = [];

function formatHResult(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

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

function comRelease(address: bigint): number {
  if (address === 0n) return 0;
  const vtable = readPointerAt(address);
  const releaseAddr = readPointerAt(vtable + BigInt(RELEASE_OFFSET));
  const calls = linkSymbols({
    Release: { args: [FFIType.u64], ptr: releaseAddr, returns: FFIType.u32 },
  });
  try {
    return calls.symbols.Release(address);
  } finally {
    calls.close();
  }
}

// Read an ID3DBlob's bytes back into a local Bun Buffer via its
// GetBufferPointer / GetBufferSize vtable slots, so the serialized root
// signature can be fed straight into the matching deserializer API.
function blobBytes(blobAddress: bigint): { bytes: Buffer; pointer: bigint; size: bigint } {
  const vtable = readPointerAt(blobAddress);
  const getPointerAddr = readPointerAt(vtable + BigInt(BLOB_GET_BUFFER_POINTER_OFFSET));
  const getSizeAddr = readPointerAt(vtable + BigInt(BLOB_GET_BUFFER_SIZE_OFFSET));
  const calls = linkSymbols({
    GetBufferPointer: { args: [FFIType.u64], ptr: getPointerAddr, returns: FFIType.u64 },
    GetBufferSize: { args: [FFIType.u64], ptr: getSizeAddr, returns: FFIType.u64 },
  });
  try {
    const pointer = calls.symbols.GetBufferPointer(blobAddress);
    const size = calls.symbols.GetBufferSize(blobAddress);
    const bytes = Buffer.alloc(Number(size));
    const ok = kernel32.symbols.ReadProcessMemory(currentProcess, pointer, bytes.ptr, size, null);
    if (ok === 0) throw new Error(`ReadProcessMemory failed reading blob @ 0x${pointer.toString(16)}`);
    return { bytes, pointer, size };
  } finally {
    calls.close();
  }
}

function record(section: string, name: string, status: Status, hr: number | null, detail: string): void {
  rows.push({ detail, hr, name, section, status });
}

// ── Section A: feature-level support (flat FFI, NULL device output) ──────────
const iidDevice = guidBytes(IID_ID3D12Device);
let highestSupported: string | null = null;

for (const fl of FEATURE_LEVELS) {
  const hr = D3d12.D3D12CreateDevice(null, fl.level, iidDevice.ptr, null);
  const hrU = hr >>> 0;
  if (hrU === S_OK || hrU === S_FALSE) {
    if (highestSupported === null) highestSupported = fl.label;
    record('Feature levels', `FL ${fl.label}`, 'ok', hr, hrU === S_FALSE ? 'supported (S_FALSE — probe only)' : 'supported');
  } else {
    record('Feature levels', `FL ${fl.label}`, 'info', hr, `unsupported · ${formatHResult(hr)}`);
  }
}

// ── Section B: debug + global interfaces ─────────────────────────────────────
{
  const iid = guidBytes(IID_ID3D12Debug);
  const out = Buffer.alloc(POINTER_SIZE);
  const hr = D3d12.D3D12GetDebugInterface(iid.ptr, out.ptr);
  if (hr >>> 0 === S_OK) {
    const addr = out.readBigUInt64LE(0);
    record('Debug & globals', 'D3D12GetDebugInterface', 'ok', hr, `ID3D12Debug @ 0x${addr.toString(16)} (debug layer present)`);
    comRelease(addr);
  } else {
    record('Debug & globals', 'D3D12GetDebugInterface', 'info', hr, `${formatHResult(hr)} — Graphics Tools not installed`);
  }
}

{
  const clsid = guidBytes(CLSID_D3D12SDKConfiguration);
  const iid = guidBytes(IID_ID3D12SDKConfiguration);
  const out = Buffer.alloc(POINTER_SIZE);
  const hr = D3d12.D3D12GetInterface(clsid.ptr, iid.ptr, out.ptr);
  if (hr >>> 0 === S_OK) {
    const addr = out.readBigUInt64LE(0);
    record('Debug & globals', 'D3D12GetInterface', 'ok', hr, `ID3D12SDKConfiguration @ 0x${addr.toString(16)}`);
    comRelease(addr);
  } else {
    record('Debug & globals', 'D3D12GetInterface', 'info', hr, `${formatHResult(hr)} (SDK configuration unavailable)`);
  }
}

// ── Section C: root-signature serialize → deserialize round-trips ────────────
{
  // D3D12_ROOT_SIGNATURE_DESC: NumParameters@0, pParameters@8, NumStaticSamplers@16,
  // pStaticSamplers@24, Flags@32 — an all-zero (empty) root signature is valid.
  const desc = Buffer.alloc(40);
  const ppBlob = Buffer.alloc(POINTER_SIZE);
  const ppError = Buffer.alloc(POINTER_SIZE);
  const hr = D3d12.D3D12SerializeRootSignature(desc.ptr, D3D_ROOT_SIGNATURE_VERSION.D3D_ROOT_SIGNATURE_VERSION_1, ppBlob.ptr, ppError.ptr);
  if (hr >>> 0 !== S_OK) {
    record('Root signature', 'D3D12SerializeRootSignature', 'fail', hr, formatHResult(hr));
  } else {
    const blobAddr = ppBlob.readBigUInt64LE(0);
    const { bytes, pointer, size } = blobBytes(blobAddr);
    record('Root signature', 'D3D12SerializeRootSignature', 'ok', hr, `serialized ${size} bytes @ 0x${pointer.toString(16)}`);

    const iid = guidBytes(IID_ID3D12RootSignatureDeserializer);
    const ppDeser = Buffer.alloc(POINTER_SIZE);
    const hrD = D3d12.D3D12CreateRootSignatureDeserializer(bytes.ptr, size, iid.ptr, ppDeser.ptr);
    if (hrD >>> 0 === S_OK) {
      const deserAddr = ppDeser.readBigUInt64LE(0);
      record('Root signature', 'D3D12CreateRootSignatureDeserializer', 'ok', hrD, `round-trip OK · ID3D12RootSignatureDeserializer @ 0x${deserAddr.toString(16)}`);
      comRelease(deserAddr);
    } else {
      record('Root signature', 'D3D12CreateRootSignatureDeserializer', 'fail', hrD, formatHResult(hrD));
    }
    comRelease(blobAddr);
  }
}

{
  // D3D12_VERSIONED_ROOT_SIGNATURE_DESC: Version@0, then the 1.0 desc union @8.
  const desc = Buffer.alloc(48);
  desc.writeUInt32LE(D3D_ROOT_SIGNATURE_VERSION.D3D_ROOT_SIGNATURE_VERSION_1, 0);
  const ppBlob = Buffer.alloc(POINTER_SIZE);
  const ppError = Buffer.alloc(POINTER_SIZE);
  const hr = D3d12.D3D12SerializeVersionedRootSignature(desc.ptr, ppBlob.ptr, ppError.ptr);
  if (hr >>> 0 !== S_OK) {
    record('Root signature', 'D3D12SerializeVersionedRootSignature', 'fail', hr, formatHResult(hr));
  } else {
    const blobAddr = ppBlob.readBigUInt64LE(0);
    const { bytes, pointer, size } = blobBytes(blobAddr);
    record('Root signature', 'D3D12SerializeVersionedRootSignature', 'ok', hr, `serialized ${size} bytes @ 0x${pointer.toString(16)}`);

    const iid = guidBytes(IID_ID3D12VersionedRootSignatureDeserializer);
    const ppDeser = Buffer.alloc(POINTER_SIZE);
    const hrD = D3d12.D3D12CreateVersionedRootSignatureDeserializer(bytes.ptr, size, iid.ptr, ppDeser.ptr);
    if (hrD >>> 0 === S_OK) {
      const deserAddr = ppDeser.readBigUInt64LE(0);
      record('Root signature', 'D3D12CreateVersionedRootSignatureDeserializer', 'ok', hrD, `round-trip OK · ID3D12VersionedRootSignatureDeserializer @ 0x${deserAddr.toString(16)}`);
      comRelease(deserAddr);
    } else {
      record('Root signature', 'D3D12CreateVersionedRootSignatureDeserializer', 'fail', hrD, formatHResult(hrD));
    }
    comRelease(blobAddr);
  }
}

kernel32.close();

// ── Report ───────────────────────────────────────────────────────────────────
const NAME_WIDTH = Math.max(...rows.map((r) => r.name.length));
const HR_WIDTH = 10;

const badge: Record<Status, string> = {
  fail: `${ANSI.red}✗${ANSI.reset}`,
  info: `${ANSI.cyan}ℹ${ANSI.reset}`,
  ok: `${ANSI.green}✓${ANSI.reset}`,
};

console.log();
console.log(`${ANSI.bold}${ANSI.cyan}d3d12.dll${ANSI.reset}  ${ANSI.dim}device + root-signature probe · ${rows.length} checks${ANSI.reset}`);

let currentSection = '';
for (const r of rows) {
  if (r.section !== currentSection) {
    currentSection = r.section;
    console.log();
    console.log(`  ${ANSI.bold}${ANSI.magenta}${r.section}${ANSI.reset}`);
    console.log(`  ${ANSI.dim}${'─'.repeat(Math.min(120, NAME_WIDTH + 2 + HR_WIDTH + 2 + 50))}${ANSI.reset}`);
  }
  const hrRaw = r.hr === null ? '(n/a)' : r.hr >>> 0 === S_OK ? 'S_OK' : r.hr >>> 0 === S_FALSE ? 'S_FALSE' : formatHResult(r.hr);
  const hrColored = r.hr === null ? `${ANSI.dim}(n/a)${ANSI.reset}` : r.hr >>> 0 === S_OK || r.hr >>> 0 === S_FALSE ? `${ANSI.green}${hrRaw}${ANSI.reset}` : `${ANSI.yellow}${hrRaw}${ANSI.reset}`;
  const pad = ' '.repeat(Math.max(0, HR_WIDTH - hrRaw.length));
  const detail = r.status === 'info' ? `${ANSI.dim}${r.detail}${ANSI.reset}` : r.detail;
  console.log(`  ${badge[r.status]} ${ANSI.yellow}${r.name.padEnd(NAME_WIDTH)}${ANSI.reset}  ${hrColored}${pad}  ${detail}`);
}

const okCount = rows.filter((r) => r.status === 'ok').length;
const failCount = rows.filter((r) => r.status === 'fail').length;
const infoCount = rows.filter((r) => r.status === 'info').length;

console.log();
console.log(
  `  ${ANSI.bold}${okCount}${ANSI.reset} ${ANSI.green}ok${ANSI.reset}` +
    `  ${ANSI.dim}•${ANSI.reset}  ${ANSI.bold}${failCount}${ANSI.reset} ${ANSI.red}fail${ANSI.reset}` +
    `  ${ANSI.dim}•${ANSI.reset}  ${ANSI.bold}${infoCount}${ANSI.reset} ${ANSI.cyan}info${ANSI.reset}` +
    (highestSupported ? `  ${ANSI.dim}•${ANSI.reset}  highest feature level ${ANSI.yellow}${highestSupported}${ANSI.reset}` : ''),
);
console.log();

process.exit(failCount > 0 ? 1 : 0);
