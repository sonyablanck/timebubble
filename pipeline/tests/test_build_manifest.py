import pytest

from pipeline import config
from pipeline.build_manifest import build, period_of, slice_label
from pipeline.continentality import run_slice as run_continentality
from pipeline.ingest_climate import ingest_slice as ingest_climate_slice
from pipeline.ingest_dem import ingest_slice as ingest_dem_slice
from pipeline.io_util import read_json
from pipeline.tests.test_ingest_climate import climate_dirs  # noqa: F401  (fixture)


@pytest.mark.parametrize("age,expected", [
    (250, ("Triassic", "Early Triassic")),
    (230, ("Triassic", "Late Triassic")),
    (200, ("Jurassic", "Early Jurassic")),
    (150, ("Jurassic", "Late Jurassic")),
    (145, ("Jurassic", "Late Jurassic")),       # base of Cretaceous is 143.1 Ma
    (140, ("Cretaceous", "Early Cretaceous")),
    (66.0, ("Cretaceous", "Late Cretaceous")),  # a base age belongs to the older unit
    (65, ("Palaeogene", "Palaeocene")),
])
def test_period_of(age, expected):
    assert period_of(age) == expected


def test_labels():
    assert slice_label(150) == "150 Ma · Late Jurassic"
    assert slice_label(65) == "65 Ma · Palaeocene · after the extinction"


@pytest.fixture(scope="module")
def built(raw_dirs, climate_dirs, tmp_path_factory):  # noqa: F811
    out = tmp_path_factory.mktemp("out")
    for age in (150, 65):
        ingest_dem_slice(age, raw_dirs, out)
        run_continentality(age, out)
        ingest_climate_slice(age, climate_dirs, out)
    return out, build(out)


def test_manifest_contents(built):
    out, m = built
    assert m == read_json(out / "manifest.json")
    assert [s["age"] for s in m["slices"]] == [150, 65]              # descending
    assert m["plate_model"] == config.PLATE_MODEL_NAME
    s65 = m["slices"][1]
    assert s65["aftermath_mode"] is True and s65["ecology"] is None
    assert s65["grid"] == {"width": 360, "height": 181, "res": 1.0, "registration": "node",
                           "lat_north": 90.0, "lon_west": -180.0}
    assert s65["terrain_grid"]["chunk_rows"] == 19
    for s in m["slices"]:
        for key in ("globe", "continentality", "temperature", "precipitation", "climate_meta", "terrain"):
            assert (out / s[key]).exists()
            assert not s[key].startswith("/") and ".." not in s[key]


def test_data_version_tracks_content(built):
    out, m = built
    assert build(out)["data_version"] == m["data_version"]          # stable on rerun
    (out / "globe" / "extra.txt").write_text("x")
    assert build(out)["data_version"] != m["data_version"]          # changes with data
    (out / "globe" / "extra.txt").unlink()
    build(out)


def test_missing_asset_is_an_error(built, tmp_path):
    import shutil
    out, _ = built
    shutil.copytree(out, tmp_path / "o")
    (tmp_path / "o" / "globe" / "150.precip.i16.gz").unlink()
    with pytest.raises(FileNotFoundError, match="precip"):
        build(tmp_path / "o")
