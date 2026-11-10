import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useApp } from './store';
import type { Agent } from './types';
import { MOOD_LABELS, type FaceStyle, type Mood } from './botface';
import { t } from './i18n';
import { formatTime } from './format';
import { DONE_MS, moodFrom, type MoodInputs } from './moodCore';

export { DONE_MS, moodFrom };

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** The bot's most recent conversation with an answer as its last line (before anything happened in this session). */
function latestAnswer(s: ReturnType<typeof useApp.getState>, id: string) {
  let latest: (typeof s.threads)[number] | undefined;
  for (const t of s.threads) if (t.agent_id === id && t.last && t.last.role === 'assistant' && (!latest || t.updated_at > latest.updated_at)) latest = t;
  return latest?.last;
}

/** When the daily budget that stopped this bot's last run opens again (ms), or 0: not stopped by the budget. */
function limitUntilOf(s: ReturnType<typeof useApp.getState>, id: string): number {
  const fin = s.finished[id];
  if (fin) return fin.status === 'error' ? fin.budgetUntil || 0 : 0;
  const last = latestAnswer(s, id);
  return last?.status === 'error' ? ms(last.budgetUntil) : 0;
}

/** Everything the mood depends on, as primitives (cheap to compare in a store selector). */
function inputs(s: ReturnType<typeof useApp.getState>, agent: Pick<Agent, 'id' | 'archived'> | null | undefined): MoodInputs {
  if (!agent) return { paused: false, waiting: false, working: false, failed: false, doneAt: 0 };
  const id = agent.id;
  const runs = s.runs.filter((r) => r.agent_id === id);
  const fin = s.finished[id];
  // Before anything happened in this session: did the bot's most recent answer fail (or stop at the daily budget)?
  const failed = fin ? fin.status === 'error' : latestAnswer(s, id)?.status === 'error';
  return {
    paused: !!agent.archived,
    waiting: s.approvals.some((a) => a.agent_id === id) || runs.some((r) => r.status === 'waiting'),
    working: runs.some((r) => r.status === 'queued' || r.status === 'running'),
    failed,
    doneAt: fin && fin.status === 'done' ? fin.at : 0,
    limitUntil: failed ? limitUntilOf(s, id) : 0,
  };
}

/** The bot's current mood from real state: run active, approval pending, last run failed, archived, just finished. */
export function useAgentMood(agent: Pick<Agent, 'id' | 'archived'> | null | undefined): Mood {
  const i = useApp(useShallow((s) => inputs(s, agent)));
  const [, tick] = useState(0);
  const mood = moodFrom(i);
  useEffect(() => {
    // "klaar" for a moment, "daglimiet bereikt" until the new day: then the face changes by itself.
    const left = mood === 'done' ? DONE_MS - (Date.now() - i.doneAt) : mood === 'limit' ? (i.limitUntil || 0) - Date.now() : -1;
    if (left < 0) return;
    const t = setTimeout(() => tick((x) => x + 1), Math.min(left, 2_000_000_000) + 50);
    return () => clearTimeout(t);
  }, [mood, i.doneAt, i.limitUntil]);
  return mood;
}

/** When the daily budget that stopped this bot opens again (ms), or 0. */
export function useLimitUntil(agentId: string | null | undefined): number {
  return useApp((s) => (agentId ? limitUntilOf(s, agentId) : 0));
}

/**
 * The daily budget stop as a status line, in whole sentences: a limit (not a failure), when the bot works again and
 * where to raise it (acceptance round 6, B-70: it said "er ging iets mis").
 */
export function limitLine(until: number): string {
  return until ? t('Daglimiet bereikt. Om {0} werkt de bot weer; verhogen kan in Instellingen › Kosten.', formatTime(until)) : 'Daglimiet bereikt. Verhogen kan in Instellingen › Kosten.';
}

/** Short status text that always goes with a face (colour or face alone never carries the status). */
export function moodText(mood: Mood, fallback = ''): string {
  return mood === 'idle' ? fallback : MOOD_LABELS[mood];
}

/** Text colour class for a mood's status text. */
export function moodTone(mood: Mood): string {
  return mood === 'working' || mood === 'done' ? 'text-ok' : mood === 'waiting' || mood === 'limit' ? 'text-warn' : mood === 'error' ? 'text-danger' : 'text-muted';
}

/** Global "Stijl figuurtjes" setting (Glad = clay, Vilt = felt). */
export function useFaceStyle(): FaceStyle {
  return useApp((s) => (s.settings?.ui?.botStyle === 'felt' ? 'felt' : 'clay'));
}
