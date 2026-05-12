// tests/cluster-body-telemetry.test.js - named organisms expose whole-body motion feedback.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xC1057E);

const { World, CELL, MAX_V } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');

function makeNamedCluster(world) {
  const ps = [];
  for (let i = 0; i < 8; i++) {
    const g = makeGenome(0);
    g.brain.enabled.fill(0);
    const p = world.addParticle(
      30 * CELL + (i % 4) * 3,
      30 * CELL + Math.floor(i / 4) * 3,
      g,
      8,
    );
    ps.push(p);
  }
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    const b = ps[(i + 1) % ps.length];
    if (!a.bonds.includes(b.id)) a.bonds.push(b.id);
    if (!b.bonds.includes(a.id)) b.bonds.push(a.id);
  }
  world.updateClusters();
  return ps;
}

await runTest('cluster-body-telemetry: named clusters share drift, contact, and slip sensors', async () => {
  const world = new World({ maxParticles: 16 });
  const ps = makeNamedCluster(world);
  assert('cluster is named', world._clusters.length === 1);

  for (const p of ps) {
    p.lastHardContactX = 1;
    p.lastHardContactY = 0;
    p.lastMotorSlip = 0.75;
    p.x += MAX_V;
  }

  world.tick = 12;
  world.updateClusters();
  const cluster = world._clusters[0];

  assert('cluster reports positive body drift', cluster.vx > 0.05, `vx=${cluster.vx}`);
  assert('cluster reports average contact normal', cluster.contactX > 0.9,
    `contactX=${cluster.contactX}`);
  assert('cluster reports average member slip', cluster.slip > 0.7 && cluster.slip < 0.8,
    `slip=${cluster.slip}`);

  for (const p of ps) {
    assert('member points at the updated cluster object', p.cluster === cluster);
    assert('member can read cluster body telemetry', p.cluster.slip === cluster.slip);
  }
});
