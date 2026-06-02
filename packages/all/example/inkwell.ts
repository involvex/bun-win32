/**
 * Inkwell — stir a real fluid with your cursor.
 *
 * A live 2D STABLE-FLUIDS solver (Jos Stam, SIGGRAPH 1999) on a FIXED interior
 * grid, decoupled from the terminal: velocity is advected SEMI-LAGRANGIANLY
 * (trace each cell backward along the flow, bilinearly sample — unconditionally
 * stable), made incompressible by red-black GAUSS-SEIDEL pressure projection
 * (∇·u → solve ∇²p = ∇·u → u −= ∇p), and re-curled by VORTICITY CONFINEMENT so
 * the ink keeps rolling into vortices instead of dissolving. Three luminous DYE
 * channels ride that flow. The grid is BILINEARLY upsampled to the pixel buffer
 * and mapped density→HDR colour with an additive glow core and an ACES grade —
 * luminous ink in a black void.
 *
 * INTERACTION (live): moving the cursor injects velocity along the drag vector
 * (you stir the water); holding the button injects luminous dye at the cursor;
 * the wheel shifts the dye hue. With no input — or after a few idle seconds — a
 * deterministic, time-driven invisible cursor traces flowing Lissajous curves,
 * dropping dye and dragging the fluid so the piece is alive instantly and every
 * CAPTURE_PNG is a rich, swirling frame. Hand-off is immediate on interaction.
 *
 * The attract path is a closed-form function of `time` (no RNG, no wall clock),
 * so captures and benches are bit-for-bit reproducible.
 *
 * Run: bun run packages/all/example/inkwell.ts
 */
import { runDemo, Term, clamp, smoothstep, hsv } from './_term';

// ── Fixed interior simulation grid (+1-cell border). Tuned for ≥90 bench fps. ───
const GW = 128;
const GH = 72;
const NX = GW + 2;
const NY = GH + 2;
const N = NX * NY;

// ── Solver tuning ───────────────────────────────────────────────────────────────
const PRESSURE_ITERS = 26; // red-black Gauss-Seidel sweeps → smooth, divergence-free
const VORT_EPS = 1.85;     // vorticity confinement — keeps the swirl alive without shredding dye into speckle
const VEL_DAMP = 0.9978;   // gentle velocity bleed so energy doesn't blow up
const DYE_DECAY = 0.9992;  // ink dissolves slowly → strokes layer into a rich, persistent field
const DYE_FLOOR = 0.0013;  // subtractive floor — crushes faint stray dye → clean dark
const FLOW_SCALE = 0.92;   // global flow speed
const BUOYANCY = 0.0;      // no net buoyancy — pure cursor-driven stirring (set >0 to convect)
const AMBIENT_COOL = 0.0;

// ── Field storage (all allocated once at module load — no hot-loop allocation). ─
const u = new Float32Array(N);
const v = new Float32Array(N);
const u0 = new Float32Array(N);
const v0 = new Float32Array(N);
const dr = new Float32Array(N);
const dg = new Float32Array(N);
const db = new Float32Array(N);
const s0 = new Float32Array(N);
const s1 = new Float32Array(N);
const s2 = new Float32Array(N);
const fwd = new Float32Array(N);  // BFECC forward-advected scratch
const back = new Float32Array(N); // BFECC back-advected scratch (error estimate)
const p = new Float32Array(N);
const div = new Float32Array(N);
const curl = new Float32Array(N);
const aCurl = new Float32Array(N);
const mag = new Float32Array(N);

// ── Boundaries: free-slip walls. ─────────────────────────────────────────────────
const setVelBounds = (): void => {
  for (let x = 1; x < NX - 1; x++) {
    u[x] = u[NX + x]; v[x] = -v[NX + x];
    const b = (NY - 1) * NX, b1 = (NY - 2) * NX;
    u[b + x] = u[b1 + x]; v[b + x] = -v[b1 + x];
  }
  for (let y = 1; y < NY - 1; y++) {
    const r = y * NX;
    u[r] = -u[r + 1]; v[r] = v[r + 1];
    u[r + NX - 1] = -u[r + NX - 2]; v[r + NX - 1] = v[r + NX - 2];
  }
};

const setScalarBounds = (sc: Float32Array): void => {
  for (let x = 1; x < NX - 1; x++) {
    sc[x] = sc[NX + x];
    sc[(NY - 1) * NX + x] = sc[(NY - 2) * NX + x];
  }
  for (let y = 1; y < NY - 1; y++) {
    const r = y * NX;
    sc[r] = sc[r + 1];
    sc[r + NX - 1] = sc[r + NX - 2];
  }
};

