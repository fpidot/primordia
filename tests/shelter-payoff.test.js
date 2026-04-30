// tests/shelter-payoff.test.js — verifies wall shelter is a real cluster payoff.
//
// Walls alone should not grant metabolic relief. A named bonded cluster gets
// shelter near walls, and a build-channel bond message should strengthen that
// relief.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0x5E17E2);

const { World, CELL, GW, WALL_SOLID } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { OUT_DIG, OUT_DEPOSIT } = await import('../js/brain.js');

function quietGenome(species = 0) {
  const g = makeGenome(species);
  const b = g.brain;
  b.enabled.fill(0);
  b.biasO.fill(0);
  b.biasO[OUT_DIG] = -10;
  b.biasO[OUT_DEPOSIT] = -10;
  g.metab = 0.02;
  g.repro_thresh = 50;
  return g;
}

function wallRing(world, gx, gy) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const idx = (gy + dy) * GW + (gx + dx);
      world.walls[idx] = WALL_SOLID;
      world._wallCount++;
      world._wallsVersion++;
    }
  }
}

function makeCluster(world, bondMsgB = 0.5) {
  const gx = 40, gy = 40;
  const ps = [];
  for (let i = 0; i < 8; i++) {
    const p = world.addParticle(
      gx * CELL + CELL * 0.5 + (i % 4) * 1.1,
      gy * CELL + CELL * 0.5 + ((i / 4) | 0) * 1.1,
      quietGenome(i % 2),
      4,
    );
    p.vx = 0;
    p.vy = 0;
    p.bondMsgB = bondMsgB;
    ps.push(p);
  }
  for (let i = 0; i < ps.length - 1; i++) {
    ps[i].bonds.push(ps[i + 1].id);
    ps[i + 1].bonds.push(ps[i].id);
  }
  wallRing(world, gx, gy);
  world.updateClusters();
  return ps;
}

await runTest('shelter-payoff: walls help named build-coordinated clusters', async () => {
  const solo = new World({ maxParticles: 16 });
  const lone = solo.addParticle(40 * CELL + CELL * 0.5, 40 * CELL + CELL * 0.5, quietGenome(), 4);
  lone.vx = 0;
  lone.vy = 0;
  wallRing(solo, 40, 40);
  await solo.step();
  assert('unclustered wall shelter is inactive', (lone.shelterRelief || 0) === 0);

  const neutral = new World({ maxParticles: 16 });
  const neutralPs = makeCluster(neutral, 0.5);
  await neutral.step();
  const neutralRelief = neutralPs[0].shelterRelief || 0;
  assert('named cluster receives wall shelter', neutralRelief > 0.20);

  const coordinated = new World({ maxParticles: 16 });
  const coordinatedPs = makeCluster(coordinated, 1);
  await coordinated.step();
  const coordinatedRelief = coordinatedPs[0].shelterRelief || 0;
  assert('build message strengthens shelter', coordinatedRelief > neutralRelief + 0.10,
         `neutral=${neutralRelief.toFixed(3)} coordinated=${coordinatedRelief.toFixed(3)}`);
});
