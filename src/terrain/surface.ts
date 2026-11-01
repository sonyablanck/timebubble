import type { DemSampler } from "../data";
import { F } from "../provenance/flags";
import { Fractal, hash32 } from "./noise";

// terrain/ §3–6: the one continuous global terrain function for a slice,
//
//   H(lat, lon) = S + D + r_c · ψ_c
//
//   S   smooth interpolation of the 0.1° PaleoDEM (Catmull-Rom: passes through the
//       source values, so land/sea at the nodes matches the data)          → data
//   D   detail noise, amplitude by terrain class, damped at the coast      → generated
//   ψ_c a bump inside source cell c: zero (with zero slope) on the cell's edges,
//       mean 1 over the cell; r_c = source_c − mean_c(S + D)
//
// so the mean of H over every 0.1° cell equals the source value (DESIGN §2 rule 1)
// exactly, using only that cell: no iterative solve, nothing that depends on which
// tile is asking, and seams match because H depends on position alone.
//
// Hsmooth = S + r'_c · ψ_c with r'_c = source_c − mean_c(S) is the same surface
// without generated detail: the far horizon (render §5) and biome's "lowness" use it.

export const CELL_SAMPLES = 64;        // per side, for mean(S + D) over a cell
export const SMOOTH_SAMPLES = 16;      // per side, for mean(S) (smooth: few samples suffice)
const R = 6_371_000;
const DEG = Math.PI / 180;
const M_PER_DEG = R * DEG;

export enum TerrainClass { Abyssal, ShelfSlope, CoastalPlain, Lowland, Plateau, Orogen }
export const CLASS_NAMES = ["abyssal", "shelf/slope", "coastal plain", "lowland", "plateau", "orogen"] as const;
/** Detail amplitude per class, metres (terrain §4b; starting values to tune). */
export const CLASS_AMPLITUDE = [20, 40, 4, 60, 40, 600];

export const DETAIL = { lambdaMax: 8000, octaves: 9, gain: 0.5 }; // 8 km → 31 m
const COAST_DAMP_M = 30;
const WARP_LAMBDA = 6000;
const WARP_AMP = 1500;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const bump = (x: number, a: number, b: number) => {
  const w = 0.15 * (b - a);
  return smoothstep(a - w, a + w, x) * (1 - smoothstep(b - w, b + w, x));
};

function crWeights(t: number, out: Float64Array, dOut: Float64Array): void {
  const t2 = t * t, t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
  dOut[0] = 0.5 * (-3 * t2 + 4 * t - 1);
  dOut[1] = 0.5 * (9 * t2 - 10 * t);
  dOut[2] = 0.5 * (-9 * t2 + 8 * t + 1);
  dOut[3] = 0.5 * (3 * t2 - 2 * t);
}

/** ψ on [0,1]²: C¹ bump, zero value and slope on the edges, mean exactly 1. */
export function psi(s: number, t: number): number {
  const a = s * (1 - s), b = t * (1 - t);
  return 900 * a * a * b * b;
}

export interface Base { h: number; dN: number; dE: number } // m, and m/m towards north / east

export interface SurfaceSample {
  h: number;           // H, metres
  smooth: number;      // Hsmooth, metres
  generated: number;   // H − Hsmooth: the invented part
  base: number;        // S
  cls: TerrainClass;   // dominant class
  amp: number;         // local detail amplitude, metres
  strength: number;    // |generated| / amp, 0..1 (provenance gradient)
  flags: number;       // provenance registry bits
  cellLat: number;     // centre of the source cell (for info cards)
  cellLon: number;
  source: number;      // the source cell's elevation
}

interface CellCorr { r: number; rSmooth: number }

/** A rectangular window of DEM nodes copied from the chunk cache, for fast synchronous reads. */
class Window {
  constructor(readonly i0: number, readonly j0: number, readonly rows: number, readonly cols: number, readonly v: Float32Array) {}
  at(i: number, j: number): number {
    const r = i - this.i0, c = j - this.j0;
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) throw new Error(`DEM node (${i}, ${j}) outside the prepared window`);
    return this.v[r * this.cols + c]!;
  }
}

export class Surface {
  readonly age: number;
  private readonly fractal: Fractal;
  private readonly res: number;
  private readonly latNorth: number;
  private readonly lonWest: number;
  private readonly nlat: number;
  private readonly nlon: number;
  private win: Window | null = null;
  private readonly cells = new Map<string, CellCorr>();
  private readonly smoothCells = new Map<string, number>();
  private readonly wu = new Float64Array(4);
  private readonly wv = new Float64Array(4);
  private readonly du = new Float64Array(4);
  private readonly dv = new Float64Array(4);

  constructor(private readonly dem: DemSampler, age: number) {
    this.age = age;
    this.fractal = new Fractal(hash32("terrain", age), DETAIL);
    this.res = dem.spec.res;
    this.latNorth = dem.spec.lat_north;
    this.lonWest = dem.spec.lon_west;
    this.nlat = dem.spec.nlat;
    this.nlon = dem.spec.nlon;
  }

