"""Fossil pipeline steps 2–5 on a synthetic PBDB download (and the real plate model, if present)."""
from __future__ import annotations

import csv
import io
import os
from pathlib import Path

import pytest

from pipeline import bin_occurrences, classify_taxa, ingest_pbdb, rotate
from pipeline.config import KPG_MA, PLATE_MODEL_DIR, PLATE_ROTATION_FILE

HEADER = ingest_pbdb.FIELDS

ROWS = [
    # occ, coll, ref, name, rank, phylum, class, order, family, genus, lng, lat, max, min, env
    (1, 10, 100, "Tyrannosaurus rex", "species", "Chordata", "Saurischia", "", "Tyrannosauridae", "Tyrannosaurus", -106.5, 47.5, 68.0, 66.0, "terrestrial indet."),
    (2, 11, 101, "Ankylosaurus magniventris", "species", "Chordata", "Ornithischia", "", "Ankylosauridae", "Ankylosaurus", -106.4, 47.6, 69.0, 64.0, "fluvial"),
    (3, 12, 102, "Purgatorius unio", "species", "Chordata", "Mammalia", "Primates", "Purgatoriidae", "Purgatorius", -106.3, 47.4, 66.5, 63.0, "fluvial"),
    (4, 12, 102, "Purgatorius unio", "species", "Chordata", "Mammalia", "Primates", "Purgatoriidae", "Purgatorius", -106.3, 47.4, 66.5, 63.0, "fluvial"),  # duplicate in collection
    (5, 13, 103, "Ornithischia", "order", "Chordata", "Ornithischia", "", "", "", -100.0, 40.0, 70.0, 66.0, ""),          # too coarse
    (6, 14, 104, "Araucarites sp.", "genus", "Tracheophyta", "Pinopsida", "Pinales", "Araucariaceae", "Araucarites", 10.0, 50.0, 152.0, 148.0, ""),
    (7, 15, 105, "Mysterium oddum", "species", "Chordata", "Weirdia", "", "", "Mysterium", 0.0, 0.0, 151.0, 149.0, ""),  # unmapped
    (8, 16, 106, "Corvus sp.", "genus", "Chordata", "Aves", "Passeriformes", "Corvidae", "Corvus", 0.0, 10.0, 64.0, 63.0, ""),
    (9, 17, 107, "No coords", "species", "Chordata", "Mammalia", "", "", "X", "", "", 150.0, 149.0, ""),             # missing coords
]


def pbdb_csv() -> str:
    buf = io.StringIO()
    buf.write('"Data Provider","The Paleobiology Database"\n"Data License","Creative Commons CC0"\n')
    buf.write('"Access Time","Sun 2026-11-01 10:00:00 GMT"\n"Parameters:"\n"","timerule","overlap"\n"Records:"\n')
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(HEADER)
    for r in ROWS:
        w.writerow(r)
    return buf.getvalue()


@pytest.fixture()
def cleaned(tmp_path: Path):
    src = tmp_path / "dl.csv"
    src.write_text(pbdb_csv(), encoding="utf-8")
    report = ingest_pbdb.run(src, out_dir=tmp_path / "pbdb")
    rows = ingest_pbdb.read_clean(tmp_path / "pbdb" / "pbdb_clean.csv.gz")
    return rows, report, tmp_path


class IdentityRotator:
    def plate(self, lat, lon):
        return None if (lat, lon) == (0.0, 0.0) and False else 101

    def rotate(self, lat, lon, plate, age):
        return lat, lon


def test_ingest_parses_datainfo_and_cleans(cleaned):
    rows, report, tmp = cleaned
    assert report == {"input": 9, "dropped_missing_coords_or_ages": 1, "dropped_rank_coarser_than_family": 1,
                      "dropped_duplicates_in_collection": 1, "output": 6}
    q = ingest_pbdb.read_json(tmp / "pbdb" / "pbdb_query.json") if hasattr(ingest_pbdb, "read_json") else None
    from pipeline.io_util import read_json
    q = read_json(tmp / "pbdb" / "pbdb_query.json")
    assert q["data_license"] == "Creative Commons CC0" and q["rows_in_file"] == 9
    # deterministic output
    a = (tmp / "pbdb" / "pbdb_clean.csv.gz").read_bytes()
    ingest_pbdb.run(tmp / "dl.csv", out_dir=tmp / "pbdb")
    assert (tmp / "pbdb" / "pbdb_clean.csv.gz").read_bytes() == a


def test_rejects_non_pbdb_csv(tmp_path):
    f = tmp_path / "x.csv"
    f.write_text("a,b\n1,2\n")
    with pytest.raises(ValueError):
        ingest_pbdb.run(f, out_dir=tmp_path / "o")


