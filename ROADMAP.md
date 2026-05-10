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
- Predation pressure is real but was previously hard to see. The sim now
  tracks field-food energy, meat energy, hunt hits, direct fatal drains, and
  deaths that occur soon after predation. A seeded 1800-tick soup soak
  (`0x51A11`, cap 1200) measured ~108k field-food energy, ~148k predation
  energy, 463k hunt contacts, and 1483 predation-attributed deaths out of
  2457 total deaths.

### Near-term execution plan

Current planetary ecology scaffold: `docs/PLANETARY_ECOLOGY_PLAN.md` now lays
out the path from bounded 2D habitat work to torus/chunked torus, with a
bounded 3D fishbowl tracked as a serious alternate branch and globe/sphere mode
held for later. The first shipped step is a new `Planet` preset: protected
food oases, mud rings, glass arcs, thick diggable ridges, migration gaps,
quarries, decay pockets, sparse global food, and mutagen cracks. The goal is
not a prettier maze; it is persistent niche pressure that can make navigation,
construction, predation defense, communication, cluster reproduction, and brain
capacity matter at the same time. Current validation now includes regional
occupancy, movement, clade-turnover, survival/death/escape telemetry, and
behavior deltas for feeding, wall work, predation, and event combat. Next
validation target: longer soup/maze/planet contrasts. First short
validation on seed `0xC1A0C0` created 4733 solid, 2789 glass, 6749 mud, 3085
rich-food, 2460 decay, and 789 mutagen cells. Planet's first-click default is
720 particles, while the population slider can still push it higher. A 600-tick
cap-900 event-combat CPU probe stayed viable at 865 particles, produced 11
clusters, 673 digs, 500 deposits, 59 wall carriers, 506 attacks, and 290
somatic cluster-cell births, but no daughter buds yet. A two-second browser
smoke at the 720-body default reached 19.5 FPS with no page errors on this
machine; heavier Planet starts are still a deliberate stress test.

