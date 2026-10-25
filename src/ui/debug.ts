import type { Stage } from "../render/stage";

/** ?debug overlay: fps, frame-time avg/p95/max, draw calls and fenced per-pass cost. P toggles pass profiling. */
export class DebugOverlay {
  private el = document.createElement("pre");
  private times: number[] = [];
  private last = 0;
  private shown = 0;
  /** Rolling samples exposed for automated playtests. */
  readonly samples: number[] = [];

  constructor() {
    this.el.className = "debug-overlay";
    document.body.appendChild(this.el);
    addEventListener("keydown", (e) => { if (e.code === "KeyP" && e.shiftKey) this.toggle(); });
    (window as unknown as { perf: DebugOverlay }).perf = this;
  }

  private stage: Stage | null = null;
  toggle() { if (this.stage) this.stage.profile = this.stage.profile ? null : {}; }

  frame(now: number, stage: Stage, mode: string) {
    this.stage = stage;
    if (this.last) { const dt = now - this.last; this.times.push(dt); this.samples.push(dt); if (this.samples.length > 20000) this.samples.shift(); }
    this.last = now;
    if (this.times.length > 120) this.times.shift();
    if (now - this.shown < 250) return;
    this.shown = now;
    const sorted = [...this.times].sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const info = stage.renderer.info.render;
    const lines = [
      `${(1000 / avg).toFixed(0)} fps  ${avg.toFixed(1)} ms  p95 ${p95.toFixed(1)}  max ${(sorted.at(-1) ?? 0).toFixed(1)}`,
      `tier ${stage.quality}  dpr ${stage.renderer.getPixelRatio()}  ${mode}`,
      `draws ${info.calls}  tris ${(info.triangles / 1000).toFixed(1)}k`
    ];
    if (stage.profile) for (const [k, v] of Object.entries(stage.profile)) lines.push(`  ${k.padEnd(9)} ${v.toFixed(2)} ms`);
    else lines.push("Shift+P: profile passes");
    this.el.textContent = lines.join("\n");
  }
}
