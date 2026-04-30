// ui.js — DOM controls, brush dispatch, specimen inspector, save/load.

import { W, H } from './sim.js';
import {
  SPECIES_COLORS, SPECIES_NAMES, NUM_SPECIES, NUM_CHEM, CHEM_NAMES,
} from './genome.js';
import { PRESETS, PRESET_COUNTS } from './presets.js';

const STORAGE_KEY = 'primordia.world.v1';

export class UI {
  constructor({ world, renderer, camera, chart, bgCanvas, stage, onPresetLoaded }) {
    this.world = world;
    this.renderer = renderer;
    this.camera = camera;
    this.chart = chart;
    this.bgCanvas = bgCanvas;
    this.stage = stage;
    this.onPresetLoaded = onPresetLoaded || (() => {});

    this.paused = false;
    this.speed = 1;
    this.activeBrush = 'none';
    this.brushSize = 2;
    this.brushStrength = 1;
    this.spawnSpecies = 0;
    this.dragging = false;
    this.lastBrushAt = 0;
    this.lastClickWasDrag = false;

    this.specimenEl = document.getElementById('specimen');
    this.statsEl = document.getElementById('ui-stats');
    this.meanEl = document.getElementById('ui-mean-genome');
    this.fpsEl = document.getElementById('ui-fps');
    this.tickEl = document.getElementById('ui-step');
    this.pauseBtn = document.getElementById('btn-pause');
    this.matrixCanvas = document.getElementById('matrix');
    this.matrixTooltip = document.getElementById('matrix-tooltip');
    this.cladesEl = document.getElementById('ui-clades');
    this.clustersEl = document.getElementById('ui-clusters');
    this.eventsEl = document.getElementById('ui-events');
    this.fossilsEl = document.getElementById('ui-fossils');
    this.complexityEl = document.getElementById('ui-complexity');
    this._matrixCtx = this.matrixCanvas.getContext('2d');
    this.bindMatrixHover();

    // Watchdog state
    this.watchdog = { enabled: false, interval: 2000, threshold: 0.25, lastFired: 0 };
    this.activePreset = 'soup';

    this.bindControls();
    this.bindBrushPalette();
    this.bindCanvas();
    this.populateSpawnSelect();
    this.refreshStats();
  }

  // ────────────────────────────── Controls

