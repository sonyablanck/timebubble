import { describe, expect, it } from "vitest";
import { headingOf, LocalFrame, sunDirection } from "./projection";

describe("local frame (render §1)", () => {
  it("toLatLon inverts the horizontal projection", () => {
    const f = new LocalFrame(41.2, 179.98);
    for (const [lat, lon] of [[41.2, 179.98], [41.25, -179.97], [41.16, 179.9], [41.3, 179.99]] as const) {
      const p = [0, 0, 0];
      f.project(lat, lon, 0, p);
      const [la, lo] = f.toLatLon(p[0]!, p[2]!);
      expect(la).toBeCloseTo(lat, 10);
      expect(((lo - lon + 540) % 360) - 180).toBeCloseTo(0, 10);
    }
  });

  it("INVARIANT: rebasing keeps positions continuous to < 1 cm, also across the antimeridian", () => {
    const a = new LocalFrame(-20.01, 179.99), b = new LocalFrame(-20.05, -179.97);
    const [x, z] = [3200.123, -2711.5];
    const [x2, z2] = a.transfer(x, z, b);
    const [x3, z3] = b.transfer(x2, z2, a);
    expect(Math.hypot(x3 - x, z3 - z)).toBeLessThan(0.01);
    // the point is the same lat/lon in both frames
    const p = a.toLatLon(x, z), q = b.toLatLon(x2, z2);
    expect(p[0]).toBeCloseTo(q[0], 9);
    expect(Math.abs(((p[1] - q[1] + 540) % 360) - 180)).toBeLessThan(1e-9);
  });

  it("INVARIANT: after 50 km of walking, local coordinates near the player stay small (float32-safe)", () => {
    // the origin follows the player tile by tile, so the player is never more than ~3 km from it
    let frame = new LocalFrame(10, 20);
    let [x, z] = [0, 0];
    for (let step = 0; step < 50_000; step += 4000) {
      x += 4000;
      const [lat, lon] = frame.toLatLon(x, z);
      const next = new LocalFrame(lat, lon);
      [x, z] = frame.transfer(x, z, next);
      frame = next;
      expect(Math.hypot(x, z)).toBeLessThan(1e-6);
    }
    expect(Math.fround(2999.9995) - 2999.9995).toBeLessThan(0.001); // float32 step at 3 km is 0.24 mm
  });

  it("curvature drop is ~2.8 m at 6 km and ~283 m at 60 km", () => {
    expect(LocalFrame.drop(6000, 0)).toBeCloseTo(2.83, 1);
    expect(LocalFrame.drop(0, 60000)).toBeCloseTo(282.5, 0);
  });
});

describe("sun and compass", () => {
  it("noon sun at 30°N is 60° up, due south; at the equator it is overhead", () => {
    const [x, y, z] = sunDirection(30, 12);
    expect(Math.asin(y) * 180 / Math.PI).toBeCloseTo(60, 6);
    expect(x).toBeCloseTo(0, 9);
    expect(z).toBeGreaterThan(0); // +z is south
    expect(sunDirection(0, 12)[1]).toBeCloseTo(1, 9);
  });

  it("the morning sun is in the east and below the horizon before 06:00", () => {
    expect(sunDirection(45, 9)[0]).toBeGreaterThan(0);
    expect(sunDirection(45, 5)[1]).toBeLessThan(0);
  });

  it("headings: north 0, east 90, south 180", () => {
    expect(headingOf(0, -1)).toBeCloseTo(0);
    expect(headingOf(1, 0)).toBeCloseTo(90);
    expect(headingOf(0, 1)).toBeCloseTo(180);
  });
});
