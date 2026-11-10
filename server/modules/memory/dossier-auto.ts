/**
 * Dossiers without effort for bots (0.4 F2):
 *
 * - **Found and linked by itself**: a conversation, task or delegation that names a dossier of the bot's own team
 *   (its title or one of its tags, as whole words) is linked to it at the first turn; from then on its summary, open
 *   actions and latest decisions are in the bot's context every turn, without the bot asking (context.ts).
 * - **One tool to write**: `dossier_note` takes one sentence; TeamBot files it as a decision, action (with owner and
 *   deadline when given), event, person/organisation, source (a link) or note, or closes an open action ("offerte is
 *   verstuurd" → done). The detailed tools stay for the rare case.
 * - **Proposed when a subject keeps coming back**: the client/project a conversation is about (the learner's answer in
 *   the same call, or simple patterns such as "klant Jansen") is counted per team; in a second conversation without a
 *   dossier the owner gets a proposal with one click (or, when he allowed it, the dossier is made for that team).
 *   Notes a bot wrote before it existed wait with the proposal and go in when it is made.
 *
 * Team walls (B3) everywhere: only dossiers the bot may read *and* write (its home team), never another team's.
 */
import type { Agent, Thread } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import type { MemoryService } from './service.js';
import { outside } from './types.js';
import { addRecord, addSourceAsync, createDossier, updateRecord } from './dossiers.js';
import { writeCandidate } from './pipeline.js';
import { clean, detectSecret, excerpt, isInjectionLike, jaccard, normalize, tokens } from './text.js';

/** Words in a dossier title that say nothing about which one it is. */
const GENERIC = new Set(
  ['klant', 'klanten', 'client', 'project', 'projecten', 'dossier', 'opdracht', 'zaak', 'onderwerp', 'team', 'algemeen', 'plan', 'planning', 'werk', 'prive', 'nieuw', 'oud', 'van', 'voor', 'met', 'het', 'de', 'een', 'and', 'the', 'customer', 'case', 'topic', 'kennisbank'].map((w) => tokens(w)[0] || w),
);

/** The words that identify a dossier (title and tags without generic words). */
export function distinctive(title: string): string[] {
  return tokens(title).filter((t) => !GENERIC.has(t) && t.length >= 3);
}

/** Does this text name this dossier: every identifying word of its title, or one of its tags, as whole words? */
export function namesDossier(text: string, d: { title: string; tags?: string[] | null }): boolean {
  const have = new Set(tokens(text, 400));
  const own = distinctive(d.title);
  if (own.length && own.every((t) => have.has(t))) return true;
  for (const tag of d.tags || []) {
    const tt = distinctive(tag);
    if (tt.length && tt.every((t) => have.has(t))) return true;
  }
  return false;
}

/**
 * Dossiers this bot may read and write (its own team's, active — or archived, 0.4.4: a customer who comes back), with
 * what is needed to match them.
 */
function writableDossiers(svc: MemoryService, agent: Agent): { id: string; title: string; tags: string[]; ref: string; status?: string }[] {
  const reader = svc.readerFor(agent, null);
  const ids = svc.readableDossiers(reader, { archived: true });
  if (!ids.length) return [];
  return svc.store
    .all<any>(`SELECT id, title, tags, ref, user_id, status FROM memory_dossiers WHERE id IN (${ids.map(() => '?').join(',')}) AND status IN ('active','archived')`, ...ids)
    .filter((d) => d.user_id === agent.user_id && !svc.dossierWriteRefusal(agent, d.id))
    .map((d) => ({ id: d.id, title: d.title, ref: d.ref, status: d.status, tags: (() => {
      try {
        return JSON.parse(d.tags || '[]');
      } catch {
        return [];
      }
    })() }));
}