// ── Semi-Lagrangian advection (unconditionally stable). `dir` = +1 backtrace
// (normal, downstream→here), −1 forward-trace (used for the BFECC error pass). ──
const advectDir = (dst: Float32Array, src: Float32Array, dt: number, dir: number): void => {
  const maxX = NX - 1.001;
  const maxY = NY - 1.001;
  const sdt = dt * dir;
  for (let y = 1; y < NY - 1; y++) {
    const row = y * NX;
    for (let x = 1; x < NX - 1; x++) {
      const i = row + x;
      let px = x - sdt * u[i];
      let py = y - sdt * v[i];
      if (px < 0.5) px = 0.5; else if (px > maxX) px = maxX;
      if (py < 0.5) py = 0.5; else if (py > maxY) py = maxY;
      const x0 = px | 0, y0 = py | 0;
      const sx = px - x0, sy = py - y0;
      const b = y0 * NX, tt = b + NX;
      const a00 = src[b + x0], a10 = src[b + x0 + 1];
      const a01 = src[tt + x0], a11 = src[tt + x0 + 1];
      const top = a00 + (a10 - a00) * sx;
      const bot = a01 + (a11 - a01) * sx;
      dst[i] = top + (bot - top) * sy;
    }
  }
};
const advect = (dst: Float32Array, src: Float32Array, dt: number): void =>
  advectDir(dst, src, dt, 1);

// ── Despeckle: a tiny in-place Laplacian that erases ISOLATED single-cell spikes
// (the only artefact BFECC's higher-order term can manufacture) without softening
// real ribbons. Each cell is pulled a fraction `k` toward its 4-neighbour mean
// ONLY when it stands well clear of that mean (an outlier) — coherent edges, where
// the cell agrees with at least one neighbour, are left untouched. Reads `fwd` as
// the snapshot so the pass is order-independent. */
const despeckle = (a: Float32Array, k: number): void => {
  fwd.set(a);
  for (let y = 1; y < NY - 1; y++) {
    const row = y * NX;
    for (let x = 1; x < NX - 1; x++) {
      const i = row + x;
      const c = fwd[i];
      const l = fwd[i - 1], r = fwd[i + 1], up = fwd[i - NX], dn = fwd[i + NX];
      const mean = (l + r + up + dn) * 0.25;
      // Nearest neighbour distance — if the cell hugs ANY neighbour it's part of a
      // structure, not a lone spike, so leave it.
      let nd = c - l; if (nd < 0) nd = -nd;
      let d = c - r; if (d < 0) d = -d; if (d < nd) nd = d;
      d = c - up; if (d < 0) d = -d; if (d < nd) nd = d;
      d = c - dn; if (d < 0) d = -d; if (d < nd) nd = d;
      let dm = c - mean; if (dm < 0) dm = -dm;
      if (nd > dm * 0.6) a[i] = c + (mean - c) * k; // isolated → pull toward mean
    }
  }
};

// ── BFECC dye advection (sharp ribbons): a plain semi-Lagrangian backtrace is
// 1st-order and smears thin dye into blobs within a second. Back-and-Forth Error
// Compensation & Correction lifts it to ~2nd order: advect FORWARD, then BACKWARD,
// the round-trip error e = ½(src − back) is added back to src before the final
// forward advection — cancelling most numerical diffusion so filaments stay crisp.
// The result is CLAMPED to the 4 source cells of each backtrace so the higher-order
// term can't overshoot into negative dye or ringing. `src` is destroyed (scratch).
const advectBFECC = (dst: Float32Array, src: Float32Array, dt: number): void => {
  advectDir(fwd, src, dt, 1);   // φ̂ = A(φ)
  advectDir(back, fwd, dt, -1); // φ̄ = A⁻¹(φ̂)
  // 0.45 (not the textbook 0.5) trades a hair of sharpness for far less grid-scale
  // speckle — the over-correction is what manufactures single-cell noise.
  for (let i = 0; i < N; i++) src[i] += 0.45 * (src[i] - back[i]); // corrected field
  const maxX = NX - 1.001;
  const maxY = NY - 1.001;
  for (let y = 1; y < NY - 1; y++) {
    const row = y * NX;
    for (let x = 1; x < NX - 1; x++) {
      const i = row + x;
      let px = x - dt * u[i];
      let py = y - dt * v[i];
      if (px < 0.5) px = 0.5; else if (px > maxX) px = maxX;
      if (py < 0.5) py = 0.5; else if (py > maxY) py = maxY;
      const x0 = px | 0, y0 = py | 0;
      const sx = px - x0, sy = py - y0;
      const b = y0 * NX, tt = b + NX;
      const a00 = src[b + x0], a10 = src[b + x0 + 1];
      const a01 = src[tt + x0], a11 = src[tt + x0 + 1];
      const top = a00 + (a10 - a00) * sx;
      const bot = a01 + (a11 - a01) * sx;
      let r = top + (bot - top) * sy;
      // Clamp to the source stencil bounds → monotone, no over/undershoot.
      let lo = a00, hi = a00;
      if (a10 < lo) lo = a10; else if (a10 > hi) hi = a10;
      if (a01 < lo) lo = a01; else if (a01 > hi) hi = a01;
      if (a11 < lo) lo = a11; else if (a11 > hi) hi = a11;
      if (r < lo) r = lo; else if (r > hi) r = hi;
      dst[i] = r;
    }
  }
};

