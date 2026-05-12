// tools/detour-assay.js - repeatable obstacle-navigation probe.
//
// This is an evidence generator, not a pass/fail claim that detour planning has
// evolved. It creates a vertical barrier with two gaps and food behind it, then
// measures whether particles that start on the near side cross through/around
// the barrier and approach the goal.

import { pathToFileURL } from 'node:url';
import { mulberry32 } from '../tests/harness.js';
import {
  World, W, H, GW, GH, CELL, MAX_V,
  WALL_MEMBRANE, WALL_POROUS, WALL_SOLID,
} from '../js/sim.js';
import { cloneGenome } from '../js/genome.js';
import { PRESETS, PRESET_COUNTS } from '../js/presets.js';
import { sampleClusterCohort } from './defense-soak.js';

const RAW_ARGS = process.argv.slice(2);
const USE_POSITIONAL_ARGS = RAW_ARGS.length > 0 && RAW_ARGS.every(arg => !arg.startsWith('--'));

function readArg(name, fallback, position = -1) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function readArgOrPos(name, fallback, position = -1) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  if (USE_POSITIONAL_ARGS && position >= 0 && RAW_ARGS[position] !== undefined) {
    return RAW_ARGS[position];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readNumberArg(name, fallback, position = -1) {
  const raw = readArgOrPos(name, '', position);
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, n = 3) {
  return Number((Number.isFinite(v) ? v : 0).toFixed(n));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function wallTypeForName(name) {
  const s = String(name || 'glass').toLowerCase();
  if (s === 'solid') return WALL_SOLID;
  if (s === 'mud' || s === 'porous') return WALL_POROUS;
  return WALL_MEMBRANE;
}

function addFoodPatch(world, x, y, radiusCells, amount) {
  const cx = clamp(Math.floor(x / CELL), 0, GW - 1);
  const cy = clamp(Math.floor(y / CELL), 0, GH - 1);
  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      if (dx * dx + dy * dy > radiusCells * radiusCells) continue;
      const gx = cx + dx;
      const gy = cy + dy;
      if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) continue;
      world.field[0][gy * GW + gx] = amount;
    }
  }
}

function addGoalScent(world, x, y, radiusCells, amount) {
  const cx = clamp(Math.floor(x / CELL), 0, GW - 1);
  const cy = clamp(Math.floor(y / CELL), 0, GH - 1);
  const r = Math.max(1, radiusCells | 0);
  const r2 = r * r;
  let cells = 0;
  for (let gy = Math.max(0, cy - r); gy <= Math.min(GH - 1, cy + r); gy++) {
    for (let gx = Math.max(0, cx - r); gx <= Math.min(GW - 1, cx + r); gx++) {
      const dx = gx - cx;
      const dy = gy - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const idx = gy * GW + gx;
      if (world.walls[idx] === WALL_SOLID) continue;
      const fall = 1 - Math.sqrt(d2) / r;
      const add = amount * fall * fall;
      if (add <= 0) continue;
      world.field[0][idx] = Math.max(world.field[0][idx], add);
      cells++;
    }
  }
  return cells;
}

