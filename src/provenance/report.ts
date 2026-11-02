// provenance/ §5: the provenance report and "cite this view". A research user can reproduce and
// cite exactly what they saw: the report lists the datasets and versions, the view (with a link
// that reopens it), the climate grids used, every taxon with its evidence and flags, the plant mix,
// the in-view shares and the full references. Pure functions: the same view and data version give
// byte-identical output (no timestamps), and nothing leaves the browser.

import referencesMd from "../../REFERENCES.md?raw";
import type { ClimateMeta } from "../data";
import type { PlantMix } from "../biome/plants";
import { PLANT_NAMES, PLANT_PLANS } from "../biome/plants";
import type { TaxonEntry } from "../ecology/roster";
import { FLAG_INFO, flagNames, levelOf, LEVEL_NAMES } from "./flags";

export const APP_NAME = "Time Bubble";
export const APP_VERSION = "0.1.0";   // keep in step with package.json

export interface ReportInput {
  view: {
    url: string;                       // absolute link that reopens this view
    sliceAge: number;
    aftermath: { phase: string; year: number } | null;
    tile: { row: number; col: number };
    lat: number; lon: number;          // palaeo-coordinates of the viewer
    altitudeM: number; headingDeg: number; pitchDeg: number;
    mode: "walk" | "fly";
    overlay: { mode: string; focus: string | null };
    representativeFauna: boolean;
  };
  manifest: {
    data_version: string; pipeline_version: string; plate_model: string; dem_source: string;
    pbdb?: { retrieved_utc?: string; data_license?: string; url?: string; access_time?: string } | null;
  };
  climate: ClimateMeta | null;
  roster: readonly TaxonEntry[];
  plantMix: PlantMix | null;
  shares: { data: number; inferred: number; generated: number; samples: number } | null;
}

export interface Reference { key: string; text: string }

/** Every `- **[key]** text` entry in REFERENCES.md, Markdown emphasis removed. */
export function parseReferences(md: string = referencesMd): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of md.split("\n")) {
    const m = /^- \*\*\[([a-z0-9]+)\]\*\*\s+(.*)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!.replace(/\*\*?/g, "").replace(/\s+/g, " ").trim());
  }
  return out;
}

/** Datasets and methods every view rests on. */
const BASE_REFS = ["scotese2024data", "scotese2024", "kocsis2021", "scotese2022data", "scotese2021", "valdes2021", "peel2007", "pbdb"];

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function buildReport(input: ReportInput, refs: Map<string, string> = parseReferences()) {
  const { view, manifest, climate, roster, plantMix, shares } = input;
  const keys = new Set(BASE_REFS);
  if (roster.length) { keys.add("damuth1981"); keys.add("marshall2021"); }
  for (const t of roster) for (const n of flagNames(t.flags)) for (const k of FLAG_INFO[n].refs) keys.add(k);
  if (view.aftermath) { keys.add("brugger2017"); keys.add("vajda2004"); }
  const references: Reference[] = [...keys].sort().map((k) => ({ key: k, text: refs.get(k) ?? `(missing from REFERENCES.md: ${k})` }));

  return {
    report: "Time Bubble provenance report",
    format: 1,
    app: { name: APP_NAME, version: APP_VERSION },
    data: {
      data_version: manifest.data_version, pipeline_version: manifest.pipeline_version,
      dem: manifest.dem_source, plate_model: manifest.plate_model,
      pbdb: manifest.pbdb ? { retrieved: manifest.pbdb.retrieved_utc ?? null, licence: manifest.pbdb.data_license ?? null, query: manifest.pbdb.url ?? null } : null,
    },
    view: {
      link: view.url,
      slice_ma: view.sliceAge,
      aftermath: view.aftermath,
      tile: view.tile,
      palaeo_lat: r4(view.lat), palaeo_lon: r4(view.lon),
      altitude_m: r2(view.altitudeM), heading_deg: r2(view.headingDeg), pitch_deg: r2(view.pitchDeg), mode: view.mode,
      overlay: view.overlay,
      settings: { representative_fauna: view.representativeFauna },
    },
    levels: {
      rule: "Levels derive from provenance flags (src/provenance/flags.ts). Terrain: data below 20 m and 25% of the local amplitude of invented relief, generated from 60 m or 75%, or where invented detail moved the coastline; inferred between. Biomes and climate: inferred. Taxa: data with a fossil within 150 km in this slice window, otherwise inferred. Sky, light, colours, poses and fine positions: generated.",
      in_view: shares ? { data: r4(shares.data), inferred: r4(shares.inferred), generated: r4(shares.generated), samples: shares.samples } : null,
    },
    climate: climate ? {
      temperature: { source: climate.temp.source, file: climate.temp.source_file, source_age_ma: climate.temp.source_age, age_mismatch_myr: climate.temp.age_mismatch_myr, override: climate.temp.override_reason, level: "inferred" },
      precipitation: { source: climate.precip.source, file: climate.precip.source_file, source_age_ma: climate.precip.source_age, age_mismatch_myr: climate.precip.age_mismatch_myr, override: climate.precip.override_reason, level: "inferred" },
    } : null,
    plants: plantMix ? {
      source: plantMix.source,
      mix: Object.fromEntries(PLANT_PLANS.filter((p) => plantMix.weights[p] > 0).map((p) => [PLANT_NAMES[p], r4(plantMix.weights[p])])),
      occurrences: plantMix.evidence?.count ?? 0,
      nearest_km: plantMix.evidence?.nearestKm != null ? r2(plantMix.evidence.nearestKm) : null,
    } : null,
    taxa: roster.map((t) => ({
      name: t.name, rank: t.rank, species: t.species, body_plan: t.planLabel,
      level: LEVEL_NAMES[levelOf("animal", t.flags)],
      flags: flagNames(t.flags),
      occurrences: t.evidence.count, nearest_km: r2(t.evidence.nearestKm),
      occurrence_ids: t.evidence.occurrenceIds, reference_ids: t.evidence.refIds,
      age_ranges_ma: t.evidence.ageRanges,
      length_m: r2(t.lengthM), length_source: t.lengthSource, mass_kg_estimated: Math.round(t.massKg),
      density_per_km2_where_present: Number(t.realisticPerKm2.toPrecision(4)),
      presence: r4(t.presence), expected_on_tile: r4(t.expected), drawn_on_tile: t.count,
      note: t.note,
    })),
    references,
  };
}

