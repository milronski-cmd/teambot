// Managed cloud (CLD-04): control plane + router + billing, with PGlite and real TeamBot server processes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import AdmZip from 'adm-zip';
import WebSocket from 'ws';
import { createCloud, type CloudHandle } from '../cloud/server.js';
import { FakeClock, redact, slugError, suggestSlug } from '../cloud/util.js';
import { formEncode, signStripePayload, verifyStripeSignature } from '../cloud/billing/stripe.js';
import { decide } from '../cloud/billing/service.js';
import { DEFAULT_PLANS } from '../cloud/billing/plans.js';
import { DockerProvisioner, assertHardened, dockerNames, dockerRunArgs, type DockerRun } from '../cloud/provisioner/docker.js';
import { processEnv, type ProcessInfo } from '../cloud/provisioner/process.js';
import type { InstanceInfo, InstanceSpec, Provisioner } from '../cloud/provisioner/types.js';
import { classifyHost, normalizePath } from '../cloud/router.js';
import { proxyHttp, requestHeaders, rewriteSetCookie, stripControlCookies } from '../cloud/proxy.js';
import type { Workspace } from '../cloud/workspaces.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'server', 'main.js');
const DOMAIN = 'cloud.test';
const WEBHOOK_SECRET = 'whsec_testgeheim123';

// ---------------------------------------------------------------- helpers

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function hreq(base: string, o: { method?: string; path: string; host: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Res> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: u.hostname, port: u.port, method: o.method || 'GET', path: o.path, headers: { host: o.host, ...(o.headers || {}), ...(o.body !== undefined ? { 'content-length': String(Buffer.byteLength(o.body)) } : {}) }, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
      },
    );
    r.on('error', reject);
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}

