/**
 * Hard forget ("vergeet") with propagation: the record and all its versions are purged, a tombstone blocks
 * re-learning, and derived copies are scrubbed (FTS, vectors for search by meaning, episodes + thread summaries, frozen
 * per-turn contexts, memory tool output, tool-call arguments, approval cards, audit summaries). The original chat message is the source/archive and
 * is only removed when the user asks for it (alsoSource).
 */
import type { Message } from '../../core/types.js';
import { newId, now, purgeDeleted } from '../../core/db.js';
import path from 'node:path';
import type { MemoryService } from './service.js';
import { TABLE_OF } from './service.js';
import { clean, containment, likeEscape, sentences, tokens } from './text.js';

export interface ForgetReceipt {
  id: string;
  kind: string;
  forgotten: number;
  scrubbed: { messages: number; contexts: number; approvals: number; audit: number; episodes: number; sources: number };
  tombstones: number;
  at: string;
  note: string;
}

interface Scrub {
  needles: string[];
  refs: string[];
  toks: string[][];
  sourceMessages: Set<string>;
  /** Record ids whose usage (context/tool retrievals) marks threads that may hold derived copies. */
  ids: string[];
}

/** A line that paraphrases forgotten content (most of its significant words). */
function overlaps(line: string, s: Scrub): boolean {
  if (!s.toks.length) return false;
  const lt = tokens(line);
  return lt.length >= 2 && s.toks.some((t) => t.length >= 2 && containment(t, lt) >= 0.8);
}

function deepScrub(v: any, needles: string[], key = ''): { v: any; changed: boolean } {
  if (typeof v === 'string') {
    let s = v;
    let changed = false;
    for (const n of needles) {
      if (!n || !s.includes(n)) continue;
      changed = true;
      s = s === n ? '[vergeten]' : s.split(n).join('[vergeten]');
    }
    return { v: s, changed };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const r = deepScrub(x, needles);
      changed ||= r.changed;
      return r.v;
    });
    return { v: out, changed };
  }
  if (v && typeof v === 'object') {
    // Signed reasoning blocks cannot be edited without breaking provider replay; they are not shown to people.
    if (v.type === 'thinking' || v.type === 'redacted_thinking' || key === 'signature') return { v, changed: false };
    let changed = false;
    const out: any = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'signature' || k === 'encrypted_content') {
        out[k] = x;
        continue;
      }
      const r = deepScrub(x, needles, k);
      changed ||= r.changed;
      out[k] = r.v;
    }
    return { v: out, changed };
  }
  return { v, changed: false };
}

function dropLines(text: string, s: Scrub): { text: string; changed: boolean } {
  const lines = text.split('\n');
  const kept = lines.filter((l) => !s.refs.some((r) => l.includes(`[${r}]`)) && !s.needles.some((n) => n && l.includes(n)) && !(/^\s*- \[[a-z]{1,2}:[a-z0-9]+\]/.test(l) && overlaps(l, s)));
  return { text: kept.join('\n'), changed: kept.length !== lines.length };
}

/** Remove sentences that closely paraphrase forgotten content (used for echoes in the source thread). */
function dropEchoes(text: string, s: Scrub): { text: string; removed: string[] } {
  const removed: string[] = [];
  for (const sent of sentences(text)) {
    const st = tokens(sent);
    if (st.length < 2) continue;
    if (s.toks.some((t) => t.length >= 2 && containment(t, st) >= 0.8)) removed.push(sent);
  }
  let out = text;
  for (const r of removed) out = out.split(r).join('[vergeten]');
  return { text: out, removed };
}

function needleVariants(content: string): string[] {
  const c = content.trim();
  if (c.length < 6) return [];
  const out = [c];
  if (c.length > 60) out.push(c.slice(0, 60));
  return out;
}

