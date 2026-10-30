import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { HeistRun, emptyInput, POSE_RADIUS, HIT_SCALE, type Pose, type SimInput } from "../src/sim/run";
import { segSegDist, v2, type V2 } from "../src/sim/math2d";
import { BANDS, type Band, type RoomDef } from "../src/sim/roomTypes";

/**
 * The Gilded Museum night, played by a bot through the real sim, one scripted heist per room.
 * Each script only says *where to go and what to press*; the bot plans paths over the static beams,
 * picks poses, and waits out every pulse, sweeper, pendulum and grate by looking ahead in the sim.
 */
const load = (id: string) => JSON.parse(readFileSync(new URL(`../src/rooms/${id}.json`, import.meta.url), "utf8")) as RoomDef;
const STEP = 0.1;
const POSE_BANDS: Record<Pose, Band[]> = { stand: ["low", "mid", "high"], crouch: ["low", "mid"], flatten: ["low", "mid", "high"] };

class Bot {
  log: string[] = [];
  contacts = 0;
  constructor(readonly r: HeistRun) {}
  step(i: Partial<SimInput> = {}) {
    for (const e of this.r.step({ ...emptyInput(), ...i })) if (e.type === "contact") { this.contacts++; this.log.push(`contact:${e.emitter}@${this.r.locke.pos.x.toFixed(2)},${this.r.locke.pos.z.toFixed(2)} f${this.r.locke.floor} ${this.r.locke.pose}`); }
  }
  wait(n: number) { for (let i = 0; i < n; i++) this.step(); }
  setPose(want: Pose) {
    const L = this.r.locke;
    if (L.pose === want) return;
    if (want === "crouch") this.step({ crouch: true });
    else if (want === "flatten") this.step({ flatten: true });
    else this.step(L.pose === "crouch" ? { crouch: true } : { flatten: true });
  }

  private bandsAt(p: V2, pose: Pose): Band[] {
    const b = POSE_BANDS[pose];
    return this.r.raisedAt(p) ? b.map((x) => BANDS[BANDS.indexOf(x) + 1]).filter((x): x is Band => !!x) : b;
  }

  /** Which pose (if any) can occupy p, given static live beams and live alarm plates on this floor. */
  poseAt(p: V2, from: V2): Pose | null {
    const r = this.r, floor = r.locke.floor;
    const segs = r.beams.trace(r.world(), undefined).segments.filter((s) => s.live && s.type === "static" && !s.vertical && s.floor === floor);
    for (const plate of r.room.plates ?? []) if (plate.alarm && !plate.prize && (plate.floor ?? 0) === floor && r.plateLive(plate) && Math.abs(p.x - plate.x) < plate.w / 2 + 0.05 && Math.abs(p.z - plate.z) < plate.d / 2 + 0.05) return null;
    for (const pose of ["stand", "crouch", "flatten"] as Pose[]) {
      if (!r.canStand(p, pose)) continue;
      const rr = POSE_RADIUS[pose] * HIT_SCALE + 0.06;
      let a = from, bb = p;
      if (pose === "flatten") {
        const dx = p.x - from.x, dz = p.z - from.z, l = Math.hypot(dx, dz) || 1;
        a = v2(from.x - (dx / l) * 0.22, from.z - (dz / l) * 0.22); bb = v2(p.x + (dx / l) * 0.24, p.z + (dz / l) * 0.24);
      }
      const bands = this.bandsAt(p, pose);
      if (segs.some((s) => bands.includes(s.band) && segSegDist(a, bb, s.a, s.b) < rr)) continue;
      return pose;
    }
    return null;
  }

