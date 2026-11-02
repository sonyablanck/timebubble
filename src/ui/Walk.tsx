import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { OVERLAY_COLOURS } from "../render/materials";
import { FOCUS_FLAGS, fmtCount, fmtDensity, fmtHours, fmtLat, fmtLon, fmtM, type InfoCard, type LocateStatus, type LocateTarget, type OverlayMode, type PlayerState, type TileEcologyView, type WalkRenderer } from "../render/walk";
import { PLAN_INFO, presenceLabel, presencePct, type TaxonEntry } from "../ecology/roster";
import { PLANT_NAMES, topPlants } from "../biome/plants";
import { F, FLAG_INFO, type FlagName } from "../provenance/flags";
import { composePhoto, downloadCanvas, photoFileName } from "./photo";
import { citeThisView, reportCsv, reportJson, type ProvenanceReport } from "../provenance/report";

// ui/ §2 (loading screen) and §3 (walk HUD): slice label, position, compass, crosshair, key hints,
// provenance legend, the "ground colour is elevation and slope only" note, info cards, back button.

export function LoadingScreen({ label, fraction, sliceLabel, place }: { label: string; fraction: number; sliceLabel: string; place: string }) {
  return (
    <div class="loading-screen" role="status" aria-live="polite">
      <h2>{sliceLabel}</h2>
      <p class="muted">{place}</p>
      <div class="progress" aria-hidden="true"><div style={{ width: `${Math.round(fraction * 100)}%` }} /></div>
      <p>{label}…</p>
    </div>
  );
}

