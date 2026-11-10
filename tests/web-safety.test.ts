import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isInside } from '../server/tools/builtin/files.js';
import { RedirectError, readBytes, safeFetch } from '../server/tools/builtin/web.js';
import { parsePreview } from '../server/api/link-preview.js';
import { startTestApp } from './helpers.js';

test('safeFetch re-checks every redirect hop (no SSRF via redirect)', async () => {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (u: any) => {
    seen.push(String(u));
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } });
  }) as any;
  try {
    await assert.rejects(safeFetch('http://93.184.216.34/'), /privé|Lokale|SSRF/i);
    assert.deepEqual(seen, ['http://93.184.216.34/'], 'the private hop is never requested');
  } finally {
    globalThis.fetch = real;
  }
});

test('safeFetch: login headers stay on the origin, redirects are counted, manual gives the redirect back', async () => {
  const real = globalThis.fetch;
  const seen: { url: string; auth: string | null; etag: string | null }[] = [];
  let hops: Record<string, string> = {};
  globalThis.fetch = (async (u: any, init: any) => {
    const h = new Headers(init?.headers);
    seen.push({ url: String(u), auth: h.get('authorization'), etag: h.get('if-none-match') });
    const location = hops[String(u)];
    return location ? new Response(null, { status: 302, headers: { location } }) : new Response('klaar', { status: 200 });
  }) as any;
  try {
    // Same origin keeps the login; another origin (here: another port) loses it, also on the way back.
    hops = { 'http://93.184.216.34/a': '/b', 'http://93.184.216.34/b': 'http://93.184.216.34:8080/c', 'http://93.184.216.34:8080/c': 'http://93.184.216.34/d' };
    const res = await safeFetch('http://93.184.216.34/a', { headers: { authorization: 'Bearer geheim', 'if-none-match': '"v1"' } });
    assert.equal(res.url, 'http://93.184.216.34/d');
    assert.equal(await res.text(), 'klaar');
    assert.deepEqual(
      seen.map((s) => s.auth),
      ['Bearer geheim', 'Bearer geheim', null, null],
    );
    assert.ok(seen.every((s) => s.etag === '"v1"'), 'other headers travel along');

    // One redirect more than allowed is refused; the hook can refuse one earlier.
    hops = { 'http://93.184.216.34/1': '/2', 'http://93.184.216.34/2': '/3', 'http://93.184.216.34/3': '/4' };
    await assert.rejects(safeFetch('http://93.184.216.34/1', { maxRedirects: 2 }), (e: any) => e instanceof RedirectError && !e.to && /Te veel doorverwijzingen/.test(e.message));
    assert.equal((await safeFetch('http://93.184.216.34/1', { maxRedirects: 3 })).url, 'http://93.184.216.34/4');
    await assert.rejects(
      safeFetch('http://93.184.216.34/1', {
        onRedirect: (_from, to) => {
          if (to.pathname === '/3') throw new Error('nee');
        },
      }),
      /^Error: nee$/,
    );

    // A refused target is a RedirectError that names it; the first address keeps its own error.
    hops = { 'http://93.184.216.34/x': 'http://10.0.0.5/intern' };
    await assert.rejects(safeFetch('http://93.184.216.34/x'), (e: any) => e instanceof RedirectError && e.to?.hostname === '10.0.0.5');
    await assert.rejects(safeFetch('http://10.0.0.5/intern'), (e: any) => !(e instanceof RedirectError) && /SSRF/.test(e.message));

    const manual = await safeFetch('http://93.184.216.34/x', { redirect: 'manual' });
    assert.equal(manual.status, 302);
    assert.equal(manual.headers.get('location'), 'http://10.0.0.5/intern');
  } finally {
    globalThis.fetch = real;
  }
});

test('readBytes stops at the limit, with or without a content-length', async () => {
  assert.equal((await readBytes(new Response('12345'), 5))?.toString(), '12345');
  assert.equal(await readBytes(new Response('123456'), 5), null);
  assert.equal(await readBytes(new Response('x', { headers: { 'content-length': '999' } }), 5), null);
  assert.equal((await readBytes(new Response(null, { status: 200 }), 5))?.length, 0);
});

