import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { mockAdapter, startTestApp, type TestApp } from './helpers.js';
import { engineTier, enginePrivacy, modelFamily, normPrivacy, orderFree, pauseUntil, resolveChainSettings, weekUse } from '../server/agent/fallback.js';

/**
 * Package D2: the default chain (no reserves per bot), important work that pauses instead of running on a weaker
 * model and goes on by itself after the reset, the weekly reserve for Claude/Codex, and private work that never goes
 * to a source that can train. Everything with the mock provider (registered as engines of each kind), the fake
 * OpenCode (ACP) and a fake Ollama; never a real engine, and never the Ollama that may run on this computer.
 */

const FAKE_ACP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents-fake-acp.mjs');

/** Mock engines that look like a subscription (Claude), a free tier and a local model to the chain. */
function kinds(t: TestApp) {
  const add = (id: string, billing: 'subscription' | 'free' | 'local', models: string[]) =>
    t.app.ctx.providers.registerKind({ id, label: id, type: 'api', billing, needsKey: false, description: 'test', models, defaultModel: models[0], create: () => mockAdapter(t.script, t.requests) });
  add('mocksub', 'subscription', ['claude-test']);
  add('mockcodex', 'subscription', ['gpt-test']);
  add('mockfree', 'free', ['llama-3.3-70b']);
  add('mocklocal', 'local', ['qwen3:4b']);
}

/**
 * The free-model catalogue of package D1 as a stand-in with its real shapes (docs/modules/free-models.md): one
 * available candidate per given provider, every report recorded. The last test uses the real D1 service.
 */
function catalogue(t: TestApp, list: { provider_id: string; model: string; privacy?: 'local' | 'no-store' | 'may-train'; family?: string }[]) {
  const queries: any[] = [];
  const reports: { providerId: string; model: string; outcome: any }[] = [];
  t.app.ctx.services.freeModels = {
    candidates: (q: any) => (
      queries.push(q),
      list.map((c) => ({
        providerId: c.provider_id,
        providerKind: 'mockfree',
        providerLabel: c.provider_id,
        engine: 'api',
        model: c.model,
        family: c.family || '',
        tools: 'tools',
        privacy: { level: c.privacy || 'may-train', label: c.privacy === 'no-store' ? 'bewaart niets' : 'kan trainen' },
        available: true,
        availableAt: null,
        resetsAt: null,
      }))
    ),
    report: (ref: string | { providerId: string; model?: string }, outcome: any) => reports.push({ providerId: typeof ref === 'string' ? ref : ref.providerId, model: typeof ref === 'string' ? '' : ref.model || '', outcome }),
  };
  return { queries, reports };
}

