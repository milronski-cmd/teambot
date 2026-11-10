import path from 'node:path';
import type { Agent, Ctx, User } from '../core/types.js';
import { ah, bad, requireRole, user } from '../core/http.js';
import { assertPublicUrl } from '../tools/builtin/web.js';
import { sharedRunOf, sharedWorkspace } from '../agent/shared.js';

/**
 * Rules for members on a shared server (friends using the owner's TeamBot). Owners/admins and desktop mode are not
 * affected. A member's bot runs as the server's OS user, so anything that reaches outside the bot's own sandbox-less
 * workspace must be off unless the admin explicitly allows it:
 *  - workspace is always the bot's own folder in the data dir (no custom paths, no extra roots)
 *  - no terminal (shell) unless allowShell
 *  - no private-network access for web tools; provider base URLs must be public (no SSRF via a custom endpoint)
 *  - daily spend capped by the admin (members can set a lower limit, never a higher/unlimited one)
 *  - maximum number of bots
 *  - no cloud VMs (browser module, CMP-07) unless allowCloudVm — and then with their own provider token and costs
 * Enforced when saving AND when tools are assembled for a run (defence in depth).
 */
export interface MemberPolicy {
  dailyBudgetUsd: number;
  maxAgents: number;
  allowShell: boolean;
  allowCloudVm: boolean;
}

export const DEFAULT_POLICY: MemberPolicy = { dailyBudgetUsd: 1, maxAgents: 10, allowShell: false, allowCloudVm: false };

export function memberPolicy(ctx: Ctx): MemberPolicy {
  const p = ctx.store.getSetting<Partial<MemberPolicy> | null>('', 'memberPolicy', null) || {};
  return { ...DEFAULT_POLICY, ...p };
}

export function isRestricted(ctx: Ctx, u: Pick<User, 'role'> | null | undefined): boolean {
  return ctx.config.mode === 'server' && (!u || u.role === 'member');
}

/** Clean an agent create/patch from a restricted member. Throws on things that must be refused outright. */
export function sanitizeAgentForMember(ctx: Ctx, u: User, data: Partial<Agent>, existing?: Agent): Partial<Agent> {
  if (!isRestricted(ctx, u)) return data;
  const out: Partial<Agent> = { ...data };
  if (out.workspace !== undefined) {
    const own = existing ? ctx.store.defaultWorkspace(existing.id) : null;
    if (out.workspace && path.resolve(out.workspace) !== (own && path.resolve(own))) throw bad('Op deze server kies je geen eigen map: elke bot werkt in zijn eigen werkmap.');
    delete out.workspace;
  }
  if (out.settings) {
    const s = { ...out.settings };
    delete s.extraRoots;
    delete s.folders;
    delete s.allowPrivateNetwork;
    out.settings = s;
  }
  if (out.tool_groups && !memberPolicy(ctx).allowShell) out.tool_groups = out.tool_groups.filter((g) => g !== 'shell');
  if (!existing) {
    const n = ctx.store.one<any>('SELECT COUNT(*) n FROM agents WHERE user_id = ?', u.id)?.n || 0;
    const max = memberPolicy(ctx).maxAgents;
    if (max > 0 && n >= max) throw bad(max === 1 ? 'Je kunt op deze server maximaal 1 bot hebben.' : `Je kunt op deze server maximaal ${max} bots hebben.`);
  }
  return out;
}

/** Same rules for code paths that create a bot on someone's behalf (templates, duplicate, hire proposals). */
export function sanitizeNewAgentFor(ctx: Ctx, userId: string, data: Partial<Agent>): Partial<Agent> {
  const u = ctx.store.user(userId);
  if (!u) return data;
  return sanitizeAgentForMember(ctx, u, data);
}

