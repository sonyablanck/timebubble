// Procedural body-plan models (render §7–§8, DESIGN A10), built in code so the repo needs no art
// assets. Plants are 1 unit tall (scaled to height in metres) and come in a few variants per plan;
// animals are 1 unit long along −z (forward), scaled to body length.
//
// Animals are smooth hulls swept along a spine (snout → tail), with jointed limbs. Every vertex
// carries two extra attributes read by the organism shader (materials.ts):
//   aBody = (s, v, u): position along the body 0–1, vertical position in the cross-section −1–1, and
//                      angle around it 0–1, used for countershading and generated patterns
//   aRig  = (kind, a, b, c): how the vertex moves
//            kind 0 still · 1 leg (pivot y = a, z = b, phase = c) · 2 tail (weight a)
//            kind 3 neck/head (weight a, pivot y = b, z = c) · 4 wing (weight a) · 5 flipper (weight a, phase b)
//            plants use kind 0 with sway weight in a
// Shapes are generic: proportions follow the body plan, not any one species (cards say so).

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PlantPlan } from "../../biome/plants";
import type { AnimalPlan } from "../../ecology/roster";
import { mulberry32 } from "../../terrain/noise";

type Part = THREE.BufferGeometry;
type V3 = THREE.Vector3;
type Rgb = THREE.Color;
type ColourFn = (p: V3, body: [number, number, number]) => Rgb;
type RigFn = (p: V3, body: [number, number, number]) => [number, number, number, number];

const col = (hex: string) => new THREE.Color(hex);

/** Give a geometry the shared attribute set (non-indexed): colour, aBody, aRig. */
function finish(g: THREE.BufferGeometry, colour: Rgb | ColourFn, rig: RigFn | [number, number, number, number] = [0, 0, 0, 0],
  body?: (i: number, p: V3) => [number, number, number]): Part {
  const geo = g.index ? g.toNonIndexed() : g;
  if (!geo.getAttribute("normal")) geo.computeVertexNormals();
  for (const k of Object.keys(geo.attributes)) if (k !== "position" && k !== "normal" && k !== "aBody") geo.deleteAttribute(k);
  const pos = geo.getAttribute("position"), n = pos.count;
  const c = new Float32Array(n * 3), r = new Float32Array(n * 4);
  const bodyAttr = geo.getAttribute("aBody") as THREE.BufferAttribute | undefined;
  const b = bodyAttr ? (bodyAttr.array as Float32Array) : new Float32Array(n * 3).fill(-1);
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    if (!bodyAttr && body) { const bb = body(i, p); b[i * 3] = bb[0]; b[i * 3 + 1] = bb[1]; b[i * 3 + 2] = bb[2]; }
    const bb: [number, number, number] = [b[i * 3]!, b[i * 3 + 1]!, b[i * 3 + 2]!];
    const cc = typeof colour === "function" ? colour(p, bb) : colour;
    c[i * 3] = cc.r; c[i * 3 + 1] = cc.g; c[i * 3 + 2] = cc.b;
    const rr = typeof rig === "function" ? rig(p, bb) : rig;
    r.set(rr, i * 4);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  geo.setAttribute("aBody", new THREE.BufferAttribute(b, 3));
  geo.setAttribute("aRig", new THREE.BufferAttribute(r, 4));
  return geo;
}

/** Place a geometry. Three's X rotation: rx > 0 raises the −z (front) end and lowers the +z end. */
function at<T extends THREE.BufferGeometry>(g: T, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): T {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")), new THREE.Vector3(sx, sy, sz));
  g.applyMatrix4(m);
  return g;
}

function merge(parts: Part[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Deterministic hash of a position (so duplicated vertices of a non-indexed mesh move together). */
function hash3(x: number, y: number, z: number, seed: number): number {
  const q = (v: number) => Math.round(v * 1e4);
  let h = (q(x) * 73856093) ^ (q(y) * 19349663) ^ (q(z) * 83492791) ^ (seed * 2654435761);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A lumpy foliage blob: icosahedron with each corner pushed in or out, faceted. */
function blob(r: number, seed: number, rough = 0.35, detail = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 1 + rough * (hash3(x, y, z, seed) - 0.5) * 2;
    pos.setXYZ(i, x * k, y * k * 0.9, z * k);
  }
  g.deleteAttribute("normal");
  g.computeVertexNormals();
  return g;
}

/** Tapered trunk from y = 0 to y = h, bending slightly by `lean` (x offset at the top). */
function trunk(r0: number, r1: number, h: number, seg = 7, lean = 0, rows = 4): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, rows, true);
  g.translate(0, h / 2, 0);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) { const t = pos.getY(i) / h; pos.setX(i, pos.getX(i) + lean * t * t); }
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ hull (spine sweep)

interface Node { x?: number; y: number; z: number; w: number; h: number }

/** Sweep an ellipse (half-width w, half-height h) along a Catmull-Rom spine through the nodes. */
function hull(nodes: Node[], opts: { sides?: number; perSpan?: number; sMap?: (p: number) => number } = {}): THREE.BufferGeometry {
  const sides = opts.sides ?? 10, perSpan = opts.perSpan ?? 3;
  const pts = nodes.map((n) => new THREE.Vector3(n.x ?? 0, n.y, n.z));
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const rings = (nodes.length - 1) * perSpan + 1;
  const pos: number[] = [], body: number[] = [], idx: number[] = [];
  const X0 = new THREE.Vector3(1, 0, 0), Z0 = new THREE.Vector3(0, 0, 1);
  const T = new THREE.Vector3(), X = new THREE.Vector3(), U = new THREE.Vector3(), C = new THREE.Vector3();
  for (let r = 0; r < rings; r++) {
    const t = r / (rings - 1), p = t * (nodes.length - 1);
    const i0 = Math.min(nodes.length - 2, Math.floor(p)), f = p - i0;
    const sm = f * f * (3 - 2 * f);
    const w = nodes[i0]!.w + (nodes[i0 + 1]!.w - nodes[i0]!.w) * sm, h = nodes[i0]!.h + (nodes[i0 + 1]!.h - nodes[i0]!.h) * sm;
    curve.getPoint(t, C);
    curve.getTangent(t, T);
    const ref = Math.abs(T.dot(X0)) > 0.9 ? Z0 : X0;
    X.copy(ref).addScaledVector(T, -T.dot(ref)).normalize();
    U.crossVectors(X, T).normalize();
    if (U.y < 0 && Math.abs(T.y) < 0.7) { U.negate(); X.negate(); }
    const s = opts.sMap ? opts.sMap(p) : t;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      pos.push(C.x + X.x * ca * w + U.x * sa * h, C.y + X.y * ca * w + U.y * sa * h, C.z + X.z * ca * w + U.z * sa * h);
      body.push(s, sa, k / sides);
    }
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let k = 0; k < sides; k++) {
      const a = r * sides + k, b = r * sides + ((k + 1) % sides), c = a + sides, d = b + sides;
      idx.push(a, c, b, b, c, d);
    }
  }
  // caps
  for (const [r, flip] of [[0, true], [rings - 1, false]] as [number, boolean][]) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < sides; k++) { cx += pos[(r * sides + k) * 3]!; cy += pos[(r * sides + k) * 3 + 1]!; cz += pos[(r * sides + k) * 3 + 2]!; }
    const ci = pos.length / 3;
    pos.push(cx / sides, cy / sides, cz / sides);
    body.push(body[r * sides * 3]!, 0, 0);
    for (let k = 0; k < sides; k++) {
      const a = r * sides + k, b = r * sides + ((k + 1) % sides);
      if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aBody", new THREE.Float32BufferAttribute(body, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // keep aBody through toNonIndexed (finish() reads it)
  return g.toNonIndexed();
}

