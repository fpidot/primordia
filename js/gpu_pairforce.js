// gpu_pairforce.js — Phase 4c + 4d + 4e
//
// Two compute pipelines run per tick:
//   1. pair_force — for each particle, scans neighbors in 3×3 hash cells,
//      accumulates the same pair force the CPU loop computes (short-range
//      repulsion + tent-shaped attraction band, asymmetric), AND accumulates
//      per-particle stats: ownN/alienN counts, neighbor velocity sum,
//      signal-RGB sum, signal-emitter count, crowd count.
//   2. brain_forward — for each particle, builds the same input vector the
//      CPU brain forward would build (using stats from pair_force, particle
//      state, and CPU-provided chem-extras), runs the CTRNN forward pass
//      using GPU-resident brain weights and persistent state, writes brain
//      outputs and updated state to the result buffer.
//
// The CPU consumes a compact 40-float-per-particle ParticleResult struct that
// bundles forces, minimal stats, and brain outputs. Hidden brain state stays
// resident on the GPU between dispatches and is only reset on structural changes. CPU then runs:
// integration, brushes, predation drains, bond physics, reproduction, deaths,
// field updates, and brain mutation on births.
//
// Brain weights live on the GPU. They're re-uploaded only when any brain
// changed since the last tick (births, sexual repro, death-removed slots).
// The CPU sets `world._brainsDirty = true` after any structural change.

import {
  N_HIDDEN_MAX, N_INPUT, N_OUTPUT, N_SOUND_CHANNELS, BRAIN_PACK_STRIDE, packBrain,
  BRAIN_OFF_ENABLED, BRAIN_OFF_ACTH, BRAIN_OFF_BIASH,
  BRAIN_OFF_WIH, BRAIN_OFF_WHH, BRAIN_OFF_WHO, BRAIN_OFF_BIASO,
} from './brain.js';

// ── Layouts ─────────────────────────────────────────────────────────
const PARTICLE_STRIDE_F32 = 16;
const RESULT_STRIDE_F32   = 30;       // forces+stats(12) + outputs(18); h stays GPU-resident
const EXTRAS_STRIDE_F32   = 36;       // chem + sound + bondMsg + cluster + wallCarry + terrain proximity
const BRAIN_STRIDE_F32    = BRAIN_PACK_STRIDE;
const STATE_STRIDE_F32    = N_HIDDEN_MAX + 8; // h state + GPU-only quadrant scratch
const PARAMS_SIZE         = 32;
const WORKGROUP_SIZE      = 64;
const CROWD_RADIUS        = 14.0;
// Extras-buffer layout (must match sim.js prefill):
//   0..5  : food, decay, food.dx, food.dy, decay.dx, decay.dy
//   6..9  : sound[0..3]
//   10    : bond.msg.r (was 'bond.msg' single channel — kept at 10 for back-compat)
//   11    : bond.msg.g
//   12    : bond.msg.b
//   13..14: cluster.dx, cluster.dy
//   15    : cluster.size  (saturating curve over member count)
//   16    : cluster.member (1.0 if in any named cluster else 0)
//   17    : cluster.alarm  (Phase 6c — fast cluster-wide broadcast)
//   18    : wall.carry
//   19..22: wall proximity n/s/e/w
//   23..26: mud proximity n/s/e/w
//   27    : terrain.mud underfoot
//   28..31: solid proximity n/s/e/w
//   32..35: glass proximity n/s/e/w
const EXTRAS_BOND_MSG_R_OFFSET = 10;
const EXTRAS_BOND_MSG_G_OFFSET = 11;
const EXTRAS_BOND_MSG_B_OFFSET = 12;
const EXTRAS_CLUSTER_DX_OFFSET = 13;
const EXTRAS_CLUSTER_DY_OFFSET = 14;
const EXTRAS_CLUSTER_SIZE_OFFSET = 15;
const EXTRAS_CLUSTER_MEMBER_OFFSET = 16;
const EXTRAS_CLUSTER_ALARM_OFFSET = 17;

// Result struct field offsets — matches WGSL ParticleResult layout
export const RESULT_STRIDE   = RESULT_STRIDE_F32;
export const RES_FX          = 0;
export const RES_FY          = 1;
export const RES_NBVX        = 2;
export const RES_NBVY        = 3;
export const RES_SIGR        = 4;
export const RES_SIGG        = 5;
export const RES_SIGB        = 6;
export const RES_SIGN        = 7;
export const RES_OWNN        = 8;
export const RES_ALIENN      = 9;
export const RES_CROWD       = 10;
// 11: pad
// Thread B-2 layout: outputs grew 16→18 to add OUT_DIG / OUT_DEPOSIT.
// Directional quadrant stats and hidden brain state stay GPU-only, so readback
// fits in 30 floats.
export const RES_OUT0        = 12;   // brain outputs 0..17 occupy 12..29

