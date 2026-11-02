"""Step 6: manifest.json (the app's index of slices and assets), credits.json and climate parameters (pipeline/PSEUDOCODE.md §6).

Usage:  python -m pipeline.build_manifest

Lists every slice that has a globe heightmap, with relative paths to its assets and
the grid dimensions the app needs to decode them. Ecology files are optional until
the fossil steps (2–5) exist; slices without one get "ecology": null.
It also copies the hand-curated climate_by_age.json (§1d) and writes credits.json for the in-app
About panel: datasets, papers, values entered by hand and software, with every reference key
resolved from REFERENCES.md (INVARIANT: no key is missing).

data_version is a hash of every asset file's bytes, so it changes exactly when the
data change. The app appends it to URLs (?v=...) to bust stale browser caches.
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import re
import shutil
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


CLIMATE_PARAMS = Path(__file__).resolve().parent / "climate_by_age.json"
REFERENCES_MD = config.REPO_ROOT / "REFERENCES.md"

DATASETS = [
    {"name": "PALEOMAP PaleoDEMs, 2024 release (item 5a)", "version": "v24221", "doi": "10.5281/zenodo.10659112",
     "licence": "CC BY 4.0", "ref": "scotese2024data", "used_for": "elevation and bathymetry per slice, 0.1°; the 1° globe grid",
     "changes": "gzipped int16 grids; 0.1° DEM in 10° chunks; area-averaged to 1° for the globe"},
    {"name": "PALEOMAP Global Plate Model v19o_r1d (item 3a)", "version": "v24221", "doi": "10.5281/zenodo.10659112",
     "licence": "CC BY 4.0", "ref": "scotese2024data", "used_for": "rotating fossil occurrences to each slice",
     "changes": "used with pyGPlates; not redistributed"},
    {"name": "Mean annual temperature grids (item 6a1; Scotese 2022)", "version": "scotese02a_v21321", "doi": "10.5281/zenodo.5718392",
     "licence": "CC BY 4.0", "ref": "scotese2022data", "used_for": "temperature per slice, 1°",
     "changes": "stored in 0.01 °C; nearest-age interval per slice; the 65 Ma slice uses the 60 Ma grid"},
    {"name": "Mean annual precipitation grids, HadCM3L (item 6b2)", "version": "scotese_02", "doi": "10.5281/zenodo.10659112",
     "licence": "CC BY 4.0", "ref": "valdes2021", "used_for": "moisture per slice (biomes), 1°",
     "changes": "stored in 0.01 mm/day (the files' units, not mm/month as the record states)"},
    {"name": "The Paleobiology Database", "version": None, "doi": None, "licence": "as stated at download (CC0)", "ref": "pbdb",
     "used_for": "fossil occurrences: who lived where", "changes": "rotated to each slice; mapped to body plans (pipeline/rules.csv); binned in 5° cells"},
]
PAPERS = ["scotese2024", "kocsis2021", "scotese2021", "valdes2021"]
HAND_ENTERED = [
    {"what": "Global mean surface temperature per stage (PhanDA percentiles), for the spread between reconstructions on info cards", "ref": "judd2024"},
    {"what": "Impact Winter cooling (26 °C peak, ~3 sub-freezing years, ~30-year recovery)", "ref": "brugger2017"},
    {"what": "Fern Spike duration (~8,000–20,000 years)", "ref": "vajda2004"},
    {"what": "Köppen–Geiger aridity threshold for biome moisture", "ref": "peel2007"},
    {"what": "Early Triassic lethal heat", "ref": "sun2012"},
    {"what": "Population density from body mass (Damuth's law) and its T. rex calibration", "ref": "damuth1981"},
    {"what": "T. rex population density, ~1 per 100 km²", "ref": "marshall2021"},
]
SOFTWARE = [
    {"name": "Three.js", "licence": "MIT"}, {"name": "Preact", "licence": "MIT"}, {"name": "Vite", "licence": "MIT"},
    {"name": "pyGPlates (pipeline only, not shipped)", "licence": "GPL-2.0-only"},
]


def parse_references(path: Path = REFERENCES_MD) -> dict[str, str]:
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^- \*\*\[([a-z0-9]+)\]\*\*\s+(.*)$", line.strip())
        if m:
            out[m.group(1)] = re.sub(r"\s+", " ", re.sub(r"\*\*?", "", m.group(2))).strip()
    return out


def check_refs(params: list[dict], refs: dict[str, str]) -> None:
    """INVARIANT: every numeric value in climate_by_age.json carries a ref, and every ref resolves."""
    def walk(node, where):
        if isinstance(node, dict):
            nums = [k for k, v in node.items() if isinstance(v, (int, float)) and not isinstance(v, bool) and k not in ("age",)]
            if nums and "ref" not in node and where != "slice":
                raise ValueError(f"climate_by_age {where}: numbers {nums} without a ref")
            for k, v in node.items():
                if k == "ref" and v not in refs:
                    raise ValueError(f"climate_by_age {where}: ref {v} missing from REFERENCES.md")
                walk(v, k)
    for e in params:
        for k in e.get("refs", []):
            if k not in refs:
                raise ValueError(f"climate_by_age {e['age']}: ref {k} missing from REFERENCES.md")
        walk(e, "slice")


def credits(manifest: dict, refs: dict[str, str]) -> dict:
    keys = sorted({d["ref"] for d in DATASETS} | set(PAPERS) | {h["ref"] for h in HAND_ENTERED})
    missing = [k for k in keys if k not in refs]
    if missing:
        raise ValueError(f"credits: refs missing from REFERENCES.md: {missing}")
    return {
        "datasets": DATASETS, "papers": PAPERS, "hand_entered": HAND_ENTERED, "software": SOFTWARE,
        "pbdb": manifest.get("pbdb"),
        "references": {k: refs[k] for k in keys},
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
        "data_version": None,          # set below, after every asset (incl. credits) is written
        "kpg_ma": config.KPG_MA,
        "slices": [slice_entry(a, out) for a in sorted(ages, reverse=True)],
    }
    # fossil source as PBDB stated it at download time (for CREDITS and the About panel)
    q = config.DATA_RAW / "pbdb" / "pbdb_query.json"
    if q.exists():
        meta = read_json(q)
        manifest["pbdb"] = {k: meta.get(k) for k in ("access_time", "retrieved_utc", "data_license", "license_url", "records_found", "url")}
    refs = parse_references()
    if CLIMATE_PARAMS.exists():
        params = read_json(CLIMATE_PARAMS)
        check_refs(params, refs)
        shutil.copyfile(CLIMATE_PARAMS, out / "climate_by_age.json")
        manifest["climate_params"] = "climate_by_age.json"
    write_json(out / "credits.json", credits(manifest, refs))
    manifest["credits"] = "credits.json"
    manifest["data_version"] = data_version(out)
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
