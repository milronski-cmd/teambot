// Managed cloud, CLD-05 completion: monthly SLA reports (immutable), service credits (operator approval, Stripe
// balance credit or "te verrekenen"), outbound alerts (signed webhooks, e-mail, rate limit, SSRF guard).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCloud, type CloudHandle } from '../cloud/server.js';
import { calendarDays, FakeClock, localDay, monthOf, monthRange } from '../cloud/util.js';
import { evaluate, reportCsv, type SlaReport } from '../cloud/reports.js';
import { loadPlans } from '../cloud/billing/plans.js';
import { postWebhook } from '../cloud/health.js';
import { signAlert } from '../cloud/alerts.js';
import { hmacHex } from '../cloud/crypto.js';
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

// ---------------------------------------------------------------- unit

test('reports: month boundaries and local days follow Europe/Amsterdam (DST)', () => {
  const oct = monthRange('2026-10', TZ); // CEST at the start, CET at the end (DST ends 25 Oct)
  assert.equal(oct.start.toISOString(), '2026-09-30T22:00:00.000Z');
  assert.equal(oct.end.toISOString(), '2026-10-31T23:00:00.000Z');
  const mar = monthRange('2026-03', TZ); // DST starts 29 Mar
  assert.equal(mar.start.toISOString(), '2026-02-28T23:00:00.000Z');
  assert.equal(mar.end.toISOString(), '2026-03-31T22:00:00.000Z');
  const dec = monthRange('2026-12', TZ);
  assert.equal(dec.end.toISOString(), '2026-12-31T23:00:00.000Z');
  assert.equal(dec.nextFirstDay, '2027-01-01');
  assert.equal(localDay(new Date('2026-10-31T22:59:00Z'), TZ), '2026-10-31');
  assert.equal(localDay(new Date('2026-10-31T23:00:00Z'), TZ), '2026-11-01');
  assert.equal(localDay(new Date('2026-03-31T21:59:00Z'), TZ), '2026-03-31');
  assert.equal(localDay(new Date('2026-03-31T22:00:00Z'), TZ), '2026-04-01');
  assert.equal(monthOf(new Date('2026-10-31T23:30:00Z'), TZ), '2026-11');
  assert.equal(monthOf(new Date('2026-01-15T12:00:00Z'), TZ, -1), '2025-12');
  assert.deepEqual(calendarDays('2026-03-30', 3), ['2026-03-28', '2026-03-29', '2026-03-30']);
  assert.throws(() => monthRange('2026-13', TZ));
});

test('reports: credit table edges are exact (strictly below a threshold, most severe tier wins)', () => {
  // The example table from the task: < 99.9% → 10%, < 99% → 25%, < 95% → 50%.
  const plan = { slaTarget: 99.9, credits: [{ below: 99.9, pct: 10 }, { below: 99.0, pct: 25 }, { below: 95.0, pct: 50 }] };
  const ev = (ok: number, checks: number) => {
    const r = evaluate(plan, ok, checks);
    return r.result === 'not_met' ? r.tier?.pct ?? 0 : r.result;
  };
  assert.equal(ev(999, 1000), 'met', 'exactly 99.9% meets the target (no float error)');
  assert.equal(ev(100_000, 100_000), 'met');
  assert.equal(ev(99_899, 100_000), 10);
  assert.equal(ev(990, 1000), 10, 'exactly 99% is not below 99%');
  assert.equal(ev(98_999, 100_000), 25);
  assert.equal(ev(950, 1000), 25, 'exactly 95% is not below 95%');
  assert.equal(ev(94_999, 100_000), 50);
  assert.equal(ev(0, 1000), 50);
  assert.equal(ev(0, 0), 'no_data');
  assert.equal(evaluate({ slaTarget: null, credits: [] }, 1, 100).result, 'no_target');
  // A target without a matching tier: not met, but no credit.
  assert.deepEqual(evaluate({ slaTarget: 99.9, credits: [{ below: 99, pct: 25 }] }, 9_950, 10_000), { result: 'not_met', tier: null });
  // Defaults are example values and config-driven; tables are sorted and validated.
  const plans = loadPlans({ CLOUD_PLANS: JSON.stringify([{ id: 'team', credits: [{ below: 95, pct: 50 }, { below: 99.9, pct: 10 }] }]) });
  const team = plans.find((p) => p.id === 'team')!;
  assert.deepEqual(team.credits, [{ below: 99.9, pct: 10 }, { below: 95, pct: 50 }]);
  assert.equal(plans.find((p) => p.id === 'starter')!.slaTarget, 99.5);
  assert.equal(plans.find((p) => p.id === 'dedicated')!.slaTarget, null);
  assert.throws(() => loadPlans({ CLOUD_PLANS: JSON.stringify([{ id: 'team', credits: [{ below: 120, pct: 10 }] }]) }), /credit-regel/);
});

