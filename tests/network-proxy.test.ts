import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { startTestApp } from './helpers.js';
import { applyProxy, isLoopbackHost, looksLocalName, makeUpstream, matchesNoProxy, openTunnel, parseNoProxy, parseProxyUrl, testProxy, toNodeNoProxy, upstreamFor } from '../server/modules/network/proxy.js';
import { assertPublicUrl, safeFetch } from '../server/tools/builtin/web.js';
import { PolicyProxy } from '../server/modules/browser/proxy.js';

/** A small forward proxy for tests: counts requests, checks Basic auth, sends everything to one local target. */
async function testProxyServer(o: { target: number; user?: string; pass?: string }) {
  const seen: { kind: 'connect' | 'forward'; host: string; auth: string | null }[] = [];
  const want = o.user || o.pass ? 'Basic ' + Buffer.from(`${o.user}:${o.pass}`).toString('base64') : null;
  const direct = new http.Agent();
  const server = http.createServer((req, res) => {
    const auth = (req.headers['proxy-authorization'] as string) || null;
    let host = '';
    try {
      host = new URL(req.url || '').host;
    } catch {
      res.writeHead(400);
      return res.end();
    }
    seen.push({ kind: 'forward', host, auth });
    if (want && auth !== want) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
      return res.end();
    }
    const u = new URL(req.url!);
    const up = http.request({ agent: direct, host: '127.0.0.1', port: o.target, path: u.pathname + u.search, method: req.method, headers: { ...req.headers, 'x-via': 'testproxy' } }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  server.on('connect', (req, sock: net.Socket, head) => {
    const auth = (req.headers['proxy-authorization'] as string) || null;
    seen.push({ kind: 'connect', host: req.url || '', auth });
    sock.on('error', () => {});
    if (want && auth !== want) return sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n');
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

/** A small SOCKS5 server for tests (RFC 1928, optional user/password RFC 1929): every CONNECT goes to one local target. */
async function socksServer(o: { target: number; user?: string; pass?: string }) {
  const seen: string[] = [];
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    let stage = 0;
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        const want = o.user || o.pass ? 2 : 0;
        if (!methods.includes(want)) return void sock.end(Buffer.from([5, 0xff]));
        sock.write(Buffer.from([5, want]));
        stage = want ? 1 : 2;
      }
      if (stage === 1) {
        if (buf.length < 2 || buf.length < 3 + buf[1] || buf.length < 3 + buf[1] + buf[2 + buf[1]]) return;
        const ul = buf[1];
        const user = buf.subarray(2, 2 + ul).toString();
        const pl = buf[2 + ul];
        const pass = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        const ok = user === o.user && pass === o.pass;
        sock.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return void sock.end();
        stage = 2;
      }
      if (stage === 2) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const alen = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buf[4];
        if (buf.length < 4 + alen + 2) return;
        const host = atyp === 3 ? buf.subarray(5, 5 + buf[4]).toString() : atyp === 1 ? [...buf.subarray(4, 8)].join('.') : 'ipv6';
        const port = buf.readUInt16BE(4 + alen);
        const rest = buf.subarray(4 + alen + 2);
        seen.push(`${host}:${port}`);
        stage = 3;
        sock.removeListener('data', onData);
        const up = net.connect(o.target, '127.0.0.1', () => {
          sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) up.write(rest);
          up.pipe(sock);
          sock.pipe(up);
        });
        up.on('error', () => sock.destroy());
      }
    };
    sock.on('data', onData);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const conns = new Set<net.Socket>();
  server.on('connection', (s) => (conns.add(s), s.on('close', () => conns.delete(s))));
  return { url: `socks5://127.0.0.1:${port}`, port, seen, close: () => new Promise<void>((r) => (conns.forEach((s) => s.destroy()), server.close(() => r()))) };
}

async function targetServer() {
  const server = http.createServer((req, res) => res.end(`doel ${req.headers.host} ${req.url} ${req.headers['x-via'] || 'direct'}`));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

const httpGet = (url: string) =>
  new Promise<string>((resolve, reject) => {
    http
      .get(url, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve(b));
      })
      .on('error', reject);
  });

