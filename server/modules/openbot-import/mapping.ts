import type { AccessMode } from '../../core/types.js';
import type { ObAgent, ObRoutine } from './reader.js';

/** OpenBot provider id → TeamBot provider kind. */
const ENGINES: Record<string, { kind: string; label: string }> = {
  claude: { kind: 'claude-code', label: 'Claude Code' },
  'claude-code': { kind: 'claude-code', label: 'Claude Code' },
  codex: { kind: 'codex-cli', label: 'Codex' },
  'codex-cli': { kind: 'codex-cli', label: 'Codex' },
  opencode: { kind: 'opencode', label: 'OpenCode' },
  gemini: { kind: 'gemini-cli', label: 'Gemini CLI' },
  antigravity: { kind: 'antigravity', label: 'Antigravity' },
  devin: { kind: 'devin-cli', label: 'Devin CLI' },
  qwen: { kind: 'qwen-code', label: 'Qwen Code' },
  copilot: { kind: 'copilot-cli', label: 'GitHub Copilot CLI' },
  cursor: { kind: 'cursor-cli', label: 'Cursor CLI' },
  kimi: { kind: 'kimi-code', label: 'Kimi Code' },
  hermes: { kind: 'hermes-agent', label: 'Hermes' },
  grok: { kind: 'grok-build', label: 'Grok' },
  cline: { kind: 'cline-cli', label: 'Cline' },
  pi: { kind: 'pi-agent', label: 'Pi' },
  deepseek: { kind: 'deepseek', label: 'DeepSeek' },
  openai: { kind: 'openai', label: 'OpenAI' },
  anthropic: { kind: 'anthropic', label: 'Anthropic' },
  openrouter: { kind: 'openrouter', label: 'OpenRouter' },
  google: { kind: 'google', label: 'Google Gemini' },
  xai: { kind: 'xai', label: 'xAI' },
  groq: { kind: 'groq', label: 'Groq' },
  mistral: { kind: 'mistral', label: 'Mistral' },
  ollama: { kind: 'ollama', label: 'Ollama' },
  lmstudio: { kind: 'lmstudio', label: 'LM Studio' },
  'lm-studio': { kind: 'lmstudio', label: 'LM Studio' },
};

export interface EngineRef {
  /** OpenBot provider id as stored by OpenBot. */
  from: string;
  /** TeamBot provider kind, or null when there is no equivalent. */
  kind: string | null;
  label: string;
  /** Base URL for custom (OpenAI-compatible) providers. */
  baseUrl?: string;
}

/** Map an OpenBot provider id (incl. custom providers from openbot-custom-providers-v1.json). */
export function mapEngine(provider: string, custom: { id: string; name: string; baseUrl: string }[] = []): EngineRef {
  const id = String(provider || '').trim();
  const known = ENGINES[id.toLowerCase()];
  if (known) return { from: id, ...known };
  const c = custom.find((x) => x.id === id || x.name === id);
  if (c) {
    const url = c.baseUrl || '';
    if (/:1234\b/.test(url) && /127\.0\.0\.1|localhost/i.test(url)) return { from: id, kind: 'lmstudio', label: c.name || 'LM Studio', baseUrl: url };
    if (/:11434\b/.test(url)) return { from: id, kind: 'ollama', label: c.name || 'Ollama', baseUrl: url };
    return { from: id, kind: 'openai-compatible', label: c.name || 'Eigen provider', baseUrl: url };
  }
  return { from: id, kind: null, label: id || 'onbekend' };
}

export function mapReasoning(v: string): string {
  const r = String(v || '').toLowerCase();
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(r)) return r;
  if (r === 'minimal' || r === 'none') return 'low';
  return '';
}

/**
 * OpenBot access → TeamBot access mode. OpenBot's "full access" maps to TeamBot's "Volledige toegang": normal work
 * runs without asking; sending to others and payments still ask unless the owner switches that on per bot.
 */
export function mapAccess(v: string): { mode: AccessMode; note: string } {
  const a = String(v || '').toLowerCase();
  if (a === 'full') return { mode: 'full', note: 'Volledige toegang → Volledige toegang: gewoon werk gaat zonder vragen; versturen naar anderen en betalen vragen nog wel toestemming (per bot aan te passen).' };
  if (a === 'workspace' || a === 'workspace-only' || a === 'workspace_only') return { mode: 'auto', note: 'Alleen werkmap → Automatisch, zonder terminal: bestanden blijven binnen de werkmap.' };
  if (a === 'readonly' || a === 'read-only') return { mode: 'readonly', note: '' };
  return { mode: 'ask', note: '' };
}

export function toolGroupsFor(a: Pick<ObAgent, 'access' | 'computerUse'>): string[] {
  const g = ['files', 'web', 'memory', 'team', 'skills', 'routines'];
  const access = String(a.access || '').toLowerCase();
  if (access === 'full') g.push('shell', 'browser');
  else if (access !== 'workspace' && access !== 'workspace-only') g.push('browser');
  if (a.computerUse) g.push('desktop');
  return g;
}