// ── WGSL ────────────────────────────────────────────────────────────
const WGSL = /* wgsl */ `
const N_HIDDEN: u32 = ${N_HIDDEN_MAX}u;
const N_INPUT:  u32 = ${N_INPUT}u;
const N_OUTPUT: u32 = ${N_OUTPUT}u;
const BRAIN_STRIDE: u32 = ${BRAIN_STRIDE_F32}u;
const STATE_STRIDE: u32 = ${STATE_STRIDE_F32}u;
const EXTRAS_STRIDE: u32 = ${EXTRAS_STRIDE_F32}u;

// Brain layout offsets (in floats, within a single brain block of length BRAIN_STRIDE)
const BO_ENABLED: u32 = ${BRAIN_OFF_ENABLED}u;
const BO_ACTH:    u32 = ${BRAIN_OFF_ACTH}u;
const BO_BIASH:   u32 = ${BRAIN_OFF_BIASH}u;
const BO_WIH:     u32 = ${BRAIN_OFF_WIH}u;       // N_HIDDEN_MAX × N_INPUT
const BO_WHH:     u32 = ${BRAIN_OFF_WHH}u;       // N_HIDDEN_MAX × N_HIDDEN_MAX
const BO_WHO:     u32 = ${BRAIN_OFF_WHO}u;       // N_HIDDEN_MAX × N_OUTPUT
const BO_BIASO:   u32 = ${BRAIN_OFF_BIASO}u;     // N_OUTPUT

struct Particle {
  pos: vec2f,
  vel: vec2f,
  species: u32,
  alive: u32,
  sense_radius: f32,
  cohesion: f32,
  signalR: f32,
  signalG: f32,
  signalB: f32,
  pad0: f32,
  energy: f32,
  age: f32,
  pad1: f32,
  pad2: f32,
};

struct ParticleResult {
  fx: f32, fy: f32,
  nbVx: f32, nbVy: f32,
  sigR: f32, sigG: f32, sigB: f32, sigN: f32,
  ownN: f32, alienN: f32,
  crowd: f32, pad0: f32,
  // Brain outputs 0..17 (18 outputs — Thread B-2 adds OUT_DIG / OUT_DEPOSIT)
  o0:  f32, o1:  f32, o2:  f32, o3:  f32,
  o4:  f32, o5:  f32, o6:  f32, o7:  f32,
  o8:  f32, o9:  f32, o10: f32, o11: f32,
  o12: f32, o13: f32, o14: f32, o15: f32,
  o16: f32, o17: f32,
};

struct Params {
  hash_cell: f32,
  hash_w: i32,
  hash_h: i32,
  particle_count: u32,
  num_species: u32,
  r_close: f32,
  k_rep: f32,
  k_attr: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> attraction: array<f32>;
@group(0) @binding(3) var<storage, read_write> results: array<ParticleResult>;
@group(0) @binding(4) var<storage, read_write> hashHead: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read_write> hashNext: array<i32>;
@group(0) @binding(6) var<storage, read> brains: array<f32>;
@group(0) @binding(7) var<storage, read_write> brainState: array<f32>;
@group(0) @binding(8) var<storage, read> extras: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn clear_hash(@builtin(global_invocation_id) id: vec3u) {
  let i = i32(id.x);
  if (i < params.hash_w * params.hash_h) {
    atomicStore(&hashHead[i], -1);
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn build_hash(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.particle_count) { return; }
  let p = particles[i];
  if (p.alive == 0u) {
    hashNext[i] = -1;
    return;
  }
  let cx = clamp(i32(p.pos.x / params.hash_cell), 0, params.hash_w - 1);
  let cy = clamp(i32(p.pos.y / params.hash_cell), 0, params.hash_h - 1);
  let cell = cy * params.hash_w + cx;
  let prev = atomicExchange(&hashHead[cell], i32(i));
  hashNext[i] = prev;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn pair_force(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.particle_count) { return; }
  let p = particles[i];
  if (p.alive == 0u) {
    let so = i * STATE_STRIDE;
    results[i].fx = 0.0; results[i].fy = 0.0;
    results[i].nbVx = 0.0; results[i].nbVy = 0.0;
    results[i].sigR = 0.0; results[i].sigG = 0.0; results[i].sigB = 0.0;
    results[i].sigN = 0.0; results[i].ownN = 0.0; results[i].alienN = 0.0;
    results[i].crowd = 0.0;
    for (var q: u32 = 0u; q < 8u; q = q + 1u) {
      brainState[so + N_HIDDEN + q] = 0.0;
    }
    return;
  }

  let R = p.sense_radius;
  let R2 = R * R;
  let cx = clamp(i32(p.pos.x / params.hash_cell), 0, params.hash_w - 1);
  let cy = clamp(i32(p.pos.y / params.hash_cell), 0, params.hash_h - 1);
  let attrOff = i * params.num_species;
  let crowdR: f32 = ${CROWD_RADIUS.toFixed(2)};

  var ax: f32 = 0.0;
  var ay: f32 = 0.0;
  var ownN: f32 = 0.0;
  var alienN: f32 = 0.0;
  var nbVx: f32 = 0.0;
  var nbVy: f32 = 0.0;
  var sigR: f32 = 0.0;
  var sigG: f32 = 0.0;
  var sigB: f32 = 0.0;
  var sigN: f32 = 0.0;
  var crowd: f32 = 0.0;
  // Phase 5b — per-quadrant accumulators (NE, SE, SW, NW)
  var qcnt0: f32 = 0.0; var qcnt1: f32 = 0.0; var qcnt2: f32 = 0.0; var qcnt3: f32 = 0.0;
  var qsig0: f32 = 0.0; var qsig1: f32 = 0.0; var qsig2: f32 = 0.0; var qsig3: f32 = 0.0;
  var qsigN0: f32 = 0.0; var qsigN1: f32 = 0.0; var qsigN2: f32 = 0.0; var qsigN3: f32 = 0.0;

  for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
    let ny = cy + dy;
    if (ny < 0 || ny >= params.hash_h) { continue; }
    for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
      let nx = cx + dx;
      if (nx < 0 || nx >= params.hash_w) { continue; }
      let cell = ny * params.hash_w + nx;
      var j: i32 = atomicLoad(&hashHead[cell]);
      var iter: u32 = 0u;
      loop {
        if (j == -1) { break; }
        if (iter >= 1024u) { break; }
        iter = iter + 1u;
        if (u32(j) != i) {
          let q = particles[j];
          if (q.alive != 0u) {
            let dpos = q.pos - p.pos;
            let d2 = dot(dpos, dpos);
            if (d2 < R2 && d2 > 1.0e-6) {
              let d = sqrt(d2);
              let invd = 1.0 / d;
              if (d < crowdR) { crowd = crowd + 1.0; }
              if (q.species == p.species) { ownN = ownN + 1.0; }
              else { alienN = alienN + 1.0; }
              nbVx = nbVx + q.vel.x;
              nbVy = nbVy + q.vel.y;
              let att = 1.0 - d / R;
              let sigMag = (q.signalR + q.signalG + q.signalB) / 3.0;
              if (q.signalR > 0.01 || q.signalG > 0.01 || q.signalB > 0.01) {
                sigR = sigR + q.signalR * att;
                sigG = sigG + q.signalG * att;
                sigB = sigB + q.signalB * att;
                sigN = sigN + 1.0;
              }
              // Phase 5b — quadrant binning by relative position
              if (dpos.x >= 0.0) {
                if (dpos.y < 0.0) {
                  qcnt0 = qcnt0 + 1.0; qsig0 = qsig0 + sigMag * att; qsigN0 = qsigN0 + 1.0;
                } else {
                  qcnt1 = qcnt1 + 1.0; qsig1 = qsig1 + sigMag * att; qsigN1 = qsigN1 + 1.0;
                }
              } else {
                if (dpos.y >= 0.0) {
                  qcnt2 = qcnt2 + 1.0; qsig2 = qsig2 + sigMag * att; qsigN2 = qsigN2 + 1.0;
                } else {
                  qcnt3 = qcnt3 + 1.0; qsig3 = qsig3 + sigMag * att; qsigN3 = qsigN3 + 1.0;
                }
              }
              if (d < params.r_close) {
                let f = -params.k_rep * (1.0 - d / params.r_close);
                ax = ax + dpos.x * invd * f;
                ay = ay + dpos.y * invd * f;
              } else {
                var a: f32;
                if (q.species == p.species) {
                  a = p.cohesion;
                } else {
                  a = attraction[attrOff + q.species];
                }
                if (abs(a) > 1.0e-4) {
                  let t = (d - params.r_close) / (R - params.r_close);
                  let tent = 1.0 - abs(2.0 * t - 1.0);
                  if (tent > 0.0) {
                    let f = params.k_attr * a * tent;
                    ax = ax + dpos.x * invd * f;
                    ay = ay + dpos.y * invd * f;
                  }
                }
              }
            }
          }
        }
        j = hashNext[u32(j)];
      }
    }
  }

  results[i].fx = ax;     results[i].fy = ay;
  results[i].nbVx = nbVx; results[i].nbVy = nbVy;
  results[i].sigR = sigR; results[i].sigG = sigG; results[i].sigB = sigB;
  results[i].sigN = sigN;
  results[i].ownN = ownN; results[i].alienN = alienN;
  results[i].crowd = crowd;
  // Phase 5b — per-quadrant outputs. Signals are stored as means (per-quadrant
  // sum / count) so the brain shader can use them directly without divide.
  let so = i * STATE_STRIDE;
  brainState[so + N_HIDDEN + 0u] = qcnt0;
  brainState[so + N_HIDDEN + 1u] = qcnt1;
  brainState[so + N_HIDDEN + 2u] = qcnt2;
  brainState[so + N_HIDDEN + 3u] = qcnt3;
  brainState[so + N_HIDDEN + 4u] = select(0.0, qsig0 / qsigN0, qsigN0 > 0.0);
  brainState[so + N_HIDDEN + 5u] = select(0.0, qsig1 / qsigN1, qsigN1 > 0.0);
  brainState[so + N_HIDDEN + 6u] = select(0.0, qsig2 / qsigN2, qsigN2 > 0.0);
  brainState[so + N_HIDDEN + 7u] = select(0.0, qsig3 / qsigN3, qsigN3 > 0.0);
}

fn act(actId: u32, x: f32) -> f32 {
  if (actId == 0u) { return tanh(x); }
  if (actId == 1u) { if (x > 0.0) { return x; } else { return 0.0; } }
  if (actId == 2u) { return 1.0 / (1.0 + exp(-x)); }
  return x;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn brain_forward(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.particle_count) { return; }
  let p = particles[i];
  if (p.alive == 0u) { return; }

  let bo = i * BRAIN_STRIDE;
  let so = i * STATE_STRIDE;
  let eo = i * EXTRAS_STRIDE;
  let res = results[i];

  // Build input vector
  var inp: array<f32, ${N_INPUT}>;
  inp[0]  = 1.0;
  inp[1]  = tanh(p.energy * 0.15 - 0.5);
  inp[2]  = tanh(p.age / 600.0);
  inp[3]  = extras[eo + 0u];     // chem.food at cell (CPU pre-tanh'd)
  inp[4]  = extras[eo + 1u];     // chem.decay
  inp[5]  = extras[eo + 2u];     // food.dx
  inp[6]  = extras[eo + 3u];     // food.dy
  inp[7]  = extras[eo + 4u];     // decay.dx
  inp[8]  = extras[eo + 5u];     // decay.dy
  inp[9]  = tanh(res.ownN * 0.3);
  inp[10] = tanh(res.alienN * 0.3);
  let totalNb = res.ownN + res.alienN;
  if (totalNb > 0.0) {
    inp[11] = tanh(res.nbVx / totalNb);
    inp[12] = tanh(res.nbVy / totalNb);
  } else {
    inp[11] = 0.0;
    inp[12] = 0.0;
  }
  if (res.sigN > 0.0) {
    let inv = 1.0 / res.sigN;
    inp[13] = tanh(res.sigR * inv * 1.5);
    inp[14] = tanh(res.sigG * inv * 1.5);
    inp[15] = tanh(res.sigB * inv * 1.5);
  } else {
    inp[13] = 0.0; inp[14] = 0.0; inp[15] = 0.0;
  }
  inp[16] = extras[eo + 6u];
  inp[17] = extras[eo + 7u];
  inp[18] = extras[eo + 8u];
  inp[19] = extras[eo + 9u];
  inp[20] = extras[eo + 10u];     // Phase 5a → 6b — bond.msg.r (was 'bond.msg')
  // Phase 5b — directional sensors. Counts normalized via tanh; signals are
  // already means in [0, ~1] so re-tanh maps them into [-1, 1] symmetrically.
  inp[21] = tanh(brainState[so + N_HIDDEN + 0u] * 0.3);
  inp[22] = tanh(brainState[so + N_HIDDEN + 1u] * 0.3);
  inp[23] = tanh(brainState[so + N_HIDDEN + 2u] * 0.3);
  inp[24] = tanh(brainState[so + N_HIDDEN + 3u] * 0.3);
  inp[25] = tanh(brainState[so + N_HIDDEN + 4u] * 2.0 - 1.0);
  inp[26] = tanh(brainState[so + N_HIDDEN + 5u] * 2.0 - 1.0);
  inp[27] = tanh(brainState[so + N_HIDDEN + 6u] * 2.0 - 1.0);
  inp[28] = tanh(brainState[so + N_HIDDEN + 7u] * 2.0 - 1.0);
  inp[29] = extras[eo + 11u];     // Phase 6b — bond.msg.g
  inp[30] = extras[eo + 12u];     // Phase 6b — bond.msg.b
  inp[31] = extras[eo + 13u];     // Phase 6a — cluster.dx (relative to centroid)
  inp[32] = extras[eo + 14u];     // Phase 6a — cluster.dy
  inp[33] = extras[eo + 15u];     // Phase 6a — cluster.size (saturating)
  inp[34] = extras[eo + 16u];     // Phase 6a — cluster.member (0/1)
  inp[35] = extras[eo + 17u];     // Phase 6c — cluster.alarm broadcast
  inp[36] = extras[eo + 18u];     // Thread B-2 — wall.carry (0..1)
  inp[37] = extras[eo + 19u];     // Thread B-2 — wall.n proximity
  inp[38] = extras[eo + 20u];     // Thread B-2 — wall.s
  inp[39] = extras[eo + 21u];     // Thread B-2 — wall.e
  inp[40] = extras[eo + 22u];     // Thread B-2 — wall.w
  inp[41] = extras[eo + 23u];     // mud.n proximity
  inp[42] = extras[eo + 24u];     // mud.s
  inp[43] = extras[eo + 25u];     // mud.e
  inp[44] = extras[eo + 26u];     // mud.w
  inp[45] = extras[eo + 27u];     // terrain.mud underfoot
  inp[46] = extras[eo + 28u];     // solid.n proximity
  inp[47] = extras[eo + 29u];     // solid.s
  inp[48] = extras[eo + 30u];     // solid.e
  inp[49] = extras[eo + 31u];     // solid.w
  inp[50] = extras[eo + 32u];     // glass.n proximity
  inp[51] = extras[eo + 33u];     // glass.s
  inp[52] = extras[eo + 34u];     // glass.e
  inp[53] = extras[eo + 35u];     // glass.w

  // Forward — compute new hidden state
  var h_new: array<f32, ${N_HIDDEN_MAX}>;
  for (var k: u32 = 0u; k < N_HIDDEN; k = k + 1u) {
    if (brains[bo + BO_ENABLED + k] < 0.5) {
      h_new[k] = 0.0;
      continue;
    }
    var s: f32 = brains[bo + BO_BIASH + k];
    let ihOff = bo + BO_WIH + k * N_INPUT;
    for (var j: u32 = 0u; j < N_INPUT; j = j + 1u) {
      s = s + brains[ihOff + j] * inp[j];
    }
    let hhOff = bo + BO_WHH + k * N_HIDDEN;
    for (var j: u32 = 0u; j < N_HIDDEN; j = j + 1u) {
      if (brains[bo + BO_ENABLED + j] >= 0.5) {
        s = s + brains[hhOff + j] * brainState[so + j];
      }
    }
    let actId = u32(brains[bo + BO_ACTH + k]);
    h_new[k] = act(actId, s);
  }

  // Persist new hidden state on GPU. The CPU does not need this every tick:
  // children start with fresh transient state, saves omit it, and CPU fallback
  // can tolerate a cold state after GPU mode is toggled off.
  for (var k: u32 = 0u; k < N_HIDDEN; k = k + 1u) {
    brainState[so + k] = h_new[k];
  }

  // Compute outputs — all N_OUTPUT (18 with Thread B-2: dig + deposit).
  var out_0:  f32 = brains[bo + BO_BIASO + 0u];
  var out_1:  f32 = brains[bo + BO_BIASO + 1u];
  var out_2:  f32 = brains[bo + BO_BIASO + 2u];
  var out_3:  f32 = brains[bo + BO_BIASO + 3u];
  var out_4:  f32 = brains[bo + BO_BIASO + 4u];
  var out_5:  f32 = brains[bo + BO_BIASO + 5u];
  var out_6:  f32 = brains[bo + BO_BIASO + 6u];
  var out_7:  f32 = brains[bo + BO_BIASO + 7u];
  var out_8:  f32 = brains[bo + BO_BIASO + 8u];
  var out_9:  f32 = brains[bo + BO_BIASO + 9u];
  var out_10: f32 = brains[bo + BO_BIASO + 10u];
  var out_11: f32 = brains[bo + BO_BIASO + 11u];
  var out_12: f32 = brains[bo + BO_BIASO + 12u];
  var out_13: f32 = brains[bo + BO_BIASO + 13u];
  var out_14: f32 = brains[bo + BO_BIASO + 14u];
  var out_15: f32 = brains[bo + BO_BIASO + 15u];
  var out_16: f32 = brains[bo + BO_BIASO + 16u];
  var out_17: f32 = brains[bo + BO_BIASO + 17u];
  for (var k: u32 = 0u; k < N_HIDDEN; k = k + 1u) {
    if (brains[bo + BO_ENABLED + k] >= 0.5) {
      let woff = bo + BO_WHO + k * N_OUTPUT;
      let hk = h_new[k];
      out_0  = out_0  + brains[woff + 0u]  * hk;
      out_1  = out_1  + brains[woff + 1u]  * hk;
      out_2  = out_2  + brains[woff + 2u]  * hk;
      out_3  = out_3  + brains[woff + 3u]  * hk;
      out_4  = out_4  + brains[woff + 4u]  * hk;
      out_5  = out_5  + brains[woff + 5u]  * hk;
      out_6  = out_6  + brains[woff + 6u]  * hk;
      out_7  = out_7  + brains[woff + 7u]  * hk;
      out_8  = out_8  + brains[woff + 8u]  * hk;
      out_9  = out_9  + brains[woff + 9u]  * hk;
      out_10 = out_10 + brains[woff + 10u] * hk;
      out_11 = out_11 + brains[woff + 11u] * hk;
      out_12 = out_12 + brains[woff + 12u] * hk;
      out_13 = out_13 + brains[woff + 13u] * hk;
      out_14 = out_14 + brains[woff + 14u] * hk;
      out_15 = out_15 + brains[woff + 15u] * hk;
      out_16 = out_16 + brains[woff + 16u] * hk;
      out_17 = out_17 + brains[woff + 17u] * hk;
    }
  }

  results[i].o0 = out_0;   results[i].o1 = out_1;
  results[i].o2 = out_2;   results[i].o3 = out_3;
  results[i].o4 = out_4;   results[i].o5 = out_5;
  results[i].o6 = out_6;   results[i].o7 = out_7;
  results[i].o8 = out_8;   results[i].o9 = out_9;
  results[i].o10 = out_10; results[i].o11 = out_11;
  results[i].o12 = out_12; results[i].o13 = out_13;
  results[i].o14 = out_14; results[i].o15 = out_15;
  results[i].o16 = out_16; results[i].o17 = out_17;
}
`;

