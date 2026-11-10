import { useEffect, useRef, useState } from 'react';
import { BookOpen, GraduationCap, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Field, Input, Spinner, Toggle, toast, useAsync } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber } from '../../lib/format';
import { t } from '../../lib/i18n';
import { stableJson, useEditorSection } from '../../lib/editorSave';
import type { Agent } from '../../lib/types';
import { type BudgetId, type Cadence, type SourceKind, type SourceView, type SpecialistView, spApi, useSpecialistData } from './api';

export const KIND_LABEL: Record<SourceKind, string> = { web: 'Website', feed: 'Feed', docs: 'Documentatie', file: 'Eigen bestand' };
const KIND_HINT: Record<SourceKind, string> = {
  web: 'https://… een pagina die regelmatig verandert',
  feed: 'https://…/feed of …/rss.xml (RSS of Atom)',
  docs: 'https://…/docs/ (de pagina en een paar pagina’s eronder)',
  file: 'Bestand of map in de mappen van deze bot, bijv. kennis/notities.md',
};

interface Draft {
  enabled: boolean;
  field: string;
  learnOn: boolean;
  cadence: Cadence;
  budget: BudgetId;
  selfTest: boolean;
  learnWith: 'own' | 'cheap';
  sources: SourceView[];
}

const draftOf = (v: SpecialistView): Draft => ({
  enabled: v.enabled,
  field: v.field,
  learnOn: v.learnOn,
  cadence: v.cadence,
  budget: v.budget,
  selfTest: v.selfTest,
  learnWith: v.learnWith === 'cheap' ? 'cheap' : 'own',
  sources: v.sources.map((s) => ({ id: s.id, kind: s.kind, target: s.target, label: s.label, enabled: s.enabled, suggested: s.suggested })),
});
const comparable = (d: Draft) => ({ ...d, sources: d.sources.map((s) => ({ kind: s.kind, target: s.target, label: s.label, enabled: s.enabled })) });

export function sourceStatus(s: SourceView): { text: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' } | null {
  if (!s.lastCheckedAt) return s.suggested ? { text: 'Voorgesteld door het sjabloon; nog niet bekeken', tone: 'neutral' } : { text: 'Nog niet bekeken', tone: 'neutral' };
  const when = formatDateTime(s.lastCheckedAt);
  if (s.lastStatus === 'error') return { text: t('Fout op {0}: {1}', when, s.lastError || 'onbekend'), tone: 'danger' };
  if (s.lastStatus === 'blocked') return { text: t('Overgeslagen op {0}: {1}', when, s.lastError || 'robots.txt'), tone: 'warn' };
  if (s.lastStatus === 'unchanged') return { text: t('Bekeken op {0}: niets nieuws', when), tone: 'neutral' };
  return { text: t('Bekeken op {0}: nieuwe inhoud', when), tone: 'ok' };
}

/** "Specialisme" in the bot editor: field, sources, learning round (off until you turn it on), budget. */
export function SpecialistSection({ agent }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  if (!agent?.id) return <p className="text-sm text-muted">Sla de bot eerst op. Daarna kun je hem een specialist maken die zelf bijleert.</p>;
  return <SpecialistCard agentId={agent.id} agentName={agent.name} />;
}

