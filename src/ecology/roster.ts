// ecology §1–§3, §5: which taxa are present on a tile (from fossil evidence) and how many
// individuals (from body size, Damuth's law). Fossils decide presence, never abundance.

import type { OccurrenceNear } from "../data";
import { F } from "../provenance/flags";
import { KPG_MA } from "./constants";

export const R_DATA_KM = 150;
export const R_INFERRED_KM = 750;
export const KERNEL_KM = 250;
export const N_MAX = 40;
export const TILE_AREA_KM2 = 16;

export type AnimalPlan =
  | "small_theropod" | "large_theropod" | "sauropod" | "prosauropod" | "ornithopod" | "ceratopsian" | "ankylosaur"
  | "stegosaur" | "pterosaur" | "crocodylomorph" | "marine_reptile" | "turtle" | "small_tetrapod" | "fish" | "invertebrate";
export const ANIMAL_PLANS: readonly AnimalPlan[] = [
  "small_theropod", "large_theropod", "sauropod", "prosauropod", "ornithopod", "ceratopsian", "ankylosaur",
  "stegosaur", "pterosaur", "crocodylomorph", "marine_reptile", "turtle", "small_tetrapod", "fish", "invertebrate",
];
const DINOSAUR: ReadonlySet<AnimalPlan> = new Set(["small_theropod", "large_theropod", "sauropod", "prosauropod", "ornithopod", "ceratopsian", "ankylosaur", "stegosaur"]);
/** Groups that did not survive the K–Pg extinction besides non-avian dinosaurs (all pterosaurs; mosasaurs and plesiosaurs). */
const KPG_VICTIMS: ReadonlySet<AnimalPlan> = new Set(["pterosaur", "marine_reptile"]);

export type Trophic = "herbivore" | "carnivore" | "omnivore";
export type Realm = "land" | "sea" | "air" | "water_edge";

export interface PlanInfo {
  label: string;
  trophic: Trophic;
  realm: Realm;
  /** Class-default size when rules.csv gives none. Provisional round values, not yet sourced: tagged `inferred`. */
  lengthM: number;
  massKg: number;
  group: [number, number];   // group size range (ecology §2)
  rendered: boolean;         // false: listed in the field guide but not placed (too small, or underwater)
}

export const PLAN_INFO: Record<AnimalPlan, PlanInfo> = {
  sauropod:       { label: "sauropod", trophic: "herbivore", realm: "land", lengthM: 20, massKg: 15000, group: [1, 8], rendered: true },
  prosauropod:    { label: "early sauropodomorph", trophic: "herbivore", realm: "land", lengthM: 6, massKg: 700, group: [1, 6], rendered: true },
  ornithopod:     { label: "ornithopod", trophic: "herbivore", realm: "land", lengthM: 7, massKg: 2000, group: [3, 20], rendered: true },
  ceratopsian:    { label: "ceratopsian", trophic: "herbivore", realm: "land", lengthM: 6, massKg: 4000, group: [1, 10], rendered: true },
  ankylosaur:     { label: "ankylosaur", trophic: "herbivore", realm: "land", lengthM: 6, massKg: 4000, group: [1, 3], rendered: true },
  stegosaur:      { label: "stegosaur", trophic: "herbivore", realm: "land", lengthM: 7, massKg: 3500, group: [1, 3], rendered: true },
  large_theropod: { label: "large theropod", trophic: "carnivore", realm: "land", lengthM: 10, massKg: 5200, group: [1, 2], rendered: true },
  small_theropod: { label: "small theropod", trophic: "carnivore", realm: "land", lengthM: 2, massKg: 20, group: [1, 6], rendered: true },
  pterosaur:      { label: "pterosaur", trophic: "carnivore", realm: "air", lengthM: 3, massKg: 10, group: [1, 12], rendered: true },
  crocodylomorph: { label: "crocodylomorph", trophic: "carnivore", realm: "water_edge", lengthM: 3, massKg: 150, group: [1, 4], rendered: true },
  marine_reptile: { label: "marine reptile", trophic: "carnivore", realm: "sea", lengthM: 6, massKg: 1500, group: [1, 4], rendered: true },
  turtle:         { label: "turtle", trophic: "omnivore", realm: "water_edge", lengthM: 0.5, massKg: 10, group: [1, 5], rendered: true },
  small_tetrapod: { label: "small tetrapod (mammal, bird, lizard…)", trophic: "omnivore", realm: "land", lengthM: 0.3, massKg: 0.5, group: [1, 3], rendered: true },
  fish:           { label: "fish", trophic: "carnivore", realm: "sea", lengthM: 0.5, massKg: 2, group: [1, 10], rendered: false },
  invertebrate:   { label: "invertebrate", trophic: "omnivore", realm: "sea", lengthM: 0.05, massKg: 0.01, group: [1, 1], rendered: false },
};

