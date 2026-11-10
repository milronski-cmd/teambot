import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AppHandle } from '../server/app.js';
import { loadConfig } from '../server/core/config.js';
import { Auth, passwordProblem } from '../server/core/auth.js';
import { redact, rememberSecret } from '../server/core/secrets.js';
import { checkExposure, exposureInput, isLoopbackHost } from '../server/modules/network/exposure.js';
import { privacyLabel, registerPrivacyRule, whereIs } from '../server/modules/network/privacy.js';
import { Gateway } from '../server/modules/mobile/gateway.js';
import { startTestApp } from './helpers.js';

// Package P of 0.4: "alles wat de pc verlaat staat standaard uit". Closed by default: loopback bind, no exposure
// without authentication, strong passwords, throttled guessing, short single-use pairing codes, no public links,
// a privacy label per bot, and a planted secret that never shows up in logs, audit, errors or exports.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sec-'));
const rm = (dir: string) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* Windows keeps files a bit longer */
  }
};

async function call(base: string, token: string | null, method: string, p: string, body?: any, headers: Record<string, string> = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

/** A server-mode app without an owner yet (a fresh install), on loopback. */
async function freshServer(env: Record<string, string | undefined> = {}): Promise<{ app: AppHandle; dir: string; close(): Promise<void> }> {
  const dir = tmp();
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'server', quiet: true });
    return {
      app,
      dir,
      async close() {
        await app.close();
        rm(dir);
      },
    };
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const STRONG = 'Fietsen-langs-de-Vecht-77';

// ---------------------------------------------------------------- exposure

test('by default TeamBot listens on 127.0.0.1 only, in desktop and in server mode', async () => {
  const prev = { host: process.env.TEAMBOT_HOST, mode: process.env.TEAMBOT_MODE };
  delete process.env.TEAMBOT_HOST;
  delete process.env.TEAMBOT_MODE;
  const dir = tmp();
  try {
    assert.equal(loadConfig({ dataDir: dir }).host, '127.0.0.1', 'default (server) mode');
    assert.equal(loadConfig({ dataDir: dir, mode: 'server' }).host, '127.0.0.1');
    assert.equal(loadConfig({ dataDir: dir, mode: 'desktop' }).host, '127.0.0.1');
    const app = await createApp({ dataDir: dir, port: 0, mode: 'server', quiet: true });
    try {
      const a = app.server.address() as net.AddressInfo;
      assert.equal(a.address, '127.0.0.1');
      assert.ok(isLoopbackHost(app.ctx.config.host));
      assert.equal(app.ctx.services.exposure.loopbackOnly, true);
    } finally {
      await app.close();
    }
  } finally {
    if (prev.host !== undefined) process.env.TEAMBOT_HOST = prev.host;
    if (prev.mode !== undefined) process.env.TEAMBOT_MODE = prev.mode;
    rm(dir);
  }
});

test('exposing the password-less desktop owner to the network is refused before anything listens', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      createApp({ dataDir: dir, port: 0, host: '0.0.0.0', mode: 'desktop', quiet: true }),
      (e: any) => e?.code === 'exposure_refused' && /alleen op deze computer/.test(e.message),
    );
    await assert.rejects(createApp({ dataDir: dir, port: 0, host: '192.168.1.20', mode: 'desktop', quiet: true }), (e: any) => e?.code === 'exposure_refused');
  } finally {
    rm(dir);
  }
  // The decision itself: refusals, warnings and the explicit expert override.
  const base = { mode: 'desktop' as const, host: '0.0.0.0', publicUrl: '', allowSignup: false, users: 1, setupToken: false, trustProxy: '', unsafeOverride: false };
  assert.equal(checkExposure(base).findings.find((f) => f.code === 'desktop-exposed')?.level, 'refuse');
  assert.equal(checkExposure({ ...base, unsafeOverride: true }).findings.find((f) => f.code === 'desktop-exposed')?.level, 'warn');
  assert.deepEqual(checkExposure({ ...base, host: '127.0.0.1' }).findings, []);
  assert.deepEqual(checkExposure({ ...base, host: 'localhost' }).findings, []);
  const server = { ...base, mode: 'server' as const };
  assert.ok(checkExposure(server).findings.some((f) => f.code === 'no-https' && f.level === 'warn'), 'server on the network without https: loud warning');
  assert.ok(!checkExposure({ ...server, publicUrl: 'https://teambot.example.nl' }).findings.some((f) => f.code === 'no-https'));
  assert.ok(checkExposure({ ...server, allowSignup: true }).findings.some((f) => f.code === 'open-signup'));
  assert.ok(checkExposure({ ...server, trustProxy: 'true' }).findings.some((f) => f.code === 'trust-proxy-all'));
  assert.ok(checkExposure({ ...server, users: 0 }).findings.some((f) => f.code === 'setup-locked'));
  assert.equal(exposureInput({ mode: 'desktop', host: '0.0.0.0', publicUrl: '', allowSignup: false }, 1, { TEAMBOT_UNSAFE_EXPOSE: '1' }).unsafeOverride, true);
  for (const h of ['127.0.0.1', '127.8.9.1', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']) assert.ok(isLoopbackHost(h), h);
  for (const h of ['0.0.0.0', '::', '192.168.1.2', '100.101.102.103', 'teambot.example.nl', '']) assert.ok(!isLoopbackHost(h), h);
});

