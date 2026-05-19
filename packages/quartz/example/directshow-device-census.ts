/**
 * DirectShow Device Census
 *
 * An exhaustive, richly-formatted diagnostic that walks the legacy DirectShow
 * stack end-to-end over pure FFI. It resolves the System Device Enumerator,
 * then enumerates every video- and audio-capture moniker on the machine,
 * reading each device's FriendlyName, DevicePath and (where present)
 * Description straight out of its `IPropertyBag`. For every video capture
 * device it instantiates `quartz.dll`'s own `CLSID_FilterGraph` COM server
 * — resolved through the bound `DllGetClassObject` export and an
 * `IClassFactory::CreateInstance` call — binds the source filter into the
 * graph with `IGraphBuilder::AddFilter`, and walks the filter's output pins
 * via `IBaseFilter::EnumPins` to report the live capture topology. Every
 * HRESULT is decoded by name through `quartz.dll`'s `AMGetErrorTextW`.
 *
 * APIs demonstrated (Quartz):
 *   - DllGetClassObject     (resolve quartz.dll's CLSID_FilterGraph factory)
 *   - DllCanUnloadNow       (COM unload probe, before and after live objects)
 *   - AMGetErrorTextW       (decode every DirectShow HRESULT to text)
 *
 * APIs demonstrated (cross-package, raw dlopen):
 *   - ole32!CoInitializeEx / CoCreateInstance / CoTaskMemFree / CoUninitialize
 *   - oleaut32!VariantInit / VariantClear / SysFreeString
 *   - kernel32!GetCurrentProcess / ReadProcessMemory / GetStdHandle /
 *     GetConsoleMode / SetConsoleMode
 *
 * COM interfaces driven through their vtables (no marshaling helpers):
 *   - IClassFactory::CreateInstance      (materialize an IGraphBuilder)
 *   - ICreateDevEnum::CreateClassEnumerator
 *   - IEnumMoniker::Next
 *   - IMoniker::BindToStorage            (open the device's IPropertyBag)
 *   - IPropertyBag::Read                 (FriendlyName / DevicePath / Description)
 *   - IMoniker::BindToObject             (bind the moniker to an IBaseFilter)
 *   - IGraphBuilder::AddFilter           (add the source into the filter graph)
 *   - IBaseFilter::EnumPins / IEnumPins::Next / IPin::QueryPinInfo / QueryDirection
 *   - IUnknown::Release                  (full release chain)
 *
 * Run: bun run example:directshow-device-census
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
  yellow: '\x1b[33m',
} as const;

const COINIT_APARTMENTTHREADED = 0x2;
const CLSCTX_INPROC_SERVER = 0x1;
const POINTER_SIZE = 8;
const S_FALSE = 0x0000_0001;
const RPC_E_CHANGED_MODE = 0x8001_0106 >>> 0;
const MAX_ERROR_TEXT_LEN = 160;

// Well-known DirectShow GUIDs (shared/uuids.h, devenum.idl, axextend.idl).
const CLSID_SYSTEM_DEVICE_ENUM = '62be5d10-60eb-11d0-bd3b-00a0c911ce86';
const CLSID_FILTER_GRAPH = 'e436ebb3-524f-11ce-9f53-0020af0ba770';
const CLSID_VIDEO_INPUT_CATEGORY = '860bb310-5d01-11d0-bd3b-00a0c911ce86';
const CLSID_AUDIO_INPUT_CATEGORY = '33d9a762-90c8-11d0-bd43-00a0c911ce86';
const IID_ICREATE_DEV_ENUM = '29840822-5b84-11d0-bd3b-00a0c911ce86';
const IID_ICLASS_FACTORY = '00000001-0000-0000-c000-000000000046';
const IID_IGRAPH_BUILDER = '56a868a9-0ad4-11ce-b03a-0020af0ba770';
const IID_IBASE_FILTER = '56a86895-0ad4-11ce-b03a-0020af0ba770';
const IID_IPROPERTY_BAG = '55272a00-42cb-11ce-8135-00aa004bb851';

// IUnknown / IClassFactory / ICreateDevEnum / IEnumMoniker / IMoniker /
// IPropertyBag / IGraphBuilder (IFilterGraph) / IBaseFilter / IEnumPins / IPin
// vtable slot offsets (in bytes; slot * 8) from their respective IDLs.
const RELEASE_OFFSET = 0x10; // IUnknown slot 2
const CLASSFACTORY_CREATEINSTANCE_OFFSET = 0x18; // IClassFactory slot 3
const CREATE_CLASS_ENUMERATOR_OFFSET = 0x18; // ICreateDevEnum slot 3
const ENUMMONIKER_NEXT_OFFSET = 0x18; // IEnumMoniker slot 3
const MONIKER_BIND_TO_OBJECT_OFFSET = 0x40; // IMoniker slot 8 (after IPersistStream)
const MONIKER_BIND_TO_STORAGE_OFFSET = 0x48; // IMoniker slot 9
const PROPERTYBAG_READ_OFFSET = 0x18; // IPropertyBag slot 3
const IFILTERGRAPH_ADDFILTER_OFFSET = 0x18; // IFilterGraph slot 3
const BASEFILTER_ENUMPINS_OFFSET = 0x50; // IBaseFilter slot 10 (after IMediaFilter)
const ENUMPINS_NEXT_OFFSET = 0x18; // IEnumPins slot 3
const PIN_QUERYPININFO_OFFSET = 0x40; // IPin slot 8
const PIN_QUERYDIRECTION_OFFSET = 0x48; // IPin slot 9

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
  CoTaskMemFree: { args: [FFIType.u64], returns: FFIType.void },
  CoUninitialize: { args: [], returns: FFIType.void },
});

const oleaut32 = dlopen('oleaut32.dll', {
  SysFreeString: { args: [FFIType.u64], returns: FFIType.void },
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

function readWideStringAt(address: bigint, maxChars = 512): string {
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

/** Decodes any DirectShow HRESULT to text via quartz.dll's own AMGetErrorTextW. */
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
  return `0x${(hr >>> 0).toString(16).padStart(8, '0')}${text ? ` — ${text}` : ''}`;
}

