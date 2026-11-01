# src/globe/

The 3D globe of the chosen slice: relief, sea, climate layers, fossil dots, grid, picking and the time-slider logic. Design: [`PSEUDOCODE.md`](PSEUDOCODE.md). Status: **coded and tested**, running on the real data.

## Use

```ts
const globe = new Globe();
await globe.mount(canvas, store, { initialAge: 150, reducedMotion });
globe.onHover((info) => ...);          // HoverInfo | null
globe.onPick((info) => ...);           // click (not drag) on the globe
globe.onEnterTile((req) => ...);       // "Walk here" → terrain/ (not built yet)
await globe.setSlice(65);              // snaps; crossfades 400 ms (instant with reduced motion)
globe.setLayer("temperature", true);   // relief | temperature | precipitation | fossils | graticule | provenance
globe.setExaggeration(40);
await globe.flyTo(lat, lon);
```

Keys (when focus is not in a form control): arrows rotate, `+`/`-` zoom, `[`/`]` older/younger slice, `R` reset.

## Files

| File | What |
|---|---|
| `geo.ts` | The one coordinate convention: lon 0 at +z, lon 90 at +x, north +y; grid texel mapping; ray–sphere picking |
| `palette.ts` | Colour scales, compiled into GLSL *and* used by the HTML legends, so they cannot drift apart |
| `shaders.ts` | Relief (displaced, hillshaded), sea shell (depth-tinted), climate and provenance overlays |
| `textures.ts` | Grids → half-float textures (linear filtering guaranteed in WebGL2) |
| `camera.ts` | Orbit camera in palaeo-coordinates: continents drift underneath when the slice changes |
| `timeline.ts` | Slider ticks, period bands, snapping and stepping |
| `fossils.ts` | Fossil dots per 5° bin at the occurrences' centroid; empty until the fossil pipeline runs |
| `globe.ts` | Scene, slices (crossfade, prefetch of neighbours, ≤ 3 slices of textures), layers, input, hover, picking |

## Decisions made while coding

- **Temperature and precipitation share one overlay slot:** turning one on turns the other off, so the 50% blend stays readable.
- **The sea writes depth** so grid lines behind it are hidden at the limb.
- **Fossil dots float just above the highest exaggerated relief**, so mountains never swallow them.
- **Grid lines** every 15°, with the equator and the modern tropics (±23.44°) emphasised for orientation; latitude labels follow a meridian 25° west of the view centre.
- **The 1° grid shows** as slightly blocky shallow-water patches up close. That is the data's resolution, not a bug, and the terrain view (0.1°) is where detail lives.

## Invariants (tested)

Unit (`globe.test.ts`): lat/lon ↔ 3D round trip; a marker at (30°N, 60°E) lands on its own texel; ±180° share a texel; picks either side of ±180° resolve correctly; shader colour stops = legend stops; slider snapping and stepping never overshoot; fossil centroids across the antimeridian.

Browser (`tests/browser/`): rendered land/sea agrees with the readout at 99.8–100% of sampled pixels on three slices; `pick(project(p)) == p` exactly; URL round trip restores slice, camera and layers; no console errors.
