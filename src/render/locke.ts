import * as THREE from "three";
import type { V2 } from "../sim/math2d";
import type { Pose } from "../sim/run";
import { Hose } from "./hose";
import { Spring, ease } from "./spring";
import { inked } from "./toon";
import { DIM, applyModelOverrides, buildGlasses, buildGlove, buildHat, buildHead, buildShoe, buildTorso, mats, type Expression, type Slot } from "./lockeParts";

export interface LockeFrame {
  pos: V2; vel: V2; facing: number; pose: Pose;
  stretchPoints: V2[]; armY: number; stretching: boolean;
  holding: boolean; hasPrize: boolean;
  takeTimer: number; grace: number;
  beat: number; stepPhase: number;
  celebrate: number; // seconds since escape (−1 = not celebrating)
  smug: boolean;
  caught: boolean;
  camYaw: number;
}

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Z = v3(0, 0, 1);

/** Mr. Locke: rigid gloves, shoes, head and hat; everything between them is rubber hose. */
export class LockeView {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private hatPivot = new THREE.Group();
  private hat: THREE.Group;
  private glasses: THREE.Group;
  private eyes = new THREE.Group();
  private browL: THREE.Mesh; private browR: THREE.Mesh;
  private mouths: Record<Expression, THREE.Object3D>;
  private tailL: THREE.Object3D; private tailR: THREE.Object3D;
  private arms: [Hose, Hose];
  private legs: [Hose, Hose];
  private chain: Hose;
  private gloves: [THREE.Group, THREE.Group];
  private shoes: [THREE.Group, THREE.Group];
  private shadow: THREE.Mesh;
  readonly hatSparkle: THREE.Mesh;
  /** Swappable part slots (see lockeParts.ts / docs/locke-model-spec.md). */
  readonly slots: Partial<Record<Slot, THREE.Group>> = {};
  private cigar!: THREE.Group;
  private ember!: THREE.MeshBasicMaterial;
  private smoke!: THREE.Points;
  private tauntT = -1;
  private mood: Expression = "cool";
  private moodTimer = 0;

  // Secondary motion.
  private hip = new Spring(DIM.hipY, 5, 0.55);
  private lean = new Spring(0, 4, 0.6);
  private squash = new Spring(1, 5.5, 0.28);
  private thin = new Spring(1, 6, 0.35);
  private hatY = new Spring(0, 2.2, 0.32);
  private hatTilt = new Spring(0, 2.0, 0.3);
  private tails = new Spring(0, 3, 0.25);
  private chainSag = new Spring(0, 2.5, 0.2);
  private brow = new Spring(0, 7, 0.4);
  private pop = new Spring(0, 6, 0.35);
  private headTurn = new Spring(0, 3, 0.7);
  private lastHipVel = 0;
  private time = 0;
  private prevTake = 0;
  readonly handWorld = v3();
  readonly hatWorld = v3();

