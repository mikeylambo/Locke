import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HeistRun, emptyInput, type SimInput } from "../src/sim/run";
import type { RoomDef } from "../src/sim/roomTypes";

const load = (id: string) => JSON.parse(readFileSync(new URL(`../src/rooms/${id}.json`, import.meta.url), "utf8")) as RoomDef;
const step = (r: HeistRun, n: number, f: (r: HeistRun) => Partial<SimInput> = () => ({})) => { for (let i = 0; i < n; i++) r.step({ ...emptyInput(), ...f(r) }); };
function walk(r: HeistRun, pts: Array<[number, number]>) {
  for (const [x, z] of pts) step(r, 2400, (rr) => {
    const dx = x - rr.locke.pos.x, dz = z - rr.locke.pos.z, d = Math.hypot(dx, dz);
    return d < 0.05 ? {} : { move: { x: (dx / d) * Math.min(1, d * 3), z: (dz / d) * Math.min(1, d * 3) } };
  });
}

test("A: walking around the column clears with no contact; touching the beam is forgiven", () => {
  const r = new HeistRun(load("tut-a"));
  walk(r, [[2.6, 1.2], [2.6, -1.0]]);
  step(r, 1, () => ({ interact: true }));
  step(r, 120);
  assert.ok(r.locke.hasPrize);
  walk(r, [[3.6, 1.8]]);
  assert.equal(r.phase, "escaped");
  assert.equal(r.threat, 0);
  const f = new HeistRun(load("tut-a"));
  walk(f, [[-2, 1], [-2, -1.5], [-2, 1], [-2, -1.5], [-2, 1], [-2, -1.5]]);
  assert.equal(f.threat, 1, "capped at Disturbed");
  assert.notEqual(f.phase, "lockdown");
});

test("B: the prize is unreachable on foot but the Stretch gets it over the rope", () => {
  const r = new HeistRun(load("tut-b"));
  walk(r, [[0, -0.4]]);
  assert.ok(!r.canGrabPrize(), "cannot grab on foot");
  step(r, 300, (rr) => ({ stretch: !rr.prizeLifted, move: { x: 0, z: -1 } }));
  step(r, 120);
  assert.ok(r.locke.hasPrize, "stretched and lifted");
  walk(r, [[-3.6, 1.8]]);
  assert.equal(r.phase, "escaped");
});

test("C: placing the mirror at 45° feeds the sensor and kills the grid", () => {
  const r = new HeistRun(load("tut-c"));
  assert.ok(r.frame.segments.some((s) => s.emitter === "grid-a"));
  walk(r, [[-2.7, 1.85]]);
  step(r, 1, () => ({ interact: true }));
  const op = r.optics[0]!;
  while (op.angle !== 45 && op.angle !== 225) step(r, 1, () => ({ rotate: 1 }));
  step(r, 2);
  assert.ok(r.frame.fed.has("s1"));
  assert.ok(!r.frame.segments.some((s) => s.emitter.startsWith("grid")));
  walk(r, [[-4.0, 1.9], [-4.0, -1.5], [1.5, -1.6]]);
  step(r, 1, () => ({ interact: true }));
  step(r, 120);
  assert.ok(r.locke.hasPrize);
  step(r, 1, () => ({ crouch: true }));
  walk(r, [[4.0, 2.4]]);
  assert.equal(r.phase, "escaped");
  assert.equal(r.threat, 0);
});
