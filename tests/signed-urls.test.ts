import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { startTestApp } from './helpers.js';
import { fromBase64Url, hmacSha256, sha256, toBase64Url } from '../ui/src/lib/sign.js';

/**
 * Links to attachments, downloads, live streams and the WebSocket never carry the session token: they are signed per
 * path (HMAC with a per-session URL key), only for GET/HEAD, expire, and stop working when the session is revoked.
 */

test('the app’s own SHA-256 / HMAC-SHA256 / base64url match node:crypto', () => {
  for (const n of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const data = crypto.randomBytes(n);
    assert.equal(Buffer.from(sha256(data)).toString('hex'), crypto.createHash('sha256').update(data).digest('hex'), `sha256 len ${n}`);
    for (const kl of [0, 16, 32, 64, 65, 200]) {
      const key = crypto.randomBytes(kl);
      assert.equal(Buffer.from(hmacSha256(key, data)).toString('hex'), crypto.createHmac('sha256', key).update(data).digest('hex'), `hmac key ${kl} len ${n}`);
    }
    assert.equal(toBase64Url(data), data.toString('base64url'));
    assert.deepEqual(Buffer.from(fromBase64Url(data.toString('base64url'))), data);
  }
});

async function upload(t: Awaited<ReturnType<typeof startTestApp>>, name: string, body: string) {
  const r = await fetch(`${t.app.url}/api/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'text/plain' }, body });
  return (await r.json()) as { id: string };
}

test('signed URLs: per path, GET only, expiring, revocable; the token in a URL no longer works', async () => {
  const t = await startTestApp();
  try {
    const a = await upload(t, 'notitie.txt', 'geheime notitie');
    const b = await upload(t, 'ander.txt', 'iets anders');
    const get = (p: string, init: RequestInit = {}) => fetch(t.app.url + p, init);

    // The session token as ?token= is refused (it would end up in history and proxy logs).
    assert.equal((await get(`/api/attachments/${a.id}?token=${t.token}`)).status, 401);
    assert.equal((await get(`/api/me?token=${t.token}`)).status, 401);

    const ok = t.signed(`/api/attachments/${a.id}`);
    assert.ok(!ok.includes(t.token), 'no token in the URL');
    assert.match(ok, /[?&]tbs=ses_[^&]+&tbe=\d+&tbsig=[A-Za-z0-9_-]{43}$/);
    const r = await get(ok);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'geheime notitie');
    assert.equal((await get(ok, { method: 'HEAD' })).status, 200);

    // Scoped: another file, an extra parameter or a changed signature does not work.
    assert.equal((await get(ok.replace(a.id, b.id))).status, 401);
    assert.equal((await get(ok.replace('?tbs=', '?download=1&tbs='))).status, 401);
    assert.equal((await get(ok.slice(0, -2) + (ok.endsWith('AA') ? 'BB' : 'AA'))).status, 401);
    assert.equal((await get(ok + '&x=1')).status, 401);
    // GET only.
    assert.equal((await get(t.signed('/api/auth/logout'), { method: 'POST' })).status, 401);

    // Expired, or an expiry further away than allowed.
    const sid = t.app.ctx.auth.resolve(t.token)!.session.id;
    const key = t.app.ctx.auth.urlKey(sid);
    const make = (p: string, exp: number) => {
      const base = `${p}?tbs=${sid}&tbe=${exp}`;
      return `${base}&tbsig=${crypto.createHmac('sha256', key).update(base).digest('base64url')}`;
    };
    const nowSec = Math.floor(Date.now() / 1000);
    assert.equal((await get(make(`/api/attachments/${a.id}`, nowSec + 30))).status, 200);
    assert.equal((await get(make(`/api/attachments/${a.id}`, nowSec - 5))).status, 401);
    assert.equal((await get(make(`/api/attachments/${a.id}`, nowSec + 7 * 86400))).status, 401);

    // The URL key comes only with the real token, never via a signed link.
    const k = await t.api('GET', '/auth/url-key');
    assert.equal(k.sid, sid);
    assert.equal(Buffer.from(k.key, 'base64url').toString('hex'), key.toString('hex'));
    assert.equal((await get(t.signed('/api/auth/url-key'))).status, 403);

    // WebSocket: ?token= is refused, a signed /ws works.
    const wsOpen = (url: string) =>
      new Promise<string>((resolve) => {
        const w = new WebSocket(url);
        w.once('message', (d) => {
          resolve(JSON.parse(String(d)).type);
          w.close();
        });
        w.once('unexpected-response', (_q, res) => resolve('http ' + res.statusCode));
        w.once('error', () => resolve('error'));
      });
    const wsBase = t.app.url.replace(/^http/, 'ws');
    assert.equal(await wsOpen(`${wsBase}/ws?token=${encodeURIComponent(t.token)}`), 'http 401');
    assert.equal(await wsOpen(wsBase + t.signed('/ws')), 'hello');

    // A revoked session: its signed links stop working at once.
    const other = t.app.ctx.auth.createSession(t.app.ctx.auth.owner()!.id, 'web', 'Tweede browser');
    const link = t.signed(`/api/attachments/${a.id}`, other.token);
    assert.equal((await get(link)).status, 200);
    t.app.ctx.auth.revokeSession(other.id);
    assert.equal((await get(link)).status, 401);
    assert.equal(await wsOpen(wsBase + t.signed('/ws', other.token)), 'http 401');
  } finally {
    await t.close();
  }
});

test('the UI signs links the server accepts (fileUrl, authUrl, WebSocket) and re-signs expired ones', async () => {
  const t = await startTestApp();
  const g = globalThis as any;
  const saved = { location: g.location, fetch: g.fetch };
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map<string, string>([['tb_token', t.token]]);
  g.location = { origin: t.app.url, host: new URL(t.app.url).host, protocol: 'http:', hash: '', pathname: '/', search: '' };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
  g.fetch = (u: any, init?: any) => saved.fetch(typeof u === 'string' && u.startsWith('/') ? t.app.url + u : u, init);
  try {
    const att = await upload(t, 'plaatje.txt', 'inhoud');
    const api = await import('../ui/src/lib/' + 'api.js');
    await api.ensureUrlKey();
    assert.ok(store.get('tb_urlkey'), 'the URL key is kept for the next visit');
    const f = api.fileUrl(att.id);
    assert.ok(!f.includes(t.token));
    assert.equal(api.fileUrl(att.id), f, 'the same link while it is valid (re-renders do not reload)');
    assert.equal((await saved.fetch(t.app.url + f)).status, 200);
    const dl = await saved.fetch(t.app.url + api.fileUrl(att.id, true));
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition') || '', /^attachment/);
    // A path with odd characters is normalised exactly like the browser sends it.
    const odd = api.authUrl(`/attachments/${att.id}?naam=${encodeURIComponent('één bestand (1).txt')}&x=a b`);
    assert.equal((await saved.fetch(t.app.url + odd)).status, 200);
    // The WebSocket URL is signed too.
    const wsPath = api.signedPath('/ws');
    assert.ok(!wsPath.includes('token='));
    const hello = await new Promise<string>((resolve) => {
      const w = new WebSocket(t.app.url.replace(/^http/, 'ws') + wsPath);
      w.once('message', (d) => (resolve(JSON.parse(String(d)).type), w.close()));
      w.once('unexpected-response', (_q, r) => resolve('http ' + r.statusCode));
    });
    assert.equal(hello, 'hello');
    // An expired link (e.g. a page that stayed open) is signed again; a still-valid one is left alone.
    assert.equal(api.resignUrl(f), null);
    const base = `/api/attachments/${att.id}?tbs=${JSON.parse(await (await saved.fetch(t.app.url + '/api/auth/url-key', { headers: { authorization: `Bearer ${t.token}` } })).text()).sid}&tbe=${Math.floor(Date.now() / 1000) - 10}`;
    const stale = `${base}&tbsig=${'A'.repeat(43)}`;
    assert.equal((await saved.fetch(t.app.url + stale)).status, 401);
    const fresh = api.resignUrl(stale);
    assert.ok(fresh && fresh !== stale);
    assert.equal((await saved.fetch(t.app.url + fresh)).status, 200);
  } finally {
    Object.assign(g, saved);
    if (savedStorage) Object.defineProperty(globalThis, 'localStorage', savedStorage);
    else delete g.localStorage;
    await t.close();
  }
});
