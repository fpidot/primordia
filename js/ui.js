// ui.js — DOM controls, brush dispatch, specimen inspector, save/load.

import { W, H, CELL, WALL_SOLID, WALL_MEMBRANE, WALL_POROUS } from './sim.js';
import {
  SPECIES_COLORS, SPECIES_NAMES, NUM_SPECIES, NUM_CHEM, CHEM_NAMES,
  genomeToJSON, genomeFromJSON,
} from './genome.js';
import { PRESETS, PRESET_COUNTS } from './presets.js';

const STORAGE_KEY = 'primordia.world.v1';
const HELP_DOCS = {
  quick: { title: 'Primordia quick start', path: 'docs/QUICK_START.md' },
  particles: { title: "A naturalist's note on the particles", path: 'docs/PARTICLES_NATURALIST_NOTE.md' },
};

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
    this.curatedEl = document.getElementById('ui-curated');
    this.eventsEl = document.getElementById('ui-events');
    this.fossilsEl = document.getElementById('ui-fossils');
    this.complexityEl = document.getElementById('ui-complexity');
    this.helpModalEl = document.getElementById('help-modal');
    this.helpTitleEl = document.getElementById('help-modal-title');
    this.helpBodyEl = document.getElementById('help-modal-body');
    this.helpCloseEl = document.getElementById('help-modal-close');
    this.helpDocCache = new Map();
    this._matrixCtx = this.matrixCanvas.getContext('2d');
    this.bindMatrixHover();

    // Watchdog state
    this.watchdog = { enabled: false, interval: 2000, threshold: 0.25, lastFired: 0 };
    this.activePreset = 'soup';
    this.presetInitCount = PRESET_COUNTS.soup || 1800;

    this.bindPanelTabs();
    this.bindControls();
    this.bindHelpDocs();
    this.bindLivePanelLocks();
    this.bindBrushPalette();
    this.bindCanvas();
    this.populateSpawnSelect();
    this.refreshStats();
  }

  bindPanelTabs() {
    document.querySelectorAll('.sidebar').forEach(sidebar => {
      const tabs = [...sidebar.querySelectorAll('[data-panel-tab]')];
      if (!tabs.length) return;
      const setPanel = (panel) => {
        sidebar.dataset.activePanel = panel;
        tabs.forEach(btn => {
          const active = btn.dataset.panelTab === panel;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        if (panel === 'data') {
          this.chart.draw();
          this.updateMatrix();
        }
      };
      tabs.forEach(btn => {
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', btn.classList.contains('active') ? 'true' : 'false');
        btn.addEventListener('click', () => setPanel(btn.dataset.panelTab));
      });
      setPanel(sidebar.dataset.activePanel || tabs[0].dataset.panelTab);
    });
  }

  bindLivePanelLocks() {
    const lock = (el, prop, sigProp) => {
      if (!el) return;
      el.addEventListener('pointerenter', () => { this[prop] = true; });
      el.addEventListener('pointerleave', () => {
        this[prop] = false;
        this[sigProp] = null;
        this.refreshStats();
      });
    };
    lock(this.clustersEl, '_clustersPointerInside', '_lastClustersSig');
    lock(this.curatedEl, '_curatedPointerInside', '_lastCuratedSig');
  }

  bindHelpDocs() {
    if (!this.helpModalEl || !this.helpBodyEl || !this.helpTitleEl) return;
    document.querySelectorAll('[data-help-doc]').forEach(btn => {
      btn.addEventListener('click', () => this.openHelpDoc(btn.dataset.helpDoc));
    });
    if (this.helpCloseEl) {
      this.helpCloseEl.addEventListener('click', () => this.closeHelpDoc());
    }
    this.helpModalEl.addEventListener('click', (e) => {
      if (e.target === this.helpModalEl) this.closeHelpDoc();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.helpModalEl.classList.contains('hidden')) this.closeHelpDoc();
    });
  }

  async openHelpDoc(key) {
    const doc = HELP_DOCS[key];
    if (!doc || !this.helpModalEl || !this.helpBodyEl || !this.helpTitleEl) return;
    this.helpTitleEl.textContent = doc.title;
    this.helpBodyEl.innerHTML = '<p class="help-loading">Loading guide...</p>';
    this.helpModalEl.classList.remove('hidden');
    if (this.helpCloseEl) this.helpCloseEl.focus({ preventScroll: true });

    try {
      let markdown = this.helpDocCache.get(key);
      if (!markdown) {
        const res = await fetch(doc.path, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        markdown = await res.text();
        this.helpDocCache.set(key, markdown);
      }
      this.helpBodyEl.innerHTML = renderHelpMarkdown(markdown);
    } catch (err) {
      console.error('help doc failed', err);
      this.helpBodyEl.innerHTML = '<p class="help-error">This guide could not be loaded. Try refreshing the app.</p>';
    }
  }

  closeHelpDoc() {
    if (!this.helpModalEl) return;
    this.helpModalEl.classList.add('hidden');
  }

  applyPreset(name) {
    const fn = PRESETS[name];
    if (!fn) return;
    const count = Math.min(this.world.maxParticles || 5000, this.presetInitCount | 0);
    fn(this.world, count);
    this.activePreset = name;
    this.chart.data.length = 0;
    this._lastClustersSig = null;
    this._lastCuratedSig = null;
    this._lastCuratedTick = -9999;
    this.refreshStats();
    this.hideSpecimen();
    this.onPresetLoaded(name);
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
    const tryEnableAudio = async () => {
      const audio = window.__primordia?.audioHum;
      if (!audio || !audioEl.checked) return false;
      const ok = audio.enable();
      if (ok && audio.ctx?.state === 'suspended') {
        try { await audio.ctx.resume(); } catch {}
      }
      if (!ok) audioEl.checked = false;
      return ok;
    };
    const unlockAudio = () => { tryEnableAudio(); };
    audioEl.addEventListener('change', async () => {
      if (audioEl.checked) {
        await tryEnableAudio();
      } else {
        window.removeEventListener('pointerdown', unlockAudio);
        window.removeEventListener('keydown', unlockAudio);
        window.__primordia?.audioHum?.disable();
      }
    });
    if (audioEl.checked) {
      window.addEventListener('pointerdown', unlockAudio, { once: true });
      window.addEventListener('keydown', unlockAudio, { once: true });
    }
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

    const presetPop = document.getElementById('ui-preset-pop');
    const presetPopVal = document.getElementById('ui-preset-pop-val');
    if (presetPop && presetPopVal) {
      presetPop.max = String(this.world.maxParticles || 5000);
      presetPop.value = String(Math.min(this.world.maxParticles || 5000, this.presetInitCount));
      presetPopVal.textContent = presetPop.value;
      presetPop.addEventListener('input', () => {
        this.presetInitCount = Math.max(0, parseInt(presetPop.value, 10) || 0);
        presetPopVal.textContent = String(this.presetInitCount);
      });
    }

    document.querySelectorAll('[data-preset]').forEach(btn => {
      const name = btn.dataset.preset;
      btn.addEventListener('click', () => {
        this.applyPreset(name);
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
      this.applyPreset(this.activePreset || 'soup');
    });
    document.getElementById('btn-save').addEventListener('click', () => this.save());
    document.getElementById('btn-load').addEventListener('click', () => this.load());
    document.getElementById('btn-export').addEventListener('click', () => this.exportFile());
    const exportTemplateBtn = document.getElementById('btn-export-template');
    if (exportTemplateBtn) exportTemplateBtn.addEventListener('click', () => this.exportWorldTemplate());
    const importTemplateBtn = document.getElementById('btn-import-template');
    const importTemplateFile = document.getElementById('file-import-template');
    if (importTemplateBtn && importTemplateFile) {
      importTemplateBtn.addEventListener('click', () => importTemplateFile.click());
      importTemplateFile.addEventListener('change', () => {
        const file = importTemplateFile.files && importTemplateFile.files[0];
        if (file) this.importWorldTemplateFile(file);
        importTemplateFile.value = '';
      });
    }
    const importSpecimenBtn = document.getElementById('btn-import-specimen');
    const importSpecimenFile = document.getElementById('file-import-specimen');
    if (importSpecimenBtn && importSpecimenFile) {
      importSpecimenBtn.addEventListener('click', () => importSpecimenFile.click());
      importSpecimenFile.addEventListener('change', () => {
        const file = importSpecimenFile.files && importSpecimenFile.files[0];
        if (file) this.importSpecimenFile(file);
        importSpecimenFile.value = '';
      });
    }
    const importCladeBtn = document.getElementById('btn-import-clade');
    const importCladeFile = document.getElementById('file-import-clade');
    if (importCladeBtn && importCladeFile) {
      importCladeBtn.addEventListener('click', () => importCladeFile.click());
      importCladeFile.addEventListener('change', () => {
        const file = importCladeFile.files && importCladeFile.files[0];
        if (file) this.importCladeFile(file);
        importCladeFile.value = '';
      });
    }
    const importClusterBtn = document.getElementById('btn-import-cluster');
    const importClusterFile = document.getElementById('file-import-cluster');
    if (importClusterBtn && importClusterFile) {
      importClusterBtn.addEventListener('click', () => importClusterFile.click());
      importClusterFile.addEventListener('change', () => {
        const file = importClusterFile.files && importClusterFile.files[0];
        if (file) this.importClusterFile(file);
        importClusterFile.value = '';
      });
    }

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
      // Middle/right button (or shift+left) → pan
      if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
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
        else {
          const gx = Math.max(0, Math.min(((w.x / CELL) | 0), (W / CELL) - 1));
          const gy = Math.max(0, Math.min(((w.y / CELL) | 0), (H / CELL) - 1));
          const wall = this.world.wallInfoAt(gx, gy);
          if (wall) this.showWallInfo(wall, w.cssX, w.cssY);
          else this.hideSpecimen();
        }
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

  isClusterChased(cluster) {
    if (!cluster || !this.camera.resolveChasedCluster) return false;
    const current = this.camera.resolveChasedCluster(this.world);
    if (!current) return false;
    if (current === cluster) return true;
    if (current.anchorId != null && cluster.anchorId != null && current.anchorId === cluster.anchorId) {
      return true;
    }
    const currentIds = new Set((current.members || []).map(m => m && m.id).filter(id => id != null));
    return (cluster.members || []).some(m => m && currentIds.has(m.id));
  }

  showSpecimen(p, cssX, cssY, opts = {}) {
    const el = this.specimenEl;
    el.classList.remove('hidden');
    const isLive = opts.live !== false && typeof p.id === 'number';
    const chasing = isLive && this.camera.followTarget === p;
    const cluster = isLive ? this.world._particleToCluster.get(p.id) : null;
    const chasingCluster = this.isClusterChased(cluster);
    el.innerHTML = renderSpecimen(p, {
      isLive,
      chasing,
      inCluster: !!cluster,
      chasingCluster,
    });
    this.positionCard(el, cssX, cssY);
    el.querySelector('.close').addEventListener('click', () => this.hideSpecimen());
    const chaseBtn = el.querySelector('.btn-chase');
    if (chaseBtn) {
      chaseBtn.addEventListener('click', () => {
        const stopRequested = chaseBtn.classList.contains('active');
        if (stopRequested) {
          this.camera.unfollow();
          chaseBtn.textContent = 'Chase';
          chaseBtn.classList.remove('active');
          const clusterBtn = el.querySelector('.btn-chase-cluster');
          if (clusterBtn) {
            clusterBtn.textContent = 'Chase cluster';
            clusterBtn.classList.remove('active');
          }
        } else {
          this.camera.follow(p);
          chaseBtn.textContent = 'Stop chasing';
          chaseBtn.classList.add('active');
          const clusterBtn = el.querySelector('.btn-chase-cluster');
          if (clusterBtn) {
            clusterBtn.textContent = 'Chase cluster';
            clusterBtn.classList.remove('active');
          }
        }
        this._lastClustersSig = null;
      });
    }
    const chaseClusterBtn = el.querySelector('.btn-chase-cluster');
    if (chaseClusterBtn && cluster) {
      chaseClusterBtn.addEventListener('click', () => {
        const stopRequested = chaseClusterBtn.classList.contains('active') || this.isClusterChased(cluster);
        if (stopRequested) {
          this.camera.unfollow();
          chaseClusterBtn.textContent = 'Chase cluster';
          chaseClusterBtn.classList.remove('active');
          const particleBtn = el.querySelector('.btn-chase');
          if (particleBtn) {
            particleBtn.textContent = 'Chase';
            particleBtn.classList.remove('active');
          }
        } else {
          const memberIds = (cluster.members || [])
            .filter(m => m && !m.dead)
            .slice(0, 8)
            .map(m => m.id);
          this.camera.zoom = Math.max(this.camera.zoom, 1.8);
          this.camera.followCluster(memberIds.length ? memberIds : [p.id]);
          chaseClusterBtn.textContent = 'Stop cluster';
          chaseClusterBtn.classList.add('active');
        }
        this._lastClustersSig = null;
      });
    }
    const duplicateBtn = el.querySelector('.btn-duplicate-specimen');
    if (duplicateBtn && isLive) {
      duplicateBtn.addEventListener('click', () => {
        const copy = this.duplicateSpecimen(p, p.x + 16, p.y + 16);
        if (copy) {
          duplicateBtn.textContent = 'Copied';
          setTimeout(() => { duplicateBtn.textContent = 'Copy'; }, 700);
        }
      });
    }
    const exportBtn = el.querySelector('.btn-export-specimen');
    if (exportBtn && isLive) {
      exportBtn.addEventListener('click', () => this.exportSpecimen(p));
    }
    const inspectClusterBtn = el.querySelector('.btn-inspect-cluster');
    if (inspectClusterBtn && cluster) {
      inspectClusterBtn.addEventListener('click', () => this.showClusterInfo(cluster, cssX, cssY));
    }
    this._inspected = p;
  }

  showClusterInfo(cluster, cssX, cssY) {
    if (!cluster) return;
    const el = this.specimenEl;
    el.classList.remove('hidden');
    const summary = this.clusterSummary(cluster);
    const chasing = this.isClusterChased(cluster);
    el.innerHTML = renderClusterInfo(cluster, summary, { chasing });
    this.positionCard(el, cssX, cssY);
    el.querySelector('.close').addEventListener('click', () => this.hideSpecimen());
    const chaseBtn = el.querySelector('.btn-chase-cluster');
    if (chaseBtn) {
      chaseBtn.addEventListener('click', () => {
        const current = (this.world._clusters || []).find(c => c.anchorId === cluster.anchorId) || cluster;
        const alreadyChasing = this.isClusterChased(current);
        if (alreadyChasing) {
          this.camera.unfollow();
        } else {
          const memberIds = (current.members || [])
            .filter(m => m && !m.dead)
            .slice(0, 8)
            .map(m => m.id);
          this.camera.zoom = Math.max(this.camera.zoom, 1.8);
          this.camera.followCluster(memberIds.length ? memberIds : [current.anchorId]);
        }
        this._lastClustersSig = null;
        this.showClusterInfo(current, cssX, cssY);
      });
    }
    const copyBtn = el.querySelector('.btn-duplicate-cluster');
    if (copyBtn) copyBtn.addEventListener('click', () => this.duplicateCluster(cluster));
    const exportBtn = el.querySelector('.btn-export-cluster');
    if (exportBtn) exportBtn.addEventListener('click', () => this.exportCluster(cluster));
    this._inspected = null;
    this._inspectedWall = null;
    this._inspectedCluster = cluster;
  }

  showWallInfo(info, cssX, cssY) {
    const el = this.specimenEl;
    el.classList.remove('hidden');

    const clade = info.cladeId ? this.world.clades.clades.get(info.cladeId) : null;
    el.innerHTML = renderWallInfo(info, clade);
    this.positionCard(el, cssX, cssY);
    el.querySelector('.close').addEventListener('click', () => this.hideSpecimen());
    this._inspected = null;
    this._inspectedCluster = null;
    this._inspectedWall = info;
  }

  positionCard(el, cssX, cssY) {
    const stageRect = this.stage.getBoundingClientRect();
    const margin = 10;
    const gap = 14;
    const w = Math.min(el.offsetWidth || 260, stageRect.width - margin * 2);
    const h = Math.min(el.offsetHeight || 220, stageRect.height - margin * 2);
    let left = cssX + gap;
    let top = cssY + gap;
    if (left + w + margin > stageRect.width) left = cssX - w - gap;
    if (top + h + margin > stageRect.height) top = cssY - h - gap;
    left = Math.max(margin, Math.min(left, stageRect.width - w - margin));
    top = Math.max(margin, Math.min(top, stageRect.height - h - margin));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  centerCameraOn(x, y, zoom = 2.5) {
    this.camera.unfollow();
    this.camera.x = x;
    this.camera.y = y;
    this.camera.zoom = Math.max(this.camera.zoom, zoom);
    this.camera.clamp();
  }

  viewCluster(cluster) {
    if (!cluster) return;
    this.hideSpecimen();
    this.centerCameraOn(cluster.cx, cluster.cy, 2.5);
    const stageRect = this.stage.getBoundingClientRect();
    this.showClusterInfo(cluster, stageRect.width * 0.5, stageRect.height * 0.5);
    this._lastClustersSig = null;
  }

  viewSpecimen(p) {
    if (!p || p.dead) return;
    this.centerCameraOn(p.x, p.y, 2.5);
    const stageRect = this.stage.getBoundingClientRect();
    this.showSpecimen(p, stageRect.width * 0.5, stageRect.height * 0.5);
  }

  hideSpecimen() {
    this.specimenEl.classList.add('hidden');
    this._inspected = null;
    this._inspectedWall = null;
    this._inspectedCluster = null;
  }

  clusterSummary(cluster) {
    const members = (cluster.members || []).filter(p => p && !p.dead);
    const memberIds = new Set(members.map(p => p.id));
    const n = Math.max(1, members.length);
    let energy = 0, minEnergy = Infinity, age = 0, slots = 0;
    let wallDigs = 0, wallDeposits = 0, wallCarry = 0;
    let aggression = 0, signal = 0, sound = 0, bondSignal = 0;
    let internalBonds = 0;
    const speciesCounts = new Array(NUM_SPECIES).fill(0);
    const cladeCounts = new Map();
    for (const p of members) {
      const e = p.energy || 0;
      energy += e;
      if (e < minEnergy) minEnergy = e;
      age += p.age || 0;
      slots += p.genome && p.genome.brain ? p.genome.brain.enabledCount() : 0;
      wallDigs += p.wallDigs || 0;
      wallDeposits += p.wallDeposits || 0;
      wallCarry += p.wallCarry || 0;
      aggression += p.predationGain || 0;
      signal += ((p.signalR || 0) + (p.signalG || 0) + (p.signalB || 0)) / 3;
      sound += p.soundAmp || 0;
      bondSignal += (
        Math.abs((p.bondMsgR || 0.5) - 0.5) +
        Math.abs((p.bondMsgG || 0.5) - 0.5) +
        Math.abs((p.bondMsgB || 0.5) - 0.5)
      ) / 3;
      if (p.species >= 0 && p.species < NUM_SPECIES) speciesCounts[p.species]++;
      if (p.cladeId != null) cladeCounts.set(p.cladeId, (cladeCounts.get(p.cladeId) || 0) + 1);
      for (const id of (p.bonds || [])) if (id > p.id && memberIds.has(id)) internalBonds++;
    }
    let dominantSpecies = 0, dominantSpeciesCount = 0;
    for (let i = 0; i < speciesCounts.length; i++) {
      if (speciesCounts[i] > dominantSpeciesCount) {
        dominantSpecies = i;
        dominantSpeciesCount = speciesCounts[i];
      }
    }
    let dominantClade = null, dominantCladeCount = 0;
    for (const [id, count] of cladeCounts) {
      if (count > dominantCladeCount) {
        dominantClade = this.world.clades.clades.get(id) || { id };
        dominantCladeCount = count;
      }
    }
    return {
      liveCount: members.length,
      meanEnergy: energy / n,
      minEnergy: minEnergy === Infinity ? 0 : minEnergy,
      meanAge: age / n,
      meanSlots: slots / n,
      wallDigs,
      wallDeposits,
      wallCarry,
      meanAggression: aggression / n,
      meanSignal: signal / n,
      meanSound: sound / n,
      meanBondSignal: bondSignal / n,
      internalBonds,
      meanDegree: internalBonds * 2 / n,
      bondFill: (internalBonds * 2 / n) / 4,
      dominantSpecies,
      dominantSpeciesCount,
      dominantClade,
      dominantCladeCount,
      compactness: members.length / Math.max(8, cluster.spread || cluster.radius || 8),
    };
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
        const dDig = this.world.totalWallDigs - (this._lastVitals.wallDigs || 0);
        const dBuild = this.world.totalWallDeposits - (this._lastVitals.wallDeposits || 0);
        // exponential smoothing to keep the readout stable
        const alpha = 0.3;
        this._deathRate = (this._deathRate || 0) * (1 - alpha) + (dDied / dt) * alpha;
        this._birthRate = (this._birthRate || 0) * (1 - alpha) + (dBorn / dt) * alpha;
        this._digRate = (this._digRate || 0) * (1 - alpha) + (dDig / dt) * alpha;
        this._buildRate = (this._buildRate || 0) * (1 - alpha) + (dBuild / dt) * alpha;
        this._lastVitals = {
          t: now,
          died: this.world.totalDied,
          born: this.world.totalBorn,
          wallDigs: this.world.totalWallDigs,
          wallDeposits: this.world.totalWallDeposits,
        };
      }
    } else {
      this._lastVitals = {
        t: now,
        died: this.world.totalDied,
        born: this.world.totalBorn,
        wallDigs: this.world.totalWallDigs,
        wallDeposits: this.world.totalWallDeposits,
      };
      this._deathRate = 0;
      this._birthRate = 0;
      this._digRate = 0;
      this._buildRate = 0;
    }
    const lowPct = (v.lowFrac * 100).toFixed(0);
    const shelteredPct = (v.shelteredFrac * 100).toFixed(0);
    const energyClass = v.meanEnergy < 2 ? 'warn' : '';
    html += `<div class="row-stat vitals-divider"><span></span><span class="vitals-head">vitals</span><span></span></div>`;
    html += `<div class="row-stat"><span></span><span>mean E</span><span class="num ${energyClass}">${v.meanEnergy.toFixed(2)}</span></div>`;
    html += `<div class="row-stat"><span></span><span>low E (&lt;1)</span><span class="num">${lowPct}%</span></div>`;
    html += `<div class="row-stat"><span></span><span>mean food</span><span class="num">${v.meanFood.toFixed(3)}</span></div>`;
    html += `<div class="row-stat"><span></span><span>mean decay</span><span class="num">${v.meanDecay.toFixed(3)}</span></div>`;
    html += `<div class="row-stat"><span></span><span>walls</span><span class="num">${v.walls}</span></div>`;
    html += `<div class="row-stat"><span></span><span>carrying</span><span class="num">${v.wallCarriers}</span></div>`;
    html += `<div class="row-stat"><span></span><span>dig / build</span><span class="num">${v.wallDigs}/${v.wallDeposits}</span></div>`;
    html += `<div class="row-stat"><span></span><span>shelter</span><span class="num">${v.meanShelter.toFixed(3)} · ${shelteredPct}%</span></div>`;
    html += `<div class="row-stat"><span></span><span>births/s</span><span class="num">${(this._birthRate || 0).toFixed(1)}</span></div>`;
    html += `<div class="row-stat"><span></span><span>deaths/s</span><span class="num">${(this._deathRate || 0).toFixed(1)}</span></div>`;
    html += `<div class="row-stat"><span></span><span>dig/build/s</span><span class="num">${(this._digRate || 0).toFixed(1)}/${(this._buildRate || 0).toFixed(1)}</span></div>`;

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
    this.updateCurated();
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
    if (this._clustersPointerInside && this._lastClustersSig != null) return;
    this._lastClustersSig = sigKey;

    if (showCount === 0) {
      this.clustersEl.innerHTML = '<div class="hint-text">no bonded clusters yet · let the soup settle</div>';
      return;
    }
    let html = '';
    for (let i = 0; i < showCount; i++) {
      const c = clusters[i];
      const col = SPECIES_COLORS[c.species] || '#fff';
      const chasing = this.isClusterChased(c);
      html += `<div class="cluster-row ${chasing ? 'chasing' : ''}" data-anchor="${c.anchorId}">
        <span class="swatch" style="background:${col}"></span>
        <span class="name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
        <span class="pop">${c.count}</span>
        <button class="btn-mini btn-zoom" data-act="zoom">zoom</button>
        <button class="btn-mini btn-chase ${chasing ? 'active' : ''}" data-act="chase">${chasing ? '×' : 'chase'}</button>
        <button class="btn-mini" data-act="copy">copy</button>
        <button class="btn-mini" data-act="export">export</button>
      </div>`;
    }
    this.clustersEl.innerHTML = html;
    this.clustersEl.querySelectorAll('.cluster-row').forEach(row => {
      const anchor = parseInt(row.dataset.anchor);
      row.querySelector('[data-act="zoom"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const c = (this.world._clusters || []).find(c => c.anchorId === anchor);
        this.viewCluster(c);
      });
      row.querySelector('[data-act="chase"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const cluster = (this.world._clusters || []).find(c => c.anchorId === anchor);
        if (!cluster) return;
        const alreadyChasing = this.isClusterChased(cluster);
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
        const btn = e.currentTarget;
        btn.classList.toggle('active', !alreadyChasing);
        btn.textContent = alreadyChasing ? 'chase' : '×';
        row.classList.toggle('chasing', !alreadyChasing);
        this._lastClustersSig = null;  // force re-render so chasing state updates
      });
      row.querySelector('[data-act="copy"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const cluster = (this.world._clusters || []).find(c => c.anchorId === anchor);
        if (cluster) this.duplicateCluster(cluster);
      });
      row.querySelector('[data-act="export"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const cluster = (this.world._clusters || []).find(c => c.anchorId === anchor);
        if (cluster) this.exportCluster(cluster);
      });
    });
  }

  updateCurated() {
    if (!this.curatedEl) return;
    const clusters = this.world._clusters || [];
    const clusterSig = clusters.slice(0, 8)
      .map(c => `${c.anchorId}:${c.count}:${Math.round(c.spread || 0)}`)
      .join('|');
    const liveSig = `${this.world.particles.length}:${clusterSig}`;
    if (this._curatedPointerInside && this._lastCuratedSig != null) return;
    if (this.world.tick - (this._lastCuratedTick || -9999) < 24 &&
        this._lastCuratedSig === liveSig) {
      return;
    }
    this._lastCuratedTick = this.world.tick;
    this._lastCuratedSig = liveSig;

    const live = this.world.particles.filter(p => !p.dead);
    if (!live.length && !clusters.length) {
      this.curatedEl.innerHTML = '<div class="hint-text">no living specimens or clusters</div>';
      return;
    }
    const pick = (label, scoreFn, fmtFn) => {
      let best = null, bestScore = -Infinity;
      for (const p of live) {
        const score = scoreFn(p);
        if (Number.isFinite(score) && score > bestScore) {
          best = p;
          bestScore = score;
        }
      }
      return best ? { label, p: best, score: bestScore, value: fmtFn(best, bestScore) } : null;
    };
    const particleRows = [
      pick('fittest', p => p.energy + Math.min(20, p.age / 100), p => `E ${p.energy.toFixed(1)} · age ${p.age}`),
      pick('builder', p => (p.wallDigs || 0) + (p.wallDeposits || 0), p => `${p.wallDigs || 0}/${p.wallDeposits || 0}`),
      pick('brain', p => p.genome.brain ? p.genome.brain.enabledCount() : 0, p => `${p.genome.brain.enabledCount()} slots`),
      pick('aggressive', p => Math.max(0, p.predationGain || 0), p => `${(p.predationGain || 0).toFixed(2)}`),
      pick('communicator', p => {
        const sig = ((p.signalR || 0) + (p.signalG || 0) + (p.signalB || 0)) / 3;
        const bond = Math.max(
          Math.abs((p.bondMsgR || 0.5) - 0.5),
          Math.abs((p.bondMsgG || 0.5) - 0.5),
          Math.abs((p.bondMsgB || 0.5) - 0.5));
        return Math.max(0, sig - 0.5) + Math.max(0, (p.soundAmp || 0) - 0.5) + bond;
      }, p => `sig ${(((p.signalR || 0) + (p.signalG || 0) + (p.signalB || 0)) / 3).toFixed(2)}`),
    ].filter(Boolean);
    const clusterStats = (c) => {
      const ms = (c.members || []).filter(p => p && !p.dead);
      const n = Math.max(1, ms.length);
      let slots = 0, walls = 0, aggression = 0, energy = 0;
      for (const p of ms) {
        slots += p.genome && p.genome.brain ? p.genome.brain.enabledCount() : 0;
        walls += (p.wallDigs || 0) + (p.wallDeposits || 0);
        aggression += p.predationGain || 0;
        energy += p.energy || 0;
      }
      return {
        n,
        meanSlots: slots / n,
        wallActions: walls,
        wallPerMember: walls / n,
        aggression,
        aggressionPerMember: aggression / n,
        meanEnergy: energy / n,
        compactness: n / Math.max(8, c.spread || c.radius || 8),
      };
    };
    const pickCluster = (label, scoreFn, fmtFn) => {
      let best = null, bestScore = -Infinity, bestStats = null;
      for (const c of clusters) {
        const stats = clusterStats(c);
        const score = scoreFn(c, stats);
        if (Number.isFinite(score) && score > bestScore) {
          best = c;
          bestScore = score;
          bestStats = stats;
        }
      }
      return best ? { label, cluster: best, score: bestScore, value: fmtFn(best, bestStats) } : null;
    };
    const clusterRows = [
      pickCluster('stable cluster', (c, s) => s.compactness + Math.min(2, s.meanEnergy / 20), (c, s) => `${c.count} · compact ${s.compactness.toFixed(2)}`),
      pickCluster('builder cluster', (c, s) => s.wallActions, (c, s) => `${s.wallActions} wall`),
      pickCluster('brain cluster', (c, s) => s.meanSlots, (c, s) => `${s.meanSlots.toFixed(1)} slots`),
      pickCluster('fighter cluster', (c, s) => s.aggressionPerMember, (c, s) => `${s.aggression.toFixed(1)} pred`),
    ].filter(Boolean);

    let html = '';
    for (const row of particleRows) {
      const p = row.p;
      const col = SPECIES_COLORS[p.species] || '#fff';
      html += `<div class="curated-row" data-kind="particle" data-id="${p.id}">
        <span class="swatch" style="background:${col}"></span>
        <span class="label">${escapeHtml(row.label)}</span>
        <span class="who">#${p.id}</span>
        <span class="metric">${escapeHtml(row.value)}</span>
        <button class="btn-mini" data-act="inspect">view</button>
        <button class="btn-mini" data-act="copy">copy</button>
        <button class="btn-mini" data-act="export">export</button>
      </div>`;
    }
    for (const row of clusterRows) {
      const c = row.cluster;
      const col = SPECIES_COLORS[c.species] || '#fff';
      html += `<div class="curated-row cluster-pick" data-kind="cluster" data-anchor="${c.anchorId}">
        <span class="swatch" style="background:${col}"></span>
        <span class="label" title="${escapeHtml(c.name)}">${escapeHtml(row.label)}</span>
        <span class="who">${escapeHtml(c.name)}</span>
        <span class="metric">${escapeHtml(row.value)}</span>
        <button class="btn-mini" data-act="inspect">view</button>
        <button class="btn-mini" data-act="copy">copy</button>
        <button class="btn-mini" data-act="export">export</button>
      </div>`;
    }
    this.curatedEl.innerHTML = html;
    this.curatedEl.querySelectorAll('.curated-row').forEach(row => {
      row.querySelector('[data-act="inspect"]').addEventListener('click', () => {
        if (row.dataset.kind === 'cluster') {
          const anchor = parseInt(row.dataset.anchor);
          const c = (this.world._clusters || []).find(c => c.anchorId === anchor);
          this.viewCluster(c);
          return;
        }
        const id = parseInt(row.dataset.id);
        const p = this.world.particles.find(p => p.id === id && !p.dead);
        this.viewSpecimen(p);
      });
      row.querySelector('[data-act="copy"]').addEventListener('click', () => {
        if (row.dataset.kind === 'cluster') {
          const anchor = parseInt(row.dataset.anchor);
          const c = (this.world._clusters || []).find(c => c.anchorId === anchor);
          if (c) this.duplicateCluster(c);
          return;
        }
        const id = parseInt(row.dataset.id);
        const p = this.world.particles.find(p => p.id === id && !p.dead);
        if (p) this.duplicateSpecimen(p);
      });
      row.querySelector('[data-act="export"]').addEventListener('click', () => {
        if (row.dataset.kind === 'cluster') {
          const anchor = parseInt(row.dataset.anchor);
          const c = (this.world._clusters || []).find(c => c.anchorId === anchor);
          if (c) this.exportCluster(c);
          return;
        }
        const id = parseInt(row.dataset.id);
        const p = this.world.particles.find(p => p.id === id && !p.dead);
        if (!p) return;
        this.exportSpecimen(p);
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
      ['build',     c.components.construction || 0,
        `${c.raw.wallActions || 0} actions · ${((c.raw.wallActionRate || 0) * 1000).toFixed(2)}/kpt`],
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
      fn(this.world, Math.min(this.world.maxParticles || 5000, this.presetInitCount | 0));
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
          <button class="btn-mini" data-act="copy">copy</button>
          <button class="btn-mini" data-act="export">export</button>
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
      row.querySelector('[data-act="copy"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(row.dataset.clade);
        const cl = this.world.clades.clades.get(id);
        if (cl) this.duplicateClade(cl);
      });
      row.querySelector('[data-act="export"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(row.dataset.clade);
        const cl = this.world.clades.clades.get(id);
        if (cl) this.exportClade(cl);
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
    const used = w._gpuTicksUsed || 0;
    const fallback = w._gpuTicksFallback || 0;
    const pending = w._gpuPendings ? w._gpuPendings.length : 0;
    const cool = w._gpuCooldownTicks > 0 ? ` · cool ${w._gpuCooldownTicks}` : '';
    this._gpuStatusEl.textContent =
      `active · ${k.dispatchCount} dispatches · ` +
      `up ${upMs}ms · disp ${k.lastDispatchMs.toFixed(2)}ms · ` +
      `read ${k.lastReadbackMs.toFixed(2)}ms · ` +
      `used ${used}/${used + fallback} · pend ${pending}${cool}${err}`;
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
      this.downloadJSON(data, `primordia-tick${this.world.tick}.json`);
    } catch (err) {
      console.error('export failed', err);
    }
  }

  exportWorldTemplate() {
    try {
      const data = this.world.toWorldTemplateJSON();
      this.downloadJSON(data, `primordia-terrain-t${this.world.tick}.json`);
      this.flashButton('btn-export-template', 'Exported');
    } catch (err) {
      console.error('terrain export failed', err);
      this.flashButton('btn-export-template', 'Export failed');
    }
  }

  async importWorldTemplateFile(file) {
    try {
      const data = JSON.parse(await file.text());
      this.world.fromWorldTemplateJSON(data);
      this.chart.data.length = 0;
      this._lastClustersSig = null;
      this._lastCuratedTick = -9999;
      this.refreshStats();
      this.hideSpecimen();
      this.flashButton('btn-import-template', 'Imported');
    } catch (err) {
      console.error('terrain import failed', err);
      this.flashButton('btn-import-template', 'Import failed');
    }
  }

  exportClade(clade) {
    const tags = this.world.clades.classifyClade(clade).map(t => t.name);
    const payload = {
      kind: 'primordia.clade.v1',
      exportedAtTick: this.world.tick,
      clade: {
        id: clade.id,
        name: clade.name,
        species: clade.species,
        speciesName: SPECIES_NAMES[clade.species] || `species ${clade.species}`,
        foundedTick: clade.foundedTick,
        age: this.world.tick - clade.foundedTick,
        aliveCount: clade.aliveCount,
        peakCount: clade.peakCount,
        totalEverBorn: clade.totalEverBorn,
        tags,
        founderGenome: genomeToJSON(clade.founderGenome),
        meanGenome: genomeToJSON(clade.meanGenome || clade.founderGenome),
      },
    };
    this.downloadJSON(payload, `primordia-clade-${safeFilename(clade.name || clade.id)}-t${this.world.tick}.json`);
  }

  duplicateClade(clade, count = 16) {
    if (!clade) return 0;
    const template = {
      id: clade.id,
      name: clade.name,
      meanGenome: genomeToJSON(clade.meanGenome || clade.founderGenome),
    };
    return this.spawnCladeTemplate(template, this.camera.x, this.camera.y, count, null);
  }

  spawnCladeTemplate(template, x = this.camera.x, y = this.camera.y, count = 16, flashId = 'btn-import-clade') {
    const genomeJSON = template && (template.meanGenome || template.founderGenome || template.genome);
    if (!genomeJSON) {
      if (flashId) this.flashButton(flashId, 'Bad file');
      return 0;
    }
    const genomeTemplate = genomeFromJSON(genomeJSON);
    const parentId = template.parentId || template.id || null;
    const newClade = this.world.clades.newClade(genomeTemplate, parentId, this.world.tick);
    if (template.name) newClade.name = `${template.name}-copy`;
    const baseX = clamp(x, 24, W - 24);
    const baseY = clamp(y, 24, H - 24);
    let made = 0;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.2;
      const r = 8 + Math.sqrt(i + 1) * 5;
      const p = this.world.addParticle(
        clamp(baseX + Math.cos(a) * r, 2, W - 2),
        clamp(baseY + Math.sin(a) * r, 2, H - 2),
        genomeFromJSON(genomeToJSON(genomeTemplate)),
        5 + Math.random() * 2,
        newClade);
      if (p) made++;
    }
    this.world._clustersTick = -10000;
    this._lastCuratedTick = -9999;
    this.refreshStats();
    if (flashId) this.flashButton(flashId, `Imported ${made}`);
    return made;
  }

  exportSpecimen(p) {
    this.downloadJSON(this.specimenPayload(p), `primordia-specimen-${p.id}-t${this.world.tick}.json`);
  }

  specimenPayload(p) {
    return {
      kind: 'primordia.specimen.v1',
      exportedAtTick: this.world.tick,
      particle: {
        id: p.id,
        species: p.species,
        age: p.age,
        energy: p.energy,
        cladeId: p.cladeId,
        lineage: p.lineage,
        wallCarry: p.wallCarry || 0,
        wallDigs: p.wallDigs || 0,
        wallDeposits: p.wallDeposits || 0,
        genome: genomeToJSON(p.genome),
      },
    };
  }

  exportCluster(cluster) {
    const payload = {
      kind: 'primordia.cluster.v1',
      exportedAtTick: this.world.tick,
      cluster: this.clusterTemplate(cluster),
    };
    const name = safeFilename(cluster.name || `cluster-${cluster.anchorId || 'x'}`);
    this.downloadJSON(payload, `primordia-cluster-${name}-t${this.world.tick}.json`);
  }

  clusterTemplate(cluster) {
    const members = (cluster.members || [])
      .filter(p => p && !p.dead)
      .slice()
      .sort((a, b) => a.id - b.id);
    const memberIds = new Set(members.map(p => p.id));
    let energy = 0, wallDigs = 0, wallDeposits = 0, predationGain = 0, brainSlots = 0;
    let signal = 0, sound = 0, bondSignal = 0;
    let internalBonds = 0;
    for (const p of members) {
      energy += p.energy || 0;
      wallDigs += p.wallDigs || 0;
      wallDeposits += p.wallDeposits || 0;
      predationGain += p.predationGain || 0;
      brainSlots += p.genome && p.genome.brain ? p.genome.brain.enabledCount() : 0;
      signal += ((p.signalR || 0) + (p.signalG || 0) + (p.signalB || 0)) / 3;
      sound += p.soundAmp || 0;
      bondSignal += (
        Math.abs((p.bondMsgR || 0.5) - 0.5) +
        Math.abs((p.bondMsgG || 0.5) - 0.5) +
        Math.abs((p.bondMsgB || 0.5) - 0.5)
      ) / 3;
      for (const id of (p.bonds || [])) if (id > p.id && memberIds.has(id)) internalBonds++;
    }
    const n = Math.max(1, members.length);
    const meanDegree = internalBonds * 2 / n;
    return {
      name: cluster.name,
      baseName: cluster.baseName || cluster.name,
      anchorId: cluster.anchorId,
      count: members.length,
      species: cluster.species,
      radius: cluster.radius,
      spread: cluster.spread,
      center: { x: cluster.cx, y: cluster.cy },
      stats: {
        meanEnergy: energy / n,
        meanBrainSlots: brainSlots / n,
        wallDigs,
        wallDeposits,
        predationGain,
        meanSignal: signal / n,
        meanSound: sound / n,
        meanBondSignal: bondSignal / n,
        internalBonds,
        meanDegree,
        bondFill: meanDegree / 4,
      },
      members: members.map(p => ({
        id: p.id,
        species: p.species,
        age: p.age,
        energy: p.energy,
        cladeId: p.cladeId,
        lineage: p.lineage,
        dx: p.x - cluster.cx,
        dy: p.y - cluster.cy,
        wallCarry: p.wallCarry || 0,
        wallDigs: p.wallDigs || 0,
        wallDeposits: p.wallDeposits || 0,
        bonds: (p.bonds || []).filter(id => memberIds.has(id)),
        genome: genomeToJSON(p.genome),
      })),
    };
  }

  duplicateSpecimen(p, x = this.camera.x, y = this.camera.y) {
    if (!p || !p.genome) return null;
    const clade = p.cladeId ? this.world.clades.clades.get(p.cladeId) : null;
    const genome = genomeFromJSON(genomeToJSON(p.genome));
    const energy = Math.max(3, Math.min(18, Number.isFinite(p.energy) ? p.energy : 6));
    const copy = this.world.addParticle(
      clamp(x + (Math.random() - 0.5) * 10, 2, W - 2),
      clamp(y + (Math.random() - 0.5) * 10, 2, H - 2),
      genome,
      energy,
      clade);
    if (!copy) return null;
    copy.wallCarry = clamp(p.wallCarry || 0, 0, 5) | 0;
    this.world._clustersTick = -10000;
    this.world.updateClusters();
    this._lastClustersSig = null;
    this._lastCuratedTick = -9999;
    this.refreshStats();
    return copy;
  }

  duplicateCluster(cluster) {
    if (!cluster) return 0;
    const offset = Math.max(48, (cluster.radius || 24) * 1.8);
    const x = clamp((cluster.cx || this.camera.x) + offset, 24, W - 24);
    const y = clamp((cluster.cy || this.camera.y) + offset * 0.35, 24, H - 24);
    return this.spawnClusterTemplate(this.clusterTemplate(cluster), x, y, 'btn-import-cluster');
  }

  spawnSpecimenTemplate(specimen, x = this.camera.x, y = this.camera.y, flashId = 'btn-import-specimen') {
    const src = specimen && specimen.particle ? specimen.particle : specimen;
    if (!src || !src.genome) {
      if (flashId) this.flashButton(flashId, 'Bad file');
      return null;
    }
    const genome = genomeFromJSON(src.genome);
    const clade = this.world.clades.newClade(genome, null, this.world.tick);
    const energy = Math.max(3, Math.min(18, Number.isFinite(src.energy) ? src.energy : 6));
    const p = this.world.addParticle(clamp(x, 2, W - 2), clamp(y, 2, H - 2), genomeFromJSON(src.genome), energy, clade);
    if (!p) {
      if (flashId) this.flashButton(flashId, 'World full');
      return null;
    }
    p.wallCarry = clamp(src.wallCarry || 0, 0, 5) | 0;
    this.world._clustersTick = -10000;
    this._lastCuratedTick = -9999;
    this.refreshStats();
    if (flashId) this.flashButton(flashId, 'Imported 1');
    return p;
  }

  async importClusterFile(file) {
    try {
      const data = JSON.parse(await file.text());
      const cluster = data && data.kind === 'primordia.cluster.v1' ? data.cluster : data;
      this.spawnClusterTemplate(cluster, this.camera.x, this.camera.y, 'btn-import-cluster');
    } catch (err) {
      console.error('cluster import failed', err);
      this.flashButton('btn-import-cluster', 'Import failed');
    }
  }

  async importSpecimenFile(file) {
    try {
      const data = JSON.parse(await file.text());
      const specimen = data && data.kind === 'primordia.specimen.v1' ? data.particle : data;
      this.spawnSpecimenTemplate(specimen, this.camera.x, this.camera.y, 'btn-import-specimen');
    } catch (err) {
      console.error('specimen import failed', err);
      this.flashButton('btn-import-specimen', 'Import failed');
    }
  }

  async importCladeFile(file) {
    try {
      const data = JSON.parse(await file.text());
      const clade = data && data.kind === 'primordia.clade.v1' ? data.clade : data;
      this.spawnCladeTemplate(clade, this.camera.x, this.camera.y, 16, 'btn-import-clade');
    } catch (err) {
      console.error('clade import failed', err);
      this.flashButton('btn-import-clade', 'Import failed');
    }
  }

  spawnClusterTemplate(cluster, x = this.camera.x, y = this.camera.y, flashId = 'btn-import-cluster') {
    const members = cluster && Array.isArray(cluster.members) ? cluster.members : [];
    if (!members.length) {
      if (flashId) this.flashButton(flashId, 'Bad file');
      return 0;
    }
    const firstGenome = genomeFromJSON(members[0].genome);
    const clade = this.world.clades.newClade(firstGenome, null, this.world.tick);
    if (cluster.name) clade.name = `${cluster.name}-copy`;
    const baseX = clamp(x, 24, W - 24);
    const baseY = clamp(y, 24, H - 24);
    const oldToNew = new Map();
    for (const m of members) {
      if (!m || !m.genome) continue;
      const genome = genomeFromJSON(m.genome);
      const px = clamp(baseX + (m.dx || 0), 2, W - 2);
      const py = clamp(baseY + (m.dy || 0), 2, H - 2);
      const energy = Math.max(3, Math.min(18, Number.isFinite(m.energy) ? m.energy : 6));
      const p = this.world.addParticle(px, py, genome, energy, clade);
      if (!p) break;
      p.wallCarry = clamp(m.wallCarry || 0, 0, 5) | 0;
      oldToNew.set(m.id, p);
    }
    for (const m of members) {
      const p = oldToNew.get(m.id);
      if (!p || !Array.isArray(m.bonds)) continue;
      for (const oldBondId of m.bonds) {
        const q = oldToNew.get(oldBondId);
        if (!q || q === p) continue;
        if (p.bonds.length < 4 && !p.bonds.includes(q.id)) p.bonds.push(q.id);
        if (q.bonds.length < 4 && !q.bonds.includes(p.id)) q.bonds.push(p.id);
      }
    }
    this.world._clustersTick = -10000;
    this.world.updateClusters();
    this._lastClustersSig = null;
    this._lastCuratedTick = -9999;
    this.refreshStats();
    if (flashId) this.flashButton(flashId, `Copied ${oldToNew.size}`);
    return oldToNew.size;
  }

  downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
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

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function renderHelpMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const intro = [];
  const sections = [];
  let current = null;
  let skippedTitle = false;

  for (const line of lines) {
    if (!skippedTitle && /^#\s+/.test(line)) {
      skippedTitle = true;
      continue;
    }
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      current = { title: h2[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    (current ? current.lines : intro).push(line);
  }

  const introHtml = renderMarkdownBlocks(intro);
  const sectionHtml = sections.map((section, i) => `
    <details class="help-section" ${i === 0 ? 'open' : ''}>
      <summary>${renderInlineMarkdown(section.title)}</summary>
      <div class="help-section-body">${renderMarkdownBlocks(section.lines)}</div>
    </details>`).join('');
  return `<div class="help-doc">${introHtml}${sectionHtml}</div>`;
}

function renderMarkdownBlocks(rawLines) {
  const lines = mergeMarkdownListContinuations(rawLines);
  let html = '';
  let paragraph = [];
  let inList = false;
  let inCode = false;
  let codeLines = [];

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html += `<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`;
    paragraph = [];
  };
  const closeList = () => {
    if (!inList) return;
    html += '</ul>';
    inList = false;
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        html += `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
        codeLines = [];
        inCode = false;
      } else {
        closeParagraph();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeParagraph();
      closeList();
      continue;
    }

    const subhead = line.match(/^###\s+(.+)/);
    if (subhead) {
      closeParagraph();
      closeList();
      html += `<h3>${renderInlineMarkdown(subhead[1].trim())}</h3>`;
      continue;
    }

    const item = line.match(/^(\s*)-\s+(.+)/);
    if (item) {
      closeParagraph();
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      const depth = Math.min(4, Math.floor(item[1].length / 2) + 1);
      html += `<li class="help-li-depth-${depth}">${renderInlineMarkdown(item[2])}</li>`;
      continue;
    }

    closeList();
    paragraph.push(trimmed);
  }

  closeParagraph();
  closeList();
  if (inCode) html += `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
  return html;
}

function mergeMarkdownListContinuations(lines) {
  const merged = [];
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line)) inCode = !inCode;
    const isContinuation = !inCode &&
      line.trim() &&
      !/^\s*- /.test(line) &&
      !/^#{1,6}\s+/.test(line) &&
      merged.length &&
      /^\s*- /.test(merged[merged.length - 1]);
    if (isContinuation) {
      merged[merged.length - 1] += ` ${line.trim()}`;
    } else {
      merged.push(line);
    }
  }
  return merged;
}

