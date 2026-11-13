import { useEffect, useState } from 'react';
import { Ban, BookOpen, Brain, Check, ChevronRight, ExternalLink, GraduationCap, Lightbulb, Plus, RotateCcw, Settings2, Trash2, Wand2 } from 'lucide-react';
import { askConfirm, Badge, Button, Card, EmptyState, Field, Input, Modal, Page, PageHeader, Tabs, Textarea, cx, toast, toastError, useAsync, CardHead } from '../../components/ui';
import { Fold, Menu, SkeletonRows } from '../../components/overview';
import { MoreInfo } from '../../components/MoreInfo';
import { BotAvatar } from '../../components/BotFace';
import { api } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { useApp } from '../../lib/store';
import { type Fact, type Goal, type Report, type Round, type RoundLine, spApi, useSpecialistData, useSpecialists } from './api';
import { KIND_LABEL, sourceStatus } from './Card';

/**
 * Three places: what the specialist knows, what waits for you (facts that clash), and how it
 * learns (goals, reports, sources). Links of earlier versions to the six old tabs land on the place they moved to.
 */
type Tab = 'feiten' | 'controleren' | 'leren';
const TABS: Tab[] = ['feiten', 'controleren', 'leren'];
const OLD_TABS: Record<string, Tab> = { voorstellen: 'controleren', leerdoelen: 'leren', verslagen: 'leren', bronnen: 'leren' };

/** While a part of the knowledge base loads: grey rows instead of a lone spinner. */
const Spinner = () => <SkeletonRows n={3} avatar={false} />;

function host(u: string | null | undefined): string {
  if (!u) return '';
  try {
    return new URL(u).host;
  } catch {
    return u.split(/[\\/]/).pop() || u;
  }
}

