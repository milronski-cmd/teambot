/**
 * One small query interface over Postgres: `pg` (production, DATABASE_URL) or PGlite (Postgres in WebAssembly, for
 * development and tests). Both speak the same SQL with $1-style parameters. Counts must be cast (`COUNT(*)::int`)
 * because pg returns bigint as a string.
 */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  /** Run several statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Run fn in one transaction; only use the given Queryable inside fn. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function one<T = any>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q.query<T>(sql, params);
  return rows[0] ?? null;
}

async function openPg(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // Never let connection errors crash the process; queries surface their own errors.
  pool.on('error', () => {});
  return {
    kind: 'pg',
    async query(sql, params = []) {
      return (await pool.query(sql, params as any[])).rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: async (sql, params = []) => (await client.query(sql, params as any[])).rows });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function openPglite(dir: string | undefined): Promise<Db> {
  let mod: typeof import('@electric-sql/pglite');
  try {
    mod = await import('@electric-sql/pglite');
  } catch {
    throw new Error('DATABASE_URL ontbreekt en PGlite is niet geïnstalleerd (alleen voor ontwikkeling). Zet DATABASE_URL naar je Postgres-database.');
  }
  const db = await mod.PGlite.create(dir);
  return {
    kind: 'pglite',
    async query(sql, params = []) {
      return (await db.query<any>(sql, params as any[])).rows;
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async tx(fn) {
      return db.transaction(async (t) => fn({ query: async (sql, params = []) => (await t.query<any>(sql, params as any[])).rows }));
    },
    async close() {
      await db.close();
    },
  };
}

/** DATABASE_URL → Postgres; otherwise PGlite in `pgliteDir` (or in memory when that is undefined). */
export function openDb(databaseUrl: string | null, pgliteDir?: string): Promise<Db> {
  return databaseUrl ? openPg(databaseUrl) : openPglite(pgliteDir);
}

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: 'cloud-001-init',
    sql: `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'operator')),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verify_token_hash TEXT,
  verify_expires_at TIMESTAMPTZ,
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX sessions_account ON sessions (account_id);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  plan TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'suspended', 'deleting', 'deleted')),
  status_reason TEXT,
  instance JSONB NOT NULL DEFAULT '{}'::jsonb,
  master_key_enc TEXT,
  owner_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token_hash TEXT,
  claim_expires_at TIMESTAMPTZ,
  health TEXT NOT NULL DEFAULT 'unknown',
  health_checked_at TIMESTAMPTZ,
  storage_bytes BIGINT,
  trial_ends_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  delete_after TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX workspaces_owner ON workspaces (owner_id);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  provider TEXT NOT NULL CHECK (provider IN ('manual', 'stripe')),
  external_customer_id TEXT,
  external_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end TIMESTAMPTZ,
  cancel_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  payment_failed_at TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  workspace_id TEXT,
  event_created_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL,
  outcome TEXT
);
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  file TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX exports_workspace ON exports (workspace_id);
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL CHECK (impact IN ('minor', 'major')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  updates JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);
CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL,
  actor_id TEXT,
  kind TEXT NOT NULL,
  workspace_id TEXT,
  ip TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_at ON audit (at DESC);
CREATE INDEX audit_workspace ON audit (workspace_id);
CREATE TABLE health_daily (
  day TEXT PRIMARY KEY,
  checks INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0
);
`,
  },
  {
    // CLD-05: dedicated deployments, per-workspace uptime, automatic incidents, maintenance windows.
    id: 'cloud-002-dedicated-sla',
    sql: `
ALTER TABLE workspaces ADD COLUMN deployment TEXT NOT NULL DEFAULT 'shared' CHECK (deployment IN ('shared', 'dedicated'));
ALTER TABLE workspaces ADD COLUMN external_url TEXT;
ALTER TABLE workspaces ADD COLUMN setup_token_hash TEXT;
ALTER TABLE workspaces ADD COLUMN health_fail_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN health_detail TEXT;
ALTER TABLE incidents ADD COLUMN workspace_id TEXT;
ALTER TABLE incidents ADD COLUMN auto BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX incidents_workspace ON incidents (workspace_id);
CREATE TABLE workspace_health_daily (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
CREATE TABLE maintenance (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  workspace_id TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  excluded BOOLEAN NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  canceled_at TIMESTAMPTZ
);
CREATE INDEX maintenance_window ON maintenance (starts_at, ends_at);
`,
  },
  {
    // CLD-05 completion: monthly SLA reports (immutable), service credits (operator approval), outbound alerts.
    // Health buckets are local calendar days in CLOUD_TZ from now on, so a month report has exact boundaries.
    id: 'cloud-003-sla-reports',
    sql: `
ALTER TABLE workspace_health_daily ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
CREATE TABLE sla_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  month TEXT NOT NULL,
  version INTEGER NOT NULL,
  data JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  generated_by TEXT,
  reason TEXT,
  UNIQUE (workspace_id, month, version)
);
CREATE INDEX sla_reports_month ON sla_reports (month);
CREATE FUNCTION sla_reports_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SLA-rapporten zijn onveranderlijk'; END $$;
CREATE TRIGGER sla_reports_no_change BEFORE UPDATE OR DELETE ON sla_reports FOR EACH ROW EXECUTE FUNCTION sla_reports_immutable();
CREATE TABLE sla_credits (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL UNIQUE REFERENCES sla_reports(id),
  workspace_id TEXT NOT NULL,
  month TEXT NOT NULL,
  pct INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'to_settle', 'settled', 'rejected')),
  method TEXT,
  external_ref TEXT,
  note TEXT,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sla_credits_status ON sla_credits (status);
ALTER TABLE accounts ADD COLUMN alert_email BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounts ADD COLUMN alert_webhook_url TEXT;
ALTER TABLE accounts ADD COLUMN alert_webhook_secret_enc TEXT;
CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  workspace_id TEXT,
  channel TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX alerts_account ON alerts (account_id, created_at DESC);
`,
  },
];

/** Apply pending migrations, each in its own transaction. */
export async function migrate(db: Db): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS cloud_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)');
  const done = new Set((await db.query<{ id: string }>('SELECT id FROM cloud_migrations')).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.tx(async (q) => {
      for (const stmt of m.sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await q.query(stmt);
      await q.query('INSERT INTO cloud_migrations (id, applied_at) VALUES ($1, $2)', [m.id, new Date().toISOString()]);
    });
  }
}
