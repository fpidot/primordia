// render.js — paints the chemical field (low-res, drawn via offscreen canvas)
// and particles, both with a Camera transform applied for pan/zoom.

import { GW, GH, W, H, CELL } from './sim.js';
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
    // Separate walls buffer — built only when the wall set changes, then
    // drawn over the field with image-smoothing on so wall edges anti-alias
    // (bilinear filter feathers between solid-density cells and transparent
    // empty cells). The field itself stays nearest-neighbour so chemical
    // blobs keep their crisp cellular look.
    this.wallBuf = document.createElement('canvas');
    this.wallBuf.width = GW;
    this.wallBuf.height = GH;
    this.wallCtx = this.wallBuf.getContext('2d');
    this.wallImage = this.wallCtx.createImageData(GW, GH);
    this._wallSig = -1;

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
      if (walls[i]) {
        // Transparent here; walls drawn from wallBuf with smoothing on.
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

    // 2. Rebuild walls buffer if the wall set changed. Density-shaded edges
    //    (3×3 neighbour count) give soft anti-aliased borders. Three wall
    //    types render with distinct palettes:
    //      • solid    (1) → slate     · opaque
    //      • membrane (2) → cyan/teal · semi-translucent (chems pass through)
    //      • porous   (3) → warm ochre · stippled feel    (particles pass)
    const wallSig = world._wallsVersion ?? world._wallCount;
    if (this._wallSig !== wallSig) {
      this._wallSig = wallSig;
      const wd = this.wallImage.data;
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          const idx = y * GW + x;
          const di = idx * 4;
          const wt = walls[idx];
          if (!wt) {
            wd[di] = 0; wd[di + 1] = 0; wd[di + 2] = 0; wd[di + 3] = 0;
            continue;
          }
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
          const dens = cnt / 9;
          const lerp = 1 - dens;
          let cr, cg, cb, alpha;
          if (wt === 2) {
            // Membrane — cyan/teal, more translucent so it visually reads as
            // "chemicals pass through". Stipple via a faint XOR pattern.
            const stipple = ((x ^ y) & 1) ? 1 : 0.85;
            cr = (28 + lerp * 14)       * stipple | 0;
            cg = (80 + lerp * 30)       * stipple | 0;
            cb = (110 + lerp * 30)      * stipple | 0;
            alpha = ((130 + dens * 60)  * stipple) | 0;
          } else if (wt === 3) {
            // Porous — warm ochre stippled stronger so it reads as "particles
            // pass through". More holes than membrane.
            const stipple = (((x + y) & 3) === 0) ? 0.5 : 1;
            cr = (90 + lerp * 28)       * stipple | 0;
            cg = (74 + lerp * 22)       * stipple | 0;
            cb = (40 + lerp * 14)       * stipple | 0;
            alpha = ((120 + dens * 70)  * stipple) | 0;
          } else {
            // Solid — slate (current)
            cr = 40 + (lerp * 18) | 0;
            cg = 46 + (lerp * 24) | 0;
            cb = 64 + (lerp * 22) | 0;
            alpha = (160 + dens * 95) | 0;
          }
          wd[di]     = cr;
          wd[di + 1] = cg;
          wd[di + 2] = cb;
          wd[di + 3] = alpha;
        }
      }
      this.wallCtx.putImageData(this.wallImage, 0, 0);
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
    // Walls smoothed (anti-aliased edges)
    if (showWalls && world._wallCount > 0) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.wallBuf, 0, 0, GW, GH, 0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
    }

    // World boundary outline
    ctx.lineWidth = 2 / this.cam.zoom;
    ctx.strokeStyle = 'rgba(120,150,200,0.18)';
    ctx.strokeRect(0, 0, W, H);
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

    // Bond lines first, in normal compositing so additive glow lands on top.
    // Each bond is colored as a *lightened average* of its two endpoints'
    // species RGB, so a viewer can read cluster makeup at a glance: a green
    // member bonded to a red member shows a yellowish edge, a homogeneous
    // green colony shows green-on-green edges. Bonds are batched per-color
    // (32-step quantisation) to keep stroke calls reasonable even at high N.
    const ps = world.particles;
    const z = this.cam.zoom;
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
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const sp = p.genome.species;
      const col = SPECIES_COLORS[sp];
      // Base radius scales with energy; bonded particles look bigger so
      // multi-cellular colonies read as distinct entities.
      const bondScale = Math.sqrt(1 + (p.bonds ? p.bonds.length : 0));
      const r = (1.6 + Math.min(1.0, p.energy * 0.06)) * bondScale;

      // Signaling halo + sonar-ping ring.
      //   • sustained component: only kicks in well above the comm baseline
      //     (sigmoid≈0.6 random init), so a still population is dim.
      //   • flash component: discrete event from sim.js when signal crosses
      //     the 0.65 threshold from below (sigMean > 0.65). signalFlash
      //     starts at 1 on the rising edge and decays at 0.85/tick. The
      //     halo brightens, AND we draw an expanding ring (small at flash=1,
      //     widening as it decays — reads as a "ping" outward).
      const sigStrength = (p.signalR + p.signalG + p.signalB) / 3;
      const sustained = Math.max(0, sigStrength - 0.7) * 1.6;          // 0..0.48
      const flash = p.signalFlash || 0;                                 // 0..1
      const haloA = Math.max(sustained, flash);
      if (haloA > 0.04) {
        const sr = (p.signalR * 255) | 0;
        const sg = (p.signalG * 255) | 0;
        const sb = (p.signalB * 255) | 0;
        ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
        ctx.globalAlpha = Math.min(0.85, haloA * 0.7);
        ctx.beginPath();
        // Zoom-clamp: at high zoom, additive flash radius is dampened by
        // 1/sqrt(z) so it doesn't dominate the view. At z=1 unchanged; at
        // z=4 → flash component halved, etc.
        const zClamp = z > 1 ? 1 / Math.sqrt(z) : 1;
        const haloR = r * (2.0 + (flash * 4 + sustained * 2) * zClamp);
        ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
        ctx.fill();
        // Ping ring — only on a fresh flash event, expanding as it fades
        if (flash > 0.05) {
          const ringR = r * (1.6 + (1 - flash) * 6 * zClamp);
          ctx.strokeStyle = `rgba(${sr},${sg},${sb},${flash * 0.85})`;
          ctx.lineWidth = Math.max(0.6, 1.4 / z);
          ctx.beginPath();
          ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
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
      const isSpiky = p.predationGain > 0.18;

      ctx.fillStyle = col;
      // Visual-only energy dimming: low-energy particles look ghostly so the
      // user can spot starvation at a glance. Sensors are unaffected — this
      // is purely a render concession. Floor at 0.30 alpha so dying particles
      // are still visible enough to track.
      const eFrac = Math.max(0.3, Math.min(1, (p.energy || 0) / 6));
      ctx.globalAlpha = 0.72 * eFrac;

      if (isSpiky) {
        // 5-pointed star — outer radius ~1.4× body, inner ~0.55×. Sharper
        // for stronger predators.
        const sharpness = Math.min(1, (p.predationGain - 0.18) / 0.5);    // 0..1
        const outerR = (rx + ry) * 0.65 * (1.2 + sharpness * 0.5);
        const innerR = (rx + ry) * 0.32 * (1 - sharpness * 0.3);
        const points = 5;
        ctx.beginPath();
        for (let s = 0; s < points * 2; s++) {
          const radius = (s & 1) ? innerR : outerR;
          const a = ang - Math.PI / 2 + (s / (points * 2)) * Math.PI * 2;
          const px = p.x + Math.cos(a) * radius;
          const py = p.y + Math.sin(a) * radius;
          if (s === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        // Hot rim around the star — reads even more aggressively
        ctx.strokeStyle = `rgba(255, 70, 30, ${0.6 + sharpness * 0.3})`;
        ctx.lineWidth = Math.max(0.5, 1.2 / z);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rx, ry, ang, 0, Math.PI * 2);
        ctx.fill();

        // Mild predator rim for in-between particles (predation 0.08..0.18).
        if (p.predationGain > 0.08) {
          const rimA = Math.min(1, p.predationGain * 4) * 0.7;
          ctx.strokeStyle = `rgba(255, 80, 40, ${rimA})`;
          ctx.lineWidth = Math.max(0.5, 1.0 / z);
          ctx.stroke();         // reuses ellipse path
        }
      }

    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Chased-cluster highlight — when the camera is following a cluster, draw
    // a pulsing ring around every member so it's unmistakable which group is
    // being tracked. Phase ties to wall clock so cadence stays steady at any
    // sim speed.
    if (this.cam.followClusterMembers && world._particleToCluster) {
      const cluster = this.cam.resolveChasedCluster(world);
      if (cluster && cluster.members) {
        const phase = (performance.now() % 1200) / 1200;
        const pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
        const ringR = 4 + pulse * 3;
        const sp = cluster.species;
        const col = SPECIES_COLORS[sp] || '#ffffff';
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1.2, 2.2 / z);
        ctx.globalAlpha = 0.55 + 0.35 * pulse;
        ctx.beginPath();
        for (const m of cluster.members) {
          if (m.dead) continue;
          ctx.moveTo(m.x + ringR, m.y);
          ctx.arc(m.x, m.y, ringR, 0, Math.PI * 2);
        }
        ctx.stroke();
        // Centroid crosshair so it's clear what the camera is locked onto
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = Math.max(1, 1.2 / z);
        const cR = 14 + pulse * 4;
        ctx.beginPath();
        ctx.moveTo(cluster.cx - cR, cluster.cy);
        ctx.lineTo(cluster.cx - cR * 0.4, cluster.cy);
        ctx.moveTo(cluster.cx + cR * 0.4, cluster.cy);
        ctx.lineTo(cluster.cx + cR, cluster.cy);
        ctx.moveTo(cluster.cx, cluster.cy - cR);
        ctx.lineTo(cluster.cx, cluster.cy - cR * 0.4);
        ctx.moveTo(cluster.cx, cluster.cy + cR * 0.4);
        ctx.lineTo(cluster.cx, cluster.cy + cR);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

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
