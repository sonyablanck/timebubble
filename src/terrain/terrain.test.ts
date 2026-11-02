import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DataStore, type Fetcher } from "../data";
import { dataRoot, smoothDem } from "../data/testing";
import { F } from "../provenance/flags";
import { Fractal, hash32 } from "./noise";
import { psi, Surface } from "./surface";
import { generateFarField, generateTile, prepareFor, vertexLat, vertexLon } from "./tile";
import { colsInRow, DLAT, NROWS, ring, tileBounds, tileIdFor, wrapLon } from "./tilegrid";

// ------------------------------------------------------------------ fixtures

const realRoot = process.env.TB_DATA_DIR ?? join(__dirname, "..", "..", "public", "data");
const haveReal = existsSync(join(realRoot, "manifest.json"));
const diskFetcher: Fetcher = async (url) =>
  new Response(new Uint8Array(readFileSync(join(realRoot, url.split("?")[0]!.replace(/^\/data\//, "")))));

async function surfaceFor(source: "synthetic" | "real", age = 150) {
  const store = source === "real"
    ? new DataStore({ baseUrl: "/data/", fetcher: diskFetcher, chunkCapacity: 32 })
    : new DataStore({ baseUrl: "/data/", fetcher: dataRoot([150], { demFn: smoothDem }).fetcher, chunkCapacity: 32 });
  const slice = await store.slice(age);
  return { surface: new Surface(slice.dem(), slice.age), dem: slice.dem() };
}

/** Mean of H over a source cell on an independent, offset 96 × 96 lattice. */
function cellMean(surface: Surface, lat: number, lon: number, fn: "height" | "smooth" = "height"): number {
  const K = 96;
  let sum = 0;
  for (let a = 0; a < K; a++) {
    for (let b = 0; b < K; b++) {
      const la = lat + 0.05 - ((a + 0.37) / K) * 0.1, lo = lon - 0.05 + ((b + 0.61) / K) * 0.1;
      sum += fn === "height" ? surface.height(la, lo) : surface.smooth(la, lo);
    }
  }
  return sum / (K * K);
}

// ------------------------------------------------------------------ tile grid

describe("tile grid (terrain §1)", () => {
  it("INVARIANT: tileIdFor(tileCentre(r, c)) == (r, c) inside the walkable band (|lat| ≤ 89.5°)", () => {
    const lo = Math.ceil(0.5 / DLAT), hi = NROWS - 1 - lo;     // rows wholly inside ±89.5°
    for (const row of [lo, lo + 1, 1000, NROWS / 2 | 0, 3000, hi]) {
      const n = colsInRow(row);
      for (const col of [0, 1, (n / 2) | 0, n - 1]) {
        const b = tileBounds({ row, col });
        expect(tileIdFor(b.centreLat, b.centreLon)).toEqual({ row, col });
      }
    }
  });

  it("rows close exactly at the antimeridian; tiles are ~4 km wide", () => {
    for (const row of [500, 2500, 4000]) {
      const n = colsInRow(row);
      const last = tileBounds({ row, col: n - 1 });
      expect(last.lonEast).toBeCloseTo(180, 9);
      const widthKm = (last.dlon * Math.PI / 180) * 6371 * Math.cos((last.centreLat * Math.PI) / 180);
      expect(widthKm).toBeGreaterThan(3.9);
      expect(widthKm).toBeLessThan(4.2);
    }
  });

  it("INVARIANT: tiles at the antimeridian wrap to col 0 / last col consistently", () => {
    expect(tileIdFor(10, 180)).toEqual(tileIdFor(10, -180));
    const id = tileIdFor(10, 179.999);
    expect(id.col).toBe(colsInRow(id.row) - 1);
    const r = ring(id);
    expect(r).toHaveLength(9);
    expect(r.some((t) => t.row === id.row && t.col === 0)).toBe(true);
  });

  it("vertex lattices of east–west neighbours coincide bitwise", () => {
    const a = tileBounds({ row: 3300, col: 100 }), b = tileBounds({ row: 3300, col: 101 });
    expect(vertexLon(a, 512)).toBe(vertexLon(b, 0));
    expect(vertexLat(a, 256)).toBe(vertexLat(b, 256));
  });
});

// ------------------------------------------------------------------ noise and bump

describe("noise and correction bump", () => {
  it("is deterministic for a seed and differs between slices", () => {
    const a = new Fractal(hash32("terrain", 150), { lambdaMax: 8000, octaves: 9, gain: 0.5 });
    const b = new Fractal(hash32("terrain", 150), { lambdaMax: 8000, octaves: 9, gain: 0.5 });
    const c = new Fractal(hash32("terrain", 145), { lambdaMax: 8000, octaves: 9, gain: 0.5 });
    const p = [1234567.8, -2345678.9, 5432109.1] as const;
    expect(a.eval(...p, true)).toEqual(b.eval(...p, true));
    expect(a.eval(...p, false).fbm).not.toBe(c.eval(...p, false).fbm);
  });

  it("fBm and ridged detail are zero-mean (else the cell correction stamps a 0.1° pattern)", () => {
    const f = new Fractal(hash32("terrain", 150), { lambdaMax: 8000, octaves: 9, gain: 0.5 });
    let sf = 0, sr = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const e = f.eval((i * 7919.3) % 4e6, (i * 104729.7) % 4e6, (i * 1299709.1) % 4e6, true);
      sf += e.fbm; sr += e.ridged;
    }
    expect(Math.abs(sf / N)).toBeLessThan(0.02);
    expect(Math.abs(sr / N)).toBeLessThan(0.03);
  });

  it("ψ has mean 1 over the cell and vanishes on its edges", () => {
    let sum = 0;
    const K = 200;
    for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) sum += psi((a + 0.5) / K, (b + 0.5) / K);
    expect(sum / (K * K)).toBeCloseTo(1, 3);
    expect(psi(0, 0.5)).toBe(0);
    expect(psi(1, 0.3)).toBe(0);
  });
});

// ------------------------------------------------------------------ terrain invariants

for (const source of (haveReal ? ["synthetic", "real"] : ["synthetic"]) as ("synthetic" | "real")[]) {
  describe(`terrain invariants (terrain §5, §9) on ${source} data`, () => {
    // lowland near the synthetic continent's centre / real 150 Ma lowland (~140 m) in Europe; mountain = the 150 Ma global maximum (~3 km)
    const site = source === "synthetic" ? { lat: 28.3, lon: 8.2 } : { lat: 39.3, lon: 10.2 };
    const mountain = source === "synthetic" ? { lat: 35.6, lon: 12.1 } : { lat: -14.1, lon: -41.2 };

    it("INVARIANT: determinism: generating twice gives identical buffers", async () => {
      const { surface } = await surfaceFor(source);
      const id = tileIdFor(site.lat, site.lon);
      await prepareFor(surface, id);
      const a = generateTile(surface, id, 4), b = generateTile(surface, id, 4);
      expect(a.heights).toEqual(b.heights);
      expect(a.flags).toEqual(b.flags);
      expect(a.normals).toEqual(b.normals);
      // and a fresh Surface (cold caches) agrees too
      const { surface: s2 } = await surfaceFor(source);
      await prepareFor(s2, id);
      expect(generateTile(s2, id, 4).heights).toEqual(a.heights);
    });

    it("INVARIANT: E/W seam: shared edge vertices of neighbours are identical", async () => {
      const { surface } = await surfaceFor(source);
      const a = tileIdFor(site.lat, site.lon), b = { row: a.row, col: a.col + 1 };
      await prepareFor(surface, a);
      const ta = generateTile(surface, a, 4);
      await prepareFor(surface, b);
      const tb = generateTile(surface, b, 4);
      for (let i = 0; i < ta.n; i++) expect(ta.heights[i * ta.n + ta.n - 1]).toBe(tb.heights[i * tb.n]);
    });

    it("INVARIANT: N/S seam: max height gap along the edge < 0.5 m (lowland)", async () => {
      const { surface } = await surfaceFor(source);
      const a = tileIdFor(site.lat, site.lon);
      const south = ring(a).find((t) => t.row === a.row - 1 && Math.abs(tileBounds(t).centreLon - tileBounds(a).centreLon) < tileBounds(a).dlon / 2)!;
      await prepareFor(surface, a);
      const ta = generateTile(surface, a, 1);
      await prepareFor(surface, south);
      const tb = generateTile(surface, south, 1);
      // A's south edge vertices vs B's north edge, linearly interpolated at A's longitudes
      const ba = tileBounds(a), bb = tileBounds(south);
      let worst = 0;
      for (let j = 0; j < ta.n; j++) {
        const lon = vertexLon(ba, j);
        const x = ((lon - bb.lonWest) / bb.dlon) * 512;
        if (x < 0 || x > 512) continue;
        const j0 = Math.min(511, Math.floor(x)), f = x - j0;
        const hb = tb.heights[j0]! * (1 - f) + tb.heights[j0 + 1]! * f;
        worst = Math.max(worst, Math.abs(ta.heights[(ta.n - 1) * ta.n + j]! - hb));
      }
      expect(worst).toBeLessThan(0.5);
    });

    it("INVARIANT: antimeridian: tiles either side of ±180° match at the seam", async () => {
      const { surface } = await surfaceFor(source);
      const id = tileIdFor(source === "synthetic" ? 20 : -20, 179.99);
      const west = { row: id.row, col: 0 };
      await prepareFor(surface, id);
      const ta = generateTile(surface, id, 8);
      await prepareFor(surface, west);
      const tb = generateTile(surface, west, 8);
      for (let i = 0; i < ta.n; i++) expect(ta.heights[i * ta.n + ta.n - 1]).toBeCloseTo(tb.heights[i * tb.n]!, 4);
    });

    it.each([["lowland", site], ["mountain", mountain]] as const)(
      "INVARIANT: mean preservation: |mean(H) − source| < 1 m over a %s cell", async (_k, at) => {
        const { surface, dem } = await surfaceFor(source);
        const lat = Math.round(at.lat * 10) / 10, lon = Math.round(at.lon * 10) / 10;   // a node: the cell centre
        await surface.prepare(lat - 0.2, lat + 0.2, lon - 0.2, lon + 0.2);
        const src = dem.cell(Math.round(dem.latIdxOf(lat)), Math.round(dem.lonIdxOf(lon)));
        expect(Math.abs(cellMean(surface, lat, lon) - src)).toBeLessThan(1);
        expect(Math.abs(cellMean(surface, lat, lon, "smooth") - src)).toBeLessThan(1);
      }, 60_000);

    it("INVARIANT: land/sea agreement and no NaN in a full-resolution tile", async () => {
      const { surface, dem } = await surfaceFor(source);
      const id = tileIdFor(site.lat, site.lon);
      await prepareFor(surface, id);
      const t = generateTile(surface, id, 1);
      expect(t.heights.every(Number.isFinite)).toBe(true);
      expect(t.normals.every((v) => Number.isFinite(v))).toBe(true);
      // per source cell touched by the tile: the majority of vertices share its sign
      const tally = new Map<string, { src: number; agree: number; total: number }>();
      for (let i = 0; i < t.n; i += 4) {
        for (let j = 0; j < t.n; j += 4) {
          const lat = vertexLat(t.bounds, i), lon = vertexLon(t.bounds, j);
          const ci = Math.round(dem.latIdxOf(lat)), cj = Math.round(dem.lonIdxOf(lon));
          const key = `${ci}_${cj}`;
          const e = tally.get(key) ?? { src: dem.cell(ci, cj), agree: 0, total: 0 };
          e.total++;
          if ((t.heights[i * t.n + j]! >= 0) === (e.src >= 0)) e.agree++;
          tally.set(key, e);
        }
      }
      for (const e of tally.values()) if (Math.abs(e.src) >= 30 && e.total > 50) expect(e.agree / e.total).toBeGreaterThan(0.5);
      // provenance: every vertex carries DATA_SURFACE
      expect(t.flags.every((f) => (f & F.DATA_SURFACE) !== 0)).toBe(true);
      console.log(`[benchmark] ${source} full tile: ${t.stats.ms.toFixed(0)} ms, ${t.n}² vertices, land ${(t.stats.landShare * 100).toFixed(0)}%`);
    }, 60_000);

    it("far field is the detail-free surface and is finite", async () => {
      const { surface } = await surfaceFor(source);
      await surface.prepare(site.lat - 0.6, site.lat + 0.6, site.lon - 0.7, site.lon + 0.7);
      const f = generateFarField(surface, site.lat, site.lon, 60_000, 61);
      expect(f.heights.every(Number.isFinite)).toBe(true);
      expect(f.heights[30 * 61 + 30]).toBeCloseTo(surface.smooth(site.lat, wrapLon(site.lon)), 3);
    });
  });
}

it("DLAT is 4 km of latitude", () => {
  expect(DLAT * Math.PI / 180 * 6371).toBeCloseTo(4, 6);
});

describe("terrain service and client (inline mode)", () => {
  it("serialises interleaved tile, far-field and inspect requests", async () => {
    const { TerrainClient } = await import("./client");
    const { DataStore } = await import("../data");
    const store = new DataStore({ baseUrl: "/data/", fetcher: dataRoot([150], { demFn: smoothDem }).fetcher });
    const c = new TerrainClient({ inline: true, store });
    expect(c.mode).toBe("inline");
    const id = tileIdFor(28.3, 8.2);
    const stages: string[] = [];
    const [t, f, x] = await Promise.all([
      c.tile(150, id, 8, (s) => stages.push(s)),
      c.farField(150, 28.3, 8.2, 20_000, 21),
      c.inspect(150, 28.3, 8.2),
    ]);
    expect(t.n).toBe(65);
    expect(stages).toContain("generating");
    expect(f.heights.every(Number.isFinite)).toBe(true);
    expect(x.flagNames).toContain("DATA_SURFACE");
    expect(x.h).toBeCloseTo(x.smooth + x.generated, 6);
    expect(typeof x.className).toBe("string");
    // the tile is unchanged by the interleaved requests
    const again = await c.tile(150, id, 8);
    expect(again.heights).toEqual(t.heights);
  });
});

describe("terrain provenance calibration (DESIGN §12, 2026-11-02)", () => {
  it("invented relief reads inferred from 20 m and generated from 60 m, however large the local amplitude", async () => {
    const { provStrength } = await import("./surface");
    const { levelOf, Level } = await import("../provenance/flags");
    const lvl = (g: number, amp: number) => levelOf("terrain", 0, provStrength(g, amp));
    // orogen: amplitude 600 m
    expect(lvl(10, 600)).toBe(Level.DATA);
    expect(lvl(25, 600)).toBe(Level.INFERRED);
    expect(lvl(150, 600)).toBe(Level.GENERATED);    // read as data before the floor
    // lowland: amplitude 30 m; the relative term still bites first
    expect(lvl(5, 30)).toBe(Level.DATA);
    expect(lvl(10, 30)).toBe(Level.INFERRED);
    expect(lvl(-25, 30)).toBe(Level.GENERATED);
    expect(provStrength(1e4, 1)).toBe(1);
  });
});