/** Validate a provider base URL from a restricted member (must be a public address). */
export async function checkMemberProviderUrl(ctx: Ctx, u: User, baseUrl: string | undefined) {
  if (!isRestricted(ctx, u) || !baseUrl) return;
  try {
    await assertPublicUrl(baseUrl);
  } catch (e: any) {
    throw bad(`Dit adres is niet toegestaan op deze server: ${e.message}`);
  }
}

/** Per-member daily budgets set by the admin (team usage allocation); overrides the policy default. */
export function memberBudgets(ctx: Ctx): Record<string, number> {
  const v = ctx.store.getSetting<Record<string, number> | null>('', 'memberBudgets', null);
  return v && typeof v === 'object' ? v : {};
}

/** Effective daily budget for a user: members can't exceed (or disable) the admin cap. 0 = unlimited. */
export function effectiveBudget(ctx: Ctx, userId: string): number {
  const own = Number(ctx.store.getSetting(userId, 'dailyBudgetUsd', 0)) || 0;
  const u = ctx.store.user(userId);
  if (!isRestricted(ctx, u)) return own;
  const personal = memberBudgets(ctx)[userId];
  const cap = personal !== undefined ? personal : memberPolicy(ctx).dailyBudgetUsd;
  if (!cap) return own;
  return own > 0 ? Math.min(own, cap) : cap;
}

export function memberPolicyRoutes(ctx: Ctx) {
  ctx.api.get(
    '/admin/member-policy',
    ah(async (req) => {
      requireRole(req, 'admin');
      return memberPolicy(ctx);
    }),
  );
  ctx.api.put(
    '/admin/member-policy',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      const b = req.body || {};
      const cur = memberPolicy(ctx);
      const next: MemberPolicy = {
        dailyBudgetUsd: b.dailyBudgetUsd !== undefined ? Math.max(0, Math.min(10_000, Number(b.dailyBudgetUsd) || 0)) : cur.dailyBudgetUsd,
        maxAgents: b.maxAgents !== undefined ? Math.max(0, Math.min(1000, Math.floor(Number(b.maxAgents) || 0))) : cur.maxAgents,
        allowShell: b.allowShell !== undefined ? !!b.allowShell : cur.allowShell,
        allowCloudVm: b.allowCloudVm !== undefined ? !!b.allowCloudVm : cur.allowCloudVm,
      };
      if (next.allowShell && me.role !== 'owner') throw bad('Alleen de eigenaar kan de terminal voor leden aanzetten');
      ctx.store.setSetting('', 'memberPolicy', next);
      ctx.audit(me.id, 'admin.member_policy', next);
      return next;
    }),
  );
  ctx.api.get(
    '/my-limits',
    ah(async (req) => {
      const u = user(req);
      return { restricted: isRestricted(ctx, u), dailyBudgetUsd: effectiveBudget(ctx, u.id), policy: isRestricted(ctx, u) ? memberPolicy(ctx) : null };
    }),
  );
  // Runtime guard: whatever is stored, a restricted member's bot never gets the terminal or paths outside its folder.
  ctx.tools.addFilter((agent, _thread, list) => {
    const owner = ctx.store.user(agent.user_id);
    if (!isRestricted(ctx, owner)) return list;
    const policy = memberPolicy(ctx);
    const ws = path.resolve(agent.workspace || '');
    const own = path.resolve(ctx.store.defaultWorkspace(agent.id));
    // A shared bot in this member's conversation works in its own private folder for him (agent/shared.ts).
    const wsOk = ws === own || (!!sharedRunOf(agent) && ws === path.resolve(sharedWorkspace(ctx, agent.id, agent.user_id)));
    const extra = (Array.isArray(agent.settings?.extraRoots) && agent.settings.extraRoots.length > 0) || (Array.isArray(agent.settings?.folders) && agent.settings.folders.length > 0);
    const priv = !!agent.settings?.allowPrivateNetwork;
    return list.filter((t) => (policy.allowShell || t.group !== 'shell') && (wsOk && !extra ? true : t.group !== 'files') && (!priv || t.group !== 'web'));
  });
}
