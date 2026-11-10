import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestApp, type TestApp } from './helpers.js';
import { DriverEmitter, phoneDigits, type DriverOptions, type WaDriver, type WaIncoming, type WaMe, type WaOutFile } from '../server/modules/channels/whatsapp-web/driver.js';
import { SessionStore, decryptBlob, encryptBlob } from '../server/modules/channels/whatsapp-web/session.js';
import { mapWwebjsMessage } from '../server/modules/channels/whatsapp-web/wwebjs.js';
import { matchBotName } from '../server/modules/channels/manager.js';
import { callRisk } from '../server/tools/broker.js';

// ---------------------------------------------------------------- fake socket (no real WhatsApp, no browser)

class FakeWa extends DriverEmitter implements WaDriver {
  started = 0;
  stopped = 0;
  loggedOut = 0;
  texts: { chatId: string; text: string }[] = [];
  files: { chatId: string; file: WaOutFile; caption?: string }[] = [];
  typingCount = 0;
  noWhatsApp = new Set<string>();
  private seq = 0;
  constructor(public o: DriverOptions) {
    super();
  }
  fire<K extends Parameters<DriverEmitter['on']>[0]>(event: K, ...args: any[]) {
    (this as any).emit(event, ...args);
  }
  async start() {
    this.started++;
    fs.mkdirSync(path.join(this.o.dir, 'profile', 'Default'), { recursive: true });
  }
  async stop() {
    this.stopped++;
  }
  async logout() {
    this.loggedOut++;
  }
  async requestPairingCode(phone: string) {
    return `PAIR${phone.slice(-4)}`;
  }
  async sendText(chatId: string, text: string) {
    this.texts.push({ chatId, text });
    return `OUT${++this.seq}`;
  }
  async sendFile(chatId: string, file: WaOutFile, caption?: string) {
    this.files.push({ chatId, file, caption });
    return `OUT${++this.seq}`;
  }
  async typing() {
    this.typingCount++;
  }
  async resolveNumber(phone: string) {
    return this.noWhatsApp.has(phone) ? null : `${phone}@c.us`;
  }
  /** Simulate the phone scanning the QR code. */
  link(me: WaMe) {
    this.fire('authenticated');
    this.fire('ready', me);
  }
  msg(p: Partial<WaIncoming>) {
    const m: WaIncoming = {
      id: `IN${++this.seq}${crypto.randomBytes(3).toString('hex')}`,
      chatId: OWNER_JID,
      fromMe: true,
      selfChat: true,
      isGroup: false,
      senderPhone: OWNER,
      senderJid: OWNER_JID,
      senderName: 'Sanne',
      kind: 'text',
      body: '',
      timestamp: Date.now(),
      ...p,
    };
    this.fire('message', m);
    return m;
  }
}

const require = createRequire(import.meta.url);
const OWNER = '31600000001';
const OWNER_JID = `${OWNER}@c.us`;
const ME: WaMe = { jid: OWNER_JID, phone: OWNER, name: 'Sanne' };