export function WalkHud({ walk, sliceLabel, onBack, makeReport }: { walk: WalkRenderer; sliceLabel: string; onBack: () => void; makeReport?: () => Promise<ProvenanceReport> }) {
  const [s, setS] = useState<PlayerState | null>(null);
  const [card, setCard] = useState<InfoCard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(true);
  const [guideOpen, setGuideOpen] = useState(false);
  const [eco, setEco] = useState<TileEcologyView | null>(null);
  const [repFauna, setRepFauna] = useState(walk.representativeFauna);
  const [citeOpen, setCiteOpen] = useState(false);
  const [photo, setPhoto] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    walk.onState(setS);
    walk.onCard(setCard);
    walk.onNotice((m) => {
      setNotice(m);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setNotice(null), 6000);
    });
    setS(walk.debug.state());
    walk.onEcology(setEco);
    setEco(walk.currentEcology());
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.code === "KeyG") setGuideOpen((v) => !v);
      if (e.code === "KeyR" && !e.ctrlKey && !e.metaKey) setCiteOpen((v) => !v);   // C already flies down
      if (e.code === "KeyK" && !e.ctrlKey && !e.metaKey) setPhoto((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, [walk]);

  useEffect(() => {
    document.body.classList.toggle("photo-mode", photo);
    return () => document.body.classList.remove("photo-mode");
  }, [photo]);

  if (!s) return null;
  if (photo) return <PhotoBar walk={walk} s={s} sliceLabel={sliceLabel} makeReport={makeReport} onExit={() => setPhoto(false)} />;
  const ground = s.groundM;
  return (
    <div class="hud walk-hud">
      <header class="hud-top">
        <h1 class="slice-label">{sliceLabel}</h1>
      </header>

      <div class="crosshair" aria-hidden="true" />
      <Compass heading={s.headingDeg} />
      {s.locate && <LocateChip st={s.locate} heading={s.headingDeg} onStop={() => walk.locate(null)} onGo={() => walk.goToLocated()} />}

      <section class="panel walk-status" aria-label="Position">
        <dl class="readout-list">
          <dt>Position</dt><dd>{fmtLat(s.lat)}, {fmtLon(s.lon)} <span class="muted">palaeo</span></dd>
          <dt>Ground</dt><dd>{ground === null ? "loading…" : fmtM(ground)}</dd>
          <dt>Eye</dt><dd>{fmtM(s.altitudeM)}{s.mode === "fly" && ground !== null && <span class="muted"> · {fmtM(s.altitudeM - Math.max(0, ground))} up</span>}</dd>
          <dt>Mode</dt><dd>{s.mode === "fly" ? <strong class="flying">Flying · {s.flySpeed.toFixed(0)} m/s</strong> : "Walking"}</dd>
          <dt>Sun</dt><dd>{fmtHours(s.hours)} <span class="muted">equinox</span></dd>
          <dt>Terrain</dt><dd>{s.tiles.ready}/{s.tiles.wanted} tiles{s.tiles.current === "coarse" && <span class="muted"> · refining</span>}</dd>
          <dt>Life</dt><dd>{s.plants.toLocaleString("en-GB")} plants · {s.animals} animals <span class="muted">(G: field guide)</span></dd>
        </dl>
        {s.aftermath && <p class="aftermath-badge">{s.aftermath.phase === "impactWinter" ? `Aftermath: Impact Winter, year ${s.aftermath.year}` : "Aftermath: Fern Spike"}</p>}
        <p class="legend-note">Ground colour shows modelled biomes (inferred). Plants and animals are generic body-plan models; click one to see its evidence.</p>
        <div class="buttons">
          <button type="button" onClick={onBack}>Back to globe</button>
          <button type="button" class="secondary" onClick={() => setHelpOpen(!helpOpen)} aria-expanded={helpOpen}>Keys</button>
          <button type="button" class="secondary" onClick={() => setGuideOpen(!guideOpen)} aria-expanded={guideOpen}>Field guide</button>
          {makeReport && <button type="button" class="secondary" onClick={() => setCiteOpen(!citeOpen)} aria-expanded={citeOpen}>Cite</button>}
          <button type="button" class="secondary" onClick={() => setPhoto(true)}>Photo</button>
        </div>
      </section>

      {helpOpen && (
        <section class="panel walk-keys" aria-label="Controls">
          <h2>Controls</h2>
          <dl class="readout-list compact">
            <dt>Click</dt><dd>capture the mouse; then click to inspect</dd>
            <dt>W A S D</dt><dd>move (Shift: run)</dd>
            <dt>Space</dt><dd>hop; up when flying (C: down)</dd>
            <dt>F</dt><dd>fly / walk (wheel: flight speed)</dd>
            <dt>P</dt><dd>provenance overlay</dd>
            <dt>G</dt><dd>field guide: who lives here</dd>
            <dt>I</dt><dd>inspect what's under the crosshair</dd>
            <dt>[ ]</dt><dd>time of day</dd>
            <dt>L</dt><dd>shadows on / off (off is faster)</dd>
            <dt>Shift+P</dt><dd>overlay mode: source, focus, evidence</dd>
            <dt>R</dt><dd>cite this view; provenance report</dd>
            <dt>K</dt><dd>photo mode: hide the interface, save a captioned PNG</dd>
            <dt>Esc</dt><dd>release mouse; again for the globe</dd>
          </dl>
        </section>
      )}

      {s.overlay && <OverlayLegend s={s} walk={walk} />}

      {notice && <p class="panel walk-notice" role="status">{notice}</p>}

      {card && <Card card={card} onClose={() => setCard(null)} />}

      {citeOpen && makeReport && <CiteDialog makeReport={makeReport} onClose={() => setCiteOpen(false)} />}

      {guideOpen && (
        <FieldGuide eco={eco} repFauna={repFauna} onClose={() => setGuideOpen(false)}
          locating={s.locate?.name ?? null}
          onLocate={(t) => { const st = walk.locate(t); if (st?.found) setGuideOpen(false); }}
          onRepFauna={(on) => { setRepFauna(on); walk.setRepresentativeFauna(on); }} />
      )}
    </div>
  );
}

/** ui §6b: photo mode. Only this bar is drawn; the saved PNG has the citation burnt in. */
function PhotoBar({ walk, s, sliceLabel, makeReport, onExit }: { walk: WalkRenderer; s: PlayerState; sliceLabel: string; makeReport?: () => Promise<ProvenanceReport>; onExit: () => void }) {
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = makeReport ? await makeReport() : null;
      const caption = r ? citeThisView(r) : `Time Bubble, ${sliceLabel}, ${fmtLat(s.lat)} ${fmtLon(s.lon)} (palaeo-coordinates).`;
      const img = composePhoto(walk.snapshot(), caption);
      await downloadCanvas(img, photoFileName(r?.view.slice_ma ?? 0, s.lat, s.lon));
    } finally { setBusy(false); }
  };
  return (
    <div class="hud walk-hud photo-hud">
      <div class="panel photo-bar" role="toolbar" aria-label="Photo mode">
        <span class="muted">Photo mode · K to return</span>
        <button type="button" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save PNG"}</button>
        <button type="button" class="secondary" onClick={onExit}>Done</button>
      </div>
    </div>
  );
}

