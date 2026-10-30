import * as THREE from "three";
import { BrowserStorage, SaveManager, SettingsStore } from "@slu/web-shell";
import { AudioEngine } from "../audio/engine";
import { Input, type InputFrame } from "../input/input";
import { BeamView } from "../render/beams";
import { LockeView } from "../render/locke";
import { OpticsView, PrizeView } from "../render/props";
import { RoomView } from "../render/room";
import { Stage, detectTier, type Quality } from "../render/stage";
import { DebugOverlay } from "../ui/debug";
import { toonLights } from "../render/toon";
import { emitterActive, sweepAngle } from "../sim/beams";
import { dist, pointSegDist, v2 } from "../sim/math2d";
import { DT, HeistRun, emptyInput, STRETCH_MAX, type RunSnapshot, type SimEvent, type SimInput } from "../sim/run";
import type { RoomDef } from "../sim/roomTypes";
import { UI, type MenuItem } from "../ui/ui";
import { CAMPAIGN, isTutorial, loadRoom } from "./rooms";
import { lineFor } from "./lines";
import VENUES_JSON from "../content/venues.json";
const VENUES = VENUES_JSON as unknown as Record<string, { title: string; cards: string[] }>;
const ROOM_NAMES = Object.fromEntries(Object.entries(import.meta.glob<{ name: string }>("../rooms/*.json", { eager: true, import: "default" })).map(([k, v]) => [k.replace("../rooms/", "").replace(".json", ""), v.name]));

interface Settings {
  masterVolume: number; musicVolume: number; sfxVolume: number;
  reducedMotion: boolean; cameraSensitivity: number; quality: "Auto" | "Cinematic" | "Balanced" | "Performance"; beamPatterns: boolean;
}
const DEFAULTS: Settings = { masterVolume: 0.9, musicVolume: 0.75, sfxVolume: 0.9, reducedMotion: false, cameraSensitivity: 0.5, quality: "Auto", beamPatterns: false };
const REWIND_SECONDS = 3;
const SNAP_EVERY = 6; // ticks (20 Hz history)

interface RoomRecord { bestTime?: number; bestGrade?: string; bestClearance?: number; clears: number }
interface Progress { rooms: Record<string, RoomRecord>; learned?: string[] }

const GRADE_ORDER = ["C", "B", "A", "S", "Gentleman"];

export function gradeFor(time: number, par: number, alarms: number, rewinds = 0): string {
  if (alarms === 0 && time <= par && rewinds === 0) return "Gentleman";
  if (alarms === 0 && time <= par * 1.5) return "S";
  if (alarms <= 1 && time <= par * 2) return "A";
  if (alarms <= 2) return "B";
  return "C";
}

type Mode = "press" | "title" | "play" | "paused" | "results" | "caught" | "editor";

export class Game {
  stage: Stage;
  private input: Input;
  private ui: UI;
  private audio = new AudioEngine();
  private settings: SettingsStore<Settings>;
  private save: SaveManager<Progress>;
  private progress: Progress = { rooms: {} };
  private room!: RoomDef;
  run!: HeistRun;
  private roomView!: RoomView;
  private beams = new BeamView();
  private locke = new LockeView();
  private prize!: PrizeView;
  private optics!: OpticsView;
  private mode: Mode = "press";
  private acc = 0;
  private last = performance.now();
  private time = 0;
  private wasOrbiting = false;
  private celebrate = -1;
  private resultsTimer = -1;
  private learned = new Set<string>();
  /** Swallows the menu-confirm press so it can't start the clock or act in the vault. */
  private inputGrace = 0;
  /** Leaves the press-start screen; also fired by any gamepad button. */
  private pressGo: (() => void) | null = null;
  private debug: DebugOverlay | null = null;
  private photo: string | undefined;
  private wantPhoto = false;
  private pendingEdges: SimInput = emptyInput();
  private history: RunSnapshot[] = [];
  private rewinding = false;
  private rewinds = 0;
  private editor: { show(v: boolean): void } | null = null;

  constructor(private canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    const storage = new BrowserStorage("light-fingers");
    this.settings = new SettingsStore<Settings>(storage, "settings", { ...DEFAULTS });
    this.save = new SaveManager<Progress>(storage, "progress", 1);
    this.stage = new Stage(canvas, detectTier());
    this.input = new Input(canvas, uiRoot);
    this.ui = new UI(uiRoot, (id) => this.audio.play(id));
    this.input.onDevice((d) => this.ui.setDevice(d));
    this.ui.setDevice(this.input.device);
    this.stage.scene.add(this.beams.group, this.locke.root);
    const unlock = () => this.audio.unlock();
    addEventListener("pointerdown", unlock, { once: true });
    addEventListener("keydown", unlock, { once: true });
  }

  async boot() {
    try { await this.settings.load(); } catch { /* defaults */ }
    try { const r = await this.save.loadWithRecovery(); if (r.data) this.progress = r.data; } catch { /* fresh */ }
    this.learned = new Set(this.progress.learned ?? []);
    this.applySettings();
    this.loadRoom(await loadRoom(new URLSearchParams(location.search).get("room") ?? this.nextRoomId()));
    if (new URLSearchParams(location.search).has("bench")) { this.startBench(); requestAnimationFrame((t) => this.frame(t)); return; }
    if (new URLSearchParams(location.search).has("editor")) { await this.openEditor(); requestAnimationFrame((t) => this.frame(t)); return; }
    const go = this.ui.pressStart(() => this.toTitle(true));
    this.pressGo = go;
    const anyKey = (e: Event) => { if (this.mode === "press") { e.preventDefault(); go(); } };
    addEventListener("keydown", anyKey, { once: true });
    requestAnimationFrame((t) => this.frame(t));
    if (import.meta.env.DEV || location.search.includes("debug")) (window as unknown as { game: Game }).game = this;
    if (location.search.includes("debug")) this.debug = new DebugOverlay();
  }