export function buildDetourArena(world, opts = {}) {
  const barrier = wallTypeForName(opts.barrier || 'glass');
  const difficulty = String(opts.difficulty || 'medium').toLowerCase();
  const diff = difficulty === 'easy' ? 'easy' : difficulty === 'hard' ? 'hard' : 'medium';
  const barrierGx = clamp(Number(opts.barrierGx) || Math.floor(GW * 0.52), 8, GW - 9);
  const defaultGapCells = diff === 'easy' ? 16 : diff === 'hard' ? 8 : 12;
  const defaultGapA = diff === 'easy' ? 0.45 : diff === 'hard' ? 0.34 : 0.40;
  const defaultGapB = diff === 'easy' ? 0.55 : diff === 'hard' ? 0.66 : 0.60;
  const gapCells = Math.max(2, Number(opts.gapCells) || defaultGapCells);
  const gapA = clamp(Number(opts.gapA) || Math.floor(GH * defaultGapA), 8, GH - 9);
  const gapB = clamp(Number(opts.gapB) || Math.floor(GH * defaultGapB), 8, GH - 9);
  const thickness = Math.max(1, Number(opts.thickness) || 2);
  const yMin = 8;
  const yMax = GH - 9;
  let barrierCells = 0;
  let openGapCells = 0;

  if (opts.clearFields !== false) world.clearField?.();
  world.walls.fill(0);
  world.wallOwnerId?.fill?.(0);
  world.wallOwnerClusterId?.fill?.(0);
  world.wallOwnerCladeId?.fill?.(0);
  world.wallOwnerTick?.fill?.(0);
  world._wallCount = 0;

  for (let gy = yMin; gy <= yMax; gy++) {
    const inGap = Math.abs(gy - gapA) <= gapCells || Math.abs(gy - gapB) <= gapCells;
    for (let dx = 0; dx < thickness; dx++) {
      const gx = barrierGx + dx;
      if (gx < 0 || gx >= GW) continue;
      const idx = gy * GW + gx;
      if (inGap) {
        openGapCells++;
        continue;
      }
      world.walls[idx] = barrier;
      world._wallCount++;
      barrierCells++;
    }
  }
  world._wallsVersion++;

  const goalX = Number(opts.goalX) || W * 0.76;
  const goalY = Number(opts.goalY) || H * 0.5;
  const scentAmount = Number(opts.scentAmount) || 2.2;
  const scentRadiusCells = Math.max(12, Number(opts.scentRadiusCells) || 220);
  const scentCells = opts.scent === false
    ? 0
    : addGoalScent(world, goalX, goalY, scentRadiusCells, scentAmount);
  addFoodPatch(world, goalX, goalY, Math.max(3, Number(opts.foodRadiusCells) || 12),
    Number(opts.foodAmount) || 5.5);
  addFoodPatch(world, W * 0.27, H * 0.5, Math.max(2, Number(opts.startFoodRadiusCells) || 5),
    Number(opts.startFoodAmount) || 1.8);

  world.habitatRegions = [
    {
      id: 'detour-start',
      name: 'detour start',
      type: 'start',
      x: W * 0.28,
      y: H * 0.5,
      radius: 26 * CELL,
      gx: Math.floor(W * 0.28 / CELL),
      gy: Math.floor(H * 0.5 / CELL),
      radiusCells: 26,
    },
    {
      id: 'detour-goal',
      name: 'detour goal',
      type: 'goal',
      x: goalX,
      y: goalY,
      radius: 26 * CELL,
      gx: Math.floor(goalX / CELL),
      gy: Math.floor(goalY / CELL),
      radiusCells: 26,
    },
  ];

  return {
    barrier: opts.barrier || 'glass',
    difficulty: diff,
    barrierGx,
    barrierX: (barrierGx + 0.5) * CELL,
    gapCells,
    gapA,
    gapB,
    barrierCells,
    openGapCells,
    scentCells,
    scentRadiusCells: opts.scent === false ? 0 : scentRadiusCells,
    scentAmount: opts.scent === false ? 0 : scentAmount,
    goalX,
    goalY,
  };
}

function initPreset(world, presetName, startCount) {
  if (!PRESETS[presetName]) {
    throw new Error(`Unknown preset "${presetName}". Options: ${Object.keys(PRESETS).join(', ')}`);
  }
  PRESETS[presetName](world, startCount);
}

function cohortScore(p) {
  const brainSlots = p.genome?.brain?.enabledCount?.() || 0;
  const clusterSize = p.cluster?.size || 0;
  return (p.energy || 0) + brainSlots * 0.4 + clusterSize * 0.08 + (p.age || 0) * 0.002;
}

function selectCohort(world, startCount, mode = 'mixed') {
  const live = world.particles.filter(p => p && !p.dead);
  const targetN = Math.min(live.length, Math.max(1, Number(startCount) || live.length));
  const m = String(mode || 'mixed').toLowerCase();
  if (m === 'all') return live;
  if (m === 'random') {
    const shuffled = live.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, targetN);
  }
  if (m === 'elite') {
    return live.slice().sort((a, b) => cohortScore(b) - cohortScore(a)).slice(0, targetN);
  }
  const ranked = live.slice().sort((a, b) => cohortScore(b) - cohortScore(a));
  const eliteN = Math.min(ranked.length, Math.max(1, Math.floor(targetN * 0.5)));
  const picked = ranked.slice(0, eliteN);
  const pickedIds = new Set(picked.map(p => p.id));
  const rest = live.filter(p => !pickedIds.has(p.id));
  while (picked.length < targetN && rest.length > 0) {
    const i = (Math.random() * rest.length) | 0;
    picked.push(rest.splice(i, 1)[0]);
  }
  return picked;
}

function frozenCloneGenome(sample, freezeReproduction = true) {
  const g = cloneGenome(sample.genome);
  if (freezeReproduction) g.repro_thresh = 9999;
  return g;
}

