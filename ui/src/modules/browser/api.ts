import { useEffect, useRef, useState } from 'react';
import { api, on } from '../../lib/api';
import { uiLocale } from '../../lib/i18n';
import { formatBytes, formatNumber } from '../../lib/format';

export type ModeId = 'none' | 'workspace' | 'browser' | 'host' | 'container' | 'remote';

/** Own server over SSH. The key/password itself is never sent to the browser: only whether one is stored. */
export interface RemoteConfig {
  host: string;
  port: number;
  username: string;
  auth: 'key' | 'password';
  secret_name: string | null;
  has_secret: boolean;
  fingerprint: string | null;
  dir: string;
  workdir: string;
  docker: { enabled: boolean; image: string; memoryMb: number; cpus: number };
  limits: { timeoutSec: number; maxOutputKb: number; transferMb: number };
}

export interface RemoteTestResult {
  ok: boolean;
  host: string;
  port: number;
  username: string;
  fingerprint: string | null;
  trusted: boolean;
  mismatch?: boolean;
  expected?: string | null;
  windows?: boolean;
  os?: string;
  docker?: { installed: boolean; usable: boolean; version: string | null };
  message?: string;
  error?: string;
}

export type VmStatus = 'creating' | 'booting' | 'running' | 'stopping' | 'off' | 'starting' | 'deleting' | 'deleted' | 'error';

export interface CloudEstimate {
  currency: string;
  serverMonthlyGross: number;
  ipv4MonthlyGross: number | null;
  ipv4Included: boolean;
  totalMonthlyGross: number;
  totalMonthlyNet: number;
  hourlyGross: number;
  /** false: plus VAT/sales tax on the provider's invoice */
  taxIncluded: boolean;
  gpu: boolean;
  confirm: string;
}

export interface CloudVm {
  id: string;
  agent_id: string | null;
  agent_name: string;
  provider: string;
  name: string;
  server_type: string;
  location: string;
  image: string;
  ip: string | null;
  status: VmStatus;
  detail: string;
  host_fingerprint: string;
  docker: boolean;
  price: Partial<CloudEstimate>;
  created_at: string;
  ready_at: string | null;
}

export interface CloudProviderInfo {
  id: string;
  label: string;
  has_token: boolean;
  allowed: boolean;
  reason?: string;
}

export interface CloudOptions {
  currency: string;
  pricesIncludeTax?: boolean;
  ipv4Included?: boolean;
  locations: { name: string; description: string; city: string; country: string }[];
  types: {
    name: string;
    description: string;
    cores: number;
    memoryGb: number;
    diskGb: number;
    architecture: string;
    group?: 'standard' | 'gpu';
    gpu?: { count: number; model: string; vramGb: number };
    prices: Record<string, { monthlyNet: number; monthlyGross: number; hourlyGross: number }>;
  }[];
  images: { name: string; description: string }[];
  defaults: { location: string; serverType: string; image: string } | null;
}

export const VM_STATUS: Record<VmStatus, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'accent' }> = {
  creating: { label: 'Wordt aangemaakt…', tone: 'accent' },
  booting: { label: 'Start op…', tone: 'accent' },
  running: { label: 'Draait', tone: 'ok' },
  stopping: { label: 'Wordt uitgezet…', tone: 'warn' },
  off: { label: 'Uit (kost nog steeds geld)', tone: 'warn' },
  starting: { label: 'Wordt aangezet…', tone: 'accent' },
  deleting: { label: 'Wordt verwijderd…', tone: 'warn' },
  deleted: { label: 'Verwijderd', tone: 'neutral' },
  error: { label: 'Fout', tone: 'danger' },
};

