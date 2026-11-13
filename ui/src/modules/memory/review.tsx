import React, { useState } from 'react';
import { AlertTriangle, ArrowRight, Ban, Check, ClipboardCheck, GitMerge, ShieldAlert, Trash2, X, GraduationCap, Wrench, Coins, Gauge } from 'lucide-react';
import { api } from '../../lib/api';
import { stripRefs } from '../../lib/preview';
import { useApp } from '../../lib/store';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Tabs, Toggle, timeAgo, toast, useAsync, CardHead } from '../../components/ui';
import { ChangeRow, ErrorBox, ForgetDialog, ItemCard, ItemEditor, Loading, Meter } from './parts';
import { MoreOptions } from '../../components/MoreOptions';
import { ExportButtons, MemoryShell } from './pages';
import { ALL_TEAMS, type Change, type MemItem, engineLabel, fmtDate, memPath, REASON_LABEL, REVIEW_OPTIONS, reviewLabel, SCOPE_LABEL, SOURCE_LABEL, teamQuery, TYPE_LABEL, useMem, useMemTeams, useTeamFilter } from './lib';
import { t, translate } from '../../lib/i18n';
import { Words } from '../../components/Words';
import { formatSeconds, formatUsd, formatBytes } from '../../lib/format';
import { SemanticCard } from './semantic';
import { SizeCard } from './size';
import { Segmented } from '../../components/SettingControls';
import { ReportCard } from './learned';
import { MoreInfo } from '../../components/MoreInfo';
import { AssistantImport } from './assistant-import';

// ------------------------------------------------------------------ review queue

export function ReviewPage() {
  const r = useMem<any>('/memory/review');
  const [sel, setSel] = useState<string[]>([]);
  const { run, busy } = useAsync();
  const bulk = (action: 'approve' | 'reject') =>
    run(async () => {
      const out = await api.post('/memory/items/bulk', { ids: sel, action });
      setSel([]);
      r.reload();
      const failed = out.results.filter((x: any) => !x.ok);
      if (failed.length) toast(`${out.ok} gelukt, ${failed.length} niet: ${failed[0].error}`, 'danger');
      else toast(action === 'approve' ? `${out.ok} goedgekeurd` : `${out.ok} geweigerd`, 'ok');
    });
  const total = r.data ? r.data.proposals.length + r.data.due.length + r.data.decisions.length : 0;
  return (
    <MemoryShell tab="beoordelen">
      {r.error ? (
        <ErrorBox error={r.error} retry={r.reload} />
      ) : !r.data ? (
        <Loading />
      ) : total === 0 ? (
        <Card>
          <EmptyState icon={<ClipboardCheck />} title="Niets te beoordelen">
            Als een bot iets wil onthouden waar jij over moet beslissen, staat het hier.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-5">
          {r.data.proposals.length > 0 && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold">Voorstellen ({r.data.proposals.length})</h2>
                <label className="ms-auto flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={sel.length > 0 && sel.length === r.data.proposals.length}
                    onChange={(e) => setSel(e.target.checked ? r.data.proposals.map((p: any) => p.item.id) : [])}
                  />
                  Alles selecteren
                </label>
                <Button size="sm" disabled={!sel.length} loading={busy} onClick={() => bulk('approve')}>
                  Goedkeuren ({sel.length})
                </Button>
                <Button size="sm" disabled={!sel.length} loading={busy} onClick={() => bulk('reject')}>
                  Weigeren ({sel.length})
                </Button>
              </div>
              {r.data.proposals.map((p: any) => (
                <ProposalCard key={p.item.id} p={p} selected={sel.includes(p.item.id)} onSelect={(v) => setSel(v ? [...sel, p.item.id] : sel.filter((x) => x !== p.item.id))} reload={r.reload} />
              ))}
            </section>
          )}
          {r.data.decisions.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Besluiten die botsen ({r.data.decisions.length})</h2>
              {r.data.decisions.map((x: any) => (
                <DecisionCard key={x.record.id} x={x} reload={r.reload} />
              ))}
            </section>
          )}
          {r.data.due.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">
                Klopt dit nog? ({r.data.due.length}) <MoreInfo>Herinneringen komen hier terug als hun nakijkdatum is bereikt.</MoreInfo>
              </h2>
              {r.data.due.map((i: MemItem) => (
                <DueCard key={i.id} item={i} reload={r.reload} />
              ))}
            </section>
          )}
        </div>
      )}
    </MemoryShell>
  );
}

