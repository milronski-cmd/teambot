import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, startTestApp, type TestApp } from './helpers.js';
import { now } from '../server/core/db.js';
import { isBudgetError } from '../server/agent/budget.js';
import { billingOf, estimateTokens, judgeEngine, parseJsonObject, pickShortEngine, runShortCall, setShortCallFake, ShortCallError } from '../server/agent/short-call.js';

/** Extra engine kinds on the scripted mock adapter: a local one, a free API tier and a CLI with a one-shot. */
function kinds(t: TestApp, complete: () => Promise<string | null> = async () => 'cli-antwoord') {
  const base = { needsKey: false, description: 'test', models: ['m-1'], defaultModel: 'm-1' };
  t.app.ctx.providers.registerKind({ ...base, id: 'mocklocal', label: 'Lokaal', type: 'api', billing: 'local', group: 'local', create: () => mockAdapter(t.script, t.requests) });
  t.app.ctx.providers.registerKind({ ...base, id: 'mockfree', label: 'Gratis', type: 'api', billing: 'free', group: 'free', create: () => mockAdapter(t.script, t.requests) });
  t.app.ctx.providers.registerKind({ ...base, id: 'mockcli', label: 'CLI', type: 'cli', billing: 'subscription', group: 'cli', create: () => ({ kind: 'mockcli', listModels: async () => [], test: async () => ({ ok: true, detail: '' }), complete }) });
}

const usageRows = (t: TestApp) => t.app.ctx.store.all<any>('SELECT * FROM usage_log ORDER BY id');

test('parseJsonObject: the first whole JSON object, whatever is around it', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('Hier: ```json\n{"a":{"b":"}"}}\n``` klaar {x}'), { a: { b: '}' } }, 'fence, a brace in a string, chatter after it');
  assert.deepEqual(parseJsonObject('Zeker! {"verdict":"klaar","reason":"ok"} Laat maar weten.'), { verdict: 'klaar', reason: 'ok' });
  assert.deepEqual(parseJsonObject('Let op {dit} eerst. {"a":1}'), { a: 1 }, 'braces in the chatter before the answer are skipped');
  assert.deepEqual(parseJsonObject('Gebruik { voor objecten:\n```json\n{"a":1}\n```'), { a: 1 }, 'a stray brace before a fenced block');
  assert.deepEqual(parseJsonObject('```\n{"a":1}\n```\n```json\n{"b":2}\n```'), { a: 1 }, 'the first block wins');
  assert.deepEqual(parseJsonObject('{"a":"\\"}{"}'), { a: '"}{' }, 'escaped quotes in a string');
  assert.equal(parseJsonObject('{"facts":[{"a":1},{"b":'), null, 'cut off: never a part of the answer');
  assert.equal(parseJsonObject('geen json'), null);
  assert.equal(parseJsonObject('[1,2]'), null, 'an array is not an object');
  assert.equal(parseJsonObject('{a:1}'), null);
  assert.equal(parseJsonObject(''), null);
  assert.equal(parseJsonObject(undefined as any), null);
});

test('estimateTokens: one estimate (3.5 characters per token) for a text or a number of characters', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('abcdefg'), 2);
  assert.equal(estimateTokens(7), 2);
  assert.equal(estimateTokens('x'.repeat(3500)), 1000);
});

