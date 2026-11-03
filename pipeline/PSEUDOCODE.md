# Pipeline pseudocode — Time Bubble

Implements DESIGN.md §5. Offline, Python, run once per data refresh. Output goes to `/public/data`.

Conventions:
- `# INVARIANT:` lines become automated tests.
- `# CHECK:` lines are facts to verify against the real files or API before coding that step.
- All coordinates are (lat, lon) in degrees, lon in [-180, 180).


> **Status (2026-11-03):** steps 0–7 are coded, tested and run on the real data (step 6 and §1d, credits.json and climate_by_age.json, completed 2026-11-02; step 7, modern places, added 2026-11-03). Fossil steps run on the real data (PBDB download of 2026-11-01: 608,780 rows → 516,075 clean; every one fell inside a plate polygon). Real-data findings: PBDB writes `NO_ORDER_SPECIFIED`-style placeholders (read as empty); many dinosaurs are filed as class Reptilia with no order, so dinosaur detection uses every dinosaur family in `rules.csv` plus egg and track families; microfossils and algae get body plan `skip` (counted, not reviewed); 5.4% of occurrence-slices remain unmapped (no taxonomy, dinosaurs without a family, tracks, lycopsids, gnetophytes, liverworts: see `pipeline/review/unmapped_taxa.csv`). Ecology files are gzipped JSON (`ecology/{age}.json.gz`, 11 MB in all, from 204 MB plain). Terrestrial-environment fossils land on 1° DEM land 67–99% of the time, and on land or shelf above −200 m 88–99.7% (`pipeline/checks/fossil_land_check.py`), confirming the plate model choice (DESIGN A12). Settled while coding: the PBDB query uses `min_ma=62.5&max_ma=252.5&timerule=overlap&show=class,coords,env&vocab=pbdb&limit=all&datainfo` (parameter names confirmed against published PBDB download metadata); the `datainfo` header is parsed for the access time and licence. Intermediates are gzipped CSV/JSON rather than parquet (no extra dependency). PBDB's own download metadata has stated **CC0** since at least November 2025 (earlier CC BY 4.0); the pipeline records whatever the actual download says. Non-avian dinosaurs are recognised by Saurischia/Ornithischia and their subgroups at class, order or family level, birds (Aves) kept. `rules.csv` is a starter set; size hints stay blank until sourced.
---

## 0. config.py

```
DATA_RAW     = "pipeline/raw/"        # downloads, never committed
DATA_OUT     = "public/data/"
SLICE_MIN_MA = 65                     # post-extinction slice included (DESIGN §8)
KPG_MA       = 66.0                   # K–Pg boundary
SLICE_MAX_MA = 250
SLICE_STEP   = 5                      # matches PaleoDEM interval
SLICE_HALF_WINDOW = SLICE_STEP / 2    # occurrence matching window, ±2.5 Myr

GLOBE_RES    = 1.0                    # degrees
TERRAIN_RES  = 0.1                    # degrees
CHUNK_DEG    = 10                     # terrain chunk size
CHUNK_OVERLAP = 1                     # cells shared with the next chunk

BIN_DEG      = 5                      # occurrence bins

HEIGHT_DTYPE = int16, metres, little-endian
HEIGHT_EXT   = ".i16.gz"              # gzip with mtime=0 for byte-identical output

DEM source     = PALEOMAP PaleoDEMs, 2024 release (Zenodo 10659112, item 5a), 0.1° netCDF
PLATE_MODEL    = PALEOMAP v19o_r1d, same record (item 3a): Scotese_Plate_Model_forPgeog_v19o_r1d_v240506a.rot
                 + Scotese_Plate_Polygons__forPgeog_v19o_v240506.gpml (confirmed, DESIGN A12)

slices() -> list of ages from SLICE_MAX_MA down to SLICE_MIN_MA in steps of SLICE_STEP
```

---

## 1. ingest_dem.py

