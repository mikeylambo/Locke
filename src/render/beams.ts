import * as THREE from "three";
import type { BeamSegment } from "../sim/beams";
import { BAND_Y } from "../sim/roomTypes";
import { P, spectral } from "./palette";

const MAX = 512;

const vert = /* glsl */ `
attribute vec2 corner;      // x: 0..1 along, y: -1..1 across
attribute vec3 iA; attribute vec3 iB; attribute vec3 iColor; attribute vec4 iParams; // width, intensity, dash, flat
attribute float iS0;
varying vec2 vC; varying vec3 vColor; varying float vI; varying float vDash; varying float vAlong; varying float vFlat;
void main(){
  vec3 P = mix(iA, iB, corner.x);
  vec3 dir = normalize(iB - iA + vec3(1e-5));
  vec3 side;
  if (iParams.w > 0.5) side = normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
  else side = normalize(cross(dir, normalize(cameraPosition - P)));
  P += side * corner.y * iParams.x;
  vC = corner; vColor = iColor; vI = iParams.y; vDash = iParams.z; vFlat = iParams.w;
  vAlong = iS0 + corner.x * length(iB - iA);
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;

const frag = /* glsl */ `
uniform float uTime;
varying vec2 vC; varying vec3 vColor; varying float vI; varying float vDash; varying float vAlong; varying float vFlat;
void main(){
  float across = abs(vC.y);
  float prof = vFlat > 0.5 ? pow(1.0 - across, 2.5) : exp(-across * across * 6.0) * (1.0 - across);
  float shimmer = 0.92 + 0.08 * sin(uTime * 37.0 + vAlong * 9.0);
  float dash = 1.0;
  if (vDash > 0.0) dash = step(0.5, fract(vAlong * vDash - uTime * 2.0));
  // Fade the very ends so emitters/impacts read as points of light.
  float ends = smoothstep(0.0, 0.02, vC.x) * smoothstep(1.0, 0.98, vC.x);
  vec3 c = vColor * vI * prof * shimmer * dash * mix(1.0, ends, 0.6);
  gl_FragColor = vec4(c, 1.0);
}`;

/** All beams as camera-facing ribbons in a single instanced draw per layer. */
export class BeamView {
  readonly group = new THREE.Group();
  private layers: Array<{ mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; a: Float32Array; b: Float32Array; c: Float32Array; p: Float32Array; s: Float32Array }> = [];
  private readonly uniforms = { uTime: { value: 0 } };
  private flares: THREE.Points;
  private flarePos: Float32Array;
  private flareCol: Float32Array;
  flash = new Map<string, number>();
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
      const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: vert, fragmentShader: frag, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
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
    return out.copy(P.laser);
  }

  update(segments: BeamSegment[], dt: number, time: number) {
    this.uniforms.uTime.value = time;
    for (const [k, v] of this.flash) { const n = v - dt; if (n <= 0) this.flash.delete(k); else this.flash.set(k, n); }
    const [core, glow, floor] = this.layers as [typeof this.layers[0], typeof this.layers[0], typeof this.layers[0]];
    let n = 0, f = 0;
    for (const seg of segments) {
      if (n >= MAX) break;
      const y = BAND_Y[seg.band];
      const col = this.colorFor(seg, time, this.tmp);
      const fl = this.flash.get(seg.emitter) ?? 0;
      const warnOnly = !seg.live;
      const intensity = warnOnly ? 0.35 + seg.warn * 0.9 : 1;
      const dash = warnOnly ? 6 : seg.type === "tripwire" ? 9 : 0;
      const whiten = Math.min(1, fl * 3);
      const cr = col.r + (1 - col.r) * whiten, cg = col.g + (1 - col.g) * whiten, cb = col.b + (1 - col.b) * whiten;
      for (const [L, width, inten, flat, yy] of [
        [core, 0.009, 9, 0, y],
        [glow, 0.05, 0.42, 0, y],
        [floor, 0.32, 0.22 * (1.6 - y * 0.5), 1, 0.012]
      ] as const) {
        L.a[n * 3] = seg.a.x; L.a[n * 3 + 1] = yy; L.a[n * 3 + 2] = seg.a.z;
        L.b[n * 3] = seg.b.x; L.b[n * 3 + 1] = yy; L.b[n * 3 + 2] = seg.b.z;
        L.c[n * 3] = cr; L.c[n * 3 + 1] = cg; L.c[n * 3 + 2] = cb;
        L.p[n * 4] = width * (1 + fl * 2); L.p[n * 4 + 1] = inten * intensity * (1 + fl * 2); L.p[n * 4 + 2] = dash; L.p[n * 4 + 3] = flat;
        L.s[n] = seg.s0;
      }
      n++;
      if (seg.live && f < MAX) {
        this.flarePos[f * 3] = seg.b.x; this.flarePos[f * 3 + 1] = y; this.flarePos[f * 3 + 2] = seg.b.z;
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
