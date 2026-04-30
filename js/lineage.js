// lineage.js — clade tracking, mean attraction matrix, event ticker, fossil viewer.
//
// A "clade" is a genetic lineage. New clades are forked when a particle's genome
// drifts more than SPEC_DIST from its current clade's running mean — a coarse
// proxy for speciation. Clades carry parent links so we can render a tree later.

import {
  NUM_SPECIES, NUM_CHEM, SPECIES_NAMES, SPECIES_COLORS,
  genomeDistance, genomeToJSON, genomeFromJSON,
} from './genome.js';

const SWEEP_INTERVAL = 24;     // ticks between full census
const SPEC_DIST = 1.6;         // genome distance threshold to fork a new clade
const SPEC_SAMPLE = 60;        // particles sampled per sweep for speciation check
const EVENT_MAX = 80;
const FOSSIL_MAX = 12;
const MIN_FOSSIL_AGE = 350;
const POP_SPARK_LEN = 60;

let _cladeId = 0;

export function freshGenomeAcc() {
  return {
    attraction: new Float32Array(NUM_SPECIES),
    emit: new Float32Array(NUM_CHEM),
    sense: new Float32Array(NUM_CHEM),
    cohesion: 0, metab: 0, efficiency: 0,
    repro_thresh: 0, mut_rate: 0, sense_radius: 0,
  };
}

function addToAcc(acc, g) {
  for (let i = 0; i < NUM_SPECIES; i++) acc.attraction[i] += g.attraction[i];
  for (let i = 0; i < NUM_CHEM; i++) {
    acc.emit[i] += g.emit[i];
    acc.sense[i] += g.sense[i];
  }
  acc.cohesion += g.cohesion;
  acc.metab += g.metab;
  acc.efficiency += g.efficiency;
  acc.repro_thresh += g.repro_thresh;
  acc.mut_rate += g.mut_rate;
  acc.sense_radius += g.sense_radius;
}

function meanFromAcc(acc, n, species) {
  const out = {
    species,
    attraction: new Float32Array(NUM_SPECIES),
    emit: new Float32Array(NUM_CHEM),
    sense: new Float32Array(NUM_CHEM),
    cohesion: acc.cohesion / n,
    metab: acc.metab / n,
    efficiency: acc.efficiency / n,
    repro_thresh: acc.repro_thresh / n,
    mut_rate: acc.mut_rate / n,
    sense_radius: acc.sense_radius / n,
  };
  for (let i = 0; i < NUM_SPECIES; i++) out.attraction[i] = acc.attraction[i] / n;
  for (let i = 0; i < NUM_CHEM; i++) {
    out.emit[i] = acc.emit[i] / n;
    out.sense[i] = acc.sense[i] / n;
  }
  return out;
}

function snapshotGenome(g) {
  return {
    species: g.species,
    attraction: Float32Array.from(g.attraction),
    emit: Float32Array.from(g.emit),
    sense: Float32Array.from(g.sense),
    cohesion: g.cohesion, metab: g.metab, efficiency: g.efficiency,
    repro_thresh: g.repro_thresh, mut_rate: g.mut_rate, sense_radius: g.sense_radius,
  };
}

// Pseudo-randomized syllable pools for trait-flavoured names.
// Picked deterministically from the genome so names are stable across reloads.
const NAME_PREFIXES_BY_TRAIT = {
  aggressive: ['Tearer', 'Fang', 'Reaver', 'Striker', 'Render'],
  social:     ['Coil',   'Weave',  'Hearth', 'Sept',   'Schoal'],
  solitary:   ['Drift',  'Lonely', 'Hermit', 'Outer',  'Errant'],
  photic:     ['Sunlit', 'Bright', 'Solar',  'Glower', 'Helio'],
  voracious:  ['Maw',    'Glutton','Throat', 'Swill',  'Crater'],
  wanderer:   ['Rover',  'Chaser', 'Migrant','Strider','Path'],
  parasite:   ['Cling',  'Latch',  'Fester', 'Burrow', 'Bleed'],
  vocal:      ['Caller', 'Chime',  'Hum',    'Echo',   'Knock'],
  sentinel:   ['Watch',  'Guard',  'Warden', 'Vigil',  'Keeper'],
  default:    ['Drift',  'Tide',   'Shoal',  'Bloom',  'Pulse'],
};

