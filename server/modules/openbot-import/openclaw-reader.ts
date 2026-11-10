import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Reading an OpenClaw installation (OpenClaw is MIT; we read its file format, no code is copied). Only reads, never
 * writes, and never opens what holds secrets: `credentials/`, `.env`, `agents/<id>/agent/` (auth profiles, the agent's
 * own database), and from `openclaw.json` only the agent list, names, workspaces and models (keys, tokens, channel
 * accounts and `env` are never read into the snapshot).
 *
 * Layout (docs.openclaw.ai, 2026):
 *  - state folder `~/.openclaw` (`OPENCLAW_STATE_DIR`; older installs `~/.clawdbot` or `~/.moltbot`), config
 *    `openclaw.json` (JSON5; `OPENCLAW_CONFIG_PATH`);
 *  - agents: `agents.entries` (keyed by id) or the older `agents.list[]` (`default: true`); without a list one agent
 *    `main`. Workspace: the entry's `workspace`, else `~/.openclaw/workspace` for the default agent and
 *    `~/.openclaw/workspace-<id>` (or `<agents.defaults.workspace>/<id>`) for the others;
 *  - per workspace: `AGENTS.md` (instructions), `SOUL.md` (persona), `IDENTITY.md` (name, emoji), `USER.md` (about the
 *    owner), `MEMORY.md` (long-term memory), `memory/YYYY-MM-DD.md` (daily log), `skills/<name>/SKILL.md`;
 *  - shared skills `~/.openclaw/skills/<name>/SKILL.md`;
 *  - scheduled jobs: `cron/jobs.json` (`{ version: 1, jobs: [...] }`), newer installs keep them in
 *    `state/openclaw.sqlite` (read from a private copy, best effort).
 * Tests point it at a fixture with `TEAMBOT_OPENCLAW_DIR`.
 */

export interface OpenClawPaths {
  stateDir: string;
  configPath: string;
}

export interface OcSkill {
  name: string;
  dir: string;
  scope: 'workspace' | 'shared';
}

export interface OcAgent {
  id: string;
  name: string;
  emoji: string;
  model: string;
  isDefault: boolean;
  workspace: string;
  workspaceExists: boolean;
  instructions: string;
  instructionFiles: string[];
  userFacts: string;
  memory: string;
  dailyLogs: number;
  skills: OcSkill[];
}

export interface OcJob {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  schedule: any;
  payload: any;
  timezone: string;
}

export interface OcSnapshot {
  paths: OpenClawPaths;
  agents: OcAgent[];
  sharedSkills: OcSkill[];
  jobs: OcJob[];
  /** Things we saw but do not bring over (in words, for "Wat niet meekomt"). */
  seen: {
    channels: string[];
    sessions: number;
    dailyLogs: number;
    jobsInDatabase: boolean;
  };
  warnings: string[];
}

const MAX_TEXT = 200_000;

export function defaultOpenClawPaths(): OpenClawPaths {
  const home = process.env.TEAMBOT_OPENCLAW_HOME || os.homedir();
  const override = process.env.TEAMBOT_OPENCLAW_DIR || process.env.OPENCLAW_STATE_DIR;
  let stateDir = override ? path.resolve(override) : path.join(home, '.openclaw');
  if (!override && !fs.existsSync(stateDir)) for (const legacy of ['.clawdbot', '.moltbot']) if (fs.existsSync(path.join(home, legacy))) stateDir = path.join(home, legacy);
  let configPath = process.env.TEAMBOT_OPENCLAW_DIR ? path.join(stateDir, 'openclaw.json') : process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, 'openclaw.json');
  if (!fs.existsSync(configPath)) for (const alt of ['clawdbot.json', 'moltbot.json']) if (fs.existsSync(path.join(stateDir, alt))) configPath = path.join(stateDir, alt);
  return { stateDir, configPath };
}

export function detectOpenClaw(p: OpenClawPaths): {
  found: boolean;
  dir: string;
} {
  const found = fs.existsSync(p.configPath) || fs.existsSync(path.join(p.stateDir, 'workspace'));
  return { found, dir: p.stateDir };
}