test('proxy settings: address, no-proxy list (names, domains, CIDR, ports) and loopback', () => {
  assert.equal(parseProxyUrl('proxy.bedrijf.nl:8080').href, 'http://proxy.bedrijf.nl:8080/');
  assert.equal(makeUpstream({ url: 'https://p.example', noProxy: [], browser: true }).port, 443);
  assert.equal(makeUpstream({ url: 'p.example', noProxy: [], browser: true }).label, 'p.example:80');
  assert.equal(parseProxyUrl('socks5://p:1080').href, 'socks5://p:1080');
  assert.equal(parseProxyUrl('socks://p').href, 'socks5://p', 'socks:// is SOCKS5');
  assert.equal(parseProxyUrl('socks5h://p:9050').href, 'socks5://p:9050');
  assert.equal(parseProxyUrl('socks4a://p:1080').href, 'socks4://p:1080');
  assert.throws(() => parseProxyUrl('ftp://p:21'), /socks5/);
  const sp = makeUpstream({ url: 'socks5://p.example', noProxy: [], browser: true, username: 'u', password: 'x' });
  assert.deepEqual([sp.socks, sp.port, sp.label, sp.auth], [5, 1080, 'p.example:1080', null], 'SOCKS: default port 1080, no HTTP Basic header');
  assert.equal(makeUpstream({ url: 'socks4://p:1081', noProxy: [], browser: true }).socks, 4);
  assert.equal(makeUpstream({ url: 'http://p:3128', noProxy: [], browser: true }).socks, null);
  assert.throws(() => parseProxyUrl('http://u:p@p:3128'), /aparte velden/);
  assert.throws(() => parseProxyUrl('http://p:3128/pad'), /geen pad/);
  const { rules, invalid, entries } = parseNoProxy('intranet.bedrijf.nl, .corp.example  10.0.0.0/8\n192.168.1.7:8080 fd00::/8 *.wiki.example ???');
  assert.deepEqual(invalid, ['???']);
  assert.ok(entries.includes('10.0.0.0/8') && entries.includes('.wiki.example'));
  assert.ok(matchesNoProxy(rules, 'intranet.bedrijf.nl'));
  assert.ok(matchesNoProxy(rules, 'a.b.corp.example'));
  assert.ok(matchesNoProxy(rules, 'corp.example'));
  assert.ok(matchesNoProxy(rules, '10.20.30.40'));
  assert.ok(!matchesNoProxy(rules, '11.0.0.1'));
  assert.ok(matchesNoProxy(rules, '192.168.1.7', 8080));
  assert.ok(!matchesNoProxy(rules, '192.168.1.7', 80));
  assert.ok(matchesNoProxy(rules, '[fd00::1]'));
  assert.ok(matchesNoProxy(rules, 'docs.wiki.example'));
  assert.ok(!matchesNoProxy(rules, 'example.com'));
  assert.ok(matchesNoProxy(parseNoProxy('*').rules, 'whatever.example'));
  for (const h of ['localhost', 'api.localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]', '::ffff:127.0.0.1']) assert.ok(isLoopbackHost(h), h);
  assert.ok(!isLoopbackHost('128.0.0.1'));
  assert.ok(looksLocalName('intranet') && looksLocalName('nas.local') && looksLocalName('x.internal') && !looksLocalName('api.openai.com'));
  const p = makeUpstream({ url: 'http://p:3128', noProxy: ['10.0.0.0/8', '172.16.0.0/12', '.bedrijf.nl'], browser: false });
  assert.equal(upstreamFor('http://127.0.0.1:11434/api', { proxy: p }), null, 'loopback is always direct');
  assert.equal(upstreamFor('https://wiki.bedrijf.nl/', { proxy: p }), null);
  assert.equal(upstreamFor('http://10.1.1.1/', { proxy: p }), null);
  assert.equal(upstreamFor('https://api.openai.com/v1', { proxy: p }), p);
  assert.equal(upstreamFor('https://api.openai.com/v1', { proxy: p, browser: true }), null, 'browser chain can be switched off');
  assert.match(toNodeNoProxy(p), /10\.0\.0\.0-10\.255\.255\.255/);
  assert.match(toNodeNoProxy(p), /172\.16\.0\.0-172\.31\.255\.255/);
  assert.match(toNodeNoProxy(p), /127\.0\.0\.1-127\.255\.255\.255/);
});

