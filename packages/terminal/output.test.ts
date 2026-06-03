// OutputBuffer emission checks: cursor moves, combined/single SGR, and pen
// run-length suppression. Run: `bun run packages/terminal/output.test.ts`.

import { OutputBuffer } from './output';

let passCount = 0;
let failCount = 0;
const assert = (label: string, condition: boolean, detail = ''): void => {
  if (condition) passCount++;
  else {
    failCount++;
    console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const decode = (output: OutputBuffer): string => Buffer.from(output.view()).toString('latin1');

{
  const output = new OutputBuffer();
  output.home();
  assert('home is ESC[H', decode(output) === '\x1b[H');
}

{
  const output = new OutputBuffer();
  output.moveCursor(3, 7);
  assert('moveCursor is 1-based ESC[r;cH', decode(output) === '\x1b[3;7H');
}

{
  const output = new OutputBuffer();
  output.setTruecolor(0xff0000, 0x0000ff);
  assert('combined truecolor', decode(output) === '\x1b[38;2;255;0;0;48;2;0;0;255m', decode(output));
}

{
  const output = new OutputBuffer();
  output.setTruecolor(0x010203, 0x010203);
  output.reset();
  output.setTruecolor(0x010203, 0x0a0b0c);
  assert('truecolor emits only changed background', decode(output) === '\x1b[48;2;10;11;12m', decode(output));
}

{
  const output = new OutputBuffer();
  output.setTruecolor(0x112233, 0x445566);
  output.reset();
  output.setTruecolor(0x112233, 0x445566);
  assert('pen suppresses unchanged colour', decode(output) === '');
}

{
  const glyph = new Uint8Array([0xe2, 0x96, 0x80]); // ▀
  const output = new OutputBuffer();
  output.emitCellTruecolor(0xff0000, 0x0000ff, glyph);
  assert('emitCellTruecolor = escape + glyph', decode(output) === '\x1b[38;2;255;0;0;48;2;0;0;255m\xe2\x96\x80', decode(output));
}

{
  const glyph = new Uint8Array([0xe2, 0x96, 0x80]);
  const output = new OutputBuffer();
  output.emitCellTruecolor(0x112233, 0x445566, glyph);
  output.reset();
  output.emitCellTruecolor(0x112233, 0x445566, glyph);
  assert('emitCellTruecolor skips escape but keeps glyph when pen unchanged', decode(output) === '\xe2\x96\x80', decode(output));
}

{
  const glyph = new Uint8Array([0xe2, 0x96, 0x80]);
  const output = new OutputBuffer();
  output.emitCellPalette(196, 16, glyph);
  assert('emitCellPalette = escape + glyph', decode(output) === '\x1b[38;5;196;48;5;16m\xe2\x96\x80', decode(output));
}

{
  const output = new OutputBuffer();
  output.setPaletteColor(196, 16);
  assert('combined palette', decode(output) === '\x1b[38;5;196;48;5;16m', decode(output));
}

{
  const output = new OutputBuffer();
  output.setPaletteColor(9, 0);
  output.resetPen();
  output.reset();
  output.setPaletteColor(9, 0);
  assert('resetPen forces re-emit', decode(output) === '\x1b[38;5;9;48;5;0m', decode(output));
}

{
  const output = new OutputBuffer();
  output.setBoldTruecolor(0xff0000, 0x0000ff, 1);
  assert('combined bold + truecolor', decode(output) === '\x1b[1;38;2;255;0;0;48;2;0;0;255m', decode(output));
}

{
  const output = new OutputBuffer();
  output.setBoldTruecolor(0xff0000, 0x0000ff, 1);
  output.reset();
  output.setBoldTruecolor(0xff0000, 0x0000ff, 0);
  assert('bold-only change', decode(output) === '\x1b[22m', decode(output));
}

{
  const output = new OutputBuffer();
  output.emitCellBoldTruecolor(0xff0000, 0x0000ff, 1, 0x41);
  assert('emitCellBoldTruecolor = bold escape + ascii glyph', decode(output) === '\x1b[1;38;2;255;0;0;48;2;0;0;255mA', decode(output));
}

{
  const output = new OutputBuffer();
  output.emitCellBoldTruecolor(0x112233, 0x445566, 0, 0x2588);
  output.reset();
  output.emitCellBoldTruecolor(0x112233, 0x445566, 0, 0x2588);
  assert('emitCellBoldTruecolor skips escape but keeps utf-8 glyph', Buffer.from(output.view()).toString('utf8') === '█', Buffer.from(output.view()).toString('utf8'));
}

{
  const output = new OutputBuffer();
  output.putCodePoint(0x2580);
  output.putCodePoint(0x41);
  assert('putCodePoint utf-8 + ascii', Buffer.from(output.view()).toString('utf8') === '▀A', Buffer.from(output.view()).toString('utf8'));
}

console.log(`output.test: ${passCount} pass, ${failCount} fail`);
if (failCount > 0) process.exit(1);
