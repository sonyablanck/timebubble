"""Shared pipeline settings (pipeline/PSEUDOCODE.md §0).

All paths are relative to the repository root, so scripts work from anywhere.
"""
from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

DATA_RAW = REPO_ROOT / "pipeline" / "raw"        # downloads; never committed
DATA_OUT = REPO_ROOT / "public" / "data"

# Raw inputs from the PALEOMAP 2024 release (Scotese et al. 2024),
# Zenodo doi:10.5281/zenodo.10659112, CC BY 4.0. Unzip:
#   "5a. PaleoDEM (nc, 3601x1801).zip"                         -> raw/dem_01deg/
#   "3a. PALEOMAP Global Plate Model for Paleogeographic
#        Reconstructions v.19o_r1d.zip"                         -> raw/plate_model/
# The 1° globe grid is derived from the 0.1° grid. raw/dem_1deg/ is optional
# and only used if it holds 1° netCDFs (e.g. the 2018 release).
DEM_DIRS = {
    1.0: DATA_RAW / "dem_1deg",
    0.1: DATA_RAW / "dem_01deg",
}
DEM_SOURCE = "PALEOMAP PaleoDEMs (Scotese et al. 2024, v24221)"

SLICE_MIN_MA = 65          # post-extinction slice included (DESIGN §8)
KPG_MA = 66.0              # K–Pg boundary
SLICE_MAX_MA = 250
SLICE_STEP = 5             # matches the PaleoDEM interval
SLICE_HALF_WINDOW = SLICE_STEP / 2

GLOBE_RES = 1.0            # degrees
TERRAIN_RES = 0.1          # degrees
CELLS_PER_CHUNK = 100      # unique cells per chunk side (10° at 0.1°)
CHUNK_OVERLAP = 1          # extra row/column shared with the east/south neighbour
CHUNK_STORED = CELLS_PER_CHUNK + CHUNK_OVERLAP   # 101

BIN_DEG = 5                # occurrence bins

HEIGHT_EXT = ".i16.gz"     # raw little-endian int16, gzip with mtime=0
GZIP_LEVEL = 9

# PALEOMAP plate model v19o_r1d, from the same 2024 record as the DEMs.
# Confirmed against the DEMs on 2026-10-31 (pipeline/checks/plate_model_check.py):
# v19o puts fewer present-day continental points into deep ocean than v18e at
# every slice tested (65, 100, 150, 200, 250 Ma).
PLATE_MODEL_DIR = DATA_RAW / "plate_model"
PLATE_ROTATION_FILE = "Scotese_Plate_Model_forPgeog_v19o_r1d_v240506a.rot"
PLATE_POLYGON_FILE = "Scotese_Plate_Polygons__forPgeog_v19o_v240506.gpml"

# Climate grids, same 2024 record (Scotese et al. 2024), 1° node-registered, 361×181:
#   "6a1. Mean Annual Temperatures (csv, list).zip"  -> raw/temperature/
#        = Scotese (2022) scotese02a_v21321: HadCM3L adjusted to proxies, °C
#   "6b2. Mean Annual Precipitation (nc).zip"        -> raw/precipitation/
#        = HadCM3L 'scotese_02' runs (Valdes et al. 2021), raw model output.
#        UNITS ARE mm/day, not the mm/month the record's explanation states: the
#        150 Ma grid has an area mean of ~3.0 and a maximum of ~17, which matches
#        Earth's ~2.7 mm/day and would be a planet-wide desert in mm/month.
CLIMATE = {
    "temp": {
        "dir": DATA_RAW / "temperature",
        "scale": 100,            # stored as int16 in 0.01 °C
        "units": "0.01 degC",
        "source": "Mean annual surface temperature, scotese02a_v21321 (Scotese 2022; Scotese et al. 2021)",
        "valid": (-80.0, 60.0),        # per-cell plausibility bounds, source units
        "global_mean": (5.0, 40.0),    # area-weighted mean bounds: catches K vs °C
    },
    "precip": {
        "dir": DATA_RAW / "precipitation",
        "scale": 100,            # stored as int16 in 0.01 mm/day (max 327 mm/day)
        "units": "0.01 mm/day",
        "source": "Mean annual precipitation, HadCM3L scotese_02 (Valdes et al. 2021)",
        "valid": (0.0, 200.0),
        "global_mean": (1.0, 6.0),     # mm/day; mm/month or mm/year would fail this
    },
}
CLIMATE_MISMATCH_WARN_MYR = 3.0

# Deliberate substitutions: (variable, slice age) -> (interval age to use, reason).
# Recorded in globe/{age}.climate.json; the age mismatch sets CLIMATE_AGE_MISMATCH.
CLIMATE_OVERRIDES = {
    ("temp", 65): (60.0,
        "The 65 Ma grid is an icehouse outlier (area mean 8.1 °C, −9 °C at 60°N) between "
        "warm 70 Ma (20.8 °C) and 60 Ma grids, although the dataset's own documentation "
        "lists 65–40 Ma as a hothouse interval; it appears to encode a K–Pg cooling event. "
        "Time Bubble models impact winter separately (Aftermath mode, DESIGN §8), so the "
        "base 65 Ma slice uses the 60 Ma (Palaeocene) grid instead."),
}
PLATE_MODEL_NAME = "PALEOMAP v19o_r1d (Scotese et al. 2024)"


def slices() -> list[int]:
    """Slice ages in Ma, oldest first: 250, 245, ..., 65 (38 slices)."""
    return list(range(SLICE_MAX_MA, SLICE_MIN_MA - 1, -SLICE_STEP))