interface CaptureDevice {
  friendlyName: string;
  devicePath: string;
  description: string;
  pins: { name: string; direction: 'input' | 'output' }[];
  graphHr: number | null;
}

/** Reads one named string property out of a device moniker's IPropertyBag. */
function readBagString(propertyBagAddress: bigint, name: string): string {
  const readPtr = readVtableMethod(propertyBagAddress, PROPERTYBAG_READ_OFFSET);
  const read = linkSymbols({ Read: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u64], ptr: readPtr, returns: FFIType.i32 } });
  // VARIANT is 24 bytes on x64; SysAllocString'd BSTR pointer sits at offset 8.
  const variant = Buffer.alloc(24);
  oleaut32.symbols.VariantInit(variant.ptr);
  const wname = Buffer.from(`${name}\0`, 'utf16le');
  let result = '';
  try {
    if (read.symbols.Read(propertyBagAddress, wname.ptr, variant.ptr, 0n) === 0) {
      const bstr = variant.readBigUInt64LE(8);
      result = readWideStringAt(bstr);
    }
  } finally {
    oleaut32.symbols.VariantClear(variant.ptr);
    read.close();
  }
  return result;
}

/** Enumerates the output pins of a source IBaseFilter that is in the graph. */
function enumeratePins(filterAddress: bigint): { name: string; direction: 'input' | 'output' }[] {
  const pins: { name: string; direction: 'input' | 'output' }[] = [];
  const enumPins = linkSymbols({ EnumPins: { args: [FFIType.u64, FFIType.ptr], ptr: readVtableMethod(filterAddress, BASEFILTER_ENUMPINS_OFFSET), returns: FFIType.i32 } });
  const enumOut = Buffer.alloc(POINTER_SIZE);
  try {
    if (enumPins.symbols.EnumPins(filterAddress, enumOut.ptr) !== 0) return pins;
  } finally {
    enumPins.close();
  }
  const enumAddress = enumOut.readBigUInt64LE(0);
  if (enumAddress === 0n) return pins;

  const next = linkSymbols({ Next: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(enumAddress, ENUMPINS_NEXT_OFFSET), returns: FFIType.i32 } });
  try {
    for (let guard = 0; guard < 64; guard += 1) {
      const pinOut = Buffer.alloc(POINTER_SIZE);
      const fetched = Buffer.alloc(4);
      const hr = next.symbols.Next(enumAddress, 1, pinOut.ptr, fetched.ptr);
      if (hr !== 0 || fetched.readUInt32LE(0) === 0) break;
      const pinAddress = pinOut.readBigUInt64LE(0);
      if (pinAddress === 0n) break;

      const dirBuf = Buffer.alloc(4);
      const queryDirection = linkSymbols({ QueryDirection: { args: [FFIType.u64, FFIType.ptr], ptr: readVtableMethod(pinAddress, PIN_QUERYDIRECTION_OFFSET), returns: FFIType.i32 } });
      queryDirection.symbols.QueryDirection(pinAddress, dirBuf.ptr);
      queryDirection.close();
      const direction: 'input' | 'output' = dirBuf.readUInt32LE(0) === 0 ? 'input' : 'output';

      // PIN_INFO: IBaseFilter* (8) + PIN_DIRECTION (4) + WCHAR achName[128].
      const pinInfo = Buffer.alloc(8 + 4 + 128 * 2);
      const queryPinInfo = linkSymbols({ QueryPinInfo: { args: [FFIType.u64, FFIType.ptr], ptr: readVtableMethod(pinAddress, PIN_QUERYPININFO_OFFSET), returns: FFIType.i32 } });
      let pinName = '';
      if (queryPinInfo.symbols.QueryPinInfo(pinAddress, pinInfo.ptr) === 0) {
        const owner = pinInfo.readBigUInt64LE(0);
        let end = 12;
        while (end < pinInfo.length && pinInfo.readUInt16LE(end) !== 0) end += 2;
        pinName = pinInfo.toString('utf16le', 12, end);
        if (owner !== 0n) release(owner);
      }
      queryPinInfo.close();
      pins.push({ name: pinName || '(unnamed)', direction });
      release(pinAddress);
    }
  } finally {
    next.close();
    release(enumAddress);
  }
  return pins;
}

