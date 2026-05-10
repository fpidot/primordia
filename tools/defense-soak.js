// tools/defense-soak.js - evolution snapshots replayed in danger arenas.
//
// This is an evidence generator, not a pass/fail test. It asks whether later
// lineages survive standardized predator challenges better than earlier ones.
//
// Usage:
//   node tools/defense-soak.js --preset soup --ticks 2400 --cap 1200 --seed 0x51A11
//   node tools/defense-soak.js --ticks 900 --samples 0,300,900 --sampleSize 32 --challengeTicks 180

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
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

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function minOf(values) {
  return values.length ? Math.min(...values) : 0;
}

function maxOf(values) {
  return values.length ? Math.max(...values) : 0;
}

function aggregateChallengeTrials(kind, trials, cohortKind = 'particles') {
  if (!trials.length) {
    return {
      kind,
      cohortKind,
      repeats: 0,
      start: 0,
      survival: 0,
      survivalMin: 0,
      survivalMax: 0,
      predationDeaths: 0,
      injuredAliveFrac: 0,
      mudUsePerTick: 0,
      safeSidePerTick: 0,
      meanPredatorDistance: 0,
      bondMsgPerCellTick: 0,
      cohortClusters: 0,
      meanBondRetention: 0,
      meanDispersionRatio: 0,
      trials: [],
    };
  }
  const get = key => trials.map(t => Number(t[key]) || 0);
  const survival = get('survival');
  return {
    kind,
    cohortKind: trials[0].cohortKind || cohortKind,
    repeats: trials.length,
    start: trials[0].start,
    predatorCount: trials[0].predatorCount,
    cohortEnergy: trials[0].cohortEnergy,
    hunterEnergy: trials[0].hunterEnergy,
    hunterDrive: trials[0].hunterDrive,
    hunterPreference: trials[0].hunterPreference,
    hunterAttraction: trials[0].hunterAttraction,
    survival: round(mean(survival)),
    survivalMin: round(minOf(survival)),
    survivalMax: round(maxOf(survival)),
    aliveMean: round(mean(get('alive'))),
    predationDeaths: round(mean(get('predationDeaths'))),
    predationDeathsMin: round(minOf(get('predationDeaths'))),
    predationDeathsMax: round(maxOf(get('predationDeaths'))),
    predationEnergy: round(mean(get('predationEnergy'))),
    combatAttacks: round(mean(get('combatAttacks'))),
    combatKills: round(mean(get('combatKills'))),
    combatCounters: round(mean(get('combatCounters'))),
    combatEscapes: round(mean(get('combatEscapes'))),
    combatFailedCost: round(mean(get('combatFailedCost'))),
    fieldEnergy: round(mean(get('fieldEnergy'))),
    hitAliveFrac: round(mean(get('hitAliveFrac'))),
    injuredAliveFrac: round(mean(get('injuredAliveFrac'))),
    meanSlotsAlive: round(mean(get('meanSlotsAlive'))),
    mudUsePerTick: round(mean(get('mudUsePerTick'))),
    safeSidePerTick: round(mean(get('safeSidePerTick'))),
    meanPredatorDistance: round(mean(get('meanPredatorDistance'))),
    bondMsgPerCellTick: round(mean(get('bondMsgPerCellTick'))),
    cohortClusters: round(mean(get('cohortClusters'))),
    clustersAliveAny: round(mean(get('clustersAliveAny'))),
    clusterAnySurvival: round(mean(get('clusterAnySurvival'))),
    clustersMajorityAlive: round(mean(get('clustersMajorityAlive'))),
    clusterMajoritySurvival: round(mean(get('clusterMajoritySurvival'))),
    meanMemberSurvival: round(mean(get('meanMemberSurvival'))),
    meanBondRetention: round(mean(get('meanBondRetention'))),
    meanDispersionRatio: round(mean(get('meanDispersionRatio'))),
    trials,
  };
}

