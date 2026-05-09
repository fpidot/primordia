# Primordia Codex handoff

This is the durable, portable context packet for continuing Primordia from
another machine, another Codex desktop thread, or Codex cloud. It exists because
the Codex desktop app does not appear to provide a direct "move this exact
thread and all chat history to another device" workflow. Treat this file,
`ROADMAP.md`, and git history as the canonical cross-device memory.

If this file conflicts with current code, trust the code and update this file.

## Fastest restart on another machine

Fresh clone:

```powershell
git clone https://github.com/fpidot/primordia.git
cd primordia
git status -sb
```

Then start a new Codex thread from the clone and say:

```text
Please take over development of this local Primordia clone. First read
CODEX_HANDOFF.md and ROADMAP.md, inspect git status and the latest commits on
main, then continue from the current roadmap. Keep commits/pushes happening at
the end of each meaningful pass.
```

If using Codex cloud instead of local desktop, start a task against
`fpidot/primordia` and paste the same instruction. Cloud will have repo context,
but not this desktop chat unless you paste or commit the needed context.

## Current repo state

- Original local path:
  `C:\Users\flipp\Documents\New project\primordia`
- Remote: `https://github.com/fpidot/primordia.git`
- Branch: `main`
- GitHub Pages deploys automatically from pushes to `main`.
- At this handoff, the working tree should be clean after commit/push.
- Latest durable context checkpoint:
  current `main` HEAD after this pass: `Make predation economy measurable`

Recent useful commits:

- current `main` HEAD - Make predation economy measurable
- `2e790dd` - Add motor slip proprioception
- `ae44643` - Reserve headroom for cluster budding
- `cf04f2c` - Record cluster budding soak results
- `6a85b9a` - Label cluster bud generations
- `d3a2097` - Add cluster-level budding reproduction
- `b688116` - Add experimental pair-only GPU assist
- `7ea2a8f` - Improve long-run browser broad phase
- `32234f7` - Add coarse visibility cache
- `5dc0e85` - Add render LOD and profiling
- `c6ad5e3` - Add adaptive GPU cadence
- `576432c` - Clarify bonds in quick start
- `5432b68` - Add in-app guide popups
- `81b69b2` - Add field notes and quick start docs
- `33e144b` - Add Codex handoff guide
- `702cf38` - Pipeline GPU readbacks through slots
- `b5368d5` - Respect solid line of sight
- `9e97544` - Add typed terrain sensors
- `849b81a` - Expand Primordia simulation tooling and inspection

## Collaboration policy

- Commit and push each meaningful pass. This is now part of the workflow because
  the user may switch machines, and git is the cross-device continuity layer.
- Keep changes focused and test-backed. This repo is complex enough that broad
  "cleanup" can erase behavioral scaffolding.
- Update `ROADMAP.md` whenever a design decision changes or a new user note
  becomes part of the plan.
- Do not revert user or other-agent changes unless explicitly asked.
- For frontend or WebGPU work, always run a browser smoke/bench. Node tests
  cannot catch WGSL, browser validation, visual layout, or GPU binding errors.
- Prefer local conventions and existing architecture over new frameworks.
- Preserve save compatibility where possible, especially sensor and action
  indices. Append inputs/outputs rather than reordering existing slots.

## Project north star

Primordia is an evolving artificial-life simulation. The user wants organisms
and ecosystems that can become more capable without being hand-scripted into
specific solutions.

Highest-level goals:

- communication that pays for itself behaviorally
- coordinated, goal-driven cluster behavior
- goal-driven wall building and digging
- stable but selection-rich ecosystems
- continued possible escalation of brain power and evolutionary fitness, with
  computational caps pushed as high as feasible
- obstacle navigation emerging from sufficient senses, recurrent brains,
  selection pressure, and possibly cluster-level specialization
- clusters that can act like multicellular organisms: some members sense,
  others message, others locomote, dig, defend, forage, or build
- rich inspection/export tooling so evolved behavior can be studied, saved,
  duplicated, combined, and reintroduced
- listenable, organic simulation music rather than harsh novelty noise

The critical philosophical constraint: do not hard-code intelligence. Add raw
materials, sensors, actions, pressures, and feedback loops so intelligence can
emerge and be measured.

## Current simulation model

Core systems:

