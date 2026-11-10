import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import AdmZip from 'adm-zip';
import type { Log } from '../util.js';
import { EXPORT_README, ProvisionError, type InstanceInfo, type InstanceSpec, type Provisioner } from './types.js';

/**
 * Development/test provisioner: runs the built TeamBot server (`node dist/server/main.js --mode server`) as a child
 * process on a free 127.0.0.1 port with its own data folder and HOME. Not an isolation boundary (same OS user) —
 * production uses the docker provisioner.
 */
export interface ProcessInfo extends InstanceInfo {
  kind: 'process';
  dir: string;
  dataDir: string;
  port?: number;
  pid?: number;
}

/**
 * Environment for the child: an allowlist, never the control plane's own environment (which holds STRIPE_*,
 * DATABASE_URL and CLOUD_SECRET_KEY). HOME points into the instance folder so a developer's own CLI logins and
 * config never leak into a customer instance.
 */
export function processEnv(spec: InstanceSpec, info: ProcessInfo, base: NodeJS.ProcessEnv = process.env, uiDir: string | null = null): Record<string, string> {
  const home = path.join(info.dir, 'home');
  const env: Record<string, string> = {
    TEAMBOT_MODE: 'server',
    TEAMBOT_MASTER_KEY: spec.masterKey,
    TEAMBOT_SETUP_TOKEN: spec.setupToken,
    TEAMBOT_MAX_USERS: String(spec.plan.seats || 0),
    TEAMBOT_PUBLIC_URL: spec.publicUrl,
    TEAMBOT_TRUST_PROXY: 'loopback',
    TEAMBOT_ALLOW_SIGNUP: '0',
    NODE_ENV: 'production',
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  };
  if (uiDir) env.TEAMBOT_UI_DIR = uiDir;
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TZ', 'WINDIR']) {
    if (base[k]) env[k] = base[k] as string;
  }
  return env;
}

export class ProcessProvisioner implements Provisioner {
  readonly kind = 'process' as const;
  private children = new Map<string, ChildProcess>();

  constructor(private opts: { rootDir: string; entry: string; nodeBin?: string; startTimeoutMs?: number; uiDir?: string | null; log?: Log }) {
    fs.mkdirSync(opts.rootDir, { recursive: true });
  }

  private dirFor(workspaceId: string) {
    if (!/^[a-z0-9_]+$/i.test(workspaceId)) throw new ProvisionError('Ongeldige workspace-id');
    return path.join(this.opts.rootDir, workspaceId);
  }

  async create(spec: InstanceSpec): Promise<ProcessInfo> {
    const dir = this.dirFor(spec.workspaceId);
    const dataDir = path.join(dir, 'data');
    for (const d of [dataDir, path.join(dir, 'home', 'AppData', 'Roaming'), path.join(dir, 'home', 'AppData', 'Local')]) fs.mkdirSync(d, { recursive: true });
    return { kind: 'process', dir, dataDir };
  }

