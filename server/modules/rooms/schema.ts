import { defineTable } from '../../core/db.js';
import type { Migration } from '../../core/types.js';

defineTable('rooms', { json: ['limits', 'settings', 'state'], bool: ['archived'] });
defineTable('room_members', { json: ['perms'], bool: ['paused', 'accepted'] });
defineTable('room_delegations', { json: ['path'], bool: ['wait', 'follow_up', 'delivered'] });
defineTable('room_teams', {});
defineTable('room_team_members', {});
defineTable('room_tasks', {});
defineTable('room_proposals', { json: ['profile'] });
defineTable('room_activity', { json: ['data'] });
defineTable('room_inbox', { bool: ['read'] });

export const roomMigrations: Migration[] = [
  {
    id: 'rooms-001',
    sql: `
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, thread_id TEXT NOT NULL, team_id TEXT, name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'lead', lead_agent_id TEXT, owner_agent_id TEXT, instructions TEXT NOT NULL DEFAULT '',
  limits TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active', status_reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}', archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX rooms_user ON rooms(user_id);
CREATE UNIQUE INDEX rooms_thread ON rooms(thread_id);

CREATE TABLE room_members (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
  perms TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'idle', state_detail TEXT NOT NULL DEFAULT '', last_run_id TEXT,
  paused INTEGER NOT NULL DEFAULT 0, accepted INTEGER NOT NULL DEFAULT 1, invited_by TEXT, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (room_id, kind, ref_id)
);
CREATE INDEX room_members_ref ON room_members(kind, ref_id);

CREATE TABLE room_delegations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT, kind TEXT NOT NULL DEFAULT 'delegate', group_id TEXT,
  parent_thread_id TEXT NOT NULL, parent_run_id TEXT, tool_call_id TEXT, thread_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, task TEXT NOT NULL DEFAULT '', expected TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', result TEXT, error TEXT, run_id TEXT, chain_id TEXT, path TEXT NOT NULL DEFAULT '[]',
  depth INTEGER NOT NULL DEFAULT 1, wait INTEGER NOT NULL DEFAULT 0, follow_up INTEGER NOT NULL DEFAULT 1,
  delivered INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX room_delegations_parent ON room_delegations(parent_thread_id);
CREATE INDEX room_delegations_room ON room_delegations(room_id);
CREATE INDEX room_delegations_run ON room_delegations(run_id);
CREATE INDEX room_delegations_call ON room_delegations(tool_call_id);
CREATE INDEX room_delegations_group ON room_delegations(group_id);

CREATE TABLE room_teams (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  chief_agent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX room_teams_user ON room_teams(user_id);
CREATE TABLE room_team_members (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
  title TEXT NOT NULL DEFAULT '', reports_to TEXT, created_at TEXT NOT NULL, UNIQUE (team_id, agent_id)
);

CREATE TABLE room_tasks (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT, team_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo', owner_type TEXT, owner_id TEXT, deadline TEXT, source_thread_id TEXT, source_message_id TEXT,
  result TEXT NOT NULL DEFAULT '', created_by_type TEXT NOT NULL DEFAULT 'user', created_by_id TEXT, created_by_name TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX room_tasks_user ON room_tasks(user_id);
CREATE INDEX room_tasks_room ON room_tasks(room_id);

CREATE TABLE room_proposals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT, team_id TEXT, proposer_agent_id TEXT NOT NULL, kind TEXT NOT NULL,
  agent_id TEXT, profile TEXT NOT NULL DEFAULT '{}', reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT, decided_at TEXT, result_agent_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX room_proposals_user ON room_proposals(user_id, status);

CREATE TABLE room_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX room_activity_room ON room_activity(room_id, id);

CREATE TABLE room_inbox (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '', ref_id TEXT, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX room_inbox_user ON room_inbox(user_id, read, created_at);
`,
  },
  {
    // 0.4 teams as workspaces (module teams): an org-chart department and a task belong to one team. Filled for
    // existing rows by the teams module ("Mijn team"); NULL = not linked (visible to every team).
    id: 'rooms-002',
    sql: `
ALTER TABLE room_teams ADD COLUMN workspace_id TEXT;
ALTER TABLE room_tasks ADD COLUMN workspace_id TEXT;
CREATE INDEX room_tasks_workspace ON room_tasks(workspace_id);
`,
  },
  // Package D: "Belangrijk" on a task (its work never runs below the minimum level and pauses instead; engine-chain).
  // Its own id so other task columns added in parallel (rooms-002 …) never clash with it.
  {
    id: 'rooms-task-important',
    sql: `ALTER TABLE room_tasks ADD COLUMN important INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // 0.4 package B2: a group belongs to one team (walls.ts). Filled at start for existing groups: the team of their
    // bots, else the default team; "Bots van andere teams toestaan" is settings.crossTeam. Its own id (no number),
    // like rooms-task-important, so migrations added in parallel never clash.
    id: 'rooms-group-team',
    sql: `
ALTER TABLE rooms ADD COLUMN workspace_id TEXT;
CREATE INDEX rooms_workspace ON rooms(workspace_id);
`,
  },
];
