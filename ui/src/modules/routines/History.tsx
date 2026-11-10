import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ExternalLink, Receipt, RefreshCw, Square } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Badge, Button, Card, EmptyState, Modal, Select, Spinner, useAsync } from '../../components/ui';
import { Fold, Skeleton, SkeletonRows } from '../../components/overview';
import { Markdown } from '../../shell/Markdown';
import { ACTIVE, fmtCost, fmtDate, fmtDuration, RUN_STATUS, runStatus, startedByText, TRIGGER_LABEL, type RunProof, type RunView } from './lib';
import { RunChanges } from '../folders/Trash';

const PROOF_KIND: Record<string, string> = { file: 'Bestand', message: 'Bericht', task: 'Taak', action: 'Actie' };

/** "Bewijs: notulen.md geschreven" or why there is no result, in one line under the receipt. */
function ProofLine({ proof }: { proof?: RunProof }) {
  if (!proof) return null;
  if (proof.result === 'none') return <p className="text-xs text-warn">{proof.reason}</p>;
  if (proof.result === 'answer') return <p className="text-xs text-muted">Resultaat: het antwoord van de bot.</p>;
  const first = proof.items[0];
  return (
    <p className="text-xs text-ok">
      {proof.items.length === 1 ? `Bewijs: ${first.text}` : t('Bewijs: {0} (en {1, plural, one {# ander} other {# andere}})', first.text, proof.items.length - 1)}
    </p>
  );
}

/** Delivery to a chat app and the routine chain, as one line each (empty when not used). */
/** The channel delivery on a run receipt: { ok, at, error } (also reads the older `delivered` shape). */
function deliveryOf(rr: RunView): { ok: boolean; at?: string; error?: string; files?: number } | null {
  const d = rr.meta?.delivery;
  if (d) return { ok: d.status === 'sent', at: d.at, error: d.error, files: d.files };
  return rr.meta?.delivered || null;
}

function RunLinks({ rr }: { rr: RunView }) {
  const d = deliveryOf(rr);
  const n = rr.meta?.next;
  const by = startedByText(rr);
  if (!d && !n && !by && rr.trigger !== 'chain') return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {by && <span className="min-w-0 break-words text-muted">{by}</span>}
      {d && <span className={d.ok ? 'text-ok' : 'text-danger'}>{d.ok ? (!d.files ? 'Verstuurd naar het kanaal' : d.files === 1 ? 'Verstuurd naar het kanaal (met 1 bestand)' : `Verstuurd naar het kanaal (met ${d.files} bestanden)`) : `Versturen naar het kanaal mislukt: ${d.error || 'onbekend'}`}</span>}
      {rr.trigger === 'chain' && rr.meta?.fromRun && <span className="text-muted">Gestart na een andere routine</span>}
      {n && (n.error ? <span className="text-warn">Volgende routine niet gestart: {n.error}</span> : <span className="text-muted">Volgende routine gestart</span>)}
    </div>
  );
}

export function RunReceipt({ rr, tz, onOpen, onCancel, busy }: { rr: RunView; tz: string; onOpen(): void; onCancel(): void; busy?: boolean }) {
  const st = runStatus(rr);
  const tokens = (rr.usage?.input || 0) + (rr.usage?.output || 0);
  const waiting = rr.status === 'retrying' && rr.meta?.limitWait;
  return (
    <Card className="space-y-2 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={st.tone}>{st.label}</Badge>
        <Badge>{TRIGGER_LABEL[rr.trigger] || rr.trigger}</Badge>
        {rr.routineName && <span className="text-xs font-medium">{rr.routineName}</span>}
        {rr.max_attempts > 1 && rr.attempt > 1 && <span className="text-xs text-muted">poging {rr.attempt}/{rr.max_attempts}</span>}
        <span className="ms-auto text-xs text-muted">{fmtDate(rr.started_at || rr.created_at, tz)}</span>
      </div>
      {(rr.summary || rr.error) && !waiting && <p className={rr.status === 'error' ? 'line-clamp-3 text-sm text-danger' : 'line-clamp-3 whitespace-pre-wrap text-sm'}>{rr.status === 'error' ? rr.error : rr.summary || rr.error}</p>}
      {rr.status === 'done' && <ProofLine proof={rr.meta?.proof} />}
      {waiting && rr.next_retry_at && (
        <p className="text-xs text-warn">
          De AI-engine heeft zijn limiet bereikt. Gaat automatisch verder om {fmtDate(rr.next_retry_at, tz)}
          {rr.meta.limitWait.count > 1 ? ` (${rr.meta.limitWait.count}e keer wachten)` : ''}.{rr.error ? ` — ${rr.error.slice(0, 160)}` : ''}
        </p>
      )}
      {rr.status === 'retrying' && !waiting && rr.next_retry_at && <p className="text-xs text-warn">Volgende poging: {fmtDate(rr.next_retry_at, tz)}{rr.error ? ` — ${rr.error.slice(0, 160)}` : ''}</p>}
      <RunLinks rr={rr} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {rr.scheduled_for && <span>Gepland: {fmtDate(rr.scheduled_for, tz)}</span>}
        <span>Duur: {fmtDuration(rr.duration_ms)}</span>
        <span>Tokens: {tokens ? `${rr.usage.input || 0} in / ${rr.usage.output || 0} uit` : '—'}</span>
        <span>Kosten: {fmtCost(rr.usage?.cost)}</span>
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" variant="ghost" icon={<Receipt className="h-4 w-4" />} onClick={onOpen}>
          Bonnetje
        </Button>
        {rr.thread_id && (
          <a className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-accent hover:bg-surface-2" href={`#/t/${rr.thread_id}`}>
            <ExternalLink className="h-4 w-4" /> Gesprek
          </a>
        )}
        {ACTIVE.includes(rr.status) && (
          <Button size="sm" variant="ghost" icon={<Square className="h-4 w-4" />} onClick={onCancel} loading={busy}>
            Annuleren
          </Button>
        )}
      </div>
    </Card>
  );
}