async function fakeOllama() {
  const chats: any[] = [];
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const send = (x: any) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
      if (req.url === '/api/version') return send({ version: '0.40.15' });
      if (req.url === '/api/tags') return send({ models: [{ name: 'qwen3:4b', digest: 'q', details: { parameter_size: '4B', context_length: 40960 }, capabilities: ['completion', 'tools'] }] });
      if (req.url === '/api/ps') return send({ models: [{ name: 'qwen3:4b', context_length: 8192 }] });
      if (req.url === '/api/show') return send({ model_info: {}, capabilities: [] });
      if (req.url === '/v1/models') return send({ data: [{ id: 'qwen3:4b' }] });
      if (req.url === '/v1/chat/completions') {
        chats.push(b ? JSON.parse(b) : null);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Rome, van het lokale model.' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, chats, close: () => new Promise<void>((r) => s.close(() => r())) };
}

const events = (t: TestApp, id: string) => t.app.ctx.store.messages(id).filter((m) => m.role === 'event');
const answers = (t: TestApp, id: string) => t.app.ctx.store.messages(id).filter((m) => m.role === 'assistant');
/** Every attempt, also the ones removed when another engine took over: which engines were called. */
const attempts = (t: TestApp, id: string) => t.app.ctx.store.messages(id, { includeDeleted: true }).filter((m) => m.role === 'assistant');
const notes = (t: TestApp) => t.app.ctx.store.all<any>('SELECT kind, title, body, link FROM notifications ORDER BY created_at');
const runsOf = (t: TestApp, threadId: string) => t.app.ctx.store.all<any>('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at', threadId).map((r) => ({ ...r, meta: JSON.parse(r.meta || '{}') }));
async function until(fn: () => boolean, ms = 10_000, what = 'condition') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout: ${what}`);
}

test('chain rules: tiers, families, privacy labels, free order, weekly use, pause time, settings per team', () => {
  assert.equal(engineTier({ id: 'claude-code', billing: 'subscription' }, ''), 'top');
  assert.equal(engineTier({ id: 'codex-cli', billing: 'subscription' }, ''), 'top');
  assert.equal(engineTier({ id: 'anthropic', billing: 'paid' }, 'claude-sonnet-4-5'), 'top');
  assert.equal(engineTier({ id: 'opencode', billing: 'free' }, 'opencode/big-pickle'), 'free');
  assert.equal(engineTier({ id: 'groq', billing: 'free' }, 'openai/gpt-oss-120b'), 'free', 'a free tier stays free, whatever the model family');
  assert.equal(engineTier({ id: 'ollama', billing: 'local' }, 'qwen3:4b'), 'local');
  assert.equal(engineTier({ id: 'mistral', billing: 'paid' }, 'mistral-large'), 'paid');
  assert.equal(modelFamily('ollama', 'qwen3:4b'), 'qwen');
  assert.equal(modelFamily('groq', 'llama-3.3-70b-versatile'), 'llama');
  assert.equal(modelFamily('claude-code', 'opus'), 'claude');
  assert.equal(enginePrivacy({ billing: 'local' }), 'local');
  assert.equal(enginePrivacy({ billing: 'free' }), 'train', 'a free source counts as one that can train');
  assert.equal(enginePrivacy({ billing: 'subscription' }), 'stores');
  assert.equal(enginePrivacy({ billing: 'free' }, { privacy: 'bewaart niets' }), 'none', 'the label of the catalogue or the owner wins');
  assert.equal(normPrivacy('zero-retention'), null);
  assert.equal(normPrivacy('no-retention'), 'none');
  // Another provider first (a free limit counts per account), then the same model family.
  const order = orderFree(
    [
      { provider_id: 'oc', family: 'qwen', n: 1 },
      { provider_id: 'groq', family: 'llama', n: 2 },
      { provider_id: 'or', family: 'qwen', n: 3 },
    ],
    { provider_id: 'oc', family: 'qwen' },
  ).map((x) => x.n);
  assert.deepEqual(order, [3, 2, 1]);
  const now = Date.parse('2026-11-09T10:00:00Z');
  assert.deepEqual(weekUse([{ id: 'five_hour', usedPercent: 99 }, { id: 'seven_day', usedPercent: 87, resetsAt: now + 864e5 }], now), { percent: 87, resetsAt: now + 864e5 });
  assert.equal(weekUse([{ id: 'codex:10080', usedPercent: 91, resetsAt: now + 1000 }], now)!.percent, 91, 'the Codex week');
  assert.equal(weekUse([{ id: 'seven_day', usedPercent: 95, resetsAt: now - 1000 }], now), null, 'a week that has reset says nothing');
  assert.deepEqual(pauseUntil(now + 3600_000, now), { at: now + 3600_000 + 60_000, known: true });
  assert.deepEqual(pauseUntil(null, now), { at: now + 30 * 60_000, known: false });
  assert.equal(pauseUntil(now + 30 * 864e5, now).at, now + 8 * 864e5, 'never longer than 8 days');
  assert.deepEqual(resolveChainSettings(undefined), { enabled: true, minLevel: 'top', weeklyReserve: 85 }, 'on by default');
  const raw = { minLevel: 'paid', weeklyReserve: 120, teams: { team_a: { enabled: false, weeklyReserve: 0 } } };
  assert.deepEqual(resolveChainSettings(raw), { enabled: true, minLevel: 'paid', weeklyReserve: 99 });
  assert.deepEqual(resolveChainSettings(raw, 'team_a'), { enabled: false, minLevel: 'paid', weeklyReserve: 0 }, 'a team can have its own chain (wave 2)');
});

test('simulated limit on OpenCode: a normal task switches visibly to another free source, then to Ollama — no reserves set per bot', async () => {
  const ol = await fakeOllama();
  const t = await startTestApp();
  kinds(t);
  try {
    const oc = await t.api('POST', '/providers', { kind: 'opencode', config: { path: FAKE_ACP, defaultModel: 'opencode/big-pickle' } });
    const free = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Groq (test)' });
    const ollama = await t.api('POST', '/providers', { kind: 'ollama', base_url: ol.url + '/v1' });
    const cat = catalogue(t, [{ provider_id: free.id, model: 'llama-3.3-70b', privacy: 'may-train', family: 'llama' }]);
    const a = await t.api('POST', '/agents', { name: 'Gratisbot', provider_id: oc.id, model: '', access_mode: 'ask' });
    assert.equal(a.settings?.fallbacks, undefined, 'no reserves set for this bot');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    // The other free provider is at its limit too (an API 429): then the local model.
    t.script.push({ error: { message: 'Rate limit reached. Try again in 20 minutes.', status: 429 } });
    await t.say(th.id, 'Wat is de hoofdstad van Italië? SCENARIO:freelimit', 30_000);
    assert.equal(answers(t, th.id).at(-1)!.content, 'Rome, van het lokale model.');
    assert.equal(answers(t, th.id).length, 1, 'only the answer stays; the failed attempts went');
    const ev = events(t, th.id).map((m) => m.content);
    assert.ok(ev.some((e) => /^De gratis limiet van OpenCode is bereikt\. Overgeschakeld naar reserve: Groq \(test\)/.test(e)), ev.join(' | '));
    assert.ok(ev.some((e) => /^Groq \(test\).* heeft zijn gebruikslimiet bereikt.*\. Overgeschakeld naar reserve: Ollama \(lokaal\) · qwen3:4b\.$/.test(e)), ev.join(' | '));
    assert.deepEqual(attempts(t, th.id).map((m) => m.parts.providerId), [oc.id, free.id, ollama.id], 'OpenCode → other provider → Ollama');
    // The catalogue was asked (tools needed, not private, from the main family) and told about the limit.
    assert.equal(cat.queries[0].needTools, true);
    assert.equal(cat.queries[0].privacy, 'any');
    assert.ok(cat.queries[0].exclude.includes(oc.id));
    assert.ok(cat.reports.some((r) => r.providerId === free.id && r.model === 'llama-3.3-70b' && r.outcome?.limit === true), JSON.stringify(cat.reports));
    assert.ok(cat.reports.some((r) => r.providerId === oc.id && r.outcome?.limit === true), 'OpenCode free limit reported too');
    assert.ok(!cat.reports.some((r) => r.outcome === 'ok' || 'ok' in (r.outcome || {})), 'a failure is never reported as a success');
    // OpenCode's free limit counts for all its free models: the next turn starts on another source, not on OpenCode.
    await t.say(th.id, 'En van Frankrijk?', 30_000);
    assert.ok(events(t, th.id).some((m) => /OpenCode .*zit nog tot ongeveer .* aan zijn gebruikslimiet; deze beurt draait op Ollama/.test(m.content)), events(t, th.id).map((m) => m.content).join(' | '));
    assert.ok(!notes(t).some((n) => /liep vast/.test(n.title)));
  } finally {
    await t.close();
    await ol.close();
  }
});

test('a free model that is gone drops out of the chain: the next source answers, no error for the user, the catalogue hears it', async () => {
  const t = await startTestApp();
  kinds(t);
  try {
    const main = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis A (test)' });
    const gone = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis B (test)' });
    const local = await t.api('POST', '/providers', { kind: 'mocklocal', name: 'Lokaal (test)', config: { defaultModel: 'qwen3:4b' } });
    const cat = catalogue(t, [{ provider_id: gone.id, model: 'oud-model', privacy: 'may-train' }]);
    const a = await t.agent({ provider_id: main.id, model: 'llama-3.3-70b' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ error: { message: 'Rate limit reached. Try again in 20 minutes.', status: 429 } }, { error: { message: 'The model `oud-model` does not exist', status: 404, category: 'model' } }, { text: 'antwoord van het lokale model' });
    await t.say(th.id, 'hallo');
    const last = answers(t, th.id).at(-1)!;
    assert.equal(last.content, 'antwoord van het lokale model');
    assert.equal(last.parts.providerId, local.id);
    assert.equal(answers(t, th.id).length, 1, 'no error message left in the chat');
    assert.ok(events(t, th.id).some((m) => /^Gratis B \(test\).* kon niet starten\. Overgeschakeld naar reserve: Lokaal \(test\)/.test(m.content)), events(t, th.id).map((m) => m.content).join(' | '));
    // The error itself goes to the catalogue, which sees "model gone" in it (D1: category model / 404).
    assert.ok(cat.reports.some((r) => r.providerId === gone.id && r.model === 'oud-model' && r.outcome?.error?.category === 'model' && r.outcome.error.status === 404), JSON.stringify(cat.reports));
    assert.ok(cat.reports.some((r) => r.providerId === local.id && r.outcome === 'ok') === false, 'a local engine is not the catalogue\'s business');
  } finally {
    await t.close();
  }
});

test('an important task pauses with a resume time and a notification instead of going to a free model, and goes on by itself after the reset', async () => {
  const t = await startTestApp();
  kinds(t);
  try {
    const claude = await t.api('POST', '/providers', { kind: 'mocksub', name: 'Claude (test)' });
    const free = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis (test)' });
    catalogue(t, [{ provider_id: free.id, model: 'llama-3.3-70b', privacy: 'may-train' }]);
    const a = await t.agent({ provider_id: claude.id, model: 'claude-test' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const task = await t.api('POST', '/rooms/tasks', { title: 'Kwartaalrapport', ownerType: 'agent', ownerId: a.id, status: 'doing', important: true, sourceThreadId: th.id });
    assert.equal(task.important, true);
    t.script.push({ error: { message: 'Usage limit reached. Try again in 30 minutes.', status: 429 } });
    const before = Date.now();
    await t.say(th.id, 'Maak het kwartaalrapport af');
    const runs = runsOf(t, th.id);
    assert.equal(runs.length, 1);
    const paused = runs[0];
    assert.equal(paused.meta.important?.kind, 'task');
    assert.equal(paused.meta.important?.title, 'Kwartaalrapport');
    const resumeAt = Date.parse(paused.meta.paused?.until);
    assert.ok(resumeAt >= before + 30 * 60_000 && resumeAt <= Date.now() + 32 * 60_000, 'resumes at the reset (+1 min)');
    assert.equal(paused.meta.paused.known, true);
    assert.ok(!attempts(t, th.id).some((m) => m.parts.providerId === free.id), 'never ran on the free model');
    const card = events(t, th.id).find((m) => m.parts.kind === 'work_paused')!;
    assert.ok(card, events(t, th.id).map((m) => m.content).join(' | '));
    assert.match(card.content, /^Belangrijk werk gepauzeerd \(“Kwartaalrapport”\): Claude \(test\).* heeft zijn gebruikslimiet bereikt, en een ander model op het niveau Claude of Codex is er nu niet\. Testbot gaat rond \d\d:\d\d vanzelf verder\.$/);
    assert.equal(card.parts.pause.state, 'waiting');
    assert.equal(card.parts.pause.until, paused.meta.paused.until);
    assert.ok(!events(t, th.id).some((m) => /Overgeschakeld/.test(m.content)), 'no switch');
    const n = notes(t);
    const pauseNote = n.find((x) => x.kind === 'pause');
    assert.ok(pauseNote, JSON.stringify(n));
    assert.equal(pauseNote.title, 'Belangrijk werk gepauzeerd');
    assert.match(pauseNote.body, /heeft zijn gebruikslimiet bereikt\. Testbot gaat rond .* vanzelf verder\.$/);
    assert.equal(pauseNote.link, `#/t/${th.id}`);
    assert.ok(!n.some((x) => /liep vast/.test(x.title)), 'a pause is not a failure');
    // Another message meanwhile: still important (the task is in progress), so it pauses at once without a call.
    const calls = t.requests.length;
    await t.say(th.id, 'Hoe staat het ervoor?');
    assert.equal(t.requests.length, calls, 'no call to the engine that is still at its limit');
    assert.equal(events(t, th.id).filter((m) => m.parts.kind === 'work_paused').length, 2);

    // The (simulated) reset: Claude is free again and the scheduled resume fires.
    t.app.ctx.services.runner.limited.clear();
    t.script.push({ text: 'Het rapport is klaar.' });
    t.app.ctx.services.runner.armRetry(paused.id, Date.now());
    await until(() => answers(t, th.id).some((m) => m.content === 'Het rapport is klaar.'), 10_000, 'resumed answer');
    await t.waitIdle(th.id);
    const resumed = runsOf(t, th.id).find((r) => r.meta.resumeOf === paused.id)!;
    assert.ok(resumed, 'a new run for the paused message');
    assert.equal(resumed.input_message_id, paused.input_message_id);
    assert.equal(resumed.meta.important?.kind, 'task', 'it stays important');
    assert.equal(resumed.status, 'done');
    assert.equal(answers(t, th.id).find((m) => m.content === 'Het rapport is klaar.')!.parts.providerId, claude.id, 'on Claude, not on the free model');
    assert.equal(t.app.ctx.store.message(card.id)!.parts.pause.state, 'resumed', 'the pause card says it went on');
  } finally {
    await t.close();
  }
});

