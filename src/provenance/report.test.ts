import { describe, expect, it } from "vitest";
import { buildReport, citeThisView, parseReferences, reportCsv, reportJson, type ReportInput } from "./report";
import { buildRoster, type Habitats } from "../ecology/roster";
import { FLAG_INFO } from "./flags";
import type { OccurrenceNear } from "../data";

const H: Habitats = { land: 0.9, nearCoast: 0.1, shelf: 0.1, ocean: 0 };
const occ = (name: string, body_plan: string, distanceKm: number, id: number): OccurrenceNear => ({
  id, name, rank: "species", body_plan, size_hint: null, matched_level: "family",
  lat: 0, lon: 0, env: "fluvial indet.", age_range: [68, 66], age_fit: 1, ref: id + 1000, distanceKm,
});
const roster = buildRoster([occ("Triceratops horridus", "ceratopsian", 69, 1), occ("Tyrannosaurus rex", "large_theropod", 300, 2)], {
  age: 70, habitats: H, heatStress: 0, aftermath: null, representativeFauna: true,
  rng: () => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); },
});
const input: ReportInput = {
  view: {
    url: "https://example.org/?age=70&walk=54.9,-80.3", sliceAge: 70, aftermath: null, tile: { row: 2289, col: 2491 },
    lat: 54.90012, lon: -80.30044, altitudeM: 163.2, headingDeg: 284.4, pitchDeg: -3, mode: "walk",
    overlay: { mode: "source", focus: null }, representativeFauna: true,
  },
  manifest: { data_version: "fcde077f2a8386c9", pipeline_version: "0.1.0", plate_model: "PALEOMAP v19o_r1d (Scotese et al. 2024)", dem_source: "PALEOMAP PaleoDEMs",
    pbdb: { retrieved_utc: "2026-11-01", data_license: "Creative Commons CC0", url: "http://paleobiodb.org/data1.2/occs/list.csv" } },
  climate: null, roster, plantMix: null, shares: { data: 0.6, inferred: 0.3, generated: 0.1, samples: 4000 },
};

describe("provenance report and cite this view (provenance §5)", () => {
  it("INVARIANT: every ref key the app uses resolves to a REFERENCES.md entry", () => {
    const refs = parseReferences();
    for (const f of Object.values(FLAG_INFO)) for (const k of f.refs) expect(refs.has(k), k).toBe(true);
    const r = buildReport(input);
    for (const x of r.references) expect(x.text, x.key).not.toMatch(/missing from REFERENCES/);
    expect(r.references.map((x) => x.key)).toEqual(expect.arrayContaining(["scotese2024data", "pbdb", "damuth1981", "marshall2021"]));
    expect(refs.get("damuth1981")).toMatch(/^Damuth, J\. \(1981\) 'Population density and body size in mammals', Nature/);
  });

  it("INVARIANT: the report for the same view and data version is byte-identical", () => {
    expect(reportJson(buildReport(input))).toBe(reportJson(buildReport(input)));
    expect(reportCsv(buildReport(input))).toBe(reportCsv(buildReport(input)));
    expect(reportJson(buildReport(input))).not.toMatch(/generated_at|timestamp/);
  });

  it("lists every taxon with its evidence IDs, level and flags", () => {
    const r = buildReport(input);
    const t = r.taxa.find((x) => x.name === "Triceratops")!;
    expect(t.level).toBe("data");
    expect(t.flags).toContain("TAXON_FROM_DATA");
    expect(t.occurrence_ids).toEqual([1]);
    expect(t.reference_ids).toEqual([1001]);
    expect(r.taxa.find((x) => x.name === "Tyrannosaurus")!.level).toBe("inferred");
    const csv = reportCsv(r).split("\n");
    expect(csv[1]).toMatch(/^name,rank,body_plan,level,flags/);
    expect(csv.some((l) => l.startsWith("Triceratops,genus,ceratopsian,data,"))).toBe(true);
  });

  it("the citation names the version, data version, slice, place, sources and the link", () => {
    const c = citeThisView(buildReport(input));
    expect(c).toMatch(/^Time Bubble v0\.1\.0 \(data fcde077f2a8386c9\), 70 Ma, 54\.90°N 80\.30°W \(palaeo-coordinates\)/);
    expect(c).toMatch(/Scotese et al\., 2024/);
    expect(c).toMatch(/Paleobiology Database \(accessed 2026-11-01\)/);
    expect(c).toContain("https://example.org/?age=70&walk=54.9,-80.3");
  });
});
