/**
 * GPU Constellation
 *
 * Lights up every graphics-and-compute adapter DXCore can see — discrete GPUs,
 * integrated parts, the software render driver, and headless compute-only MCDM
 * devices — as a glowing terminal "constellation", entirely over Bun FFI with
 * no native addon. `dxcore.dll` exports exactly one flat function; everything
 * after it (the adapter factory, the adapter list, every per-adapter property)
 * is hand-walked over the COM vtable. Each adapter is drawn as a vendor-tinted
 * silicon die with an animated VRAM bar that charges up, plus a star plotted
 * into a twinkling sky sized by its dedicated video memory. Nothing touches
 * disk; every COM object is released on the way out.
 *
 * Pipeline (every step after the first is a COM vtable call):
 *
 *   1. Dxcore.DXCoreCreateAdapterFactory             — the one flat dxcore.dll export
 *   2. IDXCoreAdapterFactory::CreateAdapterList       — filter by D3D12 graphics + core-compute
 *   3. IDXCoreAdapterList::GetAdapterCount / GetAdapter
 *   4. IDXCoreAdapter::IsAttributeSupported           — graphics vs compute-only
 *   5. IDXCoreAdapter::GetPropertySize / GetProperty  — name, hardware id, memory, flags
 *   6. IUnknown::Release                              — release every COM object
 *
 * APIs demonstrated (Dxcore):
 *   - DXCoreCreateAdapterFactory                      (bootstrap the adapter factory)
 *   - IDXCoreAdapterFactory::CreateAdapterList        (attribute-filtered enumeration)
 *   - IDXCoreAdapterList::GetAdapterCount / GetAdapter
 *   - IDXCoreAdapter::IsAttributeSupported / GetPropertySize / GetProperty
 *   - IUnknown::Release                               (release every COM object)
 *
 * Run: bun run example/gpu-constellation.ts
 */

import { CFunction, FFIType, type Pointer, read } from 'bun:ffi';

import Dxcore, { DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE, DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS, DXCoreAdapterProperty, IID_IDXCoreAdapter, IID_IDXCoreAdapterFactory, IID_IDXCoreAdapterList } from '../index';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREY = '\x1b[90m';
const WHITE = '\x1b[97m';
const YELLOW = '\x1b[93m';

const S_OK = 0;

// IUnknown(0..2) then declaration order from dxcore_interface.h.
const IUNKNOWN_RELEASE = 2;
const FACTORY_CREATEADAPTERLIST = 3;
const LIST_GETADAPTER = 3;
const LIST_GETADAPTERCOUNT = 4;
const ADAPTER_ISATTRIBUTESUPPORTED = 4;
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
 * per (method pointer, signature) so enumeration loops stay cheap.
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

function releaseAll(): void {
  for (const obj of liveObjects.splice(0).reverse()) vcall(obj, IUNKNOWN_RELEASE, [], [], FFIType.u32);
}

/** Reads a fixed-size adapter property into a freshly allocated buffer. */
function getProperty(adapter: bigint, property: DXCoreAdapterProperty, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  vcall(adapter, ADAPTER_GETPROPERTY, [FFIType.u32, FFIType.u64, FFIType.ptr], [property, BigInt(size), buffer.ptr!]);
  return buffer;
}

/** Reads a variable-size string property (DriverDescription is a UTF-8 char[]). */
function getStringProperty(adapter: bigint, property: DXCoreAdapterProperty): string {
  const sizeBuffer = Buffer.alloc(8);
  vcall(adapter, ADAPTER_GETPROPERTYSIZE, [FFIType.u32, FFIType.ptr], [property, sizeBuffer.ptr!]);
  const size = Number(sizeBuffer.readBigUInt64LE(0));
  if (size <= 0) return '';
  return getProperty(adapter, property, size).toString('utf8').replace(/\0.*$/, '');
}

function attributeSupported(adapter: bigint, attribute: string): boolean {
  return vcall(adapter, ADAPTER_ISATTRIBUTESUPPORTED, [FFIType.ptr], [guid(attribute).ptr!], FFIType.u8) !== 0;
}

interface Vendor {
  color: string;
  name: string;
}

// PCI-SIG vendor IDs (DXCoreHardwareID.vendorID).
function vendorOf(vendorID: number): Vendor {
  switch (vendorID) {
    case 0x10de:
      return { color: '\x1b[92m', name: 'NVIDIA' };
    case 0x1002:
    case 0x1022:
      return { color: '\x1b[91m', name: 'AMD' };
    case 0x8086:
      return { color: '\x1b[94m', name: 'Intel' };
    case 0x1414:
      return { color: GREY, name: 'Microsoft' };
    case 0x5143:
      return { color: '\x1b[95m', name: 'Qualcomm' };
    case 0x15ad:
      return { color: '\x1b[96m', name: 'VMware' };
    case 0x1ab8:
    case 0x1af4:
      return { color: '\x1b[96m', name: 'Virtio' };
    default:
      return { color: YELLOW, name: `0x${vendorID.toString(16).padStart(4, '0')}` };
  }
}

