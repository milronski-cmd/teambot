import { isDir, isFile } from '../../core/util.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';

/**
 * Read-only reader for a local Hermes Agent data folder (Nous Research, MIT; our own reader of its documented file
 * layout, no Hermes code). Nothing in the folder is opened for writing, and secrets are never read: `.env` and
 * `auth.json` are skipped, and of `config.yaml` only the model, provider and timezone are taken.
 *
 * The layout (checked against the Hermes source, see docs/modules/openbot-import.md):
 *   <HERMES_HOME>/                default ~/.hermes; the "default" profile
 *     config.yaml                 model: { default, provider, base_url } (or model: "<id>"), timezone
 *     SOUL.md                     the agent's persona (slot 1 of its system prompt)
 *     memories/MEMORY.md          the agent's notes, entries separated by "\n§\n"
 *     memories/USER.md            what it knows about the user, same format
 *     skills/<category>/<name>/SKILL.md   skills; skills/.bundled_manifest lists the ones copied from Hermes itself
 *     cron/jobs.json              { jobs: [...] } (or a bare list): id, name, prompt, schedule { kind: interval|cron|once }, enabled
 *     profiles/<name>/            extra agents, each with the same layout as above
 */

export const ENTRY_DELIMITER = '\n§\n';
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_JOBS = 500;
const MAX_SKILLS = 1000;

export function defaultHermesHome(): string {
  const v = process.env.TEAMBOT_HERMES_HOME || process.env.HERMES_HOME || '';
  return path.resolve(v || path.join(os.homedir(), '.hermes'));
}

export interface HermesJob {
  /** `<profile>:<job id>` (unique across profiles). */
  key: string;
  profile: string;
  name: string;
  prompt: string;
  schedule: any;
  active: boolean;
  skills: string[];
  deliver: string;
  model: string;
  script: boolean;
}

export interface HermesProfile {
  /** "default" for the root folder, otherwise the profile's folder name. */
  id: string;
  dir: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  timezone: string;
  soul: string;
  memories: string[];
  userFacts: string[];
  /** Skill names in this profile's skills folder. */
  skills: string[];
  jobs: HermesJob[];
  mcpServers: string[];
  hasEnv: boolean;
}

export interface HermesSkill {
  name: string;
  description: string;
  category: string;
  dir: string;
  /** Copied from Hermes itself (listed in skills/.bundled_manifest), not written by the owner. */
  bundled: boolean;
  profiles: string[];
  variants: number;
}

export interface HermesSnapshot {
  home: string;
  readAt: string;
  profiles: HermesProfile[];
  skills: HermesSkill[];
  warnings: string[];
}


/** Read a small text file (never written); BOM stripped and line endings made "\n". */
function readText(p: string, max = 200_000): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 5_000_000) return null;
    const s = fs.readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return null;
  }
}

const str = (v: any, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Is this a Hermes folder (root or profile)? */
function looksLikeHermes(dir: string) {
  return isFile(path.join(dir, 'config.yaml')) || isFile(path.join(dir, 'SOUL.md')) || isDir(path.join(dir, 'memories')) || isFile(path.join(dir, 'cron', 'jobs.json'));
}

export function detectHermes(home: string = defaultHermesHome()) {
  const found = isDir(home) && looksLikeHermes(home);
  return { found, home, profiles: found ? profileDirs(home).length : 0 };
}

function profileDirs(home: string): { id: string; dir: string }[] {
  const out = [{ id: 'default', dir: home }];
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (!e.isDirectory() || !PROFILE_ID.test(e.name) || e.name === 'default') continue;
      const dir = path.join(home, 'profiles', e.name);
      if (looksLikeHermes(dir)) out.push({ id: e.name, dir });
    }
  } catch {
    /* no profiles */
  }
  return out;
}

/** Memory entries as Hermes stores them: split on the delimiter, trimmed, empty ones dropped. */
export function parseEntries(text: string | null): string[] {
  if (!text) return [];
  return text
    .replace(/\r\n/g, '\n')
    .split(ENTRY_DELIMITER)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .slice(0, 500);
}