// Practice test 0.4.4: the owner makes the task on the board (no conversation), gives it to the bot, sets it to Bezig
// and Belangrijk, and asks the bot in its chat. The work went to the free model, then to a local one.
test('an important task made on the board pauses the bot in its own chat with the owner, not in other conversations', async () => {
  const t = await startTestApp();
  kinds(t);
  try {
    const claude = await t.api('POST', '/providers', { kind: 'mocksub', name: 'Claude (test)' });
    const free = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis (test)' });
    catalogue(t, [{ provider_id: free.id, model: 'llama-3.3-70b', privacy: 'may-train' }]);
    const a = await t.agent({ provider_id: claude.id, model: 'claude-test' });
    const task = await t.api('POST', '/rooms/tasks', { title: 'Offerte Jansen' });
    assert.equal(task.source_thread_id ?? null, null, 'made on the board, not in a conversation');
    await t.api('PATCH', `/rooms/tasks/${task.id}`, { ownerType: 'agent', ownerId: a.id, status: 'doing', important: true });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ error: { message: 'Usage limit reached. Try again in 30 minutes.', status: 429 } });
    await t.say(th.id, 'Maak de offerte voor Jansen af');
    const paused = runsOf(t, th.id)[0];
    assert.equal(paused.meta.important?.kind, 'task');
    assert.equal(paused.meta.important?.title, 'Offerte Jansen');
    assert.ok(paused.meta.paused?.until, 'paused until the reset');
    assert.ok(!attempts(t, th.id).some((m) => m.parts.providerId === free.id), 'never ran on the free model');
    assert.ok(events(t, th.id).some((m) => m.parts.kind === 'work_paused'), events(t, th.id).map((m) => m.content).join(' | '));
    // A routine of that bot is not the owner's chat: it is not made important by the board task.
    const svc = t.app.ctx.services.engineChain;
    const rt = t.app.ctx.store.createThread({ user_id: a.user_id, agent_id: a.id, kind: 'routine' });
    assert.equal(svc.importantOf({ meta: {} } as any, a, rt), null);
  } finally {
    await t.close();
  }
});

