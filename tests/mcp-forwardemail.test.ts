import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { startTestApp } from './helpers.js';
import { FORWARDEMAIL_TOOLS, forwardEmailServer, tidyFeDomain } from '../server/modules/mcp/forwardemail.js';
import { getConn } from '../server/modules/mcp/oauth.js';

/**
 * Forward Email end to end against a local stand-in (TEAMBOT_FORWARDEMAIL_BASE): HTTP Basic with the API token, the
 * check on save, the domains with what DNS is missing, verify-records, and making and removing addresses.
 */
const TOKEN = 'fe-test-token-1234567890';

interface Seen {
  method: string;
  path: string;
  body: string;
  auth: string;
}

async function fakeForwardEmail() {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://x');
      const p = url.pathname;
      seen.push({ method: req.method || '', path: p + url.search, body, auth: String(req.headers.authorization || '') });
      const json = (code: number, v: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
      if (req.headers.authorization !== `Basic ${Buffer.from(`${TOKEN}:`).toString('base64')}`) return json(401, { statusCode: 401, error: 'Unauthorized', message: 'Invalid API token.' });
      if (p === '/v1/account') return json(200, { id: 'u1', email: 'eigenaar@voorbeeld.nl', plan: 'enhanced_protection' });
      if (p === '/v1/domains' && req.method === 'GET')
        return json(200, [
          { id: 'd1', name: 'voorbeeld.nl', plan: 'enhanced_protection', has_mx_record: true, has_txt_record: true, has_dkim_record: true, has_return_path_record: true, has_dmarc_record: true },
          { id: 'd2', name: 'nieuw.nl', plan: 'enhanced_protection', has_mx_record: false, has_txt_record: true, has_dkim_record: false, has_return_path_record: true, has_dmarc_record: true, verification_record: 'abc123' },
        ]);
      if (p === '/v1/domains' && req.method === 'POST') return json(200, { id: 'd3', name: JSON.parse(body).domain, plan: JSON.parse(body).plan || 'free', has_mx_record: false, has_txt_record: false });
      if (p === '/v1/domains/nieuw.nl/verify-records') return json(400, { statusCode: 400, error: 'Bad Request', message: 'MX records missing: mx1.forwardemail.net, mx2.forwardemail.net. DKIM record missing.' });
      if (p === '/v1/domains/voorbeeld.nl/verify-records') return json(200, { message: 'Domain DNS records are verified.' });
      if (p === '/v1/domains/voorbeeld.nl/aliases' && req.method === 'GET') return json(200, [{ id: 'a1', name: 'info', recipients: ['jan@gmail.com'], is_enabled: true, has_imap: false }]);
      if (p === '/v1/domains/voorbeeld.nl/aliases' && req.method === 'POST') return json(200, { id: 'a2', ...JSON.parse(body) });
      if (p === '/v1/domains/voorbeeld.nl/aliases/a2' && req.method === 'PUT') return json(200, { id: 'a2', name: 'sales', ...JSON.parse(body) });
      if (p === '/v1/domains/voorbeeld.nl/aliases/a2' && req.method === 'DELETE') return json(200, { id: 'a2', name: 'sales' });
      if (p === '/v1/domains/voorbeeld.nl/aliases/a2/generate-password') return json(200, {});
      json(404, { statusCode: 404, error: 'Not Found', message: `geen nep-antwoord voor ${req.method} ${p}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('forwardemail: a domain as a bot reads it, and the kinds of tools', () => {
  const d = tidyFeDomain({ name: 'a.nl', has_mx_record: false, has_txt_record: true, has_dkim_record: false });
  assert.equal(d.dns_compleet, false);
  assert.deepEqual(d.ontbreekt, ['MX', 'DKIM']);
  assert.equal(tidyFeDomain({ name: 'b.nl', has_mx_record: true, has_txt_record: true, has_dkim_record: true }).dns_compleet, true);
  assert.deepEqual(Object.fromEntries(FORWARDEMAIL_TOOLS.map((x) => [x.name, x.kind])), {
    forwardemail_domains: 'read', forwardemail_domain: 'read', forwardemail_domain_verify: 'read', forwardemail_domain_create: 'write', forwardemail_aliases: 'read', forwardemail_alias_create: 'write', forwardemail_alias_update: 'write', forwardemail_alias_delete: 'send', forwardemail_alias_password: 'send',
  });
  assert.match(FORWARDEMAIL_TOOLS.find((x) => x.name === 'forwardemail_alias_password')!.description, /nooit in een chat/);
});

test('forwardemail: set up with the API token, the bots read domains and make and remove addresses', async () => {
  const f = await fakeForwardEmail();
  process.env.TEAMBOT_FORWARDEMAIL_BASE = f.base;
  const t = await startTestApp({ mode: 'desktop' });
  try {
    const bot = await t.agent({ name: 'Postbeheer' });
    assert.deepEqual(await t.api('GET', '/mcp/forwardemail'), { account: null, status: 'off', connection: null });
    await assert.rejects(t.api('PUT', '/mcp/forwardemail', { token: 'kort' }), /Plak je API-token/);
    await assert.rejects(t.api('PUT', '/mcp/forwardemail', { token: 'verkeerde-token-123' }), /nam deze API-token niet aan/);
    assert.equal((await t.api('GET', '/mcp/forwardemail')).account, null);

    const s = await t.api('PUT', '/mcp/forwardemail', { token: TOKEN });
    assert.deepEqual(s.account, { email: 'eigenaar@voorbeeld.nl' });
    assert.equal(s.status, 'on');
    assert.ok(!JSON.stringify(s).includes(TOKEN), 'the token never comes back');
    const conn = s.connection;
    assert.deepEqual(conn.agents, [bot.id]);
    const risk = Object.fromEntries(conn.tools.map((x: any) => [x.name, x.risk]));
    assert.deepEqual([risk.forwardemail_domains, risk.forwardemail_domain_verify, risk.forwardemail_alias_create, risk.forwardemail_alias_delete, risk.forwardemail_alias_password], ['read', 'read', 'write', 'danger', 'danger']);

    const r = await t.api('POST', `/mcp/connections/${conn.id}/test`, { tool: 'forwardemail_domains', args: {} });
    assert.match(r.sample.text, /nieuw\.nl/);
    assert.match(r.sample.text, /"dns_compleet": false/);
    assert.match(r.sample.text, /"MX"/);
    // What is missing comes back as an answer the bot can act on (with transip_dns_add), not as a failure.
    const v = await t.api('POST', `/mcp/connections/${conn.id}/test`, { tool: 'forwardemail_domain_verify', args: { domain: 'nieuw.nl' } });
    assert.equal(v.sample.isError, false);
    assert.match(v.sample.text, /MX records missing/);
    assert.ok(f.seen.some((x) => x.path === '/v1/domains/nieuw.nl/verify-records'));
    const ok = await t.api('POST', `/mcp/connections/${conn.id}/test`, { tool: 'forwardemail_domain_verify', args: { domain: 'voorbeeld.nl' } });
    assert.match(ok.sample.text, /"ok": true/);

    const client = new Client({ name: 'test', version: '1' });
    const [mine, theirs] = InMemoryTransport.createLinkedPair();
    await forwardEmailServer(t.app.ctx, getConn(t.app.ctx, conn.id)!).connect(theirs);
    await client.connect(mine);
    const call = async (name: string, args: any) => {
      const res: any = await client.callTool({ name, arguments: args });
      assert.ok(!res.isError, `${name}: ${res.content?.[0]?.text}`);
      return JSON.parse(res.content[0].text);
    };
    const last = () => f.seen.at(-1)!;
    assert.equal((await call('forwardemail_aliases', { domain: 'voorbeeld.nl' })).aliases[0].address, 'info@voorbeeld.nl');
    const made = await call('forwardemail_alias_create', { domain: 'voorbeeld.nl', name: 'sales', recipients: ['jan@gmail.com'], description: 'Verkoop', is_enabled: true, has_imap: true });
    assert.deepEqual([last().method, last().path, JSON.parse(last().body)], ['POST', '/v1/domains/voorbeeld.nl/aliases', { name: 'sales', recipients: ['jan@gmail.com'], description: 'Verkoop', is_enabled: true, has_imap: true }]);
    assert.equal(made.address, 'sales@voorbeeld.nl');
    await call('forwardemail_alias_update', { domain: 'voorbeeld.nl', alias: 'a2', is_enabled: false });
    assert.deepEqual([last().method, last().path, JSON.parse(last().body)], ['PUT', '/v1/domains/voorbeeld.nl/aliases/a2', { is_enabled: false }]);
    await call('forwardemail_alias_password', { domain: 'voorbeeld.nl', alias: 'a2', send_to: 'eigenaar@voorbeeld.nl' });
    assert.deepEqual([last().path, JSON.parse(last().body)], ['/v1/domains/voorbeeld.nl/aliases/a2/generate-password', { emailed_instructions: 'eigenaar@voorbeeld.nl' }], 'the password goes by mail, never to the bot');
    await call('forwardemail_alias_delete', { domain: 'voorbeeld.nl', alias: 'a2' });
    assert.deepEqual([last().method, last().path], ['DELETE', '/v1/domains/voorbeeld.nl/aliases/a2']);
    await call('forwardemail_domain_create', { domain: 'derde.nl', plan: 'free' });
    assert.deepEqual([last().method, last().path, JSON.parse(last().body)], ['POST', '/v1/domains', { domain: 'derde.nl', plan: 'free' }]);
    await client.close();
    assert.ok(f.seen.slice(2).every((x) => x.auth === `Basic ${Buffer.from(`${TOKEN}:`).toString('base64')}`), 'HTTP Basic: the token as user name, empty password');

    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const defs = await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(bot.id)!, t.app.ctx.store.thread(th.id)!);
    assert.equal(defs.find((x) => x.name === 'mcp_forwardemail_forwardemail_alias_delete')!.risk, 'danger');
    assert.equal(defs.find((x) => x.name === 'mcp_forwardemail_forwardemail_alias_create')!.risk, 'write');

    await t.api('DELETE', `/mcp/connections/${conn.id}`);
    assert.deepEqual(await t.api('GET', '/mcp/forwardemail'), { account: null, status: 'off', connection: null });
  } finally {
    delete process.env.TEAMBOT_FORWARDEMAIL_BASE;
    await t.close();
    await f.close();
  }
});
