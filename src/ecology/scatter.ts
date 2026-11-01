// ecology §4: world-anchored placement. Candidate points live on a global jittered grid keyed
// by palaeo-coordinates, each cell with its own seed, and every cell belongs to exactly one tile
// (by its centre). Neighbouring tiles therefore agree on everything near their shared edge with
// no seam code. Fields are read at the step-4 vertex lattice, which full-resolution and ring tiles
// share exactly, so a tile's plants don't change when it becomes the tile underfoot.

import type { TileBiome } from "../biome/field";
import { Biome, FOREST } from "../biome/rules";
import type { PlantMix, PlantPlan } from "../biome/plants";
import { PLANT_PLANS } from "../biome/plants";
import { hash32, mulberry32 } from "../terrain/noise";
import type { TileData } from "../terrain/tile";
import { EARTH_RADIUS_M, TILE_SEGMENTS, type TileBounds } from "../terrain/tilegrid";
import { PLAN_INFO, type AnimalPlan, type TaxonEntry } from "./roster";

const DEG = Math.PI / 180;
const FIELD_STEP = 4;   // read fields on the step-4 lattice (shared by every tile resolution)

export const LAYERS = {
  canopy: { spacingM: 10, plans: ["conifer", "ginkgo", "early_angiosperm", "seed_fern"] as PlantPlan[] },
  understorey: { spacingM: 7, plans: ["cycad_bennettitalean", "fern", "horsetail", "early_angiosperm", "seed_fern"] as PlantPlan[] },
};
export type Layer = keyof typeof LAYERS;
export const MAX_PLANTS = 250_000;
export const MAX_ANIMALS = 80;

/** Global scatter cell for a point: rows of fixed latitude height; columns sized for the row's latitude. */
export function cellOf(lat: number, lon: number, spacingM: number): { i: number; j: number } {
  const dLat = (spacingM / EARTH_RADIUS_M) / DEG;
  const i = Math.floor((lat + 90) / dLat);
  const dLon = dLat / Math.max(Math.cos(((i + 0.5) * dLat - 90) * DEG), 1e-3);
  return { i, j: Math.floor((lon + 180) / dLon) };
}

/** Each cell in the tile (by its centre), visited in a fixed order. */
export function forEachCell(b: TileBounds, spacingM: number, fn: (i: number, j: number, lat: number, lon: number) => void): void {
  const dLat = (spacingM / EARTH_RADIUS_M) / DEG;
  const i0 = Math.floor((b.latSouth + 90) / dLat - 0.5), i1 = Math.ceil((b.latNorth + 90) / dLat - 0.5);
  for (let i = i0; i <= i1; i++) {
    const lat = (i + 0.5) * dLat - 90;
    if (lat < b.latSouth || lat >= b.latNorth) continue;
    const dLon = dLat / Math.max(Math.cos(lat * DEG), 1e-3);
    const j0 = Math.floor((b.lonWest + 180) / dLon - 0.5), j1 = Math.ceil((b.lonWest + b.dlon + 180) / dLon - 0.5);
    for (let j = j0; j <= j1; j++) {
      const lon = (j + 0.5) * dLon - 180;
      if (lon < b.lonWest || lon >= b.lonWest + b.dlon) continue;
      fn(i, j, lat, lon);
    }
  }
}

/** Nearest step-4 lattice sample of a tile's fields (works for step 1 and step 4 tiles alike). */
export function makeSampler(t: TileData, biome: TileBiome) {
  const b = t.bounds, seg = TILE_SEGMENTS;
  return (lat: number, lon: number) => {
    const fi = ((b.latNorth - lat) / (b.latNorth - b.latSouth)) * seg;
    const fj = ((lon - b.lonWest) / b.dlon) * seg;
    const gi = Math.min(seg, Math.max(0, Math.round(fi / FIELD_STEP) * FIELD_STEP));
    const gj = Math.min(seg, Math.max(0, Math.round(fj / FIELD_STEP) * FIELD_STEP));
    const k = (gi / t.step) * t.n + gj / t.step;
    const up = t.normals[k * 3 + 1]! / 127;
    return {
      h: t.heights[k]!, slopeDeg: (Math.acos(Math.min(1, up)) * 180) / Math.PI,
      biome: biome.dominant[k]! as Biome, veg: biome.veg[k]! / 255,
    };
  };
}

