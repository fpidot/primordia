// render.js — paints the chemical field (low-res, drawn via offscreen canvas)
// and particles, both with a Camera transform applied for pan/zoom.

import { GW, GH, W, H, CELL, WALL_SOLID } from './sim.js';
import { SPECIES_RGB, SPECIES_COLORS } from './genome.js';

export class Camera {
  constructor() {
    this.x = W * 0.5;
    this.y = H * 0.5;
    this.zoom = 1;
    this.minZoom = 0.25;
    this.maxZoom = 6;
    this.viewW = 1;
    this.viewH = 1;
    this.followTarget = null;   // a particle reference to chase each frame
  }

  follow(particle) {
    this.followTarget = particle || null;
    this.followClusterAnchorId = null;
    this.followClusterMembers = null;
  }
  // Accept a single id (back-compat) or an array of member ids. Camera will
  // follow whichever cluster currently contains *any* of them, so the chase
  // survives the original anchor dying or unbonding from the colony.
  followCluster(memberIds) {
    const arr = typeof memberIds === 'number' ? [memberIds] : memberIds.slice(0, 8);
    this.followClusterMembers = arr;
    this.followClusterAnchorId = arr[0];   // primary, used for UI compare
    this.followTarget = null;
  }
  unfollow() {
    this.followTarget = null;
    this.followClusterAnchorId = null;
    this.followClusterMembers = null;
  }
  isFollowing() { return !!(this.followTarget || this.followClusterMembers); }

  // Resolve the currently-chased cluster object from the world, if any of
  // the snapshot member ids is still in some cluster. Returns null when
  // every chased member has died or unbonded.
  resolveChasedCluster(world) {
    if (!this.followClusterMembers || !world || !world._particleToCluster) return null;
    for (const id of this.followClusterMembers) {
      const cl = world._particleToCluster.get(id);
      if (cl) return cl;
    }
    return null;
  }

  // Called once per frame from the RAF loop. Tracks either a single particle
  // (chase mode from specimen card) or a cluster centroid (chase from the Top
  // Clusters panel). Cluster anchorId is the smallest-id member at detection
  // time; when the cluster dissolves we drop the chase.
  tickFollow(world, smoothing = 0.2) {
    if (this.followTarget) {
      if (this.followTarget.dead) { this.followTarget = null; return; }
      this.x += (this.followTarget.x - this.x) * smoothing;
      this.y += (this.followTarget.y - this.y) * smoothing;
      this.clamp();
      return;
    }
    if (this.followClusterMembers && world) {
      // Resolve the chased cluster by trying each remembered member id in
      // turn. Survives anchor death, anchor unbonding, and recompute-
      // reshuffling that changes which member is "smallest id".
      const cluster = this.resolveChasedCluster(world);
      if (!cluster) {
        this._chaseMissCount = (this._chaseMissCount || 0) + 1;
        if (this._chaseMissCount > 60) {
          this.followClusterMembers = null;
          this.followClusterAnchorId = null;
          this._chaseMissCount = 0;
        }
        return;
      }
      this._chaseMissCount = 0;
      this.x += (cluster.cx - this.x) * smoothing;
      this.y += (cluster.cy - this.y) * smoothing;
      this.clamp();
    }
  }

  setViewport(w, h) { this.viewW = w; this.viewH = h; }

  fit(world = true) {
    // Fit world entirely inside viewport
    const sx = this.viewW / W;
    const sy = this.viewH / H;
    this.zoom = Math.min(sx, sy);
    this.x = W * 0.5;
    this.y = H * 0.5;
  }

  clamp() {
    if (this.zoom < this.minZoom) this.zoom = this.minZoom;
    if (this.zoom > this.maxZoom) this.zoom = this.maxZoom;
    // Pan limits — keep at least a slice of world visible
    const halfW = this.viewW / (2 * this.zoom);
    const halfH = this.viewH / (2 * this.zoom);
    if (this.x < -halfW) this.x = -halfW;
    if (this.x > W + halfW) this.x = W + halfW;
    if (this.y < -halfH) this.y = -halfH;
    if (this.y > H + halfH) this.y = H + halfH;
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.viewW / 2) / this.zoom + this.x,
      y: (sy - this.viewH / 2) / this.zoom + this.y,
    };
  }

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.zoom + this.viewW / 2,
      y: (wy - this.y) * this.zoom + this.viewH / 2,
    };
  }

  apply(ctx) {
    ctx.setTransform(
      this.zoom, 0,
      0, this.zoom,
      -this.x * this.zoom + this.viewW / 2,
      -this.y * this.zoom + this.viewH / 2,
    );
  }

  // Zoom around a screen point (e.g., the mouse cursor)
  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.zoom *= factor;
    this.clamp();
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  pan(dxScreen, dyScreen) {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.clamp();
  }
}