```
for age in slices():
    # 2024 names are '{age:03d}_v{version}.nc' (e.g. 150_v23220d.nc); parse, never hard-code
    src_01deg = find_dem_file(resolution=0.1, age=age)
    src_1deg  = find_dem_file(resolution=1.0, age=age) or None   # only the 2018 release has one

    # CHECK: grid registration (cell-centred vs node). Affects interpolation and
    #        mean preservation; record it in the sidecar.
    grid_01  = read_raster(src_01deg)     -> array[lat, lon] of float metres
    grid_1   = read_raster(src_1deg) if src_1deg
               else area_mean(grid_01, factor 10)   # trapezoid weights on node grids

    normalise_orientation(grid)           # north at row 0, lon from -180; the ±180°
                                          # columns differ in the 2024 files (two estimates
                                          # of one meridian): keep −180, record max diff
    fill_nodata(grid)                     # nearest-neighbour; log count

    # --- Globe ---
    write_int16(DATA_OUT/globe/{age}.i16.gz, round(grid_1))
    write_json (DATA_OUT/globe/{age}.json, {
        age, width, height, res: 1.0, registration,
        min_elev, max_elev, source, resampling, provenance: "data" })

    # --- Terrain chunks ---
    # chunk (R, C) = global rows R*100 .. R*100+100, cols C*100 .. C*100+100
    # (row 0 = north), matching data/ §3's chunkKeyFor(latIdx, lonIdx)
    for R in 0 .. ceil(NLAT / 100) − 1:              # 19 rows for 1801 node rows
        for C in 0 .. NLON / 100 − 1:                # 36 columns
            block = 101×101 window, cols wrap at lon ±180, rows clamp at the south pole
            write_int16(DATA_OUT/terrain/{age}/r{R}_c{C}.i16.gz, round(block))

    write_json(DATA_OUT/terrain/{age}/index.json, chunk list + dims + registration)

# INVARIANT: decode(write_int16(x)) == round(x) for every cell
# INVARIANT: overlapping edge cells of adjacent chunks are identical
# INVARIANT: chunk at lon 170 and chunk at lon -180 join across the antimeridian
# INVARIANT: no NaN or nodata remains after fill
```

---

## 1b. continentality.py (needed by biome/)

```
for age in slices():
    grid = read globe/{age}.i16.gz            # 1° DEM from step 1
    land = grid >= 0
    coast_cells = land cells with at least one sea neighbour (4-neighbour, lon wraps)
    for each cell:
        dist_km = great-circle distance to the nearest coast cell
                  # brute-force over coast cells is fine at 360×181; or a
                  # multi-source Dijkstra on the sphere for speed
        value = dist_km if land else −dist_km   # sign marks land vs sea
    write_int16(DATA_OUT/globe/{age}.continentality.i16.gz, round(value))

# INVARIANT: |value| == 0 only on coast cells
# INVARIANT: value continuous across the antimeridian
```

## 1c. ingest_climate.py (needed by biome/) — coded

Sources, both in the 2024 PALEOMAP record (Zenodo 10659112), 1°, 361×181, node-registered:
- **Temperature** (item 6a1, list-format CSV): mean annual surface temperature, version scotese02a_v21321, identical to Scotese (2022). HadCM3L runs (Valdes, Scotese and Lunt, 2021) adjusted to δ18O proxies and lithological indicators (Scotese et al., 2021).
- **Precipitation** (item 6b2, netCDF): mean annual precipitation, version scotese_02. Raw HadCM3L output (Valdes, Scotese and Lunt, 2021), not proxy-adjusted. Units are **mm/day**, although the record's explanation says mm/month: area means are 3.2–4.1, against ≈ 2.7 mm/day for Earth today.

```
for var in (temp, precip):
    intervals = files in raw/{var}/ with ages parsed from their names
    for age in slices():
        src = CLIMATE_OVERRIDES[(var, age)] if present          # documented substitution
              else interval with age nearest to `age`           # ties -> older interval
              # nearest, not interpolated: blending two plate configurations
              # smears climate across shifting coastlines
        G = load_global_grid(src)    # CSV list or netCDF; drops the duplicate lon 180
                                     # column and NaN padding past 180°E; snaps float32
                                     # coordinates; same layout as the 1° DEM
        flatten_pole_rows(G)         # each pole is one point: set the row to its median
                                     # (removes the 50 °C / −55 °C legend anchors at 90°N)
        reject if any cell falls outside plausible bounds
        reject if the area-weighted mean falls outside its range (temp 5–40 °C,
               precip 1–6 mm/day): catches K vs °C and mm/month vs mm/day
        reject if G's shape or registration differs from globe/{age}.json
        write_int16(globe/{age}.{var}.i16.gz, round(G * scale))   # temp ×100 (0.01 °C),
                                                                   # precip ×100 (0.01 mm/day)
    write_json(globe/{age}.climate.json, per var: source, file, source_age,
               age_mismatch_myr, override_reason, units, min, max, area-weighted mean,
               pole_cells_flattened)

# OVERRIDE (only one): temp at 65 Ma uses the 60 Ma grid. The 65 Ma grid has an area
#   mean of 8.1 °C (−9 °C at 60°N) between ~21–22 °C neighbours, although the dataset's
#   documentation calls 65–40 Ma a hothouse; Aftermath mode models K–Pg cooling itself.

# INVARIANT: every slice has both grids, aligned with the heightmap
# WARN if |age_mismatch_myr| > 3 (info card shows the mismatch)
# SANITY: area-weighted mean temperature per slice next to Scotese et al. (2021)
#         published global averages; flag differences > 2 °C for review
# CHECK: land/sea disagreement between the climate model's palaeogeography and the
#        2024 DEMs, per slice (the model ran on the Valdes et al. 2021 geography)
```

