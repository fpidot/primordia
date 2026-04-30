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

// --- pitch alphabets in Hz, C Lydian dominant (Lydian b7) ----------------
//
// Scale: C  D  E  F#  G  A  Bb
// Characteristic notes vs major: raised 4th (#4) + lowered 7th (b7).
// Yields a bright-but-uneasy quality somewhere between Lydian's lift and
// Mixolydian's bluesy droop. Pleasant for organism vocalisations because
// no two scale tones form a tritone-fifth (4 → b7 is a major 3rd), and
// the b7 prevents the major-7 brightness from feeling saccharine.
//
// Chord set (consonant) = root7 voicing: C E G Bb across two octaves.
// Discord set = remaining scale tones: D F# A across two octaves.

const C2 = 65.41,  D2 = 73.42,  E2 = 82.41,  Fs2 = 92.50;
const G2 = 98.00,  A2 = 110.00, Bb2 = 116.54;
const C3 = 130.81, D3 = 146.83, E3 = 164.81, Fs3 = 185.00;
const G3 = 196.00, A3 = 220.00, Bb3 = 233.08;
const C4 = 261.63, D4 = 293.66, E4 = 329.63, Fs4 = 369.99;
const G4 = 392.00, A4 = 440.00, Bb4 = 466.16;
const C5 = 523.25, D5 = 587.33, E5 = 659.25, Fs5 = 739.99;
const G5 = 783.99, A5 = 880.00, Bb5 = 932.33;
const C6 = 1046.50, D6 = 1174.66, E6 = 1318.51, Fs6 = 1479.98;
const A6 = 1760.00;

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

// Two-octave C7 (Lydian dominant tonic) arpeggio per channel
const CHORD = [
  [C2, E2, G2, Bb2, C3, E3],   // ch0 deep
  [C3, E3, G3, Bb3, C4, E4],   // ch1 bass
  [C4, E4, G4, Bb4, C5, E5],   // ch2 mid
  [C5, E5, G5, Bb5, C6, E6],   // ch3 high
];

// Non-chord scale tones — D, F#, A across two octaves. F# is the signature
// lydian colour; A is the natural 6 that makes Dm vs C7 ambiguity.
const DISCORD = [
  [D2, Fs2, A2, D3, Fs3, A3],   // ch0
  [D3, Fs3, A3, D4, Fs4, A4],   // ch1
  [D4, Fs4, A4, D5, Fs5, A5],   // ch2
  [D5, Fs5, A5, D6, Fs6, A6],   // ch3
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
    this._nextOnsetT = 0;     // next swing-quantised trigger time (ctx clock)
    this._swingSlot = 0;      // 0 = down-beat just fired, next gap is short
                              // 1 = up-beat just fired, next gap is long
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
      this._nextOnsetT = this.ctx.currentTime + 0.05;
      this._swingSlot = 0;
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
      }
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
      let fired = 0;
      for (const ev of evs) {
        if (fired >= 4) break;
        if (ev.kind === 'grunt') this._playGrunt(ev.x);
        else if (ev.kind === 'plop') this._playPlop(ev.x);
        fired++;
      }
      evs.length = 0;
    }
  }

  // Short percussive scratch — bandpass-filtered noise burst, suggests
  // friction/scraping. ~150ms, low-mid centered. Routed through a dedicated
  // bus gain (≈3× master) so wall events stand out vs the lowpass-warm
  // music — earlier 0.5 peak got swamped by simultaneous voice triggers.
  _playGrunt(px) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(220 + Math.random() * 80, t);
    filter.frequency.exponentialRampToValueAtTime(100, t + 0.12);
    filter.Q.value = 4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1.6, t + 0.005);
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
  // Same loudness boost as grunt so wall events cut through.
  _playPlop(px) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1.5, t + 0.008);
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

  _playVoice(p, world = null) {
    const ctx = this.ctx;
    const ch = ((p.soundCh | 0) % 4 + 4) % 4;
    const variant = ((p.id | 0) % 6 + 6) % 6;
    const hostile = isHostile(p);
    const set = hostile ? DISCORD[ch] : CHORD[ch];
    const baseFreq = set[variant];
    const detune = (((p.id * 31337) >>> 0) % 200 - 100) / 10000;   // ±0.01
    // Key = base transpose (constant) + per-epoch transpose. Both as
    // half-step offsets in 12-TET so Lydian b7 intervals are preserved.
    const halfSteps = world && world.clades ? (world.clades.epochsStarted || 0) : 0;
    const totalSemis = KEY_BASE_SEMITONES + halfSteps;
    const keyMult = Math.pow(2, totalSemis / 12);
    const freq = baseFreq * (1 + detune) * keyMult;

    // Per-particle trait modulation so listeners can tell apart calling kind:
    //   • energyN    → envelope decay length (energetic = lingering ring)
    //   • cohesionN  → attack sharpness + vibrato (calm cohesive = warm wobble)
    //   • slotsN     → harmonic partial (smarter brain = richer voice)
    const gn = p.genome;
    const energyN   = Math.max(0, Math.min(1, (p.energy || 4) / 8));
    const cohesionN = gn ? Math.max(0, Math.min(1, (gn.cohesion + 0.5) / 1.5)) : 0.5;
    const slotsN    = gn && gn.brain ? gn.brain.enabledCount() / 8 : 0.5;

    const t = ctx.currentTime;
    const instForAttack = INSTRUMENTS[(p.species | 0) % INSTRUMENTS.length];
    const attackMul = instForAttack[7];
    const attack = (hostile
      ? 0.003 + (1 - cohesionN) * 0.005
      : 0.008 + (1 - cohesionN) * 0.018) * attackMul;
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
