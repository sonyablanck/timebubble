import { describe, expect, it } from "vitest";
import { EcologyIndex, binKey, type Occurrence } from "../data";
import { manifest } from "../data/testing";
import { fossilDots, groupOf } from "./fossils";
import { angularDistance, gridUV, latLonToVec3, nearestCell, raySphere, vec3ToLatLon, wrapLon } from "./geo";
import { cssGradient, glslRamp, HYPSOMETRIC, TEMPERATURE } from "./palette";
import { RELIEF_FRAGMENT, SEA_FRAGMENT } from "./shaders";
import { ariaText, buildTimeline, nearestIndex, step } from "./timeline";

const GRID = { width: 360, height: 181, res: 1, latNorth: 90, lonWest: -180 };

describe("geo conventions (globe §2, §5)", () => {
  it("round-trips lat/lon through 3D", () => {
    for (const [lat, lon] of [[0, 0], [30, 60], [-45, -170], [89, 179.5], [-10, -180]] as const) {
      const ll = vec3ToLatLon(latLonToVec3(lat, lon));
      expect(ll.lat).toBeCloseTo(lat, 9);
      expect(wrapLon(ll.lon - lon)).toBeCloseTo(0, 9);
    }
  });

  it("puts lon 0 at +z and lon 90 at +x, north at +y", () => {
    expect(latLonToVec3(0, 0).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1]);
    expect(latLonToVec3(0, 90).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 0, 0]);
    expect(latLonToVec3(90, 0)[1]).toBeCloseTo(1, 12);
  });

  it("INVARIANT: a marker at (30°N, 60°E) lands on its own texel", () => {
    const [u, v] = gridUV(GRID, 30, 60);
    // texel centre of row 60, column 240
    expect(u).toBeCloseTo((240 + 0.5) / 360, 12);
    expect(v).toBeCloseTo((60 + 0.5) / 181, 12);
    expect(nearestCell(GRID, 30, 60)).toEqual([60, 240]);
  });

  it("INVARIANT: the antimeridian has no seam: ±180° map to the same texel", () => {
    expect(gridUV(GRID, 10, 180)[0]).toBeCloseTo(gridUV(GRID, 10, -180)[0], 12);
    expect(nearestCell(GRID, 10, 180)).toEqual(nearestCell(GRID, 10, -180));
    expect(nearestCell(GRID, 10, 179.6)[1]).toBe(0);
    expect(nearestCell(GRID, 10, 179.4)[1]).toBe(359);
  });

  it("intersects rays with the unit sphere", () => {
    const hit = raySphere([0, 0, 3], [0, 0, -1])!;
    expect(hit[2]).toBeCloseTo(1, 12);
    expect(raySphere([0, 2, 3], [0, 0, -1])).toBeNull();
    expect(raySphere([0, 0, 3], [0, 0, 1])).toBeNull();          // behind the camera
  });

  it("INVARIANT: picks either side of ±180° resolve to the correct side", () => {
    const east = vec3ToLatLon(raySphere([...latLonToVec3(0, 179.9, 3)] as [number, number, number],
      latLonToVec3(0, 179.9, -1) as [number, number, number])!);
    const west = vec3ToLatLon(raySphere([...latLonToVec3(0, -179.9, 3)] as [number, number, number],
      latLonToVec3(0, -179.9, -1) as [number, number, number])!);
    expect(east.lon).toBeCloseTo(179.9, 6);
    expect(west.lon).toBeCloseTo(-179.9, 6);
    expect(angularDistance(east, west)).toBeCloseTo(0.2, 6);
  });
});

describe("palette (globe §2–3)", () => {
  it("INVARIANT: the shader's colour stops are the legend's stops", () => {
    const ramp = glslRamp("hypsometric", HYPSOMETRIC);
    for (const s of HYPSOMETRIC) expect(ramp).toContain(`x <= ${Number.isInteger(s.value) ? `${s.value}.0` : s.value}`);
    expect(RELIEF_FRAGMENT).toContain(ramp);
    expect(SEA_FRAGMENT).toContain(glslRamp("temperatureRamp", TEMPERATURE));
    const css = cssGradient(TEMPERATURE);
    for (const s of TEMPERATURE) expect(css).toContain(s.color);
    expect(css).toContain("#f2f0eb 57.1%");                     // 12 °C sits at 32/56 of −20…36
  });
});