## 1d. climate_by_age.json — coded (`curate_climate.py`)

```
per slice: {
    age,
    # (zonal moisture, dry-belt latitude and megamonsoon strength were dropped:
    #  moisture now comes from the precipitation grids, §1c)
    ice_possible,                     # true only 165 Ma and 130–150 Ma (Scotese et al. 2021)
    gmst_scotese, gmst_judd,          # global means for the uncertainty note
                                      # (Scotese et al. 2021; Judd et al. 2024)
    aftermath: (65 Ma only) {
        impact_winter: { peak_cooling_C: 26, subfreezing_years: 3, recovery_years: 30 },
                                      # Brugger, Feulner and Petri 2017
        fern_spike:    { duration_kyr: [8, 20] }          # Vajda et al. 2004
    },
    refs: [citation keys into REFERENCES.md]
}
validated against a schema: every numeric field must have a ref
```

`gmst_judd`: the PhanDA time series is on GitHub (Judd et al., 2024). The repository has no licence file (checked 2026-11-02), so only the per-stage percentile values are stored, with the citation, which is how a scientific fact is normally reused.

**As coded (2026-11-02):** `python -m pipeline.curate_climate --phanda <PhanDA_GMSTandCO2_percentiles.csv> --data <out>` writes 38 slices. `gmst_scotese` is the area-weighted mean of the temperature grid the slice uses (from its sidecar), with the grid's age; `gmst_judd` holds p5, p16, p50, p84 and p95 for the stage containing the slice (half-open stage ranges). `build_manifest.py` copies the file into the output and refuses to build if any numeric field lacks a reference that resolves in `REFERENCES.md`. Tests: `pipeline/tests/test_climate_params.py`.

---

## 2. ingest_pbdb.py

```
# CHECK: exact parameter and field names against the PBDB data1.2 API docs
query = {
    min_ma: 62.5, max_ma: 252.5,      # covers every slice window, incl. the
                                      # Palaeocene side of the 65 Ma slice
    show:     coords, classification, environment, references,
    fields:   occurrence_no, collection_no, reference_no,
              accepted_name, accepted_rank,
              phylum, class, order, family, genus,
              lat, lng,                 # MODERN coordinates
              max_ma, min_ma,           # age range
              environment
}

raw = fetch_paged(PBDB_URL, query)       # retry with backoff; respect the API
save(DATA_RAW/pbdb_{retrieval_date}.csv, raw)
save(DATA_RAW/pbdb_query.json, { query, retrieval_date, row_count })   # for CREDITS

clean = raw
    .drop_rows(missing lat or lng or max_ma or min_ma)
    .drop_rows(accepted_rank coarser than family)    # too vague to place or render
    .dedupe(on = [collection_no, accepted_name])

save(DATA_RAW/pbdb_clean.parquet, clean)
log counts dropped at each step

# INVARIANT: max_ma >= min_ma for every row
```

---

## 3. rotate.py (pyGPlates + PALEOMAP)

