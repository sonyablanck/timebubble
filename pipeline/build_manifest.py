"""Step 6 (partial): manifest.json, the app's index of slices and assets (pipeline/PSEUDOCODE.md §6).

Usage:  python -m pipeline.build_manifest

Lists every slice that has a globe heightmap, with relative paths to its assets and
the grid dimensions the app needs to decode them. Ecology files are optional until
the fossil steps (2–5) exist; slices without one get "ecology": null.
CREDITS.md generation is still to do (it needs the PBDB retrieval details).

data_version is a hash of every asset file's bytes, so it changes exactly when the
data change. The app appends it to URLs (?v=...) to bust stale browser caches.
"""
from __future__ import annotations

import argparse
import hashlib
import logging
from pathlib import Path

from pipeline import config
from pipeline.io_util import read_json, write_json

log = logging.getLogger("build_manifest")

PIPELINE_VERSION = "0.1.0"
MANIFEST_SCHEMA = 1

# Period and epoch bases in Ma, oldest first. ICS International Chronostratigraphic
# Chart v2024/12: Cretaceous base 143.1 Ma (still without a GSSP).
# CHECK: epoch bases against the chart when it is next revised.
INTERVALS = [
    (251.902, "Triassic", "Early Triassic"),
    (247.2, "Triassic", "Middle Triassic"),
    (237.0, "Triassic", "Late Triassic"),
    (201.4, "Jurassic", "Early Jurassic"),
    (174.7, "Jurassic", "Middle Jurassic"),
    (161.5, "Jurassic", "Late Jurassic"),
    (143.1, "Cretaceous", "Early Cretaceous"),
    (100.5, "Cretaceous", "Late Cretaceous"),
    (66.0, "Palaeogene", "Palaeocene"),
]


def period_of(age: float) -> tuple[str, str]:
    """(period, epoch) containing `age`. A base age belongs to the older unit
    (66.0 Ma is still Late Cretaceous), so the test is strict."""
    found = None
    for base, period, epoch in INTERVALS:         # oldest first
        if age < base:
            found = (period, epoch)
    if found is None:
        raise ValueError(f"{age} Ma is outside the supported range")
    return found


def slice_label(age: int) -> str:
    period, epoch = period_of(age)
    label = f"{age} Ma · {epoch}"
    if age < config.KPG_MA:
        label += " · after the extinction"
    return label


def data_version(out: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(out.rglob("*")):
        if p.is_file() and p.name != "manifest.json":
            h.update(p.relative_to(out).as_posix().encode())
            h.update(b"\0")
            h.update(p.read_bytes())
    return h.hexdigest()[:16]


def slice_entry(age: int, out: Path) -> dict:
    ext = config.HEIGHT_EXT
    globe_side = read_json(out / "globe" / f"{age}.json")
    terrain_idx = read_json(out / "terrain" / str(age) / "index.json")
    required = {
        "globe": f"globe/{age}{ext}",
        "globe_meta": f"globe/{age}.json",
        "continentality": f"globe/{age}.continentality{ext}",
        "temperature": f"globe/{age}.temp{ext}",
        "precipitation": f"globe/{age}.precip{ext}",
        "climate_meta": f"globe/{age}.climate.json",
        "terrain": f"terrain/{age}/index.json",
    }
    for key, rel in required.items():
        if not (out / rel).exists():
            raise FileNotFoundError(f"{age} Ma: missing {rel} ({key}); run the earlier steps first")
    eco = f"ecology/{age}.json.gz"
    period, epoch = period_of(age)
    return {
        "age": age,
        "label": slice_label(age),
        "period": period,
        "epoch": epoch,
        "aftermath_mode": age < config.KPG_MA,
        **required,
        "ecology": eco if (out / eco).exists() else None,
        "grid": {k: globe_side[k] for k in ("width", "height", "res", "registration", "lat_north", "lon_west")},
        "terrain_grid": {k: terrain_idx[k] for k in
                         ("nlat", "nlon", "res", "registration", "lat_north", "lon_west",
                          "cells_per_chunk", "stored_per_chunk", "chunk_rows", "chunk_cols")},
    }


def build(out: Path) -> dict:
    ages = [a for a in config.slices() if (out / "globe" / f"{a}.json").exists()]
    if not ages:
        raise FileNotFoundError(f"no slices found in {out}/globe; run ingest_dem first")
    missing = [a for a in config.slices() if a not in ages]
    if missing:
        log.warning("slices not yet built (skipped): %s", missing)
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "pipeline_version": PIPELINE_VERSION,
        "plate_model": config.PLATE_MODEL_NAME,
        "dem_source": config.DEM_SOURCE,
        "data_version": data_version(out),
        "kpg_ma": config.KPG_MA,
        "slices": [slice_entry(a, out) for a in sorted(ages, reverse=True)],
    }
    # fossil source as PBDB stated it at download time (for CREDITS and the About panel)
    q = config.DATA_RAW / "pbdb" / "pbdb_query.json"
    if q.exists():
        meta = read_json(q)
        manifest["pbdb"] = {k: meta.get(k) for k in ("access_time", "retrieved_utc", "data_license", "license_url", "records_found", "url")}
    write_json(out / "manifest.json", manifest)
    log.info("manifest: %d slices, data_version %s", len(ages), manifest["data_version"])
    return manifest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=config.DATA_OUT)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    build(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