  private bench: { tiers: Quality[]; i: number; t: number; samples: number[]; out: string[]; el: HTMLElement } | null = null;

  /** ?bench: each tier gets 2 s warm-up + 10 s of measured gameplay in the heaviest room. */
  private async startBench() {
    if (this.room.id !== "room-zero") this.loadRoom(await loadRoom("room-zero"));
    const el = document.createElement("pre");
    el.className = "debug-overlay bench";
    document.body.appendChild(el);
    this.bench = { tiers: ["cinematic", "balanced", "performance"], i: -1, t: 99, samples: [], out: [], el };
    this.startPlay();
  }

  private benchFrame(dt: number) {
    const b = this.bench!;
    b.t += dt;
    if (b.t > 2) b.samples.push(dt * 1000);
    if (b.t < 12) {
      b.el.textContent = `BENCH ${b.tiers[b.i] ?? ""} ${(12 - b.t).toFixed(0)}s\n${b.out.join("\n")}`;
      return;
    }
    if (b.i >= 0) {
      const s = [...b.samples].sort((x, y) => x - y);
      const avg = s.reduce((a, c) => a + c, 0) / s.length;
      b.out.push(`${b.tiers[b.i]!.padEnd(12)} ${(1000 / avg).toFixed(1)} fps  avg ${avg.toFixed(1)} ms  p95 ${(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(1)} ms`);
    }
    b.i++;
    if (b.i >= b.tiers.length) { b.el.textContent = `BENCH DONE (${innerWidth}x${innerHeight} @${devicePixelRatio}x)\n${b.out.join("\n")}`; (window as unknown as { benchResult: string[] }).benchResult = b.out; this.bench = null; return; }
    this.stage.setQuality(b.tiers[b.i]!);
    this.rebuildRoom();
    this.newRun();
    b.t = 0; b.samples = [];
  }

  /** First campaign vault not yet cleared (or the last one once everything is done). */
  private nextRoomId(after?: string): string {
    if (after) { const i = CAMPAIGN.indexOf(after); if (i >= 0 && i < CAMPAIGN.length - 1) return CAMPAIGN[i + 1]!; }
    return CAMPAIGN.find((id) => !this.progress.rooms[id]?.clears) ?? CAMPAIGN[CAMPAIGN.length - 1]!;
  }

  private learn(what: string) {
    if (this.learned.has(what)) return;
    this.learned.add(what);
    this.progress.learned = [...this.learned];
    void this.save.save(this.progress).catch(() => {});
  }

  private async openEditor() {
    const { RoomEditor } = await import("../editor/editor");
    this.mode = "editor";
    this.ui.closeAll();
    this.ui.showHud(false);
    this.editor = new RoomEditor({
      room: () => this.room,
      apply: (r) => { this.room = r; this.audio.setRoom(r); this.rebuildRoom(); this.newRun(); },
      camera: () => this.stage.camera,
      canvas: this.canvas,
      scene: this.stage.scene,
      playtest: () => { this.editor?.show(false); this.startPlay(); }
    });
  }

  private backToEditor() {
    this.ui.closeAll();
    this.audio.setPaused(false);
    this.mode = "editor";
    this.ui.showHud(false);
    this.newRun();
    this.editor?.show(true);
  }

  private leave() { if (this.editor) this.backToEditor(); else this.toTitle(); }

  private applySettings() {
    const s = this.settings.snapshot();
    this.audio.setVolumes({ master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume });
    this.input.sensitivity = 0.4 + s.cameraSensitivity * 1.4;
    document.documentElement.classList.toggle("reduced", s.reducedMotion);
    this.beams.patterns = s.beamPatterns;
    // Tier is decided at load (auto-detect) or by the player in Settings; never silently mid-run.
    if (!["Auto", "Cinematic", "Balanced", "Performance"].includes(s.quality)) { s.quality = "Auto"; void this.settings.patch({ quality: "Auto" }); }
    const want: Quality = s.quality === "Auto" ? detectTier() : (s.quality.toLowerCase() as Quality);
    if (want !== this.stage.quality) { this.stage.setQuality(want); this.rebuildRoom(); }
  }

  private loadRoom(def: RoomDef) {
    this.room = def;
    const side = def.view === "side";
    this.stage.lockSide(side);
    this.stage.setDist(side ? 15 * Math.max(def.size.w / 13, def.size.d / 7.5, 0.62) : 15 * Math.max(def.size.w / 12, def.size.d / 9, 0.62) * (def.floors && def.floors > 1 ? 1.12 : 1));
    this.audio.setRoom(def);
    this.rebuildRoom();
    this.newRun();
  }

  private rebuildRoom() {
    if (!this.room) return;
    if (this.roomView) this.stage.scene.remove(this.roomView.group);
    if (this.prize) this.stage.scene.remove(this.prize.group, this.prize.causticObject);
    if (this.optics) this.stage.scene.remove(this.optics.group);
    this.roomView = new RoomView(this.room, this.stage.quality);
    this.prize = new PrizeView(this.room);
    this.optics = new OpticsView(this.room);
    this.stage.scene.add(this.roomView.group, this.prize.group, this.prize.causticObject, this.optics.group);
    this.beams.space = this.roomView.space;
  }

