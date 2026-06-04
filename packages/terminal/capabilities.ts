import { readEnv } from './env';
import type { TermDepth } from './types';

/**
 * A machine-readable manifest of everything the engine supports — modes, diff
 * strategies, colour depths, input backends, feature flags, and the env knobs.
 * An agent can enumerate features at runtime without reading source.
 */
export const CAPABILITIES = {
  depths: ['16', '256', 'truecolor'],
  diffs: ['exact', 'none', 'threshold'],
  dithers: ['none', 'ordered'],
  features: {
    blit: true,
    clipRect: true,
    damageRegion: true,
    dithering: true,
    drawPrimitives: true,
    focusEvents: true,
    keyUpDown: true,
    mouse: true,
    pasteEvents: true,
    pipeSink: true,
    pngExport: true,
    resizeEvents: true,
    softAdditiveCircle: true,
    synchronizedOutput: true,
  },
  inputBackends: ['console'],
  modes: ['ascii', 'braille', 'half', 'octant', 'quad', 'sextant'],
  options: {
    bench: ['BENCH', 'BENCH_FRAMES'],
    capture: ['CAPTURE_FPS', 'CAPTURE_FRAMES', 'CAPTURE_PNG', 'CAPTURE_T', 'TERM_COLS', 'TERM_ROWS'],
    render: ['TERM_DEPTH', 'TERM_DIFF', 'TERM_DITHER', 'TERM_MODE', 'TERM_THRESHOLD'],
  },
} as const;

/** Best-effort runtime capabilities detected from the environment. */
export interface DetectedCapabilities {
  colorDepth: TermDepth;
  truecolor: boolean;
}

/**
 * Probe the current terminal's colour support from `COLORTERM` / `WT_SESSION`.
 * Reports `truecolor` when `COLORTERM` advertises `truecolor`/`24bit` or `WT_SESSION`
 * is set (Windows Terminal); otherwise conservatively `256`. A plain conhost that sets
 * neither is reported as `256` even though Windows 10+ conhost does render truecolor —
 * pass `depth: 'truecolor'` explicitly if you know the host supports it.
 *
 * @example
 * const surface = new Term(120, 40, { depth: detectCapabilities().colorDepth });
 */
export const detectCapabilities = (): DetectedCapabilities => {
  const colorterm = readEnv('COLORTERM') ?? '';
  const truecolor = colorterm.includes('truecolor') || colorterm.includes('24bit') || readEnv('WT_SESSION') !== undefined;
  return { colorDepth: truecolor ? 'truecolor' : '256', truecolor };
};
