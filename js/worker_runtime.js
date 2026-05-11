// worker_runtime.js - main-thread proxy for worker-owned World snapshots.

import { W, H, GW, GH, CELL } from './sim.js';
import { NUM_SPECIES, NUM_CHEM } from './genome.js';
import { PARTICLE_GENOME_STRIDE, PARTICLE_STRIDE, SNAPSHOT_MAX_BONDS } from './snapshot.js';

function emptyVitals() {
  return {
    alive: 0,
    meanEnergy: 0,
    meanSpeed: 0,
    meanSpeedCapFrac: 0,
    meanMotorEffort: 0,
    highSpeedFrac: 0,
    eMin: 0,
    eMax: 0,
    lowFrac: 0,
    meanFood: 0,
    meanDecay: 0,
    walls: 0,
    wallCarriers: 0,
    wallDigs: 0,
    wallDeposits: 0,
    meanShelter: 0,
    shelteredFrac: 0,
    fieldEnergyGain: 0,
    predationEnergyGain: 0,
    predationEvents: 0,
    predationDeaths: 0,
    clusterBuds: 0,
    clusterBudParticles: 0,
    clusterCellBirths: 0,
    clusterBudReserve: 0,
    descendantClusters: 0,
    descendantParticles: 0,
    maxOrganismGeneration: 1,
    lastClusterBud: null,
  };
}

function emptyMeanGenome() {
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

function inflateGenome(src = {}) {
  const biasO = [];
  biasO[16] = src.digBias || 0;
  return {
    species: src.species || 0,
    attraction: src.attraction || new Array(NUM_SPECIES).fill(0),
    emit: src.emit || new Array(NUM_CHEM).fill(0),
    sense: src.sense || new Array(NUM_CHEM).fill(0),
    prey_preference: src.prey_preference || null,
    cohesion: src.cohesion || 0,
    metab: src.metab || 0,
    efficiency: src.efficiency || 0,
    repro_thresh: src.repro_thresh || 0,
    mut_rate: src.mut_rate || 0,
    sense_radius: src.sense_radius || 0,
    cluster_affinity: src.cluster_affinity ?? 0,
    kin_aversion: src.kin_aversion ?? 0.5,
    wall_affinity: src.wall_affinity ?? 0,
    prey_walling: src.prey_walling ?? 0,
    brain: {
      biasO,
      enabledCount: () => src.brainSlots || 0,
    },
  };
}

function particleRowsFromSlab(slab) {
  if (!slab || !slab.ids || !slab.data) return [];
  const ids = slab.ids;
  const data = slab.data;
  const bonds = slab.bonds;
  const genomes = slab.genomes;
  const count = Math.min(slab.count || ids.length || 0, ids.length || 0);
  const stride = slab.stride || PARTICLE_STRIDE;
  const genomeStride = slab.genomeStride || PARTICLE_GENOME_STRIDE;
  const maxBonds = slab.maxBonds || SNAPSHOT_MAX_BONDS;
  const rows = new Array(count);
  const gv = (offset, fallback = 0) => (genomes && Number.isFinite(genomes[offset]) ? genomes[offset] : fallback);
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const go = i * genomeStride;
    const species = data[o + 7] | 0;
    const bondList = [];
    if (bonds) {
      const bo = i * maxBonds;
      for (let b = 0; b < maxBonds; b++) {
        const id = bonds[bo + b] | 0;
        if (id > 0) bondList.push(id);
      }
    }
    rows[i] = {
      id: ids[i] | 0,
      x: data[o + 0] || 0,
      y: data[o + 1] || 0,
      vx: data[o + 2] || 0,
      vy: data[o + 3] || 0,
      energy: data[o + 4] || 0,
      age: data[o + 5] || 0,
      lineage: data[o + 6] || 0,
      species,
      cladeId: data[o + 8] || 0,
      bonds: bondList,
      wallCarry: data[o + 9] || 0,
      wallDigs: data[o + 10] || 0,
      wallDeposits: data[o + 11] || 0,
      predationGain: data[o + 12] || 0,
      signalR: data[o + 13] || 0,
      signalG: data[o + 14] || 0,
      signalB: data[o + 15] || 0,
      signalFlash: data[o + 16] || 0,
      soundCh: data[o + 17] || 0,
      soundAmp: data[o + 18] || 0,
      bondMsgR: data[o + 19] || 0.5,
      bondMsgG: data[o + 20] || 0.5,
      bondMsgB: data[o + 21] || 0.5,
      genome: {
        species: genomes ? (gv(go + 0, species) | 0) : species,
        cohesion: gv(go + 1),
        metab: gv(go + 2),
        efficiency: gv(go + 3),
        repro_thresh: gv(go + 4),
        mut_rate: gv(go + 5),
        sense_radius: gv(go + 6),
        cluster_affinity: gv(go + 7),
        kin_aversion: gv(go + 8, 0.5),
        wall_affinity: gv(go + 9),
        prey_walling: gv(go + 10),
        brainSlots: gv(go + 11),
        digBias: gv(go + 12),
      },
    };
  }
  return rows;
}

