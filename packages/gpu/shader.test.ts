import { describe, expect, test } from 'bun:test';

import { compile, preprocessHLSL } from './shader';

describe('preprocessHLSL', () => {
  test('substitutes a named include', () => {
    expect(preprocessHLSL('#include "common"\nfloat x;', { common: 'float y;' })).toBe('float y;\nfloat x;');
  });
  test('resolves nested includes', () => {
    expect(preprocessHLSL('#include "a"', { a: '#include "b"', b: 'float z;' })).toBe('float z;');
  });
  test('leaves include-free source untouched', () => {
    expect(preprocessHLSL('float w;')).toBe('float w;');
  });
  test('throws on unresolved include', () => {
    expect(() => preprocessHLSL('#include "missing"')).toThrow('unresolved #include');
  });
  test('throws on include cycles', () => {
    expect(() => preprocessHLSL('#include "a"', { a: '#include "a"' })).toThrow('nesting exceeds');
  });
});

describe('compile guardrails (throw before any FFI call)', () => {
  test('backtick in source throws the template-literal hint', () => {
    expect(() => compile('float4 main() : SV_Target { return 0; } `', 'main', 'ps_5_0')).toThrow('backtick');
  });
  test('backtick arriving via an include is still caught', () => {
    expect(() => compile('#include "bad"', 'main', 'ps_5_0', { includes: { bad: 'float ` x;' } })).toThrow('backtick');
  });
  test('noise() with [unroll] throws unless allowNoise', () => {
    const source = '[unroll] for (int i = 0; i < 4; i += 1) { value += noise(uv * i); }';
    expect(() => compile(source, 'main', 'ps_5_0')).toThrow('noise()');
  });
});
