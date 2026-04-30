// brain.js — variable-complexity CTRNN-style neural controller for particles.
// Each particle's brain is a small recurrent network with enable-gated hidden
// slots so structural complexity can grow or shrink across generations.
//
// Forward pass (per tick):
//   for each enabled hidden k:
//     h_new[k] = act(bias_h[k] + Σⱼ W_ih[k,j]·input[j] + Σⱼ W_hh[k,j]·h[j] {j enabled})
//   h ← h_new
//   for each output o:
//     output[o] = bias_o[o] + Σₖ W_ho[k,o]·h[k]   {k enabled}
//
// Outputs are raw — caller applies per-output activation/clamp meaningfully.
// Outputs are *additive* on top of body-plan dynamics, so a freshly-randomized
// brain (~zero weights) leaves Phase-0 behavior intact and evolution can
// gradually take over.

import { NUM_SPECIES, NUM_CHEM } from './genome.js';

export const N_HIDDEN_MAX = 8;          // structural cap; raise later if perf allows

// Sensor layout — STABLE: changing this breaks evolved-weight meaning.
// Slots reserved for Phase 2d/e signaling sensors are zero-filled until those
// land, so weights to them stay near zero in evolved genomes (free real estate).
export const SENSOR_NAMES = [
  /*  0 */ 'bias',
  /*  1 */ 'energy',
  /*  2 */ 'age',
  /*  3 */ 'chem.food',
  /*  4 */ 'chem.decay',
  /*  5 */ 'chem.food.dx',
  /*  6 */ 'chem.food.dy',
  /*  7 */ 'chem.decay.dx',
  /*  8 */ 'chem.decay.dy',
  /*  9 */ 'neighbor.own',
  /* 10 */ 'neighbor.alien',
  /* 11 */ 'neighbor.vx',
  /* 12 */ 'neighbor.vy',
  /* 13 */ 'signal.r',                  // Phase 2d
  /* 14 */ 'signal.g',                  // Phase 2d
  /* 15 */ 'signal.b',                  // Phase 2d
  /* 16 */ 'sound.0',                   // Phase 2e
  /* 17 */ 'sound.1',                   // Phase 2e
  /* 18 */ 'sound.2',                   // Phase 2e
  /* 19 */ 'sound.3',                   // Phase 2e
  /* 20 */ 'bond.msg.r',                // Phase 5a → 6b — was 'bond.msg' (1 ch);
                                        //   reinterpreted as R channel of 3-ch
                                        //   bondMsg vector. Old weights at this
                                        //   position now feed off the R channel.
  /* 21 */ 'quad.ne.count',             // Phase 5b — neighbor count in NE quadrant
  /* 22 */ 'quad.se.count',             // Phase 5b
  /* 23 */ 'quad.sw.count',             // Phase 5b
  /* 24 */ 'quad.nw.count',             // Phase 5b
  /* 25 */ 'quad.ne.sig',               // Phase 5b — mean signal magnitude in NE quadrant
  /* 26 */ 'quad.se.sig',               // Phase 5b
  /* 27 */ 'quad.sw.sig',               // Phase 5b
  /* 28 */ 'quad.nw.sig',               // Phase 5b
  /* 29 */ 'bond.msg.g',                // Phase 6b — G channel of multi-channel bondMsg
  /* 30 */ 'bond.msg.b',                // Phase 6b — B channel of multi-channel bondMsg
  /* 31 */ 'cluster.dx',                // Phase 6a — relative offset to cluster centroid
  /* 32 */ 'cluster.dy',                // Phase 6a
  /* 33 */ 'cluster.size',              // Phase 6a — saturating curve over member count
  /* 34 */ 'cluster.member',            // Phase 6a — 1 if in any named cluster, else 0
  /* 35 */ 'cluster.alarm',             // Phase 6c — fast cluster-wide alarm broadcast
  /* 36 */ 'wall.carry',                // Thread B-2 — count of carried wall blocks (0..1)
  /* 37 */ 'wall.n',                    // Thread B-2 — proximity of nearest wall north (1=adjacent, 0=none in range)
  /* 38 */ 'wall.s',                    // Thread B-2 — south
  /* 39 */ 'wall.e',                    // Thread B-2 — east
  /* 40 */ 'wall.w',                    // Thread B-2 — west
];
export const N_INPUT = SENSOR_NAMES.length;