/** Scrub derived copies in the user's conversations, approvals and audit log. */
export function scrubDerived(svc: MemoryService, userId: string, s: Scrub, opts: { alsoSource?: boolean } = {}) {
  const ctx = svc.ctx;
  const counts = { messages: 0, contexts: 0, approvals: 0, audit: 0, episodes: 0, sources: 0 };
  const touched = new Map<string, Message>();
  const patterns = [...s.refs.map((r) => `[${r}]`), ...s.needles];
  const jsonPatterns = [...s.refs.map((r) => `[${r}]`), ...s.needles.map((n) => JSON.stringify(n).slice(1, -1))];
  const ids = new Set<string>();
  // Notes waiting for a proposed dossier (0.4 F2, memory_subjects.pending) that hold what is forgotten go too.
  for (const r of ctx.store.all<any>("SELECT id, pending FROM memory_subjects WHERE user_id = ? AND pending != '[]'", userId)) {
    let list: any[] = [];
    try {
      list = JSON.parse(r.pending || '[]');
    } catch {
      list = [];
    }
    const keep = list.filter((p) => !s.needles.some((n) => n && String(p?.text || '').toLowerCase().includes(String(n).toLowerCase())) && !svc.lineIsForgotten(userId, String(p?.text || '')));
    if (keep.length !== list.length) ctx.store.update('memory_subjects', r.id, { pending: keep });
  }
  for (let i = 0; i < patterns.length; i++) {
    const p = '%' + likeEscape(patterns[i]) + '%';
    const pj = '%' + likeEscape(jsonPatterns[i]) + '%';
    for (const r of ctx.store.all<any>(
      "SELECT m.id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.user_id = ? AND (m.content LIKE ? ESCAPE '\\' OR m.parts LIKE ? ESCAPE '\\') LIMIT 5000",
      userId,
      p,
      pj,
    ))
      ids.add(r.id);
  }
  for (const id of s.sourceMessages) ids.add(id);
  const sourceThreads = new Set<string>();
  for (const id of s.sourceMessages) {
    const m = ctx.store.message(id);
    if (m) sourceThreads.add(m.thread_id);
  }
  // Threads where the record was used (frozen contexts, memory tool output) may hold paraphrased copies.
  const usageThreads = new Set<string>();
  for (const rid of s.ids)
    for (const r of ctx.store.all<any>('SELECT DISTINCT thread_id FROM memory_usage WHERE user_id = ? AND refs LIKE ?', userId, `%"${rid}"%`)) usageThreads.add(r.thread_id);
  for (const tid of usageThreads)
    for (const r of ctx.store.all<any>("SELECT id FROM messages WHERE thread_id = ? AND role IN ('user','system','tool') AND deleted = 0 ORDER BY seq DESC LIMIT 2000", tid)) ids.add(r.id);
  // Echoes of the forgotten content by bots in the source thread(s) and where the bot learned it from memory.
  if (opts.alsoSource && s.toks.length) {
    for (const tid of new Set([...sourceThreads, ...usageThreads]))
      for (const r of ctx.store.all<any>("SELECT id FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0", tid)) ids.add(r.id);
    for (const tid of usageThreads) sourceThreads.add(tid);
  }
  for (const id of ids) {
    const m = ctx.store.message(id);
    if (!m) continue;
    const t = ctx.store.thread(m.thread_id);
    if (!t || t.user_id !== userId) continue;
    const patch: any = {};
    let parts = m.parts || {};
    if (typeof parts.context === 'string') {
      const r = dropLines(parts.context, s);
      if (r.changed) {
        parts = { ...parts, context: r.text };
        patch.parts = parts;
        counts.contexts++;
      }
    }
    if (parts.contextByAgent && typeof parts.contextByAgent === 'object') {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [aid, txt] of Object.entries(parts.contextByAgent as Record<string, string>)) {
        const r = dropLines(String(txt || ''), s);
        next[aid] = r.changed ? r.text : String(txt || '');
        if (r.changed) changed = true;
      }
      if (changed) {
        parts = { ...parts, contextByAgent: next };
        patch.parts = parts;
        counts.contexts++;
      }
    }
    if (m.role === 'tool' && m.content) {
      const r = dropLines(m.content, s);
      if (r.changed) patch.content = r.text.trim() || '(vergeten)';
    }
    if (m.role === 'assistant') {
      const dp = deepScrub({ toolCalls: parts.toolCalls, raw: parts.raw, reasoning: parts.reasoning }, s.needles);
      if (dp.changed) {
        parts = { ...parts, ...dp.v };
        patch.parts = parts;
      }
      let content = m.content || '';
      const dc = deepScrub(content, s.needles);
      if (dc.changed) content = dc.v;
      if (opts.alsoSource && sourceThreads.has(m.thread_id)) {
        const e = dropEchoes(content, s);
        if (e.removed.length) {
          content = e.text;
          const rr = deepScrub({ raw: parts.raw }, e.removed);
          if (rr.changed) {
            parts = { ...parts, raw: rr.v.raw };
            patch.parts = parts;
          }
        }
      }
      if (content !== m.content) patch.content = content;
    }
    if (opts.alsoSource && s.sourceMessages.has(m.id) && (m.role === 'user' || m.role === 'system')) {
      patch.content = '';
      patch.deleted = true;
      patch.parts = { ...parts, attachments: parts.attachments, memoryForgotten: true };
      counts.sources++;
    }
    if (Object.keys(patch).length) {
      const upd = ctx.store.updateMessage(m.id, patch);
      touched.set(upd.id, upd);
      counts.messages++;
    }
  }
  for (const m of touched.values()) {
    const t = ctx.store.thread(m.thread_id);
    if (t) ctx.chat.emitMessage(t, m, 'message.updated');
  }

  // Approval cards (input + summary) and audit summaries written by the core for memory tool calls.
  for (const n of s.needles) {
    const pj = '%' + likeEscape(JSON.stringify(n).slice(1, -1)) + '%';
    for (const a of ctx.store.all<any>("SELECT * FROM approvals WHERE user_id = ? AND (summary LIKE ? ESCAPE '\\' OR input LIKE ? ESCAPE '\\')", userId, '%' + likeEscape(n) + '%', pj)) {
      const row = ctx.store.decode<any>('approvals', a);
      const input = deepScrub(row.input, s.needles).v;
      const summary = s.needles.some((x) => row.summary.includes(x)) ? '[vergeten]' : row.summary;
      ctx.store.update('approvals', row.id, { input, summary });
      counts.approvals++;
    }
    for (const a of ctx.store.all<any>("SELECT id, data FROM audit WHERE user_id = ? AND data LIKE ? ESCAPE '\\'", userId, pj)) {
      let data: any = {};
      try {
        data = JSON.parse(a.data);
      } catch {
        /* ignore */
      }
      const r = deepScrub(data, s.needles);
      if (data && typeof data.summary === 'string' && s.needles.some((x) => data.summary.includes(x))) r.v.summary = '[vergeten]';
      ctx.store.exec('UPDATE audit SET data = ? WHERE id = ?', JSON.stringify(r.v), a.id);
      counts.audit++;
    }
  }

  // Episodes (+ thread summaries used for compaction).
  for (const e0 of ctx.store.all<any>('SELECT * FROM memory_episodes WHERE user_id = ?', userId)) {
    const e = ctx.store.decode<any>('memory_episodes', e0);
    const hit = (txt: string) => s.refs.some((r) => txt.includes(`[${r}]`)) || s.needles.some((n) => n && txt.includes(n)) || s.toks.some((t) => t.length >= 2 && containment(t, tokens(txt)) >= 0.8);
    const filt = (list: any[]) => (list || []).filter((x) => !hit(String(x?.text || '')));
    const decisions = filt(e.decisions);
    const actions = filt(e.actions);
    const questions = filt(e.questions);
    const sum = sentences(e.summary || "").filter((x) => !hit(x)).join(" ");
    const title = e.title && hit(e.title) ? "" : e.title;
    if (title !== e.title || decisions.length !== (e.decisions || []).length || actions.length !== (e.actions || []).length || questions.length !== (e.questions || []).length || sum !== (e.summary || '').replace(/\s+/g, ' ').trim()) {
      ctx.store.update('memory_episodes', e.id, { title, decisions, actions, questions, summary: sum, version: (e.version || 1) + 1, updated_at: now() });
      svc.syncIndex('episode', e.id);
      syncThreadSummary(svc, e.thread_id);
      counts.episodes++;
    }
  }

  // Maintenance reports quote item labels: lines about forgotten records lose their text (and their undo).
  for (const r0 of ctx.store.all<any>('SELECT id, lines FROM memory_reports WHERE user_id = ?', userId)) {
    let lines: any[] = [];
    try {
      lines = JSON.parse(r0.lines || '[]');
    } catch {
      continue;
    }
    let changed = false;
    const hit = (l: any) => (l.refs || []).some((r: string) => s.refs.includes(r)) || s.needles.some((n) => n && String(l.text || '').includes(n)) || s.toks.some((t) => t.length >= 2 && containment(t, tokens(String(l.text || ''))) >= 0.8);
    for (const l of lines) {
      if (!hit(l)) continue;
      l.text = '(vergeten)';
      l.refs = [];
      l.changeIds = [];
      l.undone = true;
      changed = true;
    }
    if (changed) ctx.store.exec('UPDATE memory_reports SET lines = ? WHERE id = ?', JSON.stringify(lines), r0.id);
  }

  // What-the-bot-used records.
  for (const u of ctx.store.all<any>('SELECT id, refs FROM memory_usage WHERE user_id = ?', userId)) {
    let refs: any[] = [];
    try {
      refs = JSON.parse(u.refs || '[]');
    } catch {
      /* ignore */
    }
    const next = refs.filter((r) => !s.refs.includes(`${r.p}:${r.ref}`));
    if (next.length !== refs.length) ctx.store.exec('UPDATE memory_usage SET refs = ? WHERE id = ?', JSON.stringify(next), u.id);
  }
  return counts;
}

