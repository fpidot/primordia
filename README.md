# Primordia

A browser-based artificial-life simulation: per-particle evolving genomes + chemistry field + bonded-cluster organisms + tactile brushes. No build step, no backend, runs entirely on the visitor's GPU/CPU.

## Run locally

```sh
python -m http.server 8765
# open http://localhost:8765/
# optional preview: http://localhost:8765/?worker=1
```

`?worker=1` runs the simulation inside a module worker and sends compact
snapshots back to the UI/render thread. It is a preview path for dense long
runs: core presets, brushes, saving/exporting, sterile terrain export, and
inspection work there, while live copy/import spawning is still main-thread
only.

## Run tests

```sh
npm test
```

## Field notes and user guide

- [A naturalist's note on the particles](docs/PARTICLES_NATURALIST_NOTE.md)
- [Quick start for first-time visitors](docs/QUICK_START.md)
- [Planetary ecology upgrade plan](docs/PLANETARY_ECOLOGY_PLAN.md)

## CPU timing probe

```sh
npm run bench:cpu -- maze 1200 1500 0xC0FFEE
node tools/bench-cpu.js --preset maze --ticks 500 --cap 1200 --seed 0xC0FFEE --profile --profileEvery 100
node tools/bench-cpu.js --preset planet --ticks 600 --cap 900 --seed 0xC1A0C0 --combat event --profileEvery 300
```

The CPU probe reports timing plus construction diagnostics (`wallDigs`,
`wallDeposits`, live `wallCarriers`, and cluster-bud counters through
`profileMetrics()`) so builder and organism-level reproduction regressions are
easy to spot during performance work. `--profileEvery` emits rolling phase
windows and line-of-sight counters (`losHashSkips`, `losWalks`, etc.) for
degradation checks. Habitat presets such as Planet also emit region metrics:
basin occupancy, mean energy, mud/glass use, food/decay/mutagen mass, species
entropy, profile-window movement between regions, and clade turnover/local
extinction by region. Profile windows also compare regional survival, deaths,
escapes, new particles, mean energy change, and per-region behavior deltas for
feeding, wall work, predation, attacks, counters, escapes, and combat damage.
Vitals and CPU JSON also include live movement telemetry: mean speed, fraction
of the energy-scaled velocity cap, mean motor effort, and high-speed fraction.
Use `--combat nibble` or `--combat event` to compare the legacy
contact-predation model against the event-style attack/counter/escape model
used by the browser app.

## Defense soak probe

```sh
node tools/defense-soak.js --preset soup --ticks 1200 --cap 900 --start 500 --seed 0x51A11 --samples 0,600,1200 --sampleSize 32 --challengeTicks 180 --combat event --predatorRatio 0.2 --hunterDrive 0.5 --hunterPreference 0 --hunterEnergy 5 --challengeRepeats 3 --challengeJitter 1
```

The defense probe evolves a population, snapshots cohorts, and replays them in
predator, mud-refuge, and glass-gap arenas. The hunter knobs above tune replay
pressure separately from the normal world, which keeps short challenge runs
from becoming too lethal to interpret. `--challengeRepeats` and
`--challengeJitter` reduce dependence on one exact placement. Add
`--cohortEnergy 5` when you want founder and descendant cohorts to enter replay
with identical starting energy. Replay results also include cohort-owned
behavior counters: field energy, predation energy, attacks, kills, counters,
escapes, and combat damage given/taken.
Add `--replay both --clusterBudget 64 --clusterMaxClusters 3` to compare the
old particle cohort, intact top-cluster organisms, and disassembled controls
made from the same cluster member cells.

## Detour navigation assay

```sh
npm run assay:detour -- --ticks 600 --cap 600 --start 320 --seed 0xD370A --barrier glass --combat event
node tools/detour-assay.js --ticks 600 --cap 600 --start 320 --seed 0xD370A --barrier glass --combat event
node tools/detour-assay.js --evolveTicks 1200 --ticks 600 --cap 900 --start 320 --seed 0x51A11 --barrier glass --combat event --cohort elite
node tools/detour-suite.js --presets soup,maze,planet --seeds 0x51A11,0xA11CE --ticks 180 --evolveTicks 420 --cap 600 --start 320 --replays particles,clusters-intact,clusters-disassembled --combat event
node tools/detour-suite.js --presets soup,planet --seeds 0x51A11,0xA11CE --ticks 220 --evolveTicks 650 --evolveInArena --difficulty easy --combat event
node tools/detour-suite.js --presets soup,planet --seeds 0x51A11,0xA11CE --ticks 220 --evolveTicks 900 --curriculum ladder --difficulty medium --combat event
```

The detour assay creates a controlled vertical obstacle with two gaps, places a
food patch and scent field behind it, and tracks whether the near-side cohort
crosses, reaches the goal, survives, approaches either gap, gets stuck/slips
near the barrier, gains field or meat energy, and how fast it moves. It is an
evidence generator, not a pass/fail proof of planning; use it before and after
longer evolved-cohort runs to test whether obstacle navigation is becoming more
than random wandering. `--evolveTicks` soaks the source population before the
controlled arena is built; `--evolveInArena` soaks the source population inside
the challenge world; `--difficulty easy|medium|hard` changes gap generosity;
`--replay particles|clusters-intact|clusters-disassembled` compares individual
cells with intact/disassembled organism cohorts; and
`--cohort mixed|elite|random|all` chooses which live particles enter particle
replay. `--noScent`, `--scentRadiusCells`, and `--scentAmount` control whether
the goal signal actually reaches the start area. `--curriculum gap-adjacent`
or `--curriculum ladder` makes the source population evolve through
training-only gap worlds before the final controlled replay, so you can test
whether easier obstacle experiences improve later detour behavior.

## Browser timing probe

Start the local server first, then run:

```sh
npm run bench:browser -- maze 6 4
node tools/bench-browser.js maze 6 4 9230 --gpu
node tools/bench-browser.js --preset maze --seconds 8 --speed 4 --seed 0xC0FFEE --gpu
node tools/bench-browser.js --preset maze --seconds 10 --speed 4 --seed 0xC0FFEE --gpu --gpuPairOnly
node tools/bench-browser.js --preset maze --seconds 75 --speed 4 --seed 0xC0FFEE --profile --profileEvery 300 --zoom 0.35
node tools/bench-browser.js --preset maze --seconds 5 --speed 4 --seed 0xC0FFEE --profile --zoom 0.35 --worker --workBudget 12 --fieldInterval 500 --wallInterval 240
```

The browser probe launches Chrome/Edge through the DevTools protocol and
reports FPS, sim ticks/sec, GPU availability, WebGPU readback timings, and
adaptive GPU cooldown telemetry. Use `--seed` for CPU/GPU comparisons that
start from the same preset state; use `--gpuPairOnly` to test the experimental
smaller-readback GPU pair-force mode; use `--profileEvery` for long-run
degradation windows; use `--profile` and `--zoom` to inspect sim/render/frame
costs and low-zoom LOD behavior. Use `--worker` to benchmark the worker-owned
simulation path; `--workBudget` controls how much wall-clock time each worker
slice may spend advancing ticks before it posts another snapshot. Worker
bench output includes layer counts; `--fieldInterval` and `--wallInterval`
control how often larger field/terrain buffers are refreshed relative to
lighter particle/cluster snapshots.

## Preset population

The Presets panel includes an initial-population slider. Presets scale their
starting population to that value, including zero-particle starts for terrain
inspection or manual seeding.

Available terrain-heavy starts now include Maze and Planet. Maze is a tighter
constraint course; Planet is a niche-rich habitat with protected food oases,
mud rings, glass arcs, thick diggable ridges, quarries, decay pockets, and
mutagen cracks. Planet defaults to 720 particles; raise the initial-population
slider when you want a heavier stress ecology.

## Architecture

Worker preview files: `js/sim_worker.js`, `js/snapshot.js`, and
`js/worker_runtime.js`.

- `js/sim.js` — particle pair-force, bond network, energy economy, wall types
- `js/brain.js` — variable-size CTRNN controller, mutation, crossover
- `js/genome.js` — gene encoding, mutation distributions, crossover
- `js/render.js` — Canvas2D field + particle pass, wall rendering, camera
- `js/audio.js` — vocalisation-driven synth voices + wall-action one-shots
- `js/lineage.js` — clade tracker, complexity metrics
- `js/region_metrics.js` — habitat/region occupancy, niche, survival, turnover,
  and behavior telemetry
- `js/gpu_pairforce.js` — WebGPU compute shader for pair-force + brain forward
- `tests/` — Node-runnable regression suite (deterministic seeded RNG)
