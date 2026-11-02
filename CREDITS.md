# Credits

Time Bubble's derived data (`public/data/`) is built from these openly licensed datasets. The PALEOMAP datasets are CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); the Paleobiology Database states CC0, and we credit it anyway.

| Dataset | Used for | What we changed |
|---|---|---|
| Scotese, C.R., Vérard, C., Burgener, L., Elling, R.P. and Kocsis, A.T. (2024) *Phanerozoic-scope supplementary material to 'The Cretaceous World'* (v24221). Zenodo. doi:10.5281/zenodo.10659112 | PaleoDEMs (item 5a), plate model v19o_r1d (item 3a), temperature (6a1) and precipitation (6b2) grids | Converted to gzipped int16 grids; 0.1° DEM split into 10° chunks and area-averaged to 1° for the globe; climate stored in 0.01 units; the 65 Ma slice uses the 60 Ma temperature grid |
| Scotese, C.R. (2022) *Global Mean Surface Temperatures for 100 Phanerozoic Time Intervals* (scotese02a_v21321). Zenodo. doi:10.5281/zenodo.5718392 | Temperature grids (identical to item 6a1 above) | As above |
| Judd, E.J. et al. (2024) PhanDA global mean surface temperature reconstruction (*Science*, doi:10.1126/science.adk3705), values from the authors' GitHub repository | Stage-level GMST percentiles (p5–p95) shown beside the climate grid's global mean on terrain cards | Only the per-stage percentile values are stored, in `pipeline/climate_by_age.json`, with the citation; the repository has no licence file, so nothing else from it is redistributed |
| The Paleobiology Database, https://paleobiodb.org | Fossil occurrences | Rotated to each slice with PALEOMAP v19o_r1d; mapped to body plans by `pipeline/rules.csv`; binned in 5° cells. Licence and access date as stated by the download are recorded in `public/data/manifest.json`. |

Papers behind the data, cited at the datasets' request: Scotese et al. (2024), Kocsis and Scotese (2021), Scotese et al. (2021), Valdes, Scotese and Lunt (2021). Full entries are in [`REFERENCES.md`](REFERENCES.md).

Software: Three.js, Preact and Vite (MIT). pyGPlates 1.0 (GPL-2.0-only) is used by the pipeline only and is not shipped.

The app's About & credits panel is generated from the same sources: `pipeline/build_manifest.py` writes `public/data/credits.json`, and the build fails if any number in `climate_by_age.json` lacks a reference that resolves in `REFERENCES.md`.
