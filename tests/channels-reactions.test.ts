import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import type { AdapterContext, AdapterDef, ReactionStatus } from '../server/modules/channels/types.js';
import { DISCORD_PERMISSIONS, discordAdapter } from '../server/modules/channels/adapters/discord.js';
import { SLACK_SCOPES, slackManifest } from '../server/modules/channels/adapters/slack.js';
import { DriverEmitter, type DriverOptions, type WaDriver, type WaIncoming, type WaOutFile } from '../server/modules/channels/whatsapp-web/driver.js';
import { mapWwebjsMessage } from '../server/modules/channels/whatsapp-web/wwebjs.js';

/**
 * 14.3 status reactions: 👀 when the bot starts on a message, then done or error, on every channel with reactions
 * (Telegram 👀 👍 😢, Slack/Discord/WhatsApp 👀 ✅ ❌). Off per channel; channels without reactions are skipped
 * quietly; a platform that refuses never breaks the answer. Only test doubles, never real accounts.
 */

async function until<T>(fn: () => T | Promise<T>, ms = 5000, what = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function fakeAdapter(o: { reactions?: boolean; withReact?: boolean; failReact?: boolean } = {}) {
  const state = { ctx: null as AdapterContext | null, sent: [] as string[], reacts: [] as { to: string; status: ReactionStatus }[] };
  const def: AdapterDef = {
    id: 'fake',
    label: 'Nep',
    description: 'test',
    needsPublicUrl: () => false,
    approveViaChannel: false,
    maxText: 1000,
    reactions: o.reactions !== false,
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
        async send(_conv, out) {
          state.sent.push(out.text);
          return [`out${state.sent.length}`];
        },
        ...(o.withReact !== false
          ? {
              async react(_conv: any, to: string, status: ReactionStatus) {
                state.reacts.push({ to, status });
                if (o.failReact) throw new Error('missing_scope');
              },
            }
          : {}),
      };
    },
  };
  return { def, state };
}

async function setup(t: TestApp, o: Parameters<typeof fakeAdapter>[0] = {}, config: any = {}) {
  const f = fakeAdapter(o);
  t.app.ctx.services.channels.registerAdapter(f.def);
  const a = await t.agent();
  const b = await t.api('POST', '/channels/bindings', { adapter: 'fake', name: 'Nep', agent_id: a.id, config, secrets: { token: 'fake-secret-token-123456' } });
  await until(() => f.state.ctx && t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 3000, 'fake connected');
  await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: 'u1', label: 'Jan' });
  return { f, a, b, ctx: f.state.ctx! };
}

let seq = 0;
const inbound = (over: any = {}) => ({ messageId: `m${++seq}`, conversation: { id: 'chat1', title: 'Jan', private: true }, sender: { id: 'u1', name: 'Jan' }, text: 'Hoi', ...over });

