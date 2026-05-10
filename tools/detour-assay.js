// tools/detour-assay.js - repeatable obstacle-navigation probe.
//
// This is an evidence generator, not a pass/fail claim that detour planning has
// evolved. It creates a vertical barrier with two gaps and food behind it, then
// measures whether particles that start on the near side cross through/around
// the barrier and approach the goal.

import { pathToFileURL } from 'node:url';
import { mulberry32 } from '../tests/harness.js';
import {
  World, W, H, GW, GH, CELL,
  WALL_MEMBRANE, WALL_POROUS, WALL_SOLID,
} from '../js/sim.js';
import { PRESETS, PRESET_COUNTS } from '../js/presets.js';

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

export function buildDetourArena(world, opts = {}) {
  const barrier = wallTypeForName(opts.barrier || 'glass');
  const barrierGx = clamp(Number(opts.barrierGx) || Math.floor(GW * 0.52), 8, GW - 9);
  const gapCells = Math.max(2, Number(opts.gapCells) || 8);
  const gapA = clamp(Number(opts.gapA) || Math.floor(GH * 0.34), 8, GH - 9);
  const gapB = clamp(Number(opts.gapB) || Math.floor(GH * 0.66), 8, GH - 9);
  const thickness = Math.max(1, Number(opts.thickness) || 2);
  const yMin = 8;
  const yMax = GH - 9;
  let barrierCells = 0;
  let openGapCells = 0;

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
    barrierGx,
    barrierX: (barrierGx + 0.5) * CELL,
    gapCells,
    gapA,
    gapB,
    barrierCells,
    openGapCells,
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

function focusCohortNearStart(world, startCount, arena, opts = {}) {
  const ps = world.particles.filter(p => !p.dead);
  const targetN = Math.min(ps.length, Math.max(1, Number(startCount) || ps.length));
  const cx = Number(opts.startX) || W * 0.28;
  const cy = Number(opts.startY) || H * 0.5;
  for (let i = 0; i < targetN; i++) {
    const p = ps[i];
    const a = (i / Math.max(1, targetN)) * Math.PI * 2;
    const r = 8 + (i % 9) * 3;
    p.x = clamp(cx + Math.cos(a) * r, 2, arena.barrierX - 14);
    p.y = clamp(cy + Math.sin(a) * r, 2, H - 2);
    p.vx = 0;
    p.vy = 0;
  }
}

function initTrackers(world, arena) {
  const tracked = new Map();
  for (const p of world.particles) {
    if (!p || p.dead || p.x >= arena.barrierX) continue;
    tracked.set(p.id, {
      id: p.id,
      startX: p.x,
      startY: p.y,
      maxX: p.x,
      minGoalDistance: Math.hypot(p.x - arena.goalX, p.y - arena.goalY),
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

export async function runDetourAssay(opts = {}) {
  const seed = Number(opts.seed ?? 0xD370A);
  const presetName = opts.preset || 'soup';
  const cap = Math.max(16, Number(opts.cap) || 600);
  const defaultStart = presetName === 'soup' ? 320 : (PRESET_COUNTS[presetName] || cap);
  const start = Math.min(cap, Math.max(1, Number(opts.start) || defaultStart));
  const ticks = Math.max(1, Number(opts.ticks) || 600);
  const sampleEvery = Math.max(1, Number(opts.sampleEvery) || 6);
  const combatMode = opts.combatMode === 'event' ? 'event' : 'nibble';

  const prevRandom = Math.random;
  Math.random = mulberry32(seed >>> 0);
  try {
    const world = new World({ maxParticles: cap, combatMode });
    initPreset(world, presetName, start);
    const arena = buildDetourArena(world, opts);
    if (opts.focusStart !== false) focusCohortNearStart(world, start, arena, opts);
    const tracked = initTrackers(world, arena);

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
    let minGoalSum = 0;
    let maxXSum = 0;
    let stuckSamples = 0;
    let nearBarrierSamples = 0;
    let nearBarrierSlipSamples = 0;
    let fieldEnergyGain = 0;
    let predationEnergyGain = 0;
    for (const r of records) {
      if (r.crossed) crossed++;
      if (r.reachedGoal) reachedGoal++;
      minGoalSum += r.minGoalDistance;
      maxXSum += r.maxX;
      stuckSamples += r.stuckSamples;
      nearBarrierSamples += r.nearBarrierSamples;
      nearBarrierSlipSamples += r.nearBarrierSlipSamples;
      const p = liveById.get(r.id);
      if (p) {
        fieldEnergyGain += (p.fieldEnergyGain || 0) - r.fieldEnergyStart;
        predationEnergyGain += (p.predationEnergyGain || 0) - r.predationEnergyStart;
      }
    }
    const denom = Math.max(1, records.length);
    const liveDenom = Math.max(1, alive.length);
    return {
      preset: presetName,
      seed: opts.seed ?? '0xD370A',
      ticks,
      cap,
      start,
      combatMode,
      arena,
      tracked: records.length,
      alive: alive.length,
      crossed,
      reachedGoal,
      crossRate: round(crossed / denom),
      goalRate: round(reachedGoal / denom),
      survivalRate: round(alive.length / denom),
      meanMinGoalDistance: round(minGoalSum / denom),
      meanMaxX: round(maxXSum / denom),
      meanFieldEnergyGainAlive: round(fieldEnergyGain / liveDenom),
      meanPredationEnergyGainAlive: round(predationEnergyGain / liveDenom),
      stuckSamplesPerTracked: round(stuckSamples / denom),
      nearBarrierSlipRate: nearBarrierSamples ? round(nearBarrierSlipSamples / nearBarrierSamples) : 0,
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
    gapCells: Number(readArg('gapCells', 8)),
    thickness: Number(readArg('thickness', 2)),
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
