import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ClimateMeta, DataStore } from "../data";
import { ariaText, palette, type Globe, type GlobeLayer, type HoverInfo, type Timeline } from "../globe";
import { GROUP_COLOURS } from "../globe/fossils";
import { formatCoast, formatElevation, formatLatLon, formatPrecip } from "./format";
import { viewToUrl, type WalkViewState } from "./url";
import { buildReport, type ProvenanceReport } from "../provenance/report";
import type { WalkRenderer } from "../render/walk";
import type { Aftermath } from "../biome/climate";
import { LoadingScreen, WalkHud } from "./Walk";
import { About, Help, Intro, SettingsPanel, type PanelKind } from "./Panels";
import { applyTextScale, loadSettings, markIntroSeen, seenIntro, type Settings } from "./settings";

// ui/ §1b (globe HUD), §9 (accessibility). A first slice of the UI module:
// slice label, time slider, layers, exaggeration, hover readout and "Walk here".

const LAYER_LABELS: Record<GlobeLayer, string> = {
  relief: "Relief",
  temperature: "Temperature",
  precipitation: "Precipitation",
  fossils: "Fossils",
  graticule: "Grid",
  provenance: "Provenance",
};
const TOGGLEABLE: GlobeLayer[] = ["temperature", "precipitation", "fossils", "graticule", "provenance"];

type Screen = { kind: "globe" } | { kind: "loading"; label: string; fraction: number; place: string } | { kind: "walk" };