test('engine choice: explicit, then the catalogue, then the own engine, then others without extra cost; paid only when allowed', async () => {
  const t = await startTestApp();
  try {
    kinds(t);
    const ctx = t.app.ctx;
    const me = ctx.auth.owner()!.id;
    const bot = ctx.store.agent((await t.agent()).id)!;
    assert.equal(billingOf(ctx.providers.kind('mock')), 'paid', 'unknown billing counts as paid');

    // Only the bot's own (paid) engine.
    let e = pickShortEngine(ctx, { userId: me, agent: bot });
    assert.deepEqual([e?.providerId, e?.source, e?.billing, e?.model, e?.label], [t.providerId, 'own', 'paid', 'mock-1', 'Mock · mock-1']);
    assert.equal(pickShortEngine(ctx, { userId: me, agent: bot, allowPaid: false }), null, 'a paid engine only when allowed');
    assert.equal(judgeEngine(ctx, { userId: me, agent: bot, allowPaid: false }, { providerId: t.providerId }, 'own').problem, 'paid');
    assert.equal(pickShortEngine(ctx, { userId: me, agent: bot, others: true, allowPaid: false }), null, 'nothing free connected');

    // Others: a local model before a free API tier (whatever was connected first), a subscription CLI before both.
    const free = await t.api('POST', '/providers', { kind: 'mockfree' });
    const local = await t.api('POST', '/providers', { kind: 'mocklocal' });
    e = pickShortEngine(ctx, { userId: me, agent: bot, others: true, allowPaid: false });
    assert.deepEqual([e?.providerId, e?.source, e?.billing], [local.id, 'other', 'local']);
    e = pickShortEngine(ctx, { userId: me, agent: bot, others: true, allowPaid: false, usable: (cfg) => cfg.id !== local.id });
    assert.deepEqual([e?.providerId, e?.billing], [free.id, 'free'], "the caller's own filter (an engine that rests)");
    assert.equal(pickShortEngine(ctx, { userId: me, agent: bot, others: true })?.source, 'own', 'the own engine comes before the others');
    assert.equal(pickShortEngine(ctx, { userId: me, agent: bot, own: false }), null, 'only the sources the caller switched on');

    // The owner's explicit choice first; switched off, it is passed over.
    e = pickShortEngine(ctx, { userId: me, agent: bot, explicit: { providerId: free.id, model: 'm-9' } });
    assert.deepEqual([e?.providerId, e?.source, e?.model], [free.id, 'explicit', 'm-9']);
    await t.api('PATCH', `/providers/${free.id}`, { enabled: false });
    assert.equal(judgeEngine(ctx, { userId: me }, { providerId: free.id }, 'explicit').problem, 'off');
    assert.equal(pickShortEngine(ctx, { userId: me, agent: bot, explicit: { providerId: free.id } })?.source, 'own');
    assert.equal(judgeEngine(ctx, { userId: me }, { providerId: 'prov_weg' }, 'explicit').problem, 'missing');
    await t.api('PATCH', `/providers/${free.id}`, { enabled: true });

    // The free catalogue: its first candidate that can answer now, before the own engine, with the privacy level asked.
    const real = ctx.services.freeModels;
    const asked: any[] = [];
    ctx.services.freeModels = {
      candidates: (q: any) => {
        asked.push(q);
        return [
          { providerId: local.id, engine: 'api', model: 'x', available: false },
          { providerId: free.id, engine: 'api', model: 'gratis-1', modelLabel: 'Gratis Eén', providerLabel: 'Bron', available: true },
        ];
      },
    };
    e = pickShortEngine(ctx, { userId: me, agent: bot, catalogue: true, privacy: 'any' });
    assert.deepEqual([e?.providerId, e?.source, e?.billing, e?.model, e?.name, e?.modelLabel], [free.id, 'catalogue', 'free', 'gratis-1', 'Bron', 'Gratis Eén']);
    assert.equal(asked.at(-1).privacy, 'any');
    pickShortEngine(ctx, { userId: me, agent: bot, catalogue: true });
    assert.equal(asked.at(-1).privacy, 'no-store', 'by default only a source that keeps nothing');
    // A free API tier outside the catalogue's list is not used when the caller asks for that check.
    assert.equal(judgeEngine(ctx, { userId: me, checkFreeTier: true }, { providerId: free.id, model: 'm-1' }, 'own').engine?.model, 'gratis-1', 'the model the catalogue lists as free');
    ctx.services.freeModels = { candidates: () => [] };
    assert.equal(judgeEngine(ctx, { userId: me, checkFreeTier: true }, { providerId: free.id }, 'own').problem, 'unsupported');
    ctx.services.freeModels = real;

    // Team rules for keys: an engine this bot may not use is never chosen for it.
    const off = ctx.providers.addBotGuard((_a, cfg) => (cfg.id === local.id ? 'Mag niet.' : null));
    const v = judgeEngine(ctx, { userId: me, agent: bot }, { providerId: local.id }, 'explicit');
    assert.deepEqual([v.problem, v.detail], ['refused', 'Mag niet.']);
    assert.ok(judgeEngine(ctx, { userId: me }, { providerId: local.id }, 'explicit').engine, 'without a bot there is no bot rule');
    off();

    // A CLI engine: on the subscription, through its one-shot, or the way the caller runs it itself.
    const cli = await t.api('POST', '/providers', { kind: 'mockcli' });
    e = pickShortEngine(ctx, { userId: me, agent: bot, others: true, allowPaid: false });
    assert.deepEqual([e?.providerId, e?.type, e?.billing], [local.id, 'api', 'local']);
    e = judgeEngine(ctx, { userId: me }, { providerId: cli.id }, 'explicit').engine!;
    assert.deepEqual([e.type, e.billing], ['cli', 'subscription']);
    e = judgeEngine(ctx, { userId: me, cli: () => ({ billing: 'paid', model: 'licht', bin: '/bin/x' }) }, { providerId: cli.id }, 'explicit').engine!;
    assert.deepEqual([e.billing, e.model, e.bin], ['paid', 'licht', '/bin/x']);
    assert.equal(judgeEngine(ctx, { userId: me, cli: () => null }, { providerId: cli.id }, 'explicit').problem, 'unsupported');
  } finally {
    await t.close();
  }
});

