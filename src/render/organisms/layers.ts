// Plants and animals in walk mode (render §7–§8). Instances come from ecology/ (world-anchored lat/lon
// positions); this layer projects them into the current local frame, sits them on the drawn
// terrain, and draws them as one InstancedMesh per body plan. Rebuilt on tile changes and when the
// player has moved far enough; animals step through their behaviour every frame.

import * as THREE from "three";
import { PLANT_NAMES, PLANT_PLANS, type PlantPlan } from "../../biome/plants";
import { makeAgent, separate, step, type Agent } from "../../ecology/behaviour";
import { PLAN_INFO, type AnimalPlan, type TaxonEntry } from "../../ecology/roster";
import { F, levelOf } from "../../provenance/flags";
import type { TileData } from "../../terrain/tile";
import { tileKey } from "../../terrain/tilegrid";
import { makeOrganismMaterial } from "../materials";
import { LocalFrame } from "../projection";
import { animalGeometry, plantGeometry, tintFromSeed } from "./models";

export type HeightAt = (lat: number, lon: number) => number | null;

/** Draw distances (m): trees to the edge of the 3 × 3 ring, understorey closer. */
export const PLANT_DRAW_M: Record<PlantPlan | "snag", number> = {
  conifer: 1800, ginkgo: 1800, early_angiosperm: 1400, seed_fern: 1000, cycad_bennettitalean: 600, fern: 450, horsetail: 450, snag: 1800,
};
export const REBUILD_AFTER_M = 150;

export interface OrganismUniforms { u_overlay: { value: number }; u_time: { value: number } }

export interface PlantPick { kind: "plant"; plan: PlantPlan | "snag"; alive: boolean; tile: TileData; lat: number; lon: number; distance: number }
export interface AnimalPick { kind: "animal"; agent: LiveAnimal; distance: number }

interface Batch { mesh: THREE.InstancedMesh; level: THREE.InstancedBufferAttribute; capacity: number; refs: { tile: TileData; k: number }[] }

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpC = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function makeBatch(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number, name: string): Batch {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
  mesh.name = name;
  mesh.count = 0;
  mesh.frustumCulled = false;   // instances span the whole ring; the per-instance distance cut does the culling
  const level = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity)), 1);
  geo.setAttribute("aLevel", level);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 3), 3);
  return { mesh, level, capacity: Math.max(1, capacity), refs: [] };
}

// ------------------------------------------------------------------ flora

export class FloraLayer {
  readonly group = new THREE.Group();
  private readonly batches = new Map<PlantPlan | "snag", Batch>();
  private readonly geos = new Map<PlantPlan | "snag", THREE.BufferGeometry>();
  private readonly living: THREE.MeshStandardMaterial;
  private readonly dead: THREE.MeshStandardMaterial;
  private lastX = Infinity;
  private lastZ = Infinity;
  instances = 0;

  constructor(uniforms: OrganismUniforms) {
    this.living = makeOrganismMaterial(uniforms, { sway: true });
    this.dead = makeOrganismMaterial(uniforms, { sway: false });
    this.group.name = "flora";
  }

  needsRebuild(px: number, pz: number): boolean {
    return Math.hypot(px - this.lastX, pz - this.lastZ) > REBUILD_AFTER_M;
  }

  rebuild(tiles: Iterable<TileData>, frame: LocalFrame, px: number, pz: number, heightAt: HeightAt): void {
    this.lastX = px;
    this.lastZ = pz;
    const chosen = new Map<PlantPlan | "snag", { tile: TileData; k: number; x: number; z: number }[]>();
    for (const t of tiles) {
      const p = t.ecology?.plants;
      if (!p) continue;
      for (let k = 0; k < p.count; k++) {
        const plan: PlantPlan | "snag" = p.alive[k] ? PLANT_PLANS[p.plan[k]!]! : "snag";
        const [e, n] = frame.en(p.lat[k]!, p.lon[k]!);
        const x = e, z = -n;
        const d = Math.hypot(x - px, z - pz);
        if (d > PLANT_DRAW_M[plan]) continue;
        let list = chosen.get(plan);
        if (!list) chosen.set(plan, (list = []));
        list.push({ tile: t, k, x, z });
      }
    }
    this.instances = 0;
    for (const plan of [...PLANT_PLANS, "snag"] as (PlantPlan | "snag")[]) {
      const list = chosen.get(plan) ?? [];
      let b = this.batches.get(plan);
      if (!b || b.capacity < list.length) {
        if (b) { this.group.remove(b.mesh); b.mesh.dispose(); }
        let geo = this.geos.get(plan);
        if (!geo) this.geos.set(plan, (geo = plantGeometry(plan)));
        b = makeBatch(geo, plan === "snag" ? this.dead : this.living, Math.ceil(list.length * 1.3), `plants ${plan}`);
        this.batches.set(plan, b);
        this.group.add(b.mesh);
      }
      b.refs = [];
      let i = 0;
      for (const it of list) {
        const p = it.tile.ecology!.plants;
        const h = heightAt(p.lat[it.k]!, p.lon[it.k]!);
        if (h === null || h < 0) continue;
        const s = p.scale[it.k]!;
        tmpP.set(it.x, h - LocalFrame.drop(it.x, it.z) - 0.05 * s, it.z);
        tmpQ.setFromAxisAngle(UP, p.rotation[it.k]!);
        tmpS.set(s, s, s);
        b.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
        b.mesh.setColorAt(i, tintFromSeed(p.colourSeed[it.k]!, plan === "snag" ? 0.05 : 0.22, tmpC));
        const flags = it.tile.biome?.flags[0] ?? 0;
        b.level.setX(i, levelOf("plant", flags));
        b.refs.push({ tile: it.tile, k: it.k });
        i++;
      }
      b.mesh.count = i;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      b.level.needsUpdate = true;
      this.instances += i;
    }
  }

