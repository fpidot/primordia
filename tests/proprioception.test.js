// tests/proprioception.test.js - particles can sense failed motor effort.
//
// This is intentionally material-agnostic: the brain does not receive "you hit
// glass" or "you hit the edge" as a special event. It receives a body signal
// saying the previous motor command failed to turn into forward progress.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0x570CC);

const { World, CELL, GW, W, WALL_MEMBRANE } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { OUT_TX, OUT_TY, OUT_REPRO_GATE } = await import('../js/brain.js');

function eastMotorGenome() {
  const g = makeGenome(0);
  g.repro_thresh = 999;
  const b = g.brain;
  b.enabled.fill(0);
  b.biasO.fill(0);
  b.biasO[OUT_TX] = 10;
  b.biasO[OUT_TY] = 0;
  b.biasO[OUT_REPRO_GATE] = -10;
  return g;
}

await runTest('proprioception: open thrust reports progress', async () => {
  const world = new World({ maxParticles: 8 });
  const p = world.addParticle(20 * CELL + CELL * 0.5, 20 * CELL + CELL * 0.5, eastMotorGenome(), 8);
  p.vx = 0; p.vy = 0;
  await world.step();
  assert('east motor command stored', p.lastMotorX > 0.95);
  assert('open movement has forward progress', p.lastMotorProgress > 0.05, `progress=${p.lastMotorProgress}`);
  assert('open movement has less slip than blocked movement', p.lastMotorSlip < 0.95, `slip=${p.lastMotorSlip}`);
});

await runTest('proprioception: glass and world edge report failed forward motion', async () => {
  const glassWorld = new World({ maxParticles: 8 });
  const gx = 20, gy = 20;
  glassWorld.walls[gy * GW + gx + 1] = WALL_MEMBRANE;
  glassWorld._wallCount = 1;
  glassWorld._wallsVersion++;
  const p = glassWorld.addParticle(gx * CELL + CELL - 0.1, gy * CELL + CELL * 0.5, eastMotorGenome(), 8);
  p.vx = 0; p.vy = 0;
  await glassWorld.step();
  assert('glass-blocked thrust has high slip', p.lastMotorSlip > 0.9, `slip=${p.lastMotorSlip}`);
  assert('glass-blocked thrust lacks forward progress', p.lastMotorProgress <= 0.01, `progress=${p.lastMotorProgress}`);

  const edgeWorld = new World({ maxParticles: 8 });
  const q = edgeWorld.addParticle(W - 1, 30 * CELL, eastMotorGenome(), 8);
  q.vx = 0; q.vy = 0;
  await edgeWorld.step();
  assert('edge-blocked thrust has high slip', q.lastMotorSlip > 0.9, `slip=${q.lastMotorSlip}`);
  assert('edge-blocked thrust lacks forward progress', q.lastMotorProgress <= 0.01, `progress=${q.lastMotorProgress}`);
});
