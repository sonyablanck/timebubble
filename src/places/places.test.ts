import { describe, expect, it } from "vitest";
import { Geocoder, MIN_INTERVAL_MS, parseCoordinates, parseNominatim } from "./geocode";
import { PlaceIndex, rotateVec, toLatLon, toVec, type PlacesMeta } from "./rotate";

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("places/ §1 rotation", () => {
  it("identity quaternion leaves a point where it is", () => {
    const p = toLatLon(rotateVec([1, 0, 0, 0], toVec(50.85, 0.57)));
    close(p.lat, 50.85); close(p.lon, 0.57);
  });

  it("90° about the pole moves longitude by 90°", () => {
    const h = Math.SQRT1_2;
    const p = toLatLon(rotateVec([h, 0, 0, h], toVec(10, 20)));
    close(p.lat, 10); close(p.lon, 110);
  });

  it("longitudes stay in [−180, 180)", () => {
    const p = toLatLon(rotateVec([0, 0, 0, 1], toVec(0, 90)));   // 180° about z
    expect(p.lon).toBeGreaterThanOrEqual(-180);
    expect(p.lon).toBeLessThan(180);
  });

  // a 2-cell-wide world: west half plate 1 (rotates), east half plate 2 (crust from 100 Ma)
  const meta: PlacesMeta = {
    schema: 1, plate_model: "test", method: "",
    grid: { file: "u", width: 4, height: 2, res: 90, registration: "cell", lat_north: 90, lon_west: -180 },
    units: [[0, null], [1, null], [2, 100]],
    rotations: { "150": { "1": [Math.SQRT1_2, 0, 0, Math.SQRT1_2], "2": [1, 0, 0, 0] }, "65": { "1": [1, 0, 0, 0], "2": [1, 0, 0, 0] } },
  };
  const idx = new PlaceIndex(meta, new Int16Array([1, 1, 2, 0, 1, 1, 2, 0]));

  it("looks up the cell's plate and applies its rotation", () => {
    const p = idx.locate(10, -100, 150);
    expect(p.status).toBe("ok");
    if (p.status === "ok") { close(p.lat, 10); close(p.lon, -10); expect(p.plate).toBe(1); }
  });

  it("INVARIANT: never places crust on a slice older than the crust", () => {
    expect(idx.locate(10, 10, 150)).toEqual({ status: "not-formed", plate: 2, crustFromMa: 100 });
    expect(idx.locate(10, 10, 65).status).toBe("ok");
  });

  it("reports points outside every plate", () => {
    expect(idx.locate(10, 100, 65)).toEqual({ status: "no-plate" });
  });

  it("cell edges: the south pole and 180° fall inside the grid", () => {
    expect(idx.locate(-90, -180, 65).status).toBe("ok");
    expect(idx.locate(0, 179.999, 65).status).toBe("no-plate");
  });
});

describe("places/ §2 search", () => {
  it("parses typed coordinates in common forms", () => {
    expect(parseCoordinates("50.85, 0.57")).toMatchObject({ lat: 50.85, lon: 0.57, source: "coordinates" });
    expect(parseCoordinates("50.85 -0.57")).toMatchObject({ lat: 50.85, lon: -0.57 });
    expect(parseCoordinates("33.9S 18.4E")).toMatchObject({ lat: -33.9, lon: 18.4 });
    expect(parseCoordinates("40.7°N, 74°W")).toMatchObject({ lat: 40.7, lon: -74 });
    expect(parseCoordinates("Hastings")).toBeNull();
    expect(parseCoordinates("95, 10")).toBeNull();
  });

  it("splits Nominatim display names into a name and its context", () => {
    const r = parseNominatim([
      { lat: "50.85", lon: "0.57", display_name: "Hastings, East Sussex, England, United Kingdom", name: "Hastings" },
      { lat: "x", lon: "0", display_name: "bad" },
    ]);
    expect(r).toEqual([{ name: "Hastings", detail: "East Sussex, England, United Kingdom", lat: 50.85, lon: 0.57, source: "osm" }]);
  });

  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }

  it("INVARIANT: requests to Nominatim are ≥ 1.1 s apart, and repeats come from the cache", async () => {
    const clock = fakeClock();
    const calls: { url: string; at: number }[] = [];
    const g = new Geocoder(async (url) => {
      calls.push({ url, at: clock.now() });
      return new Response(JSON.stringify([{ lat: "1", lon: "2", display_name: "A, B" }]));
    }, clock.now, clock.sleep, () => "en-GB");
    await Promise.all([g.search("Hastings"), g.search("Bexhill"), g.search("hastings  ")]);
    await g.search("51.5, -0.1");           // coordinates: no request
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    expect(calls[0]!.url).toContain("format=jsonv2");
    expect(calls[0]!.url).toContain("accept-language=en-GB");
  });

  it("explains a rate-limit reply instead of failing silently", async () => {
    const clock = fakeClock();
    const g = new Geocoder(async () => new Response("", { status: 429 }), clock.now, clock.sleep);
    await expect(g.search("Hastings")).rejects.toThrow(/busy/);
    // a failure doesn't block the queue
    const ok = new Geocoder(async () => new Response("[]"), clock.now, clock.sleep);
    await expect(ok.search("x")).resolves.toEqual([]);
  });
});
