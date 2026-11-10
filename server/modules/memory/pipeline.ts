/**
 * Write pipeline (plan §13 steps 1–10): capture → classify → intent check → normalise/dedup → conflict handling →
 * decide (reject / propose / insert / supersede) → transactional write with version + change record → verify → notify.
 * Background reconciliation lives in lifecycle.ts.
 */
import type { Agent, Message, Run, Thread } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { budgetOf, spentToday } from '../../agent/budget.js';
import type { MemoryService } from './service.js';
import type { Candidate, ItemType, MemoryItemRow, Outcome, Scope } from './types.js';
import { ALL_TEAMS, ITEM_TYPES, REVIEW_KINDS, SCOPES, SENSITIVITIES, nextReview, reviewInterval } from './types.js';
import { detectReviewKind } from './refresh.js';
import { consolidateNow, doneSignal, isOpenTodo } from './consolidate.js';
import {
  canonicalKey,
  clean,
  detectSecret,
  detectSensitivity,
  excerpt,
  explicitIntent,
  firstPerson,
  guessKey,
  guessType,
  heuristicFacts,
  isCorrection,
  isInjectionLike,
  isInstructionLike,
  maxSensitivity,
  normalize,
  ownWords,
  wantsAllTeams,
  wantsShared,
} from './text.js';

const CONFIDENCE: Record<string, number> = { user: 0.95, import: 0.7, agent: 0.7, system: 0.8, external: 0.4, customer: 0.8 };
/** How much a source counts when two notes about the same subject disagree (the owner's own words always win). */
const TRUST_RANK: Record<string, number> = { user: 4, system: 3, import: 3, agent: 2, customer: 2, external: 1 };

function fail(action: Outcome['action'], reason: string, message: string, existing?: any): Outcome {
  return { action, reason, message, item: null, existing: existing ?? null };
}

/**
 * A full quota. What the user saves himself (memory page, "onthoud …" in the chat) or imports shows this message
 * where he did it; anything learned or saved without him watching (automatic learning, a bot's tool, other modules)
 * also tells him in a notification, so nothing is lost silently (A-46).
 */
function quotaFull(svc: MemoryService, c: Candidate, bucket: { user_id: string; scope: string; agent_id?: string | null; dossier_id?: string | null }, message: string): Outcome {
  // (Not for the cap on open proposals: those wait in "Te beoordelen", which has its own notice.)
  if (!['user_ui', 'explicit', 'import'].includes(c.origin) && svc.quotaProblem(bucket, Buffer.byteLength(clean(c.content)), false)) svc.quotaFullNotice(bucket);
  return fail('quota', 'quota', message);
}

