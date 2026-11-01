// Main-thread handle on terrain generation. Uses the Web Worker when available; otherwise (tests,
// or a browser that refuses module workers) runs the same TerrainService inline.

import { defaultBaseUrl, type DataStore } from "../data";
import type { FarField, TileData } from "./tile";
import type { TileId } from "./tilegrid";
import type { Aftermath } from "../biome/climate";
import type { EcologySettings } from "../ecology";
import { TerrainService, type InspectResult, type Progress, type TerrainRequest, type TerrainResult } from "./service";

interface Pending { resolve: (r: TerrainResult) => void; reject: (e: Error) => void; progress?: Progress }

export class TerrainClient {
  private worker: Worker | null = null;
  private inline: TerrainService | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private ready: Promise<void>;

  constructor(opts: { baseUrl?: string; inline?: boolean; store?: DataStore } = {}) {
    const baseUrl = new URL(opts.baseUrl ?? defaultBaseUrl(), globalThis.location?.href ?? "http://localhost/").href;
    if (opts.inline || typeof Worker === "undefined") {
      this.inline = new TerrainService({ baseUrl, store: opts.store });
      this.ready = Promise.resolve();
      return;
    }
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "terrain" });
    this.worker.onmessage = (ev) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(`terrain worker failed: ${ev.message}`));
      this.pending.clear();
    };
    this.ready = this.post({ id: 0, init: { baseUrl } }).then(() => undefined);
  }

  get mode(): "worker" | "inline" { return this.worker ? "worker" : "inline"; }

  /** Ground cover options for every request: Aftermath phase (65 Ma only), or null. */
  aftermath: Aftermath | null = null;
  /** Ecology settings for every tile request (ui/ §4: representative fauna, default on). */
  ecologySettings: EcologySettings = { representativeFauna: true };

  tile(sliceAge: number, id: TileId, step: number, progress?: Progress): Promise<TileData> {
    return this.request({ kind: "tile", sliceAge, id, step, aftermath: this.aftermath, ecology: this.ecologySettings }, progress) as Promise<TileData>;
  }

  farField(sliceAge: number, lat0: number, lon0: number, halfSizeM: number, n: number, progress?: Progress): Promise<FarField> {
    return this.request({ kind: "far", sliceAge, lat0, lon0, halfSizeM, n, aftermath: this.aftermath }, progress) as Promise<FarField>;
  }

  inspect(sliceAge: number, lat: number, lon: number): Promise<InspectResult> {
    return this.request({ kind: "inspect", sliceAge, lat, lon, aftermath: this.aftermath }) as Promise<InspectResult>;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("terrain client disposed"));
    this.pending.clear();
  }

  private async request(req: TerrainRequest, progress?: Progress): Promise<TerrainResult> {
    if (this.inline) return this.inline.run(req, progress);
    await this.ready;
    return this.post({ req }, progress);
  }

  private post(msg: { id?: number; init?: { baseUrl: string }; req?: TerrainRequest }, progress?: Progress): Promise<TerrainResult> {
    const id = msg.id ?? this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      this.worker!.postMessage({ ...msg, id });
    });
  }

  private onMessage(m: { id: number; ok?: TerrainResult; err?: string; progress?: [Parameters<Progress>[0], number, number] }): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.progress) { p.progress?.(...m.progress); return; }
    this.pending.delete(m.id);
    if (m.err !== undefined) p.reject(new Error(m.err));
    else p.resolve(m.ok!);
  }
}