/** Builds a quartz.dll IGraphBuilder via the bound DllGetClassObject export. */
function createFilterGraph(): bigint {
  const clsid = guidBytes(CLSID_FILTER_GRAPH);
  const iidClassFactory = guidBytes(IID_ICLASS_FACTORY);
  const factoryOut = Buffer.alloc(POINTER_SIZE);
  if (Quartz.DllGetClassObject(clsid.ptr, iidClassFactory.ptr, factoryOut.ptr) !== 0) return 0n;
  const factoryAddress = factoryOut.readBigUInt64LE(0);
  if (factoryAddress === 0n) return 0n;

  const iidGraph = guidBytes(IID_IGRAPH_BUILDER);
  const graphOut = Buffer.alloc(POINTER_SIZE);
  const factory = linkSymbols({
    CreateInstance: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(factoryAddress, CLASSFACTORY_CREATEINSTANCE_OFFSET), returns: FFIType.i32 },
  });
  let graphAddress = 0n;
  try {
    if (factory.symbols.CreateInstance(factoryAddress, 0n, iidGraph.ptr, graphOut.ptr) === 0) {
      graphAddress = graphOut.readBigUInt64LE(0);
    }
  } finally {
    factory.close();
    release(factoryAddress);
  }
  return graphAddress;
}

