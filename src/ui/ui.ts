import { ICON, type Device, type InputFrame } from "../input/input";
import type { OpticKind } from "../sim/roomTypes";

export interface MenuItem {
  id: string;
  label: string;
  kind?: "button" | "slider" | "toggle" | "choice";
  get?: () => number | boolean | string;
  set?: (v: number | boolean | string) => void;
  choices?: string[];
  action?: () => void;
  disabled?: boolean;
}

type Sound = (id: string) => void;

const GLYPHS: Record<Device, Record<string, string>> = {
  kbm: { move: "WASD", stretch: "Space", crouch: "C", flatten: "F", interact: "Click", rotate: "Q / E", rotL: "Q", rotR: "E", restart: "R", orbit: "Right-drag", cycle: "Tab", rewind: "T", taunt: "G" },
  pad: { move: "L", stretch: "RT", crouch: "B", flatten: "Y", interact: "A", rotate: "LB / RB", rotL: "LB", rotR: "RB", restart: "View", orbit: "R Stick", cycle: "X", rewind: "LT", taunt: "D-pad ↑" },
  touch: { move: "Drag", stretch: "Hand", crouch: "Crouch", flatten: "Flat", interact: "Use", rotate: "Twist", rotL: "⟲", rotR: "⟳", restart: "↺", orbit: "Two fingers", cycle: "", rewind: "", taunt: "Cigar" }
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

/** Menu with keyboard, gamepad, mouse and touch navigation sharing one focus. */
class Menu {
  readonly root: HTMLElement;
  private rows: Array<{ item: MenuItem; row: HTMLElement; value?: HTMLElement }> = [];
  focus = 0;
  constructor(items: MenuItem[], private sound: Sound) {
    this.root = el("div", "menu");
    items.forEach((item, i) => {
      const row = el("button", `menu-row kind-${item.kind ?? "button"}`);
      row.type = "button";
      row.innerHTML = `<span class="label">${item.label}</span>`;
      let value: HTMLElement | undefined;
      if (item.kind && item.kind !== "button") {
        value = el("span", "value");
        row.appendChild(value);
      }
      if (item.disabled) row.classList.add("disabled");
      row.addEventListener("pointerenter", () => this.setFocus(i, false));
      row.addEventListener("click", (e) => {
        this.setFocus(i, false);
        if (item.kind === "slider") {
          const r = row.getBoundingClientRect();
          const t = (e.clientX - r.left - r.width * 0.45) / (r.width * 0.5);
          if (t >= 0) { item.set?.(Math.round(Math.max(0, Math.min(1, t)) * 10) / 10); this.refresh(); this.sound("ui.move"); return; }
        }
        this.activate();
      });
      this.root.appendChild(row);
      this.rows.push({ item, row, value });
    });
    this.refresh();
    this.setFocus(0, false);
  }
  setFocus(i: number, sound = true) {
    const n = this.rows.length;
    let k = ((i % n) + n) % n, guard = 0;
    while (this.rows[k]!.item.disabled && guard++ < n) k = (k + (i >= this.focus ? 1 : -1) + n) % n;
    if (sound && k !== this.focus) this.sound("ui.move");
    this.focus = k;
    this.rows.forEach((r, j) => r.row.classList.toggle("focus", j === k));
  }
  refresh() {
    for (const r of this.rows) {
      const it = r.item;
      if (!r.value || !it.get) continue;
      const v = it.get();
      if (it.kind === "slider") r.value.innerHTML = `<span class="bar"><span style="width:${Math.round((v as number) * 100)}%"></span></span>`;
      else if (it.kind === "toggle") r.value.textContent = v ? "On" : "Off";
      else r.value.textContent = String(v);
    }
  }
  activate() {
    const it = this.rows[this.focus]!.item;
    if (it.disabled) return;
    if (it.kind === "toggle") { it.set?.(!it.get?.()); this.refresh(); this.sound("ui.move"); return; }
    if (it.kind === "choice") { this.adjust(1); return; }
    if (it.kind === "slider") return;
    this.sound("ui.confirm");
    it.action?.();
  }
  adjust(dir: number) {
    const it = this.rows[this.focus]!.item;
    if (it.kind === "slider") { const v = it.get!() as number; it.set!(Math.round(Math.max(0, Math.min(1, v + dir * 0.1)) * 10) / 10); }
    else if (it.kind === "toggle") it.set!(!it.get!());
    else if (it.kind === "choice" && it.choices) { const v = it.get!() as string; const i = it.choices.indexOf(v); it.set!(it.choices[(i + dir + it.choices.length) % it.choices.length]!); }
    else return;
    this.refresh();
    this.sound("ui.move");
  }
  handle(f: InputFrame): boolean {
    if (f.ui.up) this.setFocus(this.focus - 1);
    if (f.ui.down) this.setFocus(this.focus + 1);
    if (f.ui.left) this.adjust(-1);
    if (f.ui.right) this.adjust(1);
    if (f.ui.confirm || f.interact) { this.activate(); return true; }
    return false;
  }
}

export interface ResultsData {
  headline: string; prize: string; time: number; par: number; alarms: number; clearance: number; value: number; grade: string; best: boolean; photo?: string; mini?: boolean;
}

export class UI {
  readonly root: HTMLElement;
  private layer: HTMLElement;
  private hud: HTMLElement;
  private screen: { el: HTMLElement; menu?: Menu; back?: () => void } | null = null;
  private stack: Array<{ el: HTMLElement; menu?: Menu; back?: () => void }> = [];
  private timerEl!: HTMLElement;
  private lamps: HTMLElement[] = [];
  private stateEl!: HTMLElement;
  private beatEl!: HTMLElement;
  private beltEl!: HTMLElement;
  private meterEl!: HTMLElement;
  private meterFill!: HTMLElement;
  private promptEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private flashEl!: HTMLElement;
  private eyeEl!: HTMLElement;
  private toastEl!: HTMLElement;
  device: Device = "kbm";

  constructor(root: HTMLElement, private sound: Sound) {
    this.root = root;
    this.hud = el("div", "hud hidden");
    this.layer = el("div", "screens");
    root.append(this.hud, this.layer);
    this.buildHud();
  }

  private buildHud() {
    const h = this.hud;
    const tl = el("div", "hud-tl deco-frame");
    this.eyeEl = el("span", "eye", `<svg viewBox="0 0 48 28"><path d="M2 14C10 4 38 4 46 14 38 24 10 24 2 14z" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="24" cy="14" r="6" fill="currentColor"/></svg>`);
    this.timerEl = el("span", "timer", "0:00.00");
    this.beatEl = el("span", "beat");
    const row = el("div", "timer-row");
    row.append(this.eyeEl, this.timerEl, this.beatEl);
    const lamps = el("div", "lamps");
    for (let i = 0; i < 3; i++) { const l = el("span", `lamp lamp-${i}`); lamps.appendChild(l); this.lamps.push(l); }
    this.stateEl = el("span", "threat-word");
    lamps.appendChild(this.stateEl);
    tl.append(row, lamps);
    this.beltEl = el("div", "hud-tr belt deco-frame");
    this.meterEl = el("div", "meter");
    this.meterFill = el("div", "meter-fill");
    this.meterEl.append(el("span", "meter-cap l"), this.meterFill, el("span", "meter-cap r"));
    this.promptEl = el("div", "prompt");
    this.hintEl = el("div", "hint deco-frame");
    this.flashEl = el("div", "flash");
    this.toastEl = el("div", "toast");
    this.coachEl = el("div", "speech");
    this.noteEl = el("div", "blueprint");
    h.append(this.flashEl, tl, this.beltEl, this.meterEl, this.promptEl, this.coachEl, this.toastEl, this.noteEl);
  }

  private noteEl!: HTMLElement;
  /** The designer's aged blueprint card: shown while casing, folds away once the clock runs. */
  blueprint(note: { title: string; note: string; author: string; obscura?: string } | null, show: boolean) {
    const html = note ? `<div class="bp-title">${note.title}</div><div class="bp-note">“${note.note}”</div><div class="bp-author">— ${note.author}</div>${note.obscura ? `<div class="bp-hint">${note.obscura}</div>` : ""}` : "";
    if (this.noteEl.dataset.h !== html) { this.noteEl.innerHTML = html; this.noteEl.dataset.h = html; }
    this.noteEl.classList.toggle("show", !!note && show);
  }

  setDevice(d: Device) { this.device = d; this.renderHint(); }

  /** Button label for an action on the active device. */
  glyph(action: string): string { return GLYPHS[this.device][action] ?? action; }

  private coachEl!: HTMLElement;
  /** Locke talking himself through it: a short line beside him, with the button small next to it. */
  speech(s: { x: number; y: number; text: string; glyph?: string } | null) {
    if (!s) { this.coachEl.classList.remove("show"); return; }
    this.coachEl.style.transform = `translate(${s.x}px, ${s.y}px)`;
    const html = `<span class="say">${s.text}</span>${s.glyph ? `<kbd>${s.glyph}</kbd>` : ""}`;
    if (this.coachEl.dataset.h !== html) {
      this.coachEl.innerHTML = html; this.coachEl.dataset.h = html;
      this.coachEl.classList.remove("show"); void this.coachEl.offsetWidth;
    }
    this.coachEl.classList.add("show");
  }

  private renderHint() {
    const g = GLYPHS[this.device];
    const rows: Array<[string, string]> = [["Move", g.move!], ["Stretch", g.stretch!], ["Crouch", g.crouch!], ["Flatten", g.flatten!], ["Use", g.interact!], ["Rotate", g.rotate!], ["Rewind", g.rewind!], ["Look", g.orbit!]];
    this.hintEl.innerHTML = rows.map(([a, k]) => `<div><kbd>${k}</kbd><span>${a}</span></div>`).join("");
  }

  showHud(v: boolean) { this.hud.classList.toggle("hidden", !v); document.documentElement.dataset.hud = v ? "1" : "0"; }
  showHint(v: boolean) { this.hintEl.classList.toggle("show", v); }

  hudFrame(s: { time: number; casing: boolean; threat: number; beat: number; belt: OpticKind[]; selected: number; stretch: number | null; prompt: { x: number; y: number; verb: string } | null; reduced: boolean }) {
    const t = s.time;
    const m = Math.floor(t / 60), sec = t - m * 60;
    this.timerEl.textContent = `${m}:${sec.toFixed(2).padStart(5, "0")}`;
    this.eyeEl.classList.toggle("on", s.casing);
    this.timerEl.classList.toggle("dim", s.casing);
    const ph = s.beat % 1;
    this.beatEl.style.transform = `rotate(45deg) scale(${1 + (s.reduced ? 0 : Math.max(0, 1 - ph * 4)) * 0.6})`;
    this.beatEl.classList.toggle("down", Math.floor(s.beat) % 4 === 0 && ph < 0.25);
    this.lamps.forEach((l, i) => l.classList.toggle("lit", s.threat > i));
    this.stateEl.textContent = ["", "Disturbed", "Alert", "Lockdown"][s.threat] ?? "";
    this.hud.dataset.threat = String(s.threat);
    const beltHtml = [0, 1, 2, 3].map((i) => {
      const k = s.belt[i];
      return `<span class="slot ${k ? "full" : ""} ${i === s.selected && k ? "sel" : ""}">${k ? ICON[k as "mirror"] ?? ICON.mirror : ""}</span>`;
    }).join("");
    if (this.beltEl.dataset.k !== beltHtml) { this.beltEl.innerHTML = beltHtml; this.beltEl.dataset.k = beltHtml; }
    this.meterEl.classList.toggle("show", s.stretch !== null);
    if (s.stretch !== null) { this.meterFill.style.transform = `scaleX(${Math.max(0, s.stretch)})`; this.meterEl.classList.toggle("low", s.stretch < 0.25); }
    if (s.prompt) {
      this.promptEl.classList.add("show");
      this.promptEl.style.transform = `translate(${s.prompt.x}px, ${s.prompt.y}px)`;
      const html = `<kbd>${GLYPHS[this.device].interact}</kbd>${s.prompt.verb}`;
      if (this.promptEl.innerHTML !== html) this.promptEl.innerHTML = html;
    } else this.promptEl.classList.remove("show");
  }

  flash(kind: "contact" | "lift" | "solve" | "escape") {
    this.flashEl.className = "flash";
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add(`f-${kind}`);
  }

  toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove("show");
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add("show");
  }

  // ——— Screens ———
  get open() { return !!this.screen; }

  private present(node: HTMLElement, menu?: Menu, back?: () => void, push = false) {
    if (this.screen && push) this.stack.push(this.screen);
    else if (this.screen) this.screen.el.remove();
    if (push && this.stack.length) this.stack[this.stack.length - 1]!.el.classList.add("behind");
    this.screen = { el: node, menu, back };
    this.guardUntil = performance.now() + 280;
    this.layer.appendChild(node);
    requestAnimationFrame(() => node.classList.add("in"));
  }

  close() {
    if (!this.screen) return;
    const s = this.screen;
    s.el.classList.remove("in");
    s.el.classList.add("out");
    setTimeout(() => s.el.remove(), 260);
    this.screen = this.stack.pop() ?? null;
    this.screen?.el.classList.remove("behind");
  }

  closeAll() { while (this.screen) this.close(); }

  private guardUntil = 0;

  handle(f: InputFrame) {
    if (!this.screen || performance.now() < this.guardUntil) return;
    if (f.ui.back && this.screen.back) { this.sound("ui.back"); this.screen.back(); return; }
    this.screen.menu?.handle(f);
  }

  title(onStart: () => void, onSettings: () => void, best: string | null) {
    const node = el("div", "screen title-screen");
    node.innerHTML = `
      <div class="logo">
        <div class="crown">${ICON.crown}</div>
        <h1><span>Light</span><span>Fingers</span></h1>
        <div class="rule"><i></i><b></b><i></i></div>
        <p class="tag">A Lockestep heist</p>
      </div>`;
    const menu = new Menu([
      { id: "play", label: best ? "Play" : "Begin the Heist", action: onStart },
      { id: "settings", label: "Settings", action: onSettings }
    ], this.sound);
    node.appendChild(menu.root);
    if (best) node.appendChild(el("div", "best", `<span>Best</span> ${best}`));
    this.present(node, menu);
  }

  pause(onResume: () => void, onRestart: () => void, onSettings: () => void, onQuit: () => void) {
    const node = el("div", "screen pause-screen");
    node.innerHTML = `<div class="card deco-frame"><h2>Paused</h2></div>`;
    const menu = new Menu([
      { id: "resume", label: "Resume", action: onResume },
      { id: "restart", label: "Restart", action: onRestart },
      { id: "settings", label: "Settings", action: onSettings },
      { id: "quit", label: "Leave the Vault", action: onQuit }
    ], this.sound);
    node.querySelector(".card")!.appendChild(menu.root);
    this.present(node, menu, onResume);
  }

  settings(items: MenuItem[], onBack: () => void) {
    const node = el("div", "screen settings-screen");
    node.innerHTML = `<div class="card deco-frame wide"><h2>Settings</h2></div>`;
    const menu = new Menu([...items, { id: "back", label: "Back", action: onBack }], this.sound);
    node.querySelector(".card")!.appendChild(menu.root);
    this.present(node, menu, onBack, true);
  }

  caught() {
    const node = el("div", "screen caught-screen");
    node.innerHTML = `<div class="caught-card"><div class="stamp">Foiled</div></div>`;
    this.present(node);
  }

  results(r: ResultsData, onAgain: () => void, onTitle: () => void, onNext?: () => void) {
    if (r.mini) return this.miniResults(r, onAgain, onNext ?? onTitle);
    const node = el("div", "screen results-screen");
    const fmt = (t: number) => { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(2).padStart(5, "0")}`; };
    const money = "$" + r.value.toLocaleString("en-US");
    const clr = Number.isFinite(r.clearance) ? `${Math.max(0, Math.round(r.clearance * 100))} cm` : "—";
    const date = new Date();
    node.innerHTML = `
      <article class="paper">
        <header class="mast">
          <span class="ear">Late Edition</span>
          <h3>Extra!</h3>
          <span class="ear">${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, 1934</span>
        </header>
        <h1 class="headline">${r.headline}</h1>
        <div class="body">
          <figure class="photo">${r.photo ? `<img src="${r.photo}" alt="">` : ""}</figure>
          <dl class="stats">
            <div><dt>Time</dt><dd>${fmt(r.time)}</dd><small>Par ${fmt(r.par)}</small></div>
            <div><dt>Alarms</dt><dd>${r.alarms}</dd></div>
            <div><dt>Closest shave</dt><dd>${clr}</dd></div>
            <div><dt>${r.prize}</dt><dd>${money}</dd></div>
          </dl>
        </div>
        <div class="grade grade-${r.grade.toLowerCase()}">${r.grade === "Gentleman" ? `<span class="g-crown">${ICON.crown}</span>` : ""}<span>${r.grade}</span></div>
        ${r.best ? `<div class="best-ribbon">Personal best</div>` : ""}
      </article>`;
    const menu = new Menu([
      ...(onNext ? [{ id: "next", label: "Next Vault", action: onNext }] : []),
      { id: "again", label: "Again", action: onAgain },
      { id: "title", label: "Title", action: onTitle }
    ], this.sound);
    menu.root.classList.add("results-menu");
    node.appendChild(menu.root);
    this.present(node, menu);
    setTimeout(() => this.sound("paper"), 80);
    setTimeout(() => { node.querySelector(".grade")?.classList.add("stamped"); this.sound("stamp"); }, 900);
  }

  /** Tutorial clear: a clipping, not a full front page. */
  private miniResults(r: ResultsData, onAgain: () => void, onNext: () => void) {
    const node = el("div", "screen results-screen");
    node.innerHTML = `<article class="paper mini"><header class="mast"><h3>Extra!</h3></header><h1 class="headline">${r.headline}</h1><p class="byline">${r.prize} · $${r.value.toLocaleString("en-US")}</p></article>`;
    const menu = new Menu([{ id: "next", label: "Next Vault", action: onNext }, { id: "again", label: "Again", action: onAgain }], this.sound);
    menu.root.classList.add("results-menu");
    node.appendChild(menu.root);
    this.present(node, menu);
    setTimeout(() => this.sound("paper"), 80);
  }

  /** Heist map: every vault in order with its best grade; locked ones stay dark. */
  heistMap(groups: Array<{ title: string; rooms: Array<{ id: string; name: string; grade?: string; locked: boolean }> }>, onPick: (id: string) => void, onBack: () => void) {
    const node = el("div", "screen map-screen");
    node.innerHTML = `<div class="card deco-frame wide map"><h2>The Jobs</h2></div>`;
    const items: MenuItem[] = [];
    for (const g of groups) for (const [i, r] of g.rooms.entries()) items.push({
      id: r.id, label: `${i === 0 ? `<em class="venue">${g.title}</em>` : ""}<span class="room-name">${r.locked ? "· · ·" : r.name}</span>${r.grade ? `<b class="grade-chip grade-${r.grade.toLowerCase()}">${r.grade}</b>` : ""}`,
      disabled: r.locked, action: () => onPick(r.id)
    });
    items.push({ id: "back", label: "Back", action: onBack });
    const menu = new Menu(items, this.sound);
    node.querySelector(".card")!.appendChild(menu.root);
    const firstOpen = items.findIndex((it) => !it.disabled && it.id !== "back" && !groups.flatMap((g) => g.rooms).find((r) => r.id === it.id)?.grade);
    menu.setFocus(firstOpen >= 0 ? firstOpen : 0, false);
    this.present(node, menu, onBack);
  }

  /** Silent-film intertitle: cards one after another; any button advances. */
  intertitle(title: string, cards: string[], onDone: () => void) {
    const node = el("div", "screen intertitle-screen");
    let i = -1;
    const show = () => {
      i++;
      if (i > cards.length) { this.close(); onDone(); return; }
      const text = i === 0 ? `<h2>${title}</h2>` : `<p>${cards[i - 1]}</p>`;
      node.innerHTML = `<div class="film"><div class="frame">${text}</div></div>`;
      this.sound(i === 0 ? "paper" : "ui.move");
    };
    const menu = { handle: (f: InputFrame) => { if (f.ui.confirm || f.interact || f.ui.back) show(); return true; } } as unknown as Menu;
    node.addEventListener("pointerdown", show);
    show();
    this.present(node, menu, () => show());
  }

  pressStart(onAny: () => void) {
    const node = el("div", "screen press-screen");
    node.innerHTML = `<div class="logo big"><div class="crown">${ICON.crown}</div><h1><span>Light</span><span>Fingers</span></h1><div class="rule"><i></i><b></b><i></i></div><p class="press">Press any button</p></div>`;
    const go = () => { node.removeEventListener("pointerdown", go); onAny(); };
    node.addEventListener("pointerdown", go);
    this.present(node, undefined, undefined);
    return go;
  }
}
