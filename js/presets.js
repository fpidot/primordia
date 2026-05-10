// presets.js — initial-condition factories.
// Each preset returns void after seeding the World.

import { W, H, GW, GH, CELL, WALL_SOLID, WALL_MEMBRANE, WALL_POROUS } from './sim.js';
import { NUM_SPECIES, makeGenome, randomMatrixRow } from './genome.js';

export const PRESETS = {
  soup, predprey, symbiotic, maze, planet,
};

// Particle counts seeded by each preset. Kept here next to the preset bodies
// so the UI can show "Soup · 1800" etc. without anyone having to read JS.
export const PRESET_COUNTS = {
  soup: 1800,
  predprey: 240 + 1400,
  symbiotic: NUM_SPECIES * 110,
  maze: NUM_SPECIES * 80,
  planet: NUM_SPECIES * 45,
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
function predprey(world, count = PRESET_COUNTS.predprey) {
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
  const predCount = Math.max(0, Math.round(count * (240 / PRESET_COUNTS.predprey)));
  const preyCount = Math.max(0, count - predCount);
  for (let i = 0; i < predCount; i++) {
    world.addParticle(Math.random() * W, Math.random() * H, jitterGenome(predator), 5, predClade);
  }
  for (let i = 0; i < preyCount; i++) {
    world.addParticle(Math.random() * W, Math.random() * H, jitterGenome(prey), 4, preyClade);
  }
  scatterFood(world, 0.6, 0.45);
}

// Symbiotic Web — every species mildly attracts the next-in-cycle and itself.
// Wraps around all NUM_SPECIES so any palette size works.
function symbiotic(world, count = PRESET_COUNTS.symbiotic) {
  world.reset();
  const perSpecies = Math.max(0, Math.round(count / NUM_SPECIES));
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
    for (let i = 0; i < perSpecies; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * 70;
      world.addParticle(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, jitterGenome(tpl), 5, clade);
    }
  }
  scatterFood(world, 0.5, 0.32);
}

