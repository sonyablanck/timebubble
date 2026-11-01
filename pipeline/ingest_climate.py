"""Step 1c: temperature and precipitation grids -> one 1° grid per slice (pipeline/PSEUDOCODE.md §1c).

Usage:
    python -m pipeline.ingest_climate                 # every slice, both variables
    python -m pipeline.ingest_climate --ages 150 65
    python -m pipeline.ingest_climate --list          # show the interval ages found

For each slice, the source interval with the NEAREST age is used, never an
interpolation: blending two palaeogeographies smears climate across moving
coastlines (DESIGN A6).

Outputs, per slice age:
    public/data/globe/{age}.temp.i16.gz     mean annual temperature, 0.01 °C
    public/data/globe/{age}.precip.i16.gz   mean annual precipitation, 0.01 mm/day
    public/data/globe/{age}.climate.json    sources, interval ages, mismatch, summary stats

Both grids share the layout of globe/{age}.i16.gz (row 0 = north, column 0 =
lon −180, node-registered 360×181).
"""
from __future__ import annotations

import argparse
import logging
from pathlib import Path

import numpy as np

from pipeline import config
from pipeline.grids import flatten_pole_rows, list_dem_files, load_global_grid
from pipeline.io_util import read_json, write_int16, write_json

log = logging.getLogger("ingest_climate")


def nearest_interval(files: dict[float, Path], age: float) -> tuple[float, Path]:
    if not files:
        raise FileNotFoundError("no climate files found")
    ages = np.array(sorted(files))
    # ties go to the older interval, deterministically
    best = ages[np.argmin(np.abs(ages - age) - 1e-9 * (ages > age))]
    return float(best), files[float(best)]


def area_weighted_mean(values: np.ndarray, lat_north: float, res: float) -> float:
    lats = lat_north - np.arange(values.shape[0]) * res
    w = np.cos(np.radians(lats))[:, None] * np.ones_like(values)
    return float((values * w).sum() / w.sum())


def ingest_variable(var: str, age: int, files: dict[float, Path], out: Path,
                    globe_side: dict | None) -> dict:
    spec = config.CLIMATE[var]
    override = config.CLIMATE_OVERRIDES.get((var, age))
    if override:
        src_age = float(override[0])
        if src_age not in files:
            raise FileNotFoundError(f"override for {var} at {age} Ma needs a {src_age:g} Ma file")
        src = files[src_age]
        log.warning("%3d Ma %s: using the %g Ma interval by override (see config.CLIMATE_OVERRIDES)",
                    age, var, src_age)
    else:
        src_age, src = nearest_interval(files, age)
    grid = load_global_grid(src, expected_res=config.GLOBE_RES)
    pole_fixed = flatten_pole_rows(grid)
    lo, hi = spec["valid"]
    vmin, vmax = float(grid.values.min()), float(grid.values.max())
    if vmin < lo or vmax > hi:
        raise ValueError(f"{src.name}: values {vmin:.1f}..{vmax:.1f} outside the plausible "
                         f"range {lo}..{hi} for {var}; check units")
    gmean = area_weighted_mean(grid.values, grid.lat_north, grid.res)
    glo, ghi = spec["global_mean"]
    if not glo <= gmean <= ghi:
        raise ValueError(f"{src.name}: area-weighted mean {gmean:.2f} outside {glo}..{ghi} "
                         f"for {var}; the units are probably not what config.CLIMATE expects")
    if globe_side and (grid.shape != (globe_side["height"], globe_side["width"])
                       or grid.registration != globe_side["registration"]):
        raise ValueError(f"{src.name}: grid {grid.shape} {grid.registration} does not match the "
                         f"globe heightmap {globe_side['height']}x{globe_side['width']} "
                         f"{globe_side['registration']}")
    write_int16(out / "globe" / f"{age}.{var}{config.HEIGHT_EXT}", grid.values * spec["scale"])
    mismatch = round(src_age - age, 3)
    if abs(mismatch) > config.CLIMATE_MISMATCH_WARN_MYR:
        log.warning("%3d Ma %s: source interval is %g Ma (%+g Myr)", age, var, src_age, mismatch)
    return {
        "source": spec["source"],
        "source_file": src.name,
        "source_age": src_age,
        "age_mismatch_myr": mismatch,
        "units": spec["units"],
        "scale": spec["scale"],
        "nodata_filled": grid.nodata_filled,
        "pole_cells_flattened": pole_fixed,
        "min": round(vmin, 3),
        "max": round(vmax, 3),
        "area_mean": round(gmean, 3),
        "override_reason": override[1] if override else None,
        "provenance": "inferred",
    }


def ingest_slice(age: int, dirs: dict[str, Path], out: Path) -> dict:
    side_path = out / "globe" / f"{age}.json"
    globe_side = read_json(side_path) if side_path.exists() else None
    if globe_side is None:
        log.warning("%s Ma: no globe sidecar yet; run ingest_dem first to check grid alignment", age)
    record = {"age": age}
    for var, folder in dirs.items():
        record[var] = ingest_variable(var, age, list_dem_files(folder), out, globe_side)
    write_json(out / "globe" / f"{age}.climate.json", record)
    log.info("%3d Ma  temp from %g Ma (mean %.1f °C)  precip from %g Ma (mean %.2f mm/day)",
             age, record["temp"]["source_age"], record["temp"]["area_mean"],
             record["precip"]["source_age"], record["precip"]["area_mean"])
    return record


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ages", type=int, nargs="*")
    ap.add_argument("--temp-dir", type=Path, default=config.CLIMATE["temp"]["dir"])
    ap.add_argument("--precip-dir", type=Path, default=config.CLIMATE["precip"]["dir"])
    ap.add_argument("--out", type=Path, default=config.DATA_OUT)
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    dirs = {"temp": args.temp_dir, "precip": args.precip_dir}

    if args.list:
        for var, folder in dirs.items():
            files = list_dem_files(folder)
            print(f"{var}: {len(files)} intervals in {folder}")
            for age in config.slices():
                src_age, src = nearest_interval(files, age)
                flag = "  <-- > 3 Myr" if abs(src_age - age) > config.CLIMATE_MISMATCH_WARN_MYR else ""
                print(f"  {age:3d} Ma -> {src_age:g} Ma  {src.name}{flag}")
        return 0

    for age in args.ages or config.slices():
        ingest_slice(age, dirs, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
