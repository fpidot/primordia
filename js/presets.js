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

// Maze — programmatically generated each load. Several straight wall
// segments with random orientation, position, length, and type, with
// gaps left mid-segment and a guaranteed mix of all three wall types.
// Constraints aim for a maze that's traversable but partitions the
// world enough to exercise directional sensors + bondMsg.
function maze(world) {
  world.reset();

  // Helpers — same as before
  const setWall = (gx, gy, type) => {
    if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return;
    const idx = gy * GW + gx;
    if (!world.walls[idx]) world._wallCount++;
    world.walls[idx] = type;
  };
  const paintLineH = (gy, x0, x1, type) => {
    for (let x = x0; x <= x1; x++) {
      setWall(x, gy, type);
      setWall(x, gy + 1, type);
    }
  };
  const paintLineV = (gx, y0, y1, type) => {
    for (let y = y0; y <= y1; y++) {
      setWall(gx, y, type);
      setWall(gx + 1, y, type);
    }
  };

  // Wall budget — aim for ~5–8% of grid cells walled, distributed across
  // 6–10 segments. Type mix tilted toward solid (most), with at least
  // one membrane and one porous segment guaranteed.
  const segCount = 6 + ((Math.random() * 5) | 0);   // 6..10
  const types = [];
  // Force variety: 1 membrane, 1 porous, rest solid biased
  types.push(WALL_MEMBRANE, WALL_POROUS);
  for (let i = 2; i < segCount; i++) {
    const r = Math.random();
    types.push(r < 0.65 ? WALL_SOLID : (r < 0.83 ? WALL_MEMBRANE : WALL_POROUS));
  }
  // Shuffle so the membrane/porous aren't always at the front
  for (let i = types.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [types[i], types[j]] = [types[j], types[i]];
  }

  for (let s = 0; s < segCount; s++) {
    const horizontal = Math.random() < 0.5;
    const lenMin = (horizontal ? GW : GH) * 0.25;
    const lenMax = (horizontal ? GW : GH) * 0.55;
    const segLen = (lenMin + Math.random() * (lenMax - lenMin)) | 0;
    if (horizontal) {
      const gy = (8 + Math.random() * (GH - 16)) | 0;
      const xStart = (Math.random() * (GW - segLen)) | 0;
      const xEnd = xStart + segLen;
      // 0–2 random gaps within the segment for traversability
      const gaps = [];
      const numGaps = 1 + ((Math.random() * 2) | 0);
      for (let g = 0; g < numGaps; g++) {
        const gx = xStart + ((segLen * (0.2 + Math.random() * 0.6)) | 0);
        const gw = 6 + ((Math.random() * 8) | 0);
        gaps.push([gx - (gw >> 1), gx + (gw >> 1)]);
      }
      let cursor = xStart;
      gaps.sort((a, b) => a[0] - b[0]);
      for (const [g0, g1] of gaps) {
        if (cursor < g0) paintLineH(gy, cursor, g0 - 1, types[s]);
        cursor = Math.max(cursor, g1 + 1);
      }
      if (cursor <= xEnd) paintLineH(gy, cursor, xEnd, types[s]);
    } else {
      const gx = (8 + Math.random() * (GW - 16)) | 0;
      const yStart = (Math.random() * (GH - segLen)) | 0;
      const yEnd = yStart + segLen;
      const gaps = [];
      const numGaps = 1 + ((Math.random() * 2) | 0);
      for (let g = 0; g < numGaps; g++) {
        const gy = yStart + ((segLen * (0.2 + Math.random() * 0.6)) | 0);
        const gw = 6 + ((Math.random() * 8) | 0);
        gaps.push([gy - (gw >> 1), gy + (gw >> 1)]);
      }
      let cursor = yStart;
      gaps.sort((a, b) => a[0] - b[0]);
      for (const [g0, g1] of gaps) {
        if (cursor < g0) paintLineV(gx, cursor, g0 - 1, types[s]);
        cursor = Math.max(cursor, g1 + 1);
      }
      if (cursor <= yEnd) paintLineV(gx, cursor, yEnd, types[s]);
    }
  }

  world._wallsVersion++;

  // Seed particles distributed evenly across the world. Each species gets
  // one founder clade. Skip placement if cell is wall (retry up to 8x).
  const perSpecies = 80;
  for (let s = 0; s < NUM_SPECIES; s++) {
    const founder = world.beginClade(makeGenome(s));
    for (let i = 0; i < perSpecies; i++) {
      let x, y;
      for (let tries = 0; tries < 8; tries++) {
        x = Math.random() * (W - 20) + 10;
        y = Math.random() * (H - 20) + 10;
        const gx = clamp((x / CELL) | 0, 0, GW - 1);
        const gy = clamp((y / CELL) | 0, 0, GH - 1);
        if (!world.walls[gy * GW + gx]) break;
      }
      world.addParticle(x, y, makeGenome(s), 4 + Math.random() * 2, founder);
    }
  }

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