/** JSON5 as OpenClaw writes it (comments, trailing commas, unquoted keys, single quotes) → a value. */
export function parseJson5(src: string): any {
  const s = String(src || '').replace(/^﻿/, '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      // A string: copied as a JSON string (single quotes become double quotes).
      let j = i + 1;
      let val = '';
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\' && j + 1 < s.length) {
          val += s[j] + s[j + 1];
          j += 2;
          continue;
        }
        val += s[j] === '"' ? '\\"' : s[j];
        j++;
      }
      out += `"${c === "'" ? val.replace(/\\'/g, "'") : val}"`;
      i = j + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (c === '}' || c === ']') {
      // A trailing comma before the end of an object or list.
      out = out.replace(/,\s*$/, '');
      out += c;
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c) && /[{,]\s*$/.test(out)) {
      // An unquoted key.
      let j = i;
      while (j < s.length && /[\w$-]/.test(s[j])) j++;
      let k = j;
      while (k < s.length && /\s/.test(s[k])) k++;
      if (s[k] === ':') {
        out += `"${s.slice(i, j)}"`;
        i = j;
        continue;
      }
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

const readText = (f: string): string => {
  try {
    const st = fs.statSync(f);
    if (!st.isFile()) return '';
    return fs.readFileSync(f, 'utf8').slice(0, MAX_TEXT);
  } catch {
    return '';
  }
};
const expand = (p: string, home: string) => (p.startsWith('~') ? path.join(home, p.slice(1)) : p);

/** IDENTITY.md: "- **Name:** Clawd" / "Emoji: 🦞" style lines. */
export function parseIdentity(text: string): { name: string; emoji: string } {
  const get = (k: string) =>
    text
      .match(new RegExp(`^[\\s>*-]*\\**\\s*(?:${k})\\s*\\**\\s*[:：]\\s*\\**\\s*(.+?)\\s*$`, 'im'))?.[1]
      ?.replace(/\*+/g, '')
      .trim() || '';
  return {
    name: get('name|naam').slice(0, 80),
    emoji: get('emoji').slice(0, 8),
  };
}

function skillsIn(dir: string, scope: OcSkill['scope']): OcSkill[] {
  const out: OcSkill[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const d = path.join(dir, e.name);
    if (fs.existsSync(path.join(d, 'SKILL.md'))) out.push({ name: e.name, dir: d, scope });
  }
  return out;
}

function modelOf(v: any): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.primary === 'string') return v.primary;
  return '';
}

