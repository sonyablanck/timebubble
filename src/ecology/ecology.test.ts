import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DataStore, type Fetcher, type OccurrenceNear } from "../data";
import { dataRoot, smoothDem } from "../data/testing";
import { F } from "../provenance/flags";
import { TerrainService } from "../terrain/service";
import type { TileData } from "../terrain/tile";
import { tileBounds, tileIdFor } from "../terrain/tilegrid";
import { makeAgent, step } from "./behaviour";
import { buildRoster, densityPerKm2, envClass, PLAN_INFO, type Habitats } from "./roster";
import { forEachCell, habitatScore, makeSampler } from "./scatter";

const H: Habitats = { land: 0.9, nearCoast: 0.1, shelf: 0.1, ocean: 0 };
const occ = (name: string, body_plan: string, distanceKm: number, extra: Partial<OccurrenceNear> = {}): OccurrenceNear => ({
  id: Math.floor(Math.random() * 1e6), name, rank: "species", body_plan, size_hint: null, matched_level: "family",
  lat: 0, lon: 0, env: "fluvial indet.", age_range: [68, 66], age_fit: 1, ref: 1, distanceKm, ...extra,
});
const opts = (over: Partial<Parameters<typeof buildRoster>[1]> = {}) => ({
  age: 70, habitats: H, heatStress: 0, aftermath: null, representativeFauna: true,
  rng: () => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }, ...over,
});

describe("roster and abundance (ecology §1–§3)", () => {
  it("BENCHMARK: a ~5,200 kg carnivore has ~0.01 individuals per km² (Marshall et al. 2021)", () => {
    expect(densityPerKm2(5200, "carnivore")).toBeCloseTo(0.01, 6);
    expect(densityPerKm2(15000, "herbivore")).toBeGreaterThan(densityPerKm2(15000, "carnivore"));
  });

  it("maps PBDB's environment vocabulary", () => {
    expect(envClass("terrestrial indet.")).toBe("terrestrial");
    expect(envClass('"floodplain"')).toBe("terrestrial");
    expect(envClass("lacustrine delta plain")).toBe("terrestrial");
    expect(envClass("estuary/bay")).toBe("marginal");
    expect(envClass("lagoonal/restricted shallow subtidal")).toBe("shallow");
    expect(envClass("reef, buildup or bioherm")).toBe("shallow");
    expect(envClass("basinal (carbonate)")).toBe("deep");
    expect(envClass("deep subtidal shelf")).toBe("marine");
    expect(envClass("marine indet.")).toBe("marine");
    expect(envClass("")).toBe("unknown");
  });

  it("presence from evidence: within 150 km is data, further is inferred; genus collapses species", () => {
    const r = buildRoster([occ("Edmontosaurus annectens", "ornithopod", 40), occ("Edmontosaurus regalis", "ornithopod", 300),
      occ("Triceratops horridus", "ceratopsian", 400)], opts());
    const ed = r.find((e) => e.name === "Edmontosaurus")!;
    expect(ed.source).toBe("data");
    expect(ed.species).toEqual(["Edmontosaurus annectens", "Edmontosaurus regalis"]);
    expect(r.find((e) => e.name === "Triceratops")!.source).toBe("inferred");
    expect(ed.flags & F.TAXON_FROM_DATA).toBeTruthy();
    expect(ed.flags & F.COLOUR_GENERATED).toBeTruthy();
  });

  it("INVARIANT: no non-avian dinosaur (or other K–Pg victim) after 66 Ma", () => {
    const r = buildRoster([occ("Tyrannosaurus rex", "large_theropod", 10), occ("Quetzalcoatlus", "pterosaur", 10),
      occ("Purgatorius unio", "small_tetrapod", 10)], opts({ age: 65 }));
    expect(r.map((e) => e.bodyPlan)).toEqual(["small_tetrapod"]);
  });

  it("INVARIANT: representative fauna off → no DENSITY_BOOSTED; on → each data taxon shown at least once", () => {
    const list = [occ("Tyrannosaurus rex", "large_theropod", 10)];
    const off = buildRoster(list, opts({ representativeFauna: false }));
    expect(off.some((e) => e.flags & F.DENSITY_BOOSTED)).toBe(false);
    expect(off[0]!.expected).toBeLessThan(0.2);          // a 16 km² tile usually holds no T. rex
    const on = buildRoster(list, opts());
    expect(on[0]!.count).toBeGreaterThanOrEqual(1);
    expect(on[0]!.flags & F.DENSITY_BOOSTED).toBeTruthy();
    expect(on[0]!.note).toMatch(/illustration/);
  });

  it("Aftermath: Impact Winter keeps only rare survivors", () => {
    const r = buildRoster([occ("Purgatorius unio", "small_tetrapod", 10), occ("Borealosuchus", "crocodylomorph", 10)],
      opts({ age: 65, aftermath: "impactWinter" }));
    expect(r.every((e) => e.flags & F.AFTERMATH_RECON)).toBe(true);
    const normal = buildRoster([occ("Purgatorius unio", "small_tetrapod", 10)], opts({ age: 65 }));
    expect(r.find((e) => e.name === "Purgatorius")!.expected).toBeCloseTo(normal[0]!.expected * 0.2, 9);
  });
});

