// Byte-identity contract for the frame wire-stream. Builds a deterministic frame
// sequence across every mode × diff × depth, hashes the exact bytes each
// `buildFrame()` emits, and asserts the rolling hash matches a frozen golden. Any
// change to emitted bytes — even one that still renders identically — trips this.
// It is the gate the §8 optimisation rounds run against: speed may change, bytes
// may not. Run: `bun run packages/terminal/frame.golden.test.ts`.

import { Term } from './pixel';
import type { TermDepth, TermDiff, TermMode } from './types';

const GOLDEN_HASH: string = '4a6e2109';

// FNV-1a over the concatenated wire bytes of every frame of every config.
const fnvOffset = 0x811c9dc5;
let hash = fnvOffset >>> 0;
const absorb = (bytes: Uint8Array): void => {
  let accumulator = hash;
  for (let index = 0; index < bytes.length; index++) {
    accumulator ^= bytes[index];
    accumulator = Math.imul(accumulator, 0x01000193);
  }
  hash = accumulator >>> 0;
};

// Deterministic content that exercises solid cells, gradients, motion (so the diff
// path skips and re-emits), and per-channel drift (so threshold accumulation runs).
const paintFrame = (surface: Term, frame: number): void => {
  const { height, pixels, width } = surface;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3;
      const wave = Math.sin(x * 0.21 + frame * 0.4) + Math.cos(y * 0.17 - frame * 0.3);
      pixels[index] = (128 + 110 * Math.sin(wave + frame * 0.05)) & 0xff;
      pixels[index + 1] = ((x * 7 + y * 5 + frame * 9) & 0xff);
      pixels[index + 2] = ((x ^ y) + frame * 3) & 0xff;
    }
  }
};

const modes: TermMode[] = ['ascii', 'braille', 'half', 'quad', 'sextant'];
const depths: TermDepth[] = ['16', '256', 'truecolor'];
const diffs: TermDiff[] = ['exact', 'none', 'threshold'];

for (const mode of modes) {
  for (const depth of depths) {
    for (const diff of diffs) {
      const surface = new Term(48, 16, { depth, diff, mode, threshold: 18 });
      for (let frame = 0; frame < 8; frame++) {
        paintFrame(surface, frame);
        surface.buildFrame();
        absorb(surface.frameBytes());
      }
    }
  }
}

const digest = hash.toString(16).padStart(8, '0');
if (GOLDEN_HASH === '__PLACEHOLDER__') {
  console.log(`frame.golden: capture mode — hash is ${digest}`);
  process.exit(0);
}
if (digest === GOLDEN_HASH) {
  console.log(`frame.golden: 1 pass, 0 fail (hash ${digest})`);
} else {
  console.log(`frame.golden: 0 pass, 1 fail — wire bytes changed: expected ${GOLDEN_HASH}, got ${digest}`);
  process.exit(1);
}
