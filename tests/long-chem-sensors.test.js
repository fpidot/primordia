// tests/long-chem-sensors.test.js - distant food/decay smell is actionable.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xC0DE57);

const { World, CELL, GW } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { N_INPUT, N_OUTPUT, OUT_TX, OUT_TY, OUT_REPRO_GATE } = await import('../js/brain.js');

function longFoodMotorGenome() {
  const g = makeGenome(0);
  g.repro_thresh = 999;
  g.sense_radius = 60;
  const b = g.brain;
  b.enabled.fill(0);
  b.enabled[0] = 1;
  b.actH[0] = 3;
  b.biasH.fill(0);
  b.biasO.fill(0);
  b.W_ih.fill(0);
  b.W_hh.fill(0);
  b.W_ho.fill(0);
  b.W_ih[64] = 5;
  b.W_ho[OUT_TX] = 4;
  b.biasO[OUT_TY] = 0;
  b.biasO[OUT_REPRO_GATE] = -10;
  return g;
}

await runTest('long-chem-sensors: distant food direction can drive motor output', async () => {
  const world = new World({ maxParticles: 4 });
  const gx = 50;
  const gy = 50;
  const p = world.addParticle(gx * CELL + CELL * 0.5, gy * CELL + CELL * 0.5, longFoodMotorGenome(), 8);
  world.field[0][gy * GW + (gx + 12)] = 5.5;

  await world.step();

  assert('test keeps the append-only input count expected by weight index 64', N_INPUT >= 72,
    `N_INPUT=${N_INPUT}`);
  assert('test keeps output count expected by OUT_TX wiring', N_OUTPUT >= 18,
    `N_OUTPUT=${N_OUTPUT}`);
  assert('long food sensor drove an eastward motor command', p.lastMotorX > 0.75,
    `lastMotorX=${p.lastMotorX}`);
});
