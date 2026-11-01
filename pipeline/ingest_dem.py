"""Step 1: PaleoDEMs -> globe heightmaps and terrain chunks (pipeline/PSEUDOCODE.md §1).

Source: PALEOMAP PaleoDEMs, 2024 release (Scotese et al. 2024), 0.1° netCDF.
The 1° globe grid is area-averaged from the 0.1° grid unless a 1° netCDF is
present in raw/dem_1deg/ (as in the 2018 release).

Usage (from the repo root):
    python -m pipeline.ingest_dem                 # every slice
    python -m pipeline.ingest_dem --ages 150 65   # selected slices
    python -m pipeline.ingest_dem --list          # show the ages found in raw/

Outputs, per slice age:
    public/data/globe/{age}.i16.gz        1° heightmap, int16 metres
    public/data/globe/{age}.json          sidecar: shape, registration, source
    public/data/terrain/{age}/r{R}_c{C}.i16.gz   0.1° chunks, 101×101 int16
    public/data/terrain/{age}/index.json  chunk index for the data/ module

Chunk layout (matches src/data/PSEUDOCODE.md §3):
    chunk (R, C) holds global cells rows R*100 .. R*100+100 and columns
    C*100 .. C*100+100: 100 unique cells plus one overlap row (south) and one
    overlap column (east). The east column wraps across the antimeridian; rows
    past the south pole repeat the last row (the runtime clamps latitude too).
"""
from __future__ import annotations

import argparse
import logging
import math
from pathlib import Path

import numpy as np

from pipeline import config
from pipeline.grids import GlobalGrid, derive_coarse, list_dem_files, load_global_grid
from pipeline.io_util import write_int16, write_json

log = logging.getLogger("ingest_dem")


def globe_outputs(grid: GlobalGrid, age: int, src: Path, out: Path, derived: bool = False) -> dict:
    stored = write_int16(out / "globe" / f"{age}{config.HEIGHT_EXT}", grid.values)
    method = (f"area mean of the {config.TERRAIN_RES}° grid ({grid.registration} registration)"
              if derived else "as shipped")
    sidecar = {
        "age": age,
        "height": stored.shape[0],
        "width": stored.shape[1],
        "res": grid.res,
        "registration": grid.registration,
        "lat_north": grid.lat_north,
        "lon_west": grid.lon_west,
        "dtype": "int16le",
        "units": "m",
        "min_elev": int(stored.min()),
        "max_elev": int(stored.max()),
        "nodata_filled": grid.nodata_filled,
        "source": config.DEM_SOURCE,
        "source_file": src.name,
        "resampling": method,
        "provenance": "data",
    }
    write_json(out / "globe" / f"{age}.json", sidecar)
    return sidecar


def chunk_block(values: np.ndarray, r: int, c: int,
                n: int = config.CELLS_PER_CHUNK, overlap: int = config.CHUNK_OVERLAP) -> np.ndarray:
    nlat, nlon = values.shape
    rows = np.minimum(np.arange(r * n, r * n + n + overlap), nlat - 1)   # clamp at the south pole
    cols = np.arange(c * n, c * n + n + overlap) % nlon                  # wrap at the antimeridian
    return values[np.ix_(rows, cols)]


def terrain_outputs(grid: GlobalGrid, age: int, src: Path, out: Path) -> dict:
    nlat, nlon = grid.shape
    n = config.CELLS_PER_CHUNK
    if nlon % n:
        raise ValueError(f"{nlon} longitude cells is not a multiple of the chunk size {n}")
    n_rows, n_cols = math.ceil(nlat / n), nlon // n
    folder = out / "terrain" / str(age)
    chunks = {}
    for r in range(n_rows):
        for c in range(n_cols):
            name = f"r{r}_c{c}{config.HEIGHT_EXT}"
            write_int16(folder / name, chunk_block(grid.values, r, c))
            chunks[f"{r}_{c}"] = name
    index = {
        "age": age,
        "res": grid.res,
        "registration": grid.registration,
        "lat_north": grid.lat_north,
        "lon_west": grid.lon_west,
        "nlat": nlat,
        "nlon": nlon,
        "cells_per_chunk": n,
        "stored_per_chunk": n + config.CHUNK_OVERLAP,
        "overlap_edges": ["east", "south"],
        "chunk_rows": n_rows,
        "chunk_cols": n_cols,
        "dtype": "int16le",
        "units": "m",
        "nodata_filled": grid.nodata_filled,
        "seam_column_max_diff_m": grid.dropped_dup_col_maxdiff,
        "source": config.DEM_SOURCE,
        "source_file": src.name,
        "provenance": "data",
        "chunks": chunks,
    }
    write_json(folder / "index.json", index)
    return index


