// Managed cloud, dedicated deployments + SLA monitoring (CLD-05): customer-run instances are registered, never
// provisioned, monitored from outside (SSRF-guarded), with per-workspace uptime, automatic incidents and
// maintenance windows that are excluded from uptime.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCloud, type CloudHandle } from '../cloud/server.js';
import { FakeClock, toLocalInput, zonedTimeToUtc } from '../cloud/util.js';
import { checkInstance, isPublicAddress, validateInstanceUrl } from '../cloud/health.js';
import { sha256 } from '../cloud/crypto.js';
import type { Provisioner } from '../cloud/provisioner/types.js';
import type { Workspace } from '../cloud/workspaces.js';

const DOMAIN = 'cloud.test';
const TZ = 'Europe/Amsterdam';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function hreq(base: string, o: { method?: string; path: string; host: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
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

class Browser {
  jar = new Map<string, string>();
  constructor(public base: string) {}
  async go(p: string, form?: Record<string, string>): Promise<Res> {
    const headers: Record<string, string> = { accept: 'text/html' };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await hreq(this.base, { method: form ? 'POST' : 'GET', path: p, host: DOMAIN, headers, body });
    for (const c of ([] as string[]).concat(res.headers['set-cookie'] || [])) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
  async submit(pagePath: string, action: string, form: Record<string, string>) {
    const csrf = /name="_csrf" value="([^"]+)"/.exec((await this.go(pagePath)).body)?.[1];
    assert.ok(csrf, `geen CSRF-token op ${pagePath}`);
    return this.go(action, { _csrf: csrf!, ...form });
  }
}

/** Fake dedicated TeamBot: /healthz answers according to `mode`. */
let mode: 'up' | 'down' | 'html' | 'redirect-same' | 'redirect-other' | 'hang' = 'up';
let hits = 0;
let fake: http.Server;
let other: http.Server;
let fakeUrl = '';
let otherUrl = '';

// ---------------------------------------------------------------- unit: address checks

test('dedicated: only public addresses count as public (incl. IPv4-in-IPv6, NAT64, metadata)', () => {
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '224.0.0.1', 'nonsense']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('dedicated: instance URL validation (https only, public, no credentials/paths, not our own domain)', async () => {
  const resolve = async (h: string) => (h === 'teambot.klant.nl' ? ['93.184.216.34'] : h === 'intern.klant.nl' ? ['10.0.0.5'] : h === 'mixed.klant.nl' ? ['93.184.216.34', '127.0.0.1'] : []);
  const v = (u: string, allowPrivate = false) => validateInstanceUrl(u, { allowPrivate, cloudDomain: DOMAIN, resolve });
  assert.equal(await v('https://teambot.klant.nl/'), 'https://teambot.klant.nl');
  assert.equal(await v('https://TeamBot.Klant.nl:8443'), 'https://teambot.klant.nl:8443');
  const bad: [string, RegExp][] = [
    ['http://teambot.klant.nl', /https/],
    ['ftp://teambot.klant.nl', /https/],
    ['https://user:pw@teambot.klant.nl', /gebruikersnaam/],
    ['https://teambot.klant.nl/pad', /basisadres/],
    ['https://teambot.klant.nl/?a=1', /basisadres/],
    ['https://127.0.0.1', /niet publiek/],
    ['https://[::1]', /niet publiek/],
    ['https://169.254.169.254', /niet publiek/],
    ['https://[::ffff:10.0.0.1]', /niet publiek/],
    ['https://localhost', /publieke domeinnaam/],
    ['https://teambot.local', /publieke domeinnaam/],
    ['https://intranet', /publieke domeinnaam/],
    ['https://intern.klant.nl', /privé/],
    ['https://mixed.klant.nl', /privé/],
    ['https://bestaatniet.klant.nl', /privé|bestaat/],
    ['https://cloud.test', /TeamBot Cloud zelf/],
    ['https://alpha.cloud.test', /TeamBot Cloud zelf/],
    ['geen url', /geldig/],
  ];
  for (const [u, re] of bad) await assert.rejects(v(u), re, u);
  // Development flag: http and loopback are allowed (local tests only).
  assert.equal(await v('http://127.0.0.1:4747', true), 'http://127.0.0.1:4747');
});

test('dedicated: maintenance times are entered in the cloud time zone', () => {
  assert.equal(zonedTimeToUtc('2026-07-01T22:00', TZ)!.toISOString(), '2026-07-01T20:00:00.000Z'); // CEST
  assert.equal(zonedTimeToUtc('2026-01-15T22:00', TZ)!.toISOString(), '2026-01-15T21:00:00.000Z'); // CET
  assert.equal(toLocalInput(new Date('2026-07-01T20:00:00Z'), TZ), '2026-07-01T22:00');
  assert.equal(zonedTimeToUtc('morgen', TZ), null);
});

// ---------------------------------------------------------------- integration

let cloud: CloudHandle;
let clock: FakeClock;
let tmp: string;
const provisionerCalls: string[] = [];
const klant = { email: 'klant@example.nl', password: 'klant-wachtwoord-1' };
let owner: Browser;
let stranger: Browser;
let op: Browser;
let ws: Workspace;
let setupToken = '';

before(async () => {
  fake = http.createServer((req, res) => {
    hits++;
    if (req.url !== '/healthz' && req.url !== '/healthz/') return res.writeHead(404).end();
    if (mode === 'hang') return; // never answers
    if (mode === 'down') return res.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false}');
    if (mode === 'html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>parked domain</h1>');
    if (mode === 'redirect-other') return res.writeHead(302, { location: `${otherUrl}/healthz` }).end();
    if (mode === 'redirect-same' && req.url === '/healthz') return res.writeHead(301, { location: '/healthz/' }).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"version":"0.1.0"}');
  });
  other = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as any).port}`;
  otherUrl = `http://127.0.0.1:${(other.address() as any).port}`;

  // Every provisioner call is recorded: a dedicated workspace must never cause one.
  const stub: Provisioner = {
    kind: 'process',
    async create() {
      provisionerCalls.push('create');
      return { kind: 'process' };
    },
    async start(info) {
      provisionerCalls.push('start');
      return info;
    },
    async stop() {
      provisionerCalls.push('stop');
    },
    async remove() {
      provisionerCalls.push('remove');
    },
    async health() {
      provisionerCalls.push('health');
      return true;
    },
    upstream: () => (provisionerCalls.push('upstream'), null),
    async exportData() {
      provisionerCalls.push('export');
    },
    async shutdown() {},
  };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cloud-ded-'));
  clock = new FakeClock('2026-03-02T09:00:00Z');
  cloud = await createCloud({
    env: { CLOUD_TZ: TZ },
    config: {
      url: `http://${DOMAIN}`,
      listenPort: 0,
      dataDir: tmp,
      secretKey: crypto.randomBytes(32),
      healthIntervalMs: 0,
      enforceIntervalMs: 0,
      quiet: true,
      timeZone: TZ,
      incidentAfterFailures: 3,
      maintenanceNoticeHours: 48,
      dedicated: { allowPrivate: false, timeoutMs: 1500 },
    },
    clock,
    provisioner: stub,
    pgliteDir: null,
  });
  owner = new Browser(cloud.listenUrl);
  stranger = new Browser(cloud.listenUrl);
  op = new Browser(cloud.listenUrl);
  await owner.submit('/signup', '/signup', { email: klant.email, name: 'Klant', password: klant.password });
  await stranger.submit('/signup', '/signup', { email: 'ander@example.nl', password: 'ander-wachtwoord-1' });
  await op.submit('/signup', '/signup', { email: 'beheer@example.nl', password: 'beheer-wachtwoord-1' });
  await cloud.accounts.setRole('beheer@example.nl', 'operator');
});