export class Renderer {
  constructor(bgCanvas, fgCanvas, camera) {
    this.bg = bgCanvas;
    this.fg = fgCanvas;
    this.cam = camera;
    this.bgCtx = bgCanvas.getContext('2d');
    this.fgCtx = fgCanvas.getContext('2d');

    // Offscreen low-res buffer for the field — drawn to bg with transform.
    this.fieldBuf = document.createElement('canvas');
    this.fieldBuf.width = GW;
    this.fieldBuf.height = GH;
    this.fieldCtx = this.fieldBuf.getContext('2d');
    this.fieldImage = this.fieldCtx.createImageData(GW, GH);
    // Walls render via a vector pass per cell (see renderField), so we just
    // cache a list of {type, gx, gy, density} that gets rebuilt only when
    // the wall set changes. No raster buffer = no zoom-dependent blockiness.
    this._wallSig = -1;
    this._wallCellList = [];
    // Predator rim color cache — one "offset" hue per species derived by
    // brightening + slight hue rotation so the rim differs from the body
    // but reads as related, not as a universal red. Computed once at
    // boot since SPECIES_COLORS is static.
    this._predRimColors = SPECIES_COLORS.map(hex => {
      const n = parseInt(hex.slice(1), 16);
      let r = (n >> 16) & 0xff;
      let g = (n >> 8) & 0xff;
      let b = n & 0xff;
      // Brighten 50% toward white, then small channel rotation so the rim
      // reads as a "highlight" of the body color rather than a swap.
      r = Math.min(255, r + (255 - r) * 0.6);
      g = Math.min(255, g + (255 - g) * 0.45);
      b = Math.min(255, b + (255 - b) * 0.45);
      return `${r | 0},${g | 0},${b | 0}`;
    });

    this.options = {
      trails: true,
      showField: true,
      showWalls: true,
      showFlags: true,
    };
    // Cap how many cluster flags we draw to avoid clutter and perf hits
    this.MAX_FLAGS = 18;

    this.resizeIfNeeded();
  }