/** Mirror an episode into thread.meta.summary (used by the core when old history is truncated). */
export function syncThreadSummary(svc: MemoryService, threadId: string) {
  const ctx = svc.ctx;
  const t = ctx.store.thread(threadId);
  if (!t) return;
  if (t.meta?.summary && t.meta?.summary_by !== 'memory') return;
  const e = ctx.store.one<any>('SELECT * FROM memory_episodes WHERE thread_id = ?', threadId);
  const ep = e ? ctx.store.decode<any>('memory_episodes', e) : null;
  const text = ep ? renderEpisode(ep) : '';
  const meta = { ...(t.meta || {}) };
  if (text) {
    meta.summary = text;
    meta.summary_by = 'memory';
  } else {
    delete meta.summary;
    delete meta.summary_by;
  }
  ctx.store.update('threads', threadId, { meta });
}

export function renderEpisode(ep: any): string {
  const lines: string[] = [];
  if (ep.summary) lines.push(ep.summary);
  if (ep.decisions?.length) lines.push('Besluiten: ' + ep.decisions.map((d: any) => d.text).join(' · '));
  if (ep.actions?.length) lines.push('Acties: ' + ep.actions.map((d: any) => d.text).join(' · '));
  if (ep.questions?.length) lines.push('Open vragen: ' + ep.questions.map((d: any) => d.text).join(' · '));
  return lines.join('\n').slice(0, 3000);
}

