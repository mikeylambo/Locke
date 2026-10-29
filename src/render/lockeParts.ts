import * as THREE from "three";
import { P } from "./palette";
import { inked, toonMaterial } from "./toon";

/**
 * Mr. Locke as swappable parts. Each slot is a named group parented to a named attach point; the
 * procedural build fills it, and a GLB from /models/locke/manifest.json can replace its contents
 * without touching the rig. Limbs stay procedural hoses (the stretch needs them). See docs/locke-model-spec.md.
 */
export type Expression = "cool" | "grin" | "surprised" | "serious";
export const EXPRESSIONS: Expression[] = ["cool", "grin", "surprised", "serious"];

export const SLOTS = ["torso", "head", "hat", "glasses", "glove_L", "glove_R", "shoe_L", "shoe_R", "bust"] as const;
export type Slot = (typeof SLOTS)[number];

/** Attach points: where each slot's origin sits (metres, parent space). */
export const ATTACH = {
  pt_hips: "body → torso origin (pelvis centre)",
  pt_neck: "torso → head origin (base of skull)",
  pt_crown: "head → hat origin (top of head, brim plane)",
  pt_eyes: "head → glasses origin (bridge of nose)",
  pt_wrist_L: "hose end → left glove (fingers along +Z)",
  pt_wrist_R: "hose end → right glove (fingers along +Z)",
  pt_ankle_L: "body → left shoe (toe along +Z, sole at y=0)",
  pt_ankle_R: "body → right shoe (toe along +Z, sole at y=0)"
} as const;

/** Rig dimensions for a 6'1" (1.85 m) lean build. */
export const DIM = {
  hipY: 0.92, torsoH: 0.6, shoulderY: 0.53, shoulderX: 0.2, hipX: 0.09,
  neckY: 0.66, headR: 0.125, crownY: 0.135, eyesZ: 0.118
};

export const mats = () => ({
  suit: toonMaterial({ color: "#17151b", shade: "#2c2834", stripes: 34, stripeColor: "#8a7350", stripeMode: 0, gloss: 0.12 }),
  sleeve: toonMaterial({ color: "#17151b", shade: "#2c2834", stripes: 6, stripeColor: "#8a7350", stripeMode: 1, gloss: 0.1 }),
  vest: toonMaterial({ color: "#121015", shade: "#25212c", stripes: 22, stripeColor: "#6e5c40", stripeMode: 0, gloss: 0.15 }),
  shirt: toonMaterial({ color: "#f4efe4", shade: "#b8ad9e", gloss: 0.2 }),
  skin: toonMaterial({ color: "#6b4028", shade: "#3e2215", gloss: 0.35, rim: 0.7 }),
  beard: toonMaterial({ color: "#100c0b", shade: "#1e1715", gloss: 0.05, rim: 0.4 }),
  glove: toonMaterial({ color: P.glove, shade: "#b9b0c2", gloss: 0.35 }),
  black: toonMaterial({ color: "#0d0b10", shade: "#221d29", gloss: 0.7, rim: 0.6 }),
  white: toonMaterial({ color: "#f6f2ea", shade: "#bdb4a8", gloss: 0.4 }),
  gold: toonMaterial({ color: P.gold, shade: "#7b5320", gloss: 1.2, emissive: "#2a1a04", chatoy: 0.9 }),
  goldFlat: toonMaterial({ color: P.gold, shade: "#7b5320", gloss: 0.6, emissive: "#1a1003" }),
  hat: toonMaterial({ color: "#121015", shade: "#2a2433", gloss: 0.3, rim: 0.35 }),
  band: toonMaterial({ color: "#eee3cc", shade: "#a89a82", gloss: 0.2 }),
  mouth: toonMaterial({ color: "#2a0d0a", shade: "#1a0605", gloss: 0, rim: 0 }),
  teeth: toonMaterial({ color: "#fbf7ee", shade: "#cfc6b8", gloss: 0.5, rim: 0 })
});
export type LockeMats = ReturnType<typeof mats>;

const V2 = (pts: number[][]) => pts.map(([r, y]) => new THREE.Vector2(r!, y!));

