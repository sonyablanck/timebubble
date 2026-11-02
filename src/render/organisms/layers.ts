// Plants and animals in walk mode (render §7–§8). Instances come from ecology/ (world-anchored lat/lon
// positions); this layer projects them into the current local frame, sits them on the drawn
// terrain, and draws them as instanced meshes. Plants come in three distance tiers per (plan,
// variant): full models that cast shadows near the player, full models without shadows further
// out, and camera-facing cut-outs (impostors) baked from the same models out to the draw distance.
// Animals step through their behaviour every frame; their gait, grazing and pattern are passed to
// the shader per instance.

import * as THREE from "three";
import { PLANT_NAMES, PLANT_PLANS, type PlantPlan } from "../../biome/plants";
import { makeAgent, separate, step, type Agent } from "../../ecology/behaviour";
import { PLAN_INFO, type AnimalPlan, type TaxonEntry } from "../../ecology/roster";
import { F, levelOf } from "../../provenance/flags";
import type { TileData } from "../../terrain/tile";
import { tileKey } from "../../terrain/tilegrid";
import { makeImpostorMaterial, makeOrganismDepthMaterial, makeOrganismMaterial, type OverlayUniforms } from "../materials";
import { LocalFrame } from "../projection";
import { PLANT_VARIANTS, animalGeometry, patternSeed, plantGeometry, plantVariant, tintFromSeed } from "./models";

export type HeightAt = (lat: number, lon: number) => number | null;
type PlantKind = PlantPlan | "snag";
const KINDS: PlantKind[] = [...PLANT_PLANS, "snag"];

/** Draw distances (m): trees to the edge of the 3 × 3 ring, understorey closer. */
export const PLANT_DRAW_M: Record<PlantKind, number> = {
  conifer: 1800, ginkgo: 1800, early_angiosperm: 1400, seed_fern: 1000, cycad_bennettitalean: 600, fern: 450, horsetail: 450, snag: 1800,
};
/** Beyond this distance a plant is drawn as a cut-out (impostor) instead of the full model. */
export const PLANT_NEAR_M: Record<PlantKind, number> = {
  conifer: 240, ginkgo: 220, early_angiosperm: 200, seed_fern: 180, cycad_bennettitalean: 160, fern: 130, horsetail: 120, snag: 240,
};
/** Plants this close cast shadows (matches the sun's shadow box, see walk.ts). */
export const PLANT_SHADOW_M = 110;
export const REBUILD_AFTER_M = 120;

export type OrganismUniforms = OverlayUniforms & { u_time: { value: number }; u_motion: { value: number } };

export interface PlantPick { kind: "plant"; plan: PlantKind; alive: boolean; tile: TileData; lat: number; lon: number; distance: number }
export interface AnimalPick { kind: "animal"; agent: LiveAnimal; distance: number }

type Tier = "cast" | "near" | "far";
interface Batch {
  mesh: THREE.InstancedMesh; level: THREE.InstancedBufferAttribute; flags: THREE.InstancedBufferAttribute; capacity: number;
  refs: { tile: TileData; k: number }[]; plan: PlantKind | AnimalPlan; anim?: THREE.InstancedBufferAttribute;
}

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpC = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/** A geometry sharing another's vertex buffers, so each batch can carry its own instanced attributes. */
function view(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(g.attributes)) c.setAttribute(k, a);
  c.boundingBox = g.boundingBox; c.boundingSphere = g.boundingSphere;
  return c;
}

function makeBatch(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number, name: string, plan: Batch["plan"], anim = false): Batch {
  const cap = Math.max(1, capacity);
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.name = name;
  mesh.count = 0;
  mesh.frustumCulled = false;   // instances span the whole ring; the per-instance distance cut does the culling
  const level = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  geo.setAttribute("aLevel", level);
  const flags = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);   // provenance bits (focus mode)
  geo.setAttribute("aFlags", flags);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  const b: Batch = { mesh, level, flags, capacity: cap, refs: [], plan };
  if (anim) { b.anim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); geo.setAttribute("aAnim", b.anim); }
  return b;
}

// ------------------------------------------------------------------ impostor atlas

const CELL = 256, ATLAS_COLS = 8;

interface ImpostorCell { geo: THREE.BufferGeometry }

/**
 * Bake one side view of every plant variant into an atlas with the near models' own material and a
 * fixed midday light, and build a quad per variant mapped to its cell. Quads stand on y = 0, 1 unit
 * tall (plants are normalised to 1 unit), as wide as the model.
 */