/** Only the non-secret settings of config.yaml (keys elsewhere in the file are never kept). */
function readConfig(dir: string, warnings: string[], label: string) {
  const t = readText(path.join(dir, 'config.yaml'), 1_000_000);
  if (t === null) return { provider: '', model: '', baseUrl: '', timezone: '', mcpServers: [] as string[] };
  let cfg: any = null;
  try {
    cfg = YAML.parse(t);
  } catch {
    warnings.push(`${label}: config.yaml is niet leesbaar; het model kies je zelf.`);
  }
  const m = cfg?.model;
  const model = typeof m === 'string' ? m : str(m?.default) || str(m?.model);
  const provider = typeof m === 'object' && m ? str(m.provider, 80) : str(cfg?.provider, 80);
  let baseUrl = typeof m === 'object' && m ? str(m.base_url, 300) : '';
  // A URL with a user name or password in it is not kept (and not shown).
  try {
    if (baseUrl && new URL(baseUrl).username) baseUrl = '';
  } catch {
    baseUrl = '';
  }
  const mcp = cfg?.mcp_servers && typeof cfg.mcp_servers === 'object' && !Array.isArray(cfg.mcp_servers) ? Object.keys(cfg.mcp_servers).slice(0, 50).map((k) => k.slice(0, 80)) : [];
  return { provider, model: model.slice(0, 200), baseUrl, timezone: str(cfg?.timezone, 80), mcpServers: mcp };
}

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  try {
    const v = YAML.parse(m[1]);
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string').map(([k, x]) => [k.toLowerCase(), String(x)]));
  } catch {
    return {};
  }
}

/** Skill folders (a SKILL.md each) under skills/, any depth up to 4; .archive and other dot folders are skipped. */
function skillDirs(root: string): { dir: string; category: string }[] {
  const out: { dir: string; category: string }[] = [];
  const walk = (dir: string, depth: number, category: string) => {
    if (depth > 4 || out.length >= MAX_SKILLS) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const d = path.join(dir, e.name);
      if (isFile(path.join(d, 'SKILL.md'))) out.push({ dir: d, category });
      else walk(d, depth + 1, depth === 0 ? e.name : category);
    }
  };
  walk(root, 0, '');
  return out;
}

function bundledNames(skillsRoot: string): Set<string> {
  const t = readText(path.join(skillsRoot, '.bundled_manifest'), 200_000);
  const out = new Set<string>();
  for (const line of (t || '').split('\n')) {
    const name = line.split(':')[0].trim();
    if (name) out.add(name);
  }
  return out;
}

function dirHash(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string, rel: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + '/', depth + 1);
      else if (e.isFile()) {
        h.update(rel + e.name);
        try {
          if (fs.statSync(p).size < 2_000_000) h.update(fs.readFileSync(p));
        } catch {
          /* unreadable */
        }
      }
    }
  };
  walk(dir, '', 0);
  return h.digest('hex');
}

