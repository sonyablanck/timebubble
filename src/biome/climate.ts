// Per-slice climate parameters for the biome rules, each cited. The ice flag is read from
// climate_by_age.json (pipeline §1d) when it is loaded; ICE_POSSIBLE_AGES is the same list, kept as the
// fallback for tests and for data built without that file. The Impact Winter curve lives only here.

/**
 * Slices where brief polar/highland ice is considered possible: the Callovian (166–164 Ma) and the
 * Tithonian to early Barremian (~150–128 Ma) (Scotese et al. 2021). Ice everywhere else is ruled out.
 */
export const ICE_POSSIBLE_AGES: ReadonlySet<number> = new Set([165, 150, 145, 140, 135, 130]);

export function icePossible(age: number, fromJson?: boolean | null): boolean {
  return fromJson ?? ICE_POSSIBLE_AGES.has(age);
}

export type AftermathPhase = "impactWinter" | "fernSpike";
export interface Aftermath { phase: AftermathPhase; year: number }

/**
 * Impact Winter cooling in °C after the Chicxulub impact: at least 26 °C of global surface air
 * cooling, annual means below freezing for ~3 years, recovery over ~30 years
 * (Brugger, Feulner and Petri 2017). Ramps up over year 0–1, holds to year 3, eases to 0 by 30.
 * CHECK: Brugger et al. give spatial patterns; v1 applies the cooling uniformly.
 */
export function impactWinterCooling(year: number): number {
  const PEAK = 26;
  if (year <= 0) return 0;
  if (year < 1) return PEAK * year;
  if (year <= 3) return PEAK;
  if (year >= 30) return 0;
  const t = (year - 3) / 27;
  return PEAK * (1 - t * t * (3 - 2 * t));
}

/** Sunlight factor for the sky (render §6): darkest while the cooling peaks. CHECK against Brugger et al. (2017). */
export function impactWinterLight(year: number): number {
  return 1 - 0.85 * (impactWinterCooling(year) / 26);
}
