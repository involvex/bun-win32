/**
 * _textterm.selftest — exercises the character-grid engine headlessly and proves
 * it by writing a PNG you can look at. Renders the full ASCII font atlas, three
 * box styles (rounded / sharp / double), the ░▒▓█ shading + half-block ramp, an
 * HSV colour bar, and a few box-drawing junctions, plus the mandatory FPS readout.
 * Not a shipped demo.
 *
 *   CAPTURE_PNG=out.png TERM_COLS=160 TERM_ROWS=50 bun run _textterm.selftest.ts
 *   BENCH=1 bun run _textterm.selftest.ts
 */
import { runTextDemo, CharTerm, hsv, type RGB } from './_textterm';

const PRINTABLE: string[] = [];
for (let c = 32; c < 127; c++) PRINTABLE.push(String.fromCharCode(c));

const INK: RGB = [225, 228, 240];
const DIM: RGB = [120, 122, 140];
const CLAY: RGB = [235, 130, 90];
const PANEL: RGB = [18, 18, 26];

runTextDemo({
  title: 'TextTerm Engine Selftest',
  hud: 'ENTER/BACKSPACE · BOX · SHADE · HSV',
  captureT: 2,
  frame: (t: CharTerm, time) => {
    // Animated wallpaper so captures look alive: a drifting two-tone gradient.
    for (let y = 0; y < t.rows; y++) {
      for (let x = 0; x < t.cols; x++) {
        const u = x / t.cols, v = y / t.rows;
        const w = 0.5 + 0.5 * Math.sin(u * 6 + v * 4 + time);
        const r = 8 + 14 * v + 6 * w;
        const g = 8 + 10 * v;
        const b = 16 + 22 * (1 - v) + 8 * w;
        t.put(x, y, ' ', INK, [r, g, b]);
      }
    }

    // Title.
    t.text(2, 1, 'TEXTTERM ENGINE SELFTEST', CLAY, undefined, true);

    // Font atlas — every ASCII printable, on a dark panel.
    t.fillRect(2, 3, t.cols - 4, 4, PANEL);
    t.text(3, 3, 'ASCII FONT ATLAS', DIM, PANEL);
    const perRow = Math.max(16, t.cols - 8);
    for (let i = 0; i < PRINTABLE.length; i++) {
      const x = 3 + (i % perRow);
      const y = 4 + ((i / perRow) | 0);
      if (y < 7) t.put(x, y, PRINTABLE[i], INK, PANEL);
    }
    t.text(3, 6, 'the quick brown fox 0123456789 +-*/=<>[]{}', [150, 210, 255], PANEL);

    // Three box styles, side by side.
    const boxY = 8;
    const bw = Math.min(20, ((t.cols - 8) / 3) | 0);
    const styles: Array<['rounded' | 'sharp' | 'double', string, RGB]> = [
      ['rounded', 'ROUNDED', [120, 220, 160]],
      ['sharp', 'SHARP', [120, 180, 255]],
      ['double', 'DOUBLE', [255, 200, 120]],
    ];
    for (let s = 0; s < styles.length; s++) {
      const [style, name, col] = styles[s];
      const bx = 3 + s * (bw + 2);
      t.fillRect(bx, boxY, bw, 5, PANEL);
      t.box(bx, boxY, bw, 5, style, col, PANEL);
      t.text(bx + 2, boxY + 2, name, col, PANEL);
    }

    // Box-drawing junctions row.
    const jy = boxY + 6;
    t.text(3, jy, 'JOINTS:', DIM);
    t.text(11, jy, '┌─┬─┐ ├─┼─┤ └─┴─┘ ╔═╦═╗', [200, 200, 220]);

    // Shading ramp: space, ░, ▒, ▓, █  +  half-blocks.
    const shY = jy + 2;
    t.text(3, shY, 'SHADE:', DIM);
    const ramp = ' ░▒▓█';
    const rampW = Math.min(40, t.cols - 30);
    for (let i = 0; i < rampW; i++) {
      const ci = (i / rampW) * (ramp.length - 1);
      const ch = ramp[Math.min(ramp.length - 1, Math.round(ci))];
      const g = 40 + ((i / rampW) * 200) | 0;
      t.put(11 + i, shY, ch, [g + 40, g + 40, g + 55], PANEL);
    }
    t.text(11, shY + 1, 'half: ▀▄▌▐ █', [200, 200, 220]);

    // HSV colour bar — full hue sweep using full blocks, animated phase.
    const hY = shY + 3;
    t.text(3, hY, 'HSV:', DIM);
    const barW = t.cols - 12;
    for (let i = 0; i < barW; i++) {
      const h = i / barW + time * 0.05;
      const [r, g, b] = hsv(h, 0.9, 1);
      t.put(9 + i, hY, '█', [r, g, b], PANEL);
      t.put(9 + i, hY + 1, '▀', [r, g, b], [(r * 0.4) | 0, (g * 0.4) | 0, (b * 0.4) | 0]);
    }

    // A faux input box with a blinking caret to prove styled chrome + cursor.
    const inY = t.rows - 4;
    t.fillRect(2, inY, t.cols - 4, 3, [12, 12, 18]);
    t.box(2, inY, t.cols - 4, 3, 'rounded', CLAY, [12, 12, 18]);
    t.text(4, inY + 1, '> stir the pixels', INK, [12, 12, 18]);
    const caretOn = Math.floor(time * 2) % 2 === 0;
    if (caretOn) t.put(4 + 17, inY + 1, '█', CLAY, [12, 12, 18]);
  },
});
