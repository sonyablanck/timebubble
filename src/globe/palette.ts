// Colour scales for the globe (globe/ §2–3). Each scale is defined once here and
// compiled into GLSL by glslRamp(), and the same stops drive the HTML legends, so
// INVARIANT "the legend matches the shader's colour stops" holds by construction.

export interface Stop { value: number; color: string }

/** Neutral hypsometric palette for land (m): no vegetation greens, since the globe computes no biomes. */
export const HYPSOMETRIC: Stop[] = [
  { value: 0, color: "#cbc3ad" },     // lowland sand-grey
  { value: 500, color: "#c9b48a" },
  { value: 1200, color: "#b99a62" },  // upland ochre
  { value: 2200, color: "#8e6e4c" },  // highland brown
  { value: 3200, color: "#a39a91" },
  { value: 4200, color: "#e4e1dc" },  // peaks pale grey
];

/** Sea colour by depth (m below sea level): pale shelves, dark abyssal plains. */
export const BATHYMETRIC: Stop[] = [
  { value: 0, color: "#9fd0d6" },
  { value: 200, color: "#6fb1c4" },
  { value: 1000, color: "#3d7fa6" },
  { value: 3000, color: "#1f4f7d" },
  { value: 6000, color: "#0f2a4d" },
];

/** Mean annual temperature (°C): diverging blue → white → red. */
export const TEMPERATURE: Stop[] = [
  { value: -20, color: "#2c5aa0" },
  { value: 0, color: "#8db6dd" },
  { value: 12, color: "#f2f0eb" },
  { value: 24, color: "#f0a36b" },
  { value: 36, color: "#b2182b" },
];

/** Mean annual precipitation (mm/yr): sequential pale → blue-green. */
export const PRECIPITATION: Stop[] = [
  { value: 0, color: "#f4efe1" },
  { value: 250, color: "#dcd9a8" },
  { value: 750, color: "#9fcf9a" },
  { value: 1500, color: "#4fae9b" },
  { value: 3000, color: "#1d6d8c" },
];

/** Okabe–Ito provenance colours (provenance/ §3a). */
export const PROVENANCE = { data: "#0072B2", inferred: "#E69F00", generated: "#CC79A7" } as const;

/** ICS chart colours for the slider's period bands. */
export const PERIOD_COLOURS: Record<string, string> = {
  Triassic: "#812B92",
  Jurassic: "#34B2C9",
  Cretaceous: "#7FC64E",
  Palaeogene: "#FD9A52",
};

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const glslFloat = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const glslVec3 = (hex: string) => `vec3(${hexToRgb(hex).map((c) => c.toFixed(4)).join(", ")})`;

/** A GLSL function `vec3 name(float x)` that linearly interpolates the stops. */
export function glslRamp(name: string, stops: Stop[]): string {
  const lines = [`vec3 ${name}(float x) {`];
  lines.push(`  if (x <= ${glslFloat(stops[0]!.value)}) return ${glslVec3(stops[0]!.color)};`);
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!;
    lines.push(`  if (x <= ${glslFloat(b.value)}) return mix(${glslVec3(a.color)}, ${glslVec3(b.color)}, ` +
      `(x - ${glslFloat(a.value)}) / ${glslFloat(b.value - a.value)});`);
  }
  lines.push(`  return ${glslVec3(stops[stops.length - 1]!.color)};`, "}");
  return lines.join("\n");
}

/** CSS linear-gradient for a legend, with stops at their true positions. */
export function cssGradient(stops: Stop[]): string {
  const lo = stops[0]!.value, hi = stops[stops.length - 1]!.value;
  return `linear-gradient(to right, ${stops.map((s) => `${s.color} ${(((s.value - lo) / (hi - lo)) * 100).toFixed(1)}%`).join(", ")})`;
}
