import { defineTable } from '../../core/db.js';
import type { Migration } from '../../core/types.js';

defineTable('specialist_profiles', { json: ['settings'], bool: ['enabled', 'learn_on', 'self_test'] });
defineTable('specialist_sources', { json: ['state'], bool: ['enabled', 'suggested'] });
defineTable('specialist_pages', {});
defineTable('specialist_goals', {});
defineTable('specialist_rounds', { json: ['stats', 'lines', 'news'] });
defineTable('specialist_reports', { json: ['data'] });
defineTable('specialist_procedures', { json: ['tools', 'examples'] });
defineTable('specialist_proposals', { json: ['evidence'] });

/**
 * specialist_profiles   one row per bot that is (or was) a specialist: field, learning round (on/off, daily/weekly,
 *                       budget, self-test), its routine and its knowledge dossier (in the memory module)
 * specialist_sources    websites, RSS/Atom feeds, documentation and own files of a specialist, with fetch state
 *                       (ETag, Last-Modified, hash, seen feed items)
 * specialist_pages      the last readable text per fetched page or feed item (cache: what is new, and learning goals
 *                       can be looked up again without fetching); derived, deleted with its source
 * specialist_goals      learning goals: a "weet ik niet" in a chat, a failed self-test question, or the owner's own
 * specialist_rounds     one row per learning round: what was checked, learned, skipped, ignored, with memory change ids
 * specialist_reports    the weekly learning report (also a timeline entry in the knowledge dossier)
 * specialist_procedures repeated tool sequences of successful runs (for skill proposals)
 * specialist_proposals  skill proposals with a SKILL.md draft; installed only when the owner approves
 * The facts themselves are memory items in the bot's knowledge dossier (memory module), never in these tables.
 */
export const specialistMigrations: Migration[] = [
  {
    id: 'specialists-001',
    sql: `
CREATE TABLE specialist_profiles (
  agent_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, field TEXT NOT NULL DEFAULT '',
  learn_on INTEGER NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'daily', budget TEXT NOT NULL DEFAULT 'normal',
  self_test INTEGER NOT NULL DEFAULT 0, routine_id TEXT, dossier_id TEXT, settings TEXT NOT NULL DEFAULT '{}',
  learn_since TEXT, last_round_at TEXT, last_selftest_at TEXT, last_report_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX specialist_profiles_user ON specialist_profiles(user_id);
CREATE TABLE specialist_sources (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, suggested INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT '{}', last_checked_at TEXT, last_status TEXT, last_error TEXT, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX specialist_sources_agent ON specialist_sources(agent_id, sort);
CREATE TABLE specialist_pages (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', published_at TEXT,
  fetched_at TEXT NOT NULL, UNIQUE (source_id, url)
);
CREATE INDEX specialist_pages_agent ON specialist_pages(agent_id);
CREATE TABLE specialist_goals (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, question TEXT NOT NULL, origin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', hits INTEGER NOT NULL DEFAULT 1, tries INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT, message_id TEXT, answer_ref TEXT, answer_text TEXT, note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT
);
CREATE INDEX specialist_goals_agent ON specialist_goals(agent_id, status);
CREATE TABLE specialist_rounds (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, trigger TEXT NOT NULL, run_id TEXT,
  status TEXT NOT NULL, engine TEXT, stats TEXT NOT NULL DEFAULT '{}', lines TEXT NOT NULL DEFAULT '[]', error TEXT,
  summary TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX specialist_rounds_agent ON specialist_rounds(agent_id, started_at);
CREATE INDEX specialist_rounds_run ON specialist_rounds(run_id);
CREATE TABLE specialist_reports (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL,
  summary TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', record_id TEXT, seen_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX specialist_reports_agent ON specialist_reports(agent_id, created_at);
CREATE TABLE specialist_procedures (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, signature TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]',
  count INTEGER NOT NULL DEFAULT 0, examples TEXT NOT NULL DEFAULT '[]', first_at TEXT NOT NULL, last_at TEXT NOT NULL,
  UNIQUE (agent_id, signature)
);
CREATE TABLE specialist_proposals (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, signature TEXT, title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', skill_md TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open',
  skill_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX specialist_proposals_agent ON specialist_proposals(agent_id, status);
`,
  },
  {
    // Self-updating by default: every specialist learns by itself at a modest rhythm (weekly, small budget, a free
    // model) unless the owner turns it off. Specialists that never had the learning round on (it was off by default)
    // get it now; one that was switched on and off again by the owner (learn_since set) is left alone.
    // `news`: per round "wat is er nieuw en wat verandert er daardoor aan mijn werkwijze" ({ at, nieuw, gevolg }).
    id: 'specialists-002',
    sql: `
ALTER TABLE specialist_rounds ADD COLUMN news TEXT;
UPDATE specialist_profiles SET learn_on = 1, cadence = 'weekly', budget = 'small', learn_since = updated_at WHERE learn_on = 0 AND learn_since IS NULL;
`,
  },
  {
    // The platform sets no limit of its own: the small budget that specialists-002 (and one day of defaults) gave is
    // lifted; the owner can still choose a limit per specialist.
    id: 'specialists-003',
    sql: `UPDATE specialist_profiles SET budget = 'none' WHERE budget = 'small';`,
  },
];
