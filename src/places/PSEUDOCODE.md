# places/ pseudocode

> **Status: coded** (2026-11-03; see README). Pipeline side: `pipeline/PSEUDOCODE.md` §7.

## §1 Rotate a modern point to a slice

```
load places.json (units, rotations, grid spec) and units.i16.gz      # once, on first search
unit = units[grid[floor(row(lat)), floor(col(lon))]]                 # cell-registered, 0.1°
if unit is none: return no-plate
if unit.crust_from_ma and slice_age > unit.crust_from_ma: return not-formed(crust_from_ma)
q = rotations[slice_age][unit.plate]                                  # [w, x, y, z]
return to_lat_lon(q · to_vec(lat, lon) · q*)

# INVARIANT: matches pyGPlates within 0.1 km where the grid's plate is pyGPlates' plate
# INVARIANT: never pins crust on a slice older than the crust
# Provenance: position is `inferred` (rigid plates, PALEOMAP v19o_r1d)
```

## §2 Search

```
on submit (Enter or the button; never while typing — Nominatim policy):
    if text parses as coordinates ("51.5, -0.1", "33.9S 18.4E"): answer locally, no request
    elif cached: answer from cache
    else: queue; wait until ≥ 1.1 s since the last request; GET /search?q&format=jsonv2&limit=5&accept-language
          429 → "busy, try again"; other errors → message; results → cache
show up to 5 results with "Search by Nominatim · © OpenStreetMap contributors" (linked)

# INVARIANT: requests ≥ 1.1 s apart; repeats never re-request
```

## §3 UI

```
choose(result): locate at current slice
    ok          → pin with the place's name, fly there, open the place panel ("X today was here at N Ma", inferred)
    not-formed  → no pin; say from which slice it appears, or that it is younger than every slice
on slice change: re-locate the same modern point (the pin follows the plate)
click on globe: replaces the searched place with a plain palaeo-pin
link: place=lat,lon & pn=name (modern coordinates); reopening restores it on the linked slice
"/" focuses the search box on the globe screen
```

## Deferred

- A drawn modern-coastline overlay (globe pseudocode, Deferred).
- Showing the searched place in walk mode (a compass marker) and in the provenance report.
