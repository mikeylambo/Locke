/** Floor-plane math. x = east, z = south (toward the default camera). Angles in degrees, 0 = +x, 90 = +z. */
export interface V2 { x: number; z: number }

export const v2 = (x: number, z: number): V2 => ({ x, z });
export const DEG = Math.PI / 180;
export const dirFromDeg = (deg: number): V2 => ({ x: Math.cos(deg * DEG), z: Math.sin(deg * DEG) });
export const degFromDir = (d: V2): number => Math.atan2(d.z, d.x) / DEG;
export const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, z: a.z + b.z });
export const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, z: a.z - b.z });
export const scale = (a: V2, s: number): V2 => ({ x: a.x * s, z: a.z * s });
export const dot = (a: V2, b: V2): number => a.x * b.x + a.z * b.z;
export const cross = (a: V2, b: V2): number => a.x * b.z - a.z * b.x;
export const len = (a: V2): number => Math.hypot(a.x, a.z);
export const dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const norm = (a: V2): V2 => { const l = len(a) || 1; return { x: a.x / l, z: a.z / l }; };
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const wrapDeg = (d: number): number => ((d % 360) + 540) % 360 - 180;

/** Ray (o + t·d, t ≥ 0) vs segment ab. Returns t or -1. */
export function raySegment(o: V2, d: V2, a: V2, b: V2): number {
  const e = sub(b, a);
  const den = cross(d, e);
  if (Math.abs(den) < 1e-9) return -1;
  const ao = sub(a, o);
  const t = cross(ao, e) / den;
  const u = cross(ao, d) / den;
  return t > 1e-6 && u >= 0 && u <= 1 ? t : -1;
}

/** Ray vs circle. Returns nearest positive t or -1. */
export function rayCircle(o: V2, d: V2, c: V2, r: number): number {
  const oc = sub(o, c);
  const b = dot(oc, d);
  const cc = dot(oc, oc) - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 > 1e-6) return t0;
  return -1;
}

/** Shortest distance between segments p0p1 and q0q1. */
export function segSegDist(p0: V2, p1: V2, q0: V2, q1: V2): number {
  const d1 = sub(p1, p0), d2 = sub(q1, q0), r = sub(p0, q0);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return len(r);
  if (a <= 1e-12) { t = clamp(f / e, 0, 1); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { s = clamp(-c / a, 0, 1); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den !== 0 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const cp = add(p0, scale(d1, s)), cq = add(q0, scale(d2, t));
  return dist(cp, cq);
}

export function pointSegDist(p: V2, a: V2, b: V2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? clamp(dot(sub(p, a), ab) / l2, 0, 1) : 0;
  return dist(p, add(a, scale(ab, t)));
}

export function closestOnSeg(p: V2, a: V2, b: V2): V2 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? clamp(dot(sub(p, a), ab) / l2, 0, 1) : 0;
  return add(a, scale(ab, t));
}