// ------------------------------------------------------------------ plants

export interface PlantInstances {
  count: number;
  plan: Uint8Array;          // index into PLANT_PLANS
  alive: Uint8Array;         // 0 = dead snag (Aftermath)
  lat: Float64Array; lon: Float64Array;
  scale: Float32Array; rotation: Float32Array;
  colourSeed: Uint32Array;
}

const CANOPY_BY_BIOME: Partial<Record<Biome, number>> = {
  [Biome.WarmHumidForest]: 0.9, [Biome.FloodplainForest]: 0.8, [Biome.CoastalSwamp]: 0.6, [Biome.PolarForest]: 0.7,
  [Biome.MontaneForest]: 0.6, [Biome.SeasonalWoodland]: 0.45, [Biome.FernOpenland]: 0.06, [Biome.AridScrub]: 0.04, [Biome.Desert]: 0.005,
  [Biome.BareHighland]: 0.01, [Biome.AftermathFernField]: 0, [Biome.AftermathBareGround]: 0, [Biome.ImpactWinterFrost]: 0,
};
const UNDER_BY_BIOME: Partial<Record<Biome, number>> = {
  [Biome.WarmHumidForest]: 0.5, [Biome.FloodplainForest]: 0.6, [Biome.CoastalSwamp]: 0.7, [Biome.PolarForest]: 0.35,
  [Biome.MontaneForest]: 0.35, [Biome.SeasonalWoodland]: 0.45, [Biome.FernOpenland]: 0.6, [Biome.AridScrub]: 0.3, [Biome.Desert]: 0.02,
  [Biome.BareHighland]: 0.03, [Biome.Beach]: 0.03, [Biome.AftermathFernField]: 0.8,
};

/** Suitability nudges by ground cover (ecology §4; starting rules, all `inferred`). */
function suitability(plan: PlantPlan, b: Biome): number {
  const wet = b === Biome.CoastalSwamp || b === Biome.FloodplainForest;
  const dry = b === Biome.Desert || b === Biome.AridScrub;
  switch (plan) {
    case "fern": return wet ? 2 : dry ? 0.3 : b === Biome.FernOpenland || b === Biome.AftermathFernField ? 2.5 : 1;
    case "horsetail": return wet ? 3 : dry ? 0.1 : 0.6;
    case "conifer": return dry ? 1.5 : b === Biome.PolarForest || b === Biome.MontaneForest ? 1.5 : 1;
    case "cycad_bennettitalean": return dry ? 1.6 : b === Biome.PolarForest ? 0.3 : 1;
    case "ginkgo": return b === Biome.PolarForest || b === Biome.FloodplainForest ? 1.8 : 0.8;
    case "early_angiosperm": return wet ? 1.6 : 1;
    case "seed_fern": return 1;
  }
}

/** Typical heights for scale (m); placeholders for the models (render §7). */
export const PLANT_HEIGHT_M: Record<PlantPlan, number> = {
  conifer: 25, ginkgo: 15, early_angiosperm: 8, seed_fern: 6, cycad_bennettitalean: 2.5, fern: 1, horsetail: 1.5,
};

