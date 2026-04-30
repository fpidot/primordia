// tests/world-template.test.js -- sterile terrain templates preserve the world, not its inhabitants.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0x57012D);

const { World, CELL, GW, WALL_SOLID, WALL_POROUS } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');

await runTest('world-template: export/import keeps terrain sterile', async () => {
  const source = new World({ maxParticles: 12 });
  const g = makeGenome(1);
  const p = source.addParticle(40 * CELL, 40 * CELL, g, 7);
  source.updateClusters();

  const solidIdx = 18 * GW + 22;
  const mudIdx = 19 * GW + 23;
  source.walls[solidIdx] = WALL_SOLID;
  source.walls[mudIdx] = WALL_POROUS;
  source._wallCount = 2;
  source.wallOwnerId[solidIdx] = p.id;
  source.wallOwnerClusterId[solidIdx] = 123;
  source.field[0][solidIdx] = 1.25;
  source.field[1][mudIdx] = 2.5;
  source.mutagen[mudIdx] = 0.75;

  const template = source.toWorldTemplateJSON();
  assert('template kind set', template.kind === 'primordia.world-template.v1');
  assert('template has no particles', !('particles' in template));
  assert('template has no clades', !('clades' in template));

  const target = new World({ maxParticles: 12 });
  target.addParticle(10 * CELL, 10 * CELL, makeGenome(0), 3);
  target.updateClusters();
  assert('target starts inhabited', target.particles.length === 1);
  assert('target starts with clades', target.clades.clades.size > 0);

  target.fromWorldTemplateJSON(template);

  assert('import removes particles', target.particles.length === 0);
  assert('import clears clades', target.clades.clades.size === 0);
  assert('solid wall restored', target.walls[solidIdx] === WALL_SOLID);
  assert('mud restored', target.walls[mudIdx] === WALL_POROUS);
  assert('wall count recomputed', target._wallCount === 2);
  assert('food field restored', Math.abs(target.field[0][solidIdx] - 1.25) < 0.0002);
  assert('decay field restored', Math.abs(target.field[1][mudIdx] - 2.5) < 0.0002);
  assert('mutagen restored', Math.abs(target.mutagen[mudIdx] - 0.75) < 0.0002);
  assert('template import does not preserve wall owner', target.wallOwnerId[solidIdx] === 0);
});
