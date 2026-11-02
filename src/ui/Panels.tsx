import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import type { ClimateParams, Credits, DataStore } from "../data";
import { APP_VERSION } from "../provenance/report";
import { applyTextScale, saveSettings, type Detail, type Settings } from "./settings";

// ui/ §1a intro, §4 settings, §5 about & credits, §7 help. Plain HTML panels over the canvas, with
// solid backgrounds (§9); each closes with its button or Esc and returns focus to the view.

export type PanelKind = "intro" | "about" | "help" | "settings";

export const REPO_URL = "https://github.com/sonyablanck/timebubble";

function useEsc(onClose: () => void) {
  useLayoutEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
}

function Shell({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: preact.ComponentChildren }) {
  useEsc(onClose);
  return (
    <div class="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section class={`panel modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        <div class="buttons"><button type="button" class="secondary" onClick={onClose} autoFocus>Close</button></div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ §1a intro

export function Intro({ onStart, onAbout }: { onStart: () => void; onAbout: () => void }) {
  useEsc(onStart);
  return (
    <div class="modal-backdrop intro-backdrop">
      <section class="panel modal intro" role="dialog" aria-modal="true" aria-label="Welcome to Time Bubble">
        <h1>Time Bubble</h1>
        <p class="lead">Walk through the Mesozoic, built from real data, with every guess labelled.</p>
        <ol class="intro-steps">
          <li><strong>Pick a time.</strong> Drag the time slider from 250 to 65 million years ago and watch the continents move.</li>
          <li><strong>Pick a place.</strong> Click the globe, then <em>Walk here</em>. The ground, plants and animals come from palaeogeography, climate models and fossils found nearby.</li>
          <li><strong>See what's data and what's not.</strong> Press <kbd>P</kbd> in walk mode: blue is data, orange is inferred, purple is generated. Click anything to see its evidence.</li>
        </ol>
        <div class="buttons">
          <button type="button" onClick={onStart} autoFocus>Start</button>
          <button type="button" class="secondary" onClick={onAbout}>About &amp; credits</button>
        </div>
        <p class="legend-note">Best in a desktop browser with a mouse and keyboard. Press H at any time for help.</p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ §5 about & credits

export function About({ store, age, onClose }: { store: DataStore; age: number; onClose: () => void }) {
  const [c, setC] = useState<Credits | null | undefined>(undefined);
  const [p, setP] = useState<ClimateParams | null>(null);
  const [dv, setDv] = useState<string>("");
  useEffect(() => {
    store.credits().then(setC).catch(() => setC(null));
    store.slice(age).then((h) => h.climate()).then(setP).catch(() => setP(null));
    store.manifest().then((m) => setDv(m.data_version)).catch(() => undefined);
  }, [age]);
  const ref = (k: string) => c?.references[k] ?? k;
  return (
    <Shell title="About & credits" onClose={onClose} wide>
      <div class="about">
        <p>Time Bubble is an explorer for Earth between 250 and 65 million years ago. Each landscape is generated from published palaeogeography, palaeoclimate and fossil-occurrence data, and everything carries a provenance level: <strong>data</strong> (taken from a dataset), <strong>inferred</strong> (derived by a stated rule or model) or <strong>generated</strong> (invented to fill gaps, such as fine relief, colours and poses). Press P in walk mode to see the levels, and R to cite what you see.</p>
        <p class="muted">Version {APP_VERSION}{dv && <> · data {dv}</>} · maintained by Sonya Blanck · <a href={REPO_URL} target="_blank" rel="noopener">source code</a></p>
        {c === undefined && <p class="muted">Loading credits…</p>}
        {c === null && <p class="muted">Credits haven't been built for this data yet (run pipeline.build_manifest). Full references are in REFERENCES.md.</p>}
        {c && <>
          <h3>Datasets</h3>
          <ul class="credits">
            {c.datasets.map((d) => (
              <li key={d.name}><strong>{d.name}</strong>{d.version && <> ({d.version})</>}. {d.licence}{d.doi && <> · <a href={`https://doi.org/${d.doi}`} target="_blank" rel="noopener">doi:{d.doi}</a></>}
                <div class="muted">Used for {d.used_for}. Changes: {d.changes}.</div>
                <div class="ref">{ref(d.ref)}</div></li>
            ))}
          </ul>
          {c.pbdb && <p class="legend-note">Paleobiology Database download: {c.pbdb.retrieved_utc}, licence as stated: {c.pbdb.data_license}. We credit the database and its contributors regardless.</p>}
          <h3>Papers the datasets ask us to cite</h3>
          <ul class="credits">{c.papers.map((k) => <li key={k} class="ref">{ref(k)}</li>)}</ul>
          <h3>Values entered by hand</h3>
          <ul class="credits">{c.hand_entered.map((h) => <li key={h.what}>{h.what}<div class="ref">{ref(h.ref)}</div></li>)}</ul>
          {p && (
            <>
              <h3>Model assumptions for {age} Ma</h3>
              <ul class="credits">
                <li>Ice: {p.ice_possible ? "brief polar or highland ice is considered possible in this interval (contested; Scotese et al. 2021)" : "none (Scotese et al. 2021)"}.</li>
                {p.gmst_scotese && <li>Global mean temperature of the grid used: {p.gmst_scotese.c.toFixed(1)} °C (Scotese 2022{p.gmst_scotese.grid_age_ma !== age ? `; the ${p.gmst_scotese.grid_age_ma} Ma grid` : ""}).</li>}
                {p.gmst_judd && <li>PhanDA global mean for the {p.gmst_judd.stage}: {p.gmst_judd.p50.toFixed(1)} °C, 68% range {p.gmst_judd.p16.toFixed(1)}–{p.gmst_judd.p84.toFixed(1)} °C (Judd et al. 2024). Shown on info cards as the spread between reconstructions.</li>}
                <li>Animal densities: Damuth's law per species (Damuth 1981), calibrated to ~1 <em>T. rex</em> per 100 km² (Marshall et al. 2021); herbivores ×10 and omnivores ×3 the carnivore constant (provisional); presence from the fossil evidence (provisional).</li>
              </ul>
            </>
          )}
          <h3>Software</h3>
          <p>{c.software.map((s) => `${s.name} (${s.licence})`).join(" · ")}</p>
          <p class="legend-note">Code: MIT licence. Documentation and derived data: CC BY 4.0, carrying the attributions above.</p>
        </>}
      </div>
    </Shell>
  );
}

// ------------------------------------------------------------------ §7 help

const KEYS: [string, string][] = [
  ["Globe: drag / arrows", "rotate; wheel to zoom"],
  ["Globe: [ ]", "older / younger time slice"],
  ["Globe: click", "pick a place, then Walk here"],
  ["W A S D", "move (Shift: run)"],
  ["Mouse", "look (click the view first)"],
  ["Space", "hop; up when flying"],
  ["C", "down when flying"],
  ["F", "fly / walk (wheel: flight speed)"],
  ["P", "provenance overlay on / off"],
  ["Shift+P", "overlay mode: source, focus, evidence"],
  ["I or click", "inspect what's under the crosshair"],
  ["G", "field guide: who lives here; Locate"],
  ["R", "cite this view; provenance report"],
  ["L", "shadows on / off"],
  ["[ ] (walking)", "time of day"],
  ["H or ?", "this help"],
  ["Esc", "close a panel → release the mouse → back to the globe"],
];

export function Help({ onClose, onAbout }: { onClose: () => void; onAbout: () => void }) {
  return (
    <Shell title="Help" onClose={onClose} wide>
      <div class="help-cols">
        <div>
          <h3>Keys</h3>
          <dl class="readout-list compact">{KEYS.map(([k, v]) => <><dt key={k}><kbd>{k}</kbd></dt><dd>{v}</dd></>)}</dl>
        </div>
        <div>
          <h3>Reading the overlay</h3>
          <div class="prov"><span class="sw sw-data" /> <strong>data</strong>: straight from a dataset. The ground's shape from the 0.1° PaleoDEM; animals with a fossil within 150 km.</div>
          <div class="prov"><span class="sw sw-inferred" /> <strong>inferred</strong>: derived by a stated rule. Biomes from modelled climate; taxa borrowed from further away; 20 m or more of invented relief.</div>
          <div class="prov"><span class="sw sw-generated" /> <strong>generated</strong>: invented to fill gaps. 60 m or more of invented relief, invented coastlines, colours, poses, sky.</div>
          <p class="legend-note">Colours never carry meaning alone: inferred is dotted and generated is hatched. Focus mode (Shift+P) lights up one flag; evidence mode shows how far the nearest fossil is.</p>
          <h3>Good to know</h3>
          <ul class="credits">
            <li>Each slice is a 5-million-year snapshot; the world doesn't change between slices.</li>
            <li>Fossils say who lived nearby, not how many: numbers come from body size. Representative fauna (in settings and the field guide) shows one group of every taxon with nearby fossils.</li>
            <li>Plant and animal shapes are generic body plans, not species anatomy.</li>
          </ul>
          <p><button type="button" class="secondary" onClick={onAbout}>About &amp; credits</button></p>
        </div>
      </div>
    </Shell>
  );
}

// ------------------------------------------------------------------ §4 settings

export function SettingsPanel({ value, onChange, onClose }: { value: Settings; onChange: (s: Settings) => void; onClose: () => void }) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    const s = { ...value, [k]: v };
    saveSettings(s);
    if (k === "textScale") applyTextScale(v as number);
    onChange(s);
  };
  return (
    <Shell title="Settings" onClose={onClose}>
      <div class="settings">
        <h3>Graphics</h3>
        <label class="row">Detail
          <select value={value.detail} onChange={(e) => set("detail", (e.target as HTMLSelectElement).value as Detail)}>
            <option value="high">High: full plant distance, sharp on high-DPI screens</option>
            <option value="medium">Medium: plants to 80% distance</option>
            <option value="low">Low: plants to 55% distance, standard resolution</option>
          </select></label>
        <label class="check"><input type="checkbox" checked={value.shadows} onChange={(e) => set("shadows", (e.target as HTMLInputElement).checked)} /> Sun shadows (L) <span class="muted">— turn off on slower computers</span></label>
        <h3>Ecology</h3>
        <label class="check"><input type="checkbox" checked={value.representativeFauna} onChange={(e) => set("representativeFauna", (e.target as HTMLInputElement).checked)} /> Representative fauna
          <span class="muted"> — show one group of every taxon with fossils within 150 km, even where it would be too rare to appear (flagged "density boosted"). Off gives realistic densities: most tiles hold no large predator.</span></label>
        <h3>Controls</h3>
        <label class="row">Mouse sensitivity <input type="range" min={0.25} max={3} step={0.05} value={value.mouseSensitivity}
          onInput={(e) => set("mouseSensitivity", Number((e.target as HTMLInputElement).value))} aria-valuetext={`${value.mouseSensitivity.toFixed(2)}×`} />
          <span class="muted">{value.mouseSensitivity.toFixed(2)}×</span></label>
        <label class="check"><input type="checkbox" checked={value.invertY} onChange={(e) => set("invertY", (e.target as HTMLInputElement).checked)} /> Invert vertical look</label>
        <h3>Display</h3>
        <label class="row">Text size
          <select value={String(value.textScale)} onChange={(e) => set("textScale", Number((e.target as HTMLSelectElement).value))}>
            <option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option>
          </select></label>
        <label class="check"><input type="checkbox" checked={value.reducedMotion} onChange={(e) => set("reducedMotion", (e.target as HTMLInputElement).checked)} /> Reduced motion <span class="muted">— no wind sway; the globe stops turning on its own after a reload</span></label>
        <p class="legend-note">Settings are kept in this browser only.</p>
      </div>
    </Shell>
  );
}
