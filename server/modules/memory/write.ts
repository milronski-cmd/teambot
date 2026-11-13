/**
 * The one way into memory: text into a dossier.
 *
 * Whoever captures something — a bot with its tool, the background review of a conversation, a lesson, the owner in
 * Geheugen, an import — ends here. `writeNote` puts lines into one dossier by the one rule (same.ts): what the dossier
 * already says is not written again, a line about the same thing with another value takes the place of the older one
 * (which goes to the dossier's archive), the rest is added. The dossier's size limit holds for everyone: a bot is told
 * the numbers and makes the dossier shorter itself; a write nobody is there to shorten for (the review, a lesson)
 * keeps the line in the dossier's archive, where memory_search finds it.
 *
 * `dossierWrite` is the tool dossier_write, as a function: the background review calls exactly this, so a bot's own
 * write and the review give the same result for the same input.
 */
import type { Agent } from '../../core/types.js';
import { nlCount } from '../../core/i18n.js';
import type { MemoryService } from './service.js';
import type { Reader, Scope } from './types.js';
import { ALL_TEAMS } from './types.js';
import { clean } from './text.js';
import { findIn, lineKey } from './same.js';
import { createDossier, findDossier } from './dossiers.js';
import { DossierFull, NEARLY_FULL, WriteRefused, addToBody, archiveLines, coreDossiers, limitOf, linesRefusal, notesDossier, ownerDossier, replaceInBody, teamDossier, tidyBody, writeBody, writeRefusal, type CoreKind, type WriteActor } from './living.js';

export interface NoteIn {
  /** The dossier the text goes into (its row). */
  dossier: any;
  text: string;
  /** The heading it comes under (made when missing). */
  section?: string | null;
  /** The subject of the line when the writer knows it ("woonplaats"): a line about that subject is replaced. */
  key?: string | null;
  actor: WriteActor;
  /** A full dossier: refuse with the numbers (a bot makes it shorter itself), or keep the line in the dossier's archive. */
  full?: 'refuse' | 'archive';
}

export interface NoteOut {
  action: 'added' | 'replaced' | 'same' | 'archived' | 'refused';
  reason?: 'secret' | 'injection' | 'forgotten' | 'full' | 'idempotent';
  dossier: any;
  changeId: string | null;
  /** Lines that left the text for the archive (replaced lines; the new lines themselves when the dossier was full). */
  archived: number;
  message: string;
}

/** The core dossier a kind of memory belongs in: about the owner, for the team, a lesson, a bot's own. */
export function placeOf(scope: Scope, type?: string | null): CoreKind {
  if (scope === 'about_you') return 'owner';
  if (scope === 'agent') return 'notes';
  return type === 'lesson' ? 'lessons' : 'overview';
}

/** That dossier (made when missing). Null: a bot's own notes without a bot. */
export function dossierAt(svc: MemoryService, userId: string, place: CoreKind, o: { agent?: Agent | null; teamId?: string | null } = {}): any | null {
  if (place === 'owner') return ownerDossier(svc, userId);
  if (place === 'notes') return o.agent && o.agent.user_id === userId ? notesDossier(svc, o.agent) : null;
  // What the owner gives every team lives with the owner: his dossier is the one all teams read.
  if (o.teamId === ALL_TEAMS) return ownerDossier(svc, userId);
  return teamDossier(svc, userId, place, o.teamId ?? null);
}

