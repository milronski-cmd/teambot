import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api, on, wsConnected } from '../../lib/api';
import { t, translate, uiLocale } from '../../lib/i18n';
import { formatDuration, formatPercent, formatUsd, relativeTime } from '../../lib/format';

export type LimitLevel = 'ok' | 'warn' | 'limit' | 'unknown';

export interface LimitWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: number | null;
  level: LimitLevel;
  at: number;
}

export interface Spend {
  calls: number;
  tokens: number;
  cost: number;
  /** Estimated value at list price; null = unknown (the engine did not report one). */
  value: number | null;
}

export interface EngineView {
  providerId: string;
  name: string;
  kind: string;
  kindLabel: string;
  type: 'api' | 'cli';
  enabled: boolean;
  billing: 'subscription' | 'paid' | 'free' | 'local' | 'unknown';
  billingPath: string;
  plan: string | null;
  note: string | null;
  windows: LimitWindow[];
  worst: LimitWindow | null;
  blocked: { at: number; until: number | null; label?: string } | null;
  pausedUntil: number | null;
  canRead: boolean;
  reading: boolean;
  source: 'stream' | 'usage-command' | 'app-server' | 'error' | 'stats' | null;
  updatedAt: number | null;
  checkedAt: number | null;
  error: string | null;
  unsupported: string | null;
  stats: { input: number; output: number; cost: number; sessions: number } | null;
  spend: { today: Spend; week: Spend };
}

export interface AlertSettings {
  enabled: boolean;
  warnAt: number;
}

export interface ContextView {
  kind: 'engine' | 'history' | 'none';
  engine?: string;
  used?: number | null;
  window?: number | null;
  percent?: number | null;
  at?: number | null;
  estimated?: boolean;
  canCompact?: boolean;
  compactNote?: string;
  note?: string | null;
}

interface UsageState {
  engines: EngineView[] | null;
  alerts: AlertSettings | null;
  loadedAt: number;
  load(refresh?: boolean): Promise<void>;
  refreshOne(providerId: string): Promise<void>;
  setAlerts(a: Partial<AlertSettings>): Promise<void>;
}

export const useUsage = create<UsageState>((set, get) => ({
  engines: null,
  alerts: null,
  loadedAt: 0,
  async load(refresh = false) {
    const r = await api.get<{ engines: EngineView[]; alerts: AlertSettings }>(`/usage/limits${refresh ? '?refresh=1' : ''}`);
    set({ engines: r.engines, alerts: r.alerts, loadedAt: Date.now() });
  },
  async refreshOne(providerId) {
    set({ engines: (get().engines || []).map((e) => (e.providerId === providerId ? { ...e, reading: true } : e)) });
    try {
      const e = await api.post<EngineView>(`/usage/limits/${providerId}/refresh`);
      set({ engines: (get().engines || []).map((x) => (x.providerId === providerId ? e : x)) });
    } catch (err) {
      set({ engines: (get().engines || []).map((x) => (x.providerId === providerId ? { ...x, reading: false } : x)) });
      throw err;
    }
  },
  async setAlerts(a) {
    set({ alerts: await api.put<AlertSettings>('/usage/alerts', a) });
  },
}));

// ---------------- the always-visible usage bar ----------------

export interface BarWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: number | null;
  level: LimitLevel;
  at: number;
  /** TeamBot derived the number (no exact figure from the provider): "schatting". */
  estimated: boolean;
  /** The weekly reserve of the free-model chain starts here (a mark on the bar); null = none. */
  reserveAt: number | null;
  reserveActive: boolean;
}

export interface BarEngine {
  providerId: string;
  name: string;
  kind: string;
  family: 'claude' | 'codex' | 'other';
  plan: string | null;
  windows: BarWindow[];
  blocked: { until: number | null; estimated: boolean } | null;
  pausedUntil: number | null;
  updatedAt: number | null;
  checkedAt: number | null;
  reading: boolean;
  canRead: boolean;
  error: string | null;
}

export interface BarSource {
  id: string;
  label: string;
  status: 'available' | 'low' | 'limited' | 'offline' | 'unknown';
  resetsAt: number | null;
  usedPercent: number | null;
  estimated: boolean;
  note: string | null;
  providerId: string | null;
  kind: 'free' | 'local';
  origin: 'engine' | 'reported';
  at: number;
}

export interface BarView {
  engines: BarEngine[];
  sources: BarSource[];
  now: number;
}

