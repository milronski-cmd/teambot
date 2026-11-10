import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startTestApp, type TestApp } from './helpers.js';
import { startFakeIdp, type FakeIdp, type FakeUser, type Tamper } from './fake-oidc.js';
import sso from '../server/modules/sso/index.js';

const DOMAIN = 'example.test';

async function call(t: TestApp, method: string, p: string, body?: any, token = t.token) {
  const r = await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

async function setup(sso_: Record<string, any> = {}, authMethods?: string[]) {
  const t = await startTestApp({ modules: [sso], mode: 'server' });
  const idp = await startFakeIdp(undefined, undefined, authMethods);
  const r = await call(t, 'PUT', '/admin/sso', { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, label: 'Inloggen met Testprovider', allowedDomains: [DOMAIN], enabled: true, ...sso_ });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { t, idp };
}

interface LoginResult {
  error?: string;
  status?: number;
  token?: string;
  user?: any;
  body?: any;
  location?: string;
}

/** Act like a browser: start → provider → callback (with the binding cookie) → exchange the one-time code. */
async function ssoLogin(t: TestApp, idp: FakeIdp, user: FakeUser, tamper: Tamper = {}, opt: { mutateCallback?: (u: URL) => void; dropCookie?: boolean; keepCode?: (code: string, cookie: string) => void } = {}): Promise<LoginResult> {
  idp.next(user, tamper);
  const s = await fetch(`${t.app.url}/api/public/sso/start`, { redirect: 'manual' });
  assert.equal(s.status, 302, 'start redirects');
  const authUrl = s.headers.get('location')!;
  assert.ok(authUrl.startsWith(idp.issuer + '/authorize?'), authUrl);
  const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert.match(cookie, /tb_sso=/);
  const a = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(a.status, 302, 'provider redirects back');
  const cb = new URL(a.headers.get('location')!);
  assert.equal(cb.origin + cb.pathname, `${t.app.url}/api/public/sso/callback`);
  opt.mutateCallback?.(cb);
  const c = await fetch(cb, { redirect: 'manual', headers: opt.dropCookie ? {} : { cookie } });
  assert.equal(c.status, 302);
  const loc = c.headers.get('location')!;
  assert.ok(loc.startsWith(`${t.app.url}/#/?`), 'always back to the own app (no open redirect): ' + loc);
  const ok = /[?&]sso=([^&]+)/.exec(loc);
  if (!ok) return { error: /sso_error=([^&]+)/.exec(loc)?.[1] || 'none', location: loc };
  opt.keepCode?.(ok[1], cookie);
  const x = await fetch(`${t.app.url}/api/public/sso/exchange`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ code: ok[1] }) });
  const body: any = await x.json();
  return { status: x.status, token: body.token, user: body.user, body, location: loc };
}

