// Walk mode (render §1–§6, §9): first-person walk and flight over generated terrain, 3 × 3 tile
// streaming around a floating origin, the far ring from the DEM, sea, sky with the sun from the
// palaeolatitude, the provenance overlay (P) and click-to-inspect. Plants, animals, biome colours,
// shadows, quality presets and photo mode are later work.

import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { F, FLAG_INFO, flagNames, Level, levelOf, LEVEL_NAMES, type FlagName } from "../provenance/flags";
import { fmtArea } from "../ecology/roster";
import { impactWinterCooling, impactWinterLight, type Aftermath } from "../biome/climate";
import { PLANT_NAMES, topPlants, type PlantMix } from "../biome/plants";
import type { TileEcology } from "../ecology";
import { BIOME_NAMES } from "../biome/rules";
import type { TerrainClient } from "../terrain/client";
import type { InspectResult } from "../terrain/service";
import type { FarField, TileData } from "../terrain/tile";
import { MAX_ABS_LAT, ring, tileBounds, tileIdFor, tileKey, type TileId } from "../terrain/tilegrid";
import { makeTerrainMaterial, makeUniforms, makeWaterMaterial, type TerrainUniforms } from "./materials";
import { buildFarMesh, buildSea, buildTileMesh, farHeightAt, tileHeightAt, type FarMesh, type TileMesh } from "./meshes";
import { buildMorph, type MorphFn } from "./morph";
import { FaunaLayer, FloraLayer, type LiveAnimal, type PlantPick } from "./organisms/layers";
import { headingOf, LocalFrame, sunDirection } from "./projection";

// ------------------------------------------------------------------ constants (render §2, §5, §6)

export const EYE_M = 1.7;
export const WALK_MS = 1.4;
export const RUN_MS = 4;
export const FLY_MIN_MS = 5;
export const FLY_MAX_MS = 60;
export const FLY_CLEARANCE_M = 2;
export const MAX_SLOPE_DEG = 40;
const HOP_MS = 3.2, GRAVITY = 9.81;
const FAR_HALF_M = 60_000, FAR_N = 241;
const CURRENT_STEP = 1, RING_STEP = 4;
const TILE_CACHE = 18;
const INSPECT_RANGE_M = 9000;

export type Mode = "walk" | "fly";

export interface PlayerState {
  lat: number; lon: number;
  altitudeM: number;           // eye altitude above sea level
  groundM: number | null;      // terrain height under the player (null = not loaded)
  headingDeg: number; pitchDeg: number;
  mode: Mode; flySpeed: number; hours: number;
  overlay: boolean;
  tiles: { ready: number; wanted: number; current: "coarse" | "full" | "loading" };
  plants: number;   // plant instances drawn
  animals: number;  // animals on the loaded tiles
  sliceAge: number;
  aftermath: Aftermath | null;
}

export interface InfoCard {
  kind: "terrain" | "water" | "sky" | "animal" | "plant";
  title: string;
  level: Level;
  levelName: (typeof LEVEL_NAMES)[number];
  lines: { label: string; value: string }[];
  links?: { label: string; url: string }[];
  flags: { name: FlagName; short: string; long: string; refs: string[] }[];
  lat?: number; lon?: number;
}

export interface TileEcologyView {
  ecology: TileEcology;
  plantMix: PlantMix;
  sliceAge: number;
  tile: TileId;
}

export interface EnterRequest { sliceAge: number; lat: number; lon: number; aftermath?: Aftermath | null }
export type LoadProgress = (label: string, fraction: number) => void;

// ------------------------------------------------------------------ renderer

