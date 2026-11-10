import { encodeFace, type FaceColor } from '../../../shared/botface.js';
import { TEAM_FORMAT, type TeamPackage } from '../rooms/packages.js';
import type { TemplateSkill } from '../skills/templates.js';
import { fillPlaceholders } from './profile.js';
import { botInstructions, teamInstructions } from './render.js';
import type { BotDef, TeamProfile, TemplateDef } from './types.js';

/** Accent colour per face colour: a deeper tone of the same hue that stays readable on a light background. */
const ACCENT: Record<FaceColor, string> = {
  coral: '#e5484d',
  tangerine: '#ea580c',
  sun: '#ca8a04',
  lime: '#65a30d',
  mint: '#059669',
  teal: '#0891b2',
  sky: '#2563eb',
  cobalt: '#4f46e5',
  violet: '#7c3aed',
  grape: '#a21caf',
  pink: '#db2777',
  slate: '#64748b',
};

export const accentOf = (c: FaceColor) => ACCENT[c];

/** Team limits: the defaults, with one hop of delegation less (lead → helper; helpers do not pass work on). */
export const TEAM_LIMITS = { maxTurnsPerMessage: 8, maxDelegationDepth: 2 };

/** Group permissions: the lead may write the team files; helpers read them and do not hand work to other bots. */
export const LEAD_PERMS = { files: 'write' as const };
export const HELPER_PERMS = { files: 'read' as const, delegate: false };

export interface BuildOptions {
  /** The filled business profile (goes into the team instructions). */
  profile?: TeamProfile | null;
  /** Answers by question key, for `{key}` in routine prompts. */
  values?: Record<string, string>;
  /** Catalogue skills to install, per bot name (resolved by ./skills.ts). */
  skills?: Record<string, TemplateSkill[]>;
  /**
   * Put the profile in the team (group) instructions. Off when the teams module holds the profile: that one reaches
   * every bot of the team in every conversation, so a copy in the group instructions would only double it.
   */
  profileInInstructions?: boolean;
}

/** A bot template (`teambot.bot-template/v1`), as the skills module installs it. */
export function botTemplate(def: TemplateDef, bot: BotDef, values: Record<string, string> = {}) {
  return {
    format: 'teambot.bot-template/v1',
    name: bot.name,
    role: bot.role,
    description: bot.description,
    instructions: botInstructions(def, bot),
    avatar: encodeFace(bot.face),
    color: ACCENT[bot.face.color],
    access_mode: 'ask',
    tool_groups: [...bot.tools],
    reasoning: '',
    busy_policy: 'queue' as const,
    settings: {},
    model_hint: '',
    skills: [],
    // Routines always come in paused (routines.importForAgent); the timezone is the owner's own.
    routines: (bot.routines || []).map((r) => ({
      name: r.name,
      prompt: fillPlaceholders(r.prompt, values),
      schedule: r.schedule,
      options: { missedPolicy: 'skip', maxRunsPerDay: 1, notify: 'always', timeoutMinutes: 20, ...(r.options || {}) },
    })),
    // Optional specialist field and sources for package S; learning stays off until the owner turns it on.
    ...(bot.specialist ? { specialist: { field: bot.specialist.field, suggestedSources: [...bot.specialist.suggestedSources] } } : {}),
    meta: { template_id: def.id, template_version: def.version, ...(bot.specialist ? { specialist: { field: bot.specialist.field, suggestedSources: [...bot.specialist.suggestedSources] } } : {}) },
  };
}

/**
 * The template as a team package (`teambot.team/v1`): the same format as an exported team, so the rooms module
 * previews and installs it with its usual rules.
 */
export function buildPackage(def: TemplateDef, o: BuildOptions = {}): TeamPackage & { id: string } {
  const values = o.values || {};
  const skills: TemplateSkill[] = [];
  const bots = def.bots.map((b) => {
    const own = o.skills?.[b.name] || [];
    for (const sk of own) if (!skills.some((x) => x.name === sk.name)) skills.push(sk);
    return { role: b.lead ? ('lead' as const) : ('member' as const), perms: b.lead ? { ...LEAD_PERMS } : { ...HELPER_PERMS }, template: botTemplate(def, b, values), skillRefs: own.map((x) => x.name) };
  });
  return {
    id: def.id,
    format: TEAM_FORMAT,
    name: def.name,
    description: def.description,
    mode: 'lead',
    instructions: teamInstructions(def, o.profileInInstructions === false ? null : o.profile),
    limits: { ...TEAM_LIMITS },
    bots,
    skills,
    meta: { builtin: true, template_id: def.id, template_version: def.version, category: def.category },
  };
}
