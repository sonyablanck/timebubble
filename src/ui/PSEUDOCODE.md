# ui/ module pseudocode — Time Bubble

All HTML interface around the canvas: screens, panels, the time slider, info cards, the field guide, settings, credits and help. It holds the app's single view state and keeps it in sync with the URL.

> **Status: partly coded.** The globe HUD (§1b: slice label, time slider with period bands and ARIA text, layer toggles, exaggeration slider with its ×N label, legends with source intervals and overrides, hover readout, "Walk here" panel), URL sync for the globe view (a `pin` in the URL reopens its panel), the WebGL2 fallback and the no-data message exist in `src/ui/` and `src/main.tsx`. Walk mode adds a loading screen with progress, and a first walk HUD (`src/ui/Walk.tsx`): slice label, position, ground and eye height, mode, sun time, tile status, compass, crosshair, key help, provenance legend, a note that ground colour shows modelled (inferred) biomes, terrain/sea/sky info cards (with ground cover, expected plants and modelled climate), animal and plant cards (taxon, body plan, evidence with PBDB occurrence and reference links, size and density; plant mix and Aftermath die-off), a HUD line counting drawn plants and animals, and Back to globe. A first field guide (G, §3) lists the tile's roster grouped by body plan, with source badges, density-boosted badges, evidence counts, realistic densities, PBDB links, the expected plant mix, a data/inferred filter and the representative-fauna setting. The 65 Ma slice has a working Aftermath control (Impact Winter with a 0–30 year slider, or Fern Spike), applied on entering walk mode. Still to do: intro screen, the field guide's "Locate" (animals are now drawn, so this is unblocked), settings, about, the single view-state store, walk-mode URL state, and `localStorage` preferences.

Conventions as in `pipeline/PSEUDOCODE.md`: `# INVARIANT:` lines become tests, `# CHECK:` lines are facts to verify first.

---

## 0. Framework and state

- **Preact** (MIT, ~4 KB) with TSX, built by Vite. It has React's familiar model, which AI coding tools write fluently, without React's weight. UI is HTML overlaid on the canvas, never drawn in WebGL.
- **One store** for the view state, with modules subscribing to the parts they need:

```ts
interface ViewState {
  screen: "intro" | "globe" | "loading" | "walk"
  sliceAge: number
  aftermath: { on: boolean, phase: "impactWinter" | "fernSpike", year: number }
  globe: { camera, layers: Set<GlobeLayer>, exaggeration, pinned?: {lat, lon} }
  walk?: { tile: TileId, player: PlayerState, flying: boolean }
  overlay: { mode: "off" | "source" | "focus" | "evidence", focus?: Flags }
  panels: { infoCard?: InfoCard, fieldGuide: boolean, settings: boolean,
            about: boolean, help: boolean, report: boolean }
  settings: { quality, representativeFauna, reducedMotion, textScale,
              invertY, mouseSensitivity }
}

store changes → provenance.viewToUrl (debounced 500 ms, history.replaceState)
page load    → provenance.viewFromUrl → store
```

Settings persist in `localStorage`, wrapped in try/catch so the app works when storage is unavailable. The URL carries the view; storage carries preferences only.

---

## 1. Screens

### 1a. Intro

```
title "Time Bubble", one-line pitch, a slowly rotating globe behind
three short points: pick a time · pick a place · see what's data and what's not
buttons: Start (→ globe at 150 Ma by default) · About & credits
shown on first visit; skipped when the URL already contains a view
```

### 1b. Globe HUD

```
top:     slice label ("150 Ma · Late Jurassic") with period colour
bottom:  time slider (globe §8): period bands, ticks, 65 Ma extinction mark and
         Aftermath toggle, keyboard [ ]
left:    layer toggles (relief, temperature, fossils, graticule, provenance),
         exaggeration slider with its "×40" label
corner:  hover readout (globe §5): lat/lon (palaeo), elevation, land/sea,
         temperature "(model)", coast distance, fossil count
on click: "Walk here" panel (globe §6): preview + warnings + Walk button
```

### 1c. Loading

```
progress bar from the terrain worker stages: terrain → biome → ecology → render
"Did you know?" cards that rotate every 6 s, each a cited fact relevant to the
slice, drawn from facts.json (every fact has a ref key), e.g.
   "Dinosaurs nested at about 82°N in the Late Cretaceous Arctic, where winters
    brought freezing spells and occasional snow (Druckenmiller et al. 2021)."
Cancel → back to the globe
```

### 1d. Walk HUD (minimal by default)

