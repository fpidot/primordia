// region_metrics.js - bench/UI helpers for habitat niche telemetry.

import { GW, GH, CELL, WALL_SOLID, WALL_MEMBRANE, WALL_POROUS } from './sim.js';
import { NUM_SPECIES, SPECIES_NAMES } from './genome.js';

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round(v, digits = 3) {
  const m = 10 ** digits;
  return Math.round((Number.isFinite(v) ? v : 0) * m) / m;
}

function entropy(counts) {
  let n = 0;
  for (const c of counts) n += c;
  if (n <= 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / n;
    h -= p * Math.log(p);
  }
  return round(h / Math.log(Math.max(2, counts.length)), 3);
}

function normaliseRegion(region, idx) {
  const x = Number.isFinite(region.x) ? region.x
    : Number.isFinite(region.gx) ? (region.gx + 0.5) * CELL
      : GW * CELL * 0.5;
  const y = Number.isFinite(region.y) ? region.y
    : Number.isFinite(region.gy) ? (region.gy + 0.5) * CELL
      : GH * CELL * 0.5;
  const radius = Number.isFinite(region.radius) ? region.radius
    : Number.isFinite(region.radiusCells) ? region.radiusCells * CELL
      : 20 * CELL;
  return {
    id: region.id || `region-${idx + 1}`,
    name: region.name || `region ${idx + 1}`,
    type: region.type || 'region',
    x,
    y,
    gx: Number.isFinite(region.gx) ? region.gx : Math.floor(x / CELL),
    gy: Number.isFinite(region.gy) ? region.gy : Math.floor(y / CELL),
    radius,
    radiusCells: Number.isFinite(region.radiusCells) ? region.radiusCells : radius / CELL,
  };
}

function emptyMetric(region) {
  return {
    id: region.id,
    name: region.name,
    type: region.type,
    gx: region.gx | 0,
    gy: region.gy | 0,
    radiusCells: round(region.radiusCells, 1),
    particles: 0,
    meanEnergy: 0,
    lowEnergy: 0,
    wallCarriers: 0,
    mudOccupants: 0,
    glassBlockedOccupants: 0,
    speciesPresent: 0,
    speciesEntropy: 0,
    dominantSpecies: null,
    dominantShare: 0,
    speciesCounts: new Array(NUM_SPECIES).fill(0),
    cells: 0,
    solidCells: 0,
    glassCells: 0,
    mudCells: 0,
    foodMass: 0,
    richFoodCells: 0,
    decayMass: 0,
    decayCells: 0,
    mutagenMass: 0,
    mutagenCells: 0,
  };
}

function finishMetric(m, energySum) {
  m.meanEnergy = m.particles ? round(energySum / m.particles, 3) : 0;
  m.speciesPresent = m.speciesCounts.reduce((n, c) => n + (c > 0 ? 1 : 0), 0);
  m.speciesEntropy = entropy(m.speciesCounts);
  let best = 0;
  for (let i = 1; i < m.speciesCounts.length; i++) {
    if (m.speciesCounts[i] > m.speciesCounts[best]) best = i;
  }
  if (m.speciesCounts[best] > 0) {
    m.dominantSpecies = SPECIES_NAMES[best] || String(best);
    m.dominantShare = round(m.speciesCounts[best] / Math.max(1, m.particles), 3);
  }
  m.foodMass = round(m.foodMass, 3);
  m.decayMass = round(m.decayMass, 3);
  m.mutagenMass = round(m.mutagenMass, 3);
  return m;
}

export function computeRegionMetrics(world, opts = {}) {
  const src = Array.isArray(world?.habitatRegions) ? world.habitatRegions : [];
  if (!world || src.length === 0) return [];
  const regions = src.map(normaliseRegion);
  const metrics = regions.map(emptyMetric);
  const energySums = new Array(metrics.length).fill(0);
  const includeOutside = !!opts.includeOutside;
  const outside = includeOutside
    ? emptyMetric({ id: 'outside', name: 'outside', type: 'outside', gx: -1, gy: -1, radiusCells: 0 })
    : null;
  let outsideEnergy = 0;

  for (let ri = 0; ri < regions.length; ri++) {
    const r = regions[ri];
    const m = metrics[ri];
    const cr = Math.max(1, Math.ceil(r.radius / CELL));
    const cx = clamp(Math.floor(r.x / CELL), 0, GW - 1);
    const cy = clamp(Math.floor(r.y / CELL), 0, GH - 1);
    const r2 = r.radius * r.radius;
    const gx0 = clamp(cx - cr, 0, GW - 1);
    const gx1 = clamp(cx + cr, 0, GW - 1);
    const gy0 = clamp(cy - cr, 0, GH - 1);
    const gy1 = clamp(cy + cr, 0, GH - 1);
    for (let gy = gy0; gy <= gy1; gy++) {
      const wy = (gy + 0.5) * CELL;
      for (let gx = gx0; gx <= gx1; gx++) {
        const wx = (gx + 0.5) * CELL;
        const dx = wx - r.x;
        const dy = wy - r.y;
        if (dx * dx + dy * dy > r2) continue;
        const idx = gy * GW + gx;
        const wt = world.walls[idx];
        m.cells++;
        if (wt === WALL_SOLID) m.solidCells++;
        else if (wt === WALL_MEMBRANE) m.glassCells++;
        else if (wt === WALL_POROUS) m.mudCells++;
        const food = world.field[0][idx] || 0;
        const decay = world.field[1][idx] || 0;
        const mutagen = world.mutagen[idx] || 0;
        m.foodMass += food;
        m.decayMass += decay;
        m.mutagenMass += mutagen;
        if (food > 1.0) m.richFoodCells++;
        if (decay > 0.2) m.decayCells++;
        if (mutagen > 0.2) m.mutagenCells++;
      }
    }
  }

  for (const p of world.particles || []) {
    if (!p || p.dead) continue;
    let assigned = -1;
    for (let ri = 0; ri < regions.length; ri++) {
      const r = regions[ri];
      const dx = p.x - r.x;
      const dy = p.y - r.y;
      if (dx * dx + dy * dy <= r.radius * r.radius) {
        assigned = ri;
        break;
      }
    }
    const m = assigned >= 0 ? metrics[assigned] : outside;
    if (!m) continue;
    const gx = clamp((p.x / CELL) | 0, 0, GW - 1);
    const gy = clamp((p.y / CELL) | 0, 0, GH - 1);
    const wt = world.walls[gy * GW + gx];
    m.particles++;
    if ((p.energy || 0) < 1) m.lowEnergy++;
    if ((p.wallCarry || 0) > 0) m.wallCarriers++;
    if (wt === WALL_POROUS) m.mudOccupants++;
    else if (wt === WALL_MEMBRANE) m.glassBlockedOccupants++;
    const sp = clamp((p.species ?? p.genome?.species ?? 0) | 0, 0, NUM_SPECIES - 1);
    m.speciesCounts[sp]++;
    if (assigned >= 0) energySums[assigned] += p.energy || 0;
    else outsideEnergy += p.energy || 0;
  }

  const out = metrics.map((m, i) => finishMetric(m, energySums[i]));
  if (outside) out.push(finishMetric(outside, outsideEnergy));
  return out;
}
