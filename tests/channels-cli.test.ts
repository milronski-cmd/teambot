import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import channels from '../server/modules/channels/index.js';
import { refusalText } from '../server/modules/channels/manager.js';
import type { AdapterContext, AdapterDef, Outbound } from '../server/modules/channels/types.js';
import type { AgentRunRequest } from '../server/core/types.js';

// Channels with bots on a CLI engine (B-61). A CLI brings its own tools, which the channel tool filter cannot cap:
// Claude Code can run without any tools, so "Alleen praten" works there (its chat mode); Codex/OpenCode cannot, and
// "Alleen lezen" cannot be held per sender on any CLI, so those messages are refused — and the owner is told.

async function until<T>(fn: () => T | Promise<T>, ms = 5000, what = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function fakeAdapter() {
  const state = { ctx: null as AdapterContext | null, sent: [] as { conv: string; out: Outbound }[] };
  const def: AdapterDef = {
    id: 'fake',
    label: 'Nep',
    description: 'test',
    needsPublicUrl: () => false,
    approveViaChannel: false,
    maxText: 1000,
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
          state.sent.push({ conv: conv.external_id, out });
          return [`out${state.sent.length}`];
        },
      };
    },
  };
  return { def, state };
}

/** Fake CLI engines: they record the access mode TeamBot started them with. */
function cliKinds(t: TestApp) {
  const calls: { kind: string; req: AgentRunRequest }[] = [];
  for (const [id, label] of [
    ['claude-code', 'Claude Code'],
    ['codex-cli', 'Codex'],
  ] as const)
    t.app.ctx.providers.registerKind({
      id,
      label,
      type: 'cli',
      needsKey: false,
      description: 'test',
      models: ['default'],
      defaultModel: 'default',
      create: () => ({
        kind: id,
        async listModels() {
          return [{ id: 'default' }];
        },
        async test() {
          return { ok: true, detail: 'nep' };
        },
        async runAgent(req) {
          calls.push({ kind: id, req });
          return { text: `${label} antwoordt (${req.accessMode})`, usage: { input: 1, output: 1 } };
        },
      }),
    });
  return calls;
}

let seq = 0;
const msg = (sender: string, text = 'Hoi bot') => ({ messageId: `c${++seq}`, conversation: { id: `chat-${sender}`, title: sender, private: true }, sender: { id: sender, name: sender }, text });

async function setup(kind: 'claude-code' | 'codex-cli', config: Record<string, any>) {
  const t = await startTestApp({ modules: [channels] });
  const calls = cliKinds(t);
  const f = fakeAdapter();
  t.app.ctx.services.channels.registerAdapter(f.def);
  const prov = await t.api('POST', '/providers', { kind });
  const bot = await t.api('POST', '/agents', { name: kind === 'claude-code' ? 'Claudia' : 'Codie', provider_id: prov.id, model: 'default', access_mode: 'ask' });
  const b = await t.api('POST', '/channels/bindings', { adapter: 'fake', name: 'Nep', agent_id: bot.id, config, secrets: { token: 'fake-secret-token-123456' } });
  await until(() => f.state.ctx && t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 3000, 'connected');
  await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: 'vriend', label: 'Vriend' });
  await t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: 'ik', label: 'Sanne', is_owner: true });
  const notes: any[] = [];
  t.app.ctx.events.subscribe((e) => e.type === 'notification' && e.data.kind === 'channel' && notes.push(e.data));
  return { t, calls, f, bot, b, ctx: f.state.ctx!, notes };
}

test('Claude Code bot: "Alleen praten" really works — the friend gets an answer from Claude Code without any tools', async () => {
  const { t, calls, f, b, ctx } = await setup('claude-code', { othersAccess: 'none', ownerAccess: 'agent' });
  try {
    const view = await t.api('GET', `/channels/bindings/${b.id}`);
    assert.deepEqual(view.engine, { type: 'cli', kind: 'claude-code', label: 'Claude Code', levels: ['none', 'agent'] });

    const r = await ctx.receive(msg('vriend', 'Wat is de hoofdstad van Frankrijk?'));
    assert.equal(r.status, 'ok');
    assert.equal(r.refused, undefined);
    await t.waitIdle(r.threadId!);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].req.accessMode, 'chat', 'started in chat mode (no tools)');
    const run = t.app.ctx.store.all<any>('SELECT meta FROM runs WHERE thread_id = ?', r.threadId).map((x) => JSON.parse(x.meta))[0];
    assert.equal(run.override.access_mode, 'chat');
    assert.equal(f.state.sent.at(-1)!.out.text, 'Claude Code antwoordt (chat)');

    // the owner keeps the bot's own access mode
    const r2 = await ctx.receive(msg('ik', 'Maak een bestand'));
    await t.waitIdle(r2.threadId!);
    assert.equal(calls.at(-1)!.req.accessMode, 'ask');
    assert.equal(f.state.sent.at(-1)!.out.text, 'Claude Code antwoordt (ask)');
  } finally {
    await t.close();
  }
});

