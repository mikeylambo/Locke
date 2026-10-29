import { BeamEngine, type BeamFrame, type BeamSegment, type PlacedOptic, PRIZE_R } from "./beams";
import { type V2, add, clamp, closestOnSeg, degFromDir, dirFromDeg, dist, len, pointSegDist, scale, segSegDist, sub, v2, wrapDeg } from "./math2d";
import type { Band, OpticKind, RoomDef } from "./roomTypes";

export const SIM_HZ = 120;
export const DT = 1 / SIM_HZ;

export type Pose = "stand" | "crouch" | "flatten";
export type RunPhase = "case" | "in" | "out" | "escaped" | "lockdown";

export const POSE_BANDS: Record<Pose, Band[]> = { stand: ["low", "mid", "high"], crouch: ["low", "mid"], flatten: ["low", "mid", "high"] };
/** Visual silhouette radius per pose: drives the closest-clearance stat. */
export const POSE_RADIUS: Record<Pose, number> = { stand: 0.26, crouch: 0.3, flatten: 0.07 };
/** Beam hit capsules are ~70% of the silhouette; hat, coat tails and watch chain never collide. */
export const HIT_SCALE = 0.7;
/** Beams leaving a placed optic can't touch Locke within about one body-width of it. */
export const OPTIC_GRACE = 0.55;
const POSE_SPEED: Record<Pose, number> = { stand: 2.25, crouch: 1.25, flatten: 0.95 };
const WALL_RADIUS: Record<Pose, number> = { stand: 0.28, crouch: 0.32, flatten: 0.16 };

export const STRETCH_MAX = 3.0;
const STRETCH_SPEED = 3.6;
const STRETCH_TURN = 280; // deg/s
const RETRACT_SPEED = 11;
const ARM_R = 0.055;
const GRACE = 1.6;
const LOCKDOWN_HOLD = 2.6;

export interface SimInput {
  /** World-space move intent, |m| ≤ 1. */
  move: V2;
  stretch: boolean;
  crouch: boolean;   // pressed edge
  flatten: boolean;  // pressed edge
  interact: boolean; // pressed edge
  rotate: number;    // -1 / 0 / 1 pressed edge
  cycle: boolean;    // pressed edge
}

export const emptyInput = (): SimInput => ({ move: v2(0, 0), stretch: false, crouch: false, flatten: false, interact: false, rotate: 0, cycle: false });

export type SimEvent =
  | { type: "run.start" }
  | { type: "step"; foot: 0 | 1; pos: V2 }
  | { type: "pose"; pose: Pose }
  | { type: "stretch.start"; auto?: boolean }
  | { type: "stretch.bump" }
  | { type: "stretch.release"; length: number }
  | { type: "stretch.snap" }
  | { type: "optic.place"; mountId: string; kind: OpticKind }
  | { type: "optic.pickup"; mountId: string; kind: OpticKind }
  | { type: "optic.rotate"; mountId: string; angle: number }
  | { type: "optic.select"; kind: OpticKind | null }
  | { type: "sensor.fed"; id: string }
  | { type: "sensor.lost"; id: string }
  | { type: "contact"; threat: number; at: V2; emitter: string }
  | { type: "lift" }
  | { type: "exit.closed"; id: string }
  | { type: "escaped"; exit: string }
  | { type: "lockdown" }
  | { type: "restart" }
  | { type: "deny" };

export interface Stretch {
  active: boolean;
  retracting: boolean;
  points: V2[];
  heading: number;
  length: number;
  holding: boolean;
  armBand: Band;
  armY: number;
}

export interface LockeState {
  pos: V2;
  vel: V2;
  facing: number;
  pose: Pose;
  stretch: Stretch;
  stepPhase: number;
  grace: number;
  takeTimer: number;
  hasPrize: boolean;
}