test('a fresh server cannot be claimed through the network without the one-time setup code', async () => {
  const s = await freshServer({ TEAMBOT_SETUP_TOKEN: undefined });
  try {
    const { app } = s;
    const code = app.ctx.auth.setupCode;
    assert.match(String(code), /^tbsetup_[A-Za-z0-9_-]{20,}$/, 'a code is made at startup');
    // Through a tunnel, Tailscale Serve or a reverse proxy the request comes from 127.0.0.1 with forwarding headers.
    const remote = { 'x-forwarded-for': '203.0.113.7' };
    assert.equal((await call(app.url, null, 'GET', '/api/public/status', undefined, remote)).body.setupCode, 'console');
    assert.equal((await call(app.url, null, 'GET', '/api/public/status')).body.setupCode, null, 'this computer itself needs no code');
    const form = { name: 'Eigenaar', email: 'eigenaar@test.local', password: STRONG };
    const r1 = await call(app.url, null, 'POST', '/api/public/setup', form, remote);
    assert.equal(r1.status, 403);
    assert.equal(r1.body.code, 'setup_code');
    assert.equal((await call(app.url, null, 'POST', '/api/public/setup', { ...form, setupToken: 'tbsetup_geraden-code-123456789' }, remote)).status, 403);
    assert.equal(app.ctx.auth.userCount(), 0, 'nobody became owner');
    const ok = await call(app.url, null, 'POST', '/api/public/setup', { ...form, setupToken: code }, remote);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.user.role, 'owner');
    assert.equal(app.ctx.auth.setupCode, null, 'the code is used up');
    assert.equal((await call(app.url, null, 'POST', '/api/public/setup', { ...form, setupToken: code }, remote)).status, 400, 'setup is closed for good');
    // The code never reaches the log file.
    const log = fs.readFileSync(path.join(s.dir, 'logs', 'server.log'), 'utf8');
    assert.ok(!log.includes(String(code)));
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- passwords

test('weak passwords are refused everywhere a password is chosen', async () => {
  for (const pw of ['x', 'kort', 'zeven77', 'aaaaaaaaaaaaaaaa', 'abababababababab', '123456789012', 'qwertyuiopasdf', 'Wachtwoord2026!', 'password1234', '!!Welkom123!!', 'anna@example.nl'])
    assert.ok(passwordProblem(pw, { email: 'anna@example.nl', name: 'Anna' }), `refused: ${pw}`);
  assert.equal(passwordProblem(STRONG, { email: 'anna@example.nl' }), null);
  assert.equal(passwordProblem('anna-wachtwoord-1', { email: 'anna@example.nl' }), null, 'containing a name is fine');
  assert.match(String(passwordProblem('x')), /minstens 12 tekens/);

  const s = await freshServer({ TEAMBOT_SETUP_TOKEN: undefined });
  try {
    const { app } = s;
    for (const password of ['x', 'kort-1', 'aaaaaaaaaaaaaaaa', '123456789012', 'Wachtwoord2026!']) {
      const r = await call(app.url, null, 'POST', '/api/public/setup', { name: 'E', email: 'e@test.local', password });
      assert.equal(r.status, 400, password);
    }
    assert.equal(app.ctx.auth.userCount(), 0);
    const ok = await call(app.url, null, 'POST', '/api/public/setup', { name: 'E', email: 'e@test.local', password: STRONG });
    assert.equal(ok.status, 200, ok.text);
    const tok = ok.body.token;
    // Invite signup: same rule.
    const inv = await call(app.url, tok, 'POST', '/api/admin/invites', { uses: 2 });
    assert.equal((await call(app.url, null, 'POST', '/api/public/signup', { invite: inv.body.code, email: 'v@test.local', password: 'geheim1234' })).status, 400);
    assert.equal((await call(app.url, null, 'POST', '/api/public/signup', { invite: inv.body.code, email: 'v@test.local', password: 'Een-sterk-vriendenwachtwoord' })).status, 200);
    // Changing your own password: the current one is needed, a weak new one is refused, other sessions are signed out.
    const other = await call(app.url, null, 'POST', '/api/public/login', { email: 'e@test.local', password: STRONG });
    assert.equal(other.status, 200);
    const noCur = await call(app.url, tok, 'PATCH', '/api/me', { password: 'Nieuw-en-sterk-wachtwoord-1' });
    assert.equal(noCur.status, 403);
    assert.equal(noCur.body.code, 'current_password');
    assert.equal((await call(app.url, tok, 'PATCH', '/api/me', { email: 'gekaapt@evil.test' })).status, 403, 'changing the login e-mail needs the password too');
    assert.equal((await call(app.url, tok, 'PATCH', '/api/me', { password: 'x', currentPassword: STRONG })).status, 400);
    assert.equal((await call(app.url, tok, 'PATCH', '/api/me', { password: 'Nieuw-en-sterk-wachtwoord-1', currentPassword: STRONG })).status, 200);
    assert.equal((await call(app.url, other.body.token, 'GET', '/api/me')).status, 401, 'the other session is revoked');
    assert.equal((await call(app.url, tok, 'GET', '/api/me')).status, 200, 'the session that changed it stays');
    const audit = app.ctx.store.all<any>("SELECT kind FROM audit WHERE kind = 'auth.password.changed'");
    assert.equal(audit.length, 1);
  } finally {
    await s.close();
  }

  // TEAMBOT_OWNER_PASSWORD: a weak one never creates the owner.
  const weak = await freshServer({ TEAMBOT_OWNER_EMAIL: 'baas@test.local', TEAMBOT_OWNER_PASSWORD: 'a', TEAMBOT_SETUP_TOKEN: undefined });
  try {
    assert.equal(weak.app.ctx.auth.userCount(), 0);
  } finally {
    await weak.close();
  }
  const good = await freshServer({ TEAMBOT_OWNER_EMAIL: 'baas@test.local', TEAMBOT_OWNER_PASSWORD: STRONG, TEAMBOT_SETUP_TOKEN: undefined });
  try {
    assert.equal(good.app.ctx.auth.userCount(), 1);
  } finally {
    await good.close();
  }
});

// ---------------------------------------------------------------- guessing

test('repeated wrong logins are throttled per address, per account and against spraying', async () => {
  const s = await freshServer({ TEAMBOT_OWNER_EMAIL: 'baas@test.local', TEAMBOT_OWNER_PASSWORD: STRONG, TEAMBOT_SETUP_TOKEN: undefined });
  try {
    const { app } = s;
    const login = (email: string, password: string, ip: string) => call(app.url, null, 'POST', '/api/public/login', { email, password }, { 'x-forwarded-for': ip });
    // Same e-mail + address: blocked after 5.
    for (let i = 0; i < 5; i++) assert.equal((await login('baas@test.local', 'fout-' + i, '198.51.100.1')).status, 401);
    assert.equal((await login('baas@test.local', STRONG, '198.51.100.1')).status, 429, 'even the right password waits');
    // One account from many addresses (a botnet): locked for everyone, the right password included.
    for (let i = 0; i < 4; i++) assert.equal((await login('baas@test.local', 'fout-x' + i, `198.51.100.${10 + i}`)).status, 401);
    // 9 failures so far (5 + 4); the 10th locks the account.
    assert.equal((await login('baas@test.local', 'fout-laatste', '198.51.100.50')).status, 401);
    const locked = await login('baas@test.local', STRONG, '198.51.100.99');
    assert.equal(locked.status, 429);
    assert.equal(locked.body.code, 'account_locked');
    const kinds = app.ctx.store.all<any>("SELECT kind FROM audit WHERE kind LIKE 'auth.login.%'").map((r) => r.kind);
    assert.ok(kinds.filter((k) => k === 'auth.login.failed').length >= 10);
    assert.ok(kinds.includes('auth.login.locked'));
    // One address trying one password on many accounts (spraying): blocked after 30 failures.
    let last = 401;
    for (let i = 0; i < 31 && last === 401; i++) last = (await login(`iemand${i}@test.local`, 'Zomer2026!-test', '203.0.113.200')).status;
    assert.equal(last, 429);
  } finally {
    await s.close();
  }
});

test('pairing codes are short-lived, single use and throttled per address and in total', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const mk = () => t.api('POST', '/pairing');
    const c1 = await mk();
    const ttl = (Date.parse(c1.expires_at) - Date.now()) / 1000;
    assert.ok(ttl <= Auth.PAIR_CODE_TTL && ttl > Auth.PAIR_CODE_TTL - 30, `5 minutes, got ${ttl}`);
    const pair = (code: string, ip: string) => call(t.app.url, null, 'POST', '/api/public/pair', { code, deviceName: 'Telefoon' }, { 'x-forwarded-for': ip });
    // Once.
    assert.equal((await pair(c1.code, '192.0.2.1')).status, 200);
    assert.equal((await pair(c1.code, '192.0.2.2')).status, 400, 'a used code is dead');
    // Expired.
    const c2 = await mk();
    t.app.ctx.store.exec('UPDATE pair_codes SET expires_at = ? WHERE code = ?', new Date(Date.now() - 1000).toISOString(), c2.code);
    assert.equal((await pair(c2.code, '192.0.2.3')).status, 400);
    // Per address: 5 wrong codes, then even a good one waits.
    const c3 = await mk();
    for (let i = 0; i < 5; i++) assert.equal((await pair('ZZZZ' + String(1000 + i), '192.0.2.10')).status, 400);
    assert.equal((await pair(c3.code, '192.0.2.10')).status, 429);
    // In total, from many addresses: after 30 wrong codes code pairing pauses for everyone (the QR still works).
    let n = 0;
    for (let i = 0; n < 40; i++) {
      const r = await pair('QQQQ' + String(2000 + i), `192.0.2.${100 + (i % 120)}`);
      n++;
      if (r.status === 429) break;
    }
    const blocked = await pair(c3.code, '192.0.2.250');
    assert.equal(blocked.status, 429, 'global limit on wrong codes');
    assert.equal(t.app.ctx.store.one<any>('SELECT used FROM pair_codes WHERE code = ?', c3.code).used, 0, 'the blocked attempt did not use the code');
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- nothing public by default

test('share links are off by default: no public route beyond login, pairing, webhooks and signed previews', async () => {
  const t = await startTestApp();
  try {
    const routes: string[] = [];
    for (const layer of (t.app.ctx.publicApi as any).stack || []) if (layer.route?.path) routes.push(String(layer.route.path));
    // Every route that works without a TeamBot login. A new one (e.g. a public share link) must be added here on purpose.
    const ALLOWED = [
      '/status', '/setup', '/login', '/signup', '/pair', // core auth
      '/preview/:token', // signed, 30 minutes, sandboxed HTML preview of an attachment
      '/mobile/pair', '/mobile/claim', // one-time phone pairing
      '/mobile/hello', // the iPhone app checks it talks to its own TeamBot (HMAC with its token) before sending the token
      '/hooks/:id', '/hooks/channels/:id/:kind', // webhooks with their own secret
      '/mcp/oauth/callback', '/mcp/google/callback', '/mcp/google/callback', '/mcp/server', '/cli/send', '/cli/runs/:id', // own tokens
      '/sso', '/sso/start', '/sso/callback', '/sso/exchange',
    ];
    const extra = routes.filter((r) => !ALLOWED.includes(r));
    assert.deepEqual(extra, [], `unexpected public routes: ${extra.join(', ')}`);
    assert.ok(!routes.some((r) => /share|public-link|deel/i.test(r)), 'no share-link routes');
    // A new bot and a new provider are not shared; a bot's website stays on this computer unless asked otherwise.
    const a = await t.agent();
    assert.notEqual(a.settings?.shared, true);
    const p = t.app.ctx.providers.config(t.providerId)!;
    assert.equal(p.shared, false);
    const site = t.app.ctx.tools.list().find((x) => x.name === 'site_publish');
    if (site) {
      assert.equal(site.risk, 'danger', 'publishing always asks');
      assert.match(String((site.parameters as any)?.properties?.reach?.description), /standaard "local"/);
    }
  } finally {
    await t.close();
  }
});

test('the phone gateway never forwards to Ollama or another local service', async () => {
  // A stand-in for a local service (Ollama on 11434): it must never get a connection through the gateway.
  let hits = 0;
  const ollama = net.createServer((s) => {
    hits++;
    s.destroy();
  });
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
  const target = `127.0.0.1:${(ollama.address() as net.AddressInfo).port}`;
  const t = await startTestApp({ modules: [] });
  const gw = new Gateway(t.app.ctx);
  try {
    const st = await gw.start('127.0.0.1', 0);
    assert.ok(st.running);
    const raw = (line: string) =>
      new Promise<string>((resolve) => {
        const sock = net.connect(st.port!, '127.0.0.1', () => sock.end(`${line}\r\nHost: ${target}\r\nConnection: close\r\n\r\n`));
        let out = '';
        sock.on('data', (d) => (out += d));
        sock.on('close', () => resolve(out));
        sock.on('error', () => resolve(out));
      });
    assert.match(await raw(`GET http://${target}/api/tags HTTP/1.1`), /^HTTP\/1\.1 400/, 'absolute-form (proxy) request refused');
    assert.match(await raw(`CONNECT ${target} HTTP/1.1`), /^$|^HTTP\/1\.1 4\d\d/, 'CONNECT gets no tunnel');
    assert.match(await raw(`GET //${target}/api/tags HTTP/1.1`), /^HTTP\/1\.1 400/);
    // A normal path goes to TeamBot itself (the app shell or a 404 of TeamBot), never to the Host header's service.
    await raw('GET /api/tags HTTP/1.1');
    assert.equal(hits, 0, 'the local service was never reached');
  } finally {
    await gw.stop();
    await t.close();
    ollama.close();
  }
});

// ---------------------------------------------------------------- privacy labels

test('privacyLabel: local models stay on the pc, cloud engines say what they do, subscriptions link to the opt-out', () => {
  assert.equal(privacyLabel('ollama', 'qwen3:8b').level, 'local');
  assert.equal(privacyLabel('ollama', 'qwen3:8b').label, 'Blijft op je pc');
  assert.equal(privacyLabel('ollama', 'qwen3:8b', { baseUrl: 'http://127.0.0.1:11434/v1' }).receiver, null);
  assert.equal(privacyLabel('lmstudio', 'x', { baseUrl: 'http://192.168.1.40:1234/v1' }).level, 'lan');
  assert.equal(privacyLabel('ollama', 'x', { baseUrl: 'https://ollama.example.com/v1' }).level, 'unknown');
  assert.equal(privacyLabel('ollama', 'gpt-oss:120b-cloud').level, 'unknown', 'Ollama cloud models leave the pc');
  const claude = privacyLabel('claude-code', 'sonnet');
  assert.equal(claude.level, 'may-train', 'subscription login: the worst plausible case');
  assert.equal(claude.label, 'Kan trainen');
  assert.equal(claude.optOutUrl, 'https://claude.ai/settings/data-privacy-controls');
  assert.equal(privacyLabel('claude-code', 'sonnet', { billing: 'api' }).level, 'no-train');
  const codex = privacyLabel('codex-cli', 'gpt-5.5');
  assert.equal(codex.level, 'may-train');
  assert.match(String(codex.optOutUrl), /chatgpt\.com/);
  assert.equal(privacyLabel('anthropic', 'claude-sonnet-4-5').level, 'no-train');
  assert.equal(privacyLabel('openai', 'gpt-5').level, 'no-train');
  assert.equal(privacyLabel('groq', 'llama-3.3-70b').level, 'no-store');
  assert.equal(privacyLabel('groq', 'llama-3.3-70b').label, 'Bewaart niets');
  assert.equal(privacyLabel('google', 'gemini-2.5-flash').level, 'may-train');
  assert.equal(privacyLabel('openrouter', 'deepseek/deepseek-r1:free').level, 'may-train');
  assert.equal(privacyLabel('opencode', 'opencode/big-pickle').level, 'may-train');
  assert.equal(privacyLabel('opencode', 'opencode/glm-5.3-flash-free').level, 'no-store');
  assert.equal(privacyLabel('opencode', 'ollama/qwen3:8b').level, 'local');
  assert.equal(privacyLabel('openai-compatible', 'x', { baseUrl: 'http://localhost:8000/v1' }).level, 'local');
  assert.equal(privacyLabel('iets-onbekends', 'x').level, 'unknown');
  for (const k of ['claude-code', 'groq', 'ollama', 'nvidia']) assert.match(privacyLabel(k, 'x').checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(whereIs('http://100.101.102.103:11434'), 'lan', 'tailnet');
  // Other packages extend it (e.g. a free provider).
  const off = registerPrivacyRule('kilo', (m) => (m.endsWith(':free') ? { level: 'may-train', receiver: 'Kilo', detail: 'Test.', checkedAt: '2026-11-09' } : null));
  assert.equal(privacyLabel('kilo', 'x:free').label, 'Kan trainen');
  assert.equal(privacyLabel('kilo', 'betaald').level, 'unknown');
  off();
  assert.equal(privacyLabel('kilo', 'x:free').level, 'unknown');
  const off2 = registerPrivacyRule('groq', { level: 'no-train', receiver: 'Groq', detail: 'Override.', checkedAt: '2026-11-09' });
  assert.equal(privacyLabel('groq', 'x').detail, 'Override.');
  off2();
});

test('the privacy label shows per bot: local bot vs cloud bot, reserves included, and on the data page', async () => {
  const t = await startTestApp();
  try {
    const ollama = await t.api('POST', '/providers', { kind: 'ollama' });
    const claude = await t.api('POST', '/providers', { kind: 'anthropic', apiKey: 'sk-ant-api03-' + 'n'.repeat(40) });
    const local = await t.agent({ name: 'Lokaal', provider_id: ollama.id, model: 'qwen3:8b' });
    const cloud = await t.agent({ name: 'Wolk', provider_id: claude.id, model: 'claude-sonnet-4-5', settings: { fallbacks: [{ provider_id: ollama.id, model: 'qwen3:8b' }] } });
    const pl = await t.api('GET', `/privacy/agents/${local.id}`);
    assert.equal(pl.main.level, 'local');
    assert.equal(pl.main.label, 'Blijft op je pc');
    const pc = await t.api('GET', `/privacy/agents/${cloud.id}`);
    assert.equal(pc.main.level, 'no-train');
    assert.equal(pc.main.receiver, 'Anthropic');
    assert.deepEqual(pc.engines.map((e: any) => [e.role, e.privacy.level]), [['main', 'no-train'], ['reserve', 'local']]);
    // The bot editor (before saving).
    const pre = await t.api('POST', '/privacy/engines', { engines: [{ provider_id: ollama.id, model: 'x' }, { provider_id: 'prv_bestaat_niet', model: 'x' }] });
    assert.equal(pre[0].privacy.level, 'local');
    assert.equal(pre[1], null);
    // The data page: every bot, other traffic, where the keys are, who can reach TeamBot.
    const o = await t.api('GET', '/privacy/overview');
    assert.ok(o.bots.some((b: any) => b.name === 'Lokaal' && b.main.level === 'local'));
    assert.ok(o.bots.some((b: any) => b.name === 'Wolk' && b.worst.level === 'no-train'));
    assert.equal(o.outgoing.telemetry, false);
    assert.equal(o.outgoing.shareLinks, false);
    assert.equal(o.keys.kind, 'file');
    assert.match(o.keys.text, /AES-256-GCM/);
    assert.equal(o.exposure.loopbackOnly, true);
    assert.equal(o.levels['may-train'], 'Kan trainen');
    assert.deepEqual(o.exposure.findings, [], 'nothing to warn about by default');
    // Phone access switched on for every network (plain http on wifi) shows up as a warning (state faked: no real
    // listener on 0.0.0.0 in tests).
    const m = t.app.ctx.services.mobile.instance;
    t.app.ctx.store.setSetting('', 'mobileGateway', { enabled: true, bind: 'all', port: 1234 });
    m.gateway.state = { running: true, address: '0.0.0.0', port: 1234, error: null };
    const ex = await t.api('GET', '/admin/network/exposure');
    assert.ok(ex.findings.some((f: any) => f.code === 'gateway-lan' && f.level === 'warn'));
    assert.equal(ex.gateway.running, true);
    m.gateway.state = { running: false, address: null, port: null, error: null };
    // A paired phone sees the labels too, but no server details.
    const pc1 = await t.api('POST', '/pairing');
    const dev = await call(t.app.url, null, 'POST', '/api/public/pair', { code: pc1.code, deviceName: 'Telefoon' });
    assert.equal(dev.status, 200, dev.text);
    assert.equal((await call(t.app.url, dev.body.token, 'GET', `/api/privacy/agents/${local.id}`)).body.main.level, 'local');
    const po = await call(t.app.url, dev.body.token, 'GET', '/api/privacy/overview');
    assert.equal(po.status, 200);
    assert.equal(po.body.exposure, null);
    assert.equal(po.body.dataDir, null);
    assert.equal((await call(t.app.url, dev.body.token, 'GET', '/api/secrets')).status, 403);
    // Someone else's bot: not found.
    const other = t.app.ctx.auth.createUser({ name: 'Ander', email: 'ander@test.local', role: 'member' });
    const otok = t.app.ctx.auth.createSession(other.id).token;
    assert.equal((await call(t.app.url, otok, 'GET', `/api/privacy/agents/${local.id}`)).status, 404);
    assert.equal((await call(t.app.url, otok, 'GET', '/api/privacy/overview')).body.exposure, null, 'members do not see server details');
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- secrets never leak

test('a planted fake secret never shows up in logs, audit, error messages, exports, diagnostics or team packages', async () => {
  // A key format no pattern knows: only "TeamBot knows this value" can catch it.
  const SECRET = 'PlantedFake' + crypto.randomBytes(18).toString('hex');
  const PATTERNED = 'sk-ant-api03-' + crypto.randomBytes(24).toString('base64url');
  // A provider that echoes the key it got in every error (as some do).
  const seen: string[] = [];
  const echo = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '');
    seen.push(auth);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${auth.replace(/^Bearer /, '')}`, type: 'invalid_request_error' } }));
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  const port = (echo.address() as net.AddressInfo).port;
  const t = await startTestApp();
  try {
    const prov = await t.api('POST', '/providers', { kind: 'openai-compatible', name: 'Lekkende server', base_url: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, config: { headers: { 'X-Extra-Key': SECRET } } });
    // Error message of a provider test.
    const test1 = await call(t.app.url, t.token, 'POST', `/api/providers/${prov.id}/test`);
    assert.ok(seen.some((h) => h.includes(SECRET)), 'the fake provider really got the key');
    assert.ok(!test1.text.includes(SECRET), `provider test leaks: ${test1.text}`);
    // Error message of a model list.
    const models = await call(t.app.url, t.token, 'GET', `/api/providers/${prov.id}/models`);
    assert.ok(!models.text.includes(SECRET));
    // A chat run on that provider fails with the echoed key in the provider's error.
    const bot = await t.agent({ name: 'Lekbot', provider_id: prov.id, model: 'm1', instructions: `Gebruik nooit ${PATTERNED}.` });
    const thread = await t.api('POST', '/threads', { agentId: bot.id });
    const msgs = await t.say(thread.id, 'hallo');
    assert.ok(msgs.length > 0);
    assert.ok(!JSON.stringify(msgs).includes(SECRET), 'chat error leaks');
    const thr = await call(t.app.url, t.token, 'GET', `/api/threads/${thread.id}/messages`);
    assert.ok(!thr.text.includes(SECRET));
    // A named secret and a proxy password.
    await t.api('PUT', '/secrets/eigen_sleutel', { value: SECRET });
    await t.api('PUT', '/admin/network/proxy', { enabled: false, url: 'http://proxy.example.nl:3128', username: 'piet', password: SECRET });
    // Anything that happens to log it (a module, an error with the provider's text).
    t.app.ctx.log.warn('provider zei', `Incorrect API key provided: ${SECRET}`, { body: `{"key":"${SECRET}"}` });
    t.app.ctx.log.error(new Error(`boom ${SECRET} ${PATTERNED}`));
    t.app.ctx.audit(t.app.ctx.auth.owner()!.id, 'test.planted', { note: `key=${SECRET}`, nested: { k: SECRET, p: PATTERNED } });
    // A 4xx error that carries it.
    t.app.ctx.api.get('/test/leaky-error', () => {
      throw Object.assign(new Error(`Ongeldige sleutel ${SECRET}`), { status: 400 });
    });
    const err = await call(t.app.url, t.token, 'GET', '/api/test/leaky-error');
    assert.equal(err.status, 400);
    assert.ok(!err.text.includes(SECRET), `error message leaks: ${err.text}`);

    const outputs: Record<string, string> = {};
    outputs.log = fs.readFileSync(path.join(t.dir, 'logs', 'server.log'), 'utf8');
    outputs.audit = (await call(t.app.url, t.token, 'GET', '/api/audit?limit=500')).text;
    outputs.export = (await call(t.app.url, t.token, 'GET', '/api/export')).text;
    outputs.diagnostics = (await call(t.app.url, t.token, 'GET', '/api/admin/diagnostics')).text;
    outputs.secrets = (await call(t.app.url, t.token, 'GET', '/api/secrets')).text;
    outputs.providers = JSON.stringify((await t.api('GET', '/providers')).map((p: any) => ({ ...p, config: { ...p.config, headers: undefined } })));
    outputs.proxy = (await call(t.app.url, t.token, 'GET', '/api/admin/network/proxy')).text;
    outputs.privacy = (await call(t.app.url, t.token, 'GET', '/api/privacy/overview')).text;
    // A team package with that bot (instructions carry a key-shaped secret).
    const room = await call(t.app.url, t.token, 'POST', '/api/rooms', { name: 'Lekteam', agentIds: [bot.id], mode: 'lead', leadAgentId: bot.id });
    assert.equal(room.status, 200, room.text);
    const pkg = await call(t.app.url, t.token, 'GET', `/api/rooms/${room.body.room.id}/package`);
    assert.equal(pkg.status, 200, pkg.text);
    outputs.teamPackage = pkg.text;
    assert.match(outputs.teamPackage, /Lekbot/);

    assert.ok(outputs.log.includes('provider zei'), 'the log line itself was written');
    assert.ok(outputs.audit.includes('test.planted'), 'the audit entry itself was written');
    assert.ok(outputs.export.includes('Lekbot'), 'the export has the bot');
    for (const [name, text] of Object.entries(outputs)) {
      assert.ok(!text.includes(SECRET), `${name} contains the planted secret`);
      assert.ok(!text.includes(SECRET.slice(8)), `${name} contains part of the planted secret`);
    }
    for (const name of ['log', 'audit', 'diagnostics', 'teamPackage']) assert.ok(!outputs[name].includes(PATTERNED), `${name} contains the key-shaped secret`);
    // The export keeps the header name, never its value.
    assert.match(outputs.export, /X-Extra-Key/);
  } finally {
    await t.close();
    echo.close();
  }
});

test('redact masks every secret TeamBot handled and the common key formats', () => {
  const v = 'Zz' + crypto.randomBytes(12).toString('hex');
  assert.equal(redact(`x ${v} y`), `x ${v} y`, 'unknown values stay');
  rememberSecret(v);
  assert.ok(!redact(`x ${v} y`).includes(v));
  assert.ok(!redact(JSON.stringify({ a: `"${v}"` })).includes(v));
  rememberSecret(JSON.stringify({ username: 'piet', password: 'Pw-' + v }));
  assert.ok(!redact(`login Pw-${v}`).includes(v));
  assert.ok(redact('gebruiker piet').includes('piet'), 'a username is not a secret');
  rememberSecret('kort');
  rememberSecret('wachtwoord');
  assert.equal(redact('kort wachtwoord'), 'kort wachtwoord', 'short or plain words are never masked');
  for (const k of ['gsk_' + 'a'.repeat(40), 'hf_' + 'b'.repeat(34), 'xai-' + 'c'.repeat(40), 'AKIA' + 'D'.repeat(16), 'sk_live_' + 'e'.repeat(24), 'github_pat_' + 'f'.repeat(40), 'tbsetup_' + 'g'.repeat(24), 'tbmcp_' + 'h'.repeat(30)])
    assert.ok(!redact(`key ${k} end`).includes(k), k);
  assert.ok(!redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123').includes('abcdefghijklmnopqrstuvwxyz0123'));
  assert.ok(!redact('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----').includes('MIIEvQIBADANBg'));
});