test('isInside: the folder itself and what is in it, never a parent, a sibling or another drive', () => {
  const root = path.resolve('/srv/team');
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(path.join(root, 'a', 'b.txt'), root), true);
  assert.equal(isInside(root + path.sep, root), true);
  assert.equal(isInside(path.join(root, '..foo'), root), true, 'a name that starts with two dots is not "up"');
  assert.equal(isInside(path.join(root, '..foo', 'x'), root), true);
  assert.equal(isInside(path.join(root, '...'), root), true);
  assert.equal(isInside(path.dirname(root), root), false, 'the parent (rel "..")');
  assert.equal(isInside(path.join(root, '..', 'other'), root), false);
  assert.equal(isInside(root + '-2', root), false, 'a sibling that shares the prefix');
  assert.equal(isInside(path.join(root, 'a', '..', '..', 'x'), root), false);
  assert.equal(isInside(path.join(root, 'a', '..', 'b'), root), true);
  if (process.platform === 'win32') {
    assert.equal(isInside('D:\\elders\\x', 'C:\\team'), false, 'another drive (an absolute rel)');
    assert.equal(isInside('C:\\TEAM\\Map\\x.txt', 'c:\\team\\map'), true, 'letter case does not matter on Windows');
    assert.equal(isInside('\\\\server\\share\\x', 'C:\\team'), false);
  } else {
    assert.equal(isInside('/srv/TEAM/x', '/srv/team'), false);
  }
});

test('link preview parses Open Graph and blocks private addresses', async () => {
  const p = parsePreview('<html><head><title>Fallback</title><meta property="og:title" content="Echte &amp; titel"><meta name="description" content="Omschrijving"><meta property="og:image" content="/img.png"><meta property="og:site_name" content="Voorbeeld"></head></html>', 'https://voorbeeld.nl/pagina');
  assert.equal(p.title, 'Echte & titel');
  assert.equal(p.description, 'Omschrijving');
  assert.equal(p.image, 'https://voorbeeld.nl/img.png');
  assert.equal(p.site, 'Voorbeeld');
  const t = await startTestApp({ modules: [] });
  try {
    const r = await t.api('GET', `/link-preview?url=${encodeURIComponent('http://127.0.0.1:1/x')}`);
    assert.equal(r.error, 'geblokkeerd');
  } finally {
    await t.close();
  }
});

test('diagnostics contain no message contents or secrets and are admin-only', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    await t.api('PUT', '/secrets/zeer_geheim', { value: 'sk-SUPERSECRET-1234567890abcdef' });
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'Mijn privébericht met wachtwoord hunter2');
    const res = await fetch(`${t.app.url}/api/admin/diagnostics`, { headers: { authorization: `Bearer ${t.token}` } });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!text.includes('hunter2'), 'no message contents');
    assert.ok(!text.includes('SUPERSECRET'), 'no secret values');
    assert.match(text, /teambot\.diagnostics\/v1/);
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid2@test.local', password: 'geheim1234', role: 'member' });
    const s = t.app.ctx.auth.createSession(m.id, 'web', 'x');
    assert.equal((await fetch(`${t.app.url}/api/admin/diagnostics`, { headers: { authorization: `Bearer ${s.token}` } })).status, 403);
  } finally {
    await t.close();
  }
});

test('blocked free search falls back to Wikipedia and says so honestly', async () => {
  const { webSearchDetailed } = await import('../server/tools/builtin/web.js');
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    if (url.includes('duckduckgo')) return new Response('<html>anomaly challenge</html>', { status: 202 });
    if (url.includes('wikipedia.org/w/api.php')) return new Response(JSON.stringify({ query: { search: [{ title: 'Lima (stad)', snippet: 'hoofdstad van <span>Peru</span>' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('', { status: 404 });
  }) as any;
  try {
    const fake: any = { store: { getSetting: () => null }, secrets: { getByName: () => null } };
    const o = await webSearchDetailed(fake, 'u', 'hoofdstad van Peru', 5);
    assert.equal(o.source, 'wikipedia');
    assert.match(o.note!, /blokkeert/);
    assert.equal(o.results[0].url, 'https://nl.wikipedia.org/wiki/Lima_(stad)');
    assert.equal(o.results[0].snippet, 'hoofdstad van Peru');
  } finally {
    globalThis.fetch = real;
  }
});

test('SSRF guard blocks IPv4-in-IPv6, NAT64, metadata and reserved ranges', async () => {
  const { isPrivateIp, assertPublicUrl } = await import('../server/tools/builtin/web.js');
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '::127.0.0.1', '::1', 'fd00::1', 'fe80::1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0'])
    assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8']) assert.equal(isPrivateIp(ip), false, ip);
  for (const u of ['http://[::ffff:127.0.0.1]:8080/', 'http://[::ffff:7f00:1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://localhost/'])
    await assert.rejects(assertPublicUrl(u), /privé|Lokale|SSRF/i, u);
});
