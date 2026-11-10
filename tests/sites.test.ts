import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { allowedFrom, parseSitePath, SITE_CSP } from '../server/modules/sites/server.js';
import { scanFolder } from '../server/modules/sites/snapshot.js';

// a free port per test app; never 0.0.0.0 in tests (no firewall prompt)
process.env.TEAMBOT_SITES_PORT = '0';
process.env.TEAMBOT_SITES_HOST = '127.0.0.1';

/** Raw GET (no URL normalisation by fetch), so traversal attempts reach the server as typed. */
function rawGet(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function makeSite(dir: string) {
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Weekmenu</title><link rel="stylesheet" href="style.css"><h1>Weekmenu</h1><script src="app.js"></script>');
  fs.writeFileSync(path.join(dir, 'style.css'), 'h1{color:teal}');
  fs.writeFileSync(path.join(dir, 'app.js'), 'document.title += "!"');
  fs.writeFileSync(path.join(dir, 'sub', 'page.html'), '<p>sub</p>');
  fs.writeFileSync(path.join(dir, 'sub', 'index.html'), '<p>sub-index</p>');
  fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=sk-geheim');
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]');
  fs.writeFileSync(path.join(dir, 'sub', '.hidden.html'), 'verborgen');
  fs.writeFileSync(path.join(dir, 'secrets.json'), '{"token":"x"}');
  fs.writeFileSync(path.join(dir, 'passwords.txt'), 'hunter2');
  fs.writeFileSync(path.join(dir, 'tool.exe'), 'MZ');
  fs.writeFileSync(path.join(dir, 'server.key'), 'PRIVATE');
}

async function waitFor<T>(fn: () => Promise<T | null | undefined> | T | null | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timeout');
}

async function publishViaBot(t: TestApp, agent: any, args: any, decision: 'approve' | 'deny' = 'approve') {
  const th = await t.api('POST', '/threads', { agentId: agent.id });
  t.script.push({ toolCalls: [{ name: 'site_publish', args }] }, { text: 'klaar' });
  await t.api('POST', `/threads/${th.id}/messages`, { content: 'publiceer de site' });
  const ap = await waitFor(async () => (await t.api('GET', '/approvals')).find((a: any) => a.tool === 'site_publish'));
  return { th, ap, decide: async () => (await t.api('POST', `/approvals/${ap.id}`, { decision }), await t.waitIdle(th.id)) };
}

test('site paths: traversal, dotfiles, encoded slashes and ADS are refused; reach decides who may connect', () => {
  const tok = 'A'.repeat(32);
  assert.deepEqual(parseSitePath(`/s/${tok}/`)?.segments, []);
  assert.deepEqual(parseSitePath(`/s/${tok}/sub/page.html`)?.segments, ['sub', 'page.html']);
  for (const p of [`/s/${tok}/../x`, `/s/${tok}/.env`, `/s/${tok}/sub/.git/config`, `/s/${tok}/..%2f..%2fx`, `/s/${tok}/a%5cb`, `/s/${tok}/index.html:stream`, `/s/${tok}//x`, `/s/${tok}/%00`, `/s/short/`, `/api/me`])
    assert.equal(parseSitePath(p), null, p);
  assert.ok(allowedFrom('local', '127.0.0.1') && allowedFrom('local', '::1') && allowedFrom('local', '::ffff:127.0.0.1'));
  assert.ok(!allowedFrom('local', '192.168.1.5'));
  assert.ok(allowedFrom('lan', '192.168.1.5') && allowedFrom('lan', '10.0.0.8') && allowedFrom('lan', 'fe80::1'));
  assert.ok(!allowedFrom('lan', '8.8.8.8') && !allowedFrom('lan', '100.101.1.2'));
  assert.ok(allowedFrom('tailnet', '100.101.1.2') && allowedFrom('tailnet', 'fd7a:115c:a1e0::5'));
  assert.ok(!allowedFrom('tailnet', '192.168.1.5') && !allowedFrom('tailnet', '1.1.1.1'));
  assert.match(SITE_CSP, /sandbox allow-scripts/);
  assert.doesNotMatch(SITE_CSP, /allow-same-origin/);
  assert.doesNotMatch(SITE_CSP, /connect-src[^;]*http:/);
});