// ── Pressure projection (red-black Gauss-Seidel — faster than Jacobi). ──────────
const project = (iters: number): void => {
  p.fill(0);
  for (let y = 1; y < NY - 1; y++) {
    const row = y * NX;
    for (let x = 1; x < NX - 1; x++) {
      const i = row + x;
      div[i] = -0.5 * (u[i + 1] - u[i - 1] + v[i + NX] - v[i - NX]);
    }
  }
  setScalarBounds(div);
  const xMax = NX - 1, yMax = NY - 1;
  for (let k = 0; k < iters; k++) {
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 1; y < yMax; y++) {
        const row = y * NX;
        const start = 1 + ((y + pass) & 1);
        for (let x = start; x < xMax; x += 2) {
          const i = row + x;
          p[i] = (div[i] + p[i - 1] + p[i + 1] + p[i - NX] + p[i + NX]) * 0.25;
        }
      }
    }
    for (let x = 1; x < xMax; x++) {
      p[x] = p[NX + x];
      p[(NY - 1) * NX + x] = p[(NY - 2) * NX + x];
    }
    for (let y = 1; y < yMax; y++) {
      const r = y * NX;
      p[r] = p[r + 1];
      p[r + NX - 1] = p[r + NX - 2];
    }
  }
  for (let y = 1; y < NY - 1; y++) {
    const row = y * NX;
    for (let x = 1; x < NX - 1; x++) {
      const i = row + x;
      u[i] -= 0.5 * (p[i + 1] - p[i - 1]);
      v[i] -= 0.5 * (p[i + NX] - p[i - NX]);
    }
  }
  setVelBounds();
};

// ── Vorticity confinement (smoothed |curl| with a real floor → coherent swirl). ─
const VORT_FLOOR = 0.02;
const vorticityConfine = (eps: number, dt: number): void => {
  for (let y = 1; y < NY - 1; y++) {
    const row = y * NX;
    for (let x = 1; x < NX - 1; x++) {
      const i = row + x;
      const c = (v[i + 1] - v[i - 1]) * 0.5 - (u[i + NX] - u[i - NX]) * 0.5;
      curl[i] = c;
      aCurl[i] = c < 0 ? -c : c;
    }
  }
  for (let y = 2; y < NY - 2; y++) {
    const row = y * NX;
    for (let x = 2; x < NX - 2; x++) {
      const i = row + x;
      s0[i] = (aCurl[i] * 4 + aCurl[i - 1] + aCurl[i + 1] + aCurl[i - NX] + aCurl[i + NX]) * 0.125;
    }
  }
  for (let y = 2; y < NY - 2; y++) {
    const row = y * NX;
    for (let x = 2; x < NX - 2; x++) {
      const i = row + x;
      const gx = (s0[i + 1] - s0[i - 1]) * 0.5;
      const gy = (s0[i + NX] - s0[i - NX]) * 0.5;
      const len = Math.sqrt(gx * gx + gy * gy);
      if (len < VORT_FLOOR) continue;
      const w = curl[i];
      const s = (eps * dt) / len;
      u[i] += s * gy * w;
      v[i] -= s * gx * w;
    }
  }
};

// ── Soft radial splat of dye + force (the unit of injection for cursor + attract). ─
const splat = (
  cx: number, cy: number, radius: number,
  fx: number, fy: number, cr: number, cg: number, cb: number, amt: number,
): void => {
  const r2 = radius * radius;
  const inv = 1 / (r2 * 0.55);
  const x0 = Math.max(1, (cx - radius) | 0), x1 = Math.min(NX - 2, (cx + radius + 1) | 0);
  const y0 = Math.max(1, (cy - radius) | 0), y1 = Math.min(NY - 2, (cy + radius + 1) | 0);
  for (let y = y0; y <= y1; y++) {
    const row = y * NX;
    const ddy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const ddx = x - cx;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 > r2) continue;
      const g = Math.exp(-d2 * inv);
      const i = row + x;
      u[i] += fx * g;
      v[i] += fy * g;
      const a = g * amt;
      dr[i] += cr * a;
      dg[i] += cg * a;
      db[i] += cb * a;
    }
  }
};

