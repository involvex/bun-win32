/**
 * Quartz Integration Test
 *
 * A real FFI integration test that loads `C:\Windows\System32\quartz.dll`
 * through the bindings and exercises every bound export against the live
 * DirectShow runtime — no mocks, no stubs. It verifies:
 *
 *   - AMGetErrorTextW   decodes a known DirectShow HRESULT (VFW_E_NOT_CONNECTED)
 *                       into non-empty Unicode text and returns the char count.
 *   - AMGetErrorTextA   decodes the same HRESULT into a non-empty ANSI string.
 *   - DllCanUnloadNow   returns a valid COM unload verdict (S_OK or S_FALSE).
 *   - DllGetClassObject  resolves quartz.dll's own CLSID_FilterGraph class
 *                        factory for IID_IClassFactory and yields a usable
 *                        IClassFactory whose CreateInstance materializes a
 *                        real IGraphBuilder, which is then released.
 *   - DllRegisterServer / DllUnregisterServer are bound and callable (their
 *                        symbols resolve); they are NOT invoked because they
 *                        mutate HKLM and require elevation.
 *
 * Run: bun test example/quartz.integration.test.ts
 */

import { afterAll, expect, test } from 'bun:test';
import { FFIType, dlopen, linkSymbols } from 'bun:ffi';

import Quartz from '../index';

const S_OK = 0;
const S_FALSE = 0x0000_0001;
const VFW_E_NOT_CONNECTED = 0x8004_0209 | 0; // a well-known DirectShow HRESULT
const POINTER_SIZE = 8;
const CLASSFACTORY_CREATEINSTANCE_OFFSET = 0x18; // IClassFactory slot 3
const RELEASE_OFFSET = 0x10; // IUnknown slot 2

const CLSID_FILTER_GRAPH = 'e436ebb3-524f-11ce-9f53-0020af0ba770';
const IID_ICLASS_FACTORY = '00000001-0000-0000-c000-000000000046';
const IID_IGRAPH_BUILDER = '56a868a9-0ad4-11ce-b03a-0020af0ba770';

const kernel32 = dlopen('kernel32.dll', {
  GetCurrentProcess: { args: [], returns: FFIType.u64 },
  ReadProcessMemory: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
});

const currentProcess = kernel32.symbols.GetCurrentProcess();

afterAll(() => {
  kernel32.close();
});

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
  expect(kernel32.symbols.ReadProcessMemory(currentProcess, address, buffer.ptr, BigInt(POINTER_SIZE), null)).not.toBe(0);
  return buffer.readBigUInt64LE(0);
}

function readVtableMethod(objectAddress: bigint, methodOffset: number): bigint {
  return readPointerAt(readPointerAt(objectAddress) + BigInt(methodOffset));
}

test('AMGetErrorTextW decodes a DirectShow HRESULT into Unicode text', () => {
  const buffer = Buffer.alloc(320);
  const written = Quartz.AMGetErrorTextW(VFW_E_NOT_CONNECTED, buffer.ptr, 160);
  expect(written).toBeGreaterThan(0);
  const text = buffer
    .toString('utf16le', 0, written * 2)
    .replace(/\0+$/, '')
    .trim();
  expect(text.length).toBeGreaterThan(0);
});

test('AMGetErrorTextA decodes a DirectShow HRESULT into ANSI text', () => {
  const buffer = Buffer.alloc(320);
  const written = Quartz.AMGetErrorTextA(VFW_E_NOT_CONNECTED, buffer.ptr, 160);
  expect(written).toBeGreaterThan(0);
  const text = buffer.toString('latin1', 0, written).replace(/\0+$/, '').trim();
  expect(text.length).toBeGreaterThan(0);
});

test('DllCanUnloadNow returns a valid COM unload verdict', () => {
  const hr = Quartz.DllCanUnloadNow();
  expect([S_OK, S_FALSE]).toContain(hr >>> 0);
});

test('DllGetClassObject resolves CLSID_FilterGraph and CreateInstance yields an IGraphBuilder', () => {
  const factoryOut = Buffer.alloc(POINTER_SIZE);
  const hr = Quartz.DllGetClassObject(guidBytes(CLSID_FILTER_GRAPH).ptr, guidBytes(IID_ICLASS_FACTORY).ptr, factoryOut.ptr);
  expect(hr).toBe(S_OK);

  const factoryAddress = factoryOut.readBigUInt64LE(0);
  expect(factoryAddress).not.toBe(0n);

  const factory = linkSymbols({
    CreateInstance: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], ptr: readVtableMethod(factoryAddress, CLASSFACTORY_CREATEINSTANCE_OFFSET), returns: FFIType.i32 },
    Release: { args: [FFIType.u64], ptr: readVtableMethod(factoryAddress, RELEASE_OFFSET), returns: FFIType.u32 },
  });

  const graphOut = Buffer.alloc(POINTER_SIZE);
  const createHr = factory.symbols.CreateInstance(factoryAddress, 0n, guidBytes(IID_IGRAPH_BUILDER).ptr, graphOut.ptr);
  expect(createHr).toBe(S_OK);

  const graphAddress = graphOut.readBigUInt64LE(0);
  expect(graphAddress).not.toBe(0n);

  const graph = linkSymbols({ Release: { args: [FFIType.u64], ptr: readVtableMethod(graphAddress, RELEASE_OFFSET), returns: FFIType.u32 } });
  graph.symbols.Release(graphAddress);
  graph.close();

  factory.symbols.Release(factoryAddress);
  factory.close();
});

test('DllRegisterServer and DllUnregisterServer symbols resolve (not invoked)', () => {
  // These mutate HKLM and require elevation, so they are bound but not called.
  expect(typeof Quartz.DllRegisterServer).toBe('function');
  expect(typeof Quartz.DllUnregisterServer).toBe('function');
});
