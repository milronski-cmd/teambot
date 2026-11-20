import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Run } from '../core/types.js';

/**
 * One bot at a time on what cannot be shared. Two things a team of bots kept doing over each other (live, 20 Nov 2026):
 *   - putting a site live: two builders deployed the same site minutes apart, one from an older state, and work of the
 *     other was gone from the live site until it was found;
 *   - writing to a person: three bots each wrote their own mail to the same contact.
 * In both TeamBot can see it coming, so the second bot hears it once, at the step itself, with who was first and what
 * to do; the same step again goes through (the two may have agreed). Nothing is locked for good and nobody has to
 * claim anything.
 */

const DEPLOY_MIN = 20;
const MAIL_HOURS = 48;

/** Commands that put something live for everyone. */
const DEPLOY_RE = /\bvercel\b[^\n;|&]*(?:--prod\b|\bdeploy\b[^\n;|&]*--prod\b)|\bvercel\s+(?:deploy\s+)?--prod\b|\bnetlify\s+deploy\b[^\n;|&]*--prod\b|\bwrangler\s+(?:pages\s+)?(?:deploy|publish)\b|\bfirebase\s+deploy\b|\bnpm\s+publish\b|\bgh-pages\b/i;

const lastDeploy = new Map<string, { agentId: string; name: string; at: number }>();
const told = new Set<string>();

const lower = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);

/** The repository a folder belongs to: the main checkout, also from inside one of its worktrees. */
export function repoOf(dir: string): string | null {
  let d = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    const g = path.join(d, '.git');
    try {
      const st = fs.statSync(g);
      if (st.isDirectory()) return d;
      const m = /gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/i.exec(fs.readFileSync(g, 'utf8'));
      return m ? path.resolve(m[1].trim()) : d;
    } catch {
      /* no .git here */
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** The folder a command works in: `cd <dir>` or `--cwd <dir>` in the command, else the step's own folder. */
function folderOf(command: string, cwd?: string): string | null {
  const m = /(?:^|[;&|\n]\s*)(?:cd|Set-Location|pushd)\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(command) || /--cwd[= ](?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(command);
  let dir = m ? m[1] || m[2] || m[3] : cwd || '';
  if (!dir) return null;
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(dir);
  if (msys) dir = `${msys[1].toUpperCase()}:/${msys[2]}`;
  return path.isAbsolute(dir) ? dir : cwd ? path.resolve(cwd, dir) : null;
}

/** A colleague just put this same site live: said once to the second one, before its own deploy. */
export function deployClash(agent: Agent, run: Pick<Run, 'id'> | null, command: string | undefined, cwd: string | undefined, now = Date.now()): string | null {
  const cmd = String(command || '');
  if (!cmd || !DEPLOY_RE.test(cmd)) return null;
  const dir = folderOf(cmd, cwd);
  const repo = dir ? repoOf(dir) || dir : null;
  if (!repo) return null;
  const key = lower(repo);
  const prev = lastDeploy.get(key);
  const mark = `${run?.id || agent.id}|d|${key}`;
  if (prev && prev.agentId !== agent.id && now - prev.at < DEPLOY_MIN * 60_000 && !told.has(mark)) {
    told.add(mark);
    if (told.size > 2000) told.clear();
    const who = agent.settings?.private === true ? 'Een andere bot' : prev.name;
    return `Nog niet live gezet: ${who} zette ${path.basename(repo)} ${Math.max(1, Math.round((now - prev.at) / 60_000))} min geleden live. Twee keer kort na elkaar live zetten vanaf verschillende standen haalt het werk van de ander van de site. Haal eerst de laatste stand op (git fetch, bouw vanaf de nieuwste main), kijk of jouw wijziging er nog bij moet en stem af wie live zet. Klopt het dan, doe dezelfde stap opnieuw: die gaat dan door.`;
  }
  lastDeploy.set(key, { agentId: agent.id, name: agent.name, at: now });
  return null;
}

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** A colleague wrote this person in the last two days (a draft or a sent mail): said once to the second one. */
export function mailClash(ctx: Ctx, agent: Agent, run: Pick<Run, 'id'> | null, tool: string, input: any, now = Date.now()): string | null {
  if (!/(?:^|_)gmail_(?:draft|send)$/.test(tool)) return null;
  const to = ADDRESS.exec(String(input?.to || ''))?.[0]?.toLowerCase();
  if (!to) return null;
  const mark = `${run?.id || agent.id}|m|${to}`;
  if (told.has(mark)) return null;
  let row: any = null;
  try {
    row = ctx.store.one<any>(
      "SELECT c.agent_id, c.tool, c.created_at FROM mcp_calls c WHERE c.user_id = ? AND c.ok = 1 AND c.agent_id IS NOT NULL AND c.agent_id != ? AND c.tool IN ('gmail_draft','gmail_send') AND c.created_at >= ? AND lower(c.summary) LIKE ? ORDER BY c.created_at DESC LIMIT 1",
      agent.user_id,
      agent.id,
      new Date(now - MAIL_HOURS * 3_600_000).toISOString(),
      `%${to}%`,
    );
  } catch {
    return null;
  }
  if (!row) return null;
  const other = ctx.store.agent(row.agent_id);
  if (!other || other.archived || other.settings?.private === true) return null;
  told.add(mark);
  if (told.size > 2000) told.clear();
  const when = String(row.created_at).slice(0, 16).replace('T', ' ');
  const rest = `Eén bot schrijft met één persoon, anders krijgt die twee verschillende berichten. Lees eerst wat er al ligt (gmail_search op dit adres) en stem af met ${other.name}, of laat het aan hem. Is het afgestemd of gaat jouw bericht over iets anders, doe dan dezelfde stap opnieuw: die gaat dan door.`;
  return row.tool === 'gmail_send' ? `Nog niet gedaan: ${other.name} verstuurde een mail aan ${to} (${when} UTC). ${rest}` : `Nog niet gedaan: ${other.name} zette een concept klaar aan ${to} (${when} UTC). ${rest}`;
}

/** Tests only. */
export function resetOneAtATime() {
  lastDeploy.clear();
  told.clear();
}
