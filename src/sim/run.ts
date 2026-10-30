import { BeamEngine, type BeamFrame, type BeamSegment, type PlacedOptic, PRIZE_R, pointInPoly, resolveEmitter } from "./beams";
import { type V2, add, clamp, closestOnSeg, degFromDir, dirFromDeg, dist, len, pointSegDist, scale, segSegDist, sub, v2, wrapDeg } from "./math2d";
import { BANDS, type Band, type BlockDef, type OpticKind, type RoomDef } from "./roomTypes";

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
/** Within this of a beam (from the silhouette) without touching counts as a near-miss. */
export const NEAR_MISS = 0.06;
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
  | { type: "deny" }
  | { type: "nearMiss"; emitter: string; clearance: number }
  | { type: "plate.down"; id: string }
  | { type: "plate.up"; id: string }
  | { type: "shutter.open"; id: string }
  | { type: "shutter.close"; id: string }
  | { type: "stairs"; id: string; floor: number }
  | { type: "obscura"; on: boolean }
  | { type: "stepUp"; on: boolean }
  | { type: "rope.hook"; mountId: string }
  | { type: "rope.letgo" }
  | { type: "rope.yank" }
  | { type: "land"; speed: number };

export interface Stretch {
  active: boolean;
  retracting: boolean;
  points: V2[];
  heading: number;
  length: number;
  holding: boolean;
  armBand: Band;
  armY: number;
  /** Side view: the hand has caught a hook and the arm is a rope. */
  hook: string | null;
  rope: number;
  yank: boolean;
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
  floor: number;
  /** Standing on a plinth: every band he occupies rides one higher. */
  raised: boolean;
  grounded: boolean;
}

export interface RunSnapshot {
  tick: number; beat: number; phase: RunPhase; threat: number; locke: LockeState; optics: PlacedOptic[]; belt: OpticKind[];
  selected: number; sweep: Record<string, number>; prizeLifted: boolean; liftBeat: number | undefined; prizePos: V2; closedExits: string[]; runTicks: number;
  clearance: number; lockdownTimer: number; escapedVia: string; fed: string[];
  plates: string[]; shutterOpen: Record<string, number>; obscura: boolean; obscuraSeen: boolean;
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
  /** Plates currently pressed. */
  plates = new Set<string>();
  /** Shutter open amount 0..1 (animated in the sim so collision matches the picture). */
  shutterOpen: Record<string, number> = {};
  private sealed = new Set<string>();
  /** Camera obscura view is up (casing only). */
  obscura = false;
  obscuraSeen = false;
  readonly side: boolean;
  private nearCooldown: Record<string, number> = {};
  private events: SimEvent[] = [];

  constructor(readonly room: RoomDef) {
    this.beams = new BeamEngine(room);
    this.belt = [...room.belt];
    this.prizePos = v2(room.prize.x, room.prize.z);
    this.locke = {
      pos: v2(room.spawn.x, room.spawn.z), vel: v2(0, 0), facing: room.spawn.facing, pose: "stand",
      stretch: { active: false, retracting: false, points: [], heading: 0, length: 0, holding: false, armBand: "mid", armY: 0.95, hook: null, rope: 0, yank: false },
      stepPhase: 0, grace: 0, takeTimer: 0, hasPrize: false, floor: room.spawn.floor ?? 0, raised: false, grounded: true
    };
    this.side = room.view === "side";
    for (const e of room.emitters) this.sweep[e.id] = 0;
    for (const f of room.fixedOptics ?? []) this.optics.push({ mountId: f.mountId, kind: f.kind, angle: f.angle, fixed: true, rotatable: f.rotatable ?? true });
    for (const sh of room.shutters ?? []) this.shutterOpen[sh.id] = 0;
    this.updatePlates(false);
    this.frame = this.beams.trace(this.world());
    this.fed = this.frame.fed;
    this.updateShutters(0, false);
    this.frame = this.beams.trace(this.world(), this.fed);
  }

