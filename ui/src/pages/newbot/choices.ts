/**
 * "Welk model?" when you make a bot: the engines you can pick, best first. No imports, so it is unit-tested directly
 * (tests/new-bot.test.ts).
 *
 * Order (TeamBot 0.4, package A): your own subscriptions first (Claude Code, Codex), then OpenCode's free models, then a
 * local model on this PC (Ollama, LM Studio …), then free API tiers, then paid API keys. The server ranks the default
 * engine the same way (server/api/providers.ts, providerRank) and also knows whether a CLI is logged in, so its default
 * engine is the suggestion when it is in the list.
 */

/** Who pays (same values as Billing in ../../lib/types). */
type Billing = 'free' | 'subscription' | 'paid' | 'local';

/** Local engines by id, also when the kind does not say `billing: 'local'`. */
export const LOCAL_KINDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm', 'jan', 'localai', 'lemonade', 'koboldcpp', 'textgen-webui', 'gpt4all']);

export interface EngineFacts {
  kind: string;
  type: 'api' | 'cli';
  billing?: Billing;
  group?: string;
}

/** One choice under "Welk model?". */
export interface EngineChoice {
  /** `p:<providerId>` for a connected engine, `k:<kindId>` for one found on this PC that is connected when you create the bot. */
  key: string;
  providerId?: string;
  kind: string;
  /** The engine's name ("Claude Code", "Ollama"). */
  label: string;
  /** The model the bot gets; '' = the engine's own default. */
  model: string;
  /** Who pays, in a few words ("met je eigen abonnement"). */
  note: string;
  rank: number;
}

/** Lower is better: subscription CLIs, OpenCode (free), local models, free API tiers, paid API keys. */
export function engineRank(e: EngineFacts): number {
  if (e.type === 'cli') {
    if (e.kind === 'claude-code') return 0;
    if (e.kind === 'codex-cli') return 1;
    if (e.kind === 'opencode' || e.billing === 'free') return 5;
    return e.billing === 'subscription' ? 2 : 40;
  }
  if (e.billing === 'local' || e.group === 'local' || LOCAL_KINDS.has(e.kind)) return 10;
  if (e.billing === 'free' || e.group === 'free') return 20;
  return 30;
}

/** Who pays for this engine, in words. */
export function engineNote(e: EngineFacts): string {
  const r = engineRank(e);
  if (r < 5) return 'met je eigen abonnement';
  if (r === 5) return 'gratis modellen, geen account nodig';
  if (r === 10) return 'gratis, draait op deze pc';
  if (r === 20) return 'gratis, met een daglimiet';
  return 'met je eigen sleutel';
}

/** Best first; `preferred` (the user's default engine) goes on top when it is in the list. */
export function rankChoices(list: EngineChoice[], preferred?: string | null): EngineChoice[] {
  const sorted = [...list].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  const i = preferred ? sorted.findIndex((c) => c.providerId === preferred) : -1;
  if (i > 0) sorted.unshift(...sorted.splice(i, 1));
  return sorted;
}

/**
 * A new bot starts at "Volledige toegang", also for sending to others: it does its work without a question per step.
 * Paying always asks (server/tools/broker.ts). Only the owner of this installation may give that (server/api/agents.ts
 * checks and logs it); anyone else starts at "Automatisch".
 */
export function startAccess(role: string | undefined, settings: Record<string, any> = {}): { access_mode: 'full' | 'auto'; settings: Record<string, any> } {
  return role === 'owner' ? { access_mode: 'full', settings: { ...settings, fullAccessExternal: true } } : { access_mode: 'auto', settings };
}