  /** Load DEM chunks and copy a node window covering the box plus a 4-node margin. */
  async prepare(latS: number, latN: number, lonW: number, lonE: number): Promise<void> {
    const i0 = Math.floor((this.latNorth - latN) / this.res) - 4;
    const i1 = Math.ceil((this.latNorth - latS) / this.res) + 4;
    const j0 = Math.floor((lonW - this.lonWest) / this.res) - 4;
    const j1 = Math.ceil((lonE - this.lonWest) / this.res) + 4;
    const cLat = (latS + latN) / 2, cLon = (lonW + lonE) / 2;
    const radius = Math.max(i1 - i0, j1 - j0) / 2 + 1;
    await this.dem.ensureRegion(cLat, cLon, Math.ceil(radius));
    const rows = i1 - i0 + 1, cols = j1 - j0 + 1;
    const v = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) v[r * cols + c] = this.dem.cell(i0 + r, j0 + c);   // clamps lat, wraps lon
    }
    this.win = new Window(i0, j0, rows, cols, v);
  }

  private node(i: number, j: number): number {
    return this.win!.at(i, j);
  }

  /**
   * Distance in km to the nearest 0.1° source node below sea level, searching up to maxKm
   * (returns maxKm if none). Uses the prepared window; for biome's coastal terms.
   */
  nearestSeaKm(lat: number, lon: number, maxKm = 25): number {
    const u = (this.latNorth - lat) / this.res, v = (lon - this.lonWest) / this.res;
    const kmPerNode = 111.195 * this.res;
    const cl = Math.max(Math.cos(lat * DEG), 0.05);
    const ri = Math.ceil(maxKm / kmPerNode), rj = Math.min(Math.ceil(maxKm / (kmPerNode * cl)), 40);
    const i0 = Math.round(u), j0 = Math.round(v);
    let best = maxKm;
    for (let i = i0 - ri; i <= i0 + ri; i++) {
      for (let j = j0 - rj; j <= j0 + rj; j++) {
        const w = this.win!;
        if (i < w.i0 || j < w.j0 || i >= w.i0 + w.rows || j >= w.j0 + w.cols) continue;   // outside the prepared window
        if (w.at(i, j) >= 0) continue;
        const d = Math.hypot((i - u) * kmPerNode, (j - v) * kmPerNode * cl);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** Catmull-Rom interpolation of the source nodes, with its gradient. */
  base(lat: number, lon: number): Base {
    const u = (this.latNorth - lat) / this.res;
    const v = (lon - this.lonWest) / this.res;
    const i0 = Math.floor(u), j0 = Math.floor(v);
    crWeights(u - i0, this.wu, this.du);
    crWeights(v - j0, this.wv, this.dv);
    let h = 0, hu = 0, hv = 0;
    for (let a = 0; a < 4; a++) {
      let row = 0, rowDv = 0;
      for (let b = 0; b < 4; b++) {
        const z = this.node(i0 - 1 + a, j0 - 1 + b);
        row += this.wv[b]! * z;
        rowDv += this.dv[b]! * z;
      }
      h += this.wu[a]! * row;
      hu += this.du[a]! * row;
      hv += this.wu[a]! * rowDv;
    }
    const cosLat = Math.max(Math.cos(lat * DEG), 1e-6);
    return { h, dN: -hu / (this.res * M_PER_DEG), dE: hv / (this.res * M_PER_DEG * cosLat) };
  }

  /** Terrain-class weights (terrain §4a), from the smooth base only, so they are tile-independent. */
  classWeights(h: number, slopeMPerKm: number, out: Float64Array): void {
    const s = slopeMPerKm;
    out[TerrainClass.Abyssal] = 1 - smoothstep(-4000, -3000, h);
    out[TerrainClass.ShelfSlope] = bump(h, -3000, -200) * (0.5 + 0.5 * smoothstep(5, 30, s));
    out[TerrainClass.CoastalPlain] = bump(h, -200, 150) * (1 - smoothstep(5, 20, s));
    out[TerrainClass.Lowland] = bump(h, 100, 1200);
    out[TerrainClass.Plateau] = smoothstep(800, 1500, h) * (1 - smoothstep(10, 40, s));
    out[TerrainClass.Orogen] = Math.max(smoothstep(1500, 3000, h), smoothstep(40, 100, s));
    let sum = 0;
    for (let k = 0; k < 6; k++) sum += out[k]!;
    if (sum < 1e-6) { out.fill(0); out[TerrainClass.Lowland] = 1; return; }
    for (let k = 0; k < 6; k++) out[k]! /= sum;
  }

  private readonly cw = new Float64Array(6);

  /** Damped detail noise at a point, plus the local amplitude and dominant class. */
  detail(lat: number, lon: number, b: Base): { d: number; amp: number; cls: TerrainClass } {
    const slope = Math.hypot(b.dN, b.dE) * 1000;
    const w = this.cw;
    this.classWeights(b.h, slope, w);
    let amp = 0, cls = 0, best = -1;
    for (let k = 0; k < 6; k++) {
      amp += w[k]! * CLASS_AMPLITUDE[k]!;
      if (w[k]! > best) { best = w[k]!; cls = k; }
    }
    const cl = Math.cos(lat * DEG);
    let x = R * cl * Math.sin(lon * DEG), y = R * Math.sin(lat * DEG), z = R * cl * Math.cos(lon * DEG);
    const warp = WARP_AMP * (0.4 * w[TerrainClass.Lowland]! + w[TerrainClass.Orogen]!);
    if (warp > 1) {
      const fx = this.fractal.low(x, y, z, WARP_LAMBDA, 0);
      const fy = this.fractal.low(x, y, z, WARP_LAMBDA, 1);
      const fz = this.fractal.low(x, y, z, WARP_LAMBDA, 2);
      x += warp * fx; y += warp * fy; z += warp * fz;
    }
    const n = this.fractal.eval(x, y, z, w[TerrainClass.Orogen]! > 0.01);
    let d = 0;
    for (let k = 0; k < 6; k++) d += w[k]! * CLASS_AMPLITUDE[k]! * (k === TerrainClass.Orogen ? n.ridged : n.fbm);
    d *= smoothstep(0, COAST_DAMP_M, Math.abs(b.h));
    return { d, amp: Math.max(amp, 1), cls: cls as TerrainClass };
  }

  private cellOf(lat: number, lon: number): { ic: number; jr: number; jc: number; s: number; t: number } {
    const u = (this.latNorth - lat) / this.res;
    const v = (lon - this.lonWest) / this.res;
    const ic = Math.round(u), jr = Math.round(v);
    return { ic, jr, jc: ((jr % this.nlon) + this.nlon) % this.nlon, s: u - (ic - 0.5), t: v - (jr - 0.5) };
  }

  private cellLatLon(ic: number, jr: number, a: number, b: number): [number, number] {
    return [this.latNorth - (ic - 0.5 + a) * this.res, this.lonWest + (jr - 0.5 + b) * this.res];
  }

  /** r_c: source minus mean(S + D) over cell c (memoised; depends on the cell alone). */
  private corr(ic: number, jr: number, jc: number): CellCorr {
    const key = `${ic}_${jc}`;
    let c = this.cells.get(key);
    if (c) return c;
    const src = this.node(ic, jr);
    let sum = 0;
    const K = CELL_SAMPLES;
    for (let a = 0; a < K; a++) {
      for (let b = 0; b < K; b++) {
        const [lat, lon] = this.cellLatLon(ic, jr, (a + 0.5) / K, (b + 0.5) / K);
        const base = this.base(lat, lon);
        sum += base.h + this.detail(lat, lon, base).d;
      }
    }
    c = { r: src - sum / (K * K), rSmooth: this.smoothCorr(ic, jr, jc) };
    if (this.cells.size > 512) this.cells.delete(this.cells.keys().next().value as string);
    this.cells.set(key, c);
    return c;
  }

  /** r'_c: source minus mean(S) over cell c (memoised). */
  private smoothCorr(ic: number, jr: number, jc: number): number {
    const key = `${ic}_${jc}`;
    let r = this.smoothCells.get(key);
    if (r !== undefined) return r;
    let sum = 0;
    const K = SMOOTH_SAMPLES;
    for (let a = 0; a < K; a++) {
      for (let b = 0; b < K; b++) {
        const [lat, lon] = this.cellLatLon(ic, jr, (a + 0.5) / K, (b + 0.5) / K);
        sum += this.base(lat, lon).h;
      }
    }
    r = this.node(ic, jr) - sum / (K * K);
    if (this.smoothCells.size > 4096) this.smoothCells.delete(this.smoothCells.keys().next().value as string);
    this.smoothCells.set(key, r);
    return r;
  }

  /** Hsmooth only: the data surface without generated detail (far horizon). */
  smooth(lat: number, lon: number): number {
    const cell = this.cellOf(lat, lon);
    return this.base(lat, lon).h + this.smoothCorr(cell.ic, cell.jr, cell.jc) * psi(cell.s, cell.t);
  }

  /** Everything a tile vertex needs. */
  sample(lat: number, lon: number): SurfaceSample {
    const b = this.base(lat, lon);
    const { d, amp, cls } = this.detail(lat, lon, b);
    const cell = this.cellOf(lat, lon);
    const { r, rSmooth } = this.corr(cell.ic, cell.jr, cell.jc);
    const p = psi(cell.s, cell.t);
    const h = b.h + d + r * p;
    const smooth = b.h + rSmooth * p;
    const generated = h - smooth;
    let flags = F.DATA_SURFACE;
    if (Math.abs(generated) > 2) flags |= F.GENERATED_RELIEF;
    if ((h >= 0) !== (smooth >= 0)) flags |= F.GENERATED_COAST;
    const [cellLat, cellLon] = this.cellLatLon(cell.ic, cell.jr, 0.5, 0.5);
    return {
      h, smooth, generated, base: b.h, cls, amp,
      strength: Math.min(1, Math.abs(generated) / amp), flags,
      cellLat, cellLon, source: this.node(cell.ic, cell.jr),
    };
  }

  /** H only (cheaper call sites, tests). */
  height(lat: number, lon: number): number {
    return this.sample(lat, lon).h;
  }
}
