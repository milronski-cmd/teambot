import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestApp } from './helpers.js';
import { MS_DEFAULT_CLIENT_ID, MS_SCOPES, MS_TOOLS, htmlToText, watchOutlook } from '../server/modules/mcp/microsoft.js';

/**
 * Microsoft / Outlook against a local stand-in for login.microsoftonline.com and graph.microsoft.com (TEAMBOT_MS_BASE):
 * the login (authorization code + PKCE, a public client without a secret), several accounts side by side, the tools
 * per account, sending, the rotating refresh token, the routines trigger and the refusal in server mode. Nothing here
 * talks to the real Microsoft.
 */
interface Seen {
  method: string;
  path: string;
  auth: string;
  body: string;
}

async function fakeMicrosoft() {
  const seen: Seen[] = [];
  const state = {
    email: 'ronnie@hotmail.com',
    challenge: '',
    n: 0,
    /** Access token → address; cleared to make every token expire. */
    access: new Map<string, string>(),
    /** Per address the one refresh token that still works (Microsoft rotates them). */
    refresh: new Map<string, string>(),
    revoked: false,
    inbox: ['m1'],
  };
  const issue = (email: string) => {
    const at = `at-${++state.n}`;
    const rt = `rt-${email}-${state.n}`;
    state.access.set(at, email);
    state.refresh.set(email, rt);
    return { access_token: at, refresh_token: rt, expires_in: 3600, scope: 'openid email profile offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read', token_type: 'Bearer' };
  };
  const msg = (id: string) => ({
    id,
    conversationId: 'conv-1',
    from: { emailAddress: { name: 'Jan de Vries', address: 'jan@klant.test' } },
    toRecipients: [{ emailAddress: { name: 'Ronnie', address: state.email } }],
    subject: 'Levering',
    receivedDateTime: '2026-11-24T10:00:00Z',
    isRead: false,
    bodyPreview: 'Kunnen jullie morgen leveren?',
    internetMessageId: `<${id}@klant.test>`,
    hasAttachments: false,
    body: { contentType: 'html', content: '<html><head><style>p{}</style></head><body><p>Kunnen jullie <b>morgen</b> leveren?</p><p>Groet,&nbsp;Jan</p></body></html>' },
  });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://x');
      const p = url.pathname;
      seen.push({ method: req.method || '', path: p + url.search, auth: String(req.headers.authorization || ''), body });
      const json = (code: number, v: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
      if (p === '/login.microsoftonline.com/common/oauth2/v2.0/token') {
        const f = new URLSearchParams(body);
        if (f.get('client_secret') !== null) return json(400, { error: 'invalid_request', error_description: 'AADSTS90023: Public clients can\'t send a client secret.' });
        if (f.get('grant_type') === 'authorization_code') {
          const verifier = f.get('code_verifier') || '';
          if (f.get('code') !== 'code-1' || crypto.createHash('sha256').update(verifier).digest('base64url') !== state.challenge) return json(400, { error: 'invalid_grant', error_description: 'AADSTS50148: The code_verifier does not match.' });
          const id = Buffer.from(JSON.stringify({ preferred_username: state.email, tid: '9188040d-6c67-4c5b-b112-36a304b66dad' })).toString('base64url');
          return json(200, { ...issue(state.email), id_token: `x.${id}.y` });
        }
        const rt = f.get('refresh_token') || '';
        const email = [...state.refresh].find(([, v]) => v === rt)?.[0];
        if (state.revoked || !email) return json(400, { error: 'invalid_grant', error_description: 'AADSTS70000: The refresh token has expired or is invalid.' });
        return json(200, issue(email));
      }
      const who = state.access.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!who) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } });
      const g = p.replace(/^\/graph\.microsoft\.com\/v1\.0/, '');
      if (g === '/me') return json(200, { id: 'u1', mail: who, userPrincipalName: who });
      if (g === '/me/mailFolders/inbox/messages' || g === '/me/messages') return json(200, { value: state.inbox.map(msg) });
      if (g === '/me/mailFolders/sentitems/messages') return json(200, { value: [] });
      if (g === '/me/sendMail' || /^\/me\/messages\/[^/]+\/reply$/.test(g)) return (res.writeHead(202), res.end());
      const one = /^\/me\/messages\/([^/]+)$/.exec(g);
      if (one && req.method === 'GET') return json(200, msg(decodeURIComponent(one[1])));
      if (one && req.method === 'PATCH') return json(200, { ...msg(one[1]), ...JSON.parse(body) });
      if (g === '/me/calendarView') return json(200, { value: [{ id: 'e1', subject: 'Overleg', start: { dateTime: '2026-11-25T09:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-25T10:00:00.0000000', timeZone: 'UTC' } }] });
      json(404, { error: { code: 'ResourceNotFound', message: `geen nep-antwoord voor ${req.method} ${g}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('Outlook: every tool has the right kind, and sending is the only one that goes to others', () => {
  assert.deepEqual(Object.fromEntries(MS_TOOLS.map((t) => [t.name, t.kind])), {
    outlook_search: 'read',
    outlook_read: 'read',
    outlook_draft: 'write',
    outlook_send: 'send',
    outlook_mark_read: 'write',
    outlook_move: 'write',
    outlook_calendar_events: 'read',
    outlook_calendar_create: 'write',
  });
  assert.equal(htmlToText('<style>x{}</style><p>Hallo&nbsp;<b>Jan</b></p><p>Groet</p>'), 'Hallo Jan\nGroet');
});

test('Outlook: login with PKCE and no secret, two accounts side by side, tools per account, sending, a rotating refresh token', async () => {
  const f = await fakeMicrosoft();
  process.env.TEAMBOT_MS_BASE = f.base;
  const t = await startTestApp({ mode: 'desktop' });
  const login = async (body: any) => {
    const a = new URL((await t.api('POST', '/mcp/microsoft/start', body)).authorizationUrl);
    f.state.challenge = a.searchParams.get('code_challenge')!;
    // The redirect is http://localhost (what the Entra app has); the test server listens on 127.0.0.1.
    const back = await fetch(`${a.searchParams.get('redirect_uri')!.replace('//localhost', '//127.0.0.1')}?code=code-1&state=${a.searchParams.get('state')}`);
    assert.equal(back.status, 200, await back.clone().text());
    assert.match(await back.text(), /Outlook is gekoppeld/);
    return a;
  };
  try {
    const ctx = t.app.ctx;
    const bot = await t.agent({ name: 'Postbode' });
    let s = await t.api('GET', '/mcp/microsoft');
    assert.equal(s.status, 'off');
    assert.equal(s.local, true);

    // Start: Microsoft's own login page, TeamBot's public client, PKCE, every scope, back to localhost.
    const a = await login({});
    assert.ok(a.pathname.endsWith('/login.microsoftonline.com/common/oauth2/v2.0/authorize'));
    assert.equal(a.searchParams.get('client_id'), MS_DEFAULT_CLIENT_ID);
    assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(a.searchParams.get('prompt'), 'select_account');
    assert.deepEqual(a.searchParams.get('scope')!.split(' '), MS_SCOPES);
    assert.match(a.searchParams.get('redirect_uri')!, /^http:\/\/localhost:\d+\/api\/public\/mcp\/microsoft\/callback$/);
    const code = f.seen.find((x) => x.path.endsWith('/token') && x.body.includes('grant_type=authorization_code'))!;
    const form = new URLSearchParams(code.body);
    assert.ok(form.get('code_verifier'), 'the code verifier is sent');
    assert.equal(form.get('client_secret'), null, 'a public client sends no secret');
    assert.equal(form.get('redirect_uri'), a.searchParams.get('redirect_uri'));
    // The same login link works once; a wrong state never connects anything.
    assert.equal((await fetch(`${a.searchParams.get('redirect_uri')!.replace('//localhost', '//127.0.0.1')}?code=code-1&state=${a.searchParams.get('state')}`)).status, 400);

    s = await t.api('GET', '/mcp/microsoft');
    assert.equal(s.status, 'on');
    assert.equal(s.email, 'ronnie@hotmail.com');
    const first = s.connection.id;
    assert.equal(s.connection.transport, 'builtin');
    assert.deepEqual(s.connection.agents, [bot.id], 'connected means the bots can use it');

    // The tools are usable straight away, with the right risks.
    const r = await t.api('POST', `/mcp/connections/${first}/test`, { tool: 'outlook_search', args: { folder: 'inbox' } });
    assert.equal(r.ok, true, r.error);
    assert.match(r.sample.text, /Levering/);
    const risk = Object.fromEntries(r.connection.tools.map((x: any) => [x.name, x.risk]));
    assert.equal(risk.outlook_search, 'read');
    assert.equal(risk.outlook_draft, 'write');
    assert.equal(risk.outlook_send, 'danger');
    assert.equal(r.connection.tools.length, MS_TOOLS.length);

    // "Nog een Microsoft-account": Microsoft lets you choose; a new address is a second account.
    f.state.email = 'ronnie@msn.com';
    const add = await login({ add: true });
    assert.equal(add.searchParams.get('prompt'), 'select_account');
    assert.equal(add.searchParams.get('login_hint'), null);
    s = await t.api('GET', '/mcp/microsoft');
    assert.deepEqual(s.accounts.map((x: any) => x.email), ['ronnie@hotmail.com', 'ronnie@msn.com']);
    const second = s.accounts[1].id;
    assert.equal(s.connection.id, first, 'without ?conn= the first account');
    assert.equal((await t.api('GET', `/mcp/microsoft?conn=${second}`)).email, 'ronnie@msn.com');

    // Logging in again for the second account fills in its address; "add" with a known address is that account again.
    const again = await login({ conn: second });
    assert.equal(again.searchParams.get('login_hint'), 'ronnie@msn.com');
    assert.equal(again.searchParams.get('prompt'), null);
    f.state.email = 'ronnie@hotmail.com';
    await login({ add: true });
    assert.equal((await t.api('GET', '/mcp/microsoft')).accounts.length, 2);
    const rows = ctx.store.all<any>("SELECT id, slug, label FROM mcp_connections WHERE catalog_id = 'microsoft' ORDER BY created_at");
    assert.deepEqual(rows.map((x) => x.label), ['ronnie@hotmail.com', 'ronnie@msn.com']);
    assert.notEqual(rows[0].slug, rows[1].slug);

    // Each account its own tools for the bot, each working on its own mailbox.
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const names = (await ctx.tools.forAgent(ctx.store.agent(bot.id)!, ctx.store.thread(th.id)!)).map((x: any) => x.name).filter((n: string) => n.endsWith('outlook_search'));
    assert.equal(names.length, 2, 'outlook_search once per account');
    const chk = await t.api('POST', '/mcp/microsoft/test', { conn: second });
    assert.equal(chk.ok, true, JSON.stringify(chk.checks));
    const lastMe = f.seen.filter((x) => x.path.startsWith('/graph.microsoft.com/v1.0/me?')).at(-1)!;
    assert.equal(f.state.access.get(lastMe.auth.replace('Bearer ', '')), 'ronnie@msn.com', 'the second account reads its own mailbox');

    // The owner's own mail on the dashboard, per account: the list, one mail as text, a new mail and an answer.
    const list = await t.api('GET', `/mcp/microsoft/mail?conn=${second}`);
    assert.deepEqual(list.messages.map((m: any) => [m.from, m.subject, m.unread, m.thread]), [['Jan de Vries <jan@klant.test>', 'Levering', true, 'conv-1']]);
    const one = await t.api('GET', `/mcp/microsoft/mail/m1?conn=${second}`);
    assert.equal(one.body, 'Kunnen jullie morgen leveren?\nGroet, Jan');
    assert.equal(one.messageId, '<m1@klant.test>');
    await assert.rejects(t.api('POST', '/mcp/microsoft/mail/send', { to: 'geen adres', body: 'x' }), /Vul een e-mailadres in/);
    await t.api('POST', '/mcp/microsoft/mail/send', { to: 'Piet <piet@klant.test>', subject: 'Offerte', body: 'Zie hieronder.', conn: second });
    const sent = f.seen.filter((x) => x.path === '/graph.microsoft.com/v1.0/me/sendMail').at(-1)!;
    assert.equal(sent.method, 'POST');
    assert.deepEqual(JSON.parse(sent.body), { message: { subject: 'Offerte', body: { contentType: 'Text', content: 'Zie hieronder.' }, toRecipients: [{ emailAddress: { address: 'piet@klant.test' } }] }, saveToSentItems: true });
    assert.equal(f.state.access.get(sent.auth.replace('Bearer ', '')), 'ronnie@msn.com', 'sent from the account that was chosen');
    await t.api('POST', '/mcp/microsoft/mail/send', { replyTo: 'm1', subject: 'Re: Levering', body: 'Ja, morgen voor twaalf uur.' });
    const reply = f.seen.filter((x) => x.path === '/graph.microsoft.com/v1.0/me/messages/m1/reply').at(-1)!;
    assert.deepEqual(JSON.parse(reply.body), { comment: 'Ja, morgen voor twaalf uur.' });
    assert.equal(f.state.access.get(reply.auth.replace('Bearer ', '')), 'ronnie@hotmail.com', 'without conn: the first account');

    // An expired access token is refreshed; Microsoft rotates the refresh token and TeamBot keeps the newest (the
    // fake only accepts the newest, so a second refresh proves it was stored).
    for (let i = 0; i < 2; i++) {
      f.state.access.clear();
      const again2 = await t.api('POST', `/mcp/connections/${first}/test`, { tool: 'outlook_calendar_events', args: {} });
      assert.equal(again2.ok, true, again2.error);
      assert.match(again2.sample.text, /Overleg/);
    }
    const refreshes = f.seen.filter((x) => x.path.endsWith('/token') && x.body.includes('grant_type=refresh_token')).map((x) => new URLSearchParams(x.body));
    assert.equal(refreshes.length, 2);
    assert.notEqual(refreshes[0].get('refresh_token'), refreshes[1].get('refresh_token'), 'the rotated refresh token was used');
    assert.ok(refreshes.every((x) => x.get('client_secret') === null && x.get('client_id') === MS_DEFAULT_CLIENT_ID));

    // New mail in Outlook starts the routines that wait for mail; what was already there starts nothing.
    const mgr = ctx.services.mcp._manager;
    const owner = ctx.auth.owner()!;
    assert.equal(await watchOutlook(ctx, mgr, owner.id), 0, 'nobody waits for mail');
    const routine = await t.api('POST', '/routines', { name: 'Nieuwe mail', agent_id: bot.id, prompt: 'Deel deze mail in.', schedule: { kind: 'none' } });
    const trg = (await t.api('POST', `/routines/${routine.id}/triggers`, { kind: 'email', config: { accountId: 'outlook' } })).trigger;
    assert.equal(await watchOutlook(ctx, mgr, owner.id), 0, 'the first look: old mail');
    f.state.inbox = ['m2', 'm1'];
    assert.equal(await watchOutlook(ctx, mgr, owner.id), 2, 'one new mail in each of the two accounts');
    assert.equal(await watchOutlook(ctx, mgr, owner.id), 0, 'the same mail never twice');
    assert.ok(ctx.store.all<any>('SELECT status FROM routine_events WHERE trigger_id = ?', trg.id).length >= 1);

    // Revoked at Microsoft: the test says to log in again.
    f.state.revoked = true;
    f.state.access.clear();
    const dead = await t.api('POST', '/mcp/microsoft/test', { conn: first });
    assert.equal(dead.ok, false);
    assert.equal(dead.status, 'expired');
    assert.ok(dead.checks.every((x: any) => x.authRequired));

    // Disconnect: the tokens are gone and the owner is told where to take the access away at Microsoft.
    const del = await t.api('DELETE', `/mcp/connections/${first}`);
    assert.equal(del.revokedAtService, false);
    assert.match(del.revokeDetail || del.detail || JSON.stringify(del), /account\.live\.com\/consent\/Manage/);
    assert.ok(!ctx.secrets.list(owner.id).some((x) => x.name.startsWith(`mcp:${first}:`)));
    assert.deepEqual((await t.api('GET', '/mcp/microsoft')).accounts.map((x: any) => x.email), ['ronnie@msn.com']);
  } finally {
    delete process.env.TEAMBOT_MS_BASE;
    await t.close();
    await f.close();
  }
});

test('Outlook: a reply goes to the sender in the same conversation, and the same mail does not go twice', async () => {
  const calls: any[] = [];
  const sentAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  let sentItems: any[] = [];
  const g = (async (method: string, url: string, o: any = {}) => {
    calls.push([method, url, o.body ?? null]);
    if (method === 'GET' && url === '/me/messages/m1') return { subject: 'Levering', from: { emailAddress: { name: 'Jan', address: 'jan@klant.test' } } };
    if (method === 'GET' && url === '/me/mailFolders/sentitems/messages') return { value: sentItems };
    return {};
  }) as any;
  const send = MS_TOOLS.find((x) => x.name === 'outlook_send')!;
  const draft = MS_TOOLS.find((x) => x.name === 'outlook_draft')!;

  assert.deepEqual(await send.run({ replyTo: 'm1', body: 'Ja.' }, g), { verstuurd: true, antwoordOp: 'm1', aan: ['jan@klant.test'] });
  assert.deepEqual(calls.at(-1), ['POST', '/me/messages/m1/reply', { comment: 'Ja.' }]);

  sentItems = [{ id: 's1', subject: 'RE: Levering', sentDateTime: sentAgo(8), toRecipients: [{ emailAddress: { address: 'jan@klant.test' } }] }];
  await assert.rejects(() => send.run({ replyTo: 'm1', body: 'Ja.' }, g), /Niet verstuurd: aan deze ontvanger ging 8 min geleden al een mail met dit onderwerp/);
  await assert.rejects(() => send.run({ to: 'jan@klant.test', subject: 'Levering', body: 'x' }, g), /Niet verstuurd/);
  assert.deepEqual(await send.run({ to: 'jan@klant.test', subject: 'Levering', body: 'x', again: true }, g), { verstuurd: true, aan: ['jan@klant.test'], onderwerp: 'Levering' });
  sentItems = [{ id: 's1', subject: 'Levering', sentDateTime: sentAgo(90), toRecipients: [{ emailAddress: { address: 'jan@klant.test' } }] }];
  assert.equal((await send.run({ to: 'jan@klant.test', subject: 'Levering', body: 'x' }, g)).verstuurd, true, 'an hour and a half later is a new mail');

  await draft.run({ replyTo: 'm1', body: 'Concept' }, g);
  assert.deepEqual(calls.at(-1), ['POST', '/me/messages/m1/createReply', { comment: 'Concept' }]);
  await draft.run({ to: 'a@b.nl', cc: 'c@d.nl', subject: 'Hoi', body: 'Tekst' }, g);
  assert.deepEqual(calls.at(-1), ['POST', '/me/messages', { subject: 'Hoi', body: { contentType: 'Text', content: 'Tekst' }, toRecipients: [{ emailAddress: { address: 'a@b.nl' } }], ccRecipients: [{ emailAddress: { address: 'c@d.nl' } }] }]);

  const move = MS_TOOLS.find((x) => x.name === 'outlook_move')!;
  await move.run({ id: 'm1', folder: 'Prullenbak' }, g);
  assert.deepEqual(calls.at(-1), ['POST', '/me/messages/m1/move', { destinationId: 'deleteditems' }]);
});

test('Outlook: on another address than this computer (server mode) connecting is refused in plain words', async () => {
  process.env.TEAMBOT_PUBLIC_URL = 'https://teambot.voorbeeld.nl';
  const t = await startTestApp({ mode: 'server' });
  try {
    const s = await t.api('GET', '/mcp/microsoft');
    assert.equal(s.local, false);
    await assert.rejects(t.api('POST', '/mcp/microsoft/start', {}), /Outlook koppelen kan alleen op de computer waar TeamBot draait/);
  } finally {
    delete process.env.TEAMBOT_PUBLIC_URL;
    await t.close();
  }
});
