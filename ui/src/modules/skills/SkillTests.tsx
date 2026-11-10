import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleHelp, FlaskConical, Plus, Trash2, XCircle } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatDateTime, formatNumber, formatUsd } from '../../lib/format';
import { Badge, Button, Card, Field, Input, Spinner, Textarea, toast, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { Dropdown } from '../../components/SettingControls';
import { Skeleton, SkeletonRows } from '../../components/overview';
import type { SkillDetail } from './api';

/**
 * Testing a skill with saved test questions (0.4.4; server/modules/skills/tests.ts). The owner keeps 3 to 5 questions,
 * each with a "klaar als". Running them costs tokens: first an estimate, then the owner's click. The result (goed,
 * twijfel, fout) stands next to the version; updating a skill stays a separate click.
 */

export interface SkillTest {
  id?: string;
  question: string;
  doneWhen: string;
}

interface TestResult {
  testId: string;
  question: string;
  doneWhen: string;
  answer: string;
  verdict: 'goed' | 'twijfel' | 'fout' | null;
  reason: string;
}

export interface TestRun {
  id: string;
  target: string;
  label: string;
  agentName: string;
  status: 'running' | 'done';
  results: TestResult[];
  summary: {
    goed?: number;
    twijfel?: number;
    fout?: number;
    geen?: number;
    total?: number;
    state?: string;
  };
  tokens: number;
  engine: string;
  error: string | null;
  createdAt: string;
}

interface TestsView {
  tests: SkillTest[];
  runs: TestRun[];
  bots: { id: string; name: string; usesSkill: boolean; engine: boolean }[];
  max: number;
}

interface Estimate {
  questions: number;
  calls: number;
  tokens: number;
  cost: number | null;
  billing: 'paid' | 'free' | 'local' | 'subscription' | 'unknown';
  engine: string;
  hasEngine: boolean;
  label: string;
}

const VERDICT_LABEL = {
  goed: 'Goed',
  twijfel: 'Twijfel',
  fout: 'Fout',
} as const;

function VerdictIcon({ v }: { v: TestResult['verdict'] }) {
  if (v === 'goed') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />;
  if (v === 'fout') return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />;
  return <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />;
}

/** One line with the totals of a run ("2 goed, 1 fout"). */
export function RunSummary({ run }: { run: TestRun }) {
  const s = run.summary || {};
  const tone = s.state === 'goed' ? 'ok' : s.state === 'fout' ? 'danger' : 'warn';
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone={tone}>{s.state === 'goed' ? 'Alles goed' : s.state === 'fout' ? 'Niet alles goed' : 'Twijfel'}</Badge>
      <span className="text-xs text-muted">{t('{0} goed, {1} twijfel, {2} fout', s.goed || 0, (s.twijfel || 0) + (s.geen || 0), s.fout || 0)}</span>
    </span>
  );
}

