// terrain/ §1: the fixed global tile grid. The same place always maps to the same
// tile, so the same tile is always generated.
//
// Rows are DLAT tall (4 km of latitude). Each row is split into a whole number of
// columns, ncols = round(360 · cos(rowLat) / DLAT), so tiles are ~4 km wide and a
// row closes exactly at the antimeridian. Vertices lie on a regular lat/lon lattice
// inside each tile, so east–west neighbours share their edge vertices exactly.

export const EARTH_RADIUS_M = 6_371_000;
export const TILE_M = 4000;
export const DLAT = (TILE_M / EARTH_RADIUS_M) * (180 / Math.PI); // ≈ 0.03597°
export const NROWS = Math.floor(180 / DLAT);
export const TILE_N = 513;          // vertices per side at full resolution (~8 m spacing)
export const TILE_SEGMENTS = TILE_N - 1;
export const MAX_ABS_LAT = 89.5;

export interface TileId { row: number; col: number }

export interface TileBounds {
  id: TileId;
  latSouth: number;
  latNorth: number;
  lonWest: number;
  lonEast: number;          // may exceed 180 for the last column; wrap when sampling
  centreLat: number;
  centreLon: number;
  dlon: number;
}

export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function rowLat(row: number): number {
  return -90 + (row + 0.5) * DLAT;
}

export function colsInRow(row: number): number {
  return Math.max(1, Math.round((360 * Math.cos((rowLat(row) * Math.PI) / 180)) / DLAT));
}

export function tileIdFor(lat: number, lon: number): TileId {
  const la = Math.max(-MAX_ABS_LAT, Math.min(MAX_ABS_LAT, lat));
  const row = Math.min(NROWS - 1, Math.floor((la + 90) / DLAT));
  const ncols = colsInRow(row);
  const col = Math.min(ncols - 1, Math.floor(((wrapLon(lon) + 180) / 360) * ncols));
  return { row, col };
}

export function tileBounds({ row, col }: TileId): TileBounds {
  const ncols = colsInRow(row);
  const c = ((col % ncols) + ncols) % ncols;
  const dlon = 360 / ncols;
  const latSouth = -90 + row * DLAT;
  const lonWest = -180 + c * dlon;
  return {
    id: { row, col: c },
    latSouth, latNorth: latSouth + DLAT,
    lonWest, lonEast: lonWest + dlon,
    centreLat: latSouth + DLAT / 2,
    centreLon: wrapLon(lonWest + dlon / 2),
    dlon,
  };
}

export function tileKey({ row, col }: TileId): string {
  return `${row}_${col}`;
}

/** The 3 × 3 ring around a tile (itself included), north row first. */
export function ring(id: TileId): TileId[] {
  const out: TileId[] = [];
  const centre = tileBounds(id);
  for (const dr of [1, 0, -1]) {
    const r = id.row + dr;
    if (r < 0 || r >= NROWS) continue;
    const ncols = colsInRow(r);
    // the column in row r whose centre is nearest this tile's centre longitude
    const c0 = Math.min(ncols - 1, Math.floor(((wrapLon(centre.centreLon) + 180) / 360) * ncols));
    for (const dc of [-1, 0, 1]) out.push({ row: r, col: (((dr === 0 ? id.col : c0) + dc) % ncols + ncols) % ncols });
  }
  return out;
}

/** Lattice coordinates of vertex (i, j) at a given step: i counts south from the north edge. */
export function vertexLatLon(b: TileBounds, i: number, j: number): [number, number] {
  return [b.latNorth - (i / TILE_SEGMENTS) * DLAT, b.lonWest + (j / TILE_SEGMENTS) * b.dlon];
}
