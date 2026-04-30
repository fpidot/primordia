// sim.js — Primordia simulation core
// Three layers: particles (typed agents w/ evolving genome) + chemical field
// (food/decay) + walls. Closed-loop ecology: dying particles deposit decay,
// decay slowly converts to food, others eat it.

import {
  NUM_SPECIES, NUM_CHEM, makeGenome, mutate, cloneGenome,
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
import { CladeTracker } from './lineage.js';
import {
  RESULT_STRIDE, EXTRAS_STRIDE,
  RES_FX, RES_FY, RES_NBVX, RES_NBVY,
  RES_SIGR, RES_SIGG, RES_SIGB, RES_SIGN,
  RES_OWNN, RES_ALIENN, RES_CROWD,
  RES_OUT0, RES_H0,
} from './gpu_pairforce.js';

// Fixed world geometry — canvas internal pixel size = (W, H); camera scales it.
export const GW = 400;
export const GH = 260;
export const CELL = 5;
export const W = GW * CELL;
export const H = GH * CELL;

// Spatial hash cell size must be ≥ max sense_radius (genome cap = 90).
export const HASH_CELL = 96;
export const HW = Math.ceil(W / HASH_CELL);
export const HH = Math.ceil(H / HASH_CELL);

// Force-model constants — Phase 0 tuning: stronger forces, longer ranges
// produce the chasing/orbiting/clustering signatures of Particle-Life-style
// emergent organisms.
export const R_CLOSE = 6.0;          // collision radius
export const K_REP = 1.8;            // short-range repulsion strength
export const K_ATTR = 0.30;          // tent peak strength multiplier
const K_FIELD = 4.5;          // gradient → acceleration scale
const K_DRAG = 0.18;          // viscous drag (overdamped, Particle-Lenia style)
const MAX_V = 3.6;
const K_MOTION_COST = 0.0014; // per-tick energy cost of |v|^2 (raised from 0.0008
                              // to make movement metabolically meaningful — was
                              // ~free before, no pressure to conserve)

// Field constants — tightened for survival pressure. Earlier values produced
// a stable thriving equilibrium with no evolutionary advancement: ambient
// food + carcass recycling kept everyone fed regardless of fitness. Reduced
// PHOTO 33%, PHOTO_SOFT capped lower, DECAY_TO_FOOD halved.
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
const PHOTO = 0.0008;          // ambient food regen per cell per tick (was 0.0012)
const PHOTO_SOFT = 0.7;        // photo tapers off above this food level (was 1.1)
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
const DEATH_DEPOSIT = 1.4;     // decay packet released on death
const EAT_MAX = 0.18;          // max food a particle can eat per tick

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
// and deposit carried material at their current cell.
const WALL_DIG_COST     = 0.30;
const WALL_DEPOSIT_COST = 0.10;
const WALL_CARRY_MAX    = 5;
const WALL_SCAN_RANGE   = 6;       // grid cells; sensor reach for wall.{n,s,e,w}

// Scan four cardinal directions from grid (gx, gy) for the nearest *real*
// wall (any type) — returns {n, s, e, w} each in [0, 1]. World edges DO NOT
// register: an earlier version did, but that produced a bias toward steering
// into the bounce-bound (where particles can't actually dig anything),
// which a digging lineage would learn to feckly chase. Now sensors only
// fire for diggable interior walls.
function scanWallProximity(walls, gx, gy) {
  let wn = 0, ws = 0, we = 0, ww = 0;
  // North (y decreasing)
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const ny = gy - d;
    if (ny < 0) break;
    if (walls[ny * GW + gx]) { wn = 1 - (d - 1) / WALL_SCAN_RANGE; break; }
  }
  // South (y increasing)
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const ny = gy + d;
    if (ny >= GH) break;
    if (walls[ny * GW + gx]) { ws = 1 - (d - 1) / WALL_SCAN_RANGE; break; }
  }
  // East (x increasing)
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const nx = gx + d;
    if (nx >= GW) break;
    if (walls[gy * GW + nx]) { we = 1 - (d - 1) / WALL_SCAN_RANGE; break; }
  }
  // West (x decreasing)
  for (let d = 1; d <= WALL_SCAN_RANGE; d++) {
    const nx = gx - d;
    if (nx < 0) break;
    if (walls[gy * GW + nx]) { ww = 1 - (d - 1) / WALL_SCAN_RANGE; break; }
  }
  return { wn, ws, we, ww };
}