0. **Keep the experience inspectable and legible.**
   Improve cluster and wall rendering in zoom-aware vector passes: organic
   cluster membranes/hulls, clearer chased groups, and wall edges that reveal
   structure at high zoom without adding per-pixel work. Add wall inspection
   so deposited segments report their builder particle/cluster history. Polish
   cards so they never spawn partly off screen, and support particle/cluster
   chase directly from cards. Current status: first pass shipped, including
   right-click pan, clamped cards, wall cards, card cluster chase/stop, compact
   cluster labels, visible cluster membranes, visible-wall render culling, more
   opaque cluster membranes, and compact hamburger action menus in Best Now and
   Top Clusters. Current polish pass: chased clusters should pulse their
   membrane only, not every member with a large halo; Best Now "view" should
   always center the target, clear/replace stale cards, and keep cards on
   screen. Live sidebar panels must not rebuild hovered menu elements under the
   pointer.
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
   Current status: typed directional material sensors are now appended to the
   brain input set for solid walls and glass barriers, while the old wall/mud
   slots remain index-stable for saved organisms. Proprioception sensors are
   also appended: self velocity, previous motor command, previous forward
   progress, and previous motor slip. These do not tell particles "glass" or
   "edge" as a special case; they report that intended thrust failed to become
   motion, giving evolution generic feedback for glass, solid, world-edge,
   crowding, mud, and other impediments. Next validation target:
   detour-navigation microtests that put food/prey behind glass with a nearby
   opening and verify whether random/evolved brains have enough sensory,
   bodily-feedback, and recurrent scaffolding to learn "go around, then turn
   back toward the goal."
   Transmission rule is now explicit for direct particle/signal perception:
   solid blocks line-of-sight interactions, while glass and mud transmit them.
   GPU parity is maintained by packing a solid-wall visibility grid into the
   existing extras buffer, avoiding an extra WebGPU storage binding.
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
   Cluster-level reproduction is now a first-pass mechanic: stable,
   energy-rich, sufficiently bonded named clusters can occasionally bud a
   daughter cluster that inherits a representative sample of member genomes,
   rough parent-relative positions, and selected parent bond topology, pays
   energy from the parent organism, and starts with internal bonds. This
   is meant to move some selection pressure from the cell/particle level to
   the organism/body-plan level without scripting a specific strategy. Next
   validation target: long soaks should measure whether budded daughter
   clusters preserve useful topology, diversify, survive independently, and
   improve the rate of coordinated behavior compared with particle-only
   reproduction. Daughter/granddaughter organisms now carry a lightweight
   generation marker that appears in labels as `Jr`, `III`, `IV`, etc., so
   lineages can be tracked in the sim without adding a heavy genealogy UI yet.
   Cluster/specimen exports preserve the visible generation marker while
   imported copies receive a fresh local lineage root. Long seeded CPU soaks
   after the first implementation did **not** produce natural daughter
   clusters: eligible clusters do emerge, but normal particle reproduction
   fills the population cap before there are enough open slots for an 8+ member
   bud. Current status: ordinary particle births now stop below the hard cap
   when cluster budding is enabled, reserving a small slot band for organism
   reproduction. A seeded 6000-tick soup soak at cap 1200/start 300 produced
   15 bud events, 133 budded particles, multiple live `Jr` clusters, and one
   live `III` cluster. Current life-history update: ordinary cell births and
   cluster buds now use bounded starter provisioning instead of splitting rich
   parent reserves into equally rich descendants. Fitter, well-fed parents can
   still give offspring a better start and reproduce again sooner, but babies
   enter the world with capped reserves and must earn further energy through
   foraging, defense, cooperation, or predation. Ordinary births from named
   clusters are now treated as organism cell growth/turnover: they keep the
   parent body's organism root/generation, must attach to available bond slots
   in that body, and are counted as `clusterCellBirths`. Cluster budding is
   therefore the only path that advances the visible organism generation
   (`Jr`, `III`, etc.). Current visibility update: organism buds now emit
   explicit event-log entries, the vitals panel reports bud count, budded
   particles, somatic cluster-cell births, bud reserve, descendant clusters,
   descendant cells, max generation, and the last bud tick/generation/size; CPU
   bench and defense-soak JSON now include the same lineage telemetry. Current
   cluster-selection update: organism bud headroom is wider, eligible clusters
   accumulate a bounded readiness credit when they miss the probability roll,
   bud gate diagnostics are reported, and daughter buds inherit the selected
   parent bond topology before adding the stabilizing internal ring. A compact
   post-change `0x51A11` soak reached 17 buds, 158 budded cells, 471 somatic
   cluster-cell births, 8 live descendant clusters, and generation `III` by
   tick 2000; intact-cluster predator replay beat disassembled replay at ticks
   1000 and 2000. Current topology-coordination update: clusters now measure
   internal bond density as a bounded topology score; same-channel bond
   messages get modest degree/topology reinforcement; and event-combat guard
   power gets a conservative topology/alarm boost. A four-seed tick-3000
   `--replay both` follow-up moved intact-vs-disassembled predator survival
   from a slightly negative mean delta before the payoff (`-0.018`) to a
   positive mean delta after it (`+0.049`), with intact clusters beating
   disassembled controls in three of four seeds. Current read: topology now
   has measurable ecological value, but sophisticated defense is not solved.
   Next validation target: repeated multi-seed replays with behavior metrics
   for cohesion under attack, alarm activity, predator-distance change,
   retreat vectors, mud/glass use, and whether topology-rich daughter clusters
   continue to outperform disassembled controls in longer soaks.
   Ecology pressure status: ambient food has been nudged lower again, predation
   conversion has been raised, and the vitals/bench counters now separate
   field-food energy from meat energy. The immediate follow-up is not "add
   predation" but measure whether stronger predator pressure produces evolved
   avoidance, kin defense, obstacle use, or cluster-level rescue behavior.
   Current status: `tools/defense-soak.js` snapshots evolving populations and
   replays cloned cohorts in standardized predator, mud-refuge, and glass-gap
   challenges. A 2400-tick `0x51A11` soup probe showed high-slot variants still
   appear (`maxSlots=7`) but mean slots stayed around 4.25; challenge survival
   was non-monotonic, so this is now a repeatable measurement path rather than
   evidence that defense has already reliably evolved. A follow-up three-seed
   3000-tick probe is recorded in `docs/DEFENSE_SOAK_RESULTS.md`; final
   descendants were worse than founders in all three open-predator challenges,
   mixed in mud-refuge challenges, and roughly stable in glass-gap challenges.
   That points to a real gap between "predation pressure exists" and "replayable
   predator-defense behavior has evolved."
   Current event-combat update: the app now starts in an experimental
   kill/counter/escape combat mode while the old nibble mode remains available
   to `World({ combatMode: 'nibble' })`, CPU bench, and defense-soak comparisons.
   Failed attacks now cost energy and give no food; successful attacks are
   full consume events; counterattacks can kill the attacker; close escapes
   injure both sides and write damage-memory sensors. A short `0x51A11`
   comparison at cap 900/start 500/tick 1200 showed event combat replacing
   tens of thousands of nibble transfers with 698 attacks, 136 kills, 70
   counters, 447 escapes, and 179.84 failed-cost energy in normal life. Treat
   this as a better selection-pressure scaffold, not yet evidence that robust
   defense has emerged.
   Follow-up harness calibration exposed challenge predator controls
   (`--hunterDrive`, `--hunterEnergy`, `--hunterPreference`,
   `--hunterAttraction`, `--hunterSenseRadius`) plus injured-survivor and
   cohort-owned behavior telemetry. Recommended near-term defense replay setting is now milder than
   the first lethal probe: `--combat event --predatorRatio 0.2 --hunterDrive
   0.5 --hunterPreference 0 --hunterEnergy 5`. On seed `0x51A11`, this left
   founder open-predator survival around 0.69 and tick-1200 descendants around
   0.72, leaving room to measure improvement or regression.
   Latest evidence pass: `tools/defense-soak.js` now supports repeated replay
   trials (`--challengeRepeats`) with seeded placement jitter
   (`--challengeJitter`) and fixed replay cohort energy (`--cohortEnergy`) for
   energy-confound checks. Six 6000-tick soup seeds with three jittered replays
   per snapshot/challenge showed positive mean survival deltas at tick 6000 in
   all three arenas, both with sampled energy and with fixed energy 5:
   predator `+0.180`, mud-refuge `+0.147`, glass-gap `+0.164` in the fixed
   energy control. Current read: event combat, damage sensing, and the existing
   cluster/organism machinery now produce measurable replay-survival selection
   under calibrated predators. This still does not prove sophisticated defense
   such as coordinated retreat, rescue, or path planning. Replay realism is now
   implemented: `--replay both` compares particle replay, intact top-cluster
   replay, and disassembled top-cluster controls while reporting source-bond
   retention, member survival, cluster survival, dispersion ratio, predator
   distance, and bond-message activity. Initial post-provisioning results show
   many more live descendants and promising intact-vs-disassembled survival,
   but not enough seeds yet to call topology-specific defense solved. Note that
   the ecosystem now also uses bounded newborn energy, cluster-cell turnover,
   wider bud headroom, readiness credit, and inherited daughter bond topology,
   plus modest topology-level communication/guard payoff, so future defense
   soaks should be compared to fresh baselines rather than the pre-provisioning
   six-seed table. If intact replay remains mixed, the next structural target
   is richer behavior measurement and coordination scaffolding rather than
   simply making buds more frequent.
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
   ~20 ms to ~5 ms and improving both FPS and ticks/second. Latest CPU-side
   pass merged repeated wall/mud proximity scans; the 1200-cap maze probe
   improved from ~31.9 ms/tick to ~27.0 ms/tick on the same seed.
   Current status: GPU readback now uses a small ring of readback buffers so a
   late mapAsync no longer blocks launching newer dispatches, and browser
   bench/UI telemetry reports used vs fallback GPU ticks, pending readbacks,
   and adaptive cooldown state. The CPU-side loop now avoids repeating full
   sensory-radius neighbor/line-of-sight work on ticks where GPU pair results
   are consumed; it only keeps CPU contact-range biology and bond barriers.
   Adaptive GPU cadence now samples the GPU path briefly, then cools down for
   300 ticks when the recent used/fallback ratio or readback time is poor.
   Browser bench now accepts `--seed`, so CPU/GPU comparisons can start from
   the same preset state. Recent headless Chrome/Intel samples:
   - dense maze, GPU before adaptive: ~19.9 ticks/sec with ~55 ms readback and
     many fallback ticks
   - seeded dense maze, 5s: adaptive GPU ~25.3 ticks/sec, CPU-only ~26.6
   - seeded dense maze, 8s: adaptive GPU ~26.5 ticks/sec, CPU-only ~24.0
   - open soup, adaptive GPU: short 4s probes still pay startup tax, but an 8s
     run recovered to ~35 ticks/sec after cooldown
   Current status: browser and CPU benches now expose rolling profiler windows.
   Browser profiling splits frame time into sim/render/audio/UI; sim profiling
   includes rolling phase costs and line-of-sight counters. Low-zoom rendering
   now uses tile LOD for walls and screen-space density LOD for particles, so
   zoomed-out views retain terrain/population structure without drawing every
   bond/body ornament. Browser `--profileEvery` windows confirmed the long-run
   FPS drop is dominated by population growth inside the sim step, not renderer
   or UI churn: in a seeded 75s low-zoom maze run, population climbed past 3,200
   and the final 300-tick window spent ~58 ms/frame in `step` while render stayed
   ~4.4 ms/frame.
   Follow-up performance pass tested a one-pass CPU pair accumulator, but the
   extra scratch writes and contact-order changes were slower in V8 than the
   original hot loop, so that route was not shipped. The shipped win is a coarse
   solid-wall visibility cache: most line-of-sight checks first ask whether the
   particle-hash cells crossed by the ray contain any solid wall at all. On the
   seeded 500-tick dense-maze CPU probe this cut actual grid line walks from
   ~1.08M/window to ~126k/window by tick 500 and improved the sample from the
   low-to-mid 20 ms/tick range to ~19.7-20.2 ms/tick. Browser low-zoom probes
   still show sim step as the dominant frame cost. A later pass shrank the
   broad-phase hash cells from 96px to 48px and made CPU/GPU neighbor scans
   radius-aware, then replaced solid-wall coarse rejection with a prefix-sum
   visibility grid. On the same seeded low-zoom browser shape, the tick-1200
   window improved from roughly 20 FPS before the pass to roughly 28.5 FPS after
   it, and a 75s run still held ~20 FPS at tick ~1513 with ~2,700 particles.
   The remaining degradation at ~3,200+ particles is fundamental single-threaded
   sim cost: tens of thousands of neighbor/visibility checks per tick. A
   same-tick pair line-of-sight cache was tested and rejected because Map
   overhead outweighed saved queries. The lower-readback pair-force-only GPU
   path is now implemented as an experimental benchmark mode: it skips GPU brain
   forward, reads back 20 floats/particle instead of 30, keeps CPU brains
   authoritative, and preserves quadrant sensory stats. Short GPU smoke showed
   readback dropping to ~7 ms with `--gpuPairOnly`, but longer dense-maze runs
   were not a reliable win on the Intel sample because map waits/cooldowns and
   ecological divergence still dominate late windows. It is therefore available
   for measurement but not the default user-facing GPU mode. Current priority:
   worker/snapshot architecture first, explicit user-facing population/work
   budgets second, broader GPU compute third. Faster hardware helps, but the
   durable fix is to decouple render responsiveness from sim ticks and make the
   sim budget visible/tunable.
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
  raw materials, corridors, glass barriers, mud flats, and ecological niches
  rather than maze-likeness for its own sake. Current status: `Planet` is the
  first habitat branch beyond Maze, with persistent basins, oases, ridges,
  quarries, decay pockets, and mutagen cracks.