- particle genomes and CTRNN-like brains
- food and decay chemistry fields
- mutagen field
- sound channels
- visual RGB signal channels
- bond messages and named clusters
- cluster alarm broadcast
- cluster-level budding reproduction for stable, energy-rich bonded organisms
- wall digging/depositing with carried wall material
- wall metadata: builder particle, builder cluster, clade, deposited tick
- import/export for particles, species/clades, clusters, and sterile worlds
- CPU simulation path
- WebGPU pair-force/brain path with CPU fallback
- browser and Node regression/bench tooling

Terrain semantics:

- solid wall:
  - blocks movement
  - blocks chemistry and sound
  - blocks direct particle/signal line of sight
  - is diggable
- glass:
  - blocks movement
  - transmits chemistry and sound
  - transmits direct particle/signal line of sight
  - functions as a transparent barrier
- mud:
  - does not block movement
  - slows and energy-drains particles inside it
  - transmits chemistry and sound
  - transmits direct particle/signal line of sight
  - is visible to brains as terrain

Important recent sensor state:

- Existing brain sensor indices are save-sensitive.
- `terrain.mud` remains at index 45.
- Typed material sensors were appended:
  - `solid.n/s/e/w`
  - `glass.n/s/e/w`
- Proprioception sensors were appended after terrain:
  - `self.vx/self.vy`
  - `motor.prev.x/motor.prev.y`
  - `motor.progress`
  - `motor.slip`
- Old wall/mud slots remain stable.
- CPU and GPU terrain/proprioception sensor paths are wired for parity.

## Recently shipped behavior

Inspection and UI:

- cards clamp inside the viewport
- right-click drag pans
- particle cards support chase particle/cluster
- stop chase clears all chase modes
- cluster labels are cleaner:
  - no ubiquitous `-band`
  - trait/color words are joined for display
  - human-name suffixes are expanded and avoid color-name collisions
- cluster membranes stay visible when cluster labels/flags are off
- chased clusters pulse membrane rather than flashing every member
- wall segments are inspectable and preserve builder/cluster metadata
- current best/top panels can copy/export/view/chase, though polish remains open
- stable, energy-rich bonded clusters can occasionally bud a daughter cluster:
  the daughter inherits mutated member genomes, starts internally bonded, and
  costs the parent cluster real energy
- daughter/granddaughter organism labels append generation suffixes:
  founder clusters have no suffix, daughters show `Jr`, then `III`, `IV`, etc.

Export/import:

- individual specimens can be exported/copied/imported
- clusters can be exported/copied/imported
- clades/species templates can be exported/copied
- sterile world templates can be exported/imported
- live ranking panels exist for useful candidates and top clusters

Environment:

- preset initial population is user-selectable
- empty preset button was removed; use zero population instead
- maze/world generation includes richer material constraints, but still needs
  more tuning for thicker walls, isolation, protection, raw materials, mud
  zones, food oases, and reusable challenge worlds

Audio:

- reverb was removed
- audio defaults were discussed both ways; latest desired direction was audio
  off by default because "checked but silent until interaction" confused users
- death sound should represent mass-casualty events only, not ordinary turnover
- digging/depositing should snap to the musical grid
- add rare goofy-but-sonorous timbres: human-ish boop, boing, plops, scratches
- make some events sustain/decay longer when meaningful or high energy
- expand note range by about an octave for common tones
- avoid loud clap-like events
- consider a richer WebAudio/Tone/soundfont style layer for organic timbres

## Performance state

CPU:

- Full Node suite passes.
- CPU maze 500-tick cap-1200 probes vary by run/load, with recent values around
  the low-to-mid 20 ms/tick range and sometimes worse under load.
- CPU hot-loop work already done:
  - reduced repeated allocations
  - cached cluster membership pointers
  - throttled chart redraws
  - visible-region render culling
  - merged repeated wall/mud/material proximity scans
- CPU bench now supports `--profileEvery`, which records rolling phase windows,
  population/cluster/wall metrics, and line-of-sight counters. The current CPU
  path uses 48px radius-aware neighbor hash scans plus a prefix-sum solid-wall
  visibility grid before exact line walks. A same-tick particle-pair
  line-of-sight cache was tested and removed because Map overhead outweighed
  saved queries in the seeded maze probe.

GPU:

- WebGPU smoke currently passes without page/GPU errors.
- GPU path includes pair-force and brain-forward kernels.
- Hidden brain state stays GPU-resident.
- Direct solid line-of-sight parity was added to GPU by packing a solid-wall
  visibility grid into the existing extras buffer, avoiding a ninth storage
  binding that exceeded default WebGPU per-stage limits on the Intel sample.
- GPU readback now uses a 3-slot ring of readback buffers.
- The simulation consumes only age-1 same-order GPU results; stale results are
  discarded.
- If CPU fallback performs a brain step, GPU brain state is marked dirty so the
  next GPU dispatch resyncs from CPU state.
- Browser bench and UI now report:
  - used GPU ticks
  - fallback ticks
  - pending readbacks
  - last result age
  - adaptive cooldown ticks/cooldown count
- Browser bench accepts `--profile`, `--profileEvery`, and `--zoom`. Profiling
  reports sim, renderer, and frame phase costs; rolling windows show when
  population growth, rendering, UI, or audio is responsible for degradation.
  Low-zoom probes can confirm wall tile LOD and particle density LOD are active.

Performance reality:

- The readback-slot pass improves scheduling resilience and diagnostics.
- A follow-up pass tightened the CPU side of GPU mode: when a fresh GPU result
  is consumed, the CPU neighbor loop no longer repeats full sensory-radius
  pair/stat/line-of-sight work. It keeps only contact-range biology
  (predation/bond formation) and CPU-only bond-barrier checks.
- Adaptive cadence now samples GPU briefly and enters a 300-tick cooldown if
  the recent used/fallback ratio is poor or readback is too slow. The user
  toggle remains on, but dispatch pauses; CPU remains the reference path.
- Recent local headless Chrome/Intel samples after this pass:
  - dense maze GPU before adaptive: about 19.9 ticks/sec, readback around 55 ms
  - seeded dense maze, 5s: adaptive GPU about 25.3 ticks/sec, CPU-only about
    26.6
  - seeded dense maze, 8s: adaptive GPU about 26.5 ticks/sec, CPU-only about
    24.0
  - open soup adaptive GPU: 4s probes still show startup tax, while an 8s run
    recovered to about 35 ticks/sec after cooldown
- Latest low-zoom browser profile, seeded dense maze, 5s, CPU-only, `--zoom
  0.35`: about 28.1 FPS/ticks/sec, render about 4.2 ms/frame, sim step about
  28.5 ms/frame, wall mode `tile-lod`, particle mode `density-lod`, no page
  errors.
- Latest matching GPU profile on this Intel sample: about 25.4 FPS/ticks/sec,
  readback about 59 ms, adaptive cooldown engaged. GPU remains useful to probe
  but not yet a guaranteed dense-maze win on this hardware.
- Latest CPU probe, seeded dense maze, cap 1200, 1800 ticks, CPU-only:
  about 21.1 ms/tick / 47 ticks/sec locally after the radius-aware broad phase
  and prefix visibility grid. Window costs generally fell toward ~18.7-24.8
  ms/tick as population stayed capped near 1200.
- Browser degradation diagnosis, seeded dense maze, low zoom, CPU-only:
  rolling browser windows reproduced the user's report and showed the slowdown
  is sim-step/population dominated. Before the radius/prefix pass, tick ~1233
  was about 20 FPS with step around 44 ms/frame. After the pass, a comparable
  tick ~1214 window was about 28.5 FPS with step around 30 ms/frame.
- Longer 75s browser soak after the pass still degraded as population exceeded
  3k: tick ~1513 was about 20 FPS at ~2718 particles, while tick ~1813 was
  about 15 FPS at ~3223 particles. Render remained only ~4.4 ms/frame, so this
  is not a draw/LOD issue.
- Experimental pair-force-only GPU mode now exists for measurement:
  `tools\bench-browser.js --gpu --gpuPairOnly`. It skips GPU brain forward,
  reads back 20 floats/particle instead of 30, preserves quadrant sensory stats
  for CPU brains, and reports readback bytes/stride in the browser bench. A
  short seeded maze smoke showed pair-only readback around 7 ms versus full GPU
  around 42 ms in the same noisy short-run shape. A longer 45s serial probe was
  not a reliable win versus CPU-only on the Intel sample; late windows still hit
  map waits/cooldowns and population-trajectory divergence. The app therefore
  keeps full GPU as the default mode, with pair-only available through the
  bench/API for further testing.