function generateCladeName(c, tracker) {
  const tags = tracker ? tracker.classifyClade(c) : [];
  const speciesName = (c.species != null && SPECIES_NAMES[c.species]) || 'unknown';
  // Stable seed from founder genome
  const g = c.founderGenome;
  let seed = c.id * 9301;
  for (let i = 0; i < g.attraction.length; i++) seed += (g.attraction[i] * 1000) | 0;
  seed = Math.abs(seed) % 1000003;
  const trait = (tags[0] && tags[0].name) || 'default';
  const pool = NAME_PREFIXES_BY_TRAIT[trait] || NAME_PREFIXES_BY_TRAIT.default;
  const prefix = pool[seed % pool.length];
  return `${prefix}-${speciesName}`;
}

class Clade {
  constructor(id, parentId, founderGenome, foundedTick) {
    this.id = id;
    this.parentId = parentId;
    this.founderGenome = snapshotGenome(founderGenome);
    this.species = founderGenome.species;
    this.foundedTick = foundedTick;
    this.aliveCount = 0;
    this.peakCount = 0;
    this.lastSeenTick = foundedTick;
    this.totalEverBorn = 0;
    this.meanGenome = snapshotGenome(founderGenome);
    this.popHistory = []; // last POP_SPARK_LEN samples of aliveCount
    this.name = null;     // assigned by tracker after creation
  }
}

// Named epochs the chronicle watches for. Each has a `holds(stats)` predicate
// over a small derived state object built each sweep.
const EPOCHS = [
  {
    name: 'Sole Predator',
    description: 'one clade dominates the population',
    holds: s => s.totalPop > 200 && s.topShare > 0.6,
  },
  {
    name: 'Cambrian Bloom',
    description: 'rapid radiation of new clades',
    holds: s => s.cladeBurst > 0.5 && s.livingClades > 12,
  },
  {
    name: 'Great Vocalization',
    description: 'sustained inter-particle signaling',
    holds: s => (s.meanSignal + s.meanSound) > 0.5,
  },
  {
    name: 'Brain Renaissance',
    description: 'mean structural complexity peaks',
    holds: s => s.meanSlots > 5,
  },
  {
    name: 'Long Night',
    description: 'population crashed and stays low',
    holds: s => s.totalPop > 0 && s.totalPop < (s.peakPop * 0.35) && s.peakPop > 400,
  },
];

export class CladeTracker {
  constructor() {
    this.clades = new Map();   // id → Clade
    this.events = [];          // {tick, type, msg, color}
    this.fossils = [];         // {tick, age, energy, species, cladeId, genome}
    this.lastDominantId = null;
    this.popSamples = [];      // last K total-population samples
    this.peakPop = 0;          // historical peak total population
    this.cladeCountSamples = []; // for cambrian bloom detection
    this.epochs = EPOCHS.map(e => ({
      ...e,
      active: false,
      sustained: 0,
      startedAt: 0,
    }));
    // Lifetime count of epoch starts — audio.js reads this each frame and
    // transposes the key by `epochsStarted` half-steps so each new age
    // shifts the music up. Resets to 0 on world.reset (new tracker).
    this.epochsStarted = 0;
  }

  // Called when particle is born (externally via brush/preset, or via reproduction).
  // For reproduction, parentClade is the parent particle's clade.
  registerNewParticle(p, parentClade, tick) {
    if (parentClade) {
      p.cladeId = parentClade.id;
      parentClade.totalEverBorn++;
    } else {
      // Founder particle — start its own clade
      const c = this.newClade(p.genome, null, tick);
      p.cladeId = c.id;
    }
  }

  newClade(founderGenome, parentId, tick) {
    const id = ++_cladeId;
    const c = new Clade(id, parentId, founderGenome, tick);
    c.name = generateCladeName(c, this);
    this.clades.set(id, c);
    const parentLabel = parentId ? `← #${parentId}` : 'founder';
    this.pushEvent(tick, 'speciation',
      `${c.name} forms ${parentLabel}`,
      SPECIES_COLORS[founderGenome.species]);
    return c;
  }

  onParticleDie(p, tick) {
    if (p.age >= MIN_FOSSIL_AGE) this.recordFossil(p, tick);
  }

  recordFossil(p, tick) {
    this.fossils.unshift({
      tick, age: p.age,
      energy: p.energy,
      species: p.genome.species,
      cladeId: p.cladeId,
      genome: snapshotGenome(p.genome),
    });
    if (this.fossils.length > FOSSIL_MAX) this.fossils.pop();
  }

