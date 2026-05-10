# Defense Soak Results

This is a running notebook for `tools/defense-soak.js`: evolve populations,
snapshot ancestors and descendants, then replay cloned cohorts in standardized
danger arenas.

## 2026-05-09 - three-seed soup probe

Command shape:

```powershell
node tools\defense-soak.js --preset soup --ticks 3000 --samples "0,1000,2000,3000" --cap 1200 --start 800 --sampleSize 48 --challengeTicks 240 --seed <seed> --json
```

Seeds:

- `0x51A11`
- `0xB00D1E`
- `0xC0FFEE`

### Final normal-life state

| seed | tick | population | mean slots | p90 slots | max slots | cluster buds | meat energy | field energy |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `0x51A11` | 3000 | 1173 | 4.179 | 5 | 7 | 0 | 283242 | 199125 |
| `0xB00D1E` | 3000 | 1176 | 4.224 | 5 | 8 | 4 | 335940 | 206854 |
| `0xC0FFEE` | 3000 | 1176 | 4.368 | 5 | 7 | 0 | 254249 | 201196 |

Interpretation:

- Meat energy exceeded field-food energy in all three runs.
- High-slot variants still appear (`maxSlots` 7-8), but the population mean
  remains under 4.5 and p90 remains 5.
- Cluster budding is seed-sensitive at this horizon: one seed produced four
  buds by tick 3000, two produced none.

### Founder to descendant challenge deltas

Delta is final snapshot survival minus founder snapshot survival in the same
standardized challenge. Negative means tick-3000 descendants survived worse
than founders in that replay arena.

| seed | challenge | founder survival | final survival | delta |
|---|---|---:|---:|---:|
| `0x51A11` | predator | 0.938 | 0.708 | -0.230 |
| `0x51A11` | mud-refuge | 0.917 | 0.792 | -0.125 |
| `0x51A11` | glass-gap | 0.979 | 1.000 | +0.021 |
| `0xB00D1E` | predator | 0.854 | 0.583 | -0.271 |
| `0xB00D1E` | mud-refuge | 0.854 | 0.667 | -0.187 |
| `0xB00D1E` | glass-gap | 1.000 | 0.938 | -0.062 |
| `0xC0FFEE` | predator | 0.896 | 0.396 | -0.500 |
| `0xC0FFEE` | mud-refuge | 0.833 | 0.667 | -0.166 |
| `0xC0FFEE` | glass-gap | 0.958 | 1.000 | +0.042 |

Interpretation:

- These descendants are not yet reliably better than founders in standardized
  predator-defense challenges.
- Glass remains strongly protective, but that may be terrain geometry rather
  than evolved behavior.
- The evolved soup population may be optimizing for normal ecological churn,
  predation, reproduction, and local cluster survival rather than for a sudden
  replay-arena predator drop.
- Current next step: run longer soaks and/or compare against ancestor genomes
  in the exact same normal-world ecological context. If defense remains flat or
  negative, improve the raw scaffolding for danger response before tuning
  rewards directly.

## Open questions

- Are high-slot variants dying faster, reproducing less, or simply rare because
  3000 ticks is too short?
- Does organism-level budding preserve any defensive topology at 6000+ ticks?
- Does predator pressure select for becoming a better predator more than for
  becoming better prey?
- Are the replay arenas too harsh, too artificial, or missing the signals that
  descendants evolved to use in the original soup?

## 2026-05-09 - event combat comparison

Event combat was added after the three-seed probe above to replace continuous
mutual nibbling with discrete attack outcomes: kill and consume, counterkill,
or escape with injuries. Failed attacks now pay an energy cost and give no food.

Command shape:

```powershell
node tools\defense-soak.js --preset soup --ticks 1200 --cap 900 --start 500 --seed 0x51A11 --samples 0,600,1200 --sampleSize 32 --challengeTicks 180 --predatorRatio 0.35 --combat <nibble|event> --json
```

### Normal-life comparison at tick 1200

