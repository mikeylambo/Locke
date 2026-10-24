import * as THREE from "three";
import { BrowserStorage, SaveManager, SettingsStore } from "@slu/web-shell";
import { AudioEngine } from "../audio/engine";
import { Input, type InputFrame } from "../input/input";
import { BeamView } from "../render/beams";
import { LockeView } from "../render/locke";
import { OpticsView, PrizeView } from "../render/props";
import { RoomView } from "../render/room";
import { Stage, type Quality } from "../render/stage";
import { toonLights } from "../render/toon";
import { emitterActive, sweepAngle } from "../sim/beams";
import { dist, pointSegDist, v2 } from "../sim/math2d";
import { DT, HeistRun, emptyInput, STRETCH_MAX, type SimEvent, type SimInput } from "../sim/run";
import type { RoomDef } from "../sim/roomTypes";
import { UI, type MenuItem } from "../ui/ui";
import { loadRoom } from "./rooms";

interface Settings {
  masterVolume: number; musicVolume: number; sfxVolume: number;
  reducedMotion: boolean; cameraSensitivity: number; quality: "Auto" | "High" | "Low";
}
const DEFAULTS: Settings = { masterVolume: 0.9, musicVolume: 0.75, sfxVolume: 0.9, reducedMotion: false, cameraSensitivity: 0.5, quality: "Auto" };

interface RoomRecord { bestTime?: number; bestGrade?: string; bestClearance?: number; clears: number }
interface Progress { rooms: Record<string, RoomRecord> }

const GRADE_ORDER = ["C", "B", "A", "S", "Gentleman"];

export function gradeFor(time: number, par: number, alarms: number): string {
  if (alarms === 0 && time <= par) return "Gentleman";
  if (alarms === 0 && time <= par * 1.5) return "S";
  if (alarms <= 1 && time <= par * 2) return "A";
  if (alarms <= 2) return "B";
  return "C";
}

