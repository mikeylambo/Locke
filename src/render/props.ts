import * as THREE from "three";
import type { PlacedOptic } from "../sim/beams";
import { MIRROR_HALF } from "../sim/beams";
import type { OpticKind, RoomDef } from "../sim/roomTypes";
import { Space } from "./space";
import { P, goldMaterial } from "./palette";
import { Spring } from "./spring";
import { FLOOR_H } from "../sim/roomTypes";

const gemVert = /* glsl */ `
varying vec3 vN; varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const gemFrag = /* glsl */ `
uniform float uTime; uniform float uGlow; uniform vec3 uTint;
varying vec3 vN; varying vec3 vW;
vec3 hue(float h){ return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
void main(){
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float ndv = max(dot(n, v), 0.0);
  // Facet-locked dispersion: each facet throws its own slice of the spectrum.
  float h = fract(dot(n, vec3(0.37, 0.71, 0.53)) * 2.3 + ndv * 0.8 + uTime * 0.07);
  vec3 fire = hue(h);
  vec3 r = reflect(-v, n);
  float spark = pow(max(0.0, r.y * 0.6 + 0.6 * sin(uTime * 2.0 + dot(n, vec3(5.0)))), 24.0);
  // Coloured stones: the fire narrows toward the stone's body colour and the core glows deep.
  float coloured = step(0.01, abs(uTint.r - uTint.b) + abs(uTint.g - uTint.b));
  fire = mix(fire, uTint * (0.6 + 0.4 * fire.g), coloured * 0.8);
  vec3 col = mix(mix(vec3(0.75, 0.85, 1.0) * 0.35, uTint * 0.55, coloured), fire * 1.3, 0.55 + 0.45 * (1.0 - ndv));
  col += vec3(1.0) * spark * 4.0;
  col *= uGlow;
  gl_FragColor = vec4(col, 1.0);
}`;

function brilliantCut(): THREE.BufferGeometry {
  const prof = [new THREE.Vector2(0, 0.12), new THREE.Vector2(0.075, 0.12), new THREE.Vector2(0.14, 0.055), new THREE.Vector2(0.15, 0.035), new THREE.Vector2(0.0, -0.14)];
  const g = new THREE.LatheGeometry(prof, 10).toNonIndexed();
  g.computeVertexNormals();
  return g;
}

/** The hero prize: a faceted diamond that rides the pedestal, Locke's hand, then his hat. */
export class PrizeView {
  readonly group = new THREE.Group();
  private gem: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private halo: THREE.Mesh;
  private caustics: THREE.Points;
  private causticVel: Float32Array;
  private causticLife = 0;
  private bob = 0;
  private scale = new Spring(1, 3.5, 0.45);
  private time = 0;
  readonly restPos: THREE.Vector3;

  constructor(readonly room: RoomDef) {
    this.mat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uGlow: { value: 1 }, uTint: { value: new THREE.Vector3(1, 1, 1) } }, vertexShader: gemVert, fragmentShader: gemFrag, toneMapped: false });
    this.gem = new THREE.Mesh(brilliantCut(), this.mat);
    this.gem.scale.setScalar(1.25);
    this.group.add(this.gem);
    const ped = room.blocks.find((b) => (b.style === "pedestal" || b.style === "statue") && Math.hypot(b.x - room.prize.x, b.z - room.prize.z) < 0.6);
    this.restPos = new THREE.Vector3(room.prize.x, (room.prize.y ?? (ped?.h ?? 0.95) + 0.25) + (room.prize.floor ?? 0) * FLOOR_H, room.prize.z);
    // Treasure colour: diamond white fire, crystal ice, ruby and sapphire deep glow, crown gold.
    const tint: Record<string, [number, number, number]> = { diamond: [1, 1, 1], crystal: [0.8, 0.95, 1.1], ruby: [1.3, 0.25, 0.35], sapphire: [0.3, 0.5, 1.4], crown: [1.3, 1.0, 0.5] };
    (this.mat.uniforms.uTint!.value as THREE.Vector3).set(...(tint[room.prize.kind] ?? [1, 1, 1]));
    if (room.setPiece) this.group.visible = false;
    this.group.position.copy(this.restPos);
    // Soft halo sprite.
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d")!;
    const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,0.9)"); grd.addColorStop(0.25, "rgba(200,220,255,0.35)"); grd.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 128, 128);
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, color: new THREE.Color(0.8, 0.9, 1.2) }));
    this.group.add(this.halo);
    // Spectral caustic burst thrown across the walls on lift.
    const n = 260;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    this.causticVel = new Float32Array(n * 3);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    cg.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.caustics = new THREE.Points(cg, new THREE.PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.caustics.frustumCulled = false;
    this.caustics.visible = false;
  }

  get causticObject() { return this.caustics; }

  burst() {
    const pos = this.caustics.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.caustics.geometry.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color();
    const o = this.group.getWorldPosition(new THREE.Vector3());
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, o.x, o.y, o.z);
      const a = Math.random() * Math.PI * 2, el = (Math.random() - 0.2) * 0.9;
      const sp = 4 + Math.random() * 6;
      this.causticVel[i * 3] = Math.cos(a) * Math.cos(el) * sp;
      this.causticVel[i * 3 + 1] = Math.sin(el) * sp;
      this.causticVel[i * 3 + 2] = Math.sin(a) * Math.cos(el) * sp;
      c.setHSL(Math.random(), 1, 0.6).multiplyScalar(2.2);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    pos.needsUpdate = true; col.needsUpdate = true;
    this.caustics.visible = true;
    this.causticLife = 2.4;
    this.scale.kick(6);
  }

  update(dt: number, s: { lifted: boolean; holding: boolean; hasPrize: boolean; hand: THREE.Vector3; hat: THREE.Vector3 }) {
    this.time += dt;
    this.mat.uniforms.uTime!.value = this.time;
    this.bob += dt;
    let target: THREE.Vector3;
    if (!s.lifted) target = this.restPos.clone().add(new THREE.Vector3(0, Math.sin(this.bob * 1.6) * 0.03, 0));
    else if (s.holding || !s.hasPrize) target = s.hand.clone().add(new THREE.Vector3(0, 0.12, 0));
    else target = s.hat.clone().add(new THREE.Vector3(0, 0.08, 0));
    const k = s.lifted ? 1 - Math.exp(-dt * 30) : 1;
    this.group.position.lerp(target, k);
    const sc = this.scale.step(s.hasPrize && !s.holding ? 0 : 1, dt);
    this.group.visible = sc > 0.02 && !this.room.setPiece;
    this.group.scale.setScalar(Math.max(0, sc));
    this.gem.rotation.y += dt * (s.lifted ? 3 : 0.6);
    this.halo.quaternion.copy((this.group.parent as THREE.Object3D | null)?.quaternion ?? new THREE.Quaternion());
    this.mat.uniforms.uGlow!.value = 1 + Math.max(0, this.causticLife - 1.6) * 2;

    if (this.causticLife > 0) {
      this.causticLife -= dt;
      const pos = this.caustics.geometry.attributes.position as THREE.BufferAttribute;
      const hw = this.room.size.w / 2 - 0.02, hd = this.room.size.d / 2 - 0.02, hh = this.room.size.h - 0.05;
      for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const vx = this.causticVel[i * 3]!, vy = this.causticVel[i * 3 + 1]!, vz = this.causticVel[i * 3 + 2]!;
        x += vx * dt; y += vy * dt; z += vz * dt;
        // Stick to whatever surface they reach: light pooling on walls.
        if (Math.abs(x) > hw || Math.abs(z) > hd || y < 0.01 || y > hh) {
          x = Math.max(-hw, Math.min(hw, x)); z = Math.max(-hd, Math.min(hd, z)); y = Math.max(0.01, Math.min(hh, y));
          this.causticVel[i * 3] = this.causticVel[i * 3 + 1] = this.causticVel[i * 3 + 2] = 0;
        }
        pos.setXYZ(i, x, y, z);
      }
      pos.needsUpdate = true;
      (this.caustics.material as THREE.PointsMaterial).opacity = Math.min(1, this.causticLife / 1.2);
      if (this.causticLife <= 0) this.caustics.visible = false;
    }
  }

  /** Billboard the halo toward the camera. */
  face(camera: THREE.Camera) { this.halo.quaternion.copy(camera.quaternion); }
}

/** The belt's optics: cheval mirror, corner-cube retro, glass splitter, and the funhouse band-shifters. */
export class OpticsView {
  readonly group = new THREE.Group();
  private items = new Map<string, { g: THREE.Group; pivot: THREE.Group; spring: Spring; angle: Spring; shown: number; kind: OpticKind }>();
  private mirrorMat: THREE.MeshStandardMaterial;
  private frameMat: THREE.MeshStandardMaterial;
  private ghost: THREE.Group;
  private space: Space;

  constructor(readonly room: RoomDef) {
    this.space = new Space(room);
    this.mirrorMat = new THREE.MeshStandardMaterial({ color: "#c9d4e0", metalness: 1, roughness: 0.04, envMapIntensity: 1.6, emissive: new THREE.Color("#2a3440"), emissiveIntensity: 0.3 });
    this.frameMat = goldMaterial(0.22, 0.25);
    this.ghost = this.build("mirror", true);
    this.ghost.visible = false;
    this.group.add(this.ghost);
  }

  private glassFor(kind: OpticKind, ghost: boolean): THREE.Material {
    if (ghost) return new THREE.MeshBasicMaterial({ color: P.gold, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
    if (kind === "splitter") return new THREE.MeshStandardMaterial({ color: "#9fe8ff", metalness: 0.2, roughness: 0.02, transparent: true, opacity: 0.45, envMapIntensity: 2, side: THREE.DoubleSide, emissive: new THREE.Color("#1d5566"), emissiveIntensity: 0.6, depthWrite: false });
    if (kind === "concave") return new THREE.MeshStandardMaterial({ color: "#f2c6d8", metalness: 1, roughness: 0.08, envMapIntensity: 1.6, emissive: new THREE.Color("#4a2433"), emissiveIntensity: 0.4, side: THREE.DoubleSide });
    if (kind === "convex") return new THREE.MeshStandardMaterial({ color: "#c6d6f2", metalness: 1, roughness: 0.08, envMapIntensity: 1.6, emissive: new THREE.Color("#243048"), emissiveIntensity: 0.4, side: THREE.DoubleSide });
    return this.mirrorMat;
  }

  private build(kind: OpticKind, ghost = false, fixed = false): THREE.Group {
    const g = new THREE.Group();
    const pivot = new THREE.Group();
    g.add(pivot);
    const H = 1.75, W = MIRROR_HALF * 2;
    if (kind === "retro") {
      // Corner-cube retroreflector: a faceted jewel in a gimbal ring; it throws light straight back.
      const jewel = new THREE.Mesh(new THREE.OctahedronGeometry(0.15, 0), ghost ? this.glassFor(kind, true) : new THREE.MeshStandardMaterial({ color: "#ffe9b8", metalness: 1, roughness: 0.05, envMapIntensity: 2, flatShading: true, emissive: new THREE.Color("#5a3a12"), emissiveIntensity: 0.6 }));
      jewel.position.y = 0.95;
      pivot.add(jewel);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.015, 8, 40), this.frameMat);
      ring.position.y = 0.95;
      pivot.add(ring);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.03, 0.8, 8), this.frameMat);
      post.position.y = 0.4;
      pivot.add(post);
      return g;
    }
    let geo: THREE.BufferGeometry = new THREE.CircleGeometry(0.5, 40);
    if (kind === "concave" || kind === "convex") {
      // Funhouse glass: visibly bowed (in for concave, out for convex) with a wavy rim.
      geo = new THREE.PlaneGeometry(1, 1, 16, 24);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const r2 = x * x * 4 + y * y * 4;
        pos.setZ(i, (kind === "concave" ? -1 : 1) * (1 - Math.min(1, r2)) * 0.12 + Math.sin(y * 18) * 0.01);
      }
      geo.computeVertexNormals();
    }
    const glass = new THREE.Mesh(geo, this.glassFor(kind, ghost));
    glass.scale.set(W * 0.96, H * 0.96, kind === "concave" || kind === "convex" ? 2.4 : 1);
    glass.position.y = 0.12 + H / 2;
    pivot.add(glass);
    const curve = new THREE.EllipseCurve(0, 0, W / 2, H / 2, 0, Math.PI * 2, false, 0);
    const pts = curve.getPoints(64).map((p, i) => new THREE.Vector3(p.x * (kind === "concave" || kind === "convex" ? 1 + Math.sin(i * 0.6) * 0.05 : 1), p.y, 0));
    const frame = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 96, kind === "splitter" ? 0.014 : 0.022, 8, true), ghost ? new THREE.MeshBasicMaterial({ color: P.gold, transparent: true, opacity: 0.35 }) : this.frameMat);
    frame.position.y = glass.position.y;
    pivot.add(frame);
    if (!ghost) {
      const crest = new THREE.Mesh(kind === "splitter" ? new THREE.OctahedronGeometry(0.05) : new THREE.ConeGeometry(0.05, 0.1, 4), this.frameMat);
      crest.position.y = 0.12 + H + 0.05;
      pivot.add(crest);
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.9, 8), this.frameMat);
        leg.position.set(sx * (W / 2 + 0.02), 0.45, 0);
        pivot.add(leg);
        const foot = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.32), this.frameMat);
        foot.position.set(sx * (W / 2 + 0.02), 0.01, 0);
        pivot.add(foot);
      }
      if (fixed) {
        // Bolted down: a heavy brass turntable with rivets says "turn me, don't take me".
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.06, 32), this.frameMat);
        base.position.y = 0.03;
        g.add(base);
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), this.frameMat);
          rivet.position.set(Math.cos(a) * 0.3, 0.065, Math.sin(a) * 0.3);
          g.add(rivet);
        }
      }
    }
    return g;
  }

  /** Brief flash on an optic (splitters on first light, mirrors on a snap). */
  private flashes = new Map<string, number>();
  flash(mountId: string) { this.flashes.set(mountId, 1); }

  update(dt: number, optics: PlacedOptic[], ghostAt: { x: number; z: number; angle: number } | null) {
    const live = new Set(optics.map((o) => o.mountId));
    for (const op of optics) {
      let it = this.items.get(op.mountId);
      const m = this.room.mounts.find((mm) => mm.id === op.mountId)!;
      if (it && it.kind !== op.kind) { this.group.remove(it.g); this.items.delete(op.mountId); it = undefined; }
      if (!it) {
        const g = this.build(op.kind, false, !!op.fixed);
        this.place(g, m.x, m.z, m.floor ?? 0);
        this.group.add(g);
        // Stiff, near-critically damped: a precise mechanical turn that settles in one tick.
        it = { g, pivot: g.children[0] as THREE.Group, spring: new Spring(op.fixed ? 1 : 0, 4.5, 0.32), angle: new Spring(op.angle, 22, 0.92), shown: 0, kind: op.kind };
        this.items.set(op.mountId, it);
      }
      let target = op.angle;
      while (target - it.angle.x > 180) target -= 360;
      while (target - it.angle.x < -180) target += 360;
      const a = it.angle.step(target, dt);
      this.orient(it.g, a);
      const s = it.spring.step(1, dt);
      const fl = this.flashes.get(op.mountId) ?? 0;
      if (fl > 0) this.flashes.set(op.mountId, Math.max(0, fl - dt * 5));
      it.pivot.scale.set(Math.max(0.01, s) * (1 + fl * 0.06), Math.max(0.01, s), 1);
    }
    for (const [id, it] of this.items) {
      if (!live.has(id)) { this.group.remove(it.g); this.items.delete(id); }
    }
    this.ghost.visible = !!ghostAt;
    if (ghostAt) {
      const m = this.room.mounts.find((mm) => Math.abs(mm.x - ghostAt.x) < 1e-6 && Math.abs(mm.z - ghostAt.z) < 1e-6);
      this.place(this.ghost, ghostAt.x, ghostAt.z, m?.floor ?? 0);
      this.orient(this.ghost, ghostAt.angle);
    }
  }

  private place(g: THREE.Object3D, x: number, z: number, floor: number) {
    g.position.copy(this.space.at(x, z, 0, floor));
    if (this.space.side) g.position.z -= 0.95; // the glass centre sits on the play plane
  }

  /** Mirror surface direction = angle. Side view turns about the depth axis instead. */
  private orient(g: THREE.Object3D, deg: number) {
    if (this.space.side) {
      const r = deg * Math.PI / 180, x = new THREE.Vector3(Math.cos(r), -Math.sin(r), 0), y = new THREE.Vector3(0, 0, 1);
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y)));
    }
    else g.rotation.y = -deg * Math.PI / 180;
  }
}
