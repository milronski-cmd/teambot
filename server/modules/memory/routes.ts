/** REST API of the memory module (/api/memory/...). Every route only returns data of the logged-in user. */
import { retireItem } from './retire.js';
import type { Ctx } from '../../core/types.js';
import { ah, bad, HttpError, notFound, requireRole, str, user } from '../../core/http.js';
import { now } from '../../core/db.js';
import type { MemoryService } from './service.js';
import type { MemoryItemRow, Scope } from './types.js';
import { ALL_TEAMS, ITEM_TYPES, SCOPES, SENSITIVITIES, nextReview, reviewInterval } from './types.js';
import { copyTeamKnowledge } from './teams.js';
import { approveProposal, rejectProposal, writeCandidate } from './pipeline.js';
import { deleteAllForUser, forgetRecord, purgeForgotten, recordLabel } from './forget.js';
import { addRecord, addSourceAsync, createDossier, dossierMarkdown, getDossier, listDossiers, shareDossier, updateDossier, updateRecord } from './dossiers.js';
import { importMarkdownDossiers } from './md-import.js';
import { purgeTrash, reconcile, storageReport } from './lifecycle.js';
import { exportJson, exportMarkdown, importText } from './io.js';
import { episodeFor, rebuildEpisode } from './episodes.js';
import { linkedDossier } from './context.js';
import { impliedSources } from './implied.js';
import { estimateTokens } from '../../core/tokens.js';
import { clean, detectSecret, excerpt } from './text.js';
import { type Learner, PROFILE_GROUPS, profileGroup } from './learn.js';
import { type MaintenanceReport, reportView, summaryText, undoReport } from './maintenance.js';
import { engineBackoff, engineOptions, pickEngine } from './engine.js';
import { EMBED_PREFERENCE, SUGGESTED_MODEL } from './semantic.js';
import { BUILTIN } from './builtin-embed.js';
import { cleanupText, sizes } from './cleanup.js';
import { acceptSubject, dismissSubject, subjectProposals } from './dossier-auto.js';
import { customerInfo, dropIdentities, linkIdentity } from './customers.js';

const ITEM_ACTIONS = new Set(['approve', 'reject', 'archive', 'restore', 'trash', 'confirm', 'pin', 'unpin', 'retire']);

export interface MemoryRouteDeps {
  learner: Learner;
  maintain(userId: string, trigger: 'nightly' | 'manual'): Promise<MaintenanceReport>;
}

