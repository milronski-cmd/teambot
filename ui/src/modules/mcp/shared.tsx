import { useEffect, useState } from 'react';
import { api, on } from '../../lib/api';
import { Badge } from '../../components/ui';
import { uiLocale } from '../../lib/i18n';

export type Risk = 'read' | 'write' | 'exec' | 'danger';

export interface KVView {
  name: string;
  value?: string;
  secret: boolean;
  secret_name?: string;
  set?: boolean;
}

export interface ToolView {
  name: string;
  exposed: string;
  title: string;
  description: string;
  input_schema: any;
  annotations: any;
  hint_risk: Risk;
  server_risk: Risk;
  user_risk: Risk | null;
  risk: Risk;
  /** "lezen" is TeamBot's guess from the name and description (the server gave no annotations). */
  guessed?: boolean;
  enabled: boolean;
  approved: boolean;
  changed: boolean;
  present: boolean;
  usable: boolean;
}

export interface RuntimeView {
  state: 'stopped' | 'starting' | 'ready' | 'backoff' | 'error' | 'auth_required';
  since: string;
  lastError: string | null;
  crashes: number;
  restarts: number;
  nextRetryAt: string | null;
  pid: number | null;
  inflight: number;
  lastUsed: string | null;
}

export interface Conn {
  id: string;
  catalog_id: string | null;
  name: string;
  label: string;
  display: string;
  slug: string;
  /** builtin: a server inside TeamBot itself (Google). */
  transport: 'stdio' | 'http' | 'sse' | 'builtin';
  command: string;
  args: string[];
  cwd: string;
  env: KVView[];
  url: string;
  host: string | null;
  headers: KVView[];
  auth: 'none' | 'headers' | 'oauth';
  oauth: null | {
    status: 'disconnected' | 'pending' | 'connected' | 'expired';
    scope: string;
    granted_scope: string;
    expires_at: string | null;
    has_refresh: boolean;
    authorization_server: string | null;
    preregistered: boolean;
    client_id?: string;
    has_client_secret: boolean;
    connected_at: string | null;
    can_revoke: boolean;
  };
  trusted: boolean;
  allow_private: boolean;
  enabled: boolean;
  allow_actions: boolean;
  verified_at: string | null;
  verify_result: any;
  status: string;
  last_error: string | null;
  server_info: { name?: string; version?: string; protocol?: string; capabilities?: Record<string, boolean>; instructions?: string } | null;
  idle_minutes: number;
  timeout_sec: number;
  created_at: string;
  updated_at: string;
  runtime: RuntimeView;
  counts: { total: number; usable: number; pending: number; read: number; write: number; exec: number; danger: number };
  agents: string[];
  catalog: null | { name: string; source: string; license: string; verification: string; revokeHelp?: string; oauthClient?: 'dynamic' | 'own-app'; oauthAppHelp?: string; oauthAppGuide?: OAuthAppGuide };
  /** Detail view: own OAuth clients of other connections that can be reused here (same guide group). */
  sharedClients?: { id: string; display: string; client_id: string }[];
  /** Publisher signature of the template this connection came from (built-in, package or hand-made). */
  signature?: SigView;
  package?: { name: string | null; version: string | null; publisher: string | null; fingerprint: string | null } | null;
  /** Installed from the official MCP Registry (name, version, install option; newest version known from the cache). */
  registry?: { name: string; version: string; option: string; kind: string; identifier: string | null; installedAt: string; publishedAt: string | null; latest: string | null; updateAvailable: boolean } | null;
  dataDir?: string;
  /** npx/uvx is not on this computer yet: "Installeren" gets TeamBot's own copy. */
  needsRuntime?: 'node' | 'uv' | null;
  tools?: ToolView[];
  stderr?: string[];
  bound?: boolean;
}

export interface CatalogField {
  name: string;
  label: string;
  help?: string;
  secret?: boolean;
  required?: boolean;
  prefix?: string;
  placeholder?: string;
  default?: string;
}

/** Guided setup of an own OAuth client (server catalogue: exact console pages, fields and values). */
export interface OAuthAppGuide {
  group: string;
  vendor: string;
  intro: string;
  secretRequired: boolean;
  clientIdPattern?: string;
  clientIdPlaceholder?: string;
  steps: { title: string; lines: string[]; links?: { url: string; label: string }[]; copy?: { label: string; value: string }[] }[];
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  publisher: string;
  official: boolean;
  transport: 'stdio' | 'http' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
  argsPrompt?: { label: string; help: string; kind: 'paths' | 'text'; defaultWorkFolders?: boolean };
  env?: CatalogField[];
  headers?: CatalogField[];
  auth: 'none' | 'headers' | 'oauth';
  oauthClient?: 'dynamic' | 'own-app';
  oauthAppHelp?: string;
  oauthAppGuide?: OAuthAppGuide;
  scopes?: { name: string; description: string; default?: boolean }[];
  dataFlow: string;
  requirements?: string;
  license: string;
  source: string;
  docs?: string;
  verification: 'geverifieerd' | 'niet geverifieerd';
  verifiedAt: string;
  testStatus: string;
  revokeHelp?: string;
  availability?: string;
  alternatives?: string;
  available: boolean;
  unavailableReason?: string;
  commandFound?: boolean;
  /** npx/uvx: the program "Installeren" gets when it is not on this computer. */
  runtime?: 'node' | 'uv';
  /** What one click does: connect (nothing needed), login (only the service's login), form (a key or more first). */
  oneClick?: 'connect' | 'login' | 'form';
  /** Only shown when searched for: the built-in Google connection does the same in one login. */
  advanced?: boolean;
  /** Built-in templates: TeamBot (trusted); package templates: the publisher signature. */
  signature?: SigView | null;
}

