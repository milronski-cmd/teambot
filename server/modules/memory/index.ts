import fs from 'node:fs';
import path from 'node:path';
import type { Ctx, Module } from '../../core/types.js';
import { memoryMigrations } from './schema.js';
import { MemoryService } from './service.js';
import { buildTurnContext, currentRule, systemPromptText } from './context.js';
import { captureExplicit, keepOrder, writeCandidate } from './pipeline.js';
import { captureConfirmation } from './confirm.js';
import { captureDone, closeFromRun } from './consolidate.js';
import { REREAD_DEBOUNCE_MS, Rereader } from './reread.js';
import { plannerOf, type Planned, type Planner, type PlannerSource } from '../routines/planner.js';
import { excerpt } from './text.js';
import { deleteAllForUser, forgetRecord } from './forget.js';
import { deleteEpisodeForThread, episodeFor, updateEpisode } from './episodes.js';
import { reconcileAll } from './lifecycle.js';
import { Learner, type LearnJob } from './learn.js';
import { pickEngine } from './engine.js';
import { nightlyDue, runMaintenance } from './maintenance.js';
import { exportJson } from './io.js';
import { memoryTools } from './tools.js';
import { memoryRoutes } from './routes.js';
import { assistantImportRoutes } from './assistant-import.js';
import { addRecord, addSourceAsync, createDossier, findDossier, getDossier, listDossiers } from './dossiers.js';
import { itemLine } from './context.js';
import type { Candidate, Reader, Scope } from './types.js';
import { copyTeamKnowledge, fileUnderTeams } from './teams.js';
import { confirmFact, detectReviewKind } from './refresh.js';
import { acceptSubject, dossierNamedIn, subjectProposals } from './dossier-auto.js';
import type { MemoryItemRow } from './types.js';
import { customerDossierOf, customerFactsFor, customerInfo, ensureCustomer, linkIdentity } from './customers.js';
import { retireItem, retiredInDossier, retiredView } from './retire.js';
import { lessonFromReopenedTask } from './lessons.js';
import { doubleReply } from './crosschannel.js';
import { overTarget, targetOf } from './cleanup.js';
import { nextReview } from './types.js';
import { coreContext, coreDossiers, writeBody } from './living.js';
import { moveLooseNotes, moveOnce } from './move.js';


/**
 * Geheugen & dossiers: visible, bounded memory with sources, review queue, versioning/undo, hard forget with
 * tombstones, dossiers (timeline, decisions, actions, people, sources), thread episodes and quotas.
 */
/**
 * After a backup restore: insert the "forget" tombstones that existed before, forget matching records again, and
 * rebuild the derived stores (FTS now; vectors checked against their records, the rest re-embedded in the background).
 * Returns true when a restore was handled.
 */