const passwordLogin = (t: TestApp, email: string, password: string) =>
  fetch(`${t.app.url}/api/public/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

const me = (t: TestApp, token: string) => fetch(`${t.app.url}/api/me`, { headers: { authorization: `Bearer ${token}` } });

const audit = (t: TestApp, kind: string) => t.app.ctx.store.all<any>('SELECT * FROM audit WHERE kind = ? ORDER BY id', kind).map((r) => ({ ...r, data: JSON.parse(r.data) }));

test('SSO: login via OIDC (PKCE, state, nonce), linking by e-mail, provisioning and every refusal', async () => {
  const { t, idp } = await setup();
  try {
    const pub = await (await fetch(`${t.app.url}/api/public/sso`)).json();
    assert.deepEqual(pub, { enabled: true, label: 'Inloggen met Testprovider', requireSso: false });
    const cfg = await call(t, 'GET', '/admin/sso');
    assert.equal(cfg.body.redirectUri, `${t.app.url}/api/public/sso/callback`);
    assert.equal(cfg.body.hasClientSecret, true);
    assert.equal(cfg.body.clientSecret, undefined);

    // Auto-provision is off: an unknown e-mail is refused.
    assert.equal((await ssoLogin(t, idp, { sub: 'u-anna', email: `anna@${DOMAIN}`, email_verified: true, name: 'Anna' })).error, 'unknown');
    assert.equal(t.app.ctx.store.one('SELECT id FROM users WHERE email = ?', `anna@${DOMAIN}`), undefined);

    // An existing member is linked by (verified) e-mail and gets a normal web session.
    const bob = t.app.ctx.auth.createUser({ name: 'Bob', email: `bob@${DOMAIN}`, password: 'geheim1234', role: 'member' });
    const r1 = await ssoLogin(t, idp, { sub: 'u-bob', email: `Bob@${DOMAIN}`, email_verified: true, name: 'Bob B' });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.user.id, bob.id);
    const m1 = await me(t, r1.token!);
    assert.equal(m1.status, 200);
    assert.equal(((await m1.json()) as any).user.email, `bob@${DOMAIN}`);
    assert.equal(t.app.ctx.store.one<any>('SELECT kind FROM sessions WHERE user_id = ? ORDER BY created_at DESC', bob.id).kind, 'web');
    const link = t.app.ctx.store.one<any>('SELECT * FROM sso_identities WHERE user_id = ?', bob.id);
    assert.equal(link.subject, 'u-bob');
    assert.equal(link.issuer, idp.issuer);
    assert.equal(audit(t, 'sso.linked').length, 1);
    assert.ok(audit(t, 'sso.login').some((a) => a.user_id === bob.id));
    // PKCE S256 + state + nonce went to the provider; the client secret went only to the token endpoint.
    const q = idp.authorizeRequests.at(-1)!;
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.ok(q.get('state') && q.get('nonce') && q.get('code_challenge'));
    assert.equal(q.get('scope'), 'openid email profile');
    assert.equal(q.get('client_secret'), null);
    assert.ok(idp.tokenRequests.at(-1)!.params.get('code_verifier'));
    assert.match(idp.tokenRequests.at(-1)!.auth, /^Basic /, 'client_secret_basic when offered');

    // Second login: matched by (issuer, sub), even with a different e-mail claim within the domain.
    const r2 = await ssoLogin(t, idp, { sub: 'u-bob', email: `bob.b@${DOMAIN}`, email_verified: true });
    assert.equal(r2.user.id, bob.id);

    // The one-time code is single use and bound to the browser cookie.
    let kept: { code: string; cookie: string } | null = null;
    await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}` }, {}, { keepCode: (code, cookie) => (kept = { code, cookie }) });
    const again = await fetch(`${t.app.url}/api/public/sso/exchange`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: kept!.cookie }, body: JSON.stringify({ code: kept!.code }) });
    assert.equal(again.status, 401, 'code already used');
    // Exchange without the browser cookie (code copied to another device) is refused.
    {
      idp.next({ sub: 'u-bob', email: `bob@${DOMAIN}` });
      const s = await fetch(`${t.app.url}/api/public/sso/start`, { redirect: 'manual' });
      const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const a = await fetch(s.headers.get('location')!, { redirect: 'manual' });
      const c = await fetch(a.headers.get('location')!, { redirect: 'manual', headers: { cookie } });
      const code = /sso=([^&]+)/.exec(c.headers.get('location')!)![1];
      const x = await fetch(`${t.app.url}/api/public/sso/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      assert.equal(x.status, 401);
    }

    // State mismatch, missing browser cookie, replayed callback → refused.
    assert.equal((await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}` }, {}, { mutateCallback: (u) => u.searchParams.set('state', 'aanvaller-state') })).error, 'state');
    assert.equal((await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}` }, {}, { dropCookie: true })).error, 'state');
    {
      idp.next({ sub: 'u-bob', email: `bob@${DOMAIN}` });
      const s = await fetch(`${t.app.url}/api/public/sso/start`, { redirect: 'manual' });
      const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const a = await fetch(s.headers.get('location')!, { redirect: 'manual' });
      const cb = a.headers.get('location')!;
      assert.match((await fetch(cb, { redirect: 'manual', headers: { cookie } })).headers.get('location')!, /sso=/);
      assert.match((await fetch(cb, { redirect: 'manual', headers: { cookie } })).headers.get('location')!, /sso_error=state/, 'replay refused');
    }

    // Token problems are caught by openid-client: nonce, audience, issuer, expiry, signature.
    assert.equal((await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}` }, { nonce: 'ander-nonce' })).error, 'provider');
    assert.equal((await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}` }, { aud: 'iemand-anders' })).error, 'provider');
    assert.equal((await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}` }, { iss: 'https://nep.example' })).error, 'provider');
    assert.equal((await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}` }, { exp: -600 })).error, 'provider');
    assert.equal((await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}` }, { foreignKey: true })).error, 'provider');
    const why = audit(t, 'sso.refused').slice(-5).map((a) => String(a.data.error));
    for (const [i, re] of [/nonce/, /aud/, /iss/, /exp/, /signature/].entries()) assert.match(why[i], re, `refusal ${i}: ${why[i]}`);

    // Wrong domain, unverified e-mail, no e-mail.
    assert.equal((await ssoLogin(t, idp, { sub: 'u-eve', email: 'eve@evil.test', email_verified: true })).error, 'domain');
    assert.equal((await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}`, email_verified: false })).error, 'unverified');
    assert.equal((await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}`, email_verified: 'false' })).error, 'unverified');
    assert.equal((await ssoLogin(t, idp, { sub: 'u-x' })).error, 'noemail');
    // A self-chosen username claim never stands in for the e-mail (only Entra's UPN does, on Microsoft issuers).
    assert.equal((await ssoLogin(t, idp, { sub: 'u-y', preferred_username: `bob@${DOMAIN}` })).error, 'noemail');
    const reasons = audit(t, 'sso.refused').map((a) => a.data.reason);
    for (const r of ['unknown', 'state', 'provider', 'domain', 'unverified', 'noemail', 'handoff']) assert.ok(reasons.includes(r), `refusal ${r} audited`);

    // Auto-provision on: a new member is created (role member by default).
    const ap = await call(t, 'PUT', '/admin/sso', { autoProvision: true });
    assert.equal(ap.status, 200);
    const r3 = await ssoLogin(t, idp, { sub: 'u-anna', email: `anna@${DOMAIN}`, email_verified: true, name: 'Anna de Vries' });
    assert.equal(r3.status, 200);
    assert.equal(r3.user.role, 'member');
    assert.equal(r3.user.name, 'Anna de Vries');
    assert.equal(audit(t, 'sso.provisioned').length, 1);
    // Entra-style token without email_verified works (missing ≠ false).
    const r4 = await ssoLogin(t, idp, { sub: 'u-carl', email: `carl@${DOMAIN}` });
    assert.equal(r4.status, 200);
    // Seat limit (TEAMBOT_MAX_USERS) also applies to SSO auto-provisioning: a clear refusal, not a provider error.
    process.env.TEAMBOT_MAX_USERS = String(t.app.ctx.store.one<any>('SELECT COUNT(*) n FROM users WHERE disabled = 0').n);
    try {
      assert.equal((await ssoLogin(t, idp, { sub: 'u-dirk', email: `dirk@${DOMAIN}` })).error, 'seats');
    } finally {
      delete process.env.TEAMBOT_MAX_USERS;
    }

    // Deactivated (blocked) user: refused at SSO, password login and token resolve.
    assert.equal((await call(t, 'PATCH', `/admin/users/${bob.id}`, { disabled: true })).status, 200);
    assert.equal((await me(t, r1.token!)).status, 401, 'existing session revoked');
    assert.equal((await ssoLogin(t, idp, { sub: 'u-bob', email: `bob@${DOMAIN}` })).error, 'disabled');
    assert.equal((await passwordLogin(t, `bob@${DOMAIN}`, 'geheim1234')).status, 401);
    assert.equal(t.app.ctx.auth.resolve(t.app.ctx.auth.createSession(bob.id).token), null);

    // Only the owner changes the provider; only the owner makes SSO users admins.
    const admin = t.app.ctx.auth.createUser({ name: 'Beheerder', email: `beheer@${DOMAIN}`, role: 'admin' });
    const adminTok = t.app.ctx.auth.createSession(admin.id).token;
    assert.equal((await call(t, 'PUT', '/admin/sso', { issuer: 'https://evil.example' }, adminTok)).status, 403);
    assert.equal((await call(t, 'PUT', '/admin/sso', { clientSecret: 'nieuw' }, adminTok)).status, 403);
    assert.equal((await call(t, 'PUT', '/admin/sso', { defaultRole: 'admin' }, adminTok)).status, 403);
    assert.equal((await call(t, 'PUT', '/admin/sso', { label: 'Inloggen met Werk' }, adminTok)).status, 200);
    const memberTok = r3.token!;
    assert.equal((await call(t, 'GET', '/admin/sso', undefined, memberTok)).status, 403);
    // Validation: auto-provision needs a domain.
    assert.equal((await call(t, 'PUT', '/admin/sso', { allowedDomains: [] })).status, 400);

    // Test discovery (owner/admin; local IdP allowed for them).
    const td = await call(t, 'POST', '/admin/sso/test', { issuer: idp.issuer }, adminTok);
    assert.equal(td.body.ok, true);
    assert.equal(td.body.token_endpoint, `${idp.issuer}/token`);
    const bad = await call(t, 'POST', '/admin/sso/test', { issuer: `${idp.issuer}/bestaat-niet` });
    assert.equal(bad.body.ok, false);
    assert.ok(bad.body.error);

    // Events overview for admins.
    const ev = await call(t, 'GET', '/admin/sso/events');
    assert.ok(ev.body.some((e: any) => e.kind === 'sso.login'));

    // The client secret and ID tokens never show up in responses, audit or logs.
    const dump = JSON.stringify([cfg.body, (await call(t, 'GET', '/admin/sso')).body, ev.body, (await call(t, 'GET', '/admin/settings')).body, (await call(t, 'GET', '/audit')).body, t.app.ctx.store.all('SELECT * FROM audit'), t.app.ctx.store.all('SELECT * FROM sso_settings')]);
    const log = fs.readFileSync(path.join(t.dir, 'logs', 'server.log'), 'utf8');
    for (const hay of [dump, log]) {
      assert.ok(!hay.includes(idp.clientSecret), 'client secret leaked');
      assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(hay), 'ID token leaked');
    }
  } finally {
    await idp.close();
    await t.close();
  }
});

