// tests/signal-transmission.test.js - solid blocks sight; glass and mud transmit it.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0x519A1);

const {
  World,
  CELL,
  GW,
  WALL_SOLID,
  WALL_MEMBRANE,
  WALL_POROUS,
  solidBlocksLineOfSight,
} = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const {
  N_INPUT,
  N_OUTPUT,
  OUT_TX,
  OUT_DIG,
  OUT_DEPOSIT,
  OUT_REPRO_GATE,
} = await import('../js/brain.js');

function quietGenome(species = 0) {
  const g = makeGenome(species);
  g.metab = 0;
  g.repro_thresh = 999;
  g.sense_radius = 90;
  g.cohesion = 0;
  g.attraction.fill(0);
  g.sense.fill(0);
  g.brain.enabled.fill(0);
  g.brain.W_ih.fill(0);
  g.brain.W_hh.fill(0);
  g.brain.W_ho.fill(0);
  g.brain.biasH.fill(0);
  g.brain.biasO.fill(0);
  g.brain.biasO[OUT_DIG] = -10;
  g.brain.biasO[OUT_DEPOSIT] = -10;
  g.brain.biasO[OUT_REPRO_GATE] = -10;
  return g;
}

function signalSeekingGenome() {
  const g = quietGenome(0);
  g.brain.enabled[0] = 1;
  g.brain.actH[0] = 3; // linear
  g.brain.W_ih[0 * N_INPUT + 13] = 4.0; // signal.r
  g.brain.W_ho[0 * N_OUTPUT + OUT_TX] = 3.0;
  return g;
}

function placeBarrier(world, gx, gy, type) {
  if (!type) return;
  world.walls[gy * GW + gx] = type;
  world._wallCount = 1;
  world._wallsVersion++;
}

async function vxAfterSeeingThrough(type) {
  const world = new World({ maxParticles: 4 });
  const gy = 40;
  const p = world.addParticle(30 * CELL + CELL * 0.5, gy * CELL + CELL * 0.5, signalSeekingGenome(), 10);
  const q = world.addParticle(34 * CELL + CELL * 0.5, gy * CELL + CELL * 0.5, quietGenome(1), 10);
  p.vx = 0; p.vy = 0;
  q.vx = 0; q.vy = 0;
  q.signalR = 1;
  q.signalG = 0;
  q.signalB = 0;
  placeBarrier(world, 32, gy, type);
  await world.step();
  return p.vx;
}

await runTest('signal-transmission: line of sight blocks only on solid', async () => {
  const world = new World({ maxParticles: 0 });
  const gy = 30;
  const x0 = 30 * CELL + CELL * 0.5;
  const x1 = 34 * CELL + CELL * 0.5;

  placeBarrier(world, 32, gy, WALL_SOLID);
  assert('solid blocks direct sight', solidBlocksLineOfSight(world.walls, x0, gy * CELL, x1, gy * CELL));

  world.walls.fill(0);
  placeBarrier(world, 32, gy, WALL_MEMBRANE);
  assert('glass transmits direct sight', !solidBlocksLineOfSight(world.walls, x0, gy * CELL, x1, gy * CELL));

  world.walls.fill(0);
  placeBarrier(world, 32, gy, WALL_POROUS);
  assert('mud transmits direct sight', !solidBlocksLineOfSight(world.walls, x0, gy * CELL, x1, gy * CELL));
});

await runTest('signal-transmission: visual signal drives through glass and mud, not solid', async () => {
  const open = await vxAfterSeeingThrough(0);
  const glass = await vxAfterSeeingThrough(WALL_MEMBRANE);
  const mud = await vxAfterSeeingThrough(WALL_POROUS);
  const solid = await vxAfterSeeingThrough(WALL_SOLID);

  assert('open signal produces thrust', open > 0.15, `open vx=${open}`);
  assert('glass signal produces thrust', glass > 0.15, `glass vx=${glass}`);
  assert('mud signal produces thrust', mud > 0.15, `mud vx=${mud}`);
  assert('solid blocks signal-driven thrust', Math.abs(solid) < 0.05, `solid vx=${solid}`);
});
