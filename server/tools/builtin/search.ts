import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { safeEnv } from './shell.js';

/**
 * search_files without holding up the server: ripgrep (MIT/Unlicense, the binary from @vscode/ripgrep, MIT) in its own
 * process. Its regex engine runs in linear time (a bot's pattern cannot hang it), it skips binary files and what
 * .gitignore leaves out, and it never follows a symlink out of the folder. A time limit and a limit on hits stop it
 * early; what was found until then is returned with an honest note.
 *
 * Without the binary (an unusual build) the old walk runs in a worker thread with the same limits, so a slow folder
 * or a catastrophic regex can be stopped there too.
 */

export const MAX_HITS = 200;
const MAX_FILE = 2_000_000;
const TIMEOUT_MS = 15_000;
const SKIP_DIRS = ['node_modules', '.git', '.venv', '__pycache__', 'dist', '.next', '.cache'];
/** Never in results (the same protection as reading): keys and secrets. */
const SECRET_GLOBS = ['.env', '.env.*', '.ssh', '.gnupg', '.aws', 'master.key', 'local-token'];

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}
export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  timedOut: boolean;
  engine: 'ripgrep' | 'js';
  error?: string;
}

const req = createRequire(import.meta.url);
let rgCache: string | null | undefined;
/** The ripgrep binary for this platform, unpacked next to app.asar in the Windows app; null when not there. */
export function ripgrepPath(): string | null {
  if (rgCache !== undefined) return rgCache;
  try {
    const p = req.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    rgCache = fs.existsSync(p) ? p : null;
  } catch {
    rgCache = null;
  }
  return rgCache;
}

/** Tests: force the fallback (null) or another binary. */
export function setRipgrepForTests(p: string | null | undefined) {
  rgCache = p;
}

export interface SearchOptions {
  root: string;
  query: string;
  regex?: boolean;
  /** File name pattern, e.g. "*.ts" (matched on the name, case-insensitive). */
  glob?: string;
  max?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function searchFiles(o: SearchOptions): Promise<SearchResult> {
  const rg = ripgrepPath();
  return rg ? searchRipgrep(rg, o) : searchWorker(o);
}

function searchRipgrep(rg: string, o: SearchOptions): Promise<SearchResult> {
  const max = o.max ?? MAX_HITS;
  const args = [
    '--no-config',
    '--line-number',
    '--with-filename',
    '--no-heading',
    '--null',
    '--color',
    'never',
    '--ignore-case',
    '--max-filesize',
    String(MAX_FILE),
    '--max-columns',
    '400',
    '--max-columns-preview',
    '--max-count',
    String(max),
    '--regex-size-limit',
    '10M',
    '--dfa-size-limit',
    '10M',
    ...(o.regex ? [] : ['--fixed-strings']),
    ...SKIP_DIRS.flatMap((d) => ['--glob', `!${d}`]),
    ...SECRET_GLOBS.flatMap((g) => ['--glob', `!${g}`]),
    ...(o.glob ? ['--iglob', String(o.glob)] : []),
    '-e',
    o.query,
    '--',
    '.',
  ];
  return new Promise((resolve) => {
    const hits: SearchHit[] = [];
    let truncated = false;
    let timedOut = false;
    let err = '';
    let buf = '';
    let done = false;
    const child = spawn(rg, args, { cwd: o.root, env: safeEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => ((timedOut = true), stop()), o.timeoutMs ?? TIMEOUT_MS);
    const onAbort = () => stop();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const line = (l: string) => {
      const z = l.indexOf('\0');
      if (z < 0) return;
      const m = /^(\d+):(.*)$/s.exec(l.slice(z + 1));
      if (!m) return;
      if (hits.length >= max) {
        truncated = true;
        stop();
        return;
      }
      hits.push({ file: path.join(o.root, l.slice(0, z)), line: Number(m[1]), text: m[2] });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (err.length < 4000 ? (err += d) : null));
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (buf) line(buf);
      // Exit 2 = an error; with a bad pattern there are no hits and the message says why.
      const bad = code === 2 && !hits.length && /regex parse error|error parsing|regex/i.test(err) ? err.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined;
      resolve({ hits, truncated, timedOut, engine: 'ripgrep', error: bad });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

/** The walk of before, in a worker thread: stopped (terminated) at the time limit, whatever the regex does. */
const WORKER_SOURCE = `
const { parentPort, workerData: o } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const skip = new Set(o.skipDirs);
const secret = /(^|[\\\\/])(\\.env(\\..*)?|\\.ssh|\\.gnupg|\\.aws|master\\.key|local-token)$/i;
const re = o.regex ? new RegExp(o.query, 'i') : null;
const q = String(o.query).toLowerCase();
const globRe = o.glob ? new RegExp('^' + String(o.glob).replace(/[.+^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*').replace(/\\?/g, '.') + '$', 'i') : null;
const hits = [];
let truncated = false;
const walk = (d) => {
  let entries = [];
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (hits.length >= o.max) { truncated = true; return; }
    if (skip.has(e.name) || secret.test(e.name)) continue;
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && (!globRe || globRe.test(e.name))) {
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (!st || st.size > ${MAX_FILE}) continue;
      const buf = fs.readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString('utf8').split(/\\r?\\n/);
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= o.max) { truncated = true; break; }
        if (re ? re.test(lines[i]) : lines[i].toLowerCase().includes(q)) hits.push({ file: full, line: i + 1, text: lines[i].slice(0, 400) });
      }
    }
  }
};
walk(o.root);
parentPort.postMessage({ hits, truncated });
`;

function searchWorker(o: SearchOptions): Promise<SearchResult> {
  const max = o.max ?? MAX_HITS;
  if (o.regex) {
    try {
      new RegExp(o.query, 'i');
    } catch (e: any) {
      return Promise.resolve({ hits: [], truncated: false, timedOut: false, engine: 'js', error: String(e?.message || e).slice(0, 300) });
    }
  }
  return new Promise((resolve) => {
    let done = false;
    const w = new Worker(WORKER_SOURCE, { eval: true, name: 'teambot-search', workerData: { root: o.root, query: o.query, regex: !!o.regex, glob: o.glob || '', max, skipDirs: SKIP_DIRS } });
    const finish = (r: SearchResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      void w.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ hits: [], truncated: false, timedOut: true, engine: 'js' }), o.timeoutMs ?? TIMEOUT_MS);
    const onAbort = () => finish({ hits: [], truncated: false, timedOut: false, engine: 'js' });
    o.signal?.addEventListener('abort', onAbort, { once: true });
    w.on('message', (m: any) => finish({ hits: m.hits, truncated: m.truncated, timedOut: false, engine: 'js' }));
    w.on('error', (e: any) => finish({ hits: [], truncated: false, timedOut: false, engine: 'js', error: String(e?.message || e).slice(0, 300) }));
  });
}
