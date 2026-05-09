// tools/bench-cpu.js — deterministic CPU timing probe for local tuning.
//
// Usage:
//   npm run bench:cpu -- --preset soup --ticks 1200 --cap 1500 --seed 0xC0FFEE
//   npm run bench:cpu -- soup 1200 1500 0xC0FFEE

import { performance } from 'node:perf_hooks';
import { mulberry32 } from '../tests/harness.js';
import { World } from '../js/sim.js';
import { PRESETS } from '../js/presets.js';

function readArg(name, fallback) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const positional = process.argv.slice(2).filter(arg => !arg.startsWith('--'));

const presetName = readArg('preset', positional[0] || 'soup');
const ticks = Math.max(1, Number(readArg('ticks', positional[1] || 1200)) | 0);
const cap = Math.max(1, Number(readArg('cap', positional[2] || 1500)) | 0);
const seedRaw = readArg('seed', positional[3] || '0xC0FFEE');
const seed = Number(seedRaw);
const reportEvery = Math.max(0, Number(readArg('reportEvery', 0)) | 0);
const profileEvery = Math.max(0, Number(readArg('profileEvery', 0)) | 0);
const profile = process.argv.includes('--profile');
const combatMode = readArg('combat', positional[4] || 'nibble') === 'event' ? 'event' : 'nibble';

if (!PRESETS[presetName]) {
  console.error(`Unknown preset "${presetName}". Options: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

Math.random = mulberry32(seed);

const world = new World({ maxParticles: cap, combatMode });
if (presetName === 'soup') PRESETS.soup(world, Math.min(800, cap));
else PRESETS[presetName](world);
if ((profile || profileEvery) && typeof world.setProfiling === 'function') world.setProfiling(true);

const startN = world.particles.length;
const profileTrend = [];
const t0 = performance.now();
let lastWindowTick = 0;
let lastWindowTime = t0;
for (let i = 0; i < ticks; i++) {
  await world.step();
  if (reportEvery && (i + 1) % reportEvery === 0) {
    const elapsed = performance.now() - t0;
    const mspt = elapsed / (i + 1);
    console.log(`t=${world.tick} n=${world.particles.length} ms/tick=${mspt.toFixed(3)}`);
  }
  if (profileEvery && (i + 1) % profileEvery === 0 && typeof world.profileSnapshot === 'function') {
    const now = performance.now();
    const windowTicks = world.tick - lastWindowTick;
    const windowMs = now - lastWindowTime;
    const snap = world.profileSnapshot({ reset: true });
    snap.elapsedMs = Number((now - t0).toFixed(1));
    snap.windowTicks = windowTicks;
    snap.windowMsPerTick = Number((windowMs / Math.max(1, windowTicks)).toFixed(3));
    profileTrend.push(snap);
    lastWindowTick = world.tick;
    lastWindowTime = now;
  }
}
const elapsed = performance.now() - t0;
const mspt = elapsed / ticks;
const actions = (world.totalWallDigs || 0) + (world.totalWallDeposits || 0);
const wallCarriers = world.particles.reduce((n, p) => n + (!p.dead && (p.wallCarry || 0) > 0 ? 1 : 0), 0);

console.log(JSON.stringify({
  preset: presetName,
  seed: seedRaw,
  ticks,
  cap,
  combatMode,
  startN,
  endN: world.particles.length,
  elapsedMs: Number(elapsed.toFixed(1)),
  msPerTick: Number(mspt.toFixed(3)),
  ticksPerSecond: Number((1000 / mspt).toFixed(1)),
  born: world.totalBorn,
  died: world.totalDied,
  walls: world._wallCount,
  wallActions: actions,
  wallDigs: world.totalWallDigs || 0,
  wallDeposits: world.totalWallDeposits || 0,
  wallCarriers,
  clusterCellBirths: world.totalClusterCellBirths || 0,
  fieldFoodEaten: Number((world.totalFieldFoodEaten || 0).toFixed(3)),
  fieldEnergyGain: Number((world.totalFieldEnergyGain || 0).toFixed(3)),
  predationEvents: world.totalPredationEvents || 0,
  predationDrain: Number((world.totalPredationDrain || 0).toFixed(3)),
  predationEnergyGain: Number((world.totalPredationEnergyGain || 0).toFixed(3)),
  predationFatalDrains: world.totalPredationFatalDrains || 0,
  predationDeaths: world.totalPredationDeaths || 0,
  combatAttacks: world.totalCombatAttacks || 0,
  combatKills: world.totalCombatKills || 0,
  combatCounters: world.totalCombatCounters || 0,
  combatEscapes: world.totalCombatEscapes || 0,
  combatFailedCost: Number((world.totalCombatFailedCost || 0).toFixed(3)),
  profile: profile && typeof world.profileSummary === 'function' ? world.profileSummary() : undefined,
  profileTrend: profileTrend.length ? profileTrend : undefined,
}, null, 2));
