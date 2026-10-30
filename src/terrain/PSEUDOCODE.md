# Terrain module pseudocode — Time Bubble

Implements DESIGN.md §2 and §7. TypeScript, runs in a Web Worker.

Conventions as in `pipeline/PSEUDOCODE.md`: `# INVARIANT:` lines become tests, `# CHECK:` lines are facts to verify first.

---

## Core idea

Terrain is **one continuous global function** per slice:

```
H(lat, lon) = base(lat, lon) + detail(lat, lon) − correction(lat, lon)
```

A tile is just a window of samples of H. Because H depends only on position (never on which tile is asking), neighbouring tiles agree wherever their samples coincide. That property is what keeps seams honest and cheap.

- **base:** smooth interpolation of the 0.1° PaleoDEM (`data`).
- **detail:** noise whose amplitude depends on terrain class (`generated`).
- **correction:** a smooth field that pulls each 0.1° cell's mean back to its source value (enforces the §2 invariant).

---

## 0. Interfaces

```ts
interface TileRequest {
  sliceAge: number          // Ma
  lat: number; lon: number  // palaeo-coordinates of the click
}

interface Tile {
  id: TileId                // { sliceAge, row, col }
  centre: { lat, lon }
  size: 4000                // metres per side
  n: 513                    // vertices per side
  heights: Float32Array     // n*n, metres, local frame (y up)
  normals: Float32Array     // n*n*3
  provenance: Uint8Array    // n*n bit flags, see §6
  terrainClass: Uint8Array  // n*n dominant class, for biome
  classWeights: Float32Array// n*n*K, blended class weights, for biome
  seaMask: Uint8Array       // n*n, 1 = below 0 m
  coarseCoastDistKm: Float32Array // n*n, from 0.1° land/sea grid
  chunks: ChunkMeta[]       // 8x8 render chunks
}

// Provided by the data module:
interface DemSampler {
  cell(age, latIdx, lonIdx): number   // 0.1° value, wraps lon, clamps lat
  resolution: 0.1
  registration: "cell" | "node"       // from the pipeline sidecar
}
```

---

## 1. Tile grid (deterministic placement)

```
R      = 6_371_000                          # Earth radius, m
TILE_M = 4000
DLAT   = deg(TILE_M / R)                    # ~0.036°

tileIdFor(lat, lon):
    lat = clamp(lat, -89.5, 89.5)           # avoid polar singularity
    row = floor((lat + 90) / DLAT)
    rowLat = -90 + (row + 0.5) * DLAT
    dlon = DLAT / cos(rad(rowLat))          # tiles widen in degrees towards poles
    col = floor((wrapLon(lon) + 180) / dlon)
    return { row, col }

tileCentre(row, col) -> { lat: rowLat, lon: -180 + (col + 0.5) * dlon }

neighbours(tile):
    E/W: same row, col ± 1 (wrap at the antimeridian)
    N/S: row ± 1, the col whose centre lon is nearest
```

A click snaps to the tile containing it, so the same spot always yields the same tile.

```
# INVARIANT: tileIdFor(tileCentre(r, c)) == (r, c)
# INVARIANT: tiles at the antimeridian wrap to col 0 / last col consistently
```

---

## 2. Vertex positions

```
for i, j in 0..n-1:                         # plus a 1-vertex border for normals
    x = (j / (n-1) - 0.5) * TILE_M          # east, metres
    y = (i / (n-1) - 0.5) * TILE_M          # north, metres
    lat = centre.lat + deg(y / R)
    lon = centre.lon + deg(x / (R * cos(rad(lat))))
    p   = unitSphere(lat, lon) * R          # 3D point, float64, for noise
```

Use float64 (plain JS numbers) for `p`. At Earth-radius magnitudes, float32 loses sub-metre precision, which would make fine noise octaves shimmer. This is one reason generation stays on the CPU for v1.

---

## 3. base(lat, lon)

```
# CHECK: registration. If "cell", source values are cell means at cell centres.
(u, v) = continuous grid coords of (lat, lon) in the 0.1° grid
base = bicubicBSpline(sampler, age, u, v)   # 4x4 support, lon wraps
```

A B-spline is smooth and never overshoots, unlike Catmull-Rom. It doesn't pass exactly through cell values, which doesn't matter because the correction step (§5) handles fidelity.

---

## 4. detail(lat, lon)

### 4a. Terrain class weights

Computed from the base surface, so they vary smoothly and identically for every tile:

```
elev  = base(lat, lon)
slope = |∇base| over ~1 cell (m per km)

weights (unnormalised, smooth ramps, not hard thresholds):
  abyssal      : ramp(elev, −4000 → −3000, falling)
  shelfSlope   : bump(elev, −3000 … −200) * ramp(slope)
  coastalPlain : bump(elev, −200 … 150)   * (1 − ramp(slope))
  lowland      : bump(elev, 100 … 1200)
  plateau      : ramp(elev, 800 → 1500)   * (1 − ramp(slope))
  orogen       : max(ramp(elev, 1500 → 3000), ramp(slope, high))
normalise to sum 1
```

### 4b. Noise per class

All thresholds and amplitudes are starting values to tune visually.