  // Run periodically — full census + speciation detection + event derivation.
  sweep(world) {
    if (world.tick % SWEEP_INTERVAL !== 0) return;

    // Reset clade counts and accumulators
    const accs = new Map();
    for (const c of this.clades.values()) c.aliveCount = 0;

    // Tally
    for (const p of world.particles) {
      let c = this.clades.get(p.cladeId);
      if (!c) {
        // Orphaned (e.g. loaded from older save) — found fresh clade
        c = this.newClade(p.genome, null, world.tick);
        p.cladeId = c.id;
      }
      c.aliveCount++;
      let acc = accs.get(c.id);
      if (!acc) { acc = freshGenomeAcc(); accs.set(c.id, acc); }
      addToAcc(acc, p.genome);
    }

    // Update means; detect extinctions
    for (const c of this.clades.values()) {
      if (c.aliveCount > 0) {
        const acc = accs.get(c.id);
        c.meanGenome = meanFromAcc(acc, c.aliveCount, c.species);
        if (c.aliveCount > c.peakCount) c.peakCount = c.aliveCount;
        c.lastSeenTick = world.tick;
      } else if (c.lastSeenTick >= world.tick - SWEEP_INTERVAL && c.peakCount > 8) {
        // Just went extinct (was alive last sweep, dead now, was non-trivial)
        this.pushEvent(world.tick, 'extinction',
          `clade #${c.id} extinct (peaked ${c.peakCount}, lasted ${world.tick - c.foundedTick}t)`,
          SPECIES_COLORS[c.species]);
        c.lastSeenTick = -1; // mark as already-mourned
      }
      c.popHistory.push(c.aliveCount);
      if (c.popHistory.length > POP_SPARK_LEN) c.popHistory.shift();
    }

    // Speciation detection: sample a few particles, fork if they have drifted far
    const N = world.particles.length;
    if (N > 0) {
      const sampleSize = Math.min(SPEC_SAMPLE, N);
      for (let i = 0; i < sampleSize; i++) {
        const p = world.particles[(Math.random() * N) | 0];
        const c = this.clades.get(p.cladeId);
        if (!c) continue;
        const d = genomeDistance(p.genome, c.meanGenome);
        if (d > SPEC_DIST) {
          const child = this.newClade(p.genome, c.id, world.tick);
          p.cladeId = child.id;
        }
      }
    }

    // Dominance flip detection — only when the new top is meaningful
    const top = this.topClades(1);
    if (top.length && top[0].aliveCount >= 30) {
      const dominant = top[0];
      if (this.lastDominantId !== null && this.lastDominantId !== dominant.id) {
        this.pushEvent(world.tick, 'dominance',
          `clade #${dominant.id} now dominant (${dominant.aliveCount} alive)`,
          SPECIES_COLORS[dominant.species]);
      }
      this.lastDominantId = dominant.id;
    }

    // Mass die-off detection
    this.popSamples.push(N);
    if (this.popSamples.length > 10) this.popSamples.shift();
    if (this.popSamples.length === 10) {
      const peak = Math.max(...this.popSamples);
      if (peak > 200 && N < peak * 0.55 && N < this.popSamples[this.popSamples.length - 2]) {
        this.pushEvent(world.tick, 'crash',
          `population crash · ${peak} → ${N}`,
          '#ff5d6c');
        this.popSamples = [N];
      }
    }

    // ── Narrative epochs ─────────────────────────────────────────────
    if (N > this.peakPop) this.peakPop = N;
    this.cladeCountSamples.push(top.length ? this.clades.size : 0);
    if (this.cladeCountSamples.length > 8) this.cladeCountSamples.shift();
    const cladeBurst = this.cladeCountSamples.length >= 4
      ? (this.cladeCountSamples[this.cladeCountSamples.length - 1] -
         this.cladeCountSamples[0]) / Math.max(1, this.cladeCountSamples[0])
      : 0;

    let livingClades = 0, totalAlive = 0, topAlive = 0, totalSlots = 0, slotsN = 0;
    for (const c of this.clades.values()) {
      if (c.aliveCount > 0) {
        livingClades++;
        totalAlive += c.aliveCount;
        if (c.aliveCount > topAlive) topAlive = c.aliveCount;
      }
    }
    let signalSum = 0, soundSum = 0;
    for (const p of world.particles) {
      totalSlots += p.genome.brain.enabledCount();
      slotsN++;
      const m = (p.signalR + p.signalG + p.signalB) / 3;
      signalSum += Math.max(0, m - 0.5) * 2;
      soundSum += Math.max(0, p.soundAmp - 0.5) * 2;
    }
    const stats = {
      totalPop: totalAlive,
      peakPop: this.peakPop,
      livingClades,
      topShare: totalAlive > 0 ? topAlive / totalAlive : 0,
      cladeBurst,
      meanSlots: slotsN > 0 ? totalSlots / slotsN : 0,
      meanSignal: slotsN > 0 ? signalSum / slotsN : 0,
      meanSound: slotsN > 0 ? soundSum / slotsN : 0,
    };

    for (const ep of this.epochs) {
      const holds = ep.holds(stats);
      if (holds) {
        ep.sustained++;
        if (!ep.active && ep.sustained >= 4) {
          ep.active = true;
          ep.startedAt = world.tick;
          this.epochsStarted++;
          this.pushEvent(world.tick, 'epoch',
            `★ Age of ${ep.name} begins — key shifts +${this.epochsStarted} half-step${this.epochsStarted === 1 ? '' : 's'}`,
            '#ffd166');
        }
      } else {
        if (ep.active) {
          this.pushEvent(world.tick, 'epoch',
            `Age of ${ep.name} ends · lasted ${world.tick - ep.startedAt}t`,
            '#ffd166');
          ep.active = false;
        }
        ep.sustained = 0;
      }
    }
  }

