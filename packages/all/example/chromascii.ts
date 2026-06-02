/**
 * chromascii — a real-time, full-colour ASCII 3D renderer pushed to the limit.
 *
 * Every CELL is a tiny raymarcher: a (p,q) torus-knot tube SDF morphing with a
 * pulsing metaball core is sphere-traced with bounded steps, shaded by three
 * coloured lights against the surface normal, supersampled 2×2 for detail, then
 * resolved to a fine luminance→glyph density ramp. A Sobel pass over the resolved
 * luminance/depth field finds silhouettes and creases and OVERLAYS directional
 * line glyphs (/ \ | - _ ( )) for an inked-contour engraving. Each cell's colour
 * is the actual lit RGB of three CHROMATIC lights (warm key, cool fill, magenta
 * rim) — per-channel ACES-tonemapped, then its hue/saturation are read back out of
 * that RGB so a teal-lit face reads teal and a magenta rim reads magenta: the form
 * is genuinely multicoloured, not one wash. The form sits in a soft radial colour
 * pool so it never floats in a dead-black void.
 *
 * LIVE: drag rotates the camera (cell-unit deltas), wheel zooms, [ ] cycle the
 * glyph ramp, p/P cycle the colour palette, e toggles the contour ink. ATTRACT:
 * a slow turntable with a breathing knot morph, so a capture lands on a fully
 * shaded, contoured, multicoloured form the instant it launches.
 */
import { runTextDemo, CharTerm, clamp01, aces, hsv, type RGB } from './_textterm';

// ── Glyph density ramps (dark → bright). Cycled with [ ]. ────────────────────────
const RAMPS: string[] = [
  ' .:-=+*#%@',
  ' .,:;irsXA253hMHGS#9B&@',
  ' .\'`^",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
  ' ░▒▓█',
  ' .oO0@',
];
const RAMP_CODE: Int32Array[] = RAMPS.map((s) => {
  const a = new Int32Array(s.length);
  let i = 0;
  for (const c of s) a[i++] = c.codePointAt(0) ?? 32;
  return a.subarray(0, i);
});

// Directional contour glyphs indexed by quantised gradient angle (0..7 = 8 dirs).
// angle 0 = gradient points +x (vertical edge) → '|'; rotates around.
const EDGE_BY_DIR: number[] = [
  0x007c, // | vertical edge (grad horizontal)
  0x002f, // / diagonal
  0x005f, // _ horizontal-ish low
  0x005c, // \ diagonal
  0x007c, // |
  0x002f, // /
  0x002d, // - horizontal edge (grad vertical)
  0x005c, // \
];
const PAREN_L = 0x0028; // (
const PAREN_R = 0x0029; // )

// Quantise a 2D gradient (gx,gy) to one of 8 octants WITHOUT atan2 — pure sign +
// magnitude comparisons against tan(22.5°)=0.41421 and tan(67.5°)=2.41421. This is
// the hot-loop octant classifier for the contour ink; it returns the same index
// (0..7) that round(atan2(gy,gx)/45°)&7 would, so EDGE_BY_DIR maps it identically.
const TAN225 = 0.41421356;
const TAN675 = 2.41421356;
// Narrower axis bands (tan 11.25° / tan 78.75°) for the OUTER silhouette only: a
// top run that is "almost but not quite" horizontal then resolves to a gentle
// diagonal that follows the curve, instead of a long mechanical -/_ ruler. The wide
// bands stay for interior creases so engraving strokes read cleanly.
const TAN1125 = 0.19891237;
const TAN7875 = 5.02733949;
const octantBands = (gx: number, gy: number, tlo: number, thi: number): number => {
  const ax = gx < 0 ? -gx : gx;
  const ay = gy < 0 ? -gy : gy;
  // Region within the right/left half by |slope|: 0=along x, 1=diagonal, 2=along y.
  let band: number;
  if (ay <= ax * tlo) band = 0;
  else if (ay <= ax * thi) band = 1;
  else band = 2;
  // Resolve the full octant from the quadrant signs.
  if (gx >= 0) {
    if (gy >= 0) return band; // 0,1,2
    return band === 0 ? 0 : band === 1 ? 7 : 6; // x+,y-  → 0/7/6
  }
  if (gy >= 0) return band === 0 ? 4 : band === 1 ? 3 : 2; // x-,y+ → 4/3/2
  return band === 0 ? 4 : band === 1 ? 5 : 6; // x-,y- → 4/5/6
};
const octant = (gx: number, gy: number): number => octantBands(gx, gy, TAN225, TAN675);
const octantSil = (gx: number, gy: number): number => octantBands(gx, gy, TAN1125, TAN7875);

// ── Colour palettes: (luminance, depth, normal) → hue/sat tuning. Cycled p/P. ────
interface Palette {
  name: string;
  hueBase: number;
  hueSpan: number; // hue travel across depth/normal
  sat: number;
  warm: RGB; // key-light tint
  fill: RGB; // fill-light tint
  rim: RGB; // rim-light tint
}
const PALETTES: Palette[] = [
  // Genuinely TRI-TONE lights so each face of the form reads in a distinct hue:
  // a warm amber key, a cool teal/blue fill, a hot magenta rim. The renderer
  // colours each cell by WHICH light dominates, so the form is multicoloured.
  { name: 'EMBER', hueBase: 0.04, hueSpan: 0.50, sat: 0.92, warm: [1.0, 0.55, 0.18], fill: [0.10, 0.55, 0.95], rim: [1.0, 0.30, 0.62] },
  { name: 'NEON', hueBase: 0.52, hueSpan: 0.60, sat: 0.98, warm: [0.15, 0.95, 1.0], fill: [0.65, 0.18, 1.0], rim: [0.30, 1.0, 0.45] },
  { name: 'JADE', hueBase: 0.34, hueSpan: 0.46, sat: 0.88, warm: [0.45, 1.0, 0.55], fill: [0.12, 0.45, 0.85], rim: [1.0, 0.85, 0.30] },
  { name: 'GOLD', hueBase: 0.10, hueSpan: 0.34, sat: 0.86, warm: [1.0, 0.78, 0.30], fill: [0.30, 0.45, 0.90], rim: [1.0, 0.40, 0.22] },
  { name: 'PLASMA', hueBase: 0.80, hueSpan: 0.70, sat: 0.97, warm: [1.0, 0.30, 0.62], fill: [0.25, 0.50, 1.0], rim: [1.0, 0.80, 0.28] },
];