// ------------------------------------------------------------------ §3 abundance

/**
 * Damuth's law, D = k·M^−0.75 individuals per km² (Damuth 1981). The carnivore constant is
 * calibrated so a ~5,200 kg carnivore gives ~0.01 per km², the Tyrannosaurus rex estimate of
 * Marshall et al. (2021). Herbivores and omnivores use provisional multiples of it (CHECK: calibrate
 * against Damuth's (1981) regressions; record the choice in the About panel).
 */
export const K_CARNIVORE = 0.01 * 5200 ** 0.75;
export const TROPHIC_FACTOR: Record<Trophic, number> = { carnivore: 1, omnivore: 3, herbivore: 10 };

export function densityPerKm2(massKg: number, trophic: Trophic): number {
  return K_CARNIVORE * TROPHIC_FACTOR[trophic] * massKg ** -0.75;
}

/**
 * Evidence weight at which presence reaches 1 − 1/e ≈ 63%. Weight sums, over a taxon's occurrences,
 * age fit × exp(−distance / 250 km) × environment match (§1–§2): one well-dated occurrence on the
 * spot in the right environment gives weight 1. Provisional (CHECK in DESIGN §12): a stated reading
 * of the evidence, not a fitted probability.
 */
export const PRESENCE_SCALE = 1;

export function presenceFromWeight(weight: number): number {
  return 1 - Math.exp(-Math.max(0, weight) / PRESENCE_SCALE);
}

/** Presence as a percentage, never shown as a certain 100% or 0%. */
export function presencePct(p: number): string {
  return p > 0.99 ? "> 99%" : p < 0.01 ? "< 1%" : `${Math.round(p * 100)}%`;
}

/** Plain-language presence for cards and the field guide. */
export function presenceLabel(p: number): string {
  return p >= 0.9 ? "very likely" : p >= 0.6 ? "likely" : p >= 0.3 ? "possible" : "uncertain";
}

// ------------------------------------------------------------------ §1a environments

export type EnvClass = "terrestrial" | "marginal" | "shallow" | "deep" | "marine" | "unknown";