/** Run one candidate through the pipeline. Always transactional and idempotent (idemKey). */
export function writeCandidate(svc: MemoryService, c: Candidate): Outcome {
  const ctx = svc.ctx;
  const content = clean(c.content);
  if (content.length < 2) return fail('invalid', 'empty', 'Niets om op te slaan.');
  if (!SCOPES.includes(c.scope)) return fail('invalid', 'scope', 'Onbekende geheugenplek.');

  // 1. Secrets never enter memory — not even as a proposal or in history.
  const secret = detectSecret(content);
  if (secret) {
    ctx.audit(c.userId, 'memory.secret_rejected', { scope: c.scope, kind: secret }, c.createdByAgent ?? null);
    return fail('rejected', 'secret', `Niet opgeslagen: dit lijkt op een ${secret}. Bewaar geheimen in Instellingen › Beveiliging › Opgeslagen geheimen, nooit in het geheugen.`);
  }

  // Resolve the bucket (owner, bot, dossier, team) and check write access.
  let ownerId = c.userId;
  let agentId: string | null = null;
  let dossierId: string | null = null;
  // A bot writes (itself, or a module/the learner on its behalf): only in its home team (teams 0.4 B).
  const writer = c.createdBy !== 'user' && c.createdByAgent ? ctx.store.agent(c.createdByAgent) : null;
  const botWriter = writer && writer.user_id === c.userId ? writer : null;
  let teamId: string | null = null;
  if (c.scope === 'agent') {
    const a = ctx.store.agent(c.agentId);
    if (!a || a.user_id !== c.userId) return fail('invalid', 'agent', 'Bot niet gevonden.');
    agentId = a.id;
    teamId = svc.homeTeam(a);
  } else if (c.scope === 'dossier') {
    const role = svc.dossierRole(c.userId, c.dossierId);
    if (!role || role === 'read') return fail('invalid', 'dossier', 'Dossier niet gevonden of alleen-lezen.');
    const d = ctx.store.get<any>('memory_dossiers', c.dossierId!);
    if (!d || !['active', 'closed'].includes(d.status)) return fail('invalid', 'dossier', 'Dit dossier is gearchiveerd of verwijderd.');
    const refusal = botWriter ? svc.dossierWriteRefusal(botWriter, d.id) : null;
    if (refusal) return fail('invalid', 'team', refusal);
    ownerId = d.user_id;
    dossierId = d.id;
  } else if (c.scope === 'shared') {
    // Shared knowledge is per team: a bot's goes to its home team; the owner chooses a team or "alle teams" (teamId),
    // and his "onthoud voor alle bots" in a bot's chat goes to that bot's team. Without a choice: the default team.
    if (botWriter) teamId = svc.homeTeam(botWriter);
    else if (c.teamId) {
      if (!svc.validTeam(c.userId, c.teamId)) return fail('invalid', 'team', 'Onbekend team.');
      teamId = c.teamId;
    } else if (c.agentId) teamId = svc.homeTeam(c.agentId);
  }

  // A new version stays in the team of the note it replaces (memory_update of knowledge the writer may write).
  if (c.replacesId && (c.scope === 'agent' || c.scope === 'shared')) {
    const old = svc.itemRow(c.replacesId);
    if (old && old.user_id === ownerId && old.scope === c.scope && (old.agent_id ?? null) === agentId) teamId = old.team_id ?? null;
  }

  // Idempotency: the same capture (message, tool call, import line) never writes twice.
  if (c.idemKey) {
    const prev = ctx.store.one<any>('SELECT * FROM memory_items WHERE user_id = ? AND idem_key = ?', ownerId, c.idemKey);
    if (prev) return { action: 'duplicate', reason: 'idempotent', message: 'Al verwerkt.', item: svc.view(ctx.store.decode('memory_items', prev)) };
  }

  // 2. Classify.
  const guess = guessKey(content);
  const type: ItemType = c.type && ITEM_TYPES.includes(c.type) ? c.type : guess.type || guessType(content);
  const key = c.key !== undefined && c.key !== null && String(c.key).trim() ? clean(String(c.key), 80) : guess.key;
  const sensitivity = maxSensitivity(c.sensitivity && SENSITIVITIES.includes(c.sensitivity) ? c.sensitivity : 'normal', detectSensitivity(content));
  const flags = new Set(c.flags || []);
  if (isInstructionLike(content) || type === 'instruction') flags.add('instruction');
  if (isInjectionLike(content)) flags.add('injection');
  if (c.source.trust === 'external') flags.add('external');
  const confidence = Math.max(0, Math.min(1, c.confidence ?? CONFIDENCE[c.source.trust] ?? 0.7));

  // External / agent-sourced text that tries to steer the agent (exfiltration, overrides) is refused outright; so is
  // such text from a customer (0.4.5) and text the learner found in a bot's reply or a tool result (0.4.5).
  const fromWork = c.learned === 'bot' || c.learned === 'tool';
  if (flags.has('injection') && (c.source.trust === 'external' || c.source.trust === 'customer' || flags.has('tainted') || fromWork)) {
    ctx.audit(c.userId, 'memory.injection_rejected', { scope: c.scope, origin: c.origin }, c.createdByAgent ?? null);
    return fail('rejected', 'injection', 'Niet opgeslagen: dit lijkt op een instructie uit een externe bron (mogelijke prompt-injectie). Externe inhoud is data, geen opdracht.');
  }

  // 3. Intent / blocks: a forget-tombstone is a hard block; a recent rejection suppresses re-proposals.
  if (!c.overrideBlock) {
    const tomb = svc.blockedBy(ownerId, content, key, ['forget']);
    if (tomb) return fail('blocked', 'forgotten', 'Niet opgeslagen: dit is eerder op verzoek vergeten. De gebruiker kan de blokkade opheffen in Geheugen › Geschiedenis › Blokkades.');
    if (!['explicit', 'user_ui'].includes(c.origin) && !c.userApproved) {
      const rej = svc.blockedBy(ownerId, content, null, ['reject']);
      if (rej) return fail('suppressed', 'rejected_before', 'Niet voorgesteld: de gebruiker heeft dit eerder afgewezen.');
    }
  }

  const bucket = { scope: c.scope, agent_id: agentId, dossier_id: dossierId, team_id: teamId };
  const hash = svc.contentHash(ownerId, content);
  // A fact that changes over time (price, version, rule, agreement, opening hours, contact) gets a review date.
  const reviewKind = c.reviewKind !== undefined && c.reviewKind !== null ? c.reviewKind : detectReviewKind(content, type);
  // Keywords/synonyms for word search; never for sensitive memories (they would be a readable copy).
  const terms = sensitivity === 'sensitive' ? null : c.terms?.length ? c.terms : null;
  /** The same thing said again: confirmed (and, when due, its next review date); new synonyms added. */
  const reconfirm = (row: MemoryItemRow) => {
    const p: any = { last_confirmed_at: now() };
    if (row.review_at && row.review_at <= now()) Object.assign(p, { review_at: nextReview(row.review_every_days), review_note: null, flags: (row.flags || []).filter((f) => f !== 'check') });
    if (terms) p.terms = [...new Set([...(row.terms || []), ...terms])].slice(0, 16);
    svc.patchItem(row.id, p);
  };
  const settings = svc.userSettings(ownerId);
  // Recognised automatically from the owner's own words (pattern or model with a literal quote): counts as the owner
  // saying it when he allows that. Never for external text, injections or anything tainted.
  const ownApplies = !!c.ownStatement && settings.autoApply === 'own' && c.source.trust === 'user' && !flags.has('external') && !flags.has('tainted') && !flags.has('injection');
  const userSays = c.userApproved || (c.source.trust === 'user' && ['explicit', 'user_ui'].includes(c.origin)) || ownApplies;
  // 0.4.5: what the learner found in the bot's own work (its reply after using a tool, or the tool result) is applied
  // directly too, as the bot's note or its dossier's — never an instruction, never with external or injection flags.
  const workOk = fromWork && settings.autoApply === 'own' && c.source.trust === 'agent' && !flags.has('external') && !flags.has('tainted') && !flags.has('injection') && !flags.has('instruction');
  const workApplies = workOk && (c.scope === 'agent' || c.scope === 'dossier');

  return ctx.store.tx(() => {
    // 4. Dedup: exact hash in the same bucket.
    const dup = svc.exactDuplicate(ownerId, bucket, hash);
    if (dup) {
      if (dup.status === 'proposed' && userSays) {
        const before = svc.snapshot('item', dup.id);
        svc.patchItem(dup.id, { status: 'active', valid_from: now(), last_confirmed_at: now(), proposal_reason: null });
        const changeId = svc.recordChange({ userId: ownerId, kind: 'item', recordId: dup.id, dossierId, op: 'approve', before, after: svc.snapshot('item', dup.id), summary: `Bevestigd: ${svc.label(dup)}`, actor: c.createdBy, actorId: c.createdByAgent || c.userId });
        svc.emit(ownerId, { op: 'approve', ids: [dup.id], dossierId });
        return { action: 'inserted', reason: 'confirmed_proposal', message: `Opgeslagen [m:${dup.ref}].`, item: svc.view(svc.itemRow(dup.id)), changeId };
      }
      if (dup.status === 'active') reconfirm(dup);
      return { action: 'duplicate', reason: 'exact', message: `Stond al in het geheugen [m:${dup.ref}].`, item: svc.view(svc.itemRow(dup.id)) };
    }

    // 5. Conflict on the same canonical key (or the item the learner says is outdated): user correction wins,
    //    otherwise a review card (never a silent overwrite).
    const keyNorm = canonicalKey(key);
    let conflict: MemoryItemRow | null = null;
    if (c.replacesId) {
      const old = svc.itemRow(c.replacesId);
      const ob = old ? svc.bucketWhere(old) : null;
      const nb = svc.bucketWhere({ user_id: ownerId, ...bucket });
      if (old && old.status === 'active' && ob && JSON.stringify(ob) === JSON.stringify(nb)) conflict = old;
    }
    if (!conflict && keyNorm) conflict = svc.sameKey(ownerId, bucket, keyNorm);
    let similarHint: MemoryItemRow | null = null;
    if (!conflict) {
      const sims = svc.similar(ownerId, bucket, content, 3).filter((s) => s.row.status === 'active' || s.row.status === 'proposed');
      const top = sims[0];
      if (top && top.sim >= 0.9) {
        if (top.row.status === 'active') reconfirm(top.row);
        return { action: 'duplicate', reason: 'similar', message: `Stond al (bijna gelijk) in het geheugen [m:${top.row.ref}].`, item: svc.view(svc.itemRow(top.row.id)) };
      }
      if (top && top.sim >= 0.5 && top.row.status === 'active') {
        // Automatic learning only replaces what it was told is outdated (replacesId) or what has the same key; a merely
        // similar statement is kept next to it (maintenance merges or resolves it later, reversibly). "De SEO is
        // bijgewerkt" next to "we moeten de SEO bijwerken" is no conflict: it finishes that task (consolidate.ts).
        const finishes = doneSignal(content) && isOpenTodo(top.row, svc.contentOf(top.row));
        if (c.origin === 'user_ui' || finishes || c.compared || ((c.ownStatement || c.learned) && ['auto', 'model'].includes(c.origin))) similarHint = top.row;
        else conflict = top.row;
      }
    }

    // Refresh from the same source: a fact that is due for its check (review date passed) and a new statement from the
    // very source it came from (a specialist re-reading its page, a new version of a document) → a new version, the
    // old one stays in the history. Never for pinned facts or what the owner confirmed himself (a review card instead).
    if (conflict && conflict.status === 'active' && !conflict.pinned && conflict.review_at && conflict.review_at <= now() && sameSource(conflict, c) && c.source.trust !== 'external' && !flags.has('external') && !flags.has('injection')) {
      const ownerMade = svc.store.one("SELECT 1 FROM memory_changes WHERE record_id = ? AND actor = 'user' AND op IN ('create','approve','confirm','update','pin') AND undone_at IS NULL LIMIT 1", conflict.id);
      if (!ownerMade) {
        const quota = svc.quotaProblem({ user_id: ownerId, ...bucket }, Buffer.byteLength(content), false);
        if (quota) return quotaFull(svc, c, { user_id: ownerId, ...bucket }, quota);
        const r = supersede(svc, conflict, { ...c, content, type, key: key ?? conflict.canonical_key, sensitivity, confidence, flags: [...flags], terms: terms ?? conflict.terms ?? null, reviewKind: reviewKind ?? conflict.review_kind ?? null }, ownerId);
        svc.store.update('memory_changes', r.changeId, { reason: 'vernieuwd uit dezelfde bron', undo_until: new Date(Date.now() + 62 * 864e5).toISOString() });
        return { action: 'superseded', reason: 'refresh', message: `Vernieuwd [m:${r.item.ref}] (vervangt [m:${conflict.ref}], zelfde bron).`, item: svc.view(r.item), existing: svc.view(conflict), changeId: r.changeId };
      }
    }

    // Contradiction: replace directly only when the owner decided it (approved card, his own memory page, setting
    // "Direct vervangen") or explicitly said it changed ("ik woon nu in …", "niet meer …"); otherwise a review card.
    const replaceNow =
      !!conflict &&
      (c.userApproved || c.origin === 'user_ui' || settings.conflicts === 'replace' || isCorrection(content, c.source.excerpt, c.source.kind === 'message' && c.source.ref ? ctx.store.message(c.source.ref)?.content : null));
    // 0.4.5: what was learned from the conversation updates a changed fact directly (new version, history and undo),
    // also without correction words — as long as the old note is not pinned (something important: a review card),
    // and a bot or tool never overwrites what the owner said himself (a review card: his words win). Something
    // sensitive stays a proposal, as always.
    const pinnedAsk = !!conflict && !!c.learned && conflict.pinned;
    const learnedReplace = !!conflict && !pinnedAsk && sensitivity !== 'sensitive' && ((c.learned === 'owner' && ownApplies) ||(workOk && (conflict.scope === 'agent' || conflict.scope === 'dossier') && !ownerSaid(svc, conflict)));
    // Newer and at least as well sourced wins: the same subject (the same key, or the very note the writer pointed
    // at) is never stored twice. A bot's newer note replaces a bot's older one, a specialist's newer source replaces
    // what an older source said — the old version goes to the history, with undo. Still a question for the owner
    // (one review card): the old note is pinned or his own words, the new one is sensitive, comes from outside or
    // from a run that read outside content, or he chose to review everything bots write.
    const pointed = !!conflict && (c.replacesId === conflict.id || (!!keyNorm && conflict.key_norm === keyNorm));
    const clean_ = !flags.has('external') && !flags.has('tainted') && !flags.has('injection') && sensitivity !== 'sensitive';
    const betterSource =
      pointed && ['tool', 'service'].includes(c.origin) && !c.forcePropose && clean_ && !conflict!.pinned && settings.autoApply === 'own' && !(c.createdBy === 'agent' && settings.botWrites === 'propose') &&
      (TRUST_RANK[c.source.trust] ?? 0) >= (TRUST_RANK[conflict!.source_trust] ?? 0) && (c.source.trust === 'user' || !ownerSaid(svc, conflict!));
    if (conflict && conflict.status === 'active' && !pinnedAsk && (learnedReplace || betterSource || (userSays && replaceNow && (c.origin !== 'user_ui' || keyNorm)))) {
      const quota = svc.quotaProblem({ user_id: ownerId, ...bucket }, Buffer.byteLength(content), false);
      if (quota) return quotaFull(svc, c, { user_id: ownerId, ...bucket }, quota);
      const r = supersede(svc, conflict, { ...c, content, type, key, sensitivity, confidence, flags: [...flags] }, ownerId);
      const byUser = userSays && replaceNow;
      if (!byUser) svc.store.update('memory_changes', r.changeId, { undo_until: new Date(Date.now() + 62 * 864e5).toISOString() });
      return { action: 'superseded', reason: byUser ? 'user_correction' : learnedReplace ? 'learned_update' : 'newer_source', message: `Bijgewerkt [m:${r.item.ref}] (vervangt [m:${conflict.ref}]).`, item: svc.view(r.item), existing: svc.view(conflict), changeId: r.changeId };
    }

    // 6/7. Decide: propose or insert.
    let reason: string | null = null;
    if (conflict) reason = 'conflict';
    else if (c.forcePropose) reason = c.proposalReason || 'review';
    else if (c.userApproved) reason = null;
    else if (flags.has('external') || flags.has('injection')) reason = flags.has('injection') ? 'injection' : 'external';
    else if (sensitivity === 'sensitive') reason = 'sensitive';
    else if (c.origin === 'explicit' || c.origin === 'user_ui') reason = null;
    else if (ownApplies) reason = null;
    else if (workApplies) reason = null;
    else if (['auto', 'model', 'import', 'consolidation'].includes(c.origin)) reason = c.origin;
    else if (c.createdBy === 'agent') {
      if (c.scope === 'about_you') reason = 'about_you';
      else if (c.scope === 'shared') reason = 'shared';
      else if (flags.has('tainted')) reason = 'tainted';
      else if (flags.has('instruction')) reason = 'instruction';
      else if (settings.botWrites === 'propose') reason = 'bot';
    }
    const proposal = reason !== null;

    // Quota (count/bytes per scope, plus a cap on pending proposals).
    const quota = svc.quotaProblem({ user_id: ownerId, ...bucket }, Buffer.byteLength(content), proposal);
    if (quota) return quotaFull(svc, c, { user_id: ownerId, ...bucket }, quota);

    // 8. Transactional write + version/diff record.
    const ts = now();
    // Review interval: what was asked (UI, import), else the rhythm of a changing kind of fact (a price every 3 months,
    // a version every 2 …), else the owner's default for facts that can change (with a key).
    const reviewEvery =
      c.reviewEveryDays !== undefined && c.reviewEveryDays !== null
        ? reviewInterval(c.reviewEveryDays) ?? (Number(c.reviewEveryDays) > 0 ? Math.min(3650, Math.round(Number(c.reviewEveryDays))) : 0)
        : reviewKind
          ? REVIEW_KINDS[reviewKind].days
          : type === 'fact' && key
            ? settings.reviewEveryDays
            : 0;
    const row = svc.insertItem({
      user_id: ownerId,
      scope: c.scope,
      agent_id: agentId,
      dossier_id: dossierId,
      team_id: teamId,
      type,
      canonical_key: key,
      content,
      source_kind: c.source.kind,
      source_ref: c.source.ref ?? null,
      source_thread_id: c.source.threadId ?? null,
      source_excerpt: c.source.excerpt && sensitivity !== 'sensitive' ? excerpt(c.source.excerpt, 300) : null,
      source_trust: c.source.trust,
      confidence,
      sensitivity,
      status: proposal ? 'proposed' : 'active',
      proposal_reason: reason,
      conflict_with: conflict?.id ?? null,
      flags: [...flags],
      pinned: !!c.pinned && !proposal,
      observed_at: c.observedAt || ts,
      valid_from: proposal ? null : ts,
      expires_at: c.expiresAt ?? null,
      review_every_days: reviewEvery || null,
      review_at: c.reviewAt ?? nextReview(reviewEvery),
      review_kind: reviewKind,
      terms,
      created_by: c.createdBy,
      created_by_agent: c.createdByAgent ?? null,
      origin_run_id: c.runId ?? null,
      origin_call_id: c.callId ?? null,
      idem_key: c.idemKey ?? null,
    } as any);
    const changeId = svc.recordChange({
      userId: ownerId,
      kind: 'item',
      recordId: row.id,
      dossierId,
      op: proposal ? 'propose' : 'create',
      before: null,
      after: svc.snapshot('item', row.id),
      summary: `${proposal ? 'Voorstel' : 'Nieuw'}: ${svc.label(row)}`,
      reason: reason || c.origin,
      actor: c.createdBy,
      actorId: c.createdByAgent || c.userId,
    });
    svc.bumpMeta(ownerId, { since_consolidation: (svc.meta(ownerId).since_consolidation || 0) + 1 });
    // A new note in a dossier: the dossier is read again (its state, NU), as after any change (reread.ts).
    if (dossierId && !proposal) svc.markDossierChanged(dossierId);

    // 9. Verify (read-after-write) and notify.
    const check = svc.itemRow(row.id);
    if (!check || check.status !== row.status) ctx.log.error('[memory] read-after-write mismatch', row.id);
    // 0.4.4: does this new fact end something or finish an open task? The clear cases now (patterns, with undo); the
    // learner and nightly maintenance check the rest with a free model (consolidate.ts).
    if (check && !proposal && c.consolidate !== false && !['model', 'consolidation', 'import'].includes(c.origin)) {
      try {
        consolidateNow(svc, check, { agent: botWriter ?? (c.agentId ? ctx.store.agent(c.agentId) : null), trust: c.source.trust === 'user' ? 'user' : c.source.trust === 'customer' ? 'customer' : 'agent', threadId: c.source.threadId ?? null });
      } catch (e: any) {
        ctx.log.warn('[memory] controleren tegen wat er al staat mislukt', e?.message || e);
      }
    }
    svc.emit(ownerId, { op: proposal ? 'propose' : 'create', ids: [row.id], scope: c.scope, agentId, dossierId, actor: c.createdBy, actorId: c.createdByAgent ?? null, ref: row.ref, changeId, origin: c.origin });
    ctx.audit(ownerId, proposal ? 'memory.proposed' : 'memory.created', { ref: row.ref, scope: c.scope, type, origin: c.origin, reason }, c.createdByAgent ?? null);
    const reasonText: Record<string, string> = {
      conflict: 'het botst met wat er al staat',
      sensitive: 'het is gevoelige informatie',
      external: 'het komt uit een externe bron',
      injection: 'het lijkt op een instructie',
      auto: 'het is automatisch herkend',
      model: 'het is automatisch herkend',
      import: 'het komt uit een import',
      consolidation: 'het is een samenvoeging',
      about_you: 'het gaat over de gebruiker',
      shared: 'delen met alle bots vraagt toestemming',
      tainted: 'er is in deze taak externe inhoud gelezen',
      instruction: 'het is een instructie',
      bot: 'botvoorstellen worden eerst beoordeeld',
      scope: 'niet duidelijk is voor welke bot',
      review: 'het eerst beoordeeld moet worden',
    };
    const msg = proposal
      ? `Voorstel [m:${row.ref}] klaargezet voor de gebruiker (Geheugen › Te beoordelen), omdat ${reasonText[reason!] || 'het eerst beoordeeld wordt'}.`
      : `Onthouden [m:${row.ref}].`;
    return { action: proposal ? (conflict ? 'conflict' : 'proposed') : 'inserted', reason: reason || 'ok', message: msg, item: svc.view(check), existing: conflict ? svc.view(conflict) : similarHint ? svc.view(similarHint) : null, changeId };
  });
}

