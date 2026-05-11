// snapshot.js - compact render/UI snapshots for worker-owned simulations.

import { NUM_SPECIES, NUM_CHEM } from './genome.js';

export const SNAPSHOT_MAX_BONDS = 4;
export const PARTICLE_STRIDE = 22;
export const PARTICLE_GENOME_STRIDE = 13;

function genomeView(g, detail = true) {
  if (!g) return null;
  return {
    species: g.species || 0,
    attraction: detail ? Array.from(g.attraction || []) : [],
    emit: detail ? Array.from(g.emit || []) : [],
    sense: detail ? Array.from(g.sense || []) : [],
    prey_preference: detail && g.prey_preference ? Array.from(g.prey_preference) : null,
    cohesion: g.cohesion || 0,
    metab: g.metab || 0,
    efficiency: g.efficiency || 0,
    repro_thresh: g.repro_thresh || 0,
    mut_rate: g.mut_rate || 0,
    sense_radius: g.sense_radius || 0,
    cluster_affinity: g.cluster_affinity ?? 0,
    kin_aversion: g.kin_aversion ?? 0.5,
    wall_affinity: g.wall_affinity ?? 0,
    prey_walling: g.prey_walling ?? 0,
    brainSlots: g.brain && typeof g.brain.enabledCount === 'function'
      ? g.brain.enabledCount()
      : 0,
    digBias: g.brain && g.brain.biasO ? (g.brain.biasO[16] || 0) : 0,
  };
}

function meanGenomeView(m) {
  if (!m) {
    return {
      attraction: new Array(NUM_SPECIES).fill(0),
      emit: new Array(NUM_CHEM).fill(0),
      sense: new Array(NUM_CHEM).fill(0),
      cohesion: 0,
      metab: 0,
      efficiency: 0,
      repro_thresh: 0,
      mut_rate: 0,
      sense_radius: 0,
    };
  }
  return {
    attraction: Array.from(m.attraction || []),
    emit: Array.from(m.emit || []),
    sense: Array.from(m.sense || []),
    cohesion: m.cohesion || 0,
    metab: m.metab || 0,
    efficiency: m.efficiency || 0,
    repro_thresh: m.repro_thresh || 0,
    mut_rate: m.mut_rate || 0,
    sense_radius: m.sense_radius || 0,
  };
}

function cloneEvents(events, max = 80) {
  return (events || []).slice(0, max).map(e => ({ ...e }));
}

function cloneFossils(fossils, max = 12) {
  return (fossils || []).slice(0, max).map(f => ({
    tick: f.tick || 0,
    age: f.age || 0,
    energy: f.energy || 0,
    species: f.species || 0,
    cladeId: f.cladeId || 0,
    genome: genomeView(f.genome),
  }));
}

function sparseWallMeta(world) {
  const rows = [];
  for (let i = 0; i < world.walls.length; i++) {
    if (!world.walls[i]) continue;
    const ownerId = world.wallOwnerId[i] || 0;
    const tick = world.wallOwnerTick[i] || 0;
    if (!ownerId && !tick) continue;
    rows.push([
      i,
      ownerId,
      world.wallOwnerClusterId[i] || 0,
      world.wallOwnerCladeId[i] || 0,
      tick,
    ]);
  }
  return rows;
}

function particleObjectView(p) {
  return {
    id: p.id,
    x: p.x || 0,
    y: p.y || 0,
    vx: p.vx || 0,
    vy: p.vy || 0,
    energy: p.energy || 0,
    age: p.age || 0,
    lineage: p.lineage || 0,
    species: p.species ?? p.genome?.species ?? 0,
    cladeId: p.cladeId || 0,
    bonds: Array.from(p.bonds || []),
    wallCarry: p.wallCarry || 0,
    wallDigs: p.wallDigs || 0,
    wallDeposits: p.wallDeposits || 0,
    predationGain: p.predationGain || 0,
    signalR: p.signalR || 0,
    signalG: p.signalG || 0,
    signalB: p.signalB || 0,
    signalFlash: p.signalFlash || 0,
    soundCh: p.soundCh || 0,
    soundAmp: p.soundAmp || 0,
    bondMsgR: p.bondMsgR || 0.5,
    bondMsgG: p.bondMsgG || 0.5,
    bondMsgB: p.bondMsgB || 0.5,
    genome: genomeView(p.genome, false),
  };
}

