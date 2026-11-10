import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../components/ui';
import { uiLocale } from '../../lib/i18n';
import { capFirst, formatUsd } from '../../lib/format';

export type Schedule =
  | { kind: 'none' }
  | { kind: 'once'; at: string }
  | { kind: 'interval'; everyMinutes: number; anchor?: string }
  | { kind: 'weekly'; days: number[]; times: string[] }
  | { kind: 'monthly'; days: (number | string)[]; times: string[]; months?: number[] }
  | { kind: 'cron'; expr: string };

export interface ChainNext {
  routineId: string;
  on: 'done' | 'always';
  passResult: boolean;
}

export interface RunOverride {
  provider_id?: string | null;
  model?: string;
  access_mode?: string;
  tool_groups?: string[] | null;
  max_turns?: number;
  deny_tools?: string[];
}

export interface RoutineOptions {
  missedPolicy: 'skip' | 'catchup';
  maxRunsPerDay: number;
  maxCostPerDayUsd: number;
  retries: number;
  pauseAfterFailures: number;
  timeoutMinutes: number;
  lastRunContext: boolean;
  lastRunChars: number;
  hideSilentRuns: boolean;
  notify: 'always' | 'errors' | 'never';
  /** Also send the result (and shared files) to a chat app, e.g. the owner's WhatsApp. */
  deliver?: { bindingId: string; to: 'owner' | string; withFiles: boolean; errors?: boolean } | null;
  override: RunOverride;
  runIn: 'thread' | 'main';
  limitPolicy: 'wait' | 'skip' | 'fail';
  maxLimitWaitHours: number;
  then: ChainNext | null;
  /** Belangrijk: never below the minimum level of Instellingen › Gratis doorschakelen; pauses until the reset instead. */
  important?: boolean;
  /** Set by a bot with wait_for: fires once on its event (or times out) and continues in that conversation. */
  waitpoint?: { kind: 'file' | 'message' | 'webhook' | 'time'; what: string; threadId: string | null; until: string; firedAt?: string | null; how?: 'event' | 'timeout' | null };
}

export interface RoutineView {
  id: string;
  user_id: string;
  agent_id: string;
  /** The team of its bot (package B4; null without teams). */
  teamId?: string | null;
  teamName?: string;
  /** Its bot's name and face from the server: an archived bot is not in the app's bot list. */
  agentName?: string | null;
  agentAvatar?: string | null;
  name: string;
  prompt: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
  paused_reason: string | null;
  schedule: Schedule;
  timezone: string;
  options: RoutineOptions;
  thread_id: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_summary: string | null;
  fail_count: number;
  created_by: 'user' | 'agent';
  created_at: string;
  updated_at: string;
  scheduleText: string;
  nextRunText: string | null;
  triggerCount: number;
  activeRun: { id: string; status: string } | null;
  triggers?: TriggerView[];
}

export interface RunView {
  id: string;
  routine_id: string;
  trigger: string;
  trigger_id: string | null;
  scheduled_for: string | null;
  status: string;
  attempt: number;
  max_attempts: number;
  next_retry_at: string | null;
  run_id: string | null;
  thread_id: string | null;
  usage: { input?: number; output?: number; cost?: number };
  summary: string;
  error: string | null;
  meta: Record<string, any>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  hasPayload: boolean;
  payload?: { source: string; label: string; data: any } | null;
  routineName?: string;
}

export interface FieldFilter {
  path: string;
  op: string;
  value?: any;
}
export interface Filters {
  fields?: FieldFilter[];
  anyKeywords?: string[];
  noneKeywords?: string[];
}

export interface TriggerView {
  id: string;
  routine_id: string;
  kind: 'webhook' | 'feed' | 'page' | 'folder' | 'email' | 'chat';
  name: string;
  preset: string;
  config: Record<string, any>;
  filters: Filters;
  secret_set_at: string | null;
  prev_valid_until: string | null;
  enabled: boolean;
  state: { lastCheck: string | null; items?: number; initialized: boolean };
  last_event_at: string | null;
  last_error: string | null;
  url?: string;
  hasSecret?: boolean;
  prevSecretActive?: boolean;
}