interface BarState {
  bar: BarView | null;
  /** When the CLIs were last asked to read (refresh=1), so several bars and windows do not ask twice. */
  askedAt: number;
  load(refresh?: boolean): Promise<void>;
  /** "Vernieuwen": ask every readable engine now, whatever its age. */
  refreshAll(): Promise<void>;
}

export const useUsageBar = create<BarState>((set, get) => ({
  bar: null,
  askedAt: 0,
  async load(refresh = false) {
    if (refresh) set({ askedAt: Date.now() });
    set({ bar: await api.get<BarView>(`/usage/bar${refresh ? '?refresh=1' : ''}`) });
  },
  async refreshAll() {
    const ids = (get().bar?.engines || []).filter((e) => e.canRead).map((e) => e.providerId);
    set({ askedAt: Date.now() });
    await Promise.allSettled(ids.map((id) => api.post(`/usage/limits/${id}/refresh`)));
    await get().load();
  },
}));

/**
 * Ask the CLIs again when their numbers may be older than this (the server keeps its own cache too: a minute, 20
 * seconds while a bot works on that engine).
 */
const ASK_AFTER_MS = 60_000;
/** While TeamBot is in view, ask now and then, so use outside TeamBot (the Claude app, a terminal) shows up too. */
const ASK_EVERY_MS = 3 * 60_000;

/**
 * The bar's data, kept live: usage.updated events (WebSocket) reload it right away; once a minute the countdowns move
 * on, a cheap reload of stored numbers runs when the WebSocket is down, and every three minutes in view (or when the
 * window comes back into view after one) the CLIs are asked again. Reading costs no quota. Work by the bots needs no
 * asking from here: the server reads an engine once a minute while a bot works on it and three seconds after a run
 * ends (server/modules/usage/service.ts), and tells it with usage.updated.
 */
export function useLiveUsageBar(): BarView | null {
  const bar = useUsageBar((s) => s.bar);
  const [, setTick] = useState(0);
  useEffect(() => {
    const st = useUsageBar.getState;
    const ask = (after: number) => {
      if (Date.now() - st().askedAt < after) return false;
      st().load(true).catch(() => {});
      return true;
    };
    if (!ask(ASK_AFTER_MS) && !st().bar) st().load().catch(() => {});
    const iv = setInterval(() => {
      setTick((x) => x + 1);
      if (document.visibilityState !== 'visible') return;
      if (!wsConnected) st().load().catch(() => {});
      ask(ASK_EVERY_MS);
    }, 60_000);
    const back = () => document.visibilityState === 'visible' && ask(ASK_AFTER_MS);
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
    };
  }, []);
  return bar;
}

// ---------------- usage per bot ----------------

export interface BreakdownRow {
  key: string;
  /** team: per team (`by=team`), its bots in `children`; none there = work without a team. */
  kind: 'bot' | 'deleted' | 'none' | 'team';
  id: string | null;
  name: string | null;
  avatar: string;
  color: string;
  today: Spend;
  week: Spend;
  engines: { providerId: string | null; name: string | null; billing: 'subscription' | 'paid' | 'free' | 'local' | 'unknown'; today: Spend; week: Spend }[];
  children?: BreakdownRow[];
}

export interface Breakdown {
  by: 'bot' | 'team';
  groupings: string[];
  since: { today: string; week: string };
  rows: BreakdownRow[];
  total: { today: Spend; week: Spend };
}

/** Usage per bot or per team (today, this week), reloaded when a run ends. */
export function useBreakdown(by: 'bot' | 'team' = 'bot') {
  const [data, setData] = useState<Breakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .get<Breakdown>(`/usage/breakdown?by=${by}`)
      .then((r) => alive && (setData(r), setError(null)))
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => {
      alive = false;
    };
  }, [n, by]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = on('usage.spend', () => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        setN((x) => x + 1);
      }, 1500);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, []);
  return { data, error, reload: () => setN((x) => x + 1) };
}

