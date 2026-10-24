import type { EmitterDef, RoomDef } from "../sim/roomTypes";
import { Key, mtof } from "./theory";
import { STEMS } from "./stems";

export interface AudioFrame {
  beat: number;
  running: boolean;
  phase: "case" | "in" | "out" | "escaped" | "lockdown";
  emitterOn: Record<string, boolean>;
  /** Per emitter: distance from Locke to its nearest live segment and stereo pan (-1..1). */
  beamNear: Record<string, { d: number; pan: number }>;
  sweepAngles: Record<string, number>;
  unsolved: boolean;
  nearPrize: number;
  stretch: { active: boolean; length: number; moving: boolean };
}

interface BeamVoice { def: EmitterDef; gain: GainNode; pan: StereoPannerNode; oscs: OscillatorNode[]; base: number; level: number }

const SWING = 2 / 3;
const PROGRESSION = [1, 4, 1, 4, 2, 5, 1, 5]; // i7 · IV7 · i7 · IV7 · ii · V · i7 · V (dorian swing)

/**
 * Semantic audio. Gameplay says what happened; this decides how it sounds. Every voice is synthesized
 * from the room's key data unless a stem is supplied for the venue.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private beamBus!: GainNode;
  private uiBus!: GainNode;
  private reverb!: ConvolverNode;
  private revSend!: GainNode;
  private layers!: { bed: GainNode; near: GainNode; escape: GainNode };
  private noise!: AudioBuffer;
  private voices = new Map<string, BeamVoice>();
  private tension: { osc: OscillatorNode; gain: GainNode } | null = null;
  private creak: { osc: OscillatorNode; filt: BiquadFilterNode; gain: GainNode } | null = null;
  private key = new Key("D", "dorian");
  private tempo = 112;
  private room: RoomDef | null = null;
  private anchor = 0;
  private anchored = false;
  private scheduledUntil = 0;
  private lastBeat = 0;
  private volumes = { master: 0.9, music: 0.75, sfx: 0.9 };
  private stems: Record<string, AudioBuffer | null> = {};
  private stemSources: Partial<Record<"bed" | "near" | "escape", AudioBufferSourceNode>> = {};
  private duck = 1;
  private resolvePending = false;

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) { if (this.ctx.state !== "running") void this.ctx.resume(); return; }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);
    this.musicBus = ctx.createGain(); this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain(); this.sfxBus.connect(this.master);
    this.beamBus = ctx.createGain(); this.beamBus.connect(this.sfxBus);
    this.uiBus = ctx.createGain(); this.uiBus.connect(this.sfxBus);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.6, 2.4);
    this.revSend = ctx.createGain(); this.revSend.gain.value = 0.55;
    this.revSend.connect(this.reverb).connect(this.master);
    this.layers = { bed: ctx.createGain(), near: ctx.createGain(), escape: ctx.createGain() };
    for (const l of Object.values(this.layers)) { l.gain.value = 0; l.connect(this.musicBus); }
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.applyVolumes();
    if (this.room) this.setRoom(this.room);
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay) * (i < 200 ? i / 200 : 1);
    }
    return buf;
  }

  setVolumes(v: { master: number; music: number; sfx: number }) { this.volumes = v; this.applyVolumes(); }
  private applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master * this.duck, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.volumes.music * 0.8, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
  }

  setPaused(p: boolean) { this.duck = p ? 0.35 : 1; this.applyVolumes(); if (p) this.anchored = false; }

  setRoom(room: RoomDef) {
    this.room = room;
    this.key = new Key(room.key.root, room.key.mode);
    this.tempo = room.tempo;
    if (!this.ctx) return;
    for (const v of this.voices.values()) { v.oscs.forEach((o) => o.stop()); v.gain.disconnect(); }
    this.voices.clear();
    if (this.tension) { this.tension.osc.stop(); this.tension = null; }
    this.anchored = false;
    this.scheduledUntil = 0;
    this.resolvePending = false;
    this.stopStems();
    void this.loadStems(room.venue);
  }

  private async loadStems(venue: string) {
    const cfg = STEMS[venue];
    if (!cfg || !this.ctx) return;
    for (const k of ["bed", "near", "escape"] as const) {
      const url = cfg[k];
      if (!url || this.stems[k] !== undefined) continue;
      try { const res = await fetch(url); this.stems[k] = await this.ctx.decodeAudioData(await res.arrayBuffer()); }
      catch { this.stems[k] = null; }
    }
  }

  private voice(e: EmitterDef): BeamVoice {
    let v = this.voices.get(e.id);
    if (v) return v;
    const ctx = this.ctx!;
    const oct = e.tint === "prism" ? 6 : 5;
    const f = mtof(this.key.degree(e.note ?? 1, oct - 1));
    const gain = ctx.createGain(); gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    const trem = ctx.createGain(); trem.gain.value = 0.75;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2 + Math.random() * 0.6;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.22;
    lfo.connect(lfoAmt).connect(trem.gain);
    const oscs: OscillatorNode[] = [lfo];
    // Vibraphone/glass partials: fundamental, 4×, soft 10×.
    for (const [mult, amp, type] of [[1, 1, "sine"], [4, 0.09, "sine"], [2, 0.18, "triangle"], [10, 0.02, "sine"]] as const) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * mult;
      o.detune.value = (Math.random() - 0.5) * 6;
      const g = ctx.createGain(); g.gain.value = amp;
      o.connect(g).connect(trem);
      oscs.push(o);
    }
    trem.connect(gain).connect(pan);
    pan.connect(this.beamBus);
    const send = ctx.createGain(); send.gain.value = 0.6;
    pan.connect(send).connect(this.revSend);
    for (const o of oscs) o.start();
    v = { def: e, gain, pan, oscs, base: f, level: 0 };
    this.voices.set(e.id, v);
    return v;
  }

  frame(dt: number, a: AudioFrame) {
    const ctx = this.ctx;
    if (!ctx || !this.room) return;
    const t = ctx.currentTime;
    const bps = this.tempo / 60;
    // Beam chord: each live emitter sustains its note; pulses gate staccato.
    const sounding = a.phase !== "escaped";
    for (const e of this.room.emitters) {
      const on = (a.emitterOn[e.id] ?? false) && sounding;
      if (!on && !this.voices.has(e.id)) continue;
      const v = this.voice(e);
      const near = a.beamNear[e.id];
      const prox = near ? Math.max(0, 1 - near.d / 5) : 0;
      const level = on ? 0.018 + prox * prox * 0.07 : 0;
      const tc = e.type === "pulse" ? 0.008 : 0.12;
      v.gain.gain.setTargetAtTime(level, t, on ? tc * 0.5 : tc);
      if (near) v.pan.pan.setTargetAtTime(Math.max(-0.9, Math.min(0.9, near.pan)), t, 0.1);
      if (e.type === "sweeper") {
        const ang = (a.sweepAngles[e.id] ?? 0) * Math.PI / 180;
        for (const o of v.oscs.slice(1)) o.detune.setTargetAtTime(Math.sin(ang) * 22, t, 0.05);
      }
    }
    // Tension: a suspended fourth hangs over the chord until the room is solved.
    const wantTension = a.unsolved && (a.phase === "in" || a.phase === "case") && a.running;
    if (wantTension && !this.tension) {
      const osc = ctx.createOscillator(); osc.type = "sine";
      osc.frequency.value = mtof(this.key.degree(4, 4));
      const gain = ctx.createGain(); gain.gain.value = 0;
      const send = ctx.createGain(); send.gain.value = 0.8;
      osc.connect(gain); gain.connect(this.beamBus); gain.connect(send).connect(this.revSend);
      osc.start();
      this.tension = { osc, gain };
    }
    if (this.tension) this.tension.gain.gain.setTargetAtTime(wantTension ? 0.022 : 0, t, wantTension ? 0.6 : 0.3);

    // Stretch creak follows the reach.
    if (this.creak) {
      const f = 260 + a.stretch.length * 160;
      this.creak.osc.frequency.setTargetAtTime(f, t, 0.03);
      this.creak.filt.frequency.setTargetAtTime(f * 3.2, t, 0.03);
      this.creak.gain.gain.setTargetAtTime(a.stretch.moving ? 0.05 : 0.008, t, 0.03);
    }

    // Music layers.
    const L = this.layers;
    const bed = a.phase === "case" ? 0.45 : a.phase === "lockdown" ? 0 : 0.85;
    const near = a.phase === "out" || a.phase === "escaped" ? 1 : Math.min(1, a.nearPrize);
    const esc = a.phase === "out" ? 1 : a.phase === "escaped" ? 0.7 : 0;
    L.bed.gain.setTargetAtTime(a.running ? bed : 0, t, 0.4);
    L.near.gain.setTargetAtTime(a.running ? near * 0.85 : 0, t, 0.8);
    L.escape.gain.setTargetAtTime(a.running ? esc : 0, t, 0.3);

    if (!a.running) { this.anchored = false; this.stopStems(); return; }
    // Map the deterministic sim beat onto audio time, smoothing frame jitter.
    const want = t - a.beat / bps;
    if (!this.anchored || Math.abs(want - this.anchor) > 0.08 || a.beat < this.lastBeat) {
      this.anchor = want; this.anchored = true; this.scheduledUntil = a.beat;
    } else this.anchor += (want - this.anchor) * 0.04;
    this.lastBeat = a.beat;
    const horizon = a.beat + 0.5;
    const lat = 0.06;
    let b = Math.max(this.scheduledUntil, a.beat);
    // Schedule on the swung-eighth grid.
    const grid = (x: number) => { const k = Math.floor(x); return x - k < 1e-6 ? x : x - k <= SWING ? k + SWING : k + 1; };
    b = grid(b);
    while (b < horizon) {
      const when = this.anchor + b / bps + lat;
      if (when >= t - 0.01) this.musicEvent(b, Math.max(when, t), a);
      b = grid(b + 1e-4);
    }
    this.scheduledUntil = b;
    // Authored stems loop from the next bar line, locked to the same clock.
    for (const k of ["bed", "near", "escape"] as const) {
      const buf = this.stems[k];
      if (!buf || this.stemSources[k]) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      src.connect(this.layers[k]);
      const nextBar = Math.ceil(a.beat / 4) * 4;
      src.start(Math.max(t, this.anchor + nextBar / bps + lat));
      this.stemSources[k] = src;
    }
    if (this.resolvePending) {
      // Resolve on the next downbeat.
      const nextBar = Math.ceil(a.beat / 4) * 4;
      if (nextBar - a.beat < 0.5) { this.resolvePending = false; this.chime(this.anchor + nextBar / bps + lat, true); }
    }
    void dt;
  }

  private musicEvent(b: number, when: number, a: AudioFrame) {
    const k = Math.round(b * 3) / 3;
    const beatI = Math.floor(k + 1e-6);
    const off = k - beatI > 0.1; // swung "and"
    const inBar = ((beatI % 4) + 4) % 4;
    const bar = Math.floor(beatI / 4);
    const deg = PROGRESSION[((bar % PROGRESSION.length) + PROGRESSION.length) % PROGRESSION.length]!;
    const nextDeg = PROGRESSION[(((bar + 1) % PROGRESSION.length) + PROGRESSION.length) % PROGRESSION.length]!;
    const spb = 60 / this.tempo;
    if (!this.stems.bed) {
      // Ride: ding, ding-da, ding, ding-da.
      if (!off || inBar === 1 || inBar === 3) this.ride(when, off ? 0.5 : inBar % 2 ? 1 : 0.8, this.layers.bed);
      if (!off) {
        // Walking bass.
        const chord = this.key.chord(deg, 2);
        let n: number;
        if (inBar === 0) n = chord[0]!;
        else if (inBar === 1) n = chord[1]! + (bar % 2 ? 0 : 0);
        else if (inBar === 2) n = chord[2]!;
        else { const target = this.key.chord(nextDeg, 2)[0]!; n = target + (bar % 2 ? 1 : -1); }
        this.bass(when, mtof(n), spb * 0.95, this.layers.bed);
      }
      if (!off && (inBar === 1 || inBar === 3)) this.hat(when, this.layers.bed);
    }
    if (!this.stems.near) {
      if (!off) this.brush(when, inBar === 1 || inBar === 3 ? 1 : 0.55, spb, this.layers.near);
      const comp = (bar % 2 === 0 && inBar === 1 && off) || (bar % 2 === 1 && inBar === 3 && !off) || (inBar === 0 && !off && bar % 4 === 0);
      if (comp) this.rhodes(when, this.key.chord(deg, 4).map(mtof), spb * (off ? 0.5 : 0.9), this.layers.near);
    }
    if (!this.stems.escape && a.phase !== "case") {
      if (!off && (inBar === 0 || inBar === 2)) this.kick(when, this.layers.escape);
      // Muted-trumpet riff, two bars, call and response.
      const riff: Array<[number, boolean, number, number]> = [[0, false, 5, 0.5], [0, true, 6, 0.33], [1, false, 7, 0.9], [2, true, 5, 0.33], [3, false, 4, 0.5], [3, true, 3, 0.4]];
      if (bar % 2 === 0) for (const [bi, o, dg, len] of riff) if (bi === inBar && o === off) this.trumpet(when, mtof(this.key.degree(dg, 4)), spb * len * 1.6, this.layers.escape);
      if (bar % 2 === 1 && inBar === 0 && !off) this.brass(when, this.key.chord(deg, 3).map(mtof), 0.18, 0.09, this.layers.escape);
    }
  }

  // ——— Instruments ———
  private env(g: GainNode, when: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  }

  private noiseSrc(when: number, dur: number): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.start(when, Math.random() * 1.5, dur + 0.05);
    return s;
  }

  private ride(when: number, vel: number, out: AudioNode) {
    const ctx = this.ctx!;
    const s = this.noiseSrc(when, 0.5);
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 6500;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 9500; bp.Q.value = 0.9;
    const g = ctx.createGain();
    this.env(g, when, 0.05 * vel, 0.002, 0.42);
    s.connect(hp).connect(bp).connect(g).connect(out);
    // Bell partial.
    const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = 3170;
    const og = ctx.createGain(); this.env(og, when, 0.006 * vel, 0.001, 0.18);
    const ohp = ctx.createBiquadFilter(); ohp.type = "highpass"; ohp.frequency.value = 5000;
    o.connect(ohp).connect(og).connect(out);
    o.start(when); o.stop(when + 0.3);
  }

  private hat(when: number, out: AudioNode) {
    const ctx = this.ctx!;
    const s = this.noiseSrc(when, 0.06);
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 8000;
    const g = ctx.createGain(); this.env(g, when, 0.03, 0.001, 0.05);
    s.connect(hp).connect(g).connect(out);
  }

  private brush(when: number, vel: number, spb: number, out: AudioNode) {
    const ctx = this.ctx!;
    const s = this.noiseSrc(when, spb);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2400; bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.03 * vel, when + spb * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, when + spb * 0.9);
    s.connect(bp).connect(g).connect(out);
    if (vel > 0.9) {
      const s2 = this.noiseSrc(when, 0.12);
      const bp2 = ctx.createBiquadFilter(); bp2.type = "bandpass"; bp2.frequency.value = 1800; bp2.Q.value = 1.2;
      const g2 = ctx.createGain(); this.env(g2, when, 0.06, 0.002, 0.12);
      s2.connect(bp2).connect(g2).connect(out);
    }
  }

  private bass(when: number, f: number, dur: number, out: AudioNode) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = f;
    const sub = ctx.createOscillator(); sub.type = "sine"; sub.frequency.value = f;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 2;
    lp.frequency.setValueAtTime(1400, when); lp.frequency.exponentialRampToValueAtTime(260, when + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.32, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.12, when + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(lp); sub.connect(lp); lp.connect(g).connect(out);
    o.start(when); sub.start(when); o.stop(when + dur + 0.05); sub.stop(when + dur + 0.05);
  }

  private rhodes(when: number, fs: number[], dur: number, out: AudioNode) {
    const ctx = this.ctx!;
    for (const f of fs) {
      const car = ctx.createOscillator(); car.frequency.value = f;
      const mod = ctx.createOscillator(); mod.frequency.value = f * 14;
      const mg = ctx.createGain(); mg.gain.setValueAtTime(f * 1.2, when); mg.gain.exponentialRampToValueAtTime(1, when + 0.2);
      mod.connect(mg).connect(car.frequency);
      const g = ctx.createGain(); this.env(g, when, 0.03, 0.006, dur + 0.3);
      car.connect(g); g.connect(out);
      const sg = ctx.createGain(); sg.gain.value = 0.4; g.connect(sg).connect(this.revSend);
      car.start(when); mod.start(when); car.stop(when + dur + 0.5); mod.stop(when + dur + 0.5);
    }
  }

  private kick(when: number, out: AudioNode) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(110, when); o.frequency.exponentialRampToValueAtTime(42, when + 0.12);
    const g = ctx.createGain(); this.env(g, when, 0.22, 0.003, 0.22);
    o.connect(g).connect(out); o.start(when); o.stop(when + 0.3);
  }

  private trumpet(when: number, f: number, dur: number, out: AudioNode) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.setValueAtTime(f * 0.97, when); o.frequency.exponentialRampToValueAtTime(f, when + 0.05);
    const vib = ctx.createOscillator(); vib.frequency.value = 5.5;
    const vg = ctx.createGain(); vg.gain.setValueAtTime(0, when); vg.gain.linearRampToValueAtTime(f * 0.012, when + dur);
    vib.connect(vg).connect(o.frequency);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1300; bp.Q.value = 2.2;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(900, when); lp.frequency.linearRampToValueAtTime(2600, when + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(0.09, when + 0.03); g.gain.setValueAtTime(0.08, when + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(bp).connect(lp).connect(g).connect(out);
    const sg = ctx.createGain(); sg.gain.value = 0.35; g.connect(sg).connect(this.revSend);
    o.start(when); vib.start(when); o.stop(when + dur + 0.05); vib.stop(when + dur + 0.05);
  }

  private brass(when: number, fs: number[], dur: number, level: number, out: AudioNode, bright = 3200) {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 3;
    lp.frequency.setValueAtTime(bright * 1.4, when); lp.frequency.exponentialRampToValueAtTime(600, when + dur + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(level, when + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.25);
    lp.connect(g).connect(out);
    const sg = ctx.createGain(); sg.gain.value = 0.5; g.connect(sg).connect(this.revSend);
    for (const f of fs) for (const det of [-9, 7]) {
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.detune.value = det;
      o.connect(lp); o.start(when); o.stop(when + dur + 0.3);
    }
  }

  private bell(when: number, f: number, level: number, decay: number, out: AudioNode = this.sfxBus) {
    const ctx = this.ctx!;
    const g = ctx.createGain(); this.env(g, when, level, 0.003, decay);
    for (const [m, a] of [[1, 1], [2.76, 0.35], [5.4, 0.15]] as const) {
      const o = ctx.createOscillator(); o.frequency.value = f * m;
      const og = ctx.createGain(); og.gain.value = a;
      o.connect(og).connect(g); o.start(when); o.stop(when + decay + 0.1);
    }
    g.connect(out);
    const sg = ctx.createGain(); sg.gain.value = 0.7; g.connect(sg).connect(this.revSend);
  }

  private chime(when: number, resolve: boolean) {
    const tones = resolve ? [1, 3, 5, 8] : [5, 8];
    tones.forEach((d, i) => this.bell(when + i * 0.07, mtof(this.key.degree(d, 5)), 0.08, 1.8, this.beamBus));
  }

  private blip(f: number, dur: number, level: number, type: OscillatorType = "sine", out: AudioNode = this.sfxBus, when = this.ctx!.currentTime, toF?: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, when);
    if (toF) o.frequency.exponentialRampToValueAtTime(toF, when + dur);
    const g = ctx.createGain(); this.env(g, when, level, 0.002, dur);
    o.connect(g).connect(out); o.start(when); o.stop(when + dur + 0.05);
  }

  private burst(f: number, q: number, dur: number, level: number, out: AudioNode = this.sfxBus, when = this.ctx!.currentTime, pan = 0) {
    const ctx = this.ctx!;
    const s = this.noiseSrc(when, dur);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = q;
    const g = ctx.createGain(); this.env(g, when, level, 0.001, dur);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    s.connect(bp).connect(g).connect(p).connect(out);
  }

  // ——— Semantic events ———
  play(event: string, opts: { pan?: number; value?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const pan = opts.pan ?? 0;
    switch (event) {
      case "step": this.burst(4200, 2.5, 0.03, 0.05, this.sfxBus, t, pan); this.blip(2400, 0.012, 0.012, "sine", this.sfxBus, t); break;
      case "pose": this.burst(1200, 1, 0.12, 0.05); this.blip(380, 0.12, 0.05, "sine", this.sfxBus, t, 220); break;
      case "stretch.start": {
        if (this.creak) break;
        const osc = ctx.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = 280;
        const vib = ctx.createOscillator(); vib.frequency.value = 23;
        const vg = ctx.createGain(); vg.gain.value = 14;
        vib.connect(vg).connect(osc.frequency); vib.start();
        const filt = ctx.createBiquadFilter(); filt.type = "bandpass"; filt.Q.value = 7; filt.frequency.value = 900;
        const gain = ctx.createGain(); gain.gain.value = 0;
        osc.connect(filt).connect(gain).connect(this.sfxBus);
        osc.start();
        this.creak = { osc, filt, gain };
        (osc as OscillatorNode & { _vib?: OscillatorNode })._vib = vib;
        this.blip(520, 0.09, 0.06, "sine", this.sfxBus, t, 900);
        break;
      }
      case "stretch.release": {
        if (this.creak) {
          const c = this.creak; this.creak = null;
          c.gain.gain.setTargetAtTime(0, t, 0.02);
          c.osc.frequency.setTargetAtTime(160, t, 0.05);
          c.osc.stop(t + 0.3);
          (c.osc as OscillatorNode & { _vib?: OscillatorNode })._vib?.stop(t + 0.3);
        }
        this.burst(700, 1.2, 0.12, 0.05);
        break;
      }
      case "stretch.snap": {
        // Boing: pitch swoop with decaying spring wobble.
        const o = ctx.createOscillator(); o.type = "sine";
        o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(520, t + 0.05); o.frequency.exponentialRampToValueAtTime(200, t + 0.45);
        const wob = ctx.createOscillator(); wob.frequency.value = 17;
        const wg = ctx.createGain(); wg.gain.setValueAtTime(90, t); wg.gain.exponentialRampToValueAtTime(1, t + 0.45);
        wob.connect(wg).connect(o.frequency);
        const g = ctx.createGain(); this.env(g, t, 0.16, 0.004, 0.45);
        o.connect(g).connect(this.sfxBus);
        o.start(t); wob.start(t); o.stop(t + 0.5); wob.stop(t + 0.5);
        break;
      }
      case "stretch.bump": this.blip(160, 0.06, 0.05, "triangle"); break;
      case "optic.place":
        this.burst(6000, 3, 0.02, 0.12, this.sfxBus, t, pan); this.burst(4500, 3, 0.02, 0.1, this.sfxBus, t + 0.06, pan);
        this.blip(900, 0.25, 0.05, "sine", this.sfxBus, t + 0.02, 1800);
        this.bell(t + 0.08, mtof(this.key.degree(5, 5)), 0.04, 0.6);
        break;
      case "optic.pickup": this.blip(1600, 0.18, 0.05, "sine", this.sfxBus, t, 700); this.burst(5000, 3, 0.02, 0.1); break;
      case "optic.rotate": this.burst(7000, 4, 0.012, 0.1, this.sfxBus, t, pan); this.blip(3000, 0.015, 0.02); break;
      case "optic.select": this.blip(1200, 0.05, 0.04); break;
      case "deny": this.blip(140, 0.14, 0.08, "triangle"); break;
      case "sensor.fed": this.chime(t, false); this.resolvePending = true; break;
      case "sensor.lost": this.blip(600, 0.3, 0.05, "sine", this.sfxBus, t, 300); break;
      case "contact": {
        // Brass stab: a crushed cluster, filter snapping shut.
        const r = this.key.degree(1, 3);
        this.brass(t, [r, r + 1, r + 7, r + 13].map(mtof), 0.22, 0.12, this.sfxBus, 4200);
        this.burst(180, 0.8, 0.25, 0.25);
        this.blip(1800, 0.2, 0.04, "square", this.sfxBus, t, 400);
        break;
      }
      case "lift": {
        // Rising clarinet run + glass shimmer.
        const ctx2 = ctx;
        const o = ctx2.createOscillator(); o.type = "square";
        const lp = ctx2.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1700; lp.Q.value = 1.5;
        const g = ctx2.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
        const step = 0.065;
        for (let i = 0; i < 12; i++) o.frequency.setValueAtTime(mtof(this.key.degree(1 + i, 4)), t + i * step);
        g.gain.setValueAtTime(0.07, t + 12 * step); g.gain.exponentialRampToValueAtTime(0.0001, t + 12 * step + 0.6);
        const vib = ctx2.createOscillator(); vib.frequency.value = 6; const vg = ctx2.createGain(); vg.gain.value = 6;
        vib.connect(vg).connect(o.detune);
        o.connect(lp).connect(g).connect(this.sfxBus);
        const sg = ctx2.createGain(); sg.gain.value = 0.6; g.connect(sg).connect(this.revSend);
        o.start(t); vib.start(t); o.stop(t + 12 * step + 0.7); vib.stop(t + 12 * step + 0.7);
        for (let i = 0; i < 9; i++) this.bell(t + 0.3 + i * 0.09, mtof(this.key.degree([1, 3, 5, 7, 8, 10, 12, 14, 15][i]!, 5)), 0.035, 2.2);
        break;
      }
      case "exit.closed":
      case "shutter": this.burst(220, 0.7, 1.0, 0.18); this.blip(90, 0.4, 0.15, "triangle", this.sfxBus, t + 0.8); break;
      case "escaped": {
        const spb = 60 / this.tempo;
        const five = this.key.chord(5, 3).map(mtof), one = this.key.chord(1, 3).map(mtof);
        this.brass(t, five, 0.12, 0.1, this.sfxBus);
        this.brass(t + spb * 0.66, one, 0.5, 0.12, this.sfxBus);
        this.chime(t + spb * 0.66, true);
        break;
      }
      case "lockdown": {
        // Sad trombone.
        const r = this.key.degree(5, 3);
        const notes = [r, r - 1, r - 2, r - 3];
        const spb = 60 / this.tempo;
        const o = ctx.createOscillator(); o.type = "sawtooth";
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 6;
        const g = ctx.createGain(); g.gain.value = 0.0001;
        notes.forEach((n, i) => {
          const at = t + i * spb * 0.9;
          o.frequency.setValueAtTime(mtof(n), at);
          lp.frequency.setValueAtTime(300, at); lp.frequency.exponentialRampToValueAtTime(1600, at + 0.12); lp.frequency.exponentialRampToValueAtTime(500, at + spb * 0.8);
          g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.12, at + 0.05);
          if (i < 3) g.gain.exponentialRampToValueAtTime(0.02, at + spb * 0.85);
        });
        const end = t + 3 * spb * 0.9;
        const vib = ctx.createOscillator(); vib.frequency.value = 5; const vg = ctx.createGain(); vg.gain.setValueAtTime(0, end); vg.gain.linearRampToValueAtTime(25, end + 0.4);
        vib.connect(vg).connect(o.detune);
        g.gain.setValueAtTime(0.12, end + 1.2); g.gain.exponentialRampToValueAtTime(0.0001, end + 1.8);
        o.connect(lp).connect(g).connect(this.sfxBus);
        o.start(t); vib.start(t); o.stop(end + 2); vib.stop(end + 2);
        this.play("shutter");
        break;
      }
      case "rewind": {
        const o = ctx.createOscillator(); o.type = "sawtooth";
        o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.5);
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1400;
        const g = ctx.createGain(); this.env(g, t, 0.05, 0.02, 0.5);
        o.connect(lp).connect(g).connect(this.sfxBus); o.start(t); o.stop(t + 0.6);
        this.duck = 0.5; this.applyVolumes();
        break;
      }
      case "rewind.end": this.duck = 1; this.applyVolumes(); this.blip(500, 0.12, 0.05, "sine", this.sfxBus, t, 1100); break;
      case "restart": this.blip(1400, 0.12, 0.05, "sine", this.uiBus, t, 700); break;
      case "ui.move": this.blip(880, 0.03, 0.04, "triangle", this.uiBus); break;
      case "ui.confirm": this.bell(t, mtof(this.key.degree(5, 5)), 0.05, 0.5, this.uiBus); this.bell(t + 0.06, mtof(this.key.degree(8, 5)), 0.05, 0.7, this.uiBus); break;
      case "ui.back": this.bell(t, mtof(this.key.degree(5, 4)), 0.05, 0.4, this.uiBus); break;
      case "ui.start": this.chime(t, true); break;
      case "stamp": this.burst(160, 0.6, 0.3, 0.35); this.blip(70, 0.25, 0.3, "sine"); break;
      case "paper": this.burst(3000, 0.5, 0.35, 0.06); break;
    }
  }

  private stopStems() {
    for (const k of Object.keys(this.stemSources) as Array<keyof typeof this.stemSources>) { try { this.stemSources[k]?.stop(); } catch { /* already stopped */ } }
    this.stemSources = {};
  }

  stopAll() {
    for (const v of this.voices.values()) v.gain.gain.setTargetAtTime(0, this.ctx?.currentTime ?? 0, 0.1);
  }
}