test('above the weekly reserve normal work goes to a free model while important work stays on Claude', async () => {
  const t = await startTestApp();
  kinds(t);
  try {
    const claude = await t.api('POST', '/providers', { kind: 'mocksub', name: 'Claude (test)' });
    const free = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis (test)' });
    catalogue(t, [{ provider_id: free.id, model: 'llama-3.3-70b', privacy: 'may-train' }]);
    const reset = Date.now() + 3 * 864e5;
    t.app.ctx.services.usage.report(claude.id, { windows: [{ id: 'seven_day', label: 'Week · alle modellen', usedPercent: 90, resetsAt: reset, level: 'warn', at: Date.now() }], source: 'usage-command', at: Date.now() });
    const a = await t.agent({ provider_id: claude.id, model: 'claude-test' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'gewoon antwoord' });
    await t.say(th.id, 'Een gewone vraag');
    const normal = answers(t, th.id).at(-1)!;
    assert.equal(normal.content, 'gewoon antwoord');
    assert.equal(normal.parts.providerId, free.id, 'normal work on the free model');
    assert.ok(events(t, th.id).some((m) => /^Overgeschakeld naar Gratis \(test\).*, omdat Claude \(test\).* al 90% van de weeklimiet heeft gebruikt \(grens 85%\); zo blijft er genoeg over voor belangrijk werk\.$/.test(m.content)), events(t, th.id).map((m) => m.content).join(' | '));

    // Important work (a task in progress here) stays on Claude.
    await t.api('POST', '/rooms/tasks', { title: 'Offerte', ownerType: 'agent', ownerId: a.id, status: 'doing', important: true, sourceThreadId: th.id });
    t.script.push({ text: 'belangrijk antwoord' });
    await t.say(th.id, 'Maak de offerte af');
    const imp = answers(t, th.id).at(-1)!;
    assert.equal(imp.content, 'belangrijk antwoord');
    assert.equal(imp.parts.providerId, claude.id, 'important work on Claude');

    // A higher threshold (owner's choice): normal work stays on Claude again.
    await t.api('PUT', '/engine-chain/settings', { weeklyReserve: 95 });
    await t.api('PATCH', `/rooms/tasks/${(await t.api('GET', '/rooms/tasks'))[0].id}`, { status: 'done' });
    t.script.push({ text: 'weer op claude' });
    await t.say(th.id, 'nog een gewone vraag');
    assert.equal(answers(t, th.id).at(-1)!.parts.providerId, claude.id);
  } finally {
    await t.close();
  }
});

