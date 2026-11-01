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

## Walk mode

`walk_browser.mjs` runs the walk-mode flow on real data: enters at a 150 Ma lowland, a mountain and a sea point; checks the ground clamp, the overlay, an inspect card, flight, tile-edge crossings (rebasing without jumps), the sea start, Back to globe and the console. Software GL (SwiftShader) draws about one frame a second, so the script pauses the frame loop and steps the simulation itself, drawing one frame before each screenshot.

```bash
npm run dev &
node tests/browser/walk_browser.mjs http://localhost:5173/ shots
```

## Field guide

`field_guide_browser.mjs` walks in at Hell Creek (70 Ma), opens the field guide (G), checks the roster and links, and turns representative fauna off (no density-boosted badges should remain).