// Quadrant indexing. dx, dy are partner-relative (q.pos - p.pos):
//   dx >= 0, dy <  0 → NE (0)   dx >= 0, dy >= 0 → SE (1)
//   dx <  0, dy >= 0 → SW (2)   dx <  0, dy <  0 → NW (3)
export const QUAD_NE = 0, QUAD_SE = 1, QUAD_SW = 2, QUAD_NW = 3;
export function quadIndex(dx, dy) {
  return dx >= 0 ? (dy < 0 ? 0 : 1) : (dy >= 0 ? 2 : 3);
}

// Action layout — also STABLE. Append-only: existing weights keep their meaning.
export const OUT_TX           = 0;
export const OUT_TY           = 1;
export const OUT_EMIT_FOOD    = 2;
export const OUT_EMIT_DECAY   = 3;
export const OUT_REPRO_GATE   = 4;
export const OUT_PREDATION    = 5;
export const OUT_SIGNAL_R     = 6;
export const OUT_SIGNAL_G     = 7;
export const OUT_SIGNAL_B     = 8;
export const OUT_SOUND_AMP    = 9;
export const OUT_SOUND_CH     = 10;
export const OUT_WANT_BOND    = 11;
export const OUT_WANT_MATE    = 12;
export const OUT_BOND_MSG_R   = 13;     // Phase 5a → 6b — was OUT_BOND_MSG (1 ch);
                                        //   now R channel of 3-channel bondMsg
export const OUT_BOND_MSG_G   = 14;     // Phase 6b — G channel
export const OUT_BOND_MSG_B   = 15;     // Phase 6b — B channel
export const OUT_DIG          = 16;     // Thread B-2 — dig adjacent solid wall
export const OUT_DEPOSIT      = 17;     // Thread B-2 — deposit solid wall at current cell
export const N_OUTPUT = 18;
// Back-compat alias for code that still references the original single-
// channel bondMsg output (sim.js etc.). New code should use the explicit
// _R / _G / _B constants.
export const OUT_BOND_MSG     = OUT_BOND_MSG_R;

export const N_SOUND_CHANNELS = 4;

const ACT_TANH = 0, ACT_RELU = 1, ACT_SIG = 2, ACT_LIN = 3;
const N_ACT = 4;

function activate(actId, x) {
  if (actId === ACT_TANH) return Math.tanh(x);
  if (actId === ACT_RELU) return x > 0 ? x : 0;
  if (actId === ACT_SIG)  return 1 / (1 + Math.exp(-x));
  return x;
}

export class Brain {
  constructor() {
    this.enabled = new Uint8Array(N_HIDDEN_MAX);
    this.actH    = new Uint8Array(N_HIDDEN_MAX);
    this.biasH   = new Float32Array(N_HIDDEN_MAX);
    this.W_ih    = new Float32Array(N_HIDDEN_MAX * N_INPUT);
    this.W_hh    = new Float32Array(N_HIDDEN_MAX * N_HIDDEN_MAX);
    this.W_ho    = new Float32Array(N_HIDDEN_MAX * N_OUTPUT);
    this.biasO   = new Float32Array(N_OUTPUT);
    this.h       = new Float32Array(N_HIDDEN_MAX);
    this.h_new   = new Float32Array(N_HIDDEN_MAX);
  }

  enabledCount() {
    let c = 0;
    for (let i = 0; i < N_HIDDEN_MAX; i++) if (this.enabled[i]) c++;
    return c;
  }

  // Hot path — keep tight. `input` length must == N_INPUT, `output` length == N_OUTPUT.
  forward(input, output) {
    const enabled = this.enabled;
    const h = this.h;
    const h_new = this.h_new;
    const biasH = this.biasH;
    const actH = this.actH;
    const W_ih = this.W_ih;
    const W_hh = this.W_hh;
    const W_ho = this.W_ho;
    const biasO = this.biasO;

    // Hidden update
    for (let k = 0; k < N_HIDDEN_MAX; k++) {
      if (!enabled[k]) { h_new[k] = 0; continue; }
      let s = biasH[k];
      const ihOff = k * N_INPUT;
      for (let j = 0; j < N_INPUT; j++) s += W_ih[ihOff + j] * input[j];
      const hhOff = k * N_HIDDEN_MAX;
      for (let j = 0; j < N_HIDDEN_MAX; j++) {
        if (enabled[j]) s += W_hh[hhOff + j] * h[j];
      }
      h_new[k] = activate(actH[k], s);
    }
    for (let k = 0; k < N_HIDDEN_MAX; k++) h[k] = h_new[k];

    // Output
    for (let o = 0; o < N_OUTPUT; o++) {
      let s = biasO[o];
      for (let k = 0; k < N_HIDDEN_MAX; k++) {
        if (enabled[k]) s += W_ho[k * N_OUTPUT + o] * h[k];
      }
      output[o] = s;
    }
  }
}

