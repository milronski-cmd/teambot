import type { Migration } from '../../core/types.js';
import { defineTable } from '../../core/db.js';

defineTable('memory_items', { json: ['flags', 'merge_of', 'terms'], bool: ['pinned'] });
defineTable('memory_subjects', { json: ['threads', 'pending'] });
defineTable('memory_changes', { json: ['before', 'after'], bool: ['undoable', 'redacted'] });
defineTable('memory_tombstones', { json: ['tokens'] });
defineTable('memory_dossiers', { json: ['agent_ids', 'tags'], bool: ['pinned'] });
defineTable('memory_records', { json: ['data', 'sources'] });
defineTable('memory_sources', { json: [] });
defineTable('memory_episodes', { json: ['agent_ids', 'decisions', 'actions', 'questions', 'source_ids'] });
defineTable('memory_usage', { json: ['refs'] });
defineTable('memory_reports', { json: ['counts', 'lines'] });

/**
 * Tables of the memory module. Everything is owned by a user (user_id). The FTS index and the vectors are derived data
 * and can be rebuilt at any time from the source tables (POST /api/memory/reindex).
 */
export const memoryMigrations: Migration[] = [
  {
    id: 'memory-001',
    sql: `
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  agent_id TEXT,
  dossier_id TEXT,
  type TEXT NOT NULL DEFAULT 'fact',
  canonical_key TEXT,
  key_norm TEXT,
  content TEXT NOT NULL DEFAULT '',
  content_enc TEXT,
  hash TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'user',
  source_ref TEXT,
  source_thread_id TEXT,
  source_excerpt TEXT,
  source_trust TEXT NOT NULL DEFAULT 'user',
  confidence REAL NOT NULL DEFAULT 0.8,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'active',
  proposal_reason TEXT,
  conflict_with TEXT,
  merge_of TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT,
  valid_from TEXT,
  valid_to TEXT,
  expires_at TEXT,
  review_at TEXT,
  last_confirmed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  superseded_by TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_by_agent TEXT,
  origin_run_id TEXT,
  origin_call_id TEXT,
  idem_key TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  trashed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_items_ref ON memory_items(user_id, ref);
CREATE UNIQUE INDEX memory_items_idem ON memory_items(user_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX memory_items_scope ON memory_items(user_id, scope, status);
CREATE INDEX memory_items_agent ON memory_items(agent_id, status);
CREATE INDEX memory_items_dossier ON memory_items(dossier_id, status);
CREATE INDEX memory_items_hash ON memory_items(user_id, hash);
CREATE INDEX memory_items_key ON memory_items(user_id, key_norm);
CREATE INDEX memory_items_source ON memory_items(source_ref);
CREATE INDEX memory_items_call ON memory_items(origin_call_id);

CREATE TABLE memory_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'item',
  record_id TEXT NOT NULL,
  dossier_id TEXT,
  op TEXT NOT NULL,
  before TEXT,
  after TEXT,
  before_hash TEXT,
  after_hash TEXT,
  summary TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'user',
  actor_id TEXT,
  batch_id TEXT,
  undo_of TEXT,
  undone_at TEXT,
  undoable INTEGER NOT NULL DEFAULT 1,
  undo_until TEXT,
  redacted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX memory_changes_user ON memory_changes(user_id, created_at);
CREATE INDEX memory_changes_record ON memory_changes(record_id, created_at);
CREATE INDEX memory_changes_batch ON memory_changes(batch_id);
CREATE INDEX memory_changes_dossier ON memory_changes(dossier_id, created_at);

CREATE TABLE memory_tombstones (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'forget',
  record_kind TEXT NOT NULL DEFAULT 'item',
  record_id TEXT,
  scope TEXT,
  label TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  key_hash TEXT,
  tokens TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX memory_tombstones_user ON memory_tombstones(user_id, kind);
CREATE INDEX memory_tombstones_hash ON memory_tombstones(user_id, content_hash);

CREATE TABLE memory_dossiers (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'project',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  agent_ids TEXT,
  retention_days INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_by_agent TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  trashed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_dossiers_ref ON memory_dossiers(user_id, ref);
CREATE INDEX memory_dossiers_user ON memory_dossiers(user_id, status);

CREATE TABLE memory_dossier_acl (
  dossier_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'read',
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (dossier_id, user_id)
);
CREATE INDEX memory_dossier_acl_user ON memory_dossier_acl(user_id);

CREATE TABLE memory_records (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  user_id TEXT NOT NULL,
  dossier_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  occurred_at TEXT,
  owner TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  data TEXT NOT NULL DEFAULT '{}',
  sources TEXT NOT NULL DEFAULT '[]',
  supersedes_id TEXT,
  superseded_by TEXT,
  author_type TEXT NOT NULL DEFAULT 'user',
  author_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  hash TEXT NOT NULL DEFAULT '',
  origin_call_id TEXT,
  trashed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_records_ref ON memory_records(user_id, ref);
CREATE INDEX memory_records_dossier ON memory_records(dossier_id, kind, status);
CREATE INDEX memory_records_call ON memory_records(origin_call_id);

CREATE TABLE memory_sources (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  user_id TEXT NOT NULL,
  dossier_id TEXT,
  kind TEXT NOT NULL DEFAULT 'note',
  target TEXT NOT NULL DEFAULT '',
  thread_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL DEFAULT '',
  trust TEXT NOT NULL DEFAULT 'user',
  chunks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  observed_at TEXT,
  author_type TEXT NOT NULL DEFAULT 'user',
  author_id TEXT,
  trashed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_sources_ref ON memory_sources(user_id, ref);
CREATE INDEX memory_sources_dossier ON memory_sources(dossier_id, status);

CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  dossier_id TEXT,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX memory_chunks_source ON memory_chunks(source_id, seq);

CREATE TABLE memory_episodes (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  agent_ids TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  decisions TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  questions TEXT NOT NULL DEFAULT '[]',
  source_ids TEXT NOT NULL DEFAULT '[]',
  upto_seq INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'heuristic',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_episodes_ref ON memory_episodes(user_id, ref);
CREATE INDEX memory_episodes_user ON memory_episodes(user_id, updated_at);

CREATE TABLE memory_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  agent_id TEXT,
  via TEXT NOT NULL DEFAULT 'context',
  refs TEXT NOT NULL DEFAULT '[]',
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX memory_usage_thread ON memory_usage(thread_id, created_at);
CREATE INDEX memory_usage_message ON memory_usage(message_id);

CREATE TABLE memory_msg_flags (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  flag TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memory_links (
  thread_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  dossier_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX memory_links_dossier ON memory_links(dossier_id);

CREATE TABLE memory_meta (
  user_id TEXT PRIMARY KEY,
  since_consolidation INTEGER NOT NULL DEFAULT 0,
  last_consolidation_at TEXT,
  last_quota_warn_at TEXT,
  model_day TEXT,
  model_calls INTEGER NOT NULL DEFAULT 0,
  last_reconcile_at TEXT
);

CREATE VIRTUAL TABLE memory_fts USING fts5(text, kind UNINDEXED, rid UNINDEXED, user_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
`,
  },
  {
    // Smart learning queue (one row per thread), maintenance reports and the dossier roll-up cursor.
    id: 'memory-002',
    sql: `
CREATE TABLE memory_learn (
  thread_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  upto_seq INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  dirty INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_engine TEXT,
  last_error TEXT,
  last_result TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX memory_learn_due ON memory_learn(status, due_at);
CREATE INDEX memory_learn_user ON memory_learn(user_id);

CREATE TABLE memory_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'nightly',
  status TEXT NOT NULL DEFAULT 'running',
  engine TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  counts TEXT NOT NULL DEFAULT '{}',
  lines TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  seen_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX memory_reports_user ON memory_reports(user_id, started_at);

CREATE TABLE memory_rollups (
  dossier_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  episode_version INTEGER NOT NULL DEFAULT 0,
  event_id TEXT,
  rolled_at TEXT NOT NULL,
  PRIMARY KEY (dossier_id, thread_id)
);

ALTER TABLE memory_meta ADD COLUMN learn_stats TEXT;
ALTER TABLE memory_meta ADD COLUMN last_maintenance_at TEXT;
ALTER TABLE memory_meta ADD COLUMN last_nightly_day TEXT;
`,
  },
  {
    // Review interval per item ("elke 3 maanden nakijken"). Items that already had a check date keep the old rhythm
    // (every 6 months).
    id: 'memory-003',
    sql: `
ALTER TABLE memory_items ADD COLUMN review_every_days INTEGER;
UPDATE memory_items SET review_every_days = 180 WHERE review_at IS NOT NULL;
CREATE INDEX memory_items_review ON memory_items(user_id, status, review_at);
`,
  },
  {
    // Search by meaning: one embedding per memory item or document chunk (semantic.ts). Derived data like memory_fts:
    // rebuilt by reindex, removed with the record (forget, trash, sensitive), never exported. `text_hash` is an HMAC
    // of the embedded text (no content), `model` the embedding model, `vec` little-endian float32, unit length.
    // Access is never decided here: a search joins the source table and applies its ACL (and, later, its team).
    id: 'memory-004',
    sql: `
CREATE TABLE memory_vectors (
  kind TEXT NOT NULL,
  rid TEXT NOT NULL,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  vec BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, rid)
);
CREATE INDEX memory_vectors_user ON memory_vectors(user_id, kind, model);
`,
  },
  {
    // Memory per team (0.4 B, wave 2). `team_id` on what belongs to a team: a bot's notes and shared knowledge
    // (memory_items, scope agent/shared), dossiers (their records, sources, document parts and notes follow the
    // dossier) and conversation summaries. NULL = the owner's default team (everything from before teams, filed under
    // "Mijn team" at start); '*' = for all teams (shared knowledge and dossiers, the owner's explicit choice). "Over
    // jou" is personal and has no team. `copy_of` links a copy made with "vakkennis meenemen" to its original, so
    // forgetting one forgets the whole family. The derived stores (FTS, vectors) get no team: access is decided on
    // these source rows only.
    id: 'memory-005',
    sql: `
ALTER TABLE memory_items ADD COLUMN team_id TEXT;
ALTER TABLE memory_items ADD COLUMN copy_of TEXT;
ALTER TABLE memory_dossiers ADD COLUMN team_id TEXT;
ALTER TABLE memory_dossiers ADD COLUMN copy_of TEXT;
ALTER TABLE memory_records ADD COLUMN copy_of TEXT;
ALTER TABLE memory_sources ADD COLUMN copy_of TEXT;
ALTER TABLE memory_episodes ADD COLUMN team_id TEXT;
CREATE INDEX memory_items_team ON memory_items(user_id, team_id, scope, status);
CREATE INDEX memory_items_copy ON memory_items(copy_of) WHERE copy_of IS NOT NULL;
CREATE INDEX memory_dossiers_team ON memory_dossiers(user_id, team_id, status);
CREATE INDEX memory_dossiers_copy ON memory_dossiers(copy_of) WHERE copy_of IS NOT NULL;
CREATE INDEX memory_records_copy ON memory_records(copy_of) WHERE copy_of IS NOT NULL;
CREATE INDEX memory_sources_copy ON memory_sources(copy_of) WHERE copy_of IS NOT NULL;
CREATE INDEX memory_episodes_team ON memory_episodes(user_id, team_id);
`,
  },
  {
    // 0.4 F2: memory that keeps itself current and small.
    // - `terms`: keywords and synonyms (NL/EN) the learner adds to a memory, indexed for word search only (so "wagen"
    //   finds "auto" without any embedding model); never shown as content, cleared with the record on forget.
    // - `review_kind`: what kind of fact can change over time (price, version, rule, agreement, hours, contact); such a
    //   fact gets a "herzien op" date (review_at) and is re-checked; `review_note` says why it is "te controleren".
    // - memory_subjects: clients/projects/subjects the owner keeps coming back to, per team, so a dossier can be
    //   proposed (or made, if the owner allows) for a recurring subject; notes filed before it exists wait here.
    // - memory_meta.last_cleanup_month: the month of the last "opruimverslag".
    id: 'memory-006',
    sql: `
ALTER TABLE memory_items ADD COLUMN terms TEXT;
ALTER TABLE memory_items ADD COLUMN review_kind TEXT;
ALTER TABLE memory_items ADD COLUMN review_note TEXT;
CREATE TABLE memory_subjects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  team_id TEXT,
  agent_id TEXT,
  norm TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'project',
  threads TEXT NOT NULL DEFAULT '[]',
  mentions INTEGER NOT NULL DEFAULT 0,
  pending TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'seen',
  dossier_id TEXT,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_subjects_key ON memory_subjects(user_id, COALESCE(team_id, ''), norm);
CREATE INDEX memory_subjects_status ON memory_subjects(user_id, status);
ALTER TABLE memory_meta ADD COLUMN last_cleanup_month TEXT;
`,
  },
  {
    // 0.4.4 — consolidation on write and validity in time (consolidate.ts):
    // - `invalid_reason`: why a fact no longer holds (the newer fact that ended it, "afgerond", a changed document);
    //   `valid_to` is when it stopped holding (Graphiti's invalid_at), the change record when TeamBot learned it.
    // - `consolidated_at`: when this fact was checked against what was already known (so maintenance does not
    //   check it again).
    // - memory_dossiers.changed_at / reread_at: a dossier whose content changed (a document, a note, a record) is
    //   read again against its facts; `reread_at` says when that last happened (reread.ts).
    // - memory_sources.replaces_id: a new version of a document (same title, link or file) replaces the old one,
    //   which stays in the history but is no longer searched.
    id: 'memory-007',
    sql: `
ALTER TABLE memory_items ADD COLUMN invalid_reason TEXT;
ALTER TABLE memory_items ADD COLUMN consolidated_at TEXT;
ALTER TABLE memory_dossiers ADD COLUMN changed_at TEXT;
ALTER TABLE memory_dossiers ADD COLUMN reread_at TEXT;
ALTER TABLE memory_sources ADD COLUMN replaces_id TEXT;
`,
  },
  {
    // 0.4.5: memory per customer on channels. Who is writing (an HMAC of the normalised sender id on one channel
    // binding, in one team) maps to that customer's dossier. A customer's conversation summaries are archived after
    // 45 days without contact (archived_at): out of the block, still kept.
    id: 'memory-008',
    sql: `
CREATE TABLE memory_customer_ids (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  team_id TEXT NOT NULL DEFAULT '',
  dossier_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  ext_hash TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  strength TEXT NOT NULL DEFAULT 'channel',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_customer_ids_key ON memory_customer_ids(binding_id, team_id, ext_hash);
CREATE INDEX memory_customer_ids_dossier ON memory_customer_ids(dossier_id);
CREATE INDEX memory_customer_ids_user ON memory_customer_ids(user_id, last_seen_at);
ALTER TABLE memory_episodes ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS memory_items_dossier_status ON memory_items(dossier_id, status);
`,
  },
  {
    // 0.4.5: where each record sits in memory_fts. Its kind and rid are UNINDEXED columns of the FTS table, so
    // "DELETE … WHERE kind = ? AND rid = ?" read the whole table on every write (300 customer dossiers: 138 s). With
    // this map a write removes its old row by rowid. Filled from what is there now (a duplicate keeps its newest row).
    id: 'memory-009',
    sql: `
CREATE TABLE memory_fts_rows (kind TEXT NOT NULL, rid TEXT NOT NULL, row INTEGER NOT NULL, user_id TEXT, PRIMARY KEY (kind, rid));
CREATE INDEX memory_fts_rows_user ON memory_fts_rows(user_id);
DELETE FROM memory_fts WHERE rowid NOT IN (SELECT MAX(rowid) FROM memory_fts GROUP BY kind, rid);
INSERT OR REPLACE INTO memory_fts_rows (kind, rid, row, user_id) SELECT kind, rid, rowid, user_id FROM memory_fts;
`,
  },
  {
    // Living dossiers (living.ts): the text of a dossier that the bots keep up to date themselves (`body`), and which
    // core dossier it is (`core`: owner, overview, lessons, notes; NULL = a dossier about one subject).
    id: 'memory-010',
    sql: `
ALTER TABLE memory_dossiers ADD COLUMN body TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_dossiers ADD COLUMN core TEXT;
CREATE INDEX memory_dossiers_core ON memory_dossiers(user_id, core) WHERE core IS NOT NULL;
`,
  },
  {
    // One write path (write.ts): what a loose note carried is now on the change of the dossier's text. The capture it
    // came from (the same message, lesson or import line never writes twice), and the message it was learned from
    // (the line under that message in the chat, with undo).
    id: 'memory-011',
    sql: `
ALTER TABLE memory_changes ADD COLUMN idem_key TEXT;
ALTER TABLE memory_changes ADD COLUMN source_thread_id TEXT;
ALTER TABLE memory_changes ADD COLUMN source_ref TEXT;
CREATE INDEX memory_changes_idem ON memory_changes(user_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX memory_changes_thread ON memory_changes(source_thread_id) WHERE source_thread_id IS NOT NULL;
`,
  },
];