// ------------------------------------------------------------------ plants

const BARK = col("#6b5440"), DARK_BARK = col("#4a3a2c"), PALE_BARK = col("#8a7a66"), DEAD = col("#8a7f72"), DEAD_DARK = col("#62584d");

/** Foliage colour with fake ambient occlusion: darker low and inside the crown, lighter at the top and rim. */
function foliage(base: string, yMin: number, yMax: number, cx = 0, cz = 0, rMax = 1): ColourFn {
  const c0 = col(base);
  return (p) => {
    const up = THREE.MathUtils.clamp((p.y - yMin) / Math.max(1e-6, yMax - yMin), 0, 1);
    const out = THREE.MathUtils.clamp(Math.hypot(p.x - cx, p.z - cz) / rMax, 0, 1);
    const k = 0.78 + 0.25 * up + 0.15 * out;
    return c0.clone().multiplyScalar(k);
  };
}
const barkFn = (c: Rgb, h: number): ColourFn => (p) => c.clone().multiplyScalar(0.85 + 0.25 * THREE.MathUtils.clamp(p.y / h, 0, 1));
const sway = (h0: number, h1: number, k = 1): RigFn => (p) => { const t = THREE.MathUtils.clamp((p.y - h0) / Math.max(1e-6, h1 - h0), 0, 1); return [0, k * t * t, 0, 0]; };

/**
 * A pinnate frond: a curved rachis along +x with leaflet pairs, base at the origin. `arch` lifts the
 * middle, `droop` drops the tip; leaflets shrink towards the tip. Double-sided quads.
 */
function frond(len: number, arch: number, droop: number, leaf: number, pairs: number, hex: string, opts: { stiff?: boolean; width?: number } = {}): Part {
  const pos: number[] = [], rachisW = (opts.width ?? 0.012) * len;
  const at_ = (t: number) => [t * len, arch * Math.sin(Math.PI * Math.min(1, t * 1.1)) * len - droop * t * t * len] as const;
  const segs = pairs;
  for (let i = 0; i < segs; i++) {
    const [x0, y0] = at_(i / segs), [x1, y1] = at_((i + 1) / segs);
    pos.push(x0, y0, -rachisW, x1, y1, -rachisW * 0.6, x0, y0, rachisW, x0, y0, rachisW, x1, y1, -rachisW * 0.6, x1, y1, rachisW * 0.6);
  }
  const spacing = len / (pairs + 1);
  for (let i = 1; i <= pairs; i++) {
    const t = i / (pairs + 1);
    const [x, y] = at_(t), [xn, yn] = at_(Math.min(1, t + 0.5 / pairs));
    const dx = (xn - x), dy = (yn - y), dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl;
    const L = leaf * len * (opts.stiff ? 1 - 0.5 * t : Math.sin(Math.PI * (0.25 + 0.75 * t)) * (1 - 0.35 * t));
    const w = spacing * (opts.stiff ? 0.35 : 0.6);   // half-width at the base: neighbouring leaflets nearly touch
    const sag = L * (opts.stiff ? 0.05 : 0.22), fwd = L * 0.35;
    for (const side of [-1, 1]) {
      // lanceolate leaflet: broad base on the rachis, swept forward and sagging to a point
      const A = [x - ux * w, y - uy * w, 0], B = [x + ux * w, y + uy * w, 0];
      const M1 = [x + ux * (fwd * 0.4 + w), y + uy * (fwd * 0.4 + w) - sag * 0.4, side * L * 0.5];
      const M0 = [x + ux * (fwd * 0.4 - w * 0.6), y + uy * (fwd * 0.4 - w * 0.6) - sag * 0.45, side * L * 0.5];
      const T = [x + ux * fwd, y + uy * fwd - sag, side * L];
      const tris = side > 0 ? [A, M0, B, B, M0, M1, M1, M0, T] : [A, B, M0, B, M1, M0, M1, T, M0];
      for (const q of tris) pos.push(q[0]!, q[1]!, q[2]!);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const c = col(hex);
  return finish(g, (p) => c.clone().multiplyScalar(0.62 + 0.38 * THREE.MathUtils.clamp(p.x / len, 0, 1)),
    (p) => [0, 0.2 + 0.8 * THREE.MathUtils.clamp(p.x / len, 0, 1) ** 1.5, 0, 0]);
}

/** Place a frond (built along +x) at height y, pointing at azimuth az and tilted up by `tilt`. */
function placeFrond(f: Part, x: number, y: number, z: number, az: number, tilt: number): Part {
  f.applyMatrix4(new THREE.Matrix4().makeRotationZ(tilt));
  f.applyMatrix4(new THREE.Matrix4().makeRotationY(az));
  f.translate(x, y, z);
  return f;
}

/** A conifer tier: a jagged, drooping skirt of foliage. */
function skirt(r: number, h: number, seed: number, seg = 11): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, seg, 2, true);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (y < -h / 2 + 1e-6) {
      const a = Math.atan2(z, x), k = Math.round(((a + Math.PI) / (Math.PI * 2)) * seg) % seg;
      const jag = (k % 2 ? 0.82 : 1.08) * (0.9 + 0.2 * hash3(k, seg, r, seed));
      pos.setXYZ(i, x * jag, y - h * 0.18 * (k % 2 ? 0 : 1) - h * 0.1 * hash3(k, 1, r, seed), z * jag);
    } else if (y < h / 2 - 1e-6) {
      const j = 1 + 0.12 * (hash3(x, y, z, seed) - 0.5);
      pos.setXYZ(i, x * j, y, z * j);
    }
  }
  g.translate(0, h / 2, 0);
  g.computeVertexNormals();
  return g;
}

