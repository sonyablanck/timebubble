// Field guide "Locate" (ui/ §3): a marker on the located plant or animal: a pale beam rising from
// above it that shows through trees and terrain (so it can be found from a distance), and a pulsing ring
// on the ground around it. The HUD adds a direction arrow and the distance. The marker is a UI aid:
// it is not part of the reconstruction and carries no provenance level.

import * as THREE from "three";

const BEAM_MIN_M = 120;

export class LocateMarker {
  readonly group = new THREE.Group();
  private readonly beam: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private size = 1;

  constructor() {
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    beamGeo.translate(0, 0.5, 0);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false, fog: false, side: THREE.DoubleSide });
    this.beam = new THREE.Mesh(beamGeo, beamMat);
    this.beam.renderOrder = 10;
    const ringGeo = new THREE.RingGeometry(0.82, 1, 40);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.85, depthWrite: false, fog: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.renderOrder = 9;
    this.group.add(this.beam, this.ring);
    this.group.visible = false;
    this.group.name = "locate marker";
    for (const m of [this.beam, this.ring]) m.frustumCulled = false;
  }

  /** Show the marker at a base point; `size` is the organism's length or height in metres. */
  place(x: number, y: number, z: number, size: number): void {
    this.size = Math.max(1, size);
    this.group.position.set(x, y, z);
    this.group.visible = true;
  }

  hide(): void { this.group.visible = false; }

  /** Pulse the ring; widen the beam with distance so it stays visible far away. */
  update(time: number, distanceM: number): void {
    const r = this.size * 0.75 * (1 + 0.12 * Math.sin(time * 3));
    this.ring.scale.set(r, 1, r);
    this.ring.position.y = 0.15;
    const w = Math.max(0.25 * this.size, distanceM * 0.004);
    // tall enough to stand out above the canopy from afar (≈ 14° of sky at any distance beyond 500 m)
    this.beam.scale.set(w, Math.max(BEAM_MIN_M, distanceM * 0.25), w);
    this.beam.position.y = this.size * 0.9;   // starts above the organism, so it never hides it up close
    (this.beam.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(0.15 + distanceM / 1500, 0.15, 0.5);
  }

  dispose(): void {
    for (const m of [this.beam, this.ring]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
  }
}