  plan(goal: (p: V2) => boolean): Array<{ p: V2; pose: Pose }> | null {
    const hw = this.r.room.size.w / 2, hd = this.r.room.size.d / 2;
    const toP = (i: number, j: number) => v2(-hw + i * STEP, -hd + j * STEP);
    const from = this.r.locke.pos;
    const si = Math.round((from.x + hw) / STEP), sj = Math.round((from.z + hd) / STEP);
    const k = (i: number, j: number) => i * 1000 + j;
    const prev = new Map<number, number>([[k(si, sj), -1]]);
    const pose = new Map<number, Pose>();
    const q: Array<[number, number]> = [[si, sj]];
    let head = 0;
    while (head < q.length) {
      const [i, j] = q[head++]!;
      const p = toP(i, j);
      if (goal(p)) {
        const out: Array<{ p: V2; pose: Pose }> = [];
        for (let c = k(i, j); c !== -1; c = prev.get(c)!) out.unshift({ p: toP(Math.floor(c / 1000), c % 1000), pose: pose.get(c) ?? "stand" });
        return out;
      }
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = i + di, nj = j + dj, nk = k(ni, nj);
        if (prev.has(nk)) continue;
        const ps = this.poseAt(toP(ni, nj), p);
        if (!ps) continue;
        prev.set(nk, k(i, j)); pose.set(nk, ps); q.push([ni, nj]);
      }
    }
    return null;
  }

  private lastPick: [V2, Pose] | undefined;
  /** Move toward a point, waiting out dynamic hazards by looking ahead in the sim. */
  go(x: number, z: number, pose: Pose, tol = 0.08): boolean {
    this.lastPick = undefined;
    for (let t = 0; t < 8000; t++) {
      const L = this.r.locke;
      const dx = x - L.pos.x, dz = z - L.pos.z, d = Math.hypot(dx, dz);
      if (d < tol || this.r.phase === "escaped") return true;
      if ((this.r.phase as string) === "lockdown") return false;
      const s = Math.min(1, d * 3), go = v2((dx / d) * s, (dz / d) * s), still = v2(0, 0), back = v2(-go.x, -go.z);
      // Try the planned pose first, then any other pose his body fits in right here.
      const poses = ([pose, "crouch"] as Pose[]).filter((p, i, a) => a.indexOf(p) === i && (p === pose || pose !== "flatten" || this.r.canStand(L.pos, p)));
      const opts: Array<[V2, Pose]> = [];
      for (const mvv of [go, still, back]) for (const p of poses) opts.push([mvv, p]);
      if (t % 4 === 0 || !this.lastPick) {
        let chosen: [V2, Pose] = [still, this.r.locke.pose];
        for (const o of opts) {
          const snap = this.r.snapshot(), th = this.r.threat;
          const b2 = new Bot(this.r);
          b2.setPose(o[1]);
          // Look ahead about as far as the move takes him (plus a beat), never blindly past the waypoint.
          const ahead = o[0] === go ? Math.min(150, Math.ceil((d / 1.2) * 120) + 50) : 150;
          for (let kk = 0; kk < ahead; kk++) this.r.step({ ...emptyInput(), move: kk * (1 / 120) * 2.25 < d + 0.1 || o[0] !== go ? o[0] : still });
          const ok = this.r.threat === th && this.r.phase !== "lockdown";
          this.r.restore(snap);
          if (ok) { chosen = o; break; }
        }
        this.lastPick = chosen;
      }
      const [mv, ps] = this.lastPick!;
      this.setPose(ps);
      this.step({ move: mv });
    }
    return false;
  }

  travel(goal: (p: V2) => boolean, what = "goal"): void {
    const path = this.plan(goal);
    assert.ok(path, `${this.r.room.id}: no path to ${what} from ${this.r.locke.pos.x.toFixed(2)},${this.r.locke.pos.z.toFixed(2)} f${this.r.locke.floor} ${this.log.join(" ; ")}`);
    const rank: Record<Pose, number> = { stand: 0, crouch: 1, flatten: 2 };
    let prevPose: Pose = this.r.locke.pose;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b: { p: V2; pose: Pose } = path[i]!, c = path[i + 1];
      const turn = !c || Math.sign(b.p.x - a.p.x) !== Math.sign(c.p.x - b.p.x) || Math.sign(b.p.z - a.p.z) !== Math.sign(c.p.z - b.p.z);
      if (c && !turn && b.pose === a.pose && c.pose === b.pose) continue;
      const segPose = rank[prevPose] > rank[b.pose] ? prevPose : b.pose;
      prevPose = b.pose;
      assert.ok(this.go(b.p.x, b.p.z, segPose), `${this.r.room.id}: stuck heading for ${what} at ${this.r.locke.pos.x.toFixed(2)},${this.r.locke.pos.z.toFixed(2)} ${this.log.join(" ; ")}`);
    }
  }
  to(x: number, z: number, rad = 0.35) { this.travel((p) => Math.hypot(p.x - x, p.z - z) < rad, `${x},${z}`); }

  /** Stand near a mount, place the belt optic (if empty) and turn it to `angle`. */
  setOptic(mountId: string, angle: number) {
    const m = this.r.room.mounts.find((mm) => mm.id === mountId)!;
    const others = this.r.room.mounts.filter((o) => o.id !== m.id && (o.floor ?? 0) === (m.floor ?? 0) && !o.hook);
    if (this.r.targetMount() !== mountId) this.travel((p) => { const d = Math.hypot(p.x - m.x, p.z - m.z); return d < 1.2 && d > 0.45 && others.every((o) => Math.hypot(p.x - o.x, p.z - o.z) > d + 0.4); }, mountId);
    this.setPose("stand");
    for (let i = 0; i < 30 && this.r.targetMount() !== mountId; i++) this.step();
    assert.equal(this.r.targetMount(), mountId, `${this.r.room.id}: targeting ${mountId}`);
    if (!this.r.optics.some((o) => o.mountId === mountId)) this.step({ interact: true });
    const op = this.r.optics.find((o) => o.mountId === mountId)!;
    assert.ok(op, `${this.r.room.id}: optic on ${mountId}`);
    for (let i = 0; i < 24 && op.angle % 180 !== angle % 180; i++) this.step({ rotate: 1 });
    this.wait(4);
  }

  stairs() { const f = this.r.locke.floor; this.setPose("stand"); this.step({ interact: true }); assert.notEqual(this.r.locke.floor, f, "took the stairs"); }

  lift() {
    const pz = this.r.prizePos;
    this.setPose("stand");
    if (this.r.canGrabPrize()) this.step({ interact: true });
    for (let tries = 0; tries < 30 && !this.r.prizeLifted; tries++) {
      const L = this.r.locke, d = v2(pz.x - L.pos.x, pz.z - L.pos.z), l = Math.hypot(d.x, d.z);
      for (let k = 0; k < 220 && !this.r.prizeLifted; k++) this.step({ stretch: true, move: { x: d.x / l, z: d.z / l } });
      for (let k = 0; k < 120 && !this.r.prizeLifted; k++) this.step();
    }
    // The room flips the moment it lifts: get low while the arm reels it in.
    for (let i = 0; i < 240 && !this.r.locke.hasPrize; i++) { if (this.r.locke.pose === "stand") this.setPose("crouch"); else this.step(); }
    assert.ok(this.r.locke.hasPrize, `${this.r.room.id}: prize in hand ${this.log.join(" ; ")}`);
  }

  escape() {
    const exits = this.r.room.exits.filter((e) => this.r.exitOpen(e.id) && (e.floor ?? 0) === this.r.locke.floor);
    this.travel((p) => exits.some((e) => Math.hypot(p.x - e.x, p.z - e.z) < 0.7), "an exit");
    for (let i = 0; i < 60 && this.r.phase !== "escaped"; i++) this.step();
    assert.equal(this.r.phase, "escaped", `${this.r.room.id}: escaped (${this.log.join(", ")})`);
  }

  /** Side view: run an input for n ticks, but only once a look-ahead says it won't touch a beam. */
  safely(n: number, input: Partial<SimInput>, waitInput: Partial<SimInput> = {}, horizon = n) {
    for (let w = 0; w < 2400; w++) {
      const snap = this.r.snapshot(), th = this.r.threat;
      for (let k = 0; k < horizon; k++) this.r.step({ ...emptyInput(), ...input });
      const ok = this.r.threat === th;
      this.r.restore(snap);
      if (ok) { for (let k = 0; k < n; k++) this.step(input); return; }
      this.step(waitInput);
    }
    assert.fail(`${this.r.room.id}: never safe to ${JSON.stringify(input)}`);
  }
}