/** The one dossier this text names (null when none or more than one: never a guess). */
export function dossierNamedIn(svc: MemoryService, agent: Agent, text: string): { id: string; title: string; ref: string } | null {
  const hits = writableDossiers(svc, agent).filter((d) => namesDossier(text, d));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // "Klant Jansen" and "Jansen verbouwing": the one whose every title word is named wins only if it is unique.
    const full = hits.filter((d) => distinctive(d.title).length && distinctive(d.title).every((t) => tokens(text, 400).includes(t)));
    const longest = full.sort((a, b) => distinctive(b.title).length - distinctive(a.title).length);
    if (longest.length && (longest.length === 1 || distinctive(longest[0].title).length > distinctive(longest[1].title).length)) return longest[0];
  }
  return null;
}

/**
 * Turn time: a conversation not linked yet that clearly names a dossier of the bot's team is linked to it, so its
 * summary and open actions come along every turn. Returns the dossier when it was linked now.
 */
export function autoLinkThread(svc: MemoryService, agent: Agent, thread: Thread, text: string): { id: string; title: string; ref: string } | null {
  if (!text.trim() || outside(svc.audience(thread, agent.user_id))) return null;
  if (svc.store.one('SELECT 1 FROM memory_links WHERE thread_id = ?', thread.id)) return null;
  const d = dossierNamedIn(svc, agent, [text, thread.title || ''].join('\n'));
  if (!d) return null;
  svc.store.exec('INSERT OR IGNORE INTO memory_links (thread_id, user_id, dossier_id, created_at) VALUES (?, ?, ?, ?)', thread.id, agent.user_id, d.id, now());
  // A customer who comes back: his archived dossier is active again (with undo).
  if ((d as any).status === 'archived') {
    svc.store.tx(() => {
      const before = svc.snapshot('dossier', d.id);
      svc.store.update('memory_dossiers', d.id, { status: 'active', updated_at: now() });
      svc.recordChange({ userId: agent.user_id, kind: 'dossier', recordId: d.id, dossierId: d.id, op: 'restore', before, after: svc.snapshot('dossier', d.id), summary: `Weer actief (${agent.name} heeft een gesprek over “${d.title}”)`, reason: 'klant is terug', actor: 'agent', actorId: agent.id });
    });
  }
  svc.emit(agent.user_id, { op: 'link', kind: 'dossier', ids: [d.id], dossierId: d.id, threadId: thread.id });
  return d;
}

// ---------------------------------------------------------------------------- recurring subjects → dossier proposals

const SUBJECT_RE = /\b([Kk]lant|[Cc]lient|[Oo]pdrachtgever|[Pp]roject|[Oo]pdracht|[Dd]ossier)\s+((?:[A-Z][\p{L}'&.-]*)(?:\s+(?:[A-Z][\p{L}'&.-]*|\d+)){0,2})/gu;

/** Subjects named in the owner's words without a model ("klant Jansen", "project Zwaluw"). */
export function subjectsFromText(text: string): { name: string; kind: string }[] {
  const out: { name: string; kind: string }[] = [];
  for (const m of String(text || '').matchAll(SUBJECT_RE)) {
    const word = m[1].toLowerCase();
    const kind = ['klant', 'client', 'opdrachtgever'].includes(word) ? 'client' : 'project';
    const name = `${word === 'client' ? 'Klant' : word[0].toUpperCase() + word.slice(1)} ${m[2]}`.trim();
    if (!out.some((o) => normalize(o.name) === normalize(name))) out.push({ name: clean(name, 80), kind });
  }
  return out.slice(0, 3);
}

const subjectKey = (name: string) => distinctive(name).join(' ') || normalize(name);

/** How many different conversations before a dossier is proposed (or made). */
export const SUBJECT_THREADS = 2;

/**
 * A conversation is about this subject. Linked to its dossier when there is one; else counted, and after the second
 * conversation proposed to the owner (or made for the bot's team when he allowed that).
 */
