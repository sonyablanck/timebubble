// Geometry for walk mode: near tiles (with skirts), the far ring, and the sea. Everything is built
// from lat/lon + height and projected through a LocalFrame, so rebasing = calling reproject().

import * as THREE from "three";
import { F, levelOf } from "../provenance/flags";
import { hash32 } from "../terrain/noise";
import { vertexLat, vertexLon, type FarField, type TileData } from "../terrain/tile";
import { DLAT, EARTH_RADIUS_M, TILE_SEGMENTS, wrapLon } from "../terrain/tilegrid";
import { groundColour } from "./materials";
import { LocalFrame } from "./projection";

const DEG = Math.PI / 180;

// ------------------------------------------------------------------ height lookup

/**
 * Height of the rendered surface at (lat, lon) within a tile, interpolated on the same two triangles
 * per quad that the mesh draws (diagonal from the north-east to the south-west corner), so the
 * walker stands exactly on what is drawn. Null if the point is outside the tile.
 */
export function tileHeightAt(t: TileData, lat: number, lon: number, heights: Float32Array = t.heights): number | null {
  const b = t.bounds, seg = TILE_SEGMENTS / t.step;
  const fi = ((vertexLat(b, 0) - lat) / DLAT) * seg;
  const fj = (wrapLon(lon - b.lonWest) / b.dlon) * seg;   // wrapLon handles tiles at the antimeridian
  const eps = 1e-6;   // shared edges: rounding must not drop a point into neither tile
  if (!(fi >= -eps && fi <= seg + eps && fj >= -eps && fj <= seg + eps)) return null;
  const ci = Math.min(seg, Math.max(0, fi)), cj = Math.min(seg, Math.max(0, fj));
  const i = Math.min(seg - 1, Math.floor(ci)), j = Math.min(seg - 1, Math.floor(cj));
  const y = ci - i, x = cj - j, n = t.n, H = heights;
  const a = H[i * n + j]!, bb = H[i * n + j + 1]!, c = H[(i + 1) * n + j]!, d = H[(i + 1) * n + j + 1]!;
  return x + y <= 1 ? a + (bb - a) * x + (c - a) * y : d + (c - d) * (1 - x) + (bb - d) * (1 - y);
}

/** Bilinear height in a far field (Hsmooth), or null outside it. */
export function farHeightAt(f: FarField, lat: number, lon: number): number | null {
  const yN = (lat - f.lat0) * DEG * EARTH_RADIUS_M;
  const xE = wrapLon(lon - f.lon0) * DEG * EARTH_RADIUS_M * Math.max(Math.cos(lat * DEG), 1e-3);
  const fi = ((f.halfSizeM - yN) / (2 * f.halfSizeM)) * (f.n - 1);
  const fj = ((xE + f.halfSizeM) / (2 * f.halfSizeM)) * (f.n - 1);
  if (!(fi >= 0 && fi <= f.n - 1 && fj >= 0 && fj <= f.n - 1)) return null;
  const i = Math.min(f.n - 2, Math.floor(fi)), j = Math.min(f.n - 2, Math.floor(fj));
  const y = fi - i, x = fj - j, n = f.n, H = f.heights;
  return (H[i * n + j]! * (1 - x) + H[i * n + j + 1]! * x) * (1 - y) + (H[(i + 1) * n + j]! * (1 - x) + H[(i + 1) * n + j + 1]! * x) * y;
}

// ------------------------------------------------------------------ near tiles

export interface TileMesh {
  data: TileData;
  mesh: THREE.Mesh;
  /** Heights as drawn (H, blended toward Hsmooth near the edge of the loaded ring). */
  drawn: Float32Array;
  /** Re-project into a frame; morph(lat, lon) in 0..1 blends H toward Hsmooth (1 = smooth). */
  reproject(frame: LocalFrame, morph?: (lat: number, lon: number) => number): void;
  dispose(): void;
}

/** Far-ring heights sit this far below Hsmooth so tile skirts, not gaps, meet them (render §5). */
export const FAR_DROP_M = 6;

export function provLevel(flags: number, strength255: number): number {
  return levelOf("terrain", flags, strength255 / 255);
}

