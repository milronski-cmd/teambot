import fs from 'node:fs';
import type { Ctx } from '../../core/types.js';
import { importSpreadsheet } from './import-file.js';
import { HttpError, ah, bad, user } from '../../core/http.js';
import { type TeamData, TeamDataError } from './service.js';

/**
 * HTTP API for the owner's "Teamwerk" pages and the decision cards under "Wacht op jou". Always the caller's own
 * databases. `?team=<teamId>` picks one team's database; without it, summary and decisions cover every team
 * (`team=all` too) and the other views show the default team.
 */
export function teamdataRoutes(ctx: Ctx, svc: TeamData) {
  const api = ctx.api;
  const wrap = <T>(p: Promise<T>) =>
    p.catch((e) => {
      if (e instanceof TeamDataError) throw bad(e.message);
      if (e instanceof HttpError) throw e;
      throw new HttpError(503, e?.message || String(e));
    });
  const q = (v: any) => (typeof v === 'string' ? v.slice(0, 200) : '');
  const team = (v: any) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
  /** Synchronous checks (an unknown team) as a normal error response too. */
  const run = <T>(fn: () => Promise<T>) => {
    try {
      return wrap(fn());
    } catch (e) {
      return wrap(Promise.reject(e));
    }
  };

  api.get('/teamdata/summary', ah(async (req) => run(() => svc.summary(user(req).id, team(req.query.team)))));
  api.get('/teamdata/tables', ah(async (req) => run(() => svc.tables(user(req).id, team(req.query.team)))));
  api.get(
    '/teamdata/tables/:name',
    ah(async (req) => run(() => svc.tableRows(user(req).id, String(req.params.name), { offset: Number(req.query.offset) || 0, limit: Number(req.query.limit) || 50 }, team(req.query.team)))),
  );
  api.get('/teamdata/audit', ah(async (req) => run(async () => svc.auditLog(user(req).id, Number(req.query.limit) || 100, team(req.query.team)))));

  api.get('/teamdata/decisions', ah(async (req) => run(() => svc.decisions(user(req).id, { status: q(req.query.status), q: q(req.query.q) }, team(req.query.team)))));
  api.post(
    '/teamdata/decisions/:id/answer',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      return run(() => svc.decide(u, Number(req.params.id), { choice: b.choice ?? null, answer: typeof b.answer === 'string' ? b.answer : '', note: typeof b.note === 'string' ? b.note : '', expire: b.expire === true }, team(b.teamId) || team(req.query.team)));
    }),
  );

  api.get('/teamdata/tasks', ah(async (req) => run(() => svc.tasks(user(req).id, team(req.query.team)))));
  api.patch(
    '/teamdata/tasks/:id',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      return run(async () => {
        // "12" (with ?team= or the default team) or "<teamId>:12" (the quality module's own name for it).
        const t = svc.parseTaskRef(u.id, String(req.params.id), team(b.teamId) || team(req.query.team));
        if (!t) throw bad('Ongeldige taak');
        // "klaar_als" (Klaar als) and/or the status; at least one of them.
        let row: any = null;
        if (typeof b.klaar_als === 'string' || typeof b.doneWhen === 'string') row = await svc.setTaskDoneWhen(u, t.id, String(b.klaar_als ?? b.doneWhen), t.teamId);
        if (b.status !== undefined || !row) row = await svc.setTaskStatus(u, t.id, String(b.status || ''), t.teamId);
        return row;
      });
    }),
  );
  // Not done yet: back to "bezig", and the bot that reported it hears why in its own chat.
  api.post(
    '/teamdata/tasks/:id/reopen',
    ah(async (req) => {
      const u = user(req);
      return run(async () => {
        const t = svc.parseTaskRef(u.id, String(req.params.id), team(req.body?.teamId) || team(req.query.team));
        if (!t) throw bad('Ongeldige taak');
        const q = ctx.services.quality;
        const before = q?.view?.(u.id, 'teamdata', t.ref);
        const row = await svc.setTaskStatus(u, t.id, 'bezig', t.teamId);
        q?.reopen?.(u.id, 'teamdata', t.ref);
        const worker = q?.workerOf?.(u.id, 'teamdata', t.ref);
        let told: any = null;
        if (worker && q?.tellBot) {
          const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000).trim() : '';
          const why = note || before?.check?.reason || '';
          told = await q.tellBot(u, worker, `Taak #${t.id} (“${String(row?.titel || '')}”) in de teamdatabase is nog niet klaar.${why ? ` ${why}` : ''}\n\nMaak hem af, zet het bewijs in de kolom bewijs en zet de status daarna opnieuw op klaar. Lukt het niet: status kon_niet met de reden in resultaat.`, { kind: 'task_reopened', teamdataTaskId: t.id });
        }
        return { task: row, told };
      });
    }),
  );

  api.get(
    '/teamdata/log',
    ah(async (req) =>
      run(() => svc.log(user(req).id, { q: q(req.query.q), agent: q(req.query.agent), site: q(req.query.site), before: Number(req.query.before) || 0, limit: Number(req.query.limit) || 50 }, team(req.query.team))),
    ),
  );
  api.get(
    '/teamdata/events',
    ah(async (req) =>
      run(() => svc.events(user(req).id, { q: q(req.query.q), soort: q(req.query.soort), verwerkt: q(req.query.verwerkt), before: Number(req.query.before) || 0, limit: Number(req.query.limit) || 50 }, team(req.query.team))),
    ),
  );
  api.get('/teamdata/experiments', ah(async (req) => run(() => svc.experiments(user(req).id, team(req.query.team)))));

  // A CSV or Excel file (an uploaded attachment) into a team table; undone with its source (import-file.ts).
  api.post(
    '/teamdata/import',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const a = ctx.store.get<any>('attachments', String(b.attachmentId || ''));
      if (!a || a.user_id !== u.id || !fs.existsSync(a.path)) throw bad('Bijlage niet gevonden');
      return run(async () => {
        const r = await importSpreadsheet(svc, u.id, a.path, {
          name: a.name,
          table: typeof b.table === 'string' && b.table.trim() ? b.table.slice(0, 60) : undefined,
          sheet: typeof b.sheet === 'string' && b.sheet ? b.sheet.slice(0, 120) : undefined,
          teamId: team(b.teamId),
          actor: { type: 'user', id: u.id, name: u.name },
        });
        ctx.audit(u.id, 'teamdata.import_file', { table: r.table, inserted: r.inserted, created: r.created, source: r.source });
        return r;
      });
    }),
  );
  api.post(
    '/teamdata/import/undo',
    ah(async (req) => {
      const u = user(req);
      const source = String(req.body?.source || '');
      if (!/^bestand:[0-9a-f]{16}$/.test(source)) throw bad('Onbekende import');
      return run(() => svc.undoImport(u.id, source, { teamId: team(req.body?.teamId) }));
    }),
  );
}
