// ecology/: who lives on a tile, how many, and where (runs in the terrain worker after biome/).

import type { BiomeContext, TileBiome } from "../biome/field";
import { F } from "../provenance/flags";
import { hash32, mulberry32 } from "../terrain/noise";
import type { TileData } from "../terrain/tile";
import { buildRoster, R_INFERRED_KM, type Habitats, type TaxonEntry } from "./roster";
import { placeAnimals, scatterPlants, type AnimalSpawn, type PlantInstances } from "./scatter";

export * from "./roster";
export * from "./scatter";
export * from "./behaviour";

export interface EcologySettings { representativeFauna: boolean }

export interface TileEcology {
  available: boolean;          // false when the slice has no fossil data yet
  roster: TaxonEntry[];
  plants: PlantInstances;
  animals: AnimalSpawn[];
  habitats: Habitats;
  /** Fossil sites near the tile (palaeo lat, lon pairs; nearest first, ≤ MAX_SITES, ~5 km apart), for the evidence overlay. */
  sites: Float32Array;
  ms: number;
}

export const MAX_SITES = 128;

/** Distinct occurrence sites, nearest first: occurrences within ~5 km of a kept site are merged. */
export function nearestSites(occ: readonly { lat: number; lon: number; distanceKm: number }[], max = MAX_SITES): Float32Array {
  const sorted = [...occ].sort((a, b) => a.distanceKm - b.distanceKm);
  const seen = new Set<string>(), out: number[] = [];
  for (const o of sorted) {
    const k = `${Math.round(o.lat * 20)},${Math.round(o.lon * 20)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o.lat, o.lon);
    if (out.length >= max * 2) break;
  }
  return Float32Array.from(out);
}

/** Land / near-coast / shelf / ocean shares of a tile (ecology §1a). */
export function tileHabitats(t: TileData): Habitats {
  let land = 0, near = 0, shelf = 0, ocean = 0;
  const n = t.heights.length;
  for (let k = 0; k < n; k++) {
    const h = t.heights[k]!;
    if (h >= 0) { land++; if (h < 20) near++; }
    else if (h >= -200) { shelf++; if (h > -20) near++; }
    else ocean++;
  }
  return { land: land / n, nearCoast: near / n, shelf: shelf / n, ocean: ocean / n };
}

export function buildTileEcology(t: TileData, biome: TileBiome, ctx: BiomeContext, settings: EcologySettings): TileEcology {
  const t0 = performance.now();
  const habitats = tileHabitats(t);
  const aftermath = ctx.aftermath?.phase ?? null;
  const centre = t.bounds;
  const occ = ctx.ecology ? ctx.ecology.near(centre.centreLat, centre.centreLon, R_INFERRED_KM) : [];
  let heatSum = 0, heatN = 0;
  for (let k = 0; k < biome.flags.length; k += 7) { if (t.heights[k]! >= 0) { heatN++; heatSum += (biome.flags[k]! & F.THERMAL_EXCLUSION) ? 1 : 0; } }
  const roster = buildRoster(occ, {
    age: ctx.age, habitats, heatStress: heatN ? heatSum / heatN : 0, aftermath,
    representativeFauna: settings.representativeFauna,
    rng: (key) => mulberry32(hash32("count", ctx.age, key, t.id.row, t.id.col)),
  });
  const plants = scatterPlants(t, biome, biome.plantMix, ctx.age, aftermath);
  const animals = placeAnimals(t, biome, roster, ctx.age);
  return { available: !!ctx.ecology, roster, plants, animals, habitats, sites: nearestSites(occ), ms: performance.now() - t0 };
}
