import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, ArrowUp, Check, ExternalLink, Eye, EyeOff, Globe, Hand, RotateCcw, Square, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { api, authUrl, on } from '../../lib/api';
import { previewText, stripRefs } from '../../lib/preview';
import { limitLine } from '../../lib/mood';
import { agentById, statusText, useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import type { Thread } from '../../lib/types';
import { BotAvatar, LiveBotAvatar } from '../../components/BotFace';
import { Badge, Button, EmptyState, Input, Page, PageHeader, cx, timeAgo, toast, toastError } from '../../components/ui';
import { Mark, StopAllButton } from '../../shell/Sidebar';
import { isUnread, markSeen, onSeen } from '../../shell/unread';
import { openDock } from '../browser/BrowserDock';
import { PLACE } from '../../../../shared/places.js';
import { tText } from '../../lib/format';

/** What the desktop shell adds for the floating status window (preload.ts). */
interface DesktopStatusBridge {
  show?(hash?: string): Promise<unknown>;
  statusWindow?: { get(): Promise<{ mode: StatusMode }>; set(mode: StatusMode): Promise<{ mode: StatusMode }>; hide(): Promise<unknown>; /** The island: catch the mouse (true) or let clicks through to what is underneath (false). */ interactive?(on: boolean): Promise<unknown> };
}
export type StatusMode = 'off' | 'auto' | 'always';
export const desktopBridge = (): DesktopStatusBridge | null => (window as any).teambotDesktop || null;

interface RunInfo {
  id: string;
  status: 'queued' | 'running' | 'waiting';
  threadId: string;
  agentId: string;
  agentName: string;
  doing: string;
  startedAt: string;
  trigger: string;
  /** The bot's own browser while it runs (0.4.5): the page it shows and who has control; null without one. */
  browser?: { url: string; title: string; controller: { kind: 'bot' | 'user'; name: string } | null; filling: boolean } | null;
}

/** Server-side "what is each bot doing" lines, refreshed (batched) on live run/message/approval/browser events. */
function useDoing() {
  const [state, setState] = useState<{ runs: RunInfo[]; at: number }>({ runs: [], at: 0 });
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const asked = Date.now();
    api
      .get<{ runs: RunInfo[] }>('/usage/status')
      .then((r) => alive && setState({ runs: r.runs, at: asked }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [n]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        setN((x) => x + 1);
      }, 1200);
    };
    const offs = ['run.updated', 'message.updated', 'message.created', 'approval.created', 'approval.updated', 'computer.status'].map((e) => on(e, bump));
    return () => {
      offs.forEach((f) => f());
      if (t) clearTimeout(t);
    };
  }, []);
  return state;
}

/**
 * The step a bot announces while it works ("Opent bol.com…", a tool's progress), per conversation, straight from the
 * live events: newer than the last server line, it goes first.
 */
function useLiveSteps() {
  const [steps, setSteps] = useState<Record<string, { text: string; at: number }>>({});
  useEffect(() => {
    const set = (d: any) => {
      if (!d?.threadId || typeof d.text !== 'string' || !d.text.trim()) return;
      setSteps((s) => ({ ...s, [d.threadId]: { text: statusText(d.text), at: Date.now() } }));
    };
    const a = on('message.status', set);
    const b = on('tool.progress', set);
    return () => {
      a();
      b();
    };
  }, []);
  return steps;
}