function cohortEnergy(sample, opts = {}) {
  return Number.isFinite(opts.cohortEnergy)
    ? opts.cohortEnergy
    : Math.max(3, Math.min(10, sample.energy || 4));
}

function startPose(i, n, arena, opts = {}) {
  const cx = Number(opts.startX) || W * 0.28;
  const cy = Number(opts.startY) || H * 0.5;
  const a = (i / Math.max(1, n)) * Math.PI * 2;
  const r = 8 + (i % 9) * 3;
  return {
    x: clamp(cx + Math.cos(a) * r, 2, arena.barrierX - 14),
    y: clamp(cy + Math.sin(a) * r, 2, H - 2),
  };
}

export function focusCohortNearStart(world, cohort, arena, opts = {}) {
  const ps = cohort && cohort.length ? cohort : world.particles.filter(p => !p.dead);
  const liveSet = new Set(ps.filter(p => p && !p.dead));
  const bodies = [];
  const assigned = new Set();

  world._clustersTick = -10000;
  world.updateClusters();
  for (const c of world._clusters || []) {
    const members = (c.members || []).filter(p => liveSet.has(p) && !p.dead);
    if (members.length < 2) continue;
    let cx = 0;
    let cy = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of members) {
      cx += p.x;
      cy += p.y;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      assigned.add(p);
    }
    bodies.push({ members, cx: cx / members.length, cy: cy / members.length, minX, maxX, minY, maxY });
  }

  for (const p of ps) {
    if (!p || p.dead || assigned.has(p)) continue;
    bodies.push({ members: [p], cx: p.x, cy: p.y, minX: p.x, maxX: p.x, minY: p.y, maxY: p.y });
  }

  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    const pose = startPose(i, bodies.length, arena, opts);
    const minCenterX = 2 + (body.cx - body.minX);
    const maxCenterX = arena.barrierX - 14 - (body.maxX - body.cx);
    const minCenterY = 2 + (body.cy - body.minY);
    const maxCenterY = H - 2 - (body.maxY - body.cy);
    const targetX = minCenterX <= maxCenterX
      ? clamp(pose.x, minCenterX, maxCenterX)
      : (minCenterX + maxCenterX) * 0.5;
    const targetY = minCenterY <= maxCenterY
      ? clamp(pose.y, minCenterY, maxCenterY)
      : (minCenterY + maxCenterY) * 0.5;
    const dx = targetX - body.cx;
    const dy = targetY - body.cy;
    for (const p of body.members) {
      p.x += dx;
      p.y += dy;
      p.vx = 0;
      p.vy = 0;
      p.lastMotorProgress = 0;
      p.lastMotorSlip = 0;
      p.lastHardContactX = 0;
      p.lastHardContactY = 0;
    }
  }
  if (world._clusterMotion) world._clusterMotion.clear();
  if (world._clusterBus) {
    for (const value of world._clusterBus.values()) {
      value.r = 0;
      value.g = 0;
      value.b = 0;
    }
  }
  world._clustersTick = -10000;
  world.updateClusters();
}

function parseCurriculum(raw) {
  const s = String(raw || 'none').toLowerCase();
  if (s === 'gap' || s === 'near-gap' || s === 'gap-adjacent') return 'gap-adjacent';
  if (s === 'ladder' || s === 'staged') return 'ladder';
  return 'none';
}

