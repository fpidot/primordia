// presets.js — initial-condition factories.
// Each preset returns void after seeding the World.

import { W, H, GW, GH, CELL, WALL_SOLID, WALL_MEMBRANE, WALL_POROUS } from './sim.js';
import { NUM_SPECIES, makeGenome, randomMatrixRow } from './genome.js';

export const PRESETS = {
  soup, predprey, symbiotic, maze, empty,
};

// Particle counts seeded by each preset. Kept here next to the preset bodies
// so the UI can show "Soup · 1800" etc. without anyone having to read JS.
export const PRESET_COUNTS = {
  soup: 1800,
  predprey: 240 + 1400,
  symbiotic: NUM_SPECIES * 110,
  maze: NUM_SPECIES * 80,
  empty: 0,
};

// Fresh Soup — random genomes, even species mix, scattered food.
// Each species starts with one founder clade; speciation forks from there.
function soup(world, count = 1800) {
  world.reset();
  const founders = [];
  for (let s = 0; s < NUM_SPECIES; s++) {
    founders.push(world.beginClade(makeGenome(s)));
  }
  for (let i = 0; i < count; i++) {
    const sp = i % NUM_SPECIES;
    const x = Math.random() * (W - 20) + 10;
    const y = Math.random() * (H - 20) + 10;
    world.addParticle(x, y, makeGenome(sp), 4 + Math.random() * 2, founders[sp]);
  }
  scatterFood(world, 0.5, 0.28);
}

// Predator–Prey — two species, one preys on the other.
// Species 0 (red) = predator, hunts species 2 (green); species 2 = prey, eats food.
function predprey(world) {
  world.reset();
  const predator = makeSeedGenome(0, {
    attraction: [-0.2,  0.0,  0.95, 0.0, 0.0, 0.0],
    sense: [0.4, 0.6],          // tracks decay of victims
    cohesion: -0.1,
    repro_thresh: 9,
    metab: 0.018,
    efficiency: 1.5,
    sense_radius: 50,
  });
  const prey = makeSeedGenome(2, {
    attraction: [-0.95, 0.0,  0.55, 0.0, 0.0, 0.0],
    sense: [1.6, -0.5],
    cohesion: 0.7,
    repro_thresh: 5,
    metab: 0.014,
    efficiency: 1.2,
    sense_radius: 28,
  });

  const predClade = world.beginClade(predator);
  const preyClade = world.beginClade(prey);
  for (let i = 0; i < 240; i++) {
    world.addParticle(Math.random() * W, Math.random() * H, jitterGenome(predator), 5, predClade);
  }
  for (let i = 0; i < 1400; i++) {
    world.addParticle(Math.random() * W, Math.random() * H, jitterGenome(prey), 4, preyClade);
  }
  scatterFood(world, 0.6, 0.45);
}

// Symbiotic Web — every species mildly attracts the next-in-cycle and itself.
// Wraps around all NUM_SPECIES so any palette size works.
function symbiotic(world) {
  world.reset();
  for (let s = 0; s < NUM_SPECIES; s++) {
    const next = (s + 1) % NUM_SPECIES;
    const a = new Float32Array(NUM_SPECIES);
    a[s] = 0.45;          // self-cohesion baked in
    a[next] = 0.7;        // chase the next link
    const tpl = makeSeedGenome(s, {
      attraction: a,
      cohesion: 0.5,
      sense: [0.9, -0.2],
      repro_thresh: 7,
      metab: 0.022,
      efficiency: 1.0,
      sense_radius: 50,
    });
    const cols = 4, rows = 4;
    const col = s % cols, row = (s / cols) | 0;
    const cx = (col + 0.5) / cols * W;
    const cy = (row + 0.5) / rows * H;
    const clade = world.beginClade(tpl);
    for (let i = 0; i < 110; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * 70;
      world.addParticle(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, jitterGenome(tpl), 5, clade);
    }
  }
  scatterFood(world, 0.5, 0.32);
}