/** A small live picture of the bot's browser: a fresh frame every few seconds while the page is in view. */
function LiveThumb({ agentId, name, onOpen }: { agentId: string; name: string; onOpen(): void }) {
  const [n, setN] = useState(0);
  const [ok, setOk] = useState(true);
  useEffect(() => {
    const i = setInterval(() => document.visibilityState === 'visible' && setN((x) => x + 1), 3000);
    return () => clearInterval(i);
  }, []);
  const src = useMemo(() => authUrl(`/computers/${agentId}/frame.jpg?n=${n}`), [agentId, n]);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative block aspect-[16/10] w-36 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2 hover:border-line-strong sm:w-44"
      aria-label={t('Live beeld van de browser van {0} bekijken', name)}
      data-testid="now-thumb"
    >
      <img src={src} alt="" className={cx('h-full w-full object-cover object-top', !ok && 'invisible')} onLoad={() => setOk(true)} onError={() => setOk(false)} />
      {!ok ? (
        <span className="absolute inset-0 flex items-center justify-center text-muted" aria-hidden>
          <Globe className="h-5 w-5" />
        </span>
      ) : (
        <span className="absolute start-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-px text-[10.5px] font-bold text-white" aria-hidden>
          <span className="h-1.5 w-1.5 rounded-full bg-danger tb-pulse" />
          LIVE
        </span>
      )}
    </button>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

function openThread(threadId: string | null, floating: boolean) {
  const hash = threadId ? `#/t/${threadId}` : '#/inbox';
  const d = desktopBridge();
  if (floating && d?.show) d.show(hash).catch(() => {});
  else navigate(hash);
}

/**
 * Answers that came in while you were not looking, and bots that got stuck (status islands of other bot apps show these as "message"
 * and "failed"): the newest unread chat per bot, at most five, not for bots that are still working.
 */
function useFresh(busyAgents: Set<string>): Thread[] {
  const threads = useApp((s) => s.threads);
  const [, bump] = useState(0);
  useEffect(() => onSeen(() => bump((x) => x + 1)), []);
  const per = new Map<string, Thread>();
  for (const t of threads) {
    if (t.kind !== 'chat' || !t.agent_id || t.room_id || t.archived || !t.last || t.last.role !== 'assistant' || busyAgents.has(t.agent_id)) continue;
    if (!isUnread(t) || Date.now() - Date.parse(t.updated_at) > 6 * 3600_000) continue;
    const cur = per.get(t.agent_id);
    if (!cur || t.updated_at > cur.updated_at) per.set(t.agent_id, t);
  }
  return [...per.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);
}

/** A bot's question answered right here: its choices, or a few words of your own (the chat stays for longer answers). */
function QuickAnswer({ options, busy, onAnswer }: { options: string[] | null; busy: boolean; onAnswer(text: string): void }) {
  const [text, setText] = useState('');
  return (
    <div className="mt-2 space-y-1.5">
      {options?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {options.slice(0, 6).map((o) => (
            <Button key={o} size="sm" disabled={busy} onClick={() => onAnswer(o)}>
              {o}
            </Button>
          ))}
        </div>
      ) : null}
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onAnswer(text.trim());
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={options?.length ? 'Of typ je antwoord…' : 'Typ je antwoord…'} aria-label="Antwoord" className="h-8 bg-surface text-[13px]" />
        <Button size="icon" variant="primary" className="h-8 w-8 shrink-0 rounded-full" aria-label="Antwoord versturen" loading={busy} disabled={!text.trim()}>
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
      </form>
    </div>
  );
}