function bakeImpostors(renderer: THREE.WebGLRenderer, material: THREE.Material, deadMaterial: THREE.Material,
  geos: (k: PlantKind, v: number) => THREE.BufferGeometry): { texture: THREE.Texture; cells: Map<string, ImpostorCell>; target: THREE.WebGLRenderTarget } {
  const list: [PlantKind, number][] = [];
  for (const k of KINDS) for (let v = 0; v < PLANT_VARIANTS[k]; v++) list.push([k, v]);
  const rows = Math.ceil(list.length / ATLAS_COLS);
  const target = new THREE.WebGLRenderTarget(CELL * ATLAS_COLS, CELL * rows, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xc4d6ff, 0x6f6a55, 3.2));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
  sun.position.set(0.4, 1, 1);
  scene.add(sun);
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 1, 0, -10, 10);
  cam.position.set(0, 0, 5);
  const prev = { target: renderer.getRenderTarget(), clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), auto: renderer.autoClear };
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.autoClear = false;
  const cells = new Map<string, ImpostorCell>();
  list.forEach(([k, v], i) => {
    const g = geos(k, v), bb = g.boundingBox!;
    const half = Math.max(0.5, Math.abs(bb.min.x), Math.abs(bb.max.x), Math.abs(bb.min.z), Math.abs(bb.max.z)) * 1.02;
    const size = Math.max(1.02, half * 2);   // square cell in world units
    const col = i % ATLAS_COLS, row = Math.floor(i / ATLAS_COLS);
    const mesh = new THREE.Mesh(g, k === "snag" ? deadMaterial : material);
    scene.add(mesh);
    cam.left = -size / 2; cam.right = size / 2; cam.bottom = -0.01; cam.top = size - 0.01;
    cam.updateProjectionMatrix();
    renderer.setViewport(col * CELL, row * CELL, CELL, CELL);
    renderer.setScissor(col * CELL, row * CELL, CELL, CELL);
    renderer.setScissorTest(true);
    renderer.render(scene, cam);
    scene.remove(mesh);
    // the quad: same world extent as the camera window; uv to the cell
    const quad = new THREE.PlaneGeometry(size, size);
    quad.translate(0, size / 2 - 0.01, 0);
    const uv = quad.getAttribute("uv");
    for (let j = 0; j < uv.count; j++) uv.setXY(j, (col + uv.getX(j)) / ATLAS_COLS, (row + uv.getY(j)) / rows);
    quad.deleteAttribute("normal");
    cells.set(`${k}|${v}`, { geo: quad });
  });
  renderer.setScissorTest(false);
  renderer.setRenderTarget(prev.target);
  renderer.setClearColor(prev.clear, prev.alpha);
  renderer.autoClear = prev.auto;
  const size = new THREE.Vector2();
  renderer.getSize(size);
  renderer.setViewport(0, 0, size.x, size.y);
  return { texture: target.texture, cells, target };
}

// ------------------------------------------------------------------ flora

export class FloraLayer {
  readonly group = new THREE.Group();
  private readonly batches = new Map<string, Batch>();
  private readonly geos = new Map<string, THREE.BufferGeometry>();
  private readonly living: THREE.MeshStandardMaterial;
  private readonly dead: THREE.MeshStandardMaterial;
  private readonly depthLiving: THREE.MeshDepthMaterial;
  private readonly depthDead: THREE.MeshDepthMaterial;
  private impostor: { material: THREE.MeshBasicMaterial; cells: Map<string, ImpostorCell>; target: THREE.WebGLRenderTarget } | null = null;
  readonly impostorUniforms: OverlayUniforms & { u_bright: { value: number } };
  private lastX = Infinity;
  private lastZ = Infinity;
  instances = 0;
  /** Settings "detail": scales the plant draw and near distances (1 = full). */
  distanceScale = 1;
  readonly tierCounts: Record<Tier, number> = { cast: 0, near: 0, far: 0 };

  constructor(uniforms: OrganismUniforms) {
    this.living = makeOrganismMaterial(uniforms, { kind: "plant" });
    this.dead = makeOrganismMaterial(uniforms, { kind: "still" });
    this.depthLiving = makeOrganismDepthMaterial(uniforms, "plant");
    this.depthDead = makeOrganismDepthMaterial(uniforms, "still");
    this.impostorUniforms = { u_overlay: uniforms.u_overlay, u_focus: uniforms.u_focus, u_sites: uniforms.u_sites, u_nsites: uniforms.u_nsites, u_bright: { value: 1 } };
    this.group.name = "flora";
  }