export function buildTorso(m: LockeMats): THREE.Group {
  const g = new THREE.Group();
  g.name = "slot_torso";
  // Lean, tapered jacket: narrow waist, squared shoulders.
  const prof = V2([[0, 0], [0.14, 0.0], [0.16, 0.08], [0.15, 0.22], [0.165, 0.36], [0.205, 0.5], [0.19, 0.57], [0.08, 0.6], [0, 0.6]]);
  const jacket = inked(new THREE.LatheGeometry(prof, 28), m.suit, 0.012);
  jacket.scale.set(1, 1, 0.72);
  g.add(jacket);
  // Shirt V, vest, tie, pocket square, crown pin, chain.
  const shirt = inked(new THREE.SphereGeometry(0.09, 16, 12), m.shirt, 0.006);
  shirt.scale.set(0.62, 1.5, 0.32); shirt.position.set(0, 0.47, 0.112);
  const vest = inked(new THREE.SphereGeometry(0.1, 16, 12), m.vest, 0.006);
  vest.scale.set(0.95, 1.25, 0.32); vest.position.set(0, 0.3, 0.108);
  const tie = inked(new THREE.ConeGeometry(0.022, 0.2, 4), m.black, 0.004);
  tie.rotation.x = Math.PI; tie.scale.set(1, 1, 0.35); tie.position.set(0, 0.47, 0.14);
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.017, 10, 8), m.black);
  knot.position.set(0, 0.565, 0.125);
  const square = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.035, 3), m.goldFlat);
  square.position.set(0.1, 0.45, 0.108); square.rotation.set(0.2, 0, Math.PI);
  g.add(shirt, vest, tie, knot, square);
  const crown = new THREE.Group();
  crown.name = "crown_pin";
  crown.add(new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.01, 0.008), m.gold));
  for (let i = -1; i <= 1; i++) { const pt = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.018, 4), m.gold); pt.position.set(i * 0.012, 0.013, 0); crown.add(pt); }
  crown.position.set(0, 0.49, 0.152);
  g.add(crown);
  for (const y of [0.34, 0.27, 0.2]) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), m.goldFlat); b.position.set(0, y, 0.142); g.add(b); }
  // Lapels: two dark flaps flanking the shirt.
  for (const sx of [-1, 1]) {
    const lap = inked(new THREE.BoxGeometry(0.05, 0.2, 0.01), m.suit, 0.004);
    lap.position.set(sx * 0.06, 0.45, 0.125); lap.rotation.set(-0.15, 0, sx * 0.28);
    g.add(lap);
  }
  return g;
}

export interface HeadParts { group: THREE.Group; brows: [THREE.Mesh, THREE.Mesh]; mouths: Record<Expression, THREE.Object3D>; cigar: THREE.Group; ember: THREE.MeshBasicMaterial }

