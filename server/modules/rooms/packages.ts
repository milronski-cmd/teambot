import type { Ctx } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { cleanLimits, MODE_LABEL, MODES, type RoomMode } from './routing.js';
import { cleanPerms, type RoomService } from './service.js';
import type { BotPerms, Room } from './types.js';

/**
 * Team packages (A-63) and team templates (A-14): a whole group as one file — its bots (each a normal bot template:
 * profile, instructions, face, tool groups, routines that install switched off), their role in the group (lead or
 * member, with group permissions), the group settings (name, way of working, instructions, limits) and the skills
 * the bots use, once, referenced by name. Never in it: conversations, memory, keys or other secrets (removed from
 * texts), provider choice, working folders, people or guests. Built-in team templates use the same format.
 */
export const TEAM_FORMAT = 'teambot.team/v1';

export interface TeamBot {
  /** Group role: the lead answers first and divides the work (mode "lead"). */
  role: 'lead' | 'member';
  perms?: Partial<BotPerms>;
  /** A bot template (teambot.bot-template/v1) without skill files; `skillRefs` names skills in the package. */
  template: any;
  skillRefs: string[];
}
export interface TeamPackage {
  format: typeof TEAM_FORMAT;
  name: string;
  description: string;
  mode: RoomMode;
  instructions: string;
  limits: Record<string, number>;
  bots: TeamBot[];
  skills: any[];
  meta: Record<string, any>;
}

const s = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Read a package from an untrusted file: known format, bounded sizes, at least one bot, one lead in "lead" mode. */
export function normalizeTeam(raw: any): TeamPackage {
  if (!raw || typeof raw !== 'object' || raw.format !== TEAM_FORMAT) throw new HttpError(400, `Dit is geen teampakket (verwacht "${TEAM_FORMAT}").`);
  const bots: TeamBot[] = (Array.isArray(raw.bots) ? raw.bots : []).slice(0, 12).filter((b: any) => b && typeof b === 'object' && b.template && typeof b.template === 'object').map((b: any) => ({
    role: b.role === 'lead' ? 'lead' : 'member',
    perms: cleanPerms(b.perms),
    template: { ...b.template, skills: [] },
    skillRefs: (Array.isArray(b.skillRefs) ? b.skillRefs : []).map((x: any) => s(x, 64)).filter(Boolean).slice(0, 30),
  }));
  if (!bots.length) throw new HttpError(400, 'Dit teampakket bevat geen bots.');
  const mode: RoomMode = MODES.includes(raw.mode) ? raw.mode : 'lead';
  if (mode === 'lead' && !bots.some((b) => b.role === 'lead')) bots[0].role = 'lead';
  let leads = 0;
  for (const b of bots) if (b.role === 'lead' && ++leads > 1) b.role = 'member';
  return {
    format: TEAM_FORMAT,
    name: s(raw.name, 80).trim() || 'Team',
    description: s(raw.description, 2000),
    mode,
    instructions: s(raw.instructions, 20_000),
    limits: cleanLimits(raw.limits) as Record<string, number>,
    bots,
    skills: (Array.isArray(raw.skills) ? raw.skills : []).filter((x: any) => x && typeof x === 'object' && typeof x.name === 'string').slice(0, 60),
    meta: raw.meta && typeof raw.meta === 'object' ? { ...raw.meta } : {},
  };
}

/** A bot's full template again: its own skills from the package's shared list. */
function botTemplate(p: TeamPackage, b: TeamBot) {
  return { ...b.template, skills: b.skillRefs.map((n) => p.skills.find((x: any) => x.name === n)).filter(Boolean) };
}

function skillsService(ctx: Ctx) {
  const svc = ctx.services.skills;
  if (!svc?.exportTemplate || !svc?.previewTemplate || !svc?.installTemplate) throw new HttpError(400, 'Teampakketten hebben de skillsmodule nodig (die staat uit).');
  return svc;
}

