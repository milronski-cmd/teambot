import fs from 'node:fs';
import { oneLine } from '../../core/util.js';
import path from 'node:path';
import type { Request } from 'express';
import type { Agent, Ctx, Module, User } from '../../core/types.js';
import { ah, str, user } from '../../core/http.js';
import { isRestricted } from '../../api/member-policy.js';
import { agentRootList, isProtectedPath, type AgentRoot } from '../../tools/builtin/files.js';

/**
 * "Zoek alles" for the command palette (Ctrl+K): one call that searches what lives on the server — messages (prefix
 * match while you type), channels, skills, apps/connectors, routines, tasks (the board and the team database), memory
 * items and file names in the team folder and the bots' folders. Pages, settings, bots, groups and quick actions are matched in the UI itself.
 *
 * Every source is optional and isolated: a module that is missing or fails just contributes nothing. On a paired phone
 * only sources whose own routes the phone may use are searched.
 *
 * Teams (0.4, package B2): every hit belongs to a team (the team of its bot, group, key or folder) or to every team
 * (`teamId` null: skills, apps for all teams, memory about the owner — shared until those modules get their own walls).
 * The owner sees every team and can filter on one (`?team=`); a search for a bot (`scope.agentId`,
 * `ctx.services.search.forAgent`) only finds what that bot may read: its own conversations and folders, plus the team
 * folders, channels, routines and memory of the teams it may read (home team, meekijken, aansturen).
 */

export type HitKind = 'message' | 'channel' | 'skill' | 'app' | 'routine' | 'task' | 'file' | 'memory';

export interface SearchHit {
  id: string;
  kind: HitKind;
  title: string;
  subtitle?: string;
  /** Message/memory text with the match between [ and ]. For a message, `id` is the message id (the UI scrolls to it). */
  snippet?: string;
  href: string;
  agentId?: string | null;
  at?: string | null;
  /** The team this hit belongs to (null: every team; absent without teams). */
  teamId?: string | null;
}

/** Who searches: the owner (optionally one team) or a bot (only what it may read). */
export interface SearchScope {
  /** Only hits of this team (plus what every team shares): the owner's team filter. */
  teamId?: string | null;
  /** A search for this bot: only hits of the teams it may read, and of other bots only what is the team's. */
  agentId?: string | null;
}

const PER_KIND = 6;
const MESSAGES = 8;
/** The list route of each source: a phone only gets the sources it may open. */
const SOURCE_ROUTE: Record<HitKind, string> = {
  message: '/search',
  channel: '/channels/bindings',
  skill: '/skills',
  app: '/mcp/connections',
  routine: '/routines',
  task: '/rooms/tasks',
  memory: '/memory/items',
  file: '/folders/browse',
};

const ADAPTER_LABEL: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp (Business)', 'whatsapp-web': 'WhatsApp', discord: 'Discord', slack: 'Slack', email: 'E-mail' };

const likeArg = (q: string) => `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

/** Mark the first case-insensitive occurrence of `q` in `text` with [ ], with a little context around it. */
export function markSnippet(text: string, q: string, around = 60): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return oneLine(t, around * 2);
  const start = Math.max(0, i - around);
  const end = Math.min(t.length, i + q.length + around);
  return `${start ? '…' : ''}${t.slice(start, i)}[${t.slice(i, i + q.length)}]${t.slice(i + q.length, end)}${end < t.length ? '…' : ''}`;
}

/** FTS query for search-as-you-type: every word must occur; the last one may be a prefix ("basispak" → "basispakket"). */
export function ftsPrefixQuery(q: string): string {
  const words = q
    .split(/\s+/)
    .map((w) => w.replace(/["*^:(){}[\]]/g, ''))
    .filter(Boolean)
    .slice(0, 8);
  return words.map((w, i) => `"${w.replace(/"/g, '""')}"${i === words.length - 1 && w.length >= 2 ? '*' : ''}`).join(' ');
}

// ---------------- teams ----------------

/**
 * The team view of one search: which team a bot, group or key belongs to, and whether a hit of a team may be shown.
 * Without the teams module (or without teams) everything passes, as before.
 */
