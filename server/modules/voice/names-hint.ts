/**
 * A spoken message can name another bot ("Vraag aan Onderzoeker …"), but speech-to-text often gets a name slightly
 * wrong ("Vraag en onderzoeken …", acceptance round 4, B-52). A group call matches names itself (ui/…/voice/names.ts);
 * in a one-to-one call or a voice memo the bot gets the names of its colleagues, so it can hand the work to the right
 * bot instead of saying it does not know whom you meant.
 */
export function spokenNamesHint(selfId: string, bots: { id: string; name: string; archived?: number | boolean }[], max = 25): string | null {
  const names = bots.filter((b) => b.id !== selfId && !b.archived && b.name?.trim()).map((b) => b.name.trim());
  if (!names.length) return null;
  const shown = names.slice(0, max);
  const more = names.length > shown.length ? ` (en ${names.length - shown.length} meer)` : '';
  return `Namen van bots kunnen in het transcript verkeerd verstaan zijn (bijvoorbeeld "onderzoeken" voor "Onderzoeker"). Je collega-bots heten: ${shown.join(', ')}${more}. Lijkt een woord sterk op een van die namen en gaat het om werk voor een andere bot, ga dan uit van die bot; twijfel je tussen twee bots, vraag het dan kort na.`;
}
