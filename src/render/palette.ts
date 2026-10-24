import * as THREE from "three";

/** Light Fingers palette: black, charcoal, cream, gold, warm brown — plus the rule colours of light. */
export const P = {
  black: new THREE.Color("#09080b"),
  ink: new THREE.Color("#050407"),
  charcoal: new THREE.Color("#2a2830"),
  suit: new THREE.Color("#4a4653"),
  cream: new THREE.Color("#f3e7cc"),
  glove: new THREE.Color("#fffaf0"),
  gold: new THREE.Color("#d9aa52"),
  goldDeep: new THREE.Color("#8e6424"),
  brown: new THREE.Color("#6e4a2c"),
  wall: new THREE.Color("#0f0d13"),
  floor: new THREE.Color("#07060a"),
  laser: new THREE.Color(1.0, 0.1, 0.14),
  emerald: new THREE.Color(0.12, 1.0, 0.55),
  violet: new THREE.Color(0.65, 0.3, 1.0)
};

export function goldMaterial(rough = 0.32, emissive = 0.06): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: P.gold, metalness: 1, roughness: rough, emissive: P.goldDeep, emissiveIntensity: emissive * 0.5, envMapIntensity: 0.55 });
}

export function matteMaterial(color: THREE.Color = P.wall, rough = 0.88): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.05, roughness: rough, envMapIntensity: 0.25 });
}

export function glowMaterial(color: THREE.Color, intensity = 3): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(intensity), toneMapped: false });
}

/** HSV-ish spectral colour for prism light. */
export function spectral(t: number, out = new THREE.Color()): THREE.Color {
  return out.setHSL(((t % 1) + 1) % 1, 1, 0.55);
}
