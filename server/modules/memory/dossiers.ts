/**
 * Project/client dossiers: summary, timeline (events), decisions, action items (owner/deadline/status), people &
 * organisations, sources (with optional indexed document chunks) and notes (memory items with scope "dossier").
 * Access: the owner; bots of the owner (all, or a chosen list); other users only through an explicit share (read/edit).
 */
import { limitOf, ownerDossier, teamDossier, writeBody } from './living.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../../core/types.js';
import { resolveInWorkspace } from '../../tools/builtin/files.js';
import { newId, now } from '../../core/db.js';
import type { MemoryService } from './service.js';
import type { Reader, RecordKind } from './types.js';
import { RECORD_KINDS } from './types.js';
import { canonicalKey, clean, detectSecret, excerpt, isInjectionLike, jaccard, normalize, tokens } from './text.js';
import { shortDate } from './context.js';
import { chunkText } from '../folders/chunk.js';

export { chunkText };

export const DOSSIER_KINDS = ['project', 'client', 'person', 'topic', 'team'] as const;
export const DOSSIER_STATUSES = ['active', 'closed', 'archived'] as const;
const ENTITY_KINDS = ['person', 'organization', 'place', 'product', 'other'];
const ACTION_STATUSES = ['open', 'done', 'cancelled'];

export interface SourceRefIn {
  kind: string;
  ref?: string | null;
  threadId?: string | null;
  title?: string | null;
}

export function dossierView(svc: MemoryService, d: any, viewerId: string) {
  if (!d) return null;
  const counts = svc.store.one<any>(
    `SELECT
      (SELECT COUNT(*) FROM memory_records WHERE dossier_id = ? AND kind = 'action' AND status = 'open') AS open_actions,
      (SELECT COUNT(*) FROM memory_records WHERE dossier_id = ? AND status NOT IN ('trashed','forgotten')) AS records,
      (SELECT COUNT(*) FROM memory_items WHERE dossier_id = ? AND status = 'active') AS notes,
      (SELECT COUNT(*) FROM memory_sources WHERE dossier_id = ? AND status = 'active') AS sources,
      (SELECT MAX(updated_at) FROM memory_records WHERE dossier_id = ?) AS last_record`,
    d.id,
    d.id,
    d.id,
    d.id,
    d.id,
  );
  const role = svc.dossierRole(viewerId, d.id);
  const owner = d.user_id === viewerId ? null : svc.store.user(d.user_id)?.name || 'Iemand';
  return {
    ...d,
    role,
    owner_name: owner,
    open_actions: counts?.open_actions || 0,
    records: counts?.records || 0,
    notes: counts?.notes || 0,
    sources: counts?.sources || 0,
    last_activity_at: [d.updated_at, counts?.last_record].filter(Boolean).sort().pop(),
    // The living text of the dossier (living.ts) and how long it may get.
    body_limit: limitOf(d),
    agent_names: Array.isArray(d.agent_ids) && d.user_id === viewerId ? d.agent_ids.map((id: string) => svc.agentName(id)) : null,
    // The dossier's team for its owner, only with two or more teams ('*' = Alle teams).
    team: d.user_id === viewerId ? svc.teamTag(d.user_id, d.team_id ?? null) : null,
  };
}

/** The shared core dossiers of an owner exist before he looks (the owner's, and each team's overview and lessons). */
export function ensureCoreDossiers(svc: MemoryService, userId: string) {
  svc.store.tx(() => {
    ownerDossier(svc, userId);
    const info = svc.teamInfo(userId);
    for (const team of info ? [...info.ids] : [null]) {
      teamDossier(svc, userId, 'overview', team);
      teamDossier(svc, userId, 'lessons', team);
    }
  });
}

export function listDossiers(svc: MemoryService, reader: Reader, o: { q?: string; status?: string; teamId?: string | null } = {}) {
  // Archived dossiers (a customer nobody worked on for a long time) are found when asked for, or when searching by name.
  let ids = svc.readableDossiers(reader, { archived: !o.status || ['archived', 'all'].includes(o.status) });
  // The owner's team filter (Geheugen page): only that team's dossiers (or those "voor alle teams").
  if (o.teamId && reader.asUser) {
    const team = svc.teamDossierIds(reader.userId, o.teamId);
    ids = ids.filter((id) => team.has(id));
  }
  if (!ids.length) return [];
  // The core dossiers first (owner, overview, lessons), bots' working notes last.
  let rows = svc.store
    .all<any>(`SELECT * FROM memory_dossiers WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY CASE core WHEN 'owner' THEN 0 WHEN 'overview' THEN 1 WHEN 'lessons' THEN 2 WHEN 'notes' THEN 9 ELSE 5 END, pinned DESC, updated_at DESC`, ...ids)
    .map((r) => svc.store.decode('memory_dossiers', r));
  if (o.status && o.status !== 'all') rows = rows.filter((d: any) => d.status === o.status);
  else rows = rows.filter((d: any) => d.status !== 'trashed' || o.status === 'all');
  if (o.q?.trim()) {
    const hits = new Set<string>();
    for (const h of svc.ftsMatch(svc.ownerIds(reader), o.q, ['dossier', 'record'], 200)) {
      if (h.kind === 'dossier') hits.add(h.rid);
      else {
        const did = svc.store.one<any>('SELECT dossier_id FROM memory_records WHERE id = ?', h.rid)?.dossier_id;
        if (did) hits.add(did);
      }
    }
    const qn = normalize(o.q);
    rows = rows.filter((d: any) => hits.has(d.id) || normalize(d.title).includes(qn));
  }
  return rows.map((d: any) => dossierView(svc, d, reader.userId));
}

export function findDossier(svc: MemoryService, reader: Reader, input: string): any | null {
  const s = String(input || '').trim();
  if (!s) return null;
  const ids = new Set(svc.readableDossiers(reader));
  const r = svc.resolve(reader.userId, s);
  if (r?.kind === 'dossier' && ids.has(r.row.id)) return svc.store.decode('memory_dossiers', svc.store.get('memory_dossiers', r.row.id));
  const n = normalize(s);
  const all = [...ids].map((id) => svc.store.decode<any>('memory_dossiers', svc.store.get('memory_dossiers', id))).filter((d) => d && d.status !== 'trashed');
  return all.find((d) => normalize(d.title) === n) || all.find((d) => normalize(d.title).includes(n)) || null;
}

