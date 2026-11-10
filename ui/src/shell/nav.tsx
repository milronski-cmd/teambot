import { Activity, AlarmClock, Brain, Ellipsis, Inbox, MessageCircle, Settings, SquareKanban, Store } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { settingsHostOf } from '../lib/palette';
import { uiModules } from '../modules';

/**
 * The fixed places of the app, shared by the desktop sidebar, the phone tab bar and the phone "Meer" screen.
 * Everything else lives under Instellingen (lib/palette.ts SETTINGS_GROUPS).
 *
 * TeamBot 0.4.2 ("simpeler voor een normaal mens"): the desktop sidebar keeps only what matters day to day — the
 * chats, Wacht op jou, Taken and Instellingen. Routines moved into Taken (they are work too: tasks that run by
 * themselves; one click on the Taken page, and Taken stays marked there). Geheugen moved into Instellingen › Bots en
 * teams (what your bots know), two clicks from the sidebar.
 * TeamBot 0.4.5: the Marktplaats is a fixed place again (what you can add to your bots, visible by default): its own
 * row in the sidebar, its pages no longer inside Instellingen (lib/palette.ts OWN_PLACES).
 */
export type DestId = 'chats' | 'inbox' | 'tasks' | 'routines' | 'memory' | 'market' | 'settings' | 'more' | 'now';

export interface Destination {
  id: DestId;
  href: string;
  label: string;
  icon: LucideIcon;
  active(route: string[]): boolean;
}

/** `<module>/<path>` of the module page a route shows (the same lookup as the router in App.tsx), or null. */
export function modulePageKey(route: string[]): string | null {
  if (route[0] !== 'm' || !route[1]) return null;
  const mod = uiModules.find((m) => m.id === route[1]);
  const page = mod?.pages?.find((p) => p.path === (route[2] || '')) || (route[2] ? mod?.pages?.find((p) => p.path === '') : mod?.pages?.[0]);
  return page ? `${route[1]}/${page.path}` : null;
}

/** The Instellingen entry a route belongs to (a settings tab, Alle bots, or a page that lives under Instellingen). */
export function settingsEntryOf(route: string[]): string | null {
  if (route[0] === 'settings') return route[1] || 'general';
  if (route[0] === 'agents' && !route[1]) return 'agents/';
  const key = modulePageKey(route);
  return key ? settingsHostOf(key) : null;
}

const mod = (route: string[], id: string) => route[0] === 'm' && route[1] === id;

export const DESTINATIONS: Record<DestId, Destination> = {
  // A new bot and a bot's own settings belong to the chats (reached from the list and from a chat), not to Meer.
  chats: { id: 'chats', href: '#/', label: 'Chats', icon: MessageCircle, active: (r) => !r[0] || r[0] === 't' || r[0] === 'a' || (r[0] === 'agents' && !!r[1]) },
  inbox: { id: 'inbox', href: '#/inbox', label: 'Wacht op jou', icon: Inbox, active: (r) => r[0] === 'inbox' },
  // Taken: one board at #/tasks; Teamwerk (#/m/teamdata/…), the routines (#/m/routines/…) and the old link Groepen ›
  // Takenbord (#/m/rooms/taken, the same board) count as Taken too.
  tasks: { id: 'tasks', href: '#/tasks', label: 'Taken', icon: SquareKanban, active: (r) => r[0] === 'tasks' || mod(r, 'teamdata') || mod(r, 'routines') || (mod(r, 'rooms') && r[2] === 'taken') },
  routines: { id: 'routines', href: '#/m/routines/', label: 'Routines', icon: AlarmClock, active: (r) => mod(r, 'routines') },
  memory: { id: 'memory', href: '#/m/memory/', label: 'Geheugen', icon: Brain, active: (r) => mod(r, 'memory') },
  market: { id: 'market', href: '#/m/skills/', label: 'Marktplaats', icon: Store, active: (r) => mod(r, 'skills') },
  settings: { id: 'settings', href: '#/settings', label: 'Instellingen', icon: Settings, active: (r) => !!settingsEntryOf(r) },
  more: { id: 'more', href: '#/more', label: 'Meer', icon: Ellipsis, active: (r) => r[0] === 'more' },
  // "Nu bezig" (0.4.5): every bot that works right now, its step, a live picture of its browser, Bekijken / Stoppen / Overnemen.
  now: { id: 'now', href: '#/m/usage/status', label: 'Nu bezig', icon: Activity, active: (r) => mod(r, 'usage') && r[2] === 'status' },
};

/** The fixed buttons at the bottom of the desktop sidebar, under "Wacht op jou". */
// 'now' (Nu bezig) is reached from Taken and Ctrl+K: the sidebar keeps at most six fixed places (tests/e2e/newcomer.mjs).
export const SIDEBAR_DESTINATIONS: DestId[] = ['tasks', 'market', 'settings'];

/**
 * Phone tab bar. The owner chooses between 3 and 5 tabs: this one line decides. "Meer" comes last and lists every
 * place that is not a tab. Five tabs would be: ['chats', 'inbox', 'tasks', 'routines', 'more'].
 */
export const PHONE_TABS: DestId[] = ['chats', 'inbox', 'more'];

/** The places the phone's "Meer" screen offers (a short list on its own screen, so Routines, Geheugen and Marktplaats stay). */
export const PHONE_MORE_DESTINATIONS: DestId[] = ['now', 'tasks', 'routines', 'memory', 'market', 'settings'];

/** What the phone "Meer" screen lists: its places that are not a tab of their own, in the same order. */
export function phoneMoreDestinations(): Destination[] {
  return (['inbox', ...PHONE_MORE_DESTINATIONS] as DestId[]).filter((id) => !PHONE_TABS.includes(id)).map((id) => DESTINATIONS[id]);
}

/** The phone tab that is active for a route: the first tab that claims it, else "Meer" (everything else is reached there). */
export function activePhoneTab(route: string[]): DestId {
  return PHONE_TABS.find((id) => id !== 'more' && DESTINATIONS[id].active(route)) || 'more';
}