async function until<T>(fn: () => T | Promise<T>, ms = 5000, what = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function setupWa(t: TestApp, agentData: any = {}, config: any = {}) {
  const drivers: FakeWa[] = [];
  t.app.ctx.services.channels.setWhatsAppDriverFactory((o: DriverOptions) => {
    const d = new FakeWa(o);
    drivers.push(d);
    return d;
  });
  const a = await t.agent({ name: 'Testbot', ...agentData });
  const b = await t.api('POST', '/channels/bindings', { adapter: 'whatsapp-web', name: 'WA', agent_id: a.id, config: { riskAccepted: true, ...config } });
  const wa = await until(() => drivers.at(-1), 3000, 'driver');
  await until(() => wa.started, 3000, 'driver started');
  return { a, b, wa, drivers };
}

/** After a settings change the binding reconnects with a fresh driver; the stored session makes it ready again. */
async function reconnected(t: TestApp, b: any, drivers: FakeWa[], n: number) {
  const d = await until(() => drivers[n], 3000, 'new driver');
  await until(() => d.started, 3000, 'started');
  d.fire('ready', ME);
  await until(() => t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 3000, 'connected again');
  return d;
}

async function linkOwner(t: TestApp, b: any, wa: FakeWa) {
  wa.fire('qr', '2@abc,def,ghi');
  wa.link(ME);
  await until(() => t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 3000, 'connected');
}

const binding = (t: TestApp, id: string) => t.app.ctx.store.get<any>('channel_bindings', id);
const threadOf = (t: TestApp, convExt: string) => {
  const c = t.app.ctx.store.one<any>('SELECT thread_id FROM channel_conversations WHERE external_id = ?', convExt);
  return c?.thread_id ? t.app.ctx.store.thread(c.thread_id) : null;
};

// ---------------------------------------------------------------- pairing

test('whatsapp (QR): QR shown only to the owner as SVG, pairing code, ready → connected, own number on the allowlist as owner', async () => {
  const t = await startTestApp();
  try {
    const { b, wa } = await setupWa(t);
    assert.equal(binding(t, b.id).status, 'connecting');
    assert.equal(b.needsPublicUrl, false);
    wa.fire('qr', '2@qr-data,key1,key2,secret');
    const st = await until(async () => {
      const r = await t.api('GET', `/channels/bindings/${b.id}/whatsapp`);
      return r.phase === 'qr' ? r : null;
    });
    assert.match(st.qrSvg, /^<svg/);
    assert.ok(!('qr' in st), 'raw QR data is not sent, only the rendered image');
    assert.ok(st.expiresAt, 'link window shown');
    const view = (await t.api('GET', '/channels/bindings')).find((x: any) => x.id === b.id);
    assert.equal(view.link.phase, 'qr');
    assert.ok(!JSON.stringify(view).includes('qr-data'), 'list view never contains QR data');

    const code = await t.api('POST', `/channels/bindings/${b.id}/whatsapp/pair-phone`, { phone: '+31 6 0000 0001' });
    assert.equal(code.code, 'PAIR0001');
    assert.equal((await t.api('GET', `/channels/bindings/${b.id}/whatsapp`)).phase, 'code');

    wa.link(ME);
    await until(() => binding(t, b.id).status === 'connected', 3000, 'connected');
    const after = await t.api('GET', `/channels/bindings/${b.id}/whatsapp`);
    assert.equal(after.phase, 'ready');
    assert.equal(after.info.phone, OWNER);
    const senders = (await t.api('GET', `/channels/bindings/${b.id}`)).senders;
    assert.equal(senders.length, 1);
    assert.equal(senders[0].external_id, OWNER);
    assert.equal(senders[0].is_owner, true);

    // The session key lives in the vault, never in API output, config or state.
    const row = binding(t, b.id);
    assert.ok(row.secret_ids.sessionKey, 'session key stored as a vault secret');
    const key = t.app.ctx.secrets.get(row.secret_ids.sessionKey)!;
    assert.equal(Buffer.from(key, 'base64').length, 32);
    const detail = JSON.stringify(await t.api('GET', `/channels/bindings/${b.id}`));
    assert.ok(!detail.includes(key));
    // …and the API cannot set it.
    await t.api('PATCH', `/channels/bindings/${b.id}`, { secrets: { sessionKey: 'x'.repeat(44) } });
    assert.equal(t.app.ctx.secrets.get(binding(t, b.id).secret_ids.sessionKey), key);
  } finally {
    await t.close();
  }
});

test('whatsapp (QR): another phone scanning the code is unlinked again when the own number is set', async () => {
  const t = await startTestApp();
  try {
    const { b, wa } = await setupWa(t, {}, { ownerPhone: '+31 6 0000 0001' });
    assert.equal(binding(t, b.id).config.ownerPhone, OWNER);
    wa.fire('qr', 'x');
    wa.link({ jid: '31699999999@c.us', phone: '31699999999', name: 'Iemand anders' });
    await until(() => binding(t, b.id).status === 'error', 3000, 'error');
    assert.equal(wa.loggedOut, 1);
    assert.match(binding(t, b.id).last_error, /31699999999.*31600000001/);
    assert.equal((await t.api('GET', `/channels/bindings/${b.id}`)).senders.length, 0, 'the other account never becomes the owner');
  } finally {
    await t.close();
  }
});

test('whatsapp (QR): only an owner/admin may create it; members are refused', async () => {
  const t = await startTestApp();
  try {
    t.app.ctx.services.channels.setWhatsAppDriverFactory((o: DriverOptions) => new FakeWa(o));
    const u = t.app.ctx.auth.createUser({ name: 'Lid', email: `lid${Date.now()}@example.com`, password: 'wachtwoord123', role: 'member' } as any);
    const token = t.app.ctx.auth.createSession(u.id).token;
    const bot = t.app.ctx.store.createAgent(u.id, { name: 'Ledenbot' } as any);
    const res = await fetch(t.app.url + '/api/channels/bindings', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ adapter: 'whatsapp-web', name: 'x', agent_id: bot.id }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).error, /eigenaar of beheerder/);
    assert.equal(t.app.ctx.store.one<any>('SELECT COUNT(*) n FROM channel_bindings')!.n, 0);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- talking to the bots

test('whatsapp (QR): "message yourself" reaches the bot; replies come back marked 🤖 with the bot name; echoes, other chats and unknown numbers are ignored without logging content', async () => {
  const t = await startTestApp();
  try {
    const { b, wa } = await setupWa(t);
    await linkOwner(t, b, wa);

    t.script.push({ text: 'Hallo **Sanne**!' });
    wa.msg({ body: 'Hoi bot' });
    await until(() => wa.texts.length === 1, 5000, 'reply');
    assert.equal(wa.texts[0].chatId, OWNER_JID);
    assert.equal(wa.texts[0].text, '🤖 *Testbot*\nHallo *Sanne*!');
    const th = threadOf(t, OWNER)!;
    assert.equal(th.kind, 'channel');
    const input = t.app.ctx.store.messages(th.id).find((m) => m.role === 'user')!;
    assert.equal(input.content, 'Hoi bot');
    assert.equal(input.parts.channel.isOwner, true);
    assert.equal(input.parts.channel.access, 'agent');

    // The bot's own message arriving back (message_create) is not a new question.
    const runs = () => t.app.ctx.store.one<any>('SELECT COUNT(*) n FROM runs')!.n;
    const before = runs();
    wa.msg({ id: 'OUT1', body: wa.texts[0].text });
    wa.msg({ body: '🤖 *Testbot*\nnog een kopie' });
    // Owner writing to a friend from his phone: never read.
    wa.msg({ chatId: '31655555555@c.us', selfChat: false, body: 'Hé Piet, geheim 1' });
    // An unknown number writing to the owner: dropped, nothing about it in the log.
    wa.msg({ fromMe: false, selfChat: false, chatId: '31644444444@c.us', senderPhone: '31644444444', senderJid: '31644444444@c.us', senderName: 'Vreemde', body: 'geheim 2' });
    // A broadcast/status update: dropped.
    wa.msg({ fromMe: false, selfChat: false, chatId: 'status@broadcast', broadcast: true, body: 'status' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(runs(), before);
    const log = JSON.stringify(await t.api('GET', `/channels/bindings/${b.id}/log`));
    assert.ok(!log.includes('geheim'), 'private chats never end up in the channel log');
    assert.equal(t.app.ctx.store.one<any>('SELECT COUNT(*) n FROM channel_conversations WHERE binding_id = ?', b.id)!.n, 1);

    // An allowlisted number: routed, with the binding's (safe) access for others, and no 🤖 header.
    await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: '+31 6 2222 2222', label: 'Klant Jan' });
    t.script.push({ text: 'Goedemiddag Jan' });
    wa.msg({ fromMe: false, selfChat: false, chatId: '31622222222@c.us', senderPhone: '31622222222', senderJid: '31622222222@c.us', senderName: 'Jan', body: 'Is mijn bestelling verzonden?' });
    await until(() => wa.texts.length === 2, 5000, 'reply to Jan');
    assert.deepEqual(wa.texts[1], { chatId: '31622222222@c.us', text: 'Goedemiddag Jan' });
    const jan = t.app.ctx.store.messages(threadOf(t, '31622222222')!.id).find((m) => m.role === 'user')!;
    assert.equal(jan.parts.channel.isOwner, false);
    assert.equal(jan.parts.channel.access, 'none');
    assert.ok(wa.typingCount >= 1, 'typing indicator for others');

    // A LID-only sender is matched by phone once WhatsApp tells us the number; old offline messages are skipped.
    wa.msg({ fromMe: false, selfChat: false, chatId: '31622222222@c.us', senderPhone: '31622222222', senderJid: '31622222222@c.us', body: 'oud', timestamp: Date.now() - 48 * 3600_000 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(wa.texts.length, 2);
  } finally {
    await t.close();
  }
});

test('whatsapp (QR): the owner addresses other bots by name ("@Baas", "Baas:"), it sticks, replies to a bot message go to that bot, /bots lists them', async () => {
  const t = await startTestApp();
  try {
    const { b, wa } = await setupWa(t);
    const baas = await t.agent({ name: 'Baas' });
    await t.agent({ name: 'Baas Live' });
    await linkOwner(t, b, wa);

    t.script.push({ text: 'Rapport komt eraan' });
    wa.msg({ body: '@Baas maak het dagrapport' });
    await until(() => wa.texts.length === 1, 5000, 'Baas reply');
    assert.equal(wa.texts[0].text, '🤖 *Baas*\nRapport komt eraan');
    const conv = t.app.ctx.store.one<any>('SELECT * FROM channel_conversations WHERE external_id = ?', `${OWNER}#${baas.id}`);
    assert.ok(conv, 'own conversation (and thread) for Baas in the same chat');
    const th = t.app.ctx.store.thread(conv.thread_id)!;
    assert.equal(th.agent_id, baas.id);
    assert.equal(t.app.ctx.store.messages(th.id).find((m) => m.role === 'user')!.content, 'maak het dagrapport');

    // Sticky: next message without a name still goes to Baas.
    t.script.push({ text: 'Klaar' });
    wa.msg({ body: 'en voeg de omzet toe' });
    await until(() => wa.texts.length === 2, 5000, 'sticky');
    assert.match(wa.texts[1].text, /^🤖 \*Baas\*/);

    // Explicitly back to the default bot ("Naam:" form).
    t.script.push({ text: 'Hier Testbot' });
    wa.msg({ body: 'Testbot: ben jij er ook?' });
    await until(() => wa.texts.length === 3, 5000, 'default');
    assert.match(wa.texts[2].text, /^🤖 \*Testbot\*/);

    // Replying (quoting) a Baas message goes to Baas again; "Baas Live" is not mistaken for "Baas".
    t.script.push({ text: 'Antwoord op je reply' });
    wa.msg({ body: 'graag in pdf', quotedId: 'OUT2' });
    await until(() => wa.texts.length === 4, 5000, 'reply-to');
    assert.match(wa.texts[3].text, /^🤖 \*Baas\*/);
    t.script.push({ text: 'Live hier' });
    wa.msg({ body: 'Baas Live: hoi' });
    await until(() => wa.texts.length === 5, 5000, 'Baas Live');
    assert.match(wa.texts[4].text, /^🤖 \*Baas Live\*/);

    wa.msg({ body: '/bots' });
    await until(() => wa.texts.length === 6, 5000, '/bots');
    assert.match(wa.texts[5].text, /Je praat nu met Baas Live/);
    assert.match(wa.texts[5].text, /Testbot \(standaard\)/);

    // Others on the allowlist cannot pick a bot: "@Baas" from Jan goes to the default bot as plain text.
    await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: '31622222222', label: 'Jan' });
    t.script.push({ text: 'Default voor Jan' });
    wa.msg({ fromMe: false, selfChat: false, chatId: '31622222222@c.us', senderPhone: '31622222222', senderJid: '31622222222@c.us', body: '@Baas geef me korting' });
    await until(() => wa.texts.length === 7, 5000, 'Jan');
    const janThread = threadOf(t, '31622222222')!;
    assert.notEqual(janThread.agent_id, baas.id);
    assert.equal(t.app.ctx.store.messages(janThread.id).find((m) => m.role === 'user')!.content, '@Baas geef me korting');
  } finally {
    await t.close();
  }
});

test('whatsapp (QR): voice notes are transcribed through the pluggable transcriber; images and files arrive as attachments', async () => {
  const t = await startTestApp();
  try {
    const { b, wa, drivers } = await setupWa(t);
    await linkOwner(t, b, wa);
    const calls: any[] = [];
    t.app.ctx.services.channels.setTranscriber(async (o: any) => {
      calls.push(o);
      return { text: 'maak het rapport voor vandaag', engine: 'test-stt' };
    });
    const ogg = Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(200)]);
    t.script.push({ text: 'Ik ga ermee aan de slag' });
    wa.msg({ kind: 'voice', body: '', media: { name: 'spraakbericht-1.ogg', mime: 'audio/ogg', size: ogg.length, fetch: async () => ogg } });
    await until(() => wa.texts.length === 1, 5000, 'reply to voice');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mime, 'audio/ogg');
    assert.ok(calls[0].data.equals(ogg));
    const th = threadOf(t, OWNER)!;
    const m1 = t.app.ctx.store.messages(th.id).find((m) => m.role === 'user')!;
    assert.match(m1.content, /automatisch uitgeschreven.*maak het rapport voor vandaag/);
    assert.equal(m1.parts.attachments!.length, 1);
    assert.equal(m1.parts.attachments![0].mime, 'audio/ogg');

    // No engine available → the bot gets the audio file and a note, nothing breaks.
    t.app.ctx.services.channels.setTranscriber(async () => null);
    t.script.push({ text: 'ok' });
    wa.msg({ kind: 'voice', body: '', media: { name: 'spraakbericht-2.ogg', mime: 'audio/ogg', size: ogg.length, fetch: async () => ogg } });
    await until(() => wa.texts.length === 2, 5000, 'reply 2');
    const m2 = t.app.ctx.store.messages(th.id).filter((m) => m.role === 'user')[1];
    assert.match(m2.content, /\[spraakbericht bijgevoegd: spraakbericht-2\.ogg\]/);

    // Switched off per channel → not even tried.
    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { transcribeVoice: false } });
    const wa2 = await reconnected(t, b, drivers, 1);
    t.script.push({ text: 'ok' });
    wa2.msg({ kind: 'voice', body: '', media: { name: 'spraakbericht-3.ogg', mime: 'audio/ogg', size: ogg.length, fetch: async () => ogg } });
    await until(() => wa2.texts.length === 1, 5000, 'reply 3');
    assert.equal(calls.length, 1, 'transcriber not called when switched off');
  } finally {
    await t.close();
  }
});

