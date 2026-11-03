# Browser checks

End-to-end checks of the globe in headless Chromium, against real pipeline output. Optional; they need Playwright, which is not a project dependency.

```bash
npm install --no-save playwright && npx playwright install chromium   # once
npm run dev                                                           # in another terminal
node tests/browser/globe_browser.mjs      # loads, hovers, picks, steps slices, toggles layers,
                                          # reloads from the URL; screenshots in ./shots
node tests/browser/globe_consistency.mjs  # rendered land/sea vs picked data; pick(project(p)) == p
```

Results on 2026-10-31 (software WebGL, real 2024 PaleoDEMs):

- land/sea colour agreed with the picked data at 99.8–100% of ~8,500 sampled pixels across 150, 65 and 250 Ma (points within 150 km of a coast skipped; the few misses sit at the limb, where exaggerated relief hides what lies behind it and picking ignores displacement by design)
- `pick(project(lat, lon))` round trip: 0.0000° worst error
- no console errors or warnings

## Accessibility

`a11y_browser.mjs` is the ui §9 audit: axe-core (WCAG 2.0/2.1/2.2 A and AA, best practice) on every screen and panel; focus traps, Esc and focus return for each dialog; a focus ring on every Tab stop; a keyboard-only journey (search → Walk here → info card → field guide → cite → back to the globe); 150% text at 1400 × 860 and 1280 × 720 with no panels off screen or overlapping; and the app with `localStorage` throwing and `prefers-reduced-motion` on. Needs `npm install --no-save axe-core`. All 42 checks passed on 2026-11-03 (after the fixes listed in ui/PSEUDOCODE.md, amendment §9).

## Place search

`place_search_browser.mjs` checks "Where was my town?" with Nominatim stubbed (the script never contacts the real service): "/" focuses the box, one request per search, OSM attribution, Hastings pinned at pyGPlates' 150 Ma position and following Eurasia to 250 Ma, Reykjavik typed as coordinates (no request; crust not formed at 65 Ma, no pin), a globe click clearing the place, a link reopening it, and a clean console. All 15 checks passed on 2026-11-03.

## Walk mode

`walk_browser.mjs` runs the walk-mode flow on real data: enters at a 150 Ma lowland, a mountain and a sea point; checks the ground clamp, the overlay, an inspect card, flight, tile-edge crossings (rebasing without jumps), the sea start, Back to globe and the console. Software GL (SwiftShader) draws about one frame a second, so the script pauses the frame loop and steps the simulation itself, drawing one frame before each screenshot.

```bash
npm run dev &
node tests/browser/walk_browser.mjs http://localhost:5173/ shots
```

## Field guide

`field_guide_browser.mjs` walks in at Hell Creek (70 Ma), opens the field guide (G), checks the roster and links, and turns representative fauna off (no density-boosted badges should remain).

## Locate

`locate_browser.mjs` (Hell Creek, 70 Ma) opens the field guide, locates a drawn dinosaur, checks the HUD chip (name, distance, "ahead" when facing the bearing), walks towards it and sees the distance fall, uses "Take me there" (ends within 40 m, facing it, on the ground), stops, locates a plant type, and checks that a taxon with nothing drawn reports so without leaving a marker. Result on 2026-11-02: all 15 checks pass, no console errors.

## Models

`models.html` (open it from the dev server: `/tests/browser/models.html`) draws every animal body plan and the first variant of each plant plan side by side, for eyeballing proportions.

## Provenance

`provenance_browser.mjs` (Hell Creek, 70 Ma) turns the overlay on (in-view shares sum to 100%), steps through focus (picks a flag) and evidence (nearest fossil site), checks that the URL follows the walk view, opens "cite this view" (R), downloads the JSON and CSV reports and checks their contents, then opens the link in a new tab and checks it lands in walk mode at the same place, heading and overlay. Result on 2026-11-02: all 18 checks pass, no console errors.

## Panels, sea and photo mode

`node tests/browser/panels_sea_browser.mjs [url] [outDir]` checks the intro (first visit only), H for help and Esc to close, the About panel's datasets, papers and maintainer, that settings persist across a reload and apply in walk mode, the terrain card's global-mean line at Hell Creek (70 Ma), the sea-floor depth texture at the Western Interior Seaway shore, the heat-haze level, and photo mode (K hides the HUD; Save writes a PNG with a caption strip). Screenshots `sea-*.png` show the shore.
