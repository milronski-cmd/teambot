import { defineTable } from '../../core/db.js';
import type { Migration } from '../../core/types.js';

defineTable('teams', { json: ['profile', 'folder'] });
defineTable('team_bots', {});
defineTable('team_access', {});
defineTable('team_key_scopes', {});
defineTable('team_main', {});

/**
 * teams            a workspace of one owner: name, colour, business profile, lead bot and team folder
 * team_bots        the home team of each bot (one row per bot)
 * team_access      what a bot may do in a team that is not its home team: read (meekijken) or direct (aansturen);
 *                  for the main bot also 'none', because its default is aansturen on every team
 * team_key_scopes  a key that is "alleen dit team" (no row = usable by every team): kind provider | app | login | …
 * team_main        the owner's main bot (hoofdbot): at most one per owner (primary key), only made by the owner
 */
export const teamMigrations: Migration[] = [
  {
    id: 'teams-001',
    sql: `
CREATE TABLE teams (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#6366f1',
  profile TEXT NOT NULL DEFAULT '{}', lead_agent_id TEXT, folder TEXT, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX teams_user ON teams(user_id, sort);
CREATE TABLE team_bots (
  agent_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, team_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX team_bots_team ON team_bots(team_id);
CREATE INDEX team_bots_user ON team_bots(user_id);
CREATE TABLE team_access (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, team_id TEXT NOT NULL, level TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (agent_id, team_id)
);
CREATE INDEX team_access_team ON team_access(team_id);
CREATE INDEX team_access_user ON team_access(user_id);
CREATE TABLE team_key_scopes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, team_id TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE (kind, ref_id)
);
CREATE INDEX team_key_scopes_team ON team_key_scopes(team_id);
CREATE INDEX team_key_scopes_user ON team_key_scopes(user_id);
`,
  },
  {
    id: 'teams-002',
    sql: `
CREATE TABLE team_main (
  user_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
`,
  },
  {
    // Package B2: an optional daily budget per team (USD, 0 = none), on top of the owner's own daily budget.
    id: 'teams-002-budget',
    sql: `ALTER TABLE teams ADD COLUMN daily_budget_usd REAL NOT NULL DEFAULT 0;`,
  },
  {
    // 0.4.4 (P2): stuck work the main bot already reported (stuck.ts), so every item is told once.
    id: 'teams-003-stuck',
    sql: `CREATE TABLE team_stuck_reports (
  user_id TEXT NOT NULL, ref TEXT NOT NULL, message_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY (user_id, ref)
);`,
  },
];
