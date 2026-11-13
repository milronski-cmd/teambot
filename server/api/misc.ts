import path from 'node:path';
import type { Ctx } from '../core/types.js';
import { ah, bad, requireRole, str, user } from '../core/http.js';
import { agentTemplate, pickAgent } from './agents.js';
import { assertPublicUrl, lastSearch, SEARCH_CHOICES, SEARCH_KEY_SECRET, searchKey, searchSettings } from '../tools/builtin/web.js';
import { sanitizeAgentForMember } from './member-policy.js';
import { budgetOf, nextDay, spentToday } from '../agent/budget.js';
import { isLanguage } from '../../shared/languages.js';
import { scrubValues } from '../core/secrets.js';
import { SETTINGS, type SettingDef } from '../../shared/settings.js';

/**
 * Settings a member may change for themselves (PUT /settings). What each is in the screens, and the values it takes,
 * is in shared/settings.ts (a bot finds it there through teambot_find).
 */
// (`theme`, `notifications` and `onboarded` were accepted here and read nowhere: notifications have their own
// preferences. Sending them is harmless: unknown keys are skipped. The theme is `ui.theme`.)
export const USER_SETTINGS = new Set(['defaultProvider', 'defaultModel', 'timezone', 'language', 'botLanguage', 'dailyBudgetUsd', 'search', 'voice', 'attachmentSpeech', 'ui', 'closedFolders']);

/**
 * `ui` is merged, not replaced: `{ ui: { botStyle: 'felt' } }` changes the style and keeps the colour, the theme and the
 * rest (a bot sends one field; two devices never undo each other). A field with fixed values (shared/settings.ts) takes
 * only those. A theme that is set (by a bot, or through the API) gets a new `themeAt`, so every device takes it over
 * (ui/src/shell/accentSync.ts); a screen that sends its whole `ui` back with the same `themeAt` changes nothing there.
 */
function mergeUi(prev: unknown, next: unknown): Record<string, unknown> {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw bad('ui moet een object zijn, bijvoorbeeld { "botStyle": "felt" }.');
  const old = prev && typeof prev === 'object' && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...old, ...(next as Record<string, unknown>) };
  for (const [id, d] of Object.entries(SETTINGS as Record<string, SettingDef>)) {
    if (d.call !== 'PUT /settings' || !d.field?.startsWith('ui.') || !d.choices || !(d.field.slice(3) in (next as object))) continue;
    const v = (next as Record<string, unknown>)[d.field.slice(3)];
    if (v !== null && !d.choices.some((c) => c.value === v)) throw bad(`Onbekende waarde voor ${d.title} (${id}): kies uit ${d.choices.map((c) => `${JSON.stringify(c.value)} (${c.label})`).join(', ')}.`);
  }
  const n = next as Record<string, unknown>;
  if (n.theme !== undefined && (n.themeAt === undefined || n.themeAt !== old.themeAt)) out.themeAt = new Date().toISOString();
  return out;
}

