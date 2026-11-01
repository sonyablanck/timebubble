// Test helpers: an in-memory fetcher and synthetic assets laid out exactly as the pipeline writes them.
import { gzipSync } from "node:zlib";
import type { Fetcher, Manifest, SliceEntry, TerrainGridSpec } from "./types";

export type Asset = Uint8Array | string | (() => Uint8Array | string);

export interface MockFetcher extends Fetcher {
  calls: string[];
  failNext: (count: number, status?: number) => void;
}

/** Serves `files` keyed by path relative to `base`; the query string is ignored. */
export function mockFetcher(files: Map<string, Asset>, base = "/data/"): MockFetcher {
  let failures = 0;
  let failStatus = 500;
  const fn = (async (url: string) => {
    fn.calls.push(url);
    if (failures > 0) {
      failures -= 1;
      if (failStatus === 0) throw new TypeError("network down");
      return new Response("boom", { status: failStatus });
    }
    const path = url.split("?")[0]!.slice(base.length);
    const asset = files.get(path);
    if (asset === undefined) return new Response("nope", { status: 404 });
    const body = typeof asset === "function" ? asset() : asset;
    return new Response(typeof body === "string" ? body : (body as Uint8Array<ArrayBuffer>));
  }) as MockFetcher;
  fn.calls = [];
  fn.failNext = (count, status = 500) => { failures = count; failStatus = status; };
  return fn;
}

export function int16Bytes(values: ArrayLike<number>, gzip = true): Uint8Array {
  const arr = Int16Array.from(values);
  const bytes = new Uint8Array(arr.buffer);
  return gzip ? new Uint8Array(gzipSync(bytes, { level: 1 })) : bytes;
}

export const TERRAIN: TerrainGridSpec = {
  nlat: 1801, nlon: 3600, res: 0.1, registration: "node", lat_north: 90, lon_west: -180,
  cells_per_chunk: 100, stored_per_chunk: 101, chunk_rows: 19, chunk_cols: 36,
};

/** Deterministic synthetic 0.1° elevation, int16-safe. */
export function demValue(row: number, col: number): number {
  return ((row * 37 + col * 11) % 20000) - 8000;
}

/** Chunk (R, C) exactly as pipeline/ingest_dem.py builds it: rows clamp, columns wrap. */
export function demChunk(R: number, C: number, fn: (row: number, col: number) => number = demValue): number[] {
  const out: number[] = [];
  for (let i = 0; i < 101; i++) {
    const row = Math.min(R * 100 + i, TERRAIN.nlat - 1);
    for (let j = 0; j < 101; j++) out.push(fn(row, (C * 100 + j) % TERRAIN.nlon));
  }
  return out;
}

/** A smooth, realistic-looking synthetic 0.1° DEM: a continent with a mountain belt, seas around it. */
export function smoothDem(row: number, col: number): number {
  const lat = 90 - row * 0.1, lon = -180 + col * 0.1;
  const r = Math.hypot(lat - 30, (lon - 10) * Math.cos((30 * Math.PI) / 180));
  const continent = 1800 * Math.exp(-((r / 25) ** 2)) - 1500;
  const ridge = 2500 * Math.exp(-(((lat - 35 - 0.3 * (lon - 10)) / 1.2) ** 2)) * (r < 20 ? 1 : 0.2);
  const texture = 120 * Math.sin(lat * 3.1) * Math.cos(lon * 2.7) + 60 * Math.sin(lat * 17 + lon * 13);
  return Math.round(continent + ridge + texture);
}

export function globeValues(fn: (row: number, col: number) => number): number[] {
  const out: number[] = [];
  for (let r = 0; r < 181; r++) for (let c = 0; c < 360; c++) out.push(fn(r, c));
  return out;
}

export function sliceEntry(age: number, ecology: string | null = null): SliceEntry {
  return {
    age,
    label: `${age} Ma`,
    period: "Jurassic",
    epoch: "Late Jurassic",
    aftermath_mode: age < 66,
    globe: `globe/${age}.i16.gz`,
    globe_meta: `globe/${age}.json`,
    continentality: `globe/${age}.continentality.i16.gz`,
    temperature: `globe/${age}.temp.i16.gz`,
    precipitation: `globe/${age}.precip.i16.gz`,
    climate_meta: `globe/${age}.climate.json`,
    terrain: `terrain/${age}/index.json`,
    ecology,
    grid: { width: 360, height: 181, res: 1, registration: "node", lat_north: 90, lon_west: -180 },
    terrain_grid: TERRAIN,
  };
}

export function manifest(ages: number[], extra: Partial<Manifest> = {}): Manifest {
  return {
    schema: 1,
    pipeline_version: "0.1.0",
    plate_model: "PALEOMAP v19o_r1d (Scotese et al. 2024)",
    dem_source: "test",
    data_version: "abc123",
    kpg_ma: 66,
    slices: ages.map((a) => sliceEntry(a)),
    ...extra,
  };
}

/** A complete synthetic data root for the given ages. Chunks are generated on request. */
export function dataRoot(ages: number[], opts: { dropChunk?: string; ecology?: Record<string, unknown>; demFn?: (row: number, col: number) => number } = {}) {
  const m = manifest(ages);
  const files = new Map<string, Asset>();
  for (const s of m.slices) {
    const a = s.age;
    files.set(s.globe, int16Bytes(globeValues((r, c) => (r - 90) * 10 + (c % 7))));
    files.set(s.continentality, int16Bytes(globeValues((r) => 500 - r)));
    files.set(s.temperature, int16Bytes(globeValues((r) => 3000 - Math.abs(r - 90) * 30)));   // °C × 100
    files.set(s.precipitation, int16Bytes(globeValues((r) => 300 + (r % 10))));               // mm/day × 100
    files.set(s.climate_meta, JSON.stringify({ age: a, temp: { source_age: a }, precip: { source_age: a } }));
    const chunks: Record<string, string> = {};
    for (let R = 0; R < 19; R++) {
      for (let C = 0; C < 36; C++) {
        const key = `${R}_${C}`;
        if (key === opts.dropChunk) continue;
        chunks[key] = `r${R}_c${C}.i16.gz`;
        files.set(`terrain/${a}/r${R}_c${C}.i16.gz`, () => int16Bytes(demChunk(R, C, opts.demFn), false));
      }
    }
    files.set(s.terrain, JSON.stringify({ ...TERRAIN, age: a, chunks }));
    if (opts.ecology) {
      s.ecology = `ecology/${a}.json`;
      files.set(s.ecology, JSON.stringify(opts.ecology));
    }
  }
  files.set("manifest.json", JSON.stringify(m));
  return { manifest: m, files, fetcher: mockFetcher(files) };
}
