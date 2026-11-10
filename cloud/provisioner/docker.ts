import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { Plan } from '../billing/plans.js';
import type { Log } from '../util.js';
import { EXPORT_README, ProvisionError, type InstanceInfo, type InstanceSpec, type Provisioner } from './types.js';

/**
 * Production provisioner: one hardened container per workspace, driven through the docker CLI.
 *
 * - Own named volume (`/data`) and own bridge network per workspace. Only the router (CLOUD_DOCKER_SELF) is attached
 *   to every workspace network, so instances cannot reach each other; they keep normal egress for AI providers.
 * - `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root user, `--read-only` root with tmpfs, and
 *   memory/cpu/pids limits from the plan.
 * - TEAMBOT_MASTER_KEY is passed through the docker CLI's environment (`-e NAME` without a value), never on argv.
 * - Fails closed: when Docker is missing or unhealthy, nothing is started and the workspace is not marked active.
 */
export interface DockerInfo extends InstanceInfo {
  kind: 'docker';
  container: string;
  volume: string;
  network: string;
}

export type DockerRun = (args: string[], opts?: { env?: Record<string, string>; stdoutFile?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

const PORT = 4747;

/** Spawn the docker CLI with a minimal environment (no control-plane secrets). */
export function defaultDockerRun(bin: string): DockerRun {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const env: Record<string, string> = {};
      for (const k of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_CONTEXT', 'TEMP', 'TMP']) {
        if (process.env[k]) env[k] = process.env[k] as string;
      }
      const child = spawn(bin, args, { env: { ...env, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      if (opts.stdoutFile) child.stdout.pipe(fs.createWriteStream(opts.stdoutFile));
      else child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-65536)));
      child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-8192)));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

export function dockerNames(workspaceId: string) {
  if (!/^[a-z0-9_]{4,64}$/.test(workspaceId)) throw new ProvisionError('Ongeldige workspace-id');
  const base = `tbws-${workspaceId.replace(/_/g, '-')}`;
  return { container: base, volume: `${base}-data`, network: `${base}-net` };
}

const REQUIRED_FLAGS = [['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--pids-limit'], ['--memory'], ['--cpus'], ['--user']];

/** Arguments for `docker run`. Pure, so the hardening is unit-tested. */
export function dockerRunArgs(spec: InstanceSpec, names: ReturnType<typeof dockerNames>, opts: { image: string; readOnly: boolean }): string[] {
  const p = spec.plan;
  for (const [k, v] of [['memoryMb', p.memoryMb], ['cpus', p.cpus], ['pids', p.pids]] as const) {
    if (!Number.isFinite(v) || v <= 0) throw new ProvisionError(`Ongeldige limiet in abonnement ${p.id}: ${k}`);
  }
  if (!/^[a-z0-9][a-z0-9._\/:@-]{0,200}$/i.test(opts.image)) throw new ProvisionError('Ongeldige image-naam');
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(spec.publicUrl)) throw new ProvisionError('Ongeldig publiek adres');
  const args = [
    'run', '-d',
    '--name', names.container,
    '--network', names.network,
    '--restart', 'unless-stopped',
    '--memory', `${Math.round(p.memoryMb)}m`,
    '--memory-swap', `${Math.round(p.memoryMb)}m`,
    '--cpus', String(p.cpus),
    '--pids-limit', String(Math.round(p.pids)),
    ...(opts.readOnly ? ['--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--tmpfs', '/home/node:rw,nosuid,nodev,size=64m'] : []),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', 'node',
    '--log-opt', 'max-size=10m',
    '--log-opt', 'max-file=3',
    '--label', 'teambot.cloud=1',
    '--label', `teambot.cloud.workspace=${spec.workspaceId}`,
    '-v', `${names.volume}:/data`,
    '-e', 'TEAMBOT_MASTER_KEY',
    '-e', 'TEAMBOT_SETUP_TOKEN',
    '-e', `TEAMBOT_MAX_USERS=${spec.plan.seats || 0}`,
    '-e', 'TEAMBOT_MODE=server',
    '-e', 'TEAMBOT_DATA=/data',
    '-e', 'TEAMBOT_HOST=0.0.0.0',
    '-e', `TEAMBOT_PORT=${PORT}`,
    '-e', `TEAMBOT_PUBLIC_URL=${spec.publicUrl}`,
    '-e', 'TEAMBOT_TRUST_PROXY=loopback,uniquelocal',
    '-e', 'TEAMBOT_ALLOW_SIGNUP=0',
    opts.image,
  ];
  assertHardened(args, spec.masterKey);
  return args;
}

