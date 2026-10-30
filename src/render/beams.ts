import * as THREE from "three";
import type { BeamSegment } from "../sim/beams";
import { BAND_Y, FLOOR_H } from "../sim/roomTypes";
import type { Space } from "./space";
import { P, spectral } from "./palette";

const MAX = 512;

const vert = /* glsl */ `
attribute vec2 corner;      // x: 0..1 along, y: -1..1 across
attribute vec3 iA; attribute vec3 iB; attribute vec3 iColor; attribute vec4 iParams; // width, intensity, dash, flat
attribute float iS0;
uniform float uPix; uniform vec3 uCam;
varying vec2 vC; varying vec3 vColor; varying float vI; varying float vDash; varying float vAlong; varying float vFlat;
void main(){
  vec3 P = mix(iA, iB, corner.x);
  // Never thinner than ~1.5 px: beams are gameplay and must survive every quality tier.
  float minW = distance(uCam, P) * uPix * (iParams.w > 0.5 ? 3.0 : (iParams.x < 0.02 ? 2.2 : 1.5));
  float w = max(iParams.x, minW);
  vec3 dir = normalize(iB - iA + vec3(1e-5));
  vec3 side;
  if (iParams.w > 0.5) side = normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
  else side = normalize(cross(dir, normalize(uCam - P)));
  P += side * corner.y * w;
  vC = corner; vColor = iColor; vI = iParams.y * mix(1.0, sqrt(iParams.x / w), 0.6); vDash = iParams.z; vFlat = iParams.w;
  vAlong = iS0 + corner.x * length(iB - iA);
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;

const frag = /* glsl */ `
uniform float uTime;
uniform float uLayer; // 0 = hard core, 1 = glow, 2 = floor wash
varying vec2 vC; varying vec3 vColor; varying float vI; varying float vDash; varying float vAlong; varying float vFlat;
void main(){
  float across = abs(vC.y);
  float prof;
  if (uLayer < 0.5) {
    // Hard core: flat-topped with a one-pixel antialiased edge, plus a white-hot centre line.
    float aa = max(fwidth(across) * 1.25, 1e-3);
    prof = 1.0 - smoothstep(0.62 - aa, 0.62 + aa, across);
  } else if (vFlat > 0.5) prof = pow(1.0 - across, 2.5);
  else prof = exp(-across * across * 5.0) * (1.0 - across);
  float shimmer = 0.92 + 0.08 * sin(uTime * 37.0 + vAlong * 9.0);
  float dash = 1.0;
  if (vDash > 0.0) dash = step(0.5, fract(vAlong * vDash - uTime * 2.0));
  // Fade the very ends so emitters/impacts read as points of light.
  float ends = smoothstep(0.0, 0.02, vC.x) * (1.0 - smoothstep(0.98, 1.0, vC.x));
  vec3 col = vColor;
  if (uLayer < 0.5) col = mix(vColor, vec3(1.0), (1.0 - smoothstep(0.0, 0.35, across)) * 0.55);
  vec3 c = col * vI * prof * shimmer * dash * mix(1.0, ends, 0.6);
  gl_FragColor = vec4(c, 1.0);
}`;

/** All beams as camera-facing ribbons in a single instanced draw per layer. */
export class BeamView {
  readonly group = new THREE.Group();
  private layers: Array<{ mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; a: Float32Array; b: Float32Array; c: Float32Array; p: Float32Array; s: Float32Array }> = [];
  readonly uniforms = { uTime: { value: 0 }, uPix: { value: 0.001 }, uCam: { value: new THREE.Vector3() } };
  private flares: THREE.Points;
  private flarePos: Float32Array;
  private flareCol: Float32Array;
  flash = new Map<string, number>();
  /** Beams that caught Locke: held bright and pulsing so the player sees what tripped them. */
  tripped = new Map<string, number>();
  /** Near-misses: a quick hot flicker on the beam he just slipped past. */
  sizzle = new Map<string, number>();
  private tmp = new THREE.Color();

  constructor() {
    for (let i = 0; i < 3; i++) {
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute("corner", new THREE.Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      const a = new Float32Array(MAX * 3), b = new Float32Array(MAX * 3), c = new Float32Array(MAX * 3), p = new Float32Array(MAX * 4), s = new Float32Array(MAX);
      geo.setAttribute("iA", new THREE.InstancedBufferAttribute(a, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("iB", new THREE.InstancedBufferAttribute(b, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("iColor", new THREE.InstancedBufferAttribute(c, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("iParams", new THREE.InstancedBufferAttribute(p, 4).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("iS0", new THREE.InstancedBufferAttribute(s, 1).setUsage(THREE.DynamicDrawUsage));
      geo.instanceCount = 0;
      const mat = new THREE.ShaderMaterial({ uniforms: { ...this.uniforms, uLayer: { value: i } }, vertexShader: vert, fragmentShader: frag, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 5 + i;
      this.group.add(mesh);
      this.layers.push({ mesh, geo, a, b, c, p, s });
    }
    // Impact flares where beams end on walls.
    this.flarePos = new Float32Array(MAX * 3);
    this.flareCol = new Float32Array(MAX * 3);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute("position", new THREE.BufferAttribute(this.flarePos, 3).setUsage(THREE.DynamicDrawUsage));
    fg.setAttribute("color", new THREE.BufferAttribute(this.flareCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.flares = new THREE.Points(fg, new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `attribute vec3 color; varying vec3 vCol; void main(){ vCol = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = 260.0 / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `varying vec3 vCol; void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; float a = pow(max(0.0, 1.0 - r), 3.0); float star = max(0.0, 1.0 - abs(d.x) * 14.0) * max(0.0, 1.0 - abs(d.y) * 2.2) + max(0.0, 1.0 - abs(d.y) * 14.0) * max(0.0, 1.0 - abs(d.x) * 2.2); gl_FragColor = vec4(vCol * (a + star * 0.5), 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    }));
    this.flares.frustumCulled = false;
    this.group.add(this.flares);
  }

  colorFor(seg: BeamSegment, time: number, out: THREE.Color): THREE.Color {
    if (seg.tint === "prism") return spectral(seg.spoke * 0.17 + (seg.band === "high" ? 0.5 : 0) + seg.bounce * 0.08 + time * 0.05, out).multiplyScalar(1.1);
    if (seg.tint === "emerald") return out.copy(P.emerald);
    if (seg.tint === "violet") return out.copy(P.violet);
    if (seg.tint === "gold") return out.copy(P.gold);
    if (seg.tint === "camera") return out.setRGB(0.75, 0.85, 1.0).multiplyScalar(0.55);
    return out.copy(P.laser);
  }

  /** Colour-independent beam language: each type gets its own pattern. */
  patterns = false;

  /** Camera obscura: hidden beams drawn at full strength (and remembered faintly after). */
  reveal = 0;
  space: Space | null = null;
  /** The floor Locke is on: beams on other floors are drawn as quiet reference lines. */
  focusFloor = 0;
  private pa = new THREE.Vector3();
  private pb = new THREE.Vector3();

  update(segments: BeamSegment[], dt: number, time: number) {
    this.uniforms.uTime.value = time;
    for (const m of [this.flash, this.tripped, this.sizzle]) for (const [k, v] of m) { const n = v - dt; if (n <= 0) m.delete(k); else m.set(k, n); }
    const [core, glow, floor] = this.layers as [typeof this.layers[0], typeof this.layers[0], typeof this.layers[0]];
    let n = 0, f = 0;
    for (const seg of segments) {
      if (n >= MAX) break;
      const y = BAND_Y[seg.band];
      const sp = this.space;
      const side = !!sp?.side;
      if (sp) { sp.at(seg.a.x, seg.a.z, y, seg.floor, this.pa); sp.at(seg.b.x, seg.b.z, y, seg.floor, this.pb); }
      else { this.pa.set(seg.a.x, y, seg.a.z); this.pb.set(seg.b.x, y, seg.b.z); }
      if (seg.vertical) {
        // Grate shaft: from the grille below up through the whole floor above.
        if (seg.band !== "mid") continue;
        this.pa.y = (seg.floor - 1) * FLOOR_H + 0.05; this.pb.y = seg.floor * FLOOR_H + 2.1;
      }
      const other = !seg.vertical && seg.floor !== this.focusFloor;
      const hide = (seg.hidden ? 0.12 + 0.88 * this.reveal : 1) * (other ? 0.22 : 1);
      const col = this.colorFor(seg, time, this.tmp);
      const tr = this.tripped.get(seg.emitter) ?? 0;
      const sz = this.sizzle.get(seg.emitter) ?? 0;
      const fl = Math.max(this.flash.get(seg.emitter) ?? 0, tr > 0 ? 0.25 + 0.2 * Math.abs(Math.sin(time * 14)) : 0, sz > 0 ? (Math.sin(time * 90) > 0 ? 0.3 : 0.1) * Math.min(1, sz * 4) : 0);
      const warnOnly = !seg.live;
      const intensity = (warnOnly ? 0.35 + seg.warn * 0.9 : 1) * hide * (seg.tint === "camera" ? 0.6 : 1);
      const pattern = !this.patterns ? 0 : seg.type === "pulse" ? 3.5 : seg.type === "sweeper" ? (seg.tint === "prism" ? 0 : 12) : seg.type === "oscillator" ? 6 : 0;
      const dash = warnOnly ? 6 : seg.type === "tripwire" ? 9 : pattern;
      const whiten = Math.min(1, fl * 3);
      const cr = col.r + (1 - col.r) * whiten, cg = col.g + (1 - col.g) * whiten, cb = col.b + (1 - col.b) * whiten;
      for (const [L, width, inten, flat, yy] of [
        [core, 0.008, 7, 0, y],
        [glow, other ? 0.03 : 0.075, 0.3, 0, y],
        [floor, 0.32, side || seg.vertical || other ? 0 : 0.22 * (1.6 - y * 0.5), 1, 0.012]
      ] as const) {
        const dy = L === floor ? yy - y : 0;
        L.a[n * 3] = this.pa.x; L.a[n * 3 + 1] = this.pa.y + dy; L.a[n * 3 + 2] = this.pa.z;
        L.b[n * 3] = this.pb.x; L.b[n * 3 + 1] = (seg.vertical && L === floor ? this.pa.y : this.pb.y) + dy; L.b[n * 3 + 2] = this.pb.z;
        L.c[n * 3] = cr; L.c[n * 3 + 1] = cg; L.c[n * 3 + 2] = cb;
        L.p[n * 4] = width * (1 + fl * 2); L.p[n * 4 + 1] = inten * intensity * (1 + fl * 2); L.p[n * 4 + 2] = dash; L.p[n * 4 + 3] = flat;
        L.s[n] = seg.s0;
      }
      n++;
      if (seg.live && f < MAX) {
        this.flarePos[f * 3] = this.pb.x; this.flarePos[f * 3 + 1] = this.pb.y; this.flarePos[f * 3 + 2] = this.pb.z;
        this.flareCol[f * 3] = cr * 1.6; this.flareCol[f * 3 + 1] = cg * 1.6; this.flareCol[f * 3 + 2] = cb * 1.6;
        f++;
      }
    }
    for (const L of this.layers) {
      L.geo.instanceCount = n;
      for (const k of ["iA", "iB", "iColor", "iParams", "iS0"]) (L.geo.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
    }
    this.flares.geometry.setDrawRange(0, f);
    (this.flares.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.flares.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}
