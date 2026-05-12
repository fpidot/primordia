// sim.js — Primordia simulation core
// Three layers: particles (typed agents w/ evolving genome) + chemical field
// (food/decay) + walls. Closed-loop ecology: dying particles deposit decay,
// decay slowly converts to food, others eat it.

import {
  NUM_SPECIES, NUM_CHEM, SPECIES_NAMES, makeGenome, mutate, cloneGenome,
  genomeToJSON, genomeFromJSON,
} from './genome.js';
import {
  N_INPUT, N_OUTPUT, N_SOUND_CHANNELS,
  OUT_TX, OUT_TY, OUT_EMIT_FOOD, OUT_EMIT_DECAY, OUT_REPRO_GATE,
  OUT_PREDATION, OUT_SIGNAL_R, OUT_SIGNAL_G, OUT_SIGNAL_B,
  OUT_SOUND_AMP, OUT_SOUND_CH, OUT_WANT_BOND, OUT_WANT_MATE,
  OUT_BOND_MSG_R, OUT_BOND_MSG_G, OUT_BOND_MSG_B,
  OUT_DIG, OUT_DEPOSIT,
} from './brain.js';
import { crossoverGenome } from './genome.js';
import { CladeTracker, CLUSTER_HUMAN_NAMES } from './lineage.js';
import {
  RESULT_STRIDE, PAIR_RESULT_STRIDE, EXTRAS_STRIDE,
  RES_FX, RES_FY, RES_NBVX, RES_NBVY,
  RES_SIGR, RES_SIGG, RES_SIGB, RES_SIGN,
  RES_OWNN, RES_ALIENN, RES_CROWD,
  RES_QCNT0, RES_QCNT1, RES_QCNT2, RES_QCNT3,
  RES_QSIG0, RES_QSIG1, RES_QSIG2, RES_QSIG3,
  RES_OUT0,
} from './gpu_pairforce.js';

// Fixed world geometry — canvas internal pixel size = (W, H); camera scales it.
export const GW = 400;
export const GH = 260;
export const CELL = 5;
export const W = GW * CELL;
export const H = GH * CELL;

// Spatial hash cell size. Neighbor scans expand across as many cells as each
// particle's current sense radius needs, so this can stay smaller than the max
// sense cap and avoid late-run over-broad buckets.
export const HASH_CELL = 48;
export const HW = Math.ceil(W / HASH_CELL);
export const HH = Math.ceil(H / HASH_CELL);

// Force-model constants — Phase 0 tuning: stronger forces, longer ranges
// produce the chasing/orbiting/clustering signatures of Particle-Life-style
// emergent organisms.
export const R_CLOSE = 6.0;          // collision radius
const R_CLOSE2 = R_CLOSE * R_CLOSE;
export const K_REP = 1.8;            // short-range repulsion strength
export const K_ATTR = 0.30;          // tent peak strength multiplier
const K_FIELD = 4.5;          // gradient → acceleration scale
const K_FIELD_LONG = 0.12;    // longer-range smell → gentle steering pressure
const K_DRAG = 0.18;          // viscous drag (overdamped, Particle-Lenia style)
export const MAX_V = 3.6;
const K_MOTION_COST = 0.0014; // per-tick energy cost of |v|^2 (raised from 0.0008
                              // to make movement metabolically meaningful — was
                              // ~free before, no pressure to conserve)

// Field constants — tightened for survival pressure. Earlier values produced
// a stable thriving equilibrium with no evolutionary advancement: ambient
// food + carcass recycling kept everyone fed regardless of fitness. Reduced
// PHOTO 42%, PHOTO_SOFT capped lower, DECAY_TO_FOOD halved.
const DIFFUSE = 0.10;          // 3x3 mean blend factor
const DECAY_LOSS = 0.0006;     // food decay
const DECAY_DECAY = 0.003;     // decay channel decay
const DECAY_TO_FOOD = 0.004;   // decay → food conversion rate (Phase 6:
                               // further reduced from 0.006 to make hunting
                               // a real strategy — when carcasses recycle
                               // slowly, food scarcity pushes selection
                               // toward predation)
const MUTAGEN_DECAY = 0.004;
const FOOD_CAP = 6.0;
const DECAY_CAP = 10.0;
const MUTAGEN_CAP = 4.0;
const PHOTO = 0.0007;          // ambient food regen per cell per tick (was 0.0012)
const PHOTO_SOFT = 0.6;        // photo tapers off above this food level (was 1.1)
const SOUND_CAP = 4.0;
const SOUND_DIFFUSE = 0.28;    // sound spreads quickly...
const SOUND_DECAY = 0.08;      // ...and now fades much slower than before
                               // (was 0.20). At 0.08 a single emission carries
                               // 2.5–3× farther — clusters can hear each
                               // other across the world rather than only when
                               // physically near. Required so brains can
                               // condition on distant-cluster activity.

// Reproduction
const REPRO_TAX = 0.15;        // energy lost on splitting
const REPRO_PROB = 0.05;       // chance per tick once threshold met (smoothing)
const REPRO_PROB_SEX = 0.12;   // sexual reproduction is favoured a bit
export const OFFSPRING_BASE_ENERGY = 2.4;
export const OFFSPRING_SURPLUS_FRAC = 0.16;
export const OFFSPRING_MAX_ENERGY = 5.6;
export const OFFSPRING_SEX_MAX_ENERGY = 6.0;
const OFFSPRING_PARENT_FLOOR = 2.0;
const CLUSTER_BUD_INTERVAL = 48;
const CLUSTER_BUD_COOLDOWN = 720;
const CLUSTER_BUD_PROB = 0.035;
const CLUSTER_BUD_PROB_MAX = 0.16;
const CLUSTER_BUD_READINESS_MAX = 10;
const CLUSTER_BUD_MIN_SIZE = 8;
const CLUSTER_BUD_MIN_CHILDREN = 8;
const CLUSTER_BUD_MAX_CHILDREN = 14;
const CLUSTER_BUD_MIN_MEAN_AGE = 180;
const CLUSTER_BUD_MIN_MEAN_ENERGY = 8.0;
const CLUSTER_BUD_MIN_MEAN_BONDS = 1.9;
const CLUSTER_BUD_PARENT_FLOOR = 3.0;
export const CLUSTER_BUD_CHILD_MAX_ENERGY = 5.8;
const CLUSTER_BUD_TAX = 0.08;
const CLUSTER_BUD_MUTATION_BOOST = 0.55;
const CLUSTER_BUD_RESERVE_FRAC = 0.035;
const CLUSTER_BUD_RESERVE_MAX = 72;
const DEATH_DEPOSIT = 1.4;     // decay packet released on death
const EAT_MAX = 0.18;          // max food a particle can eat per tick
const PREDATION_BASE_RATE = 0.20;
const PREDATION_CONVERSION = 0.90;
const COMBAT_ATTACK_GATE = 0.35;
const COMBAT_ATTACK_COST = 0.32;
const COMBAT_ATTACK_COOLDOWN = 5;
const COMBAT_KILL_CONVERSION = 0.82;
const COMBAT_COUNTER_CONVERSION = 0.65;
const COMBAT_ESCAPE_INJURY = 0.22;
const COMBAT_ESCAPE_ATTACKER_INJURY = 0.10;
const COMBAT_ESCAPE_MARGIN = 0.15;
const DAMAGE_SENSOR_DECAY = 0.86;
const DAMAGE_SENSOR_WINDOW = 90;

// Bonds — Phase 3d
const MAX_BONDS = 4;
const BOND_FORM_DIST = 9;          // must be in close contact to form
const BOND_BREAK_DIST = 80;        // dragged apart farther than this → snap
const BOND_REST = 7.5;
const K_BOND = 0.04;
const ENERGY_SHARE_RATE = 0.08;
const BOND_GATE = 0.50;            // sigmoid baseline; ~half of random brains willing
const MATE_GATE = 0.52;            // mating slightly stricter than bonding
// When a bonded particle dies, the rest of the colony pays an energy cost —
// total drain split evenly across surviving bond partners. Reflects the
// physiological shock of losing a connected member; gives selection pressure
// for stable, defensible colonies.
const BOND_DEATH_DRAIN = 1.5;

// Wall manipulation (Thread B-2) — particles can dig adjacent solid walls
// and deposit carried material near their current position.
const WALL_DIG_COST     = 0.30;
const WALL_DEPOSIT_COST = 0.05;     // halved from 0.10 to encourage building
const WALL_CARRY_COST   = 0.0025;   // per carried block per tick; makes load meaningful
const WALL_CARRY_MAX    = 5;
const WALL_SCAN_RANGE   = 6;       // grid cells; sensor reach for wall.{n,s,e,w}
const MUD_SPEED_MULT     = 0.78;
const MUD_ENERGY_DRAIN   = 0.010;
const HARD_CONTACT_TANGENT = 0.18; // rough hard-surface slip so agents do not pin forever
const HARD_CONTACT_ESCAPE  = 0.05; // tiny generic rebound from solid/glass/edges
const CLUSTER_CONTACT_SLIDE = 0.12; // organism-scale surface following from shared contact feedback
const CLUSTER_CONTACT_EXPLORE = 0.62; // coherent wall-following when a body is pushing into an obstacle
const CLUSTER_TRACTION = 0.24; // shared traction when a named organism's motors agree
const CLUSTER_FIELD_STEER = 0.14; // weak distributed-scent steering for named organisms

// Communication has a tiny metabolic cost, but named clusters can convert
// received bond messages into action-specific coordination bonuses.
const SIGNAL_COST  = 0.0012;
const SOUND_COST   = 0.0010;
const BONDMSG_COST = 0.0008;
const BONDMSG_DEGREE_GAIN = 0.10;
const BONDMSG_TOPOLOGY_GAIN = 0.25;
const CLUSTER_MSG_DECAY = 0.84;
const CLUSTER_MSG_TOPOLOGY_GAIN = 0.35;
const COORD_HUNT_BONUS  = 0.25;
const COORD_EAT_BONUS   = 0.08;
const COORD_BUILD_BONUS = 0.35;
const COORD_GUARD_BONUS = 0.32;
const COORD_ALARM_GUARD_BONUS = 0.22;
const WALL_SHELTER_RELIEF = 0.25;
const COORD_SHELTER_RELIEF = 0.25;

// Scan four cardinal directions from grid (gx, gy) for the nearest *real*
// wall (any type) — returns {n, s, e, w} each in [0, 1]. World edges DO NOT
// register: an earlier version did, but that produced a bias toward steering
// into the bounce-bound (where particles can't actually dig anything),
// which a digging lineage would learn to feckly chase. Now sensors only
// fire for diggable interior walls.
function scanWallProximity(walls, gx, gy, targetType = 0) {
  let wn = 0, ws = 0, we = 0, ww = 0;
  const hit = targetType
    ? (idx) => walls[idx] === targetType
    : (idx) => !!walls[idx];
  // North (y decreasing)
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const ny = gy - d;
    if (ny < 0) break;
    if (hit(ny * GW + gx)) { wn = 1 - (d - 1) / WALL_SCAN_RANGE; break; }
  }
  // South (y increasing)
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const ny = gy + d;
    if (ny >= GH) break;
    if (hit(ny * GW + gx)) { ws = 1 - (d - 1) / WALL_SCAN_RANGE; break; }
  }
  // East (x increasing)
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const nx = gx + d;
    if (nx >= GW) break;
    if (hit(gy * GW + nx)) { we = 1 - (d - 1) / WALL_SCAN_RANGE; break; }
  }
  // West (x decreasing)
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const nx = gx - d;
    if (nx < 0) break;
    if (hit(gy * GW + nx)) { ww = 1 - (d - 1) / WALL_SCAN_RANGE; break; }
  }
  return { wn, ws, we, ww };
}

// Combined terrain scan for the hot brain-input paths. It preserves the old
// semantics of independent scans: wall.* reports nearest material of any type,
// while mud/solid/glass report nearest matching material even if another type
// is closer. Output layout: 0..3 wall, 4..7 mud, 8..11 solid, 12..15 glass.
function scanWallAndMudProximityInto(walls, gx, gy, out) {
  let wn = 0, ws = 0, we = 0, ww = 0;
  let mn = 0, ms = 0, me = 0, mw = 0;
  let sn = 0, ss = 0, se = 0, sw = 0;
  let gn = 0, gs = 0, ge = 0, gw = 0;
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const ny = gy - d;
    if (ny < 0) break;
    const wt = walls[ny * GW + gx];
    const v = 1 - (d - 1) / WALL_SCAN_RANGE;
    if (wt) {
      if (!wn) wn = v;
      if (wt === WALL_POROUS && !mn) mn = v;
      if (wt === WALL_SOLID && !sn) sn = v;
      if (wt === WALL_MEMBRANE && !gn) gn = v;
      if (wn && mn && sn && gn) break;
    }
  }
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const ny = gy + d;
    if (ny >= GH) break;
    const wt = walls[ny * GW + gx];
    const v = 1 - (d - 1) / WALL_SCAN_RANGE;
    if (wt) {
      if (!ws) ws = v;
      if (wt === WALL_POROUS && !ms) ms = v;
      if (wt === WALL_SOLID && !ss) ss = v;
      if (wt === WALL_MEMBRANE && !gs) gs = v;
      if (ws && ms && ss && gs) break;
    }
  }
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const nx = gx + d;
    if (nx >= GW) break;
    const wt = walls[gy * GW + nx];
    const v = 1 - (d - 1) / WALL_SCAN_RANGE;
    if (wt) {
      if (!we) we = v;
      if (wt === WALL_POROUS && !me) me = v;
      if (wt === WALL_SOLID && !se) se = v;
      if (wt === WALL_MEMBRANE && !ge) ge = v;
      if (we && me && se && ge) break;
    }
  }
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const nx = gx - d;
    if (nx < 0) break;
    const wt = walls[gy * GW + nx];
    const v = 1 - (d - 1) / WALL_SCAN_RANGE;
    if (wt) {
      if (!ww) ww = v;
      if (wt === WALL_POROUS && !mw) mw = v;
      if (wt === WALL_SOLID && !sw) sw = v;
      if (wt === WALL_MEMBRANE && !gw) gw = v;
      if (ww && mw && sw && gw) break;
    }
  }
  out[0] = wn; out[1] = ws; out[2] = we; out[3] = ww;
  out[4] = mn; out[5] = ms; out[6] = me; out[7] = mw;
  out[8] = sn; out[9] = ss; out[10] = se; out[11] = sw;
  out[12] = gn; out[13] = gs; out[14] = ge; out[15] = gw;
  return out;
}

const LONG_CHEM_UX = new Float32Array([1, 0.7071, 0, -0.7071, -1, -0.7071, 0, 0.7071]);
const LONG_CHEM_UY = new Float32Array([0, 0.7071, 1, 0.7071, 0, -0.7071, -1, -0.7071]);

function sampleLongChemInto(field, gx, gy, radiusCells, out, offset, amountScale = 0.45) {
  const rFar = clamp(radiusCells | 0, 4, 18);
  const rNear = Math.max(2, (rFar * 0.5) | 0);
  const rMid = Math.max(rNear + 1, Math.round(rFar * 0.82));
  const center = field[gy * GW + gx] || 0;
  let vx = 0, vy = 0, total = 0, mean = 0, best = 0, weightSum = 0;
  for (let i = 0; i < 8; i++) {
    const ux = LONG_CHEM_UX[i];
    const uy = LONG_CHEM_UY[i];
    for (let pass = 0; pass < 3; pass++) {
      const rr = pass === 0 ? rNear : (pass === 1 ? rMid : rFar);
      const w = pass === 0 ? 0.45 : (pass === 1 ? 0.75 : 1.0);
      const sx = clamp(Math.round(gx + ux * rr), 0, GW - 1);
      const sy = clamp(Math.round(gy + uy * rr), 0, GH - 1);
      const v = field[sy * GW + sx] || 0;
      const signal = Math.max(0, v - center * 0.20);
      vx += signal * ux * w;
      vy += signal * uy * w;
      total += signal * w;
      mean += v * w;
      weightSum += w;
      if (v > best) best = v;
    }
  }
  const inv = total > 1e-6 ? 1 / total : 0;
  out[offset + 0] = inv ? Math.tanh(vx * inv * 1.35) : 0;
  out[offset + 1] = inv ? Math.tanh(vy * inv * 1.35) : 0;
  out[offset + 2] = Math.tanh(best * amountScale);
  out[offset + 3] = Math.tanh(((mean / Math.max(1, weightSum)) - center) * amountScale);
}

export function solidBlocksLineOfSight(walls, x0, y0, x1, y1) {
  const gx0 = clamp((x0 / CELL) | 0, 0, GW - 1);
  const gy0 = clamp((y0 / CELL) | 0, 0, GH - 1);
  const gx1 = clamp((x1 / CELL) | 0, 0, GW - 1);
  const gy1 = clamp((y1 / CELL) | 0, 0, GH - 1);
  return solidBlocksLineOfSightCells(walls, gx0, gy0, gx1, gy1);
}

function solidBlocksLineOfSightCells(walls, gx0, gy0, gx1, gy1) {
  const dx = gx1 - gx0;
  const dy = gy1 - gy0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps <= 1) return false;
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const gx = clamp(Math.round(gx0 + dx * t), 0, GW - 1);
    const gy = clamp(Math.round(gy0 + dy * t), 0, GH - 1);
    if (walls[gy * GW + gx] === WALL_SOLID) return true;
  }
  return false;
}

// Wall types — `walls[i]` value semantics:
//   0 = open
//   1 = solid    (blocks particles, blocks chemicals/sound) — original behaviour
//   2 = glass (blocks particles, passes chemicals/sound) — transparent barrier
//   3 = mud   (passes particles/fields, slows + drains)  — terrain pressure
// Stored as Uint8 so brushes can paint any of 1/2/3 at the cost of one byte.
export const WALL_OPEN     = 0;
export const WALL_SOLID    = 1;
export const WALL_MEMBRANE = 2;
export const WALL_POROUS   = 3;

// Birth provisioning is bounded: fitter parents can give a better start and
// reproduce again sooner, but offspring still have to forage/defend for wealth.
export function offspringEndowmentForEnergy(parentEnergy, threshold = 8, maxEnergy = OFFSPRING_MAX_ENERGY) {
  const energy = Math.max(0, Number(parentEnergy) || 0);
  const gate = Math.max(0, Number(threshold) || 0);
  const cap = Math.max(OFFSPRING_BASE_ENERGY, Number(maxEnergy) || OFFSPRING_MAX_ENERGY);
  const surplus = Math.max(0, energy - gate);
  return clamp(OFFSPRING_BASE_ENERGY + surplus * OFFSPRING_SURPLUS_FRAC, OFFSPRING_BASE_ENERGY, cap);
}

function offspringCostForEndowment(childEnergy, tax = REPRO_TAX) {
  return Math.max(0, childEnergy) / Math.max(0.01, 1 - tax);
}

function clusterBudChildEnergy(parent, fallbackThreshold) {
  return offspringEndowmentForEnergy(
    parent?.energy || 0,
    parent?.genome?.repro_thresh ?? fallbackThreshold,
    CLUSTER_BUD_CHILD_MAX_ENERGY,
  );
}

function clusterBudEnergyCost(parent, fallbackThreshold) {
  return offspringCostForEndowment(clusterBudChildEnergy(parent, fallbackThreshold), CLUSTER_BUD_TAX);
}

function newClusterBudDiagnostics() {
  return {
    intervals: 0,
    checked: 0,
    tooSmall: 0,
    cooldown: 0,
    age: 0,
    bonds: 0,
    energy: 0,
    chance: 0,
    donors: 0,
    slots: 0,
    eligible: 0,
    budded: 0,
  };
}

function centeredBondMsg(v) {
  return clamp(((Number.isFinite(v) ? v : 0.5) * 2) - 1, -1, 1);
}

function salientMessageMean(members, channel) {
  let weighted = 0;
  let weightSum = 0;
  for (const p of members || []) {
    if (!p || p.dead) continue;
    const v = centeredBondMsg(p[channel]);
    const a = Math.abs(v);
    if (a < 0.04) continue;
    const w = a * a;
    weighted += v * w;
    weightSum += w;
  }
  return weightSum > 1e-6 ? weighted / weightSum : 0;
}

// Bond barrier — bonded clusters act as one-way "moving walls" against
// outsider particles. Outsider = not bonded to either endpoint of the segment.
// Gated on cluster membership so a single bonded pair doesn't form a barrier;
// only fully named clusters (size ≥ MIN_NAMED_CLUSTER) count. Force is
// applied to the outsider only — Newton's 3rd is intentionally violated so
// the cluster reads as a static wall rather than getting battered apart.
const K_BOND_BARRIER = 0.55;       // peak force at zero distance
const BOND_BARRIER_R = 7.5;        // reach perpendicular to segment
const BOND_BARRIER_R2 = BOND_BARRIER_R * BOND_BARRIER_R;

// Density cap: extra metabolic cost when local food is depleted and crowd is high
const CROWD_RADIUS = 14;
const CROWD_PENALTY = 0.0015;

let _id = 0;
let _lineage = 0;

function rng_default() { return Math.random(); }

const CLUSTER_FORBIDDEN_GIVEN_NAMES = new Set(SPECIES_NAMES.map(s => s.toLowerCase()));

function clusterDisplayName(baseName) {
  const parts = String(baseName || 'cluster').split('-').filter(Boolean);
  if (parts.length >= 2) return [parts[0] + parts[1], ...parts.slice(2)].join('-');
  return parts[0] || 'cluster';
}

function romanNumeral(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const vals = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let x = Math.min(3999, Math.floor(n));
  for (const [v, s] of vals) {
    while (x >= v) { out += s; x -= v; }
  }
  return out;
}

function organismGenerationSuffix(generation) {
  const g = Math.max(1, generation | 0);
  if (g <= 1) return '';
  if (g === 2) return ' Jr';
  return ` ${romanNumeral(g)}`;
}

function uniqueClusterDisplayName(baseDisplay, usedNames, anchorId) {
  const parts = String(baseDisplay || 'cluster').split('-').filter(Boolean);
  if (parts.length < 2) return baseDisplay;
  let given = parts[parts.length - 1];
  let givenKey = given.toLowerCase();
  if (!CLUSTER_FORBIDDEN_GIVEN_NAMES.has(givenKey) && !usedNames.has(givenKey)) {
    usedNames.add(givenKey);
    return baseDisplay;
  }
  const pool = CLUSTER_HUMAN_NAMES.filter(n => !CLUSTER_FORBIDDEN_GIVEN_NAMES.has(n.toLowerCase()));
  const start = Math.abs((anchorId || 1) * 1103515245) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(start + i) % pool.length];
    const key = candidate.toLowerCase();
    if (usedNames.has(key)) continue;
    usedNames.add(key);
    parts[parts.length - 1] = candidate;
    return parts.join('-');
  }
  usedNames.add(givenKey);
  return baseDisplay;
}

