import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useIsDesktop } from '../lib/media';
import { isDefaultModel } from '../lib/modelLabel';
import { translate } from '../lib/i18n';
import type { Agent } from '../lib/types';
import { Button, cx, toast, toastError } from '../components/ui';
import { Pop, useDismiss } from '../components/Menu';
import { ModelMenu } from '../components/ModelPicker';
import { AUTO, controlText, fitReasoning, levelsOfPick, type ModelGroup, type ModelPick } from './modelSwitch';
import { aiPick } from '../pages/agentRows';

/** The lists last fetched, per bot (an AI a bot may not use is left out for that bot): the list opens at once. */
const kept = new Map<string, { at: number; groups: ModelGroup[]; providers: unknown }>();
const FRESH_MS = 30_000;

/**
 * On top of a chat with a bot (the owner: "bovenin de chat, dat ik een bot zo op een ander model kan zetten"): one
 * quiet control that says which AI and model the bot is on ("Claude Code · Sonnet", "Automatisch" when the AI picks;
 * in a narrow header only the model). One click opens the list of every model of every connected AI (ModelMenu); a
 * pick is saved on the bot at once, the AI and the model together, and counts from the next message: a turn that is
 * running goes on as it was. A thinking level the new model does not take becomes the nearest one it does.
 * Desktop: a popover under the control; phone: a sheet from the bottom.
 */
