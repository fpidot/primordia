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
  SENSOR_NAMES,
  OUT_TX,
  OUT_TY,
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

function clusterMessageSeekingGenome() {
  const g = quietGenome(0);
  const msgG = SENSOR_NAMES.indexOf('cluster.msg.g');
  g.brain.enabled[0] = 1;
  g.brain.actH[0] = 3; // linear
  g.brain.W_ih[0 * N_INPUT + msgG] = 5.0;
  g.brain.W_ho[0 * N_OUTPUT + OUT_TY] = 4.0;
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

await runTest('signal-transmission: mesh bonds reinforce shared messages', async () => {
  const world = new World({ maxParticles: 12 });
  const ps = [];
  const cx = 60 * CELL;
  const cy = 50 * CELL;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const p = world.addParticle(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8, quietGenome(i % 2), 8);
    p.vx = 0;
    p.vy = 0;
    p.bondMsgR = i === 0 ? 0.5 : 1;
    p.bondMsgG = 0.5;
    p.bondMsgB = 0.5;
    ps.push(p);
  }
  const receiver = ps[0];
  for (let i = 1; i <= 4; i++) {
    receiver.bonds.push(ps[i].id);
    ps[i].bonds.push(receiver.id);
  }
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i];
    const b = ps[i === ps.length - 1 ? 1 : i + 1];
    if (!a.bonds.includes(b.id)) a.bonds.push(b.id);
    if (!b.bonds.includes(a.id)) b.bonds.push(a.id);
  }

  world.updateClusters();
  assert('mesh cluster is detected', world._clusters.length === 1);
  assert('mesh has positive topology score', world._clusters[0].topology > 0);

  await world.step();

  assert('same-channel bonded neighbors reinforce above single-message tanh limit',
    receiver.incomingBondMsgR > 0.77,
    `incoming=${receiver.incomingBondMsgR}`);
});

await runTest('signal-transmission: cluster message trace carries a salient payload beyond one hop', async () => {
  const world = new World({ maxParticles: 12 });
  const ps = [];
  const cx = 72 * CELL;
  const cy = 50 * CELL;
  for (let i = 0; i < 8; i++) {
    const g = i === 4 ? clusterMessageSeekingGenome() : quietGenome(i % 2);
    const p = world.addParticle(cx + i * 4, cy, g, 8);
    p.vx = 0;
    p.vy = 0;
    p.bondMsgR = 0.5;
    p.bondMsgG = i === 0 ? 1 : 0.5;
    p.bondMsgB = 0.5;
    ps.push(p);
  }
  for (let i = 0; i < ps.length - 1; i++) {
    ps[i].bonds.push(ps[i + 1].id);
    ps[i + 1].bonds.push(ps[i].id);
  }

  const source = ps[0];
  const receiver = ps[4];
  world.updateClusters();
  assert('chain cluster is named', world._clusters.length === 1);
  assert('receiver is not a direct neighbor of source', !receiver.bonds.includes(source.id));

  await world.step();

  assert('one-hop local G message stays neutral at the remote receiver',
    Math.abs(receiver.incomingBondMsgG) < 0.05,
    `incomingBondMsgG=${receiver.incomingBondMsgG}`);
  assert('cluster trace preserves the salient G-channel payload',
    receiver.cluster.busG > 0.45,
    `cluster.msg.g=${receiver.cluster.busG}`);
  assert('remote brain can use cluster.msg.g for coordinated movement',
    receiver.lastMotorY > 0.8,
    `lastMotorY=${receiver.lastMotorY}`);
});
