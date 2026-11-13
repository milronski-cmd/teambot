import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDownUp, Check, ChevronDown, ChevronUp, Ellipsis, FolderPlus, GripVertical, Pin, PinOff, Settings2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { limitLine, moodTone, useAgentMood, useLimitUntil } from '../lib/mood';
import { MOOD_LABELS, type Mood } from '../lib/botface';
import type { Agent, Thread } from '../lib/types';
import { LiveBotAvatar, StackedFaces } from '../components/BotFace';
import { Button, cx, listTime, toastError } from '../components/ui';
import { MenuSeparator, Pop, menuKeys, menuRow, useDismiss } from '../components/Menu';
import { dictionaryLoaded, onDictionary, ownText, t } from '../lib/i18n';
import { isUnread } from './unread';
import { useRoomList, type RoomSummary } from './rooms';
import { previewText } from '../lib/preview';
import { Words } from '../components/Words';
import { splitPinned } from './pinned';
import { TeamDot } from './TeamDot';
import { compareManual, dropIndex, moveItem, type BotOrderMode } from './botOrder';
import { botInView, roomInView, tilesWithMain } from './teamFilter';
import { useHomeMap, useMainBotId, useTeamView } from '../modules/teams/scope';
import { FolderedList, NewFolderDialog } from '../modules/chat-folders/parts';

/**
 * The bots-first chat list (desktop sidebar and the phone "Chats" screen): pinned bots as big tiles, then every bot
 * and group with its face, last activity time and a one-line preview. A bot's earlier conversations are reachable from
 * the chat header (thread switcher), so the list stays one row per bot.
 * Order: by last activity (default) or the owner's own order (settings.ui.botOrder = 'manual'; bots first in their
 * own order, then the groups by activity). "Volgorde aanpassen" lets you drag the bots (also by touch) or move them
 * with the arrows; the order is stored per bot (POST /agents/order) and is the same on every device.
 *
 * Three streams: a bot's row is your own conversation with it (kind 'chat'). Routine runs, bot-to-bot consultations
 * and channel conversations have their own threads; they never take over the row (its link, preview or unread dot),
 * and are one click away in the chat header (the conversation switcher) and, for routines, under the bell.
 * Teams: with a team chosen in the team switcher only that team's bots and groups are listed (shell/teamFilter.ts);
 * the main bot stands above all teams, always first among the pinned bots.
 * Folders (PARITEIT 4.2, modules/chat-folders): the rows can be filed in folders of the team in view, collapsible; drag
 * a row onto a folder, or use "Verplaats naar map…" in the chat's menu. While searching the list is flat.
 */

type Entry = { type: 'bot'; agent: Agent; thread?: Thread; at: string } | { type: 'room'; room: RoomSummary; at: string };

function useEntries(q: string, mode: BotOrderMode): Entry[] {
  const agents = useApp((s) => s.agents);
  const threads = useApp((s) => s.threads);
  const rooms = useRoomList();
  const team = useTeamView().activeId;
  const home = useHomeMap();
  const mainId = useMainBotId();
  return useMemo(() => {
    const ql = q.trim().toLowerCase();
    const latest = new Map<string, Thread>();
    for (const t of threads) {
      if (t.archived || !t.agent_id || t.room_id || t.kind !== 'chat') continue;
      const cur = latest.get(t.agent_id);
      if (!cur || t.updated_at > cur.updated_at) latest.set(t.agent_id, t);
    }
    const out: Entry[] = [];
    for (const a of agents) {
      if (a.archived) continue;
      if (a.id !== mainId && !botInView(a.id, team, home)) continue;
      if (ql && !(a.name + ' ' + a.role).toLowerCase().includes(ql)) continue;
      const t = latest.get(a.id);
      out.push({ type: 'bot', agent: a, thread: t, at: t?.last ? t.updated_at : t?.updated_at || a.updated_at || a.created_at });
    }
    for (const r of rooms) {
      if (r.archived) continue;
      if (!roomInView(r, team, home)) continue;
      if (ql && !r.name.toLowerCase().includes(ql)) continue;
      out.push({ type: 'room', room: r, at: r.last?.created_at || r.updated_at });
    }
    if (mode === 'manual') {
      const bots = out.filter((e): e is Extract<Entry, { type: 'bot' }> => e.type === 'bot').sort((x, y) => compareManual(x.agent, y.agent));
      const groups = out.filter((e) => e.type === 'room').sort((x, y) => y.at.localeCompare(x.at));
      return [...bots, ...groups];
    }
    return out.sort((x, y) => y.at.localeCompare(x.at));
  }, [agents, threads, rooms, q, mode, team, home, mainId]);
}

function isActiveBot(route: string[], agentId: string, threads: Thread[]) {
  if ((route[0] === 'a' || route[0] === 'agents') && route[1] === agentId) return true;
  if (route[0] === 't') {
    const t = threads.find((x) => x.id === route[1]);
    return !!t && t.agent_id === agentId && !t.room_id && t.kind !== 'room';
  }
  return false;
}

