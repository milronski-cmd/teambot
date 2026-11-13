import type { Module } from '../../core/types.js';
import { ah, bad, notFound, user } from '../../core/http.js';
import { UsageService } from './service.js';
import { estimateFor } from './estimate.js';
import { botCapCheck, capStatus } from './cap.js';

/**
 * "Gebruik en limieten": usage windows per account (5 hours / week / month, reset time), the estimated value of
 * subscription work, the context fill of a chat, limit notifications, and what is running or waiting right now (for
 * the floating status window and the phone). Engines report into ctx.services.usage (see parse.ts for what is real).
 * The always-visible usage bar (GET /usage/bar) and usage per bot (GET /usage/breakdown); other modules add free
 * sources with ctx.services.usage.reportSource(...) and the weekly reserve with reportReserve(...) —
 * docs/modules/usage.md.
 */

let svc: UsageService | null = null;

const mod: Module = {
  id: 'usage',
  label: 'Gebruik en limieten',
  migrations: [
    {
      id: 'usage-001',
      sql: `CREATE TABLE usage_engines (provider_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
CREATE TABLE usage_context (thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, PRIMARY KEY (thread_id, agent_id));`,
    },
    {
      // Free sources that other modules report for the usage bar (reportSource); user_id '*' = every user.
      id: 'usage-002-sources',
      sql: `CREATE TABLE usage_sources (id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, PRIMARY KEY (id, user_id));`,
    },
    {
      // A bot's own usage cap (cap.ts) adds up its usage before every model call: by bot and time.
      id: 'usage-bot-cap',
      sql: `CREATE INDEX IF NOT EXISTS usage_agent ON usage_log(agent_id, created_at);`,
    },
    {
      // A call that stopped before the engine gave its numbers is counted as TeamBot's estimate (agent/budget.ts,
      // recordUnfinished): 1 = these tokens are an estimate, not the engine's count.
      id: 'usage-estimated',
      sql: `ALTER TABLE usage_log ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;`,
    },
  ],
  init(ctx) {
    const s = new UsageService(ctx);
    svc = s;
    ctx.services.usage = s;

    const own = (userId: string, id: string) => {
      const c = ctx.providers.config(id);
      if (!c || c.user_id !== userId) throw notFound('Provider niet gevonden');
      return c;
    };
    const canSee = (userId: string, threadId: string) => {
      const t = ctx.store.thread(threadId);
      if (!t || (t.user_id !== userId && !(t.meta?.memberUserIds || []).includes(userId))) throw notFound('Gesprek niet gevonden');
      return t;
    };

    /** All accounts with their limits; `?refresh=1` asks CLIs with numbers older than a minute again in the background (results via usage.updated). */
    ctx.api.get(
      '/usage/limits',
      ah(async (req) => {
        const u = user(req);
        if (req.query.refresh === '1') for (const c of ctx.providers.list(u.id).filter((p) => p.user_id === u.id && p.enabled)) void s.refresh(c).catch(() => {});
        return { engines: await s.engines(u.id), alerts: s.alerts(u.id), now: Date.now() };
      }),
    );

    ctx.api.get(
      '/usage/limits/:id',
      ah(async (req) => {
        const u = user(req);
        const c = own(u.id, req.params.id as string);
        if (req.query.refresh === '1') void s.refresh(c).catch(() => {});
        return s.engineView(c);
      }),
    );

    ctx.api.post(
      '/usage/limits/:id/refresh',
      ah(async (req) => {
        const u = user(req);
        const c = own(u.id, req.params.id as string);
        if (!s.canRead(c)) throw bad(`${c.name} geeft zijn limieten niet door aan TeamBot.`);
        await s.refresh(c, true);
        return s.engineView(c);
      }),
    );

    ctx.api.put(
      '/usage/alerts',
      ah(async (req) => s.setAlerts(user(req).id, { enabled: req.body?.enabled, warnAt: req.body?.warnAt })),
    );

    ctx.api.get(
      '/usage/context/:threadId',
      ah(async (req) => {
        const u = user(req);
        const t = canSee(u.id, req.params.threadId as string);
        const agentId = (req.query.agentId as string) || t.agent_id;
        const agent = agentId ? ctx.store.agent(agentId) : null;
        if (!agent || agent.user_id !== t.user_id) throw bad('Geen bot in dit gesprek');
        return s.contextView(agent, t);
      }),
    );

    ctx.api.get(
      '/usage/status',
      ah(async (req) => s.status(user(req).id)),
    );

    /**
     * The always-visible usage bar (sidebar, top of Meer on the phone). Cheap: stored numbers only. `?refresh=1` asks
     * the CLIs whose numbers are older than a minute (20 seconds while a bot works on them), in the background (the new
     * numbers follow via usage.updated).
     */
    ctx.api.get(
      '/usage/bar',
      ah(async (req) => {
        const u = user(req);
        if (req.query.refresh === '1') for (const c of ctx.providers.list(u.id).filter((p) => p.user_id === u.id && p.enabled && (p.kind === 'claude-code' || p.kind === 'codex-cli'))) void s.refresh(c).catch(() => {});
        return s.bar(u.id);
      }),
    );

    /** Usage per bot, today and this week. `?by=bot` (default) or `by=team` (a row per team, its bots in `children`). */
    ctx.api.get(
      '/usage/breakdown',
      ah(async (req) => {
        const by = String(req.query.by || 'bot');
        if (by !== 'bot' && by !== 'team') throw bad('Kies verbruik per bot of per team.');
        if (by === 'team' && !ctx.services.teams?.teamOf) throw bad('Verbruik per team kan alleen met teams; kies per bot.');
        return s.breakdown(user(req).id, by);
      }),
    );

    /**
     * "Kosten vooraf" (P3): what one run of this routine (else this bot) will roughly cost, and its share of the usage
     * windows; `startAfter` when it does not fit in what is left. `?routineId=` or `?agentId=` (+ `important=1`).
     */
    ctx.api.get(
      '/usage/estimate',
      ah(async (req) => {
        const u = user(req);
        const routineId = typeof req.query.routineId === 'string' ? req.query.routineId : '';
        const engine = ctx.services.routines?.engine;
        const r = routineId ? engine?.routine?.(routineId) : null;
        if (routineId && (!r || r.user_id !== u.id)) throw notFound('Routine niet gevonden');
        const agentId = r ? r.agent_id : String(req.query.agentId || '').trim();
        // Without a bot or routine there is nothing to estimate: say what to send (the main bot calls this too, and
        // "Bot niet gevonden" told it nothing; live, 12 nov). A bot may be named by its name as well as its id.
        if (!agentId) throw bad('Geef aan voor welke bot of routine je de kosten wilt zien: query agentId (het id of de naam van een bot, zie GET /agents) of routineId (zie GET /routines).');
        const agent = ctx.store.agent(agentId) || ctx.store.agents(u.id).find((a) => !a.archived && a.name.toLowerCase() === agentId.toLowerCase());
        if (!agent || agent.user_id !== u.id) throw notFound('Bot niet gevonden');
        const routine = r ? { id: r.id, providerId: engine.providerOf?.(r, agent) ?? null, important: r.options?.important === true } : null;
        return estimateFor(ctx, s, { agent, routine, important: req.query.important === '1' });
      }),
    );

    // A run is going: its engine is read once a minute. It ended: its engine's numbers changed (read once more, three
    // seconds later, unless the run's own last report covered every window).
    ctx.events.on('run.updated', (e) => s.runChanged(e.data));

    // Forget a deleted provider's limits; a deleted bot's context fill.
    ctx.events.on('provider.deleted', (e) => {
      const id = e.data?.id;
      if (id) ctx.store.exec('DELETE FROM usage_engines WHERE provider_id = ?', id);
    });
    ctx.hooks.agentDeleted.push(({ agentId }) => ctx.store.exec('DELETE FROM usage_context WHERE agent_id = ?', agentId));

    // A bot's own usage cap (spend or tokens per day or week; cap.ts): checked before every model call on any engine.
    (ctx.hooks.beforeAnyModelCall ??= []).push(botCapCheck(ctx));
    /** The cap of one bot as it is now (bot editor › Gebruikslimiet): what it may use, what it used, when it resets. */
    ctx.api.get(
      '/usage/bots/:id/cap',
      ah(async (req) => {
        const u = user(req);
        const a = ctx.store.agent(String(req.params.id));
        if (!a || a.user_id !== u.id) throw notFound('Bot niet gevonden');
        return capStatus(ctx, a);
      }),
    );
  },
  start() {
    svc?.resumeTimers();
  },
  stop() {
    svc?.stop();
  },
};

export default mod;
