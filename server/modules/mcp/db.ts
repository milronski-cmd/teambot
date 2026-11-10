import type { Migration, ToolRisk } from '../../core/types.js';
import { defineTable } from '../../core/db.js';

defineTable('mcp_connections', {
  json: ['args', 'env', 'headers', 'oauth', 'server_info', 'verify_result', 'package', 'registry'],
  bool: ['enabled', 'allow_actions', 'allow_private'],
});
defineTable('mcp_tools', { json: ['input_schema', 'annotations'], bool: ['enabled', 'approved', 'changed'] });
defineTable('mcp_bindings', {});
defineTable('mcp_calls', {});
defineTable('mcp_oauth_flows', { bool: ['used'] });
defineTable('mcp_server_tokens', { json: ['agent_ids'], bool: ['revoked'] });

export const migrations: Migration[] = [
  {
    id: 'mcp-001',
    sql: `
CREATE TABLE mcp_connections (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, catalog_id TEXT, name TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL, transport TEXT NOT NULL, command TEXT NOT NULL DEFAULT '', args TEXT NOT NULL DEFAULT '[]',
  cwd TEXT NOT NULL DEFAULT '', env TEXT NOT NULL DEFAULT '[]', url TEXT NOT NULL DEFAULT '', headers TEXT NOT NULL DEFAULT '[]',
  auth TEXT NOT NULL DEFAULT 'none', oauth TEXT NOT NULL DEFAULT '{}', trusted_at TEXT, allow_private INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, allow_actions INTEGER NOT NULL DEFAULT 0, verified_at TEXT, verify_result TEXT,
  status TEXT NOT NULL DEFAULT 'new', last_error TEXT, server_info TEXT, idle_minutes INTEGER NOT NULL DEFAULT 10,
  timeout_sec INTEGER NOT NULL DEFAULT 60, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (user_id, slug)
);
CREATE INDEX mcp_connections_user ON mcp_connections(user_id);
CREATE TABLE mcp_tools (
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE, name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', input_schema TEXT NOT NULL DEFAULT '{}', annotations TEXT NOT NULL DEFAULT '{}',
  hint_risk TEXT NOT NULL DEFAULT 'write', server_risk TEXT NOT NULL DEFAULT 'write', user_risk TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, approved INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0,
  schema_hash TEXT NOT NULL DEFAULT '', present INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  PRIMARY KEY (connection_id, name)
);
CREATE TABLE mcp_bindings (
  agent_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (agent_id, connection_id)
);
CREATE INDEX mcp_bindings_conn ON mcp_bindings(connection_id);
CREATE TABLE mcp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, agent_id TEXT, thread_id TEXT,
  kind TEXT NOT NULL DEFAULT 'tool', tool TEXT NOT NULL, risk TEXT NOT NULL DEFAULT 'read', summary TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1, error TEXT, duration_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX mcp_calls_conn ON mcp_calls(connection_id, id);
CREATE INDEX mcp_calls_user ON mcp_calls(user_id, id);
CREATE TABLE mcp_oauth_flows (
  state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mcp_server_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', token_hash TEXT NOT NULL UNIQUE,
  agent_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, last_used TEXT, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX mcp_server_tokens_user ON mcp_server_tokens(user_id);
`,
  },
  {
    // Connector packages: publisher snapshot + template of a connection created from a signed package.
    id: 'mcp-002',
    sql: 'ALTER TABLE mcp_connections ADD COLUMN package TEXT;',
  },
  {
    // Connections installed from the official MCP Registry: server name, version, install option and template.
    id: 'mcp-003',
    sql: 'ALTER TABLE mcp_connections ADD COLUMN registry TEXT;',
  },
];

/** builtin: a server inside TeamBot itself (Google, see google.ts); never typed in by a user. */
export type Transport = 'stdio' | 'http' | 'sse' | 'builtin';
export type AuthKind = 'none' | 'headers' | 'oauth';

/** One environment variable or HTTP header. Secret values live in ctx.secrets, never in this row. */
export interface KV {
  name: string;
  /** Plain (non-secret) value. */
  value?: string;
  /** Id of a secret created for this connection (inline secret). */
  secret_id?: string;
  /** Name of an existing user secret (Instellingen › Beveiliging › Opgeslagen geheimen). */
  secret_name?: string;
}

export interface OAuthState {
  /** Scopes the user approved before connecting. */
  scope?: string;
  /** Scope string the authorization server actually granted. */
  granted_scope?: string;
  redirect_uri?: string;
  authorization_server?: string;
  resource?: string;
  resource_metadata_url?: string;
  discovery?: any;
  /** Public client id (pre-registered or dynamically registered). */
  client_id?: string;
  /** Secret id of a pre-registered client secret (optional). */
  client_secret_id?: string;
  /** Authorization server a pre-registered client was first used with. */
  client_issuer?: string;
  preregistered?: boolean;
  connected_at?: string;
  expires_at?: string | null;
  has_refresh?: boolean;
  status?: 'disconnected' | 'pending' | 'connected' | 'expired';
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  catalog_id: string | null;
  name: string;
  label: string;
  slug: string;
  transport: Transport;
  command: string;
  args: string[];
  cwd: string;
  env: KV[];
  url: string;
  headers: KV[];
  auth: AuthKind;
  oauth: OAuthState;
  trusted_at: string | null;
  allow_private: boolean;
  enabled: boolean;
  allow_actions: boolean;
  verified_at: string | null;
  verify_result: any;
  status: string;
  last_error: string | null;
  server_info: { name?: string; version?: string; protocol?: string; capabilities?: any; instructions?: string } | null;
  idle_minutes: number;
  timeout_sec: number;
  /** Set when the connection was created from a connector package (see package.ts). */
  package?: import('./package.js').ConnectionPackage | null;
  /** Set when the connection was installed from the MCP Registry (see registry.ts). */
  registry?: import('./registry.js').ConnectionRegistry | null;
  created_at: string;
  updated_at: string;
}

export interface ToolRow {
  connection_id: string;
  name: string;
  title: string;
  description: string;
  input_schema: any;
  annotations: any;
  hint_risk: ToolRisk;
  server_risk: ToolRisk;
  user_risk: ToolRisk | null;
  enabled: boolean;
  approved: boolean;
  changed: boolean;
  schema_hash: string;
  present: number;
  first_seen: string;
  last_seen: string;
}