/** Minimal browser: per-host cookie jar (host-only cookies, like the real thing for these tests). */
class Browser {
  jar = new Map<string, Map<string, string>>();
  constructor(public base: string) {}
  cookies(host: string) {
    if (!this.jar.has(host)) this.jar.set(host, new Map());
    return this.jar.get(host)!;
  }
  async go(host: string, p: string, o: { method?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
    const jar = this.cookies(host);
    const headers: Record<string, string> = { accept: 'text/html', ...(o.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (o.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(o.form).toString();
    } else if (o.json !== undefined) {
      headers['content-type'] = 'application/json';
      headers.accept = 'application/json';
      body = JSON.stringify(o.json);
    }
    const res = await hreq(this.base, { method: o.method || (body !== undefined ? 'POST' : 'GET'), path: p, host, headers, body });
    for (const c of ([] as string[]).concat(res.headers['set-cookie'] || [])) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  }
  /** GET a page, then submit a form on it with its CSRF token. */
  async submit(host: string, pagePath: string, action: string, form: Record<string, string>) {
    const pageRes = await this.go(host, pagePath);
    const csrf = csrfOf(pageRes.body);
    assert.ok(csrf, `geen CSRF-token op ${pagePath} (${pageRes.status})`);
    return this.go(host, action, { form: { _csrf: csrf!, ...form } });
  }
}

const csrfOf = (body: string) => /name="_csrf" value="([^"]+)"/.exec(body)?.[1] || null;

function alive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(fn: () => Promise<boolean> | boolean, ms = 15_000, what = 'voorwaarde') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout: ${what}`);
}

// ---------------------------------------------------------------- unit tests

test('cloud: slugs are validated (lowercase, 3–30, no reserved names)', () => {
  for (const ok of ['abc', 'team-zuid', 'a1b2c3', 'x'.repeat(30)]) assert.equal(slugError(ok), null, ok);
  for (const bad of ['ab', 'x'.repeat(31), 'Team', 'team_zuid', '-team', 'team-', 'te--am', 'xn--abc', 'tëam', 'a.b', 'www', 'api', 'status', 'admin', 'cloud', '']) {
    assert.notEqual(slugError(bad), null, bad);
  }
  assert.equal(suggestSlug('Team Zuid!'), 'team-zuid');
  assert.equal(suggestSlug('Café Één'), 'cafe-een');
});

test('cloud: host classification never routes a nested or foreign host to a workspace', () => {
  assert.deepEqual(classifyHost('cloud.test', DOMAIN), { kind: 'control' });
  assert.deepEqual(classifyHost('CLOUD.TEST:8080', DOMAIN), { kind: 'control' });
  assert.deepEqual(classifyHost('alpha.cloud.test', DOMAIN), { kind: 'workspace', slug: 'alpha' });
  assert.deepEqual(classifyHost('alpha.cloud.test.:443', DOMAIN), { kind: 'workspace', slug: 'alpha' });
  for (const h of ['x.alpha.cloud.test', 'alpha.cloud.test.evil', 'alphacloud.test', 'www.cloud.test', 'evil.com']) assert.equal(classifyHost(h, DOMAIN).kind, 'other', h);
  for (const h of ['', 'a b', '[::1]:80', 'alpha.cloud.test/x', 'al_pha.cloud.test']) assert.equal(classifyHost(h, DOMAIN).kind, 'bad', h);
  // every spelling of the setup path normalises to the same path
  for (const p of ['/api/public/setup', '/API/Public/Setup/', '/api//public/./setup', '/api/public/%73etup', '/api/x/../public/setup?a=1', '/api\\public\\setup', '/api/public/%2573etup']) {
    assert.equal(normalizePath(p), '/api/public/setup', p);
  }
  assert.equal(normalizePath('/%E0%A4%A'), null);
});

test('cloud: Stripe signature check (valid, wrong secret, tampered, replay window, malformed)', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const now = 1_800_000_000;
  const good = signStripePayload(payload, WEBHOOK_SECRET, now);
  assert.equal(verifyStripeSignature(payload, good, WEBHOOK_SECRET, { nowSec: now }).ok, true);
  assert.equal(verifyStripeSignature(Buffer.from(payload), good, WEBHOOK_SECRET, { nowSec: now + 299 }).ok, true);
  // Several v1 signatures (secret rotation): one valid is enough.
  const rotated = `${good},v1=${'0'.repeat(64)}`;
  assert.equal(verifyStripeSignature(payload, rotated, WEBHOOK_SECRET, { nowSec: now }).ok, true);
  assert.equal(verifyStripeSignature(payload, signStripePayload(payload, 'whsec_ander', now), WEBHOOK_SECRET, { nowSec: now }).ok, false);
  assert.equal(verifyStripeSignature(payload + ' ', good, WEBHOOK_SECRET, { nowSec: now }).ok, false);
  assert.equal(verifyStripeSignature(payload, good, WEBHOOK_SECRET, { nowSec: now + 301 }).ok, false);
  assert.equal(verifyStripeSignature(payload, good, WEBHOOK_SECRET, { nowSec: now - 301 }).ok, false);
  for (const h of [undefined, '', 't=abc,v1=zz', `v1=${'a'.repeat(64)}`, `t=${now}`, `t=${now},v0=${'a'.repeat(64)}`]) assert.equal(verifyStripeSignature(payload, h, WEBHOOK_SECRET, { nowSec: now }).ok, false, String(h));
  assert.equal(verifyStripeSignature(payload, good, '', { nowSec: now }).ok, false);
  assert.equal(
    formEncode({ mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], metadata: { workspace_id: 'ws_1' } }).toString(),
    'mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Bworkspace_id%5D=ws_1',
  );
});

test('cloud: subscription state machine (trial end, grace period, resume, retention, operator hold)', () => {
  const t0 = new Date('2026-03-01T10:00:00Z');
  const day = (n: number) => new Date(t0.getTime() + n * 864e5);
  const ws = (o: Partial<Workspace> = {}) => ({ status: 'active', status_reason: null, trial_ends_at: day(14), delete_after: null, ...o }) as Workspace;
  const sub = (o: any = {}) => ({ status: 'trialing', payment_failed_at: null, updated_at: t0, ...o });
  assert.deepEqual(decide(ws(), sub(), day(13), 7), { action: 'none' });
  assert.deepEqual(decide(ws(), sub(), day(14), 7), { action: 'suspend', reason: 'trial_ended' });
  assert.deepEqual(decide(ws(), sub({ status: 'active' }), day(40), 7), { action: 'none' });
  const failed = sub({ status: 'past_due', payment_failed_at: day(20) });
  assert.deepEqual(decide(ws(), failed, day(26), 7), { action: 'none' }, 'inside the grace period');
  assert.deepEqual(decide(ws(), failed, day(27), 7), { action: 'suspend', reason: 'payment_failed' });
  assert.deepEqual(decide(ws({ status: 'suspended', status_reason: 'payment_failed' }), sub({ status: 'active' }), day(28), 7), { action: 'resume' });
  assert.deepEqual(decide(ws({ status: 'suspended', status_reason: 'operator' }), sub({ status: 'active' }), day(28), 7), { action: 'none' }, 'billing never lifts an operator hold');
  assert.deepEqual(decide(ws(), sub({ status: 'canceled' }), day(30), 7), { action: 'suspend', reason: 'canceled' });
  assert.deepEqual(decide(ws({ status: 'suspended', status_reason: 'canceled', delete_after: day(60) }), sub({ status: 'canceled' }), day(59), 7), { action: 'none' });
  assert.deepEqual(decide(ws({ status: 'suspended', status_reason: 'canceled', delete_after: day(60) }), sub({ status: 'canceled' }), day(60), 7), { action: 'delete' });
  assert.deepEqual(decide(ws({ status: 'deleting' }), sub(), day(1), 7), { action: 'delete' }, 'an interrupted delete is retried');
  assert.deepEqual(decide(ws({ status: 'provisioning' }), sub(), day(99), 7), { action: 'none' });
});

test('cloud: docker provisioner builds hardened arguments and fails closed without Docker', async () => {
  const spec: InstanceSpec = { workspaceId: 'ws_abc123def', slug: 'alpha', publicUrl: 'https://alpha.cloud.example', masterKey: crypto.randomBytes(32).toString('base64'), setupToken: 'setup-geheim-123', plan: DEFAULT_PLANS[1] };
  const names = dockerNames(spec.workspaceId);
  const args = dockerRunArgs(spec, names, { image: 'teambot:1.2.3', readOnly: true });
  // the setup token, like the master key, only travels via the environment; the seat limit follows the plan
  assert.ok(args.includes('TEAMBOT_SETUP_TOKEN') && !args.join(' ').includes('setup-geheim-123'));
  assert.ok(args.includes(`TEAMBOT_MAX_USERS=${DEFAULT_PLANS[1].seats}`));
  const flag = (f: string) => args[args.indexOf(f) + 1];
  assert.equal(flag('--cap-drop'), 'ALL');
  assert.equal(flag('--security-opt'), 'no-new-privileges');
  assert.equal(flag('--memory'), '1024m');
  assert.equal(flag('--memory-swap'), '1024m');
  assert.equal(flag('--cpus'), '1');
  assert.equal(flag('--pids-limit'), '512');
  assert.equal(flag('--network'), names.network);
  assert.equal(flag('--user'), 'node');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes(`${names.volume}:/data`));
  assert.ok(args.includes('TEAMBOT_MASTER_KEY'), 'key passed by name (from the CLI environment)');
  assert.ok(!args.some((a) => a.includes(spec.masterKey)), 'secret never on argv');
  assert.ok(!args.includes('-p') && !args.some((a) => a.startsWith('--publish')), 'no published ports: only the router reaches the instance');
  assert.equal(args.at(-1), 'teambot:1.2.3');
  assert.throws(() => assertHardened(args.filter((a) => a !== '--cap-drop' && a !== 'ALL'), spec.masterKey), /Containerbeveiliging/);
  assert.throws(() => dockerRunArgs({ ...spec, plan: { ...spec.plan, memoryMb: 0 } }, names, { image: 'teambot', readOnly: true }), /limiet/);
  assert.throws(() => dockerRunArgs(spec, names, { image: 'teambot; rm -rf /', readOnly: true }), /image/);
  assert.throws(() => dockerNames('../etc'), /Ongeldige/);

  // No docker binary: nothing runs, every call fails with a clear Dutch message.
  const missing: DockerRun = async () => {
    throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
  };
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const p1 = new DockerProvisioner({ image: 'teambot', self: 'teambot-cloud', run: missing, fetchImpl: offline });
  await assert.rejects(p1.create(spec), /Docker is niet beschikbaar/);
  await assert.rejects(p1.start({ kind: 'docker', ...names }, spec), /Docker is niet beschikbaar/);
  assert.equal(await p1.health({ kind: 'docker', ...names }), false);

  // Daemon down, or router container unknown: fail closed as well.
  const calls: string[][] = [];
  const down: DockerRun = async (a) => (calls.push(a), { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' });
  await assert.rejects(new DockerProvisioner({ image: 'teambot', self: 'x', run: down }).create(spec), /niet bereikbaar/);
  assert.deepEqual(calls.map((c) => c[0]), ['version'], 'stopped after the availability check');
  const up: DockerRun = async (a) => ({ code: 0, stdout: a[0] === 'version' ? '27.0.1' : '', stderr: '' });
  await assert.rejects(new DockerProvisioner({ image: 'teambot', self: null, run: up }).create(spec), /CLOUD_DOCKER_SELF/);

  // Happy path with a recording runner: the secret only travels through the env of `docker run`.
  const seen: { args: string[]; env?: Record<string, string> }[] = [];
  const rec: DockerRun = async (a, o) => {
    seen.push({ args: a, env: o?.env });
    if (a[0] === 'version') return { code: 0, stdout: '27.0.1', stderr: '' };
    if (a[0] === 'container') return { code: 1, stdout: '', stderr: 'No such container' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const p2 = new DockerProvisioner({ image: 'teambot', self: 'teambot-cloud', run: rec, startTimeoutMs: 1, fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch });
  const info = await p2.create(spec);
  await p2.start(info, spec);
  const run = seen.find((s) => s.args[0] === 'run')!;
  assert.equal(run.env?.TEAMBOT_MASTER_KEY, spec.masterKey);
  assert.ok(seen.some((s) => s.args.join(' ') === `network connect ${names.network} teambot-cloud`), 'router joins the per-workspace network');
  assert.ok(seen.filter((s) => s.args[0] !== 'run').every((s) => !s.env?.TEAMBOT_MASTER_KEY), 'key only for docker run');

  // Upgrade: an existing container on an older image is recreated (volume kept); same image → plain start.
  const ops: string[] = [];
  const existing = (image: string): DockerRun => async (a) => {
    ops.push(a[0] === 'container' ? 'inspect' : a[0]);
    if (a[0] === 'version') return { code: 0, stdout: '27.0.1', stderr: '' };
    if (a[0] === 'container') return { code: 0, stdout: `false ${image}`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const okFetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
  await new DockerProvisioner({ image: 'teambot:2', self: 'c', run: existing('teambot:1'), fetchImpl: okFetch }).start({ kind: 'docker', ...names }, spec);
  assert.deepEqual(ops.filter((o) => o !== 'version'), ['inspect', 'rm', 'run']);
  assert.ok(!ops.includes('volume'), 'data volume untouched');
  ops.length = 0;
  await new DockerProvisioner({ image: 'teambot:2', self: 'c', run: existing('teambot:2'), fetchImpl: okFetch }).start({ kind: 'docker', ...names }, spec);
  assert.deepEqual(ops.filter((o) => o !== 'version'), ['inspect', 'update', 'start']);
});

test('cloud: process instances get an allowlisted environment without control-plane secrets', () => {
  const spec: InstanceSpec = { workspaceId: 'ws_x', slug: 'alpha', publicUrl: 'http://alpha.cloud.test', masterKey: 'a2V5', setupToken: 'setup-geheim-456', plan: DEFAULT_PLANS[0] };
  const info: ProcessInfo = { kind: 'process', dir: path.join(os.tmpdir(), 'x'), dataDir: path.join(os.tmpdir(), 'x', 'data') };
  const env = processEnv(spec, info, { PATH: '/bin', STRIPE_SECRET_KEY: 'sk_live_x', DATABASE_URL: 'postgres://u:p@h/db', CLOUD_SECRET_KEY: 'k', ANTHROPIC_API_KEY: 'sk-ant', HOME: '/home/dev' });
  assert.equal(env.TEAMBOT_SETUP_TOKEN, 'setup-geheim-456');
  assert.equal(env.TEAMBOT_MAX_USERS, String(DEFAULT_PLANS[0].seats));
  assert.equal(env.TEAMBOT_MASTER_KEY, 'a2V5');
  assert.equal(env.TEAMBOT_MODE, 'server');
  assert.equal(env.PATH, '/bin');
  for (const k of ['STRIPE_SECRET_KEY', 'DATABASE_URL', 'CLOUD_SECRET_KEY', 'ANTHROPIC_API_KEY']) assert.equal(env[k], undefined, k);
  assert.ok(env.HOME.startsWith(info.dir), "developer's HOME is not shared with instances");
  assert.equal(redact('key sk_live_abc123 and whsec_zzz and postgres://u:pw@db/x?t=1 and /claim?t=geheimtoken'), 'key [geheim] and [geheim] and [geheim] and /claim?t=[geheim]');
});

test('cloud: proxy overwrites forwarding headers, strips control-plane cookies and cookie domains', async () => {
  let seen: http.IncomingHttpHeaders = {};
  const upstream = http.createServer((req, res) => {
    seen = req.headers;
    res.setHeader('set-cookie', ['tb_x=1; Path=/; Domain=cloud.test; HttpOnly', 'tbc_session=evil; Path=/', '__Host-tbc_session=evil; Path=/; Secure']);
    res.end('ok');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as any).port;
  const front = http.createServer((req, res) =>
    proxyHttp(req, res, { host: '127.0.0.1', port }, { headers: requestHeaders(req, { clientIp: '203.0.113.9', proto: 'https', host: 'alpha.cloud.test' }), maxBodyBytes: 1024, onError: (r, s) => (r.writeHead(s), r.end()) }),
  );
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(front.address() as any).port}`;
    const res = await hreq(base, {
      path: '/x',
      host: 'alpha.cloud.test',
      headers: { cookie: 'tbc_session=s1; tb_ui=keep; __Host-tbc_pre=p; tbc_claim=c', 'x-forwarded-for': '1.2.3.4', 'x-forwarded-host': 'bravo.cloud.test', forwarded: 'for=1.2.3.4', 'x-real-ip': '1.2.3.4', 'x-cloud-internal': '1' },
    });
    assert.equal(res.status, 200);
    assert.equal(seen.cookie, 'tb_ui=keep');
    assert.equal(seen['x-forwarded-for'], '203.0.113.9');
    assert.equal(seen['x-forwarded-host'], 'alpha.cloud.test');
    assert.equal(seen['x-forwarded-proto'], 'https');
    assert.equal(seen.host, 'alpha.cloud.test');
    assert.equal(seen.forwarded, undefined);
    assert.equal(seen['x-real-ip'], undefined);
    assert.equal(seen['x-cloud-internal'], undefined);
    assert.deepEqual(res.headers['set-cookie'], ['tb_x=1; Path=/; HttpOnly']);
    const big = await hreq(base, { method: 'POST', path: '/x', host: 'alpha.cloud.test', body: 'x'.repeat(2048) });
    assert.equal(big.status, 413);
  } finally {
    front.close();
    upstream.close();
  }
  assert.equal(stripControlCookies('tbc_a=1'), undefined);
  assert.deepEqual(rewriteSetCookie(['a=1; domain=.x; path=/']), ['a=1; path=/']);
});