export function memoryRoutes(ctx: Ctx, svc: MemoryService, deps: MemoryRouteDeps) {
  const api = ctx.api;
  const st = ctx.store;

  const ownItem = (userId: string, id: string, write = false): MemoryItemRow => {
    const row = svc.itemRow(id);
    if (!row || row.status === 'forgotten') throw notFound('Herinnering niet gevonden');
    if (row.user_id === userId) return row;
    const role = svc.dossierRole(userId, row.dossier_id);
    if (row.scope === 'dossier' && role && (!write || role !== 'read')) return row;
    throw notFound('Herinnering niet gevonden');
  };

  /** A team filter from the page (a team of the owner or '*'), or null (all teams / no teams). */
  const teamFilter = (userId: string, v: any): string | null => {
    const s = typeof v === 'string' ? v : '';
    return s && svc.validTeam(userId, s) ? s : null;
  };

  const actorName = (actor: string, id: string | null) => (actor === 'agent' ? svc.agentName(id) : actor === 'user' ? st.user(id || '')?.name || 'Gebruiker' : actor === 'import' ? 'Import' : 'Systeem');

  const changeView = (c: any) => {
    const decodeContent = (snap: any) => (snap ? (snap.content_enc ? svc.decrypt(snap.content_enc) : snap.content ?? snap.title ?? null) : null);
    const before = c.before ? (typeof c.before === 'string' ? JSON.parse(c.before) : c.before) : null;
    const after = c.after ? (typeof c.after === 'string' ? JSON.parse(c.after) : c.after) : null;
    const fields: string[] = [];
    if (before && after) for (const k of ['content', 'content_enc', 'status', 'scope', 'agent_id', 'type', 'canonical_key', 'sensitivity', 'pinned', 'expires_at', 'title', 'body', 'owner', 'due_at', 'summary']) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) fields.push(k === 'content_enc' ? 'content' : k);
    return {
      id: c.id,
      record_kind: c.record_kind,
      record_id: c.record_id,
      dossier_id: c.dossier_id,
      op: c.op,
      summary: c.summary,
      reason: c.reason,
      actor: c.actor,
      actor_id: c.actor_id,
      actor_name: actorName(c.actor, c.actor_id),
      batch_id: c.batch_id,
      created_at: c.created_at,
      undone_at: c.undone_at,
      undoable: !!c.undoable && !c.redacted && !c.undone_at && (!c.undo_until || c.undo_until > now()) && c.op !== 'undo',
      redacted: !!c.redacted,
      before_content: c.redacted ? null : decodeContent(before),
      after_content: c.redacted ? null : decodeContent(after),
      before_status: before?.status ?? null,
      after_status: after?.status ?? null,
      fields: [...new Set(fields)],
      receipt: c.op === 'forget' ? after : null,
    };
  };

  const setStatus = (userId: string, row: MemoryItemRow, status: string, op: string, extra: any = {}) =>
    st.tx(() => {
      const before = svc.snapshot('item', row.id);
      svc.patchItem(row.id, { status: status as any, ...extra });
      const changeId = svc.recordChange({ userId: row.user_id, kind: 'item', recordId: row.id, dossierId: row.dossier_id, op, before, after: svc.snapshot('item', row.id), summary: `${({ archive: 'Gearchiveerd', restore: 'Teruggezet', trash: 'Naar prullenbak', pin: 'Vastgezet', unpin: 'Losgemaakt', confirm: 'Bevestigd', share: 'Gedeeld', move: 'Verplaatst', update: 'Bewerkt' } as any)[op] || op}: ${svc.label(row)}`, actor: 'user', actorId: userId });
      svc.emit(row.user_id, { op, ids: [row.id], dossierId: row.dossier_id, changeId });
      ctx.audit(userId, `memory.${op}`, { ref: row.ref });
      return { item: svc.view(svc.itemRow(row.id)), changeId };
    });

  const itemAction = (userId: string, id: string, action: string, body: any = {}) => {
    const row = ownItem(userId, id, true);
    switch (action) {
      case 'approve': {
        const r = approveProposal(svc, userId, row.id, { action: body.mode, content: body.content, scope: body.scope, agentId: body.agentId, dossierId: body.dossierId, type: body.type, key: body.key, sensitivity: body.sensitivity, expires_at: body.expires_at, teamId: body.teamId });
        return { item: svc.view(r.item), changeId: r.changeId };
      }
      case 'reject':
        return { changeId: rejectProposal(svc, userId, row.id, str(body.reason, 200)) };
      case 'archive':
        if (row.status !== 'active') throw bad('Alleen actieve herinneringen kun je archiveren');
        return setStatus(userId, row, 'archived', 'archive', { valid_to: now(), pinned: false });
      case 'restore': {
        if (!['archived', 'trashed', 'rejected'].includes(row.status)) throw bad('Deze herinnering kun je niet terugzetten');
        const content = svc.contentOf(row);
        if (svc.blockedBy(row.user_id, content, row.canonical_key, ['forget'])) throw bad('Dit is eerder vergeten; hef eerst de blokkade op.');
        if (row.status === 'rejected') st.exec("DELETE FROM memory_tombstones WHERE user_id = ? AND kind = 'reject' AND record_id = ?", row.user_id, row.id);
        return setStatus(userId, row, row.status === 'rejected' ? 'proposed' : 'active', 'restore', { trashed_at: null, valid_to: null, valid_from: now() });
      }
      case 'trash':
        if (['trashed', 'forgotten'].includes(row.status)) throw bad('Staat al in de prullenbak');
        return setStatus(userId, row, 'trashed', 'trash', { trashed_at: now(), pinned: false });
      case 'confirm':
        // "Klopt nog": the next check follows the item's own interval (a one-time check from maintenance just ends).
        return setStatus(userId, row, row.status, 'confirm', { last_confirmed_at: now(), review_at: nextReview(row.review_every_days) });
      case 'retire': {
        // "Werkt niet meer": gone from what bots use, and from now on told to them as "niet meer doen, omdat …".
        const r = retireItem(svc, row, { reason: str(body.reason, 300), actor: 'user', actorId: userId });
        return { item: svc.view(r.item), changeId: r.changeId };
      }
      case 'pin':
      case 'unpin':
        if (row.status !== 'active') throw bad('Alleen actieve herinneringen kun je vastzetten');
        return setStatus(userId, row, row.status, action, { pinned: action === 'pin', flags: (row.flags || []).filter((f) => f !== 'brief') });
    }
    throw bad('Onbekende actie');
  };

  // ------------------------------------------------------------------ overview / list

  api.get(
    '/memory/overview',
    ah(async (req) => {
      const u = user(req);
      const counts = st.all<any>("SELECT scope, status, COUNT(*) AS n FROM memory_items WHERE user_id = ? AND status NOT IN ('forgotten') GROUP BY scope, status", u.id);
      const byScope: Record<string, Record<string, number>> = {};
      for (const c of counts) (byScope[c.scope] ||= {})[c.status] = c.n;
      const due = st.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND status = 'active' AND review_at IS NOT NULL AND review_at < ?", u.id, now())?.n || 0;
      const proposedDecisions = st.one<any>("SELECT COUNT(*) AS n FROM memory_records WHERE user_id = ? AND kind = 'decision' AND status = 'proposed'", u.id)?.n || 0;
      const dossiers = st.one<any>("SELECT COUNT(*) AS n FROM memory_dossiers WHERE user_id = ? AND status IN ('active','closed')", u.id)?.n || 0;
      const sharedWithMe = st.one<any>('SELECT COUNT(*) AS n FROM memory_dossier_acl WHERE user_id = ?', u.id)?.n || 0;
      const openActions = st.one<any>("SELECT COUNT(*) AS n FROM memory_records WHERE user_id = ? AND kind = 'action' AND status = 'open'", u.id)?.n || 0;
      const episodes = st.one<any>("SELECT COUNT(*) AS n FROM memory_episodes WHERE user_id = ? AND summary != ''", u.id)?.n || 0;
      const recent = st.all<any>("SELECT * FROM memory_changes WHERE user_id = ? AND op != 'undo' ORDER BY created_at DESC LIMIT 12", u.id).map(changeView);
      const proposals = st.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND status = 'proposed'", u.id)?.n || 0;
      return { byScope, review: proposals + due + proposedDecisions, proposals, due, dossiers, sharedWithMe, openActions, episodes, recent, settings: svc.userSettings(u.id) };
    }),
  );

  api.get(
    '/memory/items',
    ah(async (req) => {
      const u = user(req);
      const q = req.query as Record<string, string>;
      const reader = svc.userReader(u.id);
      const acl = svc.aclSql(reader);
      const where = [acl.sql];
      const params: any[] = [...acl.params];
      const status = q.status || 'active';
      if (status === 'all') where.push("i.status NOT IN ('forgotten')");
      else {
        where.push('i.status = ?');
        params.push(status);
      }
      if (q.scope && SCOPES.includes(q.scope as Scope)) (where.push('i.scope = ?'), params.push(q.scope));
      if (q.agentId) (where.push('i.agent_id = ?'), params.push(q.agentId));
      if (q.dossierId) (where.push('i.dossier_id = ?'), params.push(q.dossierId));
      if (q.type && ITEM_TYPES.includes(q.type as any)) (where.push('i.type = ?'), params.push(q.type));
      if (q.sensitivity && SENSITIVITIES.includes(q.sensitivity as any)) (where.push('i.sensitivity = ?'), params.push(q.sensitivity));
      if (q.source) (where.push('i.source_kind = ?'), params.push(q.source));
      if (q.pinned === '1') where.push('i.pinned = 1');
      if (q.from) (where.push('i.created_at >= ?'), params.push(q.from));
      if (q.to) (where.push('i.created_at <= ?'), params.push(q.to + (q.to.length === 10 ? 'T23:59:59.999Z' : '')));
      if (q.threadId) (where.push('i.source_thread_id = ?'), params.push(q.threadId));
      // Team filter (two or more teams): that team's bot notes, shared knowledge and dossier notes; '*' = for all teams.
      const team = teamFilter(u.id, q.teamId);
      if (team) {
        const t = svc.ownerItemTeamSql(u.id, team);
        where.push(t.sql);
        params.push(...t.params);
      }
      const limit = Math.min(200, Number(q.limit) || 50);
      const offset = Math.max(0, Number(q.offset) || 0);
      if (q.q?.trim()) {
        // Relevance order from the search (words and meaning); filters applied in SQL.
        const hits = await svc.searchItemsAsync(reader, q.q, { limit: 200, status: status === 'all' ? undefined : status, includeInactive: status !== 'active' });
        if (!hits.length) return { items: [], total: 0 };
        where.push(`i.id IN (${hits.map(() => '?').join(',')})`);
        params.push(...hits.map((h) => h.row.id));
        const rank = new Map(hits.map((h, k) => [h.row.id, k]));
        const rows = st.all<any>(`SELECT i.* FROM memory_items i WHERE ${where.join(' AND ')}`, ...params).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
        return { items: rows.slice(offset, offset + limit).map((r) => svc.view(st.decode('memory_items', r))), total: rows.length };
      }
      const total = st.one<any>(`SELECT COUNT(*) AS n FROM memory_items i WHERE ${where.join(' AND ')}`, ...params)?.n || 0;
      const rows = st.all<any>(`SELECT i.* FROM memory_items i WHERE ${where.join(' AND ')} ORDER BY i.pinned DESC, i.updated_at DESC LIMIT ${limit} OFFSET ${offset}`, ...params);
      return { items: rows.map((r) => svc.view(st.decode('memory_items', r))), total };
    }),
  );

  api.get(
    '/memory/items/:id',
    ah(async (req) => {
      const u = user(req);
      const row = ownItem(u.id, req.params.id as string);
      const chain: any[] = [];
      let prev = row.supersedes_id ? svc.itemRow(row.supersedes_id) : null;
      while (prev && chain.length < 20) {
        chain.push(svc.view(prev, { names: false }));
        prev = prev.supersedes_id ? svc.itemRow(prev.supersedes_id) : null;
      }
      const next = row.superseded_by ? svc.view(svc.itemRow(row.superseded_by), { names: false }) : null;
      const changes = st.all<any>('SELECT * FROM memory_changes WHERE record_id = ? ORDER BY created_at DESC LIMIT 50', row.id).map(changeView);
      const conflict = row.conflict_with ? svc.view(svc.itemRow(row.conflict_with)) : null;
      const merged = (row.merge_of || []).map((id) => svc.view(svc.itemRow(id))).filter(Boolean);
      const usage = st.all<any>("SELECT thread_id, via, created_at FROM memory_usage WHERE user_id = ? AND refs LIKE ? ORDER BY created_at DESC LIMIT 10", u.id, `%"${row.id}"%`);
      const sourceMessage = row.source_kind === 'message' && row.source_ref ? st.message(row.source_ref) : null;
      return {
        item: svc.view(row),
        versions: chain,
        next,
        changes,
        conflict,
        merged,
        usage,
        source: sourceMessage && st.thread(sourceMessage.thread_id)?.user_id === u.id ? { messageId: sourceMessage.id, threadId: sourceMessage.thread_id, deleted: sourceMessage.deleted, excerpt: excerpt(sourceMessage.content, 300), author: sourceMessage.author_name, at: sourceMessage.created_at } : null,
      };
    }),
  );

  api.post(
    '/memory/items',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const scope = (SCOPES.includes(b.scope) ? b.scope : 'about_you') as Scope;
      if (b.liftBlock === true) {
        const tomb = svc.blockedBy(scope === 'dossier' ? st.get<any>('memory_dossiers', b.dossierId)?.user_id || u.id : u.id, str(b.content, 4000), b.key, ['forget']);
        if (tomb) {
          st.exec('DELETE FROM memory_tombstones WHERE id = ?', tomb.id);
          ctx.audit(u.id, 'memory.block_lifted', { tombstone: tomb.id });
        }
      }
      const out = writeCandidate(svc, {
        userId: u.id,
        content: str(b.content, 4000),
        scope,
        agentId: b.agentId || null,
        dossierId: b.dossierId || null,
        type: ITEM_TYPES.includes(b.type) ? b.type : undefined,
        key: b.key ? str(b.key, 80) : null,
        sensitivity: SENSITIVITIES.includes(b.sensitivity) ? b.sensitivity : undefined,
        source: b.threadId && st.thread(b.threadId)?.user_id === u.id ? { kind: 'message', ref: b.messageId || null, threadId: b.threadId, excerpt: b.messageId ? st.message(b.messageId)?.content : null, trust: 'user' } : { kind: 'user', trust: 'user' },
        // Shared knowledge: the team the owner picked, or "alle teams" ('*'); else the default team.
        teamId: scope === 'shared' && b.teamId ? str(b.teamId, 80) : null,
        origin: 'user_ui',
        createdBy: 'user',
        userApproved: true,
        pinned: !!b.pinned,
        expiresAt: b.expires_at || null,
        reviewAt: b.review_at || null,
        reviewEveryDays: b.review_every_days !== undefined ? reviewInterval(b.review_every_days) ?? 0 : undefined,
        idemKey: b.idemKey ? `ui:${str(b.idemKey, 80)}` : null,
      });
      if (out.action === 'blocked') throw new HttpError(409, out.message, 'blocked');
      if (['rejected', 'invalid', 'quota'].includes(out.action)) throw bad(out.message);
      return out;
    }),
  );

  api.patch(
    '/memory/items/:id',
    ah(async (req) => {
      const u = user(req);
      const row = ownItem(u.id, req.params.id as string, true);
      if (['forgotten', 'rejected'].includes(row.status)) throw bad('Deze herinnering kan niet meer worden bewerkt');
      const b = req.body || {};
      const p: any = {};
      let op = 'update';
      if (b.content !== undefined) {
        const c = clean(str(b.content, 4000));
        if (!c) throw bad('Lege tekst');
        const secret = detectSecret(c);
        if (secret) throw bad(`Dit lijkt op een ${secret}; dat hoort niet in het geheugen.`);
        if (svc.blockedBy(row.user_id, c, b.key ?? row.canonical_key, ['forget'])) throw new HttpError(409, 'Dit is eerder vergeten; hef eerst de blokkade op in Geschiedenis › Blokkades.', 'blocked');
        if (c !== svc.contentOf(row)) p.content = c;
      }
      if (b.type !== undefined && ITEM_TYPES.includes(b.type)) p.type = b.type;
      if (b.key !== undefined) p.canonical_key = b.key ? str(b.key, 80) : null;
      if (b.sensitivity !== undefined && SENSITIVITIES.includes(b.sensitivity)) p.sensitivity = b.sensitivity;
      if (b.expires_at !== undefined) p.expires_at = b.expires_at || null;
      if (b.review_at !== undefined) p.review_at = b.review_at || null;
      if (b.review_every_days !== undefined) {
        const n = reviewInterval(b.review_every_days);
        if (n === null) throw bad('Kies nooit, elke maand, elke 3 of 6 maanden of elk jaar');
        if (n !== (row.review_every_days || 0)) {
          p.review_every_days = n || null;
          // A new rhythm starts today ("elke 3 maanden" → first check in 3 months); "Nooit" clears the date.
          if (b.review_at === undefined) p.review_at = nextReview(n);
        }
      }
      if (b.pinned !== undefined) p.pinned = !!b.pinned;
      // The team (two or more teams): shared knowledge in a team or "alle teams"; a bot note in a team of that bot.
      const teamChoice = b.teamId !== undefined && b.teamId !== null && b.teamId !== '' ? str(b.teamId, 80) : null;
      if (teamChoice && !svc.validTeam(u.id, teamChoice)) throw bad('Onbekend team');
      if (b.scope !== undefined && b.scope !== row.scope) {
        if (row.user_id !== u.id) throw bad('Alleen de eigenaar kan dit verplaatsen');
        if (!SCOPES.includes(b.scope)) throw bad('Onbekende plek');
        p.scope = b.scope;
        op = b.scope === 'shared' ? 'share' : 'move';
        p.agent_id = null;
        p.dossier_id = null;
        p.team_id = null;
        if (b.scope === 'agent') {
          const a = st.agent(b.agentId);
          if (!a || a.user_id !== u.id) throw bad('Kies een bot');
          p.agent_id = a.id;
          p.team_id = svc.homeTeam(a);
        }
        if (b.scope === 'dossier') {
          const role = svc.dossierRole(u.id, b.dossierId);
          if (role !== 'owner' && role !== 'edit') throw bad('Kies een dossier');
          p.dossier_id = b.dossierId;
        }
        // Shared from a bot note: stays in the bot's team unless the owner picks another (or all teams).
        if (b.scope === 'shared') p.team_id = teamChoice ?? (row.scope === 'agent' ? row.team_id ?? null : null);
      } else if (b.agentId && row.scope === 'agent' && b.agentId !== row.agent_id) {
        const a = st.agent(b.agentId);
        if (!a || a.user_id !== u.id) throw bad('Kies een bot');
        p.agent_id = a.id;
        p.team_id = svc.homeTeam(a);
        op = 'move';
      } else if (teamChoice && (row.scope === 'shared' || (row.scope === 'agent' && teamChoice !== ALL_TEAMS)) && row.user_id === u.id && svc.resolveTeam(u.id, teamChoice) !== svc.resolveTeam(u.id, row.team_id)) {
        p.team_id = teamChoice;
        op = 'move';
      }
      if (!Object.keys(p).length) return { item: svc.view(row) };
      if (p.content !== undefined || p.scope !== undefined) p.version = (row.version || 1) + 1;
      return setStatus(u.id, row, row.status, op, p);
    }),
  );

  api.post(
    '/memory/items/:id/forget',
    ah(async (req) => {
      const u = user(req);
      const row = ownItem(u.id, req.params.id as string, true);
      if (row.user_id !== u.id && svc.dossierRole(u.id, row.dossier_id) !== 'edit') throw bad('Geen rechten');
      return forgetRecord(svc, u.id, row.id, { actor: 'user', actorId: u.id, alsoSource: req.body?.alsoSource !== false, label: str(req.body?.label, 120), reason: str(req.body?.reason, 200) });
    }),
  );

  api.post(
    '/memory/items/bulk',
    ah(async (req) => {
      const u = user(req);
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 200).map(String) : [];
      const action = String(req.body?.action || '');
      if (!ITEM_ACTIONS.has(action) && action !== 'forget') throw bad('Onbekende actie');
      const results: any[] = [];
      for (const id of ids) {
        try {
          if (action === 'forget') results.push({ id, ok: true, receipt: forgetRecord(svc, u.id, ownItem(u.id, id, true).id, { actor: 'user', actorId: u.id, alsoSource: req.body?.alsoSource !== false, purge: false }).id });
          else (itemAction(u.id, id, action, {}), results.push({ id, ok: true }));
        } catch (e: any) {
          results.push({ id, ok: false, error: e.message });
        }
      }
      if (action === 'forget' && results.some((r) => r.ok)) purgeForgotten(svc, { messages: req.body?.alsoSource !== false });
      return { results, ok: results.filter((r) => r.ok).length };
    }),
  );

  api.post(
    '/memory/items/:id/:action',
    ah(async (req) => {
      const u = user(req);
      const action = req.params.action as string;
      if (!ITEM_ACTIONS.has(action)) throw notFound('Onbekende actie');
      try {
        return itemAction(u.id, req.params.id as string, action, req.body || {});
      } catch (e: any) {
        if (e instanceof HttpError) throw e;
        throw bad(e.message);
      }
    }),
  );

  // ------------------------------------------------------------------ review queue

  api.get(
    '/memory/review',
    ah(async (req) => {
      const u = user(req);
      const proposals = st.all<any>("SELECT * FROM memory_items WHERE user_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 300", u.id).map((r) => {
        const row = st.decode<MemoryItemRow>('memory_items', r);
        return {
          item: svc.view(row),
          conflict: row.conflict_with ? svc.view(svc.itemRow(row.conflict_with)) : null,
          merged: (row.merge_of || []).map((id) => svc.view(svc.itemRow(id))).filter(Boolean),
        };
      });
      const due = st.all<any>("SELECT * FROM memory_items WHERE user_id = ? AND status = 'active' AND review_at IS NOT NULL AND review_at < ? ORDER BY review_at LIMIT 100", u.id, now()).map((r) => svc.view(st.decode('memory_items', r)));
      const decisions = st.all<any>("SELECT r.*, d.title AS dossier_title FROM memory_records r JOIN memory_dossiers d ON d.id = r.dossier_id WHERE r.user_id = ? AND r.kind = 'decision' AND r.status = 'proposed' ORDER BY r.created_at DESC LIMIT 100", u.id).map((r) => {
        const rec = st.decode<any>('memory_records', r);
        const old = rec.data?.conflict_with ? st.decode<any>('memory_records', st.get('memory_records', rec.data.conflict_with)) : null;
        return { record: { ...rec, author_name: rec.author_type === 'agent' ? svc.agentName(rec.author_id) : 'Gebruiker' }, conflict: old };
      });
      return { proposals, due, decisions };
    }),
  );

  // ------------------------------------------------------------------ history / undo / blocks

  api.get(
    '/memory/changes',
    ah(async (req) => {
      const u = user(req);
      const q = req.query as Record<string, string>;
      const where = ['user_id = ?'];
      const params: any[] = [u.id];
      if (q.recordId) (where.push('record_id = ?'), params.push(q.recordId));
      if (q.dossierId) (where.push('dossier_id = ?'), params.push(q.dossierId));
      if (q.op) (where.push('op = ?'), params.push(q.op));
      if (q.actor) (where.push('actor = ?'), params.push(q.actor));
      if (q.before) (where.push('created_at < ?'), params.push(q.before));
      // Team filter: changes of that team's items and of its dossiers (derived from the records, no copy of the team).
      const team = teamFilter(u.id, q.teamId);
      if (team) {
        const it = svc.ownerItemTeamSql(u.id, team);
        const deq = svc.teamEq('d.team_id', u.id, team);
        where.push(`((record_kind = 'item' AND record_id IN (SELECT i.id FROM memory_items i WHERE i.user_id = ? AND ${it.sql})) OR dossier_id IN (SELECT d.id FROM memory_dossiers d WHERE d.user_id = ? AND ${deq.sql}))`);
        params.push(u.id, ...it.params, u.id, ...deq.params);
      }
      const limit = Math.min(200, Number(q.limit) || 50);
      return st.all<any>(`SELECT * FROM memory_changes WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`, ...params).map(changeView);
    }),
  );

  api.post(
    '/memory/changes/:id/undo',
    ah(async (req) => {
      const u = user(req);
      try {
        return svc.undo(u.id, req.params.id as string, u.id);
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );

  api.get(
    '/memory/blocks',
    ah(async (req) => {
      const u = user(req);
      return st.all<any>("SELECT id, kind, label, record_kind, scope, created_at, expires_at FROM memory_tombstones WHERE user_id = ? AND kind = 'forget' ORDER BY created_at DESC LIMIT 500", u.id);
    }),
  );

  api.delete(
    '/memory/blocks/:id',
    ah(async (req) => {
      const u = user(req);
      const r = st.one<any>('SELECT id FROM memory_tombstones WHERE id = ? AND user_id = ?', req.params.id, u.id);
      if (!r) throw notFound('Blokkade niet gevonden');
      st.exec('DELETE FROM memory_tombstones WHERE id = ?', r.id);
      ctx.audit(u.id, 'memory.block_lifted', { tombstone: r.id });
      svc.emit(u.id, { op: 'block_lifted' });
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------------ settings / storage / maintenance

  api.get('/memory/settings', ah(async (req) => svc.userSettings(user(req).id)));
  api.put(
    '/memory/settings',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const patch: any = {};
      if (b.learnMode !== undefined) {
        if (!['off', 'explicit', 'auto'].includes(b.learnMode)) throw bad('Ongeldige leermodus');
        patch.learnMode = b.learnMode;
      }
      if (b.extractor !== undefined) {
        if (!['heuristic', 'own', 'free', 'model'].includes(b.extractor)) throw bad('Ongeldige methode');
        patch.extractor = b.extractor;
      }
      if (b.autoApply !== undefined) {
        if (!['own', 'never'].includes(b.autoApply)) throw bad('Ongeldige keuze');
        patch.autoApply = b.autoApply;
      }
      if (b.engine !== undefined) {
        const pid = b.engine?.providerId ? str(b.engine.providerId, 80) : null;
        if (pid && !ctx.providers.list(u.id).some((p) => p.id === pid)) throw bad('Onbekende engine');
        patch.engine = { providerId: pid, model: b.engine?.model ? str(b.engine.model, 120) : null };
      }
      if (b.nightly !== undefined) patch.nightly = !!b.nightly;
      for (const k of ['quietMin', 'briefTokens', 'learnEvery']) if (b[k] !== undefined) patch[k] = Number(b[k]) || 0;
      if (b.botWrites !== undefined) {
        if (!['direct', 'propose'].includes(b.botWrites)) throw bad('Ongeldige keuze');
        patch.botWrites = b.botWrites;
      }
      if (b.conflicts !== undefined) {
        if (!['ask', 'replace'].includes(b.conflicts)) throw bad('Ongeldige keuze');
        patch.conflicts = b.conflicts;
      }
      if (b.reviewEveryDays !== undefined) {
        const n = reviewInterval(b.reviewEveryDays);
        if (n === null) throw bad('Kies nooit, elke maand, elke 3 of 6 maanden of elk jaar');
        patch.reviewEveryDays = n;
      }
      for (const k of ['paused', 'episodes']) if (b[k] !== undefined) patch[k] = !!b[k];
      if (b.semantic !== undefined) {
        if (!['auto', 'off'].includes(b.semantic)) throw bad('Ongeldige keuze');
        patch.semantic = b.semantic;
      }
      if (b.semanticModel !== undefined) {
        const m = b.semanticModel ? str(b.semanticModel, 120) : null;
        if (m && !/^[\w.:/@+-]{1,120}$/.test(m)) throw bad('Ongeldige modelnaam');
        patch.semanticModel = m;
      }
      for (const k of ['budgetTokens', 'profileCap', 'trashDays', 'modelDailyCap']) if (b[k] !== undefined) patch[k] = Number(b[k]) || 0;
      if (b.quotas && typeof b.quotas === 'object') patch.quotas = b.quotas;
      // 0.4 F2: target size per part, archive after, dossiers for recurring subjects.
      if (b.targets && typeof b.targets === 'object') {
        const t: any = {};
        for (const k of ['about_you', 'agent', 'shared', 'dossier', 'client']) if (b.targets[k] !== undefined) t[k] = Math.round(Number(b.targets[k]) || 0);
        patch.targets = t;
      }
      if (b.archiveAfterDays !== undefined) patch.archiveAfterDays = Number(b.archiveAfterDays) || 0;
      if (b.dossierAuto !== undefined) {
        if (!['off', 'propose', 'create'].includes(b.dossierAuto)) throw bad('Ongeldige keuze');
        patch.dossierAuto = b.dossierAuto;
      }
      const s = svc.saveUserSettings(u.id, patch);
      ctx.audit(u.id, 'memory.settings', { fields: Object.keys(patch) });
      svc.emit(u.id, { op: 'settings' });
      return s;
    }),
  );

  api.get(
    '/memory/admin/limits',
    ah(async (req) => {
      requireRole(req, 'admin');
      return svc.limits();
    }),
  );
  api.put(
    '/memory/admin/limits',
    ah(async (req) => {
      const u = requireRole(req, 'admin');
      const b = req.body || {};
      const cur = svc.limits();
      const next = {
        items: Math.max(100, Math.min(1_000_000, Number(b.items ?? cur.items))),
        bytes: Math.max(100_000, Math.min(2_000_000_000, Number(b.bytes ?? cur.bytes))),
        budgetTokens: Math.max(0, Math.min(64_000, Number(b.budgetTokens ?? cur.budgetTokens))),
        profileCap: Math.max(0, Math.min(64_000, Number(b.profileCap ?? cur.profileCap))),
        dossiers: Math.max(10, Math.min(100_000, Number(b.dossiers ?? cur.dossiers))),
        dossiersTotal: Math.max(10, Math.min(1_000_000, Number(b.dossiersTotal ?? cur.dossiersTotal))),
      };
      st.setSetting('', 'memory.limits', next);
      ctx.audit(u.id, 'memory.admin_limits', next);
      return next;
    }),
  );

  api.get('/memory/storage', ah(async (req) => storageReport(svc, user(req).id)));
  /** Every part of memory against its target size (active, archived, target, quota). */
  api.get('/memory/sizes', ah(async (req) => ({ parts: sizes(svc, user(req).id), targets: svc.userSettings(user(req).id).targets })));
  api.get('/memory/agents', ah(async (req) => storageReport(svc, user(req).id).agents));

  // ------------------------------------------------------------------ teams (0.4 B)

  /** The owner's teams for the memory page: a team filter and team choices appear only with two or more. */
  api.get(
    '/memory/teams',
    ah(async (req) => {
      const u = user(req);
      const list = (svc.teams?.list(u.id) || []) as any[];
      return { multi: list.length > 1, teams: list.map((t, i) => ({ id: t.id, name: t.name, color: t.color, isDefault: i === 0, bots: (svc.teams?.botsOf(t.id) || []) as string[] })) };
    }),
  );

  /**
   * "Vakkennis kopiëren": the dossiers and shared knowledge of one team into another (a visible, deliberate copy;
   * copying is preferred over linking). Never "Over jou", bot notes, summaries or anything personal or sensitive.
   */
  api.post(
    '/memory/teams/copy',
    ah(async (req) => {
      const u = user(req);
      try {
        return copyTeamKnowledge(svc, u.id, str(req.body?.fromTeamId, 80), str(req.body?.toTeamId, 80), { actorId: u.id });
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );
  api.post(
    '/memory/consolidate',
    ah(async (req) => {
      // "Dubbele herinneringen zoeken": the one maintenance path (duplicates merged, contradictions resolved, each
      // part within its budget), with its report and undo.
      const rep = await deps.maintain(user(req).id, 'manual');
      return { merged: rep.counts?.merged || 0, changes: rep.lines?.length || 0, reportId: rep.id };
    }),
  );
  api.post(
    '/memory/reconcile',
    ah(async (req) => reconcile(svc, user(req).id)),
  );
  api.post(
    '/memory/trash/empty',
    ah(async (req) => {
      const u = user(req);
      const n = purgeTrash(svc, u.id, true);
      ctx.audit(u.id, 'memory.trash_emptied', { count: n });
      return { purged: n };
    }),
  );
  api.post(
    '/memory/reindex',
    ah(async (req) => {
      const u = user(req);
      const indexed = svc.reindex(u.id);
      const sem = await svc.semantic.info(u.id, true);
      return { indexed, meaning: sem.state === 'on' ? 'rebuilding' : sem.state };
    }),
  );

  // ------------------------------------------------------------------ search by meaning (local Ollama)

  const semanticView = async (userId: string, fresh = false) => {
    const info = await svc.semantic.info(userId, fresh);
    const s = svc.userSettings(userId);
    const pull = info.provider ? svc.semantic.pulls.get(info.provider.id) || null : null;
    const b = svc.semantic.builtinStatus();
    const offerSeen = !!st.getSetting<any>(userId, 'memory.builtinOffer', null);
    return {
      mode: s.semantic,
      chosen: s.semanticModel,
      state: info.state,
      engine: info.engine?.kind || null,
      model: info.engine?.model || null,
      models: info.models,
      provider: info.provider,
      error: info.error || null,
      counts: svc.semantic.counts(userId),
      pull,
      suggested: SUGGESTED_MODEL,
      // The built-in model: one download (± MB) after the owner said yes; "no-runtime" = this build cannot run it.
      builtin: { ...b, id: BUILTIN.id, mb: Math.round(b.bytes / 1e6), homepage: BUILTIN.homepage, mayEnable: ctx.config.mode !== 'server' || ['owner', 'admin'].includes(String(st.user(userId)?.role || '')) },
      // The calm one-time card ("Slim zoeken aanzetten?"): only when nothing searches by meaning yet and it can run here.
      offer: s.semantic !== 'off' && info.state !== 'on' && ['absent', 'error'].includes(b.state) && !offerSeen,
    };
  };
  api.get('/memory/semantic', ah(async (req) => semanticView(user(req).id, req.query.fresh === '1')));

  /** "Slim zoeken aanzetten": the owner's yes to the built-in model (download once, then everything stays here). */
  api.post(
    '/memory/semantic/builtin',
    ah(async (req) => {
      const u = user(req);
      const action = str(req.body?.action, 20);
      st.setSetting(u.id, 'memory.builtinOffer', { at: now(), action });
      if (action === 'later') return semanticView(u.id);
      if (ctx.config.mode === 'server' && !['owner', 'admin'].includes(String(u.role || ''))) throw new HttpError(403, 'Alleen de beheerder van deze server kan het ingebouwde zoekmodel downloaden.', 'forbidden');
      if (action === 'remove') {
        svc.semantic.removeBuiltin();
        ctx.audit(u.id, 'memory.semantic_builtin_removed', {});
        return semanticView(u.id, true);
      }
      if (action !== 'enable') throw bad('Ongeldige keuze');
      const b0 = svc.semantic.builtinStatus();
      if (b0.state === 'no-runtime') throw bad('Het ingebouwde zoekmodel kan in deze versie van TeamBot niet draaien. Zoeken op woorden (met synoniemen) werkt gewoon.');
      if (svc.userSettings(u.id).semantic === 'off') svc.saveUserSettings(u.id, { semantic: 'auto' });
      ctx.audit(u.id, 'memory.semantic_builtin', { mb: Math.round(b0.bytes / 1e6) });
      svc.semantic.enableBuiltin(u.id, (ok) => {
        svc.emit(u.id, { op: 'semantic' });
        const st2 = svc.semantic.builtinStatus();
        ctx.events.emit(
          u.id,
          'notification',
          ok
            ? { title: 'Slim zoeken staat aan', body: 'Het zoekmodel staat op je pc. TeamBot vindt herinneringen en documenten nu ook als ze in andere woorden staan.', link: '#/m/memory/opslag', kind: 'memory' }
            : { title: 'Slim zoeken niet gelukt', body: `Het zoekmodel kon niet worden gedownload (${st2.error || 'onbekende fout'}). Zoeken op woorden werkt gewoon; probeer het later opnieuw in Geheugen › Opslag.`, link: '#/m/memory/opslag', kind: 'memory' },
        );
      });
      return semanticView(u.id);
    }),
  );

  // ------------------------------------------------------------------ dossiers for recurring subjects (0.4 F2)

  api.get('/memory/dossier-proposals', ah(async (req) => subjectProposals(svc, user(req).id)));
  api.post(
    '/memory/dossier-proposals/:id/accept',
    ah(async (req) => {
      const u = user(req);
      const d = acceptSubject(svc, u.id, req.params.id as string, { type: 'user', id: u.id }, req.body?.title ? str(req.body.title, 120) : undefined);
      if (!d) throw notFound('Voorstel niet gevonden');
      return { dossier: d };
    }),
  );
  api.post(
    '/memory/dossier-proposals/:id/dismiss',
    ah(async (req) => {
      const u = user(req);
      if (!dismissSubject(svc, u.id, req.params.id as string)) throw notFound('Voorstel niet gevonden');
      svc.emit(u.id, { op: 'reject', kind: 'dossier' });
      return { ok: true };
    }),
  );

  /** Download the suggested embedding model with the owner's own Ollama (his explicit choice; it is ±1,2 GB). */
  api.post(
    '/memory/semantic/pull',
    ah(async (req) => {
      const u = user(req);
      const model = str(req.body?.model, 80) || SUGGESTED_MODEL;
      if (!EMBED_PREFERENCE.some((p) => model === p || model.startsWith(p + ':'))) throw bad('Kies een van de voorgestelde modellen voor zoeken op betekenis');
      const info = await svc.semantic.info(u.id, true);
      if (!info.provider || info.state === 'remote' || info.state === 'no-ollama' || info.state === 'off') throw bad('Koppel eerst Ollama op deze computer (Instellingen › AI-diensten) en zet zoeken op betekenis aan.');
      if (info.state === 'unreachable') throw bad('Ollama reageert niet. Start Ollama en probeer het opnieuw.');
      const cfg = ctx.providers.config(info.provider.id)!;
      const origin = (() => {
        try {
          return new URL(cfg.base_url || ctx.providers.kind('ollama')?.baseUrl || 'http://127.0.0.1:11434').origin;
        } catch {
          return 'http://127.0.0.1:11434';
        }
      })();
      ctx.audit(u.id, 'memory.semantic_pull', { model });
      svc.semantic.pull(u.id, { providerId: cfg.id, origin }, model, () => {
        const p = svc.semantic.pulls.get(cfg.id);
        svc.emit(u.id, { op: 'semantic' });
        ctx.events.emit(u.id, 'notification', p?.status === 'done'
          ? { title: 'Zoeken op betekenis staat aan', body: `${model} is gedownload. TeamBot doorzoekt je geheugen nu ook op betekenis; dat blijft op je pc.`, link: '#/m/memory/opslag', kind: 'memory' }
          : { title: 'Downloaden mislukt', body: `${model} kon niet worden gedownload: ${p?.error || 'onbekende fout'}. Zoeken op woorden werkt gewoon.`, link: '#/m/memory/opslag', kind: 'memory' });
      });
      return semanticView(u.id);
    }),
  );

  api.get(
    '/memory/export',
    ah(async (req, res) => {
      const u = user(req);
      const date = new Date().toISOString().slice(0, 10);
      ctx.audit(u.id, 'memory.exported', { format: req.query.format || 'json' });
      if (req.query.format === 'md') {
        res.setHeader('content-type', 'text/markdown; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="teambot-geheugen-${date}.md"`);
        res.send(exportMarkdown(svc, u.id));
        return;
      }
      res.setHeader('content-disposition', `attachment; filename="teambot-geheugen-${date}.json"`);
      res.json(exportJson(svc, u.id));
    }),
  );

  api.post(
    '/memory/import',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const text = str(b.text, 200_000);
      if (!text.trim()) throw bad('Plak eerst de tekst of JSON van je geheugenexport');
      const scope = (SCOPES.includes(b.scope) ? b.scope : 'about_you') as Scope;
      if (scope === 'agent' && st.agent(b.agentId)?.user_id !== u.id) throw bad('Kies een bot');
      if (scope === 'dossier' && !['owner', 'edit'].includes(svc.dossierRole(u.id, b.dossierId) || '')) throw bad('Kies een dossier');
      const teamId = scope === 'shared' ? teamFilter(u.id, b.teamId) : null;
      return importText(svc, u.id, text, { scope, agentId: b.agentId, dossierId: b.dossierId, label: str(b.label, 60), teamId });
    }),
  );

  api.post(
    '/memory/delete-all',
    ah(async (req) => {
      const u = user(req);
      if (req.body?.confirm !== 'WISSEN') throw bad('Typ WISSEN om te bevestigen');
      return { deleted: deleteAllForUser(svc, u.id, { keepBlocks: req.body?.keepBlocks !== false }) };
    }),
  );

  // ------------------------------------------------------------------ mixed search ("Wat weet je over X?")

  api.get(
    '/memory/search',
    ah(async (req) => {
      const u = user(req);
      const q = str(req.query.q, 500);
      if (!q.trim()) return { items: [], dossiers: [], records: [], episodes: [], documents: [] };
      const reader = svc.userReader(u.id);
      const qvec = await svc.semantic.queryVector(u.id, q);
      // Team filter (two or more teams): only that team's memory ("Over jou" is personal and not part of a team).
      const team = teamFilter(u.id, req.query.teamId);
      const items = svc.searchItems(reader, q, { limit: 30, qvec, archived: true, where: team ? svc.ownerItemTeamSql(u.id, team) : null }).map((h) => ({ ...svc.view(h.row), score: Math.round(h.score * 100) / 100, meaning: !!h.meaning }));
      let readable = new Set(svc.readableDossiers(reader));
      if (team) {
        const ids = svc.teamDossierIds(u.id, team);
        readable = new Set([...readable].filter((id) => ids.has(id)));
      }
      const dossiers: any[] = [];
      const records: any[] = [];
      const documents: any[] = [];
      const episodes: any[] = [];
      // Document parts by words and meaning; dossiers, records and conversations by words.
      for (const h of svc.chunkMatch(svc.ownerIds(reader), q, qvec, 30, null, team ? readable : null)) {
        const c = st.one<any>("SELECT c.text, c.dossier_id, s.id, s.ref, s.title FROM memory_chunks c JOIN memory_sources s ON s.id = c.source_id WHERE c.id = ? AND s.status = 'active'", h.rid);
        if (c && readable.has(c.dossier_id)) documents.push({ id: h.rid, ref: c.ref, title: c.title, dossier_id: c.dossier_id, excerpt: excerpt(c.text, 300), meaning: h.meaning });
      }
      for (const h of svc.ftsMatch(svc.ownerIds(reader), q, ['dossier', 'record', 'episode'], 80)) {
        if (h.kind === 'dossier') {
          const d = st.get<any>('memory_dossiers', h.rid);
          if (d && readable.has(d.id)) dossiers.push({ id: d.id, ref: d.ref, title: d.title, summary: excerpt(d.summary, 200), status: d.status, updated_at: d.updated_at });
        } else if (h.kind === 'record') {
          const r = st.decode<any>('memory_records', st.get('memory_records', h.rid));
          if (r && readable.has(r.dossier_id) && !['trashed', 'forgotten'].includes(r.status))
            records.push({ id: r.id, ref: r.ref, kind: r.kind, label: recordLabel(r.kind), title: r.title, status: r.status, dossier_id: r.dossier_id, dossier_title: st.one<any>('SELECT title FROM memory_dossiers WHERE id = ?', r.dossier_id)?.title, at: r.occurred_at || r.due_at || r.created_at, author_type: r.author_type, sources: r.sources });
        } else if (h.kind === 'episode') {
          const e = st.decode<any>('memory_episodes', st.get('memory_episodes', h.rid));
          if (e && e.user_id === u.id && e.summary && (!team || svc.resolveTeam(u.id, e.team_id) === team)) episodes.push({ id: e.id, ref: e.ref, thread_id: e.thread_id, title: e.title, summary: excerpt(e.summary, 300), updated_at: e.updated_at });
        }
      }
      return { items, dossiers: dossiers.slice(0, 10), records: records.slice(0, 20), episodes: episodes.slice(0, 10), documents: documents.slice(0, 10) };
    }),
  );

  // ------------------------------------------------------------------ chat integration (inspector, message extras, tool cards)

  const ownThread = (userId: string, id: string) => {
    const t = st.thread(id);
    if (!t || t.user_id !== userId) throw notFound('Gesprek niet gevonden');
    return t;
  };

  const refBrief = (userId: string, p: string, ref: string, id?: string) => {
    const r = svc.resolve(userId, `${p}:${ref}`) || (id ? svc.resolve(userId, id) : null);
    if (!r) return { p, ref, status: 'forgotten', label: '(vergeten of verwijderd)' };
    const row = r.row;
    if (r.kind === 'item') {
      const item = svc.itemRow(row.id)!;
      return { p, ref, id: item.id, kind: 'item', status: item.status, scope: item.scope, type: item.type, label: item.status === 'forgotten' ? '(vergeten)' : excerpt(svc.contentOf(item), 160), dossier_id: item.dossier_id };
    }
    if (r.kind === 'dossier') return { p, ref, id: row.id, kind: 'dossier', status: row.status, label: row.title };
    if (r.kind === 'episode') return { p, ref, id: row.id, kind: 'episode', status: row.summary ? 'active' : 'forgotten', label: row.title || 'Gesprek', thread_id: row.thread_id };
    if (r.kind === 'source') return { p, ref, id: row.id, kind: 'source', status: row.status, label: row.title, dossier_id: row.dossier_id, url: row.kind === 'url' ? row.target : null };
    return { p, ref, id: row.id, kind: r.kind, status: row.status, label: excerpt(row.title || '', 160), dossier_id: row.dossier_id };
  };

  api.get(
    '/memory/thread/:threadId',
    ah(async (req) => {
      const u = user(req);
      const t = ownThread(u.id, req.params.threadId as string);
      const usage = st.all<any>('SELECT * FROM memory_usage WHERE thread_id = ? ORDER BY created_at DESC LIMIT 20', t.id).map((x) => {
        const u0 = st.decode<any>('memory_usage', x);
        return { id: u0.id, via: u0.via, message_id: u0.message_id, agent_id: u0.agent_id, agent_name: svc.agentName(u0.agent_id), tokens: u0.tokens, created_at: u0.created_at, refs: (u0.refs || []).map((r: any) => refBrief(u.id, r.p, r.ref, r.id)) };
      });
      const learned = st.all<any>("SELECT * FROM memory_items WHERE user_id = ? AND source_thread_id = ? AND status NOT IN ('forgotten','rejected') ORDER BY created_at DESC LIMIT 50", u.id, t.id).map((r) => svc.view(st.decode('memory_items', r)));
      const ep = episodeFor(svc, t.id);
      const linked = linkedDossier(svc, t.id);
      const agent = st.agent(t.agent_id);
      const eff = agent ? svc.effective(agent) : null;
      return {
        usage,
        learned,
        episode: ep,
        linkedDossier: linked ? (() => {
          const d = st.get<any>('memory_dossiers', linked);
          return d ? { id: d.id, ref: d.ref, title: d.title } : null;
        })() : null,
        dossiers: listDossiers(svc, svc.userReader(u.id), { status: 'active' }).map((d: any) => ({ id: d.id, title: d.title, ref: d.ref })),
        agent: agent ? { id: agent.id, name: agent.name, enabled: eff!.enabled, learn: eff!.learn, budgetTokens: eff!.budgetTokens, profileCap: eff!.profileCap } : null,
        audience: svc.audience(t, u.id),
      };
    }),
  );

  api.post(
    '/memory/thread/:threadId/capture',
    ah(async (req) => {
      const u = user(req);
      const t = ownThread(u.id, req.params.threadId as string);
      const b = req.body || {};
      const scope = (SCOPES.includes(b.scope) ? b.scope : t.agent_id ? 'agent' : 'about_you') as Scope;
      const out = writeCandidate(svc, {
        userId: u.id,
        content: str(b.content, 4000),
        scope,
        // (shared: in the team of this conversation's bot, unless the owner picked a team)
        agentId: scope === 'agent' || scope === 'shared' ? b.agentId || t.agent_id : null,
        teamId: scope === 'shared' && b.teamId ? str(b.teamId, 80) : null,
        dossierId: scope === 'dossier' ? b.dossierId || linkedDossier(svc, t.id) : null,
        type: ITEM_TYPES.includes(b.type) ? b.type : undefined,
        source: { kind: 'message', ref: b.messageId || null, threadId: t.id, excerpt: b.messageId ? st.message(b.messageId)?.content : null, trust: 'user' },
        origin: 'user_ui',
        createdBy: 'user',
        userApproved: true,
        pinned: !!b.pinned,
      });
      if (out.action === 'blocked') throw new HttpError(409, out.message, 'blocked');
      if (['rejected', 'invalid', 'quota'].includes(out.action)) throw bad(out.message);
      return out;
    }),
  );

  api.put(
    '/memory/thread/:threadId/link',
    ah(async (req) => {
      const u = user(req);
      const t = ownThread(u.id, req.params.threadId as string);
      const dossierId = req.body?.dossierId || null;
      if (!dossierId) st.exec('DELETE FROM memory_links WHERE thread_id = ?', t.id);
      else {
        if (!svc.dossierRole(u.id, dossierId)) throw bad('Dossier niet gevonden');
        st.exec('INSERT INTO memory_links (thread_id, user_id, dossier_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET dossier_id = excluded.dossier_id', t.id, u.id, dossierId, now());
      }
      svc.emit(u.id, { op: 'link', threadId: t.id });
      return { ok: true, dossierId };
    }),
  );

  api.post(
    '/memory/thread/:threadId/episode/rebuild',
    ah(async (req) => {
      const u = user(req);
      const t = ownThread(u.id, req.params.threadId as string);
      return rebuildEpisode(svc, t);
    }),
  );

  api.get(
    '/memory/message/:messageId',
    ah(async (req) => {
      const u = user(req);
      const m = st.message(req.params.messageId as string);
      if (!m) throw notFound();
      const t = st.thread(m.thread_id);
      if (!t || t.user_id !== u.id) return { items: [], usage: null, outcomes: [] };
      const items = st.all<any>("SELECT * FROM memory_items WHERE user_id = ? AND source_ref = ? AND status NOT IN ('forgotten') ORDER BY created_at", u.id, m.id).map((r) => {
        const v = svc.view(st.decode('memory_items', r))!;
        const ch = st.one<any>("SELECT id FROM memory_changes WHERE record_id = ? AND op IN ('create','propose') AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1", v.id);
        return { ...v, changeId: ch?.id ?? null };
      });
      const flags = st.one<any>('SELECT flag FROM memory_msg_flags WHERE message_id = ?', m.id);
      let outcomes: any[] = [];
      try {
        outcomes = flags ? JSON.parse(flags.flag).outcomes || [] : [];
      } catch {
        outcomes = [];
      }
      return { items, outcomes };
    }),
  );

  api.get(
    '/memory/refs',
    ah(async (req) => {
      const u = user(req);
      const list = str(req.query.refs, 2000).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40);
      return list.map((s) => {
        const [p, ref] = s.split(':');
        return refBrief(u.id, p, ref);
      });
    }),
  );

  api.get(
    '/memory/by-call/:callId',
    ah(async (req) => {
      const u = user(req);
      const callId = req.params.callId as string;
      const items = st.all<any>('SELECT * FROM memory_items WHERE origin_call_id = ? AND user_id = ?', callId, u.id).map((r) => {
        const v = svc.view(st.decode('memory_items', r))!;
        const ch = st.one<any>("SELECT id FROM memory_changes WHERE record_id = ? AND op IN ('create','propose') AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1", v.id);
        return { ...v, changeId: ch?.id ?? null };
      });
      const records = st.all<any>('SELECT * FROM memory_records WHERE origin_call_id = ? AND user_id = ?', callId, u.id).map((r) => {
        const rec = st.decode<any>('memory_records', r);
        const ch = st.one<any>("SELECT id FROM memory_changes WHERE record_id = ? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1", rec.id);
        return { ...rec, changeId: ch?.id ?? null };
      });
      return { items, records };
    }),
  );

  // ------------------------------------------------------------------ dossiers

  api.get(
    '/memory/dossiers',
    ah(async (req) => {
      const u = user(req);
      return listDossiers(svc, svc.userReader(u.id), { q: req.query.q ? str(req.query.q, 200) : undefined, status: (req.query.status as string) || undefined, teamId: teamFilter(u.id, req.query.teamId) });
    }),
  );

  api.post(
    '/memory/dossiers',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      try {
        // The team: the owner's choice (a team or '*' = alle teams), else the team of the chosen bots, else the default.
        const r = createDossier(svc, u.id, { title: str(b.title, 200), summary: str(b.summary, 4000), kind: b.kind, agentIds: b.agentIds === undefined ? null : b.agentIds, tags: Array.isArray(b.tags) ? b.tags : [], teamId: b.teamId ? str(b.teamId, 80) : null }, { type: 'user', id: u.id });
        return { ...r, dossier: getDossier(svc, svc.userReader(u.id), r.dossier.id)?.dossier };
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );

  // Existing Markdown notes (.md files or a folder of them) as dossiers: preview first (dryRun), then import (A-49).
  api.post(
    '/memory/dossiers/import',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const files = Array.isArray(b.files) ? b.files.map((f: any) => ({ name: str(f?.name, 300), text: typeof f?.text === 'string' ? f.text : '' })) : [];
      try {
        return importMarkdownDossiers(svc, u.id, files, { dryRun: !!b.dryRun, duplicates: b.duplicates === 'rename' ? 'rename' : 'skip' });
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );

  api.get(
    '/memory/dossiers/:id',
    ah(async (req) => {
      const u = user(req);
      const full = getDossier(svc, svc.userReader(u.id), req.params.id as string);
      if (!full) throw notFound('Dossier niet gevonden');
      // 0.4.5: a customer's channel identities and what the bot knows about him (owner only).
      const customer = full.dossier?.role === 'owner' && full.dossier?.kind === 'client' ? customerInfo(svc, u.id, req.params.id as string) : null;
      return customer ? { ...full, customer } : full;
    }),
  );

  api.post(
    '/memory/customers/:identityId/link',
    ah(async (req) => {
      const u = user(req);
      try {
        return { identity: linkIdentity(svc, u.id, req.params.identityId as string, str(req.body?.dossierId, 80)) };
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );

  api.patch(
    '/memory/dossiers/:id',
    ah(async (req) => {
      const u = user(req);
      try {
        updateDossier(svc, u.id, req.params.id as string, req.body || {}, { type: 'user', id: u.id });
      } catch (e: any) {
        throw bad(e.message);
      }
      return getDossier(svc, svc.userReader(u.id), req.params.id as string);
    }),
  );

  api.post(
    '/memory/dossiers/:id/forget',
    ah(async (req) => {
      const u = user(req);
      const d = st.get<any>('memory_dossiers', req.params.id as string);
      if (!d || d.user_id !== u.id) throw notFound('Dossier niet gevonden');
      const receipt = forgetRecord(svc, u.id, d.id, { actor: 'user', actorId: u.id, alsoSource: !!req.body?.alsoSource });
      // "Vergeet deze klant": his channel identities go too (a new contact starts an empty dossier).
      dropIdentities(svc, d.id);
      return receipt;
    }),
  );

  api.post(
    '/memory/dossiers/:id/records',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      try {
        return addRecord(svc, u.id, req.params.id as string, b.kind, { title: str(b.title, 500), body: str(b.body, 4000), occurred_at: b.occurred_at, owner: b.owner, due_at: b.due_at, status: b.status, question: b.question, entity_kind: b.entity_kind, aliases: b.aliases, facts: b.facts, sources: Array.isArray(b.sources) ? b.sources : [], supersedes: b.supersedes }, { type: 'user', id: u.id });
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );

  api.post(
    '/memory/dossiers/:id/sources',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      try {
        return await addSourceAsync(svc, u.id, req.params.id as string, { kind: b.kind, target: b.target, title: b.title, text: b.text, attachmentId: b.attachmentId }, { type: 'user', id: u.id });
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );

  api.post(
    '/memory/dossiers/:id/share',
    ah(async (req) => {
      const u = user(req);
      try {
        return shareDossier(svc, u.id, req.params.id as string, { email: req.body?.email, userId: req.body?.userId, role: req.body?.role, revoke: !!req.body?.revoke });
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );

  api.post(
    '/memory/dossiers/:id/leave',
    ah(async (req) => {
      const u = user(req);
      st.exec('DELETE FROM memory_dossier_acl WHERE dossier_id = ? AND user_id = ?', req.params.id, u.id);
      return { ok: true };
    }),
  );

  api.get(
    '/memory/dossiers/:id/export',
    ah(async (req, res) => {
      const u = user(req);
      const reader = svc.userReader(u.id);
      const full = getDossier(svc, reader, req.params.id as string);
      if (!full) throw notFound('Dossier niet gevonden');
      const name = String(full.dossier!.title).replace(/[^\w-]+/g, '_').slice(0, 60) || 'dossier';
      if (req.query.format === 'json') {
        res.setHeader('content-disposition', `attachment; filename="${name}.json"`);
        res.json({ format: 'teambot.dossier/v1', ...full });
        return;
      }
      res.setHeader('content-type', 'text/markdown; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${name}.md"`);
      res.send(dossierMarkdown(svc, reader, full.dossier!.id));
    }),
  );

  api.patch(
    '/memory/records/:id',
    ah(async (req) => {
      const u = user(req);
      try {
        return updateRecord(svc, u.id, req.params.id as string, req.body || {}, { type: 'user', id: u.id });
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );

  const forgetById = (table: string) =>
    ah(async (req) => {
      const u = user(req);
      const row = st.get<any>(table, req.params.id as string);
      if (!row) throw notFound();
      const role = svc.dossierRole(u.id, row.dossier_id);
      if (row.user_id !== u.id && role !== 'edit') throw notFound();
      try {
        return forgetRecord(svc, u.id, row.id, { actor: 'user', actorId: u.id, alsoSource: !!req.body?.alsoSource });
      } catch (e: any) {
        throw bad(e.message);
      }
    });
  api.post('/memory/records/:id/forget', forgetById('memory_records'));
  api.post('/memory/sources/:id/forget', forgetById('memory_sources'));

  // ------------------------------------------------------------------ episodes

  api.get(
    '/memory/episodes',
    ah(async (req) => {
      const u = user(req);
      const team = teamFilter(u.id, req.query.teamId);
      const eq = team ? svc.teamEq('team_id', u.id, team) : { sql: '1', params: [] };
      const rows = st.all<any>(`SELECT * FROM memory_episodes WHERE user_id = ? AND summary != '' AND ${eq.sql} ORDER BY updated_at DESC LIMIT ?`, u.id, ...eq.params, Math.min(200, Number(req.query.limit) || 50));
      return rows.map((r) => {
        const e = st.decode<any>('memory_episodes', r);
        return { ...e, agent_names: (e.agent_ids || []).map((id: string) => svc.agentName(id)), team: svc.teamTag(u.id, e.team_id ?? null) };
      });
    }),
  );

  api.post(
    '/memory/episodes/:id/forget',
    ah(async (req) => {
      const u = user(req);
      const e = st.get<any>('memory_episodes', req.params.id as string);
      if (!e || e.user_id !== u.id) throw notFound();
      return forgetRecord(svc, u.id, e.id, { actor: 'user', actorId: u.id });
    }),
  );

  // ------------------------------------------------------------------ smart learning, profile, maintenance

  /** How an item was learned, in plain words. */
  const howLearned = (r: MemoryItemRow) => {
    const k = (st.one<any>('SELECT idem_key FROM memory_items WHERE id = ?', r.id)?.idem_key || '') as string;
    if (k.startsWith('x:')) return 'Je vroeg het te onthouden';
    if (k.startsWith('ml:') || k.startsWith('mx:')) return 'Herkend in je bericht (model)';
    if (k.startsWith('h:')) return 'Herkend in je bericht';
    // 0.4.5: learned from the bot's own work in the conversation.
    if (k.startsWith('mb:')) return `Uit het antwoord van ${svc.agentName(r.created_by_agent)}`;
    if (k.startsWith('mt:')) return `Gevonden met een tool door ${svc.agentName(r.created_by_agent)}`;
    if (k.startsWith('imp:')) return 'Geïmporteerd';
    if (r.source_kind === 'consolidation') return 'Samengevoegd';
    if (r.created_by === 'agent') return `Opgeslagen door ${svc.agentName(r.created_by_agent)}`;
    if (r.created_by === 'user') return 'Zelf toegevoegd';
    return 'Systeem';
  };
  // (an approval counts too: "ja, doe maar" on a bot's proposal is undone back to the proposal)
  const lastChange = (id: string) => st.one<any>("SELECT id FROM memory_changes WHERE record_id = ? AND op IN ('create','propose','approve') AND undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1", id)?.id ?? null;
  const learnedView = (r: MemoryItemRow) => {
    const v = svc.view(r)!;
    const prev = r.supersedes_id ? svc.itemRow(r.supersedes_id) : null;
    // A contradiction that waits in Beoordelen: say what it contradicts (A-46).
    const other = r.status === 'proposed' && r.conflict_with ? svc.itemRow(r.conflict_with) : null;
    return {
      ...v,
      how: howLearned(r),
      changeId: lastChange(r.id),
      replaced: prev ? { id: prev.id, ref: prev.ref, content: svc.contentOf(prev), status: prev.status } : null,
      conflict: other && other.status === 'active' ? { id: other.id, ref: other.ref, content: svc.contentOf(other) } : null,
    };
  };

  /** Recently learned (what, when, from where), newest first. */
  api.get(
    '/memory/learned',
    ah(async (req) => {
      const u = user(req);
      const limit = Math.min(100, Number(req.query.limit) || 30);
      const rows = st
        .all<any>("SELECT * FROM memory_items WHERE user_id = ? AND (source_kind = 'message' OR (source_kind = 'tool' AND idem_key LIKE 'mt:%')) AND status IN ('active','proposed','superseded') ORDER BY created_at DESC LIMIT ?", u.id, limit)
        .map((r) => learnedView(st.decode('memory_items', r)));
      const pending = deps.learner.pendingFor(u.id).map((j) => ({ threadId: j.thread_id, title: st.thread(j.thread_id)?.title || 'Gesprek', due_at: j.due_at, status: j.status }));
      return { items: rows, pending };
    }),
  );

  /**
   * Items learned per message of a thread: the undo line under the owner's own message, and (0.4.5) under the bot's
   * answer for what was learned from its work (a fact from a tool result sits under the answer of that turn).
   */
  api.get(
    '/memory/thread/:threadId/learned-map',
    ah(async (req) => {
      const u = user(req);
      const t = ownThread(u.id, req.params.threadId as string);
      const out: Record<string, any[]> = {};
      const answerOf = new Map<string, string | null>();
      for (const r0 of st.all<any>("SELECT * FROM memory_items WHERE user_id = ? AND source_thread_id = ? AND (source_kind = 'message' OR (source_kind = 'tool' AND idem_key LIKE 'mt:%')) AND status NOT IN ('forgotten','rejected') ORDER BY created_at", u.id, t.id)) {
        const r = st.decode<MemoryItemRow>('memory_items', r0);
        if (!r.source_ref) continue;
        let key: string | null = r.source_ref;
        if (r.source_kind === 'tool') {
          if (!answerOf.has(r.source_ref)) {
            const runId = st.one<any>('SELECT run_id FROM messages WHERE id = ? AND thread_id = ?', r.source_ref, t.id)?.run_id;
            answerOf.set(r.source_ref, runId ? st.one<any>("SELECT id FROM messages WHERE run_id = ? AND role = 'assistant' AND deleted = 0 AND content != '' ORDER BY seq DESC LIMIT 1", runId)?.id ?? null : null);
          }
          key = answerOf.get(r.source_ref) ?? null;
        }
        if (key) (out[key] ||= []).push(learnedView(r));
      }
      const job = deps.learner.job(t.id);
      return { byMessage: out, pending: job && job.status !== 'idle' ? { due_at: job.due_at, status: job.status } : null };
    }),
  );

  /**
   * Sources of answers that cite none (A-42: a small local model used "Mijn hond heet Bram" but wrote no [m:…]): per
   * answer the memories from its context that it clearly used. One request per thread; `upto` is the newest message
   * seen, so the page asks again for an answer that came later.
   */
  api.get(
    '/memory/thread/:threadId/answer-sources',
    ah(async (req) => {
      const u = user(req);
      const t = ownThread(u.id, req.params.threadId as string);
      const r = impliedSources(svc, u.id, t.id);
      const out: Record<string, any[]> = {};
      for (const [mid, rows] of Object.entries(r.byMessage)) out[mid] = rows.map((row) => refBrief(u.id, 'm', row.ref, row.id));
      // A document a local model used without citing it (fout 4 of the 0.4 acceptance): its file under the answer too.
      for (const [mid, docs] of Object.entries(r.documents)) out[mid] = [...(out[mid] || []), ...docs.map((d) => refBrief(u.id, 's', d.ref, d.id))];
      return { byMessage: out, upto: r.upto };
    }),
  );

  /** Learn from this conversation now (instead of waiting until it has been quiet). */
  api.post(
    '/memory/thread/:threadId/learn',
    ah(async (req) => {
      const u = user(req);
      const t = ownThread(u.id, req.params.threadId as string);
      const agent = st.agent(req.body?.agentId || t.agent_id);
      if (!agent || agent.user_id !== u.id) throw bad('Geen bot in dit gesprek');
      const r = await deps.learner.learnNow(agent, t);
      return r || { method: 'none', applied: 0, proposed: 0, superseded: 0, dropped: 0 };
    }),
  );

  /** "Wat ik over je weet": what bots know about you, grouped like a profile. */
  api.get(
    '/memory/profile',
    ah(async (req) => {
      const u = user(req);
      const s = svc.userSettings(u.id);
      const rows = st
        .all<any>("SELECT * FROM memory_items WHERE user_id = ? AND scope = 'about_you' AND status = 'active' ORDER BY pinned DESC, COALESCE(last_confirmed_at, updated_at) DESC LIMIT 500", u.id)
        .map((r) => st.decode<MemoryItemRow>('memory_items', r));
      const groups = PROFILE_GROUPS.map((g) => ({ id: g.id, label: g.label, items: [] as any[] }));
      let briefTokens = 0;
      for (const r of rows) {
        const v = learnedView(r);
        const versions = st.one<any>("SELECT COUNT(*) AS n FROM memory_changes WHERE record_id = ? AND op IN ('update','supersede')", r.id)?.n || 0;
        const brief = r.pinned;
        if (brief) briefTokens += estimateTokens(svc.contentOf(r)) + 18;
        groups.find((g) => g.id === profileGroup(r))!.items.push({ ...v, brief, autoBrief: r.flags?.includes('brief'), versions, history: !!r.supersedes_id });
      }
      const proposals = st.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND scope = 'about_you' AND status = 'proposed'", u.id)?.n || 0;
      return { groups: groups.filter((g) => g.items.length), total: rows.length, proposals, brief: { tokens: briefTokens, budget: s.briefTokens, profileCap: s.profileCap } };
    }),
  );

  /** Which engine learns, what it costs (always 0 unless paid use was allowed), latency today. */
  api.get(
    '/memory/engine',
    ah(async (req) => {
      const u = user(req);
      const s = svc.userSettings(u.id);
      const meta = svc.meta(u.id);
      let stats: any = null;
      try {
        stats = meta.learn_stats ? JSON.parse(meta.learn_stats) : null;
      } catch {
        stats = null;
      }
      const day = new Date().toISOString().slice(0, 10);
      const choice = s.extractor === 'heuristic' ? null : await pickEngine(svc, u.id, null, s.extractor === 'model' ? 'model' : 'free').catch(() => null);
      const options = req.query.options === '1' ? await engineOptions(svc, u.id) : undefined;
      const jobs = deps.learner.pendingFor(u.id);
      return {
        extractor: s.extractor,
        engine: choice ? { label: choice.label, billing: choice.billing, model: choice.model, providerId: choice.providerId, backoff: engineBackoff(choice.providerId) } : null,
        options,
        today: stats?.day === day ? { calls: stats.calls, avgMs: stats.calls ? Math.round(stats.ms / stats.calls) : 0, cost: stats.cost, input: stats.input, output: stats.output } : { calls: 0, avgMs: 0, cost: 0, input: 0, output: 0 },
        last: stats?.last || null,
        cap: s.modelDailyCap,
        callsToday: meta.model_day === day ? meta.model_calls || 0 : 0,
        pending: jobs.length,
        lastMaintenanceAt: meta.last_maintenance_at || null,
      };
    }),
  );

  api.post(
    '/memory/maintenance',
    ah(async (req) => {
      const u = user(req);
      const rep = await deps.maintain(u.id, 'manual');
      return { ...rep, summary: summaryText(rep.counts || {}) };
    }),
  );

  api.get(
    '/memory/reports',
    ah(async (req) => {
      const u = user(req);
      const limit = Math.min(50, Number(req.query.limit) || 10);
      // trigger=monthly: the "opruimverslagen"; trigger=maintenance: the nightly and manual ones only.
      const trig = String(req.query.trigger || '');
      const where = trig === 'monthly' ? " AND trigger = 'monthly'" : trig === 'maintenance' ? " AND trigger != 'monthly'" : '';
      return st.all<any>(`SELECT * FROM memory_reports WHERE user_id = ?${where} ORDER BY started_at DESC LIMIT ?`, u.id, limit).map((r) => {
        const v = reportView(svc, r)!;
        const c = v.counts || {};
        return { ...v, summary: v.trigger === 'monthly' ? cleanupText(c) : [summaryText(c), cleanupText({ consolidated: c.consolidated, trashed: c.trashed, refreshed: c.refreshed, check: c.check, confirmed: c.confirmed })].filter(Boolean).join(' · ') };
      });
    }),
  );

  api.post(
    '/memory/reports/:id/undo',
    ah(async (req) => {
      const u = user(req);
      const idx = req.body?.index === undefined || req.body?.index === null ? null : Number(req.body.index);
      try {
        return undoReport(svc, u.id, req.params.id as string, idx);
      } catch (e: any) {
        throw bad(e.message);
      }
    }),
  );

  api.post(
    '/memory/reports/:id/seen',
    ah(async (req) => {
      const u = user(req);
      const r = st.get<any>('memory_reports', req.params.id as string);
      if (!r || r.user_id !== u.id) throw notFound();
      st.update('memory_reports', r.id, { seen_at: now() });
      return { ok: true };
    }),
  );
}
