import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Bell, Bot, CircleCheck, CircleX, Copy, GitBranch, Hand, History, Pencil, Play, Plus, RotateCcw, Square, Trash2, Workflow as WorkflowIcon, LayoutTemplate, ListOrdered, Clock } from 'lucide-react';
import { Fold, Menu, Skeleton, SkeletonRows } from '../../components/overview';
import { MoreInfo } from '../../components/MoreInfo';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { agentById, useApp } from '../../lib/store';
import type { Approval } from '../../lib/types';
import { BotAvatar } from '../../components/BotFace';
import { askConfirm, Badge, Button, Card, EmptyState, Field, Input, Modal, Page, PageHeader, SectionTitle, Select, Spinner, Textarea, Toggle, timeAgo, toast, toastError, useAsync, copyText } from '../../components/ui';
import { Markdown } from '../../shell/Markdown';
import { useDecide } from '../../shell/approvalDecide';
import { DAY_NAMES, STATUS_TEXT, STATUS_TONE, TRIGGER_TEXT, newStepId, useRun, useWorkflows, type Run, type RunRow, type Schedule, type Step, type Template, type TraceItem, type Version, type Workflow } from './api';
import { tText } from '../../lib/format';

const KIND_ICON = { bot: Bot, condition: GitBranch, approval: Hand, notify: Bell } as const;
const KIND_TEXT: Record<Step['kind'], string> = { bot: 'Een bot doet iets', condition: 'Controle', approval: 'Jouw akkoord', notify: 'Melding aan jou' };

function scheduleText(s: Schedule): string {
  if (s.kind === 'daily') return `Elke dag om ${s.time}`;
  if (s.kind === 'weekly') return `Elke ${s.days.map((d) => DAY_NAMES[d]).join(', ')} om ${s.time}`;
  return '';
}

function StatusBadge({ status }: { status: Run['status'] }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>;
}

/** The faces of the bots that take part, in order. */
function Bots({ steps }: { steps: Step[] }) {
  const ids = [...new Set(steps.flatMap((s) => (s.kind === 'bot' ? [s.agentId] : [])))];
  return (
    <div className="flex -space-x-1.5">
      {ids.slice(0, 6).map((id) => {
        const a = agentById(id);
        return <BotAvatar key={id} bot={a || { id, name: '?' }} size={24} className="ring-2 ring-surface" />;
      })}
    </div>
  );
}

// ---------------------------------------------------------------- start