export function ReceiptModal({ id, tz, onClose }: { id: string | null; tz: string; onClose(): void }) {
  const [rr, setRr] = useState<RunView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    setRr(null);
    setErr(null);
    api
      .get<RunView>(`/routines/runs/${id}`)
      .then(setRr)
      .catch((e) => setErr(e.message));
  }, [id]);
  const st = rr ? runStatus(rr) : null;
  const row = (k: string, v: ReactNode) => (
    <div className="flex gap-3 border-b border-line py-1.5 text-sm last:border-0">
      <div className="w-32 shrink-0 text-muted">{k}</div>
      <div className="min-w-0 flex-1 break-words">{v}</div>
    </div>
  );
  return (
    <Modal open={!!id} onClose={onClose} title="Run-bonnetje" wide>
      {err && <div className="text-sm text-danger">{err}</div>}
      {!rr && !err && (
        <div className="space-y-3" role="status" aria-label="Laden">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-24 rounded-control" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      )}
      {rr && st && (
        <div className="space-y-4">
          {/* First what happened, in one line; the numbers are in the fold "Details". */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <Badge tone={st.tone}>{st.label}</Badge>
            <span className="text-muted">
              {[startedByText(rr) || TRIGGER_LABEL[rr.trigger] || rr.trigger, fmtDate(rr.started_at || rr.created_at, tz), rr.duration_ms != null ? fmtDuration(rr.duration_ms) : ''].filter(Boolean).join(' · ')}
            </span>
            {rr.thread_id && (
              <a className="ms-auto font-medium underline underline-offset-2" href={`#/t/${rr.thread_id}`}>
                Naar het gesprek
              </a>
            )}
          </div>
          {rr.meta?.preflight?.blockers?.length > 0 && (
            <div data-preflight>
              <div className="mb-1 text-sm font-medium">Koppelingen gecontroleerd vóór de start</div>
              <ul className="space-y-1 text-sm">
                {(rr.meta.preflight.blockers as { kind: string; id: string; text: string; link: string }[]).map((b) => (
                  <li key={b.kind + b.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone="danger">{b.kind === 'app' ? 'App' : 'Kanaal'}</Badge>
                    <span className="min-w-0 break-words">{b.text}</span>
                    <a className="text-accent underline" href={b.link}>
                      Repareren
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted">De bot is niet gestart, dus dit kostte niets.</p>
            </div>
          )}
          {rr.status === 'done' && rr.meta?.proof && (
            <div>
              <div className="mb-1 text-sm font-medium">Resultaat</div>
              {rr.meta.proof.result === 'none' ? (
                <p className="rounded-control bg-warn-soft px-3 py-2.5 text-sm text-warn">{rr.meta.proof.reason}</p>
              ) : rr.meta.proof.result === 'answer' ? (
                <p className="text-sm text-muted">Het antwoord van de bot, hieronder.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {(rr.meta.proof as RunProof).items.map((i, n) => (
                    <li key={n} className="flex flex-wrap items-center gap-2">
                      <Badge tone="ok">{PROOF_KIND[i.kind] || i.kind}</Badge>
                      <span className="min-w-0 break-words">{i.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              {rr.meta.proof.result !== 'none' && rr.meta.proof.claims?.length > 0 && <p className="mt-1 text-xs text-warn">De bot noemde ook {rr.meta.proof.claims.join(' en ')}, maar TeamBot zag dat niet gebeuren.</p>}
            </div>
          )}
          {(rr.meta?.runIds?.length || rr.run_id) && <RunChanges runIds={rr.meta?.runIds?.length ? rr.meta.runIds : [rr.run_id!]} />}
          {rr.summary && (
            <div>
              <div className="mb-1 text-sm font-medium">Samenvatting</div>
              <div className="scroll-thin max-h-72 overflow-auto rounded-control bg-surface-2 p-3 text-sm">
                <Markdown text={rr.summary} />
              </div>
            </div>
          )}
          {rr.error && (
            <div>
              <div className="mb-1 text-sm font-medium">Fout</div>
              <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap rounded-control bg-danger-soft p-3 font-sans text-sm text-danger">{rr.error}</pre>
            </div>
          )}
          <Fold title="Details" card={false} testId="receipt-details">
            <div>
              {row('Aanleiding', startedByText(rr) || TRIGGER_LABEL[rr.trigger] || rr.trigger)}
              {rr.scheduled_for && row('Gepland voor', fmtDate(rr.scheduled_for, tz))}
              {row('Gestart', fmtDate(rr.started_at, tz))}
              {row('Klaar', fmtDate(rr.finished_at, tz))}
              {row('Duur', fmtDuration(rr.duration_ms))}
              {row('Pogingen', `${rr.attempt} van max. ${rr.max_attempts}`)}
              {row('Tokens', `${rr.usage?.input || 0} in / ${rr.usage?.output || 0} uit`)}
              {row('Kosten (schatting)', fmtCost(rr.usage?.cost))}
              {rr.meta?.missed &&
                row('Gemist', rr.meta.capped ? t('Meer dan {0, plural, one {# geplande run} other {# geplande runs}} sinds {1}', rr.meta.missed, fmtDate(rr.meta.missedFrom, tz)) : t('{0, plural, one {# geplande run} other {# geplande runs}} sinds {1}', rr.meta.missed, fmtDate(rr.meta.missedFrom, tz)))}
              {rr.meta?.limitWait && row('Limiet', `${rr.meta.limitWait.count}× gewacht op de reset van de AI-engine (tot ${fmtDate(rr.meta.limitWait.until, tz)})`)}
              {deliveryOf(rr) && row('Kanaal', deliveryOf(rr)!.ok ? `Verstuurd (${fmtDate(deliveryOf(rr)!.at!, tz)})` : `Mislukt: ${deliveryOf(rr)!.error || 'onbekend'}`)}
              {rr.meta?.next && row('Daarna', rr.meta.next.error ? `Niet gestart: ${rr.meta.next.error}` : 'Volgende routine gestart')}
              {rr.meta?.notRun && row('Niet gedraaid', rr.meta.reason || 'De planner startte deze run niet.')}
            </div>
          </Fold>
          {rr.payload && (
            <Fold title={t('Ontvangen data ({0})', rr.payload.label)} card={false} testId="receipt-payload">
              <pre className="scroll-thin max-h-72 overflow-auto rounded-control bg-surface-2 p-3 text-xs">{typeof rr.payload.data === 'string' ? rr.payload.data : JSON.stringify(rr.payload.data, null, 2)}</pre>
            </Fold>
          )}
        </div>
      )}
    </Modal>
  );
}

export function HistoryTab({ routineId, tz }: { routineId: string; tz: string }) {
  const [rows, setRows] = useState<RunView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { busy, run } = useAsync();

  const load = useCallback(
    async (before?: string) => {
      try {
        const q = new URLSearchParams({ limit: '30' });
        if (before) q.set('before', before);
        if (status) q.set('status', status);
        const list = await api.get<RunView[]>(`/routines/${routineId}/runs?${q}`);
        setRows((cur) => (before && cur ? [...cur, ...list] : list));
        setMore(list.length === 30);
        setErr(null);
      } catch (e: any) {
        setErr(e.message);
      }
    },
    [routineId, status],
  );

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  useEffect(
    () =>
      on('routine.run', (rr: RunView) => {
        if (rr.routine_id !== routineId) return;
        setRows((cur) => {
          if (!cur) return cur;
          const i = cur.findIndex((x) => x.id === rr.id);
          if (i >= 0) return cur.map((x) => (x.id === rr.id ? rr : x));
          if (status && rr.status !== status) return cur;
          return [rr, ...cur];
        });
      }),
    [routineId, status],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-56" aria-label="Filter op status">
          <option value="">Alle runs</option>
          {Object.entries(RUN_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={() => load()}>
          Vernieuwen
        </Button>
      </div>
      {err && (
        <EmptyState icon={<Receipt />} title="Historie laden mislukt" action={<Button onClick={() => load()}>Opnieuw</Button>}>
          {err}
        </EmptyState>
      )}
      {!err && !rows && <SkeletonRows n={3} avatar={false} />}
      {rows && !rows.length && (
        <EmptyState icon={<Receipt />} title="Nog geen runs">
          {status ? 'Geen runs met deze status.' : 'Met “Nu testen” probeer je de routine meteen.'}
        </EmptyState>
      )}
      {rows?.map((rr) => (
        <RunReceipt key={rr.id} rr={rr} tz={tz} onOpen={() => setOpen(rr.id)} busy={busy} onCancel={() => run(() => api.post(`/routines/runs/${rr.id}/cancel`), 'Run geannuleerd')} />
      ))}
      {more && rows && (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={() => load(rows[rows.length - 1].created_at)}>
            Meer laden
          </Button>
        </div>
      )}
      <ReceiptModal id={open} tz={tz} onClose={() => setOpen(null)} />
    </div>
  );
}
