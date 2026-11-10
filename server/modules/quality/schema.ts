import { defineTable } from '../../core/db.js';
import type { Migration } from '../../core/types.js';

/**
 * One row per task (task board, team database, delegated subtask): its "klaar als", who claimed it, what the bot
 * reported (done with evidence, or "kon niet" with a reason) and the outcome of the second look. Kept apart from the
 * task tables themselves, so the task board, the team database and delegations share one quality record.
 */
defineTable('quality_tasks', { json: ['evidence', 'steps', 'recheck_input'], bool: ['skip_check', 'open'] });
defineTable('quality_lessons', {});
defineTable('quality_suggestions', {});

export const qualityMigrations: Migration[] = [
  {
    id: 'quality-001',
    sql: `
CREATE TABLE quality_tasks (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', done_when TEXT NOT NULL DEFAULT '', done_when_by TEXT,
  skip_check INTEGER NOT NULL DEFAULT 0, claimed_by TEXT, claimed_at TEXT,
  outcome TEXT, outcome_reason TEXT NOT NULL DEFAULT '', reported_by TEXT, reported_at TEXT,
  evidence TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]',
  check_state TEXT NOT NULL DEFAULT 'none', check_reason TEXT NOT NULL DEFAULT '', check_engine TEXT NOT NULL DEFAULT '',
  check_tokens INTEGER, checked_at TEXT, open INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (user_id, kind, ref)
);
CREATE INDEX quality_tasks_open ON quality_tasks(user_id, open);
CREATE INDEX quality_tasks_claim ON quality_tasks(claimed_by);

CREATE TABLE quality_lessons (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, thread_id TEXT, message_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '', method TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '',
  memory_ref TEXT, memory_item_id TEXT, change_id TEXT, created_at TEXT NOT NULL,
  UNIQUE (message_id, agent_id)
);
CREATE INDEX quality_lessons_agent ON quality_lessons(agent_id, created_at);

CREATE TABLE quality_suggestions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'skill',
  key TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', decided_at TEXT, created_at TEXT NOT NULL,
  UNIQUE (user_id, agent_id, kind, key)
);
CREATE INDEX quality_suggestions_user ON quality_suggestions(user_id, status);
`,
  },
  {
    // 0.4.5: a second look that hit its engine's usage limit (OpenCode's free daily limit) runs again by itself after
    // the reset. Its own id (no number), so migrations added in parallel never clash.
    id: 'quality-recheck',
    sql: `
ALTER TABLE quality_tasks ADD COLUMN recheck_at TEXT;
ALTER TABLE quality_tasks ADD COLUMN recheck_n INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quality_tasks ADD COLUMN recheck_input TEXT NOT NULL DEFAULT '{}';
CREATE INDEX quality_tasks_recheck ON quality_tasks(recheck_at);
`,
  },
];