```
rotation_model  = load_rotation_model(PLATE_MODEL .rot file)
static_polygons = load_features(PLATE_MODEL static/partitioning polygons)

occ = load(DATA_RAW/pbdb_clean.parquet)

# Assign each occurrence to a plate using present-day polygons (done once)
partitioner = plate_partitioner(static_polygons, rotation_model, time=0)
for o in occ:
    o.plate_id = partitioner.plate_containing(o.lat, o.lng)   # None if outside all polygons
log and drop rows where plate_id is None

for age in slices():
    window = [age - SLICE_HALF_WINDOW, age + SLICE_HALF_WINDOW]

    # K–Pg rule (DESIGN §8): the post-extinction slice never reaches back
    # across the boundary
    if window contains KPG_MA and age < KPG_MA:
        window.upper = KPG_MA                      # 65 Ma -> [62.5, 66.0]

    in_slice = occ where overlap([o.min_ma, o.max_ma], window) > 0

    if age < KPG_MA:
        in_slice = in_slice.drop(is_non_avian_dinosaur(o))   # Dinosauria minus Aves
        for o in in_slice where o.max_ma > KPG_MA:
            o.straddles_kpg = True                 # renderer tags these `inferred`

    for o in in_slice:
        # Rotate to the SLICE age, not the occurrence midpoint:
        # the fossil must sit on the same map as this slice's DEM.
        (o.palaeo_lat, o.palaeo_lon) = reconstruct_point(o.lat, o.lng, o.plate_id,
                                                         age, rotation_model)
        o.age_fit = overlap_length / max(o.max_ma - o.min_ma, 0.01)  # 1.0 = range fully inside window; guard point ages
        o.slice_age = age

    save(DATA_RAW/rotated/{age}.parquet, in_slice)

# INVARIANT: no non-avian dinosaur appears in any slice younger than KPG_MA
# INVARIANT: reconstruct_point(p, time=0) == p (within 1e-6 degrees)
# INVARIANT: every palaeo_lat in [-90, 90], palaeo_lon in [-180, 180)
# INVARIANT (sanity): a sample of rotated points falls on land or shelf in that
#   slice's 1° DEM at a rate well above chance; report the rate and do not fail on it

# REPORT: share of terrestrial occurrences (envClass TERRESTRIAL) landing on DEM land
#   per slice. The plate model is already settled (DESIGN A12); this confirms it with
#   fossils, since the DEM coastlines were fitted to PBDB localities (Kocsis and Scotese 2021).
```

---

## 4. classify_taxa.py

```
# Body-plan classes the renderer understands
CLASSES = [small_theropod, large_theropod, sauropod, prosauropod, ornithopod,
           ceratopsian, ankylosaur, stegosaur, pterosaur, crocodylomorph,
           marine_reptile, turtle, small_tetrapod, fish, invertebrate,
           conifer, cycad_bennettitalean, ginkgo, fern, horsetail,
           early_angiosperm, seed_fern]

# rules.csv: hand-curated, ordered most specific first
#   level, name, body_plan, size_hint
#   genus,  Tyrannosaurus, large_theropod, 12
#   family, Dromaeosauridae, small_theropod, 2
#   order,  Sauropoda, sauropod,
rules = load(pipeline/rules.csv)

def classify(o):
    for level in [genus, family, order, class, phylum]:
        rule = rules.lookup(level, o[level])
        if rule: return rule.body_plan, rule.size_hint, matched_level=level
    return None

for age in slices():
    occ = load(DATA_RAW/rotated/{age}.parquet)
    for o in occ:
        o.body_plan, o.size_hint, o.matched_level = classify(o) or (None, None, None)
    unmapped += occ where body_plan is None
    save(DATA_RAW/classified/{age}.parquet, occ where body_plan is not None)

write(pipeline/review/unmapped_taxa.csv, unmapped grouped by taxonomy, with counts)

# Size: PBDB has no body size. size_hint comes only from rules.csv;
# if missing, the renderer uses the class default and tags size as `inferred`.
```

---

## 5. bin_occurrences.py

```
for age in slices():
    occ = load(DATA_RAW/classified/{age}.parquet)
    bins = {}
    for o in occ:
        key = bin_key(o.palaeo_lat, o.palaeo_lon, BIN_DEG)    # e.g. "35_-5": south-west
                                                               # corner; must match data/'s binKey()
        bins[key].append({
            id: o.occurrence_no, name: o.accepted_name, rank: o.accepted_rank,
            body_plan, size_hint, matched_level,
            lat: o.palaeo_lat, lon: o.palaeo_lon,
            env: o.environment, age_range: [o.min_ma, o.max_ma], age_fit,
            ref: o.reference_no, straddles_kpg })
    write_json(DATA_OUT/ecology/{age}.json, bins)

# INVARIANT: every occurrence appears in exactly one bin
```

---

## 6. build_manifest.py — coded (manifest, credits.json, climate parameters)