let wired = false;
/** Live: an engine or a free source reported new numbers → reload what is shown (batched). */
export function wireUsageEvents() {
  if (wired) return () => {};
  wired = true;
  let t: ReturnType<typeof setTimeout> | null = null;
  let tb: ReturnType<typeof setTimeout> | null = null;
  const offs = [
    on('usage.updated', () => {
      if (useUsageBar.getState().bar && !tb)
        tb = setTimeout(() => {
          tb = null;
          useUsageBar.getState().load().catch(() => {});
        }, 150);
      if (!useUsage.getState().engines || t) return;
      t = setTimeout(() => {
        t = null;
        useUsage.getState().load().catch(() => {});
      }, 400);
    }),
    // Back online after a break: catch up on what was missed.
    on('ws.status', (d: any) => d?.connected && useUsageBar.getState().bar && useUsageBar.getState().load().catch(() => {})),
  ];
  return () => {
    offs.forEach((f) => f());
    if (t) clearTimeout(t);
    if (tb) clearTimeout(tb);
    wired = false;
  };
}

/** The context ring data of one bot in one chat, live after each turn. */
export function useChatContext(threadId: string, agentId: string | null | undefined, runsBusy: boolean) {
  const [c, setC] = useState<ContextView | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    api
      .get<ContextView>(`/usage/context/${threadId}?agentId=${encodeURIComponent(agentId)}`)
      .then((v) => alive && setC(v))
      .catch(() => alive && setC(null));
    return () => {
      alive = false;
    };
  }, [threadId, agentId, n, runsBusy]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = (d: any) => {
      if ((d?.threadId || d?.thread_id) !== threadId || t) return;
      t = setTimeout(() => {
        t = null;
        setN((x) => x + 1);
      }, 600);
    };
    const offs = [on('usage.context', bump), on('message.created', bump)];
    return () => {
      offs.forEach((f) => f());
      if (t) clearTimeout(t);
    };
  }, [threadId]);
  return { context: c, reload: () => setN((x) => x + 1) };
}

// ---------------- formatting ----------------

export const fmtTokens = (n: number | null | undefined) => (typeof n === 'number' ? n.toLocaleString(uiLocale()) : 'onbekend');
export const fmtPct = (n: number | null | undefined) => (typeof n === 'number' ? formatPercent(n) : 'onbekend');

export function fmtUsd(n: number | null | undefined) {
  if (typeof n !== 'number') return 'onbekend';
  return formatUsd(n, n !== 0 && n < 0.1 ? { min: 3, max: 3 } : {});
}

/** "vandaag 14:30", "morgen 05:59", "do 13 nov 05:59". */
export function fmtWhen(ms: number | null | undefined) {
  if (!ms) return 'onbekend';
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  // Whole texts in the interface language: these go into other sentences as a value ("weer beschikbaar {0}").
  if (diff === 0) return t('vandaag {0}', time);
  if (diff === 1) return t('morgen {0}', time);
  return `${d.toLocaleDateString(uiLocale(), { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** "nog 2 u 13 min", "nog 4 dagen". */
export function fmtLeft(ms: number | null | undefined) {
  if (!ms) return '';
  const left = ms - Date.now();
  if (left <= 0) return translate('nu');
  const min = Math.round(left / 60_000);
  if (min < 60) return t('nog {0}', formatDuration(min, 'minute'));
  const h = Math.floor(min / 60);
  if (h < 48) return t('nog {0}', min % 60 ? `${formatDuration(h, 'hour')} ${formatDuration(min % 60, 'minute')}` : formatDuration(h, 'hour'));
  return t('nog {0}', formatDuration(Math.round(h / 24), 'day'));
}

export function fmtAgo(ms: number | null | undefined) {
  if (!ms) return translate('nog niet');
  return Date.now() - ms < 86_400_000 ? relativeTime(ms) : new Date(ms).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' });
}

export const BILLING_TEXT: Record<EngineView['billing'], string> = {
  subscription: 'via abonnement',
  paid: 'betaald per gebruik',
  free: 'gratis',
  local: 'lokaal, gratis',
  unknown: 'facturering onbekend',
};

export const SOURCE_TEXT: Record<NonNullable<EngineView['source']>, string> = {
  stream: 'gemeld tijdens een beurt',
  'usage-command': 'opgevraagd met /usage',
  'app-server': 'opgevraagd bij de Codex app-server',
  error: 'uit een foutmelding',
  stats: 'uit de statistieken van de CLI',
};

/** Tone for a percentage (context or limit). */
export function toneOf(pct: number | null | undefined, level?: LimitLevel): 'muted' | 'fg' | 'warn' | 'danger' {
  if (level === 'limit') return 'danger';
  if (typeof pct !== 'number') return 'muted';
  if (pct >= 95) return 'danger';
  if (pct >= 80 || level === 'warn') return 'warn';
  return 'fg';
}
