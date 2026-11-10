/**
 * Memory per team (0.4 B, wave 2): filing what existed before teams under the default team, and copying a team's
 * "vakkennis" (dossiers and shared knowledge — never "Over jou", bot notes, conversation summaries or anything
 * personal or sensitive) to another team. Reading and writing walls live in service.ts (Reader, aclSql,
 * readableDossiers, bucketWhere); see docs/modules/memory.md "Geheugen per team".
 */
import { newId, now } from '../../core/db.js';
import type { MemoryService } from './service.js';
import type { MemoryItemRow } from './types.js';
import { normalize } from './text.js';

let filing = false;

/**
 * Everything without a team is filed under a real team, so it never moves when the owner reorders his teams: a bot's
 * notes and conversation summaries under the bot's home team, shared knowledge and dossiers under the default team
 * ("Mijn team"). Right after the update from 0.3 every bot is in "Mijn team", so every bot sees exactly what it saw
 * before; nothing becomes visible to a bot that could not see it. Runs at start and whenever the teams change (the
 * first team appears, …); cheap when there is nothing to file. Returns the number of rows filed.
 */
export function fileUnderTeams(svc: MemoryService, userId?: string): number {
  if (filing) return 0;
  filing = true;
  try {
    const users = userId
      ? [userId]
      : svc.store
          .all<any>("SELECT DISTINCT user_id FROM memory_items WHERE team_id IS NULL AND scope IN ('agent','shared') UNION SELECT DISTINCT user_id FROM memory_dossiers WHERE team_id IS NULL UNION SELECT DISTINCT user_id FROM memory_episodes WHERE team_id IS NULL")
          .map((r) => r.user_id);
    let n = 0;
    for (const u of users) {
      const info = svc.teamInfo(u);
      if (!info) continue;
      const changed = (r: any) => Number(r?.changes || 0);
      svc.store.tx(() => {
        // A bot's own notes: its home team (a bot that no longer exists: the default team).
        for (const r of svc.store.all<any>("SELECT DISTINCT agent_id FROM memory_items WHERE user_id = ? AND scope = 'agent' AND team_id IS NULL", u)) {
          const bot = r.agent_id ? svc.store.agent(r.agent_id) : null;
          const team = (bot && bot.user_id === u && svc.homeTeam(bot)) || info.def;
          n += changed(svc.store.exec("UPDATE memory_items SET team_id = ? WHERE user_id = ? AND scope = 'agent' AND team_id IS NULL AND agent_id IS ?", team, u, r.agent_id));
        }
        n += changed(svc.store.exec("UPDATE memory_items SET team_id = ? WHERE user_id = ? AND scope = 'shared' AND team_id IS NULL", info.def, u));
        n += changed(svc.store.exec('UPDATE memory_dossiers SET team_id = ? WHERE user_id = ? AND team_id IS NULL', info.def, u));
        // A conversation summary: the team of the conversation's bot.
        for (const e of svc.store.all<any>('SELECT e.id, e.agent_ids, t.agent_id FROM memory_episodes e LEFT JOIN threads t ON t.id = e.thread_id WHERE e.user_id = ? AND e.team_id IS NULL', u)) {
          let first: string | null = e.agent_id || null;
          if (!first) {
            try {
              first = (JSON.parse(e.agent_ids || '[]') as string[])[0] || null;
            } catch {
              first = null;
            }
          }
          const bot = first ? svc.store.agent(first) : null;
          const team = (bot && bot.user_id === u && svc.homeTeam(bot)) || info.def;
          n += changed(svc.store.exec('UPDATE memory_episodes SET team_id = ? WHERE id = ?', team, e.id));
        }
      });
    }
    return n;
  } finally {
    filing = false;
  }
}

export interface KnowledgeCopy {
  dossiers: number;
  records: number;
  sources: number;
  /** Shared knowledge and dossier notes. */
  items: number;
  skipped: { existing: number; quota: number; personal: number };
  message: string;
}

/**
 * "Vakkennis meenemen": copy a team's dossiers (with their records, sources, document parts and notes) and its shared
 * knowledge to another team of the same owner. Never personal memory ("Over jou"), a bot's own notes, conversation
 * summaries, items marked personal or sensitive, or knowledge "voor alle teams" (every team has that already); keys
 * and logins are never in memory at all. A copy is a new record linked to its original (copy_of): forgetting either
 * one forgets both. Dedup within the target team (same dossier title, same fact) and the target team's quota apply.
 * `agentMap` (old bot id → new bot id, when a team is duplicated with its bots) keeps a dossier's bot list; without
 * it a copied dossier is open to every bot of the target team.
 */