export interface RunSnapshot {
  tick: number; beat: number; phase: RunPhase; threat: number; locke: LockeState; optics: PlacedOptic[]; belt: OpticKind[];
  selected: number; sweep: Record<string, number>; prizeLifted: boolean; liftBeat: number | undefined; prizePos: V2; closedExits: string[]; runTicks: number;
  clearance: number; lockdownTimer: number; escapedVia: string; fed: string[];
}

export interface RunStats { time: number; alarms: number; clearance: number; value: number }

export class HeistRun {
  readonly beams: BeamEngine;
  tick = 0;
  beat = 0;
  phase: RunPhase = "case";
  threat = 0;
  locke: LockeState;
  optics: PlacedOptic[] = [];
  belt: OpticKind[];
  selected = 0;
  sweep: Record<string, number> = {};
  frame: BeamFrame;
  prizeLifted = false;
  liftBeat: number | undefined = undefined;
  prizePos: V2;
  closedExits = new Set<string>();
  runTicks = 0;
  clearance = Infinity;
  lockdownTimer = 0;
  escapedVia = "";
  private fed = new Set<string>();
  private events: SimEvent[] = [];

  constructor(readonly room: RoomDef) {
    this.beams = new BeamEngine(room);
    this.belt = [...room.belt];
    this.prizePos = v2(room.prize.x, room.prize.z);
    this.locke = {
      pos: v2(room.spawn.x, room.spawn.z), vel: v2(0, 0), facing: room.spawn.facing, pose: "stand",
      stretch: { active: false, retracting: false, points: [], heading: 0, length: 0, holding: false, armBand: "mid", armY: 0.95 },
      stepPhase: 0, grace: 0, takeTimer: 0, hasPrize: false
    };
    for (const e of room.emitters) this.sweep[e.id] = 0;
    this.frame = this.beams.trace(this.world());
    this.fed = this.frame.fed;
  }

  get stats(): RunStats {
    return { time: this.runTicks / SIM_HZ, alarms: this.threat, clearance: this.clearance, value: this.room.prize.value };
  }

  get beltKind(): OpticKind | null { return this.belt[this.selected] ?? this.belt[0] ?? null; }

  world() {
    return { beat: this.beat, sweep: this.sweep, optics: this.optics, threat: this.threat, phase: this.phase === "case" || this.phase === "in" ? "in" as const : "out" as const, prizeLifted: this.prizeLifted, liftBeat: this.liftBeat };
  }

  exitOpen(id: string): boolean {
    const ex = this.room.exits.find((e) => e.id === id);
    if (!ex) return false;
    const inOut = this.phase === "out" || this.phase === "escaped";
    return inOut && ex.phase === "out" && !this.closedExits.has(id);
  }

  /** Advance one fixed 120 Hz step. Returns the semantic events it produced. */
  step(input: SimInput): SimEvent[] {
    this.events = [];
    const L = this.locke;
    this.tick++;
    const dBeat = (this.room.tempo / 60) * DT;

    if (this.phase === "lockdown") {
      this.lockdownTimer -= DT;
      this.beat += dBeat;
      if (this.lockdownTimer <= 0 && this.lockdownTimer > -DT) this.emit({ type: "restart" });
      this.refreshBeams();
      return this.events;
    }
    if (this.phase === "escaped") { this.beat += dBeat; this.refreshBeams(); return this.events; }

    const wants = len(input.move) > 0.15 || input.stretch || input.interact || input.crouch || input.flatten;
    if (this.phase === "case" && wants) { this.phase = "in"; this.emit({ type: "run.start" }); }
    if (this.phase === "in" || this.phase === "out") this.runTicks++;

    this.beat += dBeat;
    const alertBoost = this.threat >= 2 ? 1.25 : 1;
    for (const e of this.room.emitters) {
      if (e.type === "sweeper" && e.sweep) this.sweep[e.id] = (this.sweep[e.id] ?? 0) + e.sweep.speed * dBeat * alertBoost;
    }

    L.grace = Math.max(0, L.grace - DT);
    L.takeTimer = Math.max(0, L.takeTimer - DT);
    const locked = L.takeTimer > 0;

    // Poses (toggles). Flatten cancels any reach.
    if (!locked && input.crouch) this.setPose(L.pose === "crouch" ? "stand" : "crouch");
    if (!locked && input.flatten) this.setPose(L.pose === "flatten" ? "stand" : "flatten");

    if (!locked && input.cycle && this.belt.length > 1) {
      this.selected = (this.selected + 1) % this.belt.length;
      this.emit({ type: "optic.select", kind: this.beltKind });
    }

    this.updateStretch(input, locked);
    this.updateMove(input, locked);
    if (!locked) this.updateInteract(input);

    this.refreshBeams();
    this.checkContacts();
    this.checkExit();
    return this.events;
  }

