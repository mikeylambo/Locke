import LINES from "../content/lines.json";

export interface Line { text: string; glyph?: string; clip?: string; hum?: "hum" | "grunt" | "chuckle" | "tsk" }
type Table = Record<string, Record<string, Line>>;
const table = LINES as unknown as Table;

/** Room-specific line if Michael wrote one, else the default for that trigger. */
export function lineFor(roomId: string, trigger: string): Line | null {
  return table[roomId]?.[trigger] ?? table.default?.[trigger] ?? null;
}
