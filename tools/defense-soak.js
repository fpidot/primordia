// tools/defense-soak.js - evolution snapshots replayed in danger arenas.
//
// This is an evidence generator, not a pass/fail test. It asks whether later
// lineages survive standardized predator challenges better than earlier ones.
//
// Usage:
//   node tools/defense-soak.js --preset soup --ticks 2400 --cap 1200 --seed 0x51A11
//   node tools/defense-soak.js --ticks 900 --samples 0,300,900 --sampleSize 32 --challengeTicks 180

import { performance } from 'node:perf_hooks';
import { mulberry32 } from '../tests/harness.js';
import {
  World, W, H, GW, GH, CELL,
  WALL_MEMBRANE, WALL_POROUS,
} from '../js/sim.js';
import { PRESETS } from '../js/presets.js';
import { cloneGenome, makeGenome, NUM_SPECIES } from '../js/genome.js';
import { OUT_PREDATION, OUT_REPRO_GATE } from '../js/brain.js';

const rawArgs = process.argv.slice(2);
const hasNamedArgs = rawArgs.some(arg => arg.startsWith('--'));
const positionalArgs = rawArgs.filter(arg => !arg.startsWith('--'));

function readArg(name, fallback) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function readArgCompat(name, posIndex, fallback) {
  if (hasNamedArgs) return readArg(name, fallback);
  return positionalArgs[posIndex] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseSeed(raw) {
  return Number(raw);
}

function parseSamples(raw, ticks) {
  if (raw) {
    return [...new Set(raw.split(',')
      .map(s => Math.max(0, Number(s.trim()) | 0))
      .filter(n => Number.isFinite(n) && n <= ticks))]
      .sort((a, b) => a - b);
  }
  const points = [0, Math.round(ticks * 0.25), Math.round(ticks * 0.5), ticks];
  return [...new Set(points)].sort((a, b) => a - b);
}

function round(v, n = 3) {
  return Number((v || 0).toFixed(n));
}

function quantile(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * q)))];
}

function withSeed(seed, fn) {
  const prev = Math.random;
  Math.random = mulberry32(seed >>> 0);
  try {
    return fn();
  } finally {
    Math.random = prev;
  }
}

function initPreset(world, presetName, startCount) {
  if (!PRESETS[presetName]) {
    throw new Error(`Unknown preset "${presetName}". Options: ${Object.keys(PRESETS).join(', ')}`);
  }
  if (presetName === 'soup') PRESETS.soup(world, startCount);
  else PRESETS[presetName](world);
}

function liveParticles(world) {
  return world.particles.filter(p => !p.dead);
}

function summarizeWorld(world) {
  const ps = liveParticles(world);
  const slots = ps.map(p => p.genome.brain.enabledCount());
  const slotHist = {};
  for (const n of slots) slotHist[n] = (slotHist[n] || 0) + 1;
  const energy = ps.map(p => p.energy || 0);
  return {
    tick: world.tick,
    population: ps.length,
    births: world.totalBorn || 0,
    deaths: world.totalDied || 0,
    combatMode: world.combatMode || 'nibble',
    combatAttacks: world.totalCombatAttacks || 0,
    combatKills: world.totalCombatKills || 0,
    combatCounters: world.totalCombatCounters || 0,
    combatEscapes: world.totalCombatEscapes || 0,
    combatFailedCost: round(world.totalCombatFailedCost || 0),
    predationDeaths: world.totalPredationDeaths || 0,
    predationEnergy: round(world.totalPredationEnergyGain || 0),
    fieldEnergy: round(world.totalFieldEnergyGain || 0),
    clusterBuds: world.totalClusterBuds || 0,
    clusters: world._clusters ? world._clusters.length : 0,
    meanSlots: round(slots.reduce((a, b) => a + b, 0) / Math.max(1, slots.length)),
    p90Slots: quantile(slots, 0.9),
    maxSlots: slots.length ? Math.max(...slots) : 0,
    slotHist,
    meanEnergy: round(energy.reduce((a, b) => a + b, 0) / Math.max(1, energy.length)),
  };
}