  activeEpochs() {
    return this.epochs.filter(e => e.active);
  }

  pushEvent(tick, type, msg, color) {
    this.events.unshift({ tick, type, msg, color });
    if (this.events.length > EVENT_MAX) this.events.pop();
  }

  topClades(n = 8) {
    const arr = [];
    for (const c of this.clades.values()) {
      if (c.aliveCount > 0) arr.push(c);
    }
    arr.sort((a, b) => b.aliveCount - a.aliveCount);
    return arr.slice(0, n);
  }

  // Composite evolutionary-complexity score.
  // Components are normalized to ~[0,1] and combined with fixed weights so the
  // score is comparable across runs. Used for the HUD and the stagnation
  // watchdog.
  complexity(world) {
    // Cache by tick — the calc samples random particles for variance, so
    // calling it twice on the same tick (or repeatedly while paused) returned
    // slightly different totals each time. Pause should freeze the HUD.
    if (this._complexityCache && this._complexityCache.tick === world.tick) {
      return this._complexityCache.value;
    }
    const ps = world.particles;
    const n = ps.length;

    // 1. Mean brain slots
    let totalSlots = 0;
    for (let i = 0; i < n; i++) totalSlots += ps[i].genome.brain.enabledCount();
    const meanSlots = n ? totalSlots / n : 0;

    // 2. Living-clade count
    let livingClades = 0;
    for (const c of this.clades.values()) if (c.aliveCount > 0) livingClades++;

    // 3. Genome variance — sample-based mean distance to current global centroid
    let variance = 0;
    if (n > 1) {
      const sample = Math.min(80, n);
      // build crude centroid from a sample (cheaper than full mean)
      const centroidAcc = freshGenomeAcc();
      const samplePtrs = [];
      for (let i = 0; i < sample; i++) {
        const p = ps[(Math.random() * n) | 0];
        addToAcc(centroidAcc, p.genome);
        samplePtrs.push(p);
      }
      const centroid = meanFromAcc(centroidAcc, sample, 0);
      let sum = 0;
      for (const p of samplePtrs) sum += genomeDistance(p.genome, centroid);
      variance = sum / sample;
    }

    // 4. Max lineage depth among living clades
    let maxDepth = 0;
    for (const c of this.clades.values()) {
      if (c.aliveCount === 0) continue;
      let d = 0;
      let cur = c;
      while (cur.parentId != null && d < 64) {
        const par = this.clades.get(cur.parentId);
        if (!par) break;
        d++;
        cur = par;
      }
      if (d > maxDepth) maxDepth = d;
    }

    // 5. Communication activity — earlier version stripped the sigmoid baseline
    // and applied a weak *0.6 multiplier, so the score plateaued near 0.3 even
    // with active signaling. Rewritten to combine four sub-signals that each
    // capture a different aspect of "real" communication, normalised so each
    // can independently push comm toward 1.0:
    //   • activity    — mean signal/sound *above* the random-init baseline
    //   • flash       — mean per-tick signal delta (intermittent messaging)
    //   • colorVar    — std-dev of RGB signal across the population
    //                   (vocabulary diversity — lots of identical-color
    //                   particles = no comm; mix of red, green, blue =
    //                   distinct messages)
    //   • bondMsg     — mean expressiveness of bondMsg (distance from 0.5)
    let actSum = 0, flashSum = 0, bondSum = 0;
    let rSum = 0, gSum = 0, bSum = 0;
    let signalSum = 0, soundSum = 0;       // kept for the "raw" readout below
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      const m = (p.signalR + p.signalG + p.signalB) / 3;
      const above = Math.max(0, m - 0.5) * 2;             // 0..1
      const aboveSound = Math.max(0, p.soundAmp - 0.5) * 2;
      actSum += (above + aboveSound) * 0.5;
      // Flash is now a discrete threshold-crossing event from sim.js — it
      // jumps to 1 on a fresh rising edge above 0.65 mean signal then decays
      // at 0.85/tick. Active brains that toggle their signal output
      // contribute meaningfully; silent baselines contribute zero.
      flashSum += p.signalFlash || 0;
      // Phase 6b — bondMsg is now 3 channels. Score expressiveness as the
      // max-channel deviation from 0.5 baseline so a brain using even one
      // channel meaningfully scores well.
      const bondTop = Math.max(
        Math.abs((p.bondMsgR || 0.5) - 0.5),
        Math.abs((p.bondMsgG || 0.5) - 0.5),
        Math.abs((p.bondMsgB || 0.5) - 0.5));
      bondSum += bondTop * 2;
      rSum += p.signalR; gSum += p.signalG; bSum += p.signalB;
      signalSum += above;
      soundSum += aboveSound;
    }
    const meanAct = n ? actSum / n : 0;
    const meanFlash = n ? flashSum / n : 0;
    const meanBondMsg = n ? bondSum / n : 0;
    const rMean = n ? rSum / n : 0, gMean = n ? gSum / n : 0, bMean = n ? bSum / n : 0;
    let cVar = 0;
    for (let i = 0; i < n; i++) {
      const dr = ps[i].signalR - rMean;
      const dg = ps[i].signalG - gMean;
      const db = ps[i].signalB - bMean;
      cVar += dr * dr + dg * dg + db * db;
    }
    const colorStd = n ? Math.sqrt(cVar / n) : 0;
    const meanColorVar = Math.min(1, colorStd * 4);
    const meanSignal = n ? signalSum / n : 0;
    const meanSound = n ? soundSum / n : 0;

