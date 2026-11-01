// Morph field for the edge of the near ring (render §5). Near tiles blend from full detail (H) to
// the detail-free surface (Hsmooth) within MORPH_BAND_M of the region the 3 × 3 ring does not cover,
// so their outer edges meet the far ring (which is Hsmooth) without steps or gaps.
// The current tile is always ≥ 2 km from that region, so the ground underfoot is never morphed.

import { tileBounds, type TileId } from "../terrain/tilegrid";
import { LocalFrame } from "./projection";

export const MORPH_BAND_M = 1200;
const CELL_M = 100;
const HALF_M = 14_000;

export type MorphFn = (lat: number, lon: number) => number;

/** Distance (m) from each grid cell to the nearest cell outside the tiles, by a two-pass chamfer transform. */
export function buildMorph(frame: LocalFrame, tiles: TileId[]): MorphFn {
  const n = Math.round((2 * HALF_M) / CELL_M);
  const dist = new Float32Array(n * n);
  const rects = tiles.map((id) => tileBounds(id));
  for (let i = 0; i < n; i++) {
    const z = -HALF_M + (i + 0.5) * CELL_M;
    for (let j = 0; j < n; j++) {
      const x = -HALF_M + (j + 0.5) * CELL_M;
      const [lat, lon] = frame.toLatLon(x, z);
      const inside = rects.some((b) => lat >= b.latSouth && lat <= b.latNorth &&
        ((((lon - b.lonWest) % 360) + 360) % 360) <= b.dlon);
      dist[i * n + j] = inside ? 1e9 : 0;
    }
  }
  const D = CELL_M, D2 = CELL_M * Math.SQRT2;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    let d = dist[i * n + j]!;
    if (d === 0) continue;
    if (i > 0) { d = Math.min(d, dist[(i - 1) * n + j]! + D); if (j > 0) d = Math.min(d, dist[(i - 1) * n + j - 1]! + D2); if (j < n - 1) d = Math.min(d, dist[(i - 1) * n + j + 1]! + D2); }
    if (j > 0) d = Math.min(d, dist[i * n + j - 1]! + D);
    if (i === 0 || j === 0 || i === n - 1 || j === n - 1) d = Math.min(d, D / 2);
    dist[i * n + j] = d;
  }
  for (let i = n - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    let d = dist[i * n + j]!;
    if (d === 0) continue;
    if (i < n - 1) { d = Math.min(d, dist[(i + 1) * n + j]! + D); if (j < n - 1) d = Math.min(d, dist[(i + 1) * n + j + 1]! + D2); if (j > 0) d = Math.min(d, dist[(i + 1) * n + j - 1]! + D2); }
    if (j < n - 1) d = Math.min(d, dist[i * n + j + 1]! + D);
    dist[i * n + j] = d;
  }
  return (lat, lon) => {
    const [e, nn] = frame.en(lat, lon);
    // bilinear in the distance field; cell centres at −HALF + (k + 0.5)·CELL
    const fx = (e + HALF_M) / CELL_M - 0.5, fz = (-nn + HALF_M) / CELL_M - 0.5;
    const j = Math.max(0, Math.min(n - 2, Math.floor(fx))), i = Math.max(0, Math.min(n - 2, Math.floor(fz)));
    const x = Math.max(0, Math.min(1, fx - j)), y = Math.max(0, Math.min(1, fz - i));
    const d = (dist[i * n + j]! * (1 - x) + dist[i * n + j + 1]! * x) * (1 - y) + (dist[(i + 1) * n + j]! * (1 - x) + dist[(i + 1) * n + j + 1]! * x) * y;
    // the distance field is cell-quantised; subtract half a cell so the boundary itself reaches w = 1
    const t = Math.max(0, Math.min(1, (d - CELL_M / 2) / MORPH_BAND_M));
    return 1 - t * t * (3 - 2 * t);
  };
}