/** PBDB `environment` strings (74 in the 2026-11-01 download) → class, by keyword. */
export function envClass(env: string | null): EnvClass {
  const e = (env ?? "").toLowerCase().replace(/"/g, "");
  if (!e) return "unknown";
  if (/deep subtidal/.test(e)) return "marine";                 // below wave base but still on the shelf
  if (/basin|slope|deep|submarine fan/.test(e)) return "deep";
  if (/terrestrial|fluvial|lacustrine|floodplain|channel|crevasse|pond|mire|swamp|eolian|fissure|alluvial|levee|dune|karst|sinkhole|crater lake|spring|cave/.test(e)) return "terrestrial";
  if (/coastal|marginal|estuar|bay|lagoonal$|delta|peritidal|paralic|foreshore/.test(e)) return "marginal";
  if (/shallow|reef|shoal|shoreface|carbonate|offshore shelf|offshore ramp|lagoonal/.test(e)) return "shallow";
  if (/offshore|marine/.test(e)) return "marine";
  return "unknown";
}

export interface Habitats { land: number; nearCoast: number; shelf: number; ocean: number }

export function environmentMatch(c: EnvClass, h: Habitats): number {
  switch (c) {
    case "terrestrial": return h.land;
    case "marginal": return Math.min(1, h.nearCoast + 0.5 * h.land);
    case "shallow": return h.shelf;
    case "deep": return h.ocean;
    case "marine": return Math.min(1, h.shelf + h.ocean);
    case "unknown": return 0.5;
  }
}

/** Share of a tile's area each realm of animal can use. */
export function realmFraction(realm: Realm, h: Habitats): number {
  switch (realm) {
    case "land": return h.land;
    case "sea": return h.shelf + h.ocean;
    case "air": return 1;
    case "water_edge": return Math.min(1, h.nearCoast + 0.3 * h.land);
  }
}

// ------------------------------------------------------------------ §1 roster

export interface TaxonEntry {
  key: string;
  name: string;              // genus (or the finest name the occurrences share)
  rank: string;
  species: string[];
  bodyPlan: AnimalPlan;
  planLabel: string;
  lengthM: number; lengthSource: "rule" | "class default";
  massKg: number;            // always inferred
  weight: number;            // evidence weight (presence only)
  source: "data" | "inferred";
  evidence: { occurrenceIds: number[]; refIds: number[]; count: number; nearestKm: number; ageRanges: [number, number][]; straddlesKpg: boolean; matchedLevel: string };
  realisticPerKm2: number;   // Damuth density for one species of this mass where it lives (per km²)
  presence: number;          // 0–1: provisional chance it lived on this spot at this time, from the evidence (§3)
  expected: number;          // expected individuals on this tile
  count: number;             // individuals placed on this tile (0 for unrendered plans)
  flags: number;
  note: string | null;
}

export interface RosterOptions {
  age: number;
  habitats: Habitats;
  heatStress: number;          // mean over the tile's land (biome §2b)
  aftermath: "impactWinter" | "fernSpike" | null;
  representativeFauna: boolean;
  rng: (key: string) => () => number;   // seeded per taxon (slice, tile, taxon)
}

/** Collapse an occurrence name to its genus (or keep a family-rank name as is). */
export function taxonKey(o: Pick<OccurrenceNear, "name" | "rank">): { key: string; name: string; rank: string } {
  const r = o.rank;
  if (r === "species" || r === "subspecies" || r === "genus" || r === "subgenus") {
    const g = o.name.split(" ")[0]!;
    return { key: g, name: g, rank: "genus" };
  }
  return { key: o.name, name: o.name, rank: r };
}

function poisson(lambda: number, rnd: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(rnd)));
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
}
function gauss(rnd: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
}

const SURVIVORS: ReadonlySet<AnimalPlan> = new Set(["small_tetrapod", "crocodylomorph", "turtle", "fish", "invertebrate"]);