export function makeBrain(rng = Math.random, initSlots = 4) {
  const b = new Brain();
  const slots = [];
  for (let i = 0; i < N_HIDDEN_MAX; i++) slots.push(i);
  shuffle(slots, rng);
  const n = Math.min(N_HIDDEN_MAX, Math.max(1, initSlots));
  for (let i = 0; i < n; i++) {
    enableSlot(b, slots[i], rng, /*small*/true);
  }
  for (let o = 0; o < N_OUTPUT; o++) b.biasO[o] = (rng() - 0.5) * 0.1;
  // Phase 5a — comm baseline tuning. Initial bias for visual signal RGB and
  // sound amp set to a positive mean so freshly-randomized brains land at
  // sigmoid(~0.45) ≈ 0.61 — above the comm-score baseline cut and roughly at
  // the halo-display threshold edge. Evolution can suppress if costly.
  // Comm baseline biases — wider spread than original ±0.1 so the founding
  // population shows real distribution: most are near-baseline (sigmoid≈0.5)
  // but ~15% are loud (sigmoid > 0.65) and fire visible flash events. Without
  // this spread, random init concentrates every particle's signal in a tight
  // band below the flash threshold and the metric reads zero forever.
  b.biasO[OUT_SIGNAL_R]  = 0.20 + (rng() - 0.3) * 1.4;
  b.biasO[OUT_SIGNAL_G]  = 0.20 + (rng() - 0.3) * 1.4;
  b.biasO[OUT_SIGNAL_B]  = 0.20 + (rng() - 0.3) * 1.4;
  b.biasO[OUT_SOUND_AMP] = 0.30 + (rng() - 0.5) * 0.2;
  // Predation bias — same problem as comm: default ±0.05 init meant
  // tanh(predation) was always tiny so no founder was visibly predatory.
  // Skewed slightly negative so most particles are passive but ~10-15%
  // start with a real predator drive.
  b.biasO[OUT_PREDATION] = -0.2 + (rng() - 0.35) * 1.2;
  // Multi-channel bondMsg baselines — broad spread so different brains start
  // with different "neutral" outputs across channels, giving evolution
  // independent dimensions to differentiate. Centred near zero; sigmoid01
  // applied at consumption.
  b.biasO[OUT_BOND_MSG_R] = (rng() - 0.5) * 1.2;
  b.biasO[OUT_BOND_MSG_G] = (rng() - 0.5) * 1.2;
  b.biasO[OUT_BOND_MSG_B] = (rng() - 0.5) * 1.2;
  // Wall-manipulation biases: most brains negative (won't dig at random),
  // but a small tail starts mildly positive — same shape as the predation
  // bias init so evolution has a non-vanishing seed to amplify within a
  // few thousand ticks if digging pays off.
  b.biasO[OUT_DIG]     = -0.6 + (rng() - 0.4) * 1.5;
  b.biasO[OUT_DEPOSIT] = -0.6 + (rng() - 0.4) * 1.5;
  return b;
}

function enableSlot(b, k, rng, small) {
  b.enabled[k] = 1;
  b.actH[k] = (rng() * N_ACT) | 0;
  // Phase 6 — dynamics fix. Earlier scale (0.15 × 0.5 for W_hh = 0.075)
  // produced fixed-point CTRNNs that never toggled outputs. Bumped to put
  // the network closer to "edge of chaos" so signals can dynamically pulse.
  // W_hh subscale further reduced from 0.8 → 0.45 after CPU/GPU parity
  // testing showed the original was *too* hot — CPU f64 stayed stable but
  // GPU f32 precision tipped recurrent dynamics into chaotic oscillation,
  // causing every particle to flash continuously in GPU mode. 0.45 keeps
  // meaningful recurrence without amplifying numerical drift.
  const s = small ? 0.45 : 0.6;
  b.biasH[k] = (rng() - 0.5) * 0.4;
  for (let j = 0; j < N_INPUT; j++) b.W_ih[k * N_INPUT + j] = (rng() - 0.5) * s;
  for (let j = 0; j < N_HIDDEN_MAX; j++) b.W_hh[k * N_HIDDEN_MAX + j] = (rng() - 0.5) * s * 0.45;
  for (let o = 0; o < N_OUTPUT; o++) b.W_ho[k * N_OUTPUT + o] = (rng() - 0.5) * s;
}

export function cloneBrain(src) {
  const b = new Brain();
  b.enabled.set(src.enabled);
  b.actH.set(src.actH);
  b.biasH.set(src.biasH);
  b.W_ih.set(src.W_ih);
  b.W_hh.set(src.W_hh);
  b.W_ho.set(src.W_ho);
  b.biasO.set(src.biasO);
  // h is per-individual transient state — children start fresh
  return b;
}

