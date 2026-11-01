"""Which PALEOMAP plate model matches the 2024 PaleoDEMs?

Usage: python pipeline/checks/plate_model_check.py RAW_DIR [ages...]
RAW_DIR holds pm19o/ (item 3a unzipped), pm18e/ (item 3b) and dem/ (item 5a .nc files).
Result on 2026-10-31 (deep = share of present-day land landing below -2000 m):
  age  v19o deep  v18e deep
   65     1.9%      3.0%
  100     2.8%      3.8%
  150     1.8%      4.0%
  200     2.7%      3.7%
  250     3.2%      3.8%
-> v19o_r1d fits the DEMs better at every slice (DESIGN A12).

Present-day land (DEM 0 Ma, elevation >= 0) is sampled on a 0.5° grid, each point is
assigned a plate ID with each model's polygons at 0 Ma, rotated to slice age t, and
looked up in the t Ma DEM. The model the DEMs were built with should put present-day
continental crust on continental crust (elevation >= -200 m) more often.
"""
import sys
import numpy as np
import pygplates
import xarray as xr
import glob

RAW = sys.argv[1]
MODELS = {
    "v19o_r1d": (glob.glob(f"{RAW}/pm19o/*/Scotese_Plate_Model_forPgeog_v19o_r1d_v240506a.rot")[0],
                 glob.glob(f"{RAW}/pm19o/*/Scotese_Plate_Polygons__forPgeog_v19o_v240506.gpml")[0]),
    "v18e":     (glob.glob(f"{RAW}/pm18e/*/m17v2d3_81_v18e_cleanupv1.rot")[0],
                 glob.glob(f"{RAW}/pm18e/*/14_PALEOMAP_PlatePolygons_Medi_15v3d.gpml")[0]),
}
AGES = [int(a) for a in sys.argv[2:]] or [65, 100, 150, 200, 250]


def dem(age):
    f = glob.glob(f"{RAW}/dem/{age:03d}_*.nc")[0]
    ds = xr.open_dataset(f)
    v = ds[[k for k in ds.data_vars if k != "crs"][0]].values
    return ds.latitude.values, ds.longitude.values, v


def lookup(lat_axis, lon_axis, v, lats, lons):
    i = np.clip(np.rint((lat_axis[0] - lats) / 0.1).astype(int), 0, v.shape[0] - 1)
    j = np.rint((((lons + 180) % 360) - 180 - lon_axis[0]) / 0.1).astype(int) % (v.shape[1] - 1)
    return v[i, j]


lat0, lon0, v0 = dem(0)
step = 5                                            # 0.5° sampling
la, lo = np.meshgrid(lat0[::step], lon0[:-1:step], indexing="ij")
land = v0[::step, :-1:step] >= 0
pts_lat, pts_lon = la[land], lo[land]
print(f"present-day land sample points: {pts_lat.size}")

plate_ids = {}
rot_models = {}
for name, (rot, poly) in MODELS.items():
    rm = pygplates.RotationModel(rot)
    rot_models[name] = rm
    part = pygplates.PlatePartitioner(poly, rm, 0)
    ids = np.full(pts_lat.size, -1)
    for k, (a, b) in enumerate(zip(pts_lat, pts_lon)):
        p = part.partition_point(pygplates.PointOnSphere(float(a), float(b)))
        if p is not None:
            ids[k] = p.get_feature().get_reconstruction_plate_id()
    plate_ids[name] = ids
    print(f"{name}: {np.mean(ids >= 0):.1%} of points inside a polygon, {len(set(ids[ids>=0]))} plates")

both = (plate_ids["v19o_r1d"] >= 0) & (plate_ids["v18e"] >= 0)
print(f"points assigned by both models: {both.sum()}\n")

print(f"{'age':>4} | {'v19o on cont.':>13} {'v18e on cont.':>13} | {"v19o deep":>12} {"v18e deep":>12} | median / 90th pct shift between models (km)")
for age in AGES:
    la_t, lo_t, vt = dem(age)
    res, pos = {}, {}
    for name, rm in rot_models.items():
        ids = plate_ids[name][both]
        out_lat = np.empty(ids.size); out_lon = np.empty(ids.size)
        cache = {}
        for k, (pid, a, b) in enumerate(zip(ids, pts_lat[both], pts_lon[both])):
            if pid not in cache:
                cache[pid] = rm.get_rotation(float(age), int(pid))
            q = cache[pid] * pygplates.PointOnSphere(float(a), float(b))
            out_lat[k], out_lon[k] = q.to_lat_lon()
        e = lookup(la_t, lo_t, vt, out_lat, out_lon)
        res[name] = (np.mean(e >= -200), np.mean(e < -2000))
        pos[name] = (out_lat, out_lon)
    a1, o1 = np.radians(pos["v19o_r1d"][0]), np.radians(pos["v19o_r1d"][1])
    a2, o2 = np.radians(pos["v18e"][0]), np.radians(pos["v18e"][1])
    d = 6371 * np.arccos(np.clip(np.sin(a1)*np.sin(a2) + np.cos(a1)*np.cos(a2)*np.cos(o1-o2), -1, 1))
    print(f"{age:>4} | {res['v19o_r1d'][0]:>13.1%} {res['v18e'][0]:>13.1%} | {res['v19o_r1d'][1]:>12.1%} {res['v18e'][1]:>12.1%} | "
          f"{np.median(d):6.0f} / {np.percentile(d, 90):6.0f}")
