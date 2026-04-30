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

## Current development plan

**Status:** active

Direction after the first takeover pass: optimize for communication that pays
for itself, coordinated cluster behavior, goal-directed construction, stable
but selection-rich ecosystems, and brain capacity that can keep rising without
making the browser unusable.

### Findings from first testing pass

- CPU symbolic runs are stable, but slow at 1200-1500 particles. A 3k tick
  maze soak is still a minute-scale test, so future performance work needs
  both algorithmic CPU wins and real-browser GPU measurement.
- Communication is visible, but much of the current comm score comes from
  baseline signal/color variation. It needs more direct behavioral value.
- Wall manipulation existed but was too seed-sensitive. Some maze seeds showed
  no wall change over 3k ticks, meaning the trait had weak selection access.
- Brain slots drift upward and can hit the cap. The cap should rise in small
  steps with tests, not leap far enough to sink browser frame rate.

### Near-term execution plan

0. **Keep the experience inspectable and legible.**
   Improve cluster and wall rendering in zoom-aware vector passes: organic
   cluster membranes/hulls, clearer chased groups, and wall edges that reveal
   structure at high zoom without adding per-pixel work. Add wall inspection
   so deposited segments report their builder particle/cluster history. Polish
   cards so they never spawn partly off screen, and support particle/cluster
   chase directly from cards. Current status: first pass shipped, including
   right-click pan, clamped cards, wall cards, card cluster chase/stop, compact
   cluster labels, visible cluster membranes, and visible-wall render culling.
   Current polish pass: chased clusters should pulse their membrane only, not
   every member with a large halo; Best Now "view" should always center the
   target, clear/replace stale cards, and keep cards on screen. Live sidebar
   panels must not rebuild hovered button elements under the pointer.
1. **Make communication useful, not just visible.**
   Add small costs for signaling, then attach cluster-local payoffs to received
   bond messages: hunting coordination, foraging efficiency, and construction
   assistance. First pass is implemented; next tests should distinguish
   dynamic useful messaging from static always-on signals. Current concern:
   particles may not yet have enough actionable "vision" to evolve deliberate
   obstacle avoidance, targeting, or cluster-level danger escape. Audit whether
   existing particle/cluster direction sensors, wall/mud proximity sensors,
   chemistry, sound, and bond messages provide enough raw material for
   non-programmed navigation and stress-relief strategies, or whether longer
   range/typed directional sensors are needed.
   Specific open question: should we expect detour navigation to emerge when a
   particle sees food/prey through glass, learns straight-line pursuit fails,
   explores left/right, passes through a gap, and then returns to the original
   goal? Current brains have recurrent memory, food value/gradient, neighbor
   direction, cluster centroid, wall proximity, mud proximity, sound, chemistry,
   visual signals, and bond messages, but not explicit typed glass direction or
   multi-step path memory. Audit whether clusters can distribute that work
   across specialist members (sensing, bond-message planning, locomotion), or
   whether new typed/longer-range sensors are needed.
   Also test user-observed food response: particles may sense/smell food via
   food concentration and gradient, but if dropped food nearby does not attract
   them, verify whether chemotaxis is too weak, gradient sampling is too local,
   or neural motor outputs overpower the genome-level food force.
   Bond topology question: cluster neural capacity may depend not only on size
   but on graph shape. Current bondMsg is three continuous channels that brains
   can repurpose, received as the mean of immediate bonded neighbors, so
   multiple same-channel neighbors reinforce only by shifting that local mean;
   distant members are heard only through one-hop-per-tick relay, while
   high-amplitude events can also trigger a cluster-wide alarm. Inspect whether
   meshes, hubs, and chains evolve different behaviors. Before adding a direct
   reward for interconnectedness, prefer measuring topology and letting existing
   indirect rewards work; possible future nudges include small topology-scaled
   energy smoothing, robustness, or communication bandwidth rather than a blunt
   free-energy bonus on new bonds.
