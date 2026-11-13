import React, { useEffect, useState } from 'react';
import { AlertTriangle, Archive, Bot, ClipboardCheck, Clock, ExternalLink, History, Lock, MessageSquare, Pencil, Pin, PinOff, RotateCcw, Search, Share2, SlidersHorizontal, Trash2, Undo2, User } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { stripRefs } from '../../lib/preview';
import { useApp } from '../../lib/store';
import { t } from '../../lib/i18n';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Textarea, Toggle, cx, timeAgo, toast, toastError, useAsync } from '../../components/ui';
import { Menu, SkeletonRows } from '../../components/overview';
import {
  ALL_TEAMS,
  type Change,
  type MemItem,
  type Scope,
  confLabel,
  defaultTeamFor,
  useMemTeams,
  useTeamFilter,
  fmtDate,
  fromDateInput,
  memPath,
  REVIEW_OPTIONS,
  reviewLabel,
  reviewWhen,
  OP_LABEL,
  REASON_LABEL,
  SCOPE_LABEL,
  SENS_LABEL,
  SOURCE_LABEL,
  STATUS_LABEL,
  toDateInput,
  TYPE_LABEL,
  useMem,
  wordDiff,
} from './lib';

/** While a list loads: grey rows in the size of the real ones, so the page does not jump. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return <SkeletonRows n={rows} avatar={false} />;
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <Card className="flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
      {retry && (
        <Button size="sm" onClick={retry}>
          Opnieuw
        </Button>
      )}
    </Card>
  );
}

/** A quota meter (red and "Vol" at the limit), or with `progress` a progress bar (100% = done, never a warning). */
export function Meter({ value, max, label, hint, progress }: { value: number; max: number; label: React.ReactNode; hint?: React.ReactNode; progress?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tone = progress ? (pct >= 100 ? 'bg-ok' : 'bg-accent') : pct >= 100 ? 'bg-danger' : pct >= 90 ? 'bg-warn' : 'bg-accent';
  // Full in words too, not only a red bar (acceptance A-46: what does the page say at the limit?).
  const full = !progress && max > 0 && value >= max;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 text-xs text-muted">
          {full && <span className="me-1.5 font-semibold text-danger">Vol</span>}
          {hint ?? `${value} / ${max}`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={typeof label === 'string' ? label : undefined}>
        <div className={cx('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
      {full && <p className="text-xs text-danger">Hier wordt niets nieuws meer onthouden. Ruim op of voeg samen om weer ruimte te maken.</p>}
    </div>
  );
}

export function DiffView({ before, after }: { before: string | null; after: string | null }) {
  if (before === null && after === null) return <p className="text-xs text-muted">(inhoud niet beschikbaar)</p>;
  if (before === null) return <p className="whitespace-pre-wrap text-sm"><ins className="bg-ok-soft text-ok no-underline">{after}</ins></p>;
  if (after === null || before === after) return <p className="whitespace-pre-wrap text-sm">{after ?? before}</p>;
  return (
    <p className="whitespace-pre-wrap text-sm" aria-label="Verschil">
      {wordDiff(before, after).map((p, i) =>
        p.t === 'same' ? (
          <span key={i}>{p.s}</span>
        ) : p.t === 'add' ? (
          <ins key={i} className="rounded bg-ok-soft text-ok no-underline">
            {p.s}
          </ins>
        ) : (
          <del key={i} className="rounded bg-danger-soft text-danger">
            {p.s}
          </del>
        ),
      )}
    </p>
  );
}

/** Where a memory lives, in words: about you, the bot it belongs to, the dossier, or shared. */
const scopeLabel = (item: Pick<MemItem, 'scope' | 'agent_name' | 'dossier_title'>) => (item.scope === 'agent' ? item.agent_name || 'Bot' : item.scope === 'dossier' ? item.dossier_title || 'Dossier' : SCOPE_LABEL[item.scope]);

/** The team of an item or dossier (the server only sends it with two or more teams). */
export function TeamBadge({ team }: { team?: { id: string; name: string } | null }) {
  if (!team) return null;
  return <Badge tone={team.id === ALL_TEAMS ? 'accent' : 'neutral'}>{team.id === ALL_TEAMS ? 'Alle teams' : t('Team {0}', team.name)}</Badge>;
}

export function SourceLine({ item }: { item: MemItem }) {
  const src = SOURCE_LABEL[item.source_kind] || item.source_kind;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {item.source_kind === 'message' && item.source_thread_id ? (
        <a className="inline-flex items-center gap-1 text-accent hover:underline" href={`#/t/${item.source_thread_id}`}>
          <MessageSquare className="h-3 w-3" />
          {item.source_thread_title ? `“${item.source_thread_title.slice(0, 40)}”` : src}
        </a>
      ) : item.source_kind === 'url' && item.source_ref ? (
        <a className="inline-flex items-center gap-1 text-accent hover:underline" href={item.source_ref} target="_blank" rel="noreferrer noopener">
          <ExternalLink className="h-3 w-3" />
          {src}
        </a>
      ) : (
        <span>{src}</span>
      )}
      {item.created_by === 'agent' && item.created_by_agent && <span>· via {useApp.getState().agents.find((a) => a.id === item.created_by_agent)?.name || 'bot'}</span>}
      {/* Learned from the bot's own work (0.4.5): say so, the owner's own words weigh more. */}
      {item.learned_from === 'tool' ? <Badge>Gevonden met een tool</Badge> : item.learned_from === 'bot' ? <Badge>Uit een antwoord van de bot</Badge> : null}
    </span>
  );
}

const ACTIONS: Record<string, string> = { pin: 'Vastgezet', unpin: 'Losgemaakt', archive: 'Gearchiveerd', trash: 'Naar prullenbak verplaatst', restore: 'Teruggezet', confirm: 'Bevestigd' };

/** `hideScope`: the list is already about one place (Over jou, one bot, Gedeeld, a dossier), so a card does not repeat it. */
export function ItemCard({ item, onChanged, compact, hideScope }: { item: MemItem; onChanged?(): void; compact?: boolean; hideScope?: boolean }) {
  const [edit, setEdit] = useState(false);
  const [forget, setForget] = useState(false);
  const [detail, setDetail] = useState(false);
  const { run } = useAsync();
  const act = (a: string) =>
    run(async () => {
      await api.post(`/memory/items/${item.id}/${a}`, {});
      onChanged?.();
    }, ACTIONS[a]);
  // With two or more teams, sharing a bot's note shares it in that bot's team (the editor can pick another team).
  const multi = useMemTeams().multi;
  const share = () =>
    run(async () => {
      await api.patch(`/memory/items/${item.id}`, { scope: 'shared' });
      onChanged?.();
    }, multi ? 'Gedeeld met de bots van het team' : 'Gedeeld met al je bots');
  const readOnly = ['forgotten', 'rejected'].includes(item.status);
  // A lesson for the whole team (from a correction of one bot) can be narrowed to that one bot.
  const lessonBot = item.type === 'lesson' && item.scope === 'shared' && item.created_by_agent ? item.created_by_agent : null;
  const lessonBotName = useApp((st) => st.agents.find((a) => a.id === lessonBot)?.name) || 'deze bot';
  const narrow = () =>
    run(async () => {
      await api.patch(`/memory/items/${item.id}`, { scope: 'agent', agentId: lessonBot });
      onChanged?.();
    }, t('Geldt nu alleen voor {0}', lessonBotName));
  return (
    <Card className={cx('tb-in relative px-4 py-3', item.status !== 'active' && 'opacity-90')}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* What it says comes first; one quiet line says what kind it is, where it lives and where it came from. */}
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.content ? <span translate="no">{item.content}</span> : <span className="text-muted">(inhoud gewist)</span>}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span>{TYPE_LABEL[item.type] || item.type}</span>
            {!hideScope && <span>· {scopeLabel(item)}</span>}
            {item.scope !== 'dossier' && item.team && <span>· {item.team.id === ALL_TEAMS ? 'Alle teams' : t('Team {0}', item.team.name)}</span>}
            {!compact && (
              <>
                <span aria-hidden>·</span>
                <SourceLine item={item} />
                <span>· {fmtDate(item.observed_at || item.created_at)}</span>
              </>
            )}
            {item.status !== 'active' && <Badge tone={item.status === 'proposed' ? 'warn' : 'neutral'}>{STATUS_LABEL[item.status]}</Badge>}
            {item.pinned && (
              // A pinned instruction is a standing rule: every bot always follows it, also after a summary.
              <Badge tone="accent">
                <Pin className="h-3 w-3" /> {item.type === 'instruction' && item.status === 'active' && !item.flags?.includes('external') ? 'Vaste regel' : 'Vast'}
              </Badge>
            )}
            {item.sensitivity !== 'normal' && (
              <Badge tone={item.sensitivity === 'sensitive' ? 'danger' : 'neutral'}>
                {item.sensitivity === 'sensitive' && <Lock className="h-3 w-3" />}
                {SENS_LABEL[item.sensitivity]}
              </Badge>
            )}
            {item.flags?.includes('external') && <Badge tone="warn">Externe bron</Badge>}
            {item.proposal_reason && item.status === 'proposed' && <Badge tone="warn">{REASON_LABEL[item.proposal_reason] || item.proposal_reason}</Badge>}
            {item.status === 'active' && item.flags?.includes('check') && <Badge tone="warn">Te controleren</Badge>}
            {item.type === 'lesson' && item.scope === 'shared' && <Badge>{multi ? 'Les voor het team' : 'Les voor alle bots'}</Badge>}
            {!compact && item.expires_at && (
              <span className="inline-flex items-center gap-1">
                · <Clock className="h-3 w-3" aria-hidden /> tot {fmtDate(item.expires_at)}
              </span>
            )}
            {!compact && item.status === 'active' && item.review_at && Date.parse(item.review_at) <= Date.now() && (
              <span className="inline-flex items-center gap-1 font-semibold text-warn">
                · <ClipboardCheck className="h-3 w-3" aria-hidden /> nu nakijken
              </span>
            )}
          </div>
        </div>
        {!readOnly && (
          <Menu
            label="Acties"
            className="-me-2 -mt-1"
            items={[
              { label: 'Details en geschiedenis', icon: <History />, onSelect: () => setDetail(true) },
              ['active', 'proposed', 'archived'].includes(item.status) && { label: 'Bewerken', icon: <Pencil />, onSelect: () => setEdit(true) },
              item.status === 'active' && { label: item.pinned ? 'Losmaken' : 'Vastzetten (altijd laden)', icon: item.pinned ? <PinOff /> : <Pin />, onSelect: () => void act(item.pinned ? 'unpin' : 'pin') },
              item.status === 'active' && item.scope !== 'shared' && item.scope !== 'dossier' && { label: multi ? 'Delen met de bots van het team' : 'Delen met alle bots', icon: <Share2 />, onSelect: () => void share() },
              item.status === 'active' && !!lessonBot && { label: t('Alleen voor {0}', lessonBotName), icon: <User />, onSelect: () => void narrow() },
              item.status === 'active' && { label: 'Archiveren', icon: <Archive />, onSelect: () => void act('archive') },
              ['archived', 'trashed'].includes(item.status) && { label: 'Terugzetten', icon: <RotateCcw />, onSelect: () => void act('restore') },
              item.status !== 'trashed' && { label: 'Naar prullenbak', icon: <Trash2 />, onSelect: () => void act('trash') },
              'sep',
              { label: 'Definitief vergeten…', icon: <AlertTriangle />, danger: true, onSelect: () => setForget(true) },
            ]}
          />
        )}
      </div>
      {edit && <ItemEditor item={item} onClose={() => setEdit(false)} onSaved={() => (setEdit(false), onChanged?.())} />}
      {forget && <ForgetDialog item={item} onClose={() => setForget(false)} onDone={() => (setForget(false), onChanged?.())} />}
      {detail && <ItemDetailModal id={item.id} onClose={() => setDetail(false)} />}
    </Card>
  );
}