/**
 * Did the owner say this himself (0.4.5: his words win over a bot or a tool)? His own words (also when the learner
 * took them from a conversation), his own import, or anything he wrote, approved, confirmed, changed or pinned.
 */
export function ownerSaid(svc: MemoryService, row: MemoryItemRow): boolean {
  if (row.source_trust === 'user' || row.source_trust === 'import' || row.created_by === 'user') return true;
  return !!svc.store.one("SELECT 1 FROM memory_changes WHERE record_id = ? AND actor = 'user' AND op IN ('create','approve','confirm','update','pin') AND undone_at IS NULL LIMIT 1", row.id);
}

/**
 * Two active notes about the same subject that disagree (found by the sweep): may the newer one simply replace the
 * older? Yes when it is at least as well sourced, and the older one is not pinned and not the owner's own words
 * (unless the newer one is his too). Otherwise the owner is asked.
 */
export function newerWins(svc: MemoryService, old: MemoryItemRow, neu: MemoryItemRow): boolean {
  if (old.pinned || neu.sensitivity === 'sensitive' || neu.source_trust === 'external' || (neu.flags || []).some((f) => ['external', 'tainted', 'injection'].includes(f))) return false;
  if ((TRUST_RANK[neu.source_trust] ?? 0) < (TRUST_RANK[old.source_trust] ?? 0)) return false;
  return neu.source_trust === 'user' || !ownerSaid(svc, old);
}