export interface TriggerEvent {
  id: string;
  status: string;
  event_type: string;
  summary: string;
  routine_run_id: string | null;
  created_at: string;
}

export interface Meta {
  mode: 'desktop' | 'server';
  startedAt: string;
  lastTickAt: string | null;
  timezone: string;
  timezones: string[];
  emailAvailable: boolean;
  /** Chat-message triggers (WhatsApp, Telegram, …) via the channels module. */
  chatAvailable?: boolean;
  webhookBase: string;
  webhookReachable: boolean;
  publicUrl: string | null;
  presets: { id: string; label: string; generatesSecret: boolean; help: string }[];
  defaults: RoutineOptions;
  graceMinutes: number;
  global: GlobalSettings;
}

export interface GlobalSettings {
  paused: boolean;
  maxRunsPerDay: number;
  maxCostPerDayUsd: number;
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

export function routineStatus(r: Pick<RoutineView, 'status' | 'paused_reason'>): { label: string; tone: Tone } {
  if (r.status === 'draft') return { label: 'Concept', tone: 'warn' };
  if (r.status === 'active') return { label: 'Actief', tone: 'ok' };
  if (r.status === 'completed') return { label: 'Afgerond', tone: 'neutral' };
  if (r.paused_reason?.startsWith('Automatisch')) return { label: 'Automatisch gepauzeerd', tone: 'danger' };
  return { label: 'Gepauzeerd', tone: 'neutral' };
}

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'In wachtrij', tone: 'accent' },
  running: { label: 'Bezig', tone: 'accent' },
  retrying: { label: 'Nieuwe poging gepland', tone: 'warn' },
  done: { label: 'Geslaagd', tone: 'ok' },
  // A run that said "klaar" without a result TeamBot could see (no answer, file, message or task).
  no_result: { label: 'Zonder resultaat', tone: 'warn' },
  no_update: { label: 'Niets nieuws', tone: 'neutral' },
  error: { label: 'Mislukt', tone: 'danger' },
  cancelled: { label: 'Geannuleerd', tone: 'neutral' },
  interrupted: { label: 'Onderbroken', tone: 'warn' },
  skipped: { label: 'Overgeslagen', tone: 'neutral' },
  missed: { label: 'Gemist', tone: 'warn' },
  limited: { label: 'Limiet bereikt', tone: 'warn' },
};

export const TRIGGER_LABEL: Record<string, string> = {
  schedule: 'Schema',
  catchup: 'Inhaalrun',
  manual: 'Handmatig',
  test: 'Test',
  webhook: 'Webhook',
  feed: 'Feed',
  page: 'Webpagina',
  folder: 'Map',
  email: 'E-mail',
  chat: 'Chat-bericht',
  chain: 'Na andere routine',
};

/** "Gestart door bericht van Jan via Telegram" for a run that a chat message started (empty otherwise). */
export function startedByText(rr: Pick<RunView, 'trigger' | 'meta'>): string {
  const s = rr.trigger === 'chat' ? rr.meta?.startedBy : null;
  if (!s) return '';
  const who = s.status === 'owner' ? 'jou' : s.name || 'onbekend';
  return `Gestart door bericht van ${who}${s.channel ? ` via ${s.channel}` : ''}${s.status === 'unknown' ? ' (onbekende afzender)' : ''}`;
}

/**
 * Status of a run including "waiting for the engine's limit reset" (a retrying run with meta.limitWait), "zonder
 * resultaat" (finished, but no proof) and "niet gedraaid" (the watchdog found a planned run that never started).
 */
export function runStatus(rr: Pick<RunView, 'status' | 'meta'>): { label: string; tone: Tone } {
  if (rr.status === 'retrying' && rr.meta?.limitWait) return { label: 'Wacht op limiet-reset', tone: 'warn' };
  if (rr.status === 'done' && rr.meta?.proof?.result === 'none') return RUN_STATUS.no_result;
  if (rr.status === 'missed' && rr.meta?.notRun) return { label: 'Niet gedraaid', tone: 'danger' };
  return RUN_STATUS[rr.status] || { label: rr.status, tone: 'neutral' };
}

