/// <reference lib="webworker" />
// Web Worker entry: terrain generation off the main thread (terrain §7).
// Protocol: main → { id, init: { baseUrl } } once, then { id, req: TerrainRequest }.
//           worker → { id, progress: [stage, done, total] } … then { id, ok: result } or { id, err: message }.

import { TerrainService, transferables, type TerrainRequest } from "./service";

declare const self: DedicatedWorkerGlobalScope;

let service: TerrainService | null = null;

self.onmessage = async (ev: MessageEvent<{ id: number; init?: { baseUrl: string }; req?: TerrainRequest }>) => {
  const { id, init, req } = ev.data;
  if (init) {
    service = new TerrainService({ baseUrl: init.baseUrl });
    self.postMessage({ id, ok: true });
    return;
  }
  if (!service || !req) {
    self.postMessage({ id, err: "terrain worker not initialised" });
    return;
  }
  try {
    const result = await service.run(req, (stage, done, total) => self.postMessage({ id, progress: [stage, done, total] }));
    self.postMessage({ id, ok: result }, transferables(result));
  } catch (e) {
    self.postMessage({ id, err: e instanceof Error ? e.message : String(e) });
  }
};
