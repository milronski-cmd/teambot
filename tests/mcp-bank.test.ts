import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestApp } from './helpers.js';
import { BANK_TOOLS, bankToken, clearBankCache, maskIban, tidyBalances, tidyTransaction } from '../server/modules/mcp/bank.js';

/**
 * The bank connection end to end against a local stand-in for Enable Banking (TEAMBOT_BANK_BASE): the application is
 * checked, a bank is chosen, the owner gives permission "at the bank" and comes back with a code, and the bots read
 * balances and transactions. Reading only.
 */
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APP_ID = '1a2b3c4d-1234-5678-9abc-1a2b3c4d5e6f';

async function fakeBank() {
  const seen: { method: string; path: string; body: string }[] = [];
  const state = { rateLimited: false, expired: false, deleted: [] as string[] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://x');
      const p = url.pathname;
      seen.push({ method: req.method || '', path: p + url.search, body });
      const json = (code: number, v: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
      // The token: signed by the application's key, with its id as kid.
      const [h, c, sig] = String(req.headers.authorization || '').replace(/^Bearer /, '').split('.');
      let head: any = {};
      try {
        head = JSON.parse(Buffer.from(h || '', 'base64url').toString());
      } catch {
        /* no token */
      }
      const okSig = !!sig && crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), keys.publicKey, Buffer.from(sig, 'base64url'));
      if (head.kid !== APP_ID || !okSig) return json(401, { error: 'UNAUTHORIZED_ACCESS', message: 'Unknown application', code: 401 });
      if (p === '/aspsps') return json(200, { aspsps: [{ name: 'Testbank', country: url.searchParams.get('country'), logo: 'https://x/logo.png', psu_types: ['personal', 'business'], auth_methods: [], maximum_consent_validity: 180 * 86400, beta: false }] });
      if (p === '/auth' && req.method === 'POST') {
        const b = JSON.parse(body);
        if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/public\/mcp\/bank\/callback$/.test(b.redirect_url) && b.redirect_url !== 'https://oud.voorbeeld.nl/terug') return json(400, { error: 'REDIRECT_URI_NOT_ALLOWED', message: 'Redirect URI not allowed', code: 400 });
        return json(200, { url: `https://auth.enablebanking.com/ais/start?sessionid=s1&state=${b.state}`, authorization_id: 'a1' });
      }
      if (p === '/sessions' && req.method === 'POST') {
        if (JSON.parse(body).code !== 'code-1') return json(400, { error: 'WRONG_AUTHORIZATION_CODE', message: 'Wrong code', code: 400 });
        return json(200, {
          session_id: 'sess-1',
          aspsp: { name: 'Testbank', country: 'NL' },
          access: { valid_until: new Date(Date.now() + 180 * 86400_000).toISOString() },
          accounts: [
            { uid: 'acc-1', account_id: { iban: 'NL91ABNA0417164300' }, name: 'Zakelijke rekening', currency: 'EUR' },
            { uid: 'acc-2', account_id: { iban: 'NL02RABO0123456789' }, name: 'Spaarrekening', currency: 'EUR' },
          ],
        });
      }
      if (req.method === 'DELETE' && p.startsWith('/sessions/')) return (state.deleted.push(p.split('/')[2]), json(200, { message: 'OK' }));
      if (state.expired) return json(401, { error: 'EXPIRED_SESSION', message: 'Session expired', code: 401 });
      if (state.rateLimited) return json(429, { error: 'ASPSP_RATE_LIMIT_EXCEEDED', message: 'Rate limit', code: 429 });
      if (p === '/accounts/acc-1/balances') return json(200, { balances: [{ name: 'Available', balance_amount: { currency: 'EUR', amount: '1500.10' }, balance_type: 'ITAV' }, { name: 'Booked', balance_amount: { currency: 'EUR', amount: '1234.56' }, balance_type: 'CLBD', reference_date: '2026-11-19' }] });
      if (p === '/accounts/acc-2/balances') return json(200, { balances: [{ name: 'Booked', balance_amount: { currency: 'EUR', amount: '9000.00' }, balance_type: 'CLBD' }] });
      if (p === '/accounts/acc-1/transactions') {
        if (!url.searchParams.get('continuation_key'))
          return json(200, { continuation_key: 'k2', transactions: [{ entry_reference: 'r1', transaction_amount: { currency: 'EUR', amount: '59.00' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: '2026-11-18', creditor: { name: 'TransIP B.V.' }, creditor_account: { iban: 'NL00TEST0000000001' }, remittance_information: ['Factuur', '2026-118'] }] });
        return json(200, { continuation_key: null, transactions: [{ entry_reference: 'r2', transaction_amount: { currency: 'EUR', amount: '250.00' }, credit_debit_indicator: 'CRDT', status: 'BOOK', booking_date: '2026-11-19', debtor: { name: 'Klant B.V.' }, debtor_account: { iban: 'NL00TEST0000000002' }, remittance_information: ['Order 2041'] }] });
      }
      json(404, { error: 'NOT_FOUND', message: `geen nep-antwoord voor ${p}`, code: 404 });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('bank: the token, and money as a bot reads it', () => {
  const [h, c, sig] = bankToken({ appId: APP_ID, privateKey: PEM }, 1_800_000_000_000).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'RS256', kid: APP_ID });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: 1_800_000_000, exp: 1_800_003_600 });
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), keys.publicKey, Buffer.from(sig, 'base64url')));
  assert.equal(maskIban('NL91ABNA0417164300'), 'NL91 •••• 4300');
  // Booked comes first, whatever order the bank gives.
  assert.deepEqual(tidyBalances({ balances: [{ balance_amount: { currency: 'EUR', amount: '5' }, balance_type: 'ITAV' }, { balance_amount: { currency: 'EUR', amount: '4' }, balance_type: 'CLBD' }] }).map((b) => [b.name, b.amount]), [['geboekt', 4], ['beschikbaar', 5]]);
  // Money out is negative and names who got it; money in is positive and names who paid.
  const out = tidyTransaction({ transaction_amount: { currency: 'EUR', amount: '59.00' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: '2026-11-18', creditor: { name: 'TransIP' }, debtor: { name: 'Ik' }, remittance_information: ['Factuur', '118'] });
  assert.deepEqual([out.amount, out.counterparty, out.description, out.status], [-59, 'TransIP', 'Factuur 118', 'geboekt']);
  const inn = tidyTransaction({ transaction_amount: { currency: 'EUR', amount: '250' }, credit_debit_indicator: 'CRDT', status: 'PDNG', debtor: { name: 'Klant' }, creditor: { name: 'Ik' } });
  assert.deepEqual([inn.amount, inn.counterparty, inn.status], [250, 'Klant', 'in behandeling']);
  // There is no tool that pays or changes anything.
  assert.deepEqual(BANK_TOOLS.map((t) => t.name), ['bank_accounts', 'bank_balances', 'bank_transactions']);
});

