// tests/baseline-maze.test.js — maze preset regression test.
//
// Verifies the new wall types load correctly and the sim continues to run
// past the wall-imposed pop bottleneck. Tighter bounds on population (the
// maze cuts the world into 4 rooms) but otherwise the same shape as soup.

import { seedGlobalRandom, runSim, captureMetrics, assertInRange,
         assert, dumpMetrics, runTest } from './harness.js';

seedGlobalRandom(0xDEADBEEF);

const { World, WALL_SOLID, WALL_MEMBRANE, WALL_POROUS } = await import('../js/sim.js');
const { PRESETS } = await import('../js/presets.js');

const TICKS = 1500;
const POP_CAP = 1200;

await runTest('baseline-maze: 1.5k ticks, multi-wall preset', async () => {
  const world = new World({ maxParticles: POP_CAP });
  PRESETS.maze(world);

  // Verify the maze actually painted multi-type walls.
  let solid = 0, membrane = 0, porous = 0;
  for (let i = 0; i < world.walls.length; i++) {
    if (world.walls[i] === WALL_SOLID) solid++;
    else if (world.walls[i] === WALL_MEMBRANE) membrane++;
    else if (world.walls[i] === WALL_POROUS) porous++;
  }
  console.log(`  walls — solid=${solid} membrane=${membrane} porous=${porous}`);
  assert('has solid walls', solid > 50);
  assert('has membrane', membrane > 30);
  assert('has porous', porous > 30);
  assertInRange('total walls', world._wallCount, solid + membrane + porous,
                solid + membrane + porous);

  await runSim(world, TICKS, { reportEvery: 500 });

  const m = captureMetrics(world);
  console.log('\n  final metrics:');
  console.log(dumpMetrics(m));

  // Looser pop bound — maze is more punishing than soup.
  assertInRange('n', m.n, 50, POP_CAP);
  assert('born > 0', m.born > 50);

  // Genome traits within sane ranges.
  assertInRange('aff.mean', m.aff.mean, -0.5, 0.6);
  assertInRange('slots.mean', m.slots.mean, 1, 8);
  assertInRange('pred.mean', m.pred.mean, -0.95, 0.95);

  // Comm should still register.
  assertInRange('comm', m.comm, 0.05, 1.0);
});