function ProposalCard({ p, selected, onSelect, reload }: { p: { item: MemItem; conflict: MemItem | null; merged: MemItem[] }; selected: boolean; onSelect(v: boolean): void; reload(): void }) {
  const it = p.item;
  const { run, busy } = useAsync();
  const [edit, setEdit] = useState(false);
  const agents = useApp((s) => s.agents);
  const by = it.created_by_agent ? agents.find((a) => a.id === it.created_by_agent)?.name || 'een bot' : it.created_by === 'import' ? 'een import' : it.created_by === 'system' ? 'TeamBot' : 'jou';
  const decide = (mode?: string) =>
    run(async () => {
      await api.post(`/memory/items/${it.id}/approve`, mode ? { mode } : {});
      reload();
    }, mode === 'keep_both' ? 'Beide bewaard' : 'Goedgekeurd');
  const reject = () =>
    run(async () => {
      await api.post(`/memory/items/${it.id}/reject`, {});
      reload();
    }, 'Geweigerd (wordt niet opnieuw voorgesteld)');
  // "Oude houden": the new statement is refused (and not proposed again); what was stored stays as it is.
  const keepOld = () =>
    run(async () => {
      await api.post(`/memory/items/${it.id}/reject`, {});
      reload();
    }, 'De oude herinnering blijft staan');
  const warn = it.flags?.includes('injection') || it.flags?.includes('external') || it.flags?.includes('tainted');
  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label="Selecteren" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge tone="warn">{REASON_LABEL[it.proposal_reason || ''] || 'Voorstel'}</Badge>
            <Badge>{TYPE_LABEL[it.type]}</Badge>
            <Badge tone={it.scope === 'shared' ? 'accent' : 'neutral'}>{it.scope === 'agent' ? it.agent_name || 'Bot' : it.scope === 'dossier' ? it.dossier_title || 'Dossier' : SCOPE_LABEL[it.scope]}</Badge>
            {it.sensitivity === 'sensitive' && <Badge tone="danger">Gevoelig</Badge>}
            <span className="text-muted">
              voorgesteld door {by} · {timeAgo(it.created_at)} · bron: {SOURCE_LABEL[it.source_kind] || it.source_kind}
            </span>
          </div>
          {warn && (
            <div className="flex items-start gap-1.5 rounded-lg bg-warn-soft p-2 text-xs text-warn">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {it.flags.includes('injection')
                ? 'Dit leest als een opdracht aan een bot. Keur alleen goed als dit echt jouw wens is.'
                : 'Dit kwam tot stand na het lezen van externe inhoud (web, bestand, kanaal). Controleer of het klopt.'}
            </div>
          )}
          {p.conflict ? (
            <div className="space-y-1.5">
              <p className="text-xs text-muted">Dit spreekt tegen wat er al in het geheugen staat. Er is nog niets vervangen: kies wat klopt.</p>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                <div className="rounded-lg border border-line p-2 text-sm">
                  <div className="mb-0.5 text-xs text-muted">Oud — nu bewaard (sinds {fmtDate(p.conflict.observed_at || p.conflict.created_at)})</div>
                  <span translate="no">{p.conflict.content}</span>
                </div>
                <ArrowRight className="mx-auto hidden h-4 w-4 text-muted sm:block" aria-hidden />
                <div className="rounded-lg border border-accent/50 bg-accent-soft p-2 text-sm">
                  <div className="mb-0.5 text-xs text-muted">Nieuw ({timeAgo(it.created_at)})</div>
                  <span translate="no">{it.content}</span>
                </div>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm" translate="no">{it.content}</p>
          )}
          {p.merged.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-muted">
                <GitMerge className="h-3.5 w-3.5" /> Voegt samen ({p.merged.length}):
              </div>
              <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted">
                {p.merged.map((m) => (
                  <li key={m.id} translate="no">{m.content}</li>
                ))}
              </ul>
            </div>
          )}
          {it.source_excerpt && <p className="line-clamp-2 text-xs text-muted">Uit: “{it.source_excerpt}”</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 ps-6">
        {p.conflict ? (
          <>
            <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy} onClick={() => decide('replace')}>
              Nieuwe bewaren (oude vervangen)
            </Button>
            <Button size="sm" loading={busy} onClick={keepOld}>
              Oude houden
            </Button>
            <Button size="sm" loading={busy} onClick={() => decide('keep_both')}>
              Beide houden
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy} onClick={() => decide()}>
            {p.merged.length ? 'Samenvoegen' : 'Goedkeuren'}
          </Button>
        )}
        <Button size="sm" onClick={() => setEdit(true)}>
          Aanpassen
        </Button>
        {!p.conflict && (
          <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} loading={busy} onClick={reject}>
            Weigeren
          </Button>
        )}
      </div>
      {edit && <ItemEditor item={it} onClose={() => setEdit(false)} onSaved={() => (setEdit(false), reload())} />}
    </Card>
  );
}

