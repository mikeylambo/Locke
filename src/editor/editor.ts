import * as THREE from "three";
import type { Band, BeamType, BlockDef, EmitterDef, ExitDef, MountDef, RoomDef, SensorDef } from "../sim/roomTypes";

/**
 * Dev-only room editor. Click to place, drag to move, Delete to remove, [ ] to rotate.
 * Every edit rebuilds the live room so beams, sensors and collision update instantly.
 */
export interface EditorHost {
  room(): RoomDef;
  apply(room: RoomDef): void;
  camera(): THREE.Camera;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  playtest(): void;
}

type Tool = "select" | "block" | "static" | "pulse" | "sweeper" | "mount" | "sensor" | "exit" | "spawn" | "prize";
type Sel = { kind: "block" | "emitter" | "mount" | "sensor" | "exit"; index: number } | { kind: "spawn" | "prize" } | null;

const TOOLS: Tool[] = ["select", "block", "static", "pulse", "sweeper", "mount", "sensor", "exit", "spawn", "prize"];
const SNAP = 0.05;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

export class RoomEditor {
  private panel: HTMLElement;
  private props: HTMLElement;
  private tool: Tool = "select";
  private sel: Sel = null;
  private dragging = false;
  private marker: THREE.Mesh;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private undo: string[] = [];
  active = true;

