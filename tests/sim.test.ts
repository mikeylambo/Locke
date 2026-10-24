import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HeistRun, emptyInput, type SimInput } from "../src/sim/run";
import type { RoomDef } from "../src/sim/roomTypes";

const room = JSON.parse(readFileSync(new URL("../src/rooms/room-zero.json", import.meta.url), "utf8")) as RoomDef;

function run(r: HeistRun, ticks: number, f: (r: HeistRun) => Partial<SimInput>) {
  const evs: string[] = [];
  for (let i = 0; i < ticks; i++) for (const e of r.step({ ...emptyInput(), ...f(r) })) evs.push(e.type === "contact" ? `contact:${e.emitter}@${e.at.x.toFixed(2)},${e.at.z.toFixed(2)} t${r.tick} b${r.beat.toFixed(2)}` : e.type);
  return evs;
}

function walkTo(r: HeistRun, x: number, z: number, max = 2400, extra: Partial<SimInput> = {}) {
  return run(r, max, (rr) => {
    const dx = x - rr.locke.pos.x, dz = z - rr.locke.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.05) return { ...extra };
    const s = Math.min(1, d * 3);
    return { ...extra, move: { x: (dx / d) * s, z: (dz / d) * s } };
  });
}

test("grid is live at start, mirror at 45° feeds the sensor and drops it", () => {
  const r = new HeistRun(room);
  assert.ok(r.frame.segments.some((s) => s.emitter === "grid-a" && s.live));
  r.optics.push({ mountId: "m1", kind: "mirror", angle: 45 });
  r.step(emptyInput());
  assert.ok(r.frame.fed.has("s1"), "sensor fed");
  assert.ok(!r.frame.segments.some((s) => s.emitter === "grid-a"), "grid off");
});

test("deterministic: same inputs give identical state", () => {
  const a = new HeistRun(room), b = new HeistRun(room);
  const script = (rr: HeistRun) => ({ move: { x: Math.sin(rr.tick / 50), z: -0.6 } });
  run(a, 900, script); run(b, 900, script);
  assert.deepEqual(a.locke.pos, b.locke.pos);
  assert.equal(a.threat, b.threat);
});

/** Cautious bot: steps toward each waypoint, but waits (or backs off) when a look-ahead predicts contact. */
function sneak(r: HeistRun, pts: Array<[number, number]>, maxTicks = 20000) {
  const evs: string[] = [];
  let wp = 0;
  for (let t = 0; t < maxTicks && wp < pts.length; t++) {
    const [x, z] = pts[wp]!;
    const dx = x - r.locke.pos.x, dz = z - r.locke.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.08) { wp++; continue; }
    const go = { x: (dx / d) * Math.min(1, d * 3), z: (dz / d) * Math.min(1, d * 3) };
    const still = { x: 0, z: 0 };
    const options = [[go, false], [go, true], [still, false], [still, true], [{ x: -go.x, z: -go.z }, false], [{ x: -go.x, z: -go.z }, true]] as const;
    let chosen: (typeof options)[number] = options[2];
    for (const opt of options) {
      const snap = r.snapshot();
      const threat = r.threat;
      for (let k = 0; k < 90; k++) r.step({ ...emptyInput(), move: opt[0], crouch: k === 0 && opt[1] });
      const ok = r.threat === threat;
      r.restore(snap);
      if (ok) { chosen = opt; break; }
    }
    for (const e of r.step({ ...emptyInput(), move: chosen[0], crouch: chosen[1] })) evs.push(e.type === "contact" ? `contact:${e.emitter}` : e.type);
  }
  return evs;
}

test("a cautious thief can place the mirror, lift the diamond and escape clean", () => {
  const r = new HeistRun(room);
  const all: string[] = [];
  all.push(...walkTo(r, -4.3, 2.75));
  all.push(...run(r, 1, () => ({ interact: true })));
  assert.equal(r.optics.length, 1, "mirror placed");
  const op = r.optics[0]!;
  while (op.angle !== 45) all.push(...run(r, 1, () => ({ rotate: 1 })));
  all.push(...run(r, 2, () => ({})));
  assert.ok(r.frame.fed.has("s1"), "sensor fed");
  all.push(...sneak(r, [[-5.4, 2.6], [-5.4, 0.6], [-5.4, -0.62], [0, -0.62], [0, -1.48], [0, -2.5]]));
  all.push(...run(r, 1, () => ({ interact: true })));
  assert.ok(r.prizeLifted, "diamond lifted");
  for (let i = 0; i < 120 && !r.locke.hasPrize; i++) all.push(...run(r, 1, () => ({})));
  assert.ok(r.locke.hasPrize, "diamond in hand");
  all.push(...sneak(r, [[0, -1.48], [0, -0.62], [-5.3, -0.62], [-5.3, 0.9], [-5.4, 3.0], [-5.9, 3.4]], 40000));
  assert.equal(r.phase, "escaped", all.filter((e) => e !== "step").join(","));
  assert.equal(r.threat, 0);
}, 120_000);