- The likely next big win is now structural: decouple sim from render with a
  worker/snapshot architecture or expose explicit population/work budgets for
  dense long soaks.

Next performance target:

- Prioritize a worker/snapshot architecture so UI/render FPS can stay
  responsive while sim ticks run as fast as the budget allows.
- Continue pair-only GPU benchmarking only if a targeted change addresses
  map-wait/cooldown behavior; the first smaller-readback pass is not enough by
  itself.
- Revisit CPU pair-loop structure only with a lower-write design; the naive
  per-agent accumulator version underperformed despite fewer line walks.
- Tune adaptive cadence with longer headed-browser runs on both the desktop and
  laptop, especially short-run startup tax versus long-run recovery.
- Prefer `tools\bench-browser.js --seed 0xC0FFEE` for CPU/GPU comparisons;
  unseeded browser presets are too variable to support precise conclusions.

Be careful: full GPU brain mode needs output readback for many CPU-side systems
that currently apply outputs, reproduction, deaths, wall actions, and metadata.

## Agency and emergence state

Food sensing:

- Particles sense food as chemical concentration and gradient, not as a
  discrete object.
- Food behind glass/mud should be chemically detectable if the field reaches
  the particle.
- User observation: dropped food sometimes appears ignored. Existing regression
  proves isolated chemotaxis works, so the open question is whether the signal
  is too weak in crowded/ecological conditions, gradients are too local, or
  neural/motor outputs overpower genome-level food force.

Predation and food pressure:

- Ambient field food is intentionally lower than early builds, and predation
  is now a richer but riskier meal: contact, attraction/cohesion, prey
  preference, and optional hunt coordination all have to line up.
- The transfer is now capped by victim energy, so a strong hunter cannot gain
  more energy than the prey actually had.
- The sim now tracks:
  - field food eaten
  - field-food energy gained
  - hunt contact events
  - victim energy drained by predation
  - predator energy gained from meat
  - direct fatal drains
  - deaths within a short window after predation
- Vitals and CPU bench output expose the meat-vs-field economy directly.
- Latest measured soak:
  `node tools\bench-cpu.js --preset soup --ticks 1800 --cap 1200 --seed 0x51A11 --profileEvery 600`
  ended with population 1173, born 3630, died 2457, field energy
  107983.797, predation energy 147985.021, 463349 hunt contacts, no direct
  fatal drains, and 1483 predation-attributed deaths.
- Interpretation: predation is not absent. It already supplies major energy
  and mortality pressure in that seed. The next question is whether avoidance,
  kin defense, mud/glass exploitation, cluster alarms, and defensive topology
  evolve under that pressure.
- Defense testing harness now exists:
  `tools/defense-soak.js`.
  It runs an evolution soak, snapshots populations at requested ticks, clones
  a mixed elite/random sample, freezes reproduction by default for challenge
  fairness, and replays those clones in standardized danger arenas:
  `predator`, `mud-refuge`, and `glass-gap`.
- Useful command:
  `node tools\defense-soak.js --preset soup --ticks 2400 --samples "0,600,1200,2400" --cap 1200 --start 800 --sampleSize 48 --challengeTicks 240 --seed 0x51A11`
- The local `npm run`/PowerShell route may strip flag names; the tool has a
  positional fallback and this also works:
  `npm run soak:defense -- --ticks 10 --samples "0,10" --cap 80 --start 40 --sampleSize 8 --challengeTicks 8 --challenges predator --seed 0x51A11`
- First useful probe:
  `soup`, seed `0x51A11`, cap 1200, start 800, snapshots `0,600,1200,2400`,
  sample size 48, challenge ticks 240.
  At tick 2400, normal-life metrics were population 1175, predation energy
  225192.797, field energy 155109.434, mean brain slots 4.254, p90 slots 5,
  max slots 7, and one cluster bud.
  Challenge survival was non-monotonic:
  founders did well in some arenas, tick-1200 descendants did worse in the
  open predator arena, and tick-2400 descendants recovered in predator/mud but
  did worse in glass-gap. Interpret as "now measurable," not proof of evolved
  defense yet.
- Brain-slot observation:
  the cap is still 10, initial brains still start around 4 slots, and add-slot
  structural mutation is still more likely than remove-slot mutation. Recent
  lower averages likely reflect ecological selection/lifetime changes and
  measuring mean slots rather than p90/max. The defense harness now reports
  mean, p90, max, and `slotHist`.

