import * as THREE from "three";

/**
 * A rubber-hose limb: a tube swept along a smooth curve, rebuilt in place every frame.
 * Parallel-transport frames keep it from twisting; it never kinks because the
 * curve is always a cubic bezier or a centripetal Catmull-Rom through smoothed points.
 */
export class Hose {
  readonly geometry: THREE.BufferGeometry;
  private pos: Float32Array;
  private nrm: Float32Array;
  private pts: THREE.Vector3[];
  private tan: THREE.Vector3[];
  private readonly tmp = new THREE.Vector3();
  private readonly tmpN = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly prevN = new THREE.Vector3(1, 0, 0);

  constructor(readonly segments = 24, readonly radial = 10) {
    const rings = segments + 1;
    const vcount = rings * (radial + 1) + 2 * (radial + 2);
    this.pos = new Float32Array(vcount * 3);
    this.nrm = new Float32Array(vcount * 3);
    const uv = new Float32Array(vcount * 2);
    const idx: number[] = [];
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j <= radial; j++) {
        const k = i * (radial + 1) + j;
        uv[k * 2] = j / radial;
        uv[k * 2 + 1] = i / segments;
        if (i < segments && j < radial) {
          const a = k, b = k + radial + 1, c = b + 1, d = a + 1;
          idx.push(a, d, b, b, d, c);
        }
      }
    }
    // End caps (fans).
    const capBase = rings * (radial + 1);
    for (let c = 0; c < 2; c++) {
      const center = capBase + c * (radial + 2);
      for (let j = 0; j < radial; j++) {
        const a = center + 1 + j, b = center + 2 + j;
        if (c === 0) idx.push(center, a, b); else idx.push(center, b, a);
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("normal", new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    this.geometry.setIndex(idx);
    this.pts = Array.from({ length: rings }, () => new THREE.Vector3());
    this.tan = Array.from({ length: rings }, () => new THREE.Vector3());
  }

  /** Cubic bezier p0→p3 with control points p1, p2. */
  bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, r0: number, r1: number) {
    const n = this.segments;
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      this.pts[i]!.set(
        a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        a * p0.y + b * p1.y + c * p2.y + d * p3.y,
        a * p0.z + b * p1.z + c * p2.z + d * p3.z
      );
    }
    this.build(r0, r1);
  }

  /** Sweep through an arbitrary polyline, resampled uniformly by arc length (Catmull-Rom). */
  through(points: THREE.Vector3[], r0: number, r1: number) {
    if (points.length < 2) { const p = points[0] ?? this.tmp.set(0, 0, 0); this.bezier(p, p, p, p.clone().add(new THREE.Vector3(0, 0, 0.001)), r0, r1); return; }
    const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
    const n = this.segments;
    const spaced = curve.getSpacedPoints(n);
    for (let i = 0; i <= n; i++) this.pts[i]!.copy(spaced[i]!);
    this.build(r0, r1);
  }

  private build(r0: number, r1: number) {
    const n = this.segments, R = this.radial;
    for (let i = 0; i <= n; i++) {
      const a = this.pts[Math.max(0, i - 1)]!, b = this.pts[Math.min(n, i + 1)]!;
      this.tan[i]!.subVectors(b, a);
      if (this.tan[i]!.lengthSq() < 1e-12) this.tan[i]!.set(0, 0, 1);
      this.tan[i]!.normalize();
    }
    // Initial normal: any vector perpendicular to the first tangent.
    const t0 = this.tan[0]!;
    const N = this.tmpN.copy(Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
    N.sub(this.tmp.copy(t0).multiplyScalar(N.dot(t0))).normalize();
    this.prevN.copy(N);
    const B = this.tmpB;
    for (let i = 0; i <= n; i++) {
      const T = this.tan[i]!;
      if (i > 0) {
        // Parallel transport the previous normal.
        N.copy(this.prevN).sub(this.tmp.copy(T).multiplyScalar(this.prevN.dot(T))).normalize();
        this.prevN.copy(N);
      }
      B.crossVectors(T, N);
      const t = i / n;
      // Rubber-hose taper: slightly thicker in the middle, like a sausage.
      const r = (r0 + (r1 - r0) * t) * (1 + 0.12 * Math.sin(Math.PI * t));
      const P = this.pts[i]!;
      for (let j = 0; j <= R; j++) {
        const ang = (j / R) * Math.PI * 2;
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const nx = N.x * cs + B.x * sn, ny = N.y * cs + B.y * sn, nz = N.z * cs + B.z * sn;
        const k = (i * (R + 1) + j) * 3;
        this.pos[k] = P.x + nx * r; this.pos[k + 1] = P.y + ny * r; this.pos[k + 2] = P.z + nz * r;
        this.nrm[k] = nx; this.nrm[k + 1] = ny; this.nrm[k + 2] = nz;
      }
    }
    // Caps.
    const capBase = (n + 1) * (R + 1);
    for (let c = 0; c < 2; c++) {
      const ring = c === 0 ? 0 : n;
      const P = this.pts[ring]!, T = this.tan[ring]!;
      const sgn = c === 0 ? -1 : 1;
      const center = capBase + c * (R + 2);
      let k = center * 3;
      this.pos[k] = P.x; this.pos[k + 1] = P.y; this.pos[k + 2] = P.z;
      this.nrm[k] = T.x * sgn; this.nrm[k + 1] = T.y * sgn; this.nrm[k + 2] = T.z * sgn;
      for (let j = 0; j <= R; j++) {
        const src = (ring * (R + 1) + j) * 3;
        k = (center + 1 + j) * 3;
        this.pos[k] = this.pos[src]!; this.pos[k + 1] = this.pos[src + 1]!; this.pos[k + 2] = this.pos[src + 2]!;
        this.nrm[k] = T.x * sgn; this.nrm[k + 1] = T.y * sgn; this.nrm[k + 2] = T.z * sgn;
      }
    }
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  /** Point and tangent at the end of the hose, for attaching gloves and shoes. */
  end(out: THREE.Vector3): THREE.Vector3 { return out.copy(this.pts[this.segments]!); }
  endTangent(out: THREE.Vector3): THREE.Vector3 { return out.copy(this.tan[this.segments]!); }
}