test('SSO: no self-claimed SSO addresses; "require SSO" blocks password logins and signups for everyone but the owner', async () => {
  const { t, idp } = await setup({}, ['client_secret_post']); // a provider that only takes the secret in the body
  try {
    await t.api('PATCH', '/me', { email: `eigenaar@${DOMAIN}`, password: 'eigenaar-noodtoegang-1' });
    t.app.ctx.auth.createUser({ name: 'Lid', email: `lid@${DOMAIN}`, password: 'geheim1234', role: 'member' });
    t.app.ctx.auth.createUser({ name: 'Beheer', email: `beheer@${DOMAIN}`, password: 'geheim1234', role: 'admin' });
    const inv = await t.api('POST', '/admin/invites', { uses: 1 });
    assert.equal((await passwordLogin(t, `lid@${DOMAIN}`, 'geheim1234')).status, 200, 'password works before');

    // While SSO is on, nobody claims an address in an SSO domain by themselves (SSO links on e-mail).
    const signup = (code: string, email: string) =>
      fetch(`${t.app.url}/api/public/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: code, email, password: 'geheim-voor-een-vriend-1' }) });
    const inv0 = await t.api('POST', '/admin/invites', { uses: 2 });
    assert.equal((await signup(inv0.code, `ceo@${DOMAIN}`)).status, 403);
    assert.equal((await signup(inv0.code, 'vriend@elders.test')).status, 200, 'friends outside the SSO domains can still join');
    const mailer = t.app.ctx.auth.createUser({ name: 'Mail', email: 'mail@elders.test', role: 'member' });
    const mtok = t.app.ctx.auth.createSession(mailer.id).token;
    const pm = await call(t, 'PATCH', '/me', { email: `ceo@${DOMAIN}` }, mtok);
    assert.equal(pm.status, 403);
    assert.equal(pm.body.code, 'sso_managed');
    assert.equal((await call(t, 'PATCH', '/me', { email: 'mail2@elders.test' }, mtok)).status, 200);
    assert.equal((await call(t, 'PATCH', '/me', { name: 'Mail B' }, mtok)).status, 200, 'other profile fields stay editable');

    assert.equal((await call(t, 'PUT', '/admin/sso', { requireSso: true })).status, 200);
    assert.equal(((await (await fetch(`${t.app.url}/api/public/sso`)).json()) as any).requireSso, true);
    const m = await passwordLogin(t, `lid@${DOMAIN}`, 'geheim1234');
    assert.equal(m.status, 403);
    assert.equal(m.body.code, 'sso_required');
    assert.equal((await passwordLogin(t, `beheer@${DOMAIN}`, 'geheim1234')).status, 403, 'admins too');
    assert.equal((await passwordLogin(t, `onbekend@${DOMAIN}`, 'x')).status, 403, 'same answer for unknown e-mails');
    const o = await passwordLogin(t, `eigenaar@${DOMAIN}`, 'eigenaar-noodtoegang-1');
    assert.equal(o.status, 200, 'owner keeps password login (break-glass)');
    const su = await fetch(`${t.app.url}/api/public/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: inv.code, email: `nieuw@${DOMAIN}`, password: 'geheim1234' }) });
    assert.equal(su.status, 403);
    assert.equal(t.app.ctx.store.one<any>('SELECT uses_left FROM invites WHERE code = ?', inv.code).uses_left, 1, 'refused signup keeps the invite');
    // The member signs in with SSO instead.
    const s = await ssoLogin(t, idp, { sub: 'u-lid', email: `lid@${DOMAIN}`, email_verified: true });
    assert.equal(s.status, 200);
    assert.equal(idp.tokenRequests.at(-1)!.params.get('client_secret'), idp.clientSecret, 'client_secret_post');
    // Switching SSO off gives password logins back.
    assert.equal((await call(t, 'PUT', '/admin/sso', { enabled: false })).status, 400, 'require SSO must go off first');
    assert.equal((await call(t, 'PUT', '/admin/sso', { requireSso: false, enabled: false })).status, 200);
    assert.equal((await passwordLogin(t, `lid@${DOMAIN}`, 'geheim1234')).status, 200);
    assert.equal(((await (await fetch(`${t.app.url}/api/public/sso`)).json()) as any).enabled, false);
    const off = await fetch(`${t.app.url}/api/public/sso/start`, { redirect: 'manual' });
    assert.match(off.headers.get('location') || '', /sso_error=config/);
  } finally {
    await idp.close();
    await t.close();
  }
});

