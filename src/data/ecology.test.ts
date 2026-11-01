import { describe, expect, it } from "vitest";
import { binKey, EcologyIndex, greatCircleKm } from "./ecology";
import type { Occurrence } from "./types";

const occ = (id: number, lat: number, lon: number, body_plan = "sauropod"): Occurrence => ({
  id, name: `T${id}`, rank: "genus", body_plan, size_hint: null, matched_level: "order",
  lat, lon, env: "terrestrial", age_range: [150, 152], age_fit: 1, ref: null,
});

function index(list: Occurrence[]) {
  const bins: Record<string, Occurrence[]> = {};
  for (const o of list) (bins[binKey(o.lat, o.lon)] ??= []).push(o);
  return new EcologyIndex(bins);
}

describe("ecology index (data §4)", () => {
  it("names bins by their south-west corner", () => {
    expect(binKey(37.2, -3.1)).toBe("35_-5");
    expect(binKey(-0.1, 0.1)).toBe("-5_0");
    expect(binKey(90, 180)).toBe("85_-180");
  });

  it("measures great-circle distance", () => {
    expect(greatCircleKm(0, 0, 0, 1)).toBeCloseTo(111.19, 1);
    expect(greatCircleKm(0, 179.5, 0, -179.5)).toBeCloseTo(111.19, 1);
  });

  it("finds occurrences within a radius, nearest first, with distances", () => {
    const idx = index([occ(1, 40, 10), occ(2, 41, 10), occ(3, 45, 10), occ(4, -40, 10)]);
    const hits = idx.near(40, 10, 200);
    expect(hits.map((h) => h.id)).toEqual([1, 2]);
    expect(hits[1]!.distanceKm).toBeCloseTo(111.2, 0);
  });

  it("searches across the antimeridian and bin edges", () => {
    const idx = index([occ(1, 0, 179.9), occ(2, 0, -179.9), occ(3, 4.99, -179.99)]);
    expect(idx.near(0, 180, 600).map((h) => h.id).sort()).toEqual([1, 2, 3]);
  });

  it("handles points near a pole", () => {
    const idx = index([occ(1, 89, 0), occ(2, 89, 180)]);
    expect(idx.near(89.5, 90, 300).map((h) => h.id).sort()).toEqual([1, 2]);
  });

  it("filters plants", () => {
    const idx = index([occ(1, 10, 10, "fern"), occ(2, 10, 10.1, "sauropod")]);
    expect(idx.plantsNear(10, 10, 50).map((h) => h.id)).toEqual([1]);
  });

  it("is empty but valid before the fossil pipeline has run", () => {
    const idx = new EcologyIndex(null);
    expect(idx.available).toBe(false);
    expect(idx.near(0, 0, 1000)).toEqual([]);
  });
});