// Wall types — `walls[i]` value semantics:
//   0 = open
//   1 = solid    (blocks particles, blocks chemicals/sound) — original behaviour
//   2 = membrane (blocks particles, passes chemicals/sound) — selective barrier
//   3 = porous   (passes particles, blocks chemicals)       — chemical screen
// Stored as Uint8 so brushes can paint any of 1/2/3 at the cost of one byte.
export const WALL_OPEN     = 0;
export const WALL_SOLID    = 1;
export const WALL_MEMBRANE = 2;
export const WALL_POROUS   = 3;

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
    this.walls = new Uint8Array(GW * GH);

    // Spatial hash (linked-list style)
    this.cellHead = new Int32Array(HW * HH);
    this.cellNext = new Int32Array(this.maxParticles);

    // Lineage counter for new particles created from outside
    this.totalBorn = 0;
    this.totalDied = 0;

    this.clades = new CladeTracker();

    // Reusable scratch buffers for brain forward pass
    this._brainInput = new Float32Array(N_INPUT);
    this._brainOutput = new Float32Array(N_OUTPUT);

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
    // Wall version — bumped on every wall brush so the renderer can rebuild
    // its smooth-edge cache even when count is unchanged but a cell changed
    // type (e.g. solid → membrane).
    this._wallsVersion = 0;

    // Bonded clusters — recomputed periodically via union-find on the bond
    // graph. Clusters of size ≥ MIN_NAMED_CLUSTER get a name + flag label.
    this._clusters = [];
    this._clustersTick = -10000;
    this._clusterIdCounter = 0;
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
    this._brainsDirty = true;          // re-upload brain weights when any brain changed
    this._extrasStaging = null;        // Float32Array(maxParticles × EXTRAS_STRIDE) — lazy alloc
    this._gpuValidate = false;
    this._gpuLastDiff = null;
  }

  // Attach a GPUPairForce kernel. World does not own its lifecycle; caller
  // toggles via setGPUEnabled().
  attachGPU(kernel) { this._gpu = kernel; }
  setGPUEnabled(enabled) {
    this._gpuEnabled = !!enabled && !!this._gpu;
    if (!this._gpuEnabled) {
      this._gpuResults = null;
    } else {
      // First GPU-enabled tick must (re)upload all brain weights so the brain
      // kernel doesn't run with the GPU buffer's zeroed initial state.
      this._brainsDirty = true;
    }
  }
  isGPUEnabled() { return !!this._gpuEnabled; }
  setGPUValidate(v) { this._gpuValidate = !!v; }

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
      signalR: 0, signalG: 0, signalB: 0,
      prevSignalR: 0, prevSignalG: 0, prevSignalB: 0,
      signalFlash: 0, signalAboveLast: 0,
      predationGain: 0,
      soundCh: 0, soundAmp: 0,
      wantBond: 0, wantMate: 0,
      bondMsgR: 0, bondMsgG: 0, bondMsgB: 0,
      incomingBondMsgR: 0, incomingBondMsgG: 0, incomingBondMsgB: 0,
      wallCarry: 0,
      bonds: [],
      dead: false,
    };
    this.particles.push(p);
    if (clade) {
      p.cladeId = clade.id;
      clade.totalEverBorn++;
    } else {
      this.clades.registerNewParticle(p, null, this.tick);
    }
    this.totalBorn++;
    this._brainsDirty = true;
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
    this.mutagen.fill(0);
    this.walls.fill(0);
    if (this._soundFields) for (const s of this._soundFields) s.fill(0);
    this.tick = 0;
    this.totalBorn = 0;
    this.totalDied = 0;
    this._wallCount = 0;
    this._brainsDirty = true;
    this.clades = new CladeTracker();
    // Clusters are recomputed on a 12-tick cadence; if we don't clear here,
    // stale cluster flags + chase locks survive the preset switch until the
    // next recompute fires (which won't happen in an empty world).
    this._clusters = [];
    this._clustersTick = -10000;
    this._particleToCluster.clear();
    this._clusterNames.clear();
  }

  clearField() {
    this.field[0].fill(0);
    this.field[1].fill(0);
    this.mutagen.fill(0);
    if (this._soundFields) for (const s of this._soundFields) s.fill(0);
  }

  // ────────────────────────────────────────────────────────────── brushes

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
            break;
          case 'membrane':
            if (!this.walls[idx]) this._wallCount++;
            this.walls[idx] = WALL_MEMBRANE;
            this._wallsVersion++;
            // Membrane doesn't zero fields — chemicals pass through
            break;
          case 'porous':
            if (!this.walls[idx]) this._wallCount++;
            this.walls[idx] = WALL_POROUS;
            this._wallsVersion++;
            this.field[0][idx] = 0;
            this.field[1][idx] = 0;
            break;
          case 'mutagen':
            this.mutagen[idx] = clamp(this.mutagen[idx] + strength * 0.6 * fall, 0, MUTAGEN_CAP);
            break;
          case 'erase':
            if (this.walls[idx]) {
              this.walls[idx] = 0;
              this._wallCount = Math.max(0, this._wallCount - 1);
              this._wallsVersion++;
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

    // id → particle map for bond / mate lookups
    const idMap = new Map();
    for (let i = 0; i < N; i++) {
      const p = ps[i];
      if (!p.dead) idMap.set(p.id, p);
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
        const partner = idMap.get(partnerId);
        if (partner && !partner.dead) {
          sR += partner.bondMsgR;
          sG += partner.bondMsgG;
          sB += partner.bondMsgB;
          n++;
        }
      }
      if (n > 0) {
        const inv = 1 / n;
        p.incomingBondMsgR = Math.tanh((sR * inv) * 2 - 1);
        p.incomingBondMsgG = Math.tanh((sG * inv) * 2 - 1);
        p.incomingBondMsgB = Math.tanh((sB * inv) * 2 - 1);
      } else {
        p.incomingBondMsgR = p.incomingBondMsgG = p.incomingBondMsgB = 0;
      }
    }

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
          }
        }
        c.alarm = alarmTrigger ? 1 : (c.alarm || 0) * 0.5;
      }
    }

    // ── GPU pair-force + stats + brain forward pass ──────────────────
    // Upload particles, attractions, brain weights (only if dirty), brain
    // state, and chem extras pre-sampled from the field. Dispatch the four
    // compute pipelines (clear hash → build hash → pair_force → brain_forward)
    // and await the readback. When GPU mode is on, the CPU loop skips:
    //   * pair-force math and stat accumulation (from 4d)
    //   * brain input building and CTRNN forward (4e)
    let useGpuPairs = false;
    if (this._gpuEnabled && this._gpu && N > 0) {
      try {
        // Pre-sample field at each particle's cell — used as brain inputs
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
          extras[o + 10] = p.incomingBondMsgR;    // Phase 6b — bondMsg R channel
          extras[o + 11] = p.incomingBondMsgG;    // Phase 6b — G channel
          extras[o + 12] = p.incomingBondMsgB;    // Phase 6b — B channel
          // Phase 6a — cluster geometry. Lookup once; if absent, all zeros.
          const cl = this._particleToCluster.get(p.id);
          if (cl) {
            extras[o + 13] = Math.tanh((cl.cx - p.x) / 80);   // dx normalized
            extras[o + 14] = Math.tanh((cl.cy - p.y) / 80);
            extras[o + 15] = Math.tanh(Math.log2(cl.count + 1) * 0.3);
            extras[o + 16] = 1;
            extras[o + 17] = cl.alarm || 0;                  // Phase 6c
          } else {
            extras[o + 13] = 0;
            extras[o + 14] = 0;
            extras[o + 15] = 0;
            extras[o + 16] = 0;
            extras[o + 17] = 0;
          }
          extras[o + 18] = (p.wallCarry || 0) / WALL_CARRY_MAX;   // Thread B-2
          // Wall proximity sensors — N/S/E/W cardinal scan
          {
            const wgx = clamp((p.x / CELL) | 0, 0, GW - 1);
            const wgy = clamp((p.y / CELL) | 0, 0, GH - 1);
            const ws = scanWallProximity(walls, wgx, wgy);
            extras[o + 19] = ws.wn;
            extras[o + 20] = ws.ws;
            extras[o + 21] = ws.we;
            extras[o + 22] = ws.ww;
          }
        }

        this._gpu.upload(ps);
        this._gpu.uploadExtras(extras);
        if (this._brainsDirty) {
          this._gpu.uploadBrains(ps);
          this._brainsDirty = false;
        }
        this._gpu.uploadBrainState(ps);
        this._gpu.dispatch();
        this._gpuResults = await this._gpu.readback();
        useGpuPairs = true;
      } catch (err) {
        console.warn('[gpu] dispatch failed; falling back to CPU', err);
        this._gpuEnabled = false;
        this._gpuResults = null;
      }
    } else {
      this._gpuResults = null;
    }

    // ── 1. Build spatial hash ────────────────────────────────────────
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
      let ax = 0, ay = 0;
      // Bond barrier accumulator — kept separate from ax/ay so the GPU
      // pair-force overwrite below doesn't clobber it. Added to ax/ay after
      // the GPU result is injected, so barrier still works when GPU is on.
      let bax = 0, bay = 0;

      // Pair forces from neighbours in 3×3 hash cells
      const cx = (p.x / HASH_CELL) | 0;
      const cy = (p.y / HASH_CELL) | 0;
      const cx0 = Math.max(0, cx - 1), cx1 = Math.min(HW - 1, cx + 1);
      const cy0 = Math.max(0, cy - 1), cy1 = Math.min(HH - 1, cy + 1);
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
      if (useGpuPairs) {
        const ro = i * RESULT_STRIDE;
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
                if (d2 < R2 && d2 > 1e-6) {
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
                      const pCl = this._particleToCluster.get(p.id);
                      const qCl = this._particleToCluster.get(q.id);
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
                        const baseRate = 0.18 * willBoost * totalMult;
                        const drain = Math.min(q.energy * baseRate, 0.7);
                        q.energy -= drain;
                        // Phase 6 — predator efficiency raised 0.55 → 0.80.
                        p.energy += drain * 0.80;
                      }
                    }
                    // Bond formation: only checked when i.id < j.id to avoid
                    // double work. Both must want bond; both must have a free
                    // slot; not already bonded; close enough. Cluster affinity
                    // shifts each side's effective gate when both are already
                    // in the same named cluster — positive affinity makes
                    // colony loyalty (extra bonds within own group) easier.
                    if (i < j &&
                        d < BOND_FORM_DIST &&
                        p.bonds.length < MAX_BONDS && q.bonds.length < MAX_BONDS &&
                        !p.bonds.includes(q.id) && !q.bonds.includes(p.id)) {
                      const pCluster = this._particleToCluster.get(p.id);
                      const qCluster = this._particleToCluster.get(q.id);
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
                if (this.bondBarrier &&
                    q.bonds.length > 0 &&
                    this._particleToCluster.has(q.id)) {
                  const pBondedQ = p.bonds.length > 0 && p.bonds.includes(q.id);
                  if (!pBondedQ) {
                    const qBonds = q.bonds;
                    for (let bi = 0; bi < qBonds.length; bi++) {
                      const pid = qBonds[bi];
                      if (pid <= q.id) continue;          // each segment once
                      if (pid === p.id) continue;
                      if (p.bonds.length > 0 && p.bonds.includes(pid)) continue;
                      const partner = idMap.get(pid);
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
        const oi = i * RESULT_STRIDE;
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

      // ── Brain: build sensor input, run forward pass, apply outputs ──
      const out = this._brainOutput;
      if (useGpuPairs) {
        // GPU already ran the forward pass — copy outputs from the result
        // buffer and update the persistent h state from GPU's value.
        const oo = i * RESULT_STRIDE + RES_OUT0;
        for (let oj = 0; oj < N_OUTPUT; oj++) out[oj] = this._gpuResults[oo + oj];
        const ho = i * RESULT_STRIDE + RES_H0;
        const h = g.brain.h;
        for (let k = 0; k < h.length; k++) h[k] = this._gpuResults[ho + k];
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
        const cl6 = this._particleToCluster.get(p.id);
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
        // Wall proximity sensors — share the same scan helper as GPU extras.
        {
          const wScan = scanWallProximity(walls, sgx, sgy);
          inp[37] = wScan.wn;
          inp[38] = wScan.ws;
          inp[39] = wScan.we;
          inp[40] = wScan.ww;
        }
        g.brain.forward(inp, out);
      }

      // Apply outputs
      const tx = Math.tanh(out[OUT_TX]);
      const ty = Math.tanh(out[OUT_TY]);
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
      const sigMean = (p.signalR + p.signalG + p.signalB) / 3;
      let above = p.signalAboveLast || 0;
      if (sigMean > 0.65) above = 1;
      else if (sigMean < 0.55) above = 0;
      if (above && !p.signalAboveLast) {
        p.signalFlash = 1;     // rising edge → fresh flash event
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

      // ── Thread B-2 — wall manipulation ──────────────────────────────
      // Two outputs: dig the cell in front of velocity (if solid wall) or
      // deposit a carried wall block at the current cell. Mutually
      // exclusive — deposit wins ties. Carry capped at WALL_CARRY_MAX.
      const digSig = sigmoid01(out[OUT_DIG]);
      const depSig = sigmoid01(out[OUT_DEPOSIT]);
      if (depSig > 0.6 && p.wallCarry > 0) {
        const dgx = clamp((p.x / CELL) | 0, 0, GW - 1);
        const dgy = clamp((p.y / CELL) | 0, 0, GH - 1);
        const didx = dgy * GW + dgx;
        if (walls[didx] === 0) {
          walls[didx] = WALL_SOLID;
          this._wallCount++;
          this._wallsVersion++;
          p.wallCarry--;
          p.energy -= WALL_DEPOSIT_COST;
          this._wallSoundEvents.push({ kind: 'plop', x: p.x, y: p.y, id: p.id });
        }
      } else if (digSig > 0.6 && p.wallCarry < WALL_CARRY_MAX) {
        // Cell in front of velocity (rounded). Particles too slow to have a
        // direction skip (digging while sitting still doesn't make sense).
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (sp > 0.1) {
          const dirx = p.vx / sp;
          const diry = p.vy / sp;
          const dgx = clamp((p.x / CELL) | 0, 0, GW - 1);
          const dgy = clamp((p.y / CELL) | 0, 0, GH - 1);
          const tgx = clamp(dgx + Math.round(dirx), 0, GW - 1);
          const tgy = clamp(dgy + Math.round(diry), 0, GH - 1);
          const tidx = tgy * GW + tgx;
          if (walls[tidx] === WALL_SOLID && p.energy > WALL_DIG_COST) {
            walls[tidx] = 0;
            this._wallCount = Math.max(0, this._wallCount - 1);
            this._wallsVersion++;
            p.wallCarry++;
            p.energy -= WALL_DIG_COST;
            this._wallSoundEvents.push({ kind: 'grunt', x: p.x, y: p.y, id: p.id });
          }
        }
      }

      // ── Bond physics: spring + energy share + break-on-distance ──
      if (p.bonds.length > 0) {
        for (let bi = p.bonds.length - 1; bi >= 0; bi--) {
          const partner = idMap.get(p.bonds[bi]);
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
      let nx = p.x + vx;
      let ny = p.y + vy;

      // Wall handling — axis-separated, using actual current cell
      const pgy = clamp((p.y / CELL) | 0, 0, GH - 1);
      const ngx = clamp((nx / CELL) | 0, 0, GW - 1);
      // Solid + membrane wall types block particles; porous lets them pass.
      const wTargetX = walls[pgy * GW + ngx];
      if (wTargetX === WALL_SOLID || wTargetX === WALL_MEMBRANE) {
        nx = p.x;
        vx = -vx * 0.5;
      }
      const cgx = clamp((nx / CELL) | 0, 0, GW - 1);
      const ngy = clamp((ny / CELL) | 0, 0, GH - 1);
      const wTargetY = walls[ngy * GW + cgx];
      if (wTargetY === WALL_SOLID || wTargetY === WALL_MEMBRANE) {
        ny = p.y;
        vy = -vy * 0.5;
      }
      // Toroidal-ish bounds: reflect at edges
      if (nx < 1) { nx = 1; vx = Math.abs(vx) * 0.5; }
      else if (nx > W - 1) { nx = W - 1; vx = -Math.abs(vx) * 0.5; }
      if (ny < 1) { ny = 1; vy = Math.abs(vy) * 0.5; }
      else if (ny > H - 1) { ny = H - 1; vy = -Math.abs(vy) * 0.5; }

      p.x = nx; p.y = ny;
      p.vx = vx; p.vy = vy;
      p.age++;

      // Energy
      const speed2 = vx * vx + vy * vy;
      let dE = -(g.metab + K_MOTION_COST * speed2);
      // crowd penalty
      if (crowd > 6) dE -= CROWD_PENALTY * (crowd - 6);
      // eat food at current cell
      const finalGx = clamp((nx / CELL) | 0, 0, GW - 1);
      const finalGy = clamp((ny / CELL) | 0, 0, GH - 1);
      const fIdx = finalGy * GW + finalGx;
      // Phase 6 — eat efficiency now scales with two evolved traits:
      //   • cluster bonus: +20% if particle is in a named cluster (rewards
      //     bondedness directly so cluster_affinity has selection pressure)
      //   • slot bonus:    +2.5% per active brain slot above the baseline 3
      //     (rewards cognitive growth beyond the small-brain default)
      // Combined max ≈ 1.20 × 1.125 = 1.35× efficiency for an 8-slot bonded
      // particle vs an unbonded 3-slot one. Direct fitness lever for both
      // Phase 6a (clusters) and structural brain mutation.
      const eat = Math.min(f0[fIdx], EAT_MAX);
      const inCluster = this._particleToCluster.has(p.id);
      const slotBonus = 1 + Math.max(0, g.brain.enabledCount() - 3) * 0.025;
      const effMult = (inCluster ? 1.20 : 1.0) * slotBonus;
      const eatGain = eat * g.efficiency * effMult;
      f0[fIdx] -= eat;
      dE += eatGain;
      // emit chemicals — body baseline plus brain decision
      const eF = g.emit[0] + Math.max(0, out[OUT_EMIT_FOOD]) * 0.06;
      const eD = g.emit[1] + Math.max(0, out[OUT_EMIT_DECAY]) * 0.06;
      if (eF > 0) f0[fIdx] = Math.min(FOOD_CAP, f0[fIdx] + eF);
      if (eD > 0) f1[fIdx] = Math.min(DECAY_CAP, f1[fIdx] + eD);
      // Sound emission deposited into selected channel field at this cell
      if (p.soundAmp > 0.15) {
        const sf = this._soundFields[p.soundCh];
        sf[fIdx] = Math.min(SOUND_CAP, sf[fIdx] + p.soundAmp * 0.4);
        this._soundLastEmit[p.soundCh] = this.tick;
      }

      p.energy += dE;

      // Death
      if (p.energy <= 0) {
        p.dead = true;
        f1[fIdx] = Math.min(DECAY_CAP, f1[fIdx] + DEATH_DEPOSIT);
        this.totalDied++;
        this.clades.onParticleDie(p, this.tick);
        // Bond cost — losing a member drains every surviving partner. Bonds
        // also break naturally next tick when partners notice p.dead.
        if (p.bonds.length > 0) {
          const drainPerPartner = BOND_DEATH_DRAIN / p.bonds.length;
          for (const partnerId of p.bonds) {
            const partner = idMap.get(partnerId);
            if (partner && !partner.dead) {
              partner.energy -= drainPerPartner;
              if (partner.energy < 0) partner.energy = 0;
            }
          }
        }
        continue;
      }

      // Reproduction — body threshold, gated by brain output (must not strongly veto)
      const reproVeto = out[OUT_REPRO_GATE] < -0.35;
      // Sexual reproduction: try first if conditions are right
      let didSex = false;
      if (!reproVeto && p.wantMate > MATE_GATE && p.bonds.length > 0 &&
          p.energy > g.repro_thresh * 0.8 &&
          Math.random() < REPRO_PROB_SEX &&
          this.particles.length + this.births.length < this.maxParticles) {
        for (const pid of p.bonds) {
          const partner = idMap.get(pid);
          if (!partner || partner.dead) continue;
          if (partner.wantMate < MATE_GATE) continue;
          if (partner.energy < partner.genome.repro_thresh * 0.7) continue;
          // Both willing — sexual repro with crossover + mutation
          const boost = 1 + Math.min(2, mut[fIdx] * 0.8);
          let childGenome = crossoverGenome(g, partner.genome);
          childGenome = mutate(childGenome, Math.random, boost);
          // Energy: each parent pays a tax; child gets the surplus
          const pool = (p.energy + partner.energy) * (1 - REPRO_TAX);
          p.energy = pool * 0.4;
          partner.energy = pool * 0.4;
          const childE = pool * 0.2;
          // Inherit cladeId from "richer" parent, with chance to fork later
          const parentClade = p.energy >= partner.energy ? p.cladeId : partner.cladeId;
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
            signalR: 0, signalG: 0, signalB: 0,
            predationGain: 0,
            soundCh: 0, soundAmp: 0,
            wantBond: 0, wantMate: 0,
            bondMsgR: 0, bondMsgG: 0, bondMsgB: 0,
      incomingBondMsgR: 0, incomingBondMsgG: 0, incomingBondMsgB: 0,
      wallCarry: 0,
            bonds: [],
            dead: false,
          };
          this.births.push(child);
          this.totalBorn++;
          this._brainsDirty = true;
          didSex = true;
          break;
        }
      }
      // Asexual fallback
      if (!didSex && !reproVeto && p.energy > g.repro_thresh && Math.random() < REPRO_PROB) {
        if (this.particles.length + this.births.length < this.maxParticles) {
          const boost = 1 + Math.min(2, mut[fIdx] * 0.8);
          const childGenome = mutate(g, Math.random, boost);
          const e = p.energy * (1 - REPRO_TAX) * 0.5;
          p.energy = e;
          const jitter = 4;
          const child = {
            id: ++_id,
            x: clamp(p.x + (Math.random() - 0.5) * jitter, 1, W - 1),
            y: clamp(p.y + (Math.random() - 0.5) * jitter, 1, H - 1),
            vx: -p.vx * 0.5 + (Math.random() - 0.5) * 0.5,
            vy: -p.vy * 0.5 + (Math.random() - 0.5) * 0.5,
            genome: childGenome,
            species: childGenome.species,
            energy: e,
            age: 0,
            lineage: p.lineage,
            cladeId: p.cladeId,
            signalR: 0, signalG: 0, signalB: 0,
            predationGain: 0,
            soundCh: 0, soundAmp: 0,
            wantBond: 0, wantMate: 0,
            bondMsgR: 0, bondMsgG: 0, bondMsgB: 0,
      incomingBondMsgR: 0, incomingBondMsgG: 0, incomingBondMsgB: 0,
      wallCarry: 0,
            bonds: [],
            dead: false,
          };
          this.births.push(child);
          this.totalBorn++;
          this._brainsDirty = true;
        }
      }
    }

    // ── 3. Field update ──────────────────────────────────────────────
    convertDecayToFood(f0, f1);
    photosynthesise(f0, walls);
    diffuseAndDecay(f0, DIFFUSE, DECAY_LOSS, FOOD_CAP);
    diffuseAndDecay(f1, DIFFUSE, DECAY_DECAY, DECAY_CAP);
    decayOnly(mut, MUTAGEN_DECAY);
    // Sound channels: only diffuse channels with recent emissions (cheap idle).
    for (let s = 0; s < this._soundFields.length; s++) {
      if (this.tick - this._soundLastEmit[s] < 60) {
        diffuseAndDecay(this._soundFields[s], SOUND_DIFFUSE, SOUND_DECAY, SOUND_CAP);
      }
    }
    // Zero out walls — skip the entire pass when there are no walls. Only
    // solid + porous types zero chemicals; membrane lets them pass through.
    if (this._wallCount > 0) {
      for (let i = 0; i < walls.length; i++) {
        const wt = walls[i];
        if (wt === WALL_SOLID || wt === WALL_POROUS) {
          f0[i] = 0; f1[i] = 0; mut[i] = 0;
          for (let s = 0; s < this._soundFields.length; s++) this._soundFields[s][i] = 0;
        }
      }
    }

    // ── 4. Compact particles: remove dead, append births ─────────────
    const alive = [];
    for (let i = 0; i < this.particles.length; i++) {
      if (!this.particles[i].dead) alive.push(this.particles[i]);
    }
    for (let i = 0; i < this.births.length; i++) alive.push(this.births[i]);
    this.births.length = 0;
    this.particles = alive;

    // ── 5. Clade census + speciation detection ───────────────────────
    this.clades.sweep(this);
    this.updateClusters();
    this.smoothClusterEnergy();
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
  updateClusters() {
    const CLUSTER_INTERVAL = 12;
    const MIN_NAMED_CLUSTER = 8;
    if (this.tick - this._clustersTick < CLUSTER_INTERVAL) return;
    this._clustersTick = this.tick;

    const ps = this.particles;
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
    for (const [root, members] of groups) {
      if (members.length < MIN_NAMED_CLUSTER) continue;
      let cx = 0, cy = 0;
      const cladeCount = new Map();
      let smallestId = Infinity;
      for (const p of members) {
        cx += p.x;
        cy += p.y;
        cladeCount.set(p.cladeId, (cladeCount.get(p.cladeId) || 0) + 1);
        if (p.id < smallestId) smallestId = p.id;
      }
      cx /= members.length;
      cy /= members.length;
      // Dominant clade
      let topClade = -1, topCount = 0;
      for (const [cid, cnt] of cladeCount) {
        if (cnt > topCount) { topCount = cnt; topClade = cid; }
      }
      const clade = this.clades.clades.get(topClade);
      const baseName = clade ? clade.name : `cluster`;
      // Name format: "<dominant clade> · ×N" (or "·band" if mixed)
      const isMixed = topCount < members.length;
      const name = isMixed
        ? `${baseName}-band ×${members.length}`
        : `${baseName} ×${members.length}`;
      const cluster = {
        root,
        anchorId: smallestId,
        count: members.length,
        members,                  // actual particle refs — used by chase highlight
        cx, cy,
        name,
        species: clade?.species ?? 0,
      };
      clusters.push(cluster);
      for (const p of members) memberMap.set(p.id, cluster);
    }
    // Sort by size descending — renderer caps how many flags it draws
    clusters.sort((a, b) => b.count - a.count);
    this._clusters = clusters;
  }

  // ────────────────────────────────────────────────────────────── stats

  // Snapshot of energy / food / death dynamics for the diagnostics readout.
  // Called from the UI at ~6 Hz; cheap relative to a step.
  vitals() {
    const ps = this.particles;
    let eSum = 0, eMin = Infinity, eMax = -Infinity, lowN = 0;
    const lowThresh = 1.0;
    let alive = 0;
    for (const p of ps) {
      if (p.dead) continue;
      alive++;
      eSum += p.energy;
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
      eMin: alive ? eMin : 0,
      eMax: alive ? eMax : 0,
      lowFrac,
      meanFood,
      meanDecay,
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
    return {
      version: 2,
      tick: this.tick,
      walls: Array.from(this.walls),
      field0: Array.from(this.field[0]),
      field1: Array.from(this.field[1]),
      mutagen: Array.from(this.mutagen),
      clades: this.clades.toJSON(),
      particles: this.particles.map(p => ({
        x: p.x, y: p.y, vx: p.vx, vy: p.vy,
        energy: p.energy, age: p.age, lineage: p.lineage,
        cladeId: p.cladeId,
        bonds: p.bonds.slice(),
        genome: genomeToJSON(p.genome),
      })),
    };
  }

  fromJSON(data) {
    this.reset();
    this.tick = data.tick || 0;
    if (data.walls) {
      this.walls.set(data.walls);
      let wc = 0;
      for (let i = 0; i < this.walls.length; i++) if (this.walls[i]) wc++;
      this._wallCount = wc;
    }
    if (data.field0) this.field[0].set(data.field0);
    if (data.field1) this.field[1].set(data.field1);
    if (data.mutagen) this.mutagen.set(data.mutagen);
    if (data.clades) this.clades.fromJSON(data.clades);
    this._brainsDirty = true;
    for (const op of (data.particles || [])) {
      const loadedGenome = genomeFromJSON(op.genome);
      const p = {
        id: ++_id,
        x: op.x, y: op.y, vx: op.vx, vy: op.vy,
        genome: loadedGenome,
        species: loadedGenome.species,
        energy: op.energy, age: op.age,
        lineage: op.lineage ?? (++_lineage),
        cladeId: op.cladeId ?? 0,
        signalR: 0, signalG: 0, signalB: 0,
        predationGain: 0,
        soundCh: 0, soundAmp: 0,
        wantBond: 0, wantMate: 0,
        bondMsgR: 0, bondMsgG: 0, bondMsgB: 0,
      incomingBondMsgR: 0, incomingBondMsgG: 0, incomingBondMsgB: 0,
      wallCarry: 0,
        bonds: Array.isArray(op.bonds) ? op.bonds.slice() : [],
        dead: false,
      };
      this.particles.push(p);
      // If no clades data was provided (old save), register as fresh clade
      if (!data.clades) this.clades.registerNewParticle(p, null, this.tick);
    }
  }
}

// ─────────────────────────────────────────────────────────────── helpers

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Maps brain output → [0,1] via sigmoid (smooth gate)
function sigmoid01(x) { return 1 / (1 + Math.exp(-x)); }

// Fast 5-point (von Neumann) diffuse + multiplicative decay. Walls handled
// post-pass in step() — keeping this loop tight and branch-free.
function diffuseAndDecay(f, d, dec, cap) {
  if (!diffuseAndDecay._scratch || diffuseAndDecay._scratch.length !== f.length) {
    diffuseAndDecay._scratch = new Float32Array(f.length);
  }
  const out = diffuseAndDecay._scratch;
  const w = GW, h = GH;
  const keep = (1 - d) * (1 - dec);
  const share = (d * 0.25) * (1 - dec);

  // Interior cells (vectorisable hot loop)
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const v = f[i] * keep + (f[i - 1] + f[i + 1] + f[i - w] + f[i + w]) * share;
      out[i] = v < 1e-5 ? 0 : (v > cap ? cap : v);
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
      out[i] = v < 1e-5 ? 0 : (v > cap ? cap : v);
    }
    // bottom
    {
      const i = (h - 1) * w + x;
      const left = x > 0 ? f[i - 1] : f[i];
      const right = x < w - 1 ? f[i + 1] : f[i];
      const up = f[i - w];
      const v = f[i] * keep + (left + right + up + f[i]) * share;
      out[i] = v < 1e-5 ? 0 : (v > cap ? cap : v);
    }
  }
  for (let y = 1; y < h - 1; y++) {
    // left col
    {
      const i = y * w;
      const v = f[i] * keep + (f[i] + f[i + 1] + f[i - w] + f[i + w]) * share;
      out[i] = v < 1e-5 ? 0 : (v > cap ? cap : v);
    }
    // right col
    {
      const i = y * w + (w - 1);
      const v = f[i] * keep + (f[i - 1] + f[i] + f[i - w] + f[i + w]) * share;
      out[i] = v < 1e-5 ? 0 : (v > cap ? cap : v);
    }
  }
  f.set(out);
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
  for (let i = 0; i < f.length; i++) {
    const v = f[i] * (1 - k);
    f[i] = v < 1e-5 ? 0 : v;
  }
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
function photosynthesise(f0, walls) {
  for (let y = 0; y < GH; y++) {
    // Latitude factor: 1.7 at equator, 0.3 at poles, smooth transition.
    const yn = (y / GH - 0.5) * 2;       // -1..1 (north pole..south pole)
    const lat = 0.3 + 1.4 * Math.cos(yn * Math.PI * 0.5) ** 2;
    const localPhoto = PHOTO * lat;
    const localSoft = PHOTO_SOFT * (0.5 + 0.5 * lat);
    for (let x = 0; x < GW; x++) {
      const i = y * GW + x;
      if (walls[i]) continue;
      const v = f0[i];
      if (v < FOOD_CAP) {
        const taper = Math.max(0, 1 - v / localSoft);
        f0[i] = v + localPhoto * taper;
      }
    }
  }
}