// ── Math helpers (no allocations in the hot loop — all scalars) ──────────────────
const PI = Math.PI;

// 4×4 ordered (Bayer) dither, normalised to (-0.5..0.5). Added to the ramp index
// before quantising so a flat bright region stipples between the top two glyphs
// instead of reading as a solid wall of '@' — finer perceived tonal detail at zero
// extra cost. Deterministic (purely a function of cell x,y), so capture stays exact.
const BAYER4 = new Float32Array([
  0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5,
].map((v) => v / 16 - 0.5));

// State that survives across frames (camera + UI), allocated once.
interface Scene {
  cols: number;
  rows: number;
  ssx: number; // supersample columns (cols * SS)
  ssy: number; // supersample rows  (rows * SS)
  // Resolved per-cell fields.
  lum: Float32Array; // 0..1 shaded luminance per cell
  dep: Float32Array; // 0..1 normalised depth per cell (1=far/miss)
  hue: Float32Array; // 0..1 hue per cell
  satv: Float32Array; // 0..1 saturation per cell
  valv: Float32Array; // 0..1 value/brightness per cell
  hit: Uint8Array; // 1 if the cell's centre sample hit the surface
  gx: Float32Array; // separable backdrop-glow factor per column
  gy: Float32Array; // separable backdrop-glow factor per row
  // Coarse pass: one ray per cell centre, used to drive ADAPTIVE supersampling.
  // 1 = centre ray hit the surface, 0 = missed. `cdep` is its 0..1 depth.
  chit: Uint8Array;
  cdep: Float32Array;
}

const SS = 2; // 2×2 supersample per cell

// Camera / interaction state (module-level, reset only on init).
let yaw = 0.0;
let pitch = -0.32;
let zoom = 1.0;
let rampIdx = 0;
let paletteIdx = 0;
let inkOn = 1;

// Auto/attract bookkeeping.
let dragging = false;
let dragPrevX = -1;
let dragPrevY = -1;

let scene: Scene | null = null;

// Whether a key was pressed since last frame (set in onKey). The harness clears
// input in capture/bench, so this stays false there → attract always runs.
let keyTouched = false;
// Sim-time of the last interaction so we resume the attract turntable after idle.
let interactT = -1e9;

const buildScene = (t: CharTerm): Scene => {
  const cols = t.cols;
  const rows = t.rows;
  const ssx = cols * SS;
  const ssy = rows * SS;
  return {
    cols,
    rows,
    ssx,
    ssy,
    lum: new Float32Array(cols * rows),
    dep: new Float32Array(cols * rows),
    hue: new Float32Array(cols * rows),
    satv: new Float32Array(cols * rows),
    valv: new Float32Array(cols * rows),
    hit: new Uint8Array(cols * rows),
    gx: new Float32Array(cols),
    gy: new Float32Array(rows),
    chit: new Uint8Array(cols * rows),
    cdep: new Float32Array(cols * rows),
  };
};

// Torus-knot tube SDF. The knot curve winds p times around the torus axis and q
// times through the hole; we approximate distance to the swept tube by sampling
// the parametric curve over the angle that best matches the query point's azimuth
// and refining. To stay branch-light and allocation-free we evaluate the closest
// point analytically against a coarse set of curve samples folded by symmetry.
//
// For real-time per-cell marching we instead use a compact implicit form: map the
// point into the torus's (u = major angle, r = distance from tube centreline)
// frame and fold by the knot winding, giving a smooth tube. This renders as a
// gorgeous self-knotting tube and is cheap.

// Knot/morph parameters (set per frame from time so the SDF closure can read them).
let kP = 2;
let kQ = 3;
let kMajor = 0.62; // torus major radius
let kTube = 0.26; // tube radius
let kMorph = 0; // 0..1 blend toward metaball blob
let kTwist = 0; // extra twist phase
let blobPulse = 0; // metaball radius modulation

// Bounding sphere (squared radius) enclosing the whole form — used to early-reject
// rays that can't possibly hit, so empty cells cost almost nothing. Tightened to
// the actual reach of the knot/blob (≈1.25) so more rays reject and the marchable
// span per ray is shorter.
const BSPHERE = 1.32;
const BSPHERE2 = BSPHERE * BSPHERE;

// Metaball centres (4), positions filled per frame.
const mbx = new Float32Array(4);
const mby = new Float32Array(4);
const mbz = new Float32Array(4);
const mbr = new Float32Array(4);

// Smooth-min for the metaball field.
const smin = (a: number, b: number, k: number): number => {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return b * (1 - h) + a * h - k * h * (1 - h);
};

// (p,q) torus-knot tube distance — a compact ANALYTIC form (no per-call polyline
// loop, so it's cheap enough to march per cell). We work in the torus's local
// frame: the major angle `a` around the +y axis selects which of the p strands is
// nearest, and the knot's q-winding places the tube centreline on a small circle
// of radius r2 about the major ring. We fold the q-phase to the nearest strand and
// return distance to that strand minus the tube radius. The result is a smooth,
// correct-looking (p,q) tube that sphere-traces stably.
const r2Knot = 0.34; // secondary radius (knot path radius about the major ring)

