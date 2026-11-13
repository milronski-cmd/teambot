import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, ToolDef } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { MAX_HITS, searchFiles } from './search.js';
import { words } from '../../../shared/i18n-core.js';

const PROTECTED = /([\\/]\.ssh([\\/]|$)|[\\/]\.gnupg([\\/]|$)|[\\/]\.aws([\\/]|$)|master\.key$|local-token$|[\\/]\.env(\.[^\\/]*)?$)/i;
/** The same without `.env`: a bot on "Volledige toegang" builds apps and reads and writes their .env files. */
const PROTECTED_KEYS = /([\\/]\.ssh([\\/]|$)|[\\/]\.gnupg([\\/]|$)|[\\/]\.aws([\\/]|$)|master\.key$|local-token$)/i;
/**
 * Key files and folders no bot may touch (keys, logins, password managers, browser passwords/cookies, TeamBot's key),
 * in any mode, on every kind of AI. Where they live on this computer: `keyPlaces`.
 */
export const KEY_PATH = /([\\/]\.(ssh|gnupg|aws|azure|kube|password-store|terraform\.d)([\\/]|$)|[\\/]\.git-credentials$|[\\/]_?\.?netrc$|[\\/]\.(vault-token|pgpass)$|[\\/]\.docker[\\/]config\.json$|[\\/]\.config[\\/](gh|gcloud)([\\/]|$)|[\\/]\.codex[\\/]auth\.json$|[\\/]\.claude[\\/]\.credentials\.json$|[\\/]opencode[\\/]auth\.json$|master\.key$|local-token$|[\\/]Microsoft[\\/](Credentials|Protect)([\\/]|$)|[\\/]Roaming[\\/]Bitwarden([\\/]|$)|[\\/]Local[\\/]1Password([\\/]|$)|[\\/](Login Data|Login Data For Account|Cookies|Web Data|Local State|logins\.json|key4\.db|cookies\.sqlite|signons\.sqlite)$)/i;

const existsPath = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where the files of KEY_PATH are on this computer, for an engine whose own sandbox needs real paths instead of a
 * pattern (Codex, cli-agents/codex-sandbox.ts): only places that exist and that KEY_PATH itself refuses, so what such
 * a sandbox shuts and what the gate refuses come from this one list. Small targets where possible (a sandbox sets a
 * rule per path, and a large tree takes long). Not covered: a file with a key name elsewhere on the disk (KEY_PATH
 * refuses it anywhere; a list of places cannot name it).
 */
