# render/

Walk mode: first-person walking and flight over the generated terrain. Design: [`PSEUDOCODE.md`](PSEUDOCODE.md) (status and amendments at the top).

| File | What it does |
|---|---|
| `projection.ts` | `LocalFrame`: floating origin at the current tile's centre; local metres (+x east, +y up, −z north) with Earth curvature (drop d²/2R). Rebasing re-projects from lat/lon, so positions stay continuous. Also the equinox sun direction and compass heading. |
| `meshes.ts` | Tile meshes with skirts, the far ring, the curved sea; `tileHeightAt` interpolates on the drawn triangles (the walker stands on what is drawn). |
| `morph.ts` | Ring tiles blend from H to Hsmooth within 1.2 km of the edge of the 3 × 3 ring, so they meet the far ring without steps or gaps. The tile underfoot is never morphed. |
| `materials.ts` | Terrain material: vertex colour from biomes, elevation and slope, plus the provenance overlay (Okabe–Ito colours, α 0.55, dots = inferred, hatching = generated) as a uniform toggle; the organism material (vertex colours, instanced provenance level, wind sway) shares the same overlay. |
| `organisms/models.ts` | Procedural low-poly body-plan models: 7 plant plans plus a dead snag (1 unit tall) and the animal plans (1 unit long, facing −z), with per-part vertex colours. Generic shapes, not species anatomy. |
| `organisms/layers.ts` | `FloraLayer` (one `InstancedMesh` per plant plan, per-plan draw distances, rebuilt after 150 m or tile changes, picking) and `FaunaLayer` (animals from each tile's ecology, behaviour stepped near the player, rebasing with the floating origin, picking). |
| `walk.ts` | `WalkRenderer`: streaming (current tile coarse, then full; ring at step 4; far ring ±60 km of Hsmooth), player controller, sky and sun, inspect cards, input, debug hooks for tests. |

## Controls

Click to capture the mouse (or drag to look if pointer lock is unavailable); WASD to move, Shift to run (1.4 / 4 m/s); Space to hop; F to fly (Space / C up and down, wheel 5–60 m/s, Shift ×2.5); P toggles the provenance overlay; I or click inspects the animal, plant or ground under the crosshair; G opens the field guide; `[` `]` change the time of day; Esc releases the mouse, Esc again returns to the globe.

Rules: no swimming (the shore stops you; points in the sea start in flight), slopes over 40° block walking, flight stays 2 m above ground and sea.

## Tests

`projection.test.ts` (inverse, rebase continuity across the antimeridian, float32-safe origin after 50 km, curvature, sun, compass), `meshes.test.ts` (height lookup, E/W continuity, mesh raycast agrees with the walker's ground height, morph field) and `organisms/models.test.ts` (every model's size, footing and triangle budget). The browser walk-through `tests/browser/walk_browser.mjs` runs the whole flow on real data: ground clamp while running, overlay, inspect card, flight, crossing tile edges without jumps, sea start, back to the globe, no console errors.

Not yet: plant LODs and impostors, animal animation and integument, shadows, quality presets, photo mode, focus/evidence overlay modes, coastline outlines in the overlay.