export function noteSubject(svc: MemoryService, agent: Agent, thread: Thread, subject: { name: string; kind: string }): { linked?: string; proposed?: string; created?: string } {
  const userId = agent.user_id;
  if (outside(svc.audience(thread, userId))) return {};
  const name = clean(subject.name, 80);
  const key = subjectKey(name);
  if (key.length < 3 || detectSecret(name) || isInjectionLike(name)) return {};
  const existing = writableDossiers(svc, agent).find((d) => subjectKey(d.title) === key || namesDossier(name, d));
  if (existing) {
    if (!svc.store.one('SELECT 1 FROM memory_links WHERE thread_id = ?', thread.id)) svc.store.exec('INSERT OR IGNORE INTO memory_links (thread_id, user_id, dossier_id, created_at) VALUES (?, ?, ?, ?)', thread.id, userId, existing.id, now());
    return { linked: existing.id };
  }
  const team = svc.homeTeam(agent);
  const ts = now();
  let row = svc.store.one<any>("SELECT * FROM memory_subjects WHERE user_id = ? AND COALESCE(team_id, '') = ? AND norm = ?", userId, team || '', key);
  if (!row) {
    svc.store.insert('memory_subjects', { id: newId('msj_'), user_id: userId, team_id: team, agent_id: agent.id, norm: key, name, kind: subject.kind || 'project', threads: [thread.id], mentions: 1, pending: [], status: 'seen', first_at: ts, last_at: ts });
    row = svc.store.one<any>("SELECT * FROM memory_subjects WHERE user_id = ? AND COALESCE(team_id, '') = ? AND norm = ?", userId, team || '', key);
  } else {
    const sub = svc.store.decode<any>('memory_subjects', row);
    const threads = [...new Set([...(sub.threads || []), thread.id])].slice(-20);
    svc.store.update('memory_subjects', sub.id, { threads, mentions: (sub.mentions || 0) + 1, last_at: ts });
    row = svc.store.get('memory_subjects', sub.id);
  }
  const sub = svc.store.decode<any>('memory_subjects', row);
  if (sub.status !== 'seen' || (sub.threads || []).length < SUBJECT_THREADS) return {};
  return proposeOrCreate(svc, agent, sub);
}

function proposeOrCreate(svc: MemoryService, agent: Agent, sub: any): { proposed?: string; created?: string } {
  const mode = svc.userSettings(agent.user_id).dossierAuto;
  if (mode === 'off') return {};
  if (mode === 'create') {
    const d = acceptSubject(svc, agent.user_id, sub.id, { type: 'agent', id: agent.id });
    if (d) {
      svc.ctx.events.emit(agent.user_id, 'notification', { title: 'Nieuw dossier', body: `${agent.name} maakte het dossier “${d.title}”: het kwam in meer gesprekken terug.`, link: `#/m/memory/dossiers/${d.id}`, kind: 'memory', agentId: agent.id });
      return { created: d.id };
    }
    return {};
  }
  svc.store.update('memory_subjects', sub.id, { status: 'proposed' });
  svc.emit(agent.user_id, { op: 'propose', kind: 'dossier', ids: [sub.id] });
  svc.ctx.events.emit(agent.user_id, 'notification', { title: 'Dossier voorgesteld', body: `${agent.name} stelt een dossier voor: “${sub.name}” (kwam in meer gesprekken terug). Eén klik in Geheugen › Dossiers.`, link: '#/m/memory/dossiers', kind: 'memory', agentId: agent.id });
  return { proposed: sub.id };
}

/** Open proposals for the owner's Dossiers page. */
export function subjectProposals(svc: MemoryService, userId: string) {
  return svc.store
    .all<any>("SELECT * FROM memory_subjects WHERE user_id = ? AND status = 'proposed' ORDER BY last_at DESC LIMIT 50", userId)
    .map((r) => svc.store.decode<any>('memory_subjects', r))
    .map((s) => ({ id: s.id, name: s.name, kind: s.kind, threads: (s.threads || []).length, pending: (s.pending || []).length, agent: s.agent_id ? { id: s.agent_id, name: svc.agentName(s.agent_id) } : null, team: svc.teamTag(userId, s.team_id), at: s.last_at }));
}