function readJobs(dir: string, profile: string, warnings: string[], label: string): HermesJob[] {
  const file = path.join(dir, 'cron', 'jobs.json');
  const t = readText(file, 5_000_000);
  if (t === null) return [];
  let data: any;
  try {
    data = JSON.parse(t);
  } catch {
    warnings.push(`${label}: cron/jobs.json is niet leesbaar; de geplande taken komen niet mee.`);
    return [];
  }
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
  const out: HermesJob[] = [];
  for (const j of list.slice(0, MAX_JOBS)) {
    if (!j || typeof j !== 'object') continue;
    const id = str(j.id, 80) || crypto.createHash('sha1').update(JSON.stringify(j)).digest('hex').slice(0, 12);
    const prompt = str(j.prompt, 20_000).trim();
    const skills = [...(Array.isArray(j.skills) ? j.skills : []), ...(typeof j.skill === 'string' ? [j.skill] : [])].filter((x) => typeof x === 'string').map((x) => x.slice(0, 80));
    const state = str(j.state, 30).toLowerCase();
    const active = j.enabled !== false && !j.paused_at && !['paused', 'disabled', 'completed', 'done'].includes(state);
    const name = (str(j.name, 120).trim() || prompt.split('\n')[0].slice(0, 50) || skills[0] || 'Geplande taak').trim();
    out.push({ key: `${profile}:${id}`, profile, name, prompt, schedule: j.schedule ?? j.schedule_display ?? null, active, skills, deliver: str(typeof j.deliver === 'object' ? j.deliver?.platform || j.deliver?.target : j.deliver, 80), model: str(j.model, 120), script: !prompt && (typeof j.script === 'string' || j.no_agent === true) });
  }
  return out;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One read of the Hermes folder (and its profiles). Throws when the folder is not a Hermes folder. */
export function readHermes(home: string): HermesSnapshot {
  const root = path.resolve(home);
  if (!isDir(root) || !looksLikeHermes(root)) throw new Error(`Geen Hermes-map gevonden in ${root}.`);
  const warnings: string[] = [];
  const skills = new Map<string, HermesSkill & { hashes: Set<string>; mtime: number }>();
  const profiles: HermesProfile[] = [];
  for (const p of profileDirs(root)) {
    const name = p.id === 'default' ? 'Hermes' : titleCase(p.id);
    const cfg = readConfig(p.dir, warnings, name);
    const skillsRoot = path.join(p.dir, 'skills');
    const bundled = bundledNames(skillsRoot);
    const names: string[] = [];
    for (const s of skillDirs(skillsRoot)) {
      const md = readText(path.join(s.dir, 'SKILL.md'), 40_000) || '';
      const fm = frontmatter(md);
      const skillName = (fm.name || path.basename(s.dir)).trim().slice(0, 80);
      if (!skillName) continue;
      names.push(skillName);
      const hash = dirHash(s.dir);
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(s.dir, 'SKILL.md')).mtimeMs;
      } catch {
        /* ignore */
      }
      const cur = skills.get(skillName);
      const isBundled = bundled.has(path.basename(s.dir)) || bundled.has(skillName);
      if (!cur) skills.set(skillName, { name: skillName, description: (fm.description || '').slice(0, 300), category: s.category, dir: s.dir, bundled: isBundled, profiles: [p.id], variants: 1, hashes: new Set([hash]), mtime });
      else {
        if (!cur.profiles.includes(p.id)) cur.profiles.push(p.id);
        cur.hashes.add(hash);
        cur.variants = cur.hashes.size;
        cur.bundled = cur.bundled && isBundled;
        // The newest copy is imported.
        if (mtime > cur.mtime) Object.assign(cur, { dir: s.dir, mtime, description: (fm.description || cur.description).slice(0, 300) });
      }
    }
    profiles.push({
      id: p.id,
      dir: p.dir,
      name,
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      timezone: cfg.timezone,
      soul: (readText(path.join(p.dir, 'SOUL.md'), 60_000) || '').trim(),
      memories: parseEntries(readText(path.join(p.dir, 'memories', 'MEMORY.md'))),
      userFacts: parseEntries(readText(path.join(p.dir, 'memories', 'USER.md'))),
      skills: [...new Set(names)],
      jobs: readJobs(p.dir, p.id, warnings, name),
      mcpServers: cfg.mcpServers,
      hasEnv: isFile(path.join(p.dir, '.env')),
    });
  }
  return {
    home: root,
    readAt: new Date().toISOString(),
    profiles,
    skills: [...skills.values()].map(({ hashes: _h, mtime: _m, ...s }) => s).sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

// ---------------- mapping ----------------

/** Hermes provider id → TeamBot provider kind. Hermes' "gemini" is Google AI Studio (an API), not the Gemini CLI. */
const ENGINES: Record<string, { kind: string | null; label: string }> = {
  openrouter: { kind: 'openrouter', label: 'OpenRouter' },
  anthropic: { kind: 'anthropic', label: 'Anthropic' },
  openai: { kind: 'openai', label: 'OpenAI' },
  'openai-codex': { kind: 'codex-cli', label: 'Codex' },
  codex: { kind: 'codex-cli', label: 'Codex' },
  gemini: { kind: 'google', label: 'Google Gemini' },
  google: { kind: 'google', label: 'Google Gemini' },
  'x-ai': { kind: 'xai', label: 'xAI' },
  xai: { kind: 'xai', label: 'xAI' },
  deepseek: { kind: 'deepseek', label: 'DeepSeek' },
  groq: { kind: 'groq', label: 'Groq' },
  mistral: { kind: 'mistral', label: 'Mistral' },
  ollama: { kind: 'ollama', label: 'Ollama' },
  lmstudio: { kind: 'lmstudio', label: 'LM Studio' },
  'lm-studio': { kind: 'lmstudio', label: 'LM Studio' },
  nous: { kind: null, label: 'Nous Portal' },
};

export interface HermesEngineRef {
  from: string;
  kind: string | null;
  label: string;
  baseUrl?: string;
}

export function mapHermesEngine(provider: string, baseUrl = ''): HermesEngineRef {
  const id = String(provider || '').trim().toLowerCase();
  const known = ENGINES[id];
  if (known) return { from: id, ...known };
  if (id === 'custom' || (!id && baseUrl)) {
    if (/:1234\b/.test(baseUrl) && /127\.0\.0\.1|localhost/i.test(baseUrl)) return { from: id || 'custom', kind: 'lmstudio', label: 'LM Studio', baseUrl };
    if (/:11434\b/.test(baseUrl)) return { from: id || 'custom', kind: 'ollama', label: 'Ollama', baseUrl };
    if (baseUrl) return { from: id || 'custom', kind: 'openai-compatible', label: 'Eigen provider', baseUrl };
  }
  return { from: id || 'auto', kind: null, label: id && id !== 'auto' ? id : 'automatisch' };
}

const pad = (n: number) => String(n).padStart(2, '0');
const EVERY = { hour: 'elk uur', minute: 'elke minuut' };
const everyLabel = (minutes: number) => (minutes === 60 ? EVERY.hour : minutes % 60 === 0 ? `elke ${minutes / 60} uur` : minutes === 1 ? EVERY.minute : `elke ${minutes} minuten`);

/** "2026-11-20T09:00" in the given timezone for an instant (Hermes stores one-shot times as ISO). */
function localIso(ms: number, tz: string): string {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

const UNIT: Record<string, number> = { m: 1, h: 60, d: 1440 };

/**
 * A Hermes schedule → a TeamBot routine schedule. Hermes keeps { kind: 'interval', minutes } / { kind: 'cron', expr } /
 * { kind: 'once', run_at }; an older or hand-written job may hold the text form ("every 30m", "0 9 * * *", an ISO time).
 */
export function mapHermesSchedule(s: any, tz = ''): { schedule: any; label: string } | { error: string } {
  if (typeof s === 'string') {
    const v = s.trim();
    const iv = v.match(/^(?:every\s+)?(\d+)\s*([mhd])$/i);
    if (iv) return mapHermesSchedule({ kind: 'interval', minutes: Number(iv[1]) * UNIT[iv[2].toLowerCase()] }, tz);
    if (/^(\S+\s+){4}\S+(\s+\S+)?$/.test(v) && !/[a-z]{4,}/i.test(v)) return mapHermesSchedule({ kind: 'cron', expr: v }, tz);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return mapHermesSchedule({ kind: 'once', run_at: v }, tz);
    return { error: `Dit schema kent TeamBot niet: “${v.slice(0, 60)}”. Maak de routine zelf opnieuw.` };
  }
  if (!s || typeof s !== 'object') return { error: 'Geen schema gevonden.' };
  const kind = String(s.kind || '').toLowerCase();
  if (kind === 'interval') {
    const minutes = Math.round(Number(s.minutes ?? s.every_minutes));
    if (!Number.isFinite(minutes) || minutes < 1) return { error: 'Onleesbaar interval.' };
    return { schedule: { kind: 'interval', everyMinutes: minutes }, label: everyLabel(minutes) };
  }
  if (kind === 'cron') {
    const expr = String(s.expr ?? s.expression ?? '').trim();
    if (!expr) return { error: 'Leeg cron-schema.' };
    return { schedule: { kind: 'cron', expr }, label: `cron ${expr}` };
  }
  if (kind === 'once') {
    const raw = String(s.run_at ?? s.at ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return { error: 'Onleesbare datum.' };
    // With an offset or "Z": that moment in the routine's timezone. Without: Hermes' own local time, kept as written.
    const at = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw) && Number.isFinite(Date.parse(raw)) ? localIso(Date.parse(raw), tz) : raw.slice(0, 16);
    return { schedule: { kind: 'once', at }, label: `eenmalig op ${at.replace('T', ' ')}` };
  }
  if (typeof s.display === 'string' && s.display) return mapHermesSchedule(s.display, tz);
  return { error: `Onbekend schematype "${kind}".` };
}