  /** Nearest plant along a ray, by its trunk/crown as a vertical capsule; within maxM. */
  pick(ray: THREE.Ray, maxM: number): PlantPick | null {
    let best: PlantPick | null = null;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    for (const [plan, b] of this.batches) {
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
        best = { kind: "plant", plan, alive: plan !== "snag", tile: ref.tile, lat: p.lat[ref.k]!, lon: p.lon[ref.k]!, distance: along };
      }
    }
    return best;
  }

  dispose(): void {
    for (const b of this.batches.values()) b.mesh.dispose();
    for (const g of this.geos.values()) g.dispose();
    this.living.dispose();
    this.dead.dispose();
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
}

export class FaunaLayer {
  readonly group = new THREE.Group();
  private readonly byTile = new Map<string, LiveAnimal[]>();
  private readonly batches = new Map<AnimalPlan, Batch>();
  private readonly live = new Map<AnimalPlan, LiveAnimal[]>();   // instance index → animal, per batch
  private readonly material: THREE.MeshStandardMaterial;
  private time = 0;

  constructor(uniforms: OrganismUniforms) {
    this.material = makeOrganismMaterial(uniforms, { sway: false });
    this.group.name = "fauna";
  }

  get count(): number { let n = 0; for (const l of this.byTile.values()) n += l.length; return n; }

  /** Add (or replace) a tile's animals. Agents keep their state when the same tile is upgraded. */
  setTile(t: TileData, frame: LocalFrame): void {
    const key = tileKey(t.id);
    if (this.byTile.has(key) || !t.ecology) return;
    const list: LiveAnimal[] = [];
    for (const s of t.ecology.animals) {
      const taxon = t.ecology.roster[s.taxon]!;
      if (!PLAN_INFO[taxon.bodyPlan].rendered) continue;
      const [e, n] = frame.en(s.lat, s.lon);
      list.push({ agent: makeAgent(taxon.bodyPlan, e, -n, s.heading, s.colourSeed, s.group, s.scale), taxon, tile: t,
        lengthM: s.scale, colourSeed: s.colourSeed, flags: s.flags, lat: s.lat, lon: s.lon });
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
        if (b) { this.group.remove(b.mesh); b.mesh.dispose(); }
        b = makeBatch(animalGeometry(plan), this.material, n + 16, `animals ${plan}`);
        this.batches.set(plan, b);
        this.group.add(b.mesh);
      }
    }
  }

  /** Step behaviour (within 2.5 km of the player) and write instance matrices. */
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
        separate(list.map((a) => a.agent), (g) => 0.6 * (list.find((a) => a.agent === g)?.lengthM ?? 1), ok);
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
        const moving = g.state === "wander" || g.state === "drink";
        let y = realm === "sea" ? -0.25 * a.lengthM * 0.1 : realm === "air" ? Math.max(ground, 0) + 25 + 10 * Math.sin(this.time * 0.3 + g.homeX) : Math.max(ground, realm === "water_edge" ? -0.5 : 0);
        if (moving && realm !== "air") y += Math.abs(Math.sin(this.time * 6 / Math.sqrt(a.lengthM))) * 0.02 * a.lengthM;   // gait bob
        tmpP.set(g.x, y - LocalFrame.drop(g.x, g.z), g.z);
        tmpQ.setFromAxisAngle(UP, -g.heading + (g.state === "rest" ? 0 : 0));
        tmpS.set(a.lengthM, a.lengthM * (g.state === "rest" && realm === "land" ? 0.8 : 1), a.lengthM);
        b.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
        b.mesh.setColorAt(i, tintFromSeed(a.colourSeed, 0.35, tmpC));
        b.level.setX(i, levelOf("animal", a.flags));
        b.refs.push({ tile: a.tile, k: i });
        this.live.get(g.plan)![i] = a;
      }
    }
    for (const [plan, b] of this.batches) {
      b.mesh.count = counts.get(plan) ?? 0;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      b.level.needsUpdate = true;
    }
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
  }
}

export { F, PLANT_NAMES };
