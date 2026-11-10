// Channel health: "verbonden" only after TeamBot really received AND sent a message with the current settings; a
// transport that is merely up says "verbonden, nog niet getest" with a next step; a failure says exactly why.
// Plus the picker (Telegram first) and the WhatsApp (QR) warning that must be accepted before connecting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp, type TestApp } from './helpers.js';
import type { AdapterContext, AdapterDef, Outbound } from '../server/modules/channels/types.js';
import type { ChannelManager } from '../server/modules/channels/manager.js';
import { computeHealth, parseTestCode } from '../server/modules/channels/health.js';
import { hmacHex } from '../server/modules/channels/security.js';
import { healthBadge, newSecretAction, nextStep, type HealthState } from '../ui/src/modules/channels/health.js';
import { ADAPTER_ORDER, PICK_BADGE, QR_RISK, RECOMMENDED, needsRiskAck, pickerOrder } from '../ui/src/modules/channels/picker.js';

async function until<T>(fn: () => T | Promise<T>, ms = 5000, what = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function fakeAdapter(id = 'fake', hint?: string) {
  const state = { ctx: null as AdapterContext | null, sent: [] as { conv: string; out: Outbound }[], fail: '' };
  const def: AdapterDef = {
    id,
    label: 'Nep',
    description: 'test',
    needsPublicUrl: () => false,
    approveViaChannel: true,
    maxText: 4000,
    secretFields: [{ key: 'token', label: 'Token', required: true }],
    validate: (c) => ({ mode: c.mode === 'b' ? 'b' : 'a' }),
    test: async () => ({ ok: true, detail: 'ok' }),
    ...(hint ? { receiveHint: () => hint } : {}),
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
          if (state.fail) throw new Error(state.fail);
          state.sent.push({ conv: target, out });
          return { conversationId: target, title: target, private: true, ids: [`new${state.sent.length}`] };
        },
      };
    },
  };
  return { def, state };
}

let seq = 0;
const msg = (over: any = {}) => ({ messageId: `h${++seq}`, conversation: { id: 'chat1', title: 'Jan', private: true }, sender: { id: 'u1', name: 'Jan' }, text: 'Hoi', ...over });

async function setup(t: TestApp, o: { hint?: string; id?: string } = {}) {
  const f = fakeAdapter(o.id || 'fake', o.hint);
  t.app.ctx.services.channels.registerAdapter(f.def);
  const a = await t.agent();
  const b = await t.api('POST', '/channels/bindings', { adapter: f.def.id, name: 'Nep', agent_id: a.id, config: {}, secrets: { token: 'fake-secret-token-123456' } });
  await until(() => f.state.ctx && t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 3000, 'connected');
  const m = t.app.ctx.services.channels.manager as ChannelManager;
  const view = async () => t.api('GET', `/channels/bindings/${b.id}`);
  return { f, a, b, ctx: f.state.ctx!, m, view };
}

