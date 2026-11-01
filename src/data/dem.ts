import { DataError } from "./errors";
import { fetchInt16, fetchJson } from "./fetch";
import { LRU } from "./lru";
import type { Fetcher, TerrainGridSpec, TerrainIndex } from "./types";

// data/ §3. The 0.1° DEM is stored as 10° × 10° chunks of 101 × 101 int16 values:
// chunk (R, C) holds global rows R*100 .. R*100+100 and columns C*100 .. C*100+100
// (one overlap row to the south, one overlap column to the east, wrapping at ±180°).
// The sampler is synchronous so terrain's inner loops never await; call
// ensureRegion() first, once per tile.

export const OCEAN_SENTINEL_M = -4000;
export const DEFAULT_CHUNK_CAPACITY = 16; // ≈ 330 KB of int16 per thread

export type ChunkCache = LRU<string, Int16Array>;

export function makeChunkCache(capacity = DEFAULT_CHUNK_CAPACITY): ChunkCache {
  return new LRU<string, Int16Array>(capacity);
}

export class DemSampler {
  readonly age: number;
  readonly spec: TerrainGridSpec;
  readonly resolution: number;
  readonly registration: TerrainGridSpec["registration"];
  /** Chunk keys that were absent from the index and replaced by the ocean sentinel. */
  readonly sentinelChunks = new Set<string>();

  private index: TerrainIndex | null = null;
  private indexPromise: Promise<TerrainIndex> | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly n: number;
  private readonly stored: number;

  constructor(
    age: number,
    spec: TerrainGridSpec,
    private readonly indexUrl: string,
    private readonly chunkUrl: (file: string) => string,
    private readonly fetcher: Fetcher,
    private readonly cache: ChunkCache,
  ) {
    this.age = age;
    this.spec = spec;
    this.resolution = spec.res;
    this.registration = spec.registration;
    this.n = spec.cells_per_chunk;
    this.stored = spec.stored_per_chunk;
  }

  get nlat(): number {
    return this.spec.nlat;
  }

  get nlon(): number {
    return this.spec.nlon;
  }

  /** Fractional row index of a latitude (0 = north edge). */
  latIdxOf(lat: number): number {
    return (this.spec.lat_north - lat) / this.spec.res;
  }

  /** Fractional column index of a longitude, wrapped into [0, nlon). */
  lonIdxOf(lon: number): number {
    const c = (lon - this.spec.lon_west) / this.spec.res;
    return ((c % this.nlon) + this.nlon) % this.nlon;
  }

  chunkKeyFor(latIdx: number, lonIdx: number): string {
    return `${Math.floor(latIdx / this.n)}_${Math.floor(lonIdx / this.n)}`;
  }

  private cacheKey(key: string): string {
    return `${this.age}/${key}`;
  }

  private async loadIndex(): Promise<TerrainIndex> {
    if (this.index) return this.index;
    this.indexPromise ??= fetchJson<TerrainIndex>(this.fetcher, this.indexUrl).then((idx) => {
      if (idx.nlat !== this.spec.nlat || idx.nlon !== this.spec.nlon || idx.stored_per_chunk !== this.stored) {
        throw new DataError("format", this.indexUrl, "terrain index does not match the manifest's terrain_grid");
      }
      this.index = idx;
      return idx;
    });
    return this.indexPromise;
  }

  /** Chunk keys covering the cell box around (lat, lon) ± radiusCells; longitude wraps. */
  keysForRegion(lat: number, lon: number, radiusCells: number): string[] {
    const r0 = Math.floor(this.latIdxOf(lat)) - radiusCells;
    const r1 = Math.ceil(this.latIdxOf(lat)) + radiusCells;
    const c0 = Math.floor(this.lonIdxOf(lon)) - radiusCells;
    const c1 = Math.ceil(this.lonIdxOf(lon)) + radiusCells;
    const keys = new Set<string>();
    for (let r = Math.max(r0, 0); r <= Math.min(r1, this.nlat - 1); r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const cw = ((c % this.nlon) + this.nlon) % this.nlon;
        keys.add(this.chunkKeyFor(r, cw));
      }
    }
    return [...keys].sort();
  }

  /** Load every chunk needed to sample around (lat, lon). Safe to call concurrently. */
  async ensureRegion(lat: number, lon: number, radiusCells: number): Promise<void> {
    const index = await this.loadIndex();
    const keys = this.keysForRegion(lat, lon, radiusCells);
    if (keys.length > this.cache.capacity) {
      throw new DataError("region", this.indexUrl,
        `region needs ${keys.length} chunks but the cache holds ${this.cache.capacity}`);
    }
    await Promise.all(keys.map((k) => this.loadChunk(index, k)));
    for (const k of keys) this.cache.get(this.cacheKey(k)); // mark as recently used
  }

  private loadChunk(index: TerrainIndex, key: string): Promise<void> {
    const ck = this.cacheKey(key);
    if (this.cache.has(ck)) return Promise.resolve();
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const file = index.chunks[key];
    if (!file) {
      // Guard only: the pipeline writes every chunk (tested there).
      console.warn(`[data] terrain ${this.age} Ma: chunk ${key} missing from index; using ocean sentinel`);
      this.sentinelChunks.add(key);
      this.cache.set(ck, new Int16Array(this.stored * this.stored).fill(OCEAN_SENTINEL_M));
      return Promise.resolve();
    }
    const p = fetchInt16(this.fetcher, this.chunkUrl(file), this.stored * this.stored)
      .then((arr) => this.cache.set(ck, arr))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /** Elevation in metres at a 0.1° cell. Synchronous; never fetches. */
  cell(latIdx: number, lonIdx: number): number {
    const r = Math.min(Math.max(Math.trunc(latIdx), 0), this.nlat - 1);
    const c = ((Math.trunc(lonIdx) % this.nlon) + this.nlon) % this.nlon;
    const chunk = this.cache.peek(this.cacheKey(this.chunkKeyFor(r, c)));
    if (!chunk) {
      throw new DataError("region", `terrain/${this.age}`,
        `cell (${r}, ${c}) not loaded: await ensureRegion() before sampling`);
    }
    return chunk[(r % this.n) * this.stored + (c % this.n)]!;
  }
}
