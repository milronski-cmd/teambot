process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1'; // never open GUI windows in tests

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { startTestApp, type TestApp } from './helpers.js';
import { base32Encode, isInsecureOrigin, normalizeOrigin, originMatches, parseOrigins, parseTotp, scrubSecrets, secretVariants, totpCode, VaultInputError } from '../server/modules/browser/vault.js';
import { browserCandidates, realProbes } from '../server/modules/browser/capabilities.js';
import { SENSITIVE_SELECTOR } from '../server/modules/browser/pagescripts.js';
import { siteOf, type ComputerService } from '../server/modules/browser/service.js';

const svcOf = (t: TestApp): ComputerService => t.app.ctx.services.computers._service;

async function asUser(t: TestApp, token: string, method: string, p: string, body?: any) {
  const res = await fetch(t.app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 10_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timeout');
}

/** Everything TeamBot stored or logged: every table, as JSON. */
function dumpDb(t: TestApp): string {
  const tables = t.app.ctx.store.all<any>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  return tables.map((n) => JSON.stringify(t.app.ctx.store.all(`SELECT * FROM "${n}"`))).join('\n');
}

function captureLogs(t: TestApp): string[] {
  const out: string[] = [];
  const log: any = t.app.ctx.log;
  for (const k of ['info', 'warn', 'error']) {
    const orig = log[k].bind(log);
    log[k] = (...a: any[]) => {
      out.push(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? `${x.message} ${x.stack}` : JSON.stringify(x))).join(' '));
      return orig(...a);
    };
  }
  return out;
}

// ---------------- unit: exact origins (phishing guard) ----------------

