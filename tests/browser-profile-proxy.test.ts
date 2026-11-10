process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startTestApp } from './helpers.js';
import { PolicyProxy } from '../server/modules/browser/proxy.js';
import { applyProxy, makeUpstream } from '../server/modules/network/proxy.js';
import type { ComputerService } from '../server/modules/browser/service.js';

/**
 * 11.1: a proxy per browser profile. Only that profile's browser chains to it (the policy proxy keeps checking first);
 * other profiles stay direct. The login lives in the encrypted secrets and never shows in the API, audit or logs.
 */

const PW = 'Proxy-Geheim-7Hq2';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

/** Forward proxy for tests: records requests and their login, sends everything to one local target. */
async function fakeProxy(o: { target: number; user: string; pass: string }) {
  const seen: { kind: 'connect' | 'forward'; host: string; auth: string | null }[] = [];
  const want = 'Basic ' + Buffer.from(`${o.user}:${o.pass}`).toString('base64');
  const server = http.createServer((req, res) => {
    const auth = (req.headers['proxy-authorization'] as string) || null;
    seen.push({ kind: 'forward', host: new URL(req.url || '').host, auth });
    if (auth !== want) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
      return res.end();
    }
    const u = new URL(req.url!);
    const up = http.request({ agent: false, host: '127.0.0.1', port: o.target, path: u.pathname, method: req.method, headers: { ...req.headers, 'x-via': 'profielproxy' } }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  server.on('connect', (req, sock: net.Socket, head) => {
    const auth = (req.headers['proxy-authorization'] as string) || null;
    seen.push({ kind: 'connect', host: req.url || '', auth });
    sock.on('error', () => {});
    if (auth !== want) return sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
    const up = net.connect(o.target, '127.0.0.1', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, seen, close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

test('policy proxy: a profile with its own proxy chains to it (with its login), another profile stays direct, checks stay first', async () => {
  const target = http.createServer((req, res) => res.end(`doel ${req.url} ${req.headers['x-via'] || 'direct'}`));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const tport = (target.address() as net.AddressInfo).port;
  const px = await fakeProxy({ target: tport, user: 'jan', pass: PW });
  // local.example resolves to loopback so the "direct" profile (local addresses allowed) reaches the test target itself
  const pp = new PolicyProxy(async (h) => {
    if (h === 'pub.example') return ['93.184.216.34'];
    if (h === 'local.example') return ['127.0.0.1'];
    if (h === 'priv.example') return ['10.0.0.5'];
    throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  });
  await pp.start();
  let profileProxy = makeUpstream({ url: px.url, noProxy: [], browser: true, username: 'jan', password: PW });
  const blocked: string[] = [];
  const withProxy = pp.register({ policy: () => ({ allow: [], deny: ['blocked.example'], allowPrivate: false }), onBlock: (u, r) => blocked.push(`${u} ${r}`), upstream: () => profileProxy });
  const direct = pp.register({ policy: () => ({ allow: [], deny: [], allowPrivate: true }), onBlock: (u, r) => blocked.push(`${u} ${r}`) });
  const basic = (c: { username: string; password: string }) => 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64');
  const tunnel = (c: { username: string; password: string }, host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const s = net.connect(pp.port, '127.0.0.1', () => s.write(`CONNECT ${host}:${tport} HTTP/1.1\r\nHost: ${host}:${tport}\r\nProxy-Authorization: ${basic(c)}\r\n\r\n`));
      let buf = '';
      let status = 0;
      s.on('data', (d) => {
        buf += d;
        if (!status && buf.includes('\r\n\r\n')) {
          status = Number(buf.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
          if (status !== 200) return (s.destroy(), resolve({ status, body: '' }));
          buf = '';
          s.write(`GET /tunnel HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        }
      });
      s.on('end', () => resolve({ status, body: buf }));
      s.on('error', reject);
    });
  const plain = (c: { username: string; password: string }, host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: pp.port, path: `http://${host}:${tport}/plain`, headers: { 'proxy-authorization': basic(c), host: `${host}:${tport}` }, agent: false }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: b }));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    applyProxy(null);
    // the profile with a proxy: CONNECT and plain http both go through it, with its login
    let r = await tunnel(withProxy, 'pub.example');
    assert.equal(r.status, 200);
    assert.match(r.body, /doel \/tunnel/);
    r = await plain(withProxy, 'pub.example');
    assert.match(r.body, /doel \/plain profielproxy/);
    assert.deepEqual(px.seen.map((x) => [x.kind, x.host]), [['connect', `pub.example:${tport}`], ['forward', `pub.example:${tport}`]]);
    assert.ok(px.seen.every((x) => x.auth === 'Basic ' + Buffer.from(`jan:${PW}`).toString('base64')), 'the profile login is added by TeamBot');
    // the other profile: direct, the proxy sees nothing
    const n = px.seen.length;
    r = await plain(direct, 'local.example');
    assert.match(r.body, /doel \/plain direct/);
    r = await tunnel(direct, 'local.example');
    assert.equal(r.status, 200);
    assert.equal(px.seen.length, n, 'another profile never uses this proxy');
    // TeamBot's own checks stay first: a denied domain and a private address are blocked before the proxy
    assert.equal((await tunnel(withProxy, 'blocked.example')).status, 403);
    assert.equal((await tunnel(withProxy, 'priv.example')).status, 403);
    assert.equal(px.seen.length, n);
    // a wrong login: a TeamBot page that names the profile's proxy (Chromium never asks)
    profileProxy = makeUpstream({ url: px.url, noProxy: [], browser: true, username: 'jan', password: 'fout' });
    r = await plain(withProxy, 'pub.example');
    assert.equal(r.status, 403);
    assert.match(r.body, /De proxy van dit browserprofiel weigert de inloggegevens/);
    assert.ok(!r.body.includes('fout') && !blocked.join(' ').includes(PW));
  } finally {
    await pp.stop();
    await px.close();
    await new Promise<void>((res) => (target.closeAllConnections?.(), target.close(() => res())));
  }
});

test('profile proxy API: address checked, login encrypted and write-only, one profile only, phone and members limited', async () => {
  const t = await startTestApp();
  try {
    const svc: ComputerService = t.app.ctx.services.computers._service;
    const shared = await t.api('POST', '/computers/profiles', { name: 'Marketing' });
    const other = await t.api('POST', '/computers/profiles', { name: 'Support' });
    // invalid addresses in plain Dutch
    await assert.rejects(t.api('PUT', `/computers/profiles/${shared.id}/proxy`, { url: 'socks5://proxy:1080' }), /SOCKS/);
    await assert.rejects(t.api('PUT', `/computers/profiles/${shared.id}/proxy`, { url: 'http://jan:pw@proxy:8080' }), /aparte velden/);
    const saved = await t.api('PUT', `/computers/profiles/${shared.id}/proxy`, { url: 'proxy.bedrijf.nl:8080', username: 'jan', password: PW });
    assert.deepEqual(saved.proxy, { url: 'http://proxy.bedrijf.nl:8080', has_login: true });
    const list = await t.api('GET', '/computers/profiles');
    const row = list.find((p: any) => p.id === shared.id);
    assert.deepEqual(row.proxy, { url: 'http://proxy.bedrijf.nl:8080', has_login: true });
    assert.equal(list.find((p: any) => p.id === other.id).proxy, null);
    assert.ok(!JSON.stringify(list).includes(PW) && !JSON.stringify(list).includes('"jan"'), 'the login never comes back');
    // stored encrypted in secrets, applied to this profile only
    const sec = t.app.ctx.store.all<any>("SELECT * FROM secrets WHERE name LIKE 'browser-proxy:%'");
    assert.equal(sec.length, 1);
    assert.ok(!JSON.stringify(sec).includes(PW));
    const up = svc.profileUpstream(shared.id)!;
    assert.equal(up.label, 'proxy.bedrijf.nl:8080');
    assert.equal(up.auth, 'Basic ' + Buffer.from(`jan:${PW}`).toString('base64'));
    assert.equal(svc.profileUpstream(other.id), null);
    assert.equal(svc.sessionOpts(t.app.ctx.store.get<any>('browser_profiles', shared.id)).upstream!(), up, 'the browser session asks the profile for its proxy');
    // a new address keeps the login; clear_login removes it; '' removes the proxy
    let v = await t.api('PUT', `/computers/profiles/${shared.id}/proxy`, { url: 'http://proxy2.bedrijf.nl:3128' });
    assert.deepEqual(v.proxy, { url: 'http://proxy2.bedrijf.nl:3128', has_login: true });
    assert.equal(svc.profileUpstream(shared.id)!.label, 'proxy2.bedrijf.nl:3128', 'the change applies at once');
    v = await t.api('PUT', `/computers/profiles/${shared.id}/proxy`, { url: 'http://proxy2.bedrijf.nl:3128', clear_login: true });
    assert.equal(v.proxy.has_login, false);
    assert.equal(svc.profileUpstream(shared.id)!.auth, null);
    await t.api('PUT', `/computers/profiles/${shared.id}/proxy`, { url: 'http://proxy2.bedrijf.nl:3128', username: 'jan', password: PW });
    v = await t.api('PUT', `/computers/profiles/${shared.id}/proxy`, { url: '' });
    assert.equal(v.proxy, null);
    assert.equal(svc.profileUpstream(shared.id), null);
    assert.equal(t.app.ctx.store.all("SELECT id FROM secrets WHERE name LIKE 'browser-proxy:%'").length, 0, 'the login goes with the proxy');
    // a proxy that does not answer: the test button says so (no network needed)
    const dead = await t.api('POST', `/computers/profiles/${shared.id}/proxy/test`, { url: 'http://127.0.0.1:9' });
    assert.equal(dead.ok, false);
    // deleting the profile removes its login too
    await t.api('PUT', `/computers/profiles/${other.id}/proxy`, { url: 'http://proxy.bedrijf.nl:8080', username: 'x', password: PW });
    await t.api('DELETE', `/computers/profiles/${other.id}`);
    assert.equal(t.app.ctx.store.all("SELECT id FROM secrets WHERE name LIKE 'browser-proxy:%'").length, 0);
    // never in the audit log
    const audit = JSON.stringify(t.app.ctx.store.all("SELECT data FROM audit WHERE kind = 'browser.profile_proxy'"));
    assert.match(audit, /proxy\.bedrijf\.nl:8080/);
    assert.ok(!audit.includes(PW) && !audit.includes('"jan"'));

    // a paired phone cannot set it
    const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4761' });
    const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
    const phone = (await (await fetch(t.app.url + '/api/public/mobile/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': IPHONE_UA }, body: JSON.stringify({ secret, name: 'Telefoon' }) })).json()).token as string;
    const res = await fetch(`${t.app.url}/api/computers/profiles/${shared.id}/proxy`, { method: 'PUT', headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json', 'user-agent': IPHONE_UA }, body: JSON.stringify({ url: 'http://proxy:8080' }) });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as any).error, /op je computer/);

    // a member may not point a profile at a private address (SSRF)
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: `lid${Date.now()}@example.com`, password: 'wachtwoord123' });
    const mt = t.app.ctx.auth.createSession(m.id).token;
    const mApi = async (method: string, p: string, body?: any) => {
      const r = await fetch(t.app.url + '/api' + p, { method, headers: { authorization: `Bearer ${mt}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };
    const mine = await mApi('POST', '/computers/profiles', { name: 'Van het lid' });
    const refused = await mApi('PUT', `/computers/profiles/${mine.body.id}/proxy`, { url: 'http://10.0.0.8:3128' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /openbaar adres/);
    // and cannot touch the owner's profile
    assert.equal((await mApi('PUT', `/computers/profiles/${shared.id}/proxy`, { url: 'http://proxy:8080' })).status, 404);
  } finally {
    await t.close();
  }
});
