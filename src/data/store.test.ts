import { describe, expect, it } from "vitest";
import { DataError } from "./errors";
import { DataStore, validateManifest } from "./store";
import { dataRoot, manifest } from "./testing";

describe("manifest (data §1)", () => {
  it("accepts a valid manifest", () => {
    expect(() => validateManifest(manifest([150, 65]), "m")).not.toThrow();
  });

  it.each([
    ["wrong plate model", manifest([150], { plate_model: "PALEOMAP (Scotese 2016)" })],
    ["unsorted ages", manifest([65, 150])],
    ["duplicate ages", manifest([150, 150])],
    ["unknown schema", manifest([150], { schema: 2 })],
  ])("rejects %s", (_name, m) => {
    expect(() => validateManifest(m, "m")).toThrow(DataError);
  });

  it.each(["../secret", "/etc/passwd", "https://evil.example/x"])("rejects path %s", (p) => {
    const m = manifest([150]);
    m.slices[0]!.globe = p;
    expect(() => validateManifest(m, "m")).toThrow(/relative/);
  });
});

describe("DataStore and slices (data §1, §5)", () => {
  it("snaps to the nearest slice; ties go to the older one", async () => {
    const { fetcher } = dataRoot([150, 145, 65]);
    const store = new DataStore({ baseUrl: "/data/", fetcher });
    expect((await store.slice(148)).age).toBe(150);
    expect((await store.slice(146)).age).toBe(145);
    expect((await store.slice(147.5)).age).toBe(150);
    expect((await store.slice(10)).age).toBe(65);
    expect(await store.ages()).toEqual([150, 145, 65]);
  });

  it("loads grids with the right scale and caches them", async () => {
    const { fetcher } = dataRoot([150]);
    const store = new DataStore({ baseUrl: "/data/", fetcher });
    const s = await store.slice(150);
    const t = await s.temperature();
    expect(t.valueAt(90, 0)).toBe(30);           // equator: 3000 / 100 °C
    expect(t.valueAt(0, 0)).toBe(3);
    const p = await s.precipitation();
    expect(p.valueAt(0, 0)).toBe(3);             // 300 / 100 mm/day
    const calls = fetcher.calls.length;
    await s.temperature();
    expect(fetcher.calls.length).toBe(calls);
  });

  it("wraps longitude and clamps latitude in Grid.at()", async () => {
    const { fetcher } = dataRoot([150]);
    const g = await (await new DataStore({ baseUrl: "/data/", fetcher }).slice(150)).globe();
    expect(g.at(10, 360)).toBe(g.at(10, 0));
    expect(g.at(10, -1)).toBe(g.at(10, 359));
    expect(g.at(-5, 3)).toBe(g.at(0, 3));
    expect(g.rowOf(30)).toBe(60);
    expect(g.colOf(60)).toBe(240);
    expect(g.colOf(180)).toBe(0);
  });

  it("appends the data version to asset URLs but not to the manifest", async () => {
    const { fetcher } = dataRoot([150]);
    const store = new DataStore({ baseUrl: "/data/", fetcher });
    await (await store.slice(150)).globe();
    expect(fetcher.calls[0]).toBe("/data/manifest.json");
    expect(fetcher.calls[1]).toBe("/data/globe/150.i16.gz?v=abc123");
  });

  it("returns an empty ecology index when the slice has no ecology file", async () => {
    const { fetcher } = dataRoot([150]);
    const eco = await (await new DataStore({ baseUrl: "/data/", fetcher }).slice(150)).ecology();
    expect(eco.available).toBe(false);
  });

  it("loads ecology when present, and keeps it for the current slice only", async () => {
    const { fetcher } = dataRoot([150, 145], {
      ecology: { "35_5": [{ id: 7, name: "Brachiosaurus", rank: "genus", body_plan: "sauropod", size_hint: 22,
        matched_level: "genus", lat: 36, lon: 6, env: "fluvial", age_range: [150, 154], age_fit: 1, ref: 1 }] },
    });
    const store = new DataStore({ baseUrl: "/data/", fetcher });
    const a = await store.slice(150);
    expect((await a.ecology()).near(36, 6, 10)[0]!.name).toBe("Brachiosaurus");
    const ecoCalls = () => fetcher.calls.filter((u) => u.includes("ecology/150")).length;
    expect(ecoCalls()).toBe(1);
    await store.slice(145);                        // another slice becomes current
    const again = await store.slice(150);
    expect(again).toBe(a);                         // previous handle is kept (grids cached)...
    await again.ecology();
    expect(ecoCalls()).toBe(2);                    // ...but its ecology was released
  });

  it("returns null climate params until climate_by_age.json exists", async () => {
    const { fetcher } = dataRoot([150]);
    expect(await (await new DataStore({ baseUrl: "/data/", fetcher }).slice(150)).climate()).toBeNull();
  });

  it("retries the manifest after a failure instead of caching the error", async () => {
    const { fetcher } = dataRoot([150]);
    const store = new DataStore({ baseUrl: "/data/", fetcher });
    fetcher.failNext(3, 503);
    await expect(store.manifest()).rejects.toThrow(DataError);
    expect((await store.manifest()).slices).toHaveLength(1);
  });
});