// ── Class ───────────────────────────────────────────────────────────
export class GPUPairForce {
  /**
   * @param {GPUDevice} device
   * @param {{
   *   maxParticles: number,
   *   hashW: number, hashH: number, hashCell: number,
   *   numSpecies: number,
   *   rClose: number, kRep: number, kAttr: number,
   * }} opts
   */
  constructor(device, opts) {
    this.device = device;
    this.opts = opts;
    this.maxParticles = opts.maxParticles;
    this.numSpecies = opts.numSpecies;

    this._setup();

    // CPU-side staging buffers (re-used each tick)
    this.particleStaging = new Float32Array(this.maxParticles * PARTICLE_STRIDE_F32);
    this.particleStagingU32 = new Uint32Array(this.particleStaging.buffer);
    this.attractionStaging = new Float32Array(this.maxParticles * this.numSpecies);
    this.brainStaging = new Float32Array(this.maxParticles * BRAIN_STRIDE_F32);
    this.brainStateStaging = new Float32Array(this.maxParticles * STATE_STRIDE_F32);
    this.extrasStaging = new Float32Array(this.maxParticles * EXTRAS_STRIDE_F32);
    this.paramsStaging = new ArrayBuffer(PARAMS_SIZE);
    this.paramsView = new DataView(this.paramsStaging);
    this.resultsCPU = new Float32Array(this.maxParticles * RESULT_STRIDE_F32);

    this._uploadedCount = 0;
    this._brainsUploadedCount = 0;
    this.dispatchCount = 0;
    this.lastDispatchMs = 0;
    this.lastReadbackMs = 0;
    this.lastUploadMs = 0;
    this.lastError = null;
  }

