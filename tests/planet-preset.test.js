// tests/planet-preset.test.js - richer habitat scaffold regression.

import { seedGlobalRandom, runSim, captureMetrics, assert, assertInRange, runTest } from './harness.js';

seedGlobalRandom(0xC1A0C0);

const { World, WALL_SOLID, WALL_MEMBRANE, WALL_POROUS } = await import('../js/sim.js');
const { PRESETS } = await import('../js/presets.js');
const {
  computeRegionBehavior,
  computeRegionLineageTurnover,
  computeRegionMetrics,
  computeRegionSurvival,
  computeRegionTransitions,
} = await import('../js/region_metrics.js');

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
  assert('planet registers named habitat regions', world.habitatRegions.length >= 5,
    `regions=${world.habitatRegions.length}`);
  assert('solid ridges/quarries present', t.solid > 1500);
  assert('glass refuges present', t.glass > 300);
  assert('mud flats present', t.mud > 900);
  assert('rich food oases present', t.richFood > 800);
  assert('decay pockets present', t.decay > 120);
  assert('mutagen cracks present', t.mutagen > 60);
  assertInRange('wall count matches terrain sum', world._wallCount, t.solid + t.glass + t.mud, t.solid + t.glass + t.mud);

  const regions = computeRegionMetrics(world, { includeOutside: true });
  const assigned = regions.reduce((sum, r) => sum + r.particles, 0);
  assert('region metrics include outside population', assigned === world.particles.length,
    `assigned=${assigned} particles=${world.particles.length}`);
  assert('basin metrics capture food oases', regions.some(r => r.type === 'basin' && r.richFoodCells > 150));
  assert('basin metrics capture mud rings', regions.some(r => r.type === 'basin' && r.mudCells > 100));
  assert('region metrics include species entropy', regions.some(r => r.particles > 0 && r.speciesEntropy > 0));

  const initialMoves = computeRegionTransitions(world, new Map(), { includeOutside: true });
  assert('region transition baseline maps live particles',
    initialMoves.current.size === world.particles.length,
    `mapped=${initialMoves.current.size} particles=${world.particles.length}`);
  const targetRegion = world.habitatRegions[0].id;
  const moved = world.particles.find(p => initialMoves.current.get(p.id) !== targetRegion) || world.particles[0];
  moved.x = world.habitatRegions[0].x;
  moved.y = world.habitatRegions[0].y;
  const afterMove = computeRegionTransitions(world, initialMoves.current, { includeOutside: true });
  assert('region transitions detect moved particles', afterMove.summary.moved >= 1,
    `moved=${afterMove.summary.moved}`);

  const initialLineages = computeRegionLineageTurnover(world, new Map(), { includeOutside: true });
  let lineageTotal = 0;
  for (const counts of initialLineages.current.values()) {
    for (const count of counts.values()) lineageTotal += count;
  }
  assert('region lineage baseline counts live particles', lineageTotal === world.particles.length,
    `lineageTotal=${lineageTotal} particles=${world.particles.length}`);
  moved.cladeId = 999999;
  const afterLineages = computeRegionLineageTurnover(world, initialLineages.current, { includeOutside: true });
  const changedRegion = afterLineages.summary.regions.find(r => r.id === targetRegion);
  assert('region lineage turnover detects local colonization',
    changedRegion && changedRegion.colonizations >= 1,
    `colonizations=${changedRegion?.colonizations || 0}`);

  const initialSurvival = computeRegionSurvival(world, new Map(), { includeOutside: true });
  assert('region survival baseline maps live particles',
    initialSurvival.current.size === world.particles.length,
    `mapped=${initialSurvival.current.size} particles=${world.particles.length}`);
  const originRegion = initialSurvival.current.get(moved.id).regionId;
  moved.dead = true;
  const afterSurvival = computeRegionSurvival(world, initialSurvival.current, { includeOutside: true });
  const survivalRegion = afterSurvival.summary.regions.find(r => r.id === originRegion);
  assert('region survival detects deaths by origin region',
    survivalRegion && survivalRegion.died >= 1,
    `died=${survivalRegion?.died || 0}`);

  const initialBehavior = computeRegionBehavior(world, new Map(), { includeOutside: true });
  assert('region behavior baseline maps live particles',
    initialBehavior.current.size === world.particles.filter(p => !p.dead).length,
    `mapped=${initialBehavior.current.size}`);
  const actor = world.particles.find(p => !p.dead);
  const actorRegion = initialBehavior.current.get(actor.id).regionId;
  actor.wallDigs = (actor.wallDigs || 0) + 2;
  actor.fieldEnergyGain = (actor.fieldEnergyGain || 0) + 3.5;
  actor.combatAttacks = (actor.combatAttacks || 0) + 1;
  const afterBehavior = computeRegionBehavior(world, initialBehavior.current, { includeOutside: true });
  const behaviorRegion = afterBehavior.summary.regions.find(r => r.id === actorRegion);
  assert('region behavior detects action deltas',
    behaviorRegion && behaviorRegion.wallDigs >= 2 &&
      behaviorRegion.fieldEnergyGain >= 3.5 &&
      behaviorRegion.combatAttacks >= 1,
    `wallDigs=${behaviorRegion?.wallDigs || 0} field=${behaviorRegion?.fieldEnergyGain || 0}`);
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
