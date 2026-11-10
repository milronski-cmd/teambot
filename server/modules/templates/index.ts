import type { Request } from 'express';
import type { Ctx, Module } from '../../core/types.js';
import { ah, bad, notFound, str, user } from '../../core/http.js';
import { encodeFace } from '../../../shared/botface.js';
import { normalizeTeam, previewTeam } from '../rooms/packages.js';
import { describeSchedule, normalizeSchedule, systemTimezone } from '../routines/schedule.js';
import { accentOf, buildPackage } from './build.js';
import { isEmptyProfile, profileFromAnswers, profileText, teamsProfile } from './profile.js';
import { TEMPLATE_DEFS, templateDef } from './registry.js';
import { botInstructions, teamInstructions } from './render.js';
import { resolveSkills } from './skills.js';
import type { RoutineSuggestion, TemplateDef } from './types.js';
import { validateRegistry } from './validate.js';

/**
 * Team templates (0.4, package R): ready teams for a type of business, for private life and general ones, each with
 * one team lead and 2–4 bots (the empty team has only its lead), a short profile questionnaire, suggested catalogue
 * skills, optional specialist fields and suggested routines that come in switched off. Always optional: TeamBot
 * never creates a team by itself. The definitions are data (./defs, one file per template); installing goes through
 * the rooms module's team-package install, so bots start on "vraagt toestemming" and nothing personal travels along.
 * With the teams module (package B) the template becomes one team: its bots get that team as home, the lead is the
 * team lead and the answers fill the team's business profile.
 */

function routineView(r: RoutineSuggestion) {
  const tz = systemTimezone();
  let when = '';
  try {
    when = describeSchedule(normalizeSchedule(r.schedule, tz, Date.now()), tz);
  } catch {
    when = '';
  }
  return { name: r.name, when, prompt: r.prompt, enabled: false };
}

function summary(d: TemplateDef) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    note: d.note || '',
    category: d.category,
    status: d.status,
    version: d.version,
    minimal: !!d.minimal,
    bots: d.bots.map((b) => ({
      name: b.name,
      role: b.role,
      description: b.description,
      avatar: encodeFace(b.face),
      color: accentOf(b.face.color),
      groupRole: b.lead ? ('lead' as const) : ('member' as const),
      customer: b.customer || null,
      specialist: b.specialist ? { field: b.specialist.field, suggestedSources: [...b.specialist.suggestedSources] } : null,
    })),
    questions: d.questions,
    examples: d.examples,
    routines: d.bots.reduce((n, b) => n + (b.routines?.length || 0), 0),
    skills: d.bots.reduce((n, b) => n + (b.skills?.length || 0), 0),
  };
}

function detail(ctx: Ctx, userId: string, d: TemplateDef) {
  const { suggestions } = resolveSkills(ctx, userId, d);
  const s = summary(d);
  return {
    ...s,
    goal: d.goal,
    rules: d.rules,
    instructions: teamInstructions(d),
    bots: d.bots.map((b, i) => ({
      ...s.bots[i],
      tools: b.tools,
      instructions: botInstructions(d, b),
      does: b.does,
      may: b.may,
      mayNot: b.mayNot,
      askWhen: b.askWhen,
      doneWhen: b.doneWhen,
      routines: (b.routines || []).map(routineView),
      skills: suggestions.filter((x) => x.bot === b.name),
    })),
  };
}

/** The teams module (package B, its public ctx.services.teams), when it is there and has what a template install needs. */
function teamsApi(ctx: Ctx) {
  const t = ctx.services.teams;
  if (!t || typeof t.list !== 'function' || typeof t.create !== 'function' || typeof t.update !== 'function' || typeof t.setHome !== 'function' || typeof t.own !== 'function') return null;
  return {
    list: (userId: string): any[] => t.list(userId),
    own: (userId: string, id: string): any => t.own(userId, id),
    create: (userId: string, data: any): any => t.create(userId, data),
    update: (userId: string, id: string, data: any): any => t.update(userId, id, data),
    setHome: (userId: string, teamId: string, agentId: string) => t.setHome(userId, teamId, agentId),
    remove: (userId: string, id: string) => (typeof t.remove === 'function' ? t.remove(userId, id) : undefined),
  };
}

/** A team name that is still free for this owner ("Webshop", "Webshop 2", …). */
function freeTeamName(existing: string[], base: string): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const b = base.trim().slice(0, 56) || 'Team';
  if (!taken.has(b.toLowerCase())) return b;
  for (let i = 2; i < 100; i++) if (!taken.has(`${b} ${i}`.toLowerCase())) return `${b} ${i}`;
  return `${b} ${Date.now() % 1000}`;
}