function chainOf(svc: MemoryService, userId: string, startId: string): string[] {
  const seen = new Set<string>();
  const todo = [startId];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    const r = svc.itemRow(id);
    if (!r || (r.user_id !== userId && !svc.dossierRole(userId, r.dossier_id))) continue;
    seen.add(id);
    if (r.supersedes_id) todo.push(r.supersedes_id);
    if (r.superseded_by) todo.push(r.superseded_by);
    for (const o of r.merge_of || []) todo.push(o);
    // Versions (supersede chain) and consolidated copies carry the same fact; conflicting proposals do not.
    for (const x of svc.store.all<any>('SELECT id FROM memory_items WHERE supersedes_id = ? OR (merge_of IS NOT NULL AND merge_of LIKE ?)', id, `%"${id}"%`)) todo.push(x.id);
  }
  return [...seen];
}

/**
 * Forgetting is global (teams 0.4 B): the same fact elsewhere goes too — an identical item in another team, bot or
 * "Over jou" (same content fingerprint), and every copy made with "vakkennis meenemen" (copy_of, both ways).
 */
function itemCopies(svc: MemoryService, owner: string, ids: string[]): string[] {
  const out = new Set(ids);
  const hashes = new Set<string>();
  const families = new Set<string>();
  for (const id of ids) {
    const r = svc.store.one<any>('SELECT hash, copy_of FROM memory_items WHERE id = ?', id);
    if (r?.hash) hashes.add(r.hash);
    families.add(r?.copy_of || id);
  }
  for (const h of hashes) for (const r of svc.store.all<any>("SELECT id FROM memory_items WHERE user_id = ? AND hash = ? AND status != 'forgotten'", owner, h)) out.add(r.id);
  for (const f of families) for (const r of svc.store.all<any>("SELECT id FROM memory_items WHERE (id = ? OR copy_of = ?) AND user_id = ? AND status != 'forgotten'", f, f, owner)) out.add(r.id);
  return [...out];
}