function DecisionCard({ x, reload }: { x: any; reload(): void }) {
  const { run, busy } = useAsync();
  const rec = x.record;
  return (
    <Card className="space-y-2 p-3 text-sm">
      <div className="text-xs text-muted">
        Dossier{' '}
        <a className="text-accent hover:underline" href={memPath(`dossiers/${rec.dossier_id}`)} translate="no">
          {rec.dossier_title}
        </a>{' '}
        · <Words text="voorgesteld door {0}" values={[rec.author_name]} /> · {timeAgo(rec.created_at)}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-line p-2">
          <div className="mb-0.5 text-xs text-muted">Huidig besluit</div>
          <span translate="no">{x.conflict?.title || '—'}</span>
        </div>
        <div className="rounded-lg border border-accent/50 bg-accent-soft p-2">
          <div className="mb-0.5 text-xs text-muted">Nieuw</div>
          <span translate="no">{rec.title}</span>
          {rec.body && <div className="mt-1 text-xs text-muted" translate="no">{rec.body}</div>}
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={() => run(async () => (await api.patch(`/memory/records/${rec.id}`, { status: 'active' }), reload()), 'Nieuw besluit geldt nu')}>
          Nieuw besluit aannemen
        </Button>
        <Button size="sm" loading={busy} onClick={() => run(async () => (await api.patch(`/memory/records/${rec.id}`, { status: 'trashed' }), reload()), 'Voorstel weggegooid')}>
          Weigeren
        </Button>
      </div>
    </Card>
  );
}

/** "Klopt dit nog?": a memory whose check date has come (its own interval, or a one-time check from maintenance). */
function DueCard({ item, reload }: { item: MemItem; reload(): void }) {
  const { run, busy } = useAsync();
  const [edit, setEdit] = useState(false);
  const [forget, setForget] = useState(false);
  const every = item.review_every_days || 0;
  return (
    <div className="space-y-1">
      <ItemCard item={item} onChanged={reload} />
      {item.review_note && <p className="ps-1 text-xs text-warn">{t('Te controleren: {0}', item.review_note)}</p>}
      <div className="flex flex-wrap items-center gap-2 ps-1">
        <Button
          size="sm"
          variant="primary"
          icon={<Check className="h-3.5 w-3.5" />}
          loading={busy}
          onClick={() => run(async () => (await api.post(`/memory/items/${item.id}/confirm`, {}), reload()), every ? `Bevestigd · volgende keer over ${({ 30: 'een maand', 90: '3 maanden', 180: '6 maanden', 365: 'een jaar' } as Record<number, string>)[every] || t('{0, plural, one {# dag} other {# dagen}}', every)}` : 'Bevestigd')}
        >
          Klopt nog
        </Button>
        <Button size="sm" onClick={() => setEdit(true)}>
          Aanpassen
        </Button>
        <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setForget(true)}>
          Vergeten
        </Button>
        <span className="text-xs text-muted">{every ? `Nakijken: ${reviewLabel(every).toLowerCase()}` : 'Eenmalige controle'}</span>
      </div>
      {edit && <ItemEditor item={item} onClose={() => setEdit(false)} onSaved={() => (setEdit(false), run(async () => (await api.post(`/memory/items/${item.id}/confirm`, {}), reload())))} />}
      {forget && <ForgetDialog item={item} onClose={() => setForget(false)} onDone={() => (setForget(false), reload())} />}
    </div>
  );
}

// ------------------------------------------------------------------ history / undo / blocks

