import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { HorizontalTiltShiftShader } from "three/examples/jsm/shaders/HorizontalTiltShiftShader.js";
import { VerticalTiltShiftShader } from "three/examples/jsm/shaders/VerticalTiltShiftShader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export type Quality = "cinematic" | "balanced" | "performance";

interface TierSpec { pr: number; bloomScale: number; bloomOn: boolean; tilt: boolean; msaa: number; vignette: boolean }
export const TIERS: Record<Quality, TierSpec> = {
  // Tilt-shift is gone everywhere: it smeared beams off the focus line. Depth comes from fog + vignette.
  cinematic: { pr: 2, bloomScale: 0.5, bloomOn: true, tilt: false, msaa: 4, vignette: true },
  balanced: { pr: 2, bloomScale: 0.5, bloomOn: true, tilt: false, msaa: 0, vignette: true },
  performance: { pr: 1.5, bloomScale: 0.35, bloomOn: true, tilt: false, msaa: 0, vignette: true }
};

/** Pick a tier once, at load. Never changed mid-run except by the player in Settings. */
export function detectTier(): Quality {
  if (matchMedia("(pointer: coarse)").matches) return "performance";
  return "balanced";
}

/** Cheap depth cue replacing tilt-shift: a soft vignette that darkens and fogs the frame edges. */
const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, uStrength: { value: 0.55 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uStrength; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv - vec2(0.5, 0.55); float v = smoothstep(0.35, 0.95, length(d * vec2(1.0, 1.25)));
      c.rgb = mix(c.rgb, c.rgb * vec3(0.55, 0.5, 0.6), v * uStrength); gl_FragColor = c; }`
};

/** Renderer, quality-tiered post stack and the orbiting diorama camera. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private hTilt!: ShaderPass;
  private vTilt!: ShaderPass;
  private passNames: string[] = [];
  quality: Quality;
  /** Per-pass CPU+GPU ms (gl.finish fenced) when profiling. */
  profile: Record<string, number> | null = null;

  // Orbit rig.
  yaw = 0; pitch = 0.86; dist = 15;
  private yawTarget = 0; private pitchTarget = 0.86; private distTarget = 15;
  readonly target = new THREE.Vector3(0, 0.4, 0.3);
  private targetGoal = new THREE.Vector3(0, 0.4, 0.3);
  freeOrbit = true;
  baseDist = 15;
  /** Debug/photo override of the follow target. */
  pin: { x: number; z: number; y?: number } | null = null;
  private shake = 0;
  private shakeT = 0;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.scene.background = new THREE.Color("#050407");
    this.scene.fog = new THREE.Fog("#050407", 20, 36);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.3;

    this.scene.add(new THREE.HemisphereLight("#5a4a6a", "#0a0806", 0.55));
    const key = new THREE.DirectionalLight("#ffd9a0", 1.1);
    key.position.set(-4, 9, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight("#8fa6ff", 0.55);
    rim.position.set(3, 5, -8);
    this.scene.add(rim);
    this.buildComposer();
    addEventListener("resize", () => this.resize());
  }

  buildComposer() {
    const t = TIERS[this.quality];
    this.composer?.dispose();
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: t.msaa });
    this.composer = new EffectComposer(this.renderer, rt);
    this.passNames = ["scene"];
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.65, 0.28, 1.15);
    if (t.bloomOn) { this.composer.addPass(this.bloom); this.passNames.push("bloom"); }
    this.hTilt = new ShaderPass(HorizontalTiltShiftShader);
    this.vTilt = new ShaderPass(VerticalTiltShiftShader);
    if (t.tilt) { this.composer.addPass(this.hTilt); this.composer.addPass(this.vTilt); this.passNames.push("tiltH", "tiltV"); }
    if (t.vignette) { this.composer.addPass(new ShaderPass(VignetteShader)); this.passNames.push("vignette"); }
    this.composer.addPass(new OutputPass());
    this.passNames.push("output");
    // Fence each pass for the ?debug profiler.
    this.composer.passes.forEach((pass, i) => {
      const name = this.passNames[i]!;
      const orig = pass.render.bind(pass);
      pass.render = (...args: Parameters<typeof orig>) => {
        if (!this.profile) return orig(...args);
        const gl = this.renderer.getContext();
        gl.finish();
        const t0 = performance.now();
        orig(...args);
        gl.finish();
        this.profile[name] = performance.now() - t0;
      };
    });
    this.resize();
  }

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    this.buildComposer();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    const t = TIERS[this.quality];
    const pr = Math.min(devicePixelRatio, t.pr);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w * pr * t.bloomScale, h * pr * t.bloomScale);
    this.bloom.setSize(w * pr * t.bloomScale, h * pr * t.bloomScale);
    this.camera.aspect = w / h;
    // Keep the whole diorama framed on portrait phones.
    this.distTarget = this.baseDist * (w / h < 1 ? Math.min(1.9, 1.15 / (w / h)) : 1);
    this.camera.updateProjectionMatrix();
    const amount = 0.8;
    (this.hTilt.uniforms.h as { value: number }).value = amount / (w * pr);
    (this.vTilt.uniforms.v as { value: number }).value = amount / (h * pr);
  }

  /** World size of one screen pixel at unit depth (for minimum beam width). */
  pixelAngle(): number {
    const pr = this.renderer.getPixelRatio();
    return (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / (innerHeight * pr);
  }

  orbit(dYaw: number, dPitch: number) {
    if (this.side || this.overheadOn) return;
    this.yawTarget += dYaw;
    this.pitchTarget = Math.max(0.42, Math.min(1.32, this.pitchTarget + dPitch));
  }

  /** Snap to the nearest of 8 readable angles. */
  snap() { if (this.side) return; this.yawTarget = Math.round(this.yawTarget / (Math.PI / 4)) * (Math.PI / 4); }
  snapStep(dir: number) { if (this.side) return; this.yawTarget = (Math.round(this.yawTarget / (Math.PI / 4)) + dir) * (Math.PI / 4); }

  /** Fog scales with the framing so long galleries don't drown in it. */
  setDist(d: number) {
    this.baseDist = d; this.resize();
    const fog = this.scene.fog as THREE.Fog;
    fog.near = Math.max(20, d * 1.25); fog.far = Math.max(36, d * 2.3);
  }

  focus(x: number, z: number, weight: number, y = 0.4) {
    if (this.pin) { this.targetGoal.set(this.pin.x, this.pin.y ?? 0.6, this.pin.z); return; }
    if (this.side) { this.targetGoal.set(x * weight, y, 0); return; }
    this.targetGoal.set(x * weight, y, 0.3 + (z - 0.3) * weight);
  }

  /** Side-view rooms: camera locked square-on to the x/y plane. */
  side = false;
  private savedPitch = 0.86;
  lockSide(on: boolean) {
    this.side = on;
    if (on) { this.yawTarget = 0; this.pitchTarget = 0.1; }
    else this.pitchTarget = 0.86;
  }

  /** Camera obscura: swing up to a straight-down plan view and back. */
  private overheadOn = false;
  overhead(on: boolean) {
    if (on === this.overheadOn) return;
    this.overheadOn = on;
    if (on) { this.savedPitch = this.pitchTarget; this.pitchTarget = 1.5; }
    else this.pitchTarget = this.savedPitch;
  }

  /** Jump straight to the current goals (cuts, debug). */
  cut() { this.yaw = this.yawTarget; this.pitch = this.pitchTarget; this.dist = this.distTarget; this.target.copy(this.targetGoal); }

  kick(amount: number) { this.shake = Math.max(this.shake, amount); }

  update(dt: number, reduced: boolean) {
    const k = 1 - Math.exp(-dt * 6);
    this.yaw += (this.yawTarget - this.yaw) * k;
    this.pitch += (this.pitchTarget - this.pitch) * k;
    this.dist += (this.distTarget - this.dist) * k;
    this.target.lerp(this.targetGoal, 1 - Math.exp(-dt * 2.5));
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + sp * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist
    );
    this.camera.lookAt(this.target);
    if (this.shake > 0 && !reduced) {
      this.shakeT += dt * 40;
      this.camera.position.x += Math.sin(this.shakeT * 1.3) * this.shake * 0.08;
      this.camera.position.y += Math.sin(this.shakeT * 1.9) * this.shake * 0.06;
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }
  }

  /** World → screen focus line for tilt-shift (0 = bottom, 1 = top). */
  setFocusWorld(p: THREE.Vector3) {
    if (!TIERS[this.quality].tilt) return;
    const v = p.clone().project(this.camera);
    const r = Math.max(0.2, Math.min(0.8, v.y * 0.5 + 0.5));
    (this.hTilt.uniforms.r as { value: number }).value = r;
    (this.vTilt.uniforms.r as { value: number }).value = r;
  }

  render() { this.renderer.info.reset(); this.composer.render(); }

  /** Horizontal camera forward/right on the floor plane, for camera-relative movement. */
  basis(): { fwd: { x: number; z: number }; right: { x: number; z: number } } {
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    return { fwd: { x: fx, z: fz }, right: { x: -fz, z: fx } };
  }
}
