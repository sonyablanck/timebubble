# biome/ module pseudocode — Time Bubble

Implements DESIGN.md §8 (biome half). Runs in the terrain worker, straight after `generateTile`. All outputs are tagged `inferred`.

Conventions as in `pipeline/PSEUDOCODE.md`: `# INVARIANT:` lines become tests, `# CHECK:` lines are facts to verify first. Every numeric threshold here is a starting value to tune.

> **Status: coded** (`src/biome/`, see its README) and checked on the real data, including Aftermath mode (Impact Winter with a year slider, and Fern Spike, chosen on the globe's 65 Ma slice). Since then: the §5 data path (nearby PBDB plant occurrences, blended with the prior where evidence is thin) and the §2a Judd et al. (2024) global-mean line on terrain cards (from `climate_by_age.json`) are done. Not yet: the §9 snapshot tiles (reference images for regression checks). Amendments from coding are at the end.

---

## 0. Interfaces

```ts
interface BiomeInput {
  tile: Tile                         // from terrain/
  slice: SliceHandle                 // age, aftermathMode, temperature, precipitation, ecology
}

interface BiomeField {
  weights: Float32Array              // n*n*B soft biome weights, sum 1
  dominant: Uint8Array               // n*n argmax, for textures and debugging
  moisture: Float32Array             // n*n, 0..1
  temperatureC: Float32Array         // n*n, mean annual
  vegDensity: Float32Array           // n*n, 0..1, for scatter
  plantMix: PlantMix                 // per tile: plant body-plan proportions
  provenance: Uint8Array             // n*n flags, see §7
}

PlantMix = Map<PlantBodyPlan, { weight: number, source: "data" | "inferred" }>
```

---

## 1. Biome set (v1)

```
OPEN_OCEAN, SHELF_SEA, BEACH, COASTAL_SWAMP,
FLOODPLAIN_FOREST, WARM_HUMID_FOREST, SEASONAL_WOODLAND,
FERN_OPENLAND,            # Mesozoic analogue of savanna, with no grass
ARID_SCRUB, DESERT,
POLAR_FOREST,             # deciduous conifer/ginkgo forest, light-seasonal
MONTANE_FOREST, BARE_HIGHLAND,
HIGHLAND_ICE,             # only in cool intervals where ice is plausible (§4)
AFTERMATH_FERN_FIELD, AFTERMATH_DEAD_FOREST,  # 65 Ma Aftermath mode only
IMPACT_WINTER_FROST                           # 65 Ma Impact Winter phase only
```

---

## 2. Temperature

Temperature comes from **gridded reconstructions**, not a hand-built zonal formula. The source is Scotese et al.'s 1° mean annual surface temperature fields (HadCM3L climate-model runs adjusted to δ18O proxies and lithological climate indicators; Scotese et al., 2021; Valdes, Scotese and Lunt, 2021). The pipeline maps them to our slices (pipeline §1c).

```
T_grid  = bilinear(slice.temperature(), lat, lon)          # °C, 1° grid
E_grid  = bilinear(slice.globe(), lat, lon)                # the 1° elevation the
                                                           # grid cell "sees"
LAPSE   = 6.0 °C per km
temperatureC = T_grid − LAPSE * (max(H, 0) − max(E_grid, 0)) / 1000
               # correct only for the difference between local terrain and the
               # coarse elevation, so we don't double-count the model's own orography
```

Provenance: `inferred` (model + proxy), never `data`. The info card names the source and shows the alternative estimate (§2a).

### 2a. Uncertainty between reconstructions

Published reconstructions disagree, most of all in hothouse intervals:

- Scotese et al. (2021) put the Cenomanian–Turonian tropics at ~34 °C and the poles at ~13 °C.
- Judd et al. (2024), using proxy data assimilation, find a Turonian global mean of ~36 °C with tropical SSTs of ~40 °C, and greenhouse tropical–polar gradients of 14–27 °C.
- Belemnite-based δ18O temperatures, which feed several Jurassic–Cretaceous compilations, may be too cold by ~11–12 °C (Vickers et al., 2021).

So the warmer end is plausible, and Time Bubble should show the spread rather than hide it:

```
info card:  "Mean annual temperature ≈ {T} °C (Scotese et al. 2021 grid).
             Data-assimilation estimates for this interval run {ΔGMST} °C warmer
             globally (Judd et al. 2024)."
ΔGMST       = climate_by_age[age].gmst_judd − climate_by_age[age].gmst_scotese
```

A temperature-scenario toggle (Scotese / Judd) is deferred to v2. It would need a latitude-dependent offset, not a flat shift.

### 2b. Thermal stress (Early Triassic)

Equatorial temperatures after the end-Permian extinction were high enough to exclude much marine and terrestrial life at low latitudes (Sun et al., 2012). Scotese et al. (2021) put tropical temperatures at ~39 °C at the Permo-Triassic boundary.

```
heatStress = ramp(temperatureC, 35 → 40)                   # 0..1
vegDensity *= (1 − 0.8 * heatStress)
ecology fauna density *= (1 − 0.9 * heatStress)            # passed on to ecology/
flag provenance bit THERMAL_EXCLUSION where heatStress > 0.5
```

The emergent "equatorial dead zone" in the 250 Ma slice is then grounded in literature, and the info card cites it.

---

## 3. Moisture

Moisture comes from the **precipitation grids** (pipeline §1c): mean annual total precipitation from the HadCM3L runs of Valdes, Scotese and Lunt (2021). It is turned into an aridity ratio with the Köppen–Geiger dryness threshold (Peel, Finlayson and McMahon, 2007), which also uses temperature, so a hot place needs more rain to count as wet.

```
P_day    = bilinear(slice.precipitation(), lat, lon)       # mm/day, 1° grid
MAP      = 365.25 * P_day                                   # mm/year
P_thresh = 20 * max(temperatureC, 0) + 140                  # mm/year; Köppen B threshold
                                                            # with no seasonal bias
                                                            # (Peel et al. 2007: MAP < 10 × Pthreshold,
                                                            #  Pthreshold = 2 × MAT + 14)
aridity  = MAP / P_thresh          # < 0.5 desert (BW), 0.5–1 steppe (BS), > 1 humid
base     = aridity / (1 + aridity) # 0..1: 0.33 at the desert edge, 0.5 at the steppe edge

# Local topography only nudges moisture (tile-independent, so seams match)
lowness  = clamp((Hsmooth − H) / 20 m, −1, 1)    # Hsmooth = base + correction (no detail)
near_sea = exp(−coarseCoastDistKm / 5)

moisture = clamp(base + 0.08 * max(lowness, 0) + 0.04 * near_sea, 0, 1)
```

`temperatureC` is the lapse-corrected value from §2, so cold highlands come out wetter than the warm lowland around them, as they would.

Caveats, shown on the info card:
- The 65 Ma slice's temperature comes from the 60 Ma grid (pipeline §1c override); its info card says so via CLIMATE_AGE_MISMATCH.
- The precipitation is raw climate-model output, not proxy-adjusted, and has no seasons in v1. A strongly seasonal climate (e.g. the Pangaean megamonsoon, Parrish 1993) is represented only by its annual total.
- The model ran on the palaeogeography of Valdes et al. (2021), not the 2024 DEMs. Near coasts the two disagree slightly, so bilinear sampling can pick up a sea-cell value; the coastal terms above keep this small.

```
# INVARIANT: moisture and temperature are identical on shared tile edges
# INVARIANT: moisture is monotonic in precipitation at fixed temperature
```

---

## 4. Biome classification (soft)

```
for each vertex:
    if seaMask:
        depth = −H
        w[OPEN_OCEAN] = ramp(depth, 150 → 300)
        w[SHELF_SEA]  = 1 − w[OPEN_OCEAN]
        continue

    # Land: score every land biome with smooth membership functions
    score[BEACH]             = bump(H, 0 … 3) * (1 − ramp(slope)) * near_sea
    score[COASTAL_SWAMP]     = bump(H, 0 … 10) * ramp(moisture, 0.6 → 0.8) * near_sea
    score[FLOODPLAIN_FOREST] = ramp(lowness) * ramp(moisture, 0.5 → 0.7)
    score[WARM_HUMID_FOREST] = ramp(T, 18 → 22) * ramp(moisture, 0.6 → 0.75)
    score[SEASONAL_WOODLAND] = ramp(T, 12 → 18) * bump(moisture, 0.4 … 0.65)
    score[FERN_OPENLAND]     = bump(moisture, 0.3 … 0.5)
    score[ARID_SCRUB]        = bump(moisture, 0.15 … 0.35)
    score[DESERT]            = 1 − ramp(moisture, 0.1 → 0.2)
    score[POLAR_FOREST]      = ramp(|lat|, 55 → 65) * ramp(moisture, 0.3 → 0.5)
    score[MONTANE_FOREST]    = ramp(H, 1200 → 1800) * (1 − ramp(H, 2800 → 3400))
    score[BARE_HIGHLAND]     = ramp(H, 2800 → 3400) + ramp(slope, very steep)

    w = softmax(score / τ)                     # τ ≈ 0.15: blended edges, no hard lines
```

**Ice:** permanent polar ice needs a global mean below roughly 18 °C and cannot form above about 20 °C (Scotese et al., 2021). For most of the Mesozoic, the poles were ice-free. Scotese et al. (2021) allow possible brief ice in two cool intervals: the Callovian (166–164 Ma) and the Tithonian to early Barremian (~150–128 Ma). So:

```
score[HIGHLAND_ICE] = climate_by_age[age].ice_possible
                      * ramp(−temperatureC, 2 → 8)     # MAT below about −2 to −8 °C
                      # tagged `inferred` plus provenance bit ICE_CONTESTED
```

At 165 and 130–150 Ma this can produce small ice caps on high polar ground; everywhere else it stays zero. Even far north, cold winters didn't mean ice sheets. At ~82°N, the Late Cretaceous Prince Creek Formation had a mean annual temperature of 6.3 ± 2.2 °C, cold-month means around −2 °C and occasional snow (Druckenmiller et al., 2021). That is polar forest, not ice.

---

## 5. Plant mix (data-led where possible)

```
plants = slice.ecology().plantsNear(centre, radiusKm = 500)

# Data path: occurrences weighted by distance and age fit
for o in plants:
    mix[o.body_plan].weight += o.age_fit * exp(−o.distanceKm / 250)
    mix[o.body_plan].source  = "data"

# Prior path: fill gaps from an age-aware prior (when data are thin)
if sum(mix.weights) < MIN_EVIDENCE:
    prior = plantPrior(age, dominant biome of tile)
    blend mix toward prior; borrowed entries tagged "inferred"

# Hard age constraints (DESIGN §8), applied last, whatever the data say:
if age > 130: mix[early_angiosperm] = 0
angiosperm ceiling by age: ramp from 0 at 130 Ma to dominant only after ~90 Ma
# no grass body plan exists in v1 at all

normalise mix
```

A plant occurrence that breaks an age constraint (e.g. a misdated angiosperm) is dropped and logged as a data-quality note rather than silently rendered.

---

## 6. Vegetation density

```
vegDensity = moisture_curve(moisture) * temp_curve(T) * (1 − ramp(slope, steep))
by biome multipliers: DESERT 0.02, ARID_SCRUB 0.2, FERN_OPENLAND 0.5 (low-growing),
                      forests 0.8–1.0, BARE_HIGHLAND 0.05
```

`ecology/` turns `vegDensity` + `plantMix` into actual plant placement, using world-anchored scatter seeds (ecology §4).

---

## 7. Aftermath mode (65 Ma only)

The literature describes two phases with very different timescales, so Aftermath has two:

| Phase | Time after impact | Evidence | What the player sees |
|---|---|---|---|
| **Impact Winter** | ~0–30 years | Climate models with impact sulfate aerosols: global surface air cooling of at least 26 °C, annual means below freezing for ~3 years, tropical annual means falling from ~27 °C to ~5 °C, recovery in ~30 years (Brugger, Feulner and Petri, 2017). Proxy evidence of rapid short-term cooling (Vellekoop et al., 2014) | Dark, overcast sky; frost and snow even in the tropics; standing dead forest; no ferns yet |
| **Fern Spike** | ~1–20 thousand years | Palynology shows a sudden land-plant die-off followed by fern dominance lasting roughly 8,000–20,000 years (Vajda et al., 2004) | Fern fields, decaying snags, a normal but cooler sky |

```
if slice.aftermathMode and toggle == IMPACT_WINTER:
    phaseYear = user slider 0..30                  # default 2
    cooling   = coolingCurve(phaseYear)            # 26 °C at peak (years 1–3),
                                                   # easing to 0 by year 30
    temperatureC -= cooling * latitudeWeight(lat)  # CHECK: Brugger et al. give
                                                   # spatial patterns; start uniform
    for land vertices:
        w[AFTERMATH_DEAD_FOREST] = forestShare
        w[IMPACT_WINTER_FROST]   = ramp(−temperatureC, 0 → 5) * (1 − forestShare)
        renormalise
    plantMix  = {} (living plants absent); vegDensity = deadSnagDensity only
    sky: dark, low sun, `generated`

if slice.aftermathMode and toggle == FERN_SPIKE:
    for land vertices:
        w[AFTERMATH_FERN_FIELD]  = 0.7 * (1 − forestShare)
        w[AFTERMATH_DEAD_FOREST] = forestShare
        renormalise
    plantMix = { fern: 0.85, horsetail: 0.1, pioneer_other: 0.05 }, all "inferred"
    vegDensity *= 0.6
    temperatureC: grid value (the slice uses the 60 Ma Palaeocene grid, pipeline
                  §1c override; Vajda et al. 2004 report a cooler early Palaeocene,
                  which a −2 °C offset could represent; CHECK the magnitude first)
```

Both phases set the provenance bit `AFTERMATH_RECON`; info cards cite the sources above.

---

## 8. Provenance

> **Bit numbers here are superseded by the single registry in `provenance/PSEUDOCODE.md` §1.** Names are unchanged; import constants from `provenance/flags.ts`.

```
bit 0  BIOME_INFERRED         always set on biome outputs
bit 1  PLANTS_FROM_DATA       plantMix majority came from nearby occurrences
bit 2  PLANTS_FROM_PRIOR      prior contributed more than half
bit 3  AFTERMATH_RECON        Aftermath override active
bit 4  THERMAL_EXCLUSION      heat stress above threshold (§2b)
bit 5  ICE_CONTESTED          ice shown in an interval where it is debated (§4)
```

Info cards on ground and vegetation show: biome name, temperature and moisture estimates with "(model)" labels, and the plant evidence (count of nearby occurrences, nearest distance).

---

## 9. Tests

```
# INVARIANT: weights sum to 1 (±1e-5) at every vertex
# INVARIANT: no early_angiosperm weight in any slice older than 130 Ma
# INVARIANT: no land biome on sea vertices, and vice versa
# INVARIANT: seam continuity of moisture, temperature and weights
# INVARIANT: deterministic: same tile → identical BiomeField
# INVARIANT: HIGHLAND_ICE weight is zero in every slice where ice_possible is false
# BENCHMARK: share of land vertices with aridity < 1 per slice, reported against the
#            Köppen B-zone extent in Scotese et al. (2021); report, do not fail
# SNAPSHOT: a fixed set of reference tiles (e.g. Hell Creek at 65/70 Ma, Morrison
#           at 150 Ma, central Pangaea at 230 Ma) produce the expected dominant biome

# LITERATURE BENCHMARKS (report, do not fail; values are proxy or model targets)
#   250 Ma  equatorial land/sea: T ≥ 35 °C, heat stress active   (Sun et al. 2012;
#           Scotese et al. 2021: tropics ~39 °C at ~252 Ma)
#   95/90 Ma tropics ~34 °C, poles ~13 °C, no ice                (Scotese et al. 2021)
#           note the gap to Judd et al. 2024 (tropics ~40 °C)
#   70 Ma   Prince Creek, ~82°N: MAT 6.3 ± 2.2 °C               (Druckenmiller et al. 2021)
#   165 Ma  mid-latitude Tethyan seaway (Christian Malford, UK): SST 20–29.5 °C
#                                                                (Vickers et al. 2021)
#   65 Ma   Impact Winter year 2: tropical land MAT ≈ 5 °C       (Brugger et al. 2017)
#   Cretaceous low-to-mid-latitude SST gradient: ~10–17 °C Valanginian, ~3–5 °C
#           Aptian, < 14 °C Cenomanian–Santonian, ~19–21 °C Campanian–Maastrichtian
#                                                                (O'Brien et al. 2017)
```

---

## Dependencies added to the pipeline

- `ingest_climate.py` (pipeline §1c): the 1° temperature and precipitation grids mapped to our slices, as `globe/{age}.temp.i16.gz` and `globe/{age}.precip.i16.gz`.
- `continentality.py` (pipeline §1b) is no longer used by biome: interior dryness now comes from the precipitation grids. The globe's hover readout still shows it.
- `climate_by_age.json` (pipeline §1d): hand-curated per-slice parameters (ice flag, alternative global mean, aftermath constants), each with a cited source. Full references are in `REFERENCES.md`.

---

## Amendments from coding (2026-11-01)

- **§4 softmax gated:** a plain softmax spreads weight onto every biome when no score is high (it put "beach" at 375 m). Each biome's share is now multiplied by `ramp(score, 0, 0.05)`, so biomes whose rules don't apply get nothing; if none apply, the vertex is fern openland. Ice is a hard exclusion where it isn't possible.
- **§4 thresholds tuned:** seasonal woodland from 6–12 °C (not 12–18 °C), with moisture 0.45–0.6, so cool humid mid-latitudes aren't fern openland; montane forest needs moisture ≥ 0.4–0.55; heat stress adds to the desert score (Early Triassic tropics).
- **§7 Impact Winter:** which forests died is decided on the **pre-impact** climate; frost covers non-forest ground as annual means fall from 8 °C to 0 °C; the rest is a new **bare ground (aftermath)** biome (18 biomes in all). The sky becomes a grey-brown overcast, sunlight scales with the cooling curve (render §6).
- **§7 Fern Spike:** ferns carpet the ground, including under former forest; 30% of former forest remains as standing dead snags.
- **§3 coast term:** distance to the nearest 0.1° sea node, from the DEM window terrain already holds, sampled on a 17 × 17 lattice per tile. The 1° climate fields are sampled on the same lattice.
- **§5 provisional (superseded 2026-11-02):** before `climate_by_age.json` and the fossil steps existed, ice flags lived only in `climate.ts` and the plant mix was the prior alone. Now the ice flag is read from `climate_by_age.json` (`climate.ts` keeps the same list as a fallback) and the mix uses nearby plant occurrences, as in §5.
