// tests/event-combat.test.js - event-style predation outcomes and damage sensors.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xC0BA7);

const { World, CELL } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { EXTRAS_STRIDE } = await import('../js/gpu_pairforce.js');

function combatGenome(species) {
  const g = makeGenome(species);
  g.attraction.fill(0);
  g.cohesion = 0;
  g.sense.fill(0);
  g.emit.fill(0);
  if (g.prey_preference) g.prey_preference.fill(0);
  g.metab = 0.001;
  g.repro_thresh = 999;
  g.brain.enabled.fill(0);
  g.brain.biasO.fill(0);
  return g;
}

function combatWorld() {
  const world = new World({ maxParticles: 8, combatMode: 'event' });
  world.field[0].fill(0);
  world.field[1].fill(0);
  return world;
}

function addPair(world, aEnergy = 8, bEnergy = 4) {
  const ag = combatGenome(0);
  const bg = combatGenome(1);
  ag.attraction[1] = 1;
  bg.attraction[0] = 1;
  const a = world.addParticle(20 * CELL, 20 * CELL, ag, aEnergy);
  const b = world.addParticle(20 * CELL + 1, 20 * CELL, bg, bEnergy);
  a.vx = 0; a.vy = 0;
  b.vx = 0; b.vy = 0;
  return { a, b };
}

await runTest('event combat: strong one-sided attack kills and consumes prey', async () => {
  const world = combatWorld();
  const { a: hunter, b: prey } = addPair(world, 8, 4);
  hunter.predationGain = 1;
  prey.predationGain = 0;
  const before = hunter.energy;

  await world.step();

  assert('prey is killed by the event attack', prey.dead);
  assert('hunter gains net meat energy after attack cost', hunter.energy > before,
    `before=${before} after=${hunter.energy}`);
  assert('combat kill counter increments', world.totalCombatKills === 1,
    `kills=${world.totalCombatKills}`);
  assert('predation death is attributed', world.totalPredationDeaths === 1,
    `predationDeaths=${world.totalPredationDeaths}`);
  assert('successful attack is not counted as failed cost', world.totalCombatFailedCost === 0,
    `failedCost=${world.totalCombatFailedCost}`);
});

await runTest('event combat: guarded prey counterkills a weak attacker', async () => {
  const world = combatWorld();
  const { a: attacker, b: defender } = addPair(world, 4, 8);
  attacker.predationGain = 0.5;
  defender.predationGain = -1;
  const defenderBefore = defender.energy;

  await world.step();

  assert('attacker dies to counterattack', attacker.dead);
  assert('defender gains energy from the counterkill', defender.energy > defenderBefore,
    `before=${defenderBefore} after=${defender.energy}`);
  assert('counter counter increments', world.totalCombatCounters === 1,
    `counters=${world.totalCombatCounters}`);
  assert('failed attack cost is recorded for the attacker', world.totalCombatFailedCost > 0,
    `failedCost=${world.totalCombatFailedCost}`);
});

await runTest('event combat: failed attack gives no food and leaves damage memory', async () => {
  const world = combatWorld();
  const { a: attacker, b: defender } = addPair(world, 8, 8);
  attacker.predationGain = 0.75;
  defender.predationGain = -0.55;
  const attackerBefore = attacker.energy;
  const defenderBefore = defender.energy;

  await world.step();

  assert('both survive a close escape', !attacker.dead && !defender.dead);
  assert('escape counter increments', world.totalCombatEscapes === 1,
    `escapes=${world.totalCombatEscapes}`);
  assert('failed attack is net negative to the attacker', attacker.energy < attackerBefore,
    `before=${attackerBefore} after=${attacker.energy}`);
  assert('defender is injured but not eaten', defender.energy < defenderBefore,
    `before=${defenderBefore} after=${defender.energy}`);
  assert('failed attack produced no meat gain', world.totalPredationEnergyGain === 0,
    `meat=${world.totalPredationEnergyGain}`);
  assert('defender remembers damage', defender.recentDamage > 0,
    `recentDamage=${defender.recentDamage}`);
  assert('damage direction points toward source', defender.damageDirX < -0.5,
    `damageDirX=${defender.damageDirX}`);

  world._buildGpuExtras();
  const o = world.particles.indexOf(defender) * EXTRAS_STRIDE;
  assert('GPU extras expose recent damage sensor', world._extrasStaging[o + 40] > 0,
    `damageSensor=${world._extrasStaging[o + 40]}`);
  assert('GPU extras expose damage source direction', world._extrasStaging[o + 41] < -0.5,
    `damageDx=${world._extrasStaging[o + 41]}`);
});