| mode | population | predation deaths | meat energy | field energy | attacks | kills | counters | escapes | failed cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `nibble` | 882 | 653 | 67,937 | 51,192 | 0 | 0 | 0 | 0 | 0 |
| `event` | 882 | 206 | 1,274 | 50,282 | 698 | 136 | 70 | 447 | 179.84 |

### Challenge note

Under event combat, the standardized predator challenge became much harsher:
at tick 1200, open-predator survival was 0.094 in event mode versus 0.969 in
nibble mode for the same seed and cohort size. Glass-gap survival stayed high
in event mode (0.938 at tick 1200), which suggests the challenge harness is
now more decisively measuring lethal predator exposure and obstacle separation.

Interpretation:

- Event combat gives a cleaner ecological signal: failed attacks are costly,
  kills are meaningful, and counters/escapes are visible.
- The short comparison does not yet show evolved defense. It mostly proves the
  pressure and measurement are sharper.
- Next defense soaks should run longer, compare several seeds, and consider
  dialing challenge predator strength separately from normal-world combat so
  replay arenas are not just instant execution chambers for naive cohorts.

### Challenge calibration pass

The defense harness now exposes predator replay controls:

- `--hunterDrive`
- `--hunterEnergy`
- `--hunterPreference`
- `--hunterAttraction`
- `--hunterSenseRadius`

It also reports `injuredAlive` / `injuredAliveFrac` for event-combat survivors
that were hurt but not killed.

Note: a follow-up pass fixed `withSeed` so async challenge replays keep their
seeded RNG for the full replay. The multi-seed tables below are the canonical
post-fix measurements; the earlier calibration numbers were useful for choosing
the mild hunter setting but should not be treated as exact reproducibility
targets.

Founder-only calibration, all on seed `0x51A11`, cap 120, start 80, sample 32,
open-predator challenge only, event combat, 180 challenge ticks:

| setting | predator ratio | hunter drive | hunter pref | hunter energy | survival | kills | counters | escapes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| default lethal | 0.35 | 4.00 | 1 | 9 | 0.125 | 27 | 1 | 0 |
| mild calibrated | 0.20 | 0.50 | 0 | 5 | 0.656 | 7 | 10 | 4 |
| medium calibrated | 0.25 | 0.65 | 0 | 6 | 0.563 | 12 | 9 | 5 |

Short calibrated descendant probe:

```powershell
node tools\defense-soak.js --preset soup --ticks 1200 --cap 900 --start 500 --seed 0x51A11 --samples "0,600,1200" --sampleSize 32 --challengeTicks 180 --predatorRatio 0.2 --combat event --hunterDrive 0.5 --hunterPreference 0 --hunterEnergy 5 --json
```

Normal life at tick 1200: population 881, combat attacks 704, kills 165,
counters 59, escapes 432, failed cost 172.48, predation deaths 224, mean slots
4.160, p90 slots 5, max slots 6.

| challenge | founder survival | tick-600 survival | tick-1200 survival |
|---|---:|---:|---:|
| predator | 0.688 | 0.656 | 0.719 |
| mud-refuge | 0.750 | 0.594 | 0.594 |
| glass-gap | 0.750 | 0.781 | 0.813 |

Interpretation:

- The mild setting leaves enough survivors that improvement can be measured.
- The one-seed, 1200-tick result is mixed: predator and glass-gap improve
  slightly, mud-refuge worsens.
- Recommended next run: three or more seeds at 3000-6000 ticks with the mild
  calibrated challenge, then compare survival deltas and injured-survivor rates.

## 2026-05-09 - deterministic calibrated event-combat soaks

After fixing async seeded replay handling, the calibrated event-combat defense
probe was rerun across three seeds.

Command shape:

```powershell
node tools\defense-soak.js --preset soup --ticks 3000 --cap 900 --start 500 --seed <seed> --samples "0,1000,2000,3000" --sampleSize 40 --challengeTicks 180 --predatorRatio 0.2 --combat event --hunterDrive 0.5 --hunterPreference 0 --hunterEnergy 5 --json
```

### Final normal-life state at tick 3000

