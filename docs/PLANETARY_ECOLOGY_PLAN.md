# Planetary Ecology Upgrade Plan

This is the master plan for moving Primordia from a rich particle soup into a
more open-ended artificial ecology: larger habitats, persistent niches,
organism-level selection, meaningful communication, and eventually either less
bounded surfaces or richer bounded volumes.

## Current Read

What is working:

- Selection pressure is measurable. Predation, food intake, deaths, combat
  outcomes, cluster budding, and replay survival are now visible in tests and
  soak output.
- Event combat removed the old mutual-nibbling incentive and replaced it with
  kill, counterkill, escape, and injury outcomes.
- Named clusters can now bud daughter organisms, and reserve headroom fixed the
  earlier "eligible but no room to reproduce" blocker.
- Cluster-preserving replay can compare intact organisms against the same cells
  with bonds removed.
- Topology now has a modest measurable payoff through bond-message
  reinforcement and defensive guard power.

What is still holding back interesting behavior:

- The world is still too homogeneous. Soup and maze generate pressure, but not
  enough persistent ecological niches.
- The main unit of reproduction is still mixed: organism budding exists, but
  particle-level reproduction remains a dominant background process.
- Navigation has raw scaffolding but not yet enough measured proof. Particles
  can sense food gradients, terrain, damage direction, motion slip, signals,
  sound, and bond messages, but detour planning and obstacle use need sharper
  assays.
- Communication has costs and some payoffs, but not enough situation-specific
  pressure to prove dynamic useful messaging.
- Brain capacity should rise only when the world gives extra cognition a real
  job. Raising caps before niches exist mostly adds compute cost.
- Larger worlds are blocked less by drawing and more by simulation architecture:
  hot loops, neighbor search, GPU readback, and UI/render coupling.

## North Star

The target is not scripted intelligence. The target is an environment where
intelligence, cooperation, navigation, construction, predation, defense, and
specialization have enough raw material and selection pressure to emerge.

The stack should develop in this order:

1. Persistent niches.
2. Resource specialization.
3. Organism-level life cycles.
4. Measured communication and coordination payoffs.
5. Larger brains because larger brains earn their keep.
6. Larger and less bounded worlds.
7. Physics, projectiles, 3D, and multiplayer ecosystem exchange.

## Phase 1: Rich 2D Habitat

Goal: give current particles more ecological questions without rewriting core
geometry.

Implemented first step:

- `Planet` preset: protected food oases, mud rings, glass arcs, thick diggable
  ridges, migration gaps, quarries, decay pockets, sparse global food, and
  local mutagen cracks. The default start is 720 particles; the preset
  population slider can still be raised for stress tests.

First validation:

- Seed `0xC1A0C0` generated 4733 solid, 2789 glass, 6749 mud, 3085 rich-food,
  2460 decay, and 789 mutagen cells.
- A 600-tick cap-900 event-combat CPU probe stayed viable at 865 particles,
  formed 11 clusters, recorded 673 digs, 500 deposits, 59 wall carriers, 506
  attacks, and 290 somatic cluster-cell births.
- A two-second browser smoke of the 720-body default reached 19.5 FPS with no
  page errors on this machine.
- No daughter-cluster buds appeared in that short planet probe; longer
  planet-specific soaks should test whether the richer habitat delays or
  enhances organism-level reproduction.

Near validation:

- Run short and medium planet soaks with `combatMode: event`.
- Compare planet vs soup/maze for:
  - live descendant clusters;
  - cluster topology;
  - wall digging/depositing;
  - mud/glass use;
  - predation deaths;
  - mean/p90/max brain slots;
  - regional clade divergence.

Next habitat improvements:

- Add a sterile world generator mode that lets saved habitats be reused with
  different imported populations.
- Add basin/corridor metrics to bench output: particles per region, energy per
  region, clade/species entropy by region, and migration between regions.
- Add visible biome overlay or optional low-cost terrain labels.

## Phase 2: Resource Ecology

Goal: make more than one thing worth seeking.

Candidate resources:

- Food: direct energy, current field.
- Decay: carcass/scavenger signal, current field.
- Mineral/raw wall matter: current solid wall deposits and carried blocks.
- Mutagen: local evolutionary acceleration, current auxiliary field.
- Later optional fields:
  - toxin/stress;
  - catalyst needed for advanced reproduction or construction;
  - water/fluid or drag field;
  - temperature/light.

Design rule: add a new resource only if it changes behavior. A new field should
create a tradeoff such as food-rich-but-dangerous, safe-but-barren,
builder-rich-but-energy-poor, or mutagenic-but-lethal.

## Phase 3: Finite But Unbounded Surface

Recommended path:

1. Bounded rectangle plus planet preset. Current step.
2. Optional toroidal topology.
3. Chunked toroidal world.
4. Globe/sphere mode if the ecology proves worth the extra geometry.

Why torus before sphere:

- It removes edge/corner artifacts.
- It preserves the grid, fields, wall arrays, neighbor hash, and renderer shape.
- It is testable with wrap-distance and wrap-diffusion microtests.
- It gives most of the finite/unbounded ecological benefit with far less risk.

Sphere/globe risks:

- Spherical grids need seams, poles, or non-rectangular topology.
- Diffusion, line-of-sight, wall painting, brush tools, hash cells, camera
  projection, GPU kernels, and saved terrain all become more complex.
- It is probably worth doing later as a visual/scientific mode, not as the next
  mechanical step.