function finish(b: Bot, entryFloor = 0) {
  const r = b.r;
  assert.ok(r.threat <= 1, `${r.room.id}: alarms ${r.threat} (${b.log.join(", ")})`);
  const ex = r.room.exits.find((e) => e.id === r.escapedVia)!;
  assert.ok(ex.id !== r.room.entry.id && (Math.hypot(ex.x - r.room.entry.x, ex.z - r.room.entry.z) > 2 || (ex.floor ?? 0) !== entryFloor), `${r.room.id}: the way out differs from the way in`);
}

const SCRIPTS: Record<string, (b: Bot) => void> = {
  "mus-a": (b) => {
    const r = b.r;
    b.wait(20);
    b.go(-0.35, r.locke.pos.z, "stand", 0.05);
    for (let i = 0; i < 120 && !r.locke.stretch.hook; i++) b.step({ stretch: true });
    assert.equal(String(r.locke.stretch.hook), "h1", "caught the skylight hook");
    // Swing off the roof beam and pay out rope down to the cornice, timing the drifting beam.
    b.safely(40, { stretch: true, move: v2(1, 0) }, { stretch: true }, 40);
    for (let i = 0; i < 400 && !r.locke.grounded; i++) b.safely(1, { stretch: true, move: v2(0, 1) }, { stretch: true, move: v2(0, -1) }, 90);
    assert.ok(r.locke.grounded && r.locke.pos.z < 0, `on the cornice z=${r.locke.pos.z}`);
    b.step({});
    b.wait(30);
    b.go(1.75, r.locke.pos.z, "stand", 0.05);
    for (let i = 0; i < 160 && r.locke.stretch.hook !== "h2"; i++) b.step({ stretch: true, move: v2(0.4, 1) });
    assert.equal(String(r.locke.stretch.hook), "h2");
    b.safely(30, { stretch: true, move: v2(1, 0) }, { stretch: true }, 30);
    let let_go = false;
    for (let i = 0; i < 900 && !let_go; i++) { b.safely(1, { stretch: true, move: v2(0, 1) }, { stretch: true }, 100); let_go = !r.locke.stretch.hook; }
    b.wait(90);
    assert.ok(r.locke.grounded && r.locke.pos.z === r.room.size.d / 2, "landed in the atrium");
    for (let i = 0; i < 900 && r.phase !== "escaped"; i++) b.step({ move: v2(-1, 0) });
  },
  "room-zero": (b) => {
    b.setOptic("m1", 45);
    assert.ok(b.r.frame.fed.has("s1"), "grid sensor lit");
    b.to(0, -2.25, 0.12); b.lift(); b.to(0, 0.6); b.escape();
  },
  "mus-2": (b) => {
    b.to(8.75, 0); b.lift(); b.escape();
  },
  "mus-3": (b) => {
    b.setOptic("m1", 45);
    if (!b.r.frame.fed.has("s1")) console.log("mus-3 dbg", b.r.optics, b.log, b.r.locke.pos, b.r.threat);
    assert.ok(b.r.frame.fed.has("s1"), "funhouse sensor lit");
    b.to(-2.6, -5.3); b.lift(); b.escape();
  },
  "mus-b": (b) => {
    const r = b.r;
    for (let i = 0; i < 4000 && r.phase !== "escaped"; i++) {
      b.setPose("crouch");
      b.safely(6, { move: v2(1, 0) }, {}, 70);
    }
  },
  "mus-4": (b) => {
    const r = b.r;
    b.to(-11.6, -1.5); b.stairs();
    b.setOptic("well", 135);
    assert.ok(r.frame.fed.has("s0"), "well beam lit the gallery sensor");
    b.to(-11.6, -1.5); b.stairs();
    b.to(2.0, 1.75, 0.25); b.lift();
    b.to(11.6, -1.5); b.stairs();
    b.escape();
  },
  "mus-5": (b) => {
    // Through the first card-thin gap, onto the plinth walk (the low sweeper passes beneath), flatten through the second gap.
    b.to(-6.0, 3.7, 0.2);
    b.to(-5.2, 1.2, 0.2);
    b.go(-1.0, 1.15, "stand");
    b.go(-1.0, -0.2, "flatten");
    b.setPose("stand");
    b.to(0.2, -2.45, 0.2); b.lift();
    // Skirt the court sweeper's reach, then one timed dash to the door.
    b.to(2.6, -0.9); b.to(7.3, -0.9);
    if (process.env.DUMP) console.log("m5 after lift", b.r.locke.pos, b.r.frame.segments.filter((s) => s.live && s.emitter === "court-sweep").map((s) => `${s.a.x.toFixed(1)},${s.a.z.toFixed(1)}>${s.b.x.toFixed(1)},${s.b.z.toFixed(1)}`));
    b.escape();
  },
  "mus-6": (b) => {
    const r = b.r;
    b.to(-7.0, 3.6); b.stairs();
    b.setOptic("well", 45);
    assert.ok(r.frame.fed.has("A") && r.frame.fed.has("B"), "both lock sensors lit");
    b.to(-7.0, 3.6); b.stairs();
    b.wait(120);
    assert.ok(r.shutterOpen.inner! > 0.9, "inner shutter open");
    b.to(0, 2.75, 0.2); b.lift();
    b.to(-7.0, 3.6); b.stairs();
    b.escape();
  },
  "mus-6g": (b) => {
    const r = b.r;
    b.wait(30);
    // Re-aim the rib mirror so the beam bends up into the first rib.
    b.go(-2.4, r.locke.pos.z, "stand", 0.05);
    for (let i = 0; i < 6 && r.optics[0]!.angle !== 45; i++) b.step({ rotate: 1 });
    assert.equal(r.optics[0]!.angle, 45, "mirror re-aimed");
    b.go(-3.2, r.locke.pos.z, "stand", 0.05);
    const climb = (hook: string, edgeX: number, landX: number) => {
      for (let i = 0; i < 200 && r.locke.stretch.hook !== hook; i++) b.step({ stretch: true, move: v2((r.room.mounts.find((m) => m.id === hook)!.x - r.locke.pos.x) * 0.5, -1) });
      assert.equal(r.locke.stretch.hook, hook, `caught ${hook}`);
      const z0 = r.locke.pos.z;
      b.safely(1, { stretch: false, move: v2(Math.sign(landX - edgeX), -1) }, { stretch: true }, 130);
      for (let i = 0; i < 300 && !(r.locke.grounded && !r.locke.stretch.hook && !r.locke.stretch.yank && r.locke.pos.z < z0 - 0.5); i++) b.step({ move: v2(Math.sign(landX - edgeX), -1) });
      b.wait(20);
    };
    if (process.env.DUMP) console.log("6g pre", r.locke.pos, r.optics[0]!.angle, b.log);
    climb("hA", -3.2, -2.2);
    if (process.env.DUMP) console.log("6g rib1", r.locke.pos, b.log);
    assert.ok(r.locke.pos.z < 2, `on the first rib z=${r.locke.pos.z}`);
    b.go(-0.45, r.locke.pos.z, "stand", 0.05);
    climb("hB", -0.45, 0.6);
    if (process.env.DUMP) console.log("6g rib2", r.locke.pos, b.log);
    assert.ok(r.locke.pos.z < 0, `on the second rib z=${r.locke.pos.z}`);
    b.go(2.3, r.locke.pos.z, "stand", 0.05);
    climb("hC", 2.3, 3.0);
    assert.ok(r.locke.pos.z < -2.3, `on the skylight sill z=${r.locke.pos.z}`);
    for (let i = 0; i < 600 && r.phase !== "escaped"; i++) b.step({ move: v2(1, 0) });
  },
};

