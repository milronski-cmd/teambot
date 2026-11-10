/** Selection rules of the shared bot picker (components/BotPicker.tsx), kept pure for the unit test. */

/** "Alle bots": adds every bot, or clears them when all are on already (other ids in `value` stay). */
export function toggleAll(value: string[], ids: string[]): string[] {
  const allOn = ids.length > 0 && ids.every((id) => value.includes(id));
  return allOn ? value.filter((x) => !ids.includes(x)) : [...new Set([...value, ...ids])];
}

/** One bot on or off; with `single` at most one stays chosen. */
export function toggleOne(value: string[], id: string, single = false): string[] {
  const on = value.includes(id);
  if (single) return on ? [] : [id];
  return on ? value.filter((x) => x !== id) : [...value, id];
}