2. **Make construction evolvable.**
   Keep wall actions costly, but make successful digging/depositing reachable
   from random founders. Expand wall sensors, construction actions, and
   diagnostics until builders/trappers can be observed and selected. Current
   status: direct dig/build counters, a fast coordination test, a maze liveness
   test, a builder complexity component, and a modest cluster shelter payoff
   are in place.
3. **Raise brain capacity carefully.**
   Increase hidden-slot cap only as far as tests and browser FPS allow. Each
   increase must update GPU packing, UI readouts, and regression bounds.
4. **Measure and improve performance.**
   Add repeatable CPU soak probes, headless browser smoke, and real-browser GPU
   checks. Prioritize hot-loop allocation reduction, neighbor-search profiling,
   render-pass caps/culling, and GPU parity/latency before silent auto-caps.
   Later, increase overall grid size only when these measurements show enough
   headroom. Current status: CPU bench is active, the maze 1200x/1500-cap
   probe improved from 26.15 ms/tick to about 23.66 ms/tick after hot-loop
   allocation cleanup and cached cluster membership pointers. Chart redraws
   are throttled, and particle/bond/wall render passes now cull to visible
   camera bounds where possible. Browser bench is now available through
   `npm run bench:browser`; early CPU/GPU browser checks show WebGPU can
   improve frame responsiveness. First GPU handoff improvement keeps hidden
   brain state resident on-GPU, cutting the short maze probe readback from
   ~20 ms to ~5 ms and improving both FPS and ticks/second. Next GPU approach:
   keep decoupling the CPU/GPU handoff and profile whether pair-force-only or
   adaptive cadence modes outperform full GPU brains. Latest CPU-side pass
   merged repeated wall/mud proximity scans; the 1200-cap maze probe improved
   from ~31.9 ms/tick to ~27.0 ms/tick on the same seed.
5. **Improve listenability.**
   Keep the organism-driven music, but reduce harsh density, soften hostile
   events, add light dynamics, and make audio state follow meaningful
   ecological events rather than every loud particle. Reverb was removed after
   user testing. Add a few rare, goofy-but-pitched timbres such as human-ish
   "boop" vocal formants and boingy resonators; keep them uncommon so they
   remain delightful instead of exhausting. Let higher-energy or otherwise
   meaningful events sustain longer with slower decay, so the music breathes
   beyond uniform eighth-note blips. Death should become a gated musical event:
   only trigger a "sad trombone" style cue when enough deaths occur inside one
   musical note window, not on isolated deaths; the gate should represent mass
   casualty events, not ordinary background turnover. Add occasional
   high-signal ornament notes outside the swung eighth grid: midpoint triplets
   inside the long eighth, or grace notes just before a downbeat, tied to
   meaningful signal thresholds rather than random chatter. Digging and
   depositing sounds should also snap to the same musical grid/ornament logic,
   not fire as unmetered one-shots. Investigate/replace synthetic one-shots
   that read as loud claps, especially wall events in GPU-heavy runs.
   Add a wider register for common notes so the same chord tones do not repeat
   too narrowly across dense populations.
   Longer-term, evaluate a richer WebAudio/Tone-style synth layer or soundfont
   source for more organic vocal, instrument, scratch, and plop timbres rather
   than 16-bit-ish oscillator/noise recipes.

### Longer arcs

- richer cluster-level goals and memory
- better builder/trapper epoch detection
- sharable seeded URLs and exported dominant genomes/species/clusters
- curation tools: live "best of" rankings for fittest, strongest builder,
  highest brain complexity, most aggressive, best communicator, and most stable
  cluster, with export/duplicate affordances. Current status: live specimen and
  cluster picks export and copy; specimen and cluster JSON can be imported back
  near the camera; top clades can be copied/exported as species templates.
- cluster builder tool: use exported species/clusters as ingredients for new
  in-sim colonies or future environments
- sterile world builder: design, save, and reload reusable population-free
  environments such as food oases inside mud circles, glass corridors, and
  raw-material deposits, then import different populations into the same world
  repeatedly without mutating the template
- richer maze/environment generator focused on constraints, shelter, isolation,
  raw materials, corridors, glass barriers, mud flats, and ecological niches rather than
  maze-likeness for its own sake