/** Jobs from the newer database: any table about cron/jobs with a JSON column that has a schedule (best effort). */
function jobsFromDatabase(stateDir: string, tmp: string): any[] {
  const db = path.join(stateDir, 'state', 'openclaw.sqlite');
  if (!fs.existsSync(db)) return [];
  const copy = path.join(tmp, `oc-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  const out: any[] = [];
  try {
    fs.copyFileSync(db, copy);
    if (fs.existsSync(db + '-wal')) fs.copyFileSync(db + '-wal', copy + '-wal');
    const d = new DatabaseSync(copy, { readOnly: true });
    try {
      const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((r) => String(r.name)).filter((n) => /cron|job|automation/i.test(n) && /^[\w]+$/.test(n));
      for (const t of tables) {
        for (const row of d.prepare(`SELECT * FROM "${t}" LIMIT 500`).all() as any[]) {
          for (const v of Object.values(row)) {
            if (typeof v !== 'string' || !v.startsWith('{')) continue;
            try {
              const j = JSON.parse(v);
              if (j && typeof j === 'object' && j.schedule && (j.payload || j.message)) {
                out.push({
                  id: j.id ?? row.id,
                  name: j.name ?? row.name,
                  enabled: j.enabled ?? row.enabled,
                  ...j,
                });
                break;
              }
            } catch {
              /* not JSON */
            }
          }
        }
      }
    } finally {
      d.close();
    }
  } catch {
    /* unreadable: said in the warnings by the caller */
  } finally {
    for (const f of [copy, copy + '-wal', copy + '-shm']) fs.rmSync(f, { force: true });
  }
  return out;
}

export function readOpenClaw(p: OpenClawPaths, tmp: string = os.tmpdir()): OcSnapshot {
  const home = process.env.TEAMBOT_OPENCLAW_HOME || os.homedir();
  const warnings: string[] = [];
  let cfg: any = {};
  if (fs.existsSync(p.configPath)) {
    try {
      cfg = parseJson5(fs.readFileSync(p.configPath, 'utf8')) || {};
    } catch {
      warnings.push('De instellingen van OpenClaw (openclaw.json) konden niet worden gelezen; de standaardwerkmap is gebruikt.');
    }
  }
  const agentsCfg = cfg?.agents || {};
  const defaults = agentsCfg.defaults || {};
  let entries: { id: string; e: any }[] = [];
  if (agentsCfg.entries && typeof agentsCfg.entries === 'object' && !Array.isArray(agentsCfg.entries))
    entries = Object.entries(agentsCfg.entries).map(([id, e]) => ({
      id,
      e: e || {},
    }));
  else if (Array.isArray(agentsCfg.list)) entries = agentsCfg.list.filter((e: any) => e && typeof e.id === 'string').map((e: any) => ({ id: e.id, e }));
  if (!entries.length) entries = [{ id: 'main', e: {} }];
  const defaultId = entries.find((x) => x.e.default === true)?.id || (entries.some((x) => x.id === 'main') ? 'main' : entries[0].id);

  const agents: OcAgent[] = [];
  for (const { id, e } of entries) {
    if (!/^[\w.-]{1,64}$/.test(id)) continue;
    const isDefault = id === defaultId;
    const ws = e.workspace
      ? path.resolve(expand(String(e.workspace), home))
      : isDefault
        ? path.resolve(expand(String(defaults.workspace || path.join(p.stateDir, 'workspace')), home))
        : defaults.workspace
          ? path.join(path.resolve(expand(String(defaults.workspace), home)), id)
          : path.join(p.stateDir, `workspace-${id}`);
    const exists = fs.existsSync(ws);
    const files: string[] = [];
    const agentsMd = readText(path.join(ws, 'AGENTS.md'));
    if (agentsMd) files.push('AGENTS.md');
    const soul = readText(path.join(ws, 'SOUL.md'));
    if (soul) files.push('SOUL.md');
    const identity = parseIdentity(readText(path.join(ws, 'IDENTITY.md')));
    const instructions = [agentsMd.trim(), soul.trim() ? `## Persoonlijkheid (uit SOUL.md van OpenClaw)\n\n${soul.trim()}` : ''].filter(Boolean).join('\n\n');
    let dailyLogs = 0;
    try {
      dailyLogs = fs.readdirSync(path.join(ws, 'memory')).filter((f) => /\.md$/i.test(f)).length;
    } catch {
      /* none */
    }
    const skills = [...skillsIn(path.join(ws, 'skills'), 'workspace'), ...skillsIn(path.join(ws, '.agents', 'skills'), 'workspace')];
    const rawName = String(e.identity?.name || e.name || identity.name || '').trim();
    agents.push({
      id,
      name: (rawName || (id === 'main' ? 'OpenClaw' : id.charAt(0).toUpperCase() + id.slice(1))).slice(0, 80),
      emoji: String(e.identity?.emoji || identity.emoji || ''),
      model: modelOf(e.model) || modelOf(defaults.model),
      isDefault,
      workspace: ws,
      workspaceExists: exists,
      instructions: instructions.slice(0, 60_000),
      instructionFiles: files,
      userFacts: readText(path.join(ws, 'USER.md')),
      memory: readText(path.join(ws, 'MEMORY.md')),
      dailyLogs,
      skills,
    });
  }

  // Scheduled jobs: the JSON file, and (newer installs) the state database.
  const jobs: OcJob[] = [];
  const rawJobs: any[] = [];
  const jobsFile = path.join(p.stateDir, 'cron', 'jobs.json');
  if (fs.existsSync(jobsFile)) {
    try {
      const j = parseJson5(fs.readFileSync(jobsFile, 'utf8'));
      rawJobs.push(...(Array.isArray(j?.jobs) ? j.jobs : Array.isArray(j) ? j : []));
    } catch {
      warnings.push('De geplande taken van OpenClaw (cron/jobs.json) konden niet worden gelezen.');
    }
  }
  const fromDb = rawJobs.length ? [] : jobsFromDatabase(p.stateDir, tmp);
  rawJobs.push(...fromDb);
  const seenIds = new Set<string>();
  for (const j of rawJobs) {
    if (!j || typeof j !== 'object') continue;
    const jid = String(j.id || j.name || '').slice(0, 100);
    if (!jid || seenIds.has(jid)) continue;
    seenIds.add(jid);
    const agentId = String(j.agentId || j.owner?.agentId || defaultId);
    jobs.push({
      id: jid,
      name: String(j.displayName || j.name || jid).slice(0, 120),
      agentId,
      enabled: j.enabled !== false,
      schedule: j.schedule || null,
      payload: j.payload || (j.message ? { kind: 'agentTurn', message: j.message } : null),
      timezone: String(j.schedule?.tz || j.schedule?.timezone || j.tz || ''),
    });
  }

  // Seen, not brought over: channel names only (never their accounts or tokens), the number of conversations.
  const channels = cfg?.channels && typeof cfg.channels === 'object' ? Object.keys(cfg.channels).filter((k) => /^[\w-]{1,40}$/.test(k)) : [];
  let sessions = 0;
  try {
    for (const a of fs.readdirSync(path.join(p.stateDir, 'agents'))) {
      try {
        sessions += fs.readdirSync(path.join(p.stateDir, 'agents', a, 'sessions')).filter((f) => f.endsWith('.jsonl')).length;
      } catch {
        /* none */
      }
    }
  } catch {
    /* none */
  }
  return {
    paths: p,
    agents,
    sharedSkills: skillsIn(path.join(p.stateDir, 'skills'), 'shared'),
    jobs,
    seen: {
      channels,
      sessions,
      dailyLogs: agents.reduce((n, a) => n + a.dailyLogs, 0),
      jobsInDatabase: fromDb.length > 0,
    },
    warnings,
  };
}

