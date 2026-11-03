// Shapes of the files the pipeline writes to /public/data (pipeline/PSEUDOCODE.md).
// Field names follow the JSON exactly (snake_case), so nothing is renamed in transit.

export type Registration = "node" | "cell";

export interface GridSpec {
  width: number;
  height: number;
  res: number;
  registration: Registration;
  lat_north: number; // latitude of row 0
  lon_west: number;  // longitude of column 0 (−180 for node grids)
}

export interface TerrainGridSpec {
  nlat: number;
  nlon: number;
  res: number;
  registration: Registration;
  lat_north: number;
  lon_west: number;
  cells_per_chunk: number;  // 100
  stored_per_chunk: number; // 101 (one overlap row south, one overlap column east)
  chunk_rows: number;
  chunk_cols: number;
}

export interface SliceEntry {
  age: number;
  label: string;            // e.g. "150 Ma · Late Jurassic"
  period: string;
  epoch: string;
  aftermath_mode: boolean;
  globe: string;            // all paths relative to the data root
  globe_meta: string;
  continentality: string;
  temperature: string;
  precipitation: string;
  climate_meta: string;
  terrain: string;
  ecology: string | null;   // null until the fossil pipeline steps have run
  grid: GridSpec;
  terrain_grid: TerrainGridSpec;
}

export interface Manifest {
  schema: number;
  pipeline_version: string;
  plate_model: string;
  dem_source: string;
  data_version: string;
  kpg_ma: number;
  climate_params?: string;  // climate_by_age.json, once curated (pipeline §1d)
  credits?: string;         // credits.json, once generated (pipeline §6)
  places?: string;          // places/places.json, the modern-place lookup (pipeline §7)
  slices: SliceEntry[];     // sorted by age, oldest first
}

export interface TerrainIndex extends TerrainGridSpec {
  age: number;
  chunks: Record<string, string>; // "R_C" -> file name in terrain/{age}/
  nodata_filled: number;
  seam_column_max_diff_m: number | null;
  source: string;
  source_file: string;
}

export interface ClimateVarMeta {
  source: string;
  source_file: string;
  source_age: number;
  age_mismatch_myr: number;
  override_reason: string | null;
  units: string;             // "0.01 degC" | "0.01 mm/day"
  scale: number;             // stored integer = value × scale
  min: number;
  max: number;
  area_mean: number;
  nodata_filled: number;
  pole_cells_flattened: number;
  provenance: "inferred";
}

export interface ClimateMeta {
  age: number;
  temp: ClimateVarMeta;
  precip: ClimateVarMeta;
}

/** One slice's entry in climate_by_age.json (pipeline §1d; built by pipeline/curate_climate.py). */
export interface ClimateParams {
  age: number;
  ice_possible?: boolean;
  /** Area-weighted mean of the temperature grid this slice uses (Scotese 2022 dataset). */
  gmst_scotese?: { c: number; grid_age_ma: number; note: string; ref: string };
  /** PhanDA GMST percentiles for the stage containing the slice (Judd et al. 2024). */
  gmst_judd?: { stage: string; stage_ma: [number, number]; p5: number; p16: number; p50: number; p84: number; p95: number; ref: string };
  aftermath?: unknown;
  refs?: string[];
  [key: string]: unknown;
}

/** A fossil occurrence as binned by pipeline §5 (palaeo-coordinates for this slice). */
export interface Occurrence {
  id: number;
  name: string;
  rank: string;
  body_plan: string;
  size_hint: number | null;
  matched_level: string;
  lat: number;
  lon: number;
  env: string | null;
  age_range: [number, number];
  age_fit: number;
  ref: number | null;
  straddles_kpg?: boolean;
}

export interface OccurrenceNear extends Occurrence {
  distanceKm: number;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** credits.json (pipeline §6, written by build_manifest): what the About panel shows. */
export interface Credits {
  datasets: { name: string; version: string | null; doi: string | null; licence: string; ref: string; used_for: string; changes: string }[];
  papers: string[];
  hand_entered: { what: string; ref: string }[];
  software: { name: string; licence: string }[];
  pbdb: { retrieved_utc?: string; data_license?: string; url?: string; access_time?: string } | null;
  references: Record<string, string>;
}
