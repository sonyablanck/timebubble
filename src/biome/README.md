# biome/

Ground cover for walk mode: temperature, moisture, soft biome weights, vegetation density and the expected plant mix, plus the 65 Ma Aftermath phases. Runs in the terrain worker straight after each tile. Every output is `inferred`. Design: [`PSEUDOCODE.md`](PSEUDOCODE.md) (status and amendments at the top).

| File | What it does |
|---|---|
| `rules.ts` | §2 temperature (1° grid, 6 °C/km lapse correction only for height above the grid's own orography); §3 moisture (precipitation → aridity by the Köppen–Geiger threshold, Peel, Finlayson and McMahon 2007); §4 the 18 biomes, scored and blended by a gated softmax; §6 vegetation density; §7 Aftermath overrides; biome colours. |
| `plants.ts` | §5 plant mix: an age-aware prior, nudged by biome, with the DESIGN §8 constraints (no flowering plants before 130 Ma; dominant only after ~90 Ma; no grass). Where there are plant fossils within 500 km, the mix comes from them (weighted by age fit and distance) and leans on the prior only where evidence is thin; with none, it is the prior alone, tagged `PLANTS_FROM_PRIOR`. |
| `climate.ts` | Cited per-slice parameters: ice possible (read from `climate_by_age.json`, with the same list here as a fallback) only at 165 and 130–150 Ma (Scotese et al. 2021); the Impact Winter cooling curve (26 °C at peak, years 1–3, recovering by year 30; Brugger, Feulner and Petri 2017). |
| `field.ts` | Per-tile fields (colour, dominant biome, vegetation density, flags, plant mix), the far ring's colours, and the full detail for one point (info cards). Climate and coast distance are sampled on a 17 × 17 lattice per tile and interpolated. |

Literature check on the real data (`biome.test.ts`, report only): 250 Ma equator 38 °C with heat stress (Sun et al. 2012: ≥ 35 °C); Impact Winter year 2, tropical land 2.9 °C (Brugger et al. 2017: ≈ 5 °C).

Cost: about 0.2–0.3 s extra per full-resolution tile (Node, one core).
