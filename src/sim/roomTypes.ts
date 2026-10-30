/** Room JSON schema. Rooms are data: every vault is one of these files. */

export type Band = "low" | "mid" | "high";
export const BANDS: readonly Band[] = ["low", "mid", "high"];
/** Height ranges (m) and the render height of a beam in each band. */
export const BAND_RANGE: Record<Band, [number, number]> = { low: [0, 0.45], mid: [0.45, 1.15], high: [1.15, 1.9] };
export const BAND_Y: Record<Band, number> = { low: 0.24, mid: 0.82, high: 1.5 };

export type BeamType = "static" | "pulse" | "sweeper" | "oscillator" | "tripwire" | "camera" | "pendulum" | "projector";
export type Phase = "in" | "out" | "both";
export type Wall = "n" | "s" | "e" | "w";
export type OpticKind = "mirror" | "retro" | "splitter" | "concave" | "convex";
/** Band-shift mirrors: concave throws the beam one band up, convex one band down. */
export const BAND_SHIFT: Partial<Record<OpticKind, 1 | -1>> = { concave: 1, convex: -1 };

export interface BlockDef { x: number; z: number; w: number; d: number; h: number; style?: "plinth" | "case" | "column" | "post" | "pedestal" | "sensor" | "rail" | "statue" | "ledge"; solid?: boolean;
  /** Locke can step up onto it: his body rides one band higher while on top. */
  stand?: boolean; floor?: number }
export interface MountDef { id: string; x: number; z: number; floor?: number;
  /** Light reflected off an optic here drops (or rises) through a grate onto this floor. */
  well?: number;
  /** Side view: a hook the stretched hand can catch and hang from. */
  hook?: boolean }
export interface SensorDef { id: string; x: number; z: number; floor?: number }
/** A pre-installed optic: rotatable in place but bolted down. */
export interface FixedOpticDef { mountId: string; kind: OpticKind; angle: number; rotatable?: boolean }
/** Floor plate. Pressed while Locke stands on it (or while the prize sits on it, for `prize` plates). */
export interface PlateDef { id: string; x: number; z: number; w: number; d: number; floor?: number;
  /** Phase in which the plate is live; pressing a live alarm plate trips like a beam. */
  phase?: Phase; alarm?: boolean; prize?: boolean }
/** Brass grille gate: solid until every signal in `opens` is on at once (sensors lit / plates held). */
export interface ShutterDef { id: string; x: number; z: number; w: number; d: number; h?: number; floor?: number; opens: string[];
  /** Once open, stays open. */ latch?: boolean;
  /** Slams shut (and stays shut) on the out phase: the room's way in seals behind him. */ sealOnLift?: boolean }
/** Stairs link two floors; walk into the zone and press interact. */
export interface StairDef { id: string; x: number; z: number; w: number; d: number; from: number; to: number }
/** A vertical shaft of light through a floor grate (fires up into the floor above). */
export interface GrateDef { id: string; x: number; z: number; floor: number; emitter?: string; phase?: Phase; pulse?: { period: number; duty: number; offset?: number } }

export interface EmitterDef {
  id: string;
  floor?: number;
  /** Overrides applied once the prize lifts (the room flips). */
  out?: Partial<Omit<EmitterDef, "id" | "out">>;
  /** Drawn faintly from floor level: only the camera obscura shows it plainly. */
  hidden?: boolean;
  /** Projector: casts the same spokes on every floor. */
  allFloors?: boolean;
  /** Pendulum: swing plane (deg), amplitude (m) and full period (beats); the blade is `range` long. */
  swing?: { plane: number; amp: number; period: number };
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
  tint?: "red" | "prism" | "emerald" | "violet" | "gold" | "camera";
  /** Emitter housing is mounted on a wall vs a free-standing post. */
  housing?: "wall" | "post" | "none";
}

export interface ExitDef { id: string; x: number; z: number; wall: Wall; phase: "in" | "out"; floor?: number }

export interface PrizeDef { kind: "diamond" | "crystal" | "ruby" | "sapphire" | "crown"; x: number; z: number; value: number; name: string; floor?: number; y?: number }

export interface RoomDef {
  id: string;
  name: string;
  venue: string;
  headline: string;
  size: { w: number; d: number; h: number };
  key: { root: string; mode: "major" | "minor" | "dorian" | "mixolydian" | "lydian" };
  tempo: number;
  parTime: number;
  spawn: { x: number; z: number; facing: number; floor?: number };
  entry: ExitDef;
  blocks: BlockDef[];
  mounts: MountDef[];
  sensors: SensorDef[];
  emitters: EmitterDef[];
  exits: ExitDef[];
  prize: PrizeDef;
  belt: OpticKind[];
  /** Visual dressing: same sim, different joint. */
  theme?: "museum" | "pawnshop" | "jeweler" | "hotel" | "gallery";
  /** Lettering over the back wall. */
  sign?: string;
  /** Tutorial vaults: contact shows Disturbed but never escalates. */
  forgiving?: boolean;
  /** Polygon footprint (x,z pairs, clockwise from the camera's view); defaults to the size rectangle. */
  outline?: Array<[number, number]>;
  /** Number of stacked floors (balconies); upper floors sit FLOOR_H above. */
  floors?: number;
  stairs?: StairDef[];
  grates?: GrateDef[];
  plates?: PlateDef[];
  shutters?: ShutterDef[];
  fixedOptics?: FixedOpticDef[];
  /** Camera obscura station: interact while casing to see the hidden beams from above. */
  obscura?: { x: number; z: number; floor?: number };
  /** Painted portraits whose eyes follow Locke (facing: degrees the canvas looks toward). */
  portraits?: Array<{ x: number; z: number; facing: number; floor?: number; name?: string }>;
  /** The designer's blueprint card shown while casing. */
  note?: string;
  author?: string;
  /** Tempo once the prize lifts (the flip). */
  tempoOut?: number;
  /** "side": an x/height plane with gravity and stretch-as-rope; z is depth below the ceiling. */
  view?: "top" | "side";
  /** Set piece with no prize: reach an exit (phase "in") to finish. */
  setPiece?: boolean;
  /** Room that this one hands straight into on escape (a getaway set piece). */
  next?: string;
}

export const FLOOR_H = 2.6;