- UI cleanup: consolidate crowded sidebar sections into clearer panels/tabs,
  reduce tiny text pressure, and make export/inspection actions feel
  consistent now that the control surface has grown. Current status: first
  pass groups the left sidebar into Run/World/Data and the right sidebar into
  Tools/Lineages/Log, with world actions grouped by state, population, and
  environment; Best Now and Top Clusters now use compact per-row action menus
  instead of always-visible action-button clusters. Tabs should read visually as
  tabs, not command buttons.
- user-adjustable preset initial population, so testing can trade ecological
  richness against frame rate without editing code
- simplified preset buttons: no numeric subtitles and no separate Empty preset,
  because a zero-particle initial population covers that workflow
- consider higher-level "ages" beyond epoch tags: construction age,
  communication age, organism age, projectile age, and higher-order tool-use
  or social-coordination ages once the metrics are trustworthy
- finite but unbounded worlds: bounded Planet first, then optional torus, then
  chunked torus, then globe/sphere only after ecology and performance justify
  the geometry cost
- bounded 3D fishbowl branch: potentially more behaviorally rich than a 2D
  wraparound surface because vertical refuges, fluid/gravity/friction, occlusion,
  and pursuit/escape geometry become evolutionary problems; likely much heavier
  than torus because neighbor search, fields, terrain, sensors, and rendering
  become volumetric
