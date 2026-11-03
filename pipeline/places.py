"""Pipeline step 7: modern-place lookup, so the app can drop a pin for a searched town (pipeline §7, DESIGN §9).

pyGPlates can't run in the browser (and is GPL-2.0-only, never shipped), so this step bakes the two
things the app needs to rotate any present-day point itself, with the *same* plate model and plate
assignment as the fossils (rotate.py), so a pin and a fossil from the same spot land together:

  places/units.i16.gz   0.1° cell-registered grid (3600 × 1800, row 0 = 90°N, column 0 = 180°W).
                        Each cell holds an index into `units` in places/places.json (0 = no plate).
  places/places.json    `units`: [plate_id, crust_from_ma | null] per index;
                        `rotations`: {age: {plate_id: [w, x, y, z]}}, the unit quaternion that takes a
                        present-day point on that plate to its position at `age` (pyGPlates' finite
                        rotation from 0 Ma, anchor plate 0).

crust_from_ma: the age before which the model has no crust at this spot. From the ocean-floor
polygons (Scotese_OceansOnly, whose valid time is the seafloor's age) where the cell is ocean, and
from the static plate polygon's begin time where that is a real age (e.g. Iceland, accreted
terranes). Begin times of 0 or "distant past" mean "not stated" and give null. The youngest stated
age wins, so the app never claims a place existed when either source says it hadn't formed.

  python -m pipeline.places                 # writes public/data/places/
  python -m pipeline.places --fixture       # also writes tests/fixtures/places_expected.json
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from . import config
from .io_util import write_int16, write_json

OUT_DIR = config.DATA_OUT / "places"
OCEAN_FILE = "Scotese_OceansOnly.gpmlz"
RES = 0.1
WIDTH, HEIGHT = int(round(360 / RES)), int(round(180 / RES))
FIXTURE = config.REPO_ROOT / "tests" / "fixtures" / "places_expected.json"

# Named checks; also used by the tests. (lat, lon) present day.
NAMED_PLACES = {
    "Hastings": (50.855, 0.573),
    "Hell Creek (Jordan, MT)": (47.32, -106.91),
    "Beijing": (39.904, 116.407),
    "Reykjavik": (64.146, -21.942),
    "Honolulu": (21.307, -157.858),
    "Cape Town": (-33.925, 18.424),
    "Sydney": (-33.869, 151.209),
    "Buenos Aires": (-34.604, -58.382),
}


def stated_age(valid_time: tuple[float, float]) -> float | None:
    """A polygon's begin time if it is a real age; 0 and distant past mean 'not stated'."""
    begin = valid_time[0]
    if not math.isfinite(begin) or begin <= 0 or begin >= 4000:
        return None
    return float(begin)


def youngest(*ages: float | None) -> float | None:
    known = [a for a in ages if a is not None]
    return min(known) if known else None


class PlaceModel:
    """Plate and crust age at 0 Ma for any point, using rotate.Rotator's partitioner (same plates as fossils)."""

    def __init__(self, model_dir: Path = config.PLATE_MODEL_DIR):
        from .rotate import Rotator
        self.rot = Rotator(model_dir)
        pg = self.rot.pg
        self.pg = pg
        oceans = pg.FeatureCollection(str(model_dir / OCEAN_FILE))
        self.oceans = pg.PlatePartitioner(oceans, self.rot.rotations, 0)

    def lookup(self, lat: float, lon: float) -> tuple[int, float | None] | None:
        p = self.pg.PointOnSphere(lat, lon)
        g = self.rot.partitioner.partition_point(p)
        if g is None:
            return None
        f = g.get_feature()
        o = self.oceans.partition_point(p)
        ocean_age = stated_age(o.get_feature().get_valid_time()) if o is not None else None
        return f.get_reconstruction_plate_id(), youngest(stated_age(f.get_valid_time()), ocean_age)

    def quaternion(self, age: int, plate: int) -> list[float]:
        r = self.rot.rotations.get_rotation(age, plate)
        if r.represents_identity_rotation():
            return [1.0, 0.0, 0.0, 0.0]
        pole, angle = r.get_euler_pole_and_angle()
        a = angle / 2
        axis = pole.to_xyz()
        q = [math.cos(a), *(math.sin(a) * c for c in axis)]
        if q[0] < 0:
            q = [-c for c in q]           # canonical sign, so files are deterministic
        return [round(c, 9) for c in q]


