// tests/terrain-sensors.test.js - typed material sensors stay aligned across CPU/GPU inputs.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0x73351);

const {
  World,
  CELL,
  GW,
  WALL_SOLID,
  WALL_MEMBRANE,
  WALL_POROUS,
} = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { SENSOR_NAMES, N_INPUT } = await import('../js/brain.js');
const { EXTRAS_STRIDE } = await import('../js/gpu_pairforce.js');

function addQuietParticle(world, gx, gy) {
  const g = makeGenome(0);
  g.brain.enabled.fill(0);
  return world.addParticle(gx * CELL + CELL * 0.5, gy * CELL + CELL * 0.5, g, 4);
}

await runTest('terrain-sensors: material sensor names append without moving old slots', async () => {
  assert('terrain.mud kept its save-compatible index', SENSOR_NAMES[45] === 'terrain.mud');
  assert('solid.n appended at index 46', SENSOR_NAMES[46] === 'solid.n');
  assert('glass.w appended at index 53', SENSOR_NAMES[53] === 'glass.w');
  assert('input count includes typed material sensors', N_INPUT === 54);
});

await runTest('terrain-sensors: gpu extras include typed directional material proximity', async () => {
  const world = new World({ maxParticles: 4 });
  const gx = 42;
  const gy = 42;
  addQuietParticle(world, gx, gy);

  world.walls[(gy - 1) * GW + gx] = WALL_SOLID;
  world.walls[(gy + 2) * GW + gx] = WALL_MEMBRANE;
  world.walls[gy * GW + (gx + 3)] = WALL_POROUS;
  world.walls[gy * GW + (gx - 4)] = WALL_SOLID;
  world._wallCount = 4;

  world._buildGpuExtras();
  const e = world._extrasStaging;
  const o = 0 * EXTRAS_STRIDE;

  assert('any-wall north sees adjacent solid', e[o + 19] > 0.99, `wall.n=${e[o + 19]}`);
  assert('solid north sees adjacent solid', e[o + 28] > 0.99, `solid.n=${e[o + 28]}`);
  assert('glass north stays empty', e[o + 32] === 0, `glass.n=${e[o + 32]}`);

  assert('any-wall south sees glass', e[o + 20] > 0, `wall.s=${e[o + 20]}`);
  assert('glass south sees glass', e[o + 33] > 0, `glass.s=${e[o + 33]}`);
  assert('solid south stays empty', e[o + 29] === 0, `solid.s=${e[o + 29]}`);

  assert('mud east sees mud', e[o + 25] > 0, `mud.e=${e[o + 25]}`);
  assert('solid west sees solid', e[o + 31] > 0, `solid.w=${e[o + 31]}`);
  assert('underfoot mud remains separate', e[o + 27] === 0, `terrain.mud=${e[o + 27]}`);
});
