"""Synthetic PaleoDEM-like netCDF files, so tests run without the real downloads."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import xarray as xr

MARKER = (30.0, 60.0)          # (lat, lon) of a +5000 m spike used to test orientation
MARKER_ELEV = 5000.0


def synthetic_field(lat2d, lon2d):
    """Smooth, longitude-periodic elevation with a continent straddling the antimeridian."""
    lat, lon = np.radians(lat2d), np.radians(lon2d)
    # continent A centred at (0, 180): straddles the antimeridian
    ca = np.cos(lat) * np.cos(lon - np.pi)
    # continent B centred at (-40, -60)
    cb = (np.sin(lat) * np.sin(np.radians(-40))
          + np.cos(lat) * np.cos(np.radians(-40)) * np.cos(lon - np.radians(-60)))
    return 4000.0 * np.maximum(ca, cb) - 2500.0 + 37.3 * np.sin(3 * lon) * np.cos(lat)


def make_dem(path: Path, res: float, *, registration="node", lat_ascending=True,
             lon_0_360=False, include_seam=True, nan_cells=(), marker=True, var="z"):
    if registration == "node":
        lat = np.linspace(-90, 90, int(round(180 / res)) + 1)
    else:
        lat = np.linspace(-90 + res / 2, 90 - res / 2, int(round(180 / res)))
    n_lon = int(round(360 / res)) + (1 if include_seam else 0)
    start = 0.0 if lon_0_360 else -180.0
    if registration == "cell":
        start += res / 2
    lon = start + np.arange(n_lon) * res
    if not lat_ascending:
        lat = lat[::-1]
    lat2d, lon2d = np.meshgrid(lat, lon, indexing="ij")
    z = synthetic_field(lat2d, lon2d)
    if marker:
        i = int(np.argmin(np.abs(lat - MARKER[0])))
        j = int(np.argmin(np.abs(((lon + 180) % 360 - 180) - MARKER[1])))
        z[i, j] = MARKER_ELEV
    for (la, lo) in nan_cells:
        i = int(np.argmin(np.abs(lat - la)))
        j = int(np.argmin(np.abs(((lon + 180) % 360 - 180) - lo)))
        z[i, j] = np.nan
    ds = xr.Dataset({var: (("lat", "lon"), z.astype(np.float32))},
                    coords={"lat": lat, "lon": lon})
    path.parent.mkdir(parents=True, exist_ok=True)
    ds.to_netcdf(path)
    return path


@pytest.fixture(scope="session")
def raw_dirs(tmp_path_factory):
    root = tmp_path_factory.mktemp("raw")
    d1, d01 = root / "dem_1deg", root / "dem_01deg"
    # Names follow the Zenodo pattern loosely: map number first, age last
    make_dem(d1 / "Map34_PALEOMAP_1deg_Late_Jurassic_150Ma.nc", 1.0, nan_cells=[(10, 179)])
    make_dem(d1 / "Map22_PALEOMAP_1deg_KT_Boundary_65Ma.nc", 1.0)
    make_dem(d01 / "Map34_PALEOMAP_6min_Late_Jurassic_150Ma.nc", 0.1, nan_cells=[(-20.0, 0.0)])
    make_dem(d01 / "Map22_PALEOMAP_6min_KT_Boundary_65Ma.nc", 0.1)
    return {1.0: d1, 0.1: d01}