| seed | population | mean slots | p90 slots | max slots | cluster buds | combat attacks | combat kills | counters | escapes | predation deaths | meat energy | field energy |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `0x51A11` | 882 | 4.167 | 5 | 7 | 10 | 1157 | 143 | 93 | 843 | 236 | 2,022 | 136,957 |
| `0xB00D1E` | 882 | 4.222 | 5 | 6 | 12 | 1687 | 352 | 130 | 1073 | 482 | 5,031 | 142,045 |
| `0xC0FFEE` | 882 | 4.136 | 5 | 6 | 13 | 927 | 131 | 143 | 608 | 274 | 4,266 | 143,190 |

### Founder-to-tick-3000 survival deltas

| seed | predator delta | mud-refuge delta | glass-gap delta |
|---|---:|---:|---:|
| `0x51A11` | +0.075 | +0.125 | +0.200 |
| `0xB00D1E` | -0.025 | +0.075 | +0.000 |
| `0xC0FFEE` | +0.150 | -0.100 | +0.050 |
| mean | +0.067 | +0.033 | +0.083 |

Interpretation:

- This is the first calibrated defense probe with a positive average survival
  delta across all three arenas.
- The signal is mixed by seed and arena, so it is not proof that robust defense
  is solved.
- Open predator and glass-gap look more encouraging than mud-refuge.
- Brain capacity did not run away: mean slots stayed around 4.1-4.2, p90 stayed
  5, and max reached 6-7 by tick 3000.
- Organism budding was present in all three seeds at this lower cap/start
  setting (10, 12, and 13 bud events by tick 3000).

### One-seed 6000-tick persistence check

Command:

```powershell
node tools\defense-soak.js --preset soup --ticks 6000 --cap 900 --start 500 --seed 0x51A11 --samples "0,3000,6000" --sampleSize 40 --challengeTicks 180 --predatorRatio 0.2 --combat event --hunterDrive 0.5 --hunterPreference 0 --hunterEnergy 5 --json
```

Normal life at tick 6000: population 882, mean slots 4.329, p90 slots 5, max
slots 8, cluster buds 16, combat attacks 1473, combat kills 231, counters 152,
escapes 1006, predation deaths 383, meat energy 5,013, field energy 288,947.

| challenge | founder | tick 3000 | tick 6000 |
|---|---:|---:|---:|
| predator | 0.800 | 0.875 | 0.700 |
| mud-refuge | 0.700 | 0.825 | 0.800 |
| glass-gap | 0.775 | 0.975 | 0.950 |

Interpretation:

- The 6000-tick persistence check is not monotonic: open-predator survival fell
  below founder level, while mud-refuge and glass-gap remained above founders.
- Brain complexity continued to produce higher-slot variants (`maxSlots=8`) but
  population mean rose only modestly.
- Current conclusion: event combat plus damage sensing probably fixed a real
  structural incentive problem and produced measurable positive defense signal
  at 3000 ticks, but long-run robust defense is not yet proven.
- Next best test: preserve/export the sampled cohorts or top clusters from each
  snapshot so we can inspect/replay lineages directly instead of only aggregate
  sampled survival.

## 2026-05-09 - six-seed repeated-replay evidence pass

This pass tightened the evidence in two ways:

- Each snapshot/challenge uses three seeded replay trials with small placement
  jitter: `--challengeRepeats 3 --challengeJitter 1`.
- The same six seeds were also rerun with `--cohortEnergy 5` so founder and
  descendant cohorts enter replay with the same energy. This checks whether the
  survival gain is more than "descendants are better fed."

Command shape:

```powershell
node tools\defense-soak.js --preset soup --ticks 6000 --cap 900 --start 500 --seed <seed> --samples "0,3000,6000" --sampleSize 40 --challengeTicks 180 --predatorRatio 0.2 --combat event --hunterDrive 0.5 --hunterPreference 0 --hunterEnergy 5 --challengeRepeats 3 --challengeJitter 1 --json
```

Fixed-energy command adds:

```powershell
--cohortEnergy 5
```

