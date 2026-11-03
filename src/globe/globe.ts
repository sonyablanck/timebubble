import * as THREE from "three";
import { binKey, type DataStore, type EcologyIndex, type Grid, type Manifest, type SliceHandle } from "../data";
import { DEFAULT_VIEW, OrbitCamera, type CameraView } from "./camera";
import { fossilDots, GROUP_COLOURS, type FossilDot } from "./fossils";
import { latLonToVec3, nearestCell, raySphere, vec3ToLatLon, type Vec3 } from "./geo";
import { RELIEF_FRAGMENT, RELIEF_VERTEX, SEA_FRAGMENT, SEA_VERTEX } from "./shaders";
import { sliceTextures, type SliceTextures } from "./textures";
import { buildTimeline, nearestIndex, step, type Timeline } from "./timeline";

// globe/ PSEUDOCODE §0–§10. Owns the WebGL scene for the globe view.

export type GlobeLayer = "relief" | "temperature" | "precipitation" | "fossils" | "graticule" | "provenance";

export interface HoverInfo {
  lat: number;
  lon: number;
  elevationM: number;           // 1° DEM (data)
  isLand: boolean;
  temperatureC: number;         // 1° grid (inferred, model)
  precipitationMmYr: number;    // 1° grid (inferred, model)
  coastDistKm: number;          // continentality grid
  fossilsAvailable: boolean;
  occurrencesInBin: number;
  topTaxa: string[];
}

export interface TileRequest { sliceAge: number; lat: number; lon: number }

export interface GlobeOptions {
  reducedMotion?: boolean;
  initialAge?: number;
  initialView?: CameraView;
  initialLayers?: GlobeLayer[];
  initialExaggeration?: number;
}

export const DEFAULT_LAYERS: GlobeLayer[] = ["relief", "fossils", "graticule"];
export const DEFAULT_EXAGGERATION = 40;
const CROSSFADE_MS = 400;
const FLY_MS = 1200;
const IDLE_ROTATE_AFTER_MS = 20_000;
const IDLE_ROTATE_DEG_PER_S = 2;
const MAX_TEXTURE_SLICES = 3;
const CLICK_SLOP_PX = 4;

type Listener<T> = (v: T) => void;

interface Loaded {
  handle: SliceHandle;
  elev: Grid;
  temp: Grid;
  prec: Grid;
  cont: Grid;
}

export class Globe {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  private orbit!: OrbitCamera;
  private uniforms!: Record<string, THREE.IUniform>;
  private relief!: THREE.Mesh;
  private sea!: THREE.Mesh;
  private graticule = new THREE.Group();
  private fossilMesh: THREE.InstancedMesh | null = null;
  private labelLayer!: HTMLDivElement;
  private labels: { el: HTMLDivElement; lat: number }[] = [];

  private store!: DataStore;
  private manifest!: Manifest;
  timeline!: Timeline;
  private index = -1;
  private loaded: Loaded | null = null;
  private eco: EcologyIndex | null = null;
  private dots: FossilDot[] = [];
  private textures = new Map<number, SliceTextures>();
  private gridPromises = new Map<number, Promise<Loaded>>();
  private sliceToken = 0;
  private fadeStart = -1;

  private layers = new Set<GlobeLayer>(DEFAULT_LAYERS);
  private exaggeration = DEFAULT_EXAGGERATION;
  private reducedMotion = false;
  private pinned: { lat: number; lon: number } | null = null;
  /** A searched place's marker and name, drawn over the canvas (places/ §3); hidden for clicked pins. */
  private pinLabel!: HTMLDivElement;
  private pinMesh!: THREE.Mesh;

  private dirty = true;
  private lastInput = performance.now();
  private lastFrame = performance.now();
  private raf = 0;
  private active = true;
  private resizeObs: ResizeObserver | null = null;
  private disposers: (() => void)[] = [];

  private hoverCbs: Listener<HoverInfo | null>[] = [];
  private pickCbs: Listener<HoverInfo>[] = [];
  private enterCbs: Listener<TileRequest>[] = [];
  private sliceCbs: Listener<SliceHandle>[] = [];
  private viewCbs: Listener<CameraView>[] = [];

  /** False if WebGL2 is unavailable (ui/ §8 shows a static explanation). */
  static supported(): boolean {
    try {
      return !!document.createElement("canvas").getContext("webgl2");
    } catch {
      return false;
    }
  }

