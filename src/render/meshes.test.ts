import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DataStore } from "../data";
import { dataRoot, smoothDem } from "../data/testing";
import { TerrainService } from "../terrain/service";
import type { TileData } from "../terrain/tile";
import { vertexLat, vertexLon } from "../terrain/tile";
import { tileIdFor } from "../terrain/tilegrid";
import { buildTileMesh, tileHeightAt } from "./meshes";
import { LocalFrame } from "./projection";

async function tiles() {
  const store = new DataStore({ baseUrl: "/data/", fetcher: dataRoot([150], { demFn: smoothDem }).fetcher });
  const svc = new TerrainService({ store });
  const id = tileIdFor(35.6, 12.1);      // the synthetic mountain belt: rough ground
  const a = (await svc.run({ kind: "tile", sliceAge: 150, id, step: 8 })) as TileData;
  const b = (await svc.run({ kind: "tile", sliceAge: 150, id: { row: id.row, col: id.col + 1 }, step: 8 })) as TileData;
  return { a, b };
}

describe("walk meshes (render §2, §3)", () => {
  it("tileHeightAt reproduces vertex heights and is null outside the tile", async () => {
    const { a } = await tiles();
    for (const [i, j] of [[0, 0], [3, 7], [64, 64], [10, 0]] as [number, number][]) {
      expect(tileHeightAt(a, vertexLat(a.bounds, i * a.step), vertexLon(a.bounds, j * a.step))).toBeCloseTo(a.heights[i * a.n + j]!, 3);
    }
    expect(tileHeightAt(a, a.bounds.latNorth + 0.01, a.bounds.centreLon)).toBeNull();
  });

  it("INVARIANT: the ground under the walker is continuous across an E/W tile edge", async () => {
    const { a, b } = await tiles();
    const lon = a.bounds.lonEast;
    for (const f of [0.1, 0.37, 0.8]) {
      const lat = a.bounds.latSouth + f * (a.bounds.latNorth - a.bounds.latSouth);
      expect(tileHeightAt(a, lat, lon)).toBeCloseTo(tileHeightAt(b, lat, lon)!, 3);
    }
  });

  it("INVARIANT: the camera clamp stands on the drawn triangles (mesh raycast agrees with tileHeightAt)", async () => {
    const { a } = await tiles();
    const frame = new LocalFrame(a.bounds.centreLat, a.bounds.centreLon);
    const tm = buildTileMesh(a, frame, new THREE.MeshBasicMaterial());
    tm.mesh.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    for (const [fy, fx] of [[0.31, 0.62], [0.5, 0.5], [0.77, 0.13]] as [number, number][]) {
      const lat = a.bounds.latSouth + fy * (a.bounds.latNorth - a.bounds.latSouth);
      const lon = a.bounds.lonWest + fx * a.bounds.dlon;
      const [e, n] = frame.en(lat, lon);
      ray.set(new THREE.Vector3(e, 10_000, -n), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(tm.mesh)[0]!;
      const y = tileHeightAt(a, lat, lon)! - LocalFrame.drop(e, n);
      expect(Math.abs(hit.point.y - y)).toBeLessThan(0.05);
    }
  });
});

describe("ring-edge morph (render §5)", () => {
  it("is 0 on the current tile, 1 at the ring's outer edge, and stays in 0..1", async () => {
    const { buildMorph } = await import("./morph");
    const { ring, tileBounds } = await import("../terrain/tilegrid");
    const id = tileIdFor(39.3, 10.2), b = tileBounds(id);
    const frame = new LocalFrame(b.centreLat, b.centreLon);
    const m = buildMorph(frame, ring(id));
    // the whole current tile (incl. its corners) is unmorphed
    for (const [la, lo] of [[b.latNorth, b.lonWest], [b.latSouth, b.lonEast], [b.centreLat, b.centreLon]] as [number, number][]) expect(m(la, lo)).toBe(0);
    // outer edges of the ring: east edge of the east tile, north edge of the north row
    const east = tileBounds({ row: id.row, col: id.col + 1 });
    expect(m(east.centreLat, east.lonEast)).toBeGreaterThan(0.99);
    const north = ring(id).map(tileBounds).filter((t) => t.id.row === id.row + 1);
    expect(m(north[0]!.latNorth, north[1]!.centreLon)).toBeGreaterThan(0.99);
    for (let k = 0; k < 200; k++) {
      const v = m(b.centreLat + (k % 20 - 10) * 0.01, b.centreLon + (Math.floor(k / 20) - 5) * 0.015);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
