// tests/detour-navigation.test.js - controlled obstacle-navigation assay.
//
// These checks verify the assay geometry and output contract. They intentionally
// do not require successful detours; that remains an empirical outcome for
// evolved cohorts and future structure changes.

import { assert, assertInRange, runTest, seedGlobalRandom } from './harness.js';
import { World, CELL, GH, GW, WALL_MEMBRANE } from '../js/sim.js';
import { makeGenome } from '../js/genome.js';
import { buildDetourArena, focusCohortNearStart, runDetourAssay } from '../tools/detour-assay.js';

seedGlobalRandom(0xD370A);

await runTest('detour-navigation: arena builds a glass barrier with two open gaps', async () => {
  const world = new World({ maxParticles: 8 });
  const arena = buildDetourArena(world, {
    barrier: 'glass',
    barrierGx: Math.floor(GW * 0.5),
    gapCells: 3,
    thickness: 1,
  });

  const barrierIdx = Math.floor((arena.gapA + arena.gapB) * 0.5) * GW + arena.barrierGx;
  const gapIdx = arena.gapA * GW + arena.barrierGx;
  const goalIdx = Math.floor(arena.goalY / CELL) * GW + Math.floor(arena.goalX / CELL);

  assert('barrier cells counted', arena.barrierCells > GH * 0.45,
    `barrierCells=${arena.barrierCells}`);
  assert('open gap cells counted', arena.openGapCells > 0,
    `openGapCells=${arena.openGapCells}`);
  assert('world wall count matches arena', world._wallCount === arena.barrierCells,
    `world._wallCount=${world._wallCount} arena=${arena.barrierCells}`);
  assert('non-gap cell is glass', world.walls[barrierIdx] === WALL_MEMBRANE,
    `wall=${world.walls[barrierIdx]}`);
  assert('gap cell stays open', world.walls[gapIdx] === 0,
    `wall=${world.walls[gapIdx]}`);
  assert('goal food patch exists', world.field[0][goalIdx] > 0,
    `food=${world.field[0][goalIdx]}`);
  assert('goal scent exists', arena.scentCells > arena.openGapCells,
    `scentCells=${arena.scentCells}`);
  assert('start and goal regions exposed', world.habitatRegions.length === 2,
    `regions=${world.habitatRegions.length}`);
});

await runTest('detour-navigation: curriculum refocus preserves named cluster geometry', async () => {
  const world = new World({ maxParticles: 16 });
  const ps = [];
  const cx = 70 * CELL;
  const cy = 60 * CELL;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const p = world.addParticle(cx + Math.cos(a) * 11, cy + Math.sin(a) * 11, makeGenome(i % 2), 6);
    ps.push(p);
  }
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    const b = ps[(i + 1) % ps.length];
    a.bonds.push(b.id);
    b.bonds.push(a.id);
  }
  world.updateClusters();
  const before = ps.map((p, i) => {
    const q = ps[(i + 1) % ps.length];
    return Math.hypot(p.x - q.x, p.y - q.y);
  });
  const arena = buildDetourArena(world, { barrier: 'glass', difficulty: 'easy' });

  focusCohortNearStart(world, ps, arena, { startX: 220, startY: 360 });

  const after = ps.map((p, i) => {
    const q = ps[(i + 1) % ps.length];
    return Math.hypot(p.x - q.x, p.y - q.y);
  });
  const meanX = ps.reduce((sum, p) => sum + p.x, 0) / ps.length;
  const meanY = ps.reduce((sum, p) => sum + p.y, 0) / ps.length;

  assert('cluster still has one named body after refocus', world._clusters.length === 1,
    `clusters=${world._clusters.length}`);
  assert('refocus translates the body near the requested start',
    Math.abs(meanX - 220) < 9 && Math.abs(meanY - 360) < 9,
    `mean=(${meanX.toFixed(2)},${meanY.toFixed(2)})`);
  assert('bond geometry is preserved by translation',
    after.every((d, i) => Math.abs(d - before[i]) < 1e-6),
    `before=${before.join(',')} after=${after.join(',')}`);
});

await runTest('detour-navigation: assay returns finite behavior metrics', async () => {
  const result = await runDetourAssay({
    preset: 'soup',
    ticks: 20,
    cap: 96,
    start: 64,
    seed: 0xD370A,
    barrier: 'glass',
    combatMode: 'event',
  });

  assert('tracked cohort exists', result.tracked > 0, `tracked=${result.tracked}`);
  assertInRange('crossRate', result.crossRate, 0, 1);
  assertInRange('goalRate', result.goalRate, 0, 1);
  assertInRange('survivalRate', result.survivalRate, 0, 1);
  assert('min goal distance is finite', Number.isFinite(result.meanMinGoalDistance),
    `meanMinGoalDistance=${result.meanMinGoalDistance}`);
  assert('max x is finite', Number.isFinite(result.meanMaxX),
    `meanMaxX=${result.meanMaxX}`);
  assertInRange('meanSpeedCapFracAlive', result.meanSpeedCapFracAlive, 0, 1.5);
  assertInRange('highSpeedAliveRate', result.highSpeedAliveRate, 0, 1);
  assertInRange('gapApproachRate', result.gapApproachRate, 0, 1);
  assertInRange('clusterBodySignalCoverage', result.clusterBodySignalCoverage, 0, 1);
  assertInRange('clusterMessageCoverage', result.clusterMessageCoverage, 0, 1);
  assertInRange('meanClusterMotorConsensus', result.meanClusterMotorConsensus, 0, 1);
  assertInRange('meanClusterFieldStrength', result.meanClusterFieldStrength, 0, 1);
  assertInRange('clusterFieldCoverage', result.clusterFieldCoverage, 0, 1);
  assertInRange('clusterCentroidCrossRate', result.clusterCentroidCrossRate, 0, 1);
  assertInRange('clusterMajorityCrossRate', result.clusterMajorityCrossRate, 0, 1);
  assertInRange('clusterBodyGoalRate', result.clusterBodyGoalRate, 0, 1);
  assertInRange('clusterBodyGapApproachRate', result.clusterBodyGapApproachRate, 0, 1);
  assertInRange('meanClusterCohesion', result.meanClusterCohesion, 0, 1);
  assertInRange('clusterCohesiveCrossRate', result.clusterCohesiveCrossRate, 0, 1);
  assertInRange('clusterCohesiveGoalRate', result.clusterCohesiveGoalRate, 0, 1);
  assert('cluster body route distance is finite',
    Number.isFinite(result.meanClusterMinGoalDistance) &&
    Number.isFinite(result.meanClusterMinGapDistance),
    `bodyMinGoal=${result.meanClusterMinGoalDistance} bodyMinGap=${result.meanClusterMinGapDistance}`);
  assert('cluster morphology metrics are finite',
    Number.isFinite(result.meanClusterMinGapFit) &&
    Number.isFinite(result.meanClusterMaxStretch),
    `gapFit=${result.meanClusterMinGapFit} stretch=${result.meanClusterMaxStretch}`);
  assert('min gap distance is finite', Number.isFinite(result.meanMinGapDistance),
    `meanMinGapDistance=${result.meanMinGapDistance}`);
});