export function mutateBrain(src, rng = Math.random, rate = 0.04, boost = 1) {
  const b = cloneBrain(src);
  const sigma = rate * boost;
  const gauss = () => ((rng() + rng() + rng()) - 1.5) * sigma * 0.8165;

  for (let k = 0; k < N_HIDDEN_MAX; k++) {
    if (!b.enabled[k]) continue;
    if (rng() < 0.6) b.biasH[k] += gauss();
    if (rng() < 0.04) b.actH[k] = (rng() * N_ACT) | 0;
    const ihOff = k * N_INPUT;
    for (let j = 0; j < N_INPUT; j++) {
      if (rng() < 0.5) b.W_ih[ihOff + j] += gauss();
    }
    const hhOff = k * N_HIDDEN_MAX;
    for (let j = 0; j < N_HIDDEN_MAX; j++) {
      if (b.enabled[j] && rng() < 0.3) b.W_hh[hhOff + j] += gauss();
    }
    const hoOff = k * N_OUTPUT;
    for (let o = 0; o < N_OUTPUT; o++) {
      if (rng() < 0.5) b.W_ho[hoOff + o] += gauss();
    }
  }
  for (let o = 0; o < N_OUTPUT; o++) {
    if (rng() < 0.4) b.biasO[o] += gauss();
  }

  // Structural — bumped from 0.05 → 0.12 in Phase 6 to give selection enough
  // raw material to grow brain capacity beyond ~3 slots within 5–10k ticks.
  if (rng() < 0.12 * boost) {
    for (let k = 0; k < N_HIDDEN_MAX; k++) {
      if (!b.enabled[k]) {
        enableSlot(b, k, rng, /*small*/true);
        break;
      }
    }
  }
  if (rng() < 0.025 * boost) {
    let last = -1;
    for (let k = 0; k < N_HIDDEN_MAX; k++) if (b.enabled[k]) last = k;
    if (last >= 0 && b.enabledCount() > 1) {
      // Pick a random enabled slot
      const enabledIdx = [];
      for (let k = 0; k < N_HIDDEN_MAX; k++) if (b.enabled[k]) enabledIdx.push(k);
      const k = enabledIdx[(rng() * enabledIdx.length) | 0];
      b.enabled[k] = 0;
      b.h[k] = 0;
    }
  }
  return b;
}

// JSON
export function brainToJSON(b) {
  return {
    v: 1,
    enabled: Array.from(b.enabled),
    actH: Array.from(b.actH),
    biasH: Array.from(b.biasH),
    W_ih: Array.from(b.W_ih),
    W_hh: Array.from(b.W_hh),
    W_ho: Array.from(b.W_ho),
    biasO: Array.from(b.biasO),
  };
}

// Migration-aware loader. Old saves had different N_INPUT / N_OUTPUT, so a
// flat copyInto would scramble every weight after the layout change. Detect
// the source layout from array sizes and remap by (k, j) coordinates so old
// learned weights survive intact, with new sensor/output columns zero-filled.
export function brainFromJSON(o) {
  const b = new Brain();
  if (!o) return b;
  copyInto(b.enabled, o.enabled);
  copyInto(b.actH, o.actH);
  copyInto(b.biasH, o.biasH);

  if (o.W_ih) {
    const oldNInput = (o.W_ih.length / N_HIDDEN_MAX) | 0;
    const cols = Math.min(oldNInput, N_INPUT);
    if (oldNInput === N_INPUT) {
      copyInto(b.W_ih, o.W_ih);
    } else {
      for (let k = 0; k < N_HIDDEN_MAX; k++) {
        const oldOff = k * oldNInput;
        const newOff = k * N_INPUT;
        for (let j = 0; j < cols; j++) b.W_ih[newOff + j] = o.W_ih[oldOff + j];
      }
    }
  }
  if (o.W_hh) {
    // W_hh dimensions only depend on N_HIDDEN_MAX which hasn't changed.
    copyInto(b.W_hh, o.W_hh);
  }
  if (o.W_ho) {
    const oldNOutput = (o.W_ho.length / N_HIDDEN_MAX) | 0;
    const cols = Math.min(oldNOutput, N_OUTPUT);
    if (oldNOutput === N_OUTPUT) {
      copyInto(b.W_ho, o.W_ho);
    } else {
      for (let k = 0; k < N_HIDDEN_MAX; k++) {
        const oldOff = k * oldNOutput;
        const newOff = k * N_OUTPUT;
        for (let oo = 0; oo < cols; oo++) b.W_ho[newOff + oo] = o.W_ho[oldOff + oo];
      }
    }
  }
  if (o.biasO) {
    const n = Math.min(o.biasO.length, N_OUTPUT);
    for (let oi = 0; oi < n; oi++) b.biasO[oi] = o.biasO[oi];
  }
  return b;
}