/** Export a group as a team package (owner only; the caller checks). */
export async function exportTeam(ctx: Ctx, room: Room): Promise<{ pkg: TeamPackage; warnings: string[] }> {
  const svc = skillsService(ctx);
  const warnings: string[] = [];
  const skills: any[] = [];
  const bots: TeamBot[] = [];
  const members = ctx.store.all<any>("SELECT * FROM room_members WHERE room_id = ? AND kind = 'agent' ORDER BY sort", room.id).map((m) => ctx.store.decode<any>('room_members', m));
  for (const m of members) {
    const agent = ctx.store.agent(m.ref_id);
    if (!agent || agent.user_id !== room.user_id) continue;
    const { template, warnings: w } = await svc.exportTemplate(agent);
    for (const x of w) warnings.push(`${agent.name}: ${x}`);
    const refs: string[] = [];
    for (const sk of template.skills || []) {
      const same = skills.find((x) => x.name === sk.name);
      if (!same) skills.push(sk);
      else if (same.checksum && sk.checksum && same.checksum !== sk.checksum) warnings.push(`Skill "${sk.name}" verschilt per bot; de versie van de eerste bot gaat mee.`);
      refs.push(sk.name);
    }
    bots.push({ role: room.lead_agent_id === agent.id || m.role === 'lead' ? 'lead' : 'member', perms: cleanPerms(m.perms), template: { ...template, skills: [] }, skillRefs: refs });
  }
  if (!bots.length) throw new HttpError(400, 'Deze groep heeft geen bots om te exporteren.');
  const pkg: TeamPackage = {
    format: TEAM_FORMAT,
    name: room.name,
    description: '',
    mode: room.mode,
    instructions: room.instructions || '',
    limits: { ...(room.limits as any) },
    bots,
    skills,
    meta: { app: ctx.config.appName, app_version: ctx.config.version, exported_at: new Date().toISOString(), bots: bots.length },
  };
  return { pkg, warnings };
}

/** What installing would do, for the preview: bots with role, profile, skills and warnings; the group settings. */
export function previewTeam(ctx: Ctx, userId: string, p: TeamPackage) {
  const svc = skillsService(ctx);
  const warnings: string[] = [];
  const bots = p.bots.map((b) => {
    const pv = svc.previewTemplate(userId, botTemplate(p, b));
    for (const w of pv.warnings || []) warnings.push(`${pv.bot.name}: ${w}`);
    return {
      name: pv.bot.name,
      role: pv.bot.role,
      description: pv.bot.description,
      avatar: pv.bot.avatar,
      color: pv.bot.color,
      groupRole: b.role,
      access_mode: pv.bot.access_mode,
      tool_groups: (pv.bot.tool_groups || []).filter((g: any) => g.known).map((g: any) => g.label),
      instructions: String(pv.bot.instructions || '').slice(0, 600),
      skills: (pv.skills || []).map((x: any) => ({ name: x.name, action: x.action })),
      routines: pv.routines?.count || 0,
      needsAcknowledge: !!pv.needsAcknowledge,
    };
  });
  for (const ref of new Set(p.bots.flatMap((b) => b.skillRefs))) if (!p.skills.some((x: any) => x.name === ref)) warnings.push(`Skill "${ref}" ontbreekt in het pakket en wordt overgeslagen.`);
  return {
    name: p.name,
    description: p.description,
    mode: p.mode,
    modeLabel: MODE_LABEL[p.mode],
    instructions: p.instructions,
    lead: bots.find((b) => b.groupRole === 'lead')?.name || null,
    bots,
    routines: bots.reduce((n, b) => n + b.routines, 0),
    needsAcknowledge: bots.some((b) => b.needsAcknowledge),
    warnings: [...new Set(warnings)],
  };
}

/** Create the bots (each through the normal bot-template install: safe access, routines off) and then the group. */
export async function installTeam(ctx: Ctx, rooms: RoomService, userId: string, p: TeamPackage, o: { provider_id?: string | null; model?: string; name?: string; acknowledge?: boolean } = {}) {
  const svc = skillsService(ctx);
  const pv = previewTeam(ctx, userId, p);
  if (pv.needsAcknowledge && !o.acknowledge) throw new HttpError(409, 'Een of meer skills in dit team hebben ernstige waarschuwingen. Bekijk ze en bevestig.');
  const created: { id: string; name: string; role: 'lead' | 'member'; perms?: Partial<BotPerms> }[] = [];
  try {
    for (const b of p.bots) {
      const r = await svc.installTemplate(userId, botTemplate(p, b), { provider_id: o.provider_id || undefined, model: o.model || undefined, acknowledge: o.acknowledge });
      created.push({ id: r.agent.id, name: r.agent.name, role: b.role, perms: b.perms });
    }
  } catch (e) {
    // All or nothing: a team with half its bots is not what the person asked for.
    for (const c of created) {
      try {
        ctx.store.deleteAgent(c.id);
      } catch {
        /* best effort */
      }
    }
    throw e;
  }
  const lead = created.find((c) => c.role === 'lead');
  const room = rooms.create(userId, { name: (o.name || '').trim() || p.name, mode: p.mode, agentIds: created.map((c) => c.id), leadAgentId: lead?.id, instructions: p.instructions, limits: p.limits });
  for (const c of created) if (c.perms && Object.keys(c.perms).length) rooms.updateBot(room, c.id, { perms: c.perms });
  ctx.audit(userId, 'team.installed', { name: p.name, bots: created.length, roomId: room.id, source: p.meta?.builtin ? 'sjabloon' : 'pakket' });
  return { room, agents: created.map((c) => ({ id: c.id, name: c.name, role: c.role })), warnings: pv.warnings };
}
