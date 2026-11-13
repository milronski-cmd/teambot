// Local models and their context window (acceptance round 6, B-18 and B-20). Live against Ollama 0.40.15 with a
// qwen3.6 GGUF (Jinja template, num_ctx 16384): after a 21 kB MCP result the next call failed with 500 "Jinja
// Exception: No user query found in messages". Ollama cuts a prompt that does not fit from the front, message by
// message; once the user's question is gone, the template raises. The fake Ollama below applies the same rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatMsg, ChatRequest, ToolSpec } from '../server/core/types.js';
import { builtinKinds } from '../server/providers/kinds.js';
import { autoWindow, fitToWindow, fitNotice } from '../server/providers/localmodels.js';
import { plainError } from '../server/agent/fallback.js';
import { startTestApp } from './helpers.js';

const tool = (name: string, app?: string, words = 40): ToolSpec => ({ name, description: `${app ? `[${app} · MCP] ` : ''}${'doet iets nuttigs '.repeat(words)}`, parameters: { type: 'object', properties: { q: { type: 'string', description: 'zoekterm '.repeat(words) } } }, ...(app ? { app } : {}) });
const docs = (n: number) => 'Azure Functions bewaart logboeken in Application Insights; standaard 90 dagen. '.repeat(Math.ceil(n / 80)).slice(0, n);
const turn = (q: string, result: string, id: string): ChatMsg[] => [
  { role: 'user', content: q },
  { role: 'assistant', content: '', toolCalls: [{ id, name: 'mcp_learn_microsoft_docs_search', args: { query: q } }] },
  { role: 'tool', toolCallId: id, toolName: 'mcp_learn_microsoft_docs_search', content: result },
];

/**
 * Ollama's rule (server/prompt.go): drop messages from the front (system stays) until the prompt fits num_ctx.
 * `fresh`: the model is not loaded and its Modelfile sets no window, like qwen3:1.7b straight from the library; Ollama
 * then runs it with its own default (`window`, 4K) and, when the instructions alone are bigger, keeps only a part of
 * the prompt and the model answers nothing (acceptance 12 Nov: 2,050 tokens evaluated, "Het model gaf geen antwoord").
 */
async function fakeOllama(o: { window: number; charsPerToken: number; fresh?: boolean; max?: number }) {
  const seen: any[] = [];
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      const send = (code: number, x: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
      if (req.url === '/api/ps') return send(200, { models: o.fresh ? [] : [{ name: 'qwen:latest', model: 'qwen:latest', context_length: o.window }] });
      if (req.url === '/api/show') return send(200, { parameters: o.fresh ? 'temperature 0.6' : `num_ctx ${o.window}`, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': o.max ?? 40960, 'qwen3.block_count': 28, 'qwen3.attention.head_count': 16, 'qwen3.attention.head_count_kv': 8, 'qwen3.attention.key_length': 128, 'qwen3.embedding_length': 2048 } });
      if (req.url !== '/api/chat' && req.url !== '/v1/chat/completions') return send(404, { error: 'not found' });
      seen.push(body);
      const window = body.options?.num_ctx || o.window;
      if (o.fresh) {
        const n = Math.ceil((JSON.stringify(body.tools || []).length + JSON.stringify(body.messages).length) / o.charsPerToken) + 400;
        const cut = n > window;
        const text = cut ? '' : 'Klaar: het bestand staat er.';
        const evaluated = cut ? Math.floor(window / 2) + 2 : n;
        if (req.url === '/api/chat') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write(JSON.stringify({ message: { thinking: 'Hmm.', content: text }, done: false }) + '\n');
          return res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: evaluated, eval_count: 4 }) + '\n');
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning: 'Hmm.', content: text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: evaluated, completion_tokens: 4 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      const system = body.messages.filter((m: any) => m.role === 'system');
      const rest = body.messages.filter((m: any) => m.role !== 'system');
      const tokens = (list: any[]) => Math.ceil((JSON.stringify(body.tools || []).length + JSON.stringify(list).length) / o.charsPerToken) + 400;
      let i = 0;
      while (i < rest.length - 1 && tokens([...system, ...rest.slice(i)]) > window) i++;
      const kept = rest.slice(i);
      if (!kept.some((m: any) => m.role === 'user')) return send(500, { error: "------------\nWhile executing CallExpression at line 79, column 24 in source:\n...{{- raise_exception('No user query found in messages.') }}\nError: Jinja Exception: No user query found in messages." });
      const n = tokens([...system, ...kept]);
      if (n > window) return send(400, { error: `request (${n} tokens) exceeds the available context size (${window} tokens), try increasing it` });
      if (req.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { content: 'Standaard 90 dagen.' }, done: false }) + '\n');
        return res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: n, eval_count: 4 }) + '\n');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Standaard 90 dagen.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: n, completion_tokens: 4 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => s.close(() => r())) };
}

