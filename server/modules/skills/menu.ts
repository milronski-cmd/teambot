import type { Agent, Ctx, Message } from '../../core/types.js';
import { ah, notFound, str, user } from '../../core/http.js';
import { canSeeThread } from '../../api/threads.js';
import type { SkillLibrary, SkillRow } from './library.js';
import { tokens } from '../memory/text.js';

/**
 * The "/" and "$" menu in the composer. The app lists the skills of the conversation's bot(s); a picked skill stays in
 * the message as "/name" or "$name", and this module tells the bot for that turn to load and follow it (also for CLI
 * engines: the turn context is frozen into the user message). Works the same from the phone.
 */

const TOKEN = /(?:^|\s)[/$]([\p{L}\p{N}][\p{L}\p{N}._-]{0,79})(?=$|[\s,.!?:;])/gu;

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Skills of this bot that the message picks with "/name" or "$name" (at most 3, in order). */
export function pickedSkills(lib: SkillLibrary, agent: Agent, text: string): SkillRow[] {
  const enabled = lib.enabledFor(agent);
  if (!enabled.length || !text) return [];
  const out: SkillRow[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const want = m[1].toLowerCase();
    const s = enabled.find((x) => x.name.toLowerCase() === want) || enabled.find((x) => slug(x.name) === slug(want));
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}

export function skillChoiceContext(ctx: Ctx, lib: SkillLibrary, agent: Agent, input: Message | null): string | null {
  if (!input || input.role !== 'user') return null;
  const picked = pickedSkills(lib, agent, String(input.content || ''));
  if (!picked.length) return null;
  const names = picked.map((s) => `“${s.name}”`).join(' en ');
  const toolsOk = agent.access_mode !== 'chat' && ctx.tools.groupEnabled(agent, 'skills');
  return toolsOk
    ? `De gebruiker koos voor dit bericht de skill ${names} (met / of $ in het bericht). Laad ${picked.length > 1 ? 'die' : 'hem'} eerst (met je eigen skill-tool als je die hebt, anders met skill_load) en volg de instructies bij dit verzoek.`
    : `De gebruiker koos voor dit bericht de skill ${names} (met / of $ in het bericht). Volg de instructies van die skill uit je instructies hierboven.`;
}

/** At most this many skills are named for a turn; the best fits first. */
const FIT_MAX = 6;
const FIT_DESCRIBED = 3;

/**
 * The bot's own skills, named with the work they are for, on every turn that brings work. A bot has its skills (the
 * engine lists them, or TeamBot's instructions do) and may load one whenever it likes; live (20 Nov 2026) twenty bots
 * with 49 skills between them did some 7,000 steps in a night and did not load a skill once. Being allowed to is not
 * the same as being pointed to it at the moment the work arrives, so the turn says which of its skills fit this
 * work and that it starts with one. Words the task shares with a skill put that skill first; with none shared the
 * bot's skills are named in their own order (a bot has the handful that belong to its role).
 */
export function skillFitContext(ctx: Ctx, lib: SkillLibrary, agent: Agent, input: Message | null): string | null {
  if (!input || input.role !== 'user' || agent.access_mode === 'chat') return null;
  const text = String(input.content || '');
  if (text.replace(/\s+/g, ' ').trim().length < 40) return null;
  const mine = lib.enabledFor(agent);
  if (!mine.length || pickedSkills(lib, agent, text).length) return null;
  const task = new Set(tokens(text, 400));
  const ranked = mine
    .map((s, n) => ({ s, n, hit: tokens(`${s.name.replace(/[-_]+/g, ' ')} ${s.description || ''}`, 200).filter((w) => task.has(w)).length }))
    .sort((x, y) => y.hit - x.hit || x.n - y.n)
    .slice(0, FIT_MAX);
  const names = ranked.map((r, i) => (i < FIT_DESCRIBED && r.s.description ? `${r.s.name} (${String(r.s.description).replace(/\s+/g, ' ').trim().slice(0, 110)})` : r.s.name));
  const more = mine.length - ranked.length;
  return `Je skills voor dit werk: ${names.join('; ')}${more > 0 ? `; en nog ${more}` : ''}. Hoort deze opdracht bij een van deze skills, pak die er dan eerst bij (je eigen skill-tool als je die hebt, anders skill_load) en werk volgens zijn stappen; zeg in je antwoord welke skill je gebruikte. Past er geen, werk dan zonder.`;
}

export function skillMenuRoutes(ctx: Ctx, lib: SkillLibrary) {
  /** The skills the bot(s) of a conversation may use: name and description only (also on a paired phone). */
  ctx.api.get(
    '/skills/menu',
    ah(async (req) => {
      const u = user(req);
      const t = ctx.store.thread(str(req.query.threadId, 80));
      if (!canSeeThread(u.id, t)) throw notFound('Gesprek niet gevonden');
      let agentIds: string[] = t.agent_id ? [t.agent_id] : [];
      if (!agentIds.length && t.room_id) {
        try {
          // Bots are room members of kind "agent" (round 6: "bot" here left the / and $ menu empty in every group).
          agentIds = ctx.store.all<{ ref_id: string }>("SELECT ref_id FROM room_members WHERE room_id = ? AND kind = 'agent' ORDER BY sort", t.room_id).map((r) => r.ref_id);
        } catch {
          agentIds = [];
        }
      }
      const multi = agentIds.length > 1;
      const out = new Map<string, { name: string; description: string; bots: string[] }>();
      for (const id of agentIds) {
        const a = ctx.store.agent(id);
        if (!a || a.user_id !== t.user_id) continue;
        for (const s of lib.enabledFor(a)) {
          const row = out.get(s.name) || { name: s.name, description: String(s.description || '').replace(/\s+/g, ' ').trim().slice(0, 200), bots: [] };
          if (multi) row.bots.push(a.name);
          out.set(s.name, row);
        }
      }
      return { skills: [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'nl')) };
    }),
  );
  if (!Array.isArray(ctx.services.mobileRoutes)) ctx.services.mobileRoutes = [];
  ctx.services.mobileRoutes.push({ method: 'GET', path: '/skills/menu' });
}