after(async () => {
  try {
    await cloud?.close();
  } finally {
    fake?.close();
    other?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('dedicated: health checker (up, errors, timeout, same-origin redirect, cross-host redirect refused, SSRF guard)', async () => {
  const o = { allowPrivate: true, timeoutMs: 400 };
  mode = 'up';
  assert.equal((await checkInstance(fakeUrl, o)).ok, true);
  mode = 'down';
  assert.deepEqual({ ...(await checkInstance(fakeUrl, o)), ms: 0 }, { ok: false, status: 503, error: 'HTTP 503', ms: 0 });
  mode = 'html';
  assert.match((await checkInstance(fakeUrl, o)).error!, /geen TeamBot/);
  mode = 'redirect-same';
  assert.equal((await checkInstance(fakeUrl, o)).ok, true, 'redirect within the same origin is followed');
  mode = 'redirect-other';
  const cross = await checkInstance(fakeUrl, o);
  assert.equal(cross.ok, false);
  assert.match(cross.error!, /ander adres geweigerd/);
  mode = 'hang';
  const slow = await checkInstance(fakeUrl, o);
  assert.equal(slow.ok, false);
  assert.match(slow.error!, /geen antwoord/);
  mode = 'up';
  // Without the development flag: a private address is refused before connecting, also when DNS points there.
  const before = hits;
  assert.match((await checkInstance(fakeUrl, { allowPrivate: false, timeoutMs: 400 })).error!, /https|privé/);
  const viaDns = await checkInstance(`https://teambot.klant.nl:${(fake.address() as any).port}`, { allowPrivate: false, timeoutMs: 400, resolve: async () => ['127.0.0.1'] });
  assert.equal(viaDns.ok, false);
  assert.match(viaDns.error!, /privé/);
  assert.equal(hits, before, 'no request reached the private address');
});

test('dedicated: operator-only routes are enforced', async () => {
  const routes: [string, Record<string, string> | null][] = [
    ['/operator', null],
    ['/operator/dedicated', { email: klant.email, name: 'X', slug: 'xxx', url: 'https://teambot.klant.nl' }],
    ['/operator/maintenance', { title: 'X', starts: '2026-03-10T22:00', ends: '2026-03-10T23:00' }],
    ['/operator/maintenance/mnt_x/cancel', {}],
    ['/operator/workspaces/ws_xxxxxxxxxx', null],
    ['/operator/workspaces/ws_xxxxxxxxxx/url', { url: 'https://teambot.klant.nl' }],
    ['/operator/workspaces/ws_xxxxxxxxxx/setup-token', {}],
  ];
  for (const [p, form] of routes) {
    const r = form ? await owner.submit('/dashboard', p, form) : await owner.go(p);
    assert.equal(r.status, 403, p);
  }
  assert.equal((await new Browser(cloud.listenUrl).go('/operator')).status, 303, 'anonymous → login');
});

test('dedicated: registering validates the address, shows the setup token once and never provisions', async () => {
  const reg = (form: Record<string, string>) => op.submit('/operator', '/operator/dedicated', { email: klant.email, name: 'Klant BV', slug: 'klant-bv', ...form });
  // Production rules: https and a public address only.
  assert.match((await reg({ url: fakeUrl })).body, /Alleen https/);
  assert.match((await reg({ url: 'https://127.0.0.1' })).body, /niet publiek/);
  assert.match((await reg({ url: 'https://intranet' })).body, /publieke domeinnaam/);
  assert.match((await op.submit('/operator', '/operator/dedicated', { email: 'onbekend@example.nl', name: 'X', slug: 'xxx', url: 'https://1.1.1.1' })).body, /Geen account/);
  assert.equal((await cloud.db.query("SELECT COUNT(*)::int AS n FROM workspaces WHERE deployment = 'dedicated'"))[0].n, 0);

  // Local test instance on 127.0.0.1: only with the explicit development flag.
  cloud.cfg.dedicated.allowPrivate = true;
  const ok = await reg({ url: fakeUrl });
  assert.equal(ok.status, 200);
  setupToken = /TEAMBOT_SETUP_TOKEN=([A-Za-z0-9_-]+)/.exec(ok.body)?.[1] || '';
  assert.ok(setupToken.length >= 40);
  assert.match(ok.body, /TEAMBOT_MAX_USERS=100/);
  assert.match(ok.body, new RegExp(`TEAMBOT_PUBLIC_URL=${fakeUrl.replace(/[.:/]/g, '\\$&')}`));
  assert.match(ok.body, /niet opnieuw getoond/);
  [ws] = await cloud.db.query<Workspace>("SELECT * FROM workspaces WHERE deployment = 'dedicated'");
  assert.equal(ws.status, 'active');
  assert.equal(ws.plan, 'dedicated');
  assert.equal(ws.master_key_enc, null, 'we never hold the master key of a dedicated instance');
  assert.equal(ws.setup_token_hash, sha256(setupToken));
  const sub = (await cloud.billing.subscription(ws.id))!;
  assert.equal(sub.provider, 'manual');
  assert.equal(sub.status, 'active');
  // The token is stored nowhere in plain text.
  const dump = JSON.stringify([await cloud.db.query('SELECT * FROM workspaces'), await cloud.db.query('SELECT * FROM audit')]);
  assert.ok(!dump.includes(setupToken));
  // Shown once: the operator page for the workspace does not show it again.
  const detail = await op.go(`/operator/workspaces/${ws.id}`);
  assert.equal(detail.status, 200);
  assert.ok(!detail.body.includes(setupToken));
  // A new token can be made (old one stops matching).
  const rot = await op.submit(`/operator/workspaces/${ws.id}`, `/operator/workspaces/${ws.id}/setup-token`, {});
  const rotated = /TEAMBOT_SETUP_TOKEN=([A-Za-z0-9_-]+)/.exec(rot.body)?.[1];
  assert.ok(rotated && rotated !== setupToken);
  assert.equal((await cloud.workspaces.get(ws.id))!.setup_token_hash, sha256(rotated!));

  // No proxying through our router, no certificate, no provisioner call.
  assert.equal((await hreq(cloud.listenUrl, { path: '/healthz', host: `klant-bv.${DOMAIN}`, headers: { accept: 'text/html' } })).status, 404);
  assert.equal((await hreq(cloud.listenUrl, { path: `/_tls/ask?domain=klant-bv.${DOMAIN}`, host: 'intern' })).status, 404);
  assert.deepEqual(provisionerCalls, []);

  // The owner sees it, opens the customer's own address, and gets honest export/delete texts.
  const dash = await owner.go('/dashboard');
  assert.match(dash.body, /Dedicated/);
  assert.ok(dash.body.includes(`href="${fakeUrl}"`), 'Openen links straight to the customer address');
  const page = await owner.go(`/workspaces/${ws.id}`);
  assert.match(page.body, /eigen server/);
  assert.match(page.body, /wij hebben er geen kopie van/);
  assert.match(page.body, /Je eigen server en de data daarop blijven staan/);
  assert.match((await owner.submit(`/workspaces/${ws.id}`, `/workspaces/${ws.id}/export`, {})).body, /eigen server/);
  assert.match((await owner.submit(`/workspaces/${ws.id}`, `/workspaces/${ws.id}/claim`, {})).body, /setup-link/);
  // Operator billing: a dedicated workspace keeps a dedicated plan.
  assert.equal((await op.submit('/operator', `/operator/workspaces/${ws.id}/billing`, { plan: 'starter', status: 'active' })).status, 400);
  assert.deepEqual(provisionerCalls, []);
});

test('dedicated: health checks feed uptime, open and resolve incidents, status page shows counts only', async () => {
  const sweep = () => cloud.monitoring.sweep();
  mode = 'up';
  await sweep();
  await sweep();
  let u = await cloud.monitoring.uptime(ws.id, 30);
  assert.deepEqual([u.checks, u.ok, u.pct], [2, 2, 100]);
  mode = 'down';
  await sweep();
  await sweep();
  assert.equal((await cloud.monitoring.incidentsFor(ws.id)).length, 0, 'two failures: no incident yet');
  await sweep();
  const [inc] = await cloud.monitoring.incidentsFor(ws.id);
  assert.equal(inc.status, 'open');
  assert.equal(inc.auto, true);
  assert.match(inc.body, /HTTP 503/);
  const cur = (await cloud.workspaces.get(ws.id))!;
  assert.equal(cur.health, 'unhealthy');
  assert.equal(cur.health_fail_streak, 3);
  await sweep(); // still down: no second incident
  assert.equal((await cloud.monitoring.incidentsFor(ws.id)).length, 1);

  // Public status: counts only (dedicated separately), no names/addresses, the workspace incident stays private.
  const json = JSON.parse((await hreq(cloud.listenUrl, { path: '/status.json', host: DOMAIN })).body);
  assert.deepEqual(json.dedicated, { healthy: 0, unhealthy: 1 });
  assert.deepEqual(json.workspaces, { healthy: 0, unhealthy: 0, suspended: 0, provisioning: 0 });
  assert.deepEqual(json.incidents, []);
  assert.equal(json.overall, 'ok', "one customer's own server down is not a platform outage");
  const html = (await hreq(cloud.listenUrl, { path: '/status', host: DOMAIN })).body;
  assert.match(html, /1 niet bereikbaar/);
  for (const secret of ['klant-bv', 'Klant BV', fakeUrl, '127.0.0.1', klant.email, 'Niet bereikbaar</']) assert.ok(!html.includes(secret), `status page leaks ${secret}`);

  // Owner and operator see the uptime and the incident; another account does not.
  const mine = await owner.go(`/workspaces/${ws.id}`);
  assert.match(mine.body, /Niet bereikbaar/);
  assert.match(mine.body, /Lopend/);
  assert.match(mine.body, /33,33%/); // 2 of 6
  assert.equal((await stranger.go(`/workspaces/${ws.id}`)).status, 404);
  const opPage = await op.go(`/operator/workspaces/${ws.id}`);
  assert.match(opPage.body, /Niet bereikbaar/);
  assert.match((await op.go('/operator')).body, /Lopende storingen per workspace/);

  mode = 'up';
  await sweep();
  const [resolved] = await cloud.monitoring.incidentsFor(ws.id);
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.updates.some((x) => /Weer bereikbaar/.test(x.text)));
  u = await cloud.monitoring.uptime(ws.id, 30);
  assert.deepEqual([u.checks, u.ok], [7, 3]);
  assert.equal((await cloud.workspaces.get(ws.id))!.health_fail_streak, 0);
});

test('dedicated: announced maintenance is excluded from uptime, short-notice maintenance counts', async () => {
  const before = await cloud.monitoring.uptime(ws.id, 90);
  // Announced through the operator console, in local time, three days ahead: excluded.
  const start = new Date(clock.now().getTime() + 3 * 864e5);
  const end = new Date(start.getTime() + 2 * 3600_000);
  const r = await op.submit('/operator', '/operator/maintenance', { title: 'Update naar 0.3', body: 'Even geen toegang.', starts: toLocalInput(start, TZ), ends: toLocalInput(end, TZ), workspace: '' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/operator?m=onderhoud-gepland');
  const statusBefore = (await hreq(cloud.listenUrl, { path: '/status', host: DOMAIN })).body;
  assert.match(statusBefore, /Gepland onderhoud/);
  assert.match(statusBefore, /Update naar 0\.3/);
  assert.match((await owner.go(`/workspaces/${ws.id}`)).body, /Update naar 0\.3/, 'owner sees platform maintenance too');
  // Backdated or nonsensical windows are refused (no erasing downtime afterwards).
  const past = new Date(clock.now().getTime() - 3600_000);
  assert.match((await op.submit('/operator', '/operator/maintenance', { title: 'Achteraf', starts: toLocalInput(past, TZ), ends: toLocalInput(start, TZ) })).body, /verleden/);
  assert.match((await op.submit('/operator', '/operator/maintenance', { title: 'Omgekeerd', starts: toLocalInput(end, TZ), ends: toLocalInput(start, TZ) })).body, /na de begintijd/);

  clock.set(new Date(start.getTime() + 30 * 60_000));
  const during = JSON.parse((await hreq(cloud.listenUrl, { path: '/status.json', host: DOMAIN })).body);
  assert.equal(during.overall, 'maintenance');
  mode = 'down';
  for (let i = 0; i < 4; i++) await cloud.monitoring.sweep();
  let u = await cloud.monitoring.uptime(ws.id, 90);
  assert.deepEqual([u.checks, u.ok], [before.checks, before.ok], 'checks during announced maintenance are not counted');
  assert.equal((await cloud.monitoring.incidentsFor(ws.id)).filter((i) => i.status === 'open').length, 0, 'no incident during maintenance');

  // After the window, failures count again.
  clock.set(new Date(end.getTime() + 60_000));
  await cloud.monitoring.sweep();
  u = await cloud.monitoring.uptime(ws.id, 90);
  assert.equal(u.checks, before.checks + 1);

  // Short notice (1 hour ahead, only this workspace): shown, but it counts as downtime.
  const soon = new Date(clock.now().getTime() + 3600_000);
  const short = await op.submit('/operator', '/operator/maintenance', { title: 'Spoedupdate', starts: toLocalInput(soon, TZ), ends: toLocalInput(new Date(soon.getTime() + 3600_000), TZ), workspace: ws.id });
  assert.equal(short.headers.location, '/operator?m=onderhoud-kort');
  assert.ok(!(await hreq(cloud.listenUrl, { path: '/status', host: DOMAIN })).body.includes('Spoedupdate'), 'workspace maintenance is not public');
  assert.match((await owner.go(`/workspaces/${ws.id}`)).body, /Spoedupdate[\s\S]*telt mee als uitval/);
  clock.set(new Date(soon.getTime() + 10 * 60_000));
  await cloud.monitoring.sweep();
  await cloud.monitoring.sweep();
  u = await cloud.monitoring.uptime(ws.id, 90);
  assert.equal(u.checks, before.checks + 3);
  assert.equal((await cloud.monitoring.incidentsFor(ws.id)).filter((i) => i.status === 'open').length, 1, 'third failure in a row opens an incident');

  // Cancel an upcoming window.
  const later = await cloud.monitoring.announce({ title: 'Later', startsAt: new Date(clock.now().getTime() + 5 * 864e5), endsAt: new Date(clock.now().getTime() + 5 * 864e5 + 3600_000) }, { actor: 'operator' });
  assert.equal(later.excluded, true);
  const [mnt] = await cloud.db.query("SELECT id FROM maintenance WHERE title = 'Later'");
  assert.equal((await op.submit('/operator', `/operator/maintenance/${mnt.id}/cancel`, {})).status, 303);
  assert.ok(!(await cloud.monitoring.upcoming('all')).some((m) => m.title === 'Later'));
  mode = 'up';
  await cloud.monitoring.sweep();
});

test('dedicated: suspend = licence/support status (server keeps running), resume and delete never touch it', async () => {
  assert.equal((await op.submit('/operator', `/operator/workspaces/${ws.id}/suspend`, {})).status, 303);
  let cur = (await cloud.workspaces.get(ws.id))!;
  assert.equal(cur.status, 'suspended');
  assert.match((await owner.go(`/workspaces/${ws.id}`)).body, /licentie en support zijn gepauzeerd/);
  assert.equal((await checkInstance(fakeUrl, { allowPrivate: true, timeoutMs: 1000 })).ok, true, 'their server still runs');
  const checksBefore = (await cloud.monitoring.uptime(ws.id, 90)).checks;
  await cloud.monitoring.sweep();
  assert.equal((await cloud.monitoring.uptime(ws.id, 90)).checks, checksBefore, 'no SLA measurement while suspended');
  assert.equal((await op.submit('/operator', `/operator/workspaces/${ws.id}/resume`, {})).status, 303);
  assert.equal((await cloud.workspaces.get(ws.id))!.status, 'active');
  // The address can be changed (validated the same way).
  cloud.cfg.dedicated.allowPrivate = false;
  assert.match((await op.submit(`/operator/workspaces/${ws.id}`, `/operator/workspaces/${ws.id}/url`, { url: 'http://teambot.klant.nl' })).body, /https/);
  cloud.cfg.dedicated.allowPrivate = true;
  // Delete by the owner: the registration ends, their server is untouched.
  const del = await owner.submit(`/workspaces/${ws.id}`, `/workspaces/${ws.id}/delete`, { confirm: 'klant-bv' });
  assert.equal(del.status, 303);
  cur = (await cloud.workspaces.get(ws.id))!;
  assert.equal(cur.status, 'deleted');
  assert.equal(cur.external_url, null);
  assert.equal(cur.setup_token_hash, null);
  assert.equal((await checkInstance(fakeUrl, { allowPrivate: true, timeoutMs: 1000 })).ok, true);
  assert.deepEqual(provisionerCalls, [], 'not a single provisioner call for a dedicated workspace');
});