test('snapshot skips hidden, secret, non-web files and links; limits give a clear message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-site-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-out-'));
  try {
    makeSite(dir);
    fs.writeFileSync(path.join(outside, 'geheim.html'), 'buiten');
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
    const s = scanFolder(dir);
    const names = s.files.map((f) => f.rel).sort();
    assert.deepEqual(names, ['app.js', 'index.html', 'style.css', 'sub/index.html', 'sub/page.html']);
    const why = Object.fromEntries(s.skipped.map((x) => [x.rel, x.why]));
    assert.equal(why['.env'], 'hidden');
    assert.equal(why['.git'], 'hidden');
    assert.equal(why['sub/.hidden.html'], 'hidden');
    assert.equal(why['secrets.json'], 'secret');
    assert.equal(why['passwords.txt'], 'secret');
    assert.equal(why['tool.exe'], 'type');
    assert.equal(why['server.key'], 'type');
    assert.equal(why['link'], 'link');
    assert.equal(s.entry, 'index.html');
    assert.throws(() => scanFolder(dir, { files: 3, bytes: 1e9, file: 1e9, depth: 12 }), /Te veel bestanden/);
    assert.throws(() => scanFolder(dir, { files: 100, bytes: 20, file: 1e9, depth: 12 }), /te groot/);
    assert.throws(() => scanFolder(path.join(dir, 'index.html')), /Kies een map/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a bot publishes a site only after approval; it is served from its own port with strict headers; stop → 404', async () => {
  const t = await startTestApp();
  try {
    const agent = await t.agent({ access_mode: 'auto' });
    makeSite(path.join(agent.workspace, 'site'));
    const { th, ap, decide } = await publishViaBot(t, agent, { path: 'site', title: 'Weekmenu', reach: 'local', expires_days: 7 });
    // waiting for the owner: nothing published yet
    assert.equal(ap.risk, 'danger');
    assert.match(ap.summary, /Website publiceren: Weekmenu · alleen deze computer · verloopt na 7 dagen/);
    assert.equal((await t.api('GET', '/sites')).sites.length, 0);
    // the approval card's preview: folder, files, size, start page, reach
    const p = await t.api('GET', `/sites/preview/${ap.id}`);
    assert.equal(p.files, 5);
    assert.equal(p.entry, 'index.html');
    assert.equal(p.reachLabel, 'Alleen deze computer');
    assert.match(p.folder, /site$/);
    assert.match(p.skippedText, /verborgen/);
    assert.equal(p.ok, true);
    await decide();
    const { sites, info } = await t.api('GET', '/sites');
    assert.equal(sites.length, 1);
    const s = sites[0];
    assert.equal(s.state, 'live');
    assert.equal(s.files, 5);
    assert.ok(s.expires_at);
    assert.ok(info.listening);
    const url = new URL(s.urls[0].url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.notEqual(url.port, new URL(t.app.url).port, 'own port = own origin');
    assert.match(url.pathname, /^\/s\/[A-Za-z0-9_-]{32}\/$/);
    const port = Number(url.port);
    // the bot got the link
    const msgs = t.app.ctx.store.messages(th.id);
    assert.ok(msgs.some((m) => m.role === 'tool' && m.content.includes(url.href)), 'link in the tool result');
    // the page, with the safety headers
    const home = await rawGet(port, url.pathname);
    assert.equal(home.status, 200);
    assert.match(home.body, /Weekmenu/);
    assert.match(String(home.headers['content-type']), /^text\/html/);
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    assert.match(String(home.headers['content-security-policy']), /^sandbox allow-scripts/);
    assert.equal(home.headers['referrer-policy'], 'no-referrer');
    assert.match(String((await rawGet(port, url.pathname + 'style.css')).headers['content-type']), /^text\/css/);
    assert.match(String((await rawGet(port, url.pathname + 'app.js')).headers['content-type']), /^text\/javascript/);
    assert.equal((await rawGet(port, url.pathname + 'sub/')).body, '<p>sub-index</p>');
    assert.equal((await rawGet(port, url.pathname + 'sub')).status, 301);
    assert.equal((await rawGet(port, url.pathname.slice(0, -1))).status, 301);
    // traversal, dotfiles, secrets, links: never served
    for (const bad of ['.env', '.git/config', 'sub/.hidden.html', 'secrets.json', 'passwords.txt', 'tool.exe', 'server.key', '../../teambot.db', '..%2f..%2fteambot.db', '%2e%2e/%2e%2e/master.key', 'sub/..%5c..%5cmaster.key', 'index.html::$DATA'])
      assert.equal((await rawGet(port, url.pathname + bad)).status, 404, bad);
    // a site cannot reach TeamBot's API with the owner's login: the API is not on this port …
    const api = await rawGet(port, '/api/me', { authorization: `Bearer ${t.token}`, cookie: `tb_token=${t.token}` });
    assert.equal(api.status, 404);
    assert.doesNotMatch(api.body, /"email"|"role"/);
    assert.equal((await rawGet(port, url.pathname + 'api/me', { authorization: `Bearer ${t.token}` })).status, 404);
    // … the page has an opaque origin (no cookies/storage) and may not connect to http:// at all
    const csp = String(home.headers['content-security-policy']);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.match(csp, /connect-src 'self' https:;/);
    assert.match(csp, /form-action 'self'/);
    // only GET/HEAD
    const post = await new Promise<number>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, path: url.pathname, method: 'POST', agent: false }, (res) => (res.resume(), resolve(res.statusCode || 0)));
      r.end('x');
    });
    assert.equal(post, 405);
    // a guessed token is just "not found"
    assert.equal((await rawGet(port, '/s/' + 'x'.repeat(32) + '/')).status, 404);
    // the snapshot: changing the folder does not change the site until it is published again
    fs.writeFileSync(path.join(agent.workspace, 'site', 'index.html'), '<h1>Nieuw</h1>');
    assert.match((await rawGet(port, url.pathname)).body, /Weekmenu/);
    const again = await t.api('POST', `/sites/${s.id}/republish`, {});
    assert.equal(again.urls[0].url, url.href, 'same link after publishing again');
    assert.match((await rawGet(port, url.pathname)).body, /Nieuw/);
    // views are counted
    assert.ok((await t.api('GET', '/sites')).sites[0].views >= 2);
    // stop → 404, and the server stops listening when nothing is online
    await t.api('POST', `/sites/${s.id}/stop`);
    const after = await t.api('GET', '/sites');
    assert.equal(after.sites[0].state, 'stopped');
    assert.equal(after.sites[0].urls.length, 0);
    assert.equal(after.info.listening, false);
    // publish again from the list: same link back
    const back = await t.api('POST', `/sites/${s.id}/republish`, { expires_days: 0 });
    assert.equal(back.state, 'live');
    assert.equal(back.expires_at, null);
    const port2 = Number(new URL(back.urls[0].url).port);
    assert.equal((await rawGet(port2, url.pathname)).status, 200);
    await t.api('POST', `/sites/${s.id}/stop`);
    assert.equal((await t.app.ctx.services.sites.http.listening), false);
    // audit
    const kinds = t.app.ctx.store.all<any>("SELECT kind FROM audit WHERE kind LIKE 'site.%' ORDER BY id").map((r) => r.kind);
    assert.deepEqual(kinds, ['site.publish', 'site.republish', 'site.unpublish', 'site.republish', 'site.unpublish']);
    await t.api('DELETE', `/sites/${s.id}`);
    assert.equal((await t.api('GET', '/sites')).sites.length, 0);
    assert.ok(!fs.existsSync(path.join(t.dir, 'sites', s.id)), 'snapshot removed');
  } finally {
    await t.close();
  }
});

