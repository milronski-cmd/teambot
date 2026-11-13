import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../../core/types.js';
import { MCP_SERVER_NAME } from './bridge.js';
import { appLabel } from './permissions.js';
import { runQuick } from './proc.js';

/**
 * The engine's own apps: the MCP servers and connectors a CLI engine loads from its own settings or account, next to
 * TeamBot's own tools. On Claude Code these are the owner's claude.ai connectors (Gmail, Agenda, Docs …) and the MCP
 * servers in his Claude Code settings; on Codex the `[mcp_servers.*]` of its config.toml; on OpenCode the `mcp` of its
 * opencode.json. A bot that brings the engine's own apps (cli.useUserMcp, on by default with "Volledige toegang") has
 * them as its apps: TeamBot shows them with the bot's apps, and the owner switches one off per bot
 * (`settings.cli.appsOff`, a list of app ids; nothing in it = every app on).
 *
 * Claude Code says which servers and tools it loaded in the first line of every run (its init message): that is
 * recorded here per AI connection (provider config), so the bot page shows them, with the tools Claude Code listed.
 * Codex and OpenCode name their servers in their own config files, read when asked.
 */

export interface EngineApp {
  /** The app in the engine's tool names: `mcp__<id>__<tool>` (Claude Code), the server key (Codex, OpenCode). */
  id: string;
  /** The engine's own name for it ("claude.ai Gmail"). */
  name: string;
  /** Where the engine has it from: "claudeai" (claude.ai connectors), "user", "project", "local", "config" … */
  source: string;
  /** As the engine last reported it: "connected", "needs-auth", "failed", "pending", "" (only configured). */
  status: string;
  /** Tool names without the prefix, as last listed by the engine (empty until a run listed them). */
  tools: string[];
  /** Last seen. */
  at: string;
}

/** How Claude Code turns a server name into the middle of its tool names ("claude.ai Gmail" → "claude_ai_Gmail"). */
export const appId = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_');

/** An app not seen in any run for this long is no longer listed (the owner removed it from the engine). */
const FORGET_MS = 30 * 24 * 3600_000;

const fileOf = (dataDir: string) => path.join(dataDir, 'cli-agents', 'engine-apps.json');

function readAll(dataDir: string): Record<string, EngineApp[]> {
  try {
    const v = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The apps the engine behind AI connection `cfgId` last reported (Claude Code). */
export function knownApps(dataDir: string, cfgId: string): EngineApp[] {
  const list = readAll(dataDir)[cfgId];
  return Array.isArray(list) ? list.filter((a) => a && typeof a.id === 'string' && Date.now() - Date.parse(a.at) < FORGET_MS) : [];
}

/**
 * Record what Claude Code's init message says it loaded besides TeamBot's own server. `off`: apps switched off for this
 * run's bot; Claude Code lists no tools of those (a deny rule keeps them out), so their tools from an earlier run stay.
 * An app missing from this init is kept (Claude Code may still be connecting it); it goes after FORGET_MS unseen.
 */
export function recordClaudeInit(dataDir: string, cfgId: string, init: any, off: string[] = []): EngineApp[] | null {
  const servers: any[] = Array.isArray(init?.mcp_servers) ? init.mcp_servers : [];
  const tools: string[] = Array.isArray(init?.tools) ? init.tools.filter((t: unknown) => typeof t === 'string') : [];
  const mine = servers.filter((s) => typeof s?.name === 'string' && s.name && s.name !== MCP_SERVER_NAME);
  if (!mine.length) return null;
  return save(dataDir, cfgId, mine.map((s) => {
    const id = appId(s.name);
    const own = tools.filter((t) => t.startsWith(`mcp__${id}__`)).map((t) => t.slice(`mcp__${id}__`.length));
    return { name: String(s.name), source: String(s.source || ''), status: String(s.status || ''), tools: own.length || !off.includes(id) ? own : undefined };
  }));
}

/**
 * Before the very first run on a Claude Code connection nothing is known yet: `claude mcp list` (no model call; it
 * connects every server once, some seconds) names the servers, so that first run already sends every call of them
 * through the gate and the bot page shows them. Their tools follow from the first run.
 */
export async function discoverClaudeApps(dataDir: string, cfgId: string, bin: string, cwd?: string): Promise<EngineApp[]> {
  // An owner without any apps of his own: asked once an hour at most, not before every run.
  const last = discovered.get(cfgId) || 0;
  if (Date.now() - last < 3600_000) return knownApps(dataDir, cfgId);
  discovered.set(cfgId, Date.now());
  const r = await runQuick(bin, ['mcp', 'list'], { timeoutMs: 45_000, cwd });
  const found = parseMcpList(r.stdout);
  return found.length ? save(dataDir, cfgId, found) || [] : knownApps(dataDir, cfgId);
}

const discovered = new Map<string, number>();

/** "claude.ai Gmail: https://… - ✔ Connected" → { name, source, status } per line of `claude mcp list`. */
export function parseMcpList(out: string): { name: string; source: string; status: string }[] {
  const res: { name: string; source: string; status: string }[] = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^(.+?): .* - (.+)$/.exec(line.trim());
    if (!m || m[1] === MCP_SERVER_NAME || m[1].length > 120) continue;
    const st = m[2].toLowerCase();
    const status = /connected/.test(st) && !/fail|not/.test(st) ? 'connected' : /auth/.test(st) ? 'needs-auth' : /fail|error/.test(st) ? 'failed' : /pending|connecting/.test(st) ? 'pending' : '';
    res.push({ name: m[1], source: /^claude\.ai /.test(m[1]) ? 'claudeai' : '', status });
  }
  return res;
}

/** Merge what the engine reported into what is known (tools: undefined = keep the known ones). */
function save(dataDir: string, cfgId: string, found: { name: string; source: string; status: string; tools?: string[] }[]): EngineApp[] | null {
  const at = new Date().toISOString();
  const by = new Map(knownApps(dataDir, cfgId).map((a) => [a.id, a]));
  for (const f of found) {
    const id = appId(f.name);
    const old = by.get(id);
    by.set(id, { id, name: f.name.slice(0, 120), source: f.source || old?.source || '', status: f.status, tools: (f.tools ?? old?.tools ?? []).slice(0, 300), at });
  }
  const list = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  try {
    const all = readAll(dataDir);
    all[cfgId] = list;
    fs.mkdirSync(path.dirname(fileOf(dataDir)), { recursive: true });
    const tmp = fileOf(dataDir) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, fileOf(dataDir));
  } catch {
    /* only what the bot page shows */
  }
  return list;
}

