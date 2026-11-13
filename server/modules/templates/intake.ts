import type { Ctx } from '../../core/types.js';
import { emptyProfile, fillPlaceholders, placeholdersIn, profileFromAnswers, teamsProfile } from './profile.js';
import { templateDef } from './registry.js';
import type { ProfileQuestion, TeamProfile, TemplateDef } from './types.js';

/**
 * The questions of a template are asked in the chat, not in a form: a team from a template starts with an empty
 * profile, and the owner's main bot (hoofdbot) asks the same questions one at a time and writes every answer down.
 *  - `fillTeamProfile`: answers by question key → the team's business profile (the main bot's tool team_profile);
 *  - `startIntake`: right after the team is made in the app, the main bot starts by itself in its own chat;
 *  - `intakeContext`: the instruction for that turn (welcome, the questions, a first task to propose).
 */

/** The group chat a team was made with from a template, with that template (null: the team is not from a template). */
function templateRoom(ctx: Ctx, userId: string, teamId: string): { room: any; def: TemplateDef } | null {
  for (const room of ctx.store.find<any>('rooms', { user_id: userId })) {
    if (room.settings?.teamId !== teamId || !room.settings?.template?.id) continue;
    const def = templateDef(String(room.settings.template.id));
    if (def) return { room, def };
  }
  return null;
}

/** The answers behind a stored profile (teams made before the answers were kept by key). */
function valuesOf(def: TemplateDef, p: TeamProfile): Record<string, string> {
  const v: Record<string, string> = {};
  for (const q of def.questions) {
    const x = q.profile === 'extra' ? p.extra.find((e) => e.key === q.key)?.value : p[q.profile];
    if (x) v[q.key] = x;
  }
  return v;
}

export interface TemplateQuestions {
  def: TemplateDef;
  /** Answers so far, by question key. */
  values: Record<string, string>;
  /** Questions without an answer yet, in the template's order. */
  open: ProfileQuestion[];
}

/** The template questions of a team and what is answered so far; null for a team that is not from a template. */
export function teamQuestions(ctx: Ctx, userId: string, teamId: string): TemplateQuestions | null {
  const tr = templateRoom(ctx, userId, teamId);
  if (!tr) return null;
  const s = tr.room.settings;
  const values: Record<string, string> = s.answers && typeof s.answers === 'object' ? { ...s.answers } : valuesOf(tr.def, { ...emptyProfile(), ...(s.profile || {}) });
  return { def: tr.def, values, open: tr.def.questions.filter((q) => !values[q.key]) };
}

/**
 * Write answers to a template's questions (by question key) into the team's business profile. Earlier answers stay; an
 * empty answer clears that one. What the owner wrote in the profile by hand is kept: a new answer is then added to
 * "about" as its own line. Routine prompts of the team that waited for an answer ("nog niet ingevuld") get it too.
 * Returns null for a team that is not from a template.
 */
export function fillTeamProfile(ctx: Ctx, userId: string, teamId: string, answers: unknown): (TemplateQuestions & { saved: string[]; unknown: string[]; warnings: string[] }) | null {
  const teams = ctx.services.teams;
  const cur = teamQuestions(ctx, userId, teamId);
  const tr = templateRoom(ctx, userId, teamId);
  if (!cur || !tr || !teams) return null;
  const def = cur.def;
  const given = answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {};
  const known = new Set(def.questions.map((q) => q.key));
  const unknown = Object.keys(given).filter((k) => !known.has(k));
  const touched = def.questions.filter((q) => typeof given[q.key] === 'string');
  const before = profileFromAnswers(def, cur.values);
  const after = profileFromAnswers(def, { ...cur.values, ...Object.fromEntries(touched.map((q) => [q.key, given[q.key]])) });
  const saved = touched.filter((q) => (after.values[q.key] || '') !== (cur.values[q.key] || '')).map((q) => q.key);

  if (saved.length) {
    const team = teams.own(userId, teamId);
    const was = teamsProfile(before.profile);
    const now = teamsProfile(after.profile);
    const patch: Record<string, string> = {};
    const fields = new Set(touched.filter((q) => saved.includes(q.key)).map((q) => q.profile));
    if (fields.has('name')) patch.company = now.company;
    if (fields.has('tone')) patch.tone = now.tone;
    if (fields.has('rules')) patch.rules = now.rules;
    if (fields.has('business') || fields.has('extra')) {
      const about = String(team.profile?.about || '').trim();
      if (!about || about === was.about.trim()) patch.about = now.about;
      else {
        // The owner changed "about" by hand: keep it and add the new answers as their own lines.
        const add = touched
          .filter((q) => saved.includes(q.key) && (q.profile === 'business' || q.profile === 'extra') && after.values[q.key])
          .map((q) => (q.profile === 'extra' ? `${q.short || q.label}: ${after.values[q.key]}` : after.values[q.key]))
          .filter((line) => !about.includes(line));
        if (add.length) patch.about = [about, ...add].join('\n');
      }
    }
    if (Object.keys(patch).length) teams.update(userId, teamId, { profile: patch });
    ctx.store.update('rooms', tr.room.id, { settings: { ...(ctx.store.get<any>('rooms', tr.room.id)?.settings || {}), profile: after.profile, answers: after.values } });
    refillRoutines(ctx, userId, teamId, def, before.values, after.values);
  }
  return { def, values: after.values, open: def.questions.filter((q) => !after.values[q.key]), saved, unknown, warnings: after.warnings };
}