/** provenance §5 / ui §6: "Cite this view", the link, and the provenance report (JSON or CSV). */
function CiteDialog({ makeReport, onClose }: { makeReport: () => Promise<ProvenanceReport>; onClose: () => void }) {
  const [r, setR] = useState<ProvenanceReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { makeReport().then(setR).catch((e) => setErr(String(e))); }, []);
  const copy = (what: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => setCopied(what)).catch(() => setCopied(null));
  };
  const save = (ext: "json" | "csv") => {
    if (!r) return;
    const blob = new Blob([ext === "json" ? reportJson(r) : reportCsv(r)], { type: ext === "json" ? "application/json" : "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `time-bubble-${r.view.slice_ma}Ma-${r.view.palaeo_lat.toFixed(2)}_${r.view.palaeo_lon.toFixed(2)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const cite = r ? citeThisView(r) : "";
  return (
    <section class="panel cite-dialog" role="dialog" aria-label="Cite this view">
      <h2>Cite this view</h2>
      {err && <p class="muted">Couldn't build the report: {err}</p>}
      {!r && !err && <p class="muted">Gathering sources…</p>}
      {r && <>
        <textarea readOnly rows={7} aria-label="Citation" value={cite} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />
        <div class="buttons">
          <button type="button" onClick={() => copy("citation", cite)}>{copied === "citation" ? "Copied" : "Copy citation"}</button>
          <button type="button" class="secondary" onClick={() => copy("link", r.view.link)}>{copied === "link" ? "Copied" : "Copy link"}</button>
        </div>
        <p class="legend-note">The link reopens this place, slice, view direction, flight, overlay and settings. The provenance report lists the datasets and versions, climate sources, every taxon here with its PBDB occurrence and reference IDs, flags and levels, the plant mix, the in-view shares and full references. Nothing leaves your browser.</p>
        <div class="buttons">
          <button type="button" class="secondary" onClick={() => save("json")}>Download report (JSON)</button>
          <button type="button" class="secondary" onClick={() => save("csv")}>Taxa (CSV)</button>
        </div>
        <p class="legend-note">{r.taxa.length} taxa · {r.references.length} references · data {r.data.data_version}</p>
      </>}
      <div class="buttons"><button type="button" class="secondary" onClick={onClose}>Close</button></div>
    </section>
  );
}

const MODE_LABELS: Record<Exclude<OverlayMode, "off">, string> = { source: "Source", focus: "Focus", evidence: "Evidence" };

/** Provenance legend (provenance §3c): mode switch, swatches for the mode, focus flag, in-view shares. */
function OverlayLegend({ s, walk }: { s: PlayerState; walk: WalkRenderer }) {
  const mode = s.overlayMode === "off" ? "source" : s.overlayMode;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <section class="panel walk-legend" aria-label="Provenance legend">
      <h2>Provenance</h2>
      <div class="seg" role="radiogroup" aria-label="Overlay mode">
        {(Object.keys(MODE_LABELS) as (keyof typeof MODE_LABELS)[]).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} class={mode === m ? "on" : ""}
            onClick={() => walk.setOverlayMode(m)}>{MODE_LABELS[m]}</button>
        ))}
      </div>
      {mode === "source" && <>
        <div class="prov"><span class="sw sw-data" /> data: surface from the 0.1° PaleoDEM; taxa with fossils within 150 km</div>
        <div class="prov"><span class="sw sw-inferred" /> inferred: 20 m or more of invented relief; biomes; borrowed taxa</div>
        <div class="prov"><span class="sw sw-generated" /> generated: 60 m or more of invented relief, or an invented coastline</div>
        <p class="legend-note">A pale line marks where the coastline is invented. Sea surface, sky and light are generated (not tinted).</p>
      </>}
      {mode === "focus" && <>
        <label class="focus-pick">Show <select aria-label="Flag to focus on" value={s.focusFlag}
          onChange={(e) => walk.setOverlayMode("focus", (e.target as HTMLSelectElement).value as FlagName)}>
          {FOCUS_FLAGS.map((f) => <option key={f} value={f}>{FLAG_INFO[f].short}</option>)}
        </select></label>
        <div class="prov"><span class="sw sw-focus" /> has this flag · everything else is greyed out</div>
        <p class="legend-note">{FLAG_INFO[s.focusFlag].long}</p>
      </>}
      {mode === "evidence" && <>
        <div class="prov"><span class="sw sw-data" /> a fossil site within 25 km</div>
        <div class="prov"><span class="sw sw-inferred" /> nearest fossil 25–150 km away</div>
        <div class="prov"><span class="sw sw-generated" /> nearest fossil over 150 km away</div>
        {s.nearestSiteKm !== null && <p class="shares"><strong>Nearest fossil site:</strong> {s.nearestSiteKm < 10 ? s.nearestSiteKm.toFixed(1) : Math.round(s.nearestSiteKm)} km from you</p>}
        <p class="legend-note">Distance from the ground to the nearest Paleobiology Database site used for this area: where the record is thin, more of what you see is inferred.</p>
      </>}
      {s.shares && mode === "source" && (
        <p class="shares" aria-live="polite"><strong>In view:</strong> {pct(s.shares.data)} data · {pct(s.shares.inferred)} inferred · {pct(s.shares.generated)} generated
          <span class="muted"> (share of what you can see: ground, plants and animals; the sea counts by its floor)</span></p>
      )}
      <p class="legend-note">P: overlay on/off · Shift+P: next mode · R: cite this view and download the report</p>
    </section>
  );
}