Seeds:

- `0x51A11`
- `0xA11CE`
- `0xB00D1E`
- `0xC0FFEE`
- `0xD15EA5E`
- `0xF00D`

### Normal-life state at tick 6000

Normal-life metrics are identical between the natural-energy and fixed-energy
replay passes because only the replay clone energy differs.

| seed | mean slots | p90 slots | max slots | cluster buds | predation deaths | meat energy | field energy |
|---|---:|---:|---:|---:|---:|---:|---:|
| `0x51A11` | 4.329 | 5 | 8 | 16 | 383 | 5,013 | 288,947 |
| `0xA11CE` | 4.245 | 5 | 8 | 17 | 571 | 6,565 | 311,505 |
| `0xB00D1E` | 4.294 | 5 | 7 | 25 | 556 | 8,547 | 302,468 |
| `0xC0FFEE` | 4.230 | 5 | 6 | 30 | 386 | 6,833 | 298,946 |
| `0xD15EA5E` | 4.180 | 5 | 7 | 24 | 534 | 8,651 | 304,934 |
| `0xF00D` | 4.174 | 5 | 7 | 39 | 329 | 4,164 | 303,720 |

### Natural-energy replay aggregates

This is the default challenge behavior: replay clones keep sampled energy,
clamped to 3-10.

| challenge | founder mean | tick-3000 mean | delta 3000 | positive seeds | tick-6000 mean | delta 6000 | positive seeds |
|---|---:|---:|---:|---:|---:|---:|---:|
| predator | 0.696 | 0.850 | +0.154 | 5/6 | 0.869 | +0.173 | 6/6 |
| mud-refuge | 0.721 | 0.849 | +0.128 | 6/6 | 0.901 | +0.180 | 6/6 |
| glass-gap | 0.819 | 0.970 | +0.150 | 6/6 | 0.986 | +0.167 | 6/6 |

### Fixed-energy replay aggregates

This is the stricter test: every replayed cohort particle starts at energy 5.

| challenge | founder mean | tick-3000 mean | delta 3000 | positive seeds | tick-6000 mean | delta 6000 | positive seeds |
|---|---:|---:|---:|---:|---:|---:|---:|
| predator | 0.699 | 0.842 | +0.143 | 5/6 | 0.879 | +0.180 | 6/6 |
| mud-refuge | 0.736 | 0.833 | +0.097 | 6/6 | 0.883 | +0.147 | 6/6 |
| glass-gap | 0.822 | 0.965 | +0.143 | 6/6 | 0.986 | +0.164 | 6/6 |

Interpretation:

- This is substantially stronger evidence than the earlier three-seed pass.
- Positive deltas persist under fixed-energy replay, so the effect is not only
  higher descendant energy.
- The most conservative read is that event combat, damage sensing, and the
  existing cluster/organism machinery now produce measurable replay-survival
  selection under calibrated predators.
- It still does not prove sophisticated defensive behavior such as coordinated
  retreat, rescue, or navigation. The next question is behavioral: what are the
  successful descendants doing?
- Best next implementation target: export/replay sampled cohorts and top
  clusters from snapshots, then add behavior metrics such as predator distance,
  retreat vector, cluster cohesion under attack, alarm activity, mud/glass use,
  and counter/escape rates.

## 2026-05-09 - offspring provisioning note

After the six-seed evidence pass, reproduction was changed so rich parents no
longer spawn equally rich descendants. Cell births and cluster buds now use
bounded starter provisioning: a baseline viable endowment plus a modest
surplus-based boost, capped for newborns. Energetic parents are still favored
because they can provision slightly better and reproduce again sooner, but
offspring must earn further reserves in the world. Ordinary births from named
clusters are also now treated as cell growth/turnover inside the existing
organism: they retain the cluster body's organism root/generation, must attach
to available body bond slots, and are reported as `clusterCellBirths`.

Implication for this file: the six-seed table above remains the best
pre-provisioning/pre-turnover evidence pass. Future defense soaks should
establish fresh post-provisioning/post-turnover baselines before making direct
numeric comparisons.

