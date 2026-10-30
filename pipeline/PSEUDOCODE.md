# Pipeline pseudocode — Time Bubble

Implements DESIGN.md §5. Offline, Python, run once per data refresh. Output goes to `/public/data`.

Conventions:
- `# INVARIANT:` lines become automated tests.
- `# CHECK:` lines are facts to verify against the real files or API before coding that step.
- All coordinates are (lat, lon) in degrees, lon in [-180, 180).

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

PALEOMAP_ROT   = DATA_RAW + "PALEOMAP_PlateModel.rot"
PALEOMAP_POLYS = DATA_RAW + "PALEOMAP_PlatePolygons.gpml"

slices() -> list of ages from SLICE_MAX_MA down to SLICE_MIN_MA in steps of SLICE_STEP
```

---

## 1. ingest_dem.py

```
for age in slices():
    # CHECK: PaleoDEM filenames encode age; parse age from name, never hard-code names
    src_1deg  = find_dem_file(resolution=1.0, age=age)
    src_01deg = find_dem_file(resolution=0.1, age=age)

    # CHECK: grid registration (cell-centred vs node). Affects interpolation and
    #        mean preservation; record it in the sidecar.
    grid_1   = read_raster(src_1deg)      -> array[lat, lon] of float metres
    grid_01  = read_raster(src_01deg)

    normalise_orientation(grid)           # north at row 0, lon from -180
    fill_nodata(grid)                     # nearest-neighbour; log count

    # --- Globe ---
    write_int16(DATA_OUT/globe/{age}.i16.gz, round(grid_1))
    write_json (DATA_OUT/globe/{age}.json, {
        age, width, height, res: 1.0, registration,
        min_elev, max_elev, source: "PaleoDEM 1deg v2", provenance: "data" })

    # --- Terrain chunks ---
    for chunk_lat in range(-90, 90, CHUNK_DEG):
        for chunk_lon in range(-180, 180, CHUNK_DEG):
            block = slice_with_overlap(grid_01, chunk_lat, chunk_lon,
                                       CHUNK_DEG, CHUNK_OVERLAP)  # wraps at lon ±180
            write_int16(DATA_OUT/terrain/{age}/{chunk_lat}_{chunk_lon}.i16.gz, round(block))

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

## 1c. ingest_temperature.py (needed by biome/)

Source: Scotese, *Global Mean Surface Temperatures for 100 Phanerozoic Time Intervals*, Zenodo, CC BY 4.0 (DOI 10.5281/zenodo.5718392; latest version 10.5281/zenodo.8238875). These are 1° netCDF grids (361×181) for 100 stage-level intervals, from HadCM3L runs (Valdes, Scotese and Lunt, 2021) adjusted to δ18O proxies and lithological indicators (Scotese et al., 2021).

```
# CHECK: read readme.md: variable name, units, exact interval ages, grid registration
# CHECK: confirm the HadCM3L runs use the PALEOMAP palaeogeography (Valdes et al. 2021);
#        if so, model coastlines line up with our DEMs
intervals = list netCDF files with their representative ages (Ma)

for age in slices():
    src = interval with representative age nearest to `age`
          # nearest, not interpolated: blending two plate configurations
          # smears temperatures across shifting coastlines
    T = read(src)                                   # 361×181, lon −180..180 inclusive
    T = drop duplicate lon 180 column -> 360×181    # CHECK: identical to lon −180
    T = normalise_orientation(T)                    # same layout as the 1° DEM
    write_int16(DATA_OUT/globe/{age}.temp.i16.gz, round(T * 100))   # 0.01 °C units
    sidecar += { temp_source_interval, temp_source_age, age_mismatch_myr }

# INVARIANT: every slice has a temperature grid; |age_mismatch_myr| logged per slice
# WARN if |age_mismatch_myr| > 3 (info card shows the mismatch)
# SANITY: grid-wide area-weighted mean reported per slice next to Scotese et al.
#         (2021) published global averages; flag differences > 2 °C for review
```

## 1d. climate_by_age.json (hand-curated, copied as-is)

```
per slice: {
    age,
    zonal_moisture: [ { lat, value } control points ],   # 0..1
    dry_belt_lat,                     # Triassic ≈ 35 (Chandra et al. 2021); CHECK others
    megamonsoon_strength,             # 0..1; high Triassic → Early Jurassic (Parrish 1993)
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

`gmst_judd`: the PhanDA time series is on GitHub (Judd et al., 2024). `# CHECK:` the repository licence before copying values; if it isn't open, store only the values with a citation, which is how a scientific fact is normally reused.

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
rotation_model  = load_rotation_model(PALEOMAP_ROT)
static_polygons = load_features(PALEOMAP_POLYS)

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
        key = bin_key(o.palaeo_lat, o.palaeo_lon, BIN_DEG)    # e.g. "35_-5"
        bins[key].append({
            id: o.occurrence_no, name: o.accepted_name, rank: o.accepted_rank,
            body_plan, size_hint, matched_level,
            lat: o.palaeo_lat, lon: o.palaeo_lon,
            env: o.environment, age_range: [o.min_ma, o.max_ma], age_fit,
            ref: o.reference_no })
    write_json(DATA_OUT/ecology/{age}.json, bins)

# INVARIANT: every occurrence appears in exactly one bin
```

---

## 6. build_manifest.py

```
manifest = {
    pipeline_version, plate_model: "PALEOMAP (Scotese 2016)",
    inputs_hash,          # hash of raw inputs + rules.csv; NOT a timestamp,
                          # which would break byte-identical output
    slices: [ for age in slices(): {
        age,
        label: "after the extinction" if age < KPG_MA else period_name(age),
        aftermath_mode: age < KPG_MA,
        globe:   "globe/{age}.i16.gz",
        continentality: "globe/{age}.continentality.i16.gz",
        temperature:    "globe/{age}.temp.i16.gz",
        terrain: "terrain/{age}/index.json",
        ecology: "ecology/{age}.json",
        counts:  { occurrences, taxa, bins } } ]
}
write_json(DATA_OUT/manifest.json, manifest)

write CREDITS.md data section:
    for each dataset (PaleoDEMs, PALEOMAP plate model, temperature grids, PBDB):
        name, version, DOI, licence, changes made
    PBDB retrieval date and query
    papers each dataset asks us to cite (temperature grids: Scotese et al. 2021;
        Valdes, Scotese and Lunt 2021)
    every ref key used in climate_by_age.json, resolved from REFERENCES.md
    # INVARIANT: every ref key in climate_by_age.json exists in REFERENCES.md
write public/data/credits.json (same content, for the in-app About panel)
copy hand-curated facts.json ("Did you know?" cards, ui/ §1c) to public/data
    # INVARIANT: every fact has a ref key that exists in REFERENCES.md
```

---

## run_all.py

```
run ingest_dem -> continentality -> ingest_temperature -> copy climate_by_age -> ingest_pbdb -> rotate -> classify_taxa -> bin_occurrences -> build_manifest
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
