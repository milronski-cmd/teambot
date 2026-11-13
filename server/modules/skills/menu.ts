import type { Agent, Ctx, Message } from '../../core/types.js';
import { ah, notFound, str, user } from '../../core/http.js';
import { canSeeThread } from '../../api/threads.js';
import type { SkillLibrary, SkillRow } from './library.js';

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
