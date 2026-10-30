import * as THREE from "three";
import { FLOOR_H, type RoomDef } from "../sim/roomTypes";

/**
 * Sim plane → world. Top-down rooms keep (x, z) and stack floors FLOOR_H apart;
 * side-view rooms stand the plane up: x stays, sim z (depth below the ceiling) becomes height.
 */
export class Space {
  readonly side: boolean;
  private half: number;
  constructor(room: RoomDef) { this.side = room.view === "side"; this.half = room.size.d / 2; }
  /** World point for sim (x, z) at height y on a floor. */
  at(x: number, z: number, y = 0, floor = 0, out = new THREE.Vector3()): THREE.Vector3 {
    return this.side ? out.set(x, this.half - z, 0) : out.set(x, y + floor * FLOOR_H, z);
  }
  floorY(floor = 0): number { return this.side ? 0 : floor * FLOOR_H; }
}
