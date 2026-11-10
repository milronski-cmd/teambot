// Koppelen in één keer (channels): a refused token never becomes a channel, a good one is tested before it is saved,
// and e-mail needs only an address and a password because TeamBot finds the mail servers itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp } from './helpers.js';
import { discoverMail, knownByDomain, parseAutoconfig, type DiscoveryDeps } from '../server/modules/channels/email-auto.js';
import { emailAdapter, emailDiscovery } from '../server/modules/channels/adapters/email.js';
import { ADAPTER_ORDER, MORE_ADAPTERS } from '../ui/src/modules/channels/picker.js';

const none: DiscoveryDeps = { mx: async () => [], srv: async () => [], text: async () => '', open: async () => false };

test('mail servers from an address: known domains need no network', async () => {
  const boom: DiscoveryDeps = { mx: () => Promise.reject(new Error('no network')), srv: () => Promise.reject(new Error('x')), text: () => Promise.reject(new Error('x')), open: () => Promise.reject(new Error('x')) };
  const g = await discoverMail('Bot@Gmail.com', boom);
  assert.deepEqual([g?.imapHost, g?.imapPort, g?.smtpHost, g?.smtpPort, g?.smtpSecure, g?.provider, g?.via], ['imap.gmail.com', 993, 'smtp.gmail.com', 465, true, 'Gmail', 'domein']);
  const z = await discoverMail('jan@ziggo.nl', boom);
  assert.deepEqual([z?.imapHost, z?.smtpHost, z?.smtpPort, z?.smtpSecure], ['imap.ziggo.nl', 'smtp.ziggo.nl', 587, false]);
  assert.equal((await discoverMail('piet@kpnmail.nl', boom))?.provider, 'KPN');
  assert.equal(knownByDomain('x@icloud.com')?.name, 'iCloud');
  assert.equal(await discoverMail('geen-adres', boom), null);
});

test('mail servers from an address: own domain by MX, SRV, autoconfig, then a look at imap./smtp.', async () => {
  // Google Workspace and TransIP on an own domain: the MX record tells.
  assert.equal((await discoverMail('bot@bakkerij.nl', { ...none, mx: async () => ['aspmx.l.google.com'] }))?.imapHost, 'imap.gmail.com');
  const tr = await discoverMail('bot@winkel.nl', { ...none, mx: async () => ['mx1.transip.email'] });
  assert.deepEqual([tr?.provider, tr?.via, tr?.smtpHost], ['TransIP', 'mx', 'smtp.transip.email']);
  // RFC 6186 SRV records.
  const srv = await discoverMail('bot@eigen.nl', {
    ...none,
    srv: async (n) => (n.startsWith('_imaps.') ? [{ name: 'mail.eigen.nl', port: 993 }] : n.startsWith('_submission.') ? [{ name: 'uit.eigen.nl', port: 587 }] : []),
  });
  assert.deepEqual([srv?.imapHost, srv?.smtpHost, srv?.smtpPort, srv?.smtpSecure, srv?.via], ['mail.eigen.nl', 'uit.eigen.nl', 587, false, 'srv']);
  // Thunderbird's autoconfig file.
  const xml = `<clientConfig><emailProvider id="x"><incomingServer type="pop3"><hostname>pop.x.nl</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
    <incomingServer type="imap"><hostname>imap.x.nl</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.x.nl</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer></emailProvider></clientConfig>`;
  assert.deepEqual(parseAutoconfig(xml), { imapHost: 'imap.x.nl', imapPort: 993, imapSecure: true, smtpHost: 'smtp.x.nl', smtpPort: 587, smtpSecure: false });
  assert.equal(parseAutoconfig('<html>404</html>'), null);
  const seen: string[] = [];
  const ac = await discoverMail('bot@x.nl', { ...none, text: async (u) => (seen.push(u), u.includes('thunderbird') ? xml : '') });
  assert.equal(ac?.via, 'autoconfig');
  assert.deepEqual(seen, ['https://autoconfig.x.nl/mail/config-v1.1.xml', 'https://autoconfig.thunderbird.net/v1.1/x.nl']);
  // Last: which of the usual names answer.
  const guess = await discoverMail('bot@klein.nl', { ...none, open: async (h, p) => h === 'mail.klein.nl' && (p === 993 || p === 587) });
  assert.deepEqual([guess?.imapHost, guess?.smtpHost, guess?.smtpPort, guess?.smtpSecure, guess?.via], ['mail.klein.nl', 'mail.klein.nl', 587, false, 'gok']);
  assert.equal(await discoverMail('bot@niks.nl', none), null);
});

