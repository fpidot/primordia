// tests/food-chemotaxis.test.js - food field gradient should create motion.
//
// This isolates the non-neural genome-level food force. A neutral-brain,
// no-neighbor particle should accelerate toward a nearby food-rich cell.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xF00D);

const { World, CELL, GW } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');

function neutralFoodSeeker() {
  const g = makeGenome(0);
  g.attraction.fill(0);
  g.cohesion = 0;
  g.sense[0] = 2.0;
  g.sense[1] = 0;
  g.metab = 0.005;
  g.brain.enabled.fill(0);
  g.brain.biasO.fill(0);
  return g;
}

await runTest('food-chemotaxis: isolated particle accelerates toward adjacent food', async () => {
  const world = new World({ maxParticles: 4 });
  const gx = 40;
  const gy = 40;
  const p = world.addParticle(
    gx * CELL + CELL * 0.5,
    gy * CELL + CELL * 0.5,
    neutralFoodSeeker(),
    10,
  );
  p.vx = 0;
  p.vy = 0;
  world.field[0][gy * GW + gx + 1] = 6.0;

  await world.step();

  assert('particle moves east toward food gradient', p.vx > 0.5, `vx=${p.vx.toFixed(3)}`);
  assert('no accidental vertical pull', Math.abs(p.vy) < 0.15, `vy=${p.vy.toFixed(3)}`);
});
