import type { Request } from 'express';
import type { Agent, Ctx, Decision, Module, ToolDef } from '../../core/types.js';
import { defineTable, newId, now } from '../../core/db.js';
import { HttpError, ah, bad, notFound, own, str, user } from '../../core/http.js';
import { impactOf } from '../../tools/broker.js';
import { APPS, isParseError, parseRule, type ParsedRule } from './parse.js';
import { applyRules, ruleMatches, type CallInfo, type StoredRule } from './match.js';
import { reviewRulesFor } from './review.js';

/**
 * Own rules in plain words (docs/modules/botrules.md, package P6). The owner writes a rule per bot or per team; it is
 * translated into a fixed rule (parse.ts) that the Broker applies in code on every tool call of API bots, CLI bots and
 * routines (Broker.decide → services.botRules.decide), and the bot also reads it in its system prompt. A rule can make
 * every level stricter; "mag altijd" only lifts a question within the bot's level (match.ts). Making a bot looser —
 * adding an "allow" rule or removing an "ask"/"never" rule — hands out access: only on the computer
 * (`/bot-rules/loosen…` is in the phone's COMPUTER_ONLY list, server/modules/mobile/policy.ts, and refused here too).
 */

defineTable('bot_rules', { json: ['match'], bool: ['review'] });

const MAX_RULES = 50;

type Scope = { agentId: string; teamId?: undefined } | { teamId: string; agentId?: undefined };

export class BotRules {
  private cache = new Map<string, StoredRule[]>();
  constructor(private ctx: Ctx) {}

  private all(userId: string): StoredRule[] {
    let list = this.cache.get(userId);
    if (!list) {
      list = this.ctx.store.find<StoredRule>('bot_rules', { user_id: userId }, { order: 'created_at' });
      this.cache.set(userId, list);
    }
    return list;
  }

  private touch(userId: string) {
    this.cache.delete(userId);
    this.ctx.events.emit(userId, 'botrules.updated', {});
  }

  /** Rules that hold for this bot: its own, then those of its home team. */
  forAgent(agent: Pick<Agent, 'id' | 'user_id'>): StoredRule[] {
    const list = this.all(agent.user_id);
    if (!list.length) return list;
    const own = list.filter((r) => r.agent_id === agent.id);
    const teamRules = list.filter((r) => r.team_id);
    if (!teamRules.length) return own;
    let home: string | null = null;
    try {
      home = this.ctx.services.teams?.teamOf?.(agent.id) ?? null;
    } catch {
      home = null;
    }
    return home ? [...own, ...teamRules.filter((r) => r.team_id === home)] : own;
  }

  list(userId: string, scope: Scope): StoredRule[] {
    return this.all(userId).filter((r) => (scope.agentId ? r.agent_id === scope.agentId : r.team_id === scope.teamId));
  }

  /** The owner's apps (MCP servers) by slug and name, so "in Shopify" also finds his own Shopify app. */
  ownApps(userId: string): { slug: string; name: string }[] {
    try {
      return this.ctx.store.all<{ slug: string; name: string; label: string }>('SELECT slug, name, label FROM mcp_connections WHERE user_id = ?', userId).flatMap((c) => [
        { slug: c.slug, name: c.label || c.name },
        { slug: c.slug, name: c.name },
      ]);
    } catch {
      return [];
    }
  }

  parse(userId: string, text: string) {
    return parseRule(text, { apps: this.ownApps(userId), tools: this.ctx.tools?.list?.().map((t) => t.name) ?? [] });
  }

  add(userId: string, scope: Scope, text: string, rule: ParsedRule): StoredRule {
    if (this.list(userId, scope).length >= MAX_RULES) throw bad(`Hoogstens ${MAX_RULES} regels per bot of team.`);
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (this.list(userId, scope).some((r) => r.text.toLowerCase() === clean.toLowerCase())) throw bad('Deze regel staat er al.');
    const row = {
      id: newId('rule_'),
      user_id: userId,
      agent_id: scope.agentId ?? null,
      team_id: scope.teamId ?? null,
      text: clean,
      effect: rule.effect,
      match: rule.match,
      review: rule.review,
      created_at: now(),
    };
    this.ctx.store.insert('bot_rules', row);
    this.ctx.audit(userId, 'botrules.added', { text: clean, effect: rule.effect, teamId: scope.teamId }, scope.agentId ?? null);
    this.touch(userId);
    return this.ctx.store.get<StoredRule>('bot_rules', row.id)!;
  }

