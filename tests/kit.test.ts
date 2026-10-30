import { test } from "vitest";
import assert from "node:assert/strict";
import { HeistRun, emptyInput, type SimInput } from "../src/sim/run";
import { pointInPoly, outlineOf, pendulumBob } from "../src/sim/beams";
import type { EmitterDef, RoomDef } from "../src/sim/roomTypes";
import { v2 } from "../src/sim/math2d";

/** A bare 10×10 room; each test bolts on the one feature it checks. */
function room(extra: Partial<RoomDef> = {}): RoomDef {
  return {
    id: "kit", name: "Kit", venue: "Test", headline: "", size: { w: 10, d: 10, h: 4 }, key: { root: "C", mode: "major" }, tempo: 120, parTime: 60,
    spawn: { x: -4, z: 4, facing: 0 }, entry: { id: "in", x: -4, z: 5, wall: "s", phase: "in" },
    blocks: [], mounts: [], sensors: [], emitters: [], exits: [{ id: "out", x: 4, z: -5, wall: "n", phase: "out" }],
    prize: { kind: "diamond", x: 3, z: -3, value: 100, name: "Test" }, belt: [], ...extra
  };
}
const beam = (e: Partial<EmitterDef> & { id: string }): EmitterDef => ({ type: "static", x: -5, z: 0, angle: 0, bands: ["mid"], ...e });
function steps(r: HeistRun, n: number, f: (r: HeistRun) => Partial<SimInput> = () => ({})) {
  const ev: string[] = [];
  for (let i = 0; i < n; i++) for (const e of r.step({ ...emptyInput(), ...f(r) })) ev.push(e.type);
  return ev;
}
const segsOf = (r: HeistRun, id: string) => r.frame.segments.filter((s) => s.emitter === id);

test("shutter: solid until its sensor is lit, then grinds open and lets light and Locke through", () => {
  const def = room({
    sensors: [{ id: "s1", x: 0, z: -4.5 }],
    emitters: [beam({ id: "feed", x: 0, z: 4.9, angle: -90 }), beam({ id: "probe", x: -4.9, z: 2, angle: 0 })],
    blocks: [{ x: 0, z: -4.2, w: 0.1, d: 0.1, h: 0.1 }],
    shutters: [{ id: "g", x: 2, z: 2, w: 0.4, d: 2, opens: ["s1"] }]
  });
  // Sensor fed from the start: shutter opens.
  const r = new HeistRun(def);
  assert.ok(r.frame.fed.has("s1"));
  assert.equal(r.shutterOpen.g, 1);
  // Same room with the feed blocked: probe beam stops at the gate.
  const shut = new HeistRun({ ...def, emitters: [def.emitters[1]!] });
  assert.equal(shut.shutterOpen.g, 0);
  const end = segsOf(shut, "probe")[0]!.b.x;
  assert.ok(Math.abs(end - 1.8) < 1e-3, `stopped at shutter face, got ${end}`);
});

test("multi-sensor lock: needs every sensor lit at once", () => {
  const def = room({
    sensors: [{ id: "a", x: 4.5, z: 1 }, { id: "b", x: 4.5, z: -1 }],
    emitters: [beam({ id: "ea", x: -4.9, z: 1 }), beam({ id: "eb", x: -4.9, z: -1, phase: "out" })],
    shutters: [{ id: "lock", x: 0, z: -4, w: 2, d: 0.3, opens: ["a", "b"] }]
  });
  const r = new HeistRun(def);
  assert.ok(r.frame.fed.has("a") && !r.frame.fed.has("b"));
  assert.equal(r.shutterOpen.lock, 0, "one of two is not enough");
  const both = new HeistRun({ ...def, emitters: def.emitters.map((e) => ({ ...e, phase: undefined })) });
  assert.equal(both.shutterOpen.lock, 1);
});