// ── A pure velocity impulse (stir without adding dye — the drag stroke). ────────
const stir = (cx: number, cy: number, radius: number, fx: number, fy: number): void => {
  const r2 = radius * radius;
  const inv = 1 / (r2 * 0.55);
  const x0 = Math.max(1, (cx - radius) | 0), x1 = Math.min(NX - 2, (cx + radius + 1) | 0);
  const y0 = Math.max(1, (cy - radius) | 0), y1 = Math.min(NY - 2, (cy + radius + 1) | 0);
  for (let y = y0; y <= y1; y++) {
    const row = y * NX;
    const ddy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const ddx = x - cx;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 > r2) continue;
      const g = Math.exp(-d2 * inv);
      const i = row + x;
      u[i] += fx * g;
      v[i] += fy * g;
    }
  }
};

// ── Dye colour from a hue (turns). Saturated, HDR — luminous ink, not pastel. ───
type RGB = [number, number, number];
const inkColor = (hue: number): RGB => {
  const [r, g, b] = hsv(hue, 0.9, 1);
  // Lift to HDR (≈1.42×) so dense ink blooms in its own colour.
  return [(r / 255) * 1.42, (g / 255) * 1.42, (b / 255) * 1.42];
};

// ── Input / hue / cursor state ───────────────────────────────────────────────────
let hue = 0.58;            // current dye hue (turns); wheel shifts it
let lastMX = -1, lastMY = -1; // previous cursor grid position (for the drag vector)
let lastSeq = -1;          // last mouse event sequence seen
let idleTime = 0;          // seconds since last interaction
let everInteracted = false;
const IDLE_RESUME = 3.0;   // seconds of no input before attract resumes

// ── Attract: TWO deterministic invisible cursors trace counter-phased flowing
// curves across the whole tank, each laying its own drifting hue and dragging the
// fluid in opposite senses so the ribbons shear and fold into vortices between
// them. Two simultaneous hues → every capture is a multi-coloured, frame-filling
// composition; the wide reach keeps both ribbons sweeping the full canvas instead
// of pooling in one corner. Driven purely by `time` (reproducible, richly inked).
let prevAX0 = -1, prevAY0 = -1, prevAX1 = -1, prevAY1 = -1;

const brush = (
  gx: number, gy: number, ox: number, oy: number,
  swirl: number, amt: number, cr: number, cg: number, cb: number,
): void => {
  // Path velocity (cells/step). The velocity field is in grid cells per advection
  // step, so the drag kick must stay small (a few cells/step) or the semi-
  // Lagrangian backtrace samples far-away empty water and erases the dye.
  let vx = gx - ox, vy = gy - oy;
  const sp = Math.hypot(vx, vy);
  const maxSp = 2.4;
  if (sp > maxSp) { const k = maxSp / sp; vx *= k; vy *= k; }
  // A velocity kick along the motion + a handed swirl perpendicular to it so the
  // strokes curl into vortices. Lay the dye as a short SEGMENT (sub-stamps between
  // last and current position) so a fast path draws a continuous ribbon.
  const fkx = (vx - vy * swirl) * 1.7;
  const fky = (vy + vx * swirl) * 1.7;
  const segs = 5;
  const a = amt / segs;
  for (let s = 0; s < segs; s++) {
    const k = s / segs;
    splat(ox + (gx - ox) * k, oy + (gy - oy) * k, 3.3, fkx, fky, cr, cg, cb, a);
  }
};

