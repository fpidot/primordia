// tests/dig-emergence.test.js — verifies wall manipulation actually fires.
//
// This is a *liveness* check, not a regression bound: we just want to confirm
// that with the wall-proximity sensors and lowered dig threshold, at least
// some particles dig or deposit during a 3000-tick maze run. If this stays
// at zero, the trait is dead in the water.

import { seedGlobalRandom, runSim, captureMetrics, assert,
         dumpMetrics, runTest } from './harness.js';

seedGlobalRandom(0xD16D16);

const { World, WALL_SOLID } = await import('../js/sim.js');
const { PRESETS } = await import('../js/presets.js');

await runTest('dig-emergence: maze 3k ticks → some wall activity', async () => {
  const world = new World({ maxParticles: 1500 });
  PRESETS.maze(world);
  const wallsBefore = world._wallCount;
  const versionBefore = world._wallsVersion;

  await runSim(world, 3000, { reportEvery: 1000 });

  const wallsAfter = world._wallCount;
  const versionAfter = world._wallsVersion;
  const carryingNow = world.particles.filter(p => !p.dead && p.wallCarry > 0).length;

  console.log(`\n  walls: before=${wallsBefore} after=${wallsAfter} ` +
              `delta=${wallsAfter - wallsBefore}`);
  console.log(`  versionDelta=${versionAfter - versionBefore} ` +
              `carryingNow=${carryingNow}`);

  // Liveness: either (a) wall count changed, (b) wall version bumped past
  // initial setup, or (c) particles are actively carrying. Any one is fine.
  const activity = (wallsAfter !== wallsBefore) ||
                   (versionAfter > versionBefore + 1) ||
                   (carryingNow > 0);
  assert('some wall activity', activity,
         'no dig/deposit events in 3000 ticks of maze');

  // Sanity — pop didn't crash
  const m = captureMetrics(world);
  console.log('\n  final metrics:');
  console.log(dumpMetrics(m));
  assert('pop survived', m.n > 100);
});
