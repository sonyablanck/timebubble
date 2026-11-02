// Materials for walk mode. Terrain uses MeshStandardMaterial with vertex colours (biome, elevation and
// slope) plus a provenance overlay injected via onBeforeCompile (provenance §3):
// per-vertex level (0 data, 1 inferred, 2 generated) mixed in at α 0.55 with the Okabe–Ito colours,
// and a screen-space pattern as a second channel (dots = inferred, hatching = generated).
// Toggling the overlay changes a uniform only (render §11: no geometry rebuild).

import * as THREE from "three";
import { SEA_COLOUR_GLSL, SEA_DECL, SEA_NORMAL_GLSL, type SeaUniforms } from "./sea";
import { F } from "../provenance/flags";

export const OVERLAY_COLOURS = { data: "#0072B2", inferred: "#E69F00", generated: "#CC79A7" } as const;

/** Overlay modes (provenance §3): u_overlay values. ID is the hidden pass that measures in-view shares. */
export const OVERLAY = { OFF: 0, SOURCE: 1, FOCUS: 2, EVIDENCE: 3, ID: 4 } as const;
export const MAX_SITES = 128;

/** Uniforms every overlay-aware material shares (one object, so a mode change is one write). */
export interface OverlayUniforms {
  u_overlay: { value: number };
  u_focus: { value: number };                  // the focused flag's bit value (a power of two)
  u_sites: { value: THREE.Vector2[] };         // fossil sites in local metres (x, z), evidence mode
  u_nsites: { value: number };
}

export function makeOverlayUniforms(): OverlayUniforms {
  return {
    u_overlay: { value: 0 }, u_focus: { value: 1 },
    u_sites: { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector2(1e9, 1e9)) }, u_nsites: { value: 0 },
  };
}

export interface TerrainUniforms extends OverlayUniforms {
  u_holes: { value: THREE.Vector4[] };   // far field only: (latS, latN, lonW, lonE) relative to the origin
  u_nholes: { value: number };
}

