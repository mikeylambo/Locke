/** Damped springs for secondary motion. Frequency in Hz, damping ratio ζ (1 = critical). */
export class Spring {
  v = 0;
  constructor(public x = 0, public freq = 4, public zeta = 0.4) {}
  step(target: number, dt: number): number {
    const w = 2 * Math.PI * this.freq;
    // Semi-implicit Euler, sub-stepped for stability at low frame rates.
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = w * w * (target - this.x) - 2 * this.zeta * w * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  kick(impulse: number) { this.v += impulse; }
}

export const ease = {
  outBack: (t: number, s = 1.7) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  inOut: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  out: (t: number) => 1 - (1 - t) * (1 - t)
};
