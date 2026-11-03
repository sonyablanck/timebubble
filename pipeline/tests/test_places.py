"""Step 7 (places): crust-age rules, and the baked rotations against pyGPlates when the plate model is present."""
from __future__ import annotations

import math

import numpy as np
import pytest

from pipeline import config
from pipeline.places import NAMED_PLACES, stated_age, youngest


def test_stated_age_ignores_unset_and_distant_past():
    assert stated_age((0.0, 0.0)) is None             # PALEOMAP's "not stated"
    assert stated_age((0.0, -math.inf)) is None
    assert stated_age((math.inf, 600.0)) is None
    assert stated_age((4500.0, -math.inf)) is None    # "since the Hadean": no claim
    assert stated_age((89.0, -math.inf)) == 89.0


def test_youngest_stated_age_wins():
    assert youngest(None, None) is None
    assert youngest(600.0, None) == 600.0
    assert youngest(30.0, 15.0) == 15.0               # Iceland: the plate polygon is younger than the ocean band


HAVE_MODEL = (config.PLATE_MODEL_DIR / config.PLATE_ROTATION_FILE).exists()


@pytest.mark.skipif(not HAVE_MODEL, reason="plate model not in pipeline/raw/plate_model")
def test_quaternions_match_pygplates():
    pytest.importorskip("pygplates")
    from pipeline.places import PlaceModel
    m = PlaceModel()

    def qrot(q, v):
        w, u = q[0], np.array(q[1:])
        return v + 2 * np.cross(u, np.cross(u, v) + w * v)

    for name, (lat, lon) in NAMED_PLACES.items():
        plate, _ = m.lookup(lat, lon)
        for age in (65, 150, 250):
            la, lo = math.radians(lat), math.radians(lon)
            v = np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
            got = qrot(m.quaternion(age, plate), v)
            want = np.array((m.rot.rotations.get_rotation(age, plate) * m.pg.PointOnSphere(lat, lon)).to_xyz())
            assert np.linalg.norm(got - want) * 6371 < 0.001, (name, age)


@pytest.mark.skipif(not HAVE_MODEL, reason="plate model not in pipeline/raw/plate_model")
def test_crust_ages_for_known_places():
    pytest.importorskip("pygplates")
    from pipeline.places import PlaceModel
    m = PlaceModel()
    assert m.lookup(*NAMED_PLACES["Reykjavik"])[1] == 15.0
    assert 80 <= m.lookup(*NAMED_PLACES["Honolulu"])[1] <= 100      # Pacific seafloor, Late Cretaceous
    assert m.lookup(*NAMED_PLACES["Hastings"])[1] in (None, 600.0)   # old continental crust