export function buildHead(m: LockeMats): HeadParts {
  const g = new THREE.Group();
  g.name = "slot_head";
  const R = DIM.headR;
  const skull = inked(new THREE.SphereGeometry(R, 28, 20), m.skin, 0.01);
  skull.scale.set(0.9, 1.12, 0.95); skull.position.y = R;
  g.add(skull);
  // Jawline beard and moustache.
  const beard = inked(new THREE.SphereGeometry(R * 1.01, 24, 12, 0, Math.PI * 2, Math.PI * 0.58, Math.PI * 0.32), m.beard, 0.006);
  beard.scale.set(0.92, 1.14, 0.97); beard.position.y = R; beard.rotation.x = -0.18;
  g.add(beard);
  const chin = inked(new THREE.SphereGeometry(0.035, 12, 10), m.beard, 0.005);
  chin.scale.set(1.1, 1.1, 0.8); chin.position.set(0, R * 0.08, R * 0.82);
  g.add(chin);
  for (const sx of [-1, 1]) {
    const mo = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.034, 4, 8), m.beard);
    mo.rotation.z = Math.PI / 2 + sx * 0.32; mo.position.set(sx * 0.022, R * 0.66, R * 0.9);
    g.add(mo);
    const ear = inked(new THREE.SphereGeometry(0.03, 10, 8), m.skin, 0.006);
    ear.scale.set(0.5, 1, 0.8); ear.position.set(sx * R * 0.9, R * 1.05, -0.005);
    g.add(ear);
  }
  const nose = inked(new THREE.SphereGeometry(0.024, 12, 10), m.skin, 0.005);
  nose.scale.set(1, 0.85, 0.9); nose.position.set(0, R * 0.95, R * 0.96);
  g.add(nose);
  // Expressions: one mouth per state, plus brows the rig drives.
  const mouthAt = (o: THREE.Object3D) => { o.position.set(0, R * 0.5, R * 0.93); g.add(o); return o; };
  const cool = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 6, 16, Math.PI * 0.55), m.mouth);
  cool.rotation.set(0.1, 0, Math.PI + 0.75); cool.position.x = 0.008;
  const grinG = new THREE.Group();
  const grinBack = new THREE.Mesh(new THREE.CircleGeometry(0.036, 18, Math.PI, Math.PI), m.mouth);
  const grinTeeth = new THREE.Mesh(new THREE.PlaneGeometry(0.058, 0.012), m.teeth);
  grinTeeth.position.set(0, -0.006, 0.002);
  grinG.add(grinBack, grinTeeth);
  const oMouth = new THREE.Mesh(new THREE.CircleGeometry(0.019, 16), m.mouth);
  oMouth.scale.set(0.8, 1.25, 1); oMouth.position.y = -0.008;
  const serious = new THREE.Mesh(new THREE.CapsuleGeometry(0.005, 0.034, 4, 8), m.mouth);
  serious.rotation.z = Math.PI / 2;
  // The cigar, parked in the corner of the smirk (from the sheet). Ember brightens on a puff.
  const cigar = new THREE.Group();
  cigar.name = "cigar";
  const leaf = toonMaterial({ color: "#5b3a22", shade: "#2e1c10", gloss: 0.2 });
  const stick = inked(new THREE.CylinderGeometry(0.0085, 0.0095, 0.085, 10), leaf, 0.003);
  stick.rotation.z = Math.PI / 2; stick.position.x = 0.042;
  const bandRing = new THREE.Mesh(new THREE.CylinderGeometry(0.0098, 0.0098, 0.009, 10), m.goldFlat);
  bandRing.rotation.z = Math.PI / 2; bandRing.position.x = 0.016;
  const emberMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.7, 0.2), toneMapped: false });
  const ember = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), emberMat);
  ember.name = "ember"; ember.position.x = 0.086;
  cigar.add(stick, bandRing, ember);
  cigar.position.set(-0.03, R * 0.5, R * 0.93);
  cigar.rotation.set(0, -0.55, -0.18);
  g.add(cigar);
  const mouths: Record<Expression, THREE.Object3D> = { cool: mouthAt(cool), grin: mouthAt(grinG), surprised: mouthAt(oMouth), serious: mouthAt(serious) };
  for (const e of EXPRESSIONS) mouths[e].visible = e === "cool";
  const browGeo = new THREE.CapsuleGeometry(0.008, 0.04, 4, 8);
  browGeo.rotateZ(Math.PI / 2);
  const bl = new THREE.Mesh(browGeo, m.beard), br = new THREE.Mesh(browGeo, m.beard);
  bl.position.set(0.045, R * 1.58, R * 0.84); br.position.set(-0.045, R * 1.58, R * 0.84);
  g.add(bl, br);
  return { group: g, brows: [bl, br], mouths, cigar, ember: emberMat };
}

export function buildGlasses(m: LockeMats): THREE.Group {
  const g = new THREE.Group();
  g.name = "slot_glasses";
  const lensMat = new THREE.MeshStandardMaterial({ color: "#050407", metalness: 0.6, roughness: 0.15, envMapIntensity: 1.4 });
  for (const sx of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.008, 24), lensMat);
    lens.rotation.x = Math.PI / 2; lens.scale.set(1.1, 1, 0.95); lens.position.set(sx * 0.045, 0, 0);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.005, 6, 24), m.black);
    rim.scale.set(1.1, 0.95, 1); rim.position.set(sx * 0.045, 0, 0.004);
    const glint = new THREE.Mesh(new THREE.CircleGeometry(0.007, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 1.8, 1.8), toneMapped: false }));
    glint.position.set(sx * 0.045 - 0.014, 0.014, 0.006);
    const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.006, 0.006), m.goldFlat);
    hinge.position.set(sx * 0.086, 0.006, 0);
    const temple = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 0.1), m.black);
    temple.position.set(sx * 0.09, 0.006, -0.05);
    g.add(lens, rim, glint, hinge, temple);
  }
  const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.02, 6), m.black);
  bridge.rotation.z = Math.PI / 2; bridge.position.set(0, 0.008, 0.004);
  g.add(bridge);
  return g;
}

