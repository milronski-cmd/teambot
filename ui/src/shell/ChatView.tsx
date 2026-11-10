import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ChevronDown, CornerDownRight, ListEnd, MessageSquarePlus, Monitor, PanelRight, Play, RotateCcw, Search, Square } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { api, authUrl, on } from '../lib/api';
import { agentById, useApp } from '../lib/store';
import { navigate } from '../lib/router';
import { useIsDesktop } from '../lib/media';
import { limitLine, moodText, moodTone, useAgentMood, useLimitUntil } from '../lib/mood';
import type { Agent, Message, ProviderView, Run, Thread } from '../lib/types';
import { uiModules } from '../modules';
import { BotAvatar, LiveBotAvatar, StackedFaces } from '../components/BotFace';
import { askConfirm, Button, EmptyState, Input, Modal, Spinner, cx, listTime, toast, toastError, toastProgress } from '../components/ui';
import { MenuLabel, Pop, menuKeys, menuRow, useDismiss } from '../components/Menu';
import { ChatMenu, openChatMenuFor } from './ChatMenu';
import { useRunning } from '../modules/browser/BrowserDock';
import { MessageItem } from './Message';
import { Composer } from './Composer';
import { FindInChat } from './FindInChat';
import type { ComposerCommand } from './SlashMenu';
import { ApprovalCard, QuestionCard } from './ApprovalCard';
import { Inspector } from './Inspector';
import { QueueBar, useMessageQueue } from './QueueBar';
import { markSeen } from './unread';
import { useRoomList } from './rooms';
import { t, translate, uiLocale } from '../lib/i18n';
import { firstTasks } from './firstTasks';
import { ChatUsage } from '../modules/usage/UsagePopover';
import { BotDeleteDialog } from './BotDeleteDialog';
import { HistoryDeleteDialog, useCanDeleteHistory } from './HistoryDeleteDialog';
import { CHAT_MIN, PagePanel, PagePanelButton, usePagesDocked } from './PagePanel';
import { BUSY_POLICIES } from './busyPolicy';
import { stripKindPrefix, threadSubtitle } from '../lib/threadTitle';
import { useAdvanced } from './advanced';
import { SaveAsSkillModal } from '../modules/skills/SaveAsSkill';
import { MoveToFolderDialog } from '../modules/chat-folders/parts';
import { useHomeMap, useMainBotId } from '../modules/teams/scope';

const kindTitle: Record<Thread['kind'], string> = { chat: 'Chat', room: 'Groep', routine: 'Routine', delegation: 'Subtaak', channel: 'Kanaal' };

/** #/a/<agentId>: open the bot's most recent 1:1 chat, or start one. */
export function AgentChatRoute({ agentId }: { agentId: string }) {
  const threads = useApp((s) => s.threads);
  const [err, setErr] = useState('');
  useEffect(() => {
    const existing = threads.find((t) => t.agent_id === agentId && t.kind === 'chat' && !t.room_id && !t.archived);
    if (existing) {
      history.replaceState(null, '', `#/t/${existing.id}`);
      dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    api
      .post<Thread>('/threads', { agentId })
      .then((t) => {
        useApp.setState((s) => ({ threads: [t, ...s.threads.filter((x) => x.id !== t.id)] }));
        history.replaceState(null, '', `#/t/${t.id}`);
        dispatchEvent(new HashChangeEvent('hashchange'));
      })
      .catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  if (err) return <EmptyState title="Kan gesprek niet openen">{err}</EmptyState>;
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner />
    </div>
  );
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Vandaag';
  if (d.toDateString() === y.toDateString()) return 'Gisteren';
  return d.toLocaleDateString(uiLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/**
 * The conversations of one bot in separate streams, so automatic work never floods your own chat: your conversations,
 * conversations via a channel, consultations between bots and automatic (routine) runs. The bot's row in the chat
 * list always opens your own conversation (ChatList).
 */
const STREAMS: { kind: Thread['kind']; title: string }[] = [
  { kind: 'chat', title: 'Jouw gesprekken' },
  { kind: 'channel', title: 'Via kanalen' },
  { kind: 'delegation', title: 'Overleg tussen bots' },
  { kind: 'routine', title: 'Automatische runs' },
];

/** The bot's conversations (chat, routines, channels, subtasks) — replaces the old "Recent" list in the sidebar. */
function ThreadSwitcher({ agent, thread, onNew }: { agent: Agent; thread: Thread; onNew(): void }) {
  const [open, setOpen] = useState(false);
  const threads = useApp(useShallow((s) => s.threads.filter((t) => t.agent_id === agent.id && !t.room_id && t.kind !== 'room' && !t.archived)));
  const list = [...threads].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const streams = STREAMS.map((s) => ({ ...s, list: list.filter((t) => t.kind === s.kind) })).filter((s) => s.list.length);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useDismiss(open, ref, () => setOpen(false), btn);
  // The list hangs from the bot's name, which starts a third into a phone screen: never wider than the room to its right.
  const [room, setRoom] = useState<number | undefined>(undefined);
  return (
    <div className="relative" ref={ref}>
      <button
        ref={btn}
        className="flex h-7 max-w-full items-center gap-1 rounded-control px-1 text-[15px] font-bold tracking-tight transition-colors hover:bg-surface-2 aria-expanded:bg-surface-2 coarse:-my-2 coarse:h-11 coarse:min-w-11"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Gesprekken met ${agent.name} (${list.length})`}
        onClick={() => {
          if (!open && ref.current) setRoom(Math.max(200, document.documentElement.clientWidth - ref.current.getBoundingClientRect().left - 8));
          setOpen(!open);
        }}
      >
        <span className="truncate">{agent.name}</span>
        <ChevronDown className={cx('size-icon shrink-0 text-muted transition-transform duration-150', open && 'rotate-180')} />
      </button>
      <Pop open={open} origin="top left" onKeyDown={menuKeys} style={{ maxWidth: room }} className="absolute start-0 top-full z-30 mt-1 w-[min(340px,86vw)] p-1.5">
        <button className={cx(menuRow, 'font-semibold')} onClick={() => (setOpen(false), onNew())}>
          <MessageSquarePlus aria-hidden />
          <span className="min-w-0 truncate">Nieuw gesprek met {agent.name}</span>
        </button>
        <div className="scroll-thin max-h-[50vh] overflow-y-auto">
          {streams.map((s) => (
            <section key={s.kind} aria-label={s.title}>
              <MenuLabel>{s.title}</MenuLabel>
              {s.list.map((t) => (
                <a
                  key={t.id}
                  href={`#/t/${t.id}`}
                  onClick={() => setOpen(false)}
                  aria-current={t.id === thread.id ? 'page' : undefined}
                  className={cx('block rounded-control px-2.5 py-2 text-sm outline-none transition-colors focus-visible:bg-surface-2', t.id === thread.id ? 'bg-surface-3' : 'hover:bg-surface-2')}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-semibold">{t.kind === 'chat' ? t.title || 'Gesprek' : stripKindPrefix(t.title, kindTitle[t.kind]) || kindTitle[t.kind]}</span>
                    <span className="shrink-0 text-xs text-muted">{listTime(t.updated_at)}</span>
                  </span>
                  <span className="block truncate text-xs text-muted" translate={t.last ? 'no' : undefined}>
                    {t.last ? `${t.last.role === 'user' ? 'Jij: ' : ''}${t.last.content}` : 'Nog leeg'}
                  </span>
                </a>
              ))}
            </section>
          ))}
        </div>
      </Pop>
    </div>
  );
}