// Maze — programmatically generated each load. Mix of partition walls
// (long straight segments with one or two narrow gaps, encouraging
// quasi-discontinuous regions that reward digging) and feedstock blobs
// (irregular patches of solid wall ~12-22 cells across, useful as
// material for builder lineages). Wall thickness varies so some cells
// can be punched through quickly while others form chunky barriers.
function maze(world, count = PRESET_COUNTS.maze) {
  world.reset();

  // Helpers
  const setWall = (gx, gy, type) => {
    if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return;
    const idx = gy * GW + gx;
    if (!world.walls[idx]) world._wallCount++;
    world.walls[idx] = type;
  };
  // Paint a horizontal line of given thickness (width along y axis)
  const paintLineH = (gy, x0, x1, type, thick) => {
    for (let x = x0; x <= x1; x++) {
      for (let dy = 0; dy < thick; dy++) setWall(x, gy + dy, type);
    }
  };
  const paintLineV = (gx, y0, y1, type, thick) => {
    for (let y = y0; y <= y1; y++) {
      for (let dx = 0; dx < thick; dx++) setWall(gx + dx, y, type);
    }
  };
  // Irregular roundish blob of solid wall — feedstock for diggers/builders.
  // Uses a sum of two off-centre disc tests for a non-circular outline.
  const paintBlob = (cx, cy, radius) => {
    const r2 = radius * radius;
    const ox = (Math.random() - 0.5) * radius * 0.5;
    const oy = (Math.random() - 0.5) * radius * 0.5;
    const r2b = (radius * 0.7) ** 2;
    for (let dy = -radius - 2; dy <= radius + 2; dy++) {
      for (let dx = -radius - 2; dx <= radius + 2; dx++) {
        const gx = cx + dx, gy = cy + dy;
        if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) continue;
        const d1 = dx * dx + dy * dy;
        const d2 = (dx - ox) ** 2 + (dy - oy) ** 2;
        if (d1 <= r2 || d2 <= r2b) setWall(gx, gy, WALL_SOLID);
      }
    }
  };

  // Partition segments — fewer and narrower-gapped so they actually
  // cut the world into rooms rather than scattering disconnected pieces.
  // 4-7 segments with 1 (sometimes 2) gaps each. Thickness 3-7 cells:
  // digging is now common enough that some barriers should be chunky, both
  // as longer-term constraints and as usable raw material.
  const segCount = 4 + ((Math.random() * 4) | 0);   // 4..7
  const types = [WALL_MEMBRANE, WALL_POROUS];        // force one glass and one mud segment
  for (let i = 2; i < segCount; i++) {
    const r = Math.random();
    types.push(r < 0.70 ? WALL_SOLID : (r < 0.85 ? WALL_MEMBRANE : WALL_POROUS));
  }
  for (let i = types.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [types[i], types[j]] = [types[j], types[i]];
  }

  for (let s = 0; s < segCount; s++) {
    const horizontal = Math.random() < 0.5;
    const lenMin = (horizontal ? GW : GH) * 0.50;     // longer than before
    const lenMax = (horizontal ? GW : GH) * 0.85;
    const segLen = (lenMin + Math.random() * (lenMax - lenMin)) | 0;
    const thick = 3 + ((Math.random() * 5) | 0);      // 3..7 cells thick
    if (horizontal) {
      const gy = (8 + Math.random() * (GH - 16 - thick)) | 0;
      const xStart = (Math.random() * (GW - segLen)) | 0;
      const xEnd = xStart + segLen;
      const numGaps = 1 + (Math.random() < 0.35 ? 1 : 0);   // mostly 1 gap
      const gaps = [];
      for (let g = 0; g < numGaps; g++) {
        const gx = xStart + ((segLen * (0.2 + Math.random() * 0.6)) | 0);
        const gw = 5 + ((Math.random() * 5) | 0);            // narrower gaps
        gaps.push([gx - (gw >> 1), gx + (gw >> 1)]);
      }
      gaps.sort((a, b) => a[0] - b[0]);
      let cursor = xStart;
      for (const [g0, g1] of gaps) {
        if (cursor < g0) paintLineH(gy, cursor, g0 - 1, types[s], thick);
        cursor = Math.max(cursor, g1 + 1);
      }
      if (cursor <= xEnd) paintLineH(gy, cursor, xEnd, types[s], thick);
    } else {
      const gx = (8 + Math.random() * (GW - 16 - thick)) | 0;
      const yStart = (Math.random() * (GH - segLen)) | 0;
      const yEnd = yStart + segLen;
      const numGaps = 1 + (Math.random() < 0.35 ? 1 : 0);
      const gaps = [];
      for (let g = 0; g < numGaps; g++) {
        const gy = yStart + ((segLen * (0.2 + Math.random() * 0.6)) | 0);
        const gw = 5 + ((Math.random() * 5) | 0);
        gaps.push([gy - (gw >> 1), gy + (gw >> 1)]);
      }
      gaps.sort((a, b) => a[0] - b[0]);
      let cursor = yStart;
      for (const [g0, g1] of gaps) {
        if (cursor < g0) paintLineV(gx, cursor, g0 - 1, types[s], thick);
        cursor = Math.max(cursor, g1 + 1);
      }
      if (cursor <= yEnd) paintLineV(gx, cursor, yEnd, types[s], thick);
    }
  }

  // 1-3 feedstock blobs of solid wall. Placed away from segment edges so
  // they don't accidentally seal off rooms.
  const blobCount = 1 + ((Math.random() * 3) | 0);
  for (let b = 0; b < blobCount; b++) {
    const cx = (12 + Math.random() * (GW - 24)) | 0;
    const cy = (12 + Math.random() * (GH - 24)) | 0;
    const radius = 8 + ((Math.random() * 7) | 0);    // 8..14 cell radius
    paintBlob(cx, cy, radius);
  }

  world._wallsVersion++;

  // Seed particles distributed evenly across the world. Each species gets
  // one founder clade. Skip placement if cell is wall (retry up to 8x).
  const perSpecies = Math.max(0, Math.round(count / NUM_SPECIES));
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

// ─────────────────────────────────────────────────────────────── helpers