export class World {
  constructor(opts = {}) {
    this.maxParticles = opts.maxParticles ?? 5000;
    this.tick = 0;

    // Particles stored as plain objects in a JS array (small N, V8-friendly).
    // Hot loops still touch numeric fields — JS engines specialise on these objects.
    this.particles = [];
    this.births = [];       // queue: pushed during step, flushed at end

    // Field channels (food, decay) + mutagen aux + walls
    this.field = [new Float32Array(GW * GH), new Float32Array(GW * GH)];
    this.mutagen = new Float32Array(GW * GH);
    this._decayActive = false;
    this._mutagenActive = false;
    this.walls = new Uint8Array(GW * GH);
    this.habitatRegions = [];
    this.wallOwnerId = new Int32Array(GW * GH);
    this.wallOwnerClusterId = new Int32Array(GW * GH);
    this.wallOwnerCladeId = new Int32Array(GW * GH);
    this.wallOwnerTick = new Int32Array(GW * GH);

    // Spatial hash (linked-list style)
    this.cellHead = new Int32Array(HW * HH);
    this.cellNext = new Int32Array(this.maxParticles);

    // Lineage counter for new particles created from outside
    this.totalBorn = 0;
    this.totalDied = 0;
    this.totalWallDigs = 0;
    this.totalWallDeposits = 0;
    this.totalClusterBuds = 0;
    this.totalClusterBudParticles = 0;
    this.totalClusterCellBirths = 0;
    this.lastClusterBudInfo = null;
    this.totalFieldFoodEaten = 0;
    this.totalFieldEnergyGain = 0;
    this.totalPredationEvents = 0;
    this.totalPredationDrain = 0;
    this.totalPredationEnergyGain = 0;
    this.totalPredationFatalDrains = 0;
    this.totalPredationDeaths = 0;
    this.totalCombatContacts = 0;
    this.totalCombatOneSidedContacts = 0;
    this.totalCombatMutualContacts = 0;
    this.totalCombatAttacks = 0;
    this.totalCombatKills = 0;
    this.totalCombatCounters = 0;
    this.totalCombatEscapes = 0;
    this.totalCombatInjuries = 0;
    this.totalCombatFailedCost = 0;

    this.combatMode = opts.combatMode || 'nibble';

    this.clades = new CladeTracker();

    // Reusable scratch buffers for brain forward pass
    this._brainInput = new Float32Array(N_INPUT);
    this._brainOutput = new Float32Array(N_OUTPUT);
    this._longChemScratch = new Float32Array(8);

    // Phase 2e — sound channels (low-res field, one per channel)
    this._soundFields = [];
    this._soundLastEmit = new Int32Array(N_SOUND_CHANNELS);
    for (let i = 0; i < N_SOUND_CHANNELS; i++) {
      this._soundFields.push(new Float32Array(GW * GH));
      this._soundLastEmit[i] = -9999;
    }

    // Wall counter — lets us skip the wall-zero post-pass when there are none
    this._wallCount = 0;
    // One-shot wall-action audio events: producer is the dig/deposit code
    // path, consumer is audio.js (drained each tick). Cosmetic only.
    this._wallSoundEvents = [];
    this._deathSoundEvents = [];
    this._attackFlashEvents = [];
    // Wall version — bumped on every wall brush so the renderer can rebuild
    // its smooth-edge cache even when count is unchanged but a cell changed
    // type (e.g. solid -> glass).
    this._wallsVersion = 0;
    this._solidWallVersion = -1;
    this._solidWallIndices = [];
    this._solidHashVersion = -1;
    this._solidHashPrefix = new Uint32Array((GW + 1) * (GH + 1));

    // Bonded clusters — recomputed periodically via union-find on the bond
    // graph. Clusters of size ≥ MIN_NAMED_CLUSTER get a name + flag label.
    this._clusters = [];
    this._clustersTick = -10000;
    this._clusterIdCounter = 0;
    this._clusterBudLastTick = new Map();
    this._clusterBudReadiness = new Map();
    this.clusterBudDiagnostics = newClusterBudDiagnostics();
    this.clusterBudding = opts.clusterBudding ?? true;
    this._clusterMotion = new Map();
    this._clusterBus = new Map();
    this._clusterNames = new Map();   // member-set fingerprint → stable name
    // Map from particle.id → cluster object, rebuilt each detection. Lets the
    // camera chase a cluster by holding a reference to one specific member
    // (anchorId): if that particle is still bonded into a cluster the chase
    // continues, otherwise it drops cleanly.
    this._particleToCluster = new Map();

    // Bond-barrier toggle — when on, outsider particles can't pass through
    // bond segments of named clusters. CPU-only; GPU pair-force kernel
    // doesn't know about bonds, so toggling this in GPU mode silently no-ops.
    this.bondBarrier = true;

    // GPU pair-force kernel — set later via attachGPU().
    this._gpu = null;
    this._gpuResults = null;
    this._gpuResultStride = RESULT_STRIDE;
    this._gpuResultPairOnly = false;
    this._gpuPairOnly = false;
    this._gpuPendings = [];
    this._gpuOrderVersion = 0;
    this._gpuLastResultAge = 0;
    this._gpuTicksUsed = 0;
    this._gpuTicksFallback = 0;
    this._gpuAdaptive = true;
    this._gpuCooldownTicks = 0;
    this._gpuAdaptiveCooldowns = 0;
    this._gpuWindowUsed = 0;
    this._gpuWindowFallback = 0;
    this._brainsDirty = true;          // re-upload brain weights when any brain changed
    this._gpuStateDirty = true;        // re-upload transient brain state when GPU state mapping changes
    this._extrasStaging = null;        // Float32Array(maxParticles × EXTRAS_STRIDE) — lazy alloc
    this._gpuValidate = false;
    this._gpuLastDiff = null;
    this._idLookup = [];
    this._idLookupTouched = [];
    this._buildCandX = new Int16Array(4);
    this._buildCandY = new Int16Array(4);
    this._terrainScanScratch = new Float32Array(16);
    this._profileEnabled = false;
    this._profileTotals = new Map();
    this._profileTicks = 0;
    this._profileCounters = null;
  }

