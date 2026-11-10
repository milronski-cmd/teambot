import { isDir, isFile } from '../../core/util.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Read-only reader for a local OpenBot installation (the owner's own data). Nothing in the OpenBot folders is
 * ever opened for writing: the database is copied to a private temp folder and the copy is read; JSON settings
 * and skill/instruction files are only read. Secrets (provider keys, tokens, MCP env/headers, remote-server
 * credentials) are never read into the snapshot: only whitelisted, non-secret fields are taken.
 */

export interface OpenBotPaths {
  /** OpenBot app data (%APPDATA%\OpenBot on Windows). */
  dataDir: string;
  /** Home folder that holds ~/OpenBot (Agents, Shared) and ~/.agents/skills. */
  home: string;
}

export function defaultOpenBotPaths(): OpenBotPaths {
  const home = process.env.TEAMBOT_OPENBOT_HOME || os.homedir();
  let dataDir = process.env.TEAMBOT_OPENBOT_DIR || '';
  if (!dataDir) {
    if (process.platform === 'win32') dataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'OpenBot');
    else if (process.platform === 'darwin') dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'OpenBot');
    else dataDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'OpenBot');
  }
  return { dataDir: path.resolve(dataDir), home: path.resolve(home) };
}

export interface BackupRef {
  provider: string;
  model: string;
}

export interface ObAgent {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  reasoning: string;
  access: string;
  computerUse: boolean;
  backups: BackupRef[];
  backupsAutomatic: boolean;
  workspacePath: string;
  workspaceExists: boolean;
  instructions: string;
  instructionsSource: string;
  avatarSeed: string;
  avatarHue: number | null;
  sort: number;
  pinned: boolean;
  notifications: boolean;
  /** Skill names the bot has in its own skill folders. */
  skills: string[];
  /** Marked as the lead of the team in OpenBot: a lead/orchestrator role in its settings, or it runs a chat connection. */
  lead: boolean;
}

export interface ObRoutine {
  id: string;
  agentId: string;
  name: string;
  instruction: string;
  active: boolean;
  timezone: string;
  limitPolicy: string;
  missedPolicy: string;
  runIn: string;
  schedule: any;
}

export interface ObMemory {
  id: string;
  agentId: string;
  text: string;
  inclusion: 'essential' | 'searchable';
  origin: string;
  createdAt: string;
}

export type SkillClass = 'own' | 'permissive' | 'openbot' | 'unknown';

export interface ObSkill {
  name: string;
  description: string;
  /** Folder that is imported (the team copy when there is one, otherwise the newest bot copy). */
  dir: string;
  scope: 'team' | 'agent' | 'local';
  klass: SkillClass;
  license: string;
  reason: string;
  /** OpenBot agent ids that have this skill. */
  usedBy: string[];
  /** Number of distinct contents found across copies (1 = all copies identical). */
  variants: number;
}

export interface ObSnapshot {
  paths: OpenBotPaths;
  readAt: string;
  agents: ObAgent[];
  routines: ObRoutine[];
  memories: ObMemory[];
  skills: ObSkill[];
  shared: { path: string; exists: boolean; entries: string[] };
  customProviders: { id: string; name: string; baseUrl: string; models: string[] }[];
  channels: ObChannel[];
  mcpServers: { name: string; transport: string; enabled: boolean }[];
  workflows: number;
  phonePaired: boolean;
  /** Shared team tables (agent-data.db), or null when OpenBot has none. */
  teamData: ObTeamData | null;
  /** Name of the OpenBot workspace (team server or the one sidebar section), '' when unknown or a default name. */
  workspaceName: string;
  warnings: string[];
}

/**
 * A chat connection in OpenBot (Telegram, WhatsApp, Discord, Slack …). Only names, the bot that answers and the
 * allowlist are read: tokens, bot user ids and app ids never.
 */
export interface ObChannel {
  id: string;
  platform: string;
  name: string;
  enabled: boolean;
  /** OpenBot agent that answers on it (orchestrator_agent_id), if any. */
  agentId: string | null;
  /** Allowlisted senders (platform user ids with a label); no secrets. */
  senders: { id: string; kind: string; name: string }[];
}