// Planet Garden - niche-rich 2D planet prototype. This is the low-risk
// stepping stone before toroidal/globe topology: protected oases, mud costs,
// glass refuges, thick diggable ridges, sparse corridors, quarries, decay
// pockets, and mutagenic cracks inside the existing performant world.
function planet(world, count = PRESET_COUNTS.planet) {
  world.reset();

  const setWall = (gx, gy, type) => {
    if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return;
    const idx = gy * GW + gx;
    if (!world.walls[idx]) world._wallCount++;
    world.walls[idx] = type;
  };
  const clearWall = (gx, gy) => {
    if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return;
    const idx = gy * GW + gx;
    if (world.walls[idx]) world._wallCount = Math.max(0, world._wallCount - 1);
    world.walls[idx] = 0;
  };
  const addField = (gx, gy, food = 0, decay = 0, mutagen = 0) => {
    if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return;
    const idx = gy * GW + gx;
    if (food) world.field[0][idx] = Math.min(6, world.field[0][idx] + food);
    if (decay) {
      world.field[1][idx] = Math.min(10, world.field[1][idx] + decay);
      world._decayActive = true;
    }
    if (mutagen) {
      world.mutagen[idx] = Math.min(4, world.mutagen[idx] + mutagen);
      world._mutagenActive = true;
    }
  };
  const paintDisc = (cx, cy, radius, type, rough = 0.18) => {
    const r = Math.max(1, radius | 0);
    for (let dy = -r - 1; dy <= r + 1; dy++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        const edge = radius * (1 + (Math.random() - 0.5) * rough);
        if (d <= edge) setWall(cx + dx, cy + dy, type);
      }
    }
  };
  const paintRing = (cx, cy, radius, width, type, gapAngle = null, gapWidth = 0) => {
    const outer = radius + width;
    const inner = Math.max(1, radius - width);
    for (let dy = -outer - 1; dy <= outer + 1; dy++) {
      for (let dx = -outer - 1; dx <= outer + 1; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < inner || d > outer) continue;
        if (gapAngle != null && gapWidth > 0) {
          const a = Math.atan2(dy, dx);
          let da = Math.abs(a - gapAngle);
          if (da > Math.PI) da = Math.PI * 2 - da;
          if (da < gapWidth) continue;
        }
        setWall(cx + dx, cy + dy, type);
      }
    }
  };
  const paintArc = (cx, cy, radius, width, type, start, end) => {
    const outer = radius + width;
    const inner = Math.max(1, radius - width);
    for (let dy = -outer - 1; dy <= outer + 1; dy++) {
      for (let dx = -outer - 1; dx <= outer + 1; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < inner || d > outer) continue;
        let a = Math.atan2(dy, dx);
        if (a < 0) a += Math.PI * 2;
        const s = start < 0 ? start + Math.PI * 2 : start;
        const e = end < 0 ? end + Math.PI * 2 : end;
        const inside = s <= e ? (a >= s && a <= e) : (a >= s || a <= e);
        if (inside) setWall(cx + dx, cy + dy, type);
      }
    }
  };
  const stampField = (cx, cy, radius, food, decay = 0, mutagen = 0) => {
    const r = Math.max(1, radius | 0);
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const fall = 1 - d2 / r2;
        addField(cx + dx, cy + dy, food * fall, decay * fall, mutagen * fall);
      }
    }
  };
  const paintLineH = (gy, x0, x1, type, thick, gaps = []) => {
    for (let x = x0; x <= x1; x++) {
      let open = false;
      for (const [g0, g1] of gaps) {
        if (x >= g0 && x <= g1) { open = true; break; }
      }
      if (open) continue;
      for (let dy = 0; dy < thick; dy++) setWall(x, gy + dy, type);
    }
  };
  const paintLineV = (gx, y0, y1, type, thick, gaps = []) => {
    for (let y = y0; y <= y1; y++) {
      let open = false;
      for (const [g0, g1] of gaps) {
        if (y >= g0 && y <= g1) { open = true; break; }
      }
      if (open) continue;
      for (let dx = 0; dx < thick; dx++) setWall(gx + dx, y, type);
    }
  };

  paintLineH((GH * 0.30) | 0, 20, GW - 32, WALL_SOLID, 5, [
    [(GW * 0.20) | 0, (GW * 0.25) | 0],
    [(GW * 0.58) | 0, (GW * 0.64) | 0],
  ]);
  paintLineH((GH * 0.70) | 0, 28, GW - 24, WALL_SOLID, 6, [
    [(GW * 0.36) | 0, (GW * 0.43) | 0],
    [(GW * 0.76) | 0, (GW * 0.82) | 0],
  ]);
  paintLineV((GW * 0.48) | 0, 16, GH - 18, WALL_MEMBRANE, 4, [
    [(GH * 0.18) | 0, (GH * 0.27) | 0],
    [(GH * 0.52) | 0, (GH * 0.60) | 0],
    [(GH * 0.80) | 0, (GH * 0.88) | 0],
  ]);

  const basins = [
    { x: 0.18, y: 0.22, r: 17, food: 3.5, mud: 24, glass: [0.65, 1.75] },
    { x: 0.80, y: 0.27, r: 21, food: 3.0, mud: 29, glass: [3.15, 4.65] },
    { x: 0.30, y: 0.78, r: 20, food: 3.8, mud: 28, glass: [5.10, 0.35] },
    { x: 0.70, y: 0.74, r: 16, food: 2.8, mud: 23, glass: [2.10, 3.05] },
  ];
  for (const b of basins) {
    const cx = (b.x * GW) | 0;
    const cy = (b.y * GH) | 0;
    paintRing(cx, cy, b.mud, 4, WALL_POROUS, Math.random() * Math.PI * 2, 0.28);
    paintArc(cx, cy, b.mud + 7, 3, WALL_MEMBRANE, b.glass[0], b.glass[1]);
    stampField(cx, cy, b.r, b.food, 0.20, 0);
    stampField(cx + ((Math.random() - 0.5) * 12 | 0), cy + ((Math.random() - 0.5) * 12 | 0),
      Math.max(6, b.r - 8), b.food * 0.7, 0, 0);
  }

  for (let i = 0; i < 8; i++) {
    const cx = (24 + Math.random() * (GW - 48)) | 0;
    const cy = (18 + Math.random() * (GH - 36)) | 0;
    stampField(cx, cy, 7 + ((Math.random() * 7) | 0), 0.10, 1.0 + Math.random() * 1.6, 0);
  }
  for (let i = 0; i < 7; i++) {
    const cx = (20 + Math.random() * (GW - 40)) | 0;
    const cy = (18 + Math.random() * (GH - 36)) | 0;
    paintDisc(cx, cy, 7 + ((Math.random() * 9) | 0), WALL_SOLID, 0.35);
  }
  for (let i = 0; i < 5; i++) {
    const cx = (28 + Math.random() * (GW - 56)) | 0;
    const cy = (24 + Math.random() * (GH - 48)) | 0;
    paintArc(cx, cy, 12 + ((Math.random() * 12) | 0), 2 + ((Math.random() * 3) | 0),
      WALL_MEMBRANE, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
  }
  for (let i = 0; i < 9; i++) {
    const cx = (20 + Math.random() * (GW - 40)) | 0;
    const cy = (18 + Math.random() * (GH - 36)) | 0;
    paintDisc(cx, cy, 5 + ((Math.random() * 8) | 0), WALL_POROUS, 0.5);
  }
  for (let i = 0; i < 5; i++) {
    const cx = (30 + Math.random() * (GW - 60)) | 0;
    const cy = (18 + Math.random() * (GH - 36)) | 0;
    stampField(cx, cy, 5 + ((Math.random() * 5) | 0), 0, 0, 1.1 + Math.random() * 1.2);
  }

  for (let i = 0; i < 14; i++) {
    const cx = (12 + Math.random() * (GW - 24)) | 0;
    const cy = (12 + Math.random() * (GH - 24)) | 0;
    const r = 2 + ((Math.random() * 3) | 0);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) clearWall(cx + dx, cy + dy);
      }
    }
  }

  world._wallsVersion++;
  scatterFood(world, 0.22, 0.12);

  const centers = basins.map(b => ({ x: b.x * W, y: b.y * H }));
  centers.push({ x: W * 0.50, y: H * 0.50 });
  centers.push({ x: W * 0.88, y: H * 0.52 });
  const founders = [];
  for (let s = 0; s < NUM_SPECIES; s++) founders.push(world.beginClade(makeGenome(s)));
  for (let i = 0; i < count; i++) {
    const sp = i % NUM_SPECIES;
    const c = centers[(sp + ((i / NUM_SPECIES) | 0)) % centers.length];
    let x = c.x, y = c.y;
    for (let tries = 0; tries < 24; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 20 + Math.random() * 120;
      x = clamp(c.x + Math.cos(a) * r, 8, W - 8);
      y = clamp(c.y + Math.sin(a) * r, 8, H - 8);
      const gx = clamp((x / CELL) | 0, 0, GW - 1);
      const gy = clamp((y / CELL) | 0, 0, GH - 1);
      const wt = world.walls[gy * GW + gx];
      if (wt !== WALL_SOLID && wt !== WALL_MEMBRANE) break;
    }
    world.addParticle(x, y, makeGenome(sp), 4 + Math.random() * 2, founders[sp]);
  }
}

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
