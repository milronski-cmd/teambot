import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { startTestApp } from './helpers.js';
import { TRANSIP_TOOLS, clearTransipTokens, explainTransip, tidyDomain, transipAuthRequest, transipServer } from '../server/modules/mcp/transip.js';
import { getConn } from '../server/modules/mcp/oauth.js';

/**
 * TransIP end to end against a local stand-in (TEAMBOT_TRANSIP_BASE): the signed token request (checked with the
 * public key), keeping the token and getting a new one on 401, the check on save with plain errors, the tools and
 * what they send, and the risks: registering a domain is a payment, DNS changes are outward steps.
 */
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const LOGIN = 'eigenaar';

interface Seen {
  method: string;
  path: string;
  body: string;
  auth: string;
}

async function fakeTransip() {
  const seen: Seen[] = [];
  const state = { valid: new Set<string>(), auths: 0, refuse: '' as '' | 'ip' | 'api', nonces: new Set<string>() };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://x');
      const p = url.pathname;
      seen.push({ method: req.method || '', path: p + url.search, body, auth: String(req.headers.authorization || '') });
      const json = (code: number, v?: any) => (res.writeHead(code, v === undefined ? {} : { 'content-type': 'application/json' }), res.end(v === undefined ? '' : JSON.stringify(v)));
      if (p === '/auth' && req.method === 'POST') {
        const sig = String(req.headers.signature || '');
        const ok = !!sig && crypto.verify('RSA-SHA512', Buffer.from(body), keys.publicKey, Buffer.from(sig, 'base64'));
        if (!ok) return json(401, { error: 'Signature is not valid' });
        const b = JSON.parse(body);
        if (b.login !== LOGIN) return json(401, { error: `Login '${b.login}' not found` });
        if (state.refuse === 'ip') return json(401, { error: 'Your IP address 203.0.113.9 is not whitelisted for this key' });
        if (state.refuse === 'api') return json(401, { error: 'The API is disabled for this account' });
        assert.ok(String(b.nonce).length >= 8 && !state.nonces.has(b.nonce), 'a fresh nonce of 8 or more characters');
        state.nonces.add(b.nonce);
        assert.deepEqual([b.read_only, b.expiration_time, b.global_key, /^TeamBot /.test(b.label)], [false, '30 minutes', false, true]);
        state.auths++;
        const token = `tok-${state.auths}`;
        state.valid.add(token);
        return json(200, { token });
      }
      if (!state.valid.has(String(req.headers.authorization || '').replace(/^Bearer /, ''))) return json(401, { error: 'Token is expired' });
      if (p === '/domains' && req.method === 'GET')
        return json(200, { domains: [{ name: 'voorbeeld.nl', authCode: 'GEHEIM-AUTH-123', isTransferLocked: false, registrationDate: '2020-01-01', renewalDate: '2027-01-01', tags: ['shop'] }] });
      if (p === '/domains/voorbeeld.nl' && req.method === 'GET') {
        assert.equal(url.searchParams.get('include'), 'nameservers,contacts');
        return json(200, { domain: { name: 'voorbeeld.nl', authCode: 'GEHEIM-AUTH-123', renewalDate: '2027-01-01', nameservers: [{ hostname: 'ns0.transip.net', ipv4: '', ipv6: '' }], contacts: [{ type: 'registrant', firstName: 'Jan', lastName: 'Jansen', companyName: 'Voorbeeld BV', email: 'jan@voorbeeld.nl', country: 'nl', phoneNumber: '+31 6 1234' }] } });
      }
      if (p === '/domain-availability/nieuw.nl') return json(200, { availability: { domainName: 'nieuw.nl', status: 'free', actions: ['register'] } });
      if (p === '/domain-availability' && req.method === 'GET') return json(200, { availability: JSON.parse(body).domainNames.map((n: string) => ({ domainName: n, status: n === 'voorbeeld.nl' ? 'inyouraccount' : 'free', actions: [] })) });
      if (p === '/domains' && req.method === 'POST') return json(201);
      if (p === '/domains/voorbeeld.nl/dns' && req.method === 'GET') return json(200, { dnsEntries: [{ name: '@', expire: 86400, type: 'A', content: '192.0.2.1' }] });
      if (p === '/domains/voorbeeld.nl/dns') return json(req.method === 'POST' ? 201 : 204);
      if (p === '/domains/voorbeeld.nl/nameservers' && req.method === 'PUT') return json(204);
      json(404, { error: `geen nep-antwoord voor ${req.method} ${p}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('transip: the signed token request, a domain as a bot reads it, and errors in plain words', () => {
  const { body, signature } = transipAuthRequest({ login: LOGIN, privateKey: PEM });
  assert.ok(crypto.verify('RSA-SHA512', Buffer.from(body), keys.publicKey, Buffer.from(signature, 'base64')), 'signed over the exact JSON text');
  const b = JSON.parse(body);
  assert.deepEqual(Object.keys(b), ['login', 'nonce', 'read_only', 'expiration_time', 'label', 'global_key']);
  assert.ok(b.nonce.length >= 8);
  assert.notEqual(JSON.parse(transipAuthRequest({ login: LOGIN, privateKey: PEM }).body).nonce, b.nonce, 'a new nonce every time');
  const t = tidyDomain({ name: 'a.nl', authCode: 'X', renewalDate: '2027-01-01' });
  assert.equal(t.name, 'a.nl');
  assert.ok(!JSON.stringify(t).includes('authCode'), 'the auth code never reaches a bot');
  assert.match(explainTransip(401, 'Your IP address 1.2.3.4 is not whitelisted', true), /whitelist van je API-sleutel/);
  assert.match(explainTransip(401, 'The API is disabled for this account', true), /API staat uit/);
  assert.match(explainTransip(401, 'Signature is not valid', true), /inlognaam en sleutel niet aan/);
  assert.deepEqual(
    Object.fromEntries(TRANSIP_TOOLS.map((x) => [x.name, x.kind])),
    {
      transip_domains: 'read', transip_domain: 'read', transip_domain_available: 'read', transip_domain_register: 'send', transip_dns: 'read', transip_dns_add: 'send', transip_dns_update: 'send', transip_dns_delete: 'send', transip_dns_replace: 'send', transip_nameservers_set: 'send',
    },
  );
  assert.match(TRANSIP_TOOLS.find((x) => x.name === 'transip_dns_replace')!.description, /vervangt ALLE DNS-records/);
});

test('transip: set up with login and key, the bots use the tools, token kept and renewed on 401', async () => {
  const f = await fakeTransip();
  process.env.TEAMBOT_TRANSIP_BASE = f.base;
  clearTransipTokens();
  const t = await startTestApp({ mode: 'desktop' });
  try {
    const bot = await t.agent({ name: 'Webbeheer' });
    assert.deepEqual(await t.api('GET', '/mcp/transip'), { account: null, status: 'off', connection: null });
    // Wrong input is refused before anything is stored, each with what to do.
    await assert.rejects(t.api('PUT', '/mcp/transip', { login: LOGIN, privateKey: 'geen sleutel' }), /geen geldige privésleutel/);
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await assert.rejects(t.api('PUT', '/mcp/transip', { login: LOGIN, privateKey: other }), /inlognaam en sleutel niet aan/);
    await assert.rejects(t.api('PUT', '/mcp/transip', { login: 'iemand-anders', privateKey: PEM }), /inlognaam en sleutel niet aan/);
    f.state.refuse = 'ip';
    await assert.rejects(t.api('PUT', '/mcp/transip', { login: LOGIN, privateKey: PEM }), /niet op de whitelist/);
    f.state.refuse = 'api';
    await assert.rejects(t.api('PUT', '/mcp/transip', { login: LOGIN, privateKey: PEM }), /API staat uit/);
    f.state.refuse = '';
    assert.equal((await t.api('GET', '/mcp/transip')).account, null);

    const s = await t.api('PUT', '/mcp/transip', { login: LOGIN, privateKey: PEM });
    assert.deepEqual(s.account, { login: LOGIN });
    assert.equal(s.status, 'on');
    assert.ok(!JSON.stringify(s).includes('PRIVATE KEY'), 'the key never comes back');
    assert.ok(f.seen.some((x) => x.path === '/domains?pageSize=1'), 'checked with one real read');
    const conn = s.connection;
    assert.equal(conn.transport, 'builtin');
    assert.deepEqual(conn.agents, [bot.id], 'bound to the bots at once');
    assert.ok(conn.verified_at);
    const risk = Object.fromEntries(conn.tools.map((x: any) => [x.name, x.risk]));
    assert.equal(risk.transip_domains, 'read');
    assert.equal(risk.transip_dns, 'read');
    for (const n of ['transip_domain_register', 'transip_dns_add', 'transip_dns_update', 'transip_dns_delete', 'transip_dns_replace', 'transip_nameservers_set']) assert.equal(risk[n], 'danger', n);
    assert.ok(conn.tools.every((x: any) => x.approved), 'usable at once');

    // Reading: the auth code stays hidden; the token from the check is used again.
    const r = await t.api('POST', `/mcp/connections/${conn.id}/test`, { tool: 'transip_domains', args: {} });
    assert.match(r.sample.text, /voorbeeld\.nl/);
    assert.match(r.sample.text, /2027-01-01/);
    assert.ok(!r.sample.text.includes('GEHEIM-AUTH'));
    const one = await t.api('POST', `/mcp/connections/${conn.id}/test`, { tool: 'transip_domain', args: { domain: 'voorbeeld.nl' } });
    assert.match(one.sample.text, /ns0\.transip\.net/);
    assert.match(one.sample.text, /Voorbeeld BV/);
    assert.ok(!one.sample.text.includes('GEHEIM-AUTH') && !one.sample.text.includes('+31 6'), 'contacts in short');
    assert.equal(f.state.auths, 1, 'one token for all these calls');

    // The token ends early: one new token, and the call still works.
    f.state.valid.clear();
    const again = await t.api('POST', `/mcp/connections/${conn.id}/test`, { tool: 'transip_dns', args: { domain: 'voorbeeld.nl' } });
    assert.match(again.sample.text, /192\.0\.2\.1/);
    assert.equal(again.sample.isError, false);
    assert.equal(f.state.auths, 2, 'a new token after the 401');

    // The tools that change things, straight on the built-in server: the routes and bodies TransIP expects.
    const client = new Client({ name: 'test', version: '1' });
    const [mine, theirs] = InMemoryTransport.createLinkedPair();
    await transipServer(t.app.ctx, getConn(t.app.ctx, conn.id)!).connect(theirs);
    await client.connect(mine);
    const call = async (name: string, args: any) => {
      const res: any = await client.callTool({ name, arguments: args });
      assert.ok(!res.isError, `${name}: ${res.content?.[0]?.text}`);
      return JSON.parse(res.content[0].text);
    };
    const last = () => f.seen.at(-1)!;
    const entry = { name: '@', expire: 300, type: 'MX', content: '10 mx1.forwardemail.net.' };
    assert.equal((await call('transip_domain_available', { domain: 'nieuw.nl' })).availability[0].status, 'free');
    const many = await call('transip_domain_available', { domains: ['nieuw.nl', 'voorbeeld.nl'] });
    assert.deepEqual(JSON.parse(last().body), { domainNames: ['nieuw.nl', 'voorbeeld.nl'] }, 'a list goes as domainNames');
    assert.equal(many.availability[1].status, 'inyouraccount');
    await call('transip_dns_add', { domain: 'voorbeeld.nl', entry });
    assert.deepEqual([last().method, last().path, JSON.parse(last().body)], ['POST', '/domains/voorbeeld.nl/dns', { dnsEntry: entry }]);
    await call('transip_dns_update', { domain: 'voorbeeld.nl', entry: { ...entry, content: '20 mx2.forwardemail.net.' } });
    assert.deepEqual([last().method, JSON.parse(last().body).dnsEntry.content], ['PATCH', '20 mx2.forwardemail.net.']);
    await call('transip_dns_delete', { domain: 'voorbeeld.nl', entry });
    assert.deepEqual([last().method, last().path, JSON.parse(last().body)], ['DELETE', '/domains/voorbeeld.nl/dns', { dnsEntry: entry }]);
    await call('transip_dns_replace', { domain: 'voorbeeld.nl', entries: [entry] });
    assert.deepEqual([last().method, JSON.parse(last().body)], ['PUT', { dnsEntries: [entry] }]);
    await call('transip_nameservers_set', { domain: 'voorbeeld.nl', nameservers: [{ hostname: 'ns1.voorbeeld.nl' }] });
    assert.deepEqual([last().method, last().path, JSON.parse(last().body)], ['PUT', '/domains/voorbeeld.nl/nameservers', { nameservers: [{ hostname: 'ns1.voorbeeld.nl' }] }]);
    await call('transip_domain_register', { domain: 'Nieuw.nl' });
    assert.deepEqual([last().method, last().path, JSON.parse(last().body)], ['POST', '/domains', { domainName: 'nieuw.nl' }]);
    const bad: any = await client.callTool({ name: 'transip_domain', arguments: { domain: 'onbekend.nl' } });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /TransIP gaf een fout: Niet gevonden/);
    await client.close();
    assert.ok(f.seen.filter((x) => x.path !== '/auth').every((x) => /^Bearer tok-\d$/.test(x.auth)), 'every call with the token');

    // What a bot gets: registering is a payment (asks on every access level), DNS changes are outward steps.
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const defs = await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(bot.id)!, t.app.ctx.store.thread(th.id)!);
    const def = (n: string) => defs.find((x) => x.name === `mcp_transip_${n}`)!;
    assert.equal(def('transip_domain_register').risk, 'danger');
    assert.equal(def('transip_domain_register').impact, 'payment');
    assert.equal(def('transip_dns_add').risk, 'danger');
    assert.equal(def('transip_dns_add').impact, undefined, 'an outward step: asks unless outward steps are allowed');
    assert.equal(def('transip_domains').risk, 'read');

    // Forgetting the key: nothing left to sign with.
    await t.api('DELETE', `/mcp/connections/${conn.id}`);
    assert.deepEqual(await t.api('GET', '/mcp/transip'), { account: null, status: 'off', connection: null });
  } finally {
    delete process.env.TEAMBOT_TRANSIP_BASE;
    await t.close();
    await f.close();
  }
});