  constructor(private host: EditorHost) {
    this.panel = document.createElement("div");
    this.panel.className = "editor";
    this.panel.innerHTML = `
      <header>Room Editor <small>dev</small></header>
      <div class="tools">${TOOLS.map((t) => `<button data-tool="${t}">${t}</button>`).join("")}</div>
      <div class="props"></div>
      <div class="actions">
        <button data-act="play">Playtest</button>
        <button data-act="export">Export JSON</button>
        <button data-act="import">Import</button>
        <button data-act="undo">Undo</button>
      </div>
      <p class="help">Click floor to place · drag to move · Del removes · [ ] rotate 15° · Ctrl+Z undo</p>`;
    document.body.appendChild(this.panel);
    this.props = this.panel.querySelector(".props")!;
    this.panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    for (const b of Array.from(this.panel.querySelectorAll<HTMLButtonElement>("[data-tool]"))) b.addEventListener("click", () => this.setTool(b.dataset.tool as Tool));
    this.panel.querySelector('[data-act="play"]')!.addEventListener("click", () => this.host.playtest());
    this.panel.querySelector('[data-act="export"]')!.addEventListener("click", () => this.export());
    this.panel.querySelector('[data-act="import"]')!.addEventListener("click", () => this.import());
    this.panel.querySelector('[data-act="undo"]')!.addEventListener("click", () => this.popUndo());
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.38, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 1.6, 2.4), toneMapped: false, side: THREE.DoubleSide }));
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.position.y = 0.02;
    this.marker.visible = false;
    host.scene.add(this.marker);
    host.canvas.addEventListener("pointerdown", (e) => this.down(e));
    addEventListener("pointermove", (e) => this.move(e));
    addEventListener("pointerup", () => { this.dragging = false; });
    addEventListener("keydown", (e) => this.key(e));
    this.setTool("select");
  }

  show(v: boolean) { this.active = v; this.panel.style.display = v ? "" : "none"; this.marker.visible = v && !!this.sel; }

  private setTool(t: Tool) {
    this.tool = t;
    for (const b of Array.from(this.panel.querySelectorAll<HTMLElement>("[data-tool]"))) b.classList.toggle("on", b.dataset.tool === t);
  }

  private floor(e: PointerEvent): { x: number; z: number } | null {
    const r = this.host.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.host.camera());
    const p = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.plane, p)) return null;
    const room = this.host.room();
    const hw = room.size.w / 2, hd = room.size.d / 2;
    return { x: snap(Math.max(-hw, Math.min(hw, p.x))), z: snap(Math.max(-hd, Math.min(hd, p.z))) };
  }

  private commit(mut: (r: RoomDef) => void) {
    const room = this.host.room();
    this.undo.push(JSON.stringify(room));
    if (this.undo.length > 80) this.undo.shift();
    const next = structuredClone(room);
    mut(next);
    this.host.apply(next);
    this.renderProps();
  }

  private popUndo() {
    const prev = this.undo.pop();
    if (!prev) return;
    this.host.apply(JSON.parse(prev) as RoomDef);
    this.sel = null;
    this.renderProps();
  }

  private pick(p: { x: number; z: number }): Sel {
    const r = this.host.room();
    let best: Sel = null, bestD = 0.5;
    const test = (s: Sel, x: number, z: number, rad = 0.5) => { const d = Math.hypot(p.x - x, p.z - z); if (d < Math.min(bestD, rad)) { bestD = d; best = s; } };
    r.emitters.forEach((e, i) => test({ kind: "emitter", index: i }, e.x, e.z));
    r.mounts.forEach((m, i) => test({ kind: "mount", index: i }, m.x, m.z));
    r.sensors.forEach((s, i) => test({ kind: "sensor", index: i }, s.x, s.z));
    r.exits.forEach((x, i) => test({ kind: "exit", index: i }, x.x, x.z, 0.8));
    test({ kind: "spawn" }, r.spawn.x, r.spawn.z);
    test({ kind: "prize" }, r.prize.x, r.prize.z);
    if (!best) r.blocks.forEach((b, i) => { if (Math.abs(p.x - b.x) <= b.w / 2 && Math.abs(p.z - b.z) <= b.d / 2) best = { kind: "block", index: i }; });
    return best;
  }

  private down(e: PointerEvent) {
    if (!this.active || e.button !== 0) return;
    const p = this.floor(e);
    if (!p) return;
    if (this.tool === "select") {
      this.sel = this.pick(p);
      this.dragging = !!this.sel;
      if (this.dragging) this.undo.push(JSON.stringify(this.host.room()));
      this.renderProps();
      return;
    }
    const id = (prefix: string, list: Array<{ id: string }>) => { let n = list.length + 1; while (list.some((x) => x.id === `${prefix}${n}`)) n++; return `${prefix}${n}`; };
    this.commit((r) => {
      switch (this.tool) {
        case "block": r.blocks.push({ x: p.x, z: p.z, w: 0.8, d: 0.8, h: 1.0, style: "plinth" }); this.sel = { kind: "block", index: r.blocks.length - 1 }; break;
        case "static": case "pulse": case "sweeper": {
          const e: EmitterDef = { id: id(`${this.tool}-`, r.emitters), type: this.tool as BeamType, x: p.x, z: p.z, angle: 0, bands: ["mid"], note: 1 + (r.emitters.length % 7), housing: this.onWall(r, p) ? "wall" : "post" };
          if (this.tool === "pulse") e.pulse = { period: 2, duty: 0.5, offset: 0 };
          if (this.tool === "sweeper") { e.sweep = { speed: 30 }; e.range = 1.6; e.startOffset = 0.12; r.blocks.push({ x: p.x, z: p.z, w: 0.18, d: 0.18, h: 1.0, style: "post" }); }
          r.emitters.push(e); this.sel = { kind: "emitter", index: r.emitters.length - 1 }; break;
        }
        case "mount": r.mounts.push({ id: id("m", r.mounts), x: p.x, z: p.z }); this.sel = { kind: "mount", index: r.mounts.length - 1 }; break;
        case "sensor": { const sid = id("s", r.sensors); r.sensors.push({ id: sid, x: p.x, z: p.z }); r.blocks.push({ x: p.x, z: p.z, w: 0.3, d: 0.3, h: 1.2, style: "sensor" }); this.sel = { kind: "sensor", index: r.sensors.length - 1 }; break; }
        case "exit": { const wall = this.nearestWall(r, p); r.exits.push({ id: id("exit", r.exits), ...wall, phase: "out" }); this.sel = { kind: "exit", index: r.exits.length - 1 }; break; }
        case "spawn": r.spawn = { ...r.spawn, x: p.x, z: p.z }; this.sel = { kind: "spawn" }; break;
        case "prize": {
          const ped = r.blocks.find((b) => b.style === "pedestal");
          r.prize = { ...r.prize, x: p.x, z: p.z };
          if (ped) { ped.x = p.x; ped.z = p.z; } else r.blocks.push({ x: p.x, z: p.z, w: 0.7, d: 0.7, h: 0.95, style: "pedestal" });
          for (const e of r.emitters) if (e.phase === "out" && e.housing === "none") { e.x = p.x; e.z = p.z; }
          this.sel = { kind: "prize" }; break;
        }
      }
    });
    this.setTool("select");
  }

  private onWall(r: RoomDef, p: { x: number; z: number }) { return Math.abs(Math.abs(p.x) - r.size.w / 2) < 0.15 || Math.abs(Math.abs(p.z) - r.size.d / 2) < 0.15; }

  private nearestWall(r: RoomDef, p: { x: number; z: number }): Pick<ExitDef, "x" | "z" | "wall"> {
    const hw = r.size.w / 2, hd = r.size.d / 2;
    const c = [{ d: hw - p.x, wall: "e" as const, x: hw, z: p.z }, { d: p.x + hw, wall: "w" as const, x: -hw, z: p.z }, { d: hd - p.z, wall: "s" as const, x: p.x, z: hd }, { d: p.z + hd, wall: "n" as const, x: p.x, z: -hd }];
    c.sort((a, b) => a.d - b.d);
    const w = c[0]!;
    return { x: w.x, z: w.z, wall: w.wall };
  }

  private move(e: PointerEvent) {
    if (!this.active || !this.dragging || !this.sel) return;
    const p = this.floor(e);
    if (!p) return;
    const r = structuredClone(this.host.room());
    const s = this.sel;
    const shift = (o: { x: number; z: number }) => { const dx = p.x - o.x, dz = p.z - o.z; return { dx, dz }; };
    if (s.kind === "block") { const b = r.blocks[s.index]!; b.x = p.x; b.z = p.z; }
    else if (s.kind === "emitter") {
      const em = r.emitters[s.index]!; const { dx, dz } = shift(em);
      // Sweeper posts travel with their emitter.
      const post = r.blocks.find((b) => b.style === "post" && Math.abs(b.x - em.x) < 0.01 && Math.abs(b.z - em.z) < 0.01);
      if (post) { post.x += dx; post.z += dz; }
      em.x = p.x; em.z = p.z;
    }
    else if (s.kind === "mount") { const m = r.mounts[s.index]!; m.x = p.x; m.z = p.z; }
    else if (s.kind === "sensor") {
      const sn = r.sensors[s.index]!;
      const blk = r.blocks.find((b) => b.style === "sensor" && Math.abs(b.x - sn.x) < 0.01 && Math.abs(b.z - sn.z) < 0.01);
      if (blk) { blk.x = p.x; blk.z = p.z; }
      sn.x = p.x; sn.z = p.z;
    }
    else if (s.kind === "exit") { Object.assign(r.exits[s.index]!, this.nearestWall(r, p)); }
    else if (s.kind === "spawn") { r.spawn.x = p.x; r.spawn.z = p.z; }
    else if (s.kind === "prize") {
      const { dx, dz } = shift(r.prize);
      for (const b of r.blocks) if (b.style === "pedestal" && Math.abs(b.x - r.prize.x) < 0.01 && Math.abs(b.z - r.prize.z) < 0.01) { b.x += dx; b.z += dz; }
      for (const em of r.emitters) if (em.phase === "out" && em.housing === "none") { em.x += dx; em.z += dz; }
      r.prize.x = p.x; r.prize.z = p.z;
    }
    this.host.apply(r);
    this.updateMarker();
  }

  private key(e: KeyboardEvent) {
    if (!this.active || (e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); this.popUndo(); return; }
    const s = this.sel;
    if (!s) return;
    if (e.code === "Delete" || e.code === "Backspace") {
      e.preventDefault();
      if (s.kind === "spawn" || s.kind === "prize") return;
      const { kind, index } = s as { kind: "block" | "emitter" | "mount" | "sensor" | "exit"; index: number };
      this.commit((r) => {
        const list = { block: r.blocks, emitter: r.emitters, mount: r.mounts, sensor: r.sensors, exit: r.exits }[kind] as unknown[];
        list.splice(index, 1);
      });
      this.sel = null;
      this.renderProps();
    }
    if (e.code === "BracketLeft" || e.code === "BracketRight") {
      const d = e.code === "BracketLeft" ? -15 : 15;
      this.commit((r) => {
        if (s.kind === "emitter") r.emitters[s.index]!.angle = (r.emitters[s.index]!.angle + d + 360) % 360;
        if (s.kind === "spawn") r.spawn.facing = (r.spawn.facing + d + 360) % 360;
        if (s.kind === "block") { const b = r.blocks[s.index]!; [b.w, b.d] = [b.d, b.w]; }
      });
    }
  }

  private current(): Record<string, unknown> | null {
    const r = this.host.room(), s = this.sel;
    if (!s) return null;
    switch (s.kind) {
      case "block": return r.blocks[s.index] as unknown as Record<string, unknown>;
      case "emitter": return r.emitters[s.index] as unknown as Record<string, unknown>;
      case "mount": return r.mounts[s.index] as unknown as Record<string, unknown>;
      case "sensor": return r.sensors[s.index] as unknown as Record<string, unknown>;
      case "exit": return r.exits[s.index] as unknown as Record<string, unknown>;
      case "spawn": return r.spawn as unknown as Record<string, unknown>;
      case "prize": return r.prize as unknown as Record<string, unknown>;
    }
  }

  private updateMarker() {
    const cur = this.current();
    this.marker.visible = this.active && !!cur;
    if (cur) this.marker.position.set(Number(cur.x ?? 0), 0.02, Number(cur.z ?? 0));
  }

  /** Property sheet: edit any field of the selection, or room-level settings when nothing is selected. */
  private renderProps() {
    this.updateMarker();
    const r = this.host.room();
    const cur = this.current();
    const target: Record<string, unknown> = cur ?? { id: r.id, name: r.name, headline: r.headline, tempo: r.tempo, parTime: r.parTime, keyRoot: r.key.root, keyMode: r.key.mode, belt: r.belt.join(",") };
    const rows = Object.entries(target).map(([k, v]) => {
      if (Array.isArray(v) && k === "bands") return `<label>${k}<span class="bands">${(["low", "mid", "high"] as Band[]).map((b) => `<input type="checkbox" data-band="${b}" ${(v as Band[]).includes(b) ? "checked" : ""}>${b}`).join("")}</span></label>`;
      if (v && typeof v === "object") return `<label>${k}<input data-k="${k}" data-json value='${JSON.stringify(v)}'></label>`;
      return `<label>${k}<input data-k="${k}" value="${String(v ?? "")}"></label>`;
    });
    const extras = cur && this.sel?.kind === "emitter" ? `<div class="hintline">poweredBy · threat · phase · pulse · sweep · range · tint: edit as JSON below</div><label>extra<input data-k="__extra" data-json value='${JSON.stringify({ poweredBy: target.poweredBy, threat: target.threat, phase: target.phase, tint: target.tint })}'></label>` : "";
    this.props.innerHTML = `<h4>${this.sel ? this.sel.kind : "room"}</h4>${rows.join("")}${extras}`;
    for (const inp of Array.from(this.props.querySelectorAll<HTMLInputElement>("input[data-k]"))) {
      inp.addEventListener("change", () => this.commit((rr) => {
        const k = inp.dataset.k!;
        let val: unknown = inp.value;
        if (inp.dataset.json !== undefined) { try { val = JSON.parse(inp.value); } catch { return; } }
        else if (inp.value.trim() !== "" && !Number.isNaN(Number(inp.value))) val = Number(inp.value);
        const obj = this.selIn(rr);
        if (!obj) {
          if (k === "keyRoot") rr.key.root = String(val); else if (k === "keyMode") rr.key.mode = val as RoomDef["key"]["mode"];
          else if (k === "belt") rr.belt = String(val).split(",").map((x) => x.trim()).filter(Boolean) as RoomDef["belt"];
          else (rr as unknown as Record<string, unknown>)[k] = val;
          return;
        }
        if (k === "__extra") { for (const [ek, ev] of Object.entries(val as object)) { if (ev === undefined || ev === null || ev === "") delete obj[ek]; else obj[ek] = ev; } return; }
        obj[k] = val;
      }));
    }
    for (const cb of Array.from(this.props.querySelectorAll<HTMLInputElement>("input[data-band]"))) {
      cb.addEventListener("change", () => this.commit((rr) => {
        const obj = this.selIn(rr) as unknown as EmitterDef;
        const bands = (["low", "mid", "high"] as Band[]).filter((b) => (this.props.querySelector<HTMLInputElement>(`input[data-band="${b}"]`)!).checked);
        obj.bands = bands.length ? bands : ["mid"];
      }));
    }
  }

  private selIn(r: RoomDef): Record<string, unknown> | null {
    const s = this.sel;
    if (!s) return null;
    const pick: Record<string, () => unknown> = {
      block: () => r.blocks[(s as { index: number }).index], emitter: () => r.emitters[(s as { index: number }).index], mount: () => r.mounts[(s as { index: number }).index],
      sensor: () => r.sensors[(s as { index: number }).index], exit: () => r.exits[(s as { index: number }).index], spawn: () => r.spawn, prize: () => r.prize
    };
    return (pick[s.kind]?.() as Record<string, unknown>) ?? null;
  }

  private export() {
    const json = JSON.stringify(this.host.room(), null, 2);
    void navigator.clipboard?.writeText(json).catch(() => {});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = `${this.host.room().id}.json`;
    a.click();
  }

  private import() {
    const text = prompt("Paste room JSON");
    if (!text) return;
    try { const r = JSON.parse(text) as RoomDef; this.undo.push(JSON.stringify(this.host.room())); this.host.apply(r); this.sel = null; this.renderProps(); }
    catch (err) { alert(`Invalid room JSON: ${(err as Error).message}`); }
  }
}

export type { BlockDef, MountDef, SensorDef };
