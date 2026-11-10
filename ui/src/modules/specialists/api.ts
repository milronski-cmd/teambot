import { useEffect, useState } from 'react';
import { api, on } from '../../lib/api';

/** Mirrors server/modules/specialists (see docs/modules/specialists.md). */
export type SourceKind = 'web' | 'feed' | 'docs' | 'file';
export type Cadence = 'hourly' | 'daily' | 'weekly';
export type BudgetId = 'none' | 'small' | 'normal' | 'large';

export interface SourceView {
  id?: string;
  kind: SourceKind;
  target: string;
  label: string;
  enabled: boolean;
  suggested?: boolean;
  lastCheckedAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
}

export interface SpecialistView {
  agentId: string;
  agentName: string;
  enabled: boolean;
  field: string;
  learnOn: boolean;
  cadence: Cadence;
  budget: BudgetId;
  selfTest: boolean;
  /** The specialist's own model (default) or a cheaper (free or local) one. */
  learnWith?: 'own' | 'cheap';
  sources: SourceView[];
  /** When the next round starts by itself; `skipped` = the last one waited for a free or local model. */
  nextRoundAt?: string | null;
  skipped?: { at: string; reason: string } | null;
  dossierId: string | null;
  engine: { kind: 'free' | 'own' | 'none'; label: string; billing: string; problem: string | null };
  canUseTools: boolean;
  counts: { facts: number; review: number; goals: number; proposals: number; reportsUnseen: number; retired?: number };
  /** Active facts against the knowledge base's budget (memory keeps it at or under the target). */
  size?: { active: number; target: number } | null;
  /** The newest "wat is er nieuw en wat verandert er daardoor" of a learning round. */
  lastNews?: { at: string; nieuw: string; gevolg: string } | null;
  lastRound: { id: string; status: string; summary: string | null; finished_at: string | null; started_at: string } | null;
  budgets: { id: BudgetId; label: string; tokens: number; calls: number }[];
}

export interface Fact {
  id: string;
  ref: string;
  content: string;
  status: string;
  sourceKind: string;
  source: string | null;
  quote: string | null;
  learnedAt: string;
  /** When a source (or the owner) last confirmed it; `check` = it could not be confirmed. */
  confirmedAt?: string | null;
  check?: boolean;
  published: string | null;
  sourceLabel: string | null;
  by: string | null;
  reason: string | null;
  changeId: string | null;
  roundId: string | null;
  lineIndex: number | null;
  existing?: { id?: string; ref?: string; content: string; source?: string | null; learnedAt?: string } | null;
}

/** A fact or practice that no longer holds: the bot is told not to use it any more. */
export interface Retired {
  id: string;
  ref: string;
  content: string;
  reason: string;
  since: string;
  source: string | null;
}

export interface Goal {
  id: string;
  question: string;
  origin: 'gap' | 'selftest' | 'owner' | 'bot';
  status: 'open' | 'done' | 'dropped';
  hits: number;
  answer_ref: string | null;
  answer_text: string | null;
  note: string | null;
  thread_id: string | null;
  created_at: string;
  done_at: string | null;
}

export interface RoundLine {
  kind: 'new' | 'duplicate' | 'conflict' | 'proposed' | 'ignored' | 'rejected' | 'error' | 'unchanged' | 'skipped' | 'goal';
  text: string;
  source?: string;
  sourceLabel?: string;
  published?: string | null;
  ref?: string;
  changeId?: string | null;
  existing?: { ref?: string; text: string } | null;
  undone?: boolean;
}

export interface Round {
  id: string;
  trigger: string;
  status: string;
  engine: string | null;
  summary: string | null;
  error: string | null;
  stats: Record<string, number>;
  lines: RoundLine[];
  started_at: string;
  finished_at: string | null;
}

export interface Report {
  id: string;
  summary: string;
  period_from: string;
  period_to: string;
  created_at: string;
  seen_at: string | null;
  data: { roundIds: string[]; facts: { text: string; ref?: string; source?: string; sourceLabel?: string }[]; conflicts: any[]; goalsDone: { question: string }[]; errors: string[]; sources: { url: string; label: string }[] };
}

export interface Proposal {
  id: string;
  title: string;
  summary: string;
  skill_md: string;
  status: 'open' | 'accepted' | 'dismissed';
  evidence: { threadId: string; task: string; at: string }[];
  created_at: string;
}

export interface SpecialistListItem {
  agentId: string;
  agentName: string;
  avatar: string;
  enabled: boolean;
  field: string;
  learnOn: boolean;
  cadence: Cadence;
  lastRoundAt: string | null;
  counts: SpecialistView['counts'];
}

