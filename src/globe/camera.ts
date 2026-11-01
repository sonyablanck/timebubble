import * as THREE from "three";
import { latLonToVec3, wrapLon } from "./geo";

// globe/ §4. The camera orbits the fixed globe at (lat, lon, distance), always
// looking at the centre with north up. Keeping the camera in palaeo-coordinates
// is what makes the continents drift under you when the slice changes (§7).

export const MIN_DIST = 1.3;
export const MAX_DIST = 6;
export const DEFAULT_VIEW: CameraView = { lat: 20, lon: 0, dist: 3 };
const MAX_LAT = 85;

export interface CameraView { lat: number; lon: number; dist: number }

export class OrbitCamera {
  view: CameraView;
  private vLat = 0;     // degrees per second, decaying (damping)
  private vLon = 0;
  private flight: { from: CameraView; to: CameraView; t0: number; dur: number; resolve: () => void } | null = null;

  constructor(readonly camera: THREE.PerspectiveCamera, initial: CameraView = DEFAULT_VIEW) {
    this.view = { ...initial };
    this.apply();
  }

  /** Degrees of rotation per pixel of drag: slower when zoomed in. */
  degPerPixel(viewportHeight: number): number {
    return ((this.view.dist - 1) * 60) / Math.max(viewportHeight, 1);
  }

  drag(dxPx: number, dyPx: number, viewportHeight: number, dt: number): void {
    const k = this.degPerPixel(viewportHeight);
    this.set({ lat: this.view.lat + dyPx * k, lon: this.view.lon - dxPx * k });
    if (dt > 0) {
      this.vLat = (dyPx * k) / dt;
      this.vLon = (-dxPx * k) / dt;
    }
  }

  release(): void { /* velocity carries on and decays in update() */ }

  stop(): void {
    this.vLat = 0;
    this.vLon = 0;
  }

  rotate(dLat: number, dLon: number): void {
    this.stop();
    this.set({ lat: this.view.lat + dLat, lon: this.view.lon + dLon });
  }

  zoom(factor: number): void {
    this.set({ dist: this.view.dist * factor });
  }

  set(v: Partial<CameraView>): void {
    this.view = {
      lat: Math.max(-MAX_LAT, Math.min(MAX_LAT, v.lat ?? this.view.lat)),
      lon: wrapLon(v.lon ?? this.view.lon),
      dist: Math.max(MIN_DIST, Math.min(MAX_DIST, v.dist ?? this.view.dist)),
    };
    this.apply();
  }

  /** Animate to a view; resolves when done. `instant` for reduced motion. */
  flyTo(to: Partial<CameraView>, durationMs: number, instant: boolean): Promise<void> {
    this.stop();
    const target = { ...this.view, ...to };
    if (instant || durationMs <= 0) {
      this.set(target);
      return Promise.resolve();
    }
    // take the short way round in longitude
    const dLon = wrapLon(target.lon - this.view.lon);
    target.lon = this.view.lon + dLon;
    this.flight?.resolve();
    return new Promise((resolve) => {
      this.flight = { from: { ...this.view }, to: target, t0: performance.now(), dur: durationMs, resolve };
    });
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  /** Advance damping or a flight. Returns true if the view changed. */
  update(dt: number, now = performance.now()): boolean {
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (now - f.t0) / f.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
      this.set({
        lat: f.from.lat + (f.to.lat - f.from.lat) * e,
        lon: f.from.lon + (f.to.lon - f.from.lon) * e,
        dist: f.from.dist + (f.to.dist - f.from.dist) * e,
      });
      if (t >= 1) {
        this.flight = null;
        f.resolve();
      }
      return true;
    }
    if (Math.abs(this.vLat) < 0.01 && Math.abs(this.vLon) < 0.01) return false;
    this.set({ lat: this.view.lat + this.vLat * dt, lon: this.view.lon + this.vLon * dt });
    const decay = Math.exp(-dt * 5);
    this.vLat *= decay;
    this.vLon *= decay;
    return true;
  }

  private apply(): void {
    const [x, y, z] = latLonToVec3(this.view.lat, this.view.lon, this.view.dist);
    this.camera.position.set(x, y, z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
  }
}