test('Claude Code with "Alleen lezen" and Codex with "Alleen praten" are refused: no run, a clear notice for the owner (once a day)', async () => {
  const cc = await setup('claude-code', { othersAccess: 'readonly' });
  try {
    const r = await cc.ctx.receive(msg('vriend'));
    assert.equal(r.status, 'ok');
    assert.equal(r.refused, true);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(cc.calls.length, 0, 'the CLI never ran');
    assert.equal(cc.f.state.sent.at(-1)!.out.text, 'Deze bot kan je via dit kanaal nu niet helpen.');
    const ev = cc.t.app.ctx.store.messages(r.threadId!).find((m) => m.role === 'event')!;
    assert.match(ev.content, /Niet beantwoord\. Claudia draait op Claude Code\. Daar kan TeamBot “Alleen lezen” niet per afzender afdwingen\. Kies bij Kanalen › Toegang “Alleen praten” of “Zoals de bot zelf”/);
    assert.equal(cc.notes.length, 1);
    assert.equal(cc.notes[0].title, 'Vriend kreeg geen antwoord via Nep');
    assert.match(cc.notes[0].body, /Open Toegang/);
    assert.equal(cc.notes[0].link, `#/m/channels/${cc.b.id}`);
    const log = await cc.t.api('GET', `/channels/bindings/${cc.b.id}/log`);
    assert.ok(log.some((l: any) => l.kind === 'refused' && /Niet beantwoord/.test(l.summary)));
    const inMsg = cc.t.app.ctx.store.messages(r.threadId!).find((m) => m.role === 'user')!;
    assert.equal(inMsg.parts.channel.refused, true);
  } finally {
    await cc.t.close();
  }

  const cx = await setup('codex-cli', { othersAccess: 'none' });
  try {
    const view = await cx.t.api('GET', `/channels/bindings/${cx.b.id}`);
    assert.deepEqual(view.engine.levels, ['agent']);
    const r = await cx.ctx.receive(msg('vriend'));
    assert.equal(r.refused, true);
    await cx.ctx.receive(msg('vriend', 'nog een keer'));
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(cx.calls.length, 0);
    assert.equal(cx.notes.length, 1, 'one notification per sender per day');
    assert.equal(cx.notes[0].body, 'Codie draait op Codex. Die werkt altijd met zijn eigen tools en kan niet “alleen praten”. Open Toegang om dit te regelen.');

    // "Opnieuw" in TeamBot on the refused message: the CLI runs with all its tools, so the answer never goes out
    const sentBefore = cx.f.state.sent.length;
    await cx.t.api('POST', `/threads/${r.threadId}/retry`, {});
    await cx.t.waitIdle(r.threadId!);
    assert.equal(cx.calls.length, 1);
    assert.equal(cx.f.state.sent.length, sentBefore, 'nothing sent to the friend');
    assert.ok(cx.t.app.ctx.store.messages(r.threadId!).some((m) => m.role === 'event' && /niet naar buiten gestuurd/.test(m.content)));

    // "Zoals de bot zelf" for others: the owner's explicit choice, the bot answers with its own mode
    await cx.t.api('PATCH', `/channels/bindings/${cx.b.id}`, { config: { othersAccess: 'agent' } });
    await until(() => cx.t.app.ctx.store.get<any>('channel_bindings', cx.b.id)?.status === 'connected', 3000, 'reconnected');
    const r3 = await cx.f.state.ctx!.receive(msg('vriend', 'en nu?'));
    await cx.t.waitIdle(r3.threadId!);
    assert.equal(cx.calls.at(-1)!.req.accessMode, 'ask');
    assert.equal(cx.f.state.sent.at(-1)!.out.text, 'Codex antwoordt (ask)');
  } finally {
    await cx.t.close();
  }
});

test('refusal texts are plain Dutch and name a way out', () => {
  const codex = { type: 'cli' as const, kind: 'codex-cli', label: 'Codex', levels: ['agent' as const] };
  const t = refusalText('Codie', codex, 'none');
  assert.equal(t.short, 'Codie draait op Codex. Die werkt altijd met zijn eigen tools en kan niet “alleen praten”.');
  assert.match(t.long, /“Zoals de bot zelf” \(alleen voor mensen die je volledig vertrouwt\), of laat een bot met een API-model antwoorden\.$/);
  assert.ok(!/CLI-agent|access|none|readonly/i.test(t.long));
});