  /** Bake the distant-plant cut-outs (needs the renderer; without it, distant plants use full models). */
  init(renderer: THREE.WebGLRenderer): void {
    if (this.impostor) return;
    const baked = bakeImpostors(renderer, this.living, this.dead, (k, v) => this.geo(k, v));
    this.impostor = { material: makeImpostorMaterial(baked.texture, this.impostorUniforms), cells: baked.cells, target: baked.target };
  }

  private geo(k: PlantKind, v: number): THREE.BufferGeometry {
    const key = `${k}|${v}`;
    let g = this.geos.get(key);
    if (!g) this.geos.set(key, (g = plantGeometry(k, v)));
    return g;
  }

  needsRebuild(px: number, pz: number): boolean {
    return Math.hypot(px - this.lastX, pz - this.lastZ) > REBUILD_AFTER_M;
  }

  rebuild(tiles: Iterable<TileData>, frame: LocalFrame, px: number, pz: number, heightAt: HeightAt): void {
    this.lastX = px;
    this.lastZ = pz;
    const chosen = new Map<string, { tile: TileData; k: number; x: number; z: number }[]>();
    for (const t of tiles) {
      const p = t.ecology?.plants;
      if (!p) continue;
      for (let k = 0; k < p.count; k++) {
        const plan: PlantKind = p.alive[k] ? PLANT_PLANS[p.plan[k]!]! : "snag";
        const [e, n] = frame.en(p.lat[k]!, p.lon[k]!);
        const x = e, z = -n;
        const d = Math.hypot(x - px, z - pz);
        if (d > PLANT_DRAW_M[plan] * this.distanceScale) continue;
        const tier: Tier = d < PLANT_SHADOW_M ? "cast" : d < PLANT_NEAR_M[plan] * this.distanceScale || !this.impostor ? "near" : "far";
        const key = `${plan}|${plantVariant(plan, p.colourSeed[k]!)}|${tier}`;
        let list = chosen.get(key);
        if (!list) chosen.set(key, (list = []));
        list.push({ tile: t, k, x, z });
      }
    }
    this.instances = 0;
    this.tierCounts.cast = this.tierCounts.near = this.tierCounts.far = 0;
    const keys = new Set([...chosen.keys(), ...this.batches.keys()]);
    for (const key of keys) {
      const [plan, vs, tier] = key.split("|") as [PlantKind, string, Tier];
      const v = Number(vs);
      const list = chosen.get(key) ?? [];
      let b = this.batches.get(key);
      if (!b || b.capacity < list.length) {
        if (!list.length) { if (b) b.mesh.count = 0; continue; }
        if (b) { this.group.remove(b.mesh); b.mesh.dispose(); }
        const far = tier === "far";
        const geo = view(far ? this.impostor!.cells.get(`${plan}|${v}`)!.geo : this.geo(plan, v));
        const mat = far ? this.impostor!.material : plan === "snag" ? this.dead : this.living;
        b = makeBatch(geo, mat, Math.ceil(list.length * 1.3) + 8, `plants ${key}`, plan);
        b.mesh.castShadow = tier === "cast";
        b.mesh.receiveShadow = !far;
        if (!far) b.mesh.customDepthMaterial = plan === "snag" ? this.depthDead : this.depthLiving;
        this.batches.set(key, b);
        this.group.add(b.mesh);
      }
      b.refs = [];
      let i = 0;
      for (const it of list) {
        const p = it.tile.ecology!.plants;
        const h = heightAt(p.lat[it.k]!, p.lon[it.k]!);
        if (h === null || h < 0) continue;
        const s = p.scale[it.k]!;
        tmpP.set(it.x, h - LocalFrame.drop(it.x, it.z) - 0.03 * s, it.z);
        tmpQ.setFromAxisAngle(UP, p.rotation[it.k]!);
        tmpS.set(s, s, s);
        b.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
        b.mesh.setColorAt(i, plan === "snag" ? tintFromSeed(p.colourSeed[it.k]!, 0.05, tmpC) : tintFromSeed(p.colourSeed[it.k]!, 0.22, tmpC, [0.12, 0.3]));
        const flags = it.tile.biome?.flags[0] ?? 0;
        b.level.setX(i, levelOf("plant", flags));
        b.flags.setX(i, flags);
        b.refs.push({ tile: it.tile, k: it.k });
        i++;
      }
      b.mesh.count = i;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      b.level.needsUpdate = true;
      b.flags.needsUpdate = true;
      this.instances += i;
      this.tierCounts[tier] += i;
    }
  }