export function App({ globe, store, getWalk, initialWalk }: { globe: Globe; store: DataStore; getWalk?: () => WalkRenderer; initialWalk?: WalkViewState }) {
  const [screen, setScreen] = useState<Screen>({ kind: "globe" });
  const [aftermath, setAftermath] = useState<Aftermath | null>(null);
  const timeline: Timeline = globe.timeline;
  const [index, setIndex] = useState(globe.currentIndex);
  const [layers, setLayers] = useState<GlobeLayer[]>(globe.getLayers());
  const [ex, setEx] = useState(globe.getExaggeration());
  const [hover, setHover] = useState<HoverInfo | null>(null);
  // a pin from the URL reopens its panel, so a shared link lands one click from walking
  const [picked, setPicked] = useState<HoverInfo | null>(() => { const p = globe.getPin(); return p ? globe.hoverInfo(p.lat, p.lon) : null; });
  const [notice, setNotice] = useState<string | null>(null);
  const [climate, setClimate] = useState<ClimateMeta | null>(null);
  const [fossilsAvailable, setFossilsAvailable] = useState<boolean | null>(null);
  const urlTimer = useRef<number | undefined>(undefined);
  const walking = useRef(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  // first visit, no view in the link: the intro (ui §1a)
  const [panel, setPanel] = useState<PanelKind | null>(() => (!seenIntro() && !initialWalk && !location.search.includes("age=") ? "intro" : null));

  const tick = timeline.ticks[index]!;

  /** The link for the current view: the globe, plus the walk view while walking (provenance §5). */
  const currentUrl = () => viewToUrl({
    age: globe.currentAge, camera: globe.getView(), layers: globe.getLayers(),
    exaggeration: globe.getExaggeration(), pin: picked ? { lat: picked.lat, lon: picked.lon } : undefined,
    ...(walking.current && getWalk ? { walk: getWalk().viewState() } : {}),
  });

  // keep the URL in step with the view (debounced, replaceState)
  const syncUrl = () => {
    window.clearTimeout(urlTimer.current);
    urlTimer.current = window.setTimeout(() => {
      const url = currentUrl();
      history.replaceState(null, "", url);
    }, 500);
  };

  useEffect(() => {
    globe.onHover(setHover);
    globe.onPick((info) => { setPicked(info); setNotice(null); });
    globe.onViewChange(() => syncUrl());
    globe.onFossilsLoaded((ok) => {
      setFossilsAvailable(ok);
      setPicked((p) => (p ? globe.hoverInfo(p.lat, p.lon) : p));   // refresh counts in the pinned panel
    });
    globe.onSliceChange((h) => {
      setIndex(globe.currentIndex);
      setClimate(null);
      h.climateMeta().then(setClimate).catch(() => setClimate(null));
      h.ecology().then((e) => {
        setFossilsAvailable(e.available);
        // the pinned panel was filled before the fossils loaded: refresh its counts
        setPicked((p) => (p ? globe.hoverInfo(p.lat, p.lon) : p));
      }).catch(() => setFossilsAvailable(false));
      syncUrl();
    });
    store.slice(globe.currentAge).then((h) => {
      h.climateMeta().then(setClimate).catch(() => undefined);
      h.ecology().then((e) => {
        setFossilsAvailable(e.available);
        // the pinned panel was filled before the fossils loaded: refresh its counts
        setPicked((p) => (p ? globe.hoverInfo(p.lat, p.lon) : p));
      }).catch(() => setFossilsAvailable(false));
    });
  }, []);

  useEffect(() => syncUrl(), [layers, ex, picked]);

  // refresh the picked point's values when the slice changes (same place, new world)
  useEffect(() => {
    if (picked) setPicked(globe.hoverInfo(picked.lat, picked.lon));
  }, [index]);

  const toggle = (l: GlobeLayer) => {
    globe.setLayer(l, !layers.includes(l));
    setLayers(globe.getLayers());
  };

  const showWalkCanvas = (on: boolean) => {
    document.getElementById("walk")?.toggleAttribute("hidden", !on);
    document.getElementById("globe")?.toggleAttribute("hidden", on);
    document.body.classList.toggle("walking", on);
  };

  const backToGlobe = () => {
    walking.current = false;
    syncUrl();
    showWalkCanvas(false);
    globe.setActive(true);
    setScreen({ kind: "globe" });
  };

  const walk = async () => {
    if (!picked) return;
    await enterWalk(picked.lat, picked.lon, null);
  };

  /** Enter walk mode at a palaeo-position; `view` restores a saved look, flight and overlay (from a link). */
  const enterWalk = async (lat: number, lon: number, view: WalkViewState | null) => {
    if (!getWalk) return;
    if (Math.abs(lat) > 89.5) return;
    const af = view ? (view.aftermath && globe.timeline.ticks[globe.currentIndex]!.afterExtinction ? view.aftermath : null) : (tick.afterExtinction ? aftermath : null);
    if (view) setAftermath(af);
    await globe.flyTo(lat, lon);
    globe.enterTile(lat, lon);
    const place = `${formatLatLon(lat, lon)} (palaeo)`;
    setScreen({ kind: "loading", label: "Starting the terrain generator", fraction: 0, place });
    globe.setActive(false);
    showWalkCanvas(true);
    const w = getWalk();
    w.setClimateParams(await store.slice(globe.currentAge).then((h) => h.climate()).catch(() => null));
    try {
      await w.enter({ sliceAge: globe.currentAge, lat, lon, aftermath: af },
        (label, fraction) => setScreen({ kind: "loading", label, fraction, place }));
      w.applySettings(settings);
      if (view) w.applyView(view);
      walking.current = true;
      setScreen({ kind: "walk" });
      syncUrl();
      (document.getElementById("walk") as HTMLCanvasElement | null)?.focus();
    } catch (e) {
      console.error(e);
      backToGlobe();
      setNotice(`Couldn't build this place: ${e instanceof Error ? e.message : e}`);
    }
  };

  useEffect(() => {
    applyTextScale(settings.textScale);
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.code === "KeyH" || e.key === "?") setPanel((p) => (p === "help" ? null : "help"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!getWalk) return;
    const w = getWalk();
    w.onExit(backToGlobe);
    // while walking, keep the link pointing at where you are (throttled by the debounce)
    let last = 0;
    w.onState(() => { const now = performance.now(); if (walking.current && now - last > 1000) { last = now; syncUrl(); } });
    if (initialWalk) void enterWalk(initialWalk.lat, initialWalk.lon, initialWalk);
  }, []);

  /** Everything the provenance report needs, gathered from the walk, the store and the URL. */
  const makeReport = async (): Promise<ProvenanceReport> => {
    const w = getWalk!();
    const st = w.debug.state();
    const v = w.viewState();
    const eco = w.currentEcology();
    const h = await store.slice(globe.currentAge);
    const [manifest, climate] = await Promise.all([store.manifest(), h.climateMeta().catch(() => null)]);
    return buildReport({
      view: {
        url: `${location.origin}${location.pathname}${currentUrl()}`,
        sliceAge: globe.currentAge, aftermath: st.aftermath, tile: eco?.tile ?? { row: 0, col: 0 },
        lat: v.lat, lon: v.lon, altitudeM: st.altitudeM, headingDeg: st.headingDeg, pitchDeg: st.pitchDeg, mode: st.mode,
        overlay: { mode: st.overlayMode, focus: st.overlayMode === "focus" ? st.focusFlag : null },
        representativeFauna: w.representativeFauna,
      },
      manifest: manifest as unknown as Parameters<typeof buildReport>[0]["manifest"],
      climate, roster: eco?.ecology.roster ?? [], plantMix: eco?.plantMix ?? null, shares: st.shares,
    });
  };


  const legend = useMemo(() => {
    if (layers.includes("temperature")) return { title: "Mean annual temperature (°C, model)", stops: palette.TEMPERATURE, meta: climate?.temp };
    if (layers.includes("precipitation")) return { title: "Mean annual precipitation (mm/yr, model)", stops: palette.PRECIPITATION, meta: climate?.precip };
    return null;
  }, [layers, climate]);

  const openPanel = (p: PanelKind) => {
    if (p === "settings" && getWalk && walking.current) {
      const w = getWalk();   // L and the field guide change these too: start from what's live
      setSettings((s) => ({ ...s, shadows: w.shadows, representativeFauna: w.representativeFauna }));
    }
    if (document.pointerLockElement) document.exitPointerLock();
    setPanel(p);
  };
  const changeSettings = (s: Settings) => {
    setSettings(s);
    if (getWalk && walking.current) getWalk().applySettings(s);
  };
  const panels = (
    <>
      <nav class="top-buttons" aria-label="Help and settings">
        <button type="button" class="secondary small" onClick={() => openPanel("help")} title="Help (H)">Help</button>
        <button type="button" class="secondary small" onClick={() => openPanel("settings")}>Settings</button>
        <button type="button" class="secondary small" onClick={() => openPanel("about")}>About &amp; credits</button>
      </nav>
      {panel === "intro" && <Intro onStart={() => { markIntroSeen(); setPanel(null); }} onAbout={() => { markIntroSeen(); setPanel("about"); }} />}
      {panel === "about" && <About store={store} age={tick.age} onClose={() => setPanel(null)} />}
      {panel === "help" && <Help onClose={() => setPanel(null)} onAbout={() => setPanel("about")} />}
      {panel === "settings" && <SettingsPanel value={settings} onChange={changeSettings} onClose={() => setPanel(null)} />}
    </>
  );

  if (screen.kind === "loading") {
    return <><div class="hud"><LoadingScreen label={screen.label} fraction={screen.fraction} sliceLabel={tick.label} place={screen.place} /></div>{panels}</>;
  }
  if (screen.kind === "walk" && getWalk) {
    return <><WalkHud walk={getWalk()} sliceLabel={tick.label} onBack={() => getWalk().exit()} makeReport={makeReport} />{panels}</>;
  }

  return (<>
    <div class="hud">
      <header class="hud-top">
        <h1 class="slice-label">
          <span class="period-swatch" style={{ background: palette.PERIOD_COLOURS[tick.period] }} aria-hidden="true" />
          {tick.label}
        </h1>
      </header>

      <section class="panel layers" aria-label="Map layers">
        <h2>Layers</h2>
        {TOGGLEABLE.map((l) => (
          <label key={l} class="check">
            <input type="checkbox" checked={layers.includes(l)} onChange={() => toggle(l)} />
            {LAYER_LABELS[l]}
            {l === "fossils" && fossilsAvailable === false && <span class="muted"> (not built yet)</span>}
          </label>
        ))}
        <label class="range">
          <span>Relief exaggerated ×{Math.round(ex)}</span>
          <input type="range" min={1} max={80} step={1} value={ex} aria-label="Vertical exaggeration"
            onInput={(e) => { const v = Number((e.target as HTMLInputElement).value); globe.setExaggeration(v); setEx(v); }} />
        </label>
        <div class="legend" aria-label="Elevation legend">
          <div class="legend-title">Elevation (m)</div>
          <div class="legend-bar" style={{ background: palette.cssGradient(palette.HYPSOMETRIC) }} />
          <div class="legend-scale"><span>0</span><span>4,200</span></div>
          <div class="legend-bar" style={{ background: palette.cssGradient(palette.BATHYMETRIC) }} />
          <div class="legend-scale"><span>0</span><span>6,000 below</span></div>
        </div>
        {legend && (
          <div class="legend">
            <div class="legend-title">{legend.title}</div>
            <div class="legend-bar" style={{ background: palette.cssGradient(legend.stops) }} />
            <div class="legend-scale"><span>{legend.stops[0]!.value}</span><span>{legend.stops[legend.stops.length - 1]!.value.toLocaleString("en-GB")}</span></div>
            {legend.meta && (
              <p class="legend-note">
                Source interval {legend.meta.source_age} Ma
                {legend.meta.age_mismatch_myr !== 0 && ` (${legend.meta.age_mismatch_myr > 0 ? "+" : ""}${legend.meta.age_mismatch_myr} Myr)`}.
                {legend.meta.override_reason && <> Substituted: {legend.meta.override_reason}</>}
              </p>
            )}
          </div>
        )}
        {layers.includes("fossils") && fossilsAvailable && (
          <div class="legend" aria-label="Fossil legend">
            <div class="legend-title">Fossils (PBDB): dot size ∝ √occurrences, colour = commonest group</div>
            {(Object.keys(GROUP_COLOURS) as (keyof typeof GROUP_COLOURS)[]).map((g) => (
              <div class="prov" key={g}><span class="sw" style={{ background: GROUP_COLOURS[g], borderRadius: "50%", width: "10px" }} /> {g === "other" ? "other animals (invertebrates, fish, mammals…)" : g}</div>
            ))}
            <p class="legend-note">Rotated to this slice with PALEOMAP v19o_r1d. Positions: data.</p>
          </div>
        )}
        {layers.includes("provenance") && (
          <div class="legend">
            <div class="legend-title">Provenance</div>
            <div class="prov"><span class="sw sw-data" /> data: relief</div>
            <div class="prov"><span class="sw sw-inferred" /> inferred: climate layers</div>
          </div>
        )}
      </section>

      <section class="panel readout" aria-live="polite" aria-label="Location readout">
        {hover ? <Readout info={hover} /> : <p class="muted">Hover over the globe. Click to pick a place.</p>}
      </section>

      {picked && (
        <section class="panel walk" aria-label="Walk here">
          <h2>{formatLatLon(picked.lat, picked.lon)} <span class="muted">(palaeo)</span></h2>
          <Readout info={picked} compact />
          {!picked.isLand && <p class="warn">Mostly water here: you'll start in flight (no swimming or underwater view yet).</p>}
          {Math.abs(picked.lat) > 89.5 && <p class="warn">Too close to the pole to walk.</p>}
          <div class="buttons">
            <button type="button" onClick={walk} disabled={Math.abs(picked.lat) > 89.5}>Walk here</button>
            <button type="button" class="secondary" onClick={() => { setPicked(null); globe.unpin(); setNotice(null); }}>Close</button>
          </div>
          {notice && <p class="notice">{notice}</p>}
        </section>
      )}

      <TimeSlider timeline={timeline} index={index} onChange={(i) => void globe.setSlice(timeline.ticks[i]!.age)}
        aftermath={aftermath} setAftermath={setAftermath} />
    </div>
    {panels}</>
  );
}

function Readout({ info, compact = false }: { info: HoverInfo; compact?: boolean }) {
  return (
    <dl class={compact ? "readout-list compact" : "readout-list"}>
      {!compact && <><dt>Position</dt><dd>{formatLatLon(info.lat, info.lon)} <span class="muted">palaeo</span></dd></>}
      <dt>Elevation</dt><dd>{formatElevation(info.elevationM)} <span class="badge badge-data">data</span></dd>
      <dt>Temperature</dt><dd>{info.temperatureC.toFixed(1)} °C <span class="badge badge-inferred">model</span></dd>
      <dt>Precipitation</dt><dd>{formatPrecip(info.precipitationMmYr)} <span class="badge badge-inferred">model</span></dd>
      <dt>Coast</dt><dd>{formatCoast(info.coastDistKm)}</dd>
      <dt>Fossils</dt>
      <dd>{info.fossilsAvailable
        ? (info.occurrencesInBin > 0 ? `${info.occurrencesInBin} in this 5° bin${info.topTaxa.length ? `: ${info.topTaxa.slice(0, 3).join(", ")}` : ""}` : "none in this 5° bin")
        : <span class="muted">not built yet</span>}</dd>
    </dl>
  );
}

function TimeSlider({ timeline, index, onChange, aftermath, setAftermath }: {
  timeline: Timeline; index: number; onChange: (i: number) => void;
  aftermath: Aftermath | null; setAftermath: (a: Aftermath | null) => void;
}) {
  const n = timeline.ticks.length;
  const tick = timeline.ticks[index]!;
  return (
    <section class="panel timeline" aria-label="Time">
      <div class="bands" aria-hidden="true">
        {timeline.bands.map((b) => (
          <div key={b.period} class={`band${b.afterExtinction ? " band--after" : ""}`}
            style={{ flexGrow: b.toIndex - b.fromIndex + 1, background: palette.PERIOD_COLOURS[b.period] }}>
            {b.afterExtinction ? "After" : b.period}
          </div>
        ))}
      </div>
      <input type="range" class="slider" min={0} max={n - 1} step={1} value={index}
        aria-label="Time slice" aria-valuetext={ariaText(tick)}
        onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
      <div class="slider-ends" aria-hidden="true">
        <span>{timeline.ticks[0]!.age} Ma</span>
        <span>{tick.age} Ma{tick.afterExtinction ? " · after the extinction" : ""}</span>
        <span>{timeline.ticks[n - 1]!.age} Ma</span>
      </div>
      {tick.afterExtinction && (
        <div class="aftermath">
          <label class="check">
            <input type="checkbox" checked={!!aftermath} onChange={(e) => setAftermath((e.target as HTMLInputElement).checked ? { phase: "impactWinter", year: 2 } : null)} />
            Aftermath of the impact <span class="muted">(applies when you walk)</span>
          </label>
          {aftermath && (
            <div class="aftermath-opts" role="group" aria-label="Aftermath phase">
              <label class="check"><input type="radio" name="phase" checked={aftermath.phase === "impactWinter"} onChange={() => setAftermath({ phase: "impactWinter", year: aftermath.year })} /> Impact Winter</label>
              <label class="check"><input type="radio" name="phase" checked={aftermath.phase === "fernSpike"} onChange={() => setAftermath({ phase: "fernSpike", year: aftermath.year })} /> Fern Spike</label>
              {aftermath.phase === "impactWinter" && (
                <label class="range inline">
                  <span>Year {aftermath.year}</span>
                  <input type="range" min={0} max={30} step={1} value={aftermath.year} aria-label="Years after the impact"
                    onInput={(e) => setAftermath({ phase: "impactWinter", year: Number((e.target as HTMLInputElement).value) })} />
                </label>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