  remove(userId: string, rule: StoredRule) {
    this.ctx.store.remove('bot_rules', rule.id);
    this.ctx.audit(userId, 'botrules.removed', { text: rule.text, effect: rule.effect, teamId: rule.team_id ?? undefined }, rule.agent_id);
    this.touch(userId);
  }

  get(userId: string, id: string): StoredRule {
    const r = this.ctx.store.get<StoredRule>('bot_rules', id);
    if (!r || r.user_id !== userId) throw notFound('Regel niet gevonden');
    return r;
  }

  /** What a call looks like to the rules (who it goes to, which chat channel). */
  callInfo(agent: Agent, tool: Pick<ToolDef, 'name' | 'risk'> & { impact?: ToolDef['impact']; internal?: boolean }, args: any): CallInfo {
    const c: CallInfo = { name: tool.name, risk: tool.risk, args, internal: !!tool.internal };
    if (args !== undefined) c.impact = impactOf(tool, args, agent);
    if (tool.name === 'channel_send' && args !== undefined) {
      try {
        c.channel = this.ctx.services.channels?.adapterFor?.(agent, args?.binding) ?? '?';
      } catch {
        c.channel = '?';
      }
    }
    return c;
  }

  /** The Broker's hook: the decision after the owner's rules (see match.ts). */
  decide(agent: Agent, tool: Pick<ToolDef, 'name' | 'risk'> & { impact?: ToolDef['impact']; internal?: boolean }, args: any, mode: Decision): Decision {
    const rules = this.forAgent(agent);
    if (!rules.length) return mode;
    return applyRules(agent, this.callInfo(agent, tool, args), mode, rules).decision;
  }

  /** The owner's rule behind a final "ask" or "deny" (for the approval card and the bot's message), or null. */
  reason(agent: Agent, tool: Pick<ToolDef, 'name' | 'risk'> & { impact?: ToolDef['impact']; internal?: boolean }, args: any, decision: 'ask' | 'deny'): StoredRule | null {
    const rules = this.forAgent(agent);
    if (!rules.length) return null;
    const c = this.callInfo(agent, tool, args);
    return rules.find((r) => r.effect === decision && ruleMatches(r, c)) ?? null;
  }

  /**
   * The rules TeamBot cannot pin down in code that name one concrete step (review.ts), for the reviewer model: a rule
   * about money or messages only for a step that can pay or send; `strong` = clearly such a step, so a failed check
   * asks the owner instead of letting it through. Asked by the permission gate only (tools/gate.ts).
   */
  reviewFor(agent: Agent, tool: Pick<ToolDef, 'name' | 'risk'> & { impact?: ToolDef['impact']; internal?: boolean; group?: string }, args?: any): { texts: string[]; strong: boolean } {
    const rules = this.forAgent(agent);
    if (!rules.some((r) => r.review)) return { texts: [], strong: false };
    return reviewRulesFor(rules, { ...this.callInfo(agent, tool, args ?? {}), group: tool.group });
  }

  agentDeleted(agentId: string, userId: string) {
    const n = this.ctx.store.all('SELECT id FROM bot_rules WHERE agent_id = ?', agentId).length;
    if (!n) return;
    this.ctx.store.exec('DELETE FROM bot_rules WHERE agent_id = ?', agentId);
    this.touch(userId);
  }

  exportUser(userId: string) {
    return { botRules: this.all(userId).map((r) => ({ text: r.text, effect: r.effect, agent_id: r.agent_id, team_id: r.team_id, created_at: r.created_at })) };
  }

