// Coordinate conventions for the globe (globe/ §2, §5). One place, so the shaders,
// picking and the camera can never disagree.
//
//   unit sphere, radius 1, y up (north pole at +y)
//   lon 0 faces +z, lon +90 faces +x
//   (lat, lon) -> (x, y, z) = (cos lat · sin lon, sin lat, cos lat · cos lon)
//
// The GLSL in shaders.ts uses the same formulas (see GLSL_GEO).

import type { Grid } from "../data";

export const DEG = Math.PI / 180;
export const EARTH_RADIUS_M = 6_371_000;

export interface LatLon { lat: number; lon: number }
export type Vec3 = [number, number, number];

export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function latLonToVec3(lat: number, lon: number, r = 1): Vec3 {
  const cl = Math.cos(lat * DEG);
  return [r * cl * Math.sin(lon * DEG), r * Math.sin(lat * DEG), r * cl * Math.cos(lon * DEG)];
}

export function vec3ToLatLon([x, y, z]: Vec3): LatLon {
  const r = Math.hypot(x, y, z);
  return { lat: Math.asin(Math.max(-1, Math.min(1, y / r))) / DEG, lon: Math.atan2(x, z) / DEG };
}

/**
 * Texture coordinates of (lat, lon) in a grid uploaded with row 0 at v = 0.
 * Each value sits at its texel centre, so node- and cell-registered grids both
 * land exactly on their sample points.
 */
export function gridUV(grid: Pick<Grid, "width" | "height" | "res" | "latNorth" | "lonWest">, lat: number, lon: number): [number, number] {
  const spanLon = grid.width * grid.res;
  let u = (lon - grid.lonWest) / spanLon + 0.5 / grid.width;
  u -= Math.floor(u);                      // longitude wraps (RepeatWrapping)
  const v = (grid.latNorth - lat) / (grid.height * grid.res) + 0.5 / grid.height;
  return [u, v];
}

/** Nearest grid node to (lat, lon): row and column indices. */
export function nearestCell(grid: Pick<Grid, "width" | "height" | "res" | "latNorth" | "lonWest">, lat: number, lon: number): [number, number] {
  const row = Math.min(grid.height - 1, Math.max(0, Math.round((grid.latNorth - lat) / grid.res)));
  const col = ((Math.round((lon - grid.lonWest) / grid.res) % grid.width) + grid.width) % grid.width;
  return [row, col];
}

/**
 * Ray–unit-sphere intersection (globe/ §5: displacement is ignored; at ×40 the
 * error is < 0.2° and a pick snaps to a 4 km tile anyway). Returns the nearer hit.
 */
export function raySphere(origin: Vec3, dir: Vec3, radius = 1): Vec3 | null {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) return null;
  return [ox + t * dx, oy + t * dy, oz + t * dz];
}

/** Great-circle angle between two points, degrees. */
export function angularDistance(a: LatLon, b: LatLon): number {
  const [ax, ay, az] = latLonToVec3(a.lat, a.lon);
  const [bx, by, bz] = latLonToVec3(b.lat, b.lon);
  return Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz))) / DEG;
}
