/**
 * DXCore Adapter Report
 *
 * An exhaustive, flat-FFI hardware dossier for every DXCore-visible adapter on
 * the machine. `dxcore.dll` exports a single flat function; the entire report
 * is produced by hand-walking the `IDXCoreAdapterFactory` → `IDXCoreAdapterList`
 * → `IDXCoreAdapter` COM vtables. It first profiles each of the three DXCore
 * attribute families (D3D12 graphics, D3D12 core-compute, D3D11 graphics) —
 * adapter counts and which adapter-selection preferences each list supports —
 * then prints a fully-labelled property block for every adapter: decoded
 * hardware IDs with vendor names, driver version, WDDM model, preemption
 * granularity, every memory pool in human-readable units, and the full
 * capability/attribute matrix. Every COM object is released.
 *
 * APIs demonstrated (Dxcore):
 *   - DXCoreCreateAdapterFactory                              (bootstrap the factory)
 *   - IDXCoreAdapterFactory::CreateAdapterList                (per-attribute enumeration)
 *   - IDXCoreAdapterList::GetAdapterCount / GetAdapter / IsAdapterPreferenceSupported
 *   - IDXCoreAdapter::IsAttributeSupported / IsPropertySupported
 *   - IDXCoreAdapter::GetPropertySize / GetProperty           (every adapter property)
 *   - IUnknown::Release                                       (release every COM object)
 *
 * Run: bun run example/adapter-report.ts
 */

import { CFunction, FFIType, type Pointer, read } from 'bun:ffi';

import Dxcore, { DXCORE_ADAPTER_ATTRIBUTE_D3D11_GRAPHICS, DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE, DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS, DXCoreAdapterPreference, DXCoreAdapterProperty, IID_IDXCoreAdapter, IID_IDXCoreAdapterFactory, IID_IDXCoreAdapterList } from '../index';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const MAGENTA = '\x1b[95m';

const S_OK = 0;

// IUnknown(0..2) then declaration order from dxcore_interface.h.
const IUNKNOWN_RELEASE = 2;
const FACTORY_CREATEADAPTERLIST = 3;
const LIST_GETADAPTER = 3;
const LIST_GETADAPTERCOUNT = 4;
const LIST_ISADAPTERPREFERENCESUPPORTED = 8;
const ADAPTER_ISATTRIBUTESUPPORTED = 4;
const ADAPTER_ISPROPERTYSUPPORTED = 5;
const ADAPTER_GETPROPERTY = 6;
const ADAPTER_GETPROPERTYSIZE = 7;

const hex = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

/** Builds the 16-byte little-endian GUID layout COM expects from a REFIID/REFGUID. */
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
 * per (method pointer, signature) so the enumeration loops stay cheap.
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

function take(slot: Buffer): bigint {
  const ptr = slot.readBigUInt64LE(0);
  if (ptr !== 0n) liveObjects.push(ptr);
  return ptr;
}

function release(ptr: bigint): void {
  if (ptr === 0n) return;
  vcall(ptr, IUNKNOWN_RELEASE, [], [], FFIType.u32);
  const index = liveObjects.lastIndexOf(ptr);
  if (index !== -1) liveObjects.splice(index, 1);
}

function releaseAll(): void {
  for (const obj of liveObjects.splice(0).reverse()) vcall(obj, IUNKNOWN_RELEASE, [], [], FFIType.u32);
}

function attributeSupported(adapter: bigint, attribute: string): boolean {
  return vcall(adapter, ADAPTER_ISATTRIBUTESUPPORTED, [FFIType.ptr], [guid(attribute).ptr!], FFIType.u8) !== 0;
}

function propertySupported(adapter: bigint, property: DXCoreAdapterProperty): boolean {
  return vcall(adapter, ADAPTER_ISPROPERTYSUPPORTED, [FFIType.u32], [property], FFIType.u8) !== 0;
}