const attract = (time: number, sdt: number): void => {
  const t = time;
  // Fade injection in over the first ~0.4s so the opening frame is a clean seed.
  const fade = time < 0.4 ? time / 0.4 : 1;
  const pulse = 0.86 + 0.14 * Math.sin(t * 1.7);

  // ── Brush A: an EPICYCLE — a centre that orbits the tank at a steady rate plus a
  // smaller, faster counter-spinning loop. Because both terms rotate at a constant
  // angular rate (never reverse), the path speed never drops to zero, so the brush
  // always lays a continuous RIBBON and never dwells long enough to pool a blob.
  // The orbital rate is brisk (≈1.1 rad/s) so within a 5s capture window the brush
  // sweeps a near-full revolution — every diagonal of the tank gets inked across the
  // four capture phases instead of one band staying light. A slow precession term
  // rotates the whole figure so successive laps don't retrace the same arc.
  const ang0 = t * 1.12 + 0.22 * Math.sin(t * 0.19) + 0.4;
  const rad0 = 0.225 + 0.035 * Math.sin(t * 0.13 + 0.7);
  const cx0 = 0.5 + rad0 * Math.cos(ang0);
  // The vertical orbit is squashed (×0.66) and the epicycle's Y is too: a tank
  // wider than it is tall has free-slip top/bottom walls, and dye carried into a
  // wall has no vertical escape and pancakes into a flat slab. Keeping the brushes
  // vertically central (and the X sweep wide) fills the frame without slabbing.
  const cy0 = 0.5 + rad0 * 0.66 * Math.sin(ang0);
  const fx0 = cx0 + 0.1 * Math.cos(-t * 1.43 + 1.7);
  const fy0 = cy0 + 0.072 * Math.sin(-t * 1.43 + 1.7);
  // Wide horizontal reach, vertically held well off both walls in [0.2,0.8] so the
  // ribbons stay airborne and keep curling instead of pinning into a slab.
  const gx0 = clamp(fx0, 0.06, 0.94) * GW + 1;
  const gy0 = clamp(fy0, 0.2, 0.8) * GH + 1;
  // Cool half of the wheel (cyan→violet), drifting slowly so a frame holds a family.
  const h0 = 0.56 + 0.13 * Math.sin(t * 0.23) + 0.05 * Math.sin(t * 0.09 + 1.3);
  const [cr0, cg0, cb0] = inkColor(h0);

  // ── Brush B: the POINT-REFLECTION of brush A's centre through the tank centre,
  // so the two brushes are always on opposite sides of the middle — they cross
  // through the centre and balance the frame instead of drifting to one band. Its
  // own faster epicycle spins the OTHER way so the ribbons shear against each other.
  const cx1 = 1.0 - cx0;
  const cy1 = 1.0 - cy0;
  const fx1 = cx1 + 0.1 * Math.cos(t * 1.31 + 0.6);
  const fy1 = cy1 + 0.072 * Math.sin(t * 1.31 + 0.6);
  const gx1 = clamp(fx1, 0.06, 0.94) * GW + 1;
  const gy1 = clamp(fy1, 0.2, 0.8) * GH + 1;
  // Warm half (crimson→rose→magenta), held in [0.88,0.97] so it never crosses into
  // the red→yellow arc (which reads garish), offset ~half the wheel from A → strong
  // complementary contrast against the cyan/violet brush.
  const h1 = 0.925 + 0.045 * Math.sin(t * 0.19 + 2.2) + 0.02 * Math.cos(t * 0.11);
  const [cr1, cg1, cb1] = inkColor(h1);

  if (prevAX0 < 0) { prevAX0 = gx0; prevAY0 = gy0; prevAX1 = gx1; prevAY1 = gy1; }
  const ox0 = prevAX0, oy0 = prevAY0, ox1 = prevAX1, oy1 = prevAY1;
  prevAX0 = gx0; prevAY0 = gy0; prevAX1 = gx1; prevAY1 = gy1;

  // Opposite handedness on the two swirls → counter-rotating vortices between them.
  const sw = 0.5 * Math.sin(t * 0.31) + 0.18;
  const amt = 0.33 * pulse * fade;
  brush(gx0, gy0, ox0, oy0, sw, amt, cr0, cg0, cb0);
  brush(gx1, gy1, ox1, oy1, -sw, amt, cr1, cg1, cb1);
};

