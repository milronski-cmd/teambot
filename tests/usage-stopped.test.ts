// What a stopped or failed run used is counted, on every kind of AI ("Alles stoppen" after half a minute on Claude Code
// recorded nothing). A CLI engine: what it reported on the way (Claude Code per model call, Codex and an ACP agent
// pass along what they counted). A model through an API key, or a CLI that said nothing yet: TeamBot's estimate from
// what it sent and what came back, marked as an estimate. An engine that sent nothing back used nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { withUsage } from '../server/agent/budget.js';
import { ProviderError } from '../server/providers/common.js';
import type { AgentEvent, ChatRequest, StreamEvent } from '../server/core/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');

/** The usage rows of one bot on one engine (a failure may go on on a reserve engine: not what is counted here). */
const rows = (t: TestApp, agentId: string, providerId: string) => t.app.ctx.store.all<any>('SELECT provider_id, model, input, output, cost, value, estimated FROM usage_log WHERE agent_id = ? AND provider_id = ? ORDER BY id', agentId, providerId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (fn()) return;
  throw new Error(`time-out: ${what}`);
}

/** The text the chat receives live (what the owner sees stream in). */
function live(t: TestApp) {
  let text = '';
  t.app.ctx.events.on('message.delta', (e: any) => (text += String(e.data?.text || '')));
  return () => text;
}

/** An engine through an API key that streams a few words and then keeps going until it is stopped, or fails. */
function slowApi(t: TestApp, o: { fail?: 'mid' | 'at-once' } = {}) {
  const state = { streamed: false };
  t.app.ctx.providers.registerKind({
    id: 'traag',
    label: 'Traag',
    type: 'api',
    needsKey: false,
    description: 'test',
    models: ['claude-haiku-4-5'],
    defaultModel: 'claude-haiku-4-5',
    create: () => ({
      kind: 'traag',
      async listModels() {
        return [{ id: 'claude-haiku-4-5' }];
      },
      async test() {
        return { ok: true, detail: 'nep' };
      },
      async chat(_req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void) {
        if (o.fail === 'at-once') throw new ProviderError('Ongeldige sleutel', 401, false, '');
        for (const w of ['Er ', 'was ', 'eens ', 'een ', 'heel ', 'lang ', 'verhaal ']) onEvent({ type: 'text', delta: w });
        state.streamed = true;
        if (o.fail === 'mid') throw new ProviderError('Verbinding verbroken', 502, true, '');
        await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason || new Error('Gestopt')), { once: true }));
        throw new Error('unreachable');
      },
    }),
  } as any);
  return state;
}

/** A CLI engine (as Codex or an ACP agent): it streams, then on the stop throws with what it counted so far. */
function countingCli(t: TestApp, o: { said?: boolean; fail?: boolean } = {}) {
  const state = { streamed: false };
  t.app.ctx.providers.registerKind({
    id: 'telcli',
    label: 'Tel-CLI',
    type: 'cli',
    needsKey: false,
    description: 'test',
    models: ['default'],
    defaultModel: 'default',
    create: () => ({
      kind: 'telcli',
      async listModels() {
        return [{ id: 'default' }];
      },
      async test() {
        return { ok: true, detail: 'nep' };
      },
      async runAgent(_req: any, signal: AbortSignal, onEvent: (e: AgentEvent) => void) {
        onEvent({ type: 'text', delta: 'Ik ben bezig met de eerste stap van het werk. ' });
        state.streamed = true;
        if (o.fail) return { text: 'Ik ben bezig', usage: { input: 0, output: 0, cost: 0 }, error: 'De CLI stopte onverwacht (exitcode 3).' };
        await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
        throw withUsage(new Error('Gestopt'), o.said ? { input: 4200, output: 310, cacheRead: 3000, cost: 0 } : { input: 0, output: 0, cost: 0 });
      },
    }),
  } as any);
  return state;
}

async function startAndStop(t: TestApp, agentId: string, state: { streamed: boolean }, content = 'Vertel een lang verhaal') {
  const th = await t.api('POST', '/threads', { agentId });
  await t.api('POST', `/threads/${th.id}/messages`, { content });
  await until(() => state.streamed, 'the engine streamed');
  await sleep(50);
  await t.api('POST', '/stop-all', {});
  await t.waitIdle(th.id, 15_000);
  return th;
}

test('a model through an API key, stopped mid-answer with "Alles stoppen": the call is counted, as an estimate', async () => {
  const t = await startTestApp();
  try {
    const state = slowApi(t);
    const p = await t.api('POST', '/providers', { kind: 'traag' });
    const a = await t.api('POST', '/agents', { name: 'Verteller', provider_id: p.id, model: 'claude-haiku-4-5', access_mode: 'auto' });
    const th = await startAndStop(t, a.id, state);
    const run = t.app.ctx.store.one<any>('SELECT status, usage FROM runs WHERE thread_id = ?', th.id);
    assert.equal(run.status, 'cancelled');
    const r = rows(t, a.id, p.id);
    assert.equal(r.length, 1, 'one row for the stopped call');
    assert.equal(r[0].estimated, 1, 'marked as an estimate');
    assert.ok(r[0].input > 100, `what was sent (system, tools, the message): ${r[0].input}`);
    assert.ok(r[0].output >= 8 && r[0].output < 20, `what came back: ${r[0].output}`);
    assert.ok(r[0].cost > 0, 'priced like any call of this model');
    assert.equal(JSON.parse(run.usage).estimated, true, 'the run says it is an estimate too');
    const m = t.app.ctx.store.messages(th.id).filter((x) => x.role === 'assistant').at(-1)!;
    assert.equal(m.status, 'cancelled');
    assert.equal(m.usage?.estimated, true, 'and so does the stopped answer');
  } finally {
    await t.close();
  }
});