/** Lines of text into a dossier, by the one rule. Never throws for a refusal: the outcome says what happened. */
export function writeNote(svc: MemoryService, n: NoteIn): NoteOut {
  const d = n.dossier;
  const base = { dossier: d, changeId: null, archived: 0 };
  const where = `dossier “${d.title}” [d:${d.ref}]`;
  if (n.actor.idemKey && svc.store.one('SELECT 1 FROM memory_changes WHERE user_id = ? AND idem_key = ? LIMIT 1', d.user_id, n.actor.idemKey)) return { ...base, action: 'same', reason: 'idempotent', message: 'Al verwerkt.' };
  const next = addToBody(String(d.body || ''), n.text, n.section, n.key);
  if (!next) return { ...base, action: 'same', message: `Dat stond al in ${where}; er is niets gewijzigd.` };
  try {
    const w = writeBody(svc, d.id, next.body, n.actor);
    const size = String(w.dossier.body || '').length;
    return { action: next.added ? 'added' : 'replaced', dossier: w.dossier, changeId: w.changeId, archived: w.archived, message: `In ${where} gezet (${size}/${limitOf(w.dossier)} tekens)${next.replaced ? '; wat er eerder over stond, is vervangen en staat in het archief van het dossier' : ''}.` };
  } catch (e: any) {
    if (e instanceof WriteRefused) return { ...base, action: 'refused', reason: e.reason, message: e.message };
    if (!(e instanceof DossierFull)) throw e;
    if (n.full !== 'archive') return { ...base, action: 'refused', reason: 'full', message: e.message };
    // Nobody is here to make the dossier shorter: the lines are kept in its archive (searchable), and the bots see
    // in their next turn that the dossier is full.
    const lines = tidyBody(n.text).split('\n').map((l) => l.trim()).filter((l) => lineKey(l) && !/^#{1,6}\s/.test(l));
    const refusal = linesRefusal(svc, d.user_id, lines, n.actor);
    if (refusal) return { ...base, action: 'refused', reason: refusal.reason, message: refusal.message };
    const r = svc.store.tx(() => archiveLines(svc, d, lines, n.actor, { batchId: n.actor.batchId ?? null, title: 'Paste niet meer in het dossier' }));
    svc.emit(d.user_id, { op: 'update', kind: 'dossier', ids: [d.id], dossierId: d.id, changeId: r.changeId });
    fullNotice(svc, d);
    return { action: 'archived', reason: 'full', dossier: d, changeId: r.changeId, archived: r.archived, message: `Het ${where} is vol; dit staat nu in het archief van het dossier (vindbaar met memory_search).` };
  }
}

const noticed = new Map<string, string>();
/**
 * A dossier is full and what came in went to its archive (nobody was there to make it shorter): the owner is told, once
 * a day per dossier, so nothing goes out of sight silently. The bots see it in the dossier itself.
 */
function fullNotice(svc: MemoryService, d: any) {
  const day = new Date().toISOString().slice(0, 10);
  if (noticed.get(d.id) === day) return;
  noticed.set(d.id, day);
  svc.ctx.events.emit(d.user_id, 'notification', { title: 'Geheugen vol', body: `Dossier “${d.title}” is vol. Wat er nu bij kwam, staat in het archief van het dossier (je bots vinden het met zoeken) tot het korter is. Je bots maken het korter als ze eraan werken; je kunt het ook zelf inkorten in Geheugen.`, link: '#/m/memory/dossiers', kind: 'memory' });
}

/** The heading in a team's overview for what the owner told this team about himself (several teams). */
export const OWNER_HERE = 'Over de eigenaar';

/** Names a bot may use for its core dossiers ("eigenaar", "overzicht", "lessen", "notities"). */
const CORE_NAMES: Record<string, CoreKind> = {
  eigenaar: 'owner',
  owner: 'owner',
  'over jou': 'owner',
  'over de eigenaar': 'owner',
  profiel: 'owner',
  overzicht: 'overview',
  overview: 'overview',
  lessen: 'lessons',
  lessons: 'lessons',
  werknotities: 'notes',
  notities: 'notes',
  notes: 'notes',
  'mijn notities': 'notes',
  'mijn werknotities': 'notes',
};

/** The dossier a bot means: one of its core dossiers by its plain name, else by id or title among what it may read. */
export function dossierFor(svc: MemoryService, agent: Agent, reader: Reader, name: string, exact = false): any | null {
  const n = String(name || '').trim().toLowerCase();
  const core = CORE_NAMES[n];
  if (core) return coreDossiers(svc, agent).find((d) => d.core === core) || null;
  const d = findDossier(svc, reader, name);
  // Writing: the id or the whole title, never a title that merely contains the name ("Jans" is not "Jansen").
  if (d && exact && !/^d:/i.test(n) && d.title.trim().toLowerCase() !== n && d.ref !== n && d.id !== name.trim()) return null;
  return d;
}

export interface DossierWriteArgs {
  dossier: string;
  content: string;
  mode?: string;
  old_text?: string;
  section?: string;
  kind?: string;
}

/**
 * The lines a dossier_write would put into a dossier that its text does not say yet (the one rule; a heading is no
 * line). Empty: the write only takes out, merges or reorders what is there.
 */
export function newLines(body: string, a: Pick<DossierWriteArgs, 'content'>): string[] {
  const old = String(body || '').split('\n');
  return tidyBody(a.content)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => lineKey(l) && !/^#{1,6}\s/.test(l) && findIn(l, old).verdict !== 'same');
}

export interface DossierWriteResult {
  text: string;
  isError?: boolean;
  data?: { dossier: string; size: number; limit: number };
  /** What happened, for callers that count (the review). */
  action: NoteOut['action'] | 'rewritten' | 'invalid';
  changeId?: string | null;
}

/**
 * dossier_write: add to a dossier (the one rule decides what is new), replace a piece of its text, or rewrite it. A
 * name that is no dossier yet makes one, for the whole team — unless `create` is false (the review never makes one).
 */
export function dossierWrite(svc: MemoryService, agent: Agent, reader: Reader, a: DossierWriteArgs, actor: WriteActor, o: { full?: 'refuse' | 'archive'; create?: boolean; allTeams?: boolean } = {}): DossierWriteResult {
  const name = String(a.dossier || '').trim();
  const mode = ['add', 'replace', 'rewrite'].includes(String(a.mode)) ? String(a.mode) : a.old_text ? 'replace' : 'add';
  const content = String(a.content ?? '');
  const bad = (text: string): DossierWriteResult => ({ text, isError: true, action: 'invalid' });
  if (mode !== 'replace' && !content.trim()) return bad('Geef in content de tekst voor het dossier.');
  let d: any = dossierFor(svc, agent, reader, name, true);
  // Several teams: "Eigenaar" is read by every team. What the owner says in this team stays in this team (its overview,
  // under "Over de eigenaar") unless he said it is for all teams; taking out or shortening is fine.
  if (d?.core === 'owner' && !o.allTeams && svc.teamInfo(agent.user_id)?.multi) {
    const fresh = newLines(String(d.body || ''), { content });
    if (fresh.length) {
      const team = teamDossier(svc, agent.user_id, 'overview', svc.homeTeam(agent));
      const r = dossierWrite(svc, agent, reader, { dossier: `d:${team.ref}`, content: fresh.map((l) => (/^[-*>]\s/.test(l) ? l : `- ${l}`)).join('\n'), mode: 'add', section: OWNER_HERE }, actor, { ...o, create: false });
      if (r.isError) return r;
      return { ...r, text: `Wat de eigenaar in dit team vertelt, blijft in dit team: gezet in dossier “${team.title}” [d:${team.ref}] onder “${OWNER_HERE}”; alleen de bots van team ${svc.teamName(agent.user_id, team.team_id)} lezen het. In “Eigenaar” (alle teams) komt alleen wat hij voor alle teams zegt.` };
    }
  }
  let made = false;
  try {
    if (!d) {
      if (!name || /^d:[a-z0-9]{4,16}$/i.test(name) || o.create === false) return bad('Dossier niet gevonden. Noem het dossier bij zijn naam; dossier_get zonder dossier geeft de lijst.');
      if (mode === 'replace') return bad(`Er is geen dossier “${clean(name, 60)}”. Met mode add maak je het aan.`);
      // A new dossier is for the whole team (agentIds null), in the bot's own team.
      const r = createDossier(svc, agent.user_id, { title: name, kind: a.kind, agentIds: null }, { type: 'agent', id: agent.id });
      d = r.dossier;
      made = !r.existed;
    }
    const refusal = writeRefusal(svc, agent, d);
    if (refusal) return bad(refusal);
    let w: { dossier: any; archived: number; changeId: string | null };
    let action: DossierWriteResult['action'];
    if (mode === 'add') {
      const out = writeNote(svc, { dossier: d, text: content, section: a.section ? String(a.section) : null, actor, full: o.full });
      if (out.action === 'same') return { text: `Dat stond al in dossier “${d.title}” [d:${d.ref}]; er is niets gewijzigd.`, action: 'same' };
      if (out.action === 'refused') {
        const cur = out.reason === 'full' && !d.core && d.body ? `\nDe tekst nu:\n${d.body}` : '';
        return { text: out.reason === 'full' ? `${out.message} Gebruik mode rewrite met de hele, kortere tekst waar het nieuwe al in staat.${cur}` : out.message, isError: true, action: 'refused' };
      }
      if (out.action === 'archived') return { text: out.message, action: 'archived', changeId: out.changeId };
      w = out;
      action = out.action;
    } else {
      const old = String(d.body || '');
      w = writeBody(svc, d.id, mode === 'rewrite' ? content : replaceInBody(old, String(a.old_text || ''), content), actor);
      action = mode === 'rewrite' ? 'rewritten' : 'replaced';
    }
    const size = String(w.dossier.body || '').length;
    const limit = limitOf(w.dossier);
    const bits = [`Dossier “${w.dossier.title}” [d:${w.dossier.ref}] ${made ? 'aangemaakt' : 'bijgewerkt'} (${size}/${limit} tekens). Alle bots van je team lezen dit vanaf nu.`];
    if (w.dossier.core === 'notes') bits[0] = `Je werknotities zijn bijgewerkt [d:${w.dossier.ref}] (${size}/${limit} tekens).`;
    if (w.archived) bits.push(`Wat eruit ging (${nlCount(w.archived, 'regel', 'regels')}) staat in het archief van het dossier.`);
    if (size >= limit * NEARLY_FULL) bits.push('Het dossier is bijna vol: herschrijf het bij je volgende wijziging korter (mode rewrite).');
    if (made && !w.dossier.core) bits.push('Zet ook één regel over dit dossier in “Overzicht”.');
    return { text: bits.join(' '), data: { dossier: `d:${w.dossier.ref}`, size, limit }, action, changeId: w.changeId };
  } catch (e: any) {
    if (e instanceof DossierFull) {
      const cur = d && !d.core && d.body ? `\nDe tekst nu:\n${d.body}` : '';
      return { text: `${e.message}${cur}`, isError: true, action: 'refused' };
    }
    return { text: e.message, isError: true, action: e instanceof WriteRefused ? 'refused' : 'invalid' };
  }
}
