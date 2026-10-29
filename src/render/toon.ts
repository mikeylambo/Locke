import * as THREE from "three";
import { CHATOYANT_GLSL, chatoyStrength } from "./chatoyant";

/** Shared lighting rig for every toon surface (Locke, gadgets). Updated once per frame. */
export const toonLights = {
  key: { value: new THREE.Vector3(-0.35, 0.85, 0.4).normalize() },
  rimDir: { value: new THREE.Vector3(0.2, 0.35, -1).normalize() },
  rimColor: { value: new THREE.Color("#ffe9c4").multiplyScalar(0.42) },
  ambient: { value: new THREE.Color("#3a3346") },
  flash: { value: 0 }
};

export interface ToonOptions {
  color: THREE.ColorRepresentation;
  shade?: THREE.ColorRepresentation;
  stripes?: number;
  stripeColor?: THREE.ColorRepresentation;
  /** 0 = stripes around local Y (torso), 1 = stripes along tube length (limbs). */
  stripeMode?: 0 | 1;
  gloss?: number;
  rim?: number;
  emissive?: THREE.ColorRepresentation;
  /** Cat's-eye sheen strength (gold accents only). */
  chatoy?: number;
}

const vert = /* glsl */ `
varying vec3 vN; varying vec3 vW; varying vec2 vUv; varying vec3 vLocal;
void main(){
  vUv = uv; vLocal = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const frag = /* glsl */ `
uniform vec3 uColor; uniform vec3 uShade; uniform vec3 uStripe; uniform vec3 uEmissive;
uniform float uStripes; uniform float uStripeMode; uniform float uGloss; uniform float uRim;
uniform vec3 uKey; uniform vec3 uRimDir; uniform vec3 uRimColor; uniform vec3 uAmbient; uniform float uFlash; uniform float uChatoyAmt; uniform float uChatoy;
${CHATOYANT_GLSL}
varying vec3 vN; varying vec3 vW; varying vec2 vUv; varying vec3 vLocal;
void main(){
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(cameraPosition - vW);
  float ndl = dot(n, uKey);
  float lit = smoothstep(0.18, 0.24, ndl);
  float mid = smoothstep(-0.35, -0.28, ndl);
  vec3 base = uColor;
  if (uStripes > 0.0) {
    float c = uStripeMode < 0.5 ? atan(vLocal.z, vLocal.x) / 6.2831853 * uStripes : vUv.x * uStripes;
    float s = smoothstep(0.42, 0.47, abs(fract(c) - 0.5));
    base = mix(base, uStripe, s * 0.85);
  }
  vec3 col = mix(uShade * base * 1.4, base, lit);
  col = mix(uAmbient * base * 1.6, col, mid);
  // Stepped Blinn highlight.
  vec3 h = normalize(uKey + v);
  float spec = pow(max(dot(n, h), 0.0), 48.0);
  col += step(0.55, spec) * uGloss * vec3(1.0, 0.96, 0.88);
  // Cream rim light from behind: reads Locke against the black room.
  float fr = 1.0 - max(dot(n, v), 0.0);
  float rimMask = smoothstep(0.62, 0.7, fr) * smoothstep(-0.1, 0.5, dot(n, uRimDir) + 0.15);
  col += uRimColor * rimMask * uRim;
  col += uEmissive;
  if (uChatoyAmt > 0.0) col += vec3(1.0, 0.9, 0.68) * uChatoyAmt * uChatoy * chatoyBand(n, v, normalize(vec3(0.25, 1.0, 0.15)), 40.0);
  col = mix(col, vec3(1.0, 0.95, 0.85), uFlash * 0.6);
  gl_FragColor = vec4(col, 1.0);
}`;

export function toonMaterial(o: ToonOptions): THREE.ShaderMaterial {
  const color = new THREE.Color(o.color);
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uShade: { value: new THREE.Color(o.shade ?? "#6c5a7a") },
      uStripe: { value: new THREE.Color(o.stripeColor ?? "#cfc3a8") },
      uEmissive: { value: new THREE.Color(o.emissive ?? 0x000000) },
      uStripes: { value: o.stripes ?? 0 },
      uStripeMode: { value: o.stripeMode ?? 0 },
      uGloss: { value: o.gloss ?? 0.25 },
      uRim: { value: o.rim ?? 1 },
      uKey: toonLights.key,
      uRimDir: toonLights.rimDir,
      uRimColor: toonLights.rimColor,
      uAmbient: toonLights.ambient,
      uFlash: toonLights.flash,
      uChatoyAmt: { value: o.chatoy ?? 0 },
      uChatoy: chatoyStrength
    },
    vertexShader: vert,
    fragmentShader: frag
  });
}

const outlineVert = /* glsl */ `
uniform float uWidth;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  // Constant-ish screen width: scale with view depth.
  mv.xyz += n * uWidth * (0.6 + 0.04 * -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const outlineFrag = /* glsl */ `
uniform vec3 uInk;
void main(){ gl_FragColor = vec4(uInk, 1.0); }`;

const inkUniform = { value: new THREE.Color("#050407") };

export function outlineMaterial(width = 0.012): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uWidth: { value: width }, uInk: inkUniform },
    vertexShader: outlineVert,
    fragmentShader: outlineFrag,
    side: THREE.BackSide
  });
}

/** Mesh + inverted-hull ink outline sharing one geometry. */
export function inked(geo: THREE.BufferGeometry, mat: THREE.Material, width = 0.012): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  const o = new THREE.Mesh(geo, outlineMaterial(width));
  o.name = "ink";
  o.raycast = () => {};
  m.add(o);
  return m;
}