async function fakeServer(handler: (req: { url: string; body: Buffer; headers: http.IncomingHttpHeaders; method: string }, res: http.ServerResponse) => void | Promise<void>) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => void Promise.resolve(handler({ url: req.url || '/', body: Buffer.concat(chunks), headers: req.headers, method: req.method || 'GET' }, res)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}
const json = (res: http.ServerResponse, obj: any, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

test('framework: 👀 when the bot starts, then done; error when it fails; off per channel; no react or no id = quiet', async () => {
  const t = await startTestApp();
  try {
    const { f, b, ctx } = await setup(t);
    t.script.push({ text: 'Klaar!' });
    await ctx.receive(inbound({ reactTo: 'R1' }));
    await until(() => f.state.sent.length === 1, 5000, 'answer');
    await until(() => f.state.reacts.length === 2, 5000, 'done reaction');
    assert.deepEqual(f.state.reacts, [
      { to: 'R1', status: 'working' },
      { to: 'R1', status: 'done' },
    ]);
    // the bot fails: error reaction (and the usual short message)
    t.script.push({ error: { message: 'kapot', status: 400 } });
    await ctx.receive(inbound({ reactTo: 'R2' }));
    await until(() => f.state.reacts.some((r) => r.to === 'R2' && r.status === 'error'), 8000, 'error reaction');
    assert.deepEqual(f.state.reacts.filter((r) => r.to === 'R2').map((r) => r.status), ['working', 'error']);
    // a message without a platform id gets none
    const n = f.state.reacts.length;
    t.script.push({ text: 'ok' });
    await ctx.receive(inbound());
    await until(() => f.state.sent.filter((s) => s === 'ok').length === 1, 5000, 'answer 3');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.state.reacts.length, n);
    // the binding view says the platform has reactions; switched off: nothing more
    const view = await t.api('GET', `/channels/bindings/${b.id}`);
    assert.equal(view.reactionsSupported, true);
    assert.equal(view.config.reactions, true, 'on by default');
    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { reactions: false } });
    assert.equal((await t.api('GET', `/channels/bindings/${b.id}`)).config.reactions, false);
    const ctx2 = await until(() => (t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected' ? f.state.ctx : null), 3000, 'still connected');
    t.script.push({ text: 'stil' });
    await ctx2.receive(inbound({ reactTo: 'R4' }));
    await until(() => f.state.sent.includes('stil'), 5000, 'answer 4');
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!f.state.reacts.some((r) => r.to === 'R4'), 'switched off');
  } finally {
    await t.close();
  }
});

test('framework: a platform that refuses reactions never breaks the answer; channels without reactions are skipped', async () => {
  const t = await startTestApp();
  try {
    const { f, ctx, b } = await setup(t, { failReact: true });
    t.script.push({ text: 'Toch geantwoord' });
    await ctx.receive(inbound({ reactTo: 'X1' }));
    await until(() => f.state.sent.includes('Toch geantwoord'), 5000, 'answer');
    await until(() => f.state.reacts.length === 2, 5000, 'both tried');
    assert.equal(t.app.ctx.store.get<any>('channel_bindings', b.id).status, 'connected', 'the channel stays healthy');
    assert.ok(!(await t.api('GET', `/channels/bindings/${b.id}/log`)).some?.((l: any) => /missing_scope/.test(l.summary)), 'no error lines for a refused reaction');
  } finally {
    await t.close();
  }
  const t2 = await startTestApp();
  try {
    const { f, ctx, b } = await setup(t2, { reactions: false, withReact: false });
    t2.script.push({ text: 'Zonder reacties' });
    await ctx.receive(inbound({ reactTo: 'Y1' }));
    await until(() => f.state.sent.includes('Zonder reacties'), 5000, 'answer');
    assert.equal((await t2.api('GET', `/channels/bindings/${b.id}`)).reactionsSupported, false, 'no switch for a channel without reactions');
  } finally {
    await t2.close();
  }
});

test('telegram: setMessageReaction with the allowed emoji 👀 then 👍 (fake Bot API)', async () => {
  const token = '123456789:' + 'B'.repeat(35);
  const updates: any[] = [];
  const reactions: any[] = [];
  const sent: any[] = [];
  const tg = await fakeServer(async (req, res) => {
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)/);
    if (!m || m[1] !== token) return json(res, { ok: false, error_code: 401 }, 401);
    const body = req.body.length ? JSON.parse(req.body.toString()) : {};
    if (m[2] === 'getMe') return json(res, { ok: true, result: { id: 999, is_bot: true, first_name: 'TB', username: 'tb_test_bot' } });
    if (m[2] === 'getUpdates') {
      const ready = updates.filter((u) => u.update_id >= Number(body.offset || 0));
      if (!ready.length) await new Promise((r) => setTimeout(r, 120));
      return json(res, { ok: true, result: ready });
    }
    if (m[2] === 'setMessageReaction') reactions.push(body);
    if (m[2] === 'sendMessage') sent.push(body);
    return json(res, { ok: true, result: m[2] === 'sendMessage' ? { message_id: 500, chat: { id: body.chat_id } } : true });
  });
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const b = await t.api('POST', '/channels/bindings', { adapter: 'telegram', name: 'TG', agent_id: a.id, config: { apiBase: tg.url }, secrets: { token } });
    await until(() => t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 5000, 'telegram connected');
    await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: '42', label: 'Jan' });
    assert.equal((await t.api('GET', `/channels/bindings/${b.id}`)).reactionsSupported, true);
    t.script.push({ text: 'Gedaan' });
    updates.push({ update_id: 1, message: { message_id: 77, date: Math.floor(Date.now() / 1000), from: { id: 42, first_name: 'Jan' }, chat: { id: 42, type: 'private' }, text: 'Doe iets' } });
    await until(() => reactions.length === 2, 8000, 'two reactions');
    assert.deepEqual(reactions.map((r) => [String(r.chat_id), r.message_id, r.reaction[0].emoji]), [
      ['42', 77, '👀'],
      ['42', 77, '👍'],
    ]);
    assert.ok(reactions.every((r) => r.reaction[0].type === 'emoji'));
    assert.ok(sent.some((s) => /Gedaan/.test(s.text)));
  } finally {
    await t.close();
    await tg.close();
  }
});

