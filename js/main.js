// main.js — boots Primordia and drives the animation loop.

import {
  World, GW, GH, CELL, HW, HH, HASH_CELL, R_CLOSE, K_REP, K_ATTR,
} from './sim.js';
import { NUM_SPECIES } from './genome.js';
import { Renderer, PopulationChart, Camera } from './render.js';
import { UI } from './ui.js';
import { PRESETS } from './presets.js';
import { gpu } from './gpu.js';
import { GPUPairForce } from './gpu_pairforce.js';
import { audioHum } from './audio.js';

const world = new World();
const bgCanvas = document.getElementById('canvas-bg');
const fgCanvas = document.getElementById('canvas-fg');
const camera = new Camera();
const renderer = new Renderer(bgCanvas, fgCanvas, camera);
const chart = new PopulationChart(document.getElementById('chart'));
const stage = document.querySelector('.stage');

// Fit camera to stage on first layout
renderer.resizeIfNeeded();
camera.fit();

const ui = new UI({
  world, renderer, camera, chart,
  bgCanvas, stage,
  onPresetLoaded: (name) => {
    document.getElementById('hint').textContent =
      `${name} loaded · drag to paint · scroll to zoom · middle-drag to pan`;
  },
});

// Re-fit camera when stage resizes
new ResizeObserver(() => {
  renderer.resizeIfNeeded();
  // keep current focal point but clamp
  camera.clamp();
}).observe(stage);

// Seed world with the default preset
PRESETS.soup(world);
ui.refreshStats();

// ─────────────────────────────────────────────── animation loop

let last = performance.now();
let acc = 0;
let fpsAcc = 0;
let fpsFrames = 0;
let statsTimer = 0;
let chartTimer = 0;
const STEP_FRAME_BUDGET_MS = 12;
const MAX_STEP_BACKLOG = 12;

async function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (!ui.paused) {
    acc += ui.speed;
    if (acc > MAX_STEP_BACKLOG) acc = MAX_STEP_BACKLOG;
    let steps = 0;
    const stepStart = performance.now();
    while (acc >= 1 && steps < 8) {
      await world.step();
      acc -= 1;
      steps++;
      if (performance.now() - stepStart > STEP_FRAME_BUDGET_MS) break;
    }
  }

  camera.tickFollow(world);
  renderer.render(world);
  audioHum.tick(world, dt, camera);

  if (!ui.paused && world.tick % 4 === 0) {
    chart.push(world.tick, world.populationBySpecies());
  }

  statsTimer += dt;
  chartTimer += dt;
  if (chartTimer > 0.16) {
    chart.draw();
    chartTimer = 0;
  }
  if (statsTimer > 0.16) {
    ui.refreshStats();
    statsTimer = 0;
  }

  // FPS only counts unpaused frames — display stays frozen on whatever the
  // last live reading was while paused, instead of jittering with display
  // refresh rate while no sim work is happening.
  if (!ui.paused) {
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc > 0.5) {
      ui.setFps(fpsFrames / fpsAcc);
      fpsAcc = 0; fpsFrames = 0;
    }
  } else {
    fpsAcc = 0; fpsFrames = 0;
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Kick off WebGPU init in the background. Once ready, build the pair-force
// kernel and attach it to the world. The UI toggle drives whether step() uses it.
gpu.init().then(ok => {
  if (ok && gpu.device) {
    try {
      const kernel = new GPUPairForce(gpu.device, {
        maxParticles: world.maxParticles,
        hashW: HW, hashH: HH, hashCell: HASH_CELL,
        gridW: GW, gridH: GH, gridCell: CELL,
        numSpecies: NUM_SPECIES,
        rClose: R_CLOSE, kRep: K_REP, kAttr: K_ATTR,
      });
      world.attachGPU(kernel);
    } catch (err) {
      gpu.errors.push(`kernel build: ${err.message || err}`);
      gpu.status = `kernel build failed: ${err.message || err}`;
    }
  }
  ui.onGPUStatusChange?.(gpu.describe());
});

window.__primordia = { world, renderer, ui, camera, chart, gpu, audioHum, PRESETS };