Toroid implementation gates:

- Add `world.topology = 'bounded' | 'torus'`, default bounded.
- CPU pair distances use shortest wrapped delta.
- Field diffusion wraps in torus mode.
- Hash neighbor windows wrap in torus mode.
- Wall/terrain scans and line-of-sight define seam behavior.
- GPU pair-force parity is either implemented or GPU is disabled in torus mode
  until parity exists.
- Renderer/camera show seam hints or ghost edge previews.

## Phase 3b: Bounded 3D Fishbowl Alternative

A bounded 3D habitat may be more behaviorally interesting than a 2D unbounded
surface because it makes locomotion, vertical refuges, gravity/fluid drag,
layered resources, occlusion, and pursuit/escape geometry into real evolutionary
problems. It also keeps the world physically legible: organisms are inside a
container rather than living on an abstract wraparound surface.

Compute tradeoff:

- 2D torus is the cheapest topology upgrade. It preserves arrays, fields,
  brushes, most rendering assumptions, and GPU kernels; only distance, neighbor
  windows, diffusion, and seam behavior need careful work.
- A true globe/sphere is mechanically expensive because it keeps surface motion
  but complicates grids, seams/poles, brush tools, projection, diffusion, and
  line-of-sight.
- A bounded 3D fishbowl is probably more interesting than a sphere, but it is
  the heaviest of the near-future options. Neighbor search becomes volumetric,
  fields become 3D textures or stacked slices, walls become voxels/surfaces,
  sensory rays become 3D, and rendering needs either a true 3D scene or careful
  slice/volume visualization.

Recommended decision:

- Do not jump directly from current 2D to full 3D.
- Prototype 3D as a small, bounded fishbowl after region telemetry and worker
  architecture exist.
- Treat 3D as an alternate major branch against torus, not as a sequel to globe.
- Use the first prototype to test whether vertical navigation and physics
  produce better evolved behavior per unit compute than wraparound 2D.

## Phase 4: Organism-Level Life Cycle

Goal: make clusters the main evolutionary actors without deleting the cell-level
texture that makes the sim alive.

Current status:

- Named clusters can bud daughter organisms.
- Ordinary births inside named clusters are somatic cell growth/turnover.
- Daughter labels use `Jr`, `III`, `IV`, etc.
- Cluster exports preserve organism generation and topology.

Next steps:

- Track parent/child organism lineage explicitly, not just generation suffix.
- Add organism fitness assays: offspring count, descendant survival, mean body
  topology, defense replay performance, construction contribution.
- Consider germ/soma distinction later: only some cells contribute to daughter
  genomes, while others mostly act as body cells.
- Add regional organism replay: export a cluster from one habitat, replay it in
  another habitat.

## Phase 5: Brains, Senses, And Planning

Goal: raise neural capacity only when there is a reason.

Near steps:

- Add detour-navigation microtests: food/prey behind glass with a gap.
- Add behavior metrics to defense replay: retreat vector, predator-distance
  delta, alarm timing, cohesion under attack, mud/glass use.
- Audit whether food gradients are too local or too weak for visible attraction
  when the user drops food nearby.
- Raise brain slot cap only after planet/niche tests show pressure for more
  memory, planning, and specialization.

Likely future sensors:

- Longer-range typed food/prey/predator direction.
- Regional stress/energy summaries for bonded organisms.
- More explicit carried-material load and deposit opportunity sensors.
- Cluster role context: edge/interior, local topology, neighbor count.

## Phase 6: Communication With Stakes

Goal: make communication useful in specific ecological situations.

Current status:

- Visual signals, sound, and three-channel bond messages exist.
- Bond messages have small costs and topology-scaled reinforcement.
- Cluster alarms exist for damage/high-amplitude events.

Next steps:

- Record communication before/after events: attack, food discovery, wall dig,
  wall deposit, bud, death.
- Add red visual attack flash for full-on attacks so predation/violence is
  legible on the map.
- Add communication assays:
  - does a cluster that detects danger maintain cohesion better?
  - does a food-finder's signal pull bonded members toward the source?
  - does a builder's bond message predict coordinated digging/depositing?

## Phase 7: Performance And Scale

Goal: let richer worlds run long enough for evolution to matter.

Next structural target:

- Worker/snapshot architecture so UI/render FPS stays responsive while the sim
  advances on its own budget.

Other scale steps:

- User-facing population/work budgets.
- Chunked spatial ecology: only active regions get full simulation cadence.
- Lower-write CPU pair-loop redesign if GPU readback remains limiting.
- GPU work only when readback and parity risks are contained.
- Larger grid only after planet preset profiling shows enough headroom.

## Phase 8: Later Expansions

- Projectiles: throw carried wall material rather than only depositing it.
- Physics: gravity, friction, fluid drag, terrain momentum, and locomotion
  constraints.
- 3D bounded fishbowl: a serious alternate branch once the 2D ecology is
  instrumented enough to compare behavior-per-compute against torus.
- Multiplayer/alien exchange: player-owned saved ecosystems, organisms, or
  clusters released into temporary combined worlds.

## Immediate Build Order

1. Ship `Planet` preset and tests.
2. Run planet short/medium CPU soaks.
3. Add region/niche telemetry to bench output.
4. Add behavior metrics to defense replay.
5. Add attack flash.
6. Add detour-navigation assay.
7. Decide whether torus topology or a small bounded fishbowl prototype is the
   better next topology/physics experiment.