function conifer(variant: number): Part[] {
  const parts: Part[] = [];
  if (variant === 1) {
    // monkey-puzzle style: tall clear trunk, flat-topped crown of tufted horizontal branches
    parts.push(finish(trunk(0.03, 0.012, 1, 8), barkFn(PALE_BARK, 1), sway(0, 1, 0.3)));
    const rnd = mulberry32(11);
    for (let tier = 0; tier < 5; tier++) {
      const y = 0.62 + tier * 0.08, n = 5, len = 0.2 - tier * 0.03;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + tier * 0.6;
        const arm = at(new THREE.CylinderGeometry(0.004, 0.007, len, 4), Math.cos(a) * len / 2, y + 0.02, Math.sin(a) * len / 2, 0, -a, -(Math.PI / 2 - 0.15));
        parts.push(finish(arm, BARK, sway(0.5, 1, 0.6)));
        const tuft = at(blob(0.05 + 0.02 * rnd(), 40 + tier * 7 + k, 0.4), Math.cos(a) * len, y + 0.035, Math.sin(a) * len, 0, 0, 0, 1.2, 0.55, 1.2);
        parts.push(finish(tuft, foliage("#2f4a2c", 0.55, 1, 0, 0, 0.25), sway(0.5, 1)));
      }
    }
    parts.push(finish(at(blob(0.07, 9, 0.35), 0, 0.97, 0, 0, 0, 0, 1.2, 0.6, 1.2), foliage("#334f2f", 0.9, 1.02), sway(0.5, 1)));
    return parts;
  }
  if (variant === 2) {
    // podocarp / cypress style: dense, lumpy, broadly conical crown
    parts.push(finish(trunk(0.035, 0.015, 0.45, 7), barkFn(DARK_BARK, 0.45), sway(0, 1, 0.3)));
    const rnd = mulberry32(23);
    for (let k = 0; k < 11; k++) {
      const t = k / 10, y = 0.25 + t * 0.68, r = (0.2 - t * 0.15) * (0.85 + 0.3 * rnd());
      const a = rnd() * Math.PI * 2, off = r * 0.35;
      parts.push(finish(at(blob(r, 60 + k, 0.4), Math.cos(a) * off, y, Math.sin(a) * off, 0, rnd() * 3, 0, 1, 1.15, 1), foliage("#2c4433", 0.15, 1, 0, 0, 0.25), sway(0.2, 1)));
    }
    return parts;
  }
  // tall spire: drooping, jagged tiers of foliage on a straight trunk
  parts.push(finish(trunk(0.032, 0.006, 1, 7), barkFn(BARK, 1), sway(0, 1, 0.3)));
  const tiers = 9;
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1), y = 0.2 + t * 0.72, r = 0.25 * (1 - t) ** 0.9 + 0.035, h = 0.13 + 0.03 * (1 - t);
    parts.push(finish(at(skirt(r, h, 100 + k), 0, y, 0, 0, k * 0.7, 0), foliage(k % 2 ? "#2d4a34" : "#335339", 0.15, 1, 0, 0, 0.27), sway(0.15, 1)));
  }
  return parts;
}

function angiosperm(variant: number): Part[] {
  const parts: Part[] = [], rnd = mulberry32(31 + variant * 17);
  const green = ["#4f7a35", "#5a8338", "#47703a"][variant]!;
  if (variant === 2) {
    // multi-stemmed shrub
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4, lean = 0.12;
      parts.push(finish(at(trunk(0.018, 0.008, 0.5, 5, lean), 0, 0, 0, 0, a, 0), barkFn(BARK, 0.5), sway(0, 0.6, 0.5)));
    }
    for (let k = 0; k < 9; k++) {
      const a = rnd() * Math.PI * 2, d = 0.12 + 0.18 * rnd(), y = 0.45 + 0.35 * rnd();
      parts.push(finish(at(blob(0.17 + 0.07 * rnd(), 200 + k, 0.4), Math.cos(a) * d, y, Math.sin(a) * d, 0, rnd() * 3, 0, 1.1, 0.85, 1.1), foliage(green, 0.25, 1, 0, 0, 0.45), sway(0.3, 1)));
    }
    return parts;
  }
  const crownY = variant === 1 ? 0.62 : 0.66, crownR = variant === 1 ? 0.2 : 0.32, crownH = variant === 1 ? 0.32 : 0.24;
  parts.push(finish(trunk(0.04, 0.022, crownY - 0.05, 7, 0.02), barkFn(BARK, crownY), sway(0, 1, 0.3)));
  // limbs forking into the crown
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3;
    const limb = at(trunk(0.018, 0.008, 0.22, 5), 0, 0, 0, 0, 0, 0.55);
    limb.applyMatrix4(new THREE.Matrix4().makeRotationY(a));
    limb.translate(0, crownY - 0.12, 0);
    parts.push(finish(limb, barkFn(BARK, 1), sway(0.3, 1, 0.5)));
  }
  const n = variant === 1 ? 7 : 9;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rnd() * 0.6, d = crownR * (0.35 + 0.55 * rnd());
    const y = crownY + crownH * (0.15 + 0.8 * rnd()) * (1 - 0.5 * d / crownR);
    const r = (variant === 1 ? 0.13 : 0.16) + 0.06 * rnd();
    parts.push(finish(at(blob(r, 300 + variant * 31 + k, 0.4), Math.cos(a) * d, y, Math.sin(a) * d, 0, rnd() * 3, 0, 1.1, 0.85, 1.1),
      foliage(green, crownY - 0.1, crownY + crownH + 0.15, 0, 0, crownR + 0.15), sway(0.3, 1)));
  }
  parts.push(finish(at(blob(crownR * 0.6, 390 + variant, 0.35), 0, crownY + crownH * 0.85, 0), foliage(green, crownY, crownY + crownH + 0.2), sway(0.3, 1)));
  return parts;
}

function ginkgo(variant: number): Part[] {
  const parts: Part[] = [], rnd = mulberry32(41 + variant);
  parts.push(finish(trunk(0.035, 0.014, 0.9, 7), barkFn(PALE_BARK, 0.9), sway(0, 1, 0.3)));
  const nb = variant === 1 ? 6 : 4;
  for (let k = 0; k < nb; k++) {
    const a = (k / nb) * Math.PI * 2 + rnd(), y = 0.35 + 0.45 * (k / nb), len = variant === 1 ? 0.22 - 0.12 * (k / nb) : 0.3;
    const br = at(trunk(0.012, 0.004, len, 4), 0, 0, 0, 0, 0, -(variant === 1 ? 1.1 : 0.7));
    br.applyMatrix4(new THREE.Matrix4().makeRotationY(a));
    br.translate(0, y, 0);
    parts.push(finish(br, barkFn(PALE_BARK, 1), sway(0.3, 1, 0.5)));
    const tipX = Math.cos(a) * Math.sin(variant === 1 ? 1.1 : 0.7) * len, tipY = y + Math.cos(variant === 1 ? 1.1 : 0.7) * len;
    for (let j = 0; j < 2; j++) {
      parts.push(finish(at(blob(0.1 + 0.05 * rnd(), 500 + k * 3 + j, 0.45), tipX * (0.75 + 0.3 * j), tipY + 0.03 * j, -Math.sin(a) * Math.sin(variant === 1 ? 1.1 : 0.7) * len * (0.75 + 0.3 * j), 0, rnd() * 3, 0, 1, 0.8, 1),
        foliage("#6f8a3c", 0.3, 1, 0, 0, 0.35), sway(0.3, 1)));
    }
  }
  parts.push(finish(at(blob(0.1, 590, 0.4), 0, 0.93, 0), foliage("#6f8a3c", 0.8, 1.05), sway(0.3, 1)));
  return parts;
}

function frondCrown(parts: Part[], n: number, y: number, len: number, hex: string, tilt: number, droop: number, seed: number, stiff = false): void {
  const rnd = mulberry32(seed);
  for (let k = 0; k < n; k++) {
    const az = (k / n) * Math.PI * 2 + rnd() * 0.4;
    const f = frond(len * (0.85 + 0.3 * rnd()), stiff ? 0.06 : 0.12, droop * (0.8 + 0.4 * rnd()), stiff ? 0.16 : 0.2, stiff ? 13 : 15, hex, { stiff });
    parts.push(placeFrond(f, 0, y, 0, az, tilt * (0.85 + 0.3 * rnd())));
  }
}

