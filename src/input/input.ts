import { InputManager } from "@slu/web-shell";

export type Device = "kbm" | "pad" | "touch";

export interface InputFrame {
  /** Screen-relative move: x right, y forward (away from camera). |v| ≤ 1. */
  move: { x: number; y: number };
  stretch: boolean;
  crouch: boolean; flatten: boolean; interact: boolean; rotate: number; cycle: boolean;
  restart: boolean; pause: boolean; rewind: boolean;
  orbit: { dx: number; dy: number }; orbiting: boolean; snap: number;
  ui: { up: boolean; down: boolean; left: boolean; right: boolean; confirm: boolean; back: boolean };
  any: boolean;
}

const ACTIONS = ["rewind", "stretch", "crouch", "flatten", "interact", "rotL", "rotR", "cycle", "restart", "pause", "uiUp", "uiDown", "uiLeft", "uiRight", "uiConfirm", "uiBack", "snapL", "snapR"] as const;
type Action = (typeof ACTIONS)[number];

const KEYS: Record<Action, string[]> = {
  rewind: ["Backspace", "KeyT"], stretch: ["Space"], crouch: ["KeyC", "ControlLeft"], flatten: ["KeyF"], interact: ["Enter", "KeyX"], rotL: ["KeyQ"], rotR: ["KeyE"],
  cycle: ["Tab"], restart: ["KeyR"], pause: ["Escape", "KeyP"],
  uiUp: ["ArrowUp", "KeyW"], uiDown: ["ArrowDown", "KeyS"], uiLeft: ["ArrowLeft", "KeyA"], uiRight: ["ArrowRight", "KeyD"],
  uiConfirm: ["Enter", "Space"], uiBack: ["Escape", "Backspace"], snapL: ["KeyZ"], snapR: ["KeyV"]
};
// Standard gamepad mapping.
const PAD: Partial<Record<Action, number[]>> = {
  rewind: [6], stretch: [7], crouch: [1], flatten: [3], interact: [0], rotL: [4], rotR: [5], cycle: [2], restart: [8], pause: [9],
  uiUp: [12], uiDown: [13], uiLeft: [14], uiRight: [15], uiConfirm: [0], uiBack: [1]
};

export class Input {
  readonly mgr = new InputManager();
  device: Device = "kbm";
  private keys = new Set<string>();
  private tapped = new Set<string>();
  private mouseLeftPulse = false;
  private wheelPulse = 0;
  private drag = { active: false, x: 0, y: 0, dx: 0, dy: 0 };
  private touch = { stick: null as null | { id: number; ox: number; oy: number; x: number; y: number }, buttons: new Map<string, boolean>(), pulses: new Set<string>(), orbit: null as null | { ids: number[]; x: number; y: number }, odx: 0, ody: 0 };
  private padPrevAxes = { x: 0, y: 0 };
  private listeners: Array<(d: Device) => void> = [];
  readonly touchLayer: HTMLElement;
  private stickEl: HTMLElement;
  private knobEl: HTMLElement;
  sensitivity = 1;
  enabled = true;

  constructor(private canvas: HTMLCanvasElement, root: HTMLElement) {
    this.mgr.setBindings(ACTIONS.map((a) => ({ action: a })));
    addEventListener("keydown", (e) => {
      if (e.code === "Tab") e.preventDefault();
      if (e.code === "Space" && document.activeElement === document.body) e.preventDefault();
      if (!e.repeat) this.tapped.add(e.code);
      this.keys.add(e.code); this.setDevice("kbm");
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("mousedown", (e) => {
      this.setDevice("kbm");
      if (e.button === 0) this.mouseLeftPulse = true;
      if (e.button === 2 || e.button === 1) { this.drag.active = true; this.drag.x = e.clientX; this.drag.y = e.clientY; }
    });
    addEventListener("mousemove", (e) => {
      if (!this.drag.active) return;
      this.drag.dx += e.clientX - this.drag.x; this.drag.dy += e.clientY - this.drag.y;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
    });
    addEventListener("mouseup", (e) => { if (e.button === 2 || e.button === 1) this.drag.active = false; });
    canvas.addEventListener("wheel", (e) => { this.wheelPulse = Math.sign(e.deltaY); }, { passive: true });

    // Touch layer: floating stick (left), action cluster (right).
    this.touchLayer = document.createElement("div");
    this.touchLayer.id = "touch";
    this.touchLayer.innerHTML = `
      <div class="t-stick"><div class="t-knob"></div></div>
      <div class="t-cluster">
        <button data-b="stretch" class="t-btn t-hand" aria-label="Stretch">${ICON.hand}</button>
        <button data-b="interact" class="t-btn t-act" aria-label="Use">${ICON.act}</button>
        <button data-b="crouch" class="t-btn t-crouch" aria-label="Crouch">${ICON.crouch}</button>
        <button data-b="flatten" class="t-btn t-flat" aria-label="Flatten">${ICON.flat}</button>
        <button data-b="rotL" class="t-btn t-rl" aria-label="Rotate left">${ICON.rotL}</button>
        <button data-b="rotR" class="t-btn t-rr" aria-label="Rotate right">${ICON.rotR}</button>
      </div>
      <div class="t-top">
        <button data-b="rewind" class="t-btn t-small" aria-label="Rewind">${ICON.rewind}</button>
        <button data-b="restart" class="t-btn t-small" aria-label="Restart">${ICON.restart}</button>
        <button data-b="pause" class="t-btn t-small" aria-label="Pause">${ICON.pause}</button>
      </div>`;
    root.appendChild(this.touchLayer);
    this.stickEl = this.touchLayer.querySelector(".t-stick")!;
    this.knobEl = this.touchLayer.querySelector(".t-knob")!;
    for (const btn of Array.from(this.touchLayer.querySelectorAll<HTMLButtonElement>("button[data-b]"))) {
      const b = btn.dataset.b!;
      btn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.touch.buttons.set(b, true); this.touch.pulses.add(b); btn.classList.add("down"); btn.setPointerCapture(e.pointerId); });
      const up = () => { this.touch.buttons.set(b, false); btn.classList.remove("down"); };
      btn.addEventListener("pointerup", up); btn.addEventListener("pointercancel", up);
    }
    canvas.addEventListener("touchstart", (e) => this.onTouch(e, "start"), { passive: false });
    canvas.addEventListener("touchmove", (e) => this.onTouch(e, "move"), { passive: false });
    canvas.addEventListener("touchend", (e) => this.onTouch(e, "end"), { passive: false });
    canvas.addEventListener("touchcancel", (e) => this.onTouch(e, "end"), { passive: false });
    addEventListener("touchstart", () => this.setDevice("touch"), { passive: true });
  }

