import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { isDefaultModel, prettyModel } from '../../lib/modelLabel';
import type { Agent, ProviderKindView, ProviderView } from '../../lib/types';
import { Badge, Field, Input, Spinner, cx } from '../../components/ui';
import { FreeStartButton } from '../../modules/cli-agents/runtime';
import { type EngineChoice, engineNote, engineRank, rankChoices } from './choices';
import { MainBotChoice } from '../../modules/teams/MainBot';

/** A ready-made bot under "Wat doet hij?" (the starters of the bot editor): one click fills the questions. */
export interface BotExample {
  name: string;
  description: string;
}

/**
 * The engines for "Welk model?": what is connected, best first (see ./choices). With nothing connected yet, the AI found
 * on this PC that needs no key (it is connected when you create the bot).
 */
export function useEngineChoices(active = true, prefer?: string | null) {
  const providers = useApp((s) => s.providers);
  // The engine chosen on the first screen (`prefer`) goes first, else the user's default engine.
  const preferred = useApp((s) => prefer || (s.settings.defaultProvider as string | undefined) || null);
  const connected = providers.some((p) => p.enabled);
  const [kinds, setKinds] = useState<ProviderKindView[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    // Only look around on this PC (a few seconds) when nothing is connected; otherwise the list of kinds is enough.
    api
      .get<ProviderKindView[]>(`/provider-kinds${connected ? '' : '?detect=1'}`)
      .then((k) => alive && setKinds(k))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [active, connected]);
  const choices = useMemo(() => {
    const kindOf = new Map((kinds || []).map((k) => [k.id, k]));
    const list: EngineChoice[] = [];
    for (const p of providers) {
      if (!p.enabled) continue;
      const k = kindOf.get(p.kind);
      const facts = { kind: p.kind, type: p.type, billing: p.billing ?? k?.billing, group: k?.group };
      list.push({ key: 'p:' + p.id, providerId: p.id, kind: p.kind, label: p.name, model: p.config?.defaultModel || k?.defaultModel || '', note: engineNote(facts), rank: engineRank(facts) });
    }
    if (!list.length)
      for (const k of kinds || []) {
        if (!k.status?.installed || k.needsKey || k.retired || (k.type === 'cli' && k.status.loggedIn === false)) continue;
        const facts = { kind: k.id, type: k.type, billing: k.billing, group: k.group };
        list.push({ key: 'k:' + k.id, kind: k.id, label: k.label, model: k.defaultModel || '', note: engineNote(facts), rank: engineRank(facts) });
      }
    return rankChoices(list, preferred);
  }, [providers, kinds, preferred]);
  return { choices, loading: active && !connected && !kinds && !err };
}

/**
 * The engine of a choice as a connected provider: a choice that was only found on this PC is connected first (no key
 * needed), and OpenCode gets the local reserve set up, like on the welcome screen.
 */