test('whatsapp (QR): images and documents from the owner are passed to the bot as attachments', async () => {
  const t = await startTestApp();
  try {
    const { b, wa } = await setupWa(t);
    await linkOwner(t, b, wa);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(100)]);
    const pdf = Buffer.from('%PDF-1.4\n%test\n');
    t.script.push({ text: 'Mooie foto' });
    wa.msg({ kind: 'image', body: 'kijk deze offerte', media: { name: 'foto.jpg', mime: 'image/png', size: png.length, fetch: async () => png } });
    await until(() => wa.texts.length === 1, 5000, 'reply image');
    t.script.push({ text: 'Gelezen' });
    wa.msg({ kind: 'document', body: '', media: { name: 'offerte.pdf', mime: 'application/pdf', size: pdf.length, fetch: async () => pdf } });
    await until(() => wa.texts.length === 2, 5000, 'reply pdf');
    const users = t.app.ctx.store.messages(threadOf(t, OWNER)!.id).filter((m) => m.role === 'user');
    assert.equal(users[0].content, 'kijk deze offerte');
    assert.equal(users[0].parts.attachments![0].mime, 'image/png');
    assert.equal(users[1].parts.attachments![0].name, 'offerte.pdf');
    const att = t.app.ctx.store.get<any>('attachments', users[1].parts.attachments![0].id);
    assert.ok(fs.readFileSync(att.path).equals(pdf));
    // Too big for the channel limit → not downloaded, the bot is told why.
    t.script.push({ text: 'ok' });
    let fetched = false;
    wa.msg({ kind: 'document', body: '', media: { name: 'groot.zip', mime: 'application/zip', size: 80 * 1024 * 1024, fetch: async () => ((fetched = true), Buffer.alloc(1)) } });
    await until(() => wa.texts.length === 3, 5000, 'reply big');
    assert.equal(fetched, false);
    assert.match(t.app.ctx.store.messages(threadOf(t, OWNER)!.id).filter((m) => m.role === 'user')[2].content, /groot\.zip.*niet opgehaald/);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- files from bots

test('channel_send with files: workspace only, size checks; to the owner without approval only when allowed per bot; customers always ask unless trusted', async () => {
  const t = await startTestApp();
  try {
    const { a, b, wa, drivers } = await setupWa(t, { tool_groups: ['channels', 'files'], access_mode: 'auto' });
    await linkOwner(t, b, wa);
    fs.mkdirSync(path.join(a.workspace, 'rapporten'), { recursive: true });
    fs.writeFileSync(path.join(a.workspace, 'rapporten', 'dagrapport.pdf'), '%PDF-1.4 dagrapport');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const approvals = async () => (await t.api('GET', '/approvals')).filter((x: any) => x.tool === 'channel_send');

    // 1. No rule yet: sending to the owner asks first.
    t.script.push({ toolCalls: [{ name: 'channel_send', args: { binding: 'WA', to: 'eigenaar', text: 'Je dagrapport', files: ['rapporten/dagrapport.pdf'] } }] }, { text: 'Verstuurd' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'stuur me het rapport' });
    const p1 = await until(async () => (await approvals())[0], 5000, 'approval');
    assert.equal(p1.risk, 'danger');
    assert.match(p1.summary, /jou \(eigenaar\).*dagrapport\.pdf/);
    assert.equal(wa.files.length, 0);
    await t.api('POST', `/approvals/${p1.id}`, { decision: 'approve' });
    await t.waitIdle(th.id);
    assert.equal(wa.files.length, 1);
    assert.equal(wa.files[0].chatId, OWNER_JID);
    assert.equal(wa.files[0].file.name, 'dagrapport.pdf');
    assert.equal(wa.files[0].file.mime, 'application/pdf');
    assert.equal(wa.files[0].caption, '🤖 dagrapport.pdf');
    assert.match(wa.texts.at(-1)!.text, /^🤖 \*Testbot\*\nJe dagrapport/);

    // 2. The owner allows "send to me without asking" for this bot → no approval, still audited.
    const rules = await t.api('PUT', `/channels/agents/${a.id}/send-rules/owner`, { enabled: true });
    assert.equal(rules.ownerWithoutApproval, true);
    t.script.push({ toolCalls: [{ name: 'channel_send', args: { to: 'eigenaar', files: ['rapporten/dagrapport.pdf'] } }] }, { text: 'ok' });
    await t.say(th.id, 'nog een keer');
    assert.equal(wa.files.length, 2);
    assert.equal((await approvals()).length, 0);
    const audit = t.app.ctx.store.all<any>("SELECT * FROM audit WHERE kind = 'channels.send' ORDER BY id DESC LIMIT 1")[0];
    assert.ok(audit, 'audited');
    const data = JSON.parse(audit.data);
    assert.equal(data.preApproved, true);
    assert.equal(data.owner, true);
    assert.deepEqual(data.files, [{ name: 'dagrapport.pdf', size: 19 }]);

    // 3. Files outside the workspace or secrets: refused, nothing sent.
    const outside = path.join(t.dir, 'buiten.pdf');
    fs.writeFileSync(outside, 'x');
    t.script.push({ toolCalls: [{ name: 'channel_send', args: { to: 'eigenaar', files: [outside] } }] }, { text: 'ok' });
    await t.say(th.id, 'stuur dat andere bestand');
    t.script.push({ toolCalls: [{ name: 'channel_send', args: { to: 'eigenaar', files: ['../../master.key'] } }] }, { text: 'ok' });
    await t.say(th.id, 'en de sleutel');
    assert.equal(wa.files.length, 2);
    const toolMsgs = t.app.ctx.store.messages(th.id).filter((m) => m.role === 'tool').slice(-2);
    for (const m of toolMsgs) assert.match(m.content, /buiten de toegestane werkmap|beschermd/);

    // 4. Size limit of the channel (owner setting, capped by the platform).
    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { maxFileMb: 1 } });
    await reconnected(t, b, drivers, 1);
    fs.writeFileSync(path.join(a.workspace, 'groot.pdf'), Buffer.alloc(2 * 1024 * 1024, 1));
    t.script.push({ toolCalls: [{ name: 'channel_send', args: { to: 'eigenaar', files: ['groot.pdf'] } }] }, { text: 'ok' });
    await t.say(th.id, 'stuur de grote');
    assert.match(t.app.ctx.store.messages(th.id).filter((m) => m.role === 'tool').at(-1)!.content, /groot\.pdf is 2,0 MB; via “WA” kan maximaal 1,0 MB/);
  } finally {
    await t.close();
  }
});

