# ecology/ module pseudocode — Time Bubble

Implements DESIGN.md §8 (ecology half): which organisms appear on a tile, how many, where, and how they idle. Roster and placement run in the terrain worker after `biome/`; the behaviour loop runs on the main thread each frame.

Conventions as in `pipeline/PSEUDOCODE.md`: `# INVARIANT:` lines become tests, `# CHECK:` lines are facts to verify first. Numeric values are starting points to tune unless cited.

> **Status: coded** (`src/ecology/`, see its README) and run on the real PBDB data, with a field guide panel (G, with Locate) in walk mode. Plants and animals are drawn (render §7–§8). §3 abundance was corrected on 2026-11-02 (per-species density plus a presence estimate; see the amendments). The §1a `CHECK` is resolved (74 PBDB environment strings mapped). Amendments from coding are at the end.

---

## 0. Interfaces

```ts
interface EcologyInput {
  tile: Tile                       // terrain/
  biome: BiomeField                // biome/: weights, vegDensity, plantMix, temperature, flags
  slice: SliceHandle               // data/: age, aftermathMode, ecology index
  settings: { representativeFauna: boolean }   // §4c, default true
}

interface EcologyResult {
  roster: TaxonEntry[]             // every taxon present on this tile, with evidence
  plants: PlantBatch[]             // one instanced batch per (body plan, variant)
  fauna: Animal[]                  // individual animated animals
}

interface TaxonEntry {
  name: string; rank: string       // e.g. "Edmontosaurus", "genus"
  bodyPlan: BodyPlan
  lengthM: number; lengthSource: "rule" | "class default"   // from rules.csv size_hint
  massKg: number                   // §3, always `inferred`
  weight: number                   // evidence weight, §1
  source: "data" | "inferred"
  evidence: {
    occurrenceIds: number[]; refIds: number[]
    nearestKm: number; ageRanges: [number, number][]
    straddlesKpg: boolean; matchedLevel: string            // from the pipeline
  }
}

interface Animal {
  taxon: TaxonEntry
  position: Vec3; heading: number; scale: number
  groupId: number
  behaviour: BehaviourState        // §6
  colourSeed: number               // colour is always `generated`
  flags: ProvenanceBits            // §7
}

interface PlantBatch {
  bodyPlan: PlantBodyPlan; variant: number; alive: boolean   // false = dead snag
  transforms: Float32Array         // per-instance position, rotation, scale
  colourSeeds: Uint32Array
  source: "data" | "inferred"      // from biome.plantMix
}
```

---

## 1. Faunal roster (evidence, not abundance)

```
R_DATA     = 150 km        # occurrences within this distance → `data`
R_INFERRED = 750 km        # further out, up to this distance → `inferred`
KERNEL_KM  = 250

occ = slice.ecology().near(tile.centre, R_INFERRED)
occ = occ where body_plan is an animal body plan

for o in occ:
    envW = environmentMatch(o.env, tileHabitats)                  # §1a
    w    = o.age_fit * exp(−o.distanceKm / KERNEL_KM) * envW
    if w < 1e-3: skip
    entry = roster[genusOrBest(o)]        # collapse to genus; keep species names
    entry.weight += w
    entry.evidence += o
    entry.source = "data" if any o in entry with distanceKm <= R_DATA
                          and not o.straddles_kpg
                   else "inferred"

roster = top N_MAX taxa by weight (N_MAX = 40), always keeping every `data` taxon
```

Fossil occurrences say a taxon was **there**, not how **common** it was. Preservation favours large bodies and animals living near water, so evidence weight is used only to decide presence. Abundance comes from body size (§3).

### 1a. Environment matching