export function buildHat(m: LockeMats): THREE.Group {
  const g = new THREE.Group();
  g.name = "slot_hat";
  const brim = inked(new THREE.LatheGeometry(V2([[0, 0], [0.15, 0.0], [0.205, 0.016], [0.215, 0.03], [0.207, 0.026], [0.15, 0.01], [0, 0.01]]), 32), m.hat, 0.007);
  brim.scale.set(1, 1, 0.92);
  const crown = inked(new THREE.LatheGeometry(V2([[0, 0.135], [0.05, 0.13], [0.09, 0.11], [0.112, 0.06], [0.118, 0.0], [0, 0]]), 28), m.hat, 0.008);
  crown.scale.set(1, 1, 0.86);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.119, 0.12, 0.028, 28, 1, true), m.band);
  band.scale.set(1, 1, 0.86); band.position.y = 0.024;
  const pinch = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.01, 0.14), toonMaterial({ color: "#070609", gloss: 0 }));
  pinch.position.y = 0.13;
  g.add(brim, crown, band, pinch);
  g.rotation.z = 0.12;
  return g;
}

export function buildGlove(m: LockeMats, sx: number): THREE.Group {
  const g = new THREE.Group();
  g.name = sx > 0 ? "slot_glove_L" : "slot_glove_R";
  const palm = inked(new THREE.SphereGeometry(0.058, 18, 14), m.glove, 0.009);
  palm.scale.set(1, 0.7, 1.15); palm.position.z = 0.048;
  const thumb = inked(new THREE.SphereGeometry(0.024, 12, 10), m.glove, 0.006);
  thumb.scale.set(0.8, 0.8, 1.3); thumb.position.set(sx * 0.05, 0.01, 0.034);
  const cuff = inked(new THREE.CylinderGeometry(0.05, 0.038, 0.045, 18), m.glove, 0.007);
  cuff.rotation.x = Math.PI / 2; cuff.position.z = -0.004;
  g.add(palm, thumb, cuff);
  for (const off of [-0.017, 0, 0.017]) { const st = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.003, 0.038), m.black); st.position.set(off, 0.041, 0.044); g.add(st); }
  return g;
}

export function buildShoe(m: LockeMats, sx: number): THREE.Group {
  const g = new THREE.Group();
  g.name = sx > 0 ? "slot_shoe_L" : "slot_shoe_R";
  // Spectators: black toe cap and heel, white vamp.
  const vamp = inked(new THREE.SphereGeometry(0.06, 18, 12), m.white, 0.008);
  vamp.scale.set(0.78, 0.6, 1.5); vamp.position.set(0, 0.034, 0.04);
  const toe = inked(new THREE.SphereGeometry(0.045, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), m.black, 0.006);
  toe.scale.set(1, 0.72, 1.2); toe.position.set(0, 0.022, 0.105); toe.rotation.x = Math.PI / 2.4;
  const heel = inked(new THREE.SphereGeometry(0.045, 14, 10), m.black, 0.006);
  heel.scale.set(0.9, 0.8, 0.9); heel.position.set(0, 0.035, -0.035);
  const sole = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.012, 0.22), m.black);
  sole.position.set(0, 0.006, 0.035);
  g.add(vamp, toe, heel, sole);
  return g;
}

/** Load any GLB overrides listed in /models/locke/manifest.json into their slots (keeps the slot as the attach point). */
export async function applyModelOverrides(slots: Partial<Record<Slot, THREE.Group>>, base = "/models/locke/"): Promise<Slot[]> {
  let manifest: { parts?: Partial<Record<Slot, string>> };
  try { const res = await fetch(base + "manifest.json"); if (!res.ok) return []; manifest = await res.json(); } catch { return []; }
  // bust, hat and torso are fitted by the rig itself (scale, pivots, toon shading).
  const entries = (Object.entries(manifest.parts ?? {}) as Array<[Slot, string]>).filter(([k]) => k !== "bust" && k !== "hat" && k !== "torso");
  if (!entries.length) return [];
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  const done: Slot[] = [];
  for (const [slot, file] of entries) {
    const target = slots[slot];
    if (!target || !file) continue;
    try {
      const gltf = await loader.loadAsync(base + file);
      target.clear();
      target.add(gltf.scene);
      done.push(slot);
    } catch { /* keep the procedural part */ }
  }
  return done;
}
