"""Step 1b: signed distance to coast on the 1° grid (pipeline/PSEUDOCODE.md §1b).

Reads public/data/globe/{age}.i16.gz (written by ingest_dem) and writes
public/data/globe/{age}.continentality.i16.gz: great-circle km to the nearest
coast cell, positive on land, negative at sea, 0 on coast cells.

Usage:  python -m pipeline.continentality [--ages 150 65]
"""
from __future__ import annotations

import argparse
import logging
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from pipeline import config
from pipeline.io_util import read_int16, read_json, write_int16

log = logging.getLogger("continentality")

EARTH_RADIUS_KM = 6371.0


def coast_mask(land: np.ndarray) -> np.ndarray:
    """Land cells with at least one sea neighbour (4-neighbour, longitude wraps)."""
    sea = ~land
    neighbour_sea = np.zeros_like(land)
    neighbour_sea |= np.roll(sea, 1, axis=1) | np.roll(sea, -1, axis=1)   # E/W wrap
    neighbour_sea[1:, :] |= sea[:-1, :]                                    # north neighbour
    neighbour_sea[:-1, :] |= sea[1:, :]                                    # south neighbour
    return land & neighbour_sea


def unit_vectors(lat_deg: np.ndarray, lon_deg: np.ndarray) -> np.ndarray:
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    return np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], axis=-1)


def signed_coast_distance(elev: np.ndarray, lat_north: float, lon_west: float, res: float) -> np.ndarray:
    nlat, nlon = elev.shape
    lats = lat_north - np.arange(nlat) * res
    lons = lon_west + np.arange(nlon) * res
    lat2d, lon2d = np.meshgrid(lats, lons, indexing="ij")

    land = elev >= 0
    coast = coast_mask(land)
    if not coast.any():
        raise ValueError("no coast cells: grid is all land or all sea")

    pts = unit_vectors(lat2d, lon2d).reshape(-1, 3)
    tree = cKDTree(pts[coast.ravel()])
    chord, _ = tree.query(pts, k=1)
    # chord length on the unit sphere -> central angle -> km
    dist_km = 2.0 * np.arcsin(np.clip(chord / 2.0, 0.0, 1.0)) * EARTH_RADIUS_KM
    dist_km = dist_km.reshape(nlat, nlon)
    dist_km[coast] = 0.0
    return np.where(land, dist_km, -dist_km)


def run_slice(age: int, out: Path) -> np.ndarray:
    side = read_json(out / "globe" / f"{age}.json")
    elev = read_int16(out / "globe" / f"{age}{config.HEIGHT_EXT}", (side["height"], side["width"]))
    value = signed_coast_distance(elev, side["lat_north"], side["lon_west"], side["res"])
    stored = write_int16(out / "globe" / f"{age}.continentality{config.HEIGHT_EXT}", value)
    log.info("%3d Ma  continentality: max inland %d km, max offshore %d km",
             age, stored.max(), -stored.min())
    return stored


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ages", type=int, nargs="*")
    ap.add_argument("--out", type=Path, default=config.DATA_OUT)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    for age in args.ages or config.slices():
        run_slice(age, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