function seedFern(variant: number): Part[] {
  const parts: Part[] = [];
  if (variant === 1) { frondCrown(parts, 10, 0.02, 0.75, "#5d7a3a", 0.9, 0.6, 71); return parts; }
  parts.push(finish(trunk(0.03, 0.02, 0.8, 6, 0.03), barkFn(DARK_BARK, 0.8), sway(0, 1, 0.3)));
  frondCrown(parts, 8, 0.78, 0.5, "#5d7a3a", 0.35, 0.8, 72);
  return parts;
}

function cycad(variant: number): Part[] {
  const parts: Part[] = [];
  if (variant === 1) {
    // Cycadeoidea-like: squat barrel trunk with short stiff fronds
    const barrel = at(new THREE.SphereGeometry(0.22, 10, 7), 0, 0.22, 0, 0, 0, 0, 1, 0.95, 1);
    const pos = barrel.getAttribute("position");
    for (let i = 0; i < pos.count; i++) { const j = 1 + 0.06 * (hash3(pos.getX(i), pos.getY(i), pos.getZ(i), 7) - 0.5); pos.setXYZ(i, pos.getX(i) * j, pos.getY(i), pos.getZ(i) * j); }
    barrel.computeVertexNormals();
    parts.push(finish(barrel, barkFn(col("#7a6446"), 0.45)));
    frondCrown(parts, 12, 0.4, 0.5, "#4c6b33", 0.7, 0.15, 81, true);
    return parts;
  }
  if (variant === 2) {
    // Williamsonia-like: slender forked trunk with frond tufts
    for (const [a, lean] of [[0.4, 0.15], [2.8, 0.12]] as [number, number][]) {
      parts.push(finish(at(trunk(0.035, 0.022, 0.7, 6, lean), 0, 0, 0, 0, a, 0), barkFn(col("#6e5a3e"), 0.7), sway(0, 1, 0.3)));
      const tx = Math.cos(-a) * lean, tz = Math.sin(-a) * lean, sub: Part[] = [];
      frondCrown(sub, 8, 0, 0.32, "#4c6b33", 0.6, 0.25, 82 + Math.round(a * 10), true);
      for (const s of sub) parts.push(s.translate(tx, 0.69, tz));
    }
    return parts;
  }
  // cycad: stout trunk with leaf-base texture and a crown of stiff fronds
  const tr = trunk(0.1, 0.085, 0.42, 9, 0, 6);
  const pos = tr.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), k = 1 + 0.08 * Math.abs(Math.sin(y * 60 + Math.atan2(pos.getZ(i), pos.getX(i)) * 3));
    pos.setXYZ(i, pos.getX(i) * k, y, pos.getZ(i) * k);
  }
  tr.computeVertexNormals();
  parts.push(finish(tr, barkFn(col("#6e5a3e"), 0.42)));
  frondCrown(parts, 13, 0.41, 0.6, "#4c6b33", 0.75, 0.35, 83, true);
  return parts;
}

function fern(variant: number): Part[] {
  const parts: Part[] = [];
  if (variant === 1) {
    // tree fern
    parts.push(finish(trunk(0.035, 0.03, 0.7, 6, 0.04), barkFn(DARK_BARK, 0.7), sway(0, 1, 0.3)));
    frondCrown(parts, 9, 0.7, 0.45, "#5f8b3c", 0.45, 0.9, 91);
    return parts;
  }
  if (variant === 2) { frondCrown(parts, 7, 0.0, 1.0, "#6a9140", 0.6, 0.35, 92); return parts; }   // low, spreading
  frondCrown(parts, 11, 0.0, 0.85, "#5f8b3c", 1.05, 0.75, 93);                                          // shuttlecock clump
  return parts;
}

function horsetail(variant: number): Part[] {
  const parts: Part[] = [], rnd = mulberry32(101 + variant);
  const n = variant === 1 ? 7 : 10, segs = 6;
  const green = col("#6b8a45"), node = col("#3e4f2a");
  for (let k = 0; k < n; k++) {
    const a = rnd() * Math.PI * 2, d = 0.04 + 0.16 * Math.sqrt(rnd()), h = (variant === 1 ? 0.85 : 0.7) + 0.3 * rnd();
    const x = Math.cos(a) * d, z = Math.sin(a) * d, lean = (rnd() - 0.5) * 0.08;
    // one jointed stem: dark bands at the nodes are baked into the vertex colours
    const st = new THREE.CylinderGeometry(0.011, 0.014, h, 5, segs * 2, true);
    st.translate(0, h / 2, 0);
    const sp = st.getAttribute("position");
    for (let i = 0; i < sp.count; i++) sp.setX(i, sp.getX(i) + lean * (sp.getY(i) / h));
    st.computeVertexNormals();
    st.translate(x, 0, z);
    parts.push(finish(st, (q) => { const f = (((q.y / h) * segs) % 1 + 1) % 1; return (f > 0.9 ? node : green).clone().multiplyScalar(0.7 + 0.35 * (q.y / h)); }, sway(0, 1.2, 0.8)));
    for (let s2 = 1; s2 < segs - 1; s2++) {
      const y1 = (s2 / segs) * h;
      for (let b = 0; b < 5; b++) {
        const ba = (b / 5) * Math.PI * 2 + s2;
        const br = at(new THREE.CylinderGeometry(0.0015, 0.003, 0.09, 3), x + lean * (y1 / h) + Math.cos(ba) * 0.04, y1 + 0.015, z + Math.sin(ba) * 0.04, 0, -ba, -(Math.PI / 2 - 0.5));
        parts.push(finish(br, col("#5c7a3a"), sway(0, 1.2, 0.8)));
      }
    }
    parts.push(finish(at(new THREE.ConeGeometry(0.016, 0.05, 5), x + lean, h + 0.025, z), col("#7a6a45"), sway(0, 1.2, 0.8)));   // strobilus
  }
  return parts;
}

function snag(variant: number): Part[] {
  const parts: Part[] = [];
  if (variant === 1) {
    parts.push(finish(trunk(0.035, 0.02, 1, 7, 0.06), barkFn(DEAD, 1)));
    for (const [y, a, len, tilt] of [[0.45, 0.4, 0.3, 0.9], [0.6, 2.4, 0.26, 0.8], [0.72, 4.2, 0.22, 0.7], [0.82, 1.4, 0.18, 0.6]] as [number, number, number, number][]) {
      const br = at(trunk(0.01, 0.003, len, 4), 0, 0, 0, 0, 0, tilt);
      br.applyMatrix4(new THREE.Matrix4().makeRotationY(a));
      br.translate(0.06 * y * y, y, 0);
      parts.push(finish(br, DEAD_DARK));
    }
    return parts;
  }
  // broken trunk with stubs, the top splintered
  const tr = trunk(0.045, 0.03, 1, 7, 0.02);
  const pos = tr.getAttribute("position");
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0.99) pos.setY(i, 0.86 + 0.14 * hash3(pos.getX(i), 0, pos.getZ(i), 3));
  tr.computeVertexNormals();
  parts.push(finish(tr, barkFn(DEAD, 1)));
  for (const [y, a] of [[0.4, 0.6], [0.58, 2.5], [0.7, 4.4]] as [number, number][]) {
    const br = at(trunk(0.012, 0.006, 0.12, 4), 0, 0, 0, 0, 0, 1.0);
    br.applyMatrix4(new THREE.Matrix4().makeRotationY(a));
    br.translate(0, y, 0);
    parts.push(finish(br, DEAD_DARK));
  }
  return parts;
}