export function ModelSwitcher({ agent: given, busy }: { agent: Agent; busy: boolean }) {
  const desktop = useIsDesktop();
  // The bot as the store has it now: the control follows a change made here, on the bot's page or on another device.
  const agent = useApp((s) => s.agents.find((a) => a.id === given.id)) || given;
  const providers = useApp((s) => s.providers);
  const provider = providers.find((p) => p.id === agent.provider_id);
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<ModelGroup[] | null>(null);
  const [error, setError] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  useDismiss(open, desktop ? wrap : sheet, close, btn);
  // The sheet on a phone takes the focus (a screen reader starts in it); the popover does that itself (ModelMenu).
  useEffect(() => {
    if (open && !desktop) sheet.current?.focus({ preventScroll: true });
  }, [open, desktop]);

  useEffect(() => {
    if (!open) return;
    const hit = kept.get(agent.id);
    const usable = hit && hit.providers === providers ? hit : null;
    setGroups(usable ? usable.groups : null);
    setError('');
    if (usable && Date.now() - usable.at < FRESH_MS) return;
    let live = true;
    const url = `/model-catalog/choices?agentId=${encodeURIComponent(agent.id)}`;
    const show = (list: ModelGroup[]) => {
      // A list with an AI still being read is shown, but not kept as the whole list.
      kept.set(agent.id, { at: list.some((g) => g.pending) ? 0 : Date.now(), groups: list, providers });
      if (live) setGroups(list);
      return list;
    };
    // First what is there within a moment (a CLI that reads its models for the first time takes seconds), then the rest.
    api
      .get<{ groups: ModelGroup[] }>(`${url}&soft=1`)
      .then((r) => (show(r.groups).some((g) => g.pending) && live ? api.get<{ groups: ModelGroup[] }>(url).then((rest) => show(rest.groups)) : null))
      .catch((e) => live && setError(e?.message || String(e)));
    return () => {
      live = false;
    };
  }, [open, agent.id, providers]);

  const pick = async (p: ModelPick) => {
    close();
    btn.current?.focus({ preventScroll: true });
    const cur = useApp.getState().agents.find((a) => a.id === agent.id) || agent;
    if (cur.provider_id === p.provider_id && (isDefaultModel(cur.model) ? '' : cur.model) === p.model) return;
    const reasoning = fitReasoning(cur.reasoning || '', groups ? levelsOfPick(groups, p) : undefined);
    // Another AI: what does not apply there is put aside and comes back with the AI it belongs to (same rule as the bot page).
    const patch = { ...aiPick(cur as any, providers as any, p), ...(reasoning !== (cur.reasoning || '') ? { reasoning } : {}) };
    // In the control at once; taken back when the server refuses it.
    const put = (v: Partial<Agent>) => useApp.setState((s) => ({ agents: s.agents.map((a) => (a.id === cur.id ? { ...a, ...v } : a)) }));
    put(patch);
    try {
      put(await api.patch<Agent>(`/agents/${cur.id}`, patch));
      if (busy) toast('Geldt vanaf je volgende bericht.', 'ok');
    } catch (e) {
      put({ provider_id: cur.provider_id, model: cur.model, reasoning: cur.reasoning, access_mode: cur.access_mode, settings: cur.settings });
      toastError(e);
    }
  };

  const text = controlText(agent, provider);
  const auto = text.model === AUTO;
  const model = !provider && auto ? 'Kies een AI' : text.model;
  const menu = (
    <ModelMenu groups={groups} error={error} value={{ provider_id: agent.provider_id, model: agent.model || '' }} onPick={pick} autoFocus={desktop} more={{ href: '#/settings/providers', label: "Meer AI's koppelen", onClick: close }} />
  );
  return (
    // Narrow header: only the model, and the control gives way before the bot's name does (it shrinks twenty times as fast).
    <div className="relative min-w-0 max-w-[6.75rem] shrink-[20] coarse:min-w-11 @[620px]:max-w-[17rem]" ref={wrap}>
      <button
        ref={btn}
        type="button"
        data-testid="model-switch"
        className="group flex h-9 w-full min-w-0 items-center justify-center rounded-full coarse:h-11"
        aria-haspopup="dialog"
        aria-expanded={open}
        // A model's own name is never translated; "Automatisch" and "Kies een AI" are.
        aria-label={`${text.ai ? `${text.ai} · ` : ''}${auto ? translate(model) : model} — ${translate('Model wijzigen')}`}
        onClick={() => setOpen(!open)}
      >
        <span className="flex h-7 min-w-0 items-center gap-0.5 rounded-full border border-line ps-2 pe-1 text-[12px] font-medium text-muted transition-colors group-hover:bg-surface-2 group-hover:text-fg group-aria-expanded:bg-surface-2 group-aria-expanded:text-fg @[620px]:gap-1 @[620px]:ps-2.5 @[620px]:pe-1.5 @[620px]:text-[12.5px]">
          <span className="min-w-0 truncate">
            {text.ai && (
              <span className="hidden @[620px]:inline" translate="no">
                {text.ai} ·{' '}
              </span>
            )}
            <span translate={auto ? undefined : 'no'}>{model}</span>
          </span>
          <ChevronDown className={cx('size-3 shrink-0 transition-transform duration-150 @[620px]:size-3.5', open && 'rotate-180')} aria-hidden />
        </span>
      </button>
      {desktop && (
        <Pop open={open} origin="top right" role="dialog" aria-label="Model" className="absolute end-0 top-full z-30 mt-1 flex max-h-[min(70vh,520px)] w-[min(340px,86vw)] flex-col p-1.5">
          {menu}
        </Pop>
      )}
      {!desktop &&
        open &&
        createPortal(
          <div className="tb-overlay fixed inset-0 z-50 flex items-end bg-black/55">
            <div ref={sheet} role="dialog" aria-modal="true" aria-label="Model" tabIndex={-1} className="flex max-h-[80vh] w-full flex-col rounded-t-dialog border border-line bg-surface p-2 pb-[max(0.5rem,var(--safe-bottom))] outline-none">
              <div className="flex shrink-0 items-center justify-between gap-3 ps-2.5">
                <div className="min-w-0 truncate text-base font-bold tracking-tight">Model</div>
                <Button variant="ghost" size="icon" aria-label="Sluiten" onClick={close}>
                  <X className="size-icon" />
                </Button>
              </div>
              {menu}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