```
# CHECK: the exact PBDB environment vocabulary (e.g. via the API's environment
#        list). Map by keyword and log any unmapped strings for review.
envClass(o.env) ->
    TERRESTRIAL   : "terrestrial", "fluvial", "lacustrine", "eolian", "cave", "paleosol", ...
    MARGINAL      : "coastal", "deltaic", "estuar", "lagoon", "tidal", "marginal marine", ...
    SHALLOW_MARINE: "shallow subtidal", "shoreface", "carbonate platform", "reef", ...
    DEEP_MARINE   : "offshore", "basinal", "slope", "deep", ...
    UNKNOWN

tileHabitats = share of tile vertices that are land / near coast / shelf sea / open ocean

environmentMatch(env, habitats) =
    TERRESTRIAL    → habitats.land
    MARGINAL       → habitats.nearCoast + 0.5 * habitats.land
    SHALLOW_MARINE → habitats.shelf
    DEEP_MARINE    → habitats.ocean
    UNKNOWN        → 0.5               # neutral; tagged `inferred` regardless
```

Body-plan habitat limits override the environment match: marine reptiles never appear on land-only tiles, and sauropods never in open-ocean tiles.

---

## 2. Habitat preferences by body plan

| Body plan | Habitat | Group size | Notes |
|---|---|---|---|
| sauropod / prosauropod | open woodland, floodplain | 1–8 | avoids slopes > 15° |
| ornithopod | floodplain, coastal, woodland | 3–20 | herds |
| ceratopsian | open land, floodplain | 1–10 | |
| ankylosaur / stegosaur | woodland, open land | 1–3 | |
| large theropod | any land | 1–2 | |
| small theropod | any land, forest edge | 1–6 | |
| pterosaur | coast, water, open sky | 1–12 | flies or stands on shore |
| crocodylomorph | water edge, swamp | 1–4 | |
| turtle | water edge, shallow water | 1–5 | |
| small tetrapod (incl. mammals) | forest floor, scrub | 1–3 | |
| marine reptile, fish | sea, near the surface | 1–10 | v1 has no underwater camera |

```
habitatScore(animalPlan, vertex) = Σ_biome biome.weights[vertex][b] * PREF[animalPlan][b]
                                   * slopeOk * waterRule
```

---

## 3. Abundance: Damuth's law

Population density in living animals scales with body mass roughly as `D ∝ M^−0.75` (Damuth, 1981). Marshall et al. (2021) applied this to *Tyrannosaurus rex*, estimating about one adult per 100 km² (95% range spanning more than two orders of magnitude). A 4 × 4 km tile is 16 km², so a realistic tile usually holds **no** large predator at all.

```
massKg(entry) = allometry[bodyPlan](lengthM)       # mass from length per body plan
                # CHECK: source allometric equations per clade; tag `inferred`

densityPerKm2(entry) =
    k[trophic] * massKg^−0.75
    # trophic from body plan: herbivore, carnivore, omnivore/insectivore
    # k calibrated so a ~5,200 kg carnivore gives ~0.01 per km² (Marshall et al. 2021)
    # CHECK: calibrate the herbivore k against Damuth (1981) mammal regressions,
    #        then adjust for endothermy assumptions; record the choice in About

presence(entry) = 1 − exp(−entry.weight / PRESENCE_SCALE)     # PRESENCE_SCALE = 1
                # chance the taxon lived on this spot at this moment, from its evidence
                # (age fit × distance kernel × environment match, summed over occurrences)
                # CHECK: provisional reading of the evidence, not a fitted probability
                # (amended 2026-11-02; this replaced share = weight / Σ trophic weights)

expectedCount = densityPerKm2 * presence * tileAreaKm2 * habitatFraction
                * (1 − 0.9 * heatStress)           # biome §2b, Early Triassic tropics
count = poisson(expectedCount, rng(slice, tile, taxon))
```

### 3a. Representative fauna (default on)

Realistic densities would leave most tiles looking empty of large dinosaurs, which is true but hard to explore. With the setting on, every `data` taxon is guaranteed at least one group:

```
if settings.representativeFauna and entry.source == "data" and count == 0:
    count = minGroupSize(bodyPlan)
    flags |= DENSITY_BOOSTED
```

The info card states plainly that the animal is shown for illustration, next to its density where it lived, its presence here and the expected number on the tile. Turning the setting off gives the realistic picture.

---

## 4. Placement (seamless across tiles)