export class WalkRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.3, 150_000);
  private readonly uniforms: TerrainUniforms = makeUniforms();
  private readonly nearMat: THREE.MeshStandardMaterial;
  private readonly farMat: THREE.MeshStandardMaterial;
  private readonly waterMat = makeWaterMaterial();
  private readonly sky = new Sky();
  private readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  private readonly hemi = new THREE.HemisphereLight(0xc4d6ff, 0x4d4436, 0.9);
  private readonly tileGroup = new THREE.Group();
  private readonly organismUniforms = { u_overlay: this.uniforms.u_overlay, u_time: { value: 0 } };
  private readonly flora = new FloraLayer(this.organismUniforms);
  private readonly fauna = new FaunaLayer(this.organismUniforms);
  private floraDirty = true;

  private frame = new LocalFrame(0, 0);
  private current: TileId = { row: 0, col: 0 };
  private sliceAge = 150;
  private readonly tiles = new Map<string, TileMesh>();        // in the scene
  private readonly cache = new Map<string, TileData>();        // recent tile data, LRU
  private readonly inflight = new Set<string>();
  private far: FarMesh | null = null;
  private morph: MorphFn = () => 0;
  private farInflight = false;
  private generation = 0;

  // player, in the current frame (float64)
  private x = 0;
  private z = 0;
  private alt = 0;             // eye altitude above sea level
  private hop = 0;             // height of a hop above the walking eye level
  private vy = 0;
  private yaw = 0;             // radians; 0 = looking north
  private pitch = 0;
  private mode: Mode = "walk";
  private flySpeed = 20;
  private hours = 10.5;
  private aftermath: Aftermath | null = null;
  private overlay = false;
  private readonly keys = new Set<string>();

  private raf = 0;
  private last = 0;
  private running = false;     // the frame loop
  private live = false;        // walk mode is on screen (input enabled)
  private lastState = 0;
  private dragging: { x: number; y: number; moved: boolean } | null = null;
  private lockUnavailable = false;
  private readonly disposers: (() => void)[] = [];
  private stateCbs: ((s: PlayerState) => void)[] = [];
  private cardCbs: ((c: InfoCard | null) => void)[] = [];
  private exitCbs: (() => void)[] = [];
  private noticeCbs: ((msg: string) => void)[] = [];
  private ecoCbs: ((e: TileEcologyView | null) => void)[] = [];
  private staleEcology = new Set<string>();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly terrain: TerrainClient) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.55;

    this.nearMat = makeTerrainMaterial(this.uniforms, { holes: false });
    this.farMat = makeTerrainMaterial(this.uniforms, { holes: true });

    this.sky.scale.setScalar(100_000);
    this.sky.renderOrder = -1;
    (this.sky.material as THREE.ShaderMaterial).depthTest = false;
    const su = (this.sky.material as THREE.ShaderMaterial).uniforms;
    su.turbidity!.value = 5;
    su.rayleigh!.value = 1.4;
    su.mieCoefficient!.value = 0.004;
    su.mieDirectionalG!.value = 0.8;
    this.sky.frustumCulled = false;

    this.scene.add(this.sky, this.sun, this.sun.target, this.hemi, this.tileGroup, buildSea(FAR_HALF_M * 1.3, this.waterMat),
      this.flora.group, this.fauna.group);
    this.scene.fog = new THREE.Fog(0xaebccb, 2500, 58_000);
    this.camera.rotation.order = "YXZ";

    this.bindInput();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement ?? canvas);
    this.disposers.push(() => ro.disconnect());
    this.resize();
  }

  // ------------------------------------------------------------------ public API

  onState(cb: (s: PlayerState) => void): void { this.stateCbs.push(cb); }
  onCard(cb: (c: InfoCard | null) => void): void { this.cardCbs.push(cb); }
  onExit(cb: () => void): void { this.exitCbs.push(cb); }
  onNotice(cb: (msg: string) => void): void { this.noticeCbs.push(cb); }
  /** The ecology of the tile underfoot (roster, plant mix), whenever it changes. */
  onEcology(cb: (e: TileEcologyView | null) => void): void { this.ecoCbs.push(cb); }

  currentEcology(): TileEcologyView | null {
    const t = this.tiles.get(tileKey(this.current))?.data;
    return t?.ecology && t.biome ? { ecology: t.ecology, plantMix: t.biome.plantMix, sliceAge: this.sliceAge, tile: t.id } : null;
  }

  /** Representative fauna (ui/ §4): regenerate the loaded tiles' ecology with the new setting. */
  setRepresentativeFauna(on: boolean): void {
    this.terrain.ecologySettings = { representativeFauna: on };
    this.cache.clear();
    for (const [k, t] of this.tiles) { this.staleEcology.add(k); this.request(t.data.id, t.data.step); }
  }

  get representativeFauna(): boolean { return this.terrain.ecologySettings.representativeFauna; }

  /** Load the tile under (lat, lon) and its surroundings, put the player there, start the loop. */
  async enter(req: EnterRequest, progress?: LoadProgress): Promise<void> {
    const lat = Math.max(-MAX_ABS_LAT, Math.min(MAX_ABS_LAT, req.lat));
    this.generation++;
    this.clearTiles();
    this.sliceAge = req.sliceAge;
    this.aftermath = req.aftermath ?? null;
    this.terrain.aftermath = this.aftermath;
    this.current = tileIdFor(lat, req.lon);
    const b = tileBounds(this.current);
    this.frame = new LocalFrame(b.centreLat, b.centreLon);
    this.morph = buildMorph(this.frame, ring(this.current));
    [this.x, this.z] = (() => { const [e, n] = this.frame.en(lat, req.lon); return [e, -n]; })();
    this.updateSun();

    progress?.("Loading the elevation model", 0.05);
    const first = await this.terrain.tile(this.sliceAge, this.current, RING_STEP, (stage) =>
      progress?.(stage === "loading DEM" ? "Loading the elevation model" : "Generating terrain", 0.25));
    this.store(first);
    this.addTile(first);
    progress?.("Drawing the horizon from the DEM", 0.55);
    const far = await this.terrain.farField(this.sliceAge, b.centreLat, b.centreLon, FAR_HALF_M, FAR_N);
    this.setFar(far);
    progress?.("Placing you on the ground", 0.95);

    const g = this.groundAt(this.x, this.z);
    this.yaw = 0;
    this.pitch = -0.05;
    if (g === null || g < 0) {
      this.mode = "fly";
      this.alt = Math.max(0, g ?? 0) + 60;
      this.notice("This point is under the sea at this time slice, so you start in flight. Fly to land and press F to walk.");
    } else {
      this.mode = "walk";
      this.alt = g + EYE_M;
    }
    this.hop = 0;
    this.vy = 0;
    this.stream();
    this.start();
    progress?.("Ready", 1);
  }

  exit(): void {
    this.stop();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.exitCbs.forEach((cb) => cb());
  }

  setOverlay(on: boolean): void {
    this.overlay = on;
    this.uniforms.u_overlay.value = on ? 1 : 0;
    this.waterMat.opacity = on ? 0.45 : 0.8;
    this.emitState(true);
  }

  setTimeOfDay(hours: number): void {
    this.hours = ((hours % 24) + 24) % 24;
    this.updateSun();
    this.emitState(true);
  }

  toggleFly(): void {
    if (this.mode === "walk") {
      this.mode = "fly";
      this.alt += 3;
    } else {
      const g = this.groundAt(this.x, this.z);
      if (g === null || g < 0) { this.notice("You can't land on the sea (no swimming yet). Fly over land first."); return; }
      this.mode = "walk";
      this.alt = g + EYE_M;
      this.hop = 0;
    }
    this.emitState(true);
  }

  /** Inspect what is under a screen point (NDC, −1..1); default is the crosshair. */
  async inspect(ndcX = 0, ndcY = 0): Promise<InfoCard> {
    const hit = this.raycast(ndcX, ndcY);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const reach = hit ? hit.distance + 1 : INSPECT_RANGE_M;
    const animal = this.fauna.pick(ray.ray, reach);
    const plant = this.flora.pick(ray.ray, Math.min(reach, animal?.distance ?? Infinity));
    let card: InfoCard;
    if (animal && (!plant || animal.distance <= plant.distance)) {
      card = animalCard(animal.agent);
    } else if (plant) {
      card = plantCard(plant, this.aftermath);
    } else if (!hit) {
      card = {
        kind: "sky", title: "Sky and light", level: Level.GENERATED, levelName: "generated",
        lines: [
          { label: "Sun", value: `equinox sun at ${fmtLat(this.playerLatLon()[0])}, ${fmtHours(this.hours)} local time` },
          { label: "Note", value: "No seasons, clouds or weather yet." },
        ],
        flags: [flagCard("SKY_GENERATED")],
      };
    } else {
      const r = await this.terrain.inspect(this.sliceAge, hit.lat, hit.lon);
      card = terrainCard(r, hit.water, this.aftermath);
    }
    this.cardCbs.forEach((cb) => cb(card));
    return card;
  }

  /** Debug and test hooks (exposed on window.timeBubble.walk). */
  readonly debug = {
    press: (code: string, down: boolean) => (down ? this.keys.add(code) : this.keys.delete(code)),
    /** Advance the simulation without drawing (draw with frameMs()). */
    step: (seconds: number) => { for (let t = 0; t < seconds; t += 1 / 30) this.update(1 / 30); this.emitState(true); },
    teleport: (lat: number, lon: number) => this.teleport(lat, lon),
    look: (headingDeg: number, pitchDeg: number) => { this.yaw = -headingDeg * Math.PI / 180; this.pitch = pitchDeg * Math.PI / 180; this.draw(); },
    state: () => this.state(),
    /** Turn to face the nearest drawn animal; returns its name and distance. */
    aimAtAnimal: (minLengthM = 0) => {
      const n = this.fauna.nearest(this.x, this.z, minLengthM);
      if (!n) return null;
      const dx = n.x - this.x, dz = n.z - this.z, dy = n.y - (this.alt + this.hop - LocalFrame.drop(this.x, this.z));
      this.yaw = Math.atan2(-dx, -dz);
      this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      return { name: n.animal.taxon.name, plan: n.animal.agent.plan, distance: n.distance };
    },
    idle: () => this.waitIdle(),
    origin: () => ({ lat0: this.frame.lat0, lon0: this.frame.lon0, x: this.x, z: this.z }),
    /** Stop / restart the frame loop (tests drive frames with step() instead). */
    pause: (paused: boolean) => { if (paused) { this.running = false; cancelAnimationFrame(this.raf); } else this.start(); },
    frameMs: () => {
      const t = performance.now();
      this.draw();
      const gl = this.renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));   // forces the frame to finish
      return performance.now() - t;
    },
  };

  dispose(): void {
    this.stop();
    this.generation++;
    this.clearTiles();
    this.far?.dispose();
    this.disposers.forEach((d) => d());
    this.nearMat.dispose();
    this.flora.dispose();
    this.fauna.dispose();
    this.farMat.dispose();
    this.waterMat.dispose();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------ loop

  private start(): void {
    this.live = true;
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.update(dt);
      this.draw();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop(): void {
    this.live = false;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.keys.clear();
  }

  private draw(): void {
    const y = this.alt + this.hop - LocalFrame.drop(this.x, this.z);
    this.camera.position.set(this.x, y, this.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------------ movement (render §2)

  private update(dt: number): void {
    const k = this.keys;
    const fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    const side = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);          // forward, horizontal
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);           // right

    if (this.mode === "fly") {
      const sp = this.flySpeed * (k.has("ShiftLeft") || k.has("ShiftRight") ? 2.5 : 1);
      const cp = Math.cos(this.pitch), sp2 = Math.sin(this.pitch);
      let dx = (fx * cp * fwd + rx * side) * sp * dt;
      let dz = (fz * cp * fwd + rz * side) * sp * dt;
      const da = (sp2 * fwd + ((k.has("Space") ? 1 : 0) - (k.has("KeyC") || k.has("ControlLeft") ? 1 : 0))) * sp * dt;
      const g = this.groundAt(this.x + dx, this.z + dz);
      if (g === null && (dx !== 0 || dz !== 0)) { dx = 0; dz = 0; }   // the edge of the loaded world
      this.x += dx;
      this.z += dz;
      this.alt += da;
      const floor = Math.max(this.groundAt(this.x, this.z) ?? 0, 0) + FLY_CLEARANCE_M;
      if (this.alt < floor) this.alt = floor;
    } else {
      const sp = k.has("ShiftLeft") || k.has("ShiftRight") ? RUN_MS : WALK_MS;
      let mx = fx * fwd + rx * side, mz = fz * fwd + rz * side;
      const len = Math.hypot(mx, mz);
      if (len > 0) {
        mx = (mx / len) * sp * dt;
        mz = (mz / len) * sp * dt;
        const g0 = this.groundAt(this.x, this.z);
        const g1 = this.groundAt(this.x + mx, this.z + mz);
        const ok = g0 !== null && g1 !== null && g1 >= 0 &&
          (g1 - g0) / Math.hypot(mx, mz) <= Math.tan((MAX_SLOPE_DEG * Math.PI) / 180);
        if (ok) { this.x += mx; this.z += mz; }
        else if (g1 !== null && g1 < 0) this.throttledNotice("shore", "The sea stops you here (no swimming yet). Press F to fly.");
      }
      const g = this.groundAt(this.x, this.z);
      if (g !== null) this.alt = Math.max(g, 0) + EYE_M;
      // a small hop for uneven ground
      if (k.has("Space") && this.hop === 0) this.vy = HOP_MS;
      if (this.hop > 0 || this.vy > 0) {
        this.vy -= GRAVITY * dt;
        this.hop = Math.max(0, this.hop + this.vy * dt);
        if (this.hop === 0) this.vy = 0;
      }
    }

    // plants and animals (render §7–§8)
    this.organismUniforms.u_time.value += dt;
    const hAt = (la: number, lo: number) => this.heightAtLatLon(la, lo);
    this.fauna.update(dt, this.frame, this.x, this.z, hAt);
    if (this.floraDirty || this.flora.needsRebuild(this.x, this.z)) {
      this.flora.rebuild([...this.tiles.values()].map((t) => t.data), this.frame, this.x, this.z, hAt);
      this.floraDirty = false;
    }

    const [lat, lon] = this.playerLatLon();
    const id = tileIdFor(lat, lon);
    if (id.row !== this.current.row || id.col !== this.current.col) this.rebase(id);
    this.emitState(false);
  }

  /** Height of the drawn surface at a local position, or null if no tile there is loaded. */
  private groundAt(x: number, z: number): number | null {
    const [lat, lon] = this.frame.toLatLon(x, z);
    return this.heightAtLatLon(lat, lon);
  }

  private heightAtLatLon(lat: number, lon: number): number | null {
    const tm = this.tiles.get(tileKey(tileIdFor(lat, lon)));
    if (tm) return tileHeightAt(tm.data, lat, lon, tm.drawn);
    return null;
  }

  private playerLatLon(): [number, number] {
    return this.frame.toLatLon(this.x, this.z);
  }

  private teleport(lat: number, lon: number): void {
    const id = tileIdFor(lat, lon);
    const [e, n] = this.frame.en(lat, lon);
    this.x = e;
    this.z = -n;
    this.rebase(id);
  }

  // ------------------------------------------------------------------ floating origin and streaming (render §1)

  private rebase(id: TileId): void {
    const b = tileBounds(id);
    const next = new LocalFrame(b.centreLat, b.centreLon);
    [this.x, this.z] = this.frame.transfer(this.x, this.z, next);
    this.fauna.rebase(this.frame, next);
    this.floraDirty = true;
    this.frame = next;
    this.current = id;
    this.morph = buildMorph(next, ring(id));
    for (const t of this.tiles.values()) t.reproject(next, this.morphFor(t.data.id));
    this.far?.reproject(next);
    this.updateHoles();
    this.updateSun();
    this.stream();
    this.emitEcology();
    // keep the player on the ground if the new tile's mesh differs by step
    if (this.mode === "walk") {
      const g = this.groundAt(this.x, this.z);
      if (g !== null) this.alt = Math.max(g, 0) + EYE_M;
    }
  }

  private stream(): void {
    const wanted = ring(this.current);
    const keys = new Set(wanted.map(tileKey));
    for (const [k, t] of this.tiles) {
      if (!keys.has(k)) { this.tileGroup.remove(t.mesh); t.dispose(); this.tiles.delete(k); this.fauna.removeTile(k); this.floraDirty = true; }
    }
    // the current tile first (coarse, then full), then the ring
    const order: [TileId, number][] = [[this.current, RING_STEP], [this.current, CURRENT_STEP]];
    for (const id of wanted) if (tileKey(id) !== tileKey(this.current)) order.push([id, RING_STEP]);
    for (const [id, step] of order) {
      const k = tileKey(id);
      const have = this.tiles.get(k);
      if (have && have.data.step <= step) continue;
      const cached = this.cache.get(`${k}/${step}`) ?? (step === RING_STEP ? this.cache.get(`${k}/${CURRENT_STEP}`) : undefined);
      if (cached && cached.sliceAge === this.sliceAge) { this.addTile(cached); continue; }
      this.request(id, step);
    }
    // far ring: rebuild when the player is > 20 km from its centre
    if (this.far && !this.farInflight) {
      const [e, n] = this.frame.en(this.far.data.lat0, this.far.data.lon0);
      if (Math.hypot(e, n) > 20_000) this.requestFar();
    }
    this.updateHoles();
  }

  private request(id: TileId, step: number): void {
    const key = `${tileKey(id)}/${step}`;
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    const gen = this.generation;
    this.terrain.tile(this.sliceAge, id, step).then((t) => {
      this.inflight.delete(key);
      if (gen !== this.generation) return;
      this.store(t);
      const wanted = ring(this.current).some((r) => tileKey(r) === tileKey(id));
      if (!wanted) return;
      const have = this.tiles.get(tileKey(id));
      if (have && have.data.step <= t.step && !this.staleEcology.has(tileKey(id))) return;
      if (have && have.data.step < t.step) return;
      this.staleEcology.delete(tileKey(id));
      this.addTile(t);
    }).catch((e) => {
      this.inflight.delete(key);
      this.notice(`Terrain failed to generate: ${e instanceof Error ? e.message : e}`);
    });
  }

  private requestFar(): void {
    this.farInflight = true;
    const gen = this.generation;
    const b = tileBounds(this.current);
    this.terrain.farField(this.sliceAge, b.centreLat, b.centreLon, FAR_HALF_M, FAR_N).then((f) => {
      this.farInflight = false;
      if (gen === this.generation) this.setFar(f);
    }).catch(() => { this.farInflight = false; });
  }

  private store(t: TileData): void {
    const k = `${tileKey(t.id)}/${t.step}`;
    this.cache.delete(k);
    this.cache.set(k, t);
    while (this.cache.size > TILE_CACHE) this.cache.delete(this.cache.keys().next().value!);
  }

  private addTile(t: TileData): void {
    const k = tileKey(t.id);
    const old = this.tiles.get(k);
    if (old) { this.tileGroup.remove(old.mesh); old.dispose(); }
    const wasStale = this.staleEcology.has(k) || (old !== undefined && old.data.ecology !== undefined && t.ecology !== undefined &&
      old.data.ecology.animals.length !== t.ecology.animals.length);
    const tm = buildTileMesh(t, this.frame, this.nearMat);
    const morph = this.morphFor(t.id);
    if (morph) tm.reproject(this.frame, morph);
    this.tiles.set(k, tm);
    this.tileGroup.add(tm.mesh);
    if (wasStale) this.fauna.resetTile(t, this.frame); else this.fauna.setTile(t, this.frame);
    this.floraDirty = true;
    tm.mesh.updateMatrix();
    this.updateHoles();
    this.emitState(true);
    // if this replaced the tile under the player, re-seat them on the new surface
    if (k === tileKey(this.current)) this.emitEcology();
    if (k === tileKey(this.current) && this.mode === "walk") {
      const g = this.groundAt(this.x, this.z);
      if (g !== null && g >= 0) this.alt = g + EYE_M;
    }
  }

  /** The ring-edge morph for a tile; none for the tile under the player (render §5). */
  private morphFor(id: TileId): MorphFn | undefined {
    return id.row === this.current.row && id.col === this.current.col ? undefined : this.morph;
  }

  private setFar(f: FarField): void {
    if (this.far) { this.scene.remove(this.far.mesh); this.far.dispose(); }
    this.far = buildFarMesh(f, this.frame, this.farMat);
    this.scene.add(this.far.mesh);
    this.far.mesh.updateMatrix();
  }

  /** Cut holes in the far ring where near tiles are loaded (lat/lon relative to the origin). */
  private updateHoles(): void {
    const eps = 1e-6;
    let i = 0;
    for (const t of this.tiles.values()) {
      const b = t.data.bounds;
      const w = ((b.lonWest - this.frame.lon0 + 540) % 360) - 180;
      this.uniforms.u_holes.value[i++]!.set(b.latSouth - this.frame.lat0 + eps, b.latNorth - this.frame.lat0 - eps, w + eps, w + b.dlon - eps);
      if (i >= 9) break;
    }
    this.uniforms.u_nholes.value = i;
  }

  private clearTiles(): void {
    for (const t of this.tiles.values()) { this.tileGroup.remove(t.mesh); t.dispose(); }
    this.tiles.clear();
    this.fauna.clear();
    this.floraDirty = true;
    this.cache.clear();
    this.inflight.clear();
    if (this.far) { this.scene.remove(this.far.mesh); this.far.dispose(); this.far = null; }
  }

  private async waitIdle(): Promise<void> {
    while (this.inflight.size > 0 || this.farInflight) await new Promise((r) => setTimeout(r, 50));
    this.draw();
  }

  // ------------------------------------------------------------------ sky (render §6)

  private updateSun(): void {
    const [dx, dy, dz] = sunDirection(this.frame.lat0, this.hours);
    const d = new THREE.Vector3(dx, dy, dz);
    (this.sky.material as THREE.ShaderMaterial).uniforms.sunPosition!.value.copy(d);
    this.sun.position.copy(d).multiplyScalar(1000);
    const day = THREE.MathUtils.smoothstep(dy, -0.05, 0.15);
    // Aftermath atmosphere (render §6): Impact Winter dims the sun and turns the sky grey-brown
    const winter = this.aftermath?.phase === "impactWinter";
    const light = winter ? impactWinterLight(this.aftermath!.year) : 1;
    const su = (this.sky.material as THREE.ShaderMaterial).uniforms;
    su.turbidity!.value = winter ? 5 + 15 * (1 - light) : 5;
    su.rayleigh!.value = winter ? 1.4 * light + 0.1 : 1.4;
    this.sun.intensity = 2.4 * day * light;
    this.hemi.intensity = (0.15 + 0.75 * day) * (0.6 + 0.4 * light) * (winter ? 2.6 : 1);
    this.renderer.toneMappingExposure = (0.35 + 0.2 * day) * (this.aftermath?.phase === "fernSpike" ? 0.92 : 1);
    const fog = (this.scene.fog as THREE.Fog);
    if (winter) fog.color.setHSL(0.08, 0.12, (0.12 + 0.45 * day) * (0.35 + 0.65 * light));
    else fog.color.setHSL(0.58, 0.18, 0.12 + 0.6 * day);
    fog.far = winter ? 15_000 + 43_000 * light : 58_000;
    // Impact Winter overcast: the analytic sky can't darken, so a fog-coloured sky replaces it
    this.sky.visible = !winter || light > 0.9;
    // the background skips tone mapping, so darken it to sit with the tone-mapped fog at the horizon
    this.scene.background = this.sky.visible ? null : fog.color.clone().multiplyScalar(0.5);
  }

  // ------------------------------------------------------------------ picking (render §9)

  private raycast(ndcX: number, ndcY: number): { lat: number; lon: number; water: boolean; distance: number } | null {
    const ray = new THREE.Raycaster();
    this.draw();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const surf = (t: number) => {
      const x = o.x + d.x * t, z = o.z + d.z * t;
      const altP = o.y + d.y * t + LocalFrame.drop(x, z);
      const [lat, lon] = this.frame.toLatLon(x, z);
      const g = this.heightAtLatLon(lat, lon) ?? (this.far ? farHeightAt(this.far.data, lat, lon) : null);
      return { lat, lon, above: g === null ? Infinity : altP - Math.max(g, 0), water: g !== null && g < 0 };
    };
    let t0 = 0, t = 0.5;
    while (t < INSPECT_RANGE_M) {
      const s = surf(t);
      if (s.above <= 0) {
        let lo = t0, hi = t;
        for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (surf(m).above <= 0) hi = m; else lo = m; }
        const h = surf(hi);
        return { lat: h.lat, lon: h.lon, water: h.water, distance: hi };
      }
      t0 = t;
      t += Math.max(0.5, t * 0.01);
    }
    return null;
  }

  // ------------------------------------------------------------------ input

  private bindInput(): void {
    const c = this.canvas;
    const on = <K extends keyof WindowEventMap | "pointerlockerror">(target: Window | HTMLElement | Document, type: K,
      fn: (e: K extends keyof WindowEventMap ? WindowEventMap[K] : Event) => void) => {
      target.addEventListener(type, fn as EventListener);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener));
    };
    on(window, "keydown", (e) => {
      if (!this.live || isTyping(e)) return;
      if (e.code === "Escape") { if (document.pointerLockElement !== c) this.exit(); return; }
      if (e.code === "KeyP") { this.setOverlay(!this.overlay); return; }
      if (e.code === "KeyF") { this.toggleFly(); return; }
      if (e.code === "KeyI") { void this.inspect(); return; }
      if (e.code === "BracketLeft") { this.setTimeOfDay(this.hours - 0.5); return; }
      if (e.code === "BracketRight") { this.setTimeOfDay(this.hours + 0.5); return; }
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    on(window, "keyup", (e) => this.keys.delete(e.code));
    on(window, "blur", () => this.keys.clear());
    on(c, "mousedown", (e) => { this.dragging = { x: e.clientX, y: e.clientY, moved: false }; });
    on(window, "mousemove", (e) => {
      if (!this.live) return;
      if (document.pointerLockElement === c) this.look(e.movementX, e.movementY);
      else if (this.dragging && (e.buttons & 1)) {
        const dx = e.clientX - this.dragging.x, dy = e.clientY - this.dragging.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragging.moved = true;
        if (this.dragging.moved) { this.look(dx, dy); this.dragging.x = e.clientX; this.dragging.y = e.clientY; }
      }
    });
    on(window, "mouseup", (e) => {
      const d = this.dragging;
      this.dragging = null;
      if (!this.live || !d || d.moved || e.target !== c) return;
      if (document.pointerLockElement === c) { void this.inspect(); return; }
      if (!this.lockUnavailable && c.requestPointerLock) {
        try {
          const p = c.requestPointerLock() as unknown as Promise<void> | undefined;
          p?.catch?.(() => { this.lockUnavailable = true; });
        } catch { this.lockUnavailable = true; }
        return;
      }
      const r = c.getBoundingClientRect();
      void this.inspect(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
    });
    on(document, "pointerlockerror", () => { this.lockUnavailable = true; });
    on(c, "wheel", (e) => {
      if (this.mode !== "fly") return;
      e.preventDefault();
      this.flySpeed = Math.max(FLY_MIN_MS, Math.min(FLY_MAX_MS, this.flySpeed * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.emitState(true);
    });
  }

  private look(dx: number, dy: number): void {
    this.yaw -= dx * 0.0025;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * 0.0025));
  }

  private resize(): void {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.live) this.draw();
  }

  // ------------------------------------------------------------------ state and notices

  private state(): PlayerState {
    const [lat, lon] = this.playerLatLon();
    const wanted = ring(this.current).map(tileKey);
    const cur = this.tiles.get(tileKey(this.current));
    return {
      lat, lon, altitudeM: this.alt + this.hop, groundM: this.groundAt(this.x, this.z),
      headingDeg: headingOf(-Math.sin(this.yaw), -Math.cos(this.yaw)), pitchDeg: (this.pitch * 180) / Math.PI,
      mode: this.mode, flySpeed: this.flySpeed, hours: this.hours, overlay: this.overlay,
      tiles: { ready: wanted.filter((k) => this.tiles.has(k)).length, wanted: wanted.length, current: !cur ? "loading" : cur.data.step === CURRENT_STEP ? "full" : "coarse" },
      plants: this.flora.instances, animals: this.fauna.count,
      sliceAge: this.sliceAge, aftermath: this.aftermath,
    };
  }

  private emitState(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastState < 100) return;
    this.lastState = now;
    const s = this.state();
    this.stateCbs.forEach((cb) => cb(s));
  }

  private readonly noticeTimes = new Map<string, number>();
  private throttledNotice(key: string, msg: string): void {
    const now = performance.now();
    if (now - (this.noticeTimes.get(key) ?? -1e9) < 4000) return;
    this.noticeTimes.set(key, now);
    this.notice(msg);
  }

  private emitEcology(): void {
    const e = this.currentEcology();
    this.ecoCbs.forEach((cb) => cb(e));
  }

  private notice(msg: string): void {
    this.noticeCbs.forEach((cb) => cb(msg));
  }
}

