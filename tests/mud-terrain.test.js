// tests/mud-terrain.test.js — mud is passable terrain, not a field-blocking wall.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0x4D0D);

const { World, CELL, GW, WALL_SOLID, WALL_POROUS } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { OUT_DEPOSIT, OUT_DIG, OUT_REPRO_GATE } = await import('../js/brain.js');

function quietGenome() {
  const g = makeGenome(0);
  g.metab = 0.02;
  g.repro_thresh = 50;
  g.brain.enabled.fill(0);
  g.brain.biasO.fill(0);
  g.brain.biasO[OUT_DEPOSIT] = -10;
  g.brain.biasO[OUT_DIG] = -10;
  g.brain.biasO[OUT_REPRO_GATE] = -10;
  return g;
}

async function movingParticleWorld(withMud) {
  const world = new World({ maxParticles: 2 });
  const gx = 30;
  const gy = 30;
  if (withMud) {
    world.walls[gy * GW + gx] = WALL_POROUS;
    world._wallCount++;
  }
  const p = world.addParticle(gx * CELL + CELL * 0.5, gy * CELL + CELL * 0.5, quietGenome(), 5);
  p.vx = 1.8;
  p.vy = 0;
  await world.step();
  return p;
}

await runTest('mud-terrain: mud slows and drains but does not block movement', async () => {
  const open = await movingParticleWorld(false);
  const mud = await movingParticleWorld(true);

  assert('mud particle still moved', mud.x > 30 * CELL + CELL * 0.5);
  assert('mud slowed velocity', Math.abs(mud.vx) < Math.abs(open.vx),
    `open vx=${open.vx.toFixed(4)} mud vx=${mud.vx.toFixed(4)}`);
  assert('mud drained extra energy', mud.energy < open.energy,
    `open e=${open.energy.toFixed(4)} mud e=${mud.energy.toFixed(4)}`);
});

await runTest('mud-terrain: mud passes fields while solid walls zero them', async () => {
  const world = new World({ maxParticles: 0 });
  const solidIdx = 20 * GW + 20;
  const mudIdx = 20 * GW + 22;
  world.walls[solidIdx] = WALL_SOLID;
  world.walls[mudIdx] = WALL_POROUS;
  world._wallCount = 2;
  world.field[0][solidIdx] = 1;
  world.field[0][mudIdx] = 1;
  world.field[1][solidIdx] = 1;
  world.field[1][mudIdx] = 1;
  world.mutagen[solidIdx] = 1;
  world.mutagen[mudIdx] = 1;

  await world.step();

  assert('solid food zeroed', world.field[0][solidIdx] === 0);
  assert('solid decay zeroed', world.field[1][solidIdx] === 0);
  assert('solid mutagen zeroed', world.mutagen[solidIdx] === 0);
  assert('mud food persisted', world.field[0][mudIdx] > 0);
  assert('mud decay persisted', world.field[1][mudIdx] > 0);
  assert('mud mutagen persisted', world.mutagen[mudIdx] > 0);
});