  private emit(e: SimEvent) { this.events.push(e); }

  private setPose(p: Pose) {
    const L = this.locke;
    if (L.pose === p) return;
    L.pose = p;
    if (p === "flatten" && L.stretch.active) this.release();
    this.emit({ type: "pose", pose: p });
  }

  shoulder(): V2 {
    const L = this.locke;
    const f = dirFromDeg(L.facing), r = dirFromDeg(L.facing + 90);
    return add(L.pos, add(scale(f, 0.08), scale(r, 0.24)));
  }

  private updateStretch(input: SimInput, locked: boolean) {
    const L = this.locke, S = L.stretch;
    if (!S.active && input.stretch && !locked && L.pose !== "flatten" && !S.retracting) {
      S.active = true; S.retracting = false; S.holding = false;
      S.points = [this.shoulder()];
      S.heading = len(input.move) > 0.2 ? degFromDir(input.move) : L.facing;
      S.length = 0;
      S.armBand = L.pose === "crouch" ? "low" : "mid";
      S.armY = L.pose === "crouch" ? 0.42 : 0.95;
      L.facing = S.heading;
      this.emit({ type: "stretch.start" });
      this.advanceHand(0.22);
    }
    if (S.active && !S.retracting) {
      S.points[0] = this.shoulder();
      if (!input.stretch || locked) { this.release(); }
      else {
        const m = len(input.move);
        if (m > 0.2) {
          const target = degFromDir(input.move);
          const diff = wrapDeg(target - S.heading);
          const maxTurn = STRETCH_TURN * DT;
          S.heading += clamp(diff, -maxTurn, maxTurn);
          this.advanceHand(STRETCH_SPEED * clamp(m, 0, 1) * DT);
        }
      }
    }
    if (S.retracting) {
      let budget = RETRACT_SPEED * DT;
      S.points[0] = this.shoulder();
      while (budget > 0 && S.points.length > 1) {
        const last = S.points[S.points.length - 1]!, prev = S.points[S.points.length - 2]!;
        const d = dist(last, prev);
        if (d <= budget) { S.points.pop(); budget -= d; S.length -= d; }
        else { S.points[S.points.length - 1] = add(last, scale(sub(prev, last), budget / d)); S.length -= budget; budget = 0; }
      }
      if (S.holding && S.points.length) this.prizePos = S.points[S.points.length - 1]!;
      if (S.points.length <= 1) {
        S.retracting = false; S.active = false; S.points = []; S.length = 0;
        if (S.holding) { S.holding = false; L.hasPrize = true; }
        this.emit({ type: "stretch.snap" });
      }
    }
  }

  private advanceHand(amount: number) {
    const S = this.locke.stretch;
    if (S.length >= STRETCH_MAX) return;
    amount = Math.min(amount, STRETCH_MAX - S.length);
    const tip = S.points[S.points.length - 1]!;
    const next = add(tip, scale(dirFromDeg(S.heading), amount));
    if (this.handBlocked(next)) { this.emit({ type: "stretch.bump" }); return; }
    // Densify: keep a point every ~6 cm so the curve stays smooth.
    if (S.points.length > 1 && dist(S.points[S.points.length - 2]!, tip) < 0.06) S.points[S.points.length - 1] = next;
    else S.points.push(next);
    S.length += amount;
    // Grab the prize at range.
    if (!this.prizeLifted && dist(next, this.prizePos) < 0.5) this.grabPrize();
  }