test('reports: CSV is RFC 4180 and safe against spreadsheet formula injection', () => {
  const r = {
    format: 1,
    workspace: { id: 'ws_x', slug: 'alpha', name: '=HYPERLINK("evil")', deployment: 'shared' },
    month: '2026-10',
    period: { start: '2026-09-30T22:00:00.000Z', end: '2026-10-31T23:00:00.000Z', timeZone: TZ },
    plan: { id: 'team', name: 'Team', slaTarget: 99.9, monthlyPriceCents: 2900, currency: 'eur', credits: [] },
    measurement: { checks: 10, ok: 9, failed: 1, uptimePct: 90, excludedChecks: 0, intervalSec: 30, estimatedDowntimeMinutes: 1 },
    maintenance: [{ title: 'Update, "groot"', scope: 'platform', start: 'a', end: 'b', minutes: 60, excluded: true }],
    incidents: [{ id: 'inc_1', title: '+cmd', scope: 'workspace', start: 'a', end: null, minutes: 5, ongoing: true }],
    result: 'not_met',
    credit: { pct: 50, amountCents: 1450, currency: 'eur', rule: '< 95%' },
    generatedAt: 'x',
    generatedBy: 'system',
  } as SlaReport;
  const csv = reportCsv(r, null);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^type,workspace,month,/);
  assert.match(lines[1], /^summary,alpha,2026-10,"'=HYPERLINK\(""evil""\)"/);
  assert.match(lines[1], /,14\.50,eur,$/);
  assert.match(lines[2], /"Update, ""groot"""/);
  assert.match(lines[3], /^incident,alpha,2026-10,'\+cmd,/);
});