const sdKnot = (x: number, y: number, z: number): number => {
  const R = kMajor;
  const p = kP, q = kQ;
  // Major angle around the +y axis.
  let a = Math.atan2(z, x); // -PI..PI
  // The knot has p-fold symmetry about y: fold `a` into one strand's sector and
  // record the sector so the q-winding phase is continuous.
  const seg = 2 * PI / p;
  // Nearest strand index.
  const k = Math.round(a / seg);
  a -= k * seg; // a now in [-seg/2, seg/2]
  // Position relative to the major ring centre at this folded angle.
  const ca = Math.cos(a), sa = Math.sin(a);
  // Rotate the query point so the strand lies in a canonical plane.
  const xr = x * ca + z * sa; // radial-ish coordinate
  const zr = -x * sa + z * ca; // tangential offset along the ring
  // Distance from the major ring (in the radial/height plane).
  const rad = xr - R;
  // The knot's tube centre winds q times as we go around p times → phase:
  const phase = (q / p) * (a + k * seg) + kTwist;
  // Centreline of the tube on the small circle of radius r2:
  const cx2 = r2Knot * Math.cos(phase);
  const cy2 = r2Knot * Math.sin(phase);
  const dx = rad - cx2;
  const dy = y - cy2;
  // `zr` is the along-ring offset — include it so the tube has 3D thickness.
  const dTube = Math.sqrt(dx * dx + dy * dy + zr * zr) - kTube;
  return dTube;
};

// Metaball blob distance (smooth union of 4 spheres). Unrolled, no per-iter branch.
const sdBlob = (x: number, y: number, z: number): number => {
  let dx = x - mbx[0], dy = y - mby[0], dz = z - mbz[0];
  let d = Math.sqrt(dx * dx + dy * dy + dz * dz) - mbr[0];
  dx = x - mbx[1]; dy = y - mby[1]; dz = z - mbz[1];
  d = smin(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - mbr[1], 0.42);
  dx = x - mbx[2]; dy = y - mby[2]; dz = z - mbz[2];
  d = smin(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - mbr[2], 0.42);
  dx = x - mbx[3]; dy = y - mby[3]; dz = z - mbz[3];
  d = smin(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - mbr[3], 0.42);
  return d;
};

// Full scene SDF: morph between knot and blob. The blob is the expensive branch,
// so when the morph is negligible we skip it entirely and pay only for the knot —
// which is the legible "hero" form the spec wants on screen most of the time.
const sceneSDF = (x: number, y: number, z: number): number => {
  if (kMorph <= 0.02) return sdKnot(x, y, z);
  if (kMorph >= 0.98) return sdBlob(x, y, z);
  const a = sdKnot(x, y, z);
  const b = sdBlob(x, y, z);
  return a + (b - a) * kMorph;
};

// Lighting directions (normalised, world space). Three coloured lights placed so
// that on a smooth orbiting form each of the three hues claims a broad, distinct
// region of the surface — warm from upper-right, cool from the left, magenta a
// LATERAL lower-right accent — rather than one light washing the whole shape.
// ROUND-3 rebalance: the magenta rim was a down/back light (0.12,-0.62,-0.78), so
// when the camera orbited behind/under it faced the viewer and washed whole frames
// pink. Re-aimed to a near-horizontal lower-RIGHT direction (more +x, much less -z)
// so its lobe is a confined side accent regardless of orbit angle, and its world-
// space pull toward the viewer is far weaker on back-camera frames.
const L0x = 0.58, L0y = 0.66, L0z = 0.48; // key (warm), upper-right
const L1x = -0.82, L1y = 0.18, L1z = 0.54; // fill (cool), left/front
const L2x = 0.66, L2y = -0.44, L2z = -0.32; // rim (magenta), lower-right side accent

runTextDemo({
  title: 'chromascii — colour ASCII 3D renderer',
  hud: 'DRAG ORBIT · WHEEL ZOOM · [ ] RAMP · p PALETTE · e INK',
  captureT: 5,
  targetFps: 60,
  mouse: true,
  init: (t: CharTerm) => {
    scene = buildScene(t);
    yaw = 0;
    pitch = -0.32;
    zoom = 1.0;
    rampIdx = 0;
    paletteIdx = 0;
    inkOn = 1;
    interactT = -1e9;
    dragging = false;
    dragPrevX = -1;
    dragPrevY = -1;
  },
  resize: (t: CharTerm) => {
    scene = buildScene(t);
  },
  onKey: (key: string, t: CharTerm) => {
    void t;
    if (key === '[' || key === 'left') rampIdx = (rampIdx + RAMPS.length - 1) % RAMPS.length;
    else if (key === ']' || key === 'right') rampIdx = (rampIdx + 1) % RAMPS.length;
    else if (key === 'p' || key === 'down') paletteIdx = (paletteIdx + 1) % PALETTES.length;
    else if (key === 'P' || key === 'up') paletteIdx = (paletteIdx + PALETTES.length - 1) % PALETTES.length;
    else if (key === 'e' || key === ' ') inkOn = inkOn ? 0 : 1;
    else if (key === '+' || key === '=') zoom = Math.min(2.4, zoom * 1.08);
    else if (key === '-' || key === '_') zoom = Math.max(0.55, zoom / 1.08);
    // A key counts as interaction → frame() resets the attract idle timer.
    keyTouched = true;
  },
  frame: (t: CharTerm, time: number) => {
    const sc = scene && scene.cols === t.cols && scene.rows === t.rows ? scene : (scene = buildScene(t));
    renderFrame(t, sc, time);
  },
});