// ---------------------------------------------------------------- integration (real TeamBot processes)

let cloud: CloudHandle;
let clock: FakeClock;
let tmp: string;
let base: string;
let stripe: http.Server;
const stripeCalls: { method: string; path: string; body: string }[] = [];
const A = { email: 'anna@example.nl', password: 'anna-wachtwoord-1' };
const B = { email: 'bram@example.nl', password: 'bram-wachtwoord-1' };
const OP = { email: 'beheer@example.nl', password: 'beheer-wachtwoord-1' };
let anna: Browser;
let bram: Browser;
let op: Browser;
let alpha: Workspace;
let bravo: Workspace;
let alphaToken = '';

const webhook = (event: Record<string, unknown>, o: { at?: number; secret?: string; sig?: string } = {}) => {
  const body = JSON.stringify({ created: Math.floor(clock.now().getTime() / 1000), ...event });
  const t = o.at ?? Math.floor(clock.now().getTime() / 1000);
  return hreq(base, { method: 'POST', path: '/stripe/webhook', host: DOMAIN, headers: { 'content-type': 'application/json', 'stripe-signature': o.sig ?? signStripePayload(body, o.secret || WEBHOOK_SECRET, t) }, body });
};
const reload = async (ws: Workspace) => (await cloud.workspaces.get(ws.id))!;