/** Is OpenBot running right now? From its own run marker (state + heartbeat), read only. */
export function openBotRunning(p: OpenBotPaths): { running: boolean; heartbeatAt: string | null; version: string } {
  const j = readJson(path.join(p.dataDir, 'openbot-run-marker-v1.json'));
  const hb = Number(j?.heartbeatAt);
  const heartbeatAt = Number.isFinite(hb) && hb > 0 ? new Date(hb).toISOString() : null;
  // The marker says "running" until OpenBot quits; a heartbeat older than 3 minutes means it stopped without saying so.
  const running = j?.state === 'running' && Number.isFinite(hb) && Date.now() - hb < 3 * 60_000;
  return { running, heartbeatAt, version: s(j?.appVersion, 30) };
}

/**
 * Where an agent's workspace is. OpenBot stores an absolute path; when the OpenBot home is read from somewhere else
 * (a copy, a restored backup, a moved user folder) the same folder under that home is used, so nothing outside it is read.
 */
export function workspaceOf(p: OpenBotPaths, id: string, stored: string): string {
  const own = path.join(p.home, 'OpenBot', 'Agents', id);
  if (!stored) return path.resolve(own);
  const norm = stored.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (norm.endsWith(`/openbot/agents/${id.toLowerCase()}`) && isDir(own)) return path.resolve(own);
  return path.resolve(stored);
}

/** Lead/orchestrator roles an OpenBot agent may carry in its settings. */
const LEAD_ROLES = new Set(['lead', 'leader', 'teamlead', 'team-lead', 'orchestrator', 'main', 'boss', 'chief', 'manager', 'coordinator', 'baas', 'hoofdbot', 'teamleider']);
/** Names OpenBot (or a user) gives by default: these say nothing about the team. */
const GENERIC_NAMES = /^(open ?bot|my team|mijn team|team|default|standaard|server|home|workspace|werkruimte|local|lokaal)$/i;

function leadMarker(j: any): boolean {
  for (const k of ['role', 'kind', 'type', 'agentRole', 'teamRole']) if (typeof j?.[k] === 'string' && LEAD_ROLES.has(j[k].trim().toLowerCase())) return true;
  for (const k of ['lead', 'isLead', 'orchestrator', 'isOrchestrator', 'main', 'isMain', 'boss']) if (j?.[k] === true) return true;
  return false;
}

/**
 * The name of the owner's OpenBot workspace: the team server's name (openbot-team-server-v2.json; only `serverName` is
 * taken, never its keys, members or sessions) or the single section in the sidebar. A default name ("OpenBot") is no name.
 */
function workspaceNameOf(p: OpenBotPaths): string {
  const names: string[] = [];
  const ts = readJson(path.join(p.dataDir, 'openbot-team-server-v2.json'));
  for (const h of Array.isArray(ts?.hosts) ? ts.hosts : []) if (typeof h?.serverName === 'string') names.push(h.serverName);
  const layout = readJson(path.join(p.dataDir, 'openbot-sidebar-layout-v1.json'));
  const sections = Array.isArray(layout?.sections) ? layout.sections : [];
  if (sections.length === 1) for (const k of ['name', 'title', 'label']) if (typeof sections[0]?.[k] === 'string') names.push(sections[0][k]);
  for (const n of names) {
    const v = n.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (v && !GENERIC_NAMES.test(v)) return v;
  }
  return '';
}

export function detectOpenBot(p: OpenBotPaths = defaultOpenBotPaths()) {
  const db = path.join(p.dataDir, 'openbot.db');
  const agentsDir = path.join(p.home, 'OpenBot', 'Agents');
  const sharedDir = path.join(p.home, 'OpenBot', 'Shared');
  const hasDb = isFile(db);
  let workspaces = 0;
  try {
    workspaces = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    workspaces = 0;
  }
  return { found: hasDb, dataDir: p.dataDir, hasDb, workspaces, sharedDir: isDir(sharedDir) ? sharedDir : null };
}


/** Read a small text file (never written); BOM stripped. */
function readText(p: string, max = 200_000): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 5_000_000) return null;
    const s = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return null;
  }
}