test('private work: a bot set to private runs on a local model and never goes to a source that can train', async () => {
  const t = await startTestApp();
  kinds(t);
  try {
    const claude = await t.api('POST', '/providers', { kind: 'mocksub', name: 'Claude (test)' });
    const free = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis (test)' });
    const local = await t.api('POST', '/providers', { kind: 'mocklocal', name: 'Lokaal (test)', config: { defaultModel: 'qwen3:4b' } });
    const cat = catalogue(t, [{ provider_id: free.id, model: 'llama-3.3-70b', privacy: 'may-train' }]);
    const a = await t.agent({ provider_id: claude.id, model: 'claude-test', settings: { private: true } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'lokaal antwoord' });
    await t.say(th.id, 'mijn medische gegevens');
    assert.equal(answers(t, th.id).at(-1)!.parts.providerId, local.id);
    assert.ok(events(t, th.id).some((m) => /^Overgeschakeld naar Lokaal \(test\).*, omdat dit privéwerk is \(Testbot staat op privé\): Claude \(test\).* bewaart gesprekken, en privéwerk gaat alleen naar een lokaal model of een bron die niets bewaart\.$/.test(m.content)), events(t, th.id).map((m) => m.content).join(' | '));
    assert.equal(cat.queries[0]?.privacy, 'no-store', 'the catalogue is asked for sources that keep nothing only');
    assert.equal(cat.queries[0]?.includeLocal, false, 'local models come from the chain itself');
    // The local model fails: no switch to the free source that can train; said in the chat.
    t.script.push({ error: { message: 'Service unavailable', status: 503 } });
    await t.say(th.id, 'nog meer privé');
    assert.ok(!attempts(t, th.id).some((m) => m.parts.providerId === free.id), 'never on the source that can train');
    assert.ok(!attempts(t, th.id).some((m) => m.parts.providerId === claude.id), 'not on the main engine either (it keeps conversations)');
    assert.ok(events(t, th.id).some((m) => /^Niet overgeschakeld naar Gratis \(test\): dit is privéwerk/.test(m.content)), events(t, th.id).map((m) => m.content).join(' | '));
    // Without any private-safe engine the bot says so instead of sending anything.
    await t.api('PATCH', `/providers/${local.id}`, { enabled: false });
    const calls = t.requests.length;
    await t.say(th.id, 'en nu?');
    assert.equal(t.requests.length, calls, 'nothing was sent anywhere');
    assert.match(answers(t, th.id).at(-1)!.parts.error || '', /^Dit is privéwerk \(Testbot staat op privé\)\. Privéwerk gaat alleen naar een lokaal model of een bron die niets bewaart/);
  } finally {
    await t.close();
  }
});

