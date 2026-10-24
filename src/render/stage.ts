import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { HorizontalTiltShiftShader } from "three/examples/jsm/shaders/HorizontalTiltShiftShader.js";
import { VerticalTiltShiftShader } from "three/examples/jsm/shaders/VerticalTiltShiftShader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export type Quality = "high" | "low";

/** Renderer, post stack (bloom → tilt-shift → output) and the orbiting diorama camera. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private hTilt: ShaderPass;
  private vTilt: ShaderPass;
  quality: Quality;

  // Orbit rig.
  yaw = 0; pitch = 0.86; dist = 15;
  private yawTarget = 0; private pitchTarget = 0.86; private distTarget = 15;
  readonly target = new THREE.Vector3(0, 0.4, 0.3);
  private targetGoal = new THREE.Vector3(0, 0.4, 0.3);
  freeOrbit = true;
  baseDist = 15;
  /** Debug/photo override of the follow target. */
  pin: { x: number; z: number } | null = null;
  private shake = 0;
  private shakeT = 0;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === "high", powerPreference: "high-performance" });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color("#050407");
    this.scene.fog = new THREE.Fog("#050407", 22, 40);
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

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: quality === "high" ? 4 : 0 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.45, 1.15);
    this.composer.addPass(this.bloom);
    this.hTilt = new ShaderPass(HorizontalTiltShiftShader);
    this.vTilt = new ShaderPass(VerticalTiltShiftShader);
    this.composer.addPass(this.hTilt);
    this.composer.addPass(this.vTilt);
    this.composer.addPass(new OutputPass());
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    const pr = Math.min(devicePixelRatio, this.quality === "high" ? 2 : 1);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w * pr * 0.5, h * pr * 0.5);
    this.camera.aspect = w / h;
    // Keep the whole diorama framed on portrait phones.
    this.distTarget = this.baseDist * (w / h < 1 ? Math.min(1.9, 1.15 / (w / h)) : 1);
    this.camera.updateProjectionMatrix();
    const amount = 0.8;
    (this.hTilt.uniforms.h as { value: number }).value = amount / (w * pr);
    (this.vTilt.uniforms.v as { value: number }).value = amount / (h * pr);
  }

  orbit(dYaw: number, dPitch: number) {
    this.yawTarget += dYaw;
    this.pitchTarget = Math.max(0.42, Math.min(1.32, this.pitchTarget + dPitch));
  }

  /** Snap to the nearest of 8 readable angles. */
  snap() { this.yawTarget = Math.round(this.yawTarget / (Math.PI / 4)) * (Math.PI / 4); }
  snapStep(dir: number) { this.yawTarget = (Math.round(this.yawTarget / (Math.PI / 4)) + dir) * (Math.PI / 4); }

  setDist(d: number) { this.baseDist = d; this.resize(); }

  focus(x: number, z: number, weight: number) {
    if (this.pin) { this.targetGoal.set(this.pin.x, 0.6, this.pin.z); return; }
    this.targetGoal.set(x * weight, 0.4, 0.3 + (z - 0.3) * weight);
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
    const v = p.clone().project(this.camera);
    const r = Math.max(0.2, Math.min(0.8, v.y * 0.5 + 0.5));
    (this.hTilt.uniforms.r as { value: number }).value = r;
    (this.vTilt.uniforms.r as { value: number }).value = r;
  }

  render() { this.composer.render(); }

  /** Horizontal camera forward/right on the floor plane, for camera-relative movement. */
  basis(): { fwd: { x: number; z: number }; right: { x: number; z: number } } {
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    return { fwd: { x: fx, z: fz }, right: { x: -fz, z: fx } };
  }
}
