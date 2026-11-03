# src/data/

Loads, decodes and caches everything in `/public/data`. Pure I/O: no geometry, no rules. Design: [`PSEUDOCODE.md`](PSEUDOCODE.md). Status: **coded and tested**.

## Use

```ts
import { DataStore } from "./data";

const store = new DataStore();               // base URL = Vite BASE_URL + "data/"
const slice = await store.slice(150);        // snaps to the nearest slice (ties → older)

const elev = await slice.globe();            // Grid, metres
elev.at(elev.rowOf(30), elev.colOf(60));     // value at 30°N, 60°E
const t = await slice.temperature();         // Grid, stored ×100
t.valueAt(t.rowOf(0), t.colOf(0));           // °C
const p = await slice.precipitation();       // valueAt() gives mm/day
const meta = await slice.climateMeta();      // source intervals, mismatches, overrides

await slice.ensureRegion(lat, lon, 3);       // load 0.1° chunks first...
const dem = slice.dem();
dem.cell(dem.latIdxOf(lat), dem.lonIdxOf(lon)); // ...then sample synchronously

const eco = await slice.ecology();           // eco.available is false until the fossil steps run
eco.near(lat, lon, 150);                     // occurrences with distanceKm, nearest first
```

Create one `DataStore` per thread (main thread and terrain worker); they share nothing.

## Inputs

`manifest.json` from `pipeline/build_manifest.py`, and the files it lists. The manifest carries each slice's grid dimensions, so no sidecar has to be fetched before decoding.

## Outputs

| Call | Returns | Units |
|---|---|---|
| `globe()` | `Grid` 360×181 | m |
| `continentality()` | `Grid` | km, land +, sea − |
| `temperature()` | `Grid`, `scale` 100 | `valueAt()` → °C |
| `precipitation()` | `Grid`, `scale` 100 | `valueAt()` → mm/day |
| `climateMeta()` | `ClimateMeta` | |
| `climate()` | `ClimateParams` or `null` (until `climate_by_age.json` exists) | |
| `dem()` | `DemSampler` (0.1°, 3600×1801) | m |
| `ecology()` | `EcologyIndex` | km for distances |

On the store itself: `credits()`, `climateParams()`, and `places()` (the modern-place lookup, `PlaceIndex` from `src/places/`, loaded on the first search; `null` if `pipeline.places` hasn't run).

Every failure is a `DataError` with `kind` (`network`, `format`, `missing`, `region`) and the file `path`.

## Invariants (tested)

- gzipped and plain inputs decode to identical arrays; a wrong length is a `format` error naming the file
- `cell(lat, NLON) == cell(lat, 0)`; regions straddling the antimeridian load chunks from both sides
- sampling never triggers a fetch; sampling an unloaded region throws a `region` error rather than guessing
- concurrent `ensureRegion` calls fetch each chunk once
- 404 is reported at once; 5xx and network failures are retried twice with backoff
- asset URLs carry `?v=<data_version>`; the manifest is fetched with `cache: "no-cache"`
- grids stay cached for the current and previous slice; ecology for the current slice only
- **against real pipeline output** (`tests/real-data.test.ts`): the 1° globe equals the trapezoid mean of the 0.1° chunks read through the sampler; continentality agrees with the heightmap on every cell; climate grids reproduce the sidecar means; the 65 Ma override is present

## Conventions other modules rely on

- **Bin keys** (`ecology/{age}.json`): the south-west corner of a 5° bin, `"35_-5"` = 35–40°N, 5°W–0°; 90°N joins the 85° bin. `pipeline/bin_occurrences.py` must use `binKey()`'s rule.
- **Chunk cache** holds 16 chunks (≈ 330 KB). A tile needs at most 4, so `ensureRegion` then sample, one tile at a time per thread.