function buildParticleSlab(particles, addTransfer) {
  const n = particles.length;
  const ids = addTransfer(new Uint32Array(n));
  const data = addTransfer(new Float32Array(n * PARTICLE_STRIDE));
  const bonds = addTransfer(new Int32Array(n * SNAPSHOT_MAX_BONDS));
  const genomes = addTransfer(new Float32Array(n * PARTICLE_GENOME_STRIDE));
  for (let i = 0; i < n; i++) {
    const p = particles[i];
    const o = i * PARTICLE_STRIDE;
    ids[i] = p.id >>> 0;
    data[o + 0] = p.x || 0;
    data[o + 1] = p.y || 0;
    data[o + 2] = p.vx || 0;
    data[o + 3] = p.vy || 0;
    data[o + 4] = p.energy || 0;
    data[o + 5] = p.age || 0;
    data[o + 6] = p.lineage || 0;
    data[o + 7] = p.species ?? p.genome?.species ?? 0;
    data[o + 8] = p.cladeId || 0;
    data[o + 9] = p.wallCarry || 0;
    data[o + 10] = p.wallDigs || 0;
    data[o + 11] = p.wallDeposits || 0;
    data[o + 12] = p.predationGain || 0;
    data[o + 13] = p.signalR || 0;
    data[o + 14] = p.signalG || 0;
    data[o + 15] = p.signalB || 0;
    data[o + 16] = p.signalFlash || 0;
    data[o + 17] = p.soundCh || 0;
    data[o + 18] = p.soundAmp || 0;
    data[o + 19] = p.bondMsgR || 0.5;
    data[o + 20] = p.bondMsgG || 0.5;
    data[o + 21] = p.bondMsgB || 0.5;
    const bondList = p.bonds || [];
    const bo = i * SNAPSHOT_MAX_BONDS;
    for (let b = 0; b < Math.min(SNAPSHOT_MAX_BONDS, bondList.length); b++) {
      bonds[bo + b] = bondList[b] | 0;
    }

    const g = p.genome || {};
    const go = i * PARTICLE_GENOME_STRIDE;
    genomes[go + 0] = g.species || 0;
    genomes[go + 1] = g.cohesion || 0;
    genomes[go + 2] = g.metab || 0;
    genomes[go + 3] = g.efficiency || 0;
    genomes[go + 4] = g.repro_thresh || 0;
    genomes[go + 5] = g.mut_rate || 0;
    genomes[go + 6] = g.sense_radius || 0;
    genomes[go + 7] = g.cluster_affinity ?? 0;
    genomes[go + 8] = g.kin_aversion ?? 0.5;
    genomes[go + 9] = g.wall_affinity ?? 0;
    genomes[go + 10] = g.prey_walling ?? 0;
    genomes[go + 11] = g.brain && typeof g.brain.enabledCount === 'function'
      ? g.brain.enabledCount()
      : 0;
    genomes[go + 12] = g.brain && g.brain.biasO ? (g.brain.biasO[16] || 0) : 0;
  }
  return {
    count: n,
    stride: PARTICLE_STRIDE,
    genomeStride: PARTICLE_GENOME_STRIDE,
    maxBonds: SNAPSHOT_MAX_BONDS,
    ids,
    data,
    bonds,
    genomes,
  };
}

