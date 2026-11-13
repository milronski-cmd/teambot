import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api, on } from '../../lib/api';
import type { ImportResult } from '../../../../shared/teamdata.js';

// Mirrors server/modules/teamdata (JSON returned by /api/teamdata/*). Rows keep whatever columns the table has.

export interface Summary {
  decisions: Record<string, number>;
  openDecisions: number;
  tasks: Record<string, number>;
  waitingTasks: number;
  experiments: Record<string, number>;
  unprocessedEvents: number;
  logToday: number;
}

export interface DecisionOption {
  key: string;
  text: string;
  answer: string;
}

export interface Decision {
  id: number;
  vraag: string;
  uitleg: string;
  opties: string;
  options: DecisionOption[];
  gevraagd_door: string;
  asker: { id: string; name: string; avatar: string } | null;
  status: string;
  antwoord: string;
  vervangt_id: number | null;
  aangemaakt: string;
  beslist: string;
  /** The team whose database holds this decision (answer with it). */
  teamId: string | null;
  teamName: string;
  extra: Record<string, any>;
}

export interface DecideResult {
  decision: Decision;
  woke: { agentId: string; name: string; threadId: string; mode: 'sent' | 'queued' | 'steered' | 'answered' | 'interrupted' } | null;
  notice: string;
}

export type Row = Record<string, any> & { id: number };

export interface Facet {
  v: string | null;
  n: number;
}

export interface LogPage {
  rows: Row[];
  next: number | null;
  agents: Facet[] | null;
  sites: Facet[] | null;
  total: number | null;
}

export interface EventPage {
  rows: Row[];
  next: number | null;
  soorten: Facet[] | null;
  total: number | null;
}

export interface TableInfo {
  name: string;
  type: 'table' | 'view';
  sql: string;
  rows: number | null;
  standard: boolean;
  label: string;
  about: string;
  owner: { type: 'system' | 'agent' | 'user'; id: string | null; name: string };
}

export interface AuditRow {
  id: number;
  actor_type: string;
  actor_id: string | null;
  actor_name: string;
  verb: string;
  table_name: string | null;
  sql: string;
  changes: number | null;
  row_id: number | null;
  error: string | null;
  created_at: string;
}

/**
 * Teams (0.4, B2): every team has its own team database. The team the Teamwerk page shows ('' = the default team);
 * the picker in the page header sets it (only from the second team on). Decisions and the badge count every team.
 */
export const useTeamPick = create<{ team: string; set(team: string): void }>((set) => ({ team: '', set: (team) => set({ team }) }));
/** `&team=…` (or `?team=…`) for the picked team, empty for the default team. */
const tq = (sep: '?' | '&') => {
  const t = useTeamPick.getState().team;
  return t ? `${sep}team=${encodeURIComponent(t)}` : '';
};

/** How the quality module names a task of the picked team's database (`<teamId>:<id>`; the default team: the id). */
export const teamTaskRef = (id: number | string) => {
  const t = useTeamPick.getState().team;
  return t ? `${t}:${id}` : String(id);
};

export const teamApi = {
  /** `team`: one team ('all' or empty: every team). */
  summary: (team = '') => api.get<Summary>(`/teamdata/summary${team ? `?team=${encodeURIComponent(team)}` : ''}`),
  /** `team`: one team ('all' or empty: every team, each decision with its teamId). */
  decisions: (status: 'open' | 'closed' | 'all' = 'open', q = '', team = '') => api.get<Decision[]>(`/teamdata/decisions?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}${team ? `&team=${encodeURIComponent(team)}` : ''}`),
  decide: (id: number, body: { choice?: number; answer?: string; note?: string; expire?: boolean }, teamId?: string | null) => api.post<DecideResult>(`/teamdata/decisions/${id}/answer`, teamId ? { ...body, teamId } : body),
  tasks: () => api.get<Row[]>(`/teamdata/tasks${tq('?')}`),
  setTaskStatus: (id: number, status: string) => api.patch<Row>(`/teamdata/tasks/${id}${tq('?')}`, { status }),
  log: (p: Record<string, string | number | undefined>) => api.get<LogPage>(`/teamdata/log?${qs(p)}${tq('&')}`),
  events: (p: Record<string, string | number | undefined>) => api.get<EventPage>(`/teamdata/events?${qs(p)}${tq('&')}`),
  experiments: () => api.get<Row[]>(`/teamdata/experiments${tq('?')}`),
  tables: () => api.get<TableInfo[]>(`/teamdata/tables${tq('?')}`),
  table: (name: string, offset = 0, limit = 50) =>
    api.get<{ table: TableInfo; columns: string[]; rows: Record<string, any>[]; offset: number; limit: number; total: number | null }>(`/teamdata/tables/${encodeURIComponent(name)}?offset=${offset}&limit=${limit}${tq('&')}`),
  audit: () => api.get<AuditRow[]>(`/teamdata/audit?limit=60${tq('&')}`),
  /** A CSV or Excel attachment into a table of the picked team (server/modules/teamdata/import-file.ts). */
  importFile: (attachmentId: string) => api.post<ImportResult>('/teamdata/import', { attachmentId, teamId: pickedTeam() }),
  undoImport: (source: string) => api.post<{ name: string; removed: number; dropped: boolean }[]>('/teamdata/import/undo', { source, teamId: pickedTeam() }),
};

const pickedTeam = () => {
  const t = useTeamPick.getState().team;
  return t && t !== 'all' ? t : null;
};

function qs(p: Record<string, string | number | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '' && v !== 0) u.set(k, String(v));
  return u.toString();
}

/** Counts for the navigation badge and the page header, refreshed whenever a bot (or the owner) changes the tables. */
export const useTeamSummary = create<{ s: Summary | null; load(): Promise<void> }>((set) => ({
  s: null,
  async load() {
    try {
      set({ s: await teamApi.summary() });
    } catch {
      /* offline or no access: keep the last counts */
    }
  },
}));

let timer: ReturnType<typeof setTimeout> | null = null;
export function initTeamSummary() {
  void useTeamSummary.getState().load();
  return on('teamdata.changed', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void useTeamSummary.getState().load(), 300);
  });
}

/** The counts of the team picked in Teamwerk (every team while none is picked), live. */
export function usePickedSummary(): Summary | null {
  const team = useTeamPick((x) => x.team);
  const all = useTeamSummary((x) => x.s);
  const [one, setOne] = useState<Summary | null>(null);
  const load = () => {
    if (team) teamApi.summary(team).then(setOne, () => setOne(null));
  };
  useEffect(() => {
    setOne(null);
    load();
  }, [team]);
  useTeamChanged([], load);
  return team ? one : all;
}

/** Reload when one of `tables` changes (debounced); `fn` must be stable enough (latest one is used). */
export function useTeamChanged(tables: string[], fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  const key = tables.join(',');
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = on('teamdata.changed', (d: { tables?: string[] }) => {
      // No tables given: every change counts.
      if (key && d?.tables && !d.tables.some((x) => key.split(',').includes(x))) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => ref.current(), 400);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [key]);
}