export function keyPlaces(o: { home: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; codexHome?: string }): string[] {
  const env = o.env || process.env;
  const win = (o.platform || process.platform) === 'win32';
  const h = (...p: string[]) => path.join(o.home, ...p);
  const out: string[] = [];
  const add = (p: string) => {
    if (KEY_PATH.test(p) && existsPath(p)) out.push(p);
  };
  for (const p of ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.password-store', '.terraform.d', '.vault-token', '.git-credentials', '.netrc', '_netrc', '.pgpass', '.docker/config.json', '.config/gh', '.config/gcloud', '.claude/.credentials.json', '.local/share/opencode/auth.json']) add(h(...p.split('/')));
  add(path.join(o.codexHome || env.CODEX_HOME || h('.codex'), 'auth.json'));
  if (win) {
    const roaming = env.APPDATA || h('AppData', 'Roaming');
    const local = env.LOCALAPPDATA || h('AppData', 'Local');
    for (const p of [path.join(roaming, 'Microsoft', 'Credentials'), path.join(roaming, 'Microsoft', 'Protect'), path.join(local, 'Microsoft', 'Credentials'), path.join(roaming, 'Bitwarden'), path.join(local, '1Password')]) add(p);
    // Chromium browsers: the encryption key (Local State) and per profile the logins, cookies and form data.
    const chromium = [path.join(local, 'Google', 'Chrome', 'User Data'), path.join(local, 'Microsoft', 'Edge', 'User Data'), path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'), path.join(local, 'Vivaldi', 'User Data'), path.join(local, 'Chromium', 'User Data'), path.join(roaming, 'Opera Software', 'Opera Stable')];
    for (const ud of chromium) {
      if (!existsPath(ud)) continue;
      add(path.join(ud, 'Local State'));
      let profiles: string[] = [];
      try {
        profiles = fs.readdirSync(ud).filter((n) => n === 'Default' || /^Profile \d+$/.test(n));
      } catch {
        /* unreadable */
      }
      if (existsPath(path.join(ud, 'Login Data'))) profiles.push('.');
      for (const pr of profiles) for (const f of ['Login Data', 'Login Data For Account', 'Cookies', path.join('Network', 'Cookies'), 'Web Data']) add(path.join(ud, pr, f));
    }
    for (const base of [path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'), path.join(roaming, 'Thunderbird', 'Profiles')]) {
      let profiles: string[] = [];
      try {
        profiles = fs.readdirSync(base);
      } catch {
        continue;
      }
      for (const pr of profiles) for (const f of ['logins.json', 'key4.db', 'cookies.sqlite', 'signons.sqlite']) add(path.join(base, pr, f));
    }
  }
  return out;
}
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', '.next', '.cache']);

/** A folder a bot may use. The first root of an agent is always its own workspace (read-write). */
export interface AgentRoot {
  path: string;
  mode: 'rw' | 'ro';
  kind: 'workspace' | 'extra' | 'team';
  label: string;
}

/** Extra roots contributed by modules (e.g. the shared team folder). Must be synchronous and cheap. */
type RootProvider = (agent: Agent) => AgentRoot[];
const rootProviders: RootProvider[] = [];
export function addRootProvider(fn: RootProvider): () => void {
  rootProviders.push(fn);
  return () => {
    const i = rootProviders.indexOf(fn);
    if (i >= 0) rootProviders.splice(i, 1);
  };
}

/**
 * Narrows the folders of a bot after all roots are known (e.g. teams: a folder of another team only with access).
 * May only drop roots or make them read-only; the work folder always stays. Must be synchronous and cheap.
 */
type RootFilter = (agent: Agent, roots: AgentRoot[]) => AgentRoot[];
const rootFilters: RootFilter[] = [];
export function addRootFilter(fn: RootFilter): () => void {
  rootFilters.push(fn);
  return () => {
    const i = rootFilters.indexOf(fn);
    if (i >= 0) rootFilters.splice(i, 1);
  };
}

/**
 * Refuses one path for a bot even inside its folders (e.g. another team's folder inside its work folder): a reason in
 * Dutch, or null. `real` is the resolved path (symlinks followed). Must be synchronous and cheap.
 */
type PathGuard = (agent: Agent, real: string, o: { write?: boolean }) => string | null;
const pathGuards: PathGuard[] = [];
export function addPathGuard(fn: PathGuard): () => void {
  pathGuards.push(fn);
  return () => {
    const i = pathGuards.indexOf(fn);
    if (i >= 0) pathGuards.splice(i, 1);
  };
}

/**
 * "Volledige toegang" means the whole computer, not only the bot's folders (the owner's explicit choice: a bot he
 * trusts works like he does). What stays closed: key files and folders (KEY_PATH, PROTECTED), TeamBot's own data and
 * the folders the owner closed (`closed`). The folders module says for which bots this holds (never a shared run,
 * never a member's bot on a server); without it, or with `settings.ownFoldersOnly`, a bot stays in its folders.
 */
type WholeComputer = (agent: Agent) => { closed: string[] } | null;
let wholeProvider: WholeComputer | null = null;
export function setWholeComputer(fn: WholeComputer): () => void {
  wholeProvider = fn;
  return () => {
    if (wholeProvider === fn) wholeProvider = null;
  };
}
/**
 * "Volledige toegang" as the owner means it: no built-in block, limit or question. Never for a shared bot in a member's
 * conversation (agent/shared.ts lowers that one to "Vragen" anyway).
 */
export function fullAccess(agent: Pick<Agent, 'access_mode' | 'settings'> | null | undefined): boolean {
  return !!agent && agent.access_mode === 'full' && !agent.settings?.sharedRun;
}
export function wholeComputer(agent: Agent): { closed: string[] } | null {
  if (!wholeProvider || agent.access_mode !== 'full' || agent.settings?.sharedRun || agent.settings?.ownFoldersOnly === true) return null;
  try {
    const w = wholeProvider(agent);
    return w ? { closed: (w.closed || []).filter((p) => typeof p === 'string' && p.trim()).map((p) => path.resolve(p)) } : null;
  } catch {
    return null; // fail-safe: the bot's own folders only
  }
}

/**
 * What stays shut for this bot on every level, besides the key files: TeamBot's own data and the folders the owner
 * closed (the list "Volledige toegang" keeps shut, `wholeComputer`). On a lower level the gate refuses everything
 * outside the bot's folders anyway; an engine whose sandbox reads more than that (Codex, codex-sandbox.ts) needs the
 * list itself.
 */
export function shutFolders(agent: Agent, dataDir: string): string[] {
  let closed: string[] = [];
  try {
    closed = (wholeProvider?.({ ...agent, access_mode: 'full', settings: { ...(agent.settings || {}), ownFoldersOnly: false } })?.closed || []).filter((p) => typeof p === 'string' && p.trim());
  } catch {
    closed = [];
  }
  const out = new Map<string, string>();
  for (const p of [dataDir, ...closed]) if (p && path.isAbsolute(p)) out.set(norm(path.resolve(p)), path.resolve(p));
  return [...out.values()];
}

/** Root filters can only remove roots or lower them to read-only; a filter that throws keeps only the work folder. */
function narrowRoots(agent: Agent, roots: AgentRoot[]): AgentRoot[] {
  let out = roots;
  for (const fn of rootFilters) {
    let next: AgentRoot[];
    try {
      next = fn(agent, out.map((r) => ({ ...r }))) || [];
    } catch {
      next = out.filter((r) => r.kind === 'workspace');
    }
    const byPath = new Map(next.map((r) => [norm(path.resolve(r.path)), r]));
    out = out.flatMap((r) => {
      const n = byPath.get(norm(r.path));
      if (!n) return r.kind === 'workspace' && r === out[0] ? [r] : [];
      return [{ ...r, mode: r.mode === 'ro' || n.mode === 'ro' ? 'ro' : 'rw' }];
    });
  }
  return out;
}

/**
 * All folders of a bot with their access: the workspace, `settings.extraRoots` (legacy, read-write),
 * `settings.folders` ([{ path, mode, label }]) and module roots (team folder). The same folder listed twice
 * keeps the most permissive mode; root filters (teams) can narrow the result afterwards.
 */
export function agentRootList(agent: Agent): AgentRoot[] {
  const out: AgentRoot[] = [];
  const add = (r: AgentRoot) => {
    if (!r.path || typeof r.path !== 'string') return;
    const p = path.resolve(r.path);
    const dup = out.find((x) => norm(x.path) === norm(p));
    if (dup) {
      if (r.mode === 'rw') dup.mode = 'rw';
      return;
    }
    out.push({ ...r, path: p, mode: r.mode === 'ro' ? 'ro' : 'rw' });
  };
  if (agent.workspace) add({ path: agent.workspace, mode: 'rw', kind: 'workspace', label: 'Werkmap' });
  // A shared bot in a member's conversation: only its private folder for that member, never the owner's folders.
  if (agent.settings?.sharedRun) return out;
  const legacy: unknown[] = Array.isArray(agent.settings?.extraRoots) ? agent.settings.extraRoots : [];
  for (const p of legacy) if (typeof p === 'string') add({ path: p, mode: 'rw', kind: 'extra', label: path.basename(p) || p });
  const folders: any[] = Array.isArray(agent.settings?.folders) ? agent.settings.folders : [];
  for (const f of folders) if (f && typeof f.path === 'string' && f.path.trim()) add({ path: f.path, mode: f.mode === 'ro' ? 'ro' : 'rw', kind: 'extra', label: String(f.label || path.basename(f.path) || f.path).slice(0, 80) });
  for (const fn of rootProviders) {
    try {
      for (const r of fn(agent) || []) add(r);
    } catch {
      /* a broken provider never widens access */
    }
  }
  return rootFilters.length ? narrowRoots(agent, out) : out;
}

export function agentRoots(agent: Agent): string[] {
  return agentRootList(agent).map((r) => r.path);
}

/**
 * The Prullenbak of the folders module (server/modules/folders/trash.ts), offered as `ctx.services.trash`. When it
 * runs, the file tools keep what they overwrite or delete: the previous version of an overwritten file and a deleted
 * file go into the trash (restorable for 30 days), a created file is noted for "alles van deze run terugzetten".
 * Without it (a minimal setup) the tools change files as before and deleting stays an action that always asks.
 */
export interface TrashKeep {
  kept: boolean;
  entry: { id: string; kind?: string } | null;
  reason?: string;
  tooBig?: boolean;
}
export interface TrashLike {
  keepBeforeWrite(o: { agent: Agent; file: string; runId?: string | null; threadId?: string | null; source: string }): TrashKeep;
  noteCreated(o: { agent: Agent; file: string; runId?: string | null; threadId?: string | null; source: string }): void;
  moveToTrash(o: { agent: Agent; file: string; runId?: string | null; threadId?: string | null; source: string }): TrashKeep;
  days: number;
}
let trashCount = 0;
/** The folders module announces its trash here (riskFor has no ctx); returns the undo for its stop(). */
export function announceTrash(): () => void {
  trashCount++;
  let done = false;
  return () => {
    if (!done) trashCount--;
    done = true;
  };
}
const trashOf = (ctx: Ctx): TrashLike | null => {
  const t = ctx.services?.trash;
  return t && typeof t.moveToTrash === 'function' ? (t as TrashLike) : null;
};
/** Keep the old version before a tool writes `f` (or note that it is new). Never throws: a failure is a note. */
function keepForWrite(ctx: Ctx, t: { agent: Agent; run: { id: string }; thread: { id: string } }, f: string, source: string): string {
  const trash = trashOf(ctx);
  if (!trash) return '';
  try {
    if (fs.existsSync(f)) {
      if (!fs.statSync(f).isFile()) return '';
      const k = trash.keepBeforeWrite({ agent: t.agent, file: f, runId: t.run.id, threadId: t.thread.id, source });
      // A file this run created itself has no earlier version to mention.
      if (k.entry?.kind === 'created') return '';
      return k.kept ? ' De vorige versie staat in de prullenbak.' : k.tooBig ? ` Let op: ${k.reason} Er is geen vorige versie bewaard.` : '';
    }
    trash.noteCreated({ agent: t.agent, file: f, runId: t.run.id, threadId: t.thread.id, source });
  } catch (e: any) {
    return ` Let op: de vorige versie kon niet bewaard worden (${String(e?.message || e).slice(0, 120)}).`;
  }
  return '';
}

/** Extra roots (everything except the workspace), optionally only the writable ones (for CLI --add-dir). */
export function extraRootsOf(agent: Agent, o: { writableOnly?: boolean } = {}): string[] {
  return agentRootList(agent)
    .slice(1)
    .filter((r) => !o.writableOnly || r.mode === 'rw')
    .map((r) => r.path);
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
/**
 * The one path-containment check: true when `child` is `parent` itself or lies inside it (on Windows whatever the
 * letter case). A sibling whose name merely starts with two dots (`..foo`) is inside; `..`, `../x` and a path on
 * another drive are not. Symlinks are not followed: pass real paths where that matters.
 */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(norm(path.resolve(parent)), norm(path.resolve(child)));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function realish(p: string): string {
  let check = p;
  while (!fs.existsSync(check)) {
    const parent = path.dirname(check);
    if (parent === check) return p;
    check = parent;
  }
  return path.join(fs.realpathSync.native(check), path.relative(check, p));
}

/** True for paths that are always off limits (keys, tokens, .env files), whatever folder they are in. */
export function isProtectedPath(p: string): boolean {
  return PROTECTED.test(p);
}

/**
 * Resolve `p` (absolute, or relative to the first root) inside one of `roots`; refuses escapes (incl. symlinks)
 * and secret files. With `write`, the most specific root that contains the path must be read-write.
 */
export function resolveInRoots(roots: AgentRoot[], p: string | undefined, o: { write?: boolean; envFiles?: boolean } = {}): string {
  if (!roots.length) throw new Error('Deze bot heeft geen werkmap');
  const target = p && path.isAbsolute(p) ? path.resolve(p) : path.resolve(roots[0].path, p || '.');
  const real = realish(target);
  const hits = roots.filter((r) => isInside(real, realish(r.path)));
  if (!hits.length) {
    const allowed = roots.map((r) => r.path).join(' ; ');
    throw new Error(roots.length === 1 ? `Pad valt buiten de toegestane werkmap: ${p}. Toegestaan: ${allowed}` : `Pad valt buiten de toegestane werkmap en extra mappen: ${p}. Toegestaan: ${allowed}`);
  }
  if ((o.envFiles ? PROTECTED_KEYS : PROTECTED).test(real)) throw new Error(`Dit pad is beschermd (geheimen/sleutels): ${p}`);
  if (o.write) {
    const own = hits.sort((a, b) => realish(b.path).length - realish(a.path).length)[0];
    if (own.mode === 'ro') throw new Error(`Deze map is alleen-lezen voor deze bot: ${own.label} (${own.path}). Schrijf in je werkmap of vraag de eigenaar om schrijfrechten.`);
  }
  return target;
}

/** Resolve a path inside the agent's allowed roots; refuses escapes (incl. symlinks) and secret files. */
export function resolveInWorkspace(agent: Agent, p: string | undefined, o: { write?: boolean } = {}): string {
  const roots = agentRootList(agent);
  if (!roots.length) throw new Error('Deze bot heeft geen werkmap');
  fs.mkdirSync(roots[0].path, { recursive: true });
  const whole = wholeComputer(agent);
  let target: string;
  const abs = p && path.isAbsolute(p) ? path.resolve(p) : null;
  if (whole && abs && !roots.some((r) => isInside(realish(abs), realish(r.path)))) {
    // Outside the bot's folders, on a bot with the whole computer: everything except keys and closed folders.
    const real = realish(abs);
    // A project's .env is ordinary work on "Volledige toegang"; the real key store stays shut.
    if (PROTECTED_KEYS.test(real) || KEY_PATH.test(real)) throw new Error(`Dit pad is beschermd (geheimen/sleutels): ${p}`);
    const shut = whole.closed.find((c) => isInside(real, realish(c)));
    if (shut) throw new Error(`Deze map is dicht voor bots (sleutels of gegevens van TeamBot): ${shut}`);
    target = abs;
  } else {
    target = resolveInRoots(roots, p, { ...o, envFiles: fullAccess(agent) });
    if (whole) {
      // A folder the owner closed stays closed when it lies inside one of the bot's folders (a closed folder that
      // contains the bot's folder, such as TeamBot's data, does not shut that folder).
      const real = realish(target);
      const shut = whole.closed.find((c) => isInside(real, realish(c)) && !roots.some((r) => isInside(realish(r.path), realish(c))));
      if (shut) throw new Error(`Deze map is dicht voor bots (sleutels of gegevens van TeamBot): ${shut}`);
    }
  }
  if (pathGuards.length) {
    const real = realish(target);
    for (const g of pathGuards) {
      let why: string | null;
      try {
        why = g(agent, real, o);
      } catch {
        why = `Dit pad kon niet worden gecontroleerd: ${p}`;
      }
      if (why) throw new Error(why);
    }
  }
  return target;
}

/** A NUL byte in the first 8000 bytes: not a text file. */
export function isBinary(buf: Buffer) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function rel(agent: Agent, abs: string) {
  const r = path.relative(agentRoots(agent)[0], abs);
  return r.startsWith('..') ? abs : r || '.';
}

/** Weaker models read "in de werkmap" as "only relative paths" and never reach their extra folders or the team folder. */
const PATH_HELP = 'Pad relatief aan de werkmap, of een volledig pad in een van je extra mappen of de teammap (zie Mappen).';

/**
 * A relative path that starts with the name of one of the bot's extra folders or the team folder, while its work folder
 * has nothing by that name: the model meant that folder. Round 6 (B-46): a local model read the extra folder with its
 * full path, then wrote "tb-r6e-team/teamnotitie.md", which landed in a new subfolder of its own work folder. Null when
 * the path is absolute, starts with "./" (explicitly the work folder), or names no such folder.
 */
export function meantFolder(agent: Agent, p: string | undefined): { root: AgentRoot; first: string; full: string } | null {
  if (typeof p !== 'string' || !p.trim() || path.isAbsolute(p) || /^\.[\\/]/.test(p)) return null;
  const [first, ...rest] = p.split(/[\\/]+/).filter(Boolean);
  if (!first || first === '.' || first === '..') return null;
  const roots = agentRootList(agent);
  if (!roots.length || fs.existsSync(path.join(roots[0].path, first))) return null;
  const name = first.toLowerCase();
  const hits = roots.slice(1).filter((r) => path.basename(r.path).toLowerCase() === name || r.label.toLowerCase() === name);
  return hits.length === 1 ? { root: hits[0], first, full: path.join(hits[0].path, ...rest) } : null;
}

/** "… is geen map in je werkmap maar de teammap (…). Gebruik het volledige pad: …" for a path `meantFolder` recognises. */
function folderHint(m: NonNullable<ReturnType<typeof meantFolder>>, p: string, write = false): string {
  const which = m.root.kind === 'team' ? 'de teammap' : `je extra map ${m.root.label}`;
  const hint = `"${m.first}" is geen map in je werkmap maar ${which} (${m.root.path}). Gebruik het volledige pad: ${m.full}.`;
  return write ? `${hint} Bedoel je echt een nieuwe map "${m.first}" in je werkmap, schrijf dan "./${p.replace(/\\/g, '/')}".` : hint;
}

/**
 * A change that can never land (outside the bot's folders, in a read-only folder, a protected file) is refused before
 * the approval card: round 6 asked the owner to approve a write into a read-only extra folder, then refused it anyway.
 * A relative path that names an extra folder or the team folder is refused with the full path to use (B-46), so the
 * file does not end up in a look-alike folder inside the work folder.
 */
const refuseWrite = (a: any, t: { agent: Agent }): string | null => {
  const meant = meantFolder(t.agent, a?.path);
  if (meant) return `Geweigerd door TeamBot: ${folderHint(meant, a.path, true)}`;
  try {
    resolveInWorkspace(t.agent, a?.path, { write: true });
    return null;
  } catch (e: any) {
    return `Geweigerd door TeamBot: ${String(e?.message || e)}`;
  }
};

/**
 * A read that can never succeed (a key file, TeamBot's own data, a folder the owner closed, a path outside the bot's
 * folders) is refused before anything is asked too, like a write and like a read of a CLI engine: with a rule of the
 * owner "vraag eerst voordat je iets leest" he got a card for a read that was then refused anyway.
 */
const refuseRead = (a: any, t: { agent: Agent }): string | null => {
  try {
    resolveInWorkspace(t.agent, a?.path);
    return null;
  } catch (e: any) {
    return `Geweigerd door TeamBot: ${String(e?.message || e)}`;
  }
};

/**
 * The same `refuse` for a tool elsewhere that reads the file (or the list of files) named in `field` of its
 * arguments: a document to read, a file to upload, import or attach. Refused before anything is asked.
 */
export const refuseReadOf =
  (field: string) =>
  (a: any, t: { agent: Agent }): string | null => {
    const v = a?.[field];
    for (const p of Array.isArray(v) ? v : [v]) if (typeof p === 'string' && p.trim()) {
      const why = refuseRead({ path: p }, t);
      if (why) return why;
    }
    return null;
  };

export function fileTools(): ToolDef[] {
  return [
    {
      name: 'list_files',
      group: 'files',
      risk: 'read',
      description: 'Toon bestanden en mappen in de werkmap van deze bot (of een submap). Gebruik recursive voor een boomweergave.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Map relatief aan de werkmap (standaard "."), of een volledig pad in een van je extra mappen of de teammap (zie Mappen).' }, recursive: { type: 'boolean' } },
      },
      summarize: (a) => words('Bestanden bekijken: {0}', a.path || '.'),
      refuse: refuseRead,
      async run(a, t) {
        const dir = resolveInWorkspace(t.agent, a.path);
        if (!fs.existsSync(dir)) {
          const meant = meantFolder(t.agent, a.path);
          return { text: `Map bestaat niet: ${a.path || '.'}${meant ? `. ${folderHint(meant, a.path)}` : ''}`, isError: true };
        }
        const out: string[] = [];
        const walk = (d: string, depth: number) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (out.length >= 500) return;
            if (SKIP_DIRS.has(e.name)) continue;
            const full = path.join(d, e.name);
            const st = fs.statSync(full, { throwIfNoEntry: false });
            out.push(`${'  '.repeat(depth)}${e.isDirectory() ? '📁 ' + e.name + '/' : e.name + (st ? `  (${st.size} B)` : '')}`);
            if (a.recursive && e.isDirectory() && depth < 4) walk(full, depth + 1);
          }
        };
        walk(dir, 0);
        return out.length ? `${rel(t.agent, dir)}:\n${out.join('\n')}${out.length >= 500 ? '\n… (afgekapt)' : ''}` : `${rel(t.agent, dir)} is leeg.`;
      },
    },
    {
      name: 'read_file',
      group: 'files',
      risk: 'read',
      description: 'Lees een tekstbestand uit de werkmap. Optioneel offset (regelnummer, 1 = eerste) en limit (aantal regels).',
      parameters: { type: 'object', properties: { path: { type: 'string', description: PATH_HELP }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] },
      summarize: (a) => words('Lezen: {0}', a.path),
      refuse: refuseRead,
      async run(a, t) {
        const f = resolveInWorkspace(t.agent, a.path);
        if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
          const meant = meantFolder(t.agent, a.path);
          return { text: `Bestand niet gevonden: ${a.path}${meant ? `. ${folderHint(meant, a.path)}` : ''}`, isError: true };
        }
        const buf = fs.readFileSync(f);
        if (isBinary(buf)) return /\.(pdf|docx)$/i.test(f) || buf.subarray(0, 5).toString('latin1') === '%PDF-' ? `Dit is een pdf- of Word-bestand (${buf.length} bytes): lees de tekst met read_document.` : `Binair bestand (${buf.length} bytes); kan niet als tekst gelezen worden.`;
        const lines = buf.toString('utf8').split(/\r?\n/);
        const start = Math.max(1, Number(a.offset) || 1);
        const lim = Math.min(Number(a.limit) || 2000, 5000);
        const slice = lines.slice(start - 1, start - 1 + lim);
        let text = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
        if (text.length > 200_000) text = text.slice(0, 200_000) + '\n… (afgekapt)';
        const more = start - 1 + lim < lines.length ? `\n… nog ${lines.length - (start - 1 + lim)} regels (gebruik offset)` : '';
        return text + more;
      },
    },
    {
      name: 'write_file',
      group: 'files',
      risk: 'write',
      description: 'Maak of overschrijf een bestand in de werkmap met de opgegeven inhoud. Mappen worden automatisch aangemaakt.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: PATH_HELP }, content: { type: 'string' } }, required: ['path', 'content'] },
      summarize: (a) => words('Schrijven: {0} ({1} tekens)', a.path, String(a.content ?? '').length),
      refuse: refuseWrite,
      async run(a, t) {
        const f = resolveInWorkspace(t.agent, a.path, { write: true });
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const existed = fs.existsSync(f);
        const kept = keepForWrite(t.ctx, t, f, 'write_file');
        fs.writeFileSync(f, String(a.content ?? ''), 'utf8');
        t.ctx.audit(t.userId, 'file.write', { path: f, bytes: Buffer.byteLength(String(a.content ?? '')) }, t.agent.id);
        return `${existed ? 'Overschreven' : 'Aangemaakt'}: ${rel(t.agent, f)} (${Buffer.byteLength(String(a.content ?? ''))} bytes)${kept}`;
      },
    },
    {
      name: 'edit_file',
      group: 'files',
      risk: 'write',
      description: 'Vervang exact een stuk tekst in een bestand. old_text moet precies één keer voorkomen, tenzij replace_all = true.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: PATH_HELP }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
        required: ['path', 'old_text', 'new_text'],
      },
      summarize: (a) => words('Bewerken: {0}', a.path),
      refuse: refuseWrite,
      async run(a, t) {
        const f = resolveInWorkspace(t.agent, a.path, { write: true });
        if (!fs.existsSync(f)) return { text: `Bestand niet gevonden: ${a.path}`, isError: true };
        const src = fs.readFileSync(f, 'utf8');
        const oldT = String(a.old_text);
        const count = oldT ? src.split(oldT).length - 1 : 0;
        if (count === 0) return { text: 'old_text niet gevonden in het bestand. Lees het bestand eerst en kopieer de tekst exact.', isError: true };
        if (count > 1 && !a.replace_all) return { text: `old_text komt ${count} keer voor; maak het unieker of zet replace_all = true.`, isError: true };
        const out = a.replace_all ? src.split(oldT).join(String(a.new_text)) : src.replace(oldT, () => String(a.new_text));
        keepForWrite(t.ctx, t, f, 'edit_file');
        fs.writeFileSync(f, out, 'utf8');
        t.ctx.audit(t.userId, 'file.edit', { path: f, replacements: a.replace_all ? count : 1 }, t.agent.id);
        return `Bewerkt: ${rel(t.agent, f)} (${a.replace_all ? count : 1} vervanging${count > 1 && a.replace_all ? 'en' : ''})`;
      },
    },
    {
      name: 'search_files',
      group: 'files',
      risk: 'read',
      description: 'Zoek tekst (of een reguliere expressie) in bestanden in de werkmap. Geeft bestand:regel: inhoud.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, regex: { type: 'boolean' }, glob: { type: 'string', description: 'bijv. *.ts' } }, required: ['query'] },
      summarize: (a) => words('Zoeken: "{0}"', a.query),
      refuse: refuseRead,
      async run(a, t) {
        const root = resolveInWorkspace(t.agent, a.path);
        if (!String(a.query ?? '')) return { text: 'Geef een zoekterm op.', isError: true };
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return 'Geen resultaten.';
        // ripgrep in its own process (search.ts): a big folder or a heavy pattern never holds up the server.
        const r = await searchFiles({ root, query: String(a.query), regex: !!a.regex, glob: a.glob ? String(a.glob) : undefined, signal: t.signal });
        if (r.error) return { text: `Deze zoekopdracht kan niet: ${r.error}`, isError: true };
        const hits = r.hits.filter((h) => !isProtectedPath(h.file)).map((h) => `${rel(t.agent, h.file)}:${h.line}: ${h.text.trim().slice(0, 300)}`);
        const note = r.timedOut ? `\n… (zoeken gestopt na 15 seconden; maak de map of de zoekterm kleiner)` : r.truncated || hits.length >= MAX_HITS ? `\n… (max ${MAX_HITS} resultaten)` : '';
        return hits.length ? hits.join('\n') + note : r.timedOut ? note.trim() : 'Geen resultaten.';
      },
    },
    {
      name: 'delete_file',
      // Inside the bot's workspace only (snapshots/undo exist): a normal action under "Volledige toegang".
      impact: 'local',
      group: 'files',
      risk: 'danger',
      // With the Prullenbak a delete can be undone: then it is a normal change (asks in "Vraagt toestemming", runs in
      // "Automatisch"). A file that does not fit in the trash is never removed without its own approval (below).
      riskFor: () => (trashCount > 0 ? 'write' : 'danger'),
      description: 'Verwijder een bestand of lege map in de werkmap. Het gaat naar de prullenbak van TeamBot, waar de gebruiker het kan terughalen.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      summarize: (a) => words(trashCount > 0 ? 'Naar de prullenbak: {0}' : 'VERWIJDEREN: {0}', a.path),
      refuse: refuseWrite,
      async run(a, t) {
        const f = resolveInWorkspace(t.agent, a.path, { write: true });
        if (!fs.existsSync(f)) return { text: 'Bestaat niet', isError: true };
        if (agentRoots(t.agent).some((r) => norm(path.resolve(f)) === norm(r))) return { text: 'De werkmap (of een gedeelde map) zelf kan niet verwijderd worden', isError: true };
        const st = fs.statSync(f);
        if (st.isDirectory() && fs.readdirSync(f).length) return { text: 'Deze map is niet leeg; verwijder eerst de bestanden erin (elk gaat naar de prullenbak).', isError: true };
        const trash = trashOf(t.ctx);
        if (trash) {
          let k: TrashKeep;
          try {
            k = trash.moveToTrash({ agent: t.agent, file: f, runId: t.run.id, threadId: t.thread.id, source: 'delete_file' });
          } catch (e: any) {
            // Never fall back to a silent permanent delete.
            return { text: `Niet verwijderd: het bestand kon niet in de prullenbak gezet worden (${String(e?.message || e).slice(0, 160)}).`, isError: true };
          }
          if (k.kept) {
            t.ctx.audit(t.userId, 'file.delete', { path: f, trash: k.entry?.id }, t.agent.id);
            return `Naar de prullenbak: ${rel(t.agent, f)}. De gebruiker kan het ${trash.days} dagen lang terughalen (Bestanden › Prullenbak).`;
          }
          if (!k.tooBig) return { text: `Niet verwijderd: ${k.reason || 'het bestand kon niet in de prullenbak gezet worden'}`, isError: true };
          // Too big for the trash: a permanent delete, always with its own approval card and an exact preview.
          let ok = false;
          try {
            const r = await t.ctx.broker.request({ userId: t.userId, agent: t.agent, thread: t.thread, run: t.run, kind: 'tool', tool: 'delete_file:definitief', input: { path: f, bytes: st.size }, summary: `DEFINITIEF VERWIJDEREN (past niet in de prullenbak, terughalen kan niet): ${f}`, risk: 'danger', signal: t.signal });
            ok = r.approved;
          } catch {
            ok = false;
          }
          if (!ok) return { text: `Niet verwijderd: ${k.reason} Definitief verwijderen mocht niet.`, isError: true };
        }
        if (st.isDirectory()) fs.rmdirSync(f);
        else fs.unlinkSync(f);
        t.ctx.audit(t.userId, 'file.delete', { path: f, permanent: true }, t.agent.id);
        return `Definitief verwijderd: ${rel(t.agent, f)}`;
      },
    },
    {
      name: 'share_file',
      group: 'files',
      risk: 'read',
      description: 'Stuur een bestand uit de werkmap als bijlage naar de gebruiker in de chat (downloadbaar, ook op de telefoon).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      summarize: (a) => words('Bestand delen: {0}', a.path),
      refuse: refuseRead,
      async run(a, t) {
        const f = resolveInWorkspace(t.agent, a.path);
        if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return { text: 'Bestand niet gevonden', isError: true };
        const ref = registerAttachment(t.ctx, t.userId, t.thread.id, f, path.basename(f), true);
        return { text: `Gedeeld als bijlage: ${ref.name}`, attachments: [ref] };
      },
    },
  ];
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
  '.html': 'text/html', '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'audio/webm', '.mp4': 'video/mp4',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const mimeOf = (name: string) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

/** Copy (or reference) a file into the attachment store and return its reference. */
export function registerAttachment(ctx: Ctx, userId: string, threadId: string | null, source: string, name: string, copy = true) {
  const id = newId('att_');
  const dir = path.join(ctx.config.dataDir, 'attachments', userId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, id + path.extname(name));
  if (copy) fs.copyFileSync(source, dest);
  else fs.renameSync(source, dest);
  const size = fs.statSync(dest).size;
  const ref = { id, name, mime: mimeOf(name), size };
  ctx.store.insert('attachments', { id, user_id: userId, thread_id: threadId, name, mime: ref.mime, size, path: dest, created_at: now() });
  return ref;
}
