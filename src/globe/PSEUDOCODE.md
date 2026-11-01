# globe/ module pseudocode — Time Bubble

The entry point: a 3D globe of the chosen slice, a time slider, map layers, and picking a spot to walk. Implements DESIGN.md §6 (globe) and the first step of the flow: choose slice → globe → click → tile.

Conventions as in `pipeline/PSEUDOCODE.md`: `# INVARIANT:` lines become tests, `# CHECK:` lines are facts to verify first.

> **Status: coded** (`src/globe/`, see its README), and checked in a browser against the real data. Settled while coding: the two `# CHECK:` items are resolved (registration is handled by placing each value at its texel centre; `sphereUV` and picking share `geo.ts`: lon 0 at +z, lon 90 at +x); temperature and precipitation share one overlay slot; the sea writes depth so grid lines behind it stay hidden; grid lines also mark the modern tropics; the hover readout adds precipitation. Period boundaries use the ICS chart v2024/12 (Cretaceous base 143.1 Ma).

---

## 0. Interface

```ts
interface Globe {
  mount(canvas: HTMLCanvasElement, store: DataStore): Promise<void>
  setSlice(age: number): Promise<void>           // snaps to nearest slice
  stepSlice(direction: −1 | +1): Promise<void>   // older / younger
  setLayer(layer: GlobeLayer, on: boolean): void
  setExaggeration(x: number): void               // vertical exaggeration, see §2
  onHover(cb: (info: HoverInfo | null) => void): void
  onEnterTile(cb: (req: TileRequest) => void): void   // handed to terrain/
  flyTo(lat: number, lon: number): Promise<void>
}

type GlobeLayer = "relief" | "temperature" | "precipitation" | "fossils" | "graticule" | "provenance"
// temperature and precipitation are mutually exclusive (one 50% blend slot)

interface HoverInfo {
  lat: number; lon: number                       // palaeo-coordinates
  elevationM: number                             // 1° DEM value (data)
  isLand: boolean
  temperatureC: number                           // 1° grid (inferred)
  precipitationMmYr: number                      // 1° grid (mm/day) × 365.25 (inferred, model)
  coastDistKm: number                            // continentality grid
  occurrencesInBin: number; topTaxa: string[]    // ecology index
}
```

---

## 1. Data to GPU

```
onSliceLoaded(handle):
    elev = await handle.globe()           # Int16Array 360×181, metres
    temp = await handle.temperature()     # Int16Array 360×181, 0.01 °C
    prec = await handle.precipitation()   # Int16Array 360×181, 0.01 mm/day
    eco  = await handle.ecology()         # binned occurrences

    elevTex = DataTexture(Float16 R, 360×181, from elev)
              # half-float: linear filtering is guaranteed in WebGL2;
              # precision ≈ 8 m at 10 km depth, ample for a globe
    tempTex = DataTexture(Float16 R, 360×181, from temp / 100)
    precTex = DataTexture(Float16 R, 360×181, from prec / 100 * 365.25)   # mm/year
    wrapS = Repeat (lon wraps), wrapT = Clamp (poles)

    # CHECK: grid registration from the sidecar; if cell-registered, offset UVs by
    #        half a texel so values sit at cell centres
```

Prefetch the two neighbouring slices in the background so stepping the slider is instant. Keep at most three slices of textures on the GPU.

---

## 2. Sphere and relief

```
mesh: UV sphere, 512 × 256 segments (desktop budget), radius 1
      UV sphere matches the equirectangular textures with no reprojection

vertex shader:
    uv = sphereUV(position)
    h  = texture(elevTex, uv).r                    # metres
    displaced = position * (1 + exaggeration * max(h, SEA_FLOOR_CLAMP) / R_EARTH)
    # ocean floor is drawn under a transparent sea shell, see below

fragment shader:
    normal from central differences of elevTex (hillshade)
    colour = hypsometric(h)                        # see palette
    light  = fixed key light + soft ambient        # no real sun position implied
```

- **Vertical exaggeration:** default ×40, adjustable 1–80. True relief is invisible at globe scale. The value is always shown on screen ("Relief exaggerated ×40") to stay honest.
- **Sea:** a second sphere at sea level, semi-transparent, coloured by depth from `elevTex` so shelves read as pale and abyssal plains as dark.
- **Hypsometric palette:** neutral, not modern-vegetation greens, to avoid implying biomes the globe doesn't compute. For example: lowland sand-grey → upland ochre → highland brown → peaks pale grey. A legend shows the elevation scale.

```
# INVARIANT: the antimeridian shows no seam (texture wraps; shared UV column)
# INVARIANT: the hypsometric legend matches the shader's colour stops
```

---

## 3. Layers