export function StartModal({ w, hint, onClose }: { w: Workflow; hint?: string; onClose(): void }) {
  const [input, setInput] = useState('');
  const { busy, run } = useAsync();
  const go = () =>
    run(async () => {
      const from = location.hash;
      const r = await api.post<Run>(`/workflows/${w.id}/run`, { input });
      onClose();
      navigate(`#/m/workflows/run/${r.id}`, { from });
    });
  return (
    <Modal
      open
      onClose={onClose}
      title={tText('“{0}” starten', w.name)}
      footer={
        <>
          <Button onClick={onClose}>Annuleren</Button>
          <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={busy} onClick={go}>
            Starten
          </Button>
        </>
      }
    >
      <Field label="Waar moet de workflow mee werken?" hint={hint || 'Bijvoorbeeld de opdracht, het onderwerp of het bericht. Mag leeg blijven.'}>
        <Textarea rows={5} value={input} onChange={(e) => setInput(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- overview

function TemplateCard({ tpl, onUse, busy }: { tpl: Template; onUse(): void; busy: boolean }) {
  return (
    <Card className="tb-in flex flex-col gap-2 p-4">
      <div className="text-[15px] font-bold tracking-tight">{tpl.name}</div>
      <p className="flex-1 text-sm leading-relaxed text-muted">{tpl.description}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{t('{0, plural, one {# stap} other {# stappen}}', tpl.steps)}</span>
        <Button size="sm" loading={busy} onClick={onUse}>
          Gebruiken
        </Button>
      </div>
    </Card>
  );
}

/**
 * One workflow as a row: what it is, when it runs, one signal (off, or how the last run went), who takes part, and
 * the one thing you do with it (start it, or look at the run that is going). The row opens it; the rest is behind "⋯".
 */
export function WorkflowRow({ w, onStart, onRemoved, kind }: { w: Workflow; onStart(): void; onRemoved(): void; /** In the list "Automatisch": the type label, and the first bot's face in front like the other rows. */ kind?: string }) {
  const first = w.steps.find((s) => s.kind === 'bot');
  const face = kind ? (first && first.kind === 'bot' ? agentById(first.agentId) : null) : null;
  const going = !!w.lastRun && (w.lastRun.status === 'running' || w.lastRun.status === 'waiting');
  const remove = async () => {
    if (!(await askConfirm(`Workflow “${w.name}” verwijderen? Ook de runs en eerdere versies gaan weg.`, { ok: 'Verwijderen', danger: true }))) return;
    try {
      await api.del(`/workflows/${w.id}`);
      onRemoved();
    } catch (e) {
      toastError(e);
    }
  };
  const line = [w.description || t('{0, plural, one {# stap} other {# stappen}}', w.steps.length), w.schedule.kind !== 'none' ? scheduleText(w.schedule) : '', w.lastRun ? `laatste run ${timeAgo(w.lastRun.created_at)}` : ''].filter(Boolean).join(' · ');
  return (
    <li className="tb-in relative flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors first:rounded-t-card last:rounded-b-card hover:bg-surface-2">
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a href={`#/m/workflows/w/${w.id}`} className="font-semibold leading-snug [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-['']" translate="no">
            {w.name}
          </a>
          {!w.enabled ? <Badge>Uit</Badge> : w.lastRun && <StatusBadge status={w.lastRun.status} />}
        </div>
        <div className="mt-0.5 text-[13px] leading-snug text-muted">{line}</div>
      </div>
      <div className="relative flex shrink-0 items-center gap-2">
        <Bots steps={w.steps} />
        {going ? (
          <Button size="sm" onClick={() => navigate(`#/m/workflows/run/${w.lastRun!.id}`)}>
            Bekijken
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<Play className="h-4 w-4" />} disabled={!w.enabled} onClick={onStart}>
            Starten
          </Button>
        )}
        <Menu
          label={t('Acties voor {0}', w.name)}
          testId="workflow-menu"
          items={[
            { label: 'Bewerken', icon: <Pencil />, href: `#/m/workflows/w/${w.id}` },
            !!w.lastRun && { label: 'Laatste run', icon: <History />, href: `#/m/workflows/run/${w.lastRun.id}` },
            'sep',
            { label: 'Verwijderen', icon: <Trash2 />, danger: true, onSelect: () => void remove() },
          ]}
        />
      </div>
    </li>
  );
}

export function WorkflowsPage() {
  const { data, error, reload } = useWorkflows();
  const agents = useApp((s) => s.agents);
  const [start, setStart] = useState<Workflow | null>(null);
  const [using, setUsing] = useState<string | null>(null);
  const use = async (tpl: Template) => {
    setUsing(tpl.id);
    const from = location.hash;
    try {
      const w = await api.post<Workflow>('/workflows', { template: tpl.id });
      toast('Workflow gemaakt. Controleer per stap of de juiste bot is gekozen.', 'ok');
      navigate(`#/m/workflows/w/${w.id}`, { from });
    } catch (e) {
      toastError(e);
    } finally {
      setUsing(null);
    }
  };
  const hintOf = (w: Workflow) => data?.templates.find((x) => x.name === w.name)?.inputHint;
  return (
    <Page>
      <PageHeader
        title="Workflows"
        subtitle="Je bots doen een vaste reeks stappen; jij geeft akkoord."
        back={{ href: '#/m/routines/', label: 'Automatisch' }}
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate('#/m/workflows/w/nieuw')}>
            Nieuwe workflow
          </Button>
        }
      />
      <div className="mx-auto max-w-4xl space-y-6 px-4 pb-8 pt-4 sm:px-6">
        {error && !data && (
          <EmptyState icon={<WorkflowIcon />} title="Workflows laden mislukt" action={<Button onClick={reload}>Opnieuw</Button>}>
            {error}
          </EmptyState>
        )}
        {!data && !error && <SkeletonRows n={3} avatar={false} />}
        {data && !data.workflows.length && (
          <EmptyState
            icon={<WorkflowIcon />}
            title="Nog geen workflows"
            action={
              agents.length ? (
                <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('#/m/workflows/w/nieuw')}>
                  Nieuwe workflow
                </Button>
              ) : (
                <Button onClick={() => navigate('/agents/new')}>Eerst een bot maken</Button>
              )
            }
          >
            {agents.length ? 'Begin met een voorbeeld hieronder, of maak er zelf een.' : 'Een workflow laat je bots om de beurt een stap doen.'}
          </EmptyState>
        )}
        {!!data?.workflows.length && (
          <Card className="p-0">
            <ul className="divide-y divide-line">
              {data.workflows.map((w) => (
                <WorkflowRow key={w.id} w={w} onStart={() => setStart(w)} onRemoved={reload} />
              ))}
            </ul>
          </Card>
        )}
        {!!data?.templates.length && !!agents.length && (
          <div className="space-y-3">
            <SectionTitle icon={LayoutTemplate}>Voorbeelden</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.templates.map((tpl) => (
                <TemplateCard key={tpl.id} tpl={tpl} busy={using === tpl.id} onUse={() => use(tpl)} />
              ))}
            </div>
          </div>
        )}
      </div>
      {start && <StartModal w={start} hint={hintOf(start)} onClose={() => setStart(null)} />}
    </Page>
  );
}