function copyInto(dst, src) {
  if (!src) return;
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] = src[i];
}

// GPU upload layout — flat float layout matching WGSL Brain struct.
// Offsets (in floats) — all derived from N_INPUT / N_OUTPUT below so changes
// flow through automatically. With Thread B-2 bumps (N_INPUT=37, N_OUTPUT=18):
//   0..7    : enabled (0.0/1.0)
//   8..15   : actH    (0..3)
//   16..23  : biasH
//   24..319 : W_ih    (k-major: k*N_INPUT + j, 8*37=296)
//   320..383: W_hh    (k-major: k*N_HIDDEN_MAX + j, 8*8=64)
//   384..527: W_ho    (k-major: k*N_OUTPUT + o, 8*18=144)
//   528..545: biasO   (18 floats)
//   546..559: pad     (round to multiple of 16 → BRAIN_PACK_STRIDE = 560)
export const BRAIN_OFF_ENABLED = 0;
export const BRAIN_OFF_ACTH    = 8;
export const BRAIN_OFF_BIASH   = 16;
export const BRAIN_OFF_WIH     = 24;
export const BRAIN_OFF_WHH     = BRAIN_OFF_WIH + N_HIDDEN_MAX * N_INPUT;       // 192
export const BRAIN_OFF_WHO     = BRAIN_OFF_WHH + N_HIDDEN_MAX * N_HIDDEN_MAX;  // 256
export const BRAIN_OFF_BIASO   = BRAIN_OFF_WHO + N_HIDDEN_MAX * N_OUTPUT;      // 368
export const BRAIN_PACK_STRIDE = Math.ceil((BRAIN_OFF_BIASO + N_OUTPUT) / 16) * 16; // 384

export function packBrain(b, out, offset) {
  for (let k = 0; k < N_HIDDEN_MAX; k++) {
    out[offset + BRAIN_OFF_ENABLED + k] = b.enabled[k] ? 1 : 0;
    out[offset + BRAIN_OFF_ACTH + k]    = b.actH[k];
    out[offset + BRAIN_OFF_BIASH + k]   = b.biasH[k];
  }
  const ihOff = offset + BRAIN_OFF_WIH;
  const Wih = b.W_ih;
  for (let i = 0; i < N_HIDDEN_MAX * N_INPUT; i++) out[ihOff + i] = Wih[i];
  const hhOff = offset + BRAIN_OFF_WHH;
  const Whh = b.W_hh;
  for (let i = 0; i < N_HIDDEN_MAX * N_HIDDEN_MAX; i++) out[hhOff + i] = Whh[i];
  const hoOff = offset + BRAIN_OFF_WHO;
  const Who = b.W_ho;
  for (let i = 0; i < N_HIDDEN_MAX * N_OUTPUT; i++) out[hoOff + i] = Who[i];
  const boOff = offset + BRAIN_OFF_BIASO;
  for (let o = 0; o < N_OUTPUT; o++) out[boOff + o] = b.biasO[o];
}

// Per-slot crossover for sexual reproduction. Each hidden slot is taken
// wholesale from one parent (preserves the slot's input/output weight
// coherence) so beneficial circuits aren't broken by gene-by-gene mixing.
export function crossoverBrain(a, b, rng = Math.random) {
  const out = cloneBrain(a);
  for (let k = 0; k < N_HIDDEN_MAX; k++) {
    if (rng() < 0.5) {
      out.enabled[k] = b.enabled[k];
      out.actH[k] = b.actH[k];
      out.biasH[k] = b.biasH[k];
      const ihOff = k * N_INPUT;
      for (let j = 0; j < N_INPUT; j++) out.W_ih[ihOff + j] = b.W_ih[ihOff + j];
      const hhOff = k * N_HIDDEN_MAX;
      for (let j = 0; j < N_HIDDEN_MAX; j++) out.W_hh[hhOff + j] = b.W_hh[hhOff + j];
      const hoOff = k * N_OUTPUT;
      for (let o = 0; o < N_OUTPUT; o++) out.W_ho[hoOff + o] = b.W_ho[hoOff + o];
    }
  }
  for (let o = 0; o < N_OUTPUT; o++) {
    if (rng() < 0.5) out.biasO[o] = b.biasO[o];
  }
  return out;
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
}
