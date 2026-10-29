import * as THREE from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BlockDef, EmitterDef, ExitDef, RoomDef } from "../sim/roomTypes";
import { BAND_Y } from "../sim/roomTypes";
import { P, glowMaterial, goldMaterial, matteMaterial } from "./palette";
import type { Quality } from "./stage";
import { chatoyant } from "./chatoyant";

const floorVert = /* glsl */ `
uniform mat4 textureMatrix;
varying vec4 vUvR; varying vec3 vW;
void main(){
  vUvR = textureMatrix * vec4(position, 1.0);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const floorFrag = /* glsl */ `
uniform vec3 color; uniform sampler2D tDiffuse; uniform float uReflect; uniform float uSheen; uniform float uPattern; uniform float uInlay; uniform vec2 uHalf; uniform vec2 uFocus; uniform float uTime;
varying vec4 vUvR; varying vec3 vW;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
float line(float d, float w){ return 1.0 - smoothstep(w * 0.5, w * 0.5 + fwidth(d) * 1.2, abs(d)); }
void main(){
  vec2 p = vW.xz;
  // Black marble with faint warm veins.
  float v = noise(p * 1.3) * 0.6 + noise(p * 3.7) * 0.3 + noise(p * 9.0) * 0.1;
  float vein = pow(1.0 - abs(sin((p.x * 0.7 + p.y * 0.4 + v * 2.0) * 1.6)), 40.0);
  vec3 base = color * (0.9 + v * 0.2) + vec3(0.018, 0.015, 0.013) * vein;
  if (uPattern > 0.5 && uPattern < 1.5) {
    // Pawnshop: worn oak planks.
    float plank = floor(p.y / 0.22);
    float grain = noise(vec2(p.x * 0.8 + plank * 7.0, plank)) * 0.5 + noise(vec2(p.x * 9.0, p.y * 40.0)) * 0.2;
    base = vec3(0.07, 0.04, 0.022) * (0.75 + grain + hash(vec2(plank, 3.0)) * 0.3);
    base *= 1.0 - line(fract(p.y / 0.22) - 0.5, 0.06) * 0.0 - (1.0 - smoothstep(0.0, 0.03, fract(p.y / 0.22))) * 0.6;
  } else if (uPattern > 1.5 && uPattern < 2.5) {
    // Jeweler: black-and-cream checker.
    vec2 c = floor(p / 0.6);
    float k = mod(c.x + c.y, 2.0);
    base = mix(vec3(0.012, 0.011, 0.014), vec3(0.16, 0.145, 0.12), k) * (0.9 + v * 0.2);
  } else if (uPattern > 2.5) {
    // Hotel: oxblood carpet with a small deco diamond.
    vec2 c = fract(p / 0.7) - 0.5;
    float dia = line(abs(c.x) + abs(c.y) - 0.3, 0.02);
    base = vec3(0.055, 0.008, 0.012) * (0.85 + noise(p * 30.0) * 0.3) + vec3(0.06, 0.04, 0.015) * dia;
  }
  // Gold inlay: inset border, large tiles, and a sunburst around the prize.
  vec2 q = abs(p) - (uHalf - 0.45);
  float border = line(max(q.x, q.y), 0.025) + line(max(q.x, q.y) + 0.12, 0.012);
  vec2 tile = (fract(p / 1.5 + 0.5) - 0.5) * 1.5;
  float grout = (line(tile.x, 0.012) + line(tile.y, 0.012)) * 0.35 * step(max(q.x, q.y), -0.2);
  vec2 r = p - uFocus;
  float rr = length(r);
  float ang = atan(r.y, r.x);
  float rays = line(sin(ang * 12.0) * rr, 0.018) * smoothstep(0.7, 0.9, rr) * (1.0 - smoothstep(2.2, 2.6, rr));
  float rings = line(rr - 0.75, 0.03) + line(rr - 0.9, 0.012) + line(rr - 2.6, 0.02);
  float gold = clamp(border + (grout + rays * 0.8 + rings) * uInlay, 0.0, 1.0);
  vec3 goldCol = vec3(0.85, 0.62, 0.28) * (0.16 + 0.05 * sin(uTime * 0.6 + p.x * 0.8));
  base = mix(base, goldCol, gold * 0.85);
  // Polished reflection with a soft 5-tap blur.
  vec4 uv = vUvR;
  vec2 px = vec2(0.0035, 0.0025) * uv.w;
  vec3 refl = texture2DProj(tDiffuse, uv).rgb * 0.4
    + texture2DProj(tDiffuse, uv + vec4(px.x, 0.0, 0.0, 0.0)).rgb * 0.15
    + texture2DProj(tDiffuse, uv - vec4(px.x, 0.0, 0.0, 0.0)).rgb * 0.15
    + texture2DProj(tDiffuse, uv + vec4(0.0, px.y, 0.0, 0.0)).rgb * 0.15
    + texture2DProj(tDiffuse, uv - vec4(0.0, px.y, 0.0, 0.0)).rgb * 0.15;
  float k = uReflect * (1.0 - gold * 0.4);
  // Baked gloss: a view-dependent sheen streak plus gold wall bounce pooling at the skirting.
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = normalize(vec3(-0.35, 0.9, -0.6));
  float spec = pow(max(dot(reflect(-L, vec3(0.0, 1.0, 0.0)), V), 0.0), 18.0);
  vec2 e = uHalf - abs(p);
  float wallGlow = exp(-min(e.x, e.y) * 2.2);
  vec3 sheen = vec3(0.05, 0.042, 0.035) * spec * (0.6 + 0.4 * v) + vec3(0.05, 0.034, 0.014) * wallGlow;
  gl_FragColor = vec4(base + refl * k + sheen * uSheen * (1.0 - gold * 0.5), 1.0);
}`;

/**
 * Collapse every static mesh under `root` into one mesh per material (relative to root).
 * The Deco trim is hundreds of tiny boxes; drawn individually it dominated frame time on iGPUs.
 */
export function mergeStatic(root: THREE.Object3D, keep: Set<THREE.Object3D>) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const victims: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || keep.has(m) || Array.isArray(m.material)) return;
    for (let p: THREE.Object3D | null = m; p && p !== root; p = p.parent) if (keep.has(p)) return;
    const g = m.geometry.index ? m.geometry.clone() : m.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k);
    if (!g.index) g.setIndex([...Array(g.attributes.position!.count).keys()]);
    const list = buckets.get(m.material) ?? [];
    list.push(g);
    buckets.set(m.material, list);
    victims.push(m);
  });
  for (const v of victims) v.removeFromParent();
  for (const [mat, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    if (merged) root.add(new THREE.Mesh(merged, mat));
  }
}

/** Each small-time job dresses the same sim differently. */
export const THEMES = {
  museum: { wall: "#0f0d13", floor: "#07060a", pattern: 0, inlay: 1 },
  pawnshop: { wall: "#1b120c", floor: "#07060a", pattern: 1, inlay: 0.25 },
  jeweler: { wall: "#0e111a", floor: "#07060a", pattern: 2, inlay: 0.5 },
  hotel: { wall: "#0b1410", floor: "#07060a", pattern: 3, inlay: 0.35 },
  gallery: { wall: "#16110f", floor: "#0b0908", pattern: 0, inlay: 0.75 }
} as const;
export type Theme = keyof typeof THEMES;

export interface DoorView {
  def: ExitDef;
  shutter: THREE.Mesh;
  lamp: THREE.Mesh;
  lampMat: THREE.MeshBasicMaterial;
  open: number; // 0 shut .. 1 open (animated)
  target: number;
}

export interface EmitterView {
  def: EmitterDef;
  lenses: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }>;
  head?: THREE.Object3D;
}

export class RoomView {
  readonly group = new THREE.Group();
  readonly walls: Array<{ g: THREE.Group; normal: THREE.Vector3; h: number; cur: number }> = [];
  readonly doors: DoorView[] = [];
  readonly emitters = new Map<string, EmitterView>();
  readonly sensors = new Map<string, { crystal: THREE.Mesh; mat: THREE.MeshBasicMaterial; ring: THREE.Mesh; conduit: THREE.Mesh; conduitMat: THREE.MeshBasicMaterial; fed: number }>();
  readonly mounts = new Map<string, { ring: THREE.Mesh; mat: THREE.MeshBasicMaterial; hot: number }>();
  floorMat?: THREE.ShaderMaterial;
  reflector?: Reflector;
  readonly showcase: THREE.Mesh;
  readonly showcaseMat: THREE.MeshBasicMaterial;
  private motes: THREE.Points;
  private time = 0;

  readonly theme: Theme;

  constructor(readonly room: RoomDef, quality: Quality) {
    this.theme = (room.theme ?? "museum") as Theme;
    const { w, d, h } = room.size;
    this.buildFloor(w, d, quality);
    this.buildWalls(w, d, h);
    if (room.sign) this.buildSign(room.sign, w, d, h);
    const blocks = new THREE.Group();
    for (const b of room.blocks) blocks.add(this.buildBlock(b));
    mergeStatic(blocks, new Set());
    this.group.add(blocks);
    for (const e of room.emitters) this.buildEmitter(e);
    for (const s of room.sensors) this.buildSensor(s.id, s.x, s.z);
    for (const m of room.mounts) this.buildMount(m.id, m.x, m.z);

    // Showcase light cone over the prize.
    const coneGeo = new THREE.ConeGeometry(0.75, h - 1, 32, 1, true);
    coneGeo.translate(0, -(h - 1) / 2, 0);
    this.showcaseMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#fff1cf").multiplyScalar(0.07), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.showcase = new THREE.Mesh(coneGeo, this.showcaseMat);
    this.showcase.position.set(room.prize.x, h + 0.2, room.prize.z);
    this.group.add(this.showcase);

    // Dust motes catching the light.
    const n = quality === "cinematic" ? 420 : quality === "balanced" ? 220 : 90;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * w; pos[i * 3 + 1] = Math.random() * h * 0.8; pos[i * 3 + 2] = (Math.random() - 0.5) * d; }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.motes = new THREE.Points(mg, new THREE.PointsMaterial({ color: new THREE.Color("#ffe2a8").multiplyScalar(0.9), size: 0.018, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.group.add(this.motes);
  }

  private buildFloor(w: number, d: number, quality: Quality) {
    const geo = new THREE.PlaneGeometry(w, d);
    const uniforms = {
      color: { value: new THREE.Color(THEMES[this.theme].floor) }, tDiffuse: { value: null }, textureMatrix: { value: null },
      uReflect: { value: quality === "cinematic" ? 0.42 : 0 }, uSheen: { value: quality === "cinematic" ? 0 : 1 }, uHalf: { value: new THREE.Vector2(w / 2, d / 2) },
      uFocus: { value: new THREE.Vector2(this.room.prize.x, this.room.prize.z) }, uTime: { value: 0 },
      uPattern: { value: THEMES[this.theme].pattern }, uInlay: { value: THEMES[this.theme].inlay }
    };
    if (quality === "cinematic") {
      const r = new Reflector(geo, {
        clipBias: 0.003, textureWidth: Math.min(1024, window.innerWidth * 0.5), textureHeight: Math.min(1024, window.innerHeight * 0.5),
        color: P.floor, shader: { name: "DecoFloor", uniforms, vertexShader: floorVert, fragmentShader: floorFrag }
      });
      r.rotation.x = -Math.PI / 2;
      this.reflector = r;
      this.floorMat = r.material as THREE.ShaderMaterial;
      this.group.add(r);
    } else {
      // Balanced/Performance: same inlay, baked gloss instead of a mirror render.
      const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      tex.needsUpdate = true;
      const mat = new THREE.ShaderMaterial({ uniforms: { ...uniforms, tDiffuse: { value: tex }, textureMatrix: { value: new THREE.Matrix4() } }, vertexShader: floorVert, fragmentShader: floorFrag });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      this.floorMat = mat;
      this.group.add(m);
    }
  }

  private buildWalls(w: number, d: number, h: number) {
    const wallMat = matteMaterial(new THREE.Color(THEMES[this.theme].wall));
    const gold = goldMaterial(0.3, 0.12);
    const trimGold = goldMaterial(0.25, 0.25);
    const sides: Array<{ wall: "n" | "s" | "e" | "w"; len: number; pos: THREE.Vector3; rotY: number; normal: THREE.Vector3 }> = [
      { wall: "n", len: w, pos: new THREE.Vector3(0, 0, -d / 2), rotY: 0, normal: new THREE.Vector3(0, 0, -1) },
      { wall: "s", len: w, pos: new THREE.Vector3(0, 0, d / 2), rotY: Math.PI, normal: new THREE.Vector3(0, 0, 1) },
      { wall: "e", len: d, pos: new THREE.Vector3(w / 2, 0, 0), rotY: -Math.PI / 2, normal: new THREE.Vector3(1, 0, 0) },
      { wall: "w", len: d, pos: new THREE.Vector3(-w / 2, 0, 0), rotY: Math.PI / 2, normal: new THREE.Vector3(-1, 0, 0) }
    ];
    const doors = [this.room.entry, ...this.room.exits];
    for (const s of sides) {
      const g = new THREE.Group();
      g.position.copy(s.pos);
      g.rotation.y = s.rotY;
      // Local frame: x along the wall, +z into the room.
      const wallDoors = doors.filter((dd) => dd.wall === s.wall).map((dd) => ({ def: dd, u: s.wall === "n" ? dd.x : s.wall === "s" ? -dd.x : s.wall === "e" ? dd.z : -dd.z }));
      const thick = 0.2;
      const dw = 1.15, dh = 2.25;
      // Panels between doors.
      const cuts = wallDoors.map((x) => x.u).sort((a, b) => a - b);
      let start = -s.len / 2 - thick;
      const spans: Array<[number, number]> = [];
      for (const c of cuts) { spans.push([start, c - dw / 2]); start = c + dw / 2; }
      spans.push([start, s.len / 2 + thick]);
      for (const [a, b] of spans) {
        if (b - a < 0.01) continue;
        const m = new THREE.Mesh(new THREE.BoxGeometry(b - a, h, thick), wallMat);
        m.position.set((a + b) / 2, h / 2, -thick / 2);
        g.add(m);
      }
      for (const c of cuts) {
        const lintel = new THREE.Mesh(new THREE.BoxGeometry(dw, h - dh, thick), wallMat);
        lintel.position.set(c, dh + (h - dh) / 2, -thick / 2);
        g.add(lintel);
      }
      // Skirting + cornice + crown line.
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(s.len, 0.09, 0.03), trimGold);
      skirt.position.set(0, 0.045, 0.015);
      g.add(skirt);
      const corn = new THREE.Mesh(new THREE.BoxGeometry(s.len, 0.06, 0.05), trimGold);
      corn.position.set(0, h - 0.05, 0.025);
      g.add(corn);
      const corn2 = new THREE.Mesh(new THREE.BoxGeometry(s.len, 0.02, 0.03), gold);
      corn2.position.set(0, h - 0.2, 0.015);
      g.add(corn2);
      // Fluted pilasters with stepped capitals, skipping doors.
      const nP = Math.floor(s.len / 2);
      for (let i = 0; i <= nP; i++) {
        const u = -s.len / 2 + (s.len / nP) * i;
        if (cuts.some((c) => Math.abs(c - u) < dw / 2 + 0.25)) continue;
        if (Math.abs(u) > s.len / 2 - 0.05) continue;
        for (const off of [-0.05, 0, 0.05]) {
          const fl = new THREE.Mesh(new THREE.BoxGeometry(0.018, h - 0.6, 0.02), gold);
          fl.position.set(u + off, (h - 0.6) / 2 + 0.12, 0.01);
          g.add(fl);
        }
        for (let k = 0; k < 3; k++) {
          const cap = new THREE.Mesh(new THREE.BoxGeometry(0.22 - k * 0.06, 0.035, 0.04), trimGold);
          cap.position.set(u, h - 0.42 + k * 0.04, 0.02);
          g.add(cap);
        }
      }
      // Sunburst reliefs centred in each bay.
      for (let i = 0; i < nP; i++) {
        const u = -s.len / 2 + (s.len / nP) * (i + 0.5);
        if (cuts.some((c) => Math.abs(c - u) < dw / 2 + 0.5)) continue;
        const burst = new THREE.Group();
        for (let k = 0; k < 9; k++) {
          const a = (k / 8) * Math.PI;
          const ray = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.55, 0.012), gold);
          ray.position.set(Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0);
          ray.rotation.z = a - Math.PI / 2;
          burst.add(ray);
        }
        const arc = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.008, 6, 40, Math.PI), trimGold);
        burst.add(arc);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(0.06, 24, 0, Math.PI), trimGold);
        burst.add(disc);
        burst.position.set(u, h - 1.25, 0.01);
        g.add(burst);
      }
      const before = this.doors.length;
      for (const wd of wallDoors) this.buildDoor(g, wd.def, wd.u, dw, dh, trimGold, gold);
      mergeStatic(g, new Set(this.doors.slice(before).flatMap((d) => [d.shutter, d.lamp])));
      this.group.add(g);
      this.walls.push({ g, normal: s.normal, h, cur: 1 });
    }
  }

  /** Gilt lettering over the back wall: tells you which joint this is without a word of UI. */
  private buildSign(text: string, w: number, d: number, h: number) {
    const c = document.createElement("canvas");
    c.width = 1024; c.height = 160;
    const ctx = c.getContext("2d")!;
    ctx.font = "64px Limelight, 'Playfair Display', Georgia, serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(255, 200, 110, 0.9)"; ctx.shadowBlur = 18;
    const grd = ctx.createLinearGradient(0, 40, 0, 120);
    grd.addColorStop(0, "#fff1c8"); grd.addColorStop(0.5, "#e2b35c"); grd.addColorStop(1, "#8e6424");
    ctx.fillStyle = grd;
    ctx.fillText(text, 512, 84, 980);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const width = Math.min(w * 0.6, 6.4);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, width * (160 / 1024)), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, color: new THREE.Color(1.5, 1.4, 1.2), depthWrite: false }));
    sign.position.set(0, h - 0.62, -d / 2 + 0.02);
    this.group.add(sign);
  }

  private buildDoor(g: THREE.Group, def: ExitDef, u: number, dw: number, dh: number, _trim: THREE.Material, _gold: THREE.Material) {
    // Vault doors carry the cat's-eye sheen on their gold.
    const trim = this.mat("doorTrim", () => chatoyant(goldMaterial(0.25, 0.25), undefined, 0.6));
    const gold = this.mat("doorGold", () => chatoyant(goldMaterial(0.3, 0.12), undefined, 0.45));
    // Stepped deco frame.
    for (let k = 0; k < 3; k++) {
      const inset = k * 0.06;
      const top = new THREE.Mesh(new THREE.BoxGeometry(dw + 0.2 - inset * 2, 0.05, 0.05), k === 0 ? trim : gold);
      top.position.set(u, dh + 0.12 + k * 0.08, 0.03);
      g.add(top);
    }
    for (const sgn of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.06, dh + 0.1, 0.06), trim);
      jamb.position.set(u + sgn * (dw / 2 + 0.03), (dh + 0.1) / 2, 0.03);
      g.add(jamb);
    }
    const recess = new THREE.Mesh(new THREE.PlaneGeometry(dw, dh), new THREE.MeshBasicMaterial({ color: "#020203" }));
    recess.position.set(u, dh / 2, -0.19);
    g.add(recess);
    // Slatted gold shutter.
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#2b2014"; ctx.fillRect(0, 0, 64, 256);
    for (let y = 0; y < 256; y += 16) {
      const grd = ctx.createLinearGradient(0, y, 0, y + 16);
      grd.addColorStop(0, "#e5b866"); grd.addColorStop(0.5, "#8e6424"); grd.addColorStop(1, "#2b2014");
      ctx.fillStyle = grd; ctx.fillRect(0, y + 1, 64, 14);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const shutter = new THREE.Mesh(new THREE.PlaneGeometry(dw, dh), chatoyant(new THREE.MeshStandardMaterial({ map: tex, metalness: 0.8, roughness: 0.35, envMapIntensity: 0.8 }), undefined, 0.35, 30));
    shutter.position.set(u, dh * 1.5, -0.08);
    g.add(shutter);
    const lampMat = glowMaterial(P.gold, 2);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), lampMat);
    lamp.position.set(u, dh + 0.42, 0.06);
    g.add(lamp);
    const initial = def.phase === "in" ? 1 : 0;
    shutter.position.y = dh / 2 + (1 - initial) * 0 + initial * dh;
    this.doors.push({ def, shutter, lamp, lampMat, open: initial, target: initial });
  }

  private mats = new Map<string, THREE.Material>();
  private mat<T extends THREE.Material>(key: string, make: () => T): T {
    let m = this.mats.get(key);
    if (!m) { m = make(); this.mats.set(key, m); }
    return m as T;
  }

  private buildBlock(b: BlockDef): THREE.Object3D {
    const g = new THREE.Group();
    g.position.set(b.x, 0, b.z);
    const dark = this.mat("blockDark", () => matteMaterial(P.charcoal.clone().multiplyScalar(0.55), 0.6));
    const gold = this.mat("blockGold", () => goldMaterial(0.28, 0.1));
    const style = b.style ?? "plinth";
    if (style === "post") {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, b.h, 16), dark);
      col.position.y = b.h / 2;
      g.add(col);
      for (const y of [0.06, b.h - 0.04]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.012, 8, 24), gold);
        ring.rotation.x = Math.PI / 2; ring.position.y = y;
        g.add(ring);
      }
      return g;
    }
    if (style === "rail") {
      // Brass stanchions with a sagging velvet rope: low enough for a reaching arm to pass over.
      const long = Math.max(b.w, b.d), alongX = b.w >= b.d;
      const n = Math.max(2, Math.round(long / 0.6) + 1);
      const velvet = this.mat("velvet", () => new THREE.MeshStandardMaterial({ color: "#6a0f1c", roughness: 0.7 }));
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < n; i++) {
        const u = -long / 2 + (long / (n - 1)) * i;
        const px = alongX ? u : 0, pz = alongX ? 0 : u;
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, b.h, 10), gold);
        post.position.set(px, b.h / 2, pz);
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.03, 16), gold);
        foot.position.set(px, 0.015, pz);
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), gold);
        knob.position.set(px, b.h, pz);
        g.add(post, foot, knob);
        if (i < n - 1) {
          const u2 = -long / 2 + (long / (n - 1)) * (i + 0.5);
          pts.push(new THREE.Vector3(px, b.h - 0.05, pz), new THREE.Vector3(alongX ? u2 : 0, b.h - 0.16, alongX ? 0 : u2));
        } else pts.push(new THREE.Vector3(px, b.h - 0.05, pz));
      }
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n * 12, 0.018, 6), velvet));
      return g;
    }
    if (style === "column") {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(b.w / 2 * 0.8, b.w / 2 * 0.9, b.h - 0.2, 20), dark);
      shaft.position.y = b.h / 2;
      g.add(shaft);
      for (const y of [0.05, b.h - 0.05]) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(b.w, 0.1, b.d), gold);
        cap.position.y = y;
        g.add(cap);
      }
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const fl = new THREE.Mesh(new THREE.BoxGeometry(0.012, b.h - 0.3, 0.012), gold);
        fl.position.set(Math.cos(a) * b.w * 0.42, b.h / 2, Math.sin(a) * b.w * 0.42);
        g.add(fl);
      }
      return g;
    }
    // Stepped deco base shared by plinths, cases, pedestals.
    const steps = style === "sensor" ? 2 : 3;
    let y = 0;
    for (let k = 0; k < steps; k++) {
      const sh = 0.06;
      const inset = (steps - k) * 0.04;
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.w + inset, sh, b.d + inset), k === 0 ? gold : dark);
      m.position.y = y + sh / 2;
      g.add(m);
      y += sh;
    }
    const bodyH = style === "case" ? 0.6 : b.h - y - 0.05;
    const body = new THREE.Mesh(new THREE.BoxGeometry(b.w, bodyH, b.d), dark);
    body.position.y = y + bodyH / 2;
    g.add(body);
    // Vertical gold fluting on each face.
    for (const [sx, sz, rot] of [[0, 1, 0], [0, -1, 0], [1, 0, Math.PI / 2], [-1, 0, Math.PI / 2]] as const) {
      const span = rot ? b.d : b.w;
      for (let k = -1; k <= 1; k++) {
        const fl = new THREE.Mesh(new THREE.BoxGeometry(0.012, bodyH * 0.8, 0.012), gold);
        fl.position.set(sx * (b.w / 2 + 0.003) + (rot ? 0 : k * span * 0.25), y + bodyH / 2, sz * (b.d / 2 + 0.003) + (rot ? k * span * 0.25 : 0));
        g.add(fl);
      }
    }
    y += bodyH;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.06, 0.05, b.d + 0.06), gold);
    cap.position.y = y + 0.025;
    g.add(cap);
    y += 0.05;
    if (style === "case" && this.theme === "hotel") {
      // Safe-deposit cabinet: a wall of numbered brass-trimmed boxes.
      const boxH = b.h - y;
      const steel = this.mat("steel", () => new THREE.MeshStandardMaterial({ color: "#2a2b2e", metalness: 0.85, roughness: 0.35, envMapIntensity: 0.9 }));
      const cab = new THREE.Mesh(new THREE.BoxGeometry(b.w - 0.02, boxH, b.d - 0.02), steel);
      cab.position.y = y + boxH / 2;
      g.add(cab);
      const cols = Math.max(2, Math.round(b.w / 0.22)), rows = 4;
      for (const sz of [1, -1]) for (let c = 0; c < cols; c++) for (let rr = 0; rr < rows; rr++) {
        const door = new THREE.Mesh(new THREE.BoxGeometry((b.w - 0.06) / cols - 0.02, boxH / rows - 0.03, 0.006), steel);
        door.position.set(-b.w / 2 + 0.03 + ((b.w - 0.06) / cols) * (c + 0.5), y + (boxH / rows) * (rr + 0.5), sz * (b.d / 2 - 0.005));
        const knob = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.012), gold);
        knob.position.copy(door.position); knob.position.z += sz * 0.006;
        g.add(door, knob);
      }
      return g;
    }
    if (style === "case") {
      // Glass vitrine with a small treasure silhouette.
      const glassH = b.h - y;
      const glass = new THREE.Mesh(new THREE.BoxGeometry(b.w - 0.04, glassH, b.d - 0.04), this.mat("glass", () => new THREE.MeshStandardMaterial({ color: "#a8b8c8", metalness: 0, roughness: 0.05, transparent: true, opacity: 0.16, envMapIntensity: 1.4, depthWrite: false })));
      glass.position.y = y + glassH / 2;
      g.add(glass);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(glass.geometry), this.mat("edge", () => new THREE.LineBasicMaterial({ color: P.gold.clone().multiplyScalar(1.4) })));
      edges.position.copy(glass.position);
      g.add(edges);
      const vase = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.08, 0.02), new THREE.Vector2(0.11, 0.14), new THREE.Vector2(0.05, 0.3), new THREE.Vector2(0.07, 0.36), new THREE.Vector2(0, 0.37)], 20), gold);
      vase.position.y = y;
      vase.scale.setScalar(Math.min(1.2, glassH / 0.45));
      g.add(vase);
    } else if (style === "plinth") {
      // A deco bust: stacked forms reading as a statue.
      const bust = new THREE.Group();
      const torso = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), gold);
      torso.scale.set(1.1, 0.7, 0.75);
      torso.position.y = 0.12;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), gold);
      head.position.y = 0.33;
      head.scale.set(0.85, 1.1, 0.9);
      bust.add(torso, head);
      bust.position.y = y;
      g.add(bust);
    } else if (style === "pedestal") {
      const cushion = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.05, 32), this.mat("cushion", () => new THREE.MeshStandardMaterial({ color: "#4a1420", roughness: 0.8 })));
      cushion.position.y = y + 0.02;
      g.add(cushion);
    }
    return g;
  }

  private buildEmitter(e: EmitterDef) {
    const view: EmitterView = { def: e, lenses: [] };
    const housing = e.housing ?? "wall";
    const g = new THREE.Group();
    g.position.set(e.x, 0, e.z);
    const dark = matteMaterial(P.charcoal.clone().multiplyScalar(0.7), 0.5);
    const gold = goldMaterial(0.25, 0.25);
    const lensFor = (y: number, parent: THREE.Object3D, fwd: number) => {
      const mat = glowMaterial(P.laser, 3);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.035, 14, 10), mat);
      lens.position.set(0, y, fwd);
      parent.add(lens);
      const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.01, 8, 20), gold);
      bezel.position.set(0, y, fwd - 0.005);
      parent.add(bezel);
      view.lenses.push({ mesh: lens, mat });
    };
    if (housing === "wall") {
      const head = new THREE.Group();
      head.rotation.y = Math.PI / 2 - e.angle * Math.PI / 180;
      const ys = e.bands.map((b) => BAND_Y[b]);
      const lo = Math.min(...ys) - 0.12, hi = Math.max(...ys) + 0.12;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.16, hi - lo, 0.08), dark);
      box.position.set(0, (lo + hi) / 2, 0.04);
      head.add(box);
      const capT = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.025, 0.1), gold);
      capT.position.set(0, hi, 0.05);
      const capB = capT.clone(); capB.position.y = lo;
      head.add(capT, capB);
      for (const y of ys) lensFor(y, head, 0.09);
      g.add(head);
    } else if (housing === "post") {
      const head = new THREE.Group();
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 20), dark);
      drum.position.y = BAND_Y[e.bands[0]!];
      head.add(drum);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.012, 8, 24), gold);
      ring.rotation.x = Math.PI / 2; ring.position.y = drum.position.y + 0.06;
      head.add(ring);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.16), gold);
      fin.position.set(0, drum.position.y + 0.08, 0.06);
      head.add(fin);
      for (const b of e.bands) lensFor(BAND_Y[b], head, 0.11);
      g.add(head);
      view.head = head;
    }
    this.group.add(g);
    this.emitters.set(e.id, view);
  }

  private buildSensor(id: string, x: number, z: number) {
    const block = this.room.blocks.find((b) => b.style === "sensor" && Math.abs(b.x - x) < 0.01 && Math.abs(b.z - z) < 0.01);
    const top = block ? block.h : 1.0;
    const mat = glowMaterial(P.laser, 0.6);
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), mat);
    crystal.position.set(x, top + 0.14, z);
    crystal.scale.set(0.8, 1.3, 0.8);
    this.group.add(crystal);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.06, 0.08, 20, 1, true), goldMaterial(0.25, 0.2));
    cup.position.set(x, top + 0.04, z);
    this.group.add(cup);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.008, 8, 40), glowMaterial(P.emerald, 0.0));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, top + 0.14, z);
    this.group.add(ring);
    // Floor conduit from the sensor to every emitter it powers: shows the causal link.
    const targets = this.room.emitters.filter((e) => e.poweredBy === id);
    const pts: THREE.Vector3[] = [];
    for (const t of targets) {
      pts.push(new THREE.Vector3(x, 0.006, z), new THREE.Vector3(x, 0.006, t.z), new THREE.Vector3(t.x, 0.006, t.z));
    }
    const conduitMat = glowMaterial(P.laser, 0.5);
    let conduit: THREE.Mesh;
    if (pts.length) {
      const segs: THREE.Vector3[] = [];
      for (let i = 0; i < pts.length; i += 3) segs.push(pts[i]!, pts[i + 1]!, pts[i + 1]!, pts[i + 2]!);
      const geo = new THREE.BufferGeometry();
      const pos: number[] = [];
      for (let i = 0; i < segs.length; i += 2) {
        const a = segs[i]!, b = segs[i + 1]!;
        const dir = new THREE.Vector3().subVectors(b, a);
        const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(0.012);
        pos.push(a.x - side.x, a.y, a.z - side.z, b.x - side.x, b.y, b.z - side.z, b.x + side.x, b.y, b.z + side.z);
        pos.push(a.x - side.x, a.y, a.z - side.z, b.x + side.x, b.y, b.z + side.z, a.x + side.x, a.y, a.z + side.z);
      }
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      conduit = new THREE.Mesh(geo, conduitMat);
      conduitMat.side = THREE.DoubleSide;
      this.group.add(conduit);
    } else {
      conduit = new THREE.Mesh();
    }
    this.sensors.set(id, { crystal, mat, ring, conduit, conduitMat, fed: 0 });
  }

  private buildMount(id: string, x: number, z: number) {
    const mat = glowMaterial(P.gold, 0.8);
    mat.transparent = true;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.235, 48), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.008, z);
    this.group.add(ring);
    const inner = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.065, 24), goldMaterial(0.3, 0.4));
    inner.rotation.x = -Math.PI / 2;
    inner.position.set(x, 0.007, z);
    this.group.add(inner);
    for (let k = 0; k < 4; k++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 0.09), mat);
      const a = (k / 4) * Math.PI * 2;
      tick.rotation.x = -Math.PI / 2;
      tick.rotation.z = a;
      tick.position.set(x + Math.cos(a) * 0.29, 0.008, z + Math.sin(a) * 0.29);
      this.group.add(tick);
    }
    this.mounts.set(id, { ring, mat, hot: 0 });
  }

  /** Cut away walls between the camera and the diorama. */
  updateCutaway(camDir: THREE.Vector3, dt: number) {
    for (const w of this.walls) {
      const facing = w.normal.x * camDir.x + w.normal.z * camDir.z;
      const target = facing > 0.25 ? 0.07 : 1;
      w.cur += (target - w.cur) * (1 - Math.exp(-dt * 7));
      w.g.scale.y = w.cur;
      w.g.visible = w.cur > 0.02;
    }
  }

  update(dt: number, s: { fed: Set<string>; emitterOn: Record<string, boolean>; sweepAngles: Record<string, number>; targetMount: string | null; prizeLifted: boolean; doorOpen: (id: string) => boolean; reduced: boolean }) {
    this.time += dt;
    if (this.floorMat) this.floorMat.uniforms.uTime!.value = this.time;
    for (const [id, v] of this.emitters) {
      const on = s.emitterOn[id] ?? false;
      for (const l of v.lenses) {
        const k = on ? 3.2 : 0.35;
        l.mat.color.copy(v.def.tint === "prism" ? P.cream : P.laser).multiplyScalar(k);
      }
      if (v.head) v.head.rotation.y = Math.PI / 2 - (s.sweepAngles[id] ?? 0) * Math.PI / 180;
    }
    for (const [id, sv] of this.sensors) {
      const target = s.fed.has(id) ? 1 : 0;
      sv.fed += (target - sv.fed) * (1 - Math.exp(-dt * 6));
      const c = new THREE.Color().lerpColors(P.laser, P.emerald, sv.fed);
      sv.mat.color.copy(c).multiplyScalar(0.6 + sv.fed * 3.5);
      sv.crystal.rotation.y += dt * (0.4 + sv.fed * 2.2);
      (sv.ring.material as THREE.MeshBasicMaterial).color.copy(P.emerald).multiplyScalar(sv.fed * 2.5);
      sv.ring.scale.setScalar(1 + Math.sin(this.time * 4) * 0.06 * sv.fed);
      // Conduit: dashed red pulse while the grid is powered, steady emerald once fed.
      const pulse = 0.35 + 0.25 * Math.sin(this.time * 6);
      sv.conduitMat.color.copy(c).multiplyScalar(sv.fed > 0.5 ? 1.4 : pulse);
    }
    for (const [id, mv] of this.mounts) {
      const t = s.targetMount === id ? 1 : 0;
      mv.hot += (t - mv.hot) * (1 - Math.exp(-dt * 10));
      mv.mat.color.copy(P.gold).multiplyScalar(0.6 + mv.hot * (2.4 + Math.sin(this.time * 8) * 0.6));
      mv.ring.scale.setScalar(1 + mv.hot * 0.12);
    }
    for (const d of this.doors) {
      d.target = s.doorOpen(d.def.id) ? 1 : 0;
      const k = 1 - Math.exp(-dt * (d.target > d.open ? 3 : 9));
      d.open += (d.target - d.open) * k;
      const dh = 2.25;
      d.shutter.position.y = dh / 2 + d.open * dh;
      const col = d.target ? (d.def.phase === "out" ? P.emerald : P.gold) : P.laser;
      d.lampMat.color.copy(col).multiplyScalar(d.target ? 2.5 + Math.sin(this.time * 5) * 0.5 : 1.6);
    }
    this.showcaseMat.color.setRGB(1, 0.94, 0.8).multiplyScalar(s.prizeLifted ? 0.025 : 0.07);
    if (!s.reduced) {
      const p = this.motes.geometry.attributes.position as THREE.BufferAttribute;
      const arr = p.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 1]! += dt * 0.03 * (0.5 + ((i * 7) % 5) / 5);
        arr[i]! += Math.sin(this.time * 0.3 + i) * dt * 0.02;
        if (arr[i + 1]! > this.room.size.h * 0.85) arr[i + 1] = 0.05;
      }
      p.needsUpdate = true;
    }
  }
}