/** Enumerates one device category through the System Device Enumerator. */
function enumerateCategory(devEnumAddress: bigint, categoryGuid: string, buildGraphs: boolean): CaptureDevice[] {
  const devices: CaptureDevice[] = [];
  const category = guidBytes(categoryGuid);
  const enumOut = Buffer.alloc(POINTER_SIZE);
  const createEnum = linkSymbols({
    CreateClassEnumerator: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32], ptr: readVtableMethod(devEnumAddress, CREATE_CLASS_ENUMERATOR_OFFSET), returns: FFIType.i32 },
  });
  let hr: number;
  try {
    hr = createEnum.symbols.CreateClassEnumerator(devEnumAddress, category.ptr, enumOut.ptr, 0);
  } finally {
    createEnum.close();
  }
  // S_FALSE (or null enumerator) means the category has zero devices.
  const enumMonikerAddress = hr === 0 ? enumOut.readBigUInt64LE(0) : 0n;
  if (enumMonikerAddress === 0n) return devices;

  const iidPropertyBag = guidBytes(IID_IPROPERTY_BAG);
  const iidBaseFilter = guidBytes(IID_IBASE_FILTER);
  const next = linkSymbols({ Next: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(enumMonikerAddress, ENUMMONIKER_NEXT_OFFSET), returns: FFIType.i32 } });
  try {
    for (let guard = 0; guard < 64; guard += 1) {
      const monikerOut = Buffer.alloc(POINTER_SIZE);
      const fetched = Buffer.alloc(4);
      if (next.symbols.Next(enumMonikerAddress, 1, monikerOut.ptr, fetched.ptr) !== 0 || fetched.readUInt32LE(0) === 0) break;
      const monikerAddress = monikerOut.readBigUInt64LE(0);
      if (monikerAddress === 0n) break;

      const bagOut = Buffer.alloc(POINTER_SIZE);
      const bindToStorage = linkSymbols({ BindToStorage: { args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(monikerAddress, MONIKER_BIND_TO_STORAGE_OFFSET), returns: FFIType.i32 } });
      const bagHr = bindToStorage.symbols.BindToStorage(monikerAddress, 0n, 0n, iidPropertyBag.ptr, bagOut.ptr);
      bindToStorage.close();

      const device: CaptureDevice = { friendlyName: '', devicePath: '', description: '', pins: [], graphHr: null };
      const bagAddress = bagHr === 0 ? bagOut.readBigUInt64LE(0) : 0n;
      if (bagAddress !== 0n) {
        device.friendlyName = readBagString(bagAddress, 'FriendlyName');
        device.devicePath = readBagString(bagAddress, 'DevicePath');
        device.description = readBagString(bagAddress, 'Description');
        release(bagAddress);
      }

      if (buildGraphs) {
        const graphAddress = createFilterGraph();
        if (graphAddress !== 0n) {
          const filterOut = Buffer.alloc(POINTER_SIZE);
          const bindToObject = linkSymbols({ BindToObject: { args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(monikerAddress, MONIKER_BIND_TO_OBJECT_OFFSET), returns: FFIType.i32 } });
          const filterHr = bindToObject.symbols.BindToObject(monikerAddress, 0n, 0n, iidBaseFilter.ptr, filterOut.ptr);
          bindToObject.close();
          const filterAddress = filterHr === 0 ? filterOut.readBigUInt64LE(0) : 0n;
          if (filterAddress !== 0n) {
            const wname = Buffer.from(`${device.friendlyName || 'Capture Source'}\0`, 'utf16le');
            const addFilter = linkSymbols({ AddFilter: { args: [FFIType.u64, FFIType.u64, FFIType.u64], ptr: readVtableMethod(graphAddress, IFILTERGRAPH_ADDFILTER_OFFSET), returns: FFIType.i32 } });
            device.graphHr = addFilter.symbols.AddFilter(graphAddress, filterAddress, BigInt(wname.ptr ?? 0));
            addFilter.close();
            device.pins = enumeratePins(filterAddress);
            release(filterAddress);
          } else {
            device.graphHr = filterHr;
          }
          release(graphAddress);
        }
      }
      devices.push(device);
      release(monikerAddress);
    }
  } finally {
    next.close();
    release(enumMonikerAddress);
  }
  return devices;
}

function printCategory(title: string, devices: CaptureDevice[]): void {
  console.log(`${ANSI.bold}${ANSI.magenta}▌ ${title}${ANSI.reset}  ${ANSI.dim}(${devices.length} device${devices.length === 1 ? '' : 's'})${ANSI.reset}`);
  if (devices.length === 0) {
    console.log(`  ${ANSI.dim}none found${ANSI.reset}\n`);
    return;
  }
  devices.forEach((device, index) => {
    const tag = index === devices.length - 1 ? '└─' : '├─';
    console.log(`  ${ANSI.dim}${tag}${ANSI.reset} ${ANSI.bold}${ANSI.cyan}${device.friendlyName || '(no FriendlyName)'}${ANSI.reset}`);
    const pipe = index === devices.length - 1 ? '  ' : '│ ';
    if (device.description) console.log(`  ${ANSI.dim}${pipe}${ANSI.reset}   ${ANSI.dim}Description :${ANSI.reset} ${device.description}`);
    if (device.devicePath) console.log(`  ${ANSI.dim}${pipe}${ANSI.reset}   ${ANSI.dim}DevicePath  :${ANSI.reset} ${ANSI.dim}${device.devicePath.slice(0, 88)}${ANSI.reset}`);
    if (device.graphHr !== null) {
      const ok = device.graphHr === 0;
      console.log(`  ${ANSI.dim}${pipe}${ANSI.reset}   ${ANSI.dim}Graph add   :${ANSI.reset} ${ok ? ANSI.green : ANSI.red}${hresultText(device.graphHr)}${ANSI.reset}`);
    }
    if (device.pins.length > 0) {
      const out = device.pins.filter((p) => p.direction === 'output').length;
      console.log(`  ${ANSI.dim}${pipe}${ANSI.reset}   ${ANSI.dim}Pins        :${ANSI.reset} ${ANSI.yellow}${device.pins.length}${ANSI.reset} ${ANSI.dim}(${out} output)${ANSI.reset}`);
      device.pins.forEach((pin) => {
        const arrow = pin.direction === 'output' ? `${ANSI.green}▶${ANSI.reset}` : `${ANSI.cyan}◀${ANSI.reset}`;
        console.log(`  ${ANSI.dim}${pipe}${ANSI.reset}      ${arrow} ${pin.name} ${ANSI.dim}(${pin.direction})${ANSI.reset}`);
      });
    }
  });
  console.log();
}

