import { describe, expect, it } from "vitest";
import { formatCoast, formatElevation, formatLatLon, formatPrecip } from "./format";
import { viewFromUrl, viewToUrl, type GlobeViewState } from "./url";

describe("URL state (ui §0, provenance §5)", () => {
  it("INVARIANT: viewFromUrl(viewToUrl(v)) == v", () => {
    const v: GlobeViewState = {
      age: 150, camera: { lat: 20.25, lon: -170.5, dist: 2.4 },
      layers: ["relief", "temperature", "graticule"], exaggeration: 40, pin: { lat: 22.49, lon: 3.64 },
    };
    expect(viewFromUrl(viewToUrl(v))).toEqual(v);
  });

  it("ignores malformed values and unknown layers", () => {
    expect(viewFromUrl("?age=abc&lat=1&lon=2&layers=relief,lasers&ex=")).toEqual({ layers: ["relief"] });
    expect(viewFromUrl("")).toEqual({});
    expect(viewFromUrl("?pin=1,x")).toEqual({});
  });
});

describe("readout formatting", () => {
  it("formats positions and values", () => {
    expect(formatLatLon(22.49, -3.64)).toBe("22.5°N 3.6°W");
    expect(formatElevation(-4905)).toBe("4,905 m below sea level");
    expect(formatElevation(212.4)).toBe("212 m");
    expect(formatCoast(0)).toBe("on the coast");
    expect(formatCoast(-301)).toBe("301 km offshore");
    expect(formatPrecip(1227.4)).toBe("1,227 mm/yr");
  });
});