Scatter is **world-anchored**: candidate points live on a global jittered grid keyed by palaeo-coordinates, and each grid cell has its own seed. Neighbouring tiles therefore agree on what grows near their shared edge, without seam code.

```
SCATTER_SEED(cell, layer) = hash(sliceAge, layer, cell.i, cell.j)

for layer in plantLayers (canopy, understorey, ground):
    spacing = LAYER_SPACING[layer]                 # e.g. 8 m, 3 m, 1 m
    for cell in globalGridCells(tile.bounds, spacing):
        rng = Rng(SCATTER_SEED(cell, layer))
        p   = cell.centre + rng.jitter(0.8 * spacing)
        v   = sample tile fields at p (height, slope, biome weights, vegDensity)
        if seaMask(p) and layer != aquatic: continue
        plan = rng.pick(biome.plantMix filtered to plans allowed in this layer,
                        weighted by suitability[plan](moisture, temperature, slope))
        if rng.next() > v.vegDensity * layerDensity[layer][plan]: continue
        emit instance(plan, p, scale = baseScale[plan] * rng.range(0.7, 1.3),
                      rotation = rng.angle(), colourSeed = rng.u32())
```

Plant suitability (starting rules, all `inferred`):
- ferns, horsetails: favour wet, low ground (biome moisture, lowness)
- conifers: tolerate drier, cooler and steeper ground
- cycads, bennettitaleans: favour warm, seasonally dry ground
- ginkgos: favour mid–high latitudes and floodplains
- early angiosperms: disturbed, wet margins first (riverbanks), widening with age

```
for each taxon in roster with count > 0:
    groups = splitIntoGroups(count, GROUP_SIZE[bodyPlan])
    for g in groups:
        site = pick a world-anchored spawn cell (coarser grid, 200 m)
               maximising habitatScore, seeded by (slice, taxon, cell)
        place members around site with spacing ~ body length
```

Budgets (desktop): ≤ 250k plant instances per tile, with impostors beyond ~300 m; ≤ 80 animated animals per tile. Over budget: thin ground cover first, then distant groups.

---

## 5. Aftermath and post-extinction rules

```
if age < KPG_MA:
    assert no non-avian dinosaur in roster        # the pipeline already removes them

if aftermath == IMPACT_WINTER:
    plants: canopy layer only, alive = false (standing dead trees)
    fauna: rare survivors only: small tetrapods, crocodylomorphs, turtles, birds
           near water; counts × 0.2

if aftermath == FERN_SPIKE:
    plants: dead snags at canopy positions (fewer, decayed)
            + fern/horsetail ground layers from biome.plantMix
    fauna: same survivor plans at × 0.5
```

All Aftermath outputs set `AFTERMATH_RECON`.

---

## 6. Ambient behaviour (main thread, no AI)

A small per-animal state machine, deterministic given its seed and the clock:

```
states: IDLE → WANDER → (GRAZE | DRINK | REST) → IDLE

update(animal, dt):
    switch state:
      IDLE:   play idle; after rng duration pick next state by body-plan weights
      WANDER: walk to a target within the group's home radius (≤ 150 m);
              target must be habitat-valid (not in sea for land animals, slope ok)
      GRAZE:  herbivores only; play feeding near vegetation
      DRINK:  walk to the nearest water edge if within home radius
      REST:   lie or stand still
    groups: members keep within cohesion distance of the group centre
    no predation, no fleeing, no collisions beyond simple separation
```

Fliers (pterosaurs, birds): circle above the coast or forest on smooth loops and occasionally land at the shore. Swimmers: drift near the surface along the coast.

---

## 7. Provenance

> **Bit numbers here are superseded by the single registry in `provenance/PSEUDOCODE.md` §1.** Names are unchanged; import constants from `provenance/flags.ts`.

```
bit 0  TAXON_FROM_DATA     occurrence within R_DATA, not straddling K–Pg
bit 1  TAXON_INFERRED      borrowed from R_DATA..R_INFERRED, or straddling K–Pg
bit 2  SIZE_FROM_RULE      size from rules.csv (else class default)
bit 3  DENSITY_BOOSTED     representative fauna override (§3a)
bit 4  AFTERMATH_RECON
bit 5  COLOUR_GENERATED    always set; colour is never known
```