function SourceLink({ url, label }: { url: string | null | undefined; label?: string | null }) {
  if (!url) return <span>de eigenaar</span>;
  if (/^https?:\/\//i.test(url))
    return (
      <a className="text-accent underline [overflow-wrap:anywhere]" href={url} target="_blank" rel="noreferrer noopener" translate="no">
        {label || host(url)}
      </a>
    );
  return (
    <span translate="no" className="[overflow-wrap:anywhere]">
      {label || host(url)}
    </span>
  );
}

/** #/m/specialists — every specialist; #/m/specialists/<bot>/<tab> — one knowledge base. */
export function KennisbankPage({ params }: { params: string[] }) {
  const [agentId, tab] = params;
  if (!agentId) return <SpecialistList />;
  return <Kennisbank agentId={agentId} tab={(TABS.includes(tab as Tab) ? tab : OLD_TABS[tab] || 'feiten') as Tab} />;
}

function SpecialistList() {
  const list = useSpecialists();
  const agents = useApp((s) => s.agents);
  const active = list.filter((s) => s.enabled);
  return (
    <Page>
      <PageHeader title="Kennisbanken" subtitle="Wat je specialisten weten, met bron en datum." />
      <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
        {active.length === 0 ? (
          <Card>
            <EmptyState icon={<GraduationCap />} title="Nog geen specialisten" action={<Button onClick={() => navigate('/agents')}>Naar je bots</Button>}>
              Maak van een bot een specialist bij de bot zelf, onder Specialisme.
            </EmptyState>
          </Card>
        ) : (
          <Card className="divide-y divide-line overflow-hidden">
            {active.map((s) => {
              const a = agents.find((x) => x.id === s.agentId);
              return (
                <a key={s.agentId} href={`#/m/specialists/${s.agentId}${s.counts.review ? '/controleren' : ''}`} className="tb-in flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  {a && <BotAvatar bot={a} size={36} />}
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold" translate="no">
                      {s.agentName}
                    </span>
                    <span className="block text-[13px] text-muted [overflow-wrap:anywhere]">
                      {t('{0, plural, one {# feit} other {# feiten}}', s.counts.facts)} · {s.field}
                    </span>
                  </span>
                  {/* One signal: what waits for you, else whether it keeps learning. */}
                  {s.counts.review > 0 ? <Badge tone="warn">{t('{0} te controleren', s.counts.review)}</Badge> : <Badge tone={s.learnOn ? 'ok' : 'neutral'}>{s.learnOn ? (s.cadence === 'weekly' ? 'Leert wekelijks' : s.cadence === 'hourly' ? 'Leert elk uur' : 'Leert dagelijks') : 'Leert niet vanzelf'}</Badge>}
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                </a>
              );
            })}
          </Card>
        )}
      </div>
    </Page>
  );
}

function Kennisbank({ agentId, tab }: { agentId: string; tab: Tab }) {
  const { data: v, error } = useSpecialistData(() => spApi.get(agentId), agentId);
  const agent = useApp((s) => s.agents.find((a) => a.id === agentId));
  const learn = useAsync();
  if (error && !v) return <EmptyState title="Kennisbank niet gevonden">{error}</EmptyState>;
  if (!v)
    return (
      <Page>
        <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
          <Spinner />
        </div>
      </Page>
    );
  const waiting = v.counts.review;
  const tabs: { id: Tab; label: React.ReactNode }[] = [
    { id: 'feiten', label: t('Feiten ({0})', v.counts.facts) },
    {
      id: 'controleren',
      label: waiting ? (
        <span className="inline-flex items-center gap-1.5">
          Te controleren <Badge tone="warn">{waiting}</Badge>
        </span>
      ) : (
        'Te controleren'
      ),
    },
    { id: 'leren', label: 'Leren' },
  ];
  return (
    <Page>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {agent && <BotAvatar bot={agent} size={36} />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{t('Kennisbank van {0}', v.agentName)}</span>
          </span>
        }
        subtitle={v.enabled ? v.field : 'Deze bot is (nog) geen specialist.'}
        back={{ href: `#/a/${agentId}`, label: t('Terug naar {0}', v.agentName) }}
        actions={
          <>
            <Menu
              label="Meer opties"
              variant="secondary"
              items={[
                { label: 'Instellingen van deze bot', icon: <Settings2 />, href: `#/agents/${agentId}/edit` },
                !!v.dossierId && { label: 'In Geheugen bekijken', icon: <Brain />, href: `#/m/memory/dossiers/${v.dossierId}` },
              ]}
            />
            {v.enabled && (
              <Button
                variant="primary"
                icon={<GraduationCap className="h-4 w-4" />}
                loading={learn.busy}
                onClick={() =>
                  learn.run(async () => {
                    await spApi.learn(agentId);
                    toast(t('{0} begint nu een leerronde.', v.agentName), 'ok');
                  })
                }
              >
                Nu leren
              </Button>
            )}
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-5 sm:px-6">
        {(v.size || v.lastNews?.nieuw) && (
          <p className="text-xs text-muted [overflow-wrap:anywhere]">
            {v.size && <span>{t('{0} van {1} feiten', v.size.active, v.size.target)}</span>}
            {v.size && v.lastNews?.nieuw ? ' · ' : ''}
            {v.lastNews?.nieuw && (
              <>
                {t('Nieuw sinds {0}: {1}', formatDate(v.lastNews.at, { dateStyle: 'medium' }), v.lastNews.nieuw)}
                {v.lastNews.gevolg ? ` ${t('Gevolg voor de werkwijze: {0}', v.lastNews.gevolg)}` : ''}
              </>
            )}
          </p>
        )}
        <Tabs tabs={tabs} value={tab} onChange={(x) => navigate(`/m/specialists/${agentId}/${x}`)} />
        <div key={tab} className="tb-in space-y-4">
        {tab === 'feiten' && <FactsTab agentId={agentId} />}
        {tab === 'controleren' && <ReviewTab agentId={agentId} />}
        {tab === 'leren' && (
          <>
            {/* When it learns, in one line; the goals, the reports and the sources each open to their own list. */}
            <p className="text-sm text-muted">
              {v.learnOn ? (v.cadence === 'weekly' ? 'Leert elke week.' : v.cadence === 'hourly' ? 'Leert elk uur.' : 'Leert elke dag.') : 'Leert niet vanzelf: klik op Nu leren, of zet de leerronde aan bij de bot.'}
              {v.learnOn && v.nextRoundAt && <> {t('Volgende ronde: {0}.', formatDateTime(v.nextRoundAt))}</>}
            </p>
            <Fold title="Leerdoelen" hint={v.counts.goals ? t('{0} open', v.counts.goals) : undefined} defaultOpen={v.counts.goals > 0}>
              <GoalsTab agentId={agentId} enabled={v.enabled} />
            </Fold>
            <Fold title="Leerverslagen" defaultOpen={!v.counts.goals}>
              <ReportsTab agentId={agentId} name={v.agentName} />
            </Fold>
            <Fold title="Bronnen" hint={String(v.sources.length)}>
          <div className="space-y-2">
            {v.sources.length === 0 && <p className="text-sm text-muted">Nog geen bronnen. Voeg ze toe bij de bot, onder Specialisme.</p>}
            {v.sources.map((s) => {
              const st = sourceStatus(s);
              return (
                <div key={s.id} className="flex flex-wrap items-start gap-2 border-b border-line pb-2 last:border-0">
                  <Badge>{KIND_LABEL[s.kind]}</Badge>
                  {!s.enabled && <Badge tone="warn">uit</Badge>}
                  <div className="min-w-0 flex-1 text-sm">
                    <SourceLink url={s.target} label={s.label || s.target} />
                    {st && <div className={cx('text-xs', st.tone === 'danger' ? 'text-danger' : st.tone === 'warn' ? 'text-warn' : 'text-muted')}>{st.text}</div>}
                  </div>
                </div>
              );
            })}
          </div>
            </Fold>
          </>
        )}
        </div>
      </div>
    </Page>
  );
}

function FactLine({ f, agentId, onChange }: { f: Fact; agentId: string; onChange(): void }) {
  const a = useAsync();
  const [retiring, setRetiring] = useState(false);
  const [why, setWhy] = useState('');
  return (
    <li className="tb-in flex items-start gap-2 border-b border-line py-3 last:border-0">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm leading-relaxed [overflow-wrap:anywhere]">{f.content}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <SourceLink url={f.source} label={f.sourceLabel} />
          <span>· {formatDate(f.learnedAt, { dateStyle: 'medium' })}</span>
          {f.confirmedAt && f.confirmedAt.slice(0, 10) !== f.learnedAt.slice(0, 10) && <span>· {t('bevestigd op {0}', formatDate(f.confirmedAt, { dateStyle: 'medium' }))}</span>}
          {f.by === 'owner' && <span>· door jou toegevoegd</span>}
        </div>
        {retiring && (
          <div className="flex flex-wrap gap-2">
            <Input className="min-w-0 flex-1" aria-label={t('Waarom werkt dit niet meer?')} placeholder={t('Waarom werkt dit niet meer?')} value={why} onChange={(e) => setWhy(e.target.value)} />
            <Button size="sm" variant="primary" loading={a.busy} disabled={why.trim().length < 3} onClick={() => a.run(async () => (await spApi.retire(agentId, f.ref, why.trim()), setRetiring(false), onChange()), t('Vervallen: de bot gebruikt dit niet meer'))}>
              Laten vervallen
            </Button>
          </div>
        )}
      </div>
      <Menu
        label={t('Acties voor: {0}', f.content.slice(0, 60))}
        className="-me-2 -mt-1"
        items={[
          !!f.changeId && { label: 'Ongedaan maken', icon: <RotateCcw />, disabled: a.busy, onSelect: () => void a.run(async () => (await spApi.undoChange(f.changeId!), onChange()), 'Ongedaan gemaakt') },
          { label: 'Werkt niet meer…', icon: <Ban />, onSelect: () => setRetiring(true) },
          {
            label: 'Klopt niet, vergeten…',
            icon: <Trash2 />,
            danger: true,
            onSelect: async () => {
              if (!(await askConfirm('Dit feit vergeten? Het verdwijnt uit de kennisbank en wordt niet opnieuw geleerd.', { ok: 'Vergeten', danger: true }))) return;
              await a.run(async () => (await spApi.forget(f.id), onChange()), 'Vergeten');
            },
          },
        ]}
      />
    </li>
  );
}

function FactsTab({ agentId }: { agentId: string }) {
  const { data, error, reload } = useSpecialistData(() => spApi.knowledge(agentId), agentId);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  if (error && !data) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <Spinner />;
  const n = q.trim().toLowerCase();
  const list = n ? data.facts.filter((f) => f.content.toLowerCase().includes(n) || (f.source || '').toLowerCase().includes(n)) : data.facts;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1" aria-label="Zoeken in de kennisbank" placeholder="Zoeken in de kennisbank" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button variant="ghost" size="icon" aria-label="Zelf een feit toevoegen" title="Zelf een feit toevoegen" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {data.facts.length === 0 ? (
        <Card>
          <EmptyState icon={<BookOpen />} title="De kennisbank is nog leeg">
            Na de eerste leerronde staan hier de feiten uit zijn bronnen. Klik op Nu leren om te beginnen.
          </EmptyState>
        </Card>
      ) : (
        <Card className="px-4">
          <ul>
            {list.map((f) => (
              <FactLine key={f.id} f={f} agentId={agentId} onChange={reload} />
            ))}
          </ul>
          {list.length === 0 && <p className="py-4 text-sm text-muted">Niets gevonden.</p>}
        </Card>
      )}
      {(data.retired?.length || 0) > 0 && (
        <Card className="px-4">
          <CardHead as="h3" className="pt-3" icon={Ban} tone="rose" title="Niet meer doen" />
          <p className="text-xs text-muted">Wat vroeger klopte en nu niet meer. De bot krijgt dit te zien als “niet meer doen”.</p>
          <ul>
            {data.retired!.map((r) => (
              <li key={r.id} className="space-y-0.5 border-b border-line py-2 last:border-0">
                <p className="text-sm text-muted line-through [overflow-wrap:anywhere]">{r.content}</p>
                <p className="text-xs text-muted [overflow-wrap:anywhere]">{t('Sinds {0}: {1}', formatDate(r.since, { dateStyle: 'medium' }), r.reason)}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <AddFact open={adding} agentId={agentId} onClose={() => setAdding(false)} onDone={reload} />
    </div>
  );
}

function AddFact({ open, agentId, onClose, onDone }: { open: boolean; agentId: string; onClose(): void; onDone(): void }) {
  const [content, setContent] = useState('');
  const [source, setSource] = useState('');
  const a = useAsync();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Feit toevoegen"
      footer={
        <>
          <Button onClick={onClose}>Annuleren</Button>
          <Button
            variant="primary"
            loading={a.busy}
            disabled={content.trim().length < 8}
            onClick={() =>
              a.run(async () => {
                const r = await spApi.addFact(agentId, content.trim(), source.trim());
                toast(r.action === 'duplicate' ? 'Dit stond er al in.' : r.action === 'conflict' ? 'Dit botst met wat er al staat; het staat bij Te controleren.' : 'Toegevoegd', r.action === 'inserted' ? 'ok' : 'neutral');
                setContent('');
                setSource('');
                onDone();
                onClose();
              })
            }
          >
            Toevoegen
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Feit" hint="Eén hele zin, controleerbaar. Geen opdrachten, wachtwoorden of persoonsgegevens.">
          <Textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
        <Field label="Bron (mag leeg)">
          <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://…" />
        </Field>
      </div>
    </Modal>
  );
}

function ReviewTab({ agentId }: { agentId: string }) {
  const { data, error, reload } = useSpecialistData(() => spApi.knowledge(agentId), agentId);
  const a = useAsync();
  if (error && !data) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <Spinner />;
  if (!data.review.length)
    return (
      <Card>
        <EmptyState icon={<Check />} title="Niets te controleren">
          Spreekt een nieuwe bron iets tegen wat de specialist al weet, dan kies jij hier wat klopt.
        </EmptyState>
      </Card>
    );
  const act = (fn: () => Promise<any>, ok: string) => a.run(async () => (await fn(), reload()), ok);
  return (
    <div className="space-y-3">
      {data.review.map((f) => (
        <Card key={f.id} className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-[10px] border border-line p-3">
              <div className="mb-1 text-xs font-semibold text-warn">Nieuw gevonden</div>
              <p className="text-sm [overflow-wrap:anywhere]">{f.content}</p>
              <div className="mt-1 text-xs text-muted">
                {'Bron: '}
                <SourceLink url={f.source} label={f.sourceLabel} /> · {formatDate(f.learnedAt, { dateStyle: 'medium' })}
              </div>
              {f.quote && <blockquote className="mt-1 border-s-2 border-line ps-2 text-xs italic text-muted [overflow-wrap:anywhere]">{f.quote}</blockquote>}
            </div>
            <div className="rounded-[10px] border border-line p-3">
              <div className="mb-1 text-xs font-semibold text-muted">Wat hij al wist</div>
              {f.existing ? (
                <>
                  <p className="text-sm [overflow-wrap:anywhere]">{f.existing.content}</p>
                  {f.existing.source && (
                    <div className="mt-1 text-xs text-muted">
                      {'Bron: '}
                      <SourceLink url={f.existing.source} />
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted">{f.reason === 'conflict' ? 'Het oude feit staat niet meer in de kennisbank.' : 'Dit is een voorstel dat eerst beoordeeld wordt.'}</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" loading={a.busy} onClick={() => act(() => spApi.approve(f.id, f.existing?.id ? 'replace' : 'approve'), 'Het nieuwe feit staat nu in de kennisbank')}>
              {f.existing?.id ? 'Nieuw klopt' : 'Klopt'}
            </Button>
            {f.existing?.id && (
              <Button size="sm" loading={a.busy} onClick={() => act(() => spApi.approve(f.id, 'keep_both'), 'Allebei bewaard')}>
                Allebei houden
              </Button>
            )}
            <Button size="sm" variant="ghost" loading={a.busy} onClick={() => act(() => spApi.reject(f.id), 'Afgewezen; dit wordt niet opnieuw voorgesteld')}>
              {f.existing?.id ? 'Oud klopt' : 'Klopt niet'}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

const ORIGIN: Record<Goal['origin'], string> = { gap: 'uit een gesprek', selftest: 'uit de zelftest', owner: 'door jou', bot: 'door de bot' };

function GoalsTab({ agentId, enabled }: { agentId: string; enabled: boolean }) {
  const { data, error, reload } = useSpecialistData(() => spApi.goals(agentId), agentId);
  const [q, setQ] = useState('');
  const a = useAsync();
  if (error && !data) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <Spinner />;
  const open = data.filter((g) => g.status === 'open');
  const done = data.filter((g) => g.status !== 'open').slice(0, 30);
  return (
    <div className="space-y-4">
      {enabled && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) a.run(async () => (await spApi.addGoal(agentId, q.trim()), setQ(''), reload()), 'Leerdoel toegevoegd');
          }}
        >
          <Input className="min-w-0 flex-1" aria-label="Nieuw leerdoel" placeholder="Wat moet hij uitzoeken? Hij kijkt er de volgende leerronde naar." value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" icon={<Plus className="h-4 w-4" />} loading={a.busy} disabled={!q.trim()}>
            Toevoegen
          </Button>
        </form>
      )}
      {open.length === 0 ? (
        <p className="text-sm text-muted">Geen open leerdoelen.</p>
      ) : (
        <Card className="px-4">
          <ul>
            {open.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-2 border-b border-line py-3 last:border-0">
                <Lightbulb className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{g.question}</span>
                <Badge>{ORIGIN[g.origin]}</Badge>
                {g.hits > 1 && <Badge tone="warn">{t('{0} keer gevraagd', g.hits)}</Badge>}
                <Button size="sm" variant="ghost" onClick={() => a.run(async () => (await spApi.setGoal(g.id, 'dropped'), reload()))}>
                  Weghalen
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {done.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[13px] font-semibold">Afgerond</h3>
          <Card className="px-4">
            <ul>
              {done.map((g) => (
                <li key={g.id} className="space-y-0.5 border-b border-line py-2 text-sm last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{g.question}</span>
                    <Badge tone={g.status === 'done' ? 'ok' : 'neutral'}>{g.status === 'done' ? 'beantwoord' : 'weggehaald'}</Badge>
                    <Button size="sm" variant="ghost" onClick={() => a.run(async () => (await spApi.removeGoal(g.id), reload()))}>
                      Verwijderen
                    </Button>
                  </div>
                  {g.answer_text && <p className="text-xs text-muted [overflow-wrap:anywhere]">{g.answer_text}</p>}
                  {g.note && <p className="text-xs text-muted">{g.note}</p>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

const LINE_TONE: Partial<Record<RoundLine['kind'], 'ok' | 'warn' | 'danger' | 'neutral'>> = { new: 'ok', conflict: 'warn', ignored: 'warn', rejected: 'neutral', error: 'danger', skipped: 'warn', goal: 'ok' };
const LINE_LABEL: Record<RoundLine['kind'], string> = { new: 'nieuw', duplicate: 'al bekend', conflict: 'te controleren', proposed: 'voorstel', ignored: 'genegeerd', rejected: 'niet opgeslagen', error: 'fout', unchanged: 'ongewijzigd', skipped: 'overgeslagen', goal: 'leerdoel' };
const TRIGGER: Record<string, string> = { auto: 'vanzelf', routine: 'volgens de leerroutine', manual: 'handmatig', test: 'handmatig', fallback: 'door TeamBot', owner: 'door jou toegevoegd', bot: 'door een bot toegevoegd' };

function RoundCard({ r, onChange }: { r: Round; onChange(): void }) {
  const [open, setOpen] = useState(false);
  const a = useAsync();
  const undoable = r.lines.some((l) => l.changeId && !l.undone && ['new', 'conflict', 'proposed'].includes(l.kind));
  const undo = (index?: number) =>
    a.run(async () => {
      const res = await spApi.undoRound(r.id, index);
      if (res.failed.length) toast(res.failed[0], 'danger');
      else toast('Ongedaan gemaakt', 'ok');
      onChange();
    });
  const shown = r.lines.filter((l) => l.kind !== 'unchanged' && l.kind !== 'duplicate');
  return (
    <Card className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{formatDateTime(r.started_at)}</span>
        <Badge tone={r.status === 'error' ? 'danger' : r.status === 'running' ? 'accent' : 'neutral'}>{r.status === 'running' ? 'bezig' : TRIGGER[r.trigger] || r.trigger}</Badge>
        <span className="min-w-0 flex-1 text-sm text-muted [overflow-wrap:anywhere]">{r.status === 'error' ? r.error : r.summary}</span>
        {shown.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Minder' : 'Details'}
          </Button>
        )}
        {undoable && (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={a.busy} onClick={() => undo()}>
            Alles ongedaan maken
          </Button>
        )}
      </div>
      {open && (
        <ul className="space-y-1.5">
          {r.lines.map((l, i) =>
            l.kind === 'unchanged' || l.kind === 'duplicate' ? null : (
              <li key={i} className={cx('flex flex-wrap items-start gap-2 text-sm', l.undone && 'opacity-60 line-through')}>
                <Badge tone={LINE_TONE[l.kind] || 'neutral'}>{LINE_LABEL[l.kind]}</Badge>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {l.text}
                  {l.existing && <span className="block text-xs text-muted">{t('Botst met: {0}', l.existing.text)}</span>}
                  {l.source && (
                    <span className="block text-xs text-muted">
                      {'Bron: '}
                      <SourceLink url={l.source} label={l.sourceLabel} />
                    </span>
                  )}
                </span>
                {l.changeId && !l.undone && ['new', 'conflict', 'proposed'].includes(l.kind) && (
                  <Button size="sm" variant="ghost" onClick={() => undo(i)}>
                    Ongedaan maken
                  </Button>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </Card>
  );
}

function ReportsTab({ agentId, name }: { agentId: string; name: string }) {
  const { data, error, reload } = useSpecialistData(() => spApi.reports(agentId), agentId);
  const a = useAsync();
  useEffect(() => {
    for (const r of data?.reports || []) if (!r.seen_at) void spApi.seen(r.id).catch(() => {});
  }, [data]);
  if (error && !data) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted">{t('Elke week schrijft {0} op wat hij leerde.', name)}</p>
        <Button size="sm" loading={a.busy} onClick={() => a.run(async () => (await spApi.makeReport(agentId), reload()), 'Leerverslag gemaakt')}>
          Verslag nu maken
        </Button>
      </div>
      {data.reports.map((r: Report) => (
        <Card key={r.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{t('Leerverslag van {0} tot {1}', formatDate(r.period_from, { dateStyle: 'medium' }), formatDate(r.period_to, { dateStyle: 'medium' }))}</span>
            {!r.seen_at && <Badge tone="accent">nieuw</Badge>}
          </div>
          <p className="text-sm">{r.summary}</p>
          {r.data.facts.length > 0 && (
            <ul className="list-disc space-y-1 ps-5 text-sm">
              {r.data.facts.slice(0, 20).map((f, i) => (
                <li key={i} className="[overflow-wrap:anywhere]">
                  {f.text}{' '}
                  {f.source && (
                    <span className="text-xs text-muted">
                      (<SourceLink url={f.source} label={f.sourceLabel} />)
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {r.data.errors.length > 0 && <p className="text-xs text-warn [overflow-wrap:anywhere]">{t('Niet gelukt: {0}', r.data.errors.join(' · '))}</p>}
          {r.data.facts.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={async () => {
                if (!(await askConfirm('Alles wat in dit verslag geleerd is ongedaan maken?', { ok: 'Ongedaan maken', danger: true }))) return;
                await a.run(async () => {
                  const res = await spApi.undoReport(r.id);
                  if (res.failed.length) toast(res.failed[0], 'danger');
                  reload();
                }, 'Ongedaan gemaakt');
              }}
            >
              Alles ongedaan maken
            </Button>
          )}
        </Card>
      ))}
      <h3 className="text-[13px] font-semibold">Leerrondes</h3>
      {data.rounds.length === 0 ? <p className="text-sm text-muted">Nog geen leerronde gedraaid.</p> : data.rounds.map((r) => <RoundCard key={r.id} r={r} onChange={reload} />)}
    </div>
  );
}
