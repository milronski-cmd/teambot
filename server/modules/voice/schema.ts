import type { Migration } from '../../core/types.js';
import { defineTable } from '../../core/db.js';

defineTable('voice_calls', { json: ['transcript', 'usage'], bool: ['keep_transcript'] });
defineTable('voice_clips', { json: ['segments'], bool: ['audio_deleted'] });
defineTable('voice_tts', {});

export const migrations: Migration[] = [
  {
    id: 'voice-001',
    sql: `
CREATE TABLE voice_tts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, message_id TEXT, agent_id TEXT, hash TEXT NOT NULL,
  provider_id TEXT, model TEXT NOT NULL DEFAULT '', voice TEXT NOT NULL DEFAULT '', path TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, chars INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, UNIQUE (user_id, hash)
);
CREATE INDEX voice_tts_user ON voice_tts(user_id, last_used_at);
CREATE INDEX voice_tts_message ON voice_tts(message_id);
CREATE TABLE voice_clips (
  attachment_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, thread_id TEXT, transcript TEXT NOT NULL DEFAULT '',
  language TEXT, duration REAL, segments TEXT NOT NULL DEFAULT '[]', timing TEXT NOT NULL DEFAULT 'estimated',
  model TEXT NOT NULL DEFAULT '', provider_id TEXT, provider_name TEXT NOT NULL DEFAULT '', cost REAL NOT NULL DEFAULT 0,
  audio_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX voice_clips_user ON voice_clips(user_id, created_at);
CREATE TABLE voice_calls (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'realtime', mode TEXT NOT NULL DEFAULT 'direct', provider_id TEXT,
  model TEXT NOT NULL DEFAULT '', voice TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'connecting',
  keep_transcript INTEGER NOT NULL DEFAULT 1, transcript TEXT NOT NULL DEFAULT '[]', usage TEXT NOT NULL DEFAULT '{}',
  cost REAL NOT NULL DEFAULT 0, price_cap REAL NOT NULL DEFAULT 0, asks INTEGER NOT NULL DEFAULT 0, error TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, duration_sec REAL NOT NULL DEFAULT 0
);
CREATE INDEX voice_calls_user ON voice_calls(user_id, started_at);
CREATE INDEX voice_calls_agent ON voice_calls(agent_id);
`,
  },
  {
    // Cloud calls: who hung up (the bot via end_call, or you), why, and the bot's own short summary for the call log.
    id: 'voice-002',
    sql: `
ALTER TABLE voice_calls ADD COLUMN ended_by TEXT;
ALTER TABLE voice_calls ADD COLUMN end_reason TEXT;
ALTER TABLE voice_calls ADD COLUMN summary TEXT;
`,
  },
];
