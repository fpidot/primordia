// tests/wall-metadata.test.js — organism-built walls remember their builder.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0x5A11);

const { World, CELL, GW, WALL_SOLID } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { OUT_DEPOSIT, OUT_DIG } = await import('../js/brain.js');

function depositGenome(species = 0) {
  const g = makeGenome(species);
  const b = g.brain;
  b.enabled.fill(0);
  b.biasO.fill(0);
  b.biasO[OUT_DEPOSIT] = 10;
  b.biasO[OUT_DIG] = -10;
  g.repro_thresh = 50;
  return g;
}

function quietGenome(species = 0) {
  const g = depositGenome(species);
  g.brain.biasO[OUT_DEPOSIT] = -10;
  return g;
}

await runTest('wall-metadata: deposited wall stores builder and survives save/load', async () => {
  const world = new World({ maxParticles: 16 });
  const ps = [];
  for (let i = 0; i < 8; i++) {
    const p = world.addParticle(
      30 * CELL + CELL * 0.5 + (i % 4) * 1.2,
      30 * CELL + CELL * 0.5 + ((i / 4) | 0) * 1.2,
      i === 0 ? depositGenome(0) : quietGenome(i % 2),
      8,
    );
    p.vx = 0;
    p.vy = 0;
    ps.push(p);
  }
  for (let i = 0; i < ps.length - 1; i++) {
    ps[i].bonds.push(ps[i + 1].id);
    ps[i + 1].bonds.push(ps[i].id);
  }
  ps[0].wallCarry = 1;
  world.updateClusters();
  const cluster = world._particleToCluster.get(ps[0].id);
  assert('builder starts in named cluster', !!cluster);
  const gx = (ps[0].x / CELL) | 0;
  const gy = (ps[0].y / CELL) | 0;

  await world.step();
  const info = world.wallInfoAt(gx, gy);
  assert('wall was deposited', info && info.type === WALL_SOLID);
  assert('owner id recorded', info.ownerId === ps[0].id);
  assert('owner is alive', info.ownerAlive);
  assert('cluster recorded', info.clusterAnchorId === cluster.anchorId);
  assert('deposit tick recorded', info.depositedTick === 1);

  const saved = world.toJSON();
  const loaded = new World({ maxParticles: 16 });
  loaded.fromJSON(saved);
  loaded.updateClusters();
  const loadedInfo = loaded.wallInfoAt(gx, gy);
  assert('metadata survives save/load', loadedInfo && loadedInfo.ownerId === ps[0].id);
  assert('saved owner id remains live after load', loadedInfo.ownerAlive);
});