function recordView(svc: MemoryService, r: any) {
  return { ...r, author_name: r.author_type === 'agent' ? svc.agentName(r.author_id) : r.author_type === 'user' ? svc.store.user(r.author_id)?.name || 'Gebruiker' : 'Systeem' };
}

export function getDossier(svc: MemoryService, reader: Reader, id: string) {
  const d = svc.store.get<any>('memory_dossiers', id);
  if (!d || !svc.readableDossiers(reader, { archived: true }).includes(id)) return null;
  const records = svc.store
    .all<any>("SELECT * FROM memory_records WHERE dossier_id = ? AND status NOT IN ('trashed','forgotten') ORDER BY COALESCE(occurred_at, created_at) DESC", id)
    .map((r) => recordView(svc, svc.store.decode('memory_records', r)));
  const items = svc.store
    .all<any>("SELECT * FROM memory_items WHERE dossier_id = ? AND status IN ('active','proposed') ORDER BY pinned DESC, updated_at DESC LIMIT 500", id)
    .map((r) => svc.view(svc.store.decode('memory_items', r)));
  const sources = svc.store.all<any>("SELECT * FROM memory_sources WHERE dossier_id = ? AND status = 'active' ORDER BY created_at DESC", id);
  const timeline = records
    .filter((r: any) => r.kind !== 'entity')
    .map((r: any) => ({ kind: r.kind, id: r.id, ref: r.ref, title: r.title, at: r.kind === 'action' ? r.due_at || r.created_at : r.occurred_at || r.created_at, status: r.status, owner: r.owner, author_name: r.author_name }))
    .sort((a: any, b: any) => String(b.at).localeCompare(String(a.at)));
  const view = dossierView(svc, svc.store.decode('memory_dossiers', d), reader.userId);
  const acl =
    d.user_id === reader.userId
      ? svc.store.all<any>('SELECT a.user_id, a.role, a.created_at, u.name, u.email FROM memory_dossier_acl a LEFT JOIN users u ON u.id = a.user_id WHERE a.dossier_id = ?', id)
      : [];
  const changes = svc.store.all<any>('SELECT id, record_kind, record_id, op, summary, actor, actor_id, created_at, undone_at, undoable, redacted FROM memory_changes WHERE dossier_id = ? ORDER BY created_at DESC LIMIT 60', id);
  return {
    dossier: view,
    events: records.filter((r: any) => r.kind === 'event'),
    decisions: records.filter((r: any) => r.kind === 'decision'),
    actions: records.filter((r: any) => r.kind === 'action').sort((a: any, b: any) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(a.due_at || '9999').localeCompare(String(b.due_at || '9999'))),
    entities: records.filter((r: any) => r.kind === 'entity'),
    items,
    sources,
    timeline,
    acl,
    changes: changes.map((c) => ({ ...c, actor_name: c.actor === 'agent' ? svc.agentName(c.actor_id) : c.actor === 'user' ? svc.store.user(c.actor_id)?.name || 'Gebruiker' : 'Systeem' })),
  };
}

/**
 * The team of a new dossier: the owner's choice (`teamId`: a team or ALL_TEAMS); a bot's (and a specialist's
 * knowledge base made for a bot) is in that bot's home team; otherwise the team of the bots it is for, else the
 * default team (null).
 */
export function newDossierTeam(svc: MemoryService, userId: string, o: { teamId?: string | null; agentId?: string | null; agentIds?: string[] | null }, actor: { type: 'user' | 'agent'; id: string }): string | null {
  if (actor.type === 'agent') return svc.homeTeam(actor.id);
  if (o.teamId) {
    if (!svc.validTeam(userId, o.teamId)) throw new Error('Onbekend team');
    return o.teamId;
  }
  const bot = o.agentId || (Array.isArray(o.agentIds) ? o.agentIds[0] : null);
  return bot && svc.store.agent(bot)?.user_id === userId ? svc.homeTeam(bot) : null;
}