test('sensitive memory in a turn: the main engine stays, but no switch to a source that keeps or trains on it', async () => {
  const t = await startTestApp();
  kinds(t);
  try {
    const claude = await t.api('POST', '/providers', { kind: 'mocksub', name: 'Claude (test)' });
    const free = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis (test)' });
    catalogue(t, [{ provider_id: free.id, model: 'llama-3.3-70b', privacy: 'may-train' }]);
    const a = await t.agent({ provider_id: claude.id, model: 'claude-test' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const item = await t.api('POST', '/memory/items', { content: 'Mijn bloedgroep is AB negatief', scope: 'about_you', sensitivity: 'sensitive' });
    const itemId = item.item?.id || item.id;
    assert.ok(itemId, JSON.stringify(item));
    const svc = t.app.ctx.services.engineChain;
    // The turn context used the item (as the memory module records it): this turn is private work.
    const msg = t.app.ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: a.user_id, author_name: 'Ik', content: 'wat is mijn bloedgroep?', parts: {} });
    t.app.ctx.store.insert('memory_usage', { id: 'mus_test', user_id: a.user_id, thread_id: th.id, message_id: msg.id, agent_id: a.id, via: 'context', refs: [{ p: 'm', ref: 'x', id: itemId, v: 1 }], tokens: 10, created_at: new Date().toISOString() });
    const run = { id: 'run_x', meta: {}, input_message_id: msg.id } as any;
    assert.deepEqual(svc.privateOf(run, t.app.ctx.store.agent(a.id), t.app.ctx.store.thread(th.id)), { mode: 'sensitive', why: 'dit gesprek gebruikt een gevoelige herinnering' });
    assert.equal(svc.privateOf({ ...run, input_message_id: 'other' }, t.app.ctx.store.agent(a.id), t.app.ctx.store.thread(th.id)), null);
    // Run it: Claude (the owner's own engine) hits its limit; the free source that can train is not used.
    t.script.push({ error: { message: 'Usage limit reached. Try again in 30 minutes.', status: 429 } });
    t.app.ctx.chat.startAgent(t.app.ctx.store.thread(th.id)!, a.id, msg.id, 'user');
    await t.waitIdle(th.id);
    assert.ok(!attempts(t, th.id).some((m) => m.parts.providerId === free.id));
    assert.ok(events(t, th.id).some((m) => /Niet overgeschakeld naar Gratis \(test\): dit is privéwerk \(dit gesprek gebruikt een gevoelige herinnering\)/.test(m.content)), events(t, th.id).map((m) => m.content).join(' | '));
  } finally {
    await t.close();
  }
});

test('an important routine pauses in the routine (whatever its limit choice) and the pause card points there', async () => {
  const t = await startTestApp();
  kinds(t);
  try {
    const claude = await t.api('POST', '/providers', { kind: 'mocksub', name: 'Claude (test)' });
    const free = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis (test)' });
    catalogue(t, [{ provider_id: free.id, model: 'llama-3.3-70b', privacy: 'may-train' }]);
    const a = await t.agent({ provider_id: claude.id, model: 'claude-test' });
    const r = await t.api('POST', '/routines', { name: 'Weekrapport', prompt: 'Maak het weekrapport', agent_id: a.id, schedule: { kind: 'none' }, options: { important: true, limitPolicy: 'skip' } });
    assert.equal(r.options.important, true);
    t.script.push({ error: { message: 'Usage limit reached. Try again in 30 minutes.', status: 429 } });
    const rr = await t.api('POST', `/routines/${r.id}/run`, {});
    const engine = t.app.ctx.services.routines.engine;
    await until(() => engine.getRun(rr.id)?.status === 'retrying', 10_000, 'routine run parked');
    const parked = engine.getRun(rr.id);
    assert.equal(parked.meta.limitWait?.important, true);
    assert.ok(Date.parse(parked.next_retry_at) > Date.now() + 29 * 60_000, 'waits until the reset, although the routine says "skip"');
    const core = t.app.ctx.store.run(parked.run_id)!;
    assert.equal(core.meta.important?.kind, 'routine');
    assert.equal(core.meta.important?.title, 'Weekrapport');
    assert.ok(core.meta.paused, 'the core run ended as paused');
    assert.equal(core.meta.limitRetryAt, undefined, 'the routine resumes it, not the runner (no double run)');
    const card = events(t, parked.thread_id).find((m) => m.parts.kind === 'work_paused')!;
    assert.equal(card.parts.pause.routineId, r.id);
    assert.ok(!attempts(t, parked.thread_id).some((m) => m.parts.providerId === free.id));
    // A normal routine on the same bot switches to the free model instead.
    const n = await t.api('POST', '/routines', { name: 'Nieuwtjes', prompt: 'Zoek nieuwtjes', agent_id: a.id, schedule: { kind: 'none' } });
    t.script.push({ text: 'nieuws van het gratis model' });
    const nr = await t.api('POST', `/routines/${n.id}/run`, {});
    await until(() => engine.getRun(nr.id)?.status === 'done', 10_000, 'normal routine done');
    assert.equal(answers(t, engine.getRun(nr.id).thread_id).at(-1)!.parts.providerId, free.id);
  } finally {
    await t.close();
  }
});

