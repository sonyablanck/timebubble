"""Pipeline step 5: write occurrences per slice in 5° bins, for the app (pipeline §5).

Bin keys name the south-west corner ("35_-5" covers 35–40°N, 5°W–0°); 90°N joins the top bin.
This must match binKey() in src/data/ecology.ts.

  python -m pipeline.bin_occurrences   # raw/classified/{age}.json.gz → public/data/ecology/{age}.json.gz
"""
from __future__ import annotations

import math

import json

from .config import DATA_OUT, slices
from .io_util import _write_bytes, gzip_bytes

BIN_DEG = 5


def bin_key(lat: float, lon: float, deg: int = BIN_DEG) -> str:
    la = min(math.floor(lat / deg) * deg, 90 - deg)
    lo = math.floor(((((lon + 180) % 360) + 360) % 360 - 180) / deg) * deg
    return f"{la}_{lo}"


def to_app(o: dict) -> dict:
    rec = {
        "id": int(o["occurrence_no"]),
        "name": o["accepted_name"],
        "rank": o["accepted_rank"],
        "body_plan": o["body_plan"],
        "size_hint": o.get("size_hint"),
        "matched_level": o["matched_level"],
        "lat": round(o["palaeo_lat"], 3),
        "lon": round(o["palaeo_lon"], 3),
        "env": o.get("environment") or None,
        "age_range": [o["min_ma"], o["max_ma"]],
        "age_fit": o["age_fit"],
        "ref": int(o["reference_no"]) if str(o.get("reference_no") or "").isdigit() else None,
    }
    if o.get("straddles_kpg"):
        rec["straddles_kpg"] = True
    return rec


def bin_slice(occ: list[dict]) -> dict[str, list[dict]]:
    bins: dict[str, list[dict]] = {}
    for o in sorted(occ, key=lambda o: int(o["occurrence_no"])):
        bins.setdefault(bin_key(o["palaeo_lat"], o["palaeo_lon"]), []).append(to_app(o))
    return dict(sorted(bins.items()))


def run() -> None:
    from .classify_taxa import read_classified
    total = 0
    for age in slices():
        bins = bin_slice(read_classified(age))
        n = sum(len(v) for v in bins.values())
        total += n
        # compact, gzipped JSON (deterministic, mtime 0); the app checks for the gzip magic bytes
        text = json.dumps(bins, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
        _write_bytes(DATA_OUT / "ecology" / f"{age}.json.gz", gzip_bytes(text.encode("utf-8")))
        (DATA_OUT / "ecology" / f"{age}.json").unlink(missing_ok=True)   # from older runs
    print(f"binned {total} occurrence-slices into public/data/ecology/; now run build_manifest")


if __name__ == "__main__":
    run()
