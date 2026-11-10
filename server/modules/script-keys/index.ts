import type { Request } from 'express';
import type { Agent, Ctx, Module } from '../../core/types.js';
import { HttpError, ah, str, user } from '../../core/http.js';
import { ScriptKeys } from './service.js';

/**
 * "Sleutels voor scripts" (docs/modules/script-keys.md): the owner gives a stored secret to one bot or to every bot of
 * a team as an environment variable with a name of his choice (SHOPIFY_TOKEN). TeamBot's own `run_command`,
 * `skill_run_script`, `computer_exec` (private container) and `remote_exec` (own server over SSH) get it in their
 * environment (`ctx.services.scriptKeys.envFor`); the model only learns the names;
 * every tool result and live output is scrubbed (`scrub`, called by tools/execute.ts). Managing keys hands out access,
 * so a paired phone cannot (server/modules/mobile/policy.ts COMPUTER_ONLY, and `noDevice` below).
 */

const instances = new WeakMap<Ctx, ScriptKeys>();

export function scriptKeysOf(ctx: Ctx): ScriptKeys | undefined {
  return instances.get(ctx);
}

/** The stable system-prompt note: names only, how to use them, and that the value never shows. */
export function promptNote(ctx: Ctx, svc: ScriptKeys, agent: Agent): string | null {
  if (agent.access_mode === 'chat' || agent.access_mode === 'readonly') return null;
  const keys = svc.namesFor(agent);
  if (!keys.length) return null;
  const win = process.platform === 'win32';
  const first = keys[0].name;
  const cfg = agent.provider_id ? ctx.providers.config(agent.provider_id) : null;
  const cli = !!cfg && ctx.providers.kind(cfg.kind)?.type === 'cli';
  return [
    '## Sleutels voor scripts',
    'De eigenaar heeft deze sleutels voor je klaargezet als omgevingsvariabelen:',
    ...keys.map((k) => `- ${k.name}${k.label ? ` — ${k.label.replace(/[\r\n]+/g, ' ').slice(0, 120)}` : ''}`),
    `Ze staan alleen klaar in TeamBot's eigen tools run_command, skill_run_script, computer_exec (je privé-container) en remote_exec (je eigen server)${cli ? ' (via de MCP-server "teambot"; niet in de eigen terminal van je programma, gebruik voor opdrachten met een sleutel dus de TeamBot-tool run_command)' : ''}.`,
    `Gebruik ze in een opdracht als ${win ? `$env:${first} (PowerShell)` : `$${first} (bash)`} en in een script via de omgeving (os.environ["${first}"], process.env.${first}).`,
    'Je ziet de waarde nooit: TeamBot vervangt hem in alle uitvoer door [verborgen: $NAAM]. Druk hem niet af, zet hem niet in bestanden, berichten, je geheugen of een andere tool, en vraag de gebruiker niet om de waarde. Ontbreekt een sleutel, vraag de gebruiker dan hem toe te voegen in je bot-instellingen onder Sleutels voor scripts.',
  ].join('\n');
}

const mod: Module = {
  id: 'script-keys',
  label: 'Sleutels voor scripts',
  migrations: [
    {
      id: 'script-keys-001',
      sql: `
        CREATE TABLE script_keys (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          secret_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT
        );
        CREATE INDEX script_keys_user ON script_keys(user_id, name);
        CREATE TABLE script_key_grants (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          key_id TEXT NOT NULL,
          target TEXT NOT NULL,
          target_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (key_id, target, target_id)
        );
        CREATE INDEX script_key_grants_target ON script_key_grants(target, target_id);
      `,
    },
  ],
  init(ctx) {
    const svc = new ScriptKeys(ctx);
    instances.set(ctx, svc);
    const api = ctx.api;
    // Handing a key to a bot hands out access: never from a paired phone (also closed in the mobile policy).
    const noDevice = (req: Request) => {
      if ((req as any).session?.kind === 'device') throw new HttpError(403, 'Sleutels voor scripts beheer je op je computer.', 'mobile_denied');
    };
    const uid = (req: Request) => {
      noDevice(req);
      return user(req).id;
    };

    api.get('/script-keys', ah(async (req) => svc.list(uid(req))));
    api.post('/script-keys', ah(async (req) => svc.create(uid(req), req.body || {})));
    api.get('/script-keys/agents/:agentId', ah(async (req) => svc.forAgent(uid(req), str(req.params.agentId, 80))));
    api.patch('/script-keys/:id', ah(async (req) => svc.update(uid(req), str(req.params.id, 80), req.body || {})));
    api.delete(
      '/script-keys/:id',
      ah(async (req) => {
        svc.remove(uid(req), str(req.params.id, 80));
        return { ok: true };
      }),
    );
    api.post('/script-keys/:id/grants', ah(async (req) => svc.grant(uid(req), str(req.params.id, 80), req.body || {})));
    api.delete('/script-keys/:id/grants/:target/:targetId', ah(async (req) => svc.revoke(uid(req), str(req.params.id, 80), str(req.params.target, 10), str(req.params.targetId, 80))));

    ctx.hooks.systemPrompt.push(({ agent }) => promptNote(ctx, svc, agent));
    ctx.hooks.agentDeleted.push(({ agentId, userId }) => svc.agentDeleted(agentId, userId));

    ctx.services.scriptKeys = {
      /** NAME → value for the environment of one of the bot's scripts. Only TeamBot's own script tools call this. */
      envFor: (agent: Agent, o?: { tool?: string }) => svc.envFor(agent, o),
      /** The key names this bot can use (never a value). */
      namesFor: (agent: Agent) => svc.namesFor(agent),
      /** Replace every script-key value of this owner in a text by [verborgen: $NAME]. */
      scrub: (userId: string, text: string) => svc.scrub(userId, text),
      /** The same for output that is still coming in: also drops a last piece that could be a half-printed value. */
      scrubLive: (userId: string, text: string) => svc.scrubLive(userId, text),
      /** A piece of shortened output: also drops half a value at the cut edge (`end`: cut after it, `start`: before it). */
      scrubPiece: (userId: string, text: string, cut?: { start?: boolean; end?: boolean }) => svc.scrubPiece(userId, text, cut),
      exportUser: (userId: string) => svc.exportUser(userId),
    };
  },
};

export default mod;