export function createDossier(
  svc: MemoryService,
  userId: string,
  o: { title: string; summary?: string; kind?: string; agentIds?: string[] | null; tags?: string[]; teamId?: string | null; agentId?: string | null },
  actor: { type: 'user' | 'agent'; id: string },
): { dossier: any; existed: boolean } {
  const title = clean(o.title, 120);
  if (!title) throw new Error('Geef het dossier een titel');
  if (detectSecret(title + ' ' + (o.summary || ''))) throw new Error('Dit lijkt een wachtwoord of sleutel te bevatten; dat hoort niet in een dossier.');
  const teamId = newDossierTeam(svc, userId, o, actor);
  // The same title in the same team is the same dossier; another team's dossier is never returned (or named).
  const sameTeam = svc.teamEq('team_id', userId, teamId);
  const same = svc.store.all<any>(`SELECT * FROM memory_dossiers WHERE user_id = ? AND status IN ('active','closed','archived') AND ${sameTeam.sql}`, userId, ...sameTeam.params).filter((d) => normalize(d.title) === normalize(title));
  const existing = same.find((d) => d.status !== 'archived');
  if (existing) return { dossier: svc.store.decode('memory_dossiers', existing), existed: true };
  // A customer who comes back (0.4.4): his archived dossier is active again instead of a second one.
  const back = same.find((d) => d.status === 'archived');
  if (back) {
    svc.store.tx(() => {
      const before = svc.snapshot('dossier', back.id);
      svc.store.update('memory_dossiers', back.id, { status: 'active', updated_at: now() });
      svc.recordChange({ userId, kind: 'dossier', recordId: back.id, dossierId: back.id, op: 'restore', before, after: svc.snapshot('dossier', back.id), summary: `Weer actief: “${excerpt(back.title, 80)}”`, reason: 'opnieuw aangemaakt', actor: actor.type, actorId: actor.id });
    });
    return { dossier: svc.store.decode('memory_dossiers', svc.store.get('memory_dossiers', back.id)), existed: true };
  }
  // Limits (0.4.4): a working set of active dossiers, and a larger total with the archive (customer service with many
  // customers: inactive customers go to the archive and stop counting for the first). Server-wide in memory.limits.
  const lim = svc.limits();
  const live = svc.store.one<any>("SELECT COUNT(*) AS n FROM memory_dossiers WHERE user_id = ? AND status IN ('active','closed')", userId)?.n || 0;
  if (live >= lim.dossiers) throw new Error(`Maximaal ${lim.dossiers} actieve dossiers. Sluit of archiveer er eerst een paar; klanten waar een half jaar niets mee gebeurde gaan vanzelf naar het archief.`);
  const all = svc.store.one<any>("SELECT COUNT(*) AS n FROM memory_dossiers WHERE user_id = ? AND status NOT IN ('trashed','forgotten')", userId)?.n || 0;
  if (all >= lim.dossiersTotal) throw new Error(`Maximaal ${lim.dossiersTotal} dossiers, ook in het archief. Verwijder er eerst een paar.`);
  let agentIds: string[] | null = o.agentIds === undefined ? (actor.type === 'agent' ? [actor.id] : o.agentId ? [o.agentId] : null) : o.agentIds;
  if (Array.isArray(agentIds)) agentIds = agentIds.filter((id) => svc.store.agent(id)?.user_id === userId);
  const ts = now();
  const d = {
    id: newId('dos_'),
    ref: svc.newRef('memory_dossiers', userId),
    user_id: userId,
    title,
    kind: DOSSIER_KINDS.includes(o.kind as any) ? o.kind : 'project',
    summary: clean(o.summary || '', 4000),
    status: 'active',
    agent_ids: agentIds,
    team_id: teamId,
    tags: (o.tags || []).map((t) => clean(String(t), 40)).filter(Boolean).slice(0, 20),
    pinned: false,
    created_by: actor.type,
    created_by_agent: actor.type === 'agent' ? actor.id : null,
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
  svc.store.tx(() => {
    svc.store.insert('memory_dossiers', d);
    svc.syncIndex('dossier', d.id);
    svc.recordChange({ userId, kind: 'dossier', recordId: d.id, dossierId: d.id, op: 'create', before: null, after: svc.snapshot('dossier', d.id), summary: `Dossier aangemaakt: “${title}”`, actor: actor.type, actorId: actor.id });
  });
  svc.emit(userId, { op: 'create', kind: 'dossier', ids: [d.id], dossierId: d.id });
  svc.ctx.audit(userId, 'memory.dossier_created', { ref: d.ref }, actor.type === 'agent' ? actor.id : null);
  return { dossier: svc.store.decode('memory_dossiers', svc.store.get('memory_dossiers', d.id)), existed: false };
}

export function updateDossier(svc: MemoryService, userId: string, id: string, patch: any, actor: { type: 'user' | 'agent'; id: string }) {
  const d = svc.store.decode<any>('memory_dossiers', svc.store.get('memory_dossiers', id));
  const role = svc.dossierRole(userId, id);
  if (!d || !role) throw new Error('Dossier niet gevonden');
  if (role === 'read') throw new Error('Je hebt alleen leesrechten op dit dossier');
  const p: any = {};
  if (patch.title !== undefined) p.title = clean(patch.title, 120) || d.title;
  if (patch.summary !== undefined) p.summary = clean(patch.summary, 4000);
  if (patch.kind !== undefined && DOSSIER_KINDS.includes(patch.kind)) p.kind = patch.kind;
  if (patch.status !== undefined) {
    if (![...DOSSIER_STATUSES, 'trashed'].includes(patch.status)) throw new Error('Ongeldige status');
    if (role !== 'owner') throw new Error('Alleen de eigenaar kan de status wijzigen');
    p.status = patch.status;
    p.trashed_at = patch.status === 'trashed' ? now() : null;
  }
  if (patch.tags !== undefined && Array.isArray(patch.tags)) p.tags = patch.tags.map((t: any) => clean(String(t), 40)).filter(Boolean).slice(0, 20);
  if (patch.pinned !== undefined) p.pinned = !!patch.pinned;
  if (patch.agentIds !== undefined) {
    if (role !== 'owner') throw new Error('Alleen de eigenaar bepaalt welke bots toegang hebben');
    p.agent_ids = patch.agentIds === null ? null : (patch.agentIds as string[]).filter((aid) => svc.store.agent(aid)?.user_id === d.user_id);
  }
  // Another team (or "Alle teams"): only the owner himself, in the memory page.
  if (patch.teamId !== undefined && (patch.teamId || null) !== (d.team_id ?? null) && svc.resolveTeam(d.user_id, patch.teamId) !== svc.resolveTeam(d.user_id, d.team_id)) {
    if (role !== 'owner' || actor.type !== 'user') throw new Error('Alleen de eigenaar zet een dossier in een ander team');
    if (!svc.validTeam(d.user_id, patch.teamId)) throw new Error('Onbekend team');
    p.team_id = patch.teamId;
  }
  if (p.summary && isInjectionLike(p.summary) && actor.type === 'agent') throw new Error('Deze samenvatting lijkt een instructie te bevatten en is niet opgeslagen.');
  // The text of the dossier (the owner edits it in Geheugen): through the one write path, with archive and history.
  if (patch.body !== undefined) writeBody(svc, id, String(patch.body ?? ''), { type: actor.type, id: actor.id, guard: actor.type === 'agent' });
  if (!Object.keys(p).length) return svc.store.decode('memory_dossiers', svc.store.get('memory_dossiers', id));
  svc.store.tx(() => {
    const before = svc.snapshot('dossier', id);
    svc.store.update('memory_dossiers', id, { ...p, version: (d.version || 1) + 1, updated_at: now() });
    svc.syncIndex('dossier', id);
    const what = Object.keys(p).filter((k) => k !== 'trashed_at').map((k) => (k === 'team_id' ? `team: ${svc.teamName(d.user_id, p.team_id)}` : k)).join(', ');
    svc.recordChange({ userId: d.user_id, kind: 'dossier', recordId: id, dossierId: id, op: p.status === 'trashed' ? 'trash' : 'update', before, after: svc.snapshot('dossier', id), summary: `Dossier “${d.title}” bijgewerkt (${what})`, actor: actor.type, actorId: actor.id });
  });
  svc.emit(d.user_id, { op: 'update', kind: 'dossier', ids: [id], dossierId: id });
  return svc.store.decode('memory_dossiers', svc.store.get('memory_dossiers', id));
}

/** Share a dossier with another user of this server (by e-mail), change roles, or revoke. Owner only. */
export function shareDossier(svc: MemoryService, ownerId: string, id: string, o: { email?: string; userId?: string; role?: string; revoke?: boolean }) {
  const d = svc.store.get<any>('memory_dossiers', id);
  if (!d || d.user_id !== ownerId) throw new Error('Alleen de eigenaar kan dit dossier delen');
  let target: any = null;
  if (o.userId) target = svc.store.user(o.userId);
  else if (o.email) target = svc.store.one<any>('SELECT id, name, email FROM users WHERE lower(email) = lower(?) AND disabled = 0', String(o.email).trim());
  if (!target) throw new Error('Geen gebruiker met dat e-mailadres op deze server');
  if (target.id === ownerId) throw new Error('Je bent zelf al eigenaar');
  if (o.revoke) {
    svc.store.exec('DELETE FROM memory_dossier_acl WHERE dossier_id = ? AND user_id = ?', id, target.id);
    svc.ctx.audit(ownerId, 'memory.dossier_unshared', { ref: d.ref, with: target.id });
  } else {
    const role = o.role === 'edit' ? 'edit' : 'read';
    svc.store.exec('INSERT INTO memory_dossier_acl (dossier_id, user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(dossier_id, user_id) DO UPDATE SET role = excluded.role', id, target.id, role, ownerId, now());
    svc.ctx.audit(ownerId, 'memory.dossier_shared', { ref: d.ref, with: target.id, role });
    svc.ctx.events.emit(target.id, 'notification', { title: 'Dossier met je gedeeld', body: `“${d.title}” (${role === 'edit' ? 'bewerken' : 'lezen'})`, link: `#/m/memory/dossiers/${id}`, kind: 'memory' });
  }
  svc.recordChange({ userId: ownerId, kind: 'dossier', recordId: id, dossierId: id, op: 'access', summary: o.revoke ? `Toegang ingetrokken voor ${target.name}` : `Gedeeld met ${target.name} (${o.role === 'edit' ? 'bewerken' : 'lezen'})`, actor: 'user', actorId: ownerId, undoable: false });
  svc.emit(ownerId, { op: 'access', kind: 'dossier', ids: [id], dossierId: id });
  svc.ctx.events.emit(target.id, 'memory.updated', { op: 'access', kind: 'dossier', ids: [id] });
  return { ok: true, user: { id: target.id, name: target.name } };
}

function hashRecord(svc: MemoryService, userId: string, kind: string, title: string, body = '') {
  return svc.hmac(userId, `r:${kind}:${normalize(title)}:${normalize(body).slice(0, 200)}`);
}

function upsertSources(svc: MemoryService, userId: string, dossierId: string, sources: SourceRefIn[], actor: { type: string; id: string }) {
  for (const s of sources) {
    if (!s?.ref) continue;
    const exists = svc.store.one<any>("SELECT id FROM memory_sources WHERE dossier_id = ? AND kind = ? AND target = ? AND status = 'active'", dossierId, s.kind, s.ref);
    if (exists) continue;
    const ts = now();
    const id = newId('src_');
    svc.store.insert('memory_sources', { id, ref: svc.newRef('memory_sources', userId), user_id: userId, dossier_id: dossierId, kind: s.kind, target: s.ref, thread_id: s.threadId ?? null, title: clean(s.title || '', 200), excerpt: '', hash: '', trust: actor.type === 'user' ? 'user' : 'agent', chunks: 0, status: 'active', observed_at: ts, author_type: actor.type, author_id: actor.id, created_at: ts, updated_at: ts });
    svc.syncIndex('source', id);
  }
}

export interface RecordInput {
  title: string;
  body?: string;
  occurred_at?: string | null;
  owner?: string | null;
  due_at?: string | null;
  status?: string;
  question?: string;
  entity_kind?: string;
  aliases?: string[];
  facts?: string[];
  sources?: SourceRefIn[];
  supersedes?: string | null;
}

function isoOrNull(v: any): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Add an event / decision / action / entity to a dossier. Dedup by hash, entity resolution by name/alias. */
export function addRecord(svc: MemoryService, userId: string, dossierId: string, kind: RecordKind, r: RecordInput, actor: { type: 'user' | 'agent'; id: string; callId?: string | null }) {
  if (!RECORD_KINDS.includes(kind)) throw new Error('Onbekend soort dossierregel');
  const d = svc.store.get<any>('memory_dossiers', dossierId);
  const role = svc.dossierRole(userId, dossierId);
  if (!d || !role) throw new Error('Dossier niet gevonden');
  if (role === 'read') throw new Error('Je hebt alleen leesrechten op dit dossier');
  if (!['active', 'closed'].includes(d.status)) throw new Error('Dit dossier is gearchiveerd; zet het eerst terug');
  const title = clean(r.title, 500);
  const body = clean(r.body || '', 4000);
  if (!title) throw new Error('Titel ontbreekt');
  const all = [title, body, r.question || '', ...(r.facts || [])].join(' ');
  const secret = detectSecret(all);
  if (secret) throw new Error(`Niet opgeslagen: dit lijkt op een ${secret}.`);
  if (actor.type === 'agent' && isInjectionLike(all)) throw new Error('Niet opgeslagen: dit lijkt op een instructie uit een externe bron.');
  const owner = d.user_id;
  if (svc.blockedBy(owner, all, null, ['forget'])) throw new Error('Niet opgeslagen: dit is eerder op verzoek vergeten.');
  const quota = svc.quotaProblem({ user_id: owner, scope: 'dossier', dossier_id: dossierId }, Buffer.byteLength(all), false);
  if (quota) throw new Error(quota);
  const hash = hashRecord(svc, owner, kind, title, kind === 'entity' ? '' : body);
  const dup = svc.store.one<any>("SELECT * FROM memory_records WHERE dossier_id = ? AND kind = ? AND hash = ? AND status NOT IN ('trashed','forgotten')", dossierId, kind, hash);
  if (dup) return { record: svc.store.decode<any>('memory_records', dup), existed: true, message: `Stond al in het dossier [${svc.refOf(kind, dup.ref)}].` };

  const data: any = {};
  let ownerName = r.owner ? clean(r.owner, 100) : null;
  let status = 'active';
  let occurred = isoOrNull(r.occurred_at);
  let due: string | null = null;
  if (kind === 'event') {
    data.facts = (r.facts || []).map((f) => clean(String(f), 300)).filter(Boolean).slice(0, 20);
    occurred = occurred || now();
  } else if (kind === 'decision') {
    data.question = clean(r.question || '', 300);
    occurred = occurred || now();
  } else if (kind === 'action') {
    status = ACTION_STATUSES.includes(r.status || '') ? r.status! : 'open';
    due = isoOrNull(r.due_at);
  } else if (kind === 'entity') {
    data.entity_kind = ENTITY_KINDS.includes(r.entity_kind || '') ? r.entity_kind : 'person';
    data.aliases = (r.aliases || []).map((a) => clean(String(a), 80)).filter(Boolean).slice(0, 10);
    // Entity resolution: same normalised name or alias → enrich the existing entity instead of duplicating.
    const n = normalize(title);
    for (const e0 of svc.store.all<any>("SELECT * FROM memory_records WHERE dossier_id = ? AND kind = 'entity' AND status = 'active'", dossierId)) {
      const e = svc.store.decode<any>('memory_records', e0);
      const names = [e.title, ...(e.data?.aliases || [])].map(normalize);
      if (names.includes(n) || data.aliases.some((a: string) => names.includes(normalize(a)))) {
        const before = svc.snapshot('entity', e.id);
        const aliases = [...new Set([...(e.data?.aliases || []), ...data.aliases, ...(normalize(e.title) === n ? [] : [title])])].slice(0, 20);
        svc.store.update('memory_records', e.id, { body: body || e.body, data: { ...e.data, aliases }, version: (e.version || 1) + 1, updated_at: now() });
        svc.syncIndex('entity', e.id);
        svc.recordChange({ userId: owner, kind: 'entity', recordId: e.id, dossierId, op: 'merge', before, after: svc.snapshot('entity', e.id), summary: `Samengevoegd met bestaande: “${e.title}”`, actor: actor.type, actorId: actor.id });
        svc.emit(owner, { op: 'update', kind: 'entity', ids: [e.id], dossierId });
        return { record: svc.store.decode<any>('memory_records', svc.store.get('memory_records', e.id)), existed: true, message: `Bijgewerkt: [p:${e.ref}] ${e.title}.` };
      }
    }
  }
  const ts = now();
  const id = newId('rec_');
  const sources = (r.sources || []).filter((s) => s && s.kind).slice(0, 10).map((s) => ({ kind: clean(s.kind, 20), ref: s.ref ? clean(String(s.ref), 500) : null, threadId: s.threadId ?? null, title: s.title ? clean(s.title, 200) : null }));
  let supersedes: any = null;
  let message = '';
  return svc.store.tx(() => {
    // Decisions on the same question: a user decision replaces the old one; a bot decision becomes a review proposal.
    if (kind === 'decision') {
      const qn = canonicalKey(data.question || '');
      // The same question — or, without one (dossier_note gives only a sentence), a decision in nearly the same words.
      const open = () => svc.store.all<any>("SELECT * FROM memory_records WHERE dossier_id = ? AND kind = 'decision' AND status = 'active'", dossierId).map((x) => svc.store.decode<any>('memory_records', x));
      const tt = tokens(title);
      const target = r.supersedes ? svc.resolve(userId, r.supersedes)?.row : qn ? open().find((x) => canonicalKey(x.data?.question || '') === qn) : open().find((x) => !x.data?.question && jaccard(tt, tokens(x.title)) >= 0.5);
      if (target && target.dossier_id === dossierId && target.kind === 'decision' && target.status === 'active') {
        // Newer and at least as well sourced wins (as for notes, pipeline.ts): the owner's decision replaces any, a
        // bot's replaces a bot's; a bot against the owner's own decision is one question for him.
        const ownerDecided = target.author_type === 'user' || !!svc.store.one("SELECT 1 FROM memory_changes WHERE record_id = ? AND actor = 'user' AND undone_at IS NULL LIMIT 1", target.id);
        if (actor.type === 'user' || r.supersedes || !ownerDecided) {
          supersedes = target;
        } else {
          status = 'proposed';
          data.conflict_with = target.id;
          message = ` Dit botst met besluit [b:${target.ref}]; het staat ter beoordeling bij de gebruiker.`;
        }
      }
    }
    svc.store.insert('memory_records', {
      id,
      ref: svc.newRef('memory_records', owner),
      user_id: owner,
      dossier_id: dossierId,
      kind,
      title,
      body,
      occurred_at: occurred,
      owner: ownerName,
      due_at: due,
      status,
      data,
      sources,
      supersedes_id: supersedes?.id ?? null,
      author_type: actor.type,
      author_id: actor.id,
      version: 1,
      hash,
      origin_call_id: actor.callId ?? null,
      created_at: ts,
      updated_at: ts,
    });
    svc.syncIndex(kind, id);
    const batch = newId('mbt_');
    if (supersedes) {
      const before = svc.snapshot('decision', supersedes.id);
      svc.store.update('memory_records', supersedes.id, { status: 'superseded', superseded_by: id, updated_at: ts });
      svc.syncIndex('decision', supersedes.id);
      svc.recordChange({ userId: owner, kind: 'decision', recordId: supersedes.id, dossierId, op: 'supersede', before, after: svc.snapshot('decision', supersedes.id), summary: `Besluit vervangen: “${excerpt(supersedes.title, 80)}”`, actor: actor.type, actorId: actor.id, batchId: batch });
      message = ` Vervangt besluit [b:${supersedes.ref}].`;
    }
    upsertSources(svc, owner, dossierId, sources.filter((s) => s.kind === 'url' || s.kind === 'file') as any, actor);
    svc.store.update('memory_dossiers', dossierId, { updated_at: ts, version: (d.version || 1) + 1 });
    const labels: Record<string, string> = { event: 'Gebeurtenis', decision: 'Besluit', action: 'Actiepunt', entity: 'Persoon/organisatie' };
    const changeId = svc.recordChange({ userId: owner, kind, recordId: id, dossierId, op: status === 'proposed' ? 'propose' : 'create', before: null, after: svc.snapshot(kind, id), summary: `${labels[kind]}: “${excerpt(title, 90)}”`, actor: actor.type, actorId: actor.id, batchId: supersedes ? batch : null });
    svc.emit(owner, { op: 'create', kind, ids: [id], dossierId, changeId });
    svc.markDossierChanged(dossierId);
    svc.ctx.audit(owner, 'memory.record_created', { kind, dossier: d.ref }, actor.type === 'agent' ? actor.id : null);
    const rec = svc.store.decode<any>('memory_records', svc.store.get('memory_records', id));
    return { record: rec, existed: false, changeId, message: `${status === 'proposed' ? 'Voorstel' : 'Toegevoegd'}: [${svc.refOf(kind, rec.ref)}] ${excerpt(title, 80)}.${message}` };
  });
}

export function updateRecord(svc: MemoryService, userId: string, recordId: string, patch: any, actor: { type: 'user' | 'agent'; id: string }) {
  const r0 = svc.store.get<any>('memory_records', recordId);
  if (!r0) throw new Error('Niet gevonden');
  const r = svc.store.decode<any>('memory_records', r0);
  const role = svc.dossierRole(userId, r.dossier_id);
  if (!role) throw new Error('Niet gevonden');
  if (role === 'read') throw new Error('Je hebt alleen leesrechten op dit dossier');
  if (r.status === 'forgotten') throw new Error('Dit is vergeten');
  const p: any = {};
  if (patch.title !== undefined) p.title = clean(patch.title, 500) || r.title;
  if (patch.body !== undefined) p.body = clean(patch.body, 4000);
  if (patch.owner !== undefined) p.owner = patch.owner ? clean(patch.owner, 100) : null;
  if (patch.due_at !== undefined) p.due_at = isoOrNull(patch.due_at);
  if (patch.occurred_at !== undefined) p.occurred_at = isoOrNull(patch.occurred_at) || r.occurred_at;
  if (patch.status !== undefined) {
    const allowed = r.kind === 'action' ? [...ACTION_STATUSES, 'trashed'] : ['active', 'revoked', 'trashed', ...(r.kind === 'decision' ? ['proposed'] : [])];
    if (!allowed.includes(patch.status)) throw new Error('Ongeldige status');
    p.status = patch.status;
    p.trashed_at = patch.status === 'trashed' ? now() : null;
    if (r.kind === 'action' && patch.status === 'done') p.data = { ...r.data, completed_at: now(), completion_source: patch.completion_source ? clean(patch.completion_source, 300) : actor.type === 'agent' ? `bot:${actor.id}` : 'gebruiker' };
  }
  if (patch.question !== undefined && r.kind === 'decision') p.data = { ...(p.data || r.data), question: clean(patch.question, 300) };
  if (patch.aliases !== undefined && r.kind === 'entity') p.data = { ...(p.data || r.data), aliases: (patch.aliases || []).map((a: any) => clean(String(a), 80)).filter(Boolean).slice(0, 20) };
  const text = [p.title, p.body].filter(Boolean).join(' ');
  if (text && detectSecret(text)) throw new Error('Dit lijkt een wachtwoord of sleutel te bevatten.');
  if (text && actor.type === 'agent' && isInjectionLike(text)) throw new Error('Niet opgeslagen: dit lijkt op een instructie uit een externe bron.');
  if (!Object.keys(p).length) return r;
  return svc.store.tx(() => {
    const before = svc.snapshot(r.kind, recordId);
    if (p.title !== undefined || p.body !== undefined) p.hash = hashRecord(svc, r.user_id, r.kind, p.title ?? r.title, r.kind === 'entity' ? '' : p.body ?? r.body);
    svc.store.update('memory_records', recordId, { ...p, version: (r.version || 1) + 1, updated_at: now() });
    svc.syncIndex(r.kind, recordId);
    const op = p.status === 'trashed' ? 'trash' : p.status === 'done' ? 'complete' : 'update';
    const changeId = svc.recordChange({ userId: r.user_id, kind: r.kind, recordId, dossierId: r.dossier_id, op, before, after: svc.snapshot(r.kind, recordId), summary: `${op === 'complete' ? 'Afgerond' : op === 'trash' ? 'Naar prullenbak' : 'Bijgewerkt'}: “${excerpt(p.title || r.title, 80)}”`, actor: actor.type, actorId: actor.id });
    // Approving a proposed decision that conflicts: the old one is superseded.
    if (r.kind === 'decision' && r.status === 'proposed' && p.status === 'active' && r.data?.conflict_with) {
      const old = svc.store.get<any>('memory_records', r.data.conflict_with);
      if (old && old.status === 'active') {
        const ob = svc.snapshot('decision', old.id);
        svc.store.update('memory_records', old.id, { status: 'superseded', superseded_by: recordId, updated_at: now() });
        svc.store.update('memory_records', recordId, { supersedes_id: old.id });
        svc.syncIndex('decision', old.id);
        svc.recordChange({ userId: r.user_id, kind: 'decision', recordId: old.id, dossierId: r.dossier_id, op: 'supersede', before: ob, after: svc.snapshot('decision', old.id), summary: `Besluit vervangen: “${excerpt(old.title, 80)}”`, actor: actor.type, actorId: actor.id });
      }
    }
    svc.store.update('memory_dossiers', r.dossier_id, { updated_at: now() });
    svc.markDossierChanged(r.dossier_id);
    svc.emit(r.user_id, { op, kind: r.kind, ids: [recordId], dossierId: r.dossier_id, changeId });
    return svc.store.decode<any>('memory_records', svc.store.get('memory_records', recordId));
  });
}

const TEXT_EXT = /\.(txt|md|markdown|csv|json|xml|ya?ml|toml|ini|log|html?|js|ts|py|sql|sh|ps1)$/i;
const DOC_EXT = /\.(pdf|docx|docm|dotx|xlsx|xlsm|pptx|pptm|png|jpe?g|bmp|tiff?|webp)$/i;
const DOC_MIME = /pdf|wordprocessingml|msword|spreadsheetml|presentationml|^image\//;
const DOC_MAX_BYTES = 60 * 1024 * 1024;
export const PDF_UNAVAILABLE = 'PDF lezen lukt niet: het onderdeel pdf.js ontbreekt in deze installatie. Installeer TeamBot opnieuw, of plak de tekst of voeg een Word-bestand toe.';

/** What the owner reads when a pdf could not be read: pdf.js missing from this build, or the file itself. */
export function pdfReadError(e: any): Error {
  if (/cannot find (module|package)|ERR_MODULE_NOT_FOUND|pdfjs-dist/i.test(String(e?.code || '') + ' ' + String(e?.message || e))) return new Error(PDF_UNAVAILABLE);
  return new Error(`Deze pdf kon niet worden gelezen: ${String(e?.message || e).slice(0, 160)}`);
}

/** A dossier source keeps at most this much text (addSource cuts there too); more is said, not hidden. */
const SOURCE_MAX_CHARS = 400_000;

/**
 * The text of a document for a dossier source, so it becomes searchable and quotable (folders/documents.ts reads it):
 * pdf with pdf.js and OCR for scanned pages, Word with mammoth (headings and tables kept), Excel sheets as tables,
 * PowerPoint slides with notes, a photo of a text with OCR. Pages keep a "--- pagina n ---" line, so a bot can say
 * where a quote comes from. A picture fetches the language data for reading scans first, as read_document does
 * (ocr.ts `ensure`). Null: not a document (text files are handled by addSource), or a picture while that could not be
 * fetched (no internet): the source is kept without text.
 */
export async function documentSourceText(file: string, name = file): Promise<string | null> {
  const st = fs.statSync(file);
  if (st.size > DOC_MAX_BYTES) throw new Error(`Dit document is te groot om te doorzoeken (${Math.round(st.size / 1024 / 1024)} MB, max 60 MB).`);
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  const { readDocument, documentKind } = await import('../folders/documents.js');
  const { ocrEngine, OCR_HINT } = await import('../folders/ocr.js');
  const kind = documentKind(head, name);
  if (!kind || kind === 'text') return null;
  if (kind === 'image' && !(await ocrEngine()?.ensure())) return null;
  const label = { pdf: 'Deze pdf', word: 'Dit Word-bestand', excel: 'Deze Excel-werkmap', powerpoint: 'Deze presentatie', image: 'Deze afbeelding' }[kind];
  let d: Awaited<ReturnType<typeof readDocument>>;
  try {
    d = await readDocument(file, { name, maxChars: SOURCE_MAX_CHARS });
  } catch (e: any) {
    if (kind === 'pdf') throw pdfReadError(e);
    throw new Error(`${label} kon niet worden gelezen: ${String(e?.message || e).slice(0, 160)}`);
  }
  let text = d.text;
  if (kind === 'pdf') {
    const plain = text.replace(/--- pagina \d+ ---/g, '').replace(/\(geen tekst op deze pagina[^)]*\)/g, '').trim();
    if (plain.length < 20) throw new Error(`In deze pdf staat geen leesbare tekst (waarschijnlijk een scan). ${ocrEngine()?.ready() ? '' : `${ocrEngine()?.problem() ?? OCR_HINT} `}Of plak de tekst, of voeg een versie met tekst toe.`);
  } else if (text.replace(/^## (Dia|Blad).*$|\((leeg|geen tekst[^)]*)\)/gm, '').trim().length < 2) {
    throw new Error(kind === 'word' ? 'In dit Word-bestand staat geen tekst.' : `${label} bevat geen tekst.`);
  }
  if (d.notes.length) text += `\n\n[${d.notes.join(' ')}]`;
  if (text.length > SOURCE_MAX_CHARS) text = text.slice(0, SOURCE_MAX_CHARS - 80) + `\n… (afgekapt: alleen de eerste ${SOURCE_MAX_CHARS.toLocaleString('nl-NL')} tekens zijn doorzoekbaar)`;
  return text;
}

/**
 * Read the text of a pdf/Word attachment or workspace file before the (synchronous) source is written; other
 * sources are passed on unchanged. Then addSource does the checks, chunking and indexing.
 */
export async function addSourceAsync(
  svc: MemoryService,
  userId: string,
  dossierId: string,
  o: Parameters<typeof addSource>[3],
  actor: Parameters<typeof addSource>[4],
) {
  const extra: { text?: string; title?: string } = {};
  if (o.attachmentId && !o.text) {
    const a = svc.store.get<any>('attachments', o.attachmentId);
    if (!a || a.user_id !== userId) throw new Error('Bijlage niet gevonden');
    if ((DOC_EXT.test(a.name) || DOC_MIME.test(a.mime || '')) && fs.existsSync(a.path)) {
      const t = await documentSourceText(a.path, a.name);
      if (t) extra.text = t;
    }
  } else if (o.kind === 'file' && actor.agent && o.target && !o.text && DOC_EXT.test(o.target)) {
    const abs = resolveInWorkspace(actor.agent, o.target);
    const t = await documentSourceText(abs, abs);
    if (t) {
      extra.text = t;
      extra.title = o.title || path.basename(abs);
    }
  }
  return addSource(svc, userId, dossierId, { ...o, ...extra }, actor);
}

/**
 * Attach a source to a dossier. Text sources (pasted text, text attachments, workspace text files, and pdf/Word files
 * whose text addSourceAsync read first) are chunked and indexed as a rebuildable knowledge library (words and
 * meaning); URLs are recorded without fetching (no network from here).
 */
export function addSource(
  svc: MemoryService,
  userId: string,
  dossierId: string,
  o: { kind: string; target?: string; title?: string; text?: string; attachmentId?: string; threadId?: string | null },
  actor: { type: 'user' | 'agent'; id: string; agent?: Agent | null },
) {
  const d = svc.store.get<any>('memory_dossiers', dossierId);
  const role = svc.dossierRole(userId, dossierId);
  if (!d || !role) throw new Error('Dossier niet gevonden');
  if (role === 'read') throw new Error('Je hebt alleen leesrechten op dit dossier');
  let kind = ['url', 'file', 'attachment', 'note', 'message'].includes(o.kind) ? o.kind : 'note';
  let target = clean(o.target || '', 1000);
  let title = clean(o.title || '', 200);
  let text = o.text ? String(o.text).slice(0, 400_000) : '';
  if (kind === 'url') {
    try {
      const u = new URL(target);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      target = u.toString();
    } catch {
      throw new Error('Ongeldige URL');
    }
  }
  if (o.attachmentId) {
    const a = svc.store.get<any>('attachments', o.attachmentId);
    if (!a || a.user_id !== userId) throw new Error('Bijlage niet gevonden');
    kind = 'attachment';
    target = a.id;
    title = title || a.name;
    // (a Word mime type contains "xml" too: documents are read by addSourceAsync, never as raw text)
    const document = DOC_EXT.test(a.name) || DOC_MIME.test(a.mime || '');
    if (!text && !document && (/^text\//.test(a.mime) || TEXT_EXT.test(a.name) || /json|xml|yaml|csv/.test(a.mime)) && a.size < 400_000 && fs.existsSync(a.path)) text = fs.readFileSync(a.path, 'utf8');
  }
  if (kind === 'file' && actor.agent && target && !text) {
    // Workspace file of the calling bot (path is checked against its workspace roots and secret-file protection).
    const abs = resolveInWorkspace(actor.agent, target);
    const st = fs.statSync(abs);
    if (st.size < 400_000 && TEXT_EXT.test(abs)) text = fs.readFileSync(abs, 'utf8');
    title = title || path.basename(abs);
  }
  if (!target && !text) throw new Error('Geef een URL, bestand of tekst op');
  if (text && detectSecret(text)) throw new Error('Deze tekst lijkt wachtwoorden of sleutels te bevatten en wordt niet geïndexeerd.');
  if (svc.blockedBy(d.user_id, [title, target].join(' '), null, ['forget'])) throw new Error('Niet opgeslagen: dit is eerder op verzoek vergeten.');
  // A new version of a document already in this dossier (same title, link or file): it replaces the old one, which
  // stays in the history but is no longer searched; the dossier is read again against it (reread.ts, 0.4.4). The
  // same text again changes nothing.
  const hash = text ? svc.hmac(d.user_id, 'src:' + normalize(text).slice(0, 5000)) : '';
  const prev = previousVersion(svc, dossierId, { kind, target, title, hash });
  if (prev && hash && prev.hash === hash) return svc.store.get<any>('memory_sources', prev.id);
  const quota = svc.quotaProblem({ user_id: d.user_id, scope: 'dossier', dossier_id: dossierId }, Buffer.byteLength(text || target), false);
  if (quota) throw new Error(quota);
  const ts = now();
  const id = newId('src_');
  return svc.store.tx(() => {
    const chunks = text ? chunkText(text) : [];
    if (prev) {
      const before = svc.snapshot('source', prev.id);
      svc.store.update('memory_sources', prev.id, { status: 'superseded', updated_at: ts });
      for (const c of svc.store.all<any>('SELECT id FROM memory_chunks WHERE source_id = ?', prev.id)) svc.unindex('chunk', c.id);
      svc.recordChange({ userId: d.user_id, kind: 'source', recordId: prev.id, dossierId, op: 'supersede', before, after: svc.snapshot('source', prev.id), summary: `Nieuwe versie van “${excerpt(prev.title || prev.target, 80)}”`, actor: actor.type, actorId: actor.id });
    }
    svc.store.insert('memory_sources', {
      id,
      ref: svc.newRef('memory_sources', d.user_id),
      user_id: d.user_id,
      dossier_id: dossierId,
      kind,
      target,
      thread_id: o.threadId ?? null,
      title: title || (kind === 'url' ? target : 'Notitie'),
      excerpt: text ? excerpt(text, 400) : '',
      hash,
      replaces_id: prev?.id ?? null,
      trust: actor.type === 'user' ? 'user' : 'agent',
      chunks: chunks.length,
      status: 'active',
      observed_at: ts,
      author_type: actor.type,
      author_id: actor.id,
      created_at: ts,
      updated_at: ts,
    });
    chunks.forEach((c, i) => {
      const cid = newId('chk_');
      svc.store.insert('memory_chunks', { id: cid, user_id: d.user_id, source_id: id, dossier_id: dossierId, seq: i, text: c, created_at: ts });
      svc.indexChunk(cid, d.user_id, c);
    });
    svc.syncIndex('source', id);
    svc.store.update('memory_dossiers', dossierId, { updated_at: ts });
    svc.markDossierChanged(dossierId);
    const changeId = svc.recordChange({ userId: d.user_id, kind: 'source', recordId: id, dossierId, op: 'create', before: null, after: svc.snapshot('source', id), summary: `${prev ? 'Nieuwe versie van bron' : 'Bron toegevoegd'}: “${excerpt(title || target, 80)}”${chunks.length ? ` (${chunks.length} delen geïndexeerd)` : ''}`, actor: actor.type, actorId: actor.id });
    svc.emit(d.user_id, { op: 'create', kind: 'source', ids: [id], dossierId, changeId });
    return svc.store.get<any>('memory_sources', id);
  });
}

/** The active source this one is a new version of: the same link or file, or the same (own) title. */
function previousVersion(svc: MemoryService, dossierId: string, o: { kind: string; target: string; title: string; hash: string }): any | null {
  const rows = svc.store.all<any>("SELECT * FROM memory_sources WHERE dossier_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 200", dossierId);
  if (['url', 'file'].includes(o.kind) && o.target) {
    const hit = rows.find((r) => r.kind === o.kind && r.target === o.target);
    if (hit) return hit;
  }
  const t = normalize(o.title);
  // A real title (not the default "Notitie"), at least two words or a file name.
  if (!t || t === 'notitie' || (t.split(' ').length < 2 && !/\.[a-z0-9]{2,5}$/i.test(o.title))) return null;
  return rows.find((r) => normalize(r.title) === t) || null;
}

export function dossierMarkdown(svc: MemoryService, reader: Reader, id: string): string {
  const full = getDossier(svc, reader, id);
  if (!full) return '';
  const d = full.dossier!;
  const L: string[] = [`# ${d.title}`, '', `_Dossier [d:${d.ref}] · ${d.kind} · status ${d.status} · laatst bijgewerkt ${shortDate(d.last_activity_at)}_`, ''];
  if (d.summary) L.push('## Samenvatting', '', d.summary, '');
  if (full.decisions.length) {
    L.push('## Besluiten', '');
    for (const r of full.decisions) L.push(`- [b:${r.ref}] ${r.title}${r.data?.question ? ` — vraag: ${r.data.question}` : ''}${r.body ? ` — waarom: ${r.body}` : ''} (${shortDate(r.occurred_at)}, ${r.status})`);
    L.push('');
  }
  if (full.actions.length) {
    L.push('## Acties', '');
    for (const r of full.actions) L.push(`- [${r.status === 'done' ? 'x' : ' '}] [a:${r.ref}] ${r.title}${r.owner ? ` — ${r.owner}` : ''}${r.due_at ? ` — uiterlijk ${shortDate(r.due_at)}` : ''}${r.status === 'cancelled' ? ' (geannuleerd)' : ''}`);
    L.push('');
  }
  if (full.events.length) {
    L.push('## Tijdlijn', '');
    for (const r of full.events) L.push(`- ${shortDate(r.occurred_at)} [g:${r.ref}] ${r.title}${r.body ? ` — ${r.body}` : ''}`);
    L.push('');
  }
  if (full.entities.length) {
    L.push('## Personen en organisaties', '');
    for (const r of full.entities) L.push(`- [p:${r.ref}] ${r.title} (${r.data?.entity_kind || 'persoon'})${r.body ? ` — ${r.body}` : ''}${r.data?.aliases?.length ? ` — ook: ${r.data.aliases.join(', ')}` : ''}`);
    L.push('');
  }
  if (full.items.length) {
    L.push('## Notities', '');
    for (const i of full.items) if (i) L.push(`- [m:${i.ref}] ${i.content}${i.status === 'proposed' ? ' _(voorstel)_' : ''}`);
    L.push('');
  }
  if (full.sources.length) {
    L.push('## Bronnen', '');
    for (const s of full.sources) L.push(`- [s:${s.ref}] ${s.title}${s.kind === 'url' ? ` — ${s.target}` : ''}${s.chunks ? ` (${s.chunks} delen geïndexeerd)` : ''}`);
    L.push('');
  }
  return L.join('\n');
}
