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

function normaliseRegions(world) {
  const src = Array.isArray(world?.habitatRegions) ? world.habitatRegions : [];
  return src.map(normaliseRegion);
}

export function assignRegionId(world, particle, regions = normaliseRegions(world), opts = {}) {
  if (!particle || particle.dead) return null;
  for (let ri = 0; ri < regions.length; ri++) {
    const r = regions[ri];
    const dx = particle.x - r.x;
    const dy = particle.y - r.y;
    if (dx * dx + dy * dy <= r.radius * r.radius) return r.id;
  }
  return opts.includeOutside ? 'outside' : null;
}

function particleSpecies(p) {
  return clamp((p?.species ?? p?.genome?.species ?? 0) | 0, 0, NUM_SPECIES - 1);
}

function particleLineageKey(p, mode = 'clade') {
  if (mode === 'species') return `species:${particleSpecies(p)}`;
  if (mode === 'organism') {
    const root = p?.organismRootId || p?.id || 0;
    const generation = Math.max(1, p?.organismGeneration || 1);
    return `organism:${root}:${generation}`;
  }
  const cladeId = p?.cladeId | 0;
  return cladeId > 0 ? `clade:${cladeId}` : `species:${particleSpecies(p)}`;
}

function lineageLabel(world, key) {
  const parts = String(key || '').split(':');
  if (parts[0] === 'clade') {
    const id = Number(parts[1]) || 0;
    const clade = world?.clades?.clades?.get(id);
    return clade?.name || `clade #${id}`;
  }
  if (parts[0] === 'organism') {
    const gen = Math.max(1, Number(parts[2]) || 1);
    return gen > 1 ? `organism ${parts[1]} gen ${gen}` : `organism ${parts[1]}`;
  }
  if (parts[0] === 'species') {
    const sp = clamp(Number(parts[1]) || 0, 0, NUM_SPECIES - 1);
    return SPECIES_NAMES[sp] || `species ${sp}`;
  }
  return String(key || 'unknown');
}

function increment(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
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
  if (!world) return [];
  const regions = normaliseRegions(world);
  if (!regions.length) return [];
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
    const regionId = assignRegionId(world, p, regions, { includeOutside: false });
    const assigned = regionId == null ? -1 : regions.findIndex(r => r.id === regionId);
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
    m.speciesCounts[particleSpecies(p)]++;
    if (assigned >= 0) energySums[assigned] += p.energy || 0;
    else outsideEnergy += p.energy || 0;
  }

  const out = metrics.map((m, i) => finishMetric(m, energySums[i]));
  if (outside) out.push(finishMetric(outside, outsideEnergy));
  return out;
}

export function computeRegionTransitions(world, previous = new Map(), opts = {}) {
  const regions = normaliseRegions(world);
  if (!world || !regions.length) {
    return { current: new Map(), summary: null };
  }
  const includeOutside = opts.includeOutside !== false;
  const current = new Map();
  const liveIds = new Set();
  const transitions = new Map();
  const exits = new Map();
  let stayed = 0, moved = 0, entered = 0, exited = 0;

  for (const p of world.particles || []) {
    if (!p || p.dead) continue;
    const id = p.id;
    liveIds.add(id);
    const next = assignRegionId(world, p, regions, { includeOutside });
    if (next == null) continue;
    current.set(id, next);
    if (!previous.has(id)) {
      entered++;
      continue;
    }
    const prev = previous.get(id);
    if (prev === next) {
      stayed++;
    } else {
      moved++;
      const key = `${prev}->${next}`;
      transitions.set(key, (transitions.get(key) || 0) + 1);
    }
  }

  for (const [id, prev] of previous) {
    if (liveIds.has(id)) continue;
    exited++;
    exits.set(prev, (exits.get(prev) || 0) + 1);
  }

  const rows = [...transitions.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('->');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const exitRows = [...exits.entries()]
    .map(([from, count]) => ({ from, count }))
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));

  return {
    current,
    summary: {
      stayed,
      moved,
      entered,
      exited,
      transitions: rows,
      exits: exitRows,
    },
  };
}