/** Deterministic colour from OpenBot's avatar hue (or the avatar seed). */
export function colorFor(seed: string, hue: number | null): string {
  let h = hue;
  if (h === null || !Number.isFinite(h)) {
    let x = 0;
    for (const ch of String(seed || 'bot')) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
    h = x % 360;
  }
  return hslToHex(((h % 360) + 360) % 360, 0.62, 0.52);
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

const TIME = /^(\d{1,2}):(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');
function time(v: any): string | null {
  const m = String(v ?? '').trim().match(TIME);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${pad(Number(m[1]))}:${pad(Number(m[2]))}`;
}

const UNIT_MIN: Record<string, number> = { minute: 1, minutes: 1, min: 1, hour: 60, hours: 60, h: 60, day: 1440, days: 1440, d: 1440, week: 10080, weeks: 10080 };

/** OpenBot schedule JSON → TeamBot schedule input (validated again by the routine engine). */
/** One hour or one minute in words, not "elke 1 uur" / "elke 1 minuten" (as values here, the extractor finds them). */
const EVERY = { hour: 'elk uur', minute: 'elke minuut' };

export function mapSchedule(s: any): { schedule: any; label: string } | { error: string } {
  if (!s || typeof s !== 'object') return { error: 'Geen schema gevonden.' };
  const kind = String(s.kind || '');
  switch (kind) {
    case 'daily': {
      const t = time(s.time);
      if (!t) return { error: `Onleesbare tijd: ${s.time}` };
      return { schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: [t] }, label: `elke dag om ${t}` };
    }
    case 'weekly': {
      const t = time(s.time);
      const days = (Array.isArray(s.weekdays) ? s.weekdays : Array.isArray(s.days) ? s.days : [s.weekday]).map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 7).map((d: number) => d % 7);
      if (!t || !days.length) return { error: 'Onleesbaar weekschema.' };
      return { schedule: { kind: 'weekly', days, times: [t] }, label: `wekelijks (${days.map(dayName).join(', ')}) om ${t}` };
    }
    case 'monthly': {
      const t = time(s.time);
      const day = Number(s.day ?? s.dayOfMonth);
      if (!t || !Number.isInteger(day) || day < 1 || day > 31) return { error: 'Onleesbaar maandschema.' };
      const [h, mi] = t.split(':').map(Number);
      return { schedule: { kind: 'cron', expr: `${mi} ${h} ${day} * *` }, label: `maandelijks op dag ${day} om ${t}` };
    }
    case 'once': {
      const t = time(s.time) || '09:00';
      const date = String(s.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const at = String(s.at || '');
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) return { schedule: { kind: 'once', at: at.slice(0, 16) }, label: `eenmalig op ${at.slice(0, 16).replace('T', ' ')}` };
        return { error: 'Onleesbare datum.' };
      }
      return { schedule: { kind: 'once', at: `${date}T${t}` }, label: `eenmalig op ${date} ${t}` };
    }
    case 'interval': {
      const amount = Number(s.amount ?? s.every);
      const unit = UNIT_MIN[String(s.unit || 'minutes').toLowerCase()];
      const minutes = Number(s.everyMinutes) || (Number.isFinite(amount) && unit ? amount * unit : NaN);
      if (!Number.isFinite(minutes) || minutes < 1) return { error: 'Onleesbaar interval.' };
      const anchor = s.anchorAt || s.anchor;
      const ms = anchor ? Date.parse(String(anchor)) : NaN;
      return { schedule: { kind: 'interval', everyMinutes: Math.round(minutes), ...(Number.isFinite(ms) ? { anchor: new Date(ms).toISOString() } : {}) }, label: minutes === 60 ? EVERY.hour : minutes % 60 === 0 ? `elke ${minutes / 60} uur` : minutes === 1 ? EVERY.minute : `elke ${minutes} minuten` };
    }
    case 'custom':
    case 'cron': {
      const expr = String(s.expression ?? s.expr ?? s.cron ?? '').trim();
      if (!expr) return { error: 'Leeg cron-schema.' };
      return { schedule: { kind: 'cron', expr }, label: `cron ${expr}` };
    }
    default:
      return { error: `Onbekend schematype "${kind}".` };
  }
}

function dayName(d: number) {
  return ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'][d] || String(d);
}

/**
 * Per-routine notes for settings TeamBot handles differently (the limit policy is reported once, globally). Running in
 * the main chat (run_in "chat") is no longer one of them: it becomes runIn 'main' (routines: "In de hoofdchat van de bot").
 */
export function routineNotes(_r: ObRoutine): string[] {
  return [];
}

/**
 * Rewrite an imported skill text for TeamBot's team database (the imported copy only; OpenBot's file is never
 * touched). OpenBot's data tools become team_tables / team_query / team_execute, bot messages become ask_bot, and the
 * path of OpenBot's shared database becomes "the team database". Everything else (the owner's conventions) stays.
 */
export function adaptSkillText(s: string): string {
  return s
    .replace(/`?openbot\.query_data`?/g, '`team_query`')
    .replace(/`?openbot\.execute_data`?/g, '`team_execute`')
    .replace(/`?openbot\.list_tables`?/g, '`team_tables`')
    .replace(/`?openbot\.delete_table`?/g, '`team_execute` (DROP TABLE)')
    .replace(/`?openbot\.send_message`?|`send_message`/g, '`ask_bot`')
    .replace(/\s*\((?:zie )?skill `?openbot-data`?\)/g, '')
    .replace(/`?~[\\/]OpenBot[\\/]Shared[\\/]Data[\\/]agent-data\.db`?/g, 'de teamdatabase van TeamBot (Teamwerk)')
    .replace(/\bin `?agent-data\.db`?/g, 'in de teamdatabase')
    .replace(/`?agent-data\.db`?/g, 'de teamdatabase');
}
