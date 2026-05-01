# Primordia Codex handoff

This file is the portable context packet for continuing Primordia development
from another machine or another Codex desktop thread. The Codex desktop app
does not appear to sync chat history across devices, so treat this repo file
plus `ROADMAP.md` as the durable handoff layer.

## Fresh clone on another machine

```powershell
git clone https://github.com/fpidot/primordia.git
cd primordia
```

Then ask Codex on that machine to read:

- `CODEX_HANDOFF.md`
- `ROADMAP.md`
- the latest few commits on `main`

Suggested prompt:

```text
Please take over development of this local Primordia clone. First read
CODEX_HANDOFF.md and ROADMAP.md, inspect the current git state, then continue
from the current roadmap. Keep commits/pushes happening at the end of each
meaningful pass.
```

## Current repo state

- Local working path on the original machine:
  `C:\Users\flipp\Documents\New project\primordia`
- Remote: `https://github.com/fpidot/primordia.git`
- Branch: `main`
- GitHub Pages deploys automatically from pushes to `main`.
- Latest pushed checkpoint at this handoff:
  `702cf38 Pipeline GPU readbacks through slots`

Useful recent commits:

- `702cf38` - Pipeline GPU readbacks through slots
- `b5368d5` - Respect solid line of sight
- `9e97544` - Add typed terrain sensors
- `849b81a` - Expand Primordia simulation tooling and inspection

## Development policy

- Commit and push each meaningful pass so the laptop/desktop can fresh-clone
  or pull without relying on local chat context.
- Avoid reverting user or other-agent changes unless explicitly instructed.
- Prefer focused, test-backed changes over broad rewrites.
- Keep `ROADMAP.md` updated when design decisions or user notes change.

## Current technical state

The simulation is a browser-based evolving particle/ecosystem project with:

- particle genomes and CTRNN-like brains
- food/decay chemistry fields
- visual signal and sound channels
- bond messages and named clusters
- wall digging/depositing with wall ownership metadata
- terrain types:
  - solid wall: blocks movement, chemistry/sound, and direct sight/signal
  - glass: blocks movement, transmits chemistry/sound/direct sight/signal
  - mud: slows/drains movement, transmits chemistry/sound/direct sight/signal
- GPU pair-force/brain path with CPU fallback
- import/export for specimens, clusters, clades, and sterile world templates
- browser and Node regression probes

## Important recently shipped behavior

- Reverb was removed from the music.
- Preset UI got user-selectable initial population.
- Empty preset button was removed.
- Mud/glass naming replaced porous/membrane in the user-facing model.
- Cluster labels were cleaned up:
  - no ubiquitous `-band`
  - trait/color words are joined for display
  - human-name suffix pool expanded and avoids color-name collisions
- Cards clamp on screen and support chase/stop behavior.
- Stop chase clears all chase modes.
- Cluster membranes remain visible when labels/flags are off.
- Chased clusters pulse membrane rather than flashing every member.
- Visual signals are moving toward softer concentric wave cues.
- Wall segments are inspectable and preserve builder/cluster metadata.
- Species/clusters/clades and sterile world templates can be exported/imported.
- Current “best/top” panels support copy/export/view/chase workflows, though
  polish remains open.

## Current performance state

CPU:

- Full Node regression suite passes.
- Recent CPU maze probe around the latest pass:
  `500 ticks, maze, cap 1200`: roughly `26.743 ms/tick`, `37.4 ticks/sec`
  in one run. Short CPU probes vary by load.

GPU:

- WebGPU browser smoke passes without page/GPU errors after the line-of-sight
  and readback-slot changes.
- GPU readback now uses a small ring of readback buffers.
- Browser bench and UI report:
  - used GPU ticks
  - fallback ticks
  - pending readbacks
  - last result age
- On the current Intel sample, the readback-slot change improves scheduling
  resilience but still does not beat CPU-only in dense mazes.

Next performance target:

- reduce readback payload/frequency, or
- add a pair-force-only assist mode so GPU can help without full brain-output
  readback every tick.

## Current roadmap priorities

Near-term plan from the active roadmap:

1. Keep the experience inspectable and legible.
2. Make communication useful, not just visible.
3. Make construction evolvable.
4. Measure and improve performance.
5. Improve listenability.

Immediate continuation point:

- Before more performance work, the latest completed pass made direct
  particle/signal perception obey terrain transmission:
  - solid blocks
  - glass and mud transmit
- Then the next pass added readback slots and GPU telemetry.
- The next planned performance pass should avoid pulling the full result
  payload back every tick or split GPU modes.

## User goals and design north star

The user especially cares about:

- communication and coordinated goal-driven behavior
- goal-driven wall building/digging
- stable but selection-rich ecosystems
- continued possible escalation of brain power and evolutionary fitness
- high computational caps where feasible
- obstacle navigation emerging from sufficient senses/brains/cluster behavior,
  not hand-programmed pathfinding
- clusters acting like organisms with distributed perception, messaging,
  planning, and locomotion if possible
- listenable, organic simulation music rather than harsh 16-bit noise
- increasingly inspectable worlds, lineages, particles, clusters, and walls

Open agency question:

- Can detour navigation emerge when food/prey is visible or chemically
  detectable behind glass, but direct motion is blocked?
- Current brains now have typed terrain direction sensors and correct
  glass/mud/solid transmission semantics, but still need microtests and
  longer soaks to verify whether the scaffolding is enough.

## Test commands

```powershell
npm test
node tests\run-all.js signal-transmission.test.js terrain-sensors.test.js
npm run bench:cpu -- --preset maze --ticks 500 --cap 1200 --seed 0xC0FFEE --profile
node tools\bench-browser.js --url http://localhost:8765/ --preset maze --seconds 6 --speed 4 --gpu --port 9336
```

If the local dev server is not running, start one from the repo root. Use the
repo's existing simple static-server workflow or any equivalent local static
server, then point browser benches at `http://localhost:8765/`.

## Notes for next Codex thread

- Start by checking `git status -sb`.
- Confirm the clone is on `main` and up to date with `origin/main`.
- Run targeted tests before broad tests when changing hot simulation paths.
- For frontend/GPU changes, run browser bench/smoke because Node tests cannot
  catch WGSL or browser validation errors.
- After each meaningful pass:
  - run relevant tests
  - update `ROADMAP.md` if design state changed
  - commit
  - push
  - check GitHub Pages deploy
