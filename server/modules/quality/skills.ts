import type { Agent, User } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import type { QualityService } from './service.js';

/**
 * A bot that does the same kind of task well, again and again, lays that way of working down as a skill, by itself:
 * TeamBot asks it to (in its own chat), and the skill is active for its team at once (a draft for the owner only when
 * it spends money or writes to customers, as every skill a bot saves). No card, no click.
 *
 * Taken over from the other agent systems (compared on their code, 12 Nov 2026): Hermes lets the agent write and
 * improve its own skills after the work, and OpenClaw, OpenMausBot and OpenBot each have a review after the work that
 * can write one. TeamBot counted the good runs and then waited on a card for the owner; in real use that card was
 * one more question to him and the learning stopped there. A bot that cannot save a skill (skills off, or reading
 * only) still gets the card, so the owner sees there is something to gain.
 */

/** How many checked-and-done tasks of the same kind before a suggestion. */
export const SKILL_AFTER = 3;
const WINDOW_DAYS = 90;

const STOP = new Set(
  'de het een en of van voor op in aan met naar bij uit over om te tot door als dan dat die dit deze wat wie the a an and or of for to in on with at by from week maand dag jaar vandaag morgen nieuwe nieuw januari februari maart april mei juni juli augustus september oktober november december maandag dinsdag woensdag donderdag vrijdag zaterdag zondag'.split(' '),
);

/** "Weekrapport SEO 12 november" → "weekrapport seo": the kind of task, without dates, numbers and small words. */
export function taskKey(title: string): string {
  const words = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return words.slice(0, 3).join(' ');
}

export function maybeSuggestSkill(svc: QualityService, userId: string, agent: Agent, title: string) {
  const key = taskKey(title);
  if (!key || key.split(' ').length < 1) return null;
  const ctx = svc.ctx;
  if (ctx.store.one('SELECT 1 FROM quality_suggestions WHERE user_id = ? AND agent_id = ? AND kind = ? AND key = ?', userId, agent.id, 'skill', key)) return null;
  const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();
  const done = ctx.store
    .all<any>("SELECT title FROM quality_tasks WHERE user_id = ? AND reported_by = ? AND kind IN ('room','teamdata') AND check_state IN ('passed','owner') AND updated_at >= ?", userId, agent.id, since)
    .filter((r) => taskKey(r.title) === key);
  if (done.length < SKILL_AFTER) return null;
  const owner = ctx.store.user(userId);
  const self = !!owner && ctx.tools.groupEnabled(agent, 'skills') && agent.access_mode !== 'chat' && agent.access_mode !== 'readonly';
  const s = {
    id: newId('qs_'),
    user_id: userId,
    agent_id: agent.id,
    kind: 'skill',
    key,
    title: title.slice(0, 200),
    body: `${agent.name} deed taken als “${title.slice(0, 120)}” al ${done.length} keer goed, gecontroleerd. Een skill legt die werkwijze vast, zodat het elke keer zo gaat.`,
    count: done.length,
    status: self ? 'accepted' : 'open',
    created_at: now(),
  };
  ctx.store.exec('INSERT OR IGNORE INTO quality_suggestions (id, user_id, agent_id, kind, key, title, body, count, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', s.id, s.user_id, s.agent_id, s.kind, s.key, s.title, s.body, s.count, s.status, s.created_at);
  if (self) {
    // The bot writes it itself, now: the same request the owner's "Ja" used to send.
    void svc.tellBot(owner!, agent, draftText(s.title, s.count), { kind: 'skill_suggestion', suggestionId: s.id }).catch((e: any) => ctx.log.warn('[quality] skill', e?.message || e));
    ctx.audit(userId, 'quality.skill_self', { suggestionId: s.id, title: s.title }, agent.id);
  } else ctx.events.emit(userId, 'notification', { title: `${agent.name} kan hier een skill van maken`, body: s.body, link: '#/inbox', kind: 'skill' });
  ctx.events.emit(userId, 'quality.changed', { suggestion: s.id });
  return s;
}

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
