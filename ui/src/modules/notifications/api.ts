import { create } from 'zustand';
import { api, on } from '../../lib/api';
import { parseHash } from '../../lib/router';
import { toast } from '../../components/ui';
import { translate } from '../../lib/i18n';
import { approvalIdOfItem, approvalIdOfTag, approvalTag, closeHandledEverywhere, PageNotes, type NoteRegistration } from './handled';
import { NOTIFY_LEVELS } from '../../../../shared/settings.js';

export type NotifyLevel = 'all' | 'important' | 'none';

export interface NotifyPrefs {
  sound: boolean;
  other: NotifyLevel;
  bots: Record<string, NotifyLevel>;
}

export interface NotificationItem {
  id: string;
  kind: string;
  important: boolean;
  title: string;
  body: string;
  link: string;
  agent_id: string | null;
  /** `apr:<id>` for an approval or question. */
  ref?: string | null;
  count: number;
  muted: boolean;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

export type NotifyFilter = 'all' | 'unread' | 'important';

interface State {
  items: NotificationItem[] | null;
  filter: NotifyFilter;
  more: boolean;
  unread: number;
  prefs: NotifyPrefs | null;
  /** The bell's popover (desktop). */
  panelOpen: boolean;
}

export const useNotifications = create<State>(() => ({ items: null, filter: 'all', more: false, unread: 0, prefs: null, panelOpen: false }));

/** The words of each level (shared/settings.ts, where a bot finds them too). */
export const LEVEL_LABEL = Object.fromEntries(NOTIFY_LEVELS.map((l) => [l.value, l.label])) as Record<NotifyLevel, string>;

/** What a kind is called in the list. */
export const KIND_LABEL: Record<string, string> = {
  approval: 'Goedkeuring',
  question: 'Vraag',
  run: 'Taak',
  routine: 'Routine',
  limit: 'Limiet',
  channel: 'Kanaal',
  team: 'Groep',
  memory: 'Geheugen',
  mcp: 'App',
  skill: 'Skill',
  agent: 'Bot',
  warning: 'Waarschuwing',
  computer: 'Computer',
  report: 'Marktplaats',
  teamdata: 'Teamwerk',
};

const matches = (n: NotificationItem, f: NotifyFilter) => f === 'all' || (f === 'unread' ? !n.read_at : n.important);

export async function loadNotifications(filter: NotifyFilter = useNotifications.getState().filter) {
  const r = await api.get<{ items: NotificationItem[]; more: boolean; unread: number }>(`/notifications?filter=${filter}&limit=40`);
  useNotifications.setState({ items: r.items, more: r.more, unread: r.unread, filter });
}

export async function loadMoreNotifications() {
  const s = useNotifications.getState();
  const last = s.items?.[s.items.length - 1];
  if (!last) return;
  const r = await api.get<{ items: NotificationItem[]; more: boolean; unread: number }>(`/notifications?filter=${s.filter}&limit=40&before=${encodeURIComponent(last.updated_at)}`);
  useNotifications.setState((st) => ({ items: [...(st.items || []), ...r.items.filter((x) => !st.items?.some((y) => y.id === x.id))], more: r.more, unread: r.unread }));
}

const markLocal = (ids: string[] | 'all') =>
  useNotifications.setState((st) => ({
    items: st.items?.map((n) => (ids === 'all' || ids.includes(n.id) ? (n.read_at ? n : { ...n, read_at: new Date().toISOString() }) : n)).filter((n) => st.filter !== 'unread' || !n.read_at) ?? null,
  }));

export async function markRead(ids: string[]) {
  if (!ids.length) return;
  markLocal(ids);
  const r = await api.post<{ unread: number }>('/notifications/read', { ids });
  useNotifications.setState({ unread: r.unread });
}

export async function markAllRead() {
  markLocal('all');
  const r = await api.post<{ unread: number }>('/notifications/read', { all: true });
  useNotifications.setState({ unread: r.unread });
  return r;
}

export async function clearNotifications() {
  await api.del('/notifications');
  useNotifications.setState({ items: [], unread: 0, more: false });
}

export async function loadPrefs() {
  const p = await api.get<NotifyPrefs>('/notifications/prefs');
  useNotifications.setState({ prefs: p });
  return p;
}

export async function savePrefs(patch: Partial<Omit<NotifyPrefs, 'bots'>> & { bots?: Record<string, NotifyLevel | null> }) {
  const p = await api.put<NotifyPrefs>('/notifications/prefs', patch);
  useNotifications.setState({ prefs: p });
  return p;
}

export const levelOf = (prefs: NotifyPrefs | null, agentId: string) => prefs?.bots[agentId] || 'all';

// ---------------- sound ----------------

let audio: AudioContext | null = null;
/** A short, soft two-tone chime (generated, no audio file). */
export function playChime() {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    audio = audio || new AC();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    const t = audio.currentTime;
    for (const [i, f] of [880, 1318.5].entries()) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const s = t + i * 0.11;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.07, s + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.32);
      o.connect(g).connect(audio.destination);
      o.start(s);
      o.stop(s + 0.34);
    }
  } catch {
    /* no audio: fine */
  }
}

// ---------------- live wiring ----------------

/** The desktop app shows its own Windows notifications (with buttons); then the page does not add web ones. */
const nativeNotifications = () => !!(window as any).teambotDesktop?.nativeNotifications;