| Class | Amplitude (m) | Character |
|---|---|---|
| abyssal | 20 | smooth fBm |
| shelfSlope | 40 | fBm, slight ridging along slope |
| coastalPlain | 4 | very low, broad |
| lowland | 60 | fBm with mild domain warp |
| plateau | 40 | fBm, flattened (terraced bias) |
| orogen | 600 | ridged multifractal, strong warp |

```
SEED = hash(sliceAge)                       # global per slice, NOT per tile
λ_max = 8 km                                # below the 0.1° cell (~11 km), so detail
                                            # never invents features the data would show
λ_min = 16 m                                # 2x vertex spacing; finer would alias

detail = Σ_k weights[k] * amplitude[k] * noise_k(warp(p), SEED, λ_max..λ_min)
```

### 4c. Coastal damping

```
detail *= smoothstep(0, COAST_K, |base|)    # COAST_K ≈ 30 m
```

This stops noise from flooding land or raising islands where the data shows otherwise. Some coastline wiggle remains and is tagged `generated` (§6).

---

## 5. correction(lat, lon): mean preservation

The correction is defined per 0.1° cell, then interpolated smoothly. It depends only on the cell and its neighbours, so it is tile-independent.

```
cellResidual(c):                            # c = 0.1° cell index
    samples = 16x16 stratified points in cell c
    mean_c  = average(base + detail − correction) over samples
    return mean_c − source(c)

solveCorrection(cells):                     # all cells under the tile + 2-cell ring
    corr[c] = 0 for all
    repeat 3 times:                         # converges fast; smooth field
        for c in cells: corr[c] += cellResidual(c)
    return corr

correction(lat, lon) = bicubicBSpline(corr, u, v)
```

Memoise `corr` per (slice, cell) in an LRU, so walking into a neighbouring tile reuses it.

```
# INVARIANT: for every cell fully inside a tile, |mean(H) − source| < 1 m
#            (int16 storage already quantises to 0.5 m)
```

---

## 6. Provenance flags (per vertex)

> **Bit numbers here are superseded by the single registry in `provenance/PSEUDOCODE.md` §1.** Names are unchanged; import constants from `provenance/flags.ts`.

```
bit 0  DATA_SURFACE    always set: base surface comes from the DEM
bit 1  GENERATED_RELIEF  |detail − correction| > 2 m
bit 2  GENERATED_COAST   sign(H) != sign(base)   # land/sea flipped by detail

reliefStrength = clamp(|detail − correction| / amplitude_local, 0, 1)
                 # stored separately; the overlay shades by it
```

The overlay draws `data` colour where relief strength is near zero, fading to `generated` colour as it rises, with generated coastline outlined. Info cards on terrain report: source cell value, local H, and the generated share.

---

## 7. Assemble the tile

```
generateTile(req):
    id      = tileIdFor(req.lat, req.lon)
    centre  = tileCentre(id)
    region  = await data.loadChunksCovering(centre, radius = 3 cells)
    corr    = solveCorrection(cellsAround(centre))

    for each vertex (incl. border):
        H, flags, class, weights = evaluate(lat, lon)

    normals  = centralDifferences(heights incl. border)
    seaMask  = heights < 0
    coarseCoastDistKm = distance transform on the 0.1° land/sea grid of `region`,
                        sampled at each vertex   # coast may lie outside the tile
    chunks   = split into 8x8 chunks of 65x65 vertices (shared edges)
    return Tile (buffers transferred, not copied, to the main thread)
```

Budget: about 270k vertices × ~20 noise calls ≈ 5M calls, targeting under 1.5 s per tile on a mid-range desktop. Show a loading state; prefetch the four neighbours in the background.

Cache: LRU of 9 tiles (current + ring).

---

## 8. Render chunks and LOD (hand-off to `render/`)

```
for each of 64 chunks:
    LOD levels: vertex step 1, 2, 4, 8
    choose by camera distance to the chunk's bounding box
    add skirts (vertical strips dropping 20 m below the edge) to every chunk
```

Skirts hide cracks both between LOD levels and between N/S neighbour tiles, whose edge vertices don't line up exactly because tile widths differ by row. The heights still agree because H is one function, so cracks are tiny and skirts cover them.

---

## 9. Tests

```
# INVARIANT: determinism: generateTile twice → identical buffers
# INVARIANT: E/W seam: shared edge vertices of neighbours are identical
# INVARIANT: N/S seam: max height gap along the edge < 0.5 m
# INVARIANT: mean preservation per cell (§5)
# INVARIANT: land/sea agreement: in each fully-covered cell, the majority of
#            vertices share the sign of the source value (except |source| < 30 m)
# INVARIANT: antimeridian: tiles either side of lon ±180 match at the seam
# INVARIANT: no NaN/Infinity in heights or normals
# BENCHMARK: tile generation time, logged per run
```

---

## Amendment to DESIGN.md

- **A9 (Determinism):** the noise seed is **global per slice** (`hash(sliceAge)`), not per tile. Per-tile seeds would make neighbouring tiles disagree at their edges. Tile identity comes from the fixed tile grid (§1). Vegetation and fauna scatter use world-anchored seeds for the same reason (ecology §4).
