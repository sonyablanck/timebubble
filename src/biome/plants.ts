// Plant mix (biome §5): nearby PBDB plant occurrences, weighted by age fit and distance, blended toward
// an age-aware prior (nudged by biome) where the evidence is thin; with no plant fossils nearby the mix
// is the prior alone, tagged inferred / PLANTS_FROM_PRIOR. The hard age constraints of DESIGN §8 are
// applied last. The prior is qualitative (broad Mesozoic floral composition).

import type { OccurrenceNear } from "../data";
import { Biome } from "./rules";

export type PlantPlan = "conifer" | "cycad_bennettitalean" | "ginkgo" | "fern" | "horsetail" | "seed_fern" | "early_angiosperm";
export const PLANT_PLANS: readonly PlantPlan[] = ["conifer", "cycad_bennettitalean", "ginkgo", "fern", "horsetail", "seed_fern", "early_angiosperm"];
export const PLANT_NAMES: Record<PlantPlan, string> = {
  conifer: "conifers", cycad_bennettitalean: "cycads and bennettitaleans", ginkgo: "ginkgos", fern: "ferns",
  horsetail: "horsetails", seed_fern: "seed ferns", early_angiosperm: "early flowering plants",
};

export interface PlantEvidence {
  count: number;            // plant occurrences used
  nearestKm: number | null;
  dataShare: number;        // 0..1: how much of the mix comes from the occurrences
  droppedByAge: number;     // occurrences that broke an age constraint (data-quality note)
}
export interface PlantMix { weights: Record<PlantPlan, number>; source: "data" | "prior"; evidence?: PlantEvidence }

export const PLANT_RADIUS_KM = 500;
const DISTANCE_SCALE_KM = 250;
const MIN_EVIDENCE = 2;   // weighted occurrences at which data and prior count equally

/**
 * biome §5: the mix from nearby plant occurrences (weighted by age fit and distance), blended
 * toward the prior when evidence is thin. Occurrences that break the DESIGN §8 age constraints
 * are dropped and counted, not rendered.
 */
export function plantMixFor(age: number, biome: Biome, plants: readonly OccurrenceNear[] | null): PlantMix {
  const prior = plantPrior(age, biome);
  if (!plants || plants.length === 0) return { ...prior, evidence: { count: 0, nearestKm: null, dataShare: 0, droppedByAge: 0 } };
  const w = zeroMix();
  let total = 0, count = 0, dropped = 0, nearest = Infinity;
  for (const o of plants) {
    const plan = o.body_plan as PlantPlan;
    if (!(plan in w)) continue;
    if (plan === "early_angiosperm" && age > 130) { dropped++; continue; }
    const x = o.age_fit * Math.exp(-o.distanceKm / DISTANCE_SCALE_KM);
    w[plan] += x;
    total += x;
    count++;
    nearest = Math.min(nearest, o.distanceKm);
  }
  if (total === 0) return { ...prior, evidence: { count: 0, nearestKm: null, dataShare: 0, droppedByAge: dropped } };
  const share = total / (total + MIN_EVIDENCE);
  const out = zeroMix();
  for (const k of PLANT_PLANS) out[k] = share * (w[k] / total) + (1 - share) * prior.weights[k];
  if (age > 130) out.early_angiosperm = 0;
  let sum = 0;
  for (const k of PLANT_PLANS) sum += out[k];
  for (const k of PLANT_PLANS) out[k] /= sum;
  return { weights: out, source: share > 0.5 ? "data" : "prior", evidence: { count, nearestKm: nearest, dataShare: share, droppedByAge: dropped } };
}

function zeroMix(): Record<PlantPlan, number> {
  return { conifer: 0, cycad_bennettitalean: 0, ginkgo: 0, fern: 0, horsetail: 0, seed_fern: 0, early_angiosperm: 0 };
}

/** Share of flowering plants: none before 130 Ma, rising to dominance only after ~90 Ma (DESIGN §8). */
export function angiospermShare(age: number): number {
  if (age >= 130) return 0;
  if (age >= 90) return 0.4 * ((130 - age) / 40);
  return Math.min(0.55, 0.4 + 0.15 * ((90 - age) / 20));
}

export function plantPrior(age: number, biome: Biome): PlantMix {
  const w: Record<PlantPlan, number> = age > 201
    ? { conifer: 0.35, seed_fern: 0.2, fern: 0.2, horsetail: 0.1, cycad_bennettitalean: 0.1, ginkgo: 0.05, early_angiosperm: 0 }
    : age > 145
      ? { conifer: 0.35, cycad_bennettitalean: 0.2, fern: 0.2, ginkgo: 0.1, horsetail: 0.08, seed_fern: 0.07, early_angiosperm: 0 }
      : { conifer: 0.38, fern: 0.22, cycad_bennettitalean: 0.17, ginkgo: 0.08, horsetail: 0.06, seed_fern: 0.03, early_angiosperm: 0 };
  // biome nudges: wet lowlands favour ferns and horsetails; dry ground favours conifers and cycads
  const mul: Partial<Record<PlantPlan, number>> =
    biome === Biome.CoastalSwamp || biome === Biome.FloodplainForest ? { fern: 1.6, horsetail: 2.5 }
      : biome === Biome.Desert || biome === Biome.AridScrub ? { conifer: 1.4, cycad_bennettitalean: 1.5, fern: 0.4, horsetail: 0.2 }
        : biome === Biome.PolarForest ? { conifer: 1.4, ginkgo: 2, cycad_bennettitalean: 0.4 }
          : biome === Biome.FernOpenland ? { fern: 2 }
            : {};
  for (const [k, v] of Object.entries(mul)) w[k as PlantPlan] *= v!;
  return { weights: finish(w, age), source: "prior" };
}

/** Fern Spike flora (biome §7; Vajda et al. 2004). Impact Winter has no living plants. */
export function aftermathMix(phase: "impactWinter" | "fernSpike"): PlantMix {
  const w: Record<PlantPlan, number> = { conifer: 0, cycad_bennettitalean: 0, ginkgo: 0, fern: 0, horsetail: 0, seed_fern: 0, early_angiosperm: 0 };
  if (phase === "fernSpike") { w.fern = 0.85; w.horsetail = 0.1; w.early_angiosperm = 0.05; }
  return { weights: w, source: "prior" };
}

/** Apply the age constraints (DESIGN §8) and normalise. No grass body plan exists at all. */
function finish(w: Record<PlantPlan, number>, age: number): Record<PlantPlan, number> {
  const a = angiospermShare(age);
  let rest = 0;
  for (const k of PLANT_PLANS) if (k !== "early_angiosperm") rest += w[k];
  for (const k of PLANT_PLANS) if (k !== "early_angiosperm") w[k] = (w[k] / rest) * (1 - a);
  w.early_angiosperm = a;
  return w;
}

export function topPlants(mix: PlantMix, n = 3): [PlantPlan, number][] {
  return (Object.entries(mix.weights) as [PlantPlan, number][]).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]).slice(0, n);
}