export const RISK_TEXT: Record<Risk, string> = { read: 'lezen', write: 'schrijven', exec: 'uitvoeren', danger: 'gevaarlijk' };
const RISK_TONE: Record<Risk, 'ok' | 'accent' | 'warn' | 'danger'> = { read: 'ok', write: 'accent', exec: 'warn', danger: 'danger' };
export const RISK_HELP: Record<Risk, string> = {
  read: 'Alleen lezen — mag automatisch',
  write: 'Wijzigt iets — vraagt toestemming in modus “vragen”',
  exec: 'Voert code/opdrachten uit — vraagt toestemming in modus “vragen”',
  danger: 'Verzenden, publiceren, verwijderen of betalen — vraagt altijd toestemming',
};

/** Publisher signature as returned by the server (see server/modules/skills/publishers.ts). */
export interface SigView {
  state: 'builtin' | 'trusted' | 'untrusted' | 'unsigned' | 'invalid';
  label: string;
  publisher: string | null;
  declaredPublisher: string | null;
  publisherId: string | null;
  publicKey: string | null;
  fingerprint: string | null;
  version: string | null;
  compatible: boolean;
  incompatible: string[];
  errors: string[];
  warnings: string[];
  blocked: boolean;
  blockReason: string | null;
}

export interface PolicyView {
  policy: string;
  allowed: boolean;
  needsOverride: boolean;
  canOverride: boolean;
  blocked: boolean;
  reason: string | null;
}

const SIG_TONE: Record<SigView['state'], 'ok' | 'neutral' | 'warn' | 'danger'> = { builtin: 'ok', trusted: 'ok', untrusted: 'warn', unsigned: 'neutral', invalid: 'danger' };

export function SigBadge({ sig }: { sig: SigView | null | undefined }) {
  if (!sig) return null;
  return (
    <>
      <Badge tone={SIG_TONE[sig.state] || 'neutral'}>{sig.label}</Badge>
      {!sig.compatible && <Badge tone="danger">Niet compatibel met deze TeamBot-versie</Badge>}
    </>
  );
}

export function RiskBadge({ risk }: { risk: Risk }) {
  return (
    <Badge tone={RISK_TONE[risk]}>
      <span title={RISK_HELP[risk]}>{RISK_TEXT[risk]}</span>
    </Badge>
  );
}

export function StatusBadge({ c }: { c: Conn }) {
  const s = c.runtime?.state;
  if (!c.enabled) return <Badge>uit</Badge>;
  if (c.auth === 'oauth' && c.oauth?.status !== 'connected') return <Badge tone="warn">{c.oauth?.status === 'expired' ? 'inloggen verlopen' : 'niet ingelogd'}</Badge>;
  if (s === 'auth_required' || c.status === 'auth_required') return <Badge tone="warn">inloggen nodig</Badge>;
  if (s === 'ready') return <Badge tone="ok">verbonden</Badge>;
  if (s === 'starting') return <Badge tone="accent">starten…</Badge>;
  if (s === 'backoff') return <Badge tone="warn">herstart…</Badge>;
  if (s === 'error' || (s === 'stopped' && c.status === 'error')) return <Badge tone="danger">fout</Badge>;
  if (!c.verified_at) return <Badge tone="warn">nog niet getest</Badge>;
  return <Badge>slaapt (start bij gebruik)</Badge>;
}

/** Live list of the user's connections (refreshes on mcp.* events). */
export function useConnections() {
  const [list, setList] = useState<Conn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api
      .get<Conn[]>('/mcp/connections')
      .then((l) => (setList(l), setError(null)))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const off1 = on('mcp.updated', (d: any) => {
      setList((cur) => {
        if (!cur) return cur;
        if (d?.deleted) return cur.filter((c) => c.id !== d.id);
        const i = cur.findIndex((c) => c.id === d.id);
        if (i < 0) return [...cur, d];
        const copy = cur.slice();
        copy[i] = { ...copy[i], ...d };
        return copy;
      });
    });
    const off2 = on('mcp.status', (d: any) => setList((cur) => cur?.map((c) => (c.id === d.id ? { ...c, runtime: { ...c.runtime, ...d } } : c)) ?? cur));
    return () => {
      off1();
      off2();
    };
  }, []);
  return { list, error, reload: load };
}

// ---- tool-index cache for the chat tool-card renderer ----
type IndexEntry = { connectionId: string; app: string; tool: string; risk: Risk; title?: string };
let indexCache: Record<string, IndexEntry> | null = null;
let indexPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function loadToolIndex(force = false) {
  if (indexPromise && !force) return indexPromise;
  indexPromise = api
    .get<{ tools: Record<string, IndexEntry> }>('/mcp/tool-index')
    .then((r) => {
      indexCache = r.tools;
      for (const l of listeners) l();
    })
    .catch(() => {
      indexPromise = null;
    });
  return indexPromise;
}

export function useToolIndex(): Record<string, IndexEntry> | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    loadToolIndex();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return indexCache;
}

export function invalidateToolIndex() {
  indexPromise = null;
  if (listeners.size) loadToolIndex(true);
}

export function timeShort(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(uiLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