  get flipped(): boolean { return this.phase === "out" || (this.phase === "escaped" && this.prizeLifted); }

  get stats(): RunStats {
    return { time: this.runTicks / SIM_HZ, alarms: this.threat, clearance: this.clearance, value: this.room.prize.value };
  }

  get beltKind(): OpticKind | null { return this.belt[this.selected] ?? this.belt[0] ?? null; }

  world() {
    const closedShutters = new Set<string>();
    for (const id in this.shutterOpen) if (this.shutterOpen[id]! < 0.9) closedShutters.add(id);
    return { beat: this.beat, sweep: this.sweep, optics: this.optics, threat: this.threat, phase: this.phase === "case" || this.phase === "in" ? "in" as const : "out" as const, prizeLifted: this.prizeLifted, liftBeat: this.liftBeat, closedShutters };
  }

  exitOpen(id: string): boolean {
    const ex = this.room.exits.find((e) => e.id === id);
    if (!ex) return false;
    if (this.room.setPiece) return ex.phase === "in" && !this.closedExits.has(id);
    const inOut = this.phase === "out" || this.phase === "escaped";
    return inOut && ex.phase === "out" && !this.closedExits.has(id);
  }

  /** Advance one fixed 120 Hz step. Returns the semantic events it produced. */
  step(input: SimInput): SimEvent[] {
    this.events = [];
    const L = this.locke;
    this.tick++;
    const dBeat = ((this.prizeLifted && this.room.tempoOut ? this.room.tempoOut : this.room.tempo) / 60) * DT;

    if (this.phase === "lockdown") {
      this.lockdownTimer -= DT;
      this.beat += dBeat;
      if (this.lockdownTimer <= 0 && this.lockdownTimer > -DT) this.emit({ type: "restart" });
      this.refreshBeams();
      return this.events;
    }
    if (this.phase === "escaped") { this.beat += dBeat; this.refreshBeams(); return this.events; }

    // Interact at the camera obscura is part of casing; it doesn't start the clock.
    // The camera obscura works until the prize lifts; while casing it doesn't start the clock.
    const atObscura = (this.phase === "case" || this.phase === "in") && this.nearObscura();
    const wants = len(input.move) > 0.15 || input.stretch || (input.interact && !atObscura) || input.crouch || input.flatten;
    if (atObscura && input.interact) { this.obscura = !this.obscura; this.obscuraSeen = true; this.emit({ type: "obscura", on: this.obscura }); input = { ...input, interact: false }; }
    if (this.obscura && (len(input.move) > 0.15 || input.stretch || input.crouch || input.flatten || this.phase === "out")) { this.obscura = false; this.emit({ type: "obscura", on: false }); }
    if (this.phase === "case" && wants) { this.phase = "in"; this.emit({ type: "run.start" }); }
    if (this.phase === "in" || this.phase === "out") this.runTicks++;

    this.beat += dBeat;
    const alertBoost = this.threat >= 2 ? 1.25 : 1;
    const ph = this.phase === "out" ? "out" : "in";
    for (const e0 of this.room.emitters) {
      const e = resolveEmitter(e0, ph);
      if ((e.type === "sweeper" || e.type === "camera" || e.type === "projector") && e.sweep) this.sweep[e.id] = (this.sweep[e.id] ?? 0) + e.sweep.speed * dBeat * alertBoost;
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

    if (this.side) this.updateSide(input, locked);
    else {
      this.updateStretch(input, locked);
      this.updateMove(input, locked);
    }
    if (!locked) this.updateInteract(input);

    this.updatePlates(true);
    this.updateShutters(DT, true);
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
    if (this.side) return this.sideShoulder();
    const L = this.locke;
    const f = dirFromDeg(L.facing), r = dirFromDeg(L.facing + 90);
    return add(L.pos, add(scale(f, 0.08), scale(r, 0.24)));
  }

  private updateStretch(input: SimInput, locked: boolean) {
    const L = this.locke, S = L.stretch;
    if (!S.active && input.stretch && !locked && L.pose !== "flatten" && !S.retracting) {
      S.active = true; S.retracting = false; S.holding = false;
      S.points = [this.shoulder()];
      S.heading = len(input.move) > 0.2 ? degFromDir(input.move) : this.side ? -90 : L.facing;
      S.length = 0;
      S.armBand = L.pose === "crouch" ? "low" : "mid";
      S.armY = L.pose === "crouch" ? 0.42 : 0.95;
      if (!this.side) L.facing = S.heading;
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
        } else if (this.side) this.advanceHand(STRETCH_SPEED * DT); // a rope arm keeps paying out toward the hook
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
    if (!this.room.setPiece && !this.prizeLifted && (this.room.prize.floor ?? 0) === this.locke.floor && dist(next, this.prizePos) < 0.5) this.grabPrize();
    if (this.side) for (const m of this.room.mounts) if (m.hook && dist(next, v2(m.x, m.z)) < 0.45) { this.catchHook(m.id); return; }
  }

  private handBlocked(p: V2): boolean {
    if (!this.insideRoom(p, 0.08)) return true;
    const y = this.locke.stretch.armY + (this.locke.raised ? 0.45 : 0);
    for (const b of this.blocksHere()) {
      if (b.h <= y && !this.side) continue;
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
    this.pushInside(L.pos, r);
    // Plinths: step up when the centre is over one; nothing to collide with.
    const on = this.blocksHere().some((b) => b.stand && Math.abs(L.pos.x - b.x) < b.w / 2 && Math.abs(L.pos.z - b.z) < b.d / 2);
    if (on !== L.raised) { L.raised = on; this.emit({ type: "stepUp", on }); }
    for (const b of this.collidersHere()) {
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
    const from = S.active && S.points.length > 1 ? S.points[S.points.length - 1]! : this.side ? this.sideShoulder() : L.pos;
    const maxD = S.active ? 0.65 : 1.45;
    let best: string | null = null, bestD = maxD;
    for (const m of this.room.mounts) {
      if ((m.floor ?? 0) !== L.floor || m.hook) continue;
      const d = dist(from, v2(m.x, m.z));
      if (d < bestD) { bestD = d; best = m.id; }
    }
    return best;
  }

  canGrabPrize(): boolean {
    return !this.room.setPiece && !this.prizeLifted && !this.locke.stretch.active && (this.room.prize.floor ?? 0) === this.locke.floor && dist(this.locke.pos, this.prizePos) < 1.05;
  }

  private updateInteract(input: SimInput) {
    const mount = this.targetMount();
    if (input.rotate !== 0 && mount) {
      const op = this.optics.find((o) => o.mountId === mount);
      if (op && (!op.fixed || op.rotatable)) {
        op.angle = (op.angle + 15 * input.rotate + 360) % 360;
        this.turning = mount; this.turnTick = this.tick;
        this.emit({ type: "optic.rotate", mountId: mount, angle: op.angle });
      }
    }
    if (!input.interact) return;
    const stair = this.stairHere();
    if (stair) {
      const to = this.locke.floor === stair.from ? stair.to : stair.from;
      this.locke.floor = to;
      if (this.locke.stretch.active) this.release();
      this.emit({ type: "stairs", id: stair.id, floor: to });
      return;
    }
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
      if (idx >= 0 && this.optics[idx]!.fixed) { this.emit({ type: "deny" }); return; }
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
    if (this.side) {
      // Side view: z is depth, so the body is a vertical capsule from the feet up.
      const top = L.pose === "crouch" ? 0.6 : 1.12;
      shapes.push({ a: v2(L.pos.x, L.pos.z - 0.22), b: v2(L.pos.x, L.pos.z - top), r: 0.17, bands: [...BANDS] });
    } else if (L.pose === "flatten") {
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
        shapes.push({ a: pts[i - 1]!, b: pts[i]!, r: ARM_R, bands: this.side ? [...BANDS] : [L.stretch.armBand] });
      }
    }
    if (L.raised) for (const sh of shapes) sh.bands = sh.bands.map((b) => BANDS[BANDS.indexOf(b) + 1]).filter((b): b is Band => !!b);
    return shapes;
  }

  private touchesLocke(frame: BeamFrame): boolean {
    const shapes = this.bodyShapes();
    return frame.segments.some((seg) => seg.live && seg.floor === this.locke.floor && !this.opticGrace(seg) && shapes.some((sh) => sh.bands.includes(seg.band) && segSegDist(sh.a, sh.b, seg.a, seg.b) - sh.r * HIT_SCALE < 0.05));
  }

  /** Light that a placed optic just redirected is harmless right next to that optic. */
  private opticGrace(seg: BeamSegment): boolean {
    if (!seg.fromOptic) return false;
    if (dist(this.locke.pos, seg.a) < OPTIC_GRACE) return true;
    // Light swinging off the mirror he's turning by hand can't catch him: aiming is never a trap.
    return !!seg.opticMount && seg.opticMount === this.turning && this.tick - this.turnTick < SIM_HZ * 0.6 && dist(this.locke.pos, seg.a) < 2.2;
  }
  private turning: string | null = null;
  private turnTick = -9999;

  private checkContacts() {
    if (this.phase !== "in" && this.phase !== "out") return;
    const L = this.locke;
    const shapes = this.bodyShapes();
    let hit: { at: V2; emitter: string } | null = null;
    let near: { emitter: string; c: number } | null = null;
    for (const seg of this.frame.segments) {
      if (!seg.live || seg.floor !== L.floor) continue;
      for (const sh of shapes) {
        if (!sh.bands.includes(seg.band)) continue;
        const d = segSegDist(sh.a, sh.b, seg.a, seg.b);
        const c = d - sh.r;
        if (c < 1.5 && c > 0 && c < this.clearance) this.clearance = c;
        if (c > 0 && c < NEAR_MISS && d - sh.r * HIT_SCALE > 0 && sh.r > ARM_R && !near) near = { emitter: seg.emitter, c };
        if (d - sh.r * HIT_SCALE <= 0 && !hit && !this.opticGrace(seg)) hit = { at: closestOnSeg(sh.a, seg.a, seg.b), emitter: seg.emitter };
      }
    }
    if (!hit && near && (this.nearCooldown[near.emitter] ?? 0) < this.tick) {
      this.nearCooldown[near.emitter] = this.tick + SIM_HZ;
      this.emit({ type: "nearMiss", emitter: near.emitter, clearance: near.c });
    }
    // A live alarm plate trips exactly like a beam.
    if (!hit) for (const p of this.room.plates ?? []) if (p.alarm && this.plates.has(p.id) && this.plateLive(p)) { hit = { at: v2(p.x, p.z), emitter: p.id }; break; }
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
    if (this.room.setPiece ? this.phase !== "in" : this.phase !== "out" || !this.locke.hasPrize && !this.locke.stretch.holding) return;
    for (const ex of this.room.exits) {
      if (!this.exitOpen(ex.id) || (ex.floor ?? 0) !== this.locke.floor) continue;
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
      escapedVia: this.escapedVia, fed: [...this.fed], plates: [...this.plates], shutterOpen: this.shutterOpen, obscura: this.obscura, obscuraSeen: this.obscuraSeen
    });
  }

  restore(s: RunSnapshot) {
    const c = structuredClone(s);
    Object.assign(this, { ...c, closedExits: new Set(c.closedExits), fed: new Set(c.fed), plates: new Set(c.plates) });
    this.frame = this.beams.trace(this.world(), this.fed);
  }

  // ---- Room furniture: floors, plates, shutters, stairs, obscura ----

  /** Blocks on Locke's floor. */
  private blocksHere(): BlockDef[] { return this.room.blocks.filter((b) => (b.floor ?? 0) === this.locke.floor); }

  /** Everything Locke bumps into: blocks (not plinths he can step onto) and shut shutters. */
  private collidersHere(): Array<{ x: number; z: number; w: number; d: number }> {
    const out: Array<{ x: number; z: number; w: number; d: number }> = this.blocksHere().filter((b) => !b.stand);
    for (const sh of this.room.shutters ?? []) if ((sh.floor ?? 0) === this.locke.floor && (this.shutterOpen[sh.id] ?? 0) < 0.9) out.push(sh);
    return out;
  }

  /** Can Locke's body (wall radius for the pose) stand at p on his current floor? For planners and tests. */
  canStand(p: V2, pose: Pose): boolean {
    const r = WALL_RADIUS[pose];
    if (!this.insideRoom(p, r - 1e-3)) return false;
    for (const b of this.collidersHere()) {
      const cx = clamp(p.x, b.x - b.w / 2, b.x + b.w / 2), cz = clamp(p.z, b.z - b.d / 2, b.z + b.d / 2);
      if (Math.hypot(p.x - cx, p.z - cz) < r) return false;
    }
    return true;
  }

  /** Is p on top of a plinth on his floor? */
  raisedAt(p: V2): boolean { return this.blocksHere().some((b) => b.stand && Math.abs(p.x - b.x) < b.w / 2 && Math.abs(p.z - b.z) < b.d / 2); }

  insideRoom(p: V2, margin: number): boolean {
    const poly = this.beams.outline;
    if (!pointInPoly(p, poly)) return false;
    for (let i = 0; i < poly.length; i++) if (pointSegDist(p, poly[i]!, poly[(i + 1) % poly.length]!) < margin) return false;
    return true;
  }

  /** Keep a circle of radius r inside the (possibly concave) room outline. */
  private pushInside(p: V2, r: number) {
    const poly = this.beams.outline;
    for (let pass = 0; pass < 3; pass++) {
      const inside = pointInPoly(p, poly);
      let moved = false;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
        const c = closestOnSeg(p, a, b);
        const d = dist(p, c);
        if (inside && d >= r) continue;
        if (!inside && d > 2) continue;
        // Inward normal of this edge.
        const e = sub(b, a), el = len(e) || 1;
        let n = v2(-e.z / el, e.x / el);
        if (!pointInPoly(add(add(a, scale(e, 0.5)), scale(n, 0.01)), poly)) n = scale(n, -1);
        if (!inside) { const q = add(c, scale(n, r)); if (pointInPoly(q, poly)) { p.x = q.x; p.z = q.z; moved = true; break; } continue; }
        const push = r - d;
        p.x += n.x * push; p.z += n.z * push; moved = true;
      }
      if (!moved) break;
    }
  }

