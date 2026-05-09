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