// ---------------------------------------------------------------- editor

function blank(kind: Step['kind'], agentId: string): Step {
  const id = newStepId();
  if (kind === 'bot') return { id, kind, title: '', agentId, prompt: '' };
  if (kind === 'condition') return { id, kind, title: 'Controle', test: 'contains', value: '', otherwise: 'stop', gotoStep: '' };
  if (kind === 'approval') return { id, kind, title: 'Jouw akkoord', note: '' };
  return { id, kind, title: 'Melding' };
}

function StepCard({ step, index, steps, onChange, onMove, onRemove }: { step: Step; index: number; steps: Step[]; onChange(s: Step): void; onMove(d: -1 | 1): void; onRemove(): void }) {
  const agents = useApp((s) => s.agents).filter((a) => !a.archived);
  const Icon = KIND_ICON[step.kind];
  return (
    <Card className="tb-in p-4" data-step={index + 1}>
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[13px] font-bold">{index + 1}</span>
        <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 text-sm font-semibold">{KIND_TEXT[step.kind]}</span>
        <Menu
          label={t('Acties voor stap {0}', index + 1)}
          items={[
            { label: 'Omhoog', icon: <ArrowUp />, disabled: index === 0, onSelect: () => onMove(-1) },
            { label: 'Omlaag', icon: <ArrowDown />, disabled: index === steps.length - 1, onSelect: () => onMove(1) },
            'sep',
            { label: 'Verwijderen', icon: <Trash2 />, danger: true, onSelect: onRemove },
          ]}
        />
      </div>
      <div className="mt-3 grid gap-3">
        {step.kind === 'bot' && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Welke bot">
                <Select value={step.agentId} onChange={(e) => onChange({ ...step, agentId: e.target.value })}>
                  {!agents.some((a) => a.id === step.agentId) && <option value="">Kies een bot…</option>}
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Naam van de stap">
                <Input value={step.title} placeholder="Bijv. Tekst schrijven" onChange={(e) => onChange({ ...step, title: e.target.value })} />
              </Field>
            </div>
            <Field label="Wat moet de bot doen?" hint={index === 0 ? 'Wat je bij het starten invult, komt er vanzelf onder.' : 'Het resultaat van de vorige stap komt er vanzelf onder.'}>
              <Textarea rows={4} value={step.prompt} onChange={(e) => onChange({ ...step, prompt: e.target.value })} />
            </Field>
          </>
        )}
        {step.kind === 'condition' && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Ga alleen door als het resultaat">
                <Select value={step.test} onChange={(e) => onChange({ ...step, test: e.target.value as any })}>
                  <option value="starts_with">begint met</option>
                  <option value="contains">dit bevat</option>
                  <option value="not_contains">dit niet bevat</option>
                </Select>
              </Field>
              <Field label="Tekst">
                <Input value={step.value} placeholder="Bijv. AKKOORD" onChange={(e) => onChange({ ...step, value: e.target.value })} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Anders">
                <Select value={step.otherwise} onChange={(e) => onChange({ ...step, otherwise: e.target.value as any })}>
                  <option value="stop">stopt de workflow</option>
                  <option value="goto">gaat hij terug naar een stap</option>
                </Select>
              </Field>
              {step.otherwise === 'goto' && (
                <Field label="Terug naar" hint="Hoogstens vier keer; daarna stopt de workflow.">
                  <Select value={step.gotoStep} onChange={(e) => onChange({ ...step, gotoStep: e.target.value })}>
                    <option value="">Kies een stap…</option>
                    {steps.map((s, i) =>
                      s.id === step.id ? null : (
                        <option key={s.id} value={s.id}>
                          {i + 1}. {s.title || KIND_TEXT[s.kind]}
                        </option>
                      ),
                    )}
                  </Select>
                </Field>
              )}
            </div>
          </>
        )}
        {step.kind === 'approval' && (
          <Field label="Wat moet je weten voor je akkoord geeft?" hint="De workflow wacht hier tot jij ja zegt, ook op je telefoon.">
            <Input value={step.note} placeholder="Bijv. Na je akkoord wordt de tekst geplaatst." onChange={(e) => onChange({ ...step, note: e.target.value })} />
          </Field>
        )}
        {step.kind === 'notify' && <p className="text-sm text-muted">Je krijgt een melding met het resultaat tot hier.</p>}
      </div>
    </Card>
  );
}

