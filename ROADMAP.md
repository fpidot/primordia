# Primordia roadmap

A running record of designed-but-unshipped work, things that are deliberately
parked, and ideas worth keeping near the codebase. Items here are *not* a
backlog of bugs or near-term polish — those land in commits as they come up.
This file is for things that will need design context next time someone
picks them up.

## Status legend

- **planned** — designed; ready to ship when prioritised
- **parked**  — designed; held back because something else has to land first
- **stretch** — interesting; not on the critical path
- **research** — open question; needs investigation before design

---

## Alien invasion preset

**Status:** stretch

A "novelty event" preset: drop a foreign-genome cluster into a settled,
established world (after ~10k ticks of evolution) and observe how natives
respond. Tests robustness of evolved strategies against unseen genotypes.

### Design

- Run an underlying preset (soup or maze) for a *seed* period (e.g. 8000
  ticks) so genuine evolution has occurred — clades stratified, predators
  established, possibly clusters formed.
- At a triggered moment (button press or tick threshold), spawn 30–60
  particles in a tight cluster at a random world location with a *foreign*
  genome distribution: max-out brain slots, very high cohesion, max
  predation drive, all six instrument families distributed evenly so they
  read as visually distinct.
- Optional: aliens come in via a small "rip" of solid wall they're
  burrowing through → integrates Thread B-2 burrow.
- Optional UX: a `★ Invasion arrives` event with a special epoch-style
  pill in the chronicle.

### Why it's a stretch, not planned

- Existing presets are sufficient for the current stage of evolution
  research.
- The "interesting" outcome (natives adapt vs natives crushed vs alien
  absorbed) requires the underlying simulation to be evolutionarily mature
  — i.e. seed period genuinely produces specialisation. Phase 6/7 are
  showing this is starting to happen; not yet rich enough to make
  invasion a meaningful test.
- Risk: if natives uniformly crush aliens (because aliens are 30 vs
  thousands), the preset is boring. Tuning aliens to be competitive
  without being unkillable requires per-genome scaling factors not
  currently in the API.

### Implementation outline

1. New preset function `alien` in `presets.js`.
2. Seed period uses `PRESETS.soup(world, 800)`.
3. After 8000 ticks, spawn alien cluster with `addParticle` and a
   custom-built genome template.
4. Add a `★ Invasion` event via `world.clades.pushEvent`.
5. Optionally: bump `epochsStarted` so the music modulates on arrival.

---

## FPS auto-cap

**Status:** parked behind Phase 4f

Soft cap that auto-reduces `world.maxParticles` when sustained FPS drops
below a threshold (e.g. fps < 18 for 5 seconds → cap to current alive count
× 0.85; fps > 35 for 10 seconds → cap +10%). Keeps the experience smooth
on slower machines without manual tuning.

### Why parked

- Phase 4f (GPU pipelining) just shipped. The expectation is that GPU
  mode should now provide real headroom that didn't exist before. Worth
  re-measuring CPU and GPU FPS profiles before deciding whether this is
  still needed.
- Auto-cap silently changes evolutionary dynamics — fewer particles =
  fewer interactions per tick = different selection pressure. We want to
  understand the perf situation post-pipelining before letting fps dictate
  population.

### Re-evaluate when

User reports steady-state fps below 15 with GPU mode on at population
cap 5000.

---

## Phase 4f — GPU pipelining

**Status:** SHIPPED (commit log)

For posterity since this was on the roadmap a while: the dispatch +
readback now run concurrently with the next tick's CPU work. 1-tick lag
on GPU forces & brain outputs accepted (CTRNN already has internal lag,
particle motion <1px/tick).

### Known limitations (post-ship)

- `f32` precision drift between CPU and GPU computations remains. CTRNN
  outputs may diverge over hundreds of ticks. Either accept (purely visual
  difference, no gameplay impact) or migrate to `f16` deterministic
  ops if a future feature needs CPU/GPU parity.
- Headless WebGPU adapter is unavailable in the project's test harness, so
  the GPU path runs only in real browsers. Tests exercise CPU-only code
  paths; GPU code reviewed via WGSL compile-info logging.

---

## Open research questions

These aren't tasks — they're questions the simulation surfaces that we
haven't dug into. Worth recording so they don't get lost.

### Why does `prey_walling` start at zero population-wide and stay there?

Initial random genome init produces small `(rng-0.5)*0.4 = ±0.2`
variation. Mutation is gaussian so drift is symmetric. Question: does any
real selection pressure exist for trap-building vs avoidance? If most
particles never deposit, the trait sees no fitness gradient. May need a
"deposit-active" multiplier to amplify mutation rates for particles that
actually use deposit, so the trait gets selection signal.

### Cluster-loyalty vs predator pressure

Phase 6 introduced `cluster_affinity` for bond loyalty, `kin_aversion` for
not-eating-clustermates. After 7k-tick soak `cluster_affinity` mean was
~0.08 (slightly positive). Predator population stayed at 33–51%. Is the
ecosystem locking into a stable predator-prey-loyalist mix, or is it
still drifting? Long-soak (50k+ ticks) needed to know.

### Comm metric `flash` component

Per-tick signal-channel deltas remain near zero (~0.001 raw) even after
Phase 6A's brain dynamics expansion. The plateau-refire detector in
`render.js` covers visual continuity for sustained signalers, but if
genuine event-driven communication ever evolves, the comm metric should
show it. Currently it doesn't — possibly because static-output brains
are evolutionarily favoured (energy-cheap).

### Spatial niches selection signature

PHOTO heterogeneity (equator lush, poles barren) was added to push
regional ecotypes. After ~3k ticks, food density does stratify
(verified visually). Genome divergence between equatorial and polar
clades is unclear — would require per-clade genome-mean tracking by
latitude. Add to a future analysis test.

---

## Backlog of micro-ideas

Tiny items not worth a full design block but worth not forgetting.

- **Event ticker**: when `wall_affinity` or `prey_walling` mean shifts
  > 0.1 from initial, fire an "Age of Builders" / "Age of Trappers"
  epoch.
- **Particle inspector**: scroll-wheel on specimen card cycles through
  bonded partners in the same cluster.
- **Save/load presets via URL**: `?preset=maze&seed=12345` so a specific
  layout can be shared.
- **Diff overlay**: highlight cells where wall_count changed in last N
  ticks, so you can visually track digger activity.
- **Genome export**: download the dominant clade's genome JSON for
  external analysis or seeding into a future run as alien stock.