test('vault origins: normalised to one exact origin; no wildcards, no other schemes, no lookalikes', () => {
  assert.equal(normalizeOrigin('ads.google.com'), 'https://ads.google.com');
  assert.equal(normalizeOrigin('https://Accounts.Google.com/signin/v2?x=1#y'), 'https://accounts.google.com');
  assert.equal(normalizeOrigin('https://shop.example.nl:443/login'), 'https://shop.example.nl');
  assert.equal(normalizeOrigin('http://127.0.0.1:8080/login'), 'http://127.0.0.1:8080');
  assert.equal(normalizeOrigin('localhost:3000'), 'https://localhost:3000');
  assert.equal(normalizeOrigin('https://bücher.example'), 'https://xn--bcher-kva.example');
  for (const bad of ['', 'javascript:alert(1)', 'file:///C:/x', 'ftp://example.com', '*.google.com', 'https://*.google.com', 'https://user:pw@example.com', 'mailto:a@b.nl', 'google com'])
    assert.throws(() => normalizeOrigin(bad), VaultInputError, bad);
  assert.deepEqual(parseOrigins('accounts.google.com\nhttps://ads.google.com/aw, accounts.google.com'), ['https://accounts.google.com', 'https://ads.google.com']);
  assert.throws(() => parseOrigins(''), VaultInputError);
  assert.throws(() => parseOrigins(['a.nl', 'b.nl', 'c.nl', 'd.nl', 'e.nl', 'f.nl']), VaultInputError);

  const o = ['https://accounts.google.com'];
  assert.equal(originMatches(o, 'https://accounts.google.com/v3/signin/identifier?continue=x'), true);
  for (const phish of [
    'http://accounts.google.com/', // other scheme
    'https://accounts.google.com:8443/', // other port
    'https://evil.accounts.google.com/', // subdomain
    'https://accounts.google.com.evil.com/', // suffix trick
    'https://accounts-google.com/',
    'https://xn--ccounts-6ve.google.com/', // lookalike (IDN)
    'https://evil.com/?u=https://accounts.google.com',
    'https://evil.com/#https://accounts.google.com',
    'about:blank',
    'data:text/html,<form>',
  ])
    assert.equal(originMatches(o, phish), false, phish);
  assert.equal(isInsecureOrigin('http://shop.example.nl'), true);
  assert.equal(isInsecureOrigin('http://127.0.0.1:9000'), false);
  assert.equal(isInsecureOrigin('https://shop.example.nl'), false);
  assert.equal(siteOf('.accounts.google.com'), 'google.com');
  assert.equal(siteOf('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(siteOf('https://www.amazon.nl/gp/cart'), 'amazon.nl');
  assert.equal(siteOf('127.0.0.1'), '127.0.0.1');
});

// ---------------- unit: TOTP ----------------

test('TOTP: RFC 6238 test vectors (SHA1/256/512, 8 digits), base32 and otpauth:// input', () => {
  const keys = {
    SHA1: '12345678901234567890',
    SHA256: '12345678901234567890123456789012',
    SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
  } as const;
  const vectors: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [sec, s1, s256, s512] of vectors) {
    for (const [alg, want] of [['SHA1', s1], ['SHA256', s256], ['SHA512', s512]] as const) {
      const spec = { secret: base32Encode(Buffer.from(keys[alg])), algorithm: alg, digits: 8 as const, period: 30 };
      assert.equal(totpCode(spec, sec * 1000).code, want, `${alg} @ ${sec}`);
    }
  }
  // what authenticator apps show: 6 digits of the same HMAC
  const p = parseTotp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq');
  assert.deepEqual(p, { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 6, period: 30 });
  assert.equal(totpCode(p, 59_000).code, '287082');
  assert.equal(totpCode(p, 59_000).remainingSec, 1);
  const uri = parseTotp('otpauth://totp/Shop:sanne%40example.nl?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&issuer=Shop&algorithm=SHA256&digits=8&period=30');
  assert.equal(uri.algorithm, 'SHA256');
  assert.equal(totpCode(uri, 59_000).code, '46119246');
  for (const bad of ['', 'not base32!', 'ABCD', 'otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ', 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=4', 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&algorithm=MD5'])
    assert.throws(() => parseTotp(bad), VaultInputError, bad);
});

test('scrubbing: plain, URL-encoded and form-encoded variants are replaced', () => {
  const pw = 'p@ss wörd&1';
  const v = secretVariants(pw);
  assert.ok(v.includes(encodeURIComponent(pw)) && v.includes(encodeURIComponent(pw).replace(/%20/g, '+')));
  const text = `Nu op: https://x.nl/?password=${encodeURIComponent(pw).replace(/%20/g, '+')} en ${pw}`;
  const clean = scrubSecrets(text, v);
  assert.doesNotMatch(clean, /p@ss|p%40ss/);
  assert.match(clean, /\[verborgen\].*\[verborgen\]/);
});

// ---------------- API: encryption at rest, write-only secrets, permissions ----------------

test('vault API: encrypted at rest, write-only secrets, own entries only, not on a phone, cleanup', async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const logs = captureLogs(t);
    const a = await t.agent({ name: 'Operations' });
    const b = await t.agent({ name: 'Marketing' });
    const PW = 'Zeer-Geheim-Wachtwoord-42!';
    const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const e = await t.api('POST', '/computers/vault', { label: 'Google Ads', origins: 'accounts.google.com\nads.google.com', username: 'sanne@example.nl', password: PW, totp: TOTP, agent_ids: [a.id] });
    assert.deepEqual(e.origins, ['https://accounts.google.com', 'https://ads.google.com']);
    assert.equal(e.has_password, true);
    assert.equal(e.has_totp, true);
    assert.equal(e.username, 'sanne@example.nl');
    assert.equal(e.password, undefined);
    assert.equal(e.totp, undefined);
    assert.deepEqual(e.agent_ids, [a.id]);
    // nothing readable at rest: not in the vault table, not as a named secret, not in audit or logs
    const raw = t.app.ctx.store.get<any>('vault_logins', e.id);
    for (const col of ['username_enc', 'password_enc', 'totp_enc']) assert.match(raw[col], /^v1:/, col);
    const db = dumpDb(t);
    for (const s of [PW, TOTP, 'sanne@example.nl']) assert.ok(!db.includes(s), `${s} not stored in plain text`);
    assert.equal(t.app.ctx.secrets.list(e.user_id || t.app.ctx.auth.owner()!.id).filter((x) => x.name.includes(e.id)).length, 0);
    assert.ok(!logs.join('\n').includes(PW));
    // list and update never return the secrets; empty password keeps the old one
    const list = await t.api('GET', '/computers/vault');
    assert.equal(list.length, 1);
    assert.ok(!JSON.stringify(list).includes(PW) && !JSON.stringify(list).includes(TOTP));
    const u = await t.api('PUT', `/computers/vault/${e.id}`, { label: 'Ads', password: '' });
    assert.equal(u.has_password, true);
    assert.equal(svcOf(t).vault!.credentials(svcOf(t).vault!.row(e.id)!).password, PW);
    const noTotp = await t.api('PUT', `/computers/vault/${e.id}`, { totp: null });
    assert.equal(noTotp.has_totp, false);
    // validation
    await assert.rejects(t.api('POST', '/computers/vault', { origins: '*.google.com', password: 'x' }), /400/);
    await assert.rejects(t.api('POST', '/computers/vault', { origins: 'google.com' }), /wachtwoord/);
    await assert.rejects(t.api('POST', '/computers/vault', { origins: 'google.com', password: 'x', totp: 'niet-base32' }), /2FA/);
    // which bots may ask: only Operations; Marketing gets no match
    const vault = svcOf(t).vault!;
    const opsAgent = t.app.ctx.store.agent(a.id)!;
    const mktAgent = t.app.ctx.store.agent(b.id)!;
    assert.equal(vault.matchesFor(opsAgent, 'https://accounts.google.com/signin').length, 1);
    assert.equal(vault.matchesFor(mktAgent, 'https://accounts.google.com/signin').length, 0);
    assert.equal(vault.matchesFor(opsAgent, 'https://accounts.google.com.evil.com/signin').length, 0);
    // grants: revoke via API
    vault.addGrant(opsAgent.user_id, e.id, a.id, 'https://accounts.google.com');
    assert.equal((await t.api('GET', '/computers/vault'))[0].grants.length, 1);
    const rv = await t.api('DELETE', `/computers/vault/${e.id}/grants/${a.id}`);
    assert.equal(rv.grants.length, 0);
    // another user cannot see or change it
    const other = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@example.nl', password: 'wachtwoord123', role: 'member' });
    const otherTok = t.app.ctx.auth.createSession(other.id, 'web').token;
    assert.equal((await asUser(t, otherTok, 'GET', '/computers/vault')).body.length, 0);
    assert.equal((await asUser(t, otherTok, 'PUT', `/computers/vault/${e.id}`, { password: 'gekaapt' })).status, 404);
    assert.equal((await asUser(t, otherTok, 'DELETE', `/computers/vault/${e.id}`)).status, 404);
    // a paired phone may not manage the vault, but may watch the bot's browser
    const owner = t.app.ctx.auth.owner()!;
    const phone = t.app.ctx.auth.createSession(owner.id, 'device', 'Telefoon', 365).token;
    assert.equal((await asUser(t, phone, 'GET', '/computers/vault')).status, 403);
    assert.equal((await asUser(t, phone, 'POST', '/computers/vault', { origins: 'x.nl', password: 'y' })).status, 403);
    assert.equal((await asUser(t, phone, 'GET', `/computers/${a.id}`)).status, 200);
    assert.equal((await asUser(t, phone, 'POST', `/computers/${a.id}/takeover`, { visible: true })).status, 403);
    // export: which logins exist, never the credentials
    const exp = JSON.stringify(svcOf(t).exportUser(owner.id));
    assert.ok(exp.includes(e.id) && !exp.includes(PW) && !exp.includes('sanne@example.nl'));
    // deleting a bot removes it from entries and grants
    vault.addGrant(owner.id, e.id, a.id, 'https://accounts.google.com');
    await t.api('DELETE', `/agents/${a.id}`);
    await waitFor(() => vault.row(e.id)!.agent_ids.length === 0);
    assert.equal(t.app.ctx.store.all('SELECT * FROM vault_grants').length, 0);
    await t.api('DELETE', `/computers/vault/${e.id}`);
    assert.equal(vault.row(e.id), null);
    assert.ok(!logs.join('\n').includes(PW));
  } finally {
    await t.close();
  }
});