Obstacle navigation:

- User specifically wants to know whether behavior like "food/prey behind
  glass, go around to a gap, then turn back toward goal" can emerge.
- Current scaffolding:
  - recurrent brains
  - food concentration/gradient
  - direct neighbor/particle sensing
  - visual signals
  - sound fields
  - bond messages
  - cluster centroid sensors
  - wall/mud/solid/glass directional sensors
  - correct solid/glass/mud transmission semantics
  - proprioceptive feedback: self velocity, previous motor command, previous
    forward progress, and previous motor slip
- Open risk:
  - current brains may still lack enough planning memory, typed long-range
    target vectors, or selection pressure for robust detours.
- Recent finding:
  - before this pass, particles could see typed glass/solid sensors but had no
    direct body-feedback channel for "I pushed and did not move forward."
    World edges were also intentionally absent from wall scans, so edge-stuck
    behavior had especially weak sensory scaffolding.
  - fix: append generic motor-slip/progress sensors rather than hard-coding
    "glass is blocked" or "edge ahead." A particle that pushes into glass,
    solid, a world edge, crowding, or any future physics impediment receives
    the same kind of bodily mismatch signal.
- Next validation:
  - microtests/soaks with food or prey behind glass and a nearby opening
  - distinguish "can sense target" from "can learn detour"
  - measure whether clusters distribute sensing/planning/locomotion roles

Communication:

- Visual/sound/bond communication exists and is visible.
- Need to ensure it is useful, not just decorative or always-on.
- Current bondMsg:
  - three continuous channels
  - immediate bonded neighbors are averaged
  - distant members hear only through one-hop-per-tick relay unless cluster
    alarm triggers
  - multiple same-channel neighbors reinforce by shifting the local mean
- User is interested in whether cluster interconnectedness confers a theoretical
  boost. Current stance:
  - measure topology first
  - avoid blunt free-energy rewards
  - possible future nudges include topology-scaled energy smoothing, robustness,
    or communication bandwidth

Organism-level reproduction:

- User raised the concern that better evolved behavior may be limited because
  reproduction was almost entirely at the particle/cell level.
- First-pass response: cluster budding is implemented in `js/sim.js`.
- Eligibility is intentionally conservative:
  - named cluster size at least 8
  - sufficient mean age
  - sufficient mean energy relative to member reproduction thresholds
  - sufficient internal bond density
  - rare interval/probability gate plus per-cluster cooldown
- A bud samples member genomes around the parent cluster, mutates them lightly,
  places daughter members nearby in open/mud terrain, creates internal bonds,
  and drains real energy from the contributing parent members.
- Budded particles carry `organismRootId` and `organismGeneration`; current
  cluster labels infer the dominant generation from bonded members and append
  `Jr`, `III`, `IV`, etc. for easy lineage tracking.
- Specimen and cluster export/import carry `organismGeneration`; imported
  copies get a fresh local root id but keep the visible generation suffix.
- This is not intended to script intelligence; it gives selection a heritable
  multicellular/body-plan unit to preserve, vary, and kill.
- Regression coverage: `tests/cluster-budding.test.js` verifies that a stable
  ring-like cluster can produce a detectable daughter cluster with inherited
  clades, internal bonds, parent energy cost, daughter generation markers, and
  a visible `Jr` label.
- Next validation: compare long soaks with/without `world.clusterBudding` to
  see whether cluster topology, coordinated construction, obstacle response,
  and survival improve without runaway population churn.
- Latest validation result: natural cluster offspring did **not** appear in
  long seeded CPU soaks. The blocker looks structural, not sensory:
  - 4 runs at 6000 ticks, cap 1200, maze/soup seeds `0xC0FFEE` and `0xB00D1E`:
    `clusterBuds=0`; several final clusters passed age/energy/bond gates, but
    population was at/near cap.
  - soup seed `0xC0FFEE`, 5000 ticks, cap 2500, start 800:
    `clusterBuds=0`; population reached cap by tick 2000.
  - soup seed `0x51A11`, 6000 ticks, cap 2500, start 300:
    `clusterBuds=0`; eligible clusters appeared from tick 2000 onward, but
    population stayed around 2495-2500, leaving fewer than the 8 open slots
    required for a bud.
