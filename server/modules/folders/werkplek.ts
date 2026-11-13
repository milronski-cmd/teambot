import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx } from '../../core/types.js';
import { isRestricted } from '../../api/member-policy.js';
import { isInside as inside } from '../../tools/builtin/files.js';
import { documentsFor, getTeamFolder, TEAM_KEY, type TeamFolder } from './index.js';

/**
 * "Eigen werkplek" (0.4.5): every new bot gets its own folder under its team's folder (Documenten\TeamBot\Teammap\Mila),
 * like a desk in the team's office. Its file tools and terminal work there by default; anything outside its folders
 * asks first (the shell gate, tools/builtin/shell.ts and the CLI gate) or is refused (file tools, key folders). A
 * colleague's desk is readable but never writable for another bot. No Docker, no WSL: the CLI engines get their own
 * sandbox pointed at this folder (it is their working folder).
 *
 * Only with a read-write team folder (the onboarding makes one) and for the owner's own bots (never a member on a
 * server, whose bots keep their private folder in TeamBot's data folder). Off with the user setting below.
 */

/** User setting: new bots get their folder in the team folder (default on; false keeps them in TeamBot's data folder). */
export const WERKPLEK_SETTING = 'werkplekInTeamFolder';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A folder name for a bot that works on Windows, macOS and Linux ("Mila", "Bot 2"); never empty or reserved. */
export function safeFolderName(name: string): string {
  let s = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.]+$/g, '')
    .slice(0, 60)
    .trim();
  if (!s) s = 'Bot';
  if (RESERVED.test(s)) s += '-bot';
  return s;
}

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/**
 * A folder of TeamBot's own data (a bot's private work folder, a shared bot's copy …), not a desk in a team folder.
 * A TeamBot with a data folder of its own keeps its team folders in that data folder too (`documentsFor`): those are
 * team folders like any other.
 */
const inOwnData = (ctx: Ctx, p: string) => inside(p, ctx.config.dataDir) && !inside(p, documentsFor(ctx));

/** The team folder a new bot belongs to: its home team's, else the default team's (only read-write ones). */
function folderOf(ctx: Ctx, userId: string, data: Partial<Agent>): TeamFolder | null {
  const teams = ctx.services.teams;
  const home = typeof data.settings?.homeTeam === 'string' ? data.settings.homeTeam : '';
  let tf: TeamFolder | null = null;
  try {
    const t = home && teams?.team?.(home);
    tf = t && t.user_id === userId ? teams.teamFolder(home) : getTeamFolder(ctx, userId);
  } catch {
    tf = null;
  }
  return tf && tf.mode === 'rw' ? tf : null;
}

/**
 * The werkplek for a new bot (null = TeamBot's own data folder, as before): `<team folder>\<bot name>`, a new folder
 * (an existing folder of the team is never taken over: "Mila (2)" then).
 */
export function werkplekFor(ctx: Ctx, userId: string, data: Partial<Agent>): string | null {
  const u = ctx.store.user(userId);
  if (!u || isRestricted(ctx, u)) return null;
  if (ctx.store.getSetting<boolean>(userId, WERKPLEK_SETTING, true) === false) return null;
  if (data.settings?.sharedRun) return null;
  const tf = folderOf(ctx, userId, data);
  if (!tf) return null;
  try {
    if (!fs.statSync(tf.path).isDirectory()) return null;
  } catch {
    return null;
  }
  const base = safeFolderName(String(data.name || ''));
  const taken = new Set(ctx.store.agents(userId, { archived: true }).map((a) => norm(a.workspace)));
  for (let i = 1; i < 100; i++) {
    const p = path.join(tf.path, i === 1 ? base : `${base} (${i})`);
    if (!fs.existsSync(p) && !taken.has(norm(p))) return p;
  }
  return null;
}

/**
 * The bot got another name right after it was made (the first run's "Aanpassen"): its werkplek follows, but only while
 * that folder is still empty and lies in a team folder (never a folder with files, never one the owner chose elsewhere).
 * Returns the new path, or null when nothing changed.
 */
export function followName(ctx: Ctx, agent: Agent): string | null {
  const cur = agent.workspace;
  if (!cur || inOwnData(ctx, cur)) return null;
  const tf = folderOf(ctx, agent.user_id, agent);
  if (!tf || norm(path.dirname(cur)) !== norm(tf.path)) return null;
  const want = safeFolderName(agent.name);
  if (path.basename(cur) === want) return null;
  try {
    if (fs.readdirSync(cur).length) return null;
  } catch {
    return null;
  }
  const next = werkplekFor(ctx, agent.user_id, { name: agent.name, settings: agent.settings });
  if (!next || path.basename(next) !== want) return null;
  fs.renameSync(cur, next);
  ctx.store.updateAgent(agent.id, { workspace: next });
  return next;
}

/**
 * Another bot of the same owner whose werkplek contains `real` (a desk inside a shared folder, not in TeamBot's data
 * folder). The bot may look there, never write: its own desk and the team folder itself are for that.
 */
export function colleagueWerkplek(ctx: Ctx, agent: Agent, real: string): Agent | null {
  for (const a of ctx.store.agents(agent.user_id, { archived: true })) {
    if (a.id === agent.id || !a.workspace || inOwnData(ctx, a.workspace)) continue;
    if (inside(agent.workspace, a.workspace)) continue; // this bot works inside the other's folder (set by the owner)
    if (inside(real, a.workspace)) return a;
  }
  return null;
}

/** The folders of the owner's teams (without the teams module: the one team folder). Only reads. */
function teamFolderPaths(ctx: Ctx, userId: string): string[] {
  const teams = ctx.services.teams;
  if (teams?.list && teams.teamFolder) return teams.list(userId).flatMap((t: { id: string }) => teams.teamFolder(t.id)?.path || []);
  const t = ctx.store.getSetting<any>(userId, TEAM_KEY, null);
  return typeof t?.path === 'string' && t.path.trim() ? [t.path] : [];
}

/**
 * Is the bot's work folder its own werkplek: a folder right under one of its owner's team folders that no other bot
 * uses? That is what every bot made in the screens or through the API gets (`werkplekFor`), so TeamBot keeps things
 * of the bot there itself, like in a private work folder in its data (the bot's skills as folders: skills/workspace.ts).
 * Not the team folder itself, not a folder the owner gave several bots, not a shared bot's copy.
 */
export function isWerkplek(ctx: Ctx, agent: Agent): boolean {
  const ws = agent.workspace;
  if (!ws || agent.settings?.sharedRun) return false;
  const parent = norm(path.dirname(ws));
  if (!teamFolderPaths(ctx, agent.user_id).some((p) => norm(p) === parent)) return false;
  return !ctx.store.agents(agent.user_id, { archived: true }).some((a) => a.id !== agent.id && !!a.workspace && norm(a.workspace) === norm(ws));
}
