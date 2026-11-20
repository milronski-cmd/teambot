import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Run } from '../core/types.js';
import { resolveInWorkspace } from './builtin/files.js';

/**
 * Two bots in one checkout of a git repository overwrite each other's work: the second one writes over what the first
 * just changed, builds a half state, or commits the other's files (live, 20 Nov 2026: two builders in one site
 * folder). Other agent systems give every agent its own working copy of a repository (a git worktree per agent or
 * task); a bot here chooses its own folders, so TeamBot says it at the moment it matters instead: the first write of
 * a bot into a checkout where a colleague's turn wrote in the last half hour is refused once, with the command for a
 * worktree of its own. The same write again goes through (the two may have agreed to work there together), and a
 * worktree is a checkout of its own, so nothing is said there.
 *
 * In memory only: after a restart no turn runs, so there is nobody to collide with.
 */

const RECENT_MS = 30 * 60_000;

interface Seen {
  at: number;
  runId: string | null;
  name: string;
  hidden: boolean;
}

const writers = new Map<string, Map<string, Seen>>();
const told = new Set<string>();

const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** The checkout a path lies in: the nearest folder with `.git` (a folder: the repository itself; a file: a worktree). */
export function checkoutOf(file: string): string | null {
  let dir = path.resolve(file);
  for (let i = 0; i < 40; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      return null;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bot';

/** The refusal for the first write of this turn into a checkout a colleague works in, or null (and the write is noted). */
export function sharedCheckout(ctx: Ctx, agent: Agent, run: Pick<Run, 'id'> | null, paths: string[] | undefined, o: { now?: number; active?(runId: string): boolean } = {}): string | null {
  if (!paths?.length) return null;
  const now = o.now ?? Date.now();
  const active = o.active || ((id: string) => ['running', 'waiting'].includes(ctx.store.run(id)?.status || ''));
  let refusal: string | null = null;
  const roots = new Set<string>();
  for (const p of paths) {
    let abs: string;
    try {
      abs = resolveInWorkspace(agent, p);
    } catch {
      // The gate decided before this whether the bot may write there; here only where it lies counts.
      if (!path.isAbsolute(p)) continue;
      abs = p;
    }
    const root = checkoutOf(abs);
    if (root) roots.add(root);
  }
  for (const root of roots) {
    const k = key(root);
    const list = writers.get(k) || new Map<string, Seen>();
    for (const [id, s] of list) if (now - s.at > RECENT_MS || (s.runId && !active(s.runId))) list.delete(id);
    const other = [...list.entries()].find(([id]) => id !== agent.id);
    const mark = `${run?.id || agent.id}|${k}`;
    if (other && !told.has(mark) && !refusal) {
      told.add(mark);
      if (told.size > 2000) told.clear();
      const who = other[1].hidden ? 'Een andere bot' : other[1].name;
      const name = path.basename(root);
      const tree = path.join(agent.workspace || path.dirname(root), 'werkbomen', name);
      const branch = `${slug(agent.name)}/${new Date(now).toISOString().slice(0, 10)}`;
      refusal =
        `Nog niet geschreven: ${who} werkt op dit moment ook in ${root} (laatste wijziging ${Math.max(1, Math.round((now - other[1].at) / 60_000))} min geleden). ` +
        `Twee bots in dezelfde werkmap van een repo schrijven over elkaars werk heen. Werk in je eigen werkmap van deze repo: ` +
        `git -C "${root}" worktree add "${tree}" -b ${branch}  (bestaat die map al, ga daar dan verder), doe je wijzigingen daar en breng ze samen via je branch. ` +
        `Hebben jullie afgesproken hier samen te werken, doe dan dezelfde stap opnieuw: die gaat nu door.`;
      continue;
    }
    list.set(agent.id, { at: now, runId: run?.id || null, name: agent.name, hidden: agent.settings?.private === true });
    writers.set(k, list);
  }
  return refusal;
}

/** Tests only. */
export function resetSharedCheckouts() {
  writers.clear();
  told.clear();
}