/** Create or edit a memory item. Shows the forget-block explicitly instead of silently failing. */
export function ItemEditor({ item, defaults, onClose, onSaved }: { item?: MemItem; defaults?: Partial<{ scope: Scope; agentId: string; dossierId: string; threadId: string; teamId: string }>; onClose(): void; onSaved(out?: any): void }) {
  const agents = useApp((s) => s.agents);
  const dossiers = useMem<any[]>('/memory/dossiers?status=active');
  const teams = useMemTeams();
  const [filter] = useTeamFilter();
  // Shared knowledge belongs to a team (or to all teams); one team = no choice.
  const [teamId, setTeamId] = useState(item?.team?.id || defaults?.teamId || '');
  const team = teamId || defaultTeamFor(filter, teams);
  const [content, setContent] = useState(item?.content || '');
  const [scope, setScope] = useState<Scope>(item?.scope || defaults?.scope || 'about_you');
  const [agentId, setAgentId] = useState(item?.agent_id || defaults?.agentId || agents[0]?.id || '');
  const [dossierId, setDossierId] = useState(item?.dossier_id || defaults?.dossierId || '');
  const [type, setType] = useState(item?.type || '');
  const [key, setKey] = useState(item?.canonical_key || '');
  const [sens, setSens] = useState(item?.sensitivity || '');
  const [expires, setExpires] = useState(toDateInput(item?.expires_at));
  // '' = automatic (the default for facts that can change), else days (0 = never).
  const [review, setReview] = useState<string>(item ? String(item.review_every_days || 0) : '');
  const [pinned, setPinned] = useState(!!item?.pinned);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { run, busy } = useAsync();
  const save = (liftBlock = false) =>
    run(async () => {
      setErr(null);
      const body: any = { content, type: type || undefined, key: key || null, sensitivity: sens || undefined, expires_at: fromDateInput(expires), pinned };
      if (review !== '' && (!item || Number(review) !== (item.review_every_days || 0))) body.review_every_days = Number(review);
      if (teams.multi && scope === 'shared' && team && (!item || item.scope !== 'shared' || item.team?.id !== team)) body.teamId = team;
      try {
        if (item) {
          if (item.status === 'proposed') {
            await api.post(`/memory/items/${item.id}/approve`, { ...body, scope, agentId, dossierId });
            toast('Aangepast en goedgekeurd', 'ok');
          } else {
            await api.patch(`/memory/items/${item.id}`, { ...body, scope, agentId: scope === 'agent' ? agentId : undefined, dossierId: scope === 'dossier' ? dossierId : undefined });
            toast('Opgeslagen', 'ok');
          }
          onSaved();
        } else {
          const out = await api.post('/memory/items', { ...body, scope, agentId: scope === 'agent' ? agentId : undefined, dossierId: scope === 'dossier' ? dossierId : undefined, threadId: defaults?.threadId, liftBlock });
          toast(out.action === 'duplicate' ? 'Stond er al in' : out.action === 'superseded' ? 'Bijgewerkt (oude versie bewaard)' : 'Onthouden', 'ok');
          onSaved(out);
        }
      } catch (e: any) {
        if (e instanceof ApiError && e.status === 409) setBlocked(e.message);
        else setErr(e?.message || String(e));
      }
    });
  return (
    <Modal
      open
      onClose={onClose}
      title={item ? (item.status === 'proposed' ? 'Voorstel aanpassen' : 'Herinnering bewerken') : 'Nieuwe herinnering'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={busy} disabled={!content.trim()} onClick={() => save()}>
            {item?.status === 'proposed' ? 'Opslaan en goedkeuren' : 'Opslaan'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Wat moet onthouden worden?" hint="Kort en op zichzelf begrijpelijk. Nooit wachtwoorden of codes.">
          <Textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} autoFocus maxLength={2000} aria-label="Inhoud" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Waar">
            <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="Plek">
              <option value="about_you">Over jou</option>
              <option value="agent">Eén bot</option>
              <option value="shared">{teams.multi ? 'Gedeeld met de bots van een team' : 'Gedeeld met al je bots'}</option>
              <option value="dossier">Dossier</option>
            </Select>
          </Field>
          {scope === 'shared' && teams.multi && (
            <Field label="Team" hint="De bots van dit team lezen het, en bots die mogen meekijken ook.">
              <Select value={team} onChange={(e) => setTeamId(e.target.value)} aria-label="Team">
                {teams.teams.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
                <option value={ALL_TEAMS}>Alle teams</option>
              </Select>
            </Field>
          )}
          {scope === 'agent' && (
            <Field label="Bot">
              <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Bot">
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {scope === 'dossier' && (
            <Field label="Dossier">
              <Select value={dossierId} onChange={(e) => setDossierId(e.target.value)} aria-label="Dossier">
                <option value="">Kies…</option>
                {(dossiers.data || []).filter((d) => d.role !== 'read').map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Soort">
            <Select value={type} onChange={(e) => setType(e.target.value as any)} aria-label="Soort">
              <option value="">Automatisch</option>
              {Object.entries(TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Gevoeligheid" hint="Gevoelig wordt versleuteld opgeslagen en niet automatisch geladen.">
            <Select value={sens} onChange={(e) => setSens(e.target.value as any)} aria-label="Gevoeligheid">
              <option value="">Automatisch</option>
              <option value="normal">Normaal</option>
              <option value="personal">Persoonlijk</option>
              <option value="sensitive">Gevoelig</option>
            </Select>
          </Field>
          <Field label="Sleutel (optioneel)" hint="Bijv. woonplaats — een nieuwe waarde vervangt dan de oude.">
            <Input value={key} onChange={(e) => setKey(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Verloopt op (optioneel)">
            <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          {item?.status !== 'proposed' && (
            <Field label="Nakijken" hint="Komt terug bij Te beoordelen als “Klopt dit nog?”.">
              <Select value={review} onChange={(e) => setReview(e.target.value)} aria-label="Nakijken">
                {!item && <option value="">Automatisch (standaard)</option>}
                {REVIEW_OPTIONS.map((o) => (
                  <option key={o.days} value={String(o.days)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Toggle checked={pinned} onChange={setPinned} label="Vastzetten: elke beurt meesturen (telt mee in het profielbudget)" />
        {err && <ErrorBox error={err} />}
        {blocked && (
          <Card className="space-y-2 border-warn/40 bg-warn-soft p-3 text-sm">
            <p className="text-warn">{blocked}</p>
            <Button size="sm" variant="secondary" onClick={() => save(true)} loading={busy}>
              Blokkade opheffen en toch opslaan
            </Button>
          </Card>
        )}
      </div>
    </Modal>
  );
}

/** Hard forget with an honest explanation and a receipt. */
export function ForgetDialog({ item, title, endpoint, onClose, onDone }: { item?: MemItem; title?: React.ReactNode; endpoint?: string; onClose(): void; onDone(): void }) {
  const [alsoSource, setAlsoSource] = useState(true);
  const [receipt, setReceipt] = useState<any>(null);
  const { run, busy } = useAsync();
  const go = () =>
    run(async () => {
      const r = await api.post(endpoint || `/memory/items/${item!.id}/forget`, { alsoSource });
      setReceipt(r);
    });
  return (
    <Modal
      open
      onClose={receipt ? onDone : onClose}
      title={receipt ? 'Vergeten' : 'Definitief vergeten?'}
      footer={
        receipt ? (
          <Button variant="primary" onClick={onDone}>
            Klaar
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Annuleren
            </Button>
            <Button variant="danger" loading={busy} onClick={go}>
              Definitief vergeten
            </Button>
          </>
        )
      }
    >
      {receipt ? (
        <div className="space-y-2 text-sm">
          <p>
            Bon <span className="font-mono">{receipt.id}</span>:{' '}
            {t('{0, plural, one {# record gewist} other {# records gewist}}, {1, plural, one {# bericht opgeschoond} other {# berichten opgeschoond}}, {2, plural, one {# blokkade tegen opnieuw opslaan} other {# blokkades tegen opnieuw opslaan}}.', receipt.forgotten, receipt.scrubbed?.messages || 0, receipt.tombstones)}
          </p>
          <p className="text-muted">{receipt.note}</p>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          {/* What is forgotten: the memory as written, or TeamBot's words with its title in them (components/Words.tsx). */}
          <p className="rounded-lg bg-surface-2 p-2">{item ? <span translate="no">{item.content}</span> : title}</p>
          <ul className="list-disc space-y-1 ps-5 text-muted">
            <li>Alle versies, de zoekindex, gesprekssamenvattingen en kopieën in eerdere beurten worden gewist.</li>
            <li>Bots kunnen dit daarna niet opnieuw opslaan (blokkade). Opheffen kan later in Geschiedenis.</li>
            <li>Dit kan niet ongedaan worden gemaakt. Wil je het alleen opbergen? Kies dan Archiveren of Prullenbak.</li>
          </ul>
          {(!item || item.source_kind === 'message') && <Toggle checked={alsoSource} onChange={setAlsoSource} label="Ook het oorspronkelijke chatbericht en echo’s van bots verwijderen (aanbevolen)" />}
        </div>
      )}
    </Modal>
  );
}

export function ChangeRow({ c, onUndone, showLink }: { c: Change; onUndone?(): void; showLink?: boolean }) {
  const [open, setOpen] = useState(false);
  const { run, busy } = useAsync();
  const hasDiff = c.before_content !== null || c.after_content !== null;
  return (
    <div className="tb-in px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-[12rem] flex-1">
          <div className="break-words">{stripRefs(c.summary)}</div>
          <div className="mt-0.5 text-xs text-muted">
            {OP_LABEL[c.op] || c.op} ·{' '}
            {c.actor === 'agent' ? <Bot className="me-1 inline h-3 w-3" /> : null}
            <bdi translate="no">{c.actor_name}</bdi> · {timeAgo(c.created_at)}
            {/* A bot writes its own reason, with memory codes ("eigen kopie in [m:izs8b5]"): the owner reads it plain, as written. */}
            {c.reason ? <> · {REASON_LABEL[c.reason] || <span translate="no">{stripRefs(c.reason)}</span>}</> : ''}
            {c.undone_at ? ' · ongedaan gemaakt' : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {c.undoable && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Undo2 className="h-3.5 w-3.5" />}
              loading={busy}
              aria-label="Ongedaan maken"
              title="Ongedaan maken"
              className="text-muted"
              onClick={() =>
                run(async () => {
                  await api.post(`/memory/changes/${c.id}/undo`, {});
                  onUndone?.();
                }, 'Ongedaan gemaakt')
              }
            />
          )}
          {(hasDiff || (showLink && c.record_kind === 'item' && c.op !== 'forget' && !c.redacted)) && (
            <Menu
              label="Meer bij deze wijziging"
              size="iconSm"
              items={[
                hasDiff && { label: open ? 'Verschil verbergen' : 'Verschil tonen', onSelect: () => setOpen(!open) },
                showLink && c.record_kind === 'item' && c.op !== 'forget' && !c.redacted && { label: 'Herinnering bekijken', href: memPath(`item/${c.record_id}`) },
              ]}
            />
          )}
        </div>
      </div>
      {open && (
        <div className="tb-in mt-2 rounded-lg bg-surface-2 p-2">
          <DiffView before={c.before_content} after={c.after_content} />
          {c.before_status !== c.after_status && c.before_status && (
            <p className="mt-1 text-xs text-muted">
              Status: {STATUS_LABEL[c.before_status] || c.before_status} → {STATUS_LABEL[c.after_status || ''] || c.after_status}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function ItemDetail({ id, onChanged }: { id: string; onChanged?(): void }) {
  const r = useMem<any>(`/memory/items/${id}`);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} retry={r.reload} />;
  const d = r.data!;
  const it: MemItem = d.item;
  return (
    <div className="space-y-4">
      <ItemCard item={it} onChanged={() => (r.reload(), onChanged?.())} />
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
        <Def k="Bron">
          <SourceLine item={it} /> ({it.source_trust === 'user' ? 'van jou' : it.source_trust === 'external' ? 'externe bron' : it.source_trust === 'import' ? 'import' : 'bot'})
        </Def>
        <Def k="Waargenomen">{fmtDate(it.observed_at, true)}</Def>
        <Def k="Geldig">{it.valid_from ? `${fmtDate(it.valid_from)} – ${it.valid_to ? fmtDate(it.valid_to) : 'nu'}` : 'nog niet (voorstel)'}</Def>
        <Def k="Zekerheid">{Math.round((it.confidence || 0) * 100)}% ({confLabel(it.confidence)})</Def>
        <Def k="Laatst bevestigd">{fmtDate(it.last_confirmed_at) || '—'}</Def>
        <Def k="Nakijken">
          <ReviewPicker item={it} onChanged={() => (r.reload(), onChanged?.())} />
        </Def>
        <Def k="Gebruikt">{it.use_count}× {it.last_used_at ? `(laatst ${timeAgo(it.last_used_at)})` : ''}</Def>
        <Def k="Sleutel">{it.canonical_key || '—'}</Def>
      </dl>
      {d.source && (
        <Card className="p-3 text-sm">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Bronbericht</div>
          {d.source.deleted ? (
            <p className="text-muted">Het bronbericht is verwijderd.</p>
          ) : (
            <>
              <p className="whitespace-pre-wrap" translate="no">{d.source.excerpt}</p>
              <a className="mt-1 inline-block text-xs text-accent hover:underline" href={`#/t/${d.source.threadId}`}>
                Naar het gesprek ({d.source.author}, {fmtDate(d.source.at, true)})
              </a>
            </>
          )}
        </Card>
      )}
      {d.conflict && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Botst met</div>
          <ItemCard item={d.conflict} compact onChanged={r.reload} />
        </div>
      )}
      {(d.versions.length > 0 || d.next) && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Versies</div>
          <Card className="divide-y divide-line">
            {d.next && (
              <a className="block px-3 py-2 text-sm hover:bg-surface-2" href={memPath(`item/${d.next.id}`)}>
                Nieuwere versie: {d.next.content || '(vergeten)'}
              </a>
            )}
            {d.versions.map((v: any) => (
              <div key={v.id} className="px-3 py-2 text-sm">
                <span className="text-xs text-muted">
                  v{v.version} · {fmtDate(v.valid_from)} – {fmtDate(v.valid_to)} ·{' '}
                </span>
                {v.content || <span className="text-muted">(vergeten)</span>}
              </div>
            ))}
          </Card>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Geschiedenis</div>
        <Card className="divide-y divide-line">
          {d.changes.length === 0 ? <p className="p-3 text-sm text-muted">Geen wijzigingen.</p> : d.changes.map((c: Change) => <ChangeRow key={c.id} c={c} onUndone={r.reload} />)}
        </Card>
      </div>
      {d.usage.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Gebruikt in</div>
          <ul className="space-y-1 text-sm">
            {d.usage.map((u: any, i: number) => (
              <li key={i}>
                <a className="text-accent hover:underline" href={`#/t/${u.thread_id}`}>
                  Gesprek
                </a>{' '}
                <span className="text-xs text-muted">
                  ({u.via === 'tool' ? 'opgezocht door bot' : 'automatisch meegestuurd'}, {timeAgo(u.created_at)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "Nakijken: Elke 3 maanden · op 7 feb. 2027" with the interval as a choice (A-44). */
function ReviewPicker({ item, onChanged }: { item: MemItem; onChanged(): void }) {
  const { run, busy } = useAsync();
  const editable = item.status === 'active';
  const set = (days: number) =>
    run(async () => {
      await api.patch(`/memory/items/${item.id}`, { review_every_days: days });
      onChanged();
    }, days ? `Nakijken: ${reviewLabel(days).toLowerCase()}` : 'Wordt niet meer nagekeken');
  const when = reviewWhen(item.review_at);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {editable ? (
        <Select value={String(item.review_every_days || 0)} onChange={(e) => set(Number(e.target.value))} disabled={busy} aria-label="Hoe vaak nakijken" style={{ width: 'auto' }} className="h-8 py-0 text-sm coarse:h-11">
          {REVIEW_OPTIONS.map((o) => (
            <option key={o.days} value={String(o.days)}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <span>{reviewLabel(item.review_every_days)}</span>
      )}
      {when && <span className={cx('text-xs', when === 'nu' ? 'font-semibold text-warn' : 'text-muted')}>{when === 'nu' ? 'nu aan de beurt (Te beoordelen)' : t('nakijken op {0}', when)}</span>}
    </span>
  );
}

function Def({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-muted">{k}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

export function ItemDetailModal({ id, onClose }: { id: string; onClose(): void }) {
  return (
    <Modal open onClose={onClose} title="Herinnering" wide>
      <ItemDetail id={id} />
    </Modal>
  );
}

export interface ListFilter {
  scope?: string;
  agentId?: string;
  dossierId?: string;
  status?: string;
  type?: string;
  source?: string;
  from?: string;
  to?: string;
  q?: string;
  pinned?: string;
  threadId?: string;
}

/** Filterable list of memory items with an add button. */
export function ItemList({ base, empty, addDefaults, hideScope }: { base: ListFilter; empty: React.ReactNode; addDefaults?: any; hideScope?: boolean }) {
  const [f, setF] = useState<ListFilter>({ status: 'active' });
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [page, setPage] = useState(0);
  // The filters are rarely needed: one button opens them; it shows how many are set.
  const [filters, setFilters] = useState(false);
  const set = [f.status !== 'active', f.type, f.scope, f.source, f.from, f.to].filter(Boolean).length;
  useEffect(() => {
    const t = setTimeout(() => setF((x) => ({ ...x, q })), 300);
    return () => clearTimeout(t);
  }, [q]);
  const [team] = useTeamFilter();
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...f })) if (v) params.set(k, String(v));
  // The page's team filter ("Over jou" is personal, never part of a team; one dossier is in one team already).
  if (team && base.scope !== 'about_you' && !base.dossierId && !base.agentId) params.set('teamId', team);
  params.set('limit', '50');
  params.set('offset', String(page * 50));
  const r = useMem<{ items: MemItem[]; total: number }>(`/memory/items?${params}`);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input className="ps-9" placeholder="Zoeken…" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} aria-label="Zoeken" />
        </div>
        <Button variant={filters || set ? 'soft' : 'secondary'} icon={<SlidersHorizontal className="h-4 w-4" />} aria-expanded={filters} onClick={() => setFilters(!filters)}>
          Filters{set ? ` (${set})` : ''}
        </Button>
        {addDefaults && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            Toevoegen
          </Button>
        )}
      </div>
      {filters && (
      <div className="tb-in flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface p-3">
        <Select style={{ width: 'auto' }} value={f.status} onChange={(e) => (setF({ ...f, status: e.target.value }), setPage(0))} aria-label="Status">
          <option value="active">Actief</option>
          <option value="proposed">Voorstellen</option>
          <option value="archived">Gearchiveerd</option>
          <option value="superseded">Vervangen versies</option>
          <option value="trashed">Prullenbak</option>
          <option value="all">Alles</option>
        </Select>
        <Select style={{ width: 'auto' }} value={f.type || ''} onChange={(e) => (setF({ ...f, type: e.target.value }), setPage(0))} aria-label="Soort">
          <option value="">Alle soorten</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        {!hideScope && !base.scope && (
          <Select style={{ width: 'auto' }} value={f.scope || ''} onChange={(e) => (setF({ ...f, scope: e.target.value }), setPage(0))} aria-label="Plek">
            <option value="">Alle plekken</option>
            {Object.entries(SCOPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        )}
        <Select style={{ width: 'auto' }} value={f.source || ''} onChange={(e) => (setF({ ...f, source: e.target.value }), setPage(0))} aria-label="Bron">
          <option value="">Alle bronnen</option>
          {['message', 'user', 'tool', 'import', 'url', 'consolidation'].map((k) => (
            <option key={k} value={k}>
              {SOURCE_LABEL[k]}
            </option>
          ))}
        </Select>
        <Input type="date" style={{ width: 'auto' }} value={f.from || ''} onChange={(e) => (setF({ ...f, from: e.target.value }), setPage(0))} aria-label="Vanaf datum" />
        <Input type="date" style={{ width: 'auto' }} value={f.to || ''} onChange={(e) => (setF({ ...f, to: e.target.value }), setPage(0))} aria-label="Tot datum" />
        {set > 0 && (
          <Button size="sm" variant="ghost" onClick={() => (setF({ status: 'active', q: f.q }), setPage(0))}>
            Wissen
          </Button>
        )}
      </div>
      )}
      {r.error ? (
        <ErrorBox error={r.error} retry={r.reload} />
      ) : !r.data ? (
        <Loading />
      ) : r.data.items.length === 0 ? (
        <Card>{f.q || f.type || f.source || f.from || f.to || f.status !== 'active' ? <EmptyState title="Niets gevonden">Pas de filters aan.</EmptyState> : empty}</Card>
      ) : (
        <>
          <div className="space-y-2">
            {r.data.items.map((i) => (
              <ItemCard key={i.id} item={i} hideScope={!!base.scope} onChanged={r.reload} />
            ))}
          </div>
          {r.data.total > 50 && (
            <div className="flex justify-center gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Vorige
              </Button>
              <Button size="sm" disabled={(page + 1) * 50 >= r.data.total} onClick={() => setPage(page + 1)}>
                Volgende
              </Button>
            </div>
          )}
        </>
      )}
      {adding && <ItemEditor defaults={addDefaults} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), r.reload())} />}
    </div>
  );
}

