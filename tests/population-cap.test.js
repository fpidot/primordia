import { World } from '../js/sim.js';
import { makeGenome } from '../js/genome.js';
import { assert, runTest } from './harness.js';

await runTest('population cap throttles births and survives save/load', async () => {
  const world = new World({ maxParticles: 12, combatMode: 'event' });
  const clade = world.beginClade(makeGenome(0));

  for (let i = 0; i < 20; i++) {
    world.addParticle(20 + i, 20, makeGenome(0), 5, clade);
  }
  assert('initial hard cap', world.particles.length === 12,
    `expected 12 particles, got ${world.particles.length}`);

  world.setMaxParticles(8);
  const blocked = world.addParticle(80, 80, makeGenome(0), 5, clade);
  assert('lowered cap blocks new births', blocked === null,
    'addParticle should refuse while population is above the cap');
  assert('lowered cap preserves existing population', world.particles.length === 12);

  world.setMaxParticles(16);
  for (let i = 0; i < 8; i++) {
    world.addParticle(60 + i, 60, makeGenome(0), 5, clade);
  }
  assert('raised cap allows growth', world.particles.length === 16,
    `expected 16 particles, got ${world.particles.length}`);

  const data = world.toJSON();
  assert('saved cap', data.maxParticles === 16);

  const loaded = new World({ maxParticles: 4, combatMode: 'event' });
  loaded.fromJSON(data);
  assert('loaded cap', loaded.maxParticles === 16,
    `expected loaded cap 16, got ${loaded.maxParticles}`);
  assert('loaded population', loaded.particles.length === 16);
});
