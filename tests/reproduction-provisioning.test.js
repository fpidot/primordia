// tests/reproduction-provisioning.test.js - offspring start viable, not wealthy.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xB17A5EED);

const {
  World, CELL,
  OFFSPRING_BASE_ENERGY, OFFSPRING_MAX_ENERGY, OFFSPRING_SEX_MAX_ENERGY,
  offspringEndowmentForEnergy,
} = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { OUT_WANT_MATE } = await import('../js/brain.js');

function quietGenome(species = 0) {
  const g = makeGenome(species);
  g.attraction.fill(0);
  g.cohesion = 0;
  g.metab = 0.005;
  g.efficiency = 0.1;
  g.repro_thresh = 7;
  g.brain.enabled.fill(0);
  g.brain.biasO.fill(0);
  return g;
}

function matingGenome(species = 0) {
  const g = quietGenome(species);
  g.brain.biasO[OUT_WANT_MATE] = 2;
  return g;
}

await runTest('reproduction provisioning: surplus helps but child reserves are capped', () => {
  const barelyReady = offspringEndowmentForEnergy(8, 7);
  const rich = offspringEndowmentForEnergy(80, 7);

  assert('barely-ready parent provisions a viable starter child', barelyReady >= OFFSPRING_BASE_ENERGY);
  assert('rich parent provisions a better-started child', rich > barelyReady);
  assert('rich parent child endowment is capped', rich <= OFFSPRING_MAX_ENERGY);
});

await runTest('reproduction provisioning: asexual births no longer split rich energy equally', async () => {
  const world = new World({ maxParticles: 8, clusterBudding: false });
  const parent = world.addParticle(40 * CELL, 40 * CELL, quietGenome(), 40);
  parent.vx = 0;
  parent.vy = 0;

  const prevRandom = Math.random;
  Math.random = () => 0;
  try {
    await world.step();
  } finally {
    Math.random = prevRandom;
  }

  const children = world.particles.filter(p => p !== parent && !p.dead);
  assert('forced asexual step creates a child', children.length >= 1);
  assert('child does not inherit rich parent reserves', children[0].energy <= OFFSPRING_MAX_ENERGY + 1e-6);
  assert('parent keeps more reserve than the newborn', parent.energy > children[0].energy);
});

await runTest('reproduction provisioning: sexual births use bounded shared reserves', async () => {
  const world = new World({ maxParticles: 8, clusterBudding: false });
  const a = world.addParticle(40 * CELL, 40 * CELL, matingGenome(0), 40);
  const b = world.addParticle(40 * CELL + 1, 40 * CELL, matingGenome(1), 30);
  a.vx = 0; a.vy = 0;
  b.vx = 0; b.vy = 0;
  a.bonds.push(b.id);
  b.bonds.push(a.id);

  const prevRandom = Math.random;
  Math.random = () => 0;
  try {
    await world.step();
  } finally {
    Math.random = prevRandom;
  }

  const children = world.particles.filter(p => p !== a && p !== b && !p.dead);
  assert('forced sexual step creates a child', children.length >= 1);
  assert(
    'sexual children do not inherit the combined parent reserve',
    children.every(p => p.energy <= OFFSPRING_SEX_MAX_ENERGY + 1e-6),
  );
  assert(
    'at least one parent remains richer than the newborns',
    Math.max(a.energy, b.energy) > children[0].energy,
  );
});
