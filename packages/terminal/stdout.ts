/** The shared Bun stdout sink used by both surfaces to flush frames. */
export const standardOutput = Bun.stdout.writer();

/** DEC synchronized-output (mode 2026): wrap a frame so the terminal swaps it atomically (no tearing). */
export const SYNCHRONIZED_OUTPUT_BEGIN = '\x1b[?2026h';
export const SYNCHRONIZED_OUTPUT_END = '\x1b[?2026l';
