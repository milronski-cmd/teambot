/**
 * Retired practices: something that used to work and no longer does ("meta keywords helpen voor SEO", "antwoord
 * klanten ook per mail"). Unlike a fact that simply changed (a new version replaces it), a retired practice has no
 * successor — so the bot must be told NOT to do it any more, or it falls back on what it once learned (or on what
 * its model was trained on).
 *
 * A retired note leaves the active set like any ended fact (status `superseded`, `valid_to` = since when,
 * `invalid_reason` = why; history and undo for 62 days) and carries the flag `retired`. The newest few are given to the
 * bots that could read the note, briefly, as "do not do this any more, because …" (bounded: RETIRED_LINES lines,
 * RETIRED_DAYS days; older ones stay in the history and in memory_search with `history: true`).
 */
import { now } from '../../core/db.js';
import type { MemoryService } from './service.js';
import type { MemoryItemRow, Reader } from './types.js';
import { invalidateItem } from './consolidate.js';
import { clean, excerpt, tokens } from './text.js';

/** At most this many "niet meer doen" lines per turn. */
export const RETIRED_LINES = 5;
/** A retired practice is repeated to the bot this long; after that it only lives in the history. */
export const RETIRED_DAYS = 365;

/** Retire an active note: out of the active set with the reason and the date, flagged so bots are told. One undo. */
export function retireItem(svc: MemoryService, row: MemoryItemRow, o: { reason: string; actor: 'user' | 'agent' | 'system'; actorId?: string | null }): { changeId: string; item: MemoryItemRow } {
  if (row.status !== 'active') throw new Error('Alleen iets dat nu geldt kan vervallen.');
  const reason = clean(o.reason, 300);
  if (reason.length < 3) throw new Error('Zeg kort waarom dit niet meer klopt.');
  return svc.store.tx(() => {
    const changeId = invalidateItem(svc, row, { reason, actor: o.actor, actorId: o.actorId ?? null });
    svc.patchItem(row.id, { flags: [...new Set([...(row.flags || []).filter((f) => f !== 'check'), 'retired'])], review_at: null, review_note: null } as any);
    svc.store.update('memory_changes', changeId, { summary: `Vervallen: ${svc.label(row)} (${excerpt(reason, 120)})` });
    return { changeId, item: svc.itemRow(row.id)! };
  });
}

function retiredRows(svc: MemoryService, where: { sql: string; params: any[] }, limit: number): MemoryItemRow[] {
  const since = new Date(Date.now() - RETIRED_DAYS * 864e5).toISOString();
  return svc.store
    .all<any>(`SELECT i.* FROM memory_items i WHERE ${where.sql} AND i.status = 'superseded' AND i.flags LIKE '%"retired"%' AND i.valid_to >= ? AND i.content_enc IS NULL ORDER BY i.valid_to DESC LIMIT ?`, ...where.params, since, limit)
    .map((r) => svc.store.decode<MemoryItemRow>('memory_items', r));
}

/** Retired notes of one dossier (a specialist's knowledge base), newest first. */
export function retiredInDossier(svc: MemoryService, userId: string, dossierId: string, limit = 50): MemoryItemRow[] {
  return retiredRows(svc, { sql: 'i.user_id = ? AND i.dossier_id = ?', params: [userId, dossierId] }, limit);
}

/** Retired notes this reader could read when they still held (its own notes, its team's knowledge, its dossiers). */
export function retiredFor(svc: MemoryService, reader: Reader, limit = 30): MemoryItemRow[] {
  const acl = svc.aclSql(reader, 'i', { history: true });
  return retiredRows(svc, acl, limit);
}

/** One short line: what, since when, why. */
export function retiredLine(svc: MemoryService, r: MemoryItemRow): string {
  const since = r.valid_to ? new Date(r.valid_to).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return `- ${excerpt(svc.contentOf(r), 160)}: niet meer${since ? ` sinds ${since}` : ''}${r.invalid_reason ? `, omdat: ${excerpt(r.invalid_reason, 140)}` : ''}`;
}

/**
 * The "niet meer doen" block for a turn: what matches the message first, then the newest; never more than
 * RETIRED_LINES. Null when nothing was retired.
 */
export function retiredBlock(svc: MemoryService, rows: MemoryItemRow[], query: string): string | null {
  if (!rows.length) return null;
  const q = new Set(tokens(query || ''));
  const scored = rows.map((r, i) => ({ r, i, n: q.size ? tokens(svc.contentOf(r)).filter((t) => q.has(t)).length : 0 }));
  const pick = scored.sort((a, b) => b.n - a.n || a.i - b.i).slice(0, RETIRED_LINES);
  return `<niet_meer info="Werkwijzen en feiten die vroeger klopten en nu niet meer. Gebruik of adviseer ze niet meer, ook niet als je ze uit jezelf zou weten.">\n${pick.map((p) => retiredLine(svc, p.r)).join('\n')}\n</niet_meer>`;
}

/** For lists (the Kennisbank page, the API): a retired note as plain data. */
export function retiredView(svc: MemoryService, r: MemoryItemRow) {
  return { id: r.id, ref: r.ref, content: svc.contentOf(r), reason: r.invalid_reason || '', since: r.valid_to || r.updated_at, source: r.source_ref, at: now() };
}