```
top-left:   slice label + palaeo-coordinates; "FLYING" badge when in flight
top-right:  compass (N/E/S/W) with palaeolatitude
centre:     small crosshair; hover over a pickable object shows its name
bottom:     key hints that fade after 10 s (WASD · Shift run · F fly · P provenance
            · G field guide · Esc menu)
when overlay on: provenance legend (provenance §3c)
Impact Winter: year slider docked bottom-centre
```

---

## 2. Info card

```
open: click (with pointer lock: the crosshair target; otherwise the cursor target)
content: provenance.cardFor(pick) (provenance §4)
layout: side panel on the right, 360 px; the game keeps running behind it
         header + level badge (colour + pattern)
         aspects row: presence · position · size · colour, each with its badge
         facts: length, mass "(estimated)", temperature, etc.
         evidence list with links (open in a new tab)
         notes for each set flag
         buttons: "Show in field guide" · "Cite this view"
close: Esc, ×, or clicking elsewhere
pointer lock is released while a card is open and re-acquired on close
```

---

## 3. Field guide (G)

```
panel listing the tile's roster (ecology TaxonEntry[]), grouped by body plan
    row: name · level badge · "density boosted" badge if set ·
         realistic density note · evidence count
    "Locate": highlight the nearest instance with an outline and a direction
              arrow; if none is rendered here, say so ("present in this area,
              too rare to appear on this tile")
plants section: plant mix shares with their source (data / prior)
filter: all / data only / inferred only
```

---

## 4. Settings

```
Graphics:   quality preset (auto-detected), fog distance
Ecology:    representative fauna (on by default, with an explanation)
Controls:   mouse sensitivity, invert Y, key bindings (view-only list in v1)
Display:    text size (100–150%), reduced motion
Atmosphere: auto / override preset (render §6)
```

**Reduced motion** (also on by default when the OS asks for it via `prefers-reduced-motion`): no globe auto-rotate, instant slice switches instead of crossfades, cuts instead of camera flights, no wind sway.

---

## 5. About & credits

```
what Time Bubble is and how provenance works (one screen, plain language)
datasets with versions, DOIs and licences  ← credits.json (pipeline §6)
papers and the values they supply          ← credits.json references
software licences (Three.js, Preact, Vite …)
model assumptions: climate_by_age values listed per slice, with refs
maintainer: Sonya Blanck · link to the repository
```

---

## 6. Report and citation dialog (C)

```
"Cite this view": the citation string with a copy button
"Copy link": the view URL
"Download provenance report": JSON or CSV (provenance §5)
```

---

## 7. Help (H or ?)

Key bindings and a short "how to read the overlay" explainer.

| Key | Action |
|---|---|
| WASD / arrows | move (walk) / rotate (globe) |
| Mouse | look (walk, after clicking the view) / drag to rotate (globe) |
| Shift | run |
| Space | hop |
| F | toggle flight |
| P / Shift+P | provenance overlay / cycle overlay mode |
| G | field guide |
| C | cite & report |
| [ / ] | older / younger slice (globe) |
| K | photo mode |
| H or ? | help |
| Esc | close panel → release mouse → back to globe |

---

## 8. Errors

```
DataError (data/ §6):
    network → toast with Retry
    format / missing → toast "Something's wrong with the data for this slice" +
                       details for the console; the app stays on the globe
WebGL2 unavailable → a static page explaining the requirement (desktop browser
                     with WebGL2), with links to the docs and credits
```

---

## 9. Accessibility

- Every control is reachable by keyboard, with visible focus rings; panels trap focus while open and return it on close.
- ARIA labels on all icon buttons; the time slider is an ARIA slider announcing "150 million years ago, Late Jurassic".
- Text meets WCAG AA contrast against its panel background; panels use solid backgrounds, not translucency over the 3D view.
- Meaning is never carried by colour alone (provenance patterns, text badges).
- Text scaling to 150% without layout breakage.

---

## 10. Onboarding

Three dismissable hints on the first visit: the time slider, the "Walk here" click, and the P key for provenance. Each hint shows once (stored in `localStorage`, with try/catch).

---

## 11. Tests

```
# INVARIANT: URL round trip restores screen, slice, aftermath, camera, layers, overlay
# INVARIANT: keyboard-only journey works: intro → globe → choose slice → walk here →
#            open an info card → field guide → back to globe
# INVARIANT: Esc unwinds in order: panel → pointer lock → globe
# INVARIANT: every "Did you know?" fact has a ref key that resolves in REFERENCES.md
# INVARIANT: automated accessibility checks (axe-core, dev dependency only) pass on
#            every screen
# INVARIANT: app renders and works with localStorage throwing
```
