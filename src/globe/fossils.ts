import type { EcologyIndex, Occurrence } from "../data";
import { latLonToVec3, vec3ToLatLon } from "./geo";

// globe/ §3: one dot per 5° bin with occurrences, at the occurrences' centroid
// (not the bin centre), area ∝ √count, coloured by dominant group.

export type FossilGroup = "dinosaurs" | "marine reptiles" | "plants" | "other";

const DINOSAUR = new Set(["small_theropod", "large_theropod", "sauropod", "prosauropod", "ornithopod",
  "ceratopsian", "ankylosaur", "stegosaur"]);
const MARINE = new Set(["marine_reptile"]);
const PLANT = new Set(["conifer", "cycad_bennettitalean", "ginkgo", "fern", "horsetail", "early_angiosperm", "seed_fern"]);

export function groupOf(o: Pick<Occurrence, "body_plan">): FossilGroup {
  if (DINOSAUR.has(o.body_plan)) return "dinosaurs";
  if (MARINE.has(o.body_plan)) return "marine reptiles";
  if (PLANT.has(o.body_plan)) return "plants";
  return "other";
}

export const GROUP_COLOURS: Record<FossilGroup, string> = {
  dinosaurs: "#D55E00", "marine reptiles": "#0072B2", plants: "#009E73", other: "#F0E442",
};

export interface FossilDot {
  bin: string;
  lat: number;
  lon: number;          // centroid on the sphere (handles the antimeridian)
  count: number;
  radius: number;       // relative; area ∝ √count
  group: FossilGroup;
  topTaxa: string[];    // up to 5, most frequent first
  ageSpread: [number, number];
}

export function fossilDots(eco: EcologyIndex): FossilDot[] {
  const dots: FossilDot[] = [];
  for (const key of eco.binKeys()) {
    const occ = eco.bin(key);
    if (occ.length === 0) continue;
    let x = 0, y = 0, z = 0;
    const groups = new Map<FossilGroup, number>();
    const names = new Map<string, number>();
    let oldest = -Infinity, youngest = Infinity;
    for (const o of occ) {
      const [a, b, c] = latLonToVec3(o.lat, o.lon);
      x += a; y += b; z += c;
      groups.set(groupOf(o), (groups.get(groupOf(o)) ?? 0) + 1);
      names.set(o.name, (names.get(o.name) ?? 0) + 1);
      oldest = Math.max(oldest, o.age_range[1]);
      youngest = Math.min(youngest, o.age_range[0]);
    }
    const { lat, lon } = vec3ToLatLon([x, y, z]);
    const group = [...groups.entries()].sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0]))[0]![0];
    const topTaxa = [...names.entries()].sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0])).slice(0, 5).map(([n]) => n);
    dots.push({ bin: key, lat, lon, count: occ.length, radius: Math.sqrt(Math.sqrt(occ.length)), group, topTaxa,
      ageSpread: [youngest, oldest] });
  }
  return dots.sort((a, b) => a.bin.localeCompare(b.bin));
}
