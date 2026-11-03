import type { CameraView, GlobeLayer } from "../globe";

// ui/ §0 and provenance/ §5: the view lives in the URL, so a link reopens it.
// The globe view always; in walk mode also where you stand, which way you look, flight, the
// overlay mode, the Aftermath phase and the representative-fauna setting (provenance §5).

export interface GlobeViewState {
  age: number;
  camera: CameraView;
  layers: GlobeLayer[];
  exaggeration: number;
  pin?: { lat: number; lon: number };
  /** A searched modern place (places/ §3): present-day coordinates and its name; the pin follows its plate. */
  place?: { name: string; lat: number; lon: number };
  walk?: WalkViewState;
}

export interface WalkViewState {
  lat: number; lon: number;          // palaeo-coordinates of the viewer
  headingDeg: number; pitchDeg: number;
  fly: boolean; altitudeM?: number;  // altitude only when flying (walking snaps to the ground)
  overlay: "off" | "source" | "focus" | "evidence";
  focus?: string;
  aftermath?: { phase: "impactWinter" | "fernSpike"; year: number } | null;
  representativeFauna: boolean;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const OVERLAYS = ["off", "source", "focus", "evidence"] as const;

const ALL_LAYERS: GlobeLayer[] = ["relief", "temperature", "precipitation", "fossils", "graticule", "provenance"];
const r2 = (x: number) => Math.round(x * 100) / 100;

export function viewToUrl(v: GlobeViewState): string {
  const q = new URLSearchParams();
  q.set("age", String(v.age));
  q.set("lat", String(r2(v.camera.lat)));
  q.set("lon", String(r2(v.camera.lon)));
  q.set("d", String(r2(v.camera.dist)));
  q.set("layers", ALL_LAYERS.filter((l) => v.layers.includes(l)).join(","));
  q.set("ex", String(Math.round(v.exaggeration)));
  if (v.pin) q.set("pin", `${r2(v.pin.lat)},${r2(v.pin.lon)}`);
  if (v.place) {
    q.set("place", `${r4(v.place.lat)},${r4(v.place.lon)}`);
    q.set("pn", v.place.name.slice(0, 80));
  }
  if (v.walk) {
    const w = v.walk;
    q.set("walk", `${r4(w.lat)},${r4(w.lon)}`);
    q.set("look", `${Math.round(w.headingDeg)},${Math.round(w.pitchDeg)}`);
    if (w.fly) q.set("fly", String(Math.round(w.altitudeM ?? 0)));
    if (w.overlay !== "off") q.set("ov", w.overlay === "focus" && w.focus ? `focus:${w.focus}` : w.overlay);
    if (w.aftermath) q.set("af", w.aftermath.phase === "impactWinter" ? `iw:${w.aftermath.year}` : "fs");
    if (!w.representativeFauna) q.set("rf", "0");
  }
  return `?${q.toString().replace(/%2C/g, ",")}`;   // commas are legal in a query; keep links readable
}

/** Parse a query string; anything missing or malformed is left out (callers use defaults). */
export function viewFromUrl(search: string): Partial<GlobeViewState> {
  const q = new URLSearchParams(search);
  const num = (k: string) => {
    const v = q.get(k);
    if (v === null || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: Partial<GlobeViewState> = {};
  const age = num("age");
  if (age !== undefined) out.age = age;
  const lat = num("lat"), lon = num("lon"), d = num("d");
  if (lat !== undefined && lon !== undefined && d !== undefined) out.camera = { lat, lon, dist: d };
  const layers = q.get("layers");
  if (layers !== null) out.layers = layers.split(",").filter((l): l is GlobeLayer => (ALL_LAYERS as string[]).includes(l));
  const ex = num("ex");
  if (ex !== undefined) out.exaggeration = ex;
  const pin = q.get("pin")?.split(",").map(Number);
  if (pin && pin.length === 2 && pin.every(Number.isFinite)) out.pin = { lat: pin[0]!, lon: pin[1]! };
  const place = q.get("place")?.split(",").map(Number);
  if (place && place.length === 2 && place.every(Number.isFinite) && Math.abs(place[0]!) <= 90 && Math.abs(place[1]!) <= 180) {
    out.place = { lat: place[0]!, lon: place[1]!, name: (q.get("pn") ?? "").trim().slice(0, 80) || `${place[0]}, ${place[1]}` };
  }
  const walk = q.get("walk")?.split(",").map(Number);
  if (walk && walk.length === 2 && walk.every(Number.isFinite) && Math.abs(walk[0]!) <= 90) {
    const look = (q.get("look") ?? "0,0").split(",").map(Number);
    const fly = num("fly");
    const ov = q.get("ov") ?? "off";
    const [ovMode, focus] = ov.split(":") as [string, string | undefined];
    const af = q.get("af");
    const iw = af?.startsWith("iw:") ? Number(af.slice(3)) : NaN;
    out.walk = {
      lat: walk[0]!, lon: walk[1]!,
      headingDeg: Number.isFinite(look[0]) ? look[0]! : 0, pitchDeg: Number.isFinite(look[1]) ? Math.max(-89, Math.min(89, look[1]!)) : 0,
      fly: fly !== undefined, ...(fly !== undefined ? { altitudeM: fly } : {}),
      overlay: (OVERLAYS as readonly string[]).includes(ovMode) ? ovMode as WalkViewState["overlay"] : "off",
      ...(focus ? { focus } : {}),
      aftermath: af === "fs" ? { phase: "fernSpike", year: 0 } : Number.isFinite(iw) ? { phase: "impactWinter", year: Math.max(0, Math.min(30, iw)) } : null,
      representativeFauna: q.get("rf") !== "0",
    };
  }
  return out;
}
