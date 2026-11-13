import express from 'express';
import type { Ctx, Module, ToolDef } from '../../core/types.js';
import { HttpError, ah, bad, str, user } from '../../core/http.js';
import { WorkflowEngine } from './engine.js';
import { words } from '../../../shared/i18n-core.js';

/**
 * Workflows (PARITEIT 9.8): a chain of steps that several bots do one after another, with a check that can send the
 * work back, the owner's approval before anything goes out, and a message at the end. A run keeps what every step
 * delivered; a workflow keeps its earlier versions. Started by the owner, by a bot (`workflow_run`), on a schedule or
 * by a webhook from another service.
 *
 * Routes (the owner's own data): GET/POST /workflows, GET /workflows/templates, GET/PATCH/DELETE /workflows/:id,
 * POST /workflows/:id/run, GET /workflows/:id/runs, GET /workflows/:id/versions, POST /workflows/:id/versions/:v/restore,
 * POST /workflows/:id/webhook, GET /workflow-runs (busy ones), GET /workflow-runs/:id, POST /workflow-runs/:id/stop|resume.
 * Public: POST /api/public/hooks/wfl_… with the webhook key. Events: `workflow.updated`, `workflowRun.updated`.
 */

const MAX_HOOK = 64 * 1024;
/**
 * A part of the group Routines (automation): every bot that may make routines can also see, start and build workflows,
 * so the owner's existing bots have it without a new switch in the bot editor.
 */
const GROUP = { id: 'routines:workflows' };

