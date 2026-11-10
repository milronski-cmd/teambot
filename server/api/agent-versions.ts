import type { Agent, Ctx, Migration } from '../core/types.js';
import { ah, bad, own, user } from '../core/http.js';
import { now } from '../core/db.js';
import { pickAgent } from './agents.js';
import { sanitizeAgentForMember } from './member-policy.js';

/** Profile history for bots (BOT-10): every change stores the previous profile so it can be compared and restored. */
export const agentVersionMigrations: Migration[] = [
  {
    id: 'core-agent-versions-001',
    sql: `CREATE TABLE agent_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL,
  changed TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT 'edit', created_at TEXT NOT NULL
);
CREATE INDEX agent_versions_agent ON agent_versions(agent_id, id);`,
  },
];

const VERSIONED: (keyof Agent)[] = ['name', 'avatar', 'color', 'role', 'description', 'instructions', 'provider_id', 'model', 'reasoning', 'access_mode', 'workspace', 'tool_groups', 'tool_policy', 'skills', 'fallback', 'busy_policy', 'settings'];
const KEEP = 50;

function snapshot(a: Agent) {
  const out: any = {};
  for (const k of VERSIONED) out[k] = a[k];
  return out;
}

/** Store the profile as it was before `patch` is applied. No-op when nothing versioned changes. */
export function recordAgentVersion(ctx: Ctx, before: Agent, patch: Partial<Agent>, reason = 'edit') {
  const changed = VERSIONED.filter((k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(before[k]));
  if (!changed.length) return;
  ctx.store.exec('INSERT INTO agent_versions (agent_id, user_id, data, changed, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)', before.id, before.user_id, JSON.stringify(snapshot(before)), JSON.stringify(changed), reason, now());
  ctx.store.exec('DELETE FROM agent_versions WHERE agent_id = ? AND id NOT IN (SELECT id FROM agent_versions WHERE agent_id = ? ORDER BY id DESC LIMIT ?)', before.id, before.id, KEEP);
}

export function agentVersionRoutes(ctx: Ctx) {
  const api = ctx.api;
  api.get(
    '/agents/:id/versions',
    ah(async (req) => {
      const a = own(req, ctx.store.agent(req.params.id as string), 'Bot niet gevonden');
      return ctx.store
        .all<any>('SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY id DESC LIMIT ?', a.id, KEEP)
        .map((r) => ({ id: r.id, created_at: r.created_at, reason: r.reason, changed: JSON.parse(r.changed), data: JSON.parse(r.data) }));
    }),
  );
  api.post(
    '/agents/:id/versions/:vid/restore',
    ah(async (req) => {
      const u = user(req);
      const a = own(req, ctx.store.agent(req.params.id as string), 'Bot niet gevonden');
      const row = ctx.store.one<any>('SELECT * FROM agent_versions WHERE id = ? AND agent_id = ?', Number(req.params.vid), a.id);
      if (!row) throw bad('Versie niet gevonden');
      const data = sanitizeAgentForMember(ctx, u, pickAgent(JSON.parse(row.data)), a);
      if (data.provider_id && !ctx.providers.canUse(u.id, ctx.providers.config(data.provider_id))) data.provider_id = a.provider_id;
      // "Volledige toegang" is only ever an explicit choice of the owner (Bot bewerken › Toegang), never a side effect
      // of putting an old version back: the bot keeps its current access level then.
      if (data.access_mode === 'full' && a.access_mode !== 'full') data.access_mode = a.access_mode;
      if (data.settings?.fullAccessExternal === true && a.settings?.fullAccessExternal !== true) data.settings = { ...data.settings, fullAccessExternal: false };
      recordAgentVersion(ctx, a, data, 'restore');
      const upd = ctx.store.updateAgent(a.id, data);
      ctx.audit(u.id, 'agent.restored', { version: row.id }, a.id);
      ctx.events.emit(u.id, 'agent.updated', upd);
      return upd;
    }),
  );
  ctx.hooks.agentDeleted.push(({ agentId }) => ctx.store.exec('DELETE FROM agent_versions WHERE agent_id = ?', agentId));
}