export function fmtMoney(n: number | undefined, currency = 'EUR') {
  if (n === undefined || n === null || !Number.isFinite(n)) return '?';
  try {
    return new Intl.NumberFormat(uiLocale(), { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

/** Desktop access level: ask every action / once per task / full access within the allowed scope. */
export type HostLevel = 'every' | 'task' | 'auto';

export const LEVELS: { id: HostLevel; label: string; text: string }[] = [
  { id: 'every', label: 'Vraag bij elke actie', text: 'Elke klik, toets of typactie vraagt eerst jouw goedkeuring met een schermvoorbeeld. Veilig, maar langzaam.' },
  { id: 'task', label: 'Vraag één keer per taak', text: 'De bot vraagt aan het begin van een taak toestemming (doel, apps, maximale tijd) en werkt daarbinnen zelfstandig.' },
  { id: 'auto', label: 'Volledige toegang', text: 'De bot werkt zelfstandig binnen de toegestane apps, zonder per actie te vragen (zoals “Full access” in OpenBot).' },
];

export interface HostOptions {
  screen: 'apps' | 'full';
  pauseOnInput: boolean;
  taskMinutes: number;
  blockWords: string[];
  maxPerMinute: number;
  monitor: number;
  allApps: boolean;
}

export interface DesktopGrant {
  goal: string;
  until: string;
  apps: string[];
  actions: number;
  threadId: string;
}

export interface ScreenInfo {
  enabled: boolean;
  level: HostLevel;
  levelLabel: string;
  options: HostOptions;
  apps: string[];
  stopped: boolean;
  controller: Controller | null;
  mine: boolean;
  botActive: boolean;
  grant: DesktopGrant | null;
  hotkey: string | null;
  monitors: { index: number; x: number; y: number; w: number; h: number; primary: boolean; dpi: number }[];
  viewers: number;
}

export interface ComputerConfig {
  agent_id: string;
  mode: ModeId;
  profile_id: string | null;
  allow_domains: string[];
  deny_domains: string[];
  allow_private: boolean;
  host_control: boolean;
  host_apps: string[];
  host_level: HostLevel;
  host_options: HostOptions;
  container: { image: string; network: 'none' | 'bridge'; memoryMb: number; cpus: number };
  limits: { downloadMb: number; idleMin: number };
  remote: RemoteConfig;
  derived?: boolean;
}

export interface Controller {
  kind: 'bot' | 'user';
  name: string;
  agentId: string | null;
  userId: string | null;
  since: string;
  sticky: boolean;
  waiting: string[];
}

export interface ComputerStatus {
  agentId: string;
  mode: ModeId;
  profileId: string | null;
  profileShared: boolean;
  profileName?: string | null;
  browser: {
    running: boolean;
    headed?: boolean;
    /** inside TeamBot (invisible tabs in the app) or an installed Edge/Chrome */
    engine?: BrowserEngine;
    /** memory of this browser's own processes (in-app browsers) */
    memoryMb?: number | null;
    tabs?: BrowserTab[];
    url?: string;
    title?: string;
    since?: string;
    viewers?: number;
    /** TeamBot is filling a vault login right now (the live view pauses) */
    filling?: boolean;
  };
  controller: Controller | null;
  host: { enabled: boolean; stopped?: boolean; controller?: Controller | null; apps?: string[]; level?: HostLevel; allApps?: boolean; grant?: DesktopGrant | null; hotkey?: string | null };
  remote: { host: string; port: number; username: string; configured: boolean; hasSecret: boolean; trusted: boolean; connected: boolean; docker: boolean; cloud: boolean; controller: Controller | null } | null;
  rehearsal: Rehearsal | null;
}

export interface BrowserTab {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

/** A login in the vault. The password and the 2FA secret never come back from the server. */
export interface VaultEntry {
  id: string;
  label: string;
  origins: string[];
  username: string;
  has_password: boolean;
  has_totp: boolean;
  /** an http:// address other than this computer: the password would travel unencrypted */
  insecure: boolean;
  /** bots that may ask for this login ([] = all your bots) */
  agent_ids: string[];
  /** "always allow for this bot on this site" */
  grants: { agent_id: string; origin: string; created_at: string }[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface VaultDraft {
  label?: string;
  origins?: string;
  username?: string;
  /** write-only: empty = keep the stored one */
  password?: string;
  /** write-only: base32 or otpauth:// link; null = remove */
  totp?: string | null;
  agent_ids?: string[];
}

/** One row of a CSV import preview (no password, no 2FA key). */
export interface VaultImportRow {
  index: number;
  /** row number as a spreadsheet shows it (header = 1) */
  line: number;
  label: string;
  origins: string[];
  username: string;
  has_totp: boolean;
  insecure: boolean;
  /** new = can be imported · duplicate = already in the vault or twice in the file · skip = not a usable login */
  status: 'new' | 'duplicate' | 'skip';
  reason?: string;
  warning?: string;
}

export interface VaultImportPreview {
  handle: string;
  format: { id: string; label: string };
  expires_at: string;
  /** how many more logins fit in the vault */
  room: number;
  rows: VaultImportRow[];
}

export interface VaultImportResult {
  imported: number;
  skipped: { line: number; label: string; reason: string }[];
}

/** Same limit as the server (vault-import.ts). */
export const VAULT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export const vault = {
  list: () => api.get<VaultEntry[]>('/computers/vault'),
  /** the CSV text goes once to TeamBot, which parses it in memory; the answer never holds a password */
  importPreview: (csv: string) => api.post<VaultImportPreview>('/computers/vault/import/preview', { csv }),
  importRun: (handle: string, rows: number[]) => api.post<VaultImportResult>('/computers/vault/import', { handle, rows }),
  create: (d: VaultDraft) => api.post<VaultEntry>('/computers/vault', d),
  update: (id: string, d: VaultDraft) => api.put<VaultEntry>(`/computers/vault/${id}`, d),
  remove: (id: string) => api.del(`/computers/vault/${id}`),
  revoke: (id: string, agentId: string) => api.del<VaultEntry>(`/computers/vault/${id}/grants/${agentId}`),
};

export const browserApi = {
  start: (agentId: string, url?: string) => api.post<{ ok: boolean; url: string }>(`/computers/${agentId}/browser/start`, url ? { url } : {}),
  close: (agentId: string) => api.post(`/computers/${agentId}/browser/close`, {}),
  input: (agentId: string, body: any) => api.post<{ ok: boolean; url: string }>(`/computers/${agentId}/input`, body),
  logoutSite: (agentId: string, site: string) => api.post<{ ok: boolean; site: string }>(`/computers/${agentId}/browser/logout-site`, { site }),
  profileSites: (profileId: string) => api.get<{ site: string; cookies: number }[]>(`/computers/profiles/${profileId}/sites`),
  profileLogout: (profileId: string, site: string) => api.post(`/computers/profiles/${profileId}/logout`, { site }),
  profileMembers: (profileId: string, agentIds: string[]) => api.put<{ profile: Profile; members: string[] }>(`/computers/profiles/${profileId}/members`, { agent_ids: agentIds }),
  wipeProfile: (profileId: string) => api.post(`/computers/profiles/${profileId}/wipe`, {}),
};

/** "accounts.google.com" → "google.com" (same rule as the server: rough registrable domain). */
export function siteOf(input: string): string {
  let d = String(input || '').trim().toLowerCase();
  try {
    if (d.includes('://')) d = new URL(d).hostname;
  } catch {
    return d;
  }
  d = d.replace(/^\.+/, '').replace(/\.$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(d) || d.includes(':') || !d.includes('.')) return d;
  const parts = d.split('.');
  if (parts.length <= 2) return d;
  const sld = parts[parts.length - 2];
  const n = parts[parts.length - 1].length === 2 && ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'or', 'ne', 'go'].includes(sld) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export interface Rehearsal {
  id: string;
  agent_id: string;
  original: string;
  copy_dir: string;
  status: 'active' | 'review' | 'applied' | 'discarded';
  note: string;
  files: number;
  skipped: number;
  created_at: string;
  finished_at: string | null;
}

export interface FileChange {
  /** for 'moved': the new place */
  path: string;
  /** for 'moved': the old place (applied or rejected together with the new one) */
  from?: string;
  change: 'added' | 'modified' | 'deleted' | 'moved';
  /** for 'moved': the content changed on the way too */
  edited?: boolean;
  /** 'deleted'/'added' that look like one replaced file: the other half (the deletion waits for it) */
  related?: string[];
  conflict: boolean;
  binary: boolean;
  size?: number;
}

/** A deletion the server did not apply: its content would only be left in a new file not in the real folder yet. */
export interface HeldDeletion {
  path: string;
  keptFor: string;
}

export interface Snapshot {
  id: string;
  agent_id: string;
  label: string;
  auto: boolean;
  partial: boolean;
  files: number;
  bytes: number;
  created_at: string;
}

export interface Action {
  id: string;
  agent_id: string;
  thread_id: string | null;
  actor: 'bot' | 'user' | 'system';
  actor_name: string;
  tool: string;
  summary: string;
  url: string;
  status: string;
  frame: string | null;
  created_at: string;
}

export interface Capability {
  id: string;
  label: string;
  status: 'available' | 'missing' | 'unsupported' | 'unknown';
  detail: string;
  howTo?: string;
  isolation: string;
}

export interface ModeInfo {
  id: ModeId;
  label: string;
  description: string;
  available: boolean;
  isolation: string;
  missing?: string[];
}

export interface Capabilities {
  platform: string;
  osName: string;
  isWindowsHome: boolean;
  appMode: 'desktop' | 'server';
  detectedAt: string;
  browsers: { name: string; path?: string }[];
  caps: Capability[];
  modes: ModeInfo[];
  canAllowPrivate: boolean;
  isOwner: boolean;
  engine?: EngineView;
}

export type BrowserEngine = 'app' | 'external';

/** "Browser van de bots": the choice, whether TeamBot hosts browsers itself (desktop app), and the installed browser. */
export interface EngineView {
  choice: BrowserEngine;
  app: boolean;
  external: string | null;
}

export interface Profile {
  id: string;
  name: string;
  agent_id: string | null;
  shared: boolean;
  room_id: string | null;
  members: string[];
  running: boolean;
  bytes: number;
  created_at: string;
  last_used_at: string | null;
  /** This profile's own proxy (address only; whether a login is stored), or null. */
  proxy?: { url: string; has_login: boolean } | null;
}

export const MODE_LABEL: Record<ModeId, string> = {
  none: 'Geen computer',
  workspace: 'Alleen werkmap',
  browser: 'Eigen browser',
  host: 'Mijn bureaublad',
  container: 'Privé-container',
  remote: 'Eigen server (SSH)',
};

export const CAP_STATUS: Record<Capability['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  available: { label: 'Beschikbaar', tone: 'ok' },
  missing: { label: 'Ontbreekt', tone: 'warn' },
  unsupported: { label: 'Niet mogelijk', tone: 'neutral' },
  unknown: { label: 'Onbekend', tone: 'neutral' },
};

export function fmtBytes(n: number) {
  return formatBytes(n);
}

export function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(uiLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Load data and refetch on the given live events. `patch` may apply an event's payload directly (e.g. the status that
 * comes with "computer.status"): the view then follows without a round trip, and a load that started before that
 * event can no longer overwrite it with older data.
 */
export function useLive<T>(
  load: () => Promise<T>,
  events: string[],
  deps: any[],
  patch?: (cur: T, data: any, type: string) => T | undefined,
): { data: T | null; error: string | null; loading: boolean; reload(): void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const version = useRef(0);
  const current = useRef<T | null>(null);
  current.current = data;
  useEffect(() => {
    let alive = true;
    const started = version.current;
    setLoading(true);
    load()
      .then((d) => {
        if (!alive || started !== version.current) return;
        setData(d);
        setError(null);
      })
      .catch((e) => alive && setError(e?.message || String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setTick((x) => x + 1);
      }, 250);
    };
    const handle = (d: any, type: string) => {
      const cur = current.current;
      const next = patch && cur ? patch(cur, d, type) : undefined;
      if (next === undefined) return bump();
      version.current++;
      current.current = next;
      setData(next);
    };
    const offs = events.map((e) => on(e, handle));
    return () => {
      offs.forEach((o) => o());
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload: () => setTick((x) => x + 1) };
}

/** `patch` for useLive on a bot's computer: take the status that comes with "computer.status" as is. */
export function patchStatus<T extends { status: ComputerStatus }>(agentId: string) {
  return (cur: T, d: any, type: string): T | undefined => (type === 'computer.status' && d?.agentId === agentId && d.browser ? { ...cur, status: d as ComputerStatus } : undefined);
}

export const computers = {
  caps: (refresh = false) => api.get<Capabilities>(`/computers/capabilities${refresh ? '?refresh=1' : ''}`),
  setEngine: (engine: BrowserEngine) => api.put<EngineView>('/computers/engine', { engine }),
  list: () => api.get<{ agent: { id: string; name: string; avatar: string; color: string; workspace: string }; config: ComputerConfig; status: ComputerStatus }[]>('/computers'),
  get: (id: string) => api.get<{ config: ComputerConfig; status: ComputerStatus; workspace: string }>(`/computers/${id}`),
  save: (id: string, body: any) => api.put<{ config: ComputerConfig; agent: any }>(`/computers/${id}/config`, body),
  actions: (id: string, limit = 60) => api.get<Action[]>(`/computers/${id}/actions?limit=${limit}`),
  profiles: () => api.get<Profile[]>('/computers/profiles'),
  remoteTest: (id: string) => api.post<RemoteTestResult>(`/computers/${id}/remote/test`, {}),
  remoteTrust: (id: string, fingerprint: string | null) => api.put<ComputerConfig>(`/computers/${id}/remote/trust`, { fingerprint }),
  /** Sends the key/password once; the answer only says that it is stored. */
  remoteCredential: (id: string, kind: 'key' | 'password', value: string) => api.put<{ secret_name: string; has_secret: boolean; auth: 'key' | 'password' }>(`/computers/${id}/remote/credential`, { kind, value }),
  remoteForget: (id: string) => api.del<{ has_secret: boolean }>(`/computers/${id}/remote/credential`),
};

/** Computer use on the owner's desktop (these routes also work from a paired phone: watch, stop, pause, resume). */
export const screen = {
  info: (agentId: string) => api.get<ScreenInfo>(`/computers/${agentId}/screen`),
  pause: (agentId: string) => api.post(`/computers/${agentId}/screen/pause`, {}),
  resume: (agentId: string) => api.post<{ ok: boolean; resumed: boolean }>(`/computers/${agentId}/screen/resume`, {}),
  revoke: (agentId: string) => api.del(`/computers/${agentId}/screen/grant`),
  stopAll: (source = 'app') => api.post<{ cancelled: number; agents: number }>('/computers/desktop/stop', { source }),
};

/** Open a bot's live screen picture-in-picture (desktop app) or in a small browser window. */
export function openPip(agentId: string, kind: 'browser' | 'desktop') {
  const d = (window as any).teambotDesktop;
  if (d?.pip) return d.pip(agentId, kind);
  window.open(`#/m/browser/live/${encodeURIComponent(agentId)}/${kind === 'desktop' ? 'pip-desktop' : 'pip'}`, `tb-pip-${agentId}-${kind}`, 'popup,width=520,height=400');
}

export const cloud = {
  providers: () => api.get<CloudProviderInfo[]>('/computers/cloud/providers'),
  /** Sends the API token once; the answer only says that it is stored. */
  saveToken: (provider: string, token: string) => api.put<{ has_token: boolean }>(`/computers/cloud/${provider}/token`, { token }),
  forgetToken: (provider: string) => api.del<{ has_token: boolean }>(`/computers/cloud/${provider}/token`),
  options: (provider: string, refresh = false) => api.get<CloudOptions>(`/computers/cloud/${provider}/options${refresh ? '?refresh=1' : ''}`),
  estimate: (provider: string, type: string, location: string) => api.get<CloudEstimate>(`/computers/cloud/${provider}/estimate?type=${encodeURIComponent(type)}&location=${encodeURIComponent(location)}`),
  forAgent: (agentId: string) => api.get<{ vm: CloudVm | null; allowed: boolean; reason?: string }>(`/computers/${agentId}/cloud`),
  create: (agentId: string, body: { provider: string; server_type: string; location: string; image: string; docker: boolean; confirmCost: string }) => api.post<CloudVm>(`/computers/${agentId}/cloud`, body),
  list: () => api.get<CloudVm[]>('/computers/cloud/vms'),
  powerOff: (id: string) => api.post<CloudVm>(`/computers/cloud/vms/${id}/poweroff`, {}),
  powerOn: (id: string) => api.post<CloudVm>(`/computers/cloud/vms/${id}/poweron`, {}),
  refresh: (id: string) => api.post<CloudVm>(`/computers/cloud/vms/${id}/refresh`, {}),
  remove: (id: string, confirm: string) => api.post<CloudVm>(`/computers/cloud/vms/${id}/delete`, { confirm }),
};
