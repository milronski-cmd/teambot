import type { User } from '../../core/types.js';
import { now } from '../../core/db.js';
import type { QualityService } from './service.js';

/**
 * Skill suggestions from earlier versions, as cards for the owner (quality_suggestions): the list and his Yes or No.
 * New ones are no longer made here. A bot now lays a way of working down itself, in a short look back after a turn
 * with real work (skill-review.ts): the earlier trigger, three checked board tasks of the same kind and then a whole
 * bot turn to ask it, never came with a real team (most work is not on the board).
 */
/** What the bot is asked: lay the way of working down, or improve the skill that already holds it. */
const draftText = (title: string, count: number) =>
  [
    `Je hebt taken als “${title}” al ${count} keer goed gedaan. Leg die werkwijze vast als skill: een korte, herbruikbare werkwijze (stappen, vorm, regels) zonder geheimen, persoonsgegevens of eenmalige details. Bestaat er al een skill voor dit werk, verbeter die dan met wat je nu weet in plaats van een tweede te maken.`,
    'Gebruik daarvoor skill_save. De skill is daarna meteen actief voor het hele team; alleen als hij geld uitgeeft of zelf klanten bericht, kijk ik er eerst naar.',
  ].join('\n\n');

export function suggestions(svc: QualityService, userId: string, status = 'open') {
  return svc.ctx.store.all<any>('SELECT * FROM quality_suggestions WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 50', userId, status).map((s) => {
    const a = svc.ctx.store.agent(s.agent_id);
    return { ...s, agentName: a?.name || 'Verwijderde bot', canDraft: !!a && svc.ctx.tools.groupEnabled(a, 'skills') && a.access_mode !== 'chat' && a.access_mode !== 'readonly' };
  });
}

/** Yes: the bot is asked (as the owner, in its own chat) to draft the skill. No: the card goes away for good. */
export async function decideSuggestion(svc: QualityService, u: Pick<User, 'id' | 'name'>, id: string, accept: boolean) {
  const ctx = svc.ctx;
  const s = ctx.store.one<any>('SELECT * FROM quality_suggestions WHERE id = ? AND user_id = ?', id, u.id);
  if (!s) return { ok: false, error: 'Voorstel niet gevonden' };
  if (s.status !== 'open') return { ok: false, error: 'Dit voorstel is al afgehandeld' };
  const agent = ctx.store.agent(s.agent_id);
  if (accept) {
    if (!agent || agent.user_id !== u.id) return { ok: false, error: 'Deze bot bestaat niet meer' };
    if (!ctx.tools.groupEnabled(agent, 'skills') || agent.access_mode === 'chat' || agent.access_mode === 'readonly')
      return { ok: false, error: `${agent.name} kan geen skill voorstellen: zet bij de bot "Skills" aan en geef hem meer dan alleen lezen.` };
  }
  ctx.store.exec('UPDATE quality_suggestions SET status = ?, decided_at = ? WHERE id = ?', accept ? 'accepted' : 'dismissed', now(), id);
  let sent: any = null;
  if (accept && agent) {
    sent = await svc.tellBot(u, agent, draftText(s.title, s.count), { kind: 'skill_suggestion', suggestionId: id });
  }
  ctx.audit(u.id, accept ? 'quality.skill_accepted' : 'quality.skill_dismissed', { suggestionId: id, title: s.title }, s.agent_id);
  ctx.events.emit(u.id, 'quality.changed', { suggestion: id });
  return { ok: true, sent };
}