before(async () => {
  if (!fs.existsSync(ENTRY)) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:server'], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cloud-'));
  stripe = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      stripeCalls.push({ method: req.method!, path: req.url!, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer sk_test_nep') return res.writeHead(401).end('{"error":{"message":"bad key"}}');
      if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }));
      if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ url: 'https://billing.stripe.com/p/session/test_1' }));
      if (req.method === 'DELETE' && req.url?.startsWith('/v1/subscriptions/')) return res.end(JSON.stringify({ id: req.url.split('/').pop(), status: 'canceled' }));
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  clock = new FakeClock(new Date());
  cloud = await createCloud({
    env: {
      STRIPE_SECRET_KEY: 'sk_test_nep',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_BASE: `http://127.0.0.1:${(stripe.address() as any).port}`,
      STRIPE_PRICE_STARTER: 'price_starter',
      STRIPE_PRICE_TEAM: 'price_team',
    },
    config: {
      url: `http://${DOMAIN}`,
      listenPort: 0,
      dataDir: tmp,
      secretKey: crypto.randomBytes(32),
      healthIntervalMs: 0,
      enforceIntervalMs: 0,
      quiet: true,
      process: { entry: ENTRY, nodeBin: process.execPath, startTimeoutMs: 30_000, uiDir: null },
    },
    clock,
    pgliteDir: null,
  });
  base = cloud.listenUrl;
  anna = new Browser(base);
  bram = new Browser(base);
  op = new Browser(base);
});

