// Biome fields for tiles, the far ring and single points (biome §0). Runs in the terrain worker
// straight after terrain generation. Every output is `inferred` (BIOME_INFERRED).

import type { EcologyIndex, Grid, SliceHandle } from "../data";
import { F } from "../provenance/flags";
import type { Surface, SurfaceSample } from "../terrain/surface";
import { vertexLat, vertexLon, type FarField, type TileData } from "../terrain/tile";
import { EARTH_RADIUS_M, TILE_SEGMENTS } from "../terrain/tilegrid";
import { icePossible, type Aftermath } from "./climate";
import { aftermathMix, plantMixFor, PLANT_RADIUS_KM, type PlantMix } from "./plants";
import { Biome, blendColour, classify, climateAt, dominant, NB, type ClimateAt } from "./rules";

export interface BiomeContext {
  age: number;
  temp: Grid; precip: Grid; elev: Grid;
  icePossible: boolean;
  aftermath: Aftermath | null;
  /** temperature or precipitation grid more than 3 Myr from the slice age (CLIMATE_AGE_MISMATCH) */
  ageMismatch: boolean;
  tempSource: { age: number; override: string | null };
  /** Fossil occurrences for the slice, or null before the fossil pipeline has run. */
  ecology: EcologyIndex | null;
}

export async function biomeContext(slice: SliceHandle, aftermath: Aftermath | null): Promise<BiomeContext> {
  const [temp, precip, elev, meta, params, eco] = await Promise.all([
    slice.temperature(), slice.precipitation(), slice.globe(), slice.climateMeta(), slice.climate().catch(() => null),
    slice.ecology().catch(() => null),
  ]);
  return {
    age: slice.age, temp, precip, elev,
    icePossible: icePossible(slice.age, params?.ice_possible ?? null),
    aftermath: slice.aftermathMode ? aftermath : null,
    ageMismatch: Math.abs(meta.temp.age_mismatch_myr) > 3 || Math.abs(meta.precip.age_mismatch_myr) > 3,
    tempSource: { age: meta.temp.source_age, override: meta.temp.override_reason },
    ecology: eco && eco.available ? eco : null,
  };
}

export interface TileBiome {
  colour: Uint8Array;          // n*n*3 sRGB ground colour
  dominant: Uint8Array;        // n*n Biome
  veg: Uint8Array;             // n*n vegetation density × 255
  flags: Uint32Array;          // n*n biome provenance bits
  plantMix: PlantMix;          // per tile
  dominantBiome: Biome;        // most common land biome on the tile (sea if none)
}

function baseFlags(ctx: BiomeContext): number {
  let f = F.BIOME_INFERRED;
  if (ctx.aftermath) f |= F.AFTERMATH_RECON;
  if (ctx.ageMismatch) f |= F.CLIMATE_AGE_MISMATCH;
  return f;
}

function vertexFlags(f0: number, c: ClimateAt, w: Float32Array): number {
  let f = f0;
  if (c.heatStress > 0.5) f |= F.THERMAL_EXCLUSION;
  if (w[Biome.HighlandIce]! > 0.05) f |= F.ICE_CONTESTED;
  return f;
}

/** Near-sea term exp(−d/5 km) with d from the 0.1° land/sea nodes (biome §3). */
const nearSeaOf = (km: number) => Math.exp(-km / 5);

export function classifyTile(t: TileData, surface: Surface, ctx: BiomeContext): TileBiome {
  const n = t.n, nv = n * n, b = t.bounds;
  // coast distance on a 17 × 17 lattice over the tile, interpolated (E/W edges coincide exactly)
  const L = 16, LS = TILE_SEGMENTS / L;
  // The 1° climate fields and the coast distance vary slowly across a 4 km tile, so they are
  // sampled on this lattice and interpolated (E/W edges of neighbouring tiles coincide exactly).
  const NL = (L + 1) * (L + 1);
  const lat4 = new Float32Array(NL * 4);   // coastKm, tGrid, eGrid, pGrid
  for (let a = 0; a <= L; a++) for (let c = 0; c <= L; c++) {
    const la = vertexLat(b, a * LS), lo = vertexLon(b, c * LS), q = (a * (L + 1) + c) * 4;
    lat4[q] = surface.nearestSeaKm(la, lo);
    lat4[q + 1] = ctx.temp.bilinear(la, lo);
    lat4[q + 2] = ctx.elev.bilinear(la, lo);
    lat4[q + 3] = ctx.precip.bilinear(la, lo);
  }
  const fld = new Float64Array(4);
  const fields = (i: number, j: number) => {
    const u = (i * t.step) / LS, v = (j * t.step) / LS;
    const a = Math.min(L - 1, Math.floor(u)), c = Math.min(L - 1, Math.floor(v)), y = u - a, x = v - c;
    const q00 = (a * (L + 1) + c) * 4, q01 = q00 + 4, q10 = q00 + (L + 1) * 4, q11 = q10 + 4;
    const w00 = (1 - x) * (1 - y), w01 = x * (1 - y), w10 = (1 - x) * y, w11 = x * y;
    for (let f = 0; f < 4; f++) fld[f] = lat4[q00 + f]! * w00 + lat4[q01 + f]! * w01 + lat4[q10 + f]! * w10 + lat4[q11 + f]! * w11;
    return fld;
  };

  const colour = new Uint8Array(nv * 3), dom = new Uint8Array(nv), veg = new Uint8Array(nv), flags = new Uint32Array(nv);
  const w = new Float32Array(NB), counts = new Float64Array(NB), rgb = new Float32Array(3);
  const f0 = baseFlags(ctx);
  for (let i = 0; i < n; i++) {
    const lat = vertexLat(b, i * t.step);
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      const h = t.heights[k]!;
      const g = fields(i, j);
      const nearSea = nearSeaOf(g[0]!);
      const c = climateAt(g[1]!, g[2]!, g[3]!, h, t.smooth[k]!, nearSea, ctx.aftermath);
      const slopeDeg = Math.acos(Math.min(1, t.normals[k * 3 + 1]! / 127)) * 180 / Math.PI;
      const v = classify({ h, hSmooth: t.smooth[k]!, slopeDeg, absLat: Math.abs(lat), nearSea, c, icePossible: ctx.icePossible, aftermath: ctx.aftermath }, w);
      blendColour(w, rgb, 0, 255);
      colour[k * 3] = rgb[0]!; colour[k * 3 + 1] = rgb[1]!; colour[k * 3 + 2] = rgb[2]!;
      const d = dominant(w);
      dom[k] = d;
      veg[k] = Math.round(v * 255);
      flags[k] = vertexFlags(f0, c, w);
      if (h >= 0) counts[d] = counts[d]! + 1;
    }
  }
  let best = -1, dominantBiome = Biome.ShelfSea;
  for (let k = 0; k < NB; k++) if (counts[k]! > best && counts[k]! > 0) { best = counts[k]!; dominantBiome = k; }
  const plantMix = mixAt(b.centreLat, b.centreLon, dominantBiome, ctx);
  const pf = plantFlag(plantMix);
  for (let k = 0; k < nv; k++) flags[k] = flags[k]! | pf;
  return { colour, dominant: dom, veg, flags, plantMix, dominantBiome };
}