  onDevice(f: (d: Device) => void) { this.listeners.push(f); }
  private setDevice(d: Device) {
    if (this.device === d) return;
    this.device = d;
    document.documentElement.dataset.device = d;
    for (const f of this.listeners) f(d);
  }

  private onTouch(e: TouchEvent, kind: "start" | "move" | "end") {
    e.preventDefault();
    this.setDevice("touch");
    const T = this.touch;
    if (e.touches.length >= 2) {
      // Two-finger drag orbits.
      const a = e.touches[0]!, b = e.touches[1]!;
      const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
      if (!T.orbit) T.orbit = { ids: [a.identifier, b.identifier], x: cx, y: cy };
      else { T.odx += cx - T.orbit.x; T.ody += cy - T.orbit.y; T.orbit.x = cx; T.orbit.y = cy; }
      if (T.stick) { T.stick = null; this.stickEl.classList.remove("on"); }
      return;
    }
    if (T.orbit && e.touches.length < 2) T.orbit = null;
    for (const t of Array.from(e.changedTouches)) {
      if (kind === "start" && !T.stick && t.clientX < innerWidth * 0.6) {
        T.stick = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY };
        this.stickEl.style.left = `${t.clientX}px`; this.stickEl.style.top = `${t.clientY}px`;
        this.stickEl.classList.add("on");
      } else if (T.stick && t.identifier === T.stick.id) {
        if (kind === "end") { T.stick = null; this.stickEl.classList.remove("on"); this.knobEl.style.transform = ""; }
        else { T.stick.x = t.clientX; T.stick.y = t.clientY; }
      }
    }
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  poll(): InputFrame {
    const raw = new Map<string, number>();
    const set = (a: Action, v: boolean) => { if (v) raw.set(a, 1); };
    for (const a of ACTIONS) set(a, KEYS[a].some((k) => this.keys.has(k) || this.tapped.has(k)));
    this.tapped.clear();
    if (this.mouseLeftPulse) raw.set("interact", 1);
    if (this.wheelPulse) raw.set("cycle", 1);
    for (const [b, v] of this.touch.buttons) if (v || this.touch.pulses.has(b)) raw.set(b, 1);

    let mx = 0, my = 0;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) mx -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) mx += 1;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) my += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) my -= 1;
    const kl = Math.hypot(mx, my);
    if (kl > 1) { mx /= kl; my /= kl; }
    // Shift walks slowly for precision threading.
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) { mx *= 0.45; my *= 0.45; }

    let odx = this.drag.dx * 0.006, ody = this.drag.dy * 0.004;
    this.drag.dx = this.drag.dy = 0;
    let orbiting = this.drag.active;

    const gp = this.pad();
    let snap = 0;
    if (gp) {
      for (const a of ACTIONS) for (const i of PAD[a] ?? []) {
        const b = gp.buttons[i];
        if (b && (b.pressed || b.value > 0.5)) { raw.set(a, 1); this.setDevice("pad"); }
      }
      const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
      const l = Math.hypot(ax, ay);
      if (l > 0.2) {
        const s = Math.min(1, (l - 0.2) / 0.75) / l;
        mx = ax * s; my = -ay * s; this.setDevice("pad");
        // Left stick also drives menus.
        if (ay < -0.6 && this.padPrevAxes.y >= -0.6) raw.set("uiUp", 1);
        if (ay > 0.6 && this.padPrevAxes.y <= 0.6) raw.set("uiDown", 1);
        if (ax < -0.6 && this.padPrevAxes.x >= -0.6) raw.set("uiLeft", 1);
        if (ax > 0.6 && this.padPrevAxes.x <= 0.6) raw.set("uiRight", 1);
      }
      this.padPrevAxes = { x: ax, y: ay };
      const rx = gp.axes[2] ?? 0, ry = gp.axes[3] ?? 0;
      if (Math.hypot(rx, ry) > 0.22) { odx += rx * 0.045; ody += ry * 0.025; orbiting = true; }
      if (gp.buttons[10]?.pressed) snap = 0; // L3 reserved
    }
    if (this.touch.stick) {
      const s = this.touch.stick;
      let dx = s.x - s.ox, dy = s.y - s.oy;
      const l = Math.hypot(dx, dy), R = 56;
      if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
      this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
      if (l > 6) { mx = dx / R; my = -dy / R; }
    }
    if (this.touch.orbit) orbiting = true;
    odx += this.touch.odx * 0.008; ody += this.touch.ody * 0.005;
    this.touch.odx = this.touch.ody = 0;

    this.mgr.update(raw as Map<string, number>);
    this.mouseLeftPulse = false;
    this.wheelPulse = 0;
    this.touch.pulses.clear();
    const p = (a: Action) => this.mgr.wasPressed(a);
    const d = (a: Action) => this.mgr.isDown(a);
    if (p("snapL")) snap = -1;
    if (p("snapR")) snap = 1;
    const any = ACTIONS.some((a) => p(a)) || Math.hypot(mx, my) > 0.3;
    if (!this.enabled) return { move: { x: 0, y: 0 }, stretch: false, crouch: false, flatten: false, interact: false, rotate: 0, cycle: false, restart: false, pause: p("pause"), rewind: false, orbit: { dx: 0, dy: 0 }, orbiting: false, snap: 0, ui: { up: p("uiUp"), down: p("uiDown"), left: p("uiLeft"), right: p("uiRight"), confirm: p("uiConfirm"), back: p("uiBack") }, any };
    return {
      move: { x: mx, y: my },
      stretch: d("stretch"),
      crouch: p("crouch"), flatten: p("flatten"), interact: p("interact"),
      rotate: (p("rotR") ? 1 : 0) - (p("rotL") ? 1 : 0), cycle: p("cycle"),
      restart: p("restart"), pause: p("pause"), rewind: d("rewind"),
      orbit: { dx: odx * this.sensitivity, dy: ody * this.sensitivity }, orbiting, snap,
      ui: { up: p("uiUp"), down: p("uiDown"), left: p("uiLeft"), right: p("uiRight"), confirm: p("uiConfirm"), back: p("uiBack") },
      any
    };
  }

  rumble(strength: number, ms: number) {
    const gp = this.pad() as (Gamepad & { vibrationActuator?: { playEffect: (t: string, o: object) => Promise<unknown> } }) | null;
    gp?.vibrationActuator?.playEffect("dual-rumble", { duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.6 }).catch(() => {});
    if (this.device === "touch") navigator.vibrate?.(Math.min(ms, 60));
  }
}