export function buildRoster(occ: readonly OccurrenceNear[], o: RosterOptions): TaxonEntry[] {
  const entries = new Map<string, TaxonEntry>();
  for (const x of occ) {
    const plan = x.body_plan as AnimalPlan;
    const info = PLAN_INFO[plan];
    if (!info) continue;                                        // plants are biome's business
    if (o.age < KPG_MA && (DINOSAUR.has(plan) || KPG_VICTIMS.has(plan))) continue;   // ecology §5 + K–Pg victims
    const envW = environmentMatch(envClass(x.env), o.habitats);
    const w = x.age_fit * Math.exp(-x.distanceKm / KERNEL_KM) * envW;
    if (w < 1e-3) continue;
    const t = taxonKey(x);
    let e = entries.get(t.key);
    if (!e) {
      const len = x.size_hint ?? info.lengthM;
      e = {
        key: t.key, name: t.name, rank: t.rank, species: [], bodyPlan: plan, planLabel: info.label,
        lengthM: len, lengthSource: x.size_hint ? "rule" : "class default",
        massKg: x.size_hint ? info.massKg * (x.size_hint / info.lengthM) ** 3 : info.massKg,
        weight: 0, source: "inferred",
        evidence: { occurrenceIds: [], refIds: [], count: 0, nearestKm: Infinity, ageRanges: [], straddlesKpg: false, matchedLevel: x.matched_level },
        realisticPerKm2: 0, presence: 0, expected: 0, count: 0, flags: 0, note: null,
      };
      entries.set(t.key, e);
    }
    e.weight += w;
    const ev = e.evidence;
    ev.count++;
    if (ev.occurrenceIds.length < 50) ev.occurrenceIds.push(x.id);
    if (x.ref !== null && !ev.refIds.includes(x.ref) && ev.refIds.length < 20) ev.refIds.push(x.ref);
    if (ev.ageRanges.length < 10) ev.ageRanges.push(x.age_range);
    ev.nearestKm = Math.min(ev.nearestKm, x.distanceKm);
    if (x.straddles_kpg) ev.straddlesKpg = true;
    if (x.rank === "species" && !e.species.includes(x.name) && e.species.length < 8) e.species.push(x.name);
    if (x.distanceKm <= R_DATA_KM && !x.straddles_kpg) e.source = "data";
  }

  // keep every data taxon, then the strongest inferred ones up to N_MAX
  const all = [...entries.values()].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  const data = all.filter((e) => e.source === "data");
  const rest = all.filter((e) => e.source !== "data").slice(0, Math.max(0, N_MAX - data.length));
  const roster = [...data, ...rest].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));

  // A family-rank entry (an occurrence identified only to family) is listed, but not drawn when a
  // genus of the same body plan is present: drawing both would double-count the same animals.
  const genusPlans = new Set(roster.filter((e) => e.rank === "genus").map((e) => e.bodyPlan));
  const listedOnly = new Set(roster.filter((e) => e.rank !== "genus" && genusPlans.has(e.bodyPlan)).map((e) => e.key));

  // §3: Damuth's law is a per-species relation (Damuth 1981; applied to one species, T. rex, by
  // Marshall et al. 2021), so each taxon gets the full density for its mass where it lives. Whether
  // it lived on this spot at this moment is a separate question, answered (provisionally) by the
  // evidence: presence = 1 − exp(−weight / PRESENCE_SCALE). Until 2026-11-02 the density was split
  // among all taxa of a trophic level by evidence share, which made weakly evidenced taxa look
  // thousands of times rarer than Damuth's law gives.
  for (const e of roster) {
    const info = PLAN_INFO[e.bodyPlan];
    e.realisticPerKm2 = densityPerKm2(e.massKg, info.trophic);
    e.presence = presenceFromWeight(e.weight);
    let expected = e.realisticPerKm2 * e.presence * TILE_AREA_KM2 * realmFraction(info.realm, o.habitats) * (1 - 0.9 * o.heatStress);
    if (o.aftermath) expected *= SURVIVORS.has(e.bodyPlan) ? (o.aftermath === "impactWinter" ? 0.2 : 0.5) : 0;
    e.expected = expected;
    e.flags = (e.source === "data" ? F.TAXON_FROM_DATA : F.TAXON_INFERRED) | F.COLOUR_GENERATED
      | (e.lengthSource === "rule" ? F.SIZE_FROM_RULE : 0) | (e.evidence.straddlesKpg ? F.STRADDLES_KPG : 0)
      | (o.aftermath ? F.AFTERMATH_RECON : 0);
    if (!info.rendered) { e.note = info.realm === "sea" ? "Lives underwater; not drawn (no underwater view yet)." : "Too small to draw."; continue; }
    if (listedOnly.has(e.key)) { e.note = `Identified only to ${e.rank} level; the genera listed separately are drawn instead.`; continue; }
    let n = poisson(expected, o.rng(e.key));
    if (n === 0 && o.representativeFauna && e.source === "data" && !o.aftermath && realmFraction(info.realm, o.habitats) > 0.05) {
      n = info.group[0];
      e.flags |= F.DENSITY_BOOSTED;
      e.note = "Shown for illustration: at realistic density and presence, none would be expected on this tile.";
    }
    e.count = n;
  }
  return roster;
}

export function fmtArea(km2: number): string {
  if (!Number.isFinite(km2)) return "—";
  if (km2 < 1) return `${Math.round(km2 * 100)} ha`;
  if (km2 < 10_000) return `${km2 < 10 ? km2.toFixed(1) : Math.round(km2).toLocaleString("en-GB")} km²`;
  return `${Math.round(km2 / 1000).toLocaleString("en-GB")},000 km²`;
}
