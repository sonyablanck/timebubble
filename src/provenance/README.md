# provenance/

Every feature carries a source tag, and the player can see it (DESIGN §2 rule 2). Design: [`PSEUDOCODE.md`](PSEUDOCODE.md) (status and amendments at the top and end).

| File | What it does |
|---|---|
| `flags.ts` | The single registry of provenance flags (`F`), their plain-language explanations and citation keys (`FLAG_INFO`), and `levelOf(kind, flags, strength)`, the only function that turns flags into data / inferred / generated. |
| `report.ts` | The provenance report (`buildReport`, `reportJson`, `reportCsv`) and "cite this view" (`citeThisView`). References are parsed from `REFERENCES.md` at build time, so the report and the bibliography can't drift apart. Pure and deterministic: the same view and data version give byte-identical output. |

The overlay itself is drawn by `render/materials.ts` (`overlayGlsl`: source, focus and evidence modes, the invented-coastline outline, and the hidden pass that measures in-view shares); its legend and the citation dialog are in `ui/Walk.tsx`; the link that reopens a view is `ui/url.ts`.

Terrain levels: `terrain/surface.ts` `provStrength` = max(|generated relief| / local amplitude, |generated relief| / 80 m), so invented relief reads `inferred` from 20 m (or 25% of the amplitude) and `generated` from 60 m (or 75%), and anywhere invented detail moved the coastline.

## Tests

`flags.test.ts` (registry invariants, `levelOf` total and pure, no always-generated aspect reported as data) and `report.test.ts` (every reference key resolves to `REFERENCES.md`, byte-identical reports, taxa with their evidence IDs, the citation's contents). The browser check `tests/browser/provenance_browser.mjs` runs the three overlay modes, the in-view shares, the link, the citation, both downloads and reopening the link.