export function miscRoutes(ctx: Ctx) {
  const api = ctx.api;

  // ---- approvals / questions inbox ----
  api.get(
    '/approvals',
    ah(async (req) => {
      const u = user(req);
      const status = (req.query.status as string) || 'pending';
      return ctx.store.all<any>(`SELECT * FROM approvals WHERE user_id = ? ${status === 'all' ? '' : 'AND status = ?'} ORDER BY created_at DESC LIMIT 200`, ...(status === 'all' ? [u.id] : [u.id, status])).map((a) => ctx.broker.view(ctx.store.decode('approvals', a)));
    }),
  );
  api.post(
    '/approvals/:id',
    ah(async (req) => {
      const u = user(req);
      const d = req.body?.decision;
      if (!['approve', 'deny', 'always'].includes(d)) throw bad('Ongeldige beslissing');
      try {
        return ctx.broker.resolve(req.params.id as string, u.id, d, req.body?.answer !== undefined ? str(req.body.answer, 20_000) : undefined);
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );

  // ---- runs ----
  api.get('/runs', ah(async (req) => ctx.runs.activeRuns(user(req).id)));
  api.post(
    '/runs/:id/cancel',
    ah(async (req) => {
      const u = user(req);
      const r = ctx.store.run(req.params.id as string);
      if (!r || r.user_id !== u.id) throw bad('Taak niet gevonden');
      return { ok: ctx.runs.cancel(r.id) };
    }),
  );
  api.post('/stop-all', ah(async (req) => ({ stopped: ctx.runs.stopAll(user(req).id) })));

  // ---- settings ----
  /**
   * ONE "Standaardmodel": the default model of the default AI connection (its `config.defaultModel`, the value
   * Instellingen › AI-diensten shows). A model chosen under "Standaarden voor nieuwe bots" is written there, so the two
   * screens can no longer disagree. Only for a connection that is not the user's own (a shared one he may not change)
   * the choice stays his own setting `defaultModel`; a value stored there by an older version keeps working until the
   * next choice.
   */
  const defaultConnection = (userId: string) => {
    const id = ctx.store.getSetting<string | null>(userId, 'defaultProvider', null);
    try {
      return id ? ctx.providers.config(id) : null;
    } catch {
      return null;
    }
  };
  const foldDefaultModel = (userId: string) => {
    const model = ctx.store.getSetting<string>(userId, 'defaultModel', '');
    const cfg = defaultConnection(userId);
    if (!model || typeof model !== 'string' || !cfg || cfg.user_id !== userId) return;
    try {
      if (cfg.config?.defaultModel !== model) ctx.providers.updateConfig(cfg.id, userId, { config: { defaultModel: model } });
      ctx.store.setSetting(userId, 'defaultModel', '');
    } catch {
      /* the connection refused: the user's own value stays and keeps working */
    }
  };
  const settingsView = (userId: string): Record<string, any> => {
    const s = ctx.store.settings(userId);
    return { ...s, defaultModel: s.defaultModel || defaultConnection(userId)?.config?.defaultModel || '' };
  };
  api.get(
    '/settings',
    ah(async (req) => {
      const u = user(req);
      const s = settingsView(u.id);
      return { ...s, timezone: s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone };
    }),
  );
  api.put(
    '/settings',
    ah(async (req) => {
      const u = user(req);
      for (const [k, v] of Object.entries(req.body || {})) {
        if (!USER_SETTINGS.has(k)) continue;
        if (k === 'defaultProvider' && v && !ctx.providers.canUse(u.id, ctx.providers.config(String(v)))) throw bad('Onbekende provider');
        if (k === 'language' && !isLanguage(v)) throw bad('Onbekende taal');
        if (k === 'botLanguage' && v !== 'auto' && !isLanguage(v)) throw bad('Onbekende taal');
        // The user chose the default engine: TeamBot no longer picks it automatically.
        if (k === 'defaultProvider') ctx.store.setSetting(u.id, 'defaultProviderAuto', false);
        if (k === 'closedFolders') {
          // Folders no bot may open, also with "Volledige toegang": full paths only.
          if (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) throw bad('Geef een lijst met volledige paden op.');
          ctx.store.setSetting(u.id, k, [...new Set(v.map((p) => path.resolve(String(p))))].slice(0, 50));
          continue;
        }
        if (k === 'search' && v) {
          // Never let a member point at someone else's secret (secretOwner is admin-only, via /admin/settings).
          const s = v as any;
          const prev = ctx.store.getSetting<any>(u.id, 'search', null) || {};
          const provider = s.provider ?? searchSettings(ctx, u.id).choice;
          if (!(SEARCH_CHOICES as readonly string[]).includes(provider)) throw bad('Onbekende zoekdienst');
          const url = s.url === undefined ? prev.url : s.url ? str(s.url, 500) : undefined;
          // On a shared server a member may not point the server at internal addresses (SSRF).
          if (url && ctx.config.mode === 'server' && u.role === 'member') await assertPublicUrl(String(url)).catch((e: any) => { throw bad(e.message); });
          // Before 0.4.5 one key (Brave or Tavily) had a free name; it moves to the fixed name of its service once.
          const legacy = prev.v !== 2 && prev.secretName && (SEARCH_KEY_SECRET as Record<string, string>)[prev.provider];
          if (legacy && !ctx.secrets.getByName(u.id, legacy)) {
            const old = ctx.secrets.getByName(u.id, String(prev.secretName));
            if (old) ctx.secrets.set(u.id, legacy, old);
          }
          ctx.store.setSetting(u.id, k, { v: 2, provider, url, jinaReader: s.jinaReader === undefined ? prev.jinaReader === true : s.jinaReader === true });
          continue;
        }
        if (k === 'ui') {
          ctx.store.setSetting(u.id, k, mergeUi(ctx.store.getSetting(u.id, 'ui', null), v));
          continue;
        }
        ctx.store.setSetting(u.id, k, v);
      }
      foldDefaultModel(u.id);
      ctx.events.emit(u.id, 'settings.updated', settingsView(u.id));
      return settingsView(u.id);
    }),
  );
  // Instellingen › Zoeken: the chosen source as TeamBot reads it, which own keys exist (yes/no, never the key) and which
  // source answered the last search.
  api.get(
    '/web-search/status',
    ah(async (req) => {
      const u = user(req);
      const s = searchSettings(ctx, u.id);
      const keys = Object.fromEntries((Object.keys(SEARCH_KEY_SECRET) as (keyof typeof SEARCH_KEY_SECRET)[]).map((p) => [p, !!searchKey(ctx, s, p)]));
      return { choice: s.choice, url: s.url || null, jinaReader: s.jinaReader, keys, last: lastSearch(u.id) };
    }),
  );
  api.get(
    '/admin/settings',
    ah(async (req) => {
      requireRole(req, 'admin');
      return ctx.store.settings('');
    }),
  );
  api.put(
    '/admin/settings',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      // publisherPolicy: managed (validated + audited) via /skills/publishers; raw writes only by the owner.
      const OWNER_ONLY = new Set(['memberPolicy', 'mcpMembersMayRunLocal', 'search', 'publisherPolicy']);
      for (const [k, v] of Object.entries(req.body || {})) {
        if (OWNER_ONLY.has(k) && me.role !== 'owner') throw bad(`Alleen de eigenaar kan “${k}” wijzigen`);
        ctx.store.setSetting('', k, v);
      }
      return ctx.store.settings('');
    }),
  );

  // ---- secrets (names only; values never leave the server) ----
  api.get('/secrets', ah(async (req) => ctx.secrets.list(user(req).id).filter((s) => !s.name.startsWith('provider:'))));
  api.put(
    '/secrets/:name',
    ah(async (req) => {
      const u = user(req);
      const name = str(req.params.name, 120);
      if (!/^[\w.:-]+$/.test(name) || name.startsWith('provider:')) throw bad('Ongeldige naam');
      const value = str(req.body?.value, 20_000);
      if (!value) throw bad('Lege waarde');
      ctx.secrets.set(u.id, name, value);
      ctx.audit(u.id, 'secret.set', { name });
      return { ok: true };
    }),
  );
  api.delete(
    '/secrets/:name',
    ah(async (req) => {
      const u = user(req);
      const row = ctx.secrets.list(u.id).find((s) => s.name === req.params.name);
      if (row) ctx.secrets.delete(row.id);
      ctx.audit(u.id, 'secret.deleted', { name: req.params.name });
      return { ok: true };
    }),
  );

  // ---- tools catalog for the UI ----
  api.get(
    '/tools',
    ah(async () => ({
      groups: [...ctx.tools.groups.values()],
      tools: ctx.tools.list().map((t) => ({ name: t.name, group: t.group, risk: t.risk, description: t.description })),
    })),
  );

  // ---- usage / cost ----
  api.get(
    '/usage',
    ah(async (req) => {
      const u = user(req);
      const days = Math.min(365, Number(req.query.days) || 30);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const byDay = ctx.store.all('SELECT substr(created_at,1,10) AS day, SUM(input) AS input, SUM(output) AS output, SUM(cost) AS cost FROM usage_log WHERE user_id = ? AND created_at >= ? GROUP BY day ORDER BY day', u.id, since);
      const byModel = ctx.store.all('SELECT model, provider_id, SUM(input) AS input, SUM(output) AS output, SUM(cost) AS cost, COUNT(*) AS calls FROM usage_log WHERE user_id = ? AND created_at >= ? GROUP BY model, provider_id ORDER BY cost DESC', u.id, since);
      const byAgent = ctx.store.all('SELECT l.agent_id, a.name, SUM(l.input) AS input, SUM(l.output) AS output, SUM(l.cost) AS cost FROM usage_log l LEFT JOIN agents a ON a.id = l.agent_id WHERE l.user_id = ? AND l.created_at >= ? GROUP BY l.agent_id ORDER BY cost DESC', u.id, since);
      // today: what counts against the daily budget right now (the same sum the runner checks, agent/budget.ts) and the
      // budget that applies, so the page can say honestly when a step went past it.
      const { limit, byAdmin } = budgetOf(ctx, u.id);
      const today = { spent: spentToday(ctx, u.id), limit, byAdmin, resetAt: nextDay().toISOString() };
      return { days, byDay, byModel, byAgent, dailyBudgetUsd: ctx.store.getSetting(u.id, 'dailyBudgetUsd', 0), today };
    }),
  );

  // ---- audit trail ----
  api.get(
    '/audit',
    ah(async (req) => {
      const u = user(req);
      const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
      const agentId = (req.query.agentId as string) || null;
      // Pages of up to 500 rows (default 200); `before` = the smallest id of the previous page.
      const limit = Math.min(500, Math.max(1, Math.floor(Number(req.query.limit)) || 200));
      // agent_name: the bot's current name, so the log can say who did it in words (null when the bot was deleted).
      const rows = ctx.store.all<any>(
        `SELECT au.*, ag.name AS agent_name FROM audit au LEFT JOIN agents ag ON ag.id = au.agent_id AND ag.user_id = au.user_id WHERE au.user_id = ? AND au.id < ? ${agentId ? 'AND au.agent_id = ?' : ''} ORDER BY au.id DESC LIMIT ${limit}`,
        ...(agentId ? [u.id, before, agentId] : [u.id, before]),
      );
      return rows.map((r) => ({ ...r, data: JSON.parse(r.data || '{}') }));
    }),
  );

  // ---- full export / import of the user's own data ----
  api.get(
    '/export',
    ah(async (req, res) => {
      const u = user(req);
      const agents = ctx.store.agents(u.id, { archived: true });
      const threads = ctx.store.threads(u.id, { archived: true, limit: 100_000 });
      const out: any = {
        format: 'teambot.export/v1',
        exported_at: new Date().toISOString(),
        user: u,
        settings: ctx.store.settings(u.id),
        // Custom request headers of a connection can hold a key: names only, never their values.
        providers: ctx.providers.list(u.id).filter((p) => p.user_id === u.id).map((p) => ({ ...p, secret_id: undefined, config: p.config?.headers && typeof p.config.headers === 'object' ? { ...p.config, headers: Object.fromEntries(Object.keys(p.config.headers).map((k) => [k, '[verborgen]'])) } : p.config })),
        agents,
        threads: threads.map((t) => ({ ...t, messages: ctx.store.messages(t.id, { limit: 1_000_000 }).map((m) => ({ ...m, parts: { ...m.parts, raw: undefined } })) })),
        modules: {} as Record<string, any>,
      };
      for (const svc of Object.values(ctx.services)) if (svc && typeof svc.exportUser === 'function') Object.assign(out.modules, await svc.exportUser(u.id));
      res.setHeader('content-disposition', `attachment; filename="teambot-export-${new Date().toISOString().slice(0, 10)}.json"`);
      // Last safety net: none of this user's stored secret values (keys, tokens, passwords) ends up in the file, also
      // not when a module or a message happens to contain one.
      res.type('json').send(scrubValues(JSON.stringify(out), ctx.secrets.valuesOf(u.id).flatMap((v) => [v, JSON.stringify(v).slice(1, -1)])));
    }),
  );

  api.post(
    '/import/agents',
    ah(async (req) => {
      const u = user(req);
      const list = Array.isArray(req.body?.agents) ? req.body.agents : [];
      const created = list.slice(0, 200).map((a: any) => ctx.store.createAgent(u.id, sanitizeAgentForMember(ctx, u, pickAgent(a.format ? a : agentTemplate(a)))));
      for (const a of created) ctx.events.emit(u.id, 'agent.updated', a);
      return { created: created.length };
    }),
  );

  // ---- system ----
  api.get(
    '/system',
    ah(async (req) => {
      const u = user(req);
      const isAdmin = u.role !== 'member';
      return {
        app: ctx.config.appName,
        version: ctx.config.version,
        mode: ctx.config.mode,
        platform: process.platform,
        node: process.versions.node,
        modules: ctx.modules.map((m) => ({ id: m.id, label: m.label || m.id })),
        dataDir: isAdmin ? ctx.config.dataDir : undefined,
        port: ctx.config.port,
        host: isAdmin ? ctx.config.host : undefined,
        publicUrl: ctx.config.publicUrl || null,
        lanUrls: isAdmin ? lanUrls(ctx.config.port) : undefined,
        stats: {
          agents: ctx.store.one<any>('SELECT COUNT(*) n FROM agents WHERE user_id = ?', u.id)?.n,
          threads: ctx.store.one<any>('SELECT COUNT(*) n FROM threads WHERE user_id = ?', u.id)?.n,
          activeRuns: ctx.runs.activeRuns(u.id).length,
        },
      };
    }),
  );
}

import os from 'node:os';
export function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${port}`);
  return out;
}
