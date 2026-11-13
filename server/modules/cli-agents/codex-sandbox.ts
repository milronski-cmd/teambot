import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside as inside, keyPlaces } from '../../tools/builtin/files.js';
import { runQuick } from './proc.js';

/**
 * What Codex's own sandbox lets a bot READ on this computer, and the Codex config that enforces it.
 *
 * Codex's legacy sandbox modes (`--sandbox read-only|workspace-write`) only limit writes: a bot could read
 * C:\Windows\win.ini, ~/.ssh or TeamBot's master.key. Codex 0.16x has permission profiles (`[permissions.<id>]`,
 * `default_permissions`, filesystem entries read/write/deny, special paths `:minimal`, `:root`, `:workspace_roots`,
 * `:tmpdir`; https://learn.chatgpt.com/docs/permissions). How much of a profile a computer can enforce depends on the
 * sandbox Codex has there, so TeamBot checks it once per Codex binary with `codex sandbox -P <profile>` and a canary
 * file outside a probe folder, and uses the strongest level that really held:
 *
 *  confined   – reads limited to the bot's folders + `:minimal` (on Windows C:\Windows, Program Files (x86),
 *               ProgramData). Windows: only the MXC sandbox (process isolation, `windows.sandbox = "mxc"`) can do this;
 *               the "elevated" sandbox refuses it ("requires effective `:root` read access", windows-sandbox-rs).
 *  keyfolders – Windows "elevated" sandbox: reads everything, minus deny entries (deny-read ACLs for Codex's sandbox
 *               users) on key folders and files that exist: ~/.ssh, credentials, browser logins, TeamBot's own data.
 *  open       – no profile support could be verified: the legacy flags; Codex can read what the owner can read.
 *
 * "Volledige toegang" on the whole computer needs one more thing: the whole disk writable with the hard blocks shut
 * (`:root` write plus deny entries; a deny entry shuts reading and writing, https://learn.chatgpt.com/docs/permissions).
 * Codex does not document `:root` write and refuses a write rule its runtime cannot enforce, so the check tries it too
 * (`root`): a file outside the probe folder must be written, a denied folder neither read nor written.
 *
 * What a profile shuts comes from the gate's own list (tools/builtin/files.ts): the places of KEY_PATH that exist
 * (`keyPlaces`), TeamBot's data and the folders the owner closed (`shutFolders`), never a folder of the bot itself.
 *
 * Only commands Codex runs are sandboxed; Codex's MCP servers (TeamBot's own bridge) run outside it and are gated by
 * TeamBot itself. A session flag `default_permissions` wins over a `sandbox_mode` in the owner's config.toml
 * (codex-rs/core/src/config/mod.rs, resolve_permission_config_syntax), so `--sandbox` must not be passed with it.
 */

export type CodexReadLevel = 'confined' | 'keyfolders' | 'open';

export interface CodexReadGuard {
  level: CodexReadLevel;
  /** The sandbox that held in the check: Windows MXC, Windows sandbox users ("elevated"), or the platform's own (macOS/Linux). */
  backend: 'mxc' | 'elevated' | 'platform' | null;
  /** What the check saw (for diagnostics; no file contents). */
  detail: string;
  /** The whole disk writable with deny entries holding (reads and writes): "Volledige toegang" can run in the sandbox. */
  root?: boolean;
}

export const CODEX_OPEN: CodexReadGuard = { level: 'open', backend: null, detail: 'niet gecontroleerd' };
const PROFILE = 'teambot';
const PROBE_PROFILE = 'teambot_probe';
const toml = (v: string) => JSON.stringify(v);
const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const exists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

export interface CodexProfileInput {
  guard: CodexReadGuard;
  /** May the sandbox write in the workspace (and the bot's read-write folders)? */
  write: boolean;
  network: boolean;
  /** "Volledige toegang" on the whole computer: the whole disk writable (only where the check showed `root` holds). */
  root?: boolean;
  /** The workspace (Codex's cwd = `:workspace_roots`): on the confined level only what lies in the bot's folders is denied. */
  workspace?: string;
  /** The bot's other folders (not the workspace, which is Codex's cwd = `:workspace_roots`). */
  roots: { path: string; mode: 'rw' | 'ro' }[];
  /** Files outside the folders the bot must be able to read this turn (attachments). */
  readFiles?: string[];
  /** What stays shut (codexKeyPaths): key files, TeamBot's data, the folders the owner closed. */
  deny?: string[];
  platform?: NodeJS.Platform;
}

