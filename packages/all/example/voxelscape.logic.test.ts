/**
 * voxelscape.logic.test.ts — pure-logic assertions for the voxelscape physics
 * sandbox. Run with `bun run` (NOT `bun test`, which segfaults repo-wide on this
 * workspace). It imports only the pure exports from voxelscape.ts; main() is
 * guarded by `import.meta.main`, so importing does NOT open a window or device.
 * Prints PASS/FAIL per check and exits non-zero if any fail.
 *
 * Run: bun run packages/all/example/voxelscape.logic.test.ts
 */
import { B_AIR, B_STONE, B_WATER, isSolid, sweptMove } from './voxelscape';

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

// (Later tasks append checks for createSim, water, lava/fire, explode, entities.)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
