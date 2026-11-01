import * as THREE from "three";
import type { Grid } from "../data";

// globe/ §1. Grids go to the GPU as single-channel half-float textures: linear
// filtering of half floats is guaranteed in WebGL2 (full float is not), and the
// precision (≈ 2 m at 4 km, ≈ 4 m at 8 km) is ample for a globe.
// Row 0 (north) is uploaded at v = 0 (flipY off); longitude repeats, latitude clamps.

export function gridTexture(grid: Grid, transform: (stored: number) => number = (v) => v): THREE.DataTexture {
  const data = new Uint16Array(grid.values.length);
  for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(transform(grid.values[i]!));
  const tex = new THREE.DataTexture(data, grid.width, grid.height, THREE.RedFormat, THREE.HalfFloatType);
  tex.flipY = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface SliceTextures {
  age: number;
  elevation: THREE.DataTexture;     // m
  temperature: THREE.DataTexture;   // °C
  precipitation: THREE.DataTexture; // mm/yr
  dispose(): void;
}

export function sliceTextures(age: number, elev: Grid, temp: Grid, prec: Grid): SliceTextures {
  const t = {
    age,
    elevation: gridTexture(elev),
    temperature: gridTexture(temp, (v) => v / temp.scale),
    precipitation: gridTexture(prec, (v) => (v / prec.scale) * 365.25),
    dispose() {
      t.elevation.dispose();
      t.temperature.dispose();
      t.precipitation.dispose();
    },
  };
  return t;
}
