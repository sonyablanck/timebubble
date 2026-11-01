import { describe, expect, it } from "vitest";
import { DataStore } from "./store";
import { OCEAN_SENTINEL_M } from "./dem";
import { dataRoot, demValue, TERRAIN } from "./testing";

async function sampler(opts: Parameters<typeof dataRoot>[1] = {}) {
  const root = dataRoot([150], opts);
  const store = new DataStore({ baseUrl: "/data/", fetcher: root.fetcher });
  const handle = await store.slice(150);
  return { root, dem: handle.dem(), handle };
}

describe("DEM sampler (data §3)", () => {
  it("returns the right cell anywhere, including the overlap edges", async () => {
    const { dem } = await sampler();
    // a region straddling the chunk corner at rows 600/700, cols 1800/1900
    await dem.ensureRegion(30.0, 0.0, 3);           // row 600, col 1800
    for (const [r, c] of [[600, 1800], [599, 1799], [602, 1803], [597, 1797]] as const) {
      expect(dem.cell(r, c)).toBe(demValue(r, c));
    }
  });

  it("test fixture mirrors the pipeline overlap layout (the invariant itself is tested in pipeline/tests)", async () => {
    const { root } = await sampler();
    const { demChunk } = await import("./testing");
    const a = demChunk(5, 12), b = demChunk(5, 13);
    for (let i = 0; i < 101; i++) expect(a[i * 101 + 100]).toBe(b[i * 101]);
    expect(root).toBeDefined();
  });

  it("INVARIANT: cell(lat, NLON) == cell(lat, 0) (antimeridian wrap)", async () => {
    const { dem } = await sampler();
    await dem.ensureRegion(10, 179.95, 2);
    await dem.ensureRegion(10, -180, 2);
    const row = Math.round(dem.latIdxOf(10));
    expect(dem.cell(row, TERRAIN.nlon)).toBe(dem.cell(row, 0));
    expect(dem.cell(row, -1)).toBe(demValue(row, TERRAIN.nlon - 1));
  });

  it("covers both sides of the antimeridian in one region", async () => {
    const { dem } = await sampler();
    expect(dem.keysForRegion(0, 179.98, 3)).toEqual(["8_0", "8_35", "9_0", "9_35"]);
  });

  it("INVARIANT: sampling never triggers a fetch", async () => {
    const { dem, root } = await sampler();
    await dem.ensureRegion(-20, 45, 3);
    const before = root.fetcher.calls.length;
    const r = Math.round(dem.latIdxOf(-20)), c = Math.round(dem.lonIdxOf(45));
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) dem.cell(r + i, c + j);
    expect(root.fetcher.calls.length).toBe(before);
  });

  it("throws a region error, not a fallback, when a region was not loaded", async () => {
    const { dem } = await sampler();
    expect(() => dem.cell(100, 100)).toThrowError(/ensureRegion/);
  });

  it("dedupes concurrent loads of the same chunks", async () => {
    const { dem, root } = await sampler();
    await Promise.all([dem.ensureRegion(30, 0, 3), dem.ensureRegion(30, 0, 3), dem.ensureRegion(30.05, 0.05, 3)]);
    const chunkCalls = root.fetcher.calls.filter((u) => u.includes("/r"));
    expect(new Set(chunkCalls).size).toBe(chunkCalls.length);
  });

  it("clamps at the poles", async () => {
    const { dem } = await sampler();
    await dem.ensureRegion(-90, 0, 2);
    expect(dem.cell(TERRAIN.nlat + 5, 1800)).toBe(demValue(TERRAIN.nlat - 1, 1800));
  });

  it("fills a chunk missing from the index with the ocean sentinel", async () => {
    const { dem } = await sampler({ dropChunk: "6_18" });
    await dem.ensureRegion(30, 0, 3);
    expect(dem.cell(650, 1850)).toBe(OCEAN_SENTINEL_M);
    expect(dem.sentinelChunks.has("6_18")).toBe(true);
  });

  it("appends the data version to chunk URLs", async () => {
    const { dem, root } = await sampler();
    await dem.ensureRegion(0, 0, 1);
    expect(root.fetcher.calls.some((u) => /terrain\/150\/r\d+_c\d+\.i16\.gz\?v=abc123$/.test(u))).toBe(true);
  });
});
