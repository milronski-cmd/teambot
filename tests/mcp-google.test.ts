import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestApp } from './helpers.js';
import { GOOGLE_SERVICES, GOOGLE_TOOLS } from '../server/modules/mcp/google.js';

/**
 * Google in one go, against a local stand-in for Google (TEAMBOT_GOOGLE_BASE): the login (authorization code + PKCE),
 * the built-in server with its tools, refreshing, a switched-off API with its link, the Ads developer token and
 * disconnecting. Nothing here talks to the real Google.
 */
interface Seen {
  method: string;
  path: string;
  auth: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

async function fakeGoogle() {
  const seen: Seen[] = [];
  const state = { access: 1, grantScope: '' as string, refreshOk: true, merchantRegistered: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://x');
      const p = url.pathname;
      seen.push({ method: req.method || '', path: p + url.search, auth: String(req.headers.authorization || ''), body, headers: req.headers });
      const json = (code: number, v: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
      if (p === '/oauth2.googleapis.com/token') {
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'authorization_code') {
          if (f.get('code') !== 'code-123' || !f.get('code_verifier') || f.get('client_secret') !== 'secret-x') return json(400, { error: 'invalid_grant', error_description: 'Bad code' });
          const id = Buffer.from(JSON.stringify({ email: 'eigenaar@voorbeeld.nl' })).toString('base64url');
          return json(200, { access_token: `at-${state.access}`, refresh_token: 'rt-1', expires_in: 3600, scope: state.grantScope, id_token: `x.${id}.y` });
        }
        if (!state.refreshOk) return json(400, { error: 'invalid_grant', error_description: 'Token has been revoked' });
        state.access++;
        return json(200, { access_token: `at-${state.access}`, expires_in: 3600 });
      }
      if (p === '/oauth2.googleapis.com/revoke') return json(200, {});
      if (req.headers.authorization !== `Bearer at-${state.access}`) return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
      if (p === '/www.googleapis.com/webmasters/v3/sites') return json(200, { siteEntry: [{ siteUrl: 'sc-domain:voorbeeld.nl', permissionLevel: 'siteOwner' }] });
      if (p.endsWith('/searchAnalytics/query')) return json(200, { rows: [{ keys: ['kaarsen kopen'], clicks: 12, impressions: 340, ctr: 0.035, position: 7.2 }] });
      if (p === '/merchantapi.googleapis.com/accounts/v1/accounts') return json(200, { accounts: [{ name: 'accounts/555', accountId: '555' }] });
      if (p.endsWith('/developerRegistration:registerGcp')) return ((state.merchantRegistered = true), json(200, { name: 'accounts/555/developerRegistration' }));
      if (p === '/merchantapi.googleapis.com/products/v1/accounts/555/products')
        return state.merchantRegistered ? json(200, { products: [{ offerId: 'kaars-1' }] }) : json(401, { error: { code: 401, message: 'The GCP project is not registered with the merchant account. Developer registration is required.' } });
      if (p.startsWith('/googleads.googleapis.com/')) return json(200, { resourceNames: ['customers/1234567890'] });
      if (p.startsWith('/analyticsadmin.googleapis.com/'))
        return json(403, { error: { code: 403, message: 'Google Analytics Admin API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://console.developers.google.com/apis/api/analyticsadmin.googleapis.com/overview?project=1' } }] } });
      if (p === '/gmail.googleapis.com/gmail/v1/users/me/profile') return json(200, { emailAddress: 'eigenaar@voorbeeld.nl' });
      if (p === '/gmail.googleapis.com/gmail/v1/users/me/messages/send') return json(200, { id: 'sent-1' });
      if (p.startsWith('/www.googleapis.com/calendar/v3/')) return json(200, { items: [] });
      if (p === '/www.googleapis.com/drive/v3/about') return json(200, { user: { emailAddress: 'eigenaar@voorbeeld.nl' } });
      json(404, { error: { code: 404, message: `geen nep-antwoord voor ${p}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('Google: every tool belongs to a service, and reading tools never write', () => {
  const ids = new Set(GOOGLE_SERVICES.map((s) => s.id));
  for (const t of GOOGLE_TOOLS) assert.ok(ids.has(t.service), t.name);
  for (const s of GOOGLE_SERVICES) assert.ok(GOOGLE_TOOLS.some((t) => t.service === s.id), `${s.id} has tools`);
  assert.deepEqual(GOOGLE_TOOLS.filter((t) => t.kind !== 'read').map((t) => t.name).sort(), ['calendar_create_event', 'gmail_draft', 'gmail_send']);
});

test('Google: one login connects it, the test proves each service, and disconnecting revokes', async () => {
  const g = await fakeGoogle();
  process.env.TEAMBOT_GOOGLE_BASE = g.base;
  const t = await startTestApp({ mode: 'desktop' });
  try {
    const bot = await t.agent({ name: 'Marketeer' });

    // No client yet: the app says so, and a pasted JSON file from Google Cloud is enough.
    let s = await t.api('GET', '/mcp/google');
    assert.equal(s.client, null);
    assert.equal(s.status, 'off');
    assert.equal(s.clientType, 'desktop');
    assert.match(s.enableApisUrl, /searchconsole\.googleapis\.com.*merchantapi\.googleapis\.com.*googleads\.googleapis\.com/);
    await assert.rejects(t.api('POST', '/mcp/google/start', {}), /nog geen Google-client/);
    await assert.rejects(t.api('PUT', '/mcp/google/client', { json: 'onzin' }), /geen Google-client/);
    s = await t.api('PUT', '/mcp/google/client', { json: JSON.stringify({ installed: { client_id: '123456-abc.apps.googleusercontent.com', client_secret: 'secret-x' } }) });
    assert.equal(s.client, 'own');
    assert.ok(!JSON.stringify(s).includes('secret-x'), 'the client secret never comes back');

    // Start: Google's own login page, with PKCE and offline access, back to this computer.
    const { authorizationUrl } = await t.api('POST', '/mcp/google/start', {});
    const a = new URL(authorizationUrl);
    assert.ok(a.pathname.endsWith('/accounts.google.com/o/oauth2/v2/auth'));
    assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(a.searchParams.get('access_type'), 'offline');
    const redirect = a.searchParams.get('redirect_uri')!;
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/api\/public\/mcp\/google\/callback$/);
    for (const sv of GOOGLE_SERVICES) for (const sc of sv.scopes) assert.ok(a.searchParams.get('scope')!.split(' ').includes(sc), sc);

    // A wrong state never connects anything.
    assert.equal((await fetch(`${redirect}?code=code-123&state=verkeerd`)).status, 400);
    assert.equal((await t.api('GET', '/mcp/google')).status, 'off');

    // Back from Google (the owner left Drive unticked).
    g.state.grantScope = ['openid', 'email', ...GOOGLE_SERVICES.filter((x) => x.id !== 'drive').flatMap((x) => x.scopes)].join(' ');
    const back = await fetch(`${redirect}?code=code-123&state=${a.searchParams.get('state')}`);
    assert.equal(back.status, 200);
    assert.match(await back.text(), /Google is gekoppeld/);
    assert.equal((await fetch(`${redirect}?code=code-123&state=${a.searchParams.get('state')}`)).status, 400, 'a login link works once');
    s = await t.api('GET', '/mcp/google');
    assert.equal(s.status, 'on');
    assert.equal(s.email, 'eigenaar@voorbeeld.nl');
    assert.deepEqual(s.services.filter((x: any) => x.on).map((x: any) => x.id), GOOGLE_SERVICES.map((x) => x.id).filter((id) => id !== 'drive'));
    const conn = s.connection;
    assert.equal(conn.transport, 'builtin');
    assert.deepEqual(conn.agents, [bot.id], 'connected means the bots can use it');
    assert.equal(conn.allow_actions, true, 'the owner’s app is not read-only (mcp/defaults.ts); what a bot may do is its access level');
    // The rest of this test is about an app whose actions are off.
    await t.api('POST', `/mcp/connections/${conn.id}/actions`, { enabled: false });

    // In one go: straight after the login the bot has the reading tools and can use them; sending mail is not offered.
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    let offered: string[] = [];
    t.script.push({ toolCalls: [{ name: 'mcp_google_gsc_search_analytics', args: { site: 'sc-domain:voorbeeld.nl' } }], check: (req) => (offered = req.tools.map((x) => x.name)) }, { text: 'klaar' });
    await t.say(th.id, 'Op welke zoekwoorden worden we gevonden volgens Search Console?');
    // The tools of an app are found on demand (tools/selection.ts): the bot reads which apps it has where it looks for
    // tools, and has exactly the reading tools.
    assert.ok(offered.includes('tools_find') && offered.includes('tools_call'), offered.join(','));
    const has = (await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(bot.id)!, t.app.ctx.store.thread(th.id)!)).map((x) => x.name);
    assert.ok(has.includes('mcp_google_gsc_search_analytics') && has.includes('mcp_google_gsc_sites'), has.join(','));
    assert.ok(!has.includes('mcp_google_gmail_send'), 'no actions before the owner allows them');
    assert.match(t.requests.at(-1)!.tools.find((x) => x.name === 'tools_find')!.description, /app [^:;]*Search Console[^:;]*: [^;]*search_analytics/, 'the apps are named, per service, with their tools');
    assert.match(t.app.ctx.store.messages(th.id).filter((m) => m.role === 'tool').at(-1)!.content, /kaarsen kopen/);

    // The ordinary read test of Apps: the built-in server lists its tools, with the right risks.
    const r = await t.api('POST', `/mcp/connections/${conn.id}/test`, { tool: 'gsc_sites', args: {} });
    assert.equal(r.ok, true, r.error);
    assert.match(r.sample.text, /sc-domain:voorbeeld\.nl/);
    const risk = Object.fromEntries(r.connection.tools.map((x: any) => [x.name, x.risk]));
    assert.equal(risk.gsc_search_analytics, 'read');
    assert.equal(risk.gmail_draft, 'write');
    assert.equal(risk.gmail_send, 'danger');
    assert.equal(risk.drive_search, undefined, 'no Drive tools without the Drive permission');
    assert.ok(g.seen.some((x) => x.path === '/www.googleapis.com/webmasters/v3/sites' && x.auth === 'Bearer at-1'));

    // Merchant Center: the one-time developer registration happens by itself.
    const mp = await t.api('POST', `/mcp/connections/${conn.id}/test`, { tool: 'merchant_products', args: { account: '555' } });
    assert.match(mp.sample.text, /kaars-1/);
    const reg = g.seen.find((x) => x.path.endsWith('developerRegistration:registerGcp'))!;
    assert.equal(JSON.parse(reg.body).developerEmail, 'eigenaar@voorbeeld.nl');

    // "Verbinding werkt" per service: Ads still wants its developer token, Analytics is switched off in the project.
    let chk = await t.api('POST', '/mcp/google/test', {});
    const by = (id: string) => chk.checks.find((x: any) => x.id === id);
    assert.equal(by('searchconsole').ok, true);
    assert.equal(by('merchant').ok, true);
    assert.equal(by('gmail').ok, true);
    assert.equal(by('ads').ok, false);
    assert.equal(by('ads').needsToken, true);
    assert.equal(by('analytics').ok, false);
    assert.match(by('analytics').fixUrl, /analyticsadmin\.googleapis\.com/);
    await assert.rejects(t.api('PUT', '/mcp/google/ads', { developerToken: 'te kort' }), /developer token/);
    s = await t.api('PUT', '/mcp/google/ads', { developerToken: 'AbCdEfGhIjKlMnOpQrStUv', loginCustomerId: '123-456-7890' });
    assert.equal(s.adsToken, true);
    assert.ok(!JSON.stringify(s).includes('AbCdEfGhIjKlMnOpQrStUv'));
    chk = await t.api('POST', '/mcp/google/test', {});
    assert.equal(by('ads').ok, true);
    const ads = g.seen.filter((x) => x.path.startsWith('/googleads.googleapis.com/')).pop()!;
    assert.equal(ads.headers['developer-token'], 'AbCdEfGhIjKlMnOpQrStUv');
    assert.equal(ads.headers['login-customer-id'], '1234567890');

    // An expired access token is refreshed without the owner noticing.
    g.state.access = 7;
    const again = await t.api('POST', `/mcp/connections/${conn.id}/test`, { tool: 'gsc_sites', args: {} });
    assert.equal(again.ok, true, again.error);
    assert.ok(g.seen.some((x) => x.path === '/oauth2.googleapis.com/token' && x.body.includes('grant_type=refresh_token') && x.body.includes('rt-1')));

    // Revoked at Google: the connection asks to log in again, it does not fail silently.
    g.state.refreshOk = false;
    g.state.access = 99;
    chk = await t.api('POST', '/mcp/google/test', {});
    assert.equal(chk.ok, false);
    assert.equal(chk.status, 'expired');
    assert.ok(chk.checks.every((x: any) => x.authRequired));

    // Disconnect: revoked at Google, tokens gone; the own client stays for the next login.
    const del = await t.api('DELETE', `/mcp/connections/${conn.id}`);
    assert.equal(del.revokedAtService, true);
    assert.ok(g.seen.some((x) => x.path === '/oauth2.googleapis.com/revoke' && x.body.includes('rt-1')));
    assert.ok(!t.app.ctx.secrets.list(t.app.ctx.auth.owner()!.id).some((x) => x.name.startsWith(`mcp:${conn.id}:`)));
    s = await t.api('GET', '/mcp/google');
    assert.equal(s.status, 'off');
    assert.equal(s.client, 'own');
  } finally {
    delete process.env.TEAMBOT_GOOGLE_BASE;
    await t.close();
    await g.close();
  }
});

test("Google: with TeamBot's own client there is nothing to set up, and sending mail is never a reading tool", async () => {
  const g = await fakeGoogle();
  process.env.TEAMBOT_GOOGLE_BASE = g.base;
  process.env.TEAMBOT_GOOGLE_CLIENT_ID = '999-teambot.apps.googleusercontent.com';
  process.env.TEAMBOT_GOOGLE_CLIENT_SECRET = 'secret-x';
  const t = await startTestApp({ mode: 'desktop' });
  try {
    assert.equal((await t.api('GET', '/mcp/google')).client, 'teambot');
    const { authorizationUrl } = await t.api('POST', '/mcp/google/start', { services: ['gmail'] });
    const a = new URL(authorizationUrl);
    assert.equal(a.searchParams.get('client_id'), '999-teambot.apps.googleusercontent.com');
    assert.ok(!a.searchParams.get('scope')!.includes('adwords'), 'only what was asked for');
    assert.equal((await fetch(`${a.searchParams.get('redirect_uri')}?code=code-123&state=${a.searchParams.get('state')}`)).status, 200);
    const s = await t.api('GET', '/mcp/google');
    assert.deepEqual(s.services.filter((x: any) => x.on).map((x: any) => x.id), ['gmail']);
    const r = await t.api('POST', `/mcp/connections/${s.connection.id}/test`, {});
    assert.deepEqual(r.connection.tools.map((x: any) => x.name).sort(), ['gmail_draft', 'gmail_read', 'gmail_search', 'gmail_send']);
    await assert.rejects(t.api('POST', `/mcp/connections/${s.connection.id}/test`, { tool: 'gmail_send', args: { to: 'a@b.nl', subject: 'x', body: 'y' } }), /alleen leestools/);
    assert.ok(!g.seen.some((x) => x.path.endsWith('/messages/send')));
  } finally {
    delete process.env.TEAMBOT_GOOGLE_BASE;
    delete process.env.TEAMBOT_GOOGLE_CLIENT_ID;
    delete process.env.TEAMBOT_GOOGLE_CLIENT_SECRET;
    await t.close();
    await g.close();
  }
});
