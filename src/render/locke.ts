import * as THREE from "three";
import type { V2 } from "../sim/math2d";
import type { Pose } from "../sim/run";
import { Hose } from "./hose";
import { P } from "./palette";
import { Spring, ease } from "./spring";
import { inked, toonMaterial } from "./toon";

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
  private hat = new THREE.Group();
  private glasses = new THREE.Group();
  private browL: THREE.Mesh; private browR: THREE.Mesh;
  private tailL: THREE.Object3D; private tailR: THREE.Object3D;
  private arms: [Hose, Hose];
  private legs: [Hose, Hose];
  private chain: Hose;
  private gloves: [THREE.Group, THREE.Group];
  private shoes: [THREE.Group, THREE.Group];
  private shadow: THREE.Mesh;
  readonly hatSparkle: THREE.Mesh;

  // Secondary motion.
  private hip = new Spring(0.5, 5, 0.55);
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
    const suit = toonMaterial({ color: P.suit, shade: "#56506a", stripes: 26, stripeColor: "#7f7787", stripeMode: 0, gloss: 0.15 });
    const sleeve = toonMaterial({ color: P.suit, shade: "#56506a", stripes: 5, stripeColor: "#7f7787", stripeMode: 1, gloss: 0.1 });
    const cream = toonMaterial({ color: P.cream, shade: "#b49a86", gloss: 0.2 });
    const white = toonMaterial({ color: P.glove, shade: "#b9b0c2", gloss: 0.35 });
    const black = toonMaterial({ color: "#121015", shade: "#2a2433", gloss: 0.6, rim: 0.8 });
    const gold = toonMaterial({ color: P.gold, shade: "#7b5320", gloss: 1.2, emissive: "#2a1a04" });
    const brown = toonMaterial({ color: P.brown, shade: "#3b2414", gloss: 0.3 });
    const hatMat = toonMaterial({ color: "#1d1b21", shade: "#3c3546", gloss: 0.3, rim: 0.35 });

    // Torso: a pear-shaped bean.
    const prof = [[0, 0], [0.13, 0.01], [0.2, 0.08], [0.215, 0.17], [0.2, 0.3], [0.165, 0.42], [0.12, 0.5], [0.05, 0.555], [0, 0.56]].map(([r, y]) => new THREE.Vector2(r!, y!));
    const torsoMesh = inked(new THREE.LatheGeometry(prof, 28), suit, 0.014);
    torsoMesh.scale.set(1, 1, 0.86);
    this.torso.add(torsoMesh);
    const shirt = inked(new THREE.SphereGeometry(0.1, 18, 14), cream, 0.008);
    shirt.scale.set(0.8, 1.15, 0.35);
    shirt.position.set(0, 0.41, 0.15);
    this.torso.add(shirt);
    const tieGeo = new THREE.ConeGeometry(0.035, 0.16, 4);
    const tie = inked(tieGeo, brown, 0.006);
    tie.rotation.x = Math.PI; tie.scale.set(1, 1, 0.4);
    tie.position.set(0, 0.38, 0.185);
    this.torso.add(tie);
    const knot = inked(new THREE.SphereGeometry(0.022, 10, 8), brown, 0.005);
    knot.position.set(0, 0.47, 0.17);
    this.torso.add(knot);
    // The gold crown tie pin.
    const crown = new THREE.Group();
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.012, 0.01), gold);
    crown.add(band);
    for (let i = -1; i <= 1; i++) {
      const pt = new THREE.Mesh(new THREE.ConeGeometry(0.007, 0.022, 4), gold);
      pt.position.set(i * 0.014, 0.016, 0);
      crown.add(pt);
    }
    crown.position.set(0, 0.4, 0.2);
    this.torso.add(crown);
    for (const y of [0.24, 0.16]) {
      const btn = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), gold);
      btn.position.set(0, y, 0.192);
      this.torso.add(btn);
    }
    // Coat tails.
    const tailGeo = new THREE.SphereGeometry(0.1, 14, 10);
    tailGeo.translate(0, -0.1, 0);
    const mkTail = (sx: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.07, 0.07, -0.15);
      const t = inked(tailGeo, suit, 0.01);
      t.scale.set(0.55, 1.15, 0.16);
      pivot.add(t);
      this.torso.add(pivot);
      return pivot;
    };
    this.tailL = mkTail(1); this.tailR = mkTail(-1);
    // Watch chain.
    this.chain = new Hose(14, 5);
    const chainMesh = new THREE.Mesh(this.chain.geometry, gold);
    this.torso.add(chainMesh);
    const watchPocket = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.008, 14), gold);
    watchPocket.rotation.x = Math.PI / 2;
    watchPocket.position.set(0.15, 0.13, 0.13);
    this.torso.add(watchPocket);

    // Head.
    this.head.position.set(0, 0.7, 0.02);
    this.torso.add(this.head);
    const headMesh = inked(new THREE.SphereGeometry(0.17, 28, 20), cream, 0.012);
    headMesh.scale.set(1, 1.05, 0.95);
    this.head.add(headMesh);
    for (const sx of [-1, 1]) {
      const ear = inked(new THREE.SphereGeometry(0.045, 12, 10), cream, 0.008);
      ear.scale.set(0.5, 1, 0.8);
      ear.position.set(sx * 0.165, 0.0, -0.01);
      this.head.add(ear);
    }
    // Round sunglasses with gold rims.
    for (const sx of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.02, 24), black);
      lens.rotation.x = Math.PI / 2;
      lens.position.set(sx * 0.065, 0, 0);
      this.glasses.add(lens);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.009, 8, 28), gold);
      rim.position.set(sx * 0.065, 0, 0.008);
      this.glasses.add(rim);
      const glint = new THREE.Mesh(new THREE.CircleGeometry(0.012, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(2), toneMapped: false }));
      glint.position.set(sx * 0.065 - 0.022, 0.022, 0.012);
      this.glasses.add(glint);
    }
    const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6), gold);
    bridge.rotation.z = Math.PI / 2;
    bridge.position.set(0, 0.012, 0.004);
    this.glasses.add(bridge);
    this.glasses.position.set(0, 0.025, 0.158);
    this.head.add(this.glasses);
    const browGeo = new THREE.CapsuleGeometry(0.009, 0.05, 4, 8);
    browGeo.rotateZ(Math.PI / 2);
    this.browL = new THREE.Mesh(browGeo, black); this.browR = new THREE.Mesh(browGeo, black);
    this.browL.position.set(0.065, 0.1, 0.15); this.browR.position.set(-0.065, 0.1, 0.15);
    this.head.add(this.browL, this.browR);
    const nose = inked(new THREE.SphereGeometry(0.03, 12, 10), toonMaterial({ color: "#d9a98a", shade: "#9a6a5a", gloss: 0.6 }), 0.006);
    nose.scale.set(1, 0.8, 0.9);
    nose.position.set(0, -0.035, 0.175);
    this.head.add(nose);
    for (const sx of [-1, 1]) {
      const mo = new THREE.Mesh(new THREE.CapsuleGeometry(0.008, 0.035, 4, 8), black);
      mo.rotation.z = Math.PI / 2 + sx * 0.25;
      mo.position.set(sx * 0.024, -0.064, 0.166);
      this.head.add(mo);
    }
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.007, 6, 18, Math.PI * 0.55), black);
    smile.rotation.set(0.2, 0, Math.PI + 0.55);
    smile.position.set(0.012, -0.075, 0.152);
    this.head.add(smile);

    // Fedora (lags one beat behind the head).
    this.hatPivot.position.set(0, 0.12, -0.005);
    this.head.add(this.hatPivot);
    this.hatPivot.add(this.hat);
    const brimProf = [[0, 0], [0.2, 0.0], [0.255, 0.018], [0.27, 0.035], [0.262, 0.03], [0.2, 0.012], [0, 0.012]].map(([r, y]) => new THREE.Vector2(r!, y!));
    const brim = inked(new THREE.LatheGeometry(brimProf, 32), hatMat, 0.008);
    brim.scale.set(1, 1, 0.92);
    this.hat.add(brim);
    const crownProf = [[0, 0.17], [0.07, 0.165], [0.12, 0.14], [0.145, 0.08], [0.15, 0.0], [0, 0]].map(([r, y]) => new THREE.Vector2(r!, y!));
    const crownMesh = inked(new THREE.LatheGeometry(crownProf, 28), hatMat, 0.01);
    crownMesh.scale.set(1, 1, 0.88);
    this.hat.add(crownMesh);
    const hatBand = new THREE.Mesh(new THREE.CylinderGeometry(0.151, 0.153, 0.035, 28, 1, true), brown);
    hatBand.scale.set(1, 1, 0.88);
    hatBand.position.y = 0.03;
    this.hat.add(hatBand);
    const pinch = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.18), toonMaterial({ color: "#0c0b0e", gloss: 0 }));
    pinch.position.set(0, 0.165, 0);
    this.hat.add(pinch);
    this.hat.rotation.z = 0.14;
    this.hatSparkle = new THREE.Mesh(new THREE.OctahedronGeometry(0.02, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.8, 2.4), toneMapped: false }));
    this.hatSparkle.position.set(0.1, 0.06, 0.12);
    this.hatSparkle.visible = false;
    this.hat.add(this.hatSparkle);

    // Hose limbs.
    this.arms = [new Hose(26, 10), new Hose(64, 10)];
    this.legs = [new Hose(22, 10), new Hose(22, 10)];
    for (const h of this.arms) this.body.add(inked(h.geometry, sleeve, 0.01));
    for (const h of this.legs) this.body.add(inked(h.geometry, sleeve, 0.01));

    // Gloves: puffy cartoon mitts with cuff flares and stitched backs.
    const mkGlove = (sx: number) => {
      const g = new THREE.Group();
      const palm = inked(new THREE.SphereGeometry(0.07, 18, 14), white, 0.011);
      palm.scale.set(1, 0.72, 1.12);
      palm.position.z = 0.055;
      g.add(palm);
      const thumb = inked(new THREE.SphereGeometry(0.03, 12, 10), white, 0.008);
      thumb.scale.set(0.8, 0.8, 1.3);
      thumb.position.set(sx * 0.06, 0.012, 0.04);
      g.add(thumb);
      const cuff = inked(new THREE.CylinderGeometry(0.06, 0.045, 0.05, 18), white, 0.009);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.z = -0.005;
      g.add(cuff);
      for (const off of [-0.02, 0, 0.02]) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.003, 0.045), black);
        st.position.set(off, 0.05, 0.05);
        g.add(st);
      }
      this.body.add(g);
      return g;
    };
    this.gloves = [mkGlove(1), mkGlove(-1)];
    // Two-tone spectator shoes.
    const mkShoe = () => {
      const g = new THREE.Group();
      const toe = inked(new THREE.SphereGeometry(0.07, 18, 12), black, 0.01);
      toe.scale.set(0.85, 0.62, 1.35);
      toe.position.set(0, 0.035, 0.06);
      g.add(toe);
      const spat = inked(new THREE.SphereGeometry(0.06, 16, 12), cream, 0.009);
      spat.scale.set(0.9, 0.85, 1.0);
      spat.position.set(0, 0.05, -0.02);
      g.add(spat);
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.012, 0.22), black);
      sole.position.set(0, 0.006, 0.03);
      g.add(sole);
      g.scale.setScalar(1.3);
      this.body.add(g);
      return g;
    };
    this.shoes = [mkShoe(), mkShoe()];

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
    let hipT = f.pose === "crouch" ? 0.28 : 0.5;
    let leanT = f.pose === "crouch" ? 0.42 : 0.04 + walkW * 0.18;
    if (f.pose === "flatten") leanT = 0;
    if (f.stretching) { leanT = 0.22; hipT -= 0.04; }
    const idleBob = (1 - walkW) * (1 - bounce) * 0.028;
    const walkBob = walkW * Math.abs(Math.sin(f.stepPhase * Math.PI)) * 0.035;
    hipT += walkBob - idleBob;
    if (take >= 0) hipT += Math.sin(Math.min(1, take * 1.6) * Math.PI) * 0.32;
    if (f.caught) hipT = 0.36;
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
    const browT = (f.smug ? 0.05 : 0) + (take >= 0 ? 0.03 : 0);
    const br = this.brow.step(browT, dt);
    this.browL.position.y = 0.1 + br * 0.8;
    this.browR.position.y = 0.1 + br * (f.smug ? 0.2 : 0.8);
    this.browL.rotation.z = f.smug ? 0.25 : 0;
    const pop = this.pop.step(f.caught ? 0.04 : 0, dt);
    this.glasses.position.y = 0.025 + pop * 0.6;

    // Hat: lags a beat, flies on a take.
    const hatLift = this.hatY.step(0, dt) + -ha * 0.00025;
    let hatOff = Math.max(-0.02, hatLift * 0.06);
    let hatTip = 0;
    if (f.celebrate >= 0) {
      const c = Math.min(1, f.celebrate / 1.1);
      hatTip = Math.sin(c * Math.PI);
      hatOff += hatTip * 0.13;
    }
    this.hatPivot.position.y = 0.12 + hatOff;
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
    this.chain.bezier(v3(0, 0.2, 0.2), v3(0.03, 0.2 - sag * 1.6, 0.22), v3(0.11, 0.15 - sag, 0.19), v3(0.15, 0.135, 0.135), 0.0055, 0.0055);

    this.torso.updateMatrix();
    this.head.updateMatrix();
    const T = this.torso.matrix;
    const shoulder = (sx: number) => v3(sx * 0.19, 0.43, 0.0).applyMatrix4(T);
    const hipA = (sx: number) => v3(sx * 0.085, 0.05, 0).applyMatrix4(T);

    // Feet: tip-toe gait on eighth notes; planted wide while reaching.
    const stride = 0.3;
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? 1 : -1;
      const p = (((f.stepPhase / 2 + i * 0.5) % 1) + 1) % 1;
      let fz = 0, fy = 0, pitch = 0;
      if (walkW > 0.02 && !f.stretching) {
        if (p < 0.5) { const u = ease.inOut(p / 0.5); fz = (-stride / 2 + stride * u) * walkW; fy = Math.sin(Math.PI * (p / 0.5)) * 0.12 * walkW; pitch = 0.5; }
        else { const u = (p - 0.5) / 0.5; fz = (stride / 2 - stride * u) * walkW; pitch = 0.45 * walkW; }
      }
      let fx = sx * (f.pose === "crouch" ? 0.16 : 0.1);
      if (f.stretching) { fx = sx * 0.17; fz = sx * 0.06; }
      if (take >= 0) { fy += Math.sin(Math.min(1, take * 1.6) * Math.PI) * 0.18; pitch = 0.8; }
      const ankle = v3(fx, 0.06 + fy + pitch * 0.03, fz);
      const shoe = this.shoes[i]!;
      shoe.position.set(ankle.x, ankle.y - 0.06, ankle.z);
      shoe.rotation.set(pitch, 0, 0);
      const h = hipA(sx);
      const legLen = h.distanceTo(ankle);
      const bow = f.pose === "crouch" ? v3(sx * 0.2, 0, 0.14) : v3(sx * 0.02, 0, 0.06 + walkW * 0.04);
      this.legs[i]!.bezier(h, h.clone().add(v3(bow.x, -legLen * 0.38, bow.z)), ankle.clone().add(v3(bow.x * 0.7, legLen * 0.38, bow.z * 0.7)), ankle.clone().add(v3(0, 0.0, -0.01)), 0.038, 0.034);
    }

    // Hands.
    const handTargets: THREE.Vector3[] = [];
    const swing = Math.sin(f.stepPhase * Math.PI);
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? 1 : -1;
      let t: THREE.Vector3;
      if (take >= 0) t = v3(sx * 0.42, hipY + 0.95 + Math.sin(take * 20) * 0.03, 0.06);
      else if (f.caught) t = v3(sx * 0.3, hipY + 0.05, 0.1);
      else if (f.pose === "flatten") t = v3(sx * 0.21, hipY - 0.02, 0.02);
      else if (f.pose === "crouch") t = v3(sx * 0.24, hipY + 0.16, 0.3 + swing * sx * 0.04 * walkW);
      else {
        const idle = v3(sx * 0.27, hipY - 0.04 + (1 - bounce) * 0.015, 0.03 + Math.sin(f.beat * Math.PI) * 0.015 * sx);
        const sneak = v3(sx * 0.17, hipY + 0.38 + swing * sx * 0.04, 0.24);
        t = idle.lerp(sneak, walkW);
      }
      handTargets.push(t);
    }
    // Left hand steadies the hat while reaching; right hand tips it on success.
    this.hatPivot.updateMatrixWorld(true);
    const hatBody = v3(0.1, 0.06, 0.08).applyMatrix4(this.head.matrix).applyMatrix4(T);
    if (f.stretching) handTargets[0] = hatBody.clone().add(v3(0.05, 0.12, 0.02));
    if (f.celebrate >= 0 && f.celebrate < 1.1) handTargets[1] = hatBody.clone().add(v3(-0.16, 0.1 + Math.sin(Math.min(1, f.celebrate / 1.1) * Math.PI) * 0.13, 0.06));

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
        this.arms[1].through(pts, 0.03, 0.03);
        this.arms[1].end(glove.position);
        this.arms[1].endTangent(tan);
      } else {
        const h = handTargets[i]!;
        const out = v3(sx * 0.12, -0.1, 0.02);
        this.arms[i]!.bezier(s, s.clone().add(out), h.clone().add(v3(sx * 0.05, -0.14, -0.06)), h, 0.032, 0.03);
        this.arms[i]!.end(glove.position);
        this.arms[i]!.endTangent(tan);
      }
      glove.quaternion.setFromUnitVectors(Z, tan.normalize());
    }
    this.gloves[1].getWorldPosition(this.handWorld);
    this.hatPivot.getWorldPosition(this.hatWorld);

    this.shadow.scale.setScalar(1 - (hipY - 0.5) * 0.8);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.9 - Math.max(0, hipY - 0.5);
  }
}