// ------------------------------------------------------------------ info cards (provenance §4, terrain part)

function flagCard(name: FlagName) {
  return { name, ...FLAG_INFO[name] };
}

export function terrainCard(r: InspectResult, water: boolean, aftermath: Aftermath | null = null): InfoCard {
  const level = water ? Level.GENERATED : levelOf("terrain", r.flags, r.strength);
  const names = [...new Set([...r.flagNames, ...(water ? [] : r.biomeFlagNames)])];
  const flags = names.map((n) => flagCard(n as FlagName));
  const lines = [
    { label: "Source cell", value: `PaleoDEM 0.1° cell at ${fmtLat(r.cellLat)}, ${fmtLon(r.cellLon)}: ${fmtM(r.source)}` },
    { label: "Height here", value: fmtM(r.h) },
    { label: "Smooth surface", value: `${fmtM(r.smooth)} (interpolated from the DEM, no invented detail)` },
    { label: "Generated detail", value: `${r.generated >= 0 ? "+" : "−"}${Math.abs(r.generated).toFixed(1)} m (${Math.round(r.strength * 100)}% of the local amplitude, ±${r.amp.toFixed(0)} m)` },
    { label: "Terrain class", value: r.className },
  ];
  const b = r.biome, c = b.climate;
  const tSrc = `model: Scotese et al. (2021) grid for ${r.tempSource.age} Ma${r.tempSource.age !== r.sliceAge ? `, ${r.tempSource.override ? "substituted for this slice (see the globe legend)" : "the nearest interval"}` : ""}, corrected for height`;
  if (!water) {
    lines.unshift({ label: "Levels", value: `shape ${LEVEL_NAMES[level]} · ground cover inferred · plants inferred` });
    lines.push(
      { label: "Ground cover", value: `${b.weights.map((w) => `${BIOME_NAMES[w.biome]} ${Math.round(w.weight * 100)}%`).join(", ")} (inferred from modelled climate and rules)` },
      { label: "Plants expected", value: aftermath?.phase === "impactWinter"
        ? "none living: standing dead trees only"
        : `${topPlants(b.plantMix).map(([k, v]) => `${PLANT_NAMES[k]} ${Math.round(v * 100)}%`).join(", ")} (${plantSource(b.plantMix)})` },
      { label: "Vegetation density", value: `${Math.round(b.vegDensity * 100)}%` },
    );
  }
  lines.push(
    { label: "Temperature", value: `${c.temperatureC.toFixed(1)} °C mean annual (${tSrc})` },
    { label: "Precipitation", value: `${Math.round(c.precipMmYr).toLocaleString("en-GB")} mm/yr (model: HadCM3L, not proxy-adjusted) · ${c.aridity < 0.5 ? "desert" : c.aridity < 1 ? "semi-arid" : "humid"} by the Köppen threshold` },
  );
  if (aftermath?.phase === "impactWinter") {
    lines.push({ label: "Aftermath", value: `Impact Winter, year ${aftermath.year}: ${impactWinterCooling(aftermath.year).toFixed(0)} °C colder than the grid (Brugger, Feulner and Petri 2017)` });
  } else if (aftermath) {
    lines.push({ label: "Aftermath", value: "Fern Spike, roughly 1,000–20,000 years after the impact (Vajda et al. 2004)" });
  }
  if (water) {
    lines.unshift({ label: "Sea surface", value: "Drawn at 0 m. Where the sea is comes from the DEM; the water itself (colour, surface) is generated." });
  }
  return {
    kind: water ? "water" : "terrain",
    title: water ? "Sea" : "Ground",
    level, levelName: LEVEL_NAMES[level],
    lines, flags, lat: r.lat, lon: r.lon,
  };
}

