import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Synthetic OpenBot installation for tests (made-up data, built at test time). Layout mirrors what the importer
 * reads: <root>/appdata/openbot.db (+ JSON settings) and <root>/home/{OpenBot/Agents,OpenBot/Shared,.agents/skills}.
 * Contains decoy secrets that must never show up in a preview, an import or a log.
 */
export const DECOY_SECRETS = ['sk-decoy-provider-key-123', 'mcp-decoy-env-token-456', 'decoy-header-secret-789'];

export interface OpenBotFixture {
  root: string;
  dataDir: string;
  home: string;
  agents: { baas: string; klant: string };
  workspace(id: string): string;
  /** sha256 of every file under root (relative path → hash). */
  hashes(): Record<string, string>;
  cleanup(): void;
}

function write(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function makeOpenBotFixture(): OpenBotFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-openbot-'));
  const dataDir = path.join(root, 'appdata');
  const home = path.join(root, 'home');
  const baas = 'agent-11111111-aaaa-4bbb-8ccc-000000000001';
  const klant = 'agent-22222222-aaaa-4bbb-8ccc-000000000002';
  const ws = (id: string) => path.join(home, 'OpenBot', 'Agents', id);

  // ---- workspaces, instructions and skills ----
  write(path.join(ws(baas), 'AGENTS.md'), '# Baas\n\nJe bent de baas van het testteam. Lees `~/OpenBot/Shared/LEESMIJ.md`.\n');
  write(path.join(ws(baas), 'notities', 'plan.md'), 'Plan voor de week.\n');
  write(path.join(ws(klant), 'AGENTS.md'), '﻿# Klantenservice\n\nBeantwoord klantmails als concept.\n');
  const ownSkill = '---\nname: dossier-bijwerken\ndescription: Houd de dossiers in de teammap bij.\n---\n\n# Werkwijze\n1. Lees het dossier.\n';
  const teamSkill = '---\nname: team-database\ndescription: Gedeelde teamtabellen gebruiken.\n---\n\nGebruik de tabellen.\n';
  for (const id of [baas, klant]) for (const sub of ['.agents', '.claude']) {
    write(path.join(ws(id), sub, 'skills', 'dossier-bijwerken', 'SKILL.md'), ownSkill);
    write(path.join(ws(id), sub, 'skills', 'team-database', 'SKILL.md'), teamSkill);
    write(path.join(ws(id), sub, 'skills', 'beheerde-skill', 'SKILL.md'), '---\nname: beheerde-skill\ndescription: Beheerd door de app.\n---\nTekst.\n');
    write(path.join(ws(id), sub, 'skills', 'beheerde-skill', '.openbot-managed.json'), '{"managed":true}');
  }
  write(path.join(ws(baas), '.agents', 'skills', 'markt-skill', 'SKILL.md'), '---\nname: "Markt Skill"\ndescription: "Uit een marktplaats."\n---\nTekst.\n');
  write(path.join(ws(baas), '.agents', 'skills', 'markt-skill', 'LICENSE.txt'), '# PolyForm Noncommercial License 1.0.0\n\n<https://polyformproject.org/licenses/noncommercial/1.0.0>\n');
  write(path.join(ws(baas), '.agents', 'skills', 'vrije-skill', 'SKILL.md'), '---\nname: vrije-skill\ndescription: Een skill onder Apache-2.0.\n---\nTekst.\n');
  write(path.join(ws(baas), '.agents', 'skills', 'vrije-skill', 'LICENSE.txt'), '                                 Apache License\n                           Version 2.0, January 2004\n');
  // Team skill (source of truth) is newer than the bot copies.
  write(path.join(home, '.agents', 'skills', 'dossier-bijwerken', 'SKILL.md'), ownSkill + '2. Werk de tijdlijn bij.\n');

  // ---- shared folder ----
  write(path.join(home, 'OpenBot', 'Shared', 'LEESMIJ.md'), '# Teammap\n');
  write(path.join(home, 'OpenBot', 'Shared', 'Dossiers', 'klant-a.md'), '# Klant A\n');
  write(path.join(home, 'OpenBot', 'Shared', 'Kennis', 'seo.md'), '# SEO\n');

  // ---- JSON settings (with decoy secrets) ----
  write(path.join(dataDir, 'openbot-custom-providers-v1.json'), JSON.stringify({ version: 1, providers: [{ id: 'lokaal-1', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'qwen-test', name: 'Qwen' }], secret: { value: DECOY_SECRETS[0] } }] }));
  write(path.join(dataDir, 'openbot-provider-credentials-v1.json'), JSON.stringify({ version: 1, credentials: { deepseek: DECOY_SECRETS[0] } }));
  write(path.join(dataDir, 'openbot-sidebar-pins-v1.json'), JSON.stringify({ version: 1, members: { owner: { items: [{ kind: 'agent', id: baas }] } } }));
  write(path.join(dataDir, 'openbot-push-notifications-v1.json'), JSON.stringify({ version: 1, token: DECOY_SECRETS[2] }));

  // ---- database ----
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'openbot.db'));
  db.exec(`
    CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, thread_id TEXT, model TEXT NOT NULL, updated_at TEXT, sort_order INTEGER NOT NULL, agent_json TEXT NOT NULL, last_event_sequence INTEGER NOT NULL);
    CREATE TABLE projection_agent_routines (routine_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, instruction TEXT NOT NULL, active INTEGER NOT NULL, timezone TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_sequence INTEGER NOT NULL, limit_policy TEXT NOT NULL DEFAULT 'wait', missed_policy TEXT NOT NULL DEFAULT 'skip', run_in TEXT NOT NULL DEFAULT 'chat');
    CREATE TABLE projection_routine_triggers (trigger_id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, schedule_json TEXT NOT NULL, next_run_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_sequence INTEGER NOT NULL);
    CREATE TABLE projection_agent_memories (memory_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL, normalized_text TEXT NOT NULL, origin TEXT NOT NULL, source_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_sequence INTEGER NOT NULL);
    CREATE TABLE agent_memory_selections (memory_id TEXT PRIMARY KEY, inclusion TEXT NOT NULL DEFAULT 'searchable', user_controlled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE projection_messaging_connections (connection_id TEXT PRIMARY KEY, platform TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_name TEXT NOT NULL, enabled INTEGER NOT NULL, bot_user_id TEXT, app_id TEXT, orchestrator_agent_id TEXT, last_error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE projection_mcp_servers (mcp_server_id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL, enabled INTEGER NOT NULL, command TEXT NOT NULL, args_json TEXT NOT NULL, env_json TEXT NOT NULL, env_passthrough_json TEXT NOT NULL, working_directory TEXT NOT NULL, url TEXT NOT NULL, headers_json TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  const ts = '2026-11-06T00:00:00.000Z';
  const agent = (id: string, sort: number, j: any) => db.prepare('INSERT INTO projection_agents VALUES (?, ?, ?, ?, ?, ?, 1)').run(id, 'openbot-thread-' + id, j.model, ts, sort, JSON.stringify({ id, threadId: 'openbot-thread-' + id, workspacePath: ws(id), ...j }));
  agent(baas, 1, {
    name: 'Baas',
    description: 'Hoofdbot van het testteam.',
    model: 'claude-opus-5-5',
    reasoningEffort: 'high',
    provider: 'claude',
    access: 'full',
    computerUse: true,
    avatarSeed: 'baas-test',
    avatarHue: 200,
    backupModels: { automatic: true, order: [{ provider: 'claude', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-v4-pro' }, { provider: 'opencode', model: 'opencode/test-free' }] },
  });
  agent(klant, 0, { name: 'Klantenservice', description: 'Klantmails.', model: 'gpt-test-codex', reasoningEffort: 'low', provider: 'codex', access: 'full', computerUse: false, avatarSeed: 'klant', avatarHue: null, backupModels: { automatic: true, order: [{ provider: 'deepseek', model: 'deepseek-flash' }] } });
  const routine = (id: string, agentId: string, name: string, schedule: any, o: { active?: number; run_in?: string; missed?: string } = {}) => {
    db.prepare('INSERT INTO projection_agent_routines VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)').run(id, agentId, name, `Doe ${name.toLowerCase()}.`, o.active ?? 1, 'Europe/Amsterdam', ts, ts, 'wait', o.missed || 'skip', o.run_in || 'thread');
    db.prepare('INSERT INTO projection_routine_triggers VALUES (?, ?, ?, ?, ?, ?, 1)').run('trg-' + id, id, JSON.stringify(schedule), ts, ts, ts);
  };
  routine('r-daily', baas, 'Dagoverzicht', { kind: 'daily', time: '07:45' });
  routine('r-weekly', baas, 'Opruimen', { kind: 'weekly', weekday: 0, time: '20:00' });
  routine('r-monthly', baas, 'Maandmeting', { kind: 'monthly', day: 1, time: '08:00' }, { run_in: 'chat' });
  routine('r-once', baas, 'Eenmalig meten', { kind: 'once', date: '2026-01-20', time: '09:00' }, { missed: 'run-once' });
  routine('r-interval', klant, 'Inbox-ronde', { kind: 'interval', amount: 3, unit: 'hours', anchorAt: '2026-11-06T12:00:00+01:00' });
  routine('r-cron', klant, 'Avondcontrole', { kind: 'custom', expression: '*/30 8-22 * * *' }, { active: 0 });
  routine('r-weird', klant, 'Raar schema', { kind: 'lunar', phase: 'full' });
  const mem = (id: string, agentId: string, text: string, inclusion: string) => {
    db.prepare('INSERT INTO projection_agent_memories VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1)').run(id, agentId, text, text.toLowerCase(), 'automatic', ts, ts);
    db.prepare('INSERT INTO agent_memory_selections VALUES (?, ?, 0, 0)').run(id, inclusion);
  };
  mem('m1', baas, 'Sanne wil korte antwoorden in het Nederlands.', 'essential');
  mem('m2', baas, 'De weekplanning staat in notities/plan.md.', 'searchable');
  mem('m3', klant, 'Klantmails eerst als concept klaarzetten.', 'searchable');
  db.prepare('INSERT INTO projection_mcp_servers VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)').run('mcp1', 'Testapp', 'stdio', 'node', '[]', JSON.stringify({ TOKEN: DECOY_SECRETS[1] }), '[]', '', '', JSON.stringify({ Authorization: DECOY_SECRETS[2] }), ts, ts);
  db.prepare('INSERT INTO projection_messaging_connections VALUES (?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, ?, ?)').run('c1', 'telegram', 'w1', 'Testgroep', ts, ts);
  db.close();

  const hashes = () => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else out[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    };
    walk(root);
    return out;
  };
  return { root, dataDir, home, agents: { baas, klant }, workspace: ws, hashes, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
