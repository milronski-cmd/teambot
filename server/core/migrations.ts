import type { Migration } from './types.js';
import { defineTable } from './db.js';

defineTable('users', { json: ['settings'], bool: ['disabled'] });
defineTable('providers', { json: ['config'], bool: ['enabled', 'shared'] });
defineTable('agents', { json: ['tool_groups', 'tool_policy', 'skills', 'fallback', 'settings'], bool: ['pinned', 'archived'] });
defineTable('threads', { json: ['provider_state', 'meta'], bool: ['pinned', 'archived'] });
defineTable('messages', { json: ['parts', 'usage', 'reactions'], bool: ['pinned', 'deleted'] });
defineTable('runs', { json: ['usage', 'meta'] });
defineTable('approvals', { json: ['input', 'options'] });

export const coreMigrations: Migration[] = [
  {
    id: 'core-001',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL, password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member', disabled INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'web', name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  last_seen TEXT, expires_at TEXT, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE invites (
  code TEXT PRIMARY KEY, created_by TEXT, role TEXT NOT NULL DEFAULT 'member', uses_left INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '', expires_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE pair_codes (
  code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE settings (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
CREATE TABLE secrets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, value_enc TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (user_id, name)
);
CREATE TABLE providers (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '',
  secret_id TEXT, config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#6366f1',
  role TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
  provider_id TEXT, model TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '', access_mode TEXT NOT NULL DEFAULT 'ask',
  workspace TEXT NOT NULL DEFAULT '', tool_groups TEXT NOT NULL DEFAULT '[]', tool_policy TEXT NOT NULL DEFAULT '{}',
  skills TEXT NOT NULL DEFAULT '[]', fallback TEXT, busy_policy TEXT NOT NULL DEFAULT 'queue', settings TEXT NOT NULL DEFAULT '{}',
  pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX agents_user ON agents(user_id);
CREATE TABLE threads (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT, room_id TEXT, kind TEXT NOT NULL DEFAULT 'chat',
  title TEXT NOT NULL DEFAULT '', parent_id TEXT, provider_state TEXT NOT NULL DEFAULT '{}', meta TEXT NOT NULL DEFAULT '{}',
  pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX threads_user ON threads(user_id, updated_at);
CREATE INDEX threads_agent ON threads(agent_id);
CREATE INDEX threads_room ON threads(room_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  role TEXT NOT NULL, author_type TEXT NOT NULL, author_id TEXT, author_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '', parts TEXT NOT NULL DEFAULT '{}', run_id TEXT, status TEXT NOT NULL DEFAULT 'done',
  usage TEXT, reply_to TEXT, reactions TEXT NOT NULL DEFAULT '{}', pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, edited_at TEXT
);
CREATE INDEX messages_thread ON messages(thread_id, seq);
CREATE VIRTUAL TABLE messages_fts USING fts5(content, message_id UNINDEXED, thread_id UNINDEXED, user_id UNINDEXED);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'user', input_message_id TEXT, error TEXT, usage TEXT NOT NULL DEFAULT '{"input":0,"output":0}',
  meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE INDEX runs_thread ON runs(thread_id);
CREATE INDEX runs_status ON runs(status);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT, run_id TEXT, thread_id TEXT, kind TEXT NOT NULL DEFAULT 'tool',
  tool TEXT NOT NULL DEFAULT '', input TEXT NOT NULL DEFAULT '{}', summary TEXT NOT NULL DEFAULT '', risk TEXT NOT NULL DEFAULT 'write',
  options TEXT, status TEXT NOT NULL DEFAULT 'pending', answer TEXT, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX approvals_user ON approvals(user_id, status);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, thread_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  path TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, agent_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX audit_user ON audit(user_id, id);
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, agent_id TEXT, provider_id TEXT, model TEXT,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX usage_user ON usage_log(user_id, created_at);
`,
  },
  {
    // Performance: message_id/thread_id are UNINDEXED columns of the FTS5 table, so updating or deleting by them
    // scanned the whole search index for every new message. A small map gives indexed access via the FTS rowid.
    id: 'core-002-fts-map',
    sql: `CREATE TABLE messages_fts_map (message_id TEXT PRIMARY KEY, rid INTEGER NOT NULL, thread_id TEXT NOT NULL);
CREATE INDEX messages_fts_map_thread ON messages_fts_map(thread_id);
DELETE FROM messages_fts;
INSERT INTO messages_fts (content, message_id, thread_id, user_id)
  SELECT m.content, m.id, m.thread_id, t.user_id FROM messages m JOIN threads t ON t.id = m.thread_id
  WHERE m.deleted = 0 AND m.content != '' AND m.role IN ('user', 'assistant') ORDER BY m.rowid;
INSERT INTO messages_fts_map (message_id, rid, thread_id) SELECT message_id, rowid, thread_id FROM messages_fts;`,
  },
  {
    // Estimated value at list price next to the actual cost: a subscription run costs 0 but still has a value
    // (Claude Code reports it as total_cost_usd), shown as "via abonnement · geschatte waarde $X".
    id: 'core-usage-value-001',
    sql: `ALTER TABLE usage_log ADD COLUMN value REAL;
CREATE INDEX usage_provider ON usage_log(provider_id, created_at);`,
  },
  {
    // An open approval of a run that a crash/restart interrupted stays open (interrupted_at); deciding it resumes the
    // run. carried_at: the decision was used once by the resumed run for the identical request (never twice).
    id: 'core-approvals-interrupted-001',
    sql: `ALTER TABLE approvals ADD COLUMN interrupted_at TEXT;
ALTER TABLE approvals ADD COLUMN carried_at TEXT;
CREATE INDEX approvals_thread ON approvals(thread_id, status);`,
  },
  {
    // Performance: these columns are looked up on every run (messages of a run, the run of a message, the newest
    // runs), for sub-conversations and for the files of a thread, and each lookup scanned the whole table.
    id: 'core-perf-indexes-001',
    sql: `CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id);
CREATE INDEX IF NOT EXISTS runs_input_message ON runs(input_message_id);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at);
CREATE INDEX IF NOT EXISTS threads_parent ON threads(parent_id);
CREATE INDEX IF NOT EXISTS attachments_thread ON attachments(thread_id);`,
  },
  {
    // "Nieuwe bot" (0.4.4) also wrote the role into the description, and the chat greets with the description as a
    // sentence ("Hoi, ik ben Pen. Schrijver"). A role is not a description: where it is exactly the role it goes, once.
    id: 'core-role-not-description-001',
    sql: `UPDATE agents SET description = '' WHERE role != '' AND description = role;`,
  },
  {
    // A bot does not stand still for the owner: a request he has not answered after a short while is parked
    // (parked_at). It stays open for him, the bot goes on with its other work, and his decision starts a turn for it.
    id: 'core-approvals-parked-001',
    sql: `ALTER TABLE approvals ADD COLUMN parked_at TEXT;`,
  },
];