/**
 * `-c` overrides that select TeamBot's permission profile for one run, or null for the legacy `--sandbox` flags
 * (level "open", or the whole computer where `root` did not hold). The profile is complete in itself (no `extends`):
 * `:minimal` or `:root` read (`:root` write for the whole computer), the workspace and the bot's folders read or
 * write, temp write when writing, network only when asked, and the deny entries of what stays shut. Codex keeps
 * `.git`, `.codex`, `.agents` of a writable root read-only on its own (protocol/src/permissions.rs).
 */
export function codexProfileArgs(o: CodexProfileInput): string[] | null {
  if (o.guard.level === 'open' || (o.root && !o.guard.root)) return null;
  const win = (o.platform || process.platform) === 'win32';
  const entries = new Map<string, string>();
  const put = (key: string, value: string) => {
    const k = key.startsWith(':') ? key : norm(key);
    if (!entries.has(k)) entries.set(k, `${toml(key)}=${value}`);
  };
  put(o.root ? ':root' : o.guard.level === 'confined' ? ':minimal' : ':root', o.root ? '"write"' : '"read"');
  put(':workspace_roots', `{"."="${o.write ? 'write' : 'read'}"}`);
  // Temp: MXC gives every sandboxed process its own temp folder (TEMP points into the container), so the owner's
  // %TEMP% (other programs' files) stays closed there; elsewhere commands get the system temp to write, as before.
  if (o.write && !o.root && !(win && o.guard.backend === 'mxc')) {
    put(':tmpdir', '"write"');
    if (!win) put(':slash_tmp', '"write"');
  }
  for (const r of o.roots) put(r.path, `"${o.write && r.mode === 'rw' ? 'write' : 'read'}"`);
  for (const f of o.readFiles || []) put(f, '"read"');
  // What stays shut. Confined: the sandbox reads only the bot's folders, so only what lies inside them needs a rule.
  const readable = [o.workspace, ...o.roots.map((r) => r.path)].filter((p): p is string => !!p);
  for (const d of o.deny || []) if (o.root || o.guard.level === 'keyfolders' || readable.some((r) => inside(d, r))) entries.set(norm(d), `${toml(d)}="deny"`);
  const profile = `permissions.${PROFILE}={filesystem={${[...entries.values()].join(', ')}}${o.network ? ', network={enabled=true}' : ''}}`;
  return [...(o.guard.backend === 'mxc' ? ['-c', 'windows.sandbox="mxc"'] : []), '-c', profile, '-c', `default_permissions="${PROFILE}"`];
}

/**
 * What a Codex profile denies: the places of the gate's KEY_PATH that exist (files.ts keyPlaces), and TeamBot's data
 * and the folders the owner closed (files.ts shutFolders). A shut folder that holds a folder of the bot (TeamBot's
 * data holds its workspace) is shut around that folder: everything next to it on the way down, as the gate refuses it
 * there. Only paths that exist (Codex creates a missing deny path as a folder), never a folder of the bot or one that
 * holds it.
 */
export function codexKeyPaths(o: { home: string; shut: string[]; keep: string[]; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; codexHome?: string }): string[] {
  const out: string[] = keyPlaces({ home: o.home, env: o.env, platform: o.platform, codexHome: o.codexHome });
  const carve = (p: string, depth: number) => {
    if (!exists(p)) return;
    if (!o.keep.some((k) => inside(k, p))) return void out.push(p);
    // A folder of the bot itself stays open; around it, one level down at a time.
    if (o.keep.some((k) => norm(k) === norm(p)) || depth > 8) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const n of names) carve(path.join(p, n), depth + 1);
  };
  for (const s of o.shut) carve(s, 0);
  const keepOut = out.filter((p) => !o.keep.some((k) => inside(k, p)));
  return [...new Map(keepOut.map((p) => [norm(p), p])).values()].slice(0, 400);
}

