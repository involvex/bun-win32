/**
 * Capture Radar
 *
 * A live, animated radar console that sweeps the legacy DirectShow capture
 * graph and "pings" every video/audio capture device it discovers — all over
 * pure FFI, nothing shells out. A rotating ASCII sweep line paints the screen
 * each frame; as the beam passes each device's bearing the device lights up
 * with a signal blip whose strength is derived from how far its source filter
 * gets when bound into a real `quartz.dll` filter graph (moniker resolved →
 * IPropertyBag opened → IBaseFilter bound → added to the graph → output pins
 * counted). Every transition is narrated, and every HRESULT that comes back is
 * decoded *live* through `quartz.dll`'s own `AMGetErrorTextW` so the radar
 * speaks DirectShow's native error vocabulary.
 *
 * The filter graph itself is materialized from `quartz.dll`'s `CLSID_FilterGraph`
 * COM server via the bound `DllGetClassObject` export and an
 * `IClassFactory::CreateInstance` call — no `CoCreateInstance` for the graph.
 *
 * APIs demonstrated (Quartz):
 *   - DllGetClassObject     (instantiate quartz.dll's CLSID_FilterGraph factory)
 *   - DllCanUnloadNow       (live server in-use telemetry, shown on the HUD)
 *   - AMGetErrorTextW       (decode every DirectShow HRESULT into radar chatter)
 *
 * APIs demonstrated (cross-package, raw dlopen):
 *   - ole32!CoInitializeEx / CoCreateInstance / CoUninitialize
 *   - oleaut32!VariantInit / VariantClear
 *   - kernel32!GetCurrentProcess / ReadProcessMemory / GetStdHandle /
 *     GetConsoleMode / SetConsoleMode
 *
 * COM interfaces driven through their vtables:
 *   - IClassFactory::CreateInstance / ICreateDevEnum::CreateClassEnumerator
 *   - IEnumMoniker::Next / IMoniker::BindToStorage / IMoniker::BindToObject
 *   - IPropertyBag::Read / IGraphBuilder::AddFilter
 *   - IBaseFilter::EnumPins / IEnumPins::Next / IUnknown::Release
 *
 * Run: bun run example:capture-radar
 */

import { FFIType, dlopen, linkSymbols } from 'bun:ffi';

import Quartz from '../index';

const ANSI = {
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  white: '\x1b[97m',
  yellow: '\x1b[33m',
} as const;

const COINIT_APARTMENTTHREADED = 0x2;
const CLSCTX_INPROC_SERVER = 0x1;
const POINTER_SIZE = 8;
const S_FALSE = 0x0000_0001;
const RPC_E_CHANGED_MODE = 0x8001_0106 >>> 0;
const MAX_ERROR_TEXT_LEN = 160;

const CLSID_SYSTEM_DEVICE_ENUM = '62be5d10-60eb-11d0-bd3b-00a0c911ce86';
const CLSID_FILTER_GRAPH = 'e436ebb3-524f-11ce-9f53-0020af0ba770';
const CLSID_VIDEO_INPUT_CATEGORY = '860bb310-5d01-11d0-bd3b-00a0c911ce86';
const CLSID_AUDIO_INPUT_CATEGORY = '33d9a762-90c8-11d0-bd43-00a0c911ce86';
const IID_ICREATE_DEV_ENUM = '29840822-5b84-11d0-bd3b-00a0c911ce86';
const IID_ICLASS_FACTORY = '00000001-0000-0000-c000-000000000046';
const IID_IGRAPH_BUILDER = '56a868a9-0ad4-11ce-b03a-0020af0ba770';
const IID_IBASE_FILTER = '56a86895-0ad4-11ce-b03a-0020af0ba770';
const IID_IPROPERTY_BAG = '55272a00-42cb-11ce-8135-00aa004bb851';