type Mode = "press" | "title" | "play" | "paused" | "results" | "caught";

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
  private hintTimer = 0;
  private frameTimes: number[] = [];
  private qualityLocked = false;
  private photo: string | undefined;
  private wantPhoto = false;
  private pendingEdges: SimInput = emptyInput();

  constructor(private canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    const storage = new BrowserStorage("light-fingers");
    this.settings = new SettingsStore<Settings>(storage, "settings", { ...DEFAULTS });
    this.save = new SaveManager<Progress>(storage, "progress", 1);
    const q: Quality = matchMedia("(pointer: coarse)").matches ? "low" : "high";
    this.stage = new Stage(canvas, q);
    this.input = new Input(canvas, uiRoot);
    this.ui = new UI(uiRoot, (id) => this.audio.play(id));
    this.input.onDevice((d) => this.ui.setDevice(d));
    this.ui.setDevice(this.input.device);
    this.stage.scene.add(this.beams.group, this.locke.root);
  }

  async boot() {
    try { await this.settings.load(); } catch { /* defaults */ }
    try { const r = await this.save.loadWithRecovery(); if (r.data) this.progress = r.data; } catch { /* fresh */ }
    this.applySettings();
    this.loadRoom(await loadRoom("room-zero"));
    const go = this.ui.pressStart(() => this.toTitle(true));
    const anyKey = (e: Event) => { if (this.mode === "press") { e.preventDefault(); go(); } };
    addEventListener("keydown", anyKey, { once: true });
    requestAnimationFrame((t) => this.frame(t));
    if (import.meta.env.DEV || location.search.includes("debug")) (window as unknown as { game: Game }).game = this;
  }

  private applySettings() {
    const s = this.settings.snapshot();
    this.audio.setVolumes({ master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume });
    this.input.sensitivity = 0.4 + s.cameraSensitivity * 1.4;
    document.documentElement.classList.toggle("reduced", s.reducedMotion);
    const want: Quality | null = s.quality === "High" ? "high" : s.quality === "Low" ? "low" : null;
    if (want && want !== this.stage.quality) { this.stage.setQuality(want); this.rebuildRoom(); }
    this.qualityLocked = s.quality !== "Auto";
  }

  private loadRoom(def: RoomDef) {
    this.room = def;
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
  }

  private newRun() {
    this.run = new HeistRun(this.room);
    this.acc = 0;
    this.celebrate = -1;
    this.resultsTimer = -1;
    this.photo = undefined;
    this.prize.group.position.copy(this.prize.restPos);
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
    this.ui.title(() => this.startPlay(), () => this.openSettings(), best);
  }

  private startPlay() {
    this.audio.unlock();
    this.ui.closeAll();
    this.mode = "play";
    this.newRun();
    this.ui.showHud(true);
    this.ui.showHint(true);
    this.hintTimer = 0;
    this.stage.snap();
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
    this.ui.pause(() => this.resume(), () => this.restart(), () => this.openSettings(), () => { this.audio.setPaused(false); this.toTitle(); });
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
      { id: "motion", label: "Reduced Motion", kind: "toggle", get: () => s.get("reducedMotion"), set: (v) => patch({ reducedMotion: v as boolean }) },
      { id: "quality", label: "Quality", kind: "choice", choices: ["Auto", "High", "Low"], get: () => s.get("quality"), set: (v) => patch({ quality: v as Settings["quality"] }) }
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

    if (this.ui.open && this.mode !== "play") this.ui.handle(f);

    // Simulation.
    if (this.mode === "title") {
      this.stepSim(emptyInput(), dt);
      this.stage.orbit(dt * (reduced ? 0.02 : 0.06), 0);
      this.stage.focus(0, 0, 0);
    } else if (this.mode === "play" || this.mode === "results" || this.mode === "caught") {
      if (this.mode === "play") {
        if (f.pause) { this.pause(); }
        else if (f.restart) { this.restart(); }
      }
      if (this.mode === "play" || this.mode === "results" || this.mode === "caught") {
        this.cameraInput(f);
        this.stepSim(this.mode === "play" ? this.simInput(f) : emptyInput(), dt);
      }
      this.stage.focus(this.run.locke.pos.x, this.run.locke.pos.z, 0.3);
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

    // Hint card fades once the run is underway.
    if (this.mode === "play") {
      if (this.run.phase !== "case") this.hintTimer += dt;
      this.ui.showHint(this.hintTimer < 4);
    }

    this.present(dt, reduced);
    this.stage.update(dt, reduced);
    this.roomView.updateCutaway(new THREE.Vector3().subVectors(this.stage.camera.position, this.stage.target).setY(0).normalize(), dt);
    this.prize.face(this.stage.camera);
    this.stage.setFocusWorld(new THREE.Vector3(this.run.locke.pos.x, 0.7, this.run.locke.pos.z));
    this.stage.render();
    if (this.wantPhoto) { this.wantPhoto = false; try { this.photo = this.canvas.toDataURL("image/jpeg", 0.8); } catch { /* tainted/unsupported */ } }
    this.autoQuality(dt);
  }

  private cameraInput(f: InputFrame) {
    if (f.orbit.dx || f.orbit.dy) this.stage.orbit(-f.orbit.dx, f.orbit.dy);
    if (f.snap) this.stage.snapStep(f.snap);
    const casing = this.run.phase === "case";
    if (!f.orbiting && this.wasOrbiting && !casing) this.stage.snap();
    this.wasOrbiting = f.orbiting;
  }

  private simInput(f: InputFrame): SimInput {
    const b = this.stage.basis();
    const mv = v2(b.right.x * f.move.x + b.fwd.x * f.move.y, b.right.z * f.move.x + b.fwd.z * f.move.y);
    return { move: mv, stretch: f.stretch, crouch: f.crouch, flatten: f.flatten, interact: f.interact, rotate: f.rotate, cycle: f.cycle };
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
      this.acc -= DT;
      steps++;
    }
    if (steps === 12) this.acc = 0;
  }

  private panOf(x: number, z: number) {
    const b = this.stage.basis();
    const dx = x - this.stage.target.x, dz = z - this.stage.target.z;
    return Math.max(-1, Math.min(1, (dx * b.right.x + dz * b.right.z) / 6));
  }

  private onEvent(e: SimEvent) {
    const L = this.run.locke;
    const pan = this.panOf(L.pos.x, L.pos.z);
    switch (e.type) {
      case "step": this.audio.play("step", { pan }); break;
      case "contact": {
        this.audio.play("contact", { pan });
        this.beams.flash.set(e.emitter, 0.45);
        this.stage.kick(1);
        this.ui.flash("contact");
        this.input.rumble(0.8, 220);
        toonLights.flash.value = 1;
        if (e.threat === 1) this.ui.toast("Disturbed");
        if (e.threat === 2) this.ui.toast("Alert");
        break;
      }
      case "lift":
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
      case "exit.closed": this.audio.play("exit.closed"); this.ui.toast("Exit sealed"); break;
      default: this.audio.play(e.type, { pan });
    }
  }

  private showResults() {
    const s = this.run.stats;
    const grade = gradeFor(s.time, this.room.parTime, s.alarms);
    const rec = this.progress.rooms[this.room.id] ?? { clears: 0 };
    const best = rec.bestTime === undefined || s.time < rec.bestTime;
    rec.clears++;
    if (best) rec.bestTime = s.time;
    if (!rec.bestGrade || GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(rec.bestGrade)) rec.bestGrade = grade;
    if (Number.isFinite(s.clearance) && (rec.bestClearance === undefined || s.clearance < rec.bestClearance)) rec.bestClearance = s.clearance;
    this.progress.rooms[this.room.id] = rec;
    void this.save.save(this.progress).catch(() => {});
    this.mode = "results";
    this.ui.showHud(false);
    this.ui.results({ headline: this.room.headline, prize: this.room.prize.name, time: s.time, par: this.room.parTime, alarms: s.alarms, clearance: s.clearance, value: s.value, grade, best, photo: this.photo },
      () => this.restart(), () => this.toTitle());
  }

  private present(dt: number, reduced: boolean) {
    const r = this.run;
    const L = r.locke;
    const frame = r.frame;
    toonLights.flash.value = Math.max(0, toonLights.flash.value - dt * 4);
    this.beams.update(frame.segments, dt, this.time);
    const sweepAngles: Record<string, number> = {};
    for (const e of this.room.emitters) if (e.type === "sweeper") sweepAngles[e.id] = sweepAngle(e, r.sweep[e.id] ?? 0);
    const target = r.targetMount();
    const playing = this.mode === "play";
    this.roomView.update(dt, {
      fed: frame.fed, emitterOn: frame.emitterOn, sweepAngles, targetMount: playing ? target : null, prizeLifted: r.prizeLifted, reduced,
      doorOpen: (id) => id === this.room.entry.id ? (r.phase === "case" || r.phase === "in") : r.exitOpen(id)
    });
    const grade = this.celebrate >= 0 ? gradeFor(r.stats.time, this.room.parTime, r.threat) : "";
    this.locke.update(dt, {
      pos: L.pos, vel: L.vel, facing: L.facing, pose: L.pose,
      stretchPoints: L.stretch.points, armY: L.stretch.armY, stretching: L.stretch.active,
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
      let prompt: { x: number; y: number; verb: string } | null = null;
      const toScreen = (x: number, y: number, z: number) => {
        const v = new THREE.Vector3(x, y, z).project(this.stage.camera);
        return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
      };
      if (r.canGrabPrize()) { const p = toScreen(r.prizePos.x, 1.55, r.prizePos.z); prompt = { ...p, verb: "Lift" }; }
      else if (target) {
        const m = this.room.mounts.find((mm) => mm.id === target)!;
        const p = toScreen(m.x, occupied ? 2.15 : 0.5, m.z);
        if (occupied) prompt = { ...p, verb: `Take <kbd>${this.ui.device === "pad" ? "LB/RB" : this.ui.device === "touch" ? "⟲⟳" : "Q/E"}</kbd>Turn` };
        else if (r.beltKind) prompt = { ...p, verb: "Place" };
      }
      this.ui.hudFrame({
        time: r.stats.time, casing: r.phase === "case", threat: r.threat, beat: r.beat, belt: r.belt, selected: r.selected,
        stretch: L.stretch.active ? 1 - L.stretch.length / STRETCH_MAX : null, prompt, reduced
      });
      document.documentElement.dataset.optic = occupied ? "1" : "0";
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

  private autoQuality(dt: number) {
    if (this.qualityLocked || this.mode !== "play" || this.stage.quality === "low") return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 240) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 1 / 48) { this.stage.setQuality("low"); this.rebuildRoom(); }
  }
}