  private newRun() {
    this.run = new HeistRun(this.room);
    this.acc = 0;
    this.history = [];
    this.rewinds = 0;
    this.rewinding = false;
    this.celebrate = -1;
    this.resultsTimer = -1;
    this.photo = undefined;
    this.prize.group.position.copy(this.prize.restPos);
    this.quipSaid.clear();
    this.quipT = 0;
    this.wasFlat = false;
    // The feather gag carries across the night.
    if (this.learned.has("feather-lost") && !this.learned.has("feather-back")) this.locke.dropFeather();
    else if (!this.locke.hasFeather) this.locke.restoreFeather();
    for (const f of this.roomView.statueFeathers) f.visible = this.learned.has("feather-lost") && !this.learned.has("feather-back");
  }

  private wasFlat = false;
  private penTick = -1;
  /** Per-frame comedy beats that don't come from a single sim event. */
  private momentsFrame() {
    const r = this.run, L = r.locke;
    if (r.phase === "case" && this.time > 0.5) this.quip("entry", 3.2);
    // The pendulum ticks at each end of its swing: the room's metronome.
    const pen = this.room.emitters.find((x) => x.type === "pendulum");
    if (pen) {
      const half = ((r.prizeLifted && pen.out?.swing ? pen.out.swing : pen.swing)?.period ?? 2) / 2;
      const k = Math.floor((r.beat + half / 2) / half);
      if (k !== this.penTick) { if (this.penTick !== -1) this.audio.play("pendulum"); this.penTick = k; }
    }
    if (L.stretch.active && !r.side && L.stretch.length >= STRETCH_MAX - 0.02) this.quip("overshoot", 2.2);
    if (this.wasFlat && L.pose !== "flatten") { this.locke.boing(0.7); this.quip("peel", 2.0); }
    this.wasFlat = L.pose === "flatten";
    // Funhouse mirrors: catch sight of himself in warped glass.
    if (r.optics.some((o) => (o.kind === "concave" || o.kind === "convex") && dist(L.pos, this.room.mounts.find((m) => m.id === o.mountId)!) < 1.3)) this.quip("reflection", 2.6);
    // Portraits and statues: anything in the room's "watchers" list.
    if (this.room.blocks.some((b) => b.style === "statue" && dist(L.pos, b) < 1.6) && this.roomView.statueFeathers.some((f) => f.visible)) this.quip("statue-see", 2.4);
  }

  private toTitle(fromPress = false) {
    this.audio.unlock();
    if (fromPress) this.audio.play("ui.start");
    this.mode = "title";
    this.ui.closeAll();
    this.ui.showHud(false);
    this.newRun();
    this.stage.freeOrbit = true;
    const rec = this.progress.rooms[this.room.id];
    const best = rec?.bestTime !== undefined ? `${rec.bestGrade ?? ""} · ${rec.bestTime.toFixed(2)}s` : null;
    this.ui.title(() => this.openMap(), () => this.openSettings(), best);
  }

  private openMap() {
    const rooms = CAMPAIGN.map((id, i) => ({ id, i }));
    const cleared = (id: string) => !!this.progress.rooms[id]?.clears;
    const unlocked = (i: number) => i === 0 || cleared(CAMPAIGN[i - 1]!);
    const groups = [
      { title: VENUES.jobs!.title, rooms: rooms.filter((r) => isTutorial(r.id)) },
      { title: VENUES["gilded-museum"]!.title, rooms: rooms.filter((r) => !isTutorial(r.id)) }
    ].map((g) => ({ title: g.title, rooms: g.rooms.map((r) => ({ id: r.id, name: ROOM_NAMES[r.id] ?? r.id, grade: this.progress.rooms[r.id]?.bestGrade, locked: !unlocked(r.i) })) }));
    this.ui.heistMap(groups, (id) => void this.playRoom(id), () => this.ui.close());
  }

  private async playRoom(id: string) {
    if (id !== this.room.id) this.loadRoom(await loadRoom(id));
    // First time into a venue: a silent-film card.
    const venue = isTutorial(id) ? "jobs" : this.room.venue;
    const seen = `venue:${venue}`;
    const card = VENUES[venue];
    if (card && !this.learned.has(seen)) {
      this.learn(seen);
      this.ui.closeAll();
      this.ui.intertitle(card.title, card.cards, () => this.startPlay());
      return;
    }
    this.startPlay();
  }

  /** Escaping a room with a `next` hands straight into its getaway set piece; the newspaper waits for the end. */
  private chainFrom: { room: RoomDef; stats: { time: number; alarms: number; clearance: number; value: number }; rewinds: number } | null = null;
  private async chainTo(id: string) {
    this.chainFrom = { room: this.room, stats: { ...this.run.stats }, rewinds: this.rewinds };
    this.audio.play("escaped");
    this.ui.flash("escape");
    this.mode = "results";
    const def = await loadRoom(id);
    const keep = this.chainFrom;
    this.loadRoom(def);
    this.chainFrom = keep;
    this.startPlay();
    this.rewinds = keep.rewinds;
    this.ui.toast("The getaway");
  }

  private startPlay() {
    this.audio.unlock();
    this.ui.closeAll();
    this.mode = "play";
    this.newRun();
    this.ui.showHud(true);
    this.stage.snap();
    this.inputGrace = 0.35;
  }

  private restart() {
    this.audio.play("restart");
    this.ui.closeAll();
    this.mode = "play";
    this.newRun();
    this.ui.showHud(true);
    this.audio.setPaused(false);
  }

  private pause() {
    if (this.mode !== "play") return;
    this.mode = "paused";
    this.audio.setPaused(true);
    this.ui.pause(() => this.resume(), () => this.restart(), () => this.openSettings(), () => { this.audio.setPaused(false); this.leave(); });
  }