  bindControls() {
    this.pauseBtn.addEventListener('click', () => this.togglePause());

    document.getElementById('btn-step').addEventListener('click', async () => {
      await this.world.step();
      this.refreshStats();
    });

    const speedSlider = document.getElementById('ui-speed');
    const speedVal = document.getElementById('ui-speed-val');
    speedSlider.addEventListener('input', () => {
      this.speed = parseFloat(speedSlider.value);
      speedVal.textContent = this.speed.toFixed(2) + '×';
    });

    const sizeSlider = document.getElementById('ui-brush-size');
    const sizeVal = document.getElementById('ui-brush-size-val');
    sizeSlider.addEventListener('input', () => {
      this.brushSize = parseInt(sizeSlider.value);
      sizeVal.textContent = this.brushSize;
    });

    const strengthSlider = document.getElementById('ui-brush-strength');
    const strengthVal = document.getElementById('ui-brush-strength-val');
    strengthSlider.addEventListener('input', () => {
      this.brushStrength = parseFloat(strengthSlider.value);
      strengthVal.textContent = this.brushStrength.toFixed(2);
    });

    document.getElementById('ui-spawn-species').addEventListener('change', (e) => {
      this.spawnSpecies = parseInt(e.target.value);
    });

    // Visual toggles
    const bind = (id, key) => {
      const el = document.getElementById(id);
      el.addEventListener('change', () => this.renderer.setOption(key, el.checked));
    };
    bind('ui-trails', 'trails');
    bind('ui-show-field', 'showField');
    bind('ui-show-walls', 'showWalls');
    bind('ui-show-flags', 'showFlags');

    // Bond barrier — toggles World.bondBarrier directly (sim flag, not a
    // visual option). When on, named clusters become impassable to outsider
    // particles via perpendicular force on bond segments.
    const barrierEl = document.getElementById('ui-bond-barrier');
    if (barrierEl) {
      barrierEl.addEventListener('change', () => {
        this.world.bondBarrier = barrierEl.checked;
      });
    }

    // Audio hum toggle — must enable from a user gesture (browser policy)
    const audioEl = document.getElementById('ui-audio');
    const audioVol = document.getElementById('ui-audio-vol');
    const audioVolVal = document.getElementById('ui-audio-vol-val');
    audioEl.addEventListener('change', async () => {
      const audio = window.__primordia?.audioHum;
      if (!audio) return;
      if (audioEl.checked) {
        const ok = audio.enable();
        if (ok && audio.ctx?.state === 'suspended') {
          try { await audio.ctx.resume(); } catch {}
        }
        if (!ok) audioEl.checked = false;
      } else {
        audio.disable();
      }
    });
    audioVol.addEventListener('input', () => {
      const v = parseFloat(audioVol.value);
      audioVolVal.textContent = v.toFixed(2);
      window.__primordia?.audioHum?.setMaster(v);
    });

    // GPU toggle — wired but currently informational; compute pipelines arrive in 4c.
    this._gpuEl = document.getElementById('ui-gpu');
    this._gpuStatusEl = document.getElementById('ui-gpu-status');
    this._gpuEl.addEventListener('change', () => {
      const checked = this._gpuEl.checked;
      const result = window.__primordia?.gpu?.setEnabled(checked);
      // result is the new enabled state. If the user wanted ON but init has
      // not produced a device, refuse and uncheck. UNCHECK always succeeds —
      // make sure to propagate that to world.setGPUEnabled too.
      if (checked && result === false) {
        this._gpuEl.checked = false;
        this.world.setGPUEnabled(false);
        return;
      }
      this.world.setGPUEnabled(checked);
    });

    // Presets — decorate buttons with seed counts so the user sees scale
    // without having to read presets.js.
    document.querySelectorAll('[data-preset]').forEach(btn => {
      const name = btn.dataset.preset;
      const count = PRESET_COUNTS[name];
      if (count != null) {
        const baseLabel = btn.textContent.trim();
        btn.innerHTML = `${baseLabel}<span class="preset-count">${count}</span>`;
      }
      btn.addEventListener('click', () => {
        const fn = PRESETS[name];
        if (fn) {
          fn(this.world);
          this.activePreset = name;
          this.chart.data.length = 0;
          this.refreshStats();
          this.hideSpecimen();
          this.onPresetLoaded(name);
        }
      });
    });

    // World ops
    document.getElementById('btn-randomize').addEventListener('click', () => {
      // Reroll attractions + cohesion AND give every particle a velocity kick
      // so the change is immediately visible. Also push an event so the user
      // gets feedback (the previous version silently rerolled rows, which made
      // it look like nothing happened).
      let n = 0;
      for (const p of this.world.particles) {
        if (p.dead) continue;
        for (let i = 0; i < NUM_SPECIES; i++) {
          p.genome.attraction[i] = (Math.random() * 2 - 1) * 0.7;
        }
        p.genome.cohesion = (Math.random() - 0.4) * 0.9;
        const ang = Math.random() * Math.PI * 2;
        const mag = 0.8 + Math.random() * 1.2;
        p.vx += Math.cos(ang) * mag;
        p.vy += Math.sin(ang) * mag;
        n++;
      }
      this.world.clades.pushEvent(this.world.tick, 'speciation',
        `attraction matrix randomized · ${n} rerolled`, '#a78bfa');
      this.flashButton('btn-randomize', `${n} rerolled`);
    });
    document.getElementById('btn-clear').addEventListener('click', () => this.world.clearField());
    document.getElementById('btn-reset').addEventListener('click', () => {
      PRESETS.soup(this.world);
      this.chart.data.length = 0;
      this.hideSpecimen();
    });
    document.getElementById('btn-save').addEventListener('click', () => this.save());
    document.getElementById('btn-load').addEventListener('click', () => this.load());
    document.getElementById('btn-export').addEventListener('click', () => this.exportFile());

    // Camera controls — every camera action also releases any active particle
    // or cluster chase, so users can break out of follow mode by pressing any
    // camera button (Fit/100%/Zoom in/Zoom out) without hunting for an
    // explicit "stop chasing" control.
    const releaseChase = () => {
      this.camera.unfollow();
      this._lastClustersSig = null;
    };
    document.getElementById('btn-cam-fit').addEventListener('click', () => {
      releaseChase();
      this.camera.fit();
    });
    document.getElementById('btn-cam-1x').addEventListener('click', () => {
      releaseChase();
      this.camera.zoom = 1; this.camera.clamp();
    });
    document.getElementById('btn-cam-zin').addEventListener('click', () => {
      releaseChase();
      this.camera.zoomAt(this.camera.viewW / 2, this.camera.viewH / 2, 1.4);
    });
    document.getElementById('btn-cam-zout').addEventListener('click', () => {
      releaseChase();
      this.camera.zoomAt(this.camera.viewW / 2, this.camera.viewH / 2, 1 / 1.4);
    });
    this.zoomEl = document.getElementById('ui-zoom');

    // God tools
    const exterminateSelect = document.getElementById('ui-exterminate-species');
    for (let i = 0; i < NUM_SPECIES; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${i} · ${SPECIES_NAMES[i]}`;
      exterminateSelect.appendChild(opt);
    }
    document.getElementById('btn-exterminate').addEventListener('click', () => {
      const v = exterminateSelect.value;
      if (v === '') return;
      const killed = this.world.exterminateSpecies(parseInt(v));
      this.flashButton('btn-exterminate', `${killed} smitten`);
    });
    document.getElementById('btn-mutagen-storm').addEventListener('click', () => {
      this.world.mutagenStorm(1.8);
      this.flashButton('btn-mutagen-storm', 'storm released');
    });

    // Watchdog wiring
    const wdEnable = document.getElementById('ui-watchdog');
    const wdInterval = document.getElementById('ui-watchdog-interval');
    const wdIntervalVal = document.getElementById('ui-watchdog-interval-val');
    const wdThresh = document.getElementById('ui-watchdog-thresh');
    const wdThreshVal = document.getElementById('ui-watchdog-thresh-val');
    wdEnable.addEventListener('change', () => {
      this.watchdog.enabled = wdEnable.checked;
      this.watchdog.lastFired = this.world.tick;
    });
    wdInterval.addEventListener('input', () => {
      this.watchdog.interval = parseInt(wdInterval.value);
      wdIntervalVal.textContent = this.watchdog.interval;
    });
    wdThresh.addEventListener('input', () => {
      this.watchdog.threshold = parseFloat(wdThresh.value);
      wdThreshVal.textContent = this.watchdog.threshold.toFixed(2);
    });

    // Keyboard
    window.addEventListener('keydown', async (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePause(); }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        await this.world.step();
        this.refreshStats();
      }
      if (/^[1-8]$/.test(e.key)) {
        const idx = parseInt(e.key) - 1;
        const brushes = ['none', 'food', 'wall', 'membrane', 'porous', 'mutagen', 'spawn', 'erase'];
        this.setActiveBrush(brushes[idx]);
      }
    });
  }

  togglePause() {
    this.paused = !this.paused;
    this.pauseBtn.textContent = this.paused ? 'Resume' : 'Pause';
    this.pauseBtn.classList.toggle('primary', !this.paused);
  }

  bindBrushPalette() {
    document.querySelectorAll('[data-brush]').forEach(btn => {
      btn.addEventListener('click', () => this.setActiveBrush(btn.dataset.brush));
    });
  }

  setActiveBrush(name) {
    this.activeBrush = name;
    document.querySelectorAll('[data-brush]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.brush === name);
    });
  }

  populateSpawnSelect() {
    const sel = document.getElementById('ui-spawn-species');
    for (let i = 0; i < NUM_SPECIES; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${i} · ${SPECIES_NAMES[i]}`;
      opt.style.color = SPECIES_COLORS[i];
      sel.appendChild(opt);
    }
  }

