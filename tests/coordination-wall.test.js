// tests/coordination-wall.test.js — fast liveness check for communication payoff.
//
// A particle with a barely-subthreshold dig output should not excavate alone.
// The same particle inside a named bonded cluster, receiving a strong B-channel
// bond message, should cross the coordinated-build threshold and dig.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xC00D);

const { World, CELL, GW, WALL_SOLID } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { OUT_DIG, OUT_DEPOSIT } = await import('../js/brain.js');

function quietDigGenome(species = 0) {
  const g = makeGenome(species);
  const b = g.brain;
  b.enabled.fill(0);
  b.biasO.fill(0);
  b.biasO[OUT_DIG] = 0.20;       // sigmoid ~= 0.55: below solo threshold 0.56
  b.biasO[OUT_DEPOSIT] = -10;
  return g;
}

function placeWallAhead(world, p) {
  const gx = ((p.x / CELL) | 0) + 1;
  const gy = (p.y / CELL) | 0;
  const idx = gy * GW + gx;
  world.walls[idx] = WALL_SOLID;
  world._wallCount++;
  world._wallsVersion++;
  return idx;
}

function makeBondedCluster(world, opts = {}) {
  const ps = [];
  for (let i = 0; i < 8; i++) {
    const p = world.addParticle(
      20 * CELL + CELL * 0.5 + (i % 4) * 1.2,
      20 * CELL + CELL * 0.5 + ((i / 4) | 0) * 1.2,
      quietDigGenome(i % 2),
      8,
    );
    p.vx = i === 0 ? 1 : 0;
    p.vy = 0;
    p.bondMsgR = opts.r || 0;
    p.bondMsgG = opts.g || 0;
    p.bondMsgB = opts.b || 0;
    ps.push(p);
  }
  for (let i = 0; i < ps.length - 1; i++) {
    ps[i].bonds.push(ps[i + 1].id);
    ps[i + 1].bonds.push(ps[i].id);
  }
  world.updateClusters();
  return ps;
}

await runTest('coordination-wall: bond message enables subthreshold digging', async () => {
  const solo = new World({ maxParticles: 16 });
  const lone = solo.addParticle(20 * CELL + CELL * 0.5, 20 * CELL + CELL * 0.5, quietDigGenome(), 8);
  lone.vx = 1; lone.vy = 0;
  const soloWall = placeWallAhead(solo, lone);
  await solo.step();
  assert('solo subthreshold dig stays inactive', solo.walls[soloWall] === WALL_SOLID);

  const wrongChannel = new World({ maxParticles: 16 });
  const wrongPs = makeBondedCluster(wrongChannel, { r: 1, g: 1, b: 0 });
  assert('wrong-channel cluster is named', wrongChannel._particleToCluster.has(wrongPs[0].id));
  const wrongWall = placeWallAhead(wrongChannel, wrongPs[0]);
  await wrongChannel.step();
  assert('non-build messages stay inactive', wrongChannel.walls[wrongWall] === WALL_SOLID);

  const coordinated = new World({ maxParticles: 16 });
  const ps = makeBondedCluster(coordinated, { b: 1 });
  assert('cluster is named', coordinated._particleToCluster.has(ps[0].id));

  const coordinatedWall = placeWallAhead(coordinated, ps[0]);
  await coordinated.step();
  assert('coordinated subthreshold dig excavates', coordinated.walls[coordinatedWall] === 0);
  assert('dig counter advances', coordinated.totalWallDigs === 1);
});