export function buildWorldSnapshot(world, opts = {}) {
  const includeFields = opts.includeFields !== false;
  const includeWalls = opts.includeWalls !== false;
  const includeWallMeta = opts.includeWallMeta !== false && includeWalls;
  if (typeof world.updateClusters === 'function') world.updateClusters();
  const transfer = [];
  let transferBytes = 0;
  const addTransfer = (array) => {
    if (!array) return array;
    transfer.push(array.buffer);
    transferBytes += array.byteLength || 0;
    return array;
  };
  const useParticleSlab = opts.particleFormat === 'slab';
  const particlePayload = useParticleSlab
    ? buildParticleSlab(world.particles, addTransfer)
    : world.particles.map(particleObjectView);

  const clusters = (world._clusters || []).map(c => ({
    anchorId: c.anchorId || 0,
    name: c.name || '',
    count: c.count || (c.members ? c.members.length : 0),
    cx: c.cx || 0,
    cy: c.cy || 0,
    radius: c.radius || 0,
    spread: c.spread || 0,
    species: c.species || 0,
    topologyScore: c.topologyScore || 0,
    members: (c.members || []).map(p => p.id),
  }));

  const tracker = world.clades;
  const topClades = tracker && typeof tracker.topClades === 'function'
    ? tracker.topClades(32).map(c => ({
      id: c.id,
      parentId: c.parentId,
      name: c.name || '',
      species: c.species || 0,
      foundedTick: c.foundedTick || 0,
      aliveCount: c.aliveCount || 0,
      peakCount: c.peakCount || 0,
      lastSeenTick: c.lastSeenTick || 0,
      totalEverBorn: c.totalEverBorn || 0,
      popHistory: Array.from(c.popHistory || []),
      founderGenome: genomeView(c.founderGenome, true),
      meanGenome: genomeView(c.meanGenome, true),
      tags: tracker.classifyClade ? tracker.classifyClade(c) : [],
    }))
    : [];

  const attraction = tracker && typeof tracker.attractionMatrix === 'function'
    ? tracker.attractionMatrix(world)
    : { matrix: new Array(NUM_SPECIES).fill(0).map(() => new Array(NUM_SPECIES).fill(0)), counts: new Array(NUM_SPECIES).fill(0) };

  const field0 = includeFields ? addTransfer(Float32Array.from(world.field[0])) : null;
  const field1 = includeFields ? addTransfer(Float32Array.from(world.field[1])) : null;
  const mutagen = includeFields ? addTransfer(Float32Array.from(world.mutagen)) : null;
  const walls = includeWalls ? addTransfer(Uint8Array.from(world.walls)) : null;

  const snapshot = {
    kind: 'primordia.world-snapshot.v1',
    tick: world.tick || 0,
    maxParticles: world.maxParticles || 0,
    ...(useParticleSlab ? { particleSlab: particlePayload } : { particles: particlePayload }),
    clusters,
    ...(includeFields ? { field0, field1, mutagen } : {}),
    ...(includeWalls ? {
      walls,
      wallMeta: includeWallMeta ? sparseWallMeta(world) : [],
      habitatRegions: (world.habitatRegions || []).map(r => ({ ...r })),
    } : {}),
    _wallCount: world._wallCount || 0,
    _wallsVersion: world._wallsVersion || 0,
    _attackFlashEvents: cloneEvents(world._attackFlashEvents, 64),
    _wallSoundEvents: cloneEvents(world._wallSoundEvents, 48),
    _deathSoundEvents: cloneEvents(world._deathSoundEvents, 48),
    totals: {
      totalBorn: world.totalBorn || 0,
      totalDied: world.totalDied || 0,
      totalWallDigs: world.totalWallDigs || 0,
      totalWallDeposits: world.totalWallDeposits || 0,
      totalPredationEvents: world.totalPredationEvents || 0,
      totalClusterBuds: world.totalClusterBuds || 0,
      totalClusterBudParticles: world.totalClusterBudParticles || 0,
      totalClusterCellBirths: world.totalClusterCellBirths || 0,
    },
    counts: world.populationBySpecies ? world.populationBySpecies() : [],
    vitals: world.vitals ? world.vitals() : null,
    meanGenome: meanGenomeView(world.meanGenome ? world.meanGenome() : null),
    profile: world.profileSnapshot ? world.profileSnapshot({ reset: !!opts.resetProfile }) : null,
    clades: {
      topClades,
      events: cloneEvents(tracker?.events, 80),
      fossils: cloneFossils(tracker?.fossils, 12),
      activeEpochs: tracker?.activeEpochs
        ? tracker.activeEpochs().map(e => ({
          name: e.name,
          description: e.description,
          startedAt: e.startedAt || 0,
          sustained: e.sustained || 0,
          active: !!e.active,
        }))
        : [],
      epochsStarted: tracker?.epochsStarted || 0,
      complexity: tracker?.complexity ? tracker.complexity(world) : null,
      attractionMatrix: {
        matrix: attraction.matrix.map(row => Array.from(row)),
        counts: Array.from(attraction.counts || []),
      },
    },
    worker: {
      snapshotAt: Date.now(),
      layers: {
        particles: useParticleSlab ? 'slab' : 'objects',
        fields: includeFields,
        walls: includeWalls,
        wallMeta: includeWallMeta,
      },
      transferBytes,
    },
  };
  return { snapshot, transfer };
}