/**
 * Yes (the owner's click, or the bot itself when the owner allowed it): the dossier for the subject's team, for every
 * bot of that team; its conversations linked and the waiting notes filed. Returns the dossier.
 */
export function acceptSubject(svc: MemoryService, userId: string, id: string, actor: { type: 'user' | 'agent'; id: string }, title?: string): any | null {
  const raw = svc.store.get<any>('memory_subjects', id);
  if (!raw || raw.user_id !== userId || !['seen', 'proposed'].includes(raw.status)) return null;
  const sub = svc.store.decode<any>('memory_subjects', raw);
  const kind = ['client', 'project', 'person', 'topic'].includes(sub.kind) ? sub.kind : 'project';
  const r = createDossier(svc, userId, { title: clean(title || sub.name, 120), kind, agentIds: null, teamId: actor.type === 'user' ? sub.team_id ?? null : undefined }, actor);
  const d = r.dossier;
  svc.store.update('memory_subjects', sub.id, { status: 'created', dossier_id: d.id, pending: [] });
  for (const th of sub.threads || []) {
    const t = svc.store.thread(th);
    if (t && t.user_id === userId) svc.store.exec('INSERT OR IGNORE INTO memory_links (thread_id, user_id, dossier_id, created_at) VALUES (?, ?, ?, ?)', th, userId, d.id, now());
  }
  for (const p of sub.pending || []) {
    const agent = p.agentId ? svc.store.agent(p.agentId) : null;
    try {
      void fileNote(svc, { userId, agent, threadId: p.threadId || null, callId: null, runId: null, fromOwner: !!p.fromOwner, tainted: !!p.tainted }, d.id, p.text, { due: p.due, owner: p.owner });
    } catch (e: any) {
      svc.ctx.log.warn('[memory] wachtende notitie in dossier zetten mislukt', e?.message || e);
    }
  }
  svc.ctx.audit(userId, 'memory.subject_accepted', { dossier: d.ref, by: actor.type }, actor.type === 'agent' ? actor.id : null);
  return d;
}

/** No: this subject is not proposed again. */
export function dismissSubject(svc: MemoryService, userId: string, id: string): boolean {
  const raw = svc.store.get<any>('memory_subjects', id);
  if (!raw || raw.user_id !== userId) return false;
  svc.store.update('memory_subjects', id, { status: 'dismissed', pending: [] });
  return true;
}

/** A note for a subject that has no dossier yet: it waits with the (new) proposal. */
export function parkNote(svc: MemoryService, agent: Agent, thread: Thread | null, name: string, note: { text: string; due?: string | null; owner?: string | null; fromOwner?: boolean; tainted?: boolean }): { id: string; status: string; name: string } | null {
  const key = subjectKey(name);
  if (key.length < 3) return null;
  const team = svc.homeTeam(agent);
  const ts = now();
  let raw = svc.store.one<any>("SELECT * FROM memory_subjects WHERE user_id = ? AND COALESCE(team_id, '') = ? AND norm = ?", agent.user_id, team || '', key);
  if (!raw) {
    svc.store.insert('memory_subjects', { id: newId('msj_'), user_id: agent.user_id, team_id: team, agent_id: agent.id, norm: key, name: clean(name, 80), kind: 'project', threads: thread ? [thread.id] : [], mentions: 1, pending: [], status: 'seen', first_at: ts, last_at: ts });
    raw = svc.store.one<any>("SELECT * FROM memory_subjects WHERE user_id = ? AND COALESCE(team_id, '') = ? AND norm = ?", agent.user_id, team || '', key);
  }
  const sub = svc.store.decode<any>('memory_subjects', raw);
  if (sub.status === 'dismissed') return { id: sub.id, status: 'dismissed', name: sub.name };
  const pending = [...(sub.pending || []), { text: clean(note.text, 1000), due: note.due ?? null, owner: note.owner ?? null, agentId: agent.id, threadId: thread?.id ?? null, fromOwner: !!note.fromOwner, tainted: !!note.tainted, at: ts }].slice(-30);
  svc.store.update('memory_subjects', sub.id, { pending, last_at: ts, threads: thread ? [...new Set([...(sub.threads || []), thread.id])].slice(-20) : sub.threads });
  if (sub.status === 'seen') {
    const r = proposeOrCreate(svc, agent, svc.store.decode<any>('memory_subjects', svc.store.get('memory_subjects', sub.id)));
    if (r.created) return { id: sub.id, status: 'created', name: sub.name };
  }
  return { id: sub.id, status: 'proposed', name: sub.name };
}

