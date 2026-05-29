/**
 * voxelscape.logic.test.ts — pure-logic assertions for the voxelscape physics
 * sandbox. Run with `bun run` (NOT `bun test`, which segfaults repo-wide on this
 * workspace). It imports only the pure exports from voxelscape.ts; main() is
 * guarded by `import.meta.main`, so importing does NOT open a window or device.
 * Prints PASS/FAIL per check and exits non-zero if any fail.
 *
 * Run: bun run packages/all/example/voxelscape.logic.test.ts
 */
import { B_AIR, B_STONE, B_WATER, isSolid } from './voxelscape';

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

// (Later tasks append checks for sweptMove, createSim, water, lava/fire, explode, entities.)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