  private resume() {
    this.ui.closeAll();
    this.mode = "play";
    this.audio.setPaused(false);
  }

  private openSettings() {
    const s = this.settings;
    const patch = (p: Partial<Settings>) => { void s.patch(p).then(() => this.applySettings()); };
    const items: MenuItem[] = [
      { id: "master", label: "Master", kind: "slider", get: () => s.get("masterVolume"), set: (v) => patch({ masterVolume: v as number }) },
      { id: "music", label: "Music", kind: "slider", get: () => s.get("musicVolume"), set: (v) => patch({ musicVolume: v as number }) },
      { id: "sfx", label: "Effects", kind: "slider", get: () => s.get("sfxVolume"), set: (v) => patch({ sfxVolume: v as number }) },
      { id: "cam", label: "Camera Speed", kind: "slider", get: () => s.get("cameraSensitivity"), set: (v) => patch({ cameraSensitivity: v as number }) },
      { id: "patterns", label: "Beam Patterns", kind: "toggle", get: () => s.get("beamPatterns"), set: (v) => patch({ beamPatterns: v as boolean }) },
      { id: "motion", label: "Reduced Motion", kind: "toggle", get: () => s.get("reducedMotion"), set: (v) => patch({ reducedMotion: v as boolean }) },
      { id: "quality", label: "Quality", kind: "choice", choices: ["Auto", "Cinematic", "Balanced", "Performance"], get: () => s.get("quality"), set: (v) => patch({ quality: v as Settings["quality"] }) }
    ];
    this.ui.settings(items, () => this.ui.close());
  }

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    const reduced = this.settings.get("reducedMotion");
    const f = this.input.poll();

    if (this.mode === "press" && f.any && this.input.device === "pad" && this.pressGo) { const go = this.pressGo; this.pressGo = null; go(); }
    else if (this.ui.open && this.mode !== "play") this.ui.handle(f);
    if (this.inputGrace > 0) {
      this.inputGrace -= dt;
      if (this.mode === "play") { f.interact = f.crouch = f.flatten = f.cycle = f.stretch = false; f.rotate = 0; f.move = { x: 0, y: 0 }; }
    }
    if (this.bench) { this.benchFrame(dt); const a = this.time * 0.7; f.move = { x: Math.cos(a), y: Math.sin(a) * 0.6 }; f.stretch = Math.sin(this.time * 0.9) > 0.85; f.orbit = { dx: dt * 0.15, dy: 0 }; }

    // Simulation.
    if (this.mode === "editor") {
      this.stepSim(emptyInput(), dt);
      this.cameraInput(f);
      this.stage.focus(0, 0, 0);
    } else if (this.mode === "title") {
      this.stepSim(emptyInput(), dt);
      this.stage.orbit(dt * (reduced ? 0.02 : 0.06), 0);
      this.stage.focus(0, 0, 0);
    } else if (this.mode === "play" || this.mode === "results" || this.mode === "caught") {
      if (this.mode === "play") {
        if (f.pause) { this.pause(); }
        else if (f.restart) { this.learn("restart"); this.restart(); }
        if (f.taunt && !this.locke.taunting) { this.learn("taunt"); this.locke.taunt(); this.audio.play("puff"); const l = lineFor(this.room.id, "taunt-say"); if (l) this.audio.speak(l); this.tauntSay = 2.2; }
      }
      if (this.mode === "play" || this.mode === "results" || this.mode === "caught") {
        this.cameraInput(f);
        const canRewind = this.mode === "play" && (this.run.phase === "in" || this.run.phase === "out") && this.history.length > 1;
        if (f.rewind && canRewind) this.rewindStep();
        else {
          if (this.rewinding) { this.rewinding = false; this.audio.play("rewind.end"); document.documentElement.classList.remove("rewinding"); }
          this.stepSim(this.mode === "play" ? this.simInput(f) : emptyInput(), dt);
        }
      }
      const Lk = this.run.locke;
      if (this.room.view === "side") this.stage.focus(Lk.pos.x, 0, 0.55, this.room.size.d / 2 - Lk.pos.z + 0.7);
      else this.stage.focus(Lk.pos.x, Lk.pos.z, 0.3, 0.4 + this.roomView.space.floorY(Lk.floor) + (Lk.raised ? 0.45 : 0));
      this.stage.overhead(this.run.obscura);
    } else if (this.mode === "paused") {
      // Frozen; still allow looking around.
      this.cameraInput(f);
    }

    // Results timing after escape.
    if (this.resultsTimer >= 0) {
      this.resultsTimer -= dt;
      if (this.resultsTimer < 0) this.showResults();
    }
    if (this.celebrate >= 0) this.celebrate += dt;
    this.rewindCoach = Math.max(0, this.rewindCoach - dt);
    this.tauntSay = Math.max(0, this.tauntSay - dt);
    this.quipT = Math.max(0, this.quipT - dt);
    if (this.mode === "play") this.momentsFrame();