function sampleCohort(world, sampleSize, seed) {
  const ps = liveParticles(world);
  if (!ps.length) return [];
  const scored = ps
    .map(p => ({
      p,
      score: (p.energy || 0) + Math.min(10, (p.age || 0) / 150) +
        (p.genome.brain.enabledCount() * 0.35) +
        ((p.bonds || []).length * 0.25),
    }))
    .sort((a, b) => b.score - a.score);
  const selected = [];
  const used = new Set();
  const take = p => {
    if (!p || used.has(p.id) || selected.length >= sampleSize) return;
    used.add(p.id);
    selected.push(p);
  };

  const eliteN = Math.min(Math.ceil(sampleSize * 0.5), scored.length);
  for (let i = 0; i < eliteN; i++) take(scored[i].p);

  const rng = mulberry32(seed >>> 0);
  const rest = ps.filter(p => !used.has(p.id));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  for (const p of rest) take(p);

  return selected.map(p => ({
    sourceId: p.id,
    species: p.genome.species,
    energy: p.energy || 0,
    age: p.age || 0,
    slots: p.genome.brain.enabledCount(),
    bonds: (p.bonds || []).length,
    genome: cloneGenome(p.genome),
  }));
}

function challengeGenomeFromSample(sample, freezeReproduction) {
  const g = cloneGenome(sample.genome);
  if (freezeReproduction) g.repro_thresh = 9999;
  return g;
}

function makeHunterGenome(opts = {}) {
  const attraction = Number.isFinite(opts.hunterAttraction) ? opts.hunterAttraction : 1;
  const preference = Number.isFinite(opts.hunterPreference) ? opts.hunterPreference : 1;
  const drive = Number.isFinite(opts.hunterDrive) ? opts.hunterDrive : 4;
  const g = makeGenome(0);
  g.attraction.fill(attraction);
  g.cohesion = Number.isFinite(opts.hunterCohesion) ? opts.hunterCohesion : 0.15;
  g.sense[0] = Number.isFinite(opts.hunterFoodSense) ? opts.hunterFoodSense : 0.2;
  g.sense[1] = Number.isFinite(opts.hunterDecaySense) ? opts.hunterDecaySense : 1.2;
  g.efficiency = Number.isFinite(opts.hunterEfficiency) ? opts.hunterEfficiency : 1.5;
  g.metab = Number.isFinite(opts.hunterMetab) ? opts.hunterMetab : 0.012;
  g.repro_thresh = 9999;
  g.sense_radius = Number.isFinite(opts.hunterSenseRadius) ? opts.hunterSenseRadius : 70;
  g.kin_aversion = Number.isFinite(opts.hunterKinAversion) ? opts.hunterKinAversion : -0.3;
  if (g.prey_preference) g.prey_preference.fill(preference);
  g.brain.enabled.fill(0);
  g.brain.biasO.fill(0);
  g.brain.biasO[OUT_PREDATION] = drive;
  g.brain.biasO[OUT_REPRO_GATE] = -8;
  return g;
}

function addGlassGap(world) {
  const gx = Math.floor(GW * 0.5);
  const gap1 = Math.floor(GH * 0.32);
  const gap2 = Math.floor(GH * 0.68);
  for (let y = 8; y < GH - 8; y++) {
    const nearGap = Math.abs(y - gap1) < 7 || Math.abs(y - gap2) < 7;
    if (nearGap) continue;
    const idx = y * GW + gx;
    if (!world.walls[idx]) world._wallCount++;
    world.walls[idx] = WALL_MEMBRANE;
  }
  world._wallsVersion++;
}

function addMudRefuge(world) {
  const cx = Math.floor(GW * 0.5);
  const cy = Math.floor(GH * 0.5);
  const r = 18;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const gx = cx + dx;
      const gy = cy + dy;
      if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) continue;
      const idx = gy * GW + gx;
      if (!world.walls[idx]) world._wallCount++;
      world.walls[idx] = WALL_POROUS;
    }
  }
  world._wallsVersion++;
}

function addFoodOasis(world, x, y, radiusCells, amount) {
  const gx0 = Math.max(0, Math.floor(x / CELL) - radiusCells);
  const gx1 = Math.min(GW - 1, Math.floor(x / CELL) + radiusCells);
  const gy0 = Math.max(0, Math.floor(y / CELL) - radiusCells);
  const gy1 = Math.min(GH - 1, Math.floor(y / CELL) + radiusCells);
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const dx = gx - Math.floor(x / CELL);
      const dy = gy - Math.floor(y / CELL);
      if (dx * dx + dy * dy > radiusCells * radiusCells) continue;
      world.field[0][gy * GW + gx] = amount;
    }
  }
}

