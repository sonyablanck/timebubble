# Time Bubble

**Walk through the Mesozoic, built from real data, with every guess labelled.**

Time Bubble is a desktop browser explorer for Earth between 250 and 65 million years ago. Pick a moment on a reconstructed globe, choose a place, and walk a landscape generated from published palaeogeography, palaeoclimate and fossil-occurrence data.

The world is honest about what it knows. Everything carries a provenance tag:

- **data**: taken directly from a published dataset, such as palaeo-elevation or a fossil occurrence nearby
- **inferred**: derived from data by a stated rule or model, such as biomes from reconstructed climate
- **generated**: invented to fill gaps, such as fine terrain detail or an animal's colour

Press **P** in-app to see the overlay. Any view can be exported as a provenance report with a citation and a link that reopens it.

> **Status: v1, feature-complete** (November 2026). Everything below is coded and tested on the real datasets: the pipeline's elevation, continentality, climate and manifest steps; the app's data loader; **the globe**, with its time slider, climate layers and picking; and **a first walk mode**: seamless generated terrain that keeps each 0.1° cell's mean, walking and flight, the horizon drawn from the DEM, sea, sky, the provenance overlay (P) and click-to-inspect; **biomes** from the modelled climate, including the 65 Ma Impact Winter and Fern Spike; and **fossils**: about 890,000 Paleobiology Database occurrences rotated to their slices, on the globe and in the plant mix. An **ecology** step decides which taxa live on each tile and how many (Damuth's law), and places plants and animal groups; the field guide (G) lists them with their evidence and can point you to the nearest one (Locate). The **provenance overlay** (P, Shift+P for focus and evidence modes) shows what is data, inferred or generated, with in-view shares; **R** gives a citation, a link that reopens the view, and a downloadable provenance report. **Plants and animals are drawn** in walk mode as generic body-plan models, with several shapes per plant type, walking and grazing animals, and sun shadows (L turns them off on slower computers); click one to see its fossil evidence. The sea is tinted by depth with foam at the shore, hot climates get a heat haze, and **K** saves a captioned screenshot. An intro, Help (**H**), Settings and an About & credits panel are on every screen. **Where was my town?** Search for a modern place (or type coordinates) and a pin shows where its plate carried it on each slice, labelled `inferred`. The whole app works from the keyboard (Tab to the globe, Enter picks the place at the centre), and passes automated WCAG 2.2 AA checks on every screen. Values that are still provisional (some animal sizes and density multiples, the presence estimate) are labelled as such in the app; see DESIGN §12.

## Try it

**In your browser:** the live site, if published, is linked at the top of this repository's page (GitHub Pages). It needs a desktop browser with WebGL2 (recent Chrome, Edge, Firefox or Safari).

**On your own computer** (Node 20 or newer, from https://nodejs.org):

```bash
git clone <this repository's URL>
cd time-bubble
npm install
npm run dev
```

Open the address it prints (usually http://localhost:5173), click a place on the globe, then **Walk here**. The processed data ships in `public/data/`, so you don't need Python or the raw datasets unless you want to rebuild it.

## Quick start

```bash
# 1. Data (Python 3.11+): download the inputs listed in pipeline/README.md, then
pip install -r pipeline/requirements.txt
python -m pipeline.ingest_dem && python -m pipeline.continentality \
  && python -m pipeline.ingest_climate && python -m pipeline.places && python -m pipeline.build_manifest

# 2. App (Node 20+)
npm install
npm run dev         # open the URL it prints: the globe; pick a place, then "Walk here"
npm test            # unit tests, plus a check against public/data if it exists
python -m pytest    # pipeline tests
```

---

## What you can do

- Scrub through 38 time slices from the Early Triassic to just after the end-Cretaceous extinction, and watch the continents move.
- Click anywhere on the globe and walk there. Terrain streams in 4 km tiles, with the horizon drawn straight from elevation data.
- Meet the plants and animals recorded by fossils nearby, at densities estimated from body size, with a field guide for the whole area.
- Visit the aftermath of the Chicxulub impact in two phases: **Impact Winter** (the first ~30 years) and the **Fern Spike** (the following thousands of years).
- Export a provenance report and a "cite this view" string for research use.
- Search for a modern town and see where it was on every slice (place names are looked up with OpenStreetMap's Nominatim).

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

All data is preprocessed and shipped as static files: no backend, no accounts. The one outside request is the optional place search, which sends what you type to OpenStreetMap's Nominatim service.

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
| [`src/places/`](src/places/PSEUDOCODE.md) | Modern place search and rotation to a slice |
| [`src/ui/`](src/ui/PSEUDOCODE.md) | Interface, accessibility, settings |

In the pseudocode, `# INVARIANT:` lines become automated tests, and `# CHECK:` lines are facts to verify against the real data before that step is coded.

---

## Roadmap

1. **Pipeline:** download the datasets, resolve the `CHECK` items, produce `/public/data`. *(elevation, climate, fossils, manifest, credits and climate parameters: done)*
2. **Globe:** time slider, layers, picking. *(done)*
3. **Terrain and walk mode:** streaming tiles, walk and flight, overlay, inspect. *(first version done)*
4. **Biome and ecology:** biomes, ecology and drawing plants and animals *(done, including the field guide's Locate button)*.
5. **Provenance overlay and reports:** source, focus and evidence overlays, in-view shares, invented-coastline outline, provenance report, cite this view, links that reopen a view. *(done)*
6. **Polish:** intro, help, settings, About & credits, depth-tinted sea with shoreline foam, heat haze, photo mode (K), accessibility audit (axe-core on every screen, keyboard-only journey, focus handling, 150% text). *(done; a manual screen-reader pass is still worth doing)*
7. **Where was my town?** Modern place search with a pin that follows its plate. *(done)*

Deferred to v2: modern coastlines on the globe, rivers and erosion, seasons, a temperature-scenario toggle, Palaeozoic and Cenozoic slices, animal behaviour.

---

## Data and credits

Time Bubble stands on openly licensed science:

- Scotese, C.R. et al. (2024) PALEOMAP PaleoDEMs and Global Plate Model v19o_r1d, supplementary material to *The Cretaceous World*. doi:10.5281/zenodo.10659112. CC BY 4.0.
- Scotese, C.R. (2022) *Global Mean Surface Temperatures for 100 Phanerozoic Time Intervals*. doi:10.5281/zenodo.5718392. CC BY 4.0. Based on Scotese et al. (2021) and Valdes, Scotese and Lunt (2021).
- Judd, E.J. et al. (2024) PhanDA global mean surface temperatures, *Science* 385, eadk3705 (stage values only, shown beside the climate grid's own global mean).
- The Paleobiology Database, https://paleobiodb.org (CC0 since 2025; credited regardless).
- Place search: Nominatim, with data © OpenStreetMap contributors (ODbL), https://www.openstreetmap.org/copyright. Queried live; nothing from it is stored in this repository.

Full references, including the climate and ecology literature behind the model, are in [`REFERENCES.md`](REFERENCES.md).

---

## Licence

- **Code:** see [`LICENSE`](LICENSE).
- **Documentation** (Markdown files: design, pseudocode, references): [CC BY 4.0](LICENSE-DOCS.md).
- **Derived data** (`/public/data`): [CC BY 4.0](public/data/LICENSE), carrying the attributions above; the licence file lists each source and what was changed.

---

## Contributing

Ideas, corrections and palaeontological pedantry are very welcome: open an issue. Corrections to the science should cite a source, so they can go into `REFERENCES.md`.

Maintained by **Sonya Blanck**.