// ---------------------------------------------------------------------------- one sentence → the right kind of record

export type NoteKind = 'decision' | 'action' | 'done' | 'event' | 'person' | 'organization' | 'source' | 'note';

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/i;
const DECISION_RE = /\b(besloten|besluit|we kiezen|gekozen voor|we gaan voor|akkoord (?:met|op)|afgesproken (?:is )?dat|definitief|goedgekeurd|decided|we chose|agreed (?:to|on|that)|approved)\b/i;
const DONE_RE = /\b(is |zijn |werd )?(klaar|gedaan|afgerond|verstuurd|verzonden|betaald|geleverd|opgelost|done|finished|completed|sent|paid)\b/i;
const ACTION_RE = /\b(moet|moeten|gaat .{1,40} (?:doen|maken|sturen|bellen|regelen)|ga ik|zal .{1,30}(?:sturen|doen|bellen|maken)|todo|to do|actie(?:punt)?|uiterlijk|vóór|voor (?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|morgen|volgende week|het eind van)|deadline|needs to|has to|will (?:send|call|do|make)|follow up|opvolgen|navragen|nabellen|offerte (?:sturen|maken))\b/i;
const EVENT_RE = /\b(vandaag|gisteren|vanochtend|vanmiddag|vanavond|net|zojuist|afgelopen (?:week|maandag|dinsdag|woensdag|donderdag|vrijdag)|heeft gebeld|hebben gebeld|gebeld|gesproken met|langs geweest|is geleverd|ontvangen|gemaild|gestart|begonnen|yesterday|today|this morning|called|met with|received|started)\b/i;
const PERSON_RE = /^\s*([A-Z][\p{L}'-]+(?:\s+(?:van|de|der|den|ter|ten|[A-Z][\p{L}'-]+)){0,3})\s+(?:is|wordt|blijft)\s+(?:de |onze |hun |het )?(contactpersoon|inkoper|eigenaar|directeur|manager|accountmanager|projectleider|aanspreekpunt|boekhouder|aannemer|architect|adviseur|contact|klant|leverancier)\b(.*)$/u;
/** A moment ahead ("vrijdag", "morgen", "volgende week", a date): with someone doing something, that is an action. */
const WHEN_RE = /\b(morgen|overmorgen|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|volgende week|deze week|eind van de (?:week|maand)|tomorrow|monday|tuesday|wednesday|thursday|friday|next week|\d{1,2}[-/ ](?:\d{1,2}|jan|feb|mrt|maart|apr|mei|jun|jul|aug|sep|okt|nov|dec)\w*|20\d{2}-\d{2}-\d{2})\b/i;
const ORG_RE = /\b(B\.?V\.?|N\.?V\.?|BV|NV|Ltd|GmbH|Inc|VOF|bureau|leverancier|aannemer|groothandel)\b/;