  constructor() {
    this.root.add(this.body);
    this.body.add(this.torso);
    this.torso.name = "pt_hips";
    const m = mats();

    const torsoPart = buildTorso(m);
    this.torso.add(torsoPart);
    this.slots.torso = torsoPart;
    // Short jacket tails.
    const tailGeo = new THREE.SphereGeometry(0.09, 14, 10);
    tailGeo.translate(0, -0.09, 0);
    const mkTail = (sx: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.07, 0.06, -0.1);
      const t = inked(tailGeo, m.suit, 0.008);
      t.scale.set(0.6, 1.0, 0.14);
      pivot.add(t);
      this.torso.add(pivot);
      return pivot;
    };
    this.tailL = mkTail(1); this.tailR = mkTail(-1);
    // Gold pocket-watch chain across the vest (chatoyant).
    this.chain = new Hose(14, 5);
    this.torso.add(new THREE.Mesh(this.chain.geometry, m.gold));
    const fob = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.007, 14), m.gold);
    fob.rotation.x = Math.PI / 2; fob.position.set(0.12, 0.22, 0.1);
    this.torso.add(fob);

    // Head on the neck attach point.
    this.head.name = "pt_neck";
    this.head.position.set(0, DIM.neckY, 0.01);
    this.torso.add(this.head);
    const neck = inked(new THREE.CylinderGeometry(0.045, 0.05, 0.09, 14), m.skin, 0.006);
    neck.position.y = -0.02;
    this.head.add(neck);
    const headParts = buildHead(m);
    this.head.add(headParts.group);
    this.slots.head = headParts.group;
    [this.browL, this.browR] = headParts.brows;
    this.mouths = headParts.mouths;
    this.cigar = headParts.cigar;
    this.ember = headParts.ember;
    // Smoke curl for the taunt.
    const n = 24;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.smoke = new THREE.Points(sg, new THREE.PointsMaterial({ color: "#eae4da", size: 0.13, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true }));
    this.smoke.frustumCulled = false;
    this.root.add(this.smoke);
    // Eyes hide behind the shades; the surprised take pops the glasses and shows them.
    for (const sx of [-1, 1]) {
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 10), m.white);
      white.scale.set(1, 1.2, 0.5); white.position.set(sx * 0.045, 0, 0);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 8), m.black);
      pupil.position.set(sx * 0.045, -0.003, 0.012);
      this.eyes.add(white, pupil);
    }
    this.eyes.position.set(0, DIM.headR * 1.18, DIM.eyesZ - 0.006);
    this.head.add(this.eyes);
    this.glasses = buildGlasses(m);
    const eyesPt = new THREE.Group(); eyesPt.name = "pt_eyes";
    eyesPt.position.set(0, DIM.headR * 1.18, DIM.eyesZ);
    eyesPt.add(this.glasses);
    this.head.add(eyesPt);
    this.slots.glasses = this.glasses;

    // Fedora (lags one beat behind the head).
    this.hatPivot.name = "pt_crown";
    this.hatPivot.position.set(0, DIM.crownY * 1.8, -0.005);
    this.head.add(this.hatPivot);
    this.hat = buildHat(m);
    this.hatPivot.add(this.hat);
    this.slots.hat = this.hat;
    this.hatSparkle = new THREE.Mesh(new THREE.OctahedronGeometry(0.018, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.8, 2.4), toneMapped: false }));
    this.hatSparkle.position.set(0.08, 0.05, 0.1);
    this.hatSparkle.visible = false;
    this.hat.add(this.hatSparkle);

    // Hose limbs (procedural: the stretch needs them).
    this.arms = [new Hose(26, 10), new Hose(64, 10)];
    this.legs = [new Hose(22, 10), new Hose(22, 10)];
    for (const h of this.arms) this.body.add(inked(h.geometry, m.sleeve, 0.009));
    for (const h of this.legs) this.body.add(inked(h.geometry, m.sleeve, 0.009));
    this.gloves = [buildGlove(m, 1), buildGlove(m, -1)];
    this.shoes = [buildShoe(m, 1), buildShoe(m, -1)];
    for (const g of [...this.gloves, ...this.shoes]) this.body.add(g);
    this.slots.glove_L = this.gloves[0]; this.slots.glove_R = this.gloves[1];
    this.slots.shoe_L = this.shoes[0]; this.slots.shoe_R = this.shoes[1];
    void applyModelOverrides(this.slots);
    void this.loadBust(headParts.group, neck);

    // Contact shadow.
    const sc = document.createElement("canvas");
    sc.width = sc.height = 64;
    const ctx = sc.getContext("2d")!;
    const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(0,0,0,0.75)"); grd.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 64);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.01;
    this.shadow.renderOrder = 2;
    this.root.add(this.shadow);
  }

  /** True when a sculpted bust (Meshy) is standing in for the procedural head, hat and glasses. */
  bustLoaded = false;

  private busts: Partial<Record<Expression, THREE.Group>> = {};
  private hatBase = DIM.crownY * 1.8;
  private chainZ = 0;

  /**
   * manifest "bust": hatless sculpted heads per expression, plus a separate "hat". They share one frame
   * (origin = underside of the hat brim), so the hat rides its own lagging pivot like the procedural one.
   */
  private async loadBust(procHead: THREE.Group, neck: THREE.Object3D) {
    let parts: { bust?: Partial<Record<Expression, string>>; hat?: string; torso?: string } | undefined;
    try { const r = await fetch("/models/locke/manifest.json"); if (!r.ok) return; parts = (await r.json())?.parts; } catch { return; }
    if (!parts?.bust?.cool) return;
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    const S = 0.58, BASE = 0.133;
    const load = async (file: string) => {
      const scene = (await loader.loadAsync("/models/locke/" + file)).scene;
      const g = new THREE.Group();
      scene.updateMatrixWorld(true);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const src = m.material as THREE.MeshStandardMaterial;
        const toon = new THREE.MeshToonMaterial({ map: src.map ?? null });
        if (toon.map) toon.map.colorSpace = THREE.SRGBColorSpace;
        const geo = m.geometry.clone();
        geo.applyMatrix4(m.matrixWorld);
        g.add(inked(geo, toon, 0.006));
      });
      g.scale.setScalar(S);
      return g;
    };
    try {
      for (const [e, file] of Object.entries(parts.bust) as Array<[Expression, string]>) {
        const g = await load(file);
        g.name = `slot_bust_${e}`;
        g.position.set(0, BASE, 0);
        g.visible = e === "cool";
        this.head.add(g);
        this.busts[e] = g;
      }
      if (parts.hat) {
        const hat = await load(parts.hat);
        hat.name = "slot_hat_mesh";
        this.hat.visible = false;
        this.hatPivot.add(hat);
        this.slots.hat = hat;
      }
      if (parts.torso) {
        // Armless jacket, 0.438 units collar-to-hem in model space → the rig's 0.6 m torso.
        const torso = await load(parts.torso);
        torso.scale.setScalar(0.6 / 0.438);
        const slot = this.slots.torso!;
        const pin = slot.getObjectByName("crown_pin");
        slot.visible = false;
        this.torso.add(torso);
        if (pin) { this.torso.add(pin); pin.position.z = 0.1; }
        this.chainZ = -0.045;
        this.slots.torso = torso;
      }
    } catch { return; }
    this.hatBase = BASE;
    this.slots.bust = this.busts.cool;
    procHead.visible = false;
    neck.visible = false;
    this.glasses.visible = false;
    this.cigar.visible = false;
    this.eyes.visible = false;
    this.bustLoaded = true;
  }

  /** Taunt: a slow puff on the cigar, a curl of smoke, a grin. Purely cosmetic. */
  taunt() { if (this.tauntT < 0) { this.tauntT = 0; this.react("grin", 2.4); } }
  get taunting() { return this.tauntT >= 0; }

  /** Hold an expression for a while (cool is the resting face). */
  react(e: Expression, seconds: number) { this.mood = e; this.moodTimer = seconds; }

  /** Squash impulse (boing on snap-back, landing). */
  boing(amount = 1) { this.squash.kick(-3.2 * amount); this.hatY.kick(1.4 * amount); }

  update(dt: number, f: LockeFrame) {
    this.time += dt;
    const yaw = Math.PI / 2 - (f.facing * Math.PI) / 180;
    this.root.position.set(f.pos.x, 0, f.pos.z);
    this.root.rotation.y = yaw;

    const speed = Math.hypot(f.vel.x, f.vel.z);
    const walkW = Math.min(1, speed / 1.6);
    const bounce = Math.pow(Math.abs(Math.sin(Math.PI * f.beat)), 0.7); // 0 on the beat
    const take = f.takeTimer > 0 ? 1 - f.takeTimer / 0.55 : -1;
    if (take >= 0 && this.prevTake < 0) { this.hatY.kick(9); this.pop.kick(14); this.brow.kick(18); this.squash.kick(6); }
    this.prevTake = take;

    // Hip height and lean per pose.
    let hipT = f.pose === "crouch" ? 0.42 : DIM.hipY;
    let leanT = f.pose === "crouch" ? 0.78 : 0.04 + walkW * 0.16;
    if (f.pose === "flatten") leanT = 0;
    if (f.stretching) { leanT = 0.24; hipT -= 0.07; }
    const idleBob = (1 - walkW) * (1 - bounce) * 0.04;
    const walkBob = walkW * Math.abs(Math.sin(f.stepPhase * Math.PI)) * 0.05;
    hipT += walkBob - idleBob;
    if (take >= 0) hipT += Math.sin(Math.min(1, take * 1.6) * Math.PI) * 0.45;
    if (f.caught) hipT = 0.6;
    const hipY = this.hip.step(hipT, dt);
    const hv = this.hip.v;
    const ha = (hv - this.lastHipVel) / Math.max(dt, 1e-4);
    this.lastHipVel = hv;
    this.lean.step(leanT, dt);

    // Squash/stretch: beat-locked idle squash + take stretch + boing.
    let sqT = 1 - (1 - walkW) * (1 - bounce) * 0.04;
    if (take >= 0 && take < 0.35) sqT = 1.35;
    const sq = this.squash.step(sqT, dt);
    const thin = this.thin.step(f.pose === "flatten" ? 0.16 : 1, dt);
    this.body.scale.set(thin / Math.sqrt(Math.max(0.5, sq)), Math.max(0.5, sq), 1 / Math.sqrt(Math.max(0.5, sq)));

    this.torso.position.set(0, hipY, 0);
    this.torso.rotation.x = this.lean.x;
    this.torso.rotation.z = f.pose === "flatten" ? 0 : Math.sin(f.stepPhase * Math.PI) * 0.05 * walkW;

    // Head: looks toward camera when smug, nods on beat when idle.
    const camLocal = f.camYaw - yaw; // radians
    const wantTurn = f.smug ? Math.atan2(Math.sin(camLocal), Math.cos(camLocal)) * 0.6 : 0;
    this.head.rotation.y = this.headTurn.step(wantTurn, dt);
    this.head.rotation.x = -this.lean.x * 0.6 + (1 - walkW) * (1 - bounce) * 0.05;
    // Expressions from the sheet: cool (rest), grin (success), surprised (beam contact), serious (later venues).
    this.moodTimer = Math.max(0, this.moodTimer - dt);
    let mood: Expression = this.moodTimer > 0 ? this.mood : "cool";
    if (take >= 0 || f.caught) mood = "surprised";
    else if (f.celebrate >= 0 || f.smug) mood = "grin";
    for (const k of Object.keys(this.mouths) as Expression[]) this.mouths[k].visible = k === mood;
    if (this.bustLoaded) { const show = this.busts[mood] ? mood : "cool"; for (const [k, g] of Object.entries(this.busts)) g!.visible = k === show; }
    const browT = mood === "surprised" ? 0.035 : mood === "grin" ? 0.012 : mood === "serious" ? -0.01 : 0;
    const br = this.brow.step(browT, dt);
    const by = DIM.headR * 1.58;
    this.browL.position.y = by + br; this.browR.position.y = by + br * (f.smug ? 0.3 : 1);
    this.browL.rotation.z = mood === "serious" ? -0.3 : f.smug ? 0.3 : 0.08;
    this.browR.rotation.z = mood === "serious" ? 0.3 : -0.08;
    const pop = this.pop.step(mood === "surprised" ? 0.05 : 0, dt);
    this.glasses.position.y = pop;
    this.eyes.visible = !this.bustLoaded && pop > 0.012;

    // Hat: lags a beat, flies on a take.
    const hatLift = this.hatY.step(0, dt) + -ha * 0.00025;
    let hatOff = Math.max(-0.02, hatLift * 0.06);
    let hatTip = 0;
    if (f.celebrate >= 0) {
      const c = Math.min(1, f.celebrate / 1.1);
      hatTip = Math.sin(c * Math.PI);
      hatOff += hatTip * 0.13;
    }
    this.hatPivot.position.y = this.hatBase + hatOff;
    this.hatPivot.rotation.x = this.hatTilt.step(-this.lean.x * 0.3 + walkW * 0.08, dt) - hatTip * 0.5;
    this.hat.rotation.z = 0.14 + Math.sin(this.time * 1.3) * 0.01;
    this.hatSparkle.visible = f.hasPrize;
    if (f.hasPrize) { this.hatSparkle.rotation.y += dt * 4; this.hatSparkle.scale.setScalar(0.7 + 0.5 * Math.abs(Math.sin(this.time * 3))); }

    // Coat tails & chain overlap.
    const tail = this.tails.step(-0.12 - walkW * 0.45 - Math.max(0, hv) * 0.2, dt);
    this.tailL.rotation.x = tail + Math.sin(this.time * 9) * 0.04 * walkW;
    this.tailR.rotation.x = tail + Math.sin(this.time * 9 + 1.3) * 0.04 * walkW;
    const sag = this.chainSag.step(0.035 + walkW * 0.01, dt);
    this.chainSag.kick(-hv * dt * 3);
    const cz = this.chainZ;
    this.chain.bezier(v3(0, 0.3, 0.14 + cz), v3(0.03, 0.3 - sag * 1.6, 0.152 + cz), v3(0.09, 0.24 - sag, 0.14 + cz), v3(0.12, 0.22, 0.1 + cz), 0.005, 0.005);

    this.torso.updateMatrix();
    this.head.updateMatrix();
    const T = this.torso.matrix;
    const shoulder = (sx: number) => v3(sx * DIM.shoulderX, DIM.shoulderY, 0.0).applyMatrix4(T);
    const hipA = (sx: number) => v3(sx * DIM.hipX, 0.04, 0).applyMatrix4(T);

    // Feet: tip-toe gait on eighth notes; planted wide while reaching.
    const stride = 0.42;
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? 1 : -1;
      const p = (((f.stepPhase / 2 + i * 0.5) % 1) + 1) % 1;
      let fz = 0, fy = 0, pitch = 0;
      if (walkW > 0.02 && !f.stretching) {
        if (p < 0.5) { const u = ease.inOut(p / 0.5); fz = (-stride / 2 + stride * u) * walkW; fy = Math.sin(Math.PI * (p / 0.5)) * 0.16 * walkW; pitch = 0.5; }
        else { const u = (p - 0.5) / 0.5; fz = (stride / 2 - stride * u) * walkW; pitch = 0.45 * walkW; }
      }
      let fx = sx * (f.pose === "crouch" ? 0.2 : 0.1);
      if (f.stretching) { fx = sx * 0.17; fz = sx * 0.06; }
      if (take >= 0) { fy += Math.sin(Math.min(1, take * 1.6) * Math.PI) * 0.26; pitch = 0.8; }
      const ankle = v3(fx, 0.06 + fy + pitch * 0.03, fz);
      const shoe = this.shoes[i]!;
      shoe.position.set(ankle.x, ankle.y - 0.06, ankle.z);
      shoe.rotation.set(pitch, 0, 0);
      const h = hipA(sx);
      const legLen = h.distanceTo(ankle);
      const bow = f.pose === "crouch" ? v3(sx * 0.26, 0, 0.2) : v3(sx * 0.02, 0, 0.08 + walkW * 0.05);
      this.legs[i]!.bezier(h, h.clone().add(v3(bow.x, -legLen * 0.38, bow.z)), ankle.clone().add(v3(bow.x * 0.7, legLen * 0.38, bow.z * 0.7)), ankle.clone().add(v3(0, 0.0, -0.01)), 0.036, 0.032);
    }

    // Hands.
    const handTargets: THREE.Vector3[] = [];
    const swing = Math.sin(f.stepPhase * Math.PI);
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? 1 : -1;
      let t: THREE.Vector3;
      if (take >= 0) t = v3(sx * 0.48, hipY + 1.15 + Math.sin(take * 20) * 0.03, 0.06);
      else if (f.caught) t = v3(sx * 0.32, hipY + 0.1, 0.12);
      else if (f.pose === "flatten") t = v3(sx * 0.22, hipY - 0.04, 0.02);
      else if (f.pose === "crouch") t = v3(sx * 0.27, hipY + 0.2, 0.42 + swing * sx * 0.05 * walkW);
      else {
        const idle = v3(sx * 0.27, hipY + 0.02 + (1 - bounce) * 0.02, 0.04 + Math.sin(f.beat * Math.PI) * 0.02 * sx);
        const sneak = v3(sx * 0.17, hipY + 0.5 + swing * sx * 0.05, 0.28);
        t = idle.lerp(sneak, walkW);
      }
      handTargets.push(t);
    }
    // Left hand steadies the hat while reaching; right hand tips it on success.
    this.hatPivot.updateMatrixWorld(true);
    const hatBody = v3(0.08, DIM.crownY * 1.8 + 0.04, 0.06).applyMatrix4(this.head.matrix).applyMatrix4(T);
    if (f.stretching) handTargets[0] = hatBody.clone().add(v3(0.05, 0.12, 0.02));
    if (f.celebrate >= 0 && f.celebrate < 1.1) handTargets[1] = hatBody.clone().add(v3(-0.16, 0.1 + Math.sin(Math.min(1, f.celebrate / 1.1) * Math.PI) * 0.13, 0.06));

    // Taunt timeline: 0–0.5 hand up, 0.5–1.1 puff (ember flares), 1.1–2.4 smoke drifts.
    if (this.tauntT >= 0) {
      this.tauntT += dt;
      const t = this.tauntT;
      const mouth = v3(-0.03, DIM.headR * 0.5, DIM.headR * 1.3).applyMatrix4(this.head.matrix).applyMatrix4(T);
      if (t < 1.3 && !f.stretching) handTargets[1] = handTargets[1]!.clone().lerp(mouth.add(v3(-0.06, -0.02, 0.04)), Math.sin(Math.min(1, t / 1.3) * Math.PI));
      const puff = t > 0.5 && t < 1.1 ? Math.sin(((t - 0.5) / 0.6) * Math.PI) : 0;
      this.ember.color.setRGB(2.2 + puff * 5, 0.7 + puff * 1.6, 0.2 + puff * 0.4);
      const pos = this.smoke.geometry.attributes.position as THREE.BufferAttribute;
      const mw = v3(-0.03 + 0.08, DIM.headR * 0.5, DIM.headR * 1.1).applyMatrix4(this.head.matrix).applyMatrix4(T);
      for (let k = 0; k < pos.count; k++) {
        const age = t - 1.0 - k * 0.035;
        const a = Math.max(0, age);
        pos.setXYZ(k, mw.x + Math.sin(a * 3 + k) * 0.04 * a, mw.y + a * 0.35, mw.z + Math.cos(a * 2.3 + k) * 0.04 * a + a * 0.05);
      }
      pos.needsUpdate = true;
      (this.smoke.material as THREE.PointsMaterial).opacity = t > 1.0 ? Math.max(0, 0.85 * (1 - (t - 1.0) / 1.4)) : 0;
      if (t > 2.4) this.tauntT = -1;
    }
    if (!this.bustLoaded) this.cigar.visible = !this.eyes.visible || this.tauntT >= 0;

    this.root.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? 1 : -1;
      const s = shoulder(sx);
      const glove = this.gloves[i]!;
      const tan = v3();
      if (i === 1 && f.stretching && f.stretchPoints.length > 1) {
        // The reach: a smooth hose through the sim's path.
        const pts: THREE.Vector3[] = [s];
        const inv = new THREE.Matrix4().copy(this.body.matrixWorld).invert();
        const n = f.stretchPoints.length;
        const stepN = Math.max(1, Math.floor(n / 24));
        for (let k = 1; k < n; k += stepN) {
          const w = f.stretchPoints[k]!;
          pts.push(v3(w.x, f.armY, w.z).applyMatrix4(inv));
        }
        const last = f.stretchPoints[n - 1]!;
        const lastLocal = v3(last.x, f.armY, last.z).applyMatrix4(inv);
        if (pts[pts.length - 1]!.distanceTo(lastLocal) > 1e-3) pts.push(lastLocal);
        if (pts.length === 2) pts.splice(1, 0, s.clone().lerp(lastLocal, 0.5).add(v3(0, 0.04, 0)));
        // Lift the first stretch out of the shoulder so it never kinks.
        if (pts.length > 2) pts[1]!.y = (pts[1]!.y + s.y) / 2;
        this.arms[1].through(pts, 0.028, 0.028);
        this.arms[1].end(glove.position);
        this.arms[1].endTangent(tan);
      } else {
        const h = handTargets[i]!;
        const out = v3(sx * 0.12, -0.14, 0.02);
        this.arms[i]!.bezier(s, s.clone().add(out), h.clone().add(v3(sx * 0.05, -0.16, -0.06)), h, 0.03, 0.028);
        this.arms[i]!.end(glove.position);
        this.arms[i]!.endTangent(tan);
      }
      glove.quaternion.setFromUnitVectors(Z, tan.normalize());
    }
    this.gloves[1].getWorldPosition(this.handWorld);
    this.hatPivot.getWorldPosition(this.hatWorld);

    this.shadow.scale.setScalar(1 - (hipY - DIM.hipY) * 0.6);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.9 - Math.max(0, hipY - DIM.hipY);
  }
}
