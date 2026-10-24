/** Room keys → pitches. Beams are notes; the room's live beams form its chord. */
const NOTE: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
export const MODES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11]
};

export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Key {
  readonly root: number;
  readonly scale: number[];
  constructor(root: string, mode: string) {
    this.root = NOTE[root] ?? 2;
    this.scale = MODES[mode] ?? MODES.dorian!;
  }
  /** 1-based scale degree → MIDI note around `octave`. */
  degree(deg: number, octave = 4): number {
    const d = deg - 1;
    const o = Math.floor(d / 7);
    const i = ((d % 7) + 7) % 7;
    return 12 * (octave + 1 + o) + this.root + this.scale[i]!;
  }
  /** Seventh chord built on a scale degree (MIDI). */
  chord(deg: number, octave = 3): number[] {
    return [0, 2, 4, 6].map((k) => this.degree(deg + k, octave));
  }
}
