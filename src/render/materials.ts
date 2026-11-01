// Materials for walk mode. Terrain uses MeshStandardMaterial with vertex colours (elevation and slope
// only until biome/ exists) plus a provenance overlay injected via onBeforeCompile (provenance §3):
// per-vertex level (0 data, 1 inferred, 2 generated) mixed in at α 0.55 with the Okabe–Ito colours,
// and a screen-space pattern as a second channel (dots = inferred, hatching = generated).
// Toggling the overlay changes a uniform only (render §11: no geometry rebuild).

import * as THREE from "three";

export const OVERLAY_COLOURS = { data: "#0072B2", inferred: "#E69F00", generated: "#CC79A7" } as const;

export interface TerrainUniforms {
  u_overlay: { value: number };
  u_holes: { value: THREE.Vector4[] };   // far field only: (latS, latN, lonW, lonE) relative to the origin
  u_nholes: { value: number };
}

export function makeUniforms(): TerrainUniforms {
  return {
    u_overlay: { value: 0 },
    u_holes: { value: Array.from({ length: 9 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    u_nholes: { value: 0 },
  };
}

const lin = (hex: string) => new THREE.Color(hex);   // THREE converts sRGB hex to linear working space

const v3 = (c: THREE.Color) => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;

/** Provenance overlay (provenance §3): level colour at α 0.55 + dots (inferred) / hatching (generated). */
export function overlayGlsl(levelVar: string): string {
  const [c0, c1, c2] = [lin(OVERLAY_COLOURS.data), lin(OVERLAY_COLOURS.inferred), lin(OVERLAY_COLOURS.generated)];
  return `if (u_overlay > 0.5) {
  float l = clamp(${levelVar}, 0.0, 2.0);
  vec3 lc = l < 1.0 ? mix(${v3(c0)}, ${v3(c1)}, l) : mix(${v3(c1)}, ${v3(c2)}, l - 1.0);
  vec2 p = gl_FragCoord.xy;
  float dots = 1.0 - step(1.3, length(mod(p, 7.0) - 3.5));
  float hatch = 1.0 - step(2.2, mod(p.x + p.y, 9.0));
  float wInf = clamp(1.0 - abs(l - 1.0), 0.0, 1.0);
  float wGen = clamp(l - 1.0, 0.0, 1.0);
  float pat = max(dots * wInf * (1.0 - wGen), hatch * wGen);
  diffuseColor.rgb = mix(diffuseColor.rgb, lc, 0.55);
  diffuseColor.rgb *= 1.0 - 0.45 * pat;
}`;
}

/**
 * Instanced plants and animals: vertex colours (parts) × instance colour (generated tint), the
 * provenance overlay from a per-instance level attribute, and optional wind sway for living plants.
 */
export function makeOrganismMaterial(uniforms: { u_overlay: { value: number }; u_time: { value: number } }, opts: { sway: boolean }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
attribute float aLevel;
varying float vLevel;
uniform float u_time;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vLevel = aLevel;
${opts.sway ? `#ifdef USE_INSTANCING
  float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.29;
  float bend = transformed.y * transformed.y;
  transformed.x += sin(u_time * 1.3 + ph) * 0.035 * bend;
  transformed.z += cos(u_time * 1.1 + ph * 1.7) * 0.025 * bend;
#endif` : ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
uniform float u_overlay;
varying float vLevel;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
${overlayGlsl("vLevel")}`);
  };
  m.customProgramCacheKey = () => `organism-${opts.sway ? "sway" : "still"}`;
  return m;
}

export function makeTerrainMaterial(uniforms: TerrainUniforms, opts: { holes: boolean }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
attribute float aProv;
varying float vProv;
${opts.holes ? "attribute vec2 aLL;\nvarying vec2 vLL;" : ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vProv = aProv;
${opts.holes ? "vLL = aLL;" : ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
uniform float u_overlay;
varying float vProv;
${opts.holes ? "uniform vec4 u_holes[9];\nuniform int u_nholes;\nvarying vec2 vLL;" : ""}`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
${opts.holes ? `for (int i = 0; i < 9; i++) {
  if (i >= u_nholes) break;
  vec4 h = u_holes[i];
  if (vLL.x > h.x && vLL.x < h.y && vLL.y > h.z && vLL.y < h.w) discard;
}` : ""}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
${overlayGlsl("vProv")}`);
  };
  m.customProgramCacheKey = () => `terrain-${opts.holes ? "far" : "near"}`;
  return m;
}

export function makeWaterMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color("#2a6f8f"), roughness: 0.18, metalness: 0.05,
    transparent: true, opacity: 0.8, depthWrite: false,
  });
}

// ------------------------------------------------------------------ ground colour

const RAMP: [number, THREE.Color][] = [
  [-4000, lin("#1d3346")], [-200, lin("#3c5f6e")], [-20, lin("#7f9a8f")], [-1, lin("#b9ad86")],
  [3, lin("#cbb98c")], [40, lin("#a39570")], [400, lin("#8d7f5f")], [1200, lin("#7a6a52")],
  [2200, lin("#857a6f")], [3500, lin("#aaa49c")], [6000, lin("#c8c4be")],
];
const ROCK = lin("#6c6560");
const tmp = new THREE.Color();

/** sRGB byte → linear, for biome colours computed in the worker. */
const LIN = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });

/**
 * Ground colour. Land uses the biome colour (sRGB bytes at biome[bo..bo+2]) when given, with rock
 * blending in on steep slopes; the sea floor and terrain without biome data use the elevation ramp.
 * up = the normal's up component.
 */
export function groundColour(h: number, up: number, jitter: number, out: Float32Array, o: number,
  biome?: Uint8Array, bo = 0): void {
  if (biome && h >= 0) {
    tmp.setRGB(LIN[biome[bo]!]!, LIN[biome[bo + 1]!]!, LIN[biome[bo + 2]!]!);
    const r = Math.min(1, Math.max(0, (0.86 - up) / 0.14));
    tmp.lerp(ROCK, r * r * (3 - 2 * r));
    const s = 1 + jitter * 0.07;
    out[o] = tmp.r * s; out[o + 1] = tmp.g * s; out[o + 2] = tmp.b * s;
    return;
  }
  elevationColour(h, up, jitter, out, o);
}

function elevationColour(h: number, up: number, jitter: number, out: Float32Array, o: number): void {
  let k = 0;
  while (k < RAMP.length - 2 && h > RAMP[k + 1]![0]) k++;
  const [h0, a] = RAMP[k]!, [h1, b] = RAMP[k + 1]!;
  tmp.copy(a).lerp(b, Math.min(1, Math.max(0, (h - h0) / (h1 - h0))));
  if (h > 0) {
    const r = Math.min(1, Math.max(0, (0.86 - up) / 0.14));       // rock above ~31–44° slopes
    tmp.lerp(ROCK, r * r * (3 - 2 * r));
  }
  const s = 1 + jitter * 0.06;
  out[o] = tmp.r * s;
  out[o + 1] = tmp.g * s;
  out[o + 2] = tmp.b * s;
}