/** Fail closed if a hardening flag went missing or a secret ended up on the command line. */
export function assertHardened(args: string[], secret: string) {
  for (const [flag, value] of REQUIRED_FLAGS) {
    const i = args.indexOf(flag);
    if (i < 0 || (value && args[i + 1] !== value)) throw new ProvisionError(`Containerbeveiliging ontbreekt (${flag}); niets gestart.`);
  }
  if (args.some((a) => a.includes(secret))) throw new ProvisionError('Geheime sleutel op de opdrachtregel; niets gestart.');
}

export class DockerProvisioner implements Provisioner {
  readonly kind = 'docker' as const;
  private run: DockerRun;
  private checked = 0;

  constructor(private opts: { bin?: string; image: string; self: string | null; readOnly?: boolean; startTimeoutMs?: number; run?: DockerRun; fetchImpl?: typeof fetch; log?: Log }) {
    this.run = opts.run || defaultDockerRun(opts.bin || 'docker');
  }

  /** Verify the docker CLI and daemon are usable (cached for a minute). */
  private async ensureDocker() {
    if (Date.now() - this.checked < 60_000) return;
    let r;
    try {
      r = await this.run(['version', '--format', '{{.Server.Version}}']);
    } catch (e: any) {
      throw new ProvisionError(e?.code === 'ENOENT' ? 'Docker is niet beschikbaar op deze host (docker niet gevonden).' : 'Docker kon niet worden gestart.');
    }
    if (r.code !== 0 || !r.stdout.trim()) throw new ProvisionError('De Docker-daemon is niet bereikbaar.');
    if (!this.opts.self) throw new ProvisionError('CLOUD_DOCKER_SELF ontbreekt: de router moet als container op de workspace-netwerken kunnen.');
    this.checked = Date.now();
  }

  private async must(args: string[], what: string, opts?: Parameters<DockerRun>[1], okIf?: RegExp) {
    const r = await this.run(args, opts);
    if (r.code !== 0 && !(okIf && okIf.test(r.stderr))) {
      this.opts.log?.error(`docker ${args[0]} ${args[1] || ''} mislukte: ${r.stderr.trim().slice(0, 300)}`);
      throw new ProvisionError(what);
    }
    return r;
  }

  async create(spec: InstanceSpec): Promise<DockerInfo> {
    await this.ensureDocker();
    const n = dockerNames(spec.workspaceId);
    const label = ['--label', 'teambot.cloud=1', '--label', `teambot.cloud.workspace=${spec.workspaceId}`];
    await this.must(['network', 'create', '--driver', 'bridge', ...label, n.network], 'Netwerk aanmaken mislukte.', undefined, /already exists/i);
    await this.must(['network', 'connect', n.network, this.opts.self!], 'Router koppelen aan het netwerk mislukte.', undefined, /already exists|already attached/i);
    await this.must(['volume', 'create', ...label, n.volume], 'Opslag aanmaken mislukte.');
    return { kind: 'docker', ...n };
  }

  private async inspect(container: string): Promise<{ state: 'running' | 'stopped' | 'missing'; image: string }> {
    const r = await this.run(['container', 'inspect', '--format', '{{.State.Running}} {{.Config.Image}}', container]);
    if (r.code !== 0) return { state: 'missing', image: '' };
    const [running, image = ''] = r.stdout.trim().split(/\s+/);
    return { state: running === 'true' ? 'running' : 'stopped', image };
  }

  private async state(container: string) {
    return (await this.inspect(container)).state;
  }

  async start(raw: InstanceInfo, spec: InstanceSpec): Promise<DockerInfo> {
    await this.ensureDocker();
    const info = raw as DockerInfo;
    const n = dockerNames(spec.workspaceId);
    const args = dockerRunArgs(spec, n, { image: this.opts.image, readOnly: this.opts.readOnly !== false });
    let { state: st, image } = await this.inspect(n.container);
    if (st !== 'missing' && image !== this.opts.image) {
      // Upgrade: CLOUD_DOCKER_IMAGE changed. Recreate the container on the new image; the volume (all data) stays.
      await this.must(['rm', '-f', n.container], 'Oude container verwijderen mislukte.', undefined, /No such container/i);
      st = 'missing';
    }
    if (st === 'missing') await this.must(args, 'Container starten mislukte.', { env: { TEAMBOT_MASTER_KEY: spec.masterKey, TEAMBOT_SETUP_TOKEN: spec.setupToken } });
    else {
      await this.applyLimits(info, spec.plan);
      if (st === 'stopped') await this.must(['start', n.container], 'Container starten mislukte.');
    }
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      if (await this.health(info)) return { ...info, ...n };
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop(info);
    throw new ProvisionError('De TeamBot-container reageert niet.');
  }

