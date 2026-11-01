// Biome rules (biome §1–§4, §6, §7): temperature from the 1° grid with a lapse-rate correction,
// moisture from precipitation via the Köppen–Geiger dryness threshold, soft biome weights by
// smooth membership scores and a softmax, vegetation density, and the Aftermath overrides.
// Pure functions of position-derived inputs, so neighbouring tiles agree at shared vertices.

import { impactWinterCooling, type Aftermath } from "./climate";

export enum Biome {
  OpenOcean, ShelfSea, Beach, CoastalSwamp, FloodplainForest, WarmHumidForest, SeasonalWoodland,
  FernOpenland, AridScrub, Desert, PolarForest, MontaneForest, BareHighland, HighlandIce,
  AftermathFernField, AftermathDeadForest, ImpactWinterFrost, AftermathBareGround,
}
export const NB = 18;

export const BIOME_NAMES: readonly string[] = [
  "open ocean", "shelf sea", "beach", "coastal swamp", "floodplain forest", "warm humid forest",
  "seasonal woodland", "fern openland", "arid scrub", "desert", "polar forest", "montane forest",
  "bare highland", "highland ice", "fern field (aftermath)", "dead forest (aftermath)", "impact-winter frost",
  "bare ground (aftermath)",
];

/** Muted, earthy ground colours (sRGB); aftermath biomes get distinct hues (render §3). */
export const BIOME_COLOURS: readonly string[] = [
  "#1d3346", "#3c5f6e", "#cdbb8b", "#56603d", "#4d6538", "#3d5c30",
  "#6c7146", "#808b4c", "#a08d60", "#c7a46f", "#4f6047", "#475a40",
  "#8a8178", "#e4eaee", "#7aa53b", "#6e4a33", "#c6c9c5", "#7a6a58",
];

export const FOREST: readonly Biome[] = [
  Biome.CoastalSwamp, Biome.FloodplainForest, Biome.WarmHumidForest, Biome.SeasonalWoodland,
  Biome.PolarForest, Biome.MontaneForest,
];