after(async () => {
  try {
    await cloud?.close();
  } finally {
    stripe?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('cloud: sign up, log in/out, CSRF and login rate limit', async () => {
  // A form without (or with a forged) CSRF token is refused.
  assert.equal((await anna.go(DOMAIN, '/signup', { form: { email: A.email, password: A.password } })).status, 403);
  assert.equal((await anna.go(DOMAIN, '/signup', { form: { _csrf: 'vervalst', email: A.email, password: A.password } })).status, 403);

  const r = await anna.submit(DOMAIN, '/signup', '/signup', { email: A.email, name: 'Anna', password: A.password });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/dashboard?m=welkom');
  const cookie = ([] as string[]).concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('tbc_session='))!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Domain=/i, 'host-only: never sent to workspace subdomains');
  assert.equal((await anna.go(DOMAIN, '/dashboard')).status, 200);
  // Duplicate e-mail, short password.
  assert.equal((await new Browser(base).submit(DOMAIN, '/signup', '/signup', { email: A.email, password: 'nog-een-wachtwoord' })).status, 409);
  assert.equal((await new Browser(base).submit(DOMAIN, '/signup', '/signup', { email: 'kort@example.nl', password: 'kort' })).status, 400);

  // Logged in: CSRF token is bound to the session; a cross-site Origin is refused even with a valid token.
  const dash = await anna.go(DOMAIN, '/dashboard');
  const csrf = csrfOf(dash.body)!;
  assert.equal((await anna.go(DOMAIN, '/workspaces', { form: { name: 'X', slug: 'xxx' } })).status, 403);
  assert.equal((await anna.go(DOMAIN, '/workspaces', { form: { _csrf: csrf, name: 'X', slug: 'xxx' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await anna.go(DOMAIN, '/workspaces', { form: { _csrf: csrf, name: 'X', slug: 'xxx' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);

  // Logout revokes the session server-side.
  const stolen = anna.cookies(DOMAIN).get('tbc_session')!;
  assert.equal((await anna.go(DOMAIN, '/logout', { form: { _csrf: csrf } })).status, 303);
  const replay = await hreq(base, { path: '/dashboard', host: DOMAIN, headers: { cookie: `tbc_session=${stolen}` } });
  assert.equal(replay.status, 303, 'revoked session cookie no longer works');

  // Login: wrong password a few times → rate limited, even with the right password afterwards.
  await bram.submit(DOMAIN, '/signup', '/signup', { email: B.email, password: B.password });
  const target = { email: 'doelwit@example.nl', password: 'doelwit-wachtwoord' };
  await new Browser(base).submit(DOMAIN, '/signup', '/signup', target);
  const attacker = new Browser(base);
  for (let i = 0; i < 5; i++) assert.equal((await attacker.submit(DOMAIN, '/login', '/login', { email: target.email, password: 'fout-wachtwoord' })).status, 401);
  assert.equal((await attacker.submit(DOMAIN, '/login', '/login', target)).status, 429);

  const back = await anna.submit(DOMAIN, '/login', '/login', A);
  assert.equal(back.status, 303);
  assert.equal(back.headers.location, '/dashboard');

  await op.submit(DOMAIN, '/signup', '/signup', { email: OP.email, password: OP.password });
  assert.equal(await cloud.accounts.setRole(OP.email, 'operator'), true);
});

test('cloud: creating workspaces provisions real, healthy TeamBot instances', async () => {
  const bad = await anna.submit(DOMAIN, '/workspaces/new', '/workspaces', { name: 'Admin', slug: 'admin' });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /gereserveerd/);
  assert.equal((await anna.submit(DOMAIN, '/workspaces/new', '/workspaces', { name: 'Team Alpha', slug: 'alpha' })).status, 303);
  assert.equal((await bram.submit(DOMAIN, '/workspaces/new', '/workspaces', { name: 'Team Bravo', slug: 'bravo' })).status, 303);
  const taken = await bram.submit(DOMAIN, '/workspaces/new', '/workspaces', { name: 'Nog een', slug: 'alpha' });
  assert.equal(taken.status, 409);
  await cloud.workspaces.idle();
  [alpha] = await cloud.workspaces.listForOwner((await cloud.accounts.byEmail(A.email))!.id);
  [bravo] = await cloud.workspaces.listForOwner((await cloud.accounts.byEmail(B.email))!.id);
  assert.equal(alpha.status, 'active', String(alpha.status_reason));
  assert.equal(bravo.status, 'active', String(bravo.status_reason));
  assert.equal(await cloud.provisioner.health(alpha.instance as InstanceInfo), true);
  assert.ok(alpha.master_key_enc?.startsWith('v1:'), 'master key stored encrypted');
  const dash = await anna.go(DOMAIN, '/dashboard');
  assert.match(dash.body, /alpha\.cloud\.test/);
  assert.match(dash.body, /Eigenaar-account aanmaken/);
  assert.match(dash.body, /Openen/);
  assert.match(dash.body, /Modelkosten zitten er niet in/);
  assert.doesNotMatch(dash.body, /bravo/, 'own workspaces only');
  // Tenant check in the control plane: Bram cannot see Anna's workspace page.
  assert.equal((await bram.go(DOMAIN, `/workspaces/${alpha.id}`)).status, 404);
});

test('cloud: owner bootstrap only through the one-time claim link', async () => {
  const setup = (b: Browser, host: string, p = '/api/public/setup') => b.go(host, p, { json: { name: 'Anna', email: A.email, password: A.password } });
  // A fresh instance's first-run setup is closed to everyone without a claim, in every spelling of the path.
  const stranger = new Browser(base);
  for (const p of ['/api/public/setup', '/API/public/setup/', '/api//public/./setup', '/api/public/%73etup']) {
    const r = await setup(stranger, 'alpha.cloud.test', p);
    assert.equal(r.status, 403, p);
  }
  // Anna gets a claim link from her dashboard → host-only cookie on alpha → TeamBot's own setup works once.
  const claim = await anna.submit(DOMAIN, '/dashboard', `/workspaces/${alpha.id}/claim`, {});
  assert.equal(claim.status, 303);
  const link = new URL(claim.headers.location!);
  assert.equal(link.host, 'alpha.cloud.test');
  assert.equal(link.pathname, '/_cloud/claim');
  // The claim token of alpha does nothing on bravo.
  assert.equal((await stranger.go('bravo.cloud.test', link.pathname + link.search)).status, 403);
  const land = await anna.go('alpha.cloud.test', link.pathname + link.search);
  assert.equal(land.status, 303);
  assert.equal(land.headers.location, '/');
  assert.match(String(land.headers['set-cookie']), /tbc_claim=.*HttpOnly.*SameSite=Strict/);
  const ok = await setup(anna, 'alpha.cloud.test');
  assert.equal(ok.status, 200, ok.body);
  alphaToken = JSON.parse(ok.body).token;
  assert.ok(alphaToken);
  assert.equal(anna.cookies('alpha.cloud.test').has('tbc_claim'), false, 'claim cookie cleared');
  await until(async () => (await reload(alpha)).owner_claimed, 5000, 'claim vastgelegd');
  // Closed for good, also for the owner and with the old link.
  assert.equal((await setup(anna, 'alpha.cloud.test')).status, 403);
  assert.equal((await new Browser(base).go('alpha.cloud.test', link.pathname + link.search)).status, 403);
  assert.match((await anna.go(DOMAIN, `/workspaces/${alpha.id}`)).body, /eigenaar-account van je TeamBot is aangemaakt/);
});

test('cloud: router proxies HTTP and WebSocket by Host, and workspaces stay isolated', async () => {
  const status = async (host: string, headers: Record<string, string> = {}) => JSON.parse((await hreq(base, { path: '/api/public/status', host, headers })).body);
  assert.equal((await status('alpha.cloud.test')).needsSetup, false);
  assert.equal((await status('bravo.cloud.test')).needsSetup, true);
  // Spoofed forwarding headers cannot redirect a request to another workspace.
  assert.equal((await status('alpha.cloud.test', { 'x-forwarded-host': 'bravo.cloud.test', forwarded: 'host=bravo.cloud.test' })).needsSetup, false);
  assert.equal((await status('bravo.cloud.test', { 'x-forwarded-host': 'alpha.cloud.test' })).needsSetup, true);
  // A token of alpha means nothing on bravo.
  const me = (host: string) => hreq(base, { path: '/api/me', host, headers: { authorization: `Bearer ${alphaToken}` } });
  assert.equal((await me('alpha.cloud.test')).status, 200);
  assert.equal(JSON.parse((await me('alpha.cloud.test')).body).user.email, A.email);
  assert.equal((await me('bravo.cloud.test')).status, 401);
  // Absolute-form targets, nested and unknown hosts are not routed.
  assert.equal((await hreq(base, { path: 'http://bravo.cloud.test/api/public/status', host: 'alpha.cloud.test' })).status, 400);
  for (const host of ['x.alpha.cloud.test', 'alpha.cloud.test.evil', 'onbekend.cloud.test']) {
    const r = await hreq(base, { path: '/api/public/status', host, headers: { accept: 'text/html' } });
    assert.equal(r.status, 404, host);
    assert.match(r.body, /bestaat niet/);
  }
  // Caddy on-demand TLS asks the router (internal host) whether a certificate may be issued.
  const ask = (domain: string) => hreq(base, { path: `/_tls/ask?domain=${encodeURIComponent(domain)}`, host: 'cloud-intern:8080' });
  assert.equal((await ask('alpha.cloud.test')).status, 200);
  assert.equal((await ask(DOMAIN)).status, 200);
  for (const d of ['onbekend.cloud.test', 'x.alpha.cloud.test', 'evil.com', '']) assert.equal((await ask(d)).status, 404, d);
  // The instance's own health endpoint answers through the router.
  const health = await hreq(base, { path: '/healthz', host: 'alpha.cloud.test' });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);

  // WebSocket upgrade through the router, to the right instance only (a signed /ws URL, as the app makes it).
  const k = JSON.parse((await hreq(base, { path: '/api/auth/url-key', host: 'alpha.cloud.test', headers: { authorization: `Bearer ${alphaToken}` } })).body);
  const wsBase = `/ws?tbs=${k.sid}&tbe=${Math.floor(Date.now() / 1000) + 600}`;
  const wsPath = `${wsBase}&tbsig=${crypto.createHmac('sha256', Buffer.from(k.key, 'base64url')).update(wsBase).digest('base64url')}`;
  const ws = new WebSocket(`${base.replace('http', 'ws')}${wsPath}`, { headers: { host: 'alpha.cloud.test' } });
  const hello = await new Promise<any>((resolve, reject) => {
    ws.once('message', (d) => resolve(JSON.parse(String(d))));
    ws.once('error', reject);
  });
  assert.equal(hello.type, 'hello');
  assert.equal(hello.data.user.email, A.email);
  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await new Promise<any>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));
  assert.equal(pong.type, 'pong');
  ws.close();
  const other = new WebSocket(`${base.replace('http', 'ws')}${wsPath}`, { headers: { host: 'bravo.cloud.test' } });
  const code = await new Promise<number>((resolve) => {
    other.once('unexpected-response', (_req, res) => resolve(res.statusCode || 0));
    other.once('error', () => resolve(-1));
  });
  assert.equal(code, 401);
  other.terminate();
});

test('cloud: operator suspends (paused page, process stopped) and resumes with data intact', async () => {
  assert.equal((await anna.go(DOMAIN, '/operator')).status, 403, 'customers are not operators');
  const console_ = await op.go(DOMAIN, '/operator');
  assert.equal(console_.status, 200);
  assert.match(console_.body, /alpha/);
  const pid = ((await reload(alpha)).instance as ProcessInfo).pid;
  assert.ok(alive(pid));
  assert.equal((await op.submit(DOMAIN, '/operator', `/operator/workspaces/${alpha.id}/suspend`, {})).status, 303);
  const ws = await reload(alpha);
  assert.equal(ws.status, 'suspended');
  assert.equal(ws.status_reason, 'operator');
  const paused = await hreq(base, { path: '/', host: 'alpha.cloud.test', headers: { accept: 'text/html' } });
  assert.equal(paused.status, 503);
  assert.match(paused.body, /gepauzeerd — betaling\/beheer/i);
  const api = await hreq(base, { path: '/api/me', host: 'alpha.cloud.test', headers: { authorization: `Bearer ${alphaToken}` } });
  assert.equal(api.status, 503);
  assert.match(JSON.parse(api.body).error, /gepauzeerd/i);
  await until(() => !alive(pid), 10_000, 'proces gestopt');
  assert.equal(await cloud.provisioner.health(ws.instance as InstanceInfo), false);
  // Billing does not lift an operator hold.
  await cloud.billing.enforce(alpha.id);
  assert.equal((await reload(alpha)).status, 'suspended');

  assert.equal((await op.submit(DOMAIN, '/operator', `/operator/workspaces/${alpha.id}/resume`, {})).status, 303);
  const resumed = await reload(alpha);
  assert.equal(resumed.status, 'active');
  assert.notEqual((resumed.instance as ProcessInfo).pid, pid, 'new process');
  const login = await hreq(base, { method: 'POST', path: '/api/public/login', host: 'alpha.cloud.test', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: A.email, password: A.password }) });
  assert.equal(login.status, 200, 'owner account survived the pause');
  alphaToken = JSON.parse(login.body).token;
  // Export while the instance runs: a consistent database snapshot that holds the owner account.
  const exp = await cloud.workspaces.createExport(alpha.id, { actor: 'user' });
  const zipFile = await cloud.workspaces.exportPath(alpha.id, exp.id);
  assert.ok(zipFile);
  const snapshot = path.join(tmp, 'alpha-export.db');
  fs.writeFileSync(snapshot, new AdmZip(zipFile!).readFile('teambot.db')!);
  const sdb = new DatabaseSync(snapshot, { readOnly: true });
  const owner = sdb.prepare("SELECT email FROM users WHERE role = 'owner'").get() as { email: string } | undefined;
  sdb.close();
  assert.equal(owner?.email, A.email);
  const audit = await op.go(DOMAIN, '/operator/audit');
  assert.match(audit.body, /workspace\.suspended/);
  assert.match(audit.body, /workspace\.resumed/);
});

test('cloud: Stripe checkout, webhooks (valid, replay, invalid) and grace period', async () => {
  const checkout = await bram.submit(DOMAIN, `/workspaces/${bravo.id}`, `/workspaces/${bravo.id}/checkout`, { plan: 'starter' });
  assert.equal(checkout.status, 303);
  assert.equal(checkout.headers.location, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const sent = new URLSearchParams(stripeCalls.find((c) => c.path === '/v1/checkout/sessions')!.body);
  assert.equal(sent.get('mode'), 'subscription');
  assert.equal(sent.get('line_items[0][price]'), 'price_starter');
  assert.equal(sent.get('client_reference_id'), bravo.id);
  assert.equal(sent.get('subscription_data[metadata][workspace_id]'), bravo.id);
  assert.equal(sent.get('customer_email'), B.email);

  const completed = { id: 'evt_checkout_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: bravo.id, customer: 'cus_bram', subscription: 'sub_bravo', metadata: { workspace_id: bravo.id, plan: 'starter' } } } };
  assert.equal((await webhook(completed, { sig: 'nep' })).status, 400, 'unsigned');
  assert.equal((await webhook(completed, { secret: 'whsec_ander' })).status, 400, 'wrong secret');
  assert.equal((await webhook(completed, { at: Math.floor(clock.now().getTime() / 1000) - 3600 })).status, 400, 'outside the tolerance window');
  assert.equal((await cloud.billing.subscription(bravo.id))!.status, 'trialing', 'nothing applied yet');
  const r1 = await webhook(completed);
  assert.equal(r1.status, 200);
  const sub = (await cloud.billing.subscription(bravo.id))!;
  assert.equal(sub.status, 'active');
  assert.equal(sub.plan, 'starter');
  assert.equal(sub.external_subscription_id, 'sub_bravo');
  assert.equal((await reload(bravo)).plan, 'starter');
  // Replay of the same event: acknowledged, not applied twice.
  const r2 = await webhook(completed);
  assert.equal(r2.status, 200);
  assert.equal(JSON.parse(r2.body).duplicate, true);
  assert.equal((await cloud.db.query("SELECT COUNT(*)::int AS n FROM billing_events WHERE id = 'evt_checkout_1'"))[0].n, 1);

  // Customer Portal.
  const portal = await bram.submit(DOMAIN, `/workspaces/${bravo.id}`, `/workspaces/${bravo.id}/portal`, {});
  assert.equal(portal.headers.location, 'https://billing.stripe.com/p/session/test_1');

  // Payment fails → still running inside the grace period → paused after it → resumes when paid.
  assert.equal((await webhook({ id: 'evt_fail_1', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_bravo' } } })).status, 200);
  assert.equal((await cloud.billing.subscription(bravo.id))!.status, 'past_due');
  clock.advanceDays(6);
  await cloud.billing.enforce();
  assert.equal((await reload(bravo)).status, 'active', 'day 6 of 7: still running');
  assert.match((await bram.go(DOMAIN, `/workspaces/${bravo.id}`)).body, /laatste betaling is mislukt/);
  clock.advanceDays(2);
  await cloud.billing.enforce();
  const paused = await reload(bravo);
  assert.equal(paused.status, 'suspended');
  assert.equal(paused.status_reason, 'payment_failed');
  assert.equal(cloud.provisioner.upstream(paused.instance as InstanceInfo), null, 'instance stopped');
  // Newer API shape (invoice.parent.subscription_details) is understood too.
  assert.equal((await webhook({ id: 'evt_paid_1', type: 'invoice.paid', data: { object: { parent: { subscription_details: { subscription: 'sub_bravo' } } } } })).status, 200);
  const back = await reload(bravo);
  assert.equal(back.status, 'active');
  assert.equal(await cloud.provisioner.health(back.instance as InstanceInfo), true);
  // An out-of-order (older) subscription update is ignored.
  await webhook({ id: 'evt_old_1', type: 'customer.subscription.updated', created: Math.floor(clock.now().getTime() / 1000) - 30 * 86400, data: { object: { id: 'sub_bravo', status: 'canceled' } } });
  assert.equal((await cloud.billing.subscription(bravo.id))!.status, 'active');
});

test('cloud: trial ends → paused; status page shows counts, never names', async () => {
  // Alpha is still on its trial (created ~8 days ago on the fake clock); bravo pays.
  clock.advanceDays(7);
  const done = await cloud.billing.enforce();
  assert.ok(done.some((d) => d.id === alpha.id && d.action === 'suspend'));
  assert.equal((await reload(alpha)).status_reason, 'trial_ended');
  assert.equal((await reload(bravo)).status, 'active');
  await cloud.monitoring.sweep();
  const page = await hreq(base, { path: '/status', host: DOMAIN });
  assert.equal(page.status, 200);
  assert.match(page.body, /1 werkt/);
  assert.match(page.body, /1 gepauzeerd/);
  for (const secret of ['alpha', 'bravo', 'Team Alpha', 'Team Bravo', A.email, B.email]) assert.ok(!page.body.includes(secret), `status page leaks ${secret}`);
  const json = JSON.parse((await hreq(base, { path: '/status.json', host: DOMAIN })).body);
  assert.deepEqual(json.workspaces, { healthy: 1, unhealthy: 0, suspended: 1, provisioning: 0 });
  assert.equal(json.uptime30, 100);
  // Incidents appear on the status page.
  assert.equal((await op.submit(DOMAIN, '/operator', '/operator/incidents', { title: 'Trage router', body: 'Pagina’s laden langzaam.', impact: 'minor' })).status, 303);
  const withIncident = JSON.parse((await hreq(base, { path: '/status.json', host: DOMAIN })).body);
  assert.equal(withIncident.overall, 'minor');
  assert.equal(withIncident.incidents[0].title, 'Trage router');
  const [inc] = await cloud.db.query("SELECT id FROM incidents WHERE title = 'Trage router'");
  assert.equal((await op.submit(DOMAIN, '/operator', `/operator/incidents/${inc.id}/resolve`, {})).status, 303);
  assert.equal(JSON.parse((await hreq(base, { path: '/status.json', host: DOMAIN })).body).overall, 'ok');
});

test('cloud: cancel → export offered → deleted after retention; slug never reused', async () => {
  assert.equal((await webhook({ id: 'evt_del_1', type: 'customer.subscription.deleted', data: { object: { id: 'sub_bravo', status: 'canceled', metadata: { workspace_id: bravo.id } } } })).status, 200);
  const ws = await reload(bravo);
  assert.equal(ws.status, 'suspended');
  assert.equal(ws.status_reason, 'canceled');
  assert.ok(ws.delete_after && new Date(ws.delete_after).getTime() - clock.now().getTime() > 29 * 864e5);
  const detail = await bram.go(DOMAIN, `/workspaces/${bravo.id}`);
  assert.match(detail.body, /We verwijderen alles op/);

  // Export of the (stopped) instance: consistent database + files + master key.
  const ex = await bram.submit(DOMAIN, `/workspaces/${bravo.id}`, `/workspaces/${bravo.id}/export`, {});
  assert.equal(ex.status, 303);
  const [row] = await cloud.workspaces.exports(bravo.id);
  assert.ok(row);
  const dl = await new Promise<Buffer>((resolve, reject) => {
    const u = new URL(base);
    http
      .get({ host: u.hostname, port: u.port, path: `/workspaces/${bravo.id}/exports/${row.id}`, headers: { host: DOMAIN, cookie: `tbc_session=${bram.cookies(DOMAIN).get('tbc_session')}` } }, (res) => {
        assert.equal(res.statusCode, 200);
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
  const zip = new AdmZip(dl);
  const names = zip.getEntries().map((e) => e.entryName);
  for (const n of ['teambot.db', 'master.key', 'LEESMIJ.txt']) assert.ok(names.includes(n), n);
  assert.equal(zip.readAsText('master.key').length, 44);
  // Nobody else can download it — not another customer, not the operator.
  assert.equal((await anna.go(DOMAIN, `/workspaces/${bravo.id}/exports/${row.id}`)).status, 404);
  assert.equal((await op.go(DOMAIN, `/workspaces/${bravo.id}/exports/${row.id}`)).status, 404);

  const dir = (ws.instance as ProcessInfo).dir;
  assert.ok(fs.existsSync(dir));
  clock.advanceDays(29);
  await cloud.billing.enforce();
  assert.equal((await reload(bravo)).status, 'suspended', 'still within retention');
  clock.advanceDays(2);
  await cloud.billing.enforce();
  const gone = await reload(bravo);
  assert.equal(gone.status, 'deleted');
  assert.equal(gone.master_key_enc, null);
  assert.deepEqual(gone.instance, {});
  assert.equal(fs.existsSync(dir), false, 'data dir removed');
  assert.equal((await cloud.workspaces.exports(bravo.id)).length, 0);
  assert.equal(fs.existsSync(path.join(tmp, 'exports', bravo.id)), false, 'exports removed');
  assert.equal((await hreq(base, { path: '/', host: 'bravo.cloud.test', headers: { accept: 'text/html' } })).status, 404);
  // More than 30 (fake) days passed: the old session expired, like it would for a real customer.
  assert.equal((await bram.go(DOMAIN, '/dashboard')).status, 303);
  await bram.submit(DOMAIN, '/login', '/login', B);
  const again = await bram.submit(DOMAIN, '/workspaces/new', '/workspaces', { name: 'Bravo 2', slug: 'bravo' });
  assert.equal(again.status, 409);
});

test('cloud: owner deletes a workspace with typed confirmation', async () => {
  await anna.submit(DOMAIN, '/login', '/login', A);
  const ws = await reload(alpha);
  const dir = (ws.instance as ProcessInfo).dir;
  const wrong = await anna.submit(DOMAIN, `/workspaces/${alpha.id}`, `/workspaces/${alpha.id}/delete`, { confirm: 'alfa' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body, /Typ precies/);
  assert.equal((await reload(alpha)).status, 'suspended');
  // Bram cannot delete Anna's workspace.
  assert.equal((await bram.submit(DOMAIN, '/dashboard', `/workspaces/${alpha.id}/delete`, { confirm: 'alpha' })).status, 404);
  const ok = await anna.submit(DOMAIN, `/workspaces/${alpha.id}`, `/workspaces/${alpha.id}/delete`, { confirm: 'alpha' });
  assert.equal(ok.status, 303);
  assert.equal((await reload(alpha)).status, 'deleted');
  assert.equal(fs.existsSync(dir), false);
  const kinds = (await cloud.db.query<{ kind: string }>('SELECT kind FROM audit WHERE workspace_id = $1', [alpha.id])).map((r) => r.kind);
  for (const k of ['workspace.created', 'workspace.provisioned', 'workspace.owner_claimed', 'workspace.suspended', 'workspace.resumed', 'workspace.deleted']) assert.ok(kinds.includes(k), k);
});

test('cloud: manual billing mode (no Stripe): operator sets plan and status', async () => {
  // A stub provisioner: this test is about the billing flow, not processes.
  const running = new Set<string>();
  const stub: Provisioner = {
    kind: 'process',
    async create(spec) {
      return { kind: 'process', id: spec.workspaceId };
    },
    async start(info) {
      running.add(String(info.id));
      return info;
    },
    async stop(info) {
      running.delete(String(info.id));
    },
    async remove(info) {
      running.delete(String(info.id));
    },
    async health(info) {
      return running.has(String(info.id));
    },
    upstream: (info) => (running.has(String(info.id)) ? { host: '127.0.0.1', port: 9 } : null),
    async exportData() {},
    async shutdown() {},
  };
  const c2 = new FakeClock(new Date());
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cloud-manual-'));
  const m = await createCloud({ env: {}, config: { url: 'http://manual.test', listenPort: 0, dataDir: dir2, secretKey: crypto.randomBytes(32), healthIntervalMs: 0, enforceIntervalMs: 0, quiet: true }, clock: c2, provisioner: stub, pgliteDir: null });
  try {
    assert.equal(m.billing.mode, 'manual');
    const u = new Browser(m.listenUrl);
    await u.submit('manual.test', '/signup', '/signup', { email: 'klant@example.nl', password: 'klant-wachtwoord' });
    await u.submit('manual.test', '/workspaces/new', '/workspaces', { name: 'Klant', slug: 'klant' });
    await m.workspaces.idle();
    const [ws] = await m.workspaces.listForOwner((await m.accounts.byEmail('klant@example.nl'))!.id);
    assert.equal(ws.status, 'active');
    const detail = await u.go('manual.test', `/workspaces/${ws.id}`);
    assert.match(detail.body, /Betalen gaat \(nog\) niet online/);
    assert.equal((await u.submit('manual.test', `/workspaces/${ws.id}`, `/workspaces/${ws.id}/checkout`, { plan: 'starter' })).status, 400);
    assert.equal((await hreq(m.listenUrl, { method: 'POST', path: '/stripe/webhook', host: 'manual.test', body: '{}' })).status, 404, 'no webhook without Stripe');

    c2.advanceDays(15);
    await m.billing.enforce();
    assert.equal((await m.workspaces.get(ws.id))!.status_reason, 'trial_ended');
    const opB = new Browser(m.listenUrl);
    await opB.submit('manual.test', '/signup', '/signup', { email: 'op@example.nl', password: 'op-wachtwoord-123' });
    await m.accounts.setRole('op@example.nl', 'operator');
    assert.equal((await opB.submit('manual.test', '/operator', `/operator/workspaces/${ws.id}/billing`, { plan: 'team', status: 'active' })).status, 303);
    const after = (await m.workspaces.get(ws.id))!;
    assert.equal(after.status, 'active');
    assert.equal(after.plan, 'team');
    assert.equal((await opB.submit('manual.test', '/operator', `/operator/workspaces/${ws.id}/billing`, { plan: 'team', status: 'canceled' })).status, 303);
    const canceled = (await m.workspaces.get(ws.id))!;
    assert.equal(canceled.status, 'suspended');
    assert.ok(canceled.delete_after);
  } finally {
    await m.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});
