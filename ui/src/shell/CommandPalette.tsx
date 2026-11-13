import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  AlarmClock,
  AppWindow,
  Bell,
  Bot,
  Brain,
  CheckCheck,
  CornerDownLeft,
  Ellipsis,
  File,
  Folder,
  History,
  Inbox,
  ListChecks,
  LogOut,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Moon,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  Store,
  Sun,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { useApp } from '../lib/store';
import { navigate } from '../lib/router';
import { stripRefs } from '../lib/preview';
import { useIsDesktop } from '../lib/media';
import { GROUP_LABEL, groupItems, pushRecent, rank, staticEntries, type PaletteItem, type PaletteKind } from '../lib/palette';
import { uiModules } from '../modules';
import { markAllRead, useNotifications } from '../modules/notifications/api';
import { BotAvatar } from '../components/BotFace';
import { Spinner, cx, listTime, toast, toastError } from '../components/ui';
import { getThemePref, setThemePref } from './theme';
import { logout, stopAll } from './Sidebar';
import { setAdvanced, useAdvanced } from './advanced';

/**
 * Ctrl+K: one search box for everything — chats and messages, bots, groups, pages and settings, channels, skills, tasks,
 * apps, routines, files and memory — plus quick actions. Keyboard: ↑/↓ choose, Enter opens, Esc closes.
 * Desktop: an overlay (CommandPalette, mounted once in the shell). Phone: the #/search page (PaletteView).
 */

export const usePalette = create<{ open: boolean; q: string }>(() => ({ open: false, q: '' }));
export const openPalette = (q = '') => usePalette.setState({ open: true, q });
export const closePalette = () => usePalette.setState({ open: false, q: '' });

