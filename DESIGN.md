# DESIGN.md — Time Bubble

*Maintainer: Sonya Blanck*

A desktop browser explorer for Mesozoic Earth. Pick a time and a place on a reconstructed globe, then walk a terrain tile generated from real palaeogeographic and fossil data.

**Audience:** primarily a research exploration tool, built to also appeal to players who enjoy world-building and exploration games. Rigour comes first; atmosphere is what keeps people exploring.

---

## 1. Goals and non-goals

**v1 goals**
- Globe view of the Earth for any supported time slice, from the Early Triassic (250 Ma) to just after the end-Cretaceous extinction (65 Ma).
- A post-extinction layer: a distinct, eerie 65 Ma world, plus an optional "Aftermath" mode (§8).
- Click a location to generate walkable terrain consistent with the global data, streamed in 4 km tiles so the player can keep walking.
- Vegetation and fauna drawn from fossil occurrence data for that time and region.
- Every visible feature can be traced to its source: data, inferred or generated.

**Non-goals (v1)**
- Survival or gameplay mechanics, animal AI, combat.
- Interpolating between time slices.
- Photoreal art.
- Multiplayer, accounts, backend services.

---

## 2. Guiding principle: honesty about resolution

The finest global elevation data is 0.1° (about 11 km). The globe view uses a 1° grid (about 100 km) area-averaged from it. Anything finer than 0.1° is generated. Two rules follow:

1. **Source data is ground truth.** Generated detail must never contradict it. The terrain's mean elevation over each 0.1° cell must match the source value, and land/sea classification must agree with the source at its native resolution.
2. **Provenance is a feature.** Each feature carries a `source` tag (`data` / `inferred` / `generated`). A toggleable overlay (default off, one key to switch) colour-codes the world by source. Info cards always show the source tag, whether or not the overlay is on, broken down by aspect (presence, position, size, colour). Levels are derived from a single flag registry by one function, so no module can label something `data` by hand. For research use, any view can be exported as a provenance report (datasets, versions, taxa with occurrence IDs, climate parameters, settings) with a "cite this view" string and a reproducible URL.

This is the project's main point of difference from existing tools, and it is what makes Time Bubble usable for research.

---