// ── One simulation step. ────────────────────────────────────────────────────────
const step = (time: number, dt: number, t: Term, useAttract: boolean): void => {
  const sdt = Math.min(dt, 1 / 60) * 60 * FLOW_SCALE;

  if (useAttract) {
    attract(time, sdt);
  } else {
    // Live cursor: drag vector → velocity; button → dye. Mouse coords are pixels;
    // map to the interior grid. Both injections are scaled by sdt-independent
    // gains and the per-frame drag delta so fast flicks stir harder.
    const gx = clamp((t.mouseX / Math.max(t.W - 1, 1)) * GW + 1, 1, NX - 2);
    const gy = clamp((t.mouseY / Math.max(t.H - 1, 1)) * GH + 1, 1, NY - 2);
    if (lastMX < 0) { lastMX = gx; lastMY = gy; }
    const dx = gx - lastMX, dy = gy - lastMY;
    lastMX = gx; lastMY = gy;
    // The drag delta dx,dy is already in grid cells/frame. Keep the injected
    // velocity to a few cells/step (clamped) so a fast flick stirs hard without
    // the advection backtrace sampling far-off empty water and erasing the ink.
    let sx = dx * 1.4, sy = dy * 1.4;
    const sp = Math.hypot(sx, sy);
    if (sp > 3.5) { const k = 3.5 / sp; sx *= k; sy *= k; }
    if (sp > 0.02) stir(gx, gy, 4.2, sx, sy);
    // Button held → inject luminous dye, riding the same drag for a painted look.
    if (t.mouseDown) {
      const [cr, cg, cb] = inkColor(hue);
      splat(gx, gy, 3.0, sx * 0.6, sy * 0.6, cr, cg, cb, 0.7);
    }
  }

  // Optional buoyancy: bright ink rises, mean density gently sinks → standing
  // circulation. Disabled by default (pure cursor-driven stirring reads cleaner).
  if (BUOYANCY > 0 || AMBIENT_COOL > 0) {
    let mean = 0;
    for (let i = 0; i < N; i++) mean += dr[i] + dg[i] + db[i];
    mean /= N;
    for (let y = 1; y < NY - 1; y++) {
      const row = y * NX;
      for (let x = 1; x < NX - 1; x++) {
        const i = row + x;
        const dens = dr[i] + dg[i] + db[i];
        v[i] -= (BUOYANCY * dens - AMBIENT_COOL * mean) * sdt * 0.02;
      }
    }
  }

  vorticityConfine(VORT_EPS, sdt);
  setVelBounds();

  // Velocity self-advection.
  u0.set(u); v0.set(v);
  advect(u, u0, sdt);
  advect(v, v0, sdt);
  for (let i = 0; i < N; i++) { u[i] *= VEL_DAMP; v[i] *= VEL_DAMP; }
  setVelBounds();

  project(PRESSURE_ITERS);

  // Advect the three dye channels through the divergence-free flow with BFECC so
  // thin ribbons survive instead of smearing into soft blobs (s0/s1/s2 are scratch
  // copies that BFECC consumes).
  s0.set(dr); s1.set(dg); s2.set(db);
  advectBFECC(dr, s0, sdt);
  advectBFECC(dg, s1, sdt);
  advectBFECC(db, s2, sdt);
  despeckle(dr, 0.5); despeckle(dg, 0.5); despeckle(db, 0.5);
  // Decay toward dark water with a subtractive floor, and SOFT-CAP each channel:
  // once dye stacks above ~1.35 it compresses HARD, so dense cores stay in the
  // bloom-in-colour regime instead of piling into a clipped white puffball.
  const CAP = 1.28;
  for (let i = 0; i < N; i++) {
    let a = dr[i] * DYE_DECAY - DYE_FLOOR; if (a < 0) a = 0; else if (a > CAP) a = CAP + (a - CAP) * 0.14; dr[i] = a;
    a = dg[i] * DYE_DECAY - DYE_FLOOR; if (a < 0) a = 0; else if (a > CAP) a = CAP + (a - CAP) * 0.14; dg[i] = a;
    a = db[i] * DYE_DECAY - DYE_FLOOR; if (a < 0) a = 0; else if (a > CAP) a = CAP + (a - CAP) * 0.14; db[i] = a;
  }
  setScalarBounds(dr); setScalarBounds(dg); setScalarBounds(db);
};

// ── Render: bilinear-upsample dye → pixels, HDR glow + edge-light + ACES. ───────
const BASE_R = 0.004, BASE_G = 0.009, BASE_B = 0.024; // deep-water base tint (linear HDR)
const EXPOSURE = 1.55;
const ACES_A = 2.51, ACES_B = 0.03, ACES_C = 2.43, ACES_D = 0.59, ACES_E = 0.14;

const buildMag = (): void => {
  for (let i = 0; i < N; i++) mag[i] = dr[i] + dg[i] + db[i];
  setScalarBounds(mag);
};

// Per-axis bilinear LUTs — rebuilt only on resize (O(W+H)), reused per frame.
let lutW = -1, lutH = -1;
let xi = new Int32Array(0);
let xf = new Float32Array(0);
let yi = new Int32Array(0);
let yf = new Float32Array(0);
const buildBilinearLUT = (W: number, H: number): void => {
  if (W === lutW && H === lutH) return;
  lutW = W; lutH = H;
  xi = new Int32Array(W); xf = new Float32Array(W);
  yi = new Int32Array(H); yf = new Float32Array(H);
  const sx = GW / W, sy = GH / H;
  for (let x = 0; x < W; x++) {
    const gx = 1 + (x + 0.5) * sx - 0.5;
    let x0 = gx | 0;
    if (x0 < 1) x0 = 1; else if (x0 > NX - 3) x0 = NX - 3;
    xi[x] = x0; xf[x] = gx - x0;
  }
  for (let y = 0; y < H; y++) {
    const gy = 1 + (y + 0.5) * sy - 0.5;
    let y0 = gy | 0;
    if (y0 < 1) y0 = 1; else if (y0 > NY - 3) y0 = NY - 3;
    yi[y] = y0; yf[y] = gy - y0;
  }
};