function main(): void {
  enableVirtualTerminal();

  const coInitHr = ole32.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  if (coInitHr < 0 && coInitHr >>> 0 !== RPC_E_CHANGED_MODE) {
    console.error(`${ANSI.red}CoInitializeEx failed: ${hresultText(coInitHr)}${ANSI.reset}`);
    process.exit(1);
  }

  console.log();
  console.log(`${ANSI.bold}${ANSI.cyan}  D I R E C T S H O W   D E V I C E   C E N S U S${ANSI.reset}`);
  console.log(`  ${ANSI.dim}quartz.dll · legacy capture-device topology over pure FFI${ANSI.reset}\n`);

  const unloadBefore = Quartz.DllCanUnloadNow();
  console.log(`  ${ANSI.dim}DllCanUnloadNow (cold)        :${ANSI.reset} ${unloadBefore >>> 0 === S_FALSE ? `${ANSI.yellow}S_FALSE (server in use)` : `${ANSI.green}S_OK (unloadable)`}${ANSI.reset}`);

  const clsidDevEnum = guidBytes(CLSID_SYSTEM_DEVICE_ENUM);
  const iidDevEnum = guidBytes(IID_ICREATE_DEV_ENUM);
  const devEnumOut = Buffer.alloc(POINTER_SIZE);
  const ccHr = ole32.symbols.CoCreateInstance(clsidDevEnum.ptr, 0n, CLSCTX_INPROC_SERVER, iidDevEnum.ptr, devEnumOut.ptr);
  console.log(`  ${ANSI.dim}SystemDeviceEnum (ICreateDevEnum):${ANSI.reset} ${ccHr === 0 ? `${ANSI.green}${hresultText(ccHr)}` : `${ANSI.red}${hresultText(ccHr)}`}${ANSI.reset}\n`);

  const devEnumAddress = ccHr === 0 ? devEnumOut.readBigUInt64LE(0) : 0n;
  if (devEnumAddress === 0n) {
    console.error(`${ANSI.red}Cannot create the System Device Enumerator — aborting.${ANSI.reset}`);
    if (coInitHr >= 0) ole32.symbols.CoUninitialize();
    process.exit(1);
  }

  const videoDevices = enumerateCategory(devEnumAddress, CLSID_VIDEO_INPUT_CATEGORY, true);
  const audioDevices = enumerateCategory(devEnumAddress, CLSID_AUDIO_INPUT_CATEGORY, false);
  release(devEnumAddress);

  printCategory('Video capture devices', videoDevices);
  printCategory('Audio capture devices', audioDevices);

  const unloadAfter = Quartz.DllCanUnloadNow();
  console.log(`  ${ANSI.dim}DllCanUnloadNow (after release):${ANSI.reset} ${unloadAfter >>> 0 === S_FALSE ? `${ANSI.yellow}S_FALSE (refs remain)` : `${ANSI.green}S_OK (unloadable)`}${ANSI.reset}`);

  const totalPins = videoDevices.reduce((sum, d) => sum + d.pins.length, 0);
  console.log();
  console.log(
    `  ${ANSI.bold}${videoDevices.length}${ANSI.reset} ${ANSI.cyan}video${ANSI.reset}  ${ANSI.dim}•${ANSI.reset}  ` +
      `${ANSI.bold}${audioDevices.length}${ANSI.reset} ${ANSI.cyan}audio${ANSI.reset}  ${ANSI.dim}•${ANSI.reset}  ` +
      `${ANSI.bold}${totalPins}${ANSI.reset} ${ANSI.cyan}capture pins enumerated${ANSI.reset}`,
  );
  console.log(`  ${ANSI.green}${ANSI.bold}✓ DirectShow census complete${ANSI.reset}\n`);

  if (coInitHr >= 0) ole32.symbols.CoUninitialize();
  ole32.close();
  oleaut32.close();
  kernel32.close();
}

main();