function splitStageTicks(totalTicks, weights) {
  const total = Math.max(0, Number(totalTicks) | 0);
  if (total <= 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const ticks = weights.map(w => Math.max(0, Math.floor(total * w / sum)));
  let used = ticks.reduce((a, b) => a + b, 0);
  for (let i = ticks.length - 1; used < total && i >= 0; i = (i - 1 + ticks.length) % ticks.length) {
    ticks[i]++;
    used++;
  }
  return ticks;
}

function curriculumPlan(kind, totalTicks, opts = {}) {
  const baseDifficulty = String(opts.difficulty || 'medium').toLowerCase();
  if (kind === 'gap-adjacent') {
    const [ticks] = splitStageTicks(totalTicks, [1]);
    return ticks ? [{
      name: 'gap-adjacent',
      ticks,
      difficulty: 'easy',
      gapCells: Math.max(18, Number(opts.gapCells) || 22),
      thickness: 1,
      gap: 'upper',
      startDistance: 44,
      goalDistance: 72,
      localGoal: true,
      localScentRadiusCells: 58,
      localFoodRadiusCells: 8,
    }] : [];
  }
  if (kind !== 'ladder') return [];
  const ticks = splitStageTicks(totalTicks, [0.22, 0.26, 0.26, 0.26]);
  const stages = [
    {
      name: 'mouth',
      difficulty: 'easy',
      gapCells: 28,
      thickness: 1,
      gap: 'upper',
      startDistance: 34,
      goalDistance: 48,
      localGoal: true,
      localScentRadiusCells: 44,
      localFoodRadiusCells: 7,
    },
    {
      name: 'near-gap',
      difficulty: 'easy',
      gapCells: 22,
      thickness: 2,
      gap: 'lower',
      startDistance: 68,
      goalDistance: 92,
      localGoal: true,
      localScentRadiusCells: 70,
      localFoodRadiusCells: 8,
    },
    {
      name: 'offset-gap',
      difficulty: 'medium',
      gapCells: 16,
      thickness: 2,
      gap: 'upper',
      startDistance: 124,
      startYOffset: -70,
      goalDistance: 130,
      localGoal: true,
      localScentRadiusCells: 96,
      localFoodRadiusCells: 9,
    },
    {
      name: 'full-start',
      difficulty: baseDifficulty === 'hard' ? 'hard' : 'medium',
      gapCells: Number.isFinite(Number(opts.gapCells)) ? Number(opts.gapCells) : undefined,
      thickness: Number.isFinite(Number(opts.thickness)) ? Number(opts.thickness) : 2,
      fullStart: true,
      localGoal: false,
    },
  ];
  return stages
    .map((stage, i) => ({ ...stage, ticks: ticks[i] || 0 }))
    .filter(stage => stage.ticks > 0);
}

function applyCurriculumStage(world, baseOpts, stage) {
  const stageOpts = {
    ...baseOpts,
    difficulty: stage.difficulty || baseOpts.difficulty,
    gapCells: Number.isFinite(stage.gapCells) ? stage.gapCells : baseOpts.gapCells,
    thickness: Number.isFinite(stage.thickness) ? stage.thickness : baseOpts.thickness,
  };
  const arena = buildDetourArena(world, stageOpts);
  const gapCell = stage.gap === 'lower' ? arena.gapB : arena.gapA;
  const gapY = (gapCell + 0.5) * CELL;
  const startX = stage.fullStart
    ? W * 0.28
    : clamp(arena.barrierX - (stage.startDistance || 64), 16, arena.barrierX - 14);
  const startY = stage.fullStart
    ? H * 0.5
    : clamp(gapY + (stage.startYOffset || 0), 16, H - 16);
  const goalX = stage.localGoal
    ? clamp(arena.barrierX + (stage.goalDistance || 96), arena.barrierX + 12, W - 16)
    : arena.goalX;
  const goalY = stage.localGoal ? gapY : arena.goalY;

  if (stage.localGoal) {
    if (baseOpts.scent !== false) {
      addGoalScent(world, goalX, goalY, Math.max(8, stage.localScentRadiusCells || 60),
        Number(baseOpts.scentAmount) || 2.2);
    }
    addFoodPatch(world, goalX, goalY, Math.max(3, stage.localFoodRadiusCells || 8),
      Number(baseOpts.foodAmount) || 5.5);
  }

  focusCohortNearStart(world, world.particles.filter(p => p && !p.dead), arena, { startX, startY });
  return {
    name: stage.name,
    ticks: stage.ticks,
    difficulty: arena.difficulty,
    gapCells: arena.gapCells,
    thickness: stageOpts.thickness,
    startX: round(startX),
    startY: round(startY),
    goalX: round(goalX),
    goalY: round(goalY),
    gapY: round(gapY),
    barrierCells: arena.barrierCells,
  };
}

async function runSourceSteps(world, ticks) {
  for (let t = 0; t < ticks; t++) await world.step();
}

async function runDetourCurriculum(world, opts, totalTicks) {
  const kind = parseCurriculum(opts.curriculum);
  const plan = curriculumPlan(kind, totalTicks, opts);
  const summaries = [];
  for (const stage of plan) {
    const summary = applyCurriculumStage(world, opts, stage);
    await runSourceSteps(world, stage.ticks);
    summary.endTick = world.tick;
    summary.endPopulation = world.particles.filter(p => p && !p.dead).length;
    summaries.push(summary);
  }
  return summaries;
}

function sampleFromParticle(p) {
  return {
    sourceId: p.id,
    species: p.species,
    energy: p.energy || 0,
    age: p.age || 0,
    genome: p.genome,
    slots: p.genome?.brain?.enabledCount?.() || 0,
  };
}

function placeParticleSamples(world, samples, arena, opts = {}) {
  const cohortParticles = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const pose = startPose(i, samples.length, arena, opts);
    const p = world.addParticle(
      pose.x,
      pose.y,
      frozenCloneGenome(sample, opts.freezeReproduction !== false),
      cohortEnergy(sample, opts),
    );
    if (!p) continue;
    p.vx = 0;
    p.vy = 0;
    p.age = sample.age || 0;
    cohortParticles.push(p);
  }
  return { cohortParticles, clusterGroups: [] };
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

function placeClusterSamples(world, cohort, arena, opts = {}) {
  const intact = opts.replay === 'clusters-intact';
  const cohortParticles = [];
  const clusterGroups = [];
  const clusters = cohort?.clusters || [];
  const cx = Number(opts.startX) || W * 0.28;
  const cy = Number(opts.startY) || H * 0.5;
  const ring = Math.max(10, Math.min(70, Math.sqrt(Math.max(1, cohort?.particleCount || 1)) * 5));

  for (let ci = 0; ci < clusters.length; ci++) {
    const source = clusters[ci];
    const a = (ci / Math.max(1, clusters.length)) * Math.PI * 2;
    const baseX = clamp(cx + Math.cos(a) * ring, 16, arena.barrierX - 16);
    const baseY = clamp(cy + Math.sin(a) * ring, 16, H - 16);
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
        clamp(baseX + member.dx * scale, 1, arena.barrierX - 14),
        clamp(baseY + member.dy * scale, 1, H - 1),
        frozenCloneGenome(member, opts.freezeReproduction !== false),
        cohortEnergy(member, opts),
      );
      if (!p) continue;
      p.vx = 0;
      p.vy = 0;
      p.age = member.age || 0;
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

function nearestGapDistance(x, y, arena) {
  const gx = arena.barrierX;
  const gapAy = (arena.gapA + 0.5) * CELL;
  const gapBy = (arena.gapB + 0.5) * CELL;
  return Math.min(Math.hypot(x - gx, y - gapAy), Math.hypot(x - gx, y - gapBy));
}

function initTrackers(world, arena, selectedIds = null) {
  const tracked = new Map();
  for (const p of world.particles) {
    if (!p || p.dead || p.x >= arena.barrierX) continue;
    if (selectedIds && !selectedIds.has(p.id)) continue;
    tracked.set(p.id, {
      id: p.id,
      startX: p.x,
      startY: p.y,
      maxX: p.x,
      minGoalDistance: Math.hypot(p.x - arena.goalX, p.y - arena.goalY),
      minGapDistance: nearestGapDistance(p.x, p.y, arena),
      crossed: false,
      reachedGoal: false,
      nearBarrierSamples: 0,
      nearBarrierSlipSamples: 0,
      stuckSamples: 0,
      fieldEnergyStart: p.fieldEnergyGain || 0,
      predationEnergyStart: p.predationEnergyGain || 0,
    });
  }
  return tracked;
}

function updateTrackers(world, arena, tracked) {
  const byId = new Map(world.particles.map(p => [p.id, p]));
  for (const rec of tracked.values()) {
    const p = byId.get(rec.id);
    if (!p || p.dead) continue;
    rec.maxX = Math.max(rec.maxX, p.x);
    const goalDistance = Math.hypot(p.x - arena.goalX, p.y - arena.goalY);
    rec.minGoalDistance = Math.min(rec.minGoalDistance, goalDistance);
    const gapDistance = nearestGapDistance(p.x, p.y, arena);
    rec.minGapDistance = Math.min(rec.minGapDistance, gapDistance);
    if (p.x > arena.barrierX + 10) rec.crossed = true;
    if (goalDistance < 18) rec.reachedGoal = true;
    const nearBarrier = p.x < arena.barrierX && Math.abs(p.x - arena.barrierX) < 28;
    if (nearBarrier) {
      rec.nearBarrierSamples++;
      if ((p.lastMotorSlip || 0) > 0.35) rec.nearBarrierSlipSamples++;
    }
    if ((p.lastMotorSlip || 0) > 0.55 && (p.lastMotorProgress || 0) < 0.08) rec.stuckSamples++;
  }
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
      meanClusterBodyDrift: 0,
      meanClusterBodyContact: 0,
      meanClusterBodySlip: 0,
      clusterBodySignalCoverage: 0,
      meanClusterMessage: 0,
      clusterMessageCoverage: 0,
      meanClusterMotorConsensus: 0,
      meanClusterFieldStrength: 0,
      clusterFieldCoverage: 0,
    };
  }
  let aliveAny = 0;
  let majorityAlive = 0;
  let memberSurvival = 0;
  let bondRetention = 0;
  let dispersionRatio = 0;
  let bodyDrift = 0;
  let bodyContact = 0;
  let bodySlip = 0;
  let bodySignalGroups = 0;
  let clusterMessage = 0;
  let clusterMessageGroups = 0;
  let motorConsensus = 0;
  let fieldStrength = 0;
  let fieldGroups = 0;
  for (const g of groups) {
    const liveMembers = g.members.filter(p => p && !p.dead);
    if (liveMembers.length > 0) aliveAny++;
    if (liveMembers.length >= Math.ceil(g.startCount * 0.5)) majorityAlive++;
    memberSurvival += liveMembers.length / Math.max(1, g.startCount);
    let retained = 0;
    for (const [a, b] of g.bondPairs) {
      if (!a.dead && !b.dead && a.bonds.includes(b.id) && b.bonds.includes(a.id)) retained++;
    }
    bondRetention += g.startBondCount ? retained / g.startBondCount : 0;
    dispersionRatio += meanDispersion(liveMembers) / Math.max(1, g.initialDispersion);
    const seenClusters = new Set();
    const liveClusters = [];
    for (const p of liveMembers) {
      const c = p.cluster;
      if (!c) continue;
      const key = c.anchorId || c.root || c.name;
      if (seenClusters.has(key)) continue;
      seenClusters.add(key);
      liveClusters.push(c);
    }
    if (liveClusters.length > 0) {
      bodySignalGroups++;
      let drift = 0, contact = 0, slip = 0;
      for (const c of liveClusters) {
        drift += Math.hypot(c.vx || 0, c.vy || 0);
        contact += Math.hypot(c.contactX || 0, c.contactY || 0);
        slip += c.slip || 0;
      }
      bodyDrift += drift / liveClusters.length;
      bodyContact += contact / liveClusters.length;
      bodySlip += slip / liveClusters.length;
      let msg = 0;
      let motor = 0;
      let field = 0;
      for (const c of liveClusters) {
        msg += Math.max(
          Math.abs(c.busR || 0),
          Math.abs(c.busG || 0),
          Math.abs(c.busB || 0),
        );
        motor += c.motorConsensus || 0;
        field += c.fieldStrength || 0;
      }
      msg /= liveClusters.length;
      motor /= liveClusters.length;
      field /= liveClusters.length;
      clusterMessage += msg;
      motorConsensus += motor;
      fieldStrength += field;
      if (msg > 0.08) clusterMessageGroups++;
      if (field > 0.04) fieldGroups++;
    }
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
    meanClusterBodyDrift: round(bodyDrift / groups.length),
    meanClusterBodyContact: round(bodyContact / groups.length),
    meanClusterBodySlip: round(bodySlip / groups.length),
    clusterBodySignalCoverage: round(bodySignalGroups / groups.length),
    meanClusterMessage: round(clusterMessage / groups.length),
    clusterMessageCoverage: round(clusterMessageGroups / groups.length),
    meanClusterMotorConsensus: round(motorConsensus / groups.length),
    meanClusterFieldStrength: round(fieldStrength / groups.length),
    clusterFieldCoverage: round(fieldGroups / groups.length),
  };
}

