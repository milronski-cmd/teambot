import React, { useEffect, useMemo, useState } from 'react';
import { Brain, Check, ChevronDown, ExternalLink, RefreshCw, Undo2 } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { stripRefs } from '../../lib/preview';
import { useApp } from '../../lib/store';
import type { Agent, Message, ToolCall } from '../../lib/types';
import { Badge, Button, Card, Field, Input, Select, Textarea, Toggle, cx, timeAgo, toast, useAsync } from '../../components/ui';
import { ErrorBox, Loading } from './parts';
import { type MemItem, memPath, REASON_LABEL, rememberToast, SCOPE_LABEL, STATUS_LABEL, useMem } from './lib';

// ------------------------------------------------------------------ inspector tab

/**
 * The Geheugen tab next to a chat. Calm by default: one box to remember something, then only what there is to show
 * (what the bot learned, the summary, what it used); an empty part shows nothing. The rarely needed choices (the
 * linked dossier, learning right now) sit under "Meer".
 */
export function MemoryInspector({ threadId, agentId }: { threadId: string; agentId: string | null }) {
  const r = useMem<any>(`/memory/thread/${threadId}`, [threadId]);
  const [content, setContent] = useState('');
  const [scope, setScope] = useState(agentId ? 'agent' : 'about_you');
  const { run, busy } = useAsync();
  if (r.error) return <ErrorBox error={r.error} retry={r.reload} />;
  if (!r.data) return <Loading />;
  const d = r.data;
  const last = d.usage[0];
  const head = 'text-xs font-semibold text-muted';
  const learnNow = d.agent?.learn === 'auto' && (
    <Button
      size="sm"
      variant="ghost"
      icon={<Brain className="h-3.5 w-3.5" />}
      loading={busy}
      onClick={() =>
        run(async () => {
          const out = await api.post<any>(`/memory/thread/${threadId}/learn`, { agentId });
          r.reload();
          toast(out.applied || out.proposed ? `${out.applied ? `${out.applied} onthouden` : ''}${out.applied && out.proposed ? ', ' : ''}${out.proposed ? `${out.proposed} voorgesteld` : ''}${out.method === 'heuristic' ? ' (vaste patronen)' : ''}` : 'Niets nieuws om te onthouden', 'ok');
        })
      }
    >
      Nu leren
    </Button>
  );
  return (
    <div className="space-y-4 text-sm">
      {d.agent && !d.agent.enabled && <p className="rounded-card bg-warn-soft p-2.5 text-xs text-warn">Geheugen staat uit voor {d.agent.name} (toolgroep Geheugen niet aan in de botinstellingen).</p>}
      {d.audience !== 'private' && (
        <p className="rounded-card bg-surface-2 p-2.5 text-xs text-muted">
          {d.audience === 'room'
            ? 'Groepsgesprek: automatisch gaat alleen gedeelde kennis mee; elke bot zoekt zijn eigen notities zelf op.'
            : d.audience === 'customer'
              ? 'Klantgesprek: de bot gebruikt alleen het dossier van deze klant, nooit iets anders uit het geheugen.'
              : 'Anderen lezen mee: persoonlijke en gevoelige herinneringen worden hier niet gebruikt.'}
        </p>
      )}

      <div className="rounded-group border border-line bg-surface p-2.5">
        <Textarea rows={2} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Wat moet onthouden worden?" aria-label="Snel vastleggen" />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <Select style={{ width: 'auto' }} value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Plek">
            {agentId && <option value="agent">Alleen deze bot</option>}
            <option value="about_you">Over jou</option>
            <option value="shared">Alle bots</option>
            {d.linkedDossier && <option value="dossier">Dossier {d.linkedDossier.title}</option>}
          </Select>
          <Button
            size="sm"
            variant="primary"
            disabled={!content.trim()}
            loading={busy}
            onClick={() =>
              run(async () => {
                const out = await api.post(`/memory/thread/${threadId}/capture`, { content, scope, agentId, dossierId: d.linkedDossier?.id });
                setContent('');
                toast(rememberToast(out.action), 'ok');
                r.reload();
              })
            }
          >
            Onthouden
          </Button>
        </div>
      </div>

      {d.learned.length > 0 && (
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className={head}>Geleerd uit dit gesprek</h3>
            {learnNow}
          </div>
          <ul className="space-y-1.5">
            {d.learned.map((i: MemItem) => (
              <li key={i.id} className="rounded-card border border-line p-2.5">
                <div className="flex flex-wrap items-center gap-1 text-xs">
                  <Badge tone={i.status === 'proposed' ? 'warn' : i.status === 'active' ? 'ok' : 'neutral'}>{STATUS_LABEL[i.status]}</Badge>
                  <Badge>{SCOPE_LABEL[i.scope]}</Badge>
                </div>
                <p className="mt-1">{i.content}</p>
                <a className="text-xs text-accent hover:underline" href={memPath(i.status === 'proposed' ? 'beoordelen' : `item/${i.id}`)}>
                  {i.status === 'proposed' ? 'Beoordelen' : 'Bekijken'}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.episode?.summary && (
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className={head}>Samenvatting van dit gesprek</h3>
            <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy} onClick={() => run(async () => (await api.post(`/memory/thread/${threadId}/episode/rebuild`, {}), r.reload()), 'Bijgewerkt')}>
              Opnieuw
            </Button>
          </div>
          <Card className="space-y-1.5 p-3">
            <p>{stripRefs(d.episode.summary)}</p>
            {d.episode.decisions.length > 0 && <List title="Besluiten" items={d.episode.decisions} />}
            {d.episode.actions.length > 0 && <List title="Acties" items={d.episode.actions} />}
            {d.episode.questions.length > 0 && <List title="Open vragen" items={d.episode.questions} />}
            <p className="text-xs text-muted">Bijgewerkt {timeAgo(d.episode.updated_at)}</p>
          </Card>
        </section>
      )}

      {last && (
        <section>
          <h3 className={cx(head, 'mb-1.5')}>Deze beurt gebruikt</h3>
          <UsageBlock u={last} />
          {d.usage.length > 1 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted">Eerdere beurten ({d.usage.length - 1})</summary>
              <div className="mt-2 space-y-3">
                {d.usage.slice(1).map((u: any) => (
                  <UsageBlock key={u.id} u={u} />
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      <details open={!!d.linkedDossier}>
        <summary className="cursor-pointer text-xs font-semibold text-muted">Meer</summary>
        <div className="mt-2 space-y-2">
          <Field label="Gekoppeld dossier">
            <Select value={d.linkedDossier?.id || ''} onChange={(e) => run(async () => (await api.put(`/memory/thread/${threadId}/link`, { dossierId: e.target.value || null }), r.reload()), 'Opgeslagen')} aria-label="Gekoppeld dossier">
              <option value="">Geen</option>
              {d.dossiers.map((x: any) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </Select>
          </Field>
          {d.learned.length === 0 && learnNow}
        </div>
      </details>
    </div>
  );
}

function List({ title, items }: { title: string; items: { text: string }[] }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted">{title}</div>
      <ul className="list-disc ps-4 text-xs">
        {items.map((x, i) => (
          <li key={i}>{x.text}</li>
        ))}
      </ul>
    </div>
  );
}

/** What a cited source is, in words (never the code "m:2tdmcj"). */
const REF_KIND: Record<string, string> = { m: 'Herinnering', d: 'Dossier', b: 'Besluit', a: 'Actie', g: 'Gebeurtenis', p: 'Persoon', e: 'Gesprek', s: 'Bron' };

function UsageBlock({ u }: { u: any }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted">
        {u.agent_name} · {u.via === 'tool' ? 'zelf opgezocht' : t('automatisch meegestuurd (≈{0, plural, one {# token} other {# tokens}})', u.tokens)} · {timeAgo(u.created_at)}
      </div>
      <ul className="space-y-1">
        {u.refs.map((r: any, i: number) => (
          <li key={i} className="flex gap-1.5">
            <span className="shrink-0 text-xs text-muted">{REF_KIND[r.p] || 'Bron'}</span>
            {r.kind === 'item' && r.status !== 'forgotten' ? (
              <a className="min-w-0 break-words hover:underline" href={memPath(`item/${r.id}`)}>
                {r.label}
              </a>
            ) : r.kind === 'dossier' || r.dossier_id ? (
              <a className="min-w-0 break-words hover:underline" href={memPath(`dossiers/${r.kind === 'dossier' ? r.id : r.dossier_id}`)}>
                {r.label}
              </a>
            ) : r.kind === 'episode' ? (
              <a className="min-w-0 break-words hover:underline" href={`#/t/${r.thread_id}`}>
                {r.label}
              </a>
            ) : (
              <span className={cx('min-w-0 break-words', r.status === 'forgotten' && 'text-muted')}>{r.label}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ bot editor section

export function MemoryAgentSection({ agent, onChange }: { agent: Agent; onChange(p: Partial<Agent>): void }) {
  const m = (agent.settings?.memory || {}) as any;
  const set = (p: any) => onChange({ settings: { ...(agent.settings || {}), memory: { ...m, ...p } } });
  const stats = useMem<any[]>(agent.id ? '/memory/agents' : null, [agent.id]);
  const s = stats.data?.find((x) => x.id === agent.id);
  const enabled = (agent.tool_groups || []).includes('memory');
  return (
    <div className="space-y-3">
      {!enabled && <p className="rounded-lg bg-warn-soft p-2 text-sm text-warn">De toolgroep “Geheugen” staat uit voor deze bot: hij gebruikt en leert dan niets. Zet hem aan bij Tools.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Leren" hint="“Standaard” volgt Geheugen › Opslag.">
          <Select value={m.learn || 'inherit'} onChange={(e) => set({ learn: e.target.value })}>
            <option value="inherit">Standaard</option>
            <option value="auto">Automatisch leren</option>
            <option value="explicit">Alleen op verzoek (“onthoud dit”)</option>
            <option value="off">Uit</option>
          </Select>
        </Field>
        <Field label="Eigen notities van de bot">
          <Select value={m.botWrites || 'inherit'} onChange={(e) => set({ botWrites: e.target.value })}>
            <option value="inherit">Standaard</option>
            <option value="direct">Direct opslaan (met ongedaan maken)</option>
            <option value="propose">Eerst als voorstel</option>
          </Select>
        </Field>
        <Field label="Geheugen per beurt (tokens)" hint="Leeg = standaard. 0 = niets automatisch; de bot zoekt zelf.">
          <Input type="number" min={0} max={8000} value={m.budgetTokens ?? ''} onChange={(e) => set({ budgetTokens: e.target.value === '' ? null : Number(e.target.value) })} placeholder="standaard" />
        </Field>
        <Field label="Altijd-geladen profiel (tokens)" hint="Bovengrens voor vastgezette herinneringen (standaard ±4000).">
          <Input type="number" min={0} max={16000} value={m.profileCap ?? ''} onChange={(e) => set({ profileCap: e.target.value === '' ? null : Number(e.target.value) })} placeholder="standaard" />
        </Field>
      </div>
      <Toggle checked={m.readShared !== false} onChange={(v) => set({ readShared: v })} label="Gedeeld geheugen en gedeelde dossiers lezen" />
      <Toggle checked={m.readAboutYou !== false} onChange={(v) => set({ readAboutYou: v })} label="Wat over jou bekend is gebruiken (alleen in gesprekken zonder anderen)" />
      {s && (
        <p className="text-xs text-muted">
          {t('{0, plural, one {# eigen notitie} other {# eigen notities}} · vastgezet ≈{1, plural, one {# token} other {# tokens}}', s.items, s.profileTokens)} ·{' '}
          <a className="text-accent hover:underline" href={memPath(`bots/${agent.id}`)}>
            Geheugen van deze bot bekijken
          </a>
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ message extras: citations + capture receipts

const REF_RE = /\[(m|d|b|a|g|p|e|s):([a-z0-9]{4,12})\]/g;
const INTENT_RE = /\b(onthoud|onthou|noteer|vergeet niet|remember|leg vast|sla op)\b/i;
/** A short yes ("Ja, doe maar") may have answered the bot's memory proposal: its outcome shows under it too. */
const YES_RE = /^\s*(ja|jawel|jazeker|yes|yep|sure|ok|oké|oke|okay|prima|klopt|graag|doe maar|akkoord|👍)\b/i;
const cache = new Map<string, Promise<any>>();
/** Answers that already asked again for their thread's sources (so a newer answer never loops). */
const refreshed = new Set<string>();
let wired = false;
function wireCache() {
  if (wired) return;
  wired = true;
  on('memory.updated', () => cache.clear());
}
function cached(path: string) {
  wireCache();
  let p = cache.get(path);
  if (!p) {
    p = api.get(path).catch(() => null);
    cache.set(path, p);
  }
  return p;
}

export function MemoryMessageExtra({ message }: { message: Message }) {
  const me = useApp((s) => s.me);
  const refs = useMemo(() => {
    if (message.role !== 'assistant' || message.status === 'streaming' || !message.content) return [];
    const out = new Set<string>();
    for (const m of message.content.matchAll(REF_RE)) out.add(`${m[1]}:${m[2]}`);
    return [...out].slice(0, 20);
  }, [message.role, message.status, message.content]);
  const own = message.role === 'user' && message.author_type === 'user' && message.author_id === me?.id;
  // A finished answer of a bot: what the learner found in its work sits under it (0.4.5).
  const botDone = message.role === 'assistant' && message.author_type === 'agent' && message.status === 'done' && !!message.content?.trim();
  const capture = own && (INTENT_RE.test(message.content || '') || ((message.content || '').length <= 80 && YES_RE.test(message.content || '')));
  const [cites, setCites] = useState<any[] | null>(null);
  const [cap, setCap] = useState<any>(null);
  const [learned, setLearned] = useState<any[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => on('memory.updated', () => setTick((t) => t + 1)), []);
  // An answer without citation codes (a small local model never writes them): the memories it clearly used (A-42).
  const implied = !refs.length && message.role === 'assistant' && message.status === 'done' && !!message.content?.trim();
  useEffect(() => {
    let alive = true;
    let t: any = null;
    if (refs.length) cached(`/memory/refs?refs=${refs.join(',')}`).then((r) => alive && setCites(r));
    else if (implied) {
      const path = `/memory/thread/${message.thread_id}/answer-sources`;
      const key = `${message.thread_id}:${message.id}`;
      const p = cached(path);
      p.then((r) => {
        if (!alive || !r) return;
        // Asked before this answer was there: ask once more (one request per thread, shared by its answers).
        if (message.seq > (r.upto ?? 0) && !refreshed.has(key)) {
          refreshed.add(key);
          if (cache.get(path) === p) cache.delete(path);
          cached(path).then((r2) => alive && setCites(r2?.byMessage?.[message.id] || null));
          return;
        }
        setCites(r.byMessage?.[message.id] || null);
      });
    }
    // What was learned from this message (explicitly or after the conversation went quiet), and (0.4.5) from the bot's
    // own work in this answer (what it found with a tool): one request per thread.
    if (own || botDone) cached(`/memory/thread/${message.thread_id}/learned-map`).then((r) => alive && setLearned(r?.byMessage?.[message.id] || []));
    if (capture) {
      const load = () => cached(`/memory/message/${message.id}`).then((r) => alive && setCap(r));
      load();
      t = setTimeout(() => (cache.delete(`/memory/message/${message.id}`), load()), 1500);
    }
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [refs.join(','), own, botDone, capture, implied, message.id, message.thread_id, tick]);
  const { run, busy } = useAsync();
  const items = (learned || []).filter((i: any) => i.status !== 'trashed');
  // One or two facts show as they are; more than that is one quiet line that opens on a tap. Ten found facts used to fill the whole screen (owner, 0.4.4).
  const toReview = items.filter((i: any) => i.status === 'proposed').length;
  const learnedLines = items.length ? (
    <details className="group mt-1 text-xs" open={items.length <= 2}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <Brain className="h-3 w-3" aria-hidden />
        {items.length - toReview > 0 && t('{0, plural, one {# ding onthouden} other {# dingen onthouden}}', items.length - toReview)}
        {items.length - toReview > 0 && toReview > 0 && ' · '}
        {toReview > 0 && <span className="text-warn">{t('{0, plural, one {# voorstel om te beoordelen} other {# voorstellen om te beoordelen}}', toReview)}</span>}
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-1 space-y-1">
      {items.map((i: any) => (
        <div key={i.id} className={cx('flex flex-wrap items-center gap-1.5 rounded-lg px-2 py-1', i.status === 'superseded' ? 'bg-surface-2 text-muted' : 'bg-accent-soft text-accent')}>
          <Brain className="h-3 w-3" aria-hidden />
          <span className="min-w-0 flex-1">
            {i.learned_from === 'tool' ? <span className="opacity-80">Gevonden met een tool · </span> : i.learned_from === 'bot' ? <span className="opacity-80">Uit dit antwoord · </span> : null}
            {i.status === 'proposed' ? (i.conflict ? 'Botst met wat er al staat — eerst beoordelen' : 'Voorstel') : i.status === 'superseded' ? 'Inmiddels vervangen' : i.replaced ? 'Bijgewerkt' : 'Onthouden'} ({SCOPE_LABEL[i.scope]}): {i.content}
            {i.replaced && i.status !== 'superseded' && <span className="opacity-80"> (was: {i.replaced.content})</span>}
            {i.status === 'proposed' && i.conflict && <span className="opacity-80"> (nu bewaard: {i.conflict.content})</span>}
          </span>
          <a className="underline" href={memPath(i.status === 'proposed' ? 'beoordelen' : `item/${i.id}`)}>
            {i.status === 'proposed' ? 'Beoordelen' : 'Bekijken'}
          </a>
          {i.changeId && ['active', 'proposed'].includes(i.status) && (
            <button
              className="inline-flex items-center gap-0.5 underline"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.post(`/memory/changes/${i.changeId}/undo`, {});
                  cache.clear();
                  setTick((t) => t + 1);
                }, i.replaced ? 'Teruggezet naar de vorige versie' : 'Ongedaan gemaakt')
              }
            >
              <Undo2 className="h-3 w-3" /> Ongedaan maken
            </button>
          )}
        </div>
      ))}
      </div>
    </details>
  ) : null;
  if (cites?.length) {
    return (
      <>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="inline-flex items-center gap-1 text-muted">
            <Brain className="h-3 w-3" /> Bronnen:
          </span>
          {cites.map((c) => (
            <a
              key={`${c.p}:${c.ref}`}
              href={c.status === 'forgotten' ? undefined : c.kind === 'item' ? memPath(`item/${c.id}`) : c.kind === 'episode' ? `#/t/${c.thread_id}` : memPath(`dossiers/${c.kind === 'dossier' ? c.id : c.dossier_id}`)}
              className={cx('max-w-[260px] truncate rounded-md border border-line px-1.5 py-0.5', c.status === 'forgotten' ? 'text-muted line-through' : 'hover:bg-surface-2')}
              title={c.label}
            >
              {c.label}
            </a>
          ))}
        </div>
        {learnedLines}
      </>
    );
  }
  if (learnedLines) return learnedLines;
  // ("unclear" is a note for the bot only: it asks what to remember.)
  const outcomes = (cap?.outcomes || []).filter((o: any) => o.action !== 'unclear');
  if (capture && outcomes.length) {
    return (
      <div className="mt-1 space-y-1 text-xs">
        {outcomes.map((o: any, k: number) => (
          <div key={k} className="rounded-lg bg-surface-2 px-2 py-1 text-muted">
            <Brain className="me-1 inline h-3 w-3" />
            {/* "Stond al in het geheugen [m:xk5un3]." — the code is for the bot; the owner reads the sentence. */}
            {stripRefs(String(o.message || '').replace(/\s*\(vervangt \[m:[a-z0-9]+\]\)/i, ''))}
          </div>
        ))}
      </div>
    );
  }
  return null;
}

// ------------------------------------------------------------------ tool card details for write tools

export function MemoryToolCard({ call }: { call: ToolCall; message: Message }) {
  const [d, setD] = useState<any>(null);
  const [tick, setTick] = useState(0);
  const { run, busy } = useAsync();
  useEffect(() => on('memory.updated', () => setTick((t) => t + 1)), []);
  useEffect(() => {
    if (call.status !== 'done' && call.status !== 'error') return;
    let alive = true;
    api
      .get(`/memory/by-call/${encodeURIComponent(call.id)}`)
      .then((r) => alive && setD(r))
      .catch(() => alive && setD(null));
    return () => {
      alive = false;
    };
  }, [call.id, call.status, tick]);
  if (call.name === 'memory_forget') return <p className="text-xs text-muted">Vergeten is definitief en kan niet ongedaan worden gemaakt. Zie Geheugen › Geschiedenis voor de bon.</p>;
  if (!d || (!d.items.length && !d.records.length)) return null;
  return (
    <div className="space-y-1 text-xs">
      {[...d.items.map((i: any) => ({ ...i, label: i.content, kind: 'item' })), ...d.records.map((r: any) => ({ ...r, label: r.title }))].map((x: any) => (
        <div key={x.id} className="flex flex-wrap items-center gap-1.5">
          <Badge tone={x.status === 'proposed' ? 'warn' : x.status === 'trashed' ? 'neutral' : 'ok'}>
            {x.status === 'proposed' ? `Voorstel${x.proposal_reason ? ` · ${REASON_LABEL[x.proposal_reason] || x.proposal_reason}` : ''}` : x.status === 'trashed' ? 'Ongedaan' : 'Opgeslagen'}
          </Badge>
          <span className="min-w-0 flex-1 truncate">{x.label}</span>
          <a className="inline-flex items-center gap-0.5 text-accent hover:underline" href={x.kind === 'item' ? memPath(x.status === 'proposed' ? 'beoordelen' : `item/${x.id}`) : memPath(`dossiers/${x.dossier_id}`)}>
            {x.status === 'proposed' ? <Check className="h-3 w-3" /> : <ExternalLink className="h-3 w-3" />}
            {x.status === 'proposed' ? 'Beoordelen' : 'Bekijken'}
          </a>
          {x.changeId && x.status !== 'trashed' && (
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" loading={busy} onClick={() => run(async () => (await api.post(`/memory/changes/${x.changeId}/undo`, {}), setTick((t) => t + 1)), 'Ongedaan gemaakt')}>
              <Undo2 className="h-3 w-3" /> Ongedaan maken
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
