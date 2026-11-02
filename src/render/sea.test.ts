import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { fillDepth, SEA_HALF_M, SEA_RES, SeaDepth, seaLook, UNKNOWN_FLOOR_M } from "./sea";
import { hazeFromTemperature } from "./walk";
import { photoFileName, wrapLines } from "../ui/photo";

const fromHalf = THREE.DataUtils.fromHalfFloat;

describe("sea depth texture", () => {
  it("samples floor heights at texel centres, clamps land, and marks unloaded ground as deep", () => {
    const out = new Uint16Array(SEA_RES * SEA_RES);
    // a shelf sloping down to the east; nothing loaded in the far north rows
    fillDepth(out, 0, 0, (x, z) => (z < -SEA_HALF_M + 200 ? null : 100 - x * 0.05));
    const at = (i: number, j: number) => fromHalf(out[j * SEA_RES + i]!);
    expect(at(0, 0)).toBe(UNKNOWN_FLOOR_M);
    expect(at(0, SEA_RES - 1)).toBe(50);                 // land clamped to 50 m
    const step = (2 * SEA_HALF_M) / SEA_RES;
    const x = -SEA_HALF_M + (SEA_RES - 0.5) * step;
    expect(at(SEA_RES - 1, 64)).toBeCloseTo(100 - x * 0.05, 0);
  });

  it("only rebuilds when invalidated or after moving away from the centre", () => {
    const sea = new SeaDepth({ value: 0 }, { value: 1 });
    let calls = 0;
    const h = () => { calls++; return -10; };
    expect(sea.update(0, 0, h)).toBe(true);
    expect(sea.update(300, 0, h)).toBe(false);
    expect(sea.update(1000, 0, h)).toBe(true);
    sea.invalidate();
    expect(sea.update(1000, 0, h)).toBe(true);
    expect(calls).toBe(3 * SEA_RES * SEA_RES);
    expect(sea.uniforms.u_seaRect.value.x).toBe(1000);
  });

  it("shallow water is clearer than deep water, and foam only at the shore", () => {
    const shore = seaLook(0.5), shelf = seaLook(20), ocean = seaLook(2000);
    expect(shore.alpha).toBeLessThan(shelf.alpha);
    expect(shelf.alpha).toBeLessThan(ocean.alpha);
    expect(ocean.deepness).toBeGreaterThan(0.99);
    expect(shore.foamBand).toBeGreaterThan(0.8);
    expect(seaLook(5).foamBand).toBe(0);
  });
});

describe("heat haze", () => {
  it("is off in temperate climates and full in hot ones", () => {
    expect(hazeFromTemperature(15)).toBe(0);
    expect(hazeFromTemperature(24)).toBe(0);
    expect(hazeFromTemperature(30)).toBeCloseTo(0.5, 5);
    expect(hazeFromTemperature(40)).toBe(1);
  });
});

describe("photo mode helpers", () => {
  it("wraps words to the width", () => {
    const lines = wrapLines("aa bb cc dd ee", 5, (s) => s.length);
    expect(lines).toEqual(["aa bb", "cc dd", "ee"]);
    expect(wrapLines("", 10, (s) => s.length)).toEqual([]);
  });

  it("names the file after the slice and palaeo-position", () => {
    expect(photoFileName(70, 47.123, -101.3)).toBe("timebubble_70Ma_47.12N_101.30W.png");
    expect(photoFileName(250, -5, 12.5)).toBe("timebubble_250Ma_5.00S_12.50E.png");
  });
});