/** Routine prompts made from the template with `{key}` in them: the same prompt with the answers of now. */
function refillRoutines(ctx: Ctx, userId: string, teamId: string, def: TemplateDef, before: Record<string, string>, after: Record<string, string>) {
  const routines = ctx.services.routines;
  if (typeof routines?.list !== 'function' || typeof routines.engine?.update !== 'function') return;
  const defs = def.bots.flatMap((b) => b.routines || []).filter((r) => placeholdersIn(r.prompt).length);
  if (!defs.length) return;
  for (const agentId of ctx.services.teams.botsOf(teamId) as string[]) {
    for (const r of routines.list(userId, agentId) as any[]) {
      const d = defs.find((x) => x.name === r.name && fillPlaceholders(x.prompt, before) === r.prompt);
      const next = d ? fillPlaceholders(d.prompt, after) : '';
      if (!d || next === r.prompt) continue;
      try {
        routines.engine.update(r, { prompt: next });
      } catch (e) {
        ctx.log.warn(`[templates] routine "${r.name}" kept its old text: ${(e as any)?.message || e}`);
      }
    }
  }
}

/** One question as a line for the main bot: the key it writes the answer under, the question, and an example. */
export const questionLine = (q: ProfileQuestion) => `- ${q.key} — ${q.label}${q.placeholder ? ` (bijvoorbeeld: ${q.placeholder.replace(/\s*\n\s*/g, ' ')})` : ''}`;

/**
 * The instruction for the main bot's first turn about a new team: a short welcome, the template's questions one at a
 * time (each answer written down with team_profile), and at the end a proposal for a first task.
 */
export function intakeText(ctx: Ctx, userId: string, teamId: string): string | null {
  const teams = ctx.services.teams;
  const team = teams?.team?.(teamId);
  const q = teamQuestions(ctx, userId, teamId);
  if (!team || team.user_id !== userId || !q) return null;
  const lead = team.lead_agent_id ? ctx.store.agent(team.lead_agent_id) : null;
  const mainId = teams.mainOf(userId);
  const bots = (teams.botsOf(teamId) as string[])
    .filter((id) => id !== mainId)
    .map((id) => ctx.store.agent(id))
    .filter((a): a is NonNullable<typeof a> => !!a && !a.archived)
    .map((a) => `${a.name}${a.role ? ` (${a.role})` : ''}`);
  const examples = q.def.examples.slice(0, 3).map((e) => `- ${e.task}`);
  return [
    `Nieuw team: de eigenaar heeft zojuist team “${team.name}” gemaakt uit het sjabloon “${q.def.name}”.${lead ? ` Teamleider: ${lead.name}.` : ''}${bots.length ? ` Bots: ${bots.join(', ')}.` : ''}`,
    'Het profiel van het team is nog leeg. Begin nu zelf; de eigenaar heeft nog niets gevraagd:',
    `1. Heet de eigenaar in één of twee zinnen welkom en noem het team${lead ? ' en de teamleider' : ''}.`,
    '2. Stel in hetzelfde bericht de eerste vraag hieronder. Daarna steeds één vraag per bericht, kort en in gewone taal.',
    `3. Schrijf elk antwoord meteen op met team_profile (team: “${team.name}”, answers: { sleutel: antwoord }). Wil de eigenaar een vraag niet beantwoorden, sla hem dan over en ga door.`,
    `4. Na de laatste vraag: doe zelf een voorstel voor een eerste taak voor het team en vraag of je die aan ${lead ? lead.name : 'het team'} zal geven.`,
    q.open.length ? 'Vragen (sleutel — vraag):' : 'Alle vragen zijn al beantwoord: ga meteen naar stap 4.',
    ...q.open.map(questionLine),
    ...(examples.length ? ['Voorbeelden van een eerste taak:', ...examples] : []),
  ].join('\n');
}

/** Per-turn context hook: the intake instruction, for the main bot's turn on the "new team" message. */
export function intakeContext(ctx: Ctx, agentId: string, userId: string, input: { parts?: any } | null): string | null {
  const it = input?.parts?.teamIntake;
  if (!it?.teamId || ctx.services.teams?.mainOf?.(userId) !== agentId) return null;
  return intakeText(ctx, userId, String(it.teamId));
}

/**
 * The main bot starts by itself in its own chat about the new team: one plain line from TeamBot ("Team … is gemaakt"),
 * then a turn of the main bot with the intake instruction as context (as a resumed run starts on a system message).
 * Returns the chat to open, or null when there is no main bot to start.
 */
export function startIntake(ctx: Ctx, userId: string, teamId: string): { agentId: string; threadId: string } | null {
  const teams = ctx.services.teams;
  const team = teams?.team?.(teamId);
  const mainId = teams?.mainOf?.(userId);
  const main = mainId ? ctx.store.agent(mainId) : null;
  if (!team || team.user_id !== userId || !main || main.archived) return null;
  const thread = ctx.chat.threadForAgent(userId, main.id);
  if (!teamQuestions(ctx, userId, teamId)) return { agentId: main.id, threadId: thread.id };
  const lead = team.lead_agent_id ? ctx.store.agent(team.lead_agent_id) : null;
  const sys = ctx.store.createMessage({
    thread_id: thread.id,
    role: 'system',
    author_type: 'system',
    author_name: 'TeamBot',
    content: `Team “${team.name}” is gemaakt.${lead ? ` Teamleider: ${lead.name}.` : ''}`,
    parts: { teamIntake: { teamId } } as any,
  });
  ctx.chat.emitMessage(thread, sys);
  ctx.chat.startAgent(thread, main.id, sys.id, 'intake', { teamIntake: teamId });
  return { agentId: main.id, threadId: thread.id };
}