  /** Nearest drawn plant of a plan (field guide "Locate"); any distance tier. */
  findNearest(plan: PlantKind, px: number, pz: number): { lat: number; lon: number; heightM: number; distance: number } | null {
    let best: { lat: number; lon: number; heightM: number; distance: number } | null = null;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    for (const b of this.batches.values()) {
      if (b.plan !== plan) continue;
      for (let i = 0; i < b.mesh.count; i++) {
        b.mesh.getMatrixAt(i, tmpM);
        tmpM.decompose(pos, q, sc);
        const d = Math.hypot(pos.x - px, pos.z - pz);
        if (best && d >= best.distance) continue;
        const ref = b.refs[i]!, p = ref.tile.ecology!.plants;
        best = { lat: p.lat[ref.k]!, lon: p.lon[ref.k]!, heightM: sc.y, distance: d };
      }
    }
    return best;
  }

  /** Nearest plant along a ray, by its trunk/crown as a vertical capsule; within maxM. */
  pick(ray: THREE.Ray, maxM: number): PlantPick | null {
    let best: PlantPick | null = null;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    for (const b of this.batches.values()) {
      for (let i = 0; i < b.mesh.count; i++) {
        b.mesh.getMatrixAt(i, tmpM);
        tmpM.decompose(pos, q, sc);
        const hgt = sc.y, r = Math.max(0.4, hgt * 0.22);
        const centre = pos.clone().setY(pos.y + hgt * 0.55);
        const d = ray.distanceToPoint(centre);
        if (d > r + hgt * 0.3) continue;
        const along = centre.clone().sub(ray.origin).dot(ray.direction);
        if (along < 0 || along > maxM || (best && along >= best.distance)) continue;
        const ref = b.refs[i]!;
        const p = ref.tile.ecology!.plants;
        const plan = b.plan as PlantKind;
        best = { kind: "plant", plan, alive: plan !== "snag", tile: ref.tile, lat: p.lat[ref.k]!, lon: p.lon[ref.k]!, distance: along };
      }
    }
    return best;
  }

  dispose(): void {
    for (const b of this.batches.values()) b.mesh.dispose();
    for (const g of this.geos.values()) g.dispose();
    this.living.dispose(); this.dead.dispose(); this.depthLiving.dispose(); this.depthDead.dispose();
    if (this.impostor) { this.impostor.material.dispose(); this.impostor.target.dispose(); for (const c of this.impostor.cells.values()) c.geo.dispose(); }
  }
}

// ------------------------------------------------------------------ fauna

export interface LiveAnimal {
  agent: Agent;
  taxon: TaxonEntry;
  tile: TileData;
  lengthM: number;
  colourSeed: number;
  flags: number;
  lat: number; lon: number;   // kept in step with the agent for picking and cards
  move: number; graze: number; // smoothed 0–1 gait and grazing amounts (shader)
  y: number;                    // drawn base height in the current frame (for the locate marker)
}

export class FaunaLayer {
  readonly group = new THREE.Group();
  private readonly byTile = new Map<string, LiveAnimal[]>();
  private readonly batches = new Map<AnimalPlan, Batch>();
  private readonly live = new Map<AnimalPlan, LiveAnimal[]>();   // instance index → animal, per batch
  private readonly material: THREE.MeshStandardMaterial;
  private readonly depth: THREE.MeshDepthMaterial;
  private time = 0;

  constructor(uniforms: OrganismUniforms) {
    this.material = makeOrganismMaterial(uniforms, { kind: "animal" });
    this.depth = makeOrganismDepthMaterial(uniforms, "animal");
    this.group.name = "fauna";
  }

  get count(): number { let n = 0; for (const l of this.byTile.values()) n += l.length; return n; }

  /** Add a tile's animals. Agents keep their state when the same tile is upgraded. */
  setTile(t: TileData, frame: LocalFrame): void {
    const key = tileKey(t.id);
    if (this.byTile.has(key) || !t.ecology) return;
    const list: LiveAnimal[] = [];
    for (const s of t.ecology.animals) {
      const taxon = t.ecology.roster[s.taxon]!;
      if (!PLAN_INFO[taxon.bodyPlan].rendered) continue;
      const [e, n] = frame.en(s.lat, s.lon);
      list.push({ agent: makeAgent(taxon.bodyPlan, e, -n, s.heading, s.colourSeed, s.group, s.scale), taxon, tile: t,
        lengthM: s.scale, colourSeed: s.colourSeed, flags: s.flags, lat: s.lat, lon: s.lon, move: 0, graze: 0, y: 0 });
    }
    this.byTile.set(key, list);
    this.layout();
  }