export function scatterPlants(t: TileData, biome: TileBiome, mix: PlantMix, sliceAge: number,
  aftermath: "impactWinter" | "fernSpike" | null): PlantInstances {
  const sample = makeSampler(t, biome);
  const cap = MAX_PLANTS * 2;   // collect generously, then thin evenly to the budget (below)
  const out: PlantInstances = {
    count: 0, plan: new Uint8Array(cap), alive: new Uint8Array(cap), lat: new Float64Array(cap), lon: new Float64Array(cap),
    scale: new Float32Array(cap), rotation: new Float32Array(cap), colourSeed: new Uint32Array(cap),
  };
  const push = (plan: PlantPlan, alive: boolean, lat: number, lon: number, rnd: () => number) => {
    if (out.count >= cap) return;
    const k = out.count++;
    out.plan[k] = PLANT_PLANS.indexOf(plan);
    out.alive[k] = alive ? 1 : 0;
    out.lat[k] = lat; out.lon[k] = lon;
    out.scale[k] = PLANT_HEIGHT_M[plan] * (0.7 + 0.6 * rnd());
    out.rotation[k] = rnd() * Math.PI * 2;
    out.colourSeed[k] = (rnd() * 2 ** 32) >>> 0;
  };
  const DEAD = Biome.AftermathDeadForest;

  for (const layer of ["canopy", "understorey"] as Layer[]) {
    const L = LAYERS[layer];
    const plans = L.plans.filter((p) => mix.weights[p] > 0);
    const dLatDeg = (L.spacingM / EARTH_RADIUS_M) / DEG;
    forEachCell(t.bounds, L.spacingM, (i, j, clat, clon) => {
      const rnd = mulberry32(hash32("plant", sliceAge, layer, i, j));
      const dLonDeg = dLatDeg / Math.max(Math.cos(clat * DEG), 1e-3);
      const lat = clat + (rnd() - 0.5) * 0.8 * dLatDeg, lon = clon + (rnd() - 0.5) * 0.8 * dLonDeg;
      const f = sample(lat, lon);
      if (f.h < 0 || f.slopeDeg > 45) return;
      const accept = rnd();
      if (aftermath === "impactWinter") {
        // standing dead trees only, where forest stood (biome §7)
        if (layer === "canopy" && f.biome === DEAD && accept < 0.5) push("conifer", false, lat, lon, rnd);
        return;
      }
      if (aftermath === "fernSpike" && layer === "canopy") {
        if (f.biome === DEAD && accept < 0.35) push("conifer", false, lat, lon, rnd);   // decaying snags
        return;
      }
      const density = (layer === "canopy" ? CANOPY_BY_BIOME[f.biome] ?? 0 : UNDER_BY_BIOME[f.biome] ?? 0) * Math.min(1, f.veg * 1.4);
      if (accept > density || plans.length === 0) return;
      let total = 0;
      for (const p of plans) total += mix.weights[p] * suitability(p, f.biome);
      let r = rnd() * total;
      let pick = plans[0]!;
      for (const p of plans) { r -= mix.weights[p] * suitability(p, f.biome); if (r <= 0) { pick = p; break; } }
      push(pick, true, lat, lon, rnd);
    });
  }
  return thin(out, MAX_PLANTS);
}

/**
 * Keep at most `max` instances, spread evenly: each instance survives by its own seed, so the
 * thinning is deterministic and has no spatial bias (truncating would leave the tile's south bare).
 */
export function thin(p: PlantInstances, max: number): PlantInstances {
  const keep = p.count <= max ? 1 : max / p.count;
  const idx: number[] = [];
  for (let k = 0; k < p.count; k++) if (keep === 1 || (hash32("thin", p.colourSeed[k]!) / 2 ** 32) < keep) idx.push(k);
  const n = Math.min(idx.length, max);
  const pick = <T extends { [i: number]: number }>(src: T, dst: T) => { for (let k = 0; k < n; k++) dst[k] = src[idx[k]!]!; return dst; };
  return {
    count: n, plan: pick(p.plan, new Uint8Array(n)), alive: pick(p.alive, new Uint8Array(n)),
    lat: pick(p.lat, new Float64Array(n)), lon: pick(p.lon, new Float64Array(n)), scale: pick(p.scale, new Float32Array(n)),
    rotation: pick(p.rotation, new Float32Array(n)), colourSeed: pick(p.colourSeed, new Uint32Array(n)),
  };
}

// ------------------------------------------------------------------ animals

export interface AnimalSpawn {
  taxon: number;           // index into the roster
  group: number;
  lat: number; lon: number;
  heading: number;
  scale: number;           // body length, m
  colourSeed: number;
  flags: number;
}