test("pressure plate: held by Locke opens a shutter; phase-gated alarm plates trip", () => {
  const def = room({ spawn: { x: 0, z: 0, facing: 0 }, plates: [{ id: "p", x: 0, z: 0, w: 1, d: 1 }], shutters: [{ id: "g", x: 3, z: 0, w: 0.3, d: 2, opens: ["p"] }] });
  const r = new HeistRun(def);
  steps(r, 120);
  assert.ok(r.plates.has("p"));
  assert.ok(r.shutterOpen.g! > 0.9);
  const off = steps(r, 240, () => ({ move: v2(-1, 0) }));
  assert.ok(off.includes("plate.up") && r.shutterOpen.g! < 0.1, "walking off closes it");

  const alarm = new HeistRun(room({ spawn: { x: 0, z: 0, facing: 0 }, plates: [{ id: "live", x: 0, z: 0, w: 1, d: 1, phase: "out", alarm: true }] }));
  const ev = steps(alarm, 60, () => ({ move: v2(0.01, 0.2) }));
  assert.ok(!ev.includes("contact"), "in-phase plate is dead");
  alarm.phase = "out";
  assert.ok(steps(alarm, 10).includes("contact"), "out-phase plate trips");
});

test("prize plate: lifting the prize releases it", () => {
  const def = room({ spawn: { x: 2.2, z: -3, facing: 0 }, plates: [{ id: "pp", x: 3, z: -3, w: 0.6, d: 0.6, prize: true }] });
  const r = new HeistRun(def);
  assert.ok(r.plates.has("pp"));
  const ev = steps(r, 200, () => ({ interact: r.tick === 2 }));
  assert.ok(r.prizeLifted && ev.includes("plate.up"));
});

test("fixed optic: rotatable, never liftable", () => {
  const def = room({ spawn: { x: 0, z: 1, facing: 0 }, mounts: [{ id: "m", x: 0, z: 0 }], fixedOptics: [{ mountId: "m", kind: "mirror", angle: 45 }] });
  const r = new HeistRun(def);
  assert.equal(r.optics.length, 1);
  const ev = steps(r, 3, () => ({ interact: r.tick === 1, rotate: r.tick === 2 ? 1 : 0 }));
  assert.ok(ev.includes("deny"));
  assert.equal(r.optics.length, 1);
  assert.equal(r.optics[0]!.angle, 60);
  assert.equal(r.belt.length, 0);
});

test("band-shift mirrors: concave raises one band, convex lowers one", () => {
  const mk = (kind: "concave" | "convex", band: "low" | "mid" | "high") => new HeistRun(room({
    mounts: [{ id: "m", x: 0, z: 0 }], fixedOptics: [{ mountId: "m", kind, angle: 45 }],
    emitters: [beam({ id: "e", z: 0, bands: [band] })]
  }));
  const up = segsOf(mk("concave", "low"), "e");
  assert.deepEqual(up.map((s) => s.band), ["low", "mid"]);
  const down = segsOf(mk("convex", "high"), "e");
  assert.deepEqual(down.map((s) => s.band), ["high", "mid"]);
  assert.equal(segsOf(mk("concave", "high"), "e").length, 1, "nothing above high: absorbed");
});

test("camera beam: trips via a reflection but never powers a sensor", () => {
  const def = room({
    spawn: { x: 0, z: 3.8, facing: 0 },
    mounts: [{ id: "m", x: 0, z: 2 }], fixedOptics: [{ mountId: "m", kind: "mirror", angle: 45 }],
    sensors: [{ id: "s", x: 4.5, z: 2 }],
    emitters: [beam({ id: "cam", type: "camera", x: -4.9, z: 2, angle: 0, bands: ["low", "mid", "high"], sweep: { speed: 0 } })]
  });
  const r = new HeistRun(def);
  assert.ok(!r.frame.fed.has("s"));
  assert.equal(segsOf(r, "cam")[1]!.tint, "camera");
  // The reflected gaze runs north along x=0 toward Locke.
  r.phase = "in";
  assert.ok(steps(r, 2).includes("contact"), "seen in the mirror");
});

