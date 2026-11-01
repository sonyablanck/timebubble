import numpy as np
import pytest

from pipeline import config
from pipeline.grids import fill_nodata, list_dem_files, load_global_grid, normalise, parse_age
from pipeline.io_util import read_int16, to_int16, write_int16, write_json
from pipeline.tests.conftest import MARKER, MARKER_ELEV, make_dem, synthetic_field


# ---------------------------------------------------------------- io_util

def test_int16_round_trip(tmp_path):
    x = np.array([[0.4, 0.6, -0.6], [1234.49, -10999.5, 40000.0]])
    stored = write_int16(tmp_path / "a.i16.gz", x)
    back = read_int16(tmp_path / "a.i16.gz", x.shape)
    # INVARIANT: decode(write_int16(x)) == round(x) for every cell (clipped to int16)
    assert np.array_equal(back, to_int16(x))
    assert np.array_equal(back, stored)
    assert back[1, 2] == 32767


def test_int16_rejects_nan(tmp_path):
    with pytest.raises(ValueError):
        write_int16(tmp_path / "a.i16.gz", np.array([[np.nan]]))


def test_writers_are_byte_identical(tmp_path):
    x = np.random.default_rng(1).normal(0, 1000, (50, 70))
    write_int16(tmp_path / "a.i16.gz", x)
    write_int16(tmp_path / "b.i16.gz", x)
    assert (tmp_path / "a.i16.gz").read_bytes() == (tmp_path / "b.i16.gz").read_bytes()
    write_json(tmp_path / "a.json", {"b": 1, "a": [1, 2]})
    write_json(tmp_path / "b.json", {"a": [1, 2], "b": 1})
    assert (tmp_path / "a.json").read_bytes() == (tmp_path / "b.json").read_bytes()


def test_wrong_length_is_an_error(tmp_path):
    write_int16(tmp_path / "a.i16.gz", np.zeros((3, 3)))
    with pytest.raises(ValueError, match="expected"):
        read_int16(tmp_path / "a.i16.gz", (4, 4))


# ---------------------------------------------------------------- file discovery

@pytest.mark.parametrize("name,age", [
    ("Map34_PALEOMAP_1deg_Late_Jurassic_150Ma.nc", 150.0),
    ("Map22_PALEOMAP_6min_KT_Boundary_65Ma.nc", 65.0),
    ("paleodem_102.5Ma.nc", 102.5),
    ("dem_250_Ma.nc", 250.0),
    ("Map01_Present.nc", None),
    # 2024 release (Zenodo 10659112, item 5a): real names
    ("150_v23220d.nc", 150.0),
    ("065_v23219.nc", 65.0),
    ("325_21037b.nc", 325.0),
    ("310_ARM_v23221.nc", 310.0),
    ("darkgreen_v23244.cpt", None),
])
def test_parse_age(name, age):
    assert parse_age(name) == age


def test_duplicate_ages_rejected(tmp_path):
    make_dem(tmp_path / "a_150Ma.nc", 1.0)
    make_dem(tmp_path / "b_150Ma.nc", 1.0)
    with pytest.raises(ValueError, match="two files"):
        list_dem_files(tmp_path)


# ---------------------------------------------------------------- orientation

@pytest.mark.parametrize("lat_ascending", [True, False])
@pytest.mark.parametrize("lon_0_360", [True, False])
@pytest.mark.parametrize("include_seam", [True, False])
def test_canonical_orientation(tmp_path, lat_ascending, lon_0_360, include_seam):
    p = make_dem(tmp_path / "x_150Ma.nc", 1.0, lat_ascending=lat_ascending,
                 lon_0_360=lon_0_360, include_seam=include_seam)
    g = load_global_grid(p, expected_res=1.0)
    assert g.registration == "node"
    assert g.shape == (181, 360)
    assert (g.lat_north, g.lon_west) == (90.0, -180.0)
    # marker at (30N, 60E) -> row 60, column 240
    row, col = int(90 - MARKER[0]), int(MARKER[1] + 180)
    assert g.values[row, col] == MARKER_ELEV
    # every other cell matches the analytic field at its canonical coordinates
    lat2d, lon2d = np.meshgrid(g.lat_of_row(np.arange(181)), g.lon_of_col(np.arange(360)), indexing="ij")
    expected = synthetic_field(lat2d, lon2d).astype(np.float32)
    mask = np.ones(g.shape, bool)
    mask[row, col] = False
    assert np.allclose(g.values[mask], expected[mask], atol=1e-2)


def test_cell_registration_detected(tmp_path):
    p = make_dem(tmp_path / "x_150Ma.nc", 1.0, registration="cell", include_seam=False)
    g = load_global_grid(p, expected_res=1.0)
    assert g.registration == "cell"
    assert g.shape == (180, 360)
    assert g.lat_north == 89.5 and g.lon_west == -179.5


def test_wrong_resolution_rejected(tmp_path):
    p = make_dem(tmp_path / "x_150Ma.nc", 1.0)
    with pytest.raises(ValueError, match="expected 0.1"):
        load_global_grid(p, expected_res=0.1)


def test_fill_nodata_wraps_longitude():
    lat = np.linspace(90, -90, 181)
    lon = np.arange(-180, 180, 1.0)
    v = np.full((181, 360), 99.0)
    v[:, 0:11] = np.nan   # a band of nodata just east of the seam
    v[50, 359] = 7.0      # the nearest valid cell to (row 50, col 0) is across the seam
    g = fill_nodata(normalise(lat, lon, v))
    # INVARIANT: no NaN or nodata remains after fill
    assert np.all(np.isfinite(g.values))
    assert g.values[50, 0] == 7.0           # nearest is across the antimeridian
    assert g.nodata_filled > 0


def test_float32_coordinates_are_snapped():
    # the 2024 100 Ma DEM stores coordinates as float32; steps wobble by ~3e-5°
    lat = np.linspace(90, -90, 181).astype(np.float32) + np.float32(1.5e-5)
    lon = np.arange(-180, 181, 1.0).astype(np.float32) - np.float32(2e-5)
    g = normalise(lat.astype(np.float64), lon.astype(np.float64), np.zeros((181, 361)), expected_res=1.0)
    assert g.registration == "node" and g.shape == (181, 360)
    assert g.lat_north == 90.0 and g.lon_west == -180.0


def test_irregular_axis_still_rejected():
    lon = np.arange(-180, 181, 1.0); lon[100] += 0.3
    with pytest.raises(ValueError, match="regularly spaced"):
        normalise(np.linspace(90, -90, 181), lon, np.zeros((181, 361)))