// ---------------- integration: a local test site with a login form ----------------

const installed = browserCandidates(realProbes);

const USER = 'sanne@example.nl';
const PASS = 'Kluis-Wachtwoord-9!x';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px sans-serif;margin:24px}input{display:block;margin:6px 0 12px;padding:6px;width:260px;font-size:16px}</style></head><body>${body}</body></html>`;
const LOGIN_FORM = (err = '') =>
  page(
    'Inloggen',
    `<h1>Inloggen bij Testwinkel</h1>${err ? `<p role="alert">${err}</p>` : ''}
     <input name="q" placeholder="Zoeken in de winkel">
     <form method="post" action="/login"><label for="u">E-mailadres</label><input id="u" name="email" type="email" autocomplete="username">
     <label for="p">Wachtwoord</label><input id="p" name="password" type="password" autocomplete="current-password">
     <a href="/vergeten">Wachtwoord vergeten?</a> <button type="submit">Inloggen</button></form>`,
  );

function parseBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      if ((req.headers['content-type'] || '').includes('json')) {
        try {
          return resolve(JSON.parse(b));
        } catch {
          return resolve({});
        }
      }
      resolve(Object.fromEntries(new URLSearchParams(b)));
    });
  });
}

function testSite() {
  const hits: string[] = [];
  const posted: Record<string, string>[] = [];
  const cookie = (req: http.IncomingMessage, k: string) => (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(k + '='))?.slice(k.length + 1);
  const html = (res: http.ServerResponse, s: string, extra: Record<string, string | string[]> = {}) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra });
    res.end(s);
  };
  const go = (res: http.ServerResponse, to: string, extra: Record<string, string | string[]> = {}) => {
    res.writeHead(302, { location: to, ...extra });
    res.end();
  };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    hits.push(`${req.method} ${url.pathname}`);
    const body = req.method === 'POST' ? await parseBody(req) : {};
    if (req.method === 'POST') posted.push({ path: url.pathname, ...body });
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /login':
        return html(res, LOGIN_FORM());
      case 'POST /login':
        if (body.email === USER && body.password === PASS) return go(res, '/2fa', { 'set-cookie': 'step=pw-ok; Path=/' });
        return html(res, LOGIN_FORM('Onjuist e-mailadres of wachtwoord.'));
      case 'GET /2fa':
        if (cookie(req, 'step') !== 'pw-ok') return go(res, '/login');
        return html(res, page('Verificatie', `<h1>Tweestapsverificatie</h1><form method="post" action="/2fa"><label for="c">Verificatiecode uit je app</label><input id="c" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"><button>Verifiëren</button></form>`));
      case 'POST /2fa': {
        const spec = parseTotp(TOTP_SECRET);
        const ok = [0, -30_000].some((d) => totpCode(spec, Date.now() + d).code === body.code);
        if (ok && cookie(req, 'step') === 'pw-ok') return go(res, '/dashboard', { 'set-cookie': ['auth=ok; Path=/', 'step=; Path=/; Max-Age=0'] });
        return html(res, page('Verificatie', '<p role="alert">Code onjuist</p>'));
      }
      case 'GET /dashboard':
        if (cookie(req, 'auth') !== 'ok') return go(res, '/login');
        return html(res, page('Mijn account', '<h1>Welkom terug</h1><p>Je bestellingen</p>'));
      // two-step: username first, then the password on a second page
      case 'GET /stap1':
        return html(res, page('Aanmelden', `<form method="post" action="/stap1"><label for="id">E-mailadres of telefoon</label><input id="id" name="identifier" type="email" autocomplete="username"><button>Volgende</button></form>`));
      case 'POST /stap1':
        return go(res, '/stap2', { 'set-cookie': `who=${encodeURIComponent(body.identifier || '')}; Path=/` });
      case 'GET /stap2':
        return html(res, page('Wachtwoord', `<form method="post" action="/stap2"><label for="pw">Voer je wachtwoord in</label><input id="pw" name="Passwd" type="password" autocomplete="current-password"><button>Volgende</button></form>`));
      case 'POST /stap2':
        if (decodeURIComponent(cookie(req, 'who') || '') === USER && body.Passwd === PASS) return go(res, '/klaar', { 'set-cookie': 'auth2=ok; Path=/' });
        return go(res, '/stap2');
      case 'GET /klaar':
        return html(res, page('Klaar', '<h1>Aangemeld</h1>'));
      case 'GET /registreren':
        return html(res, page('Account maken', `<form method="post" action="/registreren"><label for="e">E-mail</label><input id="e" name="email" type="email" autocomplete="username"><label for="n1">Nieuw wachtwoord</label><input id="n1" type="password" name="p1" autocomplete="new-password"><label for="n2">Herhaal</label><input id="n2" type="password" name="p2" autocomplete="new-password"><button>Account maken</button></form>`));
      // a (bad) site that logs in with GET: the password would land in the address bar
      case 'GET /oud':
        return html(res, page('Oud', `<form action="/oud-in"><label for="u">Gebruikersnaam</label><input id="u" name="user" autocomplete="username"><label for="p">Wachtwoord</label><input id="p" name="pass" type="password"><button>Inloggen</button></form>`));
      case 'GET /oud-in':
        return html(res, page('Oud', '<h1>Ingelogd (oud)</h1>'));
      // single-page app: the password field disappears in place, the username field stays
      case 'GET /app':
        return html(
          res,
          page(
            'App',
            `<form id="f"><label for="u">Gebruikersnaam</label><input id="u" name="username" autocomplete="username"><label for="p">Wachtwoord</label><input id="p" name="password" type="password"><button id="b">Inloggen</button></form><div id="ok" hidden><h1>Welkom in de app</h1></div>
             <script>document.getElementById('f').onsubmit = async (e) => { e.preventDefault(); const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u: document.getElementById('u').value, p: document.getElementById('p').value }) }); if (r.ok) { document.getElementById('p').remove(); document.getElementById('b').remove(); document.querySelector('label[for=p]').remove(); document.getElementById('ok').hidden = false; history.pushState({}, '', '/app/home'); } };</script>`,
          ),
        );
      case 'POST /api/login':
        res.writeHead(body.u === USER && body.p === PASS ? 200 : 401, { 'content-type': 'application/json' });
        return res.end('{}');
      default:
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('niet gevonden');
    }
  });
  return { srv, hits, posted };
}