test("pendulum: blade swings on its plane; the out override rotates the plane 90°", () => {
  const e = beam({ id: "pen", type: "pendulum", x: 0, z: 0, angle: 0, bands: ["high"], range: 0.5, swing: { plane: 0, amp: 1.5, period: 4 }, out: { swing: { plane: 90, amp: 1.5, period: 4 } } });
  assert.ok(Math.abs(pendulumBob(e, 1).x - 1.5) < 1e-9);
  const r = new HeistRun(room({ emitters: [e] }));
  r.beat = 1; r.step(emptyInput());
  const s = segsOf(r, "pen")[0]!;
  assert.ok(s.a.x > 1.1 && Math.abs(s.a.z) < 1e-6, "in-phase swings east-west");
  r.phase = "out"; r.prizeLifted = true; r.beat = 1;
  r.step(emptyInput());
  const t = segsOf(r, "pen")[0]!;
  assert.ok(Math.abs(t.a.x) < 1e-6 && t.a.z > 1, "flipped: swings north-south");
});

test("projector: spokes on every floor; out override freezes it with every spoke on", () => {
  const e = beam({ id: "pj", type: "projector", x: 0, z: 0, angle: 0, bands: ["high"], spokes: 3, allFloors: true, sweep: { speed: 30 }, out: { sweep: { speed: 0 }, spokes: 8 } });
  const r = new HeistRun(room({ floors: 2, emitters: [e] }));
  const f = (fl: number) => segsOf(r, "pj").filter((s) => s.floor === fl && s.bounce === 0).length;
  assert.equal(f(0), 3); assert.equal(f(1), 3);
  steps(r, 120);
  assert.ok(Math.abs(r.sweep.pj!) > 1, "spinning");
  r.phase = "out"; r.prizeLifted = true;
  const before = r.sweep.pj;
  r.step(emptyInput());
  assert.equal(r.sweep.pj, before, "frozen");
  assert.equal(f(0), 8);
});

test("standable plinth: Locke rides one band up, so a low beam passes under him", () => {
  const def = room({ spawn: { x: -2, z: 0, facing: 0 }, blocks: [{ x: 0, z: 0, w: 1.2, d: 1.2, h: 0.45, style: "plinth", stand: true }],
    emitters: [beam({ id: "hi", x: -4.9, z: 3, bands: ["high"] })] });
  const r = new HeistRun(def);
  const ev = steps(r, 240, (rr) => ({ move: v2(rr.locke.pos.x < 0 ? 1 : 0, 0) }));
  assert.ok(ev.includes("stepUp") && r.locke.raised, "walked onto it");
  assert.deepEqual(r.bodyShapes()[0]!.bands, ["mid", "high"]);
});

test("stacked floors: stairs move Locke between planes; beams only touch their own floor; wells drop light", () => {
  const def = room({
    floors: 2, spawn: { x: -3, z: 0, facing: 0 },
    stairs: [{ id: "st", x: -3, z: 0, w: 1, d: 1, from: 0, to: 1 }],
    mounts: [{ id: "w", x: 2, z: 2, well: 1 }], fixedOptics: [{ mountId: "w", kind: "mirror", angle: 45 }],
    sensors: [{ id: "up", x: 2, z: 4.5, floor: 1 }],
    emitters: [beam({ id: "e", x: -4.9, z: 2, bands: ["mid"] })]
  });
  const r = new HeistRun(def);
  const segs = segsOf(r, "e");
  assert.equal(segs[0]!.floor, 0);
  assert.equal(segs[1]!.floor, 1, "reflected through the well onto the balcony");
  assert.ok(r.frame.fed.has("up"));
  const ev = steps(r, 2, () => ({ interact: r.tick === 1 }));
  assert.ok(ev.includes("stairs") && r.locke.floor === 1);
});

test("grate shafts fire up into the floor above in their phase", () => {
  const def = room({ floors: 2, spawn: { x: 0, z: 0, floor: 1, facing: 0 }, grates: [{ id: "gr", x: 0, z: 0, floor: 0, phase: "out" }] });
  const r = new HeistRun(def);
  assert.equal(segsOf(r, "gr").length, 0);
  r.phase = "out"; r.prizeLifted = true;
  const ev = steps(r, 3);
  assert.ok(segsOf(r, "gr").every((s) => s.vertical && s.floor === 1));
  assert.ok(ev.includes("contact"), "standing on a live grate");
});

