import type { Agent, Ctx } from '../../core/types.js';
import { bad } from '../../core/http.js';
import type { TeamsService } from './service.js';

/**
 * "Team dupliceren" (plan 0.4 B-13): a new team with a copy of every bot of the team (as a bot template: name, face,
 * role, instructions, tools, skills, and its routines, which come in switched off), the same business profile, team
 * lead and daily budget, and specialists with their field and sources (never what they learned). Never copied:
 * memory, conversations, keys and logins (and their team scope), channels, the team folder, and access given to bots
 * of other teams. The main bot stands above the teams and stays one. All or nothing: when a bot cannot be copied,
 * the new team and the bots made so far are removed again.
 */
export async function duplicateTeam(ctx: Ctx, svc: TeamsService, userId: string, teamId: string) {
  const from = svc.own(userId, teamId);
  const skills = ctx.services.skills;
  if (typeof skills?.exportTemplate !== 'function' || typeof skills?.installTemplate !== 'function') throw bad('Team dupliceren heeft de skillsmodule nodig, en die staat uit.');
  const main = svc.mainOf(userId);
  const bots = svc
    .botsOf(from.id)
    .map((id) => ctx.store.agent(id))
    .filter((a): a is Agent => !!a && a.user_id === userId && !a.archived && a.id !== main)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const name = copyName(svc.list(userId).map((t) => t.name), from.name);
  const to = svc.create(userId, { name, profile: from.profile });
  const agentMap: Record<string, string> = {};
  const warnings: string[] = [];
  try {
    for (const a of bots) {
      const { template, warnings: w } = await skills.exportTemplate(a);
      for (const x of w || []) warnings.push(`${a.name}: ${x}`);
      // The owner's own bot, copied on his own computer: the same AI engine; skills he already has are reused.
      const r = await skills.installTemplate(userId, template, { provider_id: a.provider_id || undefined, model: a.model || undefined, acknowledge: true });
      agentMap[a.id] = r.agent.id;
      svc.setHome(userId, to.id, r.agent.id);
      for (const x of r.warnings || []) warnings.push(`${a.name}: ${x}`);
      const spec = ctx.services.specialists?.exportForAgent?.(userId, a.id);
      if (spec) {
        try {
          ctx.services.specialists.importForAgent(userId, r.agent.id, spec);
        } catch (e: any) {
          warnings.push(`${a.name}: het vakgebied kon niet worden meegenomen (${String(e?.message || e).slice(0, 120)}).`);
        }
      }
    }
  } catch (e) {
    for (const id of Object.values(agentMap)) {
      try {
        ctx.store.deleteAgent(id);
      } catch {
        /* best effort */
      }
    }
    try {
      svc.remove(userId, to.id);
    } catch {
      /* an empty team stays behind only if removing fails */
    }
    throw e;
  }
  const patch: any = {};
  if (from.lead_agent_id && agentMap[from.lead_agent_id]) patch.leadAgentId = agentMap[from.lead_agent_id];
  if (from.daily_budget_usd) patch.dailyBudgetUsd = from.daily_budget_usd;
  if (Object.keys(patch).length) svc.update(userId, to.id, patch);
  // Each module copies what it keeps per team and may copy (memory only with "vakkennis meenemen": not here).
  const modules = svc.copyTeamData(userId, from.id, to.id, { knowledge: false, agentMap });
  for (const [id, r] of Object.entries(modules)) if (r?.error) warnings.push(`${id}: ${r.error}`);
  const skipped = main && svc.teamOf(main) === from.id ? ctx.store.agent(main)?.name || null : null;
  ctx.audit(userId, 'team.duplicated', { from: from.id, to: to.id, bots: Object.keys(agentMap).length, mainSkipped: !!skipped });
  ctx.events.emit(userId, 'teams.changed', {});
  return { team: svc.view(svc.team(to.id)!, userId), bots: Object.keys(agentMap).length, mainSkipped: skipped, warnings: [...new Set(warnings)] };
}

/** "Webshop (kopie)", "Webshop (kopie 2)", … within the 60 characters of a team name. */
export function copyName(existing: string[], base: string): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  for (let i = 1; i < 100; i++) {
    const tail = i === 1 ? ' (kopie)' : ` (kopie ${i})`;
    const n = base.slice(0, 60 - tail.length).trim() + tail;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return `${base.slice(0, 40).trim()} (kopie ${Date.now() % 10000})`;
}