export function buildTileMesh(t: TileData, frame: LocalFrame, material: THREE.Material): TileMesh {
  const n = t.n, seg = n - 1, nv = n * n, perim = 4 * seg;
  const total = nv + perim;
  const lat = new Float64Array(total), lon = new Float64Array(total), h = new Float32Array(total);
  const skirt = 10 + 10 * t.step;

  for (let i = 0; i < n; i++) {
    const la = vertexLat(t.bounds, i * t.step);
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      lat[k] = la;
      lon[k] = vertexLon(t.bounds, j * t.step);
      h[k] = t.heights[k]!;
    }
  }
  // perimeter, walked clockwise from the north-west corner; skirt vertices hang below it
  const ring: number[] = [];
  for (let j = 0; j < seg; j++) ring.push(j);                         // north edge
  for (let i = 0; i < seg; i++) ring.push(i * n + seg);               // east edge
  for (let j = seg; j > 0; j--) ring.push(seg * n + j);               // south edge
  for (let i = seg; i > 0; i--) ring.push(i * n);                     // west edge
  ring.forEach((src, r) => { lat[nv + r] = lat[src]!; lon[nv + r] = lon[src]!; h[nv + r] = h[src]! - skirt; });

  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3), prov = new Float32Array(total);
  const drawn = new Float32Array(nv);
  const jit = new Float32Array(nv);
  for (let k = 0; k < nv; k++) {
    const e = t.normals[k * 3]! / 127, u = t.normals[k * 3 + 1]! / 127, no = t.normals[k * 3 + 2]! / 127;
    nor[k * 3] = e; nor[k * 3 + 1] = u; nor[k * 3 + 2] = -no;
    jit[k] = ((hash32(Math.round(lat[k]! * 2e4), Math.round(lon[k]! * 2e4)) & 1023) / 1023) * 2 - 1;
  }
  ring.forEach((src, r) => {
    const k = nv + r;
    for (let c = 0; c < 3; c++) nor[k * 3 + c] = nor[src * 3 + c]!;
  });
  /** Heights, colours and provenance for a morph field (0 = full detail everywhere). */
  const shade = (morph?: (lat: number, lon: number) => number) => {
    for (let k = 0; k < nv; k++) {
      const w = morph ? morph(lat[k]!, lon[k]!) : 0;
      drawn[k] = w > 0 ? t.heights[k]! + (t.smooth[k]! - t.heights[k]!) * w : t.heights[k]!;
      h[k] = drawn[k]!;
      groundColour(drawn[k]!, nor[k * 3 + 1]!, jit[k]!, col, k * 3, t.biome?.colour, k * 3);
      // blending toward the data surface removes invented relief, so the level falls with it
      prov[k] = provLevel(w >= 0.5 ? t.flags[k]! & ~F.GENERATED_COAST : t.flags[k]!, t.strength[k]! * (1 - w));
    }
    ring.forEach((src, r) => {
      const k = nv + r;
      h[k] = drawn[src]! - skirt;
      for (let c = 0; c < 3; c++) col[k * 3 + c] = col[src * 3 + c]! * 0.8;
      prov[k] = prov[src]!;
    });
  };

  const idx = total > 65535 ? new Uint32Array((seg * seg + perim) * 6) : new Uint16Array((seg * seg + perim) * 6);
  let q = 0;
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * n + j, b = a + 1, c = a + n, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;   // diagonal b–c, matching tileHeightAt
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  }
  for (let r = 0; r < perim; r++) {
    const top0 = ring[r]!, top1 = ring[(r + 1) % perim]!, bot0 = nv + r, bot1 = nv + ((r + 1) % perim);
    idx[q++] = top0; idx[q++] = top1; idx[q++] = bot0;
    idx[q++] = top1; idx[q++] = bot1; idx[q++] = bot0;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aProv", new THREE.BufferAttribute(prov, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(g, material);
  mesh.matrixAutoUpdate = false;
  mesh.name = `tile ${t.id.row},${t.id.col} step ${t.step}`;

  const reproject = (frame: LocalFrame, morph?: (lat: number, lon: number) => number) => {
    shade(morph);
    for (let k = 0; k < total; k++) frame.project(lat[k]!, lon[k]!, h[k]!, pos, k * 3);
    for (const a of ["position", "color", "aProv"]) g.getAttribute(a).needsUpdate = true;
    g.computeBoundingSphere();
    g.computeBoundingBox();
  };
  reproject(frame);
  return { data: t, mesh, drawn, reproject, dispose: () => g.dispose() };
}

