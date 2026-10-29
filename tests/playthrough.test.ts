import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HeistRun, emptyInput, POSE_RADIUS, HIT_SCALE, type Pose, type SimInput } from "../src/sim/run";
import type { PlacedOptic } from "../src/sim/beams";
import { segSegDist, v2, type V2 } from "../src/sim/math2d";
import type { RoomDef } from "../src/sim/roomTypes";

/**
 * A bot plays each museum room start to finish through the real sim: plans a path over static beams,
 * picks a pose per cell, sneaks past pulses and sweepers with look-ahead, sets the mirrors, lifts the
 * prize (walking up or stretching), and escapes.
 */
const load = (id: string) => JSON.parse(readFileSync(new URL(`../src/rooms/${id}.json`, import.meta.url), "utf8")) as RoomDef;
const WALL_R: Record<Pose, number> = { stand: 0.28, crouch: 0.32, flatten: 0.16 };
const BANDS: Record<Pose, string[]> = { stand: ["low", "mid", "high"], crouch: ["low", "mid"], flatten: ["low", "mid", "high"] };
const STEP = 0.1;

function solveOptics(room: RoomDef): PlacedOptic[] {
  const n = Math.min(room.belt.length, room.mounts.length);
  if (!n) return [];
  const r = new HeistRun(room);
  const A = Array.from({ length: 12 }, (_, i) => i * 15);
  let best: PlacedOptic[] = [], bestFed = 0;
  const t = (o: PlacedOptic[]) => { r.optics = o; const f = r.beams.trace(r.world()).fed.size; if (f > bestFed) { bestFed = f; best = o; } };
  for (const m of room.mounts) for (const a of A) t([{ mountId: m.id, kind: "mirror", angle: a }]);
  if (n >= 2) for (const m1 of room.mounts) for (const m2 of room.mounts) if (m1.id < m2.id) for (const a of A) for (const b of A)
    t([{ mountId: m1.id, kind: "mirror", angle: a }, { mountId: m2.id, kind: "mirror", angle: b }]);
  return best;
}

/** Which pose (if any) can stand at p, given only static live beams. */
function poseAt(r: HeistRun, p: V2, from: V2 = p): Pose | null {
  const room = r.room, hw = room.size.w / 2, hd = room.size.d / 2;
  const segs = r.beams.trace(r.world()).segments.filter((s) => s.live && s.type === "static");
  for (const pose of ["stand", "crouch", "flatten"] as Pose[]) {
    const wr = WALL_R[pose];
    if (Math.abs(p.x) > hw - wr || Math.abs(p.z) > hd - wr) continue;
    if (room.blocks.some((b) => Math.hypot(p.x - Math.max(b.x - b.w / 2, Math.min(p.x, b.x + b.w / 2)), p.z - Math.max(b.z - b.d / 2, Math.min(p.z, b.z + b.d / 2))) < wr)) continue;
    const rr = POSE_RADIUS[pose] * HIT_SCALE + 0.06;
    // Sweep the whole move between cells; thin poses can't hop over a beam.
    // Flattened, Locke is card-thin across but ~0.45 m nose-to-tail along his facing (the move direction).
    let a = from, bb = p;
    if (pose === "flatten") {
      const dx = p.x - from.x, dz = p.z - from.z, l = Math.hypot(dx, dz) || 1;
      a = v2(from.x - (dx / l) * 0.22, from.z - (dz / l) * 0.22); bb = v2(p.x + (dx / l) * 0.24, p.z + (dz / l) * 0.24);
    }
    if (segs.some((s) => BANDS[pose]!.includes(s.band) && segSegDist(a, bb, s.a, s.b) < rr)) continue;
    return pose;
  }
  return null;
}

function plan(r: HeistRun, from: V2, goal: (p: V2) => boolean): Array<{ p: V2; pose: Pose }> | null {
  const hw = r.room.size.w / 2, hd = r.room.size.d / 2;
  const toP = (i: number, j: number) => v2(-hw + i * STEP, -hd + j * STEP);
  const si = Math.round((from.x + hw) / STEP), sj = Math.round((from.z + hd) / STEP);
  const k = (i: number, j: number) => i * 1000 + j;
  const prev = new Map<number, number>([[k(si, sj), -1]]);
  const pose = new Map<number, Pose>();
  const q: Array<[number, number]> = [[si, sj]];
  while (q.length) {
    const [i, j] = q.shift()!;
    const p = toP(i, j);
    if (goal(p)) {
      const out: Array<{ p: V2; pose: Pose }> = [];
      for (let c = k(i, j); c !== -1; c = prev.get(c)!) out.unshift({ p: toP(Math.floor(c / 1000), c % 1000), pose: pose.get(c) ?? "stand" });
      return out;
    }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ni = i + di, nj = j + dj, nk = k(ni, nj);
      if (prev.has(nk)) continue;
      const ps = poseAt(r, toP(ni, nj), p);
      if (!ps) continue;
      prev.set(nk, k(i, j)); pose.set(nk, ps); q.push([ni, nj]);
    }
  }
  return null;
}