const renderFrame = (t: CharTerm, sc: Scene, time: number): void => {
  // ── Interaction: mouse drag orbit + wheel zoom (LIVE only — capture has none) ──
  if (t.wheel !== 0) {
    zoom = Math.max(0.55, Math.min(2.4, zoom * Math.pow(1.12, t.wheel)));
    t.wheel = 0;
    interactT = time;
  }
  if (t.mouseDown && t.mouseInside) {
    if (!dragging) {
      dragging = true;
      dragPrevX = t.mouseX;
      dragPrevY = t.mouseY;
    } else {
      const dx = t.mouseX - dragPrevX;
      const dy = t.mouseY - dragPrevY;
      dragPrevX = t.mouseX;
      dragPrevY = t.mouseY;
      yaw += dx * 0.045;
      pitch += dy * 0.05;
      pitch = Math.max(-1.35, Math.min(1.35, pitch));
    }
    interactT = time;
  } else {
    dragging = false;
  }
  if (keyTouched) {
    interactT = time;
    keyTouched = false;
  }

  // ── Attract: idle for >3s (or capture/bench) → drive a turntable + morph ──────
  const idle = time - interactT;
  const attract = idle > 3.0;
  // Effective camera: in attract, gently override yaw/pitch/zoom from time so a
  // capture always lands on a lit, rotating form. When the user is active we use
  // their values verbatim.
  let camYaw = yaw;
  let camPitch = pitch;
  let camZoom = zoom;
  if (attract) {
    camYaw = yaw + time * 0.42;
    camPitch = -0.22 + 0.40 * Math.sin(time * 0.31);
    // Zoom in so the form fills the canvas instead of floating in a black void,
    // but not so far that every cell marches (keeps a healthy reject margin).
    camZoom = 1.72 + 0.16 * Math.sin(time * 0.23);
  }

  // ── Per-frame scene morph (deterministic, time-driven) ────────────────────────
  kP = 2;
  kQ = 3;
  kTwist = time * 0.6;
  kMajor = 0.62 + 0.04 * Math.sin(time * 0.5);
  kTube = 0.22 + 0.05 * (0.5 + 0.5 * Math.sin(time * 0.9));
  // Slow breathing morph toward the metaball blob and back. A squared envelope
  // keeps the form a clean, legible knot most of the time (cheap, short-circuits
  // the blob) and only briefly swells toward the metaball — the hero is the knot.
  const morphPhase = 0.5 - 0.5 * Math.cos(time * 0.18); // 0..1
  kMorph = morphPhase * morphPhase * 0.45;
  blobPulse = 0.5 + 0.5 * Math.sin(time * 1.3);
  // Metaball centres orbit.
  for (let i = 0; i < 4; i++) {
    const ph = (i / 4) * 2 * PI + time * (0.5 + i * 0.13);
    const rr = 0.42 + 0.12 * Math.sin(time * 0.7 + i);
    mbx[i] = rr * Math.cos(ph);
    mby[i] = 0.34 * Math.sin(time * 0.9 + i * 1.7);
    mbz[i] = rr * Math.sin(ph * 1.3 + i);
    mbr[i] = 0.34 + 0.1 * blobPulse + 0.04 * i;
  }

  // ── Camera basis ──────────────────────────────────────────────────────────────
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  const cy = Math.cos(camYaw), sy = Math.sin(camYaw);
  // Camera orbit position around origin at distance D.
  const D = 3.0 / camZoom;
  const camX = D * cp * sy;
  const camY = D * sp;
  const camZ = D * cp * cy;
  // Forward = -camPos normalised (look at origin).
  let fwdX = -camX, fwdY = -camY, fwdZ = -camZ;
  const fl = 1 / Math.sqrt(fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ);
  fwdX *= fl; fwdY *= fl; fwdZ *= fl;
  // Right = normalize(cross(worldUp=(0,1,0), fwd)) = normalize(fwd.z, 0, -fwd.x).
  let rX = fwdZ;
  let rY = 0;
  let rZ = -fwdX;
  const rl = 1 / Math.sqrt(rX * rX + rY * rY + rZ * rZ + 1e-9);
  rX *= rl; rY *= rl; rZ *= rl;
  // Up = cross(fwd, right).
  const uX = fwdY * rZ - fwdZ * rY;
  const uY = fwdZ * rX - fwdX * rZ;
  const uZ = fwdX * rY - fwdY * rX;

  // Aspect: terminal cells are ~2:1 (tall), so scale the vertical FOV.
  const cols = sc.cols;
  const rows = sc.rows;
  const ssx = sc.ssx;
  const ssy = sc.ssy;
  const aspect = cols / (rows * 2.0); // account for cell tallness
  const fov = 1.15;

  const lum = sc.lum;
  const dep = sc.dep;
  const hue = sc.hue;
  const satv = sc.satv;
  const valv = sc.valv;
  const hit = sc.hit;

  const pal = PALETTES[paletteIdx];

  // ── Adaptive raymarch: a coarse 1-ray-per-cell pass drives selective 2×2 SS ────
  // We zero the accumulators, march ONE centre ray per cell (coarse occupancy), then
  // only the cells on a silhouette / depth seam pay for the full 2×2 supersample —
  // flat interior and background cells keep their single centre sample. This is the
  // big ROUND-3 win: instead of cols*rows*4 marches unconditionally, the interior
  // costs 1 march/cell and only the thin boundary band costs the extra 3 corners.
  const N = cols * rows;
  for (let i = 0; i < N; i++) {
    lum[i] = 0; dep[i] = 0; hue[i] = 0; satv[i] = 0; valv[i] = 0; hit[i] = 0;
  }

  const invSSx = 1 / ssx;
  const invSSy = 1 / ssy;
  const ssArea = 1 / (SS * SS);
  const chit = sc.chit;
  const cdep = sc.cdep;

  // March a normalised ray from the camera; returns hitT (>0) or -1 on miss. Uses
  // DEPTH-AWARE ADAPTIVE STEPPING: each step is scaled toward 1.0 of the SDF
  // distance as the ray penetrates deeper, where the projected cell footprint grows
  // and fine detail no longer resolves — so far/empty span is crossed in fewer
  // steps while the near surface (where the silhouette lives) keeps a conservative
  // 0.9 factor that will not tunnel the thin tube. The over-relaxation that
  // tunnelled in round 2 used factors >1; this stays ≤1 and is purely an early-span
  // accelerator. Also reports the near-bound depth so the coarse pass can detect
  // depth seams without re-deriving it.
  const marchRay = (dirX: number, dirY: number, dirZ: number): number => {
    const tca = -(camX * dirX + camY * dirY + camZ * dirZ);
    const ox = camX + dirX * tca, oy = camY + dirY * tca, oz = camZ + dirZ * tca;
    const closest2 = ox * ox + oy * oy + oz * oz;
    if (closest2 > BSPHERE2) return -1;
    const half = Math.sqrt(BSPHERE2 - closest2);
    let tRay = tca - half;
    if (tRay < 0.01) tRay = 0.01;
    const maxT = tca + half + 0.05;
    for (let s = 0; s < 32; s++) {
      const px = camX + dirX * tRay;
      const py = camY + dirY * tRay;
      const pz = camZ + dirZ * tRay;
      const d = sceneSDF(px, py, pz);
      if (d < 0.005) return tRay;
      // Step factor ramps 0.9 → 1.0 with distance, but never above 1.0 (no tunnel).
      const f = d > 0.18 ? 0.985 : 0.9;
      tRay += d * f;
      if (tRay > maxT) return -1;
    }
    return -1;
  };

  // Shade a confirmed hit along (dirX,dirY,dirZ) at distance hitT and ADD its
  // weighted contribution into cell `ci`. Pure function of the hit geometry + the
  // per-frame camera/light/palette closure — identical maths to before, just
  // factored so both the coarse centre sample and the 2×2 corners can call it.
  const shadeHit = (
    dirX: number, dirY: number, dirZ: number, hitT: number, ci: number, w: number,
  ): void => {
    const hx = camX + dirX * hitT;
    const hy = camY + dirY * hitT;
    const hz = camZ + dirZ * hitT;
    // Normal via the 4-tap tetrahedron gradient (4 SDF evals, not 6).
    const e = 0.013;
    const d1 = sceneSDF(hx + e, hy - e, hz - e);
    const d2 = sceneSDF(hx - e, hy - e, hz + e);
    const d3 = sceneSDF(hx - e, hy + e, hz - e);
    const d4 = sceneSDF(hx + e, hy + e, hz + e);
    const nx = d1 - d2 - d3 + d4;
    const ny = -d1 - d2 + d3 + d4;
    const nz = -d1 + d2 - d3 + d4;
    const nl = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + 1e-12);
    const Nx = nx * nl, Ny = ny * nl, Nz = nz * nl;

    // View vector (toward camera).
    const vx = -dirX, vy = -dirY, vz = -dirZ;

    // Three coloured lights (lambert), each wrapped a touch so terminator gradients
    // stay rich. The cool fill is wrapped LESS (so its teal claims a sharper region)
    // and the magenta rim is squared+confined so it stays an accent, not a wash.
    // ROUND-3: the warm key gets a gentle wrap too, so its amber bleeds a little
    // past the terminator onto back/under faces — that keeps the magenta rim from
    // OWNING those orbits and preserves the tri-tone balance from every angle.
    const ndl0raw = Nx * L0x + Ny * L0y + Nz * L0z;
    const ndl0 = Math.max(0, 0.18 + 0.82 * ndl0raw); // lightly-wrapped warm key
    const ndl1raw = Nx * L1x + Ny * L1y + Nz * L1z;
    const ndl1 = Math.max(0, 0.42 + 0.58 * ndl1raw) * 0.95; // wrapped cool fill
    const ndl2 = Math.max(0, Nx * L2x + Ny * L2y + Nz * L2z);
    // Half-vectors for a tight key spec. Power 32 via repeated squaring (5 mults)
    // instead of Math.pow — same look, much cheaper in the hot loop.
    let hX = L0x + vx, hY2 = L0y + vy, hZ = L0z + vz;
    const hl = 1 / Math.sqrt(hX * hX + hY2 * hY2 + hZ * hZ + 1e-9);
    hX *= hl; hY2 *= hl; hZ *= hl;
    let sp0 = Nx * hX + Ny * hY2 + Nz * hZ;
    if (sp0 < 0) sp0 = 0;
    sp0 *= sp0; sp0 *= sp0; sp0 *= sp0; sp0 *= sp0; sp0 *= sp0; // ^32
    const spec = sp0 * 1.1;

    // Fresnel rim for a luminous silhouette edge — a tight (1-ndv)^4 falloff so it
    // reads as a thin glowing lip on the true silhouette, not a broad pink wash.
    const ndv = Math.max(0, Nx * vx + Ny * vy + Nz * vz);
    const fr0 = 1 - ndv;
    const fr2 = fr0 * fr0;
    const fres = fr2 * fr2; // (1-ndv)^4

    // Per-channel HDR colour from the three coloured lights. ROUND-3: the magenta
    // rim lambert is squared to tighten its lobe and its weight cut so back/under
    // orbits don't go pink; the fresnel lip is trimmed to a thinner silhouette glow.
    // ROUND-4: the residual left-band magenta lean came from the rim's still-broad
    // squared lobe plus a fresnel lip that fires on EVERY silhouette regardless of
    // light side. Cube the lambert (ndl2^3) so the magenta confines to a tighter
    // patch facing the rim light, and trim the fresnel rim (0.30→0.22) so the left
    // silhouette — which faces AWAY from the rim — no longer picks up a pink lip.
    const ndl2t = ndl2 * ndl2 * ndl2;
    const kw = 1.0 * ndl0, kf = 1.0 * ndl1, kr = 0.34 * ndl2t + fres * 0.22;
    let rr = kw * pal.warm[0] + kf * pal.fill[0] + kr * pal.rim[0] + spec;
    let gg = kw * pal.warm[1] + kf * pal.fill[1] + kr * pal.rim[1] + spec;
    let bb = kw * pal.warm[2] + kf * pal.fill[2] + kr * pal.rim[2] + spec;
    // Cool ambient so shadows aren't black and read as deep blue, not grey.
    rr += 0.05; gg += 0.07; bb += 0.13;

    // Tonemap each channel so saturated colour survives into the highlights.
    const tr = aces(rr * 1.25), tg = aces(gg * 1.25), tb = aces(bb * 1.25);

    // Luminance for the glyph ramp (perceptual on the tonemapped colour).
    const L = 0.299 * tr + 0.587 * tg + 0.114 * tb;

    // Depth (normalised 0..1) for atmospheric cues.
    const dn = clamp01((hitT - (D - 1.7)) / 3.4);

    // Derive hue & saturation FROM the lit rgb — so a teal-lit face reads teal, a
    // magenta rim reads magenta, an amber key reads amber.
    const mx = tr > tg ? (tr > tb ? tr : tb) : tg > tb ? tg : tb;
    const mn = tr < tg ? (tr < tb ? tr : tb) : tg < tb ? tg : tb;
    const chroma = mx - mn;
    let hh: number;
    if (chroma < 1e-4) hh = pal.hueBase;
    else if (mx === tr) hh = ((tg - tb) / chroma) / 6;
    else if (mx === tg) hh = (2 + (tb - tr) / chroma) / 6;
    else hh = (4 + (tr - tg) / chroma) / 6;
    if (hh < 0) hh += 1;
    // Nudge toward the palette identity + a faint depth wash so far parts cool.
    hh = hh + pal.hueSpan * 0.12 * (Ny * 0.5 + 0.5) - 0.04 * dn;
    // Saturation: from the lit chroma, lifted by the palette's character.
    const satFromRgb = mx > 1e-4 ? chroma / mx : 0;
    const ss = clamp01(0.35 + 0.65 * satFromRgb) * pal.sat;

    lum[ci] += L * w;
    dep[ci] += dn * w;
    hue[ci] += hh * w;
    // Saturation drops in the bright spec highlight (looks like a hot reflection).
    satv[ci] += (ss * (1 - 0.6 * clamp01(spec))) * w;
    // Value from tonemapped luminance.
    valv[ci] += clamp01(mx * 1.05) * w;
  };

  // The NDC of a cell's CENTRE (sub-sample at SS/2 offset = cell midpoint).
  const cellNdcY = (row: number): number => (1 - 2 * ((row + 0.5) / rows)) / fov;
  const cellNdcX = (col: number): number => ((2 * ((col + 0.5) / cols) - 1) * aspect) / fov;

  // ── Pass A: coarse centre sample per cell → occupancy + depth ─────────────────
  for (let row = 0; row < rows; row++) {
    const ndcY = cellNdcY(row);
    const rowBase = row * cols;
    for (let col = 0; col < cols; col++) {
      const ci = rowBase + col;
      const ndcX = cellNdcX(col);
      let dirX = fwdX + rX * ndcX + uX * ndcY;
      let dirY = fwdY + rY * ndcX + uY * ndcY;
      let dirZ = fwdZ + rZ * ndcX + uZ * ndcY;
      const dl = 1 / Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
      dirX *= dl; dirY *= dl; dirZ *= dl;
      const hitT = marchRay(dirX, dirY, dirZ);
      if (hitT < 0) {
        chit[ci] = 0;
        cdep[ci] = 1;
      } else {
        chit[ci] = 1;
        cdep[ci] = clamp01((hitT - (D - 1.7)) / 3.4);
      }
    }
  }

  // ── Pass B: resolve each cell, supersampling only the boundary band ───────────
  // A cell is a BOUNDARY cell if its coarse hit-state differs from any 4-neighbour,
  // or it shares a surface with a neighbour across a steep depth seam. Those cells
  // get the full 2×2 average for clean anti-aliased edges; every other cell takes
  // its single centre sample at weight 1 (4× cheaper). Determinism is preserved:
  // the decision is a pure function of the coarse field, which is itself
  // deterministic in time.
  for (let row = 0; row < rows; row++) {
    const ndcYc = cellNdcY(row);
    const rowBase = row * cols;
    for (let col = 0; col < cols; col++) {
      const ci = rowBase + col;
      const ch0 = chit[ci];
      // Neighbour coarse states (clamped at edges to self → never a false boundary).
      const cu = row > 0 ? chit[ci - cols] : ch0;
      const cd = row < rows - 1 ? chit[ci + cols] : ch0;
      const clf = col > 0 ? chit[ci - 1] : ch0;
      const crt = col < cols - 1 ? chit[ci + 1] : ch0;
      let boundary = ch0 !== cu || ch0 !== cd || ch0 !== clf || ch0 !== crt;
      if (!boundary && ch0 === 1) {
        // Surface interior: also supersample where the depth changes fast (a crease
        // or a self-occlusion seam) so those edges stay crisp.
        const d0 = cdep[ci];
        const du = row > 0 ? cdep[ci - cols] : d0;
        const dd = row < rows - 1 ? cdep[ci + cols] : d0;
        const dl2 = col > 0 ? cdep[ci - 1] : d0;
        const dr2 = col < cols - 1 ? cdep[ci + 1] : d0;
        const gxd = dl2 - dr2, gyd = du - dd;
        if (gxd * gxd + gyd * gyd > 0.0016) boundary = true;
      }

      if (ch0 === 0 && !boundary) {
        // Background interior: nothing to shade; mark it a full miss.
        dep[ci] = 1;
        continue;
      }

      if (!boundary) {
        // Flat surface interior: shade the single centre ray at full weight.
        const ndcX = cellNdcX(col);
        let dirX = fwdX + rX * ndcX + uX * ndcYc;
        let dirY = fwdY + rY * ndcX + uY * ndcYc;
        let dirZ = fwdZ + rZ * ndcX + uZ * ndcYc;
        const dl = 1 / Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
        dirX *= dl; dirY *= dl; dirZ *= dl;
        const hitT = marchRay(dirX, dirY, dirZ);
        if (hitT < 0) { dep[ci] = 1; continue; }
        shadeHit(dirX, dirY, dirZ, hitT, ci, 1);
        hit[ci] = SS * SS; // fully-covered cell
        continue;
      }

      // Boundary cell: true 2×2 supersample averaged for an anti-aliased edge.
      let hitCount = 0;
      for (let sj = 0; sj < SS; sj++) {
        const ndcY = (1 - 2 * ((row * SS + sj + 0.5) * invSSy)) / fov;
        for (let si = 0; si < SS; si++) {
          const ndcX = ((2 * ((col * SS + si + 0.5) * invSSx) - 1) * aspect) / fov;
          let dirX = fwdX + rX * ndcX + uX * ndcY;
          let dirY = fwdY + rY * ndcX + uY * ndcY;
          let dirZ = fwdZ + rZ * ndcX + uZ * ndcY;
          const dl = 1 / Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
          dirX *= dl; dirY *= dl; dirZ *= dl;
          const hitT = marchRay(dirX, dirY, dirZ);
          if (hitT < 0) { dep[ci] += ssArea; continue; }
          shadeHit(dirX, dirY, dirZ, hitT, ci, ssArea);
          hitCount++;
        }
      }
      hit[ci] = hitCount; // 0..SS*SS sub-samples that hit
    }
  }

  // ── Sobel edge pass over the resolved per-cell luminance (for contour ink) ─────
  // Compute on luminance + depth discontinuity. Reuse the dep array as depth field.
  // We need scratch for edge magnitude/dir; reuse hue? No — hue is needed. Allocate
  // once in scene? We can compute edges inline per cell using neighbour reads from
  // lum/dep without extra buffers (read-only neighbour sampling, no write hazard
  // because we write the final glyph straight into the CharTerm, not into lum/dep).

  // ── Compose into the character grid ───────────────────────────────────────────
  t.clear(2, 2, 5);
  const ramp = RAMP_CODE[rampIdx];
  const rampMax = ramp.length - 1;

  // Backdrop: a centred radial glow tinted by the palette's key+rim, so empty
  // cells aren't dead black and the form sits in a soft pool of its own colour.
  // SEPARABLE so it's branch-free: glow ≈ gx[x] * gy[y] (precomputed once/frame),
  // no sqrt/pow in the per-cell loop. gx/gy are 1 at centre, →0 at the edges.
  const cxh = (cols - 1) * 0.5;
  const cyh = (rows - 1) * 0.5;
  const invCx = 1 / (cxh + 1e-6);
  const invCy = 1 / (cyh + 1e-6);
  const gxArr = sc.gx;
  const gyArr = sc.gy;
  for (let x = 0; x < cols; x++) {
    const u = (x - cxh) * invCx; // -1..1
    const f = 1 - u * u;
    gxArr[x] = f > 0 ? f : 0;
  }
  for (let y = 0; y < rows; y++) {
    const v = (y - cyh) * invCy;
    const f = 1 - v * v;
    gyArr[y] = f > 0 ? f : 0;
  }
  // Pool colour blends all three lights (key + fill + rim) so the backdrop carries
  // the palette's full chromatic identity, not just the warm/rim mix — a teal cast
  // toward one side, amber toward the other, deep indigo in the corners.
  const glowR = pal.warm[0] * 0.42 + pal.fill[0] * 0.30 + pal.rim[0] * 0.28;
  const glowG = pal.warm[1] * 0.42 + pal.fill[1] * 0.30 + pal.rim[1] * 0.28;
  const glowB = pal.warm[2] * 0.42 + pal.fill[2] * 0.30 + pal.rim[2] * 0.28;
  for (let y = 0; y < rows; y++) {
    const rowBase = y * cols;
    const gyv = gyArr[y];
    for (let x = 0; x < cols; x++) {
      const ci = rowBase + x;
      const isHit = hit[ci] > 0;
      if (!isHit) {
        // gamma>1 on the separable parabola tightens the pool into a luminous core
        // with a soft, clean falloff to near-black at the frame edge.
        let glow = gxArr[x] * gyv;
        glow = glow * glow * (3 - 2 * glow); // smoothstep — richer centre, cleaner edge
        const bgr = (5 + 58 * glow * glowR) | 0;
        const bgg = (5 + 56 * glow * glowG) | 0;
        const bgb = (12 + 50 * glow * glowB) | 0;
        t.put(x, y, ' ', [40, 40, 50], [bgr, bgg, bgb]);
        continue;
      }
      const bgr = 4, bgg = 4, bgb = 10;

      const L = lum[ci];
      // Glyph from luminance ramp, with a 4×4 ordered dither so smooth bright bands
      // break into a stippled gradient between adjacent ramp glyphs instead of a
      // flat block of the top glyph. ROUND-4: the dither amplitude is widened to
      // ±0.75 (×1.5) so a perfectly flat mid-luminance band on a BACK angle — which
      // at ±0.5 still quantised to one solid ramp index and read as a mechanical
      // '====' ruler — now straddles the quantisation boundary and stipples between
      // adjacent glyphs ('-'/'='/'+'), breaking the long identical runs. Still purely
      // ordered (a function of x,y) so the capture stays exact and there's no noise.
      const dith = BAYER4[((y & 3) << 2) | (x & 3)] * 1.5;
      let gi = (clamp01(L * 1.25) * rampMax + 0.5 + dith) | 0;
      if (gi < 0) gi = 0; else if (gi > rampMax) gi = rampMax;

      // Colour: hsv(hue, sat, value) then a tiny aces guard already applied in val.
      const hh = hue[ci];
      const ssN = clamp01(satv[ci]);
      let vv = valv[ci];
      // Lift mid-tones so the colour reads vividly across the whole form.
      vv = clamp01(0.24 + 0.92 * vv);
      const col = hsv(hh, ssN, vv);

      // Darker bg behind the glyph for contrast, deepened by depth so far parts of
      // the form recede into shadow (a cheap atmospheric depth cue).
      const dn = dep[ci];
      const bgDim = 1 - 0.5 * dn;
      const bg: RGB = [
        (col[0] * 0.10 * bgDim + bgr * 0.5) | 0,
        (col[1] * 0.10 * bgDim + bgg * 0.5) | 0,
        (col[2] * 0.12 * bgDim + bgb * 0.6) | 0,
      ];

      let cp = ramp[gi];
      let useBold = L > 0.6;

      // ── Contour ink: a Sobel on the lit luminance overlaid with directional line
      // glyphs that follow the EDGE TANGENT (perpendicular to the gradient), so the
      // strokes connect into a continuous inked outline instead of a scatter of
      // punctuation. Two cases:
      //   • internal crease  — a luminance ridge between two surface cells → a fine
      //     directional line, the engraving that gives the form its hand-inked feel;
      //   • outer silhouette — the surface meeting the background → a bolder, brighter
      //     directional stroke; only a near-vertical boundary becomes a round ( ), so
      //     the parens stay a rare flourish, never a ring around the whole shape.
      if (inkOn && x > 0 && x < cols - 1 && y > 0 && y < rows - 1) {
        const up = (y - 1) * cols + x, dn2 = (y + 1) * cols + x;
        const lf = y * cols + (x - 1), rt = y * cols + (x + 1);
        const i00 = lumOrFar(lum, hit, (y - 1) * cols + (x - 1));
        const i01 = lumOrFar(lum, hit, up);
        const i02 = lumOrFar(lum, hit, (y - 1) * cols + (x + 1));
        const i10 = lumOrFar(lum, hit, lf);
        const i12 = lumOrFar(lum, hit, rt);
        const i20 = lumOrFar(lum, hit, (y + 1) * cols + (x - 1));
        const i21 = lumOrFar(lum, hit, dn2);
        const i22 = lumOrFar(lum, hit, (y + 1) * cols + (x + 1));
        const gx = i00 + 2 * i10 + i20 - i02 - 2 * i12 - i22;
        const gy = i00 + 2 * i01 + i02 - i20 - 2 * i21 - i22;
        const mag2 = gx * gx + gy * gy;
        // Whether this surface cell touches the background — distinguishes the outer
        // silhouette (bright outline) from interior creases (fine engraving).
        const onEdge = hit[up] === 0 || hit[dn2] === 0 || hit[lf] === 0 || hit[rt] === 0;
        // Silhouette gets a low bar (any boundary); interior creases need a real
        // ridge. Compared squared so there's no sqrt in the hot path.
        const inkIt = onEdge ? mag2 > 0.09 : mag2 > 0.38;
        if (inkIt) {
          // Quantise gradient direction to one of 8 (branch-free, no atan2); the
          // glyph LUT maps each direction to the perpendicular edge stroke. The
          // OUTER silhouette uses the narrow-band classifier so a gently-curving top
          // reads as flowing diagonals rather than one long flat -/_ run.
          const dir = onEdge ? octantSil(gx, gy) : octant(gx, gy);
          cp = EDGE_BY_DIR[dir];
          useBold = true;
          if (onEdge) {
            // Round outline glyph only where the silhouette runs near-vertical
            // (dir 0/4 → '|'): the curved sides read as ( ), the rest as crisp
            // / \ _ - strokes — a connected outline, not a paren halo.
            if (dir === 0 || dir === 4) {
              cp = hit[rt] === 0 ? PAREN_R : PAREN_L;
            } else if (dir === 2 || dir === 6) {
              // Truly horizontal silhouette: keep the LUT's '_'/'-' lip, but where
              // the silhouette HEIGHT steps between this cell's neighbours (a curve
              // crest, not a dead-flat run) swap in a soft '~' swell. That breaks the
              // long mechanical -/_ ruler into a gently undulating curved lip while
              // the genuinely flat spans stay clean. '_' '-' '~' are all font glyphs.
              const stepLeft = (hit[lf - cols] === 0) !== (hit[lf + cols] === 0);
              const stepRight = (hit[rt - cols] === 0) !== (hit[rt + cols] === 0);
              if (stepLeft || stepRight) cp = 0x007e; // ~ where the silhouette height steps
            }
            // Outer silhouette ink: brighten strongly for a luminous lip.
            col[0] = Math.min(255, (col[0] * 0.72 + 96) | 0);
            col[1] = Math.min(255, (col[1] * 0.72 + 98) | 0);
            col[2] = Math.min(255, (col[2] * 0.72 + 108) | 0);
          } else {
            // Interior crease: a gentler lift so it engraves without bleaching colour.
            col[0] = Math.min(255, (col[0] * 0.88 + 44) | 0);
            col[1] = Math.min(255, (col[1] * 0.88 + 46) | 0);
            col[2] = Math.min(255, (col[2] * 0.88 + 52) | 0);
          }
        }
      }
      t.put(x, y, cp, col, bg, useBold);
    }
  }

  // ── On-screen status chrome (left side; FPS/HUD owned by engine top-right) ─────
  const pal2 = PALETTES[paletteIdx];
  const status = ` chromascii  ${attract ? 'ATTRACT' : 'LIVE'}  ramp ${rampIdx + 1}/${RAMPS.length}  ${pal2.name}  ink ${inkOn ? 'ON' : 'OFF'}  zoom ${camZoomLabel(camZoom)} `;
  if (rows > 1) {
    const by = rows - 1;
    t.fillRect(0, by, cols, 1, [10, 10, 16]);
    t.text(1, by, clip(status, cols - 2), [200, 205, 220], [10, 10, 16], true);
  }
};

// Luminance for the Sobel pass: hits use their luminance, misses read as 0 (so the
// silhouette against background produces a strong gradient).
const lumOrFar = (lum: Float32Array, hit: Uint8Array, idx: number): number =>
  hit[idx] > 0 ? lum[idx] : 0;

const camZoomLabel = (z: number): string => {
  const v = Math.round(z * 100) / 100;
  return v.toFixed(2);
};

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));