test('bank: set up, give permission at the bank, and the bots read balances and transactions', async () => {
  const g = await fakeBank();
  process.env.TEAMBOT_BANK_BASE = g.base;
  clearBankCache();
  const t = await startTestApp({ mode: 'desktop' });
  try {
    assert.equal((await t.api('GET', '/mcp/bank')).status, 'off');
    assert.deepEqual(await t.api('GET', '/mcp/bank/overview'), { status: 'off', accounts: [], transactions: [] }, 'not connected: an empty overview, no error');
    // A wrong key or id is refused before anything is stored.
    await assert.rejects(t.api('PUT', '/mcp/bank/app', { appId: 'geen-id', privateKey: PEM }), /geen applicatie-ID/);
    await assert.rejects(t.api('PUT', '/mcp/bank/app', { appId: APP_ID, privateKey: 'geen sleutel' }), /geen geldige sleutel/);
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await assert.rejects(t.api('PUT', '/mcp/bank/app', { appId: APP_ID, privateKey: other }), /nam deze gegevens niet aan/);
    assert.equal((await t.api('GET', '/mcp/bank')).app, null);
    const s0 = await t.api('PUT', '/mcp/bank/app', { appId: APP_ID, privateKey: PEM });
    assert.deepEqual(s0.app, { appId: APP_ID });
    assert.ok(!JSON.stringify(s0).includes('PRIVATE KEY'), 'the key never comes back');
    assert.match(s0.redirectUrl, /\/api\/public\/mcp\/bank\/callback$/);

    const banks = (await t.api('GET', '/mcp/bank/banks?country=nl')).banks;
    assert.deepEqual(banks.map((b: any) => [b.name, b.country, b.days]), [['Testbank', 'NL', 180]]);

    const { url, state } = await t.api('POST', '/mcp/bank/link', { bank: 'Testbank', country: 'NL' });
    assert.match(url, /^https:\/\/auth\.enablebanking\.com\//);
    const sent = JSON.parse(g.seen.find((x) => x.path === '/auth')!.body);
    assert.equal(sent.psu_type, 'personal');
    assert.equal(sent.aspsp.name, 'Testbank');
    // Saying no at the bank is told plainly, and the link can be used again after it.
    const cb = `${s0.redirectUrl}`;
    const no = await fetch(`${cb}?error=access_denied&state=${state}`);
    assert.equal(no.status, 400);
    assert.match(await no.text(), /geen toestemming gegeven/);
    const yes = await fetch(`${cb}?code=code-1&state=${state}`);
    assert.equal(yes.status, 200);
    assert.match(await yes.text(), /Testbank is gekoppeld/);
    assert.equal((await fetch(`${cb}?code=code-1&state=${state}`)).status, 400, 'a code works once');

    const s = await t.api('GET', '/mcp/bank');
    assert.equal(s.status, 'on');
    assert.deepEqual(s.links[0].accounts.map((x: any) => x.iban), ['NL91 •••• 4300', 'NL02 •••• 6789'], 'the screen shows masked numbers');
    const id = s.connection.id;
    const call = async (tool: string, args: any = {}) => JSON.stringify(await t.api('POST', `/mcp/connections/${id}/test`, { tool, args }));
    const tools = (await t.api('POST', `/mcp/connections/${id}/test`, {})).connection.tools;
    assert.deepEqual(tools.map((x: any) => x.name).sort(), ['bank_accounts', 'bank_balances', 'bank_transactions']);
    assert.ok(tools.every((x: any) => x.risk === 'read'), 'reading only');

    assert.match(await call('bank_accounts'), /NL91ABNA0417164300/);
    const bal = await call('bank_balances');
    assert.match(bal, /1234\.56/);
    assert.match(bal, /9000/);
    const before = g.seen.length;
    await call('bank_balances', { account: '4300' });
    assert.equal(g.seen.length, before, 'asked again within a quarter of an hour: not sent to the bank again');
    const tx = await call('bank_transactions', { account: 'NL91ABNA0417164300', from: '2026-11-01', to: '2026-11-20' });
    assert.match(tx, /TransIP B\.V\./);
    assert.match(tx, /-59/);
    assert.match(tx, /Klant B\.V\./, 'the second page too');
    assert.match(tx, /\\"bij\\": 250/);
    assert.match(await call('bank_transactions', { account: 'bestaat-niet' }).catch((e) => String(e)), /Geen gekoppelde rekening/);

    // What the bank refuses is said in plain words.
    clearBankCache();
    g.state.rateLimited = true;
    assert.match(await call('bank_balances').catch((e) => String(e)), /vier keer per dag/);
    g.state.rateLimited = false;
    g.state.expired = true;
    assert.match(await call('bank_balances').catch((e) => String(e)), /verlopen of ingetrokken/);
    g.state.expired = false;

    // The money on the dashboard: balances per account and the latest transactions, with masked numbers.
    clearBankCache();
    const o = await t.api('GET', '/mcp/bank/overview');
    assert.equal(o.status, 'on');
    assert.deepEqual(o.accounts.map((x: any) => [x.name, x.iban, x.balances?.[0]?.amount]), [['Zakelijke rekening', 'NL91 •••• 4300', 1234.56], ['Spaarrekening', 'NL02 •••• 6789', 9000]]);
    assert.ok(!JSON.stringify(o).includes('NL91ABNA0417164300'), 'never the whole number on the screen');
    assert.ok(o.transactions.some((x: any) => x.counterparty === 'TransIP B.V.' && x.amount === -59 && x.account === 'Zakelijke rekening'));

    // Taking the bank away ends the permission at the bank too.
    const gone = await t.api('POST', '/mcp/bank/unlink', { bank: 'Testbank', country: 'NL' });
    assert.equal(gone.status, 'off');
    assert.deepEqual(g.state.deleted, ['sess-1']);
  } finally {
    delete process.env.TEAMBOT_BANK_BASE;
    await t.close();
    await g.close();
  }
});

test('bank: an application made earlier for another program: paste the address the bank sent you to', async () => {
  const g = await fakeBank();
  process.env.TEAMBOT_BANK_BASE = g.base;
  clearBankCache();
  const t = await startTestApp({ mode: 'desktop' });
  try {
    const s0 = await t.api('PUT', '/mcp/bank/app', { appId: APP_ID, privateKey: PEM, redirectUrl: 'https://oud.voorbeeld.nl/terug' });
    assert.equal(s0.redirectUrl, 'https://oud.voorbeeld.nl/terug');
    assert.match(s0.ownRedirectUrl, /\/api\/public\/mcp\/bank\/callback$/);
    const { state } = await t.api('POST', '/mcp/bank/link', { bank: 'Testbank', country: 'NL', business: true });
    const sent = JSON.parse(g.seen.filter((x) => x.path === '/auth').pop()!.body);
    assert.equal(sent.redirect_url, 'https://oud.voorbeeld.nl/terug');
    assert.equal(sent.psu_type, 'business');
    await assert.rejects(t.api('POST', '/mcp/bank/finish', { url: 'geen adres' }), /Plak het hele adres/);
    const s = await t.api('POST', '/mcp/bank/finish', { url: `https://oud.voorbeeld.nl/terug?code=code-1&state=${state}` });
    assert.equal(s.status, 'on');
    assert.equal(s.links[0].bank, 'Testbank');
  } finally {
    delete process.env.TEAMBOT_BANK_BASE;
    await t.close();
    await g.close();
  }
});