/** Field guide "Locate": what is being located, how far, and an arrow pointing to it. */
function LocateChip({ st, heading, onStop, onGo }: { st: LocateStatus; heading: number; onStop: () => void; onGo: () => void }) {
  const rel = ((st.bearingDeg - heading + 540) % 360) - 180;
  const near = st.distanceM < 25;
  const dist = st.distanceM < 1000 ? `${Math.round(st.distanceM)} m` : `${(st.distanceM / 1000).toFixed(1)} km`;
  const side = Math.abs(rel) < 12 ? "ahead" : Math.abs(rel) > 150 ? "behind you" : rel > 0 ? "to your right" : "to your left";
  return (
    <div class="panel locate-chip" role="status" aria-live="polite">
      {st.found ? (
        <>
          <span class="locate-arrow" aria-hidden="true" style={{ transform: `rotate(${rel}deg)` }}>↑</span>
          <span><strong><em>{st.name}</em></strong> · {dist} {near ? <span class="muted">(here: click it to see its card)</span> : <span class="muted">{side}</span>}</span>
        </>
      ) : <span><em>{st.name}</em> <span class="muted">· searching…</span></span>}
      {st.found && st.distanceM > 40 && <button type="button" class="small" onClick={onGo}>Take me there</button>}
      <button type="button" class="secondary small" onClick={onStop}>Stop</button>
    </div>
  );
}

function Compass({ heading }: { heading: number }) {
  const labels: [number, string][] = [[0, "N"], [45, "NE"], [90, "E"], [135, "SE"], [180, "S"], [225, "SW"], [270, "W"], [315, "NW"]];
  return (
    <div class="compass" aria-label={`Heading ${Math.round(heading)}°`} role="img">
      <div class="compass-strip">
        {labels.map(([deg, l]) => {
          const d = ((deg - heading + 540) % 360) - 180;
          if (Math.abs(d) > 70) return null;
          return <span key={l} style={{ left: `${50 + (d / 70) * 50}%` }} class={l.length === 1 ? "major" : ""}>{l}</span>;
        })}
      </div>
      <div class="compass-deg">{Math.round(heading) % 360}°</div>
    </div>
  );
}