/** A record, source or dossier and its copies (copy_of, both ways) of the same owner. */
function family(svc: MemoryService, table: string, owner: string, row: any): any[] {
  const root = row.copy_of || row.id;
  return svc.store.all<any>(`SELECT * FROM ${table} WHERE (id = ? OR copy_of = ?) AND user_id = ? AND status != 'forgotten'`, root, root, owner).map((r) => svc.store.decode(table, r));
}

function redactChanges(svc: MemoryService, ids: string[]) {
  for (const id of ids) svc.store.exec("UPDATE memory_changes SET before = NULL, after = NULL, summary = '(vergeten)', reason = '', redacted = 1, undoable = 0 WHERE record_id = ?", id);
}

/**
 * Forget a memory item, dossier record, source, episode or whole dossier. Returns a deletion receipt.
 * The caller is responsible for authorisation/confirmation.
 */
/**
 * Make forgotten/deleted text physically gone: merge the search indexes (old segments keep a deleted document's words)
 * and empty the WAL (it keeps old page versions). secure_delete (see openDb) already zeroes the freed bytes.
 */
export function purgeForgotten(svc: MemoryService, o: { messages?: boolean; vacuum?: boolean } = {}) {
  const ctx = svc.ctx;
  return purgeDeleted(ctx.db, { fts: ['memory_fts', ...(o.messages ? ['messages_fts'] : [])], vacuum: o.vacuum, file: path.join(ctx.config.dataDir, 'teambot.db') });
}

