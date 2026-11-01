// provenance/ §1–2: the single registry of provenance flags, and the one function
// that turns flags into a level. Every module imports flag constants from here;
// no module may define its own bits or label something "data" by hand.

export enum Level { DATA = 0, INFERRED = 1, GENERATED = 2 }

export type Flags = number; // u32 bitmask

export const F = {
  DATA_SURFACE: 1 << 0,
  GENERATED_RELIEF: 1 << 1,
  GENERATED_COAST: 1 << 2,
  BIOME_INFERRED: 1 << 3,
  PLANTS_FROM_DATA: 1 << 4,
  PLANTS_FROM_PRIOR: 1 << 5,
  THERMAL_EXCLUSION: 1 << 6,
  ICE_CONTESTED: 1 << 7,
  TAXON_FROM_DATA: 1 << 8,
  TAXON_INFERRED: 1 << 9,
  SIZE_FROM_RULE: 1 << 10,
  DENSITY_BOOSTED: 1 << 11,
  COLOUR_GENERATED: 1 << 12,
  STRADDLES_KPG: 1 << 13,
  AFTERMATH_RECON: 1 << 14,
  CLIMATE_AGE_MISMATCH: 1 << 15,
  SKY_GENERATED: 1 << 16,
} as const;

export type FlagName = keyof typeof F;

export type FeatureKind = "terrain" | "biome" | "plant" | "animal" | "sky" | "water";

export interface FlagInfo { short: string; long: string; refs: string[] }

export const FLAG_INFO: Record<FlagName, FlagInfo> = {
  DATA_SURFACE: { short: "Data surface", long: "The base surface is interpolated from the 0.1° PaleoDEM (cells about 11 km across).", refs: ["scotese2024data"] },
  GENERATED_RELIEF: { short: "Generated relief", long: "Fine-scale relief here is generated noise. Its average over each 0.1° cell is forced to match the source elevation, but its shape is invented.", refs: [] },
  GENERATED_COAST: { short: "Generated coastline", long: "Fine-scale detail moved this point across sea level. The source data (≈11 km cells) put the coastline nearby, but not exactly here.", refs: ["scotese2024data"] },
  BIOME_INFERRED: { short: "Inferred biome", long: "The biome comes from modelled climate and stated rules, not from observation.", refs: ["scotese2021", "valdes2021", "peel2007"] },
  PLANTS_FROM_DATA: { short: "Plants from fossils", long: "The plant mix is drawn mostly from nearby plant fossil occurrences.", refs: ["pbdb"] },
  PLANTS_FROM_PRIOR: { short: "Plants from prior", long: "Nearby plant fossils are scarce, so the plant mix leans on an age-aware prior.", refs: [] },
  THERMAL_EXCLUSION: { short: "Heat stress", long: "Modelled temperatures here are high enough to exclude much life, as in the Early Triassic tropics.", refs: ["sun2012"] },
  ICE_CONTESTED: { short: "Contested ice", long: "Ice is shown in an interval where its existence is debated.", refs: ["scotese2021"] },
  TAXON_FROM_DATA: { short: "Taxon from data", long: "This taxon has a fossil occurrence within 150 km in this time window.", refs: ["pbdb"] },
  TAXON_INFERRED: { short: "Taxon inferred", long: "This taxon is borrowed from 150–750 km away, or its age range straddles the K–Pg boundary.", refs: ["pbdb"] },
  SIZE_FROM_RULE: { short: "Size from rule", long: "Body size comes from a curated rule for this taxon; otherwise a body-plan default is used.", refs: [] },
  DENSITY_BOOSTED: { short: "Density boosted", long: "Shown for illustration: at realistic densities this animal would rarely appear on a single tile.", refs: ["damuth1981", "marshall2021"] },
  COLOUR_GENERATED: { short: "Colour generated", long: "Colour is invented: it is almost never preserved in fossils.", refs: [] },
  STRADDLES_KPG: { short: "Straddles K–Pg", long: "This occurrence's age range crosses the 66 Ma boundary, so its placement after the extinction is uncertain.", refs: ["pbdb"] },
  AFTERMATH_RECON: { short: "Aftermath reconstruction", long: "Aftermath mode overrides the normal world with a reconstruction of the impact's effects.", refs: ["brugger2017", "vajda2004"] },
  CLIMATE_AGE_MISMATCH: { short: "Climate age mismatch", long: "The temperature or precipitation grid comes from an interval more than 3 Myr from this slice.", refs: [] },
  SKY_GENERATED: { short: "Sky generated", long: "Sky, light and weather are generated for atmosphere.", refs: [] },
};

export function flagNames(flags: Flags): FlagName[] {
  return (Object.keys(F) as FlagName[]).filter((k) => (flags & F[k]) !== 0);
}

/**
 * The level of a feature, derived from its flags (provenance §2). Pure and total.
 * `strength` (terrain only) is the share of generated relief, 0..1.
 */
export function levelOf(kind: FeatureKind, flags: Flags, strength = 0): Level {
  let level: Level;
  switch (kind) {
    case "terrain":
      if (flags & F.GENERATED_COAST) level = Level.GENERATED;
      else level = strength < 0.25 ? Level.DATA : strength < 0.75 ? Level.INFERRED : Level.GENERATED;
      break;
    case "biome":
      level = Level.INFERRED;
      break;
    case "plant":
      level = flags & F.PLANTS_FROM_DATA ? Level.DATA : Level.INFERRED;
      break;
    case "animal":
      level = flags & F.TAXON_FROM_DATA ? Level.DATA : Level.INFERRED;
      break;
    case "sky":
    case "water":
      level = Level.GENERATED;
      break;
  }
  if (flags & F.AFTERMATH_RECON) level = Math.max(level, Level.INFERRED) as Level;
  return level;
}

export const LEVEL_NAMES = ["data", "inferred", "generated"] as const;
