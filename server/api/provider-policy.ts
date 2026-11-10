import type { Ctx, ProviderConfig } from '../core/types.js';
import { ah, bad, requireRole } from '../core/http.js';
import { usdText } from '../core/i18n.js';
import { effectiveBudget, memberBudgets } from './member-policy.js';

/**
 * Provider fleet policy (PRV-06). The admin's keys live in *shared providers*: everybody on the server can use them,
 * nobody but the owner of the provider ever sees the key (the "org key vault"). On top of that the admin decides per
 * shared provider:
 *  - `config.memberModels`: which models others may use (empty = all). A bot without a model gets the first one.
 *  - `config.memberDailyUsd`: a daily spending cap per person on this provider (0 = only the general budget).
 * And per person a daily budget that overrides the member-policy default (team usage allocation), see
 * `memberBudgets` in member-policy.ts. Everything is enforced in the runner (every run, routines and groups too)
 * and when a bot is saved, so a member can never pick a model outside the policy.
 */

export interface SharedPolicy {
  memberModels: string[];
  memberDailyUsd: number;
}

export function sharedPolicy(cfg: ProviderConfig): SharedPolicy {
  const c: any = cfg.config || {};
  const models = Array.isArray(c.memberModels) ? c.memberModels.map((m: unknown) => String(m).trim()).filter(Boolean) : [];
  return { memberModels: models, memberDailyUsd: Math.max(0, Number(c.memberDailyUsd) || 0) };
}

/** True when `userId` uses a provider that belongs to someone else (shared with the server). */
export function isForeignShared(cfg: ProviderConfig | null | undefined, userId: string): cfg is ProviderConfig {
  return !!cfg && cfg.shared && cfg.user_id !== userId;
}

/** Validate (and default) the model for a shared provider used by someone else. Throws a readable Dutch error. */
export function applySharedModel(cfg: ProviderConfig, userId: string, model: string): string {
  if (!isForeignShared(cfg, userId)) return model;
  const p = sharedPolicy(cfg);
  if (!p.memberModels.length) return model;
  if (!model) return p.memberModels[0];
  if (!p.memberModels.includes(model)) throw bad(`Model “${model}” is op de gedeelde provider ${cfg.name} niet toegestaan. Kies een van: ${p.memberModels.join(', ')}.`);
  return model;
}

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Throws when this person reached the daily cap on a shared provider of someone else. */
export function checkSharedSpend(ctx: Ctx, cfg: ProviderConfig, userId: string) {
  if (!isForeignShared(cfg, userId)) return;
  const cap = sharedPolicy(cfg).memberDailyUsd;
  if (!cap) return;
  const spent = ctx.store.one<{ c: number }>('SELECT COALESCE(SUM(cost),0) AS c FROM usage_log WHERE user_id = ? AND provider_id = ? AND created_at >= ?', userId, cfg.id, startOfToday())?.c ?? 0;
  if (spent >= cap) throw bad(`Je daglimiet van ${usdText(cap)} op de gedeelde provider ${cfg.name} is bereikt. Morgen kan het weer, of vraag de beheerder om meer ruimte.`);
}

/** Policy fields are only accepted from the owner of the provider and only from owners/admins. */
export function cleanPolicyConfig(config: any, role: string): any {
  if (!config || typeof config !== 'object') return config;
  const out = { ...config };
  if (role === 'member' || role === 'guest') {
    delete out.memberModels;
    delete out.memberDailyUsd;
    return out;
  }
  if (out.memberModels !== undefined) out.memberModels = (Array.isArray(out.memberModels) ? out.memberModels : String(out.memberModels).split(',')).map((m: unknown) => String(m).trim().slice(0, 200)).filter(Boolean).slice(0, 100);
  if (out.memberDailyUsd !== undefined) out.memberDailyUsd = Math.max(0, Math.min(10_000, Number(out.memberDailyUsd) || 0));
  return out;
}

export function providerPolicyRoutes(ctx: Ctx) {
  // Team usage (allocation): what everybody used, against which budget, and on which providers.
  ctx.api.get(
    '/admin/usage',
    ah(async (req) => {
      requireRole(req, 'admin');
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const today = startOfToday();
      const users = ctx.store.all<any>('SELECT id, name, email, role FROM users ORDER BY created_at');
      const sum = (sql: string, ...args: any[]) => ctx.store.all<any>(sql, ...args);
      const period = new Map(sum('SELECT user_id, SUM(cost) c, SUM(input) i, SUM(output) o, COUNT(*) n FROM usage_log WHERE created_at >= ? GROUP BY user_id', since).map((r) => [r.user_id, r]));
      const todays = new Map(sum('SELECT user_id, SUM(cost) c FROM usage_log WHERE created_at >= ? GROUP BY user_id', today).map((r) => [r.user_id, r.c]));
      const byProv = sum('SELECT l.user_id, l.provider_id, p.name, p.shared, p.user_id AS owner, SUM(l.cost) c, COUNT(*) n FROM usage_log l LEFT JOIN providers p ON p.id = l.provider_id WHERE l.created_at >= ? GROUP BY l.user_id, l.provider_id ORDER BY c DESC', since);
      const overrides = memberBudgets(ctx);
      return {
        days,
        users: users.map((u) => {
          const p = period.get(u.id);
          return {
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
            today: todays.get(u.id) || 0,
            cost: p?.c || 0,
            tokens: (p?.i || 0) + (p?.o || 0),
            calls: p?.n || 0,
            budget: effectiveBudget(ctx, u.id),
            budgetOverride: overrides[u.id] ?? null,
            providers: byProv.filter((r) => r.user_id === u.id).map((r) => ({ id: r.provider_id, name: r.name || '(verwijderd)', shared: !!r.shared && r.owner !== u.id, cost: r.c || 0, calls: r.n })),
          };
        }),
      };
    }),
  );
  ctx.api.put(
    '/admin/usage/budget/:userId',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      const target = ctx.store.user(req.params.userId as string);
      if (!target) throw bad('Gebruiker niet gevonden');
      if (target.role !== 'member') throw bad('Een persoonlijk budget geldt alleen voor leden; eigenaar en beheerders stellen hun eigen limiet in');
      const raw = req.body?.dailyBudgetUsd;
      const next = { ...memberBudgets(ctx) };
      if (raw === null || raw === undefined || raw === '') delete next[target.id];
      else next[target.id] = Math.max(0, Math.min(10_000, Number(raw) || 0));
      ctx.store.setSetting('', 'memberBudgets', next);
      ctx.audit(me.id, 'admin.member_budget', { userId: target.id, dailyBudgetUsd: next[target.id] ?? null });
      return { userId: target.id, budget: effectiveBudget(ctx, target.id), budgetOverride: next[target.id] ?? null };
    }),
  );
}