  _setup() {
    const d = this.device;
    const N = this.maxParticles;
    const HW = this.opts.hashW, HH = this.opts.hashH;

    this.particlesBuf = d.createBuffer({
      size: N * PARTICLE_STRIDE_F32 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.attractionBuf = d.createBuffer({
      size: N * this.numSpecies * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.resultsBuf = d.createBuffer({
      size: N * RESULT_STRIDE_F32 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.hashHeadBuf = d.createBuffer({
      size: HW * HH * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    this.hashNextBuf = d.createBuffer({
      size: N * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    this.paramsBuf = d.createBuffer({
      size: PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.brainsBuf = d.createBuffer({
      size: N * BRAIN_STRIDE_F32 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.brainStateBuf = d.createBuffer({
      size: N * STATE_STRIDE_F32 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.extrasBuf = d.createBuffer({
      size: N * EXTRAS_STRIDE_F32 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.readBackBuf = d.createBuffer({
      size: N * RESULT_STRIDE_F32 * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Stash WGSL source for programmatic inspection (useful when chasing a
    // pipeline-creation failure — paste from `world._gpu.wgslSource`).
    this.wgslSource = WGSL;
    this.module = d.createShaderModule({ code: WGSL, label: 'primordia.kernel.4e' });
    // Surface WGSL compile errors / warnings into console so failures are
    // diagnosable. Without this, an invalid pipeline silently fires
    // "Invalid ComputePipeline" GPUValidationErrors every dispatch with no
    // hint at the underlying cause.
    this.module.getCompilationInfo().then(info => {
      if (!info || !info.messages || info.messages.length === 0) {
        console.log('[primordia.wgsl] compilationInfo: no messages (shader compiled clean)');
        return;
      }
      for (const msg of info.messages) {
        const tag = `[primordia.wgsl ${msg.type}] ${msg.message}` +
                    (msg.lineNum ? ` (line ${msg.lineNum}, col ${msg.linePos})` : '');
        if (msg.type === 'error') console.error(tag);
        else console.warn(tag);
      }
      this.compilationMessages = info.messages;
    }).catch(err => {
      console.warn('[primordia.wgsl] could not fetch compilationInfo', err);
    });

    this.layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [this.layout] });

    // Wrap each pipeline creation in an error scope so we get the *specific*
    // validation error per entry point with the underlying reason, instead
    // of the downstream "Invalid ComputePipeline" mess that floods every
    // dispatch.
    const tryCreate = (entryPoint) => {
      d.pushErrorScope('validation');
      const pipe = d.createComputePipeline({
        layout: pipelineLayout,
        compute: { module: this.module, entryPoint },
        label: `primordia.${entryPoint}`,
      });
      d.popErrorScope().then(err => {
        if (err) console.error(`[primordia.pipeline ${entryPoint}]`, err.message);
      });
      return pipe;
    };
    this.clearPipeline = tryCreate('clear_hash');
    this.buildPipeline = tryCreate('build_hash');
    this.pairPipeline  = tryCreate('pair_force');
    this.brainPipeline = tryCreate('brain_forward');

    this.bindGroup = d.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuf } },
        { binding: 1, resource: { buffer: this.particlesBuf } },
        { binding: 2, resource: { buffer: this.attractionBuf } },
        { binding: 3, resource: { buffer: this.resultsBuf } },
        { binding: 4, resource: { buffer: this.hashHeadBuf } },
        { binding: 5, resource: { buffer: this.hashNextBuf } },
        { binding: 6, resource: { buffer: this.brainsBuf } },
        { binding: 7, resource: { buffer: this.brainStateBuf } },
        { binding: 8, resource: { buffer: this.extrasBuf } },
      ],
    });
  }

  // Pack particle physics state (one writeBuffer)
  upload(particles) {
    const t0 = performance.now();
    const count = Math.min(particles.length, this.maxParticles);
    const stride = PARTICLE_STRIDE_F32;
    const arr = this.particleStaging;
    const u32 = this.particleStagingU32;
    const attr = this.attractionStaging;
    const NSP = this.numSpecies;

    for (let i = 0; i < count; i++) {
      const p = particles[i];
      const o = i * stride;
      arr[o]      = p.x;
      arr[o + 1]  = p.y;
      arr[o + 2]  = p.vx;
      arr[o + 3]  = p.vy;
      u32[o + 4]  = p.species | 0;
      u32[o + 5]  = p.dead ? 0 : 1;
      const g = p.genome;
      arr[o + 6]  = g.sense_radius;
      arr[o + 7]  = g.cohesion;
      arr[o + 8]  = p.signalR;
      arr[o + 9]  = p.signalG;
      arr[o + 10] = p.signalB;
      // pad0 at 11
      arr[o + 12] = p.energy;
      arr[o + 13] = p.age;
      // pad1, pad2 at 14, 15
      const aOff = i * NSP;
      const att = g.attraction;
      for (let j = 0; j < NSP; j++) attr[aOff + j] = att[j];
    }
    if (this._uploadedCount > count) {
      for (let i = count; i < this._uploadedCount; i++) {
        u32[i * stride + 5] = 0;
      }
    }
    const queue = this.device.queue;
    const sentCount = Math.max(count, this._uploadedCount);
    queue.writeBuffer(this.particlesBuf, 0, arr.buffer, 0, sentCount * stride * 4);
    queue.writeBuffer(this.attractionBuf, 0, attr.buffer, 0, count * NSP * 4);
    this._writeParams(count);
    this._uploadedCount = count;
    this.lastUploadMs = performance.now() - t0;
  }

  // Pack and upload brain weights for every particle. Caller invokes only when
  // any brain mutated since the last call (births / sexual repro / removal).
  uploadBrains(particles) {
    const count = Math.min(particles.length, this.maxParticles);
    const arr = this.brainStaging;
    for (let i = 0; i < count; i++) {
      const b = particles[i].genome.brain;
      packBrain(b, arr, i * BRAIN_STRIDE_F32);
    }
    this.device.queue.writeBuffer(this.brainsBuf, 0, arr.buffer, 0, count * BRAIN_STRIDE_F32 * 4);
    this._brainsUploadedCount = count;
  }

  // Upload current per-particle h state. The tail of each state row is
  // GPU-only quadrant scratch, reset here because pair_force will refill it.
  uploadBrainState(particles) {
    const count = Math.min(particles.length, this.maxParticles);
    const arr = this.brainStateStaging;
    for (let i = 0; i < count; i++) {
      const h = particles[i].genome.brain.h;
      const o = i * STATE_STRIDE_F32;
      for (let k = 0; k < N_HIDDEN_MAX; k++) arr[o + k] = h[k] || 0;
      for (let k = N_HIDDEN_MAX; k < STATE_STRIDE_F32; k++) arr[o + k] = 0;
    }
    this.device.queue.writeBuffer(this.brainStateBuf, 0, arr.buffer, 0, count * STATE_STRIDE_F32 * 4);
  }

  // Upload chem-extras (CPU pre-samples field around each particle).
  // Layout per particle: chem, sound, bond messages, cluster state, wall and typed terrain sensors.
  uploadExtras(extras) {
    // `extras` is a Float32Array supplied by sim (already sized maxParticles×EXTRAS_STRIDE_F32)
    const count = Math.min(this._uploadedCount, this.maxParticles);
    this.device.queue.writeBuffer(this.extrasBuf, 0, extras.buffer, 0, count * EXTRAS_STRIDE_F32 * 4);
  }

  _writeParams(count) {
    const o = this.opts;
    const v = this.paramsView;
    v.setFloat32(0,  o.hashCell,   true);
    v.setInt32  (4,  o.hashW,      true);
    v.setInt32  (8,  o.hashH,      true);
    v.setUint32 (12, count,        true);
    v.setUint32 (16, o.numSpecies, true);
    v.setFloat32(20, o.rClose,     true);
    v.setFloat32(24, o.kRep,       true);
    v.setFloat32(28, o.kAttr,      true);
    this.device.queue.writeBuffer(this.paramsBuf, 0, this.paramsStaging);
  }

  dispatch() {
    const d = this.device;
    const count = this._uploadedCount || this.maxParticles;
    const HW = this.opts.hashW, HH = this.opts.hashH;
    const HASH_CELLS = HW * HH;
    const partGroups = Math.max(1, Math.ceil(count / WORKGROUP_SIZE));

    const enc = d.createCommandEncoder({ label: 'primordia.kernel' });
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, this.bindGroup);

    pass.setPipeline(this.clearPipeline);
    pass.dispatchWorkgroups(Math.ceil(HASH_CELLS / WORKGROUP_SIZE));

    pass.setPipeline(this.buildPipeline);
    pass.dispatchWorkgroups(partGroups);

    pass.setPipeline(this.pairPipeline);
    pass.dispatchWorkgroups(partGroups);

    pass.setPipeline(this.brainPipeline);
    pass.dispatchWorkgroups(partGroups);

    pass.end();
    enc.copyBufferToBuffer(this.resultsBuf, 0, this.readBackBuf, 0, count * RESULT_STRIDE_F32 * 4);

    const t0 = performance.now();
    d.queue.submit([enc.finish()]);
    this.lastDispatchMs = performance.now() - t0;
    this.dispatchCount++;
  }

  async readback() {
    const count = this._uploadedCount || this.maxParticles;
    const bytes = count * RESULT_STRIDE_F32 * 4;
    const t0 = performance.now();
    try {
      await this.readBackBuf.mapAsync(GPUMapMode.READ, 0, bytes);
      const range = this.readBackBuf.getMappedRange(0, bytes);
      this.resultsCPU.set(new Float32Array(range, 0, count * RESULT_STRIDE_F32));
      this.readBackBuf.unmap();
      this.lastReadbackMs = performance.now() - t0;
      return this.resultsCPU;
    } catch (err) {
      this.lastError = err.message || String(err);
      throw err;
    }
  }
}

export const EXTRAS_STRIDE = EXTRAS_STRIDE_F32;
