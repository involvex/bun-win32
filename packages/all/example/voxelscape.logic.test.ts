/**
 * voxelscape.logic.test.ts — pure-logic assertions for the voxelscape physics
 * sandbox. Run with `bun run` (NOT `bun test`, which segfaults repo-wide on this
 * workspace). It imports only the pure exports from voxelscape.ts; main() is
 * guarded by `import.meta.main`, so importing does NOT open a window or device.
 * Prints PASS/FAIL per check and exits non-zero if any fail.
 *
 * Run: bun run packages/all/example/voxelscape.logic.test.ts
 */
import {
  B_AIR,
  B_GRAVEL,
  B_LAVA,
  B_OBSIDIAN,
  B_SAND,
  B_STONE,
  B_TNT,
  B_WATER,
  B_WOOD,
  createSim,
  isSolid,
  sweptMove,
} from './voxelscape';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}`);
    failures += 1;
  }
}

// ── Palette / properties ──────────────────────────────────────────────────────
check('stone is solid', isSolid(B_STONE) === true);
check('water is not solid', isSolid(B_WATER) === false);
check('air is not solid', isSolid(B_AIR) === false);

// ── Player physics: sweptMove ─────────────────────────────────────────────────
{
  // Solid floor at y <= 0; drop from y = 5 and land with feet ~1.0.
  const floor = (_x: number, y: number, _z: number): boolean => y <= 0;
  const r = sweptMove(1, 5, 1, 0, -50, 0, 0.6, 1.8, 0.6, 0.2, floor, 1.05);
  check('sweptMove: lands on the floor (feet ~1.0)', Math.abs(r.y - 1.0) < 0.05 && r.onGround);
}
{
  // Wall at x >= 3; moving +x stops before the body penetrates it.
  const wall = (x: number, _y: number, _z: number): boolean => x >= 3;
  const r = sweptMove(1, 2, 1, 50, 0, 0, 0.6, 1.8, 0.6, 0.2, wall, 0);
  check('sweptMove: stops at a wall', r.x < 3 - 0.3 + 1e-3 && r.hitX);
}
{
  // Floor at y<=0 plus a 1-tall step at x>=2,y==1; walking +x auto-climbs it.
  const stepWorld = (x: number, y: number, _z: number): boolean => y <= 0 || (x >= 2 && y === 1);
  const r = sweptMove(1, 1.0, 1, 8, 0, 0, 0.6, 1.8, 0.6, 0.2, stepWorld, 1.05);
  check('sweptMove: steps up a 1-block ledge', r.x > 2.0 && r.y > 1.9);
}

// ── Cellular sim: falling ─────────────────────────────────────────────────────
{
  const s = createSim(3, 8, 3);
  s.setBlock(1, 5, 1, B_SAND);
  for (let i = 0; i < 16; i += 1) s.stepTick(100000);
  check('falling: sand falls to the floor', s.getBlock(1, 0, 1) === B_SAND && s.getBlock(1, 5, 1) === B_AIR);
}
{
  const s = createSim(5, 8, 5);
  for (let x = 0; x < 5; x += 1) for (let z = 0; z < 5; z += 1) s.setBlock(x, 0, z, B_STONE);
  s.setBlock(2, 1, 2, B_STONE); // support
  s.setBlock(2, 2, 2, B_GRAVEL); // rests on the support
  for (let i = 0; i < 20; i += 1) s.stepTick(100000);
  check('falling: gravel rests on its support', s.getBlock(2, 2, 2) === B_GRAVEL);
}

// ── Cellular sim: water flow ──────────────────────────────────────────────────
{
  const s = createSim(5, 8, 5);
  for (let x = 0; x < 5; x += 1) {
    for (let z = 0; z < 5; z += 1) {
      s.setBlock(x, 0, z, B_STONE); // floor
      for (let y = 1; y < 8; y += 1) if (x === 0 || z === 0 || x === 4 || z === 4) s.setBlock(x, y, z, B_STONE); // walls
    }
  }
  for (let p = 0; p < 14; p += 1) {
    s.setBlock(2, 7, 2, B_WATER);
    for (let k = 0; k < 6; k += 1) s.stepTick(100000);
  }
  for (let k = 0; k < 300; k += 1) s.stepTick(100000);
  check('water: reaches the basin floor', s.getBlock(2, 1, 2) === B_WATER);
  check('water: spreads to a far corner', s.getBlock(3, 1, 3) === B_WATER);
}

// ── Cellular sim: lava + water → obsidian/stone ───────────────────────────────
{
  const s = createSim(4, 4, 4);
  s.setBlock(1, 1, 1, B_LAVA);
  s.setBlock(2, 1, 1, B_WATER);
  for (let i = 0; i < 10; i += 1) s.stepTick(100000);
  check('lava+water: solidifies', s.getBlock(1, 1, 1) === B_OBSIDIAN || s.getBlock(2, 1, 1) !== B_WATER);
}

// ── Cellular sim: fire spread + burnout ───────────────────────────────────────
{
  const s = createSim(6, 3, 3);
  for (let x = 0; x < 6; x += 1) s.setBlock(x, 0, 0, B_WOOD);
  s.ignite(0, 0, 0);
  for (let i = 0; i < 600; i += 1) s.stepTick(100000);
  check('fire: spreads then consumes the row', s.getBlock(5, 0, 0) === B_AIR);
}

// ── Cellular sim: explosions ──────────────────────────────────────────────────
{
  const data = new Uint32Array(21 * 21 * 21).fill(B_STONE);
  const s = createSim(21, 21, 21, data);
  const r = s.explode(10, 10, 10, 5, 1.0);
  check('explode: carves a crater', s.getBlock(10, 10, 10) === B_AIR && r.destroyed.length > 50);
  check('explode: outside the radius is intact', s.getBlock(0, 0, 0) === B_STONE);
}
{
  const s = createSim(11, 5, 5);
  s.setBlock(3, 2, 2, B_OBSIDIAN);
  s.explode(3, 2, 2, 4, 1.0);
  check('explode: obsidian is blast-immune', s.getBlock(3, 2, 2) === B_OBSIDIAN);
}
{
  const s = createSim(11, 5, 5);
  s.setBlock(5, 2, 2, B_TNT);
  s.setBlock(7, 2, 2, B_TNT);
  const r = s.explode(5, 2, 2, 4, 1.0);
  check('explode: chain-lights nearby TNT', r.litTNT >= 1 && s.fuses.size >= 1);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