test('fetch and http.get go through the proxy (with login), the no-proxy list and loopback stay direct, changes apply without restart', async () => {
  const target = await targetServer();
  const px = await testProxyServer({ target: target.port, user: 'jan', pass: 'gehe!m wachtwoord' });
  const px2 = await testProxyServer({ target: target.port });
  try {
    applyProxy(makeUpstream({ url: px.url, noProxy: ['.direct.test'], browser: true, username: 'jan', password: 'gehe!m wachtwoord' }));
    const body = await (await fetch('http://site.proxied.test/hallo?x=1')).text();
    // Node 26 sends plain http in absolute form, Node 24 (Electron) tunnels it with CONNECT: count at the proxy
    assert.match(body, /^doel site\.proxied\.test \/hallo\?x=1 /);
    assert.equal(px.seen.length, 1);
    assert.equal(px.seen[0].auth, 'Basic ' + Buffer.from('jan:gehe!m wachtwoord').toString('base64'));
    // Node's http(s) global agent too
    assert.match(await httpGet('http://other.proxied.test/via-http'), /^doel other\.proxied\.test \/via-http/);
    assert.equal(px.seen.length, 2);
    // loopback: direct
    assert.match(await (await fetch(`http://127.0.0.1:${target.port}/lokaal`)).text(), /direct$/);
    assert.match(await httpGet(`http://localhost:${target.port}/lokaal2`), /direct$/);
    assert.equal(px.seen.length, 2);
    // no-proxy list: direct (the name does not exist, so the direct attempt fails — and the proxy saw nothing)
    await assert.rejects(fetch('http://x.direct.test/'));
    assert.equal(px.seen.length, 2);
    // hot swap to another proxy
    applyProxy(makeUpstream({ url: px2.url, noProxy: [], browser: true }));
    assert.match(await (await fetch('http://site.proxied.test/twee')).text(), /^doel site\.proxied\.test \/twee/);
    assert.equal(px2.seen.length, 1);
    assert.equal(px.seen.length, 2);
    // off: direct again
    applyProxy(null);
    await assert.rejects(fetch('http://site.proxied.test/drie'));
    assert.equal(px2.seen.length, 1);
    assert.match(await (await fetch(`http://127.0.0.1:${target.port}/weer`)).text(), /direct$/);
  } finally {
    applyProxy(null);
    await px.close();
    await px2.close();
    await target.close();
  }
});

test('SOCKS5 proxy (with login): fetch, http.get, the browser tunnel and the test button go through it; loopback and the no-proxy list stay direct', async () => {
  const target = await targetServer();
  const sx = await socksServer({ target: target.port, user: 'jan', pass: 'gehe!m' });
  const px = await testProxyServer({ target: target.port });
  try {
    const p = makeUpstream({ url: sx.url, noProxy: ['.direct.test'], browser: true, username: 'jan', password: 'gehe!m' });
    // from an HTTP proxy to SOCKS without a restart
    applyProxy(makeUpstream({ url: px.url, noProxy: [], browser: true }));
    assert.equal(applyProxy(p).applied, true);
    assert.match(await (await fetch('http://site.proxied.test/hallo?x=1')).text(), /^doel site\.proxied\.test \/hallo\?x=1 direct$/);
    assert.deepEqual(sx.seen, ['site.proxied.test:80'], 'the name goes to the proxy (no local DNS lookup)');
    assert.equal(px.seen.length, 0, 'the previous HTTP proxy is no longer used');
    assert.match(await httpGet('http://other.proxied.test/via-http'), /^doel other\.proxied\.test \/via-http/);
    assert.equal(sx.seen.length, 2);
    // loopback and the no-proxy list: direct
    assert.match(await (await fetch(`http://127.0.0.1:${target.port}/lokaal`)).text(), /direct$/);
    assert.match(await httpGet(`http://localhost:${target.port}/lokaal2`), /direct$/);
    await assert.rejects(fetch('http://x.direct.test/'));
    assert.equal(sx.seen.length, 2);
    // the tunnel the bots' browser uses
    const sock = await openTunnel(p, 'tunnel.test', 80);
    const reply = await new Promise<string>((resolve) => {
      let b = '';
      sock.on('data', (d) => (b += d));
      sock.on('end', () => resolve(b));
      sock.write('GET /t HTTP/1.1\r\nHost: tunnel.test\r\nConnection: close\r\n\r\n');
    });
    assert.match(reply, /doel tunnel\.test \/t/);
    assert.equal(sx.seen[2], 'tunnel.test:80');
    // "Verbinding testen", and a wrong password in plain words
    const ok = await testProxy(p, 'http://check.test/');
    assert.equal(ok.ok, true, ok.message);
    const wrong = await testProxy(makeUpstream({ url: sx.url, noProxy: [], browser: true, username: 'jan', password: 'fout' }), 'http://check.test/');
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'auth-failed');
    assert.ok(!wrong.message.includes('fout'), 'never the password in a message');
    const none = await testProxy(makeUpstream({ url: sx.url, noProxy: [], browser: true }), 'https://check.test/');
    assert.equal(none.code, 'auth-required');
    // off: direct again
    applyProxy(null);
    await assert.rejects(fetch('http://site.proxied.test/drie'));
    assert.equal(sx.seen.filter((s) => s.startsWith('site.')).length, 1);
  } finally {
    applyProxy(null);
    await sx.close();
    await px.close();
    await target.close();
  }
});