- Next design move: stop letting cell-level reproduction consume all available
  particle slots.
- Implemented fix: when `world.clusterBudding` is enabled, ordinary particle
  reproduction stops below the hard cap and reserves a small band for organism
  buds. For a cap-1200 world, the reserve is 24 slots. Cluster buds can still
  use the full hard cap.
- Validation after fix:
  - soup seed `0x51A11`, 6000 ticks, cap 1200, start 300:
    `clusterBuds=15`, `clusterBudParticles=133`, first `Jr` label by tick
    2500, live `Jr` and `III` labels by the end.
  - final population held around 1176 with a 24-slot reserve, so this is an
    intentional soft cap for cell births, not a loss of the hard performance
    cap.
- Next tuning options:
  - compare reserve sizes across maze/soup presets
  - add a pending-bud queue if dense presets still miss the timing window
  - allow adaptive smaller buds only if they can still become named clusters

Construction:

- Wall digging/depositing now happens in tests and soaks.
- Particles can carry multiple wall blocks up to a cap, with per-tick carry
  cost.
- If a carrying particle dies and its cell is open, it drops one solid wall
  block with metadata.
- User previously observed little positive wall carry/depositing; tests now
  show digging and depositing, but behavior remains seed/ecology dependent.
- Maze generator should create some thicker walls because digging is prevalent.

## Backlog and polish notes

High-priority polish:

- Best/top panel buttons can still feel jittery or hard to click under live
  rebuild; earlier fixes helped, but keep testing while unpaused.
- "View" from Best Now/Top Cluster should reliably:
  - center target
  - clear/replace stale card
  - clamp card on screen
- Particle card should include inspect cluster and aggregate cluster card.
- Cards should never spawn partly offscreen.
- Side panel top nav should look like tabs, not command buttons.
- UI panels are crowded and need a more coherent organization.

Visuals:

- improve cluster appearance:
  - visible, organic membranes
  - zoom-aware
  - cheap enough for dense scenes
- improve walls:
  - more organic/legible
  - zoom-sensitive vector detail
  - avoid expensive per-cell rendering when zoomed out
- particle colors should have slight deterministic jitter for organic variation
- visual signaling should feel like radiating waves:
  - two soft concentric rings
  - about half-second offset
  - inner ring roughly two-thirds outer radius

World/building tools:

- world builder for sterile reusable environments:
  - food oases inside mud circles
  - glass corridors
  - raw-material deposits
  - save/import repeatedly with different populations
- cluster builder:
  - import species/clusters as ingredients
  - duplicate in-sim
  - use live ranking exports as seed material
- alien/ecosystem-vs-ecosystem concept:
  - export player ecosystems or organisms
  - temporary combined world for competitions
  - likely needs player state/logins if moved beyond local files

Longer-term:

- larger grid when performance allows
- more ages/epoch tags beyond pack stage
- 3D expansion
- physics/gravity/friction requiring real locomotion/navigation
- projectiles: particles/clusters can throw wall/material instead of only
  depositing adjacent walls

## Testing and verification commands

Latest verification in the cluster-budding pass:

- `node tests\cluster-budding.test.js` passed.
- `node --check js\ui.js` passed after generation metadata was added to export/import.
- After the headroom fix, a seeded long soak produced natural `Jr` and `III`
  clusters:
  `soup`, seed `0x51A11`, 6000 ticks, cap 1200, start 300,
  `clusterBuds=15`, `clusterBudParticles=133`.
- Proprioception pass verification:
  - `node tests\proprioception.test.js` passed.
  - `node tests\terrain-sensors.test.js` passed.
  - `node tools\bench-browser.js --url http://localhost:8765/ --preset maze --seconds 6 --speed 4 --seed 0xC0FFEE --gpu --port 9336` passed with GPU ready/enabled and no page or GPU validation errors after the WGSL `MAX_V_SIM` fix.
- `npm test` passed all 16 test files after the predation economy pass and
  took about 139 seconds.
- Quick CPU smoke passed:
  `node tools\bench-cpu.js --preset maze --ticks 300 --cap 800 --seed 0xC0FFEE --profile --profileEvery 150`.