function collectRegionLineages(world, opts = {}) {
  const regions = normaliseRegions(world);
  if (!world || !regions.length) return { current: new Map(), info: new Map() };
  const includeOutside = opts.includeOutside !== false;
  const mode = opts.lineageMode || 'clade';
  const current = new Map();
  const info = new Map();

  for (const r of regions) {
    current.set(r.id, new Map());
    info.set(r.id, { id: r.id, name: r.name, type: r.type });
  }
  if (includeOutside) {
    current.set('outside', new Map());
    info.set('outside', { id: 'outside', name: 'outside', type: 'outside' });
  }

  for (const p of world.particles || []) {
    if (!p || p.dead) continue;
    const regionId = assignRegionId(world, p, regions, { includeOutside });
    if (regionId == null) continue;
    const counts = current.get(regionId) || new Map();
    current.set(regionId, counts);
    increment(counts, particleLineageKey(p, mode));
  }
  return { current, info };
}

function sumCounts(counts) {
  let total = 0;
  for (const c of counts.values()) total += c;
  return total;
}

function lineageChangeRow(world, key, delta, current, previous) {
  return {
    lineageId: key,
    name: lineageLabel(world, key),
    delta,
    current,
    previous,
  };
}

export function computeRegionLineageTurnover(world, previous = new Map(), opts = {}) {
  const { current, info } = collectRegionLineages(world, opts);
  if (!world || current.size === 0) {
    return { current: new Map(), summary: null };
  }
  const prevState = previous instanceof Map ? previous : new Map();
  const ids = new Set([...info.keys(), ...prevState.keys(), ...current.keys()]);
  const regions = [];
  let totalColonizations = 0;
  let totalExtinctions = 0;
  let turnoverSum = 0;
  let turnoverN = 0;

  for (const id of ids) {
    const curr = current.get(id) || new Map();
    const prev = prevState.get(id) || new Map();
    const keys = new Set([...curr.keys(), ...prev.keys()]);
    const currentTotal = sumCounts(curr);
    const previousTotal = sumCounts(prev);
    let retainedLineages = 0;
    let colonizations = 0;
    let localExtinctions = 0;
    let deltaAbs = 0;
    let dominantKey = null;
    let dominantCount = 0;
    const changes = [];

    for (const key of keys) {
      const c = curr.get(key) || 0;
      const p = prev.get(key) || 0;
      if (c > 0 && p > 0) retainedLineages++;
      else if (c > 0) colonizations++;
      else if (p > 0) localExtinctions++;
      const delta = c - p;
      if (delta !== 0) changes.push(lineageChangeRow(world, key, delta, c, p));
      deltaAbs += Math.abs(delta);
      if (c > dominantCount) {
        dominantCount = c;
        dominantKey = key;
      }
    }

    const denom = currentTotal + previousTotal;
    const turnover = denom > 0 ? round(deltaAbs / denom, 3) : 0;
    if (denom > 0) {
      turnoverSum += turnover;
      turnoverN++;
    }
    totalColonizations += colonizations;
    totalExtinctions += localExtinctions;
    changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
    const meta = info.get(id) || { id, name: id, type: 'region' };

    regions.push({
      id,
      name: meta.name,
      type: meta.type,
      currentParticles: currentTotal,
      previousParticles: previousTotal,
      lineagesPresent: curr.size,
      retainedLineages,
      colonizations,
      localExtinctions,
      turnover,
      dominantLineageId: dominantKey,
      dominantLineage: dominantKey ? lineageLabel(world, dominantKey) : null,
      dominantShare: currentTotal ? round(dominantCount / currentTotal, 3) : 0,
      topGainers: changes.filter(row => row.delta > 0).slice(0, 3),
      topDecliners: changes.filter(row => row.delta < 0).slice(0, 3),
    });
  }

  regions.sort((a, b) => b.currentParticles - a.currentParticles || a.id.localeCompare(b.id));
  return {
    current,
    summary: {
      lineageMode: opts.lineageMode || 'clade',
      regions,
      colonizations: totalColonizations,
      localExtinctions: totalExtinctions,
      meanTurnover: turnoverN ? round(turnoverSum / turnoverN, 3) : 0,
      highTurnoverRegions: regions
        .filter(r => r.turnover >= 0.35 && (r.currentParticles + r.previousParticles) >= 8)
        .sort((a, b) => b.turnover - a.turnover || b.currentParticles - a.currentParticles)
        .map(r => ({ id: r.id, name: r.name, turnover: r.turnover }))
        .slice(0, 5),
    },
  };
}

function regionInfoForSurvival(world, includeOutside) {
  const regions = normaliseRegions(world);
  const info = new Map();
  for (const r of regions) info.set(r.id, { id: r.id, name: r.name, type: r.type });
  if (includeOutside) info.set('outside', { id: 'outside', name: 'outside', type: 'outside' });
  return { regions, info };
}

