import numpy as np
import pytest
import xarray as xr

from pipeline.grids import load_global_grid, read_csv_list
from pipeline.ingest_climate import ingest_slice, nearest_interval
from pipeline.ingest_dem import ingest_slice as ingest_dem_slice
from pipeline.io_util import read_int16, read_json


def node_axes():
    return np.linspace(-90, 90, 181), np.arange(-180, 181, 1.0)       # 181 × 361, seam included


def temp_field(lat2d, lon2d, offset=0.0):
    # longitude term scaled by cos(lat), so each pole is a single value as on a real sphere
    return 30 * np.cos(np.radians(lat2d)) - 5 + 2 * np.sin(np.radians(lon2d)) * np.cos(np.radians(lat2d)) + offset


def write_temp_csv(path, offset=0.0, header=True, marker=True, anchors=True):
    lat, lon = node_axes()
    lat2d, lon2d = np.meshgrid(lat, lon, indexing="ij")
    t = temp_field(lat2d, lon2d, offset)
    if anchors:                       # as in the real 2024 files: legend anchors at 90°N
        t[-1, 0], t[-1, 1] = 50.0, -55.0
    if marker:
        t[np.argmin(np.abs(lat - 30)), np.argmin(np.abs(lon - 60))] = 55.0
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        if header:
            f.write("Longitude,Latitude,Temperature\n")
        for i in range(lat.size):
            for j in range(lon.size):
                f.write(f"{lon[j]:g},{lat[i]:g},{t[i, j]:.3f}\n")
    return path


def write_precip_nc(path, scale=1.0, cell=False, pad=0):
    if cell:
        lat, lon = np.linspace(-89.5, 89.5, 180), np.arange(-179.5, 180, 1.0)
    else:
        lat, lon = node_axes()
    if pad:                           # as in the real 185–255 Ma files: NaN columns past 180°E
        lon = np.concatenate([lon, 180 + np.arange(1, pad + 1.0)])
    lat2d, lon2d = np.meshgrid(lat, lon, indexing="ij")
    # mm/day, like the real files: tropical max ~8, area mean ~3
    p = scale * (5 * np.exp(-(lat2d / 12) ** 2) + 2 + np.cos(np.radians(lon2d)) * np.cos(np.radians(lat2d)))
    if pad:
        p[:, -pad:] = np.nan
    path.parent.mkdir(parents=True, exist_ok=True)
    xr.Dataset({"pr": (("lat", "lon"), p.astype(np.float32))},
               coords={"lat": lat, "lon": lon}).to_netcdf(path)
    return path


@pytest.fixture(scope="module")
def climate_dirs(tmp_path_factory):
    root = tmp_path_factory.mktemp("climate")
    t, p = root / "temperature", root / "precipitation"
    write_temp_csv(t / "Map32_Tithonian_152.5Ma.csv", offset=0.0)
    write_temp_csv(t / "Map26_Albian_102Ma.csv", offset=4.0)
    write_temp_csv(t / "Map20_Danian_64Ma.csv", offset=-1.0)
    write_temp_csv(t / "060_temp_list.csv", offset=-0.5)
    write_precip_nc(p / "150Ma_precip.nc")
    write_precip_nc(p / "066Ma_precip.nc", scale=0.8, pad=6)
    return {"temp": t, "precip": p}


@pytest.fixture(scope="module")
def out(climate_dirs, raw_dirs, tmp_path_factory):
    out = tmp_path_factory.mktemp("out")
    for age in (150, 65):
        ingest_dem_slice(age, raw_dirs, out)
        ingest_slice(age, climate_dirs, out)
    return out


# ---------------------------------------------------------------- matching

def test_nearest_interval_and_ties():
    files = {152.5: "a", 102.0: "b", 64.0: "c", 66.0: "d"}
    assert nearest_interval(files, 150) == (152.5, "a")
    assert nearest_interval(files, 65) == (66.0, "d")      # tie 64 vs 66 -> older
    assert nearest_interval(files, 100) == (102.0, "b")


# ---------------------------------------------------------------- reading list CSVs

