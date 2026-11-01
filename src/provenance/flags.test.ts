import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { F, FLAG_INFO, flagNames, Level, levelOf, type FeatureKind, type FlagName } from "./flags";

const KINDS: FeatureKind[] = ["terrain", "biome", "plant", "animal", "sky", "water"];

describe("flag registry (provenance §1–2)", () => {
  it("has 17 distinct single bits, 0–16", () => {
    const bits = Object.values(F);
    expect(new Set(bits).size).toBe(17);
    expect(bits.every((b) => b > 0 && (b & (b - 1)) === 0)).toBe(true);
    expect(Math.max(...bits)).toBe(1 << 16);
  });

  it("INVARIANT: levelOf is pure and total", () => {
    for (const kind of KINDS) {
      for (let flags = 0; flags < 1 << 17; flags += 97) {
        for (const s of [0, 0.3, 0.9]) {
          const l = levelOf(kind, flags, s);
          expect([Level.DATA, Level.INFERRED, Level.GENERATED]).toContain(l);
          expect(levelOf(kind, flags, s)).toBe(l);
        }
      }
    }
  });

  it("INVARIANT: generated coastline, sky and water never report DATA", () => {
    expect(levelOf("terrain", F.DATA_SURFACE | F.GENERATED_COAST, 0)).toBe(Level.GENERATED);
    expect(levelOf("sky", F.SKY_GENERATED)).toBe(Level.GENERATED);
    expect(levelOf("water", 0)).toBe(Level.GENERATED);
  });

  it("grades terrain by the share of generated relief", () => {
    expect(levelOf("terrain", F.DATA_SURFACE, 0.1)).toBe(Level.DATA);
    expect(levelOf("terrain", F.DATA_SURFACE | F.GENERATED_RELIEF, 0.5)).toBe(Level.INFERRED);
    expect(levelOf("terrain", F.DATA_SURFACE | F.GENERATED_RELIEF, 0.8)).toBe(Level.GENERATED);
    expect(levelOf("terrain", F.DATA_SURFACE | F.AFTERMATH_RECON, 0)).toBe(Level.INFERRED);
  });

  it("names flags and explains every one", () => {
    expect(flagNames(F.DATA_SURFACE | F.GENERATED_COAST)).toEqual(["DATA_SURFACE", "GENERATED_COAST"]);
    for (const k of Object.keys(F) as FlagName[]) expect(FLAG_INFO[k].long.length).toBeGreaterThan(20);
  });

  it("INVARIANT: every ref key resolves in REFERENCES.md", () => {
    const refs = readFileSync(join(__dirname, "..", "..", "REFERENCES.md"), "utf8");
    for (const info of Object.values(FLAG_INFO)) for (const r of info.refs) expect(refs).toContain(`[${r}]`);
  });
});