/** Looking at the chat this notification is about: no toast or sound needed. */
function looking(link: string) {
  if (document.hidden) return false;
  const p = parseHash(link);
  const cur = parseHash();
  return p[0] === 't' && cur[0] === 't' && p[1] === cur[1];
}

/** Opening a chat reads its notifications (only when the loaded list has unread ones for it: no extra calls). */
function readOpenChat() {
  const cur = parseHash();
  if (cur[0] !== 't' || !cur[1] || document.hidden) return;
  const link = `#/t/${cur[1]}`;
  const ids = (useNotifications.getState().items || []).filter((n) => !n.read_at && n.link === link).map((n) => n.id);
  if (ids.length) markRead(ids).catch(() => {});
}

/** The floating status window of the desktop app: it shows these items itself, the app makes the Windows notification. */
function inStatusWindow() {
  const p = parseHash();
  return p[0] === 'm' && p[1] === 'usage' && p[2] === 'eiland';
}

function present(item: NotificationItem, sound: boolean) {
  // No toasts over the small status window's own cards, and no second chime (B-69).
  if (inStatusWindow()) return;
  if (looking(item.link)) {
    if (!item.read_at) markRead([item.id]).catch(() => {});
    return;
  }
  if (!document.hidden) {
    // Title and body each translated on their own (joined, no dictionary entry would match the whole).
    toast(item.body ? `${translate(item.title)}: ${translate(item.body)}` : translate(item.title));
    if (sound) playChime();
    return;
  }
  if (nativeNotifications() || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    // A system notification is not part of the page, so the page translation does not reach it.
    const apr = approvalIdOfItem(item);
    const x = new Notification(translate(item.title), { body: translate(item.body || ''), tag: apr ? approvalTag(apr) : item.link || item.id, silent: !sound });
    if (apr) pageNotes.add(x);
    x.onclose = () => pageNotes.forget(x);
    x.onclick = () => {
      window.focus();
      if (item.link) location.hash = item.link;
      markRead([item.id]).catch(() => {});
    };
  } catch {
    /* ignore */
  }
}

// ---------------- handled elsewhere (PARITEIT 15.1, web) ----------------

const pageNotes = new PageNotes();

async function registration(): Promise<NoteRegistration | null> {
  try {
    return ((await navigator.serviceWorker?.getRegistration()) as NoteRegistration | undefined) || null;
  } catch {
    return null;
  }
}

/** An approval or question was decided somewhere: its notification on this device goes away. */
function closeOne(id: string) {
  registration().then((reg) => closeHandledEverywhere(reg, pageNotes, { handled: id })).catch(() => {});
}

/** Opening or returning to the app: notifications of approvals that no longer wait go away (Apple sends no close push). */
function closeStale() {
  if (document.hidden) return;
  registration()
    .then(async (reg) => {
      // Only ask the server when an approval notification is actually showing.
      const shown = reg ? await reg.getNotifications().catch(() => []) : [];
      if (!pageNotes.size && !shown.some((n) => approvalIdOfTag(n.tag))) return;
      const pending = await api.get<{ id: string }[]>('/approvals');
      await closeHandledEverywhere(reg, pageNotes, { pending: new Set(pending.map((a) => a.id)) });
    })
    .catch(() => {});
}

/** Subscribe once after login: live history, unread count, toasts/sound/web notifications that respect the levels. */
export function wireNotifications(): () => void {
  const offs = [
    on('notification.added', (d: { item: NotificationItem; alert: boolean; sound: boolean; unread: number }) => {
      if (!d?.item) return;
      useNotifications.setState((st) => {
        if (!st.items) return { unread: d.unread };
        const rest = st.items.filter((n) => n.id !== d.item.id);
        return { unread: d.unread, items: matches(d.item, st.filter) ? [d.item, ...rest] : rest };
      });
      if (d.alert) present(d.item, d.sound);
    }),
    on('notifications.read', (d: { ids?: string[]; all?: boolean; cleared?: boolean; unread: number }) => {
      if (d?.cleared) useNotifications.setState({ items: [], more: false, unread: 0 });
      else {
        markLocal(d?.all ? 'all' : d?.ids || []);
        useNotifications.setState({ unread: d?.unread ?? 0 });
      }
    }),
    on('notifications.prefs', (p: NotifyPrefs) => useNotifications.setState({ prefs: p })),
    on('approval.updated', (a: { id?: string; status?: string }) => {
      if (typeof a?.id === 'string' && a.status && a.status !== 'pending') closeOne(a.id);
    }),
    // After a reconnect: catch up on what was missed.
    on('ws.status', (d) => {
      if (!d?.connected) return;
      loadNotifications().catch(() => {});
      closeStale();
    }),
  ];
  window.addEventListener('hashchange', readOpenChat);
  document.addEventListener('visibilitychange', readOpenChat);
  document.addEventListener('visibilitychange', closeStale);
  offs.push(
    () => window.removeEventListener('hashchange', readOpenChat),
    () => document.removeEventListener('visibilitychange', readOpenChat),
    () => document.removeEventListener('visibilitychange', closeStale),
  );
  loadNotifications()
    .then(readOpenChat)
    .catch(() => {});
  closeStale();
  loadPrefs().catch(() => {});
  return () => offs.forEach((f) => f());
}
