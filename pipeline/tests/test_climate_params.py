"""climate_by_age.json (pipeline §1d) and credits.json (§6)."""
import json
from pathlib import Path

import pytest

from pipeline import build_manifest, curate_climate

PARAMS = Path(curate_climate.OUT)


def test_every_slice_has_cited_values():
    params = json.loads(PARAMS.read_text())
    refs = build_manifest.parse_references()
    build_manifest.check_refs(params, refs)                     # INVARIANT: every number has a resolvable ref
    ages = [e["age"] for e in params]
    assert ages == sorted(ages, reverse=True) and ages[0] == 250 and ages[-1] == 65
    for e in params:
        assert e["ice_possible"] == (e["age"] in {165, 150, 145, 140, 135, 130})
        j = e["gmst_judd"]
        assert j["p5"] <= j["p16"] <= j["p50"] <= j["p84"] <= j["p95"]
        assert 5 < e["gmst_scotese"]["c"] < 40 and 5 < j["p50"] < 40
        assert j["stage_ma"][0] <= e["age"] < j["stage_ma"][1]
    sixtyfive = params[-1]
    assert sixtyfive["aftermath"]["impact_winter"]["peak_cooling_c"] == 26
    assert sixtyfive["gmst_scotese"]["grid_age_ma"] == 60        # the documented override


def test_check_refs_rejects_uncited_numbers_and_unknown_keys():
    refs = {"judd2024": "x"}
    with pytest.raises(ValueError, match="without a ref"):
        build_manifest.check_refs([{"age": 1, "refs": [], "gmst": {"c": 1.0}}], refs)
    with pytest.raises(ValueError, match="missing from REFERENCES"):
        build_manifest.check_refs([{"age": 1, "refs": ["nope2000"]}], refs)


def test_stage_lookup_uses_half_open_ranges():
    rows = [{"Stage": "A", "UpperAge": "0", "LowerAge": "10"}, {"Stage": "B", "UpperAge": "10", "LowerAge": "20"}]
    assert curate_climate.stage_for(10.0, rows)["Stage"] == "B"
    assert curate_climate.stage_for(9.99, rows)["Stage"] == "A"


def test_credits_resolve_every_reference():
    c = build_manifest.credits({"pbdb": None}, build_manifest.parse_references())
    assert {d["ref"] for d in c["datasets"]} <= c["references"].keys()
    assert all(not v.startswith("(") for v in c["references"].values())