## 3. Architecture decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| A1 | Platform | **Desktop** browser (WebGL2), TypeScript, Vite; mouse and keyboard; no mobile support | Shareable by link; well supported by AI coding tools; desktop-only frees the budget for tile resolution and vegetation density |
| A2 | Renderer | Three.js only (globe and terrain) | One library to learn; CesiumJS is heavier than a stylised globe needs |
| A3 | Hosting | Static site (GitHub Pages); processed data committed to the repo | No server costs or maintenance; one place for everything. Gzipped data is roughly a few hundred MB, inside the Pages 1 GB limit |
| A4 | Data access | **Offline preprocessing**, shipped as static assets | No runtime API dependency, rate limits or CORS problems; reproducible |
| A5 | Preprocessing | Python scripts in `/pipeline`; plate rotation with **pyGPlates run locally** | Best library support for raster and CSV work (xarray/netCDF4, numpy, pandas); local rotation avoids depending on a web service with no published terms |
| A6 | Time model | Discrete slices matching PaleoDEM intervals (5 Myr); snap to nearest | Interpolating heightmaps between plate configurations is physically meaningless |
| A7 | Coordinate frame | Everything in **palaeo-coordinates** for the chosen slice, computed by the pipeline | Avoids reconstruction maths at runtime |
| A8 | Tile projection | Local tangent plane (east-north-up) centred on the tile | Distortion is negligible at tile scale |
| A9 | Determinism | Fixed global tile grid; terrain noise seed = hash(slice), global; scatter seed = hash(slice, layer, scatter-grid cell), world-anchored | The same place always generates the same tile; global terrain noise and world-anchored scatter keep neighbouring tiles seamless |
| A10 | Art direction | Stylised low-poly, generic body-plan models | Solves the art bottleneck; makes uncertainty legible rather than hiding it |
| A11 | Erosion | None in v1; seam-safe erosion in v2 | Erosion breaks tile seams unless run with overlap; not worth the complexity yet |
| A12 | Plate model | **PALEOMAP v19o_r1d** (Scotese et al. 2024) for everything, from the same Zenodo record as the PaleoDEMs | The DEMs must share a plate model with the fossils; the two models in the record differ by a median 130–190 km. The record's explanation contradicts itself on which model the maps use, so we tested both against the DEMs: v19o puts 25–55% fewer present-day continental points into deep ocean at every slice tested (`pipeline/checks/plate_model_check.py`) |
| A13 | Resolution split | 1° grid for the globe, area-averaged from the 0.1° DEM; 0.1° DEM, chunked by region, for terrain | Globe stays light; terrain gets the best constraint available, loaded on demand; globe and terrain come from one grid, so they always agree |
| A18 | PaleoDEM release | **2024 release** (Scotese et al. 2024, v24221) rather than Scotese & Wright (2018) | Coastlines revised against PBDB fossil localities (Kocsis and Scotese 2021); same CC BY 4.0 licence; ships with its own plate model |
| A14 | Height format | Raw int16 (metres, little-endian), gzipped (`.i16.gz`), decoded in-browser with `DecompressionStream` | Browsers decode PNGs to 8 bits per channel; raw int16 is lossless and needs no decoder library |
| A16 | UI | Preact + TSX, HTML overlaid on the canvas; one view-state store synced to the URL | Small (MIT, ~4 KB); familiar React model that AI tools write fluently; accessible HTML instead of WebGL UI |
| A17 | Walk mode streaming | Floating origin at the current tile centre; 3 × 3 tile ring streamed around the player; far horizon drawn from the 0.1° DEM with no generated detail | Keeps float32 precision; lets players walk indefinitely; distant terrain is data, not invention |
| A15 | Licensing | Code: MIT recommended (AGPL-3.0 considered; if chosen, keep `/pipeline` under MIT because of pyGPlates' GPL-2.0-only licence). Docs and derived data: CC BY 4.0 | Matches the CC BY 4.0 sources; permissive code licence maximises research reuse; avoids the GPL-2.0-only / GPL-3.0 incompatibility in the pipeline (§11) |

---

## 4. Data sources and licences

| Source | Use | Format | Licence |
|---|---|---|---|
| PALEOMAP PaleoDEMs, 2024 release (Scotese et al. 2024, Zenodo v24221, item 5a) | Elevation and bathymetry per slice (0 m = palaeo-shoreline), 0.1°; the 1° globe grid is derived from it | netCDF, 3601×1801 (a 1° CSV, item 5b, is used only as a cross-check) | CC BY 4.0 |
| PALEOMAP Global Plate Model v19o_r1d (same record, item 3a) | Rotating fossil coordinates to each slice | GPlates formats (`.rot` + polygons) | CC BY 4.0 |
| Paleobiology Database (PBDB) API | Plant and animal occurrences: modern lat/lng, age range, taxonomy, environment | CSV/JSON | CC0, as stated in PBDB's download metadata since at least Nov 2025 (previously CC BY 4.0); we credit it either way and record the licence each download states |
| Mean annual temperature, version scotese02a_v21321 (same 2024 record, item 6a1; identical to Scotese 2022) | Temperature per slice, 1°, >100 stage-level intervals; HadCM3L adjusted to proxies (Scotese et al. 2021; Valdes, Scotese and Lunt 2021) | List-format CSV, 361×181 node-registered | CC BY 4.0 |
| Mean annual precipitation, version scotese_02 (same record, item 6b2) | Moisture per slice (biome); raw HadCM3L model output, not proxy-adjusted (Valdes, Scotese and Lunt 2021) | netCDF, 361×181 node-registered (185–255 Ma files padded to 366 columns). Units are **mm/day**, not the mm/month the record's explanation states (area means 3.2–4.1; Earth today ≈ 2.7 mm/day) | CC BY 4.0 |
| Published climate values (Judd et al. 2024; Brugger et al. 2017; Vajda et al. 2004; others in `REFERENCES.md`) | Uncertainty notes, aftermath constants, test benchmarks | Hand-entered with citations in `climate_by_age.json` | Facts with citation. The PhanDA repository has no licence file, so only its per-stage values are stored, cited |

**Software dependencies**

| Package | Where used | Licence | Note |
|---|---|---|---|
| pyGPlates 1.0 | Pipeline only (pip/conda install) | GPL-2.0-only | Not shipped with the app; not vendored in the repo |
| Three.js | App | MIT | |
| Vite | Build tool | MIT | |
| Preact | App UI | MIT | |
| axe-core | Accessibility tests (dev only) | MPL-2.0 | Not shipped |
| numpy, pandas, xarray/netCDF4 | Pipeline | BSD-style / MIT-style | Permissive |

Attribution for all datasets appears in-app (About panel and the provenance overlay legend) and in `CREDITS.md`, with the changes we made noted as CC BY requires.

---

## 5. Pipeline (offline, `/pipeline`)

1. **ingest_dem.py**: for each slice, 250–65 Ma (38 slices):
   - **Globe:** 0.1° DEM area-averaged to 1° → `.i16.gz` heightmap (360×181) + JSON sidecar (slice age, grid registration, resampling method).
   - **Terrain:** 0.1° DEM → `.i16.gz` chunks of 10°×10° (101×101 cells, one-cell overlap) + index. The app loads only the chunks around the selected location.
   - **Continentality:** signed distance to coast (km) on the 1° grid, `globe/{age}.continentality.i16.gz`, used by biome.
   - **Climate grids** (`ingest_climate.py`): the 1° temperature and precipitation grids for each slice, `globe/{age}.temp.i16.gz` (0.01 °C) and `globe/{age}.precip.i16.gz` (0.01 mm/day), with source intervals, age mismatches and any override in `globe/{age}.climate.json`. Every slice has an exact-age interval. One deliberate override: the 65 Ma slice uses the **60 Ma temperature grid**, because the 65 Ma grid is an icehouse outlier (area mean 8.1 °C) that appears to encode K–Pg cooling, which Aftermath mode models separately (§8). The 5 Myr mismatch is flagged in-app.
   - **Climate parameters:** hand-curated `climate_by_age.json` (ice flag, alternative global means, aftermath constants), each value cited.
2. **ingest_pbdb.py**: for the Mesozoic as a whole, fetch occurrences with **modern** lat/lng, early/late age, taxonomy and environment. Cache the raw download with its retrieval date.
3. **rotate.py** (pyGPlates + PALEOMAP): for each slice, take occurrences whose age range overlaps the slice window and rotate their modern coordinates to the **slice's reconstruction age**, so fossils sit on the same map as that slice's DEM. Drop points that fall outside any plate polygon, and log them.
4. **classify_taxa.py**: map each taxon to a **body-plan class** (e.g. small theropod, large theropod, sauropod, ornithopod, ceratopsian, pterosaur, marine reptile, conifer, cycad/bennettitalean, fern, early angiosperm). Unmapped taxa are listed for manual review, not guessed.
5. **bin_occurrences.py**: write spatially binned JSON per slice (5° bins).
6. **build_manifest.py**: write an index of slices and assets for the app, plus the generated `CREDITS.md` section with dataset versions, DOIs and retrieval dates.

Output goes to `/public/data`, regenerated by one command. Output must be **byte-identical** on re-runs with unchanged inputs (fixed gzip timestamp, sorted keys), so regenerating data doesn't bloat git history.

---

## 6. Runtime modules (`/src`)

```
src/
  globe/       Globe view: sphere, heightmap texture, time slider, picking
  terrain/     Tile generation: sampling, noise, mesh, chunking
  biome/       Rule-based biome classification
  ecology/     Taxa selection and placement for a tile
  render/      Scene, camera, water, sky, lighting, LOD
  provenance/  Source tags and overlay
  data/        Asset loading and caching
  ui/          Panels, info cards, settings
```

**Flow:** choose slice → globe → click (palaeo-lat/lon) → load the surrounding 0.1° chunks → `terrain` builds tile → `biome` classifies → `ecology` populates → `render` enters walk mode.

---

## 7. Terrain generation

- **Tile size:** 4 km × 4 km on a fixed global grid, heightfield 513×513 (~8 m spacing). A tile sits within roughly one 0.1° source cell. LOD is per tile: full resolution underfoot, every 4th vertex for the surrounding ring (amended 2026-10-31; `terrain/PSEUDOCODE.md`).
- **Base surface:** bicubic (Catmull-Rom) interpolation of the **0.1° DEM** across the tile and its neighbouring cells.
- **Detail:** noise evaluated in **global palaeo-coordinates**, so adjacent tiles match at the edges with no seam handling.
- **Relief scaling:** noise amplitude depends on terrain class, derived from source elevation and local gradient:
  - abyssal / shelf / coastal plain: low
  - lowland / plateau: moderate
  - orogen: high, with ridged noise
- **Mean preservation:** after adding zero-mean detail, each 0.1° cell gets its residual back through a bump that is zero on the cell's edges, so the cell's mean equals the source value exactly and neighbours are untouched (tested < 1 m on the real DEM).
- **Coastline:** the 0 m contour of the final surface. Generated coastline wiggle is tagged `generated`; the source land/sea call is tagged `data`.
- **Water:** sea is a surface at 0 m, curved with the Earth. Rivers and lakes are deferred to v2, alongside erosion.
- **Horizon:** beyond the 3 × 3 tiles, a ±60 km far ring is drawn from the DEM with no invented detail (`data`); near tiles blend into it at their outer edge.

---

## 8. Biome and ecology

**Biome (v1, rule-based)** from palaeolatitude, elevation, distance to coast and slice age. Temperature comes from published reconstruction grids, corrected for local elevation. Moisture comes from modelled precipitation grids, turned into an aridity ratio with the Köppen–Geiger dryness threshold (Peel, Finlayson and McMahon 2007). Together they feed soft, blended biome weights. Info cards show the spread between reconstructions (e.g. Judd et al. 2024 run warmer than Scotese et al. 2021 in hothouse intervals). Local topography only nudges moisture, so generated detail can't create climates the data don't support. The plant mix comes from nearby plant occurrences where they exist, falling back to an age-aware prior. All outputs are tagged `inferred`.

Accuracy constraints the rules must respect:
- No grass ground cover. Grasses are rare before the Late Cretaceous; the understorey is ferns, horsetails and similar.
- Flowering plants appear only from the Early Cretaceous and become dominant only late in the period.
- High-latitude Mesozoic forests have strong light seasonality and no ice caps for most of the era. Small highland ice is allowed only at 165 Ma and 130–150 Ma, where Scotese et al. (2021) consider brief ice possible, and is flagged as contested.
- Early Triassic equatorial heat (tropics ~39 °C near 252 Ma) suppresses vegetation and fauna at low latitudes (Sun et al. 2012).

**Ecology:**
- Pull occurrences from the tile's bin and its neighbours, weighted by distance and environment match.
- Taxa found within a defined radius are tagged `data`; taxa borrowed from further away or a neighbouring slice are tagged `inferred`.
- Each taxon is rendered via its body-plan model with size and colour parameters. Colour is always tagged `generated`.
- Fossil occurrences decide **presence**, not abundance (preservation favours large and water-side animals). Abundance comes from body mass via Damuth's law (Damuth 1981), a per-species relation calibrated to the *T. rex* estimate of ~1 adult per 100 km² (Marshall et al. 2021), times a provisional presence estimate from the strength of the fossil evidence. Realistically, most 16 km² tiles hold no large predator, so a "representative fauna" setting (default on) guarantees one group of each data-backed taxon, flagged as density-boosted. A field-guide panel lists the full tile roster.
- Fauna are ambient (idle and wander loops), with no AI.
- Clicking any organism opens an info card: name, source tag, a PBDB reference link and the occurrence's original age range.

**Post-extinction layer**

- **K–Pg boundary rule (66 Ma):** for the 65 Ma slice, the occurrence window is clipped to 62.5–66 Ma. Non-avian dinosaurs are excluded outright (in the pipeline), as are pterosaurs and marine reptiles (in ecology/), since none survived, and occurrences whose age range straddles 66 Ma are tagged `inferred`. This stops Maastrichtian dinosaurs from leaking into the post-extinction world.
- **65 Ma slice (data-led):** an early Palaeocene recovery world. Sparse fauna, dominated by mammals, birds, crocodylomorphs and turtles. Vegetation is impoverished, with ferns and pioneer plants prominent. The UI marks it as "after the extinction" on the time slider.
- **Aftermath mode (optional toggle on the 65 Ma slice)** uses the 65 Ma terrain (plate positions barely differ over ~1 Myr) and has two phases, because the literature puts them on very different timescales:
  - **Impact Winter (years 0–30):** dark sky; frost and snow even in the tropics; standing dead forest; no living plants. Temperatures drop by up to 26 °C, stay sub-freezing on annual average for ~3 years and recover over ~30 years (Brugger, Feulner and Petri 2017). A slider picks the year.
  - **Fern Spike (~1–20 thousand years):** fern fields, decaying snags and a normal but cooler sky. Fern dominance lasted roughly 8,000–20,000 years (Vajda et al. 2004).
  
  In both, terrain stays `data`, vegetation and temperature are `inferred`, and the sky is `generated`. The provenance overlay shows that the eeriness is reconstruction, not observation.

---

## 9. Deferred (v2+)

- Modern coastlines overlay on the globe: present-day coastlines rotated to each slice in the pipeline (first half of the next item).
- "Where was my town?": rotate a modern location to each slice with the same pyGPlates + PALEOMAP step, either precomputed on a grid or run as a small lookup table shipped with the app.
- Seam-safe hydraulic erosion, rivers and lakes.
- Seasonal climate (monthly temperature and precipitation), seasons and weather.
- Palaeozoic and Cenozoic slices.
- Animal behaviour.

---

## 10. Repo conventions

- `DESIGN.md` (this file) is the source of truth; update it before changing architecture.
- One module per coding session. Each module has a short `README.md` stating its inputs, outputs and invariants.
- Invariants from §2 and §7 get automated tests (mean preservation, seam continuity, determinism).
- Repo layout for licences: `LICENSE` (code, chosen at repo creation; see A15), `LICENSE-DOCS.md` (CC BY 4.0, Markdown docs), `public/data/LICENSE` (CC BY 4.0, derived data), `CREDITS.md`.

---

## 11. Licensing obligations

- **CC BY 4.0 sources** (PaleoDEMs 2024, PALEOMAP plate model, palaeotemperature and precipitation grids; PBDB was CC BY 4.0 until it moved to CC0): credit each source, link the licence, state what was changed (e.g. "resampled to int16 heightmaps", "coordinates rotated with PALEOMAP", "nearest-age interval matched to each slice, stored in 0.01 °C units"), and add no further restrictions. Commercial use is allowed.
- **Derived data** we publish must carry the same attribution. Releasing it as CC BY 4.0 keeps this simple.
- **pyGPlates (GPL-2.0-only)** is a pipeline dependency installed separately, never redistributed. Our pipeline scripts can be MIT because MIT is GPL-compatible. If pyGPlates is ever bundled (e.g. a Docker image), that distribution must meet GPL-2.0 terms.
- **PBDB attribution:** credit the Paleobiology Database and its contributors, with the download date and query parameters in `CREDITS.md`. CC0 removes the legal requirement, not the scholarly one: we keep the credit and per-occurrence reference numbers.

**Citations for CREDITS.md and the in-app About panel**

*Datasets (shipped in derived form)*
- Scotese, C.R., Vérard, C., Burgener, L., Elling, R.P. and Kocsis, A.T. (2024) *Phanerozoic-scope supplementary material to 'The Cretaceous World: Plate Tectonics, Paleogeography, and Paleoclimate' from the PALEOMAP project* (v24221) [Dataset]. Zenodo. doi:10.5281/zenodo.10659112. CC BY 4.0. (PaleoDEMs, item 5a; plate model v19o_r1d, item 3a.)
- Scotese, C.R. (2022) *Global Mean Surface Temperatures for 100 Phanerozoic Time Intervals* (scotese02a_v21321) [Dataset]. Zenodo. doi:10.5281/zenodo.5718392. CC BY 4.0.
- The Paleobiology Database. Available at: https://paleobiodb.org (licence as stated at download; CC0 since 2025) (Accessed: [date]).

*Papers behind the PaleoDEMs (cited at the dataset's request)*
- Scotese, C.R., Vérard, C., Burgener, L., Elling, R.P. and Kocsis, A.T. (2024) 'The Cretaceous world: plate tectonics, palaeogeography and palaeoclimate', *Geological Society, London, Special Publications*, 544, pp. 31–202. doi:10.1144/SP544-2024-28.
- Kocsis, Á.T. and Scotese, C.R. (2021) 'Mapping paleocoastlines and continental flooding during the Phanerozoic', *Earth-Science Reviews*, 213, 103463. doi:10.1016/j.earscirev.2020.103463.

*Papers behind the temperature and precipitation grids (cited at the dataset's request)*
- Scotese, C.R., Song, H., Mills, B.J.W. and van der Meer, D.G. (2021) 'Phanerozoic paleotemperatures: the earth's changing climate during the last 540 million years', *Earth-Science Reviews*, 215, 103503. doi:10.1016/j.earscirev.2021.103503.
- Valdes, P.J., Scotese, C.R. and Lunt, D.J. (2021) 'Deep ocean temperatures through time', *Climate of the Past*, 17(4), pp. 1483–1506. doi:10.5194/cp-17-1483-2021.

*Methods and climate values entered by hand* (`climate_by_age.json`, biome rules): Judd et al. (2024), Brugger, Feulner and Petri (2017), Vajda et al. (2004), Peel, Finlayson and McMahon (2007), with full entries in `REFERENCES.md`. The About panel lists these alongside the datasets.

---

## 12. Remaining checks

- ~~Plate model~~ **Resolved 2026-10-31:** v19o_r1d (A12). **Confirmed with fossils 2026-11-01:** terrestrial-environment PBDB occurrences rotated with v19o land on 1° DEM land 67–99% of the time per slice, and on land or shelf above −200 m 88–99.7% (`pipeline/checks/fossil_land_check.py`).
- Compare the derived 1° globe against the record's 1° CSV (item 5b) for one slice. *Needs the raw download in `pipeline/raw`, which is not in the current working copy.*
- The climate grids come from HadCM3L runs on the palaeogeography of Valdes et al. (2021), not the 2024 DEMs, so coastlines differ slightly. Measure the land/sea disagreement per slice and report it in the climate sidecar. *Needs the HadCM3L land mask from the raw climate files (not in the current working copy).*
- ~~Climate interval ages~~ **Done 2026-10-31:** every slice 65–250 Ma has an exact-age temperature and precipitation file; real-data quirks (legend anchors at 90°N in the temperature CSVs, varying pole rows, NaN padding columns, float32 coordinates in the 100 Ma DEM, mm/day units) are handled and tested.
- Ask the dataset authors whether the 65 Ma temperature grid deliberately represents K–Pg cooling, and confirm the precipitation units (mm/day, not mm/month as stated).
- ~~pyGPlates licence~~ **Confirmed 2026-11-02:** the pyGPlates 1.0.0 wheel's licence metadata is GPL version 2 only ("not any later version"). It stays a pipeline-only dependency, not shipped.
- ~~PhanDA licence~~ **Checked 2026-11-02:** the repository has no licence file. Only the per-stage GMST percentile values are stored (`pipeline/climate_by_age.json`), cited to Judd et al. (2024); nothing else is redistributed. Ask the authors for explicit permission when emailing them.
- ~~Reference details~~ **Done 2026-11-02:** volumes, issues, pages and DOIs confirmed for the ten entries flagged in `REFERENCES.md` (Druckenmiller et al. 2021 corrected to pp. 3469–3478.e5; Scotese et al. 2024 given pp. 31–202). Still open: the Zenodo creators list for scotese2024data.
- ~~Fossil pipeline on real data~~ **Done 2026-11-01** (see the check above; 3 non-avian dinosaurs excluded from the 65 Ma slice). Still to do: extend `rules.csv` for the remaining unmapped groups (lycopsids, gnetophytes, tracks and eggs, dinosaurs recorded without a family) and source the size hints.
- ~~Build `climate_by_age.json`~~ **Done 2026-11-02** (pipeline §1d): `pipeline/curate_climate.py` writes 38 slices with the grid's area-mean GMST, the PhanDA stage percentiles, ice flags and the 65 Ma aftermath parameters, every number referenced. Terrain cards show both global means and their difference.
- Check the Impact Winter light curve and its spatial pattern against Brugger, Feulner and Petri (2017); v1 cools uniformly by 26 °C at peak.
- Source the ecology placeholders: body-plan default lengths and masses (`src/ecology/roster.ts`) and per-taxon size hints in `pipeline/rules.csv`; calibrate the herbivore and omnivore density multiples (×10, ×3 of the carnivore constant) against Damuth (1981).
- ~~Calibrate terrain provenance levels~~ **Done 2026-11-02:** an absolute floor joins the relative one: ≥ 20 m of invented relief is at least `inferred`, ≥ 60 m `generated` (provenance amendment). Still worth checking by eye on a few orogens before figures are published.
- ~~Overlay colour-blind check~~ **Done 2026-11-02:** Machado et al. (2009) full-severity simulation of the Okabe–Ito overlay colours gives CIEDE2000 differences ≥ 41 for normal vision, but the closest pairs drop to 12 (data/generated, protanopia) and 11 (inferred/generated, tritanopia). They stay distinguishable because each level also has its own pattern (data plain, inferred dots, generated hatching) and lightness, and the legend names the levels. No change needed.
- Animal integument (pseudocode render §8): the drawn models (smooth hulls since 2026-11-02) have none. Build the clade table (feathers, filaments, scales) from published integument reviews, cite it in `REFERENCES.md`, and tag it `inferred`.
- ~~Animal density display~~ **Fixed 2026-11-02:** densities were split among all taxa of a trophic level by evidence share, which Damuth's per-species law does not support (*Furcatoceratops* at Hell Creek read ≈ 1 per 56,000 km²; it is now ≈ 1 per 8 km² where it lived). Each taxon now gets Damuth's per-species density plus a separate presence estimate, `1 − exp(−evidence weight)` (ecology §3 amendment). Still to do: test that presence reading against a sampled assemblage (e.g. Hell Creek quarry counts) before quoting expected counts, and limit co-occurrence within the 5 Myr slice window, so taxa that never overlapped in time aren't shown together at full density.