function Card({ card, onClose }: { card: InfoCard; onClose: () => void }) {
  return (
    <section class="panel info-card" aria-label={`${card.title}: info card`}>
      <h2>
        {card.title}
        <span class={`badge badge-${card.levelName}`}>{card.levelName}</span>
      </h2>
      {card.lat !== undefined && <p class="muted">{fmtLat(card.lat)}, {fmtLon(card.lon!)} · palaeo</p>}
      <dl class="readout-list">
        {card.lines.map((l) => <Fragment key={l.label}><dt>{l.label}</dt><dd>{l.value}</dd></Fragment>)}
      </dl>
      {card.links && card.links.length > 0 && (
        <p class="card-links">{card.links.map((l, i) => <span key={l.url}>{i > 0 && " · "}<a href={l.url} target="_blank" rel="noopener">{l.label}</a></span>)}</p>
      )}
      {card.flags.length > 0 && (
        <ul class="flags">
          {card.flags.map((f) => (
            <li key={f.name}><strong>{f.short}.</strong> {f.long}{f.refs.length > 0 && <span class="muted"> [{f.refs.join(", ")}]</span>}</li>
          ))}
        </ul>
      )}
      <div class="buttons"><button type="button" class="secondary" onClick={onClose}>Close</button></div>
    </section>
  );
}

export const LEVEL_SWATCHES = OVERLAY_COLOURS;

// ------------------------------------------------------------------ field guide (ui/ §3)

const pbdbOcc = (id: number) => `https://paleobiodb.org/data1.2/occs/single.json?id=${id}&show=class,coords,env`;
const pbdbRef = (id: number) => `https://paleobiodb.org/data1.2/refs/single.json?id=${id}&show=both`;

function FieldGuide({ eco, repFauna, onRepFauna, onClose, onLocate, locating }: {
  eco: TileEcologyView | null; repFauna: boolean; onRepFauna: (on: boolean) => void; onClose: () => void;
  onLocate: (t: LocateTarget) => void; locating: string | null;
}) {
  const [filter, setFilter] = useState<"all" | "data" | "inferred">("all");
  if (!eco) return <section class="panel field-guide" aria-label="Field guide"><h2>Field guide</h2><p class="muted">Loading this tile…</p></section>;
  const e = eco.ecology;
  const rows = e.roster.filter((r) => filter === "all" || r.source === filter);
  const groups = new Map<string, TaxonEntry[]>();
  for (const r of rows) groups.set(r.planLabel, [...(groups.get(r.planLabel) ?? []), r]);
  const placed = new Map<string, number>();
  for (const a of e.animals) { const k = e.roster[a.taxon]!.key; placed.set(k, (placed.get(k) ?? 0) + 1); }
  const nData = e.roster.filter((r) => r.source === "data").length;
  return (
    <section class="panel field-guide" aria-label="Field guide">
      <h2>Field guide <span class="muted">· this 4 km tile, {eco.sliceAge} Ma</span></h2>
      {!e.available ? <p class="muted">No fossil data for this slice yet.</p> : (
        <>
          <p class="legend-note">
            {e.roster.length} taxa: {nData} with fossils within 150 km (<em>data</em>){e.roster.length > nData && <>, {e.roster.length - nData} borrowed from up to 750 km (<em>inferred</em>)</>}.
            Fossils decide who is present; how dense each would be comes from body size (Damuth 1981; Marshall et al. 2021), and how likely it was right here from how near, well-dated and environment-matched its fossils are (provisional).
            {" "}{e.animals.length} animals placed on this tile (budget 80, largest first). Each is drawn as a generic body-plan model.
          </p>
          <div class="guide-controls">
            <label class="check"><input type="checkbox" checked={repFauna} onChange={(ev) => onRepFauna((ev.target as HTMLInputElement).checked)} />
              Representative fauna <span class="muted">(show one group of each taxon with nearby fossils)</span></label>
            <select aria-label="Filter by source" value={filter} onChange={(ev) => setFilter((ev.target as HTMLSelectElement).value as typeof filter)}>
              <option value="all">all</option><option value="data">data only</option><option value="inferred">inferred only</option>
            </select>
          </div>
          {[...groups.entries()].map(([label, list]) => (
            <div key={label} class="guide-group">
              <h3>{label}</h3>
              <ul>
                {list.map((r) => <TaxonRow key={r.key} r={r} placed={placed.get(r.key) ?? 0} onLocate={onLocate} locating={locating === r.name} />)}
              </ul>
            </div>
          ))}
        </>
      )}
      <div class="guide-group">
        <h3>Plants (expected mix)</h3>
        <ul class="plant-list">
          {topPlants(eco.plantMix, 7).map(([k, v]) => {
            const name = PLANT_NAMES[k].charAt(0).toUpperCase() + PLANT_NAMES[k].slice(1);
            return (
              <li key={k}>{name} <span class="muted">{Math.round(v * 100)}%</span>
                <button type="button" class="secondary small" onClick={() => onLocate({ kind: "plant", plan: k, name })}
                  aria-label={`Locate the nearest ${PLANT_NAMES[k]}`}>Locate</button></li>
            );
          })}
          {hasSnags(eco) && <li>Dead trees <span class="muted">(Aftermath)</span>
            <button type="button" class="secondary small" onClick={() => onLocate({ kind: "plant", plan: "snag", name: "Dead tree" })}
              aria-label="Locate the nearest dead tree">Locate</button></li>}
        </ul>
        <p class="legend-note">{eco.plantMix.evidence?.count ? `${eco.plantMix.evidence.count} plant occurrences within 500 km` : "age-aware prior (no nearby plant fossils)"} · {e.plants.count.toLocaleString("en-GB")} plants placed</p>
      </div>
      <div class="buttons"><button type="button" class="secondary" onClick={onClose}>Close</button></div>
    </section>
  );
}

