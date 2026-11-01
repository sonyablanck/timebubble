// The terrain service: owns a DataStore and one Surface per slice, and answers tile, far-field and
// inspect requests strictly one at a time (a Surface holds a single prepared DEM window, so
// prepare + generate must not interleave). It runs inside the Web Worker (worker.ts) and, for tests
// and as a fallback, on the main thread (client.ts, inline mode).

import { biomeAt, biomeContext, classifyFar, classifyTile, type BiomeContext, type BiomePoint } from "../biome/field";
import type { Aftermath } from "../biome/climate";
import { DataStore, type Fetcher } from "../data";
import { buildTileEcology, type EcologySettings } from "../ecology";
import { flagNames } from "../provenance/flags";
import { CLASS_NAMES, Surface, type SurfaceSample } from "./surface";
import { farFieldBox, generateFarField, generateTile, prepareFor, type FarField, type TileData } from "./tile";
import type { TileId } from "./tilegrid";

export type TerrainRequest =
  | { kind: "tile"; sliceAge: number; id: TileId; step: number; aftermath?: Aftermath | null; biome?: boolean; ecology?: EcologySettings | false }
  | { kind: "far"; sliceAge: number; lat0: number; lon0: number; halfSizeM: number; n: number; aftermath?: Aftermath | null; biome?: boolean }
  | { kind: "inspect"; sliceAge: number; lat: number; lon: number; aftermath?: Aftermath | null };

export interface InspectResult extends SurfaceSample {
  lat: number; lon: number; sliceAge: number;
  className: string;
  flagNames: string[];
  slopeDeg: number;
  biome: BiomePoint;
  biomeFlagNames: string[];
  tempSource: BiomeContext["tempSource"];
}

export type TerrainResult = TileData | FarField | InspectResult;

export type Progress = (stage: "loading DEM" | "generating", done: number, total: number) => void;

const SURFACE_LRU = 2;

export class TerrainService {
  private readonly store: DataStore;
  private readonly surfaces = new Map<number, Surface>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly contexts = new Map<string, BiomeContext>();

  constructor(opts: { baseUrl?: string; fetcher?: Fetcher; store?: DataStore } = {}) {
    this.store = opts.store ?? new DataStore({ baseUrl: opts.baseUrl, fetcher: opts.fetcher, chunkCapacity: 64 });
  }

  /** Serialise: every request waits for the previous one. */
  run(req: TerrainRequest, progress?: Progress): Promise<TerrainResult> {
    const next = this.queue.then(() => this.handle(req, progress));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async surface(age: number): Promise<Surface> {
    const hit = this.surfaces.get(age);
    if (hit) {
      this.surfaces.delete(age);
      this.surfaces.set(age, hit);
      return hit;
    }
    const slice = await this.store.slice(age);
    const s = new Surface(slice.dem(), slice.age);
    this.surfaces.set(age, s);
    while (this.surfaces.size > SURFACE_LRU) this.surfaces.delete(this.surfaces.keys().next().value!);
    return s;
  }

  private async context(age: number, aftermath: Aftermath | null | undefined): Promise<BiomeContext> {
    const key = `${age}/${aftermath ? `${aftermath.phase}/${aftermath.year}` : "-"}`;
    let c = this.contexts.get(key);
    if (!c) {
      c = await biomeContext(await this.store.slice(age), aftermath ?? null);
      if (this.contexts.size > 8) this.contexts.delete(this.contexts.keys().next().value!);
      this.contexts.set(key, c);
    }
    return c;
  }

  private async handle(req: TerrainRequest, progress?: Progress): Promise<TerrainResult> {
    const s = await this.surface(req.sliceAge);
    switch (req.kind) {
      case "tile": {
        progress?.("loading DEM", 0, 1);
        await prepareFor(s, req.id);
        progress?.("generating", 0, 1);
        const t = generateTile(s, req.id, req.step);
        if (req.biome !== false) {
          const ctx = await this.context(req.sliceAge, req.aftermath);
          t.biome = classifyTile(t, s, ctx);
          if (req.ecology !== false) t.ecology = buildTileEcology(t, t.biome, ctx, req.ecology ?? { representativeFauna: true });
        }
        progress?.("generating", 1, 1);
        return t;
      }
      case "far": {
        const [a, b, c, d] = farFieldBox(req.lat0, req.lon0, req.halfSizeM);
        progress?.("loading DEM", 0, 1);
        await s.prepare(a - 0.1, b + 0.1, c - 0.1, d + 0.1);
        progress?.("generating", 0, 1);
        const f = generateFarField(s, req.lat0, req.lon0, req.halfSizeM, req.n);
        if (req.biome !== false) f.colour = classifyFar(f, s, await this.context(req.sliceAge, req.aftermath));
        return f;
      }
      case "inspect": {
        await s.prepare(req.lat - 0.15, req.lat + 0.15, req.lon - 0.15, req.lon + 0.15);
        const x = s.sample(req.lat, req.lon);
        // slope of the drawn surface from ±4 m differences
        const dLat = 4 / 111_195, dLon = dLat / Math.max(Math.cos((req.lat * Math.PI) / 180), 1e-3);
        const dE = (s.height(req.lat, req.lon + dLon) - s.height(req.lat, req.lon - dLon)) / 8;
        const dN = (s.height(req.lat + dLat, req.lon) - s.height(req.lat - dLat, req.lon)) / 8;
        const slopeDeg = (Math.atan(Math.hypot(dE, dN)) * 180) / Math.PI;
        const ctx = await this.context(req.sliceAge, req.aftermath);
        const biome = biomeAt(req.lat, req.lon, x, slopeDeg, s, ctx);
        return {
          ...x, lat: req.lat, lon: req.lon, sliceAge: s.age, className: CLASS_NAMES[x.cls], flagNames: flagNames(x.flags),
          slopeDeg, biome, biomeFlagNames: flagNames(biome.flags), tempSource: ctx.tempSource,
        };
      }
    }
  }
}

/** Buffers that can be transferred (not copied) out of the worker. */
export function transferables(r: TerrainResult): ArrayBuffer[] {
  if ("normals" in r) {
    const b = [r.heights.buffer, r.smooth.buffer, r.flags.buffer, r.strength.buffer, r.cls.buffer, r.normals.buffer];
    if (r.biome) b.push(r.biome.colour.buffer, r.biome.dominant.buffer, r.biome.veg.buffer, r.biome.flags.buffer);
    if (r.ecology) {
      const p = r.ecology.plants;
      b.push(p.plan.buffer, p.alive.buffer, p.lat.buffer, p.lon.buffer, p.scale.buffer, p.rotation.buffer, p.colourSeed.buffer);
    }
    return b as ArrayBuffer[];
  }
  if ("halfSizeM" in r) return [r.heights.buffer, ...(r.colour ? [r.colour.buffer] : [])] as ArrayBuffer[];
  return [];
}