class SnapshotClades {
  constructor() {
    this.clades = new Map();
    this.events = [];
    this.fossils = [];
    this.epochsStarted = 0;
    this._activeEpochs = [];
    this._complexity = null;
    this._attractionMatrix = {
      matrix: new Array(NUM_SPECIES).fill(0).map(() => new Array(NUM_SPECIES).fill(0)),
      counts: new Array(NUM_SPECIES).fill(0),
    };
  }

  apply(data = {}) {
    this.clades.clear();
    for (const c of data.topClades || []) {
      const clade = {
        ...c,
        founderGenome: inflateGenome(c.founderGenome),
        meanGenome: inflateGenome(c.meanGenome),
        tags: c.tags || [],
      };
      this.clades.set(clade.id, clade);
    }
    this.events = (data.events || []).map(e => ({ ...e }));
    this.fossils = (data.fossils || []).map(f => ({ ...f, genome: inflateGenome(f.genome) }));
    this.epochsStarted = data.epochsStarted || 0;
    this._activeEpochs = (data.activeEpochs || []).map(e => ({ ...e }));
    this._complexity = data.complexity || null;
    this._attractionMatrix = data.attractionMatrix || this._attractionMatrix;
  }

  activeEpochs() { return this._activeEpochs || []; }
  topClades(n = 8) { return [...this.clades.values()].filter(c => c.aliveCount > 0).slice(0, n); }
  classifyClade(c) { return (c && c.tags) ? c.tags : []; }
  complexity() { return this._complexity || blankComplexity(); }
  attractionMatrix() { return this._attractionMatrix; }
  pushEvent(tick, type, msg, color) {
    this.events.unshift({ tick, type, msg, color });
    if (this.events.length > 80) this.events.pop();
  }
}

function blankComplexity() {
  return {
    total: 0,
    components: { brain: 0, radiation: 0, diversity: 0, depth: 0, comm: 0, construction: 0 },
    raw: {
      meanSlots: 0,
      livingClades: 0,
      variance: 0,
      maxDepth: 0,
      meanAct: 0,
      meanFlash: 0,
      meanColorVar: 0,
      wallActions: 0,
      wallActionRate: 0,
    },
  };
}