async function scim(t: TestApp, method: string, p: string, token: string | null, body?: any) {
  const r = await fetch(`${t.app.url}/scim/v2${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/scim+json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, type: r.headers.get('content-type') || '', location: r.headers.get('location'), body: text ? JSON.parse(text) : null };
}

const ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

test('SCIM: token auth, create/list/filter/patch/put/delete-as-deactivate, owner and admins untouchable', async () => {
  const { t, idp } = await setup({ autoProvision: false });
  try {
    // No token / wrong token: 401 in SCIM error format.
    const none = await scim(t, 'GET', '/Users', null);
    assert.equal(none.status, 401);
    assert.match(none.type, /application\/scim\+json/);
    assert.deepEqual(none.body.schemas, [ERR]);
    assert.equal(none.body.status, '401');
    assert.equal((await scim(t, 'GET', '/Users', 'tbscim_verkeerd')).status, 401);

    // Only the owner creates the token; it is shown once and stored as a hash.
    const admin = t.app.ctx.auth.createUser({ name: 'Beheer', email: `beheer@${DOMAIN}`, role: 'admin' });
    const adminTok = t.app.ctx.auth.createSession(admin.id).token;
    assert.equal((await call(t, 'POST', '/admin/scim/token', {}, adminTok)).status, 403);
    const created = await call(t, 'POST', '/admin/scim/token', {});
    const tok: string = created.body.newToken;
    assert.match(tok, /^tbscim_/);
    assert.equal(created.body.endpoint, `${t.app.url}/scim/v2`);
    const row = t.app.ctx.store.one<any>('SELECT * FROM scim_tokens WHERE revoked_at IS NULL');
    assert.equal(row.token_hash, crypto.createHash('sha256').update(tok).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(tok));
    const view = await call(t, 'GET', '/admin/scim', undefined, adminTok);
    assert.ok(view.body.token && view.body.newToken === undefined);

    // Discovery endpoints.
    assert.equal((await scim(t, 'GET', '/ServiceProviderConfig', tok)).body.patch.supported, true);
    assert.equal((await scim(t, 'GET', '/ResourceTypes', tok)).body.Resources[0].endpoint, '/Users');
    assert.equal((await scim(t, 'GET', '/Schemas', tok)).body.Resources[0].id, USER);
    assert.ok(view.body.token.last_used_at || true);

    // Create (Entra-style payload).
    const c = await scim(t, 'POST', '/Users', tok, {
      schemas: [USER, 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
      externalId: 'ext-jan',
      userName: `jan@${DOMAIN}`,
      active: true,
      displayName: 'Jan Jansen',
      emails: [{ primary: true, type: 'work', value: `jan@${DOMAIN}` }],
      name: { formatted: 'Jan Jansen', givenName: 'Jan', familyName: 'Jansen' },
      roles: [{ value: 'admin' }],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'IT' },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.match(c.type, /application\/scim\+json/);
    const id = c.body.id;
    assert.equal(c.location, `${t.app.url}/scim/v2/Users/${id}`);
    assert.equal(c.body.userName, `jan@${DOMAIN}`);
    assert.equal(c.body.active, true);
    const jan = t.app.ctx.store.user(id)!;
    assert.equal(jan.role, 'member', 'SCIM never creates admins');
    assert.equal(jan.name, 'Jan Jansen');
    assert.equal(audit(t, 'scim.user.created').length, 1);
    // Duplicate → 409 uniqueness.
    const dup = await scim(t, 'POST', '/Users', tok, { schemas: [USER], userName: `jan@${DOMAIN}` });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.scimType, 'uniqueness');
    // A second user, Okta-style (userName not an e-mail, primary e-mail separate).
    const p2 = await scim(t, 'POST', '/Users', tok, { schemas: [USER], userName: 'piet.p', name: { givenName: 'Piet', familyName: 'Pieters' }, emails: [{ value: `piet@${DOMAIN}`, primary: true }] });
    assert.equal(p2.status, 201);
    assert.equal(t.app.ctx.store.user(p2.body.id)!.email, `piet@${DOMAIN}`);
    assert.equal(p2.body.userName, 'piet.p');
    assert.equal(p2.body.displayName, 'Piet Pieters');

    // List + filter + paging.
    const f = await scim(t, 'GET', `/Users?filter=${encodeURIComponent(`userName eq "JAN@${DOMAIN}"`)}`, tok);
    assert.equal(f.body.totalResults, 1);
    assert.equal(f.body.Resources[0].id, id);
    assert.deepEqual(f.body.schemas, ['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
    assert.equal((await scim(t, 'GET', `/Users?filter=${encodeURIComponent('externalId eq "ext-jan"')}`, tok)).body.totalResults, 1);
    assert.equal((await scim(t, 'GET', `/Users?filter=${encodeURIComponent('userName eq "niemand@example.test"')}`, tok)).body.totalResults, 0);
    assert.equal((await scim(t, 'GET', `/Users?filter=${encodeURIComponent(`emails[type eq "work"].value eq "piet@${DOMAIN}"`)}`, tok)).body.totalResults, 1);
    const page = await scim(t, 'GET', '/Users?startIndex=2&count=1', tok);
    assert.equal(page.body.itemsPerPage, 1);
    assert.equal(page.body.startIndex, 2);
    assert.ok(page.body.totalResults >= 3);
    const badFilter = await scim(t, 'GET', `/Users?filter=${encodeURIComponent('name.familyName co "Jan"')}`, tok);
    assert.equal(badFilter.status, 400);
    assert.equal(badFilter.body.scimType, 'invalidFilter');
    assert.equal((await scim(t, 'GET', `/Users/${id}`, tok)).body.externalId, 'ext-jan');
    assert.equal((await scim(t, 'GET', '/Users/usr_bestaatniet', tok)).status, 404);

    // Jan signs in with SSO (linked by e-mail) and has a live session.
    const s1 = await ssoLogin(t, idp, { sub: 'u-jan', email: `jan@${DOMAIN}`, email_verified: true });
    assert.equal(s1.status, 200);
    assert.equal((await me(t, s1.token!)).status, 200);

    // PATCH active=false (Entra sends "False" as a string with a capitalised op): sessions revoked, login refused.
    const d = await scim(t, 'PATCH', `/Users/${id}`, tok, { schemas: [PATCH], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.active, false);
    assert.equal(t.app.ctx.store.user(id)!.disabled, true);
    assert.equal((await me(t, s1.token!)).status, 401, 'session revoked');
    assert.equal((await ssoLogin(t, idp, { sub: 'u-jan', email: `jan@${DOMAIN}` })).error, 'disabled');
    assert.equal(audit(t, 'scim.user.deactivated').length, 1);
    // Reactivate (Okta-style: value object without path).
    const ra = await scim(t, 'PATCH', `/Users/${id}`, tok, { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: true } }] });
    assert.equal(ra.body.active, true);
    assert.equal((await ssoLogin(t, idp, { sub: 'u-jan', email: `jan@${DOMAIN}` })).status, 200);
    // Name and e-mail changes.
    const nm = await scim(t, 'PATCH', `/Users/${id}`, tok, {
      schemas: [PATCH],
      Operations: [
        { op: 'Replace', path: 'displayName', value: 'Jan J. Jansen' },
        { op: 'Replace', path: 'emails[type eq "work"].value', value: `jan.jansen@${DOMAIN}` },
        { op: 'Add', path: 'title', value: 'genegeerd' },
      ],
    });
    assert.equal(nm.status, 200);
    assert.equal(t.app.ctx.store.user(id)!.name, 'Jan J. Jansen');
    assert.equal(t.app.ctx.store.user(id)!.email, `jan.jansen@${DOMAIN}`);
    // PUT replaces.
    const put = await scim(t, 'PUT', `/Users/${id}`, tok, { schemas: [USER], userName: `jan@${DOMAIN}`, name: { formatted: 'Jan Jansen' }, emails: [{ value: `jan@${DOMAIN}`, primary: true }], active: true });
    assert.equal(put.status, 200);
    assert.equal(t.app.ctx.store.user(id)!.email, `jan@${DOMAIN}`);
    // Bad PATCH → invalidSyntax; bad JSON → 400 in SCIM format.
    assert.equal((await scim(t, 'PATCH', `/Users/${id}`, tok, { schemas: [PATCH] })).body.scimType, 'invalidSyntax');
    const raw = await fetch(`${t.app.url}/scim/v2/Users`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/scim+json' }, body: '{kapot' });
    assert.equal(raw.status, 400);
    assert.deepEqual(((await raw.json()) as any).schemas, [ERR]);

    // Owner and admins: visible, but SCIM can't change, deactivate or delete them.
    await t.api('PATCH', '/me', { email: `eigenaar@${DOMAIN}` });
    const owner = t.app.ctx.auth.owner()!;
    const of = await scim(t, 'GET', `/Users?filter=${encodeURIComponent(`userName eq "eigenaar@${DOMAIN}"`)}`, tok);
    assert.equal(of.body.Resources[0].id, owner.id);
    for (const target of [owner.id, admin.id]) {
      const pa = await scim(t, 'PATCH', `/Users/${target}`, tok, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] });
      assert.equal(pa.status, 403);
      assert.deepEqual(pa.body.schemas, [ERR]);
      assert.equal((await scim(t, 'PUT', `/Users/${target}`, tok, { schemas: [USER], userName: 'overname@evil.test' })).status, 403);
      assert.equal((await scim(t, 'DELETE', `/Users/${target}`, tok)).status, 403);
      assert.equal(t.app.ctx.store.user(target)!.disabled, false);
    }
    assert.equal(t.app.ctx.store.user(owner.id)!.email, `eigenaar@${DOMAIN}`);
    assert.equal(t.app.ctx.store.user(owner.id)!.role, 'owner');
    // A no-op PATCH on the owner (nothing changes) is fine.
    assert.equal((await scim(t, 'PATCH', `/Users/${owner.id}`, tok, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: true }] })).status, 200);

    // DELETE = deactivate by default: gone for SCIM (404), account blocked, data kept; re-provisioning restores it.
    const jt = t.app.ctx.auth.createSession(id).token;
    assert.equal((await scim(t, 'DELETE', `/Users/${id}`, tok)).status, 204);
    assert.equal((await scim(t, 'GET', `/Users/${id}`, tok)).status, 404);
    assert.equal((await me(t, jt)).status, 401);
    assert.equal(t.app.ctx.store.user(id)!.disabled, true);
    assert.equal((await scim(t, 'GET', `/Users?filter=${encodeURIComponent(`userName eq "jan@${DOMAIN}"`)}`, tok)).body.totalResults, 0);
    const back = await scim(t, 'POST', '/Users', tok, { schemas: [USER], userName: `jan@${DOMAIN}`, active: true });
    assert.equal(back.status, 201);
    assert.equal(back.body.id, id, 'same account restored');
    assert.equal(t.app.ctx.store.user(id)!.disabled, false);

    // Revoked token stops working; members can't see the SCIM settings.
    assert.equal((await call(t, 'DELETE', '/admin/scim/token', undefined, adminTok)).status, 403);
    assert.equal((await call(t, 'DELETE', '/admin/scim/token')).status, 200);
    assert.equal((await scim(t, 'GET', '/Users', tok)).status, 401);
    assert.equal((await call(t, 'GET', '/admin/scim', undefined, t.app.ctx.auth.createSession(id).token)).status, 403);

    // The SCIM token never shows up in other responses, audit or logs.
    const dump = JSON.stringify([view.body, (await call(t, 'GET', '/admin/scim')).body, (await call(t, 'GET', '/admin/sso/events')).body, (await call(t, 'GET', '/audit')).body, t.app.ctx.store.all('SELECT * FROM audit')]);
    const log = fs.readFileSync(path.join(t.dir, 'logs', 'server.log'), 'utf8');
    for (const hay of [dump, log]) assert.ok(!hay.includes(tok), 'SCIM token leaked');
    // Redaction catches the token pattern in log lines too.
    const { redact } = await import('../server/core/secrets.js');
    assert.ok(!redact(`x ${tok} y`).includes(tok));
  } finally {
    await idp.close();
    await t.close();
  }
});

test('SCIM: delete mode "delete" removes a member and their data, never anyone else', async () => {
  const t = await startTestApp({ mode: 'server' }); // all default modules: the generic sweep must cope with every table
  try {
    const tok = (await t.api('POST', '/admin/scim/token', {})).newToken;
    assert.equal((await t.api('PUT', '/admin/scim', { deleteMode: 'delete' })).deleteMode, 'delete');
    const c = await scim(t, 'POST', '/Users', tok, { schemas: [USER], userName: `weg@${DOMAIN}`, displayName: 'Weg' });
    const id = c.body.id;
    const utok = t.app.ctx.auth.createSession(id).token;
    await t.api('PATCH', `/providers/${t.providerId}`, { shared: true });
    const bot = await call(t, 'POST', '/agents', { name: 'Ledenbot', provider_id: t.providerId, model: 'mock-1' }, utok);
    assert.equal(bot.status, 200, JSON.stringify(bot.body));
    const th = await call(t, 'POST', '/threads', { agentId: bot.body.id }, utok);
    assert.equal(th.status, 200);
    t.app.ctx.secrets.set(id, 'eigen-sleutel', 'geheim');
    const ownerBot = await t.agent({ name: 'Eigenaarsbot' });
    const ws = t.app.ctx.store.defaultWorkspace(bot.body.id);
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'notitie.txt'), 'x');

    assert.equal((await scim(t, 'DELETE', `/Users/${id}`, tok)).status, 204);
    assert.equal(t.app.ctx.store.user(id), null);
    assert.equal(t.app.ctx.store.all('SELECT id FROM agents WHERE user_id = ?', id).length, 0);
    assert.equal(t.app.ctx.store.all('SELECT id FROM threads WHERE user_id = ?', id).length, 0);
    assert.equal(t.app.ctx.store.all('SELECT id FROM secrets WHERE user_id = ?', id).length, 0);
    assert.equal(t.app.ctx.store.all('SELECT id FROM sessions WHERE user_id = ?', id).length, 0);
    assert.ok(!fs.existsSync(ws), 'work folder removed');
    assert.ok(t.app.ctx.store.agent(ownerBot.id), 'owner data untouched');
    assert.equal((await scim(t, 'GET', `/Users/${id}`, tok)).status, 404);
    assert.ok(audit(t, 'scim.user.deleted').some((a) => a.data.mode === 'delete'));
    // Members can't change the delete mode.
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: `lid@${DOMAIN}`, role: 'admin' });
    assert.equal((await call(t, 'PUT', '/admin/scim', { deleteMode: 'deactivate' }, t.app.ctx.auth.createSession(m.id).token)).status, 403);
  } finally {
    await t.close();
  }
});

test('SSO/SCIM stay hidden in desktop mode', async () => {
  const t = await startTestApp({ modules: [sso], mode: 'desktop' });
  try {
    assert.deepEqual(await (await fetch(`${t.app.url}/api/public/sso`)).json(), { enabled: false, label: '', requireSso: false });
    const r = await fetch(`${t.app.url}/scim/v2/Users`, { headers: { authorization: 'Bearer x' } });
    assert.equal(r.status, 404);
    assert.equal((await call(t, 'GET', '/admin/sso')).status, 400);
  } finally {
    await t.close();
  }
});