async function fakeServer(handler: (req: { method: string; url: string; body: Buffer; headers: http.IncomingHttpHeaders }, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler({ method: req.method || 'GET', url: req.url || '/', body: Buffer.concat(chunks), headers: req.headers }, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
const json = (res: http.ServerResponse, obj: any, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

// ---------------------------------------------------------------- never a false green tick

test('a channel that can send but not receive never shows "verbonden"', async () => {
  const t = await startTestApp();
  try {
    const { f, b, m, view } = await setup(t, { hint: 'Stuurde je het naar de juiste bot?' });
    let v = await view();
    assert.equal(v.status, 'connected', 'the transport is up');
    assert.equal(v.health.state, 'untested');
    assert.notEqual(healthBadge(v).label, 'Verbonden');
    assert.equal(healthBadge(v).label, 'Verbonden, nog niet getest');
    assert.ok(nextStep(v), 'with a clear next step');

    // Sending works (the bot sends a message to someone) …
    await m.sendNew(m.binding(b.id)!, '424242', { text: 'Hallo' });
    v = await view();
    assert.equal(v.health.sendOk, true);
    assert.equal(v.health.receiveOk, false);
    assert.equal(v.health.state, 'untested', 'sending alone is not enough');
    assert.equal(healthBadge(v).label, 'Verbonden, nog niet getest');

    // … but the receive test gets nothing: the channel says that receiving fails, and why.
    m.healthTestMs = 80;
    const test1 = await t.api('POST', `/channels/bindings/${b.id}/health-test`);
    assert.match(test1.text, /^test [A-Z0-9]{6}$/);
    assert.ok((await view()).health.testing, 'test is running');
    v = await until(async () => {
      const x = await view();
      return x.health.state === 'receive_failed' ? x : null;
    }, 3000, 'test timeout');
    assert.match(v.health.reason, /Er kwam geen testbericht binnen\. Stuurde je het naar de juiste bot\?/);
    assert.equal(healthBadge(v).label, 'Ontvangen lukt niet');
    assert.equal(v.health.lastTest.ok, false);
    assert.match(v.health.lastError.text, /geen testbericht/);
    const list = await t.api('GET', '/channels/bindings');
    assert.notEqual(healthBadge(list[0]).label, 'Verbonden');

    // A real message arrives and is answered: now, and only now, "verbonden".
    await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: 'u1', label: 'Jan' });
    t.script.push({ text: 'Hallo Jan' });
    const r = await f.state.ctx!.receive(msg());
    await t.waitIdle(r.threadId!);
    v = await view();
    assert.equal(v.health.state, 'ok');
    assert.equal(healthBadge(v).label, 'Verbonden');
    assert.ok(v.health.inAt && v.health.outAt);
    assert.ok(v.health.day.in >= 1 && v.health.day.out >= 2);
  } finally {
    await t.close();
  }
});

test('the receive + send test: the code from the owner (even before he is on the allowlist) proves both directions', async () => {
  const t = await startTestApp();
  try {
    const { f, b, view } = await setup(t);
    const started = await t.api('POST', `/channels/bindings/${b.id}/health-test`);
    const code = started.code;
    // Someone else writes meanwhile: blocked, but it does prove that messages arrive.
    const other = await f.state.ctx!.receive(msg({ sender: { id: 'x', name: 'X' }, conversation: { id: 'x', private: true }, text: 'hallo' }));
    assert.equal(other.status, 'blocked');
    const r = await f.state.ctx!.receive(msg({ sender: { id: 'me', name: 'Ik' }, conversation: { id: 'me', private: true }, text: `test ${code.toLowerCase()}` }));
    assert.equal(r.status, 'command');
    assert.equal(f.state.sent.length, 1);
    assert.equal(f.state.sent[0].conv, 'me');
    assert.match(f.state.sent[0].out.text, /^✅ Het werkt: TeamBot ontvangt je berichten via Nep en kan antwoorden\.$/);
    const v = await view();
    assert.equal(v.health.state, 'ok');
    assert.equal(v.health.lastTest.ok, true);
    assert.equal(v.health.testing, null);
    assert.equal(v.senders.length, 0, 'the test does not put anyone on the allowlist');
    assert.equal(t.app.ctx.store.one<any>("SELECT COUNT(*) n FROM threads WHERE kind = 'channel'")!.n, 0, 'and starts no conversation with the bot');
    // A used code does nothing any more.
    const again = await f.state.ctx!.receive(msg({ sender: { id: 'me', name: 'Ik' }, conversation: { id: 'me', private: true }, text: `test ${code}` }));
    assert.equal(again.status, 'blocked');
  } finally {
    await t.close();
  }
});

test('the test code from a sender whose reply fails: receiving works, sending fails, with the exact error', async () => {
  const t = await startTestApp();
  try {
    const { f, b, view } = await setup(t);
    const { code } = await t.api('POST', `/channels/bindings/${b.id}/health-test`);
    f.state.fail = 'Forbidden: bot was blocked by the user';
    await f.state.ctx!.receive(msg({ text: `/test ${code}` }));
    const v = await view();
    assert.equal(v.health.receiveOk, true);
    assert.equal(v.health.state, 'send_failed');
    assert.match(v.health.reason, /Versturen mislukt: Forbidden: bot was blocked by the user/);
    assert.equal(healthBadge(v).label, 'Versturen lukt niet');
    assert.match(v.health.lastTest.text, /Ontvangen werkt, maar versturen lukte niet/);
  } finally {
    await t.close();
  }
});

test('Telegram-style pairing in one step also proves both directions; new settings need a new test', async () => {
  const t = await startTestApp();
  try {
    const { f, b, view } = await setup(t);
    const pc = await t.api('POST', `/channels/bindings/${b.id}/pair-codes`, { owner: true, label: 'Mijn telefoon' });
    await f.state.ctx!.receive(msg({ text: `/start ${pc.code}` }));
    let v = await view();
    assert.equal(v.health.state, 'ok', 'the pairing message came in and the "Gekoppeld!" reply went out');
    // A setting that does not touch the connection keeps the proof …
    await t.api('PATCH', `/channels/bindings/${b.id}`, { name: 'Andere naam', config: { maxFileMb: 5 } });
    assert.equal((await view()).health.state, 'ok');
    // … a new token does not.
    await t.api('PATCH', `/channels/bindings/${b.id}`, { secrets: { token: 'another-secret-token-654321' } });
    await until(() => t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 3000, 'reconnected');
    v = await view();
    assert.equal(v.health.state, 'untested');
    assert.equal(v.health.receiveOk, false);
  } finally {
    await t.close();
  }
});

test('other messages during the test: receiving works, but the code was not in them', async () => {
  const t = await startTestApp();
  try {
    const { f, b, m, view } = await setup(t);
    await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: 'u1', label: 'Jan' });
    m.healthTestMs = 300;
    await t.api('POST', `/channels/bindings/${b.id}/health-test`);
    t.script.push({ text: 'ok' });
    const r = await f.state.ctx!.receive(msg({ text: 'test' }));
    await t.waitIdle(r.threadId!);
    const v = await until(async () => {
      const x = await view();
      return x.health.lastTest ? x : null;
    }, 3000, 'test result');
    assert.equal(v.health.lastTest.ok, false);
    assert.match(v.health.lastTest.text, /wel berichten binnen, maar geen met de testcode/);
    assert.equal(v.health.state, 'ok', 'the message and the answer proved both directions anyway');
  } finally {
    await t.close();
  }
});