  /** Replace a tile's animals outright (e.g. after the representative-fauna setting changed). */
  resetTile(t: TileData, frame: LocalFrame): void {
    this.byTile.delete(tileKey(t.id));
    this.setTile(t, frame);
  }

  removeTile(key: string): void {
    if (this.byTile.delete(key)) this.layout();
  }

  clear(): void { this.byTile.clear(); this.layout(); }

  /** Re-express every agent in a new frame (floating-origin rebase). */
  rebase(from: LocalFrame, to: LocalFrame): void {
    for (const list of this.byTile.values()) {
      for (const a of list) {
        const g = a.agent;
        [g.x, g.z] = from.transfer(g.x, g.z, to);
        [g.homeX, g.homeZ] = from.transfer(g.homeX, g.homeZ, to);
        [g.targetX, g.targetZ] = from.transfer(g.targetX, g.targetZ, to);
      }
    }
  }

  private layout(): void {
    const per = new Map<AnimalPlan, number>();
    for (const list of this.byTile.values()) for (const a of list) per.set(a.agent.plan, (per.get(a.agent.plan) ?? 0) + 1);
    for (const [plan, n] of per) {
      let b = this.batches.get(plan);
      if (!b || b.capacity < n) {
        if (b) { this.group.remove(b.mesh); b.mesh.dispose(); b.mesh.geometry.dispose(); }
        b = makeBatch(animalGeometry(plan), this.material, n + 16, `animals ${plan}`, plan, true);
        b.mesh.castShadow = true;
        b.mesh.receiveShadow = true;
        b.mesh.customDepthMaterial = this.depth;
        this.batches.set(plan, b);
        this.group.add(b.mesh);
      }
    }
  }

  /** Step behaviour (within 2.5 km of the player) and write instance matrices and animation state. */
  update(dt: number, frame: LocalFrame, px: number, pz: number, heightAt: HeightAt): void {
    this.time += dt;
    const ok = (plan: AnimalPlan, x: number, z: number) => {
      const [la, lo] = frame.toLatLon(x, z);
      const h = heightAt(la, lo);
      if (h === null) return false;
      const realm = PLAN_INFO[plan].realm;
      return realm === "sea" ? h < -2 : realm === "water_edge" ? h > -3 : realm === "air" ? true : h >= 0;
    };
    const counts = new Map<AnimalPlan, number>();
    for (const [plan, b] of this.batches) { b.refs = []; this.live.set(plan, []); }
    const ease = 1 - Math.exp(-dt * 3);
    for (const list of this.byTile.values()) {
      // group centres for cohesion
      const centres = new Map<number, { x: number; z: number; n: number }>();
      for (const a of list) { const c = centres.get(a.agent.group) ?? { x: 0, z: 0, n: 0 }; c.x += a.agent.x; c.z += a.agent.z; c.n++; centres.set(a.agent.group, c); }
      const near = list.some((a) => Math.hypot(a.agent.x - px, a.agent.z - pz) < 2500);
      if (near && dt > 0) {
        for (const a of list) {
          const c = centres.get(a.agent.group)!;
          step(a.agent, dt, ok, c.n > 1 ? { x: c.x / c.n, z: c.z / c.n } : undefined);
        }
        const len = new Map(list.map((a) => [a.agent, a.lengthM] as const));
        separate(list.map((a) => a.agent), (g) => 0.6 * (len.get(g) ?? 1), ok);
      }
      for (const a of list) {
        const g = a.agent;
        const b = this.batches.get(g.plan)!;
        const i = counts.get(g.plan) ?? 0;
        counts.set(g.plan, i + 1);
        const [la, lo] = frame.toLatLon(g.x, g.z);
        a.lat = la; a.lon = lo;
        const ground = heightAt(la, lo) ?? 0;
        const realm = PLAN_INFO[g.plan].realm;
        const walking = g.state === "wander";
        a.move += ((realm === "air" ? 0.5 + 0.5 * Math.sin(this.time * 0.15 + g.homeX) : realm === "sea" ? 1 : walking ? 1 : 0) - a.move) * ease;
        a.graze += ((g.state === "graze" || (g.state === "drink" && !walking) ? 1 : 0) - a.graze) * ease;
        let y = realm === "sea" ? -0.25 * a.lengthM * 0.1 : realm === "air" ? Math.max(ground, 0) + 25 + 10 * Math.sin(this.time * 0.3 + g.homeX) : Math.max(ground, realm === "water_edge" ? -0.5 : 0);
        if (realm !== "air" && realm !== "sea") y += Math.abs(Math.sin(this.time * 6 / Math.sqrt(a.lengthM))) * 0.01 * a.lengthM * a.move;   // gait bob
        a.y = y - LocalFrame.drop(g.x, g.z);
        tmpP.set(g.x, a.y, g.z);
        tmpQ.setFromAxisAngle(UP, -g.heading);
        const resting = g.state === "rest" && realm !== "air" && realm !== "sea";
        tmpS.set(a.lengthM, a.lengthM * (resting ? 0.8 : 1), a.lengthM);
        b.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
        b.mesh.setColorAt(i, tintFromSeed(a.colourSeed, 0.3, tmpC));
        b.level.setX(i, levelOf("animal", a.flags));
        b.flags.setX(i, a.flags);
        // gait frequency: stride ≈ a quarter of body length; fliers flap slowly
        const hz = realm === "air" ? 0.7 : realm === "sea" ? 0.35 : Math.max(0.25, g.speed / (0.25 * a.lengthM));
        b.anim!.setXYZW(i, patternSeed(a.colourSeed), hz, a.move, a.graze);
        b.refs.push({ tile: a.tile, k: i });
        this.live.get(g.plan)![i] = a;
      }
    }
    for (const [plan, b] of this.batches) {
      b.mesh.count = counts.get(plan) ?? 0;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      b.level.needsUpdate = true;
      b.flags.needsUpdate = true;
      b.anim!.needsUpdate = true;
    }
  }

