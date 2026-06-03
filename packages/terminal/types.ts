/** Sub-cell packing mode: how many pixels one character cell represents, and how. */
export type TermMode = 'ascii' | 'braille' | 'half' | 'quad' | 'sextant';

/** Frame-diff strategy: how the renderer decides which cells to re-emit. */
export type TermDiff = 'exact' | 'none' | 'threshold';

/** Colour depth of the emitted escape sequences. Fewer bits means far fewer bytes per frame. */
export type TermDepth = '16' | '256' | 'truecolor';

/** A 24-bit colour as a red/green/blue triple, each channel 0..255. */
export type RGB = readonly [number, number, number];

/** Renderer configuration for a pixel surface. */
export interface TermOptions {
  depth?: TermDepth;
  diff?: TermDiff;
  mode?: TermMode;
  /** With `diff: 'threshold'`, the maximum per-channel drift (0..255) a cell may accumulate before it is repainted. */
  threshold?: number;
}