/** Greeting for an empty chat. A bot made on first run asks what you want help with (MausBot-style choices). */
function Intro({ agent, onSend }: { agent: Agent; onSend(text: string): Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  // The first-run question only belongs in the bot's very first conversation, not in every new empty chat.
  const talkedBefore = useApp((s) => s.threads.some((t) => t.agent_id === agent.id && !!t.last));
  const welcome = agent.settings?.intro === 'welcome' && !talkedBefore;
  const answer = async (t: string) => {
    setBusy(t);
    try {
      await onSend(welcome ? `Ik wil vooral hulp bij: ${t}` : t);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col items-center px-4 pb-4 pt-10 sm:px-6">
      <BotAvatar bot={agent} size={84} />
      <div className="mt-3 text-lg font-bold tracking-tight">{agent.name}</div>
      {agent.role && <div className="text-sm text-muted">{agent.role}</div>}
      <div className="mt-8 flex w-full max-w-[640px] flex-col items-start gap-3">
        <div className="flex gap-2.5">
          <BotAvatar bot={agent} size={30} className="mt-0.5" />
          <div className="rounded-bubble rounded-ss-md border border-line bg-surface px-4 py-2.5 text-[14.5px] leading-relaxed">
            {welcome ? `Hoi! Ik ben ${agent.name}, je eerste bot. Leuk je te ontmoeten.` : `Hoi, ik ben ${agent.name}. ${agent.description || 'Waarmee kan ik je helpen?'}`}
          </div>
        </div>
        {welcome && (
          <div className="w-full ps-10">
            <QuestionCard
              label="Eerste vraag van je bot"
              title="Waar wil je vooral hulp bij?"
              subtitle="Kies wat er het dichtst bij komt; we kunnen altijd uitbreiden."
              options={['Werk en projecten', 'Schrijven en onderzoek', 'Dingen regelen', 'Een beetje van alles']}
              busy={busy}
              onAnswer={answer}
            />
          </div>
        )}
        {/* A brand-new bot (no conversation yet): three first tasks that fit its role; a tap sends the text. */}
        {!welcome && !talkedBefore && (
          <div className="w-full ps-10" role="group" aria-label="Voorstellen voor een eerste opdracht">
            <div className="mb-2 text-[13px] text-muted">Je kunt bijvoorbeeld beginnen met:</div>
            <div className="flex flex-wrap gap-2">
              {firstTasks(agent).map((task) => {
                const text = translate(task);
                return (
                  <button
                    key={task}
                    type="button"
                    disabled={!!busy}
                    onClick={() => void answer(text)}
                    className="min-h-9 rounded-full border border-line bg-surface px-3.5 py-1.5 text-start text-[13.5px] font-medium transition-colors hover:bg-surface-2 active:bg-surface-3 disabled:opacity-60 coarse:min-h-11"
                  >
                    {text}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const INSPECTOR_KEY = 'tb_inspector';

// The bot editor imports this from here (the chat menu itself lives in ./ChatMenu).
export { openChatMenuFor };

export function ChatView({ threadId }: { threadId: string }) {
  const thread = useApp((s) => s.threads.find((t) => t.id === threadId));
  const messages = useApp((s) => s.messages[threadId]);
  const approvals = useApp(useShallow((s) => s.approvals.filter((a) => a.thread_id === threadId)));
  // A question card is open: what you type is the answer (server/agent/queue.ts answerOpenQuestion).
  const asking = approvals.some((a) => a.kind === 'question' && a.status === 'pending');
  const runs = useApp(useShallow((s) => s.runs.filter((r) => r.thread_id === threadId)));
  const providers = useApp((s) => s.providers);
  const desktop = useIsDesktop();
  const advanced = useAdvanced();
  // The bot's computer has a button in the header only while the bot uses a browser or the screen.
  const computerInUse = useRunning((s) => !!(thread?.agent_id && s[thread.agent_id]));
  const rooms = useRoomList();
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  /** "Hervatten": the last task was cut off by a restart, or the owner stopped it himself. */
  const [canResume, setCanResume] = useState<'interrupted' | 'stopped' | null>(null);
  const [delBot, setDelBot] = useState(false);
  const [delHistory, setDelHistory] = useState(false);
  const [saveSkill, setSaveSkill] = useState(false);
  const [toFolder, setToFolder] = useState(false);
  const home = useHomeMap();
  const mainId = useMainBotId();
  const canDeleteHistory = useCanDeleteHistory();
  const meId = useApp((s) => s.me?.id);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [forward, setForward] = useState<Message | null>(null);
  const compacting = useRef(false);
  const [rename, setRename] = useState<string | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  // Ctrl+F: find in this conversation (also from the menu and the "/" menu on a phone).
  const [finding, setFinding] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<string | undefined>(undefined);
  // The side panel never opens on an empty conversation by itself: see the effect below.
  const [inspector, setInspector] = useState(false);
  /** The owner opened or closed the panel himself: that wish is kept for the next conversation with files. */
  const showPanel = (v: boolean) => {
    setInspector(v);
    try {
      localStorage.setItem(INSPECTOR_KEY, v ? '1' : '0');
    } catch {
      /* not kept */
    }
  };
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastTop = useRef(0);
  const [showJump, setShowJump] = useState(false);
  // While the bot works, new messages wait in a visible, editable queue (or steer the running turn).
  const queue = useMessageQueue(threadId);
  // A page panel docked next to the chat: the chat keeps enough width for its header (the panel gives way).
  const pagesDocked = usePagesDocked(threadId, !inspector);
  const agentForMood = agentById(thread?.agent_id);
  const mood = useAgentMood(thread?.kind === 'room' ? null : agentForMood);
  const limitUntil = useLimitUntil(thread?.kind === 'room' ? null : agentForMood?.id);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setMissing(false);
    setReplyTo(null);
    useApp
      .getState()
      .loadThread(threadId)
      .then((r) => {
        if (!alive) return;
        setLoading(false);
        if (!r) return setMissing(true);
        setCanResume(r.canResume ? r.resumeReason || 'interrupted' : null);
        setHasOlder((useApp.getState().messages[threadId]?.length || 0) >= 300);
        atBottom.current = true;
      });
    return () => {
      alive = false;
    };
  }, [threadId]);

  useEffect(() => {
    if (thread) markSeen(thread.id, thread.updated_at);
  }, [thread?.updated_at, thread?.id]);

  // Deleted while open (another device, "Geschiedenis wissen"): say so instead of a spinner. Emptied (a group's own
  // conversation after "Geschiedenis wissen"): show it empty.
  useEffect(() => {
    const a = on('thread.deleted', (d: { id: string }) => d?.id === threadId && setMissing(true));
    const b = on('thread.cleared', (d: { id: string }) => {
      if (d?.id !== threadId) return;
      setCanResume(null);
      setHasOlder(false);
    });
    return () => (a(), b());
  }, [threadId]);

  // A stop from the stop button (or "Alles stoppen") offers "Hervatten" right away; any new run takes it away again.
  useEffect(
    () =>
      on('run.updated', (r: Run & { meta?: Record<string, any> }) => {
        if (r?.thread_id !== threadId) return;
        if (r.status === 'queued' || r.status === 'running' || r.status === 'waiting') setCanResume(null);
        else if (r.status === 'cancelled' && (r.error === 'Gestopt door gebruiker' || r.error === 'Alles gestopt') && !r.meta?.steerInterrupt) {
          // A group has its own stop and continue; "Hervatten" after a stop is for a chat with one bot.
          const t = useApp.getState().threads.find((x) => x.id === threadId);
          if (t && t.kind !== 'room' && !t.room_id) setCanResume('stopped');
        }
        else if (r.status === 'interrupted') setCanResume('interrupted');
      }),
    [threadId],
  );

  useEffect(() => {
    setFinding(false);
  }, [threadId]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
      // Inside a dialog (a file preview) the browser's own find stays.
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      setFinding(true);
      (document.querySelector('[data-find-input]') as HTMLInputElement | null)?.select();
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);

  // Opening a conversation: the panel shows by itself only when the owner left it open last time AND this conversation
  // has something to show in it (a file sent along, or files the bot made or changed).
  useEffect(() => {
    if (loading) return;
    let wanted = false;
    try {
      wanted = localStorage.getItem(INSPECTOR_KEY) === '1';
    } catch {
      /* closed */
    }
    const list = useApp.getState().messages[threadId] || [];
    setInspector(wanted && desktop && list.some((m) => !!m.parts?.attachments?.length || !!m.parts?.activity?.some((a) => a.kind === 'files') || !!m.parts?.toolCalls?.some((c) => /^(fs_|file_|write|edit)/.test(c.name))));
  }, [loading, threadId, desktop]);

  // Keep pinned to the bottom while new content streams in, unless the user scrolled up. `loading` is a dependency:
  // the messages arrive while the spinner is still shown (no scroller yet), so without it a long conversation opened
  // at the very top instead of at the latest message.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, approvals.length, loading]);
  // Also when the chat area or its content changes size without a new message: the input growing while you type a
  // long message, "Nieuw bericht terwijl … werkt" appearing while the bot answers, an image that loads. Practice test
  // 0.4.4 (phone): after sending a long message the answer streamed on below the screen, behind "Naar nieuwste".
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [loading, threadId]);

  // Tool results by call id. `messages` is a new array on every streamed chunk; the Map stays the same object as long
  // as no tool result changed, so a chunk re-renders only the message it belongs to (MessageItem is memoized).
  const lastResults = useRef(new Map<string, Message>());
  const results = useMemo(() => {
    const next = new Map<string, Message>();
    for (const x of messages || []) if (x.role === 'tool' && x.parts.toolResult) next.set(x.parts.toolResult.toolCallId, x);
    const prev = lastResults.current;
    if (next.size === prev.size && [...next].every(([id, x]) => prev.get(id) === x)) return prev;
    lastResults.current = next;
    return next;
  }, [messages]);

  if (missing) {
    return (
      <EmptyState title="Gesprek niet gevonden" action={<Button onClick={() => navigate('/')}>Naar start</Button>}>
        Het gesprek bestaat niet meer of je hebt geen toegang.
      </EmptyState>
    );
  }
  if (loading || !thread) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const agent = agentById(thread.agent_id);
  const room = thread.kind === 'room' ? rooms.find((r) => r.thread_id === thread.id) : undefined;
  // While a reserve engine answers (the main one hit its limit or could not start), the header shows the reserve.
  const reserve = runs.find((r) => r.agent_id === agent?.id && r.meta?.engine)?.meta?.engine as { provider_id: string; name: string; model: string } | undefined;
  const reserveProvider = reserve ? providers.find((p) => p.id === reserve.provider_id) : undefined;
  const provider = reserveProvider || providers.find((p) => p.id === agent?.provider_id);
  const busy = runs.length > 0;
  const headerActions = uiModules.flatMap((m) => m.chatHeaderActions || []);
  const hasComputerTab = uiModules.some((m) => m.id === 'browser' && m.inspectorTabs?.some((t) => t.id === 'computer'));
  const title = thread.kind === 'chat' ? agent?.name || thread.title || 'Gesprek' : thread.title || room?.name || agent?.name || kindTitle[thread.kind];
  const noProvider = agent && !agent.provider_id && !agent.shared_from ? 'Deze bot heeft nog geen AI-provider. Kies er een in de bot-instellingen.' : null;
  const status = thread.kind === 'room' ? (busy ? 'aan het werk' : room ? t('Groep · {0, plural, one {# bot} other {# bots}}', room.bots.length) : 'Groep') : reserve && mood === 'working' ? `werkt nu via de reserve-engine ${reserve.name}` : mood === 'limit' ? limitLine(limitUntil) : moodText(mood, agent?.role || 'klaar voor een opdracht');
  const statusTone = thread.kind === 'room' ? (busy ? 'text-ok' : 'text-muted') : moodTone(mood);
  // A bot someone else shares with the team: say whose it is, and that this conversation is yours alone.
  const sharedBy = agent?.shared_from?.name;
  // "Verplaats naar map…" (PARITEIT 4.2): this chat's row in the list, a bot of your own or a group of your own. A pinned
  // bot (and the main bot) stands above the list as a tile, so it has no row to file.
  const roomTeam: string = room ? (room as any).workspaceId || '' : '';
  const folderItem =
    room && thread.user_id === meId
      ? { kind: 'room' as const, id: room.id, name: room.name, teams: roomTeam ? [roomTeam] : [...new Set(room.bots.map((b) => home.get(b.agentId)).filter((x): x is string => !!x))] }
      : agent && thread.kind !== 'room' && !sharedBy && !agent.pinned && agent.id !== mainId
        ? { kind: 'agent' as const, id: agent.id, name: agent.name, teams: home.get(agent.id) ? [home.get(agent.id)!] : [] }
        : null;
  const sub = sharedBy
    ? `gedeeld door ${sharedBy} · alleen jij ziet dit gesprek`
    : thread.kind !== 'chat' && thread.kind !== 'room' ? threadSubtitle(kindTitle[thread.kind], thread.title) : thread.kind === 'chat' && thread.title ? thread.title : '';

  const send = async (content: string, opts: { attachments: string[]; voice?: boolean; replyTo?: string | null }) => {
    atBottom.current = true;
    await queue.send(content, { attachments: opts.attachments, voice: opts.voice, replyTo: opts.replyTo });
    setCanResume(null);
  };
  const stop = async () => {
    try {
      await api.post(`/threads/${threadId}/stop`);
    } catch (e) {
      toastError(e);
    }
  };
  // Commands in the "/" menu of the composer (each does exactly what the menu or a button here does).
  const chatCommands: ComposerCommand[] = [
    ...(agent && thread.kind !== 'room' ? [{ id: 'nieuw', label: 'Nieuw gesprek', description: `Een nieuw gesprek met ${agent.name}`, keywords: ['nieuw', 'leeg'], icon: <MessageSquarePlus className="h-4 w-4" />, run: () => void newChat() }] : []),
    { id: 'zoek', label: 'Zoeken in dit gesprek', description: 'Treffers markeren en erheen springen (Ctrl+F)', keywords: ['zoek', 'vind', 'find'], icon: <Search className="h-4 w-4" />, run: () => setFinding(true) },
    ...(busy ? [{ id: 'stop', label: 'Stoppen', description: 'De bot stopt met wat hij nu doet', keywords: ['stop', 'halt'], icon: <Square className="h-4 w-4" />, run: () => void stop() }] : []),
  ];
  const patchThread = async (p: Partial<Thread>) => {
    try {
      const t = await api.patch<Thread>(`/threads/${threadId}`, p);
      useApp.setState((s) => ({ threads: s.threads.map((x) => (x.id === t.id ? { ...x, ...t } : x)) }));
    } catch (e) {
      toastError(e);
    }
  };
  const togglePinBot = async () => {
    if (!agent) return;
    try {
      const a = await api.patch<Agent>(`/agents/${agent.id}`, { pinned: !agent.pinned });
      useApp.setState((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? a : x)) }));
      toast(a.pinned ? `${a.name} staat bovenaan in je lijst` : `${a.name} staat niet meer bovenaan`, 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  const duplicateBot = async () => {
    if (!agent) return;
    try {
      const a = await api.post<Agent>(`/agents/${agent.id}/duplicate`);
      useApp.setState((s) => ({ agents: [...s.agents.filter((x) => x.id !== a.id), a] }));
      toast(`Kopie gemaakt: ${a.name}. Gesprekken en geheugen gaan niet mee.`, 'ok');
      navigate(`/agents/${a.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  const archiveBot = async () => {
    if (!agent) return;
    const to = !agent.archived;
    if (to && !(await askConfirm(`${agent.name} archiveren? De bot doet niets meer tot je hem terughaalt (Alle bots › Archief).`, { ok: 'Archiveren' }))) return;
    try {
      const a = await api.patch<Agent>(`/agents/${agent.id}`, { archived: to });
      useApp.setState((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? a : x)) }));
      toast(to ? `${a.name} staat in het archief` : `${a.name} is terug uit het archief`, 'ok');
      if (to) navigate('/');
    } catch (e) {
      toastError(e);
    }
  };
  const setBusyPolicy = async (policy: Agent['busy_policy']) => {
    // Read the bot from the store now: `agent` above is a snapshot of this render.
    const cur = agent && useApp.getState().agents.find((x) => x.id === agent.id);
    if (!cur || cur.busy_policy === policy) return;
    try {
      const a = await api.patch<Agent>(`/agents/${cur.id}`, { busy_policy: policy });
      useApp.setState((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? a : x)) }));
    } catch (e) {
      toastError(e);
    }
  };
  const newChat = async () => {
    if (!agent) return;
    try {
      const t = await api.post<Thread>('/threads', { agentId: agent.id });
      useApp.setState((s) => ({ threads: [t, ...s.threads] }));
      navigate(`/t/${t.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  const loadOlder = async () => {
    const first = messages?.[0];
    if (!first) return;
    setOlderBusy(true);
    try {
      const r = await api.get<{ messages: Message[] }>(`/threads/${threadId}?before=${first.seq}&limit=200`);
      const el = scroller.current;
      const prevH = el?.scrollHeight || 0;
      useApp.setState((s) => ({ messages: { ...s.messages, [threadId]: [...r.messages, ...(s.messages[threadId] || [])] } }));
      setHasOlder(r.messages.length >= 200);
      requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - prevH));
    } catch (e) {
      toastError(e);
    } finally {
      setOlderBusy(false);
    }
  };
  const compactThread = async () => {
    // One run at a time, and one message: "wordt samengevat…" becomes the outcome (acceptance round 4 showed three at
    // once). A CLI engine (Claude Code /compact, Codex) can take a minute.
    if (compacting.current) return;
    compacting.current = true;
    const p = toastProgress('Gesprek wordt samengevat…');
    try {
      const r = await api.post<{ compacted: boolean; reason?: string }>(`/threads/${threadId}/compact`);
      p.done(r.compacted ? 'Oudere deel samengevat' : `Niet samengevat: ${r.reason}`, r.compacted ? 'ok' : 'neutral');
    } catch (e: any) {
      p.done(e?.message || String(e), 'danger');
    } finally {
      compacting.current = false;
    }
  };
  const deleteThread = async () => {
    if (!(await askConfirm('Dit gesprek en alle berichten definitief verwijderen? Bestanden in de werkmap van de bot blijven bestaan.', { ok: 'Verwijderen', danger: true }))) return;
    try {
      await api.del(`/threads/${threadId}`);
      useApp.setState((s) => ({ threads: s.threads.filter((t) => t.id !== threadId) }));
      navigate('/');
    } catch (e) {
      toastError(e);
    }
  };
  const openInspector = (tab?: string) => {
    setInspectorTab(tab);
    showPanel(true);
  };

  const list = messages || [];
  let lastDay = '';
  let prev: Message | null = null;
  const multiAuthor = thread.kind === 'room' || list.some((m) => m.author_type === 'agent' && m.author_id && m.author_id !== thread.agent_id);

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col" style={pagesDocked ? { minWidth: CHAT_MIN } : undefined}>
        <header className="safe-top shrink-0 border-b border-line bg-canvas">
          <div className="@container flex h-[60px] items-center gap-2 px-2 desk:px-4">
            {!desktop && (
              <a href="#/" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg transition-colors hover:bg-surface-2 active:bg-surface-3" aria-label="Terug naar chats">
                <ArrowLeft className="h-5 w-5" />
              </a>
            )}
            {room ? (
              <StackedFaces bots={room.bots.map((b) => ({ id: b.agentId, name: b.name, avatar: b.avatar }))} size={36} />
            ) : agent ? (
              <LiveBotAvatar bot={agent} size={36} />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-3 text-xs font-bold">{kindTitle[thread.kind][0]}</div>
            )}
            <div className="min-w-0 flex-1 desk:min-w-[7rem]">
              {agent && thread.kind !== 'room' ? (
                <ThreadSwitcher agent={agent} thread={thread} onNew={newChat} />
              ) : (
                <h1 className="truncate px-1 text-[15px] font-bold tracking-tight">{title}</h1>
              )}
              {/* Touch: the name above reaches over this line (44 px to tap without moving the text), so it lets taps through. */}
              <div className="flex min-w-0 items-center gap-1.5 px-1 text-[12.5px] coarse:pointer-events-none">
                {(mood !== 'idle' || (thread.kind === 'room' && busy)) && <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full bg-current', statusTone, mood === 'working' && 'tb-pulse')} aria-hidden />}
                <span className={cx('truncate', statusTone)} title={mood === 'limit' ? status : undefined}>
                  {status}
                </span>
                {sub && (
                  <span className="hidden truncate text-muted sm:inline">
                    <span aria-hidden>· </span>
                    {/* The conversation's own title is the user's words: never translated ("Lees prijzen.txt …" became
                        "Read prijzen.txt in de extra map …" in English; acceptance round 5, C-15). */}
                    <span translate={!sharedBy && thread.kind === 'chat' ? 'no' : undefined}>{sub}</span>
                  </span>
                )}
              </div>
              {agent && thread.kind !== 'room' && <h1 className="sr-only">{title}</h1>}
            </div>
            {/* One row of the same quiet icon buttons (36 px, 44 on touch), each with its name as a tooltip. */}
            <div className="flex shrink-0 items-center gap-0.5">
              {headerActions.map((A, i) => (
                <A key={i} threadId={threadId} agentId={thread.agent_id} />
              ))}
              <PagePanelButton threadId={threadId} />
              {desktop && hasComputerTab && (advanced || computerInUse) && agent && thread.kind !== 'room' && !agent.shared_from && (
                <Button variant="ghost" size="icon" className="tb-tip" aria-label="Computer van de bot" onClick={() => openInspector('browser:computer')}>
                  <Monitor className="size-icon" />
                </Button>
              )}
              {desktop && (
                <Button variant="ghost" size="icon" className="tb-tip tb-tip-end aria-pressed:bg-surface-3 aria-pressed:text-fg" aria-label="Zijpaneel" aria-pressed={inspector} onClick={() => (inspector ? showPanel(false) : openInspector())}>
                  <PanelRight className="size-icon" />
                </Button>
              )}
              <ChatMenu
                thread={thread}
                agent={agent}
                desktop={desktop}
                advanced={advanced}
                shared={!!sharedBy}
                canFile={!!folderItem}
                canDeleteHistory={canDeleteHistory}
                canDeleteRoomHistory={thread.kind === 'room' && !!thread.room_id && thread.user_id === meId && canDeleteHistory}
                act={{
                  newChat,
                  find: () => setFinding(true),
                  openPanel: () => openInspector(),
                  rename: () => setRename(thread.title || ''),
                  togglePin: () => void patchThread({ pinned: !thread.pinned }),
                  compact: () => void compactThread(),
                  saveAsSkill: () => setSaveSkill(true),
                  moveToFolder: () => setToFolder(true),
                  toggleArchive: () => void patchThread({ archived: !thread.archived }),
                  deleteThread: () => void deleteThread(),
                  togglePinBot: () => void togglePinBot(),
                  duplicateBot: () => void duplicateBot(),
                  archiveBot: () => void archiveBot(),
                  deleteHistory: () => setDelHistory(true),
                  deleteBot: () => setDelBot(true),
                }}
              />
            </div>
          </div>
        </header>

        {finding && <FindInChat root={scroller} version={messages} hasOlder={hasOlder} onLoadOlder={loadOlder} onClose={() => setFinding(false)} />}

        <div
          ref={scroller}
          className="scroll-thin relative min-h-0 flex-1 overflow-y-auto pb-6"
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            // Only scrolling up yourself stops following the newest message; a shift the page makes itself (the chat
            // area got smaller, content moved) does not.
            const up = el.scrollTop < lastTop.current - 1;
            lastTop.current = el.scrollTop;
            if (near) atBottom.current = true;
            else if (up) atBottom.current = false;
            setShowJump(!near && !atBottom.current);
          }}
        >
          {hasOlder && (
            <div className="flex justify-center py-3">
              <Button size="sm" loading={olderBusy} onClick={loadOlder}>
                Oudere berichten laden
              </Button>
            </div>
          )}
          {list.length === 0 && approvals.length === 0 && (agent && thread.kind === 'chat' ? <Intro agent={agent} onSend={(t) => send(t, { attachments: [] })} /> : <EmptyState title="Nog geen berichten">Stel een vraag of geef een opdracht.</EmptyState>)}
          <div className="mx-auto max-w-[860px]">
            {list.map((m) => {
              const day = m.created_at.slice(0, 10);
              const divider = day !== lastDay;
              lastDay = day;
              const compact =
                !divider && !!prev && prev.role !== 'event' && prev.role !== 'system' && prev.author_id === m.author_id && prev.author_type === m.author_type && Date.parse(m.created_at) - Date.parse(prev.created_at) < 180_000;
              if (m.role !== 'tool') prev = m;
              return (
                <div key={m.id}>
                  {divider && (
                    <div className="px-4 pb-1 pt-6 text-center text-xs font-medium text-muted">
                      {dayLabel(m.created_at)} {new Date(m.created_at).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}
                  <MessageItem m={m} results={results} compact={compact} showName={multiAuthor} onReply={setReplyTo} onForward={setForward} />
                </div>
              );
            })}
            {approvals.length > 0 && (
              <div className="space-y-3 ps-[58px] pe-4 pt-4 sm:ps-[64px] sm:pe-6">
                {approvals.map((a) => (
                  <ApprovalCard key={a.id} a={a} />
                ))}
              </div>
            )}
            {canResume && !busy && !approvals.some((a) => a.interrupted_at) && (
              <div className="flex justify-center px-4 pt-4">
                <div className="tb-ask flex flex-wrap items-center gap-2 rounded-2xl border px-4 py-2.5 text-sm" role="status">
                  <span className="h-2 w-2 rounded-full bg-warn" aria-hidden />
                  {canResume === 'stopped' ? `Je hebt ${agent?.name || 'de bot'} gestopt.` : 'De vorige taak is onderbroken (bijv. door een herstart).'}
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Play className="h-3.5 w-3.5" />}
                    title={canResume === 'stopped' ? 'De bot gaat verder waar hij was; hij controleert eerst wat al gedaan is' : undefined}
                    onClick={() => api.post(`/threads/${threadId}/resume`).then(() => setCanResume(null)).catch(toastError)}
                  >
                    Hervatten
                  </Button>
                </div>
              </div>
            )}
            {!busy && list.length > 0 && (list[list.length - 1].status === 'error' || (list[list.length - 1].role === 'assistant' && list[list.length - 1].status === 'done' && !list[list.length - 1].content?.trim() && !list[list.length - 1].parts.toolCalls?.length)) && (
              <div className="flex justify-center px-4 pt-3">
                <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => api.post(`/threads/${threadId}/retry`).catch(toastError)}>
                  Opnieuw proberen
                </Button>
              </div>
            )}
          </div>
          {showJump && (
            <button
              className="sticky bottom-3 left-1/2 z-10 mx-auto flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs font-semibold shadow-pop transition-colors hover:bg-surface-2"
              onClick={() => {
                const el = scroller.current;
                if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
              }}
            >
              <ArrowDown className="h-3.5 w-3.5" /> Naar nieuwste
            </button>
          )}
        </div>

        <div className="mx-auto w-full max-w-[860px]">
          {busy && queue.enabled && agent && <BusyChoice agent={agent} cli={queue.state?.engine === 'cli'} onChange={setBusyPolicy} />}
          <QueueBar queue={queue} className="mx-3 mb-2 sm:mx-4" />
          <Composer
            key={threadId}
            threadId={threadId}
            agentId={thread.agent_id}
            busy={busy}
            disabled={noProvider}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            onSend={send}
            onStop={stop}
            busyHint={!queue.enabled ? undefined : agent?.busy_policy === 'interrupt' ? 'onderbreekt de bot' : agent?.busy_policy === 'steer' ? (queue.state?.engine === 'cli' ? 'vooraan in de wachtrij' : 'stuurt de lopende beurt bij') : 'komt in de wachtrij'}
            commands={chatCommands}
            accessory={agent && thread.kind !== 'room' && !agent.shared_from ? <ChatUsage agent={agent} provider={provider} threadId={threadId} busy={busy} reserve={reserve ? { model: reserve.model } : undefined} /> : undefined}
            placeholder={asking && queue.enabled ? 'Typ je antwoord op de vraag…' : !desktop ? 'Bericht…' : agent && thread.kind !== 'room' ? `Bericht aan ${agent.name}…` : thread.kind === 'room' ? 'Bericht aan de groep (@naam)…' : undefined}
          />
        </div>
      </div>

      <PagePanel threadId={threadId} canDock={!inspector} />

      {uiModules.flatMap((m) => m.chatDocks || []).map((D, i) => (
        <D key={i} threadId={threadId} agentId={thread.kind === 'room' ? null : thread.agent_id} />
      ))}

      {inspector && (
        <>
          <div className="fixed inset-0 z-30 bg-black/40 min-[1100px]:hidden" onClick={() => showPanel(false)} />
          <aside className={cx('fixed inset-y-0 end-0 z-40 w-[min(380px,92vw)] border-s border-line bg-surface shadow-pop', 'min-[1100px]:static min-[1100px]:z-auto min-[1100px]:w-[360px] min-[1100px]:shadow-none')}>
            <Inspector key={inspectorTab || 'default'} thread={thread} initialTab={inspectorTab} onClose={() => showPanel(false)} />
          </aside>
        </>
      )}

      <Modal open={rename !== null} onClose={() => setRename(null)} title="Naam van het gesprek" footer={<Button variant="primary" onClick={() => (patchThread({ title: rename || '' }), setRename(null))}>Opslaan</Button>}>
        <Input value={rename || ''} onChange={(e) => setRename(e.target.value)} autoFocus placeholder={title} aria-label="Naam van het gesprek" onKeyDown={(e) => e.key === 'Enter' && (patchThread({ title: rename || '' }), setRename(null))} />
      </Modal>
      <ForwardModal m={forward} onClose={() => setForward(null)} />
      <BotDeleteDialog agent={agent} open={delBot} onClose={() => setDelBot(false)} onDeleted={() => navigate('/')} />
      {saveSkill && <SaveAsSkillModal threadId={threadId} onClose={() => setSaveSkill(false)} />}
      {folderItem && <MoveToFolderDialog item={{ kind: folderItem.kind, id: folderItem.id }} name={folderItem.name} teams={folderItem.teams} open={toFolder} onClose={() => setToFolder(false)} />}
      <HistoryDeleteDialog
        target={thread.kind === 'room' && thread.room_id ? { kind: 'room', id: thread.room_id, name: room?.name || title, threadId: thread.id } : agent && thread.kind !== 'room' ? { kind: 'agent', id: agent.id, name: agent.name } : null}
        open={delHistory}
        onClose={() => setDelHistory(false)}
        onDone={() => (thread.kind === 'room' ? useApp.getState().loadThread(thread.id) : agent && navigate(`/a/${agent.id}`))}
      />
    </div>
  );
}

/**
 * While the bot works: what a new message does (the bot's busy_policy), as a visible choice right above the composer.
 * Changing it is saved for this bot (also under Bot-instellingen › Denken, drukte en reserve-engines).
 */
function BusyChoice({ agent, cli, onChange }: { agent: Agent; cli: boolean; onChange(p: Agent['busy_policy']): void }) {
  const cur = useApp((s) => s.agents.find((a) => a.id === agent.id)?.busy_policy) || 'queue';
  const help = BUSY_POLICIES.find((p) => p.id === cur)!;
  const ICON = { queue: ListEnd, steer: CornerDownRight, interrupt: Square } as const;
  // One calm line: three choices with an icon on one track, and next to it what the chosen one does, in a few words.
  return (
    <div className="mx-3 mb-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:mx-4">
      <div className="inline-flex shrink-0 rounded-full bg-surface-2 p-0.5" role="radiogroup" aria-label={t('Nieuw bericht terwijl {0} werkt', agent.name)}>
        {BUSY_POLICIES.map((p) => {
          const Icon = ICON[p.id];
          const on = cur === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              title={p.text + (cli && p.cli ? ' ' + p.cli : '')}
              onClick={() => onChange(p.id)}
              className={cx(
                'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12.5px] transition-colors coarse:h-11 coarse:px-3.5',
                on ? 'bg-surface font-semibold text-fg shadow-sm' : 'font-medium text-muted hover:text-fg',
              )}
            >
              <Icon className={cx('h-3.5 w-3.5', p.id === 'interrupt' && 'h-3 w-3')} aria-hidden />
              {p.label}
            </button>
          );
        })}
      </div>
      <span className="min-w-0 text-[12px] text-muted" aria-live="polite">
        {cli && help.cliShort ? help.cliShort : help.short}
      </span>
    </div>
  );
}

function ForwardModal({ m, onClose }: { m: Message | null; onClose(): void }) {
  const threads = useApp((s) => s.threads);
  const agents = useApp((s) => s.agents);
  return (
    <Modal open={!!m} onClose={onClose} title="Doorsturen naar…">
      <div className="space-y-0.5">
        {threads
          .filter((t) => t.id !== m?.thread_id && !t.archived)
          .slice(0, 40)
          .map((t) => {
            const a = agents.find((x) => x.id === t.agent_id);
            return (
              <button
                key={t.id}
                className="flex w-full items-center gap-2.5 rounded-control px-2 py-2 text-start text-sm transition-colors hover:bg-surface-2 active:bg-surface-3"
                onClick={async () => {
                  try {
                    await api.post(`/messages/${m!.id}/forward`, { threadId: t.id });
                    toast('Doorgestuurd', 'ok');
                    onClose();
                  } catch (e) {
                    toastError(e);
                  }
                }}
              >
                {a ? <BotAvatar bot={a} size={28} /> : <span className="h-7 w-7 rounded-full bg-surface-3" />}
                <span className="truncate font-medium">{t.title || a?.name || kindTitle[t.kind]}</span>
              </button>
            );
          })}
      </div>
    </Modal>
  );
}
