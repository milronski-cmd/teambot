import { useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import { Check, CircleAlert, Lightbulb, Plug, ShieldCheck, Newspaper, FolderKanban } from 'lucide-react';
import { SkeletonRows } from '../../components/overview';
import { MoreOptions } from '../../components/MoreOptions';
import { TaskLinks } from './Head';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import { PlannedList } from './Planned';
import { Badge, Button, Card, EmptyState, Input, Page, PageHeader, Select, Tabs, cx, timeAgo, toast, toastError, CardHead, IconTile } from '../../components/ui';
import { teamQuery, useTeamView } from '../teams/scope';
import { TeamFilterNote } from '../teams/FilterNote';

/**
 * Werk (#/m/routines/werk/<tab>): what the team does by itself.
 *  - Vaste taken: what each bot watches, what it last found, and what it still needs from you;
 *  - Projecten: one progress line per project (inspectie → tip-top), with the sprint and what waits;
 *  - Kansen: the board of opportunities, each with its sources and dates; yours to say yes or no.
 * On top: the one budget setting for proactive work and the main bot's last overview.
 */

interface DutyView {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  teamName: string;
  status: string;
  when: string;
  duty: { key: string; guard?: boolean };
  needs: string | null;
  /** Parked by TeamBot until what it needs is there. */
  parked?: boolean;
  last: { status: string | null; summary: string | null; at: string | null };
  openTasks: number;
}
/** A routine TeamBot once made by itself and archived at the clean-up because it never produced anything. */
interface Archived {
  id: string;
  name: string;
  agentName: string;
  reason: string;
  runs: number;
}
/** The work loop: what lies there for a bot now, and how its last turn went. */
interface WorkView {
  agentId: string;
  agentName: string;
  items: { ref: string; text: string }[];
  last: { at: number; result: 'gewerkt' | 'niets' | 'fout'; text: string } | null;
  waits: string | null;
}
interface Budget {
  limit: number;
  used: number;
  left: number | null;
}
interface Settings {
  runsPerDay: number;
  cheapFirst: boolean;
  maxSprint: number;
  briefing: 'dag' | 'week' | 'uit';
  briefingTime: string;
  interests: string;
}
interface Project {
  id: number;
  teamId: string | null;
  teamName: string;
  naam: string;
  site: string | null;
  doel: string | null;
  eigenaar: string | null;
  fase: string;
  status: 'sprint' | 'wacht' | 'tiptop' | 'gestopt';
  step: number;
  next: string;
  nulmeting: string | null;
  meting: string | null;
  werklog: string | null;
  tasks: { total: number; open: number; done: number };
}
export interface Kans {
  id: number;
  teamId: string | null;
  teamName: string;
  titel: string;
  wat: string;
  waarom_nu: string;
  bronnen: { url: string; titel: string; datum: string }[];
  kosten: string;
  risico: string;
  minitest: string;
  score: number | null;
  gevonden_door: string;
  status: 'nieuw' | 'gescoord' | 'voorgelegd' | 'ja' | 'nee' | 'later';
}

const STEPS = ['Inspectie', 'Diagnose', 'Plan', 'Uitvoeren', 'Meten', 'Tip-top'];
const TABS = [
  { id: 'vast' as const, label: 'Vaste taken' },
  { id: 'projecten' as const, label: 'Projecten' },
  { id: 'kansen' as const, label: 'Kansen' },
];
type TabId = (typeof TABS)[number]['id'];

// ------------------------------------------------------------------ kansen that wait for you (also in "Wacht op jou")

const useKansen = create<{ list: Kans[]; loaded: boolean }>(() => ({ list: [], loaded: false }));
let wired = false;
export function loadKansen() {
  return api
    .get<{ kansen: Kans[] }>('/proactive/kansen')
    .then((r) => useKansen.setState({ list: r.kansen, loaded: true }))
    .catch(() => useKansen.setState({ loaded: true }));
}
export function initKansen() {
  if (wired) return;
  wired = true;
  void loadKansen();
  on('teamdata.changed', (d: any) => {
    if (!d?.tables || d.tables.includes('kansen')) void loadKansen();
  });
}
export const useKansenCount = () => useKansen((s) => s.list.filter((k) => k.status === 'voorgelegd').length);

function KansCard({ k, showTeam }: { k: Kans; showTeam: boolean }) {
  const [busy, setBusy] = useState('');
  const decide = async (choice: 'ja' | 'nee' | 'later') => {
    setBusy(choice);
    try {
      const r = await api.post<{ note: string }>(`/proactive/kansen/${k.id}/decide`, { choice, teamId: k.teamId });
      toast(r.note, choice === 'ja' ? 'ok' : 'neutral');
      await loadKansen();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy('');
    }
  };
  const open = k.status === 'voorgelegd' || k.status === 'gescoord' || k.status === 'later';
  return (
    <Card className="space-y-2 p-4" data-testid="kans-card">
      <div className="flex flex-wrap items-center gap-2">
        <IconTile icon={Lightbulb} tone="orange" />
        <h3 className="min-w-0 flex-1 font-semibold">{k.titel}</h3>
        {k.score !== null && <Badge tone="accent">Score {k.score}</Badge>}
        {k.status === 'ja' && <Badge tone="ok">Ja: mini-test loopt</Badge>}
        {k.status === 'nee' && <Badge>Nee</Badge>}
        {k.status === 'nieuw' && <Badge>Nog niet gescoord</Badge>}
        {showTeam && k.teamName && <Badge>{k.teamName}</Badge>}
      </div>
      <p className="text-sm">{k.wat}</p>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Waarom nu</dt>
        <dd>{k.waarom_nu}</dd>
        <dt className="text-muted">Bewijs</dt>
        <dd className="space-y-0.5">
          {k.bronnen.map((b) => (
            <div key={b.url} className="break-all">
              <a href={b.url} target="_blank" rel="noreferrer noopener" className="text-accent underline">
                {b.titel || b.url}
              </a>{' '}
              <span className="text-muted">({b.datum})</span>
            </div>
          ))}
        </dd>
        <dt className="text-muted">Kosten</dt>
        <dd>{k.kosten}</dd>
        <dt className="text-muted">Risico</dt>
        <dd>{k.risico}</dd>
        <dt className="text-muted">Mini-test</dt>
        <dd>{k.minitest}</dd>
      </dl>
      {open && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="primary" size="sm" loading={busy === 'ja'} onClick={() => void decide('ja')}>
            Ja, test dit
          </Button>
          <Button size="sm" loading={busy === 'later'} onClick={() => void decide('later')}>
            Later
          </Button>
          <Button size="sm" variant="ghost" loading={busy === 'nee'} onClick={() => void decide('nee')}>
            Nee
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Under "Wacht op jou": the opportunities of this week that wait for a yes or no. */
export function KansenInbox() {
  // (Filter outside the selector: a selector must return the same value for the same state.)
  const list = useKansen((s) => s.list).filter((k) => k.status === 'voorgelegd');
  const teams = new Set(list.map((k) => k.teamId)).size > 1;
  if (!list.length) return null;
  return (
    <section className="space-y-3" aria-label="Kansen">
      <h2 className="text-sm font-semibold">Kansen van deze week</h2>
      {list.map((k) => (
        <KansCard key={`${k.teamId}:${k.id}`} k={k} showTeam={teams} />
      ))}
    </section>
  );
}

// ------------------------------------------------------------------ the page

/** The owner's optional maximum of projects in the sprint (empty = none, the default); over it a new one waits. */
function SprintLimit({ settings, perTeam, onSaved }: { settings: Settings; perTeam: boolean; onSaved(): void }) {
  const [n, setN] = useState(String(settings.maxSprint));
  useEffect(() => setN(String(settings.maxSprint)), [settings.maxSprint]);
  const save = async () => {
    if ((Number(n) || 0) === settings.maxSprint) return;
    try {
      await api.put('/proactive/settings', { maxSprint: Number(n) || 0 });
      onSaved();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-muted">
      <span>{perTeam ? 'Hoogstens tegelijk in de sprint, per team:' : 'Hoogstens tegelijk in de sprint:'}</span>
      <Input className="w-24" type="number" min={0} value={n === '0' ? '' : n} placeholder="geen" onChange={(e) => setN(e.target.value || '0')} onBlur={() => void save()} aria-label="Hoogstens zoveel projecten tegelijk in de sprint (leeg = geen limiet)" />
      <span>{settings.maxSprint > 0 ? 'projecten; de rest wacht op zijn beurt.' : 'projecten (leeg = geen limiet).'}</span>
    </label>
  );
}

function BudgetBar({ budget, settings, onSaved }: { budget: Budget; settings: Settings; onSaved(): void }) {
  const [n, setN] = useState(String(settings.runsPerDay));
  const [briefing, setBriefing] = useState(settings.briefing);
  useEffect(() => {
    setN(String(settings.runsPerDay));
    setBriefing(settings.briefing);
  }, [settings.runsPerDay, settings.briefing]);
  const save = async (patch: Partial<Settings>) => {
    try {
      await api.put('/proactive/settings', patch);
      onSaved();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Card className="flex flex-wrap items-end gap-x-6 gap-y-3 p-4" data-testid="proactive-budget">
      <label className="text-sm">
        <span className="block font-semibold">Werk uit zichzelf: hoogstens per dag</span>
        <span className="flex items-center gap-2">
          <Input className="w-24" type="number" min={0} value={n === '0' ? '' : n} placeholder="geen" onChange={(e) => setN(e.target.value || '0')} onBlur={() => Number(n) !== settings.runsPerDay && void save({ runsPerDay: Number(n) || 0 })} aria-label="Limiet: botbeurten per dag voor proactief werk (leeg = geen limiet)" />
          <span className="text-muted">botbeurten (leeg = geen limiet)</span>
        </span>
      </label>
      <div className="text-sm">
        <span className="block font-semibold">Vandaag</span>
        <span className="tabular-nums">{budget.limit ? `${budget.used} van ${budget.limit} botbeurten` : budget.used === 1 ? '1 botbeurt' : `${budget.used} botbeurten`}</span>
        <span className="text-muted"> · controles zonder AI tellen niet mee</span>
      </div>
      <label className="text-sm">
        <span className="block font-semibold">Overzicht van de hoofdbot</span>
        <Select
          value={briefing}
          onChange={(e) => {
            setBriefing(e.target.value as Settings['briefing']);
            void save({ briefing: e.target.value as Settings['briefing'] });
          }}
        >
          <option value="dag">Elke dag</option>
          <option value="week">Elke week</option>
          <option value="uit">Uit</option>
        </Select>
      </label>
    </Card>
  );
}

function DutyRow({ d, showTeam }: { d: DutyView; showTeam: boolean }) {
  const ok = !d.needs && (d.last.status === 'no_update' || d.last.status === 'done') && !d.openTasks;
  return (
    <a href={`#/m/routines/r/${d.id}`} className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-xl border p-3 hover:bg-surface-2" data-testid="duty-row">
      <span className="mt-0.5" aria-hidden>
        {d.needs ? <Plug className="h-4 w-4 text-muted" /> : d.openTasks ? <CircleAlert className="h-4 w-4 text-warn" /> : ok ? <Check className="h-4 w-4 text-ok" /> : <ShieldCheck className="h-4 w-4 text-muted" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{d.name}</span>
        <span className="block text-sm text-muted">
          <span translate="no">{d.agentName}</span> · {d.when}
          {showTeam && d.teamName ? ` · ${d.teamName}` : ''}
        </span>
        <span className={cx('block text-sm', d.needs && 'font-medium')}>{d.needs || d.last.summary || 'Nog niet gecontroleerd'}</span>
      </span>
      <span className="flex items-center gap-1.5">
        {d.duty.guard && <Badge>Bewaker</Badge>}
        {d.status === 'paused' && <Badge tone="warn">{d.parked ? 'Wacht' : 'Uit'}</Badge>}
        {d.openTasks > 0 && <Badge tone="warn">{d.openTasks === 1 ? '1 taak open' : `${d.openTasks} taken open`}</Badge>}
        {d.last.at && <span className="text-xs text-muted">{timeAgo(d.last.at)}</span>}
      </span>
    </a>
  );
}

function ProjectCard({ p, showTeam, onChanged }: { p: Project; showTeam: boolean; onChanged(): void }) {
  const [open, setOpen] = useState(false);
  const stop = async () => {
    try {
      await api.post(`/proactive/projects/${p.id}/stop`, { teamId: p.teamId });
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Card className="space-y-3 p-4" data-testid="project-card">
      <div className="flex flex-wrap items-center gap-2">
        <IconTile icon={FolderKanban} tone="teal" />
        <h3 className="min-w-0 flex-1 font-semibold">{p.naam}</h3>
        {p.status === 'wacht' && <Badge>Wacht op plek</Badge>}
        {p.status === 'tiptop' && <Badge tone="ok">Tip-top</Badge>}
        {p.status === 'gestopt' && <Badge>Gestopt</Badge>}
        {showTeam && p.teamName && <Badge>{p.teamName}</Badge>}
      </div>
      <ol className="flex gap-1" aria-label={t('Stap {0} van 6: {1}', Math.min(p.step + 1, 6), t(STEPS[p.step]))}>
        {STEPS.map((s, i) => (
          <li key={s} className="min-w-0 flex-1">
            <div className={cx('h-1.5 rounded-full', i < p.step || p.status === 'tiptop' ? 'bg-ok' : i === p.step && p.status === 'sprint' ? 'bg-accent' : 'bg-surface-3')} />
            <div className={cx('mt-1 truncate text-[11px]', i === p.step ? 'font-semibold' : 'text-muted')}>{s}</div>
          </li>
        ))}
      </ol>
      <p className="text-sm">
        {p.next}
        {p.tasks.total > 0 && (
          <span className="text-muted">
            {' '}
            · {t('{0} van {1, plural, one {# taak} other {# taken}} klaar', p.tasks.done, p.tasks.total)}
          </span>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Minder' : 'Cijfers en werklog'}
        </Button>
        {(p.status === 'sprint' || p.status === 'wacht') && (
          <Button size="sm" variant="ghost" onClick={() => void stop()}>
            Stoppen
          </Button>
        )}
      </div>
      {open && (
        <dl className="space-y-2 text-sm">
          {p.doel && (
            <div>
              <dt className="text-muted">Doel</dt>
              <dd>{p.doel}</dd>
            </div>
          )}
          <div>
            <dt className="text-muted">Nulmeting</dt>
            <dd className="whitespace-pre-wrap">{p.nulmeting || 'Nog niet gemeten'}</dd>
          </div>
          {p.meting && (
            <div>
              <dt className="text-muted">Laatste meting</dt>
              <dd className="whitespace-pre-wrap">{p.meting}</dd>
            </div>
          )}
          {p.werklog && (
            <div>
              <dt className="text-muted">Werklog</dt>
              <dd className="whitespace-pre-wrap">{p.werklog}</dd>
            </div>
          )}
        </dl>
      )}
    </Card>
  );
}

function NewProject({ teamId, onDone }: { teamId: string; onDone(): void }) {
  const [naam, setNaam] = useState('');
  const [site, setSite] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ note: string }>('/proactive/projects', { naam, site, doel: site ? `${site} tip-top maken` : naam, teamId: teamId || undefined });
      toast(r.note, 'ok');
      setNaam('');
      setSite('');
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (naam.trim()) void go();
      }}
    >
      <Input className="min-w-[10rem] flex-1" placeholder="Nieuw project, bijv. Raamwinkel tip-top" value={naam} onChange={(e) => setNaam(e.target.value)} aria-label="Naam van het project" />
      <Input className="w-48" placeholder="Website (mag leeg)" value={site} onChange={(e) => setSite(e.target.value)} aria-label="Website" />
      <Button type="submit" variant="primary" loading={busy} disabled={!naam.trim()}>
        Starten
      </Button>
    </form>
  );
}

export function WerkPage({ params }: { params: string[] }) {
  const tab: TabId = (TABS.find((t) => t.id === params[0])?.id || 'vast') as TabId;
  const { activeId } = useTeamView();
  const teams = useTeamView().teams || [];
  const multi = teams.length > 1;
  const agents = useApp((s) => s.agents);
  const [duties, setDuties] = useState<DutyView[] | null>(null);
  const [archived, setArchived] = useState<Archived[]>([]);
  const [work, setWork] = useState<WorkView[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [briefing, setBriefing] = useState<{ text: string; at: number } | null>(null);
  const kansen = useKansen((s) => s.list).filter((k) => !activeId || k.teamId === activeId);

  const load = useCallback(() => {
    void api
      .get<{ duties: DutyView[]; budget: Budget; settings: Settings; archived?: Archived[] }>(`/proactive/duties${teamQuery()}`)
      .then((r) => {
        setDuties(r.duties);
        setArchived(r.archived || []);
        setBudget(r.budget);
        setSettings(r.settings);
      })
      .catch(toastError);
    void api
      .get<{ projects: Project[] }>(`/proactive/projects${activeId ? `?team=${encodeURIComponent(activeId)}` : ''}`)
      .then((r) => setProjects(r.projects))
      .catch(toastError);
    void api.get<{ text: string; at: number }>('/proactive/briefing').then(setBriefing).catch(() => {});
    void api.get<{ work: WorkView[] }>('/proactive/work').then((r) => setWork(r.work || [])).catch(() => {});
    void loadKansen();
  }, [activeId]);
  useEffect(() => {
    load();
    const offs = [on('teamdata.changed', load), on('routine.updated', load), on('proactive.settings', load), on('proactive.work', load), on('rooms.task', load)];
    return () => offs.forEach((off) => off());
  }, [load]);

  const hasPrive = teams.some((t: any) => /^priv[ée]/i.test(t.name));
  const makePrive = async () => {
    try {
      await api.post('/team-templates/prive/install', {});
      toast('Je privé-team staat klaar: Assistent, Opzoeker en Kasboek.', 'ok');
      load();
    } catch (e) {
      toastError(e);
    }
  };
  const restore = async (a: Archived) => {
    try {
      await api.post(`/proactive/archived/${a.id}/restore`, {});
      toast('Teruggezet.', 'ok');
      load();
    } catch (e) {
      toastError(e);
    }
  };
  const needs = [...new Set((duties || []).filter((d) => d.needs && (d.status === 'active' || d.parked)).map((d) => d.needs!))];
  const sprint = (projects || []).filter((p) => p.status === 'sprint');
  const rest = (projects || []).filter((p) => p.status !== 'sprint');

  return (
    <Page>
      <PageHeader title="Werk" subtitle="Wat je team uit zichzelf doet." back={{ href: '#/m/routines/', label: 'Automatisch' }} />
      <div className="mx-auto w-full max-w-4xl space-y-4 px-4 pb-10">
        {/* The same two links as on Taken and Automatisch (this page hangs under Automatisch). */}
        <TaskLinks current="auto" />
        <TeamFilterNote />
        {/* The one list of everything that will start by itself, and what can be switched on. */}
        <PlannedList />
        {briefing?.text && (
          <Card className="p-4" data-testid="last-briefing">
            <CardHead className="mb-2" icon={Newspaper} tone="orange" title={<>Laatste overzicht {briefing.at ? <span className="font-normal text-muted">· {timeAgo(new Date(briefing.at).toISOString())}</span> : null}</>} />
            <div className="whitespace-pre-wrap text-sm">{briefing.text.replace(/\*\*/g, '').replace(/(^|\n)_|_(\n|$)/g, '$1$2')}</div>
          </Card>
        )}
        {work.some((w) => w.items.length > 0) && (
          <Card className="space-y-2 p-4" data-testid="work-now">
            <CardHead icon={FolderKanban} tone="orange" title="Werk dat er nu ligt" />
            {work
              .filter((w) => w.items.length > 0)
              .map((w) => (
                <div key={w.agentId} className="border-t pt-2 text-sm first:border-t-0 first:pt-0">
                  <span className="font-medium" translate="no">
                    {w.agentName}
                  </span>
                  <span className="text-muted"> · {w.items.length === 1 ? '1 punt' : `${w.items.length} punten`}</span>
                  {w.waits && <span className="text-muted"> · {w.waits}</span>}
                  {w.items.slice(0, 3).map((i) => (
                    <div key={i.ref} className="truncate text-muted">
                      {i.text}
                    </div>
                  ))}
                  {w.last?.text && <div className="truncate">Laatste beurt: {w.last.text}</div>}
                </div>
              ))}
          </Card>
        )}
        <Tabs tabs={TABS.map((t) => (t.id === 'kansen' && kansen.some((k) => k.status === 'voorgelegd') ? { ...t, label: `Kansen (${kansen.filter((k) => k.status === 'voorgelegd').length})` } : t))} value={tab} onChange={(v) => (location.hash = `#/m/routines/werk/${v}`)} />

        {tab === 'vast' &&
          (duties === null ? (
            <SkeletonRows n={4} avatar={false} />
          ) : (
            <div className="space-y-3">
              {needs.length > 0 && (
                <Card className="space-y-1 p-4" data-testid="proactive-needs">
                  <CardHead icon={CircleAlert} tone="orange" title="Nodig van jou" />
                  {needs.map((n) => (
                    <div key={n} className="text-sm">
                      {n}
                    </div>
                  ))}
                </Card>
              )}
              {duties.length === 0 ? (
                <EmptyState title="Nog geen vaste taken" icon={<ShieldCheck className="h-6 w-6" />}>
                  Een bot krijgt niets vanzelf. Vraag hem iets in de gaten te houden, bijvoorbeeld “kijk elke ochtend of de site werkt”.
                </EmptyState>
              ) : (
                duties.map((d) => <DutyRow key={d.id} d={d} showTeam={multi && !activeId} />)
              )}
              {archived.length > 0 && (
                <Card className="space-y-2 p-4" data-testid="proactive-archived">
                  <CardHead icon={ShieldCheck} tone="orange" title="Opgeruimd" />
                  <p className="text-sm text-muted">Deze routines maakte TeamBot ooit zelf aan. Ze leverden nooit iets op en staan daarom uit. Niets is weg.</p>
                  {archived.map((a) => (
                    <div key={a.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t pt-2">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">
                          {a.name} <span className="font-normal text-muted">· <span translate="no">{a.agentName}</span></span>
                        </span>
                        <span className="block text-sm text-muted">{a.reason}</span>
                      </span>
                      <Button onClick={() => void restore(a)}>Terugzetten</Button>
                    </div>
                  ))}
                </Card>
              )}
              {!hasPrive && agents.length > 0 && (
                <div className="pt-2">
                  <Button onClick={() => void makePrive()}>Privé-team maken</Button>
                </div>
              )}
            </div>
          ))}

        {tab === 'projecten' &&
          (projects === null ? (
            <SkeletonRows n={4} avatar={false} />
          ) : (
            <div className="space-y-3">
              <NewProject teamId={activeId} onDone={load} />
              {settings && <SprintLimit settings={settings} perTeam={multi} onSaved={load} />}
              {sprint.map((p) => (
                <ProjectCard key={`${p.teamId}:${p.id}`} p={p} showTeam={multi && !activeId} onChanged={load} />
              ))}
              {rest.map((p) => (
                <ProjectCard key={`${p.teamId}:${p.id}`} p={p} showTeam={multi && !activeId} onChanged={load} />
              ))}
              {projects.length === 0 && <EmptyState title="Nog geen projecten">Een project maakt één ding tip-top in een paar dagen: meten, plan, uitvoeren, opnieuw meten.</EmptyState>}
            </div>
          ))}

        {tab === 'kansen' && (
          <div className="space-y-3">
            {kansen.length === 0 ? (
              <EmptyState title="Nog geen kansen" icon={<Lightbulb className="h-6 w-6" />}>
                Vraag een bot om kansen te zoeken. Wat hij vindt, komt hier te staan.
              </EmptyState>
            ) : (
              [...kansen].sort((a, b) => Number(b.status === 'voorgelegd') - Number(a.status === 'voorgelegd') || (b.score || 0) - (a.score || 0)).map((k) => <KansCard key={`${k.teamId}:${k.id}`} k={k} showTeam={multi && !activeId} />)
            )}
          </div>
        )}
        {/* Rarely changed: the daily limit and how often the main bot reports. */}
        {budget && settings && (
          <MoreOptions>
            <BudgetBar budget={budget} settings={settings} onSaved={load} />
          </MoreOptions>
        )}
      </div>
    </Page>
  );
}
