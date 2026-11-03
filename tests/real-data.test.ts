// Cross-language check: the TypeScript loader reads exactly what the Python pipeline wrote.
// Runs against public/data (or TB_DATA_DIR) when a manifest exists there; skipped otherwise.
//   npm test                          (uses public/data if the pipeline has been run)
//   TB_DATA_DIR=/path/to/data npm test
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DataStore } from "../src/data";
import type { ClimateMeta, Fetcher } from "../src/data";

const root = process.env.TB_DATA_DIR ?? join(__dirname, "..", "public", "data");
const haveData = existsSync(join(root, "manifest.json"));

const diskFetcher: Fetcher = async (url) => {
  const path = join(root, url.split("?")[0]!.replace(/^\/data\//, ""));
  if (!existsSync(path)) return new Response("missing", { status: 404 });
  return new Response(new Uint8Array(readFileSync(path)));
};

function areaMean(values: ArrayLike<number>, width: number, height: number, scale: number): number {
  let sum = 0, wsum = 0;
  for (let r = 0; r < height; r++) {
    const w = Math.cos(((90 - r) * Math.PI) / 180);
    for (let c = 0; c < width; c++) { sum += (values[r * width + c]! / scale) * w; wsum += w; }
  }
  return sum / wsum;
}

describe.skipIf(!haveData)(`real pipeline output (${root})`, () => {
  const store = new DataStore({ baseUrl: "/data/", fetcher: diskFetcher });

  it("validates the manifest and lists every slice 250–65 Ma", async () => {
    const ages = await store.ages();
    expect(ages[0]).toBe(250);
    expect(ages.at(-1)).toBe(65);
    expect(ages).toHaveLength(38);
  });

  it("1° globe equals the trapezoid mean of the 0.1° DEM read through the chunk sampler", async () => {
    const s = await store.slice(150);
    const globe = await s.globe();
    const dem = s.dem();
    // interior, chunk-corner, and antimeridian nodes
    for (const [lat, lon] of [[30, 60], [-20, 0], [0, -180], [45, 179], [-60, -100], [10, 120]] as const) {
      await dem.ensureRegion(lat, lon, 6);
      const r0 = Math.round(dem.latIdxOf(lat)), c0 = Math.round(dem.lonIdxOf(lon));
      let sum = 0, wsum = 0;
      for (let i = -5; i <= 5; i++) {
        for (let j = -5; j <= 5; j++) {
          const w = (Math.abs(i) === 5 ? 0.5 : 1) * (Math.abs(j) === 5 ? 0.5 : 1);
          sum += w * dem.cell(r0 + i, c0 + j); wsum += w;
        }
      }
      const expected = sum / wsum;
      expect(Math.abs(globe.at(globe.rowOf(lat), globe.colOf(lon)) - expected), `${lat}, ${lon}`).toBeLessThanOrEqual(0.51);
    }
  });

  it("continentality agrees with the heightmap on land and sea", async () => {
    const s = await store.slice(100);
    const [globe, cont] = await Promise.all([s.globe(), s.continentality()]);
    let disagree = 0;
    for (let i = 0; i < globe.values.length; i++) {
      if ((globe.values[i]! >= 0) !== (cont.values[i]! >= 0)) disagree++;
    }
    expect(disagree).toBe(0);
  });

  it.each([250, 150, 100, 65])("%i Ma climate grids decode to the sidecar's area means", async (age) => {
    const s = await store.slice(age);
    const [t, p, meta] = await Promise.all([s.temperature(), s.precipitation(), s.climateMeta()]) as
      [Awaited<ReturnType<typeof s.temperature>>, Awaited<ReturnType<typeof s.precipitation>>, ClimateMeta];
    expect(areaMean(t.values, t.width, t.height, 100)).toBeCloseTo(meta.temp.area_mean, 1);
    expect(areaMean(p.values, p.width, p.height, 100)).toBeCloseTo(meta.precip.area_mean, 1);
    // orientation: the tropics are warmer than the poles in every slice
    expect(t.valueAt(t.rowOf(0), 0)).toBeGreaterThan(t.valueAt(t.rowOf(85), 0));
  });

  it("65 Ma carries the documented temperature override", async () => {
    const meta = await (await store.slice(65)).climateMeta();
    expect(meta.temp.source_age).toBe(60);
    expect(meta.temp.override_reason).toMatch(/K–Pg/);
  });

  // places/ §1: the browser's rotation against pyGPlates' own answers (pipeline/places.py --fixture)
  it("INVARIANT: searched places land where pyGPlates puts them, and with the fossils' plates", async () => {
    const fixture = join(__dirname, "fixtures", "places_expected.json");
    if (!existsSync(fixture)) return;
    const expected = JSON.parse(readFileSync(fixture, "utf8")) as {
      name: string; lat: number; lon: number; plate: number; crust_from_ma: number | null; palaeo: Record<string, [number, number]>;
    }[];
    const idx = (await store.places())!;
    expect(idx).not.toBeNull();
    let samePlate = 0, worstKm = 0, checked = 0;
    for (const e of expected) {
      const u = idx.unitAt(e.lat, e.lon);
      if (u?.plate !== e.plate) continue;      // the 0.1° grid can differ within a cell of a plate edge
      samePlate++;
      for (const [age, [plat, plon]] of Object.entries(e.palaeo)) {
        const p = idx.locate(e.lat, e.lon, Number(age));
        if (p.status !== "ok") { expect(e.crust_from_ma ?? Infinity, `${e.name} ${age} Ma`).toBeLessThan(Number(age) + 10); continue; }
        const d = 6371 * Math.acos(Math.min(1, Math.sin(p.lat * Math.PI / 180) * Math.sin(plat * Math.PI / 180)
          + Math.cos(p.lat * Math.PI / 180) * Math.cos(plat * Math.PI / 180) * Math.cos((p.lon - plon) * Math.PI / 180)));
        worstKm = Math.max(worstKm, d); checked++;
      }
    }
    expect(samePlate / expected.length).toBeGreaterThan(0.97);
    expect(checked).toBeGreaterThan(300);
    expect(worstKm).toBeLessThan(0.1);     // pyGPlates rounds to 1e-4°; the quaternions are exact
    // named checks
    const hastings = idx.locate(50.855, 0.573, 150);
    expect(hastings.status).toBe("ok");
    expect(idx.locate(64.146, -21.942, 65)).toMatchObject({ status: "not-formed" });   // Iceland: crust from ~15 Ma
    expect(idx.locate(21.307, -157.858, 150)).toMatchObject({ status: "not-formed" }); // Honolulu: seafloor ~89 Ma
    expect(idx.locate(21.307, -157.858, 65).status).toBe("ok");
  });
});
