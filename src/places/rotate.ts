import { Grid } from "../data/grid";
import type { GridSpec } from "../data/types";

// places/ §1: where a present-day place was at a slice, without pyGPlates.
// The pipeline (pipeline/places.py) bakes a 0.1° grid of present-day plates and, per slice and
// plate, the unit quaternion of pyGPlates' finite rotation from 0 Ma. Rotating a point here is
// one grid lookup and one quaternion product, and lands within centimetres of pyGPlates.

export interface PlacesMeta {
  schema: number;
  plate_model: string;
  grid: GridSpec & { file: string };
  units: [number, number | null][];                       // [plate_id, crust_from_ma | null]; index 0 = no plate
  rotations: Record<string, Record<string, [number, number, number, number]>>;   // age → plate → [w, x, y, z]
  method: string;
}

export type PlacePosition =
  | { status: "ok"; lat: number; lon: number; plate: number; crustFromMa: number | null }
  /** The model has no crust at this spot before `crustFromMa` (young seafloor, Iceland, a terrane accreted later). */
  | { status: "not-formed"; plate: number; crustFromMa: number }
  /** Outside every plate polygon (rare: gaps in the model). */
  | { status: "no-plate" };

type Quat = readonly [number, number, number, number];

export function toVec(lat: number, lon: number): [number, number, number] {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

export function toLatLon([x, y, z]: readonly number[]): { lat: number; lon: number } {
  const lat = (Math.asin(Math.max(-1, Math.min(1, z!))) * 180) / Math.PI;
  let lon = (Math.atan2(y!, x!) * 180) / Math.PI;
  if (lon >= 180) lon -= 360;
  return { lat, lon };
}

/** v' = q v q*, written out (v + 2u × (u × v + w v)). */
export function rotateVec([w, x, y, z]: Quat, [vx, vy, vz]: readonly [number, number, number]): [number, number, number] {
  const cx = y * vz - z * vy + w * vx, cy = z * vx - x * vz + w * vy, cz = x * vy - y * vx + w * vz;
  return [vx + 2 * (y * cz - z * cy), vy + 2 * (z * cx - x * cz), vz + 2 * (x * cy - y * cx)];
}

export class PlaceIndex {
  readonly plateModel: string;
  private readonly grid: Grid;

  constructor(readonly meta: PlacesMeta, units: Int16Array) {
    this.plateModel = meta.plate_model;
    this.grid = new Grid(meta.grid, units, 1);
  }

  /** Present-day plate and crust age at a point, or null outside every plate polygon. */
  unitAt(lat: number, lon: number): { plate: number; crustFromMa: number | null } | null {
    const row = Math.min(Math.floor(this.grid.rowOf(lat)), this.grid.height - 1);
    const col = Math.floor(this.grid.colOf(lon));
    const u = this.meta.units[this.grid.at(row, col)];
    if (!u || u[0] === 0) return null;
    return { plate: u[0], crustFromMa: u[1] };
  }

  /** Where the present-day point (lat, lon) was at `age` Ma. */
  locate(lat: number, lon: number, age: number): PlacePosition {
    const u = this.unitAt(lat, lon);
    if (!u) return { status: "no-plate" };
    if (u.crustFromMa !== null && age > u.crustFromMa) return { status: "not-formed", plate: u.plate, crustFromMa: u.crustFromMa };
    const q = this.meta.rotations[String(age)]?.[String(u.plate)];
    if (!q) throw new Error(`no rotation for plate ${u.plate} at ${age} Ma`);
    const p = toLatLon(rotateVec(q, toVec(lat, lon)));
    return { status: "ok", ...p, plate: u.plate, crustFromMa: u.crustFromMa };
  }
}