  plateLive(p: NonNullable<RoomDef["plates"]>[number]): boolean {
    const ph = p.phase ?? "both";
    return ph === "both" || ph === (this.phase === "out" ? "out" : "in");
  }

  private updatePlates(emit: boolean) {
    const L = this.locke;
    for (const p of this.room.plates ?? []) {
      const pressed = p.prize ? !this.prizeLifted : !this.side && (p.floor ?? 0) === L.floor && Math.abs(L.pos.x - p.x) < p.w / 2 && Math.abs(L.pos.z - p.z) < p.d / 2;
      if (pressed && !this.plates.has(p.id)) { this.plates.add(p.id); if (emit) this.emit({ type: "plate.down", id: p.id }); }
      else if (!pressed && this.plates.has(p.id)) { this.plates.delete(p.id); if (emit) this.emit({ type: "plate.up", id: p.id }); }
    }
  }

  /** Signals a shutter can listen to: lit sensors and held plates. */
  signalOn(id: string): boolean { return this.fed.has(id) || this.plates.has(id); }

  private updateShutters(dt: number, emit: boolean) {
    for (const sh of this.room.shutters ?? []) {
      const cur = this.shutterOpen[sh.id] ?? 0;
      if (sh.sealOnLift && this.prizeLifted) this.sealed.add(sh.id);
      let want = sh.opens.length > 0 && sh.opens.every((id) => this.signalOn(id)) ? 1 : 0;
      if (sh.sealOnLift && sh.opens.length === 0) want = 1;
      if (sh.latch && cur > 0.95) want = 1;
      if (this.sealed.has(sh.id)) want = 0;
      // Opening is a deliberate grind; slamming shut is quick.
      const next = dt === 0 ? want : want > cur ? Math.min(1, cur + dt * 1.6) : Math.max(0, cur - dt * 4);
      this.shutterOpen[sh.id] = next;
      if (emit && cur < 0.9 && next >= 0.9) this.emit({ type: "shutter.open", id: sh.id });
      if (emit && cur >= 0.9 && next < 0.9) this.emit({ type: "shutter.close", id: sh.id });
    }
  }