- Predation economy pass verification:
  - `node tests\predation-economy.test.js` passed.
  - `node --check js\sim.js` passed.
  - `node --check js\ui.js` passed.
  - `node --check tools\bench-cpu.js` passed.
  - `node tools\bench-cpu.js --preset soup --ticks 1800 --cap 1200 --seed 0x51A11 --profileEvery 600` passed and produced the measured meat-vs-field figures above.
  - `npm test` passed all 16 test files.
- Defense-soak harness verification:
  - `node --check tools\defense-soak.js` passed.
  - `node tools\defense-soak.js --ticks 60 --samples "0,30,60" --cap 180 --start 100 --sampleSize 12 --challengeTicks 24 --challenges predator,mud-refuge --seed 0x51A11` passed.
  - `npm run soak:defense -- --ticks 10 --samples "0,10" --cap 80 --start 40 --sampleSize 8 --challengeTicks 8 --challenges predator --seed 0x51A11` passed through the positional fallback.

Core:

```powershell
npm test
```

Targeted:

```powershell
node tests\run-all.js signal-transmission.test.js terrain-sensors.test.js
node tests\run-all.js food-chemotaxis.test.js mud-terrain.test.js
node tests\run-all.js predation-economy.test.js
node tests\run-all.js baseline-soup.test.js baseline-maze.test.js
```

CPU bench:

```powershell
npm run bench:cpu -- --preset maze --ticks 500 --cap 1200 --seed 0xC0FFEE --profile
node tools\bench-cpu.js --preset maze --ticks 500 --cap 1200 --seed 0xC0FFEE --profile --profileEvery 100
```

Browser/GPU smoke:

```powershell
node tools\bench-browser.js --url http://localhost:8765/ --preset maze --seconds 6 --speed 4 --gpu --port 9336
node tools\bench-browser.js --url http://localhost:8765/ --preset maze --seconds 8 --speed 4 --seed 0xC0FFEE --gpu --port 9336
node tools\bench-browser.js --url http://localhost:8765/ --preset maze --seconds 5 --speed 4 --seed 0xC0FFEE --profile --zoom 0.35 --port 9338
```

CPU browser comparison:

```powershell
node tools\bench-browser.js --url http://localhost:8765/ --preset maze --seconds 6 --speed 4 --port 9337
node tools\bench-browser.js --url http://localhost:8765/ --preset maze --seconds 8 --speed 4 --seed 0xC0FFEE --port 9337
```

If no local server is running, start a static server from the repo root and use
`http://localhost:8765/` or adjust the bench URL.

## Known failure modes and lessons

- WGSL/browser errors will not appear in Node tests. Always smoke WebGPU after
  shader, binding, buffer, or browser boot changes.
- Adding a ninth storage buffer exceeded default per-stage limits on the Intel
  WebGPU adapter. Avoid extra bindings unless requesting/checking limits.
- Sensor index changes can silently corrupt evolved/save behavior. Append-only.
- Readback latency can spike; one short bench sample is not proof.
- Dense maze GPU mode currently may have lower FPS than CPU-only despite more
  dispatches. Use `used/fallback/pending` telemetry.
- Random initial particle velocities can pollute microtests unless explicitly
  zeroed.
- Some files show mojibake in comments; avoid unnecessary churn there.

## How to resume work

Recommended next local pass:

1. Check repo state:

```powershell
git status -sb
git log --oneline -5
```

2. Read:

- `CODEX_HANDOFF.md`
- `ROADMAP.md`
- recent commits if needed

3. Choose one narrow pass:

- performance: pair-force-only GPU assist/readback reduction
- performance: lower-write CPU pair-loop redesign if GPU readback remains limiting
- agency: repeat `tools\defense-soak.js` across seeds/longer windows, then add
  detour-navigation microtests if defense remains non-monotonic
- UI: Best/top panel view/chase/card polish
- audio: death gate and dig/deposit quantization

4. Run targeted tests, then broader tests if hot/shared behavior changed.

5. Commit, push, and check Pages deploy.

## User-facing context summary

The user has been actively testing and supplying nuanced observations. They are
not merely asking for features; they are trying to cultivate an artificial-life
system where real emergent capacities can appear. The best collaborator stance
is:

- preserve the emergence-first philosophy
- be honest when a change is scaffolding rather than a win
- measure behavior, do not assume it
- keep the user looped in with concise progress notes
- keep the repo portable through commits and this handoff file