export function copyTeamKnowledge(svc: MemoryService, userId: string, fromTeamId: string, toTeamId: string, o: { agentMap?: Record<string, string> | null; actorId?: string } = {}): KnowledgeCopy {
  const info = svc.teamInfo(userId);
  if (!info || !info.ids.has(fromTeamId) || !info.ids.has(toTeamId)) throw new Error('Team niet gevonden');
  if (fromTeamId === toTeamId) throw new Error('Kies twee verschillende teams.');
  const st = svc.store;
  const fromName = info.names.get(fromTeamId) || '';
  const out: KnowledgeCopy = { dossiers: 0, records: 0, sources: 0, items: 0, skipped: { existing: 0, quota: 0, personal: 0 }, message: '' };
  const actorId = o.actorId || userId;
  const mapAgents = (ids: any): string[] | null => {
    if (!Array.isArray(ids) || !o.agentMap) return null;
    const mapped = ids.map((id: string) => o.agentMap![id]).filter((id: any) => typeof id === 'string' && st.agent(id)?.user_id === userId);
    return mapped.length ? mapped : null;
  };
  /** A copy of an item (fresh id, ref, index and vector; same content and source). */
  const copyItem = (r: MemoryItemRow, patch: Partial<MemoryItemRow>) =>
    svc.insertItem({
      user_id: userId,
      scope: r.scope,
      agent_id: null,
      dossier_id: r.dossier_id,
      team_id: null,
      type: r.type,
      canonical_key: r.canonical_key,
      content: svc.contentOf(r),
      source_kind: r.source_kind,
      source_ref: r.source_ref,
      source_thread_id: null,
      source_excerpt: r.source_excerpt,
      source_trust: r.source_trust,
      confidence: r.confidence,
      sensitivity: r.sensitivity,
      status: 'active',
      flags: r.flags || [],
      pinned: r.pinned,
      observed_at: r.observed_at,
      valid_from: now(),
      expires_at: r.expires_at,
      review_every_days: r.review_every_days,
      review_at: r.review_at,
      created_by: 'user',
      created_by_agent: null,
      copy_of: r.copy_of || r.id,
      ...patch,
    } as any);

  st.tx(() => {
    const batch = newId('mbt_');
    const change = (kind: string, recordId: string, dossierId: string | null, summary: string) =>
      svc.recordChange({ userId, kind, recordId, dossierId, op: 'create', before: null, after: svc.snapshot(kind, recordId), summary, reason: 'Vakkennis gekopieerd', actor: 'user', actorId, batchId: batch });

    // 1. Dossiers of the team, with everything in them.
    const fromEq = svc.teamEq('team_id', userId, fromTeamId);
    const toEq = svc.teamEq('team_id', userId, toTeamId);
    const titles = new Set(st.all<any>(`SELECT title FROM memory_dossiers WHERE user_id = ? AND status IN ('active','closed') AND ${toEq.sql}`, userId, ...toEq.params).map((d) => normalize(d.title)));
    let count = st.one<any>("SELECT COUNT(*) AS n FROM memory_dossiers WHERE user_id = ? AND status NOT IN ('trashed','forgotten')", userId)?.n || 0;
    for (const d0 of st.all<any>(`SELECT * FROM memory_dossiers WHERE user_id = ? AND status IN ('active','closed') AND ${fromEq.sql} ORDER BY created_at`, userId, ...fromEq.params)) {
      const d = st.decode<any>('memory_dossiers', d0);
      if (titles.has(normalize(d.title))) {
        out.skipped.existing++;
        continue;
      }
      if (count >= 500) {
        out.skipped.quota++;
        continue;
      }
      count++;
      titles.add(normalize(d.title));
      const ts = now();
      const nd = {
        id: newId('dos_'),
        ref: svc.newRef('memory_dossiers', userId),
        user_id: userId,
        title: d.title,
        kind: d.kind,
        summary: d.summary,
        status: d.status,
        agent_ids: mapAgents(d.agent_ids),
        retention_days: d.retention_days ?? null,
        tags: d.tags || [],
        pinned: !!d.pinned,
        created_by: 'user',
        created_by_agent: null,
        version: 1,
        team_id: toTeamId,
        copy_of: d.copy_of || d.id,
        created_at: ts,
        updated_at: ts,
      };
      st.insert('memory_dossiers', nd);
      svc.syncIndex('dossier', nd.id);
      change('dossier', nd.id, nd.id, `Dossier gekopieerd uit team “${fromName}”: “${d.title}”`);
      out.dossiers++;
      // Records: the current ones (no proposals, no replaced versions, nothing in the trash or forgotten).
      for (const r0 of st.all<any>("SELECT * FROM memory_records WHERE dossier_id = ? AND status NOT IN ('trashed','forgotten','proposed','superseded') ORDER BY created_at", d.id)) {
        const r = st.decode<any>('memory_records', r0);
        const data = { ...(r.data || {}) };
        delete data.conflict_with;
        const id = newId('rec_');
        st.insert('memory_records', {
          ...r,
          id,
          ref: svc.newRef('memory_records', userId),
          dossier_id: nd.id,
          data,
          supersedes_id: null,
          superseded_by: null,
          origin_call_id: null,
          version: 1,
          copy_of: r.copy_of || r.id,
          updated_at: ts,
        });
        svc.syncIndex(r.kind, id);
        out.records++;
      }
      // Sources with their document parts (searchable by words and meaning in the new team too).
      for (const s0 of st.all<any>("SELECT * FROM memory_sources WHERE dossier_id = ? AND status = 'active' ORDER BY created_at", d.id)) {
        const sid = newId('src_');
        st.insert('memory_sources', { ...s0, id: sid, ref: svc.newRef('memory_sources', userId), dossier_id: nd.id, thread_id: null, copy_of: s0.copy_of || s0.id, created_at: ts, updated_at: ts });
        for (const c of st.all<any>('SELECT * FROM memory_chunks WHERE source_id = ? ORDER BY seq', s0.id)) {
          const cid = newId('chk_');
          st.insert('memory_chunks', { id: cid, user_id: userId, source_id: sid, dossier_id: nd.id, seq: c.seq, text: c.text, created_at: ts });
          svc.indexChunk(cid, userId, c.text);
        }
        svc.syncIndex('source', sid);
        out.sources++;
      }
      // Notes in the dossier: the plain ones only (personal and sensitive notes stay where they are).
      for (const i0 of st.all<any>("SELECT * FROM memory_items WHERE dossier_id = ? AND scope = 'dossier' AND status = 'active'", d.id)) {
        const r = st.decode<MemoryItemRow>('memory_items', i0);
        if (r.sensitivity !== 'normal') {
          out.skipped.personal++;
          continue;
        }
        copyItem(r, { dossier_id: nd.id });
        out.items++;
      }
    }

    // 2. Shared knowledge of the team (not "voor alle teams": every team has that already).
    for (const i0 of st.all<any>(`SELECT * FROM memory_items WHERE user_id = ? AND scope = 'shared' AND status = 'active' AND ${fromEq.sql} ORDER BY created_at`, userId, ...fromEq.params)) {
      const r = st.decode<MemoryItemRow>('memory_items', i0);
      if (r.sensitivity !== 'normal') {
        out.skipped.personal++;
        continue;
      }
      const bucket = { scope: 'shared' as const, team_id: toTeamId };
      const content = svc.contentOf(r);
      if (svc.exactDuplicate(userId, bucket, r.hash) || svc.blockedBy(userId, content, r.canonical_key, ['forget'])) {
        out.skipped.existing++;
        continue;
      }
      if (svc.quotaProblem({ user_id: userId, ...bucket }, Buffer.byteLength(content), false)) {
        out.skipped.quota++;
        continue;
      }
      const row = copyItem(r, { scope: 'shared', dossier_id: null, team_id: toTeamId });
      change('item', row.id, null, `Gekopieerd uit team “${fromName}”: ${svc.label(row)}`);
      out.items++;
    }
  });
  const toName = info.names.get(toTeamId) || '';
  const lines = [
    `Gekopieerd naar team “${toName}”: ${out.dossiers === 1 ? '1 dossier' : `${out.dossiers} dossiers`}, ${out.items === 1 ? '1 herinnering' : `${out.items} herinneringen`}.`,
    out.skipped.existing === 1 ? '1 onderdeel stond er al.' : out.skipped.existing ? `${out.skipped.existing} onderdelen stonden er al.` : '',
    out.skipped.quota === 1 ? '1 onderdeel paste niet meer (geheugen vol).' : out.skipped.quota ? `${out.skipped.quota} onderdelen pasten niet meer (geheugen vol).` : '',
  ];
  out.message = lines.filter(Boolean).join(' ');
  if (out.dossiers || out.items) svc.emit(userId, { op: 'copy', kind: 'team', ids: [] });
  svc.ctx.audit(userId, 'memory.team_knowledge_copied', { from: fromTeamId, to: toTeamId, dossiers: out.dossiers, records: out.records, sources: out.sources, items: out.items, skipped: out.skipped });
  svc.semantic.kick();
  return out;
}