// Maze — four rooms separated by a mix of solid walls, a sound/chem-permeable
// membrane window (particles can sense the other side), and a particle-pass
// porous gap (matter flows but chemical trails get clipped). Tests the
// directional sensors and bondMsg propagation under spatial constraint.
function maze(world) {
  world.reset();
  const cx = (GW / 2) | 0;
  const cy = (GH / 2) | 0;

  // Helpers
  const setWall = (gx, gy, type) => {
    if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return;
    const idx = gy * GW + gx;
    if (!world.walls[idx]) world._wallCount++;
    world.walls[idx] = type;
  };
  // Paint a 2-cell-thick line so walls read clearly at low zoom
  const lineV = (gx, y0, y1, type) => {
    for (let y = y0; y <= y1; y++) {
      setWall(gx, y, type);
      setWall(gx + 1, y, type);
    }
  };
  const lineH = (gy, x0, x1, type) => {
    for (let x = x0; x <= x1; x++) {
      setWall(x, gy, type);
      setWall(x, gy + 1, type);
    }
  };

  // Vertical spine: solid top quarter, membrane window in mid, solid bottom
  // quarter — leaves a "viewing window" between top and bottom halves.
  const winY0 = (GH * 0.40) | 0;
  const winY1 = (GH * 0.65) | 0;
  lineV(cx, 0, winY0 - 1, WALL_SOLID);
  lineV(cx, winY0, winY1, WALL_MEMBRANE);
  lineV(cx, winY1 + 1, GH - 1, WALL_SOLID);

  // Horizontal spine: solid left, porous mid, solid right — particles can
  // squeeze through the porous strip but their food/decay trails get clipped.
  const porX0 = (GW * 0.30) | 0;
  const porX1 = (GW * 0.45) | 0;
  lineH(cy, 0, porX0 - 1, WALL_SOLID);
  lineH(cy, porX0, porX1, WALL_POROUS);
  lineH(cy, porX1 + 1, cx - 2, WALL_SOLID);
  lineH(cy, cx + 2, GW - 1, WALL_SOLID);

  world._wallsVersion++;

  // Seed particles distributed evenly across all four rooms. Each species
  // gets one founder clade. Particles dropped randomly anywhere — wall
  // collisions resolve at first integration step.
  const perSpecies = 80;
  for (let s = 0; s < NUM_SPECIES; s++) {
    const founder = world.beginClade(makeGenome(s));
    for (let i = 0; i < perSpecies; i++) {
      let x, y, idx;
      // Try a few times to avoid placing inside walls
      for (let tries = 0; tries < 6; tries++) {
        x = Math.random() * (W - 20) + 10;
        y = Math.random() * (H - 20) + 10;
        const gx = clamp((x / CELL) | 0, 0, GW - 1);
        const gy = clamp((y / CELL) | 0, 0, GH - 1);
        idx = gy * GW + gx;
        if (!world.walls[idx]) break;
      }
      world.addParticle(x, y, makeGenome(s), 4 + Math.random() * 2, founder);
    }
  }

  // Food sprinkled in each quadrant — uneven so some rooms are hungrier
  // than others, forcing trans-wall pressure.
  scatterFood(world, 0.5, 0.30);
}

function empty(world) {
  world.reset();
}

// ─────────────────────────────────────────────────────────────── helpers

function makeSeedGenome(species, overrides) {
  const g = makeGenome(species);
  // Merge partial attraction arrays into the full NUM_SPECIES vector
  if (overrides.attraction) {
    for (let i = 0; i < Math.min(NUM_SPECIES, overrides.attraction.length); i++) {
      g.attraction[i] = overrides.attraction[i];
    }
  }
  if (overrides.sense) {
    for (let i = 0; i < Math.min(g.sense.length, overrides.sense.length); i++) {
      g.sense[i] = overrides.sense[i];
    }
  }
  if (overrides.emit) {
    for (let i = 0; i < Math.min(g.emit.length, overrides.emit.length); i++) {
      g.emit[i] = overrides.emit[i];
    }
  }
  if (overrides.cohesion !== undefined) g.cohesion = overrides.cohesion;
  if (overrides.metab !== undefined) g.metab = overrides.metab;
  if (overrides.efficiency !== undefined) g.efficiency = overrides.efficiency;
  if (overrides.repro_thresh !== undefined) g.repro_thresh = overrides.repro_thresh;
  if (overrides.mut_rate !== undefined) g.mut_rate = overrides.mut_rate;
  if (overrides.sense_radius !== undefined) g.sense_radius = overrides.sense_radius;
  return g;
}

function jitterGenome(g, sigma = 0.06) {
  const out = makeSeedGenome(g.species, {});
  out.attraction = Float32Array.from(g.attraction, v => clamp(v + (Math.random() - 0.5) * sigma * 2, -1, 1));
  out.emit = Float32Array.from(g.emit);
  out.sense = Float32Array.from(g.sense, v => clamp(v + (Math.random() - 0.5) * sigma * 2, -2.5, 2.5));
  out.cohesion = clamp(g.cohesion + (Math.random() - 0.5) * sigma * 2, -0.5, 1.2);
  out.metab = clamp(g.metab + (Math.random() - 0.5) * 0.004, 0.005, 0.2);
  out.efficiency = clamp(g.efficiency + (Math.random() - 0.5) * 0.2, 0.1, 2.5);
  out.repro_thresh = clamp(g.repro_thresh + (Math.random() - 0.5) * 1.5, 1.5, 30);
  out.mut_rate = g.mut_rate;
  out.sense_radius = clamp(g.sense_radius + (Math.random() - 0.5) * 8, 12, 90);
  return out;
}

function scatterFood(world, intensity = 0.4, coverage = 0.2) {
  const f = world.field[0];
  // Smooth blobs using random gaussian-ish stamps
  const stamps = Math.floor(coverage * 200);
  for (let s = 0; s < stamps; s++) {
    const cx = Math.random() * GW;
    const cy = Math.random() * GH;
    const r = 4 + Math.random() * 8;
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      const y = (cy + dy) | 0;
      if (y < 0 || y >= GH) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = (cx + dx) | 0;
        if (x < 0 || x >= GW) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const fall = 1 - d2 / r2;
        f[y * GW + x] = Math.min(6, f[y * GW + x] + intensity * fall);
      }
    }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