test('the pause card: "Nu doorgaan als gewoon werk" runs it now on the chain; "Niet hervatten" drops the resume', async () => {
  const t = await startTestApp();
  kinds(t);
  try {
    const claude = await t.api('POST', '/providers', { kind: 'mocksub', name: 'Claude (test)' });
    const free = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis (test)' });
    catalogue(t, [{ provider_id: free.id, model: 'llama-3.3-70b', privacy: 'may-train' }]);
    const a = await t.agent({ provider_id: claude.id, model: 'claude-test' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', '/rooms/tasks', { title: 'Jaarplan', ownerType: 'agent', ownerId: a.id, status: 'doing', important: true, sourceThreadId: th.id });
    t.script.push({ error: { message: 'Usage limit reached. Try again in 30 minutes.', status: 429 } });
    await t.say(th.id, 'Schrijf het jaarplan');
    const paused = runsOf(t, th.id)[0];
    t.script.push({ text: 'jaarplan op het gratis model' });
    const res = await t.api('POST', `/engine-chain/paused/${paused.id}`, { action: 'continue' });
    assert.ok(res.run);
    await t.waitIdle(th.id);
    assert.equal(answers(t, th.id).at(-1)!.content, 'jaarplan op het gratis model');
    assert.equal(answers(t, th.id).at(-1)!.parts.providerId, free.id);
    assert.equal(t.app.ctx.store.run(paused.id)!.meta.limitRetried, true, 'the scheduled resume is dropped');
    const card = events(t, th.id).find((m) => m.parts.kind === 'work_paused')!;
    assert.equal(card.parts.pause.state, 'continued');
    await assert.rejects(t.api('POST', `/engine-chain/paused/${paused.id}`, { action: 'cancel' }), /al hervat of gestopt/);
    // "Niet hervatten" on a new pause.
    t.app.ctx.services.runner.limited.set(claude.id, { until: Date.now() + 20 * 60_000, known: true });
    await t.say(th.id, 'En de begroting?');
    const second = runsOf(t, th.id).at(-1)!;
    assert.ok(second.meta.paused);
    await t.api('POST', `/engine-chain/paused/${second.id}`, { action: 'cancel' });
    assert.equal(t.app.ctx.store.run(second.id)!.meta.limitRetried, true);
    assert.equal(events(t, th.id).filter((m) => m.parts.kind === 'work_paused').at(-1)!.parts.pause.state, 'cancelled');
  } finally {
    await t.close();
  }
});

test('Instellingen: the chain can be turned off (then a bot without reserves stops at its limit as before) and shows its order', async () => {
  const t = await startTestApp();
  kinds(t);
  try {
    const claude = await t.api('POST', '/providers', { kind: 'mocksub', name: 'Claude (test)' });
    const codex = await t.api('POST', '/providers', { kind: 'mockcodex', name: 'Codex (test)' });
    const free = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis (test)' });
    const local = await t.api('POST', '/providers', { kind: 'mocklocal', name: 'Lokaal (test)', config: { defaultModel: 'qwen3:4b' } });
    catalogue(t, [{ provider_id: free.id, model: 'llama-3.3-70b', privacy: 'no-store' }]);
    const s = await t.api('GET', '/engine-chain/settings');
    assert.deepEqual(s.settings, { enabled: true, minLevel: 'top', weeklyReserve: 85 });
    assert.ok(s.levels.some((l: any) => l.id === 'top' && l.label === 'Claude of Codex'));
    const a = await t.agent({ provider_id: claude.id, model: 'claude-test' });
    const p = await t.api('GET', `/engine-chain/preview?agentId=${a.id}`);
    assert.equal(p.main.provider_id, claude.id);
    assert.deepEqual(p.chain.map((x: any) => [x.provider_id, x.source, x.privacy]), [
      [codex.id, 'subscription', 'stores'],
      [free.id, 'free', 'none'],
      [local.id, 'local', 'local'],
    ]);
    await assert.rejects(t.api('PUT', '/engine-chain/settings', { minLevel: 'super' }), /Onbekend minimumniveau/);
    assert.deepEqual(await t.api('PUT', '/engine-chain/settings', { enabled: false, minLevel: 'paid', weeklyReserve: 0 }), { enabled: false, minLevel: 'paid', weeklyReserve: 0 });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ error: { message: 'Usage limit reached. Try again in 30 minutes.', status: 429 } });
    await t.say(th.id, 'hallo');
    assert.equal(answers(t, th.id).at(-1)!.status, 'error', 'chain off: no switch');
    assert.ok(!events(t, th.id).some((m) => /Overgeschakeld/.test(m.content)));
    // A bot can opt out by itself too.
    await t.api('PUT', '/engine-chain/settings', { enabled: true });
    t.app.ctx.services.runner.limited.clear();
    const b = await t.agent({ name: 'Eigen', provider_id: claude.id, model: 'claude-test', settings: { freeChain: false } });
    const th2 = await t.api('POST', '/threads', { agentId: b.id });
    t.script.push({ error: { message: 'Usage limit reached. Try again in 30 minutes.', status: 429 } });
    await t.say(th2.id, 'hallo');
    assert.equal(answers(t, th2.id).at(-1)!.status, 'error');
  } finally {
    await t.close();
  }
});

