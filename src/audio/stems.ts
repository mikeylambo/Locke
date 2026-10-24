/**
 * Music stem slots per venue. Drop Michael's loops into /public/audio/<venue>/ and list them here.
 * Each stem loops at bar boundaries on the shared tempo clock. Any missing stem falls back to the
 * procedural swing bed so a room is never silent.
 *
 *   bed     — always on while in the room (bass + ride)
 *   near    — fades in as Locke nears the prize (brushes, comping)
 *   escape  — full band once the prize is lifted
 */
export interface VenueStems { bars: number; bed?: string; near?: string; escape?: string; stingers?: Partial<Record<"contact" | "lift" | "exit" | "lockdown", string>> }

export const STEMS: Record<string, VenueStems> = {
  "gilded-museum": { bars: 8 }
};