  // Match canvas internal resolution to its CSS box (DPR-aware).
  resizeIfNeeded() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const r = this.bg.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width * dpr));
    const h = Math.max(1, Math.floor(r.height * dpr));
    if (this.bg.width !== w || this.bg.height !== h) {
      this.bg.width = w; this.bg.height = h;
      this.fg.width = w; this.fg.height = h;
    }
    this.cam.setViewport(this.bg.width, this.bg.height);
  }

  setOption(key, value) {
    this.options[key] = value;
  }

  render(world) {
    this.resizeIfNeeded();
    this.renderField(world);
    this.renderParticles(world);
  }

  renderField(world) {
    // 1. Build low-res field ImageData. Wall cells stay transparent here so
    //    the chemical-field layer doesn't paint inside walls — they're drawn
    //    in a separate smoothed pass below.
    const data = this.fieldImage.data;
    const f0 = world.field[0];
    const f1 = world.field[1];
    const mut = world.mutagen;
    const walls = world.walls;
    const showField = this.options.showField;
    const showWalls = this.options.showWalls;

    for (let i = 0, di = 0; i < f0.length; i++, di += 4) {
      if (walls[i] === WALL_SOLID) {
        // Transparent here; opaque walls are drawn in the vector pass below.
        data[di] = 0; data[di + 1] = 0; data[di + 2] = 0; data[di + 3] = 0;
        continue;
      }
      let r = 6, g = 8, b = 14;
      if (showField) {
        const food = Math.min(1, f0[i] * 0.35);
        const decay = Math.min(1, f1[i] * 0.20);
        r += food * 30  + decay * 110;
        g += food * 110 + decay * 60;
        b += food * 90  + decay * 20;
      }
      const m = mut[i];
      if (m > 0) {
        const k = Math.min(1, m * 0.5);
        r += k * 90;
        b += k * 130;
      }
      data[di] = r | 0;
      data[di + 1] = g | 0;
      data[di + 2] = b | 0;
      data[di + 3] = 255;
    }
    this.fieldCtx.putImageData(this.fieldImage, 0, 0);

    // 2. Rebuild walls cache when the wall set changes. We keep a list of
    //    {type, gx, gy, dens} per wall cell so the per-frame draw can be a
    //    fast vector pass — fillRect at world coordinates so walls stay
    //    crisp at any zoom (the old buffer-and-bilinear approach showed
    //    blocky pixelation when zoomed in next to the crisp particles).
    const wallSig = world._wallsVersion ?? world._wallCount;
    if (this._wallSig !== wallSig) {
      this._wallSig = wallSig;
      const list = [];
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          const wt = walls[y * GW + x];
          if (!wt) continue;
          let cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= GH) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= GW) continue;
              if (walls[yy * GW + xx]) cnt++;
            }
          }
          let edge = 0;
          if (y === 0 || !walls[(y - 1) * GW + x]) edge |= 1;
          if (x === GW - 1 || !walls[y * GW + x + 1]) edge |= 2;
          if (y === GH - 1 || !walls[(y + 1) * GW + x]) edge |= 4;
          if (x === 0 || !walls[y * GW + x - 1]) edge |= 8;
          list.push({ type: wt, gx: x, gy: y, dens: cnt / 9, edge });
        }
      }
      this._wallCellList = list;
    }

    // 3. Clear bg canvas (in screen space) and blit the field with camera transform
    const ctx = this.bgCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#03050a';
    ctx.fillRect(0, 0, this.bg.width, this.bg.height);
    this.cam.apply(ctx);
    // Field stays crisp (cellular look)
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.fieldBuf, 0, 0, GW, GH, 0, 0, W, H);

    // Walls — vector pass per cell at world coordinates so they stay crisp
    // at any zoom. Color/alpha derive from the cached neighbour-density
    // value computed in the rebuild pass. We bucket by quantised color
    // string so each unique fill triggers one fillStyle change at most.
    if (showWalls && this._wallCellList && this._wallCellList.length > 0) {
      const list = this._wallCellList;
      const z = this.cam.zoom;
      const pad = CELL * 2;
      const minGX = Math.max(0, Math.floor((this.cam.x - this.cam.viewW / (2 * z) - pad) / CELL));
      const maxGX = Math.min(GW - 1, Math.ceil((this.cam.x + this.cam.viewW / (2 * z) + pad) / CELL));
      const minGY = Math.max(0, Math.floor((this.cam.y - this.cam.viewH / (2 * z) - pad) / CELL));
      const maxGY = Math.min(GH - 1, Math.ceil((this.cam.y + this.cam.viewH / (2 * z) + pad) / CELL));
      // Bucket cells by colour key: "type|densBucket" → array of cells
      const buckets = this._wallBuckets || (this._wallBuckets = new Map());
      buckets.clear();
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.gx < minGX || c.gx > maxGX || c.gy < minGY || c.gy > maxGY) continue;
        const dBucket = (c.dens * 8) | 0;        // 0..8
        const key = c.type * 16 + dBucket;
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        arr.push(c);
      }
      for (const [key, arr] of buckets) {
        const wt = (key / 16) | 0;
        const dens = (key % 16) / 8;
        const lerp = 1 - dens;
        let cr, cg, cb, alpha;
        if (wt === 2) {
          cr = 80 + lerp * 35;
          cg = 155 + lerp * 50;
          cb = 190 + lerp * 45;
          alpha = (95 + dens * 55) / 255;
        } else if (wt === 3) {
          cr = 92 + lerp * 24;
          cg = 76 + lerp * 16;
          cb = 42 + lerp * 10;
          alpha = (105 + dens * 60) / 255;
        } else {
          cr = 218 + lerp * 14;
          cg = 213 + lerp * 12;
          cb = 200 + lerp * 6;
          alpha = (180 + dens * 75) / 255;
        }
        ctx.fillStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},${alpha.toFixed(3)})`;
        for (let i = 0; i < arr.length; i++) {
          const c = arr[i];
          ctx.fillRect(c.gx * CELL, c.gy * CELL, CELL, CELL);
        }
      }
      if (z > 0.75) {
        const edgeBuckets = this._wallEdgeBuckets || (this._wallEdgeBuckets = new Map());
        edgeBuckets.clear();
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (!c.edge) continue;
          if (c.gx < minGX || c.gx > maxGX || c.gy < minGY || c.gy > maxGY) continue;
          let path = edgeBuckets.get(c.type);
          if (!path) { path = new Path2D(); edgeBuckets.set(c.type, path); }
          const x = c.gx * CELL;
          const y = c.gy * CELL;
          if (c.edge & 1) { path.moveTo(x, y); path.lineTo(x + CELL, y); }
          if (c.edge & 2) { path.moveTo(x + CELL, y); path.lineTo(x + CELL, y + CELL); }
          if (c.edge & 4) { path.moveTo(x + CELL, y + CELL); path.lineTo(x, y + CELL); }
          if (c.edge & 8) { path.moveTo(x, y + CELL); path.lineTo(x, y); }
        }
        ctx.lineWidth = Math.max(0.35, 0.9 / z);
        for (const [wt, path] of edgeBuckets) {
          if (wt === 2) ctx.strokeStyle = 'rgba(175, 231, 247, 0.52)';
          else if (wt === 3) ctx.strokeStyle = 'rgba(173, 138, 78, 0.42)';
          else ctx.strokeStyle = 'rgba(255, 253, 235, 0.36)';
          ctx.stroke(path);
        }
      }
    }

    // World boundary outline
    ctx.lineWidth = 2 / this.cam.zoom;
    ctx.strokeStyle = 'rgba(120,150,200,0.18)';
    ctx.strokeRect(0, 0, W, H);
  }

  renderClusterMembranes(ctx, world, z) {
    const clusters = world._clusters || [];
    if (!clusters.length) return;
    const cap = Math.min(clusters.length, 12);
    const bins = 14;
    const chased = this.cam.resolveChasedCluster ? this.cam.resolveChasedCluster(world) : null;
    const membraneClusters = clusters.slice(0, cap);
    if (chased && !membraneClusters.some(c => c === chased || c.anchorId === chased.anchorId)) {
      membraneClusters.push(chased);
    }
    const phase = (performance.now() % 1400) / 1400;
    const chasePulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
    ctx.globalCompositeOperation = 'source-over';
    for (let ci = 0; ci < membraneClusters.length; ci++) {
      const c = membraneClusters[ci];
      const ms = c.members;
      if (!ms || ms.length < 4) continue;
      const isChased = chased && (c === chased || c.anchorId === chased.anchorId);
      const chaseBoost = isChased ? chasePulse : 0;
      const rgb = this._predRimColors[c.species] || '255,255,255';
      const pts = new Array(bins);
      const step = Math.max(1, Math.floor(ms.length / 64));
      for (let mi = 0; mi < ms.length; mi += step) {
        const p = ms[mi];
        if (!p || p.dead) continue;
        const dx = p.x - c.cx;
        const dy = p.y - c.cy;
        const d2 = dx * dx + dy * dy;
        const a = Math.atan2(dy, dx);
        const bi = Math.min(bins - 1, Math.max(0, ((a + Math.PI) / (Math.PI * 2) * bins) | 0));
        if (!pts[bi] || d2 > pts[bi].d2) pts[bi] = { x: p.x, y: p.y, d2 };
      }
      const ring = pts.filter(Boolean);
      if (ring.length < 4) {
        const rr = Math.max(8, (c.radius || 8) + 4 + chaseBoost * 2.5);
        ctx.fillStyle = `rgba(${rgb}, ${isChased ? 0.10 + chaseBoost * 0.03 : 0.08})`;
        ctx.strokeStyle = `rgba(${rgb}, ${isChased ? 0.48 + chaseBoost * 0.18 : 0.36})`;
        ctx.lineWidth = Math.max(0.6, (isChased ? 1.45 : 1.1) / z);
        ctx.beginPath();
        ctx.arc(c.cx, c.cy, rr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        continue;
      }
      const pad = Math.max(4, 7 / Math.max(0.7, z)) + chaseBoost * 1.8;
      for (const p of ring) {
        const dx = p.x - c.cx;
        const dy = p.y - c.cy;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        p.x += dx / d * pad;
        p.y += dy / d * pad;
      }
      ctx.fillStyle = `rgba(${rgb}, ${isChased ? 0.09 + chaseBoost * 0.025 : 0.075})`;
      const strokeA = isChased ? 0.55 + chaseBoost * 0.18 : (z > 1.1 ? 0.45 : 0.32);
      ctx.strokeStyle = `rgba(${rgb}, ${strokeA})`;
      ctx.lineWidth = Math.max(0.7, (isChased ? 1.9 : 1.4) / z);
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        const mx = (p.x + q.x) * 0.5;
        const my = (p.y + q.y) * 0.5;
        if (i === 0) ctx.moveTo(mx, my);
        ctx.quadraticCurveTo(q.x, q.y, (q.x + ring[(i + 2) % ring.length].x) * 0.5,
          (q.y + ring[(i + 2) % ring.length].y) * 0.5);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  renderParticles(world) {
    const ctx = this.fgCtx;
    const opts = this.options;

    // Reset transform for the trail/clear pass — operates in screen space.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (opts.trails) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
      ctx.fillRect(0, 0, this.fg.width, this.fg.height);
    } else {
      ctx.clearRect(0, 0, this.fg.width, this.fg.height);
    }

    // Switch to world coords for particle drawing
    this.cam.apply(ctx);
    const z = this.cam.zoom;
    const viewPad = 36 / Math.max(0.35, z);
    const minX = this.cam.x - this.cam.viewW / (2 * z) - viewPad;
    const maxX = this.cam.x + this.cam.viewW / (2 * z) + viewPad;
    const minY = this.cam.y - this.cam.viewH / (2 * z) - viewPad;
    const maxY = this.cam.y + this.cam.viewH / (2 * z) + viewPad;
    if (z > 0.35) this.renderClusterMembranes(ctx, world, z);

    // Bond lines first, in normal compositing so additive glow lands on top.
    // Each bond is colored as a *lightened average* of its two endpoints'
    // species RGB, so a viewer can read cluster makeup at a glance: a green
    // member bonded to a red member shows a yellowish edge, a homogeneous
    // green colony shows green-on-green edges. Bonds are batched per-color
    // (32-step quantisation) to keep stroke calls reasonable even at high N.
    const ps = world.particles;
    if (z > 0.4) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = Math.max(0.8, 1.7 / z);

      // Build id→index quick lookup for bond endpoints
      const idIdx = this._idIdx || (this._idIdx = new Map());
      idIdx.clear();
      for (let i = 0; i < ps.length; i++) idIdx.set(ps[i].id, i);

      // Bucket bonds by quantised lightened-average color, then stroke each
      // bucket as a single Path2D. 32-step quantisation per channel = 32^3
      // possible buckets in theory, but with 6 species × 6 species = 36 unique
      // pairs in practice; the Map is small.
      const buckets = this._bondBuckets || (this._bondBuckets = new Map());
      buckets.clear();
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (!p.bonds || p.bonds.length === 0) continue;
        const rgbA = SPECIES_RGB[p.genome.species];
        for (const pid of p.bonds) {
          if (pid <= p.id) continue;     // draw each bond once
          const jIdx = idIdx.get(pid);
          if (jIdx == null) continue;
          const q = ps[jIdx];
          if ((p.x < minX && q.x < minX) || (p.x > maxX && q.x > maxX) ||
              (p.y < minY && q.y < minY) || (p.y > maxY && q.y > maxY)) {
            continue;
          }
          const rgbB = SPECIES_RGB[q.genome.species];
          // SPECIES_RGB is float [0..1]. Average then lerp 35% toward white,
          // then convert to 0..255. Earlier `(rgbA[0]+rgbB[0])>>1` integer-
          // truncated the floats to zero, making every bond uniform gray.
          const ar = (rgbA[0] + rgbB[0]) * 0.5;
          const ag = (rgbA[1] + rgbB[1]) * 0.5;
          const ab = (rgbA[2] + rgbB[2]) * 0.5;
          const r = ((ar + (1 - ar) * 0.35) * 255) | 0;
          const g = ((ag + (1 - ag) * 0.35) * 255) | 0;
          const b = ((ab + (1 - ab) * 0.35) * 255) | 0;
          // Quantise to 8-bit/channel keys (we already are)
          const key = (r << 16) | (g << 8) | b;
          let path = buckets.get(key);
          if (!path) { path = new Path2D(); buckets.set(key, path); }
          path.moveTo(p.x, p.y);
          path.lineTo(q.x, q.y);
        }
      }
      for (const [key, path] of buckets) {
        const r = (key >> 16) & 0xff;
        const g = (key >> 8) & 0xff;
        const b = key & 0xff;
        ctx.strokeStyle = `rgba(${r},${g},${b},0.7)`;
        ctx.stroke(path);
      }
    }

    // Bodies use 'source-over' with sub-1 alpha so stacked particles partially
    // show through each other — visible cue when two or more occupy the same
    // spot. Glow halo pass removed — at the tonedown levels needed to avoid
    // saturating dense clusters it was no longer visually distinct anyway,
    // and it cost a per-particle drawImage + composite-mode toggle per frame.
    ctx.globalCompositeOperation = 'source-over';
    if (z < 0.85 && ps.length > 1200) {
      const paths = this._speciesParticlePaths || (this._speciesParticlePaths = SPECIES_COLORS.map(() => new Path2D()));
      for (let s = 0; s < paths.length; s++) paths[s] = new Path2D();
      const r = Math.max(1.7, 2.2 / Math.max(0.55, z));
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
        const path = paths[p.genome.species] || paths[0];
        path.moveTo(p.x + r, p.y);
        path.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      ctx.globalAlpha = 0.78;
      for (let s = 0; s < paths.length; s++) {
        ctx.fillStyle = SPECIES_COLORS[s];
        ctx.fill(paths[s]);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      this.renderClusterFlags(ctx, world);
      return;
    }
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
      const sp = p.genome.species;
      const col = particleBodyColor(p, sp);
      // Base radius scales with energy; bonded particles look bigger so
      // multi-cellular colonies read as distinct entities.
      const bondScale = Math.sqrt(1 + (p.bonds ? p.bonds.length : 0));
      const r = (1.6 + Math.min(1.0, p.energy * 0.06)) * bondScale;

      // Signaling wave. Sustained calls get a soft glow; fresh signal events
      // draw two staggered rings so communication reads as a radiating wave,
      // not a single flashing halo.
      const sigStrength = (p.signalR + p.signalG + p.signalB) / 3;
      const sustained = Math.max(0, sigStrength - 0.7) * 1.6;          // 0..0.48
      const flash = p.signalFlash || 0;                                 // 0..1
      const haloA = Math.max(sustained, flash);
      if (haloA > 0.04) {
        const sr = (p.signalR * 255) | 0;
        const sg = (p.signalG * 255) | 0;
        const sb = (p.signalB * 255) | 0;
        const zClamp = z > 1 ? 1 / z : 1;
        if (sustained > 0.04) {
          ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
          ctx.globalAlpha = Math.min(0.18, sustained * 0.22);
          ctx.beginPath();
          const haloR = r * (1.25 + sustained * 1.1 * zClamp);
          ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
          ctx.fill();
        }
        if (flash > 0.05) {
          const fade = 1 - flash;
          const outerR = r * (2.1 + fade * 2.0 * zClamp);
          const innerR = outerR * 0.66;
          const widths = Math.max(0.45, 0.9 / z);
          ctx.lineWidth = widths;
          ctx.strokeStyle = `rgba(${sr},${sg},${sb},${flash * 0.30})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, innerR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = `rgba(${sr},${sg},${sb},${flash * 0.42})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, outerR, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Body shape — three modes:
      //   • predationGain > 0.4 → spiky 5-pointed star (clear predator)
      //   • else                → velocity-aligned ellipse (streaks for fast)
      // Predators with predationGain in 0.2..0.4 get the warning rim on
      // their ellipse (transitioning into "spiky" territory).
      const sp2 = p.vx * p.vx + p.vy * p.vy;
      const speed = Math.sqrt(sp2);
      const elong = Math.min(0.55, speed * 0.22);
      const rx = r * (1 + elong * 0.7);
      const ry = r * (1 - elong * 0.4);
      const ang = speed > 0.05 ? Math.atan2(p.vy, p.vx) : 0;
      // Shape selection — three modes:
      //   • spiky star  (predator drive >  0.18 AND > digger drive)
      //   • diamond     (digger drive  >  0.30 AND >= predator drive)
      //   • ellipse     (default)
      // For particles that qualify as both, the stronger trait wins. Digger
      // drive uses the raw OUT_DIG bias mapped through tanh — neutral
      // particles map to ~0, so init bias of zero is NOT diamond-eligible.
      // Threshold 0.30 means biasO[16] needs to exceed ~0.31 for diamond,
      // which only a strongly-evolved digger lineage will reach.
      const predDrive = p.predationGain || 0;
      const digBias = (p.genome && p.genome.brain) ? p.genome.brain.biasO[16] : -2;
      const digDrive = Math.tanh(digBias);
      const isSpiky = predDrive > 0.18 && predDrive >= digDrive;
      const isDiamond = !isSpiky && digDrive > 0.30 && digDrive > predDrive;

      ctx.fillStyle = col;
      // Visual-only energy dimming: low-energy particles look ghostly so the
      // user can spot starvation at a glance. Sensors are unaffected — this
      // is purely a render concession. Floor at 0.30 alpha so dying particles
      // are still visible enough to track.
      const eFrac = Math.max(0.3, Math.min(1, (p.energy || 0) / 6));
      ctx.globalAlpha = 0.72 * eFrac;

      if (isSpiky) {
        // 5-pointed star — softer than before. Inner radius now ~0.7× outer
        // (was ~0.5×), so the points read like rounded petals rather than
        // sharp barbs. Sharpness still grows with predationGain but stays
        // gentle. Same elongation along velocity as ovals (rx/ry split +
        // rotation `ang`) so fast-moving predators streak like their oval
        // cousins; slow ones look like 5-petalled rosettes.
        const sharpness = Math.min(1, (p.predationGain - 0.18) / 0.5);    // 0..1
        const baseOuter = (rx + ry) * 0.6 * (1.05 + sharpness * 0.30);
        const baseInner = baseOuter * (0.62 - sharpness * 0.15);          // 0.47..0.62
        const points = 5;
        const cosA = Math.cos(ang), sinA = Math.sin(ang);
        // Per-axis scale: stretch along velocity by rx/ry ratio so motion
        // streaks the star the same way it streaks ovals.
        const sx = rx / r, sy = ry / r;
        ctx.beginPath();
        for (let s = 0; s < points * 2; s++) {
          const radius = (s & 1) ? baseInner : baseOuter;
          const a = -Math.PI / 2 + (s / (points * 2)) * Math.PI * 2;
          // Vertex in star-local space, then anisotropic stretch (sx, sy),
          // then rotate by velocity angle, then translate to particle pos.
          const lx = Math.cos(a) * radius * sx;
          const ly = Math.sin(a) * radius * sy;
          const px = p.x + lx * cosA - ly * sinA;
          const py = p.y + lx * sinA + ly * cosA;
          if (s === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        // Bright rim in the species' own offset hue — reads as a highlight
        // of the predator rather than a universal "red" tag.
        const rim = this._predRimColors[sp];
        ctx.strokeStyle = `rgba(${rim}, ${0.7 + sharpness * 0.3})`;
        ctx.lineWidth = Math.max(0.5, 1.2 / z);
        ctx.stroke();
      } else if (isDiamond) {
        // 4-point diamond — same anisotropic stretch + rotation as ovals so
        // diggers also streak when they're moving fast. Diamond shape reads
        // as "compact tool" vs the predator's "petal" star.
        const sx = rx / r, sy = ry / r;
        const cosA = Math.cos(ang), sinA = Math.sin(ang);
        // Local diamond vertices: long axis ±diamondLen, short axis ±diamondWid
        const diamondLen = r * 1.15;
        const diamondWid = r * 0.65;
        const verts = [
          [ diamondLen * sx,  0          ],
          [ 0,                diamondWid * sy],
          [-diamondLen * sx,  0          ],
          [ 0,               -diamondWid * sy],
        ];
        ctx.beginPath();
        for (let v = 0; v < 4; v++) {
          const [lx, ly] = verts[v];
          const px = p.x + lx * cosA - ly * sinA;
          const py = p.y + lx * sinA + ly * cosA;
          if (v === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        // Subtle outline in the species' own offset hue.
        const rim = this._predRimColors[sp];
        ctx.strokeStyle = `rgba(${rim}, 0.6)`;
        ctx.lineWidth = Math.max(0.5, 1.0 / z);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rx, ry, ang, 0, Math.PI * 2);
        ctx.fill();

        // Mild predator rim for in-between particles (predation 0.08..0.18).
        if (p.predationGain > 0.08) {
          const rimA = Math.min(1, p.predationGain * 4) * 0.7;
          const rim = this._predRimColors[sp];
          ctx.strokeStyle = `rgba(${rim}, ${rimA})`;
          ctx.lineWidth = Math.max(0.5, 1.0 / z);
          ctx.stroke();         // reuses ellipse path
        }
      }

      if ((p.wallCarry || 0) > 0 && z > 0.45) {
        const carry = Math.min(5, p.wallCarry || 0);
        const sideA = ang + Math.PI * 0.5;
        const ox = Math.cos(sideA) * (r + 1.6);
        const oy = Math.sin(sideA) * (r + 1.6);
        const cr = 0.85 + carry * 0.24;
        ctx.globalAlpha = Math.min(0.9, 0.55 + carry * 0.07);
        ctx.fillStyle = '#d6c08a';
        ctx.strokeStyle = 'rgba(46,38,28,0.72)';
        ctx.lineWidth = Math.max(0.45, 0.8 / z);
        ctx.beginPath();
        ctx.moveTo(p.x + ox, p.y + oy - cr);
        ctx.lineTo(p.x + ox + cr, p.y + oy);
        ctx.lineTo(p.x + ox, p.y + oy + cr);
        ctx.lineTo(p.x + ox - cr, p.y + oy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Cluster flags — drawn last in screen space so labels stay readable
    // regardless of zoom level.
    if (this.options.showFlags && world._clusters && world._clusters.length > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const cam = this.cam;
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      ctx.font = `${11 * dpr}px ui-monospace, "Cascadia Mono", Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const cap = Math.min(world._clusters.length, this.MAX_FLAGS);
      for (let i = 0; i < cap; i++) {
        const c = world._clusters[i];
        const s = cam.worldToScreen(c.cx, c.cy);
        // Skip if off-screen
        if (s.x < -100 || s.x > this.fg.width + 100 ||
            s.y < -40  || s.y > this.fg.height + 40) continue;
        const sp = c.species;
        const col = SPECIES_COLORS[sp] || '#fff';
        const labelY = s.y - 10 * dpr;
        // Background pill for readability
        const text = c.name;
        const tw = ctx.measureText(text).width + 8 * dpr;
        const th = 14 * dpr;
        ctx.fillStyle = 'rgba(10, 14, 22, 0.78)';
        roundRect(ctx, s.x - tw / 2, labelY - th, tw, th, 3 * dpr);
        ctx.fill();
        ctx.fillStyle = col;
        ctx.fillRect(s.x - tw / 2, labelY - th, 2 * dpr, th);
        ctx.fillStyle = '#e6ecf2';
        ctx.fillText(text, s.x, labelY - 2 * dpr);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  renderClusterFlags(ctx, world) {
    if (!this.options.showFlags || !world._clusters || world._clusters.length === 0) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const cam = this.cam;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    ctx.font = `${11 * dpr}px ui-monospace, "Cascadia Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const cap = Math.min(world._clusters.length, this.MAX_FLAGS);
    for (let i = 0; i < cap; i++) {
      const c = world._clusters[i];
      const s = cam.worldToScreen(c.cx, c.cy);
      if (s.x < -100 || s.x > this.fg.width + 100 ||
          s.y < -40  || s.y > this.fg.height + 40) continue;
      const sp = c.species;
      const col = SPECIES_COLORS[sp] || '#fff';
      const labelY = s.y - 10 * dpr;
      const text = c.name;
      const tw = ctx.measureText(text).width + 8 * dpr;
      const th = 14 * dpr;
      ctx.fillStyle = 'rgba(10, 14, 22, 0.78)';
      roundRect(ctx, s.x - tw / 2, labelY - th, tw, th, 3 * dpr);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.fillRect(s.x - tw / 2, labelY - th, 2 * dpr, th);
      ctx.fillStyle = '#e6ecf2';
      ctx.fillText(text, s.x, labelY - 2 * dpr);
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function particleBodyColor(p, sp) {
  if (p._renderColor && p._renderColorSpecies === sp) return p._renderColor;
  const rgb = SPECIES_RGB[sp] || [1, 1, 1];
  let h = ((p.id || 1) * 1103515245 + 12345) >>> 0;
  const jr = ((h & 0xff) / 255 - 0.5) * 20;
  h = (h ^ (h >>> 13)) >>> 0;
  const jg = ((h & 0xff) / 255 - 0.5) * 20;
  h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
  const jb = ((h & 0xff) / 255 - 0.5) * 20;
  const shade = 0.94 + (((h >>> 8) & 0xff) / 255) * 0.13;
  const r = clamp8(rgb[0] * 255 * shade + jr);
  const g = clamp8(rgb[1] * 255 * shade + jg);
  const b = clamp8(rgb[2] * 255 * shade + jb);
  p._renderColorSpecies = sp;
  p._renderColor = `rgb(${r},${g},${b})`;
  return p._renderColor;
}

function clamp8(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v | 0);
}

// Tiny line-chart for population history.
export class PopulationChart {
  constructor(canvas, history = 240, numSeries = 16) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.history = history;
    this.data = []; // each element: [t, [c0,c1,...]]
    this.numSeries = numSeries;
  }

  push(tick, counts) {
    this.data.push({ t: tick, c: counts.slice() });
    if (this.data.length > this.history) this.data.shift();
  }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (this.data.length === 0) return;

    let max = 1;
    for (const d of this.data) {
      for (const c of d.c) if (c > max) max = c;
    }

    for (let s = 0; s < this.numSeries; s++) {
      ctx.beginPath();
      ctx.strokeStyle = SPECIES_COLORS[s];
      ctx.lineWidth = 1;
      for (let i = 0; i < this.data.length; i++) {
        const x = (i / (this.history - 1)) * W;
        const y = H - ((this.data[i].c[s] || 0) / max) * (H - 2) - 1;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}