/** OpenClaw's schedule → a TeamBot routine schedule (or why not). */
export function mapOcSchedule(s: any): { schedule: any; label: string } | { error: string } {
  if (!s || typeof s !== 'object') return { error: 'Geen schema gevonden.' };
  const kind = String(s.kind || s.type || '');
  if (kind === 'cron') {
    const expr = String(s.expr ?? s.expression ?? s.cron ?? '').trim();
    if (!expr) return { error: 'Leeg cron-schema.' };
    const parts = expr.split(/\s+/);
    // A 6-field expression with seconds: the seconds are dropped (TeamBot plans per minute).
    const five = parts.length === 6 ? parts.slice(1).join(' ') : expr;
    if (five.split(/\s+/).length !== 5) return { error: `Onleesbaar cron-schema: ${expr}` };
    return { schedule: { kind: 'cron', expr: five }, label: `cron ${five}` };
  }
  if (kind === 'every') {
    const ms = Number(s.everyMs ?? s.intervalMs ?? s.ms);
    const minutes = Number.isFinite(ms) && ms > 0 ? ms / 60_000 : NaN;
    if (!Number.isFinite(minutes) || minutes < 1) return { error: 'Onleesbaar interval (minder dan een minuut of leeg).' };
    const anchor = Number(s.anchorMs);
    return {
      schedule: {
        kind: 'interval',
        everyMinutes: Math.round(minutes),
        ...(Number.isFinite(anchor) && anchor > 0 ? { anchor: new Date(anchor).toISOString() } : {}),
      },
      label: minutes % 60 === 0 ? `elke ${minutes / 60} uur` : `elke ${Math.round(minutes)} minuten`,
    };
  }
  if (kind === 'at') {
    const raw = s.at ?? s.atMs ?? s.when;
    const ms = typeof raw === 'number' ? raw : Date.parse(String(raw || ''));
    if (!Number.isFinite(ms)) return { error: 'Onleesbare datum.' };
    const at = new Date(ms).toISOString().slice(0, 16);
    return {
      schedule: { kind: 'once', at },
      label: `eenmalig op ${at.replace('T', ' ')}`,
    };
  }
  return {
    error: `Dit soort schema (${kind || 'onbekend'}) kent TeamBot niet als routine.`,
  };
}

/** OpenClaw's payload → the routine's prompt (or why not: commands and scripts are never taken over). */
export function ocPrompt(payload: any): { prompt: string } | { error: string } {
  const kind = String(payload?.kind || '');
  if (kind === 'agentTurn' || (!kind && typeof payload?.message === 'string')) {
    const m = String(payload.message || '').trim();
    return m ? { prompt: m.slice(0, 20_000) } : { error: 'Lege opdracht.' };
  }
  if (kind === 'systemEvent') {
    const m = String(payload.text ?? payload.message ?? '').trim();
    return m ? { prompt: m.slice(0, 20_000) } : { error: 'Lege opdracht.' };
  }
  if (kind === 'command' || kind === 'script')
    return {
      error: 'Voert een opdracht of script uit op de computer; dat neemt TeamBot niet over. Maak er zelf een routine van als je dat wilt.',
    };
  return { error: 'Onbekende soort taak.' };
}
