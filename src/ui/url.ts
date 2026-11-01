import type { CameraView, GlobeLayer } from "../globe";

// ui/ §0 and provenance/ §5: the view lives in the URL, so a link reopens it.
// This covers the globe screen; walk-mode fields join when terrain/ exists.

export interface GlobeViewState {
  age: number;
  camera: CameraView;
  layers: GlobeLayer[];
  exaggeration: number;
  pin?: { lat: number; lon: number };
}

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
  return `?${q.toString()}`;
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
  return out;
}
