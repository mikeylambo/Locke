import type { RoomDef } from "../sim/roomTypes";

/** Rooms are data: every JSON in src/rooms is bundled and addressable by id. */
const files = import.meta.glob<RoomDef>("../rooms/*.json", { import: "default" });

export async function loadRoom(id: string): Promise<RoomDef> {
  const key = `../rooms/${id}.json`;
  const load = files[key];
  if (!load) throw new Error(`Unknown room: ${id}`);
  return structuredClone(await load());
}

export const roomIds = () => Object.keys(files).map((k) => k.replace("../rooms/", "").replace(".json", ""));
