# data/ module pseudocode — Time Bubble

Loads, decodes and caches everything in `/public/data`. Pure I/O: no geometry and no rules. Works on the main thread and inside the terrain Web Worker (one instance per thread; no shared state).

Conventions as in `pipeline/PSEUDOCODE.md`: `# INVARIANT:` lines become tests, `# CHECK:` lines are facts to verify first.

---

## 0. Public interface

```ts
interface DataStore {
  manifest(): Promise<Manifest>
  slice(age: number): Promise<SliceHandle>      // snaps to nearest available age
}

interface SliceHandle {
  age: number
  label: string                                 // e.g. "after the extinction"
  aftermathMode: boolean
  globe(): Promise<Grid>                        // 1° heightmap, for globe + continentality
  continentality(): Promise<Grid>               // 1° signed distance-to-coast, km
  temperature(): Promise<Grid>                  // 1° mean annual temperature, 0.01 °C units
  climate(): Promise<ClimateParams>             // this slice's entry in climate_by_age.json
  dem(): DemSampler                             // 0.1°, chunk-backed, see §3
  ensureRegion(lat, lon, radiusCells): Promise<void>  // preload chunks before sampling
  ecology(): Promise<EcologyIndex>              // binned occurrences, see §4
}

interface Grid {
  width: number; height: number; res: number
  registration: "cell" | "node"
  values: Int16Array                            // row 0 = north, col 0 = lon −180
  at(latIdx, lonIdx): number                    // wraps lon, clamps lat
}
```

---

## 1. Manifest

```
manifest():
    if cached: return it
    m = await fetchJson(BASE + "manifest.json")
    validate(m):
        slices sorted descending by age, ages unique
        every path relative, no ".."
        plate_model == "PALEOMAP (Scotese 2016)"
    cache and return m

slice(age):
    m = await manifest()
    s = nearest(m.slices, age)                  # A6: snap to nearest slice
    return SliceHandle(s)                       # cheap; loads lazily
```

`BASE` comes from Vite's `import.meta.env.BASE_URL` + `"data/"`, so it works under the GitHub Pages sub-path.

---

## 2. Binary decoding

```
fetchInt16(path, expectedLength):
    buf = await fetchBytes(path)                # retry ×2 with backoff on network error
    if buf[0] == 0x1f and buf[1] == 0x8b:       # gzip magic: decompress ourselves
        buf = await gunzip(buf)                 # DecompressionStream("gzip")
    # else: host already decoded via Content-Encoding; use as-is
    assert buf.byteLength == expectedLength * 2
    return new Int16Array(buf)                  # little-endian; CHECK: assert host is
                                                # little-endian once at startup (all
                                                # mainstream desktops are)
```

```
# INVARIANT: gzipped and plain inputs decode to identical arrays
# INVARIANT: wrong length → typed error naming the file, never silent garbage
```

---

## 3. DEM sampler (0.1°, chunk-backed)

Chunks from the pipeline: 10°×10°, 101×101 cells, one shared overlap cell on the east and south edges.

```
CELLS_PER_CHUNK = 100                           # unique cells; 101 stored

chunkKeyFor(latIdx, lonIdx):
    return (floor(latIdx / 100), floor(lonIdx / 100))

ensureRegion(lat, lon, radiusCells):
    keys = all chunkKeys covering the cell box around (lat, lon) ± radiusCells,
           with lon wrapped
    await Promise.all(keys.map(loadChunk))      # dedupe in-flight requests

loadChunk(key):
    if lru.has(key): touch and return
    if inFlight.has(key): return inFlight.get(key)
    path = index.lookup(key)                    # from terrain/{age}/index.json
    if path missing: store an "all-ocean" sentinel chunk (−4000 m) and log
                     # CHECK: confirm the pipeline writes every chunk; this is a guard
    arr = await fetchInt16(path, 101 * 101)
    lru.put(key, arr)                           # capacity 16 chunks ≈ 330 KB

cell(latIdx, lonIdx):                           # synchronous; region must be preloaded
    latIdx = clamp(latIdx, 0, NLAT − 1)
    lonIdx = mod(lonIdx, NLON)
    chunk  = lru.get(chunkKeyFor(latIdx, lonIdx))
    if !chunk: throw RegionNotLoaded(latIdx, lonIdx)   # bug in caller, not a fallback
    return chunk[(latIdx mod 100) * 101 + (lonIdx mod 100)]
```

The sampler stays synchronous so terrain's inner loops never `await`. Terrain calls `ensureRegion` once per tile before generating.

```
# INVARIANT: cell() at a chunk's overlap column equals the neighbour's first column
# INVARIANT: cell(lat, NLON) == cell(lat, 0)   (antimeridian wrap)
# INVARIANT: sampling never triggers a fetch
```

---

## 4. Ecology index

```
ecology():
    raw = await fetchJson("ecology/{age}.json")       # { binKey: Occurrence[] }
    return EcologyIndex(raw)

EcologyIndex.near(lat, lon, radiusKm) -> Occurrence[]:
    bins = binKeys within radius (5° bins; handle lon wrap and poles)
    return occurrences in bins where greatCircleKm(o, point) <= radiusKm,
           each annotated with distanceKm

EcologyIndex.plantsNear(lat, lon, radiusKm) -> Occurrence[]
    = near(...) filtered to plant body plans
```

The whole slice file loads at once (expected to be a few MB at most per slice). `# CHECK:` measure real file sizes after the first pipeline run; split by bin if any slice exceeds ~5 MB.

---

## 5. Caching policy

| Asset | Cache | Lifetime |
|---|---|---|
| manifest | memory | session |
| globe, continentality, temperature | memory, current slice + previous | evicted on slice change |
| climate_by_age.json | memory | session |
| DEM chunks | LRU, 16 chunks per thread | session |
| ecology | memory, current slice only | evicted on slice change |

The HTTP cache does the rest. Files are immutable per data version, so the pipeline's `inputs_hash` is appended as a query string (`?v=…`) to bust stale caches after a data refresh.

---

## 6. Errors

```
DataError { kind: "network" | "format" | "missing" | "region", path, detail }
```

UI shows network errors with a retry button. Format errors are bugs and appear in the console with the file path.
