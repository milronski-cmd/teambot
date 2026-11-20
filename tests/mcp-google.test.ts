import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestApp } from './helpers.js';
import { GOOGLE_SERVICES, GOOGLE_TOOLS, setGoogleRetryWaits, tooFast, watchGmail } from '../server/modules/mcp/google.js';

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
  const state = { access: 1, grantScope: '' as string, refreshOk: true, merchantRegistered: false, tooFast: 0, daily: false, mail: false, inbox: [] as string[] };
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
      if (p === '/gmail.googleapis.com/gmail/v1/users/me/messages') {
        if (state.daily) return json(403, { error: { code: 403, message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'gmail.googleapis.com'." } });
        if (state.tooFast-- > 0) return json(403, { error: { code: 403, message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'." } });
        return json(200, { messages: state.inbox.length ? state.inbox.map((id) => ({ id, threadId: 't1' })) : state.mail ? [{ id: 'm1', threadId: 't1' }] : [] });
      }
      const one = /^\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/(m\d+|own\d+)$/.exec(p);
      if (one)
        return json(200, { id: one[1], threadId: 't1', labelIds: one[1].startsWith('own') ? ['SENT', 'INBOX'] : ['INBOX', 'UNREAD'], snippet: 'Kunnen jullie morgen leveren?', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Jan de Vries <jan@klant.test>' }, { name: 'To', value: 'eigenaar@voorbeeld.nl' }, { name: 'Subject', value: 'Levering' }, { name: 'Date', value: 'Fri, 20 Nov 2026 01:00:00 +0100' }, { name: 'Message-ID', value: one[1] === 'm1' ? '<abc@klant.test>' : `<${one[1]}@klant.test>` }], body: { data: Buffer.from('Kunnen jullie morgen leveren?').toString('base64url') } } });
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
  assert.deepEqual(GOOGLE_TOOLS.filter((t) => t.kind !== 'read').map((t) => t.name).sort(), ['calendar_create_event', 'ga_custom_dimension_create', 'ga_key_event_create', 'gmail_draft', 'gmail_draft_delete', 'gmail_send', 'gsc_sitemap_submit']);
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
    assert.deepEqual(r.connection.tools.map((x: any) => x.name).sort(), ['gmail_draft', 'gmail_draft_delete', 'gmail_drafts', 'gmail_read', 'gmail_search', 'gmail_send']);
    await assert.rejects(t.api('POST', `/mcp/connections/${s.connection.id}/test`, { tool: 'gmail_send', args: { to: 'a@b.nl', subject: 'x', body: 'y' } }), /alleen leestools/);
    assert.ok(!g.seen.some((x) => x.path.endsWith('/messages/send')));
    // Too many requests in a minute: TeamBot waits and sends the request again, the bot gets its answer.
    const searches = () => g.seen.filter((x) => x.path.startsWith('/gmail.googleapis.com/gmail/v1/users/me/messages?')).length;
    setGoogleRetryWaits([5, 5, 5]);
    g.state.tooFast = 2;
    const ok = await t.api('POST', `/mcp/connections/${s.connection.id}/test`, { tool: 'gmail_search', args: { query: 'factuur' } });
    assert.ok(!/Quota exceeded/.test(JSON.stringify(ok)), 'answered after waiting');
    assert.equal(searches(), 3, 'two refusals, then the answer');
    // A limit per day is not waited for: one request, and the bot hears why.
    g.state.daily = true;
    const day = await t.api('POST', `/mcp/connections/${s.connection.id}/test`, { tool: 'gmail_search', args: { query: 'factuur' } }).catch((e: any) => String(e?.message || e));
    assert.match(JSON.stringify(day), /per day/);
    assert.equal(searches(), 4);
    g.state.daily = false;
    // The owner's own mail on the dashboard: the inbox, one mail in full, and an answer he sends himself.
    g.state.mail = true;
    const inbox = (await t.api('GET', '/mcp/google/mail')).messages;
    assert.deepEqual(inbox.map((m: any) => [m.from, m.subject, m.unread]), [['Jan de Vries <jan@klant.test>', 'Levering', true]]);
    const one = await t.api('GET', '/mcp/google/mail/m1');
    assert.equal(one.body.trim(), 'Kunnen jullie morgen leveren?');
    assert.equal(one.messageId, '<abc@klant.test>');
    await assert.rejects(t.api('POST', '/mcp/google/mail/send', { to: 'geen adres', body: 'x' }), /Vul een e-mailadres in/);
    await assert.rejects(t.api('POST', '/mcp/google/mail/send', { to: 'jan@klant.test', body: '  ' }), /Het bericht is leeg/);
    const sent = await t.api('POST', '/mcp/google/mail/send', { to: 'jan@klant.test', subject: 'Re: Levering', body: 'Ja, morgen voor twaalf uur.', thread: 't1', inReplyTo: '<abc@klant.test>' });
    assert.equal(sent.ok, true);
    const out = g.seen.filter((x) => x.path.endsWith('/messages/send')).at(-1)!;
    const raw = Buffer.from(JSON.parse(out.body).raw, 'base64url').toString();
    assert.equal(JSON.parse(out.body).threadId, 't1', 'in the same conversation');
    assert.match(raw, /To: jan@klant\.test/);
    assert.match(raw, /In-Reply-To: <abc@klant\.test>/);
    assert.ok(t.app.ctx.store.all<any>("SELECT data FROM audit WHERE kind = 'mcp.google.mail_sent'").length === 1, 'in the log, without the text');

    // New mail in Gmail starts the routines that wait for mail; the mail that was already there starts nothing.
    const ctx = t.app.ctx;
    const mgr = ctx.services.mcp._manager;
    const owner = ctx.auth.owner()!;
    g.state.inbox = ['m1'];
    assert.equal(await watchGmail(ctx, mgr, owner.id), 0, 'nobody waits for mail: Google is not even asked');
    const before = searches();
    const bot = await t.agent({ name: 'Postbode' });
    const routine = await t.api('POST', '/routines', { name: 'Nieuwe mail indelen', agent_id: bot.id, prompt: 'Deel deze mail in en zeg of er actie nodig is.', schedule: { kind: 'none' } });
    const trg = (await t.api('POST', `/routines/${routine.id}/triggers`, { kind: 'email', config: { accountId: 'gmail' } })).trigger;
    const events = () => ctx.store.all<any>('SELECT status, summary FROM routine_events WHERE trigger_id = ?', trg.id);
    assert.equal(await watchGmail(ctx, mgr, owner.id), 0, 'the first look: what is there is old mail');
    assert.ok(searches() > before, 'now Google is asked');
    assert.equal(events().length, 0);
    g.state.inbox = ['m2', 'own3', 'm1'];
    assert.equal(await watchGmail(ctx, mgr, owner.id), 1, 'one new mail from someone else; the owner’s own sent mail is not incoming mail');
    assert.equal(events().filter((e) => e.status === 'accepted').length, 1);
    assert.match(events()[0].summary, /Jan de Vries <jan@klant\.test>/);
    assert.equal(await watchGmail(ctx, mgr, owner.id), 0, 'the same mail never twice');
    assert.ok(tooFast(429, '') && tooFast(403, 'rateLimitExceeded') && !tooFast(403, 'Queries per day') && !tooFast(403, 'insufficient permission') && !tooFast(500, 'per minute'));
  } finally {
    setGoogleRetryWaits(null);
    delete process.env.TEAMBOT_GOOGLE_BASE;
    delete process.env.TEAMBOT_GOOGLE_CLIENT_ID;
    delete process.env.TEAMBOT_GOOGLE_CLIENT_SECRET;
    await t.close();
    await g.close();
  }
});

test('Google: only reading mail ticked gives Gmail for reading, without drafts or sending', async () => {
  const g = await fakeGoogle();
  process.env.TEAMBOT_GOOGLE_BASE = g.base;
  process.env.TEAMBOT_GOOGLE_CLIENT_ID = '999-teambot.apps.googleusercontent.com';
  process.env.TEAMBOT_GOOGLE_CLIENT_SECRET = 'secret-x';
  const t = await startTestApp({ mode: 'desktop' });
  try {
    const { authorizationUrl } = await t.api('POST', '/mcp/google/start', { services: ['gmail'] });
    const a = new URL(authorizationUrl);
    // Google shows every right unticked; the owner ticked only "je e-mailberichten bekijken".
    g.state.grantScope = 'openid email https://www.googleapis.com/auth/gmail.readonly';
    assert.equal((await fetch(`${a.searchParams.get('redirect_uri')}?code=code-123&state=${a.searchParams.get('state')}`)).status, 200);
    const s = await t.api('GET', '/mcp/google');
    assert.deepEqual(s.services.filter((x: any) => x.on).map((x: any) => x.id), ['gmail']);
    const r = await t.api('POST', `/mcp/connections/${s.connection.id}/test`, {});
    assert.deepEqual(r.connection.tools.map((x: any) => x.name).sort(), ['gmail_read', 'gmail_search']);
  } finally {
    delete process.env.TEAMBOT_GOOGLE_BASE;
    delete process.env.TEAMBOT_GOOGLE_CLIENT_ID;
    delete process.env.TEAMBOT_GOOGLE_CLIENT_SECRET;
    await t.close();
    await g.close();
  }
});

test('a Merchant report on products always carries the product id Google demands', async () => {
  const { merchantQuery } = await import('../server/modules/mcp/google.js');
  assert.equal(merchantQuery("SELECT product_view.offer_id FROM product_view WHERE product_view.aggregated_reporting_context_status = 'NOT_ELIGIBLE_OR_DISAPPROVED'"), "SELECT id, product_view.offer_id FROM product_view WHERE product_view.aggregated_reporting_context_status = 'NOT_ELIGIBLE_OR_DISAPPROVED'");
  assert.equal(merchantQuery('select offer_id, title\nfrom product_view'), 'select id, offer_id, title\nfrom product_view');
  // Already there, a count, or another table: untouched.
  for (const q of ['SELECT id, title FROM product_view', 'SELECT product_view.id, title FROM product_view', 'SELECT title, offer_id, id FROM product_view', 'SELECT PRODUCTS_COUNT FROM product_view', 'SELECT offer_id, clicks FROM product_performance_view', 'SELECT offer_id FROM product_view_extra'])
    assert.equal(merchantQuery(q), q);
});

/** A Gmail that answers a tool's calls from a list of messages (newest first) and drafts; `calls` is what was asked. */
function fakeGmail(messages: { id: string; labels: string[]; subject: string; date: string; to?: string }[], drafts: { id: string; to: string; subject: string }[] = []) {
  const calls: string[] = [];
  const msg = (m: (typeof messages)[number]) => ({ id: m.id, threadId: `t-${m.id}`, labelIds: m.labels, snippet: '', payload: { headers: [{ name: 'To', value: m.to || 'pascal@afnemer.test' }, { name: 'Subject', value: m.subject }, { name: 'Date', value: m.date }] } });
  const g = async (method: string, url: string, _o: any = {}) => {
    const p = new URL(url).pathname.replace(/^.*\/users\/me/, '');
    calls.push(`${method} ${p}`);
    if (method === 'GET' && p === '/messages') return { messages: messages.map((m) => ({ id: m.id })) };
    if (method === 'GET' && p.startsWith('/messages/')) return msg(messages.find((m) => m.id === p.slice(10))!);
    if (method === 'POST' && p === '/messages/send') return { id: 'sent-new' };
    if (method === 'POST' && p === '/drafts') return { id: 'd-new', message: { id: 'dm-new' } };
    if (method === 'GET' && p === '/drafts') return { drafts: drafts.map((d) => ({ id: d.id })) };
    if (method === 'GET' && p.startsWith('/drafts/')) {
      const d = drafts.find((x) => x.id === p.slice(8))!;
      return { id: d.id, message: { threadId: 't', snippet: '', payload: { headers: [{ name: 'To', value: d.to }, { name: 'Subject', value: d.subject }, { name: 'Date', value: 'Mon, 16 Nov 2026 18:31:00 +0100' }] } } };
    }
    if (method === 'DELETE' && p.startsWith('/drafts/')) return {};
    throw new Error(`geen nep-antwoord voor ${method} ${p}`);
  };
  return { g: g as any, calls };
}
const gtool = (name: string) => GOOGLE_TOOLS.find((x) => x.name === name)!;

test('a mail or draft comes with what already lies with that person, and the same mail does not go twice', async () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toUTCString();
  // Nothing with this person yet: the mail goes as it always did, with nothing added.
  const fresh = fakeGmail([]);
  assert.deepEqual(await gtool('gmail_send').run({ to: 'Pascal <pascal@afnemer.test>', subject: 'Voorstel', body: 'Hoi' }, fresh.g, {} as any), { id: 'sent-new' });

  // A draft from days ago that was never sent, and a mail that came in: the bot that writes a new draft is told.
  const known = fakeGmail([
    { id: 'in1', labels: ['INBOX'], subject: 'Re: Tarief per lead', date: minutesAgo(600) },
    { id: 'dr1', labels: ['DRAFT'], subject: 'Tarief per lead', date: minutesAgo(5000) },
  ]);
  const d: any = await gtool('gmail_draft').run({ to: 'pascal@afnemer.test', subject: 'Re: Tarief per lead', body: 'Zoals in mijn voorstel…' }, known.g, {} as any);
  assert.equal(d.id, 'd-new');
  assert.deepEqual(d.eerder.map((r: any) => [r.what, r.subject]), [['ontvangen', 'Re: Tarief per lead'], ['concept', 'Tarief per lead']]);
  assert.match(d.let_op, /verwijs alleen naar wat echt verstuurd is/);
  assert.match(d.let_op, /1 ouder concept/);
  assert.ok(known.calls[0].startsWith('GET /messages'), 'looked first, then wrote');

  // The same subject went to this person eight minutes ago (a resumed turn, a second bot): not again, unless meant.
  const twice = fakeGmail([{ id: 's1', labels: ['SENT'], subject: 'Solvari affiliate programma', date: minutesAgo(8) }]);
  await assert.rejects(() => gtool('gmail_send').run({ to: 'pascal@afnemer.test', subject: 'Re: Solvari affiliate programma', body: 'Nog een keer' }, twice.g, {} as any), /Niet verstuurd: aan deze ontvanger ging 8 min geleden al een mail met dit onderwerp/);
  assert.ok(!twice.calls.includes('POST /messages/send'));
  const meant: any = await gtool('gmail_send').run({ to: 'pascal@afnemer.test', subject: 'Re: Solvari affiliate programma', body: 'Een aanvulling', again: true }, twice.g, {} as any);
  assert.equal(meant.id, 'sent-new');
  assert.match(meant.let_op, /Met deze ontvanger is al gemaild/);
  // Another subject, or the same one a day later, is an ordinary mail.
  const later = fakeGmail([{ id: 's1', labels: ['SENT'], subject: 'Solvari affiliate programma', date: minutesAgo(1500) }]);
  assert.equal(((await gtool('gmail_send').run({ to: 'pascal@afnemer.test', subject: 'Solvari affiliate programma', body: 'x' }, later.g, {} as any)) as any).id, 'sent-new');

  // Looking back never stops a mail: Gmail refuses the search, the mail still goes.
  const broken = { g: (async (m: string, u: string) => { if (m === 'GET') throw new Error('quota'); return { id: 'sent-new' }; }) as any };
  assert.deepEqual(await gtool('gmail_send').run({ to: 'pascal@afnemer.test', subject: 'x', body: 'y' }, broken.g, {} as any), { id: 'sent-new' });

  // Drafts can be listed and a stale one thrown away.
  const box = fakeGmail([], [{ id: 'r-1', to: 'pascal@afnemer.test', subject: 'Tarief per lead' }]);
  assert.deepEqual(((await gtool('gmail_drafts').run({ query: 'to:pascal@afnemer.test' }, box.g, {} as any)) as any[]).map((x) => [x.draft, x.subject]), [['r-1', 'Tarief per lead']]);
  assert.deepEqual(await gtool('gmail_draft_delete').run({ draft: 'r-1' }, box.g, {} as any), { deleted: 'r-1' });
  assert.ok(box.calls.includes('DELETE /drafts/r-1'));
});

test('Tag Manager: what is live in a container, with trigger names and consent per tag', async () => {
  const g = (async (_m: string, url: string) => {
    const p = new URL(url).pathname;
    if (p.endsWith('/accounts')) return { account: [{ accountId: '61', name: 'Leadsites' }] };
    if (p.endsWith('/containers')) return { container: [{ containerId: '7', name: 'Site', publicId: 'GTM-ABC123', domainName: ['voorbeeld.nl'], usageContext: ['web'] }] };
    if (p.endsWith('/versions:live'))
      return {
        containerVersionId: '12',
        name: 'v12',
        trigger: [{ triggerId: '5', name: 'Aanvraag verstuurd', type: 'customEvent' }],
        variable: [{ name: 'Paginatype', type: 'v' }],
        tag: [
          { name: 'GA4', type: 'googtag', firingTriggerId: ['2147479553'], parameter: [{ key: 'tagId', value: 'G-TEST123' }], consentSettings: { consentStatus: 'needed', consentType: { list: [{ value: 'analytics_storage' }] } } },
          { name: 'Lead', type: 'gaawe', paused: true, firingTriggerId: ['5'], blockingTriggerId: ['99'] },
        ],
      };
    throw new Error(`geen nep-antwoord voor ${p}`);
  }) as any;
  assert.deepEqual(await gtool('gtm_accounts').run({}, g, {} as any), [{ account: '61', name: 'Leadsites' }]);
  assert.deepEqual(((await gtool('gtm_containers').run({ account: '61' }, g, {} as any)) as any[]).map((c) => [c.container, c.publicId]), [['7', 'GTM-ABC123']]);
  const live: any = await gtool('gtm_published').run({ account: '61', container: '7' }, g, {} as any);
  assert.deepEqual(live.tags, [
    { name: 'GA4', type: 'googtag', paused: false, fires_on: ['All Pages'], blocked_by: [], consent: 'needed', consent_types: ['analytics_storage'], id: 'G-TEST123' },
    { name: 'Lead', type: 'gaawe', paused: true, fires_on: ['Aanvraag verstuurd'], blocked_by: ['trigger 99'], consent: 'notSet', consent_types: [], id: undefined },
  ]);
  assert.deepEqual(live.triggers, [{ name: 'Aanvraag verstuurd', type: 'customEvent' }]);
});

test('an error in the words of Google comes with the next step', async () => {
  const { nextStep } = await import('../server/modules/mcp/google.js');
  assert.match(nextStep('merchant_report', 'This method can only be accessed by subaccounts and standalone accounts.'), /subaccount zelf \(merchant_accounts/);
  assert.match(nextStep('merchant_report', "[query] Error in query: invalid field name 'product_type' in SELECT clause"), /product_type_l1/);
  assert.match(nextStep('gmail_read', 'Invalid id value'), /letterlijk over uit gmail_search/);
  assert.match(nextStep('ads_query', 'The Google Cloud project is only approved for use with test accounts. To access non-test accounts, apply for Basic or Standard access.'), /developer token .* ander account geeft dezelfde fout/);
  assert.equal(nextStep('gsc_query', 'The operation was aborted due to timeout'), '');
});

test('an ordinary reply may go without a card when the owner switched that on; money, a first message and more recipients still ask', async () => {
  const { plainReply } = await import('../server/modules/mcp/google.js');
  const reply = { to: 'jan@klant.test', subject: 'Re: Levering', thread: 't1', inReplyTo: '<a@klant.test>', body: 'Ja, morgen voor twaalf uur is hij er.' };
  assert.equal(plainReply(reply), true);
  assert.equal(plainReply({ ...reply, thread: '' }), false, 'a first message');
  assert.equal(plainReply({ ...reply, inReplyTo: '' }), false);
  assert.equal(plainReply({ ...reply, to: 'jan@klant.test, piet@klant.test' }), false, 'more than one recipient');
  assert.equal(plainReply({ ...reply, cc: 'baas@klant.test' }), false);
  assert.equal(plainReply({ ...reply, body: 'We betalen het bedrag van € 51,90 terug.' }), false, 'about money');
  assert.equal(plainReply({ ...reply, subject: 'Re: korting op je bestelling' }), false);
});

test('writing in Search Console and Analytics: a sitemap is submitted, an event becomes a goal, each with its own right', async () => {
  const calls: any[] = [];
  const g = (async (m: string, url: string, o: any = {}) => {
    calls.push([m, new URL(url).pathname, o.body || null]);
    return m === 'GET' ? { keyEvents: [{ eventName: 'purchase' }] } : { name: 'ok' };
  }) as any;
  assert.deepEqual(await gtool('gsc_sitemap_submit').run({ site: 'sc-domain:voorbeeld.nl', sitemap: 'https://voorbeeld.nl/sitemap.xml' }, g, {} as any), { ingediend: 'https://voorbeeld.nl/sitemap.xml', site: 'sc-domain:voorbeeld.nl' });
  await gtool('ga_key_events').run({ property: 'properties/123456789' }, g, {} as any);
  await gtool('ga_key_event_create').run({ property: '123456789', event: 'generate_lead' }, g, {} as any);
  await gtool('ga_custom_dimension_create').run({ property: '123456789', parameter: 'lead_bron', name: 'Bron van de aanvraag' }, g, {} as any);
  assert.deepEqual(calls, [
    ['PUT', '/webmasters/v3/sites/sc-domain%3Avoorbeeld.nl/sitemaps/https%3A%2F%2Fvoorbeeld.nl%2Fsitemap.xml', null],
    ['GET', '/v1beta/properties/123456789/keyEvents', null],
    ['POST', '/v1beta/properties/123456789/keyEvents', { eventName: 'generate_lead', countingMethod: 'ONCE_PER_EVENT' }],
    ['POST', '/v1beta/properties/123456789/customDimensions', { parameterName: 'lead_bron', displayName: 'Bron van de aanvraag', scope: 'EVENT' }],
  ]);
  // The writing tools need the wider right, which the owner grants by logging in again; reading stays as it was.
  assert.match(gtool('gsc_sitemap_submit').scope || '', /auth\/webmasters$/);
  assert.match(gtool('ga_key_event_create').scope || '', /auth\/analytics\.edit$/);
  assert.equal(gtool('ga_key_events').scope, undefined);
});