  private handBlocked(p: V2): boolean {
    const hw = this.room.size.w / 2 - 0.08, hd = this.room.size.d / 2 - 0.08;
    if (p.x < -hw || p.x > hw || p.z < -hd || p.z > hd) return true;
    const y = this.locke.stretch.armY;
    for (const b of this.room.blocks) {
      if (b.h <= y) continue;
      if (Math.abs(p.x - b.x) < b.w / 2 + 0.05 && Math.abs(p.z - b.z) < b.d / 2 + 0.05) return true;
    }
    return false;
  }

  private release() {
    const S = this.locke.stretch;
    if (!S.active || S.retracting) return;
    S.retracting = true;
    this.emit({ type: "stretch.release", length: S.length });
  }

  private grabPrize() {
    const S = this.locke.stretch;
    this.prizeLifted = true;
    this.liftBeat = this.beat;
    S.holding = true;
    this.phase = "out";
    this.emit({ type: "lift" });
    this.release();
  }

  private updateMove(input: SimInput, locked: boolean) {
    const L = this.locke;
    const planted = L.stretch.active;
    let target = v2(0, 0);
    if (!planted && !locked) {
      const m = len(input.move);
      if (m > 0.12) target = scale(input.move, POSE_SPEED[L.pose] / Math.max(1, m));
    }
    const accel = len(target) > len(L.vel) ? 16 : 22;
    const k = 1 - Math.exp(-accel * DT);
    L.vel = add(L.vel, scale(sub(target, L.vel), k));
    const speed = len(L.vel);
    if (speed > 0.05) {
      // Flattened, Locke sidles: he keeps facing the way he flattened and slides side-on.
      if (L.pose !== "flatten") {
        const want = degFromDir(L.vel);
        L.facing += wrapDeg(want - L.facing) * (1 - Math.exp(-14 * DT));
      }
      // Footfalls on eighth notes: two steps per beat when moving at stride.
      const prev = L.stepPhase;
      L.stepPhase += speed * DT / 0.29;
      if (Math.floor(prev) !== Math.floor(L.stepPhase)) this.emit({ type: "step", foot: (Math.floor(L.stepPhase) % 2) as 0 | 1, pos: L.pos });
    }
    L.pos = add(L.pos, scale(L.vel, DT));
    this.collide();
  }