for (const id of ["mus-a", "room-zero", "mus-2", "mus-3", "mus-b", "mus-4", "mus-5", "mus-6", "mus-6g"]) {
  test(`${id}: a bot plays the v3 room start to finish`, () => {
    const room = load(id);
    const b = new Bot(new HeistRun(room));
    SCRIPTS[id]!(b);
    assert.equal(b.r.phase, "escaped", `${id}: escaped (${b.log.join(", ")}) at ${b.r.locke.pos.x.toFixed(2)},${b.r.locke.pos.z.toFixed(2)}`);
    finish(b, room.spawn.floor ?? 0);
  }, 300_000);
}

test("no two museum rooms share dimensions", () => {
  const files = readdirSync(new URL("../src/rooms/", import.meta.url)).filter((f) => f.endsWith(".json"));
  const rooms = files.map((f) => load(f.replace(".json", ""))).filter((r) => r.venue === "gilded-museum" && !r.id.startsWith("tut-"));
  const seen = new Map<string, string>();
  for (const r of rooms) {
    const key = `${r.size.w}x${r.size.d}${r.floors && r.floors > 1 ? `x${r.floors}` : ""}`;
    assert.ok(!seen.has(key), `${r.id} shares ${key} with ${seen.get(key)}`);
    seen.set(key, r.id);
  }
  assert.ok(rooms.length >= 9);
});

test("every museum room carries its blueprint note and author", () => {
  for (const id of ["mus-a", "room-zero", "mus-2", "mus-3", "mus-b", "mus-4", "mus-5", "mus-6"]) {
    const r = load(id);
    assert.ok(r.note && r.author, `${id} note/author`);
  }
});