  // Attach a GPUPairForce kernel. World does not own its lifecycle; caller
  // toggles via setGPUEnabled().
  attachGPU(kernel) { this._gpu = kernel; }
  setGPUPairOnly(enabled) { this._gpuPairOnly = !!enabled; }
  setGPUEnabled(enabled) {
    this._gpuEnabled = !!enabled && !!this._gpu;
    if (!this._gpuEnabled) {
      this._gpuResults = null;
      this._gpuResultStride = RESULT_STRIDE;
      this._gpuResultPairOnly = false;
      this._gpuPendings.length = 0;
      this._gpuCooldownTicks = 0;
    } else {
      // First GPU-enabled tick must (re)upload all brain weights so the brain
      // kernel doesn't run with the GPU buffer's zeroed initial state.
      this._brainsDirty = true;
      this._gpuStateDirty = true;
      this._gpuCooldownTicks = 0;
      this._gpuAdaptiveCooldowns = 0;
      this._gpuWindowUsed = 0;
      this._gpuWindowFallback = 0;
    }
  }
  isGPUEnabled() { return !!this._gpuEnabled; }
  setGPUValidate(v) { this._gpuValidate = !!v; }
  setProfiling(enabled) {
    this._profileEnabled = !!enabled;
    this._profileTotals.clear();
    this._profileTicks = 0;
    this._profileCounters = enabled ? Object.create(null) : null;
  }
  profileSummary() {
    const ticks = Math.max(1, this._profileTicks || 0);
    const out = {};
    for (const [name, ms] of this._profileTotals) out[name] = +(ms / ticks).toFixed(3);
    return out;
  }
  profileSnapshot({ reset = false } = {}) {
    const phases = this.profileSummary();
    const metrics = this.profileMetrics();
    const snap = {
      tick: this.tick,
      profileTicks: this._profileTicks || 0,
      phases,
      counters: this._profileCounters ? { ...this._profileCounters } : {},
      metrics,
    };
    if (reset && this._profileEnabled) {
      this._profileTotals.clear();
      this._profileTicks = 0;
      this._profileCounters = Object.create(null);
    }
    return snap;
  }
  profileMetrics() {
    const ps = this.particles;
    let bonds = 0;
    let wallCarriers = 0;
    let brainSlots = 0;
    let energy = 0;
    let speed = 0;
    let speedCapFrac = 0;
    let motorEffort = 0;
    let highSpeed = 0;
    let alive = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.dead) continue;
      alive++;
      bonds += p.bonds ? p.bonds.length : 0;
      if ((p.wallCarry || 0) > 0) wallCarriers++;
      if (p.genome && p.genome.brain) brainSlots += p.genome.brain.enabledCount();
      energy += p.energy || 0;
      const sp = Math.hypot(p.vx || 0, p.vy || 0);
      const cap = MAX_V * (0.5 + Math.min(1, (p.energy || 0) * 0.15) * 0.5);
      const frac = cap > 0 ? sp / cap : 0;
      speed += sp;
      speedCapFrac += frac;
      motorEffort += Math.min(1, Math.hypot(p.lastMotorX || 0, p.lastMotorY || 0));
      if (frac > 0.8) highSpeed++;
    }
    const n = Math.max(1, alive);
    let activeSound = 0;
    for (let s = 0; s < this._soundLastEmit.length; s++) {
      if (this.tick - this._soundLastEmit[s] < 60) activeSound++;
    }
    return {
      population: ps.length,
      walls: this._wallCount || 0,
      solidWalls: this._solidWalls ? this._solidWalls().length : 0,
      clusters: this._clusters ? this._clusters.length : 0,
      bonds: (bonds / 2) | 0,
      meanBonds: +(bonds / n).toFixed(3),
      meanBrainSlots: +(brainSlots / n).toFixed(3),
      meanEnergy: +(energy / n).toFixed(3),
      meanSpeed: +(speed / n).toFixed(3),
      meanSpeedCapFrac: +(speedCapFrac / n).toFixed(3),
      meanMotorEffort: +(motorEffort / n).toFixed(3),
      highSpeedFrac: +(highSpeed / n).toFixed(3),
      wallCarriers,
      births: this.totalBorn || 0,
      deaths: this.totalDied || 0,
      wallDigs: this.totalWallDigs || 0,
      wallDeposits: this.totalWallDeposits || 0,
      fieldFoodEaten: +(this.totalFieldFoodEaten || 0).toFixed(3),
      fieldEnergyGain: +(this.totalFieldEnergyGain || 0).toFixed(3),
      predationEvents: this.totalPredationEvents || 0,
      predationDrain: +(this.totalPredationDrain || 0).toFixed(3),
      predationEnergyGain: +(this.totalPredationEnergyGain || 0).toFixed(3),
      predationFatalDrains: this.totalPredationFatalDrains || 0,
      predationDeaths: this.totalPredationDeaths || 0,
      combatMode: this.combatMode || 'nibble',
      combatContacts: this.totalCombatContacts || 0,
      combatOneSidedContacts: this.totalCombatOneSidedContacts || 0,
      combatMutualContacts: this.totalCombatMutualContacts || 0,
      combatAttacks: this.totalCombatAttacks || 0,
      combatKills: this.totalCombatKills || 0,
      combatCounters: this.totalCombatCounters || 0,
      combatEscapes: this.totalCombatEscapes || 0,
      combatInjuries: this.totalCombatInjuries || 0,
      combatFailedCost: +(this.totalCombatFailedCost || 0).toFixed(3),
      clusterBuds: this.totalClusterBuds || 0,
      clusterBudParticles: this.totalClusterBudParticles || 0,
      clusterCellBirths: this.totalClusterCellBirths || 0,
      clusterBudReserve: this.maxParticles - this._cellBirthLimit(),
      clusterBudDiagnostics: { ...(this.clusterBudDiagnostics || newClusterBudDiagnostics()) },
      ...this._organismLineageStats(),
      activeSound,
      gpuEnabled: !!this._gpuEnabled,
      gpuUsed: this._gpuTicksUsed || 0,
      gpuFallback: this._gpuTicksFallback || 0,
      gpuPending: this._gpuPendings ? this._gpuPendings.length : 0,
      gpuCooldown: this._gpuCooldownTicks || 0,
      gpuCooldowns: this._gpuAdaptiveCooldowns || 0,
      gpuPairOnly: !!this._gpuPairOnly,
      gpuResultStride: this._gpuResultStride || RESULT_STRIDE,
    };
  }
  _profileAdd(name, ms) {
    this._profileTotals.set(name, (this._profileTotals.get(name) || 0) + ms);
  }
  _clusterBudReserve() {
    if (!this.clusterBudding) return 0;
    if (this.maxParticles < CLUSTER_BUD_MIN_CHILDREN * 4) return 0;
    return Math.min(
      CLUSTER_BUD_RESERVE_MAX,
      Math.max(CLUSTER_BUD_MIN_CHILDREN, Math.ceil(this.maxParticles * CLUSTER_BUD_RESERVE_FRAC)),
    );
  }
  _cellBirthLimit() {
    return Math.max(1, this.maxParticles - this._clusterBudReserve());
  }
  setMaxParticles(maxParticles) {
    const requested = Number(maxParticles);
    if (!Number.isFinite(requested)) return this.maxParticles;
    const cap = clamp(requested | 0, 1, 20000);
    this.maxParticles = cap;
    const needed = Math.max(cap, this.particles.length + this.births.length);
    if (this.cellNext.length < needed) this.cellNext = new Int32Array(needed);
    if (this._extrasStaging && this._extrasStaging.length < cap * EXTRAS_STRIDE) {
      this._extrasStaging = null;
    }
    if (this._gpu && this._gpu.maxParticles && cap > this._gpu.maxParticles) {
      this.setGPUEnabled(false);
    }
    return this.maxParticles;
  }
  _solidWalls() {
    if (this._solidWallVersion === this._wallsVersion) return this._solidWallIndices;
    const out = this._solidWallIndices;
    out.length = 0;
    const walls = this.walls;
    for (let i = 0; i < walls.length; i++) {
      if (walls[i] === WALL_SOLID) out.push(i);
    }
    this._solidWallVersion = this._wallsVersion;
    return out;
  }
  _solidHashReady(version = this._wallsVersion) {
    if (this._solidHashVersion === version) return;
    if (this._profileCounters) {
      this._profileCounters.solidHashBuilds = (this._profileCounters.solidHashBuilds || 0) + 1;
    }
    const prefix = this._solidHashPrefix;
    prefix.fill(0);
    const walls = this.walls;
    const pw = GW + 1;
    for (let gy = 0; gy < GH; gy++) {
      let rowSum = 0;
      const row = gy * GW;
      const dstRow = (gy + 1) * pw;
      const prevRow = gy * pw;
      for (let gx = 0; gx < GW; gx++) {
        if (walls[row + gx] === WALL_SOLID) rowSum++;
        prefix[dstRow + gx + 1] = prefix[prevRow + gx + 1] + rowSum;
      }
    }
    this._solidHashVersion = version;
  }
  _solidHashRectHasAny(gx0, gy0, gx1, gy1, version = this._wallsVersion) {
    this._solidHashReady(version);
    const counters = this._profileCounters;
    if (counters) counters.solidHashQueries = (counters.solidHashQueries || 0) + 1;
    const minGX = gx0 < gx1 ? gx0 : gx1;
    const maxGX = gx0 > gx1 ? gx0 : gx1;
    const minGY = gy0 < gy1 ? gy0 : gy1;
    const maxGY = gy0 > gy1 ? gy0 : gy1;
    const pw = GW + 1;
    const x0 = Math.max(0, Math.min(GW - 1, minGX));
    const x1 = Math.max(0, Math.min(GW - 1, maxGX)) + 1;
    const y0 = Math.max(0, Math.min(GH - 1, minGY));
    const y1 = Math.max(0, Math.min(GH - 1, maxGY)) + 1;
    const p = this._solidHashPrefix;
    return (p[y1 * pw + x1] - p[y0 * pw + x1] - p[y1 * pw + x0] + p[y0 * pw + x0]) > 0;
  }
  solidBlocksLineOfSightFast(x0, y0, x1, y1, solidSightVersion = this._wallsVersion) {
    const counters = this._profileCounters;
    if (counters) counters.losTests = (counters.losTests || 0) + 1;
    const gx0 = clamp((x0 / CELL) | 0, 0, GW - 1);
    const gy0 = clamp((y0 / CELL) | 0, 0, GH - 1);
    const gx1 = clamp((x1 / CELL) | 0, 0, GW - 1);
    const gy1 = clamp((y1 / CELL) | 0, 0, GH - 1);
    const dx0 = gx1 - gx0;
    const dy0 = gy1 - gy0;
    if (Math.max(Math.abs(dx0), Math.abs(dy0)) <= 1) {
      if (counters) counters.losNearSkips = (counters.losNearSkips || 0) + 1;
      return false;
    }
    if (!this._solidHashRectHasAny(gx0, gy0, gx1, gy1, solidSightVersion)) {
      if (counters) counters.losHashSkips = (counters.losHashSkips || 0) + 1;
      return false;
    }
    if (counters) counters.losWalks = (counters.losWalks || 0) + 1;
    return solidBlocksLineOfSightCells(this.walls, gx0, gy0, gx1, gy1);
  }

  // ────────────────────────────────────────────────────────────── lifecycle

  addParticle(x, y, genome, energy = 4, clade = null) {
    if (this.particles.length >= this.maxParticles) return null;
    // p.species mirrors genome.species so the hot pair-force loop avoids a
    // second property hop (q.genome.species → q.species). Updated on repro.
    const p = {
      id: ++_id,
      x, y,
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6,
      genome,
      species: genome.species,
      energy,
      age: 0,
      lineage: ++_lineage,
      cladeId: 0,
      organismRootId: 0,
      organismGeneration: 1,
      signalR: 0, signalG: 0, signalB: 0,
      prevSignalR: 0, prevSignalG: 0, prevSignalB: 0,
      signalFlash: 0, signalAboveLast: 0, signalAboveSince: 0,
      predationGain: 0,
      predationEvents: 0,
      predationDrain: 0,
      predationEnergyGain: 0,
      predationFatalDrains: 0,
      predationKills: 0,
      fieldFoodEaten: 0,
      fieldEnergyGain: 0,
      combatAttacks: 0,
      combatKills: 0,
      combatCounters: 0,
      combatEscapes: 0,
      combatFailedCost: 0,
      combatDamageDealt: 0,
      combatDamageTaken: 0,
      lastPredatorId: 0,
      lastPredationTick: -9999,
      lastAttackTick: -9999,
      lastAttackFlashTick: -9999,
      recentDamage: 0,
      damageDirX: 0,
      damageDirY: 0,
      lastDamageTick: -9999,
      soundCh: 0, soundAmp: 0,
      wantBond: 0, wantMate: 0,
      bondMsgR: 0.5, bondMsgG: 0.5, bondMsgB: 0.5,
      incomingBondMsgR: 0, incomingBondMsgG: 0, incomingBondMsgB: 0,
      wallCarry: 0,
      shelterRelief: 0,
      wallDigs: 0,
      wallDeposits: 0,
      lastLongFieldX: 0, lastLongFieldY: 0,
      lastMotorX: 0, lastMotorY: 0,
      lastMotorProgress: 0, lastMotorSlip: 0,
      lastHardContactX: 0, lastHardContactY: 0,
      cluster: null,
      bonds: [],
      dead: false,
    };
    p.organismRootId = p.id;
    this.particles.push(p);
    if (clade) {
      p.cladeId = clade.id;
      clade.totalEverBorn++;
    } else {
      this.clades.registerNewParticle(p, null, this.tick);
    }
    this.totalBorn++;
    this._brainsDirty = true;
    this._gpuStateDirty = true;
    this._gpuOrderVersion++;
    return p;
  }

  // Convenience for presets — create a founding clade and return it.
  beginClade(founderGenome) {
    return this.clades.newClade(founderGenome, null, this.tick);
  }

  // ────────────────────────────── god tools

  exterminateSpecies(speciesId) {
    let killed = 0;
    for (const p of this.particles) {
      if (!p.dead && p.genome.species === speciesId) {
        p.dead = true;
        this.totalDied++;
        killed++;
      }
    }
    this.clades.pushEvent(this.tick, 'extinction',
      `divine smiting · ${killed} ${speciesId}-tagged particles erased`, '#ff5d6c');
    return killed;
  }

  exterminateClade(cladeId) {
    let killed = 0;
    for (const p of this.particles) {
      if (!p.dead && p.cladeId === cladeId) {
        p.dead = true;
        this.totalDied++;
        killed++;
      }
    }
    this.clades.pushEvent(this.tick, 'extinction',
      `clade #${cladeId} divinely smitten · ${killed} erased`, '#ff5d6c');
    return killed;
  }

  // Globally raise mutagen field — every cell gets a dose so all repros mutate harder
  mutagenStorm(strength = 1.5) {
    for (let i = 0; i < this.mutagen.length; i++) {
      if (!this.walls[i]) this.mutagen[i] = Math.min(4, this.mutagen[i] + strength);
    }
    this._mutagenActive = true;
    this.clades.pushEvent(this.tick, 'speciation',
      `mutagen storm · world-wide mutation boost`, '#a78bfa');
  }

  spawnCluster(x, y, species, count = 6, rng = Math.random) {
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = rng() * 14;
      const px = clamp(x + Math.cos(a) * r, 1, W - 1);
      const py = clamp(y + Math.sin(a) * r, 1, H - 1);
      this.addParticle(px, py, makeGenome(species, rng), 4 + rng() * 2);
    }
  }

  reset() {
    this.particles.length = 0;
    this.births.length = 0;
    this.field[0].fill(0);
    this.field[1].fill(0);
    this._decayActive = false;
    this.mutagen.fill(0);
    this._mutagenActive = false;
    this.walls.fill(0);
    this.habitatRegions = [];
    this.wallOwnerId.fill(0);
    this.wallOwnerClusterId.fill(0);
    this.wallOwnerCladeId.fill(0);
    this.wallOwnerTick.fill(0);
    if (this._soundFields) for (const s of this._soundFields) s.fill(0);
    this.tick = 0;
    this.totalBorn = 0;
    this.totalDied = 0;
    this.totalWallDigs = 0;
    this.totalWallDeposits = 0;
    this.totalClusterBuds = 0;
    this.totalClusterBudParticles = 0;
    this.totalClusterCellBirths = 0;
    this.lastClusterBudInfo = null;
    this.totalFieldFoodEaten = 0;
    this.totalFieldEnergyGain = 0;
    this.totalPredationEvents = 0;
    this.totalPredationDrain = 0;
    this.totalPredationEnergyGain = 0;
    this.totalPredationFatalDrains = 0;
    this.totalPredationDeaths = 0;
    this.totalCombatContacts = 0;
    this.totalCombatOneSidedContacts = 0;
    this.totalCombatMutualContacts = 0;
    this.totalCombatAttacks = 0;
    this.totalCombatKills = 0;
    this.totalCombatCounters = 0;
    this.totalCombatEscapes = 0;
    this.totalCombatInjuries = 0;
    this.totalCombatFailedCost = 0;
    this._wallCount = 0;
    // Bump version so the renderer's wall cache key changes — without this,
    // the previous preset's walls keep displaying until the user paints
    // something new (the underlying data is empty, but the cached cell
    // list never gets invalidated).
    this._wallsVersion++;
    this._wallSoundEvents.length = 0;
    this._deathSoundEvents.length = 0;
    this._attackFlashEvents.length = 0;
    this._brainsDirty = true;
    this._gpuStateDirty = true;
    // Phase 4g — drop any in-flight GPU readback so the next tick doesn't
    // apply results computed against the previous (now-replaced) world.
    this._gpuPendings.length = 0;
    this._gpuOrderVersion++;
    this.clades = new CladeTracker();
    // Clusters are recomputed on a 12-tick cadence; if we don't clear here,
    // stale cluster flags + chase locks survive the preset switch until the
    // next recompute fires (which won't happen in an empty world).
    this._clusters = [];
    this._clustersTick = -10000;
    this._particleToCluster.clear();
    this._clusterNames.clear();
    this._clusterBudLastTick.clear();
    this._clusterBudReadiness.clear();
    this._clusterMotion.clear();
    this._clusterBus.clear();
    this.clusterBudDiagnostics = newClusterBudDiagnostics();
  }

  clearField() {
    this.field[0].fill(0);
    this.field[1].fill(0);
    this._decayActive = false;
    this.mutagen.fill(0);
    this._mutagenActive = false;
    if (this._soundFields) for (const s of this._soundFields) s.fill(0);
    if (this._wallSoundEvents) this._wallSoundEvents.length = 0;
    if (this._deathSoundEvents) this._deathSoundEvents.length = 0;
    if (this._attackFlashEvents) this._attackFlashEvents.length = 0;
  }

  // ────────────────────────────────────────────────────────────── brushes

  _predationPull(attacker, victim) {
    const g = attacker.genome;
    return victim.species === attacker.species ? g.cohesion : g.attraction[victim.species];
  }

  _predationMultiplier(attacker, victim) {
    const pCl = attacker.cluster;
    const qCl = victim.cluster;
    const kinShared = pCl && pCl === qCl;
    const kinMult = kinShared
      ? Math.max(0, Math.min(1.5, 1 - (attacker.genome.kin_aversion || 0.5)))
      : 1;
    const pref = attacker.genome.prey_preference;
    const speciesMult = pref
      ? Math.max(0, 1 + pref[victim.species])
      : 1;
    return kinMult * speciesMult;
  }

  _canPredate(attacker, victim) {
    if (!attacker || !victim || attacker.dead || victim.dead) return false;
    if ((victim.energy || 0) <= 0.05) return false;
    if (this._predationPull(attacker, victim) <= 0.45) return false;
    return this._predationMultiplier(attacker, victim) > 0.001;
  }

  _eventAttackIntent(attacker, victim) {
    if (!this._canPredate(attacker, victim)) return null;
    const driveRaw = Math.max(0, attacker.predationGain || 0);
    if (driveRaw <= COMBAT_ATTACK_GATE) return null;
    if (this.tick - (attacker.lastAttackTick || -9999) < COMBAT_ATTACK_COOLDOWN) return null;
    if ((attacker.energy || 0) <= COMBAT_ATTACK_COST + 0.05) return null;
    const drive = (driveRaw - COMBAT_ATTACK_GATE) / (1 - COMBAT_ATTACK_GATE);
    const huntCoord = attacker.cluster ? Math.max(0, attacker.incomingBondMsgR || 0) : 0;
    const energyTerm = 0.65 + Math.min(1.35, (attacker.energy || 0) / 7);
    return {
      power: drive * this._predationMultiplier(attacker, victim) * energyTerm *
        (1 + huntCoord * COORD_HUNT_BONUS),
      cost: COMBAT_ATTACK_COST,
    };
  }

  _guardPower(defender) {
    const guardDrive = Math.max(0, -(defender.predationGain || 0));
    if (guardDrive <= 0) return 0;
    const energyTerm = 0.75 + Math.min(1.25, (defender.energy || 0) / 8);
    const bondTerm = 1 + Math.min(0.4, (defender.bonds ? defender.bonds.length : 0) * 0.08);
    const topology = defender.cluster ? (defender.cluster.topology || 0) : 0;
    const topologyTerm = 1 + topology * COORD_GUARD_BONUS;
    const alarmTerm = defender.cluster && defender.cluster.alarm
      ? 1 + COORD_ALARM_GUARD_BONUS + topology * 0.12
      : 1;
    return guardDrive * energyTerm * bondTerm * topologyTerm * alarmTerm;
  }

  _recordDamage(target, amount, source) {
    if (!target || target.dead || amount <= 0) return;
    const sx = source ? source.x - target.x : 0;
    const sy = source ? source.y - target.y : 0;
    const len = Math.hypot(sx, sy) || 1;
    target.recentDamage = Math.min(4, (target.recentDamage || 0) * 0.35 + amount);
    target.damageDirX = sx / len;
    target.damageDirY = sy / len;
    target.lastDamageTick = this.tick;
  }

  _applyCombatDamage(target, amount, source, idMap) {
    if (!target || target.dead || amount <= 0) return 0;
    const damage = Math.min(target.energy || 0, amount);
    target.energy -= damage;
    this._recordDamage(target, damage, source);
    if (damage > 0) {
      this.totalCombatInjuries++;
      target.combatDamageTaken = (target.combatDamageTaken || 0) + damage;
      if (source && !source.dead) source.combatDamageDealt = (source.combatDamageDealt || 0) + damage;
    }
    if (target.energy <= 0) this._killParticle(target, idMap);
    return damage;
  }

  _killParticle(p, idMap = this._idLookup) {
    if (!p || p.dead) return false;
    const gx = clamp((p.x / CELL) | 0, 0, GW - 1);
    const gy = clamp((p.y / CELL) | 0, 0, GH - 1);
    const fIdx = gy * GW + gx;
    p.shelterRelief = 0;
    if ((p.wallCarry || 0) > 0 && this.walls[fIdx] === WALL_OPEN) {
      this.walls[fIdx] = WALL_SOLID;
      this._wallCount++;
      this._wallsVersion++;
      this.wallOwnerId[fIdx] = p.id;
      this.wallOwnerClusterId[fIdx] = p.cluster ? (p.cluster.anchorId || p.cluster.root || 0) : 0;
      this.wallOwnerCladeId[fIdx] = p.cladeId || 0;
      this.wallOwnerTick[fIdx] = this.tick;
      p.wallCarry--;
      this.totalWallDeposits++;
      p.wallDeposits = (p.wallDeposits || 0) + 1;
      this._wallSoundEvents.push({ kind: 'plop', x: p.x, y: p.y, id: p.id });
    }
    p.energy = 0;
    p.dead = true;
    if (idMap) idMap[p.id] = null;
    this.field[1][fIdx] = Math.min(DECAY_CAP, this.field[1][fIdx] + DEATH_DEPOSIT);
    this._decayActive = true;
    this.totalDied++;
    if (p.lastPredatorId && this.tick - (p.lastPredationTick || -9999) <= 12) {
      this.totalPredationDeaths++;
      const predator = idMap ? idMap[p.lastPredatorId] : null;
      if (predator && !predator.dead) {
        predator.predationKills = (predator.predationKills || 0) + 1;
      }
    }
    this._deathSoundEvents.push({ x: p.x, y: p.y, id: p.id, energy: p.energy, tick: this.tick });
    this.clades.onParticleDie(p, this.tick);
    if (p.bonds.length > 0) {
      const drainPerPartner = BOND_DEATH_DRAIN / p.bonds.length;
      for (const partnerId of p.bonds) {
        const partner = idMap ? idMap[partnerId] : null;
        if (partner && !partner.dead) {
          partner.energy -= drainPerPartner;
          if (partner.energy < 0) partner.energy = 0;
        }
      }
    }
    return true;
  }

  _combatConsume(killer, victim, conversion, idMap) {
    const drained = Math.max(0, victim.energy || 0);
    const gain = drained * conversion;
    victim.lastPredatorId = killer.id;
    victim.lastPredationTick = this.tick;
    this._recordDamage(victim, drained, killer);
    if (drained > 0) {
      victim.combatDamageTaken = (victim.combatDamageTaken || 0) + drained;
      killer.combatDamageDealt = (killer.combatDamageDealt || 0) + drained;
    }
    killer.energy += gain;
    this.totalPredationEvents++;
    this.totalPredationDrain += drained;
    this.totalPredationEnergyGain += gain;
    this.totalPredationFatalDrains++;
    killer.predationEvents = (killer.predationEvents || 0) + 1;
    killer.predationDrain = (killer.predationDrain || 0) + drained;
    killer.predationEnergyGain = (killer.predationEnergyGain || 0) + gain;
    killer.predationFatalDrains = (killer.predationFatalDrains || 0) + 1;
    this._killParticle(victim, idMap);
    return gain;
  }

  _queueAttackFlash(attacker, defender, intensity = 1) {
    if (!this._attackFlashEvents) this._attackFlashEvents = [];
    const ax = attacker ? attacker.x : 0;
    const ay = attacker ? attacker.y : 0;
    const bx = defender ? defender.x : ax;
    const by = defender ? defender.y : ay;
    const power = clamp(Number.isFinite(intensity) ? intensity : 1, 0.4, 2.5);
    this._attackFlashEvents.push({
      x: (ax + bx) * 0.5,
      y: (ay + by) * 0.5,
      tick: this.tick,
      intensity: power,
    });
    if (this._attackFlashEvents.length > 180) {
      this._attackFlashEvents.splice(0, this._attackFlashEvents.length - 180);
    }
    if (attacker) attacker.lastAttackFlashTick = this.tick;
    if (defender) defender.lastAttackFlashTick = this.tick;
  }

  _resolveSingleEventAttack(attacker, defender, intent, idMap) {
    if (!intent || attacker.dead || defender.dead) return;
    attacker.energy -= intent.cost;
    attacker.lastAttackTick = this.tick;
    this.totalCombatAttacks++;
    attacker.combatAttacks = (attacker.combatAttacks || 0) + 1;
    this._queueAttackFlash(attacker, defender, intent.power);
    const guard = this._guardPower(defender);
    if (guard >= intent.power * 1.15) {
      this.totalCombatCounters++;
      this.totalCombatFailedCost += intent.cost;
      defender.combatCounters = (defender.combatCounters || 0) + 1;
      defender.combatKills = (defender.combatKills || 0) + 1;
      attacker.combatFailedCost = (attacker.combatFailedCost || 0) + intent.cost;
      this._combatConsume(defender, attacker, COMBAT_COUNTER_CONVERSION, idMap);
      return;
    }
    if (intent.power >= guard * 1.1 + COMBAT_ESCAPE_MARGIN) {
      this.totalCombatKills++;
      attacker.combatKills = (attacker.combatKills || 0) + 1;
      this._combatConsume(attacker, defender, COMBAT_KILL_CONVERSION, idMap);
      return;
    }
    this.totalCombatEscapes++;
    this.totalCombatFailedCost += intent.cost;
    defender.combatEscapes = (defender.combatEscapes || 0) + 1;
    attacker.combatFailedCost = (attacker.combatFailedCost || 0) + intent.cost;
    const defenderDamage = COMBAT_ESCAPE_INJURY * (0.7 + Math.min(1.5, intent.power));
    const attackerDamage = COMBAT_ESCAPE_ATTACKER_INJURY * (0.7 + Math.min(1.5, guard));
    this._applyCombatDamage(defender, defenderDamage, attacker, idMap);
    this._applyCombatDamage(attacker, attackerDamage, defender, idMap);
  }

  _resolveMutualEventAttack(a, b, aIntent, bIntent, idMap) {
    a.energy -= aIntent.cost;
    b.energy -= bIntent.cost;
    a.lastAttackTick = this.tick;
    b.lastAttackTick = this.tick;
    this.totalCombatAttacks += 2;
    a.combatAttacks = (a.combatAttacks || 0) + 1;
    b.combatAttacks = (b.combatAttacks || 0) + 1;
    this._queueAttackFlash(a, b, Math.max(aIntent.power, bIntent.power) * 1.15);
    if (aIntent.power > bIntent.power + COMBAT_ESCAPE_MARGIN) {
      this.totalCombatKills++;
      this.totalCombatFailedCost += bIntent.cost;
      a.combatKills = (a.combatKills || 0) + 1;
      b.combatFailedCost = (b.combatFailedCost || 0) + bIntent.cost;
      this._combatConsume(a, b, COMBAT_KILL_CONVERSION, idMap);
      return;
    }
    if (bIntent.power > aIntent.power + COMBAT_ESCAPE_MARGIN) {
      this.totalCombatKills++;
      this.totalCombatFailedCost += aIntent.cost;
      b.combatKills = (b.combatKills || 0) + 1;
      a.combatFailedCost = (a.combatFailedCost || 0) + aIntent.cost;
      this._combatConsume(b, a, COMBAT_KILL_CONVERSION, idMap);
      return;
    }
    this.totalCombatEscapes++;
    this.totalCombatFailedCost += aIntent.cost + bIntent.cost;
    a.combatEscapes = (a.combatEscapes || 0) + 1;
    b.combatEscapes = (b.combatEscapes || 0) + 1;
    a.combatFailedCost = (a.combatFailedCost || 0) + aIntent.cost;
    b.combatFailedCost = (b.combatFailedCost || 0) + bIntent.cost;
    this._applyCombatDamage(a, COMBAT_ESCAPE_ATTACKER_INJURY * (0.8 + bIntent.power), b, idMap);
    this._applyCombatDamage(b, COMBAT_ESCAPE_ATTACKER_INJURY * (0.8 + aIntent.power), a, idMap);
  }

  _resolveEventCombat(a, b, idMap) {
    if (!a || !b || a.dead || b.dead) return;
    const aIntent = this._eventAttackIntent(a, b);
    const bIntent = this._eventAttackIntent(b, a);
    if (!aIntent && !bIntent) return;
    this.totalCombatContacts++;
    if (aIntent && bIntent) {
      this.totalCombatMutualContacts++;
      this._resolveMutualEventAttack(a, b, aIntent, bIntent, idMap);
    } else {
      this.totalCombatOneSidedContacts++;
      if (aIntent) this._resolveSingleEventAttack(a, b, aIntent, idMap);
      else this._resolveSingleEventAttack(b, a, bIntent, idMap);
    }
  }

  _recordNibbleContact(a, b) {
    const aIntent = this._canPredate(a, b);
    const bIntent = this._canPredate(b, a);
    if (!aIntent && !bIntent) return;
    this.totalCombatContacts++;
    if (aIntent && bIntent) this.totalCombatMutualContacts++;
    else this.totalCombatOneSidedContacts++;
  }

  brushApply(kind, x, y, radius, strength, spawnSpecies = 0) {
    const r = Math.max(1, radius);
    const r2 = r * r;
    const gx0 = Math.max(0, Math.floor((x - r) / CELL));
    const gx1 = Math.min(GW - 1, Math.floor((x + r) / CELL));
    const gy0 = Math.max(0, Math.floor((y - r) / CELL));
    const gy1 = Math.min(GH - 1, Math.floor((y + r) / CELL));

    for (let gy = gy0; gy <= gy1; gy++) {
      const cy = gy * CELL + CELL * 0.5;
      for (let gx = gx0; gx <= gx1; gx++) {
        const cx = gx * CELL + CELL * 0.5;
        const dx = cx - x, dy = cy - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const fall = 1 - d2 / r2;
        const idx = gy * GW + gx;
        switch (kind) {
          case 'food':
            this.field[0][idx] = clamp(this.field[0][idx] + strength * 0.6 * fall, 0, FOOD_CAP);
            break;
          case 'wall':
            if (!this.walls[idx]) this._wallCount++;
            this.walls[idx] = WALL_SOLID;
            this._wallsVersion++;
            this.field[0][idx] = 0;
            this.field[1][idx] = 0;
            this.clearWallMeta(idx);
            break;
          case 'membrane':
            if (!this.walls[idx]) this._wallCount++;
            this.walls[idx] = WALL_MEMBRANE;
            this._wallsVersion++;
            this.clearWallMeta(idx);
            // Glass doesn't zero fields — chemicals and sound pass through.
            break;
          case 'porous':
            if (!this.walls[idx]) this._wallCount++;
            this.walls[idx] = WALL_POROUS;
            this._wallsVersion++;
            // Mud is terrain, not a chemical screen.
            this.clearWallMeta(idx);
            break;
          case 'mutagen':
            this.mutagen[idx] = clamp(this.mutagen[idx] + strength * 0.6 * fall, 0, MUTAGEN_CAP);
            if (this.mutagen[idx] > 1e-5) this._mutagenActive = true;
            break;
          case 'erase':
            if (this.walls[idx]) {
              this.walls[idx] = 0;
              this._wallCount = Math.max(0, this._wallCount - 1);
              this._wallsVersion++;
              this.clearWallMeta(idx);
            }
            this.field[0][idx] = 0;
            this.field[1][idx] = 0;
            this.mutagen[idx] = 0;
            break;
        }
      }
    }

    if (kind === 'spawn') {
      const n = Math.max(2, Math.floor(r / 4));
      this.spawnCluster(x, y, spawnSpecies, n);
    }

    if (kind === 'erase') {
      // also kill particles inside the brush
      for (const p of this.particles) {
        const dx = p.x - x, dy = p.y - y;
        if (dx * dx + dy * dy <= r2) p.dead = true;
      }
    }
  }

  // ────────────────────────────────────────────────────────────── tick

  async step() {
    this.tick++;
    const ps = this.particles;
    const N = ps.length;
    const f0 = this.field[0], f1 = this.field[1];
    const walls = this.walls, mut = this.mutagen;
    const hasWalls = this._wallCount > 0;
    const hasSolidSightBlockers = hasWalls && this._solidWalls().length > 0;
    const cellBirthLimit = this._cellBirthLimit();
    const profiling = this._profileEnabled;
    let profileT = profiling ? performance.now() : 0;
    const markProfile = profiling
      ? (name) => {
          const now = performance.now();
          this._profileAdd(name, now - profileT);
          profileT = now;
        }
      : null;

    const solidSightVersion = this._wallsVersion;
    if (hasSolidSightBlockers) this._solidHashReady(solidSightVersion);
    if (profiling) markProfile('sightHash');

    // id → particle map for bond / mate lookups
    const idMap = this._idLookup;
    const touchedIds = this._idLookupTouched;
    for (let i = 0; i < touchedIds.length; i++) idMap[touchedIds[i]] = null;
    touchedIds.length = 0;
    for (let i = 0; i < N; i++) {
      const p = ps[i];
      if (!p.dead) {
        idMap[p.id] = p;
        touchedIds.push(p.id);
      }
    }

    // Phase 5a → 6b — propagate bond-network messages along bond edges.
    // Now 3-channel (R/G/B) so brains can encode distinct meanings per
    // channel rather than collapsing everything into one scalar. Uses each
    // partner's bondMsgR/G/B from the previous tick → signals travel one
    // bond hop per tick (slow), but Phase 6c adds a fast cluster-wide alarm
    // broadcast for high-urgency events.
    for (let i = 0; i < N; i++) {
      const p = ps[i];
      if (p.dead || p.bonds.length === 0) {
        if (!p.dead) {
          p.incomingBondMsgR = p.incomingBondMsgG = p.incomingBondMsgB = 0;
        }
        continue;
      }
      let sR = 0, sG = 0, sB = 0, n = 0;
      for (const partnerId of p.bonds) {
        const partner = idMap[partnerId];
        if (partner && !partner.dead) {
          sR += partner.bondMsgR;
          sG += partner.bondMsgG;
          sB += partner.bondMsgB;
          n++;
        }
      }
      if (n > 0) {
        const inv = 1 / n;
        const degreeGain = 1 + Math.min(0.35, Math.max(0, n - 1) * BONDMSG_DEGREE_GAIN);
        const topologyGain = p.cluster ? 1 + (p.cluster.topology || 0) * BONDMSG_TOPOLOGY_GAIN : 1;
        const msgGain = degreeGain * topologyGain;
        p.incomingBondMsgR = Math.tanh(((sR * inv) * 2 - 1) * msgGain);
        p.incomingBondMsgG = Math.tanh(((sG * inv) * 2 - 1) * msgGain);
        p.incomingBondMsgB = Math.tanh(((sB * inv) * 2 - 1) * msgGain);
      } else {
        p.incomingBondMsgR = p.incomingBondMsgG = p.incomingBondMsgB = 0;
      }
    }
    this._updateClusterMessageBus();
    this._updateClusterMotorConsensus();
    this._updateClusterFieldConsensus();

    // Phase 6c — fast cluster alarm. After bondMsg propagation, scan each
    // named cluster for any member whose previous-tick bondMsg (any channel)
    // exceeded 0.85; if so, set cluster.alarm = 1 (fresh broadcast). Else
    // decay 0.5×/tick. This bypasses the 1-hop/tick chain so urgent signals
    // reach all colony members on the next sensor read.
    if (this._clusters && this._clusters.length > 0) {
      for (const c of this._clusters) {
        let alarmTrigger = 0;
        const ms = c.members;
        if (ms) {
          for (const m of ms) {
            if (m.dead) continue;
            const top = Math.max(m.bondMsgR, m.bondMsgG, m.bondMsgB);
            if (top > 0.85) { alarmTrigger = 1; break; }
            if ((m.recentDamage || 0) > 0 && this.tick - (m.lastDamageTick || -9999) < 20) {
              alarmTrigger = 1;
              break;
            }
          }
        }
        c.alarm = alarmTrigger ? 1 : (c.alarm || 0) * 0.5;
      }
    }

    // ── GPU pair-force + brain forward (pipelined) ───────────────────
    // Phase 4f/4g: GPU compute is pipelined one tick ahead of CPU work.
    // Multiple readback slots let a fresh dispatch launch even when an older
    // mapAsync is still finishing. Only age-1, same-order results are consumed.
    //
    // Net effect: GPU forces & brain outputs are 1 tick stale, which is
    // tolerable because (a) CTRNNs already have internal lag from the
    // recurrent state machine, (b) typical particle motion is <1 px/tick
    // so positions are virtually identical between adjacent ticks. CPU-
    // only mode is unchanged.
    if (profiling) markProfile('setup');
    let useGpuPairs = false;
    let useGpuBrain = false;
    this._gpuResults = null;
    if (this._gpuCooldownTicks > 0) this._gpuCooldownTicks--;
    const gpuComputeActive = this._gpuEnabled && this._gpuCooldownTicks <= 0;
    if (this._gpuPendings.length > 0) {
      let best = null;
      let writePending = 0;
      for (let pi = 0; pi < this._gpuPendings.length; pi++) {
        const pending = this._gpuPendings[pi];
        if (!pending.done) {
          this._gpuPendings[writePending++] = pending;
          continue;
        }
        if (pending.error) {
          console.warn('[gpu] pipelined readback failed; falling back to CPU', pending.error);
          this._gpuEnabled = false;
          continue;
        }
        const age = this.tick - pending.tick;
        if (age <= 1 &&
            pending.orderVersion === this._gpuOrderVersion &&
            (!best || pending.tick > best.tick)) {
          best = pending;
        }
      }
      this._gpuPendings.length = writePending;
      if (best && this._gpuEnabled && N > 0) {
        this._gpuResults = best.value;
        this._gpuResultStride = best.stride || RESULT_STRIDE;
        this._gpuResultPairOnly = !!best.pairOnly;
        this._gpuLastResultAge = this.tick - best.tick;
        this._gpuTicksUsed++;
        useGpuBrain = !this._gpuResultPairOnly;
        if (gpuComputeActive) this._gpuWindowUsed++;
        useGpuPairs = true;
      }
      if (!this._gpuEnabled) {
        this._gpuEnabled = false;
        this._gpuPendings.length = 0;
        this._gpuResultStride = RESULT_STRIDE;
        this._gpuResultPairOnly = false;
      }
    }
    if (gpuComputeActive && N > 0 && !useGpuPairs) {
      this._gpuTicksFallback++;
      this._gpuWindowFallback++;
      if (!this._gpuPairOnly) this._gpuStateDirty = true;
    }

    // ── 1. Build spatial hash ────────────────────────────────────────
    if (profiling) markProfile('gpuAwait');
    this.cellHead.fill(-1);
    for (let i = 0; i < N; i++) {
      const p = ps[i];
      if (p.dead) continue;
      const cx = (p.x / HASH_CELL) | 0;
      const cy = (p.y / HASH_CELL) | 0;
      const c = cy * HW + cx;
      this.cellNext[i] = this.cellHead[c];
      this.cellHead[c] = i;
    }

    // ── 2. Pair forces + field gradient + integration ────────────────
    if (profiling) markProfile('hash');
    const checkBondBarrier = this.bondBarrier && this._clusters && this._clusters.length > 0;
    for (let i = 0; i < N; i++) {
      const p = ps[i];
      if (p.dead) continue;
      const g = p.genome;
      // Hoisted hot fields — saves one property hop per neighbor check
      const gSpecies = p.species;
      const gCohesion = g.cohesion;
      const gAttraction = g.attraction;
      const gSense = g.sense;
      const R = g.sense_radius;
      const R2 = R * R;
      // When GPU results are available, broad pair forces, neighbor counts,
      // signal sums, and quadrant stats have already been computed. The CPU
      // still needs only contact-range biology (predation/bond formation) plus
      // the separate bond-barrier check below, so avoid repeating expensive
      // sqrt/solid-line tests across the full sensory radius.
      const cpuNeighborR = useGpuPairs ? R_CLOSE : R;
      const cpuNeighborR2 = cpuNeighborR * cpuNeighborR;
      let ax = 0, ay = 0;
      // Bond barrier accumulator — kept separate from ax/ay so the GPU
      // pair-force overwrite below doesn't clobber it. Added to ax/ay after
      // the GPU result is injected, so barrier still works when GPU is on.
      let bax = 0, bay = 0;

      // Pair forces from neighbours in radius-sized hash-cell windows.
      const cx = (p.x / HASH_CELL) | 0;
      const cy = (p.y / HASH_CELL) | 0;
      const cellRange = Math.max(1, Math.ceil(Math.max(cpuNeighborR, BOND_BARRIER_R) / HASH_CELL));
      const cx0 = Math.max(0, cx - cellRange), cx1 = Math.min(HW - 1, cx + cellRange);
      const cy0 = Math.max(0, cy - cellRange), cy1 = Math.min(HH - 1, cy + cellRange);
      let crowd = 0;
      // Neighbor stats for brain sensors. When GPU pair pass ran, seed these
      // from the GPU result so the CPU inner loop can skip accumulation.
      let ownN = 0, alienN = 0;
      let nbVx = 0, nbVy = 0;
      let sigR = 0, sigG = 0, sigB = 0, sigN = 0;
      // Phase 5b — per-quadrant directional stats (NE, SE, SW, NW)
      let qcnt0 = 0, qcnt1 = 0, qcnt2 = 0, qcnt3 = 0;
      let qsig0 = 0, qsig1 = 0, qsig2 = 0, qsig3 = 0;
      let qsigN0 = 0, qsigN1 = 0, qsigN2 = 0, qsigN3 = 0;
      if (p.dead) continue;

      if (useGpuPairs) {
        const ro = i * this._gpuResultStride;
        const r = this._gpuResults;
        ownN  = r[ro + RES_OWNN];
        alienN = r[ro + RES_ALIENN];
        nbVx  = r[ro + RES_NBVX];
        nbVy  = r[ro + RES_NBVY];
        sigR  = r[ro + RES_SIGR];
        sigG  = r[ro + RES_SIGG];
        sigB  = r[ro + RES_SIGB];
        sigN  = r[ro + RES_SIGN];
        crowd = r[ro + RES_CROWD];
        if (!useGpuBrain) {
          qcnt0 = r[ro + RES_QCNT0];
          qcnt1 = r[ro + RES_QCNT1];
          qcnt2 = r[ro + RES_QCNT2];
          qcnt3 = r[ro + RES_QCNT3];
          qsig0 = r[ro + RES_QSIG0];
          qsig1 = r[ro + RES_QSIG1];
          qsig2 = r[ro + RES_QSIG2];
          qsig3 = r[ro + RES_QSIG3];
          qsigN0 = qcnt0 > 0 ? 1 : 0;
          qsigN1 = qcnt1 > 0 ? 1 : 0;
          qsigN2 = qcnt2 > 0 ? 1 : 0;
          qsigN3 = qcnt3 > 0 ? 1 : 0;
        }
      }

      for (let yy = cy0; yy <= cy1; yy++) {
        for (let xx = cx0; xx <= cx1; xx++) {
          let j = this.cellHead[yy * HW + xx];
          while (j !== -1) {
            if (j !== i) {
              const q = ps[j];
              if (!q.dead) {
                const dx = q.x - p.x;
                const dy = q.y - p.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < cpuNeighborR2 && d2 > 1e-6 &&
                    !(hasSolidSightBlockers && this.solidBlocksLineOfSightFast(p.x, p.y, q.x, q.y, solidSightVersion))) {
                  const d = Math.sqrt(d2);
                  if (!useGpuPairs) {
                    // Stats accumulation — skipped when GPU already produced them
                    if (d < CROWD_RADIUS) crowd++;
                    if (q.species === gSpecies) ownN++;
                    else alienN++;
                    nbVx += q.vx;
                    nbVy += q.vy;
                    const sigMag = (q.signalR + q.signalG + q.signalB) / 3;
                    const att = 1 - d / R;
                    if (q.signalR > 0.01 || q.signalG > 0.01 || q.signalB > 0.01) {
                      sigR += q.signalR * att;
                      sigG += q.signalG * att;
                      sigB += q.signalB * att;
                      sigN++;
                    }
                    // Phase 5b — bin neighbor into quadrant by relative position
                    const quad = dx >= 0 ? (dy < 0 ? 0 : 1) : (dy >= 0 ? 2 : 3);
                    if (quad === 0)      { qcnt0++; qsig0 += sigMag * att; qsigN0++; }
                    else if (quad === 1) { qcnt1++; qsig1 += sigMag * att; qsigN1++; }
                    else if (quad === 2) { qcnt2++; qsig2 += sigMag * att; qsigN2++; }
                    else                 { qcnt3++; qsig3 += sigMag * att; qsigN3++; }
                  }

                  if (d < R_CLOSE) {
                    // strong short-range repulsion — skipped when GPU computes pair forces
                    if (!useGpuPairs) {
                      const f = -K_REP * (1 - d / R_CLOSE);
                      const inv = 1 / d;
                      ax += dx * inv * f;
                      ay += dy * inv * f;
                    }
                    if (this.combatMode === 'event') {
                      if (i < j) this._resolveEventCombat(p, q, idMap);
                    } else {
                      if (i < j) this._recordNibbleContact(p, q);
                    // Predation: positive attraction + contact = energy drain.
                    // The brain's OUT_PREDATION further amplifies if active,
                    // so evolved hunters get an edge.
                    const qsp_close = q.species;
                    const pull = (qsp_close === gSpecies) ? gCohesion : gAttraction[qsp_close];
                    const willBoost = 1 + Math.max(0, p.predationGain) * 0.8;
                    if (pull > 0.45 && q.energy > 0.05) {
                      // Kin-aversion gate: if attacker and victim are in the
                      // same named cluster, scale drain by (1 - kin_aversion)
                      // so loyal-trait colonies don't auto-cannibalize. Range
                      // [-0.5, 1.5] supports cannibal (0%-aversion → bonus
                      // drain) through strict-loyal (full block).
                      const pCl = p.cluster;
                      const qCl = q.cluster;
                      const kinShared = pCl && pCl === qCl;
                      const kinMult = kinShared
                        ? Math.max(0, Math.min(1.5, 1 - (p.genome.kin_aversion || 0.5)))
                        : 1;
                      // Phase 7 — per-victim-species preference. Multiplies
                      // drain rate by (1 + pref[victim_species]), clamped
                      // non-negative. Negative preference effectively spares
                      // that species; positive can up to ~double the drain.
                      const pref = p.genome.prey_preference;
                      const speciesMult = pref
                        ? Math.max(0, 1 + pref[qsp_close])
                        : 1;
                      const totalMult = kinMult * speciesMult;
                      if (totalMult > 0.001) {
                        const huntCoord = p.cluster
                          ? Math.max(0, p.incomingBondMsgR)
                          : 0;
                        const baseRate = PREDATION_BASE_RATE * willBoost * totalMult *
                          (1 + huntCoord * COORD_HUNT_BONUS);
                        const drain = Math.min(q.energy, q.energy * baseRate, 0.7);
                        const gain = drain * PREDATION_CONVERSION;
                        q.energy -= drain;
                        // Predation is deliberately a richer but riskier meal
                        // than field food: close contact, target preference,
                        // and coordination are required, but successful meat
                        // transfers most of the victim's lost energy.
                        p.energy += gain;
                        this.totalPredationEvents++;
                        this.totalPredationDrain += drain;
                        this.totalPredationEnergyGain += gain;
                        p.predationEvents = (p.predationEvents || 0) + 1;
                        p.predationDrain = (p.predationDrain || 0) + drain;
                        p.predationEnergyGain = (p.predationEnergyGain || 0) + gain;
                        q.lastPredatorId = p.id;
                        q.lastPredationTick = this.tick;
                        if (q.energy <= 0) {
                          this.totalPredationFatalDrains++;
                          p.predationFatalDrains = (p.predationFatalDrains || 0) + 1;
                        }
                      }
                    }
                    }
                    // Bond formation: only checked when i.id < j.id to avoid
                    // double work. Both must want bond; both must have a free
                    // slot; not already bonded; close enough. Cluster affinity
                    // shifts each side's effective gate when both are already
                    // in the same named cluster — positive affinity makes
                    // colony loyalty (extra bonds within own group) easier.
                    if (!p.dead && !q.dead && i < j &&
                        d < BOND_FORM_DIST &&
                        p.bonds.length < MAX_BONDS && q.bonds.length < MAX_BONDS &&
                        !p.bonds.includes(q.id) && !q.bonds.includes(p.id)) {
                      const pCluster = p.cluster;
                      const qCluster = q.cluster;
                      const sameCluster = pCluster && pCluster === qCluster;
                      let pGate = BOND_GATE, qGate = BOND_GATE;
                      if (sameCluster) {
                        pGate -= (p.genome.cluster_affinity || 0) * 0.15;
                        qGate -= (q.genome.cluster_affinity || 0) * 0.15;
                      }
                      if (p.wantBond > pGate && q.wantBond > qGate) {
                        p.bonds.push(q.id);
                        q.bonds.push(p.id);
                      }
                    }
                  } else if (!useGpuPairs) {
                    // tent-shaped attraction band — asymmetric: uses i's row
                    const qsp = q.species;
                    const a = (qsp === gSpecies) ? gCohesion : gAttraction[qsp];
                    if (a !== 0) {
                      const t = (d - R_CLOSE) / (R - R_CLOSE);
                      const tent = 1 - Math.abs(2 * t - 1);
                      if (tent > 0) {
                        const f = K_ATTR * a * tent;
                        const inv = 1 / d;
                        ax += dx * inv * f;
                        ay += dy * inv * f;
                      }
                    }
                  }
                }
                // Bond barrier — fires regardless of sense_radius. Outsiders
                // get pushed perpendicular to bond segments of named clusters.
                // q is already constrained to p's 3×3 hash cells, so distance
                // is naturally bounded; the segment math takes care of reach.
                if (checkBondBarrier &&
                    q.bonds.length > 0 &&
                    q.cluster) {
                  const pBondedQ = p.bonds.length > 0 && p.bonds.includes(q.id);
                  if (!pBondedQ) {
                    const qBonds = q.bonds;
                    for (let bi = 0; bi < qBonds.length; bi++) {
                      const pid = qBonds[bi];
                      if (pid <= q.id) continue;          // each segment once
                      if (pid === p.id) continue;
                      if (p.bonds.length > 0 && p.bonds.includes(pid)) continue;
                      const partner = idMap[pid];
                      if (!partner || partner.dead) continue;
                      const sx = partner.x - q.x;
                      const sy = partner.y - q.y;
                      const lenSq = sx * sx + sy * sy;
                      if (lenSq < 1) continue;
                      const tProj = ((p.x - q.x) * sx + (p.y - q.y) * sy) / lenSq;
                      const tt = tProj < 0 ? 0 : (tProj > 1 ? 1 : tProj);
                      const bcx = q.x + sx * tt;
                      const bcy = q.y + sy * tt;
                      const bx = p.x - bcx;
                      const by = p.y - bcy;
                      const bd2 = bx * bx + by * by;
                      if (bd2 < BOND_BARRIER_R2 && bd2 > 1e-6) {
                        const bd = Math.sqrt(bd2);
                        const fb = K_BOND_BARRIER * (1 - bd / BOND_BARRIER_R);
                        const inv = 1 / bd;
                        bax += bx * inv * fb;
                        bay += by * inv * fb;
                      }
                    }
                  }
                }
              }
            }
            j = this.cellNext[j];
          }
        }
      }

      // ── If GPU computed pair forces, inject them now (replaces what the
      //    inner loop would have summed). Field gradient + brain + bond are
      //    still added on top.
      if (useGpuPairs) {
        const oi = i * this._gpuResultStride;
        ax = this._gpuResults[oi + RES_FX];
        ay = this._gpuResults[oi + RES_FY];
      }
      // Bond barrier is a CPU-only force regardless of GPU mode — its
      // accumulator survives the GPU overwrite by being added here.
      ax += bax;
      ay += bay;

      // Field gradient sensing — central differences on grid (clamped sample)
      const sgx = clamp((p.x / CELL) | 0, 1, GW - 2);
      const sgy = clamp((p.y / CELL) | 0, 1, GH - 2);
      const sIdx = sgy * GW + sgx;
      const dfx0 = (f0[sIdx + 1] - f0[sIdx - 1]) * 0.5;
      const dfy0 = (f0[sIdx + GW] - f0[sIdx - GW]) * 0.5;
      const dfx1 = (f1[sIdx + 1] - f1[sIdx - 1]) * 0.5;
      const dfy1 = (f1[sIdx + GW] - f1[sIdx - GW]) * 0.5;
      ax += K_FIELD * (gSense[0] * dfx0 + gSense[1] * dfx1);
      ay += K_FIELD * (gSense[0] * dfy0 + gSense[1] * dfy1);
      const longChemRadius = Math.round(R / CELL);
      const longChem = this._longChemScratch;
      sampleLongChemInto(f0, sgx, sgy, longChemRadius, longChem, 0, 0.45);
      sampleLongChemInto(f1, sgx, sgy, longChemRadius, longChem, 4, 0.32);
      const longFieldX = gSense[0] * longChem[0] + gSense[1] * longChem[4];
      const longFieldY = gSense[0] * longChem[1] + gSense[1] * longChem[5];
      ax += K_FIELD_LONG * longFieldX;
      ay += K_FIELD_LONG * longFieldY;
      const locomotionCluster = p.cluster;
      if (locomotionCluster && (locomotionCluster.motorConsensus || 0) > 0.15) {
        const topologyGain = 0.45 + (locomotionCluster.topology || 0) * 0.55;
        const sizeGain = Math.tanh((locomotionCluster.count || 0) / 16);
        const traction = CLUSTER_TRACTION * (locomotionCluster.motorConsensus || 0) *
          topologyGain * sizeGain;
        ax += (locomotionCluster.motorX || 0) * traction;
        ay += (locomotionCluster.motorY || 0) * traction;
      }
      if (locomotionCluster && (locomotionCluster.fieldStrength || 0) > 0.04) {
        const topologyGain = 0.45 + (locomotionCluster.topology || 0) * 0.55;
        const sizeGain = Math.tanh((locomotionCluster.count || 0) / 16);
        const steer = CLUSTER_FIELD_STEER * topologyGain * sizeGain *
          clamp((locomotionCluster.fieldStrength || 0) * 2, 0, 1);
        ax += (locomotionCluster.fieldX || 0) * steer;
        ay += (locomotionCluster.fieldY || 0) * steer;
      }
      p.lastLongFieldX = longFieldX;
      p.lastLongFieldY = longFieldY;
      const bodyContactCluster = p.cluster;
      if (bodyContactCluster && (bodyContactCluster.slip || 0) > 0.025) {
        const contactX = bodyContactCluster.contactX || 0;
        const contactY = bodyContactCluster.contactY || 0;
        const contactMag = Math.hypot(contactX, contactY);
        if (contactMag > 0.02) {
          const nxBody = contactX / contactMag;
          const nyBody = contactY / contactMag;
          const txBody = -nyBody;
          const tyBody = nxBody;
          const sharedFieldX = (bodyContactCluster.fieldStrength || 0) > 0.04
            ? (bodyContactCluster.fieldX || 0)
            : longFieldX;
          const sharedFieldY = (bodyContactCluster.fieldStrength || 0) > 0.04
            ? (bodyContactCluster.fieldY || 0)
            : longFieldY;
          const tangentField = sharedFieldX * txBody + sharedFieldY * tyBody;
          const tangentStrength = Math.abs(tangentField);
          let slideSignal = 0;
          if (tangentStrength > 0.04) {
            slideSignal = Math.sign(tangentField) * clamp(tangentStrength * 2, 0, 1);
          } else {
            const normalField = sharedFieldX * nxBody + sharedFieldY * nyBody;
            const blockedGoal = clamp(normalField * 2, 0, 1);
            if (blockedGoal > 0.04) {
              const routeSeed = bodyContactCluster.anchorId || bodyContactCluster.root || 0;
              const routeSign = ((routeSeed + ((this.tick / 240) | 0)) & 1) ? 1 : -1;
              slideSignal = routeSign * blockedGoal * CLUSTER_CONTACT_EXPLORE;
            }
          }
          if (Math.abs(slideSignal) > 0.01) {
            const slipGain = clamp((bodyContactCluster.slip || 0) * 4, 0, 1);
            const topologyGain = 0.5 + (bodyContactCluster.topology || 0) * 0.5;
            const sizeGain = Math.tanh((bodyContactCluster.count || 0) / 14);
            const slide = CLUSTER_CONTACT_SLIDE * slipGain * topologyGain * sizeGain * slideSignal;
            ax += txBody * slide;
            ay += tyBody * slide;
          }
        }
      }

      // ── Brain: build sensor input, run forward pass, apply outputs ──
      const out = this._brainOutput;
      if (useGpuBrain) {
        // GPU already ran the forward pass — copy outputs from the compact
        // result buffer. Hidden CTRNN state stays resident on GPU between
        // dispatches and is reset only when the particle list changes.
        const oo = i * this._gpuResultStride + RES_OUT0;
        for (let oj = 0; oj < N_OUTPUT; oj++) out[oj] = this._gpuResults[oo + oj];
        // Validation hook: when window.__primordia.world.setGPUValidate(true),
        // every 256 ticks dump output[5] (predation) GPU vs CPU side-by-side
        // for the first live particle so the user can confirm the shader
        // bug. Cheap (one CPU brain forward per dispatch on validate frames).
        if (this._gpuValidate && (this.tick & 0xff) === 0 && i === 0) {
          const cpuOut = new Float32Array(N_OUTPUT);
          // Mirror inputs the GPU saw (limited reconstruction — best effort)
          this._gpuValidationLog = this._gpuValidationLog || [];
          // Push raw GPU output for inspection
          const gpuSnap = Array.from(out);
          this._gpuValidationLog.push({
            tick: this.tick,
            particleId: p.id,
            biasO: Array.from(g.brain.biasO),
            gpuOutputs: gpuSnap,
            enabledSlots: g.brain.enabledCount(),
            biasO_predation: g.brain.biasO[5],
            gpu_out_5: out[5],
          });
          if (this._gpuValidationLog.length > 50) this._gpuValidationLog.shift();
        }
      } else {
        const inp = this._brainInput;
        const totalNb = ownN + alienN;
        const nbInv = totalNb > 0 ? 1 / totalNb : 0;
        // Sensor layout — must match brain.js SENSOR_NAMES indices.
        inp[0] = 1;
        inp[1] = Math.tanh(p.energy * 0.15 - 0.5);
        inp[2] = Math.tanh(p.age / 600);
        inp[3] = Math.tanh(f0[sIdx] * 0.5);
        inp[4] = Math.tanh(f1[sIdx] * 0.3);
        inp[5] = Math.tanh(dfx0 * 2);
        inp[6] = Math.tanh(dfy0 * 2);
        inp[7] = Math.tanh(dfx1 * 2);
        inp[8] = Math.tanh(dfy1 * 2);
        inp[9] = Math.tanh(ownN * 0.3);
        inp[10] = Math.tanh(alienN * 0.3);
        inp[11] = totalNb > 0 ? Math.tanh(nbVx * nbInv) : 0;
        inp[12] = totalNb > 0 ? Math.tanh(nbVy * nbInv) : 0;
        const sigInv = sigN > 0 ? 1 / sigN : 0;
        inp[13] = sigN > 0 ? Math.tanh(sigR * sigInv * 1.5) : 0;
        inp[14] = sigN > 0 ? Math.tanh(sigG * sigInv * 1.5) : 0;
        inp[15] = sigN > 0 ? Math.tanh(sigB * sigInv * 1.5) : 0;
        const sf0 = this._soundFields[0], sf1 = this._soundFields[1],
              sf2 = this._soundFields[2], sf3 = this._soundFields[3];
        inp[16] = Math.tanh(sf0[sIdx] * 0.6);
        inp[17] = Math.tanh(sf1[sIdx] * 0.6);
        inp[18] = Math.tanh(sf2[sIdx] * 0.6);
        inp[19] = Math.tanh(sf3[sIdx] * 0.6);
        inp[20] = p.incomingBondMsgR;       // Phase 6b — bond.msg.r (pre-tanh'd)
        // Phase 5b — per-quadrant counts and signal magnitudes (normalized)
        inp[21] = Math.tanh(qcnt0 * 0.3);
        inp[22] = Math.tanh(qcnt1 * 0.3);
        inp[23] = Math.tanh(qcnt2 * 0.3);
        inp[24] = Math.tanh(qcnt3 * 0.3);
        inp[25] = qsigN0 > 0 ? Math.tanh((qsig0 / qsigN0) * 2 - 1) : 0;
        inp[26] = qsigN1 > 0 ? Math.tanh((qsig1 / qsigN1) * 2 - 1) : 0;
        inp[27] = qsigN2 > 0 ? Math.tanh((qsig2 / qsigN2) * 2 - 1) : 0;
        inp[28] = qsigN3 > 0 ? Math.tanh((qsig3 / qsigN3) * 2 - 1) : 0;
        // Phase 6b — multi-channel bondMsg G/B (pre-tanh'd)
        inp[29] = p.incomingBondMsgG;
        inp[30] = p.incomingBondMsgB;
        // Phase 6a — cluster geometry. Lookup once per tick.
        const cl6 = p.cluster;
        if (cl6) {
          inp[31] = Math.tanh((cl6.cx - p.x) / 80);
          inp[32] = Math.tanh((cl6.cy - p.y) / 80);
          inp[33] = Math.tanh(Math.log2(cl6.count + 1) * 0.3);
          inp[34] = 1;
          inp[35] = cl6.alarm || 0;          // Phase 6c — fast alarm broadcast
        } else {
          inp[31] = inp[32] = inp[33] = inp[34] = inp[35] = 0;
        }
        inp[36] = (p.wallCarry || 0) / WALL_CARRY_MAX;   // Thread B-2
        // Terrain proximity sensors — share the same scan helper as GPU extras.
        if (hasWalls) {
          const tScan = scanWallAndMudProximityInto(walls, sgx, sgy, this._terrainScanScratch);
          inp[37] = tScan[0];
          inp[38] = tScan[1];
          inp[39] = tScan[2];
          inp[40] = tScan[3];
          inp[41] = tScan[4];
          inp[42] = tScan[5];
          inp[43] = tScan[6];
          inp[44] = tScan[7];
          inp[46] = tScan[8];
          inp[47] = tScan[9];
          inp[48] = tScan[10];
          inp[49] = tScan[11];
          inp[50] = tScan[12];
          inp[51] = tScan[13];
          inp[52] = tScan[14];
          inp[53] = tScan[15];
        } else {
          inp[37] = inp[38] = inp[39] = inp[40] = 0;
          inp[41] = inp[42] = inp[43] = inp[44] = 0;
          inp[46] = inp[47] = inp[48] = inp[49] = 0;
          inp[50] = inp[51] = inp[52] = inp[53] = 0;
        }
        inp[45] = walls[sIdx] === WALL_POROUS ? 1 : 0;
        inp[54] = Math.tanh(p.vx / MAX_V);
        inp[55] = Math.tanh(p.vy / MAX_V);
        inp[56] = p.lastMotorX || 0;
        inp[57] = p.lastMotorY || 0;
        inp[58] = p.lastMotorProgress || 0;
        inp[59] = p.lastMotorSlip || 0;
        const damageAge = this.tick - (p.lastDamageTick || -9999);
        const damageFresh = damageAge >= 0 && damageAge < DAMAGE_SENSOR_WINDOW
          ? (p.recentDamage || 0) * Math.pow(DAMAGE_SENSOR_DECAY, damageAge)
          : 0;
        inp[60] = Math.tanh(damageFresh);
        inp[61] = damageFresh > 0.001 ? (p.damageDirX || 0) : 0;
        inp[62] = damageFresh > 0.001 ? (p.damageDirY || 0) : 0;
        inp[63] = damageFresh > 0.001 ? Math.tanh(damageAge / 30) : 0;
        inp[64] = longChem[0];
        inp[65] = longChem[1];
        inp[66] = longChem[2];
        inp[67] = longChem[3];
        inp[68] = longChem[4];
        inp[69] = longChem[5];
        inp[70] = longChem[6];
        inp[71] = longChem[7];
        if (cl6) {
          inp[72] = cl6.vx || 0;
          inp[73] = cl6.vy || 0;
          inp[74] = cl6.contactX || 0;
          inp[75] = cl6.contactY || 0;
          inp[76] = cl6.slip || 0;
          inp[77] = cl6.busR || 0;
          inp[78] = cl6.busG || 0;
          inp[79] = cl6.busB || 0;
          inp[80] = cl6.motorX || 0;
          inp[81] = cl6.motorY || 0;
          inp[82] = cl6.motorConsensus || 0;
          inp[83] = cl6.fieldX || 0;
          inp[84] = cl6.fieldY || 0;
          inp[85] = cl6.fieldStrength || 0;
        } else {
          inp[72] = inp[73] = inp[74] = inp[75] = inp[76] = 0;
          inp[77] = inp[78] = inp[79] = 0;
          inp[80] = inp[81] = inp[82] = 0;
          inp[83] = inp[84] = inp[85] = 0;
        }
        g.brain.forward(inp, out);
      }

      // Apply outputs
      const tx = Math.tanh(out[OUT_TX]);
      const ty = Math.tanh(out[OUT_TY]);
      const motorEffort = Math.min(1, Math.hypot(tx, ty));
      ax += tx * 0.5;       // additive thrust scale
      ay += ty * 0.5;
      p.predationGain = Math.tanh(out[OUT_PREDATION]);
      // Visual signal: clamp [0, 1]. The earlier per-tick-delta flash
      // detector was always near zero because random-init CTRNNs settle to
      // near-constant outputs. Replaced with a *threshold-crossing* detector:
      // when mean signal rises above 0.65 from below, fire a fresh flash
      // event (signalFlash = 1) that decays at 0.85/tick — visible for ~12
      // ticks. Sustained-high signal fires once on the rising edge then goes
      // quiet. Sub-threshold drift produces nothing. As evolution pushes
      // brains toward dynamic outputs, flashes start appearing.
      const prevR = p.signalR, prevG = p.signalG, prevB = p.signalB;
      p.signalR = sigmoid01(out[OUT_SIGNAL_R]);
      p.signalG = sigmoid01(out[OUT_SIGNAL_G]);
      p.signalB = sigmoid01(out[OUT_SIGNAL_B]);
      p.prevSignalR = prevR;
      p.prevSignalG = prevG;
      p.prevSignalB = prevB;
      // Hysteresis on the flash threshold — without this, brains whose
      // outputs oscillate near 0.65 (especially under GPU f32 precision)
      // re-fire the flash every couple of ticks instead of once per real
      // signaling event. State stays "above" between [0.55↑, 0.65↓] so
      // jitter inside the band doesn't refire.
      // Flash detection. Mean signal > 0.65 means the particle is actively
      // broadcasting, so we want the user to see them flash continuously
      // (not just on the rising edge). Three paths:
      //   (a) rising edge through 0.65 (with 0.55 hysteresis)
      //   (b) plateau refire: while held above threshold, flash every
      //       28..36 ticks (jittered per particle so colonies don't strobe
      //       in unison)
      //   (c) per-channel delta: any RGB channel jumps > 0.18 tick-to-tick
      //       (catches dynamic toggling even below threshold)
      const sigMean = (p.signalR + p.signalG + p.signalB) / 3;
      let above = p.signalAboveLast || 0;
      if (sigMean > 0.65) above = 1;
      else if (sigMean < 0.55) above = 0;
      const dR = Math.abs(p.signalR - prevR);
      const dG = Math.abs(p.signalG - prevG);
      const dB = Math.abs(p.signalB - prevB);
      const dMax = Math.max(dR, dG, dB);
      if (above && !p.signalAboveLast) {
        p.signalFlash = 1;                          // rising edge
        p.signalAboveSince = this.tick;
      } else if (above) {
        const heldFor = this.tick - (p.signalAboveSince || this.tick);
        const period = 28 + (p.id % 9);             // 28..36 ticks
        if (heldFor > 0 && heldFor % period === 0) {
          p.signalFlash = 0.85;                     // plateau refire
        } else {
          p.signalFlash *= 0.85;
        }
      } else if (dMax > 0.18) {
        p.signalFlash = Math.max(p.signalFlash, Math.min(1, dMax * 4));
      } else {
        p.signalFlash *= 0.85;
      }
      p.signalAboveLast = above;
      // Sound emission (Phase 2e)
      const samp = sigmoid01(out[OUT_SOUND_AMP]);
      p.soundAmp = samp;
      const ch = ((Math.tanh(out[OUT_SOUND_CH]) * 0.5 + 0.5) * N_SOUND_CHANNELS) | 0;
      p.soundCh = ch >= N_SOUND_CHANNELS ? N_SOUND_CHANNELS - 1 : (ch < 0 ? 0 : ch);
      // Phase 3d — bond / mate desire (sigmoid → [0,1])
      p.wantBond = sigmoid01(out[OUT_WANT_BOND]);
      p.wantMate = sigmoid01(out[OUT_WANT_MATE]);
      // Phase 5a → 6b — multi-channel bondMsg; each channel propagated to
      // bonded neighbors next tick. Three independent dimensions of meaning
      // for evolution to specialise on.
      p.bondMsgR = sigmoid01(out[OUT_BOND_MSG_R]);
      p.bondMsgG = sigmoid01(out[OUT_BOND_MSG_G]);
      p.bondMsgB = sigmoid01(out[OUT_BOND_MSG_B]);
      const inNamedCluster = !!p.cluster;
      const coordEat = inNamedCluster ? Math.max(0, p.incomingBondMsgG) : 0;
      const coordBuild = inNamedCluster ? Math.max(0, p.incomingBondMsgB) : 0;
      const commCost =
        SIGNAL_COST * Math.max(0, sigMean - 0.55) +
        SOUND_COST * Math.max(0, p.soundAmp - 0.45) +
        BONDMSG_COST * (
          Math.abs(p.bondMsgR - 0.5) +
          Math.abs(p.bondMsgG - 0.5) +
          Math.abs(p.bondMsgB - 0.5));

      // ── Thread B-2 — wall manipulation ──────────────────────────────
      // Two outputs: dig the cell in front of velocity (if solid wall) or
      // deposit a carried wall block at the current cell. Mutually
      // exclusive — deposit wins ties. Carry capped at WALL_CARRY_MAX.
      if (hasWalls || p.wallCarry > 0) {
        const digSig = sigmoid01(out[OUT_DIG]);
        const depSig = sigmoid01(out[OUT_DEPOSIT]);
        const digThresh = 0.56 - coordBuild * 0.12;
        const depThresh = 0.56 - coordBuild * 0.12;
        const digCost = WALL_DIG_COST * (1 - coordBuild * COORD_BUILD_BONUS);
        const depCost = WALL_DEPOSIT_COST * (1 - coordBuild * COORD_BUILD_BONUS);
        const carryLimit = Math.max(1, Math.min(WALL_CARRY_MAX, 1 + ((p.energy / 5) | 0)));
        if (depSig > depThresh && p.wallCarry > 0) {
        // Build candidate cells: current + cell behind velocity. Score each
        // by genome traits and pick the highest-scoring open cell.
        //   wall_affinity > 0 → prefer cells adjacent to existing walls
        //                       (extend structures); < 0 → isolated
        //                       (scatter / mark territory)
        //   prey_walling   > 0 → prefer cells near *favoured* prey species
        //                       (trap-building); < 0 → away (territorial
        //                       avoidance). Favoured prey = species with
        //                       max prey_preference value.
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        const dgx = clamp((p.x / CELL) | 0, 0, GW - 1);
        const dgy = clamp((p.y / CELL) | 0, 0, GH - 1);
        const candX = this._buildCandX;
        const candY = this._buildCandY;
        let candN = 1;
        candX[0] = dgx;
        candY[0] = dgy;
        if (sp > 0.1) {
          const fx = Math.round(p.vx / sp);
          const fy = Math.round(p.vy / sp);
          for (let ci = 0; ci < 3; ci++) {
            const ex = ci === 0 ? -fx : (ci === 1 ? -fy : fy);
            const ey = ci === 0 ? -fy : (ci === 1 ? fx : -fx);
            const bx = clamp(dgx + ex, 0, GW - 1);
            const by = clamp(dgy + ey, 0, GH - 1);
            let duplicate = false;
            for (let k = 0; k < candN; k++) {
              if (candX[k] === bx && candY[k] === by) { duplicate = true; break; }
            }
            if (!duplicate) {
              candX[candN] = bx;
              candY[candN] = by;
              candN++;
            }
          }
        }
        const wallAff = p.genome.wall_affinity || 0;
        const preyWall = p.genome.prey_walling || 0;
        // Favoured prey species (only matters when prey_walling != 0)
        let targetPrey = -1;
        if (Math.abs(preyWall) > 0.05 && p.genome.prey_preference) {
          let best = -Infinity;
          for (let s = 0; s < NUM_SPECIES; s++) {
            if (p.genome.prey_preference[s] > best) {
              best = p.genome.prey_preference[s];
              targetPrey = s;
            }
          }
        }
        let bestIdx = -1, bestTx = -1, bestTy = -1, bestScore = -Infinity;
        for (let ci = 0; ci < candN; ci++) {
          const tx = candX[ci];
          const ty = candY[ci];
          const didx = ty * GW + tx;
          if (walls[didx] !== 0) continue;
          let score = 0;
          // Wall-adjacency component
          if (Math.abs(wallAff) > 0.05) {
            let nbWalls = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = ty + dy;
              if (yy < 0 || yy >= GH) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const xx = tx + dx;
                if (xx < 0 || xx >= GW) continue;
                if (dx === 0 && dy === 0) continue;
                if (walls[yy * GW + xx]) nbWalls++;
              }
            }
            score += wallAff * (nbWalls / 8);    // -1..1 weighted
          }
          // Prey-walling component — count target-species particles within
          // a small radius via the spatial hash (3×3 hash cells).
          if (targetPrey >= 0) {
            const cwx = (tx * CELL + CELL * 0.5);
            const cwy = (ty * CELL + CELL * 0.5);
            const hcx = (cwx / HASH_CELL) | 0;
            const hcy = (cwy / HASH_CELL) | 0;
            let preyCount = 0;
            const hcx0 = Math.max(0, hcx - 1), hcx1 = Math.min(HW - 1, hcx + 1);
            const hcy0 = Math.max(0, hcy - 1), hcy1 = Math.min(HH - 1, hcy + 1);
            for (let yy = hcy0; yy <= hcy1; yy++) {
              for (let xx = hcx0; xx <= hcx1; xx++) {
                let j = this.cellHead[yy * HW + xx];
                while (j !== -1) {
                  const q = ps[j];
                  if (q && !q.dead && q.species === targetPrey) preyCount++;
                  j = this.cellNext[j];
                }
              }
            }
            score += preyWall * Math.min(1, preyCount / 6);
          }
          if (score > bestScore) {
            bestScore = score; bestIdx = didx; bestTx = tx; bestTy = ty;
          }
        }
        if (bestIdx >= 0) {
          walls[bestIdx] = WALL_SOLID;
          this._wallCount++;
          this._wallsVersion++;
          this.setWallMeta(bestIdx, p);
          p.wallCarry--;
          p.energy -= depCost;
          this.totalWallDeposits++;
          p.wallDeposits = (p.wallDeposits || 0) + 1;
          this._wallSoundEvents.push({ kind: 'plop', x: p.x, y: p.y, id: p.id });
        }
      } else if (digSig > digThresh && p.wallCarry < carryLimit && p.energy > digCost) {
        // Prefer the cell in front of velocity, but search adjacent cells too
        // so a particle pinned against a wall can still excavate.
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        const dirx = sp > 0.1 ? p.vx / sp : 0;
        const diry = sp > 0.1 ? p.vy / sp : 0;
        const dgx = clamp((p.x / CELL) | 0, 0, GW - 1);
        const dgy = clamp((p.y / CELL) | 0, 0, GH - 1);
        let bestIdx = -1, bestScore = -Infinity;
        for (let yy = -1; yy <= 1; yy++) {
          for (let xx = -1; xx <= 1; xx++) {
            if (xx === 0 && yy === 0) continue;
            const tgx = clamp(dgx + xx, 0, GW - 1);
            const tgy = clamp(dgy + yy, 0, GH - 1);
            const tidx = tgy * GW + tgx;
            if (walls[tidx] !== WALL_SOLID) continue;
            const len = Math.sqrt(xx * xx + yy * yy) || 1;
            const dot = sp > 0.1 ? (xx / len) * dirx + (yy / len) * diry : 0;
            const score = dot + Math.random() * 0.05;
            if (score > bestScore) {
              bestScore = score;
              bestIdx = tidx;
            }
          }
        }
        if (bestIdx >= 0) {
          walls[bestIdx] = 0;
          this._wallCount = Math.max(0, this._wallCount - 1);
          this._wallsVersion++;
          this.clearWallMeta(bestIdx);
          p.wallCarry++;
          p.energy -= digCost;
          this.totalWallDigs++;
          p.wallDigs = (p.wallDigs || 0) + 1;
          f1[bestIdx] = Math.min(DECAY_CAP, f1[bestIdx] + 0.15);
          this._decayActive = true;
          this._wallSoundEvents.push({ kind: 'grunt', x: p.x, y: p.y, id: p.id });
        }
      }

      // ── Bond physics: spring + energy share + break-on-distance ──
      }
      if (p.bonds.length > 0) {
        for (let bi = p.bonds.length - 1; bi >= 0; bi--) {
          const partner = idMap[p.bonds[bi]];
          if (!partner || partner.dead) {
            p.bonds.splice(bi, 1);
            continue;
          }
          const bdx = partner.x - p.x;
          const bdy = partner.y - p.y;
          const bd = Math.sqrt(bdx * bdx + bdy * bdy);
          if (bd > BOND_BREAK_DIST) {
            p.bonds.splice(bi, 1);
            continue;
          }
          if (bd > 0.5) {
            const stretch = bd - BOND_REST;
            const f = K_BOND * stretch / bd;
            ax += bdx * f;
            ay += bdy * f;
          }
          // Energy share — only once per bond (low-id side)
          if (p.id < partner.id) {
            const diff = partner.energy - p.energy;
            if (Math.abs(diff) > 0.4) {
              const transfer = diff * ENERGY_SHARE_RATE;
              p.energy += transfer;
              partner.energy -= transfer;
            }
          }
        }
      }

      // Integrate. Max velocity is energy-scaled: starving particles can't
      // move as fast as well-fed ones (50% → 100% of MAX_V across energy
      // 0..6.7+). Visible "tired/sluggish" effect plus extra selection
      // pressure — a low-energy particle struggles to chase food.
      let vx = (p.vx + ax) * (1 - K_DRAG);
      let vy = (p.vy + ay) * (1 - K_DRAG);
      const maxV = MAX_V * (0.5 + Math.min(1, p.energy * 0.15) * 0.5);
      const vmag2 = vx * vx + vy * vy;
      if (vmag2 > maxV * maxV) {
        const s = maxV / Math.sqrt(vmag2);
        vx *= s; vy *= s;
      }
      const oldX = p.x;
      const oldY = p.y;
      let nx = oldX + vx;
      let ny = oldY + vy;

      // Wall handling — axis-separated, using actual current cell
      let hardContactX = 0;
      let hardContactY = 0;
      const pgy = clamp((p.y / CELL) | 0, 0, GH - 1);
      const ngx = clamp((nx / CELL) | 0, 0, GW - 1);
      // Solid + glass wall types block particles; mud lets them pass.
      const wTargetX = walls[pgy * GW + ngx];
      if (wTargetX === WALL_SOLID || wTargetX === WALL_MEMBRANE) {
        nx = p.x;
        hardContactX = vx > 0 ? 1 : -1;
        vx = -vx * 0.5;
      }
      const cgx = clamp((nx / CELL) | 0, 0, GW - 1);
      const ngy = clamp((ny / CELL) | 0, 0, GH - 1);
      const wTargetY = walls[ngy * GW + cgx];
      if (wTargetY === WALL_SOLID || wTargetY === WALL_MEMBRANE) {
        ny = p.y;
        hardContactY = vy > 0 ? 1 : -1;
        vy = -vy * 0.5;
      }
      const terrainIdx = clamp((ny / CELL) | 0, 0, GH - 1) * GW +
        clamp((nx / CELL) | 0, 0, GW - 1);
      const inMud = walls[terrainIdx] === WALL_POROUS;
      if (inMud) {
        vx *= MUD_SPEED_MULT;
        vy *= MUD_SPEED_MULT;
        nx = p.x + vx;
        ny = p.y + vy;
      }
      // Toroidal-ish bounds: reflect at edges
      if (nx < 1) { nx = 1; hardContactX = -1; vx = Math.abs(vx) * 0.5; }
      else if (nx > W - 1) { nx = W - 1; hardContactX = 1; vx = -Math.abs(vx) * 0.5; }
      if (ny < 1) { ny = 1; hardContactY = -1; vy = Math.abs(vy) * 0.5; }
      else if (ny > H - 1) { ny = H - 1; hardContactY = 1; vy = -Math.abs(vy) * 0.5; }

      if (hardContactX || hardContactY) {
        const randomTangentSign = ((p.id + ((this.tick / 31) | 0)) & 1) ? 1 : -1;
        const tangentSignY = Math.abs(longFieldY) > 0.08 ? Math.sign(longFieldY) : randomTangentSign;
        const tangentSignX = Math.abs(longFieldX) > 0.08 ? Math.sign(longFieldX) : randomTangentSign;
        vx -= hardContactX * HARD_CONTACT_ESCAPE;
        vy -= hardContactY * HARD_CONTACT_ESCAPE;
        if (hardContactX && Math.abs(vy) < 0.35) {
          const tryVy = vy + tangentSignY * HARD_CONTACT_TANGENT;
          const tryY = clamp(oldY + tryVy, 1, H - 1);
          const tryGy = clamp((tryY / CELL) | 0, 0, GH - 1);
          const curGx = clamp((nx / CELL) | 0, 0, GW - 1);
          const wt = walls[tryGy * GW + curGx];
          if (wt !== WALL_SOLID && wt !== WALL_MEMBRANE) {
            vy = tryVy;
            ny = tryY;
          }
        }
        if (hardContactY && Math.abs(vx) < 0.35) {
          const tryVx = vx + tangentSignX * HARD_CONTACT_TANGENT;
          const tryX = clamp(oldX + tryVx, 1, W - 1);
          const tryGx = clamp((tryX / CELL) | 0, 0, GW - 1);
          const curGy = clamp((ny / CELL) | 0, 0, GH - 1);
          const wt = walls[curGy * GW + tryGx];
          if (wt !== WALL_SOLID && wt !== WALL_MEMBRANE) {
            vx = tryVx;
            nx = tryX;
          }
        }
      }

      p.x = nx; p.y = ny;
      p.vx = vx; p.vy = vy;
      if (motorEffort > 1e-4) {
        const dxActual = nx - oldX;
        const dyActual = ny - oldY;
        const progress = clamp((dxActual * tx + dyActual * ty) / (motorEffort * Math.max(0.001, maxV)), -1, 1);
        p.lastMotorProgress = progress;
        p.lastMotorSlip = clamp(motorEffort - Math.max(0, progress), 0, 1);
      } else {
        p.lastMotorProgress = 0;
        p.lastMotorSlip = 0;
      }
      if (hardContactX || hardContactY) p.lastMotorSlip = Math.max(p.lastMotorSlip, 0.65);
      p.lastMotorX = tx;
      p.lastMotorY = ty;
      p.lastHardContactX = hardContactX;
      p.lastHardContactY = hardContactY;
      p.age++;

      // Energy
      const speed2 = vx * vx + vy * vy;
      const finalGx = clamp((nx / CELL) | 0, 0, GW - 1);
      const finalGy = clamp((ny / CELL) | 0, 0, GH - 1);
      const fIdx = finalGy * GW + finalGx;
      let wallAdj = 0, wallAdjMax = 0;
      if (hasWalls) {
        for (let wy = -1; wy <= 1; wy++) {
          const yy = finalGy + wy;
          if (yy < 0 || yy >= GH) continue;
          for (let wx = -1; wx <= 1; wx++) {
            const xx = finalGx + wx;
            if (xx < 0 || xx >= GW || (wx === 0 && wy === 0)) continue;
            wallAdjMax++;
            if (walls[yy * GW + xx]) wallAdj++;
          }
        }
      }
      const shelter = wallAdjMax > 0 ? wallAdj / wallAdjMax : 0;
      const shelterRelief = inNamedCluster
        ? Math.min(0.45, shelter * (WALL_SHELTER_RELIEF + coordBuild * COORD_SHELTER_RELIEF))
        : 0;
      p.shelterRelief = shelterRelief;
      const motionCost = K_MOTION_COST * speed2 * (1 - shelterRelief * 0.35);
      const carryCost = (p.wallCarry || 0) * WALL_CARRY_COST * (1 + Math.min(1, speed2 * 0.12));
      let dE = -(g.metab + motionCost + commCost + carryCost + (inMud ? MUD_ENERGY_DRAIN : 0));
      // crowd penalty
      if (crowd > 6) dE -= CROWD_PENALTY * (crowd - 6) * (1 - shelterRelief);
      // eat food at current cell
      // Phase 6 — eat efficiency now scales with two evolved traits:
      //   • cluster bonus: +20% if particle is in a named cluster (rewards
      //     bondedness directly so cluster_affinity has selection pressure)
      //   • slot bonus:    +2.5% per active brain slot above the baseline 3
      //     (rewards cognitive growth beyond the small-brain default)
      // Combined max ≈ 1.20 × 1.125 = 1.35× efficiency for an 8-slot bonded
      // particle vs an unbonded 3-slot one. Direct fitness lever for both
      // Phase 6a (clusters) and structural brain mutation.
      const eat = Math.min(f0[fIdx], EAT_MAX);
      const slotBonus = 1 + Math.max(0, g.brain.enabledCount() - 3) * 0.025;
      const effMult = (inNamedCluster ? 1.20 : 1.0) *
        (1 + coordEat * COORD_EAT_BONUS) *
        slotBonus;
      const eatGain = eat * g.efficiency * effMult;
      f0[fIdx] -= eat;
      dE += eatGain;
      if (eat > 0) {
        this.totalFieldFoodEaten += eat;
        this.totalFieldEnergyGain += eatGain;
        p.fieldFoodEaten = (p.fieldFoodEaten || 0) + eat;
        p.fieldEnergyGain = (p.fieldEnergyGain || 0) + eatGain;
      }
      // emit chemicals — body baseline plus brain decision
      const eF = g.emit[0] + Math.max(0, out[OUT_EMIT_FOOD]) * 0.06;
      const eD = g.emit[1] + Math.max(0, out[OUT_EMIT_DECAY]) * 0.06;
      if (eF > 0) f0[fIdx] = Math.min(FOOD_CAP, f0[fIdx] + eF);
      if (eD > 0) {
        f1[fIdx] = Math.min(DECAY_CAP, f1[fIdx] + eD);
        this._decayActive = true;
      }
      // Sound emission deposited into selected channel field at this cell
      if (p.soundAmp > 0.15) {
        const sf = this._soundFields[p.soundCh];
        sf[fIdx] = Math.min(SOUND_CAP, sf[fIdx] + p.soundAmp * 0.4);
        this._soundLastEmit[p.soundCh] = this.tick;
      }

      p.energy += dE;

      // Death
      if (p.energy <= 0) {
        this._killParticle(p, idMap);
        continue;
      }

      // Reproduction — body threshold, gated by brain output (must not strongly veto)
      const reproVeto = out[OUT_REPRO_GATE] < -0.35;
      // Sexual reproduction: try first if conditions are right
      let didSex = false;
      if (!reproVeto && p.wantMate > MATE_GATE && p.bonds.length > 0 &&
          p.energy > g.repro_thresh * 0.8 &&
          Math.random() < REPRO_PROB_SEX &&
          this.particles.length + this.births.length < cellBirthLimit) {
        for (const pid of p.bonds) {
          const partner = idMap[pid];
          if (!partner || partner.dead) continue;
          if (partner.wantMate < MATE_GATE) continue;
          if (partner.energy < partner.genome.repro_thresh * 0.7) continue;
          // Both willing — sexual repro with crossover + mutation
          const boost = 1 + Math.min(2, mut[fIdx] * 0.8);
          let childGenome = crossoverGenome(g, partner.genome);
          childGenome = mutate(childGenome, Math.random, boost);
          const identity = this._cellBirthIdentity(p, partner);
          if (identity.clustered && !this._canAttachCellBirth(identity)) continue;
          const combinedEnergy = p.energy + partner.energy;
          const meanParentEnergy = combinedEnergy * 0.5;
          const meanRepro = ((g.repro_thresh || 0) + (partner.genome?.repro_thresh || 0)) * 0.5;
          const childE = offspringEndowmentForEnergy(meanParentEnergy, meanRepro, OFFSPRING_SEX_MAX_ENERGY);
          const childCost = offspringCostForEndowment(childE, REPRO_TAX);
          const pAvail = Math.max(0, p.energy - OFFSPRING_PARENT_FLOOR);
          const partnerAvail = Math.max(0, partner.energy - OFFSPRING_PARENT_FLOOR);
          const available = pAvail + partnerAvail;
          if (available < childCost) continue;
          const pCost = childCost * (pAvail / available);
          const partnerCost = childCost - pCost;
          // Inherit cladeId from the richer parent before provisioning costs.
          const parentClade = p.energy >= partner.energy ? p.cladeId : partner.cladeId;
          p.energy -= pCost;
          partner.energy -= partnerCost;
          const child = {
            id: ++_id,
            x: clamp((p.x + partner.x) * 0.5 + (Math.random() - 0.5) * 4, 1, W - 1),
            y: clamp((p.y + partner.y) * 0.5 + (Math.random() - 0.5) * 4, 1, H - 1),
            vx: (p.vx + partner.vx) * 0.25,
            vy: (p.vy + partner.vy) * 0.25,
            genome: childGenome,
            species: childGenome.species,
            energy: childE,
            age: 0,
            lineage: p.lineage,
            cladeId: parentClade,
            organismRootId: identity.rootId,
            organismGeneration: identity.generation,
            signalR: 0, signalG: 0, signalB: 0,
            predationGain: 0,
            predationEvents: 0,
            predationDrain: 0,
            predationEnergyGain: 0,
            predationFatalDrains: 0,
            predationKills: 0,
            fieldFoodEaten: 0,
            fieldEnergyGain: 0,
            combatAttacks: 0,
            combatKills: 0,
            combatCounters: 0,
            combatEscapes: 0,
            combatFailedCost: 0,
            combatDamageDealt: 0,
            combatDamageTaken: 0,
            lastPredatorId: 0,
            lastPredationTick: -9999,
            lastAttackTick: -9999,
            lastAttackFlashTick: -9999,
            recentDamage: 0,
            damageDirX: 0,
            damageDirY: 0,
            lastDamageTick: -9999,
            soundCh: 0, soundAmp: 0,
            wantBond: 0, wantMate: 0,
            bondMsgR: 0.5, bondMsgG: 0.5, bondMsgB: 0.5,
            incomingBondMsgR: 0, incomingBondMsgG: 0, incomingBondMsgB: 0,
            wallCarry: 0,
            shelterRelief: 0,
            wallDigs: 0,
            wallDeposits: 0,
            lastLongFieldX: 0, lastLongFieldY: 0,
            lastMotorX: 0, lastMotorY: 0,
            lastMotorProgress: 0, lastMotorSlip: 0,
            lastHardContactX: 0, lastHardContactY: 0,
            cluster: null,
            bonds: [],
            dead: false,
          };
          this._attachCellBirthToOrganism(child, identity);
          this.births.push(child);
          this.totalBorn++;
          this._brainsDirty = true;
          didSex = true;
          break;
        }
      }
      // Asexual fallback
      if (!didSex && !reproVeto && p.energy > g.repro_thresh && Math.random() < REPRO_PROB) {
        if (this.particles.length + this.births.length < cellBirthLimit) {
          const identity = this._cellBirthIdentity(p);
          if (identity.clustered && !this._canAttachCellBirth(identity)) continue;
          const boost = 1 + Math.min(2, mut[fIdx] * 0.8);
          const childGenome = mutate(g, Math.random, boost);
          const childE = offspringEndowmentForEnergy(p.energy, g.repro_thresh, OFFSPRING_MAX_ENERGY);
          const childCost = offspringCostForEndowment(childE, REPRO_TAX);
          if (p.energy - childCost < OFFSPRING_PARENT_FLOOR) continue;
          p.energy -= childCost;
          const jitter = 4;
          const child = {
            id: ++_id,
            x: clamp(p.x + (Math.random() - 0.5) * jitter, 1, W - 1),
            y: clamp(p.y + (Math.random() - 0.5) * jitter, 1, H - 1),
            vx: -p.vx * 0.5 + (Math.random() - 0.5) * 0.5,
            vy: -p.vy * 0.5 + (Math.random() - 0.5) * 0.5,
            genome: childGenome,
            species: childGenome.species,
            energy: childE,
            age: 0,
            lineage: p.lineage,
            cladeId: p.cladeId,
            organismRootId: identity.rootId,
            organismGeneration: identity.generation,
            signalR: 0, signalG: 0, signalB: 0,
            predationGain: 0,
            predationEvents: 0,
            predationDrain: 0,
            predationEnergyGain: 0,
            predationFatalDrains: 0,
            predationKills: 0,
            fieldFoodEaten: 0,
            fieldEnergyGain: 0,
            combatAttacks: 0,
            combatKills: 0,
            combatCounters: 0,
            combatEscapes: 0,
            combatFailedCost: 0,
            combatDamageDealt: 0,
            combatDamageTaken: 0,
            lastPredatorId: 0,
            lastPredationTick: -9999,
            lastAttackTick: -9999,
            lastAttackFlashTick: -9999,
            recentDamage: 0,
            damageDirX: 0,
            damageDirY: 0,
            lastDamageTick: -9999,
            soundCh: 0, soundAmp: 0,
            wantBond: 0, wantMate: 0,
            bondMsgR: 0.5, bondMsgG: 0.5, bondMsgB: 0.5,
            incomingBondMsgR: 0, incomingBondMsgG: 0, incomingBondMsgB: 0,
            wallCarry: 0,
            shelterRelief: 0,
            wallDigs: 0,
            wallDeposits: 0,
            lastLongFieldX: 0, lastLongFieldY: 0,
            lastMotorX: 0, lastMotorY: 0,
            lastMotorProgress: 0, lastMotorSlip: 0,
            lastHardContactX: 0, lastHardContactY: 0,
            cluster: null,
            bonds: [],
            dead: false,
          };
          this._attachCellBirthToOrganism(child, identity);
          this.births.push(child);
          this.totalBorn++;
          this._brainsDirty = true;
        }
      }
    }

    // ── 3. Field update ──────────────────────────────────────────────
      if (profiling) markProfile('agents');
    if (this._decayActive) convertDecayToFood(f0, f1);
    photosynthesise(f0, walls, hasWalls);
    diffuseAndDecay(f0, DIFFUSE, DECAY_LOSS, FOOD_CAP);
    if (this._decayActive) this._decayActive = diffuseAndDecay(f1, DIFFUSE, DECAY_DECAY, DECAY_CAP, true);
    if (this._mutagenActive) this._mutagenActive = decayOnly(mut, MUTAGEN_DECAY);
    // Sound channels: only diffuse channels with recent emissions (cheap idle).
    for (let s = 0; s < this._soundFields.length; s++) {
      if (this.tick - this._soundLastEmit[s] < 60) {
        diffuseAndDecay(this._soundFields[s], SOUND_DIFFUSE, SOUND_DECAY, SOUND_CAP);
      }
    }
    // Zero out opaque walls — glass and mud let chemistry/sound pass through.
    if (hasWalls) {
      const solidWalls = this._solidWalls();
      for (let k = 0; k < solidWalls.length; k++) {
        const i = solidWalls[k];
        f0[i] = 0; f1[i] = 0; mut[i] = 0;
        for (let s = 0; s < this._soundFields.length; s++) this._soundFields[s][i] = 0;
      }
    }

    // ── 4. Compact particles: remove dead, append births ─────────────
    if (profiling) markProfile('fields');
    const oldParticleCount = this.particles.length;
    const birthCount = this.births.length;
    let write = 0;
    for (let read = 0; read < this.particles.length; read++) {
      const p = this.particles[read];
      if (!p.dead) this.particles[write++] = p;
    }
    this.particles.length = write;
    for (let i = 0; i < this.births.length; i++) this.particles.push(this.births[i]);
    if (write !== oldParticleCount || birthCount > 0) {
      this._brainsDirty = true;
      this._gpuStateDirty = true;
      this._gpuOrderVersion++;
    }
    this.births.length = 0;

    // ── 5. Clade census + speciation detection ───────────────────────
    if (profiling) markProfile('compact');
    this.clades.sweep(this);
    this.updateClusters();
    this.smoothClusterEnergy();
    this._tryClusterBudding();
    if (profiling) markProfile('lineage');

    // ── 6. Pipeline NEXT tick's GPU compute (Phase 4g). Doesn't block.
    // Uses post-integration state so GPU sees latest positions; results
    // come back at the start of next tick.
    this._updateGpuAdaptiveCadence();

    if (this._gpuEnabled && this._gpuCooldownTicks <= 0 && this._gpu && this.particles.length > 0 &&
        (!this._gpu.hasReadbackCapacity || this._gpu.hasReadbackCapacity())) {
      try {
        const pairOnly = !!this._gpuPairOnly;
        this._gpu.upload(this.particles);
        this._gpu.uploadWalls?.(this.walls, this._wallsVersion);
        if (!pairOnly) {
          this._buildGpuExtras();
          this._gpu.uploadExtras(this._extrasStaging);
          if (this._brainsDirty) {
            this._gpu.uploadBrains(this.particles);
            this._gpu.uploadBrainState(this.particles);
            this._brainsDirty = false;
            this._gpuStateDirty = false;
          } else if (this._gpuStateDirty) {
            this._gpu.uploadBrainState(this.particles);
            this._gpuStateDirty = false;
          }
        }
        const token = this._gpu.dispatch({ pairOnly });
        if (token) {
          const pending = {
            done: false,
            value: null,
            error: null,
            promise: null,
            tick: this.tick,
            orderVersion: this._gpuOrderVersion,
            serial: token.serial,
            stride: token.stride || (pairOnly ? PAIR_RESULT_STRIDE : RESULT_STRIDE),
            pairOnly,
          };
          pending.promise = this._gpu.readback(token).then(
            (value) => {
              pending.done = true;
              pending.value = value;
              return value;
            },
            (error) => {
              pending.done = true;
              pending.error = error;
              throw error;
            },
          );
          pending.promise.catch(() => {});
          this._gpuPendings.push(pending);
        }
      } catch (err) {
        console.warn('[gpu] pipelined dispatch failed; disabling GPU', err);
        this._gpuEnabled = false;
        this._gpuPendings.length = 0;
      }
    }
    if (profiling) {
      markProfile('gpuDispatch');
      this._profileTicks++;
    }
  }

  _updateGpuAdaptiveCadence() {
    if (!this._gpuAdaptive || !this._gpuEnabled || !this._gpu) return;
    if (this._gpuCooldownTicks > 0) return;

    const used = this._gpuWindowUsed | 0;
    const fallback = this._gpuWindowFallback | 0;
    const total = used + fallback;
    if (total < 12) return;

    const usedRatio = used / total;
    const readbackMs = this._gpu.lastReadbackMs || 0;
    const tooStale = usedRatio < 0.55;
    const tooSlow = readbackMs > 45 && usedRatio < 0.75;

    if (tooStale || tooSlow) {
      // Leave the user-facing GPU toggle on, but stop launching new dispatches
      // for a while. CPU remains the reference path; after cooldown, GPU probes
      // again automatically in case population/terrain pressure has changed.
      this._gpuCooldownTicks = 300;
      this._gpuAdaptiveCooldowns++;
      this._gpuWindowUsed = 0;
      this._gpuWindowFallback = 0;
    } else {
      this._gpuWindowUsed = Math.floor(used * 0.5);
      this._gpuWindowFallback = Math.floor(fallback * 0.5);
    }
  }

  // Fill the extras staging buffer from current particle/world state. Called
  // before GPU dispatch so the brain_forward shader has chem-field samples,
  // bond-network messages, cluster geometry, and wall sensors that the CPU
  // computes more easily than the GPU.
  _buildGpuExtras() {
    const ps = this.particles;
    const N = ps.length;
    const f0 = this.field[0], f1 = this.field[1];
    const walls = this.walls;
    const hasWalls = this._wallCount > 0;
    if (!this._extrasStaging || this._extrasStaging.length < this.maxParticles * EXTRAS_STRIDE) {
      this._extrasStaging = new Float32Array(this.maxParticles * EXTRAS_STRIDE);
    }
    const extras = this._extrasStaging;
    const sf0 = this._soundFields[0], sf1 = this._soundFields[1],
          sf2 = this._soundFields[2], sf3 = this._soundFields[3];
    for (let i = 0; i < N; i++) {
      const p = ps[i];
      const o = i * EXTRAS_STRIDE;
      if (p.dead) {
        for (let k = 0; k < EXTRAS_STRIDE; k++) extras[o + k] = 0;
        continue;
      }
      const sgx = clamp((p.x / CELL) | 0, 1, GW - 2);
      const sgy = clamp((p.y / CELL) | 0, 1, GH - 2);
      const sIdx = sgy * GW + sgx;
      extras[o + 0] = Math.tanh(f0[sIdx] * 0.5);
      extras[o + 1] = Math.tanh(f1[sIdx] * 0.3);
      extras[o + 2] = Math.tanh((f0[sIdx + 1] - f0[sIdx - 1]) * 1.0);
      extras[o + 3] = Math.tanh((f0[sIdx + GW] - f0[sIdx - GW]) * 1.0);
      extras[o + 4] = Math.tanh((f1[sIdx + 1] - f1[sIdx - 1]) * 1.0);
      extras[o + 5] = Math.tanh((f1[sIdx + GW] - f1[sIdx - GW]) * 1.0);
      extras[o + 6] = Math.tanh(sf0[sIdx] * 0.6);
      extras[o + 7] = Math.tanh(sf1[sIdx] * 0.6);
      extras[o + 8] = Math.tanh(sf2[sIdx] * 0.6);
      extras[o + 9] = Math.tanh(sf3[sIdx] * 0.6);
      extras[o + 10] = p.incomingBondMsgR;
      extras[o + 11] = p.incomingBondMsgG;
      extras[o + 12] = p.incomingBondMsgB;
      const cl = p.cluster;
      if (cl) {
        extras[o + 13] = Math.tanh((cl.cx - p.x) / 80);
        extras[o + 14] = Math.tanh((cl.cy - p.y) / 80);
        extras[o + 15] = Math.tanh(Math.log2(cl.count + 1) * 0.3);
        extras[o + 16] = 1;
        extras[o + 17] = cl.alarm || 0;
      } else {
        extras[o + 13] = 0;
        extras[o + 14] = 0;
        extras[o + 15] = 0;
        extras[o + 16] = 0;
        extras[o + 17] = 0;
      }
      extras[o + 18] = (p.wallCarry || 0) / WALL_CARRY_MAX;
      const wgx = clamp((p.x / CELL) | 0, 0, GW - 1);
      const wgy = clamp((p.y / CELL) | 0, 0, GH - 1);
      if (hasWalls) {
        const ts = scanWallAndMudProximityInto(walls, wgx, wgy, this._terrainScanScratch);
        extras[o + 19] = ts[0];
        extras[o + 20] = ts[1];
        extras[o + 21] = ts[2];
        extras[o + 22] = ts[3];
        extras[o + 23] = ts[4];
        extras[o + 24] = ts[5];
        extras[o + 25] = ts[6];
        extras[o + 26] = ts[7];
        extras[o + 28] = ts[8];
        extras[o + 29] = ts[9];
        extras[o + 30] = ts[10];
        extras[o + 31] = ts[11];
        extras[o + 32] = ts[12];
        extras[o + 33] = ts[13];
        extras[o + 34] = ts[14];
        extras[o + 35] = ts[15];
      } else {
        extras[o + 19] = extras[o + 20] = extras[o + 21] = extras[o + 22] = 0;
        extras[o + 23] = extras[o + 24] = extras[o + 25] = extras[o + 26] = 0;
        extras[o + 28] = extras[o + 29] = extras[o + 30] = extras[o + 31] = 0;
        extras[o + 32] = extras[o + 33] = extras[o + 34] = extras[o + 35] = 0;
      }
      extras[o + 27] = walls[sIdx] === WALL_POROUS ? 1 : 0;
      extras[o + 36] = p.lastMotorX || 0;
      extras[o + 37] = p.lastMotorY || 0;
      extras[o + 38] = p.lastMotorProgress || 0;
      extras[o + 39] = p.lastMotorSlip || 0;
      const damageAge = this.tick - (p.lastDamageTick || -9999);
      const damageFresh = damageAge >= 0 && damageAge < DAMAGE_SENSOR_WINDOW
        ? (p.recentDamage || 0) * Math.pow(DAMAGE_SENSOR_DECAY, damageAge)
        : 0;
      extras[o + 40] = Math.tanh(damageFresh);
      extras[o + 41] = damageFresh > 0.001 ? (p.damageDirX || 0) : 0;
      extras[o + 42] = damageFresh > 0.001 ? (p.damageDirY || 0) : 0;
      extras[o + 43] = damageFresh > 0.001 ? Math.tanh(damageAge / 30) : 0;
      const longChemRadius = Math.round((p.genome?.sense_radius || 48) / CELL);
      sampleLongChemInto(f0, sgx, sgy, longChemRadius, extras, o + 44, 0.45);
      sampleLongChemInto(f1, sgx, sgy, longChemRadius, extras, o + 48, 0.32);
      if (cl) {
        extras[o + 52] = cl.vx || 0;
        extras[o + 53] = cl.vy || 0;
        extras[o + 54] = cl.contactX || 0;
        extras[o + 55] = cl.contactY || 0;
        extras[o + 56] = cl.slip || 0;
        extras[o + 57] = cl.busR || 0;
        extras[o + 58] = cl.busG || 0;
        extras[o + 59] = cl.busB || 0;
        extras[o + 60] = cl.motorX || 0;
        extras[o + 61] = cl.motorY || 0;
        extras[o + 62] = cl.motorConsensus || 0;
        extras[o + 63] = cl.fieldX || 0;
        extras[o + 64] = cl.fieldY || 0;
        extras[o + 65] = cl.fieldStrength || 0;
      } else {
        extras[o + 52] = extras[o + 53] = extras[o + 54] = extras[o + 55] = extras[o + 56] = 0;
        extras[o + 57] = extras[o + 58] = extras[o + 59] = 0;
        extras[o + 60] = extras[o + 61] = extras[o + 62] = 0;
        extras[o + 63] = extras[o + 64] = extras[o + 65] = 0;
      }
    }
  }

  // Cluster-wide energy smoothing — every CLUSTER_SMOOTH_INTERVAL ticks,
  // nudge each member of each named cluster toward the cluster's mean
  // energy. Total energy is conserved (nudges sum to zero); this just
  // reflects an organism redistributing reserves between cells, so a
  // colony with a few feeding members can sustain its hungrier ones.
  smoothClusterEnergy() {
    const SMOOTH_INTERVAL = 8;
    const RATE = 0.05;
    if (this.tick % SMOOTH_INTERVAL !== 0) return;
    if (!this._clusters || this._clusters.length === 0) return;
    for (const c of this._clusters) {
      const ms = c.members;
      if (!ms || ms.length < 2) continue;
      let sum = 0, n = 0;
      for (const p of ms) {
        if (p.dead) continue;
        sum += p.energy;
        n++;
      }
      if (n < 2) continue;
      const mean = sum / n;
      for (const p of ms) {
        if (p.dead) continue;
        p.energy += (mean - p.energy) * RATE;
      }
    }
  }

  // ────────────────────────────────────────────────────────────── clusters

  // Union-find on the bond graph → list of bonded clusters. Throttled — runs
  // only every CLUSTER_INTERVAL ticks. Clusters with ≥ MIN_NAMED_CLUSTER
  // members get a generated name and centroid for the renderer's flag labels.
  _clusterBudKey(cluster) {
    if (!cluster) return 0;
    const root = cluster.organismRootId || cluster.anchorId || cluster.root || 0;
    const generation = Math.max(1, cluster.organismGeneration || 1);
    return `${root}:${generation}`;
  }

  _isOpenForBud(x, y) {
    const gx = clamp((x / CELL) | 0, 0, GW - 1);
    const gy = clamp((y / CELL) | 0, 0, GH - 1);
    const w = this.walls[gy * GW + gx];
    return w !== WALL_SOLID && w !== WALL_MEMBRANE;
  }

  _findBudPosition(x, y, spread = 18) {
    let bx = clamp(x, 1, W - 1);
    let by = clamp(y, 1, H - 1);
    if (this._isOpenForBud(bx, by)) return [bx, by];
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = spread * (0.35 + Math.random());
      bx = clamp(x + Math.cos(a) * r, 1, W - 1);
      by = clamp(y + Math.sin(a) * r, 1, H - 1);
      if (this._isOpenForBud(bx, by)) return [bx, by];
    }
    return [bx, by];
  }

  _linkBudChildren(a, b) {
    if (!a || !b || a === b) return;
    if (a.bonds.length >= MAX_BONDS || b.bonds.length >= MAX_BONDS) return;
    if (!a.bonds.includes(b.id)) a.bonds.push(b.id);
    if (!b.bonds.includes(a.id)) b.bonds.push(a.id);
  }

  _validBirthCluster(p) {
    const c = p && p.cluster;
    return c && Array.isArray(c.members) && c.members.includes(p) ? c : null;
  }

  _cellBirthIdentity(primary, secondary = null) {
    const cluster = this._validBirthCluster(primary) || this._validBirthCluster(secondary);
    if (cluster) {
      return {
        clustered: true,
        cluster,
        primary,
        secondary,
        rootId: cluster.organismRootId || primary?.organismRootId || primary?.id || secondary?.organismRootId || secondary?.id || 0,
        generation: Math.max(1, cluster.organismGeneration || primary?.organismGeneration || secondary?.organismGeneration || 1),
      };
    }
    return {
      clustered: false,
      cluster: null,
      primary,
      secondary,
      rootId: primary?.organismRootId || primary?.id || secondary?.organismRootId || secondary?.id || 0,
      generation: Math.max(1, primary?.organismGeneration || secondary?.organismGeneration || 1),
    };
  }

  _cellBirthAttachCandidates(identity) {
    if (!identity || !identity.clustered || !identity.cluster) return [];
    const out = [];
    const cluster = identity.cluster;
    const add = (p) => {
      if (!p || p.dead || !p.bonds || p.bonds.length >= MAX_BONDS) return;
      if (!cluster.members || !cluster.members.includes(p)) return;
      if (out.includes(p)) return;
      out.push(p);
    };
    add(identity.primary);
    if (identity.secondary && this._validBirthCluster(identity.secondary) === cluster) add(identity.secondary);
    const x = identity.primary?.x ?? cluster.cx ?? 0;
    const y = identity.primary?.y ?? cluster.cy ?? 0;
    const near = [];
    for (const m of cluster.members || []) {
      if (!m || m.dead || m === identity.primary || m === identity.secondary) continue;
      if (!m.bonds || m.bonds.length >= MAX_BONDS) continue;
      const dx = m.x - x;
      const dy = m.y - y;
      near.push({ p: m, d2: dx * dx + dy * dy });
    }
    near.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < near.length && out.length < 4; i++) add(near[i].p);
    return out;
  }

  _canAttachCellBirth(identity) {
    return !identity?.clustered || this._cellBirthAttachCandidates(identity).length > 0;
  }

  _attachCellBirthToOrganism(child, identity) {
    if (!identity || !identity.clustered || !child) return false;
    const candidates = this._cellBirthAttachCandidates(identity);
    const before = child.bonds.length;
    for (const anchor of candidates) {
      if (child.bonds.length >= 2) break;
      this._linkBudChildren(child, anchor);
    }
    const attached = child.bonds.length > before;
    if (attached) this.totalClusterCellBirths = (this.totalClusterCellBirths || 0) + 1;
    return attached;
  }

  _organismLineageStats() {
    const clusters = this._clusters || [];
    let descendantClusters = 0;
    let descendantParticles = 0;
    let maxOrganismGeneration = 1;
    for (const c of clusters) {
      if (!c) continue;
      const generation = Math.max(1, c.organismGeneration || 1);
      if (generation > maxOrganismGeneration) maxOrganismGeneration = generation;
      if (generation > 1) {
        descendantClusters++;
        descendantParticles += c.count || (c.members ? c.members.length : 0) || 0;
      }
    }
    return {
      descendantClusters,
      descendantParticles,
      maxOrganismGeneration,
      lastClusterBud: this.lastClusterBudInfo || null,
    };
  }

  _tryClusterBudding({ force = false } = {}) {
    if (!force && !this.clusterBudding) return 0;
    if (!force && this.tick % CLUSTER_BUD_INTERVAL !== 0) return 0;
    if (!force && this.clusterBudDiagnostics) this.clusterBudDiagnostics.intervals++;
    if (!this._clusters || this._clusters.length === 0) return 0;
    if (this.particles.length + CLUSTER_BUD_MIN_CHILDREN > this.maxParticles) {
      if (!force && this.clusterBudDiagnostics) this.clusterBudDiagnostics.slots++;
      return 0;
    }

    let bornTotal = 0;
    let budTotal = 0;
    for (const cluster of this._clusters) {
      if (this.particles.length + CLUSTER_BUD_MIN_CHILDREN > this.maxParticles) break;
      const born = this._budCluster(cluster, force);
      if (born > 0) {
        bornTotal += born;
        budTotal++;
        if (!force && this.clusterBudDiagnostics) this.clusterBudDiagnostics.budded++;
        if (!force) break; // one daughter organism per interval keeps growth bounded
      }
    }

    if (bornTotal > 0) {
      this.totalClusterBuds += budTotal;
      this.totalClusterBudParticles += bornTotal;
      this._brainsDirty = true;
      this._gpuStateDirty = true;
      this._gpuOrderVersion++;
      this._clustersTick = -10000;
      this.updateClusters();
    }
    return bornTotal;
  }

  _budCluster(cluster, force = false) {
    const diag = !force ? this.clusterBudDiagnostics : null;
    const block = (reason) => {
      if (diag && reason) diag[reason] = (diag[reason] || 0) + 1;
      return 0;
    };
    const members = (cluster.members || []).filter(p => p && !p.dead);
    if (members.length < CLUSTER_BUD_MIN_SIZE) return block('tooSmall');

    const memberIds = new Set(members.map(p => p.id));
    let energySum = 0;
    let ageSum = 0;
    let reproSum = 0;
    let bondSum = 0;
    let recentDamageSum = 0;
    for (const p of members) {
      energySum += p.energy || 0;
      ageSum += p.age || 0;
      reproSum += p.genome?.repro_thresh || 0;
      if (p.bonds) {
        for (const id of p.bonds) if (memberIds.has(id)) bondSum++;
      }
      const damageAge = this.tick - (p.lastDamageTick || -9999);
      if (damageAge >= 0 && damageAge < 40) {
        recentDamageSum += (p.recentDamage || 0) * Math.pow(DAMAGE_SENSOR_DECAY, damageAge);
      }
    }
    const n = members.length;
    const meanEnergy = energySum / n;
    const meanAge = ageSum / n;
    const meanRepro = reproSum / n;
    const meanBonds = bondSum / n;
    const key = this._clusterBudKey(cluster);
    const lastBud = this._clusterBudLastTick.get(key) ?? -999999;
    const childGeneration = Math.max(1, cluster.organismGeneration || 1) + 1;
    const childRootId = cluster.organismRootId || cluster.anchorId || cluster.root || 0;

    if (!force) {
      if (diag) diag.checked++;
      if (this.tick - lastBud < CLUSTER_BUD_COOLDOWN) return block('cooldown');
      if (meanAge < CLUSTER_BUD_MIN_MEAN_AGE) return block('age');
      if (meanBonds < CLUSTER_BUD_MIN_MEAN_BONDS) return block('bonds');
      const energyGate = Math.max(CLUSTER_BUD_MIN_MEAN_ENERGY, meanRepro * 1.15);
      if (meanEnergy < energyGate) return block('energy');
      if (diag) diag.eligible++;

      const readiness = Math.min(CLUSTER_BUD_READINESS_MAX, this._clusterBudReadiness.get(key) || 0);
      const cohesionBonus = clamp((meanBonds - CLUSTER_BUD_MIN_MEAN_BONDS) / 1.6, 0, 1);
      const ageBonus = clamp((meanAge - CLUSTER_BUD_MIN_MEAN_AGE) / 720, 0, 1);
      const energyBonus = clamp((meanEnergy - energyGate) / Math.max(1, energyGate), 0, 1);
      const damagePenalty = clamp((recentDamageSum / n) / 2.5, 0, 0.65);
      const chance = Math.min(
        CLUSTER_BUD_PROB_MAX,
        CLUSTER_BUD_PROB * (1 + readiness * 0.55 + cohesionBonus * 0.75 + ageBonus * 0.45 + energyBonus * 0.55) *
          (1 - damagePenalty),
      );
      if (Math.random() >= chance) {
        this._clusterBudReadiness.set(key, Math.min(CLUSTER_BUD_READINESS_MAX, readiness + 1));
        return block('chance');
      }
    }

    const donors = members
      .filter(p => (p.energy || 0) - clusterBudEnergyCost(p, meanRepro) >= CLUSTER_BUD_PARENT_FLOOR)
      .sort((a, b) => Math.atan2(a.y - cluster.cy, a.x - cluster.cx) -
                      Math.atan2(b.y - cluster.cy, b.x - cluster.cx));
    const slots = this.maxParticles - this.particles.length;
    const targetCount = Math.min(
      slots,
      donors.length,
      CLUSTER_BUD_MAX_CHILDREN,
      Math.max(CLUSTER_BUD_MIN_CHILDREN, Math.round(n * 0.45)),
    );
    if (targetCount < CLUSTER_BUD_MIN_CHILDREN) return block(slots < CLUSTER_BUD_MIN_CHILDREN ? 'slots' : 'donors');

    const selected = [];
    const used = new Set();
    const stride = donors.length / targetCount;
    const offset = Math.floor(Math.random() * Math.max(1, stride));
    for (let i = 0; i < targetCount; i++) {
      const donor = donors[Math.min(donors.length - 1, Math.floor(i * stride + offset))];
      if (!donor || used.has(donor.id)) continue;
      selected.push(donor);
      used.add(donor.id);
    }
    if (selected.length < CLUSTER_BUD_MIN_CHILDREN) return block('donors');

    let dirX = 0, dirY = 0;
    for (const p of selected) {
      dirX += p.x - cluster.cx;
      dirY += p.y - cluster.cy;
    }
    let len = Math.hypot(dirX, dirY);
    if (len < 0.001) {
      const a = Math.random() * Math.PI * 2;
      dirX = Math.cos(a);
      dirY = Math.sin(a);
    } else {
      dirX /= len;
      dirY /= len;
    }

    const budCx = clamp(cluster.cx + dirX * (cluster.radius + 22 + Math.random() * 10), 1, W - 1);
    const budCy = clamp(cluster.cy + dirY * (cluster.radius + 22 + Math.random() * 10), 1, H - 1);
    const children = [];
    const parentToChild = new Map();
    for (const parent of selected) {
      const childEnergy = clusterBudChildEnergy(parent, meanRepro);
      const giftCost = offspringCostForEndowment(childEnergy, CLUSTER_BUD_TAX);
      if (parent.energy - giftCost < CLUSTER_BUD_PARENT_FLOOR) continue;
      const relX = (parent.x - cluster.cx) * 0.7;
      const relY = (parent.y - cluster.cy) * 0.7;
      const [x, y] = this._findBudPosition(
        budCx + relX + (Math.random() - 0.5) * 4,
        budCy + relY + (Math.random() - 0.5) * 4,
        Math.max(12, cluster.radius * 0.5),
      );
      const clade = this.clades.clades.get(parent.cladeId) || null;
      const childGenome = mutate(parent.genome, Math.random, CLUSTER_BUD_MUTATION_BOOST);
      const child = this.addParticle(x, y, childGenome, childEnergy, clade);
      if (!child) continue;
      parent.energy -= giftCost;
      child.lineage = parent.lineage;
      child.organismRootId = childRootId;
      child.organismGeneration = childGeneration;
      child.vx = parent.vx * 0.25 + dirX * 0.35 + (Math.random() - 0.5) * 0.18;
      child.vy = parent.vy * 0.25 + dirY * 0.35 + (Math.random() - 0.5) * 0.18;
      children.push(child);
      parentToChild.set(parent.id, child);
    }

    if (children.length < CLUSTER_BUD_MIN_CHILDREN) {
      for (const child of children) child.dead = true;
      return block('donors');
    }

    let inheritedLinks = 0;
    for (const parent of selected) {
      const child = parentToChild.get(parent.id);
      if (!child) continue;
      for (const partnerId of parent.bonds || []) {
        const partnerChild = parentToChild.get(partnerId);
        if (!partnerChild || partnerChild.id <= child.id) continue;
        const before = child.bonds.length + partnerChild.bonds.length;
        this._linkBudChildren(child, partnerChild);
        if (child.bonds.length + partnerChild.bonds.length > before) inheritedLinks++;
      }
    }
    for (let i = 0; i < children.length; i++) {
      this._linkBudChildren(children[i], children[(i + 1) % children.length]);
    }
    if (children.length >= 6) {
      for (let i = 0; i < children.length; i++) {
        this._linkBudChildren(children[i], children[(i + 2) % children.length]);
      }
    }
    this._clusterBudLastTick.set(key, this.tick);
    this._clusterBudReadiness.delete(key);
    const genLabel = organismGenerationSuffix(childGeneration).trim() || `gen ${childGeneration}`;
    const parentName = cluster.name || 'cluster';
    this.lastClusterBudInfo = {
      tick: this.tick,
      parentName,
      generation: childGeneration,
      generationLabel: genLabel,
      size: children.length,
      rootId: childRootId,
      inheritedLinks,
    };
    if (this.clades) {
      this.clades.pushEvent(this.tick, 'organism',
        `${genLabel} organism budded from ${parentName} - ${children.length} cells`,
        '#a78bfa');
    }
    return children.length;
  }

  _updateClusterMessageBus() {
    if (!this._clusters || this._clusters.length === 0) {
      this._clusterBus.clear();
      return;
    }
    const nextBus = new Map();
    for (const c of this._clusters) {
      const key = c.anchorId || c.root || 0;
      const prev = this._clusterBus.get(key) || { r: 0, g: 0, b: 0 };
      const gain = 1 + (c.topology || 0) * CLUSTER_MSG_TOPOLOGY_GAIN;
      const freshR = Math.tanh(salientMessageMean(c.members, 'bondMsgR') * gain);
      const freshG = Math.tanh(salientMessageMean(c.members, 'bondMsgG') * gain);
      const freshB = Math.tanh(salientMessageMean(c.members, 'bondMsgB') * gain);
      const carry = (old, fresh) => {
        const decayed = old * CLUSTER_MSG_DECAY;
        return Math.abs(fresh) >= Math.abs(decayed) ? fresh : decayed;
      };
      const r = carry(prev.r || 0, freshR);
      const g = carry(prev.g || 0, freshG);
      const b = carry(prev.b || 0, freshB);
      c.busR = r;
      c.busG = g;
      c.busB = b;
      nextBus.set(key, { r, g, b });
    }
    this._clusterBus = nextBus;
  }

  _updateClusterMotorConsensus() {
    if (!this._clusters || this._clusters.length === 0) return;
    for (const c of this._clusters) {
      let sx = 0, sy = 0, effort = 0, n = 0;
      for (const p of c.members || []) {
        if (!p || p.dead) continue;
        const mx = p.lastMotorX || 0;
        const my = p.lastMotorY || 0;
        const e = Math.min(1, Math.hypot(mx, my));
        if (e <= 1e-4) continue;
        sx += mx;
        sy += my;
        effort += e;
        n++;
      }
      if (n <= 0 || effort <= 1e-4) {
        c.motorX = 0;
        c.motorY = 0;
        c.motorConsensus = 0;
        continue;
      }
      const meanX = sx / n;
      const meanY = sy / n;
      c.motorX = clamp(meanX, -1, 1);
      c.motorY = clamp(meanY, -1, 1);
      c.motorConsensus = clamp(Math.hypot(sx, sy) / effort, 0, 1);
    }
  }

  _updateClusterFieldConsensus() {
    if (!this._clusters || this._clusters.length === 0) return;
    for (const c of this._clusters) {
      let sx = 0, sy = 0, n = 0;
      for (const p of c.members || []) {
        if (!p || p.dead) continue;
        sx += p.lastLongFieldX || 0;
        sy += p.lastLongFieldY || 0;
        n++;
      }
      if (n <= 0) {
        c.fieldX = 0;
        c.fieldY = 0;
        c.fieldStrength = 0;
        continue;
      }
      const fx = sx / n;
      const fy = sy / n;
      const strength = Math.min(1, Math.hypot(fx, fy));
      c.fieldX = clamp(fx, -1, 1);
      c.fieldY = clamp(fy, -1, 1);
      c.fieldStrength = strength;
    }
  }

  updateClusters() {
    const CLUSTER_INTERVAL = 12;
    const MIN_NAMED_CLUSTER = 8;
    if (this.tick - this._clustersTick < CLUSTER_INTERVAL) return;
    this._clustersTick = this.tick;

    const ps = this.particles;
    for (const p of ps) p.cluster = null;
    // Union-find via Map (sparse particle ids)
    const parent = new Map();
    const rankMap = new Map();
    for (const p of ps) {
      if (p.dead) continue;
      parent.set(p.id, p.id);
      rankMap.set(p.id, 0);
    }
    function find(x) {
      let cur = x;
      while (parent.get(cur) !== cur) cur = parent.get(cur);
      // Path compression
      let n = x;
      while (parent.get(n) !== cur) {
        const next = parent.get(n);
        parent.set(n, cur);
        n = next;
      }
      return cur;
    }
    function union(a, b) {
      const ra = find(a), rb = find(b);
      if (ra === rb) return;
      const rka = rankMap.get(ra), rkb = rankMap.get(rb);
      if (rka < rkb) parent.set(ra, rb);
      else if (rka > rkb) parent.set(rb, ra);
      else { parent.set(rb, ra); rankMap.set(ra, rka + 1); }
    }
    for (const p of ps) {
      if (p.dead || !p.bonds || p.bonds.length === 0) continue;
      for (const partnerId of p.bonds) {
        if (parent.has(partnerId)) union(p.id, partnerId);
      }
    }

    // Build groups: root → [particle]
    const groups = new Map();
    for (const p of ps) {
      if (p.dead) continue;
      const r = find(p.id);
      let g = groups.get(r);
      if (!g) { g = []; groups.set(r, g); }
      g.push(p);
    }

    // Form clusters with names
    const clusters = [];
    const memberMap = this._particleToCluster;
    memberMap.clear();
    const usedHumanNames = new Set();
    const prevMotion = this._clusterMotion || new Map();
    const nextMotion = new Map();
    for (const [root, members] of groups) {
      if (members.length < MIN_NAMED_CLUSTER) continue;
      let cx = 0, cy = 0;
      const cladeCount = new Map();
      const organismCount = new Map();
      let smallestId = Infinity;
      for (const p of members) {
        cx += p.x;
        cy += p.y;
        cladeCount.set(p.cladeId, (cladeCount.get(p.cladeId) || 0) + 1);
        const organismRoot = p.organismRootId || p.id;
        const organismGeneration = Math.max(1, p.organismGeneration || 1);
        const organismKey = `${organismRoot}:${organismGeneration}`;
        organismCount.set(organismKey, (organismCount.get(organismKey) || 0) + 1);
        if (p.id < smallestId) smallestId = p.id;
      }
      cx /= members.length;
      cy /= members.length;
      let spreadSum = 0, maxR2 = 0;
      const memberIds = new Set(members.map(p => p.id));
      let internalBondRefs = 0;
      let contactX = 0, contactY = 0, slipSum = 0;
      let motorXSum = 0, motorYSum = 0, motorEffortSum = 0;
      let fieldXSum = 0, fieldYSum = 0;
      for (const p of members) {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const d2 = dx * dx + dy * dy;
        spreadSum += Math.sqrt(d2);
        if (d2 > maxR2) maxR2 = d2;
        contactX += p.lastHardContactX || 0;
        contactY += p.lastHardContactY || 0;
        slipSum += p.lastMotorSlip || 0;
        const motorX = p.lastMotorX || 0;
        const motorY = p.lastMotorY || 0;
        const motorEffort = Math.min(1, Math.hypot(motorX, motorY));
        motorXSum += motorX;
        motorYSum += motorY;
        motorEffortSum += motorEffort;
        fieldXSum += p.lastLongFieldX || 0;
        fieldYSum += p.lastLongFieldY || 0;
        for (const partnerId of p.bonds || []) {
          if (memberIds.has(partnerId)) internalBondRefs++;
        }
      }
      const internalBonds = internalBondRefs * 0.5;
      const meanInternalBonds = internalBondRefs / Math.max(1, members.length);
      const topologyDenom = Math.max(0.001, Math.min(MAX_BONDS, members.length - 1) - 1.5);
      const topology = clamp((meanInternalBonds - 1.5) / topologyDenom, 0, 1);
      // Dominant clade
      let topClade = -1, topCount = 0;
      for (const [cid, cnt] of cladeCount) {
        if (cnt > topCount) { topCount = cnt; topClade = cid; }
      }
      let topOrganismRoot = smallestId;
      let topOrganismGeneration = 1;
      let topOrganismCount = 0;
      for (const [okey, cnt] of organismCount) {
        if (cnt <= topOrganismCount) continue;
        const [rootId, generation] = okey.split(':');
        topOrganismRoot = Number(rootId) || smallestId;
        topOrganismGeneration = Math.max(1, Number(generation) || 1);
        topOrganismCount = cnt;
      }
      const clade = this.clades.clades.get(topClade);
      const baseName = clade ? clade.name : `cluster`;
      const isMixed = topCount < members.length;
      let displayBase = uniqueClusterDisplayName(clusterDisplayName(baseName), usedHumanNames, smallestId);
      const generationSuffix = organismGenerationSuffix(topOrganismGeneration);
      displayBase += generationSuffix;
      const name = `${displayBase} ×${members.length}`;
      const motionKey = smallestId;
      const prev = prevMotion.get(motionKey);
      const prevBus = this._clusterBus.get(motionKey) || { r: 0, g: 0, b: 0 };
      const dt = prev ? Math.max(1, this.tick - prev.tick) : 0;
      const clusterVx = dt ? clamp(((cx - prev.cx) / dt) / MAX_V, -1, 1) : 0;
      const clusterVy = dt ? clamp(((cy - prev.cy) / dt) / MAX_V, -1, 1) : 0;
      const invCount = 1 / Math.max(1, members.length);
      const meanContactX = clamp(contactX * invCount, -1, 1);
      const meanContactY = clamp(contactY * invCount, -1, 1);
      const meanSlip = clamp(slipSum * invCount, 0, 1);
      const meanMotorX = clamp(motorXSum * invCount, -1, 1);
      const meanMotorY = clamp(motorYSum * invCount, -1, 1);
      const motorConsensus = motorEffortSum > 1e-4
        ? clamp(Math.hypot(motorXSum, motorYSum) / motorEffortSum, 0, 1)
        : 0;
      const meanFieldX = clamp(fieldXSum * invCount, -1, 1);
      const meanFieldY = clamp(fieldYSum * invCount, -1, 1);
      const fieldStrength = Math.min(1, Math.hypot(meanFieldX, meanFieldY));
      nextMotion.set(motionKey, { cx, cy, tick: this.tick });
      const cluster = {
        root,
        anchorId: smallestId,
        organismRootId: topOrganismRoot,
        organismGeneration: topOrganismGeneration,
        organismGenerationSuffix: generationSuffix.trim(),
        count: members.length,
        members,                  // actual particle refs — used by chase highlight
        cx, cy,
        vx: clusterVx,
        vy: clusterVy,
        contactX: meanContactX,
        contactY: meanContactY,
        slip: meanSlip,
        motorX: meanMotorX,
        motorY: meanMotorY,
        motorConsensus,
        fieldX: meanFieldX,
        fieldY: meanFieldY,
        fieldStrength,
        busR: prevBus.r || 0,
        busG: prevBus.g || 0,
        busB: prevBus.b || 0,
        radius: Math.max(8, Math.sqrt(maxR2)),
        spread: spreadSum / members.length,
        internalBonds,
        meanInternalBonds,
        topology,
        name,
        baseName,
        isMixed,
        species: clade?.species ?? 0,
      };
      clusters.push(cluster);
      for (const p of members) {
        p.cluster = cluster;
        memberMap.set(p.id, cluster);
      }
    }
    // Sort by size descending — renderer caps how many flags it draws
    clusters.sort((a, b) => b.count - a.count);
    this._clusters = clusters;
    this._clusterMotion = nextMotion;
  }

  clearWallMeta(idx) {
    this.wallOwnerId[idx] = 0;
    this.wallOwnerClusterId[idx] = 0;
    this.wallOwnerCladeId[idx] = 0;
    this.wallOwnerTick[idx] = 0;
  }

  setWallMeta(idx, p) {
    const cluster = p.cluster;
    this.wallOwnerId[idx] = p.id;
    this.wallOwnerClusterId[idx] = cluster ? cluster.anchorId : 0;
    this.wallOwnerCladeId[idx] = p.cladeId || 0;
    this.wallOwnerTick[idx] = this.tick;
  }

  wallInfoAt(gx, gy) {
    if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return null;
    const idx = gy * GW + gx;
    const type = this.walls[idx];
    if (!type) return null;
    const ownerId = this.wallOwnerId[idx] || 0;
    const owner = ownerId ? this.particles.find(p => p.id === ownerId && !p.dead) || null : null;
    const clusterAnchorId = this.wallOwnerClusterId[idx] || 0;
    const cluster = clusterAnchorId
      ? (this._clusters || []).find(c => c.anchorId === clusterAnchorId) || null
      : null;
    return {
      idx, gx, gy, type,
      ownerId,
      ownerAlive: !!owner,
      clusterAnchorId,
      clusterName: cluster ? cluster.name : null,
      clusterAlive: !!cluster,
      cladeId: this.wallOwnerCladeId[idx] || 0,
      depositedTick: this.wallOwnerTick[idx] || 0,
    };
  }

  // ────────────────────────────────────────────────────────────── stats

  // Snapshot of energy / food / death dynamics for the diagnostics readout.
  // Called from the UI at ~6 Hz; cheap relative to a step.
  vitals() {
    const ps = this.particles;
    let eSum = 0, eMin = Infinity, eMax = -Infinity, lowN = 0, carrying = 0;
    let shelterSum = 0, shelteredN = 0;
    let speedSum = 0, speedCapFracSum = 0, motorEffortSum = 0, highSpeedN = 0;
    const lowThresh = 1.0;
    let alive = 0;
    for (const p of ps) {
      if (p.dead) continue;
      alive++;
      eSum += p.energy;
      if ((p.wallCarry || 0) > 0) carrying++;
      const shelter = p.shelterRelief || 0;
      shelterSum += shelter;
      if (shelter > 0) shelteredN++;
      const sp = Math.hypot(p.vx || 0, p.vy || 0);
      const cap = MAX_V * (0.5 + Math.min(1, (p.energy || 0) * 0.15) * 0.5);
      const frac = cap > 0 ? sp / cap : 0;
      speedSum += sp;
      speedCapFracSum += frac;
      motorEffortSum += Math.min(1, Math.hypot(p.lastMotorX || 0, p.lastMotorY || 0));
      if (frac > 0.8) highSpeedN++;
      if (p.energy < lowThresh) lowN++;
      if (p.energy < eMin) eMin = p.energy;
      if (p.energy > eMax) eMax = p.energy;
    }
    const meanEnergy = alive ? eSum / alive : 0;
    const lowFrac = alive ? lowN / alive : 0;
    // Field means — sample with stride for speed
    const f0 = this.field[0], f1 = this.field[1];
    let fSum = 0, dSum = 0, n = 0;
    const stride = 8;
    for (let i = 0; i < f0.length; i += stride) {
      fSum += f0[i];
      dSum += f1[i];
      n++;
    }
    const meanFood = n ? fSum / n : 0;
    const meanDecay = n ? dSum / n : 0;
    return {
      alive,
      meanEnergy,
      meanSpeed: alive ? speedSum / alive : 0,
      meanSpeedCapFrac: alive ? speedCapFracSum / alive : 0,
      meanMotorEffort: alive ? motorEffortSum / alive : 0,
      highSpeedFrac: alive ? highSpeedN / alive : 0,
      eMin: alive ? eMin : 0,
      eMax: alive ? eMax : 0,
      lowFrac,
      meanFood,
      meanDecay,
      walls: this._wallCount,
      wallDigs: this.totalWallDigs,
      wallDeposits: this.totalWallDeposits,
      wallCarriers: carrying,
      fieldFoodEaten: this.totalFieldFoodEaten || 0,
      fieldEnergyGain: this.totalFieldEnergyGain || 0,
      clusterBuds: this.totalClusterBuds || 0,
      clusterBudParticles: this.totalClusterBudParticles || 0,
      clusterCellBirths: this.totalClusterCellBirths || 0,
      clusterBudReserve: this.maxParticles - this._cellBirthLimit(),
      clusterBudDiagnostics: { ...(this.clusterBudDiagnostics || newClusterBudDiagnostics()) },
      ...this._organismLineageStats(),
      predationEvents: this.totalPredationEvents || 0,
      predationDrain: this.totalPredationDrain || 0,
      predationEnergyGain: this.totalPredationEnergyGain || 0,
      predationFatalDrains: this.totalPredationFatalDrains || 0,
      predationDeaths: this.totalPredationDeaths || 0,
      combatMode: this.combatMode || 'nibble',
      combatContacts: this.totalCombatContacts || 0,
      combatAttacks: this.totalCombatAttacks || 0,
      combatKills: this.totalCombatKills || 0,
      combatCounters: this.totalCombatCounters || 0,
      combatEscapes: this.totalCombatEscapes || 0,
      combatFailedCost: this.totalCombatFailedCost || 0,
      meanShelter: alive ? shelterSum / alive : 0,
      shelteredFrac: alive ? shelteredN / alive : 0,
    };
  }

  populationBySpecies() {
    const counts = new Array(NUM_SPECIES).fill(0);
    for (const p of this.particles) counts[p.genome.species]++;
    return counts;
  }

  meanGenome() {
    const acc = {
      attraction: new Float32Array(NUM_SPECIES),
      sense: new Float32Array(NUM_CHEM),
      cohesion: 0, metab: 0, efficiency: 0,
      repro_thresh: 0, mut_rate: 0, sense_radius: 0,
    };
    const n = this.particles.length || 1;
    for (const p of this.particles) {
      const g = p.genome;
      for (let i = 0; i < NUM_SPECIES; i++) acc.attraction[i] += g.attraction[i];
      for (let i = 0; i < NUM_CHEM; i++) acc.sense[i] += g.sense[i];
      acc.cohesion += g.cohesion;
      acc.metab += g.metab;
      acc.efficiency += g.efficiency;
      acc.repro_thresh += g.repro_thresh;
      acc.mut_rate += g.mut_rate;
      acc.sense_radius += g.sense_radius;
    }
    for (let i = 0; i < NUM_SPECIES; i++) acc.attraction[i] /= n;
    for (let i = 0; i < NUM_CHEM; i++) acc.sense[i] /= n;
    acc.cohesion /= n; acc.metab /= n; acc.efficiency /= n;
    acc.repro_thresh /= n; acc.mut_rate /= n; acc.sense_radius /= n;
    return acc;
  }

  pickParticleAt(x, y, radius = 8) {
    const r2 = radius * radius;
    let best = null, bd2 = r2;
    for (const p of this.particles) {
      const dx = p.x - x, dy = p.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd2) { bd2 = d2; best = p; }
    }
    return best;
  }

  // ────────────────────────────────────────────────────────────── persistence

  toJSON() {
    const wallMeta = [];
    for (let i = 0; i < this.walls.length; i++) {
      if (!this.walls[i]) continue;
      const ownerId = this.wallOwnerId[i] || 0;
      const tick = this.wallOwnerTick[i] || 0;
      if (!ownerId && !tick) continue;
      wallMeta.push([
        i,
        ownerId,
        this.wallOwnerClusterId[i] || 0,
        this.wallOwnerCladeId[i] || 0,
        tick,
      ]);
    }
    return {
      version: 2,
      tick: this.tick,
      maxParticles: this.maxParticles,
      walls: Array.from(this.walls),
      habitatRegions: this.habitatRegions || [],
      field0: Array.from(this.field[0]),
      field1: Array.from(this.field[1]),
      mutagen: Array.from(this.mutagen),
      totalWallDigs: this.totalWallDigs,
      totalWallDeposits: this.totalWallDeposits,
      totalClusterBuds: this.totalClusterBuds || 0,
      totalClusterBudParticles: this.totalClusterBudParticles || 0,
      totalClusterCellBirths: this.totalClusterCellBirths || 0,
      lastClusterBudInfo: this.lastClusterBudInfo || null,
      clusterBudDiagnostics: { ...(this.clusterBudDiagnostics || newClusterBudDiagnostics()) },
      totalFieldFoodEaten: this.totalFieldFoodEaten || 0,
      totalFieldEnergyGain: this.totalFieldEnergyGain || 0,
      totalPredationEvents: this.totalPredationEvents || 0,
      totalPredationDrain: this.totalPredationDrain || 0,
      totalPredationEnergyGain: this.totalPredationEnergyGain || 0,
      totalPredationFatalDrains: this.totalPredationFatalDrains || 0,
      totalPredationDeaths: this.totalPredationDeaths || 0,
      combatMode: this.combatMode || 'nibble',
      totalCombatContacts: this.totalCombatContacts || 0,
      totalCombatOneSidedContacts: this.totalCombatOneSidedContacts || 0,
      totalCombatMutualContacts: this.totalCombatMutualContacts || 0,
      totalCombatAttacks: this.totalCombatAttacks || 0,
      totalCombatKills: this.totalCombatKills || 0,
      totalCombatCounters: this.totalCombatCounters || 0,
      totalCombatEscapes: this.totalCombatEscapes || 0,
      totalCombatInjuries: this.totalCombatInjuries || 0,
      totalCombatFailedCost: this.totalCombatFailedCost || 0,
      wallMeta,
      clades: this.clades.toJSON(),
      particles: this.particles.map(p => ({
        id: p.id,
        x: p.x, y: p.y, vx: p.vx, vy: p.vy,
        energy: p.energy, age: p.age, lineage: p.lineage,
        cladeId: p.cladeId,
        bonds: p.bonds.slice(),
        wallCarry: p.wallCarry || 0,
        shelterRelief: p.shelterRelief || 0,
        wallDigs: p.wallDigs || 0,
        wallDeposits: p.wallDeposits || 0,
        predationEvents: p.predationEvents || 0,
        predationDrain: p.predationDrain || 0,
        predationEnergyGain: p.predationEnergyGain || 0,
        predationFatalDrains: p.predationFatalDrains || 0,
        predationKills: p.predationKills || 0,
        fieldFoodEaten: p.fieldFoodEaten || 0,
        fieldEnergyGain: p.fieldEnergyGain || 0,
        combatAttacks: p.combatAttacks || 0,
        combatKills: p.combatKills || 0,
        combatCounters: p.combatCounters || 0,
        combatEscapes: p.combatEscapes || 0,
        combatFailedCost: p.combatFailedCost || 0,
        combatDamageDealt: p.combatDamageDealt || 0,
        combatDamageTaken: p.combatDamageTaken || 0,
        lastAttackTick: p.lastAttackTick || -9999,
        lastAttackFlashTick: p.lastAttackFlashTick || -9999,
        recentDamage: p.recentDamage || 0,
        damageDirX: p.damageDirX || 0,
        damageDirY: p.damageDirY || 0,
        lastDamageTick: p.lastDamageTick || -9999,
        genome: genomeToJSON(p.genome),
      })),
    };
  }

  toWorldTemplateJSON() {
    return {
      kind: 'primordia.world-template.v1',
      version: 1,
      gw: GW,
      gh: GH,
      cell: CELL,
      walls: Array.from(this.walls),
      habitatRegions: this.habitatRegions || [],
      field0: Array.from(this.field[0], v => +v.toFixed(4)),
      field1: Array.from(this.field[1], v => +v.toFixed(4)),
      mutagen: Array.from(this.mutagen, v => +v.toFixed(4)),
      wallCount: this._wallCount || 0,
      note: 'Sterile terrain/field template; contains no particles or clades.',
    };
  }

  fromWorldTemplateJSON(data) {
    const template = data && data.kind === 'primordia.world-template.v1' ? data : (data && data.template);
    if (!template || template.gw !== GW || template.gh !== GH || template.cell !== CELL) {
      throw new Error('World template dimensions do not match this simulator build');
    }
    this.reset();
    this.habitatRegions = Array.isArray(template.habitatRegions)
      ? template.habitatRegions.map(r => ({ ...r }))
      : [];
    if (template.walls) this.walls.set(template.walls);
    if (template.field0) this.field[0].set(template.field0);
    if (template.field1) {
      this.field[1].set(template.field1);
      this._decayActive = arrayHasPositive(this.field[1]);
    }
    if (template.mutagen) {
      this.mutagen.set(template.mutagen);
      this._mutagenActive = arrayHasPositive(this.mutagen);
    }
    let wc = 0;
    for (let i = 0; i < this.walls.length; i++) if (this.walls[i]) wc++;
    this._wallCount = wc;
    this._wallsVersion++;
    this._clusters = [];
    this._clustersTick = -10000;
    this._particleToCluster.clear();
    this._clusterNames.clear();
    this._brainsDirty = true;
    this._gpuStateDirty = true;
  }

  fromJSON(data) {
    this.reset();
    this.tick = data.tick || 0;
    if (data.maxParticles) this.setMaxParticles(data.maxParticles | 0);
    if (data.walls) {
      this.walls.set(data.walls);
      let wc = 0;
      for (let i = 0; i < this.walls.length; i++) if (this.walls[i]) wc++;
      this._wallCount = wc;
    }
    this.habitatRegions = Array.isArray(data.habitatRegions)
      ? data.habitatRegions.map(r => ({ ...r }))
      : [];
    if (data.field0) this.field[0].set(data.field0);
    if (data.field1) {
      this.field[1].set(data.field1);
      this._decayActive = arrayHasPositive(this.field[1]);
    }
    if (data.mutagen) {
      this.mutagen.set(data.mutagen);
      this._mutagenActive = arrayHasPositive(this.mutagen);
    }
    this.totalWallDigs = data.totalWallDigs || 0;
    this.totalWallDeposits = data.totalWallDeposits || 0;
    this.totalClusterBuds = data.totalClusterBuds || 0;
    this.totalClusterBudParticles = data.totalClusterBudParticles || 0;
    this.totalClusterCellBirths = data.totalClusterCellBirths || 0;
    this.lastClusterBudInfo = data.lastClusterBudInfo || null;
    this.clusterBudDiagnostics = { ...newClusterBudDiagnostics(), ...(data.clusterBudDiagnostics || {}) };
    this.totalFieldFoodEaten = data.totalFieldFoodEaten || 0;
    this.totalFieldEnergyGain = data.totalFieldEnergyGain || 0;
    this.totalPredationEvents = data.totalPredationEvents || 0;
    this.totalPredationDrain = data.totalPredationDrain || 0;
    this.totalPredationEnergyGain = data.totalPredationEnergyGain || 0;
    this.totalPredationFatalDrains = data.totalPredationFatalDrains || 0;
    this.totalPredationDeaths = data.totalPredationDeaths || 0;
    this.combatMode = data.combatMode || this.combatMode || 'nibble';
    this.totalCombatContacts = data.totalCombatContacts || 0;
    this.totalCombatOneSidedContacts = data.totalCombatOneSidedContacts || 0;
    this.totalCombatMutualContacts = data.totalCombatMutualContacts || 0;
    this.totalCombatAttacks = data.totalCombatAttacks || 0;
    this.totalCombatKills = data.totalCombatKills || 0;
    this.totalCombatCounters = data.totalCombatCounters || 0;
    this.totalCombatEscapes = data.totalCombatEscapes || 0;
    this.totalCombatInjuries = data.totalCombatInjuries || 0;
    this.totalCombatFailedCost = data.totalCombatFailedCost || 0;
    if (Array.isArray(data.wallMeta)) {
      for (const row of data.wallMeta) {
        const idx = row[0] | 0;
        if (idx < 0 || idx >= this.walls.length) continue;
        this.wallOwnerId[idx] = row[1] | 0;
        this.wallOwnerClusterId[idx] = row[2] | 0;
        this.wallOwnerCladeId[idx] = row[3] | 0;
        this.wallOwnerTick[idx] = row[4] | 0;
      }
    }
    if (data.clades) this.clades.fromJSON(data.clades);
    this._brainsDirty = true;
    this._gpuStateDirty = true;
    for (const op of (data.particles || [])) {
      const loadedGenome = genomeFromJSON(op.genome);
      const loadedId = op.id || (++_id);
      if (loadedId > _id) _id = loadedId;
      const p = {
        id: loadedId,
        x: op.x, y: op.y, vx: op.vx, vy: op.vy,
        genome: loadedGenome,
        species: loadedGenome.species,
        energy: op.energy, age: op.age,
        lineage: op.lineage ?? (++_lineage),
        cladeId: op.cladeId ?? 0,
        signalR: 0, signalG: 0, signalB: 0,
        predationGain: 0,
        predationEvents: op.predationEvents || 0,
        predationDrain: op.predationDrain || 0,
        predationEnergyGain: op.predationEnergyGain || 0,
        predationFatalDrains: op.predationFatalDrains || 0,
        predationKills: op.predationKills || 0,
        fieldFoodEaten: op.fieldFoodEaten || 0,
        fieldEnergyGain: op.fieldEnergyGain || 0,
        combatAttacks: op.combatAttacks || 0,
        combatKills: op.combatKills || 0,
        combatCounters: op.combatCounters || 0,
        combatEscapes: op.combatEscapes || 0,
        combatFailedCost: op.combatFailedCost || 0,
        combatDamageDealt: op.combatDamageDealt || 0,
        combatDamageTaken: op.combatDamageTaken || 0,
        lastPredatorId: 0,
        lastPredationTick: -9999,
        lastAttackTick: op.lastAttackTick || -9999,
        lastAttackFlashTick: op.lastAttackFlashTick || -9999,
        recentDamage: op.recentDamage || 0,
        damageDirX: op.damageDirX || 0,
        damageDirY: op.damageDirY || 0,
        lastDamageTick: op.lastDamageTick || -9999,
        soundCh: 0, soundAmp: 0,
        wantBond: 0, wantMate: 0,
        bondMsgR: 0.5, bondMsgG: 0.5, bondMsgB: 0.5,
        incomingBondMsgR: 0, incomingBondMsgG: 0, incomingBondMsgB: 0,
        wallCarry: op.wallCarry || 0,
        shelterRelief: op.shelterRelief || 0,
        wallDigs: op.wallDigs || 0,
        wallDeposits: op.wallDeposits || 0,
        lastLongFieldX: 0, lastLongFieldY: 0,
        cluster: null,
        bonds: Array.isArray(op.bonds) ? op.bonds.slice() : [],
        dead: false,
      };
      this.particles.push(p);
      // If no clades data was provided (old save), register as fresh clade
      if (!data.clades) this.clades.registerNewParticle(p, null, this.tick);
    }
    this.setMaxParticles(this.maxParticles);
  }
}