/** Simplify a cell path to waypoints where the pose or direction changes. */
function waypoints(path: Array<{ p: V2; pose: Pose }>) {
  const out: typeof path = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!, c = path[i + 1];
    const turn = !c || Math.sign(b.p.x - a.p.x) !== Math.sign(c.p.x - b.p.x) || Math.sign(b.p.z - a.p.z) !== Math.sign(c.p.z - b.p.z);
    if (!c || turn || b.pose !== a.pose || c.pose !== b.pose) out.push(b);
  }
  return out;
}

class Bot {
  log: string[] = [];
  constructor(readonly r: HeistRun) {}
  step(i: Partial<SimInput>) { for (const e of this.r.step({ ...emptyInput(), ...i })) if (e.type === "contact") this.log.push(`contact:${e.emitter}@${this.r.locke.pos.x.toFixed(2)},${this.r.locke.pos.z.toFixed(2)},${this.r.locke.pose},stretch=${this.r.locke.stretch.active},ph=${this.r.phase}`); }
  setPose(want: Pose) {
    const L = this.r.locke;
    if (L.pose === want) return;
    // Pose buttons switch directly between crouch and flatten; only "stand" needs the toggle released.
    if (want === "crouch") this.step({ crouch: true });
    else if (want === "flatten") this.step({ flatten: true });
    else this.step(L.pose === "crouch" ? { crouch: true } : { flatten: true });
  }
  /** Move toward a point, waiting out pulses/sweepers by looking ahead. */
  go(x: number, z: number, pose: Pose, tol = 0.08) {
    for (let t = 0; t < 6000; t++) {
      const L = this.r.locke;
      const dx = x - L.pos.x, dz = z - L.pos.z, d = Math.hypot(dx, dz);
      if (d < tol || this.r.phase === "escaped") return true;
      if (this.r.phase === "lockdown") return false;
      const s = Math.min(1, d * 3), go = { x: (dx / d) * s, z: (dz / d) * s };
      const still = { x: 0, z: 0 }, back = { x: -go.x, z: -go.z };
      // Crouching is allowed wherever the planned pose is standing (it only ever avoids more beams).
      const crouchOk = pose !== "flatten";
      const opts: Array<[{ x: number; z: number }, boolean]> = [[go, false], ...(crouchOk ? [[go, true]] as Array<[{ x: number; z: number }, boolean]> : []), [still, false], ...(crouchOk ? [[still, true]] as Array<[{ x: number; z: number }, boolean]> : []), [back, false]];
      if (t % 4 === 0 || !this.lastPick) {
        // If nothing looks safe, freeze in the current pose (never stand up under a beam).
        const curCrouch = this.r.locke.pose === "crouch";
        let chosen: [{ x: number; z: number }, boolean] = [still, curCrouch && crouchOk];
        for (const o of opts) {
          const snap = this.r.snapshot(), th = this.r.threat;
          const target: Pose = o[1] ? "crouch" : pose;
          const b2 = new Bot(this.r);
          b2.setPose(target);
          for (let k = 0; k < 150; k++) this.r.step({ ...emptyInput(), move: o[0] });
          const ok = this.r.threat === th;
          this.r.restore(snap);
          if (ok) { chosen = o; break; }
        }
        this.lastPick = chosen;
      }
      const [mv, cr] = this.lastPick!;
      this.setPose(cr ? "crouch" : pose);
      this.step({ move: mv === go || mv === back || mv === still ? mv : mv });
    }
    return false;
  }
  lastPick: [{ x: number; z: number }, boolean] | undefined;
  travel(goal: (p: V2) => boolean) {
    const path = plan(this.r, this.r.locke.pos, goal);
    if (!path) { this.log.push(`no-path from ${this.r.locke.pos.x.toFixed(2)},${this.r.locke.pos.z.toFixed(2)}`); return false; }
    if (process.env.DUMP) this.log.push("WP " + waypoints(path).map((w) => `${w.p.x.toFixed(1)},${w.p.z.toFixed(1)}:${w.pose[0]}`).join(" "));
    const rank: Record<Pose, number> = { stand: 0, crouch: 1, flatten: 2 };
    let prevPose: Pose = this.r.locke.pose;
    for (const w of waypoints(path)) {
      // Hold the stricter of the two poses for the whole segment (don't stand up under a beam).
      const segPose = rank[prevPose] > rank[w.pose] ? prevPose : w.pose;
      prevPose = w.pose;
      if (this.go(w.p.x, w.p.z, segPose)) continue; this.log.push(`stuck at ${this.r.locke.pos.x.toFixed(2)},${this.r.locke.pos.z.toFixed(2)} → ${w.p.x.toFixed(2)},${w.p.z.toFixed(2)} ${w.pose} thr${this.r.threat} ${this.r.phase}`); return false;
    }
    return true;
  }
}