OCEAN_COARSE = 0.5          # seafloor ages are looked up at 0.5°, then refined to 0.1° along coasts


def _partition(part, pg, lats: np.ndarray, lons: np.ndarray, res: float, out_shape: tuple[int, int],
               value, row0: int = 0, col_index: np.ndarray | None = None) -> dict[tuple[int, int], object]:
    """Partition cell-centre points in bulk (pyGPlates partition_geometry, same polygon order as
    partition_point) and map each point back to its (row, col) in a grid of the given resolution."""
    pts = [(float(a), float(b)) for a in lats for b in lons]
    inside: list = []
    part.partition_geometry(pg.MultiPointOnSphere(pts), inside, [])
    out: dict[tuple[int, int], object] = {}
    for plate, geoms in inside:
        v = value(plate.get_feature())
        for g in geoms:
            for p in g.get_points():
                la, lo = p.to_lat_lon()
                r = int(round((90 - res / 2 - la) / res)); c = int(round((lo + 180 - res / 2) / res)) % out_shape[1]
                out[(r, c)] = v
    return out


def ocean_ages(model: PlaceModel) -> np.ndarray:
    """Seafloor age (Ma) per 0.1° cell: NaN off the ocean-floor polygons, -1 where an ocean polygon states no age.

    Looked up at 0.5° (the ocean file is slow to partition), then every 0.1° cell in a 0.5° block that
    touches the coast (its 3 × 3 coarse neighbourhood mixes ocean and not-ocean) is looked up itself,
    so a coastal town never inherits the seafloor next to it. Inside the ocean the error is at most one
    isochron band (≈ 4 Myr)."""
    pg = model.pg
    n = int(round(1 / OCEAN_COARSE * 180)); m = 2 * n
    k = int(round(OCEAN_COARSE / RES))
    age_of = lambda f: (lambda a: -1.0 if a is None else a)(stated_age(f.get_valid_time()))
    coarse = np.full((n, m), np.nan)
    lons_c = -180 + OCEAN_COARSE / 2 + np.arange(m) * OCEAN_COARSE
    for r0 in range(0, n, 60):
        lats_c = 90 - OCEAN_COARSE / 2 - np.arange(r0, min(n, r0 + 60)) * OCEAN_COARSE
        for (r, c), v in _partition(model.oceans, pg, lats_c, lons_c, OCEAN_COARSE, (n, m), age_of).items():
            coarse[r, c] = v
    fine = np.repeat(np.repeat(coarse, k, axis=0), k, axis=1)
    ocean = ~np.isnan(coarse)
    pad = np.pad(ocean, 1, mode="edge"); pad[1:-1, 0] = ocean[:, -1]; pad[1:-1, -1] = ocean[:, 0]   # lon wraps
    any_o = np.zeros_like(ocean); all_o = np.ones_like(ocean)
    for dr in (0, 1, 2):
        for dc in (0, 1, 2):
            win = pad[dr:dr + n, dc:dc + m]
            any_o |= win; all_o &= win
    mixed = np.argwhere(any_o & ~all_o)
    lons = -180 + RES / 2 + np.arange(WIDTH) * RES
    for R in np.unique(mixed[:, 0]):
        cols = mixed[mixed[:, 0] == R][:, 1]
        sel = np.concatenate([np.arange(C * k, (C + 1) * k) for C in cols])
        fine[R * k:(R + 1) * k, sel] = np.nan
        lats = 90 - RES / 2 - np.arange(R * k, (R + 1) * k) * RES
        for (r, c), v in _partition(model.oceans, pg, lats, lons[sel], RES, (HEIGHT, WIDTH), age_of).items():
            fine[r, c] = v
    print(f"places: seafloor ages at {OCEAN_COARSE}°, {len(mixed)} coastal blocks refined to {RES}°")
    return fine