/** The apps the owner switched off for this bot (`settings.cli.appsOff`). */
export function appsOff(agent: { settings?: Agent["settings"] | null }): string[] {
  const v = (agent.settings?.cli as any)?.appsOff;
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(x)).slice(0, 100) : [];
}

/** Codex's own MCP servers: the `[mcp_servers.<id>]` tables of its config.toml (CODEX_HOME). */
export function codexConfigApps(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): EngineApp[] {
  try {
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const ids = [...new Set([...toml.matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_-]{1,64})\]\s*$/gm)].map((m) => m[1]))];
    return ids.filter((id) => id !== MCP_SERVER_NAME).map((id) => ({ id, name: id, source: 'config', status: '', tools: [], at: '' }));
  } catch {
    return [];
  }
}

/** OpenCode's own MCP servers: the `mcp` of its opencode.json (XDG_CONFIG_HOME, else ~/.config). */
export function opencodeConfigApps(dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode')): EngineApp[] {
  for (const f of ['opencode.json', 'opencode.jsonc']) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      const mcp = JSON.parse(raw)?.mcp;
      if (!mcp || typeof mcp !== 'object') return [];
      return Object.keys(mcp)
        .filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id) && id !== MCP_SERVER_NAME && mcp[id]?.enabled !== false)
        .map((id) => ({ id, name: id, source: 'config', status: '', tools: [], at: '' }));
    } catch {
      /* next file */
    }
  }
  return [];
}

/** One app as the bot page shows it. */
export interface EngineAppView {
  id: string;
  /** The name the owner knows ("Gmail"). */
  name: string;
  /** The program it comes from ("Claude Code"). */
  engine: string;
  /** In words: "verbonden", "inloggen nodig in Claude Code" … */
  state: string;
  tools: number;
  /** On for this bot. */
  on: boolean;
  /** Does TeamBot's gate see every call ("Bewaakt door TeamBot: …"), or not ("Niet bewaakt door TeamBot: …"). */
  guarded: boolean;
  note: string;
}

const STATE: Record<string, string> = { connected: 'verbonden', pending: 'verbinden…', failed: 'fout bij verbinden', disabled: 'uit in {0}' };

/**
 * The bot page's lines for the engine's own apps. `guarded`: every call of such an app reaches TeamBot's gate on this
 * engine (Claude Code: a permission prompt for every app tool, see claude.ts), so sending asks the owner there.
 */
export function appViews(apps: EngineApp[], o: { engine: string; off: string[]; guarded: boolean }): EngineAppView[] {
  const note = o.guarded
    ? 'Bewaakt door TeamBot: lezen, zoeken en concepten gaan vanzelf; iets versturen naar anderen, verwijderen of betalen vraagt eerst jou.'
    : `Niet bewaakt door TeamBot: ${o.engine} gebruikt deze app zonder TeamBot te vragen, ook om iets te versturen; alleen de instructies van de bot verbieden het.`;
  // A claude.ai connector switched off while another one stays on: Claude Code leaves its tools out, but has no way to
  // leave out only its short instructions (2.1.322); with all of them off they are gone entirely.
  const connectorsOn = apps.some((a) => a.source === 'claudeai' && !o.off.includes(a.id));
  return apps.map((a) => ({
    id: a.id,
    name: a.source === 'claudeai' ? appLabel(a.id) : a.name,
    engine: o.engine,
    state: a.status === 'needs-auth' ? `inloggen nodig in ${o.engine}` : (STATE[a.status] || (a.status ? a.status : 'ingesteld in {0}')).replace('{0}', o.engine),
    tools: a.tools.length,
    on: !o.off.includes(a.id),
    guarded: o.guarded,
    note: o.off.includes(a.id) && a.source === 'claudeai' && connectorsOn ? `Uit voor deze bot: ${o.engine} laat zijn tools weg; zijn korte uitleg laadt ${o.engine} nog zolang een andere Claude-koppeling aan staat.` : note,
  }));
}
