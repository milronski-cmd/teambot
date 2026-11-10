/**
 * Lifecycle: quota usage/reporting, TTL expiry, review dates, 30-day trash, rejected-proposal purge, orphan cleanup,
 * change-snapshot pruning, episode caps, quota warnings and (proposal-only) consolidation. Background work has a time
 * cap, runs single-flight and respects the pause switch.
 */
import { newId, now } from '../../core/db.js';
import type { MemoryService } from './service.js';
import { TABLE_OF } from './service.js';
import type { MemoryItemRow } from './types.js';
import { ALL_TEAMS } from './types.js';
import { estimateTokens } from '../../core/tokens.js';
import { jaccard, tokens } from './text.js';

export function storageReport(svc: MemoryService, userId: string) {
  const s = svc.userSettings(userId);
  const st = svc.store;
  const scopeUse = (scope: string) => st.one<any>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM memory_items WHERE user_id = ? AND scope = ? AND status IN ('active','proposed','archived','superseded')", userId, scope);
  const scopes: any = {};
  for (const k of ['about_you', 'shared'] as const) {
    const u = scopeUse(k);
    scopes[k] = { items: u?.n || 0, bytes: u?.b || 0, quota: s.quotas[k] };
  }
  // Shared knowledge has a quota per team (and one for "alle teams"); listed with two or more teams.
  const info = svc.teamInfo(userId);
  const sharedByTeam = info?.multi
    ? [...info.ids, ALL_TEAMS].map((teamId) => ({ teamId, name: teamId === ALL_TEAMS ? 'Alle teams' : info.names.get(teamId) || '', ...svc.bucketUsage({ user_id: userId, scope: 'shared', team_id: teamId }), quota: s.quotas.shared }))
    : [];
  const agents = svc.store.agents(userId, { archived: true }).map((a) => {
    // A bot's notes count per team (its home team now); notes from a team it left are in that team.
    const u = svc.bucketUsage({ user_id: userId, scope: 'agent', agent_id: a.id, team_id: svc.homeTeam(a) });
    const eff = svc.effective(a);
    const acl = svc.aclSql({ ...svc.readerFor(a, null), readShared: true, readAboutYou: true });
    const pinned = st.all<any>(`SELECT i.* FROM memory_items i WHERE ${acl.sql} AND i.pinned = 1 AND i.scope IN ('agent','shared','about_you')`, ...acl.params).map((r) => st.decode<MemoryItemRow>('memory_items', r));
    const profileTokens = pinned.reduce((n, r) => n + estimateTokens(svc.contentOf(r)) + 18, 0);
    return { id: a.id, name: a.name, avatar: a.avatar, color: a.color, items: u.items, bytes: u.bytes, quota: s.quotas.agent, profileTokens, profileCap: eff.profileCap, budgetTokens: eff.budgetTokens, learn: eff.learn, enabled: eff.enabled, readShared: eff.readShared, readAboutYou: eff.readAboutYou, team: svc.teamTag(userId, svc.homeTeam(a)) };
  });
  const dossiers = st.all<any>("SELECT id, title, status FROM memory_dossiers WHERE user_id = ? AND status NOT IN ('forgotten')", userId).map((d) => ({ id: d.id, title: d.title, status: d.status, ...svc.bucketUsage({ user_id: userId, scope: 'dossier', dossier_id: d.id }), quota: s.quotas.dossier }));
  const ep = st.one<any>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(summary) + LENGTH(decisions) + LENGTH(actions) + LENGTH(questions)),0) AS b FROM memory_episodes WHERE user_id = ?", userId);
  const trash = st.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND status = 'trashed'", userId)?.n || 0;
  const trashRecords = st.one<any>("SELECT COUNT(*) AS n FROM memory_records WHERE user_id = ? AND status = 'trashed'", userId)?.n || 0;
  const proposals = st.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND status = 'proposed'", userId)?.n || 0;
  const blocks = st.one<any>("SELECT COUNT(*) AS n FROM memory_tombstones WHERE user_id = ? AND kind = 'forget'", userId)?.n || 0;
  const index = st.one<any>('SELECT COUNT(*) AS n FROM memory_fts WHERE user_id = ?', userId)?.n || 0;
  const chunks = st.one<any>('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)),0) AS b FROM memory_chunks WHERE user_id = ?', userId);
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString();
  const stale = st
    .all<any>("SELECT * FROM memory_items WHERE user_id = ? AND status = 'active' AND pinned = 0 AND use_count = 0 AND created_at < ? ORDER BY created_at LIMIT 10", userId, cutoff)
    .map((r) => svc.view(st.decode('memory_items', r)));
  const totalBytes = (st.one<any>("SELECT COALESCE(SUM(bytes),0) AS b FROM memory_items WHERE user_id = ? AND status NOT IN ('forgotten')", userId)?.b || 0) + (ep?.b || 0) + (chunks?.b || 0);
  return {
    scopes,
    sharedByTeam,
    agents,
    dossiers,
    episodes: { items: ep?.n || 0, bytes: ep?.b || 0, quota: s.quotas.episode },
    proposals: { items: proposals, quota: s.quotas.proposals },
    trash: { items: trash, records: trashRecords, days: s.trashDays },
    blocks,
    index: { rows: index, chunks: chunks?.n || 0 },
    stale,
    totalBytes,
    settings: s,
    limits: svc.limits(),
  };
}

