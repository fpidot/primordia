// genome.js — per-particle mutable parameter vector + Brain controller.
// The fixed-vector parameters describe the "body plan" (always-active
// behaviour); the Brain (CTRNN with enable-gated hidden slots) sits on top and
// adds learned, variable-complexity decisions whose outputs are *additive* on
// the body-plan substrate. New genomes start with near-zero brain weights so
// behavior degrades gracefully to Phase-0 dynamics.

export const NUM_SPECIES = 16;
export const NUM_CHEM = 2;        // 0 = food, 1 = decay
export const CHEM_NAMES = ['food', 'decay'];

import {
  makeBrain, cloneBrain, mutateBrain, brainToJSON, brainFromJSON, crossoverBrain,
} from './brain.js';

export const SPECIES_NAMES = [
  'vermillion', 'tangerine', 'amber',  'lime',
  'verdant',    'teal',      'azure',  'cobalt',
  'iris',       'plum',      'rose',   'blush',
  'umber',      'olive',     'slate',  'garnet',
];
// Visually-distinct palette across hue + lightness
export const SPECIES_COLORS = [
  '#ff5d6c', '#ff9f47', '#ffd166', '#d4f55c',
  '#9ed8a8', '#56e6c2', '#56c2e6', '#5b8def',
  '#a78bfa', '#d18bfa', '#f9b3ff', '#ff8ab8',
  '#bd6e3d', '#7e9b6c', '#6c7e9b', '#9b6c7e',
];
// As float [r,g,b] for additive rendering
export const SPECIES_RGB = SPECIES_COLORS.map(hex => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// Approximate normal via three-uniform sum (fast, good enough for genetic noise)
const gauss = (rng, sigma = 1) => ((rng() + rng() + rng()) - 1.5) * sigma * 0.8165;

export function randomMatrixRow(rng = Math.random, scale = 0.6) {
  const a = new Float32Array(NUM_SPECIES);
  for (let i = 0; i < NUM_SPECIES; i++) a[i] = (rng() * 2 - 1) * scale;
  return a;
}

// Initial prey-preference vector — small random spread around zero so most
// species are mostly-neutral but a few start with mild bias.
function makePreyPref(rng = Math.random) {
  const a = new Float32Array(NUM_SPECIES);
  for (let i = 0; i < NUM_SPECIES; i++) a[i] = (rng() - 0.5) * 0.3;
  return a;
}

export function makeGenome(species, rng = Math.random, opts = {}) {
  const attraction = opts.attraction
    ? Float32Array.from(opts.attraction)
    : randomMatrixRow(rng);
  const emit = new Float32Array(NUM_CHEM);
  emit[0] = 0;                          // food: rarely emit
  emit[1] = 0;                          // decay: deposited on death
  const sense = new Float32Array(NUM_CHEM);
  sense[0] = 0.6 + rng() * 1.4;         // food chemotaxis
  sense[1] = (rng() - 0.5) * 0.7;       // decay sensing weak

  return {
    species,
    attraction,
    emit,
    sense,
    cohesion: 0.3 + rng() * 0.5,
    metab: 0.022 + rng() * 0.018,
    efficiency: 0.7 + rng() * 0.7,
    repro_thresh: 7 + rng() * 6,
    mut_rate: 0.04,
    sense_radius: 38 + rng() * 28,
    // Cluster affinity ∈ [-1, 1] — positive bias makes a particle more
    // willing to bond with another that's already in its cluster (boosts
    // wantBond gate). Negative bias prefers strangers. Selection pressure
    // toward stable colonies should push this positive over time.
    cluster_affinity: (rng() - 0.5) * 0.6,
    // Aversion to attacking clustermates ∈ [-0.5, 1.5]. Init centred at 0.5
    // (50% reduction of predation rate against own colony). Negative values
    // = cannibalistic strategy (drain own kin); positive = strict loyalty
    // (zero kin attacks). Selection sorts which strategy pays.
    kin_aversion: 0.3 + rng() * 0.4,
    // Per-victim-species predation preference ∈ [-1, 1]. At a predation
    // event, drain rate is multiplied by max(0, 1 + prey_preference[victim
    // species]) — negative preference fully spares that species, positive
    // doubles drain. Decouples "I chase X" (attraction) from "I drain X
    // hard if I catch it" (this trait); enables evolved roles like "spare
    // your symbiote, exterminate your competitor".
    prey_preference: makePreyPref(rng),
    // Wall-deposit affinity ∈ [-1, 1]. Builders (positive) prefer placing
    // walls adjacent to existing walls — extends structures into useful
    // forms. Scatterers (negative) prefer isolated cells — territorial
    // markers, scattered obstacles. Applied at deposit time when picking
    // among candidate cells.
    wall_affinity: (rng() - 0.5) * 0.6,
    // Prey-trap-walling tendency ∈ [-1, 1]. Couples deposit choice to the
    // particle's strongest prey_preference: positive → prefer cells next
    // to many of that prey species (trap-building); negative → away from
    // them (territorial avoidance). Combined with wall_affinity at the
    // candidate-scoring step.
    prey_walling: (rng() - 0.5) * 0.4,
    brain: opts.brain || makeBrain(rng, 4),
  };
}

export function cloneGenome(g) {
  return {
    species: g.species,
    attraction: Float32Array.from(g.attraction),
    emit: Float32Array.from(g.emit),
    sense: Float32Array.from(g.sense),
    cohesion: g.cohesion,
    metab: g.metab,
    efficiency: g.efficiency,
    repro_thresh: g.repro_thresh,
    mut_rate: g.mut_rate,
    sense_radius: g.sense_radius,
    cluster_affinity: g.cluster_affinity ?? 0,
    kin_aversion: g.kin_aversion ?? 0.5,
    prey_preference: g.prey_preference
      ? Float32Array.from(g.prey_preference)
      : new Float32Array(NUM_SPECIES),
    wall_affinity: g.wall_affinity ?? 0,
    prey_walling: g.prey_walling ?? 0,
    brain: g.brain ? cloneBrain(g.brain) : makeBrain(),
  };
}

// Mutation: per-gene Gaussian perturbation scaled by mut_rate, with rare speciation drift.
export function mutate(g, rng = Math.random, boost = 1) {
  const r = g.mut_rate * boost;
  const out = cloneGenome(g);
  for (let i = 0; i < NUM_SPECIES; i++) {
    out.attraction[i] = clamp(out.attraction[i] + gauss(rng, r), -1, 1);
  }
  for (let i = 0; i < NUM_CHEM; i++) {
    out.emit[i] = Math.max(0, out.emit[i] + gauss(rng, r * 0.5));
    out.sense[i] = clamp(out.sense[i] + gauss(rng, r), -2.5, 2.5);
  }
  out.cohesion = clamp(out.cohesion + gauss(rng, r), -0.5, 1.2);
  out.metab = clamp(out.metab + gauss(rng, r * 0.1), 0.005, 0.2);
  out.efficiency = clamp(out.efficiency + gauss(rng, r * 0.5), 0.1, 2.5);
  out.repro_thresh = clamp(out.repro_thresh + gauss(rng, r * 5), 1.5, 30);
  out.mut_rate = clamp(out.mut_rate + gauss(rng, r * 0.3), 0.005, 0.25);
  out.sense_radius = clamp(out.sense_radius + gauss(rng, r * 8), 12, 90);
  out.cluster_affinity = clamp((out.cluster_affinity ?? 0) + gauss(rng, r * 0.6), -1, 1);
  out.kin_aversion = clamp((out.kin_aversion ?? 0.5) + gauss(rng, r * 0.6), -0.5, 1.5);
  if (!out.prey_preference) out.prey_preference = makePreyPref(rng);
  for (let i = 0; i < NUM_SPECIES; i++) {
    out.prey_preference[i] = clamp(out.prey_preference[i] + gauss(rng, r * 0.5), -1, 1);
  }
  out.wall_affinity = clamp((out.wall_affinity ?? 0) + gauss(rng, r * 0.6), -1, 1);
  out.prey_walling = clamp((out.prey_walling ?? 0) + gauss(rng, r * 0.4), -1, 1);

  // Mutate brain (clones + perturbs)
  out.brain = g.brain ? mutateBrain(g.brain, rng, g.mut_rate, boost) : makeBrain(rng);

  // Rare colour drift — keeps tags meaningful but allows phenotype shift
  if (rng() < 0.004 * boost) {
    const dir = rng() < 0.5 ? 1 : NUM_SPECIES - 1;
    out.species = (g.species + dir) % NUM_SPECIES;
  }
  return out;
}

// Sexual reproduction: per-gene uniform crossover between two parents,
// per-slot crossover for the brain. Output is then typically passed through
// `mutate()` for a final round of mutation noise.
export function crossoverGenome(a, b, rng = Math.random) {
  const out = cloneGenome(a);
  for (let i = 0; i < NUM_SPECIES; i++) {
    if (rng() < 0.5) out.attraction[i] = b.attraction[i];
  }
  for (let i = 0; i < NUM_CHEM; i++) {
    if (rng() < 0.5) out.emit[i] = b.emit[i];
    if (rng() < 0.5) out.sense[i] = b.sense[i];
  }
  if (rng() < 0.5) out.cohesion = b.cohesion;
  if (rng() < 0.5) out.metab = b.metab;
  if (rng() < 0.5) out.efficiency = b.efficiency;
  if (rng() < 0.5) out.repro_thresh = b.repro_thresh;
  if (rng() < 0.5) out.mut_rate = b.mut_rate;
  if (rng() < 0.5) out.sense_radius = b.sense_radius;
  if (rng() < 0.5) out.cluster_affinity = b.cluster_affinity ?? 0;
  if (rng() < 0.5) out.kin_aversion = b.kin_aversion ?? 0.5;
  // Crossover prey_preference per-element so children mix targeting profiles.
  if (b.prey_preference && out.prey_preference) {
    for (let i = 0; i < NUM_SPECIES; i++) {
      if (rng() < 0.5) out.prey_preference[i] = b.prey_preference[i];
    }
  }
  if (rng() < 0.5) out.wall_affinity = b.wall_affinity ?? 0;
  if (rng() < 0.5) out.prey_walling = b.prey_walling ?? 0;
  if (rng() < 0.5) out.species = b.species;
  out.brain = a.brain && b.brain ? crossoverBrain(a.brain, b.brain, rng)
                                 : (b.brain ? cloneBrain(b.brain) : cloneBrain(a.brain));
  return out;
}

// Genome distance — used by clade tracker for speciation detection.
// Weights chosen so attraction dominates (it drives behavior the most).
export function genomeDistance(a, b) {
  let s = 0;
  for (let i = 0; i < NUM_SPECIES; i++) {
    const d = a.attraction[i] - b.attraction[i];
    s += d * d;
  }
  for (let i = 0; i < NUM_CHEM; i++) {
    const d = a.sense[i] - b.sense[i];
    s += 0.5 * d * d;
    const e = a.emit[i] - b.emit[i];
    s += 0.5 * e * e;
  }
  s += (a.cohesion - b.cohesion) ** 2;
  s += ((a.efficiency - b.efficiency) * 0.5) ** 2;
  s += ((a.metab - b.metab) * 10) ** 2;
  s += ((a.sense_radius - b.sense_radius) * 0.05) ** 2;
  s += ((a.repro_thresh - b.repro_thresh) * 0.15) ** 2;
  return Math.sqrt(s);
}

// JSON serialisation helpers (TypedArrays -> arrays)
export function genomeToJSON(g) {
  return {
    species: g.species,
    attraction: Array.from(g.attraction),
    emit: Array.from(g.emit),
    sense: Array.from(g.sense),
    cohesion: g.cohesion,
    metab: g.metab,
    efficiency: g.efficiency,
    repro_thresh: g.repro_thresh,
    mut_rate: g.mut_rate,
    sense_radius: g.sense_radius,
    cluster_affinity: g.cluster_affinity ?? 0,
    kin_aversion: g.kin_aversion ?? 0.5,
    prey_preference: g.prey_preference ? Array.from(g.prey_preference) : null,
    wall_affinity: g.wall_affinity ?? 0,
    prey_walling: g.prey_walling ?? 0,
    brain: g.brain ? brainToJSON(g.brain) : null,
  };
}
export function genomeFromJSON(o) {
  // Pad/truncate attraction to current NUM_SPECIES so older saves still load.
  const attraction = new Float32Array(NUM_SPECIES);
  const src = o.attraction || [];
  for (let i = 0; i < Math.min(NUM_SPECIES, src.length); i++) attraction[i] = src[i];
  const emit = new Float32Array(NUM_CHEM);
  const sense = new Float32Array(NUM_CHEM);
  for (let i = 0; i < Math.min(NUM_CHEM, (o.emit || []).length); i++) emit[i] = o.emit[i];
  for (let i = 0; i < Math.min(NUM_CHEM, (o.sense || []).length); i++) sense[i] = o.sense[i];
  return {
    species: Math.min(NUM_SPECIES - 1, o.species ?? 0),
    attraction, emit, sense,
    cohesion: o.cohesion ?? 0.5,
    metab: o.metab ?? 0.025,
    efficiency: o.efficiency ?? 1.0,
    repro_thresh: o.repro_thresh ?? 8,
    mut_rate: o.mut_rate ?? 0.04,
    sense_radius: o.sense_radius ?? 50,
    cluster_affinity: o.cluster_affinity ?? 0,
    kin_aversion: o.kin_aversion ?? 0.5,
    prey_preference: o.prey_preference
      ? (() => {
          const a = new Float32Array(NUM_SPECIES);
          for (let i = 0; i < Math.min(NUM_SPECIES, o.prey_preference.length); i++) {
            a[i] = o.prey_preference[i];
          }
          return a;
        })()
      : new Float32Array(NUM_SPECIES),
    wall_affinity: o.wall_affinity ?? 0,
    prey_walling: o.prey_walling ?? 0,
    brain: o.brain ? brainFromJSON(o.brain) : makeBrain(),
  };
}