/** Number of shape variants per plant plan (an instance's variant comes from its colour seed). */
export const PLANT_VARIANTS: Record<PlantPlan | "snag", number> = {
  conifer: 3, ginkgo: 2, early_angiosperm: 3, seed_fern: 2, cycad_bennettitalean: 3, fern: 3, horsetail: 2, snag: 2,
};

export function plantVariant(plan: PlantPlan | "snag", colourSeed: number): number {
  return ((colourSeed >>> 3) % PLANT_VARIANTS[plan]) | 0;
}

/** Plant model, normalised to exactly 1 unit tall standing on y = 0 (PLANT_HEIGHT_M is the drawn height). */
export function plantGeometry(plan: PlantPlan | "snag", variant = 0): THREE.BufferGeometry {
  const v = Math.min(variant, PLANT_VARIANTS[plan] - 1);
  const parts = plan === "conifer" ? conifer(v) : plan === "early_angiosperm" ? angiosperm(v) : plan === "ginkgo" ? ginkgo(v)
    : plan === "seed_fern" ? seedFern(v) : plan === "cycad_bennettitalean" ? cycad(v) : plan === "fern" ? fern(v)
    : plan === "horsetail" ? horsetail(v) : snag(v);
  const g = merge(parts);
  // frond tips that droop below the ground lie on it instead
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0) pos.setY(i, pos.getY(i) * 0.05);
  g.computeBoundingBox();
  const top = g.boundingBox!.max.y;
  if (top > 0) g.scale(1 / top, 1 / top, 1 / top);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ animals

interface Limb { x: number; y: number; z: number; r: number; knee: number; ankle?: number; foot: number; phase: number; sprawl?: number }
interface Spec {
  spine: [number, number, number, number][];   // z, y, half-width, half-height (snout → tail tip)
  shoulder: number;                            // index of the shoulder node (nodes before it are neck and head)
  hip: number;                                 // index of the hip node (nodes after it are tail)
  legs: Limb[];
  back: string; belly: string;
  extras?: (parts: Part[], skin: ColourFn, top: (z: number) => { top: number; halfW: number; y: number }) => void;
  realm: "land" | "air" | "sea";
}

const DIAG = [0, Math.PI, Math.PI, 0];   // LF, RF, LH, RH: diagonal pairs in step

function countershade(back: string, belly: string): ColourFn {
  const b = col(back), u = col(belly);
  return (_p, [, v]) => u.clone().lerp(b, THREE.MathUtils.smoothstep(v, -0.45, 0.55));
}

function limb(l: Limb, skin: ColourFn): Part {
  const sp = l.sprawl ?? 0, side = Math.sign(l.x) || 1;
  const nodes: Node[] = [
    { x: l.x, y: l.y, z: l.z, w: l.r, h: l.r * 1.15 },
    { x: l.x + side * sp * 0.6, y: l.y * 0.55, z: l.z + l.knee, w: l.r * 0.85, h: l.r * 0.9 },
    { x: l.x + side * sp, y: l.y * 0.12, z: l.z + (l.ankle ?? 0), w: l.r * 0.7, h: l.r * 0.7 },
    { x: l.x + side * sp, y: l.r * 0.25, z: l.z + (l.ankle ?? 0) - l.foot, w: l.r * 0.8, h: l.r * 0.25 },
  ];
  const g = hull(nodes, { sides: 7, perSpan: 2, sMap: () => 0.5 });
  return finish(g, (p, b) => skin(p, [b[0], -0.2 - 0.5 * (1 - p.y / l.y), b[2]]).multiplyScalar(0.85 + 0.15 * p.y / l.y), [1, l.y, l.z, l.phase]);
}

function buildAnimal(s: Spec): THREE.BufferGeometry {
  const skin = countershade(s.back, s.belly);
  const n = s.spine.length;
  const shoulderZ = s.spine[s.shoulder]![0], shoulderY = s.spine[s.shoulder]![1];
  const body = hull(s.spine.map(([z, y, w, h]) => ({ y, z, w, h })), { sides: 12, perSpan: 3, sMap: (p) => p / (n - 1) });
  const parts: Part[] = [finish(body, skin, (_p, [sAlong]) => {
    const p = sAlong * (n - 1);
    if (p < s.shoulder) return [3, (1 - p / s.shoulder), shoulderY, shoulderZ];
    if (p > s.hip) return [2, (p - s.hip) / (n - 1 - s.hip), 0, 0];
    return [0, 0, 0, 0];
  })];
  for (const l of s.legs) parts.push(limb(l, skin));
  const top = (z: number) => {
    const sp = s.spine;
    let i = 0;
    while (i < sp.length - 2 && sp[i + 1]![0] < z) i++;
    const a = sp[i]!, b = sp[i + 1]!, f = THREE.MathUtils.clamp((z - a[0]) / (b[0] - a[0]), 0, 1);
    const y = a[1] + (b[1] - a[1]) * f, w = a[2] + (b[2] - a[2]) * f, h = a[3] + (b[3] - a[3]) * f;
    return { top: y + h, halfW: w, y };
  };
  s.extras?.(parts, skin, top);
  const g = merge(parts);
  // normalise: length 1 along z, centred on z = 0; feet on y = 0 (land) or centred (air, sea)
  const bb = g.boundingBox!;
  const k = 1 / (bb.max.z - bb.min.z), zc = (bb.max.z + bb.min.z) / 2;
  const y0 = s.realm === "land" ? bb.min.y : (bb.max.y + bb.min.y) / 2;
  g.translate(0, -y0, -zc);
  g.scale(k, k, k);
  const rig = g.getAttribute("aRig") as THREE.BufferAttribute;
  for (let i = 0; i < rig.count; i++) {
    const kind = rig.getX(i);
    if (kind === 1) rig.setXYZW(i, 1, (rig.getY(i) - y0) * k, (rig.getZ(i) - zc) * k, rig.getW(i));
    if (kind === 3) rig.setXYZW(i, 3, rig.getY(i), (rig.getZ(i) - y0) * k, (rig.getW(i) - zc) * k);
  }
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

const quad = (x: number, y: number, zf: number, zh: number, rf: number, rh: number, kneeF: number, kneeH: number, footF: number, footH: number, yF = y, sprawl = 0): Limb[] => [
  { x: -x, y: yF, z: zf, r: rf, knee: kneeF, foot: footF, phase: DIAG[0]!, sprawl }, { x, y: yF, z: zf, r: rf, knee: kneeF, foot: footF, phase: DIAG[1]!, sprawl },
  { x: -x, y, z: zh, r: rh, knee: kneeH, foot: footH, phase: DIAG[2]!, sprawl }, { x, y, z: zh, r: rh, knee: kneeH, foot: footH, phase: DIAG[3]!, sprawl },
];

/** A cone from (x, y, z) pointing along `dir`. */
function horn(parts: Part[], x: number, y: number, z: number, len: number, r: number, dir: [number, number, number], hex = "#d9d0bd", rig: [number, number, number, number] = [0, 0, 0, 0]): void {
  const c = new THREE.ConeGeometry(r, len, 6);
  c.translate(0, len / 2, 0);
  c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir).normalize()));
  c.translate(x, y, z);
  parts.push(finish(c, col(hex), rig));
}