function reapplyRestoreTombstones(ctx: Ctx): boolean {
  const file = path.join(ctx.config.dataDir, 'restore-tombstones.json');
  if (!fs.existsSync(file)) return false;
  const svc: MemoryService | undefined = ctx.services.memory?.svc;
  try {
    const rows: any[] = JSON.parse(fs.readFileSync(file, 'utf8'));
    let refgotten = 0;
    for (const t of rows) {
      const cols = Object.keys(t);
      ctx.store.exec(`INSERT OR IGNORE INTO memory_tombstones (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => t[c]));
      if (!svc || !t.record_id) continue;
      try {
        const found = svc.resolve(t.user_id, t.record_id);
        if (found && found.row?.status !== 'forgotten') {
          forgetRecord(svc, t.user_id, t.record_id, { actor: 'system', actorId: 'restore', label: t.label || '', reason: 'Opnieuw vergeten na terugzetten van een back-up' });
          refgotten++;
        }
      } catch {
        /* record no longer present */
      }
    }
    fs.rmSync(file, { force: true });
    if (rows.length) ctx.log.info(`[memory] ${rows.length} vergeet-blokkades na terugzetten hersteld, ${refgotten} items opnieuw vergeten`);
  } catch (e) {
    ctx.log.error('[memory] tombstones na terugzetten herstellen mislukt (bestand blijft staan voor een volgende poging)', e);
  }
  try {
    svc?.reindex(undefined, { vectors: 'verify' });
  } catch (e) {
    ctx.log.error('[memory] zoekindex herbouwen na terugzetten mislukt', e);
  }
  return true;
}

/** Memory's source of the one planner, and how to take it away again (per app). */
const SOURCE = 'memory';
const stops = new WeakMap<Ctx, () => void>();
const MODEL_SOURCE = 'memory-model';

/**
 * Does this server fetch the search model (±124 MB) by itself? Not in a test run, and every kind skips it the same
 * way: the unit-test runner (node --test sets NODE_TEST_CONTEXT) and every e2e or trial server started with
 * TEAMBOT_NO_AUTO_DOWNLOAD=1. Switching slim zoeken on by hand still downloads it.
 */
export const fetchesModelBySelf = (env: NodeJS.ProcessEnv = process.env) => !env.NODE_TEST_CONTEXT && env.TEAMBOT_NO_AUTO_DOWNLOAD !== '1';

/**
 * The one download of the built-in search model, as a source of the one planner: the first look two minutes after
 * start, then every hour until it could start. It is in "Wat start vanzelf" (what, how big, when) until then. Not
 * when the owner said "niet nu" or switched slim zoeken off, and only once: a download that started is not repeated.
 */
export function searchModelSource(ctx: Ctx, svc: MemoryService, planner: Planner): PlannerSource {
  const due = (userId?: string) => {
    const owner = ctx.auth.owner();
    const sem = ctx.services.memory?.semantic;
    if (!owner || !sem || (userId && userId !== owner.id)) return null;
    if (ctx.store.getSetting<any>(owner.id, 'memory.builtinOffer', null)) return null;
    if (svc.userSettings(owner.id).semantic === 'off') return null;
    const st = sem.builtinStatus();
    return st.state === 'absent' || st.state === 'error' ? { owner, sem, mb: Math.round((Number(st.bytes) || 0) / 1e6) } : null;
  };
  return {
    id: MODEL_SOURCE,
    everyMs: 3600_000,
    firstMs: 120_000,
    look() {
      try {
        const d = due();
        if (!d) return;
        ctx.store.setSetting(d.owner.id, 'memory.builtinOffer', { at: new Date().toISOString(), action: 'auto' });
        d.sem.enableBuiltin(d.owner.id, (ok: boolean) => ok && svc.emit(d.owner.id, { op: 'semantic' }));
      } catch (e) {
        ctx.log.error('[memory] slim zoeken vanzelf aanzetten mislukt', e);
      }
    },
    planned(userId) {
      const d = due(userId);
      const at = planner.lookAt(MODEL_SOURCE);
      if (!d || at === null) return [];
      return [{ kind: 'download', id: MODEL_SOURCE, userId, agentId: null, title: `Zoekmodel voor slim zoeken downloaden (eenmalig${d.mb ? `, ± ${d.mb} MB` : ''})`, at: new Date(at).toISOString(), model: false, link: '#/m/memory/opslag' }];
    },
  };
}

const mod: Module = {
  id: 'memory',
  label: 'Geheugen & dossiers',
  migrations: memoryMigrations,

  init(ctx) {
    const svc = new MemoryService(ctx);
    // 0.4.5: who is writing on a channel decides which customer's dossier a thread may read (customers.ts).
    svc.customerDossierOf = (thread) => customerDossierOf(svc, thread);
    const learner = new Learner(svc);
    // 0.4.4: a dossier whose content changed is read again against its facts (reread.ts).
    const rereader = new Rereader(svc);
    /** Maintenance runs in flight (one per user). */
    const maint = new Map<string, Promise<any>>();
    const maintain = (userId: string, trigger: 'nightly' | 'manual') => {
      const cur = maint.get(userId);
      if (cur) return cur;
      const p = runMaintenance(svc, userId, { trigger }).finally(() => maint.delete(userId));
      maint.set(userId, p);
      return p;
    };

    ctx.tools.registerGroup({ id: 'memory', label: 'Geheugen', description: 'Herinneringen en dossiers lezen en bijwerken (met bronnen, review en vergeten)', defaultOn: true });
    // Static registration (tool catalogue, any caller without agent context) + per-agent versions with detailed approval cards.
    for (const t of memoryTools(svc)) ctx.tools.register(t);
    ctx.tools.addProvider((agent, thread) => (ctx.tools.groupEnabled(agent, 'memory') ? memoryTools(svc, { agent, thread }) : []));

    ctx.hooks.systemPrompt.push(({ agent, thread }) => systemPromptText(svc, agent, thread));
    // Every bot, also one without memory: check what changes over time against a current source.
    ctx.hooks.systemPrompt.push(({ agent }) => currentRule(svc, agent));
    ctx.hooks.turnContext.push(({ agent, thread, input }) => buildTurnContext(svc, agent, thread, input));
    ctx.hooks.messageCreated.push(({ message, thread }) => {
      try {
        // "Ja, doe maar" on the bot's memory proposal first; "gedaan" right after the bot named an open task closes
        // it; otherwise "onthoud dat …" / "niet onthouden" / "vergeet …".
        if (!captureConfirmation(svc, message, thread) && !captureDone(svc, message, thread)) captureExplicit(svc, message, thread);
      } catch (e) {
        ctx.log.error('[memory] explicit capture failed', e);
      }
      // The owner sent work back that a bot reported as done: a lesson for that bot's team (lessons.ts).
      if ((message.parts as any)?.kind === 'task_reopened') void lessonFromReopenedTask(svc, message, thread).catch((e) => ctx.log.warn('[memory] les uit teruggestuurde taak mislukt', e?.message || e));
      // 0.4.5: a customer writing on a channel in customer mode is identified (and gets his dossier) on first contact.
      if (message.author_type === 'external' && thread.kind === 'channel') {
        try {
          ensureCustomer(svc, thread, message);
        } catch (e: any) {
          ctx.log.warn('[memory] klant herkennen mislukt', e?.message || e);
        }
      }
    });
    ctx.hooks.afterRun.push(async ({ agent, thread, run, finalText }) => {
      const eff = svc.effective(agent);
      if (!eff.enabled) return;
      // 0.4.5: a customer conversation is learned from the customer's own words (customer-learn.ts), after it goes quiet.
      if (eff.learn !== 'off' && svc.audience(thread, thread.user_id) === 'customer') learner.touch(agent, thread);
      // The conversation is queued for the one background review (learn.ts): no model call now. The episode is kept
      // up to date cheaply after every run.
      learner.afterRun(agent, thread, run);
      if (eff.episodes) updateEpisode(svc, agent, thread);
      // 0.4.4: a bot or routine that reports work as done (with evidence: it used a tool, or the routine finished)
      // closes the open task or dossier action about it.
      try {
        closeFromRun(svc, agent, thread, run, finalText || '');
      } catch (e: any) {
        ctx.log.warn('[memory] afgerond werk verwerken mislukt', e?.message || e);
      }
      // The same customer answered on two channels: a mistake the team learns from (crosschannel.ts).
      if (thread.kind === 'channel' && finalText) {
        try {
          await doubleReply(svc, agent, thread, svc.store.message(run.input_message_id), finalText);
        } catch (e: any) {
          ctx.log.warn('[memory] dubbel antwoord herkennen mislukt', e?.message || e);
        }
      }
    });
    ctx.hooks.agentDeleted.push(({ agentId, userId }) => {
      try {
        ctx.store.tx(() => {
          // The bot's own working notes go with it: the dossier and the notes in it, to the bin (restorable for a while).
          const own = ctx.store.all<any>("SELECT id FROM memory_dossiers WHERE user_id = ? AND core = 'notes' AND created_by_agent = ? AND status IN ('active','closed')", userId, agentId).map((d) => d.id);
          for (const r of ctx.store.all<any>("SELECT id FROM memory_items WHERE user_id = ? AND scope = 'agent' AND agent_id = ? AND status IN ('active','proposed','archived')", userId, agentId)) {
            const before = svc.snapshot('item', r.id);
            svc.patchItem(r.id, { status: 'trashed', trashed_at: new Date().toISOString(), pinned: false });
            svc.recordChange({ userId, kind: 'item', recordId: r.id, op: 'trash', before, after: svc.snapshot('item', r.id), summary: `Naar prullenbak (bot verwijderd): ${svc.label(before)}`, actor: 'system' });
          }
          for (const id of own) {
            const before = svc.snapshot('dossier', id);
            ctx.store.update('memory_dossiers', id, { status: 'trashed', trashed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
            svc.syncIndex('dossier', id);
            svc.recordChange({ userId, kind: 'dossier', recordId: id, dossierId: id, op: 'trash', before, after: svc.snapshot('dossier', id), summary: `Naar prullenbak (bot verwijderd): “${before?.title || 'Werknotities'}”`, actor: 'system' });
          }
          for (const t of ctx.store.all<any>('SELECT id FROM threads WHERE agent_id = ? AND room_id IS NULL', agentId)) {
            deleteEpisodeForThread(svc, t.id);
            ctx.store.exec('DELETE FROM memory_usage WHERE thread_id = ?', t.id);
            ctx.store.exec('DELETE FROM memory_links WHERE thread_id = ?', t.id);
          }
          for (const d of ctx.store.all<any>('SELECT id, agent_ids FROM memory_dossiers WHERE user_id = ? AND agent_ids IS NOT NULL', userId)) {
            const ids: string[] = JSON.parse(d.agent_ids || '[]');
            if (ids.includes(agentId)) ctx.store.update('memory_dossiers', d.id, { agent_ids: ids.filter((x) => x !== agentId) });
          }
        });
        svc.emit(userId, { op: 'agent_deleted', agentId });
      } catch (e) {
        ctx.log.error('[memory] agentDeleted cleanup failed', e);
      }
    });
    // A deleted conversation, or one emptied by "Geschiedenis wissen" (a group keeps its own conversation): its
    // summary, learning queue and usage go with it. The dossier link of an emptied conversation stays (setup).
    const threadGone = (id: string, emptied: boolean) => {
      try {
        deleteEpisodeForThread(svc, id);
        learner.forgetThread(id);
        ctx.store.exec('DELETE FROM memory_usage WHERE thread_id = ?', id);
        if (!emptied) ctx.store.exec('DELETE FROM memory_links WHERE thread_id = ?', id);
        ctx.store.exec('DELETE FROM memory_rollups WHERE thread_id = ?', id);
      } catch (err) {
        ctx.log.error('[memory] thread cleanup failed', err);
      }
    };
    // (one event per audience member: the cleanup is idempotent)
    ctx.events.on('thread.deleted', (e) => e.data?.id && threadGone(e.data.id, false));
    ctx.events.on('thread.cleared', (e) => e.data?.id && threadGone(e.data.id, true));
    // Teams changed (the first team appeared, a team was added …): memory without a team is filed under a real team
    // right away, so it never moves when the owner reorders his teams.
    ctx.events.on('teams.changed', (e) => {
      try {
        if (e.userId) fileUnderTeams(svc, e.userId);
      } catch (err) {
        ctx.log.error('[memory] geheugen bij een team zetten mislukt', err);
      }
    });

    // Memory from ChatGPT, Claude or Gemini: preview, import as proposals, undo (0.4.4; before the general routes).
    assistantImportRoutes(ctx, svc);
    memoryRoutes(ctx, svc, { learner, maintain });

    // Service for other modules (rooms, routines, channels, ...). Always check ctx.services.memory?.x before use.
    const readerFor = (userId: string, agentId?: string | null): Reader => {
      const a = agentId ? ctx.store.agent(agentId) : null;
      return a && a.user_id === userId ? svc.readerFor(a, null) : svc.userReader(userId);
    };
    /** Writing in a dossier on behalf of a bot (a module, a specialist's learning round): the bot's team walls apply. */
    const asBot = (userId: string, dossierId: string, agentId?: string | null) => {
      const a = agentId ? ctx.store.agent(agentId) : null;
      if (!a || a.user_id !== userId) return { type: 'user' as const, id: userId };
      const refusal = svc.dossierWriteRefusal(a, dossierId);
      if (refusal) throw new Error(refusal);
      return { type: 'agent' as const, id: a.id };
    };
    ctx.services.memory = {
      svc,
      /** Ranked items the user (or one of their bots) may read, by words (synchronous). */
      search(userId: string, query: string, o: { agentId?: string | null; scope?: Scope; limit?: number } = {}) {
        return svc.searchItems(readerFor(userId, o.agentId), query, { limit: o.limit || 10, scope: o.scope }).map((h) => ({ ...svc.view(h.row), score: h.score }));
      },
      /** The same, by words and by meaning when a local embedding model is available. */
      async searchAsync(userId: string, query: string, o: { agentId?: string | null; scope?: Scope; limit?: number } = {}) {
        return (await svc.searchItemsAsync(readerFor(userId, o.agentId), query, { limit: o.limit || 10, scope: o.scope })).map((h) => ({ ...svc.view(h.row), score: h.score, meaning: !!h.meaning }));
      },
      semantic: svc.semantic,
      /** Store a memory through the full pipeline (dedup, conflicts, review rules, quotas). */
      // (On behalf of a bot — agentId — its team walls apply: shared knowledge goes to its home team, a dossier must
      // be one of its home team's.)
      remember(userId: string, c: Partial<Candidate> & { content: string; scope?: Scope; module?: string }) {
        return writeCandidate(svc, {
          userId,
          content: c.content,
          scope: c.scope || (c.agentId ? 'agent' : 'shared'),
          agentId: c.agentId ?? null,
          dossierId: c.dossierId ?? null,
          teamId: c.teamId ?? null,
          type: c.type,
          key: c.key,
          sensitivity: c.sensitivity,
          source: c.source || { kind: 'tool', ref: c.module || 'module', trust: 'system' },
          origin: 'service',
          createdBy: c.createdBy || 'system',
          createdByAgent: c.createdByAgent ?? c.agentId ?? null,
          idemKey: c.idemKey ?? null,
          forcePropose: c.forcePropose,
          proposalReason: c.proposalReason,
          expiresAt: c.expiresAt,
          // The note this one replaces (same subject, newer): the old version goes to the history, never next to it.
          replacesId: c.replacesId ?? null,
          compared: c.compared,
          reviewKind: c.reviewKind,
          reviewEveryDays: c.reviewEveryDays,
          observedAt: c.observedAt,
          runId: c.runId ?? null,
          flags: c.flags,
        });
      },
      /**
       * What the owner told one bot (a correction of its work, an order): in that bot's working notes under "Opdrachten
       * van de eigenaar", its one place (pipeline.ts keepOrder). Null: no such bot of this owner.
       */
      ownOrder(userId: string, agentId: string, content: string, o: { threadId: string; messageId: string; excerpt?: string; idemKey: string }) {
        const a = ctx.store.agent(agentId);
        return a && a.user_id === userId ? keepOrder(svc, a, content, o) : null;
      },
      forget(userId: string, ref: string, o: { alsoSource?: boolean; actorId?: string } = {}) {
        return forgetRecord(svc, userId, ref, { actor: 'system', actorId: o.actorId || 'service', alsoSource: o.alsoSource });
      },
      /** Undo one change (or its batch) as the owner, like Geheugen › Geschiedenis (used by specialists' reports). */
      undo: (userId: string, changeId: string) => svc.undo(userId, changeId, userId),
      /** A bounded memory block for custom prompts (e.g. a room or routine building its own context). Async. */
      async context(userId: string, agentId: string, threadId: string, text: string) {
        const agent = ctx.store.agent(agentId);
        const thread = ctx.store.thread(threadId);
        if (!agent || !thread || agent.user_id !== userId) return null;
        return buildTurnContext(svc, agent, thread, { id: '', content: text } as any);
      },
      formatItem: (row: any) => itemLine(svc, row),
      episode: (threadId: string) => episodeFor(svc, threadId),
      /**
       * Memory per customer (0.4.5). `customerDossierFor`: the dossier of the identified customer of a channel thread
       * (or null); `customerFacts`: the C-lines the bot was given in that thread's turn, for the draft check (they back
       * numbers and citations, never policy).
       */
      customerDossierFor: (threadId: string) => customerDossierOf(svc, ctx.store.thread(threadId)),
      customerFacts: (threadId: string, messageId?: string | null) => customerFactsFor(svc, threadId, messageId),
      customers: {
        info: (userId: string, dossierId: string) => customerInfo(svc, userId, dossierId),
        link: (userId: string, identityId: string, dossierId: string) => linkIdentity(svc, userId, identityId, dossierId),
      },
      dossiers: {
        list: (userId: string, agentId?: string | null) => listDossiers(svc, readerFor(userId, agentId)),
        get: (userId: string, id: string, agentId?: string | null) => getDossier(svc, readerFor(userId, agentId), id),
        find: (userId: string, input: string, agentId?: string | null) => findDossier(svc, readerFor(userId, agentId), input),
        /**
         * A new dossier. For a bot (`agentId`, e.g. a specialist's knowledge base) it lands in that bot's home team and
         * is first for that bot only; `agentIds` (the first bot's team) or `teamId` (a team or '*') otherwise; else
         * the default team.
         */
        create: (userId: string, o: { title: string; summary?: string; kind?: string; agentIds?: string[] | null; agentId?: string | null; teamId?: string | null; tags?: string[] }) => createDossier(svc, userId, o, { type: 'user', id: userId }),
        addEvent: (userId: string, dossierId: string, r: any, agentId?: string) => addRecord(svc, userId, dossierId, 'event', r, asBot(userId, dossierId, agentId)),
        addDecision: (userId: string, dossierId: string, r: any, agentId?: string) => addRecord(svc, userId, dossierId, 'decision', r, asBot(userId, dossierId, agentId)),
        addAction: (userId: string, dossierId: string, r: any, agentId?: string) => addRecord(svc, userId, dossierId, 'action', r, asBot(userId, dossierId, agentId)),
        /** A source (url, pasted text) for a dossier, searchable by words and meaning; on behalf of a bot: its walls. */
        addSource: (userId: string, dossierId: string, o: { kind: string; target?: string; title?: string; text?: string; attachmentId?: string }, agentId?: string) => addSourceAsync(svc, userId, dossierId, o, asBot(userId, dossierId, agentId)),
      },
      /**
       * "Vakkennis meenemen": copy a team's dossiers and shared knowledge to another team of the same owner (never
       * personal memory, bot notes, summaries or anything personal/sensitive). See teams.ts.
       */
      copyTeamKnowledge: (userId: string, fromTeamId: string, toTeamId: string, o: { agentMap?: Record<string, string> | null } = {}) => copyTeamKnowledge(svc, userId, fromTeamId, toTeamId, o),
      /** The team of a bot note, shared knowledge or dossier note as stored (null = personal or no teams). */
      teamOfItem: (id: string) => {
        const r = svc.itemRow(id);
        return r ? svc.itemTeam(r) : null;
      },
      /** Living dossiers (living.ts): what a bot always reads, and writing a dossier's text on behalf of a module. */
      living: {
        context: (agentId: string, threadId?: string | null) => {
          const a = ctx.store.agent(agentId);
          return a ? coreContext(svc, a, threadId ? ctx.store.thread(threadId) : null) : null;
        },
        core: (agentId: string) => {
          const a = ctx.store.agent(agentId);
          return a ? coreDossiers(svc, a) : [];
        },
        write: (dossierId: string, body: string, actor: { type: 'user' | 'agent' | 'system'; id: string }) => writeBody(svc, dossierId, body, actor),
        move: (userId: string) => moveLooseNotes(svc, userId),
      },
      /** Included in the full account export (GET /api/export). */
      exportUser: (userId: string) => ({ memory: exportJson(svc, userId) }),
      deleteUser: (userId: string) => deleteAllForUser(svc, userId, { keepBlocks: false }),
      /** Test/diagnostic hook: run pending learning jobs now (ignoring the quiet period) and wait for them. */
      drain: async () => {
        await learner.flush();
        await rereader.tick(true);
        await Promise.all([...maint.values()]);
        await svc.semantic.drain();
      },
      learner,
      rereader,
      maintain,
      /** What kind of changing fact a text is (price, version, rule …), or null: its review rhythm. */
      reviewKindOf: (text: string) => detectReviewKind(text, 'fact'),
      /** Still true (a module re-read the source): confirmed now, the next review date of its rhythm. */
      confirm(userId: string, id: string, why: string): string | null {
        const row = svc.itemRow(id);
        if (!row || row.user_id !== userId || row.status !== 'active') return null;
        return ctx.store.tx(() => confirmFact(svc, row, why, { type: 'system' }));
      },
      /**
       * Could not be checked now (the source did not answer): looked at again after its rhythm, without calling it
       * confirmed — "laatst bevestigd" stays honest, and what is never confirmed loses its place to fresher knowledge.
       */
      postponeReview(userId: string, id: string): boolean {
        const row = svc.itemRow(id);
        if (!row || row.user_id !== userId || row.status !== 'active') return false;
        svc.patchItem(id, { review_at: nextReview(row.review_every_days || 30) } as any);
        return true;
      },
      /**
       * Retire a practice or fact that no longer holds and has no successor: out of the active set with the reason and
       * the date, and from then on given to the bots as "niet meer doen, omdat …" (retire.ts). One undo.
       */
      retire(userId: string, ref: string, o: { reason: string; actor?: 'user' | 'agent' | 'system'; actorId?: string | null }) {
        const found = svc.resolve(userId, ref);
        const row = found?.kind === 'item' ? (found.row as MemoryItemRow) : svc.itemRow(ref);
        if (!row || row.user_id !== userId) throw new Error('Herinnering niet gevonden');
        const r = retireItem(svc, row, { reason: o.reason, actor: o.actor || 'system', actorId: o.actorId ?? null });
        return { changeId: r.changeId, item: svc.view(r.item) };
      },
      /** What was retired in one dossier (a specialist's knowledge base), newest first. */
      retired: (userId: string, dossierId: string, limit?: number) => retiredInDossier(svc, userId, dossierId, limit).map((r) => retiredView(svc, r)),
      /** How full one dossier is: active notes against its target size (maintenance keeps it at or under the target). */
      dossierSize(userId: string, dossierId: string): { active: number; target: number } {
        const active = ctx.store.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND dossier_id = ? AND status = 'active'", userId, dossierId)?.n || 0;
        return { active, target: targetOf(svc, userId, 'dossier', dossierId) };
      },
      /** Facts whose review date came (optionally of one dossier): for other modules that can re-check a source. */
      dueFacts(userId: string, o: { dossierId?: string | null; limit?: number } = {}) {
        return ctx.store
          .all<any>(`SELECT * FROM memory_items WHERE user_id = ? AND status = 'active' AND review_at IS NOT NULL AND review_at <= ?${o.dossierId ? ' AND dossier_id = ?' : ''} ORDER BY review_at LIMIT ?`, userId, new Date().toISOString(), ...(o.dossierId ? [o.dossierId] : []), Math.min(200, o.limit || 50))
          .map((r) => svc.view(ctx.store.decode('memory_items', r)));
      },
      /** The one dossier of a bot's team a text names (title or tag as whole words), or null. */
      dossierFor: (userId: string, agentId: string, text: string) => {
        const a = ctx.store.agent(agentId);
        return a && a.user_id === userId ? dossierNamedIn(svc, a, text) : null;
      },
      dossierProposals: (userId: string) => subjectProposals(svc, userId),
      acceptDossierProposal: (userId: string, id: string) => acceptSubject(svc, userId, id, { type: 'user', id: userId }),
    };
    /**
     * One look at who needs maintenance (the planner's look, every ten minutes): at night as always, and during the day as soon as a part
     * is clearly over its budget (at most one run per six hours), so memory stays bounded however much comes in.
     * Returns the users a run was started for.
     */
    ctx.services.memory.maintenanceTick = (nowMs = Date.now()): string[] => {
      const started: string[] = [];
      reconcileAll(svc);
      const users = svc.store.all<any>("SELECT DISTINCT user_id FROM memory_items WHERE status = 'active' UNION SELECT DISTINCT user_id FROM memory_episodes").map((r) => r.user_id);
      for (const u of users) {
        // After "Alles stoppen" it waits for his next turn (routines/planner.ts: held); then it comes at the next look.
        if (plannerOf(ctx)?.held(u)) continue;
        const last = Date.parse(svc.meta(u).last_maintenance_at || '') || 0;
        const s = svc.userSettings(u);
        if (!nightlyDue(svc, u, new Date(nowMs)) && !(s.nightly && !s.paused && nowMs - last > 6 * 3600e3 && overTarget(svc, u))) continue;
        started.push(u);
        void maintain(u, 'nightly').catch((e) => ctx.log.error('[memory] onderhoud mislukt', e));
      }
      return started;
    };
  },

  start(ctx) {
    reapplyRestoreTombstones(ctx);
    const svc: MemoryService | undefined = ctx.services.memory?.svc;
    if (svc) {
      // Update from 0.3: everything in memory goes into the default team "Mijn team" (teams made it at init), with the
      // same visibility as before. Then: duplicating a team copies memory only with "vakkennis meenemen".
      try {
        const n = fileUnderTeams(svc);
        if (n) ctx.log.info(`[memory] ${n} herinneringen, dossiers en samenvattingen bij hun team gezet`);
      } catch (e) {
        ctx.log.error('[memory] geheugen bij een team zetten mislukt', e);
      }
      // One write path: notes that are not in a dossier yet move into one, once (no model; one undo brings them back).
      moveOnce(svc);
      ctx.services.teams?.registerCopier?.('memory', (o: { userId: string; fromTeamId: string; toTeamId: string; knowledge?: boolean; agentMap?: Record<string, string> }) =>
        o.knowledge === true ? copyTeamKnowledge(svc, o.userId, o.fromTeamId, o.toTeamId, { agentMap: o.agentMap }) : null,
      );
    }
    // No clock of its own: memory is a source of the one planner (routines/planner.ts). What has a moment is an event
    // that asks for a look — a turn that ended (its conversation is read when it has gone quiet), a dossier that
    // changed (read again after a moment) — and the look every ten minutes does what only time brings: notes that
    // expired, the bin, the nightly tidy-up. A look costs no model call unless something changed since the last one.
    const mem = ctx.services.memory;
    const planner = plannerOf(ctx);
    if (svc && mem && planner) {
      const wake = (afterMs: number) => planner.kick(SOURCE, afterMs);
      mem.learner.wake = wake;
      svc.onDossierChanged = () => wake(REREAD_DEBOUNCE_MS + 1000);
      stops.set(
        ctx,
        planner.register({
          id: SOURCE,
          everyMs: 600_000,
          async look(at) {
            try {
              mem.maintenanceTick(at);
            } catch (e) {
              ctx.log.error('[memory] onderhoudsplanner mislukt', e);
            }
            await mem.learner.runDue(false, at);
            await mem.rereader.tick();
            void mem.semantic.run();
            const next = mem.learner.soonest();
            if (next !== null) wake(Math.max(0, next - at));
          },
          // What will start by itself: the conversations that wait to be read, one model call each — listed only
          // when there is an engine to read them with (without one nothing starts).
          async planned(userId: string): Promise<Planned[]> {
            const out: Planned[] = [];
            for (const j of mem.learner.pendingFor(userId).filter((x: LearnJob) => x.status === 'pending') as LearnJob[]) {
              const bot = j.agent_id ? ctx.store.agent(j.agent_id) : null;
              const eff = bot ? svc.effective(bot) : null;
              if (!bot || !eff || !eff.enabled || eff.learn !== 'auto' || eff.extractor === 'heuristic') continue;
              if (!(await pickEngine(svc, userId, bot, eff.extractor === 'model' ? 'model' : 'free').catch(() => null))) continue;
              // The chat's title is the owner's (or a bot's) words: a value, shown as written in every language.
              const name = excerpt(ctx.store.thread(j.thread_id)?.title || '', 40);
              const words = name ? { text: 'Gesprek “{0}” nalezen voor het geheugen', values: [name] } : { text: 'Gesprek zonder titel nalezen voor het geheugen' };
              out.push({ kind: 'learning', id: `review:${j.thread_id}`, userId, agentId: j.agent_id, title: `Gesprek “${name || 'zonder titel'}” nalezen voor het geheugen`, words, at: j.due_at, model: true, link: '#/m/memory/pas-geleerd' });
            }
            return out;
          },
          // "Alles stoppen": the conversations that wait are not read by themselves (the next turn in one reads it).
          stop: (userId) => mem.learner.stop(userId),
        }),
      );
      mem.learner.start();
    }
    ctx.services.memory?.semantic?.start();
    // Slim zoeken without a question (owner: "mensen moeten zelf niet te veel moeten instellen, liefst niks"): on a
    // desktop install the built-in search model is fetched by itself, once. Not on a shared server, not in tests.
    if (svc && planner && ctx.config.mode === 'desktop' && fetchesModelBySelf()) {
      const off = planner.register(searchModelSource(ctx, svc, planner));
      const before = stops.get(ctx);
      stops.set(ctx, () => (before?.(), off()));
    }
  },

  stop(ctx) {
    stops.get(ctx)?.();
    stops.delete(ctx);
    ctx.services.memory?.semantic?.stop();
  },
};

export default mod;
