"""Reading and normalising global lat/lon rasters (PaleoDEMs, temperature grids).

Canonical layout produced by `load_global_grid`:
  - row 0 is the northernmost row; latitude decreases down the rows
  - column 0 starts at lon -180; longitude increases to the east
  - no duplicated lon 180 column (it is identical to lon -180 and is dropped)
  - registration is "node" (rows at -90 ... 90, e.g. 181 rows at 1°)
    or "cell" (rows at cell centres, e.g. 180 rows at 1°)

The source files' variable names, orientation and registration are not
assumed: they are detected and recorded (the `# CHECK:` items in pipeline §1).
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy import ndimage

log = logging.getLogger(__name__)

LAT_NAMES = ("lat", "latitude", "y", "nav_lat")
LON_NAMES = ("lon", "longitude", "x", "long", "nav_lon")
PREFERRED_VARS = ("z", "elevation", "elev", "topo", "Band1", "temp", "tas", "temperature")

# Absolute values beyond this are treated as nodata (deepest ocean ~11 km)
NODATA_ABS = 15_000.0

AGE_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*_?ma(?![a-z])", re.IGNORECASE)


@dataclass
class GlobalGrid:
    values: np.ndarray      # float64 [nlat, nlon], canonical orientation
    res: float              # degrees
    registration: str       # "node" | "cell"
    lat_north: float        # latitude of row 0
    lon_west: float         # longitude of column 0 (always -180 or -180 + res/2)
    nodata_filled: int = 0
    dropped_dup_col_maxdiff: float | None = None

    @property
    def shape(self):
        return self.values.shape

    def lat_of_row(self, i):
        return self.lat_north - np.asarray(i) * self.res

    def lon_of_col(self, j):
        return self.lon_west + np.asarray(j) * self.res


# ---------------------------------------------------------------- file discovery

LEADING_AGE_RE = re.compile(r"^(\d+(?:\.\d+)?)_")


def parse_age(name: str) -> float | None:
    """Age in Ma encoded in a filename.

    '..._Late_Jurassic_150Ma.nc' -> 150.0   (2018 release: explicit 'Ma')
    '150_v23220d.nc'             -> 150.0   (2024 release: zero-padded age, then version)
    """
    stem = Path(name).stem
    matches = AGE_RE.findall(stem)
    if matches:
        return float(matches[-1])    # last match: map numbers come first in the names
    lead = LEADING_AGE_RE.match(stem)
    return float(lead.group(1)) if lead else None


def list_dem_files(folder: Path, suffixes=(".nc", ".grd", ".nc4", ".csv")) -> dict[float, Path]:
    found: dict[float, Path] = {}
    for p in sorted(Path(folder).rglob("*")):
        if p.suffix.lower() not in suffixes:
            continue
        age = parse_age(p.name)
        if age is None:
            log.warning("cannot parse an age from %s; skipped", p.name)
            continue
        if age in found:
            raise ValueError(f"two files for {age} Ma: {found[age].name} and {p.name}")
        found[age] = p
    return found


def find_dem_file(folder: Path, age: float) -> Path:
    files = list_dem_files(folder)
    if age in files:
        return files[age]
    avail = ", ".join(f"{a:g}" for a in sorted(files)) or "none"
    raise FileNotFoundError(f"no DEM for {age:g} Ma in {folder} (available: {avail})")


# ---------------------------------------------------------------- reading

def read_raster(path: Path):
    """Return (lat 1D, lon 1D, values 2D [lat, lon]) as float64, in file order.

    netCDF, or a CSV in list format (one row per grid point: lon, lat, value).
    """
    if Path(path).suffix.lower() in (".csv", ".txt"):
        return read_csv_list(path)
    import xarray as xr

    with xr.open_dataset(path, decode_times=False, mask_and_scale=True) as ds:
        lat_name = _pick(ds, LAT_NAMES, "latitude")
        lon_name = _pick(ds, LON_NAMES, "longitude")
        candidates = [v for v in ds.data_vars
                      if set(ds[v].dims) >= {lat_name, lon_name} and ds[v].ndim >= 2]
        if not candidates:
            raise ValueError(f"{path}: no 2D variable on ({lat_name}, {lon_name})")
        preferred = [v for v in PREFERRED_VARS if v in candidates]
        var = preferred[0] if preferred else candidates[0]
        if len(candidates) > 1:
            log.info("%s: several grid variables %s; using %r", path.name, candidates, var)
        da = ds[var].squeeze(drop=True).transpose(lat_name, lon_name)
        lat = np.asarray(ds[lat_name].values, dtype=np.float64)
        lon = np.asarray(ds[lon_name].values, dtype=np.float64)
        values = np.asarray(da.values, dtype=np.float64)
    return lat, lon, values


def read_csv_list(path: Path):
    """List-format CSV: one row per grid point with longitude, latitude and a value.

    Columns are found by header name (lon/long/longitude/x, lat/latitude/y);
    with no recognisable header, by range (|lat| <= 90, lon spanning > 180°).
    A grid-format CSV (a bare matrix with no coordinates) is rejected, because
    its orientation cannot be checked.
    """
    import csv

    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.reader(f) if r and any(c.strip() for c in r)]
    if not rows:
        raise ValueError(f"{path}: empty CSV")

    def is_num(s):
        try:
            float(s)
            return True
        except ValueError:
            return False

    header = None if all(is_num(c) for c in rows[0]) else [c.strip().lower() for c in rows[0]]
    body = rows[1:] if header else rows
    data = np.array([[float(c) if c.strip() not in ("", "nan", "NaN") else np.nan for c in r]
                     for r in body], dtype=np.float64)
    if data.ndim != 2 or data.shape[1] < 3:
        raise ValueError(f"{path}: expected list format (lon, lat, value); got {data.shape[1]} columns")
    if data.shape[1] > 3 and data.shape[0] < 1000:
        raise ValueError(f"{path}: looks like a grid-format CSV (no coordinates); use the list-format files")

    ilat = ilon = None
    if header:
        for i, h in enumerate(header):
            if h in LAT_NAMES and ilat is None:
                ilat = i
            elif h in LON_NAMES and ilon is None:
                ilon = i
    if ilat is None or ilon is None:
        spans = np.nanmax(data, axis=0) - np.nanmin(data, axis=0)
        lat_like = [i for i in range(data.shape[1]) if np.nanmax(np.abs(data[:, i])) <= 90 and spans[i] >= 170]
        lon_like = [i for i in range(data.shape[1]) if spans[i] > 300 and np.nanmax(np.abs(data[:, i])) <= 360]
        lon_like = [i for i in lon_like if i not in lat_like]
        if len(lat_like) != 1 or len(lon_like) != 1:
            raise ValueError(f"{path}: cannot tell which columns are latitude and longitude")
        ilat, ilon = lat_like[0], lon_like[0]
    ival = [i for i in range(data.shape[1]) if i not in (ilat, ilon)]
    if len(ival) != 1:
        raise ValueError(f"{path}: expected exactly one value column, found {len(ival)}")
    ival = ival[0]

    lat = np.unique(np.round(data[:, ilat], 6))
    lon = np.unique(np.round(data[:, ilon], 6))
    values = np.full((lat.size, lon.size), np.nan)
    ri = np.searchsorted(lat, np.round(data[:, ilat], 6))
    ci = np.searchsorted(lon, np.round(data[:, ilon], 6))
    values[ri, ci] = data[:, ival]
    if np.isnan(values).sum() > 0.01 * values.size:
        raise ValueError(f"{path}: list does not cover a full grid")
    return lat, lon, values


def _pick(ds, names, what):
    for n in names:
        if n in ds.variables or n in ds.dims:
            return n
    raise ValueError(f"no {what} coordinate (looked for {names}); found {list(ds.variables)}")


# ---------------------------------------------------------------- normalising

def normalise(lat, lon, values, expected_res: float | None = None) -> GlobalGrid:
    lat = np.asarray(lat, dtype=np.float64)
    lon = np.asarray(lon, dtype=np.float64)
    values = np.array(values, dtype=np.float64)
    if values.shape != (lat.size, lon.size):
        raise ValueError(f"shape {values.shape} does not match lat {lat.size} × lon {lon.size}")

    res = _regular_step(lat, "latitude")
    lon_res = _regular_step(lon, "longitude")
    if not np.isclose(res, lon_res, rtol=1e-6):
        raise ValueError(f"non-square grid: lat step {res}, lon step {lon_res}")
    if expected_res is not None and not np.isclose(res, expected_res, rtol=1e-6):
        raise ValueError(f"resolution {res}° but expected {expected_res}°")
    res = float(round(res, 6))
    lat, lon = _snap(lat, res), _snap(lon, res)

    # Drop padding columns beyond ±180° (the 185–255 Ma precipitation files run to
    # 185°E with six all-NaN columns). Real data out there would be ambiguous: fail.
    # Only for grids in the −180..180 convention; 0..360 grids legitimately exceed 180.
    if lon.min() < 0:
        outside = (lon > 180.0 + res * 1e-3) | (lon < -180.0 - res * 1e-3)
    else:
        outside = lon > 360.0 + res * 1e-3
    if outside.any():
        if np.isfinite(values[:, outside]).any():
            raise ValueError(f"data in {outside.sum()} longitude columns beyond ±180°")
        log.info("dropped %d all-NaN padding columns beyond ±180°", int(outside.sum()))
        lon, values = lon[~outside], values[:, ~outside]

    # north at row 0
    if lat[0] < lat[-1]:
        lat, values = lat[::-1], values[::-1, :]

    # registration from the latitude extent
    if np.isclose(lat[0], 90.0, atol=res * 1e-3) and np.isclose(lat[-1], -90.0, atol=res * 1e-3):
        registration = "node"
    elif np.isclose(lat[0], 90.0 - res / 2, atol=res * 1e-3) and np.isclose(lat[-1], -90.0 + res / 2, atol=res * 1e-3):
        registration = "cell"
    else:
        raise ValueError(f"latitude runs {lat[0]}..{lat[-1]}: neither node- nor cell-registered global grid")

    # longitude: wrap into [-180, 180), sort, drop a duplicated seam column
    lon_w = ((lon + 180.0) % 360.0) - 180.0
    order = np.argsort(lon_w, kind="stable")
    lon_w, values = lon_w[order], values[:, order]
    dup_diff = None
    nlon_expected = int(round(360.0 / res))
    if lon_w.size == nlon_expected + 1:
        # both ends of the seam present (-180 and 180, or 0 and 360); after
        # wrapping they collide as two adjacent, equal longitudes
        dups = np.flatnonzero(np.isclose(np.diff(lon_w), 0.0, atol=res * 1e-3))
        if dups.size != 1:
            raise ValueError("expected exactly one duplicated seam column")
        k = int(dups[0])
        a, b = values[:, k], values[:, k + 1]
        both = np.isfinite(a) & np.isfinite(b)
        dup_diff = float(np.max(np.abs(a[both] - b[both]))) if both.any() else 0.0
        if dup_diff > 0:
            # The 2024 PaleoDEMs carry two independent estimates of the ±180°
            # meridian (up to ~3 km apart in a few rows). The −180° column agrees
            # better with its eastern neighbour, so it is kept; the sidecar records it.
            log.info("seam columns differ by up to %.3g; keeping lon -180", dup_diff)
        values = np.delete(values, k + 1, axis=1)
        lon_w = np.delete(lon_w, k + 1)
    if lon_w.size != nlon_expected:
        raise ValueError(f"{lon_w.size} longitude columns, expected {nlon_expected}")
    expected_west = -180.0 if registration == "node" else -180.0 + res / 2
    if not np.isclose(lon_w[0], expected_west, atol=res * 1e-3):
        raise ValueError(f"first longitude {lon_w[0]} inconsistent with {registration} registration")

    return GlobalGrid(values=values, res=res, registration=registration,
                      lat_north=float(lat[0]), lon_west=expected_west,
                      dropped_dup_col_maxdiff=dup_diff)


def _regular_step(axis: np.ndarray, what: str) -> float:
    """Step of a regular axis. Coordinates stored as float32 (e.g. the 2024 100 Ma
    DEM) wobble by ~1e-5°, so the test is against an exact linspace, to 0.1% of a step."""
    if axis.size < 2:
        raise ValueError(f"{what} axis too short")
    step = (axis[-1] - axis[0]) / (axis.size - 1)
    if step == 0 or np.max(np.abs(axis - (axis[0] + step * np.arange(axis.size)))) > abs(step) * 1e-3:
        raise ValueError(f"{what} axis is not regularly spaced")
    return float(abs(step))


def _snap(axis: np.ndarray, res: float) -> np.ndarray:
    """Replace a near-regular axis with exact multiples of res (rounding noise only)."""
    snapped = np.round(axis / res * 2) / 2 * res      # nearest half-step: works for node and cell grids
    if np.max(np.abs(snapped - axis)) > res * 1e-3:
        raise ValueError("axis is not on a regular grid of the expected resolution")
    return snapped


def fill_nodata(grid: GlobalGrid) -> GlobalGrid:
    """Replace NaN / absurd values with the nearest valid cell (longitude wraps)."""
    v = grid.values
    bad = ~np.isfinite(v) | (np.abs(np.nan_to_num(v)) > NODATA_ABS)
    n_bad = int(bad.sum())
    if n_bad == 0:
        return grid
    if n_bad == v.size:
        raise ValueError("grid has no valid cells")
    nlon = v.shape[1]
    tiled_bad = np.concatenate([bad, bad, bad], axis=1)         # wrap in longitude
    _, (ri, ci) = ndimage.distance_transform_edt(tiled_bad, return_indices=True)
    rows = ri[:, nlon:2 * nlon]
    cols = ci[:, nlon:2 * nlon] % nlon
    filled = v.copy()
    filled[bad] = v[rows[bad], cols[bad]]
    log.info("filled %d nodata cells by nearest neighbour", n_bad)
    grid.values = filled
    grid.nodata_filled = n_bad
    return grid


def flatten_pole_rows(grid: GlobalGrid) -> int:
    """On a node-registered grid each pole row is one point, so it must be constant.

    Sets both pole rows to their median and returns how many cells changed. This
    removes the colour-scale anchors in the 2024 temperature files (50 °C and
    −55 °C planted at 90°N, −180° and −179°) and model noise at the precipitation poles.
    """
    if grid.registration != "node":
        return 0
    changed = 0
    for r in (0, grid.values.shape[0] - 1):
        row = grid.values[r]
        med = float(np.median(row))
        changed += int(np.sum(np.abs(row - med) > 1e-9))
        grid.values[r] = med
    return changed


def derive_coarse(fine: GlobalGrid, factor: int) -> GlobalGrid:
    """Area-average a fine global grid onto a grid `factor` times coarser.

    Used when a release ships no netCDF at the globe resolution (the 2024
    PALEOMAP PaleoDEMs give 0.1° netCDF only). Averaging, not point sampling,
    so small islands and peaks do not alias onto the globe.

    node: each coarse node averages the (factor+1)² fine nodes around it, with
          half weight on the shared edge nodes (trapezoid rule); lon wraps,
          lat clamps at the poles.
    cell: each coarse cell is the plain mean of its factor × factor fine cells.
    """
    v = fine.values
    nlat, nlon = v.shape
    if nlon % factor:
        raise ValueError(f"{nlon} columns not divisible by {factor}")
    res = round(fine.res * factor, 6)
    if fine.registration == "cell":
        if nlat % factor:
            raise ValueError(f"{nlat} rows not divisible by {factor}")
        out = v.reshape(nlat // factor, factor, nlon // factor, factor).mean(axis=(1, 3))
        return GlobalGrid(values=out, res=res, registration="cell",
                          lat_north=90.0 - res / 2, lon_west=-180.0 + res / 2,
                          nodata_filled=fine.nodata_filled)
    if (nlat - 1) % factor:
        raise ValueError(f"{nlat} node rows do not align with factor {factor}")
    w = np.ones(factor + 1)
    w[0] = w[-1] = 0.5
    w /= w.sum()
    smooth = ndimage.convolve1d(v, w, axis=1, mode="wrap")
    smooth = ndimage.convolve1d(smooth, w, axis=0, mode="nearest")
    out = smooth[::factor, ::factor]
    return GlobalGrid(values=out, res=res, registration="node",
                      lat_north=90.0, lon_west=-180.0,
                      nodata_filled=fine.nodata_filled)


def load_global_grid(path: Path, expected_res: float | None = None) -> GlobalGrid:
    lat, lon, values = read_raster(path)
    return fill_nodata(normalise(lat, lon, values, expected_res))
