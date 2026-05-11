// tools/bench-browser.js - browser FPS/tick probe via Chrome DevTools Protocol.
//
// Usage:
//   npm run bench:browser -- --url http://localhost:8765/ --preset maze --seconds 8 --speed 4
//   npm run bench:browser -- --gpu

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function readArg(name, fallback = null) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return fallback;
  if (idx + 1 >= process.argv.length || process.argv[idx + 1].startsWith('--')) return true;
  return process.argv[idx + 1];
}

const positional = process.argv.slice(2).filter(arg => !arg.startsWith('--'));

function browserPath() {
  const explicit = readArg('browser', null);
  const candidates = [
    explicit,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find(p => existsSync(p));
}

async function waitForJson(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastErr || new Error(`timed out waiting for ${url}`);
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  async open(timeoutMs = 10000) {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket open timeout')), timeoutMs);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket error')); }, { once: true });
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async close() {
    try { this.ws.close(); } catch {}
  }
}

const url = String(readArg('url', 'http://localhost:8765/'));
const preset = String(readArg('preset', positional[0] || 'maze'));
const seconds = Math.max(1, Number(readArg('seconds', positional[1] || 8)) || 8);
const speed = Math.max(0.25, Number(readArg('speed', positional[2] || 4)) || 4);
const workBudget = Math.max(1, Number(readArg('workBudget', readArg('budget', 12))) || 12);
const maxParticlesArg = readArg('maxParticles', readArg('populationCap', readArg('cap', null)));
const maxParticles = maxParticlesArg == null
  ? null
  : Math.max(1, Math.floor(Number(maxParticlesArg) || 0));
const fieldSnapshotInterval = Math.max(80, Number(readArg('fieldSnapshotInterval', readArg('fieldInterval', 500))) || 500);
const wallSnapshotInterval = Math.max(80, Number(readArg('wallSnapshotInterval', readArg('wallInterval', 240))) || 240);
const warmup = Math.max(0, Number(readArg('warmup', 1000)) || 0);
const seedArg = readArg('seed', null);
const wantGpu = !!readArg('gpu', false);
const gpuFull = !!readArg('gpuFull', false);
const gpuPairOnly = readArg('gpuPairOnly', null);
const wantWorker = !!readArg('worker', false);
const profileEvery = Math.max(0, Number(readArg('profileEvery', readArg('profileEveryTicks', 0))) | 0);
const wantProfile = !!readArg('profile', false) || profileEvery > 0;
const zoomArg = readArg('zoom', null);
const width = Math.max(320, Number(readArg('width', 1440)) || 1440);
const height = Math.max(320, Number(readArg('height', 1000)) || 1000);
const port = Math.max(1024, Number(readArg('port', positional[3] || 9225)) || 9225);
const headless = readArg('headed', false) ? false : true;
const benchUrl = wantWorker
  ? (() => {
      const u = new URL(url);
      u.searchParams.set('worker', '1');
      return u.toString();
    })()
  : url;

const exe = browserPath();
if (!exe) {
  console.error('No Chrome or Edge executable found. Use --browser <path>.');
  process.exit(1);
}

const profile = await mkdtemp(join(tmpdir(), 'primordia-browser-bench-'));
const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  `--window-size=${width},${height}`,
  url,
];
if (headless) args.unshift('--headless=new');
const browser = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
browser.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 2000); });
let eventTimer = null;