await runTest('detour-navigation: assay can replay an evolved cohort', async () => {
  const result = await runDetourAssay({
    preset: 'soup',
    evolveTicks: 12,
    ticks: 12,
    cap: 96,
    start: 48,
    seed: 0xD370B,
    barrier: 'glass',
    combatMode: 'event',
    cohort: 'elite',
  });

  assert('evolved tick count is reported', result.evolveTicks === 12,
    `evolveTicks=${result.evolveTicks}`);
  assert('elite cohort was tracked', result.tracked > 0,
    `tracked=${result.tracked}`);
  assertInRange('evolved survivalRate', result.survivalRate, 0, 1);
  assert('arena was reset to controlled goal food', result.arena.barrierCells > 0,
    `barrierCells=${result.arena.barrierCells}`);
});

await runTest('detour-navigation: source population can evolve inside arena', async () => {
  const result = await runDetourAssay({
    preset: 'soup',
    evolveTicks: 8,
    evolveInArena: true,
    ticks: 8,
    cap: 80,
    start: 40,
    seed: 0xD370C,
    barrier: 'glass',
    combatMode: 'event',
    cohort: 'mixed',
  });

  assert('arena evolution flag is reported', result.evolveInArena === true,
    `evolveInArena=${result.evolveInArena}`);
  assert('arena-evolved cohort was tracked', result.tracked > 0,
    `tracked=${result.tracked}`);
  assertInRange('arena-evolved survivalRate', result.survivalRate, 0, 1);
});

await runTest('detour-navigation: curriculum stages train through easier gap worlds', async () => {
  const result = await runDetourAssay({
    preset: 'soup',
    evolveTicks: 12,
    curriculum: 'ladder',
    ticks: 8,
    cap: 80,
    start: 40,
    seed: 0xD370D,
    barrier: 'glass',
    combatMode: 'event',
    cohort: 'mixed',
  });

  assert('curriculum mode is reported', result.curriculum === 'ladder',
    `curriculum=${result.curriculum}`);
  assert('curriculum counts as arena training', result.arenaTraining === true,
    `arenaTraining=${result.arenaTraining}`);
  assert('multiple curriculum stages are reported', result.curriculumStages.length >= 2,
    `stages=${result.curriculumStages.length}`);
  const totalStageTicks = result.curriculumStages.reduce((sum, s) => sum + s.ticks, 0);
  assert('curriculum consumes evolve ticks', totalStageTicks === 12,
    `stageTicks=${totalStageTicks}`);
  assert('curriculum stage positions are finite',
    result.curriculumStages.every(s => Number.isFinite(s.startX) && Number.isFinite(s.goalX)),
    JSON.stringify(result.curriculumStages));
  assertInRange('curriculum survivalRate', result.survivalRate, 0, 1);
});

await runTest('detour-navigation: route curriculum adds a finish-run stage', async () => {
  const result = await runDetourAssay({
    preset: 'soup',
    evolveTicks: 15,
    curriculum: 'route',
    ticks: 8,
    cap: 80,
    start: 40,
    seed: 0xD370E,
    barrier: 'glass',
    combatMode: 'event',
    cohort: 'mixed',
  });

  assert('route curriculum mode is reported', result.curriculum === 'route',
    `curriculum=${result.curriculum}`);
  assert('finish-run stage is included',
    result.curriculumStages.some(s => s.name === 'finish-run'),
    JSON.stringify(result.curriculumStages));
  const postGap = result.curriculumStages.find(s => s.name === 'post-gap');
  assert('post-gap finish stage starts on the far side',
    postGap && postGap.startX > result.arena.barrierX,
    JSON.stringify(result.curriculumStages));
  const goalApproach = result.curriculumStages.find(s => s.name === 'goal-approach');
  assert('goal-approach stage starts between barrier and goal',
    goalApproach &&
    goalApproach.startX > result.arena.barrierX &&
    goalApproach.startX < result.arena.goalX,
    JSON.stringify(result.curriculumStages));
  const totalStageTicks = result.curriculumStages.reduce((sum, s) => sum + s.ticks, 0);
  assert('route curriculum consumes evolve ticks', totalStageTicks === 15,
    `stageTicks=${totalStageTicks}`);
});