// ─────────────────────────────────────────────────────────────── helpers

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function arrayHasPositive(a) {
  for (let i = 0; i < a.length; i++) if (a[i] > 1e-5) return true;
  return false;
}

// Maps brain output → [0,1] via sigmoid (smooth gate)
function sigmoid01(x) { return 1 / (1 + Math.exp(-x)); }

// Fast 5-point (von Neumann) diffuse + multiplicative decay. Walls handled
// post-pass in step() — keeping this loop tight and branch-free.
function diffuseAndDecay(f, d, dec, cap, trackActive = false) {
  if (!diffuseAndDecay._scratch || diffuseAndDecay._scratch.length !== f.length) {
    diffuseAndDecay._scratch = new Float32Array(f.length);
  }
  const out = diffuseAndDecay._scratch;
  const w = GW, h = GH;
  const keep = (1 - d) * (1 - dec);
  const share = (d * 0.25) * (1 - dec);
  let active = false;

  // Interior cells (vectorisable hot loop)
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const v = f[i] * keep + (f[i - 1] + f[i + 1] + f[i - w] + f[i + w]) * share;
      const next = v < 1e-5 ? 0 : (v > cap ? cap : v);
      out[i] = next;
      if (trackActive && next > 0) active = true;
    }
  }
  // Edges: replicate-boundary 5-point (no wraparound)
  for (let x = 0; x < w; x++) {
    // top
    {
      const i = x;
      const left = x > 0 ? f[i - 1] : f[i];
      const right = x < w - 1 ? f[i + 1] : f[i];
      const down = f[i + w];
      const v = f[i] * keep + (left + right + f[i] + down) * share;
      const next = v < 1e-5 ? 0 : (v > cap ? cap : v);
      out[i] = next;
      if (trackActive && next > 0) active = true;
    }
    // bottom
    {
      const i = (h - 1) * w + x;
      const left = x > 0 ? f[i - 1] : f[i];
      const right = x < w - 1 ? f[i + 1] : f[i];
      const up = f[i - w];
      const v = f[i] * keep + (left + right + up + f[i]) * share;
      const next = v < 1e-5 ? 0 : (v > cap ? cap : v);
      out[i] = next;
      if (trackActive && next > 0) active = true;
    }
  }
  for (let y = 1; y < h - 1; y++) {
    // left col
    {
      const i = y * w;
      const v = f[i] * keep + (f[i] + f[i + 1] + f[i - w] + f[i + w]) * share;
      const next = v < 1e-5 ? 0 : (v > cap ? cap : v);
      out[i] = next;
      if (trackActive && next > 0) active = true;
    }
    // right col
    {
      const i = y * w + (w - 1);
      const v = f[i] * keep + (f[i - 1] + f[i] + f[i - w] + f[i + w]) * share;
      const next = v < 1e-5 ? 0 : (v > cap ? cap : v);
      out[i] = next;
      if (trackActive && next > 0) active = true;
    }
  }
  f.set(out);
  return trackActive ? active : true;
}

