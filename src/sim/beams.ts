import { type V2, add, dirFromDeg, dot, raySegment, rayCircle, scale, sub, norm, v2 } from "./math2d";
import type { Band, BlockDef, EmitterDef, OpticKind, RoomDef } from "./roomTypes";

export const MAX_BOUNCES = 32;
export const MIRROR_HALF = 0.3;
export const SENSOR_R = 0.2;
export const PRIZE_R = 0.28;
export const UNFOLD_BEATS = 1.5;

/** Columns, cabinets and pedestals are solid cover; rails only when the room marks them solid. */
export const isSolid = (b: BlockDef) => b.solid ?? (b.style === "column" || b.style === "case" || b.style === "pedestal");

export interface PlacedOptic { mountId: string; kind: OpticKind; angle: number }

export interface BeamSegment {
  emitter: string;
  band: Band;
  a: V2;
  b: V2;
  /** Distance travelled from the emitter at segment start (for dash continuity). */
  s0: number;
  tint: NonNullable<EmitterDef["tint"]>;
  type: EmitterDef["type"];
  /** Live = dangerous now. Warn = telegraphing (pulse about to fire). */
  live: boolean;
  warn: number;
  bounce: number;
  /** Spoke index within a multi-spoke emitter (for prism hues). */
  spoke: number;
  /** Segment starts at a placed optic (reflected/split/retro light). */
  fromOptic?: boolean;
}

export interface BeamWorld {
  beat: number;
  /** Accumulated sweep angle per sweeper emitter (deg). */
  sweep: Record<string, number>;
  optics: PlacedOptic[];
  threat: number;
  phase: "in" | "out";
  prizeLifted: boolean;
  /** Beat at which the prize was lifted; out-phase beams unfold for one beat after it. */
  liftBeat?: number;
}

export interface BeamFrame { segments: BeamSegment[]; fed: Set<string>; emitterOn: Record<string, boolean> }

interface Wall { a: V2; b: V2 }
type Hit = { t: number; kind: "wall" | "mirror" | "retro" | "splitter" | "sensor" | "prize"; normal?: V2; id?: string };

export function pulseState(e: EmitterDef, beat: number): { on: boolean; warn: number } {
  if (!e.pulse) return { on: true, warn: 0 };
  const { period, duty, offset = 0 } = e.pulse;
  const p = (((beat + offset) % period) + period) % period;
  const on = p < duty * period;
  // Telegraph ramps up during the last quarter beat before ignition.
  const until = period - p;
  const warn = !on && until < 0.25 ? 1 - until / 0.25 : 0;
  return { on, warn };
}

/** Is this emitter part of the current room configuration (ignoring pulse timing/power)? */
export function emitterActive(e: EmitterDef, w: Pick<BeamWorld, "phase" | "threat">): boolean {
  const phase = e.phase ?? "both";
  if (phase !== "both" && phase !== w.phase) return false;
  if (e.threat === "disturbed" && w.threat < 1) return false;
  if (e.threat === "alert" && w.threat < 2) return false;
  return true;
}

export function emitterOrigin(e: EmitterDef, beat: number): V2 {
  if (!e.osc) return v2(e.x, e.z);
  const ax = dirFromDeg(e.osc.axis);
  const k = Math.sin((beat / e.osc.period) * Math.PI * 2) * e.osc.travel;
  return v2(e.x + ax.x * k, e.z + ax.z * k);
}

export function emitterAngles(e: EmitterDef, sweepDeg: number): number[] {
  const base = e.type === "sweeper" ? sweepDeg : e.angle;
  const n = e.spokes ?? 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base + (360 / n) * i);
  return out;
}

/** Ping-pong / continuous sweep angle from an accumulated phase. */
export function sweepAngle(e: EmitterDef, acc: number): number {
  const s = e.sweep;
  if (!s || s.min === undefined || s.max === undefined) return e.angle + acc;
  const span = s.max - s.min;
  const p = ((acc % (span * 2)) + span * 2) % (span * 2);
  return s.min + (p < span ? p : span * 2 - p);
}

export class BeamEngine {
  private walls: Wall[] = [];
  private blockWalls: Array<Wall & { h: number }> = [];
  private mounts = new Map<string, V2>();

  constructor(readonly room: RoomDef) {
    const hw = room.size.w / 2, hd = room.size.d / 2;
    const c = [v2(-hw, -hd), v2(hw, -hd), v2(hw, hd), v2(-hw, hd)];
    for (let i = 0; i < 4; i++) this.walls.push({ a: c[i]!, b: c[(i + 1) % 4]! });
    for (const b of room.blocks) {
      const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
      const q = [v2(x0, z0), v2(x1, z0), v2(x1, z1), v2(x0, z1)];
      // Solid props stop light at every height; others only where they're taller than the band.
      const h = isSolid(b) ? Infinity : b.h;
      for (let i = 0; i < 4; i++) this.blockWalls.push({ a: q[i]!, b: q[(i + 1) % 4]!, h });
    }
    for (const m of room.mounts) this.mounts.set(m.id, v2(m.x, m.z));
  }

  mountPos(id: string): V2 | undefined { return this.mounts.get(id); }

  /** Trace the whole room. Iterates so sensor-powered grids settle within one frame. */
  trace(w: BeamWorld, prevFed?: Set<string>): BeamFrame {
    let fed = prevFed ?? new Set<string>();
    let frame: BeamFrame = { segments: [], fed, emitterOn: {} };
    for (let iter = 0; iter < 3; iter++) {
      frame = this.traceOnce(w, fed);
      if (sameSet(frame.fed, fed)) break;
      fed = frame.fed;
    }
    return frame;
  }

