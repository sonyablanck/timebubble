import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { OVERLAY_COLOURS } from "../render/materials";
import { fmtHours, fmtLat, fmtLon, fmtM, type InfoCard, type PlayerState, type TileEcologyView, type WalkRenderer } from "../render/walk";
import { fmtArea, PLAN_INFO, type TaxonEntry } from "../ecology/roster";
import { PLANT_NAMES, topPlants } from "../biome/plants";
import { F } from "../provenance/flags";

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

export function WalkHud({ walk, sliceLabel, onBack }: { walk: WalkRenderer; sliceLabel: string; onBack: () => void }) {
  const [s, setS] = useState<PlayerState | null>(null);
  const [card, setCard] = useState<InfoCard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(true);
  const [guideOpen, setGuideOpen] = useState(false);
  const [eco, setEco] = useState<TileEcologyView | null>(null);
  const [repFauna, setRepFauna] = useState(walk.representativeFauna);

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
    const onKey = (e: KeyboardEvent) => { if (e.code === "KeyG" && !(e.target as HTMLElement)?.closest?.("input, textarea")) setGuideOpen((v) => !v); };
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, [walk]);

  if (!s) return null;
  const ground = s.groundM;
  return (
    <div class="hud walk-hud">
      <header class="hud-top">
        <h1 class="slice-label">{sliceLabel}</h1>
      </header>

      <div class="crosshair" aria-hidden="true" />
      <Compass heading={s.headingDeg} />

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
            <dt>Esc</dt><dd>release mouse; again for the globe</dd>
          </dl>
        </section>
      )}

      {s.overlay && (
        <section class="panel walk-legend" aria-label="Provenance legend">
          <h2>Provenance</h2>
          <div class="prov"><span class="sw sw-data" /> data: surface from the 0.1° PaleoDEM</div>
          <div class="prov"><span class="sw sw-inferred" /> inferred: blend, partly invented relief</div>
          <div class="prov"><span class="sw sw-generated" /> generated: invented detail or coastline</div>
          <p class="legend-note">On the ground, the tint shows the terrain's shape; ground cover (biomes) is always inferred. Plants and animals are tinted by their own evidence: data if fossils of that kind are nearby, otherwise inferred. Sea surface, sky and light are generated (not tinted).</p>
        </section>
      )}

      {notice && <p class="panel walk-notice" role="status">{notice}</p>}

      {card && <Card card={card} onClose={() => setCard(null)} />}

      {guideOpen && (
        <FieldGuide eco={eco} repFauna={repFauna} onClose={() => setGuideOpen(false)}
          onRepFauna={(on) => { setRepFauna(on); walk.setRepresentativeFauna(on); }} />
      )}
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

function FieldGuide({ eco, repFauna, onRepFauna, onClose }: {
  eco: TileEcologyView | null; repFauna: boolean; onRepFauna: (on: boolean) => void; onClose: () => void;
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
            Fossils decide who is present; how many comes from body size (Damuth 1981; Marshall et al. 2021).
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
                {list.map((r) => <TaxonRow key={r.key} r={r} placed={placed.get(r.key) ?? 0} />)}
              </ul>
            </div>
          ))}
        </>
      )}
      <div class="guide-group">
        <h3>Plants (expected mix)</h3>
        <p>{topPlants(eco.plantMix, 7).map(([k, v]) => `${PLANT_NAMES[k]} ${Math.round(v * 100)}%`).join(" · ")}</p>
        <p class="legend-note">{eco.plantMix.evidence?.count ? `${eco.plantMix.evidence.count} plant occurrences within 500 km` : "age-aware prior (no nearby plant fossils)"} · {e.plants.count.toLocaleString("en-GB")} plants placed</p>
      </div>
      <div class="buttons"><button type="button" class="secondary" onClick={onClose}>Close</button></div>
    </section>
  );
}

function TaxonRow({ r, placed }: { r: TaxonEntry; placed: number }) {
  const info = PLAN_INFO[r.bodyPlan];
  const boosted = (r.flags & F.DENSITY_BOOSTED) !== 0;
  return (
    <li>
      <strong><em>{r.name}</em></strong>{r.rank !== "genus" && <span class="muted"> ({r.rank})</span>}
      <span class={`badge badge-${r.source}`}>{r.source}</span>
      {boosted && <span class="badge badge-generated">density boosted</span>}
      <span class="muted"> · {!info.rendered || r.note?.startsWith("Identified only") ? "not drawn" : placed > 0
        ? `${placed} placed${r.count > placed ? ` (of ~${r.count} expected; over budget)` : ""}` : r.count > 0 ? `~${r.count} expected; over budget` : "none on this tile"}</span>
      <div class="taxon-detail">
        {r.evidence.count} occurrence{r.evidence.count === 1 ? "" : "s"}, nearest {Math.round(r.evidence.nearestKm)} km
        {r.evidence.straddlesKpg && " · age range crosses the K–Pg boundary"}
        {" · "}realistic density ≈ 1 per {fmtArea(1 / Math.max(r.realisticPerKm2, 1e-9))}
        {" · "}{r.lengthM} m long ({r.lengthSource === "rule" ? "rule" : "body-plan default"}), ~{r.massKg.toLocaleString("en-GB")} kg (estimated)
        {r.note && <> · {r.note}</>}
        {" · "}<a href={pbdbOcc(r.evidence.occurrenceIds[0]!)} target="_blank" rel="noopener">PBDB occurrence</a>
        {r.evidence.refIds[0] !== undefined && <>{" · "}<a href={pbdbRef(r.evidence.refIds[0])} target="_blank" rel="noopener">reference</a></>}
      </div>
    </li>
  );
}
