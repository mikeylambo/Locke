import { test } from "vitest";
import { readFileSync } from "node:fs";
import { HeistRun, emptyInput } from "../src/sim/run";
import { v2 } from "../src/sim/math2d";
const load = (id: string) => JSON.parse(readFileSync(new URL(`../src/rooms/${id}.json`, import.meta.url), "utf8"));
test("dbg", () => {
  const g = new HeistRun(load("mus-6"));
  g.locke.pos = v2(-6.9, 3.98); g.phase = "in";
  console.log(g.stairHere(), g.targetMount(), g.canGrabPrize());
  const ev = g.step({ ...emptyInput(), interact: true });
  console.log(ev.map(e => e.type), g.locke.floor);
});
