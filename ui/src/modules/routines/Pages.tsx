import React, { useCallback, useEffect, useState } from 'react';
import { AlarmClock, CalendarDays, CheckCircle2, Copy, Eye, Gauge, History, Hourglass, Lightbulb, MessageSquare, Pause, Play, Plus, PowerOff, Settings2, Target, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { navigate, query } from '../../lib/router';
import { useApp } from '../../lib/store';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Page, PageHeader, Tabs, Toggle, toast, useAsync } from '../../components/ui';
import { Menu, Skeleton, SkeletonRows } from '../../components/overview';
import { Segmented } from '../../components/SettingControls';
import { StartModal, WorkflowRow } from '../workflows/Pages';
import { useWorkflows, type Workflow } from '../workflows/api';
import { BotAvatar } from '../../components/BotFace';
import { draftFrom, emptyDraft, RoutineEditor, type Draft } from './Editor';
import { HistoryTab } from './History';
import { AttentionCard, MissedCard } from './Attention';
import { TriggersTab } from './Triggers';
import { TaskLinks, UptimeNote } from './Head';
import { fmtDate, loadMeta, RUN_STATUS, routineStatus, useMeta, type GlobalSettings, type RoutineView, type RunSummary } from './lib';
import { useFollowTeam } from '../teams/follow';
import { TeamFilterNote } from '../teams/FilterNote';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const SUMMARY_ORDER = ['done', 'no_result', 'no_update', 'running', 'pending', 'retrying', 'error', 'skipped', 'limited', 'missed', 'cancelled', 'interrupted'];

