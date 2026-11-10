import { useCallback, useEffect, useState } from 'react';
import { api, on } from '../../lib/api';

/** Same shapes as server/modules/workflows/types.ts. */
export type Step =
  | { id: string; kind: 'bot'; title: string; agentId: string; prompt: string }
  | { id: string; kind: 'approval'; title: string; note: string }
  | { id: string; kind: 'condition'; title: string; test: 'contains' | 'not_contains' | 'starts_with'; value: string; otherwise: 'stop' | 'goto'; gotoStep: string }
  | { id: string; kind: 'notify'; title: string };

export type Schedule = { kind: 'none' } | { kind: 'daily'; time: string } | { kind: 'weekly'; time: string; days: number[] };
export type RunStatus = 'running' | 'waiting' | 'done' | 'error' | 'stopped' | 'interrupted';

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: Step[];
  schedule: Schedule;
  enabled: boolean;
  version: number;
  webhook: boolean;
  created_by: string;
  nextRun: string | null;
  lastRun: { id: string; status: RunStatus; created_at: string; finished_at: string | null } | null;
  updated_at: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  inputHint: string;
  steps: number;
}

export interface TraceItem {
  stepId: string;
  kind: Step['kind'];
  title: string;
  status: 'running' | 'waiting' | 'done' | 'error' | 'denied' | 'failed_check' | 'stopped' | 'interrupted';
  agentId?: string;
  threadId?: string;
  output: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface Run {
  id: string;
  workflow_id: string;
  workflowName: string;
  status: RunStatus;
  trigger: 'manual' | 'bot' | 'schedule' | 'webhook';
  started_by: string;
  input: string;
  version: number;
  steps: Step[];
  trace: TraceItem[];
  result: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface RunRow {
  id: string;
  status: RunStatus;
  trigger: Run['trigger'];
  started_by: string;
  input: string;
  version: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface Version {
  version: number;
  name: string;
  steps: Step[];
  created_at: string;
  current: boolean;
}

export const STATUS_TEXT: Record<RunStatus, string> = { running: 'Bezig', waiting: 'Wacht op jou', done: 'Klaar', error: 'Vastgelopen', stopped: 'Gestopt', interrupted: 'Onderbroken' };
export const STATUS_TONE: Record<RunStatus, 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'> = { running: 'accent', waiting: 'warn', done: 'ok', error: 'danger', stopped: 'neutral', interrupted: 'warn' };
export const TRIGGER_TEXT: Record<Run['trigger'], string> = { manual: 'Zelf gestart', bot: 'Gestart door een bot', schedule: 'Volgens schema', webhook: 'Webhook' };
export const DAY_NAMES = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];

export const newStepId = () => `st_${Math.random().toString(36).slice(2, 10)}`;

/** The workflows and templates, kept fresh by the server's events. */
export function useWorkflows() {
  const [data, setData] = useState<{ workflows: Workflow[]; templates: Template[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .get<{ workflows: Workflow[]; templates: Template[] }>('/workflows')
      .then((d) => (setData(d), setError(null)))
      .catch((e) => setError(e?.message || String(e)));
  }, []);
  useEffect(() => {
    load();
    const off1 = on('workflow.updated', load);
    const off2 = on('workflowRun.updated', load);
    return () => {
      off1();
      off2();
    };
  }, [load]);
  return { data, error, reload: load };
}

/** One run, live. */
export function useRun(id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setRun(null);
    setError(null);
    // Without an id the address is the list of busy runs (not a run): the page crashed on it.
    if (!id) return setError('Open een run vanaf de pagina Workflows.');
    api
      .get<Run>(`/workflow-runs/${id}`)
      .then((r) => alive && setRun(r))
      .catch((e) => alive && setError(e?.message || String(e)));
    const off = on('workflowRun.updated', (r: Run) => r?.id === id && alive && setRun(r));
    return () => {
      alive = false;
      off();
    };
  }, [id]);
  return { run, error };
}
