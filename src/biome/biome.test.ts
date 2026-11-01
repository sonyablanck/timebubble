import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DataStore, type Fetcher } from "../data";
import { dataRoot, smoothDem } from "../data/testing";
import { F } from "../provenance/flags";
import { TerrainService } from "../terrain/service";
import type { TileData } from "../terrain/tile";
import { tileIdFor } from "../terrain/tilegrid";
import { impactWinterCooling } from "./climate";
import { angiospermShare, plantMixFor, plantPrior, PLANT_PLANS } from "./plants";
import { Biome, BIOME_NAMES, classify, climateAt, NB } from "./rules";

const W = () => new Float32Array(NB);
const land = (over: Partial<Parameters<typeof classify>[0]> = {}, clim = climateAt(20, 0, 3, 100, 100, 0)) =>
  ({ h: 100, hSmooth: 100, slopeDeg: 3, absLat: 30, nearSea: 0, c: clim, icePossible: false, ...over });

describe("biome rules (biome §2–§4)", () => {
  it("INVARIANT: weights sum to 1, and sea and land biomes never mix", () => {
    for (const h of [-4000, -200, -1, 0, 2, 300, 2000, 3500]) {
      for (const p of [0.1, 1, 3, 8]) {
        for (const T of [-10, 5, 15, 25, 38]) {
          const w = W();
          classify(land({ h, hSmooth: h, c: climateAt(T, 0, p, h, h, 0.5) }), w);
          expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
          const sea = w[Biome.OpenOcean]! + w[Biome.ShelfSea]!;
          expect(sea).toBeCloseTo(h < 0 ? 1 : 0, 6);
        }
      }
    }
  });

  it("INVARIANT: moisture rises with precipitation at fixed temperature; hot places need more rain", () => {
    let prev = -1;
    for (const p of [0, 0.5, 1, 2, 4, 8]) {
      const m = climateAt(20, 0, p, 100, 100, 0).moisture;
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
    expect(climateAt(30, 0, 2, 0, 0, 0).aridity).toBeLessThan(climateAt(10, 0, 2, 0, 0, 0).aridity);
  });

  it("lapse rate corrects only for height above the grid's own orography", () => {
    expect(climateAt(20, 1000, 2, 1000, 1000, 0).temperatureC).toBeCloseTo(20, 9);
    expect(climateAt(20, 0, 2, 2000, 2000, 0).temperatureC).toBeCloseTo(8, 9);
  });

  it("INVARIANT: HIGHLAND_ICE is zero whenever ice is not possible for the slice", () => {
    const w = W();
    classify(land({ h: 3000, hSmooth: 3000, c: climateAt(-15, 0, 2, 3000, 3000, 0), icePossible: false }), w);
    expect(w[Biome.HighlandIce]).toBe(0);
    classify(land({ h: 3000, hSmooth: 3000, c: climateAt(-15, 0, 2, 3000, 3000, 0), icePossible: true }), w);
    expect(w[Biome.HighlandIce]).toBeGreaterThan(0.3);
  });

  it("characteristic cases classify sensibly", () => {
    const top = (x: Parameters<typeof classify>[0]) => { const w = W(); classify(x, w); return BIOME_NAMES[w.indexOf(Math.max(...w))]; };
    expect(top(land({ c: climateAt(26, 0, 6, 100, 100, 0) }))).toBe("warm humid forest");
    expect(top(land({ c: climateAt(28, 0, 0.1, 100, 100, 0) }))).toBe("desert");
    expect(top(land({ absLat: 70, c: climateAt(6, 0, 2.5, 100, 100, 0) }))).toBe("polar forest");
    expect(top(land({ h: 4000, hSmooth: 4000, c: climateAt(0, 0, 2, 4000, 4000, 0) }))).toBe("bare highland");
  });

  it("Aftermath: Impact Winter has no living vegetation; Fern Spike is mostly ferns", () => {
    const w = W();
    const cold = climateAt(25, 0, 4, 100, 100, 0, { phase: "impactWinter", year: 2 });
    expect(cold.temperatureC).toBeCloseTo(25 - 0.6 - 26, 6);   // lapse for 100 m, then the year-2 cooling
    expect(classify(land({ c: cold, aftermath: { phase: "impactWinter", year: 2 } }), w)).toBe(0);
    expect(w[Biome.AftermathDeadForest]! + w[Biome.ImpactWinterFrost]!).toBeGreaterThan(0.5);
    classify(land({ c: climateAt(25, 0, 4, 100, 100, 0), aftermath: { phase: "fernSpike", year: 0 } }), w);
    expect(w[Biome.AftermathFernField]! + w[Biome.AftermathDeadForest]!).toBeGreaterThan(0.8);
    expect(impactWinterCooling(2)).toBe(26);
    expect(impactWinterCooling(30)).toBe(0);
  });
});

describe("plant mix (biome §5)", () => {
  const occ = (body_plan: string, distanceKm: number, age_fit = 1) => ({ id: 1, name: "x", rank: "genus", body_plan, size_hint: null,
    matched_level: "family", lat: 0, lon: 0, env: null, age_range: [0, 1] as [number, number], age_fit, ref: null, distanceKm });

  it("data path: nearby plant fossils dominate when plentiful; the prior fills thin evidence", () => {
    const many = Array.from({ length: 20 }, () => occ("fern", 50));
    const m = plantMixFor(150, Biome.SeasonalWoodland, many);
    expect(m.source).toBe("data");
    expect(m.weights.fern).toBeGreaterThan(0.8);
    expect(m.evidence).toMatchObject({ count: 20, nearestKm: 50 });
    const thin = plantMixFor(150, Biome.SeasonalWoodland, [occ("ginkgo", 450, 0.3)]);
    expect(thin.source).toBe("prior");
    expect(thin.weights.ginkgo).toBeGreaterThan(plantPrior(150, Biome.SeasonalWoodland).weights.ginkgo);
  });

  it("INVARIANT: misdated flowering plants are dropped and counted, never shown before 130 Ma", () => {
    const m = plantMixFor(150, Biome.SeasonalWoodland, [occ("early_angiosperm", 10), occ("conifer", 20)]);
    expect(m.weights.early_angiosperm).toBe(0);
    expect(m.evidence?.droppedByAge).toBe(1);
  });

  it("INVARIANT: no flowering plants before 130 Ma, dominant only late; mixes sum to 1", () => {
    for (let age = 250; age >= 65; age -= 5) {
      for (const b of [Biome.Desert, Biome.CoastalSwamp, Biome.PolarForest, Biome.WarmHumidForest]) {
        const m = plantPrior(age, b);
        if (age > 130) expect(m.weights.early_angiosperm).toBe(0);
        expect(PLANT_PLANS.reduce((a, k) => a + m.weights[k], 0)).toBeCloseTo(1, 9);
      }
    }
    expect(angiospermShare(100)).toBeLessThan(0.4);
    expect(angiospermShare(70)).toBeGreaterThan(0.4);
  });
});

// ------------------------------------------------------------------ tiles

const realRoot = process.env.TB_DATA_DIR ?? join(__dirname, "..", "..", "public", "data");
const haveReal = existsSync(join(realRoot, "manifest.json"));
const disk: Fetcher = async (url) => new Response(new Uint8Array(readFileSync(join(realRoot, url.split("?")[0]!.replace(/^\/data\//, "")))));

describe("biome on tiles", () => {
  it("INVARIANT: deterministic, and identical on shared E/W tile edges", async () => {
    const store = new DataStore({ baseUrl: "/data/", fetcher: dataRoot([150], { demFn: smoothDem }).fetcher });
    const svc = new TerrainService({ store });
    const id = tileIdFor(28.3, 8.2);
    const a = (await svc.run({ kind: "tile", sliceAge: 150, id, step: 8 })) as TileData;
    const a2 = (await svc.run({ kind: "tile", sliceAge: 150, id, step: 8 })) as TileData;
    const b = (await svc.run({ kind: "tile", sliceAge: 150, id: { row: id.row, col: id.col + 1 }, step: 8 })) as TileData;
    expect(a.biome!.colour).toEqual(a2.biome!.colour);
    for (let i = 0; i < a.n; i++) {
      const ka = i * a.n + a.n - 1, kb = i * b.n;
      expect(a.biome!.dominant[ka]).toBe(b.biome!.dominant[kb]);
      for (let c = 0; c < 3; c++) expect(Math.abs(a.biome!.colour[ka * 3 + c]! - b.biome!.colour[kb * 3 + c]!)).toBeLessThanOrEqual(1);
    }
    expect(a.biome!.flags.every((f) => (f & F.BIOME_INFERRED) !== 0)).toBe(true);
  });

  it.runIf(haveReal)("literature benchmarks on the real data (report, do not fail)", async () => {
    const svc = new TerrainService({ store: new DataStore({ baseUrl: "/data/", fetcher: disk }) });
    const report = async (label: string, age: number, lat: number, lon: number, aftermath?: { phase: "impactWinter" | "fernSpike"; year: number }) => {
      const r = await svc.run({ kind: "inspect", sliceAge: age, lat, lon, aftermath }) as Awaited<ReturnType<TerrainService["run"]>> & { biome: { climate: { temperatureC: number; precipMmYr: number; moisture: number; heatStress: number }; weights: { biome: number; weight: number }[] }; h: number };
      const c = r.biome.climate;
      console.log(`[benchmark] ${label}: ${age} Ma (${lat}, ${lon}) h ${r.h.toFixed(0)} m, T ${c.temperatureC.toFixed(1)} °C, P ${c.precipMmYr.toFixed(0)} mm/yr, ` +
        `moisture ${c.moisture.toFixed(2)}, heat ${c.heatStress.toFixed(2)} → ${r.biome.weights.map((w) => `${BIOME_NAMES[w.biome]} ${(w.weight * 100).toFixed(0)}%`).join(", ")}`);
      return c;
    };
    const t250 = await report("Early Triassic equator (Sun et al. 2012: ≥ 35 °C)", 250, 2, 20);
    await report("Late Jurassic lowland", 150, 39.3, 10.2);
    await report("Late Jurassic highland", 150, -14.1, -41.2);
    await report("Late Jurassic high latitude", 150, 66, 60);
    const iw = await report("Impact Winter year 2, tropical land (Brugger et al. 2017: ≈ 5 °C)", 65, 5, 20, { phase: "impactWinter", year: 2 });
    await report("Fern Spike, same place", 65, 5, 20, { phase: "fernSpike", year: 0 });
    expect(Number.isFinite(t250.temperatureC) && Number.isFinite(iw.temperatureC)).toBe(true);
  }, 120_000);
});
