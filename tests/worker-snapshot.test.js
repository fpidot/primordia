import { World, GW, GH } from '../js/sim.js';
import { PRESETS } from '../js/presets.js';
import { buildWorldSnapshot } from '../js/snapshot.js';
import { runTest, assert } from './harness.js';

await runTest('worker snapshot: render-facing state is cloneable and complete', async () => {
  const world = new World({ maxParticles: 120, combatMode: 'event' });
  PRESETS.soup(world, 80);
  for (let i = 0; i < 6; i++) await world.step();

  const { snapshot, transfer } = buildWorldSnapshot(world);
  assert('snapshot has kind', snapshot.kind === 'primordia.world-snapshot.v1', snapshot.kind);
  assert('snapshot has particles', snapshot.particles.length > 0, `particles=${snapshot.particles.length}`);
  assert('snapshot includes fields', snapshot.field0.length === GW * GH && snapshot.field1.length === GW * GH,
    `field0=${snapshot.field0.length}`);
  assert('snapshot includes walls', snapshot.walls.length === GW * GH, `walls=${snapshot.walls.length}`);
  assert('transfer list includes typed arrays', transfer.length >= 4, `transfer=${transfer.length}`);
  assert('particle genome is renderable', snapshot.particles[0].genome && snapshot.particles[0].genome.brainSlots >= 0,
    `brainSlots=${snapshot.particles[0].genome && snapshot.particles[0].genome.brainSlots}`);
  assert('vitals are present', snapshot.vitals && Number.isFinite(snapshot.vitals.meanEnergy),
    `vitals=${snapshot.vitals && snapshot.vitals.meanEnergy}`);
  assert('clade panel state is present', snapshot.clades && Array.isArray(snapshot.clades.events),
    `events=${snapshot.clades && snapshot.clades.events && snapshot.clades.events.length}`);
});
