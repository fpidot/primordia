// audio.js — vocalisation-driven sound for organism signaling.
//
// Triggered model: when a particle's soundAmp output crosses an "attack"
// threshold (rises by ATTACK_THRESH while above AMP_FLOOR), we fire a short
// ADSR-enveloped voice. Pitch and timbre are determined by:
//
//   • soundCh   → octave register (4 channels → 4 stacked octaves).
//   • predationGain or red-signal level → "hostile" gate (discord vs chord).
//   • particle.id   → which note within the 6-note set, for per-individual voice.
//
// Pitch alphabet — C major:
//   chord set    = root, third, fifth across two octaves (C E G C' E' G')
//   discord set  = the rest of the C major scale (D F A B D' F') used by
//                  particles whose vocalisation is "hostile" — produces a
//                  recognisable dissonant texture without leaving the key.
//
// Timbre per channel × mode:
//   ch0 deep:   sine        / triangle + bend     — horn vs growl
//   ch1 bass:   triangle    / square + bend       — pluck vs buzz
//   ch2 mid:    square      / sawtooth + bend     — mellow vs bright
//   ch3 high:   sawtooth    / filtered noise burst — bright vs harsh static
//
// Browser policy: AudioContext can only start after a user gesture, so the
// system stays inert until the user toggles the checkbox.
//
// The export name is still `audioHum` so main.js / ui.js don't need to change.

import { W } from './sim.js';

// --- pitch alphabets in Hz, indexed by [channel][noteVariant] -------------

const C2 = 65.41,  D2 = 73.42,  E2 = 82.41,  F2 = 87.31;
const G2 = 98.00,  A2 = 110.00, B2 = 123.47;
const C3 = 130.81, D3 = 146.83, E3 = 164.81, F3 = 174.61;
const G3 = 196.00, A3 = 220.00, B3 = 246.94;
const C4 = 261.63, D4 = 293.66, E4 = 329.63, F4 = 349.23;
const G4 = 392.00, A4 = 440.00, B4 = 493.88;
const C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46;
const G5 = 783.99, A5 = 880.00, B5 = 987.77;
const C6 = 1046.50, D6 = 1174.66, E6 = 1318.51, F6 = 1396.91;
const G6 = 1567.98;

// Two-octave C major chord arpeggio per channel (root, third, fifth × 2)
const CHORD = [
  [C2, E2, G2, C3, E3, G3],   // ch0 deep
  [C3, E3, G3, C4, E4, G4],   // ch1 bass
  [C4, E4, G4, C5, E5, G5],   // ch2 mid
  [C5, E5, G5, C6, E6, G6],   // ch3 high
];

// Non-chord scale tones (D F A B × 2 octaves, dropping a couple to keep it 6)
const DISCORD = [
  [D2, F2, A2, B2, D3, F3],   // ch0
  [D3, F3, A3, B3, D4, F4],   // ch1
  [D4, F4, A4, B4, D5, F5],   // ch2
  [D5, F5, A5, B5, D6, F6],   // ch3
];

const MAX_VOICES      = 8;
const COOLDOWN_S      = 0.22;
const ATTACK_THRESH   = 0.18;
const AMP_FLOOR       = 0.40;
const SLOTS_PER_TICK  = 4;

// Hostile vocalisation gate — broadened so discord notes actually fire on a
// fresh soup. Earlier (predationGain > 0.25 || signalR > 0.78) almost never
// triggered with random-init brains. Now: any of (a) noticeable predation
// drive, (b) strong red signal, (c) anti-social cohesion, (d) starving-low
// energy below a quarter of repro threshold all route to discord. Roughly
// 15-25% of voices in a typical run come out hostile under this gate.
function isHostile(p) {
  if ((p.predationGain || 0) > 0.10) return true;
  if ((p.signalR || 0) > 0.65) return true;
  const g = p.genome;
  if (g && g.cohesion < -0.05) return true;
  if (g && p.energy < g.repro_thresh * 0.25) return true;
  return false;
}