function RunResults({ run }: { run: TestRun }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{t('Getest: {0} met {1}', run.label, run.agentName || 'de bot')}</span>
        {run.status === 'done' ? (
          <RunSummary run={run} />
        ) : (
          <span className="flex items-center gap-2 text-muted">
            <Spinner /> Bezig met testen…
          </span>
        )}
      </div>
      {run.error && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{run.error}</p>}
      <ul className="divide-y divide-line rounded-lg border border-line">
        {run.results.map((r) => (
          <li key={r.testId} className="space-y-1 px-3 py-2 text-sm">
            <div className="flex items-start gap-2">
              <VerdictIcon v={r.verdict} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.question}</div>
                <div className="text-xs text-muted">
                  {r.verdict ? VERDICT_LABEL[r.verdict] : 'Geen oordeel'}
                  {r.reason ? ` · ${r.reason}` : ''}
                </div>
                {r.answer && (
                  <MoreInfo block label="Antwoord van de bot" className="mt-1">
                    <span className="block whitespace-pre-wrap break-words">{r.answer}</span>
                  </MoreInfo>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {run.status === 'done' && run.tokens > 0 && <p className="text-xs text-muted">{t('Gebruikt: ongeveer {0} tokens ({1}).', formatNumber(run.tokens), run.engine || 'engine van de bot')}</p>}
    </div>
  );
}

function costText(e: Estimate): string {
  const tokens = t('± {0} tokens', formatNumber(e.tokens));
  if (e.billing === 'subscription') return t('{0}, binnen je abonnement van {1} (schatting).', tokens, e.engine);
  if (e.billing === 'local') return t('{0}, op je eigen computer: geen kosten (schatting).', tokens);
  if (e.billing === 'free') return t('{0}, met een gratis model (schatting).', tokens);
  if (e.cost !== null) return t('{0}, ongeveer {1} (schatting).', tokens, formatUsd(e.cost));
  return t('{0}; de prijs van dit model is niet bekend (schatting).', tokens);
}

/**
 * Run the saved questions against one version: `target` = 'active', 'rev:<n>' or 'commit:<sha>' (a new version from
 * the TeamBot catalogue, before updating). Shows the estimate first; nothing runs without the owner's click.
 */
export function TestRunPanel({ skillId, target, title, onRun }: { skillId: string; target: string; title?: string; onRun?(run: TestRun): void }) {
  const [view, setView] = useState<TestsView | null>(null);
  const [error, setError] = useState('');
  const [agentId, setAgentId] = useState('');
  const [est, setEst] = useState<Estimate | null>(null);
  const [run, setRun] = useState<TestRun | null>(null);
  const { busy, run: act } = useAsync();
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    api
      .get<TestsView>(`/skills/${skillId}/tests`)
      .then((v) => {
        setView(v);
        setAgentId((cur) => cur || v.bots.find((b) => b.engine)?.id || v.bots[0]?.id || '');
      })
      .catch((e) => setError(e.message));
  }, [skillId]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    setEst(null);
    if (!agentId || !view?.tests.length) return;
    api
      .get<Estimate>(`/skills/${skillId}/tests/estimate?agentId=${encodeURIComponent(agentId)}&target=${encodeURIComponent(target)}`)
      .then(setEst)
      .catch((e) => setError(e.message));
  }, [skillId, agentId, target, view?.tests.length]);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  const poll = (id: string) => {
    api
      .get<TestRun>(`/skills/${skillId}/tests/runs/${id}`)
      .then((r) => {
        setRun(r);
        if (r.status === 'running') timer.current = window.setTimeout(() => poll(id), 1500);
        else onRun?.(r);
      })
      .catch((e) => setError(e.message));
  };
  const start = () =>
    act(async () => {
      const r = await api.post<TestRun>(`/skills/${skillId}/tests/run`, {
        agentId,
        target,
        confirm: true,
      });
      setRun(r);
      poll(r.id);
    });

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!view)
    return (
      <div className="space-y-2" role="status" aria-label="Laden">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-64 max-w-full rounded-control" />
      </div>
    );
  if (!view.tests.length)
    return (
      <p className="text-sm text-muted">
        Nog geen testvragen. Zet ze bij de skill onder <span className="font-medium">Testen</span>.
      </p>
    );
  return (
    <div className="space-y-3">
      {title && (
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <FlaskConical className="h-4 w-4 text-accent" aria-hidden /> {title}
        </h3>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Testen met bot">
          <Dropdown label="Bot voor de test" className="!min-w-0" value={agentId} onChange={setAgentId} options={view.bots.map((b) => ({ value: b.id, label: b.name, disabled: !b.engine, attrs: { translate: 'no' } }))} />
        </Field>
        <Button variant="primary" icon={<FlaskConical className="h-4 w-4" />} loading={busy || run?.status === 'running'} disabled={!agentId || !est?.hasEngine} onClick={start}>
          {t('{0, plural, one {# testvraag draaien} other {# testvragen draaien}}', view.tests.length)}
        </Button>
      </div>
      {est && (
        <p className="text-xs text-muted">
          {est.hasEngine ? `${t('Kost {0, plural, one {# aanroep} other {# aanroepen}}:', est.calls)} ${costText(est)}` : 'Deze bot heeft nog geen AI gekoppeld. Kies een andere bot.'}
        </p>
      )}
      {run && <RunResults run={run} />}
    </div>
  );
}

/** The "Testen" tab of a skill: the questions (3 to 5) and test runs for the version in use or another version. */
export function TestsTab({ s }: { s: SkillDetail }) {
  const [view, setView] = useState<TestsView | null>(null);
  const [list, setList] = useState<SkillTest[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [target, setTarget] = useState('active');
  const [key, setKey] = useState(0);
  const { busy, run } = useAsync();
  const load = useCallback(() => {
    api
      .get<TestsView>(`/skills/${s.id}/tests`)
      .then((v) => {
        setView(v);
        setList(v.tests.length ? v.tests : [{ question: '', doneWhen: '' }]);
        setDirty(false);
      })
      .catch((e) => setError(e.message));
  }, [s.id]);
  useEffect(() => load(), [load]);
  useEffect(() => on('skills.tests', (d: { skillId?: string }) => d?.skillId === s.id && load()), [s.id, load]);

  const change = (i: number, patch: Partial<SkillTest>) => {
    setList((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setDirty(true);
  };
  const save = () =>
    run(async () => {
      const tests = list.filter((x) => x.question.trim());
      await api.put(`/skills/${s.id}/tests`, { tests });
      toast('Testvragen bewaard', 'ok');
      load();
      setKey((k) => k + 1);
    });

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!view) return <SkeletonRows n={2} avatar={false} />;
  return (
    <div className="tb-in space-y-4">
      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">Testvragen</h2>
        <p className="text-sm text-muted">
          Drie tot vijf vragen die deze skill goed moet kunnen. <MoreInfo>Zet bij elke vraag wanneer het antwoord goed is. Een test kost tokens; je ziet eerst een schatting.</MoreInfo>
        </p>
        <ol className="space-y-3">
          {list.map((x, i) => (
            <li key={i} className="space-y-2 rounded-lg border border-line p-3">
              <Field label={t('Vraag {0}', i + 1)}>
                <Textarea rows={2} value={x.question} maxLength={1000} onChange={(e) => change(i, { question: e.target.value })} placeholder="Bijv. Een klant wil na 20 dagen iets terugsturen." />
              </Field>
              <Field label="Klaar als">
                <Input value={x.doneWhen} maxLength={400} onChange={(e) => change(i, { doneWhen: e.target.value })} placeholder="Bijv. Zegt dat het mag en stuurt een retourlabel." />
              </Field>
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4 text-danger" />} onClick={() => (setList((l) => l.filter((_, j) => j !== i)), setDirty(true))}>
                  Weghalen
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap justify-between gap-2">
          <Button size="sm" icon={<Plus className="h-4 w-4" />} disabled={list.length >= view.max} onClick={() => (setList((l) => [...l, { question: '', doneWhen: '' }]), setDirty(true))}>
            Vraag toevoegen
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!dirty} onClick={save}>
            Testvragen bewaren
          </Button>
        </div>
      </Card>
      {view.tests.length > 0 && (
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">Test draaien</h2>
          <Field label="Welke versie">
            <Dropdown
              label="Versie om te testen"
              value={target}
              onChange={setTarget}
              options={[{ value: 'active', label: t('Versie {0} (in gebruik)', s.version || String(s.activeRev)) }, ...s.versions.filter((v) => !v.active).map((v) => ({ value: `rev:${v.rev}`, label: t('Versie {0} van {1}', v.version || String(v.rev), formatDateTime(v.createdAt)) }))]}
            />
          </Field>
          <TestRunPanel key={`${target}-${key}`} skillId={s.id} target={target} onRun={() => load()} />
        </Card>
      )}
      {view.runs.length > 0 && (
        <Card className="space-y-2 p-4">
          <h2 className="text-sm font-semibold">Eerdere tests</h2>
          <ul className="divide-y divide-line text-sm">
            {view.runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {r.label} · <span className="text-muted">{formatDateTime(r.createdAt)}</span>
                </span>
                {r.status === 'done' ? <RunSummary run={r} /> : <span className="text-muted">Bezig…</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