test('expiry takes a site offline; the bot can stop its own site', async () => {
  const t = await startTestApp();
  try {
    const agent = await t.agent({ access_mode: 'auto' });
    makeSite(path.join(agent.workspace, 'site'));
    const { decide } = await publishViaBot(t, agent, { path: 'site', title: 'Kort', reach: 'local', expires_days: 1 });
    await decide();
    let s = (await t.api('GET', '/sites')).sites[0];
    const url = new URL(s.urls[0].url);
    assert.equal((await rawGet(Number(url.port), url.pathname)).status, 200);
    // expired → offline
    t.app.ctx.store.exec('UPDATE sites SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), s.id);
    assert.equal((await rawGet(Number(url.port), url.pathname)).status, 404);
    await t.app.ctx.services.sites.sweep();
    s = (await t.api('GET', '/sites')).sites[0];
    assert.equal(s.state, 'expired');
    // the bot can stop its own site
    await t.api('POST', `/sites/${s.id}/republish`, { expires_days: 0 });
    const th = await t.api('POST', '/threads', { agentId: agent.id });
    t.script.push({ toolCalls: [{ name: 'site_unpublish', args: { site: 'site' } }] }, { text: 'gestopt' });
    await t.say(th.id, 'haal hem offline');
    assert.equal((await t.api('GET', '/sites')).sites[0].state, 'stopped');
  } finally {
    await t.close();
  }
});

test('refused publishing, no index.html, outside the work folder; "Volledige toegang" still asks', async () => {
  const t = await startTestApp();
  try {
    const agent = await t.agent({ access_mode: 'auto' });
    makeSite(path.join(agent.workspace, 'site'));
    // denied → nothing online
    const d = await publishViaBot(t, agent, { path: 'site' }, 'deny');
    await d.decide();
    assert.equal((await t.api('GET', '/sites')).sites.length, 0);
    // no index.html → clear error, preview warns before approving
    fs.mkdirSync(path.join(agent.workspace, 'leeg'), { recursive: true });
    fs.writeFileSync(path.join(agent.workspace, 'leeg', 'a.html'), 'a');
    fs.writeFileSync(path.join(agent.workspace, 'leeg', 'b.html'), 'b');
    const n = await publishViaBot(t, agent, { path: 'leeg' });
    const pv = await t.api('GET', `/sites/preview/${n.ap.id}`);
    assert.equal(pv.ok, false);
    assert.match(pv.problem, /geen index\.html/);
    await n.decide();
    const tool = t.app.ctx.store.messages(n.th.id).find((m) => m.role === 'tool');
    assert.match(tool!.content, /geen index\.html/);
    // outside the work folder → refused by the folder check
    const o = await publishViaBot(t, agent, { path: path.join(os.tmpdir()) });
    const po = await t.api('GET', `/sites/preview/${o.ap.id}`);
    assert.match(po.problem, /buiten de toegestane werkmap/);
    await o.decide();
    assert.equal((await t.api('GET', '/sites')).sites.length, 0);
    // "Volledige toegang" with sending/publishing allowed: publishing still asks
    const full = await t.agent({ name: 'Vol', access_mode: 'full', settings: { fullAccessExternal: true } });
    makeSite(path.join(full.workspace, 'site'));
    const f = await publishViaBot(t, full, { path: 'site' });
    assert.equal(f.ap.tool, 'site_publish');
    await f.decide();
    assert.equal((await t.api('GET', '/sites')).sites.length, 1);
  } finally {
    await t.close();
  }
});

test('members on a server cannot publish sites', async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@example.com', password: 'wachtwoord-lid-1', role: 'member' });
    const tok = t.app.ctx.auth.createSession(m.id).token;
    const res = await fetch(t.app.url + '/api/sites', { headers: { authorization: `Bearer ${tok}` } });
    const j: any = await res.json();
    assert.equal(j.info.canPublish, false);
    assert.equal(t.app.ctx.services.sites.canPublish(t.app.ctx.store.user(m.id)), false);
  } finally {
    await t.close();
  }
});