## 2026-05-10 - organism-preserving replay and cluster-selection pass

This pass addressed a measurement flaw: prior replay sampled individual
particles, so it destroyed the very cluster topology we wanted to test. The
defense harness now supports:

- `--replay particles`: old mixed elite/random particle replay.
- `--replay clusters`: intact top-cluster replay plus disassembled controls.
- `--replay both`: all three replay modes.

Cluster replay exports top named clusters with member genomes, relative
positions, organism generation, and live internal bonds. The challenge then
compares:

- `clusters-intact`: the sampled organism is reconstructed with source bonds.
- `clusters-disassembled`: the same member cells are replayed without source
  bonds.

New challenge metrics include cluster survival, member survival, source-bond
retention, dispersion ratio, predator distance, and bond-message activity.

The ecosystem also received conservative cluster-selection support:

- ordinary birth headroom for organism buds was widened from 2.0%/48 slots to
  3.5%/72 slots;
- eligible clusters now accumulate a bounded readiness credit when they pass
  deterministic gates but miss the probability roll;
- bud diagnostics report interval checks, eligibility, and blocking gates such
  as energy, cooldown, chance, donors, and slots;
- daughter buds now inherit source bond topology among selected parent members,
  then add the existing stabilizing internal ring.

### Three-seed gate/replay check before topology inheritance

Command shape:

```powershell
node tools\defense-soak.js --preset soup --ticks 3000 --cap 900 --start 500 --seed <seed> --samples 0,1500,3000 --sampleSize 32 --clusterBudget 64 --clusterMaxClusters 3 --replay both --challenges predator --challengeTicks 90 --challengeRepeats <1-2> --challengeJitter 1 --predatorRatio 0.2 --combat event --hunterDrive 0.5 --hunterPreference 0 --hunterEnergy 5 --cohortEnergy 5 --json
```

| seed | tick | buds | bud cells | soma births | live descendants | max gen | eligible / chance / energy blocks | particle survival | intact survival | disassembled survival | intact bond retention |
|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| `0x51A11` | 3000 | 15 | 148 | 655 | 4 / 72 cells | 2 | 179 / 164 / 384 | 0.719 | 0.922 | 0.896 | 0.853 |
| `0xC0FEE` | 3000 | 29 | 251 | 510 | 14 / 135 cells | 4 | 233 / 204 / 388 | 0.875 | 0.896 | 0.938 | 0.802 |
| `0xBADA55` | 3000 | 30 | 286 | 692 | 9 / 99 cells | 3 | 231 / 201 / 325 | 0.625 | 0.971 | 0.971 | 0.917 |

Interpretation:

- The immediate cluster-level bottleneck is no longer "buds never happen."
  These seeds produced many organism buds and sustained live descendant
  clusters, including generation `III`/`IV` lineages.
- Energy and chance gates still dominate; that is desirable as selection
  pressure, but they are now measurable rather than invisible.
- Intact topology was usually at least competitive with disassembled controls,
  but not yet uniformly superior. This means cluster-level reproduction is
  working, while topology-specific adaptation still needs more evidence.

### Post-topology-inheritance smoke

After daughter buds began inheriting selected parent bond topology, one compact
post-change soak was run:

```powershell
node tools\defense-soak.js --preset soup --ticks 2000 --cap 900 --start 500 --seed 0x51A11 --samples 0,1000,2000 --sampleSize 32 --clusterBudget 64 --clusterMaxClusters 3 --replay both --challenges predator --challengeTicks 75 --challengeRepeats 1 --challengeJitter 1 --predatorRatio 0.2 --combat event --hunterDrive 0.5 --hunterPreference 0 --hunterEnergy 5 --cohortEnergy 5 --json
```

| tick | buds | bud cells | soma births | live descendants | max gen | particle survival | intact survival | disassembled survival | intact bond retention | intact / disassembled dispersion |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1000 | 5 | 47 | 136 | 2 / 41 cells | 2 | 0.844 | 0.861 | 0.833 | 0.707 | 1.358 / 1.615 |
| 2000 | 17 | 158 | 471 | 8 / 155 cells | 3 | 0.781 | 0.842 | 0.772 | 0.645 | 1.770 / 1.391 |

