import type { GridSpec, Registration } from "./types";

/**
 * A global lat/lon grid of int16 values: row 0 = north, column 0 = lon −180 (data/ §0).
 * `scale` converts stored integers to physical units (value = stored / scale):
 * 1 for metres and km, 100 for 0.01 °C and 0.01 mm/day.
 */
export class Grid {
  readonly width: number;
  readonly height: number;
  readonly res: number;
  readonly registration: Registration;
  readonly latNorth: number;
  readonly lonWest: number;
  readonly scale: number;
  readonly values: Int16Array;

  constructor(spec: GridSpec, values: Int16Array, scale = 1) {
    if (values.length !== spec.width * spec.height) {
      throw new Error(`grid has ${values.length} values, expected ${spec.width}×${spec.height}`);
    }
    this.width = spec.width;
    this.height = spec.height;
    this.res = spec.res;
    this.registration = spec.registration;
    this.latNorth = spec.lat_north;
    this.lonWest = spec.lon_west;
    this.scale = scale;
    this.values = values;
  }

  /** Stored integer at (row, column); longitude wraps, latitude clamps. */
  at(latIdx: number, lonIdx: number): number {
    const r = Math.min(Math.max(latIdx, 0), this.height - 1);
    const c = ((lonIdx % this.width) + this.width) % this.width;
    return this.values[r * this.width + c]!;
  }

  /** Physical value at (row, column), i.e. at() / scale. */
  valueAt(latIdx: number, lonIdx: number): number {
    return this.at(latIdx, lonIdx) / this.scale;
  }

  /** Fractional row for a latitude (0 at latNorth). */
  /** Bilinear value in physical units at (lat, lon); node grids hold values at integer indices. */
  bilinear(lat: number, lon: number): number {
    const off = this.registration === "cell" ? 0.5 : 0;
    const u = this.rowOf(lat) - off, v = (lon - this.lonWest) / this.res - off;
    const i = Math.floor(u), j = Math.floor(v), y = u - i, x = v - j;
    const a = this.at(i, j), b = this.at(i, j + 1), c = this.at(i + 1, j), d = this.at(i + 1, j + 1);
    return ((a * (1 - x) + b * x) * (1 - y) + (c * (1 - x) + d * x) * y) / this.scale;
  }

  rowOf(lat: number): number {
    return (this.latNorth - lat) / this.res;
  }

  /** Fractional column for a longitude, in [0, width). */
  colOf(lon: number): number {
    const c = (lon - this.lonWest) / this.res;
    return ((c % this.width) + this.width) % this.width;
  }

  latOf(row: number): number {
    return this.latNorth - row * this.res;
  }

  lonOf(col: number): number {
    return this.lonWest + col * this.res;
  }
}
