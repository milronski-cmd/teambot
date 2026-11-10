// Customer mode ("Klantenservice") on a channel: AI label, hand off to the owner, never invent policy (answers only
// from approved knowledge), and an approval gate for money and promises, all enforced on the bot's draft in code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import type { AdapterContext, AdapterDef, Outbound } from '../server/modules/channels/types.js';
import type { ChannelManager } from '../server/modules/channels/manager.js';
import {
  canOpenDoor,
  classifyDraft,
  citationsOf,
  factsOf,
  hoursSummary,
  humanRequested,
  isOpen,
  knowledgeItems,
  nextOpening,
  normalizeCustomer,
  numValue,
  readCustomer,
  stripCitations,
} from '../server/modules/channels/customer.js';

async function until<T>(fn: () => T | Promise<T>, ms = 5000, what = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeAdapter(id = 'fake') {
  const state = { ctx: null as AdapterContext | null, sent: [] as { conv: string; out: Outbound }[], fail: '' };
  const def: AdapterDef = {
    id,
    label: 'Nep',
    description: 'test',
    needsPublicUrl: () => false,
    approveViaChannel: true,
    maxText: 4000,
    secretFields: [{ key: 'token', label: 'Token', required: true }],
    validate: () => ({}),
    test: async () => ({ ok: true, detail: 'ok' }),
    create(ctx) {
      state.ctx = ctx;
      return {
        async start() {
          return 'connected' as const;
        },
        async stop() {},
        async send(conv, out) {
          if (state.fail) throw new Error(state.fail);
          state.sent.push({ conv: conv.external_id, out });
          return [`out${state.sent.length}`];
        },
        async sendTo(target, out) {
          state.sent.push({ conv: target, out });
          return { conversationId: target, title: target, private: true, ids: [`new${state.sent.length}`] };
        },
      };
    },
  };
  return { def, state };
}

const KNOWLEDGE = [
  'Openingstijden: maandag tot en met vrijdag 09:00–17:00.',
  'Retourneren kan binnen 30 dagen met je kassabon; je krijgt je geld terug.',
  'De Stadsfiets kost € 499.',
  'We verkopen alleen fietsen, geen scooters.',
].join('\n');

let seq = 0;
const fromCustomer = (who: string, text: string, over: any = {}) => ({
  messageId: `c${++seq}`,
  conversation: { id: `chat-${who}`, title: who, private: true },
  sender: { id: `id-${who}`, name: who },
  text,
  ...over,
});

async function shop(t: TestApp, customer: any = {}, adapterId = 'fake') {
  const f = fakeAdapter(adapterId);
  t.app.ctx.services.channels.registerAdapter(f.def);
  const a = await t.agent({ name: 'Winkelbot' });
  const b = await t.api('POST', '/channels/bindings', { adapter: adapterId, name: 'Winkel', agent_id: a.id, config: { customer: { enabled: true, knowledge: KNOWLEDGE, ...customer } }, secrets: { token: 'fake-secret-token-123456' } });
  await until(() => f.state.ctx && t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 3000, 'connected');
  const m = t.app.ctx.services.channels.manager as ChannelManager;
  const notes: any[] = [];
  t.app.ctx.events.on('notification', (e: any) => notes.push(e.data));
  return { f, a, b, ctx: f.state.ctx!, m, notes };
}

const sentTo = (f: ReturnType<typeof fakeAdapter>, who: string) => f.state.sent.filter((s) => s.conv === `chat-${who}`).map((s) => s.out.text);
const conv = (m: ChannelManager, bindingId: string, who: string) => m.conversationByExt(bindingId, `chat-${who}`)!;

// ---------------------------------------------------------------- hand off

test('a question outside the approved knowledge is handed off to the owner instead of answered', async () => {
  const t = await startTestApp();
  try {
    const { f, b, ctx, m, notes } = await shop(t);
    // The bot invents an answer: a product and a price that are not in the approved knowledge.
    t.script.push({ text: 'Ja hoor, we verhuren elektrische scooters voor € 25 per dag.' });
    const r = await ctx.receive(fromCustomer('Kim', 'Verhuren jullie ook elektrische scooters?'));
    assert.equal(r.status, 'ok', 'a stranger may write: the channel is open to customers');
    await t.waitIdle(r.threadId!);

    const out = sentTo(f, 'Kim');
    assert.equal(out.length, 1, 'only the hand-off notice went out');
    assert.ok(!out[0].includes('€ 25') && !/scooter/i.test(out[0]), 'the invented answer never reached the customer');
    assert.match(out[0], /^🤖 Je praat met een AI-assistent\./, 'AI label first');
    assert.match(out[0], /Ik heb je vraag doorgezet naar een medewerker\. Je krijgt zo snel mogelijk antwoord\./);

    const c = conv(m, b.id, 'Kim');
    assert.equal(c.paused, true, 'the bot stops answering this conversation');
    assert.match(c.meta.handoff.reason, /Noemt iets wat niet in je goedgekeurde kennis staat: € 25/);
    assert.ok(notes.some((n) => /Klantvraag voor jou/.test(n.title) && n.important && /scooters/.test(n.body)), 'the owner is notified with the conversation');

    const inbox = await t.api('GET', '/channels/inbox');
    assert.equal(inbox.handoffs.length, 1);
    assert.equal(inbox.handoffs[0].conversation_id, c.id);
    assert.match(inbox.handoffs[0].question, /scooters/);
    const events = t.app.ctx.store.messages(r.threadId!).filter((x) => x.role === 'event').map((x) => x.content);
    assert.ok(events.some((e) => /^Doorgezet naar jou/.test(e)));
    const draftMsg = t.app.ctx.store.messages(r.threadId!).filter((x) => x.role === 'assistant').at(-1)!;
    assert.equal(draftMsg.parts.channelDelivery?.status, 'handoff');

    // While handed off, the bot stays quiet; the owner hears about the new message.
    const before = t.requests.length;
    await ctx.receive(fromCustomer('Kim', 'Hallo? Is daar iemand?'));
    await sleep(150);
    assert.equal(t.requests.length, before, 'no bot run while the conversation is with the owner');
    assert.equal(sentTo(f, 'Kim').length, 1);
    assert.ok(notes.some((n) => /Kim wacht op jouw antwoord/.test(n.title)));

    // The owner replies: released, the bot answers again (no second AI label within a day).
    await t.api('POST', `/channels/conversations/${c.id}/send`, { text: 'Hoi Kim, scooters verhuren we helaas niet.' });
    assert.equal(sentTo(f, 'Kim').at(-1), 'Hoi Kim, scooters verhuren we helaas niet.', 'the owner speaks as himself: no AI label');
    assert.equal(conv(m, b.id, 'Kim').paused, false);
    assert.equal(conv(m, b.id, 'Kim').meta.handoff, undefined);
    assert.equal((await t.api('GET', '/channels/inbox')).handoffs.length, 0);
    t.script.push({ text: 'Graag gedaan!' });
    const r2 = await ctx.receive(fromCustomer('Kim', 'Oké, dank je!'));
    await t.waitIdle(r2.threadId!);
    assert.equal(sentTo(f, 'Kim').at(-1), 'Graag gedaan!');
  } finally {
    await t.close();
  }
});

test('the bot saying it does not know, or [DOORZETTEN], or a customer asking for a person: handed off', async () => {
  const t = await startTestApp();
  try {
    const { f, b, ctx, m } = await shop(t);
    t.script.push({ text: '[DOORZETTEN]' });
    const r1 = await ctx.receive(fromCustomer('Ali', 'Kan ik mijn fiets bij jullie laten repareren?'));
    await t.waitIdle(r1.threadId!);
    assert.equal(conv(m, b.id, 'Ali').meta.handoff.reason, 'De bot weet het antwoord niet');
    assert.match(sentTo(f, 'Ali')[0], /doorgezet naar een medewerker/);
    assert.ok(!sentTo(f, 'Ali')[0].includes('DOORZETTEN'));

    t.script.push({ text: 'Dat weet ik niet zeker, misschien op zaterdag.' });
    const r2 = await ctx.receive(fromCustomer('Bo', 'Zijn jullie op zondag open?'));
    await t.waitIdle(r2.threadId!);
    assert.equal(conv(m, b.id, 'Bo').meta.handoff.reason, 'De bot weet het antwoord niet zeker');

    // Asking for a person: no bot in between at all.
    const before = t.requests.length;
    const r3 = await ctx.receive(fromCustomer('Cas', 'Ik wil graag een medewerker spreken.'));
    assert.equal(r3.status, 'ok');
    await sleep(100);
    assert.equal(t.requests.length, before, 'the bot did not run');
    assert.equal(conv(m, b.id, 'Cas').meta.handoff.reason, 'De klant vraagt om een mens');
    assert.match(sentTo(f, 'Cas')[0], /doorgezet naar een medewerker/);
  } finally {
    await t.close();
  }
});

test('working hours: the customer hears when a person will answer', async () => {
  const t = await startTestApp();
  try {
    // Open every day, all day: "binnen onze werktijden (…)".
    const open = await shop(t, { hours: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59' } });
    await open.ctx.receive(fromCustomer('Dex', 'Mag ik een mens spreken?'));
    await until(() => sentTo(open.f, 'Dex').length, 3000, 'notice');
    assert.match(sentTo(open.f, 'Dex')[0], /Je krijgt zo snel mogelijk antwoord, binnen onze werktijden \(ma–zo 00:00–23:59\)\./);

    // Only a day that is not today: closed, with the next opening.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date()));
    const day = (today + 3) % 7;
    const closed = await shop(t, { hours: { enabled: true, days: [day], from: '09:00', to: '17:00' } }, 'fake2');
    await closed.ctx.receive(fromCustomer('Eva', 'Ik wil een mens spreken'));
    await until(() => sentTo(closed.f, 'Eva').length, 3000, 'notice');
    const name = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + day)));
    assert.match(sentTo(closed.f, 'Eva')[0], new RegExp(`We zijn nu gesloten; je krijgt antwoord vanaf ${name} 09:00\\.`));
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- approval gate

test('a draft with a price waits for approval and is sent only after it, with the edited text when edited', async () => {
  const t = await startTestApp();
  try {
    const { f, b, ctx, m, notes } = await shop(t);
    t.script.push({ text: 'De Stadsfiets kost € 499 [K3].' });
    const r = await ctx.receive(fromCustomer('Fem', 'Wat kost de Stadsfiets?'));
    await t.waitIdle(r.threadId!);
    assert.equal(sentTo(f, 'Fem').length, 0, 'nothing is sent before the owner approves');

    const inbox = await t.api('GET', '/channels/inbox');
    assert.equal(inbox.held.length, 1);
    const held = inbox.held[0];
    assert.equal(held.text, 'De Stadsfiets kost € 499.', 'the exact text, without the source marker');
    assert.ok(held.reasons.includes('Noemt een bedrag: € 499'));
    assert.match(held.question, /Wat kost de Stadsfiets/);
    assert.ok(notes.some((n) => /Antwoord aan Fem wacht op jou/.test(n.title) && n.important));
    const draft = t.app.ctx.store.messages(r.threadId!).filter((x) => x.role === 'assistant').at(-1)!;
    assert.equal(draft.parts.channelDelivery?.status, 'held');

    // The owner edits and approves: exactly his text goes out (with the AI label, first reply in this chat).
    const edited = 'De Stadsfiets kost € 499. Kom gerust langs voor een proefrit!';
    const row = await t.api('POST', `/channels/outbox/${held.id}/approve`, { text: edited });
    assert.equal(row.status, 'sent');
    assert.equal(row.edited, true);
    const out = sentTo(f, 'Fem');
    assert.equal(out.length, 1);
    assert.equal(out[0], `🤖 Je praat met een AI-assistent. Wil je liever een mens? Zeg het gerust.\n\n${edited}`);
    await assert.rejects(t.api('POST', `/channels/outbox/${held.id}/approve`, {}), /al afgehandeld/);
    const after = t.app.ctx.store.message(draft.id)!;
    assert.equal(after.parts.channelDelivery?.status, 'sent');
    assert.equal(after.parts.channelDelivery?.edited, true);

    // A refund answer: held; approved unchanged, the exact proposed text goes out.
    t.script.push({ text: 'Retourneren kan binnen 30 dagen met je kassabon [K2].' });
    const r2 = await ctx.receive(fromCustomer('Fem', 'Kan ik de fiets terugbrengen?'));
    await t.waitIdle(r2.threadId!);
    assert.equal(sentTo(f, 'Fem').length, 1);
    const h2 = (await t.api('GET', '/channels/inbox')).held[0];
    assert.ok(h2.reasons.includes('Gaat over terugbetalen, retour of annuleren'));
    await t.api('POST', `/channels/outbox/${h2.id}/approve`, {});
    assert.equal(sentTo(f, 'Fem').at(-1), 'Retourneren kan binnen 30 dagen met je kassabon.');

    // Rejected: never sent; the customer hears a person will reply, the conversation is the owner's.
    t.script.push({ text: 'Je krijgt je geld terug binnen 30 dagen [K2].' });
    const r3 = await ctx.receive(fromCustomer('Fem', 'Krijg ik mijn geld terug?'));
    await t.waitIdle(r3.threadId!);
    const h3 = (await t.api('GET', '/channels/inbox')).held[0];
    await t.api('POST', `/channels/outbox/${h3.id}/reject`);
    assert.ok(!sentTo(f, 'Fem').some((x) => x.includes('Je krijgt je geld terug')));
    assert.match(sentTo(f, 'Fem').at(-1)!, /doorgezet naar een medewerker/);
    assert.ok(conv(m, b.id, 'Fem').meta.handoff);
    assert.equal((await t.api('GET', '/channels/inbox')).held.length, 0);
  } finally {
    await t.close();
  }
});

test('"Opnieuw" on a held reply and a routine message about money go through the same gate', async () => {
  const t = await startTestApp();
  try {
    const { f, b, ctx, m } = await shop(t);
    t.script.push({ text: 'De Stadsfiets kost € 499 [K3].' });
    const r = await ctx.receive(fromCustomer('Gio', 'Prijs van de Stadsfiets?'));
    await t.waitIdle(r.threadId!);
    const msg = t.app.ctx.store.messages(r.threadId!).filter((x) => x.role === 'assistant').at(-1)!;
    await t.api('POST', `/channels/messages/${msg.id}/resend`);
    assert.equal(sentTo(f, 'Gio').length, 0, 'resend never goes around the approval');
    assert.equal((await t.api('GET', '/channels/inbox')).held.length, 2);

    // A routine result to this customer with an amount: held, the routine hears why.
    const c = conv(m, b.id, 'Gio');
    await assert.rejects(t.app.ctx.services.channels.deliver({ userId: t.app.ctx.auth.owner()!.id, bindingId: b.id, conversationId: c.id, text: 'Je factuur van € 80 staat klaar.' }), /Wacht op jouw goedkeuring/);
    assert.equal(sentTo(f, 'Gio').length, 0);
    assert.equal((await t.api('GET', '/channels/inbox')).held.length, 3);

    // channel_send to a customer with money always asks the owner (also for a released contact); to the owner it does not.
    const fresh = m.binding(b.id)!;
    assert.equal(m.customerSendNeedsApproval(fresh, c.id, 'Je krijgt € 10 korting!'), true);
    assert.equal(m.customerSendNeedsApproval(fresh, 'eigenaar', 'Je krijgt € 10 korting!'), false);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- AI label, log, access

test('the AI label appears on the first reply, not on every reply, and not when switched off', async () => {
  const t = await startTestApp();
  try {
    const { f, ctx } = await shop(t);
    t.script.push({ text: 'Wij zijn open van maandag tot en met vrijdag 09:00–17:00 [K1].' });
    const r = await ctx.receive(fromCustomer('Hans', 'Wanneer zijn jullie open?'));
    await t.waitIdle(r.threadId!);
    assert.equal(sentTo(f, 'Hans')[0], '🤖 Je praat met een AI-assistent. Wil je liever een mens? Zeg het gerust.\n\nWij zijn open van maandag tot en met vrijdag 09:00–17:00.');
    t.script.push({ text: 'Hallo! Waarmee kan ik je nog helpen?' });
    const r2 = await ctx.receive(fromCustomer('Hans', 'Hoi'));
    await t.waitIdle(r2.threadId!);
    assert.equal(sentTo(f, 'Hans')[1], 'Hallo! Waarmee kan ik je nog helpen?');

    const off = await shop(t, { aiLabel: false }, 'fake2');
    t.script.push({ text: 'Wij zijn open van maandag tot en met vrijdag 09:00–17:00 [K1].' });
    const r3 = await off.ctx.receive(fromCustomer('Ivo', 'Openingstijden?'));
    await t.waitIdle(r3.threadId!);
    assert.equal(sentTo(off.f, 'Ivo')[0], 'Wij zijn open van maandag tot en met vrijdag 09:00–17:00.');
  } finally {
    await t.close();
  }
});

test('every outgoing message to customers is logged with its full text', async () => {
  const t = await startTestApp();
  try {
    const { f, b, ctx } = await shop(t);
    t.script.push({ text: 'Wij zijn open van maandag tot en met vrijdag 09:00–17:00 [K1].' });
    const r1 = await ctx.receive(fromCustomer('Jip', 'Wanneer open?'));
    await t.waitIdle(r1.threadId!);
    t.script.push({ text: 'De Stadsfiets kost € 499 [K3].' });
    const r2 = await ctx.receive(fromCustomer('Jip', 'Wat kost de Stadsfiets?'));
    await t.waitIdle(r2.threadId!);
    const held = (await t.api('GET', '/channels/inbox')).held[0];
    await t.api('POST', `/channels/outbox/${held.id}/approve`, { text: 'De Stadsfiets kost € 499, inclusief btw.' });
    t.script.push({ text: 'Scooters hebben we ook, vanaf € 1.200.' });
    const r3 = await ctx.receive(fromCustomer('Jip', 'En scooters?'));
    await t.waitIdle(r3.threadId!);

    const log = await t.api('GET', `/channels/bindings/${b.id}/outbox`);
    const sentRows = log.filter((x: any) => x.status === 'sent');
    const sentTexts = f.state.sent.map((s) => s.out.text);
    assert.equal(sentRows.length, sentTexts.length, 'one row per message that went out');
    assert.deepEqual(new Set(sentRows.map((x: any) => x.text)), new Set(sentTexts), 'with the exact text that went out');
    assert.ok(log.some((x: any) => x.status === 'handoff' && /€ 1\.200/.test(x.draft) && !x.sent_at), 'the draft that was not sent is kept too, marked as not sent');
    assert.ok(sentRows.some((x: any) => x.kind === 'handoff'));
    assert.ok(sentRows.some((x: any) => x.edited && x.text === 'De Stadsfiets kost € 499, inclusief btw.'));
    const exp = t.app.ctx.services.channels.exportUser(t.app.ctx.auth.owner()!.id);
    assert.equal(exp.channels.outbox.length, log.length, 'in the full export');
  } finally {
    await t.close();
  }
});

test('customers who simply write get no tools, only in private chats; strangers stay out when customer mode is off', async () => {
  const t = await startTestApp();
  try {
    const { b, ctx, m } = await shop(t, {});
    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { othersAccess: 'agent' } });
    t.script.push({ text: 'Hallo! Waarmee kan ik helpen?' });
    const r = await ctx.receive(fromCustomer('Kees', 'Hoi'));
    await t.waitIdle(r.threadId!);
    const thread = t.app.ctx.store.thread(r.threadId!)!;
    const agent = t.app.ctx.store.agent(m.binding(b.id)!.agent_id!)!;
    assert.deepEqual(m.filterTools(agent, thread, [{ name: 'x', risk: 'read' } as any]), [], 'a stranger never gets tools, whatever othersAccess says');
    // A group with a stranger: not open.
    const g = await ctx.receive(fromCustomer('Lot', 'Hoi allemaal', { conversation: { id: 'grp', title: 'Groep', private: false } }));
    assert.equal(g.status, 'blocked');
    // Customer mode off: a stranger is blocked again.
    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { customer: { enabled: false } } });
    assert.equal((await ctx.receive(fromCustomer('Mo', 'Hoi'))).status, 'blocked');
    // WhatsApp via QR never opens the door (it is the owner's own number).
    assert.equal(readCustomer({ enabled: true, open: true }, 'whatsapp-web').open, false);
    assert.equal(canOpenDoor('whatsapp-web'), false);
    assert.equal(canOpenDoor('whatsapp'), true);
  } finally {
    await t.close();
  }
});

test('customer settings are validated and the bot is told the rules and the numbered knowledge', async () => {
  const t = await startTestApp();
  try {
    const { b, ctx } = await shop(t);
    await assert.rejects(t.api('PATCH', `/channels/bindings/${b.id}`, { config: { customer: { hours: { enabled: true, days: [1], from: '17:00', to: '09:00' } } } }), /eindtijd/);
    await assert.rejects(t.api('PATCH', `/channels/bindings/${b.id}`, { config: { customer: { hours: { enabled: true, days: [], from: '09:00', to: '17:00' } } } }), /werkdag/);
    t.script.push({ text: 'Hallo! Waarmee kan ik helpen?' });
    const r = await ctx.receive(fromCustomer('Nina', 'Hoi'));
    await t.waitIdle(r.threadId!);
    const sys = t.requests.at(-1)!.system;
    assert.match(sys, /## Klantenservice/);
    assert.match(sys, /\[K3\] De Stadsfiets kost € 499\./);
    assert.match(sys, /\[DOORZETTEN\]/);
    // The owner's own conversation on the same channel is not customer service.
    assert.throws(() => normalizeCustomer({ knowledge: 'x'.repeat(20_001) }, {}, 'telegram'), /te lang/);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- the classifier itself

test('classifier: grounded, money, invented facts, uncovered policy, no source, doubt, small talk', () => {
  const k = knowledgeItems(KNOWLEDGE);
  assert.equal(k.length, 4);
  assert.equal(k[2].id, 'K3');
  const c = (draft: string, question = '') => classifyDraft({ draft, question, knowledge: k });

  assert.equal(c('Wij zijn open van maandag tot en met vrijdag 09:00–17:00 [K1].').action, 'send');
  assert.equal(c('Hallo! Waarmee kan ik je helpen?').action, 'send', 'small talk needs no source');
  assert.equal(c('Wat is je ordernummer?', 'Waar is mijn bestelling?').action, 'send', 'a question back is fine');

  const price = c('De Stadsfiets kost € 499 [K3].', 'Wat kost de Stadsfiets?');
  assert.equal(price.action, 'hold');
  assert.equal(price.text, 'De Stadsfiets kost € 499.');
  assert.deepEqual(price.cited, ['K3']);
  assert.equal(c('De Stadsfiets kost 499 euro [K3].').action, 'hold', 'another way of writing the same amount is grounded');
  assert.equal(c('Retourneren kan binnen 30 dagen [K2].').action, 'hold', 'refunds wait for approval');
  assert.equal(c('We sturen je de kassabon nog per mail na [K2].').action, 'hold', 'a promise waits for approval');
  assert.equal(c('Je bestelling is genoteerd [K1].').action, 'handoff', 'an unrelated source does not count');
  assert.equal(c('Je krijgt de fiets morgen thuis [K1].').action, 'handoff');

  assert.equal(c('Retourneren kan binnen 60 dagen [K2].').action, 'handoff', 'a number not in the knowledge');
  assert.match(c('Retourneren kan binnen 60 dagen [K2].').reasons[0], /60 dagen/);
  assert.equal(c('De Stadsfiets kost € 449 [K3].').action, 'handoff');
  assert.equal(c('Bel ons op 020-1234567 [K1].').action, 'handoff', 'a phone number not in the knowledge');
  assert.equal(c('Kijk op https://voorbeeld.nl/acties [K1].').action, 'handoff', 'a link not in the knowledge');
  assert.match(c('Op alle fietsen zit garantie [K3].').reasons[0], /garantie of reparatie; daar staat niets over/);
  assert.equal(c('Ja, scooters hebben we ook.').action, 'handoff', 'a substantive answer without a source');
  assert.match(c('Ja, scooters hebben we ook.').reasons[0], /geen bron/);
  assert.equal(c('Ik weet het niet precies.').action, 'handoff');
  assert.equal(c('Daar heb ik geen informatie over.').action, 'handoff');
  assert.equal(c("I don't know, sorry.").action, 'handoff');
  assert.equal(c('Ik zet je vraag door naar een collega.').action, 'handoff');
  assert.equal(c('[DOORZETTEN]').action, 'handoff');
  assert.equal(c('').action, 'handoff');
  assert.equal(c('Ik weet het zeker: we verkopen alleen fietsen [K4].').action, 'send', '"ik weet het zeker" is not doubt');
  // The customer's own numbers support the answer.
  assert.equal(c('Je bestelling 48213 staat genoteerd [K1].', 'Waar is bestelling 48213?').action, 'handoff', 'a delivery question is not covered by the knowledge');
  assert.equal(c('Bedankt voor je bericht over bestelling 48213! Wat is je postcode?', 'Bestelling 48213').action, 'send');
  // Without any knowledge everything substantive goes to the owner.
  assert.equal(classifyDraft({ draft: 'We zijn morgen open [K1].', question: '', knowledge: [] }).action, 'handoff');
});

test('classifier helpers: numbers, citations, facts, asking for a human, working hours', () => {
  assert.equal(numValue('1.899'), '1899');
  assert.equal(numValue('499,00'), '499');
  assert.equal(numValue('17.30'), '17.3');
  assert.equal(numValue('2,5'), '2.5');
  assert.equal(numValue('1.234,56'), '1234.56');
  assert.equal(numValue('499,-'), '499');
  assert.deepEqual(citationsOf('Ja [K2], en ook (K3) en [K1, K4].').sort(), ['K1', 'K2', 'K3', 'K4']);
  assert.equal(stripCitations('De fiets kost € 499 [K3].'), 'De fiets kost € 499.');
  const f = factsOf('Voor € 12,50 of 10% korting, open om 9:00, binnen 3 werkdagen, mail info@winkel.nl');
  assert.deepEqual(
    f.map((x) => `${x.kind}:${x.key}`),
    ['email:email:info@winkel.nl', 'money:12.5', 'percent:10', 'time:9:00', 'duration:3'],
  );
  assert.equal(humanRequested('Ik wil graag een medewerker spreken'), true);
  assert.equal(humanRequested('Kan ik iemand spreken?'), true);
  assert.equal(humanRequested('mens'), true);
  assert.equal(humanRequested('I want to talk to a human'), true);
  assert.equal(humanRequested('Wat kost de fiets?'), false);
  assert.equal(humanRequested('Mensen zeggen dat jullie goed zijn'), false);

  const h = { enabled: true, days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' };
  assert.equal(hoursSummary(h, 'nl-NL'), 'ma–vr 09:00–17:00');
  assert.equal(hoursSummary({ ...h, days: [1, 3, 5] }, 'nl-NL'), 'ma, wo, vr 09:00–17:00');
  // Wednesday 13 November 2024, 10:00 UTC.
  const wed10 = new Date(Date.UTC(2024, 10, 13, 10, 0));
  assert.equal(isOpen(h, wed10, 'UTC'), true);
  assert.equal(isOpen(h, new Date(Date.UTC(2024, 10, 13, 18, 0)), 'UTC'), false);
  assert.equal(nextOpening(h, new Date(Date.UTC(2024, 10, 13, 18, 0)), 'UTC', 'nl-NL'), 'donderdag 09:00');
  assert.equal(nextOpening(h, new Date(Date.UTC(2024, 10, 16, 12, 0)), 'UTC', 'nl-NL'), 'maandag 09:00', 'Saturday → Monday');
  assert.equal(nextOpening(h, new Date(Date.UTC(2024, 10, 13, 7, 0)), 'UTC', 'nl-NL'), 'woensdag 09:00', 'before opening today');
  assert.equal(readCustomer({}, 'telegram').aiLabel, true, 'AI label is on by default');
  assert.equal(readCustomer({}, 'telegram').handoff, true);
  assert.equal(readCustomer({}, 'telegram').approveMoney, true);
  assert.equal(readCustomer({}, 'telegram').enabled, false, 'customer mode itself is off by default');
});
