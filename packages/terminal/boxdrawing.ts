/** Box-drawing characters for `CharTerm.box` and manual tables/dividers, by style. */
export const BOX = {
  double: { bl: '╚', br: '╝', cross: '╬', h: '═', teeDown: '╦', teeLeft: '╣', teeRight: '╠', teeUp: '╩', tl: '╔', tr: '╗', v: '║' },
  rounded: { bl: '╰', br: '╯', cross: '┼', h: '─', teeDown: '┬', teeLeft: '┤', teeRight: '├', teeUp: '┴', tl: '╭', tr: '╮', v: '│' },
  sharp: { bl: '└', br: '┘', cross: '┼', h: '─', teeDown: '┬', teeLeft: '┤', teeRight: '├', teeUp: '┴', tl: '┌', tr: '┐', v: '│' },
} as const;

export type BoxStyle = keyof typeof BOX;

/** Block and shading characters. */
export const BLOCK = {
  dark: '▓',
  full: '█',
  left: '▌',
  light: '░',
  lower: '▄',
  medium: '▒',
  right: '▐',
  upper: '▀',
} as const;