- eventual physics/projectile branches after the 2D agency loop is robust

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
- Cluster membrane interior shading is now a little more opaque while edge
  strokes stay restrained, so named organisms remain visible in dense runs.
- Particle bodies should have slight deterministic per-individual color jitter
  so same-species groups look organic without fragmenting species identity.
- Optional next visual experiment: one-hop bonded-neighbor color averaging for
  particle bodies. Keep it nonrecursive, detail-render-only or cached, and
  measure before enabling at high population.
- Visual signal flashes should feel more like radiating waves: two soft
  concentric rings, roughly half a second apart, with the earlier inner ring
  about two-thirds the radius of the later outer ring.
- Full attack events now queue a small red blood-drop world-space flash,
  separate from normal evolved signals, so predation/violence is visible
  without turning the canvas into a warning-light show.
- Visual form update: attack flashes draw as a small red blood-drop glyph, not
  a red circle or cross, so they read as predation without looking like a UI
  alert.

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

Update: predation telemetry now shows that meat is already a major energy
source in at least one normal soup soak, not a missing behavior. A 1800-tick
`0x51A11` run at cap 1200 measured predation energy above field-food energy
and attributed 1483 of 2457 deaths to recent predation. The sharper research
question is now whether that pressure selects for useful defenses: avoidance,
glass/mud exploitation, tighter kin aversion, cluster alarms, or organism-level
budding that preserves defensive topology.