function humanBytes(value: bigint): string {
  if (value <= 0n) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = Number(value);
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled < 10 && unit > 0 ? 2 : 0)} ${units[unit]}`;
}

interface AdapterCard {
  acg: boolean;
  computeOnly: boolean;
  detachable: boolean;
  hardware: boolean;
  integrated: boolean;
  name: string;
  sharedMemory: bigint;
  vendor: Vendor;
  vram: bigint;
}

console.log();
console.log(`${BOLD}${CYAN}  ☉ GPU Constellation${RESET}  ${DIM}— every DXCore adapter, charted over pure FFI${RESET}`);
console.log();

const factoryOut = Buffer.alloc(8);
const factoryHr = Dxcore.DXCoreCreateAdapterFactory(guid(IID_IDXCoreAdapterFactory).ptr!, factoryOut.ptr!);
if (factoryHr !== S_OK) {
  console.log(`  ${YELLOW}ℹ${RESET} DXCoreCreateAdapterFactory failed (${hex(factoryHr)}).`);
  process.exit(0);
}
const factory = take(factoryOut);

// DXCore has no "all adapters" call — you enumerate by attribute. The union of
// D3D12 graphics + D3D12 core-compute covers every GPU plus headless MCDM parts.
const filterAttributes = Buffer.concat([guid(DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS), guid(DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE)]);
const listOut = Buffer.alloc(8);
const listHr = vcall(factory, FACTORY_CREATEADAPTERLIST, [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], [2, filterAttributes.ptr!, guid(IID_IDXCoreAdapterList).ptr!, listOut.ptr!]);
if (listHr !== S_OK) {
  console.log(`  ${YELLOW}ℹ${RESET} No D3D12 graphics/compute adapters on this host (CreateAdapterList → ${hex(listHr)}).`);
  releaseAll();
  process.exit(0);
}
const list = take(listOut);

const adapterCount = vcall(list, LIST_GETADAPTERCOUNT, [], [], FFIType.u32) >>> 0;
const cards: AdapterCard[] = [];

for (let index = 0; index < adapterCount; index += 1) {
  const adapterOut = Buffer.alloc(8);
  vcall(list, LIST_GETADAPTER, [FFIType.u32, FFIType.ptr, FFIType.ptr], [index, guid(IID_IDXCoreAdapter).ptr!, adapterOut.ptr!]);
  const adapter = take(adapterOut);
  if (adapter === 0n) continue;

  // DXCoreHardwareID { uint32 vendorID, deviceID, subSysID, revision } — 16 bytes.
  const hardwareID = getProperty(adapter, DXCoreAdapterProperty.HardwareID, 16);
  const vendor = vendorOf(hardwareID.readUInt32LE(0));

  cards.push({
    acg: getProperty(adapter, DXCoreAdapterProperty.AcgCompatible, 1)[0] !== 0,
    computeOnly: !attributeSupported(adapter, DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS),
    detachable: getProperty(adapter, DXCoreAdapterProperty.IsDetachable, 1)[0] !== 0,
    hardware: getProperty(adapter, DXCoreAdapterProperty.IsHardware, 1)[0] !== 0,
    integrated: getProperty(adapter, DXCoreAdapterProperty.IsIntegrated, 1)[0] !== 0,
    name: getStringProperty(adapter, DXCoreAdapterProperty.DriverDescription),
    sharedMemory: getProperty(adapter, DXCoreAdapterProperty.SharedSystemMemory, 8).readBigUInt64LE(0),
    vendor,
    vram: getProperty(adapter, DXCoreAdapterProperty.DedicatedAdapterMemory, 8).readBigUInt64LE(0),
  });
}

releaseAll();

if (cards.length === 0) {
  console.log(`  ${YELLOW}ℹ${RESET} DXCore reported zero adapters on this host.`);
  process.exit(0);
}

const maxVram = cards.reduce((max, card) => (card.vram > max ? card.vram : max), 1n);

// ── Constellation sky: each adapter is a star sized by dedicated VRAM ────────
const SKY_WIDTH = Math.min(Math.max((process.stdout.columns ?? 80) - 4, 40), 76);
const SKY_HEIGHT = 7;
const sky: string[][] = Array.from({ length: SKY_HEIGHT }, () => Array.from({ length: SKY_WIDTH }, () => ' '));

// Faint background field so the bright adapters read as a constellation.
for (let i = 0; i < SKY_WIDTH; i += 1) {
  const y = (i * 7 + 3) % SKY_HEIGHT;
  if ((i * 13) % 11 === 0) sky[y][i] = `${GREY}·${RESET}`;
}

cards.forEach((card, index) => {
  const x = cards.length === 1 ? Math.floor(SKY_WIDTH / 2) : Math.round((index / (cards.length - 1)) * (SKY_WIDTH - 5)) + 2;
  const fraction = Number(card.vram) / Number(maxVram);
  const y = Math.max(0, Math.min(SKY_HEIGHT - 1, SKY_HEIGHT - 1 - Math.round(fraction * (SKY_HEIGHT - 1))));
  const glyph = card.vram >= maxVram / 2n ? '★' : card.vram > 0n ? '✦' : '✧';
  sky[y][x] = `${card.vendor.color}${BOLD}${glyph}${RESET}`;
  if (x + 1 < SKY_WIDTH) sky[y][x + 1] = `${card.vendor.color}${DIM}∴${RESET}`;
});

// Twinkle the sky in over a few frames, then settle.
for (let frame = 0; frame < 3; frame += 1) {
  process.stdout.write('\x1b[s');
  for (const row of sky) console.log(`  ${row.map((cell) => (frame === 2 || Math.random() > 0.25 ? cell : cell === ' ' ? ' ' : `${GREY}·${RESET}`)).join('')}`);
  if (frame < 2) {
    Bun.sleepSync(110);
    process.stdout.write('\x1b[u\x1b[J');
  }
}
console.log();

// ── Adapter cards: silicon die + charging VRAM bar ───────────────────────────
const BAR_WIDTH = 28;

for (const card of cards) {
  const tags: string[] = [];
  tags.push(card.hardware ? `${WHITE}HARDWARE${RESET}` : `${GREY}SOFTWARE${RESET}`);
  tags.push(card.computeOnly ? `${YELLOW}COMPUTE-ONLY MCDM${RESET}` : `${CYAN}GRAPHICS${RESET}`);
  if (card.integrated) tags.push(`${DIM}INTEGRATED${RESET}`);
  else if (card.hardware) tags.push(`${DIM}DISCRETE${RESET}`);
  if (card.detachable) tags.push(`${DIM}DETACHABLE${RESET}`);
  if (card.acg) tags.push(`${DIM}ACG${RESET}`);

  const fraction = Number(card.vram) / Number(maxVram);
  const filled = Math.round(fraction * BAR_WIDTH);

  const die = [
    `${card.vendor.color}┌───────────┐${RESET}`,
    `${card.vendor.color}│ ▟▙▟▙ ▟▙▟▙ │${RESET}`,
    `${card.vendor.color}│ ▜▛${WHITE}████${card.vendor.color}▜▛ │${RESET}`,
    `${card.vendor.color}│ ▟▙${WHITE}████${card.vendor.color}▟▙ │${RESET}`,
    `${card.vendor.color}│ ▜▛▜▛ ▜▛▜▛ │${RESET}`,
    `${card.vendor.color}└──┬┬┬┬┬┬┬──┘${RESET}`,
  ];

  console.log(`  ${die[0]}  ${card.vendor.color}${BOLD}${card.name}${RESET}`);
  console.log(`  ${die[1]}  ${DIM}vendor${RESET} ${card.vendor.color}${card.vendor.name}${RESET}   ${tags.join(`${DIM} · ${RESET}`)}`);
  console.log(`  ${die[2]}  ${DIM}dedicated VRAM${RESET}  ${card.vendor.color}${humanBytes(card.vram).padStart(9)}${RESET}`);

  // Animate the VRAM bar charging up.
  for (let step = 0; step <= filled; step += Math.max(1, Math.ceil(BAR_WIDTH / 14))) {
    const bar = `${card.vendor.color}${'█'.repeat(step)}${RESET}${GREY}${'░'.repeat(BAR_WIDTH - step)}${RESET}`;
    process.stdout.write(`\r  ${die[3]}  [${bar}] ${WHITE}${Math.round((step / BAR_WIDTH) * 100)
      .toString()
      .padStart(3)}%${RESET}\x1b[K`);
    Bun.sleepSync(16);
  }
  const bar = `${card.vendor.color}${'█'.repeat(filled)}${RESET}${GREY}${'░'.repeat(BAR_WIDTH - filled)}${RESET}`;
  process.stdout.write(`\r  ${die[3]}  [${bar}] ${WHITE}${Math.round(fraction * 100)
    .toString()
    .padStart(3)}%${RESET}\x1b[K\n`);

  console.log(`  ${die[4]}  ${DIM}shared system memory${RESET} ${humanBytes(card.sharedMemory)}`);
  console.log(`  ${die[5]}`);
  console.log();
}

const totalVram = cards.reduce((sum, card) => sum + card.vram, 0n);
const hardwareCount = cards.filter((card) => card.hardware).length;
const computeOnlyCount = cards.filter((card) => card.computeOnly).length;

console.log(
  `  ${BOLD}${cards.length}${RESET} ${DIM}adapter${cards.length === 1 ? '' : 's'}${RESET}` +
    `  ${DIM}•${RESET}  ${BOLD}${hardwareCount}${RESET} ${DIM}hardware${RESET}` +
    `  ${DIM}•${RESET}  ${BOLD}${computeOnlyCount}${RESET} ${DIM}compute-only${RESET}` +
    `  ${DIM}•${RESET}  ${CYAN}${humanBytes(totalVram)}${RESET} ${DIM}total dedicated VRAM${RESET}`,
);
console.log(`  ${DIM}Charted purely over dxcore.dll's COM vtable — no native addon, nothing written to disk.${RESET}`);
console.log();