export function forgetRecord(
  svc: MemoryService,
  userId: string,
  input: string,
  o: {
    actor: 'user' | 'agent' | 'system';
    actorId: string;
    alsoSource?: boolean;
    label?: string;
    reason?: string;
    purge?: boolean;
    /**
     * Also forget every copy of it: the same fact in another team, bot or "Over jou", and copies made with "vakkennis
     * meenemen" (default). Only a bot forgetting its own note on its own initiative sets false.
     */
    everywhere?: boolean;
  },
): ForgetReceipt {
  const everywhere = o.everywhere !== false;
  const ctx = svc.ctx;
  const found = svc.resolve(userId, input);
  if (!found) throw new Error('Niet gevonden');
  const { kind, row } = found;
  const owner = row.user_id;
  if (owner !== userId) {
    const dId = kind === 'dossier' ? row.id : row.dossier_id;
    if (svc.dossierRole(userId, dId) !== 'edit') throw new Error('Alleen de eigenaar (of iemand met bewerkrechten) kan dit vergeten');
    if (kind === 'dossier') throw new Error('Alleen de eigenaar kan een heel dossier vergeten');
  }
  const s: Scrub = { needles: [], refs: [], toks: [], sourceMessages: new Set(), ids: [] };
  let forgotten = 0;
  let tombs = 0;
  const label = o.label || '';

  const forgetItems = (ids: string[]) => {
    for (const id of ids) {
      const r = svc.itemRow(id);
      if (!r || r.status === 'forgotten') continue;
      const content = svc.contentOf(r);
      s.needles.push(...needleVariants(content));
      s.toks.push(tokens(content));
      s.refs.push(`m:${r.ref}`);
      s.ids.push(r.id);
      if (r.source_kind === 'message' && r.source_ref) s.sourceMessages.add(r.source_ref);
      if (content) {
        svc.tombstone({ userId: owner, kind: 'forget', recordKind: 'item', recordId: r.id, scope: r.scope, label: label || `${typeLabel(r.type)} (${scopeLabel(r.scope)}) vergeten op ${new Date().toLocaleDateString('nl-NL')}`, content, key: r.canonical_key });
        tombs++;
      }
      ctx.store.exec(
        "UPDATE memory_items SET content = '', content_enc = NULL, canonical_key = NULL, key_norm = NULL, source_excerpt = NULL, hash = '', status = 'forgotten', pinned = 0, flags = '[]', merge_of = NULL, bytes = 0, conflict_with = NULL, terms = NULL, review_note = NULL, updated_at = ? WHERE id = ?",
        now(),
        r.id,
      );
      svc.unindex('item', r.id);
      redactChanges(svc, [r.id]);
      forgotten++;
    }
  };
  const forgetRecords = (rows: any[]) => {
    for (const r of rows) {
      if (r.status === 'forgotten') continue;
      const text = [r.title, r.body, r.data?.question].filter(Boolean).join(' ');
      for (const t of [r.title, r.body, r.data?.question]) if (t) s.needles.push(...needleVariants(String(t)));
      s.toks.push(tokens(text));
      s.refs.push(svc.refOf(r.kind, r.ref));
      s.ids.push(r.id);
      if (text) {
        svc.tombstone({ userId: r.user_id, kind: 'forget', recordKind: r.kind, recordId: r.id, scope: 'dossier', label: label || `${recordLabel(r.kind)} vergeten op ${new Date().toLocaleDateString('nl-NL')}`, content: text });
        tombs++;
      }
      ctx.store.exec("UPDATE memory_records SET title = '', body = '', owner = NULL, data = '{}', sources = '[]', hash = '', status = 'forgotten', updated_at = ? WHERE id = ?", now(), r.id);
      svc.unindex('record', r.id);
      redactChanges(svc, [r.id]);
      forgotten++;
    }
  };
  const forgetSources = (rows: any[]) => {
    for (const r of rows) {
      if (r.status === 'forgotten') continue;
      if (r.excerpt) s.needles.push(...needleVariants(r.excerpt));
      s.refs.push(`s:${r.ref}`);
      s.ids.push(r.id);
      for (const c of ctx.store.all<any>('SELECT id FROM memory_chunks WHERE source_id = ?', r.id)) svc.unindex('chunk', c.id);
      ctx.store.exec('DELETE FROM memory_chunks WHERE source_id = ?', r.id);
      ctx.store.exec("UPDATE memory_sources SET title = '', target = '', excerpt = '', hash = '', chunks = 0, status = 'forgotten', updated_at = ? WHERE id = ?", now(), r.id);
      svc.unindex('source', r.id);
      redactChanges(svc, [r.id]);
      forgotten++;
    }
  };

  /** A whole dossier: its notes, records, sources (with their document parts) and the dossier itself. */
  const forgetDossier = (d: any) => {
    if (d.status === 'forgotten') return;
    forgetItems(ctx.store.all<any>('SELECT id FROM memory_items WHERE dossier_id = ?', d.id).map((r) => r.id));
    forgetRecords(ctx.store.all<any>('SELECT * FROM memory_records WHERE dossier_id = ?', d.id).map((r) => ctx.store.decode('memory_records', r)));
    forgetSources(ctx.store.all<any>('SELECT * FROM memory_sources WHERE dossier_id = ?', d.id));
    if (d.title) s.needles.push(...needleVariants(d.title));
    if (d.summary) s.needles.push(...needleVariants(d.summary));
    s.refs.push(`d:${d.ref}`);
    ctx.store.exec("UPDATE memory_dossiers SET title = '(vergeten dossier)', summary = '', tags = '[]', agent_ids = NULL, status = 'forgotten', updated_at = ? WHERE id = ?", now(), d.id);
    ctx.store.exec('DELETE FROM memory_dossier_acl WHERE dossier_id = ?', d.id);
    ctx.store.exec('DELETE FROM memory_links WHERE dossier_id = ?', d.id);
    svc.unindex('dossier', d.id);
    redactChanges(svc, [d.id]);
    forgotten++;
  };
  /** The item, its versions and (everywhere) every copy of the same fact with their versions. */
  const itemsToForget = (id: string) => {
    const ids = new Set(chainOf(svc, userId, id));
    if (everywhere) for (const c of itemCopies(svc, owner, [...ids])) for (const x of chainOf(svc, userId, c)) ids.add(x);
    return [...ids];
  };

  const receipt = ctx.store.tx(() => {
    if (kind === 'item') forgetItems(itemsToForget(row.id));
    else if (TABLE_OF[kind] === 'memory_records') {
      const rec = ctx.store.decode<any>('memory_records', ctx.store.get('memory_records', row.id));
      forgetRecords(everywhere ? family(svc, 'memory_records', owner, rec) : [rec]);
    } else if (kind === 'source') forgetSources(everywhere ? family(svc, 'memory_sources', owner, row) : [row]);
    else if (kind === 'episode') {
      for (const x of [...(row.decisions || []), ...(row.actions || []), ...(row.questions || [])]) if (x?.text) s.needles.push(...needleVariants(x.text));
      if (row.summary) for (const sent of sentences(row.summary)) s.needles.push(...needleVariants(sent));
      ctx.store.update('memory_episodes', row.id, { summary: '', decisions: [], actions: [], questions: [], source_ids: [], method: 'forgotten', version: (row.version || 1) + 1, updated_at: now() });
      svc.unindex('episode', row.id);
      syncThreadSummary(svc, row.thread_id);
      forgotten++;
    } else if (kind === 'dossier') {
      for (const d of everywhere ? family(svc, 'memory_dossiers', owner, row) : [row]) forgetDossier(d);
    }
    s.needles = [...new Set(s.needles.filter((n) => n.length >= 6))].sort((a, b) => b.length - a.length);
    const scrubbed = scrubDerived(svc, owner, s, { alsoSource: o.alsoSource });
    const id = newId('mch_');
    ctx.store.insert('memory_changes', {
      id,
      user_id: owner,
      record_kind: kind,
      record_id: row.id,
      dossier_id: kind === 'dossier' ? row.id : row.dossier_id ?? null,
      op: 'forget',
      before: null,
      after: { forgotten, scrubbed, tombstones: tombs },
      summary: [forgotten === 1 ? 'Vergeten: 1 record' : `Vergeten: ${forgotten} records`, scrubbed.messages === 1 ? '1 bericht opgeschoond' : scrubbed.messages ? `${scrubbed.messages} berichten opgeschoond` : ''].filter(Boolean).join(', '),
      reason: clean(o.reason || '', 200),
      actor: o.actor,
      actor_id: o.actorId,
      undoable: false,
      redacted: true,
      created_at: now(),
    });
    return {
      id,
      kind,
      forgotten,
      scrubbed,
      tombstones: tombs,
      at: now(),
      note:
        'Vergeten is definitief: inhoud, versies en index zijn gewist en opnieuw opslaan wordt geblokkeerd. ' +
        (o.alsoSource ? 'Het bronbericht is ook uit het gesprek verwijderd. ' : 'Het oorspronkelijke chatbericht staat nog in het gesprek (verwijder het daar of kies "ook bronbericht"). ') +
        'Back-ups van TeamBot zelf bevatten geen geheugen dat na deze bon is aangemaakt; oudere back-ups verlopen volgens je back-upbeleid en de blokkade blijft gelden bij terugzetten.',
    } as ForgetReceipt;
  });
  svc.emit(owner, { op: 'forget', ids: [row.id], kind, dossierId: kind === 'dossier' ? row.id : row.dossier_id ?? null });
  ctx.audit(owner, 'memory.forgotten', { kind, receipt: receipt.id, count: receipt.forgotten, alsoSource: !!o.alsoSource, by: o.actor }, o.actor === 'agent' ? o.actorId : null);
  // Scrubbed chat messages also left words in the message search index.
  if (o.purge !== false) purgeForgotten(svc, { messages: receipt.scrubbed.messages > 0 });
  return receipt;
}