describe("timeline (globe §8)", () => {
  const m = manifest([250, 200, 150, 145, 140, 70, 65]);
  m.slices.forEach((s) => {
    s.period = s.age > 201.4 ? "Triassic" : s.age > 143.1 ? "Jurassic" : s.age > 66 ? "Cretaceous" : "Palaeogene";
    s.epoch = `${s.period} epoch`;
  });
  const tl = buildTimeline(m);

  it("groups ticks into period bands, oldest first, with the post-extinction band last", () => {
    expect(tl.bands.map((b) => [b.period, b.fromIndex, b.toIndex, b.afterExtinction])).toEqual([
      ["Triassic", 0, 0, false], ["Jurassic", 1, 3, false], ["Cretaceous", 4, 5, false], ["Palaeogene", 6, 6, true],
    ]);
  });

  it("INVARIANT: snaps to the nearest slice; stepping never overshoots", () => {
    expect(tl.ticks[nearestIndex(tl, 147.5)]!.age).toBe(150);   // tie → older
    expect(tl.ticks[nearestIndex(tl, 10)]!.age).toBe(65);
    expect(step(tl, 0, -1)).toBe(0);
    expect(step(tl, tl.ticks.length - 1, 1)).toBe(tl.ticks.length - 1);
    expect(step(tl, 2, 1)).toBe(3);
  });

  it("announces the slider in words", () => {
    expect(ariaText(tl.ticks[2]!)).toBe("150 million years ago, Jurassic epoch");
    expect(ariaText(tl.ticks[6]!)).toBe("65 million years ago, Palaeogene epoch, after the extinction");
  });
});

describe("fossil dots (globe §3)", () => {
  const occ = (id: number, lat: number, lon: number, body_plan: string, name = `T${id}`): Occurrence => ({
    id, name, rank: "genus", body_plan, size_hint: null, matched_level: "genus", lat, lon,
    env: null, age_range: [148, 152 + id], age_fit: 1, ref: null,
  });

  it("places one dot per bin at the occurrences' centroid, coloured by the dominant group", () => {
    const list = [occ(1, 36, 6, "sauropod", "Brachiosaurus"), occ(2, 38, 8, "sauropod", "Brachiosaurus"),
      occ(3, 37, 7, "fern"), occ(4, -20, 100, "marine_reptile")];
    const bins: Record<string, Occurrence[]> = {};
    for (const o of list) (bins[binKey(o.lat, o.lon)] ??= []).push(o);
    const dots = fossilDots(new EcologyIndex(bins));
    expect(dots).toHaveLength(2);
    const d = dots.find((x) => x.bin === "35_5")!;
    expect(d.count).toBe(3);
    expect(d.group).toBe("dinosaurs");
    expect(d.lat).toBeCloseTo(37, 1);
    expect(d.lon).toBeCloseTo(7, 1);
    expect(d.topTaxa[0]).toBe("Brachiosaurus");
    expect(d.ageSpread).toEqual([148, 155]);
  });

  it("takes the centroid across the antimeridian correctly", () => {
    const dots = fossilDots(new EcologyIndex({ "0_175": [occ(1, 1, 179.5, "fern")], "0_-180": [occ(2, 1, -179.5, "fern")] }));
    for (const d of dots) expect(Math.abs(d.lon)).toBeGreaterThan(179);
  });

  it("knows the body-plan groups", () => {
    expect(groupOf({ body_plan: "large_theropod" })).toBe("dinosaurs");
    expect(groupOf({ body_plan: "ginkgo" })).toBe("plants");
    expect(groupOf({ body_plan: "turtle" })).toBe("other");
  });
});