function convertDecayToFood(f0, f1) {
  // proportional conversion — decay slowly nourishes
  for (let i = 0; i < f0.length; i++) {
    const d = f1[i];
    if (d > 0) {
      const k = d * DECAY_TO_FOOD;
      f1[i] = d - k;
      f0[i] = Math.min(FOOD_CAP, f0[i] + k);
    }
  }
}

function decayOnly(f, k) {
  let active = false;
  for (let i = 0; i < f.length; i++) {
    const v = f[i] * (1 - k);
    if (v < 1e-5) f[i] = 0;
    else {
      f[i] = v;
      active = true;
    }
  }
  return active;
}

// Ambient sunlight: every non-wall cell gains a trickle of food, tapered so
// already-rich cells saturate. Closes the energy budget so populations
// sustain.
//
// Phase 7 — spatial heterogeneity. PHOTO rate varies by latitude (y) using a
// smooth cosine bell so the equator is lush and the poles are barren. Total
// world food output is roughly preserved (the bell averages to ~PHOTO over
// y), but distribution forces migration / niche specialization: brains can
// either evolve to camp the equator or to thrive in sparser regions with
// less competition.
function photosynthesise(f0, walls, hasWalls = true) {
  if (!photosynthesise._photo || photosynthesise._photo.length !== GH) {
    const photo = photosynthesise._photo = new Float32Array(GH);
    const soft = photosynthesise._soft = new Float32Array(GH);
    for (let y = 0; y < GH; y++) {
      const yn = (y / GH - 0.5) * 2;       // -1..1 (north pole..south pole)
      const c = Math.cos(yn * Math.PI * 0.5);
      const lat = 0.3 + 1.4 * c * c;
      photo[y] = PHOTO * lat;
      soft[y] = PHOTO_SOFT * (0.5 + 0.5 * lat);
    }
  }
  const photo = photosynthesise._photo;
  const soft = photosynthesise._soft;
  if (!hasWalls) {
    for (let y = 0; y < GH; y++) {
      const localPhoto = photo[y];
      const localSoft = soft[y];
      for (let x = 0; x < GW; x++) {
        const i = y * GW + x;
        const v = f0[i];
        if (v < FOOD_CAP) {
          const taper = Math.max(0, 1 - v / localSoft);
          f0[i] = v + localPhoto * taper;
        }
      }
    }
    return;
  }
  for (let y = 0; y < GH; y++) {
    // Latitude factor: 1.7 at equator, 0.3 at poles, smooth transition.
    const localPhoto = photo[y];
    const localSoft = soft[y];
    for (let x = 0; x < GW; x++) {
      const i = y * GW + x;
      if (walls[i] === WALL_SOLID) continue;
      const v = f0[i];
      if (v < FOOD_CAP) {
        const taper = Math.max(0, 1 - v / localSoft);
        f0[i] = v + localPhoto * taper;
      }
    }
  }
}