function readJson(p: string): any {
  const t = readText(p, 2_000_000);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

const s = (v: any, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Copy openbot.db (+ its WAL, so recent changes are included) to a private folder and open the copy.
 * OpenBot may be running: the copy is a best-effort snapshot; an unreadable copy is retried once.
 */
function openSnapshotDb(dbPath: string, tmpRoot: string): { db: DatabaseSync; cleanup(): void } {
  const attempt = () => {
    const dir = path.join(tmpRoot, 'openbot-' + crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
      const copy = path.join(dir, 'openbot.db');
      fs.copyFileSync(dbPath, copy);
      if (isFile(dbPath + '-wal')) fs.copyFileSync(dbPath + '-wal', copy + '-wal');
      const db = new DatabaseSync(copy);
      const ok = (db.prepare('PRAGMA quick_check').get() as any)?.quick_check;
      if (ok !== 'ok') {
        db.close();
        throw new Error('snapshot not consistent');
      }
      return {
        db,
        cleanup() {
          try {
            db.close();
          } catch {
            /* already closed */
          }
          cleanup();
        },
      };
    } catch (e) {
      cleanup();
      throw e;
    }
  };
  try {
    return attempt();
  } catch {
    return attempt();
  }
}

function hasTable(db: DatabaseSync, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
}
function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info("${table.replace(/"/g, '')}")`).all() as any[]).map((r) => String(r.name)));
}

// ---------------- skills ----------------

const LICENSE_FILES = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE', 'LICENCE.txt'];

function frontmatter(md: string): Record<string, string> {
  const m = md.replace(/^﻿/, '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Classify a skill folder. Skills that come from OpenBot itself (managed skills, or texts under the OpenBot
 * licence / marked as written or modified by OpenBot) are never imported; the owner's own skills are.
 */
export function classifySkill(dir: string): { klass: SkillClass; license: string; reason: string } {
  if (isFile(path.join(dir, '.openbot-managed.json'))) return { klass: 'openbot', license: 'OpenBot', reason: 'Beheerde OpenBot-skill (onderdeel van OpenBot zelf).' };
  const md = readText(path.join(dir, 'SKILL.md'), 20_000) ?? readText(path.join(dir, 'skill.md'), 20_000) ?? '';
  const fm = frontmatter(md);
  let licText = '';
  for (const f of LICENSE_FILES) {
    const t = readText(path.join(dir, f), 4000);
    if (t) {
      licText = t;
      break;
    }
  }
  const notice = readText(path.join(dir, 'NOTICE'), 4000) ?? readText(path.join(dir, 'NOTICE.txt'), 4000) ?? '';
  const lic = `${fm.license || ''}\n${licText.slice(0, 600)}`;
  if (/polyform/i.test(lic)) return { klass: 'openbot', license: 'PolyForm Noncommercial', reason: 'Skill uit OpenBot (licentie PolyForm Noncommercial): niet overgenomen.' };
  if (/openbot|nightly[- ]?labs/i.test(notice + '\n' + licText) || /(modified|created|written|maintained|made)\s+by\s+openbot/i.test(md.slice(0, 3000)))
    return { klass: 'openbot', license: licenseName(lic) || 'onbekend', reason: 'Skill gemaakt of bewerkt door OpenBot: niet overgenomen.' };
  const name = licenseName(lic);
  if (name) return { klass: 'permissive', license: name, reason: '' };
  if (licText || fm.license) return { klass: 'unknown', license: fm.license || 'onbekend', reason: 'Onbekende licentie: staat standaard uit. Controleer de licentie voordat je hem overneemt.' };
  return { klass: 'own', license: '', reason: '' };
}

function licenseName(t: string): string {
  if (/apache license|apache-2\.0/i.test(t)) return 'Apache-2.0';
  if (/\bMIT\b/.test(t)) return 'MIT';
  if (/\bBSD\b/.test(t)) return 'BSD';
  if (/\bISC\b/.test(t)) return 'ISC';
  return '';
}

/** The SKILL.md text of a skill (read only; '' when unreadable). */
export function skillText(sk: Pick<ObSkill, 'dir'>): string {
  return readText(path.join(sk.dir, 'SKILL.md'), 40_000) ?? readText(path.join(sk.dir, 'skill.md'), 40_000) ?? '';
}

function skillDirsIn(base: string): string[] {
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(base, e.name))
      .filter((d) => isFile(path.join(d, 'SKILL.md')) || isFile(path.join(d, 'skill.md')));
  } catch {
    return [];
  }
}

/** Content hash of a skill folder (relative paths + bytes), bounded. */
function dirHash(dir: string): { hash: string; mtime: number } {
  const h = crypto.createHash('sha256');
  let mtime = 0;
  let n = 0;
  const walk = (d: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (++n > 500) return;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full, rel + e.name + '/');
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          mtime = Math.max(mtime, st.mtimeMs);
          h.update(rel + e.name + '\0');
          if (st.size <= 2_000_000) h.update(fs.readFileSync(full));
        } catch {
          /* unreadable file: skip */
        }
      }
    }
  };
  walk(dir, '');
  return { hash: h.digest('hex'), mtime };
}