/** What TeamBot saw a run deliver (routines/proof.ts). */
export interface RunProof {
  result: 'proven' | 'answer' | 'none';
  items: { kind: 'file' | 'message' | 'task' | 'action'; text: string }[];
  answer: boolean;
  claims: string[];
  reason: string;
}

/** "Gemist terwijl je pc uit stond": one period without TeamBot (or asleep) and what each routine missed. */
export interface MissedPeriod {
  id: string;
  from: string;
  to: string;
  kind: 'off' | 'sleep';
  routines: number;
  runs: number;
  items: { routineId: string; name: string; timezone: string; count: number; capped: boolean; first: string; last: string; outcome: 'caught_up' | 'skipped'; runId: string; status: string; result: string | null }[];
}

/** One line of "Wat niet gebeurde". */
export interface AttentionItem {
  id: string;
  routineId: string;
  name: string;
  timezone: string;
  kind: 'not_run' | 'missed' | 'error' | 'no_result' | 'limited' | 'skipped' | 'interrupted';
  status: string;
  text: string;
  at: string;
  created_at: string;
  threadId: string | null;
}

export interface RunSummary {
  since: string;
  total: number;
  counts: Record<string, number>;
  waiting: { id: string; routineId: string; routineName: string; until: string | null; reason: string }[];
}

export interface ChannelTargets {
  available: boolean;
  bindings: { id: string; name: string; adapter: string; enabled: boolean; conversations: { id: string; title: string; private: boolean }[] }[];
}

export const EVENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  accepted: { label: 'Uitgevoerd', tone: 'ok' },
  filtered: { label: 'Gefilterd', tone: 'neutral' },
  duplicate: { label: 'Dubbel', tone: 'neutral' },
  rejected: { label: 'Geweigerd', tone: 'danger' },
  limited: { label: 'Limiet', tone: 'warn' },
  paused: { label: 'Niet actief', tone: 'warn' },
  baseline: { label: 'Startpunt', tone: 'neutral' },
  error: { label: 'Fout', tone: 'danger' },
};

export const ACTIVE = ['pending', 'running', 'retrying'];

export function fmtDate(iso: string | null | undefined, tz?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(uiLocale(), { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(iso).toLocaleString(uiLocale());
  }
}

/** "14:05", or "ma 9 nov 14:05" when it is not today (in the routine's timezone). */
export function fmtTime(iso: string | null | undefined, tz?: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const day = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: tz });
    if (day(d) === day(new Date())) return d.toLocaleTimeString(uiLocale(), { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    return fmtDate(iso, tz);
  } catch {
    return fmtDate(iso, tz);
  }
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function fmtCost(c: number | undefined): string {
  return formatUsd(c || 0);
}

let metaCache: Promise<Meta> | null = null;
export function loadMeta(force = false): Promise<Meta> {
  if (!metaCache || force) metaCache = api.get<Meta>('/routines/meta').catch((e) => {
    metaCache = null;
    throw e;
  });
  return metaCache;
}

export function useMeta(): { meta: Meta | null; error: string | null; reload(): void } {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    loadMeta(n > 0)
      .then((m) => alive && (setMeta(m), setError(null)))
      .catch((e) => alive && setError(e?.message || String(e)));
    return () => {
      alive = false;
    };
  }, [n]);
  return { meta, error, reload: () => setN((x) => x + 1) };
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Gekopieerd', 'ok');
  } catch {
    toast('Kopiëren lukte niet; selecteer de tekst en kopieer handmatig', 'danger');
  }
}

export const DAY_SHORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
/** Short weekday name in the interface language (0 = Sunday): "Ma", "Mon", "Mo." — for day pickers. */
export const dayShort = (d: number) => capFirst(new Date(2024, 0, 7 + d).toLocaleDateString(uiLocale(), { weekday: 'short' }));
/** Monday-first order for pickers. */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
