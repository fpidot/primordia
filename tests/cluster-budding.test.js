// tests/cluster-budding.test.js - organism-level reproduction regression.
//
// A stable, energy-rich bonded cluster should be able to bud a daughter
// cluster. The new cluster inherits mutated member genomes and starts with
// internal bonds, while parent members pay the energy cost.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xB00D1E);

const { World, CELL } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');

function makeStableCluster(world) {
  const ps = [];
  const cx = 40 * CELL;
  const cy = 40 * CELL;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const g = makeGenome(i % 2);
    g.repro_thresh = 5;
    g.mut_rate = 0.02;
    const p = world.addParticle(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8, g, 14);
    p.age = 260;
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
  return ps;
}

await runTest('cluster-budding: stable clusters can reproduce as organisms', async () => {
  const world = new World({ maxParticles: 64 });
  world.tick = 480;
  const parents = makeStableCluster(world);
  const beforeEnergy = parents.reduce((sum, p) => sum + p.energy, 0);

  world.updateClusters();
  assert('parent cluster is detected', world._clusters.length === 1);

  const born = world._tryClusterBudding({ force: true });
  const children = world.particles.slice(parents.length).filter(p => !p.dead);
  const afterEnergy = parents.reduce((sum, p) => sum + p.energy, 0);
  const childBondRefs = children.reduce((sum, p) => sum + p.bonds.length, 0);

  assert('bud creates named-cluster-sized daughter', born >= 8 && children.length >= 8);
  assert('cluster bud counter advances', world.totalClusterBuds === 1);
  assert('cluster bud particle counter advances', world.totalClusterBudParticles === children.length);
  assert('parents pay energy into bud', afterEnergy < beforeEnergy);
  assert('daughter starts internally bonded', childBondRefs >= children.length * 2);
  assert('parent and daughter clusters are both detectable', world._clusters.length >= 2);
  assert('children inherit parent clades', children.every(p => p.cladeId > 0));
  assert('children are marked as daughters', children.every(p => p.organismGeneration === 2));
  assert('daughter cluster is labeled Jr', world._clusters.some(c => c.organismGeneration === 2 && c.name.includes(' Jr ')));
});

await runTest('cluster-budding: cell births reserve headroom for organism buds', async () => {
  const world = new World({ maxParticles: 1200 });
  assert('cell birth cap leaves bud headroom', world._cellBirthLimit() <= 1176);
  assert('bud reserve is large enough for a daughter', world.maxParticles - world._cellBirthLimit() >= 8);

  const plain = new World({ maxParticles: 1200, clusterBudding: false });
  assert('reserve disables with cluster budding off', plain._cellBirthLimit() === plain.maxParticles);
});