async function runChallenge(kind, cohort, opts, seed) {
  return withSeed(seed, async () => {
    const predatorCount = Math.max(1, Math.round(cohort.length * opts.predatorRatio));
    const world = new World({
      maxParticles: cohort.length + predatorCount + 16,
      clusterBudding: false,
      combatMode: opts.combatMode,
    });
    world.reset();
    if (kind === 'glass-gap') addGlassGap(world);
    if (kind === 'mud-refuge') addMudRefuge(world);

    const cohortParticles = [];
    const centerX = kind === 'glass-gap' ? W * 0.36 : W * 0.5;
    const centerY = H * 0.5;
    for (let i = 0; i < cohort.length; i++) {
      const a = (i / Math.max(1, cohort.length)) * Math.PI * 2;
      const r = 8 + (i % 5) * 5;
      const p = world.addParticle(
        centerX + Math.cos(a) * r,
        centerY + Math.sin(a) * r,
        challengeGenomeFromSample(cohort[i], opts.freezeReproduction),
        Math.max(3, Math.min(10, cohort[i].energy || 4)),
      );
      if (p) {
        p.vx = 0;
        p.vy = 0;
        cohortParticles.push(p);
      }
    }

    const hunterBase = makeHunterGenome(opts);
    const predatorX = kind === 'glass-gap' ? W * 0.63 : W * 0.5;
    for (let i = 0; i < predatorCount; i++) {
      const a = (i / Math.max(1, predatorCount)) * Math.PI * 2;
      const r = kind === 'glass-gap' ? 24 + (i % 3) * 8 : 42 + (i % 5) * 5;
      const h = world.addParticle(
        predatorX + Math.cos(a) * r,
        centerY + Math.sin(a) * r,
        cloneGenome(hunterBase),
        opts.hunterEnergy,
      );
      if (h) {
        h.vx = 0;
        h.vy = 0;
      }
    }

    addFoodOasis(world, centerX, centerY, 8, 4.0);
    if (kind === 'glass-gap') addFoodOasis(world, W * 0.25, H * 0.5, 8, 4.0);

    let mudUseSamples = 0;
    let safeSideSamples = 0;
    let sampleTicks = 0;
    for (let t = 0; t < opts.challengeTicks; t++) {
      await world.step();
      if ((t + 1) % opts.challengeSampleEvery === 0) {
        sampleTicks++;
        for (const p of cohortParticles) {
          if (!p || p.dead) continue;
          const gx = Math.max(0, Math.min(GW - 1, (p.x / CELL) | 0));
          const gy = Math.max(0, Math.min(GH - 1, (p.y / CELL) | 0));
          if (world.walls[gy * GW + gx] === WALL_POROUS) mudUseSamples++;
          if (kind === 'glass-gap' && p.x < W * 0.5) safeSideSamples++;
        }
      }
    }

    const start = cohortParticles.length;
    const alive = cohortParticles.filter(p => p && !p.dead);
    const hitAlive = alive.filter(p => p.lastPredationTick >= 0).length;
    const injuredAlive = alive.filter(p => p.lastDamageTick >= 0).length;
    const slots = alive.map(p => p.genome.brain.enabledCount());
    return {
      kind,
      start,
      alive: alive.length,
      survival: round(alive.length / Math.max(1, start)),
      hitAlive,
      hitAliveFrac: round(hitAlive / Math.max(1, start)),
      injuredAlive,
      injuredAliveFrac: round(injuredAlive / Math.max(1, start)),
      predationDeaths: world.totalPredationDeaths || 0,
      predationEnergy: round(world.totalPredationEnergyGain || 0),
      combatAttacks: world.totalCombatAttacks || 0,
      combatKills: world.totalCombatKills || 0,
      combatCounters: world.totalCombatCounters || 0,
      combatEscapes: world.totalCombatEscapes || 0,
      combatFailedCost: round(world.totalCombatFailedCost || 0),
      fieldEnergy: round(world.totalFieldEnergyGain || 0),
      predatorCount,
      hunterEnergy: round(opts.hunterEnergy),
      hunterDrive: round(opts.hunterDrive),
      hunterPreference: round(opts.hunterPreference),
      hunterAttraction: round(opts.hunterAttraction),
      meanSlotsAlive: round(slots.reduce((a, b) => a + b, 0) / Math.max(1, slots.length)),
      mudUsePerTick: round(mudUseSamples / Math.max(1, sampleTicks * start)),
      safeSidePerTick: round(safeSideSamples / Math.max(1, sampleTicks * start)),
    };
  });
}

