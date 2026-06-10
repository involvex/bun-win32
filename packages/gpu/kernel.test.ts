import { describe, expect, test } from 'bun:test';

import { parseKernelBindings, parseNumthreads } from './kernel';

describe('parseKernelBindings', () => {
  test('parses a single RW float buffer', () => {
    expect(parseKernelBindings('RWStructuredBuffer<float> data : register(u0);')).toEqual([{ kind: 'float', name: 'data', register: 0, writable: true }]);
  });
  test('parses multiple buffers with names, kinds, and registers', () => {
    const bindings = parseKernelBindings(`
      StructuredBuffer<float> a : register(t0);
      StructuredBuffer<int> b : register(t1);
      RWStructuredBuffer<uint> c : register(u0);
    `);
    expect(bindings).toEqual([
      { kind: 'float', name: 'a', register: 0, writable: false },
      { kind: 'int', name: 'b', register: 1, writable: false },
      { kind: 'uint', name: 'c', register: 0, writable: true },
    ]);
  });
  test('tolerates flexible whitespace', () => {
    expect(parseKernelBindings('RWStructuredBuffer < float >  values :  register( u0 );')).toEqual([{ kind: 'float', name: 'values', register: 0, writable: true }]);
  });
  test('throws when an RW buffer uses a t register', () => {
    expect(() => parseKernelBindings('RWStructuredBuffer<float> data : register(t0);')).toThrow('must use a u register');
  });
  test('throws when a read-only buffer uses a u register', () => {
    expect(() => parseKernelBindings('StructuredBuffer<float> data : register(u0);')).toThrow('must use a t register');
  });
  test('throws when no annotated buffers exist', () => {
    expect(() => parseKernelBindings('[numthreads(1,1,1)] void main() {}')).toThrow('no StructuredBuffer');
  });
  test('throws when u registers are sparse', () => {
    expect(() => parseKernelBindings('RWStructuredBuffer<float> a : register(u0);\nRWStructuredBuffer<float> b : register(u2);')).toThrow('dense from 0');
  });
  test('throws when t registers do not start at 0', () => {
    expect(() => parseKernelBindings('StructuredBuffer<float> a : register(t1);\nRWStructuredBuffer<float> b : register(u0);')).toThrow('dense from 0');
  });
  test('rejects function-valued source with the transpiler explanation', () => {
    expect(() => Reflect.apply(parseKernelBindings, undefined, [() => 0])).toThrow('never transpiles JavaScript');
  });
});

describe('parseNumthreads', () => {
  test('parses the attribute', () => {
    expect(parseNumthreads('[numthreads(64,1,1)] void main() {}')).toEqual([64, 1, 1]);
  });
  test('parses whitespace forms', () => {
    expect(parseNumthreads('[ numthreads ( 8 , 8 , 2 ) ]')).toEqual([8, 8, 2]);
  });
  test('throws when absent', () => {
    expect(() => parseNumthreads('void main() {}')).toThrow('no [numthreads');
  });
});