```
manifest = {
    schema: 1, pipeline_version, plate_model: "PALEOMAP v19o_r1d (Scotese et al. 2024)",
    dem_source, kpg_ma,
    data_version,         # hash of every asset file's bytes; NOT a timestamp, which
                          # would break byte-identical output. Used by the app for ?v=
    climate_params?, credits?,   # paths, once those files exist
    slices: [ for age in slices(): {
        age,
        label: "150 Ma · Late Jurassic" / "65 Ma · Palaeocene · after the extinction",
        period, epoch,        # ICS chart v2024/12; Cretaceous base 143.1 Ma
        aftermath_mode: age < KPG_MA,
        grid, terrain_grid,   # dimensions, so the app decodes without fetching sidecars
        globe:   "globe/{age}.i16.gz",
        globe_meta: "globe/{age}.json",
        continentality: "globe/{age}.continentality.i16.gz",
        temperature:    "globe/{age}.temp.i16.gz",
        precipitation:  "globe/{age}.precip.i16.gz",
        climate_meta:   "globe/{age}.climate.json",
        terrain: "terrain/{age}/index.json",
        ecology: "ecology/{age}.json" or null until steps 2–5 exist,
        counts:  { occurrences, taxa, bins } } ]     # with the fossil steps
}
write_json(DATA_OUT/manifest.json, manifest)

write CREDITS.md data section:
    for each dataset (PaleoDEMs 2024, PALEOMAP plate model, temperature and precipitation grids, PBDB):
        name, version, DOI, licence, changes made
    PBDB retrieval date and query
    papers each dataset asks us to cite (DEMs: Scotese et al. 2024, Kocsis and Scotese 2021;
        climate grids: Scotese et al. 2021, Valdes, Scotese and Lunt 2021)
    every ref key used in climate_by_age.json, resolved from REFERENCES.md
    # INVARIANT: every ref key in climate_by_age.json exists in REFERENCES.md
write public/data/credits.json (same content, for the in-app About panel)
copy hand-curated facts.json ("Did you know?" cards, ui/ §1c) to public/data
    # INVARIANT: every fact has a ref key that exists in REFERENCES.md
```

---

## §7 places.py: modern places (DESIGN A19)

```
partitioner = the fossils' (rotate.Rotator): PALEOMAP v19o static polygons at 0 Ma
for each 0.1° cell centre (bulk partition_geometry, same polygon order as partition_point):
    plate, plate_begin = polygon's plate ID and begin time
seafloor_age = OceansOnly polygon begin time, looked up at 0.5°, then per 0.1° cell in any 0.5° block
               whose 3 × 3 neighbourhood mixes ocean and not-ocean (coasts)
crust_from_ma = youngest of (plate_begin, seafloor_age) that is a real age (0, ≥ 4000 and ±inf mean "not stated")
units = unique (plate, crust_from_ma); grid = index into units (int16, 0 = no plate)
for each slice, each plate: quaternion of rotations.get_rotation(age, plate)   (anchor 0, from 0 Ma)

# INVARIANT: quaternion · v equals pyGPlates' rotation of v (< 1 m)           (pytest)
# INVARIANT: the browser's placement of 128 fixture points equals pyGPlates' (< 0.1 km where the
#            0.1° grid gives the same plate, ≥ 97% of points)                  (npm test, real data)
# INVARIANT: never pin crust on a slice older than crust_from_ma               (unit test)
```

Measured 2026-11-03: 223 plates, 1,931 units, 99.95% of cells on a plate; 184 KB grid + 752 KB JSON (≈ 0.25 MB served gzipped).

---

## run_all.py

```
run ingest_dem -> continentality -> ingest_climate -> copy climate_by_age -> ingest_pbdb -> rotate -> classify_taxa -> bin_occurrences -> places -> build_manifest
stop on first failed INVARIANT; print a summary table of counts per slice

# INVARIANT: two runs on unchanged inputs produce byte-identical /public/data
#   (gzip mtime=0, sorted JSON keys, stable row order)
# Report total /public/data size; warn above 800 MB (Pages limit is 1 GB)
```

---

## Settled decisions

- **Last slice:** 65 Ma, with the K–Pg boundary rule above and Aftermath mode (DESIGN §8).
- **Height format:** gzipped raw int16 in metres (DESIGN A14). Runtime note: if a host ever serves `.gz` with `Content-Encoding: gzip`, the browser will decompress automatically. The loader should check for the gzip magic bytes (`1f 8b`) before calling `DecompressionStream`.
- **Storage:** processed data is committed to the repo (DESIGN A3). Byte-identical output keeps history growth to real data changes only.
