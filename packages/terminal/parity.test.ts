// Foundational-module parity checks: the clean PNG encoder must be byte-identical
// to the original engine, and the quantisers must hit the documented xterm indices.
// Run: `bun run packages/terminal/parity.test.ts` (exits non-zero on failure).

import { encodePNG as referenceEncodePNG } from '../all/example/_term';
import { channelDelta, quantizeTo16, quantizeTo256 } from './color';
import { encodePNG } from './png';

let passCount = 0;
let failCount = 0;
const assert = (label: string, condition: boolean, detail = ''): void => {
  if (condition) passCount++;
  else {
    failCount++;
    console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

{
  const width = 23;
  const height = 17;
  const pixels = new Uint8Array(width * height * 3);
  let state = 0x12345678;
  for (let index = 0; index < pixels.length; index++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    pixels[index] = state & 0xff;
  }
  const encoded = encodePNG(pixels, width, height);
  const reference = referenceEncodePNG(pixels, width, height);
  let identical = encoded.length === reference.length;
  for (let index = 0; identical && index < encoded.length; index++) if (encoded[index] !== reference[index]) identical = false;
  assert('encodePNG byte-identical to original', identical, `lengths ${encoded.length} vs ${reference.length}`);
}

assert('quantizeTo256 red', quantizeTo256(255, 0, 0) === 196);
assert('quantizeTo256 black', quantizeTo256(0, 0, 0) === 16);
assert('quantizeTo256 white', quantizeTo256(255, 255, 255) === 231);
assert('quantizeTo16 red', quantizeTo16(255, 0, 0) === 9);
assert('quantizeTo16 black', quantizeTo16(0, 0, 0) === 0);
assert('quantizeTo16 white', quantizeTo16(255, 255, 255) === 15);
assert('channelDelta maximum', channelDelta(0xffffff, 0, 0, 0) === 255);
assert('channelDelta zero', channelDelta(0x646464, 100, 100, 100) === 0);
assert('channelDelta eight', channelDelta(0x646464, 108, 100, 100) === 8);

console.log(`parity.test: ${passCount} pass, ${failCount} fail`);
if (failCount > 0) process.exit(1);