  /**
   * "Team dupliceren": the copies keep the rules of the team and of each bot, so a copy is never looser than the
   * original (copier of the teams module).
   */
  copyTeam(o: { userId: string; fromTeamId: string; toTeamId: string; agentMap: Record<string, string> }): number {
    const src = this.all(o.userId).filter((r) => r.team_id === o.fromTeamId || (r.agent_id && o.agentMap[r.agent_id]));
    for (const r of src)
      this.ctx.store.insert('bot_rules', {
        id: newId('rule_'),
        user_id: o.userId,
        agent_id: r.agent_id ? o.agentMap[r.agent_id] : null,
        team_id: r.team_id ? o.toTeamId : null,
        text: r.text,
        effect: r.effect,
        match: r.match,
        review: r.review,
        created_at: now(),
      });
    if (src.length) this.touch(o.userId);
    return src.length;
  }
}

/** The stable system-prompt note: the rules in the owner's own words (TeamBot also enforces them). */
export function promptNote(svc: BotRules, agent: Agent): string | null {
  if (agent.access_mode === 'chat') return null;
  const rules = svc.forAgent(agent);
  if (!rules.length) return null;
  const label = { deny: 'nooit', ask: 'eerst vragen', allow: 'mag zonder vragen' } as const;
  return [
    '## Regels van je eigenaar',
    'Je eigenaar heeft deze regels voor je werk gesteld. Houd je eraan; TeamBot houdt ze ook zelf tegen of vraagt dan je eigenaar om akkoord. Een regel die iets toestaat, geldt nooit voor versturen, betalen of iets wat niet terug kan.',
    ...rules.map((r) => `- ${r.text.replace(/[\r\n]+/g, ' ').slice(0, 300)} (${label[r.effect]})`),
  ].join('\n');
}

/** The name of a rule's app on screen: a product name, or the owner's own app (MCP server) by its name. */
export function appLabel(ctx: Ctx, userId: string, app: string | undefined): string | undefined {
  if (!app) return undefined;
  if (!app.startsWith('mcp:')) return APPS[app]?.label || app;
  try {
    const c = ctx.store.one<{ name: string; label: string }>('SELECT name, label FROM mcp_connections WHERE user_id = ? AND slug = ?', userId, app.slice(4));
    return c ? c.label || c.name : app.slice(4);
  } catch {
    return app.slice(4);
  }
}

export function plainView(ctx: Ctx, r: StoredRule) {
  return { id: r.id, text: r.text, effect: r.effect, match: r.match, appLabel: appLabel(ctx, r.user_id, r.match?.app), review: r.review, agentId: r.agent_id, teamId: r.team_id, created_at: r.created_at };
}

const instances = new WeakMap<Ctx, BotRules>();
const stops = new WeakMap<Ctx, () => void>();