export function HistoryPage() {
  const [tab, setTab] = useState<'changes' | 'episodes' | 'blocks'>('changes');
  const [actor, setActor] = useState('');
  const [op, setOp] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  // The page's team filter: changes and summaries of that team (forget-blocks are for every team).
  const [team] = useTeamFilter();
  const changes = useMem<Change[]>(`/memory/changes?limit=60${actor ? `&actor=${actor}` : ''}${op ? `&op=${op}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}${teamQuery(team)}`, [actor, op, before, team]);
  const blocks = useMem<any[]>(tab === 'blocks' ? '/memory/blocks' : null, [tab]);
  const eps = useMem<any[]>(tab === 'episodes' ? `/memory/episodes${team ? `?teamId=${encodeURIComponent(team)}` : ''}` : null, [tab, team]);
  const { run, busy } = useAsync();
  return (
    <MemoryShell tab="geschiedenis">
      <Tabs
        value={tab}
        onChange={(v) => setTab(v as any)}
        tabs={[
          { id: 'changes', label: 'Wijzigingen' },
          { id: 'episodes', label: 'Gesprekssamenvattingen' },
          { id: 'blocks', label: 'Vergeten' },
        ]}
      />
      <div key={tab} className="tb-in pt-3">
        {tab === 'changes' && (
          // What the nightly clean-up changed (and last month's report), each line with its own undo.
          <div className="mb-4 space-y-3">
            <ReportCard monthly />
            <ReportCard />
          </div>
        )}
        {tab === 'changes' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Select style={{ width: 'auto' }} value={actor} onChange={(e) => (setActor(e.target.value), setBefore(null))} aria-label="Door wie">
                <option value="">Iedereen</option>
                <option value="user">Door jou</option>
                <option value="agent">Door bots</option>
                <option value="system">Door TeamBot</option>
                <option value="import">Import</option>
              </Select>
              <Select style={{ width: 'auto' }} value={op} onChange={(e) => (setOp(e.target.value), setBefore(null))} aria-label="Soort wijziging">
                <option value="">Alle wijzigingen</option>
                {['create', 'propose', 'approve', 'reject', 'update', 'supersede', 'invalidate', 'merge', 'archive', 'trash', 'restore', 'forget', 'expire', 'undo'].map((k) => (
                  <option key={k} value={k}>
                    {({ create: 'Aangemaakt', propose: 'Voorgesteld', approve: 'Goedgekeurd', reject: 'Afgewezen', update: 'Bewerkt', supersede: 'Vervangen', invalidate: 'Klopt niet meer', merge: 'Samengevoegd', archive: 'Gearchiveerd', trash: 'Prullenbak', restore: 'Teruggezet', forget: 'Vergeten', expire: 'Verlopen', undo: 'Ongedaan' } as any)[k]}
                  </option>
                ))}
              </Select>
            </div>
            {changes.error ? (
              <ErrorBox error={changes.error} retry={changes.reload} />
            ) : !changes.data ? (
              <Loading />
            ) : changes.data.length === 0 ? (
              <Card>
                <EmptyState title="Geen wijzigingen" />
              </Card>
            ) : (
              <>
                <Card className="divide-y divide-line">
                  {changes.data.map((c) => (
                    <ChangeRow key={c.id} c={c} onUndone={changes.reload} showLink />
                  ))}
                </Card>
                {changes.data.length >= 60 && (
                  <div className="flex justify-center">
                    <Button size="sm" onClick={() => setBefore(changes.data![changes.data!.length - 1].created_at)}>
                      Oudere wijzigingen
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {tab === 'episodes' &&
          (eps.error ? (
            <ErrorBox error={eps.error} retry={eps.reload} />
          ) : !eps.data ? (
            <Loading />
          ) : eps.data.length === 0 ? (
            <Card>
              <EmptyState title="Nog geen samenvattingen">Na elk gesprek bewaart TeamBot een korte samenvatting.</EmptyState>
            </Card>
          ) : (
            <div className="space-y-2">
              {eps.data.map((e) => (
                <Card key={e.id} className="space-y-1 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <a className="min-w-0 flex-1 truncate font-medium text-accent hover:underline" href={`#/t/${e.thread_id}`}>
                      {e.title ? <span translate="no">{e.title}</span> : 'Gesprek'}
                    </a>
                    <span className="text-xs text-muted">
                      {e.agent_names.join(', ')} · {fmtDate(e.updated_at)}
                    </span>
                    <Button size="sm" variant="ghost" className="text-danger" loading={busy} onClick={() => run(async () => (await api.post(`/memory/episodes/${e.id}/forget`, {}), eps.reload()), 'Samenvatting vergeten')}>
                      Vergeten
                    </Button>
                  </div>
                  <p className="text-muted" translate="no">{stripRefs(e.summary)}</p>
                  {e.decisions.length > 0 && <p className="text-xs">Besluiten: {e.decisions.map((d: any) => d.text).join(' · ')}</p>}
                  {e.actions.length > 0 && <p className="text-xs">Acties: {e.actions.map((d: any) => d.text).join(' · ')}</p>}
                </Card>
              ))}
            </div>
          ))}
        {tab === 'blocks' && (
          <div className="space-y-2">
            <p className="text-sm text-muted">Vergeten dingen blijven geblokkeerd; hef een blokkade op om ze weer te onthouden.</p>
            {blocks.error ? (
              <ErrorBox error={blocks.error} retry={blocks.reload} />
            ) : !blocks.data ? (
              <Loading />
            ) : blocks.data.length === 0 ? (
              <Card>
                <EmptyState icon={<Ban className="h-6 w-6" />} title="Geen blokkades" />
              </Card>
            ) : (
              <Card className="divide-y divide-line">
                {blocks.data.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <Ban className="h-4 w-4 text-muted" />
                    {b.label ? <span className="min-w-0 flex-1" translate="no">{b.label}</span> : <span className="min-w-0 flex-1">Vergeten item</span>}
                    <span className="text-xs text-muted">{fmtDate(b.created_at)}</span>
                    <Button size="sm" loading={busy} onClick={() => run(async () => (await api.del(`/memory/blocks/${b.id}`), blocks.reload()), 'Blokkade opgeheven')}>
                      Opheffen
                    </Button>
                  </div>
                ))}
              </Card>
            )}
          </div>
        )}
      </div>
    </MemoryShell>
  );
}

