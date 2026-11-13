/**
 * One time, for an install that still has loose notes (from before every write went into a dossier): each note moves
 * into the dossier it belongs in, by the same placement as a new write (write.ts) and without a model.
 *
 * - What fits becomes a line of that dossier's text, under a plain heading, by the one rule: what is said twice becomes
 *   one line. The owner's instructions and preferences go first, so they are in before the text is full. The note
 *   itself goes to the archive.
 * - What does not fit, and what text cannot hold (a pinned note — it keeps counting as a rule —, something sensitive,
 *   something from outside, a card that still waits for the owner), stays a note with everything it had, now as a note
 *   of that dossier.
 * Nothing is deleted. Everything is one batch: one undo in Geheugen › Geschiedenis brings every note back as it was.
 * Dossiers about a subject, knowledge bases and customer dossiers are not touched.
 */
import { newId, now } from '../../core/db.js';
import type { MemoryService } from './service.js';
import type { MemoryItemRow } from './types.js';
import { excerpt } from './text.js';
import { addToBody, limitOf, notesDossier, writeBody, type WriteActor } from './living.js';
import { dossierAt, placeOf } from './write.js';

export interface MoveResult {
  /** Dossiers that got text or notes. */
  dossiers: number;
  /** Notes that became a line of a dossier's text, and notes that became a note of a dossier. */
  inText: number;
  asNotes: number;
  batchId: string | null;
}

/** Plain headings for what becomes text, in the order they are written. */
const SECTIONS = ['Voorkeuren en afspraken', 'Besluiten', 'Feiten', 'Mensen', 'Open punten'] as const;
const SECTION: Record<string, (typeof SECTIONS)[number]> = { instruction: 'Voorkeuren en afspraken', preference: 'Voorkeuren en afspraken', decision: 'Besluiten', fact: 'Feiten', person: 'Mensen', event: 'Feiten', task: 'Open punten', note: 'Feiten', lesson: 'Feiten' };
const FIRST: Record<string, number> = { instruction: 0, preference: 1, decision: 2 };

const shortDay = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
};