function parseReplayMode(raw) {
  const value = String(raw || 'particles').toLowerCase();
  if (value === 'intact' || value === 'cluster-intact') return 'clusters-intact';
  if (value === 'disassembled' || value === 'cluster-disassembled') return 'clusters-disassembled';
  return value === 'clusters-intact' || value === 'clusters-disassembled' ? value : 'particles';
}

export async function runDetourAssay(opts = {}) {
  const seed = Number(opts.seed ?? 0xD370A);
  const presetName = opts.preset || 'soup';
  const cap = Math.max(16, Number(opts.cap) || 600);
  const defaultStart = presetName === 'soup' ? 320 : (PRESET_COUNTS[presetName] || cap);
  const start = Math.min(cap, Math.max(1, Number(opts.start) || defaultStart));
  const ticks = Math.max(1, Number(opts.ticks) || 600);
  const evolveTicks = Math.max(0, Number(opts.evolveTicks) || 0);
  const sampleEvery = Math.max(1, Number(opts.sampleEvery) || 6);
  const combatMode = opts.combatMode === 'event' ? 'event' : 'nibble';
  const cohortMode = opts.cohort || 'mixed';
  const replayMode = parseReplayMode(opts.replay);
  const evolveInArena = opts.evolveInArena === true;
  const curriculum = parseCurriculum(opts.curriculum);
  const cohortEnergyOpt = Number(opts.cohortEnergy);
  const challengeOpts = {
    ...opts,
    replay: replayMode,
    freezeReproduction: opts.freezeReproduction !== false,
    cohortEnergy: Number.isFinite(cohortEnergyOpt) ? cohortEnergyOpt : NaN,
  };

  const prevRandom = Math.random;
  Math.random = mulberry32(seed >>> 0);
  try {
    const sourceWorld = new World({ maxParticles: cap, combatMode });
    initPreset(sourceWorld, presetName, start);
    let curriculumStages = [];
    if (curriculum !== 'none' && evolveTicks > 0) {
      curriculumStages = await runDetourCurriculum(sourceWorld, opts, evolveTicks);
    } else {
      if (evolveInArena) {
        const sourceArena = buildDetourArena(sourceWorld, opts);
        focusCohortNearStart(sourceWorld, sourceWorld.particles.filter(p => !p.dead), sourceArena, opts);
      }
      await runSourceSteps(sourceWorld, evolveTicks);
    }

    let sampled = null;
    let selectedSamples = [];
    if (replayMode === 'particles') {
      selectedSamples = selectCohort(sourceWorld, start, cohortMode).map(sampleFromParticle);
    } else {
      sampled = sampleClusterCohort(sourceWorld, Math.max(8, Number(opts.clusterBudget) || start),
        (seed ^ evolveTicks ^ 0xD370C105) >>> 0, {
          clusterMinSize: Math.max(2, Number(opts.clusterMinSize) || 8),
          clusterMaxClusters: Math.max(1, Number(opts.clusterMaxClusters) || 4),
        });
    }

    const world = new World({
      maxParticles: Math.max(cap, selectedSamples.length + (sampled?.particleCount || 0) + 16),
      combatMode,
      clusterBudding: false,
    });
    world.reset();
    const arena = buildDetourArena(world, opts);
    const placed = replayMode === 'particles'
      ? placeParticleSamples(world, selectedSamples, arena, challengeOpts)
      : placeClusterSamples(world, sampled, arena, challengeOpts);
    if (opts.focusStart === false && replayMode === 'particles') {
      focusCohortNearStart(world, placed.cohortParticles, arena, opts);
    }
    const selectedIds = new Set(placed.cohortParticles.map(p => p.id));
    const tracked = initTrackers(world, arena, selectedIds);

    for (let t = 0; t < ticks; t++) {
      await world.step();
      if ((t + 1) % sampleEvery === 0) updateTrackers(world, arena, tracked);
    }
    updateTrackers(world, arena, tracked);

    const records = [...tracked.values()];
    const liveById = new Map(world.particles.filter(p => !p.dead).map(p => [p.id, p]));
    const alive = records.filter(r => liveById.has(r.id));
    let crossed = 0;
    let reachedGoal = 0;
    let approachedGap = 0;
    let minGoalSum = 0;
    let minGapSum = 0;
    let maxXSum = 0;
    let stuckSamples = 0;
    let nearBarrierSamples = 0;
    let nearBarrierSlipSamples = 0;
    let fieldEnergyGain = 0;
    let predationEnergyGain = 0;
    let speedSum = 0;
    let speedCapFracSum = 0;
    let motorEffortSum = 0;
    let idleAlive = 0;
    let highSpeedAlive = 0;
    for (const r of records) {
      if (r.crossed) crossed++;
      if (r.reachedGoal) reachedGoal++;
      if (r.minGapDistance < 60) approachedGap++;
      minGoalSum += r.minGoalDistance;
      minGapSum += r.minGapDistance;
      maxXSum += r.maxX;
      stuckSamples += r.stuckSamples;
      nearBarrierSamples += r.nearBarrierSamples;
      nearBarrierSlipSamples += r.nearBarrierSlipSamples;
      const p = liveById.get(r.id);
      if (p) {
        fieldEnergyGain += (p.fieldEnergyGain || 0) - r.fieldEnergyStart;
        predationEnergyGain += (p.predationEnergyGain || 0) - r.predationEnergyStart;
        const speed = Math.hypot(p.vx || 0, p.vy || 0);
        const cap = MAX_V * (0.5 + Math.min(1, (p.energy || 0) * 0.15) * 0.5);
        const capFrac = cap > 0 ? speed / cap : 0;
        const motor = Math.min(1, Math.hypot(p.lastMotorX || 0, p.lastMotorY || 0));
        speedSum += speed;
        speedCapFracSum += capFrac;
        motorEffortSum += motor;
        if (speed < 0.25) idleAlive++;
        if (capFrac > 0.8) highSpeedAlive++;
      }
    }
    const denom = Math.max(1, records.length);
    const liveDenom = Math.max(1, alive.length);
    return {
      preset: presetName,
      seed: opts.seed ?? '0xD370A',
      ticks,
      evolveTicks,
      evolveInArena,
      arenaTraining: evolveInArena || curriculum !== 'none',
      cap,
      start,
      combatMode,
      cohortMode,
      replayMode,
      curriculum,
      curriculumStages,
      arena,
      tracked: records.length,
      alive: alive.length,
      crossed,
      reachedGoal,
      crossRate: round(crossed / denom),
      goalRate: round(reachedGoal / denom),
      gapApproachRate: round(approachedGap / denom),
      survivalRate: round(alive.length / denom),
      meanMinGoalDistance: round(minGoalSum / denom),
      meanMinGapDistance: round(minGapSum / denom),
      meanMaxX: round(maxXSum / denom),
      meanFieldEnergyGainAlive: round(fieldEnergyGain / liveDenom),
      meanPredationEnergyGainAlive: round(predationEnergyGain / liveDenom),
      meanSpeedAlive: round(speedSum / liveDenom),
      meanSpeedCapFracAlive: round(speedCapFracSum / liveDenom),
      meanMotorEffortAlive: round(motorEffortSum / liveDenom),
      idleAliveRate: round(idleAlive / liveDenom),
      highSpeedAliveRate: round(highSpeedAlive / liveDenom),
      stuckSamplesPerTracked: round(stuckSamples / denom),
      nearBarrierSlipRate: nearBarrierSamples ? round(nearBarrierSlipSamples / nearBarrierSamples) : 0,
      sourcePopulation: sourceWorld.particles.filter(p => p && !p.dead).length,
      sourceClusters: sourceWorld._clusters?.length || 0,
      clusterSampleParticles: sampled?.particleCount || 0,
      clusterSampleBonds: sampled?.bondCount || 0,
      clusterSampleSourceParticles: sampled?.sourceParticleCount || sampled?.particleCount || 0,
      clusterSampleTrimmed: sampled?.trimmedClusterCount || 0,
      ...summarizeClusterGroups(placed.clusterGroups),
    };
  } finally {
    Math.random = prevRandom;
  }
}

