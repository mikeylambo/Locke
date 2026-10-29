import { test } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { HeistRun, POSE_RADIUS, HIT_SCALE, STRETCH_MAX, type Pose } from "../src/sim/run";
import type { PlacedOptic } from "../src/sim/beams";
import { segSegDist, v2, type V2 } from "../src/sim/math2d";
import type { RoomDef } from "../src/sim/roomTypes";

const dir = new URL("../src/rooms/", import.meta.url);
const rooms = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as RoomDef);
const WALL_R: Record<Pose, number> = { stand: 0.28, crouch: 0.32, flatten: 0.16 };
const POSES: Pose[] = ["stand", "crouch", "flatten"];
const BANDS = { stand: ["low", "mid", "high"], crouch: ["low", "mid"], flatten: ["low", "mid", "high"] } as const;

/** Best optic setup the player could make: whatever feeds the most sensors. */
function solve(room: RoomDef): PlacedOptic[] {
  let best: PlacedOptic[] = [], bestFed = -1;
  const mirrors = room.belt.filter((k) => k === "mirror").length;
  if (!mirrors) return [];
  for (const m of room.mounts) for (let a = 0; a < 180; a += 15) {
    const r = new HeistRun(room);
    r.optics = [{ mountId: m.id, kind: "mirror", angle: a }];
    const fed = r.beams.trace(r.world()).fed.size;
    if (fed > bestFed) { bestFed = fed; best = r.optics; }
  }
  return best;
}

function reachable(r: HeistRun, from: V2, goal: (p: V2) => boolean): V2 | null {
  const room = r.room, step = 0.1;
  const hw = room.size.w / 2, hd = room.size.d / 2;
  // Only beams that never switch off count as walls; pulses and sweepers open on their own.
  const segs = r.beams.trace(r.world()).segments.filter((s) => s.live && s.type === "static");
  const free = (p: V2, from: V2 = p) => POSES.some((pose) => {
    const wr = WALL_R[pose];
    if (Math.abs(p.x) > hw - wr || Math.abs(p.z) > hd - wr) return false;
    for (const b of room.blocks) {
      const cx = Math.max(b.x - b.w / 2, Math.min(p.x, b.x + b.w / 2)), cz = Math.max(b.z - b.d / 2, Math.min(p.z, b.z + b.d / 2));
      if (Math.hypot(p.x - cx, p.z - cz) < wr) return false;
    }
    const rr = POSE_RADIUS[pose] * HIT_SCALE;
    // Sweep the whole step, so a thin pose can't hop over a beam between grid cells.
    return !segs.some((s) => (BANDS[pose] as readonly string[]).includes(s.band) && segSegDist(from, p, s.a, s.b) < rr);
  });
  const key = (i: number, j: number) => i * 10000 + j;
  const toP = (i: number, j: number) => v2(-hw + i * step, -hd + j * step);
  const si = Math.round((from.x + hw) / step), sj = Math.round((from.z + hd) / step);
  const seen = new Set([key(si, sj)]), q: Array<[number, number]> = [[si, sj]];
  while (q.length) {
    const [i, j] = q.shift()!;
    const p = toP(i, j);
    if (goal(p)) return p;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di!, nj = j + dj!, k = key(ni, nj);
      if (seen.has(k)) continue;
      const np = toP(ni, nj);
      if (Math.abs(np.x) > hw || Math.abs(np.z) > hd || !free(np, p)) continue;
      seen.add(k); q.push([ni, nj]);
    }
  }
  return null;
}

for (const room of rooms) {
  for (const threat of [0, 1, 2]) {
    if (room.forgiving && threat > 1) continue;
    test(`${room.id}: route exists at threat ${threat} (in and out)`, () => {
      const r = new HeistRun(room);
      r.optics = solve(room);
      r.threat = threat;
      r.phase = "in";
      const prize = v2(room.prize.x, room.prize.z);
      const liftSpot = reachable(r, v2(room.spawn.x, room.spawn.z), (p) => Math.hypot(p.x - prize.x, p.z - prize.z) < STRETCH_MAX - 0.2);
      assert.ok(liftSpot, "spawn → prize");
      r.phase = "out"; r.prizeLifted = true; r.liftBeat = r.beat - 50;
      // The escape starts where Locke stood to make the lift.
      const start = liftSpot!;
      const exits = room.exits.filter((e) => e.phase === "out").map((e) => v2(e.x, e.z));
      assert.ok(exits.length > 0, "has an out exit");
      assert.ok(reachable(r, start, (p) => exits.some((e) => Math.hypot(p.x - e.x, p.z - e.z) < 0.85)), "prize → exit");
    });
  }
}

test("control: a wall-to-wall all-band Alert beam is caught as a soft-lock", () => {
  const room = structuredClone(rooms.find((r) => r.id === "room-zero")!);
  room.emitters.push({ id: "bad", type: "static", x: -6, z: 1.8, angle: 0, bands: ["low", "mid", "high"], threat: "alert", housing: "wall" });
  const r = new HeistRun(room);
  r.optics = solve(room); r.threat = 2; r.phase = "out"; r.prizeLifted = true; r.liftBeat = r.beat - 50;
  const exits = room.exits.map((e) => v2(e.x, e.z));
  assert.equal(reachable(r, v2(0, -2.4), (p) => exits.some((e) => Math.hypot(p.x - e.x, p.z - e.z) < 0.85)), null);
});
