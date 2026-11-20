/** The owner's other mailboxes: connect an address, read what came in and went out, answer from that address. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { mailboxIo, type Mailbox, type MailOut } from '../server/modules/mcp/mailboxes.js';
import { emailDiscovery } from '../server/modules/channels/adapters/email.js';
import { refusal } from '../server/modules/teams/manage.js';

test('a mailbox: connected with its password (never given back), read, searched and answered from its own address', async () => {
  const t = await startTestApp();
  const real = { ...mailboxIo };
  const find = emailDiscovery.find;
  try {
    const seen: { checked: Mailbox[]; sent: [Mailbox, MailOut][]; lists: [string, string, string][] } = { checked: [], sent: [], lists: [] };
    mailboxIo.check = async (b) => {
      if (b.password === 'fout') throw Object.assign(new Error('IMAP: inloggen geweigerd.'), { status: 400 });
      seen.checked.push(b);
    };
    mailboxIo.list = async (b, which, q) => {
      seen.lists.push([b.address, which, q]);
      return [{ id: `${which}:7`, thread: '', from: 'Jan <jan@klant.test>', to: b.address, subject: 'Offerte', date: '2026-11-20T10:00:00.000Z', unread: which === 'inbox', snippet: 'Hallo' }];
    };
    mailboxIo.read = async (b, which, uid) => ({ id: `${which}:${uid}`, thread: '', from: 'Jan <jan@klant.test>', to: b.address, subject: 'Offerte', date: '2026-11-20T10:00:00.000Z', unread: false, snippet: 'Hallo', messageId: '<a1@klant.test>', references: '<a0@klant.test> <a1@klant.test>', attachments: [], body: 'Hallo, graag een offerte.' });
    mailboxIo.send = async (b, o) => (seen.sent.push([b, o]), '<nieuw@zaak.test>');
    emailDiscovery.find = async () => ({ provider: 'Zaak', via: 'test', imapHost: 'imap.zaak.test', imapPort: 993, imapSecure: true, smtpHost: 'smtp.zaak.test', smtpPort: 465, smtpSecure: true }) as any;

    assert.deepEqual((await t.api('GET', '/mcp/mailboxes')).boxes, []);
    await assert.rejects(t.api('POST', '/mcp/mailboxes', { address: 'info@zaak.test', password: '' }), /wachtwoord of app-wachtwoord/);
    await assert.rejects(t.api('POST', '/mcp/mailboxes', { address: 'info@zaak.test', password: 'fout' }), /inloggen geweigerd/);
    const made = await t.api('POST', '/mcp/mailboxes', { address: 'Info@Zaak.test', password: 'geheim-123' });
    assert.equal(made.boxes.length, 1);
    assert.equal(made.boxes[0].address, 'info@zaak.test');
    assert.equal(JSON.stringify(made).includes('geheim-123'), false, 'the password never comes back');
    assert.equal(seen.checked[0].imapHost, 'imap.zaak.test', 'TeamBot found the servers itself');
    // A Gmail address needs no lookup.
    const two = await t.api('POST', '/mcp/mailboxes', { address: 'tweede@gmail.com', password: 'app-wachtwoord' });
    assert.equal(seen.checked[1].imapHost, 'imap.gmail.com');
    await assert.rejects(t.api('POST', '/mcp/mailboxes', { address: 'tweede@gmail.com', password: 'x' }), /al gekoppeld/);
    const id = made.boxes[0].id;

    const inbox = await t.api('GET', `/mcp/mailboxes/${id}/mail?limit=5`);
    assert.equal(inbox.messages[0].subject, 'Offerte');
    await t.api('GET', `/mcp/mailboxes/${id}/mail?box=sent&q=offerte`);
    assert.deepEqual(seen.lists, [['info@zaak.test', 'inbox', ''], ['info@zaak.test', 'sent', 'offerte']]);
    const full = await t.api('GET', `/mcp/mailboxes/${id}/mail/inbox:7`);
    assert.equal(full.body, 'Hallo, graag een offerte.');
    await assert.rejects(t.api('GET', `/mcp/mailboxes/${id}/mail/inbox:x`), /Onbekende mail/);

    await assert.rejects(t.api('POST', `/mcp/mailboxes/${id}/mail/send`, { to: 'geen adres', body: 'Hoi' }), /e-mailadres/);
    const sent = await t.api('POST', `/mcp/mailboxes/${id}/mail/send`, { to: 'jan@klant.test', subject: 'Re: Offerte', body: 'Komt eraan.', inReplyTo: full.messageId, references: full.references });
    assert.equal(sent.ok, true);
    assert.equal(seen.sent[0][0].address, 'info@zaak.test', 'from the address it came in on');
    assert.deepEqual([seen.sent[0][1].to, seen.sent[0][1].inReplyTo], ['jan@klant.test', '<a1@klant.test>']);

    // A bot reads along; connecting or removing a mailbox is the owner's own.
    assert.equal(refusal('GET', `/mcp/mailboxes/${id}/mail`, undefined), null);
    assert.match(refusal('POST', '/mcp/mailboxes', { address: 'x@y.test', password: 'p' }) || '', /koppelt de eigenaar zelf/);
    assert.match(refusal('DELETE', `/mcp/mailboxes/${id}`, undefined) || '', /koppelt de eigenaar zelf/);

    assert.equal((await t.api('DELETE', `/mcp/mailboxes/${two.boxes[1].id}`)).boxes.length, 1);
    await assert.rejects(t.api('GET', '/mcp/mailboxes/mb_bestaatniet/mail'), /niet gekoppeld/);
  } finally {
    Object.assign(mailboxIo, real);
    emailDiscovery.find = find;
    await t.close();
  }
});