// Authoritative vtable slot offsets (slot * 8) from objidl.h / strmif.h.
const RELEASE_OFFSET = 0x10; // IUnknown slot 2
const CLASSFACTORY_CREATEINSTANCE_OFFSET = 0x18; // IClassFactory slot 3
const CREATE_CLASS_ENUMERATOR_OFFSET = 0x18; // ICreateDevEnum slot 3
const ENUMMONIKER_NEXT_OFFSET = 0x18; // IEnumMoniker slot 3
const MONIKER_BIND_TO_OBJECT_OFFSET = 0x40; // IMoniker slot 8
const MONIKER_BIND_TO_STORAGE_OFFSET = 0x48; // IMoniker slot 9
const PROPERTYBAG_READ_OFFSET = 0x18; // IPropertyBag slot 3
const IFILTERGRAPH_ADDFILTER_OFFSET = 0x18; // IFilterGraph slot 3
const BASEFILTER_ENUMPINS_OFFSET = 0x50; // IBaseFilter slot 10
const ENUMPINS_NEXT_OFFSET = 0x18; // IEnumPins slot 3

const kernel32 = dlopen('kernel32.dll', {
  GetConsoleMode: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  GetCurrentProcess: { args: [], returns: FFIType.u64 },
  GetStdHandle: { args: [FFIType.u32], returns: FFIType.u64 },
  ReadProcessMemory: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  SetConsoleMode: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
});

const ole32 = dlopen('ole32.dll', {
  CoCreateInstance: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CoUninitialize: { args: [], returns: FFIType.void },
});

const oleaut32 = dlopen('oleaut32.dll', {
  VariantClear: { args: [FFIType.ptr], returns: FFIType.i32 },
  VariantInit: { args: [FFIType.ptr], returns: FFIType.void },
});

const currentProcess = kernel32.symbols.GetCurrentProcess();