/** Minimal PNG decoder (8-bit RGB/RGBA, all five filters) to check that a masked region is black. */
function decodePng(buf: Buffer): { w: number; h: number; ch: number; px: Buffer } {
  let off = 8;
  let w = 0;
  let h = 0;
  let ch = 4;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ch = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const left = x >= ch ? px[y * stride + x - ch] : 0;
      const up = y ? px[(y - 1) * stride + x] : 0;
      const ul = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0;
      const p = left + up - ul;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - ul);
      const pred = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { w, h, ch, px };
}

test(
  'vault login on a local test site: approval, TeamBot fills (incl. TOTP), the model never sees a secret; deny, always, phishing, failures',
  { skip: installed.length ? false : 'Geen Edge/Chrome/Chromium gevonden op dit apparaat', timeout: 240_000 },
  async () => {
    const { srv, hits, posted } = testSite();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const base = `http://127.0.0.1:${port}`;
    const t = await startTestApp();
    const logs = captureLogs(t);
    try {
      const svc = svcOf(t);
      const a = await t.agent({ name: 'Operations', tool_groups: ['files'] });
      await t.api('PUT', `/computers/${a.id}/config`, { mode: 'browser', allow_private: true });
      const entry = await t.api('POST', '/computers/vault', { label: 'Testwinkel', origins: base, username: USER, password: PASS, totp: TOTP_SECRET });
      const th = await t.api('POST', '/threads', { agentId: a.id });

      // 1) through the runner: the bot asks, the owner approves, TeamBot fills password + TOTP
      t.script.push({ toolCalls: [{ name: 'browser_request_login', args: { url: base + '/login', reason: 'bestellingen bekijken' } }] }, { text: 'Gelukt.' });
      await t.api('POST', `/threads/${th.id}/messages`, { content: 'log in bij de testwinkel' });
      const ask = await waitFor(async () => (await t.api('GET', '/approvals')).find((x: any) => x.tool === 'browser_vault_login'), 30_000);
      assert.equal(ask.kind, 'question');
      assert.equal(ask.risk, 'danger');
      assert.match(ask.summary, new RegExp(`Operations wil inloggen op 127\\.0\\.0\\.1:${port} als ${USER.replace('.', '\\.')}`));
      assert.deepEqual(ask.options, [`Inloggen als ${USER}`, 'Zelf inloggen', 'Niet nu']);
      assert.ok(!posted.length, 'nothing is filled or sent before the approval');
      await t.api('POST', `/approvals/${ask.id}`, { decision: 'approve', answer: ask.options[0] });
      await t.waitIdle(th.id, 90_000);
      assert.ok(posted.some((p) => p.path === '/login' && p.email === USER && p.password === PASS), 'the site received the login');
      assert.ok(posted.some((p) => p.path === '/2fa' && /^\d{6}$/.test(p.code)), 'and a TOTP code');
      assert.ok(hits.includes('GET /dashboard'));
      const msgs = t.app.ctx.store.messages(th.id);
      const result = msgs.find((m: any) => m.role === 'tool');
      assert.match(result!.content, /^Ingelogd op 127\.0\.0\.1/);
      const code = posted.find((p) => p.path === '/2fa')!.code;
      // the model saw none of it: not the password, not the username, not the TOTP secret, not the code
      const toModel = JSON.stringify(t.requests);
      for (const s of [PASS, USER, TOTP_SECRET, code]) assert.ok(!toModel.includes(s), `model input contains ${s === code ? 'the TOTP code' : s}`);
      for (const m of msgs) for (const s of [PASS, TOTP_SECRET]) assert.ok(!JSON.stringify(m).includes(s));
      assert.ok(!JSON.stringify(msgs.filter((m: any) => m.role !== 'user')).includes(USER));
      const db = dumpDb(t);
      for (const s of [PASS, TOTP_SECRET]) assert.ok(!db.includes(s), `stored somewhere: ${s}`);
      const steps = JSON.stringify(t.app.ctx.store.all('SELECT * FROM computer_actions'));
      const audit = JSON.stringify(t.app.ctx.store.all("SELECT * FROM audit WHERE kind LIKE 'vault.%' OR kind LIKE 'computer.%' OR kind LIKE 'browser.%'"));
      const actions = steps + audit;
      assert.ok(!actions.includes(code), 'no TOTP code in the step log or audit');
      assert.ok(!actions.includes(USER), 'no username in the step log or the vault audit');
      assert.match(actions, /Kluis: ingelogd op 127\.0\.0\.1/);
      assert.match(actions, /vault\.login/);
      assert.ok(!logs.join('\n').includes(PASS));

      const tc = () => {
        const s = t.app.ctx.store;
        const agent = s.agent(a.id)!;
        const run = s.createRun({ thread_id: th.id, agent_id: agent.id, user_id: agent.user_id, status: 'running' });
        const ac = new AbortController();
        return { ctx: t.app.ctx, agent, thread: s.thread(th.id)!, run, userId: agent.user_id, signal: ac.signal, toolCallId: 'call_v', progress: () => {}, abort: () => ac.abort() };
      };
      const call = async (name: string, args: any, ctxt = tc()) => {
        try {
          const r: any = await t.app.ctx.tools.get(name)!.run(args, ctxt as any);
          return typeof r === 'string' ? { text: r } : r;
        } finally {
          svc.leases.releaseHolder(ctxt.run.id);
        }
      };
      /** Run a tool that asks the owner; answer with `decide` once the question shows up. */
      const withAnswer = async (args: any, decide: ((x: any) => any) | null) => {
        const before = new Set((await t.api('GET', '/approvals')).map((x: any) => x.id));
        const p = call('browser_request_login', args);
        if (decide) {
          const q = await waitFor(async () => (await t.api('GET', '/approvals')).find((x: any) => !before.has(x.id)), 30_000);
          await t.api('POST', `/approvals/${q.id}`, decide(q));
          return { out: await p, q };
        }
        return { out: await p, q: null };
      };
      const logOut = () => svc.sessionOf(t.app.ctx.store.agent(a.id)!)!.context.clearCookies();

      // 2) deny: nothing is filled, nothing posted
      await logOut();
      posted.length = 0;
      let r = await withAnswer({ url: base + '/login' }, () => ({ decision: 'approve', answer: 'Niet nu' }));
      assert.match(r.out.text, /niet goedgekeurd/);
      assert.equal(posted.length, 0);
      const s = svc.sessionOf(t.app.ctx.store.agent(a.id)!)!;
      assert.equal(await s.active.inputValue('#p'), '', 'password field still empty');

      // 3) "always for this bot on this site": next time no question
      r = await withAnswer({ url: base + '/login' }, (q) => ({ decision: 'always', answer: q.options[0] }));
      assert.match(r.out.text, /^Ingelogd/);
      assert.equal((await t.api('GET', '/computers/vault'))[0].grants.length, 1);
      await logOut();
      const before = (await t.api('GET', '/approvals?status=all')).length;
      r = await withAnswer({ url: base + '/login' }, null);
      assert.match(r.out.text, /^Ingelogd/, r.out.text);
      assert.equal((await t.api('GET', '/approvals?status=all')).length, before, 'no new approval');
      // a phone can never grant "always"
      const owner = t.app.ctx.auth.owner()!;
      const phone = t.app.ctx.auth.createSession(owner.id, 'device', 'Telefoon', 365).token;
      await t.api('DELETE', `/computers/vault/${entry.id}/grants/${a.id}`);
      await logOut();
      const pend = call('browser_request_login', { url: base + '/login' });
      const q = await waitFor(async () => (await t.api('GET', '/approvals')).find((x: any) => x.tool === 'browser_vault_login'), 30_000);
      assert.equal((await asUser(t, phone, 'POST', `/approvals/${q.id}`, { decision: 'always', answer: q.options[0] })).status, 403);
      assert.equal((await asUser(t, phone, 'POST', `/approvals/${q.id}`, { decision: 'approve', answer: 'Niet nu' })).status, 200);
      await pend;
      assert.equal((await t.api('GET', '/computers/vault'))[0].grants.length, 0);

      // 4) phishing guard: an identical login page on another origin (same host, other port) → no vault, manual flow
      const fake = testSite();
      await new Promise<void>((res) => fake.srv.listen(0, '127.0.0.1', () => res()));
      const fakeBase = `http://127.0.0.1:${(fake.srv.address() as any).port}`;
      try {
        posted.length = 0;
        r = await withAnswer({ url: `${fakeBase}/login` }, (x) => {
          assert.equal(x.tool, 'browser_request_login', 'falls back to "log in yourself"');
          return { decision: 'approve', answer: 'Niet nu' };
        });
        assert.equal(posted.length + fake.posted.length, 0);
        assert.match((await call('browser_request_login', { url: `${fakeBase}/login`, method: 'kluis' })).text, /geen login/);
        assert.equal(fake.posted.length, 0, 'nothing ever reached the look-alike site');
      } finally {
        fake.srv.close();
      }

      // 5) wrong password: "mislukt", fields emptied again
      await t.api('PUT', `/computers/vault/${entry.id}`, { password: 'fout-wachtwoord-123' });
      r = await withAnswer({ url: base + '/login' }, (x) => ({ decision: 'approve', answer: x.options[0] }));
      assert.equal(r.out.isError, true);
      assert.match(r.out.text, /^Mislukt: .*accepteerde de inloggegevens niet/);
      assert.doesNotMatch(r.out.text, /fout-wachtwoord|sanne/);
      assert.equal(await svc.sessionOf(t.app.ctx.store.agent(a.id)!)!.active.inputValue('#p'), '');
      await t.api('PUT', `/computers/vault/${entry.id}`, { password: PASS });

      // 6) two-step sign-in (username, then password) on another entry
      await t.api('PUT', `/computers/vault/${entry.id}`, { totp: null });
      r = await withAnswer({ url: base + '/stap1' }, (x) => ({ decision: 'approve', answer: x.options[0] }));
      assert.match(r.out.text, /^Ingelogd/, r.out.text);
      assert.ok(hits.includes('GET /klaar'));

      // 7) a sign-up / change-password form is never filled
      posted.length = 0;
      r = await withAnswer({ url: base + '/registreren' }, (x) => ({ decision: 'approve', answer: x.options[0] }));
      assert.match(r.out.text, /account te maken/);
      assert.equal(posted.length, 0);

      // 8) a site that puts the password in the URL: stopped, and the bot never sees the value
      r = await withAnswer({ url: base + '/oud' }, (x) => ({ decision: 'approve', answer: x.options[0] }));
      assert.match(r.out.text, /adres van de pagina/);
      const back = await call('browser_back', {});
      assert.ok(!back.text.includes(PASS) && !back.text.includes(encodeURIComponent(PASS)), 'scrubbed from later tool results');

      // 9) single-page app: the username field stays on the page, but masked and hidden from the bot
      r = await withAnswer({ url: base + '/app' }, (x) => ({ decision: 'approve', answer: x.options[0] }));
      assert.match(r.out.text, /^Ingelogd/, r.out.text);
      const sess = svc.sessionOf(t.app.ctx.store.agent(a.id)!)!;
      assert.equal(await sess.active.inputValue('#u'), USER, 'the username is really in the page');
      const snap = await call('browser_snapshot', {});
      assert.match(snap.text, /ingevuld door de kluis van TeamBot, verborgen/);
      assert.ok(!snap.text.includes(USER), 'snapshot hides it');
      assert.ok(await sess.active.locator('#u').evaluate((el: any, sel) => el.matches(sel), SENSITIVE_SELECTOR), 'screenshot mask covers it');
      const ref = snap.text.match(/\[(e\d+)\][^\n]*Gebruikersnaam/)![1];
      const typed = await call('browser_type', { ref, text: 'iets anders' });
      assert.equal(typed.isError, true, 'the bot cannot type into a vault field');
      const box = (await sess.active.locator('#u').boundingBox())!;
      const shot = await sess.active.screenshot({ type: 'png', clip: { x: box.x + 2, y: box.y + 2, width: box.width - 4, height: box.height - 4 }, mask: [sess.active.locator(SENSITIVE_SELECTOR)], maskColor: '#000000' });
      const img = decodePng(shot);
      let maxRgb = 0;
      for (let i = 0; i < img.px.length; i += img.ch) maxRgb = Math.max(maxRgb, img.px[i], img.px[i + 1], img.px[i + 2]);
      assert.ok(maxRgb < 16, `masked region is black (max ${maxRgb})`);
      const tool = await call('browser_screenshot', {});
      assert.equal(tool.attachments?.[0]?.mime, 'image/png');

      // nothing of this leaked into logs, audit, step log or the database
      const all = dumpDb(t) + logs.join('\n');
      for (const sec of [PASS, TOTP_SECRET, 'fout-wachtwoord-123']) assert.ok(!all.includes(sec), sec);
    } finally {
      await t.close();
      srv.close();
    }
  },
);

