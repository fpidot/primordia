// tools/detour-suite.js - repeatable matrix runner for detour assays.
//
// Runs founder controls, evolved particle cohorts, and optional intact vs
// disassembled cluster replays across presets/seeds. This is deliberately a
// measurement tool rather than a benchmark assertion.

import { pathToFileURL } from 'node:url';
import { runDetourAssay } from './detour-assay.js';

const RAW_ARGS = process.argv.slice(2);

function readArg(name, fallback) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function listArg(name, fallback) {
  return String(readArg(name, fallback))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function numArg(name, fallback) {
  const n = Number(readArg(name, fallback));
  return Number.isFinite(n) ? n : fallback;
}

function round(v, n = 3) {
  return Number((Number.isFinite(v) ? v : 0).toFixed(n));
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function summarize(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.preset}|${r.stage}|${r.replayMode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].map(([key, items]) => {
    const [preset, stage, replayMode] = key.split('|');
    return {
      preset,
      stage,
      replayMode,
      runs: items.length,
      trackedMean: round(mean(items.map(r => r.tracked))),
      crossRateMean: round(mean(items.map(r => r.crossRate))),
      goalRateMean: round(mean(items.map(r => r.goalRate))),
      gapApproachMean: round(mean(items.map(r => r.gapApproachRate))),
      survivalMean: round(mean(items.map(r => r.survivalRate))),
      minGoalDistanceMean: round(mean(items.map(r => r.meanMinGoalDistance))),
      minGapDistanceMean: round(mean(items.map(r => r.meanMinGapDistance))),
      fieldGainMean: round(mean(items.map(r => r.meanFieldEnergyGainAlive))),
      meatGainMean: round(mean(items.map(r => r.meanPredationEnergyGainAlive))),
      speedMean: round(mean(items.map(r => r.meanSpeedAlive))),
      speedCapFracMean: round(mean(items.map(r => r.meanSpeedCapFracAlive))),
      motorEffortMean: round(mean(items.map(r => r.meanMotorEffortAlive))),
      highSpeedRateMean: round(mean(items.map(r => r.highSpeedAliveRate))),
      clusterParticlesMean: round(mean(items.map(r => r.clusterSampleParticles || 0))),
      clusterBondsMean: round(mean(items.map(r => r.clusterSampleBonds || 0))),
      clusterTrimmedMean: round(mean(items.map(r => r.clusterSampleTrimmed || 0))),
      bondRetentionMean: round(mean(items.map(r => r.meanBondRetention || 0))),
      clusterBodyDriftMean: round(mean(items.map(r => r.meanClusterBodyDrift || 0))),
      clusterBodyContactMean: round(mean(items.map(r => r.meanClusterBodyContact || 0))),
      clusterBodySlipMean: round(mean(items.map(r => r.meanClusterBodySlip || 0))),
      clusterBodyCoverageMean: round(mean(items.map(r => r.clusterBodySignalCoverage || 0))),
      clusterMessageMean: round(mean(items.map(r => r.meanClusterMessage || 0))),
      clusterMessageCoverageMean: round(mean(items.map(r => r.clusterMessageCoverage || 0))),
      clusterMotorConsensusMean: round(mean(items.map(r => r.meanClusterMotorConsensus || 0))),
      clusterFieldStrengthMean: round(mean(items.map(r => r.meanClusterFieldStrength || 0))),
      clusterFieldCoverageMean: round(mean(items.map(r => r.clusterFieldCoverage || 0))),
    };
  });
}

function printTable(summary) {
  console.log('preset | stage | replay | runs | tracked | cross | goal | gap | survive | minGoal | minGap | field | meat | speed | capFrac | motor | fast | cParts | cBonds | cTrim | bondRet | cDrift | cContact | cSlip | cSignal | cMsg | msgCov | cMotor | cField | fieldCov');
  for (const s of summary) {
    console.log([
      s.preset,
      s.stage,
      s.replayMode,
      s.runs,
      s.trackedMean.toFixed(1),
      s.crossRateMean.toFixed(3),
      s.goalRateMean.toFixed(3),
      s.gapApproachMean.toFixed(3),
      s.survivalMean.toFixed(3),
      s.minGoalDistanceMean.toFixed(1),
      s.minGapDistanceMean.toFixed(1),
      s.fieldGainMean.toFixed(3),
      s.meatGainMean.toFixed(3),
      s.speedMean.toFixed(3),
      s.speedCapFracMean.toFixed(3),
      s.motorEffortMean.toFixed(3),
      s.highSpeedRateMean.toFixed(3),
      s.clusterParticlesMean.toFixed(1),
      s.clusterBondsMean.toFixed(1),
      s.clusterTrimmedMean.toFixed(1),
      s.bondRetentionMean.toFixed(3),
      s.clusterBodyDriftMean.toFixed(3),
      s.clusterBodyContactMean.toFixed(3),
      s.clusterBodySlipMean.toFixed(3),
      s.clusterBodyCoverageMean.toFixed(3),
      s.clusterMessageMean.toFixed(3),
      s.clusterMessageCoverageMean.toFixed(3),
      s.clusterMotorConsensusMean.toFixed(3),
      s.clusterFieldStrengthMean.toFixed(3),
      s.clusterFieldCoverageMean.toFixed(3),
    ].join(' | '));
  }
}

export async function runDetourSuite(opts = {}) {
  const presets = opts.presets || ['soup', 'maze', 'planet'];
  const seeds = opts.seeds || ['0x51A11', '0xA11CE'];
  const replays = opts.replays || ['particles', 'clusters-intact', 'clusters-disassembled'];
  const rows = [];

  for (const preset of presets) {
    for (const seed of seeds) {
      const founder = await runDetourAssay({
        ...opts,
        preset,
        seed,
        evolveTicks: 0,
        replay: 'particles',
        cohort: opts.cohort || 'mixed',
      });
      rows.push({ ...founder, stage: 'founder' });

      for (const replay of replays) {
        const evolved = await runDetourAssay({
          ...opts,
          preset,
          seed,
          replay,
          evolveTicks: opts.evolveTicks,
          cohort: replay === 'particles' ? (opts.cohort || 'elite') : 'mixed',
        });
        rows.push({ ...evolved, stage: 'evolved' });
      }
    }
  }

  return {
    presets,
    seeds,
    ticks: opts.ticks,
    evolveTicks: opts.evolveTicks,
    cap: opts.cap,
    start: opts.start,
    barrier: opts.barrier,
    difficulty: opts.difficulty,
    curriculum: opts.curriculum || 'none',
    scent: opts.scent !== false,
    scentAmount: opts.scentAmount,
    scentRadiusCells: opts.scentRadiusCells,
    evolveInArena: opts.evolveInArena === true,
    combatMode: opts.combatMode,
    rows,
    summary: summarize(rows),
  };
}

async function main() {
  const result = await runDetourSuite({
    presets: listArg('presets', 'soup,maze,planet'),
    seeds: listArg('seeds', '0x51A11,0xA11CE'),
    replays: listArg('replays', 'particles,clusters-intact,clusters-disassembled'),
    ticks: Math.max(1, numArg('ticks', 180)),
    evolveTicks: Math.max(0, numArg('evolveTicks', 360)),
    cap: Math.max(16, numArg('cap', 600)),
    start: Math.max(1, numArg('start', 320)),
    barrier: readArg('barrier', 'glass'),
    difficulty: readArg('difficulty', 'medium'),
    curriculum: readArg('curriculum', 'none'),
    scent: !hasFlag('noScent'),
    scentAmount: numArg('scentAmount', 2.2),
    scentRadiusCells: numArg('scentRadiusCells', 220),
    evolveInArena: hasFlag('evolveInArena'),
    combatMode: readArg('combat', 'event') === 'event' ? 'event' : 'nibble',
    cohort: readArg('cohort', 'elite'),
    clusterBudget: Math.max(8, numArg('clusterBudget', 96)),
    clusterMaxClusters: Math.max(1, numArg('clusterMaxClusters', 4)),
    clusterMinSize: Math.max(2, numArg('clusterMinSize', 8)),
    cohortEnergy: numArg('cohortEnergy', NaN),
    freezeReproduction: !hasFlag('allowRepro'),
  });

  if (hasFlag('json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTable(result.summary);
  }
}

if (!process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    console.error(`args: ${RAW_ARGS.join(' ')}`);
    process.exit(1);
  });
}