function purgeItem(svc: MemoryService, id: string) {
  svc.unindex('item', id);
  svc.store.exec('DELETE FROM memory_items WHERE id = ?', id);
  svc.store.exec("UPDATE memory_changes SET before = NULL, after = NULL, summary = '(verwijderd uit prullenbak)', redacted = 1, undoable = 0 WHERE record_id = ?", id);
}

/** Empty the trash now (items + dossier records + trashed dossiers), or only what is older than the retention. */
export function purgeTrash(svc: MemoryService, userId: string, all = false): number {
  const s = svc.userSettings(userId);
  const cutoff = all ? '9999' : new Date(Date.now() - s.trashDays * 864e5).toISOString();
  let n = 0;
  return svc.store.tx(() => {
    for (const r of svc.store.all<any>("SELECT id FROM memory_items WHERE user_id = ? AND status = 'trashed' AND COALESCE(trashed_at, updated_at) < ?", userId, cutoff)) (purgeItem(svc, r.id), n++);
    for (const r of svc.store.all<any>("SELECT id FROM memory_records WHERE user_id = ? AND status = 'trashed' AND COALESCE(trashed_at, updated_at) < ?", userId, cutoff)) {
      svc.unindex('record', r.id);
      svc.store.exec('DELETE FROM memory_records WHERE id = ?', r.id);
      svc.store.exec("UPDATE memory_changes SET before = NULL, after = NULL, redacted = 1, undoable = 0 WHERE record_id = ?", r.id);
      n++;
    }
    for (const d of svc.store.all<any>("SELECT id FROM memory_dossiers WHERE user_id = ? AND status = 'trashed' AND COALESCE(trashed_at, updated_at) < ?", userId, cutoff)) {
      for (const i of svc.store.all<any>('SELECT id FROM memory_items WHERE dossier_id = ?', d.id)) purgeItem(svc, i.id);
      for (const r of svc.store.all<any>('SELECT id FROM memory_records WHERE dossier_id = ?', d.id)) svc.unindex('record', r.id);
      for (const c of svc.store.all<any>('SELECT id FROM memory_chunks WHERE dossier_id = ?', d.id)) svc.unindex('chunk', c.id);
      for (const r of svc.store.all<any>('SELECT id FROM memory_sources WHERE dossier_id = ?', d.id)) svc.unindex('source', r.id);
      svc.store.exec('DELETE FROM memory_records WHERE dossier_id = ?', d.id);
      svc.store.exec('DELETE FROM memory_chunks WHERE dossier_id = ?', d.id);
      svc.store.exec('DELETE FROM memory_sources WHERE dossier_id = ?', d.id);
      svc.store.exec('DELETE FROM memory_dossier_acl WHERE dossier_id = ?', d.id);
      svc.store.exec('DELETE FROM memory_links WHERE dossier_id = ?', d.id);
      svc.unindex('dossier', d.id);
      svc.store.exec('DELETE FROM memory_dossiers WHERE id = ?', d.id);
      svc.store.exec("UPDATE memory_changes SET before = NULL, after = NULL, redacted = 1, undoable = 0 WHERE dossier_id = ?", d.id);
      n++;
    }
    if (n) svc.emit(userId, { op: 'purge' });
    return n;
  });
}