test('profiles: share one profile between selected bots; log out of one site', { skip: installed.length ? false : 'Geen Edge/Chrome/Chromium gevonden op dit apparaat', timeout: 120_000 }, async () => {
  const srv = http.createServer((req, res) => {
    // "logging in" sets the session cookie once, then shows the start page (a reload does not set it again)
    if (req.url === '/inloggen') {
      res.writeHead(302, { location: '/', 'set-cookie': ['sessie=abc; Path=/; Max-Age=3600'] });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Site</title><h1>Hoi</h1>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const t = await startTestApp();
  try {
    const svc = svcOf(t);
    const a = await t.agent({ name: 'Operations', tool_groups: ['files'] });
    const b = await t.agent({ name: 'Marketing', tool_groups: ['files'] });
    const c = await t.agent({ name: 'Support', tool_groups: ['files'] });
    for (const x of [a, b, c]) await t.api('PUT', `/computers/${x.id}/config`, { mode: 'browser', allow_private: true });
    // the owner starts Operations' browser himself and visits the site (gets a cookie)
    await t.api('POST', `/computers/${a.id}/browser/start`, { url: base + '/inloggen' });
    const st = await t.api('GET', `/computers/${a.id}`);
    assert.equal(st.status.browser.running, true);
    assert.match(st.status.browser.url, /127\.0\.0\.1/);
    assert.equal(st.status.browser.tabs[0].title, 'Site');
    const own = st.status.profileId;
    // share Operations' own profile with Marketing (Support stays on its own)
    const shared = await t.api('PUT', `/computers/profiles/${own}/members`, { agent_ids: [b.id] });
    assert.equal(shared.profile.shared, true);
    assert.deepEqual(shared.members.sort(), [a.id, b.id].sort(), 'the bot whose profile it was keeps it');
    assert.equal(svc.config(t.app.ctx.store.agent(b.id)!).profile_id, own);
    assert.equal(svc.config(t.app.ctx.store.agent(c.id)!).profile_id, null);
    assert.equal(svc.profileFor(t.app.ctx.store.agent(b.id)!).id, own);
    // the login (cookie) is there for Marketing too
    const sites = await t.api('GET', `/computers/profiles/${own}/sites`);
    assert.deepEqual(sites.map((x: any) => x.site), ['127.0.0.1']);
    // log out of that one site from Marketing's browser panel
    await t.api('POST', `/computers/${b.id}/browser/logout-site`, { site: '127.0.0.1' });
    assert.deepEqual(await t.api('GET', `/computers/profiles/${own}/sites`), []);
    // remove Marketing again: back to its own (new) profile
    await t.api('PUT', `/computers/profiles/${own}/members`, { agent_ids: [a.id] });
    assert.equal(svc.config(t.app.ctx.store.agent(b.id)!).profile_id, null);
    assert.notEqual(svc.profileFor(t.app.ctx.store.agent(b.id)!).id, own);
    // tab switching / forward through the human input route needs control first
    await assert.rejects(t.api('POST', `/computers/${a.id}/input`, { type: 'forward' }), /409/);
    await t.api('POST', `/computers/${a.id}/takeover`, {});
    assert.equal((await t.api('POST', `/computers/${a.id}/input`, { type: 'tab', index: 0 })).ok, true);
    await assert.rejects(t.api('POST', `/computers/${a.id}/input`, { type: 'tab', index: 5 }), /400/);
    await t.api('POST', `/computers/${a.id}/release`, {});
  } finally {
    await t.close();
    srv.close();
  }
});