/** Has the owner set up Codex's Windows sandbox users ("elevated")? Probing it otherwise could start Codex's setup (admin prompt). */
function elevatedReady(codexHome: string): boolean {
  if (exists(path.join(codexHome, '.sandbox', 'setup_marker.json'))) return true;
  try {
    return /^\s*sandbox\s*=\s*["']elevated["']/m.test(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  } catch {
    return false;
  }
}

export type SandboxRunner = (bin: string, args: string[], cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;
const defaultRunner: SandboxRunner = (bin, args, cwd) => runQuick(bin, args, { timeoutMs: 120_000, cwd });

/**
 * Check what Codex's sandbox enforces here: run `type inside.txt` and `type <canary outside the folder>` under a
 * profile; a level counts only when the inside file was read and the canary's content did not come through.
 */
export async function probeCodexReadGuard(bin: string, dataDir: string, o: { platform?: NodeJS.Platform; run?: SandboxRunner; codexHome?: string } = {}): Promise<CodexReadGuard> {
  const platform = o.platform || process.platform;
  const win = platform === 'win32';
  const run = o.run || defaultRunner;
  const root = path.join(dataDir, 'cli-agents', 'sandbox-probe', crypto.randomBytes(4).toString('hex'));
  const ws = path.join(root, 'map');
  const outside = path.join(root, 'buiten');
  const insideToken = `TB-BINNEN-${crypto.randomBytes(6).toString('hex')}`;
  const canaryToken = `TB-KANARIE-${crypto.randomBytes(6).toString('hex')}`;
  const canary = path.join(outside, 'kanarie.txt');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(ws, 'binnen.txt'), insideToken);
  fs.writeFileSync(canary, canaryToken);
  const cmd = win ? ['cmd', '/c', `type binnen.txt & type "${canary}"`] : ['sh', '-c', `cat binnen.txt; cat '${canary.replace(/'/g, "'\\''")}'`];
  const attempt = async (profile: string, extra: string[] = []) => {
    const r = await run(bin, ['sandbox', ...extra, '-c', `permissions.${PROBE_PROFILE}=${profile}`, '-P', PROBE_PROFILE, '-C', ws, '--', ...cmd], ws);
    const text = `${r.stdout}\n${r.stderr}`;
    return { ok: text.includes(insideToken) && !text.includes(canaryToken), leaked: text.includes(canaryToken), why: (r.error || r.stderr || r.stdout || `exitcode ${r.code}`).replace(/\s+/g, ' ').slice(0, 200) };
  };
  // "Volledige toegang": the whole disk writable, the denied folder neither readable nor writable.
  const elders = path.join(root, 'elders');
  const written = path.join(elders, 'geschreven.txt');
  const tried = path.join(outside, 'poging.txt');
  const writeToken = `TB-SCHRIJF-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(elders, { recursive: true });
  const rootCmd = win
    ? ['cmd', '/c', `type binnen.txt & echo ${writeToken}> "${written}" & type "${canary}" & echo x> "${tried}"`]
    : ['sh', '-c', `cat binnen.txt; printf %s ${writeToken} > '${written.replace(/'/g, "'\\''")}'; cat '${canary.replace(/'/g, "'\\''")}'; printf x > '${tried.replace(/'/g, "'\\''")}'`];
  const rootHolds = async (extra: string[]) => {
    try {
      const r = await run(bin, ['sandbox', ...extra, '-c', `permissions.${PROBE_PROFILE}={filesystem={":root"="write", ":workspace_roots"={"."="write"}, ${toml(outside)}="deny"}}`, '-P', PROBE_PROFILE, '-C', ws, '--', ...rootCmd], ws);
      const text = `${r.stdout}\n${r.stderr}`;
      const wrote = (() => {
        try {
          return fs.readFileSync(written, 'utf8').includes(writeToken);
        } catch {
          return false;
        }
      })();
      return text.includes(insideToken) && !text.includes(canaryToken) && wrote && !exists(tried);
    } catch {
      return false;
    }
  };
  try {
    const confined = await attempt('{filesystem={":minimal"="read", ":workspace_roots"={"."="write"}}}', win ? ['-c', 'windows.sandbox="mxc"'] : []);
    if (confined.ok) {
      const g: CodexReadGuard = { level: 'confined', backend: win ? 'mxc' : 'platform', detail: win ? 'Windows-sandbox MXC: alleen de eigen mappen en systeemmappen leesbaar' : 'sandbox van het systeem: alleen de eigen mappen en systeembestanden leesbaar' };
      return { ...g, root: await rootHolds(win ? ['-c', 'windows.sandbox="mxc"'] : []) };
    }
    let why = `${win ? 'MXC' : 'sandbox'}: ${confined.leaked ? 'kanarie leesbaar' : confined.why}`;
    if (win && elevatedReady(o.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))) {
      const deny = await attempt(`{filesystem={":root"="read", ":workspace_roots"={"."="write"}, ${toml(outside)}="deny"}}`);
      if (deny.ok) return { level: 'keyfolders', backend: 'elevated', detail: `Windows-sandbox (elevated): alles leesbaar behalve geweigerde mappen (${why})`, root: await rootHolds([]) };
      why += `; elevated: ${deny.leaked ? 'kanarie leesbaar' : deny.why}`;
    }
    return { level: 'open', backend: null, detail: why };
  } catch (e: any) {
    return { level: 'open', backend: null, detail: `controle mislukt: ${String(e?.message || e).slice(0, 200)}` };
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

const cache = new Map<string, { at: number; v: Promise<CodexReadGuard> }>();

/** The read guard for this Codex binary, checked once (a weaker result is checked again after 15 minutes). */
export function codexReadGuard(bin: string, dataDir: string): Promise<CodexReadGuard> {
  let key = bin;
  try {
    key += ':' + fs.statSync(bin).mtimeMs;
  } catch {
    /* keep the path */
  }
  const c = cache.get(key);
  if (c) return c.v;
  const v = probeCodexReadGuard(bin, dataDir);
  cache.set(key, { at: Date.now(), v });
  v.then((g) => {
    if (g.level === 'confined') return;
    const t = setTimeout(() => cache.get(key)?.v === v && cache.delete(key), 15 * 60_000);
    t.unref?.();
  });
  return v;
}

/** For tests: forget earlier checks. */
export function resetCodexReadGuard() {
  cache.clear();
}

/** One sentence (Dutch) for the bot editor and the warning for "Volledige toegang": what Codex can read here. */
export function codexReadText(g: CodexReadGuard): string {
  if (g.level === 'confined')
    return g.backend === 'mxc'
      ? 'Lezen: Codex leest alleen in de mappen van deze bot en in de systeemmappen van Windows (Windows, Program Files, ProgramData). Je gebruikersmap, ~/.ssh, browserprofielen en de gegevens van TeamBot zijn afgesloten (Windows-sandbox, gecontroleerd op deze pc).'
      : 'Lezen: Codex leest alleen in de mappen van deze bot en in systeembestanden die programma’s nodig hebben (sandbox van het systeem, gecontroleerd op deze pc).';
  if (g.level === 'keyfolders')
    return 'Let op: Codex kan op deze pc ook buiten de werkmap lezen; de Windows-sandbox van Codex beperkt hier alleen schrijven. Afgeschermd zijn sleutelmappen en -bestanden: ~/.ssh, inloggegevens van git, cloud en CLI’s, Windows-referenties, wachtwoorden en cookies van browsers, de mappen die je dicht zette en de gegevens van TeamBot (behalve de mappen van deze bot).';
  return 'Let op: Codex kan op deze pc alles lezen wat jij kunt lezen, ook buiten de werkmap (ook ~/.ssh, de mappen die je dicht zette en de gegevens van TeamBot); de sandbox van Codex beperkt hier alleen schrijven. Gebruik Codex niet voor bots die je niet vertrouwt.';
}