export class WorkerWorldProxy {
  constructor(opts = {}) {
    this.isWorkerProxy = true;
    this.maxParticles = opts.maxParticles || 5000;
    this.tick = 0;
    this.particles = [];
    this._particleById = new Map();
    this._particleToCluster = new Map();
    this._clusters = [];
    this.field = [new Float32Array(GW * GH), new Float32Array(GW * GH)];
    this.mutagen = new Float32Array(GW * GH);
    this.walls = new Uint8Array(GW * GH);
    this._wallMeta = new Map();
    this._wallCount = 0;
    this._wallsVersion = 0;
    this._attackFlashEvents = [];
    this._wallSoundEvents = [];
    this._deathSoundEvents = [];
    this.habitatRegions = [];
    this.totalBorn = 0;
    this.totalDied = 0;
    this.totalWallDigs = 0;
    this.totalWallDeposits = 0;
    this.totalPredationEvents = 0;
    this.totalClusterBuds = 0;
    this.totalClusterBudParticles = 0;
    this.totalClusterCellBirths = 0;
    this.clades = new SnapshotClades();
    this._vitals = emptyVitals();
    this._counts = new Array(NUM_SPECIES).fill(0);
    this._meanGenome = emptyMeanGenome();
    this._profile = null;
    this._snapshotCount = 0;
    this._fieldSnapshotCount = 0;
    this._wallSnapshotCount = 0;
    this._dynamicOnlySnapshotCount = 0;
    this._snapshotTransferBytes = 0;
    this._requestId = 1;
    this._pending = new Map();
    this._snapshotWaiters = [];
    this._runStateSig = '';
    this._workerStatus = 'starting';

    this.worker = new Worker(new URL('./sim_worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (evt) => this._handleMessage(evt.data);
    this.worker.onerror = (err) => {
      this._workerStatus = `error: ${err.message || err}`;
      console.error('[worker sim]', err);
    };
    this.ready = new Promise(resolve => { this._resolveReady = resolve; });
    this._send('init', {
      preset: opts.preset || 'soup',
      count: opts.count || 1800,
      paused: !!opts.paused,
      speed: opts.speed ?? 1,
      workBudgetMs: opts.workBudgetMs ?? 12,
      snapshotIntervalMs: opts.snapshotIntervalMs ?? 80,
      fieldSnapshotIntervalMs: opts.fieldSnapshotIntervalMs ?? 500,
      wallSnapshotIntervalMs: opts.wallSnapshotIntervalMs ?? 240,
      seed: opts.seed ?? null,
    });
  }

  _send(type, payload = {}) {
    this.worker.postMessage({ type, payload });
  }

  _request(type, payload = {}) {
    const id = this._requestId++;
    this.worker.postMessage({ type, payload, id });
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        reject(new Error(`worker request timed out: ${type}`));
      }, 10000);
    });
  }

  _handleMessage(msg = {}) {
    if (msg.type === 'snapshot') {
      this.applySnapshot(msg.snapshot);
      if (this._resolveReady) {
        this._resolveReady(this);
        this._resolveReady = null;
      }
      const waiters = this._snapshotWaiters.splice(0);
      for (const waiter of waiters) waiter(this);
      return;
    }
    if (msg.type === 'response') {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.value);
      else pending.reject(new Error(msg.error || 'worker request failed'));
      return;
    }
    if (msg.type === 'error') {
      this._workerStatus = `error: ${msg.error || 'unknown'}`;
      console.error('[worker sim]', msg.error);
    }
  }

  _releaseParticleSlabBuffers(slab) {
    if (!slab) return;
    const buffers = [];
    const add = (kind, array) => {
      if (array && array.buffer && array.buffer.byteLength > 0) {
        buffers.push({ kind, buffer: array.buffer });
      }
    };
    add('particleIds', slab.ids);
    add('particleData', slab.data);
    add('particleBonds', slab.bonds);
    add('particleGenomes', slab.genomes);
    if (!buffers.length) return;
    this.worker.postMessage(
      { type: 'releaseBuffers', payload: { buffers } },
      buffers.map(item => item.buffer),
    );
  }

  waitForSnapshot(timeoutMs = 1500) {
    return new Promise(resolve => {
      const waiter = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        const i = this._snapshotWaiters.indexOf(waiter);
        if (i >= 0) this._snapshotWaiters.splice(i, 1);
        resolve(this);
      }, timeoutMs);
      this._snapshotWaiters.push(waiter);
    });
  }

  applySnapshot(snapshot) {
    if (!snapshot) return;
    this._snapshotCount++;
    this._lastSnapshotAt = performance.now();
    this.tick = snapshot.tick || 0;
    this.maxParticles = snapshot.maxParticles || this.maxParticles;
    const layers = snapshot.worker?.layers || {};
    if (snapshot.field0 && snapshot.field1) {
      this.field = [snapshot.field0, snapshot.field1];
      this._fieldSnapshotCount++;
    }
    if (snapshot.mutagen) this.mutagen = snapshot.mutagen;
    if (snapshot.walls) {
      this.walls = snapshot.walls;
      this._wallSnapshotCount++;
    }
    if (layers.fields === false && layers.walls === false) this._dynamicOnlySnapshotCount++;
    this._snapshotTransferBytes += snapshot.worker?.transferBytes || 0;
    if (Array.isArray(snapshot.habitatRegions)) this.habitatRegions = snapshot.habitatRegions;
    if (Number.isFinite(snapshot._wallCount)) this._wallCount = snapshot._wallCount;
    if (Number.isFinite(snapshot._wallsVersion)) this._wallsVersion = snapshot._wallsVersion;
    this._attackFlashEvents = snapshot._attackFlashEvents || [];
    this._wallSoundEvents = snapshot._wallSoundEvents || [];
    this._deathSoundEvents = snapshot._deathSoundEvents || [];
    if (Array.isArray(snapshot.wallMeta)) {
      this._wallMeta.clear();
      for (const row of snapshot.wallMeta || []) this._wallMeta.set(row[0] | 0, row);
    }

    const seen = new Set();
    const next = [];
    const particleRows = snapshot.particleSlab
      ? particleRowsFromSlab(snapshot.particleSlab)
      : (snapshot.particles || []);
    for (const src of particleRows) {
      let p = this._particleById.get(src.id);
      if (!p) {
        p = { id: src.id, dead: false };
        this._particleById.set(src.id, p);
      }
      Object.assign(p, src, {
        dead: false,
        genome: inflateGenome(src.genome),
        species: src.species ?? src.genome?.species ?? 0,
      });
      seen.add(p.id);
      next.push(p);
    }
    for (const [id, p] of this._particleById) {
      if (!seen.has(id)) {
        p.dead = true;
        this._particleById.delete(id);
      }
    }
    this.particles = next;

    this._clusters = [];
    this._particleToCluster.clear();
    for (const src of snapshot.clusters || []) {
      const members = (src.members || [])
        .map(id => this._particleById.get(id))
        .filter(Boolean);
      const cluster = { ...src, members };
      this._clusters.push(cluster);
      for (const p of members) this._particleToCluster.set(p.id, cluster);
    }

    const totals = snapshot.totals || {};
    this.totalBorn = totals.totalBorn || 0;
    this.totalDied = totals.totalDied || 0;
    this.totalWallDigs = totals.totalWallDigs || 0;
    this.totalWallDeposits = totals.totalWallDeposits || 0;
    this.totalPredationEvents = totals.totalPredationEvents || 0;
    this.totalClusterBuds = totals.totalClusterBuds || 0;
    this.totalClusterBudParticles = totals.totalClusterBudParticles || 0;
    this.totalClusterCellBirths = totals.totalClusterCellBirths || 0;
    this._counts = snapshot.counts || new Array(NUM_SPECIES).fill(0);
    this._vitals = snapshot.vitals || emptyVitals();
    this._meanGenome = snapshot.meanGenome || emptyMeanGenome();
    this._profile = snapshot.profile || null;
    this.clades.apply(snapshot.clades || {});
    this._workerStatus = snapshot.worker?.paused ? 'paused worker' : 'active worker';
    this._workerSnapshot = snapshot.worker || {};
    this._workerLayerStats = {
      snapshots: this._snapshotCount,
      fieldSnapshots: this._fieldSnapshotCount,
      wallSnapshots: this._wallSnapshotCount,
      dynamicOnlySnapshots: this._dynamicOnlySnapshotCount,
      transferBytes: this._snapshotTransferBytes,
      lastLayers: layers,
      workerStats: snapshot.worker?.snapshotStats || null,
    };
    this._releaseParticleSlabBuffers(snapshot.particleSlab);
  }

  setRunState({ paused, speed, workBudgetMs, snapshotIntervalMs, fieldSnapshotIntervalMs, wallSnapshotIntervalMs } = {}) {
    const payload = {
      paused: !!paused,
      speed: Number.isFinite(speed) ? speed : 1,
      workBudgetMs: Number.isFinite(workBudgetMs) ? workBudgetMs : 12,
      snapshotIntervalMs: Number.isFinite(snapshotIntervalMs) ? snapshotIntervalMs : 80,
      fieldSnapshotIntervalMs: Number.isFinite(fieldSnapshotIntervalMs) ? fieldSnapshotIntervalMs : 500,
      wallSnapshotIntervalMs: Number.isFinite(wallSnapshotIntervalMs) ? wallSnapshotIntervalMs : 240,
    };
    const sig = `${payload.paused}|${payload.speed}|${payload.workBudgetMs}|${payload.snapshotIntervalMs}|${payload.fieldSnapshotIntervalMs}|${payload.wallSnapshotIntervalMs}`;
    if (sig === this._runStateSig) return;
    this._runStateSig = sig;
    this._send('runState', payload);
  }

  step() { this._send('stepOnce'); return this.waitForSnapshot(); }
  applyPreset(name, count, seed = null) {
    this._send('preset', { name, count, seed });
    return this.waitForSnapshot();
  }
  brushApply(kind, x, y, radius, strength, spawnSpecies = 0) {
    this._send('brush', { kind, x, y, radius, strength, spawnSpecies });
  }
  clearField() { this._send('clearField'); }
  mutagenStorm(amount = 1.8) { this._send('mutagenStorm', { amount }); }
  exterminateSpecies(species) { this._send('exterminateSpecies', { species }); return 0; }
  setBondBarrier(enabled) { this._send('bondBarrier', { enabled }); }
  setProfiling(enabled) { this._send('setProfiling', { enabled: !!enabled }); }
  profileSnapshot({ reset = false } = {}) {
    if (reset) this._send('profileReset');
    return this._profile;
  }
  setGPUPairOnly() {}
  setGPUEnabled() {}
  isGPUEnabled() { return false; }

  populationBySpecies() { return Array.from(this._counts || []); }
  vitals() { return this._vitals || emptyVitals(); }
  meanGenome() { return this._meanGenome || emptyMeanGenome(); }

  pickParticleAt(x, y, radius = 8) {
    const r2 = radius * radius;
    let best = null;
    let bd2 = r2;
    for (const p of this.particles) {
      const dx = p.x - x;
      const dy = p.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd2) { bd2 = d2; best = p; }
    }
    return best;
  }

  wallInfoAt(gx, gy) {
    if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return null;
    const idx = gy * GW + gx;
    const type = this.walls[idx] || 0;
    if (!type) return null;
    const meta = this._wallMeta.get(idx) || [];
    const ownerId = meta[1] || 0;
    const clusterAnchorId = meta[2] || 0;
    const cladeId = meta[3] || 0;
    const depositedTick = meta[4] || 0;
    const ownerAlive = ownerId ? this._particleById.has(ownerId) : false;
    const cluster = clusterAnchorId
      ? (this._clusters || []).find(c => c.anchorId === clusterAnchorId)
      : null;
    return {
      idx,
      gx,
      gy,
      type,
      ownerId,
      ownerAlive,
      clusterAnchorId,
      clusterName: cluster ? cluster.name : '',
      clusterAlive: !!cluster,
      cladeId,
      depositedTick,
    };
  }

  toJSONAsync() { return this._request('toJSON'); }
  toWorldTemplateJSONAsync() { return this._request('toWorldTemplateJSON'); }
  toJSON() {
    return {
      kind: 'primordia.worker-preview-snapshot.v1',
      tick: this.tick,
      note: 'Use Export in main-thread mode for a synchronous full save, or await toJSONAsync from the worker proxy.',
    };
  }
  toWorldTemplateJSON() {
    return {
      kind: 'primordia.world-template.v1',
      version: 1,
      gw: GW,
      gh: GH,
      cell: CELL,
      walls: Array.from(this.walls),
      habitatRegions: this.habitatRegions || [],
      field0: Array.from(this.field[0], v => +v.toFixed(4)),
      field1: Array.from(this.field[1], v => +v.toFixed(4)),
      mutagen: Array.from(this.mutagen, v => +v.toFixed(4)),
      wallCount: this._wallCount || 0,
      note: 'Sterile terrain/field template from worker snapshot.',
    };
  }
  fromJSON(data) { this._send('fromJSON', { data }); }
  fromWorldTemplateJSON(data) { this._send('fromWorldTemplateJSON', { data }); }
}

export function workerModeFromLocation(locationObj = window.location) {
  const params = new URLSearchParams(locationObj.search || '');
  const raw = params.get('worker');
  return raw === '1' || raw === 'true' || raw === 'yes';
}
