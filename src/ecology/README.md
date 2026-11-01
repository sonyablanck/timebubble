# ecology/

Which organisms live on a tile, how many, where, and how they idle. Runs in the terrain worker after biome/ (behaviour runs on the main thread). Design: [`PSEUDOCODE.md`](PSEUDOCODE.md) (status and amendments at the top).

| File | What it does |
|---|---|
| `roster.ts` | §1 presence from PBDB occurrences within 750 km (kernel 250 km, age fit, environment match; within 150 km = `data`); genus-level entries; §3 abundance by Damuth's law (D = k·M^−0.75; carnivore k calibrated to ~0.01 *T. rex* per km², Marshall et al. 2021), split among co-occurring taxa of a trophic level; §3a representative fauna; §5 K–Pg and Aftermath rules; PBDB environment vocabulary → habitat classes. |
| `scatter.ts` | §4 world-anchored placement: a global jittered grid per layer (canopy 10 m, understorey 7 m) where each cell belongs to exactly one tile, so neighbours agree at their edges. Fields are read on the step-4 vertex lattice, so plants don't change when a ring tile becomes the tile underfoot. Animal groups at the best of 12 seeded 200 m spawn cells. |
| `behaviour.ts` | §6 ambient state machine (idle, wander, graze, drink, rest; fliers loop), deterministic per seed; land animals stop at the shore; groups keep together. |
| `index.ts` | `buildTileEcology(tile, biome, ctx, settings)` → roster, plant instances, animal spawns. |

Budgets: ≤ 250,000 plant instances per tile, thinned evenly by seed (truncating left the south of a tile bare); ≤ 80 animals, largest first, ≤ 12 per taxon.

Real data (Hell Creek, 70 Ma): 202 taxa, all with fossils within 150 km; ~158,000 plants; 80 animals; ~0.5 s per tile in the worker. With representative fauna off, a 16 km² tile there holds no large dinosaurs, only small theropods, turtles and small mammals, as Damuth's law predicts.

Provisional (tagged `inferred`, listed in DESIGN §12): body-plan default lengths and masses (`PLAN_INFO`), the herbivore and omnivore density multiples, the plant-layer densities, and the habitat preferences.