  /** Is this animal still on a loaded tile? */
  has(a: LiveAnimal): boolean {
    for (const list of this.byTile.values()) if (list.includes(a)) return true;
    return false;
  }

  /** Nearest animal on the loaded tiles whose taxon matches (field guide "Locate"). */
  findNearest(match: (t: TaxonEntry) => boolean, px: number, pz: number): LiveAnimal | null {
    let best: LiveAnimal | null = null, bd = Infinity;
    for (const list of this.byTile.values()) {
      for (const a of list) {
        if (!match(a.taxon)) continue;
        const d = Math.hypot(a.agent.x - px, a.agent.z - pz);
        if (d < bd) { bd = d; best = a; }
      }
    }
    return best;
  }

  /** Closest drawn animal to a point (debug aiming and tests). Position is the body centre in the frame. */
  nearest(px: number, pz: number, minLengthM = 0): { animal: LiveAnimal; x: number; y: number; z: number; distance: number } | null {
    let best: { animal: LiveAnimal; x: number; y: number; z: number; distance: number } | null = null;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    for (const [plan, b] of this.batches) {
      const live = this.live.get(plan) ?? [];
      for (let i = 0; i < b.mesh.count; i++) {
        b.mesh.getMatrixAt(i, tmpM);
        tmpM.decompose(pos, q, sc);
        const d = Math.hypot(pos.x - px, pos.z - pz);
        if (sc.x < minLengthM) continue;
        if (!best || d < best.distance) best = { animal: live[i]!, x: pos.x, y: pos.y + sc.x * 0.2, z: pos.z, distance: d };
      }
    }
    return best;
  }

  /** Nearest animal along a ray (bounding sphere around the body), within maxM. */
  pick(ray: THREE.Ray, maxM: number): AnimalPick | null {
    let best: AnimalPick | null = null;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    for (const [plan, b] of this.batches) {
      const live = this.live.get(plan) ?? [];
      for (let i = 0; i < b.mesh.count; i++) {
        b.mesh.getMatrixAt(i, tmpM);
        tmpM.decompose(pos, q, sc);
        const len = sc.x, centre = pos.clone().setY(pos.y + len * 0.2);
        if (ray.distanceToPoint(centre) > Math.max(0.5, len * 0.35)) continue;
        const along = centre.clone().sub(ray.origin).dot(ray.direction);
        if (along < 0 || along > maxM || (best && along >= best.distance)) continue;
        best = { kind: "animal", agent: live[i]!, distance: along };
      }
    }
    return best;
  }

  dispose(): void {
    for (const b of this.batches.values()) { b.mesh.geometry.dispose(); b.mesh.dispose(); }
    this.material.dispose();
    this.depth.dispose();
  }
}

export { F, PLANT_NAMES };