export class AudioVoices {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
    this.masterVolume = 0.25;
    this._lastTrigger = new Map();
    this._lastSoundAmp = new Map();
    this._activeVoices = 0;
    this._lastTickT = 0;
    this._noiseBuffer = null;
  }

  enable() {
    if (this.ctx) {
      this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.05);
      this.enabled = true;
      return true;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
      this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.05);
      this._noiseBuffer = this._makeNoiseBuffer();
      this.enabled = true;
      return true;
    } catch (err) {
      console.warn('[audio] failed to start', err);
      return false;
    }
  }

  disable() {
    if (!this.ctx) { this.enabled = false; return; }
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.enabled = false;
  }

  setMaster(v) {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.ctx && this.enabled) {
      this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.05);
    }
  }

  // 0.5s of pre-rolled white noise reused for noise-burst voices.
  _makeNoiseBuffer() {
    const sr = this.ctx.sampleRate;
    const len = (sr * 0.5) | 0;
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  tick(world, dtSec, camera = null) {
    if (!this.ctx || !this.enabled || !world.particles) return;
    this._lastTickT += dtSec;
    if (this._lastTickT < 0.033) return;
    this._lastTickT = 0;

    const now = this.ctx.currentTime;
    const ps = world.particles;

    // Camera-aware audibility filter (cosmetic only — sim ignores it):
    //   • Chase mode (followClusterMembers set) → only members of the chased
    //     cluster make sound, even if other particles are visible on screen.
    //   • Otherwise, when zoomed in (zoom > 1.0), only particles inside the
    //     viewport are audible — sounds from offscreen colonies don't bleed
    //     into a focused view.
    //   • At full-fit zoom and no chase, everything is audible (no filter).
    let chasedCluster = null;
    let inView = null;
    if (camera) {
      if (camera.followClusterMembers && typeof camera.resolveChasedCluster === 'function') {
        chasedCluster = camera.resolveChasedCluster(world);
      }
      if (!chasedCluster && camera.zoom > 1.0 && camera.viewW && camera.viewH) {
        const halfW = camera.viewW / (2 * camera.zoom);
        const halfH = camera.viewH / (2 * camera.zoom);
        const x0 = camera.x - halfW, x1 = camera.x + halfW;
        const y0 = camera.y - halfH, y1 = camera.y + halfH;
        inView = (p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
      }
    }
    const ptc = world._particleToCluster;

    // Chase-mode threshold relaxation. With audibility filtered to a single
    // ~10–50-member cluster, default amp/attack/cooldown gates produce near-
    // silence (the gates were tuned assuming 5000-particle scanning). Relax
    // them so cluster voices trigger about as often as ambient soup did.
    const ampFloor    = chasedCluster ? 0.28 : AMP_FLOOR;
    const attackThr   = chasedCluster ? 0.10 : ATTACK_THRESH;
    const cooldownS   = chasedCluster ? 0.10 : COOLDOWN_S;

    const candidates = [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.dead) continue;
      const amp = p.soundAmp || 0;
      const prev = this._lastSoundAmp.get(p.id) || 0;
      this._lastSoundAmp.set(p.id, amp);
      if (amp < ampFloor) continue;
      if (amp - prev < attackThr) continue;
      const lastT = this._lastTrigger.get(p.id) || 0;
      if (now - lastT < cooldownS) continue;
      // Audibility gate
      if (chasedCluster) {
        if (!ptc || ptc.get(p.id) !== chasedCluster) continue;
      } else if (inView) {
        if (!inView(p)) continue;
      }
      candidates.push(p);
    }

    if (candidates.length > 0 && this._activeVoices < MAX_VOICES) {
      candidates.sort((a, b) => b.soundAmp - a.soundAmp);
      const slots = Math.min(MAX_VOICES - this._activeVoices, candidates.length, SLOTS_PER_TICK);
      for (let i = 0; i < slots; i++) {
        const p = candidates[i];
        this._lastTrigger.set(p.id, now);
        this._playVoice(p);
      }
    }

    if (this._lastSoundAmp.size > 4000) {
      const alive = new Set();
      for (const p of ps) if (!p.dead) alive.add(p.id);
      for (const id of this._lastSoundAmp.keys()) if (!alive.has(id)) this._lastSoundAmp.delete(id);
      for (const id of this._lastTrigger.keys()) if (!alive.has(id)) this._lastTrigger.delete(id);
    }

    // Wall-action one-shots (Thread B-2): grunt for dig, plop for deposit.
    // Drain world._wallSoundEvents regardless of audibility filter ABOVE; the
    // filter still applies per-event so chase / zoom modes only hear local
    // events. Cap how many fire per tick so a colony of digger-builders
    // doesn't drown out everything else.
    const evs = world._wallSoundEvents;
    if (evs && evs.length > 0) {
      let fired = 0;
      for (const ev of evs) {
        if (fired >= 4) break;
        if (chasedCluster) {
          if (!ptc || !ptc.has(ev.id)) continue;
          if (ptc.get(ev.id) !== chasedCluster) continue;
        } else if (inView) {
          if (!inView({ x: ev.x, y: ev.y })) continue;
        }
        if (ev.kind === 'grunt') this._playGrunt(ev.x);
        else if (ev.kind === 'plop') this._playPlop(ev.x);
        fired++;
      }
      evs.length = 0;
    }
  }

  // Short percussive scratch — bandpass-filtered noise burst, suggests
  // friction/scraping. ~120ms, low-mid centered.
  _playGrunt(px) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(180 + Math.random() * 60, t);
    filter.frequency.exponentialRampToValueAtTime(80, t + 0.10);
    filter.Q.value = 6;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.5, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    noise.connect(filter).connect(env);
    let last = env;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      const xn = (px || 0) / Math.max(1, W);
      pan.pan.value = Math.max(-1, Math.min(1, xn * 2 - 1));
      env.connect(pan);
      last = pan;
    }
    last.connect(this.master);
    noise.start(t);
    noise.stop(t + 0.14);
    noise.onended = () => {
      try { noise.disconnect(); filter.disconnect(); env.disconnect();
        if (last !== env) last.disconnect(); } catch {}
    };
  }

  // Short rounded thud — sine drop suggests setting something down. ~100ms.
  _playPlop(px) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(380, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.10);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.45, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(env);
    let last = env;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      const xn = (px || 0) / Math.max(1, W);
      pan.pan.value = Math.max(-1, Math.min(1, xn * 2 - 1));
      env.connect(pan);
      last = pan;
    }
    last.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.14);
    osc.onended = () => {
      try { osc.disconnect(); env.disconnect();
        if (last !== env) last.disconnect(); } catch {}
    };
  }

  _playVoice(p) {
    const ctx = this.ctx;
    const ch = ((p.soundCh | 0) % 4 + 4) % 4;
    const variant = ((p.id | 0) % 6 + 6) % 6;
    const hostile = isHostile(p);
    const set = hostile ? DISCORD[ch] : CHORD[ch];
    const baseFreq = set[variant];
    const detune = (((p.id * 31337) >>> 0) % 200 - 100) / 10000;   // ±0.01
    const freq = baseFreq * (1 + detune);

    // Per-particle trait modulation so listeners can tell apart calling kind:
    //   • energyN    → envelope decay length (energetic = lingering ring)
    //   • cohesionN  → attack sharpness + vibrato (calm cohesive = warm wobble)
    //   • slotsN     → harmonic partial (smarter brain = richer voice)
    const gn = p.genome;
    const energyN   = Math.max(0, Math.min(1, (p.energy || 4) / 8));
    const cohesionN = gn ? Math.max(0, Math.min(1, (gn.cohesion + 0.5) / 1.5)) : 0.5;
    const slotsN    = gn && gn.brain ? gn.brain.enabledCount() / 8 : 0.5;

    const t = ctx.currentTime;
    const attack = hostile
      ? 0.003 + (1 - cohesionN) * 0.005
      : 0.008 + (1 - cohesionN) * 0.018;
    const dur = (hostile ? 0.10 : 0.16)
              + Math.min(0.3, p.soundAmp) * 0.30
              + energyN * 0.18;
    const peak = Math.min(0.55, p.soundAmp * (hostile ? 0.9 : 0.7));

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + attack);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    const sources = [];

    if (hostile && ch === 3) {
      // Highest hostile register: a filtered noise burst.
      const noise = ctx.createBufferSource();
      noise.buffer = this._noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = freq * 1.5;
      filter.Q.value = 4;
      noise.connect(filter).connect(env);
      noise.start(t);
      noise.stop(t + dur + 0.04);
      sources.push(noise);
    } else {
      const osc = ctx.createOscillator();
      const TIMBRES = [
        ['sine',     'triangle' ],   // ch0
        ['triangle', 'square'   ],   // ch1
        ['square',   'sawtooth' ],   // ch2
        ['sawtooth', 'sawtooth' ],   // ch3 (hostile path uses noise above)
      ];
      osc.type = TIMBRES[ch][hostile ? 1 : 0];

      if (hostile) {
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.92, t + dur);
      } else {
        osc.frequency.value = freq;
      }
      osc.connect(env);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      sources.push(osc);

      // Smarter brains add a harmonic partial — fifth (chord) or octave
      // (hostile). Audibly richer voice.
      if (slotsN > 0.4) {
        const partial = ctx.createOscillator();
        partial.type = 'sine';
        partial.frequency.value = freq * (hostile ? 2 : 1.5);
        const partialGain = ctx.createGain();
        partialGain.gain.value = (slotsN - 0.4) * 0.4;
        partial.connect(partialGain).connect(env);
        partial.start(t);
        partial.stop(t + dur + 0.05);
        sources.push(partial);
      }

      // Calm-cohesive non-hostile voices get a soft vibrato.
      if (!hostile && cohesionN > 0.6) {
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 5 + cohesionN * 4;        // 5–9 Hz
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = freq * 0.012;
        lfo.connect(lfoGain).connect(osc.frequency);
        lfo.start(t);
        lfo.stop(t + dur + 0.05);
        sources.push(lfo);
      }
    }

    let lastNode = env;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      const xn = (p.x || 0) / Math.max(1, W);
      pan.pan.value = Math.max(-1, Math.min(1, xn * 2 - 1));
      env.connect(pan);
      lastNode = pan;
    }
    lastNode.connect(this.master);

    this._activeVoices++;
    sources[0].onended = () => {
      this._activeVoices = Math.max(0, this._activeVoices - 1);
      try {
        for (const s of sources) s.disconnect();
        env.disconnect();
        if (lastNode !== env) lastNode.disconnect();
      } catch {}
    };
  }
}

export const audioHum = new AudioVoices();
