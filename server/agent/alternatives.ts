import type { Agent, Ctx, ModelInfo, ProviderConfig } from '../core/types.js';
import { prettyModel } from '../../shared/modelLabel.js';

/**
 * The free path (acceptance round 4: OpenCode's free tier sat at its daily limit all day, and a new user without a
 * subscription was stuck at once). Two helpers:
 *  - `freeReserve`: a local model (Ollama, LM Studio …) with a usable chat model, to be the reserve engine of a bot on
 *    a free engine with a daily limit (OpenCode), set up by "Gratis starten";
 *  - `freeAlternatives`: what a bot can switch to with one click when its engine hit its limit: a local model first,
 *    then another engine the owner already connected that costs nothing extra (his own Claude Code or Codex
 *    subscription, OpenCode's free models). Paid API engines are never offered here: the free path spends no money.
 */

export interface Alternative {
  provider_id: string;
  model: string;
  /** "Ollama (lokaal) · qwen3.6", "Claude Code" */
  label: string;
  kind: 'local' | 'subscription' | 'free';
}

const LOCAL_FIRST = ['ollama', 'lmstudio', 'llamacpp', 'jan', 'lemonade', 'localai', 'vllm', 'koboldcpp', 'textgen-webui', 'gpt4all'];
/** Not a chat model (embeddings, rerankers, speech, images). */
const NOT_CHAT = /embed|rerank|whisper|tts|bge-|nomic|minilm|e5-|clip|vision-encoder|stable-diffusion|flux/i;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/** A chat model of a local provider: the provider's own default, else one loaded now, else one that can use tools, else any. */
export async function localChatModel(ctx: Ctx, cfg: ProviderConfig): Promise<string | null> {
  const models = ((await withTimeout(ctx.providers.adapterFor(cfg).listModels(), 6000)) || []) as ModelInfo[];
  const chat = models.filter((m) => m?.id && !NOT_CHAT.test(m.id) && m.id !== 'default');
  if (!chat.length) return null;
  const own = cfg.config?.defaultModel;
  if (own && chat.some((m) => m.id === own)) return own;
  // The local-models module's advice: the biggest installed model that fits this pc and can use tools.
  const advised = await withTimeout(Promise.resolve(ctx.services.localModels?.pickChatModel?.(cfg, chat) ?? null), 8000);
  if (advised && chat.some((m) => m.id === advised)) return advised;
  // One that is loaded right now answers at once and needs no extra memory; else one that can use tools.
  return (chat.find((m) => m.loadedContext && m.tools !== false) || chat.find((m) => m.tools === true) || chat[0]).id;
}

const label = (cfg: ProviderConfig, model: string) => `${cfg.name}${model && model !== 'default' ? ` · ${prettyModel(model)}` : ''}`;

/**
 * A local model to use as reserve: an enabled local provider of this user with a usable chat model. With `connect`,
 * a local engine that runs on this computer but is not connected yet (Ollama) is connected first, as "Lokaal zoeken"
 * would. Null when there is none (then the UI says in one line how a local model helps).
 */
export async function freeReserve(ctx: Ctx, userId: string, o: { connect?: boolean; exclude?: string[] } = {}): Promise<Alternative | null> {
  const mine = () => ctx.providers.list(userId).filter((p) => p.user_id === userId && p.enabled && !(o.exclude || []).includes(p.id));
  const locals = () => mine().filter((p) => ctx.providers.kind(p.kind)?.billing === 'local').sort((a, b) => rankLocal(a.kind) - rankLocal(b.kind));
  if (!locals().length && o.connect) {
    for (const id of ['ollama', 'lmstudio']) {
      const k = ctx.providers.kind(id);
      if (!k?.detect) continue;
      const s: any = await withTimeout(Promise.resolve(k.detect(ctx)), 6000);
      if (!s?.installed) continue;
      const p = ctx.providers.create(userId, { kind: id, base_url: s.baseUrl && s.baseUrl !== k.baseUrl ? s.baseUrl : undefined });
      ctx.events.emit(userId, 'provider.updated', ctx.providers.view(p, userId));
      break;
    }
  }
  for (const cfg of locals()) {
    const model = await localChatModel(ctx, cfg);
    if (!model) continue;
    // A local engine connected without a model of its own gets this one, so everything else that uses it ("Maak een
    // profiel", a new bot on it) has a model that is really there (acceptance round 5: "Model bestaat niet").
    if (!cfg.config?.defaultModel && cfg.user_id === userId) {
      const p = ctx.providers.updateConfig(cfg.id, userId, { config: { defaultModel: model } });
      ctx.events.emit(userId, 'provider.updated', ctx.providers.view(p, userId));
    }
    return { provider_id: cfg.id, model, label: label(cfg, model), kind: 'local' };
  }
  return null;
}