function plate(parts: Part[], z: number, y: number, h: number, x: number, hex: string): void {
  const g = new THREE.BufferGeometry();
  const w = h * 0.55, t = 0.006;
  const v = [[0, 0, -w / 2], [0, h, -w * 0.05], [0, 0, w / 2]];
  const pos: number[] = [];
  for (const sx of [-t, t]) for (const p of v) pos.push(p[0]! + sx, p[1]!, p[2]!);
  const idx = [0, 1, 2, 5, 4, 3, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0];
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  parts.push(finish(at(g, x, y, z), col(hex), [0, 0, 0, 0]));
}

const SPECS: Partial<Record<AnimalPlan, Spec>> = {
  sauropod: {
    spine: [[-0.5, 0.62, 0.012, 0.011], [-0.48, 0.622, 0.022, 0.019], [-0.455, 0.615, 0.022, 0.021], [-0.42, 0.585, 0.022, 0.026], [-0.34, 0.5, 0.03, 0.035],
      [-0.26, 0.41, 0.042, 0.048], [-0.18, 0.34, 0.065, 0.07], [-0.08, 0.31, 0.095, 0.095], [0.02, 0.31, 0.1, 0.1], [0.09, 0.305, 0.09, 0.088],
      [0.17, 0.285, 0.05, 0.056], [0.27, 0.235, 0.03, 0.034], [0.37, 0.175, 0.016, 0.018], [0.46, 0.125, 0.007, 0.007], [0.52, 0.105, 0.002, 0.002]],
    shoulder: 6, hip: 9, back: "#8d8372", belly: "#bdb19b", realm: "land",
    legs: quad(0.065, 0.29, -0.12, 0.07, 0.045, 0.052, 0.0, 0.0, 0.03, 0.035, 0.27),
  },
  prosauropod: {
    spine: [[-0.5, 0.38, 0.011, 0.011], [-0.47, 0.382, 0.022, 0.02], [-0.43, 0.38, 0.025, 0.026], [-0.36, 0.36, 0.024, 0.03], [-0.28, 0.335, 0.035, 0.042],
      [-0.2, 0.315, 0.06, 0.07], [-0.08, 0.31, 0.08, 0.085], [0.04, 0.32, 0.078, 0.08], [0.14, 0.31, 0.04, 0.046], [0.28, 0.27, 0.022, 0.025], [0.42, 0.22, 0.008, 0.009], [0.5, 0.2, 0.002, 0.002]],
    shoulder: 5, hip: 7, back: "#8b7d63", belly: "#c2b393", realm: "land",
    legs: [
      { x: -0.05, y: 0.26, z: -0.17, r: 0.02, knee: 0.02, foot: 0.03, phase: 0 }, { x: 0.05, y: 0.26, z: -0.17, r: 0.02, knee: 0.02, foot: 0.03, phase: Math.PI },
      { x: -0.055, y: 0.31, z: 0.03, r: 0.035, knee: -0.04, ankle: 0.03, foot: 0.06, phase: Math.PI }, { x: 0.055, y: 0.31, z: 0.03, r: 0.035, knee: -0.04, ankle: 0.03, foot: 0.06, phase: 0 },
    ],
  },
  ornithopod: {
    spine: [[-0.5, 0.405, 0.026, 0.01], [-0.465, 0.41, 0.032, 0.022], [-0.42, 0.43, 0.036, 0.04], [-0.37, 0.415, 0.03, 0.035], [-0.3, 0.37, 0.04, 0.05],
      [-0.22, 0.34, 0.07, 0.08], [-0.1, 0.335, 0.09, 0.1], [0.02, 0.35, 0.088, 0.1], [0.12, 0.345, 0.05, 0.07], [0.25, 0.315, 0.03, 0.05], [0.38, 0.285, 0.014, 0.028], [0.5, 0.265, 0.003, 0.006]],
    shoulder: 5, hip: 7, back: "#7f7660", belly: "#c4b99d", realm: "land",
    legs: [
      { x: -0.06, y: 0.27, z: -0.2, r: 0.026, knee: 0.01, foot: 0.03, phase: 0 }, { x: 0.06, y: 0.27, z: -0.2, r: 0.026, knee: 0.01, foot: 0.03, phase: Math.PI },
      { x: -0.065, y: 0.34, z: 0.0, r: 0.05, knee: -0.05, ankle: 0.03, foot: 0.06, phase: Math.PI }, { x: 0.065, y: 0.34, z: 0.0, r: 0.05, knee: -0.05, ankle: 0.03, foot: 0.06, phase: 0 },
    ],
  },
  ceratopsian: {
    spine: [[-0.5, 0.155, 0.01, 0.012], [-0.46, 0.165, 0.035, 0.04], [-0.39, 0.195, 0.065, 0.07], [-0.31, 0.215, 0.075, 0.08], [-0.22, 0.235, 0.11, 0.11],
      [-0.08, 0.255, 0.14, 0.13], [0.06, 0.26, 0.13, 0.12], [0.16, 0.24, 0.05, 0.05], [0.3, 0.19, 0.025, 0.026], [0.44, 0.145, 0.006, 0.006]],
    shoulder: 4, hip: 6, back: "#7c6c55", belly: "#b8a88a", realm: "land",
    legs: quad(0.085, 0.2, -0.18, 0.05, 0.045, 0.055, 0.0, -0.01, 0.03, 0.035, 0.18),
    extras: (parts) => {
      const neck: [number, number, number, number] = [3, 0.9, 0.245, -0.22];
      const frill = at(new THREE.SphereGeometry(0.14, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.28, -0.29, -0.9, 0, 0, 1, 0.12, 0.9);
      parts.push(finish(frill, (p) => col("#9a7650").multiplyScalar(0.8 + 0.6 * (p.y - 0.2)), neck));
      for (const x of [-0.035, 0.035]) horn(parts, x, 0.255, -0.4, 0.12, 0.012, [x * 2, 0.45, -1], "#d9d0bd", neck);
      horn(parts, 0, 0.215, -0.465, 0.05, 0.01, [0, 0.8, -0.6], "#d9d0bd", neck);
    },
  },
  ankylosaur: {
    spine: [[-0.5, 0.12, 0.03, 0.025], [-0.44, 0.13, 0.06, 0.042], [-0.38, 0.14, 0.065, 0.045], [-0.32, 0.15, 0.085, 0.06], [-0.2, 0.17, 0.16, 0.08],
      [-0.02, 0.18, 0.17, 0.085], [0.12, 0.17, 0.13, 0.07], [0.22, 0.15, 0.04, 0.035], [0.34, 0.13, 0.02, 0.02], [0.45, 0.12, 0.015, 0.015]],
    shoulder: 3, hip: 6, back: "#6f6555", belly: "#a59a85", realm: "land",
    legs: quad(0.1, 0.13, -0.16, 0.08, 0.04, 0.045, 0.0, 0.0, 0.03, 0.035, 0.12),
    extras: (parts, _skin, top) => {
      parts.push(finish(at(blob(0.05, 77, 0.25), 0, 0.12, 0.47, 0, 0, 0, 1.5, 0.7, 1), col("#5e5446"), [2, 1, 0, 0]));
      for (let k = 0; k < 10; k++) {
        const z = -0.3 + k * 0.045, b = top(z);
        for (const x of [-0.45, 0.45]) horn(parts, x * b.halfW, b.top - 0.012, z, 0.028, 0.012, [x * 0.4, 1, 0], "#5a5042");
        for (const sd of [-1, 1]) horn(parts, sd * b.halfW * 0.95, b.y + 0.01, z, 0.045, 0.012, [sd, 0.35, 0.1], "#5a5042");
      }
    },
  },
  stegosaur: {
    spine: [[-0.5, 0.12, 0.01, 0.01], [-0.46, 0.13, 0.022, 0.022], [-0.41, 0.15, 0.025, 0.028], [-0.34, 0.19, 0.035, 0.04], [-0.24, 0.25, 0.07, 0.08],
      [-0.1, 0.31, 0.09, 0.11], [0.04, 0.34, 0.09, 0.11], [0.14, 0.31, 0.05, 0.06], [0.26, 0.25, 0.03, 0.035], [0.38, 0.2, 0.015, 0.018], [0.47, 0.18, 0.005, 0.006]],
    shoulder: 4, hip: 6, back: "#7d7158", belly: "#b9ab8b", realm: "land",
    legs: quad(0.07, 0.3, -0.2, 0.03, 0.035, 0.05, 0.0, 0.0, 0.025, 0.035, 0.2),
    extras: (parts, _skin, top) => {
      for (let k = 0; k < 11; k++) {
        const z = -0.3 + k * 0.06, h = 0.05 + 0.08 * Math.sin(Math.PI * (k + 0.5) / 11);
        plate(parts, z, top(z).top - 0.015, h, k % 2 ? 0.012 : -0.012, "#a86b48");
        setRig(parts[parts.length - 1]!, z > 0.12 ? [2, (z - 0.12) / 0.35, 0, 0] : [0, 0, 0, 0]);
      }
      for (const [sd, back] of [[-1, 0.4], [1, 0.4], [-1, 0.44], [1, 0.44]] as [number, number][]) {
        const b = top(back);
        horn(parts, sd * 0.01, b.top - 0.005, back, 0.07, 0.008, [sd, 0.6, 0.5], "#d9d0bd", [2, 0.85, 0, 0]);
      }
    },
  },
  large_theropod: {
    spine: [[-0.5, 0.475, 0.016, 0.02], [-0.44, 0.475, 0.04, 0.045], [-0.37, 0.475, 0.056, 0.066], [-0.31, 0.445, 0.045, 0.055], [-0.25, 0.425, 0.056, 0.066],
      [-0.14, 0.42, 0.08, 0.1], [-0.02, 0.43, 0.08, 0.09], [0.1, 0.42, 0.05, 0.06], [0.24, 0.4, 0.03, 0.035], [0.38, 0.38, 0.014, 0.016], [0.5, 0.37, 0.003, 0.004]],
    shoulder: 4, hip: 6, back: "#6e6250", belly: "#b6a78a", realm: "land",
    legs: [
      { x: -0.055, y: 0.42, z: -0.03, r: 0.045, knee: -0.06, ankle: 0.04, foot: 0.07, phase: 0 },
      { x: 0.055, y: 0.42, z: -0.03, r: 0.045, knee: -0.06, ankle: 0.04, foot: 0.07, phase: Math.PI },
    ],
    extras: (parts, skin) => {
      for (const x of [-0.05, 0.05]) {
        const arm = hull([{ x, y: 0.38, z: -0.17, w: 0.01, h: 0.012 }, { x: x * 1.1, y: 0.35, z: -0.19, w: 0.008, h: 0.008 }, { x: x * 1.1, y: 0.34, z: -0.215, w: 0.004, h: 0.004 }], { sides: 5, perSpan: 2 });
        parts.push(finish(arm, skin));
      }
      // jaw line
      parts.push(finish(at(new THREE.BoxGeometry(0.06, 0.004, 0.1), 0, 0.455, -0.45), col("#4a3f33"), [3, 1, 0.425, -0.25]));
    },
  },
  small_theropod: {
    spine: [[-0.5, 0.36, 0.008, 0.008], [-0.46, 0.365, 0.018, 0.02], [-0.42, 0.37, 0.022, 0.026], [-0.36, 0.35, 0.016, 0.018], [-0.29, 0.31, 0.022, 0.026],
      [-0.2, 0.29, 0.045, 0.055], [-0.08, 0.29, 0.05, 0.055], [0.04, 0.29, 0.03, 0.035], [0.2, 0.28, 0.016, 0.018], [0.36, 0.27, 0.008, 0.009], [0.5, 0.265, 0.002, 0.003]],
    shoulder: 5, hip: 6, back: "#7a6244", belly: "#c8b48e", realm: "land",
    legs: [
      { x: -0.03, y: 0.29, z: -0.06, r: 0.024, knee: -0.05, ankle: 0.04, foot: 0.05, phase: 0 },
      { x: 0.03, y: 0.29, z: -0.06, r: 0.024, knee: -0.05, ankle: 0.04, foot: 0.05, phase: Math.PI },
    ],
    extras: (parts, skin) => {
      for (const x of [-0.035, 0.035]) {
        const arm = hull([{ x, y: 0.27, z: -0.21, w: 0.008, h: 0.009 }, { x: x * 1.2, y: 0.23, z: -0.24, w: 0.006, h: 0.006 }, { x: x * 1.2, y: 0.22, z: -0.29, w: 0.003, h: 0.003 }], { sides: 5, perSpan: 2 });
        parts.push(finish(arm, skin));
      }
    },
  },
  pterosaur: {
    spine: [[-0.5, 0, 0.004, 0.005], [-0.38, 0.003, 0.011, 0.014], [-0.3, 0.008, 0.018, 0.024], [-0.23, 0.0, 0.014, 0.015], [-0.14, 0.0, 0.03, 0.03],
      [0.0, 0.0, 0.034, 0.03], [0.12, 0.0, 0.02, 0.02], [0.18, 0.0, 0.006, 0.006]],
    shoulder: 4, hip: 6, back: "#7f6a53", belly: "#cdbfa5", realm: "air",
    legs: [],
    extras: (parts) => {
      // wing membranes (double-sided) with a slight upward dihedral
      const S = [0.03, -0.13], E = [0.28, -0.15], W = [0.5, -0.1], T = [1.05, 0.04], M = [0.48, 0.1], H = [0.04, 0.1];
      const pos: number[] = [];
      for (const sx of [-1, 1]) {
        const v = (p: number[]) => [sx * p[0]!, 0.03 * p[0]!, p[1]!];
        for (const tri of [[H, S, E], [H, E, W], [H, W, M], [M, W, T]]) {
          const pts = (sx > 0 ? tri : [tri[0]!, tri[2]!, tri[1]!]).map(v);
          for (const p of pts) pos.push(...p);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      parts.push(finish(g, (p) => col("#a48d70").multiplyScalar(0.75 + 0.25 * (1 - Math.abs(p.x))), (p) => [4, Math.abs(p.x), 0, 0]));
      const crest = new THREE.ConeGeometry(0.03, 0.16, 4);
      crest.translate(0, 0.08, 0);
      parts.push(finish(at(crest, 0, 0.015, -0.29, 1.35, 0, 0, 0.25, 1, 1), col("#b25a3a")));
      for (const x of [-0.02, 0.02]) parts.push(finish(hull([{ x, y: -0.01, z: 0.08, w: 0.006, h: 0.006 }, { x: x * 1.4, y: -0.02, z: 0.2, w: 0.004, h: 0.004 }], { sides: 5 }), col("#7f6a53")));
    },
  },
  crocodylomorph: {
    spine: [[-0.5, 0.05, 0.012, 0.009], [-0.38, 0.055, 0.03, 0.018], [-0.3, 0.062, 0.045, 0.03], [-0.24, 0.066, 0.05, 0.034], [-0.14, 0.07, 0.07, 0.04],
      [0.0, 0.07, 0.075, 0.04], [0.1, 0.066, 0.05, 0.036], [0.24, 0.052, 0.03, 0.034], [0.38, 0.043, 0.016, 0.026], [0.5, 0.038, 0.003, 0.01]],
    shoulder: 4, hip: 6, back: "#525a45", belly: "#a7a48a", realm: "land",
    legs: quad(0.055, 0.06, -0.13, 0.08, 0.015, 0.018, 0.0, 0.0, 0.025, 0.03, 0.06, 0.05),
    extras: (parts) => {
      for (let k = 0; k < 14; k++) {
        const z = -0.2 + k * 0.035;
        for (const x of [-0.018, 0.018]) {
          parts.push(finish(at(new THREE.BoxGeometry(0.012, 0.012, 0.022), x, 0.1 - Math.max(0, z) * 0.12, z), col("#3f4636"), z > 0.1 ? [2, (z - 0.1) / 0.4, 0, 0] : [0, 0, 0, 0]));
        }
      }
    },
  },
  marine_reptile: {
    spine: [[-0.5, 0, 0.008, 0.01], [-0.42, 0, 0.022, 0.028], [-0.32, 0.005, 0.045, 0.055], [-0.12, 0.01, 0.08, 0.09], [0.08, 0.005, 0.07, 0.075],
      [0.24, 0, 0.035, 0.045], [0.38, 0, 0.014, 0.026], [0.46, 0, 0.006, 0.012]],
    shoulder: 2, hip: 4, back: "#4d5c63", belly: "#c3c8c2", realm: "sea",
    legs: [],
    extras: (parts) => {
      const fluke = at(blob(0.06, 13, 0.1), 0, 0.01, 0.48, 0, 0, 0, 0.12, 1.3, 0.55);
      parts.push(finish(fluke, col("#465359"), [2, 1, 0, 0]));
      for (const [x, z, ph] of [[-1, -0.15, 0], [1, -0.15, Math.PI], [-1, 0.13, Math.PI], [1, 0.13, 0]] as [number, number, number][]) {
        const fl = at(blob(0.08, 17, 0.08), x * 0.12, -0.03, z, 0, x * 0.5, x * 0.25, 1, 0.12, 0.35);
        parts.push(finish(fl, col("#455258"), (p) => [5, Math.min(1, Math.abs(p.x) / 0.18), ph, 0]));
      }
    },
  },
  turtle: {
    spine: [[-0.5, 0.075, 0.012, 0.012], [-0.45, 0.08, 0.035, 0.03], [-0.38, 0.075, 0.03, 0.025], [-0.3, 0.07, 0.04, 0.03], [0.0, 0.08, 0.06, 0.04], [0.3, 0.06, 0.03, 0.02], [0.38, 0.05, 0.005, 0.006]],
    shoulder: 3, hip: 5, back: "#5c5a40", belly: "#b8ad84", realm: "land",
    legs: quad(0.17, 0.06, -0.18, 0.17, 0.028, 0.028, 0.0, 0.0, 0.04, 0.035, 0.06, 0.04),
    extras: (parts) => {
      const shell = at(new THREE.SphereGeometry(0.34, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.045, 0.0, 0, 0, 0, 0.82, 0.42, 1);
      const pos = shell.getAttribute("position");
      for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), y = pos.getY(i); pos.setY(i, y * (1 + 0.15 * (1 - Math.min(1, Math.abs(x) / 0.12)))); }
      shell.computeVertexNormals();
      parts.push(finish(shell, (p) => col("#5a5136").multiplyScalar(0.75 + 0.6 * p.y)));
      parts.push(finish(at(new THREE.CylinderGeometry(0.33, 0.33, 0.02, 12), 0, 0.045, 0, 0, 0, 0, 0.82, 1, 1), col("#b5a87d")));
    },
  },
  small_tetrapod: {
    spine: [[-0.5, 0.3, 0.014, 0.014], [-0.44, 0.31, 0.045, 0.045], [-0.37, 0.305, 0.05, 0.05], [-0.29, 0.285, 0.07, 0.075], [-0.12, 0.28, 0.09, 0.09],
      [0.05, 0.28, 0.09, 0.09], [0.13, 0.27, 0.04, 0.04], [0.28, 0.22, 0.02, 0.02], [0.44, 0.18, 0.012, 0.012], [0.52, 0.17, 0.003, 0.003]],
    shoulder: 3, hip: 5, back: "#6f5d48", belly: "#b8a284", realm: "land",
    legs: quad(0.055, 0.25, -0.25, 0.05, 0.028, 0.034, 0.0, -0.02, 0.04, 0.05, 0.25),
    extras: (parts) => {
      for (const x of [-0.025, 0.025]) {
        const ear = new THREE.ConeGeometry(0.018, 0.05, 5);
        ear.translate(0, 0.025, 0);
        parts.push(finish(at(ear, x, 0.345, -0.4, -0.3, 0, x * 8), col("#5b4b39"), [3, 1, 0.285, -0.29]));
      }
    },
  },
};

function setRig(p: Part, r: [number, number, number, number]): void {
  const a = p.getAttribute("aRig") as THREE.BufferAttribute;
  for (let i = 0; i < a.count; i++) a.setXYZW(i, r[0], r[1], r[2], r[3]);
}

/** Unit-length animal, forward = −z, feet at y = 0 (fliers and swimmers centred on y = 0). */
export function animalGeometry(plan: AnimalPlan): THREE.BufferGeometry {
  return buildAnimal(SPECS[plan] ?? SPECS.small_tetrapod!);
}

/**
 * Generated tint around white (so baked colours dominate), from a seed. Hues stay in a muted,
 * natural range: `hue` is [min, max] as fractions of the colour wheel.
 */
export function tintFromSeed(seed: number, strength: number, out: THREE.Color, hue: [number, number] = [0.02, 0.16]): THREE.Color {
  const h = hue[0] + (((seed >>> 0) % 1000) / 1000) * (hue[1] - hue[0]);
  const s = (((seed >>> 9) % 100) / 100) * strength, l = 0.85 + (((seed >>> 17) % 100) / 100) * 0.3;
  return out.setHSL(h, s, Math.min(1, l));
}

/** Seed-derived pattern value per animal instance, decoded by the shader: integer part picks the pattern. */
export function patternSeed(seed: number): number {
  return ((seed >>> 5) % 3) + ((seed >>> 11) % 997) / 1000;
}
