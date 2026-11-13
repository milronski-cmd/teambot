import { type ReactNode, useEffect, useState } from 'react';
import { AlertTriangle, BadgeCheck, CircleSlash, ExternalLink, FileText, Hand, Image as ImageIcon, Link2, MessageSquare, RotateCcw, Sparkles, Terminal, Unlock } from 'lucide-react';
import type { Message } from '../../lib/types';
import { api } from '../../lib/api';
import { Badge, Button, Spinner, Textarea, Toggle, cx, timeAgo, toast, toastError } from '../../components/ui';
import { t } from '../../lib/i18n';
import { MoreOptions } from '../../components/MoreOptions';
import { activeClaim } from './claim';
import { type OpenItem, type Suggestion, fetchQuality, loadInbox, qualityActions, useQualityInbox } from './api';
import type { CheckState, EvidenceItem, QualityView, TaskKind } from '../../../../shared/quality.js';

/**
 * Reusable pieces for "werk dat echt af is" (server: modules/quality). The task board (#/m/rooms/taken, later the
 * single board at #/tasks), the team database's task window and "Wacht op jou" all use these, so a task looks the same
 * everywhere: who works on it, when it is done ("klaar als"), the evidence and what the second look said.
 */

const TONE: Record<CheckState, 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'> = { none: 'neutral', passed: 'ok', review: 'warn', cant: 'danger', skipped: 'neutral', owner: 'ok' };
const LABEL: Record<CheckState, string> = { none: 'Nog niet afgemeld', passed: 'Gecontroleerd: klaar', review: 'Te controleren', cant: 'Kon niet', skipped: 'Klaar, zonder controle', owner: 'Goedgekeurd door jou' };

/** What the second look said, as one badge ("Te controleren", "Gecontroleerd: klaar", "Kon niet"). */
export function CheckBadge({ state, className }: { state: CheckState; className?: string }) {
  if (state === 'none') return null;
  const Icon = state === 'review' ? AlertTriangle : state === 'cant' ? CircleSlash : BadgeCheck;
  return (
    <Badge tone={TONE[state]} className={className}>
      <span className="inline-flex items-center gap-1">
        <Icon className="h-3 w-3" aria-hidden />
        {LABEL[state]}
      </span>
    </Badge>
  );
}

/** Which bot works on a task right now (its claim). */
export function ClaimBadge({ claim, className }: { claim: QualityView['claim']; className?: string }) {
  if (!claim) return null;
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1 text-xs text-muted', className)} title={t('Geclaimd {0}', timeAgo(claim.at))}>
      <Hand className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">
        <span className="font-semibold text-fg" translate="no">
          {claim.name}
        </span>{' '}
        werkt eraan
      </span>
    </span>
  );
}

const EV_ICON: Record<EvidenceItem['type'], typeof FileText> = { file: FileText, link: Link2, message: MessageSquare, attachment: FileText, screenshot: ImageIcon, output: Terminal, text: FileText };