def build_grid(model: PlaceModel) -> tuple[np.ndarray, list[tuple[int, float | None]]]:
    pg = model.pg
    plate = np.zeros((HEIGHT, WIDTH), dtype=np.int32)
    begin = np.full((HEIGHT, WIDTH), np.nan)
    lons = -180 + RES / 2 + np.arange(WIDTH) * RES
    val = lambda f: (f.get_reconstruction_plate_id(), stated_age(f.get_valid_time()))
    for r0 in range(0, HEIGHT, 100):
        lats = 90 - RES / 2 - np.arange(r0, min(HEIGHT, r0 + 100)) * RES
        for (r, c), (pid, b) in _partition(model.rot.partitioner, pg, lats, lons, RES, (HEIGHT, WIDTH), val).items():
            plate[r, c] = pid
            begin[r, c] = np.nan if b is None else b
    oceans = ocean_ages(model)
    oceans[oceans < 0] = np.nan                  # ocean polygon with no stated age: no claim
    crust = np.fmin(begin, oceans)               # youngest stated age; NaN only where neither states one
    units: list[tuple[int, float | None]] = [(0, None)]          # index 0: no plate
    index: dict[tuple[int, float | None], int] = {}
    grid = np.zeros((HEIGHT, WIDTH), dtype=np.int32)
    keys = plate.astype(np.int64) * 100000 + np.where(np.isnan(crust), 99999, np.rint(crust * 10)).astype(np.int64)
    uniq, inv = np.unique(keys, return_inverse=True)
    lut = np.zeros(len(uniq), dtype=np.int32)
    for i, key in enumerate(uniq):
        pid, cr = int(key // 100000), int(key % 100000)
        if pid == 0:
            continue
        u = (pid, None if cr == 99999 else cr / 10)
        index[u] = len(units); units.append(u); lut[i] = index[u]
    grid = lut[inv.reshape(HEIGHT, WIDTH)]
    if len(units) > 32767:
        raise ValueError(f"{len(units)} plate/crust units do not fit int16")
    return grid, units


def build_rotations(model: PlaceModel, plates: set[int]) -> dict[str, dict[str, list[float]]]:
    return {str(age): {str(p): model.quaternion(age, p) for p in sorted(plates)} for age in config.slices()}


def write_fixture(model: PlaceModel, n_random: int = 120, seed: int = 7) -> None:
    """pyGPlates' own answers for named places and random points, for the TypeScript cross-check."""
    rng = np.random.default_rng(seed)
    pts = dict(NAMED_PLACES)
    for i in range(n_random):
        lat = math.degrees(math.asin(rng.uniform(-1, 1)))
        pts[f"random-{i}"] = (round(lat, 4), round(float(rng.uniform(-180, 180)), 4))
    ages = [65, 100, 150, 200, 250]
    out = []
    for name, (lat, lon) in pts.items():
        u = model.lookup(lat, lon)
        if u is None:
            continue
        plate, crust = u
        pos = {str(a): list(model.rot.rotate(lat, lon, plate, a)) for a in ages}
        out.append({"name": name, "lat": lat, "lon": lon, "plate": plate, "crust_from_ma": crust, "palaeo": pos})
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(out, sort_keys=True, indent=1) + "\n", encoding="utf-8")


def run(fixture: bool = False) -> dict:
    model = PlaceModel()
    grid, units = build_grid(model)
    plates = {p for p, _ in units[1:]}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_int16(OUT_DIR / "units.i16.gz", grid)
    meta = {
        "schema": 1,
        "plate_model": config.PLATE_MODEL_NAME,
        "grid": {"file": "places/units.i16.gz", "width": WIDTH, "height": HEIGHT, "res": RES,
                 "registration": "cell", "lat_north": 90.0, "lon_west": -180.0},
        "units": [[p, c] for p, c in units],
        "rotations": build_rotations(model, plates),
        "method": ("Present-day plate from PALEOMAP v19o static polygons (as for fossils); crust age from "
                   "Scotese_OceansOnly seafloor ages and polygon begin times; rotations are pyGPlates finite "
                   "rotations from 0 Ma, stored as unit quaternions."),
    }
    write_json(OUT_DIR / "places.json", meta)
    covered = float((grid > 0).mean())
    report = {"units": len(units) - 1, "plates": len(plates), "covered_fraction": round(covered, 6),
              "with_crust_age": sum(1 for _, c in units[1:] if c is not None)}
    print(f"places: {report}")
    if fixture:
        write_fixture(model)
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", action="store_true", help="also write tests/fixtures/places_expected.json")
    run(ap.parse_args().fixture)