/** One reconcile pass for one user. */
export function reconcile(svc: MemoryService, userId: string): Record<string, number> {
  const st = svc.store;
  const ts = now();
  const out: Record<string, number> = { expired: 0, purged: 0, rejectedPurged: 0, orphans: 0, episodesPruned: 0, consolidations: 0 };
  const s = svc.userSettings(userId);
  st.tx(() => {
    // TTL: temporary items become archived (restorable, undoable).
    for (const r0 of st.all<any>("SELECT * FROM memory_items WHERE user_id = ? AND status = 'active' AND pinned = 0 AND expires_at IS NOT NULL AND expires_at < ?", userId, ts)) {
      const before = svc.snapshot('item', r0.id);
      svc.patchItem(r0.id, { status: 'archived', valid_to: ts });
      svc.recordChange({ userId, kind: 'item', recordId: r0.id, dossierId: r0.dossier_id, op: 'expire', before, after: svc.snapshot('item', r0.id), summary: `Verlopen: ${svc.label(before)}`, actor: 'system', undoDays: 62 });
      out.expired++;
    }
    // Rejected proposals: content kept one day for undo, then removed.
    const dayAgo = new Date(Date.now() - 864e5).toISOString();
    for (const r of st.all<any>("SELECT id FROM memory_items WHERE user_id = ? AND status = 'rejected' AND COALESCE(trashed_at, updated_at) < ?", userId, dayAgo)) {
      purgeItem(svc, r.id);
      out.rejectedPurged++;
    }
    st.exec("DELETE FROM memory_tombstones WHERE user_id = ? AND kind = 'reject' AND expires_at IS NOT NULL AND expires_at < ?", userId, ts);
    // Orphans: bot memory of a bot that no longer exists goes to the trash.
    for (const r of st.all<any>("SELECT i.id, i.dossier_id FROM memory_items i LEFT JOIN agents a ON a.id = i.agent_id WHERE i.user_id = ? AND i.scope = 'agent' AND i.status IN ('active','proposed') AND a.id IS NULL", userId)) {
      const before = svc.snapshot('item', r.id);
      svc.patchItem(r.id, { status: 'trashed', trashed_at: ts });
      svc.recordChange({ userId, kind: 'item', recordId: r.id, dossierId: r.dossier_id, op: 'trash', before, after: svc.snapshot('item', r.id), summary: `Naar prullenbak (bot bestaat niet meer): ${svc.label(before)}`, actor: 'system' });
      out.orphans++;
    }
    // Old change snapshots are trimmed after 180 days (the summary line stays).
    st.exec("UPDATE memory_changes SET before = NULL, after = NULL, undoable = 0 WHERE user_id = ? AND created_at < ? AND (before IS NOT NULL OR after IS NOT NULL) AND op != 'forget'", userId, new Date(Date.now() - 180 * 864e5).toISOString());
    st.exec('DELETE FROM memory_usage WHERE user_id = ? AND created_at < ?', userId, new Date(Date.now() - 90 * 864e5).toISOString());
    // Episodes are derived data: over quota → drop the oldest (raw conversations stay searchable).
    const epCount = st.one<any>('SELECT COUNT(*) AS n FROM memory_episodes WHERE user_id = ?', userId)?.n || 0;
    if (epCount > s.quotas.episode.items) {
      for (const e of st.all<any>('SELECT id FROM memory_episodes WHERE user_id = ? ORDER BY updated_at LIMIT ?', userId, epCount - s.quotas.episode.items)) {
        svc.unindex('episode', e.id);
        st.exec('DELETE FROM memory_episodes WHERE id = ?', e.id);
        out.episodesPruned++;
      }
    }
  });
  out.purged = purgeTrash(svc, userId);
  // Quota warnings (once per day).
  const meta = svc.meta(userId);
  const today = ts.slice(0, 10);
  if (meta.last_quota_warn_at?.slice(0, 10) !== today) {
    const rep = storageReport(svc, userId);
    // Full (nothing new is stored) and almost full (90 %) said apart: a full memory said "bijna vol" (A-46).
    const full: string[] = [];
    const near: string[] = [];
    const sort = (name: string, v: { items: number; bytes: number; quota: { items: number; bytes: number } }) => {
      if (v.items >= v.quota.items || v.bytes >= v.quota.bytes) full.push(name);
      else if (v.items >= 0.9 * v.quota.items || v.bytes >= 0.9 * v.quota.bytes) near.push(name);
    };
    if (rep.sharedByTeam.length) {
      sort('Over jou', rep.scopes.about_you);
      for (const t of rep.sharedByTeam) sort(t.teamId === ALL_TEAMS ? 'Gedeeld met alle teams' : `Gedeeld in ${t.name}`, t);
    } else for (const [k, v] of Object.entries<any>(rep.scopes)) sort(k === 'about_you' ? 'Over jou' : 'Gedeeld', v);
    for (const a of rep.agents) sort(a.name, a);
    if (full.length) {
      svc.ctx.events.emit(userId, 'notification', { title: 'Geheugen vol', body: `Vol: ${full.slice(0, 4).join(', ')}. Daar wordt niets nieuws meer onthouden tot je opruimt of samenvoegt.`, link: '#/m/memory/opslag', kind: 'memory' });
      svc.bumpMeta(userId, { last_quota_warn_at: ts });
    } else if (near.length) {
      svc.ctx.events.emit(userId, 'notification', { title: 'Geheugen bijna vol', body: `Bijna vol: ${near.slice(0, 4).join(', ')}. Ruim op of voeg samen.`, link: '#/m/memory/opslag', kind: 'memory' });
      svc.bumpMeta(userId, { last_quota_warn_at: ts });
    }
  }
  // (0.4 F2) No automatic merge proposals any more: nightly maintenance summarises and archives within the target size
  // itself (cleanup.ts), with a report and undo. Proposals nobody reviews only piled up against the proposal cap and
  // the quota. "Dubbele herinneringen zoeken" in Opslag runs that same maintenance now.
  svc.bumpMeta(userId, { last_reconcile_at: ts });
  if (out.expired || out.orphans) svc.emit(userId, { op: 'reconcile', ...out });
  return out;
}

/** One reconcile pass over every user with memory data (the module's one background look calls this, index.ts). */
export function reconcileAll(svc: MemoryService) {
  const started = Date.now();
  const users = svc.store.all<any>('SELECT DISTINCT user_id FROM memory_items UNION SELECT DISTINCT user_id FROM memory_dossiers UNION SELECT DISTINCT user_id FROM memory_tombstones').map((r) => r.user_id);
  for (const u of users) {
    if (Date.now() - started > 5_000) break; // runaway guard; the next look continues
    try {
      reconcile(svc, u);
    } catch (e) {
      svc.ctx.log.error('[memory] reconcile failed', e);
    }
  }
}