/** Habitat suitability of a point for a body plan (ecology §2). 0 = never. */
export function habitatScore(plan: AnimalPlan, f: { h: number; slopeDeg: number; biome: Biome }): number {
  const realm = PLAN_INFO[plan].realm;
  if (realm === "sea") return f.h < -2 ? 1 : 0;
  if (realm === "air") return 1;
  if (f.h < 0) return realm === "water_edge" && f.h > -3 ? 0.8 : 0;     // shore and shallow edge only
  if (f.slopeDeg > (plan === "sauropod" || plan === "prosauropod" ? 15 : 30)) return 0;
  const forest = (FOREST as readonly Biome[]).includes(f.biome);
  const open = f.biome === Biome.FernOpenland || f.biome === Biome.SeasonalWoodland || f.biome === Biome.AridScrub;
  const wet = f.biome === Biome.CoastalSwamp || f.biome === Biome.FloodplainForest || f.biome === Biome.Beach;
  switch (plan) {
    case "sauropod": case "prosauropod": return f.biome === Biome.FloodplainForest || open ? 1 : forest ? 0.5 : 0.2;
    case "ornithopod": return wet || open ? 1 : forest ? 0.6 : 0.2;
    case "ceratopsian": return open || wet ? 1 : 0.4;
    case "ankylosaur": case "stegosaur": return forest || open ? 1 : 0.3;
    case "large_theropod": return 0.8;
    case "small_theropod": return forest || open ? 1 : 0.5;
    case "crocodylomorph": case "turtle": return wet ? 1 : f.h < 5 ? 0.6 : 0.1;
    case "small_tetrapod": return forest || open ? 1 : 0.4;
    default: return 0.5;
  }
}

const SPAWN_SPACING_M = 200;
export const MAX_PER_TAXON = 12;

export function placeAnimals(t: TileData, biome: TileBiome, roster: TaxonEntry[], sliceAge: number): AnimalSpawn[] {
  const sample = makeSampler(t, biome);
  const cells: { i: number; j: number; lat: number; lon: number }[] = [];
  forEachCell(t.bounds, SPAWN_SPACING_M, (i, j, lat, lon) => cells.push({ i, j, lat, lon }));
  const out: AnimalSpawn[] = [];
  let group = 0;
  const dLat = 1 / 111_195;
  // biggest animals first, so the budget isn't spent on mice; each taxon capped
  const order = roster.map((e, ti) => ({ e, ti })).sort((a, b) => b.e.massKg - a.e.massKg || a.ti - b.ti);
  order.forEach(({ e, ti }) => {
    if (e.count <= 0 || out.length >= MAX_ANIMALS) return;
    const info = PLAN_INFO[e.bodyPlan];
    const rnd = mulberry32(hash32("fauna", sliceAge, e.key, t.id.row, t.id.col));
    let left = Math.min(e.count, MAX_PER_TAXON);
    while (left > 0 && out.length < MAX_ANIMALS) {
      const size = Math.min(left, info.group[0] + Math.floor(rnd() * (info.group[1] - info.group[0] + 1)));
      left -= size;
      // best of a few seeded candidate spawn cells
      let best: (typeof cells)[number] | null = null, bestScore = 0;
      for (let k = 0; k < 12 && cells.length; k++) {
        const c = cells[Math.floor(rnd() * cells.length)]!;
        const s = habitatScore(e.bodyPlan, sample(c.lat, c.lon)) * (0.75 + 0.25 * rnd());
        if (s > bestScore) { best = c; bestScore = s; }
      }
      if (!best) continue;
      const g = group++;
      for (let m = 0; m < size && out.length < MAX_ANIMALS; m++) {
        const r = e.lengthM * (1.5 + 3 * Math.sqrt(rnd())), a = rnd() * Math.PI * 2;
        const lat = best.lat + Math.sin(a) * r * dLat, lon = best.lon + (Math.cos(a) * r * dLat) / Math.max(Math.cos(best.lat * DEG), 1e-3);
        if (habitatScore(e.bodyPlan, sample(lat, lon)) === 0) continue;   // never spawn a land animal in the sea, or the reverse
        out.push({ taxon: ti, group: g, lat, lon, heading: rnd() * Math.PI * 2, scale: e.lengthM * (0.9 + 0.2 * rnd()),
          colourSeed: (rnd() * 2 ** 32) >>> 0, flags: e.flags });
      }
    }
  });
  return out;
}