/** Build the team package for a user: the profile from the answers, and catalogue skills when asked for. */
export function buildForUser(ctx: Ctx, userId: string, d: TemplateDef, body: any, o: { profileInInstructions?: boolean } = {}) {
  const { profile, values, warnings } = profileFromAnswers(d, body?.answers);
  const res = resolveSkills(ctx, userId, d);
  const withSkills = body?.skills === true;
  const pkg = buildPackage(d, { profile, values, skills: withSkills ? res.byBot : undefined, profileInInstructions: o.profileInInstructions });
  const missing = res.suggestions.filter((x) => !x.available);
  if (withSkills && missing.length) warnings.push(missing.length === 1 ? `1 voorgestelde skill staat niet in de catalogus en wordt overgeslagen: ${missing[0].id}.` : `${missing.length} voorgestelde skills staan niet in de catalogus en worden overgeslagen: ${missing.map((x) => x.id).join(', ')}.`);
  return { pkg, profile, warnings, suggestions: res.suggestions, withSkills };
}

/**
 * Create the team from a template: a team (teams module) with the template's bots and its lead as team lead, the
 * group chat for the team, and the business profile. All or nothing for the bots (rooms install); a new team is
 * removed again when that fails. Nothing runs by itself: routines are paused, bots ask first.
 */
export async function installForUser(ctx: Ctx, userId: string, d: TemplateDef, body: any) {
  const install = ctx.services.rooms?.installTeam;
  if (typeof install !== 'function') throw bad('Teams uit een sjabloon hebben de module Groepen en teams nodig, en die staat uit.');
  const teams = teamsApi(ctx);
  const wantName = str(body?.name, 60).trim() || d.name;
  let team: any = null;
  let createdTeam = false;
  const b = buildForUser(ctx, userId, d, body, { profileInInstructions: !teams });
  const name = teams && !body?.teamId ? freeTeamName(teams.list(userId).map((t: any) => t.name), wantName) : wantName;
  if (teams) {
    if (body?.teamId) team = teams.own(userId, str(body.teamId, 80));
    else {
      team = teams.create(userId, { name, profile: teamsProfile(b.profile) });
      createdTeam = true;
    }
  }
  let r: any;
  try {
    r = await install(userId, b.pkg, { provider_id: body?.provider_id ? str(body.provider_id, 100) : null, model: str(body?.model, 200), name, acknowledge: body?.acknowledge === true });
  } catch (e) {
    if (createdTeam) {
      try {
        teams!.remove(userId, team.id);
      } catch {
        /* an empty team stays behind only if removing fails */
      }
    }
    throw e;
  }
  const warnings = [...b.warnings, ...(r.warnings || [])];

  if (teams && team) {
    for (const a of r.agents) teams.setHome(userId, team.id, a.id);
    const lead = r.agents.find((a: any) => a.role === 'lead');
    const patch: any = {};
    if (lead && (createdTeam || !team.lead_agent_id)) patch.leadAgentId = lead.id;
    if (!createdTeam && !isEmptyProfile(b.profile)) {
      // An existing team keeps what the owner already wrote; only empty fields are filled in.
      const cur = team.profile || {};
      const np: Record<string, string> = teamsProfile(b.profile);
      const fill: Record<string, string> = {};
      for (const k of Object.keys(np)) if (np[k] && !String(cur[k] || '').trim()) fill[k] = np[k];
      if (Object.keys(fill).length) patch.profile = fill;
      if (Object.keys(fill).length < Object.values(np).filter(Boolean).length) warnings.push('Het team had al een profiel; alleen de lege velden zijn ingevuld.');
    }
    if (Object.keys(patch).length) team = teams.update(userId, team.id, patch);
  }

  // Specialists (package S): hand the field and sources over, or keep them on the bot for later. Learning stays off.
  const specialists = ctx.services.specialists;
  for (const a of r.agents) {
    const def = d.bots.find((x) => x.name === a.name);
    if (!def?.specialist) continue;
    const spec = { field: def.specialist.field, suggestedSources: [...def.specialist.suggestedSources] };
    if (typeof specialists?.importForAgent === 'function') {
      try {
        // (The bot's own settings.specialist may already have been picked up when it was made: then nothing changes.)
        if (!specialists.importForAgent(userId, a.id, spec) && !specialists.profile?.(a.id)?.enabled) warnings.push(`${a.name}: het vakgebied kon niet worden ingesteld.`);
      } catch (e: any) {
        warnings.push(`${a.name}: het vakgebied kon niet worden ingesteld (${String(e?.message || e).slice(0, 120)}).`);
      }
    } else {
      const agent = ctx.store.agent(a.id);
      if (agent) ctx.events.emit(userId, 'agent.updated', ctx.store.updateAgent(a.id, { settings: { ...(agent.settings || {}), specialist: spec } }));
    }
  }

  // The profile and where the team came from, on the group chat of the team too (the team profile is the source).
  const room = ctx.store.get<any>('rooms', r.room.id);
  // The log already has this as one plain line: the rooms install writes "team.installed" (source: sjabloon).
  ctx.store.update('rooms', r.room.id, { settings: { ...(room?.settings || {}), profile: b.profile, template: { id: d.id, version: d.version }, ...(team ? { teamId: team.id } : {}) } });
  return { teamId: team?.id || null, roomId: r.room.id, threadId: r.room.thread_id, agents: r.agents, profile: b.profile, warnings: [...new Set(warnings)] };
}

