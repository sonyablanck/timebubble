# provenance/ module pseudocode — Time Bubble

Implements DESIGN.md §2 rule 2: every feature carries a source tag, and the player can see it. This module owns the **single registry** of provenance flags, derives the `data` / `inferred` / `generated` level from them, draws the overlay, builds info cards and exports a provenance report.

Conventions as in `pipeline/PSEUDOCODE.md`: `# INVARIANT:` lines become tests, `# CHECK:` lines are facts to verify first.

---

## 0. Core types

```ts
enum Level { DATA = 0, INFERRED = 1, GENERATED = 2 }

type Flags = number          // u32 bitmask, bits from the registry in §1

interface ProvenanceRecord {
  kind: "terrain" | "biome" | "plant" | "animal" | "sky" | "water"
  level: Level               // derived from flags (§2), never set by hand
  strength?: number          // 0..1, terrain only: share of generated relief
  flags: Flags
  evidence: Evidence[]       // what backs this feature, §4
}
```

---

## 1. Flag registry (supersedes the per-module bit lists)

One `u32` namespace for the whole app, so a flag means the same thing everywhere and the overlay can filter on any of them.

| Bit | Name | Set by | Meaning |
|---|---|---|---|
| 0 | DATA_SURFACE | terrain | base surface from the PaleoDEM |
| 1 | GENERATED_RELIEF | terrain | detail noise moves the surface by more than 2 m |
| 2 | GENERATED_COAST | terrain | detail flipped land/sea relative to the source |
| 3 | BIOME_INFERRED | biome | biome from the climate model and rules (always on biome outputs) |
| 4 | PLANTS_FROM_DATA | biome | plant mix mostly from nearby plant occurrences |
| 5 | PLANTS_FROM_PRIOR | biome | age-aware prior contributed more than half |
| 6 | THERMAL_EXCLUSION | biome | heat stress above threshold (Sun et al. 2012) |
| 7 | ICE_CONTESTED | biome | ice shown in an interval where it is debated |
| 8 | TAXON_FROM_DATA | ecology | occurrence within 150 km, not straddling K–Pg |
| 9 | TAXON_INFERRED | ecology | borrowed from 150–750 km, or straddling K–Pg |
| 10 | SIZE_FROM_RULE | ecology | size from `rules.csv` (else class default) |
| 11 | DENSITY_BOOSTED | ecology | shown by the representative-fauna setting |
| 12 | COLOUR_GENERATED | ecology | colour invented (always on organisms) |
| 13 | STRADDLES_KPG | ecology | an occurrence's age range crosses 66 Ma |
| 14 | AFTERMATH_RECON | biome, ecology, render | Aftermath mode override active |
| 15 | TEMP_AGE_MISMATCH | biome | temperature grid differs from slice age by > 3 Myr |
| 16 | SKY_GENERATED | render | sky, light and weather (always on) |
| 17–31 | reserved | | |

```
# INVARIANT: TAXON_FROM_DATA and TAXON_INFERRED are mutually exclusive
# INVARIANT: PLANTS_FROM_DATA and PLANTS_FROM_PRIOR are mutually exclusive
# INVARIANT: no module defines bits outside this registry (lint rule:
#            flag constants may only be imported from provenance/flags.ts)
```

Each flag also has a **plain-language explanation** and optional citation keys, in `flags.ts`, used by info cards and the legend:

```ts
FLAG_INFO[GENERATED_COAST] = {
  short: "Generated coastline",
  long:  "Fine-scale detail moved this point across sea level. The source data
          (≈11 km cells) put the coastline nearby, but not exactly here.",
  refs:  ["scotese2018"]
}
```

---

## 2. Deriving the level

The level is computed from the flags by one function, so no module can quietly label something `data`.

```
levelOf(kind, flags, strength):
    switch kind:
      terrain:  if flags & GENERATED_COAST: return GENERATED
                return strength < 0.25 ? DATA
                     : strength < 0.75 ? INFERRED        # blended, shown as a gradient
                     : GENERATED
      biome:    return INFERRED
      plant:    return flags & PLANTS_FROM_DATA ? DATA : INFERRED
                # species presence only; colour and exact position are generated
      animal:   if flags & DENSITY_BOOSTED: still the taxon's level (presence), the
                boost is shown as a separate badge
                return flags & TAXON_FROM_DATA ? DATA : INFERRED
      sky, water surface: return GENERATED
    if flags & AFTERMATH_RECON: return max(level, INFERRED)
```

A feature has one level but several **aspects** (presence, size, colour, position). Info cards list the aspects separately, e.g. "Presence: data · Size: inferred · Colour: generated", so one label never oversells.

---

## 3. Overlay

Toggle with **P** (default off). Modes, cycled with **Shift+P**:

1. **Source:** tint everything by level.
2. **Focus:** highlight one flag chosen from the legend (e.g. show only DENSITY_BOOSTED animals or GENERATED_COAST); everything else greys out.
3. **Evidence:** terrain tinted by distance to the nearest fossil occurrence used on this tile, to show where the record is thin.

### 3a. Colours and patterns

Colour-blind-safe Okabe–Ito palette, with a pattern as a second channel, so meaning never relies on colour alone:

| Level | Colour | Pattern |
|---|---|---|
| data | blue `#0072B2` | solid |
| inferred | orange `#E69F00` | fine dots |
| generated | reddish purple `#CC79A7` | diagonal hatching |

### 3b. Rendering

```
terrain:  per-vertex attributes: level (float, from strength for the gradient),
          flags (u32 as integer attribute; WebGL2 supports it)
          shader: base colour → mix with level colour (α 0.55) + screen-space pattern
          generated coastline: outline where GENERATED_COAST changes across a triangle
plants/animals: per-instance level + flags attribute in the instanced shader
sky:      small legend note "sky: generated" (no tint, to keep the view usable)
focus mode: uniform u_focusMask; fragments with (flags & u_focusMask) == 0 desaturate
```

Overlay changes are uniform updates only: no rebuild of geometry.

### 3c. Legend (always visible when the overlay is on)

```
legend shows:
    the three levels with colour + pattern swatches
    "In view: 61% data · 31% inferred · 8% generated"
        computed by sampling a 64×64 grid of screen rays every 0.5 s on a worker
        (area share of visible surface, not a count of objects)
    the active focus flag, if any, with its explanation
```

---

## 4. Info cards

Picking (render/) returns `{ kind, id, vertexOrInstance }`. Provenance builds the card:

```ts
interface Evidence {
  type: "dataset" | "occurrence" | "reference" | "model" | "rule" | "setting"
  label: string               // e.g. "PaleoDEM 0.1° cell (12.3°N, 45.6°E): 212 m"
  link?: string               // DOI or PBDB occurrence / reference URL
  refKey?: string             // into credits.json / REFERENCES.md
}

cardFor(record):
    header: name or feature type + level badge (colour + pattern)
    aspects: presence / position / size / colour, each with its level
    evidence: list (most direct first)
        terrain: source cell value, local height, generated share, dataset DOI
        biome: temperature (grid value, source interval, age mismatch),
               moisture "(model)", alternative estimate (Judd et al. 2024 ΔGMST)
        animal/plant: occurrence count, nearest distance, age ranges,
                      PBDB occurrence and reference links, size source
    notes: one sentence per set flag (FLAG_INFO.long)
    footer: "How to cite this view" (§5)
```

PBDB links are built from IDs (`https://paleobiodb.org/classic/...`). `# CHECK:` the stable public URL patterns for occurrences and references before coding.

---

## 5. Provenance report and "cite this view"

A research user should be able to reproduce and cite exactly what they saw.

```
exportReport(view) -> JSON + CSV (download, nothing leaves the browser)
{
  app: { name: "Time Bubble", version, commit },
  data: { pipeline_version, inputs_hash, plate_model },
  view: { sliceAge, aftermath phase/year, tile id, centre palaeo lat/lon,
          camera position, settings (representativeFauna, overlay mode) },
  datasets: [ name, version, DOI, licence ] ,            # from credits.json
  climate: climate_by_age[sliceAge] with ref keys,
  temperature: { source_interval, source_age, age_mismatch_myr },
  roster: [ taxon, level, flags (names), occurrence ids, reference ids,
            nearestKm, size source, density boosted? ],
  shares: { data, inferred, generated },                  # from the legend sampler
  references: resolved entries for every ref key used
}

citeThisView() -> text, e.g.
  "Time Bubble v{version} (data {inputs_hash}), {sliceAge} Ma, tile {id}
   ({lat}°, {lon}° palaeo). Built on Scotese & Wright (2018); Scotese (2016, 2022);
   the Paleobiology Database (accessed {date}). Provenance report attached."
```

The view can also be encoded in the URL (`?age=150&lat=..&lon=..&cam=..`), so a link reopens the same tile and camera. Report + link together make a view reproducible.

---

## 6. Interfaces for other modules

```ts
// flags.ts: the only place flag constants live
export const F = { DATA_SURFACE: 1 << 0, ..., SKY_GENERATED: 1 << 16 }
export function levelOf(kind, flags, strength?): Level
export const FLAG_INFO: Record<number, FlagInfo>

// overlay.ts
export function setOverlay(mode: "off" | "source" | "focus" | "evidence", focus?: Flags)
export function legendStats(): { data, inferred, generated }

// cards.ts
export function cardFor(pick: PickResult): InfoCard

// report.ts
export function exportReport(view: ViewState): Blob
export function citeThisView(view: ViewState): string
export function viewToUrl(view) / viewFromUrl(url)
```

---

## 7. Tests

```
# INVARIANT: every rendered feature resolves to a ProvenanceRecord with a level
# INVARIANT: levelOf is pure and total: every (kind, flags) gives a level
# INVARIANT: no feature with GENERATED_COAST, SKY_GENERATED or COLOUR_GENERATED
#            reports that aspect as DATA
# INVARIANT: legend shares sum to 100% (±0.5)
# INVARIANT: viewFromUrl(viewToUrl(v)) == v
# INVARIANT: the report for the same view and data version is byte-identical
# INVARIANT: every ref key in a report resolves to a REFERENCES.md entry
# CHECK: overlay colours and patterns stay distinguishable under protanopia,
#        deuteranopia and tritanopia simulation (manual check with a simulator)
```