const svg = (d: string) => `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const ICON = {
  hand: svg("M16 28c-3-1-6-4-6-8 0-2 2-3 4-2l4 3V9c0-2 1-3 3-3s3 1 3 3v9V7c0-2 1-3 3-3s3 1 3 3v11-8c0-2 1-3 3-3s3 1 3 3v15c0 9-5 15-13 15-6 0-9-3-11-6"),
  act: svg("M24 8v6M24 34v6M8 24h6M34 24h6M24 18a6 6 0 1 1 0 12 6 6 0 0 1 0-12"),
  crouch: svg("M24 10a4 4 0 1 1 0 .1M14 38l6-10 8 2 6 8M20 28l-2-8 10 0 4 6"),
  flat: svg("M22 6h4v36h-4zM16 14l-4 10 4 10M32 14l4 10-4 10"),
  rotL: svg("M14 18a12 12 0 1 1-2 12M14 8v10h10"),
  rotR: svg("M34 18a12 12 0 1 0 2 12M34 8v10H24"),
  restart: svg("M12 24a12 12 0 1 0 4-9M12 8v8h8"),
  pause: svg("M18 12v24M30 12v24"),
  rewind: svg("M24 14L10 24l14 10zM38 14L24 24l14 10z"),
  mirror: svg("M24 6c7 0 10 7 10 16s-3 16-10 16-10-7-10-16S17 6 24 6zM24 38v6M16 44h16M19 14l4-3"),
  retro: svg("M24 10l12 20H12zM24 10v-4M18 24l6-4 6 4"),
  splitter: svg("M12 12h24v24H12zM12 12l24 24"),
  crown: `<svg viewBox="0 0 48 32" aria-hidden="true"><path d="M4 28h40L40 8l-9 9-7-13-7 13-9-9z" fill="currentColor"/></svg>`
};