function collectSkills(p: OpenBotPaths, agents: ObAgent[]): ObSkill[] {
  type Copy = { dir: string; scope: ObSkill['scope']; agentId?: string; hash: string; mtime: number };
  const byName = new Map<string, Copy[]>();
  const add = (dir: string, scope: ObSkill['scope'], agentId?: string) => {
    const name = path.basename(dir);
    const { hash, mtime } = dirHash(dir);
    const list = byName.get(name) || [];
    list.push({ dir, scope, agentId, hash, mtime });
    byName.set(name, list);
  };
  for (const d of skillDirsIn(path.join(p.home, '.agents', 'skills'))) add(d, 'team');
  for (const d of skillDirsIn(path.join(p.dataDir, 'local-skills'))) add(d, 'local');
  for (const a of agents) {
    if (!a.workspaceExists) continue;
    const seen = new Set<string>();
    for (const sub of ['.agents', '.claude', '.codex', '.opencode']) {
      for (const d of skillDirsIn(path.join(a.workspacePath, sub, 'skills'))) {
        add(d, 'agent', a.id);
        seen.add(path.basename(d));
      }
    }
    a.skills = [...seen].sort();
  }
  const out: ObSkill[] = [];
  for (const [name, copies] of byName) {
    // The team copy is the owner's source of truth; otherwise the most recently changed copy.
    const pick = copies.find((c) => c.scope === 'team') || copies.find((c) => c.scope === 'local') || [...copies].sort((a, b) => b.mtime - a.mtime)[0];
    const cls = classifySkill(pick.dir);
    const md = readText(path.join(pick.dir, 'SKILL.md'), 20_000) ?? readText(path.join(pick.dir, 'skill.md'), 20_000) ?? '';
    const fm = frontmatter(md);
    out.push({
      name,
      description: s(fm.description, 400),
      dir: pick.dir,
      scope: pick.scope,
      klass: cls.klass,
      license: cls.license,
      reason: cls.reason,
      usedBy: [...new Set(copies.map((c) => c.agentId).filter((x): x is string => !!x))],
      variants: new Set(copies.map((c) => c.hash)).size,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------- main ----------------

export function readOpenBot(p: OpenBotPaths, tmpRoot: string): ObSnapshot {
  const dbPath = path.join(p.dataDir, 'openbot.db');
  if (!isFile(dbPath)) throw new Error(`Geen OpenBot-gegevens gevonden in ${p.dataDir}.`);
  const warnings: string[] = [];
  const snap = openSnapshotDb(dbPath, tmpRoot);
  const agents: ObAgent[] = [];
  const routines: ObRoutine[] = [];
  const memories: ObMemory[] = [];
  const channels: ObSnapshot['channels'] = [];
  const mcpServers: ObSnapshot['mcpServers'] = [];
  let workflows = 0;
  try {
    const db = snap.db;
    if (!hasTable(db, 'projection_agents')) throw new Error('Deze OpenBot-versie wordt niet herkend (geen agenttabel).');
    const pins = pinnedAgents(p);
    for (const r of db.prepare('SELECT agent_id, model, sort_order, agent_json FROM projection_agents ORDER BY sort_order').all() as any[]) {
      let j: any = {};
      try {
        j = JSON.parse(String(r.agent_json || '{}'));
      } catch {
        warnings.push(`Agent ${r.agent_id}: instellingen onleesbaar; alleen de basis is overgenomen.`);
      }
      const id = String(r.agent_id);
      const workspacePath = workspaceOf(p, id, s(j.workspacePath, 1000));
      const workspaceExists = isDir(workspacePath);
      let instructions = '';
      let instructionsSource = '';
      for (const k of ['instructions', 'systemPrompt', 'prompt']) {
        if (typeof j[k] === 'string' && j[k].trim()) {
          instructions = j[k];
          instructionsSource = 'OpenBot-instellingen';
          break;
        }
      }
      if (!instructions && workspaceExists) {
        for (const f of ['AGENTS.md', 'CLAUDE.md']) {
          const t = readText(path.join(workspacePath, f), 60_000);
          if (t && t.trim()) {
            instructions = t;
            instructionsSource = f;
            break;
          }
        }
      }
      const bm = j.backupModels && typeof j.backupModels === 'object' ? j.backupModels : {};
      const order: any[] = Array.isArray(bm.order) ? bm.order : Array.isArray(j.backupModels) ? j.backupModels : [];
      agents.push({
        id,
        name: s(j.name, 80) || 'Bot',
        description: s(j.description, 1000),
        provider: s(j.provider, 60) || 'claude',
        model: s(j.model, 200) || s(r.model, 200),
        reasoning: s(j.reasoningEffort ?? j.reasoning, 20),
        access: s(j.access, 30) || 'ask',
        computerUse: j.computerUse === true,
        backups: order.filter((b) => b && typeof b === 'object').map((b) => ({ provider: s(b.provider, 60), model: s(b.model, 200) })).filter((b) => b.provider).slice(0, 10),
        backupsAutomatic: bm.automatic !== false,
        workspacePath,
        workspaceExists,
        instructions: instructions.slice(0, 60_000),
        instructionsSource,
        avatarSeed: s(j.avatarSeed, 100),
        avatarHue: Number.isFinite(Number(j.avatarHue)) && j.avatarHue !== null ? Number(j.avatarHue) : null,
        sort: Number(r.sort_order) || 0,
        pinned: pins.has(id),
        notifications: j.notifications !== false,
        skills: [],
        lead: leadMarker(j),
      });
    }

    if (hasTable(db, 'projection_agent_routines')) {
      const c = columns(db, 'projection_agent_routines');
      const trig = hasTable(db, 'projection_routine_triggers');
      const sel = ['r.routine_id', 'r.agent_id', 'r.name', 'r.instruction', 'r.active', 'r.timezone', ...['limit_policy', 'missed_policy', 'run_in'].filter((x) => c.has(x)).map((x) => 'r.' + x)];
      const sql = `SELECT ${sel.join(', ')}${trig ? ', t.schedule_json' : ''} FROM projection_agent_routines r ${trig ? 'LEFT JOIN projection_routine_triggers t ON t.routine_id = r.routine_id' : ''} ORDER BY r.created_at`;
      for (const r of db.prepare(sql).all() as any[]) {
        let schedule: any = null;
        try {
          schedule = r.schedule_json ? JSON.parse(String(r.schedule_json)) : null;
        } catch {
          schedule = null;
        }
        routines.push({
          id: String(r.routine_id),
          agentId: String(r.agent_id),
          name: s(r.name, 80) || 'Routine',
          instruction: s(r.instruction, 20_000),
          active: Number(r.active) === 1,
          timezone: s(r.timezone, 64) || 'Europe/Amsterdam',
          limitPolicy: s(r.limit_policy, 20),
          missedPolicy: s(r.missed_policy, 20),
          runIn: s(r.run_in, 20),
          schedule,
        });
      }
    }

    if (hasTable(db, 'projection_agent_memories')) {
      const sel = hasTable(db, 'agent_memory_selections');
      const sql = `SELECT m.memory_id, m.agent_id, m.text, m.origin, m.created_at${sel ? ', s.inclusion' : ''} FROM projection_agent_memories m ${sel ? 'LEFT JOIN agent_memory_selections s ON s.memory_id = m.memory_id' : ''} ORDER BY m.created_at`;
      for (const r of db.prepare(sql).all() as any[]) {
        const text = s(r.text, 4000).trim();
        if (!text) continue;
        memories.push({ id: String(r.memory_id), agentId: String(r.agent_id), text, inclusion: r.inclusion === 'essential' ? 'essential' : 'searchable', origin: s(r.origin, 20), createdAt: s(r.created_at, 40) });
      }
    }

    // Only names/types, the answering agent and the allowlist: tokens, env and headers are never read.
    channels.push(...readChannels(db));
    // The agent that runs a chat connection is OpenBot's orchestrator: a lead signal (only the id is read).
    for (const c of channels) {
      const a = c.agentId ? agents.find((x) => x.id === c.agentId) : null;
      if (a) a.lead = true;
    }
    if (hasTable(db, 'projection_mcp_servers')) {
      for (const r of db.prepare('SELECT name, transport, enabled FROM projection_mcp_servers ORDER BY position').all() as any[]) mcpServers.push({ name: s(r.name, 120), transport: s(r.transport, 20), enabled: Number(r.enabled) === 1 });
    }
    if (hasTable(db, 'workflows') && hasTable(db, 'workflow_nodes')) {
      workflows = Number((db.prepare('SELECT COUNT(DISTINCT workflow_id) n FROM workflow_nodes').get() as any)?.n) || 0;
    }
  } finally {
    snap.cleanup();
  }

  const skills = collectSkills(p, agents);
  const sharedPath = path.join(p.home, 'OpenBot', 'Shared');
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(sharedPath, { withFileTypes: true })
      .map((e) => e.name + (e.isDirectory() ? '/' : ''))
      .sort()
      .slice(0, 40);
  } catch {
    entries = [];
  }

  let teamData: ObTeamData | null = null;
  try {
    teamData = readTeamData(p, tmpRoot);
    if (teamData) warnings.push(...teamData.warnings);
  } catch (e: any) {
    warnings.push(`Teamtabellen (agent-data.db) konden niet worden gelezen: ${e?.message || e}`);
  }

  const cp = readJson(path.join(p.dataDir, 'openbot-custom-providers-v1.json'));
  const customProviders = (Array.isArray(cp?.providers) ? cp.providers : [])
    .filter((x: any) => x && typeof x === 'object')
    .map((x: any) => ({ id: s(x.id, 100), name: s(x.name, 100), baseUrl: s(x.baseUrl ?? x.url, 300), models: (Array.isArray(x.models) ? x.models : []).map((m: any) => s(typeof m === 'string' ? m : m?.id, 200)).filter(Boolean).slice(0, 50) }));

  return {
    paths: p,
    readAt: new Date().toISOString(),
    agents,
    routines,
    memories,
    skills,
    shared: { path: sharedPath, exists: isDir(sharedPath), entries },
    customProviders,
    channels,
    mcpServers,
    workflows,
    phonePaired: isFile(path.join(p.dataDir, 'openbot-push-notifications-v1.json')) || isFile(path.join(p.dataDir, 'openbot-remote-servers-v1.json')),
    teamData,
    workspaceName: workspaceNameOf(p),
    warnings,
  };
}

// ---------------- shared team tables (agent-data.db) ----------------

export interface ObTeamTable {
  name: string;
  /** Original CREATE TABLE statement. */
  sql: string;
  /** OpenBot agent id that created the table (openbot_metadata), if known. */
  ownerAgentId: string | null;
  rows: Record<string, any>[];
  /** Rows in the table (rows[] may be capped). */
  total: number;
}

export interface ObTeamData {
  path: string;
  tables: ObTeamTable[];
  warnings: string[];
}

const TEAM_ROWS_MAX = 50_000;
const TEAM_CELL_MAX = 200_000;

/** The team database OpenBot's agents share (~/OpenBot/Shared/Data/agent-data.db). */
export function teamDataPath(p: OpenBotPaths) {
  return path.join(p.home, 'OpenBot', 'Shared', 'Data', 'agent-data.db');
}

/**
 * Read the shared team tables from a private copy (the original and its WAL are only read, never opened by SQLite).
 * Every table except OpenBot's own bookkeeping; each row carries `__rowid` for tables without an `id` column.
 */
export function readTeamData(p: OpenBotPaths, tmpRoot: string): ObTeamData | null {
  const file = teamDataPath(p);
  if (!isFile(file)) return null;
  const warnings: string[] = [];
  const snap = openSnapshotDb(file, tmpRoot);
  const tables: ObTeamTable[] = [];
  try {
    const db = snap.db;
    const owners = new Map<string, string>();
    if (hasTable(db, 'openbot_metadata')) for (const r of db.prepare('SELECT table_name, owner_agent_id FROM openbot_metadata').all() as any[]) owners.set(String(r.table_name), String(r.owner_agent_id));
    const list = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' AND name != 'openbot_metadata' ORDER BY name").all() as any[];
    for (const t of list) {
      const name = String(t.name);
      const q = `"${name.replace(/"/g, '""')}"`;
      const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${q}`).get() as any)?.n) || 0;
      let rows: Record<string, any>[] = [];
      try {
        rows = (db.prepare(`SELECT rowid AS __rowid, * FROM ${q} ORDER BY rowid LIMIT ${TEAM_ROWS_MAX}`).all() as any[]).map((r) => {
          for (const k of Object.keys(r)) if (typeof r[k] === 'string' && r[k].length > TEAM_CELL_MAX) r[k] = r[k].slice(0, TEAM_CELL_MAX);
          return r;
        });
      } catch {
        // WITHOUT ROWID table
        rows = db.prepare(`SELECT * FROM ${q} LIMIT ${TEAM_ROWS_MAX}`).all() as any[];
      }
      if (total > rows.length) warnings.push(`Tabel ${name}: alleen de eerste ${TEAM_ROWS_MAX.toLocaleString('nl-NL')} van ${total.toLocaleString('nl-NL')} rijen worden overgenomen.`);
      tables.push({ name, sql: String(t.sql || ''), ownerAgentId: owners.get(name) || null, rows, total });
    }
  } finally {
    snap.cleanup();
  }
  return { path: file, tables, warnings };
}

/** Chat connections (no secrets: only the whitelisted columns are selected). */
function readChannels(db: DatabaseSync): ObChannel[] {
  if (!hasTable(db, 'projection_messaging_connections')) return [];
  const c = columns(db, 'projection_messaging_connections');
  const sel = ['platform', 'workspace_name', 'enabled', ...['connection_id', 'orchestrator_agent_id'].filter((x) => c.has(x))];
  const senders = new Map<string, ObChannel['senders']>();
  if (c.has('connection_id') && hasTable(db, 'projection_messaging_allowed_senders')) {
    const sc = columns(db, 'projection_messaging_allowed_senders');
    if (sc.has('connection_id') && sc.has('sender_id'))
      for (const r of db.prepare(`SELECT connection_id, sender_id${sc.has('kind') ? ', kind' : ''}${sc.has('name') ? ', name' : ''} FROM projection_messaging_allowed_senders`).all() as any[]) {
        const list = senders.get(String(r.connection_id)) || [];
        if (list.length < 200) list.push({ id: s(r.sender_id, 120), kind: s(r.kind, 30), name: s(r.name, 120) });
        senders.set(String(r.connection_id), list);
      }
  }
  return (db.prepare(`SELECT ${sel.join(', ')} FROM projection_messaging_connections`).all() as any[]).map((r, i) => {
    const id = r.connection_id != null ? String(r.connection_id) : `conn-${i + 1}`;
    return {
      id,
      platform: s(r.platform, 40).toLowerCase(),
      name: s(r.workspace_name, 120),
      enabled: Number(r.enabled) === 1,
      agentId: r.orchestrator_agent_id != null ? String(r.orchestrator_agent_id) : null,
      senders: (senders.get(id) || []).filter((x) => x.id),
    };
  });
}

export interface ObLive {
  found: boolean;
  running: boolean;
  heartbeatAt: string | null;
  version: string;
  routines: { id: string; agentId: string; name: string; active: boolean }[];
  channels: ObChannel[];
}

/**
 * What runs in OpenBot right now (for the switch-over steps): which routines and chat connections are switched on,
 * and whether OpenBot itself is running. Reads a private copy of the database, like the import; nothing is written.
 */
export function readOpenBotLive(p: OpenBotPaths, tmpRoot: string): ObLive {
  const dbPath = path.join(p.dataDir, 'openbot.db');
  const running = openBotRunning(p);
  if (!isFile(dbPath)) return { found: false, ...running, routines: [], channels: [] };
  const snap = openSnapshotDb(dbPath, tmpRoot);
  try {
    const db = snap.db;
    const routines = hasTable(db, 'projection_agent_routines')
      ? (db.prepare('SELECT routine_id, agent_id, name, active FROM projection_agent_routines').all() as any[]).map((r) => ({ id: String(r.routine_id), agentId: String(r.agent_id), name: s(r.name, 80), active: Number(r.active) === 1 }))
      : [];
    return { found: true, ...running, routines, channels: readChannels(db) };
  } finally {
    snap.cleanup();
  }
}

function pinnedAgents(p: OpenBotPaths): Set<string> {
  const j = readJson(path.join(p.dataDir, 'openbot-sidebar-pins-v1.json'));
  const out = new Set<string>();
  const members = j?.members && typeof j.members === 'object' ? Object.values(j.members) : [];
  for (const m of members as any[]) for (const it of Array.isArray(m?.items) ? m.items : []) if (it?.kind === 'agent' && typeof it.id === 'string') out.add(it.id);
  return out;
}

/** Bounded size estimate of a folder (for the copy-or-reference choice). */
export function folderSize(dir: string, cap = 10_000): { files: number; bytes: number; capped: boolean } {
  let files = 0;
  let bytes = 0;
  let capped = false;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files >= cap) {
        capped = true;
        return { files, bytes, capped };
      }
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        files++;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { files, bytes, capped };
}
