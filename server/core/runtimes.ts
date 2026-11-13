import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractNpmTarball, extractZip } from '../modules/cli-agents/runtimes.js';

/**
 * Node.js (node, npm, npx) and uv (uv, uvx) on demand, for everything in TeamBot that starts such a program: apps
 * (MCP servers started with `npx …` or `uvx …`) and AI engines installed with npm. A normal PC often has neither.
 *
 *  - Found on PATH: used as it is ("system"); TeamBot changes nothing.
 *  - Not found: `ensure(id)` gets TeamBot's own copy into `<data>/runtimes/` once ("teambot"), for this user only,
 *    nothing installed system-wide:
 *      node: TeamBot already runs on Node (inside the desktop app: Electron as Node, ELECTRON_RUN_AS_NODE). Only npm
 *            is fetched: the official npm package from the npm registry (about 3 MB), checked against the SHA-512
 *            pinned here. Small launchers `node`, `npm` and `npx` in `<data>/runtimes/node/bin` start that Node.
 *      uv:   the official single-file build from astral-sh/uv on GitHub (about 15 MB), checked against the SHA-256
 *            pinned here. uv fetches a Python by itself the first time a Python app starts.
 *  - `env(...)` of a toolchain puts its folder in front of PATH, so `npx`, `node`, `uvx` etc. resolve to it, also in
 *    the processes the program starts itself (an npx package that runs `node`).
 *
 * API (also for other parts of TeamBot):
 *   find(id, dataDir)                      → Toolchain | null   (no network)
 *   ensure(id, dataDir, { onProgress })    → Promise<Toolchain>  (downloads once when missing; one download at a time)
 *   status(id, dataDir)                    → { id, source: 'system' | 'teambot' | null, version, sizeMb, job }
 *   toolchainOf(command)                   → 'node' | 'uv' | null   ("npx" → node, "uvx" → uv)
 *   onPath(command, env?)                  → boolean
 */

export type ToolchainId = 'node' | 'uv';

export interface ToolchainProgress {
  id: ToolchainId;
  phase: 'download' | 'verify' | 'extract' | 'done' | 'error';
  received?: number;
  total?: number;
  error?: string;
}

export interface Toolchain {
  id: ToolchainId;
  /** system: found on PATH (left alone); teambot: TeamBot's own copy in <data>/runtimes. */
  source: 'system' | 'teambot';
  version: string | null;
  /** Folders to put in front of PATH (empty for a system copy). */
  pathDirs: string[];
  /** Environment for a process that uses this toolchain: `base` with PATH (and the copy's own settings) added. */
  env(base?: NodeJS.ProcessEnv): Record<string, string>;
}

/** One pinned download per platform. Tests (and private mirrors) pass their own via `opts.source`. */
export interface Source {
  version: string;
  /** Full download URL. */
  url: string;
  /** "sha512-<base64>" (npm SRI) or "sha256:<hex>". */
  integrity: string;
  sizeMb: number;
}

const NPM_VERSION = '11.21.1';
const NPM: Source = {
  version: NPM_VERSION,
  url: `https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`,
  // The integrity the npm registry signed for npm@11.21.1 (registry.npmjs.org/npm/11.21.1, checked 2026-11-12).
  integrity: 'sha512-YTzL6QBEJXyHcTu0JiUc7RKMp+mzlJtl7rGLmERaXUQeFHIMc9atdr6G9M9C8vDWbv40epoTQAzNL2/PtZVDhQ==',
  sizeMb: 3,
};