  stairHere(): NonNullable<RoomDef["stairs"]>[number] | null {
    const L = this.locke;
    for (const st of this.room.stairs ?? []) {
      if (L.floor !== st.from && L.floor !== st.to) continue;
      if (Math.abs(L.pos.x - st.x) < st.w / 2 + 0.2 && Math.abs(L.pos.z - st.z) < st.d / 2 + 0.2) return st;
    }
    return null;
  }

  nearObscura(): boolean {
    const o = this.room.obscura;
    return !!o && (o.floor ?? 0) === this.locke.floor && dist(this.locke.pos, v2(o.x, o.z)) < 1.2;
  }

  // ---- Side view: gravity, ledges and stretch-as-rope ----

  /** Shoulder height above the feet in side view (z grows downward). */
  private sideShoulder(): V2 { const L = this.locke; return v2(L.pos.x + (Math.cos(L.facing * Math.PI / 180) > 0 ? 0.12 : -0.12), L.pos.z - (L.pose === "crouch" ? 0.5 : 0.98)); }

  private catchHook(id: string) {
    const S = this.locke.stretch, m = this.room.mounts.find((mm) => mm.id === id)!;
    S.hook = id;
    S.points = [this.sideShoulder(), v2(m.x, m.z)];
    S.rope = Math.max(0.3, dist(S.points[0]!, S.points[1]!));
    S.length = S.rope;
    S.retracting = false;
    this.emit({ type: "rope.hook", mountId: id });
  }