/** Last 24 hours of all routines in one line: counts per status, and the runs waiting for an engine limit reset. */
function RunSummaryLine() {
  const [s, setS] = useState<RunSummary | null>(null);
  // The team chosen in the team switcher (package B4); '' = all teams.
  const team = useFollowTeam().and;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () => api.get<RunSummary>(`/routines/runs/summary?hours=24${team}`).then(setS).catch(() => {});
    // Many routine events in a burst: refresh at most every 2 s.
    const soon = () => {
      if (!t) t = setTimeout(() => ((t = null), load()), 2000);
    };
    load();
    const off = on('routine.run', soon);
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [team]);
  if (!s || !s.total) return null;
  return (
    <div className="tb-in space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
        <span className="font-semibold">Laatste 24 uur</span>
        <span className="text-muted">{t('{0, plural, one {# run} other {# runs}}', s.total)}</span>
        {SUMMARY_ORDER.filter((k) => s.counts[k]).map((k) => (
          <Badge key={k} tone={RUN_STATUS[k]?.tone || 'neutral'}>
            {RUN_STATUS[k]?.label || k}: {s.counts[k]}
          </Badge>
        ))}
      </div>
      {s.waiting.length > 0 && (
        <div className="rounded-control bg-warn-soft px-3 py-2.5 text-[13px] text-warn" role="status">
          <div className="font-semibold">Wachten op de limiet van de AI-engine ({s.waiting.length})</div>
          <ul className="mt-1 space-y-0.5">
            {s.waiting.slice(0, 8).map((w) => (
              <li key={w.id}>
                <a className="underline" href={`#/m/routines/r/${w.routineId}`}>
                  {w.routineName || 'Routine'}
                </a>{' '}
                — gaat verder om {fmtDate(w.until)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** `team`: only the routines of that team (the team switcher; '' = all). A bot's own list ignores it. */
function useRoutineList(agentId?: string, team = '') {
  const [list, setList] = useState<RoutineView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .get<RoutineView[]>(`/routines${agentId ? `?agentId=${encodeURIComponent(agentId)}` : team ? `?teamId=${encodeURIComponent(team)}` : ''}`)
      .then((r) => (setList(r), setErr(null)))
      .catch((e) => setErr(e.message));
  }, [agentId, team]);
  useEffect(load, [load]);
  useEffect(() => {
    const a = on('routine.updated', (r: RoutineView) => {
      if ((agentId && r.agent_id !== agentId) || (!agentId && team && r.teamId && r.teamId !== team)) return setList((cur) => cur?.filter((x) => x.id !== r.id) || cur);
      setList((cur) => (cur ? (cur.some((x) => x.id === r.id) ? cur.map((x) => (x.id === r.id ? { ...x, ...r } : x)) : [...cur, r]) : cur));
    });
    const b = on('routine.deleted', (d: { id: string }) => setList((cur) => cur?.filter((x) => x.id !== d.id) || cur));
    return () => {
      a();
      b();
    };
  }, [agentId, team]);
  return { list, err, load, setList };
}

function useRoutineActions() {
  const { busy, run } = useAsync();
  return {
    busy,
    test: (r: RoutineView) => run(() => api.post(`/routines/${r.id}/run`, {}), 'Testrun gestart — het resultaat verschijnt in de historie en het gesprek'),
    pause: (r: RoutineView) => run(() => api.post(`/routines/${r.id}/pause`, {}), 'Routine gepauzeerd'),
    resume: (r: RoutineView) => run(() => api.post(`/routines/${r.id}/resume`, {}), 'Routine staat weer aan'),
    confirm: (r: RoutineView) => run(() => api.post(`/routines/${r.id}/confirm`, {}), 'Routine bevestigd en actief'),
    duplicate: (r: RoutineView) =>
      run(async () => {
        const c = await api.post<RoutineView>(`/routines/${r.id}/duplicate`, {});
        toast('Kopie gemaakt; die staat op pauze tot je hem hervat', 'ok');
        navigate(`/m/routines/r/${c.id}?tab=settings`);
      }),
  };
}

/** What happens next with a routine, in a few words (after its schedule on the row). */
function NextLine({ r }: { r: RoutineView }) {
  const wp = r.options?.waitpoint;
  if (wp) {
    if (wp.firedAt) return <span>{wp.how === 'timeout' ? `Verlopen op ${fmtDate(wp.firedAt, r.timezone)}: ${wp.what} gebeurde niet op tijd` : `Ging af op ${fmtDate(wp.firedAt, r.timezone)}`}</span>;
    if (r.status === 'active') return <span>{wp.kind === 'time' ? `Gaat af op ${fmtDate(wp.until, r.timezone)}` : `Wacht op ${wp.what} · uiterlijk ${fmtDate(wp.until, r.timezone)}`}</span>;
  }
  if (r.status === 'draft') return <span className="text-warn">wacht op jouw bevestiging{r.created_by === 'agent' ? ' (voorgesteld door de bot)' : ''}</span>;
  if (r.status === 'paused') return <span className={r.paused_reason?.startsWith('Automatisch') ? 'text-danger' : undefined}>{r.paused_reason || 'gepauzeerd'}</span>;
  if (r.status === 'completed') return <span>eenmalig, is uitgevoerd</span>;
  if (r.next_run_at) return <span className="text-fg">{t('volgende: {0}', fmtDate(r.next_run_at, r.timezone))}</span>;
  return <span>{r.triggerCount ? 'start bij een trigger' : 'alleen handmatig'}</span>;
}

/** Runs that ended in a way the owner should know about (anything else needs no signal on the row). */
const TROUBLE = ['error', 'no_result', 'missed', 'limited', 'interrupted'];

/** The one thing a row says about its state, most urgent first. A routine that simply runs says nothing. */
function RowSignal({ r }: { r: RoutineView }) {
  if (r.status === 'draft') return <Badge tone="warn">Concept</Badge>;
  const running = r.activeRun ? RUN_STATUS[r.activeRun.status] : null;
  if (running) return <Badge tone={running.tone}>{running.label}</Badge>;
  if (r.options?.waitpoint)
    return (
      <Badge tone={r.status === 'active' ? 'accent' : 'neutral'}>
        <Hourglass className="h-3 w-3" aria-hidden /> {r.status === 'active' ? 'Wachtpunt' : 'Wachtpunt · klaar'}
      </Badge>
    );
  if (r.status === 'paused' && r.paused_reason?.startsWith('Automatisch')) return <Badge tone="danger">Automatisch gepauzeerd</Badge>;
  if (r.status === 'completed') return <Badge>Afgerond</Badge>;
  const last = r.status === 'active' && r.last_status && TROUBLE.includes(r.last_status) ? RUN_STATUS[r.last_status] : null;
  if (last) return <Badge tone={last.tone}>{t('Laatste keer: {0}', last.label.toLowerCase())}</Badge>;
  return null;
}

/**
 * One routine as a row: who, what, when, and one signal. The whole row opens the routine; the switch turns it on or
 * off; testing and the rare actions sit behind "⋯".
 */
function RoutineRow({ r, showTeam, zone, kind }: { r: RoutineView; showTeam?: boolean; zone: string; kind: string }) {
  const agent = useApp((s) => s.agents.find((a) => a.id === r.agent_id));
  const act = useRoutineActions();
  const wp = r.options?.waitpoint;
  const thread = wp?.threadId || r.thread_id;
  const on = r.status === 'active';
  // The time zone only when it is not the one everything else uses.
  const tz = !wp && r.timezone !== zone && r.schedule.kind !== 'none' && r.schedule.kind !== 'interval' ? ` (${r.timezone})` : '';
  return (
    <li className="tb-in relative flex flex-wrap items-center justify-end gap-x-3 gap-y-2 px-4 py-3 transition-colors first:rounded-t-card last:rounded-b-card hover:bg-surface-2">
      <BotAvatar bot={agent || { id: r.agent_id, name: r.agentName || '?', avatar: r.agentAvatar }} size={36} />
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a href={`#/m/routines/r/${r.id}`} className="font-semibold leading-snug [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-['']" translate="no">
            {r.name}
          </a>
          <RowSignal r={r} />
        </div>
        <div className="mt-0.5 text-[13px] leading-snug text-muted">
          <span className="font-medium" data-kind>
            {kind}
          </span>
          {' · '}
          <span translate="no">{agent?.name || r.agentName || 'Onbekende bot'}</span>
          {showTeam && r.teamName && (
            <>
              {' · '}
              <span translate="no">{r.teamName}</span>
            </>
          )}
          {!wp && ` · ${r.scheduleText}${tz}`}
          {/* A draft says so with its badge and its button; no third time in words. */}
          {(r.status !== 'draft' || wp) && (
            <>
              {' · '}
              <NextLine r={r} />
            </>
          )}
        </div>
      </div>
      {/* Positioned, so the controls lie above the link that covers the row (without a layer of their own: the menu must stay above the rows below). */}
      <div className="relative flex shrink-0 items-center gap-1">
        {r.status === 'draft' ? (
          <Button size="sm" variant="primary" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => act.confirm(r)} loading={act.busy}>
            Bevestigen
          </Button>
        ) : (
          !wp && <Toggle checked={on} disabled={act.busy} onChange={(v) => (v ? act.resume(r) : act.pause(r))} label={<span className="sr-only">{t('{0} actief', r.name)}</span>} />
        )}
        <Menu
          label={t('Acties voor {0}', r.name)}
          testId="routine-menu"
          items={[
            !wp && { label: 'Nu testen', icon: <Play />, onSelect: () => void act.test(r) },
            wp && on && { label: 'Niet meer wachten', icon: <Pause />, onSelect: () => void act.pause(r) },
            { label: 'Historie', icon: <History />, href: `#/m/routines/r/${r.id}?tab=history` },
            { label: 'Instellingen', icon: <Settings2 />, href: `#/m/routines/r/${r.id}?tab=settings` },
            !!thread && { label: 'Naar het gesprek', icon: <MessageSquare />, href: `#/t/${thread}` },
            !wp && 'sep',
            !wp && { label: 'Dupliceren', icon: <Copy />, onSelect: () => void act.duplicate(r) },
          ]}
        />
      </div>
    </li>
  );
}

export function GlobalLimits({ onSaved }: { onSaved?(g: GlobalSettings): void }) {
  const [g, setG] = useState<GlobalSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useAsync();
  useEffect(() => {
    api
      .get<GlobalSettings>('/routines/settings')
      .then(setG)
      .catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="text-sm text-danger">{err}</div>;
  if (!g)
    return (
      <div className="space-y-4" role="status" aria-label="Laden">
        <Skeleton className="h-6 w-56" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </div>
    );
  const save = () =>
    run(async () => {
      const r = await api.put<GlobalSettings>('/routines/settings', g);
      setG(r);
      loadMeta(true).catch(() => {});
      onSaved?.(r);
    }, 'Limieten opgeslagen');
  return (
    <div className="space-y-4">
      <Toggle checked={g.paused} onChange={(v) => setG({ ...g, paused: v })} label="Alle routines pauzeren" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Hoogstens zoveel runs per dag" hint="Alle routines samen. 0 = geen limiet.">
          <Input type="number" min={0} value={g.maxRunsPerDay} onChange={(e) => setG({ ...g, maxRunsPerDay: Number(e.target.value) })} />
        </Field>
        <Field label="Hoogstens zoveel kosten per dag (USD)" hint="Een schatting. 0 = geen limiet.">
          <Input type="number" min={0} step={0.5} value={g.maxCostPerDayUsd} onChange={(e) => setG({ ...g, maxCostPerDayUsd: Number(e.target.value) })} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" onClick={save} loading={busy}>
          Opslaan
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// #/m/routines — "Automatisch": everything that runs by itself, in one list
// ---------------------------------------------------------------------------

type Kind = 'duty' | 'routine' | 'workflow';
const KIND_LABEL: Record<Kind, string> = { duty: 'Vaste taak', routine: 'Routine', workflow: 'Workflow' };
/** A vaste taak is a routine that TeamBot set up for a bot's role (options.duty). */
const kindOf = (r: RoutineView): Kind => ((r.options as { duty?: unknown } | undefined)?.duty ? 'duty' : 'routine');

/** "Nieuw": one question in plain words; each answer leads to the screen that makes it. */
function NewDialog({ onClose }: { onClose(): void }) {
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  const choice = (icon: React.ReactNode, title: string, hint: string, to: string) => (
    <button type="button" onClick={() => go(to)} className="flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-start transition-colors hover:border-line-strong hover:bg-surface-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted [&_svg]:h-4 [&_svg]:w-4" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-[13px] text-muted">{hint}</span>
      </span>
    </button>
  );
  return (
    <Modal open onClose={onClose} title="Wat wil je laten doen?">
      <div className="space-y-2">
        {choice(<AlarmClock />, 'Elke dag of week iets laten doen', 'Een routine: één bot, op vaste tijden.', '/m/routines/r/new')}
        {choice(<Eye />, 'Iets in de gaten houden', 'Een vaste taak: een bot let op en meldt zich.', '/m/routines/werk')}
        {choice(<WorkflowIcon />, 'Meerdere stappen met meerdere bots', 'Een workflow, met jouw akkoord ertussen.', '/m/workflows/')}
      </div>
    </Modal>
  );
}

export function RoutinesPage() {
  const { meta, error: metaErr, reload } = useMeta();
  // Package B4: the overview follows the team switcher (from two teams on).
  const team = useFollowTeam();
  const { list, err, load } = useRoutineList(undefined, team.activeId);
  const flows = useWorkflows();
  const agents = useApp((s) => s.agents);
  const [paused, setPaused] = useState(false);
  // "Eerder gemist": the periods TeamBot was off in the last 30 days, also the ones already seen (#/m/routines/?gemist=1).
  const [missedAll, setMissedAll] = useState(() => query().get('gemist') === '1');
  const [limits, setLimits] = useState(false);
  const [adding, setAdding] = useState(false);
  const [start, setStart] = useState<Workflow | null>(null);
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [q, setQ] = useState('');
  useEffect(() => setPaused(!!meta?.global.paused), [meta]);
  useEffect(() => on('routine.settings', (g: GlobalSettings) => setPaused(g.paused)), []);
  const { busy, run } = useAsync();

  const routines = [...(list || [])].sort((a, b) => Number(b.status === 'draft') - Number(a.status === 'draft') || (a.next_run_at || '9').localeCompare(b.next_run_at || '9'));
  const workflows = flows.data?.workflows || [];
  const total = routines.length + workflows.length;
  const kinds = (['duty', 'routine', 'workflow'] as Kind[]).filter((k) => (k === 'workflow' ? workflows.length : routines.some((r) => kindOf(r) === k)));
  const shown = kinds.includes(kind as Kind) ? kind : 'all';
  const has = (name: string) => !q.trim() || name.toLowerCase().includes(q.trim().toLowerCase());
  const rows = routines.filter((r) => (shown === 'all' || kindOf(r) === shown) && has(r.name));
  const wrows = shown === 'all' || shown === 'workflow' ? workflows.filter((w) => has(w.name)) : [];

  return (
    <Page>
      <PageHeader
        width="5xl"
        title="Automatisch"
        subtitle="Alles wat je bots uit zichzelf doen."
        actions={
          <>
            <Menu
              label="Meer"
              variant="secondary"
              testId="auto-more"
              items={[
                { label: 'Kalender', icon: <CalendarDays />, href: '#/m/routines/kalender' },
                { label: 'Projecten', icon: <Target />, href: '#/m/routines/werk/projecten' },
                { label: 'Kansen', icon: <Lightbulb />, href: '#/m/routines/werk/kansen' },
                'sep',
                { label: 'Limieten', icon: <Gauge />, onSelect: () => setLimits(true) },
                { label: 'Eerder gemist', icon: <PowerOff />, checked: missedAll, onSelect: () => setMissedAll(!missedAll) },
              ]}
            >
              Meer
            </Menu>
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)} disabled={!agents.length}>
              Nieuw
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-5xl space-y-4 px-4 pb-8 pt-2 sm:px-6">
        <TaskLinks current="auto" />
        <TeamFilterNote>Je ziet wat de bots van dit team doen.</TeamFilterNote>
        {metaErr && (
          <div className="text-sm text-danger">
            Status laden mislukt: {metaErr}{' '}
            <button className="underline" onClick={reload}>
              Opnieuw
            </button>
          </div>
        )}
        {paused && (
          <div className="tb-in flex flex-wrap items-center gap-3 rounded-card bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
            <Pause className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 font-medium">Alle routines staan op pauze.</span>
            <Button size="sm" onClick={() => run(async () => setPaused((await api.put<GlobalSettings>('/routines/settings', { paused: false })).paused), 'Routines staan weer aan')} loading={busy}>
              Hervatten
            </Button>
          </div>
        )}
        <AttentionCard />
        <MissedCard all={missedAll} onAll={setMissedAll} />
        {err ? (
          <EmptyState icon={<AlarmClock />} title="Laden mislukt" action={<Button onClick={load}>Opnieuw</Button>}>
            {err}
          </EmptyState>
        ) : !list ? (
          <SkeletonRows n={4} />
        ) : !total ? (
          <EmptyState
            icon={<AlarmClock />}
            title="Nog niets dat vanzelf loopt"
            action={
              agents.length ? (
                <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                  Nieuw
                </Button>
              ) : (
                <Button onClick={() => navigate('/agents/new')}>Eerst een bot maken</Button>
              )
            }
          >
            Laat een bot iets op vaste tijden doen, zoals elke werkdag om 8 uur je agenda samenvatten.
          </EmptyState>
        ) : (
          <>
            {(kinds.length > 1 || total > 8) && (
              <div className="flex flex-wrap items-center gap-2">
                {kinds.length > 1 && <Segmented<Kind | 'all'> label="Soort" size="sm" value={shown} onChange={setKind} options={[{ value: 'all', label: 'Alles' }, ...kinds.map((k) => ({ value: k, label: k === 'duty' ? 'Vaste taken' : k === 'routine' ? 'Routines' : 'Workflows' }))]} />}
                {total > 8 && <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoeken" aria-label="Zoeken in automatisch" className="h-8 w-full sm:ms-auto sm:w-56" />}
              </div>
            )}
            {rows.length + wrows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">Niets gevonden.</p>
            ) : (
              <Card className="p-0">
                <ul className="divide-y divide-line">
                  {rows.map((r) => (
                    <RoutineRow key={r.id} r={r} kind={KIND_LABEL[kindOf(r)]} showTeam={team.multi && !team.activeId} zone={meta?.timezone || r.timezone} />
                  ))}
                  {wrows.map((w) => (
                    <WorkflowRow key={w.id} w={w} kind={KIND_LABEL.workflow} onStart={() => setStart(w)} onRemoved={flows.reload} />
                  ))}
                </ul>
              </Card>
            )}
            {meta && <UptimeNote meta={meta} />}
          </>
        )}
      </div>
      <Modal open={limits} onClose={() => setLimits(false)} title="Limieten voor alle routines">
        <GlobalLimits
          onSaved={(g) => {
            setPaused(g.paused);
            setLimits(false);
          }}
        />
      </Modal>
      {adding && <NewDialog onClose={() => setAdding(false)} />}
      {start && <StartModal w={start} onClose={() => setStart(null)} />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// #/m/routines/r/<id|new>
// ---------------------------------------------------------------------------

type Tab = 'settings' | 'triggers' | 'history';

/** While a routine (or what the editor needs) loads: the shape of the page, so nothing jumps. */
function DetailSkeleton() {
  return (
    <Page>
      <div className="mx-auto max-w-3xl space-y-4 px-4 pt-8 sm:px-6" role="status" aria-label="Laden">
        <Skeleton className="h-7 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-12 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    </Page>
  );
}

export function RoutineDetailPage({ params }: { params: string[] }) {
  const id = params[0] || 'new';
  const { meta, error: metaErr, reload } = useMeta();
  const agents = useApp((s) => s.agents);
  const [r, setR] = useState<RoutineView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (['settings', 'triggers', 'history'].includes(query().get('tab') || '') ? (query().get('tab') as Tab) : 'history'));
  const [del, setDel] = useState(false);
  const [delThread, setDelThread] = useState(false);
  const act = useRoutineActions();
  const { busy, run } = useAsync();

  const load = useCallback(() => {
    if (id === 'new') return;
    api
      .get<RoutineView>(`/routines/${id}`)
      .then((x) => (setR(x), setErr(null)))
      .catch((e) => setErr(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    const a = on('routine.updated', (x: RoutineView) => x.id === id && setR((cur) => (cur ? { ...cur, ...x } : cur)));
    const b = on('routine.deleted', (x: { id: string }) => x.id === id && navigate('/m/routines'));
    return () => {
      a();
      b();
    };
  }, [id]);

  if (metaErr)
    return (
      <EmptyState icon={<AlarmClock />} title="Laden mislukt" action={<Button onClick={reload}>Opnieuw</Button>}>
        {metaErr}
      </EmptyState>
    );
  if (!meta) return <DetailSkeleton />;

  if (id === 'new') {
    const pre = query().get('agent');
    const agentId = agents.find((a) => a.id === pre)?.id || agents[0]?.id || '';
    const save = async (d: Draft) => {
      const created = await api.post<RoutineView>('/routines', d);
      toast('Routine aangemaakt', 'ok');
      // Open on what was just set up (schedule and task), not on Triggers.
      navigate(`/m/routines/r/${created.id}?tab=settings`);
    };
    return (
      <Page>
        <PageHeader width="3xl" title="Nieuwe routine" subtitle="Kies een bot, wat hij moet doen en wanneer." back={{ href: '#/m/routines/', label: 'Automatisch' }} />
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 sm:px-6">
          <RoutineEditor meta={meta} initial={emptyDraft(meta, agentId)} onSave={save} onCancel={() => history.back()} saveLabel="Routine aanmaken" />
        </div>
      </Page>
    );
  }

  if (err)
    return (
      <EmptyState icon={<AlarmClock />} title="Routine niet gevonden" action={<Button onClick={() => navigate('/m/routines')}>Naar alle routines</Button>}>
        {err}
      </EmptyState>
    );
  if (!r) return <DetailSkeleton />;

  const st = routineStatus(r);
  const agent = agents.find((a) => a.id === r.agent_id);
  const save = async (d: Draft) => {
    setR(await api.patch<RoutineView>(`/routines/${r.id}`, d));
    toast('Opgeslagen', 'ok');
  };
  const remove = () =>
    run(async () => {
      await api.del(`/routines/${r.id}${delThread ? '?deleteThread=1' : ''}`);
      toast('Routine verwijderd', 'ok');
      navigate('/m/routines');
    });

  return (
    <Page>
      <PageHeader
        width="3xl"
        back={{ href: '#/m/routines/', label: 'Automatisch' }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="[overflow-wrap:anywhere]" translate="no">
              {r.name}
            </span>
            <Badge tone={st.tone}>{st.label}</Badge>
          </span>
        }
        subtitle={`${agent?.name || r.agentName || 'Onbekende bot'} · ${r.scheduleText}${r.schedule.kind !== 'none' && r.timezone !== meta.timezone ? ` · ${r.timezone}` : ''}`}
        actions={
          <>
            <Menu
              label="Meer opties"
              variant="secondary"
              items={[
                r.status === 'active' && { label: 'Pauzeren', icon: <Pause />, onSelect: () => void act.pause(r) },
                r.status !== 'active' && r.status !== 'draft' && { label: 'Hervatten', icon: <Play />, onSelect: () => void act.resume(r) },
                !!r.thread_id && { label: 'Naar het gesprek', icon: <MessageSquare />, href: `#/t/${r.thread_id}` },
                { label: 'Dupliceren', icon: <Copy />, onSelect: () => void act.duplicate(r) },
                'sep',
                { label: 'Verwijderen', icon: <Trash2 />, danger: true, onSelect: () => setDel(true) },
              ]}
            />
            {r.status === 'draft' ? (
              <Button variant="primary" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => act.confirm(r)} loading={act.busy}>
                Bevestigen
              </Button>
            ) : (
              <Button icon={<Play className="h-4 w-4" />} onClick={() => (act.test(r), setTab('history'))} disabled={act.busy}>
                Nu testen
              </Button>
            )}
          </>
        }
      />
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 sm:px-6">
        {r.status === 'paused' && r.paused_reason && <div className={r.paused_reason.startsWith('Automatisch') ? 'rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger' : 'rounded-control bg-surface-2 px-3 py-2.5 text-sm text-muted'}>{r.paused_reason}</div>}
        {r.status === 'draft' && <div className="rounded-control bg-warn-soft px-3 py-2.5 text-sm text-warn">{r.created_by === 'agent' ? t('{0} stelt deze routine voor. Hij start pas na “Bevestigen”.', agent?.name || 'De bot') : 'Een concept: hij start pas na “Bevestigen”.'}</div>}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            <span className="text-muted">Volgende run: </span>
            {r.next_run_at ? fmtDate(r.next_run_at, r.timezone) : '—'}
          </span>
          <span>
            <span className="text-muted">Laatste run: </span>
            {r.last_run_at ? `${fmtDate(r.last_run_at, r.timezone)} (${(RUN_STATUS[r.last_status || '']?.label || r.last_status || '').toLowerCase()})` : '—'}
          </span>
          {r.fail_count > 0 && <span className="text-danger">{t('{0, plural, one {# fout op rij} other {# fouten op rij}}', r.fail_count)}</span>}
        </div>
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'history', label: 'Historie' },
            { id: 'triggers', label: `Triggers${r.triggerCount ? ` (${r.triggerCount})` : ''}` },
            { id: 'settings', label: 'Instellingen' },
          ]}
        />
        {tab === 'history' && <HistoryTab routineId={r.id} tz={r.timezone} />}
        {tab === 'triggers' && <TriggersTab routineId={r.id} meta={meta} tz={r.timezone} routineActive={r.status === 'active'} />}
        {tab === 'settings' && <RoutineEditor key={r.updated_at} meta={meta} initial={draftFrom(r)} onSave={save} routineId={r.id} />}
      </div>
      <Modal
        open={del}
        onClose={() => setDel(false)}
        title="Routine verwijderen?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDel(false)}>
              Annuleren
            </Button>
            <Button variant="danger" onClick={remove} loading={busy}>
              Verwijderen
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>{t('“{0}” stopt voorgoed; ook de triggers en de historie gaan weg.', r.name)}</p>
          {r.thread_id && <Toggle checked={delThread} onChange={setDelThread} label="Ook het routinegesprek verwijderen" />}
        </div>
      </Modal>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Bot editor section
// ---------------------------------------------------------------------------

export function AgentRoutinesSection({ agent, onChange }: { agent: { id?: string; tool_groups?: string[] } & Record<string, any>; onChange(p: any): void }) {
  const groups: string[] = agent.tool_groups || [];
  const enabled = groups.includes('routines');
  const { list, err, load } = useRoutineList(agent.id || '__none__');
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Toggle checked={enabled} onChange={(v) => onChange({ tool_groups: v ? [...groups, 'routines'] : groups.filter((g) => g !== 'routines') })} label="Mag routines voorstellen via de chat" />
        <div className="text-xs text-muted">Dan kun je zeggen “herinner me elke maandag om 9 uur aan X”. Je keurt de routine eerst goed.</div>
      </div>
      {!agent.id ? (
        <div className="text-sm text-muted">Sla de bot eerst op om routines voor hem te maken.</div>
      ) : err ? (
        <div className="text-sm text-danger">
          {err}{' '}
          <button className="underline" onClick={load}>
            Opnieuw
          </button>
        </div>
      ) : !list ? (
        <Skeleton className="h-10" />
      ) : (
        <>
          {list.length === 0 ? (
            <div className="text-sm text-muted">Deze bot heeft nog geen routines.</div>
          ) : (
            <ul className="divide-y divide-line rounded-control border border-line">
              {list.map((r) => {
                const st = routineStatus(r);
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <a href={`#/m/routines/r/${r.id}`} className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere] hover:underline">
                      {r.name}
                    </a>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    <span className="w-full text-xs text-muted sm:w-auto">{r.next_run_at ? t('volgende: {0}', fmtDate(r.next_run_at, r.timezone)) : r.scheduleText}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => navigate(`/m/routines/r/new?agent=${agent.id}`)}>
            Nieuwe routine voor deze bot
          </Button>
        </>
      )}
    </div>
  );
}