export async function connectChoice(c: EngineChoice): Promise<ProviderView> {
  let p = c.providerId ? useApp.getState().providers.find((x) => x.id === c.providerId) : undefined;
  if (!p) {
    await api.post('/providers/autodetect');
    await useApp.getState().refreshProviders();
    p = useApp.getState().providers.find((x) => x.enabled && x.kind === c.kind);
    if (!p) throw new Error(`${c.label} kon niet gekoppeld worden. Kies een andere AI of koppel er een onder Instellingen › AI-diensten.`);
  }
  if (p.kind === 'opencode') await api.post('/providers/free-reserve').catch(() => null);
  return p;
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[12.5px] font-bold tabular-nums" aria-hidden>
        {n}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The engines to choose from as one list (best first, "Aanbevolen"); with nothing connected: start for free, or connect
 * your own. Used by the first-bot screen and under "Meer opties" of a new bot.
 */
export function EngineChoices({ engines, engineKey, onEngine }: { engines: ReturnType<typeof useEngineChoices>; engineKey: string; onEngine(key: string): void }) {
  const { choices, loading } = engines;
  return (
    <>
          {loading ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-muted">
              <Spinner /> Even kijken welke AI er op deze pc staat…
            </p>
          ) : choices.length ? (
            <div className="mt-2.5 space-y-2">
              {choices.map((c, i) => {
                const on = c.key === engineKey;
                const model = isDefaultModel(c.model) ? '' : prettyModel(c.model);
                return (
                  <label key={c.key} className={cx('flex cursor-pointer items-start gap-3 rounded-card border p-3 transition-colors', on ? 'border-fg bg-surface-3' : 'border-line hover:bg-surface-2')}>
                    <input type="radio" name="bot-engine" className="mt-1" checked={on} onChange={() => onEngine(c.key)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                        <span className="min-w-0 [overflow-wrap:anywhere]">{c.label}</span>
                        {i === 0 && <Badge tone="ok">Aanbevolen</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted [overflow-wrap:anywhere]">
                        {model ? (
                          <>
                            <span translate="no">{model}</span> · {c.note}
                          </>
                        ) : (
                          c.note
                        )}
                        {c.providerId ? '' : ' · gevonden op deze pc'}
                      </span>
                    </span>
                  </label>
                );
              })}
              <a className="inline-block pt-1 text-[13px] font-semibold text-muted underline-offset-2 hover:text-fg hover:underline" href="#/settings/providers">
                Andere AI koppelen
              </a>
            </div>
          ) : (
            <div className="mt-3 space-y-2 rounded-card border border-line p-3">
              <p className="text-sm">Er is nog geen AI gekoppeld. Begin gratis met OpenCode, of koppel je eigen abonnement of sleutel.</p>
              <FreeStartButton onReady={(p) => onEngine('p:' + p.id)} />
              <a className="block text-center text-[13px] font-semibold text-muted underline-offset-2 hover:text-fg hover:underline" href="#/settings/providers">
                Andere AI koppelen
              </a>
            </div>
          )}
    </>
  );
}

/**
 * Making a bot = three questions: its name, what it does (one sentence) and which model (suggested from what is
 * connected). Everything else has good defaults and sits under "Meer opties" on the page around this.
 */
export function BotQuestions({
  draft,
  set,
  engines,
  engineKey,
  onEngine,
  examples,
  onExample,
  autoFocus,
  kindQuestion = true,
}: {
  draft: Partial<Agent>;
  set(p: Partial<Agent>): void;
  engines: ReturnType<typeof useEngineChoices>;
  engineKey: string;
  onEngine(key: string): void;
  examples?: BotExample[];
  onExample?(e: BotExample): void;
  autoFocus?: boolean;
  /** false: no "Hoofdbot of gewone bot" (the very first bot: just the three questions; a bot can become the main bot later). */
  kindQuestion?: boolean;
}) {
  return (
    <div className="space-y-6">
      <Step n={1}>
        <Field label="Hoe heet je bot?">
          <Input value={draft.name || ''} onChange={(e) => set({ name: e.target.value })} maxLength={80} placeholder="Bijv. Mila" autoFocus={autoFocus} autoComplete="off" />
        </Field>
      </Step>

      <Step n={2}>
        <Field label="Wat doet hij?" hint="Eén zin is genoeg. De bot krijgt dit mee als zijn taak.">
          <Input value={draft.description || ''} onChange={(e) => set({ description: e.target.value })} maxLength={300} placeholder="Bijv. Helpt me met mails beantwoorden en mijn agenda." autoComplete="off" />
        </Field>
        {!!examples?.length && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Voorbeelden">
            <span className="text-xs text-muted">Of kies een voorbeeld:</span>
            {examples.map((x) => (
              <button
                key={x.name}
                type="button"
                onClick={() => onExample?.(x)}
                className="inline-flex h-7 items-center rounded-full border border-line px-2.5 text-[12.5px] font-semibold text-muted hover:bg-surface-2 hover:text-fg coarse:h-10"
              >
                {x.name}
              </button>
            ))}
          </div>
        )}
      </Step>

      <Step n={3}>
        <fieldset aria-describedby="welk-model-hint">
          <legend className="text-[13px] font-semibold">Welk model gebruikt hij?</legend>
          <p id="welk-model-hint" className="mt-1 text-xs leading-relaxed text-muted">
            Je kunt het later altijd wijzigen.
          </p>
          <EngineChoices engines={engines} engineKey={engineKey} onEngine={onEngine} />
        </fieldset>
      </Step>

      {/* Package C2: the choice "Hoofdbot of gewone bot", as the fourth question (not for the very first bot). */}
      {kindQuestion && <BotKindQuestion draft={draft} set={set} />}
    </div>
  );
}

/**
 * Package C2 ("De eigenaar maakt de hoofdbot zelf aan"): the choice *Hoofdbot of gewone bot* when making a bot (at most
 * one main bot; modules/teams/MainBot.tsx). It writes a one-time token into the draft's settings, so the choice is saved
 * with the bot by the one "Bot aanmaken".
 */
export function BotKindQuestion({ draft, set }: { draft: Partial<Agent>; set(p: Partial<Agent>): void }): React.ReactNode {
  return <MainBotChoice agent={draft} onChange={set} />;
}