const def = (req: Request) => {
  const d = templateDef(String((req.params as any).id || ''));
  if (!d) throw notFound('Onbekend teamsjabloon');
  return d;
};

const mod: Module = {
  id: 'templates',
  label: 'Teamsjablonen',
  init(ctx: Ctx) {
    const problems = validateRegistry(TEMPLATE_DEFS);
    if (problems.length) ctx.log.warn(`[templates] problems in the team templates (${problems.length}): ${problems.slice(0, 5).join('; ')}`);

    const api = ctx.api;
    api.get('/team-templates', ah(async () => TEMPLATE_DEFS.map(summary)));
    api.get(
      '/team-templates/profile/:roomId',
      ah(async (req) => {
        const room = ctx.store.get<any>('rooms', String((req.params as any).roomId || ''));
        if (!room || room.user_id !== user(req).id) throw notFound('Team niet gevonden');
        return { profile: room.settings?.profile || null, template: room.settings?.template || null, teamId: room.settings?.teamId || null };
      }),
    );
    api.get('/team-templates/:id', ah(async (req) => detail(ctx, user(req).id, def(req))));
    api.post(
      '/team-templates/:id/preview',
      ah(async (req) => {
        const u = user(req);
        const d = def(req);
        const b = buildForUser(ctx, u.id, d, req.body, { profileInInstructions: !teamsApi(ctx) });
        const pv = previewTeam(ctx, u.id, normalizeTeam(b.pkg));
        return {
          ...pv,
          templateId: d.id,
          version: d.version,
          note: d.note || '',
          profile: b.profile,
          profileText: profileText(b.profile, d),
          skillSuggestions: b.suggestions,
          withSkills: b.withSkills,
          specialists: d.bots.filter((x) => x.specialist).map((x) => ({ bot: x.name, field: x.specialist!.field, suggestedSources: x.specialist!.suggestedSources })),
          warnings: [...new Set([...b.warnings, ...pv.warnings])],
        };
      }),
    );
    api.post('/team-templates/:id/install', ah(async (req) => installForUser(ctx, user(req).id, def(req), req.body || {})));

    ctx.services.teamTemplates = {
      /** All template definitions (data). */
      list: () => TEMPLATE_DEFS,
      get: (id: string) => templateDef(id),
      /** The questions that fill the profile of a template. */
      questions: (id: string) => templateDef(id)?.questions || [],
      /** Answers → profile (cleaned, secrets removed). */
      profileFromAnswers: (id: string, answers: unknown) => {
        const d = templateDef(id);
        return d ? profileFromAnswers(d, answers) : null;
      },
      /** The team package for a user, with the profile from `answers` and, when `skills` is true, catalogue skills. */
      build: (userId: string, id: string, body: { answers?: unknown; skills?: boolean } = {}) => {
        const d = templateDef(id);
        return d ? buildForUser(ctx, userId, d, body) : null;
      },
      /**
       * Create a team from a template (the same as POST /team-templates/:id/install): `{ answers?, skills?, name?,
       * teamId? (install into an existing team), provider_id?, model?, acknowledge? }`.
       */
      install: (userId: string, id: string, body: any = {}) => {
        const d = templateDef(id);
        if (!d) throw notFound('Onbekend teamsjabloon');
        return installForUser(ctx, userId, d, body);
      },
      /** The profile stored on a team's group chat made from a template. */
      profileFor: (roomId: string) => ctx.store.get<any>('rooms', roomId)?.settings?.profile || null,
    };
  },
};

export default mod;
