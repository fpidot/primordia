// sim_worker.js - owns a World instance off the browser main thread.

import { World } from './sim.js';
import { PRESETS, PRESET_COUNTS } from './presets.js';
import { buildWorldSnapshot } from './snapshot.js';

let world = new World({ combatMode: 'event' });
let paused = false;
let speed = 1;
let workBudgetMs = 12;
let snapshotIntervalMs = 80;
let acc = 0;
let lastLoopT = performance.now();
let lastSnapshotT = 0;
let forceSnapshot = true;
let profileResetRequested = false;
let activePreset = 'soup';
let presetInitCount = PRESET_COUNTS.soup || 1800;

function hashSeed(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n >>> 0;
  let seed = 0;
  const s = String(value);
  for (let i = 0; i < s.length; i++) seed = ((seed << 5) - seed + s.charCodeAt(i)) | 0;
  return seed >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function withSeed(seedValue, fn) {
  const seed = hashSeed(seedValue);
  if (seed == null) return fn();
  const prev = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = prev;
  }
}

function applyPreset(name = activePreset, count = presetInitCount, seed = null) {
  const fn = PRESETS[name] || PRESETS.soup;
  activePreset = PRESETS[name] ? name : 'soup';
  const defaultCount = PRESET_COUNTS[activePreset] || presetInitCount || 1800;
  const requested = Number.isFinite(Number(count)) ? Number(count) : defaultCount;
  presetInitCount = Math.max(0, Math.min(world.maxParticles || 5000, requested | 0));
  withSeed(seed, () => fn(world, presetInitCount));
  forceSnapshot = true;
}

function postSnapshot() {
  const { snapshot, transfer } = buildWorldSnapshot(world, { resetProfile: profileResetRequested });
  profileResetRequested = false;
  snapshot.worker = {
    ...snapshot.worker,
    paused,
    speed,
    workBudgetMs,
    snapshotIntervalMs,
    activePreset,
  };
  postMessage({ type: 'snapshot', snapshot }, transfer);
  lastSnapshotT = performance.now();
  forceSnapshot = false;
}

async function advanceLoop() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastLoopT) / 1000);
  lastLoopT = now;

  if (!paused) {
    acc += Math.max(0, speed) * dt * 60;
    if (acc > 24) acc = 24;
    const start = performance.now();
    let steps = 0;
    while (acc >= 1 && steps < 16) {
      await world.step();
      acc -= 1;
      steps++;
      if (performance.now() - start > workBudgetMs) break;
    }
  }

  const due = performance.now() - lastSnapshotT >= snapshotIntervalMs;
  if (forceSnapshot || due) postSnapshot();
  setTimeout(advanceLoop, paused ? 24 : 4);
}

onmessage = async (evt) => {
  const msg = evt.data || {};
  const payload = msg.payload || {};
  try {
    switch (msg.type) {
      case 'init':
        world = new World({ maxParticles: payload.maxParticles || 5000, combatMode: 'event' });
        applyPreset(payload.preset || 'soup', payload.count ?? PRESET_COUNTS.soup ?? 1800, payload.seed);
        paused = !!payload.paused;
        speed = Number.isFinite(payload.speed) ? payload.speed : speed;
        workBudgetMs = Number.isFinite(payload.workBudgetMs) ? payload.workBudgetMs : workBudgetMs;
        snapshotIntervalMs = Number.isFinite(payload.snapshotIntervalMs) ? payload.snapshotIntervalMs : snapshotIntervalMs;
        forceSnapshot = true;
        break;
      case 'runState':
        paused = !!payload.paused;
        speed = Number.isFinite(payload.speed) ? payload.speed : speed;
        workBudgetMs = Number.isFinite(payload.workBudgetMs) ? payload.workBudgetMs : workBudgetMs;
        snapshotIntervalMs = Number.isFinite(payload.snapshotIntervalMs) ? payload.snapshotIntervalMs : snapshotIntervalMs;
        break;
      case 'stepOnce':
        await world.step();
        forceSnapshot = true;
        break;
      case 'preset':
        applyPreset(payload.name, payload.count, payload.seed);
        break;
      case 'brush':
        world.brushApply(payload.kind, payload.x, payload.y, payload.radius, payload.strength, payload.spawnSpecies);
        forceSnapshot = true;
        break;
      case 'clearField':
        world.clearField();
        forceSnapshot = true;
        break;
      case 'mutagenStorm':
        world.mutagenStorm(payload.amount);
        forceSnapshot = true;
        break;
      case 'exterminateSpecies':
        world.exterminateSpecies(payload.species | 0);
        forceSnapshot = true;
        break;
      case 'bondBarrier':
        world.bondBarrier = !!payload.enabled;
        break;
      case 'setProfiling':
        if (typeof world.setProfiling === 'function') world.setProfiling(!!payload.enabled);
        profileResetRequested = !!payload.enabled;
        break;
      case 'profileReset':
        profileResetRequested = true;
        break;
      case 'toJSON':
        postMessage({ type: 'response', id: msg.id, ok: true, value: world.toJSON() });
        break;
      case 'toWorldTemplateJSON':
        postMessage({ type: 'response', id: msg.id, ok: true, value: world.toWorldTemplateJSON() });
        break;
      case 'fromJSON':
        world.fromJSON(payload.data);
        forceSnapshot = true;
        break;
      case 'fromWorldTemplateJSON':
        world.fromWorldTemplateJSON(payload.data);
        forceSnapshot = true;
        break;
      default:
        break;
    }
  } catch (err) {
    if (msg.id) {
      postMessage({ type: 'response', id: msg.id, ok: false, error: err?.message || String(err) });
    } else {
      postMessage({ type: 'error', error: err?.stack || err?.message || String(err) });
    }
  }
};

advanceLoop();
