// tests/harness.js — shared utilities for Node-side regression tests.
//
// Runs the sim *core* (sim.js / genome.js / brain.js / lineage.js / presets.js)
// in plain Node. None of the browser-only modules — render, ui, audio, gpu —
// are imported, so no DOM/WebGPU shims are needed.
//
// Determinism: replace Math.random with a seeded Mulberry32 BEFORE creating
// the world. Static imports of the sim modules are safe because their
// module-level code doesn't touch Math.random (constants only). RNG only
// fires once we call PRESETS.* / world.step() / world.addParticle.

// ─── Seeded RNG ────────────────────────────────────────────────────────

export function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedGlobalRandom(seed = 0xC0FFEE) {
  Math.random = mulberry32(seed);
}

// ─── Run loop ──────────────────────────────────────────────────────────

export async function runSim(world, ticks, opts = {}) {
  const reportEvery = opts.reportEvery || 0;
  for (let i = 0; i < ticks; i++) {
    await world.step();
    if (reportEvery && (i + 1) % reportEvery === 0) {
      const m = captureMetrics(world);
      console.log(`  t=${m.tick} n=${m.n} aff=${m.aff.mean.toFixed(2)} ` +
                  `slots=${m.slots.mean.toFixed(2)} pred=${m.pred.mean.toFixed(2)} ` +
                  `comm=${m.comm.toFixed(2)} clusters=${m.clusters}`);
    }
  }
}

// ─── Metric capture ────────────────────────────────────────────────────

function fmt(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    min: s[0],
    med: s[s.length >> 1],
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

export function captureMetrics(world) {
  const ps = world.particles.filter(p => !p.dead);
  const c = world.clades.complexity(world);
  return {
    tick: world.tick,
    n: ps.length,
    born: world.totalBorn,
    died: world.totalDied,
    aff: fmt(ps.map(p => p.genome.cluster_affinity || 0)),
    kin: fmt(ps.map(p => p.genome.kin_aversion || 0.5)),
    slots: fmt(ps.map(p => p.genome.brain.enabledCount())),
    pred: fmt(ps.map(p => p.predationGain)),
    cohesion: fmt(ps.map(p => p.genome.cohesion)),
    comm: c.components.comm,
    depth: c.components.depth,
    radiation: c.components.radiation,
    diversity: c.components.diversity,
    brain: c.components.brain,
    total: c.total,
    clusters: world._clusters.length,
  };
}

// ─── Assertions ────────────────────────────────────────────────────────

export class AssertionFail extends Error {}

export function assertInRange(name, value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AssertionFail(`${name} = ${value} (not a finite number)`);
  }
  if (value < min || value > max) {
    throw new AssertionFail(
      `${name} = ${value.toFixed(4)} out of expected range [${min}, ${max}]`);
  }
}

export function assert(name, cond, msg = '') {
  if (!cond) throw new AssertionFail(`${name} failed${msg ? ' — ' + msg : ''}`);
}

// Pretty-print a metrics object (for fail diagnostics)
export function dumpMetrics(m) {
  const f = (v) => typeof v === 'number' ? v.toFixed(3) : JSON.stringify(v);
  const lines = [
    `  tick=${m.tick}  n=${m.n}  born=${m.born}  died=${m.died}`,
    `  aff:    min=${f(m.aff.min)}  med=${f(m.aff.med)}  max=${f(m.aff.max)}  mean=${f(m.aff.mean)}`,
    `  kin:    min=${f(m.kin.min)}  med=${f(m.kin.med)}  max=${f(m.kin.max)}  mean=${f(m.kin.mean)}`,
    `  slots:  min=${m.slots.min}  med=${m.slots.med}  max=${m.slots.max}  mean=${f(m.slots.mean)}`,
    `  pred:   min=${f(m.pred.min)}  med=${f(m.pred.med)}  max=${f(m.pred.max)}  mean=${f(m.pred.mean)}`,
    `  comm=${f(m.comm)}  depth=${f(m.depth)}  brain=${f(m.brain)}  total=${f(m.total)}`,
    `  clusters=${m.clusters}`,
  ];
  return lines.join('\n');
}

// ─── Test runner ───────────────────────────────────────────────────────

export async function runTest(name, fn) {
  console.log(`\n[test] ${name}`);
  const t0 = Date.now();
  try {
    await fn();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[pass] ${name} (${dt}s)`);
    return true;
  } catch (err) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[FAIL] ${name} (${dt}s)`);
    console.error(`  ${err.message}`);
    if (err.stack && !(err instanceof AssertionFail)) {
      console.error(err.stack.split('\n').slice(1, 5).map(l => '    ' + l).join('\n'));
    }
    return false;
  }
}