function AutoStart({ w, schedule, setSchedule }: { w: Workflow | null; schedule: Schedule; setSchedule(s: Schedule): void }) {
  const [key, setKey] = useState<string | null>(null);
  const [hook, setHook] = useState(!!w?.webhook);
  const { busy, run } = useAsync();
  const time = schedule.kind === 'none' ? '09:00' : schedule.time;
  const days = schedule.kind === 'weekly' ? schedule.days : [1];
  const url = w ? `${location.origin}/api/public/hooks/${w.id}` : '';
  const toggleHook = (on: boolean) =>
    run(async () => {
      const r = await api.post<{ key: string | null }>(`/workflows/${w!.id}/webhook`, { enabled: on });
      setHook(on);
      setKey(r.key);
    });
  return (
    <Card className="space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Vanzelf starten">
          <Select value={schedule.kind} onChange={(e) => setSchedule(e.target.value === 'daily' ? { kind: 'daily', time } : e.target.value === 'weekly' ? { kind: 'weekly', time, days } : { kind: 'none' })}>
            <option value="none">Nee, alleen als ik hem start</option>
            <option value="daily">Elke dag</option>
            <option value="weekly">Op vaste dagen</option>
          </Select>
        </Field>
        {schedule.kind !== 'none' && (
          <Field label="Hoe laat">
            <Input type="time" value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} />
          </Field>
        )}
      </div>
      {schedule.kind === 'weekly' && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dagen">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => {
            const on = schedule.days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                className={`h-9 min-w-11 rounded-full border px-2.5 text-sm font-medium transition-colors coarse:h-11 ${on ? 'border-fg bg-surface-3 text-fg' : 'border-line bg-surface text-muted hover:bg-surface-2 hover:text-fg'}`}
                onClick={() => setSchedule({ ...schedule, days: on ? schedule.days.filter((x) => x !== d) : [...schedule.days, d].sort() })}
              >
                {DAY_NAMES[d]}
              </button>
            );
          })}
        </div>
      )}
      {schedule.kind !== 'none' && <p className="text-xs text-muted">Start alleen als TeamBot op dat moment aanstaat.</p>}
      {w && (
        <div className="space-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Toggle checked={hook} disabled={busy} onChange={toggleHook} label="Een andere dienst mag deze workflow starten (webhook)" />
            {hook && (
              <MoreInfo className="text-xs text-muted">
                Stuur een POST met de sleutel in de header <code className="rounded-md bg-surface-2 px-1 py-0.5 text-fg">Authorization: Bearer …</code>. Wat je meestuurt, krijgen de bots als gegevens, nooit als opdracht. Sleutel kwijt? Zet de webhook uit en weer aan voor een nieuwe.
              </MoreInfo>
            )}
          </div>
          {hook && (
            <div className="flex flex-wrap items-center gap-2 rounded-control bg-surface-2 px-3 py-2 text-xs">
              <code className="min-w-0 flex-1 break-all">{url}</code>
              <Button size="sm" variant="ghost" icon={<Copy className="h-4 w-4" />} onClick={() => void copyText(url, 'Adres gekopieerd')}>
                Kopiëren
              </Button>
            </div>
          )}
          {hook && key && (
            <div className="flex flex-wrap items-center gap-2 rounded-control bg-warn-soft px-3 py-2 text-xs">
              <code className="min-w-0 flex-1 break-all">{key}</code>
              <Button size="sm" icon={<Copy className="h-4 w-4" />} onClick={() => void copyText(key, 'Sleutel gekopieerd')}>
                Kopiëren
              </Button>
              <span className="basis-full">Bewaar deze sleutel nu: TeamBot laat hem niet opnieuw zien.</span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function RunsList({ id }: { id: string }) {
  const [rows, setRows] = useState<RunRow[] | null>(null);
  useEffect(() => {
    api
      .get<{ runs: RunRow[] }>(`/workflows/${id}/runs`)
      .then((r) => setRows(r.runs))
      .catch(() => setRows([]));
  }, [id]);
  if (!rows) return <SkeletonRows n={2} avatar={false} />;
  if (!rows.length) return <p className="text-sm text-muted">Deze workflow is nog niet gestart.</p>;
  return (
    <Card className="divide-y divide-line overflow-hidden p-0">
      {rows.map((r) => (
        <a key={r.id} href={`#/m/workflows/run/${r.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm transition-colors hover:bg-surface-2">
          <StatusBadge status={r.status} />
          <span className="line-clamp-1 min-w-0 flex-1 [overflow-wrap:anywhere]">{r.input || TRIGGER_TEXT[r.trigger]}</span>
          <span className="text-xs text-muted">
            {r.started_by} · {timeAgo(r.created_at)}
          </span>
        </a>
      ))}
    </Card>
  );
}

function Versions({ w, onRestored }: { w: Workflow; onRestored(w: Workflow): void }) {
  const [rows, setRows] = useState<Version[] | null>(null);
  const { busy, run } = useAsync();
  useEffect(() => {
    api
      .get<{ versions: Version[] }>(`/workflows/${w.id}/versions`)
      .then((r) => setRows(r.versions))
      .catch(() => setRows([]));
  }, [w.id, w.version]);
  if (!rows || rows.length < 2) return null;
  return (
    <Fold title="Eerdere versies" hint={String(rows.length)} testId="workflow-versions">
      <div className="-my-2 divide-y divide-line">
        {rows.map((v) => (
          <div key={v.version} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
            <History className="h-4 w-4 text-muted" aria-hidden />
            <span className="font-semibold">Versie {v.version}</span>
            <span className="min-w-0 flex-1 text-muted">
              {t('{0, plural, one {# stap} other {# stappen}}', v.steps.length)} · {timeAgo(v.created_at)}
            </span>
            {v.current ? (
              <Badge>Nu</Badge>
            ) : (
              <Button size="sm" loading={busy} onClick={() => run(async () => onRestored(await api.post<Workflow>(`/workflows/${w.id}/versions/${v.version}/restore`)), `Versie ${v.version} is teruggezet`)}>
                Terugzetten
              </Button>
            )}
          </div>
        ))}
      </div>
    </Fold>
  );
}

export function WorkflowEditorPage({ params }: { params: string[] }) {
  const id = params[0] || 'nieuw';
  const isNew = id === 'nieuw';
  const agents = useApp((s) => s.agents).filter((a) => !a.archived);
  const [w, setW] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [schedule, setSchedule] = useState<Schedule>({ kind: 'none' });
  const [enabled, setEnabled] = useState(true);
  const [start, setStart] = useState(false);
  const { busy, run } = useAsync();

  const take = (x: Workflow) => {
    setW(x);
    setName(x.name);
    setDescription(x.description);
    setSteps(x.steps);
    setSchedule(x.schedule);
    setEnabled(x.enabled);
  };
  useEffect(() => {
    if (isNew) {
      setW(null);
      setName('');
      setDescription('');
      setSteps([]);
      setSchedule({ kind: 'none' });
      return;
    }
    api
      .get<Workflow>(`/workflows/${id}`)
      .then(take)
      .catch((e) => setError(e?.message || String(e)));
  }, [id]);

  const dirty = useMemo(() => isNew || !w || name !== w.name || description !== w.description || enabled !== w.enabled || JSON.stringify(steps) !== JSON.stringify(w.steps) || JSON.stringify(schedule) !== JSON.stringify(w.schedule), [isNew, w, name, description, enabled, steps, schedule]);
  const save = () =>
    run(async () => {
      const body = { name, description, steps, schedule, enabled };
      if (isNew) {
        const from = location.hash;
        const made = await api.post<Workflow>('/workflows', body);
        navigate(`#/m/workflows/w/${made.id}`, { from });
      } else take(await api.patch<Workflow>(`/workflows/${id}`, body));
    }, 'Opgeslagen');
  const remove = async () => {
    if (!(await askConfirm(`Workflow “${name}” verwijderen? Ook de runs en eerdere versies gaan weg.`, { ok: 'Verwijderen', danger: true }))) return;
    const from = location.hash;
    await run(async () => {
      await api.del(`/workflows/${id}`);
      navigate('#/m/workflows', { from });
    });
  };
  const add = (kind: Step['kind']) => setSteps((s) => [...s, blank(kind, agents[0]?.id || '')]);
  const move = (i: number, d: -1 | 1) =>
    setSteps((s) => {
      const n = [...s];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });

  if (error)
    return (
      <Page>
        <PageHeader title="Workflow" back={{ href: '#/m/workflows', label: 'Workflows' }} />
        <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
          <EmptyState icon={<WorkflowIcon />} title="Deze workflow is er niet" action={<Button onClick={() => navigate('#/m/workflows')}>Naar Workflows</Button>}>
            {error}
          </EmptyState>
        </div>
      </Page>
    );
  if (!isNew && !w)
    return (
      <Page>
        <PageHeader title="Workflow" back={{ href: '#/m/workflows', label: 'Workflows' }} />
        <div className="mx-auto max-w-4xl space-y-4 px-4 py-4 sm:px-6">
          <Skeleton className="h-32 rounded-card" />
          <SkeletonRows n={3} avatar={false} />
        </div>
      </Page>
    );
  return (
    <Page>
      <PageHeader
        title={isNew ? 'Nieuwe workflow' : name || 'Workflow'}
        back={{ href: '#/m/workflows', label: 'Workflows' }}
        actions={
          <>
            {!isNew && <Menu label="Meer opties" variant="secondary" items={[{ label: 'Workflow verwijderen', icon: <Trash2 />, danger: true, onSelect: () => void remove() }]} />}
            {!isNew && (
              <Button icon={<Play className="h-4 w-4" />} disabled={dirty || !enabled} title={dirty ? 'Sla eerst je wijzigingen op' : undefined} onClick={() => setStart(true)}>
                Starten
              </Button>
            )}
            <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>
              Opslaan
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-6 px-4 pb-8 pt-4 sm:px-6">
        <Card className="grid gap-3 p-4">
          <Field label="Naam">
            <Input value={name} placeholder="Bijv. Wekelijks overzicht" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Wat levert het op? (één zin)">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {!isNew && <Toggle checked={enabled} onChange={setEnabled} label="Aan" />}
        </Card>

        <div className="space-y-3">
          <SectionTitle icon={ListOrdered} tone="teal">Stappen</SectionTitle>
          {!steps.length && <p className="text-sm text-muted">Voeg de eerste stap toe: meestal een bot die iets maakt of uitzoekt.</p>}
          {steps.map((s, i) => (
            <StepCard key={s.id} step={s} index={i} steps={steps} onChange={(n) => setSteps((all) => all.map((x) => (x.id === s.id ? n : x)))} onMove={(d) => move(i, d)} onRemove={() => setSteps((all) => all.filter((x) => x.id !== s.id))} />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button icon={<Bot className="h-4 w-4" />} onClick={() => add('bot')} disabled={!agents.length}>
              Bot
            </Button>
            <Button icon={<GitBranch className="h-4 w-4" />} onClick={() => add('condition')}>
              Controle
            </Button>
            <Button icon={<Hand className="h-4 w-4" />} onClick={() => add('approval')}>
              Jouw akkoord
            </Button>
            <Button icon={<Bell className="h-4 w-4" />} onClick={() => add('notify')}>
              Melding
            </Button>
          </div>
          {!agents.length && <p className="text-sm text-muted">Maak eerst een bot: een workflow laat je bots om de beurt een stap doen.</p>}
        </div>

        <div className="space-y-3">
          <SectionTitle icon={Clock} tone="orange">Automatisch starten</SectionTitle>
          <AutoStart w={w} schedule={schedule} setSchedule={setSchedule} />
        </div>

        {w && (
          <>
            <div className="space-y-3">
              <SectionTitle icon={History}>Runs</SectionTitle>
              <RunsList id={w.id} key={w.lastRun?.id || 'none'} />
            </div>
            <Versions w={w} onRestored={take} />
          </>
        )}
      </div>
      {start && w && <StartModal w={w} onClose={() => setStart(false)} />}
    </Page>
  );
}

// ---------------------------------------------------------------- run

const TRACE_TEXT: Record<TraceItem['status'], string> = { running: 'Bezig…', waiting: 'Wacht op jou', done: 'Klaar', error: 'Mislukt', denied: 'Niet goedgekeurd', failed_check: 'Niet gehaald', stopped: 'Gestopt', interrupted: 'Onderbroken' };

function TraceRow({ item, n }: { item: TraceItem; n: number }) {
  const Icon = KIND_ICON[item.kind];
  const agent = item.agentId ? agentById(item.agentId) : null;
  const bad = item.status === 'error' || item.status === 'denied';
  const [open, setOpen] = useState(false);
  const long = item.output.length > 600;
  return (
    <li className="flex gap-3" data-trace={item.status}>
      <div className="flex flex-col items-center">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${item.status === 'done' ? 'bg-ok-soft text-ok' : bad ? 'bg-danger-soft text-danger' : 'bg-surface-3 text-muted'}`}>
          {item.status === 'running' ? <Spinner /> : item.status === 'done' ? <CircleCheck className="h-4 w-4" /> : bad ? <CircleX className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
        </span>
        <span className="w-px flex-1 bg-line" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">
            {n}. {item.title}
          </span>
          {agent && (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <BotAvatar bot={agent} size={16} /> {agent.name}
            </span>
          )}
          <span className="text-xs text-muted">{TRACE_TEXT[item.status]}</span>
          {item.threadId && (
            <a href={`#/t/${item.threadId}`} className="text-xs font-semibold text-muted underline underline-offset-2 hover:text-fg">
              Bekijk het werk
            </a>
          )}
        </div>
        {item.error && <p className="mt-1 text-sm text-danger">{item.error}</p>}
        {item.kind === 'bot' && item.output && (
          <div className="mt-2 rounded-card border border-line bg-surface p-3">
            <div className={long && !open ? 'max-h-40 overflow-hidden' : ''}>
              <Markdown text={item.output} />
            </div>
            {long && (
              <button type="button" className="mt-1 text-xs font-semibold text-muted hover:text-fg" onClick={() => setOpen(!open)} aria-expanded={open}>
                {open ? 'Minder tonen' : 'Alles tonen'}
              </button>
            )}
          </div>
        )}
        {item.kind !== 'bot' && item.output && <p className="mt-1 text-sm text-muted">{item.output}</p>}
      </div>
    </li>
  );
}

export function WorkflowRunPage({ params }: { params: string[] }) {
  const { run, error } = useRun(params[0] || '');
  const approvals = useApp((s) => s.approvals);
  const { busy, run: act } = useAsync();
  if (error || !run)
    return (
      <Page>
        <PageHeader title="Workflow" back={{ href: '#/m/workflows', label: 'Workflows' }} />
        <div className="mx-auto max-w-4xl space-y-4 px-4 py-4 sm:px-6">
          {error ? (
            <EmptyState icon={<WorkflowIcon />} title="Deze run is er niet" action={<Button onClick={() => navigate('#/m/workflows')}>Naar Workflows</Button>}>
              {error}
            </EmptyState>
          ) : (
            <>
              <Skeleton className="h-5 w-1/3" />
              <SkeletonRows n={3} />
            </>
          )}
        </div>
      </Page>
    );
  const card = approvals.find((a) => a.tool === 'workflow_approval' && a.input?.runId === run.id && a.status === 'pending');
  const active = run.status === 'running' || run.status === 'waiting';
  const canResume = run.status === 'interrupted' || run.status === 'error';
  const indexOf = (stepId: string) => run.steps.findIndex((s) => s.id === stepId) + 1;
  const todo = active ? run.steps.slice(indexOf(run.trace[run.trace.length - 1]?.stepId || '')) : [];
  return (
    <Page>
      <PageHeader
        title={run.workflowName}
        subtitle={`${TRIGGER_TEXT[run.trigger]}${run.trigger === 'bot' ? `: ${run.started_by}` : ''} · ${timeAgo(run.created_at)} · versie ${run.version}`}
        back={{ href: `#/m/workflows/w/${run.workflow_id}`, label: 'Workflow' }}
        actions={
          <>
            <StatusBadge status={run.status} />
            {active && (
              <Button icon={<Square className="h-4 w-4" />} loading={busy} onClick={() => act(() => api.post(`/workflow-runs/${run.id}/stop`))}>
                Stoppen
              </Button>
            )}
            {canResume && (
              <Button variant="primary" icon={<RotateCcw className="h-4 w-4" />} loading={busy} onClick={() => act(() => api.post(`/workflow-runs/${run.id}/resume`))}>
                Hervatten
              </Button>
            )}
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-4 sm:px-6">
        {run.input && (
          <Card className="p-4">
            <div className="text-xs font-semibold text-muted">Invoer</div>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{run.input}</p>
          </Card>
        )}
        {run.error && <Card className={`p-4 text-sm ${run.status === 'error' ? 'text-danger' : 'text-muted'}`}>{run.error}</Card>}
        <ol className="list-none">
          {run.trace.map((item, i) => (
            <TraceRow key={i} item={item} n={indexOf(item.stepId)} />
          ))}
          {todo.map((s) => (
            <li key={s.id} className="flex gap-3 pb-4 text-sm text-muted">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-xs">{indexOf(s.id)}</span>
              <span className="pt-1.5">{s.title}</span>
            </li>
          ))}
        </ol>
        {card && <WorkflowApprovalCard a={card} />}
        {run.status === 'done' && run.result && (
          <Card className="p-4">
            <div className="mb-2 text-xs font-semibold text-muted">Resultaat</div>
            <Markdown text={run.result} />
          </Card>
        )}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------- approval card

/** "Jouw akkoord" of a workflow: what you approve, with the result so far. Never "altijd toestaan". */
export function WorkflowApprovalCard({ a }: { a: Approval }) {
  const { busy, decide } = useDecide(a);
  const [open, setOpen] = useState(false);
  const result = String(a.input?.result || '');
  return (
    <div role="group" aria-label="Akkoord voor een workflow" className="tb-ask w-full rounded-card border p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <WorkflowIcon className="h-4 w-4" aria-hidden />
        <span>
          Workflow <span className="font-semibold text-fg">{String(a.input?.workflow || '')}</span> wacht op jouw akkoord
        </span>
        <span aria-hidden>·</span>
        <span>{timeAgo(a.created_at)}</span>
        <span aria-hidden>·</span>
        <a className="font-semibold underline underline-offset-2 hover:text-fg" href={`#/m/workflows/run/${a.input?.runId}`}>
          naar de run
        </a>
      </div>
      <div className="mt-2 text-[15px] font-bold leading-snug">{String(a.input?.step || 'Jouw akkoord')}</div>
      {a.input?.note && <p className="mt-1 text-sm text-muted">{String(a.input.note)}</p>}
      {result && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3">
          <div className={open ? '' : 'max-h-48 overflow-hidden'}>
            <Markdown text={result} />
          </div>
          {result.length > 500 && (
            <button type="button" className="mt-1 text-xs font-semibold text-muted hover:text-fg" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Minder tonen' : 'Alles tonen'}
            </button>
          )}
        </div>
      )}
      <div className="mt-3 grid max-w-md grid-cols-2 gap-2">
        <Button variant="primary" className="justify-center" loading={busy === 'approve'} onClick={() => decide('approve')}>
          Akkoord, ga door
        </Button>
        <Button className="justify-center" loading={busy === 'deny'} onClick={() => decide('deny')}>
          Niet akkoord, stop
        </Button>
      </div>
    </div>
  );
}