const render = (t: Term): void => {
  buildMag();
  const buf = t.buf;
  const W = t.W, H = t.H;
  buildBilinearLUT(W, H);
  for (let y = 0; y < H; y++) {
    const y0 = yi[y];
    const fy = yf[y];
    const fy1 = 1 - fy;
    const r0 = y0 * NX;
    const r1 = r0 + NX;
    let o = y * W * 3;
    for (let x = 0; x < W; x++) {
      const x0 = xi[x];
      const fx = xf[x];
      const fx1 = 1 - fx;
      const i00 = r0 + x0, i10 = i00 + 1, i01 = r1 + x0, i11 = i01 + 1;
      const w00 = fx1 * fy1, w10 = fx * fy1, w01 = fx1 * fy, w11 = fx * fy;

      let R = dr[i00] * w00 + dr[i10] * w10 + dr[i01] * w01 + dr[i11] * w11;
      let G = dg[i00] * w00 + dg[i10] * w10 + dg[i01] * w01 + dg[i11] * w11;
      let B = db[i00] * w00 + db[i10] * w10 + db[i01] * w01 + db[i11] * w11;

      let dens = R + G + B;

      // Clean-water rolloff: faint smeared dye fades to black; real ink stays lit.
      if (dens < 0.16) {
        const tg = dens * 6.25;
        const gate = tg * tg * (3 - 2 * tg);
        R *= gate; G *= gate; B *= gate;
        dens *= gate;
      }

      // Chroma lift: keep mixed regions saturated instead of greying to white.
      // The amount is FADED IN over [0.12,0.45] density (smoothstep) so the very
      // thinnest low-density edges get NO push and keep their literal interpolated
      // hue — pushing channels apart there is what manufactured the faint green
      // fringe on thinning cyan against the cold blue base. Past the fade it climbs
      // to a strong plateau so dense complementary overlaps stay vivid, never grey.
      if (dens > 0.12) {
        const m = dens * (1 / 3);
        let lo = (dens - 0.12) * (1 / 0.33);
        if (lo > 1) lo = 1;
        const ramp = lo * lo * (3 - 2 * lo);        // 0 at thin edge → 1 by 0.45
        const sat = (dens < 1 ? 0.16 + dens * 0.44 : 0.6) * ramp;
        R += (R - m) * sat;
        G += (G - m) * sat;
        B += (B - m) * sat;
        if (R < 0) R = 0; if (G < 0) G = 0; if (B < 0) B = 0;
      }

      // Filament edge-light: gradient of the density field carves luminous rims.
      const cgx = mag[i10] - mag[i00] + mag[i11] - mag[i01];
      const cgy = mag[i01] - mag[i00] + mag[i11] - mag[i10];
      let grad = cgx < 0 ? -cgx : cgx;
      const agy = cgy < 0 ? -cgy : cgy;
      grad += agy;
      const rim = grad * (dens < 1 ? dens : 1) * 1.55;
      if (dens > 1e-4 && rim > 0) {
        const inv = rim / dens;
        R += R * inv;
        G += G * inv;
        B += B * inv;
      }

      // Glow core: dense ink blooms above a knee, tinted by its own hue. Almost
      // no white is added (the tiny constant term only lifts the very brightest
      // hearts) so an amber heart stays amber and a magenta heart stays magenta.
      const core = dens - 1.0;
      if (core > 0) {
        const glow = core * core * 0.5;
        const inv = dens > 1e-4 ? glow / dens : 0;
        // In-hue multiplier nudged up (the term scaled by the channel itself, so a
        // magenta heart blooms brighter MAGENTA); the tiny near-white constants are
        // held flat so dense cores gain luminance without drifting toward white.
        R += R * inv * 2.3 + glow * 0.008;
        G += G * inv * 2.3 + glow * 0.006;
        B += B * inv * 2.3 + glow * 0.011;
      }

      R = R * EXPOSURE + BASE_R;
      G = G * EXPOSURE + BASE_G;
      B = B * EXPOSURE + BASE_B;

      let tR = (R * (ACES_A * R + ACES_B)) / (R * (ACES_C * R + ACES_D) + ACES_E);
      let tG = (G * (ACES_A * G + ACES_B)) / (G * (ACES_C * G + ACES_D) + ACES_E);
      let tB = (B * (ACES_A * B + ACES_B)) / (B * (ACES_C * B + ACES_D) + ACES_E);
      tR = tR < 0 ? 0 : tR > 1 ? 1 : tR;
      tG = tG < 0 ? 0 : tG > 1 ? 1 : tG;
      tB = tB < 0 ? 0 : tB > 1 ? 1 : tB;
      buf[o] = (tR * 255) | 0;
      buf[o + 1] = (tG * 255) | 0;
      buf[o + 2] = (tB * 255) | 0;
      o += 3;
    }
  }
};