export function fmtLat(v: number): string { return `${Math.abs(v).toFixed(2)}°${v >= 0 ? "N" : "S"}`; }
export function fmtLon(v: number): string { return `${Math.abs(v).toFixed(2)}°${v >= 0 ? "E" : "W"}`; }
export function fmtM(v: number): string { return `${v < 0 ? "−" : ""}${Math.abs(Math.round(v)).toLocaleString("en-GB")} m`; }
export function fmtHours(h: number): string {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

export { F };

function plantSource(m: import("../biome/plants").PlantMix): string {
  const e = m.evidence;
  if (!e) return m.source === "prior" ? "age-aware prior" : "nearby plant fossils";
  if (e.count === 0) return "age-aware prior: no plant fossils within 500 km in this slice";
  const near = e.nearestKm !== null ? `, nearest ${Math.round(e.nearestKm)} km` : "";
  return `${e.count} plant fossil occurrence${e.count === 1 ? "" : "s"} within 500 km${near}; ${Math.round(e.dataShare * 100)}% from fossils, the rest from the age-aware prior`;
}

// ------------------------------------------------------------------ organism cards (provenance §4)

const pbdbOcc = (id: number) => `https://paleobiodb.org/data1.2/occs/single.json?id=${id}&show=class,coords,env`;
const pbdbRef = (id: number) => `https://paleobiodb.org/data1.2/refs/single.json?id=${id}&show=both`;

export function animalCard(a: LiveAnimal): InfoCard {
  const t = a.taxon;
  const level = levelOf("animal", a.flags);
  const boosted = (a.flags & F.DENSITY_BOOSTED) !== 0;
  const lines = [
    { label: "Aspects", value: `presence ${LEVEL_NAMES[level]} · size inferred · colour generated · pose and behaviour generated` },
    { label: "Body plan", value: `${t.planLabel} (generic model, not this species' anatomy)` },
    { label: "Name", value: `${t.name} (${t.rank})${t.species.length ? `: ${t.species.slice(0, 3).join(", ")}${t.species.length > 3 ? "…" : ""}` : ""}` },
    { label: "Evidence", value: `${t.evidence.count} PBDB occurrence${t.evidence.count === 1 ? "" : "s"}, nearest ${Math.round(t.evidence.nearestKm)} km${t.evidence.straddlesKpg ? "; an age range crosses the K–Pg boundary" : ""}` },
    { label: "Size", value: `${a.lengthM.toFixed(1)} m long (${t.lengthSource === "rule" ? "from a curated rule" : "body-plan default"}), ~${t.massKg.toLocaleString("en-GB")} kg (estimated)` },
    { label: "Density", value: `realistic ≈ 1 per ${fmtArea(1 / Math.max(t.realisticPerKm2, 1e-9))} (Damuth 1981; Marshall et al. 2021)${boosted ? ". Shown for illustration (representative fauna)." : ""}` },
  ];
  const links = [{ label: "PBDB occurrence", url: pbdbOcc(t.evidence.occurrenceIds[0]!) }];
  if (t.evidence.refIds[0] !== undefined) links.push({ label: "Reference", url: pbdbRef(t.evidence.refIds[0]) });
  const flags = flagNames(a.flags).map((n) => flagCard(n));
  return { kind: "animal", title: t.name, level, levelName: LEVEL_NAMES[level], lines, links, flags, lat: a.lat, lon: a.lon };
}

export function plantCard(p: PlantPick, aftermath: Aftermath | null): InfoCard {
  const mix = p.tile.biome?.plantMix;
  const flags = p.tile.biome?.flags[0] ?? 0;
  const level = levelOf("plant", flags);
  const name = p.plan === "snag" ? "dead tree" : PLANT_NAMES[p.plan];
  const lines = [
    { label: "Aspects", value: `presence ${LEVEL_NAMES[level]} · position, size and shape generated · colour generated` },
    { label: "What it is", value: p.plan === "snag"
      ? (aftermath?.phase === "impactWinter" ? "a standing dead tree, killed in the Impact Winter (Vajda et al. 2004; Brugger, Feulner and Petri 2017)" : "a decaying snag from the forest killed by the impact")
      : `one of the ${name} expected here; the body-plan model is generic` },
  ];
  if (aftermath) {
    lines.push({ label: "Aftermath", value: `${aftermath.phase === "impactWinter" ? "Impact Winter" : "Fern Spike"}: plant mix and die-off reconstructed, not observed (see Aftermath notes)` });
  }
  if (mix && p.plan !== "snag") {
    lines.push({ label: "Plant mix here", value: `${topPlants(mix, 4).map(([k, v]) => `${PLANT_NAMES[k]} ${Math.round(v * 100)}%`).join(", ")} (${mix.evidence?.count ? `${mix.evidence.count} plant fossils within 500 km` : "age-aware prior"})` });
  }
  return { kind: "plant", title: name.charAt(0).toUpperCase() + name.slice(1), level, levelName: LEVEL_NAMES[level], lines,
    flags: flagNames(flags & (F.PLANTS_FROM_DATA | F.PLANTS_FROM_PRIOR | F.AFTERMATH_RECON)).map((n) => flagCard(n)), lat: p.lat, lon: p.lon };
}