/**
 * The edge around a dot or count on a face takes the colour of the row behind it (a row sets --tb-row when it is
 * hovered or open), so it reads as a cut-out, never as a white ring on a grey row.
 */
const ROW_EDGE_DESK = 'border-[color:var(--tb-row,var(--color-surface))]';
const ROW_EDGE_PHONE = 'border-[color:var(--tb-row,var(--color-canvas))]';
/** Row classes that set --tb-row with the row's own background. */
const rowBg = (active: boolean) => (active ? 'bg-surface-3 [--tb-row:var(--color-surface-3)]' : 'hover:bg-surface-2 hover:[--tb-row:var(--color-surface-2)]');

/** The count on a face (questions that wait, unread): top corner, so the status dot keeps the bottom corner. */
function CountBadge({ n, tone, label, size }: { n: number; tone: 'warn' | 'neutral'; label: string; size: 'desk' | 'phone' }) {
  return (
    <span
      className={cx(
        'absolute -end-1 -top-1 flex h-[19px] min-w-[19px] items-center justify-center rounded-full border-2 px-1 text-[11px] font-bold tabular-nums',
        size === 'phone' ? ROW_EDGE_PHONE : ROW_EDGE_DESK,
        tone === 'warn' ? 'bg-warn-strong text-warn-fg' : 'bg-surface-3 text-fg',
      )}
    >
      <span aria-hidden>{n}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export type DotState = 'working' | 'waiting' | 'idle';

/** The three states of the status dot: working, waits for you, and everything else (calm). */
export function dotState(mood: Mood): DotState {
  return mood === 'working' ? 'working' : mood === 'waiting' ? 'waiting' : 'idle';
}

/**
 * The small status dot on a bot's face (Grok's attention states, as one dot): green while it works (a soft pulse),
 * amber when it waits for you, grey when it is idle. Decorative: the line next to the face says the same in words.
 */
export function StatusDot({ state, size, className }: { state: DotState; size: 'desk' | 'phone'; className?: string }) {
  return (
    <span
      aria-hidden
      data-status={state}
      className={cx(
        'absolute -bottom-0.5 -end-0.5 rounded-full border-2',
        size === 'phone' ? cx('h-3.5 w-3.5', ROW_EDGE_PHONE) : cx('h-3 w-3', ROW_EDGE_DESK),
        state === 'working' ? 'tb-pulse bg-ok' : state === 'waiting' ? 'bg-warn-strong' : 'bg-muted/50',
        className,
      )}
    />
  );
}

/**
 * The desktop row's tooltip in the reader's language: a question waiting for you, what the bot does now, or its last
 * message. A message, a question's line, a role or a description is someone's own words and stays as written.
 */
function deskTip(mood: Mood, text: string, o: { approvals: number; firstApproval: string; live: string; last?: Thread['last']; agent: Agent }): string {
  if (mood === 'waiting') return o.approvals > 1 ? t('{0, plural, one {# vraag wacht op je} other {# vragen wachten op je}}', o.approvals) : o.firstApproval ? ownText('Wacht op jou: {0}', o.firstApproval) : t('Wacht op jou');
  if (mood === 'working') return t(o.live || 'Is aan het werk…');
  if (mood === 'limit') return text;
  if (mood === 'error') return t('Er ging iets mis bij het laatste antwoord');
  const last = o.last;
  if (last?.note?.text) return text;
  if (last) return last.role === 'user' ? ownText('Jij: {0}', previewText(last.content)) : last.role === 'event' ? t(previewText(last.content)) : previewText(last.content);
  return o.agent.role || o.agent.description || t('Nog geen gesprek');
}

function BotRow({ agent, thread, active, size, onNavigate }: { agent: Agent; thread?: Thread; active: boolean; size: 'desk' | 'phone'; onNavigate?(): void }) {
  // Words made here in the reader's language (the desktop row, its tooltip) render again once the dictionary is there.
  useSyncExternalStore(onDictionary, dictionaryLoaded);
  const mood = useAgentMood(agent);
  const limitUntil = useLimitUntil(agent.id);
  const main = useMainBotId() === agent.id;
  const { approvals, firstApproval, live } = useApp(
    useShallow((s) => {
      const mine = s.approvals.filter((a) => a.agent_id === agent.id);
      const run = s.runs.find((r) => r.agent_id === agent.id && r.status === 'running');
      let live = '';
      if (run) {
        const list = s.messages[run.thread_id];
        const m = list ? [...list].reverse().find((x) => x.status === 'streaming' && x.author_id === agent.id) : undefined;
        live = m ? s.status[m.id] || '' : '';
      }
      return { approvals: mine.length, firstApproval: mine[0]?.summary || '', live };
    }),
  );
  const unread = !!thread && isUnread(thread);
  const last = thread?.last;
  let text = '';
  let tone = 'text-muted';
  if (mood === 'waiting') {
    text = approvals > 1 ? `${approvals} vragen wachten op je` : firstApproval ? `Wacht op jou: ${firstApproval}` : 'Wacht op jou';
    tone = 'text-warn';
  } else if (mood === 'working') {
    text = live || 'Is aan het werk…';
    tone = 'text-ok';
  } else if (mood === 'limit') {
    // The daily budget is a limit, not a failure: when the bot works again and where to raise it (B-70).
    text = limitLine(limitUntil);
    tone = 'text-warn';
  } else if (mood === 'error') {
    text = 'Er ging iets mis bij het laatste antwoord';
    tone = 'text-danger';
  } else if (last?.note?.text) {
    text = ownText(last.note.text, ...(last.note.values || []));
    tone = unread ? 'text-fg' : 'text-muted';
  } else if (last) {
    text = (last.role === 'user' ? 'Jij: ' : '') + previewText(last.content);
    tone = unread ? 'text-fg' : 'text-muted';
  } else text = agent.role || agent.description || 'Nog geen gesprek';
  // What the line shows when the bot is idle: a TeamBot note as its line for the owner; a message, the role or the
  // description as written (never translated, also not in part); "Jij: " and a TeamBot event are interface text.
  const idle = mood === 'idle';
  const preview =
    idle && last?.note?.text ? (
      <Words text={last.note.text} values={last.note.values} />
    ) : idle && last && last.role !== 'event' ? (
      <>
        {last.role === 'user' && 'Jij: '}
        <span translate="no">{previewText(last.content)}</span>
      </>
    ) : idle && !last && (agent.role || agent.description) ? (
      <span translate="no">{text}</span>
    ) : (
      text
    );
  const href = thread ? `#/t/${thread.id}` : `#/a/${agent.id}`;
  const signal = <Signal state={dotState(mood)} approvals={approvals} unread={unread} problem={mood === 'error' || mood === 'limit'} />;
  const whose = agent.shared_from ? <Words className="shrink-0 truncate text-xs text-muted" text="van {0}" values={[agent.shared_from.name]} /> : agent.settings?.shared === true ? <span className="shrink-0 truncate text-xs text-muted">{t('gedeeld met het team')}</span> : null;
  if (size === 'desk') {
    // The sidebar: one line per bot (40 px): a face, the name, and at the end one signal. What the bot last said
    // or does now is one hover away (the row's tooltip); the row's own menu shows on hover or keyboard focus.
    const own = !agent.shared_from;
    return (
      // The main bot is the one you talk to most: a larger row (58 px) with a larger face, its role under the name.
      <div className={cx('group/row relative flex items-center transition-colors', main ? 'h-[58px] rounded-2xl' : 'h-10 rounded-xl', rowBg(active))}>
        {/* The tooltip says what the bot last said or does now, someone's words in it as written: the row is marked as a
            whole and TeamBot's few words in it are given in the reader's language here (deskTip, t). */}
        <a href={href} onClick={onNavigate} aria-current={active ? 'page' : undefined} title={deskTip(mood, text, { approvals, firstApproval, live, last, agent })} translate="no" className={cx('flex h-full min-w-0 flex-1 items-center rounded-[inherit] px-2', main ? 'gap-3' : 'gap-2.5')}>
          <LiveBotAvatar bot={agent} size={main ? 42 : 30} />
          {main ? (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[15px] font-semibold text-fg">{agent.name}</span>
              <span className="truncate text-xs text-muted">{t('Hoofdbot')}</span>
            </span>
          ) : (
            <span className={cx('min-w-0 truncate text-sm', active || unread ? 'font-semibold text-fg' : 'font-medium')}>{agent.name}</span>
          )}
          {whose}
          <span className={cx('ms-auto flex shrink-0 items-center', own && 'group-hover/row:invisible group-focus-within/row:invisible')}>{signal}</span>
        </a>
        {own && <RowMenu agent={agent} />}
      </div>
    );
  }
  return (
    <a href={href} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={cx('group flex items-center gap-3 rounded-xl px-2 py-2.5', rowBg(active))}>
      <LiveBotAvatar bot={agent} size={52} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={cx('truncate text-[15.5px]', unread ? 'font-bold' : 'font-semibold')}>{agent.name}</span>
            {whose}
          </span>
          {thread?.last && <span className="shrink-0 text-xs tabular-nums text-muted">{listTime(thread.updated_at)}</span>}
        </span>
        <span className="flex items-center gap-2">
          {/* Chat content is never translated; a TeamBot event as last line ("De gratis limiet van OpenCode is bereikt …") is
              interface text and is (acceptance round 5, C-15: it stood in Dutch in the English chat list). */}
          <span className={cx('block min-w-0 flex-1 truncate text-[14px]', tone, unread && mood === 'idle' && 'font-medium')} title={mood === 'limit' ? text : undefined}>
            {preview}
          </span>
          {signal}
        </span>
      </span>
    </a>
  );
}

/**
 * The ONE signal at the end of a row: how many questions wait for you (amber count), else that the bot works (a green
 * pulse), else that something went wrong or a limit was hit, else that there is something unread (a dot). Calm: nothing.
 * `data-status` always says working / waiting / idle, also when nothing shows.
 */
function Signal({ state, approvals, unread, problem }: { state: DotState; approvals: number; unread: boolean; problem?: boolean }) {
  const dot = 'block h-2 w-2 rounded-full';
  return (
    <span data-status={state} className="flex shrink-0 items-center justify-center">
      {approvals > 0 ? (
        <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warn-strong px-1 text-[11px] font-bold tabular-nums text-warn-fg">
          <span aria-hidden>{approvals}</span>
          <span className="sr-only">{approvals === 1 ? t('1 wacht op jou') : t('{0} wachten op jou', approvals)}</span>
        </span>
      ) : state === 'waiting' ? (
        <span className={cx(dot, 'bg-warn-strong')}>
          <span className="sr-only">{t('wacht op jou')}</span>
        </span>
      ) : state === 'working' ? (
        <span className={cx(dot, 'tb-pulse bg-ok')}>
          <span className="sr-only">{t('bezig')}</span>
        </span>
      ) : problem ? (
        <span className={cx(dot, 'bg-danger')}>
          <span className="sr-only">{t('vraagt aandacht')}</span>
        </span>
      ) : unread ? (
        <span className={cx(dot, 'bg-fg')}>
          <span className="sr-only">{t('ongelezen')}</span>
        </span>
      ) : null}
    </span>
  );
}

/** The menu of a bot's row in the sidebar (shown on hover or focus): its settings, and pin or unpin it. */
function RowMenu({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useDismiss(open, wrap, () => setOpen(false), btn);
  const togglePin = async () => {
    setOpen(false);
    try {
      const a = await api.patch<Agent>(`/agents/${agent.id}`, { pinned: !agent.pinned });
      useApp.setState((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? a : x)) }));
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div ref={wrap} className="absolute end-1 top-1/2 -translate-y-1/2">
      <button
        ref={btn}
        type="button"
        aria-label={t('Menu van {0}', agent.name)}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex size-7 items-center justify-center rounded-md text-muted opacity-0 transition-colors hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover/row:opacity-100 aria-expanded:bg-surface-3 aria-expanded:text-fg aria-expanded:opacity-100"
      >
        <Ellipsis className="size-icon" aria-hidden />
      </button>
      <Pop open={open} origin="top right" onKeyDown={menuKeys} className="absolute end-0 top-full z-30 mt-1 w-52 p-1.5">
        <a className={menuRow} href={`#/agents/${agent.id}`} onClick={() => setOpen(false)}>
          <Settings2 aria-hidden /> Bot-instellingen
        </a>
        <button type="button" className={menuRow} onClick={togglePin}>
          {agent.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />} {agent.pinned ? 'Niet meer vastzetten' : 'Vastzetten'}
        </button>
      </Pop>
    </div>
  );
}

/**
 * "Gedeeld": bots that someone else on this server shares with the team, with his name. You talk to them in your own
 * conversations, which their owner cannot read (server/agent/shared.ts).
 */
function SharedBots({ route, q, size, onNavigate }: { route: string[]; q: string; size: 'desk' | 'phone'; onNavigate?(): void }) {
  const shared = useApp((s) => s.shared);
  const threads = useApp((s) => s.threads);
  const ql = q.trim().toLowerCase();
  const list = shared.filter((a) => !ql || `${a.name} ${a.role} ${a.shared_from?.name || ''}`.toLowerCase().includes(ql));
  if (!list.length) return null;
  const latest = (id: string) => threads.filter((t) => t.agent_id === id && !t.room_id && !t.archived && t.kind === 'chat').sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0];
  return (
    <section aria-label="Gedeeld met het team" data-testid="shared-bots">
      <div className="px-2 pb-1 pt-2 text-xs font-semibold text-muted" data-i18n="label">
        Gedeeld
      </div>
      <ul className="space-y-0.5">
        {list.map((a) => (
          <li key={a.id}>
            <BotRow agent={a} thread={latest(a.id)} active={isActiveBot(route, a.id, threads)} size={size} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RoomRow({ room, active, size, onNavigate }: { room: RoomSummary; active: boolean; size: 'desk' | 'phone'; onNavigate?(): void }) {
  const approvals = useApp((s) => s.approvals.filter((a) => a.thread_id === room.thread_id).length);
  const working = useApp((s) => s.runs.some((r) => r.thread_id === room.thread_id && (r.status === 'running' || r.status === 'queued')));
  const face = size === 'phone' ? 52 : 44;
  let text = room.last ? `${room.last.author_name}: ${previewText(room.last.content)}` : `Groep met ${room.bots.map((b) => b.name).join(', ') || 'nog geen bots'}`;
  let tone = 'text-muted';
  if (approvals) (text = approvals === 1 ? 'Wacht op jou' : `${approvals} vragen wachten op je`), (tone = 'text-warn');
  else if (working) (text = 'Het team is aan het werk…'), (tone = 'text-ok');
  else if (room.status === 'paused') text = 'Gepauzeerd';
  const faces = room.bots.map((b) => ({ id: b.agentId, name: b.name, avatar: b.avatar }));
  const signal = <Signal state={approvals ? 'waiting' : working ? 'working' : 'idle'} approvals={approvals} unread={false} />;
  if (size === 'desk')
    return (
      <a href={`#/t/${room.thread_id}`} onClick={onNavigate} aria-current={active ? 'page' : undefined} title={text} className={cx('flex h-10 items-center gap-2.5 rounded-control px-2 transition-colors', rowBg(active))}>
        <StackedFaces bots={faces} size={30} />
        <span className={cx('min-w-0 truncate text-sm', active ? 'font-semibold text-fg' : 'font-medium')} translate="no">{room.name}</span>
        <span className="ms-auto flex shrink-0 items-center">{signal}</span>
      </a>
    );
  return (
    <a href={`#/t/${room.thread_id}`} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={cx('flex items-center gap-3 rounded-xl px-2 py-2.5', rowBg(active))}>
      <StackedFaces bots={faces} size={face} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15.5px] font-semibold" translate="no">{room.name}</span>
          {room.last && <span className="shrink-0 text-xs tabular-nums text-muted">{listTime(room.last.created_at)}</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className={cx('block min-w-0 flex-1 truncate text-[14px]', tone)} translate={room.last && tone === 'text-muted' ? 'no' : undefined}>
            {text}
          </span>
          {signal}
        </span>
      </span>
    </a>
  );
}

function PinTile({ agent, thread, active, onNavigate, size }: { agent: Agent; thread?: Thread; active: boolean; onNavigate?(): void; size: 'desk' | 'phone' }) {
  const mood = useAgentMood(agent);
  const main = useMainBotId() === agent.id;
  const limitUntil = useLimitUntil(agent.id);
  // A pinned bot is only shown here (not again in the list below), so the tile carries the same badges as a row.
  const approvals = useApp((s) => s.approvals.filter((a) => a.agent_id === agent.id).length);
  const unread = !!thread && isUnread(thread);
  return (
    <a
      href={thread ? `#/t/${thread.id}` : `#/a/${agent.id}`}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      title={mood === 'idle' ? agent.name : mood === 'limit' ? `${agent.name}: ${limitLine(limitUntil)}` : `${agent.name}: ${MOOD_LABELS[mood]}`}
      className={cx('flex min-w-0 flex-1 flex-col items-center gap-1 rounded-2xl px-1 pb-1.5 pt-2.5 text-center', rowBg(active))}
    >
      <span className="relative">
        <LiveBotAvatar bot={agent} size={size === 'phone' ? 54 : 50} />
        {/* One signal on the face: the count that waits for you, else unread, else the status dot. */}
        {approvals > 0 ? <CountBadge n={approvals} tone="warn" size={size} label={approvals === 1 ? '1 wacht op jou' : `${approvals} wachten op jou`} /> : unread ? <CountBadge n={1} tone="neutral" size={size} label="ongelezen" /> : mood !== 'idle' ? <StatusDot state={dotState(mood)} size={size} /> : null}
      </span>
      <span className="flex w-full min-w-0 flex-col items-center">
        <span className="w-full truncate text-[12.5px] font-semibold">{agent.name}</span>
        {/* The status in words under the face (colour or face alone never carries it); a fixed line so nothing jumps. */}
        <span className={cx('h-4 w-full truncate text-[11px] font-medium leading-4', mood === 'idle' ? 'text-muted' : moodTone(mood))}>{mood === 'idle' ? (main ? 'Hoofdbot' : '') : MOOD_LABELS[mood]}</span>
      </span>
    </a>
  );
}

const CLOSED_KEY = 'tb_side_closed';
/** Which sections of the sidebar list are folded (kept on this device). */
function useSection(id: string) {
  const read = () => {
    try {
      return (localStorage.getItem(CLOSED_KEY) || '').split(',').filter(Boolean);
    } catch {
      return [];
    }
  };
  const [closed, setClosed] = useState(() => read().includes(id));
  const toggle = () => {
    const next = !closed;
    setClosed(next);
    try {
      localStorage.setItem(CLOSED_KEY, [...read().filter((x) => x !== id), ...(next ? [id] : [])].join(','));
    } catch {
      /* not kept: the section still folds */
    }
  };
  return { closed, toggle };
}

/** The quiet label of a section of the sidebar list; a click folds or unfolds the section. */
function SectionToggle({ label, closed, onToggle }: { label: string; closed: boolean; onToggle(): void }) {
  return (
    <button type="button" aria-expanded={!closed} onClick={onToggle} className="-ms-1 flex h-7 items-center gap-1 rounded-md px-1 text-xs font-semibold text-muted transition-colors hover:text-fg">
      <ChevronDown className={cx('h-3.5 w-3.5 transition-transform duration-150', closed && '-rotate-90 rtl:rotate-90')} aria-hidden />
      <span data-i18n="label">{label}</span>
    </button>
  );
}

/** One team's bots and groups in the sidebar list: the team's name folds them (kept per team on this device). */
function TeamSection({ id, name, color, children }: { id: string; name: string; color?: string; children: React.ReactNode }) {
  const section = useSection('team:' + (id || 'none'));
  return (
    <li>
      <button type="button" aria-expanded={!section.closed} onClick={section.toggle} className="flex h-7 w-full items-center gap-1.5 rounded-md px-1 text-start text-xs font-semibold text-muted transition-colors hover:text-fg">
        <ChevronDown className={cx('h-3.5 w-3.5 shrink-0 transition-transform duration-150', section.closed && '-rotate-90 rtl:rotate-90')} aria-hidden />
        {color && <TeamDot color={color} size={8} />}
        <span className="min-w-0 truncate" translate={id ? 'no' : undefined}>
          {name}
        </span>
      </button>
      {!section.closed && <ul className="space-y-0.5">{children}</ul>}
    </li>
  );
}

/** "Volgorde": by last activity or your own order, and the way into reordering. */
function OrderMenu({ mode, onMode, onReorder, onNewFolder, size, section }: { mode: BotOrderMode; onMode(m: BotOrderMode): void; onReorder(): void; onNewFolder(): void; size: 'desk' | 'phone'; section?: { closed: boolean; toggle(): void } }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const item = cx(menuRow, 'font-normal');
  return (
    <div className="flex items-center justify-between ps-2" ref={ref}>
      {/* Sidebar: the quiet label of the section folds it; phone: the label says which order the list is in. */}
      {section ? (
        <SectionToggle label="Bots" closed={section.closed} onToggle={section.toggle} />
      ) : (
        <span className="text-xs font-semibold text-muted" data-i18n="label">
          {mode === 'manual' ? 'Eigen volgorde' : 'Recent'}
        </span>
      )}
      <div className="relative">
        <button
          type="button"
          className="flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3 aria-expanded:bg-surface-2 aria-expanded:text-fg coarse:h-11 coarse:px-2.5"
          aria-haspopup="true"
          aria-expanded={open}
          aria-label="Volgorde van de bots"
          onClick={() => setOpen(!open)}
        >
          <ArrowDownUp className="h-3.5 w-3.5" aria-hidden /> {size === 'phone' && 'Volgorde'}
        </button>
        <Pop open={open} origin="top right" onKeyDown={menuKeys} className="absolute end-0 top-full z-30 mt-1 w-60 p-1.5" role="menu">
            {(
              [
                ['recent', 'Laatste activiteit', 'Wie het laatst iets deed, staat bovenaan'],
                ['manual', 'Eigen volgorde', 'Zoals jij de bots neerzet'],
              ] as const
            ).map(([id, label, text]) => (
              <button key={id} type="button" role="menuitemradio" aria-checked={mode === id} className={item} onClick={() => (setOpen(false), onMode(id))}>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">{mode === id && <Check className="h-4 w-4" />}</span>
                <span className="min-w-0">
                  <span className="block font-medium">{label}</span>
                  <span className="block text-xs text-muted">{text}</span>
                </span>
              </button>
            ))}
            <MenuSeparator />
            <button type="button" role="menuitem" className={item} onClick={() => (setOpen(false), onReorder())}>
              <GripVertical aria-hidden /> Volgorde aanpassen…
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => (setOpen(false), onNewFolder())}>
              <FolderPlus aria-hidden /> Nieuwe map…
            </button>
        </Pop>
      </div>
    </div>
  );
}

/**
 * Reorder the bots: drag a row by its handle (mouse or touch), or use the arrows / arrow keys. Every move is saved at
 * once; "Klaar" goes back to the list (in your own order).
 */
function ReorderBots({ size, onDone }: { size: 'desk' | 'phone'; onDone(): void }) {
  const agents = useApp(useShallow((s) => s.agents.filter((a) => !a.archived)));
  const [order, setOrder] = useState<string[]>(() => [...agents].sort(compareManual).map((a) => a.id));
  const [drag, setDrag] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const rows = useRef(new Map<string, HTMLLIElement>());
  const byId = new Map(agents.map((a) => [a.id, a]));
  const list = order.filter((id) => byId.has(id));
  for (const a of agents) if (!list.includes(a.id)) list.push(a.id);
  const save = async (ids: string[]) => {
    try {
      await api.post('/agents/order', { ids });
      useApp.setState((s) => ({ agents: s.agents.map((a) => (ids.includes(a.id) ? { ...a, sort: ids.indexOf(a.id) + 1 } : a)) }));
    } catch (e) {
      toastError(e);
    }
  };
  const moveTo = (id: string, to: number, persist = true) => {
    const from = list.indexOf(id);
    if (from < 0 || to === from || to < 0 || to >= list.length) return list;
    const next = moveItem(list, from, to);
    setOrder(next);
    setSaid(`${byId.get(id)?.name} staat nu op plaats ${to + 1} van ${next.length}`);
    if (persist) void save(next);
    return next;
  };
  const face = size === 'phone' ? 40 : 32;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-2">
        <span className="text-[13px] font-semibold">Sleep de bots in jouw volgorde</span>
        <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} onClick={onDone}>
          Klaar
        </Button>
      </div>
      <p className="px-2 text-xs text-muted">Pak een bot bij het handvat, of gebruik de pijlen. Groepen staan eronder, op activiteit.</p>
      <ol className="space-y-1" aria-label="Volgorde van de bots">
        {list.map((id, i) => {
          const a = byId.get(id)!;
          return (
            <li
              key={id}
              ref={(el) => {
                if (el) rows.current.set(id, el);
                else rows.current.delete(id);
              }}
              className={cx('flex items-center gap-2 rounded-xl border bg-surface px-1.5 py-1', drag === id ? 'border-line-strong shadow-lg' : 'border-line')}
            >
              <button
                type="button"
                className="flex h-9 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg active:cursor-grabbing coarse:h-11 coarse:w-11"
                aria-label={t('{0} verplaatsen (pijltjestoetsen omhoog of omlaag)', a.name)}
                aria-roledescription="versleepbaar"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag(id);
                }}
                onPointerMove={(e) => {
                  if (drag !== id) return;
                  const mids = list.filter((x) => x !== id).map((x) => {
                    const r = rows.current.get(x)?.getBoundingClientRect();
                    return r ? r.top + r.height / 2 : 0;
                  });
                  moveTo(id, dropIndex(e.clientY, mids), false);
                }}
                onPointerUp={() => {
                  if (drag !== id) return;
                  setDrag(null);
                  void save(list);
                }}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    moveTo(id, i + (e.key === 'ArrowUp' ? -1 : 1));
                  }
                }}
              >
                <GripVertical className="h-4 w-4" aria-hidden />
              </button>
              <LiveBotAvatar bot={a} size={face} />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{a.name}</span>
              <Button size="iconSm" variant="ghost" className="coarse:h-11 coarse:w-11" aria-label={t('{0} omhoog', a.name)} disabled={i === 0} onClick={() => moveTo(id, i - 1)}>
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button size="iconSm" variant="ghost" className="coarse:h-11 coarse:w-11" aria-label={t('{0} omlaag', a.name)} disabled={i === list.length - 1} onClick={() => moveTo(id, i + 1)}>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </div>
  );
}

/** A primitive selector: `s.settings.ui || {}` would be a new object on every render (endless re-render). */
const useOrderMode = (): BotOrderMode => useApp((s) => (s.settings?.ui?.botOrder === 'manual' ? 'manual' : 'recent'));

/**
 * The pinned bots (at most 3, the big tiles) and the rest of the list without them. The main bot comes first, above
 * all teams (also when it is not pinned); the other tiles are the pinned bots of the team you look at.
 */
function useSplit(q: string, mode: BotOrderMode) {
  const all = useEntries(q, mode);
  const team = useTeamView().activeId;
  const home = useHomeMap();
  const mainId = useMainBotId();
  const main = useApp((s) => (mainId ? s.agents.find((a) => a.id === mainId && !a.archived) : undefined));
  const pinnedBots = useApp(useShallow((s) => [...s.agents.filter((a) => a.pinned && !a.archived && a.id !== mainId && botInView(a.id, team, home))].sort((a, b) => (mode === 'manual' ? compareManual(a, b) : 0))));
  const pinned = useMemo(() => tilesWithMain(main, pinnedBots), [main, pinnedBots]);
  const { tiles, rest } = splitPinned(all, pinned, q);
  const tileThread = (id: string) => all.find((e): e is Extract<Entry, { type: 'bot' }> => e.type === 'bot' && e.agent.id === id)?.thread;
  return { all, tiles, rest, tileThread };
}

/**
 * The pinned bots as big tiles. The desktop sidebar shows them above the scrolling list, so they are always in view
 * (the main bot will be pinned here); the phone list keeps them at the top of the list itself.
 */
export function PinnedBots({ route, onNavigate, q = '', size = 'desk', className }: { route: string[]; onNavigate?(): void; q?: string; size?: 'desk' | 'phone'; className?: string }) {
  const { tiles, tileThread } = useSplit(q, useOrderMode());
  const threads = useApp((s) => s.threads);
  const section = useSection('pinned');
  if (!tiles.length) return null;
  // The sidebar: the pinned bots are simply the first section of the list, in the same rows as every other bot.
  if (size === 'desk')
    return (
      <div className={className} role="group" aria-label="Vastgezette bots">
        <div className="ps-2">
          <SectionToggle label="Vastgezet" closed={section.closed} onToggle={section.toggle} />
        </div>
        {!section.closed && (
          <ul className="space-y-0.5">
            {tiles.map((a) => (
              <li key={a.id}>
                <BotRow agent={a} thread={tileThread(a.id)} active={isActiveBot(route, a.id, threads)} size="desk" onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  return (
    <div className={cx('flex gap-1.5 px-1', className)} role="group" aria-label="Vastgezette bots">
      {tiles.map((a) => (
        <PinTile key={a.id} agent={a} thread={tileThread(a.id)} active={isActiveBot(route, a.id, threads)} onNavigate={onNavigate} size={size} />
      ))}
    </div>
  );
}

/** `pinned="apart"`: the pinned bots are shown elsewhere (PinnedBots) and left out here. */
export function ChatList({ route, onNavigate, q = '', size = 'desk', pinned = 'inline' }: { route: string[]; onNavigate?(): void; q?: string; size?: 'desk' | 'phone'; pinned?: 'inline' | 'apart' }) {
  const mode = useOrderMode();
  const section = useSection('bots');
  const [reorder, setReorder] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const setMode = (m: BotOrderMode) =>
    api
      .put('/settings', { ui: { ...(useApp.getState().settings?.ui || {}), botOrder: m } })
      .then((st) => useApp.setState({ settings: st }))
      .catch(toastError);
  const { all, tiles, rest: entries } = useSplit(q, mode);
  const threads = useApp((s) => s.threads);
  const roomActive = (r: RoomSummary) => route[0] === 't' && route[1] === r.thread_id;
  const botCount = all.filter((e) => e.type === 'bot').length + tiles.length;
  const hasShared = useApp((s) => s.shared.length > 0);
  const view = useTeamView();
  const teamName = view.active?.name || '';
  const mainId = useMainBotId();
  const home = useHomeMap();
  const rowOf = (e: Entry) =>
    e.type === 'bot' ? (
      <BotRow agent={e.agent} thread={e.thread} active={isActiveBot(route, e.agent.id, threads)} size={size} onNavigate={onNavigate} />
    ) : (
      <RoomRow room={e.room} active={roomActive(e.room)} size={size} onNavigate={onNavigate} />
    );
  // Several teams and none chosen (the sidebar, not while searching): the list in one section per team.
  const byTeam = size === 'desk' && view.multi && !view.activeId && !q;
  const teamOf = (e: Entry) => (e.type === 'bot' ? home.get(e.agent.id) : (e.room as any).workspaceId || e.room.bots.map((b) => home.get(b.agentId)).find(Boolean)) || '';
  const teamGroups = byTeam
    ? [...view.teams.map((x) => ({ id: x.id, name: x.name, color: x.color as string | undefined })), { id: '', name: 'Zonder team', color: undefined }].map((g) => ({ ...g, entries: entries.filter((e) => (view.teams.some((x) => x.id === teamOf(e)) ? teamOf(e) : '') === g.id) })).filter((g) => g.entries.length)
    : [];
  if (reorder && !q)
    return (
      <ReorderBots
        size={size}
        onDone={() => {
          setReorder(false);
          if (mode !== 'manual') void setMode('manual');
        }}
      />
    );
  const folded = size === 'desk' && !q && section.closed;
  return (
    <div className={size === 'desk' ? 'space-y-0.5' : 'space-y-2'}>
      {!q && (botCount > 1 || size === 'desk') && <OrderMenu mode={mode} onMode={setMode} onReorder={() => setReorder(true)} onNewFolder={() => setNewFolder(true)} size={size} section={size === 'desk' ? section : undefined} />}
      <NewFolderDialog open={newFolder} onClose={() => setNewFolder(false)} />
      {pinned === 'inline' && <PinnedBots route={route} onNavigate={onNavigate} q={q} size={size} />}
      {folded ? null : (
      <>
      {byTeam ? (
        // "Alle teams" in the sidebar: one foldable section per team, so a long list stays in hand. (Folders belong to
        // one team: they show when that team is chosen in the team switcher.)
        <ul aria-label="Bots en groepen" className="space-y-1">
          {teamGroups.map((g) => (
            <TeamSection key={g.id} id={g.id} name={g.name} color={g.color}>
              {g.entries.map((e) => (
                <li key={e.type === 'bot' ? e.agent.id : e.room.id}>{rowOf(e)}</li>
              ))}
            </TeamSection>
          ))}
        </ul>
      ) : (
      <FolderedList
        size={size}
        flat={!!q}
        rows={entries.map((e) => (e.type === 'bot' ? { kind: 'agent' as const, id: e.agent.id, node: rowOf(e) } : { kind: 'room' as const, id: e.room.id, node: rowOf(e) }))}
      />
      )}
      <SharedBots route={route} q={q} size={size} onNavigate={onNavigate} />
      {q && entries.length === 0 && <p className="px-3 py-2 text-sm text-muted">Geen bot of groep met “{q}”. Druk op Enter om in alle gesprekken te zoeken.</p>}
      {!q && entries.length === 0 && !tiles.length && !hasShared && !teamName && <p className="px-3 py-2 text-[13px] leading-relaxed text-muted">Nog geen bots. Je bots en groepen verschijnen hier, met wat ze het laatst zeiden.</p>}
      {!q && teamName && !all.some((e) => e.type === 'room' || e.agent.id !== mainId) && (
        <p className="px-3 py-2 text-[13px] leading-relaxed text-muted">{t('Nog geen bots in {0}. Een nieuwe bot komt in dit team.', teamName)}</p>
      )}
      </>
      )}
    </div>
  );
}