/** Did this candidate come from the very source the item came from (same page, file or document)? */
function sameSource(row: MemoryItemRow, c: Candidate): boolean {
  if (!row.source_ref || !c.source.ref) return false;
  if (!['url', 'file', 'attachment'].includes(row.source_kind) || !['url', 'file', 'attachment'].includes(c.source.kind)) return false;
  const norm = (x: string) => String(x).trim().replace(/#.*$/, '').replace(/[/]+$/, '').toLowerCase();
  return norm(row.source_ref) === norm(c.source.ref);
}

/** Replace an active item with a new version (old one keeps its validity interval). One batch → one undo. */
export function supersede(svc: MemoryService, old: MemoryItemRow, c: Candidate & { content: string }, ownerId: string): { item: MemoryItemRow; changeId: string } {
  const ts = now();
  const batch = newId('mbt_');
  const before = svc.snapshot('item', old.id);
  const kind = c.reviewKind !== undefined ? c.reviewKind ?? null : old.review_kind ?? detectReviewKind(c.content, c.type || old.type);
  const asked = c.reviewEveryDays !== undefined && c.reviewEveryDays !== null ? reviewInterval(c.reviewEveryDays) ?? (Number(c.reviewEveryDays) > 0 ? Math.round(Number(c.reviewEveryDays)) : 0) : null;
  const every = asked ?? old.review_every_days ?? (kind ? REVIEW_KINDS[kind].days : 0);
  const row = svc.insertItem({
    user_id: ownerId,
    scope: old.scope,
    agent_id: old.agent_id,
    dossier_id: old.dossier_id,
    // A new version stays in the team of the old one.
    team_id: old.team_id ?? null,
    type: c.type || old.type,
    canonical_key: c.key ?? old.canonical_key,
    content: c.content,
    source_kind: c.source.kind,
    source_ref: c.source.ref ?? null,
    source_thread_id: c.source.threadId ?? null,
    source_excerpt: c.source.excerpt && (c.sensitivity || old.sensitivity) !== 'sensitive' ? excerpt(c.source.excerpt, 300) : null,
    source_trust: c.source.trust,
    confidence: c.confidence ?? old.confidence,
    sensitivity: maxSensitivity(c.sensitivity, old.sensitivity),
    status: 'active',
    flags: c.flags || old.flags,
    pinned: old.pinned,
    valid_from: ts,
    version: (old.version || 1) + 1,
    supersedes_id: old.id,
    expires_at: c.expiresAt ?? null,
    // The new version keeps the item's rhythm (or that of its kind); its first check is counted from now.
    review_every_days: every || null,
    review_at: c.reviewAt ?? nextReview(every),
    review_kind: kind,
    terms: (c.sensitivity || old.sensitivity) === 'sensitive' ? null : c.terms ?? old.terms ?? null,
    created_by: c.createdBy,
    created_by_agent: c.createdByAgent ?? null,
    origin_run_id: c.runId ?? null,
    origin_call_id: c.callId ?? null,
    idem_key: c.idemKey ?? null,
  } as any);
  svc.patchItem(old.id, { status: 'superseded', valid_to: ts, superseded_by: row.id, pinned: false });
  svc.recordChange({ userId: ownerId, kind: 'item', recordId: old.id, dossierId: old.dossier_id, op: 'supersede', before, after: svc.snapshot('item', old.id), summary: `Vervangen: ${svc.label(old)}`, reason: c.origin, actor: c.createdBy, actorId: c.createdByAgent || c.userId, batchId: batch });
  const changeId = svc.recordChange({ userId: ownerId, kind: 'item', recordId: row.id, dossierId: old.dossier_id, op: 'create', before: null, after: svc.snapshot('item', row.id), summary: `Nieuwe versie: ${svc.label(row)}`, reason: c.origin, actor: c.createdBy, actorId: c.createdByAgent || c.userId, batchId: batch });
  svc.emit(ownerId, { op: 'supersede', ids: [old.id, row.id], dossierId: old.dossier_id, ref: row.ref, changeId });
  svc.ctx.audit(ownerId, 'memory.superseded', { old: old.ref, new: row.ref }, c.createdByAgent ?? null);
  return { item: svc.itemRow(row.id)!, changeId };
}

// ---------------------------------------------------------------------------- review decisions

export interface ApproveOpts {
  action?: 'approve' | 'replace' | 'keep_both' | 'merge';
  content?: string;
  scope?: Scope;
  agentId?: string | null;
  dossierId?: string | null;
  type?: ItemType;
  key?: string | null;
  sensitivity?: any;
  expires_at?: string | null;
  /** Shared knowledge: the team (or ALL_TEAMS) the owner puts it in. */
  teamId?: string | null;
}

export function approveProposal(svc: MemoryService, userId: string, id: string, o: ApproveOpts = {}): { item: MemoryItemRow; changeId: string } {
  const ctx = svc.ctx;
  const row = svc.itemRow(id);
  if (!row || row.user_id !== userId) throw new Error('Voorstel niet gevonden');
  if (row.status !== 'proposed') throw new Error('Dit is geen open voorstel meer');
  const content = o.content !== undefined ? clean(o.content) : svc.contentOf(row);
  if (detectSecret(content)) throw new Error('Dit lijkt op een wachtwoord of sleutel en kan niet in het geheugen.');
  if (svc.blockedBy(userId, content, o.key ?? row.canonical_key, ['forget'])) throw new Error('Dit is eerder vergeten. Hef eerst de blokkade op in Geschiedenis › Blokkades.');
  const patch: any = { proposal_reason: null };
  if (o.content !== undefined) patch.content = content;
  if (o.type && ITEM_TYPES.includes(o.type)) patch.type = o.type;
  if (o.key !== undefined) patch.canonical_key = o.key || null;
  if (o.sensitivity && SENSITIVITIES.includes(o.sensitivity)) patch.sensitivity = o.sensitivity;
  if (o.expires_at !== undefined) patch.expires_at = o.expires_at || null;
  if (o.scope && SCOPES.includes(o.scope)) {
    patch.scope = o.scope;
    if (o.scope === 'agent') {
      const a = ctx.store.agent(o.agentId || row.agent_id);
      if (!a || a.user_id !== userId) throw new Error('Kies een bot');
      patch.agent_id = a.id;
      patch.dossier_id = null;
      patch.team_id = a.id === row.agent_id && row.scope === 'agent' ? row.team_id ?? null : svc.homeTeam(a);
    } else if (o.scope === 'dossier') {
      const role = svc.dossierRole(userId, o.dossierId || row.dossier_id);
      if (role !== 'owner' && role !== 'edit') throw new Error('Kies een dossier');
      patch.dossier_id = o.dossierId || row.dossier_id;
      patch.agent_id = null;
      patch.team_id = null;
    } else {
      patch.agent_id = null;
      patch.dossier_id = null;
      // Shared: the team the owner chose, else where it was (a bot's proposal: its team), else the default team.
      patch.team_id = o.scope === 'shared' ? (o.teamId && svc.validTeam(userId, o.teamId) ? o.teamId : row.scope === 'shared' || row.scope === 'agent' ? row.team_id ?? null : null) : null;
    }
  } else if (o.teamId && row.scope === 'shared' && svc.validTeam(userId, o.teamId)) patch.team_id = o.teamId;
  return ctx.store.tx(() => {
    const batch = newId('mbt_');
    const before = svc.snapshot('item', id);
    const ts = now();
    const action = o.action || (row.conflict_with ? 'replace' : row.merge_of?.length ? 'merge' : 'approve');
    svc.patchItem(id, { ...patch, status: 'active', valid_from: ts, last_confirmed_at: ts });
    if (action === 'replace' && row.conflict_with) {
      const old = svc.itemRow(row.conflict_with);
      if (old && old.status === 'active') {
        const ob = svc.snapshot('item', old.id);
        svc.patchItem(old.id, { status: 'superseded', valid_to: ts, superseded_by: id, pinned: false });
        svc.patchItem(id, { supersedes_id: old.id, version: (old.version || 1) + 1, pinned: old.pinned });
        svc.recordChange({ userId, kind: 'item', recordId: old.id, dossierId: old.dossier_id, op: 'supersede', before: ob, after: svc.snapshot('item', old.id), summary: `Vervangen: ${svc.label(old)}`, actor: 'user', actorId: userId, batchId: batch });
      }
    }
    if (action === 'merge' && row.merge_of?.length) {
      for (const oid of row.merge_of) {
        const old = svc.itemRow(oid);
        if (!old || old.user_id !== userId || old.status !== 'active') continue;
        const ob = svc.snapshot('item', old.id);
        svc.patchItem(old.id, { status: 'archived', valid_to: ts, superseded_by: id, pinned: false });
        svc.recordChange({ userId, kind: 'item', recordId: old.id, dossierId: old.dossier_id, op: 'merge', before: ob, after: svc.snapshot('item', old.id), summary: `Samengevoegd: ${svc.label(old)}`, actor: 'user', actorId: userId, batchId: batch });
      }
    }
    const after = svc.snapshot('item', id);
    const changeId = svc.recordChange({ userId, kind: 'item', recordId: id, dossierId: after.dossier_id, op: 'approve', before, after, summary: `Goedgekeurd: ${svc.label(after)}`, actor: 'user', actorId: userId, batchId: batch });
    svc.emit(userId, { op: 'approve', ids: [id], dossierId: after.dossier_id, changeId });
    ctx.audit(userId, 'memory.approved', { ref: row.ref, action });
    return { item: svc.itemRow(id)!, changeId };
  });
}

/** Reject a proposal: a fingerprint suppresses the same proposal for 90 days; content is purged after the undo day. */
export function rejectProposal(svc: MemoryService, userId: string, id: string, reason = ''): string {
  const row = svc.itemRow(id);
  if (!row || row.user_id !== userId) throw new Error('Voorstel niet gevonden');
  if (row.status !== 'proposed') throw new Error('Dit is geen open voorstel meer');
  return svc.ctx.store.tx(() => {
    const before = svc.snapshot('item', id);
    svc.patchItem(id, { status: 'rejected', trashed_at: now() });
    svc.tombstone({ userId, kind: 'reject', recordKind: 'item', recordId: id, scope: row.scope, label: 'Afgewezen voorstel', content: svc.contentOf(row), key: row.canonical_key, days: 90 });
    const changeId = svc.recordChange({ userId, kind: 'item', recordId: id, dossierId: row.dossier_id, op: 'reject', before, after: svc.snapshot('item', id), summary: `Afgewezen: ${svc.label(row)}`, reason, actor: 'user', actorId: userId });
    svc.emit(userId, { op: 'reject', ids: [id], changeId });
    svc.ctx.audit(userId, 'memory.rejected', { ref: row.ref });
    return changeId;
  });
}

// ---------------------------------------------------------------------------- message flags (per user message)

export interface MsgFlags {
  nolearn?: boolean;
  forget?: boolean;
  unclear?: boolean;
  outcomes?: { action: string; ref?: string; message: string }[];
}

export function msgFlags(svc: MemoryService, messageId: string | null | undefined): MsgFlags {
  if (!messageId) return {};
  const r = svc.store.one<any>('SELECT flag FROM memory_msg_flags WHERE message_id = ?', messageId);
  if (!r) return {};
  try {
    return JSON.parse(r.flag);
  } catch {
    return {};
  }
}

export function setMsgFlags(svc: MemoryService, messageId: string, userId: string, f: MsgFlags) {
  svc.store.exec(
    'INSERT INTO memory_msg_flags (message_id, user_id, flag, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET flag = excluded.flag',
    messageId,
    userId,
    JSON.stringify(f),
    now(),
  );
}

/** Is this message written by the thread owner in their own words (not external, forwarded or a system note)? */
export function isOwnerMessage(m: Message | null, thread: Thread): boolean {
  if (!m || m.role !== 'user' || m.deleted) return false;
  return (m.author_type === 'user' && m.author_id === thread.user_id) || ownerOnChannel(m, thread);
}

/**
 * The owner writing to his own bot through a channel (WhatsApp, Telegram, e-mail …): the channel marks the message
 * `isOwner` only for the owner's own verified sender in a one-to-one conversation (channels/manager.ts). His words
 * there count like his words in the app: "onthoud dat …" works and the conversation is learned from.
 */
export function ownerOnChannel(m: Message | null, thread: Thread | null): boolean {
  const ch = (m?.parts as any)?.channel;
  return !!m && !!thread && thread.kind === 'channel' && m.role === 'user' && m.author_type === 'external' && !m.deleted && ch?.isOwner === true && ch?.private !== false && !ch?.outbound;
}

function ttlFrom(content: string): string | null {
  const s = normalize(content);
  const days = /\b(vandaag|vanavond|today|tonight)\b/.test(s) ? 1 : /\b(morgen|tomorrow)\b/.test(s) ? 2 : /\b(deze week|this week)\b/.test(s) ? 7 : /\b(volgende week|next week)\b/.test(s) ? 14 : 0;
  return days ? new Date(Date.now() + days * 864e5).toISOString() : null;
}

export function dossierMentioned(svc: MemoryService, userId: string, agentId: string | null, content: string): string | null {
  const n = ' ' + normalize(content) + ' ';
  // In a bot's conversation: only a dossier that bot may read and write (its own team's), never another team's.
  const agent = agentId ? svc.store.agent(agentId) : null;
  const reader = agent ? { userId, agentId: agent.id, audience: 'private' as const, readShared: true, readAboutYou: true, teams: svc.teamScope(agent) } : svc.userReader(userId);
  const ids = svc.readableDossiers(reader);
  if (!ids.length) return null;
  const rows = svc.store.all<any>(`SELECT id, title FROM memory_dossiers WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'active'`, ...ids);
  let best: { id: string; len: number } | null = null;
  for (const d of rows) {
    const t = normalize(d.title);
    if (t.length >= 3 && n.includes(' ' + t + ' ') && svc.dossierRole(userId, d.id) !== 'read' && !(agent && svc.dossierWriteRefusal(agent, d.id)) && (!best || t.length > best.len)) best = { id: d.id, len: t.length };
  }
  return best?.id ?? null;
}

/**
 * Explicit intents in a new user message ("onthoud dat …", "niet onthouden", "vergeet …"). Runs from the messageCreated
 * hook, before the bot answers, so the turn context can tell the bot what was stored.
 */
export function captureExplicit(svc: MemoryService, m: Message, thread: Thread) {
  if (!isOwnerMessage(m, thread)) return;
  const intent = explicitIntent(m.content);
  if (!intent.kind) return;
  const userId = thread.user_id;
  const agent = svc.store.agent(thread.agent_id);
  if (agent && !svc.effective(agent).enabled) return;
  if (intent.kind === 'no_remember') return setMsgFlags(svc, m.id, userId, { nolearn: true });
  if (intent.kind === 'forget') return setMsgFlags(svc, m.id, userId, { nolearn: true, forget: true });
  const learn = agent ? svc.effective(agent).learn : svc.userSettings(userId).learnMode;
  if (learn === 'off') return setMsgFlags(svc, m.id, userId, { outcomes: [{ action: 'off', message: 'Leren staat uit; er is niets opgeslagen. De gebruiker kan dit aanzetten in Geheugen › Opslag.' }] });

  let content = intent.content || '';
  let trust: 'user' | 'external' = 'user';
  let sourceRef = m.id;
  if (!content && m.reply_to) {
    const replied = svc.store.message(m.reply_to);
    if (replied && replied.thread_id === thread.id && replied.content) {
      content = clean(replied.content, 1000);
      sourceRef = replied.id;
      if (replied.author_type === 'external' || (replied.role === 'user' && replied.author_id !== userId)) trust = 'external';
    }
  }
  if (!content) return setMsgFlags(svc, m.id, userId, { unclear: true });

  let scope: Scope;
  let dossierId: string | null = null;
  let forcePropose = false;
  // "voor alle bots" = shared in this bot's team; "voor alle teams" = shared with every team (the owner says so).
  const teamId = wantsShared(m.content) && wantsAllTeams(m.content) ? ALL_TEAMS : null;
  if (wantsShared(m.content)) scope = 'shared';
  else if ((dossierId = dossierMentioned(svc, userId, agent?.id ?? null, content))) scope = 'dossier';
  else if (firstPerson(content) && !/^(we|wij|ons|onze)\b/i.test(content)) scope = 'about_you';
  else if (agent) scope = 'agent';
  else {
    scope = 'shared';
    forcePropose = true;
  }
  const out = writeCandidate(svc, {
    userId,
    content,
    scope,
    agentId: agent?.id ?? null,
    dossierId,
    teamId,
    source: { kind: 'message', ref: sourceRef, threadId: thread.id, excerpt: m.content, trust },
    origin: 'explicit',
    createdBy: 'user',
    idemKey: `x:${m.id}`,
    expiresAt: ttlFrom(content),
    forcePropose,
    proposalReason: forcePropose ? 'scope' : undefined,
  });
  setMsgFlags(svc, m.id, userId, { outcomes: [{ action: out.action, ref: out.item?.ref, message: out.message }] });
}

/** Automatic proposals after a run (learn mode "auto"): high-precision patterns in the owner's own message. */
export function captureAuto(svc: MemoryService, agent: Agent, thread: Thread, run: Run): number {
  const eff = svc.effective(agent);
  if (!eff.enabled || eff.learn !== 'auto') return 0;
  const input = svc.store.message(run.input_message_id);
  if (!isOwnerMessage(input, thread) || !['user', 'retry', ...(ownerOnChannel(input, thread) ? ['channel'] : [])].includes(run.trigger)) return 0;
  const f = msgFlags(svc, input!.id);
  if (f.nolearn || f.forget || f.outcomes?.length) return 0;
  let n = 0;
  heuristicFacts(input!.content).forEach((h, i) => {
    const scope: Scope = h.aboutUser ? 'about_you' : 'agent';
    const out = writeCandidate(svc, {
      userId: thread.user_id,
      content: h.content,
      scope,
      agentId: agent.id,
      type: h.type,
      key: h.key,
      source: { kind: 'message', ref: input!.id, threadId: thread.id, excerpt: input!.content, trust: 'user' },
      origin: 'auto',
      createdBy: 'agent',
      createdByAgent: agent.id,
      runId: run.id,
      idemKey: `h:${input!.id}:${i}`,
      ownStatement: true,
      learned: 'owner',
    });
    if (out.action === 'proposed' || out.action === 'conflict') n++;
  });
  return n;
}

// ---------------------------------------------------------------------------- model budget (smart learning, see learn.ts)

/**
 * Respect the memory module's own daily call cap and — for engines that cost money — the user's daily spend cap.
 * Free engines (subscription CLI, free/local model) are not blocked by the spend cap: they cost nothing extra.
 */
export function modelBudgetOk(svc: MemoryService, userId: string, paid = true): boolean {
  const s = svc.userSettings(userId);
  const day = new Date().toISOString().slice(0, 10);
  const meta = svc.meta(userId);
  const calls = meta.model_day === day ? meta.model_calls || 0 : 0;
  if (calls >= s.modelDailyCap) return false;
  if (!paid) return true;
  const { limit } = budgetOf(svc.ctx, userId);
  return !limit || spentToday(svc.ctx, userId) < limit;
}

/** Did this run read external content (any non-memory tool output) before now? Then bot writes are proposals. */
export function runTainted(svc: MemoryService, run: Run): boolean {
  return !!svc.store.one(
    "SELECT 1 FROM messages WHERE run_id = ? AND role = 'tool' AND COALESCE(json_extract(parts, '$.toolResult.name'), '') NOT LIKE 'memory\\_%' ESCAPE '\\' AND COALESCE(json_extract(parts, '$.toolResult.name'), '') NOT LIKE 'dossier\\_%' ESCAPE '\\' LIMIT 1",
    run.id,
  );
}

/** Was the run started by the owner in their own words (not a webhook, channel, routine or other person)? */
export function runFromOwner(svc: MemoryService, run: Run, thread: Thread): boolean {
  if (!['user', 'retry', 'resume'].includes(run.trigger)) return false;
  const input = svc.store.message(run.input_message_id);
  if (!input) return false;
  if (input.role === 'system') return run.trigger === 'resume';
  return isOwnerMessage(input, thread) && !/^\s*(doorgestuurd van|forwarded from)/i.test(input.content);
}
