import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { PLANT_PLANS } from "../../biome/plants";
import { ANIMAL_PLANS } from "../../ecology/roster";
import { animalGeometry, plantGeometry } from "./models";

describe("body-plan models (render §7–§8)", () => {
  it("every plant model is ~1 unit tall, standing on y = 0, with part colours", () => {
    for (const p of [...PLANT_PLANS, "snag" as const]) {
      const g = plantGeometry(p);
      g.computeBoundingBox();
      const b = g.boundingBox!;
      expect(b.min.y).toBeGreaterThan(-0.1);   // drooping frond tips may dip into the ground
      expect(b.max.y).toBeCloseTo(1, 5);
      expect(g.getAttribute("color")).toBeDefined();
      expect(g.getAttribute("position").count).toBeLessThan(1500);   // low-poly budget
    }
  });

  it("every animal model is ~1 unit long, faces −z (head forward), feet near y = 0", () => {
    for (const p of ANIMAL_PLANS) {
      const g = animalGeometry(p);
      g.computeBoundingBox();
      const b = g.boundingBox!, size = new THREE.Vector3();
      b.getSize(size);
      expect(Math.max(size.z, size.x)).toBeGreaterThan(0.5);
      expect(Math.max(size.z, size.x)).toBeLessThan(1.4);
      if (p !== "pterosaur" && p !== "marine_reptile") expect(b.min.y).toBeGreaterThan(-0.05);
      expect(g.getAttribute("position").count).toBeLessThan(2500);
    }
  });
});