/** Ground colour for the far ring at coarse resolution (render §5), from Hsmooth. */
export function classifyFar(f: FarField, surface: Surface, ctx: BiomeContext): Uint8Array {
  const n = f.n, colour = new Uint8Array(n * n * 3), w = new Float32Array(NB), rgb = new Float32Array(3);
  const step = (2 * f.halfSizeM) / (n - 1), DEG = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const y = f.halfSizeM - i * step;
    const lat = f.lat0 + (y / EARTH_RADIUS_M) / DEG;
    const cl = Math.max(Math.cos(lat * DEG), 1e-3);
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      const x = -f.halfSizeM + j * step;
      const lon = f.lon0 + (x / (EARTH_RADIUS_M * cl)) / DEG;
      const h = f.heights[k]!;
      const hE = f.heights[i * n + Math.min(n - 1, j + 1)]! - f.heights[i * n + Math.max(0, j - 1)]!;
      const hN = f.heights[Math.max(0, i - 1) * n + j]! - f.heights[Math.min(n - 1, i + 1) * n + j]!;
      const slopeDeg = Math.atan(Math.hypot(hE, hN) / (2 * step)) * 180 / Math.PI;
      // cheaper coast term on the far ring: only where the surface is near sea level
      const nearSea = h < 60 ? nearSeaOf(surface.nearestSeaKm(lat, lon, 12)) : 0;
      const c = climateAt(ctx.temp.bilinear(lat, lon), ctx.elev.bilinear(lat, lon), ctx.precip.bilinear(lat, lon), h, h, nearSea, ctx.aftermath);
      classify({ h, hSmooth: h, slopeDeg, absLat: Math.abs(lat), nearSea, c, icePossible: ctx.icePossible, aftermath: ctx.aftermath }, w);
      blendColour(w, rgb, 0, 255);
      colour[k * 3] = rgb[0]!; colour[k * 3 + 1] = rgb[1]!; colour[k * 3 + 2] = rgb[2]!;
    }
  }
  return colour;
}

export interface BiomePoint {
  weights: { biome: Biome; weight: number }[];   // top 3
  climate: ClimateAt;
  tGrid: number; pGridMmDay: number;
  vegDensity: number;
  flags: number;
  plantMix: PlantMix;
  coastKm: number;
}

/** Everything an info card needs about the ground cover at one point. Surface must be prepared there. */
export function biomeAt(lat: number, lon: number, s: SurfaceSample, slopeDeg: number, surface: Surface, ctx: BiomeContext): BiomePoint {
  const coastKm = surface.nearestSeaKm(lat, lon);
  const nearSea = nearSeaOf(coastKm);
  const tGrid = ctx.temp.bilinear(lat, lon), pGrid = ctx.precip.bilinear(lat, lon);
  const c = climateAt(tGrid, ctx.elev.bilinear(lat, lon), pGrid, s.h, s.smooth, nearSea, ctx.aftermath);
  const w = new Float32Array(NB);
  const veg = classify({ h: s.h, hSmooth: s.smooth, slopeDeg, absLat: Math.abs(lat), nearSea, c, icePossible: ctx.icePossible, aftermath: ctx.aftermath }, w);
  const top = Array.from(w, (weight, biome) => ({ biome: biome as Biome, weight })).sort((a, b) => b.weight - a.weight).slice(0, 3).filter((x) => x.weight > 0.02);
  const plantMix = mixAt(lat, lon, top[0]!.biome, ctx);
  const flags = vertexFlags(baseFlags(ctx), c, w) | plantFlag(plantMix);
  return { weights: top, climate: c, tGrid, pGridMmDay: pGrid, vegDensity: veg, flags, plantMix, coastKm };
}

function mixAt(lat: number, lon: number, biome: Biome, ctx: BiomeContext): PlantMix {
  if (ctx.aftermath) return aftermathMix(ctx.aftermath.phase);
  return plantMixFor(ctx.age, biome, ctx.ecology ? ctx.ecology.plantsNear(lat, lon, PLANT_RADIUS_KM) : null);
}

function plantFlag(m: PlantMix): number {
  return m.source === "data" ? F.PLANTS_FROM_DATA : F.PLANTS_FROM_PRIOR;
}
