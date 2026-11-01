import { DemSampler, makeChunkCache, type ChunkCache } from "./dem";
import { EcologyIndex } from "./ecology";
import { DataError } from "./errors";
import { fetchInt16, fetchJson } from "./fetch";
import { Grid } from "./grid";
import type { ClimateMeta, ClimateParams, Fetcher, GridSpec, Manifest, Occurrence, SliceEntry } from "./types";

// data/ §1 and §5. One DataStore per thread (main thread, terrain worker); no shared state.

export const MANIFEST_SCHEMA = 1;
export const EXPECTED_PLATE_MODEL = "PALEOMAP v19o_r1d (Scotese et al. 2024)";

export interface DataStoreOptions {
  /** URL of the data root, ending in "/". Defaults to Vite's BASE_URL + "data/". */
  baseUrl?: string;
  fetcher?: Fetcher;
  /** DEM chunk cache size (default 16, ≈ 330 KB). */
  chunkCapacity?: number;
}

export function defaultBaseUrl(): string {
  // import.meta.env exists under Vite; fall back to "/data/" elsewhere (e.g. tests).
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? "/"}data/`;
}

export function validateManifest(m: Manifest, url: string): void {
  const bad = (msg: string) => { throw new DataError("format", url, msg); };
  if (m.schema !== MANIFEST_SCHEMA) bad(`schema ${m.schema}, expected ${MANIFEST_SCHEMA}`);
  if (m.plate_model !== EXPECTED_PLATE_MODEL) bad(`plate model "${m.plate_model}", expected "${EXPECTED_PLATE_MODEL}"`);
  if (!Array.isArray(m.slices) || m.slices.length === 0) bad("no slices");
  const ages = m.slices.map((s) => s.age);
  for (let i = 1; i < ages.length; i++) {
    if (!(ages[i - 1]! > ages[i]!)) bad("slices must be sorted by age, oldest first, with unique ages");
  }
  const paths: (string | null | undefined)[] = [m.climate_params, m.credits];
  for (const s of m.slices) {
    paths.push(s.globe, s.globe_meta, s.continentality, s.temperature, s.precipitation,
      s.climate_meta, s.terrain, s.ecology);
  }
  for (const p of paths) {
    if (p == null) continue;
    if (/^[a-z]+:|^\//i.test(p) || p.split("/").includes("..")) bad(`path "${p}" must be relative, without ".."`);
  }
}

export class DataStore {
  readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly chunks: ChunkCache;
  private manifestPromise: Promise<Manifest> | null = null;
  private climateParamsPromise: Promise<ClimateParams[] | null> | null = null;
  /** Current slice first, then the previous one (data/ §5: keep current + previous). */
  private handles: SliceHandle[] = [];

  constructor(opts: DataStoreOptions = {}) {
    this.baseUrl = opts.baseUrl ?? defaultBaseUrl();
    if (!this.baseUrl.endsWith("/")) this.baseUrl += "/";
    this.fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
    this.chunks = makeChunkCache(opts.chunkCapacity);
  }

  manifest(): Promise<Manifest> {
    this.manifestPromise ??= (async () => {
      const url = this.baseUrl + "manifest.json";
      // the manifest is the one file that must never come from a stale cache
      const m = await fetchJson<Manifest>(this.fetcher, url, { cache: "no-cache" });
      validateManifest(m, url);
      return m;
    })();
    // allow a retry after a failure instead of caching the rejection
    this.manifestPromise.catch(() => { this.manifestPromise = null; });
    return this.manifestPromise;
  }

  /** URL for an asset path, with the data version appended to bust stale caches. */
  url(path: string, version: string): string {
    return `${this.baseUrl}${path}?v=${version}`;
  }

  /** Ages available, oldest first. */
  async ages(): Promise<number[]> {
    return (await this.manifest()).slices.map((s) => s.age);
  }

  /** The slice nearest to `age` (DESIGN A6: snap to nearest; ties go to the older slice). */
  async slice(age: number): Promise<SliceHandle> {
    const m = await this.manifest();
    let best = m.slices[0]!;
    for (const s of m.slices) {
      if (Math.abs(s.age - age) < Math.abs(best.age - age)) best = s;
    }
    const existing = this.handles.find((h) => h.age === best.age);
    const handle = existing ?? new SliceHandle(best, m.data_version, this, this.fetcher, this.chunks);
    const previous = this.handles[0];
    this.handles = [handle, ...this.handles.filter((h) => h !== handle)].slice(0, 2);
    if (previous && previous !== handle) previous.releaseEcology(); // ecology: current slice only
    return handle;
  }

  /** climate_by_age.json, or null until it has been curated (pipeline §1d). */
  climateParams(): Promise<ClimateParams[] | null> {
    this.climateParamsPromise ??= (async () => {
      const m = await this.manifest();
      if (!m.climate_params) return null;
      return fetchJson<ClimateParams[]>(this.fetcher, this.url(m.climate_params, m.data_version));
    })();
    return this.climateParamsPromise;
  }
}

/** Lazy, cached access to one slice's assets. Cheap to create. */
export class SliceHandle {
  readonly age: number;
  readonly label: string;
  readonly period: string;
  readonly epoch: string;
  readonly aftermathMode: boolean;
  readonly entry: SliceEntry;

  private readonly cache = new Map<string, Promise<unknown>>();
  private ecologyPromise: Promise<EcologyIndex> | null = null;
  private demSampler: DemSampler | null = null;

  constructor(
    entry: SliceEntry,
    private readonly version: string,
    private readonly store: DataStore,
    private readonly fetcher: Fetcher,
    private readonly chunks: ChunkCache,
  ) {
    this.entry = entry;
    this.age = entry.age;
    this.label = entry.label;
    this.period = entry.period;
    this.epoch = entry.epoch;
    this.aftermathMode = entry.aftermath_mode;
  }

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key)); // failed loads can be retried
    }
    return p;
  }

  private grid(key: string, path: string, scale: number): Promise<Grid> {
    const spec: GridSpec = this.entry.grid;
    return this.once(key, async () =>
      new Grid(spec, await fetchInt16(this.fetcher, this.store.url(path, this.version), spec.width * spec.height), scale));
  }

  /** 1° elevation, metres. */
  globe(): Promise<Grid> {
    return this.grid("globe", this.entry.globe, 1);
  }

  /** 1° signed distance to coast, km (land +, sea −). */
  continentality(): Promise<Grid> {
    return this.grid("continentality", this.entry.continentality, 1);
  }

  /** 1° mean annual temperature; stored in 0.01 °C, so valueAt() gives °C. */
  temperature(): Promise<Grid> {
    return this.grid("temperature", this.entry.temperature, 100);
  }

  /** 1° mean annual precipitation; stored in 0.01 mm/day, so valueAt() gives mm/day. */
  precipitation(): Promise<Grid> {
    return this.grid("precipitation", this.entry.precipitation, 100);
  }

  /** Source intervals, age mismatches and overrides for the climate grids. */
  climateMeta(): Promise<ClimateMeta> {
    return this.once("climateMeta", () =>
      fetchJson<ClimateMeta>(this.fetcher, this.store.url(this.entry.climate_meta, this.version)));
  }

  /** This slice's climate_by_age.json entry, or null until that file exists. */
  async climate(): Promise<ClimateParams | null> {
    const all = await this.store.climateParams();
    return all?.find((c) => c.age === this.age) ?? null;
  }

  /** 0.1° DEM sampler. Synchronous to sample; await ensureRegion() first. */
  dem(): DemSampler {
    this.demSampler ??= new DemSampler(
      this.age,
      this.entry.terrain_grid,
      this.store.url(this.entry.terrain, this.version),
      (file) => this.store.url(`${this.entry.terrain.replace(/[^/]+$/, "")}${file}`, this.version),
      this.fetcher,
      this.chunks,
    );
    return this.demSampler;
  }

  ensureRegion(lat: number, lon: number, radiusCells: number): Promise<void> {
    return this.dem().ensureRegion(lat, lon, radiusCells);
  }

  /** Binned fossil occurrences. An empty index (available = false) until the fossil steps run. */
  ecology(): Promise<EcologyIndex> {
    this.ecologyPromise ??= (async () => {
      if (!this.entry.ecology) return new EcologyIndex(null);
      const raw = await fetchJson<Record<string, Occurrence[]>>(
        this.fetcher, this.store.url(this.entry.ecology, this.version));
      return new EcologyIndex(raw);
    })();
    this.ecologyPromise.catch(() => { this.ecologyPromise = null; });
    return this.ecologyPromise;
  }

  /** Drop the ecology index (called when another slice becomes current). */
  releaseEcology(): void {
    this.ecologyPromise = null;
  }
}