export const LAPSE_C_PER_KM = 6.0;
const KEEP = new Float32Array(NB);
const TAU = 0.15;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 0 below a, 1 above b, smooth between (a > b gives a falling ramp). */
export const ramp = (x: number, a: number, b: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** 1 on [a, b], easing to 0 over a quarter of the width on each side. */
export const bump = (x: number, a: number, b: number) => { const w = (b - a) * 0.25; return ramp(x, a - w, a) * (1 - ramp(x, b, b + w)); };

export interface ClimateAt {
  temperatureC: number;     // lapse-corrected mean annual temperature
  precipMmYr: number;       // mean annual precipitation
  aridity: number;          // MAP / Köppen threshold
  moisture: number;         // 0..1
  heatStress: number;       // 0..1
  /** Before any Impact Winter cooling: decides what was growing (and so what died). */
  pre: { temperatureC: number; moisture: number };
}

/** Temperature (biome §2): correct the grid only for local height above the grid's own orography. */
export function temperatureAt(tGrid: number, eGrid: number, h: number, aftermath?: Aftermath | null): number {
  let t = tGrid - (LAPSE_C_PER_KM * (Math.max(h, 0) - Math.max(eGrid, 0))) / 1000;
  if (aftermath?.phase === "impactWinter") t -= impactWinterCooling(aftermath.year);
  return t;
}

/**
 * Moisture (biome §3). Köppen–Geiger dryness threshold with no seasonal bias:
 * P_thresh = 2·MAT + 14 cm = 20·MAT + 140 mm (Peel, Finlayson and McMahon 2007).
 */
export function climateAt(tGrid: number, eGrid: number, pMmDay: number, h: number, hSmooth: number,
  nearSea: number, aftermath?: Aftermath | null): ClimateAt {
  const precipMmYr = 365.25 * Math.max(pMmDay, 0);
  const lowness = Math.max(-1, Math.min(1, (hSmooth - h) / 20));
  const wet = (t: number) => {
    const aridity = precipMmYr / (20 * Math.max(t, 0) + 140);
    return { aridity, moisture: clamp01(aridity / (1 + aridity) + 0.08 * Math.max(lowness, 0) + 0.04 * nearSea) };
  };
  const temperatureC = temperatureAt(tGrid, eGrid, h, aftermath);
  const preT = temperatureAt(tGrid, eGrid, h, null);
  const now = wet(temperatureC);
  return {
    temperatureC, precipMmYr, aridity: now.aridity, moisture: now.moisture, heatStress: ramp(temperatureC, 35, 40),
    pre: { temperatureC: preT, moisture: preT === temperatureC ? now.moisture : wet(preT).moisture },
  };
}

export interface ClassifyIn {
  h: number; hSmooth: number; slopeDeg: number; absLat: number; nearSea: number;
  c: ClimateAt; icePossible: boolean; aftermath?: Aftermath | null;
}

/** Soft biome weights (biome §4, §7), written into out[0..NB). Returns the vegetation density (§6). */
export function classify(x: ClassifyIn, out: Float32Array): number {
  out.fill(0);
  const { h, slopeDeg, c } = x;
  if (h < 0) {
    const open = ramp(-h, 150, 300);
    out[Biome.OpenOcean] = open;
    out[Biome.ShelfSea] = 1 - open;
    return 0;
  }
  // the normal biomes are scored on the pre-impact climate; Impact Winter frost uses the cooled T below
  const m = c.pre.moisture, T = c.pre.temperatureC;
  const lowness = Math.max(0, Math.min(1, (x.hSmooth - h) / 20));
  const s = out;   // scores first, then softmax in place
  s[Biome.Beach] = bump(h, 0, 3) * (1 - ramp(slopeDeg, 2, 8)) * x.nearSea;
  s[Biome.CoastalSwamp] = bump(h, 0, 10) * ramp(m, 0.6, 0.8) * x.nearSea;
  s[Biome.FloodplainForest] = ramp(lowness, 0, 1) * ramp(m, 0.5, 0.7);
  s[Biome.WarmHumidForest] = ramp(T, 18, 22) * ramp(m, 0.6, 0.72);
  s[Biome.SeasonalWoodland] = ramp(T, 6, 12) * ramp(m, 0.45, 0.6) * (1 - 0.5 * ramp(T, 22, 26));
  s[Biome.FernOpenland] = bump(m, 0.3, 0.5);
  s[Biome.AridScrub] = bump(m, 0.15, 0.35);
  s[Biome.Desert] = 1 - ramp(m, 0.1, 0.2) + 0.8 * c.heatStress;
  s[Biome.PolarForest] = ramp(x.absLat, 55, 65) * ramp(m, 0.3, 0.5);
  s[Biome.MontaneForest] = ramp(h, 1200, 1800) * (1 - ramp(h, 2800, 3400)) * ramp(m, 0.4, 0.55);
  s[Biome.BareHighland] = ramp(h, 2800, 3400) + ramp(slopeDeg, 35, 45);
  s[Biome.HighlandIce] = x.icePossible ? ramp(-T, 2, 8) * 1.5 : 0;

  // Softmax for blended edges, gated so a biome whose rules don't apply here (score ≈ 0) gets no
  // share; a plain softmax spreads weight onto every biome when no score is high.
  if (!x.icePossible) s[Biome.HighlandIce] = 0;
  let max = -Infinity;
  for (let k = Biome.Beach; k <= Biome.HighlandIce; k++) max = Math.max(max, s[k]!);
  if (max < 0.02) { s[Biome.FernOpenland] = 1; max = 1; }   // nothing applies: generic open ground
  let sum = 0;
  for (let k = Biome.Beach; k <= Biome.HighlandIce; k++) {
    const gate = ramp(s[k]!, 0, 0.05);
    s[k] = gate * Math.exp((s[k]! - max) / TAU);
    sum += s[k]!;
  }
  for (let k = Biome.Beach; k <= Biome.HighlandIce; k++) s[k] = s[k]! / sum;

  let forestShare = 0;
  for (const f of FOREST) forestShare += s[f]!;
  let veg = vegDensity(s, m, T, slopeDeg, c.heatStress);

  if (x.aftermath) {
    // biome §7: living plants replaced; forests stand dead; frost (Impact Winter) or ferns (Fern Spike)
    const keep = KEEP.fill(0);
    keep[Biome.Beach] = s[Biome.Beach]!;
    keep[Biome.BareHighland] = s[Biome.BareHighland]!;
    keep[Biome.HighlandIce] = s[Biome.HighlandIce]!;
    keep[Biome.Desert] = s[Biome.Desert]!;
    const rest = 1 - keep[Biome.Beach]! - keep[Biome.BareHighland]! - keep[Biome.HighlandIce]! - keep[Biome.Desert]!;
    out.fill(0);
    for (const k of [Biome.Beach, Biome.BareHighland, Biome.HighlandIce, Biome.Desert]) out[k] = keep[k]!;
    if (x.aftermath.phase === "impactWinter") {
      // standing dead forest; elsewhere frost where annual means approach freezing, else bare ground
      const dead = Math.min(rest, forestShare);
      const frost = ramp(c.temperatureC, 8, 0);
      out[Biome.AftermathDeadForest] = dead;
      out[Biome.ImpactWinterFrost] = (rest - dead) * frost;
      out[Biome.AftermathBareGround] = (rest - dead) * (1 - frost);
      veg = 0;                                                // no living plants; snags only (ecology)
    } else {
      // ferns carpet the ground, including under the dead snags of former forest (Vajda et al. 2004)
      const dead = 0.3 * Math.min(rest, forestShare);
      const fern = (rest - dead) * (0.6 + 0.4 * ramp(m, 0.25, 0.5));
      out[Biome.AftermathDeadForest] = dead;
      out[Biome.AftermathFernField] = fern;
      out[Biome.AftermathBareGround] = rest - dead - fern;
      veg *= 0.6;
    }
    let t = 0;
    for (let k = 0; k < NB; k++) t += out[k]!;
    for (let k = 0; k < NB; k++) out[k] = out[k]! / t;
  }
  return veg;
}

/** Vegetation density 0..1 (biome §6). */
const VEG_MULT = (() => {
  const m = new Float32Array(NB);
  m[Biome.Desert] = 0.02; m[Biome.AridScrub] = 0.2; m[Biome.FernOpenland] = 0.5; m[Biome.Beach] = 0.05;
  m[Biome.CoastalSwamp] = 0.9; m[Biome.FloodplainForest] = 1; m[Biome.WarmHumidForest] = 1; m[Biome.SeasonalWoodland] = 0.8;
  m[Biome.PolarForest] = 0.8; m[Biome.MontaneForest] = 0.8; m[Biome.BareHighland] = 0.05;
  return m;
})();

function vegDensity(w: Float32Array, m: number, T: number, slopeDeg: number, heat: number): number {
  let mult = 0;
  for (let k = 0; k < NB; k++) mult += w[k]! * VEG_MULT[k]!;
  const moist = ramp(m, 0.1, 0.6), temp = ramp(T, -5, 8);
  return clamp01(mult * (0.4 + 0.6 * moist) * temp * (1 - ramp(slopeDeg, 30, 45)) * (1 - 0.8 * heat));
}

export function dominant(w: Float32Array): Biome {
  let best = 0;
  for (let k = 1; k < NB; k++) if (w[k]! > w[best]!) best = k;
  return best as Biome;
}

/** Blended ground colour (sRGB 0..1) from biome weights. */
const RGB = BIOME_COLOURS.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]);
export function blendColour(w: Float32Array, out: Float32Array | Uint8Array, o: number, scale = 1): void {
  let r = 0, g = 0, b = 0;
  for (let k = 0; k < NB; k++) {
    const x = w[k]!;
    if (x === 0) continue;
    r += x * RGB[k]![0]; g += x * RGB[k]![1]; b += x * RGB[k]![2];
  }
  out[o] = r * scale; out[o + 1] = g * scale; out[o + 2] = b * scale;
}
