"""Report: share of occurrences from terrestrial environments that land on DEM land, per slice.

The PaleoDEM coastlines were fitted to PBDB localities (Kocsis and Scotese 2021), so a high rate
confirms that rotation (PALEOMAP v19o_r1d) and DEMs agree (DESIGN A12). Report only.
  python -m pipeline.checks.fossil_land_check
"""
from __future__ import annotations

import gzip
import json

import numpy as np

from pipeline.config import DATA_OUT, DATA_RAW, slices
from pipeline.io_util import read_int16

TERRESTRIAL = ("terrestrial", "fluvial", "lacustrine", "eolian", "cave", "fissure", "floodplain", "channel",
               "pond", "crevasse", "dune", "levee", "mire", "swamp", "paleosol", "spring", "tar")


def is_terrestrial(env: str) -> bool:
    e = (env or "").lower()
    return any(k in e for k in TERRESTRIAL) and "marine" not in e


def main() -> dict:
    out = {}
    for age in slices():
        meta = json.loads((DATA_OUT / "globe" / f"{age}.json").read_text())
        g = read_int16(DATA_OUT / "globe" / f"{age}.i16.gz", (meta["height"], meta["width"]))
        with gzip.open(DATA_RAW / "rotated" / f"{age}.json.gz", "rt") as f:
            occ = [o for o in json.load(f) if is_terrestrial(o.get("environment", ""))]
        if not occ:
            continue
        lat = np.array([o["palaeo_lat"] for o in occ]); lon = np.array([o["palaeo_lon"] for o in occ])
        r = np.clip(np.rint(meta["lat_north"] - lat).astype(int), 0, meta["height"] - 1)
        c = np.rint(lon - meta["lon_west"]).astype(int) % meta["width"]
        elev = g[r, c]
        out[age] = {"terrestrial": len(occ), "on_land": round(float((elev >= 0).mean()), 3),
                    "on_land_or_shelf_200m": round(float((elev >= -200).mean()), 3)}
        print(age, out[age])
    return out


if __name__ == "__main__":
    main()
