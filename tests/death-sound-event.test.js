// tests/death-sound-event.test.js — natural deaths expose gated audio events.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xDEAD);

const { World, CELL } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { OUT_DEPOSIT, OUT_DIG, OUT_REPRO_GATE } = await import('../js/brain.js');

function dyingGenome() {
  const g = makeGenome(0);
  g.metab = 0.8;
  g.repro_thresh = 50;
  g.brain.enabled.fill(0);
  g.brain.biasO.fill(0);
  g.brain.biasO[OUT_DEPOSIT] = -10;
  g.brain.biasO[OUT_DIG] = -10;
  g.brain.biasO[OUT_REPRO_GATE] = -10;
  return g;
}

await runTest('death-sound-event: natural death queues a cosmetic death event', async () => {
  const world = new World({ maxParticles: 4 });
  const p = world.addParticle(30 * CELL, 30 * CELL, dyingGenome(), 0.02);

  await world.step();

  assert('particle died', !world.particles.some(q => q.id === p.id));
  assert('death sound event queued', world._deathSoundEvents.length === 1);
  assert('death event has owner id', world._deathSoundEvents[0].id === p.id);
});

await runTest('death-sound-event: clearField drains pending cosmetic events', async () => {
  const world = new World({ maxParticles: 4 });
  world._deathSoundEvents.push({ id: 1, x: 1, y: 1 });
  world._wallSoundEvents.push({ kind: 'plop', x: 1, y: 1 });

  world.clearField();

  assert('death events cleared', world._deathSoundEvents.length === 0);
  assert('wall events cleared', world._wallSoundEvents.length === 0);
});
