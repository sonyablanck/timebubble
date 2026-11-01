import { BATHYMETRIC, HYPSOMETRIC, PRECIPITATION, PROVENANCE, TEMPERATURE, glslRamp, hexToRgb } from "./palette";
import { EARTH_RADIUS_M } from "./geo";

// globe/ §2–3. GLSL 3 (WebGL2). All grids share the 1° node-registered layout,
// described by gridGeo = (latNorth, lonWest, res, 0) and gridSize = (width, height).
// Coordinates follow geo.ts exactly: lat = asin(y), lon = atan(x, z).

const vec3Lit = (hex: string) => `vec3(${hexToRgb(hex).map((c) => c.toFixed(4)).join(", ")})`;

export const SEA_FLOOR_CLAMP_M = -6000;

const COMMON = /* glsl */ `
precision highp float;

uniform sampler2D elevA;
uniform sampler2D elevB;
uniform float fade;            // 0 = A only, 1 = B only (visual crossfade between slices)
uniform sampler2D tempTex;     // °C
uniform sampler2D precTex;     // mm/yr
uniform vec4 gridGeo;          // latNorth, lonWest, res, unused
uniform vec2 gridSize;         // width, height
uniform float exaggeration;
uniform float showTemp;
uniform float showPrec;
uniform float showProvenance;
uniform vec3 lightDir;         // world space, normalised

const float PI = 3.14159265358979;
const float DEG = PI / 180.0;
const float R_EARTH = ${EARTH_RADIUS_M.toFixed(1)};
const float SEA_FLOOR_CLAMP = ${SEA_FLOOR_CLAMP_M.toFixed(1)};

vec2 latLonOf(vec3 p) {
  vec3 u = normalize(p);
  return vec2(asin(clamp(u.y, -1.0, 1.0)) / DEG, atan(u.x, u.z) / DEG);
}

vec2 gridUV(vec2 ll) {
  float u = (ll.y - gridGeo.y) / (gridSize.x * gridGeo.z) + 0.5 / gridSize.x;
  float v = (gridGeo.x - ll.x) / (gridSize.y * gridGeo.z) + 0.5 / gridSize.y;
  return vec2(u, v);
}

float elevAt(vec2 ll) {
  vec2 uv = gridUV(ll);
  return mix(texture(elevA, uv).r, texture(elevB, uv).r, fade);
}

${glslRamp("hypsometric", HYPSOMETRIC)}
${glslRamp("bathymetric", BATHYMETRIC)}
${glslRamp("temperatureRamp", TEMPERATURE)}
${glslRamp("precipitationRamp", PRECIPITATION)}

vec3 overlays(vec3 base, vec2 ll) {
  vec3 c = base;
  if (showProvenance > 0.5) c = mix(c, ${vec3Lit(PROVENANCE.data)}, 0.45);       // relief: data
  if (showTemp > 0.5) {
    vec3 t = showProvenance > 0.5 ? ${vec3Lit(PROVENANCE.inferred)} : temperatureRamp(texture(tempTex, gridUV(ll)).r);
    c = mix(c, t, 0.5);                                                          // climate: inferred
  }
  if (showPrec > 0.5) {
    vec3 p = showProvenance > 0.5 ? ${vec3Lit(PROVENANCE.inferred)} : precipitationRamp(texture(precTex, gridUV(ll)).r);
    c = mix(c, p, 0.5);
  }
  return c;
}
`;

export const RELIEF_VERTEX = /* glsl */ `
${COMMON}
out vec3 vPos;
void main() {
  vec2 ll = latLonOf(position);
  float h = elevAt(ll);
  vec3 p = position * (1.0 + exaggeration * max(h, SEA_FLOOR_CLAMP) / R_EARTH);
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const RELIEF_FRAGMENT = /* glsl */ `
${COMMON}
in vec3 vPos;
out vec4 fragColor;
void main() {
  vec2 ll = latLonOf(vPos);
  float h = elevAt(ll);
  // hillshade from central differences of the elevation texture (globe/ §2)
  float d = gridGeo.z;
  float mPerDeg = R_EARTH * DEG;
  float cosLat = max(cos(ll.x * DEG), 0.05);
  float dEdN = (elevAt(ll + vec2(d, 0.0)) - elevAt(ll - vec2(d, 0.0))) / (2.0 * d * mPerDeg);
  float dEdE = (elevAt(ll + vec2(0.0, d)) - elevAt(ll - vec2(0.0, d))) / (2.0 * d * mPerDeg * cosLat);
  float s = clamp(exaggeration, 1.0, 80.0) * 0.6;
  vec3 nLocal = normalize(vec3(-s * dEdE, -s * dEdN, 1.0));
  float lat = ll.x * DEG, lon = ll.y * DEG;
  vec3 east = vec3(cos(lon), 0.0, -sin(lon));
  vec3 north = vec3(-sin(lat) * sin(lon), cos(lat), -sin(lat) * cos(lon));
  vec3 up = normalize(vPos);
  vec3 n = normalize(east * nLocal.x + north * nLocal.y + up * nLocal.z);
  float diffuse = max(dot(n, lightDir), 0.0);
  vec3 base = h >= 0.0 ? hypsometric(h) : bathymetric(-h) * 0.75;
  vec3 c = base * (0.42 + 0.7 * diffuse);
  fragColor = vec4(overlays(c, ll), 1.0);
}
`;

export const SEA_VERTEX = /* glsl */ `
${COMMON}
out vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SEA_FRAGMENT = /* glsl */ `
${COMMON}
in vec3 vPos;
out vec4 fragColor;
void main() {
  vec2 ll = latLonOf(vPos);
  float h = elevAt(ll);
  if (h >= 0.0) discard;
  float depth = -h;
  vec3 n = normalize(vPos);
  float diffuse = max(dot(n, lightDir), 0.0);
  vec3 c = bathymetric(depth) * (0.55 + 0.5 * diffuse);
  float alpha = mix(0.6, 0.94, smoothstep(0.0, 3000.0, depth));
  fragColor = vec4(overlays(c, ll), alpha);
}
`;