const ollama = (url: string, config: any = {}) =>
  builtinKinds()
    .find((k) => k.id === 'ollama')!
    .create({ id: 'p', user_id: 'u', kind: 'ollama', name: 'Ollama', base_url: url + '/v1', secret_id: null, config, enabled: true, shared: false, created_at: '' }, null, {} as any);
const ask = (messages: ChatMsg[], tools: ToolSpec[] = [tool('read_file')]): ChatRequest => ({ model: 'qwen:latest', system: 'Je bent Lokaal. '.repeat(100), messages, tools });

test('fitting keeps the question: a big tool result is shortened, earlier turns go first, whole turns', () => {
  const msgs = [...turn('Eerste vraag', docs(20_000), 'c1'), { role: 'assistant' as const, content: 'Antwoord één.' }, ...turn('Hoe lang bewaart Azure Functions logboeken?', docs(60_000), 'c2')];
  const f = fitToWindow(ask(msgs), 8192);
  assert.equal(f.messages[0].role, 'user', 'the conversation still starts with a user message');
  assert.equal(f.messages[0].content, 'Hoe lang bewaart Azure Functions logboeken?', 'the earlier turn went first');
  assert.equal(f.dropped, 4);
  assert.equal(f.cut, 1);
  const result = String(f.messages.at(-1)!.content);
  assert.ok(result.length < 25_000 && result.length >= 1500);
  assert.match(result, /tekens weggelaten: de uitvoer past niet in het contextvenster van dit model; vraag gerichter/);
  assert.ok(result.startsWith('Azure Functions bewaart'), 'the start of the output stays');
  assert.equal(f.messages[1].toolCalls![0].id, 'c2', 'a tool call keeps its result');
  assert.match(fitNotice(f)!, /tool-uitvoer paste niet in het contextvenster van dit model en is ingekort/);
  // What fits is left alone.
  const small = ask(turn('Kort?', 'ja', 'c3'));
  const same = fitToWindow(small, 8192);
  assert.equal(same.messages, small.messages);
  assert.equal(fitNotice(same), undefined);
});

test('fitting leaves out app tools the conversation does not use (B-20), never the app in use or named', () => {
  const tools = [tool('read_file'), tool('write_file')];
  for (const app of ['Notion', 'Linear', 'GitHub', 'Microsoft Learn', 'Context7'])
    for (let i = 0; i < 10; i++) tools.push(tool(app === 'Microsoft Learn' && !i ? 'mcp_learn_microsoft_docs_search' : `mcp_${app.toLowerCase().replace(/\W/g, '')}_t${i}`, app, 60));
  const f = fitToWindow(ask([{ role: 'user', content: 'Zet dit in GitHub: een issue over de logboeken.' }], tools), 16384);
  assert.ok(f.leftOut.length >= 1 && f.leftOut.length < 5, `some apps left out: ${f.leftOut}`);
  assert.ok(!f.leftOut.includes('GitHub'), 'the app named in the question stays');
  assert.ok(f.tools.some((t) => t.name === 'read_file') && f.tools.some((t) => t.name === 'write_file'), "TeamBot's own tools stay");
  assert.ok(f.tools.every((t) => !t.app || !f.leftOut.includes(t.app)));
  assert.match(fitNotice(f)!, /deze beurt kreeg de tools van (die app|deze apps) niet/);
  // An app the bot already called in this conversation stays too.
  const used = fitToWindow(ask([...turn('Zoek iets', 'gevonden', 'c1'), { role: 'assistant', content: 'Gevonden.' }, { role: 'user', content: 'En nu?' }], tools), 16384);
  assert.ok(used.leftOut.length >= 1);
  assert.ok(!used.leftOut.includes('Microsoft Learn'), `in use: ${used.leftOut}`);
});

