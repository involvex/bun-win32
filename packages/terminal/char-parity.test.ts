// Validates the clean CharTerm two ways: (1) decode its emitted byte stream back
// into a cell grid and confirm it reconstructs the source cells exactly, and
// (2) confirm its PNG rasteriser is byte-identical to the original char engine.
// Run: `bun run packages/terminal/char-parity.test.ts`.

import { CharTerm as OriginalCharTerm } from '../all/example/_textterm';
import { CharTerm } from './char';

type Surface = Pick<CharTerm, 'box' | 'clear' | 'fillRect' | 'hline' | 'put' | 'shadeRect' | 'text' | 'vline'>;

const drawScene = (surface: Surface): void => {
  surface.clear(8, 10, 16);
  surface.box(1, 1, 32, 9, 'rounded', [200, 210, 255], [0, 0, 0]);
  surface.text(3, 2, 'PHOSPHOR', [255, 255, 255], undefined, true);
  surface.fillRect(3, 4, 12, 2, [40, 12, 60]);
  surface.shadeRect(2, 2, 30, 7, 0, 80, 120, 0.3);
  surface.put(5, 6, '★', [255, 220, 0], [10, 10, 10], false);
  surface.hline(2, 8, 28, '─', [120, 120, 140]);
  surface.vline(16, 2, 6, '│', [90, 90, 110]);
};

interface DecodedCell {
  background: number;
  bold: number;
  character: number;
  foreground: number;
}

const decodeGrid = (bytes: Uint8Array, columns: number, rows: number): DecodedCell[] => {
  const grid: DecodedCell[] = new Array(columns * rows);
  for (let index = 0; index < grid.length; index++) grid[index] = { background: -1, bold: 0, character: -1, foreground: -1 };
  let cursorRow = 0;
  let cursorColumn = 0;
  let penBold = 0;
  let penForeground = -1;
  let penBackground = -1;
  let position = 0;
  const decodeCodePoint = (): number => {
    const lead = bytes[position++];
    if (lead < 0x80) return lead;
    if (lead < 0xe0) return ((lead & 0x1f) << 6) | (bytes[position++] & 0x3f);
    if (lead < 0xf0) {
      const second = bytes[position++] & 0x3f;
      return ((lead & 0x0f) << 12) | (second << 6) | (bytes[position++] & 0x3f);
    }
    const second = bytes[position++] & 0x3f;
    const third = bytes[position++] & 0x3f;
    return ((lead & 0x07) << 18) | (second << 12) | (third << 6) | (bytes[position++] & 0x3f);
  };
  while (position < bytes.length) {
    if (bytes[position] === 0x1b && bytes[position + 1] === 0x5b) {
      position += 2;
      let parameters = '';
      while (position < bytes.length && !(bytes[position] >= 0x40 && bytes[position] <= 0x7e)) parameters += String.fromCharCode(bytes[position++]);
      const finalByte = bytes[position++];
      if (finalByte === 0x48) {
        if (parameters === '') {
          cursorRow = 0;
          cursorColumn = 0;
        } else {
          const [row, column] = parameters.split(';').map(Number);
          cursorRow = row - 1;
          cursorColumn = column - 1;
        }
      } else if (finalByte === 0x6d) {
        const parts = parameters.split(';');
        for (let part = 0; part < parts.length; part++) {
          if (parts[part] === '1') penBold = 1;
          else if (parts[part] === '22') penBold = 0;
          else if (parts[part] === '38' && parts[part + 1] === '2') {
            penForeground = (Number(parts[part + 2]) << 16) | (Number(parts[part + 3]) << 8) | Number(parts[part + 4]);
            part += 4;
          } else if (parts[part] === '48' && parts[part + 1] === '2') {
            penBackground = (Number(parts[part + 2]) << 16) | (Number(parts[part + 3]) << 8) | Number(parts[part + 4]);
            part += 4;
          }
        }
      }
    } else {
      const character = decodeCodePoint();
      const cellIndex = cursorRow * columns + cursorColumn;
      if (cellIndex >= 0 && cellIndex < grid.length) grid[cellIndex] = { background: penBackground, bold: penBold, character, foreground: penForeground };
      cursorColumn++;
    }
  }
  return grid;
};

let passCount = 0;
let failCount = 0;
const assert = (label: string, condition: boolean, detail = ''): void => {
  if (condition) passCount++;
  else {
    failCount++;
    console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const columns = 40;
const rows = 12;
const mine = new CharTerm(columns, rows);
drawScene(mine);
mine.buildFrame();
const decoded = decodeGrid(mine.frameBytes(), columns, rows);
let cellsMatched = 0;
let firstMismatch = -1;
for (let cellIndex = 0; cellIndex < columns * rows; cellIndex++) {
  const expectedCharacter = mine.characters[cellIndex] === 0 ? 0x20 : mine.characters[cellIndex];
  const cell = decoded[cellIndex];
  if (cell.character === expectedCharacter && cell.foreground === mine.foreground[cellIndex] && cell.background === mine.background[cellIndex] && cell.bold === mine.bold[cellIndex]) {
    cellsMatched++;
  } else if (firstMismatch < 0) {
    firstMismatch = cellIndex;
  }
}
assert('emit decode reconstructs every cell', cellsMatched === columns * rows, `${cellsMatched}/${columns * rows} matched, first mismatch ${firstMismatch}`);

const original = new OriginalCharTerm(columns, rows);
drawScene(original);
const minePng = mine.toPNG();
const originalPng = original.toPNG();
let pngIdentical = minePng.length === originalPng.length;
for (let index = 0; pngIdentical && index < minePng.length; index++) if (minePng[index] !== originalPng[index]) pngIdentical = false;
assert('toPNG byte-identical to original', pngIdentical, `lengths ${minePng.length} vs ${originalPng.length}`);

console.log(`char-parity.test: ${passCount} pass, ${failCount} fail`);
if (failCount > 0) process.exit(1);
