# Primordia

A browser-based artificial-life simulation: per-particle evolving genomes + chemistry field + bonded-cluster organisms + tactile brushes. No build step, no backend, runs entirely on the visitor's GPU/CPU.

## Run locally

```sh
python -m http.server 8765
# open http://localhost:8765/
```

## Run tests

```sh
npm test
```

## Field notes and user guide

- [A naturalist's note on the particles](docs/PARTICLES_NATURALIST_NOTE.md)
- [Quick start for first-time visitors](docs/QUICK_START.md)

## CPU timing probe

```sh
npm run bench:cpu -- maze 1200 1500 0xC0FFEE
```

The CPU probe reports timing plus construction diagnostics (`wallDigs`,
`wallDeposits`, and live `wallCarriers`) so builder regressions are easy to
spot during performance work.

## Browser timing probe

Start the local server first, then run:

```sh
npm run bench:browser -- maze 6 4
node tools/bench-browser.js maze 6 4 9230 --gpu
```

The browser probe launches Chrome/Edge through the DevTools protocol and
reports FPS, sim ticks/sec, GPU availability, and WebGPU readback timings.

## Preset population

The Presets panel includes an initial-population slider. Presets scale their
starting population to that value, including zero-particle starts for terrain
inspection or manual seeding.

## Architecture

- `js/sim.js` — particle pair-force, bond network, energy economy, wall types
- `js/brain.js` — variable-size CTRNN controller, mutation, crossover
- `js/genome.js` — gene encoding, mutation distributions, crossover
- `js/render.js` — Canvas2D field + particle pass, wall rendering, camera
- `js/audio.js` — vocalisation-driven synth voices + wall-action one-shots
- `js/lineage.js` — clade tracker, complexity metrics
- `js/gpu_pairforce.js` — WebGPU compute shader for pair-force + brain forward
- `tests/` — Node-runnable regression suite (deterministic seeded RNG)