test('WhatsApp Business: no public address, then Meta verifies the webhook, a wrong signature: each says exactly why', async () => {
  const meta = await fakeServer((req, res) => {
    if (req.headers.authorization !== 'Bearer EAAtesttoken') return json(res, { error: { message: 'bad token', code: 190 } }, 401);
    if (req.url.includes('/messages')) return json(res, { messages: [{ id: 'wamid.out' }] });
    return json(res, { display_phone_number: '+31 6 0000', verified_name: 'Fietswinkel' });
  });
  const t = await startTestApp();
  try {
    const appSecret = 'abcdef0123456789abcdef0123456789';
    const a = await t.agent();
    const b = await t.api('POST', '/channels/bindings', {
      adapter: 'whatsapp',
      name: 'WhatsApp',
      agent_id: a.id,
      config: { phoneNumberId: '1234567', apiBase: meta.url },
      secrets: { accessToken: 'EAAtesttoken', appSecret, verifyToken: 'verify-token-123456' },
    });
    await until(() => t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'listening', 5000, 'listening');
    let v = await t.api('GET', `/channels/bindings/${b.id}`);
    assert.equal(v.info.verifiedName, 'Fietswinkel', 'the token and number were checked at start');
    assert.equal(v.health.state, 'receive_failed', 'listening is not receiving without a public address');
    assert.match(v.health.reason, /WhatsApp kan TeamBot niet bereiken: er is geen publiek https-adres ingesteld/);

    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { publicBaseUrl: 'https://bot.voorbeeld.nl' } });
    await until(() => t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'listening', 5000, 'listening again');
    v = await t.api('GET', `/channels/bindings/${b.id}`);
    assert.equal(v.health.state, 'untested');

    const hook = `${t.app.url}/api/public/hooks/channels/${b.id}/whatsapp`;
    // A request with a wrong signature before any real message: most likely a wrong app secret.
    const raw = JSON.stringify({ entry: [] });
    assert.equal((await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + hmacHex('wrong-secret', raw) }, body: raw })).status, 401);
    v = await t.api('GET', `/channels/bindings/${b.id}`);
    assert.equal(v.health.state, 'receive_failed');
    assert.match(v.health.reason, /ongeldige handtekening.*controleer dan het geheim/);

    // Meta's own check of the webhook: recorded, but not yet a message.
    assert.equal((await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=verify-token-123456&hub.challenge=XYZ`)).status, 200);
    v = await t.api('GET', `/channels/bindings/${b.id}`);
    assert.ok(v.health.platformAt);
    // Nothing arrives during the test: the reason says Meta verified the webhook but sent no message.
    const m = t.app.ctx.services.channels.manager as ChannelManager;
    m.healthTestMs = 80;
    await t.api('POST', `/channels/bindings/${b.id}/health-test`);
    v = await until(async () => {
      const x = await t.api('GET', `/channels/bindings/${b.id}`);
      return x.health.lastTest ? x : null;
    }, 3000, 'test result');
    assert.match(v.health.reason, /Meta heeft de webhook bevestigd, maar stuurde geen bericht\. Vink bij Webhook-velden “messages” aan/);

    // A signed message: received; the bot's answer goes out: verified.
    await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: '31612345678', label: 'Jan' });
    t.script.push({ text: 'Hallo!' });
    const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1234567' }, contacts: [{ wa_id: '31612345678', profile: { name: 'Jan' } }], messages: [{ from: '31612345678', id: 'wamid.in1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hoi' } }] } }] }] });
    assert.equal((await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + hmacHex(appSecret, body) }, body })).status, 200);
    v = await until(async () => {
      const x = await t.api('GET', `/channels/bindings/${b.id}`);
      return x.health.state === 'ok' ? x : null;
    }, 5000, 'verified');
    assert.equal(healthBadge(v).label, 'Verbonden');
  } finally {
    await t.close();
    await meta.close();
  }
});

test('channels from before 0.4 get their health from the log', async () => {
  const t = await startTestApp();
  try {
    const { f, b, m, view } = await setup(t);
    await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: 'u1', label: 'Jan' });
    t.script.push({ text: 'Hoi' });
    const r = await f.state.ctx!.receive(msg());
    await t.waitIdle(r.threadId!);
    t.app.ctx.store.exec("UPDATE channel_bindings SET health = '{}' WHERE id = ?", b.id);
    (m as any).initHealth();
    const v = await view();
    assert.equal(v.health.state, 'ok');
    assert.ok(v.health.inAt);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- Telegram first, QR behind a warning

test('the picker puts Telegram first as the easy, safe default; WhatsApp (QR) stays behind a warning, Business behind Meer opties', () => {
  assert.equal(ADAPTER_ORDER[0], 'telegram');
  assert.equal(RECOMMENDED, 'telegram');
  assert.equal(PICK_BADGE.telegram.text, 'Makkelijkst en veiligst');
  assert.equal(PICK_BADGE.telegram.tone, 'ok');
  assert.deepEqual(ADAPTER_ORDER.slice(0, 3), ['telegram', 'whatsapp-web', 'email']);
  assert.equal(ADAPTER_ORDER.at(-1), 'whatsapp');
  assert.equal(PICK_BADGE['whatsapp-web'].tone, 'danger');
  assert.deepEqual(pickerOrder(['webhook', 'whatsapp-web', 'telegram', 'email']), ['telegram', 'whatsapp-web', 'email', 'webhook']);
  assert.equal(needsRiskAck('whatsapp-web'), true);
  assert.equal(needsRiskAck('telegram'), false);
  assert.match(QR_RISK.lines.join(' '), /voorgoed/);
});

test('the QR warning must be accepted before a WhatsApp (QR) channel can be made; existing ones keep working', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    await assert.rejects(t.api('POST', '/channels/bindings', { adapter: 'whatsapp-web', name: 'WhatsApp', agent_id: a.id, enabled: false, config: {} }), /blokkeren, ook voorgoed/);
    assert.equal(t.app.ctx.store.one<any>('SELECT COUNT(*) n FROM channel_bindings')!.n, 0);
    const b = await t.api('POST', '/channels/bindings', { adapter: 'whatsapp-web', name: 'WhatsApp', agent_id: a.id, enabled: false, config: { riskAccepted: true } });
    assert.ok(b.config.riskAcceptedAt, 'when the owner accepted is kept');
    // Later changes do not ask again; a channel from before 0.4 (no acceptance stored) can still be changed.
    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { selfChat: true } });
    t.app.ctx.store.exec("UPDATE channel_bindings SET config = json_remove(config, '$.riskAcceptedAt') WHERE id = ?", b.id);
    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { allowGroups: false } });
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- pure parts

test('health states in words: only "ok" is "Verbonden"', () => {
  const base = { receiveOk: false, sendOk: false, sendNeeded: true, inAt: null, outAt: null, platformAt: null, lastError: null, testing: null, lastTest: null, day: { in: 0, out: 0, errors: 0 }, reason: null };
  const states: HealthState[] = ['off', 'connecting', 'error', 'untested', 'receive_failed', 'send_failed', 'ok'];
  for (const s of states) {
    const label = healthBadge({ enabled: true, status: 'connected', health: { ...base, state: s } }).label;
    assert.equal(label === 'Verbonden', s === 'ok', `${s} → ${label}`);
  }
  // Without health information (an older server): never green.
  assert.equal(healthBadge({ enabled: true, status: 'listening' }).label, 'Verbonden, nog niet getest');
  assert.equal(healthBadge({ enabled: false, status: 'connected' }).label, 'Uit');
  assert.equal(healthBadge({ enabled: true, status: 'connecting', link: { phase: 'qr' } }).label, 'Wacht op koppelen');

  const b = { adapter: 'webhook', config: { replyMode: 'none' }, enabled: true, status: 'listening' as const, last_error: null };
  const def = { label: 'Webhook', needsPublicUrl: () => false };
  assert.equal(computeHealth({ ...b, health: { receiveOkAt: '2026-01-01T00:00:00.000Z' } }, def, { webhookUrl: '', day: { in: 0, out: 0, errors: 0 } }).state, 'ok', 'a webhook without replies only needs to receive');
  assert.equal(computeHealth({ ...b, config: {}, health: { receiveOkAt: '2026-01-01T00:00:00.000Z' } }, def, { webhookUrl: '', day: { in: 0, out: 0, errors: 0 } }).state, 'untested');
  assert.equal(parseTestCode('/start test_AB12CD'), 'AB12CD');
  assert.equal(parseTestCode('Onderwerp: test ab12cd\n\nhoi'), 'AB12CD');
  assert.equal(parseTestCode('ik test kabels'), 'KABELS');
  assert.equal(parseTestCode('testen is leuk'), null);
});

test('a refused token shows the way to a new one (the channel page offers "Nieuwe token invullen")', async () => {
  // Telegram refuses the token (HTTP 401), Meta refuses the access token (code 190): the reasons the adapters give.
  const tg = await fakeServer((_req, res) => json(res, { ok: false, error_code: 401, description: 'Unauthorized' }, 401));
  const meta = await fakeServer((_req, res) => json(res, { error: { message: 'bad token', code: 190 } }, 401));
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const telegram = await t.api('POST', '/channels/bindings', { adapter: 'telegram', name: 'Telegram', agent_id: a.id, config: { apiBase: tg.url }, secrets: { token: '123456789:AAFakeFakeFakeFakeFakeFakeFakeFake12' } });
    const wa = await t.api('POST', '/channels/bindings', { adapter: 'whatsapp', name: 'WhatsApp', agent_id: a.id, config: { phoneNumberId: '1234567', apiBase: meta.url }, secrets: { accessToken: 'EAAverlopen', appSecret: 'abcdef0123456789abcdef0123456789', verifyToken: 'verify-token-123456' } });
    for (const b of [telegram, wa]) await until(() => t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'error', 8000, `${b.name} error`);
    for (const b of [telegram, wa]) {
      const v = await t.api('GET', `/channels/bindings/${b.id}`);
      assert.equal(v.health.state, 'error');
      assert.equal(newSecretAction(v), 'Nieuwe token invullen', `${b.name}: ${v.health.reason}`);
    }
  } finally {
    await t.close();
    await tg.close();
    await meta.close();
  }
  const base = { receiveOk: false, sendOk: false, sendNeeded: true, inAt: null, outAt: null, platformAt: null, lastError: null, testing: null, lastTest: null, day: { in: 0, out: 0, errors: 0 } };
  const view = (adapter: string, reason: string, state: HealthState = 'error') => ({ adapter, status: 'error' as const, enabled: true, health: { ...base, state, reason } });
  assert.equal(newSecretAction(view('email', 'IMAP: inloggen geweigerd. Controleer gebruikersnaam en (app-)wachtwoord.')), 'Ander wachtwoord invullen');
  assert.equal(newSecretAction(view('slack', 'Slack weigert de token (invalid_auth). Controleer de tokens in je Slack-app.')), 'Nieuwe token invullen');
  assert.equal(newSecretAction(view('discord', 'Discord weigert de bot-token. Maak een nieuwe in de Developer Portal (Bot › Reset Token).')), 'Nieuwe token invullen');
  assert.equal(newSecretAction(view('slack', 'App-level token (xapp-) ontbreekt')), 'Nieuwe token invullen');
  // Other problems are not about the token: no such button.
  assert.equal(newSecretAction(view('email', 'IMAP: de server 127.0.0.1 weigert de verbinding op poort 9.')), null);
  assert.equal(newSecretAction(view('telegram', 'Telegram niet bereikbaar: ENOTFOUND')), null);
  assert.equal(newSecretAction({ ...view('telegram', 'Telegram weigert de bot-token'), enabled: false }), null, 'a channel that is off');
  assert.equal(newSecretAction(view('telegram', 'Telegram weigert de bot-token', 'ok')), null, 'only while it fails');
});
