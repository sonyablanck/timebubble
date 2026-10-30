# Time Bubble

**Walk through the Mesozoic, built from real data, with every guess labelled.**

Time Bubble is a desktop browser explorer for Earth between 250 and 65 million years ago. Pick a moment on a reconstructed globe, choose a place, and walk a landscape generated from published palaeogeography, palaeoclimate and fossil-occurrence data.

The world is honest about what it knows. Everything carries a provenance tag:

- **data**: taken directly from a published dataset, such as palaeo-elevation or a fossil occurrence nearby
- **inferred**: derived from data by a stated rule or model, such as biomes from reconstructed climate
- **generated**: invented to fill gaps, such as fine terrain detail or an animal's colour

Press **P** in-app to see the overlay. Any view can be exported as a provenance report with a citation and a link that reopens it.

> **Status: design stage.** The architecture and pseudocode for every module are written; implementation has not started yet.

---

## What you'll be able to do (v1)

- Scrub through 38 time slices from the Early Triassic to just after the end-Cretaceous extinction, and watch the continents move.
- Click anywhere on the globe and walk there. Terrain streams in 4 km tiles, with the horizon drawn straight from elevation data.
- Meet the plants and animals recorded by fossils nearby, at densities estimated from body size, with a field guide for the whole area.
- Visit the aftermath of the Chicxulub impact in two phases: **Impact Winter** (the first ~30 years) and the **Fern Spike** (the following thousands of years).
- Export a provenance report and a "cite this view" string for research use.

---

## How it works

```
Offline pipeline (Python)                      Browser app (TypeScript, Three.js)
─────────────────────────                      ──────────────────────────────────
PaleoDEMs ─────────┐                           globe ── pick a time and place
Temperature grids ─┼─▶ heightmaps, climate,    terrain ─ data surface + labelled detail
PBDB fossils ──────┤   rotated & binned   ──▶  biome ── climate → biomes, plant mix
PALEOMAP rotations ┘   occurrences             ecology ─ who lives here, how many
                                               render ── walk mode, sky, photo mode
                                               provenance ─ tags, overlay, reports
```

All data is preprocessed and shipped as static files: no backend, no accounts.

---

## Repository guide

| Path | What it is |
|---|---|
| [`DESIGN.md`](DESIGN.md) | Source of truth: goals, architecture decisions, data sources, licensing |
| [`REFERENCES.md`](REFERENCES.md) | Every paper and dataset cited, in Harvard style |
| [`pipeline/PSEUDOCODE.md`](pipeline/PSEUDOCODE.md) | Offline data pipeline |
| [`src/data/`](src/data/PSEUDOCODE.md) | Loading, decoding and caching |
| [`src/terrain/`](src/terrain/PSEUDOCODE.md) | Seamless terrain that preserves the source data |
| [`src/biome/`](src/biome/PSEUDOCODE.md) | Climate, biomes and plant mix |
| [`src/ecology/`](src/ecology/PSEUDOCODE.md) | Fauna and flora: presence, abundance, placement, behaviour |
| [`src/provenance/`](src/provenance/PSEUDOCODE.md) | Flag registry, overlay, info cards, reports |
| [`src/globe/`](src/globe/PSEUDOCODE.md) | The globe and time slider |
| [`src/render/`](src/render/PSEUDOCODE.md) | Walk mode rendering |
| [`src/ui/`](src/ui/PSEUDOCODE.md) | Interface, accessibility, settings |

In the pseudocode, `# INVARIANT:` lines become automated tests, and `# CHECK:` lines are facts to verify against the real data before that step is coded.

---

## Roadmap

1. **Pipeline:** download the datasets, resolve the `CHECK` items, produce `/public/data`.
2. **Globe:** time slider, layers, picking.
3. **Terrain:** one walkable tile, then streaming.
4. **Biome and ecology:** plants first, then fauna.
5. **Provenance overlay and reports.**
6. **Polish:** render presets, photo mode, UI, accessibility.

Deferred to v2: modern coastlines on the globe, "where was my town?", rivers and erosion, seasons, precipitation grids, a temperature-scenario toggle, Palaeozoic and Cenozoic slices, animal behaviour.

---

## Data and credits

Time Bubble stands on openly licensed science:

- Scotese, C.R. and Wright, N.M. (2018) *PALEOMAP Paleodigital Elevation Models (PaleoDEMS) for the Phanerozoic* (v2). doi:10.5281/zenodo.5460860. CC BY 4.0.
- Scotese, C.R. (2016) *PALEOMAP PaleoAtlas for GPlates* (v3). doi:10.5281/zenodo.10596610. CC BY 4.0.
- Scotese, C.R. (2022) *Global Mean Surface Temperatures for 100 Phanerozoic Time Intervals*. doi:10.5281/zenodo.5718392. CC BY 4.0. Based on Scotese et al. (2021) and Valdes, Scotese and Lunt (2021).
- The Paleobiology Database, https://paleobiodb.org. CC BY 4.0.

Full references, including the climate and ecology literature behind the model, are in [`REFERENCES.md`](REFERENCES.md).

---

## Licence

- **Code:** see [`LICENSE`](LICENSE).
- **Documentation** (Markdown files: design, pseudocode, references): [CC BY 4.0](LICENSE-DOCS.md).
- **Derived data** (`/public/data`, once generated): CC BY 4.0, carrying the attributions above.

---

## Contributing

Ideas, corrections and palaeontological pedantry are very welcome: open an issue. Corrections to the science should cite a source, so they can go into `REFERENCES.md`.

Maintained by **Sonya Blanck**.
