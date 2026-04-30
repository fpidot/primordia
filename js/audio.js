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
// Pitch alphabet:
//   chord set    = C7 color tones across two octaves (C E G Bb ...)
//   discord set  = softer passing tones (D A Bb ...) for hostile calls.
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

// --- pitch alphabets in Hz, softened C7 palette --------------------------
//
// Chord set = root-7 voicing: C E G Bb across two octaves. Hostile calls use
// D/A/Bb passing tones: still tense, but less sharp than the old frequent #4.

const C2 = 65.41,  D2 = 73.42,  E2 = 82.41;
const G2 = 98.00,  A2 = 110.00, Bb2 = 116.54;
const C3 = 130.81, D3 = 146.83, E3 = 164.81;
const G3 = 196.00, A3 = 220.00, Bb3 = 233.08;
const C4 = 261.63, D4 = 293.66, E4 = 329.63;
const G4 = 392.00, A4 = 440.00, Bb4 = 466.16;
const C5 = 523.25, D5 = 587.33, E5 = 659.25;
const G5 = 783.99, A5 = 880.00, Bb5 = 932.33;
const C6 = 1046.50, D6 = 1174.66, E6 = 1318.51;
const G6 = 1567.98, A6 = 1760.00, Bb6 = 1864.66;
const D7 = 2349.32, A7 = 3520.00;

// Instrument families. Species map onto these so different species sound
// audibly different — independent of pitch register (channel) and note
// (variant). Each family is a small synth recipe tuned for a recognisable
// timbre. Five families cover 16 species via modulo:
//   0 flute       — pure sine + sine octave partial; bright but soft
//   1 organ       — triangle + sine fifth + sine octave; sustained
//   2 clarinet    — square through narrow lowpass; woody mid-range
//   3 tuba        — sine + sub-octave; fat warm low end
//   4 nylon       — triangle with slight sawtooth partial; gentle pluck
//   5 vibes       — sine with mild metallic tremolo; bell-like
const INSTRUMENTS = [
  // [oscNeutral, oscHostile, lpRatioNeutral, lpRatioHostile, partialMul,
  //  partialType, subOctaveAmount, attackMul, name]
  ['sine',     'triangle', 4.0, 5.5, 1.0, 'sine',     0.0, 1.4, 'flute'],
  ['triangle', 'triangle', 5.0, 6.5, 1.5, 'sine',     0.0, 1.6, 'organ'],
  ['triangle', 'sawtooth', 1.8, 2.8, 0.5, 'sine',     0.0, 1.0, 'clarinet'],
  ['sine',     'triangle', 2.0, 3.0, 0.8, 'sine',     0.7, 1.2, 'tuba'],
  ['triangle', 'sawtooth', 3.4, 4.5, 0.7, 'sawtooth', 0.0, 0.8, 'nylon'],
  ['sine',     'triangle', 4.5, 5.5, 0.9, 'sine',     0.0, 1.5, 'vibes'],
];

// Wider C7 arpeggio per channel; repeated chord tones span a little farther
// so dense populations do not hammer the same few notes as often.
const CHORD = [
  [C2, E2, G2, Bb2, C3, E3, G3, Bb3],   // ch0 deep
  [C3, E3, G3, Bb3, C4, E4, G4, Bb4],   // ch1 bass
  [C4, E4, G4, Bb4, C5, E5, G5, Bb5],   // ch2 mid
  [C5, E5, G5, Bb5, C6, E6, G6, Bb6],   // ch3 high
];

// Softer hostile passing tones. This keeps attacks recognisable while avoiding
// the old frequent #4 that could make dense soups feel needlessly sharp.
const DISCORD = [
  [D2, A2, Bb2, D3, A3, Bb3, D4, A4],   // ch0
  [D3, A3, Bb3, D4, A4, Bb4, D5, A5],   // ch1
  [D4, A4, Bb4, D5, A5, Bb5, D6, A6],   // ch2
  [D5, A5, Bb5, D6, A6, Bb6, D7, A7],   // ch3
];

// Root note transpose: −6 semitones (down half an octave) shifts the
// default pitch register lower for a more grounded jazz feel. Combines
// multiplicatively with the per-epoch transpose, so the music ascends
// from there as ages start.
const KEY_BASE_SEMITONES = -6;

