"""Pipeline step 3: rotate occurrences to each slice with pyGPlates and PALEOMAP v19o_r1d (pipeline §3).

Each occurrence is assigned a plate from the present-day plate polygons, then, for every slice
whose window it overlaps, rotated to the slice's age (not the occurrence's own midpoint), so the
fossil sits on the same map as that slice's DEM.

K–Pg rule (DESIGN §8): the post-extinction slice's window stops at 66 Ma; non-avian dinosaurs
are excluded from it; occurrences whose age range crosses 66 Ma are flagged `straddles_kpg`.

  python -m pipeline.rotate          # reads raw/pbdb/pbdb_clean.csv.gz → raw/rotated/{age}.json.gz
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path

from .config import DATA_RAW, KPG_MA, PLATE_MODEL_DIR, PLATE_POLYGON_FILE, PLATE_ROTATION_FILE, SLICE_HALF_WINDOW, slices
from .io_util import gzip_bytes, write_json

ROTATED_DIR = DATA_RAW / "rotated"

# Non-avian dinosaurs, recognised at any of these ranks. PBDB files dinosaurs under
# Saurischia / Ornithischia (and their subgroups); birds are class Aves and are kept.
DINOSAUR_TAXA = {
    "Dinosauria", "Saurischia", "Ornithischia", "Theropoda", "Sauropodomorpha", "Sauropoda",
    "Prosauropoda", "Ornithopoda", "Ceratopsia", "Ankylosauria", "Stegosauria", "Thyreophora",
    "Marginocephalia", "Pachycephalosauria", "Hadrosauridae", "Ceratopsidae", "Tyrannosauridae",
    "Dromaeosauridae", "Troodontidae", "Ornithomimidae", "Oviraptoridae", "Caenagnathidae",
    "Ankylosauridae", "Nodosauridae", "Titanosauridae", "Abelisauridae",
}


# PBDB also files many dinosaurs as class Reptilia with no order (e.g. Dromaeosauridae,
# Spinosauridae), and their eggs and tracks under ootaxa and ichnotaxa: these families count too.
DINOSAUR_TRACES = {"Grallatoridae", "Eubrontidae", "Anchisauripodidae", "Iguanodontipodidae", "Moyenisauropodidae",
                   "Elongatoolithidae", "Megaloolithidae", "Spheroolithidae", "Prismatoolithidae", "Ovaloolithidae",
                   "Dendroolithidae", "Faveoloolithidae", "Dictyoolithidae", "Macroolithidae", "Youngoolithidae"}


def _dinosaur_names() -> set[str]:
    from .classify_taxa import DINOSAUR_PLANS, load_rules
    try:
        rules = load_rules()
    except FileNotFoundError:
        rules = {}
    return {name for (level, name), (plan, _s) in rules.items() if plan in DINOSAUR_PLANS and level != "genus"}


DINOSAUR_TAXA = DINOSAUR_TAXA | DINOSAUR_TRACES | _dinosaur_names()


def is_non_avian_dinosaur(o: dict) -> bool:
    from .classify_taxa import field
    if field(o, "class") == "Aves":
        return False
    return any(field(o, k) in DINOSAUR_TAXA for k in ("class", "order", "family"))


def window(age: int) -> tuple[float, float]:
    lo, hi = age - SLICE_HALF_WINDOW, age + SLICE_HALF_WINDOW
    if age < KPG_MA < hi:
        hi = KPG_MA                     # the post-extinction slice never reaches back across 66 Ma
    return lo, hi


def overlap(a: tuple[float, float], b: tuple[float, float]) -> float:
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


class Rotator:
    """Plate assignment at 0 Ma and rotation to a slice age, cached per (age, plate)."""

    def __init__(self, model_dir: Path = PLATE_MODEL_DIR):
        import pygplates  # pipeline-only dependency (GPL-2.0-only; never shipped, DESIGN §11)
        self.pg = pygplates
        self.rotations = pygplates.RotationModel(str(model_dir / PLATE_ROTATION_FILE))
        polygons = pygplates.FeatureCollection(str(model_dir / PLATE_POLYGON_FILE))
        self.partitioner = pygplates.PlatePartitioner(polygons, self.rotations, 0)
        self._plates: dict[tuple[float, float], int | None] = {}
        self._rot: dict[tuple[int, int], object] = {}

    def plate(self, lat: float, lon: float) -> int | None:
        key = (round(lat, 4), round(lon, 4))
        if key not in self._plates:
            g = self.partitioner.partition_point(self.pg.PointOnSphere(lat, lon))
            self._plates[key] = g.get_feature().get_reconstruction_plate_id() if g else None
        return self._plates[key]

    def rotate(self, lat: float, lon: float, plate: int, age: int) -> tuple[float, float]:
        k = (age, plate)
        if k not in self._rot:
            self._rot[k] = self.rotations.get_rotation(age, plate)
        la, lo = (self._rot[k] * self.pg.PointOnSphere(lat, lon)).to_lat_lon()
        lo = ((lo + 180.0) % 360.0) - 180.0
        return round(la, 4), round(lo, 4)


def rotate_all(rows: list[dict[str, str]], rotator: Rotator, ages: list[int] | None = None) -> tuple[dict[int, list[dict]], dict]:
    report: dict = {"input": len(rows), "no_plate": 0, "per_slice": {}}
    occ = []
    for r in rows:
        lat, lon = float(r["lat"]), float(r["lng"])
        pid = rotator.plate(lat, lon)
        if pid is None:
            report["no_plate"] += 1
            continue
        occ.append({**r, "lat": lat, "lng": lon, "max_ma": float(r["max_ma"]), "min_ma": float(r["min_ma"]), "plate_id": pid})
    out: dict[int, list[dict]] = {}
    for age in ages or slices():
        w = window(age)
        in_slice = []
        dropped_dinos = 0
        for o in occ:
            ov = overlap((o["min_ma"], o["max_ma"]), w)
            if ov <= 0:
                continue
            straddles = False
            if age < KPG_MA:
                if is_non_avian_dinosaur(o):
                    dropped_dinos += 1
                    continue
                straddles = o["max_ma"] > KPG_MA
            plat, plon = rotator.rotate(o["lat"], o["lng"], o["plate_id"], age)
            in_slice.append({**o, "palaeo_lat": plat, "palaeo_lon": plon,
                             "age_fit": round(min(1.0, ov / max(o["max_ma"] - o["min_ma"], 0.01)), 4),
                             "straddles_kpg": straddles, "slice_age": age})
        out[age] = in_slice
        report["per_slice"][age] = {"occurrences": len(in_slice), "non_avian_dinosaurs_excluded": dropped_dinos}
    return out, report


def write_rotated(rotated: dict[int, list[dict]], out_dir: Path = ROTATED_DIR) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for age, rows in rotated.items():
        rows = sorted(rows, key=lambda o: int(o["occurrence_no"]))
        (out_dir / f"{age}.json.gz").write_bytes(gzip_bytes(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()))


def read_rotated(age: int, in_dir: Path = ROTATED_DIR) -> list[dict]:
    with gzip.open(in_dir / f"{age}.json.gz", "rt", encoding="utf-8") as f:
        return json.load(f)


def run() -> dict:
    from .ingest_pbdb import read_clean
    rotated, report = rotate_all(read_clean(), Rotator())
    write_rotated(rotated)
    write_json(ROTATED_DIR / "rotate_report.json", report)
    print(f"rotated: {report['input'] - report['no_plate']} occurrences on plates ({report['no_plate']} outside all polygons, dropped)")
    return report


if __name__ == "__main__":
    run()
