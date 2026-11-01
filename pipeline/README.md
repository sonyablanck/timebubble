# pipeline/

Offline Python scripts that turn the raw datasets into the static files in `public/data`. Design: [`PSEUDOCODE.md`](PSEUDOCODE.md). Status: steps 0–5 and the manifest half of 6 are coded. The fossil steps (2–5) are tested on a synthetic PBDB download and the real plate model; they have been run on the real PBDB download of 2026-11-01 (608,780 rows; 516,075 after cleaning; 890,510 occurrence-slices in `public/data/ecology/`, 11 MB gzipped).

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r pipeline/requirements.txt
```

## Raw data

Time Bubble uses the **2024 PALEOMAP release** (Scotese et al. 2024; Zenodo doi:10.5281/zenodo.10659112, CC BY 4.0). Download these items from that record and unzip each into its own folder. `pipeline/raw/` is git-ignored.

| Item | Unzip into |
|---|---|
| `5a. PaleoDEM (nc, 3601x1801).zip` (0.1°, 128.7 MB) | `pipeline/raw/dem_01deg/` |
| `6a1. Mean Annual Temperatures (csv, list).zip` | `pipeline/raw/temperature/` |
| `6b2. Mean Annual Precipitation (nc).zip` | `pipeline/raw/precipitation/` |
| `3a. PALEOMAP Global Plate Model for Paleogeographic Reconstructions v.19o_r1d.zip` | `pipeline/raw/plate_model/` (step 3) |

Precipitation is in **mm/day**, although the record's explanation says mm/month; the global-mean check enforces this. Use the **list-format** temperature CSVs (6a1), not the grid-format ones (6a2): a bare matrix has no coordinates, so its orientation can't be checked, and the reader rejects it.

The 1° globe grid is area-averaged from the 0.1° grid, so no 1° download is needed. (If `pipeline/raw/dem_1deg/` holds 1° netCDFs, as in the 2018 release, those are used instead.)

Then check that every slice has a file:

```bash
python -m pipeline.ingest_dem --list
```

Ages are parsed from the file names (2024: `150_v23220d.nc`; 2018: `..._150Ma.nc`), never hard-coded. If a slice age has no matching file, `--list` reports it.

## Run

```bash
python -m pipeline.ingest_dem          # all 38 slices (or --ages 150 65)
python -m pipeline.continentality
python -m pipeline.ingest_climate --list   # shows which interval each slice gets
python -m pipeline.ingest_climate
python -m pipeline.build_manifest          # last: indexes whatever has been built
```

### Fossils (steps 2–5)

Needs the plate model (item 3a above) and `pip install pygplates` (pipeline only; GPL-2.0-only, never shipped).

1. Download the occurrences. Either let the script do it (`python -m pipeline.fossils`), or open this URL in a browser and save the file (it's large: a few hundred thousand rows; the server can take minutes to start sending):

   ```
   python -m pipeline.ingest_pbdb --print-url
   ```

   gives `https://paleobiodb.org/data1.2/occs/list.csv?min_ma=62.5&max_ma=252.5&timerule=overlap&show=class,coords,env&vocab=pbdb&limit=all&datainfo`

2. Run all four steps and rebuild the manifest:

   ```bash
   python -m pipeline.fossils --from-file ~/Downloads/pbdb_data.csv
   ```

3. Review `pipeline/review/unmapped_taxa.csv` (taxa with no rule in `pipeline/rules.csv`, most common first). Add rules, then rerun from step 4 (`python -m pipeline.classify_taxa && python -m pipeline.bin_occurrences && python -m pipeline.build_manifest`).

Reports land next to the intermediate files in `pipeline/raw/`: `pbdb/pbdb_clean_report.json` (rows dropped at each cleaning step), `rotated/rotate_report.json` (per slice: occurrences, non-avian dinosaurs excluded under the K–Pg rule), `classified/classify_report.json`. `pbdb/pbdb_query.json` records the URL, access time and the licence PBDB stated; the manifest copies it for credits.

## Outputs

| File | Contents |
|---|---|
| `globe/{age}.i16.gz` | 1° elevation (area mean of the 0.1° grid), int16 metres, row 0 = north, column 0 = lon −180 |
| `globe/{age}.json` | sidecar: width, height, registration, lat_north, lon_west, min/max, source file |
| `globe/{age}.continentality.i16.gz` | signed great-circle km to the nearest coast (land +, sea −, coast 0) |
| `globe/{age}.temp.i16.gz` | mean annual temperature, int16 in 0.01 °C |
| `globe/{age}.precip.i16.gz` | mean annual precipitation, int16 in 0.01 mm/day |
| `globe/{age}.climate.json` | source file, source interval age, age mismatch, override reason, min/max/area mean, pole cells flattened |
| `terrain/{age}/r{R}_c{C}.i16.gz` | 0.1° chunk, 101×101 int16: 100 unique cells + one overlap row (south) and column (east) |
| `terrain/{age}/index.json` | chunk list, grid dimensions, registration |
| `ecology/{age}.json` | fossil occurrences rotated to the slice, in 5° bins keyed by south-west corner; each with PBDB occurrence and reference numbers, body plan, palaeo-position, age range and age fit |
| `manifest.json` | every slice with its label, period, grid dimensions and asset paths; `data_version` for cache-busting; the PBDB download's access time and stated licence |

All `.i16.gz` files are raw little-endian int16, gzipped with `mtime=0`.

## What the code decides for itself

These were `# CHECK:` items. The code now detects them rather than assuming them, and records the result in each sidecar:

- **Variable and coordinate names:** looks for `lat`/`latitude`, `lon`/`longitude`, and picks the 2D variable on them (preferring `z`).
- **Orientation:** flips south-up grids; converts 0–360 longitudes to −180–180.
- **Duplicated seam column** (lon −180 and 180 both present): the 180 column is dropped. In the 2024 files the two columns are independent estimates and differ by up to ~3 km in a few rows; the −180 column fits its neighbours better. The maximum difference goes in `index.json`.
- **Grid registration** (node vs cell): from the latitude extent. Node-registered 1° grids are 360×181; 0.1° grids are 3600×1801, in 19 × 36 chunks.
- **Nodata:** NaN or |value| > 15 km is filled from the nearest valid cell, with longitude wrapping; the count goes in the sidecar.

The `--list` step and the sidecars will confirm what the real files contain. If anything surprises the reader (e.g. a third coordinate name), it raises an error naming the file rather than guessing.

## Invariants (tested in `tests/`)

- `decode(write_int16(x)) == round(x)` for every cell
- overlapping edge cells of adjacent chunks are identical, including across the antimeridian
- chunks reassemble exactly into the source grid
- no NaN or nodata remains after filling
- re-running on unchanged inputs gives byte-identical output
- climate grids use the nearest-age interval (ties go to the older one) unless `config.CLIMATE_OVERRIDES` says otherwise, have constant pole rows, are rejected if their cell values or global mean are implausible for the expected units (mm/day, °C), and must match the heightmap's layout
- continentality is 0 only on coast cells, positive on land, negative at sea, and continuous across the antimeridian

Tests use synthetic netCDF files, so they run without the downloads:

```bash
python -m pytest          # from the repo root
```