export function moveLooseNotes(svc: MemoryService, userId: string): MoveResult {
  const rows = svc.store
    .all<any>("SELECT * FROM memory_items WHERE user_id = ? AND status IN ('active','proposed') AND scope IN ('about_you','shared','agent') AND dossier_id IS NULL ORDER BY created_at, id", userId)
    .map((r) => svc.store.decode<MemoryItemRow>('memory_items', r));
  if (!rows.length) return { dossiers: 0, inText: 0, asNotes: 0, batchId: null };
  const batchId = newId('mbt_');
  const actor: WriteActor = { type: 'system', id: 'memory-move', batchId, reason: 'losse notities naar dossiers' };
  return svc.store.tx(() => {
    const targets = new Map<string, { d: any; items: MemoryItemRow[] }>();
    for (const r of rows) {
      const bot = r.agent_id ? svc.store.agent(r.agent_id) : null;
      // (A note of a bot that no longer exists is an orphan: the regular clean-up puts it in the bin.)
      if (r.scope === 'agent' && !bot) continue;
      const d = dossierAt(svc, userId, placeOf(r.scope, r.type), { agent: bot, teamId: r.team_id ?? null });
      if (!d) continue;
      const t = targets.get(d.id) || { d, items: [] };
      t.items.push(r);
      targets.set(d.id, t);
    }
    let inText = 0;
    let asNotes = 0;
    for (const { d, items } of targets.values()) {
      const limit = limitOf(d);
      let body = String(d.body || '');
      const filed: MemoryItemRow[] = [];
      const stay: MemoryItemRow[] = [];
      const text = (r: MemoryItemRow) =>
        r.status === 'active' && !r.pinned && r.sensitivity !== 'sensitive' && !['external', 'customer'].includes(r.source_trust) && !(r.flags || []).some((f) => f === 'external' || f === 'tainted' || f === 'injection') && !(r.expires_at && r.expires_at <= now());
      for (const r of [...items].sort((a, b) => (FIRST[a.type] ?? 9) - (FIRST[b.type] ?? 9))) {
        const line = text(r) ? svc.contentOf(r).replace(/\s*\n+\s*/g, ' ').trim() : '';
        if (!line) {
          stay.push(r);
          continue;
        }
        const next = addToBody(body, `- ${line}`, d.core === 'owner' || d.core === 'overview' ? SECTION[r.type] || 'Feiten' : null, r.canonical_key);
        if (next && next.body.length > limit * 0.9) {
          stay.push(r);
          continue;
        }
        if (next) body = next.body;
        filed.push(r);
      }
      try {
        if (body !== String(d.body || '')) writeBody(svc, d.id, body, actor);
      } catch (e: any) {
        // (A secret that slipped into an old note, something forgotten since: then these stay notes of the dossier.)
        svc.ctx.log.warn(`[memory] losse notities in de tekst van dossier “${d.title}” zetten mislukt; ze blijven notities van het dossier`, e?.message || e);
        stay.push(...filed.splice(0));
      }
      for (const r of filed) {
        const before = svc.snapshot('item', r.id);
        svc.patchItem(r.id, { status: 'archived' });
        svc.recordChange({ userId, kind: 'item', recordId: r.id, dossierId: d.id, op: 'archive', before, after: svc.snapshot('item', r.id), summary: `In dossier “${excerpt(d.title, 60)}” gezet: ${svc.label(r)}`, reason: `verwerkt in d:${d.ref}`, actor: 'system', actorId: 'memory-move', batchId, undoDays: 365 });
        inText++;
      }
      for (const r of stay) {
        const before = svc.snapshot('item', r.id);
        svc.patchItem(r.id, { dossier_id: d.id } as any);
        svc.recordChange({ userId, kind: 'item', recordId: r.id, dossierId: d.id, op: 'update', before, after: svc.snapshot('item', r.id), summary: `Notitie bij dossier “${excerpt(d.title, 60)}” gezet: ${svc.label(r)}`, reason: `nu een notitie van d:${d.ref}`, actor: 'system', actorId: 'memory-move', batchId, undoDays: 365 });
        asNotes++;
      }
    }
    // One line for the owner's main bot, in its own working notes (no routine, no model call now): the dossiers were
    // put together automatically and want a tidy-up when it next works on them.
    if (inText) {
      try {
        const mainId = svc.teams?.mainOf?.(userId) || null;
        const main = mainId ? svc.store.agent(mainId) : null;
        if (main) {
          const notes = notesDossier(svc, main);
          const next = addToBody(String(notes.body || ''), `- De dossiers zijn op ${shortDay(now())} automatisch samengesteld uit losse notities. Loop ze na zodra je eraan werkt: herschrijf ze kort en samenhangend, en haal deze regel daarna weg.`);
          if (next && next.body.length <= limitOf(notes)) writeBody(svc, notes.id, next.body, actor);
        }
      } catch (e: any) {
        svc.ctx.log.warn('[memory] notitie voor de hoofdbot schrijven mislukt', e?.message || e);
      }
    }
    if (inText || asNotes) svc.emit(userId, { op: 'fold', kind: 'dossier' });
    return { dossiers: targets.size, inText, asNotes, batchId: inText || asNotes ? batchId : null };
  });
}

/** The move, once per install (at start; no model, no network). After it no note exists outside a dossier. */
export function moveOnce(svc: MemoryService): void {
  if (svc.store.getSetting<any>('', 'memory.onePath', null)) return;
  let ok = true;
  for (const u of svc.store.all<any>("SELECT DISTINCT user_id FROM memory_items WHERE status IN ('active','proposed') AND scope IN ('about_you','shared','agent') AND dossier_id IS NULL")) {
    try {
      const r = moveLooseNotes(svc, u.user_id);
      svc.store.setSetting(u.user_id, 'memory.moved', { at: now(), ...r });
      if (r.batchId) svc.ctx.log.info(`[memory] losse notities naar dossiers: ${r.inText} in de tekst van een dossier, ${r.asNotes} als notitie van een dossier; terug te draaien in Geheugen › Geschiedenis`);
    } catch (e) {
      // Tried again at the next start: nothing was changed for this owner.
      ok = false;
      svc.ctx.log.error('[memory] losse notities naar dossiers zetten mislukt (er is niets gewijzigd)', e);
    }
  }
  if (ok) svc.store.setSetting('', 'memory.onePath', now());
}