// ------------------------------------------------------------------ far ring

export interface FarMesh {
  data: FarField;
  mesh: THREE.Mesh;
  reproject(frame: LocalFrame): void;
  dispose(): void;
}

export function buildFarMesh(f: FarField, frame: LocalFrame, material: THREE.Material): FarMesh {
  const n = f.n, nv = n * n;
  const lat = new Float64Array(nv), lon = new Float64Array(nv);
  for (let i = 0; i < n; i++) {
    const y = f.halfSizeM - (2 * f.halfSizeM * i) / (n - 1);
    const la = f.lat0 + (y / EARTH_RADIUS_M) / DEG;
    const c = Math.max(Math.cos(la * DEG), 1e-3);
    for (let j = 0; j < n; j++) {
      const x = -f.halfSizeM + (2 * f.halfSizeM * j) / (n - 1);
      lat[i * n + j] = la;
      lon[i * n + j] = wrapLon(f.lon0 + (x / (EARTH_RADIUS_M * c)) / DEG);
    }
  }
  const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), ll = new Float32Array(nv * 2);
  const prov = new Float32Array(nv);   // the far ring is detail-free: DATA_SURFACE only, level 0
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
    const a = i * n + j, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aProv", new THREE.BufferAttribute(prov, 1));
  g.setAttribute("aLL", new THREE.BufferAttribute(ll, 2));
  g.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(g, material);
  mesh.matrixAutoUpdate = false;
  mesh.name = "far ring";

  const reproject = (frame: LocalFrame) => {
    for (let k = 0; k < nv; k++) {
      frame.project(lat[k]!, lon[k]!, f.heights[k]! - FAR_DROP_M, pos, k * 3);
      ll[k * 2] = lat[k]! - frame.lat0;
      ll[k * 2 + 1] = wrapLon(lon[k]! - frame.lon0);
    }
    g.getAttribute("position").needsUpdate = true;
    g.getAttribute("aLL").needsUpdate = true;
    g.computeVertexNormals();
    const nor = g.getAttribute("normal") as THREE.BufferAttribute;
    for (let k = 0; k < nv; k++) {
      const jitter = ((hash32(Math.round(lat[k]! * 2e4), Math.round(lon[k]! * 2e4)) & 1023) / 1023) * 2 - 1;
      groundColour(f.heights[k]!, nor.getY(k), jitter, col, k * 3, f.colour, k * 3);
    }
    g.getAttribute("color").needsUpdate = true;
    g.computeBoundingSphere();
  };
  reproject(frame);
  return { data: f, mesh, reproject, dispose: () => g.dispose() };
}

/** Sea surface at 0 m: a polar grid around the origin, curved with the Earth (render §4). */
export function buildSea(radiusM: number, material: THREE.Material): THREE.Mesh {
  const radii: number[] = [0];
  for (let r = 20; r < radiusM; r *= 1.12) radii.push(r);
  radii.push(radiusM);
  const segs = 128;
  const pos: number[] = [], idx: number[] = [];
  pos.push(0, 0, 0);
  for (let ri = 1; ri < radii.length; ri++) {
    const r = radii[ri]!;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const x = r * Math.cos(a), z = r * Math.sin(a);
      pos.push(x, -LocalFrame.drop(x, z), z);
    }
  }
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let ri = 1; ri < radii.length - 1; ri++) {
    const o0 = 1 + (ri - 1) * segs, o1 = 1 + ri * segs;
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      idx.push(o0 + s, o0 + s1, o1 + s, o0 + s1, o1 + s1, o1 + s);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.name = "sea";
  m.renderOrder = 1;
  return m;
}

