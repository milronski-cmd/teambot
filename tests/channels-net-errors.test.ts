// Connection errors of chat channels in plain words (practice test 0.4.4): "IMAP: connect ECONNREFUSED 127.0.0.1:9"
// became "IMAP: de server weigert de verbinding op poort 9. Controleer de IMAP-server en de poort: …".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { netReason } from '../server/modules/channels/net.js';
import { friendlyMailError } from '../server/modules/channels/adapters/email.js';

/** A port on this computer where nothing listens. */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('connection errors in plain words', () => {
  assert.equal(netReason({ code: 'ECONNREFUSED', address: '127.0.0.1', port: 993 }), 'de server weigert de verbinding op poort 993');
  assert.equal(netReason(new Error('connect ECONNREFUSED 10.0.0.5:587')), 'de server weigert de verbinding op poort 587');
  assert.equal(netReason({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND imap.voorbeeld.nl' }), 'de server is niet gevonden (klopt het adres, en is er internet?)');
  assert.equal(netReason({ message: 'fetch failed', cause: { code: 'ECONNRESET' } }), 'de server verbrak de verbinding');
  assert.equal(netReason({ code: 'ETIMEDOUT' }), 'de server reageert niet (time-out)');
  assert.equal(netReason(new Error('140:error:0A00010B:SSL routines::wrong version number')), 'de beveiligde verbinding (TLS) lukt niet');
  assert.equal(netReason({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' }), 'de beveiligde verbinding (TLS) lukt niet');
  assert.equal(netReason(new Error('Mailbox does not exist')), null, 'not a connection problem');
});

test('e-mail: a closed IMAP or SMTP port says what to check, a refused login stays a login problem', async () => {
  const port = await closedPort();
  const imap = new ImapFlow({ host: '127.0.0.1', port, secure: false, auth: { user: 'bot@voorbeeld.nl', pass: 'x' }, logger: false, connectionTimeout: 5000 });
  imap.on('error', () => {});
  const ie = await imap.connect().then(() => null, (e) => e);
  assert.ok(ie, 'connecting to a closed port fails');
  const im = friendlyMailError(ie, 'IMAP').message;
  assert.match(im, new RegExp(`^IMAP: de server weigert de verbinding op poort ${port}\\. Controleer de IMAP-server en de poort: IMAP is meestal poort 993 met TLS\\.$`));
  assert.doesNotMatch(im, /ECONNREFUSED/);
  const se = await nodemailer
    .createTransport({ host: '127.0.0.1', port, secure: false, connectionTimeout: 5000 })
    .verify()
    .then(() => null, (e) => e);
  const sm = friendlyMailError(se, 'SMTP').message;
  assert.match(sm, /^SMTP: de server weigert de verbinding op poort \d+\. Controleer de SMTP-server en de poort: SMTP is meestal poort 465 met TLS of 587 met STARTTLS \(TLS uit\)\.$/);
  const login = friendlyMailError({ authenticationFailed: true, message: 'Invalid credentials (Failure)' }, 'IMAP');
  assert.match(login.message, /inloggen geweigerd/);
  assert.equal(login.fatal, true);
});
