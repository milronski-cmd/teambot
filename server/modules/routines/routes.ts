import express from 'express';
import type { Request } from 'express';
import type { Ctx } from '../../core/types.js';
import { ah, bad, HttpError, notFound, str, user } from '../../core/http.js';
import { HttpishError, RoutineEngine } from './engine.js';
import * as S from './schedule.js';
import * as T from './triggers.js';
import { checkPresetSecret, WEBHOOK_PRESETS } from './triggers.js';
import { DEFAULT_OPTIONS, type Routine, type RoutineRun, type Trigger } from './schema.js';

const MAX_RAW = 1_048_576;

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e: any) {
    if (e instanceof HttpishError) throw new HttpError(e.status, e.message);
    throw e;
  }
}
async function wrapAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e instanceof HttpishError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

export function baseUrl(ctx: Ctx, req: Request): string {
  if (ctx.config.publicUrl) return ctx.config.publicUrl.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** History filter: "done" = geslaagd (with a result), "no_result" = klaar gemeld zonder resultaat, else the status. */
function statusFilter(status: string): { sql: string; args: any[] } {
  if (!status) return { sql: '', args: [] };
  if (status === 'no_result') return { sql: " AND status = 'done' AND json_extract(meta, '$.proof.result') = 'none'", args: [] };
  if (status === 'done') return { sql: " AND status = 'done' AND COALESCE(json_extract(meta, '$.proof.result'), '') != 'none'", args: [] };
  return { sql: ' AND status = ?', args: [status] };
}

export function routineRoutes(ctx: Ctx, engine: RoutineEngine) {
  const api = ctx.api;
  /**
   * The team the owner looks at (`?teamId=`, the team switcher; package B4): one of his teams, or '' for all teams.
   * Every overview below filters on it; the owner always sees every team without it.
   */
  const teamOf = (req: Request): string => {
    const id = str(req.query.teamId, 60);
    if (!id) return '';
    if (ctx.services.teams?.team?.(id)?.user_id !== user(req).id) throw notFound('Team niet gevonden');
    return id;
  };

  const ownRoutine = (req: Request, id: string): Routine => {
    const r = engine.routine(id);
    if (!r || r.user_id !== user(req).id) throw notFound('Routine niet gevonden');
    return r;
  };
  const ownRun = (req: Request, id: string): RoutineRun => {
    const rr = engine.getRun(id);
    if (!rr || rr.user_id !== user(req).id) throw notFound('Run niet gevonden');
    return rr;
  };
  const ownTrigger = (req: Request, id: string): { t: Trigger; r: Routine } => {
    const t = engine.trigger(id);
    if (!t || t.user_id !== user(req).id) throw notFound('Trigger niet gevonden');
    const r = engine.routine(t.routine_id);
    if (!r || r.user_id !== t.user_id) throw notFound('Trigger niet gevonden');
    return { t, r };
  };

  // ---- meta / settings / preview (before /routines/:id) ----
  api.get(
    '/routines/meta',
    ah(async (req) => {
      const u = user(req);
      const base = baseUrl(ctx, req);
      let host = '';
      try {
        host = new URL(base).hostname;
      } catch {
        /* ignore */
      }
      const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
      return {
        mode: ctx.config.mode,
        startedAt: engine.startedAt,
        lastTickAt: engine.lastTickAt,
        timezone: engine.userTz(u.id),
        timezones: typeof (Intl as any).supportedValuesOf === 'function' ? (Intl as any).supportedValuesOf('timeZone') : [S.DEFAULT_TZ],
        emailAvailable: engine.emailAvailable,
        chatAvailable: engine.chatAvailable,
        webhookBase: `${base}/api/public/hooks/`,
        webhookReachable: !local,
        publicUrl: ctx.config.publicUrl || null,
        presets: WEBHOOK_PRESETS,
        defaults: DEFAULT_OPTIONS,
        graceMinutes: Math.round(engine.graceMs / 60_000),
        global: engine.globalSettings(u.id),
      };
    }),
  );

  api.get('/routines/settings', ah(async (req) => engine.globalSettings(user(req).id)));
  // Calendar (week/month): planned runs and the runs that happened, between from and to (max 62 days).
  api.get(
    '/routines/calendar',
    ah(async (req) => {
      const from = Date.parse(str(req.query.from, 40));
      const to = Date.parse(str(req.query.to, 40));
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw bad('Geef from en to als datum (ISO)');
      return engine.calendar(user(req).id, from, to, teamOf(req));
    }),
  );
  // The one list of what starts by itself, and when: routines, reminders, wait points, vaste taken, workflows, work
  // that lies ready, the main bot's own messages and learning rounds (planner.ts).
  api.get('/routines/planned', ah(async (req) => ({ planned: await engine.planned(user(req).id) })));
  api.put('/routines/settings', ah(async (req) => engine.setGlobalSettings(user(req).id, req.body || {})));

  api.post(
    '/routines/preview',
    ah(async (req) => {
      const u = user(req);
      const tz = str(req.body?.timezone, 64) || engine.userTz(u.id);
      try {
        const s = S.normalizeSchedule(req.body?.schedule, tz, engine.now());
        const next = S.nextRuns(s, tz, engine.now(), 5);
        return { ok: true, schedule: s, text: S.describeSchedule(s, tz), next: next.map((ms) => ({ at: new Date(ms).toISOString(), text: S.formatLocal(ms, tz, true) })), runsPerDay: S.runsPerDay(s, tz, engine.now()) };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }),
  );

  /** Try a chat-message trigger's text match on an example sentence (same rules and limits as for real messages). */
  api.post(
    '/routines/chat-match',
    ah(async (req) => {
      const match = ['any', 'contains', 'starts_with', 'regex'].includes(req.body?.match) ? req.body.match : 'contains';
      const text = str(req.body?.text, T.CHAT_PATTERN_MAX);
      const sample = str(req.body?.sample, 500);
      if (match === 'regex') {
        const why = T.checkChatPattern(text);
        if (why) return { ok: false, error: why };
      }
      const hit = T.chatTextMatches({ match, text }, sample);
      return hit === 'timeout' ? { ok: false, error: 'Dit patroon doet er te lang over; maak het eenvoudiger' } : { ok: true, matches: hit };
    }),
  );

  /** Chat-app conversations a routine result can be sent to ("Stuur resultaat naar"). */
  api.get(
    '/routines/channel-targets',
    ah(async (req) => {
      const u = user(req);
      const ch = ctx.services.channels;
      if (typeof ch?.bindings !== 'function') return { available: false, bindings: [] };
      const m = ch.manager;
      // `?agentId=`: only channels of that bot's team (a routine sends only within its team; package B4).
      const agentId = str(req.query.agentId, 64);
      const bot = agentId ? ctx.store.agent(agentId) : null;
      if (agentId && (!bot || bot.user_id !== u.id)) throw notFound('Bot niet gevonden');
      const home = bot ? ctx.services.teams?.teamOf?.(bot.id) : null;
      const multi = !!ctx.services.teams?.multi?.(u.id);
      return {
        available: true,
        bindings: (ch.bindings(u.id) as any[]).filter((b) => !home || !multi || !b.team_id || b.team_id === home).map((b) => ({
          id: b.id,
          name: b.name,
          adapter: b.adapter,
          enabled: b.enabled,
          teamId: b.team_id ?? null,
          conversations: (typeof m?.conversations === 'function' ? m.conversations(b.id) : []).slice(0, 50).map((c: any) => ({ id: c.id, title: c.title, private: !!c.is_private })),
        })),
      };
    }),
  );

  // ---- what did not happen (before /routines/:id) ----
  /** "Gemist terwijl je pc uit stond": per period without TeamBot (or asleep) the routines that missed runs. */
  api.get(
    '/routines/missed',
    ah(async (req) => {
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
      return engine.watch.missedList(user(req).id, engine.now() - days * 86_400_000, engine.teamRoutineIds(user(req).id, teamOf(req)));
    }),
  );
  api.post(
    '/routines/missed/seen',
    ah(async (req) => {
      const at = new Date(engine.now()).toISOString();
      ctx.store.setSetting(user(req).id, 'routines.missedSeenAt', at);
      return { seenAt: at };
    }),
  );
  /**
   * "Wat niet gebeurde": recent runs that did not deliver — not run (watchdog), missed while off, failed, without a
   * result, skipped, stopped by a limit or a restart — newest first, with the moment the owner last looked.
   */
  api.get(
    '/routines/attention',
    ah(async (req) => {
      const u = user(req);
      const hours = Math.min(24 * 31, Math.max(1, Number(req.query.hours) || 72));
      const since = new Date(engine.now() - hours * 3_600_000).toISOString();
      const names = new Map(engine.routinesOf(u.id).map((r) => [r.id, r]));
      const only = engine.teamRoutineIds(u.id, teamOf(req));
      const rows = ctx.store
        .all<any>(
          "SELECT * FROM routine_runs WHERE user_id = ? AND created_at >= ? AND (status IN ('missed','error','limited','interrupted','skipped') OR (status = 'done' AND json_extract(meta, '$.proof.result') = 'none')) ORDER BY created_at DESC LIMIT 400",
          u.id,
          since,
        )
        .filter((x) => !only || only.has(x.routine_id))
        .slice(0, 100);
      const items = rows.map((x) => {
        const rr = ctx.store.decode<RoutineRun>('routine_runs', x);
        const r = names.get(rr.routine_id);
        const kind = rr.meta?.notRun ? 'not_run' : rr.status === 'done' ? 'no_result' : rr.status;
        const text = kind === 'no_result' ? rr.meta?.proof?.reason || 'Zonder resultaat' : rr.status === 'error' ? engine.runView(rr).error || 'Mislukt' : rr.summary || rr.error || '';
        return { id: rr.id, routineId: rr.routine_id, name: r?.name || 'Verwijderde routine', timezone: r?.timezone || engine.userTz(u.id), kind, status: rr.status, text: String(text).slice(0, 300), at: rr.scheduled_for || rr.created_at, created_at: rr.created_at, threadId: rr.thread_id };
      });
      return { since, items, seenAt: ctx.store.getSetting<string | null>(u.id, 'routines.attentionSeenAt', null) };
    }),
  );
  api.post(
    '/routines/attention/seen',
    ah(async (req) => {
      const at = new Date(engine.now()).toISOString();
      ctx.store.setSetting(user(req).id, 'routines.attentionSeenAt', at);
      return { seenAt: at };
    }),
  );

  // ---- runs (before /routines/:id) ----
  /** Status counts of all routine runs in the last `hours` (default 24) and the runs waiting for a limit reset. */
  api.get(
    '/routines/runs/summary',
    ah(async (req) => {
      const hours = Math.min(24 * 31, Math.max(1, Number(req.query.hours) || 24));
      return engine.summary(user(req).id, engine.now() - hours * 3_600_000, teamOf(req));
    }),
  );
  api.get(
    '/routines/runs/:id',
    ah(async (req) => {
      const rr = ownRun(req, req.params.id as string);
      return { ...engine.runView(rr, true), routineName: engine.routine(rr.routine_id)?.name };
    }),
  );
  api.post(
    '/routines/runs/:id/cancel',
    ah(async (req) => {
      const rr = ownRun(req, req.params.id as string);
      ctx.audit(rr.user_id, 'routine.run.cancelled', { run: rr.id, routine: rr.routine_id });
      return engine.runView(wrap(() => engine.cancelRun(rr)));
    }),
  );
  api.get(
    '/routines/runs',
    ah(async (req) => {
      const u = user(req);
      const limit = Math.min(200, Number(req.query.limit) || 50);
      const before = str(req.query.before, 40) || '9999';
      const status = str(req.query.status, 20);
      const f = statusFilter(status);
      const only = engine.teamRoutineIds(u.id, teamOf(req));
      const tf = only ? (only.size ? ` AND routine_id IN (${[...only].map(() => '?').join(',')})` : ' AND 0') : '';
      const rows = ctx.store.all(`SELECT * FROM routine_runs WHERE user_id = ? AND created_at < ?${f.sql}${tf} ORDER BY created_at DESC LIMIT ?`, u.id, before, ...f.args, ...(only ? [...only] : []), limit);
      const names = new Map(engine.routinesOf(u.id).map((r) => [r.id, r.name]));
      return rows.map((x) => {
        const rr = engine.runView(ctx.store.decode('routine_runs', x));
        return { ...rr, routineName: names.get(rr.routine_id) || '' };
      });
    }),
  );

  // ---- triggers (before /routines/:id) ----
  api.get(
    '/routines/triggers/:id',
    ah(async (req) => {
      const { t } = ownTrigger(req, req.params.id as string);
      return engine.triggerView(t, baseUrl(ctx, req));
    }),
  );
  api.patch(
    '/routines/triggers/:id',
    ah(async (req) => {
      const { t, r } = ownTrigger(req, req.params.id as string);
      const v = await wrapAsync(() => engine.validateTriggerInput(r, req.body || {}, t));
      return engine.triggerView(engine.updateTrigger(t, v), baseUrl(ctx, req));
    }),
  );
  api.delete(
    '/routines/triggers/:id',
    ah(async (req) => {
      const { t } = ownTrigger(req, req.params.id as string);
      engine.deleteTrigger(t);
      return { ok: true };
    }),
  );
  api.post(
    '/routines/triggers/:id/rotate',
    ah(async (req) => {
      const { t } = ownTrigger(req, req.params.id as string);
      if (t.kind !== 'webhook') throw bad('Alleen webhooks hebben een geheim');
      const preset = WEBHOOK_PRESETS.find((p) => p.id === t.preset);
      if (!preset?.generatesSecret) throw bad('Dit geheim komt van de externe dienst; plak het nieuwe geheim via “Geheim instellen”.');
      const secret = RoutineEngine.generateSecret();
      // Default: the old secret is invalid immediately; a short overlap only when the owner chooses one.
      engine.setSecret(t, secret, Number(req.body?.graceMinutes ?? 0) || 0);
      // Shown once, right after generation, so it can be pasted into the external service.
      return { secret, trigger: engine.triggerView(engine.trigger(t.id)!, baseUrl(ctx, req)) };
    }),
  );
  api.put(
    '/routines/triggers/:id/secret',
    ah(async (req) => {
      const { t } = ownTrigger(req, req.params.id as string);
      if (t.kind !== 'webhook') throw bad('Alleen webhooks hebben een geheim');
      const value = str(req.body?.value, 500).trim();
      if (value.length < 8) throw bad('Het geheim is te kort (minimaal 8 tekens)');
      const wrong = checkPresetSecret(t.preset, value);
      if (wrong) throw bad(wrong);
      engine.setSecret(t, value, Number(req.body?.graceMinutes ?? 0) || 0);
      return engine.triggerView(engine.trigger(t.id)!, baseUrl(ctx, req));
    }),
  );
  api.post(
    '/routines/triggers/:id/revoke-previous',
    ah(async (req) => {
      const { t } = ownTrigger(req, req.params.id as string);
      if (t.kind !== 'webhook') throw bad('Alleen webhooks hebben een geheim');
      engine.revokePreviousSecret(t);
      return engine.triggerView(engine.trigger(t.id)!, baseUrl(ctx, req));
    }),
  );
  api.post(
    '/routines/triggers/:id/test',
    ah(async (req) => {
      const { t, r } = ownTrigger(req, req.params.id as string);
      if (t.kind === 'webhook') {
        const out = await wrapAsync(() => engine.testWebhook(t, str(req.body?.payload, 200_000)));
        return { status: out.status, result: out.body };
      }
      const out = await engine.poll(t, r);
      return { status: 200, result: out };
    }),
  );
  api.get(
    '/routines/triggers/:id/events',
    ah(async (req) => {
      const { t } = ownTrigger(req, req.params.id as string);
      const limit = Math.min(200, Number(req.query.limit) || 50);
      return ctx.store.all('SELECT * FROM routine_events WHERE trigger_id = ? ORDER BY created_at DESC LIMIT ?', t.id, limit).map((x) => ctx.store.decode('routine_events', x));
    }),
  );

  // ---- routines ----
  api.get(
    '/routines',
    ah(async (req) => {
      const u = user(req);
      const agentId = str(req.query.agentId, 64) || undefined;
      const team = teamOf(req);
      return engine.routinesOf(u.id, agentId).filter((r) => engine.inTeam(r, team)).map((r) => engine.view(r));
    }),
  );

  api.post(
    '/routines',
    ah(async (req) => {
      const u = user(req);
      return engine.view(wrap(() => engine.create(u.id, req.body || {})));
    }),
  );

  api.get(
    '/routines/:id',
    ah(async (req) => {
      const r = ownRoutine(req, req.params.id as string);
      return { ...engine.view(r), triggers: engine.triggersOf(r.id).map((t) => engine.triggerView(t, baseUrl(ctx, req))) };
    }),
  );

  api.patch(
    '/routines/:id',
    ah(async (req) => {
      const r = ownRoutine(req, req.params.id as string);
      return engine.view(wrap(() => engine.update(r, req.body || {})));
    }),
  );

  api.delete(
    '/routines/:id',
    ah(async (req) => {
      const r = ownRoutine(req, req.params.id as string);
      engine.remove(r, { deleteThread: req.query.deleteThread === '1' });
      return { ok: true };
    }),
  );

  api.post('/routines/:id/duplicate', ah(async (req) => engine.view(wrap(() => engine.duplicate(ownRoutine(req, req.params.id as string))))));
  api.post(
    '/routines/:id/pause',
    ah(async (req) => {
      const r = ownRoutine(req, req.params.id as string);
      // Who paused it, as the page shows it: the person himself, or a bot that did it in the chat (its tools call this
      // route inside the app, teams/inner.ts; my_routines names the bot).
      const bot = (req as any).session?.id === 'bot';
      return engine.view(wrap(() => engine.setStatus(r, 'paused', bot ? `Gepauzeerd door ${str(req.body?.by, 80) || 'een bot'}` : 'Gepauzeerd door gebruiker')));
    }),
  );
  api.post(
    '/routines/:id/resume',
    ah(async (req) => {
      const r = ownRoutine(req, req.params.id as string);
      return engine.view(wrap(() => engine.setStatus(r, 'active')));
    }),
  );
  /** Confirm a draft proposed by a bot (routine_create without approval). */
  api.post(
    '/routines/:id/confirm',
    ah(async (req) => {
      const r = ownRoutine(req, req.params.id as string);
      if (r.status !== 'draft') throw bad('Deze routine is geen concept');
      ctx.audit(r.user_id, 'routine.confirmed', { id: r.id }, r.agent_id);
      return engine.view(wrap(() => engine.setStatus(r, 'active')));
    }),
  );
  /** "Nu testen": run once now, outside the schedule. */
  api.post(
    '/routines/:id/run',
    ah(async (req) => {
      const r = ownRoutine(req, req.params.id as string);
      const rr = wrap(() => engine.manualRun(r, req.body?.test === false ? 'manual' : 'test'));
      ctx.audit(r.user_id, 'routine.run.manual', { id: r.id, run: rr.id }, r.agent_id);
      return engine.runView(rr);
    }),
  );
  /** "Start na de reset om …" (P3): one run at a later moment (the reset the estimate gave). Body { at: epoch ms | ISO }. */
  api.post(
    '/routines/:id/run-after',
    ah(async (req) => {
      const r = ownRoutine(req, req.params.id as string);
      const raw = req.body?.at;
      const at = typeof raw === 'number' ? raw : Date.parse(String(raw || ''));
      const rr = wrap(() => engine.runAt(r, at));
      ctx.audit(r.user_id, 'routine.run.after', { id: r.id, run: rr.id, at: new Date(at).toISOString() }, r.agent_id);
      return engine.runView(rr);
    }),
  );
  api.get(
    '/routines/:id/runs',
    ah(async (req) => {
      const r = ownRoutine(req, req.params.id as string);
      const limit = Math.min(200, Number(req.query.limit) || 50);
      const before = str(req.query.before, 40) || '9999';
      const status = str(req.query.status, 20);
      const f = statusFilter(status);
      const rows = ctx.store.all(`SELECT * FROM routine_runs WHERE routine_id = ? AND created_at < ?${f.sql} ORDER BY created_at DESC LIMIT ?`, r.id, before, ...f.args, limit);
      return rows.map((x) => engine.runView(ctx.store.decode('routine_runs', x)));
    }),
  );
  api.get('/routines/:id/triggers', ah(async (req) => engine.triggersOf(ownRoutine(req, req.params.id as string).id).map((t) => engine.triggerView(t, baseUrl(ctx, req)))));
  api.post(
    '/routines/:id/triggers',
    ah(async (req) => {
      const r = ownRoutine(req, req.params.id as string);
      const v = await wrapAsync(() => engine.validateTriggerInput(r, req.body || {}, null));
      // A pasted secret is checked before anything is made (no half-made trigger without its secret).
      const pasted = v.kind === 'webhook' && req.body?.secret ? str(req.body.secret, 500).trim() : '';
      if (pasted && pasted.length < 8) throw bad('Het geheim is te kort (minimaal 8 tekens)');
      const wrong = pasted ? checkPresetSecret(v.preset, pasted) : null;
      if (wrong) throw bad(wrong);
      const { trigger, secret } = wrap(() => engine.createTrigger(r, v));
      let custom = false;
      if (trigger.kind === 'webhook' && !secret && pasted) {
        engine.setSecret(trigger, pasted);
        custom = true;
      }
      return { trigger: engine.triggerView(engine.trigger(trigger.id)!, baseUrl(ctx, req)), secret: custom ? undefined : secret };
    }),
  );

  // ---- public webhook endpoint (raw body; the JSON parser is off under /api/public/hooks) ----
  ctx.publicApi.post(
    '/hooks/:id',
    (req, res, next) => {
      // Leave other modules' hook paths alone.
      if (!String(req.params.id || '').startsWith('trg_')) return next('route');
      if (Number(req.headers['content-length'] || 0) > MAX_RAW) return res.status(413).json({ error: 'Payload te groot' });
      next();
    },
    express.raw({ type: () => true, limit: MAX_RAW }),
    ah(async (req, res) => {
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const out = await engine.handleWebhook(req.params.id as string, raw, req.headers as any, req.query as any);
      for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
      res.status(out.status).json(out.body);
    }),
  );
}
