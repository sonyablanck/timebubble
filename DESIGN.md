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

The finest global elevation data is 0.1° (about 11 km). The globe view uses the 1° set (about 100 km). Anything finer than 0.1° is generated. Two rules follow:

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
| A12 | Plate model | **PALEOMAP** (Scotese 2016) for everything | The PaleoDEMs are built on it; mixing models can misplace fossils relative to coastlines by several degrees |
| A13 | Resolution split | 1° DEM for the globe; 0.1° DEM, chunked by region, for terrain | Globe stays light; terrain gets the best constraint available, loaded on demand |
| A14 | Height format | Raw int16 (metres, little-endian), gzipped (`.i16.gz`), decoded in-browser with `DecompressionStream` | Browsers decode PNGs to 8 bits per channel; raw int16 is lossless and needs no decoder library |
| A16 | UI | Preact + TSX, HTML overlaid on the canvas; one view-state store synced to the URL | Small (MIT, ~4 KB); familiar React model that AI tools write fluently; accessible HTML instead of WebGL UI |
| A17 | Walk mode streaming | Floating origin at the current tile centre; 3 × 3 tile ring streamed around the player; far horizon drawn from the 0.1° DEM with no generated detail | Keeps float32 precision; lets players walk indefinitely; distant terrain is data, not invention |
| A15 | Licensing | Code: MIT recommended (AGPL-3.0 considered; if chosen, keep `/pipeline` under MIT because of pyGPlates' GPL-2.0-only licence). Docs and derived data: CC BY 4.0 | Matches the CC BY 4.0 sources; permissive code licence maximises research reuse; avoids the GPL-2.0-only / GPL-3.0 incompatibility in the pipeline (§11) |

---

## 4. Data sources and licences

| Source | Use | Format | Licence |
|---|---|---|---|
| PALEOMAP PaleoDEMs (Scotese & Wright 2018, v2) | Elevation and bathymetry per slice (0 m = palaeo-shoreline). 1° set for 540–0 Ma; 0.1° set for 540–0 Ma | 1°: GeoTIFF/netCDF; 0.1°: netCDF only | CC BY 4.0 |
| PALEOMAP plate model (rotation `.rot` + static polygons `.gpml`), from the PALEOMAP PaleoAtlas for GPlates v3 | Rotating fossil coordinates to each slice | GPlates formats | CC BY 4.0 (Zenodo record; confirm against the readme inside the zip) |
| Paleobiology Database (PBDB) API | Plant and animal occurrences: modern lat/lng, age range, taxonomy, environment | CSV/JSON | CC BY 4.0 |
| Scotese palaeotemperature grids (*Global Mean Surface Temperatures for 100 Phanerozoic Time Intervals*) | Mean annual surface temperature, 1°, 100 stage-level intervals; HadCM3L adjusted to proxies (Scotese et al. 2021; Valdes, Scotese and Lunt 2021) | netCDF / CSV | CC BY 4.0 |
| Published climate values (Judd et al. 2024; Brugger et al. 2017; Vajda et al. 2004; others in `REFERENCES.md`) | Uncertainty notes, aftermath constants, test benchmarks | Hand-entered with citations in `climate_by_age.json` | Facts with citation; check PhanDA repo licence before copying its files |
| Palaeo-precipitation (v2) | Replace the zonal moisture model | — | Candidate: Chandra et al. 2021 maps (13 slices, 14–249 Ma); licence and plate model unconfirmed |

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
   - **Globe:** 1° DEM → `.i16.gz` heightmap (360×181) + JSON sidecar (slice age, grid registration).
   - **Terrain:** 0.1° DEM → `.i16.gz` chunks of 10°×10° (101×101 cells, one-cell overlap) + index. The app loads only the chunks around the selected location.
   - **Continentality:** signed distance to coast (km) on the 1° grid, `globe/{age}.continentality.i16.gz`, used by biome.
   - **Temperature:** the nearest-age Scotese 1° temperature grid for each slice, `globe/{age}.temp.i16.gz` (0.01 °C units), with the age mismatch recorded.
   - **Climate parameters:** hand-curated `climate_by_age.json` (zonal moisture curve, dry-belt latitude, megamonsoon strength, ice flag, alternative global means, aftermath constants), each value cited.
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

- **Tile size:** 4 km × 4 km, heightfield 513×513 (~8 m spacing), split into 8×8 render chunks with LOD. A tile sits within roughly one 0.1° source cell.
- **Base surface:** bicubic interpolation of the **0.1° DEM** across the tile and its neighbouring cells.
- **Detail:** noise evaluated in **global palaeo-coordinates**, so adjacent tiles match at the edges with no seam handling.
- **Relief scaling:** noise amplitude depends on terrain class, derived from source elevation and local gradient:
  - abyssal / shelf / coastal plain: low
  - lowland / plateau: moderate
  - orogen: high, with ridged noise
- **Mean preservation:** after adding detail, subtract the mean residual per 0.1° cell so the source value still holds.
- **Coastline:** the 0 m contour of the final surface. Generated coastline wiggle is tagged `generated`; the source land/sea call is tagged `data`.
- **Water:** sea is a plane at 0 m. Rivers and lakes are deferred to v2, alongside erosion.

---

## 8. Biome and ecology

**Biome (v1, rule-based)** from palaeolatitude, elevation, distance to coast and slice age. Temperature comes from published reconstruction grids, corrected for local elevation; moisture comes from a cited zonal model (no open gridded precipitation yet). Together they feed soft, blended biome weights. Info cards show the spread between reconstructions (e.g. Judd et al. 2024 run warmer than Scotese et al. 2021 in hothouse intervals). Local topography only nudges moisture, so generated detail can't create climates the data don't support. The plant mix comes from nearby plant occurrences where they exist, falling back to an age-aware prior. All outputs are tagged `inferred`.

Accuracy constraints the rules must respect:
- No grass ground cover. Grasses are rare before the Late Cretaceous; the understorey is ferns, horsetails and similar.
- Flowering plants appear only from the Early Cretaceous and become dominant only late in the period.
- High-latitude Mesozoic forests have strong light seasonality and no ice caps for most of the era. Small highland ice is allowed only at 165 Ma and 130–150 Ma, where Scotese et al. (2021) consider brief ice possible, and is flagged as contested.
- Early Triassic equatorial heat (tropics ~39 °C near 252 Ma) suppresses vegetation and fauna at low latitudes (Sun et al. 2012).

**Ecology:**
- Pull occurrences from the tile's bin and its neighbours, weighted by distance and environment match.
- Taxa found within a defined radius are tagged `data`; taxa borrowed from further away or a neighbouring slice are tagged `inferred`.
- Each taxon is rendered via its body-plan model with size and colour parameters. Colour is always tagged `generated`.
- Fossil occurrences decide **presence**, not abundance (preservation favours large and water-side animals). Abundance comes from body mass via Damuth's law (Damuth 1981), calibrated to the *T. rex* estimate of ~1 adult per 100 km² (Marshall et al. 2021). Realistically, most 16 km² tiles hold no large predator, so a "representative fauna" setting (default on) guarantees one group of each data-backed taxon, flagged as density-boosted. A field-guide panel lists the full tile roster.
- Fauna are ambient (idle and wander loops), with no AI.
- Clicking any organism opens an info card: name, source tag, a PBDB reference link and the occurrence's original age range.

**Post-extinction layer**

- **K–Pg boundary rule (66 Ma):** for the 65 Ma slice, the occurrence window is clipped to 62.5–66 Ma. Non-avian dinosaurs are excluded outright, and occurrences whose age range straddles 66 Ma are tagged `inferred`. This stops Maastrichtian dinosaurs from leaking into the post-extinction world.
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
- Climate-model-driven biomes, seasons and weather.
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

- **CC BY 4.0 sources** (PaleoDEMs, PALEOMAP plate model, PBDB, palaeotemperature grids): credit each source, link the licence, state what was changed (e.g. "resampled to int16 heightmaps", "coordinates rotated with PALEOMAP", "nearest-age interval matched to each slice, stored in 0.01 °C units"), and add no further restrictions. Commercial use is allowed.
- **Derived data** we publish must carry the same attribution. Releasing it as CC BY 4.0 keeps this simple.
- **pyGPlates (GPL-2.0-only)** is a pipeline dependency installed separately, never redistributed. Our pipeline scripts can be MIT because MIT is GPL-compatible. If pyGPlates is ever bundled (e.g. a Docker image), that distribution must meet GPL-2.0 terms.
- **PBDB attribution:** credit the Paleobiology Database and its contributors, with the download date and query parameters in `CREDITS.md`.

**Citations for CREDITS.md and the in-app About panel**

*Datasets (shipped in derived form)*
- Scotese, C.R. and Wright, N.M. (2018) *PALEOMAP Paleodigital Elevation Models (PaleoDEMS) for the Phanerozoic* (v2) [Dataset]. Zenodo. doi:10.5281/zenodo.5460860. CC BY 4.0.
- Scotese, C.R. (2016) *PALEOMAP PaleoAtlas for GPlates* (v3) [Dataset]. Zenodo. doi:10.5281/zenodo.10596610. CC BY 4.0.
- Scotese, C.R. (2022) *Global Mean Surface Temperatures for 100 Phanerozoic Time Intervals* (scotese02a_v21321) [Dataset]. Zenodo. doi:10.5281/zenodo.5718392. CC BY 4.0.
- The Paleobiology Database. Available at: https://paleobiodb.org (CC BY 4.0) (Accessed: [date]).

*Papers behind the temperature grids (cited at the dataset's request)*
- Scotese, C.R., Song, H., Mills, B.J.W. and van der Meer, D.G. (2021) 'Phanerozoic paleotemperatures: the earth's changing climate during the last 540 million years', *Earth-Science Reviews*, 215, 103503. doi:10.1016/j.earscirev.2021.103503.
- Valdes, P.J., Scotese, C.R. and Lunt, D.J. (2021) 'Deep ocean temperatures through time', *Climate of the Past*, 17(4), pp. 1483–1506. doi:10.5194/cp-17-1483-2021.

*Climate values entered by hand* (`climate_by_age.json`): Judd et al. (2024), Brugger, Feulner and Petri (2017), Vajda et al. (2004), Chandra et al. (2021), Parrish (1993), with full entries in `REFERENCES.md`. The About panel lists these alongside the datasets.

---

## 12. Remaining checks

- Open the PaleoAtlas v3 zip and confirm its readme matches the Zenodo CC BY 4.0 licence for the rotation and polygon files.
- Confirm pyGPlates 1.0's bundled licence file (conda-forge lists GPL-2.0-only).
- Read the temperature dataset's readme: variable, units, interval ages, grid registration. Confirm its HadCM3L runs use the PALEOMAP palaeogeography.
- Check the PhanDA (Judd et al. 2024) GitHub repository licence.
- Confirm the unverified page ranges listed at the end of `REFERENCES.md`.