  private traceOnce(w: BeamWorld, fed: Set<string>): BeamFrame {
    const segments: BeamSegment[] = [];
    const newFed = new Set<string>();
    const emitterOn: Record<string, boolean> = {};
    for (const e of this.room.emitters) {
      if (!emitterActive(e, w)) { emitterOn[e.id] = false; continue; }
      if (e.poweredBy && fed.has(e.poweredBy)) { emitterOn[e.id] = false; continue; }
      const ps = pulseState(e, w.beat);
      if (e.phase === "out" && w.liftBeat !== undefined && w.beat - w.liftBeat < UNFOLD_BEATS) {
        ps.on = false;
        ps.warn = Math.max(0.05, (w.beat - w.liftBeat) / UNFOLD_BEATS);
      }
      emitterOn[e.id] = ps.on;
      if (!ps.on && ps.warn <= 0) continue;
      const o = emitterOrigin(e, w.beat);
      const angles = emitterAngles(e, sweepAngle(e, w.sweep[e.id] ?? 0));
      angles.forEach((ang, spoke) => {
        const d = dirFromDeg(ang);
        const start = e.startOffset ? add(o, scale(d, e.startOffset)) : o;
        for (const band of e.bands) {
          this.cast(e, band, start, d, w, ps.on, ps.warn, spoke, segments, newFed);
        }
      });
    }
    return { segments, fed: newFed, emitterOn };
  }

  private cast(e: EmitterDef, band: Band, o: V2, d: V2, w: BeamWorld, live: boolean, warn: number, spoke: number,
    out: BeamSegment[], fed: Set<string>, depth = 0, travelled = 0, optic = false): void {
    let origin = o, dir = d, s = travelled, fromOptic = optic;
    let firstLeg = true;
    for (let bounce = depth; bounce < MAX_BOUNCES; bounce++) {
      const hit = this.nearest(origin, dir, band, w);
      let t = hit.t;
      let endKind = hit.kind;
      if (firstLeg && e.range !== undefined && e.range < t) { t = e.range; endKind = "wall"; }
      const end = add(origin, scale(dir, t));
      out.push({ emitter: e.id, band, a: origin, b: end, s0: s, tint: e.tint ?? "red", type: e.type, live, warn, bounce, spoke, fromOptic });
      s += t;
      firstLeg = false;
      if (!live) return; // a telegraph doesn't feed sensors or bounce power around
      if (endKind === "sensor" && hit.id) { fed.add(hit.id); return; }
      if (endKind === "mirror" && hit.normal) {
        const n = hit.normal;
        dir = norm(sub(dir, scale(n, 2 * dot(dir, n))));
        origin = add(end, scale(dir, 1e-4));
        fromOptic = true;
        continue;
      }
      if (endKind === "retro") {
        dir = scale(dir, -1);
        origin = add(end, scale(dir, 1e-4));
        fromOptic = true;
        continue;
      }
      if (endKind === "splitter" && hit.normal) {
        // Half passes straight through, half reflects 90°.
        const n = hit.normal;
        const refl = norm(sub(dir, scale(n, 2 * dot(dir, n))));
        this.cast(e, band, add(end, scale(refl, 1e-4)), refl, w, live, warn, spoke, out, fed, bounce + 1, s, true);
        origin = add(end, scale(dir, 1e-3));
        fromOptic = true;
        continue;
      }
      return;
    }
  }

  private nearest(o: V2, d: V2, band: Band, w: BeamWorld): Hit {
    let best: Hit = { t: 1e3, kind: "wall" };
    for (const wl of this.walls) {
      const t = raySegment(o, d, wl.a, wl.b);
      if (t > 0 && t < best.t) best = { t, kind: "wall" };
    }
    const bandY = band === "low" ? 0.24 : band === "mid" ? 0.82 : 1.5;
    for (const wl of this.blockWalls) {
      if (wl.h < bandY) continue;
      const t = raySegment(o, d, wl.a, wl.b);
      if (t > 0 && t < best.t) best = { t, kind: "wall" };
    }
    for (const op of w.optics) {
      const c = this.mounts.get(op.mountId);
      if (!c) continue;
      if (op.kind === "retro") {
        const t = rayCircle(o, d, c, 0.16);
        if (t > 0 && t < best.t) best = { t, kind: "retro" };
        continue;
      }
      const along = dirFromDeg(op.angle);
      const a = add(c, scale(along, -MIRROR_HALF)), b = add(c, scale(along, MIRROR_HALF));
      const t = raySegment(o, d, a, b);
      if (t > 0 && t < best.t) {
        let n = v2(-along.z, along.x);
        if (dot(n, d) > 0) n = scale(n, -1);
        best = { t, kind: op.kind === "splitter" ? "splitter" : "mirror", normal: n };
      }
    }
    for (const sn of this.room.sensors) {
      const t = rayCircle(o, d, v2(sn.x, sn.z), SENSOR_R);
      if (t > 0 && t < best.t) best = { t, kind: "sensor", id: sn.id };
    }
    if (!w.prizeLifted) {
      const p = this.room.prize;
      const t = rayCircle(o, d, v2(p.x, p.z), PRIZE_R);
      if (t > 0 && t < best.t) best = { t, kind: "prize" };
    }
    return best;
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