function SpecialistCard({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { data, error, reload } = useSpecialistData(() => spApi.get(agentId), agentId);
  const [d, setD] = useState<Draft | null>(null);
  const [kind, setKind] = useState<SourceKind>('web');
  const [target, setTarget] = useState('');
  const [label, setLabel] = useState('');
  const save = useAsync();
  const learn = useAsync();
  // Fresh data from the server (a round finished, a status changed) replaces the draft only while nothing is edited.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (data) setD((cur) => (cur && dirtyRef.current ? cur : draftOf(data)));
  }, [data]);
  const dirty = () => !!d && !!data && stableJson(comparable(d)) !== stableJson(comparable(draftOf(data)));
  dirtyRef.current = dirty();

  async function persist() {
    if (!d) return;
    const pending = target.trim() ? [...d.sources, { kind, target: target.trim(), label: label.trim(), enabled: true }] : d.sources;
    const v = await spApi.save(agentId, { ...d, sources: pending });
    setTarget('');
    setLabel('');
    setD(draftOf(v));
    // The server gives a specialist the knowledge tools: that is stored already, not an unsaved change.
    const a = await api.get<Agent>(`/agents/${agentId}`).catch(() => null);
    if (a && editor) editor.synced({ tool_groups: a.tool_groups });
    reload();
  }
  const editor = useEditorSection('specialists:specialist', { label: 'Specialisme', dirty: () => dirty() || !!target.trim(), save: () => persist() });

  if (error && !data) return <p className="text-sm text-danger">{error}</p>;
  if (!data || !d) return <Spinner />;
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  const addSource = () => {
    if (!target.trim()) return;
    if (d.sources.some((s) => s.kind === kind && s.target === target.trim())) return toast('Deze bron staat er al');
    set({ sources: [...d.sources, { kind, target: target.trim(), label: label.trim(), enabled: true }] });
    setTarget('');
    setLabel('');
  };
  const budget = data.budgets.find((b) => b.id === d.budget);

  return (
    <div className="space-y-4" data-testid="specialist-card">
      <Toggle checked={d.enabled} onChange={(v) => set({ enabled: v })} label={<span className="font-semibold">Specialist in een vakgebied</span>} />
      <p className="text-xs leading-relaxed text-muted">
        Een specialist leert zelf bij uit bronnen die jij kiest. Wat hij leert komt met bron en datum in zijn kennisbank (in Geheugen); wat botst met wat hij al weet, zet hij klaar om te controleren.
      </p>
      {d.enabled && (
        <>
          <Field label="Vakgebied" hint="In één zin, bijvoorbeeld “SEO voor Nederlandse webshops” of “btw-regels voor zzp’ers”.">
            <Input value={d.field} maxLength={300} onChange={(e) => set({ field: e.target.value })} placeholder="Waar is deze bot specialist in?" />
          </Field>

          <div className="space-y-2">
            <h4 className="text-[13px] font-semibold" data-i18n="label">
              Bronnen
            </h4>
            {d.sources.length === 0 && <p className="text-xs text-muted">Nog geen bronnen. Voeg een website, feed, documentatie of een eigen bestand toe.</p>}
            <ul className="space-y-2">
              {d.sources.map((s, i) => {
                const st = data.sources.find((x) => x.kind === s.kind && x.target === s.target);
                const status = st ? sourceStatus(st) : { text: 'Nieuw; wordt opgeslagen met Opslaan', tone: 'neutral' as const };
                return (
                  <li key={`${s.kind}:${s.target}`} className="space-y-1 rounded-[10px] border border-line px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge tone={s.kind === 'feed' ? 'accent' : 'neutral'}>{KIND_LABEL[s.kind]}</Badge>
                      {s.suggested && <Badge tone="warn">voorgesteld</Badge>}
                      <span className="ms-auto flex items-center gap-1">
                        <Toggle checked={s.enabled} onChange={(v) => set({ sources: d.sources.map((x, j) => (j === i ? { ...x, enabled: v } : x)) })} label={<span className="sr-only">Bron gebruiken</span>} />
                        <Button size="iconSm" variant="ghost" aria-label="Bron verwijderen" title="Bron verwijderen" onClick={() => set({ sources: d.sources.filter((_, j) => j !== i) })}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium" translate="no" title={s.target}>
                        {s.label || s.target}
                      </div>
                      {s.label && (
                        <div className="truncate text-xs text-muted" translate="no">
                          {s.target}
                        </div>
                      )}
                      {status && <div className={`text-xs ${status.tone === 'danger' ? 'text-danger' : status.tone === 'warn' ? 'text-warn' : status.tone === 'ok' ? 'text-ok' : 'text-muted'} [overflow-wrap:anywhere]`}>{status.text}</div>}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="grid gap-2 sm:grid-cols-[9rem_1fr_10rem_auto]">
              <Select aria-label="Soort bron" value={kind} onChange={(e) => setKind(e.target.value as SourceKind)}>
                {(Object.keys(KIND_LABEL) as SourceKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
              <Input aria-label="Adres of pad" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={KIND_HINT[kind]} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addSource())} />
              <Input aria-label="Naam (mag leeg)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Naam (mag leeg)" />
              <Button icon={<Plus className="h-4 w-4" />} onClick={addSource} disabled={!target.trim()}>
                Toevoegen
              </Button>
            </div>
            <p className="text-xs text-muted">Bronnen zijn informatie, nooit opdrachten.</p>
          </div>

          <div className="space-y-3 rounded-[10px] border border-line p-3">
            <Toggle checked={d.learnOn} onChange={(v) => set({ learnOn: v })} label={<span className="font-semibold">Leerronde aan</span>} />
            <p className="text-xs text-muted">De specialist houdt zijn kennis zelf bij, zo vaak als jij kiest.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Hoe vaak">
                <Select value={d.cadence} onChange={(e) => set({ cadence: e.target.value as Cadence })}>
                  <option value="hourly">Elk uur</option>
                  <option value="daily">Elke dag</option>
                  <option value="weekly">Elke week</option>
                </Select>
              </Field>
              <Field label="Leert met">
                <Select value={d.learnWith} onChange={(e) => set({ learnWith: e.target.value as 'own' | 'cheap' })}>
                  <option value="own">Eigen model</option>
                  <option value="cheap">Goedkoper model (gratis of lokaal)</option>
                </Select>
              </Field>
              <Field label="Limiet per ronde" hint={budget && d.budget !== 'none' ? t('Hoogstens {0} tokens en {1, plural, one {# vraag} other {# vragen}} aan het model.', formatNumber(budget.tokens), budget.calls) : undefined}>
                <Select value={d.budget} onChange={(e) => set({ budget: e.target.value as BudgetId })}>
                  {data.budgets.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Toggle checked={d.selfTest} onChange={(v) => set({ selfTest: v })} label="Zelftest (één keer per week)" />
            <p className="text-xs text-muted">Bij de zelftest bedenkt de specialist vragen; wat hij niet weet, wordt een leerdoel.</p>
            <p className={`text-xs ${data.engine.problem ? 'text-warn' : 'text-muted'}`}>
              {data.engine.problem ? t('Leren lukt nu niet: {0}', data.engine.problem) : t('Leert met: {0}', data.engine.label)}
            </p>
            {data.enabled && data.learnOn && data.nextRoundAt && <p className="text-xs text-muted">{t('Volgende ronde: {0}.', formatDateTime(data.nextRoundAt))}</p>}
            {data.enabled && data.learnOn && data.skipped && <p className="text-xs text-warn">{t('De laatste ronde is overgeslagen: {0}', data.skipped.reason)}</p>}
            {data.lastRound && <p className="text-xs text-muted">{t('Laatste ronde ({0}): {1}', formatDateTime(data.lastRound.finished_at || data.lastRound.started_at), data.lastRound.summary || '')}</p>}
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!editor && (
          <Button variant="primary" loading={save.busy} disabled={!dirty() && !target.trim()} onClick={() => save.run(persist, 'Specialisme opgeslagen')}>
            Opslaan
          </Button>
        )}
        {data.enabled && (
          <Button
            icon={<GraduationCap className="h-4 w-4" />}
            loading={learn.busy}
            disabled={dirty() || !data.sources.some((s) => s.enabled)}
            title={dirty() ? 'Sla eerst op' : undefined}
            onClick={() =>
              learn.run(async () => {
                await spApi.learn(agentId);
                toast(t('{0} begint nu een leerronde. Het verslag staat straks in de kennisbank.', agentName), 'ok');
              })
            }
          >
            Nu leren
          </Button>
        )}
        {data.enabled && (
          <a className="inline-flex items-center gap-1.5 text-sm text-accent underline" href={`#/m/specialists/${agentId}`}>
            <BookOpen className="h-4 w-4" />
            {t('Kennisbank openen ({0, plural, one {# feit} other {# feiten}})', data.counts.facts)}
          </a>
        )}
        {dirty() && editor && <span className="text-xs text-warn">Wordt opgeslagen met Opslaan bovenaan.</span>}
      </div>
    </div>
  );
}