// Swing-meter quantisation. Voices fire only on swing-quantised eighth-
// note onsets — gives the soundscape a gentle jazzy lilt instead of an
// even flow of notes.
//   BPM      → quarter-note (beat) length in seconds
//   Long 8th → 2/3 of a beat (the down-beat 8th)
//   Short 8th → 1/3 of a beat (the swung "and")
const BPM = 96;
const BEAT_DUR_S = 60 / BPM;
const LONG_EIGHTH_S  = BEAT_DUR_S * (2 / 3);
const SHORT_EIGHTH_S = BEAT_DUR_S * (1 / 3);

const MAX_VOICES      = 6;
const COOLDOWN_S      = 0.28;
const ATTACK_THRESH   = 0.18;
const AMP_FLOOR       = 0.40;
const SLOTS_PER_TICK  = 3;
const DEATH_CHORUS_MIN = 48;
const DEATH_CHORUS_POP_FRAC = 0.035;
const ORNAMENT_SIGNAL_GATE = 0.82;
const ORNAMENT_COOLDOWN_S = 1.4;

// Discord is reserved for clearer aggressive signals so the default sound bed
// stays calmer over long runs.
function isHostile(p) {
  if ((p.predationGain || 0) > 0.28) return true;
  if ((p.signalR || 0) > 0.82) return true;
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
    this._nextOnsetT = 0;     // next swing-quantised trigger time (ctx clock)
    this._swingSlot = 0;      // 0 = down-beat just fired, next gap is short
                              // 1 = up-beat just fired, next gap is long
    this._deathWindow = { count: 0, xSum: 0 };
    this._wallWindow = [];
    this._ornament = null;
    this._wallOrnament = null;
    this._lastOrnamentT = -999;
    this._lastWallOrnamentT = -999;
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
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -18;
      this.limiter.knee.value = 18;
      this.limiter.ratio.value = 5;
      this.limiter.attack.value = 0.006;
      this.limiter.release.value = 0.18;
      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
      this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.05);
      this._noiseBuffer = this._makeNoiseBuffer();
      this._nextOnsetT = this.ctx.currentTime + 0.05;
      this._swingSlot = 0;
      this._deathWindow.count = 0;
      this._deathWindow.xSum = 0;
      this._wallWindow.length = 0;
      this._ornament = null;
      this._wallOrnament = null;
      this._lastOrnamentT = -999;
      this._lastWallOrnamentT = -999;
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
    this._deathWindow.count = 0;
    this._deathWindow.xSum = 0;
    this._wallWindow.length = 0;
    this._ornament = null;
    this._wallOrnament = null;
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
    if (!this.ctx || !this.enabled || !world.particles) {
      if (world) {
        if (world._wallSoundEvents) world._wallSoundEvents.length = 0;
        if (world._deathSoundEvents) world._deathSoundEvents.length = 0;
      }
      return;
    }
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
    // dramatically: drop the rising-attack requirement entirely and lower
    // the floor so any non-trivially-emitting member triggers.
    const ampFloor    = chasedCluster ? 0.10 : AMP_FLOOR;
    const cooldownS   = chasedCluster ? 0.10 : COOLDOWN_S;
    const skipAttack  = !!chasedCluster;

    const candidates = [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.dead) continue;
      const amp = p.soundAmp || 0;
      const prev = this._lastSoundAmp.get(p.id) || 0;
      this._lastSoundAmp.set(p.id, amp);
      if (amp < ampFloor) continue;
      if (!skipAttack && (amp - prev < ATTACK_THRESH)) continue;
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

    if (this._ornament && now >= this._ornament.t) {
      const p = this._ornament.p;
      this._ornament = null;
      if (p && !p.dead && this._activeVoices < MAX_VOICES) {
        this._lastTrigger.set(p.id, now);
        this._playVoice(p, world, { ornament: true });
      }
    }
    if (this._wallOrnament && now >= this._wallOrnament.t) {
      const ev = this._wallOrnament.ev;
      this._wallOrnament = null;
      if (ev) this._playWallEvent(ev, true);
    }

    // Swing-meter gate. Voices may only trigger on swing-quantised eighth-
    // note onsets. If the current ctx time is before the next scheduled
    // onset, hold candidates for now (they'll either re-qualify next tick
    // or get superseded by louder ones — whichever wins is what fires
    // when the onset hits).
    if (now >= this._nextOnsetT) {
      if (candidates.length > 0 && this._activeVoices < MAX_VOICES) {
        candidates.sort((a, b) => b.soundAmp - a.soundAmp);
        const slots = Math.min(MAX_VOICES - this._activeVoices, candidates.length, SLOTS_PER_TICK);
        for (let i = 0; i < slots; i++) {
          const p = candidates[i];
          this._lastTrigger.set(p.id, now);
          this._playVoice(p, world);
        }
        this._scheduleOrnament(candidates[0], now);
      }
      const deathGate = Math.max(DEATH_CHORUS_MIN, Math.floor(ps.length * DEATH_CHORUS_POP_FRAC));
      if (this._deathWindow.count >= deathGate) {
        this._playDeathCue(this._deathWindow.xSum / this._deathWindow.count,
          Math.min(1, this._deathWindow.count / (deathGate * 2)));
      }
      if (this._wallWindow.length > 0) {
        const slots = Math.min(4, this._wallWindow.length);
        for (let i = 0; i < slots; i++) this._playWallEvent(this._wallWindow[i], false);
        if (this._wallWindow.length >= 3) this._scheduleWallOrnament(this._wallWindow[0], now);
        this._wallWindow.length = 0;
      }
      this._deathWindow.count = 0;
      this._deathWindow.xSum = 0;
      // Advance to the next swing-eighth onset whether or not anything
      // played; silence in a slot is fine, but the meter keeps marching.
      // swingSlot toggles each onset: 0→down-beat, 1→up-beat, 0→down-beat.
      // After a down-beat we wait long_eighth (2/3 beat) for the up-beat;
      // after the up-beat we wait short_eighth (1/3 beat) for the next
      // down-beat. That's the standard jazz swing feel.
      const gap = this._swingSlot === 0 ? LONG_EIGHTH_S : SHORT_EIGHTH_S;
      // If we've drifted very far behind (e.g., tab paused), snap forward
      // rather than burst-fire — keeps tempo rather than catching up.
      this._nextOnsetT = Math.max(this._nextOnsetT + gap, now + gap * 0.5);
      this._swingSlot = 1 - this._swingSlot;
    }

    if (this._lastSoundAmp.size > 4000) {
      const alive = new Set();
      for (const p of ps) if (!p.dead) alive.add(p.id);
      for (const id of this._lastSoundAmp.keys()) if (!alive.has(id)) this._lastSoundAmp.delete(id);
      for (const id of this._lastTrigger.keys()) if (!alive.has(id)) this._lastTrigger.delete(id);
    }

    // Wall-action one-shots (Thread B-2): grunt for dig, plop for deposit.
    // Camera-localization filter is INTENTIONALLY bypassed — these events
    // are rare and significant ("oh, something is digging right now"), so
    // we play them whether or not the user is zoomed/chasing. Still capped
    // per tick so a digging colony can't drown the soundscape.
    const evs = world._wallSoundEvents;
    if (evs && evs.length > 0) {
      for (const ev of evs) {
        if (this._wallWindow.length >= 16) break;
        this._wallWindow.push(ev);
      }
      evs.length = 0;
    }

    // Death cue: only if enough particles died inside the current musical
    // note window. Single deaths stay silent; collapse waves get a mournful
    // slide once on the next swing onset.
    const deaths = world._deathSoundEvents;
    if (deaths && deaths.length > 0) {
      for (const ev of deaths) {
        this._deathWindow.count++;
        this._deathWindow.xSum += ev.x || W * 0.5;
      }
      deaths.length = 0;
    }
  }

  // Short percussive scratch — bandpass-filtered noise burst, suggests
  // friction/scraping. ~150ms, low-mid centered. Kept gentle: earlier boosted
  // wall events could read as random loud claps in dense builder epochs.
  _playGrunt(px, ornament = false) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime((220 + Math.random() * 80) * (ornament ? 1.25 : 1), t);
    filter.frequency.exponentialRampToValueAtTime(100 * (ornament ? 1.15 : 1), t + 0.12);
    filter.Q.value = 4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.22 * (ornament ? 0.55 : 1), t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
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
    noise.stop(t + 0.18);
    noise.onended = () => {
      try { noise.disconnect(); filter.disconnect(); env.disconnect();
        if (last !== env) last.disconnect(); } catch {}
    };
  }

  // Short rounded thud — sine drop suggests setting something down. ~120ms.
  _playPlop(px, ornament = false) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(ornament ? 520 : 420, t);
    osc.frequency.exponentialRampToValueAtTime(ornament ? 95 : 70, t + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.24 * (ornament ? 0.55 : 1), t + 0.010);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
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

  _playDeathCue(px, intensity = 0.5) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.42 + intensity * 0.28;
    const peak = 0.12 + intensity * 0.08;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(196, t);
    osc.frequency.exponentialRampToValueAtTime(92, t + dur);

    const formant = ctx.createBiquadFilter();
    formant.type = 'lowpass';
    formant.frequency.setValueAtTime(720, t);
    formant.frequency.exponentialRampToValueAtTime(360, t + dur);
    formant.Q.value = 5.5;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.035);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(formant).connect(env);

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
    osc.stop(t + dur + 0.04);
    osc.onended = () => {
      try { osc.disconnect(); formant.disconnect(); env.disconnect();
        if (last !== env) last.disconnect(); } catch {}
    };
  }

  _scheduleOrnament(p, now) {
    if (!p || this._ornament || now - this._lastOrnamentT < ORNAMENT_COOLDOWN_S) return;
    const sig = ((p.signalR || 0) + (p.signalG || 0) + (p.signalB || 0)) / 3;
    if (sig < ORNAMENT_SIGNAL_GATE || (p.soundAmp || 0) < 0.50) return;
    const seed = ((p.id * 1664525 + (((now * 1000) | 0) * 1013904223)) >>> 0);
    const graceBeforeDownbeat = (seed & 1) === 1;
    let delay;
    if (graceBeforeDownbeat) {
      const nextDownbeatGap = this._swingSlot === 0
        ? LONG_EIGHTH_S + SHORT_EIGHTH_S
        : SHORT_EIGHTH_S;
      delay = Math.max(0.035, nextDownbeatGap - BEAT_DUR_S / 8);
    } else {
      const longGap = this._swingSlot === 0
        ? LONG_EIGHTH_S
        : SHORT_EIGHTH_S + LONG_EIGHTH_S;
      delay = longGap * 0.5;
    }
    this._ornament = { t: now + delay, p };
    this._lastOrnamentT = now;
  }

  _scheduleWallOrnament(ev, now) {
    if (!ev || this._wallOrnament || now - this._lastWallOrnamentT < ORNAMENT_COOLDOWN_S) return;
    const seed = ((((ev.id || 1) * 1103515245) + ((((now * 1000) | 0) * 2654435761) >>> 0)) >>> 0);
    const graceBeforeDownbeat = (seed & 1) === 1;
    let delay;
    if (graceBeforeDownbeat) {
      const nextDownbeatGap = this._swingSlot === 0
        ? LONG_EIGHTH_S + SHORT_EIGHTH_S
        : SHORT_EIGHTH_S;
      delay = Math.max(0.035, nextDownbeatGap - BEAT_DUR_S / 8);
    } else {
      const longGap = this._swingSlot === 0
        ? LONG_EIGHTH_S
        : SHORT_EIGHTH_S + LONG_EIGHTH_S;
      delay = longGap * 0.5;
    }
    this._wallOrnament = { t: now + delay, ev };
    this._lastWallOrnamentT = now;
  }

  _playWallEvent(ev, ornament = false) {
    if (ev.kind === 'grunt') this._playGrunt(ev.x, ornament);
    else if (ev.kind === 'plop') this._playPlop(ev.x, ornament);
  }

  _playVoice(p, world = null, opts = {}) {
    const ctx = this.ctx;
    const ch = ((p.soundCh | 0) % 4 + 4) % 4;
    const hostile = isHostile(p);
    const set = hostile ? DISCORD[ch] : CHORD[ch];
    const variant = ((p.id | 0) % set.length + set.length) % set.length;
    const baseFreq = set[variant];
    const detune = (((p.id * 31337) >>> 0) % 200 - 100) / 10000;   // ±0.01
    // Key = base transpose (constant) + per-epoch transpose. Both as
    // half-step offsets in 12-TET so Lydian b7 intervals are preserved.
    const halfSteps = world && world.clades ? (world.clades.epochsStarted || 0) : 0;
    const totalSemis = KEY_BASE_SEMITONES + halfSteps;
    const keyMult = Math.pow(2, totalSemis / 12);
    let freq = baseFreq * (1 + detune) * keyMult;
    if (opts.ornament) freq *= Math.pow(2, 7 / 12);

    // Per-particle trait modulation so listeners can tell apart calling kind:
    //   • energyN    → envelope decay length (energetic = lingering ring)
    //   • cohesionN  → attack sharpness + vibrato (calm cohesive = warm wobble)
    //   • slotsN     → harmonic partial (smarter brain = richer voice)
    const gn = p.genome;
    const energyN   = Math.max(0, Math.min(1, (p.energy || 4) / 8));
    const cohesionN = gn ? Math.max(0, Math.min(1, (gn.cohesion + 0.5) / 1.5)) : 0.5;
    const slotsN    = gn && gn.brain ? gn.brain.enabledCount() / 10 : 0.5;

    const t = ctx.currentTime;
    const instForAttack = INSTRUMENTS[(p.species | 0) % INSTRUMENTS.length];
    const attackMul = instForAttack[7];
    const attack = (hostile
      ? 0.003 + (1 - cohesionN) * 0.005
      : 0.008 + (1 - cohesionN) * 0.018) * attackMul;
    const rareKey = ((p.id * 1103515245 + ((world && world.tick) || 0) * 2654435761) >>> 0) % 113;
    const rareMode = (!hostile && p.soundAmp > 0.55)
      ? (rareKey === 0 ? 'boop' : (rareKey === 1 ? 'boing' : ''))
      : '';
    let dur = (hostile ? 0.10 : 0.16)
            + Math.min(0.3, p.soundAmp) * 0.30
            + energyN * 0.18;
    if (rareMode) dur += 0.16;
    if (opts.ornament) dur *= 0.48;
    const peak = Math.min(0.45, p.soundAmp * (hostile ? 0.65 : 0.55)) * (opts.ornament ? 0.52 : 1);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + attack);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    const sources = [];

    if (rareMode === 'boop') {
      // Rare pitched vocal-ish "boop": two formant bands over a sine carrier.
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 0.92, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.04, t + dur * 0.45);
      const formA = ctx.createBiquadFilter();
      formA.type = 'bandpass';
      formA.frequency.value = 720 + ch * 120;
      formA.Q.value = 8;
      const formB = ctx.createBiquadFilter();
      formB.type = 'bandpass';
      formB.frequency.value = 1250 + variant * 55;
      formB.Q.value = 5;
      const mixA = ctx.createGain();
      const mixB = ctx.createGain();
      mixA.gain.value = 0.75;
      mixB.gain.value = 0.34;
      osc.connect(formA).connect(mixA).connect(env);
      osc.connect(formB).connect(mixB).connect(env);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      sources.push(osc, formA, formB, mixA, mixB);
    } else if (rareMode === 'boing') {
      // Rare resonant spring/boing: pitch bends through a narrow bandpass.
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq * 0.65, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.55, t + 0.045);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.82, t + dur);
      const reson = ctx.createBiquadFilter();
      reson.type = 'bandpass';
      reson.frequency.setValueAtTime(freq * 2.2, t);
      reson.frequency.exponentialRampToValueAtTime(freq * 1.1, t + dur);
      reson.Q.value = 13;
      osc.connect(reson).connect(env);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      sources.push(osc, reson);
    } else if (hostile && ch === 3) {
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
      // Per-species instrument — the strongest dimension for tonal variety
      // beyond pitch. 16 species → 6 instrument families via modulo.
      const inst = INSTRUMENTS[(p.species | 0) % INSTRUMENTS.length];
      const osc = ctx.createOscillator();
      osc.type = hostile ? inst[1] : inst[0];

      if (hostile) {
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.92, t + dur);
      } else {
        osc.frequency.value = freq;
      }

      // Per-instrument lowpass cutoff. Lower ratio = warmer (clarinet, tuba);
      // higher = brighter (organ, vibes, flute).
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = freq * (hostile ? inst[3] : inst[2]);
      lp.Q.value = 0.7;
      osc.connect(lp).connect(env);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      sources.push(osc);

      // Sub-octave (tuba): adds fundamental weight an octave below.
      if (inst[6] > 0) {
        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.value = freq * 0.5;
        const subGain = ctx.createGain();
        subGain.gain.value = inst[6];
        sub.connect(subGain).connect(lp);
        sub.start(t);
        sub.stop(t + dur + 0.05);
        sources.push(sub);
      }

      // Smarter brains add a harmonic partial — fifth (chord) or octave
      // (hostile). The instrument's partial multiplier shapes how loud it
      // is and what wave it uses (sine vs sawtooth, etc).
      if (slotsN > 0.4) {
        const partial = ctx.createOscillator();
        partial.type = inst[5];
        partial.frequency.value = freq * (hostile ? 2 : 1.5);
        const partialGain = ctx.createGain();
        partialGain.gain.value = (slotsN - 0.4) * 0.4 * inst[4];
        partial.connect(partialGain).connect(lp);
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