async function withSeed(seed, fn) {
  const prev = Math.random;
  Math.random = mulberry32(seed >>> 0);
  try {
    return await fn();
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
  const vitals = typeof world.vitals === 'function' ? world.vitals() : {};
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
    clusterBudParticles: world.totalClusterBudParticles || 0,
    clusterCellBirths: world.totalClusterCellBirths || 0,
    descendantClusters: vitals.descendantClusters || 0,
    descendantParticles: vitals.descendantParticles || 0,
    maxOrganismGeneration: vitals.maxOrganismGeneration || 1,
    clusterBudDiagnostics: vitals.clusterBudDiagnostics || {},
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

export function sampleClusterCohort(world, particleBudget, seed, opts = {}) {
  world.updateClusters();
  const clusters = world._clusters || [];
  const minSize = Math.max(2, Number(opts.clusterMinSize) || 8);
  const maxClusters = Math.max(1, Number(opts.clusterMaxClusters) || 4);
  const budget = Math.max(minSize, Number(particleBudget) || 48);
  const rng = mulberry32(seed >>> 0);

  const candidates = clusters
    .map(c => {
      const members = (c.members || []).filter(p => p && !p.dead);
      if (members.length < minSize || members.length > budget) return null;
      const memberIds = new Set(members.map(p => p.id));
      let energy = 0;
      let age = 0;
      let slots = 0;
      let internalBonds = 0;
      for (const p of members) {
        energy += p.energy || 0;
        age += p.age || 0;
        slots += p.genome?.brain?.enabledCount?.() || 0;
        for (const id of p.bonds || []) if (memberIds.has(id)) internalBonds++;
      }
      const n = Math.max(1, members.length);
      const meanEnergy = energy / n;
      const meanAge = age / n;
      const meanSlots = slots / n;
      const meanBonds = internalBonds / n;
      const compactness = 1 / Math.max(1, c.spread || c.radius || 1);
      const generation = Math.max(1, c.organismGeneration || 1);
      return {
        cluster: c,
        members,
        score: meanEnergy + Math.min(10, meanAge / 150) + meanSlots * 0.5 +
          meanBonds * 0.8 + members.length * 0.35 + compactness * 12 +
          (generation - 1) * 1.5,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  let usedParticles = 0;
  const take = item => {
    if (!item || selected.length >= maxClusters) return false;
    if (usedParticles + item.members.length > budget) return false;
    selected.push(item);
    usedParticles += item.members.length;
    return true;
  };

  for (const c of candidates) take(c);

  if (selected.length < maxClusters) {
    const rest = candidates.filter(c => !selected.includes(c));
    for (let i = rest.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    for (const c of rest) take(c);
  }

  const exported = selected.map((item, clusterIndex) => {
    const c = item.cluster;
    const members = item.members;
    const sourceToLocal = new Map();
    const exportedMembers = members.map((p, localId) => {
      sourceToLocal.set(p.id, localId);
      return {
        localId,
        sourceId: p.id,
        sourceClusterIndex: clusterIndex,
        species: p.genome.species,
        energy: p.energy || 0,
        age: p.age || 0,
        slots: p.genome.brain.enabledCount(),
        bonds: (p.bonds || []).length,
        dx: p.x - c.cx,
        dy: p.y - c.cy,
        genome: cloneGenome(p.genome),
      };
    });
    const bondPairs = [];
    for (const p of members) {
      const a = sourceToLocal.get(p.id);
      for (const partnerId of p.bonds || []) {
        const b = sourceToLocal.get(partnerId);
        if (b === undefined || b <= a) continue;
        bondPairs.push([a, b]);
      }
    }
    return {
      sourceId: c.anchorId || c.root || clusterIndex,
      name: c.name || `cluster-${clusterIndex + 1}`,
      organismRootId: c.organismRootId || c.anchorId || c.root || 0,
      organismGeneration: Math.max(1, c.organismGeneration || 1),
      count: exportedMembers.length,
      radius: c.radius || 0,
      spread: c.spread || 0,
      score: round(item.score),
      members: exportedMembers,
      bonds: bondPairs,
    };
  });

  return {
    mode: 'clusters',
    clusters: exported,
    particleCount: exported.reduce((sum, c) => sum + c.members.length, 0),
    bondCount: exported.reduce((sum, c) => sum + c.bonds.length, 0),
  };
}

function challengeGenomeFromSample(sample, freezeReproduction) {
  const g = cloneGenome(sample.genome);
  if (freezeReproduction) g.repro_thresh = 9999;
  return g;
}

function challengeEnergyFromSample(sample, opts) {
  return Number.isFinite(opts.cohortEnergy)
    ? opts.cohortEnergy
    : Math.max(3, Math.min(10, sample.energy || 4));
}

function parseReplayModes(raw) {
  const value = String(raw || 'particles').toLowerCase();
  if (value === 'both') return ['particles', 'clusters-intact', 'clusters-disassembled'];
  if (value === 'clusters') return ['clusters-intact', 'clusters-disassembled'];
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts.length ? parts : ['particles']) {
    if (p === 'particles' || p === 'particle') out.push('particles');
    else if (p === 'intact' || p === 'cluster-intact' || p === 'clusters-intact') out.push('clusters-intact');
    else if (p === 'disassembled' || p === 'cluster-disassembled' || p === 'clusters-disassembled') out.push('clusters-disassembled');
  }
  return [...new Set(out.length ? out : ['particles'])];
}

function cohortParticleCount(cohort, cohortKind) {
  if (cohortKind === 'particles') return Array.isArray(cohort) ? cohort.length : 0;
  return cohort?.particleCount || 0;
}

function clusterCohortMeanSlots(cohort) {
  const members = cohort?.clusters?.flatMap(c => c.members || []) || [];
  return round(members.reduce((sum, m) => sum + (m.slots || 0), 0) / Math.max(1, members.length));
}

function meanDispersion(particles) {
  const live = particles.filter(p => p && !p.dead);
  if (live.length <= 1) return 0;
  let cx = 0;
  let cy = 0;
  for (const p of live) { cx += p.x; cy += p.y; }
  cx /= live.length;
  cy /= live.length;
  let sum = 0;
  for (const p of live) sum += Math.hypot(p.x - cx, p.y - cy);
  return sum / live.length;
}

function nearestDistanceToAny(p, others) {
  let best = Infinity;
  for (const q of others) {
    if (!q || q.dead) continue;
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : NaN;
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

function placeParticleCohort(world, kind, cohort, opts, centerX, centerY, jitter) {
  const cohortParticles = [];
  const cohortPhase = Math.random() * Math.PI * 2;
  for (let i = 0; i < cohort.length; i++) {
    const sample = cohort[i];
    const a = cohortPhase + (i / Math.max(1, cohort.length)) * Math.PI * 2 +
      (Math.random() - 0.5) * 0.18 * jitter;
    const r = 8 + (i % 5) * 5 + (Math.random() - 0.5) * 4 * jitter;
    const p = world.addParticle(
      centerX + Math.cos(a) * r,
      centerY + Math.sin(a) * r,
      challengeGenomeFromSample(sample, opts.freezeReproduction),
      challengeEnergyFromSample(sample, opts),
    );
    if (p) {
      p.vx = 0;
      p.vy = 0;
      cohortParticles.push(p);
    }
  }
  return { cohortParticles, clusterGroups: [] };
}

function placeClusterCohort(world, kind, cohort, opts, centerX, centerY, jitter, intact) {
  const cohortParticles = [];
  const clusterGroups = [];
  const clusters = cohort?.clusters || [];
  const phase = Math.random() * Math.PI * 2;
  const ring = Math.max(10, Math.min(70, Math.sqrt(Math.max(1, cohort?.particleCount || 1)) * 5));

  for (let ci = 0; ci < clusters.length; ci++) {
    const source = clusters[ci];
    const a = phase + (ci / Math.max(1, clusters.length)) * Math.PI * 2;
    const baseX = clampChallenge(centerX + Math.cos(a) * ring, 16, W - 16);
    const baseY = clampChallenge(centerY + Math.sin(a) * ring, 16, H - 16);
    const scale = Math.min(1, 54 / Math.max(1, source.radius || source.spread || 1));
    const local = new Map();
    const group = {
      sourceId: source.sourceId,
      name: source.name,
      organismGeneration: source.organismGeneration,
      startCount: 0,
      startBondCount: intact ? (source.bonds || []).length : 0,
      members: [],
      bondPairs: [],
      initialDispersion: 1,
    };

    for (const member of source.members || []) {
      const p = world.addParticle(
        clampChallenge(baseX + member.dx * scale + (Math.random() - 0.5) * 2 * jitter, 1, W - 1),
        clampChallenge(baseY + member.dy * scale + (Math.random() - 0.5) * 2 * jitter, 1, H - 1),
        challengeGenomeFromSample(member, opts.freezeReproduction),
        challengeEnergyFromSample(member, opts),
      );
      if (!p) continue;
      p.vx = 0;
      p.vy = 0;
      p.organismRootId = source.organismRootId || source.sourceId || p.id;
      p.organismGeneration = Math.max(1, source.organismGeneration || 1);
      local.set(member.localId, p);
      cohortParticles.push(p);
      group.members.push(p);
    }

    if (intact) {
      for (const [aId, bId] of source.bonds || []) {
        const pa = local.get(aId);
        const pb = local.get(bId);
        if (!pa || !pb || pa === pb) continue;
        if (!pa.bonds.includes(pb.id)) pa.bonds.push(pb.id);
        if (!pb.bonds.includes(pa.id)) pb.bonds.push(pa.id);
        group.bondPairs.push([pa, pb]);
      }
    }

    group.startCount = group.members.length;
    group.initialDispersion = Math.max(1, meanDispersion(group.members));
    if (group.startCount > 0) clusterGroups.push(group);
  }

  world._clustersTick = -10000;
  world.updateClusters();
  return { cohortParticles, clusterGroups };
}

function clampChallenge(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function summarizeClusterGroups(groups) {
  if (!groups.length) {
    return {
      cohortClusters: 0,
      clustersAliveAny: 0,
      clusterAnySurvival: 0,
      clustersMajorityAlive: 0,
      clusterMajoritySurvival: 0,
      meanMemberSurvival: 0,
      meanBondRetention: 0,
      meanDispersionRatio: 0,
    };
  }

  let aliveAny = 0;
  let majorityAlive = 0;
  let memberSurvival = 0;
  let bondRetention = 0;
  let dispersionRatio = 0;
  for (const group of groups) {
    const live = group.members.filter(p => p && !p.dead);
    const survival = live.length / Math.max(1, group.startCount);
    memberSurvival += survival;
    if (live.length > 0) aliveAny++;
    if (live.length >= Math.ceil(group.startCount * 0.5)) majorityAlive++;
    if (group.startBondCount > 0) {
      let retained = 0;
      for (const [a, b] of group.bondPairs) {
        if (!a.dead && !b.dead && a.bonds.includes(b.id) && b.bonds.includes(a.id)) retained++;
      }
      bondRetention += retained / Math.max(1, group.startBondCount);
    }
    dispersionRatio += meanDispersion(live) / Math.max(1, group.initialDispersion);
  }

  return {
    cohortClusters: groups.length,
    clustersAliveAny: aliveAny,
    clusterAnySurvival: round(aliveAny / groups.length),
    clustersMajorityAlive: majorityAlive,
    clusterMajoritySurvival: round(majorityAlive / groups.length),
    meanMemberSurvival: round(memberSurvival / groups.length),
    meanBondRetention: round(bondRetention / groups.length),
    meanDispersionRatio: round(dispersionRatio / groups.length),
  };
}

export async function runChallenge(kind, cohort, opts, seed, cohortKind = 'particles') {
  return withSeed(seed, async () => {
    const startCount = cohortParticleCount(cohort, cohortKind);
    const predatorCount = Math.max(1, Math.round(startCount * opts.predatorRatio));
    const world = new World({
      maxParticles: startCount + predatorCount + 16,
      clusterBudding: false,
      combatMode: opts.combatMode,
    });
    world.reset();
    if (kind === 'glass-gap') addGlassGap(world);
    if (kind === 'mud-refuge') addMudRefuge(world);

    const centerX = kind === 'glass-gap' ? W * 0.36 : W * 0.5;
    const centerY = H * 0.5;
    const jitter = Math.max(0, opts.challengeJitter || 0);
    const placed = cohortKind === 'particles'
      ? placeParticleCohort(world, kind, cohort, opts, centerX, centerY, jitter)
      : placeClusterCohort(world, kind, cohort, opts, centerX, centerY, jitter, cohortKind === 'clusters-intact');
    const cohortParticles = placed.cohortParticles;
    const clusterGroups = placed.clusterGroups;

    const hunterBase = makeHunterGenome(opts);
    const predatorX = kind === 'glass-gap' ? W * 0.63 : W * 0.5;
    const predatorPhase = Math.random() * Math.PI * 2;
    const hunterParticles = [];
    for (let i = 0; i < predatorCount; i++) {
      const a = predatorPhase + (i / Math.max(1, predatorCount)) * Math.PI * 2 +
        (Math.random() - 0.5) * 0.24 * jitter;
      const r = (kind === 'glass-gap' ? 24 + (i % 3) * 8 : 42 + (i % 5) * 5) +
        (Math.random() - 0.5) * 8 * jitter;
      const h = world.addParticle(
        predatorX + Math.cos(a) * r,
        centerY + Math.sin(a) * r,
        cloneGenome(hunterBase),
        opts.hunterEnergy,
      );
      if (h) {
        h.vx = 0;
        h.vy = 0;
        hunterParticles.push(h);
      }
    }

    addFoodOasis(world, centerX, centerY, 8, 4.0);
    if (kind === 'glass-gap') addFoodOasis(world, W * 0.25, H * 0.5, 8, 4.0);

    let mudUseSamples = 0;
    let safeSideSamples = 0;
    let predatorDistanceSamples = 0;
    let predatorDistanceCount = 0;
    let bondMsgSamples = 0;
    let bondMsgCount = 0;
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
          const predatorDistance = nearestDistanceToAny(p, hunterParticles);
          if (Number.isFinite(predatorDistance)) {
            predatorDistanceSamples += predatorDistance;
            predatorDistanceCount++;
          }
          bondMsgSamples += Math.abs(p.bondMsgR || 0) + Math.abs(p.bondMsgG || 0) +
            Math.abs(p.bondMsgB || 0) + Math.abs(p.incomingBondMsgR || 0) +
            Math.abs(p.incomingBondMsgG || 0) + Math.abs(p.incomingBondMsgB || 0);
          bondMsgCount++;
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
      cohortKind,
      challengeSeed: seed >>> 0,
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
      cohortEnergy: Number.isFinite(opts.cohortEnergy) ? round(opts.cohortEnergy) : null,
      hunterEnergy: round(opts.hunterEnergy),
      hunterDrive: round(opts.hunterDrive),
      hunterPreference: round(opts.hunterPreference),
      hunterAttraction: round(opts.hunterAttraction),
      meanSlotsAlive: round(slots.reduce((a, b) => a + b, 0) / Math.max(1, slots.length)),
      mudUsePerTick: round(mudUseSamples / Math.max(1, sampleTicks * start)),
      safeSidePerTick: round(safeSideSamples / Math.max(1, sampleTicks * start)),
      meanPredatorDistance: round(predatorDistanceSamples / Math.max(1, predatorDistanceCount)),
      bondMsgPerCellTick: round(bondMsgSamples / Math.max(1, bondMsgCount)),
      ...summarizeClusterGroups(clusterGroups),
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
  const challengeRepeats = Math.max(1, Number(readArgCompat('challengeRepeats', 16, 1)) | 0);
  const challengeJitter = Math.max(0, Number(readArgCompat('challengeJitter', 17, challengeRepeats > 1 ? 1 : 0)));
  const cohortEnergyRaw = readArgCompat('cohortEnergy', 18, '');
  const cohortEnergy = cohortEnergyRaw === '' ? NaN : Math.max(0.1, Number(cohortEnergyRaw));
  const replayModes = parseReplayModes(readArgCompat('replay', 19, 'particles'));
  const clusterBudget = Math.max(8, Number(readArgCompat('clusterBudget', 20, sampleSize)) | 0);
  const clusterMaxClusters = Math.max(1, Number(readArgCompat('clusterMaxClusters', 21, 4)) | 0);
  const clusterMinSize = Math.max(2, Number(readArgCompat('clusterMinSize', 22, 8)) | 0);
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
    challengeRepeats,
    challengeJitter,
    cohortEnergy,
    replayModes,
    clusterBudget,
    clusterMaxClusters,
    clusterMinSize,
  };

  const t0 = performance.now();
  Math.random = mulberry32(seed);
  const world = new World({ maxParticles: cap, combatMode });
  initPreset(world, presetName, Math.min(startCount, cap));

  const snapshots = [];
  async function recordSnapshot() {
    world.updateClusters();
    const summary = summarizeWorld(world);
    const particleCohort = sampleCohort(world, sampleSize, (seed ^ world.tick ^ 0x5A17) >>> 0);
    const wantsClusters = replayModes.some(mode => mode.startsWith('clusters-'));
    const clusterCohort = wantsClusters
      ? sampleClusterCohort(world, clusterBudget, (seed ^ world.tick ^ 0xC1057E2) >>> 0, {
          clusterMinSize,
          clusterMaxClusters,
        })
      : { clusters: [], particleCount: 0, bondCount: 0 };
    const challenges = [];
    for (let i = 0; i < challengeKinds.length; i++) {
      const kind = challengeKinds[i];
      for (const cohortKind of replayModes) {
        const cohort = cohortKind === 'particles' ? particleCohort : clusterCohort;
        const trials = [];
        const count = cohortParticleCount(cohort, cohortKind);
        const baseSeed = (seed ^ world.tick ^ ((i + 1) * 0x9E3779B9) ^
          (cohortKind === 'particles' ? 0x1 : cohortKind === 'clusters-intact' ? 0x2 : 0x3)) >>> 0;
        for (let r = 0; r < opts.challengeRepeats && count > 0; r++) {
          const challengeSeed = (baseSeed ^ ((r + 1) * 0x85EBCA6B)) >>> 0;
          const result = await runChallenge(kind, cohort, opts, challengeSeed, cohortKind);
          result.repeat = r;
          trials.push(result);
        }
        challenges.push(aggregateChallengeTrials(kind, trials, cohortKind));
      }
    }
    snapshots.push({
      ...summary,
      sampleSize: particleCohort.length,
      sampleMeanSlots: round(particleCohort.reduce((sum, c) => sum + c.slots, 0) / Math.max(1, particleCohort.length)),
      sampleMaxSlots: particleCohort.length ? Math.max(...particleCohort.map(c => c.slots)) : 0,
      clusterSampleClusters: clusterCohort.clusters.length,
      clusterSampleParticles: clusterCohort.particleCount,
      clusterSampleBonds: clusterCohort.bondCount,
      clusterSampleMeanSlots: clusterCohortMeanSlots(clusterCohort),
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
    challengeRepeats,
    challengeJitter,
    cohortEnergy: Number.isFinite(cohortEnergy) ? cohortEnergy : null,
    replayModes,
    clusterBudget,
    clusterMaxClusters,
    clusterMinSize,
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
  console.log('tick | mode | pop | meanSlots | p90/max | buds/cells | replay | challenge | survival | clusters | bondRet | predDist | predDeaths | injured | mudUse | safeSide');
  for (const s of snapshots) {
    for (const c of s.challenges) {
      const survival = c.repeats === 0
        ? 'n/a'
        : c.repeats > 1
        ? `${c.survival.toFixed(2)}(${c.survivalMin.toFixed(2)}-${c.survivalMax.toFixed(2)})`
        : c.survival.toFixed(2);
      console.log([
        s.tick,
        s.combatMode,
        s.population,
        s.meanSlots.toFixed(2),
        `${s.p90Slots}/${s.maxSlots}`,
        `${s.clusterBuds}/${s.clusterCellBirths}`,
        c.cohortKind,
        c.kind,
        survival,
        `${c.cohortClusters || 0}:${(c.clusterMajoritySurvival || 0).toFixed(2)}`,
        (c.meanBondRetention || 0).toFixed(2),
        (c.meanPredatorDistance || 0).toFixed(0),
        c.predationDeaths,
        (c.injuredAliveFrac || 0).toFixed(2),
        c.mudUsePerTick.toFixed(2),
        c.safeSidePerTick.toFixed(2),
      ].join(' | '));
    }
  }
}

if (!process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