  private updateSide(input: SimInput, locked: boolean) {
    const L = this.locke, S = L.stretch;
    const hd = this.room.size.d / 2;
    if (S.hook) {
      const m = this.room.mounts.find((mm) => mm.id === S.hook)!;
      const H = v2(m.x, m.z);
      if (S.yank) {
        // The arm went first; now the body is yanked after it.
        const sh = this.sideShoulder();
        const d = dist(sh, H);
        const step = 9 * DT;
        L.grounded = false;
        if (d <= step + 0.05) {
          S.yank = false; S.hook = null; S.active = false; S.points = []; S.length = 0;
          L.vel = v2(input.move.x * 2.0, -2.4);
          this.emit({ type: "stretch.snap" });
        } else {
          const k = step / d;
          L.pos = add(L.pos, scale(sub(H, sh), k));
          L.vel = v2(0, 0);
          S.points = [this.sideShoulder(), H];
          S.length = dist(S.points[0]!, H);
        }
        return;
      }
      if (!input.stretch || locked) {
        // Release with up held: the arm reels the body up after it. Release otherwise: he lets go.
        if (input.move.z < -0.3 && !locked) { S.yank = true; this.emit({ type: "rope.yank" }); return; }
        S.hook = null; S.active = false; S.points = []; S.length = 0; S.rope = 0;
        this.emit({ type: "rope.letgo" });
        return;
      }
      if (input.move.z < -0.3) S.rope = Math.max(0.35, S.rope - 1.5 * DT);
      if (input.move.z > 0.3) {
        S.rope += 1.5 * DT;
        if (S.rope >= STRETCH_MAX) {
          // Out of arm. He lets go.
          S.hook = null; S.active = false; S.points = []; S.length = 0; S.rope = 0;
          this.emit({ type: "rope.letgo" });
        }
      }
    }
    if (!S.hook && !S.yank) this.updateStretch(input, locked);
    const hooked = !!S.hook;
    const grounded = L.grounded;
    const tx = locked || (S.active && !hooked && grounded) ? 0 : input.move.x * (L.pose === "crouch" ? 1.2 : 2.1);
    const ctrl = grounded ? 16 : hooked ? 3 : 4;
    L.vel.x += (tx - L.vel.x) * (1 - Math.exp(-ctrl * DT));
    L.vel.z += 9.8 * DT;
    const prev = v2(L.pos.x, L.pos.z);
    L.pos = add(L.pos, scale(L.vel, DT));
    if (hooked) {
      const m = this.room.mounts.find((mm) => mm.id === S.hook)!;
      const H = v2(m.x, m.z);
      const sh = this.sideShoulder();
      const d = dist(sh, H);
      if (d > S.rope) {
        const dir = scale(sub(sh, H), 1 / d);
        const corr = scale(dir, d - S.rope);
        L.pos = sub(L.pos, corr);
        const radial = dot2(L.vel, dir);
        if (radial > 0) L.vel = sub(L.vel, scale(dir, radial));
      }
      S.points = [this.sideShoulder(), H];
      S.length = dist(S.points[0]!, H);
    }
    if (Math.abs(L.vel.x) > 0.1) L.facing = L.vel.x > 0 ? 0 : 180;
    // Ledges, floor and walls.
    L.grounded = false;
    const fallSpeed = L.vel.z;
    const hw = this.room.size.w / 2 - 0.2;
    L.pos.x = clamp(L.pos.x, -hw, hw);
    if (L.pos.z >= hd) { L.pos.z = hd; this.landed(fallSpeed); }
    if (L.pos.z - 1.12 < -hd) { L.pos.z = -hd + 1.12; if (L.vel.z < 0) L.vel.z = 0; }
    for (const b of this.blocksHere()) {
      const top = b.z - b.d / 2, bot = b.z + b.d / 2, x0 = b.x - b.w / 2 - 0.15, x1 = b.x + b.w / 2 + 0.15;
      if (L.pos.x <= x0 || L.pos.x >= x1) continue;
      if (prev.z <= top + 1e-3 && L.pos.z >= top) { L.pos.z = top; this.landed(fallSpeed); continue; }
      if (L.pos.z > top && L.pos.z - 1.12 < bot) {
        // Inside the block's span: shove out sideways (or down if his head hit the underside).
        if (prev.z - 1.12 >= bot - 1e-3) { L.pos.z = bot + 1.12; if (L.vel.z < 0) L.vel.z = 0; continue; }
        L.pos.x = prev.x <= b.x ? x0 : x1; L.vel.x = 0;
      }
    }
    if (L.grounded && Math.abs(L.vel.x) > 0.05) {
      const p0 = L.stepPhase;
      L.stepPhase += Math.abs(L.vel.x) * DT / 0.29;
      if (Math.floor(p0) !== Math.floor(L.stepPhase)) this.emit({ type: "step", foot: (Math.floor(L.stepPhase) % 2) as 0 | 1, pos: L.pos });
    }
  }

  private landed(speed: number) {
    const L = this.locke;
    if (!L.grounded && speed > 2.5) this.emit({ type: "land", speed });
    L.grounded = true;
    if (L.vel.z > 0) L.vel.z = 0;
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

const dot2 = (a: V2, b: V2) => a.x * b.x + a.z * b.z;
