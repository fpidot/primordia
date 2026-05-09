// tests/predation-economy.test.js - meat economy telemetry and transfer rules.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xBEEF);

const { World, CELL } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');

function quietGenome(species) {
  const g = makeGenome(species);
  g.attraction.fill(0);
  g.cohesion = 0;
  g.sense.fill(0);
  g.emit.fill(0);
  g.metab = 0.001;
  g.repro_thresh = 999;
  g.brain.enabled.fill(0);
  g.brain.biasO.fill(0);
  return g;
}

await runTest('predation economy: successful contact hunt is counted as meat energy', async () => {
  const world = new World({ maxParticles: 4 });
  const hunterGenome = quietGenome(0);
  hunterGenome.attraction[1] = 1;
  const preyGenome = quietGenome(1);

  const hunter = world.addParticle(20 * CELL, 20 * CELL, hunterGenome, 5);
  const prey = world.addParticle(20 * CELL + 1, 20 * CELL, preyGenome, 5);
  hunter.vx = 0; hunter.vy = 0;
  prey.vx = 0; prey.vy = 0;

  const hunterEnergyBefore = hunter.energy;
  await world.step();

  assert('hunt event counter increments', world.totalPredationEvents > 0);
  assert('victim loses energy to predation', world.totalPredationDrain > 0.5,
    `drain=${world.totalPredationDrain}`);
  assert('hunter gains meat energy', world.totalPredationEnergyGain > 0.5,
    `gain=${world.totalPredationEnergyGain}`);
  assert('hunter particle records its hunting work', hunter.predationEvents > 0);
  assert('hunter net energy rises despite metabolism', hunter.energy > hunterEnergyBefore,
    `before=${hunterEnergyBefore} after=${hunter.energy}`);
});

await runTest('predation economy: drain never exceeds victim energy', async () => {
  const world = new World({ maxParticles: 4 });
  const hunterGenome = quietGenome(0);
  hunterGenome.attraction[1] = 1;
  hunterGenome.prey_preference[1] = 5;
  const preyGenome = quietGenome(1);

  const hunter = world.addParticle(30 * CELL, 30 * CELL, hunterGenome, 5);
  const prey = world.addParticle(30 * CELL + 1, 30 * CELL, preyGenome, 0.25);
  hunter.predationGain = 1;
  hunter.incomingBondMsgR = 1;
  hunter.vx = 0; hunter.vy = 0;
  prey.vx = 0; prey.vy = 0;

  await world.step();

  assert('fatal drain is recorded', world.totalPredationFatalDrains > 0);
  assert('predation death attribution is recorded', world.totalPredationDeaths > 0);
  assert('hunter is credited with attributed kill', hunter.predationKills > 0);
  assert('drain is capped by prey energy', world.totalPredationDrain <= 0.25 + 1e-6,
    `drain=${world.totalPredationDrain}`);
  assert('prey does not go below zero from predation transfer', prey.energy >= -0.02,
    `prey.energy=${prey.energy}`);
});