const elapsed = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} u ${Math.floor((s % 3600) / 60)} min`;
};

/**
 * Running bots, what they are doing, and what waits for the owner — with stop. The same view is the floating
 * status window on the desktop (`compact`) and a page on the phone. Approving here is the owner's own click;
 * actions with impact (risk "danger") and questions open the chat instead, so you see the details first.
 */
export function StatusView({ floating }: { floating?: boolean }) {
  const runs = useApp(useShallow((s) => s.runs.filter((r) => ['queued', 'running', 'waiting'].includes(r.status))));
  const approvals = useApp((s) => s.approvals);
  const { runs: doing, at: doingAt } = useDoing();
  const live = useLiveSteps();
  const [busy, setBusy] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const fresh = useFresh(new Set(runs.map((r) => r.agent_id)));
  const retry = async (t: Thread) => {
    setBusy(t.id);
    try {
      await api.post(`/threads/${t.id}/retry`, { agentId: t.agent_id });
      markSeen(t.id, t.updated_at);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const decide = async (id: string, decision: 'approve' | 'deny', answer?: string) => {
    setBusy(id + decision);
    try {
      await api.post(`/approvals/${id}`, { decision, ...(answer !== undefined ? { answer } : {}) });
      useApp.setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== id) }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const stop = async (runId: string) => {
    setBusy(runId);
    try {
      await api.post(`/runs/${runId}/cancel`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  /** Bekijken: the bot's conversation, with its browser open next to it (a full-screen sheet on the phone). */
  const view = (threadId: string, agentId: string, browser: boolean) => {
    if (browser && !floating) openDock(agentId);
    openThread(threadId, !!floating);
  };
  /** Overnemen: you get control of the bot's browser (module browser), then the live view to work in. */
  const takeOver = async (r: { id: string; thread_id: string; agent_id: string }) => {
    setBusy(r.id + 'take');
    try {
      await api.post(`/computers/${r.agent_id}/takeover`, {});
      toast('Jij hebt nu de bediening; de bot wacht', 'ok');
      view(r.thread_id, r.agent_id, true);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  if (!runs.length && !approvals.length && !fresh.length)
    return floating ? (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-6 text-center">
        <div className="text-sm font-semibold">Alles rustig</div>
        <div className="text-[12.5px] text-muted">Geen bot aan het werk en niets wacht op jou.</div>
      </div>
    ) : (
      <EmptyState icon={<Activity />} title="Alles rustig" action={<Button onClick={() => navigate('/tasks')}>Naar het takenbord</Button>}>
        Er is geen bot aan het werk en niets wacht op jou.
      </EmptyState>
    );
  return (
    <div className={cx('space-y-4', floating && 'p-2.5')}>
      {approvals.length > 0 && (
        <section aria-label="Wacht op jou">
          <h2 className="mb-1.5 flex items-center gap-2 px-1 text-[12px] font-bold uppercase tracking-wider text-muted">
            Wacht op jou <Badge tone="warn">{approvals.length}</Badge>
          </h2>
          <ul className="space-y-1.5">
            {approvals.map((a) => {
              const agent = agentById(a.agent_id);
              const quick = a.kind === 'tool' && a.risk !== 'danger';
              return (
                <li key={a.id} className="rounded-2xl border tb-ask p-2.5">
                  <div className="flex items-start gap-2.5">
                    <BotAvatar bot={agent || { id: a.agent_id || 'bot', name: 'Bot' }} size={floating ? 26 : 30} mood="waiting" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] text-muted">
                        <span className="font-semibold text-fg">{agent?.name || 'Bot'}</span> {a.kind === 'question' ? 'heeft een vraag' : a.risk === 'danger' ? 'vraagt toestemming (impact)' : 'vraagt toestemming'} · {timeAgo(a.created_at)}
                      </div>
                      <div className={cx('mt-0.5 break-words text-[13.5px] font-medium', floating && 'line-clamp-3')}>{stripRefs(a.summary)}</div>
                      {a.kind === 'question' && a.tool !== 'ask_form' && <QuickAnswer options={a.options} busy={busy === a.id + 'approve'} onAnswer={(text) => decide(a.id, 'approve', text)} />}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                    {floating && a.kind === 'tool' ? (
                      <Button size="sm" variant="ghost" aria-label="Bekijken in TeamBot" title="Bekijken in TeamBot" onClick={() => openThread(a.thread_id, true)}>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => openThread(a.thread_id, !!floating)}>
                        {a.kind === 'question' ? 'Beantwoorden' : 'Bekijken'}
                      </Button>
                    )}
                    {a.kind === 'tool' && (
                      <Button size="sm" icon={<X className="h-3.5 w-3.5" />} loading={busy === a.id + 'deny'} onClick={() => decide(a.id, 'deny')}>
                        Weigeren
                      </Button>
                    )}
                    {quick && (
                      <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy === a.id + 'approve'} onClick={() => decide(a.id, 'approve')}>
                        Goedkeuren
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {fresh.length > 0 && (
        <section aria-label="Nieuw voor jou">
          <h2 className="mb-1.5 flex items-center gap-2 px-1 text-[12px] font-bold uppercase tracking-wider text-muted">
            Nieuw voor jou <Badge>{fresh.length}</Badge>
            {fresh.length > 1 && (
              <button type="button" className="ms-auto rounded-md px-1.5 py-0.5 text-[12px] font-semibold normal-case tracking-normal text-muted hover:bg-surface-2 hover:text-fg" onClick={() => fresh.forEach((t) => markSeen(t.id, t.updated_at))}>
                Alles gezien
              </button>
            )}
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {fresh.map((t) => {
              const agent = agentById(t.agent_id);
              const name = agent?.name || 'Bot';
              // Stopped by the daily budget: a limit with its own words, not "liep vast" (B-70).
              const limitUntil = t.last?.status === 'error' && t.last.budgetUntil ? Date.parse(t.last.budgetUntil) || 0 : 0;
              const failed = t.last?.status === 'error' && !limitUntil;
              const tone = failed ? 'text-danger' : limitUntil ? 'text-warn' : 'text-muted';
              const line = failed ? 'Er ging iets mis bij het laatste antwoord.' : limitUntil ? limitLine(limitUntil) : previewText(t.last?.content) || 'Nieuw antwoord';
              return (
                // One compact row: the row itself opens the chat; "Gezien" is the small check at the end.
                <li key={t.id} className="tb-in flex items-center gap-1 pe-1.5 transition-colors hover:bg-surface-2">
                  <button type="button" className={cx('flex min-w-0 flex-1 items-start gap-2.5 text-start', floating ? 'px-2.5 py-2' : 'px-3.5 py-2.5')} onClick={() => openThread(t.id, !!floating)}>
                    <BotAvatar bot={agent || { id: t.agent_id || 'bot', name: 'Bot' }} size={floating ? 26 : 32} mood={limitUntil ? 'limit' : failed ? 'error' : 'done'} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-1.5">
                        <span className="text-[13.5px] font-semibold [overflow-wrap:anywhere]" translate="no">
                          {name}
                        </span>
                        <span className={cx('text-[11.5px]', tone)}>
                          {failed ? 'liep vast' : limitUntil ? 'daglimiet bereikt' : 'klaar'} · {timeAgo(t.updated_at)}
                        </span>
                      </span>
                      <span className={cx('break-words text-[12.5px] line-clamp-2', tone)}>{line}</span>
                    </span>
                  </button>
                  {failed && (
                    <Button size="icon" variant="ghost" aria-label={tText('{0}: opnieuw proberen', name)} title="Opnieuw proberen" loading={busy === t.id} onClick={() => retry(t)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" aria-label={tText('{0}: gezien', name)} title="Gezien" onClick={() => markSeen(t.id, t.updated_at)}>
                    <Check className="h-4 w-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {runs.length > 0 && (
        <section aria-label="Aan het werk">
          <h2 className="mb-1.5 flex items-center gap-2 px-1 text-[12px] font-bold uppercase tracking-wider text-muted">
            Aan het werk <Badge>{runs.length}</Badge>
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {runs.map((r) => {
              const agent = agentById(r.agent_id);
              const d = doing.find((x) => x.id === r.id);
              const step = live[r.thread_id];
              const what = r.status === 'waiting' ? 'wacht op jou' : r.status === 'queued' ? 'in de wachtrij' : step && step.at > doingAt ? step.text : d?.doing || 'aan het werk';
              const name = agent?.name || d?.agentName || 'Bot';
              if (!floating) {
                const br = d?.browser || null;
                const mine = br?.controller?.kind === 'user';
                // On the same line as the bot (they wrap below it on a phone), not a row of their own.
                const buttons = (
                  <div className="ms-auto flex flex-wrap justify-end gap-1.5">
                    <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => view(r.thread_id, r.agent_id, !!br)} aria-label={t('{0} bekijken', name)}>
                      Bekijken
                    </Button>
                    <Button size="sm" icon={<Square className="h-3 w-3 fill-current" />} loading={busy === r.id} onClick={() => stop(r.id)} aria-label={t('{0} stoppen', name)}>
                      Stoppen
                    </Button>
                    {br && !mine && (
                      <Button size="sm" variant="primary" icon={<Hand className="h-3.5 w-3.5" />} loading={busy === r.id + 'take'} onClick={() => takeOver(r)} aria-label={t('Browser van {0} overnemen', name)}>
                        Overnemen
                      </Button>
                    )}
                  </div>
                );
                return (
                  <li key={r.id} className="tb-in space-y-2 px-3.5 py-2.5" data-testid="now-run" data-agent={r.agent_id}>
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                      <LiveBotAvatar bot={agent || { id: r.agent_id, name: 'Bot' }} size={32} />
                      <div className="min-w-[10rem] flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-1.5">
                          <span className="text-[13.5px] font-semibold [overflow-wrap:anywhere]">{name}</span>
                          <span className="text-[11.5px] text-muted">{elapsed(r.started_at || r.created_at)}</span>
                        </div>
                        <div className={cx('break-words text-[12.5px] line-clamp-2', r.status === 'waiting' ? 'text-warn' : 'text-muted')} data-testid="now-step">
                          {what}
                        </div>
                      </div>
                      {buttons}
                    </div>
                    {br && (
                      <div className="flex items-start gap-2.5 ps-[44px]">
                        <LiveThumb agentId={r.agent_id} name={name} onOpen={() => view(r.thread_id, r.agent_id, true)} />
                        <div className="min-w-0 flex-1 space-y-1 text-[12.5px]">
                          <div className="flex items-center gap-1 text-muted">
                            <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
                            <span className="truncate">{br.title || hostOf(br.url) || 'Browser'}</span>
                          </div>
                          {br.url && <div className="truncate text-[11.5px] text-muted">{hostOf(br.url)}</div>}
                          {mine ? <Badge tone="accent">Jij hebt de bediening</Badge> : br.filling ? <Badge>Kluis vult in</Badge> : null}
                        </div>
                      </div>
                    )}
                  </li>
                );
              }
              return (
                <li key={r.id} className="flex items-center gap-2.5 px-2.5 py-2">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-start" onClick={() => openThread(r.thread_id, !!floating)} aria-label={t('{0}: {1} — gesprek openen', agent?.name || 'Bot', t(what))}>
                    <LiveBotAvatar bot={agent || { id: r.agent_id, name: 'Bot' }} size={floating ? 26 : 30} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="truncate text-[13.5px] font-semibold">{agent?.name || d?.agentName || 'Bot'}</span>
                        <span className="shrink-0 text-[11.5px] text-muted">{elapsed(r.started_at || r.created_at)}</span>
                      </span>
                      <span className={cx('block truncate text-[12.5px]', r.status === 'waiting' ? 'text-warn' : 'text-muted')}>{what}</span>
                    </span>
                  </button>
                  <Button size="icon" variant="ghost" aria-label={t('{0} stoppen', agent?.name || 'Bot')} title="Stoppen" loading={busy === r.id} onClick={() => stop(r.id)}>
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** #/m/usage/status — "Nu bezig" (phone and desktop). */
export function StatusPage() {
  return (
    <Page>
      <PageHeader title="Nu bezig" subtitle="Welke bots werken, wat ze doen en wat op jou wacht." width="3xl" back={{ href: '#/tasks', label: 'Taken' }} />
      <div className="mx-auto max-w-3xl space-y-4 px-4 pb-8 pt-2 sm:px-6">
        <StatusView />
        <StopAllButton className="h-10" />
      </div>
    </Page>
  );
}

/** How long "klaar" or "liep vast" stays in the island after a bot's run ends. */
const DONE_MS = 6000;
const ISLAND_EASE = 'duration-[340ms] ease-[cubic-bezier(0.23,1,0.32,1)]';

/**
 * #/m/usage/eiland — the island of the desktop app: a black pill at the top of the screen, above every program, that
 * says in one line what matters now (a question for you, who works and on what, who just finished). A click opens it
 * into the whole list (StatusView: answer, approve, stop); clicking elsewhere closes it. Outside the pill the window
 * lets every click through to what is underneath (the shell's setIgnoreMouseEvents; the pill switches it off while
 * the mouse is on it).
 */
export function FloatingStatus() {
  const runs = useApp(useShallow((s) => s.runs.filter((r) => ['queued', 'running', 'waiting'].includes(r.status))));
  const approvals = useApp((s) => s.approvals);
  const live = useLiveSteps();
  const { runs: doing, at: doingAt } = useDoing();
  const [open, setOpen] = useState(false);
  // Each time the shell shows the window again, the island drops in again.
  const [shown, setShown] = useState(0);
  const [ended, setEnded] = useState<{ agentId: string; failed: boolean } | null>(null);
  const bridge = desktopBridge();
  useEffect(() => {
    document.title = 'TeamBot';
    document.documentElement.classList.add('tb-island-page');
    const vis = () => document.visibilityState === 'visible' && setShown((x) => x + 1);
    const close = () => setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', esc);
    const off = on('run.updated', (r: any) => {
      if (r?.agent_id && (r.status === 'done' || r.status === 'error')) setEnded({ agentId: r.agent_id, failed: r.status === 'error' });
    });
    return () => {
      // Opened in the app itself (a link, the page list), leaving it must give the app its own background back.
      document.documentElement.classList.remove('tb-island-page');
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', esc);
      off();
    };
  }, []);
  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => setEnded(null), DONE_MS);
    return () => clearTimeout(t);
  }, [ended]);
  const interactive = (v: boolean) => bridge?.statusWindow?.interactive?.(v).catch(() => {});

  // The one line, most important first.
  const name = (id: string | null | undefined) => agentById(id || '')?.name || 'Bot';
  let state: 'wait' | 'work' | 'done' | 'fail' | 'idle' = 'idle';
  let faces: { bot: { id: string; name: string; avatar?: string | null }; mood: 'waiting' | 'working' | 'done' | 'error' | 'idle' }[] = [];
  let line = t('Alles rustig');
  const face = (id: string, mood: (typeof faces)[number]['mood']) => ({ bot: agentById(id) || { id, name: 'Bot' }, mood });
  if (approvals.length) {
    state = 'wait';
    const a = approvals[0];
    faces = [...new Set(approvals.map((x) => x.agent_id || ''))].slice(0, 3).map((id) => face(id, 'waiting'));
    line = approvals.length > 1 ? t('{0, plural, one {# vraag wacht op je} other {# vragen wachten op je}}', approvals.length) : a.kind === 'question' ? t('{0} heeft een vraag', name(a.agent_id)) : t('{0} vraagt toestemming', name(a.agent_id));
  } else if (runs.length) {
    state = 'work';
    faces = [...new Set(runs.map((r) => r.agent_id))].slice(0, 3).map((id) => face(id, 'working'));
    if (runs.length === 1) {
      const r = runs[0];
      const step = live[r.thread_id];
      const what = r.status === 'queued' ? t('in de wachtrij') : step && step.at > doingAt ? step.text : doing.find((x) => x.id === r.id)?.doing || t('aan het werk');
      line = `${name(r.agent_id)} · ${what}`;
    } else line = t('{0, plural, one {# bot aan het werk} other {# bots aan het werk}}', runs.length);
  } else if (ended) {
    state = ended.failed ? 'fail' : 'done';
    faces = [face(ended.agentId, ended.failed ? 'error' : 'done')];
    line = ended.failed ? t('{0} liep vast', name(ended.agentId)) : t('{0} is klaar', name(ended.agentId));
  }

  return (
    <div className="flex h-full items-start justify-center">
      <div
        key={shown}
        data-testid="island"
        data-state={state}
        onMouseEnter={() => interactive(true)}
        onMouseLeave={() => interactive(false)}
        className={cx('tb-island dark flex max-h-full flex-col overflow-hidden rounded-t-none transition-[width,border-radius]', ISLAND_EASE, open ? 'w-[420px] rounded-b-[28px]' : cx('rounded-b-[20px]', state === 'idle' ? 'w-[190px]' : 'w-[300px]'))}
      >
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? t('Eiland sluiten') : t('Eiland openen: {0}', line)} className="flex h-[38px] w-full shrink-0 items-center gap-2.5 px-3.5 text-start">
          {faces.length ? (
            <span className="flex shrink-0 items-center">
              {faces.map((f, i) => (
                <span key={f.bot.id} className={cx('rounded-full', i > 0 && '-ms-2 ring-2 ring-[#0b0b0d]')}>
                  <BotAvatar bot={f.bot} mood={f.mood} size={22} />
                </span>
              ))}
            </span>
          ) : (
            <Mark size={20} />
          )}
          <span key={line} className={cx('tb-in min-w-0 flex-1 truncate text-[13px] font-semibold', state === 'wait' ? 'text-[#ffc24a]' : state === 'fail' ? 'text-[#ff8a8a]' : 'text-white')}>
            {line}
          </span>
          {state === 'wait' ? (
            <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[#ffc24a] px-1 text-[11px] font-bold tabular-nums text-[#1a1405]">{approvals.length}</span>
          ) : state === 'work' ? (
            <span className="tb-dots shrink-0 text-white/70" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          ) : state === 'done' ? (
            <Check className="h-4 w-4 shrink-0 text-[#4fd18b]" aria-hidden />
          ) : state === 'fail' ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-[#ff8a8a]" aria-hidden />
          ) : null}
        </button>
        {/* Open: the whole list grows out of the pill. */}
        <div className={cx('grid transition-[grid-template-rows]', ISLAND_EASE, open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
          <div className="min-h-0 overflow-hidden">
            <div className="scroll-thin max-h-[500px] overflow-y-auto border-t border-white/10 text-fg">
              <StatusView floating />
              <div className="flex items-center justify-end gap-1.5 px-2.5 pb-2.5">
                <Button size="sm" variant="ghost" icon={<EyeOff className="h-3.5 w-3.5" />} title={t('Komt terug zodra er iets nieuws is (uitzetten: systeemvak of {0})', t(PLACE.limits))} onClick={() => bridge?.statusWindow?.hide()}>
                  Verbergen
                </Button>
                <Button size="sm" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => (setOpen(false), bridge?.show?.('#/m/usage/status'))}>
                  TeamBot openen
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
