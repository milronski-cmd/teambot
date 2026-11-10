import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2';
import type { TestApp } from './helpers.js';
import type { ComputerService } from '../server/modules/browser/service.js';

const { Server, utils } = ssh2;

/**
 * Shared test fixture for the SSH remote mode (CMP-07): an in-process ssh2 server with an ed25519 host key that runs
 * exec requests with bash in a temp "home" (Git Bash on Windows). Tests skip themselves when no usable bash exists.
 */

export function findBash(): string | null {
  const cands =
    process.platform === 'win32'
      ? [process.env.TEAMBOT_TEST_BASH, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')]
      : [process.env.TEAMBOT_TEST_BASH, '/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
  for (const c of cands) {
    if (!c || !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-c', 'command -v sh head mkdir ls cat wc tr uname >/dev/null && echo tb-ok'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (r.status === 0 && /tb-ok/.test(r.stdout)) return c;
  }
  return null;
}

export const BASH = findBash();
export const SKIP_NO_BASH = BASH ? false : 'Geen bruikbare bash gevonden (op Windows: Git Bash; of zet TEAMBOT_TEST_BASH)';
export const PASSWORD = 'Wachtwoord-Geheim-9f3k2Qz';

export function fpOf(pub: string | Buffer) {
  const k = utils.parseKey(pub) as ParsedKey;
  return 'SHA256:' + crypto.createHash('sha256').update(k.getPublicSSH()).digest('base64').replace(/=+$/, '');
}

export function killTree(c: ChildProcess) {
  if (c.exitCode === null && c.signalCode === null && c.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true });
    else {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        c.kill('SIGKILL');
      }
    }
  }
  // MSYS grandchildren (e.g. sleep.exe) can survive taskkill and keep the pipes open: let go of them
  for (const s of [c.stdin, c.stdout, c.stderr]) s?.destroy();
}

export interface FakeSsh {
  port: number;
  fingerprint: string;
  execs: string[];
  signals: string[];
  auth: { method: string; username: string }[];
  close(): Promise<void>;
}

/** ssh2's generator now and then emits an ed25519 key that its own parser rejects; retry. */
export function genKey() {
  for (let i = 0; i < 20; i++) {
    const k = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(k.private) instanceof Error) && !(utils.parseKey(k.public) instanceof Error)) return k;
  }
  throw new Error('Kon geen bruikbare testsleutel maken');
}

export async function startSsh(o: { home: string; publicKey: string; username?: string; hostKey?: string; binDir?: string; env?: Record<string, string>; windows?: boolean; port?: number }): Promise<FakeSsh> {
  const user = o.username || 'bot';
  const hostPrivate = o.hostKey || genKey().private;
  const hostParsed = utils.parseKey(hostPrivate) as ParsedKey;
  const allowed = utils.parseKey(o.publicKey) as ParsedKey;
  const st = { execs: [] as string[], signals: [] as string[], auth: [] as { method: string; username: string }[] };
  const children = new Set<ChildProcess>();
  const clients = new Set<any>();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(home|path)$/i.test(k)) env[k] = v;
  env.HOME = o.home;
  env.PATH = (o.binDir ? o.binDir + path.delimiter : '') + (process.env.PATH || process.env.Path || '');
  Object.assign(env, o.env || {});
  const srv = new Server({ hostKeys: [hostPrivate] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      st.auth.push({ method: ctx.method, username: ctx.username });
      if (ctx.username !== user) return ctx.reject();
      if (ctx.method === 'password') return ctx.password === PASSWORD ? ctx.accept() : ctx.reject();
      if (ctx.method === 'publickey') {
        if (ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH())) return ctx.reject();
        if (!ctx.signature) return ctx.accept();
        return ctx.blob && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        let child: ChildProcess | null = null;
        session.on('signal', (accept, _reject, info) => {
          st.signals.push(info.name);
          accept?.();
          if (child) killTree(child);
        });
        session.on('exec', (accept, _reject, info) => {
          st.execs.push(info.command);
          const stream = accept();
          if (o.windows) {
            // OpenSSH for Windows with cmd.exe as shell
            stream.stderr.write(`'${info.command.split(' ')[0]}' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n`);
            stream.exit(1);
            stream.end();
            return;
          }
          const c = spawn(BASH!, ['-c', info.command], { cwd: o.home, env, windowsHide: true, detached: process.platform !== 'win32' });
          child = c;
          children.add(c);
          c.stdin!.on('error', () => {});
          stream.on('data', (d: Buffer) => c.stdin!.write(d));
          stream.on('end', () => c.stdin!.end());
          stream.on('close', () => killTree(c));
          c.stdout!.on('data', (d: Buffer) => stream.write(d));
          c.stderr!.on('data', (d: Buffer) => stream.stderr.write(d));
          c.on('close', (code) => {
            children.delete(c);
            try {
              stream.exit(code ?? 137);
              stream.end();
            } catch {
              /* channel already gone */
            }
          });
        });
      });
    });
  });
  await new Promise<void>((r) => srv.listen(o.port || 0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  return {
    port,
    fingerprint: 'SHA256:' + crypto.createHash('sha256').update(hostParsed.getPublicSSH()).digest('base64').replace(/=+$/, ''),
    ...st,
    close: () =>
      new Promise<void>((r) => {
        for (const c of children) killTree(c);
        for (const c of clients) c.end();
        srv.close(() => r());
      }),
  };
}

export function svcOf(t: TestApp): ComputerService {
  return t.app.ctx.services.computers._service;
}

export function toolCtx(t: TestApp, agentId: string) {
  const s = t.app.ctx.store;
  const agent = s.agent(agentId)!;
  const thread = s.createThread({ user_id: agent.user_id, agent_id: agent.id });
  const run = s.createRun({ thread_id: thread.id, agent_id: agent.id, user_id: agent.user_id, status: 'running' });
  const ac = new AbortController();
  return { ctx: t.app.ctx, agent, thread, run, userId: agent.user_id, signal: ac.signal, toolCallId: 'call_x', progress: () => {}, abort: () => ac.abort() };
}

export async function callTool(t: TestApp, name: string, args: any, tc: ReturnType<typeof toolCtx>) {
  const tool = t.app.ctx.tools.get(name)!;
  assert.ok(tool, `tool ${name} registered`);
  try {
    const r = await tool.run(args, { ...tc, agent: t.app.ctx.store.agent(tc.agent.id)! } as any);
    return typeof r === 'string' ? { text: r, isError: false } : { ...r, isError: !!r.isError };
  } catch (e: any) {
    return { text: String(e.message), isError: true, thrown: true };
  } finally {
    svcOf(t).leases.releaseHolder(tc.run.id);
  }
}

export async function asUser(t: TestApp, token: string, method: string, p: string, body?: any) {
  const res = await fetch(t.app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