/** What kind of dossier record one sentence is (decision, action, done, event, person/organisation, source, note). */
export function classifyNote(text: string, o: { due?: string | null; owner?: string | null } = {}): { kind: NoteKind; url?: string; name?: string; role?: string } {
  const s = String(text || '').trim();
  const url = s.match(URL_RE)?.[0];
  if (url && s.replace(url, '').trim().split(/\s+/).length <= 12) return { kind: 'source', url };
  const p = s.match(PERSON_RE);
  if (p) return { kind: ORG_RE.test(p[1]) ? 'organization' : 'person', name: p[1].trim(), role: p[2] };
  if (o.due || o.owner) return { kind: 'action' };
  if (DECISION_RE.test(s)) return { kind: 'decision' };
  if (ACTION_RE.test(s) && !/\b(is|zijn|werd)\s+(verstuurd|gedaan|geleverd|betaald)\b/i.test(s)) return { kind: 'action' };
  // "Jan stuurt vrijdag de offerte": someone doing something, not something that already happened.
  if (ownerOf(s) && WHEN_RE.test(s) && !EVENT_RE.test(s) && !DONE_RE.test(s)) return { kind: 'action' };
  if (DONE_RE.test(s)) return { kind: 'done' };
  if (EVENT_RE.test(s)) return { kind: 'event' };
  return { kind: 'note' };
}