  // ────────────────────────────── Canvas pointer

  bindCanvas() {
    const c = this.bgCanvas;
    const cam = this.camera;

    // Map a pointer event into both canvas-internal pixel space (for camera math)
    // and world space (after applying inverse camera transform).
    const toWorld = (e) => {
      const r = c.getBoundingClientRect();
      const sx = c.width / r.width;
      const sy = c.height / r.height;
      const cssX = e.clientX - r.left;
      const cssY = e.clientY - r.top;
      const px = cssX * sx;       // canvas-internal pixel coords
      const py = cssY * sy;
      const w = cam.screenToWorld(px, py);
      return { x: w.x, y: w.y, cssX, cssY, px, py };
    };

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      // Middle button (or shift+left) → pan
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        this.panning = true;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        e.preventDefault();
        return;
      }
      this.dragging = true;
      this.lastClickWasDrag = false;
      const w = toWorld(e);
      this.applyBrushAt(w.x, w.y);
    });

    c.addEventListener('pointermove', (e) => {
      if (this.panning) {
        const dx = e.clientX - this.lastPanX;
        const dy = e.clientY - this.lastPanY;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        const r = c.getBoundingClientRect();
        const sx = c.width / r.width;
        const sy = c.height / r.height;
        cam.pan(dx * sx, dy * sy);
        return;
      }
      if (!this.dragging) return;
      this.lastClickWasDrag = true;
      const w = toWorld(e);
      this.applyBrushAt(w.x, w.y);
    });

    c.addEventListener('pointerup', (e) => {
      if (this.panning) { this.panning = false; return; }
      this.dragging = false;
      const w = toWorld(e);
      if (!this.lastClickWasDrag) {
        const pickRadius = 14 / cam.zoom;
        const p = this.world.pickParticleAt(w.x, w.y, pickRadius);
        if (p) this.showSpecimen(p, w.cssX, w.cssY);
        else this.hideSpecimen();
      }
    });
    c.addEventListener('pointercancel', () => { this.dragging = false; this.panning = false; });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // Wheel = zoom around cursor
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const sx = c.width / r.width;
      const sy = c.height / r.height;
      const px = (e.clientX - r.left) * sx;
      const py = (e.clientY - r.top) * sy;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      cam.zoomAt(px, py, factor);
    }, { passive: false });
  }

  applyBrushAt(x, y) {
    if (this.activeBrush === 'none') return;
    // Brush radius in world px; multiplier 5 = CELL, so size 1 paints a
    // 2-cell-diameter line matching the maze generator's narrow walls.
    // Size 5 paints a 10-cell-thick blob. World-space radius is constant
    // regardless of zoom — painting at high zoom produces the same on-
    // ground footprint as at full-fit zoom.
    this.world.brushApply(
      this.activeBrush, x, y,
      this.brushSize * 5,
      this.brushStrength,
      this.spawnSpecies,
    );
  }

  // ────────────────────────────── Specimen card

  showSpecimen(p, cssX, cssY, opts = {}) {
    const el = this.specimenEl;
    el.classList.remove('hidden');
    const stageRect = this.stage.getBoundingClientRect();
    let left = cssX + 14;
    let top = cssY + 14;
    if (left + 260 > stageRect.width) left = cssX - 260;
    if (top + 220 > stageRect.height) top = cssY - 220;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    const isLive = opts.live !== false && typeof p.id === 'number';
    const chasing = isLive && this.camera.followTarget === p;
    el.innerHTML = renderSpecimen(p, { isLive, chasing });
    el.querySelector('.close').addEventListener('click', () => this.hideSpecimen());
    const chaseBtn = el.querySelector('.btn-chase');
    if (chaseBtn) {
      chaseBtn.addEventListener('click', () => {
        if (this.camera.followTarget === p) {
          this.camera.unfollow();
          chaseBtn.textContent = 'Chase';
          chaseBtn.classList.remove('active');
        } else {
          this.camera.follow(p);
          chaseBtn.textContent = 'Stop chasing';
          chaseBtn.classList.add('active');
        }
      });
    }
    this._inspected = p;
  }

  hideSpecimen() {
    this.specimenEl.classList.add('hidden');
    this._inspected = null;
  }

  // ────────────────────────────── Stats panel

  refreshStats() {
    const counts = this.world.populationBySpecies();
    let html = '';
    let total = 0;
    for (let i = 0; i < NUM_SPECIES; i++) {
      total += counts[i];
      html += `<div class="row-stat">
        <span class="swatch" style="background:${SPECIES_COLORS[i]}"></span>
        <span>${SPECIES_NAMES[i]}</span>
        <span class="num">${counts[i]}</span>
      </div>`;
    }
    html += `<div class="row-stat"><span></span><span>total</span><span class="num">${total}</span></div>`;
    html += `<div class="row-stat"><span></span><span>born</span><span class="num">${this.world.totalBorn}</span></div>`;
    html += `<div class="row-stat"><span></span><span>died</span><span class="num">${this.world.totalDied}</span></div>`;

    // Vitals — energy/food/death rate so user can verify the closed ecology
    // is actually doing something. deaths/sec is sampled across stat refreshes
    // (this.deathRate, computed below in tickWatchdog hook).
    const v = this.world.vitals();
    const now = performance.now();
    if (this._lastVitals) {
      const dt = (now - this._lastVitals.t) / 1000;
      if (dt > 0.05) {
        const dDied = this.world.totalDied - this._lastVitals.died;
        const dBorn = this.world.totalBorn - this._lastVitals.born;
        // exponential smoothing to keep the readout stable
        const alpha = 0.3;
        this._deathRate = (this._deathRate || 0) * (1 - alpha) + (dDied / dt) * alpha;
        this._birthRate = (this._birthRate || 0) * (1 - alpha) + (dBorn / dt) * alpha;
        this._lastVitals = { t: now, died: this.world.totalDied, born: this.world.totalBorn };
      }
    } else {
      this._lastVitals = { t: now, died: this.world.totalDied, born: this.world.totalBorn };
      this._deathRate = 0;
      this._birthRate = 0;
    }
    const lowPct = (v.lowFrac * 100).toFixed(0);
    const energyClass = v.meanEnergy < 2 ? 'warn' : '';
    html += `<div class="row-stat vitals-divider"><span></span><span class="vitals-head">vitals</span><span></span></div>`;
    html += `<div class="row-stat"><span></span><span>mean E</span><span class="num ${energyClass}">${v.meanEnergy.toFixed(2)}</span></div>`;
    html += `<div class="row-stat"><span></span><span>low E (&lt;1)</span><span class="num">${lowPct}%</span></div>`;
    html += `<div class="row-stat"><span></span><span>mean food</span><span class="num">${v.meanFood.toFixed(3)}</span></div>`;
    html += `<div class="row-stat"><span></span><span>mean decay</span><span class="num">${v.meanDecay.toFixed(3)}</span></div>`;
    html += `<div class="row-stat"><span></span><span>births/s</span><span class="num">${(this._birthRate || 0).toFixed(1)}</span></div>`;
    html += `<div class="row-stat"><span></span><span>deaths/s</span><span class="num">${(this._deathRate || 0).toFixed(1)}</span></div>`;

    this.statsEl.innerHTML = html;

    if (total > 0) {
      const m = this.world.meanGenome();
      const fmt = (v) => (v >= 0 ? ' ' : '') + v.toFixed(2);
      let mh = '';
      mh += `<div class="row-stat"><span>cohesion</span><span class="num">${fmt(m.cohesion)}</span></div>`;
      mh += `<div class="row-stat"><span>metab</span><span class="num">${fmt(m.metab)}</span></div>`;
      mh += `<div class="row-stat"><span>efficiency</span><span class="num">${fmt(m.efficiency)}</span></div>`;
      mh += `<div class="row-stat"><span>repro</span><span class="num">${fmt(m.repro_thresh)}</span></div>`;
      mh += `<div class="row-stat"><span>mut</span><span class="num">${fmt(m.mut_rate)}</span></div>`;
      mh += `<div class="row-stat"><span>radius</span><span class="num">${fmt(m.sense_radius)}</span></div>`;
      mh += `<div class="row-stat"><span>sense·food</span><span class="num">${fmt(m.sense[0])}</span></div>`;
      mh += `<div class="row-stat"><span>sense·decay</span><span class="num">${fmt(m.sense[1])}</span></div>`;
      this.meanEl.innerHTML = mh;
    } else {
      this.meanEl.innerHTML = '<div class="row-stat"><span>(empty)</span></div>';
    }

    this.tickEl.textContent = this.world.tick.toString();
    if (this.zoomEl) this.zoomEl.textContent = this.camera.zoom.toFixed(2) + '×';

    // Lineage panels
    this.updateMatrix();
    this.updateClades();
    this.updateClusters();
    this.updateEvents();
    this.updateFossils();
    this.updateComplexity();
    this.updateGPUDiag();
    this.tickWatchdog();
  }

  // Top Clusters panel — lists named bonded clusters with zoom/chase actions.
  updateClusters() {
    const clusters = this.world._clusters || [];
    const showCount = Math.min(clusters.length, 8);
    const chasedCluster = this.camera.resolveChasedCluster
      ? this.camera.resolveChasedCluster(this.world)
      : null;
    const sigKey = clusters.slice(0, 8).map(c => `${c.anchorId}:${c.count}`).join('|') +
                   ':' + (chasedCluster ? chasedCluster.anchorId : 'x');
    if (sigKey === this._lastClustersSig) return;
    this._lastClustersSig = sigKey;

    if (showCount === 0) {
      this.clustersEl.innerHTML = '<div class="hint-text">no bonded clusters yet · let the soup settle</div>';
      return;
    }
    let html = '';
    for (let i = 0; i < showCount; i++) {
      const c = clusters[i];
      const col = SPECIES_COLORS[c.species] || '#fff';
      const chasing = chasedCluster === c;
      html += `<div class="cluster-row ${chasing ? 'chasing' : ''}" data-anchor="${c.anchorId}">
        <span class="swatch" style="background:${col}"></span>
        <span class="name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
        <span class="pop">${c.count}</span>
        <button class="btn-mini btn-zoom" data-act="zoom">zoom</button>
        <button class="btn-mini btn-chase ${chasing ? 'active' : ''}" data-act="chase">${chasing ? '×' : 'chase'}</button>
      </div>`;
    }
    this.clustersEl.innerHTML = html;
    this.clustersEl.querySelectorAll('.cluster-row').forEach(row => {
      const anchor = parseInt(row.dataset.anchor);
      row.querySelector('[data-act="zoom"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const c = (this.world._clusters || []).find(c => c.anchorId === anchor);
        if (!c) return;
        this.camera.x = c.cx;
        this.camera.y = c.cy;
        this.camera.zoom = 2.5;
        this.camera.clamp();
      });
      row.querySelector('[data-act="chase"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const cluster = (this.world._clusters || []).find(c => c.anchorId === anchor);
        if (!cluster) return;
        const alreadyChasing = chasedCluster === cluster;
        if (alreadyChasing) {
          this.camera.unfollow();
        } else {
          this.camera.zoom = Math.max(this.camera.zoom, 1.8);
          // Snapshot up to 8 member ids — chase survives anchor death now
          const memberIds = (cluster.members || [])
            .filter(p => p && !p.dead)
            .slice(0, 8)
            .map(p => p.id);
          this.camera.followCluster(memberIds.length ? memberIds : [anchor]);
        }
        this._lastClustersSig = null;  // force re-render so chasing state updates
      });
    });
  }

  // ────────────────────────────── Complexity HUD

  updateComplexity() {
    const c = this.world.clades.complexity(this.world);
    this._lastComplexity = c;
    const pct = (v) => (Math.min(1, Math.max(0, v)) * 100).toFixed(0);
    let html = `<div class="total">
      <div class="bar-wrap"><div class="fill" style="width:${pct(c.total)}%"></div></div>
      <span class="num">${c.total.toFixed(2)}</span>
    </div>
    <div class="components">`;
    const parts = [
      ['brain',     c.components.brain,     `slots ${c.raw.meanSlots.toFixed(1)}`],
      ['radiation', c.components.radiation, `${c.raw.livingClades} clades`],
      ['diversity', c.components.diversity, `σ ${c.raw.variance.toFixed(2)}`],
      ['depth',     c.components.depth,     `${c.raw.maxDepth} gens`],
      ['comm',      c.components.comm,      `act ${(c.raw.meanAct||0).toFixed(2)} · flash ${(c.raw.meanFlash||0).toFixed(2)} · var ${(c.raw.meanColorVar||0).toFixed(2)}`],
    ];
    for (const [name, v, raw] of parts) {
      html += `<div class="comp-row">
        <span class="name">${name}</span>
        <div class="mini-bar"><div class="fill" style="width:${pct(v)}%"></div></div>
        <span class="num">${raw}</span>
      </div>`;
    }
    html += '</div>';
    this.complexityEl.innerHTML = html;
  }

  tickWatchdog() {
    const wd = this.watchdog;
    if (!wd.enabled) return;
    if (this.world.tick - wd.lastFired < wd.interval) return;
    wd.lastFired = this.world.tick;
    const score = this._lastComplexity ? this._lastComplexity.total : 0;
    if (score < wd.threshold) {
      // Reseed
      const fn = PRESETS[this.activePreset] || PRESETS.soup;
      fn(this.world);
      this.chart.data.length = 0;
      this.world.clades.pushEvent(this.world.tick, 'crash',
        `watchdog reseed · complexity ${score.toFixed(2)} < ${wd.threshold.toFixed(2)}`,
        '#ff8a3c');
      this.hideSpecimen();
    }
  }

  // ────────────────────────────── Attraction matrix (rows = emitter species)

  updateMatrix() {
    const ctx = this._matrixCtx;
    const cw = this.matrixCanvas.width;
    const ch = this.matrixCanvas.height;
    const cellW = cw / NUM_SPECIES;
    const cellH = ch / NUM_SPECIES;
    ctx.clearRect(0, 0, cw, ch);

    const { matrix, counts } = this.world.clades.attractionMatrix(this.world);
    this._lastMatrix = matrix;
    this._lastMatrixCounts = counts;

    for (let i = 0; i < NUM_SPECIES; i++) {
      for (let j = 0; j < NUM_SPECIES; j++) {
        const v = matrix[i][j];
        // Map [-1, 1] → red (neg) / blue (pos). Empty rows = dim.
        const empty = counts[i] === 0;
        const intensity = empty ? 0.15 : Math.min(1, Math.abs(v));
        let r, g, b;
        if (v >= 0) {
          r = 30 + 60 * (1 - intensity);
          g = 90 + 90 * intensity;
          b = 180 + 60 * intensity;
        } else {
          r = 200 + 40 * intensity;
          g = 60 + 30 * (1 - intensity);
          b = 70 + 40 * (1 - intensity);
        }
        if (empty) {
          // gray-out empty rows
          r = 35; g = 38; b = 48;
        }
        ctx.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
        ctx.fillRect(j * cellW, i * cellH, cellW, cellH);
      }
    }

    // Row & column color swatches along edges
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    for (let s = 0; s < NUM_SPECIES; s++) {
      ctx.fillStyle = SPECIES_COLORS[s];
      ctx.fillRect(0, s * cellH + cellH * 0.35, 2, cellH * 0.3);     // left axis
      ctx.fillRect(s * cellW + cellW * 0.35, 0, cellW * 0.3, 2);     // top axis
    }
  }

  bindMatrixHover() {
    const c = this.matrixCanvas;
    c.addEventListener('mousemove', (e) => {
      if (!this._lastMatrix) return;
      const r = c.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const i = Math.min(NUM_SPECIES - 1, Math.max(0, (y * NUM_SPECIES) | 0));
      const j = Math.min(NUM_SPECIES - 1, Math.max(0, (x * NUM_SPECIES) | 0));
      const v = this._lastMatrix[i][j];
      const cnt = this._lastMatrixCounts[i];
      this.matrixTooltip.textContent =
        cnt === 0
          ? `${SPECIES_NAMES[i]} → ${SPECIES_NAMES[j]} · (no living)`
          : `${SPECIES_NAMES[i]} → ${SPECIES_NAMES[j]} · ${v.toFixed(2)} (n=${cnt})`;
    });
    c.addEventListener('mouseleave', () => {
      this.matrixTooltip.textContent = '';
    });
  }

  // ────────────────────────────── Top clades

  updateClades() {
    const top = this.world.clades.topClades(8);
    if (top.length === this._lastCladesCount && this.world.tick - (this._lastCladesUpdate || 0) < 12) {
      // light update — just redraw sparklines
      this._refreshCladeSparks(top);
      return;
    }
    this._lastCladesCount = top.length;
    this._lastCladesUpdate = this.world.tick;

    let html = '';
    for (const c of top) {
      const col = SPECIES_COLORS[c.species];
      const age = this.world.tick - c.foundedTick;
      const parent = c.parentId ? `← #${c.parentId}` : 'founder';
      const tags = this.world.clades.classifyClade(c);
      const tagHtml = tags.map(t =>
        `<span class="tag" style="color:${t.color}; border-color:${t.color}40" title="${t.name}">${t.icon}</span>`
      ).join('');
      const name = c.name || `#${c.id}`;
      html += `
        <div class="clade-row" data-clade="${c.id}" title="#${c.id}">
          <span class="swatch" style="background:${col}"></span>
          <span class="id">${name}</span>
          <span class="meta">${parent} · age ${age}</span>
          <span class="pop">${c.aliveCount}</span>
          <span class="tags">${tagHtml}</span>
          <canvas data-clade-spark="${c.id}"></canvas>
        </div>`;
    }
    this.cladesEl.innerHTML = html;

    // wire click handlers
    this.cladesEl.querySelectorAll('.clade-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = parseInt(row.dataset.clade);
        const cl = this.world.clades.clades.get(id);
        if (cl) this.showCladeFounder(cl);
      });
    });

    this._refreshCladeSparks(top);
  }

  _refreshCladeSparks(top) {
    for (const c of top) {
      const cv = this.cladesEl.querySelector(`[data-clade-spark="${c.id}"]`);
      if (!cv) continue;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(40, cv.clientWidth) * dpr;
      const h = 14 * dpr;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      const hist = c.popHistory;
      if (hist.length < 2) continue;
      const max = Math.max(...hist, 1);
      ctx.beginPath();
      ctx.strokeStyle = SPECIES_COLORS[c.species];
      ctx.lineWidth = 1 * dpr;
      for (let i = 0; i < hist.length; i++) {
        const x = (i / (hist.length - 1)) * w;
        const y = h - (hist[i] / max) * (h - 2) - 1;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  showCladeFounder(clade) {
    // Reuse the specimen card to inspect the founder genome
    const fakeParticle = {
      id: `clade-${clade.id}`,
      genome: clade.founderGenome,
      age: this.world.tick - clade.foundedTick,
      energy: 0,
      lineage: clade.id,
    };
    const stageRect = this.stage.getBoundingClientRect();
    this.showSpecimen(fakeParticle, stageRect.width / 2 - 130, 60);
  }

  // ────────────────────────────── Event ticker

  updateEvents() {
    const tracker = this.world.clades;
    const events = tracker.events;
    const epochs = tracker.activeEpochs();
    const sig = events.length + ':' + epochs.map(e => e.name).join('|');
    if (sig === this._lastEventSig) return;
    this._lastEventSig = sig;

    let html = '';
    if (epochs.length) {
      html += '<div class="active-epochs">';
      for (const ep of epochs) {
        html += `<span class="epoch-pill" title="${escapeHtml(ep.description)}">★ ${escapeHtml(ep.name)}</span>`;
      }
      html += '</div>';
    }
    for (let i = 0; i < Math.min(events.length, 30); i++) {
      const e = events[i];
      html += `<div class="ev ${e.type}">
        <span class="t">t${e.tick}</span><span class="msg">${escapeHtml(e.msg)}</span>
      </div>`;
    }
    this.eventsEl.innerHTML = html;
  }

  // ────────────────────────────── Fossils

  updateFossils() {
    const fossils = this.world.clades.fossils;
    if (fossils.length === this._lastFossilCount) return;
    this._lastFossilCount = fossils.length;
    let html = '';
    for (let i = 0; i < fossils.length; i++) {
      const f = fossils[i];
      const col = SPECIES_COLORS[f.species];
      html += `<div class="fossil" data-fossil="${i}" title="age ${f.age} · clade #${f.cladeId}">
        <div class="dot" style="background:${col}; color:${col}"></div>
        <span class="age">${f.age}</span>
      </div>`;
    }
    this.fossilsEl.innerHTML = html;
    this.fossilsEl.querySelectorAll('.fossil').forEach(el => {
      el.addEventListener('click', () => {
        const i = parseInt(el.dataset.fossil);
        const f = this.world.clades.fossils[i];
        if (!f) return;
        const fakeParticle = {
          id: `fossil-${f.tick}`,
          genome: f.genome,
          age: f.age,
          energy: f.energy,
          lineage: f.cladeId,
        };
        const stageRect = this.stage.getBoundingClientRect();
        this.showSpecimen(fakeParticle, stageRect.width / 2 - 130, 60);
      });
    });
  }

  setFps(fps) { this.fpsEl.textContent = fps.toFixed(0); }

  onGPUStatusChange(info) {
    if (!this._gpuStatusEl) return;
    this._gpuStatusEl.textContent = info.status;
    if (info.available && info.status.startsWith('ready')) {
      this._gpuEl.disabled = false;
    } else {
      this._gpuEl.disabled = true;
      this._gpuEl.checked = false;
    }
  }

  // Live diagnostic: shown in the GPU panel each refresh so user can see if
  // the path is actually engaging.
  updateGPUDiag() {
    if (!this._gpuStatusEl) return;
    const w = this.world;
    const k = w._gpu;
    if (!k) return;            // no kernel → keep static status text
    if (!w._gpuEnabled) {
      this._gpuStatusEl.textContent = `idle · ${k.dispatchCount} dispatches done`;
      return;
    }
    const err = k.lastError ? ` · err:${k.lastError}` : '';
    const upMs = (k.lastUploadMs || 0).toFixed(2);
    this._gpuStatusEl.textContent =
      `active · ${k.dispatchCount} dispatches · ` +
      `up ${upMs}ms · disp ${k.lastDispatchMs.toFixed(2)}ms · ` +
      `read ${k.lastReadbackMs.toFixed(2)}ms${err}`;
  }

  // ────────────────────────────── Persistence

  save() {
    const data = this.world.toJSON();
    let json;
    try {
      json = JSON.stringify(data);
      localStorage.setItem(STORAGE_KEY, json);
      this.flashButton('btn-save', 'Saved ✓');
      return;
    } catch (err) {
      const isQuota = err && (err.name === 'QuotaExceededError' ||
                              /quota|exceeded/i.test(err.message || ''));
      if (!isQuota) {
        console.error('save failed', err);
        this.flashButton('btn-save', 'Save failed');
        return;
      }
    }

    // Quota fallback — progressively strip the largest payloads. localStorage
    // limits are ~5 MB per origin and a 5k-particle world easily blows past
    // that. Try brain-strip first, then drop chemical fields (recoverable),
    // then drop fossils + clade snapshots, before giving up and pointing at
    // Export for full state.
    const stripBrains = () => {
      for (const p of data.particles) if (p.genome) p.genome.brain = null;
      if (data.clades && data.clades.clades) {
        for (const c of data.clades.clades) {
          if (c.founder) c.founder.brain = null;
          if (c.mean) c.mean.brain = null;
        }
        for (const f of (data.clades.fossils || [])) {
          if (f.genome) f.genome.brain = null;
        }
      }
    };
    const stripFields = () => {
      data.field0 = null; data.field1 = null; data.mutagen = null;
    };
    const stripFossils = () => {
      if (data.clades) data.clades.fossils = [];
    };
    const trySave = (label) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        this.flashButton('btn-save', `Saved ✓ (${label})`);
        console.warn(`[save] localStorage quota → degraded save: ${label}. Use Export for full state.`);
        return true;
      } catch (err2) {
        return false;
      }
    };
    stripBrains();
    if (trySave('no brains')) return;
    stripFields();
    if (trySave('no brains/fields')) return;
    stripFossils();
    if (trySave('shape only')) return;
    console.error('save quota: all fallbacks failed');
    this.flashButton('btn-save', 'Use Export');
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { this.flashButton('btn-load', 'No save'); return; }
      const data = JSON.parse(raw);
      this.world.fromJSON(data);
      this.chart.data.length = 0;
      this.refreshStats();
      this.flashButton('btn-load', 'Loaded ✓');
    } catch (err) {
      console.error('load failed', err);
      this.flashButton('btn-load', 'Load failed');
    }
  }

  exportFile() {
    try {
      const data = this.world.toJSON();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `primordia-tick${this.world.tick}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error('export failed', err);
    }
  }

  flashButton(id, label) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = orig; }, 900);
  }
}

// ────────────────────────────── helpers

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderSpecimen(p, opts = {}) {
  const g = p.genome;
  const sp = g.species;
  const swatch = `<span class="swatch" style="background:${SPECIES_COLORS[sp]}"></span>`;
  const chaseBtn = opts.isLive
    ? `<button class="btn-chase ${opts.chasing ? 'active' : ''}">${opts.chasing ? 'Stop chasing' : 'Chase'}</button>`
    : '';
  const brainSlots = g.brain ? g.brain.enabledCount() : 0;
  const signalDot = p.signalR != null
    ? `<span class="signal-dot" style="background:rgb(${(p.signalR*255)|0},${(p.signalG*255)|0},${(p.signalB*255)|0})" title="evolved visual signal"></span>`
    : '';
  const bars = (vec, range = 1) => {
    let html = '<div class="bars">';
    for (let i = 0; i < vec.length; i++) {
      const v = vec[i];
      const w = Math.min(1, Math.abs(v) / range);
      const cls = v < 0 ? 'fill neg' : 'fill';
      const bg = i < SPECIES_COLORS.length ? SPECIES_COLORS[i] : '#56c2e6';
      html += `<div class="bar" title="${v.toFixed(2)}">
        <div class="${cls}" style="width:${(w * 50).toFixed(1)}%; background:${bg}"></div>
      </div>`;
    }
    html += '</div>';
    return html;
  };
  return `
    <button class="close" aria-label="close">×</button>
    <div class="title">${swatch}<strong>${SPECIES_NAMES[sp]}</strong> &middot; #${p.id}${signalDot}</div>
    <div class="row-pair">age <span>${p.age}</span></div>
    <div class="row-pair">energy <span>${p.energy.toFixed(2)}</span></div>
    <div class="row-pair">lineage <span>${p.lineage}</span></div>
    <div class="row-pair">brain slots <span>${brainSlots} / 8</span></div>
    <div class="row-pair">wall carry <span>${(p.wallCarry || 0)} / 5</span></div>
    ${chaseBtn ? `<div class="specimen-actions">${chaseBtn}</div>` : ''}
    <h3>attraction → species</h3>
    ${bars(Array.from(g.attraction), 1)}
    ${g.prey_preference ? `<h3>prey preference → species</h3>${bars(Array.from(g.prey_preference), 1)}` : ''}
    <h3>chemistry sense (food, decay)</h3>
    ${bars(Array.from(g.sense), 2.5)}
    <div class="row-pair">cohesion <span>${g.cohesion.toFixed(2)}</span></div>
    <div class="row-pair">metab <span>${g.metab.toFixed(3)}</span></div>
    <div class="row-pair">efficiency <span>${g.efficiency.toFixed(2)}</span></div>
    <div class="row-pair">repro thresh <span>${g.repro_thresh.toFixed(2)}</span></div>
    <div class="row-pair">mut rate <span>${g.mut_rate.toFixed(3)}</span></div>
    <div class="row-pair">sense radius <span>${g.sense_radius.toFixed(1)}</span></div>
    ${g.cluster_affinity != null ? `<div class="row-pair">cluster affinity <span>${(g.cluster_affinity).toFixed(2)}</span></div>` : ''}
    ${g.kin_aversion != null ? `<div class="row-pair">kin aversion <span>${(g.kin_aversion).toFixed(2)}</span></div>` : ''}
  `;
}
