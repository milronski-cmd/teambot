import { create } from 'zustand';
import { api, on } from '../../lib/api';

/** Mirrors server/modules/quality/types.ts (what a task's quality record looks like in the interface). */
export type CheckState = 'none' | 'passed' | 'review' | 'cant' | 'skipped' | 'owner';
export type TaskKind = 'room' | 'teamdata' | 'delegation';

export interface EvidenceItem {
  type: 'file' | 'link' | 'message' | 'attachment' | 'screenshot' | 'output' | 'text';
  value: string;
  ok: boolean | null;
  note: string;
}

export interface QualityView {
  doneWhen: string;
  doneWhenBy: 'agent' | 'user' | null;
  skipCheck: boolean;
  claim: { agentId: string; name: string; at: string } | null;
  outcome: 'done' | 'cant' | null;
  outcomeReason: string;
  reportedBy: { agentId: string; name: string; at: string } | null;
  evidence: EvidenceItem[];
  check: { state: CheckState; label: string; reason: string; engine: string; at: string | null };
  open: boolean;
}

export interface OpenItem extends QualityView {
  kind: TaskKind;
  ref: string;
  title: string;
}

export interface Suggestion {
  id: string;
  agent_id: string;
  agentName: string;
  title: string;
  body: string;
  count: number;
  canDraft: boolean;
  created_at: string;
}

/**
 * Per kind of task, where its owner-only actions go: the module that owns the task checks who may change it.
 * Room tasks (task board) live in rooms, team database tasks in teamdata.
 */
export const qualityActions = {
  setDoneWhen: (kind: TaskKind, ref: string, text: string) => (kind === 'room' ? api.patch(`/rooms/tasks/${ref}`, { doneWhen: text }) : api.patch(`/teamdata/tasks/${ref}`, { klaar_als: text })),
  setSkip: (kind: TaskKind, ref: string, skip: boolean) => (kind === 'room' ? api.patch(`/rooms/tasks/${ref}`, { skipCheck: skip }) : api.patch(`/quality/task/teamdata/${ref}`, { skipCheck: skip })),
  approve: (kind: TaskKind, ref: string) => (kind === 'room' ? api.post(`/rooms/tasks/${ref}/approve`, {}) : api.patch(`/teamdata/tasks/${ref}`, { status: 'klaar' })),
  reopen: (kind: TaskKind, ref: string, note: string) => api.post<{ told?: { threadId: string } | null }>(kind === 'room' ? `/rooms/tasks/${ref}/reopen` : `/teamdata/tasks/${ref}/reopen`, { note }),
  release: (ref: string) => api.post(`/rooms/tasks/${ref}/release`, {}),
};

// ---------------------------------------------------------------- what waits for the owner (Wacht op jou)

interface InboxState {
  tasks: OpenItem[];
  suggestions: Suggestion[];
  loaded: boolean;
}

export const useQualityInbox = create<InboxState>(() => ({ tasks: [], suggestions: [], loaded: false }));

let timer: ReturnType<typeof setTimeout> | null = null;

export function loadInbox() {
  api
    .get<{ tasks: OpenItem[]; suggestions: Suggestion[] }>('/quality/inbox')
    .then((r) => useQualityInbox.setState({ tasks: Array.isArray(r?.tasks) ? r.tasks : [], suggestions: Array.isArray(r?.suggestions) ? r.suggestions : [], loaded: true }))
    .catch(() => useQualityInbox.setState({ loaded: true }));
}

const soon = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(loadInbox, 250);
};

/** Subscribe once after login: the list stays live (a bot reports a task, the owner decides elsewhere). */
export function initQuality() {
  loadInbox();
  const offs = [on('quality.changed', soon), on('rooms.task', soon), on('teamdata.changed', soon)];
  return () => offs.forEach((f) => f());
}

export function useQualityCount() {
  return useQualityInbox((s) => s.tasks.length + s.suggestions.length);
}

/** One task's quality record (team database tasks; board tasks carry it in their own view). */
export function fetchQuality(kind: TaskKind, ref: string) {
  return api.get<QualityView & { steps: { tool: string; summary: string; ok: boolean }[] }>(`/quality/task/${kind}/${ref}`);
}
