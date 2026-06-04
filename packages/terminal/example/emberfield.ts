// Emberfield — a showcase for the engine's newest surface: octant sub-cell mode
// (default), ordered dithering, and addCircle (the soft additive glow). Glowing embers
// rise from a hearth through a dithered dusk gradient; every ember and the cursor are
// additive radial splats, so overlaps bloom. Live: move the mouse to fan the embers;
// F2 cycles the mode, F3 the depth, F5 dithering — watch octant→sextant and the
// banding appear/vanish as you flip them.
//
//   bun run example/emberfield.ts
//   TERM_DEPTH=256 TERM_DITHER=ordered bun run example/emberfield.ts   # see the dither win
//   CAPTURE_PNG=ember.png bun run example/emberfield.ts                # headless still

import { run, Term } from '@bun-win32/terminal';
import { clamp01, fract, hsv, mulberry32, smoothstep, TAU } from './_kit';

const { cos, sin } = Math;
const EMBER_COUNT = 260;

interface Ember {
  drift: number; // horizontal sway phase
  energy: number; // 0..1 brightness, decays as it rises
  hue: number; // warm band, in turns
  radius: number; // glow radius in pixels
  x: number;
  y: number;
}

const random = mulberry32(0x1f1742);
const embers: Ember[] = [];

const spawn = (ember: Ember, width: number, height: number): void => {
  ember.x = width * (0.5 + (random() - 0.5) * 0.5);
  ember.y = height + random() * 6;
  ember.drift = random() * TAU;
  ember.energy = 0.6 + random() * 0.4;
  ember.hue = 0.02 + random() * 0.1; // ember red → amber
  ember.radius = 2.5 + random() * 4.5;
};

const init = (surface: Term): void => {
  embers.length = 0;
  for (let index = 0; index < EMBER_COUNT; index++) {
    const ember: Ember = { drift: 0, energy: 0, hue: 0, radius: 0, x: 0, y: 0 };
    spawn(ember, surface.width, surface.height);
    ember.y = random() * surface.height; // stagger the initial column so it starts full
    embers.push(ember);
  }
};

const frame = (surface: Term, time: number, deltaTime: number): void => {
  const { height, width } = surface;
  const mouse = surface.mouse;

  // Dusk gradient sky — deep indigo aloft fading to near-black at the hearth line.
  // At 16/256 depth with `dither: 'ordered'` this is smooth; without it, it bands.
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    const sky = smoothstep(0, 1, 1 - t);
    const red = (10 + sky * 26) | 0;
    const green = (8 + sky * 14) | 0;
    const blue = (18 + sky * 50) | 0;
    surface.fillRect(0, y, width, 1, red, green, blue);
  }

  // The hearth: a pulsing glow seated on the bottom edge.
  const hearthX = width * 0.5;
  const pulse = 0.7 + 0.3 * sin(time * 3);
  surface.addCircle(hearthX, height + 4, height * 0.5, 255, 120, 36, 0.5 * pulse);
  surface.addCircle(hearthX, height, 10, 255, 210, 140, pulse);

  const windX = mouse.active && mouse.inside ? mouse.x : -1;
  for (let index = 0; index < embers.length; index++) {
    const ember = embers[index];
    // Rise with a little sway; cursor wind shoves nearby embers sideways.
    ember.y -= (8 + ember.radius * 3) * deltaTime;
    ember.drift += deltaTime * 1.6;
    ember.x += sin(ember.drift) * 6 * deltaTime;
    if (windX >= 0) {
      const dx = ember.x - windX;
      const dy = ember.y - mouse.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < 900) {
        const push = (1 - distanceSquared / 900) * 40 * deltaTime;
        ember.x += dx > 0 ? push : -push;
        ember.y -= push * 0.4;
      }
    }
    ember.energy -= deltaTime * 0.18;
    if (ember.y < -8 || ember.energy <= 0) {
      spawn(ember, width, height);
      continue;
    }
    // Flicker, and cool from amber toward deep red as it ages.
    const flicker = 0.7 + 0.3 * sin(ember.drift * 5 + index);
    const brightness = clamp01(ember.energy) * flicker;
    const hue = ember.hue * (0.5 + ember.energy * 0.5);
    const [red, green, blue] = hsv(hue, 0.85, 1);
    surface.addCircle(ember.x, ember.y, ember.radius, red, green, blue, brightness);
  }

  // Cursor torch.
  if (mouse.active && mouse.inside) {
    const [red, green, blue] = hsv(0.08 + 0.04 * sin(time * 6), 0.6, 1);
    surface.addCircle(mouse.x, mouse.y, 12, red, green, blue, 0.9);
  }

  // A drifting cool haze up top so the dither has a wide gradient to chew on.
  const hazeY = height * 0.28 + sin(time * 0.4) * height * 0.08;
  surface.addCircle(width * (0.5 + 0.25 * cos(time * 0.3)), hazeY, height * 0.4, 40, 60, 130, 0.18 + 0.06 * fract(time));
};

run({
  title: 'Emberfield',
  hud: 'addCircle GLOW · octant · F2 mode  F3 depth  F5 dither',
  mode: 'octant',
  mouse: true,
  captureT: 3,
  init,
  frame,
  resize: init,
});
