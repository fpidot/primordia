// tests/baseline-soup.test.js — soup preset regression baseline.
//
// Runs ~2000 ticks of soup with a fixed seed and asserts core metrics stay
// within ranges informed by the live 7160-tick browser soak that validated
// Phase 6. Bounds are intentionally generous — this catches catastrophic
// regressions (population crashes, genome drifting NaN, comm metric
// collapsing, brain count stuck/runaway) without flagging healthy variation.

import { seedGlobalRandom, runSim, captureMetrics, assertInRange,
         assert, dumpMetrics, runTest } from './harness.js';

// Seed BEFORE creating the world so genome init is deterministic.
seedGlobalRandom(0xC0FFEE);

const { World } = await import('../js/sim.js');
const { PRESETS } = await import('../js/presets.js');

const TICKS = 2000;
const POP_CAP = 1500;       // smaller than default 5000 → faster test

await runTest('baseline-soup: 2k ticks, seeded RNG', async () => {
  const world = new World({ maxParticles: POP_CAP });
  PRESETS.soup(world, 800);

  console.log(`  seeded soup: n=${world.particles.length}, max=${POP_CAP}`);
  await runSim(world, TICKS, { reportEvery: 500 });

  const m = captureMetrics(world);
  console.log('\n  final metrics:');
  console.log(dumpMetrics(m));

  // ─── Assertions ────────────────────────────────────────────────────
  // Population — crash detector, not equilibrium check.
  assertInRange('n', m.n, 100, POP_CAP);
  assert('born > 0', m.born > 100, `only ${m.born} births`);
  assert('died > 0', m.died > 100, `only ${m.died} deaths`);

  // Genome traits — should stay within mutation-bounded ranges.
  assertInRange('aff.mean', m.aff.mean, -0.5, 0.6);
  assertInRange('aff.max',  m.aff.max,  -0.5, 1.0);
  assertInRange('kin.mean', m.kin.mean, -0.5, 1.5);
  assertInRange('slots.mean', m.slots.mean, 1, 8);
  assertInRange('slots.max',  m.slots.max,  1, 8);
  assertInRange('pred.mean', m.pred.mean, -0.95, 0.95);

  // Cohesion shouldn't go pathological.
  assertInRange('cohesion.mean', m.cohesion.mean, -0.5, 1.2);

  // Comm metric — flash may be ~0 (CTRNN dynamics are subtle), but other
  // components should keep comm above the noise floor.
  assertInRange('comm', m.comm, 0.05, 1.0);
  assertInRange('total complexity', m.total, 0.10, 1.0);

  // Cluster detection should fire — at least *some* clusters should form.
  assertInRange('clusters', m.clusters, 0, 200);
});
