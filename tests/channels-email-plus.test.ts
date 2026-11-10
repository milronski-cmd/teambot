import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { startTestApp } from './helpers.js';
import channels from '../server/modules/channels/index.js';
import { botTag, botTags, plusAddress, plusTagOf } from '../server/modules/channels/email-util.js';
import { emailAdapter, emailTransport, mailToInbound } from '../server/modules/channels/adapters/email.js';
import type { AdapterDef } from '../server/modules/channels/types.js';

// An e-mail address per bot (0.4.4, P10): plus addressing on the owner's own mailbox. Mail to you+baas@… goes to Baas,
// the answer comes from that address; the allowlist, verified senders and loop protection keep working.

async function until<T>(fn: () => T | Promise<T>, ms = 8000, what = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('plus addresses: tag of an address, address of a tag, a tag from a bot name, no doubles', () => {
  assert.equal(plusTagOf('jij+baas@gmail.com', 'jij@gmail.com'), 'baas');
  assert.equal(plusTagOf('JIJ+Baas@Gmail.com', 'jij@gmail.com'), 'baas', 'case does not matter');
  assert.equal(plusTagOf('j.i.j+baas@gmail.com', 'jij@gmail.com'), 'baas', 'Gmail ignores dots');
  assert.equal(plusTagOf('j.i.j+baas@example.nl', 'jij@example.nl'), null, 'other providers do not');
  assert.equal(plusTagOf('jij+baas@other.com', 'jij@gmail.com'), null);
  assert.equal(plusTagOf('ander+baas@gmail.com', 'jij@gmail.com'), null);
  assert.equal(plusTagOf('jij@gmail.com', 'jij@gmail.com'), null, 'the mailbox itself has no tag');
  assert.equal(plusTagOf('jij+b<a>s@gmail.com', 'jij@gmail.com'), null);
  assert.equal(plusAddress('jij@gmail.com', 'baas'), 'jij+baas@gmail.com');
  assert.equal(plusAddress('jij+oud@gmail.com', 'baas'), 'jij+baas@gmail.com');
  assert.equal(plusAddress('jij@gmail.com', 'b a'), null);
  assert.equal(botTag('Baas'), 'baas');
  assert.equal(botTag('Mila de Planner'), 'mila-de-planner');
  assert.equal(botTag('Zoë'), 'zoe');
  assert.equal(botTag('🤖'), '');
  const tags = botTags(
    [
      { id: 'a', name: 'Baas' },
      { id: 'b', name: 'baas' },
      { id: 'c', name: 'Schrijver' },
    ],
    { c: 'pen' },
  );
  assert.deepEqual([...tags], [['c', 'pen'], ['a', 'baas']], 'own tag first; a second "baas" gets none rather than a double');
});

test('mailToInbound: the plus address from To, Cc or Delivered-To; your own mail to a plus address is no loop', async () => {
  const raw = (to: string, extra: string[] = [], from = 'Jij <jij@gmail.com>') =>
    [`From: ${from}`, `To: ${to}`, ...extra, 'Subject: Rapport', 'Message-ID: <m1@gmail.com>', 'Authentication-Results: mx.google.com; dmarc=pass', 'Content-Type: text/plain; charset=utf-8', '', 'Maak het rapport.'].join('\r\n');
  const o = { ownAddress: 'jij@gmail.com', fallbackId: '<fb@x>', lookup: () => null, plus: true };
  const a = mailToInbound(await simpleParser(raw('jij+baas@gmail.com')), o);
  assert.equal(a.plusTag, 'baas');
  assert.equal(a.plusTo, 'jij+baas@gmail.com');
  assert.equal(a.automated, null, 'your own mail to a bot address is a message to that bot');
  const b = mailToInbound(await simpleParser(raw('iemand@example.com', ['Cc: jij+schrijver@gmail.com'])), o);
  assert.equal(b.plusTag, 'schrijver');
  const c = mailToInbound(await simpleParser(raw('lijst@example.com', ['Delivered-To: jij+baas@gmail.com'])), o);
  assert.equal(c.plusTag, 'baas', 'Bcc: only Delivered-To knows');
  const own = mailToInbound(await simpleParser(raw('jij@gmail.com')), o);
  assert.equal(own.automated, 'eigen adres', 'without a plus address your own mail stays ignored');
  const loop = mailToInbound(await simpleParser(raw('jij+baas@gmail.com', ['X-TeamBot: channel'])), o);
  assert.ok(loop.automated, "TeamBot's own answer is never read as a message");
  const off = mailToInbound(await simpleParser(raw('jij+baas@gmail.com')), { ...o, plus: false });
  assert.equal(off.plusTag, null, 'plus addressing off: no tag');
});

test('e-mail channel: you+schrijver@ goes to Schrijver and is answered from that address; unknown tag → the channel bot; allowlist holds', async () => {
  const t = await startTestApp({ modules: [channels] });
  const nodemailer = (await import('nodemailer')).default;
  const sent: any[] = [];
  const orig = emailTransport.create;
  emailTransport.create = () => {
    const tr = nodemailer.createTransport({ jsonTransport: true });
    return { sendMail: async (o: any) => sent.push(JSON.parse((await tr.sendMail(o)).message)) } as any;
  };
  // The real e-mail adapter without IMAP: mails go in through handleRaw, out through the JSON transport above.
  let rt: any = null;
  const def: AdapterDef = {
    ...emailAdapter,
    create(ctx) {
      rt = emailAdapter.create(ctx);
      rt.start = async () => 'connected';
      rt.stop = async () => {};
      return rt;
    },
  };
  t.app.ctx.services.channels.registerAdapter(def);
  try {
    const baas = await t.agent({ name: 'Baas' });
    const schrijver = await t.agent({ name: 'Schrijver' });
    const b = await t.api('POST', '/channels/bindings', {
      adapter: 'email',
      name: 'Mijn mail',
      agent_id: baas.id,
      config: { preset: 'gmail', address: 'jij@gmail.com', plusAddressing: true, requireAuth: true },
      secrets: { password: 'app-wachtwoord-1234' },
    });
    await until(() => rt && t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 5000, 'connected');
    await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: 'jij@gmail.com', label: 'Sanne', is_owner: true });

    // Instellingen › Kanalen shows each bot's address.
    const view = await t.api('GET', `/channels/bindings/${b.id}`);
    assert.deepEqual(
      view.botAddresses.map((x: any) => [x.name, x.address, x.own]),
      [
        ['Baas', 'jij+baas@gmail.com', true],
        ['Schrijver', 'jij+schrijver@gmail.com', false],
      ],
    );
    // An own tag for a bot.
    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { ...view.config, plusTags: { [schrijver.id]: 'pen' } } });
    assert.equal((await t.api('GET', `/channels/bindings/${b.id}`)).botAddresses.find((x: any) => x.agentId === schrijver.id).address, 'jij+pen@gmail.com');

    let n = 0;
    const mail = (to: string, o: { from?: string; extra?: string[] } = {}) =>
      Buffer.from(
        [`From: ${o.from || 'Sanne <jij@gmail.com>'}`, `To: ${to}`, 'Subject: Stukje voor de nieuwsbrief', `Message-ID: <m${++n}@gmail.com>`, 'Authentication-Results: mx.google.com; dkim=pass header.i=@gmail.com; dmarc=pass', ...(o.extra || []), 'Content-Type: text/plain; charset=utf-8', '', 'Schrijf een stukje.'].join('\r\n'),
      );
    const convOf = (id: string) => t.app.ctx.store.one<any>('SELECT * FROM channel_conversations WHERE binding_id = ? AND external_id = ?', b.id, id);

    await rt.handleRaw(mail('jij+pen@gmail.com'), 1, 100);
    const c1 = await until(() => convOf('<m1@gmail.com>')?.thread_id && convOf('<m1@gmail.com>'), 5000, 'conversation');
    assert.equal(JSON.parse(c1.meta).agentId, schrijver.id);
    assert.equal(t.app.ctx.store.thread(c1.thread_id)!.agent_id, schrijver.id, 'the thread is with Schrijver');
    await t.waitIdle(c1.thread_id);
    const r1 = await until(() => sent.find((s) => s.to?.[0]?.address === 'jij@gmail.com'), 8000, 'answer');
    assert.equal(r1.from.address, 'jij+pen@gmail.com', 'answered from the bot address');
    assert.equal(r1.from.name, 'Schrijver');
    assert.equal(r1.inReplyTo, '<m1@gmail.com>');

    // Unknown tag: the channel's own bot, and the log says so.
    await rt.handleRaw(mail('jij+niemand@gmail.com'), 2, 100);
    const c2 = await until(() => convOf('<m2@gmail.com>')?.thread_id && convOf('<m2@gmail.com>'), 5000, 'conversation 2');
    assert.equal(t.app.ctx.store.thread(c2.thread_id)!.agent_id, baas.id);
    assert.ok(t.app.ctx.store.one("SELECT id FROM channel_log WHERE binding_id = ? AND kind = 'ignored' AND summary LIKE '%+niemand%'", b.id), 'logged');
    await t.waitIdle(c2.thread_id);

    // Someone not on the allowlist, to a bot address: still not let through.
    await rt.handleRaw(mail('jij+pen@gmail.com', { from: 'Vreemde <vreemd@example.com>' }), 3, 100);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(convOf('<m3@gmail.com>'), undefined, 'no conversation for a stranger');

    // Plus addressing off: back to one address; the answer comes from the mailbox itself.
    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { ...view.config, plusAddressing: false } });
    await until(() => rt && t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 5000, 'reconnected');
    assert.deepEqual((await t.api('GET', `/channels/bindings/${b.id}`)).botAddresses, []);
    const before = sent.length;
    await rt.handleRaw(mail('jij+pen@gmail.com', { from: 'Sanne <sanne@example.com>' }), 4, 100);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, before, 'stranger again: nothing sent');
  } finally {
    emailTransport.create = orig;
    await t.close();
  }
});