// ── Cursor halo: in live mode, mark where the cursor is so stirring feels direct.
const drawCursor = (t: Term): void => {
  const cx = t.mouseX, cy = t.mouseY;
  if (cx < 0 || cy < 0) return;
  const ring = t.mouseDown ? 3.2 : 2.4;
  const r2 = (ring + 1.5) * (ring + 1.5);
  const [hr, hg, hb] = hsv(hue, 0.7, 1);
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d * d > r2) continue;
      const a = smoothstep(ring + 1.5, ring - 0.6, d) * (t.mouseDown ? 0.85 : 0.5);
      t.addPixel(cx + dx, cy + dy, hr * a, hg * a, hb * a);
    }
  }
};

// ── Seed a starter so even frame 0 reads as ink ribbons, not bare dots. ─────────
const stroke = (
  x0: number, y0: number, dx: number, dy: number, bend: number,
  rad: number, hueT: number, amt: number,
): void => {
  const [cr, cg, cb] = inkColor(hueT);
  const steps = 22;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  for (let s = 0; s <= steps; s++) {
    const tt = s / steps;
    const taper = Math.sin(tt * Math.PI);
    const off = Math.sin(tt * Math.PI * 1.5) * bend;
    const px = x0 + dx * tt + nx * off;
    const py = y0 + dy * tt + ny * off;
    splat(px, py, rad * (0.6 + 0.4 * taper), dx * 0.004, dy * 0.004,
      cr, cg, cb, amt * taper);
  }
};

const seed = (): void => {
  u.fill(0); v.fill(0); dr.fill(0); dg.fill(0); db.fill(0);
  p.fill(0);
  const cx = GW * 0.5 + 1, cy = GH * 0.5 + 1;
  // Big crossing strokes spanning the tank so the opening second is already a
  // rich, folding bouquet of ink — not a few dots that decay before attract ramps.
  stroke(cx - 46, cy + 14, 52, -22, 14, 4.2, 0.56, 0.62);  // teal, low-left → up-right
  stroke(cx + 40, cy + 12, -50, -20, -13, 4.0, 0.80, 0.62); // violet, low-right → up-left
  stroke(cx - 8, cy + 24, 16, -46, 18, 3.6, 0.04, 0.56);    // amber, vertical plume
  stroke(cx - 28, cy - 16, 44, 6, -12, 3.4, 0.66, 0.52);    // cyan, upper sweep
  // very gentle counter-rotating swirl so the strokes slowly shear into sheets
  // (a hard stir advects the dye off-screen before it can fold — keep it tiny;
  // vorticity confinement and the attract brush provide the ongoing motion)
  stir(cx - 16, cy + 2, 18, 1.0, -1.2);
  stir(cx + 16, cy - 2, 18, -1.0, 1.2);
};

// ── Demo wiring ────────────────────────────────────────────────────────────────
let inited = false;
const ensure = (): void => {
  if (inited) return;
  seed();
  inited = true;
};

runDemo({
  title: 'Inkwell',
  hud: 'DRAG TO STIR  -  HOLD TO INK  -  WHEEL SHIFTS HUE',
  captureT: 5,
  targetFps: 60,
  mouse: true,
  init: () => { inited = false; ensure(); idleTime = 0; everInteracted = false; lastSeq = -1; lastMX = -1; lastMY = -1; prevAX0 = -1; prevAY0 = -1; prevAX1 = -1; prevAY1 = -1; },
  resize: () => { /* sim is fixed-resolution; LUT rebuilds itself in render */ },
  onKey: (key) => {
    if (key === 'c') { dr.fill(0); dg.fill(0); db.fill(0); u.fill(0); v.fill(0); }
  },
  frame: (t, time, dt, frame) => {
    ensure();

    // Detect interaction this frame: a new mouse event (move/press/wheel). Only
    // counts once the terminal has reported ANY mouse activity — in capture/bench
    // there is none, so mouseActive stays false and attract runs from t=0.
    let interacted = false;
    if (t.mouseActive) {
      if (t.mouseSeq !== lastSeq) { lastSeq = t.mouseSeq; interacted = true; everInteracted = true; }
      if (t.wheel !== 0) {
        hue = (hue + t.wheel * 0.04) % 1;
        if (hue < 0) hue += 1;
        t.wheel = 0;
        interacted = true; everInteracted = true;
      }
    }
    if (interacted) idleTime = 0; else idleTime += dt;

    // Attract whenever no one has interacted yet OR after IDLE_RESUME idle seconds.
    const useAttract = !everInteracted || idleTime > IDLE_RESUME;
    if (useAttract) { lastMX = -1; lastMY = -1; } // forget stale drag origin

    // Sub-step large frames so fast paths advect cleanly; cap the work.
    const sub = dt > 0 ? Math.min(2, Math.max(1, Math.round(dt / (1 / 80)))) : 1;
    const sdt = dt / sub;
    for (let s = 0; s < sub; s++) step(time + s * sdt, sdt > 0 ? sdt : 1 / 60, t, useAttract);

    render(t);
    if (!useAttract) drawCursor(t);
  },
});
