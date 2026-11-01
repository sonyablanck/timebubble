import type { TileBiome } from "../biome/field";
import type { TileEcology } from "../ecology";
import type { Surface } from "./surface";
import { DLAT, EARTH_RADIUS_M, TILE_SEGMENTS, tileBounds, type TileBounds, type TileId } from "./tilegrid";

// terrain/ §2, §7: a tile is a lattice of samples of the global surface. Vertex
// (i, j) lies at lat = latNorth − i·DLAT/512, lon = lonWest + j·dlon/512, so
// east–west neighbours share their edge vertices exactly. `step` thins the lattice
// for distant tiles (1 = full 513², 4 = 129²); the same vertices, fewer of them.

export interface TileData {
  id: TileId;
  bounds: TileBounds;
  sliceAge: number;
  step: number;
  n: number;                 // vertices per side
  heights: Float32Array;     // H, metres, row-major from the north-west corner
  smooth: Float32Array;      // Hsmooth (no generated detail)
  flags: Uint32Array;        // provenance bits per vertex
  strength: Uint8Array;      // generated share × 255
  cls: Uint8Array;           // dominant terrain class
  normals: Int8Array;        // (east, up, north) × 127
  stats: { min: number; max: number; landShare: number; ms: number };
  /** Ground cover, added by biome/ in the worker (absent in terrain-only use). */
  biome?: TileBiome;
  /** Roster, plants and animal spawns, added by ecology/ in the worker. */
  ecology?: TileEcology;
}

const DEG = Math.PI / 180;

export function vertexLat(b: TileBounds, i: number): number {
  return -90 + (b.id.row + 1 - i / TILE_SEGMENTS) * DLAT;
}

export function vertexLon(b: TileBounds, j: number): number {
  return -180 + (b.id.col + j / TILE_SEGMENTS) * b.dlon;
}

/** Margin (degrees) a Surface must be prepared with around a tile. */
export const PREPARE_MARGIN_DEG = 0.1;

export async function prepareFor(surface: Surface, id: TileId): Promise<TileBounds> {
  const b = tileBounds(id);
  await surface.prepare(b.latSouth - PREPARE_MARGIN_DEG, b.latNorth + PREPARE_MARGIN_DEG,
    b.lonWest - PREPARE_MARGIN_DEG, b.lonEast + PREPARE_MARGIN_DEG);
  return b;
}

/** Generate a tile. The surface must already be prepared for it (prepareFor). */
export function generateTile(surface: Surface, id: TileId, step = 1): TileData {
  if (TILE_SEGMENTS % step !== 0) throw new Error(`step ${step} must divide ${TILE_SEGMENTS}`);
  const t0 = performance.now();
  const b = tileBounds(id);
  const n = TILE_SEGMENTS / step + 1;
  const nb = n + 2;                                  // with a one-vertex border for normals
  const H = new Float64Array(nb * nb);
  const heights = new Float32Array(n * n);
  const smooth = new Float32Array(n * n);
  const flags = new Uint32Array(n * n);
  const strength = new Uint8Array(n * n);
  const cls = new Uint8Array(n * n);
  let min = Infinity, max = -Infinity, land = 0;

  for (let bi = 0; bi < nb; bi++) {
    const i = (bi - 1) * step;
    const lat = vertexLat(b, i);
    for (let bj = 0; bj < nb; bj++) {
      const j = (bj - 1) * step;
      const lon = vertexLon(b, j);
      const inside = bi > 0 && bj > 0 && bi < nb - 1 && bj < nb - 1;
      if (!inside) { H[bi * nb + bj] = surface.height(lat, lon); continue; }
      const s = surface.sample(lat, lon);
      H[bi * nb + bj] = s.h;
      const k = (bi - 1) * n + (bj - 1);
      heights[k] = s.h;
      smooth[k] = s.smooth;
      flags[k] = s.flags;
      strength[k] = Math.round(s.strength * 255);
      cls[k] = s.cls;
      if (s.h < min) min = s.h;
      if (s.h > max) max = s.h;
      if (s.h >= 0) land++;
    }
  }

  // normals from central differences over the bordered grid, in (east, up, north)
  const normals = new Int8Array(n * n * 3);
  const dyN = EARTH_RADIUS_M * DLAT * DEG * (step / TILE_SEGMENTS);
  for (let i = 0; i < n; i++) {
    const lat = vertexLat(b, i * step);
    const dxE = EARTH_RADIUS_M * b.dlon * DEG * Math.cos(lat * DEG) * (step / TILE_SEGMENTS);
    for (let j = 0; j < n; j++) {
      const c = (i + 1) * nb + (j + 1);
      const dhdE = (H[c + 1]! - H[c - 1]!) / (2 * dxE);
      const dhdN = (H[c - nb]! - H[c + nb]!) / (2 * dyN);   // row i−1 is further north
      const len = Math.hypot(dhdE, 1, dhdN);
      const k = (i * n + j) * 3;
      normals[k] = Math.round((-dhdE / len) * 127);
      normals[k + 1] = Math.round((1 / len) * 127);
      normals[k + 2] = Math.round((-dhdN / len) * 127);
    }
  }

  return {
    id: b.id, bounds: b, sliceAge: surface.age, step, n, heights, smooth, flags, strength, cls, normals,
    stats: { min, max, landShare: land / (n * n), ms: performance.now() - t0 },
  };
}

/** Far horizon (render §5): Hsmooth on a square lattice around a point, no generated detail. */
export interface FarField {
  lat0: number; lon0: number; halfSizeM: number; n: number;
  heights: Float32Array;     // row-major, north row first
  colour?: Uint8Array;       // sRGB ground colour per vertex from biome/ (coarse)
}

export function farFieldBox(lat0: number, lon0: number, halfSizeM: number): [number, number, number, number] {
  const dLat = (halfSizeM / EARTH_RADIUS_M) / DEG;
  const dLon = dLat / Math.max(Math.cos(Math.min(89, Math.abs(lat0) + dLat) * DEG), 0.05);
  return [lat0 - dLat, lat0 + dLat, lon0 - dLon, lon0 + dLon];
}

export function generateFarField(surface: Surface, lat0: number, lon0: number, halfSizeM: number, n: number): FarField {
  const heights = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const y = halfSizeM - (2 * halfSizeM * i) / (n - 1);            // metres north of centre
    const lat = lat0 + (y / EARTH_RADIUS_M) / DEG;
    const cosLat = Math.max(Math.cos(lat * DEG), 1e-3);
    for (let j = 0; j < n; j++) {
      const x = -halfSizeM + (2 * halfSizeM * j) / (n - 1);         // metres east
      const lon = lon0 + (x / (EARTH_RADIUS_M * cosLat)) / DEG;
      heights[i * n + j] = surface.smooth(Math.max(-89.9, Math.min(89.9, lat)), lon);
    }
  }
  return { lat0, lon0, halfSizeM, n, heights };
}