Defense testing harness: `tools/defense-soak.js` now records ancestor and
descendant snapshots, clones a mixed elite/random cohort, freezes reproduction
for challenge fairness, and replays the clones against standardized predator,
mud-refuge, and glass-gap arenas. It reports survival, predation deaths,
hit-but-alive fraction, mud/refuge use, and slot histograms. First useful probe
(`soup`, seed `0x51A11`, cap 1200, 2400 ticks) showed predation pressure and
high-slot variants, but not yet a monotonic survival gain from descendants over
founders. Repeat across seeds and longer soaks before tuning.

Three-seed 3000-tick follow-up: see `docs/DEFENSE_SOAK_RESULTS.md`. Meat energy
exceeded field energy in all three seeds and high-slot variants still appeared
(`maxSlots` 7-8), but final descendants underperformed founders in all open
predator challenge replays. Current interpretation: soup evolution is producing
predation-rich ecology, not yet robust, portable defensive behavior.

Event-combat follow-up: the old contact-predation model is now kept as
`combatMode: 'nibble'`, and the browser app starts in `combatMode: 'event'`.
In event mode, positive predation drive over a gate attempts an attack and pays
a fixed cost. Outcomes are discrete: kill and consume prey, get counterkilled
by a guarding prey, or escape with small injuries to both. Failed attacks have
no food gain and are explicitly net negative. Damage writes four new brain
sensors (`damage.recent`, `damage.dx`, `damage.dy`, `damage.age`) and can trigger
cluster alarm propagation, giving organisms a raw signal for "that hurt, from
that direction" without hard-coding what response is good.