function hasSnags(eco: TileEcologyView): boolean {
  const p = eco.ecology.plants;
  for (let k = 0; k < p.count; k++) if (!p.alive[k]) return true;
  return false;
}

function TaxonRow({ r, placed, onLocate, locating }: { r: TaxonEntry; placed: number; onLocate: (t: LocateTarget) => void; locating: boolean }) {
  const info = PLAN_INFO[r.bodyPlan];
  const boosted = (r.flags & F.DENSITY_BOOSTED) !== 0;
  const drawn = info.rendered && !r.note?.startsWith("Identified only");
  return (
    <li>
      <strong><em>{r.name}</em></strong>{r.rank !== "genus" && <span class="muted"> ({r.rank})</span>}
      <span class={`badge badge-${r.source}`}>{r.source}</span>
      {boosted && <span class="badge badge-generated">density boosted</span>}
      {drawn && <button type="button" class="secondary small locate-btn" disabled={locating}
        onClick={() => onLocate({ kind: "animal", key: r.key, name: r.name })} aria-label={`Locate the nearest ${r.name}`}>{locating ? "Locating" : "Locate"}</button>}
      <span class="muted"> · {!drawn ? "not drawn" : placed > 0
        ? `${placed} placed${r.count > placed ? ` (of ~${r.count} expected; over budget)` : ""}` : r.count > 0 ? `~${r.count} expected; over budget` : "none on this tile"}</span>
      <div class="taxon-detail">
        {r.evidence.count} occurrence{r.evidence.count === 1 ? "" : "s"}, nearest {Math.round(r.evidence.nearestKm)} km
        {r.evidence.straddlesKpg && " · age range crosses the K–Pg boundary"}
        {" · "}where it lived ≈ {fmtDensity(r.realisticPerKm2)}
        {" · "}presence here {presenceLabel(r.presence)} ({presencePct(r.presence)})
        {" · "}≈ {fmtCount(r.expected)} expected on this tile
        {" · "}{r.lengthM} m long ({r.lengthSource === "rule" ? "rule" : "body-plan default"}), ~{r.massKg.toLocaleString("en-GB")} kg (estimated)
        {r.note && <> · {r.note}</>}
        {" · "}<a href={pbdbOcc(r.evidence.occurrenceIds[0]!)} target="_blank" rel="noopener">PBDB occurrence</a>
        {r.evidence.refIds[0] !== undefined && <>{" · "}<a href={pbdbRef(r.evidence.refIds[0])} target="_blank" rel="noopener">reference</a></>}
      </div>
    </li>
  );
}