function renderInlineMarkdown(s) {
  let out = escapeHtml(s);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const rawHref = href.trim();
    const safeHref = /^(https?:|\.?\/|docs\/|#)/.test(rawHref) ? rawHref : '#';
    const attrs = /^https?:/.test(rawHref) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${escapeAttr(safeHref)}"${attrs}>${label}</a>`;
  });
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return out;
}

function safeFilename(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'cluster';
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function wallTypeName(type) {
  if (type === WALL_SOLID) return 'solid';
  if (type === WALL_MEMBRANE) return 'glass';
  if (type === WALL_POROUS) return 'mud';
  return `type ${type}`;
}

function renderWallInfo(info, clade = null) {
  const type = wallTypeName(info.type);
  const cladeName = clade ? (clade.name || `clade #${clade.id}`) : null;
  const owner = info.ownerId
    ? `#${info.ownerId} ${info.ownerAlive ? 'alive' : 'dead or gone'}`
    : 'brush or preset';
  const cluster = info.clusterAnchorId
    ? `${info.clusterName ? escapeHtml(info.clusterName) : `anchor #${info.clusterAnchorId}`} ${info.clusterAlive ? 'active' : 'disbanded'}`
    : 'none recorded';
  return `
    <button class="close" aria-label="close">×</button>
    <div class="title"><span class="wall-chip wall-${type}"></span><strong>${type} wall</strong></div>
    <div class="row-pair">cell <span>${info.gx}, ${info.gy}</span></div>
    <div class="row-pair">deposited <span>${info.depositedTick ? `t${info.depositedTick}` : 'preset/brush'}</span></div>
    <div class="row-pair">builder <span>${owner}</span></div>
    <div class="row-pair">cluster <span>${cluster}</span></div>
    <div class="row-pair">clade <span>${cladeName ? escapeHtml(cladeName) : (info.cladeId ? `#${info.cladeId}` : 'none')}</span></div>
  `;
}

function renderSpecimen(p, opts = {}) {
  const g = p.genome;
  const sp = g.species;
  const swatch = `<span class="swatch" style="background:${SPECIES_COLORS[sp]}"></span>`;
  const chaseBtn = opts.isLive
    ? `<button class="btn-chase ${opts.chasing ? 'active' : ''}">${opts.chasing ? 'Stop chasing' : 'Chase'}</button>`
    : '';
  const chaseClusterBtn = opts.isLive && opts.inCluster
    ? `<button class="btn-chase-cluster ${opts.chasingCluster ? 'active' : ''}">${opts.chasingCluster ? 'Stop cluster' : 'Chase cluster'}</button>`
    : '';
  const inspectClusterBtn = opts.isLive && opts.inCluster
    ? '<button class="btn-inspect-cluster">Inspect cluster</button>'
    : '';
  const copyBtn = opts.isLive ? '<button class="btn-duplicate-specimen">Copy</button>' : '';
  const exportBtn = opts.isLive ? '<button class="btn-export-specimen">Export</button>' : '';
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
    <div class="row-pair">brain slots <span>${brainSlots} / 10</span></div>
    <div class="row-pair">wall carry <span>${(p.wallCarry || 0)} / 5</span></div>
    ${chaseBtn || chaseClusterBtn || inspectClusterBtn || copyBtn || exportBtn ? `<div class="specimen-actions">${chaseBtn}${chaseClusterBtn}${inspectClusterBtn}${copyBtn}${exportBtn}</div>` : ''}
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

function renderClusterInfo(cluster, summary, opts = {}) {
  const sp = summary.dominantSpecies ?? cluster.species ?? 0;
  const swatch = `<span class="swatch" style="background:${SPECIES_COLORS[sp]}"></span>`;
  const clade = summary.dominantClade;
  const cladeName = clade ? (clade.name || `clade #${clade.id}`) : 'mixed/unknown';
  return `
    <button class="close" aria-label="close">×</button>
    <div class="title">${swatch}<strong>${escapeHtml(cluster.name || 'cluster')}</strong></div>
    <div class="row-pair">members <span>${summary.liveCount} live / ${cluster.count || summary.liveCount}</span></div>
    <div class="row-pair">dominant species <span>${escapeHtml(SPECIES_NAMES[sp] || `species ${sp}`)} (${summary.dominantSpeciesCount})</span></div>
    <div class="row-pair">dominant clade <span>${escapeHtml(cladeName)} (${summary.dominantCladeCount || 0})</span></div>
    <div class="row-pair">mean energy <span>${summary.meanEnergy.toFixed(2)}</span></div>
    <div class="row-pair">lowest energy <span>${summary.minEnergy.toFixed(2)}</span></div>
    <div class="row-pair">mean age <span>${summary.meanAge.toFixed(0)}</span></div>
    <div class="row-pair">mean brain <span>${summary.meanSlots.toFixed(2)} slots</span></div>
    <div class="row-pair">compactness <span>${summary.compactness.toFixed(2)}</span></div>
    <div class="row-pair">bond topology <span>${summary.internalBonds} links · degree ${summary.meanDegree.toFixed(2)} · fill ${(summary.bondFill * 100).toFixed(0)}%</span></div>
    <div class="row-pair">radius / spread <span>${(cluster.radius || 0).toFixed(1)} / ${(cluster.spread || 0).toFixed(1)}</span></div>
    <div class="row-pair">wall work <span>${summary.wallDigs} digs · ${summary.wallDeposits} deposits · ${summary.wallCarry} carried</span></div>
    <div class="row-pair">mean aggression <span>${summary.meanAggression.toFixed(2)}</span></div>
    <div class="row-pair">signals <span>vis ${summary.meanSignal.toFixed(2)} · sound ${summary.meanSound.toFixed(2)} · bond ${summary.meanBondSignal.toFixed(2)}</span></div>
    <div class="specimen-actions">
      <button class="btn-chase-cluster ${opts.chasing ? 'active' : ''}">${opts.chasing ? 'Stop cluster' : 'Chase cluster'}</button>
      <button class="btn-duplicate-cluster">Copy</button>
      <button class="btn-export-cluster">Export</button>
    </div>
  `;
}