export function makeUniforms(overlay: OverlayUniforms = makeOverlayUniforms()): TerrainUniforms {
  return {
    ...overlay,
    u_holes: { value: Array.from({ length: 9 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    u_nholes: { value: 0 },
  };
}

const lin = (hex: string) => new THREE.Color(hex);   // THREE converts sRGB hex to linear working space

const v3 = (c: THREE.Color) => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;

/** Fragment declarations every overlay-aware material needs. */
export const OVERLAY_DECL = `uniform float u_overlay;
uniform float u_focus;
uniform vec2 u_sites[${MAX_SITES}];
uniform int u_nsites;
float tbHasFlag(float flags, float bit) { return mod(floor(flags / bit + 0.0001), 2.0); }`;

const levelColour = () => {
  const [c0, c1, c2] = [lin(OVERLAY_COLOURS.data), lin(OVERLAY_COLOURS.inferred), lin(OVERLAY_COLOURS.generated)];
  return `(l < 1.0 ? mix(${v3(c0)}, ${v3(c1)}, l) : mix(${v3(c1)}, ${v3(c2)}, l - 1.0))`;
};

/**
 * Provenance overlay (provenance §3), injected after <color_fragment>.
 *   source:   level colour at α 0.55 + dots (inferred) / hatching (generated)
 *   focus:    the focused flag in vermilion with stripes; everything else greyed out
 *   evidence: terrain by distance to the nearest fossil site (≤ 25 km data colour, 150 km inferred,
 *             beyond generated); organisms greyed
 *   coast:    an outline where GENERATED_COAST starts or stops (terrain, source and focus modes)
 * Each part is optional: flagsVar, worldVar (local metres x, z) and coastVar may be null.
 */
export function overlayGlsl(levelVar: string, opts: { flags?: string; world?: string; coast?: string } = {}): string {
  const focusCol = v3(lin("#D55E00"));
  return `if (u_overlay > 0.5 && u_overlay < 3.5) {
  vec2 p = gl_FragCoord.xy;
  float dots = 1.0 - step(1.3, length(mod(p, 7.0) - 3.5));
  float hatch = 1.0 - step(2.2, mod(p.x + p.y, 9.0));
  float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  if (u_overlay < 1.5) {
    float l = clamp(${levelVar}, 0.0, 2.0);
    vec3 lc = ${levelColour()};
    float wInf = clamp(1.0 - abs(l - 1.0), 0.0, 1.0);
    float wGen = clamp(l - 1.0, 0.0, 1.0);
    float pat = max(dots * wInf * (1.0 - wGen), hatch * wGen);
    diffuseColor.rgb = mix(diffuseColor.rgb, lc, 0.55);
    diffuseColor.rgb *= 1.0 - 0.45 * pat;
  } else if (u_overlay < 2.5) {
    float on = ${opts.flags ? `tbHasFlag(${opts.flags}, u_focus)` : "0.0"};
    float stripe = 1.0 - step(3.0, mod(p.x - p.y, 10.0));
    diffuseColor.rgb = on > 0.5 ? mix(diffuseColor.rgb, ${focusCol}, 0.65) * (1.0 - 0.3 * stripe) : vec3(lum * 0.8 + 0.03);
  } else {
    ${opts.world ? `float dmin = 1e12;
    for (int i = 0; i < ${MAX_SITES}; i++) {
      if (i >= u_nsites) break;
      vec2 d = ${opts.world} - u_sites[i];
      dmin = min(dmin, dot(d, d));
    }
    float km = sqrt(dmin) / 1000.0;
    float l = km < 25.0 ? 0.0 : km < 150.0 ? (km - 25.0) / 125.0 : min(2.0, 1.0 + (km - 150.0) / 150.0);
    vec3 lc = ${levelColour()};
    float wInf = clamp(1.0 - abs(l - 1.0), 0.0, 1.0);
    float wGen = clamp(l - 1.0, 0.0, 1.0);
    float pat = max(dots * wInf * (1.0 - wGen), hatch * wGen);
    diffuseColor.rgb = mix(vec3(lum), lc, 0.6) * (1.0 - 0.4 * pat);` : "diffuseColor.rgb = vec3(lum * 0.8 + 0.03);"}
  }
  ${opts.coast ? `if (u_overlay < 2.5) {
    float c = ${opts.coast};
    float w = fwidth(c);
    float edge = 1.0 - smoothstep(0.0, 1.6 * w, abs(c - 0.5));
    if (w > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.95, 0.9), edge);
  }` : ""}
}`;
}

/** The hidden "in view" pass (u_overlay = ID): flat level colour, injected after <dithering_fragment>. */
export function idPassGlsl(levelVar: string): string {
  return `if (u_overlay > 3.5) {
  float L = floor(clamp(${levelVar}, 0.0, 2.0) + 0.5);
  gl_FragColor = vec4(L < 0.5 ? 1.0 : 0.0, abs(L - 1.0) < 0.5 ? 1.0 : 0.0, L > 1.5 ? 1.0 : 0.0, 1.0);
}`;
}

/**
 * Organism vertex motion (models.ts documents aRig): wind sway for plants; for animals a walk
 * cycle (legs swing about the hip, feet lift on the forward stroke), tail sway, head lowered while
 * grazing, wing flaps and flipper strokes. Per-instance aAnim = (pattern seed, gait Hz, moving 0–1,
 * grazing 0–1), written by FaunaLayer every frame. All motion is generated (POSE_GENERATED).
 */
function organismVertex(kind: "plant" | "animal" | "still"): { decl: string; body: string } {
  const decl = `attribute vec4 aRig;
uniform float u_time;
uniform float u_motion;   // 0 with reduced motion: no wind sway
${kind === "animal" ? "attribute vec4 aAnim;" : ""}`;
  if (kind === "still") return { decl, body: "" };
  if (kind === "plant") return {
    decl, body: `#ifdef USE_INSTANCING
{
  float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.29;
  float w = aRig.y;
  float gust = (0.75 + 0.25 * sin(u_time * 0.31 + ph * 0.2)) * u_motion;
  transformed.x += (sin(u_time * 1.3 + ph) * 0.03 + sin(u_time * 3.7 + ph * 3.1 + transformed.y * 9.0) * 0.006) * w * gust;
  transformed.z += (cos(u_time * 1.1 + ph * 1.7) * 0.022 + cos(u_time * 4.1 + ph * 2.3 + transformed.x * 9.0) * 0.006) * w * gust;
}
#endif`,
  };
  return {
    decl, body: `#ifdef USE_INSTANCING
{
  float k = aRig.x;
  float ph = fract(aAnim.x) * 6.2832 + u_time * aAnim.y * 6.2832;
  float mv = aAnim.z, gz = aAnim.w;
  if (k > 0.5 && k < 1.5) {
    // leg: swing about the hip; lift the lower leg on the forward stroke
    float ang = sin(ph + aRig.w) * 0.42 * mv;
    vec2 d = transformed.yz - aRig.yz;
    float c = cos(ang), s = sin(ang);
    transformed.yz = aRig.yz + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
    float low = clamp(-d.x / max(aRig.y, 1e-3), 0.0, 1.0);
    transformed.y += max(0.0, cos(ph + aRig.w)) * 0.05 * aRig.y * mv * low;
  } else if (k > 1.5 && k < 2.5) {
    float w = aRig.y * aRig.y;
    transformed.x += sin(u_time * (1.1 + aAnim.y) + fract(aAnim.x) * 6.2832 - aRig.y * 2.5) * 0.05 * w * (0.35 + mv);
  } else if (k > 2.5 && k < 3.5) {
    // neck and head: bend down about the shoulder while grazing, a slow look-around otherwise
    float w = smoothstep(0.0, 1.0, aRig.y);
    float ang = -gz * 0.75 * w + sin(u_time * 0.4 + fract(aAnim.x) * 20.0) * 0.06 * w * (1.0 - gz);
    vec2 d = transformed.yz - aRig.zw;
    float c = cos(ang), s = sin(ang);
    transformed.yz = aRig.zw + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
    transformed.x += sin(u_time * 0.25 + fract(aAnim.x) * 13.0) * 0.04 * w * (1.0 - gz);
  } else if (k > 3.5 && k < 4.5) {
    transformed.y += sin(ph) * 0.16 * aRig.y * mv;
  } else if (k > 4.5) {
    transformed.y += sin(ph + aRig.z) * 0.04 * aRig.y;
  }
}
#endif`,
  };
}

/** The same motion for shadow maps, so swaying plants and walking animals cast matching shadows. */
export function makeOrganismDepthMaterial(uniforms: { u_time: { value: number }; u_motion?: { value: number } }, kind: "plant" | "animal" | "still"): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  const v = organismVertex(kind);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.u_time = uniforms.u_time;
    shader.uniforms.u_motion = uniforms.u_motion ?? { value: 1 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${v.decl}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${v.body}`);
  };
  m.customProgramCacheKey = () => `organism-depth-${kind}`;
  return m;
}

/**
 * Instanced plants and animals: vertex colours (parts, countershading and baked shading) × instance
 * colour (generated tint), the provenance overlay from a per-instance level, vertex motion
 * (organismVertex), and for animals a generated pattern (none, stripes or blotches) on the upper body.
 */
export function makeOrganismMaterial(uniforms: OverlayUniforms & { u_time: { value: number }; u_motion?: { value: number } }, opts: { kind: "plant" | "animal" | "still" }): THREE.MeshStandardMaterial {
  const animal = opts.kind === "animal";
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: animal ? 0.78 : 0.88, metalness: 0, flatShading: !animal, side: THREE.DoubleSide });
  const v = organismVertex(opts.kind);
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { u_motion: { value: 1 } }, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
attribute float aLevel;
attribute float aFlags;
attribute vec3 aBody;
varying float vLevel;
varying float vFlags;
varying vec3 vBody;
varying float vPat;
${v.decl}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vLevel = aLevel;
vFlags = aFlags;
vBody = aBody;
${animal ? "#ifdef USE_INSTANCING\nvPat = aAnim.x;\n#else\nvPat = 0.0;\n#endif" : "vPat = 0.0;"}
${v.body}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
${OVERLAY_DECL}
varying float vLevel;
varying float vFlags;
varying vec3 vBody;
varying float vPat;
float tbHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tbNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tbHash(i), tbHash(i + vec2(1, 0)), f.x), mix(tbHash(i + vec2(0, 1)), tbHash(i + vec2(1, 1)), f.x), f.y); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
${animal ? `{
  // generated pattern: integer part of vPat picks none / stripes / blotches; only on the upper body
  float kind = floor(vPat), seed = fract(vPat);
  float upper = smoothstep(-0.15, 0.4, vBody.y) * step(-0.99, vBody.y);
  float p = 0.0;
  if (kind > 0.5 && kind < 1.5) p = smoothstep(0.45, 0.55, fract(vBody.x * (14.0 + seed * 10.0) + 0.15 * sin(vBody.z * 6.2832)));
  else if (kind > 1.5) p = smoothstep(0.55, 0.7, tbNoise(vec2(vBody.x * (22.0 + seed * 12.0), vBody.z * 9.0 + seed * 40.0)));
  diffuseColor.rgb *= 1.0 - 0.3 * p * upper;
}` : ""}
${overlayGlsl("vLevel", { flags: "vFlags" })}`)
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>
${idPassGlsl("vLevel")}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
${opts.kind === "plant" ? "totalEmissiveRadiance += diffuseColor.rgb * 0.06;   // light through leaves" : ""}`);
  };
  m.customProgramCacheKey = () => `organism-${opts.kind}`;
  return m;
}

/**
 * Distant plants as camera-facing cut-outs (cylindrical billboards): each instance's quad turns
 * about its vertical axis to face the camera. The atlas is baked in FloraLayer with the same
 * models and lighting as near plants; `u_bright` follows the scene's daylight.
 */
export function makeImpostorMaterial(map: THREE.Texture, uniforms: OverlayUniforms & { u_bright: { value: number } }): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ map, alphaTest: 0.45, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
attribute float aLevel;
attribute float aFlags;
varying float vLevel;
varying float vFlags;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vLevel = aLevel;
vFlags = aFlags;`)
      .replace("#include <project_vertex>", `#ifdef USE_INSTANCING
vec4 tbBase = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
float tbScale = length(instanceMatrix[1].xyz);
vec2 tbD = normalize(cameraPosition.xz - tbBase.xz + vec2(1e-5, 0.0));
vec3 tbWorld = tbBase.xyz + vec3(tbD.y, 0.0, -tbD.x) * transformed.x * tbScale + vec3(0.0, transformed.y * tbScale, 0.0);
vec4 mvPosition = viewMatrix * vec4(tbWorld, 1.0);
#else
vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
#endif
gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
${OVERLAY_DECL}
uniform float u_bright;
varying float vLevel;
varying float vFlags;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
diffuseColor.rgb *= u_bright;
${overlayGlsl("vLevel", { flags: "vFlags" })}`)
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>
${idPassGlsl("vLevel")}`);
  };
  m.customProgramCacheKey = () => "impostor";
  return m;
}

export function makeTerrainMaterial(uniforms: TerrainUniforms, opts: { holes: boolean }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
float tbBit(float flags, float bit) { return mod(floor(flags / bit + 0.0001), 2.0); }
attribute float aProv;
attribute float aFlags;
varying float vProv;
varying float vFlags;
varying float vCoast;
varying vec2 vWorldXZ;
${opts.holes ? "attribute vec2 aLL;\nvarying vec2 vLL;" : ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vProv = aProv;
vFlags = aFlags;
vCoast = tbBit(aFlags, ${F.GENERATED_COAST.toFixed(1)});
vWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
${opts.holes ? "vLL = aLL;" : ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
${OVERLAY_DECL}
varying float vProv;
varying float vFlags;
varying float vCoast;
varying vec2 vWorldXZ;
${opts.holes ? "uniform vec4 u_holes[9];\nuniform int u_nholes;\nvarying vec2 vLL;" : ""}`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
${opts.holes ? `for (int i = 0; i < 9; i++) {
  if (i >= u_nholes) break;
  vec4 h = u_holes[i];
  if (vLL.x > h.x && vLL.x < h.y && vLL.y > h.z && vLL.y < h.w) discard;
}` : ""}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
${overlayGlsl("vProv", { flags: "vFlags", world: "vWorldXZ", coast: opts.holes ? undefined : "vCoast" })}`)
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>
${idPassGlsl("vProv")}`);
  };
  m.customProgramCacheKey = () => `terrain-${opts.holes ? "far" : "near"}`;
  return m;
}