interface Lens {
  /** Teams are in play (the teams module is loaded and the owner has a team). */
  on: boolean;
  /** The team of a bot (null: unknown). */
  botTeam(agentId: string | null | undefined): string | null;
  /** The team of a group. */
  roomTeam(roomId: string | null | undefined): string | null;
  /** The team a key ("alleen dit team") belongs to, else null (every team). */
  keyTeam(kind: string, refId: string): string | null;
  /** May a hit of this team be shown (null = every team's)? */
  allows(teamId: string | null): boolean;
  /** The bot a search is for (null: the owner). */
  agentId: string | null;
  defaultTeam: string | null;
}

function lensFor(ctx: Ctx, u: User, scope: SearchScope): Lens {
  const svc = ctx.services.teams;
  const teams: { id: string }[] = svc?.list?.(u.id) || [];
  const agentId = scope.agentId || null;
  if (!svc?.teamOf || !teams.length) return { on: false, botTeam: () => null, roomTeam: () => null, keyTeam: () => null, allows: () => true, agentId, defaultTeam: null };
  const readable = agentId ? new Set<string>(svc.readableTeams(agentId)) : null;
  const memo = new Map<string, string | null>();
  const once = (k: string, f: () => string | null) => {
    if (!memo.has(k)) memo.set(k, f());
    return memo.get(k)!;
  };
  const defaultTeam = teams[0]?.id ?? null;
  return {
    on: true,
    agentId,
    defaultTeam,
    botTeam: (id) => (id ? once(`a:${id}`, () => svc.teamOf(id)) : null),
    roomTeam: (id) =>
      id ? once(`r:${id}`, () => ctx.services.rooms?.teamOf?.(id) ?? ctx.store.one<{ w: string | null }>('SELECT workspace_id AS w FROM rooms WHERE id = ?', id)?.w ?? defaultTeam) : null,
    keyTeam: (kind, refId) => once(`k:${kind}:${refId}`, () => svc.keyScope?.(kind, refId) ?? null),
    allows: (t) => {
      if (t === null) return true;
      if (readable && !readable.has(t)) return false;
      if (scope.teamId && t !== scope.teamId) return false;
      return true;
    },
  };
}

/** Keep the hits a lens allows, at most `n`. */
function keep(lens: Lens, hits: SearchHit[], n: number): SearchHit[] {
  if (!lens.on) return hits.slice(0, n);
  return hits.filter((h) => lens.allows(h.teamId ?? null)).slice(0, n);
}

// ---------------- file names (team folder + the bots' folders) ----------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', '.next', '.cache', '.turbo', 'dist', 'build', '.idea', '.vscode']);
const WALK_MAX = 5000;
const WALK_DEPTH = 6;
const WALK_TTL = 30_000;

interface FileEntry {
  rel: string;
  name: string;
  dir: boolean;
}
const walkCache = new Map<string, { at: number; list: FileEntry[] }>();

/** All file and folder names under `root` (bounded, cached for a short while so typing stays fast). */
export function listNames(root: string, nowMs = Date.now()): FileEntry[] {
  const hit = walkCache.get(root);
  if (hit && nowMs - hit.at < WALK_TTL) return hit.list;
  const out: FileEntry[] = [];
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: '', depth: 0 }];
  while (queue.length && out.length < WALK_MAX) {
    const cur = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= WALK_MAX) break;
      if (e.isSymbolicLink()) continue;
      const abs = path.join(cur.abs, e.name);
      if (isProtectedPath(abs) || isProtectedPath(abs + path.sep)) continue;
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      const dir = e.isDirectory();
      if (dir && (SKIP_DIRS.has(e.name) || e.name.startsWith('.'))) continue;
      out.push({ rel, name: e.name, dir });
      if (dir && cur.depth + 1 < WALK_DEPTH) queue.push({ abs, rel, depth: cur.depth + 1 });
    }
  }
  walkCache.set(root, { at: nowMs, list: out });
  if (walkCache.size > 200) walkCache.delete(walkCache.keys().next().value!);
  return out;
}

