// Sea floor depth around the player, for the water shader (render §6b). The floor heights are the
// terrain's own (data/inferred/generated as labelled there); the colour ramp, ripples and foam drawn
// from them are generated looks.

import * as THREE from "three";

/** Texels per side and the half-width covered (m): ~47 m per texel. */
export const SEA_RES = 128;
export const SEA_HALF_M = 3000;
/** Refresh once the player is this far from the texture centre. */
const RECENTRE_M = 900;

export interface SeaUniforms {
  u_seaTex: { value: THREE.DataTexture };
  u_seaRect: { value: THREE.Vector3 };   // centre x, centre z, half-width
  u_time: { value: number };
  u_motion: { value: number };
}

/** Floor height used where no tile is loaded yet (open, deep-looking water). */
export const UNKNOWN_FLOOR_M = -200;

export class SeaDepth {
  readonly uniforms: SeaUniforms;
  private readonly data = new Uint16Array(SEA_RES * SEA_RES);
  private readonly tex: THREE.DataTexture;
  private dirty = true;

  constructor(time: { value: number }, motion: { value: number }) {
    this.tex = new THREE.DataTexture(this.data, SEA_RES, SEA_RES, THREE.RedFormat, THREE.HalfFloatType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.data.fill(THREE.DataUtils.toHalfFloat(UNKNOWN_FLOOR_M));
    this.tex.needsUpdate = true;
    this.uniforms = { u_seaTex: { value: this.tex }, u_seaRect: { value: new THREE.Vector3(0, 0, SEA_HALF_M) }, u_time: time, u_motion: motion };
  }

  /** Tiles changed or the origin moved: rebuild on the next update. */
  invalidate(): void { this.dirty = true; }

  /**
   * Rebuild if needed. heightAt(x, z) returns the drawn floor height at a local position, or null
   * where nothing is loaded. Returns true if the texture was rebuilt.
   */
  update(px: number, pz: number, heightAt: (x: number, z: number) => number | null): boolean {
    const r = this.uniforms.u_seaRect.value;
    if (!this.dirty && Math.hypot(px - r.x, pz - r.y) < RECENTRE_M) return false;
    this.dirty = false;
    r.set(px, pz, SEA_HALF_M);
    fillDepth(this.data, px, pz, heightAt);
    this.tex.needsUpdate = true;
    return true;
  }

  /** Range of floor heights in the texture, for tests. */
  /** Range of loaded floor heights in the texture (unloaded texels left out), for tests. */
  stats(): { min: number; max: number; wetShare: number; loadedShare: number } {
    let min = Infinity, max = -Infinity, wet = 0, n = 0;
    for (const v of this.data) {
      const h = THREE.DataUtils.fromHalfFloat(v);
      if (h === UNKNOWN_FLOOR_M) continue;
      n++; min = Math.min(min, h); max = Math.max(max, h); if (h < 0) wet++;
    }
    return { min, max, wetShare: n ? wet / n : 0, loadedShare: n / this.data.length };
  }

  dispose(): void { this.tex.dispose(); }
}

/** Sample floor heights on the grid (row = z, column = x, texel centres). Exported for tests. */
export function fillDepth(out: Uint16Array, cx: number, cz: number, heightAt: (x: number, z: number) => number | null): void {
  const step = (2 * SEA_HALF_M) / SEA_RES;
  for (let j = 0; j < SEA_RES; j++) {
    const z = cz - SEA_HALF_M + (j + 0.5) * step;
    for (let i = 0; i < SEA_RES; i++) {
      const x = cx - SEA_HALF_M + (i + 0.5) * step;
      const h = heightAt(x, z);
      // land is clamped: only "how far above sea level" up to a few metres matters to the shader
      out[j * SEA_RES + i] = THREE.DataUtils.toHalfFloat(h === null ? UNKNOWN_FLOOR_M : Math.max(-4000, Math.min(50, h)));
    }
  }
}

/** Generated look: shallow water lighter and clearer, deep water darker and more opaque. Mirrors the GLSL. */
export function seaLook(depthM: number): { deepness: number; alpha: number; foamBand: number } {
  const d = Math.max(0, depthM);
  const deepness = 1 - Math.exp(-d / 14);
  return { deepness, alpha: 0.42 + 0.48 * deepness, foamBand: 1 - smooth(0, 1.8, d) };
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export const SEA_DECL = /* glsl */ `
uniform sampler2D u_seaTex;
uniform vec3 u_seaRect;
uniform float u_time;
uniform float u_motion;
varying vec2 vSeaXZ;
`;

/** Fragment code: sets diffuseColor from floor depth, adds foam at the shoreline. */
export const SEA_COLOUR_GLSL = /* glsl */ `
{
  vec2 suv = (vSeaXZ - u_seaRect.xy) / (2.0 * u_seaRect.z) + 0.5;
  float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
  float floorH = mix(${UNKNOWN_FLOOR_M.toFixed(1)}, texture2D(u_seaTex, suv).r, inside);
  float depth = max(0.0, -floorH);
  float deepness = 1.0 - exp(-depth / 14.0);
  vec3 shallow = vec3(0.10, 0.42, 0.40);   // linear; turquoise over sand
  vec3 deep = vec3(0.012, 0.075, 0.13);
  diffuseColor.rgb = mix(shallow, deep, deepness);
  diffuseColor.a = 0.42 + 0.48 * deepness;
  // foam: bands that run up the shore, broken by a cheap noise
  float band = 1.0 - smoothstep(0.0, 1.8, depth);
  vec2 q = vSeaXZ;
  float n = (sin(dot(q, vec2(0.061, 0.033))) + sin(dot(q, vec2(-0.027, 0.052)) + 1.7) + sin(dot(q, vec2(0.014, -0.041)) + 4.1)) / 3.0;
  float wave = 0.5 + 0.5 * sin(depth * 2.2 - u_time * 1.3 * u_motion + n * 3.0);
  float foam = band * (0.25 + 0.75 * smoothstep(0.6, 0.95, wave)) * (0.6 + 0.4 * n);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.88, 0.86), foam * 0.85);
  diffuseColor.a = max(diffuseColor.a, foam * 0.9);
}
`;

/** Fragment code after the normal is set: small ripples so the sun glints. */
export const SEA_NORMAL_GLSL = /* glsl */ `
{
  float t = u_time * u_motion;
  vec2 p = vSeaXZ;
  vec2 g = vec2(cos(p.x * 0.31 + t * 1.1) + 0.6 * cos(p.x * 0.11 + p.y * 0.23 + t * 0.7),
                sin(p.y * 0.27 - t * 0.9) + 0.6 * sin(p.y * 0.09 - p.x * 0.19 + t * 0.8));
  float dist = length(vSeaXZ - cameraPosition.xz);
  g *= 0.05 * (1.0 - smoothstep(200.0, 2500.0, dist));   // fade ripples with distance to avoid shimmer
  normal = normalize(normal + (viewMatrix * vec4(g.x, 0.0, g.y, 0.0)).xyz);
}
`;