async function main() {
  const presetName = readArgCompat('preset', 8, 'soup');
  const ticks = Math.max(0, Number(readArgCompat('ticks', 0, 2400)) | 0);
  const cap = Math.max(16, Number(readArgCompat('cap', 2, 1200)) | 0);
  const startCount = Math.max(1, Number(readArgCompat('start', 3, Math.min(800, cap))) | 0);
  const seedRaw = readArgCompat('seed', 7, '0x51A11');
  const seed = parseSeed(seedRaw);
  const sampleSize = Math.max(4, Number(readArgCompat('sampleSize', 4, 48)) | 0);
  const challengeTicks = Math.max(1, Number(readArgCompat('challengeTicks', 5, 240)) | 0);
  const predatorRatio = Math.max(0, Number(readArgCompat('predatorRatio', 9, 0.35)));
  const combatMode = readArgCompat('combat', 10, 'nibble') === 'event' ? 'event' : 'nibble';
  const hunterEnergy = Math.max(0.1, Number(readArgCompat('hunterEnergy', 11, 9)));
  const hunterDrive = Number(readArgCompat('hunterDrive', 12, 4));
  const hunterPreference = Number(readArgCompat('hunterPreference', 13, 1));
  const hunterAttraction = Number(readArgCompat('hunterAttraction', 14, 1));
  const hunterSenseRadius = Math.max(1, Number(readArgCompat('hunterSenseRadius', 15, 70)));
  const samples = parseSamples(readArgCompat('samples', 1, ''), ticks);
  const challengeKinds = readArgCompat('challenges', 6, 'predator,mud-refuge,glass-gap')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const jsonOnly = hasFlag('json');
  const opts = {
    challengeTicks,
    predatorRatio,
    freezeReproduction: !hasFlag('allowRepro'),
    challengeSampleEvery: 12,
    combatMode,
    hunterEnergy,
    hunterDrive,
    hunterPreference,
    hunterAttraction,
    hunterSenseRadius,
  };

  const t0 = performance.now();
  Math.random = mulberry32(seed);
  const world = new World({ maxParticles: cap, combatMode });
  initPreset(world, presetName, Math.min(startCount, cap));

  const snapshots = [];
  async function recordSnapshot() {
    world.updateClusters();
    const summary = summarizeWorld(world);
    const cohort = sampleCohort(world, sampleSize, (seed ^ world.tick ^ 0x5A17) >>> 0);
    const challenges = [];
    for (let i = 0; i < challengeKinds.length; i++) {
      const kind = challengeKinds[i];
      const result = await runChallenge(kind, cohort, opts, (seed ^ world.tick ^ ((i + 1) * 0x9E3779B9)) >>> 0);
      challenges.push(result);
    }
    snapshots.push({
      ...summary,
      sampleSize: cohort.length,
      sampleMeanSlots: round(cohort.reduce((sum, c) => sum + c.slots, 0) / Math.max(1, cohort.length)),
      sampleMaxSlots: cohort.length ? Math.max(...cohort.map(c => c.slots)) : 0,
      challenges,
    });
  }

  let nextSampleIdx = 0;
  if (samples[nextSampleIdx] === 0) {
    await recordSnapshot();
    nextSampleIdx++;
  }
  for (let i = 0; i < ticks; i++) {
    await world.step();
    while (nextSampleIdx < samples.length && world.tick >= samples[nextSampleIdx]) {
      await recordSnapshot();
      nextSampleIdx++;
    }
  }

  const elapsedMs = performance.now() - t0;
  const result = {
    preset: presetName,
    seed: seedRaw,
    ticks,
    cap,
    startCount,
    sampleSize,
    challengeTicks,
    predatorRatio,
    combatMode,
    hunterEnergy,
    hunterDrive,
    hunterPreference,
    hunterAttraction,
    hunterSenseRadius,
    freezeReproduction: opts.freezeReproduction,
    elapsedMs: round(elapsedMs, 1),
    snapshots,
  };

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(JSON.stringify(result, null, 2));
  console.log('\nDefense challenge summary');
  console.log('tick | mode | pop | meanSlots | p90/max | meatE | combat | fieldE | challenge | survival | predDeaths | injured | mudUse | safeSide');
  for (const s of snapshots) {
    for (const c of s.challenges) {
      console.log([
        s.tick,
        s.combatMode,
        s.population,
        s.meanSlots.toFixed(2),
        `${s.p90Slots}/${s.maxSlots}`,
        Math.round(s.predationEnergy),
        `${s.combatKills}/${s.combatCounters}/${s.combatEscapes}`,
        Math.round(s.fieldEnergy),
        c.kind,
        c.survival.toFixed(2),
        c.predationDeaths,
        (c.injuredAliveFrac || 0).toFixed(2),
        c.mudUsePerTick.toFixed(2),
        c.safeSidePerTick.toFixed(2),
      ].join(' | '));
    }
  }
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