test('channel_send to a customer: always asks, even with the owner rule; a contact trusted for this bot goes without asking; other bots still ask', async () => {
  const t = await startTestApp();
  try {
    const { a, b, wa } = await setupWa(t, { tool_groups: ['channels'], access_mode: 'auto' });
    const other = await t.agent({ name: 'Anderebot', tool_groups: ['channels'], access_mode: 'auto' });
    await linkOwner(t, b, wa);
    await t.api('PUT', `/channels/agents/${a.id}/send-rules/owner`, { enabled: true });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const approvals = async () => (await t.api('GET', '/approvals')).filter((x: any) => x.tool === 'channel_send');

    t.script.push({ toolCalls: [{ name: 'channel_send', args: { to: '31633333333', text: 'Uw offerte' } }] }, { text: 'ok' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'stuur de klant de offerte' });
    const p = await until(async () => (await approvals())[0], 5000, 'approval for customer');
    assert.equal(p.risk, 'danger');
    await t.api('POST', `/approvals/${p.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
    assert.ok(!wa.texts.some((x) => x.chatId === '31633333333@c.us'));

    // The owner trusts this customer for this bot.
    const r = await t.api('POST', `/channels/agents/${a.id}/send-rules`, { binding_id: b.id, target: '+31 6 3333 3333', label: 'Klant Jansen' });
    assert.equal(r.contacts.length, 1);
    assert.equal(r.contacts[0].target, '31633333333');
    t.script.push({ toolCalls: [{ name: 'channel_send', args: { to: '31633333333', text: 'Uw offerte' } }] }, { text: 'ok' });
    await t.say(th.id, 'nu wel');
    assert.deepEqual(wa.texts.at(-1), { chatId: '31633333333@c.us', text: 'Uw offerte' });
    assert.equal((await approvals()).length, 0);

    // Another bot sharing the same WhatsApp: no rules → asks.
    const th2 = await t.api('POST', '/threads', { agentId: other.id });
    t.script.push({ toolCalls: [{ name: 'channel_send', args: { to: '31633333333', text: 'Spam' } }] }, { text: 'ok' });
    await t.api('POST', `/threads/${th2.id}/messages`, { content: 'stuur' });
    const p2 = await until(async () => (await approvals())[0], 5000, 'approval other bot');
    assert.equal(p2.agent_id, other.id);
    await t.api('POST', `/approvals/${p2.id}`, { decision: 'deny' });
    await t.waitIdle(th2.id);

    // Number without WhatsApp → clear error; rules cannot be set by another user or for the owner himself.
    wa.noWhatsApp.add('31688888888');
    await t.api('POST', `/channels/agents/${a.id}/send-rules`, { binding_id: b.id, target: '31688888888' });
    t.script.push({ toolCalls: [{ name: 'channel_send', args: { to: '31688888888', text: 'x' } }] }, { text: 'ok' });
    await t.say(th.id, 'stuur naar 8888');
    assert.match(t.app.ctx.store.messages(th.id).filter((m) => m.role === 'tool').at(-1)!.content, /heeft geen WhatsApp/);
    await assert.rejects(t.api('POST', `/channels/agents/${a.id}/send-rules`, { binding_id: b.id, target: OWNER }), /Dat ben jij zelf/);
    const res = await fetch(t.app.url + `/api/channels/agents/${a.id}/send-rules`, { headers: { authorization: `Bearer ${t.app.ctx.auth.createSession(t.app.ctx.auth.createUser({ name: 'X', email: `x${Date.now()}@e.nl`, password: 'wachtwoord123' }).id).token}` } });
    assert.equal(res.status, 404);
  } finally {
    await t.close();
  }
});

test('channel_send files work on the other channels too (generic adapter gets out.files)', async () => {
  const t = await startTestApp();
  try {
    const sent: any[] = [];
    t.app.ctx.services.channels.registerAdapter({
      id: 'fake',
      label: 'Nep',
      description: 'test',
      needsPublicUrl: () => false,
      approveViaChannel: false,
      maxText: 1000,
      maxFileMb: 5,
      secretFields: [],
      validate: () => ({}),
      test: async () => ({ ok: true, detail: 'ok' }),
      create: () => ({
        async start() {
          return 'connected' as const;
        },
        async stop() {},
        async send(conv: any, out: any) {
          sent.push({ conv: conv.external_id, out });
          return ['x1'];
        },
        async sendTo(target: string, out: any) {
          sent.push({ target, out });
          return { conversationId: target, title: target, private: true, ids: ['x2'] };
        },
      }),
    });
    const a = await t.agent({ tool_groups: ['channels'], access_mode: 'auto' });
    const b = await t.api('POST', '/channels/bindings', { adapter: 'fake', name: 'Nep', agent_id: a.id, config: { maxFileMb: 50 } });
    await until(() => binding(t, b.id).status === 'connected', 3000, 'connected');
    await t.api('POST', `/channels/agents/${a.id}/send-rules`, { binding_id: b.id, target: 'chat-42' });
    fs.writeFileSync(path.join(a.workspace, 'foto.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    fs.writeFileSync(path.join(a.workspace, 'zes.bin'), Buffer.alloc(6 * 1024 * 1024));
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'channel_send', args: { to: 'chat-42', text: 'Kijk', files: ['foto.png'] } }] }, { text: 'ok' });
    await t.say(th.id, 'stuur de foto');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].out.files[0].name, 'foto.png');
    assert.equal(sent[0].out.files[0].mime, 'image/png');
    // The platform cap (5 MB) wins over the binding's 50 MB.
    t.script.push({ toolCalls: [{ name: 'channel_send', args: { to: 'chat-42', files: ['zes.bin'] } }] }, { text: 'ok' });
    await t.say(th.id, 'stuur de grote');
    assert.equal(sent.length, 1);
    assert.match(t.app.ctx.store.messages(th.id).filter((m) => m.role === 'tool').at(-1)!.content, /maximaal 5,0 MB/);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- routines → WhatsApp

test('routine result is delivered to the owner on WhatsApp, with the PDF the bot shared', async () => {
  const t = await startTestApp();
  try {
    const { a, b, wa } = await setupWa(t, { tool_groups: ['files', 'routines'], access_mode: 'auto' });
    await linkOwner(t, b, wa);
    fs.writeFileSync(path.join(a.workspace, 'rapport.pdf'), '%PDF-1.4 rapport');
    const r = await t.api('POST', '/routines', {
      name: 'Dagrapport',
      agent_id: a.id,
      prompt: 'Maak het dagrapport.',
      schedule: { kind: 'none' },
      options: { deliver: { bindingId: b.id, to: 'owner', withFiles: true } },
    });
    assert.deepEqual(r.options.deliver, { bindingId: b.id, to: 'owner', withFiles: true, errors: false });
    t.script.push({ toolCalls: [{ name: 'share_file', args: { path: 'rapport.pdf' } }] }, { text: 'Omzet gisteren: € 1.234' });
    await t.api('POST', `/routines/${r.id}/run`, { test: false });
    await until(() => wa.files.length === 1, 8000, 'delivered file');
    assert.equal(wa.files[0].file.name, 'rapport.pdf');
    assert.equal(wa.files[0].chatId, OWNER_JID);
    const txt = wa.texts.find((x) => /Dagrapport/.test(x.text))!;
    assert.match(txt.text, /^🤖 \*Testbot\*\n\*Dagrapport\*\n\nOmzet gisteren: € 1\.234/);
    const rr = await until(() => t.app.ctx.store.all<any>('SELECT * FROM routine_runs WHERE routine_id = ?', r.id).map((x) => t.app.ctx.store.decode<any>('routine_runs', x)).find((x) => x.meta?.delivery), 5000, 'receipt');
    assert.equal(rr.meta.delivery.status, 'sent');
    assert.equal(rr.meta.delivery.files, 1);

    // A deleted channel just stops the forwarding (no broken routine).
    await t.api('DELETE', `/channels/bindings/${b.id}`);
    const upd = await t.api('PATCH', `/routines/${r.id}`, { name: 'Dagrapport 2' });
    assert.equal(upd.options.deliver, null);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- connection lifecycle

test('whatsapp (QR): reconnect with backoff on a dropped connection; unlinked on the phone = clear error, session wiped; logout route unlinks; deleting removes the session files', async () => {
  const t = await startTestApp();
  try {
    const { b, wa, drivers } = await setupWa(t);
    await linkOwner(t, b, wa);
    const dir = path.join(t.dir, 'channels', b.id);
    fs.writeFileSync(path.join(dir, 'session.enc'), 'x');
    wa.fire('disconnected', 'NAVIGATION', false);
    await until(() => binding(t, b.id).status === 'error', 3000, 'error');
    assert.match(binding(t, b.id).last_error, /nieuwe poging over/);
    assert.equal(wa.stopped, 1, 'old connection closed');
    await until(() => drivers.length === 2, 6000, 'reconnected with a fresh driver');
    const wa2 = drivers[1];
    await until(() => wa2.started, 3000, 'started');
    wa2.fire('ready', ME);
    await until(() => binding(t, b.id).status === 'connected', 3000, 'connected again');

    // Unlinked on the phone: fatal (no retry loop), the session is wiped, the owner is told what to do.
    wa2.fire('disconnected', 'LOGOUT', true);
    await until(() => binding(t, b.id).status === 'error', 3000, 'fatal');
    assert.match(binding(t, b.id).last_error, /Ontkoppeld/);
    assert.ok(!fs.existsSync(path.join(dir, 'session.enc')));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(drivers.length, 2, 'no reconnect after an unlink');

    // Link again, then unlink from TeamBot.
    await t.api('POST', `/channels/bindings/${b.id}/whatsapp/link`);
    const wa3 = await until(() => drivers[2], 3000, 'new driver');
    wa3.link(ME);
    await until(() => binding(t, b.id).status === 'connected', 3000, 'connected 3');
    const v = await t.api('POST', `/channels/bindings/${b.id}/whatsapp/logout`);
    assert.equal(wa3.loggedOut, 1);
    assert.equal(v.enabled, false);
    assert.equal(v.status, 'stopped');
    assert.deepEqual(binding(t, b.id).state.info, {});
    assert.ok(!fs.existsSync(dir));

    // Never linked + not requested recently (e.g. app start-up) → no hidden browser, a clear hint instead.
    t.app.ctx.store.update('channel_bindings', b.id, { created_at: new Date(Date.now() - 3600_000).toISOString() });
    await t.api('POST', `/channels/bindings/${b.id}/connect`);
    await until(() => binding(t, b.id).status === 'error', 3000, 'not linked');
    assert.match(binding(t, b.id).last_error, /Nog niet gekoppeld/);
    assert.equal(drivers.length, 3, 'no browser started');
    // "Koppelen" is an explicit request: then it does start.
    await t.api('POST', `/channels/bindings/${b.id}/whatsapp/link`);
    await until(() => drivers[3]?.started, 3000, 'started on request');
    await t.api('DELETE', `/channels/bindings/${b.id}`);
    assert.equal(drivers[3].loggedOut, 1, 'deleting also unlinks on WhatsApp (no dead device on the phone)');
  } finally {
    await t.close();
  }
});

test('whatsapp (QR): a paired phone shows the QR, asks for a pairing code and manages channels (0.4.1), with the QR warning still required', async () => {
  const t = await startTestApp();
  try {
    const { b, wa } = await setupWa(t);
    wa.fire('qr', 'qr-for-phone');
    const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4748' });
    const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t')!;
    const claim = await fetch(t.app.url + '/api/public/mobile/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, name: 'Telefoon' }) });
    const device = ((await claim.json()) as any).token as string;
    const call = (method: string, p: string, body?: any) =>
      fetch(t.app.url + '/api' + p, { method, headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const st = await call('GET', `/channels/bindings/${b.id}/whatsapp`);
    assert.equal(st.status, 200);
    assert.match(((await st.json()) as any).qrSvg, /<svg/);
    const code = await call('POST', `/channels/bindings/${b.id}/whatsapp/pair-phone`, { phone: OWNER });
    assert.equal(code.status, 200);
    // Since 0.4.1 the owner's phone can do what the computer can (server/modules/mobile/policy.ts): the channel routes
    // are open to it, and the channels module's own rules still hold there, such as the QR warning before a new link.
    const made = await call('POST', '/channels/bindings', { adapter: 'whatsapp-web', name: 'x', agent_id: b.agent_id });
    assert.equal(made.status, 400);
    assert.match(((await made.json()) as any).error, /Lees eerst de waarschuwing: WhatsApp kan een nummer/);
    assert.equal((await call('POST', `/channels/bindings/${b.id}/senders`, { external_id: '316' })).status, 200);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- units

test('session store: encrypted at rest, wrong key unreadable, crash recovery keeps the newer profile, zip-slip guarded', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'tb-wa-'));
  try {
    const key = crypto.randomBytes(32);
    const s = new SessionStore(dir, key);
    assert.equal(s.restore(), 'none');
    const idb = path.join(s.profileDir, 'Default', 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb');
    fs.mkdirSync(idb, { recursive: true });
    fs.writeFileSync(path.join(idb, '000003.log'), 'SIGNAL-KEYS-PLAINTEXT');
    fs.writeFileSync(path.join(idb, 'LOCK'), '');
    fs.mkdirSync(path.join(s.profileDir, 'Default', 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(s.profileDir, 'Default', 'Cache', 'big'), Buffer.alloc(1000));
    assert.ok(s.backup() > 0);
    const blob = fs.readFileSync(s.file);
    assert.ok(!blob.includes(Buffer.from('SIGNAL-KEYS-PLAINTEXT')), 'archive is encrypted');
    s.wipeProfile();
    assert.ok(!fs.existsSync(s.profileDir), 'only the encrypted archive is left after a clean stop');
    assert.equal(s.restore(), 'backup');
    assert.equal(fs.readFileSync(path.join(idb, '000003.log'), 'utf8'), 'SIGNAL-KEYS-PLAINTEXT');
    assert.ok(!fs.existsSync(path.join(s.profileDir, 'Default', 'Cache')), 'caches are not kept');
    // Crash: plaintext profile still there → it is newer than the archive, keep it.
    fs.writeFileSync(path.join(idb, '000004.log'), 'NEWER');
    assert.equal(new SessionStore(dir, key).restore(), 'profile');
    assert.ok(fs.existsSync(path.join(idb, '000004.log')));
    // Wrong key: unreadable, never a crash.
    s.wipeProfile();
    assert.equal(new SessionStore(dir, crypto.randomBytes(32)).restore(), 'unreadable');
    // Tampering is detected (GCM).
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => decryptBlob(key, tampered));
    assert.deepEqual(decryptBlob(key, encryptBlob(key, Buffer.from('hoi'))), Buffer.from('hoi'));
    // A crafted archive cannot write outside the profile (zip-slip).
    const AdmZip = require('adm-zip');
    const evil = new AdmZip();
    evil.addFile('Default/IndexedDB/ok.log', Buffer.from('ok'));
    const z = evil.toBuffer();
    // Patch the stored entry names to "../../../evil.txt" style paths of the same length.
    const bad = Buffer.from(z.toString('latin1').split('Default/IndexedDB/ok.log').join('../../../../../evil1.log'), 'latin1');
    fs.writeFileSync(s.file, encryptBlob(key, bad));
    s.wipeProfile();
    try {
      new SessionStore(dir, key).restore();
    } catch {
      /* a corrupt archive may also just fail */
    }
    assert.ok(!fs.existsSync(path.join(dir, '..', '..', '..', 'evil1.log')) && !fs.existsSync(path.join(dir, 'evil1.log')) && !fs.existsSync(path.resolve(s.profileDir, '../../../../../evil1.log')));
    s.wipeAll();
    assert.ok(!fs.existsSync(s.file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('matchBotName: "@Naam", "Naam:", longest name first, bare names do not count', () => {
  const bots = [
    { id: 'b1', name: 'Baas' },
    { id: 'b2', name: 'Baas Live' },
    { id: 'b3', name: 'Ads & Shopping' },
  ];
  assert.deepEqual(matchBotName('@Baas maak het rapport', bots), { id: 'b1', rest: 'maak het rapport' });
  assert.deepEqual(matchBotName('baas: maak het rapport', bots), { id: 'b1', rest: 'maak het rapport' });
  assert.deepEqual(matchBotName('Baas Live, hoi', bots), { id: 'b2', rest: 'hoi' });
  assert.deepEqual(matchBotName('@Ads & Shopping budget?', bots), { id: 'b3', rest: 'budget?' });
  assert.deepEqual(matchBotName('@Baas', bots), { id: 'b1', rest: '' });
  assert.equal(matchBotName('Baas maak het rapport', bots), null);
  assert.equal(matchBotName('@Baasje hoi', bots), null);
  assert.equal(matchBotName('hoi @Baas', bots), null);
});

test('mapWwebjsMessage: self chat, LID sender resolved to a phone number, groups, media, quotes, broadcasts', async () => {
  const meIds = new Set([OWNER_JID, '99999@lid']);
  const o = { meIds, phoneOf: async (j: string) => (j === '12345@lid' ? '31622222222' : null), chatTitle: async () => 'Team' };
  const self = await mapWwebjsMessage({ id: { id: 'A1', remote: '99999@lid', fromMe: true }, fromMe: true, to: '99999@lid', body: 'hoi', type: 'chat', timestamp: 1700000000 }, o);
  assert.equal(self!.selfChat, true);
  assert.equal(self!.senderPhone, OWNER);
  const lid = await mapWwebjsMessage({ id: { id: 'A2', remote: '12345@lid' }, from: '12345@lid', body: 'vraag', type: 'chat', _data: { notifyName: 'Jan' }, timestamp: 1700000000 }, o);
  assert.equal(lid!.selfChat, false);
  assert.equal(lid!.senderPhone, '31622222222');
  assert.equal(lid!.senderName, 'Jan');
  const media = await mapWwebjsMessage(
    {
      id: { id: 'A3', remote: '120363@g.us' },
      from: '120363@g.us',
      author: '31633333333@c.us',
      hasMedia: true,
      body: '',
      type: 'ptt',
      hasQuotedMsg: true,
      mentionedIds: [OWNER_JID],
      _data: { mimetype: 'audio/ogg; codecs=opus', size: 1234, quotedStanzaID: 'OUT7' },
      downloadMedia: async () => ({ data: Buffer.from('ogg').toString('base64') }),
      timestamp: 1700000000,
    },
    o,
  );
  assert.equal(media!.isGroup, true);
  assert.equal(media!.chatTitle, 'Team');
  assert.equal(media!.kind, 'voice');
  assert.equal(media!.senderPhone, '31633333333');
  assert.equal(media!.mentionsMe, true);
  assert.equal(media!.quotedId, 'OUT7');
  assert.equal(media!.media!.mime, 'audio/ogg');
  assert.equal((await media!.media!.fetch()).toString(), 'ogg');
  const status = await mapWwebjsMessage({ id: { id: 'A4', remote: 'status@broadcast' }, isStatus: true, body: 'x', type: 'chat' }, o);
  assert.equal(status!.broadcast, true);
  assert.equal(phoneDigits('+31 6-1234 5678'), '31612345678');
  assert.equal(phoneDigits('31612345678@c.us'), '31612345678');
  assert.equal(phoneDigits('12345@lid'), '');
});

test('callRisk: per-call risk from riskFor, falls back to the static risk on errors or nonsense', () => {
  const t = { agent: {} as any, thread: {} as any, userId: 'u' };
  assert.equal(callRisk({ risk: 'danger' }, {}, t), 'danger');
  assert.equal(callRisk({ risk: 'danger', riskFor: () => 'write' }, {}, t), 'write');
  assert.equal(callRisk({ risk: 'danger', riskFor: () => 'nonsense' as any }, {}, t), 'danger');
  assert.equal(callRisk({ risk: 'danger', riskFor: () => 'read' }, {}, t), 'write', 'never below write for an impactful tool');
  assert.equal(
    callRisk(
      {
        risk: 'danger',
        riskFor: () => {
          throw new Error('x');
        },
      },
      {},
      t,
    ),
    'danger',
  );
});

test('whatsapp (QR): a real Ogg/Opus voice note is transcribed by the free local engine (no plug-in needed) and answered', async () => {
  const { fakeStt, markInstalled } = await import('./voice-fakes.js');
  const stt = fakeStt((s) => `plan morgen om tien uur de vergadering met Sanne (${s.toFixed(1)} s)`);
  const t = await startTestApp();
  try {
    markInstalled(t.dir, 'parakeet-tdt-0.6b-v3');
    const { b, wa } = await setupWa(t);
    await linkOwner(t, b, wa);
    const ogg = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'spraakbericht-nl.ogg'));
    t.script.push({ text: 'Staat erin: morgen 10:00 met Sanne.' });
    wa.msg({ kind: 'voice', body: '', media: { name: 'spraakbericht-9.ogg', mime: 'audio/ogg; codecs=opus', size: ogg.length, fetch: async () => ogg } });
    await until(() => wa.texts.length === 1, 8000, 'reply to the voice note');
    assert.match(wa.texts[0].text, /morgen 10:00 met Sanne/);
    assert.equal(stt.calls.length, 1, t.app.ctx.store.messages(threadOf(t, OWNER)!.id).find((x) => x.role === 'user')?.content || '');
    assert.equal(stt.calls[0].rate, 16000);
    assert.ok(Math.abs(stt.calls[0].seconds - 4.36) < 0.05, `decoded ${stt.calls[0].seconds} s`);
    const m = t.app.ctx.store.messages(threadOf(t, OWNER)!.id).find((x) => x.role === 'user')!;
    assert.match(m.content, /automatisch uitgeschreven.*vergadering met Sanne/);
    assert.match(JSON.stringify(t.requests.at(-1)?.messages), /vergadering met Sanne/, 'the bot got the text');
  } finally {
    stt.restore();
    await t.close();
  }
});