test('one call: no tools, capped, thinking off on a local model, logged once; the daily budget stops a paid engine', async () => {
  const t = await startTestApp();
  try {
    kinds(t);
    const ctx = t.app.ctx;
    const me = ctx.auth.owner()!.id;
    const bot = ctx.store.agent((await t.agent()).id)!;
    const local = await t.api('POST', '/providers', { kind: 'mocklocal' });
    const paid = pickShortEngine(ctx, { userId: me, agent: bot })!;
    const free = judgeEngine(ctx, { userId: me }, { providerId: local.id }, 'explicit').engine!;

    t.script.push({ text: 'Zo: {"ok":true}' });
    let r = await runShortCall(ctx, paid, { userId: me, agentId: bot.id, system: 'S', prompt: 'P', maxTokens: 99, json: true, reasoning: 'high' });
    assert.equal(r.text, 'Zo: {"ok":true}');
    assert.deepEqual(r.json, { ok: true });
    assert.deepEqual(r.usage, { input: 10, output: 5 }, 'what the provider reported');
    assert.equal(r.engine, 'Mock · mock-1');
    const req = t.requests.at(-1)!;
    assert.deepEqual([req.model, req.system, req.tools, req.maxTokens, req.reasoning], ['mock-1', 'S', [], 99, 'high']);
    assert.deepEqual(req.messages, [{ role: 'user', content: 'P' }]);
    let rows = usageRows(t);
    assert.equal(rows.length, 1, 'one usage row for one call');
    assert.deepEqual([rows[0].user_id, rows[0].agent_id, rows[0].provider_id, rows[0].model, rows[0].input, rows[0].output], [me, bot.id, t.providerId, 'mock-1', 10, 5]);

    // A local model: thinking off whatever the caller asked, the default cap, no JSON unless asked, cost 0.
    t.script.push({ text: 'lokaal' });
    r = await runShortCall(ctx, free, { userId: me, system: 'S', prompt: 'P', reasoning: 'high' });
    assert.equal('json' in r, false);
    assert.equal(r.cost, 0);
    assert.deepEqual([t.requests.at(-1)!.reasoning, t.requests.at(-1)!.maxTokens], ['none', 1500]);
    rows = usageRows(t);
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[1].agent_id, rows[1].provider_id, rows[1].cost], [null, local.id, 0]);

    // The daily budget is used up: a paid engine is not called (and nothing is logged), a local one still is.
    ctx.store.setSetting(me, 'dailyBudgetUsd', 1);
    ctx.store.insert('usage_log', { user_id: me, agent_id: null, provider_id: t.providerId, model: 'mock-1', input: 1, output: 1, cost: 2, created_at: now() });
    const before = t.requests.length;
    await assert.rejects(runShortCall(ctx, paid, { userId: me, system: 'S', prompt: 'P' }), (e: any) => isBudgetError(e));
    assert.equal(t.requests.length, before, 'no call was made');
    assert.equal(usageRows(t).length, 3);
    t.script.push({ text: 'mag wel' });
    assert.equal((await runShortCall(ctx, free, { userId: me, system: 'S', prompt: 'P' })).text, 'mag wel');
    assert.equal(usageRows(t).length, 4);
    ctx.store.setSetting(me, 'dailyBudgetUsd', 0);

    // An engine error: nothing is logged.
    t.script.push({ error: { message: 'kapot', status: 500 } });
    await assert.rejects(runShortCall(ctx, free, { userId: me, system: 'S', prompt: 'P' }), /kapot/);
    assert.equal(usageRows(t).length, 4);

    // The caller's own transport: its reported tokens and cost are what is logged; a subscription keeps its list price as value.
    r = await runShortCall(ctx, { ...free, billing: 'subscription' }, { userId: me, system: 'S', prompt: 'P', transport: async (o) => ({ text: `t${o.timeoutMs}`, usage: { input: 100, output: 20, cacheRead: 40 }, model: 'echt-model', cost: 0, value: 0.25 }) });
    assert.deepEqual([r.text, r.model, r.cost, r.value], ['t120000', 'echt-model', 0, 0.25]);
    assert.deepEqual(r.usage, { input: 100, output: 20, cacheRead: 40 });
    rows = usageRows(t);
    assert.deepEqual([rows.length, rows[4].model, rows[4].input, rows[4].output, rows[4].cost, rows[4].value], [5, 'echt-model', 100, 20, 0, 0.25]);
    r = await runShortCall(ctx, paid, { userId: me, system: 'S', prompt: 'P', transport: async () => ({ text: 'x', cost: 0.5 }) });
    assert.equal(r.cost, 0.5, 'what the engine says it cost');
    assert.equal(usageRows(t).at(-1).cost, 0.5);

    // The test fake replaces every engine; its tokens are estimated, and it is logged once like any call.
    setShortCallFake((system, prompt) => `${system}|${prompt}`);
    const calls = t.requests.length;
    r = await runShortCall(ctx, paid, { userId: me, system: 'x'.repeat(35), prompt: 'y'.repeat(35) });
    assert.equal(r.text.length, 71);
    assert.deepEqual(r.usage, { input: 20, output: 21 });
    assert.equal(t.requests.length, calls);
    assert.equal(usageRows(t).length, 7);
    setShortCallFake(null);
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test('a CLI engine answers through its one-shot: estimated tokens, no cost, a time-out, and an honest "cannot"', async () => {
  const t = await startTestApp();
  try {
    let complete: () => Promise<string | null> = async () => 'cli-antwoord';
    kinds(t, () => complete());
    const ctx = t.app.ctx;
    const me = ctx.auth.owner()!.id;
    const cli = await t.api('POST', '/providers', { kind: 'mockcli' });
    const engine = judgeEngine(ctx, { userId: me }, { providerId: cli.id }, 'explicit').engine!;
    const r = await runShortCall(ctx, engine, { userId: me, system: 'x'.repeat(7), prompt: 'y'.repeat(7) });
    assert.deepEqual([r.text, r.cost, r.usage.input, r.usage.output], ['cli-antwoord', 0, 4, 4]);
    assert.equal(usageRows(t).length, 1);

    complete = async () => null;
    await assert.rejects(runShortCall(ctx, engine, { userId: me, system: 'S', prompt: 'P' }), (e: any) => e instanceof ShortCallError && e.code === 'unsupported');
    complete = () => new Promise(() => {});
    await assert.rejects(runShortCall(ctx, engine, { userId: me, system: 'S', prompt: 'P', timeoutMs: 30 }), (e: any) => e instanceof ShortCallError && e.name === 'TimeoutError');
    const ac = new AbortController();
    const p = runShortCall(ctx, engine, { userId: me, system: 'S', prompt: 'P', signal: ac.signal });
    ac.abort(new Error('gestopt'));
    await assert.rejects(p, /gestopt/);
    assert.equal(usageRows(t).length, 1, 'only the call that answered is logged');
  } finally {
    await t.close();
  }
});
