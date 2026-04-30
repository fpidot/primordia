// tests/wall-carry-death.test.js — carried wall matter has a defined fate.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xD1ED);

const { World, CELL, WALL_SOLID } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { OUT_DEPOSIT, OUT_DIG } = await import('../js/brain.js');

function dyingCarrierGenome(species = 0) {
  const g = makeGenome(species);
  g.metab = 0.5;
  g.repro_thresh = 50;
  g.brain.enabled.fill(0);
  g.brain.biasO.fill(0);
  g.brain.biasO[OUT_DEPOSIT] = -10;
  g.brain.biasO[OUT_DIG] = -10;
  return g;
}

await runTest('wall-carry-death: dying carrier drops one wall block with metadata', async () => {
  const world = new World({ maxParticles: 4 });
  const p = world.addParticle(
    40 * CELL + CELL * 0.5,
    40 * CELL + CELL * 0.5,
    dyingCarrierGenome(),
    0.02,
  );
  p.vx = 0;
  p.vy = 0;
  p.wallCarry = 2;
  const gx = (p.x / CELL) | 0;
  const gy = (p.y / CELL) | 0;

  await world.step();

  const info = world.wallInfoAt(gx, gy);
  assert('carrier died', !world.particles.some(q => q.id === p.id));
  assert('carried block became solid wall', info && info.type === WALL_SOLID);
  assert('dead carrier recorded as owner', info.ownerId === p.id && !info.ownerAlive);
  assert('drop counted as wall deposit', world.totalWallDeposits === 1);
});