    this.present(dt, reduced);
    this.stage.update(dt, reduced);
    this.roomView.updateCutaway(new THREE.Vector3().subVectors(this.stage.camera.position, this.stage.target).setY(0).normalize(), dt);
    this.prize.face(this.stage.camera);
    this.stage.setFocusWorld(new THREE.Vector3(this.run.locke.pos.x, 0.7, this.run.locke.pos.z));
    // Menu frames' cat's-eye band follows the camera like the in-world gold does.
    const sheen = ((((this.stage.yaw / (Math.PI * 2)) * 180 + this.stage.pitch * 60) % 160) + 160) % 160 - 30;
    if (Math.abs(sheen - this.lastSheen) > 0.5) { this.lastSheen = sheen; document.documentElement.style.setProperty("--sheen", `${sheen.toFixed(1)}%`); }
    this.beams.uniforms.uPix.value = this.stage.pixelAngle();
    this.beams.uniforms.uCam.value.copy(this.stage.camera.position);
    this.stage.render();
    if (this.wantPhoto) { this.wantPhoto = false; try { this.photo = this.canvas.toDataURL("image/jpeg", 0.8); } catch { /* tainted/unsupported */ } }
    this.debug?.frame(now, this.stage, this.mode);
  }

  private orbitTravel = 0;
  private flatTravel = 0;
  private rewindCoach = 0;
  private lastSpoken: string | null = null;
  private lastSheen = -999;
  private tauntSay = 0;

  private cameraInput(f: InputFrame) {
    if (f.orbit.dx || f.orbit.dy) this.stage.orbit(-f.orbit.dx, f.orbit.dy);
    // The look-around prompt retires after one full orbit.
    if (this.mode === "play" && f.orbit.dx) { this.orbitTravel += Math.abs(f.orbit.dx); if (this.orbitTravel >= Math.PI * 2) this.learn("orbit"); }
    if (f.snap) this.stage.snapStep(f.snap);
    const casing = this.run.phase === "case";
    if (!f.orbiting && this.wasOrbiting && !casing) this.stage.snap();
    this.wasOrbiting = f.orbiting;
  }

  private simInput(f: InputFrame): SimInput {
    const b = this.stage.basis();
    const mv = v2(b.right.x * f.move.x + b.fwd.x * f.move.y, b.right.z * f.move.x + b.fwd.z * f.move.y);
    if (this.run.locke.pose === "flatten" && Math.hypot(mv.x, mv.z) > 0.3) { this.flatTravel += 1 / 60; if (this.flatTravel > 0.6) this.learn("sidle"); }
    return { move: mv, stretch: f.stretch, crouch: f.crouch, flatten: f.flatten, interact: f.interact, rotate: f.rotate * this.rotateSign(), cycle: f.cycle };
  }

  /**
   * Rotate buttons are screen-space: the clockwise button always turns the optic clockwise as seen on
   * screen. Sim angles grow from +x toward +z; check how that sweep projects at the current camera.
   */
  private rotateSign(): number {
    const m = this.run.targetMount();
    const mp = m ? this.room.mounts.find((x) => x.id === m)! : { x: 0, z: 0 };
    const cam = this.stage.camera;
    const o = new THREE.Vector3(mp.x, 0, mp.z).project(cam), px = new THREE.Vector3(mp.x + 1, 0, mp.z).project(cam), pz = new THREE.Vector3(mp.x, 0, mp.z + 1).project(cam);
    // NDC y points up; a clockwise x→z sweep on screen has a negative cross product there.
    const cross = (px.x - o.x) * (pz.y - o.y) - (px.y - o.y) * (pz.x - o.x);
    return cross < 0 ? 1 : -1;
  }

  private stepSim(input: SimInput, dt: number) {
    // Edge-triggered actions survive until the next fixed step consumes them.
    const e = this.pendingEdges;
    e.crouch ||= input.crouch; e.flatten ||= input.flatten; e.interact ||= input.interact; e.cycle ||= input.cycle;
    if (input.rotate) e.rotate = input.rotate;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && steps < 12) {
      const si: SimInput = { ...input, crouch: e.crouch, flatten: e.flatten, interact: e.interact, rotate: e.rotate, cycle: e.cycle };
      this.pendingEdges = e;
      e.crouch = e.flatten = e.interact = e.cycle = false; e.rotate = 0;
      for (const ev of this.run.step(si)) this.onEvent(ev);
      if (this.run.tick % SNAP_EVERY === 0 && (this.run.phase === "in" || this.run.phase === "out")) {
        this.history.push(this.run.snapshot());
        if (this.history.length > (REWIND_SECONDS * 120) / SNAP_EVERY) this.history.shift();
      }
      this.acc -= DT;
      steps++;
    }
    if (steps === 12) this.acc = 0;
  }

  /** Campaign assist: scrub back through the last three seconds. */
  private rewindStep() {
    this.learn("rewind");
    if (!this.rewinding) {
      this.rewinding = true;
      this.rewinds++;
      this.audio.play("rewind");
      document.documentElement.classList.add("rewinding");
    }
    // Two history frames per render frame ≈ 2× speed.
    for (let i = 0; i < 2 && this.history.length > 1; i++) this.history.pop();
    const snap = this.history[this.history.length - 1];
    if (snap) this.run.restore(snap);
    this.acc = 0;
  }

  private panOf(x: number, z: number) {
    const b = this.stage.basis();
    const dx = x - this.stage.target.x, dz = z - this.stage.target.z;
    return Math.max(-1, Math.min(1, (dx * b.right.x + dz * b.right.z) / 6));
  }

  private onEvent(e: SimEvent) {
    const L = this.run.locke;
    if (e.type === "run.start") this.learn("move");
    if (e.type === "stretch.start" && !e.auto) this.learn("stretch");
    if (e.type === "pose") this.learn(e.pose);
    if (e.type === "optic.place") { this.learn("place"); if (e.kind === "splitter") this.audio.play("splitter"); }
    if (e.type === "optic.rotate") this.learn("rotate");
    if (e.type === "lift") this.learn("lift");
    const pan = this.panOf(L.pos.x, L.pos.z);
    switch (e.type) {
      case "step": this.audio.play("step", { pan }); break;
      case "contact": {
        this.lastContactAt = this.time;
        if (e.threat >= 2) this.quip("alarm", 2.0);
        else this.quip("contact", 1.8);
        if (!this.learned.has("restart") || (isTutorial(this.room.id) && !this.learned.has("rewind"))) this.rewindCoach = 4;
        this.locke.react("surprised", 1.2);
        this.audio.play("contact", { pan });
        this.beams.flash.set(e.emitter, 0.45);
        this.beams.tripped.set(e.emitter, 1.8);
        this.stage.kick(1);
        this.ui.flash("contact");
        this.input.rumble(0.8, 220);
        toonLights.flash.value = 1;
        if (e.threat === 1) this.ui.toast("Disturbed");
        if (e.threat === 2) this.ui.toast("Alert");
        break;
      }
      case "lift":
        if (this.run.threat === 0) this.quip("clean", 2.4);
        if (this.room.emitters.some((x) => x.type === "projector" && x.out)) setTimeout(() => this.audio.play("projector.freeze"), 500);
        this.locke.react("grin", 2.2);
        this.audio.play("lift");
        this.prize.burst();
        this.ui.flash("lift");
        this.stage.kick(0.35);
        this.input.rumble(0.4, 160);
        setTimeout(() => this.audio.play("shutter"), 350);
        break;
      case "stretch.snap": this.locke.boing(this.run.locke.hasPrize ? 1.3 : 1); this.audio.play("stretch.snap", { pan }); break;
      case "sensor.fed": this.audio.play("sensor.fed"); this.ui.flash("solve"); break;
      case "escaped":
        if (this.locke.hasFeather && this.room.emitters.some((x) => x.type === "pendulum")) { this.locke.clipFeather(); this.learn("feather-lost"); }
        if (this.room.next) { void this.chainTo(this.room.next); break; }
        this.quip("getaway", 2.0);
        this.audio.play("escaped");
        this.ui.flash("escape");
        this.celebrate = 0;
        this.resultsTimer = 1.7;
        this.wantPhoto = true;
        break;
      case "lockdown":
        this.audio.play("lockdown");
        this.stage.kick(1.4);
        this.mode = "caught";
        this.ui.caught();
        this.input.rumble(1, 500);
        break;
      case "restart":
        if (this.mode === "caught") this.restart();
        break;
      case "nearMiss": this.beams.sizzle.set(e.emitter, 0.35); this.audio.play("sizzle", { pan }); this.onNearMiss(e.emitter); break;
      case "optic.rotate": this.audio.play("optic.rotate", { pan }); this.optics.flash(e.mountId); break;
      case "plate.down": this.audio.play("plate", { pan }); break;
      case "plate.up": this.audio.play("plate.up", { pan }); break;
      case "shutter.open": this.audio.play("gate.open", { pan }); this.stage.kick(0.15); this.ui.flash("solve"); break;
      case "shutter.close": this.audio.play("gate.close", { pan }); this.stage.kick(0.3); break;
      case "stairs": this.audio.play("step", { pan }); this.audio.play("stairs", { pan }); break;
      case "obscura": this.audio.play(e.on ? "obscura.open" : "obscura.close"); if (e.on) this.learn("obscura"); break;
      case "stepUp": if (e.on) { this.audio.play("step", { pan }); this.locke.boing(0.5); } break;
      case "rope.hook": this.audio.play("hook", { pan }); this.locke.boing(0.4); break;
      case "rope.letgo": this.locke.react("surprised", 1.1); this.audio.play("letgo", { pan }); this.quip("letgo", 2.6); break;
      case "rope.yank": this.audio.play("yank", { pan }); this.locke.react("surprised", 0.6); this.quip("yank", 2.2); break;
      case "land": this.locke.boing(Math.min(1.6, e.speed / 4)); this.audio.play("land", { pan }); this.stage.kick(Math.min(0.5, e.speed / 12)); if (e.speed > 4.5) this.quip("land", 2.0); break;
      case "deny": {
        // The statue in the Sculpture Court has his feather. He takes it back.
        const st = this.room.blocks.find((b) => b.style === "statue" && dist(L.pos, b) < 1.4);
        if (st && this.roomView.statueFeathers.some((f) => f.visible)) {
          for (const f of this.roomView.statueFeathers) f.visible = false;
          this.locke.restoreFeather();
          this.learn("feather-back");
          this.audio.play("feather.back", { pan });
          this.locke.react("grin", 1.6);
          this.quip("feather-back", 2.6, "ever");
        } else this.audio.play("deny", { pan });
        break;
      }
      case "exit.closed": this.audio.play("exit.closed"); this.ui.toast("Exit sealed"); break;
      default: this.audio.play(e.type, { pan });
    }
  }

  /** Which line Locke should be saying right now (one at a time; each retires once its move is used). */
  // ---- Locke moments: brief, never blocking, never repeated tediously ----
  private quipT = 0;
  private quipKey: string | null = null;
  private quipSaid = new Set<string>();
  private lastContactAt = -9;

  /** Say a room line for a moment. "attempt" lines reset on restart; "ever" lines are saved. */
  private quip(trigger: string, seconds = 2.4, once: "attempt" | "ever" = "attempt") {
    const key = `${this.room.id}:${trigger}`;
    if (once === "ever" ? this.learned.has(`q:${key}`) : this.quipSaid.has(key)) return;
    if (!lineFor(this.room.id, trigger)) return;
    // Never talk over a contact or alarm cue.
    if (this.time - this.lastContactAt < 1.2 && trigger !== "alarm") return;
    this.quipSaid.add(key);
    if (once === "ever") this.learn(`q:${key}`);
    this.quipKey = trigger; this.quipT = seconds;
  }

  private onNearMiss(emitter: string) {
    const e = this.room.emitters.find((x) => x.id === emitter);
    if (e?.type === "pendulum" && this.locke.hasFeather) {
      this.locke.clipFeather();
      this.audio.play("snip");
      this.learn("feather-lost");
      this.quip("feather", 2.6, "ever");
      return;
    }
    this.locke.sweatDrop();
    this.quip("nearMiss", 2.0);
  }

  private speechTrigger(): string | null {
    const r = this.run, L = r.locke;
    if (this.tauntSay > 0) return "taunt-say";
    const teach = this.teachTrigger(r, L);
    if (teach) return teach;
    if (this.quipT > 0 && this.quipKey) return this.quipKey;
    return null;
  }

  private teachTrigger(r: HeistRun, L: HeistRun["locke"]): string | null {
    const tutorial = isTutorial(this.room.id);
    if (this.rewindCoach > 0) return !this.learned.has("restart") ? "fumble" : !this.learned.has("rewind") && tutorial ? "rewind" : null;
    if (r.phase === "case" && !this.learned.has("orbit")) return "orbit";
    if (r.phase === "case" && !this.learned.has("move")) return "move";
    if (tutorial && !this.learned.has("orbit") && Math.hypot(L.vel.x, L.vel.z) < 0.1) return "orbit";
    // Card Trick: a gap too thin to walk; teach flatten, then the sidle.
    const thinGap = r.room.blocks.filter((b) => b.style === "case").length >= 6 && r.room.blocks.some((b) => b.style === "case" && dist(L.pos, v2(b.x, b.z)) < b.w / 2 + 0.9);
    if (thinGap && L.pose !== "flatten" && !this.learned.has("flatten")) return "flatten";
    if (L.pose === "flatten" && !this.learned.has("sidle")) return "sidle";
    if (r.canGrabPrize() && !this.learned.has("lift")) return "lift";
    if (L.hasPrize && !this.learned.has("taunt")) return "taunt";
    if (!r.prizeLifted && !L.stretch.active && !r.canGrabPrize() && !this.learned.has("stretch") && dist(L.pos, r.prizePos) < STRETCH_MAX + 0.6) return "stretch";
    // At a mount the mirror is the point; the crouch can wait.
    const target = r.targetMount();
    if (target && !this.learned.has("place") && r.beltKind && !r.optics.some((o) => o.mountId === target)) return "place";
    if (target && !this.learned.has("rotate") && r.optics.some((o) => o.mountId === target)) return "rotate";
    if (L.pose === "stand" && !this.learned.has("crouch")) {
      const high = r.frame.segments.some((sg) => sg.live && sg.band === "high" && pointSegDist(L.pos, sg.a, sg.b) < 1.0);
      const other = r.frame.segments.some((sg) => sg.live && sg.band !== "high" && pointSegDist(L.pos, sg.a, sg.b) < 1.0);
      if (high && !other) return "crouch";
    }
    return null;
  }

  private showResults() {
    const ch = this.chainFrom;
    this.chainFrom = null;
    const room = ch ? ch.room : this.room;
    const g = this.run.stats;
    const s = ch ? { time: ch.stats.time + g.time, alarms: Math.max(ch.stats.alarms, g.alarms), clearance: Math.min(ch.stats.clearance, g.clearance), value: ch.stats.value } : g;
    const grade = gradeFor(s.time, room.parTime + (ch ? this.room.parTime : 0), s.alarms, this.rewinds);
    const rec = this.progress.rooms[room.id] ?? { clears: 0 };
    const best = rec.bestTime === undefined || s.time < rec.bestTime;
    rec.clears++;
    if (best) rec.bestTime = s.time;
    if (!rec.bestGrade || GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(rec.bestGrade)) rec.bestGrade = grade;
    if (Number.isFinite(s.clearance) && (rec.bestClearance === undefined || s.clearance < rec.bestClearance)) rec.bestClearance = s.clearance;
    this.progress.rooms[room.id] = rec;
    void this.save.save(this.progress).catch(() => {});
    this.mode = "results";
    this.ui.showHud(false);
    if (grade === "Gentleman") setTimeout(() => this.audio.play("gentleman"), 900);
    const next = this.editor ? null : this.nextRoomId(room.id);
    const hasNext = !!next && next !== room.id;
    this.ui.results({ headline: room.headline, prize: this.room.setPiece && !ch ? "" : room.prize.name, time: s.time, par: this.room.parTime, alarms: s.alarms, clearance: s.clearance, value: s.value, grade, best, photo: this.photo, mini: isTutorial(room.id) || (!!this.room.setPiece && !ch) },
      () => this.restart(), () => this.leave(), hasNext ? () => void this.playRoom(next!) : undefined);
  }

  private present(dt: number, reduced: boolean) {
    const r = this.run;
    const L = r.locke;
    const frame = r.frame;
    toonLights.flash.value = Math.max(0, toonLights.flash.value - dt * 4);
    this.beams.update(frame.segments, dt, this.time);
    const sweepAngles: Record<string, number> = {};
    for (const e of this.room.emitters) if (e.type === "sweeper" || e.type === "camera" || e.type === "projector") sweepAngles[e.id] = sweepAngle(r.prizeLifted && e.out ? { ...e, ...e.out } : e, r.sweep[e.id] ?? 0);
    const warn: Record<string, number> = {};
    for (const sg of frame.segments) if (!sg.live && sg.warn > (warn[sg.emitter] ?? 0)) warn[sg.emitter] = sg.warn;
    this.beams.reveal += ((r.obscura ? 1 : r.obscuraSeen ? 0.3 : 0) - this.beams.reveal) * (1 - Math.exp(-dt * 5));
    const target = r.targetMount();
    const playing = this.mode === "play";
    this.roomView.update(dt, {
      fed: frame.fed, emitterOn: frame.emitterOn, sweepAngles, targetMount: playing ? target : null, prizeLifted: r.prizeLifted, reduced,
      doorOpen: (id) => id === this.room.entry.id ? (r.phase === "case" || r.phase === "in") : r.exitOpen(id),
      beat: r.beat, shutterOpen: r.shutterOpen, plates: r.plates, obscura: r.obscura, warn
    });
    const sp = this.roomView.space;
    const lift = sp.floorY(L.floor) + (L.raised ? 0.45 : 0);
    this.roomView.watch(sp.at(L.pos.x, L.pos.z, 1.2, L.floor));
    const map = sp.side ? (x: number, z: number) => sp.at(x, z) : (x: number, z: number, y: number) => new THREE.Vector3(x, y + lift, z);
    const grade = this.celebrate >= 0 ? gradeFor(r.stats.time, this.room.parTime, r.threat, this.rewinds) : "";
    this.locke.update(dt, {
      pos: L.pos, vel: L.vel, facing: L.facing, pose: L.pose,
      stretchPoints: L.stretch.points, armY: L.stretch.armY, stretching: L.stretch.active, map,
      holding: L.stretch.holding, hasPrize: L.hasPrize, takeTimer: L.takeTimer, grace: L.grace,
      beat: r.beat, stepPhase: L.stepPhase, celebrate: this.celebrate, smug: grade === "Gentleman" && this.celebrate > 1.1,
      caught: r.phase === "lockdown", camYaw: this.stage.yaw
    });
    // Grace blink after a contact.
    this.locke.body.visible = !(L.grace > 0 && L.takeTimer <= 0 && Math.floor(this.time * 14) % 2 === 0 && r.phase !== "lockdown");
    this.prize.update(dt, { lifted: r.prizeLifted, holding: L.stretch.holding, hasPrize: L.hasPrize, hand: this.locke.handWorld, hat: this.locke.hatWorld });

    // Ghost preview of where the optic would land.
    let ghost: { x: number; z: number; angle: number } | null = null;
    const occupied = target ? r.optics.some((o) => o.mountId === target) : false;
    if (playing && target && !occupied && r.beltKind) {
      const m = this.room.mounts.find((mm) => mm.id === target)!;
      ghost = { x: m.x, z: m.z, angle: ((Math.round((L.facing + 90) / 15) * 15) % 360 + 360) % 360 };
    }
    this.optics.update(dt, r.optics, ghost);

    // HUD.
    if (playing) {
      const toScreen = (x: number, y: number, z: number) => {
        const v = new THREE.Vector3(x, y, z).project(this.stage.camera);
        return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
      };
      const prompt = null;
      this.ui.hudFrame({
        time: r.stats.time, casing: r.phase === "case", threat: r.threat, beat: r.beat, belt: r.belt, selected: r.selected,
        stretch: L.stretch.active ? 1 - L.stretch.length / STRETCH_MAX : null, prompt, reduced
      });
      document.documentElement.dataset.optic = occupied ? "1" : "0";
      const rm = this.room;
      this.ui.blueprint(rm.note && rm.author ? { title: ROOM_NAMES[rm.id] ?? rm.name, note: rm.note, author: rm.author, obscura: rm.obscura ? (r.obscura ? `Obscura open. ${this.ui.glyph("interact")} to close.` : `Camera obscura on the plinth: ${this.ui.glyph("interact")} to look from above.`) : undefined } : null, r.phase === "case");
      const trig = this.speechTrigger();
      const line = trig ? lineFor(this.room.id, trig) : null;
      if (line && trig !== this.lastSpoken) { this.lastSpoken = trig; this.audio.speak(line); }
      if (!line) this.lastSpoken = null;
      const head = toScreen(L.pos.x, 2.05, L.pos.z);
      this.ui.speech(line ? { x: head.x, y: head.y, text: line.text, glyph: line.glyph ? this.ui.glyph(line.glyph) : undefined } : null);
    }

    // Audio frame.
    const beamNear: Record<string, { d: number; pan: number }> = {};
    for (const s of frame.segments) {
      if (!s.live) continue;
      const d = pointSegDist(L.pos, s.a, s.b);
      const cur = beamNear[s.emitter];
      if (!cur || d < cur.d) {
        const t = Math.max(0, Math.min(1, ((L.pos.x - s.a.x) * (s.b.x - s.a.x) + (L.pos.z - s.a.z) * (s.b.z - s.a.z)) / Math.max(1e-6, (s.b.x - s.a.x) ** 2 + (s.b.z - s.a.z) ** 2)));
        beamNear[s.emitter] = { d, pan: this.panOf(s.a.x + (s.b.x - s.a.x) * t, s.a.z + (s.b.z - s.a.z) * t) };
      }
    }
    const unsolved = this.room.sensors.some((s) => !frame.fed.has(s.id)) && this.room.emitters.some((e) => e.poweredBy && emitterActive(e, r.world()));
    const hand = L.stretch.points[L.stretch.points.length - 1];
    this.audio.frame(dt, {
      beat: r.beat, running: this.mode !== "paused" && this.mode !== "press", phase: r.phase, emitterOn: frame.emitterOn, beamNear, sweepAngles, unsolved,
      nearPrize: r.prizeLifted ? 1 : Math.max(0, 1 - (dist(L.pos, r.prizePos) - 1.5) / 5),
      stretch: { active: L.stretch.active, length: L.stretch.length, moving: !!hand && L.stretch.active && !L.stretch.retracting }
    });
  }

}
