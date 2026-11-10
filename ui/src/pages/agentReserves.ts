/** Reserve engines of a bot in the editor ("Reserve-engines bij limiet of storing"). Pure, so it is unit-tested. */

/** Up to this many reserves per bot: the same number as the server (MAX_FALLBACKS in server/agent/fallback.ts). */
export const MAX_RESERVES = 5;

export interface Reserve {
  provider_id: string;
  model: string;
}

/** The change for a new ordered reserve list: all of them (up to MAX_RESERVES), the first also as the legacy `fallback`. */
export function reservesPatch(settings: Record<string, any> | undefined, list: Reserve[]): { fallback: Reserve | null; settings: Record<string, any> } {
  const kept = list.filter((r) => r && r.provider_id).slice(0, MAX_RESERVES);
  return { fallback: kept[0] || null, settings: { ...(settings || {}), fallbacks: kept } };
}