const UV_VERSION = '0.13.6';
/** uv release assets per platform with the SHA-256 GitHub publishes for them (api.github.com, checked 2026-11-12). */
const UV_ASSETS: Record<string, { file: string; sha256: string; sizeMb: number }> = {
  'win32-x64': { file: 'uv-x86_64-pc-windows-msvc.zip', sha256: 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f', sizeMb: 15 },
  'win32-arm64': { file: 'uv-aarch64-pc-windows-msvc.zip', sha256: 'c2426c0c8e28b53d8c440e47a18d96ad4db51e159866c0e81435b196d7f0081c', sizeMb: 15 },
  'darwin-x64': { file: 'uv-x86_64-apple-darwin.tar.gz', sha256: '63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02', sizeMb: 17 },
  'darwin-arm64': { file: 'uv-aarch64-apple-darwin.tar.gz', sha256: '60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472', sizeMb: 14 },
  'linux-x64': { file: 'uv-x86_64-unknown-linux-gnu.tar.gz', sha256: 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645', sizeMb: 17 },
  'linux-arm64': { file: 'uv-aarch64-unknown-linux-gnu.tar.gz', sha256: '229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d', sizeMb: 16 },
};

const isWin = process.platform === 'win32';
const plat = () => `${process.platform}-${process.arch}`;

/**
 * The pinned download for this platform, or null when TeamBot has none for it. TEAMBOT_TOOLCHAIN_SOURCES (JSON,
 * `{ "node": Source, "uv": Source }`) replaces it: tests use a local fixture server, a company a private mirror.
 */
export function defaultSource(id: ToolchainId): Source | null {
  try {
    const over = process.env.TEAMBOT_TOOLCHAIN_SOURCES ? JSON.parse(process.env.TEAMBOT_TOOLCHAIN_SOURCES)?.[id] : null;
    if (over?.url && over?.integrity && over?.version) return { sizeMb: 0, ...over };
  } catch {
    /* unreadable: the pinned source */
  }
  if (id === 'node') return NPM;
  const a = UV_ASSETS[plat()];
  return a ? { version: UV_VERSION, url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${a.file}`, integrity: `sha256:${a.sha256}`, sizeMb: a.sizeMb } : null;
}

/** Which toolchain a command needs ("npx" → node, "uvx" → uv); null for anything else. */
export function toolchainOf(command: string): ToolchainId | null {
  const base = path.basename(String(command || '')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  return base === 'node' || base === 'npm' || base === 'npx' ? 'node' : base === 'uv' || base === 'uvx' ? 'uv' : null;
}

const pathKey = (env: NodeJS.ProcessEnv) => Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

/** Is a program on PATH (of `env`, default this process)? */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
  const dirs = String(env[pathKey(env)] || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : [''];
  for (const d of dirs) for (const e of exts) if (fs.existsSync(path.join(d, cmd + e))) return true;
  return false;
}

/** The programs that must be found for a system copy to count. */
const NEEDS: Record<ToolchainId, string[]> = { node: ['node', 'npx'], uv: ['uvx'] };

const root = (dataDir: string, id: ToolchainId) => path.join(dataDir, 'runtimes', id === 'node' ? 'node' : 'uv');

interface Marker {
  version: string;
  /** node: the npm package folder; uv: the folder with uv and uvx. */
  dir: string;
  installedAt: string;
}

function marker(dataDir: string, id: ToolchainId): Marker | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root(dataDir, id), 'installed.json'), 'utf8')) as Marker;
    const probe = id === 'node' ? path.join(m.dir, 'bin', 'npx-cli.js') : path.join(m.dir, isWin ? 'uvx.exe' : 'uvx');
    return m?.dir && fs.existsSync(probe) ? m : null;
  } catch {
    return null;
  }
}

/** sh needs these escaped inside double quotes. */
const shq = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;

/**
 * The launchers `node`, `npm` and `npx` for TeamBot's own copy: they start the Node TeamBot runs on (in the desktop app
 * Electron as Node). Rewritten when TeamBot moved (another program folder after an update).
 */
function writeShims(dataDir: string, npmDir: string): string {
  const bin = path.join(root(dataDir, 'node'), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const exe = process.execPath;
  const files: Record<string, string> = {};
  const scripts: Record<string, string | null> = { node: null, npm: path.join(npmDir, 'bin', 'npm-cli.js'), npx: path.join(npmDir, 'bin', 'npx-cli.js') };
  for (const [name, script] of Object.entries(scripts)) {
    if (isWin) files[`${name}.cmd`] = ['@ECHO OFF', 'SET "ELECTRON_RUN_AS_NODE=1"', `"${exe}"${script ? ` "${script}"` : ''} %*`, ''].join('\r\n');
    else files[name] = ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec ${shq(exe)}${script ? ` ${shq(script)}` : ''} "$@"`, ''].join('\n');
  }
  for (const [name, body] of Object.entries(files)) {
    const f = path.join(bin, name);
    let cur = '';
    try {
      cur = fs.readFileSync(f, 'utf8');
    } catch {
      /* new */
    }
    if (cur !== body) fs.writeFileSync(f, body, { mode: 0o755 });
  }
  return bin;
}

function withPath(base: NodeJS.ProcessEnv, dirs: string[], extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string' && k.toUpperCase() !== 'PATH') out[k] = v;
  const key = pathKey(base);
  // One PATH key only: two spellings ("PATH" and "Path") in one environment make Windows pick either.
  out[isWin ? 'PATH' : key] = [...dirs, base[key] || ''].filter(Boolean).join(path.delimiter);
  return { ...out, ...extra };
}

function ownToolchain(dataDir: string, id: ToolchainId, m: Marker): Toolchain {
  const r = root(dataDir, id);
  if (id === 'node') {
    const bin = writeShims(dataDir, m.dir);
    const prefix = path.join(r, 'global');
    // `npm install -g` lands in TeamBot's own folder; its programs are found next to the launchers.
    const globalBin = isWin ? prefix : path.join(prefix, 'bin');
    const dirs = [bin, globalBin];
    const extra = { npm_config_cache: path.join(r, 'cache'), npm_config_prefix: prefix, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
    return { id, source: 'teambot', version: m.version, pathDirs: dirs, env: (base = process.env) => withPath(base, dirs, extra) };
  }
  const dirs = [m.dir];
  const extra = { UV_CACHE_DIR: path.join(r, 'cache'), UV_PYTHON_INSTALL_DIR: path.join(r, 'python'), UV_TOOL_DIR: path.join(r, 'tools'), UV_TOOL_BIN_DIR: path.join(r, 'tools', 'bin') };
  return { id, source: 'teambot', version: m.version, pathDirs: dirs, env: (base = process.env) => withPath(base, dirs, extra) };
}

const systemToolchain = (id: ToolchainId): Toolchain => ({ id, source: 'system', version: null, pathDirs: [], env: (base = process.env) => withPath(base, [], {}) });

/** The toolchain to use now, without downloading: on PATH, else TeamBot's own copy, else null. */
export function find(id: ToolchainId, dataDir: string, env: NodeJS.ProcessEnv = process.env): Toolchain | null {
  if (NEEDS[id].every((c) => onPath(c, env))) return systemToolchain(id);
  const m = marker(dataDir, id);
  return m ? ownToolchain(dataDir, id, m) : null;
}

const jobs = new Map<string, { progress: ToolchainProgress; done: Promise<Toolchain> }>();

/** What the UI shows: where it comes from, the size of the download, and a running download. */
export function status(id: ToolchainId, dataDir: string, opts: { source?: Source | null } = {}) {
  const t = find(id, dataDir);
  const src = opts.source === undefined ? defaultSource(id) : opts.source;
  return { id, source: t?.source ?? null, version: t?.version ?? null, sizeMb: src?.sizeMb ?? null, available: !!src, job: jobs.get(`${dataDir}|${id}`)?.progress ?? null };
}

export class ToolchainError extends Error {}

async function download(src: Source, file: string, report: (p: Partial<ToolchainProgress>) => void, signal?: AbortSignal) {
  const res = await fetch(src.url, { redirect: 'follow', signal: signal ?? AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new ToolchainError(`Downloaden mislukt (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || undefined;
  const [algo, want] = src.integrity.startsWith('sha512-') ? ['sha512', src.integrity.slice(7)] : ['sha256', src.integrity.replace(/^sha256:/, '')];
  const hash = crypto.createHash(algo);
  const out = fs.createWriteStream(file);
  let received = 0;
  let last = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    received += chunk.length;
    if (received > 200 * 1024 ** 2) throw new ToolchainError('De download is groter dan verwacht; TeamBot stopt.');
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (Date.now() - last > 250) {
      last = Date.now();
      report({ phase: 'download', received, total });
    }
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  report({ phase: 'verify', received, total });
  const got = algo === 'sha512' ? hash.digest('base64') : hash.digest('hex');
  if (got !== want) throw new ToolchainError('De download klopt niet met het controlegetal dat TeamBot kent; hij is niet gebruikt.');
}

/** Find the folder in an unpacked archive that holds `name` (uv's tar.gz has one subfolder). */
function folderWith(dir: string, name: string, depth = 2): string | null {
  if (fs.existsSync(path.join(dir, name))) return dir;
  if (depth <= 0) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = folderWith(path.join(dir, e.name), name, depth - 1);
    if (f) return f;
  }
  return null;
}

async function install(id: ToolchainId, dataDir: string, src: Source, report: (p: Partial<ToolchainProgress>) => void, signal?: AbortSignal): Promise<Toolchain> {
  const r = root(dataDir, id);
  fs.mkdirSync(r, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(r, 'tmp-'));
  try {
    const archive = path.join(tmp, id === 'node' ? 'npm.tgz' : path.basename(new URL(src.url).pathname) || 'uv.zip');
    report({ phase: 'download', received: 0 });
    await download(src, archive, report, signal);
    report({ phase: 'extract' });
    const unpacked = path.join(tmp, 'x');
    if (/\.zip$/i.test(archive)) await extractZip(archive, unpacked);
    else await extractNpmTarball(archive, unpacked);
    const want = id === 'node' ? path.join('bin', 'npx-cli.js') : isWin ? 'uvx.exe' : 'uvx';
    const found = folderWith(unpacked, want);
    if (!found) throw new ToolchainError(id === 'node' ? 'In het npm-pakket ontbreekt npx.' : 'In de uv-download ontbreekt uvx.');
    const dest = path.join(r, `${id === 'node' ? 'npm' : 'uv'}-${src.version}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(found, dest);
    if (!isWin && id === 'uv') for (const f of ['uv', 'uvx']) if (fs.existsSync(path.join(dest, f))) fs.chmodSync(path.join(dest, f), 0o755);
    const m: Marker = { version: src.version, dir: dest, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(r, 'installed.json'), JSON.stringify(m, null, 2));
    return ownToolchain(dataDir, id, m);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The toolchain, getting TeamBot's own copy first when it is not there (one download per data folder at a time; a
 * second caller waits for the same one). Throws ToolchainError with a sentence for the user when that fails.
 */
export function ensure(id: ToolchainId, dataDir: string, opts: { onProgress?: (p: ToolchainProgress) => void; source?: Source | null; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<Toolchain> {
  const have = find(id, dataDir, opts.env);
  if (have) return Promise.resolve(have);
  const key = `${dataDir}|${id}`;
  const running = jobs.get(key);
  if (running && !['done', 'error'].includes(running.progress.phase)) {
    if (opts.onProgress) void running.done.then(() => opts.onProgress!({ id, phase: 'done' }), (e) => opts.onProgress!({ id, phase: 'error', error: String(e?.message || e) }));
    return running.done;
  }
  const src = opts.source === undefined ? defaultSource(id) : opts.source;
  if (!src) return Promise.reject(new ToolchainError(id === 'uv' ? `TeamBot heeft geen uv voor dit systeem (${plat()}). Installeer uv zelf: https://docs.astral.sh/uv/` : 'TeamBot heeft geen npm voor dit systeem.'));
  const job = { progress: { id, phase: 'download' } as ToolchainProgress, done: null as unknown as Promise<Toolchain> };
  const report = (p: Partial<ToolchainProgress>) => {
    job.progress = { id, phase: job.progress.phase, ...p } as ToolchainProgress;
    try {
      opts.onProgress?.(job.progress);
    } catch {
      /* a listener's problem is not the download's */
    }
  };
  job.done = install(id, dataDir, src, report, opts.signal).then(
    (t) => (report({ phase: 'done' }), t),
    (e) => {
      const msg = e instanceof ToolchainError ? e.message : `${id === 'node' ? 'npm' : 'uv'} ophalen mislukt: ${String(e?.message || e).slice(0, 300)}`;
      report({ phase: 'error', error: msg });
      throw e instanceof ToolchainError ? e : new ToolchainError(msg);
    },
  );
  jobs.set(key, job);
  return job.done;
}
