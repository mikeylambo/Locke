import * as THREE from "three";
import type { PlacedOptic } from "../sim/beams";
import { MIRROR_HALF } from "../sim/beams";
import type { RoomDef } from "../sim/roomTypes";
import { P, goldMaterial } from "./palette";
import { Spring } from "./spring";

const gemVert = /* glsl */ `
varying vec3 vN; varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const gemFrag = /* glsl */ `
uniform float uTime; uniform float uGlow;
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
  vec3 col = mix(vec3(0.75, 0.85, 1.0) * 0.35, fire * 1.3, 0.55 + 0.45 * (1.0 - ndv));
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
    this.mat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uGlow: { value: 1 } }, vertexShader: gemVert, fragmentShader: gemFrag, toneMapped: false });
    this.gem = new THREE.Mesh(brilliantCut(), this.mat);
    this.gem.scale.setScalar(1.25);
    this.group.add(this.gem);
    const ped = room.blocks.find((b) => b.style === "pedestal");
    this.restPos = new THREE.Vector3(room.prize.x, (ped?.h ?? 0.95) + 0.25, room.prize.z);
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
    this.group.visible = sc > 0.02;
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

/** Pocket Mirror: pops open into a full-length cheval mirror on its mount. */
export class OpticsView {
  readonly group = new THREE.Group();
  private items = new Map<string, { g: THREE.Group; pivot: THREE.Group; spring: Spring; angle: Spring; shown: number }>();
  private mirrorMat: THREE.MeshStandardMaterial;
  private frameMat: THREE.MeshStandardMaterial;
  private ghost: THREE.Group;

  constructor(readonly room: RoomDef) {
    this.mirrorMat = new THREE.MeshStandardMaterial({ color: "#c9d4e0", metalness: 1, roughness: 0.04, envMapIntensity: 1.6, emissive: new THREE.Color("#2a3440"), emissiveIntensity: 0.3 });
    this.frameMat = goldMaterial(0.22, 0.25);
    this.ghost = this.build(true);
    this.ghost.visible = false;
    this.group.add(this.ghost);
  }

  private build(ghost = false): THREE.Group {
    const g = new THREE.Group();
    const pivot = new THREE.Group();
    g.add(pivot);
    const H = 1.75, W = MIRROR_HALF * 2;
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.5, 40), ghost ? new THREE.MeshBasicMaterial({ color: P.gold, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }) : this.mirrorMat);
    glass.scale.set(W * 0.96, H * 0.96, 1);
    glass.position.y = 0.12 + H / 2;
    (glass.material as THREE.Material).side = THREE.DoubleSide;
    pivot.add(glass);
    const curve = new THREE.EllipseCurve(0, 0, W / 2, H / 2, 0, Math.PI * 2, false, 0);
    const pts = curve.getPoints(64).map((p) => new THREE.Vector3(p.x, p.y, 0));
    const frame = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 96, 0.022, 8, true), ghost ? new THREE.MeshBasicMaterial({ color: P.gold, transparent: true, opacity: 0.35 }) : this.frameMat);
    frame.position.y = glass.position.y;
    pivot.add(frame);
    if (!ghost) {
      // Crest + stand.
      const crest = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.1, 4), this.frameMat);
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
    }
    return g;
  }

  update(dt: number, optics: PlacedOptic[], ghostAt: { x: number; z: number; angle: number } | null) {
    const live = new Set(optics.map((o) => o.mountId));
    for (const op of optics) {
      let it = this.items.get(op.mountId);
      const m = this.room.mounts.find((mm) => mm.id === op.mountId)!;
      if (!it) {
        const g = this.build();
        g.position.set(m.x, 0, m.z);
        this.group.add(g);
        it = { g, pivot: g.children[0] as THREE.Group, spring: new Spring(0, 4.5, 0.32), angle: new Spring(op.angle, 9, 0.55), shown: 0 };
        this.items.set(op.mountId, it);
      }
      // Unwrap angle toward target to rotate the short way.
      let target = op.angle;
      while (target - it.angle.x > 180) target -= 360;
      while (target - it.angle.x < -180) target += 360;
      const a = it.angle.step(target, dt);
      // Mirror surface direction = angle; the plane's normal is perpendicular to it.
      it.g.rotation.y = -a * Math.PI / 180;
      const s = it.spring.step(1, dt);
      it.pivot.scale.set(Math.max(0.01, s), Math.max(0.01, s), 1);
    }
    for (const [id, it] of this.items) {
      if (!live.has(id)) { this.group.remove(it.g); this.items.delete(id); }
    }
    this.ghost.visible = !!ghostAt;
    if (ghostAt) {
      this.ghost.position.set(ghostAt.x, 0, ghostAt.z);
      this.ghost.rotation.y = -ghostAt.angle * Math.PI / 180;
    }
  }
}