  async stop(raw: InstanceInfo): Promise<void> {
    const info = raw as DockerInfo;
    if (!info.container) return;
    await this.ensureDocker();
    await this.must(['stop', '-t', '20', info.container], 'Container stoppen mislukte.', undefined, /No such container/i);
  }

  async remove(raw: InstanceInfo): Promise<void> {
    const info = raw as DockerInfo;
    if (!info.container) return;
    await this.ensureDocker();
    await this.must(['rm', '-f', info.container], 'Container verwijderen mislukte.', undefined, /No such container/i);
    await this.must(['volume', 'rm', '-f', info.volume], 'Opslag verwijderen mislukte.', undefined, /no such volume/i);
    await this.run(['network', 'disconnect', '-f', info.network, this.opts.self!]);
    await this.must(['network', 'rm', info.network], 'Netwerk verwijderen mislukte.', undefined, /not found|No such network/i);
  }

  async health(raw: InstanceInfo): Promise<boolean> {
    const info = raw as DockerInfo;
    if (!info.container) return false;
    try {
      const r = await (this.opts.fetchImpl || fetch)(`http://${info.container}:${PORT}/healthz`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      const j: any = await r.json().catch(() => ({}));
      return r.ok && j?.ok === true;
    } catch {
      return false;
    }
  }

  upstream(raw: InstanceInfo) {
    const info = raw as DockerInfo;
    return info.container ? { host: info.container, port: PORT } : null;
  }

  async exportData(raw: InstanceInfo, spec: InstanceSpec, outFile: string): Promise<void> {
    await this.ensureDocker();
    const info = raw as DockerInfo;
    const running = (await this.state(info.container)) === 'running';
    if (running) {
      // Consistent database snapshot inside the running container (VACUUM INTO from a read-only connection).
      const js =
        "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');fs.mkdirSync('/data/backups',{recursive:true});" +
        "fs.rmSync('/data/backups/cloud-export.db',{force:true});const d=new DatabaseSync('/data/teambot.db',{readOnly:true});" +
        "d.exec(\"VACUUM INTO '/data/backups/cloud-export.db'\");d.close();";
      await this.must(['exec', info.container, 'node', '-e', js], 'Databasekopie maken mislukte.');
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbc-export-'));
    try {
      const tar = path.join(tmp, 'data.tar');
      await this.must(['cp', `${info.container}:/data`, '-'], 'Gegevens kopiëren mislukte.', { stdoutFile: tar });
      const zip = new AdmZip();
      zip.addLocalFile(tar);
      zip.addFile('master.key', Buffer.from(spec.masterKey));
      const note = running ? '\nLet op: gebruik na het uitpakken van data.tar het bestand data/backups/cloud-export.db als data/teambot.db.\n' : '';
      zip.addFile('LEESMIJ.txt', Buffer.from(EXPORT_README(spec.slug, new Date().toISOString().slice(0, 10)) + note));
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      await zip.writeZipPromise(outFile);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (running) await this.run(['exec', info.container, 'rm', '-f', '/data/backups/cloud-export.db']).catch(() => {});
    }
  }

  async applyLimits(raw: InstanceInfo, plan: Plan): Promise<void> {
    const info = raw as DockerInfo;
    if (!info.container) return;
    await this.must(
      ['update', '--memory', `${Math.round(plan.memoryMb)}m`, '--memory-swap', `${Math.round(plan.memoryMb)}m`, '--cpus', String(plan.cpus), '--pids-limit', String(Math.round(plan.pids)), info.container],
      'Limieten aanpassen mislukte.',
    );
  }

  async usageBytes(raw: InstanceInfo): Promise<number | null> {
    const info = raw as DockerInfo;
    if (!info.container) return null;
    const r = await this.run(['exec', info.container, 'du', '-sk', '/data']).catch(() => null);
    const kb = r && r.code === 0 ? Number(r.stdout.trim().split(/\s+/)[0]) : NaN;
    return Number.isFinite(kb) ? kb * 1024 : null;
  }

  async shutdown(): Promise<void> {
    /* containers keep running under Docker's restart policy */
  }
}