function enableVirtualTerminal(): void {
  const STD_OUTPUT_HANDLE = 0xffff_fff5;
  const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
  const handle = kernel32.symbols.GetStdHandle(STD_OUTPUT_HANDLE);
  const mode = Buffer.alloc(4);
  if (kernel32.symbols.GetConsoleMode(handle, mode.ptr) !== 0) {
    kernel32.symbols.SetConsoleMode(handle, mode.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  }
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
  if (kernel32.symbols.ReadProcessMemory(currentProcess, address, buffer.ptr, BigInt(POINTER_SIZE), null) === 0) {
    throw new Error(`ReadProcessMemory failed at 0x${address.toString(16)}`);
  }
  return buffer.readBigUInt64LE(0);
}

function readVtableMethod(objectAddress: bigint, methodOffset: number): bigint {
  return readPointerAt(readPointerAt(objectAddress) + BigInt(methodOffset));
}

function readWideStringAt(address: bigint, maxChars = 256): string {
  if (address === 0n) return '';
  const buffer = Buffer.alloc(maxChars * 2);
  if (kernel32.symbols.ReadProcessMemory(currentProcess, address, buffer.ptr, BigInt(buffer.length), null) === 0) return '';
  let end = 0;
  while (end < maxChars && buffer.readUInt16LE(end * 2) !== 0) end += 1;
  return buffer.toString('utf16le', 0, end * 2);
}

function release(objectAddress: bigint): void {
  if (objectAddress === 0n) return;
  const v = linkSymbols({ Release: { args: [FFIType.u64], ptr: readVtableMethod(objectAddress, RELEASE_OFFSET), returns: FFIType.u32 } });
  v.symbols.Release(objectAddress);
  v.close();
}

/** Decodes any DirectShow HRESULT to a short label via quartz.dll AMGetErrorTextW. */
function hresultText(hr: number): string {
  if (hr === 0) return 'S_OK';
  if (hr >>> 0 === S_FALSE) return 'S_FALSE';
  const buffer = Buffer.alloc(MAX_ERROR_TEXT_LEN * 2);
  const written = Quartz.AMGetErrorTextW(hr, buffer.ptr, MAX_ERROR_TEXT_LEN);
  const text =
    written > 0
      ? buffer
          .toString('utf16le', 0, written * 2)
          .replace(/[\r\n].*$/s, '')
          .trim()
      : '';
  return text || `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;
}

interface RadarContact {
  name: string;
  kind: 'video' | 'audio';
  bearing: number; // degrees on the scope
  strength: number; // 0..5 signal blip strength
  status: string; // decoded HRESULT chatter
  ok: boolean;
}

function readBagFriendlyName(propertyBagAddress: bigint): string {
  const read = linkSymbols({ Read: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u64], ptr: readVtableMethod(propertyBagAddress, PROPERTYBAG_READ_OFFSET), returns: FFIType.i32 } });
  const variant = Buffer.alloc(24); // VARIANT (x64); BSTR pointer lives at offset 8
  oleaut32.symbols.VariantInit(variant.ptr);
  const name = Buffer.from('FriendlyName\0', 'utf16le');
  let result = '';
  try {
    if (read.symbols.Read(propertyBagAddress, name.ptr, variant.ptr, 0n) === 0) {
      result = readWideStringAt(variant.readBigUInt64LE(8));
    }
  } finally {
    oleaut32.symbols.VariantClear(variant.ptr);
    read.close();
  }
  return result;
}

function countOutputPins(filterAddress: bigint): number {
  const enumPins = linkSymbols({ EnumPins: { args: [FFIType.u64, FFIType.ptr], ptr: readVtableMethod(filterAddress, BASEFILTER_ENUMPINS_OFFSET), returns: FFIType.i32 } });
  const enumOut = Buffer.alloc(POINTER_SIZE);
  let enumHr: number;
  try {
    enumHr = enumPins.symbols.EnumPins(filterAddress, enumOut.ptr);
  } finally {
    enumPins.close();
  }
  const enumAddress = enumHr === 0 ? enumOut.readBigUInt64LE(0) : 0n;
  if (enumAddress === 0n) return 0;
  const next = linkSymbols({ Next: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(enumAddress, ENUMPINS_NEXT_OFFSET), returns: FFIType.i32 } });
  let count = 0;
  try {
    for (let guard = 0; guard < 64; guard += 1) {
      const pinOut = Buffer.alloc(POINTER_SIZE);
      const fetched = Buffer.alloc(4);
      if (next.symbols.Next(enumAddress, 1, pinOut.ptr, fetched.ptr) !== 0 || fetched.readUInt32LE(0) === 0) break;
      const pinAddress = pinOut.readBigUInt64LE(0);
      if (pinAddress === 0n) break;
      count += 1;
      release(pinAddress);
    }
  } finally {
    next.close();
    release(enumAddress);
  }
  return count;
}

function createFilterGraph(): bigint {
  const factoryOut = Buffer.alloc(POINTER_SIZE);
  if (Quartz.DllGetClassObject(guidBytes(CLSID_FILTER_GRAPH).ptr, guidBytes(IID_ICLASS_FACTORY).ptr, factoryOut.ptr) !== 0) return 0n;
  const factoryAddress = factoryOut.readBigUInt64LE(0);
  if (factoryAddress === 0n) return 0n;
  const graphOut = Buffer.alloc(POINTER_SIZE);
  const factory = linkSymbols({ CreateInstance: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(factoryAddress, CLASSFACTORY_CREATEINSTANCE_OFFSET), returns: FFIType.i32 } });
  let graphAddress = 0n;
  try {
    if (factory.symbols.CreateInstance(factoryAddress, 0n, guidBytes(IID_IGRAPH_BUILDER).ptr, graphOut.ptr) === 0) {
      graphAddress = graphOut.readBigUInt64LE(0);
    }
  } finally {
    factory.close();
    release(factoryAddress);
  }
  return graphAddress;
}

/** Probes one device: bind moniker → name → graph → pins. Returns a contact. */
function probeDevice(monikerAddress: bigint, kind: 'video' | 'audio', bearing: number): RadarContact {
  const contact: RadarContact = { name: '(unknown)', kind, bearing, strength: 0, status: 'no return', ok: false };

  const bagOut = Buffer.alloc(POINTER_SIZE);
  const bindToStorage = linkSymbols({ BindToStorage: { args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(monikerAddress, MONIKER_BIND_TO_STORAGE_OFFSET), returns: FFIType.i32 } });
  const bagHr = bindToStorage.symbols.BindToStorage(monikerAddress, 0n, 0n, guidBytes(IID_IPROPERTY_BAG).ptr, bagOut.ptr);
  bindToStorage.close();
  const bagAddress = bagHr === 0 ? bagOut.readBigUInt64LE(0) : 0n;
  if (bagAddress !== 0n) {
    contact.name = readBagFriendlyName(bagAddress) || '(no name)';
    contact.strength = 1;
    release(bagAddress);
  } else {
    contact.status = hresultText(bagHr);
    return contact;
  }

  const graphAddress = createFilterGraph();
  if (graphAddress === 0n) {
    contact.status = 'no filter graph';
    return contact;
  }
  contact.strength = 2;

  try {
    const filterOut = Buffer.alloc(POINTER_SIZE);
    const bindToObject = linkSymbols({ BindToObject: { args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(monikerAddress, MONIKER_BIND_TO_OBJECT_OFFSET), returns: FFIType.i32 } });
    const filterHr = bindToObject.symbols.BindToObject(monikerAddress, 0n, 0n, guidBytes(IID_IBASE_FILTER).ptr, filterOut.ptr);
    bindToObject.close();
    const filterAddress = filterHr === 0 ? filterOut.readBigUInt64LE(0) : 0n;
    if (filterAddress === 0n) {
      contact.status = hresultText(filterHr);
      return contact;
    }
    contact.strength = 3;

    try {
      const wname = Buffer.from(`${contact.name}\0`, 'utf16le');
      const addFilter = linkSymbols({ AddFilter: { args: [FFIType.u64, FFIType.u64, FFIType.u64], ptr: readVtableMethod(graphAddress, IFILTERGRAPH_ADDFILTER_OFFSET), returns: FFIType.i32 } });
      const addHr = addFilter.symbols.AddFilter(graphAddress, filterAddress, BigInt(wname.ptr ?? 0));
      addFilter.close();
      contact.status = hresultText(addHr);
      if (addHr === 0) {
        contact.strength = 4;
        const pins = countOutputPins(filterAddress);
        if (pins > 0) contact.strength = 5;
        contact.status = `${hresultText(addHr)} · ${pins} pin${pins === 1 ? '' : 's'}`;
        contact.ok = true;
      }
    } finally {
      release(filterAddress);
    }
  } finally {
    release(graphAddress);
  }
  return contact;
}

function enumerateCategory(devEnumAddress: bigint, categoryGuid: string, kind: 'video' | 'audio'): bigint[] {
  const monikers: bigint[] = [];
  const enumOut = Buffer.alloc(POINTER_SIZE);
  const createEnum = linkSymbols({ CreateClassEnumerator: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32], ptr: readVtableMethod(devEnumAddress, CREATE_CLASS_ENUMERATOR_OFFSET), returns: FFIType.i32 } });
  let hr: number;
  try {
    hr = createEnum.symbols.CreateClassEnumerator(devEnumAddress, guidBytes(categoryGuid).ptr, enumOut.ptr, 0);
  } finally {
    createEnum.close();
  }
  const enumAddress = hr === 0 ? enumOut.readBigUInt64LE(0) : 0n;
  if (enumAddress === 0n) return monikers;
  const next = linkSymbols({ Next: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(enumAddress, ENUMMONIKER_NEXT_OFFSET), returns: FFIType.i32 } });
  try {
    for (let guard = 0; guard < 32; guard += 1) {
      const monikerOut = Buffer.alloc(POINTER_SIZE);
      const fetched = Buffer.alloc(4);
      if (next.symbols.Next(enumAddress, 1, monikerOut.ptr, fetched.ptr) !== 0 || fetched.readUInt32LE(0) === 0) break;
      const m = monikerOut.readBigUInt64LE(0);
      if (m === 0n) break;
      monikers.push(m);
    }
  } finally {
    next.close();
    release(enumAddress);
  }
  return monikers;
}

const sleep = (ms: number) => Bun.sleep(ms);
const RADIUS = 11;

/** Renders one full radar frame: a circular scope with a rotating sweep line. */
function renderScope(sweepAngle: number, contacts: RadarContact[], litUntil: Map<number, number>, frame: number): string[] {
  const lines: string[] = [];
  for (let y = -RADIUS; y <= RADIUS; y += 1) {
    let row = '';
    for (let x = -RADIUS; x <= RADIUS; x += 1) {
      const dist = Math.sqrt(x * x + y * 1.9 * (y * 1.9)) / 1; // y scaled for char aspect
      const radial = Math.sqrt(x * x + y * y * 3.6);
      const angle = (Math.atan2(-y, x) * 180) / Math.PI;
      const norm = (angle + 360) % 360;

      const contact = contacts.find((c) => Math.abs(((c.bearing - norm + 540) % 360) - 180) < 7 && radial > RADIUS * 0.42 && radial < RADIUS * 0.78);
      if (contact) {
        const lit = (litUntil.get(contact.bearing) ?? -1) >= frame;
        const glyph = contact.kind === 'video' ? '▣' : '◉';
        const color = !contact.ok ? ANSI.red : lit ? ANSI.white : contact.kind === 'video' ? ANSI.cyan : ANSI.magenta;
        row += `${lit ? ANSI.bold : ''}${color}${glyph}${ANSI.reset}`;
        continue;
      }

      const angleDelta = Math.abs(((norm - sweepAngle + 540) % 360) - 180);
      if (radial <= RADIUS * 0.92) {
        if (angleDelta < 6 && radial > 0.6) {
          row += `${ANSI.green}${ANSI.bold}/${ANSI.reset}`;
        } else if (angleDelta < 22 && radial > 0.6) {
          row += `${ANSI.green}${ANSI.dim}·${ANSI.reset}`;
        } else if (Math.abs(radial - RADIUS * 0.92) < 0.6) {
          row += `${ANSI.dim}${ANSI.green}o${ANSI.reset}`;
        } else if (radial < 0.7) {
          row += `${ANSI.green}${ANSI.bold}+${ANSI.reset}`;
        } else if ((Math.abs(radial - RADIUS * 0.46) < 0.5 || Math.abs(radial - RADIUS * 0.7) < 0.5) && Math.round(x) % 3 === 0) {
          row += `${ANSI.dim}${ANSI.green}.${ANSI.reset}`;
        } else {
          row += ' ';
        }
      } else {
        row += ' ';
      }
    }
    lines.push(row);
  }
  return lines;
}

function strengthBar(strength: number): string {
  const filled = '█'.repeat(strength);
  const empty = '░'.repeat(5 - strength);
  const color = strength >= 5 ? ANSI.green : strength >= 3 ? ANSI.yellow : ANSI.red;
  return `${color}${filled}${ANSI.dim}${empty}${ANSI.reset}`;
}

async function main(): Promise<void> {
  enableVirtualTerminal();
  const coInitHr = ole32.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  if (coInitHr < 0 && coInitHr >>> 0 !== RPC_E_CHANGED_MODE) {
    console.error(`${ANSI.red}CoInitializeEx failed: ${hresultText(coInitHr)}${ANSI.reset}`);
    process.exit(1);
  }

  process.stdout.write('\x1b[?25l'); // hide cursor

  const devEnumOut = Buffer.alloc(POINTER_SIZE);
  const ccHr = ole32.symbols.CoCreateInstance(guidBytes(CLSID_SYSTEM_DEVICE_ENUM).ptr, 0n, CLSCTX_INPROC_SERVER, guidBytes(IID_ICREATE_DEV_ENUM).ptr, devEnumOut.ptr);
  const devEnumAddress = ccHr === 0 ? devEnumOut.readBigUInt64LE(0) : 0n;
  if (devEnumAddress === 0n) {
    process.stdout.write('\x1b[?25h');
    console.error(`${ANSI.red}System Device Enumerator unavailable: ${hresultText(ccHr)}${ANSI.reset}`);
    if (coInitHr >= 0) ole32.symbols.CoUninitialize();
    process.exit(1);
  }

  const videoMonikers = enumerateCategory(devEnumAddress, CLSID_VIDEO_INPUT_CATEGORY, 'video');
  const audioMonikers = enumerateCategory(devEnumAddress, CLSID_AUDIO_INPUT_CATEGORY, 'audio');
  const all = [...videoMonikers.map((m) => ({ m, kind: 'video' as const })), ...audioMonikers.map((m) => ({ m, kind: 'audio' as const }))];

  // Probe each device once, assigning it a stable bearing around the scope.
  const contacts: RadarContact[] = [];
  all.forEach((entry, index) => {
    const bearing = all.length > 0 ? Math.round((index * 360) / all.length) : 0;
    contacts.push(probeDevice(entry.m, entry.kind, bearing));
  });
  all.forEach((entry) => release(entry.m));
  release(devEnumAddress);

  const litUntil = new Map<number, number>();
  const SWEEP_STEP = 11;
  const TOTAL_FRAMES = Math.ceil(360 / SWEEP_STEP) * 2;

  for (let frame = 0; frame < TOTAL_FRAMES; frame += 1) {
    const sweepAngle = (frame * SWEEP_STEP) % 360;
    // Light up any contact the beam just crossed.
    for (const c of contacts) {
      if (Math.abs(((c.bearing - sweepAngle + 540) % 360) - 180) < SWEEP_STEP / 1.4) {
        litUntil.set(c.bearing, frame + 6);
      }
    }

    const scope = renderScope(sweepAngle, contacts, litUntil, frame);
    const unloadHr = Quartz.DllCanUnloadNow();

    const out: string[] = [];
    out.push('');
    out.push(`  ${ANSI.bold}${ANSI.green}╔═ CAPTURE RADAR ═══════════════════════════════════════════════╗${ANSI.reset}`);
    out.push(
      `  ${ANSI.bold}${ANSI.green}║${ANSI.reset} ${ANSI.dim}quartz.dll DirectShow scope${ANSI.reset}   ` +
        `${ANSI.dim}sweep${ANSI.reset} ${ANSI.green}${String(sweepAngle).padStart(3)}°${ANSI.reset}   ` +
        `${ANSI.dim}server${ANSI.reset} ${unloadHr >>> 0 === S_FALSE ? `${ANSI.yellow}LIVE` : `${ANSI.green}idle`}${ANSI.reset}  ` +
        `${ANSI.bold}${ANSI.green}║${ANSI.reset}`,
    );
    out.push(`  ${ANSI.bold}${ANSI.green}╚═══════════════════════════════════════════════════════════════╝${ANSI.reset}`);

    const legendStart = Math.floor((scope.length - contacts.length) / 2);
    scope.forEach((scopeLine, i) => {
      let legend = '';
      const ci = i - legendStart;
      if (ci >= 0 && ci < contacts.length) {
        const c = contacts[ci];
        const lit = (litUntil.get(c.bearing) ?? -1) >= frame;
        const dot = c.kind === 'video' ? '▣' : '◉';
        const dotColor = !c.ok ? ANSI.red : lit ? `${ANSI.bold}${ANSI.white}` : c.kind === 'video' ? ANSI.cyan : ANSI.magenta;
        const name = c.name.length > 30 ? `${c.name.slice(0, 29)}…` : c.name.padEnd(30);
        legend = `   ${dotColor}${dot}${ANSI.reset} ${lit ? ANSI.bold : ''}${name}${ANSI.reset} ` + `${strengthBar(c.strength)} ` + `${ANSI.dim}${c.status}${ANSI.reset}`;
      }
      out.push(`   ${scopeLine}${legend}`);
    });

    const reached = contacts.filter((c) => c.ok).length;
    out.push('');
    out.push(
      `  ${ANSI.dim}contacts${ANSI.reset} ${ANSI.bold}${contacts.length}${ANSI.reset}   ` +
        `${ANSI.dim}graph-bound${ANSI.reset} ${ANSI.green}${ANSI.bold}${reached}${ANSI.reset}   ` +
        `${ANSI.dim}video${ANSI.reset} ${ANSI.cyan}${videoMonikers.length}${ANSI.reset}   ` +
        `${ANSI.dim}audio${ANSI.reset} ${ANSI.magenta}${audioMonikers.length}${ANSI.reset}`,
    );

    // Repaint in place: home cursor, draw, clear to end of screen.
    process.stdout.write(`\x1b[H${out.join('\n')}\x1b[0J`);
    await sleep(60);
  }

  process.stdout.write('\x1b[?25h\n'); // restore cursor
  console.log(`  ${ANSI.green}${ANSI.bold}✓ Sweep complete — ${contacts.filter((c) => c.ok).length}/${contacts.length} capture sources locked into a live filter graph${ANSI.reset}\n`);

  if (coInitHr >= 0) ole32.symbols.CoUninitialize();
  ole32.close();
  oleaut32.close();
  kernel32.close();
}

main();
