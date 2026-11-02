import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { PLANT_PLANS } from "../../biome/plants";
import { ANIMAL_PLANS, PLAN_INFO } from "../../ecology/roster";
import { PLANT_VARIANTS, animalGeometry, plantGeometry, plantVariant } from "./models";

const ATTRS = ["position", "normal", "color", "aBody", "aRig"];

describe("body-plan models (render §7–§8)", () => {
  it("every plant variant is exactly 1 unit tall, stands on y = 0, carries the shared attributes, within budget", () => {
    for (const p of [...PLANT_PLANS, "snag" as const]) {
      for (let v = 0; v < PLANT_VARIANTS[p]; v++) {
        const g = plantGeometry(p, v);
        const b = g.boundingBox!;
        expect(b.max.y, `${p}/${v}`).toBeCloseTo(1, 5);
        expect(b.min.y, `${p}/${v}`).toBeGreaterThan(-0.1);   // drooping frond tips may dip into the ground
        for (const a of ATTRS) expect(g.getAttribute(a), `${p}/${v} ${a}`).toBeDefined();
        expect(g.index).toBeNull();
        expect(g.getAttribute("position").count / 3, `${p}/${v} triangles`).toBeLessThan(4000);
      }
    }
  });

  it("variants are picked deterministically from the colour seed and cover every variant", () => {
    for (const p of [...PLANT_PLANS, "snag" as const]) {
      const seen = new Set<number>();
      for (let s = 0; s < 200; s++) { const v = plantVariant(p, s * 2654435761); expect(v).toBeLessThan(PLANT_VARIANTS[p]); seen.add(v); }
      expect(seen.size).toBe(PLANT_VARIANTS[p]);
    }
  });

  it("every drawn animal is 1 unit long (z), faces −z, with feet on y = 0 (fliers and swimmers centred)", () => {
    for (const p of ANIMAL_PLANS.filter((q) => PLAN_INFO[q].rendered)) {
      const g = animalGeometry(p), b = g.boundingBox!, size = new THREE.Vector3();
      b.getSize(size);
      expect(size.z, p).toBeCloseTo(1, 5);
      if (PLAN_INFO[p].realm === "land" || PLAN_INFO[p].realm === "water_edge") expect(b.min.y, p).toBeCloseTo(0, 5);
      else expect(Math.abs(b.max.y + b.min.y), p).toBeLessThan(1e-6);
      for (const a of ATTRS) expect(g.getAttribute(a), `${p} ${a}`).toBeDefined();
      expect(g.getAttribute("position").count / 3, `${p} triangles`).toBeLessThan(5000);
    }
  });

  it("necks rise and tails droop (rx > 0 raises the −z end in Three; the first models had necks inverted)", () => {
    const ys = (plan: Parameters<typeof animalGeometry>[0], keep: (z: number) => boolean) => {
      const pos = animalGeometry(plan).getAttribute("position"), out: number[] = [];
      for (let i = 0; i < pos.count; i++) if (keep(pos.getZ(i))) out.push(pos.getY(i));
      return out;
    };
    // sauropod: the head is the highest point and the tail tip is low
    const head = Math.max(...ys("sauropod", (z) => z < -0.4)), torso = Math.max(...ys("sauropod", (z) => Math.abs(z) < 0.05));
    expect(head).toBeGreaterThan(torso * 1.3);
    expect(Math.max(...ys("sauropod", (z) => z > 0.45))).toBeLessThan(torso * 0.6);
    for (const p of ["prosauropod", "ornithopod", "small_theropod", "large_theropod", "ceratopsian", "small_tetrapod", "stegosaur"] as const) {
      expect(Math.max(...ys(p, (z) => z > 0.45)), p).toBeLessThan(Math.max(...ys(p, (z) => Math.abs(z) < 0.05)));
    }
  });

  it("leg vertices pivot about a hip inside the body, and neck pivots sit at the shoulder", () => {
    for (const p of ["sauropod", "large_theropod", "ceratopsian"] as const) {
      const g = animalGeometry(p), rig = g.getAttribute("aRig"), pos = g.getAttribute("position");
      let legs = 0, neck = 0;
      for (let i = 0; i < rig.count; i++) {
        if (rig.getX(i) === 1) { legs++; expect(rig.getY(i)).toBeGreaterThanOrEqual(pos.getY(i) - 0.05); expect(Math.abs(rig.getZ(i))).toBeLessThan(0.5); }
        if (rig.getX(i) === 3) { neck++; expect(rig.getY(i)).toBeGreaterThanOrEqual(0); expect(rig.getY(i)).toBeLessThanOrEqual(1); }
      }
      expect(legs, p).toBeGreaterThan(0);
      expect(neck, p).toBeGreaterThan(0);
    }
  });
});