const rankLocal = (kind: string) => {
  const i = LOCAL_FIRST.indexOf(kind);
  return i < 0 ? LOCAL_FIRST.length : i;
};

const SETTING = 'freeReserve';

/**
 * Find a local reserve (see `freeReserve`) and remember it for this user: bots made from now on on a free engine with
 * a daily limit (OpenCode) get it as their reserve engine (`applyFreeReserve`). Nothing found: the remembered one is
 * forgotten, so no bot gets a reserve that is not there.
 */
export async function rememberFreeReserve(ctx: Ctx, userId: string, o: { connect?: boolean; exclude?: string[] } = {}): Promise<Alternative | null> {
  const r = await freeReserve(ctx, userId, o);
  ctx.store.setSetting(userId, SETTING, r ? { provider_id: r.provider_id, model: r.model } : null);
  return r;
}

/**
 * For a new bot: on a free engine with a daily limit and nothing said about reserves, the remembered local reserve
 * (when it is still connected). Returns the reserve list to store, or undefined to leave the bot as it is.
 */
export function applyFreeReserve(ctx: Ctx, userId: string, providerId: string | null | undefined, fallbacks: unknown): { provider_id: string; model: string }[] | undefined {
  // Only when the bot says nothing about reserves: an empty list is the owner's choice.
  if (fallbacks !== undefined) return undefined;
  const main = providerId ? ctx.providers.config(providerId) : null;
  if (!main || ctx.providers.kind(main.kind)?.billing !== 'free') return undefined;
  const r = ctx.store.getSetting<{ provider_id: string; model: string } | null>(userId, SETTING, null);
  const cfg = r?.provider_id ? ctx.providers.config(r.provider_id) : null;
  if (!r || !cfg || !cfg.enabled || cfg.id === main.id || !ctx.providers.canUse(userId, cfg)) return undefined;
  return [{ provider_id: cfg.id, model: String(r.model || '') }];
}

/**
 * One-click alternatives for a bot whose engine hit its limit (at most 3, best first). `limited`: engines that are
 * at their own limit right now (skipped).
 */
export async function freeAlternatives(ctx: Ctx, agent: Agent, o: { exclude: string[]; limited?: (providerId: string) => boolean }): Promise<Alternative[]> {
  const userId = agent.user_id;
  const out: Alternative[] = [];
  const skip = (p: ProviderConfig) => o.exclude.includes(p.id) || !!o.limited?.(p.id);
  const local = await freeReserve(ctx, userId, { exclude: ctx.providers.list(userId).filter(skip).map((p) => p.id) });
  if (local) out.push(local);
  const cli = ctx.services['cli-agents'];
  for (const p of ctx.providers.list(userId)) {
    if (out.length >= 3) break;
    if (p.user_id !== userId || !p.enabled || skip(p) || out.some((x) => x.provider_id === p.id)) continue;
    const k = ctx.providers.kind(p.kind);
    if (!k || k.type !== 'cli') continue;
    if (k.billing === 'free') {
      out.push({ provider_id: p.id, model: p.config?.defaultModel || '', label: label(p, p.config?.defaultModel || ''), kind: 'free' });
      continue;
    }
    if (k.billing !== 'subscription') continue;
    // Only a CLI that is installed, logged in and on the owner's own subscription (no pay-per-use key).
    const st: any = await withTimeout(Promise.resolve(cli?.status?.(p.kind)), 8000);
    if (!st?.installed || st.loggedIn === false || st.billing !== 'subscription') continue;
    out.push({ provider_id: p.id, model: '', label: p.name, kind: 'subscription' });
  }
  return out;
}