test('Ollama: the second call after a big MCP result gets an answer instead of "No user query found" (B-18)', async () => {
  const srv = await fakeOllama({ window: 8192, charsPerToken: 3.8 });
  try {
    const msgs = turn('Hoe lang bewaart Azure Functions logboeken?', docs(24_000 * 2), 'c1');
    // Without fitting, the fake (like Ollama) cuts the question away and the template raises.
    const raw = await fetch(`${srv.url}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'qwen:latest', messages: [{ role: 'system', content: 'x' }, ...msgs.map((m) => ({ role: m.role, content: m.content }))], options: { num_ctx: 8192 } }) });
    assert.equal(raw.status, 500);
    // Native path (a chosen window): the request fits, the question is still in it, the answer comes.
    const native = ollama(srv.url, { contextWindows: { 'qwen:latest': 8192 } });
    const r = await native.chat!(ask(msgs), new AbortController().signal, () => {});
    assert.equal(r.text, 'Standaard 90 dagen.');
    assert.match(r.notice || '', /ingekort/);
    const sent = srv.seen.at(-1);
    assert.equal(sent.options.num_ctx, 8192);
    assert.ok(sent.messages.some((m: any) => m.role === 'user' && /Azure Functions logboeken/.test(m.content)));
    // OpenAI layer (no window chosen): the window Ollama runs the model with comes from /api/ps.
    const compat = ollama(srv.url);
    const before = srv.seen.length;
    const r2 = await compat.chat!(ask(msgs), new AbortController().signal, () => {});
    assert.equal(r2.text, 'Standaard 90 dagen.');
    assert.equal(srv.seen.length, before + 1, 'one call, no retry needed');
  } finally {
    await srv.close();
  }
});

test('Ollama: when its count is stricter than the estimate, TeamBot sends once more with a strict count', async () => {
  // A tokenizer that needs a token per 2.6 characters: the first estimate (3.5) is too optimistic.
  const srv = await fakeOllama({ window: 8192, charsPerToken: 2.6 });
  try {
    const a = ollama(srv.url, { contextWindows: { 'qwen:latest': 8192 } });
    const r = await a.chat!(ask(turn('Hoe lang bewaart Azure Functions logboeken?', docs(30_000), 'c1')), new AbortController().signal, () => {});
    assert.equal(r.text, 'Standaard 90 dagen.');
    assert.equal(srv.seen.length, 2, 'refused once, then answered');
  } finally {
    await srv.close();
  }
});

test('Ollama: a question that does not fit at all is "Gesprek te lang", never "overbelast"', async () => {
  const srv = await fakeOllama({ window: 2048, charsPerToken: 3 });
  try {
    const a = ollama(srv.url, { contextWindows: { 'qwen:latest': 2048 } });
    const err: any = await a.chat!(ask([{ role: 'user', content: 'Lees dit: ' + docs(30_000) }]), new AbortController().signal, () => {}).catch((e) => e);
    assert.equal(err.category, 'context');
    assert.match(plainError(err, { engine: 'Lokaal' }), /^Lokaal: Gesprek te lang voor dit model\./);
    // The question was there, the template still raised: Ollama cut it away, so the conversation did not fit.
    const err2: any = await a.chat!(ask([...turn('Vraag', docs(9_000), 'c1')], Array.from({ length: 4 }, (_, i) => tool(`t${i}`, undefined, 30))), new AbortController().signal, () => {}).catch((e) => e);
    assert.equal(err2.category, 'context', err2.message);
    assert.match(err2.message, /Ollama kortte het gesprek in omdat het niet in het contextvenster past, en daarbij viel de vraag weg/);
    assert.doesNotMatch(plainError(err2, { engine: 'Lokaal' }), /overbelast/);
    // Thirty tools that alone are bigger than the window: that is said, and nothing goes out for Ollama to cut.
    const before = srv.seen.length;
    const err3: any = await a.chat!(ask([...turn('Vraag', docs(9_000), 'c1')], Array.from({ length: 30 }, (_, i) => tool(`t${i}`, undefined, 30))), new AbortController().signal, () => {}).catch((e) => e);
    assert.equal(err3.category, 'tools', err3.message);
    assert.equal(srv.seen.length, before);
    assert.doesNotMatch(plainError(err3, { engine: 'Lokaal' }), /overbelast/);
  } finally {
    await srv.close();
  }
});

// B-20: five apps (50 tools) on a 16k local model failed on the very first message with "Gesprek te lang voor dit
// model … laat het gesprek samenvatten" — summarising cannot help when the conversation is one sentence.
test('"too long" on a short conversation names the tools and instructions; on a long one it stays "Gesprek te lang"', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ tool_groups: ['files', 'memory'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const tooLong = { message: 'Ollama: 400 Gesprek te lang voor dit model — request (18999 tokens) exceeds the available context size (16384 tokens), try increasing it', status: 400, category: 'context' as const };
    t.script.push({ error: tooLong });
    let msgs = await t.say(th.id, 'Hoi, wat kun je?');
    const short = msgs.filter((m) => m.role === 'assistant').at(-1)!;
    assert.equal(short.status, 'error');
    assert.match(short.parts.error || '', /De tools en instructies van deze bot passen niet in het contextvenster\. Zet minder apps aan voor deze bot/);
    assert.doesNotMatch(short.parts.error || '', /samenvatten"\)/);
    t.script.push({ error: tooLong });
    msgs = await t.say(th.id, 'Lees dit en vat het samen: ' + docs(200_000));
    const long = msgs.filter((m) => m.role === 'assistant').at(-1)!;
    assert.match(long.parts.error || '', /Gesprek te lang voor dit model\. Kies een model met een groter contextvenster, of laat het gesprek samenvatten/);
  } finally {
    await t.close();
  }
});


// ------------------------------------------------------------------ a window that fits TeamBot by default (acceptance 12 Nov)

/** A bot the size TeamBot makes: instructions of about 6K tokens and twenty tools. */
const botRequest = (model = 'qwen:latest'): ChatRequest => ({
  model,
  system: 'Je bent een behulpzame bot in TeamBot. Gebruik je tools om het werk echt te doen. '.repeat(260),
  messages: [{ role: 'user', content: 'Schrijf een bestand met de datum van vandaag.' }],
  tools: Array.from({ length: 20 }, (_, i) => tool(`tool_${i}`, undefined, 6)),
});

test("Ollama without a chosen window: the whole prompt arrives (16K), not cut by Ollama's own 4K window", async () => {
  const srv = await fakeOllama({ window: 4096, charsPerToken: 3.5, fresh: true });
  try {
    const r = await ollama(srv.url).chat!(botRequest(), new AbortController().signal, () => {});
    assert.equal(r.text, 'Klaar: het bestand staat er.', 'the model saw the whole prompt and answered');
    const sent = srv.seen.at(-1);
    assert.equal(sent.options?.num_ctx, 16384, 'TeamBot gives the model a window that fits the bot');
    assert.ok(r.usage.input > 6000, `all of the prompt was evaluated: ${r.usage.input} tokens`);
    // A model whose own maximum is smaller: never above it.
    const small = await fakeOllama({ window: 4096, charsPerToken: 3.5, fresh: true, max: 8192 });
    try {
      await ollama(small.url).chat!({ ...botRequest(), system: 'Kort.' }, new AbortController().signal, () => {});
      assert.equal(small.seen.at(-1).options.num_ctx, 8192);
    } finally {
      await small.close();
    }
  } finally {
    await srv.close();
  }
});

test('the window by itself: 16K for a bot with tools, bigger only when its instructions need it, within model and memory', () => {
  assert.equal(autoWindow({ tokens: 7000 }), 16384);
  assert.equal(autoWindow({ tokens: 12_000 }), 32768, 'more instructions and tools: the next step');
  assert.equal(autoWindow({ tokens: 12_000, max: 20_000 }), 20_000, 'never above what the model can');
  assert.equal(autoWindow({ tokens: 7000, current: 32768 }), 32768, 'already loaded with a window that is big enough: no reload');
  assert.equal(autoWindow({ tokens: 7000, current: 4096 }), 16384, "Ollama's own 4K is too small: replaced");
  assert.equal(autoWindow({ tokens: 30_000, kvPerToken: 114688, memory: 8 * 1024 ** 3 }), 16384, 'the extra memory stays within a quarter of the computer');
  assert.equal(autoWindow({ tokens: 30_000, kvPerToken: 114688, memory: 64 * 1024 ** 3 }), 65536);
});

test('instructions that do not fit are named as such: refused when they cannot fit, a notice when they crowd out', async () => {
  // An owner who chose 4K himself: TeamBot's instructions and tools cannot fit; Ollama would keep a part of them.
  const srv = await fakeOllama({ window: 4096, charsPerToken: 3.5, fresh: true });
  try {
    const err: any = await ollama(srv.url, { contextWindows: { 'qwen:latest': 4096 } })
      .chat!(botRequest(), new AbortController().signal, () => {})
      .catch((e) => e);
    assert.equal(err?.category, 'tools', `refused before it went out: ${err?.message || err?.text}`);
    assert.match(err.message, /±\d+K tokens nodig, het contextvenster van dit model is 4K/);
    assert.equal(srv.seen.length, 0, 'nothing was sent');
    assert.match(plainError(err, { engine: 'Lokaal' }), /De tools en instructies van deze bot passen niet in het contextvenster/);
  } finally {
    await srv.close();
  }
  // They fit, but leave too little room: the notice names the instructions, not the tool output.
  const big = { ...botRequest(), system: 'Je bent een behulpzame bot in TeamBot. '.repeat(1150), messages: turn('Hoe lang?', docs(20_000), 'c1') };
  const f = fitToWindow(big, 16384);
  assert.equal(f.over, true);
  const notice = fitNotice(f)!;
  assert.match(notice, /De instructies en tools van deze bot \(±1\dK tokens\) laten in het contextvenster van dit model \(16K\) te weinig ruimte over/);
  assert.doesNotMatch(notice, /tool-uitvoer/);
});

test('a model that answers nothing: the answer and the run say it failed, never "klaar"', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: '' });
    const msgs = await t.say(th.id, 'Schrijf een bestand.');
    const last = msgs.filter((m) => m.role === 'assistant').at(-1)!;
    assert.equal(last.status, 'error');
    assert.equal(last.parts.error, 'Het model gaf een leeg antwoord. Probeer het opnieuw.');
    const run = t.app.ctx.store.run(last.run_id!)!;
    assert.equal(run.status, 'error');
    assert.match(run.error || '', /leeg antwoord/);
    // A normal answer still ends as done.
    t.script.push({ text: 'Gedaan.' });
    const ok = (await t.say(th.id, 'Nog een keer.')).filter((m) => m.role === 'assistant').at(-1)!;
    assert.equal(ok.status, 'done');
    assert.equal(t.app.ctx.store.run(ok.run_id!)!.status, 'done');
    // A turn that did its work (a tool call) and ends without closing words is done, not failed: a routine that has
    // nothing new to say stays quiet (parity-04 [9.4]).
    t.script.push({ toolCalls: [{ name: 'plan_update', args: { steps: [{ text: 'Nakijken', status: 'completed' }] } }] }, { text: '' });
    const quiet = (await t.say(th.id, 'Kijk het na.')).filter((m) => m.role === 'assistant').at(-1)!;
    assert.equal(quiet.status, 'done', String(quiet.parts.error || ''));
    assert.equal(quiet.parts.error, undefined);
    assert.equal(t.app.ctx.store.run(quiet.run_id!)!.status, 'done');
  } finally {
    await t.close();
  }
});

test('LM Studio without a chosen window: the model is loaded with one that fits the bot, not its own 4K', async () => {
  const loads: any[] = [];
  let loaded = 0;
  const s = http.createServer((rq, res) => {
    let b = '';
    rq.on('data', (d) => (b += d));
    rq.on('end', () => {
      const send = (code: number, x: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
      if (rq.url === '/api/v0/models') return send(200, { data: [{ id: 'qwen', type: 'llm', state: loaded ? 'loaded' : 'not-loaded', max_context_length: 32768, ...(loaded ? { loaded_context_length: loaded } : {}) }] });
      if (rq.url === '/api/v1/models/load') {
        loads.push(JSON.parse(b));
        loaded = JSON.parse(b).context_length;
        return send(200, { type: 'llm', instance_id: 'qwen', status: 'loaded' });
      }
      if (rq.url !== '/v1/chat/completions') return send(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Gedaan.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const lm = () =>
    builtinKinds()
      .find((k) => k.id === 'lmstudio')!
      .create({ id: 'p', user_id: 'u', kind: 'lmstudio', name: 'LM Studio', base_url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`, secret_id: null, config: {}, enabled: true, shared: false, created_at: '' }, null, {} as any);
  try {
    const r = await lm().chat!(botRequest('qwen'), new AbortController().signal, () => {});
    assert.equal(r.text, 'Gedaan.');
    assert.deepEqual(loads, [{ model: 'qwen', context_length: 16384 }]);
    // Loaded with a window that is big enough: left alone.
    await lm().chat!(botRequest('qwen'), new AbortController().signal, () => {});
    assert.equal(loads.length, 1);
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
});