/** Reads a property into a buffer sized by GetPropertySize (handles variable-length data). */
function readProperty(adapter: bigint, property: DXCoreAdapterProperty): Buffer | null {
  if (!propertySupported(adapter, property)) return null;
  const sizeBuffer = Buffer.alloc(8);
  if (vcall(adapter, ADAPTER_GETPROPERTYSIZE, [FFIType.u32, FFIType.ptr], [property, sizeBuffer.ptr!]) !== S_OK) return null;
  const size = Number(sizeBuffer.readBigUInt64LE(0));
  if (size <= 0) return null;
  const buffer = Buffer.alloc(size);
  if (vcall(adapter, ADAPTER_GETPROPERTY, [FFIType.u32, FFIType.u64, FFIType.ptr], [property, BigInt(size), buffer.ptr!]) !== S_OK) return null;
  return buffer;
}

function vendorName(vendorID: number): string {
  switch (vendorID) {
    case 0x10de:
      return 'NVIDIA';
    case 0x1002:
    case 0x1022:
      return 'AMD';
    case 0x8086:
      return 'Intel';
    case 0x1414:
      return 'Microsoft';
    case 0x5143:
      return 'Qualcomm';
    case 0x15ad:
      return 'VMware';
    case 0x1ab8:
    case 0x1af4:
      return 'Virtio';
    default:
      return 'Unknown';
  }
}