/** "Jan belt de klant vrijdag" → owner Jan. A name at the start followed by a verb of doing. */
function ownerOf(text: string): string | null {
  const m = text.match(/^\s*([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?)\s+(?:gaat|moet|zal|belt|stuurt|maakt|regelt|doet|mailt|will|needs)\b/u);
  return m && !['We', 'Wij', 'Ik', 'Jij', 'Je', 'Hij', 'Zij', 'Ze', 'Dit', 'Dat', 'De', 'Het', 'Een'].includes(m[1]) ? m[1] : null;
}

/** A Dutch/English weekday or "morgen" in the text → that date (for an action without an explicit deadline). */
function dueFrom(text: string, from = new Date()): string | null {
  const s = normalize(text);
  const days = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
  const en = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  if (/\b(morgen|tomorrow)\b/.test(s) && !/\bmorgenochtend\b/.test(s)) return new Date(from.getTime() + 864e5).toISOString().slice(0, 10);
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b(voor |op |uiterlijk |by |on )?(${days[i]}|${en[i]})\\b`).test(s)) {
      const d = new Date(from);
      const add = (i - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + add);
      return d.toISOString().slice(0, 10);
    }
  }
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return iso ? iso[1] : null;
}

export interface NoteActor {
  userId: string;
  agent: Agent | null;
  threadId: string | null;
  callId: string | null;
  runId: string | null;
  /** The run was started by the owner in his own words (not a webhook, channel or other person). */
  fromOwner: boolean;
  /** The run read outside content (web, mail, files): bot notes then wait for the owner where that applies. */
  tainted: boolean;
}

/** File one sentence in a dossier as the right kind of record. Returns the message for the bot (with the id). */
export async function fileNote(svc: MemoryService, a: NoteActor, dossierId: string, text: string, o: { due?: string | null; owner?: string | null; kind?: string | null } = {}): Promise<{ kind: NoteKind; ref: string; message: string; changeId?: string | null }> {
  const t = clean(text, 1500);
  if (t.length < 3) throw new Error('Schrijf de notitie in één zin (wat er besloten, gedaan of afgesproken is).');
  const d = svc.store.get<any>('memory_dossiers', dossierId);
  if (!d) throw new Error('Dossier niet gevonden');
  const actor = a.agent ? { type: 'agent' as const, id: a.agent.id, callId: a.callId } : { type: 'user' as const, id: a.userId };
  const sources = a.threadId ? [{ kind: 'thread', ref: a.threadId, threadId: a.threadId, title: svc.store.thread(a.threadId)?.title || 'Gesprek' }] : [];
  const hint = o.kind && ['decision', 'action', 'done', 'event', 'person', 'organization', 'source', 'note'].includes(o.kind) ? (o.kind as NoteKind) : null;
  const c = hint ? { kind: hint, url: t.match(URL_RE)?.[0], name: undefined as string | undefined, role: undefined as string | undefined } : classifyNote(t, o);
  const label: Record<NoteKind, string> = { decision: 'besluit', action: 'actie', done: 'afgerond', event: 'gebeurtenis', person: 'persoon', organization: 'organisatie', source: 'bron', note: 'notitie' };
  const title = d.title;
  if (c.kind === 'done') {
    // Closes the open action it is about ("offerte is verstuurd" ↔ "Offerte sturen naar Jansen").
    const want = tokens(t);
    const open = svc.store.all<any>("SELECT * FROM memory_records WHERE dossier_id = ? AND kind = 'action' AND status = 'open'", dossierId).map((r) => ({ r, sim: jaccard(want, tokens(r.title)) + (tokens(r.title).filter((x) => want.includes(x)).length ? 0.2 : 0) }));
    const best = open.sort((x, y) => y.sim - x.sim)[0];
    if (best && best.sim >= 0.35) {
      const rec = updateRecord(svc, a.userId, best.r.id, { status: 'done', completion_source: excerpt(t, 200) }, actor);
      return { kind: 'done', ref: `a:${rec.ref}`, message: `Actie afgerond in dossier “${title}”: [a:${rec.ref}] ${excerpt(rec.title, 80)}.` };
    }
    // Nothing open about it: it happened, so it is an event.
    c.kind = 'event';
  }
  if (c.kind === 'source' && c.url) {
    const s = await addSourceAsync(svc, a.userId, dossierId, { kind: 'url', target: c.url, title: clean(t.replace(c.url, '').trim() || c.url, 200), threadId: a.threadId }, actor);
    return { kind: 'source', ref: `s:${s.ref}`, message: `Bron toegevoegd aan dossier “${title}”: [s:${s.ref}] ${s.title}.` };
  }
  if (c.kind === 'note') {
    const out = writeCandidate(svc, {
      userId: a.userId,
      content: t,
      scope: 'dossier',
      dossierId,
      agentId: a.agent?.id ?? null,
      source: a.agent ? { kind: 'tool', ref: a.callId, threadId: a.threadId, trust: a.fromOwner ? 'agent' : 'external' } : { kind: 'user', trust: 'user' },
      origin: a.agent ? 'tool' : 'user_ui',
      createdBy: a.agent ? 'agent' : 'user',
      createdByAgent: a.agent?.id ?? null,
      runId: a.runId,
      callId: a.callId,
      idemKey: a.callId ? `t:${a.callId}` : null,
      flags: a.tainted ? ['tainted'] : [],
    });
    if (['rejected', 'blocked', 'quota', 'invalid'].includes(out.action)) throw new Error(out.message);
    return { kind: 'note', ref: out.item ? `m:${out.item.ref}` : '', message: `Notitie in dossier “${title}”: ${out.message}`, changeId: out.changeId };
  }
  const kind = c.kind === 'person' || c.kind === 'organization' ? 'entity' : c.kind;
  const owner = o.owner || (kind === 'action' ? ownerOf(t) : null);
  const due = o.due || (kind === 'action' ? dueFrom(t) : null);
  const recTitle = kind === 'entity' ? c.name || t : t;
  const body = kind === 'entity' ? clean([c.role, (t.match(PERSON_RE)?.[3] || '').trim()].filter(Boolean).join(' — '), 600) : undefined;
  const r = addRecord(svc, a.userId, dossierId, kind as any, { title: recTitle, body, owner, due_at: due, entity_kind: kind === 'entity' ? c.kind : undefined, sources }, actor);
  const prefix = { decision: 'b', action: 'a', event: 'g', entity: 'p' }[kind as 'decision' | 'action' | 'event' | 'entity'];
  const extra = kind === 'action' ? `${owner ? `, voor ${owner}` : ''}${due ? `, uiterlijk ${due}` : ''}` : '';
  return { kind: c.kind, ref: `${prefix}:${r.record.ref}`, message: r.existed ? `${r.message} (dossier “${title}”)` : `Genoteerd in dossier “${title}” als ${label[c.kind]}${extra}: [${prefix}:${r.record.ref}].${r.message.includes('botst') || r.message.includes('Vervangt') ? ' ' + r.message.replace(/^[^.]*\.\s*/, '') : ''}`, changeId: (r as any).changeId ?? null };
}
