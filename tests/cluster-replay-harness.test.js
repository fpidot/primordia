// tests/cluster-replay-harness.test.js - organism-preserving replay harness.

import { seedGlobalRandom, assert, runTest } from './harness.js';

seedGlobalRandom(0xC1057E2);

const { World, CELL } = await import('../js/sim.js');
const { makeGenome } = await import('../js/genome.js');
const { sampleClusterCohort, runChallenge } = await import('../tools/defense-soak.js');

function makeReplayCluster(world, count = 8) {
  const ps = [];
  const cx = 60 * CELL;
  const cy = 55 * CELL;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const g = makeGenome(i % 2);
    g.repro_thresh = 9999;
    const p = world.addParticle(cx + Math.cos(a) * 10, cy + Math.sin(a) * 10, g, 8);
    p.age = 240;
    p.vx = 0;
    p.vy = 0;
    ps.push(p);
  }
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    const b = ps[(i + 1) % ps.length];
    a.bonds.push(b.id);
    b.bonds.push(a.id);
  }
  world.updateClusters();
  return ps;
}

const challengeOpts = {
  challengeTicks: 2,
  predatorRatio: 0.125,
  freezeReproduction: true,
  challengeSampleEvery: 1,
  combatMode: 'event',
  hunterEnergy: 3,
  hunterDrive: 0.3,
  hunterPreference: 0,
  hunterAttraction: 0,
  hunterSenseRadius: 40,
  challengeJitter: 0,
  cohortEnergy: 5,
};

await runTest('cluster replay: sampler preserves members and source bonds', async () => {
  const world = new World({ maxParticles: 64 });
  makeReplayCluster(world);

  const cohort = sampleClusterCohort(world, 16, 0xC1057E2, {
    clusterMinSize: 8,
    clusterMaxClusters: 2,
  });

  assert('one cluster sampled', cohort.clusters.length === 1);
  assert('all members sampled', cohort.particleCount === 8);
  assert('ring bonds exported', cohort.bondCount === 8);
});

await runTest('cluster replay: oversized organisms export a connected budgeted subcluster', async () => {
  const world = new World({ maxParticles: 64 });
  makeReplayCluster(world, 14);

  const cohort = sampleClusterCohort(world, 8, 0x51A11, {
    clusterMinSize: 5,
    clusterMaxClusters: 1,
  });

  assert('large cluster is trimmed instead of dropped', cohort.clusters.length === 1);
  assert('trimmed export uses the particle budget', cohort.particleCount === 8);
  assert('source count records original organism size', cohort.clusters[0].sourceCount === 14);
  assert('trimmed cluster count is reported', cohort.trimmedClusterCount === 1);
  assert('connected ring subset preserves most local bonds', cohort.bondCount >= 7,
    `bondCount=${cohort.bondCount}`);
});

await runTest('cluster replay: intact challenge retains topology unlike disassembled control', async () => {
  const world = new World({ maxParticles: 64 });
  makeReplayCluster(world);
  const cohort = sampleClusterCohort(world, 16, 0xA11CE, {
    clusterMinSize: 8,
    clusterMaxClusters: 1,
  });

  const intact = await runChallenge('predator', cohort, challengeOpts, 0xBEE5, 'clusters-intact');
  const disassembled = await runChallenge('predator', cohort, challengeOpts, 0xBEE5, 'clusters-disassembled');

  assert('intact replay starts one organism', intact.cohortClusters === 1 && intact.start === 8);
  assert('intact replay keeps source bonds measurable', intact.meanBondRetention > 0.9);
  assert('disassembled control has no retained source bonds', disassembled.meanBondRetention === 0);
});