const RECENT_KEY = 'tb_palette_recent';
function readRecent(): PaletteItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string' && typeof x.title === 'string') : [];
  } catch {
    return [];
  }
}
function saveRecent(list: PaletteItem[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

interface Hit {
  id: string;
  kind: PaletteKind;
  title: string;
  subtitle?: string;
  snippet?: string;
  href: string;
  agentId?: string | null;
  at?: string | null;
}

/** Text with [marked] parts, as the server's snippets come. */
export function Snippet({ text }: { text: string }) {
  // Memory codes ([m:2tdmcj]) are not hits; the highlight markers are [ ] as well, so drop the codes first.
  const parts = stripRefs(text).split(/(\[[^\]]*\])/g);
  return (
    <span translate="no">
      {parts.map((p, i) =>
        p.startsWith('[') && p.endsWith(']') ? (
          <mark key={i} className="rounded-md bg-warn-soft px-0.5 font-semibold text-fg">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

const KIND_ICON: Partial<Record<PaletteKind, LucideIcon>> = {
  page: Ellipsis,
  setting: Settings,
  group: Users,
  chat: MessageSquare,
  channel: MessagesSquare,
  skill: Sparkles,
  app: AppWindow,
  routine: AlarmClock,
  task: ListChecks,
  file: File,
  memory: Brain,
  message: MessageSquare,
  recent: History,
};
const NAMED_ICON: Record<string, LucideIcon> = { MessageCircle, Inbox, Bot, Ellipsis, Settings, Plus, Square, AlarmClock, MessagesSquare, AppWindow, Store, Bell, CheckCheck, Moon, Sun, LogOut, Folder, Search, ListChecks, SlidersHorizontal };

function iconFor(it: PaletteItem): LucideIcon {
  if (it.icon?.startsWith('page:')) {
    const [mod, path] = it.id.split('/');
    const pages = uiModules.find((m) => m.id === mod)?.pages || [];
    // A sub page without its own icon borrows the module's (Kluis → Computers).
    return pages.find((p) => p.path === (path || ''))?.icon || pages.find((p) => p.icon)?.icon || Ellipsis;
  }
  if (it.icon && NAMED_ICON[it.icon]) return NAMED_ICON[it.icon];
  if (it.kind === 'file' && it.subtitle?.endsWith('· map')) return Folder;
  return KIND_ICON[it.kind] || Ellipsis;
}

/** Scroll to a message once its chat has rendered, and flash it briefly. */
function jumpToMessage(id: string) {
  let tries = 0;
  const tick = () => {
    const el = document.getElementById(`m-${id}`);
    if (!el) {
      if (++tries < 50) setTimeout(tick, 100);
      return;
    }
    setTimeout(() => {
      el.scrollIntoView({ block: 'center' });
      el.animate?.([{ backgroundColor: 'var(--color-warn-soft)' }, { backgroundColor: 'transparent' }], { duration: 2200, easing: 'ease-out' });
    }, 350);
  };
  tick();
}

/** The quick actions; `runs` and `unread` decide the subtitles. */
function useActions(): (PaletteItem & { run?(): void })[] {
  const runs = useApp((s) => s.runs.length);
  const mode = useApp((s) => s.mode);
  const unread = useNotifications((s) => s.unread);
  const advanced = useAdvanced();
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return useMemo(
    () => [
      { id: 'new-bot', kind: 'action' as const, title: 'Nieuwe bot', subtitle: 'Beschrijf wat hij moet doen of kies een sjabloon', href: '#/agents/new', icon: 'Plus', keywords: ['bot maken', 'aanmaken', 'toevoegen', 'agent', 'nieuw'] },
      {
        id: 'stop-all',
        kind: 'action' as const,
        title: 'Alles stoppen',
        subtitle: runs === 1 ? '1 taak bezig' : runs ? `${runs} taken bezig` : 'Er loopt nu niets',
        icon: 'Square',
        keywords: ['stop', 'noodstop', 'annuleren', 'halt', 'taken stoppen'],
        run: () => (runs ? stopAll() : toast('Er loopt nu niets om te stoppen')),
      },
      { id: 'new-routine', kind: 'action' as const, title: 'Nieuwe routine', subtitle: 'Een taak die vanzelf op een tijdstip draait', href: '#/m/routines/r/new', icon: 'AlarmClock', keywords: ['routine maken', 'planning', 'herhalen', 'elke dag'] },
      { id: 'add-channel', kind: 'action' as const, title: 'Kanaal toevoegen', subtitle: 'Telegram, WhatsApp, Discord, Slack of e-mail', href: '#/m/channels/nieuw', icon: 'MessagesSquare', keywords: ['telegram', 'whatsapp', 'discord', 'slack', 'e-mail', 'koppelen'] },
      { id: 'connect-app', kind: 'action' as const, title: 'App koppelen', subtitle: 'Agenda, mail, bestanden en meer', href: '#/m/mcp/', icon: 'AppWindow', keywords: ['app', 'connector', 'mcp', 'integratie', 'gmail', 'notion'] },
      { id: 'find-skill', kind: 'action' as const, title: 'Skill zoeken', subtitle: 'In de marktplaats', href: '#/m/skills/skills', icon: 'Store', keywords: ['skill installeren', 'marktplaats', 'vaardigheid'] },
      { id: 'notifications', kind: 'action' as const, title: 'Meldingen bekijken', subtitle: unread ? `${unread} ongelezen` : 'Alles gelezen', href: '#/m/notifications/', icon: 'Bell', keywords: ['meldingen', 'notificaties', 'bel', 'geschiedenis'] },
      ...(unread ? [{ id: 'read-all', kind: 'action' as const, title: 'Alle meldingen gelezen', subtitle: `${unread} ongelezen`, icon: 'CheckCheck', keywords: ['meldingen', 'gelezen', 'markeren'], run: () => void markAllRead().then(() => toast('Alles gelezen', 'ok'), toastError) }] : []),
      {
        id: 'advanced',
        kind: 'action' as const,
        title: advanced ? 'Geavanceerd verbergen' : 'Geavanceerd tonen',
        subtitle: advanced ? 'Terug naar de eenvoudige weergave' : 'Ook de onderdelen voor gevorderden',
        icon: 'SlidersHorizontal',
        keywords: ['geavanceerd', 'expert', 'eenvoudig', 'zijpaneel', 'tabellen', 'beslissingen'],
        run: () => void setAdvanced(!advanced).then(() => toast(advanced ? 'Geavanceerd staat uit' : 'Geavanceerd staat aan', 'ok'), toastError),
      },
      { id: 'theme', kind: 'action' as const, title: dark ? 'Licht thema' : 'Donker thema', subtitle: getThemePref() === 'system' ? 'Nu: volgt het systeem' : 'Weergave wisselen', icon: dark ? 'Sun' : 'Moon', keywords: ['thema', 'donker', 'licht', 'dark mode', 'weergave'], run: () => setThemePref(dark ? 'light' : 'dark') },
      ...(mode === 'server' ? [{ id: 'logout', kind: 'action' as const, title: 'Uitloggen', icon: 'LogOut', keywords: ['afmelden', 'log out'], run: () => void logout() }] : []),
    ],
    [runs, unread, mode, dark, advanced],
  );
}

/** Local items (bots, groups, chats, pages, settings) from what the app already has. */
function useLocalIndex(): PaletteItem[] {
  const agents = useApp((s) => s.agents);
  const threads = useApp((s) => s.threads);
  const me = useApp((s) => s.me);
  const mode = useApp((s) => s.mode);
  return useMemo(() => {
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const out: PaletteItem[] = staticEntries(uiModules, { isAdmin: me?.role !== 'member', serverMode: mode === 'server' });
    for (const a of agents) {
      if (a.archived) continue;
      out.push({ id: a.id, kind: 'bot', title: a.name, subtitle: a.role || 'Bot', href: `#/a/${a.id}`, agentId: a.id, keywords: [a.description || ''] });
    }
    for (const t of threads) {
      if (t.archived || t.kind === 'delegation') continue;
      if (t.kind === 'room') out.push({ id: t.id, kind: 'group', title: t.title || 'Groep', subtitle: 'Groepsgesprek', href: `#/t/${t.id}`, at: t.updated_at });
      else if (t.title) out.push({ id: t.id, kind: 'chat', title: t.title, subtitle: [names.get(t.agent_id || '') || '', t.kind === 'channel' ? 'kanaal' : t.kind === 'routine' ? 'routine' : ''].filter(Boolean).join(' · '), href: `#/t/${t.id}`, agentId: t.agent_id, at: t.updated_at });
    }
    return out;
  }, [agents, threads, me?.role, mode]);
}

/**
 * Results whose title is someone's own words: a chat's or group's title, a file, a bot's name, a channel, skill, app,
 * routine or task as it was named, a memory as written. TeamBot's own fallback for one without a title stays
 * interface text ("Gesprek", "Groep", "Gevoelige herinnering").
 */
const OWN_TITLE = new Set<string>(['file', 'chat', 'group', 'message', 'bot', 'channel', 'skill', 'app', 'routine', 'task', 'memory']);
const FALLBACK_TITLE = new Set(['Gesprek', 'Groep', 'Gevoelige herinnering']);
const ownTitle = (it: PaletteItem & { origin?: string }) => OWN_TITLE.has(it.kind === 'recent' ? it.origin || '' : it.kind) && !FALLBACK_TITLE.has(it.title);
/** A subtitle that is someone's own words: who wrote a message, a bot's role, a skill's description. */
const ownSubtitle = (it: PaletteItem) => it.kind === 'message' || (it.kind === 'bot' && it.subtitle !== 'Bot') || (it.kind === 'skill' && it.subtitle !== 'Skill' && it.subtitle !== 'Skill · uit');

function Leading({ it }: { it: PaletteItem }) {
  const bot = useApp((s) => (it.agentId ? s.agents.find((a) => a.id === it.agentId) : undefined));
  const showBot = !!bot && (it.kind === 'bot' || it.kind === 'chat' || it.kind === 'message' || (it.kind === 'recent' && (it.icon === 'bot' || it.icon === 'chat')));
  if (showBot) return <BotAvatar bot={bot} size={30} />;
  const Icon = iconFor(it.kind === 'recent' && it.icon && !NAMED_ICON[it.icon] && !it.icon.startsWith('page:') ? { ...it, kind: (it.icon as PaletteKind) || 'recent' } : it);
  return (
    <span className={cx('flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-control', it.id === 'stop-all' ? 'bg-danger-soft text-danger' : 'bg-surface-3 text-fg')}>
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}

/**
 * The palette itself: the search box and grouped results. `onDone` is called after an item was opened (the overlay
 * closes). `page` mode is the full-width #/search page (phones: the search field above the chats, and Meer › Zoeken).
 */
export function PaletteView({ initialQuery = '', page, onDone }: { initialQuery?: string; page?: boolean; onDone?(): void }) {
  const [q, setQ] = useState(initialQuery);
  const [hits, setHits] = useState<{ q: string; hits: Hit[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<PaletteItem[]>(readRecent);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const actions = useActions();
  const local = useLocalIndex();
  const desktop = useIsDesktop();

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Server search (messages, channels, skills, apps, routines, tasks, files, memory), debounced; stale answers are dropped.
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits(null);
      setBusy(false);
      return;
    }
    const my = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      api
        .get<{ q: string; hits: Hit[] }>(`/search/all?q=${encodeURIComponent(term)}`)
        .then((r) => my === seq.current && setHits({ q: term, hits: r.hits || [] }))
        .catch(() => my === seq.current && setHits({ q: term, hits: [] }))
        .finally(() => my === seq.current && setBusy(false));
    }, 160);
    return () => clearTimeout(t);
  }, [q]);

  const groups = useMemo(() => {
    const term = q.trim();
    if (!term) {
      const resolved = recent
        .map((r) => (r.kind === 'action' ? actions.find((a) => a.id === r.id) : r))
        .filter(Boolean)
        .map((r) => ({ ...r!, kind: 'recent' as const, icon: r!.kind === 'action' || r!.kind === 'page' || r!.kind === 'setting' ? r!.icon : r!.kind, origin: r!.kind }));
      const bots = local.filter((i) => i.kind === 'bot').slice(0, 5);
      const quick = actions.filter((a) => ['new-bot', 'stop-all', 'new-routine', 'connect-app', 'notifications'].includes(a.id)).filter((a) => a.id !== 'stop-all' || useApp.getState().runs.length);
      return groupItems([...resolved.slice(0, 5), ...quick, ...bots]);
    }
    const mine = rank(term, [...actions, ...local], 6);
    const server = hits && hits.q === term ? hits.hits.map((h) => ({ ...h }) as PaletteItem) : [];
    return groupItems([...mine, ...server], { bestFirst: true });
  }, [q, hits, local, actions, recent]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // A new query starts at the top; server results arriving later are appended below, so the choice stays put.
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1));
  }, [flat.length, active]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const activate = (it: PaletteItem & { run?(): void; origin?: PaletteKind }) => {
    const kind = it.kind === 'recent' ? (it as any).origin || 'page' : it.kind;
    const base = kind === 'action' ? actions.find((a) => a.id === it.id) : null;
    const next = pushRecent(recent, { ...it, kind, icon: kind === 'action' || kind === 'page' || kind === 'setting' ? it.icon : undefined });
    setRecent(next);
    saveRecent(next);
    onDone?.();
    const run = base?.run || (it as any).run;
    if (run) return run();
    if (it.href) navigate(it.href);
    if (kind === 'message') jumpToMessage(it.id);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const it = flat[active];
      if (it) activate(it);
    } else if (e.key === 'Escape' && page && q) {
      e.preventDefault();
      setQ('');
    } else if (e.key === 'Tab' && !page) {
      // The overlay is modal and the field is its only control: keep the focus here (↑/↓ move through the results).
      e.preventDefault();
    }
  };

  const term = q.trim();
  const optId = (i: number) => `${listId}-o${i}`;
  const empty = term && !busy && hits?.q === term && flat.length === 0;
  let idx = -1;
  return (
    <div className={cx('flex min-h-0 flex-col', !page && 'max-h-[min(640px,76vh)]')}>
      <div className={cx('relative flex items-center gap-2', page ? 'rounded-2xl border border-line bg-surface px-3.5 focus-within:border-muted' : 'border-b border-line px-4')}>
        <Search className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-activedescendant={flat.length ? optId(active) : undefined}
          aria-autocomplete="list"
          aria-label="Zoek in gesprekken, bots, pagina's, instellingen, kanalen, skills, apps, routines, taken, bestanden en geheugen"
          placeholder="Zoek of typ een actie…"
          enterKeyHint="go"
          autoComplete="off"
          spellCheck={false}
          // The whole row is the field (its border shows focus on the page; the overlay holds nothing else).
          style={{ outline: 'none' }}
          className={cx('min-w-0 flex-1 bg-transparent text-fg placeholder:text-muted', page ? 'h-12 text-base' : 'h-[52px] text-[15.5px]')}
        />
        {busy && <Spinner />}
        {!page && desktop && <kbd className="shrink-0 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-muted">Esc</kbd>}
      </div>
      <div className="sr-only" aria-live="polite">
        {term ? (busy ? 'Zoeken…' : t('{0, plural, one {# resultaat} other {# resultaten}}', flat.length)) : ''}
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label="Resultaten" className={cx('scroll-thin min-h-0 flex-1 overflow-y-auto', page ? 'mt-3 space-y-3' : 'px-2 py-2')}>
        {groups.map((g) => {
          const gid = `${listId}-g-${g.kind}`;
          return (
            <div key={g.kind} role="group" aria-labelledby={gid} className={cx(page && 'overflow-hidden rounded-2xl border border-line bg-surface py-1')}>
              <div id={gid} className="px-3 pb-1 pt-2 text-[11.5px] font-bold uppercase tracking-wider text-muted">
                {GROUP_LABEL[g.kind]}
              </div>
              {g.items.map((it) => {
                idx++;
                const i = idx;
                const on = i === active;
                return (
                  <div
                    key={`${it.kind}:${it.id}`}
                    id={optId(i)}
                    data-idx={i}
                    role="option"
                    aria-selected={on}
                    onMouseMove={() => !on && setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => activate(it)}
                    className={cx('mx-1 flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 coarse:py-2.5', on ? 'bg-surface-3' : 'hover:bg-surface-2')}
                  >
                    <Leading it={it} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className={cx('min-w-0 truncate text-[14px] font-semibold', it.id === 'stop-all' && 'text-danger')} translate={ownTitle(it) ? 'no' : undefined}>
                          {it.title}
                        </span>
                        {it.at && it.kind === 'message' && <span className="ms-auto shrink-0 text-[11.5px] text-muted">{listTime(it.at)}</span>}
                      </div>
                      {it.snippet ? (
                        <div className="line-clamp-2 text-[12.5px] leading-snug text-muted">
                          {it.subtitle ? (
                            <span className="font-medium">
                              <bdi translate={ownSubtitle(it) ? 'no' : undefined}>{it.subtitle}</bdi>:{' '}
                            </span>
                          ) : null}
                          <Snippet text={it.snippet} />
                        </div>
                      ) : (
                        it.subtitle && (
                          // A bot's role or a skill's description is the user's or its publisher's words.
                          <div className="truncate text-[12.5px] text-muted" translate={ownSubtitle(it) ? 'no' : undefined}>
                            {it.subtitle}
                          </div>
                        )
                      )}
                    </div>
                    {on && desktop && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />}
                  </div>
                );
              })}
            </div>
          );
        })}
        {empty && (
          <div className="px-4 py-10 text-center">
            <div className="text-[15px] font-bold">Niets gevonden voor “{term}”</div>
            <div className="mt-1 text-sm text-muted">Probeer een ander woord, of een deel van een naam.</div>
          </div>
        )}
        {!term && !groups.length && <div className="px-4 py-8 text-center text-sm text-muted">Typ om te zoeken in alles van TeamBot.</div>}
      </div>
      {!page && desktop && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-[11.5px] text-muted">
          <span>
            <kbd className="font-sans font-semibold">↑↓</kbd> kiezen
          </span>
          <span>
            <kbd className="font-sans font-semibold">↵</kbd> openen
          </span>
          <span>
            <kbd className="font-sans font-semibold">Esc</kbd> sluiten
          </span>
          <span className="ms-auto">Zoekt overal in TeamBot</span>
        </div>
      )}
    </div>
  );
}

/** The Ctrl+K overlay (desktop). Mounted once by the shell; open with openPalette(). */
export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const q = usePalette((s) => s.q);
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement as HTMLElement | null;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), closePalette());
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('keydown', k);
      // Back to where you were, unless an item moved the focus elsewhere (a new page focuses its own field).
      if (back.current && document.activeElement === document.body) back.current.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[55] flex items-start justify-center bg-black/45 px-3 pt-[10vh] backdrop-blur-[2px]" onMouseDown={closePalette}>
      <div role="dialog" aria-modal="true" aria-label="Zoeken en snelle acties" className="w-full max-w-[640px] overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <PaletteView initialQuery={q} onDone={closePalette} />
      </div>
    </div>
  );
}