for (const id of ["mus-2", "mus-3", "mus-4", "mus-5", "mus-6"]) {
  test(`${id}: a bot can play it start to finish`, () => {
    const room = load(id);
    const r = new HeistRun(room);
    const bot = new Bot(r);
    // 1. Optics.
    for (const want of solveOptics(room)) {
      const m = room.mounts.find((mm) => mm.id === want.mountId)!;
      const others = room.mounts.filter((o) => o.id !== m.id);
      assert.ok(bot.travel((p) => { const d = Math.hypot(p.x - m.x, p.z - m.z); return d < 1.2 && d > 0.45 && others.every((o) => Math.hypot(p.x - o.x, p.z - o.z) > d + 0.4); }), `${id}: reach ${m.id} ${bot.log.join(' ; ')}`);
      bot.setPose("stand");
      for (let i = 0; i < 30 && r.targetMount() !== m.id; i++) bot.step({});
      assert.equal(r.targetMount(), m.id, `${id}: targeting ${m.id} got ${r.targetMount()} ${bot.log.join(' ; ')}`);
      bot.step({ interact: true });
      const op = r.optics.find((o) => o.mountId === m.id)!;
      assert.ok(op, `${id}: placed on ${m.id}`);
      for (let i = 0; i < 24 && op.angle % 180 !== want.angle % 180; i++) bot.step({ rotate: 1 });
    }
    for (let i = 0; i < 4; i++) bot.step({});
    assert.equal(r.frame.fed.size, room.sensors.length, `${id}: sensors fed`);
    // 2. The prize: walk up and lift, or stretch to it.
    const pz = v2(room.prize.x, room.prize.z);
    const near = (rad: number) => (p: V2) => Math.hypot(p.x - pz.x, p.z - pz.z) < rad;
    if (bot.travel(near(1.0))) { bot.setPose("stand"); bot.step({ interact: true }); }
    else {
      assert.ok(bot.travel(near(2.6)), `${id}: within reach of the prize ${bot.log.join(' ; ')}`);
      bot.setPose("stand");
      for (let tries = 0; tries < 30 && !r.prizeLifted; tries++) {
        const L = r.locke, d = v2(pz.x - L.pos.x, pz.z - L.pos.z), l = Math.hypot(d.x, d.z);
        for (let k = 0; k < 220 && !r.prizeLifted; k++) bot.step({ stretch: true, move: { x: d.x / l, z: d.z / l } });
        for (let k = 0; k < 120; k++) bot.step({});
      }
    }
    for (let i = 0; i < 200 && !r.locke.hasPrize; i++) bot.step({});
    assert.ok(r.locke.hasPrize, `${id}: prize in hand`);
    // 3. Escape.
    const exits = room.exits.filter((e) => e.phase === "out").map((e) => v2(e.x, e.z));
    assert.ok(bot.travel((p) => exits.some((e) => Math.hypot(p.x - e.x, p.z - e.z) < 0.7)), `${id}: ${bot.log.join(" ; ")} path to an exit from ${r.locke.pos.x.toFixed(2)},${r.locke.pos.z.toFixed(2)} pose ${r.locke.pose} phase ${r.phase} thr ${r.threat} start ${poseAt(r, r.locke.pos)}`);
    for (let i = 0; i < 60 && r.phase !== "escaped"; i++) bot.step({});
    assert.equal(r.phase, "escaped", `${id}: escaped (${bot.log.join(",")})`);
    assert.ok(r.threat <= 1, `${id}: alarms ${r.threat} (${bot.log.join(",")})`);
  }, 240_000);
}