try {
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const pageInfo = tabs.find(t => t.type === 'page') || tabs[0];
  if (!pageInfo?.webSocketDebuggerUrl) throw new Error('No debuggable page found');
  const cdp = new CDP(pageInfo.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.call('Page.enable');
  await cdp.call('Runtime.enable');
  const pageErrors = [];
  eventTimer = setInterval(() => {
    while (cdp.events.length) {
      const evt = cdp.events.shift();
      if (evt.method === 'Runtime.exceptionThrown') {
        const ex = evt.params?.exceptionDetails;
        pageErrors.push(ex?.exception?.description || ex?.text || 'page exception');
      } else if (evt.method === 'Runtime.consoleAPICalled') {
        const type = evt.params?.type;
        if (type === 'error' || type === 'warning') {
          const args = evt.params?.args || [];
          pageErrors.push(args.map(a => a.value ?? a.description ?? '').join(' ') || `console.${type}`);
        }
      }
    }
    if (pageErrors.length > 12) pageErrors.splice(0, pageErrors.length - 12);
  }, 50);
  await cdp.call('Page.navigate', { url: benchUrl });
  await new Promise(resolve => setTimeout(resolve, 1500));

  const expression = `
    (async () => {
      const app = window.__primordia;
      if (!app) throw new Error('window.__primordia missing');
      const { world, renderer, ui, camera, chart, PRESETS, gpu, frameProfile } = app;
      if (!PRESETS['${preset}']) throw new Error('unknown preset ${preset}');
      if (world.ready) await world.ready;
      const maxParticles = ${maxParticles == null ? 'null' : maxParticles};
      if (maxParticles != null) {
        if (typeof world.setMaxParticles === 'function') await world.setMaxParticles(maxParticles);
        else world.maxParticles = maxParticles;
      }
      const seedValue = ${seedArg == null ? 'null' : JSON.stringify(String(seedArg))};
      if (seedValue != null) {
        let seed = Number(seedValue);
        if (!Number.isFinite(seed)) {
          seed = 0;
          for (let i = 0; i < seedValue.length; i++) seed = ((seed << 5) - seed + seedValue.charCodeAt(i)) | 0;
        }
        Math.random = (() => {
          let t = seed >>> 0;
          return () => {
            t += 0x6D2B79F5;
            let r = Math.imul(t ^ (t >>> 15), 1 | t);
            r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
          };
        })();
      }
      if (world.applyPreset) {
        await world.applyPreset('${preset}', undefined, seedValue);
        await new Promise(resolve => setTimeout(resolve, 120));
      } else {
        PRESETS['${preset}'](world);
      }
      chart.data.length = 0;
      camera.fit();
      const zoomValue = ${zoomArg == null ? 'null' : JSON.stringify(String(zoomArg))};
      if (zoomValue != null) {
        const z = Number(zoomValue);
        if (Number.isFinite(z) && z > 0) {
          camera.zoom = z;
          camera.clamp();
        }
      }
      ui.refreshStats();
      ui.speed = ${speed};
      ui.workBudgetMs = ${workBudget};
      ui.paused = false;
      if (world.setRunState) {
        world.setRunState({
          paused: ui.paused,
          speed: ui.speed,
          workBudgetMs: ui.workBudgetMs || 12,
          fieldSnapshotIntervalMs: ${fieldSnapshotInterval},
          wallSnapshotIntervalMs: ${wallSnapshotInterval},
        });
      }
      const wantProfile = ${wantProfile ? 'true' : 'false'};
      const profileEvery = ${profileEvery};
      if (wantProfile) {
        if (typeof world.setProfiling === 'function') world.setProfiling(true);
        if (renderer && typeof renderer.setProfiling === 'function') renderer.setProfiling(true);
        if (frameProfile) {
          frameProfile.reset?.();
          frameProfile.enabled = true;
        }
      }

      const wantGpu = ${wantGpu ? 'true' : 'false'};
      const gpuFull = ${gpuFull ? 'true' : 'false'};
      const gpuPairOnlyArg = ${gpuPairOnly == null ? 'null' : JSON.stringify(String(gpuPairOnly))};
      if (gpuFull && typeof world.setGPUPairOnly === 'function') {
        world.setGPUPairOnly(false);
      } else if (gpuPairOnlyArg != null && typeof world.setGPUPairOnly === 'function') {
        world.setGPUPairOnly(gpuPairOnlyArg !== 'false' && gpuPairOnlyArg !== '0');
      }
      let gpuReady = false;
      if (world.isWorkerProxy) {
        gpuReady = false;
        if (gpu) gpu.setEnabled(false);
      } else if (wantGpu) {
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline && !world._gpu) {
          await new Promise(requestAnimationFrame);
        }
        gpuReady = !!world._gpu;
        if (gpu && gpuReady) gpu.setEnabled(true);
        world.setGPUEnabled(gpuReady);
      } else {
        if (gpu) gpu.setEnabled(false);
        world.setGPUEnabled(false);
      }

      const warmupUntil = performance.now() + ${warmup};
      while (performance.now() < warmupUntil) {
        await new Promise(requestAnimationFrame);
      }

      const duration = ${seconds * 1000};
      const startTick = world.tick;
      const start = performance.now();
      let frames = 0;
      let lastProfileTick = startTick;
      let lastProfileTime = start;
      let lastProfileFrame = 0;
      let nextProfileTick = profileEvery > 0 ? startTick + profileEvery : Infinity;
      const profileTrend = [];
      let minFrameMs = Infinity;
      let maxFrameMs = 0;
      let last = start;
      while (performance.now() - start < duration) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        const dt = now - last;
        if (dt < minFrameMs) minFrameMs = dt;
        if (dt > maxFrameMs) maxFrameMs = dt;
        last = now;
        frames++;
        while (profileEvery > 0 && world.tick >= nextProfileTick) {
          const profileNow = performance.now();
          const windowTicks = Math.max(1, world.tick - lastProfileTick);
          const windowMs = Math.max(1, profileNow - lastProfileTime);
          const windowFrames = frames - lastProfileFrame;
          profileTrend.push({
            tick: world.tick,
            elapsedMs: Math.round(profileNow - start),
            windowTicks,
            windowMsPerTick: +(windowMs / windowTicks).toFixed(3),
            windowFrames,
            windowFps: +(windowFrames / windowMs * 1000).toFixed(1),
            sim: world.profileSnapshot ? world.profileSnapshot({ reset: true }) : null,
            render: renderer && renderer.profileSummary ? renderer.profileSummary({ reset: true }) : null,
            frame: frameProfile && frameProfile.summary ? frameProfile.summary({ reset: true }) : null,
            gpuPipeline: {
              usedTicks: world._gpuTicksUsed || 0,
              fallbackTicks: world._gpuTicksFallback || 0,
              pendingReadbacks: world._gpuPendings ? world._gpuPendings.length : 0,
              lastResultAge: world._gpuLastResultAge || 0,
              adaptiveCooldownTicks: world._gpuCooldownTicks || 0,
              adaptiveCooldowns: world._gpuAdaptiveCooldowns || 0,
              pairOnly: !!world._gpuPairOnly,
              resultStride: world._gpuResultStride || 0,
            },
            population: world.particles.length,
            walls: world._wallCount,
          });
          lastProfileTick = world.tick;
          lastProfileTime = profileNow;
          lastProfileFrame = frames;
          nextProfileTick += profileEvery;
        }
      }
      const elapsed = performance.now() - start;
      ui.paused = true;
      if (world.setRunState) {
        world.setRunState({
          paused: true,
          speed: ui.speed,
          workBudgetMs: ui.workBudgetMs || 12,
          fieldSnapshotIntervalMs: ${fieldSnapshotInterval},
          wallSnapshotIntervalMs: ${wallSnapshotInterval},
        });
      }
      const profile = wantProfile ? {
        sim: world.profileSnapshot ? world.profileSnapshot() : null,
        render: renderer && renderer.profileSummary ? renderer.profileSummary() : null,
        frame: frameProfile && frameProfile.summary ? frameProfile.summary() : null,
      } : null;
      if (frameProfile) frameProfile.enabled = false;
      return {
        preset: '${preset}',
        seed: seedValue,
        workerMode: !!world.isWorkerProxy,
        maxParticles: world.maxParticles || 0,
        workerSnapshots: world._snapshotCount || 0,
        workerStatus: world._workerStatus || null,
        workerLayers: world._workerLayerStats || null,
        workBudgetMs: ui.workBudgetMs || 12,
        fieldSnapshotIntervalMs: ${fieldSnapshotInterval},
        wallSnapshotIntervalMs: ${wallSnapshotInterval},
        requestedGpu: wantGpu,
        gpuReady,
        gpuEnabled: world.isGPUEnabled(),
        gpuStatus: gpu ? gpu.describe() : null,
        gpuKernel: world._gpu ? {
          dispatchCount: world._gpu.dispatchCount || 0,
          uploadMs: +(world._gpu.lastUploadMs || 0).toFixed(2),
          dispatchMs: +(world._gpu.lastDispatchMs || 0).toFixed(2),
          readbackMs: +(world._gpu.lastReadbackMs || 0).toFixed(2),
          readbackBytes: world._gpu.lastReadbackBytes || 0,
          readbackStride: world._gpu.lastReadbackStride || 0,
          lastError: world._gpu.lastError || null,
        } : null,
        gpuPipeline: {
          usedTicks: world._gpuTicksUsed || 0,
          fallbackTicks: world._gpuTicksFallback || 0,
          pendingReadbacks: world._gpuPendings ? world._gpuPendings.length : 0,
          lastResultAge: world._gpuLastResultAge || 0,
          adaptiveCooldownTicks: world._gpuCooldownTicks || 0,
          adaptiveCooldowns: world._gpuAdaptiveCooldowns || 0,
          pairOnly: !!world._gpuPairOnly,
          resultStride: world._gpuResultStride || 0,
        },
        elapsedMs: Math.round(elapsed),
        frames,
        fps: +(frames / elapsed * 1000).toFixed(1),
        minFrameMs: +minFrameMs.toFixed(2),
        maxFrameMs: +maxFrameMs.toFixed(2),
        ticks: world.tick - startTick,
        ticksPerSecond: +((world.tick - startTick) / elapsed * 1000).toFixed(1),
        population: world.particles.length,
        walls: world._wallCount,
        profile,
        profileTrend: profileTrend.length ? profileTrend : undefined,
      };
    })()
  `;
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: (seconds + 10) * 1000,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  console.log(JSON.stringify({
    ...result.result.value,
    pageErrors,
  }, null, 2));
  await cdp.close();
  clearInterval(eventTimer);
} catch (err) {
  console.error(err.message || err);
  if (stderr) console.error(stderr.trim().split('\n').slice(0, 5).join('\n'));
  process.exitCode = 1;
} finally {
  if (eventTimer) clearInterval(eventTimer);
  if (!browser.killed) browser.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
