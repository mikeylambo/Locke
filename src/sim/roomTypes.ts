/** Room JSON schema. Rooms are data: every vault is one of these files. */

export type Band = "low" | "mid" | "high";
export const BANDS: readonly Band[] = ["low", "mid", "high"];
/** Height ranges (m) and the render height of a beam in each band. */
export const BAND_RANGE: Record<Band, [number, number]> = { low: [0, 0.45], mid: [0.45, 1.15], high: [1.15, 1.9] };
export const BAND_Y: Record<Band, number> = { low: 0.24, mid: 0.82, high: 1.5 };

export type BeamType = "static" | "pulse" | "sweeper" | "oscillator" | "tripwire";
export type Phase = "in" | "out" | "both";
export type Wall = "n" | "s" | "e" | "w";
export type OpticKind = "mirror" | "retro" | "splitter";

export interface BlockDef { x: number; z: number; w: number; d: number; h: number; style?: "plinth" | "case" | "column" | "post" | "pedestal" | "sensor" | "rail" }
export interface MountDef { id: string; x: number; z: number }
export interface SensorDef { id: string; x: number; z: number }

export interface EmitterDef {
  id: string;
  type: BeamType;
  x: number; z: number;
  /** Direction in degrees (0 = east, 90 = south). Sweepers use it as the start angle. */
  angle: number;
  bands: Band[];
  phase?: Phase;
  /** Beam is off while this sensor receives light. */
  poweredBy?: string;
  /** Only lights once threat reaches this state. */
  threat?: "disturbed" | "alert";
  /** Pulse: on for `duty` of every `period` beats, shifted by `offset` beats. */
  pulse?: { period: number; duty: number; offset?: number };
  /** Sweeper: degrees per beat (negative = counter-clockwise); optional ping-pong arc. */
  sweep?: { speed: number; min?: number; max?: number };
  /** Oscillator: emitter slides along this axis (degrees) by ±travel over period beats. */
  osc?: { axis: number; travel: number; period: number };
  /** Spokes evenly spaced around the anchor (sweepers / prize fans). */
  spokes?: number;
  /** Max beam reach before the first bounce (m). */
  range?: number;
  /** Ray starts this far from the anchor (lets a fan escape its own pedestal). */
  startOffset?: number;
  /** Scale degree (1-based) in the room key this beam sings. */
  note?: number;
  /** Visual tint key; defaults to security red. */
  tint?: "red" | "prism" | "emerald" | "violet" | "gold";
  /** Emitter housing is mounted on a wall vs a free-standing post. */
  housing?: "wall" | "post" | "none";
}

export interface ExitDef { id: string; x: number; z: number; wall: Wall; phase: "in" | "out"; closesOnAlert?: boolean }

export interface PrizeDef { kind: "diamond" | "crystal" | "ruby"; x: number; z: number; value: number; name: string }

export interface RoomDef {
  id: string;
  name: string;
  venue: string;
  headline: string;
  size: { w: number; d: number; h: number };
  key: { root: string; mode: "major" | "minor" | "dorian" | "mixolydian" | "lydian" };
  tempo: number;
  parTime: number;
  spawn: { x: number; z: number; facing: number };
  entry: ExitDef;
  blocks: BlockDef[];
  mounts: MountDef[];
  sensors: SensorDef[];
  emitters: EmitterDef[];
  exits: ExitDef[];
  prize: PrizeDef;
  belt: OpticKind[];
  /** Tutorial vaults: contact shows Disturbed but never escalates. */
  forgiving?: boolean;
}
