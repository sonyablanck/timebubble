# render/ module pseudocode — Time Bubble

Draws walk mode: terrain, water, plants, animals, sky, and the provenance overlay hooks. Owns the camera, tile streaming around the player, picking, quality presets and photo mode. (The globe draws itself; see `globe/`.)

Conventions as in `pipeline/PSEUDOCODE.md`: `# INVARIANT:` lines become tests, `# CHECK:` lines are facts to verify first.

---

## 0. Interface

```ts
interface WalkRenderer {
  enter(req: TileRequest, slice: SliceHandle): Promise<void>  // from globe/
  exit(): void                                                // back to globe
  setQuality(preset: "low" | "medium" | "high"): void
  setAtmosphere(mode: Atmosphere): void                       // §6
  setTimeOfDay(hours: number): void
  pick(screenX, screenY): PickResult | null                   // → provenance.cardFor
  photoMode(on: boolean): void                                // §9
  onPlayerMoved(cb: (state: PlayerState) => void): void       // ui/ compass, URL
}

type Atmosphere = "normal" | "impactWinter" | "fernSpike" | "heatHaze"
```

Renderer setup: Three.js `WebGLRenderer` (WebGL2), sRGB output, ACES filmic tone mapping, antialias on medium/high.

---

## 1. Floating origin and tile streaming

Float32 GPU positions lose precision far from the origin, so the scene origin is always the **current tile's centre**:

```
worldOrigin = tileCentre(currentTile)        # palaeo lat/lon, float64 on the CPU
all tile meshes positioned relative to worldOrigin in local ENU metres

when the player crosses into a neighbouring tile:
    newOrigin = tileCentre(newTile)
    offset    = ENU(newOrigin) − ENU(worldOrigin)  # float64
    shift every scene object, the camera and animal states by −offset
    worldOrigin = newOrigin
```

Streaming keeps a 3 × 3 ring of tiles (terrain/ already caches nine):

```
on tile change:
    request missing ring tiles from the terrain worker (terrain → biome → ecology)
    dispose tiles outside the ring (geometry, instance buffers, animals)
player can walk indefinitely; a tile still generating shows its far-ring terrain (§5)
until it is ready, and animals pop in with a 0.5 s fade
```

```
# INVARIANT: after 50 km of walking in any direction, the camera's jitter stays
#            below 1 mm (float32 positions stay small)
# INVARIANT: crossing a tile edge produces no visible jump (positions continuous
#            to < 1 cm before and after rebasing)
```

---

## 2. Camera and movement

```
first-person walk (default):
    eye height 1.7 m; walk 1.4 m/s; run (Shift) 4 m/s
    WASD + mouse look (pointer lock); Space = small hop for uneven ground
    ground clamp: y = heightAt(x, z) + eyeHeight, sampled from the tile heightfield
                  with bilinear interpolation
    slope limit: cannot walk up slopes > 40°; slides gently instead
    water: stops at the shoreline (no swimming in v1); camera never goes below sea level

free flight (F to toggle):
    no gravity, 5–60 m/s with the scroll wheel, minimum 2 m above ground
    lets players survey a landscape from above; flight is clearly flagged in the HUD

collisions with animals and trees: none in v1 (pass through); animals step aside via
their separation rule (ecology §6) when the player is within 3 m
```

```
# INVARIANT: the camera never ends a frame below terrain or below sea level in walk mode
```

---

## 3. Terrain

```
for each loaded tile and each of its 64 chunks:
    pick LOD (vertex step 1/2/4/8) by camera distance; skirts from terrain/ hide cracks
    geometry attributes: position, normal, biomeIds (top 4), biomeWeights (top 4),
                         provLevel (float), provFlags (u32)

terrain material (stylised low-poly, A10):
    base colour = Σ_k biomeWeights[k] * BIOME_PALETTE[biomeIds[k]]
    + slope term: rock colour blends in above ~35°
    + small-scale colour noise in world space (breaks tiling, seamless across tiles)
    flat shading on low, smooth with subtle facets on medium/high
    provenance hook: if u_overlayOn, mix in the level colour + pattern
                     (provenance §3b); focus mode uses u_focusMask
```

Biome palettes are muted and earthy, with distinct hues for the aftermath biomes (ash-grey frost, rust-brown dead forest, vivid fern green).

---

## 4. Water

```
sea: one plane at 0 m per tile, extended to the far ring
material: stylised water: depth-tinted colour from the heightfield under it
          (shallow turquoise → deep blue), gentle normal-map waves,
          shoreline foam where depth < 0.5 m
Impact Winter: sea colour greyer; ice rims where temperatureC < −2 °C near shore
```

No rivers or lakes in v1 (DESIGN A11).

---

## 5. Far terrain ring (data on the horizon)

Beyond the 3 × 3 tiles, the horizon is drawn straight from the **0.1° DEM**, with no generated detail, so distant mountains are data, not invention:

