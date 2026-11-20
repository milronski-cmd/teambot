import type { Agent, Ctx } from '../../core/types.js';
import { now } from '../../core/db.js';

/**
 * Two bots that do the same work become one: everything that still has to happen moves from `from` to `into`, and
 * `from` goes to the archive (its chats and history stay readable there; nothing is deleted). What moves:
 *   - open tasks on its name and the claims it holds;
 *   - its routines (they run as the bot that stays);
 *   - what it may read in memory, and its own working notes as an ordinary dossier of the bot that stays;
 *   - its connected apps and its skills (the bot that stays gets what it did not have yet);
 *   - its name in the team database (tasks, dashboard tiles, experiments, projects).
 * Refused while a turn of either bot runs: a turn is never cut off for this. Live (20 Nov 2026): two builders with
 * the same role worked in the same sites and spent more turns tuning in with each other than on the work.
 */
export interface MergeResult {
  from: string;
  into: string;
  tasks: number;
  routines: number;
  dossiers: number;
  apps: number;
  skills: number;
  teamRows: number;
}

export class MergeRefused extends Error {}

export async function mergeBots(ctx: Ctx, userId: string, fromId: string, intoId: string): Promise<MergeResult> {
  const store = ctx.store;
  const from = store.agent(fromId);
  const into = store.agent(intoId);
  if (!from || !into || from.user_id !== userId || into.user_id !== userId) throw new MergeRefused('Bot niet gevonden.');
  if (from.id === into.id) throw new MergeRefused('Kies twee verschillende bots.');
  if (from.archived || into.archived) throw new MergeRefused('Een gearchiveerde bot kan niet worden samengevoegd.');
  if (ctx.services.teams?.isMain?.(from.id)) throw new MergeRefused(`${from.name} is je hoofdbot. Voeg de andere bot in ${from.name}, of maak eerst een andere bot hoofdbot.`);
  const busy = store.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE agent_id IN (?, ?) AND status IN ('queued','running','waiting')", from.id, into.id)?.n || 0;
  if (busy) throw new MergeRefused(`${from.name} of ${into.name} is nog aan het werk. Samenvoegen kan zodra hun beurten klaar zijn; er wordt niets afgebroken.`);

  const out: MergeResult = { from: from.name, into: into.name, tasks: 0, routines: 0, dossiers: 0, apps: 0, skills: 0, teamRows: 0 };
  const ts = now();
  store.tx(() => {
    out.tasks = Number(store.exec("UPDATE room_tasks SET owner_id = ?, updated_at = ? WHERE user_id = ? AND owner_type = 'agent' AND owner_id = ? AND status != 'done'", into.id, ts, userId, from.id)?.changes || 0);
    store.exec('UPDATE quality_tasks SET claimed_by = ? WHERE user_id = ? AND claimed_by = ? AND open = 1', into.id, userId, from.id);
    out.routines = Number(store.exec("UPDATE routines SET agent_id = ?, updated_at = ? WHERE user_id = ? AND agent_id = ? AND status != 'archived'", into.id, ts, userId, from.id)?.changes || 0);

    // Memory: the working notes of the bot that goes become an ordinary dossier; what it could read, the other reads.
    for (const d of store.all<any>("SELECT id, title, core, agent_ids, created_by_agent FROM memory_dossiers WHERE user_id = ? AND trashed_at IS NULL AND (agent_ids LIKE ? OR created_by_agent = ?)", userId, `%${from.id}%`, from.id)) {
      let ids: string[] = [];
      try {
        ids = JSON.parse(d.agent_ids || '[]');
      } catch {
        ids = [];
      }
      const next = [...new Set(ids.map((x) => (x === from.id ? into.id : x)))];
      const own = d.core === 'notes' && d.created_by_agent === from.id;
      if (own) store.exec('UPDATE memory_dossiers SET core = NULL, title = ?, agent_ids = ?, updated_at = ? WHERE id = ?', `Werknotities van ${from.name} (samengevoegd met ${into.name})`, JSON.stringify([...new Set([...next, into.id])]), ts, d.id);
      else if (JSON.stringify(next) !== JSON.stringify(ids)) store.exec('UPDATE memory_dossiers SET agent_ids = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), ts, d.id);
      else continue;
      out.dossiers++;
    }

    for (const b of store.all<any>('SELECT connection_id FROM mcp_bindings WHERE agent_id = ?', from.id)) {
      if (store.one('SELECT 1 FROM mcp_bindings WHERE agent_id = ? AND connection_id = ?', into.id, b.connection_id)) continue;
      store.exec('UPDATE mcp_bindings SET agent_id = ? WHERE agent_id = ? AND connection_id = ?', into.id, from.id, b.connection_id);
      out.apps++;
    }
  });

  // Skills: the bot that stays gets what the other had.
  try {
    const lib = ctx.services.skills?.library;
    if (lib?.enabledFor && lib?.setAgentSkills) {
      const have = new Set<string>(lib.enabledFor(into).map((s: any) => s.id));
      const extra: string[] = lib.enabledFor(from).map((s: any) => s.id).filter((id: string) => !have.has(id));
      if (extra.length) {
        lib.setAgentSkills(store.agent(into.id) as Agent, [...have, ...extra]);
        out.skills = extra.length;
      }
    }
  } catch (e) {
    ctx.log.warn('[merge] skills', e);
  }

  // The team database names bots by name.
  try {
    const td = ctx.services.teamdata;
    const teamId: string | null = ctx.services.teams?.teamOf?.(from.id) || null;
    if (td?.write) {
      const res = await td.write(
        userId,
        [
          { sql: "UPDATE taken SET eigenaar = ? WHERE eigenaar = ? AND status NOT IN ('klaar','geannuleerd')", params: [into.name, from.name] },
          { sql: 'UPDATE dashboard SET bot = ? WHERE bot = ?', params: [into.name, from.name] },
          { sql: "UPDATE experimenten SET eigenaar = ? WHERE eigenaar = ? AND status = 'loopt'", params: [into.name, from.name] },
          { sql: "UPDATE projecten SET eigenaar = ? WHERE eigenaar = ? AND status != 'gestopt'", params: [into.name, from.name] },
        ],
        teamId,
      );
      out.teamRows = (res || []).reduce((n: number, r: any) => n + Number(r?.changes || 0), 0);
    }
  } catch (e) {
    ctx.log.warn('[merge] teamdata', e);
  }

  // The bot that stays takes over the work itself: the other's role joins its role, and what the other was told to do
  // joins its instructions (under its name, so the owner sees where it came from and can tidy it).
  const role = [into.role, from.role].map((x) => String(x || '').trim()).filter((x, i, l) => x && l.indexOf(x) === i).join(' ').slice(0, 300);
  const theirs = String(from.instructions || '').trim();
  const mine = String(into.instructions || '').trim();
  const taken = `Je doet sinds het samenvoegen ook het werk van ${from.name}${from.role ? ` (${String(from.role).trim()})` : ''}.${theirs ? ` Wat ${from.name} was opgedragen geldt nu voor jou:\n${theirs.slice(0, 12_000)}` : ''}`;
  store.updateAgent(into.id, { role, instructions: [mine, taken].filter(Boolean).join('\n\n') } as any);

  store.updateAgent(from.id, { archived: true, settings: { ...(from.settings || {}), mergedInto: into.id, mergedAt: ts } } as any);
  ctx.audit(userId, 'agent.merged', { ...out }, into.id);
  ctx.events.emit(userId, 'agent.updated', store.agent(from.id));
  ctx.events.emit(userId, 'agent.updated', store.agent(into.id));
  return out;
}