  async start(raw: InstanceInfo, spec: InstanceSpec): Promise<ProcessInfo> {
    const info = raw as ProcessInfo;
    const existing = this.children.get(spec.workspaceId);
    if (existing && existing.exitCode === null && info.port && (await this.health(info))) return info;
    if (!fs.existsSync(this.opts.entry)) throw new ProvisionError('De TeamBot-server is nog niet gebouwd. Draai eerst "npm run build".');
    if (!existing && info.pid && info.port && (await this.ping(info.port))) {
      // A previous control plane died and left this instance running (POSIX keeps orphans alive). Stop it first:
      // two servers must never share one data folder.
      try {
        process.kill(info.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      for (let i = 0; i < 100 && (await this.ping(info.port)); i++) await new Promise((r) => setTimeout(r, 100));
    }
    fs.mkdirSync(info.dataDir, { recursive: true });
    const child = spawn(this.opts.nodeBin || process.execPath, [this.opts.entry, '--mode', 'server', '--host', '127.0.0.1', '--port', '0', '--data', info.dataDir], {
      cwd: info.dir,
      env: processEnv(spec, info, process.env, this.opts.uiDir ?? null),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.children.set(spec.workspaceId, child);
    child.stderr!.resume();
    child.on('exit', () => {
      if (this.children.get(spec.workspaceId) === child) this.children.delete(spec.workspaceId);
    });
    const timeout = this.opts.startTimeoutMs ?? 30_000;
    const port = await new Promise<number>((resolve, reject) => {
      let out = '';
      const done = (fn: () => void) => {
        clearTimeout(timer);
        child.stdout!.off('data', onData);
        child.off('exit', onExit);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill();
        done(() => reject(new ProvisionError('De TeamBot-server startte niet op tijd.')));
      }, timeout);
      const onData = (d: Buffer) => {
        out = (out + d).slice(-8192);
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m) done(() => resolve(Number(m[1])));
      };
      const onExit = (code: number | null) => {
        this.opts.log?.warn(`instantie ${spec.slug} stopte bij het starten (code ${code})`);
        done(() => reject(new ProvisionError('De TeamBot-server stopte direct na het starten.')));
      };
      child.stdout!.on('data', onData);
      child.on('exit', onExit);
    });
    // Keep draining output (the instance writes its own log file) so the child never blocks on a full pipe.
    child.stdout!.resume();
    child.stderr!.resume();
    const next: ProcessInfo = { ...info, port, pid: child.pid };
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.health(next)) return next;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.stop(next);
    throw new ProvisionError('De TeamBot-server reageert niet.');
  }

  async stop(raw: InstanceInfo): Promise<void> {
    const info = raw as ProcessInfo;
    const id = path.basename(info.dir);
    const child = this.children.get(id);
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => {
          clearTimeout(hard);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    this.children.delete(id);
  }

  async remove(raw: InstanceInfo): Promise<void> {
    const info = raw as ProcessInfo;
    await this.stop(info);
    if (info.dir && path.resolve(info.dir).startsWith(path.resolve(this.opts.rootDir) + path.sep)) {
      fs.rmSync(info.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }

  running(raw: InstanceInfo): boolean {
    const child = this.children.get(path.basename((raw as ProcessInfo).dir || ''));
    return !!child && child.exitCode === null && child.signalCode === null;
  }

  private async ping(port: number): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
      const j: any = await r.json().catch(() => ({}));
      return r.ok && j?.ok === true;
    } catch {
      return false;
    }
  }

  async health(raw: InstanceInfo): Promise<boolean> {
    const info = raw as ProcessInfo;
    return !!info.port && this.running(info) && (await this.ping(info.port));
  }

  upstream(raw: InstanceInfo) {
    const info = raw as ProcessInfo;
    return info.port && this.running(info) ? { host: '127.0.0.1', port: info.port } : null;
  }

  async exportData(raw: InstanceInfo, spec: InstanceSpec, outFile: string): Promise<void> {
    const info = raw as ProcessInfo;
    const dbFile = path.join(info.dataDir, 'teambot.db');
    if (!fs.existsSync(dbFile)) throw new ProvisionError('Er is nog geen TeamBot-database om te exporteren.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbc-export-'));
    try {
      // Consistent snapshot while the instance may be running (WAL): VACUUM INTO from a read-only connection.
      const snap = path.join(tmp, 'teambot.db');
      const vacuum = (readOnly: boolean) => {
        const db = new DatabaseSync(dbFile, { readOnly });
        try {
          db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
        } finally {
          db.close();
        }
      };
      try {
        vacuum(true);
      } catch (e) {
        // A read-only connection cannot recover the WAL of an instance that was killed; when the instance is
        // stopped nobody else writes, so a normal connection is safe.
        if (this.running(info)) throw e;
        fs.rmSync(snap, { force: true });
        vacuum(false);
      }
      const zip = new AdmZip();
      zip.addLocalFile(snap);
      for (const d of ['attachments', 'workspaces', 'skills']) {
        const p = path.join(info.dataDir, d);
        if (fs.existsSync(p)) zip.addLocalFolder(p, d, (name) => !fs.lstatSync(path.join(p, name)).isSymbolicLink());
      }
      zip.addFile('master.key', Buffer.from(spec.masterKey));
      zip.addFile('LEESMIJ.txt', Buffer.from(EXPORT_README(spec.slug, new Date().toISOString().slice(0, 10))));
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      await zip.writeZipPromise(outFile);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async usageBytes(raw: InstanceInfo): Promise<number | null> {
    const info = raw as ProcessInfo;
    let total = 0;
    const walk = (d: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          try {
            total += fs.statSync(p).size;
          } catch {
            /* vanished */
          }
        }
      }
    };
    walk(info.dataDir);
    return total;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.children.keys()].map((id) => this.stop({ kind: 'process', dir: path.join(this.opts.rootDir, id), dataDir: '' })));
  }
}
