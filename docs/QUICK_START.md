# Primordia quick start

Primordia is an evolving particle ecosystem. You are watching populations of
small agents live in a chemical world: they eat, move, signal, bond, reproduce,
mutate, dig and build walls, form clusters, and die back into the nutrient
cycle.

It is not a scripted game with a win condition. It is closer to a living
laboratory. Your job is to set conditions, observe what evolves, inspect
interesting individuals and clusters, and occasionally intervene.

## Launch

From the repo root:

```powershell
python -m http.server 8765
```

Open:

```text
http://localhost:8765/
```

No build step or backend is required.

## What you are seeing

The center canvas is the world.

- Colored particles are living agents.
- Trails show recent motion.
- Food and decay appear as field coloration when the field layer is visible.
- Solid walls block particles, chemistry, sound, and direct sight/signal.
- Glass blocks particles but lets chemistry, sound, and sight/signal pass.
- Mud slows and drains particles but lets chemistry, sound, and sight/signal
  pass.
- Bonded clusters may show membranes or labels.
- Visual signals can appear as halos/waves around particles.

Click a particle or wall to inspect it. Particle cards show live stats and
actions such as chase, copy, export, or cluster inspection when available. Wall
cards show what kind of wall it is and, for deposited walls, who built it.

## Basic navigation

- Mouse wheel: zoom.
- Middle-drag, shift-drag, or right-drag: pan.
- Fit world: reset the camera to the whole world.
- 100% zoom: return to native scale.
- Chase buttons: follow a particle or cluster.
- Stop chase: camera stops following any target.

## Left sidebar

The left sidebar has Run, World, and Data panels.

### Run

Use this when you want to control time and starting conditions.

- Pause/Resume stops or resumes the simulation.
- Step advances one tick while paused.
- Speed changes how aggressively the app advances ticks per frame.
- Presets create starting worlds:
  - Fresh Soup: general open ecosystem.
  - Predator-Prey: stronger interspecies pressure.
  - Symbiotic Web: more mutualistic starting structure.
  - Maze: terrain constraints with solid walls, glass, and mud.
- Initial population controls how many particles a preset starts with. Set it
  to zero if you want a sterile terrain start.
- Camera tools fit, zoom, and reset the view.

### World

Use this for saving, loading, importing, and direct intervention.

- Save/Load uses browser-local saved state.
- Export downloads the current world state as JSON.
- Reset reloads the active preset.
- Import specimen, clade, or cluster brings saved life back into the current
  world near the camera.
- Randomize shakes up attraction/cohesion and motion.
- Clear field removes food/decay/mutagen/sound fields without necessarily
  deleting particles.
- Export terrain saves a sterile world template: terrain and fields, no
  population.
- Import terrain loads a sterile template so you can test different populations
  in the same environment.
- Exterminate removes a selected species.
- Mutagen storm raises mutation pressure.
- Stagnation watchdog can auto-reseed if complexity stays too low.

### Data

Use this to understand what evolution is doing.

- Evolutionary complexity summarizes the current state of the ecosystem.
- Population shows live counts and recent trend.
- Mean genome shows average traits such as metabolism, sensing, and mutation.
- Evolved attraction matrix shows species relationships:
  - rows are emitters
  - columns are targets
  - blue means attraction
  - red means repulsion

## Right sidebar

The right sidebar has Tools, Lineages, and Log panels.

### Tools

Brushes let you alter the world directly.

- None: inspect without painting.
- Food: add food.
- Wall: add solid wall.
- Glass: add transparent barrier.
- Mud: add slowing/draining terrain.
- Mutagen: raise local mutation pressure.
- Spawn: add particles of a selected species.
- Erase: remove terrain/fields in the brush area.

Brush size and strength affect painting. Spawn species controls what species is
created by the Spawn brush.

Visual toggles:

- Trails: show motion history.
- Show field: show food/decay field.
- Show walls: show terrain.
- Cluster labels: show cluster names. Cluster membranes may remain visible even
  when labels are off.
- Bond barrier: named bonded clusters can physically resist outsiders.

Audio:

- Audio voices enables the organism-driven music. Browsers require a user
  gesture before audio can start.
- Volume controls master level.
- The music is generated from ecological activity: signals, species, action
  types, wall work, deaths, and other events. It is meant to be an audible trace
  of the ecosystem rather than a normal soundtrack.

Compute:

- Use WebGPU enables the experimental GPU compute path if available.
- CPU remains the reference path.
- GPU diagnostics show dispatch/readback timing and how many ticks actually
  used GPU results.

### Lineages

Use this to find what is succeeding.

- Top clades lists successful evolutionary lineages.
- Top clusters lists named bonded groups that behave like larger organisms.
- Best now curates notable living specimens and clusters such as high fitness,
  high complexity, builder candidates, aggressive lineages, and other useful
  exports.

Buttons in these panels can inspect, view, chase, copy, or export candidates.
Exports can be imported into later worlds.

### Log

Use this to track events and history.

- Events records notable births, deaths, speciation, cluster events, and user
  interventions.
- Fossils preserves notable dead particles for later inspection.
- Notes contains compact reminders about the simulation.

## Things to try

### Watch first

Load Fresh Soup, leave it running, and watch population, clades, and clusters.
Click a few particles. Look for stable movement patterns, chasing, crowding,
or early bonded groups.

### Add a food patch

Pick Food, paint a small oasis near active particles, then watch whether
particles drift toward it. If nothing obvious happens, pause and inspect nearby
particles: their brains and species relationships may be overpowering simple
chemotaxis.

### Make a glass barrier

Paint Glass between particles and a food patch. Chemistry and sight/signal can
pass through, but bodies cannot. Watch whether particles pile up, avoid it,
or eventually find a way around.

### Make mud pressure

Paint Mud around a food source. Mud is passable but costly. Predators or prey
may evolve to exploit, avoid, or tolerate it.

### Watch construction

Run Maze. Open the Data and Lineages panels. Look for wall digs, wall deposits,
carriers, and clusters near terrain. Inspect wall segments to see builder
history.

### Export a winner

In Best now or Top clusters, export an interesting specimen or cluster. Later,
start a new terrain, import it, and see whether it still succeeds.

### Build a sterile test world

Set initial population to zero, load a preset or paint terrain manually, then
export terrain. You can reuse that world as a challenge course for different
species, clades, or clusters.

## How to read behavior

Primordia is noisy. A single moment can mislead. Look for repeated patterns:

- Do particles consistently approach food gradients?
- Do they avoid solid or mud?
- Do signals precede movement or clustering?
- Do bonded clusters survive longer?
- Do walls become shelters, traps, corridors, or accidental clutter?
- Do top clades grow in brain complexity over long runs?
- Does a cluster recover from stress, or does it drift into danger?

If something interesting happens, pause, inspect, export, and write down the
seed/context if possible.

## What not to assume

- A particle ignoring food does not necessarily mean it cannot sense food. It
  may have other forces, brain outputs, or species interactions dominating.
- A wall is not just a visual obstacle. Solid, glass, and mud have different
  transmission rules.
- GPU being enabled does not always mean faster. Use the diagnostics and
  browser bench.
- One run is not proof. Evolution is seed-sensitive.

## Useful test commands for developers

```powershell
npm test
node tests\run-all.js signal-transmission.test.js terrain-sensors.test.js
npm run bench:cpu -- --preset maze --ticks 500 --cap 1200 --seed 0xC0FFEE --profile
node tools\bench-browser.js --url http://localhost:8765/ --preset maze --seconds 6 --speed 4 --gpu --port 9336
```