def ingest_slice(age: int, raw_dirs: dict[float, Path], out: Path) -> dict:
    files_01 = list_dem_files(raw_dirs[config.TERRAIN_RES])
    if age not in files_01:
        avail = ", ".join(f"{a:g}" for a in sorted(files_01)) or "none"
        raise FileNotFoundError(f"no {config.TERRAIN_RES}° DEM for {age} Ma (available: {avail})")
    g01 = load_global_grid(files_01[age], expected_res=config.TERRAIN_RES)
    terrain = terrain_outputs(g01, age, files_01[age], out)

    # 1°: use a shipped 1° netCDF if there is one (the 2018 release), otherwise
    # area-average the 0.1° grid (the 2024 release ships 0.1° netCDF only)
    folder_1 = raw_dirs.get(config.GLOBE_RES)
    files_1 = list_dem_files(folder_1) if folder_1 and Path(folder_1).exists() else {}
    if age in files_1:
        g1, src1, derived = load_global_grid(files_1[age], expected_res=config.GLOBE_RES), files_1[age], False
    else:
        factor = int(round(config.GLOBE_RES / config.TERRAIN_RES))
        g1, src1, derived = derive_coarse(g01, factor), files_01[age], True
    globe = globe_outputs(g1, age, src1, out, derived=derived)

    if g1.registration != g01.registration:
        log.warning("%s Ma: 1° grid is %s-registered but 0.1° grid is %s-registered",
                    age, g1.registration, g01.registration)
    log.info("%3d Ma  globe %dx%d (%s, %d filled)  terrain %dx%d in %d chunks (%s, %d filled)",
             age, globe["width"], globe["height"], g1.registration, g1.nodata_filled,
             terrain["nlon"], terrain["nlat"], len(terrain["chunks"]),
             g01.registration, g01.nodata_filled)
    return {"age": age, "globe": globe, "terrain": {k: v for k, v in terrain.items() if k != "chunks"}}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ages", type=int, nargs="*", help="slice ages (default: all)")
    ap.add_argument("--raw-1deg", type=Path, default=config.DEM_DIRS[1.0])
    ap.add_argument("--raw-01deg", type=Path, default=config.DEM_DIRS[0.1])
    ap.add_argument("--out", type=Path, default=config.DATA_OUT)
    ap.add_argument("--list", action="store_true", help="list ages found in the raw folders and exit")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    raw_dirs = {config.GLOBE_RES: args.raw_1deg, config.TERRAIN_RES: args.raw_01deg}
    if args.list:
        for res, folder in raw_dirs.items():
            if not Path(folder).exists():
                print(f"{res}°  {folder}: (no folder; 1° will be derived from 0.1°)")
                continue
            ages = sorted(list_dem_files(folder))
            print(f"{res}°  {folder}: {', '.join(f'{a:g}' for a in ages) or 'none'}")
        fine = list_dem_files(raw_dirs[config.TERRAIN_RES])
        missing = [a for a in config.slices() if a not in fine]
        print(f"slices with no {config.TERRAIN_RES}° file:", missing or "none")
        unparsed = [p.name for p in Path(raw_dirs[config.TERRAIN_RES]).rglob("*.nc")
                    if p not in fine.values()]
        if unparsed:
            print("files with no age in the name (rename or report):", unparsed[:10])
        return 0

    ages = args.ages or config.slices()
    for age in ages:
        ingest_slice(age, raw_dirs, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
