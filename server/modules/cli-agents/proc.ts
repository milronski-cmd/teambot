import { isFile } from '../../core/util.js';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeEnv } from '../../tools/builtin/shell.js';
import { redact } from '../../core/secrets.js';
import { jobs } from './jobs.js';

const isWin = process.platform === 'win32';

/** Directories where official installers commonly put CLI binaries (the server's PATH may be shorter than a shell's). */
export function systemBinDirs(): string[] {
  const home = os.homedir();
  const dirs = [path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.opencode', 'bin'), path.join(home, '.cargo', 'bin')];
  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    dirs.push(path.join(appData, 'npm'), path.join(local, 'Microsoft', 'WinGet', 'Links'), path.join(local, 'Programs'), path.join(home, 'scoop', 'shims'), path.join(local, 'pnpm'));
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', path.join(home, '.volta', 'bin'));
  }
  return dirs;
}

/**
 * Official CLI binaries that other apps keep in their own versioned folders (newest first): the Codex desktop app
 * and OpenBot's provider runtimes. Only used when neither TeamBot's own copy nor a system install exists, and then
 * named in the UI ("uit een andere app"), because that app may update or remove them at any time.
 */
export function otherAppBinDirs(): { dir: string; app: string }[] {
  if (!isWin) return [];
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const versioned = (parent: string, app: string, sub = '') => {
    try {
      return fs.readdirSync(parent).map((d) => ({ dir: path.join(parent, d, sub), app }));
    } catch {
      return [];
    }
  };
  const list = [
    ...versioned(path.join(local, 'OpenAI', 'Codex', 'bin'), 'de Codex-app'),
    ...versioned(path.join(appData, 'OpenBot', 'provider-runtimes', 'codex', `win32-${process.arch}`), 'OpenBot', 'bin'),
    ...versioned(path.join(appData, 'OpenBot', 'provider-runtimes', 'opencode', `win32-${process.arch}`), 'OpenBot', 'bin'),
  ].filter((d) => {
    try {
      return fs.statSync(d.dir).isDirectory();
    } catch {
      return false;
    }
  });
  return list.sort((a, b) => fs.statSync(b.dir).mtimeMs - fs.statSync(a.dir).mtimeMs);
}

/** All folders searched for CLIs: system folders first, other apps' folders last. */
export function commonBinDirs(): string[] {
  return [...systemBinDirs(), ...otherAppBinDirs().map((d) => d.dir)];
}

/** Like findBinary, and says whether the hit is in another app's folder (and which app). */
export function findBinarySource(names: string[]): { path: string; app?: string } | null {
  const sys = findBinary(names, [], { otherApps: false });
  if (sys) return { path: sys };
  for (const d of otherAppBinDirs()) {
    const p = findIn([d.dir], names);
    if (p) return { path: p, app: d.app };
  }
  return null;
}

/** Extra environment per binary (TeamBot's own CLI copies: auto-updates off, bundled helpers on PATH). */
const BIN_ENV = new Map<string, Record<string, string>>();
export function setBinEnv(bin: string, env: Record<string, string> | null) {
  if (env) BIN_ENV.set(path.resolve(bin), env);
  else BIN_ENV.delete(path.resolve(bin));
}
const binEnv = (bin: string) => BIN_ENV.get(path.resolve(bin)) || {};


/** Search PATH (+ common install dirs + extra dirs) for the first matching executable name. */
export function findBinary(names: string[], extraDirs: string[] = [], o: { otherApps?: boolean } = {}): string | null {
  const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const dirs = [...new Set([...pathDirs, ...extraDirs, ...(o.otherApps === false ? systemBinDirs() : commonBinDirs())])];
  return findIn(dirs, names);
}

function findIn(dirs: string[], names: string[]): string | null {
  const exts = isWin ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  for (const name of names) {
    for (const d of dirs) {
      for (const ext of exts) {
        const p = path.join(d, name + (name.includes('.') && ext === '' ? '' : ext));
        if (isFile(p)) return p;
      }
    }
  }
  return null;
}

export interface Launch {
  command: string;
  args: string[];
  verbatim?: boolean;
}

const SCRIPT_EXT = /\.(m?js|cjs)$/i;