test('fresh process (undici not started yet, as in Electron at startup): loopback stays direct, the rest goes via the proxy', () => {
  // bundled and run with plain node (no tsx loader, which would start undici early)
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-proxy-fresh-')), 'proxy-fresh.cjs');
  buildSync({ entryPoints: [path.join(import.meta.dirname, 'fixtures', 'proxy-fresh.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: out, logLevel: 'silent' });
  const r = spawnSync(process.execPath, [out], { encoding: 'utf8', timeout: 60_000 });
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  const line = r.stdout.trim().split('\n').pop() || '';
  const j = JSON.parse(line || '{}');
  assert.deepEqual(j.before, { s1: 'undefined', s2: 'undefined' }, 'undici had not started yet');
  assert.equal(j.applied, true, r.stderr);
  assert.equal(j.loop, `doel 127.0.0.1:${j.loop.split(':').pop()}`);
  assert.equal(j.afterLoop, 0, 'loopback went to the proxy');
  assert.equal(j.via, 'doel via.proxy.test');
  assert.deepEqual(j.seen, ['http://via.proxy.test/x'].filter(() => !j.seen[0]?.startsWith('CONNECT')).concat(j.seen[0]?.startsWith('CONNECT') ? ['CONNECT via.proxy.test:80'] : []), 'only the proxied host reached the proxy (CIDR no-proxy honoured)');
});

test('wrong or missing proxy login gives a clear error (test button, fetch, tunnel)', async () => {
  const target = await targetServer();
  const px = await testProxyServer({ target: target.port, user: 'jan', pass: 'goed' });
  try {
    const wrong = makeUpstream({ url: px.url, noProxy: [], browser: true, username: 'jan', password: 'fout' });
    const none = makeUpstream({ url: px.url, noProxy: [], browser: true });
    const good = makeUpstream({ url: px.url, noProxy: [], browser: true, username: 'jan', password: 'goed' });
    let r = await testProxy(wrong, 'http://example.test/');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'auth-failed');
    assert.match(r.message, /weigert de gebruikersnaam of het wachtwoord \(407\)/);
    r = await testProxy(none, 'http://example.test/');
    assert.equal(r.code, 'auth-required');
    assert.match(r.message, /vraagt om een gebruikersnaam en wachtwoord/);
    r = await testProxy(good, 'http://example.test/pad');
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /^Gelukt: example\.test bereikt via de proxy in \d+ ms \(HTTP 200\)\.$/);
    // https targets use CONNECT: the tunnel itself reports the 407
    await assert.rejects(openTunnel(wrong, 'example.test', 443), (e: any) => e.code === 'auth-failed' && /407/.test(e.message));
    const sock = await openTunnel(good, 'example.test', 80);
    const reply = await new Promise<string>((resolve) => {
      let b = '';
      sock.on('data', (d) => (b += d));
      sock.on('end', () => resolve(b));
      sock.write('GET /tunnel HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
    });
    assert.match(reply, /doel example\.test \/tunnel direct/);
    // the proxy is not there
    r = await testProxy(makeUpstream({ url: 'http://127.0.0.1:1', noProxy: [], browser: true }), 'http://example.test/');
    assert.equal(r.code, 'refused');
    assert.match(r.message, /weigert de verbinding/);
    // the global fetch with a wrong login fails instead of silently going direct
    applyProxy(wrong);
    await assert.rejects(async () => {
      const res = await fetch('http://example.test/');
      if (res.status === 407) throw new Error('407');
    });
  } finally {
    applyProxy(null);
    await px.close();
    await target.close();
  }
});

test('settings API: owner sets the proxy, login is stored encrypted and never returned or logged; test button; SSRF guard keeps working', async () => {
  const target = await targetServer();
  const secret = 'Zeer-Geheim-Proxy-Wachtwoord-123';
  const px = await testProxyServer({ target: target.port, user: 'piet', pass: secret });
  const t = await startTestApp();
  try {
    let v = await t.api('GET', '/admin/network/proxy');
    assert.equal(v.enabled, false);
    assert.ok(v.noProxy.includes('192.168.0.0/16'), 'sensible default no-proxy list');
    await assert.rejects(t.api('PUT', '/admin/network/proxy', { enabled: true, url: 'ftp://x' }), /http:\/\/, https:\/\/ en socks5:\/\//);
    await assert.rejects(t.api('PUT', '/admin/network/proxy', { enabled: true, url: px.url, noProxy: 'goed.nl, ?!' }), /Niet herkend/);
    // test before saving, with the typed (unsaved) values
    let r = await t.api('POST', '/admin/network/proxy/test', { url: px.url, username: 'piet', password: 'fout', target: 'http://site.proxied.test/' });
    assert.equal(r.ok, false);
    assert.match(r.message, /weigert de gebruikersnaam of het wachtwoord/);
    v = await t.api('PUT', '/admin/network/proxy', { enabled: true, url: px.url, noProxy: '.direct.test\n10.0.0.0/8', browser: true, username: 'piet', password: secret });
    assert.equal(v.active, true);
    assert.equal(v.hasAuth, true);
    assert.equal(v.activeLabel, new URL(px.url).host);
    assert.ok(!JSON.stringify(v).includes(secret) && !JSON.stringify(v).includes('piet'), 'login never returned');
    // the saved login is used by the test button
    r = await t.api('POST', '/admin/network/proxy/test', { target: 'http://site.proxied.test/' });
    assert.equal(r.ok, true, r.message);
    // app traffic through the proxy, immediately
    const before = px.seen.length;
    const res = await safeFetch('http://name-only-the-proxy-knows.test/pagina');
    assert.match(await res.text(), /^doel name-only-the-proxy-knows\.test \/pagina/);
    assert.equal(px.seen.length, before + 1);
    // SSRF guard: private, loopback and intranet-only names stay blocked even with a proxy
    await assert.rejects(assertPublicUrl('http://10.1.2.3/'), /privé-netwerk/);
    await assert.rejects(assertPublicUrl('http://localhost/'), /Lokale adressen/);
    await assert.rejects(assertPublicUrl('http://intranet/'));
    await assert.rejects(assertPublicUrl('http://nas.internal/'), /Lokale adressen/);
    // keep the saved login when only other fields change
    v = await t.api('PUT', '/admin/network/proxy', { noProxy: '.direct.test' });
    assert.equal(v.hasAuth, true);
    assert.deepEqual(v.noProxy, ['.direct.test']);
    // nowhere in plain text: database, log, audit
    await t.app.ctx.store.exec('PRAGMA wal_checkpoint(FULL)');
    for (const f of fs.readdirSync(t.dir).filter((n) => n.startsWith('teambot.db'))) assert.ok(!fs.readFileSync(path.join(t.dir, f)).includes(secret), `${f} contains the password`);
    const log = path.join(t.dir, 'logs', 'server.log');
    if (fs.existsSync(log)) assert.ok(!fs.readFileSync(log, 'utf8').includes(secret));
    const audit = t.app.ctx.store.all<any>("SELECT kind, data FROM audit WHERE kind LIKE 'network.proxy%'");
    assert.ok(audit.length >= 3);
    assert.ok(!JSON.stringify(audit).includes(secret));
    // clear the login, switch off
    v = await t.api('PUT', '/admin/network/proxy', { enabled: false, clearAuth: true });
    assert.equal(v.active, false);
    assert.equal(v.hasAuth, false);
    await assert.rejects(safeFetch('http://name-only-the-proxy-knows.test/pagina'));
  } finally {
    await t.close();
    applyProxy(null);
    await px.close();
    await target.close();
  }
});

test('members cannot see or change the proxy', async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const owner = t.app.ctx.store.users()[0];
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@example.com', password: 'wachtwoord-lid-1', role: 'member' });
    const tok = t.app.ctx.auth.createSession(m.id).token;
    const res = await fetch(t.app.url + '/api/admin/network/proxy', { headers: { authorization: `Bearer ${tok}` } });
    assert.equal(res.status, 403);
    assert.ok(owner);
  } finally {
    await t.close();
  }
});

test('the bot browser chain: policy proxy checks first, then tunnels through the owner proxy', async () => {
  const target = await targetServer();
  const px = await testProxyServer({ target: target.port, user: 'b', pass: 'c' });
  const blocked: string[] = [];
  const pp = new PolicyProxy(async (h) => {
    if (h === 'pub.example') return ['93.184.216.34'];
    if (h === 'priv.example') return ['10.0.0.5'];
    throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  });
  await pp.start();
  const creds = pp.register({ policy: () => ({ allow: [], deny: ['blocked.example'], allowPrivate: false }), onBlock: (u, r) => blocked.push(`${u} ${r}`) });
  const auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
  const connect = (host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const s = net.connect(pp.port, '127.0.0.1', () => s.write(`CONNECT ${host}:80 HTTP/1.1\r\nHost: ${host}:80\r\nProxy-Authorization: ${auth}\r\n\r\n`));
      let buf = '';
      let status = 0;
      s.on('data', (d) => {
        buf += d;
        if (!status && buf.includes('\r\n\r\n')) {
          status = Number(buf.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
          if (status !== 200) return (s.destroy(), resolve({ status, body: '' }));
          buf = '';
          s.write(`GET /chain HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        }
      });
      s.on('end', () => resolve({ status, body: buf }));
      s.on('error', reject);
    });
  try {
    applyProxy(makeUpstream({ url: px.url, noProxy: [], browser: true, username: 'b', password: 'c' }));
    let r = await connect('pub.example');
    assert.equal(r.status, 200);
    assert.match(r.body, /doel pub\.example \/chain/);
    assert.deepEqual(px.seen.map((x) => [x.kind, x.host]), [['connect', 'pub.example:80']]);
    assert.ok(px.seen[0].auth?.startsWith('Basic '), 'the owner proxy login is added by TeamBot');
    // a name only the proxy knows
    r = await connect('only-proxy-knows.example');
    assert.equal(r.status, 200);
    assert.equal(px.seen.length, 2);
    // SSRF and the domain list still win
    assert.equal((await connect('priv.example')).status, 403);
    assert.equal((await connect('intranet')).status, 403);
    assert.equal((await connect('blocked.example')).status, 403);
    assert.equal(px.seen.length, 2);
    // plain http through the chain (absolute-form to the owner proxy)
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: pp.port, path: 'http://pub.example/plain', headers: { host: 'pub.example', 'proxy-authorization': auth }, agent: false }, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => resolve(b));
        })
        .on('error', reject);
    });
    assert.match(body, /doel pub\.example \/plain testproxy/);
    assert.equal(px.seen.at(-1)?.kind, 'forward');
    // wrong login at the owner proxy: the bot learns why
    applyProxy(makeUpstream({ url: px.url, noProxy: [], browser: true, username: 'b', password: 'fout' }));
    assert.equal((await connect('pub.example')).status, 502);
    assert.ok(blocked.some((b) => /407/.test(b)), blocked.join('\n'));
  } finally {
    applyProxy(null);
    await pp.stop();
    await px.close();
    await target.close();
  }
});
