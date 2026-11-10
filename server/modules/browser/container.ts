import { spawn } from 'node:child_process';
import { safeEnv } from '../../tools/builtin/shell.js';

/**
 * Private headless container per bot (plan §14 mode 3) via the Docker CLI. Only used when capability
 * detection reports a running Docker engine; otherwise every call fails closed (never runs on the host).
 * The workspace folder is the only host path mounted into the container.
 */

export interface ContainerSettings {
  image: string;
  network: 'none' | 'bridge';
  memoryMb: number;
  cpus: number;
}

export const DEFAULT_CONTAINER: ContainerSettings = { image: 'debian:stable-slim', network: 'none', memoryMb: 1024, cpus: 1 };

export function cleanContainerSettings(v: any): ContainerSettings {
  const image = String(v?.image || DEFAULT_CONTAINER.image).trim();
  return {
    image: /^[a-z0-9][a-z0-9._\-/:@]{0,200}$/i.test(image) ? image : DEFAULT_CONTAINER.image,
    network: v?.network === 'bridge' ? 'bridge' : 'none',
    memoryMb: Math.min(16384, Math.max(256, Number(v?.memoryMb) || DEFAULT_CONTAINER.memoryMb)),
    cpus: Math.min(8, Math.max(0.25, Number(v?.cpus) || DEFAULT_CONTAINER.cpus)),
  };
}

export const containerName = (agentId: string) => `teambot-${agentId.replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase()}`;

/** Arguments for `docker run` (no shell involved; every value is a separate argv entry). */
export function dockerRunArgs(agentId: string, workspace: string, s: ContainerSettings): string[] {
  return [
    'run', '-d',
    '--name', containerName(agentId),
    '--label', `teambot.agent=${agentId}`,
    '--network', s.network,
    '--memory', `${s.memoryMb}m`,
    '--cpus', String(s.cpus),
    '--pids-limit', '512',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-v', `${workspace}:/workspace`,
    '-w', '/workspace',
    s.image,
    'sleep', 'infinity',
  ];
}

/** `env`: extra variables for the docker CLI process itself (script keys, handed on by name with `-e NAME`). */
export type DockerRunner = (args: string[], o: { timeoutMs: number; signal?: AbortSignal; onData?: (s: string) => void; env?: Record<string, string> }) => Promise<{ code: number | null; out: string; timedOut: boolean }>;

export const dockerCli: DockerRunner = (args, o) =>
  new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn('docker', args, { windowsHide: true, env: safeEnv(o.env) });
    const add = (b: Buffer) => {
      const s = b.toString('utf8');
      if (out.length < 400_000) out += s;
      o.onData?.(s);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, o.timeoutMs);
    o.signal?.addEventListener('abort', () => child.kill(), { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: out + `\n[docker niet gestart: ${e.message}]`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });

export class ContainerRuntime {
  constructor(private run: DockerRunner = dockerCli) {}

  async status(agentId: string): Promise<'running' | 'stopped' | 'absent'> {
    const r = await this.run(['inspect', '-f', '{{.State.Running}}', containerName(agentId)], { timeoutMs: 10_000 });
    if (r.code !== 0) return 'absent';
    return r.out.trim() === 'true' ? 'running' : 'stopped';
  }

  async ensure(agentId: string, workspace: string, s: ContainerSettings) {
    const st = await this.status(agentId);
    if (st === 'running') return;
    if (st === 'stopped') {
      const r = await this.run(['start', containerName(agentId)], { timeoutMs: 60_000 });
      if (r.code === 0) return;
    }
    const r = await this.run(dockerRunArgs(agentId, workspace, s), { timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(`Container starten mislukt: ${r.out.slice(-500)}`);
  }

  /**
   * Run a command in the bot's container. `env` (the bot's "Sleutels voor scripts") goes over by NAME only (`-e NAME`):
   * docker takes the value from its own environment, so a value never appears on a command line.
   */
  async exec(agentId: string, command: string, o: { timeoutMs: number; signal?: AbortSignal; onData?: (s: string) => void; env?: Record<string, string> }) {
    const names = Object.keys(o.env || {}).filter((k) => /^[A-Z_][A-Z0-9_]*$/.test(k));
    const env = names.length ? Object.fromEntries(names.map((n) => [n, o.env![n]])) : undefined;
    return this.run(['exec', ...names.flatMap((n) => ['-e', n]), '-w', '/workspace', containerName(agentId), 'sh', '-lc', command], { ...o, env });
  }

  async stop(agentId: string) {
    await this.run(['stop', '-t', '5', containerName(agentId)], { timeoutMs: 30_000 });
  }

  /** Remove the container (the workspace on the host is kept). */
  async remove(agentId: string) {
    await this.run(['rm', '-f', containerName(agentId)], { timeoutMs: 30_000 });
  }
}