  private collide() {
    const L = this.locke;
    const r = WALL_RADIUS[L.pose];
    const hw = this.room.size.w / 2 - r, hd = this.room.size.d / 2 - r;
    L.pos.x = clamp(L.pos.x, -hw, hw);
    L.pos.z = clamp(L.pos.z, -hd, hd);
    for (const b of this.room.blocks) {
      const cx = clamp(L.pos.x, b.x - b.w / 2, b.x + b.w / 2);
      const cz = clamp(L.pos.z, b.z - b.d / 2, b.z + b.d / 2);
      const dx = L.pos.x - cx, dz = L.pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          L.pos.x = cx + (dx / d) * r; L.pos.z = cz + (dz / d) * r;
        } else {
          // Centre inside the box: push out along the shallowest axis.
          const px = b.w / 2 + r - Math.abs(L.pos.x - b.x), pz = b.d / 2 + r - Math.abs(L.pos.z - b.z);
          if (px < pz) L.pos.x += Math.sign(L.pos.x - b.x || 1) * px; else L.pos.z += Math.sign(L.pos.z - b.z || 1) * pz;
        }
      }
    }
  }

  /** Mount the interact button would act on, if any. */
  targetMount(): string | null {
    const L = this.locke, S = L.stretch;
    const from = S.active && S.points.length > 1 ? S.points[S.points.length - 1]! : L.pos;
    const maxD = S.active ? 0.65 : 1.45;
    let best: string | null = null, bestD = maxD;
    for (const m of this.room.mounts) {
      const d = dist(from, v2(m.x, m.z));
      if (d < bestD) { bestD = d; best = m.id; }
    }
    return best;
  }

  canGrabPrize(): boolean {
    return !this.prizeLifted && !this.locke.stretch.active && dist(this.locke.pos, this.prizePos) < 1.05;
  }

  private updateInteract(input: SimInput) {
    const mount = this.targetMount();
    if (input.rotate !== 0 && mount) {
      const op = this.optics.find((o) => o.mountId === mount);
      if (op) {
        op.angle = (op.angle + 15 * input.rotate + 360) % 360;
        this.emit({ type: "optic.rotate", mountId: mount, angle: op.angle });
      }
    }
    if (!input.interact) return;
    if (this.canGrabPrize()) {
      // A short, automatic reach.
      const L = this.locke, S = L.stretch;
      L.facing = degFromDir(sub(this.prizePos, L.pos));
      S.active = true; S.retracting = false; S.holding = false; S.length = 0;
      S.armBand = L.pose === "crouch" ? "low" : "mid"; S.armY = L.pose === "crouch" ? 0.42 : 0.95;
      S.points = [this.shoulder()];
      S.heading = degFromDir(sub(this.prizePos, S.points[0]!));
      this.emit({ type: "stretch.start", auto: true });
      for (let i = 0; i < 40 && !this.prizeLifted; i++) this.advanceHand(0.05);
      if (!this.prizeLifted) this.release();
      return;
    }
    if (mount) {
      const idx = this.optics.findIndex((o) => o.mountId === mount);
      if (idx >= 0) {
        const op = this.optics[idx]!;
        this.optics.splice(idx, 1);
        this.belt.push(op.kind);
        this.emit({ type: "optic.pickup", mountId: mount, kind: op.kind });
        return;
      }
      const kind = this.beltKind;
      if (kind) {
        this.belt.splice(this.belt.indexOf(kind), 1);
        this.selected = 0;
        const facing = this.locke.facing;
        const base = ((Math.round((facing + 90) / 15) * 15) % 360 + 360) % 360;
        const op = { mountId: mount, kind, angle: base };
        this.optics.push(op);
        // Never open the mirror straight into Locke's own face: take the nearest safe 15° step.
        for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]) {
          op.angle = (((base + k * 15) % 360) + 360) % 360;
          if (!this.touchesLocke(this.beams.trace(this.world(), this.fed))) break;
        }
        this.emit({ type: "optic.place", mountId: mount, kind });
        return;
      }
    }
    this.emit({ type: "deny" });
  }

  private refreshBeams() {
    const before = this.fed;
    this.frame = this.beams.trace(this.world(), before);
    for (const id of this.frame.fed) if (!before.has(id)) this.emit({ type: "sensor.fed", id });
    for (const id of before) if (!this.frame.fed.has(id)) this.emit({ type: "sensor.lost", id });
    this.fed = this.frame.fed;
  }

  /** Every capsule Locke currently occupies, as (segment, radius, bands). */
  bodyShapes(): Array<{ a: V2; b: V2; r: number; bands: Band[] }> {
    const L = this.locke;
    const shapes: Array<{ a: V2; b: V2; r: number; bands: Band[] }> = [];
    if (L.pose === "flatten") {
      const f = dirFromDeg(L.facing);
      shapes.push({ a: add(L.pos, scale(f, -0.2)), b: add(L.pos, scale(f, 0.24)), r: POSE_RADIUS.flatten, bands: POSE_BANDS.flatten });
    } else {
      shapes.push({ a: L.pos, b: L.pos, r: POSE_RADIUS[L.pose], bands: POSE_BANDS[L.pose] });
    }
    const pts = L.stretch.points;
    if (pts.length > 1) {
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        acc += dist(pts[i - 1]!, pts[i]!);
        if (acc < 0.18) continue;
        shapes.push({ a: pts[i - 1]!, b: pts[i]!, r: ARM_R, bands: [L.stretch.armBand] });
      }
    }
    return shapes;
  }

  private touchesLocke(frame: BeamFrame): boolean {
    const shapes = this.bodyShapes();
    return frame.segments.some((seg) => seg.live && !this.opticGrace(seg) && shapes.some((sh) => sh.bands.includes(seg.band) && segSegDist(sh.a, sh.b, seg.a, seg.b) - sh.r * HIT_SCALE < 0.05));
  }

  /** Light that a placed optic just redirected is harmless right next to that optic. */
  private opticGrace(seg: BeamSegment): boolean {
    return !!seg.fromOptic && dist(this.locke.pos, seg.a) < OPTIC_GRACE;
  }

  private checkContacts() {
    if (this.phase !== "in" && this.phase !== "out") return;
    const L = this.locke;
    const shapes = this.bodyShapes();
    let hit: { at: V2; emitter: string } | null = null;
    for (const seg of this.frame.segments) {
      if (!seg.live) continue;
      for (const sh of shapes) {
        if (!sh.bands.includes(seg.band)) continue;
        const d = segSegDist(sh.a, sh.b, seg.a, seg.b);
        const c = d - sh.r;
        if (c < 1.5 && c > 0 && c < this.clearance) this.clearance = c;
        if (d - sh.r * HIT_SCALE <= 0 && !hit && !this.opticGrace(seg)) hit = { at: closestOnSeg(sh.a, seg.a, seg.b), emitter: seg.emitter };
      }
    }
    if (hit && L.grace <= 0) {
      this.threat = Math.min(this.room.forgiving ? 1 : 3, this.threat + 1);
      L.grace = GRACE;
      L.takeTimer = 0.55;
      this.release();
      this.emit({ type: "contact", threat: this.threat, at: hit.at, emitter: hit.emitter });
      if (this.threat >= 3) {
        this.phase = "lockdown";
        this.lockdownTimer = LOCKDOWN_HOLD;
        this.emit({ type: "lockdown" });
      }
    }
  }

  private checkExit() {
    if (this.phase !== "out" || !this.locke.hasPrize && !this.locke.stretch.holding) return;
    for (const ex of this.room.exits) {
      if (!this.exitOpen(ex.id)) continue;
      if (dist(this.locke.pos, v2(ex.x, ex.z)) < 0.85) {
        this.phase = "escaped";
        this.escapedVia = ex.id;
        this.emit({ type: "escaped", exit: ex.id });
        return;
      }
    }
  }

  snapshot(): RunSnapshot {
    return structuredClone({
      tick: this.tick, beat: this.beat, phase: this.phase, threat: this.threat, locke: this.locke, optics: this.optics,
      belt: this.belt, selected: this.selected, sweep: this.sweep, prizeLifted: this.prizeLifted, liftBeat: this.liftBeat, prizePos: this.prizePos,
      closedExits: [...this.closedExits], runTicks: this.runTicks, clearance: this.clearance, lockdownTimer: this.lockdownTimer,
      escapedVia: this.escapedVia, fed: [...this.fed]
    });
  }

  restore(s: RunSnapshot) {
    const c = structuredClone(s);
    Object.assign(this, { ...c, closedExits: new Set(c.closedExits), fed: new Set(c.fed) });
    this.frame = this.beams.trace(this.world(), this.fed);
  }

  /** Nearest live beam distance to Locke's body (for HUD heat / audio proximity). */
  nearestBeam(): number {
    let best = Infinity;
    for (const seg of this.frame.segments) {
      if (!seg.live) continue;
      const d = pointSegDist(this.locke.pos, seg.a, seg.b);
      if (d < best) best = d;
    }
    return best;
  }
}

export { PRIZE_R };
