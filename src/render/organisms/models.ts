// Stylised low-poly body-plan models (render §7–§8, DESIGN A10), built procedurally so the repo
// needs no art assets. Plants are 1 unit tall (scaled to height in metres); animals are 1 unit
// long along −z (forward) and scaled to body length. Part colours are baked as vertex colours;
// each instance gets a generated tint (colour is never known: COLOUR_GENERATED).

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PlantPlan } from "../../biome/plants";
import type { AnimalPlan } from "../../ecology/roster";

type Part = THREE.BufferGeometry;

function coloured(g: THREE.BufferGeometry, hex: string): Part {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex);
  const n = geo.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.deleteAttribute("uv");
  return geo;
}

function at(g: Part, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): Part {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")), new THREE.Vector3(sx, sy, sz));
  return g.applyMatrix4(m);
}

function merge(parts: Part[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const BARK = "#6b5440", DARK_BARK = "#4e3d2f", DEAD = "#8a7f72";

/** A fan of `n` flat fronds radiating from (0, y, 0). */
function fronds(n: number, y: number, len: number, droop: number, hex: string, width = 0.12): Part[] {
  const out: Part[] = [];
  for (let k = 0; k < n; k++) {
    const blade = new THREE.ConeGeometry(width, len, 3, 1);
    blade.translate(0, len / 2, 0);
    out.push(coloured(at(blade, 0, y, 0, Math.PI / 2 - droop, (k / n) * Math.PI * 2, 0, 1, 1, 0.25), hex));
  }
  return out;
}

export function plantGeometry(plan: PlantPlan | "snag"): THREE.BufferGeometry {
  // Normalise to exactly 1 unit tall so PLANT_HEIGHT_M is the drawn height.
  const g = plantShape(plan);
  g.computeBoundingBox();
  const top = g.boundingBox!.max.y;
  if (top > 0) g.scale(1 / top, 1 / top, 1 / top);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function plantShape(plan: PlantPlan | "snag"): THREE.BufferGeometry {
  switch (plan) {
    case "conifer": {
      const parts: Part[] = [coloured(at(new THREE.CylinderGeometry(0.02, 0.035, 0.4, 5), 0, 0.2, 0), BARK)];
      for (let k = 0; k < 4; k++) {
        const r = 0.2 - k * 0.04, y = 0.3 + k * 0.17;
        parts.push(coloured(at(new THREE.ConeGeometry(r, 0.3, 6), 0, y + 0.15, 0), k % 2 ? "#2f4a33" : "#355238"));
      }
      return merge(parts);
    }
    case "ginkgo":
      return merge([
        coloured(at(new THREE.CylinderGeometry(0.025, 0.04, 0.55, 5), 0, 0.275, 0), BARK),
        coloured(at(new THREE.IcosahedronGeometry(0.28, 0), 0, 0.7, 0, 0, 0, 0, 1, 1.15, 1), "#6f8a3c"),
      ]);
    case "early_angiosperm":
      return merge([
        coloured(at(new THREE.CylinderGeometry(0.03, 0.05, 0.45, 5), 0, 0.225, 0), BARK),
        coloured(at(new THREE.IcosahedronGeometry(0.3, 0), 0, 0.68, 0, 0, 0.4, 0, 1.2, 0.9, 1.1), "#4f7a35"),
        coloured(at(new THREE.IcosahedronGeometry(0.2, 0), 0.18, 0.62, 0.05), "#56813a"),
      ]);
    case "seed_fern":
      return merge([
        coloured(at(new THREE.CylinderGeometry(0.03, 0.04, 0.75, 5), 0, 0.375, 0), DARK_BARK),
        ...fronds(7, 0.72, 0.42, 0.5, "#5d7a3a", 0.1),
      ]);
    case "cycad_bennettitalean":
      return merge([
        coloured(at(new THREE.CylinderGeometry(0.11, 0.14, 0.35, 7), 0, 0.175, 0), "#6e5a3e"),
        ...fronds(9, 0.33, 0.6, 0.35, "#4c6b33", 0.09),
      ]);
    case "fern":
      return merge(fronds(8, 0.05, 0.75, 0.75, "#5f8b3c", 0.14));
    case "horsetail": {
      const parts: Part[] = [];
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2, r = 0.08 + (k % 2) * 0.05;
        parts.push(coloured(at(new THREE.CylinderGeometry(0.012, 0.018, 0.9 + (k % 3) * 0.08, 5), Math.cos(a) * r, 0.45, Math.sin(a) * r), "#6b8a45"));
      }
      return merge(parts);
    }
    case "snag": {
      const parts: Part[] = [coloured(at(new THREE.CylinderGeometry(0.018, 0.035, 1, 5), 0, 0.5, 0), DEAD)];
      for (const [y, a] of [[0.55, 0.4], [0.7, 2.6], [0.82, 4.4]] as [number, number][]) {
        parts.push(coloured(at(new THREE.CylinderGeometry(0.006, 0.012, 0.25, 4), Math.cos(a) * 0.08, y + 0.06, Math.sin(a) * 0.08, 0, -a, 0.9), DEAD));
      }
      return merge(parts);
    }
  }
}

// ------------------------------------------------------------------ animals

const box = (w: number, h: number, l: number) => new THREE.BoxGeometry(w, h, l);
const ellip = (rx: number, ry: number, rz: number) => { const g = new THREE.IcosahedronGeometry(1, 1); g.scale(rx, ry, rz); return g; };
const leg = (x: number, z: number, h: number, w: number, hex: string) => coloured(at(box(w, h, w), x, h / 2, z), hex);

const SKIN = "#9a8f7d", BELLY = "#c9bfa9", HORN = "#e3dccb";

/** Unit-length animal, forward = −z, feet at y = 0. Proportions are generic body plans, not species. */
export function animalGeometry(plan: AnimalPlan): THREE.BufferGeometry {
  switch (plan) {
    case "sauropod":
      return merge([
        coloured(at(ellip(0.09, 0.08, 0.17), 0, 0.17, 0.02), SKIN),
        coloured(at(box(0.035, 0.035, 0.32), 0, 0.3, -0.25, -0.75), SKIN),          // long neck
        coloured(at(box(0.05, 0.035, 0.07), 0, 0.42, -0.36), SKIN),                  // head
        coloured(at(box(0.03, 0.03, 0.42), 0, 0.15, 0.33, 0.25), SKIN),              // tail
        leg(-0.06, -0.08, 0.12, 0.04, SKIN), leg(0.06, -0.08, 0.12, 0.04, SKIN), leg(-0.06, 0.1, 0.11, 0.04, SKIN), leg(0.06, 0.1, 0.11, 0.04, SKIN),
      ]);
    case "prosauropod":
      return merge([
        coloured(at(ellip(0.07, 0.07, 0.15), 0, 0.2, 0), SKIN),
        coloured(at(box(0.04, 0.04, 0.2), 0, 0.28, -0.18, -0.5), SKIN),
        coloured(at(box(0.045, 0.04, 0.07), 0, 0.33, -0.28), SKIN),
        coloured(at(box(0.035, 0.035, 0.4), 0, 0.18, 0.3, 0.1), SKIN),
        leg(-0.05, 0.03, 0.14, 0.035, SKIN), leg(0.05, 0.03, 0.14, 0.035, SKIN), leg(-0.04, -0.08, 0.08, 0.025, SKIN), leg(0.04, -0.08, 0.08, 0.025, SKIN),
      ]);
    case "ornithopod":
      return merge([
        coloured(at(ellip(0.08, 0.09, 0.17), 0, 0.27, 0.02, 0.15), SKIN),
        coloured(at(box(0.05, 0.05, 0.12), 0, 0.36, -0.15, -0.6), SKIN),
        coloured(at(box(0.05, 0.05, 0.12), 0, 0.4, -0.24), SKIN),                    // head with a duck-like snout
        coloured(at(box(0.04, 0.05, 0.38), 0, 0.27, 0.3, 0.12), SKIN),
        leg(-0.05, 0.04, 0.19, 0.045, SKIN), leg(0.05, 0.04, 0.19, 0.045, SKIN), leg(-0.04, -0.09, 0.14, 0.03, SKIN), leg(0.04, -0.09, 0.14, 0.03, SKIN),
      ]);
    case "ceratopsian":
      return merge([
        coloured(at(ellip(0.1, 0.09, 0.2), 0, 0.17, 0.05), SKIN),
        coloured(at(box(0.08, 0.08, 0.12), 0, 0.17, -0.2), SKIN),                    // head
        coloured(at(box(0.2, 0.18, 0.02), 0, 0.24, -0.13, 0.25), "#b28456"),         // frill
        coloured(at(new THREE.ConeGeometry(0.012, 0.09, 4), -0.025, 0.25, -0.24, -0.9), HORN),
        coloured(at(new THREE.ConeGeometry(0.012, 0.09, 4), 0.025, 0.25, -0.24, -0.9), HORN),
        coloured(at(box(0.04, 0.04, 0.2), 0, 0.15, 0.3, 0.2), SKIN),
        leg(-0.07, -0.07, 0.1, 0.045, SKIN), leg(0.07, -0.07, 0.1, 0.045, SKIN), leg(-0.07, 0.13, 0.1, 0.045, SKIN), leg(0.07, 0.13, 0.1, 0.045, SKIN),
      ]);
    case "ankylosaur":
      return merge([
        coloured(at(ellip(0.13, 0.07, 0.22), 0, 0.12, 0.02), "#7d7262"),
        coloured(at(box(0.08, 0.06, 0.08), 0, 0.1, -0.24), SKIN),
        coloured(at(box(0.03, 0.03, 0.3), 0, 0.1, 0.33), SKIN),
        coloured(at(box(0.08, 0.05, 0.06), 0, 0.1, 0.5), "#6c6152"),                 // tail club
        leg(-0.09, -0.1, 0.07, 0.045, SKIN), leg(0.09, -0.1, 0.07, 0.045, SKIN), leg(-0.09, 0.12, 0.07, 0.045, SKIN), leg(0.09, 0.12, 0.07, 0.045, SKIN),
      ]);
    case "stegosaur": {
      const parts = [
        coloured(at(ellip(0.08, 0.1, 0.2), 0, 0.2, 0.02), SKIN),
        coloured(at(box(0.04, 0.04, 0.12), 0, 0.12, -0.24, 0.3), SKIN),
        coloured(at(box(0.035, 0.035, 0.35), 0, 0.17, 0.33, -0.15), SKIN),
        leg(-0.06, -0.1, 0.1, 0.04, SKIN), leg(0.06, -0.1, 0.1, 0.04, SKIN), leg(-0.06, 0.12, 0.14, 0.045, SKIN), leg(0.06, 0.12, 0.14, 0.045, SKIN),
      ];
      for (let k = 0; k < 6; k++) parts.push(coloured(at(new THREE.ConeGeometry(0.05, 0.1, 3), 0, 0.33 - Math.abs(k - 2.5) * 0.015, -0.12 + k * 0.06, 0, Math.PI / 2, 0, 0.3, 1, 1), "#a86b48"));
      return merge(parts);
    }
    case "large_theropod":
    case "small_theropod": {
      const big = plan === "large_theropod";
      return merge([
        coloured(at(ellip(0.07, 0.08, 0.15), 0, 0.3, 0.02, 0.15), SKIN),
        coloured(at(box(0.05, 0.05, 0.1), 0, 0.38, -0.15, -0.6), SKIN),
        coloured(at(box(big ? 0.07 : 0.045, big ? 0.07 : 0.04, big ? 0.14 : 0.1), 0, 0.42, -0.24), SKIN),
        coloured(at(box(0.035, 0.04, 0.42), 0, 0.3, 0.3, 0.08), SKIN),
        leg(-0.045, 0.05, 0.23, 0.04, SKIN), leg(0.045, 0.05, 0.23, 0.04, SKIN),
        coloured(at(box(0.015, 0.06, 0.015), -0.05, 0.3, -0.1, 0.6), SKIN), coloured(at(box(0.015, 0.06, 0.015), 0.05, 0.3, -0.1, 0.6), SKIN),
      ]);
    }
    case "pterosaur":
      return merge([
        coloured(at(ellip(0.04, 0.035, 0.1), 0, 0, 0), SKIN),
        coloured(at(box(0.6, 0.008, 0.12), 0, 0.01, 0.02), "#b9a58a"),              // wings, spanning ~1.2 × length
        coloured(at(box(0.03, 0.03, 0.18), 0, 0.02, -0.15), SKIN),
        coloured(at(new THREE.ConeGeometry(0.02, 0.1, 3), 0, 0.06, -0.15, -1.2), "#b25a3a"),   // crest
      ]);
    case "crocodylomorph":
      return merge([
        coloured(at(ellip(0.07, 0.04, 0.2), 0, 0.06, 0), "#5f6650"),
        coloured(at(box(0.05, 0.03, 0.17), 0, 0.05, -0.27), "#5f6650"),
        coloured(at(box(0.03, 0.03, 0.42), 0, 0.05, 0.3), "#5f6650"),
        leg(-0.07, -0.08, 0.04, 0.025, "#5f6650"), leg(0.07, -0.08, 0.04, 0.025, "#5f6650"), leg(-0.07, 0.1, 0.04, 0.025, "#5f6650"), leg(0.07, 0.1, 0.04, 0.025, "#5f6650"),
      ]);
    case "turtle":
      return merge([
        coloured(at(new THREE.SphereGeometry(0.35, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.05, 0, 0, 0, 0, 1, 0.55, 1.2), "#6a6044"),
        coloured(at(box(0.12, 0.08, 0.15), 0, 0.08, -0.45), BELLY),
        leg(-0.25, -0.2, 0.06, 0.08, BELLY), leg(0.25, -0.2, 0.06, 0.08, BELLY), leg(-0.25, 0.2, 0.06, 0.08, BELLY), leg(0.25, 0.2, 0.06, 0.08, BELLY),
      ]);
    case "marine_reptile":
      return merge([
        coloured(at(ellip(0.09, 0.07, 0.25), 0, 0, 0), "#55646b"),
        coloured(at(box(0.04, 0.04, 0.2), 0, 0.02, -0.33), "#55646b"),
        coloured(at(box(0.25, 0.015, 0.07), 0, -0.02, -0.08, 0, 0, 0.1), "#4b585e"),
        coloured(at(box(0.22, 0.015, 0.06), 0, -0.02, 0.12, 0, 0, -0.1), "#4b585e"),
        coloured(at(box(0.03, 0.03, 0.25), 0, 0, 0.35), "#55646b"),
      ]);
    default:  // small tetrapods (mammals, birds, lizards…): a small generic quadruped
      return merge([
        coloured(at(ellip(0.12, 0.1, 0.25), 0, 0.22, 0), "#7b6a55"),
        coloured(at(ellip(0.09, 0.08, 0.1), 0, 0.27, -0.28), "#7b6a55"),
        coloured(at(box(0.03, 0.03, 0.35), 0, 0.2, 0.38, 0.3), "#7b6a55"),
        leg(-0.07, -0.12, 0.12, 0.03, "#6a5a48"), leg(0.07, -0.12, 0.12, 0.03, "#6a5a48"), leg(-0.07, 0.12, 0.12, 0.03, "#6a5a48"), leg(0.07, 0.12, 0.12, 0.03, "#6a5a48"),
      ]);
  }
}

/** Generated tint around white (so baked part colours dominate), from a seed. */
export function tintFromSeed(seed: number, strength: number, out: THREE.Color): THREE.Color {
  const h = ((seed >>> 0) % 360) / 360, s = (((seed >>> 9) % 100) / 100) * strength, l = 0.85 + (((seed >>> 17) % 100) / 100) * 0.3;
  return out.setHSL(h, s, Math.min(1, l));
}