test('the real free-model catalogue (D1): its order and availability decide the switch, and the earliest availableAt is the resume time of paused important work', async () => {
  const t = await startTestApp();
  kinds(t);
  try {
    const uid = t.app.ctx.auth.owner()!.id;
    // Groq and Z.ai as they are, only their adapter is the mock (no network): D1 offers their built-in free models.
    for (const id of ['groq', 'zai']) t.app.ctx.providers.registerKind({ ...t.app.ctx.providers.kind(id)!, create: () => mockAdapter(t.script, t.requests) });
    const claude = await t.api('POST', '/providers', { kind: 'mocksub', name: 'Claude (test)' });
    const groq = await t.api('POST', '/providers', { kind: 'groq', apiKey: 'gsk_test' });
    const zai = await t.api('POST', '/providers', { kind: 'zai', apiKey: 'zai-test' });
    const fm = t.app.ctx.services.freeModels;
    assert.equal(typeof fm.service, 'object', 'the real D1 service, not a stand-in');
    const now = Date.now();
    const zaiOf = (o?: any) => fm.candidates({ userId: uid, ...o }).find((c: any) => c.providerId === zai.id);
    assert.ok(fm.candidates({ userId: uid })[0].providerId === groq.id, 'D1 prefers Groq while both are free');
    // Groq waits for its limit (known reset in 2 hours); Z.ai is free.
    const groqBack = now + 2 * 3600_000;
    fm.report(groq.id, { limit: true, resetAt: groqBack });
    const listed = fm.candidates({ userId: uid });
    assert.equal(listed[0].providerId, zai.id);
    assert.ok(listed.filter((c: any) => c.providerId === groq.id).every((c: any) => !c.available && c.availableAt === groqBack));

    const reports: any[] = [];
    const real = fm.report;
    fm.report = (ref: any, o: any) => (reports.push({ ref, o }), real(ref, o));
    const a = await t.agent({ provider_id: claude.id, model: 'claude-test' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ error: { message: 'Usage limit reached. Try again in 5 hours.', status: 429 } }, { text: 'antwoord via Z.ai' });
    await t.say(th.id, 'hallo');
    assert.equal(answers(t, th.id).at(-1)!.content, 'antwoord via Z.ai');
    assert.deepEqual(attempts(t, th.id).map((m) => m.parts.providerId), [claude.id, zai.id], 'Groq waits, so D1\'s next candidate takes over; Groq is never called');
    assert.equal(answers(t, th.id).at(-1)!.parts.model, zaiOf().model, 'with the model D1 put first for Z.ai');
    assert.ok(reports.some((r) => r.ref?.providerId === zai.id && r.o === 'ok'), JSON.stringify(reports));
    const p = await t.api('GET', `/engine-chain/preview?agentId=${a.id}`);
    assert.deepEqual(p.chain.map((x: any) => x.provider_id), [zai.id, groq.id], 'the order of the catalogue');

    // Important work that may run on a free model: Z.ai now hits its limit too, Groq still waits. It pauses until the
    // earliest moment a source within the level is back: Groq's availableAt (+1 min), not Z.ai's or Claude's reset.
    await t.api('PUT', '/engine-chain/settings', { minLevel: 'free' });
    await t.api('POST', '/rooms/tasks', { title: 'Offerte', ownerType: 'agent', ownerId: a.id, status: 'doing', important: true, sourceThreadId: th.id });
    t.script.push({ error: { message: 'Rate limit reached. Try again in 3 hours.', status: 429 } });
    await t.say(th.id, 'Maak de offerte af');
    const paused = runsOf(t, th.id).at(-1)!;
    assert.equal(paused.meta.important?.kind, 'task');
    assert.equal(Date.parse(paused.meta.paused?.until), groqBack + 60_000, JSON.stringify(paused.meta.paused));
    assert.equal(paused.meta.paused.known, true);
    assert.equal(attempts(t, th.id).at(-1)!.parts.providerId, zai.id, 'tried Z.ai (within the level), never the waiting Groq');
    const zr = reports.find((r) => r.ref?.providerId === zai.id && r.o?.limit === true);
    assert.ok(zr, JSON.stringify(reports));
    const z = zaiOf();
    assert.equal(z.available, false, 'D1 heard the limit of Z.ai');
    assert.ok(z.availableAt > groqBack, 'and keeps it until Z.ai\'s own reset');
    assert.ok(events(t, th.id).some((m) => m.parts.kind === 'work_paused'));
  } finally {
    await t.close();
  }
});