function tools(engine: WorkflowEngine): ToolDef[] {
  const inWorkflow = (t: { thread: { meta?: Record<string, any> }; run: { trigger: string } }) => !!t.thread.meta?.workflowId || t.run.trigger === 'workflow';
  const describe = (userId: string) =>
    engine
      .list(userId)
      .map((w) => `- ${w.name}${w.enabled ? '' : ' (staat uit)'}: ${w.description || `${w.steps.length} stappen`}`)
      .join('\n');
  const list: ToolDef = {
    name: 'workflow_list',
    group: GROUP.id,
    risk: 'read',
    description: 'Toon de workflows van de gebruiker: vaste ketens van stappen die meerdere bots na elkaar doen (met controle en akkoord van de gebruiker).',
    parameters: { type: 'object', properties: {} },
    summarize: () => words('Workflows bekijken'),
    async run(_a, t) {
      return describe(t.userId) || 'Er zijn nog geen workflows.';
    },
  };
  const run: ToolDef = {
    name: 'workflow_run',
    group: GROUP.id,
    risk: 'exec',
    internal: true,
    description:
      'Start een workflow van de gebruiker. De stappen lopen op de achtergrond; de gebruiker krijgt een melding als de workflow klaar is of op zijn akkoord wacht. Je krijgt het resultaat dus niet terug in dit gesprek: zeg dat de workflow gestart is.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Naam van de workflow (zie workflow_list)' }, input: { type: 'string', description: 'Waar de workflow mee moet werken, bijv. de opdracht, het onderwerp of het bericht' } }, required: ['name'] },
    summarize: (a) => words('Workflow “{0}” starten', String(a.name || '').slice(0, 80)),
    async run(a, t) {
      if (inWorkflow(t)) return { text: 'Vanuit een stap van een workflow kun je geen workflow starten.', isError: true };
      const want = String(a.name || '').trim().toLowerCase();
      const all = engine.list(t.userId);
      const w = all.find((x) => x.name.toLowerCase() === want) || all.find((x) => x.name.toLowerCase().includes(want) && want.length > 2);
      if (!w) return { text: `Workflow “${a.name}” bestaat niet. Deze zijn er:\n${describe(t.userId) || '(geen)'}`, isError: true };
      if (!w.enabled) return { text: `Workflow “${w.name}” staat uit. De gebruiker zet hem aan op de pagina Workflows.`, isError: true };
      try {
        const r = engine.start(engine.own(t.userId, w.id), { trigger: 'bot', input: String(a.input || ''), startedBy: t.agent.name });
        return `Workflow “${w.name}” is gestart (${w.steps.length} stappen). De gebruiker volgt hem op #/m/workflows/run/${r.id} en krijgt een melding bij het resultaat.`;
      } catch (e: any) {
        return { text: e?.message || 'Kon de workflow niet starten.', isError: true };
      }
    },
  };
  const save: ToolDef = {
    name: 'workflow_save',
    group: GROUP.id,
    risk: 'write',
    description:
      'Maak een workflow voor de gebruiker (of vervang de stappen van een bestaande met dezelfde naam). Stappen, in volgorde: ' +
      '{kind:"bot", title, bot: naam van de bot, prompt} (in de prompt mag {{invoer}}, {{vorige}} en {{stap N}}); ' +
      '{kind:"condition", title, test:"contains"|"not_contains"|"starts_with", value, otherwise:"stop"|"goto", gotoStep: nummer van de stap waarnaar hij teruggaat}; ' +
      '{kind:"approval", title, note} (wacht op akkoord van de gebruiker; zet dit vóór alles wat verstuurt, publiceert of geld kost); {kind:"notify", title}. De workflow start niet vanzelf.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string', description: 'Eén zin: wat de workflow oplevert' }, steps: { type: 'array', items: { type: 'object' } } },
      required: ['name', 'steps'],
    },
    summarize: (a) => words('Workflow “{0}” opslaan ({1, plural, one {# stap} other {# stappen}})', String(a.name || '').slice(0, 80), Array.isArray(a.steps) ? a.steps.length : 0),
    async run(a, t) {
      if (inWorkflow(t)) return { text: 'Vanuit een stap van een workflow kun je geen workflows maken.', isError: true };
      try {
        const name = String(a.name || '').trim();
        const existing = engine.list(t.userId).find((x) => x.name.toLowerCase() === name.toLowerCase());
        const w = existing ? engine.update(t.userId, existing.id, { steps: a.steps, ...(a.description ? { description: a.description } : {}) }) : engine.create(t.userId, { name, description: a.description, steps: a.steps }, t.agent.name);
        // One whole sentence per case, never "bijgewerkt"/"gemaakt" as a value.
        if (existing) return `Workflow “${w.name}” is bijgewerkt (versie ${w.version}, ${w.steps.length} stappen). De gebruiker bekijkt en start hem op #/m/workflows/w/${w.id}.`;
        return `Workflow “${w.name}” is gemaakt (versie ${w.version}, ${w.steps.length} stappen). De gebruiker bekijkt en start hem op #/m/workflows/w/${w.id}.`;
      } catch (e: any) {
        return { text: e?.message || 'Kon de workflow niet opslaan.', isError: true };
      }
    },
  };
  return [list, run, save];
}

