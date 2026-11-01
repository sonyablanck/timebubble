import type { Occurrence, OccurrenceNear } from "./types";

// data/ §4. ecology/{age}.json maps bin keys to occurrences. A bin key names the
// south-west corner of a 5° bin, e.g. "35_-5" covers 35–40°N, 5°W–0°.
// pipeline step 5 (bin_occurrences.py) must use the same convention: binKey() below.

export const BIN_DEG = 5;
export const EARTH_RADIUS_KM = 6371;

export const PLANT_BODY_PLANS: ReadonlySet<string> = new Set([
  "conifer", "cycad_bennettitalean", "ginkgo", "fern", "horsetail", "early_angiosperm", "seed_fern",
]);

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

export function binKey(lat: number, lon: number, binDeg = BIN_DEG): string {
  const la = Math.min(Math.floor(lat / binDeg) * binDeg, 90 - binDeg); // 90°N joins the top bin
  const lo = Math.floor(wrapLon(lon) / binDeg) * binDeg;
  return `${la}_${lo}`;
}

export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export class EcologyIndex {
  /** False when the slice has no ecology file yet (fossil pipeline not run). */
  readonly available: boolean;
  private readonly bins: Map<string, Occurrence[]>;

  constructor(raw: Record<string, Occurrence[]> | null) {
    this.available = raw !== null;
    this.bins = new Map(Object.entries(raw ?? {}));
  }

  get binCount(): number {
    return this.bins.size;
  }

  binKeys(): string[] {
    return [...this.bins.keys()];
  }

  bin(key: string): readonly Occurrence[] {
    return this.bins.get(key) ?? [];
  }

  /** Bin keys that could hold points within radiusKm of (lat, lon). */
  binsWithin(lat: number, lon: number, radiusKm: number): string[] {
    const dLat = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
    const latMin = Math.max(-90, lat - dLat);
    const latMax = Math.min(90, lat + dLat);
    const keys = new Set<string>();
    // near a pole, or a radius wider than the band allows: scan all longitudes
    const maxAbsLat = Math.max(Math.abs(latMin), Math.abs(latMax));
    const cosLat = Math.cos((maxAbsLat * Math.PI) / 180);
    const dLon = cosLat < 1e-6 ? 360 : Math.min(360, dLat / cosLat);
    const lonSteps = dLon >= 180 ? null : [lon - dLon, lon + dLon];
    for (let la = Math.floor(latMin / BIN_DEG) * BIN_DEG; la <= latMax; la += BIN_DEG) {
      if (lonSteps === null) {
        for (let lo = -180; lo < 180; lo += BIN_DEG) keys.add(binKey(la, lo));
      } else {
        for (let lo = Math.floor(lonSteps[0]! / BIN_DEG) * BIN_DEG; lo <= lonSteps[1]!; lo += BIN_DEG) {
          keys.add(binKey(la, lo));
        }
      }
    }
    return [...keys];
  }

  /** Occurrences within radiusKm (great circle), each annotated with its distance; nearest first. */
  near(lat: number, lon: number, radiusKm: number): OccurrenceNear[] {
    const out: OccurrenceNear[] = [];
    for (const key of this.binsWithin(lat, lon, radiusKm)) {
      for (const o of this.bins.get(key) ?? []) {
        const d = greatCircleKm(lat, lon, o.lat, o.lon);
        if (d <= radiusKm) out.push({ ...o, distanceKm: d });
      }
    }
    return out.sort((a, b) => a.distanceKm - b.distanceKm || a.id - b.id);
  }

  plantsNear(lat: number, lon: number, radiusKm: number): OccurrenceNear[] {
    return this.near(lat, lon, radiusKm).filter((o) => PLANT_BODY_PLANS.has(o.body_plan));
  }
}
