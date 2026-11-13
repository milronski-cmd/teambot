import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, Shrink, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useIsDesktop } from '../../lib/media';
import type { Agent, ModelInfo, ProviderView } from '../../lib/types';
import { useApp } from '../../lib/store';
import { REASONING_LABELS, effectiveModel, levelsFor } from '../../components/ModelFacts';
import { Segmented } from '../../components/SettingControls';
import { engineChipNote } from '../../lib/costLabel';
import { botModelText, isDefaultModel, prettyModel } from '../../lib/modelLabel';
import { t, translate } from '../../lib/i18n';
import { Button, Spinner, cx, toast, toastError, useAsync } from '../../components/ui';
import { Pop } from '../../components/Menu';
import { BILLING_TEXT, fmtPct, fmtTokens, toneOf, useChatContext, useUsage, type ContextView, type EngineView } from './api';
import { EngineCard, Ring } from './parts';

function ctxLabel(c: ContextView | null) {
  if (!c || c.kind === 'none') return 'Context onbekend';
  if (typeof c.percent !== 'number') return 'Context onbekend';
  return c.estimated ? t('Context {0} vol (geschat)', fmtPct(c.percent)) : t('Context {0} vol', fmtPct(c.percent));
}

/** Context section: ring, numbers, and "Nu samenvatten" (TeamBot's compaction, or the CLI's own). */
function ContextSection({ c, threadId, agent, onDone }: { c: ContextView | null; threadId: string; agent: Agent; onDone(): void }) {
  const { busy, run } = useAsync();
  const compact = () =>
    run(async () => {
      const r = await api.post<{ compacted: boolean; reason?: string }>(`/threads/${threadId}/compact`, { agentId: agent.id });
      toast(r.compacted ? 'Gesprek samengevat' : `Niet samengevat: ${r.reason}`, r.compacted ? 'ok' : 'neutral');
      onDone();
    });
  const known = !!c && typeof c.percent === 'number';
  const tone = toneOf(c?.percent ?? null);
  return (
    <section aria-label="Context van dit gesprek" className="flex items-start gap-3">
      <Ring value={known ? c!.percent! : null} size={44} stroke={5}>
        <span className={cx('text-[11px] font-bold tabular-nums', known ? (tone === 'fg' ? 'text-fg' : tone === 'warn' ? 'text-warn' : 'text-danger') : 'text-muted')}>{known ? `${Math.round(c!.percent!)}` : '?'}</span>
      </Ring>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold">Context van dit gesprek</div>
        {!c ? (
          <div className="text-[13px] text-muted">Laden…</div>
        ) : c.kind === 'none' ? (
          <div className="text-[13px] text-muted">{c.note}</div>
        ) : known ? (
          <div className="text-[13px] text-muted">
            {c.estimated
              ? t('{0} vol · {1} van {2} tokens (geschat, geheugenbudget van de bot)', fmtPct(c.percent), fmtTokens(c.used), fmtTokens(c.window))
              : t('{0} vol · {1} van {2} tokens', fmtPct(c.percent), fmtTokens(c.used), fmtTokens(c.window))}
          </div>
        ) : (
          <div className="text-[13px] text-muted">
            <span className="font-semibold text-fg">Onbekend.</span> {c.used ? `${fmtTokens(c.used)} tokens gebruikt; de grootte van het venster meldt ${c.engine} niet.` : c.note || 'Nog geen gegevens.'}
          </div>
        )}
        {c?.compactNote && <div className="mt-0.5 text-[12px] text-muted">{c.compactNote}</div>}
        {c && c.kind !== 'none' && (
          <Button size="sm" className="mt-2" icon={<Shrink className="h-3.5 w-3.5" />} loading={busy} disabled={!c.canCompact} onClick={compact} title={c.canCompact ? 'Vat het oudere deel samen; de berichten blijven bewaard' : c.compactNote}>
            Nu samenvatten
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * "Denken": how deep this bot thinks before it answers, one tap in the chat bar (owner: "denkprocessen aan en uit
 * zetten moet nog kunnen"). Only the levels the bot's model takes; nothing when the model has none.
 */
function ThinkingSection({ agent, provider }: { agent: Agent; provider?: ProviderView }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const current = useApp((s) => s.agents.find((a) => a.id === agent.id)?.reasoning) || '';
  useEffect(() => {
    if (!provider) return;
    let live = true;
    api
      .get<ModelInfo[]>(`/providers/${provider.id}/models`)
      .then((m) => live && setModels(m))
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [provider?.id]);
  if (!provider || !models) return null;
  const { levels } = levelsFor(effectiveModel(models, agent.model || '', provider));
  if (!levels.length) return null;
  // Without the explanation in brackets ("Laag (snel, goedkoop)" reads "Laag"); "Extra hoog" keeps both words.
  const short = (l: string) => translate(REASONING_LABELS[l] || l).replace(/ \(.*\)$/, '');
  const options = [{ value: '', label: 'Standaard' }, ...levels.map((l) => ({ value: l, label: l === 'none' ? 'Uit' : short(l) }))];
  const set = async (v: string) => {
    try {
      await api.patch(`/agents/${agent.id}`, { reasoning: v });
      await useApp.getState().refreshAgents();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <section aria-label="Denken" className="border-t border-line pt-3">
      <div className="mb-2 text-[13.5px] font-semibold">Denken</div>
      <Segmented label="Denken" size="sm" value={current} options={options} onChange={set} />
    </section>
  );
}

function Panel({ agent, provider, threadId, context, reloadContext, onClose, titleId }: { agent: Agent; provider?: ProviderView; threadId: string; context: ContextView | null; reloadContext(): void; onClose(): void; titleId: string }) {
  const engines = useUsage((s) => s.engines);
  const load = useUsage((s) => s.load);
  useEffect(() => {
    load(true).catch(() => {});
  }, [load]);
  const e: EngineView | undefined = engines?.find((x) => x.providerId === provider?.id);
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div id={titleId} className="truncate text-[15px] font-bold tracking-tight">
            {provider?.name || 'Geen AI gekozen'}
            {provider && <span className="font-medium text-muted"> · {botModelText(agent.model)}</span>}
          </div>
          <div className={cx('text-[12.5px]', e && (e.billing === 'subscription' || e.billing === 'free' || e.billing === 'local') ? 'text-ok' : 'text-muted')}>
            {e ? e.billingPath || BILLING_TEXT[e.billing] : provider ? '…' : 'Kies een AI in de bot-instellingen'}
            {e?.plan ? ` · ${e.plan}` : ''}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="-me-1 -mt-1" aria-label="Sluiten" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ContextSection c={context} threadId={threadId} agent={agent} onDone={reloadContext} />
      <ThinkingSection agent={agent} provider={provider} />
      <div className="border-t border-line pt-3">
        <div className="mb-2 text-[12px] font-bold uppercase tracking-wider text-muted">Limieten en kosten</div>
        {!provider ? (
          <p className="text-[13px] text-muted">Deze bot heeft nog geen AI-provider.</p>
        ) : !engines ? (
          <Spinner />
        ) : e ? (
          <EngineCard e={e} compact />
        ) : (
          <p className="text-[13px] text-muted">Limieten: onbekend (gedeelde provider van iemand anders).</p>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[13px] font-semibold">
        <a href="#/m/usage/" onClick={onClose} className="inline-flex items-center gap-0.5 hover:underline">
          Alle engines en limieten <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </a>
        <a href={`#/agents/${agent.id}`} onClick={onClose} className="inline-flex items-center gap-0.5 text-muted hover:text-fg hover:underline">
          Model wijzigen <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}

/**
 * In the chat bar, next to the microphone and the send button (the owner: "niet boven, maar in de chatbalk"): one quiet
 * button with a small context ring and, where there is room, the model's short name. It opens the usage popover (upward): which AI service and how it is paid, the context of this chat with "Nu samenvatten", the
 * account's limits with reset times, and cost vs. estimated value.
 * On the phone the popover is a bottom sheet.
 */
export function ChatUsage({ agent, provider, threadId, busy, reserve }: { agent: Agent; provider?: ProviderView; threadId: string; busy: boolean; /** A reserve engine answers right now (provider is then the reserve). */ reserve?: { model: string } }) {
  const [open, setOpen] = useState(false);
  const desktop = useIsDesktop();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { context, reload } = useChatContext(threadId, agent.id, busy);
  const worst = useUsage((s) => s.engines?.find((e) => e.providerId === provider?.id)?.worst || null);
  const blocked = useUsage((s) => !!s.engines?.find((e) => e.providerId === provider?.id && (e.blocked || e.pausedUntil)));
  useEffect(() => {
    if (!useUsage.getState().engines) useUsage.getState().load().catch(() => {});
  }, []);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => desktop && ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', f);
    document.addEventListener('keydown', k);
    return () => (document.removeEventListener('mousedown', f), document.removeEventListener('keydown', k));
  }, [open, desktop]);
  const model = reserve ? reserve.model : agent.model;
  const warn = blocked || worst?.level === 'limit' ? 'danger' : worst?.level === 'warn' ? 'warn' : null;
  const known = context && typeof context.percent === 'number';
  // The chip says one thing: the model, in its short name ("Opus 5.5"), or the AI service when the bot leaves the
  // model to it. Which service, which key and what it costs are in the popover, not squeezed into the header.
  // The route (abonnement, gratis, eigen sleutel) stays one hover away, and in the popover's first lines.
  const note = provider ? engineChipNote(model, provider) : null;
  const chip = provider ? (isDefaultModel(model) ? provider.name : prettyModel(String(model))) : '';
  const panel = <Panel agent={agent} provider={provider} threadId={threadId} context={context} reloadContext={reload} onClose={() => setOpen(false)} titleId={titleId} />;
  return (
    <div className="relative flex shrink-0 items-center" ref={ref}>
      {/* One button: the context ring, and where there is room the model next to it. */}
      <button
        type="button"
        className="tb-tip tb-tip-up relative flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3 aria-expanded:bg-surface-3 aria-expanded:text-fg coarse:h-11 coarse:min-w-11 sm:px-2.5"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${[chip, ctxLabel(context), warn ? translate('limiet bijna of helemaal op') : ''].filter(Boolean).join(' · ')} — ${translate('gebruik en limieten')}`}
        data-tip={[provider ? `${reserve ? translate('Reserve-engine') + ': ' : ''}${provider.name}${note ? ` · ${translate(note.label || note.text)}` : ''}` : '', translate(ctxLabel(context))].filter(Boolean).join(' — ')}
        onClick={() => setOpen(!open)}
      >
        <span className="relative flex shrink-0">
          <Ring value={known ? context!.percent! : null} size={18} stroke={3} />
          {warn && <span className={cx('absolute -end-1 -top-1 h-2 w-2 rounded-full ring-2 ring-surface', warn === 'danger' ? 'bg-danger' : 'bg-warn-strong')} aria-hidden />}
        </span>
        {provider && (
          <span className="hidden max-w-[10rem] items-center gap-1.5 sm:flex">
            {reserve && <span className="shrink-0 rounded-full bg-warn-soft px-1.5 text-[11px] font-bold text-warn">reserve</span>}
            <span className="truncate" translate="no">
              {chip}
            </span>
          </span>
        )}
      </button>
      {desktop && (
        <Pop open={open} origin="bottom right" role="dialog" aria-labelledby={titleId} className="scroll-thin absolute bottom-full end-0 z-40 mb-2 max-h-[min(70vh,600px)] w-[min(400px,calc(100vw-24px))] overflow-y-auto rounded-group p-4">
          {panel}
        </Pop>
      )}
      {open && !desktop && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/55" onMouseDown={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="scroll-thin max-h-[88vh] w-full overflow-y-auto rounded-t-dialog border border-line bg-surface p-5 pb-[max(1.25rem,var(--safe-bottom))]" onMouseDown={(e) => e.stopPropagation()}>
            {panel}
          </div>
        </div>
      )}
    </div>
  );
}