Current conclusion:

- Cluster-level selection mechanics are now plausibly strong enough to produce
  daughter organisms at useful rates.
- The replay harness can now test the organism as the unit of selection instead
  of accidentally dismantling it.
- The next evidence pass should be a multi-seed post-topology run with
  `--replay both`; if intact clusters still do not reliably beat
  disassembled controls, the next structural target is not "more buds" but
  better topology-level payoffs and coordination scaffolding.

### Four-seed topology-coordination follow-up

The follow-up evidence pass used the same calibrated predator replay shape as
above, with fixed replay energy and `--replay both`:

```powershell
node tools\defense-soak.js --preset soup --ticks 3000 --cap 900 --start 500 --seed <seed> --samples 0,1500,3000 --sampleSize 32 --clusterBudget 64 --clusterMaxClusters 3 --replay both --challenges predator --challengeTicks 75 --challengeRepeats 1 --challengeJitter 1 --predatorRatio 0.2 --combat event --hunterDrive 0.5 --hunterPreference 0 --hunterEnergy 5 --cohortEnergy 5 --json
```

Before adding explicit topology payoff, the four-seed tick-3000 intact-vs-
disassembled control was mixed and slightly negative on average:

| seed | buds | bud cells | particle survival | intact survival | disassembled survival | intact delta | intact bond retention | intact / disassembled dispersion |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `0x51A11` | 23 | 212 | 0.938 | 0.770 | 0.885 | -0.115 | 0.799 | 0.965 / 1.439 |
| `0xA11CE` | 27 | 257 | 0.844 | 0.973 | 1.000 | -0.027 | 0.944 | 1.009 / 1.100 |
| `0xB00D1E` | 22 | 222 | 0.625 | 0.732 | 0.661 | +0.071 | 0.609 | 1.472 / 2.016 |
| `0xC0FFEE` | 26 | 265 | 0.656 | 0.784 | 0.784 | +0.000 | 0.509 | 1.883 / 2.189 |

Implementation response:

- clusters now track `internalBonds`, `meanInternalBonds`, and a bounded
  `topology` score based on internal bond density;
- bond-message propagation gives a modest gain when several bonded neighbors
  reinforce the same channel, plus a small topology-scaled gain;
- event-combat guard power receives a conservative boost from cluster topology
  and an additional alarm/topology term.

Post-change tick-3000 results:

| seed | buds | bud cells | mean topology | sampled topology | particle survival | intact survival | disassembled survival | intact delta | intact bond retention | intact / disassembled dispersion |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `0x51A11` | 13 | 129 | 0.724 | 0.804 | 0.875 | 0.828 | 0.906 | -0.078 | 0.718 | 1.216 / 1.761 |
| `0xA11CE` | 24 | 245 | 0.858 | 1.000 | 0.938 | 0.889 | 0.815 | +0.074 | 0.750 | 1.481 / 2.099 |
| `0xB00D1E` | 19 | 198 | 0.770 | 0.875 | 0.906 | 0.929 | 0.839 | +0.090 | 0.955 | 1.083 / 1.450 |
| `0xC0FFEE` | 25 | 281 | 0.767 | 0.672 | 0.688 | 0.727 | 0.618 | +0.109 | 0.683 | 1.440 / 1.766 |

Interpretation:

- Final intact-vs-disassembled predator survival moved from one win, one tie,
  and two losses to three wins and one smaller loss.
- The mean intact delta moved from about `-0.018` to about `+0.049`.
- This is evidence that topology now has ecological payoff, not evidence that
  sophisticated defense is solved. The next sharper test should use repeated
  replay trials and behavior metrics: cohesion under attack, alarm use,
  predator-distance change, retreat vector, mud/glass use, and whether
  topology-rich daughter clusters keep outperforming their disassembled
  controls across longer soaks.
