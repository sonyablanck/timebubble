"""Step 1d: write pipeline/climate_by_age.json, the hand-curated climate parameters per slice
(pipeline/PSEUDOCODE.md §1d). Run once when a source changes; the JSON is committed and
build_manifest copies it to public/data as is.

Usage:  python -m pipeline.curate_climate --phanda path/to/PhanDA_GMSTandCO2_percentiles.csv

Per slice:
  ice_possible   true only at 165 Ma and 130–150 Ma (Scotese et al. 2021)
  gmst_scotese   area-weighted mean of the temperature grid the slice uses (Scotese 2022 dataset,
                 from public/data/globe/{age}.climate.json), with the source interval
  gmst_judd      PhanDA GMST percentiles (5/16/50/84/95) for the geological stage containing the
                 slice age (Judd et al. 2024). The PhanDA repository has no licence file, so only
                 the values are stored, with the citation (DESIGN §12)
  aftermath      65 Ma only: Impact Winter and Fern Spike constants (Brugger, Feulner and Petri
                 2017; Vajda et al. 2004)
  refs           citation keys into REFERENCES.md

INVARIANT: every numeric value carries a ref (checked by pipeline/tests and build_manifest).
"""
from __future__ import annotations

import argparse
import csv
import logging
from pathlib import Path

from pipeline import config
from pipeline.io_util import read_json, write_json

log = logging.getLogger("curate_climate")

ICE_POSSIBLE = {165, 150, 145, 140, 135, 130}
OUT = Path(__file__).resolve().parent / "climate_by_age.json"


def judd_stages(path: Path) -> list[dict]:
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    need = {"Stage", "UpperAge", "LowerAge", "GMST_05", "GMST_16", "GMST_50", "GMST_84", "GMST_95"}
    if not rows or not need <= rows[0].keys():
        raise ValueError(f"{path}: expected columns {sorted(need)}")
    return rows


def stage_for(age: float, rows: list[dict]) -> dict:
    """The stage whose range contains the age (upper ≤ age < lower; the base is in the older stage)."""
    for r in rows:
        if float(r["UpperAge"]) <= age < float(r["LowerAge"]):
            return r
    raise ValueError(f"no PhanDA stage contains {age} Ma")


def curate(phanda: Path, data_out: Path) -> list[dict]:
    rows = judd_stages(phanda)
    out = []
    for age in sorted(config.slices(), reverse=True):
        side = data_out / "globe" / f"{age}.climate.json"
        if not side.exists():
            raise FileNotFoundError(f"{side}: run ingest_climate first")
        t = read_json(side)["temp"]
        st = stage_for(float(age), rows)
        e = {
            "age": age,
            "ice_possible": age in ICE_POSSIBLE,
            "gmst_scotese": {
                "c": t["area_mean"], "grid_age_ma": t["source_age"],
                "note": "area-weighted mean of the temperature grid used for this slice"
                        + (" (the 60 Ma grid; see the climate sidecar's override)" if t["source_age"] != age else ""),
                "ref": "scotese2022data",
            },
            "gmst_judd": {
                "stage": st["Stage"], "stage_ma": [round(float(st["UpperAge"]), 3), round(float(st["LowerAge"]), 3)],
                **{f"p{p}": round(float(st[f"GMST_{p:02d}"]), 2) for p in (5, 16, 50, 84, 95)},
                "ref": "judd2024",
            },
            "refs": ["scotese2021", "scotese2022data", "judd2024"],
        }
        if age == 65:
            e["aftermath"] = {
                "impact_winter": {"peak_cooling_c": 26, "subfreezing_years": 3, "recovery_years": 30, "ref": "brugger2017"},
                "fern_spike": {"duration_kyr": [8, 20], "ref": "vajda2004"},
            }
            e["refs"] += ["brugger2017", "vajda2004"]
        out.append(e)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--phanda", type=Path, required=True, help="PhanDA_GMSTandCO2_percentiles.csv (Judd et al. 2024)")
    ap.add_argument("--data", type=Path, default=config.DATA_OUT)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    params = curate(args.phanda, args.data)
    write_json(args.out, params)
    log.info("climate_by_age: %d slices -> %s", len(params), args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