test('e-mail channel with only an address: the adapter fills in the servers, or says where to type them', async () => {
  const real = emailDiscovery.find;
  try {
    emailDiscovery.find = async () => ({ imapHost: 'imap.transip.email', imapPort: 993, imapSecure: true, smtpHost: 'smtp.transip.email', smtpPort: 465, smtpSecure: true, provider: 'TransIP', via: 'mx' });
    const c = await emailAdapter.validate({ preset: 'auto', address: 'Bot@Winkel.nl' }, { role: 'owner', secrets: { password: true }, isNew: true });
    assert.deepEqual([c.preset, c.address, c.username, c.imapHost, c.smtpHost, c.smtpPort], ['custom', 'bot@winkel.nl', 'bot@winkel.nl', 'imap.transip.email', 'smtp.transip.email', 465]);
    assert.equal('provider' in c || 'via' in c, false);
    emailDiscovery.find = async () => null;
    await assert.rejects(() => Promise.resolve(emailAdapter.validate({ preset: 'auto', address: 'bot@niks.nl' }, { role: 'owner', secrets: { password: true }, isNew: true })), /vond de mailservers van niks\.nl niet.*Meer opties/);
  } finally {
    emailDiscovery.find = real;
  }
});

test('verify on create: a refused Telegram token never becomes a channel; a good one is saved with the name of the bot', async () => {
  const good = '123456789:' + 'A'.repeat(35);
  const bad = '987654321:' + 'B'.repeat(35);
  const server = http.createServer((req, res) => {
    const m = (req.url || '').match(/^\/bot([^/]+)\/(\w+)/);
    res.setHeader('content-type', 'application/json');
    if (!m || m[1] !== good) return void ((res.statusCode = 401), res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })));
    if (m[2] === 'getMe') return void res.end(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, first_name: 'TB', username: 'tb_test_bot' } }));
    if (m[2] === 'getUpdates') return void setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 100);
    res.end(JSON.stringify({ ok: true, result: true }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const apiBase = `http://127.0.0.1:${(server.address() as any).port}`;
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Baas' });
    const refused = await fetch(`${t.app.url}/api/channels/bindings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ adapter: 'telegram', name: 'Baas via Telegram', agent_id: bot.id, config: { apiBase }, secrets: { token: bad }, verify: true }),
    });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as any).error, /Telegram weigert de bot-token/);
    assert.equal((await t.api('GET', '/channels/bindings')).length, 0, 'no half-made channel is left behind');

    const b = await t.api('POST', '/channels/bindings', { adapter: 'telegram', name: 'Baas via Telegram', agent_id: bot.id, config: { apiBase }, secrets: { token: good }, verify: true });
    assert.equal(b.tested.ok, true);
    assert.equal(b.info.botUsername, 'tb_test_bot');
    // The owner's one-time link is ready at once: open Telegram, press Start.
    const pair = await t.api('POST', `/channels/bindings/${b.id}/pair-codes`, { owner: true, label: 'Dit ben ik' });
    assert.match(pair.deepLink, /^https:\/\/t\.me\/tb_test_bot\?start=/);
    await t.api('DELETE', `/channels/bindings/${b.id}`);
  } finally {
    await t.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the picker: Telegram, WhatsApp (QR) and e-mail first; WhatsApp Business behind Meer opties', () => {
  assert.deepEqual(ADAPTER_ORDER.slice(0, 3), ['telegram', 'whatsapp-web', 'email']);
  assert.deepEqual(MORE_ADAPTERS, ['whatsapp']);
});
