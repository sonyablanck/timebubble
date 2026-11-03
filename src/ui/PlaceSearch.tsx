import { useEffect, useRef, useState } from "preact/hooks";
import { Geocoder, GEOCODER_ATTRIBUTION, type PlaceResult } from "../places";

// ui/ §1b and places/ §2: "Where was my town?" A modern place search that drops a pin on the slice.
// Searches only on Enter or the button (Nominatim's policy forbids search-as-you-type).

const geocoder = new Geocoder();

export function PlaceSearch({ onChoose }: { onChoose: (r: PlaceResult) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  // "/" on the globe focuses the search box
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.key === "/") { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); abort.current?.abort(); };
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true); setError(null);
    try {
      const r = await geocoder.search(query, ctl.signal);
      if (ctl.signal.aborted) return;
      if (r.length === 1 && r[0]!.source === "coordinates") { setResults(null); onChoose(r[0]!); return; }
      setResults(r);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message || "The place search failed.");
    } finally {
      if (abort.current === ctl) setBusy(false);
    }
  };

  const choose = (r: PlaceResult) => { setResults(null); onChoose(r); };

  return (
    <section class="panel place-search" aria-label="Find a modern place">
      <form role="search" onSubmit={submit}>
        <label for="place-q" class="visually-hidden">Find a modern place</label>
        <input id="place-q" ref={input} type="search" value={query} placeholder="Where was… (a town, or lat, lon)"
          autocomplete="off" spellcheck={false} onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setResults(null); (e.target as HTMLInputElement).blur(); } }} />
        <button type="submit" class="small" disabled={busy || !query.trim()}>{busy ? "Searching…" : "Search"}</button>
      </form>
      {error && <p class="warn" role="alert">{error}</p>}
      {results && (
        results.length === 0
          ? <p class="muted" role="status">No places found. Try adding a country, or type coordinates.</p>
          : <ul class="place-results" aria-label="Places found">
              {results.map((r, i) => (
                <li key={`${r.lat},${r.lon},${i}`}>
                  <button type="button" class="link" onClick={() => choose(r)}>
                    <strong>{r.name}</strong>{r.detail && <span class="muted"> · {r.detail}</span>}
                  </button>
                </li>
              ))}
            </ul>
      )}
      {(results || busy) && (
        <p class="legend-note"><a href={GEOCODER_ATTRIBUTION.href} target="_blank" rel="noopener">{GEOCODER_ATTRIBUTION.text}</a>. Names you search are sent to OpenStreetMap's server.</p>
      )}
    </section>
  );
}