const mod: Module = {
  id: 'botrules',
  label: 'Eigen regels',
  migrations: [
    {
      id: 'botrules-001',
      sql: `
        CREATE TABLE bot_rules (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          agent_id TEXT,
          team_id TEXT,
          text TEXT NOT NULL,
          effect TEXT NOT NULL,
          match TEXT NOT NULL DEFAULT '{}',
          review INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX bot_rules_user ON bot_rules(user_id, created_at);
      `,
    },
  ],
  init(ctx) {
    const svc = new BotRules(ctx);
    instances.set(ctx, svc);
    const api = ctx.api;
    const loosenMsg = 'Een regel die de bot meer laat doen, of een regel weghalen, doe je op je computer.';
    // Making a bot looser hands out access: never from a paired phone (also closed in the mobile policy).
    const noDevice = (req: Request) => {
      if ((req as any).session?.kind === 'device') throw new HttpError(403, loosenMsg, 'mobile_denied');
    };
    const scopeOf = (req: Request, b: any): Scope => {
      const u = user(req);
      if (typeof b?.agentId === 'string' && b.agentId) {
        const a = own(req, ctx.store.agent(b.agentId), 'Bot niet gevonden');
        return { agentId: a.id };
      }
      if (typeof b?.teamId === 'string' && b.teamId) {
        if (!ctx.services.teams?.own) throw bad('Teams zijn hier niet beschikbaar.');
        ctx.services.teams.own(u.id, b.teamId);
        return { teamId: b.teamId };
      }
      throw bad('Kies een bot of een team.');
    };
    const parsed = (req: Request, text: string): ParsedRule => {
      const r = svc.parse(user(req).id, text);
      if (isParseError(r)) throw new HttpError(400, r.error, `rule_${r.code}`);
      return r;
    };

    api.get(
      '/bot-rules',
      ah(async (req) => {
        const u = user(req);
        const scope = scopeOf(req, req.query);
        const rules = svc.list(u.id, scope).map((r) => plainView(ctx, r));
        if (!scope.agentId) return { rules };
        const home = ctx.services.teams?.teamOf?.(scope.agentId) ?? null;
        const team = home ? ctx.services.teams?.team?.(home) : null;
        return { rules, team: team ? { id: team.id, name: team.name, rules: svc.list(u.id, { teamId: team.id }).map((r) => plainView(ctx, r)) } : null };
      }),
    );

    // What TeamBot makes of a sentence, before it is saved (also on the phone: it changes nothing).
    api.post(
      '/bot-rules/preview',
      ah(async (req) => {
        const r = svc.parse(user(req).id, str(req.body?.text ?? '', 2000));
        return isParseError(r) ? { error: r.error, code: r.code } : { rule: { ...r, appLabel: appLabel(ctx, user(req).id, r.match.app) } };
      }),
    );

    // A stricter rule ("nooit", "vraag eerst"): everywhere, also on the phone.
    api.post(
      '/bot-rules',
      ah(async (req) => {
        const u = user(req);
        const scope = scopeOf(req, req.body);
        const text = str(req.body?.text ?? '', 2000);
        const r = parsed(req, text);
        if (r.effect === 'allow') throw new HttpError(409, 'Deze regel laat de bot meer doen zonder te vragen. Zo’n regel voeg je toe op je computer.', 'rule_loosens');
        return plainView(ctx, svc.add(u.id, scope, text, r));
      }),
    );

    // A rule that lets the bot do more ("mag altijd"): computer only.
    api.post(
      '/bot-rules/loosen',
      ah(async (req) => {
        noDevice(req);
        const u = user(req);
        const scope = scopeOf(req, req.body);
        const text = str(req.body?.text ?? '', 2000);
        return plainView(ctx, svc.add(u.id, scope, text, parsed(req, text)));
      }),
    );

    // Removing an "allow" rule makes the bot stricter: everywhere.
    api.delete(
      '/bot-rules/:id',
      ah(async (req) => {
        const u = user(req);
        const r = svc.get(u.id, String(req.params.id));
        if (r.effect !== 'allow') throw new HttpError(409, 'Deze regel weghalen laat de bot meer doen. Dat doe je op je computer.', 'rule_loosens');
        svc.remove(u.id, r);
        return { ok: true };
      }),
    );

    // Removing an "ask"/"never" rule makes the bot looser: computer only.
    api.delete(
      '/bot-rules/loosen/:id',
      ah(async (req) => {
        noDevice(req);
        const u = user(req);
        svc.remove(u.id, svc.get(u.id, String(req.params.id)));
        return { ok: true };
      }),
    );

    ctx.hooks.systemPrompt.push(({ agent }) => promptNote(svc, agent));
    ctx.hooks.agentDeleted.push(({ agentId, userId }) => svc.agentDeleted(agentId, userId));
    const unCopy = ctx.services.teams?.registerCopier?.('botrules', (o: any) => svc.copyTeam(o));
    if (typeof unCopy === 'function') stops.set(ctx, unCopy);

    ctx.services.botRules = {
      /** Broker hook (sync): the decision after the owner's rules. */
      decide: (agent: Agent, tool: any, args: any, mode: Decision) => svc.decide(agent, tool, args, mode),
      /** The rule that made a call ask or be refused, as `{ text, effect }`, or null. */
      reason: (agent: Agent, tool: any, args: any, decision: 'ask' | 'deny') => {
        const r = svc.reason(agent, tool, args, decision);
        return r ? { text: r.text, effect: r.effect } : null;
      },
      /** The review rules that apply to one step, and whether a failed check must ask (`strong`). */
      reviewFor: (agent: Agent, tool: any, args?: any) => svc.reviewFor(agent, tool, args),
      forAgent: (agent: Agent) => svc.forAgent(agent).map((r) => plainView(ctx, r)),
      exportUser: (userId: string) => svc.exportUser(userId),
      _service: svc,
    };
  },
  stop(ctx) {
    stops.get(ctx)?.();
    stops.delete(ctx);
  },
};

export default mod;