```
far mesh: a polar grid centred on the player, radius 60 km, ~40k triangles,
          heights = base(lat, lon) + correction (no detail noise)
          apply Earth curvature: y −= d² / (2R)
          colour from biome weights computed at coarse resolution
          rebuilt when the player moves > 2 km
inner edge hidden under the near tiles; fog fades it into the sky
provenance: tagged DATA_SURFACE only
```

---

## 6. Sky, light and atmosphere

All of this is `generated` (SKY_GENERATED) and says so in the legend.

```
sun direction: from the tile's palaeolatitude and time of day (equinox, no seasons
               in v1; DESIGN §9). Polar tiles therefore get a low sun, which suits
               the high-latitude forests.
sky: analytic gradient sky (Preetham-style), sun disc, simple cloud layer
fog: exponential, distance tuned per preset (low 4 km, high 12 km)
shadows: cascaded shadow map, 2 cascades (medium) / 3 (high); off on low
```

Atmosphere presets, chosen automatically from the slice and biome, overridable in settings:

| Preset | When | Look |
|---|---|---|
| normal | default | clear to hazy by moisture |
| heatHaze | biome heatStress > 0.5 (Early Triassic tropics) | bleached light, heat shimmer near the ground, dusty fog |
| impactWinter | Aftermath → Impact Winter | very low light, grey-brown overcast, falling snow and ash particles scaled by the year slider, frosted ground |
| fernSpike | Aftermath → Fern Spike | slightly cool, softer light, normal sky |

```
impactWinter light curve: sunlight × lightFactor(year), darkest in years 0–2,
                          recovering by ~year 30 (follows biome §7 cooling curve)
# CHECK: sunlight reduction over time from Brugger et al. (2017) before tuning
```

---

## 7. Plants

```
for each PlantBatch (ecology/):
    InstancedMesh per (body plan, variant, LOD)
    LOD 0: low-poly mesh, 0–80 m
    LOD 1: simplified mesh, 80–300 m
    LOD 2: impostor (camera-facing card, pre-rendered from 8 angles), 300–1500 m
    beyond 1500 m: dropped; the terrain colour carries the biome
vertex shader: wind sway (by height on the plant, world-space noise so it's
               seamless), none for dead snags
colour: palette per body plan, varied by colourSeed (always generated)
```

Body-plan models (v1): conifer (tall, columnar), conifer (spreading), cycad, bennettitalean, ginkgo, tree fern, ground fern, horsetail stand, seed fern, early angiosperm shrub, dead snag (two decay stages).

---

## 8. Animals

```
one rigged, low-poly model per animal body plan (≈ 15 models), shared skeleton
per plan; size by uniform scale from lengthM; proportions varied ±10% by seed
animation clips: idle, walk, run, graze, drink, rest, plus fly/glide (pterosaur,
                 bird) and swim (marine reptile, fish, crocodylomorph)
colour: shader parameters from colourSeed: base hue, countershading, simple
        stripes or blotches; always generated; muted natural ranges
integument: feathers / filaments / scales per clade rule table, tagged inferred
            # CHECK: build the clade table from published integument reviews
            #        when modelling; add citations to REFERENCES.md
LOD: full skinning < 60 m; reduced bone updates (every 2nd frame) to 200 m;
     baked impostor animation beyond 200 m
```

---

## 9. Picking and photo mode

```
pick(screenX, screenY):
    ray from the camera
    test animals (bounding capsules), then plants (bounding spheres per instance,
    via a coarse spatial hash), then terrain (heightfield ray march), then sky
    return nearest { kind, id, vertexOrInstance, worldPos }   # → provenance.cardFor

photoMode(on):
    hide the HUD; free camera (no gravity), depth-of-field and exposure sliders
    optional caption strip: slice, palaeo-coordinates and the "cite this view"
    string (provenance §5); optional provenance overlay in the photo
    save PNG at screen or 2× resolution
```

Photo mode serves both audiences: world-building players share screenshots, and researchers get figures with the citation built in.

---

## 10. Quality presets and budgets

| | low | medium | high |
|---|---|---|---|
| Plant density | 40% | 70% | 100% |
| Plant LOD 0 distance | 40 m | 80 m | 120 m |
| Shadows | off | 2 cascades | 3 cascades |
| Fog / view distance | 4 km | 8 km | 12 km |
| Far ring | 30 km | 60 km | 60 km |
| Target | 60 fps, integrated GPU | 60 fps, mid-range GPU | 60 fps, recent discrete GPU |

Auto-select on first run from a 2 s benchmark; adjustable in settings. Draw calls under ~300 on medium.

---

## 11. Tests

```
# INVARIANT: floating-origin precision (§1)
# INVARIANT: seamless tile crossing (§1)
# INVARIANT: camera never below terrain or sea level in walk mode (§2)
# INVARIANT: pick returns the instance actually under the crosshair for a set of
#            scripted test scenes
# INVARIANT: overlay toggling changes uniforms only (no geometry rebuild)
# INVARIANT: photo caption text equals provenance.citeThisView for the same view
# BENCHMARK: frame time per preset on a scripted fly-through; tile streaming time
```
