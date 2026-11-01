// Local frame for walk mode (render §1). The scene origin is a palaeo lat/lon (the current tile's
// centre). Positions are local metres: +x east, +y up, −z north, with Earth's curvature applied as
// a drop of d² / 2R. The mapping is a pure function of (lat, lon), so neighbouring tiles projected
// into the same frame share their edges exactly, and rebasing to a new origin is just re-projecting.

import { EARTH_RADIUS_M, wrapLon } from "../terrain/tilegrid";

const DEG = Math.PI / 180;

export class LocalFrame {
  constructor(readonly lat0: number, readonly lon0: number) {}

  /** East and north metres from the origin (no curvature). */
  en(lat: number, lon: number): [number, number] {
    const e = EARTH_RADIUS_M * wrapLon(lon - this.lon0) * DEG * Math.cos(lat * DEG);
    const n = EARTH_RADIUS_M * (lat - this.lat0) * DEG;
    return [e, n];
  }

  /** Curvature drop at a horizontal offset (x, z) from the origin. */
  static drop(x: number, z: number): number {
    return (x * x + z * z) / (2 * EARTH_RADIUS_M);
  }

  /** Local scene position of a point at height h. Writes into out[o..o+2]. */
  project(lat: number, lon: number, h: number, out: Float32Array | number[], o = 0): void {
    const [e, n] = this.en(lat, lon);
    out[o] = e;
    out[o + 1] = h - LocalFrame.drop(e, n);
    out[o + 2] = -n;
  }

  /** Inverse of the horizontal part: local (x, z) → lat/lon. Exact for the mapping above. */
  toLatLon(x: number, z: number): [number, number] {
    const lat = this.lat0 + (-z / EARTH_RADIUS_M) / DEG;
    const c = Math.max(Math.cos(lat * DEG), 1e-6);
    return [lat, wrapLon(this.lon0 + (x / (EARTH_RADIUS_M * c)) / DEG)];
  }

  /** Re-express a local position of this frame in another frame (for rebasing). */
  transfer(x: number, z: number, to: LocalFrame): [number, number] {
    const [lat, lon] = this.toLatLon(x, z);
    const [e, n] = to.en(lat, lon);
    return [e, -n];
  }
}

/** Sun direction in the local frame (x east, y up, z south) at an equinox (render §6). */
export function sunDirection(latDeg: number, hours: number): [number, number, number] {
  const phi = latDeg * DEG, H = (hours - 12) * 15 * DEG;
  const east = -Math.sin(H);
  const north = -Math.sin(phi) * Math.cos(H);
  const up = Math.cos(phi) * Math.cos(H);
  return [east, up, -north];
}

/** Compass heading in degrees (0 = north, 90 = east) of a local direction. */
export function headingOf(dx: number, dz: number): number {
  return ((Math.atan2(dx, -dz) / DEG) + 360) % 360;
}