test('slack: reactions.add eyes, then eyes off and white_check_mark on; manifest asks reactions:write', async () => {
  const calls: { method: string; body: any }[] = [];
  const sl = await fakeServer((req, res) => {
    const method = req.url.replace(/^\/api\//, '');
    const body = req.body.length && String(req.headers['content-type']).includes('json') ? JSON.parse(req.body.toString()) : {};
    calls.push({ method, body });
    if (method === 'auth.test') return json(res, { ok: true, user_id: 'UBOT', team: 'T', team_id: 'T1', bot_id: 'B1' });
    if (method === 'users.info') return json(res, { ok: true, user: { real_name: 'Jan', profile: { display_name: 'Jan' } } });
    if (method === 'chat.postMessage') return json(res, { ok: true, channel: body.channel, ts: '1700000000.000200' });
    if (method === 'reactions.remove' && !calls.some((c) => c.method === 'reactions.add')) return json(res, { ok: false, error: 'no_reaction' });
    return json(res, { ok: true });
  });
  assert.ok(SLACK_SCOPES.includes('reactions:write'));
  assert.ok(slackManifest({ name: 'Bot', mode: 'socket' }).oauth_config.scopes.bot.includes('reactions:write'));
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const secret = crypto.randomBytes(16).toString('hex');
    const b = await t.api('POST', '/channels/bindings', { adapter: 'slack', name: 'Slack', agent_id: a.id, config: { mode: 'events', apiBase: sl.url + '/api' }, secrets: { botToken: 'xoxb-test-token', signingSecret: secret } });
    await until(() => t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'listening', 5000, 'slack listening');
    await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: 'U1', label: 'Jan' });

    const hook = `/api/public/hooks/channels/${b.id}/slack`;
    t.script.push({ text: 'Klaar' });
    const payload = JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'Hoi', ts: '1700000000.000100' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${payload}`).digest('hex');
    const r = await fetch(t.app.url + hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body: payload });
    assert.equal(r.status, 200);
    await until(() => calls.filter((c) => c.method === 'reactions.add').length === 2, 8000, 'two reactions');
    const rx = calls.filter((c) => c.method.startsWith('reactions.')).map((c) => [c.method, c.body.channel, c.body.timestamp, c.body.name]);
    assert.deepEqual(rx, [
      ['reactions.add', 'D1', '1700000000.000100', 'eyes'],
      ['reactions.remove', 'D1', '1700000000.000100', 'eyes'],
      ['reactions.add', 'D1', '1700000000.000100', 'white_check_mark'],
    ]);

  } finally {
    await t.close();
    await sl.close();
  }
});

test('discord: Add Reactions in the invite permissions; 👀 then 👀 off and ✅ on via the REST client (test double)', async () => {
  assert.equal(BigInt(DISCORD_PERMISSIONS) & 64n, 64n, 'Add Reactions');
  const rest: { method: string; route: string }[] = [];
  const rt = discordAdapter.create({ binding: () => ({ config: {} }), signal: new AbortController().signal } as any) as any;
  rt.client = { rest: { put: async (route: string) => void rest.push({ method: 'PUT', route }), delete: async (route: string) => void rest.push({ method: 'DELETE', route }) } };
  await rt.react({}, '111111111111:222222222222', 'working');
  await rt.react({}, '111111111111:222222222222', 'done');
  await rt.react({}, 'kapot', 'error');
  const e = (s: string) => encodeURIComponent(s);
  assert.deepEqual(rest, [
    { method: 'PUT', route: `/channels/111111111111/messages/222222222222/reactions/${e('👀')}/@me` },
    { method: 'DELETE', route: `/channels/111111111111/messages/222222222222/reactions/${e('👀')}/@me` },
    { method: 'PUT', route: `/channels/111111111111/messages/222222222222/reactions/${e('✅')}/@me` },
  ]);
});

class FakeWa extends DriverEmitter implements WaDriver {
  texts: string[] = [];
  reacts: { key: string; emoji: string }[] = [];
  constructor(public o: DriverOptions) {
    super();
  }
  fire(event: string, ...args: any[]) {
    (this as any).emit(event, ...args);
  }
  async start() {
    fs.mkdirSync(path.join(this.o.dir, 'profile', 'Default'), { recursive: true });
  }
  async stop() {}
  async logout() {}
  async requestPairingCode() {
    return 'PAIR0000';
  }
  async sendText(_chatId: string, text: string) {
    this.texts.push(text);
    return `OUT${this.texts.length}`;
  }
  async sendFile(_c: string, _f: WaOutFile) {
    return 'F1';
  }
  async typing() {}
  async react(key: string, emoji: string) {
    this.reacts.push({ key, emoji });
  }
  async resolveNumber(phone: string) {
    return `${phone}@c.us`;
  }
}

test('whatsapp (QR): the driver reacts on the serialized message id with 👀 then ✅ (client.sendReaction)', async () => {
  // the wwebjs mapping keeps the serialized id for sendReaction
  const mapped = await mapWwebjsMessage({ id: { id: 'ABC', remote: '31611111111@c.us', _serialized: 'false_31611111111@c.us_ABC' }, from: '31611111111@c.us', body: 'x', type: 'chat', timestamp: 1 }, { meIds: new Set(), phoneOf: async () => null, chatTitle: async () => undefined });
  assert.equal(mapped!.key, 'false_31611111111@c.us_ABC');
  const t = await startTestApp();
  try {
    const drivers: FakeWa[] = [];
    t.app.ctx.services.channels.setWhatsAppDriverFactory((o: DriverOptions) => {
      const d = new FakeWa(o);
      drivers.push(d);
      return d;
    });
    const a = await t.agent({ name: 'Testbot' });
    const b = await t.api('POST', '/channels/bindings', { adapter: 'whatsapp-web', name: 'WA', agent_id: a.id, config: { riskAccepted: true } });
    const wa = await until(() => drivers.at(-1), 3000, 'driver');
    const OWNER = '31600000001';
    const ME = { jid: `${OWNER}@c.us`, phone: OWNER, name: 'Sanne' };
    wa.fire('qr', '2@abc,def,ghi');
    wa.fire('authenticated');
    wa.fire('ready', ME);
    await until(() => t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 3000, 'connected');
    t.script.push({ text: 'Hallo' });
    const m: WaIncoming = { id: 'IN1', key: `true_${OWNER}@c.us_IN1`, chatId: `${OWNER}@c.us`, fromMe: true, selfChat: true, isGroup: false, senderPhone: OWNER, senderJid: `${OWNER}@c.us`, senderName: 'Sanne', kind: 'text', body: 'Hoi bot', timestamp: Date.now() };
    wa.fire('message', m);
    await until(() => wa.reacts.length === 2, 8000, 'two reactions');
    assert.deepEqual(wa.reacts, [
      { key: `true_${OWNER}@c.us_IN1`, emoji: '👀' },
      { key: `true_${OWNER}@c.us_IN1`, emoji: '✅' },
    ]);
    assert.equal(wa.texts.length, 1);
  } finally {
    await t.close();
  }
});