function humanBytes(value: bigint): string {
  if (value <= 0n) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = Number(value);
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 2)} ${units[unit]} (${value.toLocaleString()} bytes)`;
}

// Documented on Microsoft Learn (DXCoreGraphicsPreemptionGranularity); not in
// the SDK header, so decoded locally with the raw value always shown.
const GRAPHICS_PREEMPTION = ['DMA buffer boundary', 'primitive boundary', 'triangle boundary', 'pixel boundary', 'instruction boundary'];
const COMPUTE_PREEMPTION = ['DMA buffer boundary', 'dispatch boundary', 'thread-group boundary', 'thread boundary', 'instruction boundary'];

const ATTRIBUTES: Array<{ guid: string; label: string }> = [
  { guid: DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS, label: 'D3D12_GRAPHICS' },
  { guid: DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE, label: 'D3D12_CORE_COMPUTE' },
  { guid: DXCORE_ADAPTER_ATTRIBUTE_D3D11_GRAPHICS, label: 'D3D11_GRAPHICS' },
];

const PREFERENCES: Array<{ label: string; value: DXCoreAdapterPreference }> = [
  { label: 'Hardware', value: DXCoreAdapterPreference.Hardware },
  { label: 'MinimumPower', value: DXCoreAdapterPreference.MinimumPower },
  { label: 'HighPerformance', value: DXCoreAdapterPreference.HighPerformance },
];

console.log();
console.log(`${BOLD}${CYAN}dxcore.dll${RESET}  ${DIM}adapter report — every DXCore adapter, decoded over pure FFI${RESET}`);

const factoryOut = Buffer.alloc(8);
const factoryHr = Dxcore.DXCoreCreateAdapterFactory(guid(IID_IDXCoreAdapterFactory).ptr!, factoryOut.ptr!);
if (factoryHr !== S_OK) {
  console.log();
  console.log(`  ${RED}✗${RESET} DXCoreCreateAdapterFactory failed (${hex(factoryHr)}). DXCore unavailable on this host.`);
  console.log();
  process.exit(1);
}
const factory = take(factoryOut);

/** Creates an attribute-filtered adapter list (caller releases it). */
function createList(attributeGuid: string): bigint {
  const filter = guid(attributeGuid);
  const out = Buffer.alloc(8);
  const hr = vcall(factory, FACTORY_CREATEADAPTERLIST, [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], [1, filter.ptr!, guid(IID_IDXCoreAdapterList).ptr!, out.ptr!]);
  if (hr !== S_OK) return 0n;
  return take(out);
}

// ── Section A: attribute-family profile ──────────────────────────────────────
console.log();
console.log(`  ${BOLD}${MAGENTA}Attribute families${RESET}`);
console.log(`  ${DIM}${'─'.repeat(72)}${RESET}`);
console.log(`  ${DIM}${'attribute'.padEnd(20)}${'adapters'.padEnd(10)}sort preferences supported${RESET}`);

for (const attribute of ATTRIBUTES) {
  const list = createList(attribute.guid);
  if (list === 0n) {
    console.log(`  ${YELLOW}${attribute.label.padEnd(20)}${RESET}${DIM}${'0'.padEnd(10)}list not available on this host${RESET}`);
    continue;
  }
  const count = vcall(list, LIST_GETADAPTERCOUNT, [], [], FFIType.u32) >>> 0;
  const supported = PREFERENCES.filter((preference) => vcall(list, LIST_ISADAPTERPREFERENCESUPPORTED, [FFIType.u32], [preference.value], FFIType.u8) !== 0).map((preference) => preference.label);
  const prefText = supported.length > 0 ? `${GREEN}${supported.join(', ')}${RESET}` : `${DIM}none${RESET}`;
  console.log(`  ${CYAN}${attribute.label.padEnd(20)}${RESET}${BOLD}${String(count).padEnd(10)}${RESET}${prefText}`);
  release(list);
}

// ── Section B: per-adapter dossier (union of graphics + core-compute) ─────────
const unionFilter = Buffer.concat([guid(DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS), guid(DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE)]);
const unionOut = Buffer.alloc(8);
const unionHr = vcall(factory, FACTORY_CREATEADAPTERLIST, [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], [2, unionFilter.ptr!, guid(IID_IDXCoreAdapterList).ptr!, unionOut.ptr!]);

if (unionHr !== S_OK) {
  console.log();
  console.log(`  ${YELLOW}ℹ${RESET} No D3D12 graphics/compute adapters to detail (CreateAdapterList → ${hex(unionHr)}).`);
  releaseAll();
  process.exit(0);
}
const unionList = take(unionOut);
const adapterCount = vcall(unionList, LIST_GETADAPTERCOUNT, [], [], FFIType.u32) >>> 0;

const LABEL_WIDTH = 26;
const field = (label: string, value: string): string => `    ${DIM}${label.padEnd(LABEL_WIDTH)}${RESET}${value}`;
const yesNo = (value: boolean): string => (value ? `${GREEN}yes${RESET}` : `${DIM}no${RESET}`);

for (let index = 0; index < adapterCount; index += 1) {
  const adapterOut = Buffer.alloc(8);
  vcall(unionList, LIST_GETADAPTER, [FFIType.u32, FFIType.ptr, FFIType.ptr], [index, guid(IID_IDXCoreAdapter).ptr!, adapterOut.ptr!]);
  const adapter = take(adapterOut);
  if (adapter === 0n) continue;

  const description = readProperty(adapter, DXCoreAdapterProperty.DriverDescription);
  const name = description ? description.toString('utf8').replace(/\0.*$/, '') : `Adapter ${index}`;

  console.log();
  console.log(`  ${BOLD}${CYAN}▌ Adapter ${index} — ${name}${RESET}`);
  console.log(`  ${DIM}${'─'.repeat(72)}${RESET}`);

  const luid = readProperty(adapter, DXCoreAdapterProperty.InstanceLuid);
  if (luid && luid.length >= 8) {
    console.log(field('Instance LUID', `0x${luid.readInt32LE(4).toString(16).padStart(8, '0')}:0x${luid.readUInt32LE(0).toString(16).padStart(8, '0')}`));
  }

  // Prefer DXCoreHardwareIDParts (20 bytes) over the legacy DXCoreHardwareID.
  const idParts = readProperty(adapter, DXCoreAdapterProperty.HardwareIDParts);
  const legacyId = readProperty(adapter, DXCoreAdapterProperty.HardwareID);
  if (idParts && idParts.length >= 20) {
    const vendorID = idParts.readUInt32LE(0);
    console.log(field('Vendor', `${vendorName(vendorID)} ${DIM}(0x${vendorID.toString(16).padStart(4, '0')})${RESET}`));
    console.log(field('Device ID', `0x${idParts.readUInt32LE(4).toString(16).padStart(4, '0')}`));
    console.log(field('Subsystem ID', `0x${idParts.readUInt32LE(8).toString(16).padStart(8, '0')}`));
    console.log(field('Subsystem vendor ID', `0x${idParts.readUInt32LE(12).toString(16).padStart(4, '0')}`));
    console.log(field('Revision', `0x${idParts.readUInt32LE(16).toString(16).padStart(2, '0')}`));
  } else if (legacyId && legacyId.length >= 16) {
    const vendorID = legacyId.readUInt32LE(0);
    console.log(field('Vendor', `${vendorName(vendorID)} ${DIM}(0x${vendorID.toString(16).padStart(4, '0')})${RESET}`));
    console.log(field('Device ID', `0x${legacyId.readUInt32LE(4).toString(16).padStart(4, '0')}`));
    console.log(field('Subsystem ID', `0x${legacyId.readUInt32LE(8).toString(16).padStart(8, '0')}`));
    console.log(field('Revision', `0x${legacyId.readUInt32LE(12).toString(16).padStart(2, '0')}`));
  }

  const driverVersion = readProperty(adapter, DXCoreAdapterProperty.DriverVersion);
  if (driverVersion && driverVersion.length >= 8) {
    const raw = driverVersion.readBigUInt64LE(0);
    const part = (shift: bigint): number => Number((raw >> shift) & 0xffffn);
    console.log(field('Driver version', `${part(48n)}.${part(32n)}.${part(16n)}.${part(0n)} ${DIM}(0x${raw.toString(16).padStart(16, '0')})${RESET}`));
  }

  const kmd = readProperty(adapter, DXCoreAdapterProperty.KmdModelVersion);
  if (kmd && kmd.length >= 4) {
    const value = kmd.readUInt32LE(0);
    console.log(field('Driver model', `WDDM ${value >> 12}.${(value >> 8) & 0xf} ${DIM}(0x${value.toString(16).padStart(4, '0')})${RESET}`));
  }

  const graphicsPreemption = readProperty(adapter, DXCoreAdapterProperty.GraphicsPreemptionGranularity);
  if (graphicsPreemption && graphicsPreemption.length >= 4) {
    const value = graphicsPreemption.readUInt32LE(0);
    console.log(field('Graphics preemption', `${GRAPHICS_PREEMPTION[value] ?? 'unknown'} ${DIM}(${value})${RESET}`));
  }
  const computePreemption = readProperty(adapter, DXCoreAdapterProperty.ComputePreemptionGranularity);
  if (computePreemption && computePreemption.length >= 4) {
    const value = computePreemption.readUInt32LE(0);
    console.log(field('Compute preemption', `${COMPUTE_PREEMPTION[value] ?? 'unknown'} ${DIM}(${value})${RESET}`));
  }

  const dedicatedVram = readProperty(adapter, DXCoreAdapterProperty.DedicatedAdapterMemory);
  if (dedicatedVram) console.log(field('Dedicated video memory', humanBytes(dedicatedVram.readBigUInt64LE(0))));
  const dedicatedSystem = readProperty(adapter, DXCoreAdapterProperty.DedicatedSystemMemory);
  if (dedicatedSystem) console.log(field('Dedicated system memory', humanBytes(dedicatedSystem.readBigUInt64LE(0))));
  const sharedSystem = readProperty(adapter, DXCoreAdapterProperty.SharedSystemMemory);
  if (sharedSystem) console.log(field('Shared system memory', humanBytes(sharedSystem.readBigUInt64LE(0))));

  const isHardware = readProperty(adapter, DXCoreAdapterProperty.IsHardware);
  const isIntegrated = readProperty(adapter, DXCoreAdapterProperty.IsIntegrated);
  const isDetachable = readProperty(adapter, DXCoreAdapterProperty.IsDetachable);
  const acg = readProperty(adapter, DXCoreAdapterProperty.AcgCompatible);
  console.log(
    field(
      'Flags',
      `hardware ${yesNo(!!isHardware && isHardware[0] !== 0)}  ${DIM}·${RESET}  ` +
        `integrated ${yesNo(!!isIntegrated && isIntegrated[0] !== 0)}  ${DIM}·${RESET}  ` +
        `detachable ${yesNo(!!isDetachable && isDetachable[0] !== 0)}  ${DIM}·${RESET}  ` +
        `ACG ${yesNo(!!acg && acg[0] !== 0)}`,
    ),
  );

  const matrix = ATTRIBUTES.map((attribute) => `${attribute.label} ${attributeSupported(adapter, attribute.guid) ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`}`).join(`  ${DIM}·${RESET}  `);
  console.log(field('Attribute support', matrix));

  release(adapter);
}

const detailed = adapterCount;
release(unionList);
release(factory);
releaseAll();

console.log();
console.log(`  ${BOLD}${detailed}${RESET} ${DIM}adapter${detailed === 1 ? '' : 's'} detailed${RESET}  ${DIM}•${RESET}  ${DIM}every value pulled live over dxcore.dll's COM vtable — no native addon${RESET}`);
console.log();

process.exit(0);