export function makeWaterMaterial(uniforms?: OverlayUniforms, sea?: SeaUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#2a6f8f"), roughness: 0.12, metalness: 0.05,
    transparent: true, opacity: 0.8, depthWrite: false,
  });
  if (uniforms || sea) {
    m.onBeforeCompile = (shader) => {
      if (uniforms) Object.assign(shader.uniforms, uniforms);
      if (sea) {
        // depth-tinted colour, shoreline foam and ripples (render §6b; generated look over the terrain's floor)
        Object.assign(shader.uniforms, sea);
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec2 vSeaXZ;")
          .replace("#include <project_vertex>", "#include <project_vertex>\nvSeaXZ = (modelMatrix * vec4(transformed, 1.0)).xz;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>\n${SEA_DECL}`)
          .replace("#include <color_fragment>", `#include <color_fragment>\n${SEA_COLOUR_GLSL}`)
          .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${SEA_NORMAL_GLSL}`);
      }
      if (uniforms) {
        // the sea surface is generated and untinted; the hidden "in view" pass looks through it to the sea floor
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>\n${OVERLAY_DECL}`)
          .replace("#include <dithering_fragment>", `#include <dithering_fragment>\nif (u_overlay > 3.5) discard;   // in-view shares count the sea by its floor (land/sea is data; the surface look is generated)`);
      }
    };
    m.customProgramCacheKey = () => `water-${uniforms ? "o" : ""}${sea ? "s" : ""}`;
  }
  return m;
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
