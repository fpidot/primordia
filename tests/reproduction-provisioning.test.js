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

function makeNamedCluster(world, energy = 40) {
  const ps = [];
  const cx = 42 * CELL;
  const cy = 42 * CELL;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const p = world.addParticle(cx + Math.cos(a) * 7, cy + Math.sin(a) * 7, quietGenome(i % 2), energy);
    p.vx = 0;
    p.vy = 0;
    ps.push(p);
  }
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    const b = ps[(i + 1) % ps.length];
    a.bonds.push(b.id);
    b.bonds.push(a.id);
  }
  world.updateClusters();
  return ps;
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

await runTest('reproduction provisioning: clustered cell births attach to the organism', async () => {
  const world = new World({ maxParticles: 24 });
  const parents = makeNamedCluster(world, 40);
  const cluster = world._clusters[0];
  const rootId = cluster.organismRootId;
  const generation = cluster.organismGeneration;

  const prevRandom = Math.random;
  Math.random = () => 0;
  try {
    await world.step();
  } finally {
    Math.random = prevRandom;
  }

  const children = world.particles.filter(p => !parents.includes(p) && !p.dead);
  assert('clustered parents produce somatic children', children.length > 0);
  assert('cluster cell births are counted', world.totalClusterCellBirths === children.length);
  assert('somatic children keep the organism root', children.every(p => p.organismRootId === rootId));
  assert('somatic children keep the organism generation', children.every(p => p.organismGeneration === generation));
  assert('somatic children are born bonded into the body', children.every(p => p.bonds.length > 0));
});

await runTest('reproduction provisioning: clustered cell births wait for bond capacity', async () => {
  const world = new World({ maxParticles: 24 });
  const parents = makeNamedCluster(world, 40);
  for (let i = 0; i < parents.length; i++) {
    const a = parents[i];
    const b = parents[(i + 2) % parents.length];
    const c = parents[(i + parents.length - 2) % parents.length];
    if (!a.bonds.includes(b.id)) a.bonds.push(b.id);
    if (!b.bonds.includes(a.id)) b.bonds.push(a.id);
    if (!a.bonds.includes(c.id)) a.bonds.push(c.id);
    if (!c.bonds.includes(a.id)) c.bonds.push(a.id);
  }
  assert('all parent bond slots are full', parents.every(p => p.bonds.length >= 4));

  const prevRandom = Math.random;
  Math.random = () => 0;
  try {
    await world.step();
  } finally {
    Math.random = prevRandom;
  }

  const children = world.particles.filter(p => !parents.includes(p) && !p.dead);
  assert('no loose somatic children are spawned when the body has no bond capacity', children.length === 0);
});
