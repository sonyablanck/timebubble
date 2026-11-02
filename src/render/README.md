# render/

Walk mode: first-person walking and flight over the generated terrain. Design: [`PSEUDOCODE.md`](PSEUDOCODE.md) (status and amendments at the top).

| File | What it does |
|---|---|
| `projection.ts` | `LocalFrame`: floating origin at the current tile's centre; local metres (+x east, +y up, −z north) with Earth curvature (drop d²/2R). Rebasing re-projects from lat/lon, so positions stay continuous. Also the equinox sun direction and compass heading. |
| `meshes.ts` | Tile meshes with skirts, the far ring, the curved sea; `tileHeightAt` interpolates on the drawn triangles (the walker stands on what is drawn). |
| `morph.ts` | Ring tiles blend from H to Hsmooth within 1.2 km of the edge of the 3 × 3 ring, so they meet the far ring without steps or gaps. The tile underfoot is never morphed. |
| `materials.ts` | Terrain material: vertex colour from biomes, elevation and slope, plus the provenance overlay (`overlayGlsl`: source mode with Okabe–Ito colours, α 0.55, dots = inferred, hatching = generated; focus mode for one flag; evidence mode by distance to fossil sites; the invented-coastline outline; and the hidden pass that measures in-view shares), all switched by one uniform; the organism material (vertex colours, instanced provenance level, wind sway, walk cycle and grazing, generated patterns), matching shadow-depth materials, and the cut-out (impostor) material share the same overlay. |
| `organisms/models.ts` | Procedural body-plan models. Plants: 2–3 variants per plan plus snags, 1 unit tall, with pinnate fronds, jagged conifer tiers, lumpy crowns and baked shading. Animals: smooth hulls swept along a spine with jointed limbs and plan-specific parts, 1 unit long facing −z, countershaded, with rig weights for the shader. Generic shapes, not species anatomy. `tests/browser/models.html` shows them all side by side. |
| `organisms/layers.ts` | `FloraLayer`: instanced meshes per (plan, variant, distance tier): shadow-casting full models, full models, and cut-outs baked into an atlas at startup; rebuilt after 120 m or tile changes; picking. `FaunaLayer`: animals from each tile's ecology, behaviour stepped near the player, per-instance gait/grazing/pattern for the shader, rebasing with the floating origin, picking. |
| `organisms/locator.ts` | The field guide's Locate marker: a beam above the located organism (visible through trees, taller with distance) and a pulsing ground ring. |
| `walk.ts` | `WalkRenderer`: streaming (current tile coarse, then full; ring at step 4; far ring ±60 km of Hsmooth), player controller, sky, sun and shadows, inspect cards, field-guide Locate and "Take me there", input, debug hooks for tests. |

## Controls

Click to capture the mouse (or drag to look if pointer lock is unavailable); WASD to move, Shift to run (1.4 / 4 m/s); Space to hop; F to fly (Space / C up and down, wheel 5–60 m/s, Shift ×2.5); P toggles the provenance overlay; I or click inspects the animal, plant or ground under the crosshair; G opens the field guide; `[` `]` change the time of day; L toggles shadows; Esc releases the mouse, Esc again returns to the globe.

Rules: no swimming (the shore stops you; points in the sea start in flight), slopes over 40° block walking, flight stays 2 m above ground and sea.

## Tests

`projection.test.ts` (inverse, rebase continuity across the antimeridian, float32-safe origin after 50 km, curvature, sun, compass), `meshes.test.ts` (height lookup, E/W continuity, mesh raycast agrees with the walker's ground height, morph field) and `organisms/models.test.ts` (every model and variant: size, footing, attributes, triangle budget, necks up and tails down, rig pivots). The browser walk-through `tests/browser/walk_browser.mjs` runs the whole flow on real data: ground clamp while running, overlay, inspect card, flight, crossing tile edges without jumps, sea start, back to the globe, no console errors.

Not yet: animal integument, quality presets, photo mode, focus/evidence overlay modes, coastline outlines in the overlay.
