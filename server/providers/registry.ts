import type { Agent, Ctx, ProviderAdapter, ProviderConfig, ProviderKind } from '../core/types.js';
import { newId, now } from '../core/db.js';
import { bad } from '../core/http.js';

/** A per-bot check on a provider (e.g. teams: a key set to "alleen dit team"): a reason in Dutch, or null. */
export type BotGuard = (agent: Agent, cfg: ProviderConfig) => string | null;

export class ProviderRegistry {
  kinds = new Map<string, ProviderKind>();
  private botGuards: BotGuard[] = [];

  constructor(private getCtx: () => Ctx) {}

  addBotGuard(fn: BotGuard): () => void {
    this.botGuards.push(fn);
    return () => {
      const i = this.botGuards.indexOf(fn);
      if (i >= 0) this.botGuards.splice(i, 1);
    };
  }

  /** Why this bot may not run on this provider (null = it may). A guard that throws refuses (fails closed). */
  refuseFor(agent: Agent, cfg: ProviderConfig): string | null {
    for (const g of this.botGuards) {
      try {
        const why = g(agent, cfg);
        if (why) return why;
      } catch {
        return `Deze bot mag "${cfg.name}" nu niet gebruiken.`;
      }
    }
    return null;
  }

  registerKind(k: ProviderKind) {
    this.kinds.set(k.id, k);
  }

  kind(id: string): ProviderKind | undefined {
    return this.kinds.get(id);
  }

  /** Providers the user may use: their own plus ones the owner shared with everybody. */
  list(userId: string): ProviderConfig[] {
    const s = this.getCtx().store;
    return s.all('SELECT * FROM providers WHERE user_id = ? OR shared = 1 ORDER BY created_at', userId).map((r) => s.decode<ProviderConfig>('providers', r));
  }

  config(id: string | null | undefined): ProviderConfig | null {
    return id ? this.getCtx().store.get<ProviderConfig>('providers', id) : null;
  }

  canUse(userId: string, cfg: ProviderConfig | null): boolean {
    return !!cfg && (cfg.user_id === userId || cfg.shared);
  }

  adapterFor(cfg: ProviderConfig): ProviderAdapter {
    const k = this.kinds.get(cfg.kind);
    if (!k) throw bad(`Onbekend providertype: ${cfg.kind}`);
    const key = this.getCtx().secrets.get(cfg.secret_id);
    if (cfg.secret_id && key === null && k.needsKey && !k.keyOptional)
      throw bad(`De opgeslagen API-sleutel van "${cfg.name}" kan niet meer worden ontsleuteld (bijv. na een nieuwe Windows-installatie). Voer de sleutel opnieuw in via Instellingen → AI-diensten → Sleutel.`);
    return k.create(cfg, key, this.getCtx());
  }

  adapter(id: string): { cfg: ProviderConfig; adapter: ProviderAdapter } {
    const cfg = this.config(id);
    if (!cfg) throw bad('Deze provider bestaat niet meer — kies een andere provider voor deze bot');
    if (!cfg.enabled) throw bad(`Provider "${cfg.name}" staat uit`);
    return { cfg, adapter: this.adapterFor(cfg) };
  }

  create(userId: string, data: { kind: string; name?: string; base_url?: string; apiKey?: string; config?: any; shared?: boolean }): ProviderConfig {
    const k = this.kinds.get(data.kind);
    if (!k) throw bad('Onbekend providertype');
    if (k.needsKey && !data.apiKey && !k.keyOptional) throw bad(`${k.label} heeft een API-sleutel nodig`);
    if (k.id === 'openai-compatible' && !data.base_url) throw bad('Vul de basis-URL van je endpoint in (bijv. http://localhost:8000/v1)');
    const id = newId('prv_');
    const ctx = this.getCtx();
    const secret_id = data.apiKey ? ctx.secrets.set(userId, `provider:${id}`, data.apiKey.trim()) : null;
    const cfg: ProviderConfig = {
      id,
      user_id: userId,
      kind: k.id,
      name: data.name?.trim() || k.label,
      base_url: data.base_url?.trim() || '',
      secret_id,
      config: data.config || {},
      enabled: true,
      shared: !!data.shared,
      created_at: now(),
    };
    ctx.store.insert('providers', cfg);
    ctx.audit(userId, 'provider.created', { id, kind: k.id, name: cfg.name });
    return cfg;
  }

  updateConfig(id: string, userId: string, patch: { name?: string; base_url?: string; apiKey?: string; config?: any; enabled?: boolean; shared?: boolean }): ProviderConfig {
    const ctx = this.getCtx();
    const cfg = this.config(id);
    if (!cfg || cfg.user_id !== userId) throw bad('Provider niet gevonden');
    const p: any = {};
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.base_url !== undefined) p.base_url = patch.base_url;
    if (patch.config !== undefined) p.config = { ...cfg.config, ...patch.config };
    if (patch.enabled !== undefined) p.enabled = patch.enabled;
    if (patch.shared !== undefined) p.shared = patch.shared;
    if (patch.apiKey) p.secret_id = ctx.secrets.set(userId, `provider:${id}`, patch.apiKey.trim());
    ctx.store.update('providers', id, p);
    ctx.audit(userId, 'provider.updated', { id, fields: Object.keys(p) });
    return this.config(id)!;
  }

  remove(id: string, userId: string) {
    const ctx = this.getCtx();
    const cfg = this.config(id);
    if (!cfg || cfg.user_id !== userId) throw bad('Provider niet gevonden');
    if (cfg.secret_id) ctx.secrets.delete(cfg.secret_id);
    ctx.store.remove('providers', id);
    ctx.audit(userId, 'provider.deleted', { id, kind: cfg.kind });
  }

  /** Public view without secrets. */
  view(cfg: ProviderConfig, userId: string) {
    const k = this.kinds.get(cfg.kind);
    return {
      ...cfg,
      secret_id: undefined,
      hasKey: !!cfg.secret_id,
      own: cfg.user_id === userId,
      kindLabel: k?.label || cfg.kind,
      type: k?.type || 'api',
      billing: k?.billing,
    };
  }
}