async function main() {
  const result = await runDetourAssay({
    preset: readArg('preset', 'soup'),
    ticks: Number(readArgOrPos('ticks', 600, 0)),
    cap: Number(readArgOrPos('cap', 600, 1)),
    start: Number(readArgOrPos('start', 320, 2)),
    seed: readArgOrPos('seed', '0xD370A', 3),
    combatMode: readArgOrPos('combat', 'nibble', 5),
    barrier: readArgOrPos('barrier', 'glass', 4),
    difficulty: readArg('difficulty', 'medium'),
    curriculum: readArg('curriculum', 'none'),
    evolveTicks: readNumberArg('evolveTicks', 0, 6),
    cohort: readArgOrPos('cohort', 'mixed', 7),
    replay: readArgOrPos('replay', 'particles', 8),
    clusterBudget: readNumberArg('clusterBudget', 64),
    clusterMaxClusters: readNumberArg('clusterMaxClusters', 4),
    clusterMinSize: readNumberArg('clusterMinSize', 8),
    cohortEnergy: readNumberArg('cohortEnergy', NaN),
    evolveInArena: hasFlag('evolveInArena'),
    scent: !hasFlag('noScent'),
    scentAmount: readNumberArg('scentAmount', 2.2),
    scentRadiusCells: readNumberArg('scentRadiusCells', 220),
    gapCells: readNumberArg('gapCells', NaN),
    gapA: readNumberArg('gapA', NaN),
    gapB: readNumberArg('gapB', NaN),
    thickness: Number(readArg('thickness', 2)),
    freezeReproduction: !hasFlag('allowRepro'),
    focusStart: !hasFlag('scatter'),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
