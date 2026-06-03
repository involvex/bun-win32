/** The shared Bun stdout sink used by both surfaces to flush frames. */
export const standardOutput = Bun.stdout.writer();
