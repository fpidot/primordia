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

await runTest('worker snapshot: dynamic layer can omit field and wall transfers', async () => {
  const world = new World({ maxParticles: 80, combatMode: 'event' });
  PRESETS.maze(world, 48);
  for (let i = 0; i < 3; i++) await world.step();

  const full = buildWorldSnapshot(world);
  const dynamic = buildWorldSnapshot(world, { includeFields: false, includeWalls: false });
  assert('dynamic snapshot keeps particles', dynamic.snapshot.particles.length > 0,
    `particles=${dynamic.snapshot.particles.length}`);
  assert('dynamic snapshot omits fields', !dynamic.snapshot.field0 && !dynamic.snapshot.field1 && !dynamic.snapshot.mutagen,
    `field0=${!!dynamic.snapshot.field0}`);
  assert('dynamic snapshot omits walls and wall metadata', !dynamic.snapshot.walls && !dynamic.snapshot.wallMeta,
    `walls=${!!dynamic.snapshot.walls} wallMeta=${!!dynamic.snapshot.wallMeta}`);
  assert('dynamic transfer list is smaller', dynamic.transfer.length < full.transfer.length,
    `dynamic=${dynamic.transfer.length} full=${full.transfer.length}`);
  assert('dynamic layers are marked', dynamic.snapshot.worker.layers.fields === false &&
    dynamic.snapshot.worker.layers.walls === false,
    JSON.stringify(dynamic.snapshot.worker.layers));
});

await runTest('worker snapshot: particle slab carries render-facing particle state', async () => {
  const world = new World({ maxParticles: 80, combatMode: 'event' });
  PRESETS.soup(world, 48);
  for (let i = 0; i < 4; i++) await world.step();

  const { snapshot, transfer } = buildWorldSnapshot(world, {
    particleFormat: 'slab',
    includeFields: false,
    includeWalls: false,
  });
  const slab = snapshot.particleSlab;
  assert('slab exists and object particles are omitted', slab && !snapshot.particles,
    `slab=${!!slab} particles=${!!snapshot.particles}`);
  assert('slab count matches world population', slab.count === world.particles.length,
    `slab=${slab.count} world=${world.particles.length}`);
  assert('slab has typed ids/data/genomes', slab.ids instanceof Uint32Array &&
    slab.data instanceof Float32Array && slab.genomes instanceof Float32Array,
    `ids=${slab.ids?.constructor?.name} data=${slab.data?.constructor?.name}`);
  assert('slab layers are marked', snapshot.worker.layers.particles === 'slab',
    JSON.stringify(snapshot.worker.layers));
  assert('slab buffers are transferable', transfer.length >= 4,
    `transfer=${transfer.length}`);
});
