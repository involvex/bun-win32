/**
 * _term.bench — isolates the ENGINE cost (buildFrame) from any demo's draw cost,
 * so the numbers reflect the renderer itself. Two parts:
 *
 *   1. The default half/truecolor/exact path across realistic scenarios — static
 *      (CLI idling), sparse (a TUI repainting ~3% of cells), scroll, and full-frame
 *      video noise (the diff's worst case).
 *   2. A config matrix (mode × diff × depth) on COHERENT plasma motion (a proxy for
 *      real video / game frames, where threshold + palette pay off) and on
 *      INCOHERENT noise (the absolute worst case), reporting fps + bytes/frame.
 *
 *   bun run packages/all/example/_term.bench.ts
 *
 * "fps" here is frame PRODUCTION rate (build the diffed byte stream); a real
 * terminal then has to consume those bytes, so fewer bytes/frame (palette depths,
 * threshold diffing) also means a faster picture on screen, not just in this loop.
 */
import { Term, type TermMode, type TermDiff, type TermDepth } from './_term';

const fillNoise = (buf: Uint8Array, seed: number): void => {
  let a = seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    buf[i] = (t ^ (t >>> 14)) & 0xff;
  }
};
// Coherent animated plasma → adjacent frames differ only slightly (like video).
const genPlasma = (out: Uint8Array, W: number, H: number, time: number): void => {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const v = Math.sin(x * 0.05 + time) + Math.sin(y * 0.06 - time * 1.3) + Math.sin((x + y) * 0.04 + time * 0.7);
      out[i] = 128 + 100 * Math.sin(v + time);
      out[i + 1] = 128 + 100 * Math.sin(v + time + 2.094);
      out[i + 2] = 128 + 100 * Math.sin(v + time + 4.188);
    }
  }
};
const time = (n: number, fn: (i: number) => void): number => {
  const s = Bun.nanoseconds();
  for (let i = 0; i < n; i++) fn(i);
  return (Bun.nanoseconds() - s) / 1e9;
};
const pad = (s: string, n: number): string => s.padEnd(n);
const padL = (s: string, n: number): string => s.padStart(n);

// ── Part 1: default path ──
process.stdout.write('\n=== default path (half / truecolor / exact) ===\n');
process.stdout.write(`${pad('SIZE', 18)}${pad('SCENARIO', 12)}${padL('FPS', 10)}${padL('ms', 9)}${padL('KB', 9)}\n${'-'.repeat(58)}\n`);
for (const [cols, rowsN] of [[120, 40], [200, 60], [320, 100]] as Array<[number, number]>) {
  const t = new Term(cols, rowsN);
  const N = 400;
  const noise: Uint8Array[] = [];
  for (let f = 0; f < 8; f++) { const nf = new Uint8Array(t.buf.length); fillNoise(nf, 12345 + f * 7919); noise.push(nf); }
  let bytes = 0;
  const out = (scn: string, secs: number) => process.stdout.write(`${pad(`${cols}x${rowsN}`, 18)}${pad(scn, 12)}${padL((N / secs).toFixed(0), 10)}${padL(((secs / N) * 1000).toFixed(3), 9)}${padL((bytes / 1024).toFixed(1), 9)}\n`);
  fillNoise(t.buf, 999); t.buildFrame(); t.buildFrame();
  out('static', time(N, () => { bytes = t.buildFrame(); }));
  t.invalidate(); fillNoise(t.buf, 1); t.buildFrame();
  const cells = cols * rowsN, touch = Math.max(1, (cells * 0.03) | 0);
  out('sparse 3%', time(N, (i) => { for (let k = 0; k < touch; k++) { const c = ((i * 2654435761 + k * 40503) >>> 0) % cells; t.setPixel(c % cols, ((c / cols) | 0) * 2, (i + k) & 255, (i * 3 + k) & 255, (i * 7) & 255); } bytes = t.buildFrame(); }));
  t.invalidate();
  const base = noise[0];
  out('scroll', time(N, (i) => { const sh = (i % t.H) * t.W * 3; t.buf.set(base.subarray(sh)); t.buf.set(base.subarray(0, sh), t.buf.length - sh); bytes = t.buildFrame(); }));
  t.invalidate();
  out('video', time(N, (i) => { t.buf.set(noise[i & 7]); bytes = t.buildFrame(); }));
}

// ── Part 2: config matrix ──
const COLS = 200, ROWS = 60, N = 300;
const matrix = (label: string, coherent: boolean): void => {
  process.stdout.write(`\n=== ${label}  (${COLS}x${ROWS} cells) ===\n`);
  process.stdout.write(`${pad('MODE', 9)}${pad('DIFF', 11)}${pad('DEPTH', 10)}${padL('px', 9)}${padL('FPS', 10)}${padL('KB/f', 8)}\n${'-'.repeat(57)}\n`);
  const modes: TermMode[] = ['half', 'quad', 'sextant', 'braille'];
  const configs: Array<[TermDiff, TermDepth, number]> = [
    ['exact', 'truecolor', 0], ['threshold', 'truecolor', 18], ['exact', '256', 0], ['exact', '16', 0],
  ];
  for (const mode of modes) {
    for (const [diff, depth, threshold] of configs) {
      const t = new Term(COLS, ROWS, { mode, diff, depth, threshold });
      const K = coherent ? 60 : 8;
      const frames: Uint8Array[] = [];
      for (let f = 0; f < K; f++) { const nf = new Uint8Array(t.buf.length); if (coherent) genPlasma(nf, t.W, t.H, f * 0.03); else fillNoise(nf, 4567 + f * 7919); frames.push(nf); }
      for (let i = 0; i < 20; i++) { t.buf.set(frames[i % K]); t.buildFrame(); }
      t.invalidate();
      let tot = 0;
      const secs = time(N, (i) => { t.buf.set(frames[i % K]); tot += t.buildFrame(); });
      const dtag = diff === 'threshold' ? `thr${threshold}` : diff;
      process.stdout.write(`${pad(mode, 9)}${pad(dtag, 11)}${pad(depth, 10)}${padL(`${t.W}x${t.H}`, 9)}${padL((N / secs).toFixed(0), 10)}${padL((tot / N / 1024).toFixed(1), 8)}\n`);
    }
  }
};
matrix('COHERENT plasma (≈ real video / game)', true);
matrix('INCOHERENT noise (absolute worst case)', false);
process.stdout.write('\n');