    // Normalize each to [0,1] with reasonable saturating caps
    const c1 = Math.min(1, meanSlots / 6);
    const c2 = Math.min(1, Math.log(livingClades + 1) / Math.log(20));
    const c3 = Math.min(1, variance / 3);
    const c4 = Math.min(1, maxDepth / 8);
    // Comm components — flash is now event-based (rising-edge crossings of
    // the signal threshold), so it scores zero for silent populations and
    // positive for any brain that toggles its signal output deliberately.
    const c5 = Math.min(1,
      meanAct       * 0.30 +
      meanFlash     * 0.30 +
      meanColorVar  * 0.30 +
      meanBondMsg   * 0.10);

    const total = 0.30 * c1 + 0.20 * c2 + 0.20 * c3 + 0.15 * c4 + 0.15 * c5;
    const value = {
      total,
      components: { brain: c1, radiation: c2, diversity: c3, depth: c4, comm: c5 },
      raw: {
        meanSlots, livingClades, variance, maxDepth,
        meanSignal, meanSound,
        meanAct, meanFlash, meanColorVar, meanBondMsg,
      },
    };
    this._complexityCache = { tick: world.tick, value };
    return value;
  }

  // Mean attraction matrix indexed by [emitter species][target species].
  attractionMatrix(world) {
    const counts = new Array(NUM_SPECIES).fill(0);
    const m = new Array(NUM_SPECIES);
    for (let i = 0; i < NUM_SPECIES; i++) m[i] = new Float32Array(NUM_SPECIES);
    for (const p of world.particles) {
      const sp = p.genome.species;
      counts[sp]++;
      for (let j = 0; j < NUM_SPECIES; j++) m[sp][j] += p.genome.attraction[j];
    }
    for (let i = 0; i < NUM_SPECIES; i++) {
      if (counts[i] > 0) {
        for (let j = 0; j < NUM_SPECIES; j++) m[i][j] /= counts[i];
      }
    }
    return { matrix: m, counts };
  }

  // ---- Behavior classification ----
  //
  // Tag a clade with descriptive trait labels derived from its mean genome and
  // observed runtime stats. Tags drive the chips shown in the Top Clades panel
  // and on the specimen card.
  classifyClade(c) {
    if (!c || c.aliveCount === 0) return [];
    const m = c.meanGenome;
    const tags = [];

    // Aggressive: high attraction to other species (>= 0.5 in >= 2 slots)
    let highOther = 0;
    let highSelf = m.attraction[c.species] > 0.5 || m.cohesion > 0.5;
    for (let i = 0; i < m.attraction.length; i++) {
      if (i === c.species) continue;
      if (m.attraction[i] > 0.45) highOther++;
    }
    if (highOther >= 2) tags.push({ icon: '⚔', name: 'aggressive', color: '#ff5d6c' });

    // Social: strong cohesion + low alien attraction
    if (m.cohesion > 0.55 && highOther <= 1) {
      tags.push({ icon: '◇', name: 'social', color: '#9ed8a8' });
    }

    // Solitary: very low cohesion, negative
    if (m.cohesion < -0.05) {
      tags.push({ icon: '·', name: 'solitary', color: '#8693a4' });
    }

    // Photic / sun-feeder: low metab, high efficiency, modest sense radius
    if (m.metab < 0.018 && m.efficiency > 1.0) {
      tags.push({ icon: '☀', name: 'photic', color: '#ffd166' });
    }

    // Voracious: high metab + needs lots of food (high sense radius)
    if (m.metab > 0.034 && m.sense_radius > 50) {
      tags.push({ icon: '⌬', name: 'voracious', color: '#ff8a3c' });
    }

    // Wanderer: high speed implied by high motion → derived from high sense radius + low cohesion
    if (m.sense_radius > 60 && m.cohesion < 0.2) {
      tags.push({ icon: '↗', name: 'wanderer', color: '#56c2e6' });
    }

    // Parasite: positive attraction to many species + low repro_thresh + low metab
    if (highOther >= 3 && m.repro_thresh < 6 && m.metab < 0.03) {
      tags.push({ icon: '✷', name: 'parasite', color: '#a78bfa' });
    }

    // Vocal: heavy non-baseline communication signaling — needs runtime sample,
    // approximated from mean emit + the brain having enough capacity
    if (m.emit && (m.emit[0] + m.emit[1]) > 0.05) {
      tags.push({ icon: '♪', name: 'vocal', color: '#f9b3ff' });
    }

    // Sentinel: high cohesion + high efficiency + low metab → long-lived guardians
    if (m.cohesion > 0.6 && m.efficiency > 1.1 && m.metab < 0.025) {
      tags.push({ icon: '◉', name: 'sentinel', color: '#56e6c2' });
    }

    return tags;
  }

  // ---- Persistence ----
  toJSON() {
    return {
      _cladeId,
      lastDominantId: this.lastDominantId,
      clades: [...this.clades.values()].map(c => ({
        id: c.id, parentId: c.parentId,
        name: c.name,
        founder: genomeToJSON(c.founderGenome),
        species: c.species,
        foundedTick: c.foundedTick,
        peakCount: c.peakCount,
        lastSeenTick: c.lastSeenTick,
        totalEverBorn: c.totalEverBorn,
        mean: genomeToJSON(c.meanGenome),
        popHistory: c.popHistory,
      })),
      events: this.events,
      fossils: this.fossils.map(f => ({
        tick: f.tick, age: f.age, energy: f.energy,
        species: f.species, cladeId: f.cladeId,
        genome: genomeToJSON(f.genome),
      })),
    };
  }

  fromJSON(data) {
    this.clades.clear();
    this.events = data.events || [];
    this.fossils = (data.fossils || []).map(f => ({
      ...f, genome: genomeFromJSON(f.genome),
    }));
    this.lastDominantId = data.lastDominantId ?? null;
    if (typeof data._cladeId === 'number') _cladeId = Math.max(_cladeId, data._cladeId);
    for (const obj of (data.clades || [])) {
      const c = new Clade(obj.id, obj.parentId, genomeFromJSON(obj.founder), obj.foundedTick);
      c.species = obj.species ?? c.species;
      c.peakCount = obj.peakCount || 0;
      c.lastSeenTick = obj.lastSeenTick ?? c.foundedTick;
      c.totalEverBorn = obj.totalEverBorn || 0;
      c.meanGenome = genomeFromJSON(obj.mean);
      c.popHistory = obj.popHistory || [];
      c.name = obj.name || generateCladeName(c, this);
      this.clades.set(c.id, c);
    }
  }
}