/** Node executable usable for helper scripts (Electron needs ELECTRON_RUN_AS_NODE). */
export function nodeRuntime(): { command: string; env: Record<string, string> } {
  return { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

/** Quote one argument for cmd.exe. Refuses characters cmd.exe would interpret (no injection possible). */
export function cmdQuote(a: string): string {
  if (/["%!^&|<>\r\n]/.test(a)) throw new Error(`Argument bevat tekens die niet veilig via cmd.exe kunnen: ${a.slice(0, 40)}`);
  return /[\s()]/.test(a) || a === '' ? `"${a}"` : a;
}

/**
 * Turn a binary path into something we can spawn without a shell:
 *  - .js/.mjs → run with node
 *  - npm cmd-shim (.cmd) → run its target script/exe directly
 *  - other .cmd/.bat → cmd.exe with strictly quoted args (last resort)
 */
export function resolveLaunch(bin: string, args: string[]): Launch {
  if (SCRIPT_EXT.test(bin)) {
    const n = nodeRuntime();
    return { command: n.command, args: [bin, ...args] };
  }
  if (isWin && /\.(cmd|bat)$/i.test(bin)) {
    try {
      const src = fs.readFileSync(bin, 'utf8');
      const m = src.match(/"%(?:~?dp0%?)\\([^"]+?\.(?:m?js|cjs|exe))"/i) || src.match(/"%dp0%\\([^"]+?\.(?:m?js|cjs|exe))"/i);
      if (m) {
        const target = path.resolve(path.dirname(bin), m[1]);
        if (isFile(target)) {
          if (/\.exe$/i.test(target)) return { command: target, args };
          const localNode = path.join(path.dirname(bin), 'node.exe');
          return { command: isFile(localNode) ? localNode : nodeRuntime().command, args: [target, ...args] };
        }
      }
    } catch {
      /* fall through */
    }
    const line = [cmdQuote(bin), ...args.map(cmdQuote)].join(' ');
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { command: bin, args };
}

/**
 * Kill a process and all its children. Windows: `taskkill /T /F` while the process still runs (the Job Object in
 * startProc also ends children whose parent is already gone). Elsewhere the CLI has its own process group
 * (`detached`): the whole group gets the signal, also when the first process already exited and left children behind
 * (a process group id is never reused while one of its members still runs).
 */
export function killTree(child: ChildProcess) {
  if (!child.pid) return;
  const alive = child.exitCode === null && child.signalCode === null;
  try {
    // taskkill from System32 itself (the server's PATH can be short); a failing start never crashes the server.
    if (isWin) {
      if (alive) spawn(path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        if (alive) child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* gone */
        }
      }, 2000).unref();
    }
  } catch {
    /* ignore */
  }
}

let jobSeq = 0;

export interface ProcOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  /** Hard limit for the whole run. */
  timeoutMs: number;
  /** Kill when there is no output for this long (paused while waiting for a human). */
  idleMs: number;
  onLine(line: string): void;
  onStderr?(text: string): void;
  /** On abort, give the CLI this long to stop gracefully (after the adapter sent its cancel message) before killing the tree. */
  graceMs?: number;
  /**
   * Windows: put the process in its own Job Object, so a stop also ends what it started after that process is gone
   * (default on). Off for a login, which may open the owner's own browser.
   */
  job?: boolean;
}

export interface Proc {
  child: ChildProcess;
  write(s: string): void;
  end(): void;
  /** Pause/resume the idle timer (e.g. while waiting for an approval). */
  hold(on: boolean): void;
  stderrTail(): string;
  kill(reason: string): void;
  killedReason: string | null;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>;
  /** Windows Job Object of this process (null off Windows or when switched off). */
  jobKey: string | null;
  /** Resolves once every process of a stopped CLI is gone (Windows: the job is empty or ended). */
  stopped: Promise<void>;
}

const MAX_LINE = 32 * 1024 * 1024;
const dur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** Spawn a CLI with a cleaned environment, line-based stdout, stderr tail, timeouts and abort → kill tree. */
export function startProc(o: ProcOptions): Proc {
  const launch = resolveLaunch(o.bin, o.args);
  const child = spawn(launch.command, launch.args, {
    cwd: o.cwd,
    env: safeEnv({ ...binEnv(o.bin), ...(o.env || {}) }),
    windowsHide: true,
    windowsVerbatimArguments: launch.verbatim,
    detached: !isWin,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let errTail = '';
  let held = false;
  let lastOut = Date.now();
  // Windows: its own Job Object, so stopping ends every process it started, also orphans (jobs.ts).
  const jobKey = isWin && o.job !== false && child.pid ? `p${child.pid}_${++jobSeq}` : null;
  if (jobKey) void jobs.add(jobKey, child.pid!);
  const p: Proc = {
    child,
    jobKey,
    stopped: Promise.resolve(),
    killedReason: null,
    write(s) {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(s);
    },
    end() {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
    },
    hold(on) {
      held = on;
      lastOut = Date.now();
    },
    stderrTail: () => redact(errTail.trim()).slice(-1500),
    kill(reason) {
      if (!p.killedReason) p.killedReason = reason;
      killTree(child);
      if (jobKey) p.stopped = jobs.close(jobKey).then(() => undefined);
    },
    done: null as any,
  };
  child.stdin?.on('error', () => {
    /* EPIPE when the CLI exits early */
  });
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (s: string) => {
    lastOut = Date.now();
    buf += s;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) {
        try {
          o.onLine(line);
        } catch {
          /* parser errors must not kill the stream */
        }
      }
    }
    if (buf.length > MAX_LINE) buf = '';
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (s: string) => {
    lastOut = Date.now();
    errTail = (errTail + s).slice(-8000);
    o.onStderr?.(s);
  });
  const onAbort = () => {
    if (!o.graceMs) return p.kill('Gestopt');
    setTimeout(() => p.kill('Gestopt'), o.graceMs).unref();
  };
  if (o.signal.aborted) queueMicrotask(onAbort);
  else o.signal.addEventListener('abort', onAbort, { once: true });
  const hard = setTimeout(() => p.kill(`Time-out: de CLI liep langer dan ${dur(o.timeoutMs)} en is gestopt`), o.timeoutMs);
  const idle = setInterval(() => {
    if (!held && Date.now() - lastOut > o.idleMs) p.kill(`Time-out: de CLI gaf ${dur(o.idleMs)} geen uitvoer en is gestopt`);
  }, Math.min(5000, Math.max(200, Math.floor(o.idleMs / 4))));
  p.done = new Promise((resolve) => {
    let settled = false;
    const fin = (r: { code: number | null; signal: NodeJS.Signals | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      clearInterval(idle);
      o.signal.removeEventListener('abort', onAbort);
      // Stopped (or stopping): what it left running goes too — e.g. an ACP agent that ended itself on "cancel" while
      // a command it started still runs. Ended by itself: unchanged, its job is only released.
      if (p.killedReason || o.signal.aborted) {
        if (!isWin) killTree(child);
        else if (jobKey) p.stopped = jobs.close(jobKey).then(() => undefined);
      } else if (jobKey) void jobs.release(jobKey);
      if (buf.trim()) {
        try {
          o.onLine(buf.replace(/\r$/, ''));
        } catch {
          /* ignore */
        }
        buf = '';
      }
      resolve(r);
    };
    child.on('error', (e: any) => fin({ code: -1, signal: null, error: e?.code === 'ENOENT' ? 'Programma niet gevonden' : String(e?.message || e) }));
    child.on('close', (code, signal) => fin({ code, signal }));
  });
  return p;
}

/** Run a short command (e.g. --version) and capture output. Never interactive: stdin is closed. */
export function runQuick(
  bin: string,
  args: string[],
  /** stopOn: ends the command early when its stderr so far says it will not finish (e.g. a CLI that keeps retrying). */
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string>; stopOn?: (stderr: string) => boolean } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let launch: Launch;
    try {
      launch = resolveLaunch(bin, args);
    } catch (e: any) {
      return resolve({ code: -1, stdout: '', stderr: '', error: e.message });
    }
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: opts.cwd || os.tmpdir(),
        env: safeEnv({ NO_COLOR: '1', ...binEnv(bin), ...(opts.env || {}) }),
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        detached: !isWin,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      return resolve({ code: -1, stdout: '', stderr: '', error: e.message });
    }
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (b) => (stdout = (stdout + b).slice(-200_000)));
    let stopped = false;
    child.stderr!.on('data', (b) => {
      stderr = (stderr + b).slice(-20_000);
      if (!stopped && opts.stopOn?.(stderr)) {
        stopped = true;
        killTree(child);
      }
    });
    const t = setTimeout(() => killTree(child), opts.timeoutMs ?? 8000);
    child.on('error', (e: any) => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr, error: e?.message || String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Private per-run temp directory (system prompt files, MCP config). Removed after the run. */
export function runTempDir(baseDir: string, runId: string): { dir: string; cleanup(): void } {
  const dir = path.join(baseDir, 'cli-agents', 'runs', runId.replace(/[^\w-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Parse a version number like "2.1.3" out of arbitrary --version output. */
export function parseVersion(s: string): string | undefined {
  return s.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0];
}