function particleSurvivalRecord(world, p, regions, includeOutside, lineageMode) {
  const regionId = assignRegionId(world, p, regions, { includeOutside });
  if (regionId == null) return null;
  return {
    regionId,
    energy: Number(p.energy) || 0,
    lineageId: particleLineageKey(p, lineageMode),
  };
}

export function computeRegionSurvival(world, previous = new Map(), opts = {}) {
  if (!world) return { current: new Map(), summary: null };
  const includeOutside = opts.includeOutside !== false;
  const lineageMode = opts.lineageMode || 'clade';
  const { regions, info } = regionInfoForSurvival(world, includeOutside);
  if (!regions.length) return { current: new Map(), summary: null };

  const current = new Map();
  for (const p of world.particles || []) {
    if (!p || p.dead) continue;
    const rec = particleSurvivalRecord(world, p, regions, includeOutside, lineageMode);
    if (rec) current.set(p.id, rec);
  }

  const prevState = previous instanceof Map ? previous : new Map();
  if (!prevState.size) return { current, summary: null };

  const rows = new Map();
  const ensure = (id) => {
    if (!rows.has(id)) {
      const meta = info.get(id) || { id, name: id, type: 'region' };
      rows.set(id, {
        id,
        name: meta.name,
        type: meta.type,
        startParticles: 0,
        survived: 0,
        died: 0,
        stayed: 0,
        movedOut: 0,
        newParticles: 0,
        energyDeltaSum: 0,
        destinations: new Map(),
      });
    }
    return rows.get(id);
  };
  for (const id of info.keys()) ensure(id);

  let startParticles = 0;
  let survived = 0;
  let died = 0;
  let movedOut = 0;
  let newParticles = 0;

  for (const [id, prev] of prevState) {
    const row = ensure(prev.regionId);
    row.startParticles++;
    startParticles++;
    const cur = current.get(id);
    if (!cur) {
      row.died++;
      died++;
      continue;
    }
    row.survived++;
    survived++;
    row.energyDeltaSum += cur.energy - (prev.energy || 0);
    if (cur.regionId === prev.regionId) {
      row.stayed++;
    } else {
      row.movedOut++;
      movedOut++;
      increment(row.destinations, cur.regionId);
    }
  }

  for (const [id, cur] of current) {
    if (prevState.has(id)) continue;
    ensure(cur.regionId).newParticles++;
    newParticles++;
  }

  const regionsOut = [...rows.values()].map(row => {
    const destinations = [...row.destinations.entries()]
      .map(([to, count]) => ({ to, count }))
      .sort((a, b) => b.count - a.count || a.to.localeCompare(b.to))
      .slice(0, 5);
    const survivalRate = row.startParticles ? row.survived / row.startParticles : 0;
    const deathRate = row.startParticles ? row.died / row.startParticles : 0;
    const moveOutRate = row.startParticles ? row.movedOut / row.startParticles : 0;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      startParticles: row.startParticles,
      survived: row.survived,
      died: row.died,
      stayed: row.stayed,
      movedOut: row.movedOut,
      newParticles: row.newParticles,
      survivalRate: round(survivalRate, 3),
      deathRate: round(deathRate, 3),
      moveOutRate: round(moveOutRate, 3),
      meanEnergyDelta: row.survived ? round(row.energyDeltaSum / row.survived, 3) : 0,
      destinations,
    };
  }).sort((a, b) => b.startParticles - a.startParticles || a.id.localeCompare(b.id));

  return {
    current,
    summary: {
      regions: regionsOut,
      startParticles,
      survived,
      died,
      movedOut,
      newParticles,
      survivalRate: startParticles ? round(survived / startParticles, 3) : 0,
      deathRate: startParticles ? round(died / startParticles, 3) : 0,
      moveOutRate: startParticles ? round(movedOut / startParticles, 3) : 0,
      highDeathRegions: regionsOut
        .filter(r => r.startParticles >= 8 && r.deathRate >= 0.08)
        .sort((a, b) => b.deathRate - a.deathRate || b.startParticles - a.startParticles)
        .map(r => ({ id: r.id, name: r.name, deathRate: r.deathRate, died: r.died }))
        .slice(0, 5),
      highEscapeRegions: regionsOut
        .filter(r => r.startParticles >= 8 && r.moveOutRate >= 0.25)
        .sort((a, b) => b.moveOutRate - a.moveOutRate || b.startParticles - a.startParticles)
        .map(r => ({ id: r.id, name: r.name, moveOutRate: r.moveOutRate, movedOut: r.movedOut }))
        .slice(0, 5),
    },
  };
}
