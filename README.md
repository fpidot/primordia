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

## Architecture

- `js/sim.js` — particle pair-force, bond network, energy economy, wall types
- `js/brain.js` — variable-size CTRNN controller, mutation, crossover
- `js/genome.js` — gene encoding, mutation distributions, crossover
- `js/render.js` — Canvas2D field + particle pass, wall rendering, camera
- `js/audio.js` — vocalisation-driven synth voices + wall-action one-shots
- `js/lineage.js` — clade tracker, complexity metrics
- `js/gpu_pairforce.js` — WebGPU compute shader for pair-force + brain forward
- `tests/` — Node-runnable regression suite (deterministic seeded RNG)