export type ProvenanceReport = ReturnType<typeof buildReport>;

/** The report as stable, pretty-printed JSON. */
export function reportJson(r: ProvenanceReport): string {
  return JSON.stringify(r, null, 2) + "\n";
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(" ") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per taxon, for spreadsheets; the view and data versions lead as comment lines. */
export function reportCsv(r: ProvenanceReport): string {
  const head = [
    `# ${r.report}; ${r.app.name} ${r.app.version}; data ${r.data.data_version}; ${r.view.slice_ma} Ma; palaeo ${r.view.palaeo_lat}, ${r.view.palaeo_lon}; ${r.view.link}`,
  ];
  const cols = ["name", "rank", "body_plan", "level", "flags", "occurrences", "nearest_km", "presence", "density_per_km2_where_present",
    "expected_on_tile", "drawn_on_tile", "length_m", "length_source", "mass_kg_estimated", "occurrence_ids", "reference_ids"] as const;
  const rows = r.taxa.map((t) => cols.map((c) => csvCell(t[c])).join(","));
  return [...head, cols.join(","), ...rows].join("\n") + "\n";
}

/** "Cite this view": one paragraph, Harvard-style references to the underlying datasets. */
export function citeThisView(r: ProvenanceReport): string {
  const lat = `${Math.abs(r.view.palaeo_lat).toFixed(2)}°${r.view.palaeo_lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(r.view.palaeo_lon).toFixed(2)}°${r.view.palaeo_lon >= 0 ? "E" : "W"}`;
  const after = r.view.aftermath ? `, Aftermath: ${r.view.aftermath.phase === "impactWinter" ? `Impact Winter, year ${r.view.aftermath.year}` : "Fern Spike"}` : "";
  const pbdbDate = r.data.pbdb?.retrieved ? ` (accessed ${r.data.pbdb.retrieved})` : "";
  return `${r.app.name} v${r.app.version} (data ${r.data.data_version}), ${r.view.slice_ma} Ma${after}, ${lat} ${lon} (palaeo-coordinates), tile ${r.view.tile.row}/${r.view.tile.col}. `
    + `Built on the PALEOMAP PaleoDEMs and plate model ${r.data.plate_model.replace(/ \(.*\)$/, "").replace(/^PALEOMAP /, "")} (Scotese et al., 2024), `
    + `palaeotemperature and precipitation grids (Scotese, 2022; Valdes, Scotese and Lunt, 2021) and the Paleobiology Database${pbdbDate}. `
    + `View: ${r.view.link}. Provenance report: ${r.taxa.length} taxa with occurrence and reference IDs, climate sources and levels.`;
}