test("polygon outline: L-shaped room keeps Locke and light inside the notch", () => {
  const L: Array<[number, number]> = [[-5, -5], [5, -5], [5, 0], [0, 0], [0, 5], [-5, 5]];
  assert.ok(pointInPoly(v2(-2, 2), outlineOf(room({ outline: L }))));
  assert.ok(!pointInPoly(v2(2, 2), outlineOf(room({ outline: L }))));
  const r = new HeistRun(room({ outline: L, spawn: { x: -1, z: 2, facing: 0 }, emitters: [beam({ id: "e", x: -4.9, z: 2 })] }));
  steps(r, 360, () => ({ move: v2(1, 0) }));
  assert.ok(r.locke.pos.x < 0, `held at the inner wall, x=${r.locke.pos.x}`);
  assert.ok(Math.abs(segsOf(r, "e")[0]!.b.x) < 1e-6, "beam ends on the inner wall");
});

test("camera obscura: interact while casing toggles the view without starting the clock", () => {
  const r = new HeistRun(room({ spawn: { x: 0, z: 0, facing: 0 }, obscura: { x: 0.5, z: 0 } }));
  const ev = steps(r, 2, () => ({ interact: r.tick === 1 }));
  assert.ok(ev.includes("obscura") && r.obscura && r.phase === "case");
  steps(r, 2, () => ({ move: v2(1, 0) }));
  assert.ok(!r.obscura && r.phase === "in");
});

test("side view: gravity, catch a hook, climb, and run out of arm", () => {
  const side = room({ view: "side", setPiece: true, size: { w: 8, d: 8, h: 1 }, spawn: { x: 0, z: -2, facing: 0 },
    blocks: [{ x: 0, z: -1.5, w: 2, d: 0.3, h: 1, style: "ledge" }],
    mounts: [{ id: "hk", x: 0, z: -3.9, hook: true }], exits: [{ id: "x", x: 3.5, z: 4, wall: "e", phase: "in" }] });
  const r = new HeistRun(side);
  steps(r, 120);
  assert.ok(r.locke.grounded && Math.abs(r.locke.pos.z - -1.65) < 1e-6, `stands on the ledge, z=${r.locke.pos.z}`);
  // Reach straight up to the hook.
  const ev = steps(r, 200, () => ({ stretch: true }));
  assert.ok(ev.includes("rope.hook"), "caught");
  // Walk off the ledge while hanging and pay out rope until the arm runs out.
  const ev2 = steps(r, 1200, () => ({ stretch: true, move: v2(r.locke.pos.x < 1.4 ? 1 : 0, 1) }));
  assert.ok(ev2.includes("rope.letgo"), "ran out of arm");
  steps(r, 240);
  assert.ok(r.locke.grounded && r.locke.pos.z === 4, "lands on the floor");
  // A set piece finishes at its exit without a prize.
  const ev3 = steps(r, 600, () => ({ move: v2(1, 0) }));
  assert.ok(ev3.includes("escaped"));
});

test("side view: releasing the stretch while hooked yanks the body up after the arm", () => {
  const r = new HeistRun(room({ view: "side", setPiece: true, size: { w: 8, d: 8, h: 1 }, spawn: { x: 0, z: 4, facing: 0 }, mounts: [{ id: "hk", x: 0, z: 1.2, hook: true }] }));
  steps(r, 10);
  steps(r, 200, () => ({ stretch: true }));
  assert.ok(r.locke.stretch.hook);
  let top = 9;
  const ev = steps(r, 120, (rr) => { top = Math.min(top, rr.locke.pos.z); return {}; });
  assert.ok(ev.includes("rope.yank") && ev.includes("stretch.snap"));
  assert.ok(top < 2.4, `body flew up to the hook, top=${top}`);
});

test("blueprint note and author are part of the schema", () => {
  const def = room({ note: "Keep time, or be kept.", author: "The Metronome" });
  assert.equal(new HeistRun(def).room.author, "The Metronome");
});