The overlay tints animals and plants by bits 0/1. Info cards show: name, rank, body plan, length (with its source), mass "(estimated)", evidence (number of occurrences, nearest distance, age ranges, PBDB occurrence and reference links), density note, and any flags.

The tile also gets a **field guide** panel listing the whole roster, so taxa present but not visible (e.g. realistic density = 0 animals here) can still be explored.

---

## 8. Tests

```
# INVARIANT: deterministic: same tile + settings → identical roster, plants, fauna
# INVARIANT: seams: plant instances within 10 m of a shared edge match between
#            neighbouring tiles
# INVARIANT: no land animal spawns below sea level; no marine animal on land
# INVARIANT: no non-avian dinosaur in any slice younger than 66 Ma
# INVARIANT: every rendered taxon appears in the roster with ≥ 1 occurrence id
# INVARIANT: with representativeFauna off, no DENSITY_BOOSTED flags exist
# INVARIANT: instance counts within budget
# BENCHMARK: realistic large-theropod density ≈ 0.01 per km² at ~5,200 kg
#            (Marshall et al. 2021); report, do not fail
```

---

## Amendment to DESIGN.md

- **A9:** scatter seeds are **world-anchored** per scatter-grid cell (`hash(slice, layer, cell)`), not per tile, so plants and spawn sites match across tile edges.

---

## Amendments from coding (2026-11-01)

- **§1 roster size:** every `data` taxon is kept, so N_MAX only limits inferred ones; fossil-rich places list far more than 40 taxa (202 at Hell Creek, 70 Ma).
- **§1 family-level records:** an occurrence identified only to family (e.g. Ceratopsidae) is listed but not drawn when a genus of the same body plan is present, so the same animals aren't counted twice.
- **§3 trophic constants:** carnivore k = 0.01 × 5,200^0.75 (Marshall et al. 2021); herbivores ×10 and omnivores ×3, provisional pending calibration against Damuth (1981).
- **§3 sizes:** `size_hint` is still blank in `rules.csv`, so every taxon uses its body-plan default (listed in `roster.ts`, provisional, shown as "body-plan default" on cards).
- **§4 layers:** canopy 10 m and understorey 7 m; ground cover is carried by the terrain colour, not instances. Over budget, instances are thinned evenly by seed rather than truncated. Fields are read on the step-4 vertex lattice so a tile's plants don't change with its resolution.
- **§4 animals:** the budget goes to the largest animals first, at most 12 per taxon, so small mammals don't crowd out everything else.
- **§5 K–Pg:** besides non-avian dinosaurs, pterosaurs and marine reptiles (mosasaurs, plesiosaurs) are excluded after 66 Ma; they did not survive the extinction.
- **PBDB links:** the data service's documented single-record URLs (`data1.2/occs/single.json?id=…`, `data1.2/refs/single.json?id=…&show=both`); the classic web pages were unreliable when checked.

- **§3 abundance, fixed (2026-11-02):** Damuth's law is a per-species relation (Damuth 1981 regressed the population densities of individual mammal species on their body mass; Marshall et al. 2021 applied it to one species, *T. rex*). The first version treated it as a density budget for a whole trophic level and split that among all taxa in the 150–750 km roster by evidence share, so with ~200 taxa a weakly evidenced genus came out thousands of times rarer than Damuth's law gives (e.g. *Furcatoceratops* at Hell Creek, 70 Ma: ≈ 1 per 56,000 km² instead of ≈ 1 per 8 km²). Each taxon now gets the full per-species density for its mass ("where it lived"), and a separate, provisional **presence** (0–1) from its evidence says how likely it was right here; the expected count is their product times area and habitat. Cards and the field guide show both. On the Hell Creek tile, well-sampled taxa saturate near 100% presence; a genus known from one occurrence 92 km away gets ≈ 50%. Remaining limitation: the roster still pools a 5 Myr slice window, so taxa that never coexisted can appear together at full density (the age fit only partly discounts them).