/** The evidence a bot attached, each with what TeamBot saw itself (exists, not found, not opened). */
export function EvidenceList({ items }: { items: EvidenceItem[] }) {
  if (!items.length) return <p className="text-[13px] text-muted">Geen bewijs bijgevoegd.</p>;
  return (
    <ul className="space-y-1.5" aria-label="Bewijs">
      {items.map((e, i) => {
        const Icon = EV_ICON[e.type] || FileText;
        return (
          <li key={i} className="flex min-w-0 items-start gap-2 text-[13px]">
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              {e.type === 'link' ? (
                <a href={e.value} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 break-all font-medium text-accent underline underline-offset-2">
                  {e.value}
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                </a>
              ) : (
                <span className="block break-words font-medium [overflow-wrap:anywhere]" translate="no">
                  {e.value}
                </span>
              )}
              <span className={cx('block text-xs', e.ok === false ? 'text-danger' : e.ok === true ? 'text-ok' : 'text-muted')}>
                {e.ok === false ? '✗ ' : e.ok === true ? '✓ ' : ''}
                {e.note}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** "Klaar als": one short sentence; the owner can always change it (then a bot can no longer). */
export function DoneWhenField({ value, by, editable, onSave }: { value: string; by: 'agent' | 'user' | null; editable: boolean; onSave(v: string): Promise<any> }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(value), [value]);
  if (edit)
    return (
      <form
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave(v.trim());
            setEdit(false);
            toast('Klaar als opgeslagen', 'ok');
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Textarea rows={2} maxLength={300} value={v} onChange={(e) => setV(e.target.value)} aria-label="Klaar als" placeholder="Bijv.: er staat een offerte als PDF in de groepsmap" autoFocus />
        <div className="flex gap-2">
          <Button size="sm" variant="primary" loading={busy}>
            Opslaan
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => (setEdit(false), setV(value))}>
            Annuleren
          </Button>
        </div>
      </form>
    );
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-[13.5px]">
      {value ? <span className="min-w-0 break-words [overflow-wrap:anywhere]">{value}</span> : <span className="text-muted">Nog niet opgegeven</span>}
      {value && by && <span className="text-xs text-muted">{by === 'user' ? '(door jou)' : '(voorstel van de bot)'}</span>}
      {editable && (
        <button type="button" className="text-xs font-semibold text-muted underline underline-offset-2 hover:text-fg" onClick={() => setEdit(true)}>
          {value ? 'Aanpassen' : 'Toevoegen'}
        </button>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
      {children}
    </div>
  );
}

/**
 * Everything about whether a task is really done, for one task: "klaar als", who works on it, what the bot reported,
 * the evidence and the second look, plus the owner's actions (approve, send back, release, check off).
 * `q`: the record when the caller already has it (board tasks); otherwise it is fetched (team database tasks).
 */
export function TaskQuality({ kind, refId, q: given, editable = true, onChanged, compact }: { kind: TaskKind; refId: string; q?: QualityView | null; editable?: boolean; onChanged?(): void; compact?: boolean }) {
  const [own, setOwn] = useState<QualityView | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => {
    if (given === undefined) fetchQuality(kind, refId).then(setOwn).catch(() => setOwn(null));
  };
  useEffect(load, [kind, refId, given === undefined]);
  const q = given !== undefined ? given : own;
  if (given === undefined && !own) return <Spinner />;
  if (!q) return null;
  const changed = () => {
    load();
    loadInbox();
    onChanged?.();
  };
  const act = async (what: string, fn: () => Promise<any>, ok: string) => {
    setBusy(what);
    try {
      await fn();
      toast(ok, 'ok');
      changed();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const waits = q.check.state === 'review' || q.check.state === 'cant';
  return (
    <div className={cx('space-y-3', !compact && 'rounded-xl border border-line bg-surface p-3')}>
      <Row label="Klaar als">
        <DoneWhenField value={q.doneWhen} by={q.doneWhenBy} editable={editable} onSave={async (v) => (await qualityActions.setDoneWhen(kind, refId, v), changed())} />
      </Row>
      {(q.claim || q.reportedBy) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ClaimBadge claim={activeClaim(q)} />
          {q.claim && editable && kind === 'room' && (
            <Button size="sm" variant="ghost" icon={<Unlock className="h-3.5 w-3.5" />} loading={busy === 'release'} onClick={() => act('release', () => qualityActions.release(refId), 'Vrijgegeven: een andere bot kan hem nu oppakken')}>
              Vrijgeven
            </Button>
          )}
          {q.reportedBy && (
            <span className="text-xs text-muted">
              {t('Afgemeld door {0}, {1}', q.reportedBy.name, timeAgo(q.reportedBy.at))}
            </span>
          )}
        </div>
      )}
      {q.check.state !== 'none' && (
        <Row label="Controle">
          <div className="space-y-1">
            <CheckBadge state={q.check.state} />
            {q.check.reason && <p className="break-words text-[13.5px]">{q.check.reason}</p>}
            {q.check.engine && <p className="text-xs text-muted">{t('Tweede blik met {0}, zonder het gesprek', q.check.engine)}</p>}
          </div>
        </Row>
      )}
      {(q.evidence.length > 0 || q.check.state !== 'none') && q.outcome !== 'cant' && (
        <Row label="Bewijs">
          <EvidenceList items={q.evidence} />
        </Row>
      )}
      {editable && waits && (
        <div className="space-y-2 border-t border-line pt-3">
          {sending && <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Wat moet er nog gebeuren?" placeholder="Wat moet er nog gebeuren? (optioneel)" maxLength={2000} />}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<BadgeCheck className="h-3.5 w-3.5" />} loading={busy === 'approve'} disabled={!!busy} onClick={() => act('approve', () => qualityActions.approve(kind, refId), 'Goedgekeurd: de taak staat op klaar')}>
              Goedkeuren
            </Button>
            <Button
              size="sm"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              loading={busy === 'reopen'}
              disabled={!!busy}
              onClick={() => {
                if (!sending) return setSending(true);
                void act('reopen', async () => {
                  const r = await qualityActions.reopen(kind, refId, note);
                  setSending(false);
                  setNote('');
                  return r;
                }, 'Teruggestuurd naar de bot');
              }}
            >
              {sending ? 'Terugsturen' : 'Terugsturen naar de bot'}
            </Button>
          </div>
        </div>
      )}
      {/* Rarely needed: behind "Meer opties" (open when the check is off, so that stays visible). */}
      {editable && (
        <MoreOptions defaultOpen={q.skipCheck}>
          <Toggle
            checked={q.skipCheck}
            onChange={(v) => act('skip', () => qualityActions.setSkip(kind, refId, v), v ? 'Controle uit voor deze taak (bewijs blijft nodig)' : 'Controle weer aan')}
            label={<span className="text-[13px]">Controle overslaan (bewijs blijft nodig)</span>}
          />
        </MoreOptions>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Wacht op jou

function OpenTaskCard({ item }: { item: OpenItem }) {
  const href = item.kind === 'room' ? '#/m/rooms/taken' : '#/m/teamdata/taken';
  return (
    <div role="group" aria-label={t('Taak: {0}', item.title)} className="tb-ask w-full space-y-2 rounded-2xl border p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <CheckBadge state={item.check.state} />
        {item.reportedBy && <span>{t('{0} meldde hem af, {1}', item.reportedBy.name, timeAgo(item.reportedBy.at))}</span>}
        <a className="font-semibold underline underline-offset-2 hover:text-fg" href={href}>
          {item.kind === 'room' ? 'naar het takenbord' : 'naar de teamtaken'}
        </a>
      </div>
      <div className="break-words text-[15px] font-bold leading-snug" translate="no">
        {item.title || 'Taak'}
      </div>
      <TaskQuality kind={item.kind} refId={item.ref} q={item} compact />
    </div>
  );
}

function SuggestionCard({ s }: { s: Suggestion }) {
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (accept: boolean) => {
    setBusy(accept ? 'yes' : 'no');
    try {
      await api.post(`/quality/suggestions/${s.id}`, { decision: accept ? 'accept' : 'dismiss' });
      toast(accept ? t('{0} maakt een concept; je beoordeelt het in Mijn skills', s.agentName) : 'Voorstel weggelegd', accept ? 'ok' : 'neutral');
      loadInbox();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div role="group" aria-label={t('Skillvoorstel van {0}', s.agentName)} className="w-full space-y-2 rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        <span>{t('Voorstel, {0}', timeAgo(s.created_at))}</span>
      </div>
      <div className="break-words text-[15px] font-bold leading-snug">{t('Een vaste werkwijze (skill) voor “{0}”?', s.title)}</div>
      <p className="break-words text-[13.5px]">{s.body}</p>
      <p className="text-xs text-muted">Er wordt niets vanzelf geïnstalleerd: de bot maakt een concept, jij beoordeelt het.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" loading={busy === 'yes'} disabled={!!busy || !s.canDraft} onClick={() => decide(true)}>
          {t('Ja, laat {0} een concept maken', s.agentName)}
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'no'} disabled={!!busy} onClick={() => decide(false)}>
          Nee, bedankt
        </Button>
      </div>
      {!s.canDraft && <p className="text-xs text-warn">Deze bot kan nu geen skill voorstellen: zet bij de bot Skills aan.</p>}
    </div>
  );
}

/** Section in "Wacht op jou": tasks to check (te controleren, kon niet) and skill suggestions. */
export function ReviewInbox() {
  const tasks = useQualityInbox((s) => s.tasks);
  const sugg = useQualityInbox((s) => s.suggestions);
  if (!tasks.length && !sugg.length) return null;
  return (
    <section aria-labelledby="inbox-quality" className="space-y-3">
      {tasks.length > 0 && (
        <>
          <h2 id="inbox-quality" className="flex items-center gap-2 pt-2 text-[15px] font-bold tracking-tight">
            <AlertTriangle className="h-4 w-4 text-muted" aria-hidden /> Te controleren <span className="font-semibold tabular-nums text-muted">{tasks.length}</span>
          </h2>
          {tasks.map((x) => (
            <OpenTaskCard key={`${x.kind}:${x.ref}`} item={x} />
          ))}
        </>
      )}
      {sugg.length > 0 && (
        <>
          <h2 className="flex items-center gap-2 pt-2 text-[15px] font-bold tracking-tight">
            <Sparkles className="h-4 w-4 text-muted" aria-hidden /> Voorstellen voor skills <span className="font-semibold tabular-nums text-muted">{sugg.length}</span>
          </h2>
          {sugg.map((s) => (
            <SuggestionCard key={s.id} s={s} />
          ))}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- in the chat

/** The card when a bot stopped itself in a loop: what it kept doing, what it tried, and an ask for help. */
export function LoopStopEvent({ message }: { message: Message }) {
  const loop = (message.parts as any)?.loop || {};
  const tried: string[] = Array.isArray(loop.tried) ? loop.tried : [];
  return (
    <div className="px-4 py-2 sm:px-6">
      <div role="note" className="tb-ask mx-auto w-full max-w-xl space-y-2 rounded-2xl border p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <p className="min-w-0 break-words text-[14px] font-semibold leading-snug">{message.content}</p>
        </div>
        {tried.length > 0 && (
          <div className="ps-6">
            <div className="text-xs font-semibold text-muted">Wat de bot probeerde</div>
            <ul className="mt-1 list-disc space-y-0.5 ps-4 text-[13px]">
              {tried.map((s, i) => (
                <li key={i} className="break-words [overflow-wrap:anywhere]">
                  {s}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="ps-6 text-xs text-muted">Typ hieronder hoe het verder moet. Lussen stoppen stel je in bij de bot, onder Werk dat af is.</p>
      </div>
    </div>
  );
}