| Layer | Default | Source | Level | Rendering |
|---|---|---|---|---|
| relief | on | 1° PaleoDEM | data | §2 |
| temperature | off | 1° temperature grid | inferred | diverging palette (blue → white → red), 50% blend over relief; legend in °C with source, interval age and mismatch |
| precipitation | off | 1° precipitation grid | inferred | sequential palette (pale → blue-green), 50% blend over relief; legend in mm/year with source, interval age and mismatch |
| fossils | on | ecology index | data | one dot per 5° bin with occurrences, area ∝ √count, colour by dominant group (dinosaurs, marine reptiles, plants, other) |
| graticule | on | — | — | 15° lines, palaeo-latitude labels; the equator and tropics emphasised |
| provenance | off | provenance/ | — | relief = data, temperature and precipitation = inferred, with the provenance palette; mostly for the legend and consistency |

The **fossils** layer doubles as a guide to where walking will be richest: tiles near dots get `data` fauna, while empty regions fall back to inferred taxa.

```
fossil dots:
    for bin in eco.bins:
        position = centroid of the bin's occurrences (not the bin centre)
        hover → tooltip: count, top 5 taxa, age range spread
```

---

## 4. Camera and controls

```
orbit camera around the globe:
    drag: rotate     wheel: zoom (distance 1.3–6 globe radii)
    keys: arrows rotate, +/- zoom, [ and ] step slices (older/younger)
    damping on; north kept up unless the user rolls deliberately (R resets)
idle: very slow auto-rotate after 20 s, stopped by any input
```

---

## 5. Picking

```
pointerMove / click:
    ray = camera ray through the pointer
    hit = intersect(ray, sphere radius 1)            # ignore displacement: at ×40
                                                     # the error is < 0.2°, and the
                                                     # pick snaps to a 4 km tile anyway
    if no hit: hover(null); return
    p = hit.point transformed into the globe's local frame (undo globe rotation)
    lat = deg(asin(p.y)); lon = deg(atan2(p.x, p.z))  # CHECK: match sphereUV convention
    hover(HoverInfo from grids at (lat, lon) and eco.near(lat, lon, bin))

# INVARIANT: pick(project(lat, lon)) == (lat, lon) within 0.05° for a grid of test points
# INVARIANT: picks either side of lon ±180 resolve to the correct side
```

`HoverInfo` drives a small readout in the corner (ui/ renders it): coordinates, elevation, land/sea, temperature and precipitation "(model)", distance to coast and fossil count.

---

## 6. Entering a tile

```
onClick(lat, lon):
    show a pin + "Walk here" panel (ui/), with a preview:
        elevation, temperature, nearest fossils, and a warning if the spot is
        open ocean ("Mostly water: v1 has no underwater view") or above 89.5°
    onConfirm:
        req = { sliceAge, lat: clamp(lat, −89.5, 89.5), lon }
        await flyTo(lat, lon)                          # 1.2 s ease-in towards the surface
        fade to the loading view; emit onEnterTile(req)
        terrain/ generates the tile (progress events → ui/)
```

Returning from a tile flies back out to the same spot and slice.

---

## 7. Changing slices

```
setSlice(age):
    s = store.slice(age)                              # snaps to nearest
    if s.age == current: return
    load s (from prefetch if available)
    crossfade textures over 400 ms                    # a visual transition only:
                                                      # never shown as an intermediate
                                                      # state (DESIGN A6), so the
                                                      # readout and picking switch at once
    keep the camera's palaeo lat/lon fixed            # the continents move under you
    update URL (provenance.viewToUrl)
    prefetch neighbours
```

Keeping the camera fixed in palaeo-coordinates means continents visibly drift as you scrub the slider. That is the globe's main "wow" moment, and an honest one: it is the plate model, not an animation.

---

## 8. Time slider (logic here, drawing in ui/)

```
ticks: one per slice, 250 → 65 Ma
bands: Triassic (252–201.4), Jurassic (201.4–143.1), Cretaceous (143.1–66),
       Palaeogene (66–) drawn as a distinct "after the extinction" band
       # CHECK: boundary ages against the current ICS International Chronostratigraphic
       #        Chart when coding (the Jurassic–Cretaceous boundary is still debated)
labels: period names; the hovered tick shows "150 Ma · Late Jurassic"
65 Ma tick: marked with the extinction symbol and an "Aftermath" toggle (biome §7)
drag snaps to ticks; keyboard [ and ] step
```

---

## 9. Performance budget

- Globe draw: two sphere meshes (≈ 265k triangles), one pass, target 60 fps on integrated desktop GPUs.
- Slice switch: under 150 ms when prefetched; under 1 s when cold.
- Fossil dots: instanced, one draw call.

---

## 10. Tests

```
# INVARIANT: setSlice snaps to the nearest available age; stepSlice never overshoots
# INVARIANT: texture orientation: a synthetic grid with a marker at (30°N, 60°E)
#            renders and picks at (30°N, 60°E)
# INVARIANT: the exaggeration label always matches the uniform in use
# INVARIANT: no intermediate slice is ever reported by hover or the URL during a crossfade
# INVARIANT: URL round trip restores slice, camera and layers
# BENCHMARK: frame time and slice-switch time, logged
```

---

## Deferred (v2)

- **Modern coastlines overlay:** rotate present-day coastlines to each slice with pyGPlates + PALEOMAP in the pipeline, so players can see where today's continents were. This is the cheap first half of "where was my town?" (DESIGN §9).