test('alerts: webhook delivery refuses private addresses, DNS to private and redirects', async () => {
  let hits = 0;
  const srv = http.createServer((_req, res) => {
    hits++;
    res.writeHead(302, { location: 'https://elders.example/' }).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/hook`;
  try {
    assert.match((await postWebhook(url, '{}', {}, { allowPrivate: false, timeoutMs: 1000 })).error!, /https/);
    const viaDns = await postWebhook(`https://hooks.klant.test:${(srv.address() as any).port}/hook`, '{}', {}, { allowPrivate: false, timeoutMs: 1000, resolve: async () => ['10.0.0.7'] });
    assert.match(viaDns.error!, /privé/);
    assert.equal(hits, 0, 'nothing reached a private address');
    const redirect = await postWebhook(url, '{}', {}, { allowPrivate: true, timeoutMs: 1000 });
    assert.equal(redirect.ok, false);
    assert.match(redirect.error!, /doorverwijzing niet gevolgd/);
    assert.equal(hits, 1, 'the redirect was not followed');
  } finally {
    srv.close();
  }
  assert.equal(signAlert('geheim', '{"a":1}', 1_800_000_000), `t=1800000000,v1=${hmacHex('geheim', '1800000000.{"a":1}')}`);
});

// ---------------------------------------------------------------- integration

let cloud: CloudHandle;
let clock: FakeClock;
let tmp: string;
let stripe: http.Server;
let hook: http.Server;
let hookUrl = '';
const stripeCalls: { method: string; path: string; body: string; idem?: string }[] = [];
const hooks: { headers: http.IncomingHttpHeaders; body: string }[] = [];
const mails: { to: string; subject: string; text: string }[] = [];
const healthy = new Map<string, boolean>();
let anna: Browser; // Stripe customer, workspace alpha (Team)
let bram: Browser; // manual billing, workspace bravo (Starter)
let stranger: Browser;
let op: Browser;
let alpha: Workspace;
let bravo: Workspace;
let webhookSecret = '';

const sweepAt = async (iso: string) => {
  clock.set(iso);
  await cloud.monitoring.sweep();
};
const addDaily = (ws: Workspace, day: string, checks: number, ok: number) =>
  cloud.db.query('INSERT INTO workspace_health_daily (workspace_id, day, checks, ok) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, day) DO UPDATE SET checks = workspace_health_daily.checks + $3, ok = workspace_health_daily.ok + $4', [ws.id, day, checks, ok]);

before(async () => {
  stripe = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      stripeCalls.push({ method: req.method!, path: req.url!, body, idem: req.headers['idempotency-key'] as string | undefined });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer sk_test_nep') return res.writeHead(401).end('{"error":{"message":"bad key"}}');
      const m = /^\/v1\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/.exec(req.url || '');
      if (req.method === 'POST' && m) return res.end(JSON.stringify({ id: 'cbtxn_test_1', amount: Number(new URLSearchParams(body).get('amount')) }));
      res.writeHead(404).end('{}');
    });
  });
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hooks.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hook.address() as any).port}/teambot-hook`;

  const stub: Provisioner = {
    kind: 'process',
    async create(spec) {
      return { kind: 'process', id: spec.workspaceId };
    },
    async start(info) {
      return info;
    },
    async stop() {},
    async remove() {},
    async health(info) {
      return healthy.get(String(info.id)) !== false;
    },
    upstream: (info) => ({ host: '127.0.0.1', port: 9, id: info.id }) as any,
    async exportData() {},
    async shutdown() {},
  };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cloud-rep-'));
  clock = new FakeClock('2026-10-01T08:00:00Z');
  cloud = await createCloud({
    env: { STRIPE_SECRET_KEY: 'sk_test_nep', STRIPE_API_BASE: `http://127.0.0.1:${(stripe.address() as any).port}`, CLOUD_TZ: TZ },
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
      alerts: { limitPerHour: 5, timeoutMs: 2000 },
      dedicated: { allowPrivate: false, timeoutMs: 1500 },
    },
    clock,
    provisioner: stub,
    pgliteDir: null,
    mailer: async (m) => {
      mails.push(m);
    },
    resolve: async (h) => (h === 'hooks.klant.test' ? ['10.0.0.5'] : ['93.184.216.34']),
  });
  const base = cloud.listenUrl;
  anna = new Browser(base);
  bram = new Browser(base);
  stranger = new Browser(base);
  op = new Browser(base);
  await anna.submit('/signup', '/signup', { email: 'anna@example.nl', password: 'anna-wachtwoord-1' });
  await bram.submit('/signup', '/signup', { email: 'bram@example.nl', password: 'bram-wachtwoord-1' });
  await stranger.submit('/signup', '/signup', { email: 'ander@example.nl', password: 'ander-wachtwoord-1' });
  await op.submit('/signup', '/signup', { email: 'beheer@example.nl', password: 'beheer-wachtwoord-1' });
  await cloud.accounts.setRole('beheer@example.nl', 'operator');
  const annaId = (await cloud.accounts.byEmail('anna@example.nl'))!.id;
  const bramId = (await cloud.accounts.byEmail('bram@example.nl'))!.id;
  alpha = await cloud.workspaces.create(annaId, { name: 'Team Alpha', slug: 'alpha' }, { actor: 'user' }, 'stripe');
  bravo = await cloud.workspaces.create(bramId, { name: 'Team Bravo', slug: 'bravo' }, { actor: 'user' }, 'manual');
  await cloud.workspaces.idle();
  // alpha pays Team through Stripe; bravo has Starter, invoiced by hand.
  await cloud.db.query("UPDATE subscriptions SET external_customer_id = 'cus_alpha', external_subscription_id = 'sub_alpha', status = 'active', plan = 'team' WHERE workspace_id = $1", [alpha.id]);
  await cloud.workspaces.setPlan(alpha.id, 'team');
  await cloud.billing.manualSet(bravo.id, { plan: 'starter', status: 'active' }, { actor: 'operator' });
});