function fileScore(e: FileEntry, q: string): number {
  const n = e.name.toLowerCase();
  const base = n.replace(/\.[^.]+$/, '');
  if (n === q || base === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.split(/[\s._-]+/).some((w) => w.startsWith(q))) return 60;
  if (n.includes(q)) return 40;
  return 0;
}

function searchFiles(ctx: Ctx, u: User, q: string, agents: Agent[], lens: Lens): SearchHit[] {
  const ql = q.toLowerCase();
  const roots: { owner: string; index: number; root: AgentRoot; ownerLabel: string; teamId: string | null }[] = [];
  const seen = new Set<string>();
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const svc = ctx.services.teams;
  if (!isRestricted(ctx, u)) {
    if (lens.on) {
      // Every team's folder (the default team keeps the old link #/m/folders/team).
      for (const t of svc.list(u.id) as { id: string }[]) {
        const tf = svc.teamFolder(t.id);
        if (!tf?.path || !lens.allows(t.id)) continue;
        const k = norm(path.resolve(tf.path));
        if (seen.has(k)) continue;
        seen.add(k);
        roots.push({ owner: t.id === lens.defaultTeam ? 'team' : `team:${t.id}`, index: 0, root: { path: tf.path, mode: tf.mode, kind: 'team', label: tf.label }, ownerLabel: tf.label, teamId: t.id });
      }
    } else {
      const team = ctx.services.folders?.team?.(u.id);
      if (team?.path) {
        roots.push({ owner: 'team', index: 0, root: { path: team.path, mode: team.mode, kind: 'team', label: team.label }, ownerLabel: team.label, teamId: null });
        seen.add(norm(path.resolve(team.path)));
      }
    }
  }
  // A search for a bot: its own folders only (another bot's work folder is not team knowledge).
  for (const a of lens.agentId ? agents.filter((x) => x.id === lens.agentId) : agents) {
    const teamId = lens.botTeam(a.id);
    if (lens.on && !lens.allows(teamId)) continue;
    agentRootList(a).forEach((r, i) => {
      const k = norm(path.resolve(r.path));
      if (seen.has(k)) return;
      seen.add(k);
      roots.push({ owner: a.id, index: i, root: r, ownerLabel: `${a.name} · ${r.kind === 'workspace' ? 'werkmap' : r.label}`, teamId });
    });
  }
  const scored: { hit: SearchHit; score: number }[] = [];
  const started = Date.now();
  for (const r of roots) {
    if (Date.now() - started > 600) break;
    if (!fs.existsSync(r.root.path)) continue;
    for (const e of listNames(r.root.path)) {
      const s = fileScore(e, ql);
      if (!s) continue;
      const dirPath = e.dir ? e.rel : e.rel.split('/').slice(0, -1).join('/');
      const qs = new URLSearchParams({ root: String(r.index) });
      if (dirPath) qs.set('path', dirPath);
      if (!e.dir) qs.set('open', e.name);
      scored.push({
        score: s - Math.min(20, e.rel.split('/').length * 2) + (e.dir ? 0 : 1),
        hit: {
          id: `${r.owner}:${r.index}:${e.rel}`,
          kind: 'file',
          title: e.name,
          subtitle: `${r.ownerLabel}${dirPath ? ' / ' + dirPath : ''}${e.dir ? ' · map' : ''}`,
          href: `#/m/folders/${r.owner}?${qs}`,
          agentId: r.owner === 'team' || r.owner.startsWith('team:') ? null : r.owner,
          ...(lens.on ? { teamId: r.teamId } : {}),
        },
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.hit.title.localeCompare(b.hit.title))
    .slice(0, PER_KIND)
    .map((s) => s.hit);
}

// ---------------- the other sources ----------------

function searchMessages(ctx: Ctx, u: User, q: string, agentName: (id: string | null) => string, lens: Lens): SearchHit[] {
  const fts = ftsPrefixQuery(q);
  if (!fts) return [];
  const rows = ctx.store.all<any>(
    `SELECT f.message_id, f.thread_id, snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet, t.title, t.agent_id, t.room_id, m.created_at, m.author_name
     FROM messages_fts f JOIN threads t ON t.id = f.thread_id JOIN messages m ON m.id = f.message_id
     WHERE messages_fts MATCH ? AND f.user_id = ? ORDER BY rank LIMIT ?`,
    fts,
    u.id,
    lens.on ? MESSAGES * 5 : MESSAGES,
  );
  const hits: SearchHit[] = [];
  for (const h of rows) {
    // A conversation's team: its group's, else its bot's (old conversations without either: the default team).
    const teamId = lens.on ? (h.room_id ? lens.roomTeam(h.room_id) : lens.botTeam(h.agent_id)) || lens.defaultTeam : undefined;
    // A bot only finds its own conversations, and groups it takes part in.
    if (lens.agentId && !(h.room_id ? ctx.services.rooms?.botTakesPart?.(h.room_id, lens.agentId) : h.agent_id === lens.agentId)) continue;
    hits.push({
      id: h.message_id,
      kind: 'message' as const,
      title: h.title || agentName(h.agent_id) || 'Gesprek',
      subtitle: h.author_name,
      snippet: h.snippet,
      href: `#/t/${h.thread_id}`,
      agentId: h.agent_id,
      at: h.created_at,
      ...(lens.on ? { teamId: teamId ?? null } : {}),
    });
  }
  return keep(lens, hits, MESSAGES);
}

function searchChannels(ctx: Ctx, u: User, q: string, agentName: (id: string | null) => string, lens: Lens): SearchHit[] {
  const ql = q.toLowerCase();
  const labelHits = Object.entries(ADAPTER_LABEL)
    .filter(([, l]) => l.toLowerCase().includes(ql))
    .map(([id]) => id);
  const rows = ctx.store.all<any>(
    `SELECT id, name, adapter, agent_id, status, enabled FROM channel_bindings WHERE user_id = ? AND (name LIKE ? ESCAPE '\\' OR adapter LIKE ? ESCAPE '\\' ${labelHits.length ? `OR adapter IN (${labelHits.map(() => '?').join(',')})` : ''}) ORDER BY updated_at DESC LIMIT ?`,
    u.id,
    likeArg(q),
    likeArg(q),
    ...labelHits,
    lens.on ? PER_KIND * 5 : PER_KIND,
  );
  return keep(
    lens,
    rows.map((b) => ({
      id: b.id,
      kind: 'channel' as const,
      title: b.name,
      subtitle: [ADAPTER_LABEL[b.adapter] || b.adapter, b.agent_id ? agentName(b.agent_id) : '', !b.enabled ? 'uit' : b.status === 'error' ? 'fout' : ''].filter(Boolean).join(' · '),
      href: `#/m/channels/${b.id}`,
      agentId: b.agent_id,
      ...(lens.on ? { teamId: lens.keyTeam('channel', b.id) ?? (b.agent_id ? lens.botTeam(b.agent_id) : null) } : {}),
    })),
    PER_KIND,
  );
}

function searchSkills(ctx: Ctx, u: User, q: string, lens: Lens): SearchHit[] {
  const rows = ctx.store.all<any>(
    `SELECT id, name, description, status FROM skills WHERE user_id = ? AND status != 'draft' AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
     ORDER BY CASE WHEN name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, name LIMIT ?`,
    u.id,
    likeArg(q),
    likeArg(q),
    likeArg(q),
    PER_KIND,
  );
  // Skills are shared by every team until the skills module gets its own walls.
  return rows.map((s) => ({ id: s.id, kind: 'skill' as const, title: s.name, subtitle: oneLine(s.description, 90) || (s.status === 'active' ? 'Skill' : 'Skill · uit'), href: `#/m/skills/mine/${s.id}`, ...(lens.on ? { teamId: null } : {}) }));
}

function searchApps(ctx: Ctx, u: User, q: string, lens: Lens): SearchHit[] {
  const rows = ctx.store.all<any>(
    `SELECT id, name, label, slug, status, enabled FROM mcp_connections WHERE user_id = ? AND (name LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?`,
    u.id,
    likeArg(q),
    likeArg(q),
    likeArg(q),
    lens.on ? PER_KIND * 5 : PER_KIND,
  );
  const status: Record<string, string> = { error: 'fout', needs_auth: 'opnieuw inloggen', new: 'nog niet getest' };
  return keep(
    lens,
    rows.map((c) => ({ id: c.id, kind: 'app' as const, title: c.label || c.name, subtitle: ['App', !c.enabled ? 'uit' : status[c.status] || ''].filter(Boolean).join(' · '), href: `#/m/mcp/c/${c.id}`, ...(lens.on ? { teamId: lens.keyTeam('app', c.id) } : {}) })),
    PER_KIND,
  );
}

function searchRoutines(ctx: Ctx, u: User, q: string, agentName: (id: string | null) => string, lens: Lens): SearchHit[] {
  const rows = ctx.store.all<any>(
    `SELECT id, name, prompt, agent_id, status FROM routines WHERE user_id = ? AND (name LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\')
     ORDER BY CASE WHEN name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?`,
    u.id,
    likeArg(q),
    likeArg(q),
    likeArg(q),
    lens.on ? PER_KIND * 5 : PER_KIND,
  );
  const st: Record<string, string> = { paused: 'gepauzeerd', disabled: 'uit' };
  return keep(
    lens,
    rows.map((r) => ({
      id: r.id,
      kind: 'routine' as const,
      title: r.name,
      subtitle: [agentName(r.agent_id), st[r.status] || ''].filter(Boolean).join(' · '),
      href: `#/m/routines/r/${r.id}`,
      agentId: r.agent_id,
      ...(lens.on ? { teamId: r.agent_id ? lens.botTeam(r.agent_id) || lens.defaultTeam : lens.defaultTeam } : {}),
    })),
    PER_KIND,
  );
}

const TASK_STATUS: Record<string, string> = { todo: 'Te doen', doing: 'Bezig', review: 'Te controleren', done: 'Klaar', blocked: 'Geblokkeerd' };

/** Every word of the query (at most 6): a task matches when each word is in its title, description or result. */
const taskWords = (q: string) => q.split(/\s+/).filter(Boolean).slice(0, 6);

/**
 * Tasks on TeamBot's own board (`room_tasks`): every word must occur ("Offerte Jansen" finds "Offerte voor Jansen
 * afmaken"). Its team: the task's own (`workspace_id`), else the team of the bot that does it, else every team (the
 * owner's own task), as the task page shows it. The link opens the task on #/tasks.
 */
function searchTasks(ctx: Ctx, u: User, q: string, agentName: (id: string | null) => string, lens: Lens): SearchHit[] {
  const ws = taskWords(q);
  if (!ws.length) return [];
  const cond = ws.map(() => `(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\')`).join(' AND ');
  const rows = ctx.store.all<any>(
    `SELECT id, title, status, owner_type, owner_id, workspace_id, updated_at FROM room_tasks WHERE user_id = ? AND ${cond}
     ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, CASE WHEN status = 'done' THEN 1 ELSE 0 END, updated_at DESC LIMIT ?`,
    u.id,
    ...ws.flatMap((w) => [likeArg(w), likeArg(w), likeArg(w)]),
    likeArg(ws[0]),
    lens.on ? PER_KIND * 5 : PER_KIND,
  );
  return keep(
    lens,
    rows.map((t) => {
      const bot = t.owner_type === 'agent' ? agentName(t.owner_id) : '';
      return {
        id: t.id,
        kind: 'task' as const,
        title: t.title,
        subtitle: [TASK_STATUS[t.status] || '', bot].filter(Boolean).join(' · '),
        href: `#/tasks?open=${encodeURIComponent(`b:${t.id}`)}`,
        agentId: t.owner_type === 'agent' ? t.owner_id : null,
        at: t.updated_at,
        ...(lens.on ? { teamId: t.workspace_id || (t.owner_type === 'agent' ? lens.botTeam(t.owner_id) : null) || null } : {}),
      };
    }),
    PER_KIND,
  );
}

const TEAM_TASK_STATUS: Record<string, string> = { open: 'Te doen', bezig: 'Bezig', klaar: 'Klaar', kon_niet: 'Te controleren', geblokkeerd: 'Geblokkeerd', geannuleerd: 'Gestopt' };

/**
 * Tasks in the team database (table `taken`, the bots' team_execute list), of the team the task page reads: the chosen
 * team, else the default team. Asynchronous (that database lives in a worker), so only the search route adds them; a
 * missing table or a slow worker gives no hits.
 */
export async function searchTeamTasks(ctx: Ctx, u: User, qRaw: string, teamId: string | null = null): Promise<SearchHit[]> {
  const svc = ctx.services.teamdata;
  const q = qRaw.trim().slice(0, 120);
  const ws = taskWords(q);
  if (typeof svc?.rows !== 'function' || !ws.length || (q.length < 2 && !/\d/.test(q))) return [];
  const cond = ws.map(() => `(titel LIKE ? ESCAPE '\\' OR resultaat LIKE ? ESCAPE '\\')`).join(' AND ');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows: any[] = await Promise.race([
      svc.rows(u.id, `SELECT id, titel, status, eigenaar FROM taken WHERE ${cond} ORDER BY COALESCE(bijgewerkt, aangemaakt) DESC LIMIT ?`, [...ws.flatMap((w) => [likeArg(w), likeArg(w)]), PER_KIND], true, teamId),
      new Promise<any[]>((resolve) => (timer = setTimeout(() => resolve([]), 1500))),
    ]);
    return (rows || []).map((r) => {
      const st = String(r.status || '').toLowerCase();
      return {
        id: `t:${r.id}`,
        kind: 'task' as const,
        title: String(r.titel || ''),
        subtitle: [TEAM_TASK_STATUS[st] || (st.startsWith('wacht_op') ? 'Te controleren' : ''), String(r.eigenaar || '').trim()].filter(Boolean).join(' · '),
        href: `#/tasks?open=${encodeURIComponent(`t:${r.id}`)}`,
      };
    });
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function searchMemory(ctx: Ctx, u: User, q: string, lens: Lens): SearchHit[] {
  const mem = ctx.services.memory;
  if (!mem?.search) return [];
  const scope: Record<string, string> = { user: 'Over jou', agent: 'Bot', shared: 'Gedeeld', dossier: 'Dossier' };
  return keep(
    lens,
    (mem.search(u.id, q, { limit: lens.on ? PER_KIND * 5 : PER_KIND }) as any[])
      .filter((m) => m && m.id && (!m.status || m.status === 'active'))
      // A bot's own memories are its own: another bot of the team does not find them.
      .filter((m) => !lens.agentId || !m.agent_id || m.agent_id === lens.agentId || m.scope !== 'agent')
      .map((m) => {
        const secret = m.sensitivity === 'sensitive';
        return {
          id: m.id,
          kind: 'memory' as const,
          title: secret ? 'Gevoelige herinnering' : oneLine(m.content, 90),
          subtitle: [scope[m.scope] || 'Herinnering', m.agent_name || '', m.dossier_title || ''].filter(Boolean).join(' · '),
          snippet: secret ? undefined : markSnippet(m.content, q),
          href: `#/m/memory/item/${m.id}`,
          agentId: m.agent_id || null,
          // Memory gets its own team walls in a later package; until then a memory of a bot belongs to the bot's team.
          ...(lens.on ? { teamId: m.agent_id ? lens.botTeam(m.agent_id) : null } : {}),
        };
      }),
    PER_KIND,
  );
}

/**
 * Search every source for one user. `allowed(kind)` decides which sources may be searched (phones). `scope`: one team
 * (the owner's filter) or one bot (only what that bot may read).
 */
export function searchAll(ctx: Ctx, u: User, qRaw: string, allowed: (k: HitKind) => boolean = () => true, scope: SearchScope = {}): SearchHit[] {
  const q = qRaw.trim().slice(0, 120);
  if (q.length < 2 && !/\d/.test(q)) return [];
  const agents = ctx.store.agents(u.id).filter((a) => !a.archived);
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const agentName = (id: string | null) => (id ? names.get(id) || '' : '');
  const lens = lensFor(ctx, u, scope);
  // A bot of another owner (or an unknown one) finds nothing.
  if (scope.agentId && !agents.some((a) => a.id === scope.agentId)) return [];
  const out: SearchHit[] = [];
  const sources: [HitKind, () => SearchHit[]][] = [
    ['message', () => searchMessages(ctx, u, q, agentName, lens)],
    ['channel', () => searchChannels(ctx, u, q, agentName, lens)],
    ['skill', () => searchSkills(ctx, u, q, lens)],
    ['app', () => searchApps(ctx, u, q, lens)],
    ['routine', () => searchRoutines(ctx, u, q, agentName, lens)],
    ['task', () => searchTasks(ctx, u, q, agentName, lens)],
    ['memory', () => searchMemory(ctx, u, q, lens)],
    ['file', () => searchFiles(ctx, u, q, agents, lens)],
  ];
  for (const [kind, fn] of sources) {
    if (!allowed(kind)) continue;
    try {
      out.push(...fn());
    } catch (e: any) {
      // A missing table (module not loaded) or a malformed FTS query: this source simply has no hits.
      if (!/no such table|fts5|syntax error|unterminated/i.test(String(e?.message))) ctx.log.warn(`[search] ${kind}:`, e?.message || e);
    }
  }
  return out;
}

const mod: Module = {
  id: 'search',
  label: 'Zoeken',
  init(ctx) {
    if (!Array.isArray(ctx.services.mobileRoutes)) ctx.services.mobileRoutes = [];
    ctx.services.mobileRoutes.push({ method: 'GET', path: '/search/all' });

    /** On a paired phone: only the sources whose own list route the phone may use. */
    const routeAllowed = (req: Request) => {
      if ((req as any).session?.kind !== 'device') return () => true;
      const policy = ctx.services.mobile?.instance?.policy;
      // Since 0.4.1 a phone may use every route except the computer-only list (`allows`); older policies only `match`.
      return (route: string) => !!(policy?.allows ? policy.allows('GET', route) : policy?.match?.('GET', route));
    };
    const allowedFor = (req: Request) => {
      const ok = routeAllowed(req);
      return (k: HitKind) => ok(SOURCE_ROUTE[k]);
    };

    /**
     * Search for other modules. `forAgent`: what a bot may find (only the teams it may read); any search a bot can
     * start (a tool, a CLI bridge) goes through this, never through `all`.
     */
    ctx.services.search = {
      all: (userId: string, q: string, scope: SearchScope = {}) => {
        const u = ctx.store.user(userId);
        return u ? searchAll(ctx, u, q, () => true, scope) : [];
      },
      forAgent: (agentId: string, q: string) => {
        const a = ctx.store.agent(agentId);
        const u = a ? ctx.store.user(a.user_id) : null;
        return a && u ? searchAll(ctx, u, q, () => true, { agentId: a.id }) : [];
      },
    };

    ctx.api.get(
      '/search/all',
      ah(async (req) => {
        const u = user(req);
        const q = str(req.query.q, 200);
        // ?team=<teamId>: only that team's hits (plus what every team shares).
        const team = str(req.query.team, 80);
        const own = team && ctx.services.teams?.team?.(team)?.user_id === u.id ? team : null;
        const hits = searchAll(ctx, u, q, allowedFor(req), own ? { teamId: own } : {});
        // The team database's tasks (the other half of the task page), after the board's own; together at most PER_KIND.
        if (routeAllowed(req)('/teamdata/tasks') && !isRestricted(ctx, u)) {
          const board = hits.filter((h) => h.kind === 'task').length;
          if (board < PER_KIND) {
            const extra = (await searchTeamTasks(ctx, u, q, own)).slice(0, PER_KIND - board);
            const at = hits.findIndex((h) => h.kind === 'memory' || h.kind === 'file');
            hits.splice(at < 0 ? hits.length : at, 0, ...extra);
          }
        }
        return { q, hits };
      }),
    );
  },
};

export default mod;