def test_kpg_rule(cleaned):
    rows, _, _ = cleaned
    out, report = rotate.rotate_all(rows, IdentityRotator(), ages=[70, 65, 150])
    assert rotate.window(65) == (62.5, KPG_MA)
    names65 = {o["accepted_name"]: o for o in out[65]}
    # INVARIANT: no non-avian dinosaur in any slice younger than the K–Pg boundary
    assert not any(rotate.is_non_avian_dinosaur(o) for o in out[65])
    assert report["per_slice"][65]["non_avian_dinosaurs_excluded"] == 1   # Ankylosaurus; T. rex (68–66 Ma) never overlaps the clipped window
    assert names65["Purgatorius unio"]["straddles_kpg"] is True
    assert names65["Corvus sp."]["straddles_kpg"] is False            # birds stay
    assert {o["accepted_name"] for o in out[70]} >= {"Tyrannosaurus rex", "Ankylosaurus magniventris"}
    assert all(0 < o["age_fit"] <= 1 for age in out for o in out[age])


def test_classify_and_bin(cleaned):
    rows, _, _ = cleaned
    out, _ = rotate.rotate_all(rows, IdentityRotator(), ages=[150, 70])
    rules = classify_taxa.load_rules()
    classified, unmapped, report = classify_taxa.classify_all(out, rules)
    by = {o["accepted_name"]: o for o in classified[150] + classified[70]}
    assert by["Araucarites sp."]["body_plan"] == "conifer" and by["Araucarites sp."]["matched_level"] == "family"
    assert by["Tyrannosaurus rex"]["body_plan"] == "large_theropod"
    assert by["Ankylosaurus magniventris"]["body_plan"] == "ankylosaur"
    assert ("Chordata", "Weirdia", "", "") in unmapped
    bins = bin_occurrences.bin_slice(classified[150])
    # INVARIANT: every occurrence appears in exactly one bin
    ids = [o["id"] for v in bins.values() for o in v]
    assert sorted(ids) == sorted(int(o["occurrence_no"]) for o in classified[150])
    assert set(bins[bin_occurrences.bin_key(50.0, 10.0)][0]) >= {"id", "name", "rank", "body_plan", "size_hint", "matched_level", "lat", "lon", "env", "age_range", "age_fit", "ref"}


def test_bin_key_matches_the_app():
    # same cases as src/data/ecology.test.ts binKey()
    assert bin_occurrences.bin_key(35.2, -4.9) == "35_-5"
    assert bin_occurrences.bin_key(90.0, 0.0) == "85_0"
    assert bin_occurrences.bin_key(-0.1, 180.0) == "-5_-180"
    assert bin_occurrences.bin_key(-90.0, 179.9) == "-90_175"


def test_rules_file_is_valid():
    rules = classify_taxa.load_rules()
    assert len(rules) > 100


PM = Path(os.environ.get("TB_PLATE_MODEL_DIR", PLATE_MODEL_DIR))


@pytest.mark.skipif(not (PM / PLATE_ROTATION_FILE).exists(), reason="plate model not downloaded")
def test_real_rotation():
    pytest.importorskip("pygplates")
    r = rotate.Rotator(PM)
    pid = r.plate(47.5, -106.5)
    assert pid is not None
    # INVARIANT: rotating to 0 Ma returns the point
    la, lo = r.rotate(47.5, -106.5, pid, 0)
    assert abs(la - 47.5) < 1e-4 and abs(lo + 106.5) < 1e-4
    la, lo = r.rotate(47.5, -106.5, pid, 65)
    assert -90 <= la <= 90 and -180 <= lo < 180
    assert 45 < la < 65          # Hell Creek sat further north at 65 Ma


def test_real_data_quirks():
    """Shapes seen in the real PBDB download (2026-11-01)."""
    # dinosaurs filed as class Reptilia with no order, and dinosaur egg ootaxa
    raptor = {"class": "Reptilia", "order": "NO_ORDER_SPECIFIED", "family": "Dromaeosauridae"}
    spino = {"class": "Reptilia", "order": "NO_ORDER_SPECIFIED", "family": "Spinosauridae"}
    eggs = {"class": "Reptilia", "order": "NO_ORDER_SPECIFIED", "family": "Elongatoolithidae"}
    turtle = {"class": "Reptilia", "order": "NO_ORDER_SPECIFIED", "family": "Baenidae"}
    assert rotate.is_non_avian_dinosaur(raptor) and rotate.is_non_avian_dinosaur(spino) and rotate.is_non_avian_dinosaur(eggs)
    assert not rotate.is_non_avian_dinosaur(turtle)
    rules = classify_taxa.load_rules()
    # placeholders read as empty: falls through to the class rule
    o = {"phylum": "Pteridophyta", "class": "Polypodiopsida", "order": "NO_ORDER_SPECIFIED", "family": "NO_FAMILY_SPECIFIED",
         "genus": "NO_GENUS_SPECIFIED", "accepted_name": "Cladophlebis sp."}
    assert classify_taxa.classify(o, rules)[:3:2] == ("fern", "class")
    assert classify_taxa.classify(turtle, rules)[0] == "turtle"
    # microfossils are skipped on purpose, counted, and not sent for review
    radiolarian = {"phylum": "Radiozoa", "class": "Polycystinea", "order": "Nassellaria", "family": "Hsuidae", "accepted_name": "X y"}
    out, unmapped, report = classify_taxa.classify_all({150: [radiolarian, {**o, "occurrence_no": "1"}]}, rules)
    assert report[150] == {"classified": 1, "skipped_on_purpose": 1, "unmapped": 0} and not unmapped
