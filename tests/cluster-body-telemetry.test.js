// tests/cluster-body-telemetry.test.js - named organisms expose whole-body motion feedback.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xC1057E);

const { World, CELL, GW, MAX_V } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { OUT_REPRO_GATE } = await import('../js/brain.js');

function quietGenome() {
  const g = makeGenome(0);
  g.repro_thresh = 999;
  g.sense_radius = 70;
  g.sense[0] = 2.2;
  g.sense[1] = 0;
  g.attraction.fill(0);
  g.cohesion = 0;
  g.metab = 0.02;
  g.efficiency = 1;
  g.brain.enabled.fill(0);
  g.brain.biasO.fill(0);
  g.brain.biasO[OUT_REPRO_GATE] = -10;
  return g;
}

function makeNamedCluster(world, genomeFactory = quietGenome) {
  const ps = [];
  for (let i = 0; i < 8; i++) {
    const g = genomeFactory();
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

await runTest('cluster-body-telemetry: shared contact lets the body surface-follow scent', async () => {
  const makeWorld = (withContact) => {
    const world = new World({ maxParticles: 16 });
    const ps = makeNamedCluster(world);
    const cluster = world._clusters[0];
    if (withContact) {
      cluster.contactX = 1;
      cluster.contactY = 0;
      cluster.slip = 1;
      cluster.topology = 1;
    }
    for (const p of ps) {
      p.vx = 0;
      p.vy = 0;
    }
    const cx = Math.round(ps.reduce((sum, p) => sum + p.x, 0) / ps.length / CELL);
    const cy = Math.round(ps.reduce((sum, p) => sum + p.y, 0) / ps.length / CELL);
    for (let dy = -14; dy <= -7; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        world.field[0][(cy + dy) * GW + (cx + dx)] = 5.5;
      }
    }
    return { world, ps };
  };

  const noContact = makeWorld(false);
  const contact = makeWorld(true);

  await noContact.world.step();
  await contact.world.step();

  const meanY = ps => ps.reduce((sum, p) => sum + p.y, 0) / ps.length;
  const noContactY = meanY(noContact.ps);
  const contactY = meanY(contact.ps);

  assert('shared contact adds northward body slide beyond individual smell',
    contactY < noContactY - 0.04,
    `noContactY=${noContactY.toFixed(4)} contactY=${contactY.toFixed(4)}`);
});
