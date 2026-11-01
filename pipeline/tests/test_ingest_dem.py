import hashlib

import numpy as np
import pytest

from pipeline import config
from pipeline.continentality import coast_mask, run_slice, signed_coast_distance
from pipeline.grids import load_global_grid
from pipeline.ingest_dem import ingest_slice
from pipeline.io_util import read_int16, read_json, to_int16

N = config.CELLS_PER_CHUNK
S = config.CHUNK_STORED


@pytest.fixture(scope="module")
def out(raw_dirs, tmp_path_factory):
    out = tmp_path_factory.mktemp("out")
    for age in (150, 65):
        ingest_slice(age, raw_dirs, out)
        run_slice(age, out)
    return out


def tree_hash(root):
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(p.relative_to(root).as_posix().encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def load_chunk(out, age, r, c):
    return read_int16(out / "terrain" / str(age) / f"r{r}_c{c}.i16.gz", (S, S))


# ---------------------------------------------------------------- globe

def test_globe_matches_source(out, raw_dirs):
    side = read_json(out / "globe" / "150.json")
    assert (side["width"], side["height"], side["registration"]) == (360, 181, "node")
    assert side["nodata_filled"] == 1
    globe = read_int16(out / "globe" / "150.i16.gz", (181, 360))
    src = load_global_grid(raw_dirs[1.0] / "Map34_PALEOMAP_1deg_Late_Jurassic_150Ma.nc", 1.0)
    assert np.array_equal(globe, to_int16(src.values))
    assert globe[60, 240] == 5000                   # (30N, 60E) marker


# ---------------------------------------------------------------- terrain chunks

def test_chunk_index(out):
    idx = read_json(out / "terrain" / "150" / "index.json")
    assert (idx["nlat"], idx["nlon"]) == (1801, 3600)
    assert (idx["chunk_rows"], idx["chunk_cols"]) == (19, 36)
    assert len(idx["chunks"]) == 19 * 36
    for key, name in idx["chunks"].items():
        assert (out / "terrain" / "150" / name).exists(), key


def test_chunks_reassemble_to_source(out, raw_dirs):
    src = load_global_grid(raw_dirs[0.1] / "Map34_PALEOMAP_6min_Late_Jurassic_150Ma.nc", 0.1)
    expected = to_int16(src.values)
    rebuilt = np.empty_like(expected)
    for r in range(19):
        for c in range(36):
            block = load_chunk(out, 150, r, c)[:N, :N]
            rows = slice(r * N, min(r * N + N, 1801))
            rebuilt[rows, c * N:(c + 1) * N] = block[: rows.stop - rows.start]
    assert np.array_equal(rebuilt, expected)
    # INVARIANT: no NaN or nodata remains after fill (int16 cannot hold NaN;
    # check the filled cell took a neighbour's value instead of a sentinel)
    assert abs(int(rebuilt[1100, 1800])) < 15000


def test_overlap_edges_identical(out):
    # INVARIANT: overlapping edge cells of adjacent chunks are identical
    for r in (0, 7, 17):
        for c in (0, 12, 35):
            a = load_chunk(out, 150, r, c)
            east = load_chunk(out, 150, r, (c + 1) % 36)       # wraps at c = 35
            south = load_chunk(out, 150, r + 1, c)
            assert np.array_equal(a[:, N], east[:, 0])
            assert np.array_equal(a[N, :], south[0, :])


def test_antimeridian_join(out):
    # INVARIANT: the chunk at lon 170 and the chunk at lon -180 join across the antimeridian
    last, first = load_chunk(out, 150, 9, 35), load_chunk(out, 150, 9, 0)
    assert np.array_equal(last[:, N], first[:, 0])
    # and the data are continuous there (continent A straddles lon 180)
    assert np.max(np.abs(last[:, N - 1].astype(int) - first[:, 0].astype(int))) < 20


def test_south_pole_chunk_is_clamped(out):
    tail = load_chunk(out, 150, 18, 3)
    assert np.all(tail[1:, :] == tail[0, :])        # only row 1800 exists; the rest repeat it


# ---------------------------------------------------------------- determinism

def test_rerun_is_byte_identical(out, raw_dirs, tmp_path):
    for age in (150, 65):
        ingest_slice(age, raw_dirs, tmp_path)
        run_slice(age, tmp_path)
    assert tree_hash(tmp_path) == tree_hash(out)


# ---------------------------------------------------------------- continentality

def test_continentality_signs_and_coast(out):
    elev = read_int16(out / "globe" / "150.i16.gz", (181, 360))
    cont = read_int16(out / "globe" / "150.continentality.i16.gz", (181, 360))
    land = elev >= 0
    coast = coast_mask(land)
    assert np.all(cont[coast] == 0)
    inner = np.zeros_like(coast)
    inner[1:-1, :] = True                           # pole rows collapse to one point
    # INVARIANT: |value| == 0 only on coast cells
    assert np.all(cont[inner & ~coast] != 0)
    assert np.all(cont[land & ~coast] > 0)
    assert np.all(cont[~land] < 0)


def test_continentality_wraps_antimeridian(out):
    cont = read_int16(out / "globe" / "150.continentality.i16.gz", (181, 360)).astype(int)
    # INVARIANT: value continuous across the antimeridian (neighbours differ by
    # at most about one cell, ~111 km, plus rounding)
    assert np.max(np.abs(cont[:, 0] - cont[:, 359])[1:-1]) <= 112


def test_continentality_distance_on_a_cap():
    # A circular continent of angular radius 30° centred on the equator at lon 0
    lats = 90 - np.arange(181.0)
    lons = -180 + np.arange(360.0)
    la, lo = np.meshgrid(np.radians(lats), np.radians(lons), indexing="ij")
    ang = np.degrees(np.arccos(np.clip(np.cos(la) * np.cos(lo), -1, 1)))
    elev = np.where(ang < 30, 500.0, -3000.0)
    d = signed_coast_distance(elev, 90.0, -180.0, 1.0)
    km_per_deg = np.pi * 6371 / 180
    expected = (30 - ang) * km_per_deg            # +inside, −outside
    far = np.abs(ang - 30) > 3
    # within ~1.5 cells of the analytic distance (the coast is rasterised)
    assert np.max(np.abs(d[far] - expected[far])) < 1.5 * km_per_deg
    assert d[90, 180] == pytest.approx(30 * km_per_deg, abs=1.5 * km_per_deg)


# ---------------------------------------------------------------- 1° derived from 0.1° (2024 release)

from pipeline.grids import GlobalGrid, derive_coarse  # noqa: E402


def test_derive_constant_and_shape():
    fine = GlobalGrid(values=np.full((1801, 3600), 123.0), res=0.1, registration="node",
                      lat_north=90.0, lon_west=-180.0)
    g = derive_coarse(fine, 10)
    assert g.shape == (181, 360) and g.res == 1.0
    assert np.allclose(g.values, 123.0)


def test_derive_matches_trapezoid_mean_and_wraps():
    rng = np.random.default_rng(3)
    v = rng.normal(0, 500, (1801, 3600))
    g = derive_coarse(GlobalGrid(v, 0.1, "node", 90.0, -180.0), 10)
    w = np.ones(11); w[0] = w[-1] = 0.5
    ww = np.outer(w, w) / np.outer(w, w).sum()
    # interior node (lat 30, lon 60): rows 595..605, cols 2395..2405
    assert g.values[60, 240] == pytest.approx((v[595:606, 2395:2406] * ww).sum())
    # antimeridian node (lat 0, lon -180): columns wrap from 3595..3599 to 0..5
    cols = np.r_[3595:3600, 0:6]
    assert g.values[90, 0] == pytest.approx((v[895:906][:, cols] * ww).sum())


def test_derive_cell_registration():
    v = np.arange(1800 * 3600, dtype=float).reshape(1800, 3600)
    g = derive_coarse(GlobalGrid(v, 0.1, "cell", 89.95, -179.95), 10)
    assert g.shape == (180, 360) and g.lat_north == 89.5 and g.lon_west == -179.5
    assert g.values[0, 0] == pytest.approx(v[:10, :10].mean())


def test_ingest_without_1deg_folder(raw_dirs, tmp_path):
    dirs = {1.0: tmp_path / "absent", 0.1: raw_dirs[0.1]}
    ingest_slice(150, dirs, tmp_path / "out")
    side = read_json(tmp_path / "out" / "globe" / "150.json")
    assert (side["width"], side["height"]) == (360, 181)
    assert side["resampling"].startswith("area mean")
    globe = read_int16(tmp_path / "out" / "globe" / "150.i16.gz", (181, 360))
    # derived globe agrees with the shipped-1° globe away from sharp features
    src = load_global_grid(raw_dirs[1.0] / "Map34_PALEOMAP_1deg_Late_Jurassic_150Ma.nc", 1.0)
    smooth = np.abs(np.gradient(src.values)[0]) + np.abs(np.gradient(src.values)[1]) < 200
    smooth[60, 240] = False                                   # skip the spike
    assert np.median(np.abs(globe[smooth] - src.values[smooth])) < 5
