// tests/long-chem-sensors.test.js - distant food/decay smell is actionable.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xC0DE57);

const { World, CELL, GW, WALL_MEMBRANE } = await import('../js/sim.js');
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

function eastMotorGenome() {
  const g = makeGenome(0);
  g.repro_thresh = 999;
  g.sense_radius = 60;
  g.sense[0] = 2.2;
  g.sense[1] = 0;
  const b = g.brain;
  b.enabled.fill(0);
  b.biasO.fill(0);
  b.biasO[OUT_TX] = 10;
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

await runTest('long-chem-sensors: hard contact slides toward tangential food scent', async () => {
  const world = new World({ maxParticles: 4 });
  const gx = 44;
  const gy = 52;
  for (let y = gy - 20; y <= gy + 20; y++) world.walls[y * GW + gx + 1] = WALL_MEMBRANE;
  world._wallCount = 41;
  world._wallsVersion++;
  const startY = gy * CELL + CELL * 0.5;
  const p = world.addParticle(gx * CELL + CELL - 0.1, startY, eastMotorGenome(), 10);
  p.vx = 0;
  p.vy = 0;
  world.field[0][(gy - 12) * GW + gx] = 5.5;

  for (let i = 0; i < 24; i++) await world.step();

  assert('particle stays on near side of glass while wall-following',
    p.x < (gx + 1) * CELL, `x=${p.x.toFixed(3)}`);
  assert('tangential food scent biases hard-contact slide north',
    p.y < startY - 1.0, `startY=${startY.toFixed(3)} y=${p.y.toFixed(3)}`);
});
