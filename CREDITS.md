# Credits

Time Bubble's derived data (`public/data/`) is built from these openly licensed datasets. The PALEOMAP datasets are CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); the Paleobiology Database states CC0, and we credit it anyway.

| Dataset | Used for | What we changed |
|---|---|---|
| Scotese, C.R., Vérard, C., Burgener, L., Elling, R.P. and Kocsis, A.T. (2024) *Phanerozoic-scope supplementary material to 'The Cretaceous World'* (v24221). Zenodo. doi:10.5281/zenodo.10659112 | PaleoDEMs (item 5a), plate model v19o_r1d (item 3a), temperature (6a1) and precipitation (6b2) grids | Converted to gzipped int16 grids; 0.1° DEM split into 10° chunks and area-averaged to 1° for the globe; climate stored in 0.01 units; the 65 Ma slice uses the 60 Ma temperature grid |
| Scotese, C.R. (2022) *Global Mean Surface Temperatures for 100 Phanerozoic Time Intervals* (scotese02a_v21321). Zenodo. doi:10.5281/zenodo.5718392 | Temperature grids (identical to item 6a1 above) | As above |
| The Paleobiology Database, https://paleobiodb.org | Fossil occurrences (once the fossil pipeline has run) | Rotated to each slice with PALEOMAP v19o_r1d; mapped to body plans by `pipeline/rules.csv`; binned in 5° cells. Licence and access date as stated by the download are recorded in `public/data/manifest.json`. |

Papers behind the data, cited at the datasets' request: Scotese et al. (2024), Kocsis and Scotese (2021), Scotese et al. (2021), Valdes, Scotese and Lunt (2021). Full entries are in [`REFERENCES.md`](REFERENCES.md).

Software: Three.js, Preact and Vite (MIT).