export const spApi = {
  list: () => api.get<SpecialistListItem[]>('/specialists'),
  get: (agentId: string) => api.get<SpecialistView>(`/specialists/${agentId}`),
  save: (agentId: string, body: Partial<{ enabled: boolean; field: string; learnOn: boolean; cadence: Cadence; budget: BudgetId; selfTest: boolean; learnWith: 'own' | 'cheap'; sources: SourceView[] }>) => api.put<SpecialistView>(`/specialists/${agentId}`, body),
  learn: (agentId: string) => api.post<{ started: boolean }>(`/specialists/${agentId}/learn`),
  knowledge: (agentId: string) => api.get<{ dossierId: string | null; dossierStatus: string | null; facts: Fact[]; review: Fact[]; retired?: Retired[]; size?: { active: number; target: number } | null }>(`/specialists/${agentId}/knowledge`),
  retire: (agentId: string, ref: string, reason: string) => api.post<{ changeId: string }>(`/specialists/${agentId}/knowledge/${ref}/retire`, { reason }),
  addFact: (agentId: string, content: string, source: string) => api.post<{ action: string; message: string; ref: string }>(`/specialists/${agentId}/knowledge`, { content, source }),
  goals: (agentId: string) => api.get<Goal[]>(`/specialists/${agentId}/goals`),
  addGoal: (agentId: string, question: string) => api.post<Goal>(`/specialists/${agentId}/goals`, { question }),
  setGoal: (id: string, status: Goal['status']) => api.patch<Goal>(`/specialists/goals/${id}`, { status }),
  removeGoal: (id: string) => api.del(`/specialists/goals/${id}`),
  reports: (agentId: string) => api.get<{ reports: Report[]; rounds: Round[] }>(`/specialists/${agentId}/reports`),
  makeReport: (agentId: string) => api.post<Report | null>(`/specialists/${agentId}/report`),
  undoRound: (roundId: string, index?: number) => api.post<{ undone: number; failed: string[] }>(`/specialists/rounds/${roundId}/undo`, index === undefined ? {} : { index }),
  undoReport: (reportId: string) => api.post<{ undone: number; failed: string[] }>(`/specialists/reports/${reportId}/undo`),
  seen: (reportId: string) => api.post(`/specialists/reports/${reportId}/seen`),
  proposals: (agentId: string) => api.get<Proposal[]>(`/specialists/${agentId}/proposals`),
  decide: (id: string, body: { status?: Proposal['status']; skillMd?: string; skillId?: string }) => api.post<Proposal>(`/specialists/proposals/${id}`, body),
  // Memory's own public routes (the facts live in memory).
  undoChange: (changeId: string) => api.post(`/memory/changes/${changeId}/undo`),
  forget: (itemId: string) => api.post(`/memory/items/${itemId}/forget`, { alsoSource: false }),
  approve: (itemId: string, mode: 'replace' | 'keep_both' | 'approve') => api.post(`/memory/items/${itemId}/approve`, { mode }),
  reject: (itemId: string) => api.post(`/memory/items/${itemId}/reject`),
};

/** Reload `fn` when the specialists module says something changed for this bot (or for any bot without an id). */
export function useSpecialistData<T>(fn: () => Promise<T>, agentId: string | null, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => alive && (setData(d), setError('')))
      .catch((e) => alive && setError(e?.message || String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, tick, ...deps]);
  useEffect(() => {
    const offs = [on('specialists.changed', (d: any) => (!agentId || d?.agentId === agentId) && setTick((n) => n + 1)), on('memory.updated', () => setTick((n) => n + 1))];
    return () => offs.forEach((o) => o());
  }, [agentId]);
  return { data, error, reload: () => setTick((n) => n + 1) };
}

/** Which bots are specialists (for the chat header button); one fetch, shared, refreshed on change. */
let cache: SpecialistListItem[] | null = null;
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();
function refresh() {
  loading = spApi
    .list()
    .then((l) => {
      cache = l;
    })
    .catch(() => {
      cache = cache || [];
    })
    .finally(() => {
      loading = null;
      subs.forEach((f) => f());
    });
}
export function useSpecialists(): SpecialistListItem[] {
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    subs.add(f);
    if (!cache && !loading) refresh();
    const off = on('specialists.changed', () => refresh());
    return () => {
      subs.delete(f);
      off();
    };
  }, []);
  return cache || [];
}