- UI cleanup: consolidate crowded sidebar sections into clearer panels/tabs,
  reduce tiny text pressure, and make export/inspection actions feel
  consistent now that the control surface has grown. Current status: first
  pass groups the left sidebar into Run/World/Data and the right sidebar into
  Tools/Lineages/Log, with world actions grouped by state, population, and
  environment. Tabs should read visually as tabs, not command buttons.
- user-adjustable preset initial population, so testing can trade ecological
  richness against frame rate without editing code
- simplified preset buttons: no numeric subtitles and no separate Empty preset,
  because a zero-particle initial population covers that workflow
- consider higher-level "ages" beyond epoch tags: construction age,
  communication age, organism age, projectile age, and higher-order tool-use
  or social-coordination ages once the metrics are trustworthy
- eventual 3D/physics/projectile branches after 2D agency is robust

---

## Visual Legibility And Inspection

**Status:** planned

Goal: make evolved structures readable without making the renderer the new
bottleneck.

### Cluster visuals

- Draw capped, zoom-aware organic membranes/hulls around the largest visible
  bonded clusters.
- Keep the existing particle/bond detail intact; the cluster layer should be a
  translucent gestalt cue, not a cover-up.
- Chased clusters should remain unmistakable even in dense soup.
- Cluster membrane/hull visibility should be independent from cluster flag
  labels; turning labels off should not hide organism outlines.
- Particle cards should support both particle chase and cluster chase when the
  inspected particle belongs to a named cluster. Stop actions should clear any
  active camera chase.
- Floating cards should clamp inside the stage on all viewport sizes.
- Right-click drag should pan, matching middle-drag and shift-drag.
- Avoid per-cluster expensive geometry every frame when zoomed far out. Prefer
  cached or bounded point samples and hard caps.

Current implementation:

- Top clusters use compact labels derived from clade names: no ubiquitous
  "-band", and display joins the trait/color words while preserving the
  human-name suffix.
- Cluster human-name suffixes are filtered so they cannot duplicate species
  color names.
- The card and sidebar chase controls resolve clusters by member continuity,
  not fragile object identity.
- Stop-state chase buttons clear all camera following, matching camera tools.
- Chased clusters pulse the membrane slightly instead of flashing every member.
- Human-name suffix pool is now much larger, with common names and nicknames;
  live clusters strongly avoid duplicate given names and still filter out names
  that collide with species color names.
- Particle bodies should have slight deterministic per-individual color jitter
  so same-species groups look organic without fragmenting species identity.
- Visual signal flashes should feel more like radiating waves: two soft
  concentric rings, roughly half a second apart, with the earlier inner ring
  about two-thirds the radius of the later outer ring.

### Wall visuals

- Keep walls vector-rendered so zoom-in remains crisp.
- At higher zoom, add edge/contour hints and type-specific surface treatments.
- Avoid drawing expensive detail for every cell when zoomed far out.
- Future: inspectable deposited segments with builder particle id, builder
  cluster/name if known, alive/dead/disbanded status, deposited tick, and wall
  type/material history.

Current implementation:

- Deposited wall metadata is stored, saved, loaded, and shown in wall cards.
- Wall vector drawing now culls fill and edge passes to the visible camera
  bounds, which matters more as maze walls get thicker and larger worlds become
  feasible.
- Wall-carry/deposit diagnostics should stay visible in tests and UI. If
  particles are carrying material but the behavior is hard to see, render a
  cheap carry marker and expose carrier/deposit counts in benchmarks.
- Current wall/material semantics: solid blocks particles and fields; glass
  blocks particles but passes fields; mud passes particles and fields while
  slightly slowing and draining anything moving through it. Mud is exposed to
  brains as directional and underfoot terrain sensors so lineages can evolve
  seek/avoid/use behavior.
- Carry semantics should feel physical: stacked carried wall material needs an
  ongoing load cost, and carrier death should have a defined fate for the
  material rather than silently deleting it.

---

## Export, Curation, And Cluster Builder

**Status:** planned

Goal: let interesting evolved things be saved, reused, duplicated, and compared.

### Export targets