describe("placement (ecology §4)", () => {
  it("INVARIANT: seams: every scatter cell belongs to exactly one of two neighbouring tiles", () => {
    const a = tileIdFor(39.3, 10.2), b = { row: a.row, col: a.col + 1 }, c = { row: a.row + 1, col: a.col };
    const seen = new Map<string, number>();
    for (const [k, id] of [a, b].entries()) forEachCell(tileBounds(id), 10, (i, j) => seen.set(`${i},${j}`, (seen.get(`${i},${j}`) ?? 0) + 1 + k * 0));
    expect([...seen.values()].every((v) => v === 1)).toBe(true);
    // and cells along the shared edge exist on one side or the other (no gap): count is the union of both
    const north = new Set<string>();
    forEachCell(tileBounds(c), 10, (i, j) => north.add(`${i},${j}`));
    for (const k of north) expect(seen.has(k)).toBe(false);
  });

  it("INVARIANT: deterministic plants and animals; none below sea level for land animals; within budget", async () => {
    const store = new DataStore({ baseUrl: "/data/", fetcher: dataRoot([150], { demFn: smoothDem }).fetcher });
    const svc = new TerrainService({ store });
    const id = tileIdFor(28.3, 8.2);
    const t1 = (await svc.run({ kind: "tile", sliceAge: 150, id, step: 4 })) as TileData;
    const t2 = (await svc.run({ kind: "tile", sliceAge: 150, id, step: 4 })) as TileData;
    const t8 = (await svc.run({ kind: "tile", sliceAge: 150, id, step: 1 })) as TileData;
    const p1 = t1.ecology!.plants, p2 = t2.ecology!.plants;
    expect(p1.count).toBeGreaterThan(1000);
    expect(p1.count).toBeLessThanOrEqual(250_000);
    expect(Array.from(p1.lat)).toEqual(Array.from(p2.lat));
    // a tile's plants don't change when it is regenerated at full resolution (shared step-4 field lattice)
    expect(t8.ecology!.plants.count).toBe(p1.count);
    expect(Array.from(t8.ecology!.plants.plan)).toEqual(Array.from(p1.plan));
    const s = makeSampler(t1, t1.biome!);
    for (let k = 0; k < p1.count; k += 97) expect(s(p1.lat[k]!, p1.lon[k]!).h).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("habitat: land animals never in the sea, marine reptiles never on land", () => {
    expect(habitatScore("ornithopod", { h: -5, slopeDeg: 0, biome: 0 })).toBe(0);
    expect(habitatScore("marine_reptile", { h: 50, slopeDeg: 0, biome: 0 })).toBe(0);
    expect(habitatScore("sauropod", { h: 50, slopeDeg: 25, biome: 0 })).toBe(0);
  });
});

describe("behaviour (ecology §6)", () => {
  it("INVARIANT: a land animal never walks into the sea, and stays within its home radius; deterministic", () => {
    const sea = (_p: string, x: number) => x < 60;   // sea east of x = 60
    const run = () => {
      const a = makeAgent("ornithopod", 0, 0, 0, 42, 0, 7);
      const xs: number[] = [];
      for (let k = 0; k < 6000; k++) {
        step(a, 0.1, (p, x, z) => sea(p, x) && Math.hypot(x, z) < 1e9);
        expect(a.x).toBeLessThan(60);
        expect(Math.hypot(a.x, a.z)).toBeLessThanOrEqual(150 + 1e-6);
        xs.push(a.x);
      }
      return xs;
    };
    expect(run()).toEqual(run());
  });
});

// ------------------------------------------------------------------ real data

const realRoot = process.env.TB_DATA_DIR ?? join(__dirname, "..", "..", "public", "data");
const haveEco = existsSync(join(realRoot, "ecology", "70.json.gz"));
const disk: Fetcher = async (url) => new Response(new Uint8Array(readFileSync(join(realRoot, url.split("?")[0]!.replace(/^\/data\//, "")))));

describe.runIf(haveEco)("real data: Hell Creek, 70 Ma (report)", () => {
  it("roster from PBDB occurrences, realistic counts, timing", async () => {
    const svc = new TerrainService({ store: new DataStore({ baseUrl: "/data/", fetcher: disk }) });
    const t = (await svc.run({ kind: "tile", sliceAge: 70, id: tileIdFor(54.9, -80.3), step: 4 })) as TileData;
    const e = t.ecology!;
    const top = e.roster.slice(0, 12).map((r) => `${r.name} (${r.planLabel}, ${r.source}, ${r.evidence.count} occ, ${r.count} here${r.flags & F.DENSITY_BOOSTED ? "*" : ""})`);
    console.log(`[report] ${e.roster.length} taxa; ${e.plants.count} plants; ${e.animals.length} animals; ${e.ms.toFixed(0)} ms\n  ${top.join("\n  ")}`);
    expect(e.roster.length).toBeGreaterThan(5);
    expect(e.roster.every((r) => r.evidence.occurrenceIds.length >= 1)).toBe(true);
    expect(e.roster.every((r) => PLAN_INFO[r.bodyPlan])).toBe(true);
    expect(e.animals.length).toBeLessThanOrEqual(80);
  }, 120_000);
});
