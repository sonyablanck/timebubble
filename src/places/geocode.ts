// places/ §2: find a modern place by name with OpenStreetMap's Nominatim, within its usage policy
// (https://operations.osmfoundation.org/policies/nominatim/): search only when the user submits
// (no search-as-you-type), at most one request a second, results cached, attribution shown
// (© OpenStreetMap contributors, ODbL). The browser sends the page as Referer, which identifies
// the app. To switch provider, change GEOCODER_URL (one place) and `parseNominatim` if needed.

export const GEOCODER_URL = "https://nominatim.openstreetmap.org/search";
export const GEOCODER_ATTRIBUTION = { text: "Search by Nominatim · © OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" };
export const MIN_INTERVAL_MS = 1100;
const MAX_RESULTS = 5;

export interface PlaceResult {
  name: string;           // short label, e.g. "Hastings"
  detail: string;         // the rest of the display name, e.g. "East Sussex, England, United Kingdom"
  lat: number;            // present-day
  lon: number;
  source: "osm" | "coordinates";
}

/** "51.5, -0.12", "51.5 -0.12" or "51.5N 0.12W" → a result, without any network request. */
export function parseCoordinates(text: string): PlaceResult | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/i);
  if (!m) return null;
  let lat = Number(m[1]), lon = Number(m[3]);
  if (m[2]?.toUpperCase() === "S") lat = -Math.abs(lat);
  if (m[4]?.toUpperCase() === "W") lon = -Math.abs(lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  const f = (x: number) => (Math.round(x * 1e4) / 1e4).toString();
  return { name: `${f(lat)}, ${f(lon)}`, detail: "coordinates you typed", lat, lon, source: "coordinates" };
}

interface NominatimHit { lat: string; lon: string; display_name: string; name?: string }

export function parseNominatim(hits: NominatimHit[]): PlaceResult[] {
  return hits.flatMap((h) => {
    const lat = Number(h.lat), lon = Number(h.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const parts = h.display_name.split(",").map((s) => s.trim()).filter(Boolean);
    const name = h.name?.trim() || parts[0] || h.display_name;
    const detail = (parts[0] === name ? parts.slice(1) : parts).join(", ");
    return [{ name, detail, lat, lon, source: "osm" as const }];
  });
}

export type GeocodeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class Geocoder {
  private readonly cache = new Map<string, PlaceResult[]>();
  private last = -Infinity;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fetcher: GeocodeFetch = (u, i) => fetch(u, i),
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly language: () => string = () => navigator.language || "en",
  ) {}

  /** Coordinates are answered locally; names go to Nominatim, one request at a time, ≥ 1.1 s apart. */
  search(text: string, signal?: AbortSignal): Promise<PlaceResult[]> {
    const q = text.trim().replace(/\s+/g, " ");
    if (!q) return Promise.resolve([]);
    const coords = parseCoordinates(q);
    if (coords) return Promise.resolve([coords]);
    const key = q.toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const run = this.queue.then(async () => {
      const cached = this.cache.get(key);
      if (cached) return cached;
      const wait = this.last + MIN_INTERVAL_MS - this.now();
      if (wait > 0) await this.sleep(wait);
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      this.last = this.now();
      const url = `${GEOCODER_URL}?${new URLSearchParams({ q, format: "jsonv2", limit: String(MAX_RESULTS), "accept-language": this.language() })}`;
      const res = await this.fetcher(url, { signal, headers: { Accept: "application/json" } });
      if (res.status === 429) throw new Error("The place search is busy. Please try again in a minute.");
      if (!res.ok) throw new Error(`The place search failed (HTTP ${res.status}).`);
      const results = parseNominatim((await res.json()) as NominatimHit[]);
      this.cache.set(key, results);
      return results;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