- Individual species/clade genome templates.
- Individual live particles/specimens.
- Named bonded clusters, including member genomes, relative positions, bonds,
  cluster name, dominant clade, and construction stats.
- Curated generated sets such as current fittest, best builder, highest mean
  brain complexity, most aggressive, best communicator, and longest-lived /
  most stable cluster.

### Reuse targets

- Duplicate exported particles/clusters back into the current sim.
- Import exports into later sims.
- New "cluster builder" tool/environment where selected genomes and cluster
  templates can be assembled deliberately and then released into a test world.
- New sterile-world builder for reusable, population-free environments:
  paint food, decay, mud, glass, solid walls, and raw-material patterns; save
  as a world template; import populations repeatedly without changing the
  source terrain.

Current implementation:

- Individual "Best now" specimen rows export `primordia.specimen.v1` JSON.
- Live specimen cards and "Best now" specimen rows can copy a specimen back
  into the current world.
- Top clades export `primordia.clade.v1` JSON with founder and mean genomes,
  and can copy a small colony from the current mean genome.
- Top cluster and "Best now" cluster rows export `primordia.cluster.v1` JSON
  with member genomes, offsets, live bonds, center, and aggregate stats.
- The World panel can import `primordia.specimen.v1` and
  `primordia.cluster.v1` files at the current camera center. Cluster imports
  restore member bonds. This is intentionally minimal; the designed
  cluster-builder tool remains future work.

### Multiplayer/alien exchange direction

- Exports should eventually support player-owned ecosystem states: saved
  species, clusters, or whole evolved worlds associated with accounts/logins.
- Alien competitions should run in temporary combined worlds that do not alter
  either origin ecosystem. Players can release exported organisms or clusters
  into a neutral/generated arena and compare survival, spread, construction,
  predation, and assimilation.
- This depends on authentication, ownership, provenance metadata, server-side
  storage, and rules for sterile arenas versus imported living populations.

---

## Constraint-Rich Maze Generator

**Status:** planned

Goal: improve the maze preset as an ecological pressure field, not simply as a
better labyrinth.

Design direction:

- More varied rooms and niches: protected pockets, isolation basins, resource
  reservoirs, pressure corridors, mud flats, glass barriers, and raw wall
  material deposits.
- Some walls should be thicker than the first generator pass because initial
  digging is now common; thick barriers should create longer-term constraints
  and more useful raw material.
- Place material where building/digging choices matter: chokepoints,
  partial shelters, stranded resources, and short-range construction puzzles.
- Preserve deterministic seeding so generated environments are testable.
  Expose seed/export later so interesting maps can be revisited.

---

## Alien Exchange / Invasion Worlds

**Status:** stretch

Clarification: this is no longer only a local "drop an alien preset into the
current world" idea. The larger version is a multiplayer/export feature where
different players can turn saved ecosystems, organisms, or clusters loose on
each other in temporary combined worlds. Those contests should not mutate the
respective origin worlds.

The local novelty-event preset remains a useful prototype: drop a
foreign-genome cluster into a settled, established world (after ~10k ticks of
evolution) and observe how natives respond. Tests robustness of evolved
strategies against unseen genotypes.

### Design

- Long-term product design: players have accounts, saved ecosystem states, and
  exported organisms/clusters with provenance. A temporary arena combines
  selected exports from multiple players, runs a contest/simulation, reports
  outcomes, and then discards or archives only the contest result.
- Arena inputs can be live exports, sterile world templates, or generated
  neutral worlds. Origin worlds remain untouched.
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

- The full feature depends on player state, logins, persistence, provenance,
  and server-side contest orchestration, which is outside the current local
  simulator.
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

- **3D world mode**: extend the ecology into volumetric space once the 2D
  control/reward loop is mature enough to survive the extra rendering and
  neighbor-search cost.
- **Navigation physics**: add gravity, friction, terrain, or fluid drag so
  locomotion and path planning become real evolutionary problems rather than
  pure point-mass steering.
- **Projectiles / thrown wall material**: let particles or clusters launch
  carried wall matter instead of only depositing it in-place, creating ranged
  construction, hunting, and territorial behaviors.
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