after(async () => {
  try {
    await cloud?.close();
  } finally {
    stripe?.close();
    hook?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('alerts: owner settings (https + public only, secret shown once), e-mail opt-in', async () => {
  const save = (b: Browser, form: Record<string, string>) => b.submit('/account/alerts', '/account/alerts', form);
  assert.match((await save(anna, { webhook: hookUrl })).body, /Alleen https/);
  assert.match((await save(anna, { webhook: 'https://10.0.0.1/hook' })).body, /niet publiek/);
  assert.match((await save(anna, { webhook: 'https://hooks.klant.test/hook' })).body, /privé/);
  assert.match((await save(anna, { webhook: 'https://user:pw@hooks.example.com/x' })).body, /gebruikersnaam/);
  // The local receiver needs the explicit development flag.
  cloud.cfg.dedicated.allowPrivate = true;
  const ok = await save(anna, { webhook: hookUrl });
  assert.equal(ok.status, 200);
  webhookSecret = /<code>(whsec_[A-Za-z0-9_-]+)<\/code>/.exec(ok.body)?.[1] || '';
  assert.ok(webhookSecret, 'secret shown once');
  assert.ok(!(await anna.go('/account/alerts')).body.includes(webhookSecret), 'not shown again');
  const stored = JSON.stringify(await cloud.db.query('SELECT * FROM accounts'));
  assert.ok(!stored.includes(webhookSecret), 'stored encrypted only');
  assert.equal((await save(bram, { email: '1', webhook: '' })).status, 303);
  assert.deepEqual(await cloud.alerts.settings(bravo.owner_id), { email: true, webhookUrl: null, emailAvailable: true });
});

test('reports: measurement per local month, maintenance excluded, short notice counted, incidents with duration, alerts', async () => {
  // Announced 5 days ahead (platform): excluded. Announced 30 minutes ahead (alpha only): counted.
  clock.set('2026-10-05T12:00:00Z');
  await cloud.monitoring.announce({ title: 'Platform-update', startsAt: new Date('2026-10-10T20:00:00Z'), endsAt: new Date('2026-10-10T21:00:00Z') }, { actor: 'operator' });
  clock.set('2026-10-12T10:00:00Z');
  await cloud.monitoring.announce({ title: 'Spoedupdate', startsAt: new Date('2026-10-12T10:30:00Z'), endsAt: new Date('2026-10-12T11:00:00Z'), workspaceId: alpha.id }, { actor: 'operator' });

  healthy.set(alpha.id, false);
  await sweepAt('2026-10-10T20:15:00Z'); // in announced maintenance: not counted
  await sweepAt('2026-10-10T20:30:00Z');
  await sweepAt('2026-10-12T10:35:00Z'); // short notice: counted
  await sweepAt('2026-10-12T10:40:00Z');
  await sweepAt('2026-10-12T10:45:00Z'); // third failure → incident + alert
  healthy.set(alpha.id, true);
  await sweepAt('2026-10-12T10:55:00Z'); // resolved → alert
  // Month boundary in local time: 22:30Z on 31 Oct is 23:30 in Amsterdam (October), 23:30Z is 00:30 on 1 Nov.
  healthy.set(alpha.id, false);
  await sweepAt('2026-10-31T22:30:00Z');
  await sweepAt('2026-10-31T23:30:00Z');
  healthy.set(alpha.id, true);
  const nov = await cloud.db.query('SELECT day, checks, ok FROM workspace_health_daily WHERE workspace_id = $1 AND day >= $2', [alpha.id, '2026-11-01']);
  assert.deepEqual(nov, [{ day: '2026-11-01', checks: 1, ok: 0 }]);
  // Bulk of the month (many more checks than the sweeps above).
  await addDaily(alpha, '2026-10-20', 195, 195); // alpha: 200 checks, 196 ok → 98.0%
  await addDaily(bravo, '2026-10-20', 995, 995); // bravo: 1000/1000

  await cloud.alerts.idle();
  const types = hooks.map((h) => JSON.parse(h.body).type);
  assert.deepEqual(types, ['incident.opened', 'incident.resolved']);
  for (const h of hooks) {
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(h.headers['x-teambot-signature']))!;
    assert.equal(v1, hmacHex(webhookSecret, `${t}.${h.body}`), 'body signed with the owner secret');
    assert.equal(h.headers['x-teambot-event'], JSON.parse(h.body).type);
  }
  assert.equal(JSON.parse(hooks[0].body).workspace.slug, 'alpha');

  // Not before the month is over.
  clock.set('2026-10-31T22:00:00Z');
  await assert.rejects(cloud.reports.generate(alpha.id, '2026-10', { actor: 'operator' }), /na het einde van de maand/);
  assert.equal(await cloud.reports.generateDue('2026-10'), 0);
  // Automatically after the month (in local time).
  clock.set('2026-11-01T00:30:00Z');
  assert.equal(await cloud.reports.generateDue(), 2);
  const a = (await cloud.reports.current(alpha.id, '2026-10'))!;
  const r = a.data;
  assert.equal(a.version, 1);
  assert.deepEqual(r.period, { start: '2026-09-30T22:00:00.000Z', end: '2026-10-31T23:00:00.000Z', timeZone: TZ });
  assert.deepEqual([r.measurement.checks, r.measurement.ok, r.measurement.failed, r.measurement.excludedChecks, r.measurement.uptimePct], [200, 196, 4, 2, 98]);
  assert.equal(r.plan.slaTarget, 99.9);
  assert.equal(r.result, 'not_met');
  assert.deepEqual(r.credit, { pct: 25, amountCents: 725, currency: 'eur', rule: '< 99%' });
  assert.deepEqual(
    r.maintenance.map((m) => [m.title, m.scope, m.minutes, m.excluded]),
    [
      ['Platform-update', 'platform', 60, true],
      ['Spoedupdate', 'workspace', 30, false],
    ],
  );
  assert.equal(r.incidents.length, 1);
  assert.deepEqual([r.incidents[0].title, r.incidents[0].minutes, r.incidents[0].ongoing], ['Niet bereikbaar', 10, false]);
  const b = (await cloud.reports.current(bravo.id, '2026-10'))!.data;
  assert.equal(b.result, 'met');
  assert.equal(b.credit, null);
  assert.deepEqual(b.maintenance.map((m) => m.title), ['Platform-update'], "another workspace's maintenance is not in this report");
  assert.equal((await cloud.reports.credit(a.id))!.status, 'pending');
  assert.equal(await cloud.reports.credit((await cloud.reports.current(bravo.id, '2026-10'))!.id), null);
  // Report-ready alerts: webhook for Anna, e-mail for Bram.
  await cloud.alerts.idle();
  assert.equal(JSON.parse(hooks.at(-1)!.body).type, 'report.ready');
  assert.equal(JSON.parse(hooks.at(-1)!.body).data.month, '2026-10');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'bram@example.nl');
  assert.match(mails[0].subject, /SLA-rapport/);
});

test('reports: immutable (database refuses changes, system never regenerates)', async () => {
  const a = (await cloud.reports.current(alpha.id, '2026-10'))!;
  await assert.rejects(cloud.db.query("UPDATE sla_reports SET month = '2026-09' WHERE id = $1", [a.id]), /onveranderlijk/);
  await assert.rejects(cloud.db.query('DELETE FROM sla_reports WHERE id = $1', [a.id]), /onveranderlijk/);
  await assert.rejects(cloud.reports.generate(alpha.id, '2026-10', { actor: 'system' }), /onveranderlijk/);
  assert.equal(await cloud.reports.generateDue(), 0);
  await assert.rejects(cloud.reports.generate(alpha.id, '2026-10', { actor: 'operator' }, ''), /reden/);
  assert.equal((await cloud.db.query("SELECT COUNT(*)::int AS n FROM sla_reports WHERE month = '2026-10'"))[0].n, 2);
});

test('reports: owner sees only own reports (page, CSV, JSON); others get 404', async () => {
  // A month passed on the fake clock: 30-day sessions expired, like for real customers.
  assert.equal((await anna.go('/dashboard')).status, 303);
  for (const [b, email, pw] of [
    [anna, 'anna@example.nl', 'anna-wachtwoord-1'],
    [bram, 'bram@example.nl', 'bram-wachtwoord-1'],
    [stranger, 'ander@example.nl', 'ander-wachtwoord-1'],
    [op, 'beheer@example.nl', 'beheer-wachtwoord-1'],
  ] as const) {
    assert.equal((await b.submit('/login', '/login', { email, password: pw })).status, 303);
  }
  const page = await anna.go(`/workspaces/${alpha.id}/reports/2026-10`);
  assert.equal(page.status, 200);
  assert.match(page.body, /SLA-rapport oktober 2026/);
  assert.match(page.body, /Doel niet gehaald/);
  assert.match(page.body, /7,25/);
  assert.match(page.body, /Wacht op beoordeling/);
  assert.match(page.body, /Spoedupdate[\s\S]*te kort van tevoren/);
  assert.ok(!page.body.includes('Credit goedkeuren'), 'no operator actions for the owner');
  const csv = await anna.go(`/workspaces/${alpha.id}/reports/2026-10/csv`);
  assert.match(String(csv.headers['content-type']), /text\/csv/);
  assert.match(String(csv.headers['content-disposition']), /sla-alpha-2026-10\.csv/);
  assert.match(csv.body, /summary,alpha,2026-10,Team Alpha,.*,98,99\.9,200,196,2,not_met,25,7\.25,eur,pending/);
  const json = JSON.parse((await anna.go(`/workspaces/${alpha.id}/reports/2026-10/json`)).body);
  assert.equal(json.report.measurement.checks, 200);
  assert.deepEqual(json.credit, { status: 'pending', pct: 25, amountCents: 725, currency: 'eur' });
  assert.match((await anna.go(`/workspaces/${alpha.id}`)).body, /SLA-rapporten[\s\S]*oktober 2026/);
  for (const who of [bram, stranger]) {
    assert.equal((await who.go(`/workspaces/${alpha.id}/reports/2026-10`)).status, 404);
    assert.equal((await who.go(`/workspaces/${alpha.id}/reports/2026-10/csv`)).status, 404);
    assert.equal((await who.go(`/workspaces/${alpha.id}/reports/2026-10/json`)).status, 404);
  }
  assert.equal((await bram.go(`/workspaces/${bravo.id}/reports/2026-10`)).status, 200);
  assert.equal((await anna.go(`/workspaces/${alpha.id}/reports/2026-11`)).status, 404);
});

test('credits: operator-only; Stripe balance credit only after approval; manual billing "te verrekenen"', async () => {
  const a = (await cloud.reports.current(alpha.id, '2026-10'))!;
  // Owners and strangers cannot touch operator routes.
  for (const p of [`/operator/reports/${a.id}/credit/approve`, `/operator/reports/${a.id}/credit/reject`, `/operator/reports/${a.id}/regenerate`, '/operator/reports/generate']) {
    assert.equal((await anna.submit('/dashboard', p, { note: 'x', reason: 'x', month: '2026-10' })).status, 403, p);
  }
  assert.equal((await anna.go('/operator/reports')).status, 403);
  assert.equal((await anna.go(`/operator/reports/${a.id}/json`)).status, 403);
  assert.equal(stripeCalls.length, 0, 'never automatic: nothing sent to Stripe before approval');

  const list = await op.go('/operator/reports?month=2026-10');
  assert.match(list.body, /1 credit\(s\) wachten op je beoordeling/);
  const approve = await op.submit(`/operator/reports/${a.id}`, `/operator/reports/${a.id}/credit/approve`, {});
  assert.equal(approve.status, 303);
  assert.equal(stripeCalls.length, 1);
  const call = stripeCalls[0];
  assert.equal(call.path, '/v1/customers/cus_alpha/balance_transactions');
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('amount'), '-725');
  assert.equal(form.get('currency'), 'eur');
  assert.equal(form.get('metadata[sla_report_id]'), a.id);
  assert.equal(call.idem, `sla-credit-${a.id}`, 'idempotent per report');
  const credit = (await cloud.reports.credit(a.id))!;
  assert.deepEqual([credit.status, credit.method, credit.external_ref], ['applied', 'stripe', 'cbtxn_test_1']);
  // Decided once; the report can no longer be replaced.
  assert.match((await op.submit(`/operator/reports/${a.id}`, `/operator/reports/${a.id}/credit/approve`, {})).body, /al besloten/);
  assert.match((await op.submit(`/operator/reports/${a.id}`, `/operator/reports/${a.id}/regenerate`, { reason: 'test' })).body, /al een credit goedgekeurd/);
  assert.equal(stripeCalls.length, 1);
  assert.match((await anna.go(`/workspaces/${alpha.id}/reports/2026-10`)).body, /Verrekend via Stripe/);

  // Manual billing (bravo): a late measurement correction → new version, pending credit, reject, new version, approve.
  await addDaily(bravo, '2026-10-21', 100, 0); // 1100 checks, 1000 ok → 90.9% → Starter 50%
  const b1 = (await cloud.reports.current(bravo.id, '2026-10'))!;
  const regen = await op.submit(`/operator/reports/${b1.id}`, `/operator/reports/${b1.id}/regenerate`, { reason: 'Late meting toegevoegd' });
  assert.equal(regen.status, 303);
  const b2 = (await cloud.reports.current(bravo.id, '2026-10'))!;
  assert.equal(b2.version, 2);
  assert.equal(b2.reason, 'Late meting toegevoegd');
  assert.equal(b2.data.generatedBy, 'operator');
  assert.deepEqual(b2.data.credit, { pct: 50, amountCents: 450, currency: 'eur', rule: '< 95%' });
  assert.equal((await cloud.reports.byId(b1.id))!.version, 1, 'the earlier version is kept');
  assert.match((await op.submit(`/operator/reports/${b2.id}`, `/operator/reports/${b2.id}/credit/reject`, { note: '' })).body, /reden/);
  assert.equal((await op.submit(`/operator/reports/${b2.id}`, `/operator/reports/${b2.id}/credit/reject`, { note: 'Klant zelf oorzaak' })).status, 303);
  assert.equal((await cloud.reports.credit(b2.id))!.status, 'rejected');
  await op.submit(`/operator/reports/${b2.id}`, `/operator/reports/${b2.id}/regenerate`, { reason: 'Toch credit na overleg' });
  const b3 = (await cloud.reports.current(bravo.id, '2026-10'))!;
  assert.equal(b3.version, 3);
  // An approval on an older version is refused.
  await assert.rejects(cloud.reports.approveCredit(b1.id, { actor: 'operator' }), /Geen credit|nieuwere versie/);
  assert.equal((await op.submit(`/operator/reports/${b3.id}`, `/operator/reports/${b3.id}/credit/approve`, {})).status, 303);
  let c3 = (await cloud.reports.credit(b3.id))!;
  assert.deepEqual([c3.status, c3.method, c3.note], ['to_settle', 'manual', 'te verrekenen']);
  assert.equal(stripeCalls.length, 1, 'manual billing never calls Stripe');
  assert.match((await bram.go(`/workspaces/${bravo.id}/reports/2026-10`)).body, /Te verrekenen/);
  assert.equal((await op.submit(`/operator/reports/${b3.id}`, `/operator/reports/${b3.id}/credit/settle`, {})).status, 303);
  c3 = (await cloud.reports.credit(b3.id))!;
  assert.equal(c3.status, 'settled');
  const kinds = (await cloud.db.query<{ kind: string }>('SELECT kind FROM audit WHERE workspace_id = $1', [bravo.id])).map((x) => x.kind);
  for (const k of ['sla.report_generated', 'sla.report_regenerated', 'sla.credit_rejected', 'sla.credit_approved', 'sla.credit_settled']) assert.ok(kinds.includes(k), k);
  // Month export for accounting.
  const exp = await op.go('/operator/reports-export?month=2026-10');
  assert.match(exp.body, /summary,alpha,.*applied/);
  assert.match(exp.body, /summary,bravo,.*settled/);
});

test('alerts: rate limited per account and channel, every attempt logged', async () => {
  const before = (await cloud.alerts.recent(alpha.owner_id, 100)).filter((x) => x.channel === 'webhook' && x.status === 'sent').length;
  for (let i = 0; i < 6; i++) await anna.submit('/account/alerts', '/account/alerts/test', {});
  const rows = await cloud.alerts.recent(alpha.owner_id, 100);
  const sent = rows.filter((x) => x.channel === 'webhook' && x.status === 'sent').length;
  assert.equal(sent, 5, `limit 5 per hour (before: ${before})`);
  assert.ok(rows.some((x) => x.status === 'rate_limited'));
  assert.match((await anna.go('/account/alerts')).body, /rate_limited/);
  assert.equal(hooks.filter((h) => JSON.parse(h.body).type === 'test').length, 5 - before);
});