@pytest.mark.parametrize("header", [True, False])
def test_csv_list_orientation(tmp_path, header):
    p = write_temp_csv(tmp_path / "t_150Ma.csv", header=header, anchors=False)
    g = load_global_grid(p, expected_res=1.0)
    assert g.shape == (181, 360) and g.registration == "node"
    assert g.values[60, 240] == pytest.approx(55.0)         # (30N, 60E)
    lat2d, lon2d = np.meshgrid(90 - np.arange(181.0), -180 + np.arange(360.0), indexing="ij")
    expected = temp_field(lat2d, lon2d)
    expected[60, 240] = 55.0
    assert np.allclose(g.values, expected, atol=1e-3)


def test_grid_format_csv_rejected(tmp_path):
    p = tmp_path / "grid_150Ma.csv"
    np.savetxt(p, np.zeros((181, 361)), delimiter=",")
    with pytest.raises(ValueError, match="grid-format"):
        read_csv_list(p)


def test_implausible_units_rejected(tmp_path, out):
    t = tmp_path / "t"
    write_temp_csv(t / "kelvin_150Ma.csv", offset=273.15)   # Kelvin, not °C
    p = tmp_path / "p"
    write_precip_nc(p / "x_150Ma.nc")
    with pytest.raises(ValueError, match="plausible"):
        ingest_slice(150, {"temp": t, "precip": p}, out)


def test_misaligned_grid_rejected(tmp_path, out, climate_dirs):
    p = tmp_path / "p"
    write_precip_nc(p / "x_150Ma.nc", cell=True)
    with pytest.raises(ValueError, match="does not match the globe"):
        ingest_slice(150, {"temp": climate_dirs["temp"], "precip": p}, out)


# ---------------------------------------------------------------- outputs

def test_outputs_scaled_and_aligned(out):
    rec = read_json(out / "globe" / "150.climate.json")
    assert rec["temp"]["source_age"] == 152.5 and rec["temp"]["age_mismatch_myr"] == 2.5
    assert rec["precip"]["source_age"] == 150.0 and rec["precip"]["age_mismatch_myr"] == 0
    assert rec["temp"]["provenance"] == rec["precip"]["provenance"] == "inferred"

    t = read_int16(out / "globe" / "150.temp.i16.gz", (181, 360))
    assert t[60, 240] == 5500                                 # 55.00 °C at (30N, 60E)
    # legend anchors at the North Pole are gone: the pole row is one constant value
    assert len(set(t[0].tolist())) == 1 and abs(int(t[0, 0])) < 1000
    assert rec["temp"]["pole_cells_flattened"] == 2
    assert t[90, 180] == round((30 - 5) * 100)                # equator, lon 0
    p = read_int16(out / "globe" / "150.precip.i16.gz", (181, 360))
    assert p[90, 180] == round((5 + 2 + 1) * 100)             # 8.00 mm/day at (0, 0)
    # INVARIANT: every slice has both grids, in the same layout as the heightmap
    for age in (150, 65):
        for var in ("temp", "precip"):
            assert (out / "globe" / f"{age}.{var}.i16.gz").exists()


def test_precip_in_wrong_units_rejected(tmp_path, out, climate_dirs):
    p = tmp_path / "p"
    write_precip_nc(p / "x_150Ma.nc", scale=30.4)             # mm/month instead of mm/day
    with pytest.raises(ValueError, match="units"):
        ingest_slice(150, {"temp": climate_dirs["temp"], "precip": p}, out)


def test_padding_columns_dropped(out):
    rec = read_json(out / "globe" / "65.climate.json")
    assert rec["precip"]["source_file"] == "066Ma_precip.nc"   # 366-column file read fine


def test_65ma_temperature_override(out):
    # config.CLIMATE_OVERRIDES: the 65 Ma temperature grid is replaced by the 60 Ma one
    rec = read_json(out / "globe" / "65.climate.json")
    assert rec["temp"]["source_age"] == 60.0
    assert rec["temp"]["age_mismatch_myr"] == -5.0
    assert "K–Pg" in rec["temp"]["override_reason"]
    assert rec["precip"]["source_age"] == 66.0 and rec["precip"]["override_reason"] is None


def test_climate_rerun_byte_identical(out, climate_dirs, tmp_path):
    import shutil
    shutil.copytree(out / "globe", tmp_path / "globe")
    ingest_slice(150, climate_dirs, tmp_path)
    for name in ("150.temp.i16.gz", "150.precip.i16.gz", "150.climate.json"):
        assert (tmp_path / "globe" / name).read_bytes() == (out / "globe" / name).read_bytes()