  async mount(canvas: HTMLCanvasElement, store: DataStore, opts: GlobeOptions = {}): Promise<void> {
    this.store = store;
    this.reducedMotion = !!opts.reducedMotion;
    if (opts.initialLayers) this.layers = new Set(opts.initialLayers);
    if (opts.initialExaggeration) this.exaggeration = opts.initialExaggeration;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0b0e14, 1);
    this.orbit = new OrbitCamera(this.camera, opts.initialView ?? DEFAULT_VIEW);

    this.buildScene(canvas);
    this.bindInput(canvas);
    this.resize();
    const parent = canvas.parentElement ?? document.body;
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(parent);

    this.manifest = await store.manifest();
    this.timeline = buildTimeline(this.manifest);
    await this.setSlice(opts.initialAge ?? 150);
    this.loop();
  }

  // ------------------------------------------------------------------ scene

  private placeholder(): THREE.DataTexture {
    const t = new THREE.DataTexture(new Uint16Array([0]), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
    t.needsUpdate = true;
    return t;
  }

  private buildScene(canvas: HTMLCanvasElement): void {
    const empty = this.placeholder();
    this.uniforms = {
      elevA: { value: empty }, elevB: { value: empty }, fade: { value: 0 },
      tempTex: { value: empty }, precTex: { value: empty },
      gridGeo: { value: new THREE.Vector4(90, -180, 1, 0) }, gridSize: { value: new THREE.Vector2(360, 181) },
      exaggeration: { value: this.exaggeration },
      showTemp: { value: 0 }, showPrec: { value: 0 }, showProvenance: { value: 0 },
      lightDir: { value: new THREE.Vector3(0, 0, 1) },
    };
    const common = { uniforms: this.uniforms, glslVersion: THREE.GLSL3 };
    this.relief = new THREE.Mesh(new THREE.SphereGeometry(1, 512, 256),
      new THREE.ShaderMaterial({ ...common, vertexShader: RELIEF_VERTEX, fragmentShader: RELIEF_FRAGMENT }));
    this.sea = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128),
      new THREE.ShaderMaterial({ ...common, vertexShader: SEA_VERTEX, fragmentShader: SEA_FRAGMENT,
        transparent: true, depthWrite: true }));   // writes depth so lines behind the sea are hidden
    this.sea.renderOrder = 1;
    this.scene.add(this.relief, this.sea);

    this.buildGraticule();
    this.scene.add(this.graticule);

    this.pinMesh = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.pinMesh.visible = false;
    this.pinMesh.renderOrder = 3;
    this.scene.add(this.pinMesh);

    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "globe-labels";
    this.labelLayer.setAttribute("aria-hidden", "true");
    canvas.parentElement?.appendChild(this.labelLayer);
    for (let lat = -75; lat <= 75; lat += 15) {
      const el = document.createElement("div");
      el.className = "globe-label" + (lat === 0 ? " globe-label--equator" : "");
      el.textContent = lat === 0 ? "0°" : `${Math.abs(lat)}°${lat > 0 ? "N" : "S"}`;
      this.labelLayer.appendChild(el);
      this.labels.push({ el, lat });
    }
    this.pinLabel = document.createElement("div");
    this.pinLabel.className = "globe-pin";
    this.pinLabel.style.display = "none";
    this.labelLayer.appendChild(this.pinLabel);
    this.applyLayers();
  }

  private buildGraticule(): void {
    const R = 1.0015;
    const normal: number[] = [];
    const strong: number[] = [];
    const seg = (out: number[], a: Vec3, b: Vec3) => out.push(...a, ...b);
    for (let lat = -75; lat <= 75; lat += 15) {
      const out = lat === 0 ? strong : normal;
      for (let lon = -180; lon < 180; lon += 2) seg(out, latLonToVec3(lat, lon, R), latLonToVec3(lat, lon + 2, R));
    }
    for (const lat of [23.44, -23.44]) {            // tropics, for orientation (modern obliquity)
      for (let lon = -180; lon < 180; lon += 4) seg(strong, latLonToVec3(lat, lon, R), latLonToVec3(lat, lon + 2, R));
    }
    for (let lon = -180; lon < 180; lon += 15) {
      for (let lat = -88; lat < 88; lat += 2) seg(normal, latLonToVec3(lat, lon, R), latLonToVec3(lat + 2, lon, R));
    }
    const mk = (pts: number[], color: number, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      l.renderOrder = 2;
      return l;
    };
    this.graticule.add(mk(normal, 0xffffff, 0.18), mk(strong, 0xfff3c4, 0.55));
  }

  private buildFossilDots(): void {
    if (this.fossilMesh) {
      this.scene.remove(this.fossilMesh);
      this.fossilMesh.geometry.dispose();
      (this.fossilMesh.material as THREE.Material).dispose();
      this.fossilMesh = null;
    }
    if (this.dots.length === 0) return;
    const geo = new THREE.CircleGeometry(1, 20);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geo, mat, this.dots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const zAxis = new THREE.Vector3(0, 0, 1);
    const surface = 1 + (this.exaggeration * 4000) / 6_371_000 + 0.004;   // above the highest relief
    this.dots.forEach((d, i) => {
      p.set(...latLonToVec3(d.lat, d.lon, surface));
      q.setFromUnitVectors(zAxis, p.clone().normalize());
      const r = 0.006 * d.radius;
      s.set(r, r, r);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, new THREE.Color(GROUP_COLOURS[d.group]));
    });
    mesh.renderOrder = 4;
    this.fossilMesh = mesh;
    this.fossilMesh.visible = this.layers.has("fossils");
    this.scene.add(mesh);
  }

  // ------------------------------------------------------------------ slices

  private loadGrids(age: number): Promise<Loaded> {
    let p = this.gridPromises.get(age);
    if (!p) {
      p = (async () => {
        const handle = await this.store.slice(age);
        const [elev, temp, prec, cont] = await Promise.all([
          handle.globe(), handle.temperature(), handle.precipitation(), handle.continentality()]);
        return { handle, elev, temp, prec, cont };
      })();
      this.gridPromises.set(age, p);
      p.catch(() => this.gridPromises.delete(age));
    }
    return p;
  }

  private texturesFor(l: Loaded): SliceTextures {
    let t = this.textures.get(l.handle.age);
    if (!t) {
      t = sliceTextures(l.handle.age, l.elev, l.temp, l.prec);
      this.textures.set(l.handle.age, t);
    }
    return t;
  }

  /** Snap to the nearest slice and show it. The readout, picking and URL switch at once. */
  async setSlice(age: number): Promise<void> {
    const idx = nearestIndex(this.timeline, age);
    if (idx === this.index) return;
    const token = ++this.sliceToken;
    const targetAge = this.timeline.ticks[idx]!.age;
    const l = await this.loadGrids(targetAge);
    if (token !== this.sliceToken) return;                 // a newer request won

    const previous = this.loaded ? this.textures.get(this.loaded.handle.age) : undefined;
    this.index = idx;
    this.loaded = l;
    const tex = this.texturesFor(l);
    const g = l.elev;
    this.uniforms.gridGeo!.value.set(g.latNorth, g.lonWest, g.res, 0);
    this.uniforms.gridSize!.value.set(g.width, g.height);
    this.uniforms.tempTex!.value = tex.temperature;
    this.uniforms.precTex!.value = tex.precipitation;
    if (previous && !this.reducedMotion) {
      this.uniforms.elevA!.value = previous.elevation;    // visual transition only (DESIGN A6)
      this.uniforms.elevB!.value = tex.elevation;
      this.uniforms.fade!.value = 0;
      this.fadeStart = performance.now();
    } else {
      this.uniforms.elevA!.value = tex.elevation;
      this.uniforms.elevB!.value = tex.elevation;
      this.uniforms.fade!.value = 0;
      this.fadeStart = -1;
    }
    this.eco = null;
    this.dots = [];
    this.buildFossilDots();
    this.sliceCbs.forEach((cb) => cb(l.handle));
    this.dirty = true;

    l.handle.ecology().then((eco) => {
      if (token !== this.sliceToken) return;
      this.eco = eco;
      this.dots = fossilDots(eco);
      this.buildFossilDots();
      this.dirty = true;
      this.ecoCbs.forEach((cb) => cb(eco.available));
    }).catch((e) => console.warn("[globe] ecology unavailable:", e));

    if (this.reducedMotion || !previous) this.afterFade();
  }

  /** Step one slice older (−1) or younger (+1). */
  stepSlice(direction: -1 | 1): Promise<void> {
    return this.setSlice(this.timeline.ticks[step(this.timeline, this.index, direction)]!.age);
  }

  private afterFade(): void {
    this.fadeStart = -1;
    const tex = this.loaded ? this.textures.get(this.loaded.handle.age) : undefined;
    if (tex) {
      this.uniforms.elevA!.value = tex.elevation;
      this.uniforms.elevB!.value = tex.elevation;
      this.uniforms.fade!.value = 0;
    }
    this.evictAndPrefetch();
  }

  private evictAndPrefetch(): void {
    const keep = new Set<number>();
    for (const d of [0, -1, 1]) {
      const t = this.timeline.ticks[this.index + d];
      if (t) keep.add(t.age);
    }
    for (const [age, t] of this.textures) {
      if (!keep.has(age) && this.textures.size > MAX_TEXTURE_SLICES) {
        t.dispose();
        this.textures.delete(age);
        this.gridPromises.delete(age);
      }
    }
    for (const age of keep) {
      if (!this.textures.has(age)) {
        this.loadGrids(age).then((l) => {
          if (keep.has(age) && this.textures.size < MAX_TEXTURE_SLICES) this.texturesFor(l);
        }).catch(() => { /* prefetch is best effort */ });
      }
    }
  }

  get currentAge(): number {
    return this.timeline.ticks[this.index]?.age ?? NaN;
  }

  get currentIndex(): number {
    return this.index;
  }

  // ------------------------------------------------------------------ layers, view

  setLayer(layer: GlobeLayer, on: boolean): void {
    if (on) this.layers.add(layer); else this.layers.delete(layer);
    // the two climate layers share the blend slot: showing one hides the other
    if (on && layer === "temperature") this.layers.delete("precipitation");
    if (on && layer === "precipitation") this.layers.delete("temperature");
    this.applyLayers();
  }

  getLayers(): GlobeLayer[] {
    return [...this.layers];
  }

  private applyLayers(): void {
    this.uniforms.showTemp!.value = this.layers.has("temperature") ? 1 : 0;
    this.uniforms.showPrec!.value = this.layers.has("precipitation") ? 1 : 0;
    this.uniforms.showProvenance!.value = this.layers.has("provenance") ? 1 : 0;
    this.graticule.visible = this.layers.has("graticule");
    for (const { el } of this.labels) el.style.display = this.layers.has("graticule") ? "" : "none";   // the pin's label stays
    if (this.fossilMesh) this.fossilMesh.visible = this.layers.has("fossils");
    this.relief.visible = true;                          // relief is the base; always drawn
    this.dirty = true;
  }

  setExaggeration(x: number): void {
    this.exaggeration = Math.max(1, Math.min(80, x));
    this.uniforms.exaggeration!.value = this.exaggeration;
    this.buildFossilDots();
    this.dirty = true;
  }

  getExaggeration(): number {
    return this.uniforms.exaggeration!.value as number;
  }

  getView(): CameraView {
    return { ...this.orbit.view };
  }

  setView(v: Partial<CameraView>): void {
    this.orbit.set(v);
    this.viewChanged();
  }

  async flyTo(lat: number, lon: number, dist = 1.6): Promise<void> {
    this.lastInput = performance.now();
    await this.orbit.flyTo({ lat, lon, dist }, FLY_MS, this.reducedMotion);
    this.viewChanged();
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  /** Pin a palaeo-position; a `label` (a searched place's name) also draws a marker and the name. */
  pin(lat: number, lon: number, label?: string): void {
    this.pinned = { lat, lon };
    this.pinLabel.textContent = label ?? "";
    this.pinLabel.dataset.on = label ? "1" : "";
    this.dirty = true;
  }

  getPin(): { lat: number; lon: number } | null { return this.pinned ? { ...this.pinned } : null; }

  unpin(): void {
    this.pinned = null;
    this.pinLabel.dataset.on = "";
    this.dirty = true;
  }

  /** Pause (false) or resume (true) the globe's frame loop and keyboard handling, e.g. while walking. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    cancelAnimationFrame(this.raf);
    if (active) {
      this.lastFrame = performance.now();
      this.dirty = true;
      this.loop();
    }
  }

  get isActive(): boolean { return this.active; }

  /** Hand a tile request to terrain/ (globe §6). */
  enterTile(lat: number, lon: number): void {
    const req = { sliceAge: this.currentAge, lat: Math.max(-89.5, Math.min(89.5, lat)), lon };
    this.enterCbs.forEach((cb) => cb(req));
  }

  onHover(cb: Listener<HoverInfo | null>): void { this.hoverCbs.push(cb); }
  onPick(cb: Listener<HoverInfo>): void { this.pickCbs.push(cb); }
  onEnterTile(cb: Listener<TileRequest>): void { this.enterCbs.push(cb); }
  /** Called when the current slice's fossils have loaded (true) or are absent (false). */
  onFossilsLoaded(cb: Listener<boolean>): void { this.ecoCbs.push(cb); }
  private readonly ecoCbs: Listener<boolean>[] = [];
  onSliceChange(cb: Listener<SliceHandle>): void { this.sliceCbs.push(cb); }
  onViewChange(cb: Listener<CameraView>): void { this.viewCbs.push(cb); }

  private viewChanged(): void {
    this.dirty = true;
    const v = this.getView();
    this.viewCbs.forEach((cb) => cb(v));
  }

  // ------------------------------------------------------------------ hover and picking

  /** Palaeo lat/lon under a canvas pixel, or null if the ray misses the globe. */
  pick(clientX: number, clientY: number): { lat: number; lon: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const hit = raySphere([o.x, o.y, o.z], [d.x, d.y, d.z]);
    return hit ? vec3ToLatLon(hit) : null;
  }

  /** Pick the point at the centre of the view, as a click there would (keyboard users, ui §9). */
  pickCentre(): void {
    const { lat, lon } = this.orbit.view;
    const info = this.hoverInfo(lat, lon);
    if (info) { this.pin(lat, lon); this.pickCbs.forEach((cb) => cb(info)); }
  }

  /** Screen position (CSS px, relative to the canvas) of a lat/lon on the unit sphere. */
  project(lat: number, lon: number): { x: number; y: number; visible: boolean } {
    const p = new THREE.Vector3(...latLonToVec3(lat, lon));
    const facing = p.dot(this.camera.position.clone().sub(p)) > 0;
    p.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: ((p.x + 1) / 2) * rect.width, y: ((1 - p.y) / 2) * rect.height, visible: facing };
  }

  hoverInfo(lat: number, lon: number): HoverInfo | null {
    const l = this.loaded;
    if (!l) return null;
    const [r, c] = nearestCell(l.elev, lat, lon);
    const elevationM = l.elev.at(r, c);
    const bin = binKey(lat, lon);
    const dot = this.dots.find((d) => d.bin === bin);
    return {
      lat, lon,
      elevationM,
      isLand: elevationM >= 0,
      temperatureC: l.temp.valueAt(r, c),
      precipitationMmYr: l.prec.valueAt(r, c) * 365.25,
      coastDistKm: l.cont.at(r, c),
      fossilsAvailable: !!this.eco?.available,
      occurrencesInBin: dot?.count ?? 0,
      topTaxa: dot?.topTaxa ?? [],
    };
  }

  // ------------------------------------------------------------------ input

  private bindInput(canvas: HTMLCanvasElement): void {
    let dragging = false, moved = 0, lastX = 0, lastY = 0, lastT = 0;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on(canvas, "pointerdown", (e) => {
      dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; lastT = performance.now();
      canvas.setPointerCapture(e.pointerId);
      this.orbit.stop();
      this.lastInput = performance.now();
    });
    on(canvas, "pointermove", (e) => {
      this.lastInput = performance.now();
      if (dragging) {
        const now = performance.now();
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        this.orbit.drag(dx, dy, canvas.clientHeight, (now - lastT) / 1000);
        lastX = e.clientX; lastY = e.clientY; lastT = now;
        this.viewChanged();
      }
      const ll = this.pick(e.clientX, e.clientY);
      const info = ll ? this.hoverInfo(ll.lat, ll.lon) : null;
      this.hoverCbs.forEach((cb) => cb(info));
    });
    on(canvas, "pointerup", (e) => {
      dragging = false;
      if (moved <= CLICK_SLOP_PX) {
        this.orbit.stop();
        const ll = this.pick(e.clientX, e.clientY);
        if (ll) {
          const info = this.hoverInfo(ll.lat, ll.lon);
          if (info) { this.pin(ll.lat, ll.lon); this.pickCbs.forEach((cb) => cb(info)); }
        }
      }
    });
    on(canvas, "pointerleave", () => this.hoverCbs.forEach((cb) => cb(null)));
    on(canvas, "wheel", (e) => {
      e.preventDefault();
      this.lastInput = performance.now();
      this.orbit.zoom(Math.exp(e.deltaY * 0.001));
      this.viewChanged();
    }, { passive: false });
    on(window, "keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, select, textarea, button, [role=slider], [contenteditable]"))) return;
      if (e.ctrlKey || e.metaKey || e.altKey || !this.active) return;
      this.lastInput = performance.now();
      const stepDeg = 5;
      switch (e.key) {
        case "ArrowLeft": this.orbit.rotate(0, -stepDeg); break;
        case "ArrowRight": this.orbit.rotate(0, stepDeg); break;
        case "ArrowUp": this.orbit.rotate(stepDeg, 0); break;
        case "ArrowDown": this.orbit.rotate(-stepDeg, 0); break;
        case "+": case "=": this.orbit.zoom(1 / 1.15); break;
        case "-": case "_": this.orbit.zoom(1.15); break;
        case "[": void this.stepSlice(-1); return;
        case "]": void this.stepSlice(1); return;
        case "r": case "R": this.orbit.set({ lat: DEFAULT_VIEW.lat, dist: DEFAULT_VIEW.dist }); break;
        case "Enter": case " ":
          // ui §9: with the globe focused, Enter picks the place at the centre of the view (keyboard picking)
          if (t !== canvas) return;
          this.pickCentre();
          e.preventDefault();
          return;
        default: return;
      }
      e.preventDefault();
      this.viewChanged();
    });
  }

  private resize(): void {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    const w = parent?.clientWidth ?? window.innerWidth, h = parent?.clientHeight ?? window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // ------------------------------------------------------------------ frame loop

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.fadeStart >= 0) {
      const t = Math.min(1, (now - this.fadeStart) / CROSSFADE_MS);
      this.uniforms.fade!.value = t;
      this.dirty = true;
      if (t >= 1) this.afterFade();
    }
    if (this.orbit.update(dt, now)) this.viewChanged();
    if (!this.reducedMotion && !this.orbit.flying && now - this.lastInput > IDLE_ROTATE_AFTER_MS) {
      this.orbit.set({ lon: this.orbit.view.lon + IDLE_ROTATE_DEG_PER_S * dt });
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.render();
  };

  /** Draw one frame now (also used by tests and screenshots). */
  render(): void {
    // light from over the viewer's upper left, so the globe always reads as lit
    const camDir = this.camera.position.clone().normalize();
    const right = new THREE.Vector3().crossVectors(this.camera.up, camDir).normalize();
    const up = new THREE.Vector3().crossVectors(camDir, right).normalize();
    (this.uniforms.lightDir!.value as THREE.Vector3).copy(camDir).addScaledVector(up, 0.55).addScaledVector(right, -0.45).normalize();

    if (this.pinned) {
      const surface = 1 + Math.max(0, this.hoverInfo(this.pinned.lat, this.pinned.lon)?.elevationM ?? 0) * this.exaggeration / 6_371_000 + 0.003;
      this.pinMesh.position.set(...latLonToVec3(this.pinned.lat, this.pinned.lon, surface));
      this.pinMesh.visible = true;
    } else {
      this.pinMesh.visible = false;
    }
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  private placeLabels(): void {
    if (this.pinned && this.pinLabel.dataset.on) {
      const p = this.project(this.pinned.lat, this.pinned.lon);
      this.pinLabel.style.display = p.visible ? "" : "none";
      this.pinLabel.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    } else {
      this.pinLabel.style.display = "none";
    }
    if (!this.layers.has("graticule")) return;
    // put latitude labels along the meridian 25° west of the view centre
    const lon = this.orbit.view.lon - 25;
    for (const { el, lat } of this.labels) {
      const p = this.project(lat, lon);
      el.style.display = p.visible ? "" : "none";
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    this.disposers.forEach((d) => d());
    this.textures.forEach((t) => t.dispose());
    this.renderer.dispose();
    this.labelLayer.remove();
  }
}