const mod: Module = {
  id: 'workflows',
  label: 'Workflows',
  migrations: [
    {
      id: 'workflows-001',
      sql: `
CREATE TABLE workflows (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]', schedule TEXT NOT NULL DEFAULT '{"kind":"none"}', enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1, webhook_hash TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX workflows_user ON workflows(user_id);
CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, steps TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, version)
);
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, "trigger" TEXT NOT NULL,
  started_by TEXT NOT NULL DEFAULT '', input TEXT NOT NULL DEFAULT '', untrusted INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1, steps TEXT NOT NULL DEFAULT '[]', trace TEXT NOT NULL DEFAULT '[]',
  result TEXT NOT NULL DEFAULT '', error TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX workflow_runs_workflow ON workflow_runs(workflow_id, created_at);
CREATE INDEX workflow_runs_user ON workflow_runs(user_id, status);
`,
    },
  ],
  init(ctx: Ctx) {
    const e = new WorkflowEngine(ctx);
    ctx.services.workflows = { engine: e, list: (u: string) => e.list(u), activeRuns: (u: string) => e.activeRuns(u), exportUser: (u: string) => e.exportUser(u) };
    for (const t of tools(e)) ctx.tools.register(t);

    const p = (req: any, k: string) => str(req.params[k], 80);
    ctx.api.get('/workflows', ah(async (req) => ({ workflows: e.list(user(req).id), templates: e.templates() })));
    ctx.api.get('/workflows/templates', ah(async () => ({ templates: e.templates() })));
    ctx.api.post('/workflows', ah(async (req) => e.view(e.create(user(req).id, req.body || {}))));
    ctx.api.get('/workflows/:id', ah(async (req) => e.view(e.own(user(req).id, p(req, 'id')))));
    ctx.api.patch('/workflows/:id', ah(async (req) => e.view(e.update(user(req).id, p(req, 'id'), req.body || {}))));
    ctx.api.delete('/workflows/:id', ah(async (req) => e.remove(user(req).id, p(req, 'id'))));
    ctx.api.post(
      '/workflows/:id/run',
      ah(async (req) => {
        const u = user(req);
        const w = e.own(u.id, p(req, 'id'));
        return e.runView(e.start(w, { trigger: 'manual', input: str(req.body?.input, 64_000), startedBy: u.name || 'Jij' }));
      }),
    );
    ctx.api.get('/workflows/:id/runs', ah(async (req) => ({ runs: e.runs(user(req).id, p(req, 'id')) })));
    ctx.api.get('/workflows/:id/versions', ah(async (req) => ({ versions: e.versions(user(req).id, p(req, 'id')) })));
    ctx.api.post(
      '/workflows/:id/versions/:v/restore',
      ah(async (req) => {
        const v = Number(req.params.v);
        if (!Number.isInteger(v)) throw bad('Onbekende versie');
        return e.view(e.restore(user(req).id, p(req, 'id'), v));
      }),
    );
    ctx.api.post(
      '/workflows/:id/webhook',
      ah(async (req) => {
        // A webhook key hands out access: made on the computer, never on a paired phone (like a routine's webhook secret).
        if ((req as any).session?.kind === 'device') throw new HttpError(403, 'Een webhook voor een workflow stel je in op je computer.', 'mobile_denied');
        return e.setWebhook(user(req).id, p(req, 'id'), req.body?.enabled !== false);
      }),
    );
    ctx.api.get('/workflow-runs', ah(async (req) => ({ runs: e.activeRuns(user(req).id) })));
    ctx.api.get('/workflow-runs/:id', ah(async (req) => e.runView(e.ownRun(user(req).id, p(req, 'id')))));
    ctx.api.post('/workflow-runs/:id/stop', ah(async (req) => e.stopRun(user(req).id, p(req, 'id'))));
    ctx.api.post('/workflow-runs/:id/resume', ah(async (req) => e.resume(user(req).id, p(req, 'id'))));

    // Another service starts a workflow. The key goes in the Authorization header (or X-TeamBot-Key), never in the URL.
    ctx.publicApi.post(
      '/hooks/:id',
      (req, res, next) => {
        if (!String(req.params.id || '').startsWith('wfl_')) return next('route');
        if (Number(req.headers['content-length'] || 0) > MAX_HOOK) return res.status(413).json({ error: 'Payload te groot' });
        next();
      },
      express.raw({ type: () => true, limit: MAX_HOOK }),
      ah(async (req, res) => {
        const auth = String(req.headers.authorization || '');
        const key = /^Bearer\s+(.+)$/i.exec(auth)?.[1] || String(req.headers['x-teambot-key'] || '');
        const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const out = e.webhook(String(req.params.id), key.trim(), raw.toString('utf8'));
        res.status(out.status).json(out.body);
      }),
    );
  },
  start(ctx: Ctx) {
    (ctx.services.workflows?.engine as WorkflowEngine | undefined)?.startAll();
  },
  stop(ctx: Ctx) {
    (ctx.services.workflows?.engine as WorkflowEngine | undefined)?.stopAll();
  },
};

export default mod;
