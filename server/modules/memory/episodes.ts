/**
 * Thread episodes: a compact, bounded summary per conversation (summary, decisions, actions, open questions, source
 * message ids). Updated cheaply after each run from the new messages only; mirrored into thread.meta.summary so the
 * core can use it when old history is truncated. Searchable through the FTS index; forgotten content never returns.
 */
import type { Agent, Thread } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import type { MemoryService } from './service.js';
import { clean, containment, detectSecret, episodeLines, excerpt, explicitIntent, jaccard, normalize, sentences, tokens } from './text.js';
import { syncThreadSummary } from './forget.js';

const MAX_LIST = 12;

interface Line {
  text: string;
  msg: string;
  by?: string;
}

function mergeLines(old: Line[], add: Line[], max = MAX_LIST): Line[] {
  const seen = new Set(old.map((l) => normalize(l.text)));
  const out = [...old];
  for (const l of add) {
    const n = normalize(l.text);
    if (!n || seen.has(n)) continue;
    // The same decision/action said twice (pattern line + model line) is kept once.
    const tk = tokens(l.text);
    if (out.some((o) => nearSame(tk, tokens(o.text)))) continue;
    seen.add(n);
    out.push(l);
  }
  return out.slice(-max);
}

/** Two short statements about the same thing (most words shared). */
export function nearSame(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  return jaccard(a, b) >= 0.5 || containment(a.length <= b.length ? a : b, a.length <= b.length ? b : a) >= 0.75;
}

export function episodeFor(svc: MemoryService, threadId: string) {
  const r = svc.store.one<any>('SELECT * FROM memory_episodes WHERE thread_id = ?', threadId);
  return r ? svc.store.decode<any>('memory_episodes', r) : null;
}

/** Update (or create) the episode of a thread with the messages since the last update. */
export function updateEpisode(svc: MemoryService, agent: Agent | null, thread: Thread, modelEpisode?: { summary?: string; decisions?: string[]; actions?: string[]; open_questions?: string[] } | null) {
  const userId = thread.user_id;
  const ep = episodeFor(svc, thread.id);
  if (ep?.method === 'forgotten' && !modelEpisode) {
    // A forgotten episode only restarts from messages after the forget.
  }
  const upto = ep?.upto_seq || 0;
  const msgs = svc.store
    .messages(thread.id, { limit: 400 })
    .filter((m) => m.seq > upto && (m.role === 'user' || m.role === 'assistant') && m.content && m.status === 'done' && !m.deleted);
  if (!msgs.length && !modelEpisode) return ep;
  // Memory commands ("onthoud dat …") live as items with supersede semantics; secrets and forgotten content never enter.
  const ok = (s: string) => !!s && !detectSecret(s) && !explicitIntent(s).kind && !svc.lineIsForgotten(userId, s);
  const decisions: Line[] = [];
  const actions: Line[] = [];
  for (const m of msgs) {
    const l = episodeLines(m.content);
    for (const t of l.decisions) if (ok(t)) decisions.push({ text: excerpt(t, 300), msg: m.id, by: m.author_name });
    for (const t of l.actions) if (ok(t)) actions.push({ text: excerpt(t, 300), msg: m.id, by: m.author_name });
  }
  const lastBot = [...msgs].reverse().find((m) => m.role === 'assistant');
  const questions: Line[] = lastBot ? episodeLines(lastBot.content).questions.filter(ok).slice(-4).map((t) => ({ text: excerpt(t, 240), msg: lastBot.id, by: lastBot.author_name })) : ep?.questions || [];
  if (modelEpisode) {
    const mk = (arr: any, msg: string) => (Array.isArray(arr) ? arr : []).map((t: any) => clean(String(t), 300)).filter(ok).map((text: string) => ({ text, msg }));
    const ref = lastBot?.id || msgs[msgs.length - 1]?.id || '';
    decisions.push(...mk(modelEpisode.decisions, ref));
    actions.push(...mk(modelEpisode.actions, ref));
    if (Array.isArray(modelEpisode.open_questions)) questions.splice(0, questions.length, ...mk(modelEpisode.open_questions, ref).slice(0, 5));
  }

  // Summary: model summary when available, else subject + latest state (cheap and bounded).
  let summary = '';
  if (modelEpisode?.summary) summary = sentences(clean(modelEpisode.summary, 1200)).filter(ok).join(' ');
  if (!summary) {
    const first = svc.store.messages(thread.id, { limit: 2000 }).find((m) => m.role === 'user' && m.content && !m.deleted && ok(m.content));
    const parts: string[] = [];
    const subject = (ok(thread.title) ? thread.title : '') || (first ? excerpt(first.content, 140) : '');
    if (subject && ok(subject)) parts.push(`Onderwerp: ${subject}.`);
    if (lastBot) {
      const s = sentences(lastBot.content.replace(/[#*_`>|]/g, ' ')).filter(ok).slice(0, 2).join(' ');
      if (s) parts.push(`Laatste stand: ${excerpt(s, 320)}`);
    }
    summary = parts.join(' ') || ep?.summary || '';
  }
  summary = clean(summary, 1200);
  const sourceIds = [...new Set([...(ep?.source_ids || []), ...decisions.map((d) => d.msg), ...actions.map((d) => d.msg), ...(lastBot ? [lastBot.id] : [])])].slice(-30);
  const agentIds = [...new Set([...(ep?.agent_ids || []), ...(agent ? [agent.id] : []), ...msgs.filter((m) => m.author_type === 'agent' && m.author_id).map((m) => m.author_id as string)])];
  const ts = now();
  const row: any = {
    title: clean(ok(thread.title) ? thread.title : '', 120),
    summary,
    decisions: mergeLines(ep?.decisions || [], decisions),
    actions: mergeLines(ep?.actions || [], actions),
    questions,
    source_ids: sourceIds,
    agent_ids: agentIds,
    upto_seq: Math.max(upto, ...msgs.map((m) => m.seq), 0),
    method: modelEpisode ? 'model' : 'heuristic',
    updated_at: ts,
  };
  if (ep) {
    svc.store.update('memory_episodes', ep.id, { ...row, version: (ep.version || 1) + 1 });
  } else {
    // The conversation summary belongs to the team of its bot (it stays there when the bot moves).
    const bot = agent || svc.store.agent(thread.agent_id);
    const teamId = bot && bot.user_id === userId ? svc.homeTeam(bot) : null;
    svc.store.insert('memory_episodes', { id: newId('epi_'), ref: svc.newRef('memory_episodes', userId), user_id: userId, thread_id: thread.id, team_id: teamId, version: 1, created_at: ts, ...row });
  }
  const cur = episodeFor(svc, thread.id)!;
  svc.syncIndex('episode', cur.id);
  syncThreadSummary(svc, thread.id);
  svc.emit(userId, { op: 'episode', kind: 'episode', ids: [cur.id], threadId: thread.id });
  return cur;
}

/** Rebuild an episode from scratch (all messages). */
export function rebuildEpisode(svc: MemoryService, thread: Thread) {
  const ep = episodeFor(svc, thread.id);
  if (ep) {
    svc.store.update('memory_episodes', ep.id, { upto_seq: 0, decisions: [], actions: [], questions: [], summary: '', source_ids: [] });
  }
  const agent = svc.store.agent(thread.agent_id);
  return updateEpisode(svc, agent, thread);
}

export function deleteEpisodeForThread(svc: MemoryService, threadId: string) {
  const ep = episodeFor(svc, threadId);
  if (!ep) return;
  svc.unindex('episode', ep.id);
  svc.store.exec('DELETE FROM memory_episodes WHERE id = ?', ep.id);
}