// ------------------------------------------------------------------ storage, settings, import/export

export function StoragePage() {
  const r = useMem<any>('/memory/storage');
  const eng = useMem<any>('/memory/engine?options=1');
  const { run, busy } = useAsync();
  const [s, setS] = useState<any>(null);
  const teams = useMemTeams();
  const [wipe, setWipe] = useState('');
  const settings = s || r.data?.settings;
  const save = (patch: any) =>
    run(async () => {
      const next = await api.put('/memory/settings', patch);
      setS(next);
      r.reload();
    }, 'Opgeslagen');
  if (r.error) return <MemoryShell tab="opslag"><ErrorBox error={r.error} retry={r.reload} /></MemoryShell>;
  if (!r.data || !settings) return <MemoryShell tab="opslag"><Loading /></MemoryShell>;
  const d = r.data;
  return (
    <MemoryShell tab="opslag" actions={<ExportButtons />}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-4">
          <CardHead icon={GraduationCap} tone="violet" title="Leren" />
          <Segmented<string>
            label="Leermodus"
            value={settings.learnMode}
            onChange={(k) => save({ learnMode: k })}
            options={[
              { value: 'auto', label: 'Automatisch leren' },
              { value: 'explicit', label: 'Alleen op verzoek' },
              { value: 'off', label: 'Uit' },
            ]}
          />
          <MoreInfo block>
            <p>Automatisch: TeamBot leest het hele gesprek, wat je zelf zegt en wat je bot met zijn tools ontdekt. Wat jij zegt gaat altijd voor.</p>
            <p>Alleen op verzoek: alleen als je “onthoud dit” zegt of het zelf toevoegt.</p>
            <p>Uit: er wordt niets nieuws onthouden. Bestaand geheugen blijft bruikbaar.</p>
          </MoreInfo>
          <Toggle checked={settings.paused} onChange={(v) => save({ paused: v })} label="Even pauzeren (ook het onderhoud)" />
        </Card>

        <Card className="space-y-3 p-4">
          <CardHead icon={Wrench} tone="teal" title="Onderhoud" />
          <p className="text-xs text-muted">
            Elke nacht ruimt TeamBot je geheugen op. <MoreInfo>Ruimt 's nachts het geheugen op. Het verslag staat onder Geschiedenis, alles is terug te draaien.</MoreInfo>
          </p>
          <Toggle checked={settings.nightly} onChange={(v) => save({ nightly: v })} label="Elke nacht onderhoud uitvoeren" />
          <Button
            size="sm"
            loading={busy}
            onClick={() =>
              run(async () => {
                const out = await api.post<any>('/memory/maintenance', {});
                toast(out.lines?.length ? t('Onderhoud klaar: {0}', out.summary ? translate(out.summary) : t('{0, plural, one {# wijziging} other {# wijzigingen}}', out.lines.length)) : 'Onderhoud klaar: alles was al op orde', 'ok');
                r.reload();
              })
            }
          >
            Nu onderhoud uitvoeren
          </Button>
          {eng.data?.lastMaintenanceAt && <p className="text-xs text-muted">Laatste onderhoud: {fmtDate(eng.data.lastMaintenanceAt, true)}</p>}
        </Card>

        <SemanticCard settings={settings} save={save} />

        <AssistantImport />

        {/* Everything below is fine as it is for almost everyone: how learning works under the hood, the budgets, the
            quota, cleaning up and wiping. Folded, never removed; a link with ?meer=1 opens it. */}
        <div className="lg:col-span-2">
          <MoreOptions>
            <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-4">
          <CardHead icon={GraduationCap} tone="violet" title="Hoe TeamBot leert" />
          <Field label="Herkennen met" hint={<MoreInfo>Standaard het model van de bot zelf, als dat niets extra kost.</MoreInfo>}>
            <Select value={settings.extractor} onChange={(e) => save({ extractor: e.target.value })}>
              <option value="own">Slim, met het model van de bot (aanbevolen)</option>
              <option value="free">Slim, met een zuinig gratis model</option>
              <option value="heuristic">Niet nalezen (de bots houden het zelf bij)</option>
              <option value="model">Model van de bot, ook als dat geld kost</option>
            </Select>
          </Field>
          {settings.extractor !== 'heuristic' && (
            <>
              <Field label="Welk model" hint={eng.data?.engine ? (eng.data.today?.calls ? t('Nu: {0} · vandaag {1}× gebruikt, gemiddeld {2}, {3}', engineLabel(eng.data.engine.label), eng.data.today.calls, formatSeconds(eng.data.today.avgMs), eng.data.today.cost ? formatUsd(eng.data.today.cost) : translate('geen extra kosten')) : t('Nu: {0}', engineLabel(eng.data.engine.label))) : translate(eng.data?.blocked || 'Er is nu geen gratis model beschikbaar; je bots houden hun dossiers zelf bij.')}>
                <Select value={settings.engine?.providerId || ''} onChange={(e) => save({ engine: { providerId: e.target.value || null, model: null } })}>
                  <option value="">Automatisch (het model van de bot als dat gratis is)</option>
                  {(eng.data?.options || []).map((o: any) => (
                    <option key={o.providerId} value={o.providerId} disabled={o.billing === 'paid' && settings.extractor !== 'model'}>
                      {engineLabel(o.label)}
                      {o.available ? '' : ` — ${o.reason ? t('nu niet beschikbaar ({0})', translate(o.reason)) : translate('nu niet beschikbaar')}`}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Leren na zoveel beurten" hint="0 = alleen na stilte">
                  <Input type="number" min={0} max={500} defaultValue={settings.learnEvery ?? 20} onBlur={(e) => save({ learnEvery: Number(e.target.value) })} />
                </Field>
                <Field label="Of na zoveel minuten stilte">
                  <Input type="number" min={1} max={240} defaultValue={settings.quietMin} onBlur={(e) => save({ quietMin: Number(e.target.value) })} />
                </Field>
                <Field label="Max. modelaanroepen per dag" hint="0 = geen limiet">
                  <Input type="number" min={0} max={100000} defaultValue={settings.modelDailyCap} onBlur={(e) => save({ modelDailyCap: Number(e.target.value) })} />
                </Field>
              </div>
            </>
          )}
          <Toggle checked={settings.autoApply === 'own'} onChange={(v) => save({ autoApply: v ? 'own' : 'never' })} label="Wat TeamBot leert direct onthouden (uit: eerst als voorstel)" />
          <Field
            label="Bij tegenspraak"
            hint={
              <MoreInfo>{settings.conflicts === 'replace'
                ? 'Een nieuw feit dat een oud feit tegenspreekt, vervangt het direct. De oude versie blijft in de geschiedenis en je kunt het ongedaan maken.'
                : 'Een veranderd feit wordt direct bijgewerkt. Twijfelgevallen komen eerst bij Te beoordelen.'}</MoreInfo>
            }
          >
            <Select value={settings.conflicts || 'ask'} onChange={(e) => save({ conflicts: e.target.value })} aria-label="Bij tegenspraak">
              <option value="ask">Eerst aan mij vragen (aanbevolen)</option>
              <option value="replace">Direct vervangen (met ongedaan maken)</option>
            </Select>
          </Field>
          <Field label="Wat bots zelf in hun eigen geheugen zetten">
            <Select value={settings.botWrites} onChange={(e) => save({ botWrites: e.target.value })}>
              <option value="direct">Direct opslaan (met ongedaan maken)</option>
              <option value="propose">Eerst als voorstel</option>
            </Select>
          </Field>
          <Toggle checked={settings.episodes} onChange={(v) => save({ episodes: v })} label="Gesprekssamenvattingen bijhouden" />
        </Card>

        <Card className="space-y-3 p-4">
          <CardHead icon={Wrench} tone="teal" title="Nakijken en kernprofiel" />
          <Field label="Standaard nakijken" hint={<MoreInfo>Voor feiten die kunnen veranderen. Ze komen terug bij Te beoordelen als “Klopt dit nog?”.</MoreInfo>}>
            <Select value={String(settings.reviewEveryDays ?? 180)} onChange={(e) => save({ reviewEveryDays: Number(e.target.value) })} aria-label="Standaard nakijken">
              {REVIEW_OPTIONS.map((o) => (
                <option key={o.days} value={String(o.days)}>
                  {o.label}
                  {o.days === 180 ? ' (standaard)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Kernprofiel: altijd geladen (tokens)" hint="Je naam, woonplaats, werk en vaste voorkeuren die elke bot altijd weet. 0 = uit.">
            <Input type="number" min={0} max={2000} defaultValue={settings.briefTokens} onBlur={(e) => save({ briefTokens: Number(e.target.value) })} />
          </Field>
        </Card>

        <Card className="space-y-3 p-4">
          <CardHead icon={Coins} tone="amber" title="Budget per beurt" />
          <p className="text-xs text-muted">
            Hoeveel geheugen er per bericht meegaat. <MoreInfo>Meer = meer context maar hogere kosten. Vastgezette instructies tellen niet mee.</MoreInfo>
          </p>
          <Field label="Geheugen per beurt (tokens)">
            <Input type="number" min={0} max={d.limits.budgetTokens} defaultValue={settings.budgetTokens} onBlur={(e) => save({ budgetTokens: Number(e.target.value) })} />
          </Field>
          <Field label="Altijd-geladen profiel (vastgezette items, tokens)">
            <Input type="number" min={0} max={d.limits.profileCap} defaultValue={settings.profileCap} onBlur={(e) => save({ profileCap: Number(e.target.value) })} />
          </Field>
          <Field label="Prullenbak bewaren (dagen)">
            <Input type="number" min={1} max={365} defaultValue={settings.trashDays} onBlur={(e) => save({ trashDays: Number(e.target.value) })} />
          </Field>
        </Card>

        <SizeCard settings={settings} save={save} />

        <Card className="space-y-3 p-4">
          <CardHead icon={Gauge} tone="amber" title="Gebruik en quota" />
          <Meter label="Over jou" value={d.scopes.about_you.items} max={d.scopes.about_you.quota.items} hint={`${d.scopes.about_you.items} / ${d.scopes.about_you.quota.items} · ${formatBytes(d.scopes.about_you.bytes)}`} />
          {/* Shared knowledge has a quota per team (two or more teams), else one. */}
          {d.sharedByTeam?.length ? (
            d.sharedByTeam.map((x: any) => (
              <Meter key={x.teamId} label={x.teamId === ALL_TEAMS ? 'Gedeeld met alle teams' : t('Gedeeld in team {0}', x.name)} value={x.items} max={x.quota.items} hint={`${x.items} / ${x.quota.items} · ${formatBytes(x.bytes)}`} />
            ))
          ) : (
            <Meter label="Gedeeld" value={d.scopes.shared.items} max={d.scopes.shared.quota.items} hint={`${d.scopes.shared.items} / ${d.scopes.shared.quota.items} · ${formatBytes(d.scopes.shared.bytes)}`} />
          )}
          {d.agents.map((a: any) => (
            <Meter key={a.id} label={<Words text="Bot: {0}" values={[a.name]} />} value={a.items} max={a.quota.items} hint={`${a.items} / ${a.quota.items} · ${formatBytes(a.bytes)}`} />
          ))}
          {d.dossiers.slice(0, 8).map((x: any) => (
            <Meter key={x.id} label={<Words text="Dossier: {0}" values={[x.title]} />} value={x.items} max={x.quota.items} />
          ))}
          <Meter label="Gesprekssamenvattingen" value={d.episodes.items} max={d.episodes.quota.items} />
          <Meter label="Open voorstellen" value={d.proposals.items} max={d.proposals.quota} />
          <p className="text-xs text-muted">
            {t('Totaal {0} · {1, plural, one {# indexregel} other {# indexregels}} · {2, plural, one {# documentdeel} other {# documentdelen}} · {3, plural, one {# blokkade} other {# blokkades}}.', formatBytes(d.totalBytes), d.index.rows, d.index.chunks, d.blocks)}
          </p>
        </Card>

        <Card className="space-y-3 p-4">
          <CardHead icon={Trash2} title="Opruimen" />
          <p className="text-sm">
            {t('Prullenbak: {0, plural, one {# herinnering} other {# herinneringen}}, {1, plural, one {# dossierregel} other {# dossierregels}} (na {2, plural, one {# dag} other {# dagen}} automatisch weg).', d.trash.items, d.trash.records, d.trash.days)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={busy} disabled={!d.trash.items && !d.trash.records} onClick={() => run(async () => (await api.post('/memory/trash/empty', {}), r.reload()), 'Prullenbak geleegd')}>
              Prullenbak legen
            </Button>
            <Button size="sm" loading={busy} onClick={() => run(async () => toast(t('{0} dubbele samengevoegd. Het verslag staat in het overzicht, met ongedaan maken.', (await api.post('/memory/consolidate', {})).merged), 'ok'))}>
              Dubbele herinneringen zoeken
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={busy}
              onClick={() =>
                run(async () => {
                  const out = await api.post<any>('/memory/reindex', {});
                  toast(out.meaning === 'rebuilding' ? t('Index herbouwd ({0, plural, one {# regel} other {# regels}}).', out.indexed) : t('Index herbouwd ({0, plural, one {# regel} other {# regels}})', out.indexed), 'ok');
                })
              }
            >
              Zoekindex herbouwen
            </Button>
          </div>
          {d.stale.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Nooit gebruikt (ouder dan 60 dagen)</div>
              {d.stale.map((i: MemItem) => (
                <ItemCard key={i.id} item={i} compact onChanged={r.reload} />
              ))}
            </div>
          )}
        </Card>

        <Card className="space-y-3 border-danger/40 p-4 lg:col-span-2">
          <CardHead icon={AlertTriangle} tone="rose" title={<span className="text-danger">Alles wissen</span>} />
          <p className="text-sm text-muted">
            Verwijdert al je herinneringen, dossiers en geschiedenis. Exporteer eerst wat je wilt bewaren. <MoreInfo>Ook de samenvattingen gaan weg. Wat je liet vergeten blijft geblokkeerd.</MoreInfo>
          </p>
          <div className="flex flex-wrap gap-2">
            <Input style={{ width: '12rem' }} placeholder="Typ WISSEN" value={wipe} onChange={(e) => setWipe(e.target.value)} aria-label="Bevestiging" />
            <Button
              variant="danger"
              disabled={wipe !== 'WISSEN'}
              loading={busy}
              onClick={() =>
                run(async () => {
                  await api.post('/memory/delete-all', { confirm: 'WISSEN' });
                  setWipe('');
                  r.reload();
                }, 'Alles gewist')
              }
            >
              Alles wissen
            </Button>
          </div>
        </Card>
            </div>
          </MoreOptions>
        </div>
      </div>
    </MemoryShell>
  );
}