Short comparison (`soup`, seed `0x51A11`, cap 900, start 500, 1200 ticks,
samples 0/600/1200, sample size 32, challenge ticks 180): nibble mode at tick
1200 produced 653 predation-attributed deaths and 67,937 meat energy; event
mode produced 206 predation-attributed deaths and 1,274 meat energy plus 698
attacks, 136 kills, 70 counters, 447 escapes, and 179.84 failed-cost energy.
CPU bench at 700 ticks/cap 900 was 13.773 ms/tick nibble versus 14.309
ms/tick event, roughly a 4% cost in that probe. The new standardized predator
challenge is much harsher under event combat, so future defense soaks should
either run longer or tune challenge strength before interpreting low survival
as ecological failure.

Defense replay calibration now has explicit hunter knobs. The original event
challenge default (`hunterDrive=4`, `hunterPreference=1`, `hunterEnergy=9`,
`predatorRatio=0.35`) drove founder survival to about 0.13 in a 180-tick
open-predator replay. A milder setting (`hunterDrive=0.5`,
`hunterPreference=0`, `hunterEnergy=5`, `predatorRatio=0.2`) produced founder
survival around 0.66-0.69 while still producing kills, counters, escapes, and
injured survivors. In a 1200-tick `0x51A11` event-mode soak with that milder
replay predator, open-predator survival went from 0.688 at founders to 0.719
at tick 1200; mud-refuge survival fell from 0.750 to 0.594; glass-gap survival
rose from 0.750 to 0.813. This is encouraging only as calibration: run longer
and across seeds before reading it as evolved defense.

Deterministic replay fix and longer results: `tools/defense-soak.js` now awaits
the full async challenge body inside `withSeed`, so replay challenge RNG stays
seeded. After that fix, three calibrated 3000-tick event-mode soaks at cap
900/start 500 produced positive average survival deltas over founders:
open-predator `+0.067`, mud-refuge `+0.033`, and glass-gap `+0.083`. The result
is promising but mixed: one seed regressed in open-predator, one regressed in
mud-refuge, and glass-gap was flat in one seed. A `0x51A11` 6000-tick check
showed max brain slots reaching 8 and mean slots 4.329, but open-predator
survival fell to 0.700 versus founder 0.800 after being 0.875 at tick 3000.
So: likely structural improvement, not solved defense.

Brain-slot note: the structural cap remains 10 and add-slot mutation still has
more raw probability than remove-slot mutation. Current observed lower averages
are likely ecological/measurement effects: stronger scarcity and predation,
shorter lifetimes, and judging mean slots rather than max/p90. The new defense
harness reports mean, p90, max, and histogram so future runs can separate
"high-slot variants never appear" from "high-slot variants appear but do not
take over."

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

Current implementation: Planet registers named habitat regions and CPU bench
reports region/niche telemetry for them. Each region reports occupancy, mean
energy, low-energy count, mud/glass occupancy, wall carriers, species entropy,
dominant species/share, terrain/material cell counts, and food/decay/mutagen
mass. Bench profile windows also report particle movement, clade colonizations,
local clade extinctions, turnover score, dominant clade, top gaining or
declining clades, survival/death/escape/energy-change outcomes, and behavior
deltas for feeding, wall work, predation, event-combat attacks/counters/escapes,
and combat damage by region.
A 300-tick `0xC1A0C0` Planet probe showed strong niche differences: `root
basin` had 177 particles at mean energy 9.927, `glass basin` had 119 particles
at mean energy 3.162 with 96 mud occupants, and 425 particles remained outside
named regions. A later 180-tick profiled probe showed higher clade turnover in
`central crossing` and `outside` than in the named basins; the final 90-tick
window also flagged `glass basin` and `dawn basin` as the highest-death basins,
while `central crossing` mostly acted as an escape corridor. First behavior
probe on the final 90-tick window showed `root basin` leading field energy,
`tide basin` leading predation damage/energy, and `tide basin` plus `glass
basin` leading wall work. Next telemetry target: longer comparisons across
soup/maze/planet, using the new behavior blocks.

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
