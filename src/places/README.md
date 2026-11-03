# places/

"Where was my town?" (DESIGN A19). Finds a modern place by name and works out where it was on a slice. Design: [`PSEUDOCODE.md`](PSEUDOCODE.md).

| File | What it does |
|---|---|
| `rotate.ts` | §1 `PlaceIndex`: present-day plate and crust age from the 0.1° grid baked by `pipeline/places.py`, then the plate's quaternion for the slice. Returns `ok` (palaeo-lat/lon), `not-formed` (crust younger than the slice) or `no-plate`. |
| `geocode.ts` | §2 `Geocoder`: Nominatim search within its usage policy (on submit only, ≥ 1.1 s between requests, cached, attribution); typed coordinates are parsed locally and never sent. `GEOCODER_URL` is the one place to switch provider. |

Loaded by `DataStore.places()` the first time someone searches (≈ 0.25 MB gzipped), never at start-up. The UI (`ui/PlaceSearch.tsx`, `ui/App.tsx`) pins the place with `Globe.pin(lat, lon, name)` and re-places it on every slice change, so the pin follows its plate; a click on the globe replaces it. The link carries `place=lat,lon&pn=name`.

**Inputs:** `public/data/places/places.json`, `public/data/places/units.i16.gz`. **Output:** a palaeo-position, tagged `inferred` (rigid-plate model; expect tens to hundreds of km of uncertainty, more near plate edges and in mountain belts).

**Invariants (tested):** the browser's position equals pyGPlates' to < 0.1 km wherever the 0.1° grid gives the same plate (`tests/real-data.test.ts`, against `tests/fixtures/places_expected.json`); crust is never pinned on a slice older than it; Nominatim requests are ≥ 1.1 s apart and repeats come from the cache (`places.test.ts`); the place survives the URL (`ui/ui.test.ts`); end to end with Nominatim stubbed (`tests/browser/place_search_browser.mjs`).
