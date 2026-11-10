import type { Agent, User } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import type { QualityService } from './service.js';

/**
 * A bot that does the same kind of task well, again and again, may suggest turning it into a skill (a fixed way of
 * working). TeamBot only *suggests*: a card under "Wacht op jou". Saying yes asks the bot (in its own chat) to draft
 * one with skill_draft; that draft goes through the normal review in Mijn skills. Nothing is installed by itself.
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
  const s = {
    id: newId('qs_'),
    user_id: userId,
    agent_id: agent.id,
    kind: 'skill',
    key,
    title: title.slice(0, 200),
    body: `${agent.name} deed taken als “${title.slice(0, 120)}” al ${done.length} keer goed, gecontroleerd. Een skill legt die werkwijze vast, zodat het elke keer zo gaat.`,
    count: done.length,
    status: 'open',
    created_at: now(),
  };
  ctx.store.exec('INSERT OR IGNORE INTO quality_suggestions (id, user_id, agent_id, kind, key, title, body, count, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', s.id, s.user_id, s.agent_id, s.kind, s.key, s.title, s.body, s.count, s.status, s.created_at);
  ctx.events.emit(userId, 'notification', { title: `${agent.name} kan hier een skill van maken`, body: s.body, link: '#/inbox', kind: 'skill' });
  ctx.events.emit(userId, 'quality.changed', { suggestion: s.id });
  return s;
}

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
    const text = [
      `Je hebt taken als “${s.title}” al ${s.count} keer goed gedaan. Maak er een skill van: een korte, herbruikbare werkwijze (stappen, vorm, regels) zonder geheimen, persoonsgegevens of eenmalige details.`,
      'Gebruik daarvoor skill_draft. Het wordt een concept; ik beoordeel het zelf in Mijn skills voordat het actief wordt.',
    ].join('\n\n');
    sent = await svc.tellBot(u, agent, text, { kind: 'skill_suggestion', suggestionId: id });
  }
  ctx.audit(u.id, accept ? 'quality.skill_accepted' : 'quality.skill_dismissed', { suggestionId: id, title: s.title }, s.agent_id);
  ctx.events.emit(u.id, 'quality.changed', { suggestion: id });
  return { ok: true, sent };
}
