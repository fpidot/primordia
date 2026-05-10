// tests/planet-preset.test.js - richer habitat scaffold regression.

import { seedGlobalRandom, runSim, captureMetrics, assert, assertInRange, runTest } from './harness.js';

seedGlobalRandom(0xC1A0C0);

const { World, WALL_SOLID, WALL_MEMBRANE, WALL_POROUS } = await import('../js/sim.js');
const { PRESETS } = await import('../js/presets.js');

function countTerrain(world) {
  let solid = 0, glass = 0, mud = 0, richFood = 0, decay = 0, mutagen = 0;
  for (let i = 0; i < world.walls.length; i++) {
    if (world.walls[i] === WALL_SOLID) solid++;
    else if (world.walls[i] === WALL_MEMBRANE) glass++;
    else if (world.walls[i] === WALL_POROUS) mud++;
    if (world.field[0][i] > 1.0) richFood++;
    if (world.field[1][i] > 0.2) decay++;
    if (world.mutagen[i] > 0.2) mutagen++;
  }
  return { solid, glass, mud, richFood, decay, mutagen };
}

await runTest('planet preset: creates multiple persistent niche pressures', async () => {
  const world = new World({ maxParticles: 900 });
  PRESETS.planet(world, 720);
  const t = countTerrain(world);
  console.log(`  planet terrain solid=${t.solid} glass=${t.glass} mud=${t.mud} food=${t.richFood} decay=${t.decay} mutagen=${t.mutagen}`);

  assert('planet preset exists', typeof PRESETS.planet === 'function');
  assert('requested population seeded', world.particles.length === 720);
  assert('solid ridges/quarries present', t.solid > 1500);
  assert('glass refuges present', t.glass > 300);
  assert('mud flats present', t.mud > 900);
  assert('rich food oases present', t.richFood > 800);
  assert('decay pockets present', t.decay > 120);
  assert('mutagen cracks present', t.mutagen > 60);
  assertInRange('wall count matches terrain sum', world._wallCount, t.solid + t.glass + t.mud, t.solid + t.glass + t.mud);
});

await runTest('planet preset: short soak remains viable under constraints', async () => {
  const world = new World({ maxParticles: 900, combatMode: 'event' });
  PRESETS.planet(world, 720);
  await runSim(world, 300, { reportEvery: 150 });
  const m = captureMetrics(world);

  assertInRange('population remains viable', m.n, 120, 900);
  assert('births occur', m.born > 720);
  assert('terrain pressure remains present', world._wallCount > 4000);
  assertInRange('mean brain slots sane', m.slots.mean, 1, 10);
});
