import * as THREE from "three";

/**
 * Cat's-eye sheen: a soft band of light lying across a fibre axis that glides over the surface as the
 * view changes. Pure ALU, no textures, so it's safe on every tier. Gold accents only; never on beams.
 */
export const CHATOYANT_GLSL = /* glsl */ `
float chatoyBand(vec3 n, vec3 v, vec3 fibre, float width) {
  // The band sits where the view direction lines up with the surface's cross-fibre direction.
  vec3 across = normalize(cross(n, fibre) + 1e-4);
  float h = dot(across, v);
  return exp(-h * h * width);
}`;

export const chatoyStrength = { value: 1 };

/** Inject the band into a MeshStandardMaterial as extra emissive light. */
export function chatoyant<T extends THREE.MeshStandardMaterial>(mat: T, color = new THREE.Color("#ffe6b0"), strength = 0.55, width = 60): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uChatoyColor = { value: color.clone().multiplyScalar(strength) };
    shader.uniforms.uChatoy = chatoyStrength;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vChWorld; varying vec3 vChNormal;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvChWorld = (modelMatrix * vec4(transformed, 1.0)).xyz; vChNormal = normalize(mat3(modelMatrix) * objectNormal);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform vec3 uChatoyColor; uniform float uChatoy; varying vec3 vChWorld; varying vec3 vChNormal;\n${CHATOYANT_GLSL}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n{ vec3 vv = normalize(cameraPosition - vChWorld); totalEmissiveRadiance += uChatoyColor * uChatoy * chatoyBand(normalize(vChNormal), vv, normalize(vec3(0.25, 1.0, 0.15)), ${width.toFixed(1)}); }`);
  };
  mat.customProgramCacheKey = () => `chatoy-${width}`;
  return mat;
}