export function typeLabel(t: string) {
  return ({ fact: 'Feit', preference: 'Voorkeur', instruction: 'Instructie', decision: 'Besluit', person: 'Persoon', event: 'Gebeurtenis', task: 'Taak', lesson: 'Les', note: 'Notitie' } as any)[t] || 'Item';
}
export function scopeLabel(s: string) {
  return ({ about_you: 'Over jou', agent: 'Bot', dossier: 'Dossier', shared: 'Gedeeld' } as any)[s] || s;
}
export function recordLabel(k: string) {
  return ({ event: 'Gebeurtenis', decision: 'Besluit', action: 'Actiepunt', entity: 'Persoon/organisatie', source: 'Bron' } as any)[k] || 'Record';
}

/** Delete everything the memory module holds for a user (account cleanup / "alles wissen"). */
export function deleteAllForUser(svc: MemoryService, userId: string, o: { keepBlocks?: boolean } = {}) {
  const counts = deleteAllRows(svc, userId, o);
  // Outside the transaction: merge the index, rebuild the file (when not huge) and empty the WAL.
  purgeForgotten(svc, { messages: true, vacuum: true });
  return counts;
}

function deleteAllRows(svc: MemoryService, userId: string, o: { keepBlocks?: boolean }) {
  const ctx = svc.ctx;
  return ctx.store.tx(() => {
    const counts: Record<string, number> = {};
    const del = (table: string, where = 'user_id = ?', ...p: any[]) => {
      const r = ctx.store.exec(`DELETE FROM ${table} WHERE ${where}`, ...(p.length ? p : [userId]));
      counts[table] = Number(r.changes || 0);
    };
    const dossiers = ctx.store.all<any>('SELECT id FROM memory_dossiers WHERE user_id = ?', userId).map((d) => d.id);
    for (const d of dossiers) ctx.store.exec('DELETE FROM memory_dossier_acl WHERE dossier_id = ?', d);
    del('memory_dossier_acl', 'user_id = ?');
    del('memory_subjects');
    del('memory_items');
    del('memory_changes');
    del('memory_records');
    del('memory_chunks');
    del('memory_sources');
    del('memory_dossiers');
    del('memory_episodes');
    del('memory_usage');
    del('memory_msg_flags');
    del('memory_links');
    del('memory_meta');
    del('memory_learn');
    del('memory_reports');
    del('memory_rollups');
    if (!o.keepBlocks) del('memory_tombstones');
    else ctx.store.exec("DELETE FROM memory_tombstones WHERE user_id = ? AND kind = 'reject'", userId);
    svc.ftsClear(userId);
    svc.semantic.dropUser(userId);
    // Remove frozen memory blocks from the user's conversations and memory-written thread summaries.
    for (const m of ctx.store.all<any>("SELECT m.id, m.parts FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.user_id = ? AND m.parts LIKE '%<geheugen%'", userId)) {
      const msg = ctx.store.message(m.id);
      if (!msg?.parts) continue;
      const strip = (x: any) => String(x || '').replace(/<geheugen[\s\S]*?<\/geheugen>\n?/g, '').trim();
      const next: any = { ...msg.parts };
      if (msg.parts.context) next.context = strip(msg.parts.context);
      if (msg.parts.contextByAgent) next.contextByAgent = Object.fromEntries(Object.entries(msg.parts.contextByAgent).map(([k, v]) => [k, strip(v)]));
      ctx.store.updateMessage(msg.id, { parts: next });
    }
    for (const t of ctx.store.all<any>("SELECT id FROM threads WHERE user_id = ? AND meta LIKE '%\"summary_by\":\"memory\"%'", userId)) {
      const th = ctx.store.thread(t.id)!;
      const meta = { ...th.meta };
      delete meta.summary;
      delete meta.summary_by;
      ctx.store.update('threads', t.id, { meta });
    }
    ctx.audit(userId, 'memory.deleted_all', { counts, keepBlocks: !!o.keepBlocks });
    svc.emit(userId, { op: 'delete_all' });
    return counts;
  });
}