test('a model through an API key that fails mid-answer is counted; one that refuses at once used nothing', async () => {
  for (const fail of ['mid', 'at-once'] as const) {
    const t = await startTestApp();
    try {
      slowApi(t, { fail });
      const p = await t.api('POST', '/providers', { kind: 'traag' });
      const a = await t.api('POST', '/agents', { name: 'Verteller', provider_id: p.id, model: 'claude-haiku-4-5', access_mode: 'auto' });
      const th = await t.api('POST', '/threads', { agentId: a.id });
      await t.say(th.id, 'Vertel een lang verhaal', 15_000);
      const r = rows(t, a.id, p.id);
      if (fail === 'mid') assert.deepEqual(r.map((x) => [x.estimated, x.output > 0, x.input > 0]), [[1, true, true]]);
      else assert.deepEqual(r, [], 'refused before it began: nothing used');
    } finally {
      await t.close();
    }
  }
});

test('Claude Code stopped with "Alles stoppen": what it reported per model call is counted (not an estimate)', async () => {
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a = await t.api('POST', '/agents', { name: 'Verteller', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const heard = live(t);
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf een lang verhaal SCENARIO:telthang' });
    await until(() => heard().includes('TWEEDE'), 'the second call streamed', 20_000);
    await t.api('POST', '/stop-all', {});
    await t.waitIdle(th.id, 15_000);
    const r = rows(t, a.id, p.id);
    assert.equal(r.length, 1);
    // Call 1 finished (800 + 20000 cached in, 150 out); call 2 started (1200 + 30000 cached + 500 written in, 40 out).
    assert.deepEqual([r[0].input, r[0].output, r[0].estimated], [800 + 20000 + 1200 + 30000 + 500, 150 + 40, 0]);
    assert.equal(r[0].model, 'fake-sonnet', 'the model Claude Code said it used');
    const run = t.app.ctx.store.one<any>('SELECT status, usage FROM runs WHERE thread_id = ?', th.id);
    assert.equal(run.status, 'cancelled');
    assert.equal(JSON.parse(run.usage).output, 190);
  } finally {
    await t.close();
  }
});

test('Claude Code stopped while it writes: its input as it reported it, its output at least what came back (an estimate)', async () => {
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a = await t.api('POST', '/agents', { name: 'Verteller', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const heard = live(t);
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf een lang verhaal SCENARIO:schrijfhang' });
    await until(() => heard().includes('SCHRIJFT-NOG'), 'it streamed', 20_000);
    await t.api('POST', '/stop-all', {});
    await t.waitIdle(th.id, 15_000);
    const r = rows(t, a.id, p.id);
    assert.equal(r.length, 1);
    assert.equal(r[0].input, 9 + 39000 + 400, 'the input as Claude Code reported it');
    assert.ok(r[0].output > 500, `not the 1 token of message_start, but what was written: ${r[0].output}`);
    assert.equal(r[0].estimated, 1, 'that part is an estimate, and says so');
  } finally {
    await t.close();
  }
});

test('Claude Code stopped before it gave any number: an estimate, marked as one', async () => {
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a = await t.api('POST', '/agents', { name: 'Verteller', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const heard = live(t);
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf een lang verhaal SCENARIO:halfhang' });
    await until(() => heard().includes('HALVERWEGE'), 'it streamed', 20_000);
    await t.api('POST', '/stop-all', {});
    await t.waitIdle(th.id, 15_000);
    const r = rows(t, a.id, p.id);
    assert.equal(r.length, 1);
    assert.equal(r[0].estimated, 1);
    assert.ok(r[0].input > 100 && r[0].output > 5, JSON.stringify(r[0]));
    assert.equal(r[0].cost, 0, 'never reported a cost: its subscription, so no money against the daily budget');
  } finally {
    await t.close();
  }
});

test('a CLI engine that counts (Codex, an ACP agent): its count goes along with the stop; without one an estimate; a failure too', async () => {
  for (const o of [{ said: true }, { said: false }, { fail: true }]) {
    const t = await startTestApp();
    try {
      const state = countingCli(t, o);
      const p = await t.api('POST', '/providers', { kind: 'telcli' });
      const a = await t.api('POST', '/agents', { name: 'Werker', provider_id: p.id, model: '', access_mode: 'ask' });
      if (o.fail) await t.say((await t.api('POST', '/threads', { agentId: a.id })).id, 'Doe het werk', 15_000);
      else await startAndStop(t, a.id, state, 'Doe het werk');
      const r = rows(t, a.id, p.id);
      assert.equal(r.length, 1, JSON.stringify(o));
      if (o.said) assert.deepEqual([r[0].input, r[0].output, r[0].estimated, r[0].cost], [4200, 310, 0, 0]);
      else assert.ok(r[0].estimated === 1 && r[0].input > 0 && r[0].output > 0, JSON.stringify(r[0]));
    } finally {
      await t.close();
    }
  }
});
