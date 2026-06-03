// Byte-identity contract for the frame wire-stream. Builds deterministic frame
// sequences across every Term mode × diff × depth and a churning CharTerm grid,
// hashes the exact bytes each `buildFrame()` emits, and asserts the rolling hashes
// match frozen goldens. Any change to emitted bytes — even one that still renders
// identically — trips this. It is the gate the §8 optimisation rounds run against:
// speed may change, bytes may not. Run: `bun run packages/terminal/frame.golden.test.ts`.

import { CharTerm } from './char';
import { Term } from './pixel';
import type { TermDepth, TermDiff, TermMode } from './types';

const TERM_GOLDEN_HASH: string = '4a6e2109';
const CHAR_GOLDEN_HASH: string = '6406c50a';

// FNV-1a folding `bytes` into `state`, returning the new state.
const fnvOffset = 0x811c9dc5;
const fold = (state: number, bytes: Uint8Array): number => {
  let accumulator = state;
  for (let index = 0; index < bytes.length; index++) {
    accumulator ^= bytes[index];
    accumulator = Math.imul(accumulator, 0x01000193);
  }
  return accumulator >>> 0;
};

// --- Term: full mode × depth × diff matrix over moving content ---
// Exercises solid cells, gradients, motion (the diff path skips and re-emits), and
// per-channel drift (so threshold accumulation runs).
const paintTerm = (surface: Term, frame: number): void => {
  const { height, pixels, width } = surface;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3;
      const wave = Math.sin(x * 0.21 + frame * 0.4) + Math.cos(y * 0.17 - frame * 0.3);
      pixels[index] = (128 + 110 * Math.sin(wave + frame * 0.05)) & 0xff;
      pixels[index + 1] = (x * 7 + y * 5 + frame * 9) & 0xff;
      pixels[index + 2] = ((x ^ y) + frame * 3) & 0xff;
    }
  }
};

const modes: TermMode[] = ['ascii', 'braille', 'half', 'quad', 'sextant'];
const depths: TermDepth[] = ['16', '256', 'truecolor'];
const diffs: TermDiff[] = ['exact', 'none', 'threshold'];

let termHash = fnvOffset >>> 0;
for (const mode of modes) {
  for (const depth of depths) {
    for (const diff of diffs) {
      const surface = new Term(48, 16, { depth, diff, mode, threshold: 18 });
      for (let frame = 0; frame < 8; frame++) {
        paintTerm(surface, frame);
        surface.buildFrame();
        termHash = fold(termHash, surface.frameBytes());
      }
    }
  }
}
const termDigest = termHash.toString(16).padStart(8, '0');

// --- CharTerm: a churning grid exercising glyphs, fg/bg, bold, and the pen ---
const boxGlyphs = [0x2500, 0x2502, 0x250c, 0x2510, 0x2514, 0x2518, 0x251c, 0x2524, 0x252c, 0x2534, 0x253c];
const paintChar = (surface: CharTerm, frame: number): void => {
  const { columns, rows } = surface;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const cellIndex = row * columns + column;
      const selector = (column + row + frame) % 5;
      surface.characters[cellIndex] = selector === 0 ? boxGlyphs[(column + frame) % boxGlyphs.length] : 0x20 + ((column * 3 + row + frame) % 0x5e);
      surface.foreground[cellIndex] = (column * 9 + row * 5 + frame * 13) & 0xffffff;
      surface.background[cellIndex] = (column * 4 + row * 11 + frame * 7) & 0x3f3f3f;
      surface.bold[cellIndex] = (column + row + frame) & 1;
    }
  }
};

let charHash = fnvOffset >>> 0;
const charSurface = new CharTerm(40, 12);
for (let frame = 0; frame < 10; frame++) {
  paintChar(charSurface, frame);
  charSurface.buildFrame();
  charHash = fold(charHash, charSurface.frameBytes());
}
const charDigest = charHash.toString(16).padStart(8, '0');

let failed = false;
const judge = (label: string, expected: string, actual: string): void => {
  if (expected === '__PLACEHOLDER__') {
    console.log(`frame.golden: capture mode — ${label} hash is ${actual}`);
    return;
  }
  if (expected === actual) {
    console.log(`frame.golden: ${label} pass (hash ${actual})`);
  } else {
    failed = true;
    console.log(`frame.golden: ${label} FAIL — wire bytes changed: expected ${expected}, got ${actual}`);
  }
};
judge('Term', TERM_GOLDEN_HASH, termDigest);
judge('CharTerm', CHAR_GOLDEN_HASH, charDigest);
if (failed) process.exit(1);
