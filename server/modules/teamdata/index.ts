import path from 'node:path';
import fs from 'node:fs';
import type { Module } from '../../core/types.js';
import { SqlWorker } from './worker.js';
import { TeamData } from './service.js';
import { GROUP, teamdataPrompt, teamdataTools } from './tools.js';
import { teamdataRoutes } from './routes.js';
import { ProjectError, ProjectService, projectTools } from './projects.js';
import { KansError, KansService, kansTools } from './kansen.js';
import { ah, bad, user } from '../../core/http.js';

/**
 * Teamdatabase ("Teamwerk"): a SQLite database per team (0.4, package B2) with the standard team tables (taken,
 * beslissingen, gebeurtenissen, logboek, experimenten) plus whatever tables the bots make. Bots use team_tables /
 * team_query / team_execute on their own team's database and may only read another team's with meekijken or
 * aansturen; the owner sees tasks, decisions, the log, events and experiments of every team in the app and answers
 * decisions under "Wacht op jou" (the asking bot is woken with the answer). See docs/modules/teamdata.md.
 */
const mod: Module = {
  id: 'teamdata',
  label: 'Teamdatabase',
  migrations: [
    {
      id: 'teamdata-001',
      sql: `
CREATE TABLE teamdata_tables (
  user_id TEXT NOT NULL, name TEXT NOT NULL, owner_type TEXT NOT NULL DEFAULT 'system', owner_id TEXT, owner_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, PRIMARY KEY (user_id, name)
);
CREATE TABLE teamdata_origins (
  user_id TEXT NOT NULL, tbl TEXT NOT NULL, row_id INTEGER NOT NULL, agent_id TEXT, thread_id TEXT, run_id TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tbl, row_id)
);
CREATE TABLE teamdata_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL DEFAULT '',
  thread_id TEXT, run_id TEXT, verb TEXT NOT NULL DEFAULT '', table_name TEXT, sql TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '[]',
  changes INTEGER, row_id INTEGER, error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX teamdata_audit_user ON teamdata_audit(user_id, id);
`,
    },
    {
      // Rows taken over from another app (OpenBot): source row id → row id here, so a second import adds only new rows.
      id: 'teamdata-002-imports',
      sql: `
CREATE TABLE teamdata_imports (
  user_id TEXT NOT NULL, source TEXT NOT NULL, tbl TEXT NOT NULL, source_id TEXT NOT NULL, row_id INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, source, tbl, source_id)
);
`,
    },
    {
      // 0.4 package B2: a database per team. What TeamBot keeps about a database gets the team id ('' = the owner's
      // original database; filled with the default team as soon as the owner has one, see TeamData.legacyTeam).
      id: 'teamdata-003-teams',
      sql: `
CREATE TABLE teamdata_tables_b2 (
  user_id TEXT NOT NULL, team_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, owner_type TEXT NOT NULL DEFAULT 'system', owner_id TEXT,
  owner_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (user_id, team_id, name)
);
INSERT INTO teamdata_tables_b2 (user_id, team_id, name, owner_type, owner_id, owner_name, created_at)
  SELECT user_id, '', name, owner_type, owner_id, owner_name, created_at FROM teamdata_tables;
DROP TABLE teamdata_tables;
ALTER TABLE teamdata_tables_b2 RENAME TO teamdata_tables;

CREATE TABLE teamdata_origins_b2 (
  user_id TEXT NOT NULL, team_id TEXT NOT NULL DEFAULT '', tbl TEXT NOT NULL, row_id INTEGER NOT NULL, agent_id TEXT, thread_id TEXT, run_id TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY (user_id, team_id, tbl, row_id)
);
INSERT INTO teamdata_origins_b2 (user_id, team_id, tbl, row_id, agent_id, thread_id, run_id, created_at)
  SELECT user_id, '', tbl, row_id, agent_id, thread_id, run_id, created_at FROM teamdata_origins;
DROP TABLE teamdata_origins;
ALTER TABLE teamdata_origins_b2 RENAME TO teamdata_origins;

CREATE TABLE teamdata_imports_b2 (
  user_id TEXT NOT NULL, team_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, tbl TEXT NOT NULL, source_id TEXT NOT NULL, row_id INTEGER,
  created_at TEXT NOT NULL, PRIMARY KEY (user_id, team_id, source, tbl, source_id)
);
INSERT INTO teamdata_imports_b2 (user_id, team_id, source, tbl, source_id, row_id, created_at)
  SELECT user_id, '', source, tbl, source_id, row_id, created_at FROM teamdata_imports;
DROP TABLE teamdata_imports;
ALTER TABLE teamdata_imports_b2 RENAME TO teamdata_imports;

ALTER TABLE teamdata_audit ADD COLUMN team_id TEXT NOT NULL DEFAULT '';
CREATE INDEX teamdata_audit_team ON teamdata_audit(user_id, team_id, id);
`,
    },
    {
      // Tables an import created (so undoImport can drop them again once they are empty).
      id: 'teamdata-004-import-tables',
      sql: `
CREATE TABLE teamdata_import_tables (
  user_id TEXT NOT NULL, team_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, tbl TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, team_id, source, tbl)
);
`,
    },
  ],
  init(ctx) {
    const dir = path.join(ctx.config.dataDir, 'teamdata');
    const worker = new SqlWorker(ctx.log);
    const svc = new TeamData(ctx, worker, dir);
    ctx.services.teamdata = svc;
    // A second look that waited for a usage limit ran later (quality module): passed → the row goes from
    // wacht_op_controle to klaar, as when the check passes right away.
    (ctx.services.qualityRechecked ||= {}).teamdata = async ({ userId, ref, verdict }: { userId: string; ref: string; verdict: { state: string } }) => {
      if (verdict.state !== 'passed' && verdict.state !== 'skipped') return;
      const t = svc.parseTaskRef(userId, ref);
      if (!t) return;
      const [res] = await svc.write(userId, [{ sql: "UPDATE taken SET status = 'klaar', bijgewerkt = datetime('now','localtime') WHERE id = ? AND status = 'wacht_op_controle'", params: [t.id] }], t.teamId);
      if (res?.changes) ctx.events.emit(userId, 'teamdata.changed', { tables: ['taken'], by: 'TeamBot', teamId: t.teamId });
    };
    for (const t of teamdataTools(svc)) ctx.tools.register(t);
    // A bot that may look into another team gets the reading tools with a `team` parameter (same names, so they take
    // the place of the plain ones); with one team, or without access, nothing about teams shows in its tools.
    const withTeam = teamdataTools(svc, { teamParam: true }).filter((t) => t.name !== 'team_execute' && t.name !== 'team_import_file');
    ctx.tools.addProvider((agent) => (svc.otherReadable(agent.id).length ? withTeam : []));
    // How the team database works: in the prompt while its tools are listed, otherwise with what tools_find finds
    // (tools/selection.ts), so a bot that never touches the tables does not carry it in every step.
    ctx.tools.addGuide({
      parts: [GROUP],
      text: ({ agent }) => {
        if (agent.access_mode === 'chat' || !ctx.tools.groupEnabled(agent, GROUP)) return null;
        // Only name what this bot may really use (readonly bots get no team_execute).
        const exec = ctx.tools.get('team_execute');
        const canWrite = !!exec && ctx.broker.decide(agent, exec) !== 'deny';
        return teamdataPrompt(agent, ctx.store.user(agent.user_id)?.name || '', canWrite, svc.otherReadable(agent.id));
      },
    });
    teamdataRoutes(ctx, svc);

    // The project loop and the kansenbord live in the team database too (tables projecten and kansen).
    const projects = new ProjectService(ctx, svc);
    const kansen = new KansService(ctx, svc, projects);
    ctx.services.projects = projects;
    ctx.services.kansen = kansen;
    for (const t of [...projectTools(projects, ctx), ...kansTools(kansen, ctx)]) ctx.tools.register(t);
    // Only for the bot that runs the projects (the main bot) and only when it may really start one (a read-only bot is
    // never promised a tool it does not have). Other bots find "projecten en kansen" when they need it.
    const startTool = ctx.tools.get('project_start');
    ctx.hooks.systemPrompt.push(({ agent }) =>
      agent.access_mode === 'chat' || !ctx.tools.groupEnabled(agent, GROUP) || !ctx.services.teams?.isMain?.(agent.id) || !startTool || ctx.broker.decide(agent, startTool) === 'deny'
        ? null
        : '## Projecten en kansen\nGroot werk aan een website, feed of campagne doe je als project (project_start, project_stap): nulmeting → diagnose → plan → uitvoeren → meten. Een idee om geld te verdienen is een kans (kans_melden, altijd met bronnen en datum); een kans wordt pas werk als de eigenaar ja zegt.',
    );
    const team = (v: any) => (typeof v === 'string' && v.trim() && v !== 'all' ? v.trim().slice(0, 80) : null);
    const own = (userId: string, teamId: string | null) => {
      if (teamId && ctx.services.teams && ctx.services.teams.team(teamId)?.user_id !== userId) throw bad('Team niet gevonden');
      return teamId;
    };
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e: any) {
        if (e instanceof ProjectError || e instanceof KansError) throw bad(e.message);
        throw e;
      }
    };
    ctx.api.get('/proactive/projects', ah(async (req) => ({ projects: await projects.list(user(req).id, own(user(req).id, team(req.query.team))) })));
    ctx.api.post(
      '/proactive/projects',
      ah(async (req) => {
        const u = user(req);
        const b = req.body || {};
        return wrap(() => projects.start(u.id, own(u.id, team(b.teamId)) ?? ctx.services.teams?.defaultTeam?.(u.id)?.id ?? null, u.name || 'Eigenaar', { naam: b.naam, site: b.site, doel: b.doel, eigenaar: b.eigenaar }));
      }),
    );
    ctx.api.post(
      '/proactive/projects/:id/stop',
      ah(async (req) => {
        const u = user(req);
        return wrap(async () => ({ project: await projects.stop(u.id, own(u.id, team(req.body?.teamId)), Number(req.params.id), u.name || 'Eigenaar') }));
      }),
    );
    ctx.api.get(
      '/proactive/kansen',
      ah(async (req) => {
        const u = user(req);
        const list = await kansen.list(u.id, own(u.id, team(req.query.team)));
        return { kansen: list, waiting: list.filter((k) => k.status === 'voorgelegd').length };
      }),
    );
    ctx.api.post(
      '/proactive/kansen/:id/decide',
      ah(async (req) => {
        const u = user(req);
        const choice = String(req.body?.choice || '');
        if (!['ja', 'nee', 'later'].includes(choice)) throw bad('Kies ja, nee of later');
        return wrap(() => kansen.decide(u.id, own(u.id, team(req.body?.teamId)) ?? ctx.services.teams?.defaultTeam?.(u.id)?.id ?? null, Number(req.params.id), choice as any, u.name || 'Eigenaar'));
      }),
    );
    // An update to 0.4: the owner's database from before teams belongs to the default team ("Mijn team").
    try {
      if (ctx.services.teams) for (const r of ctx.store.all<{ user_id: string }>('SELECT DISTINCT user_id FROM teams')) svc.legacyTeam(r.user_id);
    } catch (e) {
      ctx.log.error('[teamdata] team upgrade failed', e);
    }
  },
  start(ctx) {
    const svc = ctx.services.teamdata as TeamData | undefined;
    if (!svc) return;
    // One copy per day of every team database (TeamBot's own back-ups cover teambot.db only).
    const daily = async () => {
      let files: string[] = [];
      try {
        files = fs.readdirSync(svc.dir).filter((f) => f.endsWith('.db'));
      } catch {
        return;
      }
      for (const f of files) {
        // <user>.db (the original database) or <user>.<team>.db (a team's own).
        const userId = f.slice(0, -3).split('.')[0];
        if (!ctx.store.user(userId)) continue;
        await svc.backupFile(path.join(svc.dir, f)).catch((e) => ctx.log.warn('[teamdata] back-up mislukt', e?.message || e));
      }
    };
    // A failed round (the database closed by a stop or restore in this process) never ends the process.
    const run = () => void daily().catch((e) => ctx.log.warn('[teamdata] back-up overgeslagen', e?.message || e));
    const timer = setInterval(run, 3_600_000);
    timer.unref();
    ctx.services.teamdataTimer = timer;
    // The first copy a minute after start; cleared on stop like the interval (an in-process restart, e.g. after
    // restoring a back-up, must not run it against the closed database of the old instance).
    const first = setTimeout(run, 60_000);
    first.unref();
    ctx.services.teamdataFirst = first;
  },
  async stop(ctx) {
    if (ctx.services.teamdataTimer) clearInterval(ctx.services.teamdataTimer);
    if (ctx.services.teamdataFirst) clearTimeout(ctx.services.teamdataFirst);
    ctx.services.teamdataTimer = null;
    if (ctx.services.teamdataFirst) clearTimeout(ctx.services.teamdataFirst);
    ctx.services.teamdataFirst = null;
    await (ctx.services.teamdata as TeamData | undefined)?.worker.close();
  },
};

export default mod;
