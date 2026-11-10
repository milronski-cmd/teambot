// Conformance tests per provider family, without network: a local HTTP server replays recorded answers
// (tests/fixtures/providers/recorded, captured live by tests/e2e/providers-live.mjs) and answers built from each
// provider's documentation (tests/fixtures/providers/errors.json and the streams below, URL per case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatRequest } from '../server/core/types.js';
import { ENGINE_KIND, ProviderError, categorize, categoryOf, explain, modelsAvailable, providerErrorFrom } from '../server/providers/common.js';
import { ThinkSplitter, clearModelQuirks, openaiCompat, toOpenAIMessages } from '../server/providers/openai-compat.js';
import { anthropicAdapter } from '../server/providers/anthropic.js';
import { toResponsesInput } from '../server/providers/openai-responses.js';
import { bedrockAdapter } from '../server/providers/bedrock.js';
import { EventStreamDecoder, encodeEventStream, parseBedrockSecret, signV4 } from '../server/providers/aws.js';
import { serviceAccountJwt, vertexTokenSource } from '../server/providers/vertex.js';
import { LOCAL_PROBES, localDetect } from '../server/providers/local.js';
import { PROVIDERS, pickDefault } from '../server/providers/catalog.js';
import { azureBase, builtinKinds, vertexBase } from '../server/providers/kinds.js';
import { builtinPriceTable, clearListPrices, estimateCost, priceInfo, rememberListPrices } from '../server/providers/pricing.js';
import { classifyEngineError, plainError } from '../server/agent/fallback.js';
import { CLI_DEFS } from '../server/modules/cli-agents/catalog.js';
import { decorateModels } from '../server/api/providers.js';
import { startTestApp } from './helpers.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'providers');
const recorded = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, 'recorded', `${name}.json`), 'utf8'));
const kinds = new Map(builtinKinds().map((k) => [k.id, k]));
const cfgFor = (kind: string, extra: any = {}) => ({ id: 'p', user_id: 'u', kind, name: kind, base_url: '', secret_id: null, config: {}, enabled: true, shared: false, created_at: '', ...extra });
const noop = () => {};
const sig = () => new AbortController().signal;
const WEATHER = { name: 'get_weather', description: 'Weer', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: 'm', system: 'kort', messages: [{ role: 'user', content: 'hallo' }], tools: [], ...over });

// ---------------------------------------------------------------------------------------------------------------
// Fixture server: routes are matched in order (method + path); each route answers once unless `repeat` is set.

interface Route {
  method?: string;
  path: string | RegExp;
  status?: number;
  headers?: Record<string, string>;
  body?: string | object;
  sse?: (string | object)[];
  raw?: Buffer;
  repeat?: boolean;
  used?: boolean;
}
interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

async function serve(routes: Route[]) {
  const seen: Seen[] = [];
  const srv = http.createServer((rq, rs) => {
    let data = '';
    rq.on('data', (c) => (data += c));
    rq.on('end', () => {
      const url = rq.url || '/';
      let body: any = data;
      try {
        body = data ? JSON.parse(data) : undefined;
      } catch {
        /* form or text */
      }
      seen.push({ method: rq.method || 'GET', path: url, headers: rq.headers, body });
      const r = routes.find((x) => !x.used && (!x.method || x.method === rq.method) && (typeof x.path === 'string' ? url.split('?')[0] === x.path : x.path.test(url)));
      if (!r) {
        rs.writeHead(404, { 'content-type': 'application/json' });
        return rs.end(JSON.stringify({ error: { message: `no fixture for ${rq.method} ${url}` } }));
      }
      if (!r.repeat) r.used = true;
      if (r.raw) {
        rs.writeHead(r.status ?? 200, { 'content-type': 'application/vnd.amazon.eventstream', ...(r.headers || {}) });
        return rs.end(r.raw);
      }
      if (r.sse) {
        rs.writeHead(r.status ?? 200, { 'content-type': 'text/event-stream', ...(r.headers || {}) });
        for (const ev of r.sse) rs.write(typeof ev === 'string' ? (ev.startsWith('event:') || ev.startsWith(':') ? ev + '\n\n' : `data: ${ev}\n\n`) : `data: ${JSON.stringify(ev)}\n\n`);
        return rs.end();
      }
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
      rs.writeHead(r.status ?? 200, { 'content-type': typeof r.body === 'string' && /^\s*</.test(r.body) ? 'text/html' : 'application/json', ...(r.headers || {}) });
      rs.end(text);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { url, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** Routes from a recorded fixture file (same order as recorded). */
function replay(name: string): Route[] {
  return recorded(name).entries.map((e: any) => {
    const p = new URL(e.url).pathname;
    if (/event-stream/.test(e.contentType)) return { method: e.method, path: p, status: e.status, sse: e.body.split('\n\n').filter((x: string) => x.trim()).map((x: string) => x.replace(/^data: /, '')) };
    return { method: e.method, path: p, status: e.status, body: e.body };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Error mapping (all families): category, Dutch text, reserve-engine reason, retry-after.

test('error bodies of 30+ providers map to the right plain-language category and reserve reason', () => {
  const { cases } = JSON.parse(fs.readFileSync(path.join(FIX, 'errors.json'), 'utf8'));
  assert.ok(cases.length >= 60);
  const wrong: string[] = [];
  for (const c of cases) {
    const body = typeof c.body === 'string' ? c.body : JSON.stringify(c.body);
    const headers = new Headers(c.headers || {});
    const res = { headers, status: c.status } as any;
    let err = providerErrorFrom(c.provider, c.status, body, res);
    if (c.headers?.['x-amzn-errortype']) err = providerErrorFrom(c.provider, c.status, JSON.stringify({ __type: c.headers['x-amzn-errortype'].split(':')[0], ...JSON.parse(body) }), res);
    if (err.category !== c.expect) wrong.push(`${c.provider} ${c.status}: ${err.category} ≠ ${c.expect} (${err.message.slice(0, 120)})`);
    assert.equal(classifyEngineError(err), ENGINE_KIND[c.expect as keyof typeof ENGINE_KIND], `${c.provider}: reserve reason`);
    if (c.retryAfter) assert.equal(err.retryAfter, c.retryAfter, `${c.provider}: retry-after`);
    assert.ok(err.message.startsWith(`${c.provider}: `) && (c.status === 200 || err.message.includes(String(c.status))), 'label and status stay in the message');
  }
  assert.deepEqual(wrong, []);
  // The reserve logic: no credit and rate limits are "limit", a vanished model is "unavailable" (reserve takes over).
  assert.equal(classifyEngineError(new ProviderError('x', 402, false, '', 'quota')), 'limit');
  assert.equal(classifyEngineError(new ProviderError('x', 404, false, '', 'model')), 'unavailable');
  assert.equal(classifyEngineError(new ProviderError('x', 400, false, '', 'context')), 'other', 'too long: no engine switch, the conversation is the problem');
  // Network failures without a status.
  assert.equal(categoryOf(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'network');
  assert.equal(categorize(0, 'socket hang up'), 'network');
});

test('fix hints are Dutch and point to the provider key page', () => {
  const e = providerErrorFrom('OpenAI', 401, JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  const x = explain(e, { keyUrl: 'https://platform.openai.com/api-keys' });
  assert.equal(x.title, 'Sleutel ongeldig of verlopen');
  assert.match(x.hint, /nieuwe API-sleutel aan op https:\/\/platform\.openai\.com\/api-keys/);
  assert.match(e.message, /^OpenAI: 401 Sleutel ongeldig of verlopen — Incorrect API key/);
  assert.match(explain(providerErrorFrom('X', 402, '{}')).title, /Geen tegoed/);
  assert.match(explain(providerErrorFrom('X', 404, JSON.stringify({ error: { message: 'model foo not found' } }))).title, /Model bestaat niet/);
});

// Acceptance round 6 (B-18): Ollama's 500 "Jinja Exception: No user query found in messages" was shown as "Provider
// overbelast of tijdelijk onbereikbaar. Probeer het zo opnieuw" — trying again gives the same error.
test('a chat template that refuses the messages is named as such, is no outage and is not retried', () => {
  const e = providerErrorFrom('Ollama', 500, JSON.stringify({ error: "While executing CallExpression at line 79\nError: Jinja Exception: No user query found in messages." }));
  assert.equal(e.category, 'template');
  assert.equal(e.retryable, false);
  assert.equal(classifyEngineError(e), 'other');
  assert.match(plainError(e, { engine: 'Lokaal' }), /^Lokaal: Dit model kan dit gesprek niet verwerken\. Het chatsjabloon van het model weigert de berichten/);
  assert.doesNotMatch(plainError(e, { engine: 'Lokaal' }), /overbelast/);
  for (const text of ['Error rendering prompt with jinja template: Conversation roles must alternate user/assistant/user/assistant/...', 'Failed to apply chat template', 'System message must be at the beginning.'])
    assert.equal(providerErrorFrom('X', 400, JSON.stringify({ error: text })).category, 'template', text);
  // A server that does not know a parameter with "chat_template" in its name is no template problem.
  assert.equal(providerErrorFrom('X', 400, JSON.stringify({ error: 'Unrecognized request argument supplied: chat_template_kwargs' })).category, 'bad_request');
  // A real overload stays an overload.
  assert.equal(providerErrorFrom('Ollama', 500, JSON.stringify({ error: 'internal server error' })).category, 'overloaded');
});

// ---------------------------------------------------------------------------------------------------------------
// OpenAI (recorded live 2026-11-07 against api.openai.com with gpt-6-luna)

test('OpenAI (recorded): model list, text, parallel tools after the reasoning quirk, tool results, image in, errors', async () => {
  clearModelQuirks();
  const srv = await serve([...replay('openai-models'), ...replay('openai-text'), ...replay('openai-tools'), ...replay('openai-tools').slice(1), ...replay('openai-toolresult'), ...replay('openai-image'), ...replay('openai-error-model')]);
  try {
    const k = kinds.get('openai')!;
    const a = k.create(cfgFor('openai', { base_url: srv.url + '/v1', config: { api: 'chat' } }), 'sk-test', {} as any);
    const models = await a.listModels();
    assert.ok(models.length > 20 && models.every((m) => !/embedding|tts|whisper|realtime|image|transcribe/.test(m.id)), 'only chat models');
    assert.equal(pickDefault(models, k.recommend), 'gpt-6.1-terra');
    const deco = decorateModels(k, models);
    const terra = deco.find((m) => m.id === 'gpt-6.1-terra')!;
    assert.deepEqual(terra.price, [1, 5]);
    assert.equal(terra.priceSource, 'catalogus');
    assert.match(terra.priceChecked!, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(terra.recommended, true);
    assert.ok(deco.filter((m) => m.recommended).length === 1);

    const t = await a.chat!(req({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Zeg alleen het woord: hallo' }], reasoning: 'low', maxTokens: 600 }), sig(), noop);
    assert.match(t.text, /hallo/i);
    assert.ok(t.usage.input > 0 && t.usage.output > 0);
    assert.equal(t.stop, 'end');
    const sent = srv.seen.find((s) => s.path === '/v1/chat/completions')!.body;
    assert.equal(sent.max_completion_tokens, 600, 'OpenAI wants max_completion_tokens');
    assert.equal(sent.reasoning_effort, 'low');

    // gpt-6 refuses tools + reasoning in Chat Completions: retried with reasoning_effort "none", tools kept.
    const q = 'Wat is het weer in Amsterdam en in Utrecht? Roep de tool voor beide steden tegelijk aan.';
    const events: any[] = [];
    const tc = await a.chat!(req({ model: 'gpt-6-luna', messages: [{ role: 'user', content: q }], tools: [WEATHER], reasoning: 'low', maxTokens: 600 }), sig(), (e) => events.push(e));
    assert.equal(tc.toolCalls.length, 2, 'parallel tool calls');
    assert.deepEqual(tc.toolCalls.map((c) => c.args.city).sort(), ['Amsterdam', 'Utrecht']);
    assert.equal(tc.stop, 'tool_use');
    assert.equal(events.filter((e) => e.type === 'tool_start').length >= 2, true);
    const toolReqs = srv.seen.filter((s) => s.body?.tools);
    assert.equal(toolReqs.at(-1)!.body.reasoning_effort, 'none');
    assert.equal(toolReqs.at(-1)!.body.tools.length, 1, 'tools are never dropped for this error');
    // The quirk is remembered: the next tool turn goes straight to reasoning_effort "none" (one request).
    const before = srv.seen.length;
    const tc2 = await a.chat!(req({ model: 'gpt-6-luna', messages: [{ role: 'user', content: q }], tools: [WEATHER], reasoning: 'low', maxTokens: 600 }), sig(), noop);
    assert.equal(srv.seen.length - before, 1);
    assert.equal(tc2.toolCalls.length, 2);

    const back = await a.chat!(
      req({
        model: 'gpt-6-luna',
        tools: [WEATHER],
        messages: [{ role: 'user', content: q }, { role: 'assistant', content: '', toolCalls: tc.toolCalls }, ...tc.toolCalls.map((c) => ({ role: 'tool' as const, toolCallId: c.id, content: `Zonnig, 21 graden in ${c.args.city}.` }))],
      }),
      sig(),
      noop,
    );
    assert.match(back.text, /21/);
    const histReq = srv.seen.at(-1)!.body;
    assert.equal(histReq.messages.filter((m: any) => m.role === 'tool').length, 2, 'both tool results sent back');
    assert.equal(histReq.messages.find((m: any) => m.role === 'assistant').tool_calls.length, 2);

    const im = await a.chat!(req({ model: 'gpt-6-luna', messages: [{ role: 'user', content: [{ type: 'text', text: 'Welke kleur?' }, { type: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' }] }] }), sig(), noop);
    assert.match(im.text, /rood/i);
    const imgPart = srv.seen.at(-1)!.body.messages[1].content[1];
    assert.equal(imgPart.type, 'image_url');
    assert.match(imgPart.image_url.url, /^data:image\/png;base64,/);

    await assert.rejects(a.chat!(req({ model: 'gpt-teambot-bestaat-niet' }), sig(), noop), (e: any) => e.category === 'model' && classifyEngineError(e) === 'unavailable' && /Model bestaat niet/.test(e.message));
  } finally {
    await srv.close();
  }
});

test('OpenAI Responses API (recorded): parallel tools with reasoning, items replayed in the tool loop, image in, unknown model', async () => {
  const srv = await serve([...replay('openai-resp-text'), ...replay('openai-resp-tools'), ...replay('openai-resp-toolresult'), ...replay('openai-resp-image'), ...replay('openai-resp-error-model')]);
  try {
    const a = kinds.get('openai')!.create(cfgFor('openai', { base_url: srv.url + '/v1' }), 'sk-test', {} as any);
    const t = await a.chat!(req({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Zeg alleen het woord: hallo' }], reasoning: 'low', maxTokens: 600 }), sig(), noop);
    assert.match(t.text, /hallo/i);
    assert.ok(t.usage.input > 0 && t.usage.output > 0);
    const b0 = srv.seen[0].body;
    assert.equal(srv.seen[0].path, '/v1/responses');
    assert.deepEqual([b0.store, b0.instructions, b0.max_output_tokens, b0.reasoning.effort], [false, 'kort', 600, 'low']);
    assert.deepEqual(b0.include, ['reasoning.encrypted_content']);
    const q = 'Wat is het weer in Amsterdam en in Utrecht? Roep de tool voor beide steden tegelijk aan.';
    const tc = await a.chat!(req({ model: 'gpt-6-luna', messages: [{ role: 'user', content: q }], tools: [WEATHER], reasoning: 'low', maxTokens: 600 }), sig(), noop);
    assert.deepEqual(tc.toolCalls.map((c) => c.args.city).sort(), ['Amsterdam', 'Utrecht']);
    assert.equal(srv.seen[1].body.reasoning.effort, 'low', 'reasoning stays on together with tools');
    assert.deepEqual(srv.seen[1].body.tools[0], { type: 'function', name: 'get_weather', description: 'Weer', parameters: WEATHER.parameters, strict: false });
    assert.equal(tc.raw!.provider, 'oa-resp:openai');
    const back = await a.chat!(req({ model: 'gpt-6-luna', tools: [WEATHER], messages: [{ role: 'user', content: q }, { role: 'assistant', content: '', toolCalls: tc.toolCalls, raw: tc.raw }, ...tc.toolCalls.map((c) => ({ role: 'tool' as const, toolCallId: c.id, content: `Zonnig, 21 graden in ${c.args.city}.` }))], reasoning: 'low', maxTokens: 600 }), sig(), noop);
    assert.match(back.text, /21/);
    const input = srv.seen[2].body.input;
    assert.deepEqual(input.map((i: any) => i.type || i.role), ['user', 'function_call', 'function_call', 'function_call_output', 'function_call_output'], "the model's own items go back unchanged");
    const im = await a.chat!(req({ model: 'gpt-6-luna', messages: [{ role: 'user', content: [{ type: 'text', text: 'Welke kleur?' }, { type: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' }] }] }), sig(), noop);
    assert.match(im.text, /rood/i);
    assert.equal(srv.seen[3].body.input[0].content[1].type, 'input_image');
    await assert.rejects(a.chat!(req({ model: 'gpt-teambot-bestaat-niet' }), sig(), noop), (e: any) => e.category === 'model');
  } finally {
    await srv.close();
  }
});

test('OpenAI Responses API (docs): reasoning summaries, encrypted reasoning replay, failed response, fallback to Chat Completions', async () => {
  const sse = (events: any[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`);
  const srv = await serve([
    {
      path: '/v1/responses',
      sse: sse([
        { type: 'response.created', response: { id: 'r1', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } },
        { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Eerst het weer ' },
        { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'opzoeken.' },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Eerst het weer opzoeken.' }], encrypted_content: 'ENC123' } },
        { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'get_weather', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":"Zwolle"}' },
        { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'get_weather', arguments: '{"city":"Zwolle"}', status: 'completed' } },
        { type: 'response.completed', response: { id: 'r1', status: 'completed', model: 'gpt-6.1-terra', usage: { input_tokens: 80, input_tokens_details: { cached_tokens: 64 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 } } } },
      ]),
    },
    { path: '/v1/responses', sse: sse([{ type: 'response.created', response: { status: 'in_progress' } }, { type: 'response.output_text.delta', delta: 'Zon.' }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } }]) },
    { path: '/v1/responses', sse: sse([{ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'The server had an error.' } } }]) },
    { path: '/v1/responses', status: 400, body: { error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", param: 'reasoning.effort' } } },
    { path: '/v1/responses', sse: sse([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }]) },
  ]);
  try {
    const a = kinds.get('openai')!.create(cfgFor('openai', { base_url: srv.url + '/v1' }), 'sk', {} as any);
    const r = await a.chat!(req({ model: 'gpt-6.1-terra', tools: [WEATHER], reasoning: 'xhigh' }), sig(), noop);
    assert.equal(r.reasoning, 'Eerst het weer opzoeken.');
    assert.deepEqual(r.toolCalls, [{ id: 'call_9', name: 'get_weather', args: { city: 'Zwolle' } }]);
    assert.deepEqual(r.usage, { input: 80, output: 30, cacheRead: 64, reasoning: 12 });
    assert.equal(srv.seen[0].body.reasoning.effort, 'xhigh', "gpt-6.1-terra's own page lists xhigh (capabilities.ts)");
    await a.chat!(req({ model: 'gpt-6.1-terra', tools: [WEATHER], messages: [{ role: 'user', content: 'weer' }, { role: 'assistant', content: '', toolCalls: r.toolCalls, raw: r.raw }, { role: 'tool', toolCallId: 'call_9', content: 'zon' }] }), sig(), noop);
    const input = srv.seen[1].body.input;
    assert.equal(input[1].type, 'reasoning');
    assert.equal(input[1].encrypted_content, 'ENC123', 'encrypted reasoning goes back so the model keeps its train of thought');
    assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'call_9', output: 'zon' });
    await assert.rejects(a.chat!(req({ model: 'gpt-6.1-terra' }), sig(), noop), (e: any) => e.category === 'overloaded' && classifyEngineError(e) === 'outage');
    const plain = await a.chat!(req({ model: 'gpt-4.1', reasoning: 'low' }), sig(), noop);
    assert.equal(plain.text, 'ok');
    assert.equal(srv.seen.at(-1)!.body.reasoning, undefined, 'a model without reasoning is retried without the parameter');
  } finally {
    await srv.close();
  }
  // An OpenAI-compatible proxy without /responses: the same provider falls back to Chat Completions.
  const proxy = await serve([{ path: '/v1/responses', status: 404, body: { error: { message: 'Not Found' } } }, { path: '/v1/chat/completions', repeat: true, sse: [{ choices: [{ index: 0, delta: { content: 'via chat' }, finish_reason: 'stop' }] }, '[DONE]'] }]);
  try {
    const a = kinds.get('openai')!.create(cfgFor('openai', { base_url: proxy.url + '/v1' }), 'sk', {} as any);
    assert.equal((await a.chat!(req({ model: 'x' }), sig(), noop)).text, 'via chat');
    assert.equal((await a.chat!(req({ model: 'x' }), sig(), noop)).text, 'via chat');
    assert.equal(proxy.seen.filter((s) => s.path === '/v1/responses').length, 1, 'remembered: no second /responses attempt');
  } finally {
    await proxy.close();
  }
  // Input conversion for history from another engine.
  const inp = toResponsesInput([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b', toolCalls: [{ id: 'c1', name: 'f', args: { x: 1 } }] }, { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'zie' }, { type: 'image', mime: 'image/png', data: 'AAA' }] }]);
  assert.deepEqual(inp, [
    { role: 'user', content: [{ type: 'input_text', text: 'a' }] },
    { role: 'assistant', content: 'b' },
    { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"x":1}' },
    { type: 'function_call_output', call_id: 'c1', output: 'zie\n[afbeelding: zie hieronder]' },
    { role: 'user', content: [{ type: 'input_text', text: '[Afbeelding uit de tool-resultaten hierboven]' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] },
  ]);
});

test('OpenAI (recorded): a wrong key gives "Sleutel ongeldig" with the key page in the fix hint', async () => {
  const srv = await serve(replay('openai-error-auth'));
  try {
    const t = await kinds.get('openai')!.create(cfgFor('openai', { base_url: srv.url + '/v1' }), 'sk-bad', {} as any).test();
    assert.equal(t.ok, false);
    assert.equal(t.category, 'auth');
    assert.match(t.hint!, /platform\.openai\.com\/api-keys/);
    assert.equal(srv.seen[0].headers.authorization, 'Bearer sk-bad');
  } finally {
    await srv.close();
  }
});

test('key check counts models in whole texts: "1 model beschikbaar", "2 modellen beschikbaar" (acceptance round 4)', async () => {
  assert.equal(modelsAvailable(1), '1 model beschikbaar');
  assert.equal(modelsAvailable(47), '47 modellen beschikbaar');
  assert.equal(modelsAvailable(1, 'Claude-modellen'), '1 Claude-model beschikbaar');
  assert.equal(modelsAvailable(9, 'Claude-modellen'), '9 Claude-modellen beschikbaar');
  for (const [ids, want] of [[['gpt-x'], 'Sleutel werkt — 1 model beschikbaar'], [['gpt-x', 'gpt-y'], 'Sleutel werkt — 2 modellen beschikbaar']] as const) {
    const srv = await serve([{ method: 'GET', path: /\/models$/, body: { data: ids.map((id) => ({ id })) }, repeat: true }]);
    try {
      const t = await kinds.get('openai')!.create(cfgFor('openai', { base_url: srv.url + '/v1' }), 'sk-test', {} as any).test();
      assert.equal(t.ok, true);
      assert.equal(t.detail, want);
    } finally {
      await srv.close();
    }
  }
});

test('a wrong key is never hidden behind the built-in model list (Gemini, xAI, Groq, ... answered "Sleutel werkt")', async () => {
  // Answers as seen live on 2026-11-07 with a made-up key (acceptance round 3, C-01).
  const cases: [string, number, object][] = [
    ['google', 400, [{ error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } }]],
    ['xai', 400, { code: 'Client specified an invalid argument', error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' }],
    ['groq', 401, { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } }],
    ['mistral', 401, { message: 'Invalid API Key', request_id: 'x' }],
  ];
  for (const [kind, status, body] of cases) {
    const srv = await serve([{ method: 'GET', path: /\/models$/, status, body, repeat: true }]);
    try {
      const a = kinds.get(kind)!.create(cfgFor(kind, { base_url: srv.url + '/v1' }), 'nep-sleutel', {} as any);
      const t = await a.test();
      assert.equal(t.ok, false, `${kind}: a wrong key fails the check`);
      assert.equal(t.category, 'auth', `${kind}: ${t.detail}`);
      assert.match(t.detail, /Sleutel ongeldig/);
      await assert.rejects(a.listModels(), /Sleutel ongeldig/, `${kind}: the model picker shows the key error, not the built-in list`);
    } finally {
      await srv.close();
    }
  }
  // No list at this address (404) but the key was not refused: the built-in list, and honestly "not checked yet".
  const srv = await serve([{ method: 'GET', path: /\/models$/, status: 404, body: { error: { message: 'Not Found' } }, repeat: true }]);
  try {
    const a = kinds.get('xai')!.create(cfgFor('xai', { base_url: srv.url + '/v1' }), 'xai-echt', {} as any);
    const t = await a.test();
    assert.equal(t.ok, true);
    assert.equal(t.verified, false);
    assert.match(t.detail, /pas bij het eerste bericht gecontroleerd/);
    assert.doesNotMatch(t.detail, /Sleutel werkt/);
    assert.ok((await a.listModels()).length > 0, 'picker still offers the built-in models');
  } finally {
    await srv.close();
  }
  // NVIDIA's list answers without a key: the check says so instead of "Sleutel werkt".
  const nv = await serve([{ method: 'GET', path: /\/models$/, body: { data: [{ id: 'meta/llama-3.1-8b-instruct' }] }, repeat: true }]);
  try {
    const t = await kinds.get('nvidia')!.create(cfgFor('nvidia', { base_url: nv.url + '/v1' }), 'nvapi-nep', {} as any).test();
    assert.equal(t.ok, true);
    assert.equal(t.verified, false);
    assert.doesNotMatch(t.detail, /Sleutel werkt/);
  } finally {
    await nv.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// DeepSeek (recorded): free balance check catches "no credit"; V4 models; reasoning_content replay on every tool turn.

test('DeepSeek (recorded): free balance check reports "Geen tegoed", wrong key "Sleutel ongeldig"', async () => {
  const srv = await serve([...replay('deepseek-models'), ...replay('deepseek-error-auth')]);
  try {
    const k = kinds.get('deepseek')!;
    const a = k.create(cfgFor('deepseek', { base_url: srv.url }), 'sk-x', {} as any);
    const t = await a.test();
    assert.equal(t.ok, false);
    assert.equal(t.category, 'quota');
    assert.equal(t.verified, true, 'the key works, the account has no credit');
    assert.match(t.detail, /Geen tegoed/);
    assert.match(t.hint!, /top_up/);
    const models = await a.listModels();
    assert.deepEqual(models.map((m) => m.id).sort(), ['deepseek-flash', 'deepseek-v4-pro']);
    assert.equal(pickDefault(models, k.recommend), 'deepseek-flash');
    const bad = await a.test();
    assert.equal(bad.category, 'auth');
  } finally {
    await srv.close();
  }
});

test('DeepSeek dialect: reasoning_content goes back on every earlier tool turn; effort levels low/high/max', async () => {
  const srv = await serve([{ path: '/chat/completions', repeat: true, sse: [{ choices: [{ index: 0, delta: { reasoning_content: 'denk' } }] }, { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'] }]);
  try {
    const a = kinds.get('deepseek')!.create(cfgFor('deepseek', { base_url: srv.url }), 'k', {} as any);
    const raw = { provider: 'oa:deepseek', data: { reasoning_content: 'eerder gedacht' } };
    const msgs: any[] = [
      { role: 'user', content: 'vraag 1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', args: { city: 'A' } }], raw },
      { role: 'tool', toolCallId: 'c1', content: 'zon' },
      { role: 'assistant', content: 'klaar' },
      { role: 'user', content: 'vraag 2' },
    ];
    await a.chat!(req({ model: 'deepseek-flash', messages: msgs, reasoning: 'xhigh' }), sig(), noop);
    const body = srv.seen[0].body;
    assert.equal(body.messages[2].reasoning_content, 'eerder gedacht', 'earlier tool turn keeps its reasoning (DeepSeek returns 400 otherwise)');
    assert.equal(body.reasoning_effort, 'max');
    await a.chat!(req({ model: 'deepseek-flash', reasoning: 'none' }), sig(), noop);
    assert.deepEqual(srv.seen[1].body.thinking, { type: 'disabled' });
    // Another provider never receives DeepSeek's extras.
    const other = toOpenAIMessages('', msgs, { kind: 'openai', replayReasoning: false });
    assert.equal(other[1].reasoning_content, undefined);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Ollama (recorded live with Qwen3.6 35B-A3B): reasoning field, tool calls, tool results.

test('Ollama (recorded): reasoning field, text, tool calls and the answer after tool results', async () => {
  const srv = await serve([...replay('ollama-text'), ...replay('ollama-tools'), ...replay('ollama-toolresult')]);
  try {
    const a = kinds.get('ollama')!.create(cfgFor('ollama', { base_url: srv.url + '/v1' }), null, {} as any);
    const model = recorded('ollama-text').entries[0].request.model;
    const deltas: string[] = [];
    const t = await a.chat!(req({ model, messages: [{ role: 'user', content: 'Zeg alleen het woord: hallo' }], maxTokens: 2000 }), sig(), (e) => e.type === 'reasoning' && deltas.push(e.delta));
    assert.match(t.text, /hallo/i);
    assert.ok(t.reasoning && t.reasoning.length > 50, 'thinking arrives separately from the answer');
    assert.equal(deltas.join(''), t.reasoning);
    assert.ok(!/<think>/.test(t.text));
    // Before it chats, the adapter asks Ollama which context window the model runs with (/api/ps, /api/show; B-18).
    const chat = srv.seen.find((s) => s.path === '/v1/chat/completions')!;
    assert.equal(chat.body.max_tokens, 2000, 'local servers get max_tokens');
    assert.equal(chat.body.reasoning_effort, undefined, 'no reasoning parameter for local servers');
    const tc = await a.chat!(req({ model, messages: [{ role: 'user', content: 'weer' }], tools: [WEATHER] }), sig(), noop);
    assert.deepEqual(tc.toolCalls.map((c) => c.args.city), ['Amsterdam', 'Utrecht']);
    const back = await a.chat!(req({ model, tools: [WEATHER], messages: [{ role: 'user', content: 'weer' }, { role: 'assistant', content: '', toolCalls: tc.toolCalls }, ...tc.toolCalls.map((c) => ({ role: 'tool' as const, toolCallId: c.id, content: 'Zonnig, 21 graden.' }))] }), sig(), noop);
    assert.match(back.text, /21/);
    assert.equal(estimateCost('ollama', model, 1e6, 1e6), 0, 'local is free');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// OpenRouter (docs: openrouter.ai/docs — models, limits, reasoning, usage accounting, streaming errors)

test('OpenRouter (docs): paginated model list with live prices, free models, /key credit check, reasoning_details, cost, mid-stream error', async () => {
  clearListPrices();
  const srv = await serve([
    { path: '/api/v1/models', body: { data: [{ id: 'openai/gpt-oss-120b:free', name: 'gpt-oss-120b (free)', context_length: 131072, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'] }, { id: 'black-forest-labs/flux', architecture: { output_modalities: ['image'] }, pricing: { prompt: '0.00001', completion: '0' } }], links: { next: '/api/v1/models?page=2' } } },
    { path: '/api/v1/models', body: { data: [{ id: 'anthropic/claude-sonnet-5.5', context_length: 1000000, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['tools'] }] } },
    { path: '/api/v1/key', body: { data: { limit: null, limit_remaining: null, usage: 0, is_free_tier: true, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } } },
    { path: '/api/v1/models', body: { data: [] } },
    {
      path: '/api/v1/chat/completions',
      sse: [
        ': OPENROUTER PROCESSING',
        { model: 'anthropic/claude-sonnet-5.5', choices: [{ index: 0, delta: { reasoning: 'Even ', reasoning_details: [{ type: 'reasoning.text', text: 'Even ', index: 0 }] } }] },
        { choices: [{ index: 0, delta: { reasoning: 'denken', reasoning_details: [{ type: 'reasoning.text', text: 'denken', index: 0, signature: 'sig-1' }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Gouda"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 12 }, cost: 0.00042 } },
        '[DONE]',
      ],
    },
    { path: '/api/v1/chat/completions', sse: [{ choices: [{ index: 0, delta: { content: 'Hal' } }] }, { error: { code: 502, message: 'Provider returned error' }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] }] },
  ]);
  try {
    const k = kinds.get('openrouter')!;
    const a = k.create(cfgFor('openrouter', { base_url: srv.url + '/api/v1' }), 'sk-or-v1-x', {} as any);
    const models = await a.listModels();
    assert.deepEqual(models.map((m) => m.id), ['anthropic/claude-sonnet-5.5', 'openai/gpt-oss-120b:free'], 'second page followed, image-only model hidden');
    assert.deepEqual(models[0].price, [2, 10], 'USD per token → per 1M');
    assert.equal(models[1].free, true);
    assert.equal(pickDefault(models, k.recommend), 'openai/gpt-oss-120b:free');
    assert.equal(estimateCost('openrouter', 'anthropic/claude-sonnet-5.5', 1_000_000, 100_000), 2 + 1, 'live list price used for the budget');
    assert.equal(priceInfo('openrouter', 'anthropic/claude-sonnet-5.5')!.source, 'lijst');
    const t = await a.test();
    assert.equal(t.ok, true);
    assert.equal(t.verified, true);
    assert.match(t.credit!, /nog 47 van 50 gratis verzoeken/);
    const r = await a.chat!(req({ model: 'anthropic/claude-sonnet-5.5', tools: [WEATHER], reasoning: 'high' }), sig(), noop);
    assert.equal(r.reasoning, 'Even denken');
    assert.deepEqual(r.toolCalls[0].args, { city: 'Gouda' });
    assert.equal(r.usage.cacheRead, 40);
    assert.equal((r.usage as any).cost, 0.00042);
    assert.deepEqual(srv.seen.find((s) => s.path === '/api/v1/chat/completions')!.body.reasoning, { effort: 'high' }, 'OpenRouter reasoning parameter');
    assert.equal(srv.seen.find((s) => s.path === '/api/v1/chat/completions')!.headers['x-title'], 'TeamBot');
    // reasoning_details go back whole (signature kept) on the next request to OpenRouter only.
    const msgs = toOpenAIMessages('', [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: r.toolCalls, raw: r.raw }], { kind: 'openrouter' });
    assert.deepEqual(msgs[1].reasoning_details, [{ type: 'reasoning.text', text: 'Even denken', index: 0, signature: 'sig-1' }]);
    assert.equal(toOpenAIMessages('', [{ role: 'assistant', content: '', toolCalls: r.toolCalls, raw: r.raw }], { kind: 'groq' })[0].reasoning_details, undefined);
    await assert.rejects(a.chat!(req({ model: 'x' }), sig(), noop), (e: any) => e.category === 'overloaded' && classifyEngineError(e) === 'outage');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Gemini (docs: aistudio.google.com/docs/openai — thought signatures in extra_content, array error bodies)

test('Gemini (docs): thought signatures are kept and replayed; calls from another engine get the documented placeholder', async () => {
  const srv = await serve([
    { path: '/chat/completions', sse: [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'g1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Delft"}' }, extra_content: { google: { thought_signature: 'SIG-A' } } }, { index: 1, id: 'g2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Leiden"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]'] },
    { path: '/chat/completions', repeat: true, sse: [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'] },
  ]);
  try {
    const a = kinds.get('google')!.create(cfgFor('google', { base_url: srv.url }), 'AIza-x', {} as any);
    const r = await a.chat!(req({ model: 'gemini-3.8-flash', tools: [WEATHER] }), sig(), noop);
    assert.equal(r.toolCalls.length, 2);
    assert.deepEqual(r.raw, { provider: 'oa:google', data: { toolExtras: { g1: { google: { thought_signature: 'SIG-A' } } } } });
    await a.chat!(req({ model: 'gemini-3.8-flash', tools: [WEATHER], messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: r.toolCalls, raw: r.raw }, ...r.toolCalls.map((c) => ({ role: 'tool' as const, toolCallId: c.id, content: 'zon' }))] }), sig(), noop);
    const sent = srv.seen[1].body.messages.find((m: any) => m.tool_calls);
    assert.deepEqual(sent.tool_calls[0].extra_content, { google: { thought_signature: 'SIG-A' } });
    assert.equal(sent.tool_calls[1].extra_content, undefined, 'only the first call of a parallel set carries a signature');
    // History from another engine (e.g. after a reserve switch): placeholder on the first call, Gemini 3+ only.
    await a.chat!(req({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [{ id: 'o1', name: 'get_weather', args: {} }] }, { role: 'tool', toolCallId: 'o1', content: 'zon' }] }), sig(), noop);
    assert.deepEqual(srv.seen[2].body.messages[2].tool_calls[0].extra_content, { google: { thought_signature: 'skip_thought_signature_validator' } });
    await a.chat!(req({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [{ id: 'o1', name: 'get_weather', args: {} }] }, { role: 'tool', toolCallId: 'o1', content: 'zon' }] }), sig(), noop);
    assert.equal(srv.seen[3].body.messages[2].tool_calls[0].extra_content, undefined);
    assert.equal(srv.seen[0].body.max_tokens, undefined);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Other OpenAI-compatible dialects (docs per provider)

test('dialects: Mistral thinking chunks, <think> tags across chunks, Groq/vLLM "reasoning", xAI cost ticks, MiniMax extras', async () => {
  const srv = await serve([
    // Mistral (docs.mistral.ai/studio/conversations/reasoning): content is a list with a thinking chunk first.
    { path: '/mistral/chat/completions', sse: [{ choices: [{ index: 0, delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Eerst denken.' }] }] } }] }, { choices: [{ index: 0, delta: { content: 'Antwoord' }, finish_reason: 'stop' }] }, '[DONE]'] },
    // MiniMax / Perplexity / R1 distills: <think> inside content, split over chunks.
    { path: '/think/chat/completions', sse: ['<th', 'ink>Stap 1. ', 'Stap 2.</thi', 'nk>\n\nKlaar.'].map((c) => ({ choices: [{ index: 0, delta: { content: c } }] })).concat(['[DONE]'] as any) },
    // vLLM ("reasoning", renamed from reasoning_content) and Groq parsed reasoning.
    { path: '/vllm/chat/completions', sse: [{ choices: [{ index: 0, delta: { reasoning: 'hmm' } }] }, { choices: [{ index: 0, delta: { content: 'ja' }, finish_reason: 'stop' }] }, '[DONE]'] },
    // xAI: cost in usd ticks (10^10 ticks = $1).
    { path: '/xai/chat/completions', sse: [{ choices: [{ index: 0, delta: { content: 'yo' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cost_in_usd_ticks: 25_000_000 } }, '[DONE]'] },
    // MiniMax: HTTP 200 with base_resp error inside the stream.
    { path: '/minimax/chat/completions', sse: [{ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }] },
    // A server that ignores stream:true.
    { path: '/plain/chat/completions', body: { choices: [{ index: 0, message: { role: 'assistant', content: 'in één keer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3 } } },
  ]);
  try {
    const mk = (kind: string, p: string) => kinds.get(kind)!.create(cfgFor(kind, { base_url: srv.url + p }), 'k', {} as any);
    const m = await mk('mistral', '/mistral').chat!(req({ model: 'mistral-small-2603' }), sig(), noop);
    assert.equal(m.reasoning, 'Eerst denken.');
    assert.equal(m.text, 'Antwoord');
    const th = await mk('openai-compatible', '/think').chat!(req(), sig(), noop);
    assert.equal(th.reasoning, 'Stap 1. Stap 2.');
    assert.equal(th.text, 'Klaar.');
    const v = await mk('vllm', '/vllm').chat!(req(), sig(), noop);
    assert.equal(v.reasoning, 'hmm');
    const x = await mk('xai', '/xai').chat!(req({ model: 'grok-4.7', reasoning: 'high' }), sig(), noop);
    assert.equal((x.usage as any).cost, 0.0025);
    assert.equal(srv.seen.find((s) => s.path.startsWith('/xai'))!.body.reasoning_effort, 'high', 'Grok 4.5+ takes reasoning_effort');
    await assert.rejects(mk('minimax', '/minimax').chat!(req({ model: 'MiniMax-M3.1-Flash' }), sig(), noop), (e: any) => e.category === 'quota');
    assert.equal(srv.seen.find((s) => s.path.startsWith('/minimax'))!.body.reasoning_split, true, 'MiniMax needs reasoning_split');
    const p = await mk('openai-compatible', '/plain').chat!(req(), sig(), noop);
    assert.equal(p.text, 'in één keer');
  } finally {
    await srv.close();
  }
  // <think> splitting with a lone "<" that is not a tag.
  let out = '';
  const s = new ThinkSplitter((k, t) => (out += `${k}:${t}|`));
  s.push('<');
  s.push('3 is kleiner dan 4');
  s.end();
  assert.equal(out, 'text:<3 is kleiner dan 4|');
});

test('dialects: token-limit parameter retry, a model without tools, and old Grok without reasoning_effort', async () => {
  clearModelQuirks();
  const srv = await serve([
    { path: '/a/chat/completions', status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } },
    { path: '/a/chat/completions', sse: [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'] },
    { path: '/b/chat/completions', status: 400, body: { error: { message: 'registry.ollama.ai/library/gemma:2b does not support tools' } } },
    { path: '/b/chat/completions', sse: [{ choices: [{ index: 0, delta: { content: 'zonder tools' }, finish_reason: 'stop' }] }, '[DONE]'] },
    { path: '/c/chat/completions', sse: [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'] },
  ]);
  try {
    const a = kinds.get('openai-compatible')!.create(cfgFor('openai-compatible', { base_url: srv.url + '/a' }), null, {} as any);
    await a.chat!(req({ maxTokens: 50 }), sig(), noop);
    assert.equal(srv.seen[1].body.max_completion_tokens, 50);
    assert.equal(srv.seen[1].body.max_tokens, undefined);
    const b = kinds.get('openai-compatible')!.create(cfgFor('openai-compatible', { base_url: srv.url + '/b' }), null, {} as any);
    const r = await b.chat!(req({ tools: [WEATHER] }), sig(), noop);
    assert.equal(r.text, 'zonder tools');
    assert.match(r.notice!, /ondersteunt geen tools/);
    const c = kinds.get('xai')!.create(cfgFor('xai', { base_url: srv.url + '/c' }), 'k', {} as any);
    await c.chat!(req({ model: 'grok-4.20-0309-reasoning', reasoning: 'high' }), sig(), noop);
    assert.equal(srv.seen.at(-1)!.body.reasoning_effort, undefined, 'older Grok 4 rejects reasoning_effort');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Anthropic (SDK against the fixture server; stream per platform.claude.com/docs/en/build-with-claude/streaming)

const ANTHROPIC_STREAM = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Twee steden, twee aanroepen.' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Ik kijk het na.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city": "Amst' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'erdam"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 2 }],
  ['content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"city": "Utrecht"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 3 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 80 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}`);

test('Anthropic (docs): thinking, text, parallel tool use, cache usage, image in; models list; errors per type', async () => {
  const err = (status: number, type: string, message: string, headers: Record<string, string> = {}) => ({ path: '/v1/messages', status, headers, body: { type: 'error', error: { type, message } } });
  const srv = await serve([
    { path: '/v1/messages', sse: ANTHROPIC_STREAM },
    { path: '/v1/models', body: { data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1000000, capabilities: { image_input: true } }], has_more: false, first_id: 'a', last_id: 'a' } },
    err(401, 'authentication_error', 'invalid x-api-key'),
    err(402, 'billing_error', 'Your credit balance is too low to access the Anthropic API.'),
    err(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit.', { 'retry-after': '20' }),
    err(529, 'overloaded_error', 'Overloaded'),
    err(400, 'invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum'),
    err(404, 'not_found_error', 'model: claude-bestaat-niet'),
    { path: '/v1/models', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
  ]);
  try {
    const a = anthropicAdapter({ key: 'sk-ant-x', baseUrl: srv.url, maxRetries: 0, keyUrl: 'https://platform.claude.com/settings/keys' });
    const ev: string[] = [];
    const r = await a.chat!(req({ model: 'claude-sonnet-5-5', tools: [WEATHER], reasoning: 'high', messages: [{ role: 'user', content: [{ type: 'text', text: 'weer?' }, { type: 'image', mime: 'image/png', data: 'iVBOR' }] }] }), sig(), (e) => ev.push(e.type));
    assert.equal(r.reasoning, 'Twee steden, twee aanroepen.');
    assert.equal(r.text, 'Ik kijk het na.');
    assert.deepEqual(r.toolCalls.map((c) => c.args.city), ['Amsterdam', 'Utrecht']);
    assert.equal(r.stop, 'tool_use');
    assert.deepEqual(r.usage, { input: 1120, output: 80, cacheRead: 1000 });
    assert.ok(ev.includes('reasoning') && ev.includes('text') && ev.filter((x) => x === 'tool_start').length === 2);
    const body = srv.seen[0].body;
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.equal(body.messages[0].content[1].type, 'image');
    assert.equal(body.tools[0].eager_input_streaming, true);
    assert.match(String(srv.seen[0].headers['x-api-key'] || srv.seen[0].headers.authorization), /sk-ant-x/);
    // Thinking blocks (with signature) are replayed unchanged on the next turn.
    assert.equal(r.raw!.data[0].signature, 'sig123');
    const models = await a.listModels();
    assert.equal(models[0].context, 1000000);
    const expect = [
      ['auth', 'auth'],
      ['quota', 'limit'],
      ['rate_limit', 'limit'],
      ['overloaded', 'outage'],
      ['context', 'other'],
      ['model', 'unavailable'],
    ];
    for (const [cat, kind] of expect) {
      await assert.rejects(a.chat!(req({ model: 'claude-sonnet-5-5' }), sig(), noop), (e: any) => {
        assert.equal(e.category, cat, e.message);
        assert.equal(classifyEngineError(e), kind);
        if (cat === 'rate_limit') assert.equal(e.retryAfter, 20);
        return true;
      });
    }
    const t = await a.test();
    assert.equal(t.ok, false);
    assert.equal(t.category, 'auth');
    assert.match(t.hint!, /platform\.claude\.com\/settings\/keys/);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Amazon Bedrock (Converse API, event-stream; SigV4 per the AWS test suite)

test('SigV4 matches the published AWS examples; Bedrock secrets are parsed as API key or IAM keys', () => {
  const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  const now = new Date('2015-08-30T12:36:00Z');
  const h = signV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {} }, creds, 'us-east-1', 'service', now);
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  const iam = signV4({ method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } }, creds, 'us-east-1', 'iam', now);
  assert.match(iam.authorization, /Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7$/);
  assert.deepEqual(parseBedrockSecret('ABSKQmVkcm9ja0FQSUtleS1leGFtcGxl'), { bearer: 'ABSKQmVkcm9ja0FQSUtleS1leGFtcGxl' });
  assert.deepEqual(parseBedrockSecret('AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), { creds: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', sessionToken: undefined } });
});

const ev = (type: string, payload: any) => encodeEventStream({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, JSON.stringify(payload));

test('Bedrock (docs): ConverseStream text, reasoning, parallel tool use and usage; exceptions mid-stream; model list; Bearer and SigV4', async () => {
  const stream = Buffer.concat([
    ev('messageStart', { role: 'assistant' }),
    ev('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'Twee steden.' } } }),
    ev('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig-b' } } }),
    ev('contentBlockStop', { contentBlockIndex: 0 }),
    ev('contentBlockDelta', { contentBlockIndex: 1, delta: { text: 'Ik kijk.' } }),
    ev('contentBlockStart', { contentBlockIndex: 2, start: { toolUse: { toolUseId: 't1', name: 'get_weather' } } }),
    ev('contentBlockDelta', { contentBlockIndex: 2, delta: { toolUse: { input: '{"city":"Ams' } } }),
    ev('contentBlockDelta', { contentBlockIndex: 2, delta: { toolUse: { input: 'terdam"}' } } }),
    ev('contentBlockStart', { contentBlockIndex: 3, start: { toolUse: { toolUseId: 't2', name: 'get_weather' } } }),
    ev('contentBlockDelta', { contentBlockIndex: 3, delta: { toolUse: { input: '{"city":"Utrecht"}' } } }),
    ev('messageStop', { stopReason: 'tool_use' }),
    ev('metadata', { usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70, cacheReadInputTokens: 10 }, metrics: { latencyMs: 100 } }),
  ]);
  // The decoder handles frames split at any byte.
  const dec = new EventStreamDecoder();
  const frames = [...dec.push(stream.subarray(0, 7)), ...dec.push(stream.subarray(7, 300)), ...dec.push(stream.subarray(300))];
  assert.equal(frames.length, 12);
  const exc = encodeEventStream({ ':message-type': 'exception', ':exception-type': 'throttlingException', ':content-type': 'application/json' }, JSON.stringify({ message: 'Too many tokens, please wait.' }));
  const srv = await serve([
    { method: 'POST', path: /^\/model\/.+\/converse-stream$/, raw: stream },
    { method: 'POST', path: /^\/model\/.+\/converse-stream$/, raw: Buffer.concat([ev('messageStart', { role: 'assistant' }), exc]) },
    { path: '/foundation-models', body: { modelSummaries: [{ modelId: 'anthropic.claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5', providerName: 'Anthropic', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], inferenceTypesSupported: ['INFERENCE_PROFILE'], responseStreamingSupported: true, modelLifecycle: { status: 'ACTIVE' } }, { modelId: 'amazon.nova-pro-v1:0', modelName: 'Nova Pro', providerName: 'Amazon', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], inferenceTypesSupported: ['ON_DEMAND'], responseStreamingSupported: true, modelLifecycle: { status: 'ACTIVE' } }, { modelId: 'amazon.titan-embed-text-v2:0', inferenceTypesSupported: ['ON_DEMAND'], outputModalities: ['EMBEDDING'] }] } },
    { path: '/inference-profiles', body: { inferenceProfileSummaries: [{ inferenceProfileId: 'eu.anthropic.claude-sonnet-5-5', inferenceProfileName: 'EU Claude Sonnet 5.5', status: 'ACTIVE', models: [{ modelArn: 'arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-sonnet-5-5' }] }] } },
    { method: 'POST', path: /converse-stream$/, status: 403, headers: { 'x-amzn-errortype': 'UnrecognizedClientException:http://internal.amazon.com/coral/' }, body: { message: 'The security token included in the request is invalid.' } },
  ]);
  try {
    const a = bedrockAdapter({ label: 'Bedrock', region: 'eu-central-1', secret: 'ABSK-test-key', runtimeUrl: srv.url, controlUrl: srv.url });
    const r = await a.chat!(req({ model: 'eu.anthropic.claude-sonnet-5-5:0', tools: [WEATHER], messages: [{ role: 'user', content: [{ type: 'text', text: 'weer' }, { type: 'image', mime: 'image/png', data: 'iVBOR' }] }] }), sig(), noop);
    assert.equal(r.text, 'Ik kijk.');
    assert.equal(r.reasoning, 'Twee steden.');
    assert.deepEqual(r.toolCalls.map((c) => [c.id, c.args.city]), [['t1', 'Amsterdam'], ['t2', 'Utrecht']]);
    assert.deepEqual(r.usage, { input: 60, output: 20, cacheRead: 10 });
    assert.equal(r.stop, 'tool_use');
    assert.deepEqual(r.raw, { provider: 'bedrock', data: { reasoning: [{ reasoningContent: { reasoningText: { text: 'Twee steden.', signature: 'sig-b' } } }] } });
    const s0 = srv.seen[0];
    assert.equal(s0.path, '/model/eu.anthropic.claude-sonnet-5-5%3A0/converse-stream', 'model id encoded in the path');
    assert.equal(s0.headers.authorization, 'Bearer ABSK-test-key');
    assert.deepEqual(s0.body.toolConfig.tools[0].toolSpec.inputSchema.json, WEATHER.parameters);
    assert.deepEqual(s0.body.messages[0].content[1], { image: { format: 'png', source: { bytes: 'iVBOR' } } });
    await assert.rejects(a.chat!(req({ model: 'x' }), sig(), noop), (e: any) => e.category === 'rate_limit' && classifyEngineError(e) === 'limit');
    const models = await a.listModels();
    assert.deepEqual(models.map((m) => m.id), ['amazon.nova-pro-v1:0', 'eu.anthropic.claude-sonnet-5-5'], 'profile-only models via their inference profile; embeddings hidden');
    // Tool result turn goes back as Converse toolResult blocks with the reasoning replayed first.
    const sigv4 = bedrockAdapter({ label: 'Bedrock', region: 'eu-central-1', secret: 'AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', runtimeUrl: srv.url, controlUrl: srv.url });
    await assert.rejects(sigv4.chat!(req({ model: 'm', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: r.toolCalls, raw: r.raw }, { role: 'tool', toolCallId: 't1', content: 'zon', isError: true }] }), sig(), noop), (e: any) => e.category === 'auth');
    const last = srv.seen.at(-1)!;
    assert.match(String(last.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-central-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.deepEqual(last.body.messages[1].content[0], { reasoningContent: { reasoningText: { text: 'Twee steden.', signature: 'sig-b' } } });
    assert.deepEqual(last.body.messages[2].content[0], { toolResult: { toolUseId: 't1', content: [{ text: 'zon' }], status: 'error' } });
  } finally {
    await srv.close();
  }
  assert.throws(() => bedrockAdapter({ label: 'B', region: 'mars-1', secret: 'x' }), /ongeldige regio/);
});

// ---------------------------------------------------------------------------------------------------------------
// Vertex AI (service account → OAuth token, OpenAI-compatible endpoint), Azure, Cloudflare

test('Vertex AI: service-account JWT is signed correctly, the token is cached and used as Bearer on the openapi endpoint', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const sa = JSON.stringify({ type: 'service_account', project_id: 'mijn-project', client_email: 'bot@mijn-project.iam.gserviceaccount.com', private_key: privateKey });
  const jwt = serviceAccountJwt(JSON.parse(sa), 1_800_000_000);
  const [h, c, s] = jwt.split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')));
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: 'bot@mijn-project.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: 1_800_000_000, exp: 1_800_003_600 });
  const srv = await serve([
    { method: 'POST', path: '/token', body: { access_token: 'ya29.test', expires_in: 3599, token_type: 'Bearer' } },
    { path: /chat\/completions$/, repeat: true, sse: [{ choices: [{ index: 0, delta: { content: 'hoi' }, finish_reason: 'stop' }] }, '[DONE]'] },
  ]);
  try {
    const token = vertexTokenSource(sa, { tokenUrl: srv.url + '/token' });
    const a = openaiCompat({ kind: 'vertex', label: 'Vertex', baseUrl: srv.url + '/v1/projects/mijn-project/locations/global/endpoints/openapi', key: token });
    await a.chat!(req({ model: 'google/gemini-3.5-flash' }), sig(), noop);
    await a.chat!(req({ model: 'google/gemini-3.5-flash' }), sig(), noop);
    assert.equal(srv.seen.filter((x) => x.path === '/token').length, 1, 'token cached');
    assert.match(String(srv.seen[0].body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
    assert.equal(srv.seen[1].headers.authorization, 'Bearer ya29.test');
    assert.equal(srv.seen[1].path, '/v1/projects/mijn-project/locations/global/endpoints/openapi/chat/completions');
  } finally {
    await srv.close();
  }
  assert.equal(vertexBase('p-1', 'global'), 'https://aiplatform.googleapis.com/v1/projects/p-1/locations/global/endpoints/openapi');
  assert.equal(vertexBase('p-1', 'europe-west4'), 'https://europe-west4-aiplatform.googleapis.com/v1/projects/p-1/locations/europe-west4/endpoints/openapi');
  const noProject = await kinds.get('vertex')!.create(cfgFor('vertex'), 'ya29.raw-token', {} as any).test();
  assert.equal(noProject.ok, false);
  assert.match(noProject.detail, /Project-ID/);
  assert.equal((await kinds.get('vertex')!.create(cfgFor('vertex'), '{"type":"service_account"}', {} as any).test()).ok, false, 'broken key file explained');
});

test('Azure OpenAI v1 and Cloudflare Workers AI: address building, api-key header, model list with prices', async () => {
  assert.equal(azureBase('https://mijn.openai.azure.com/'), 'https://mijn.openai.azure.com/openai/v1');
  assert.equal(azureBase('https://mijn.services.ai.azure.com/openai'), 'https://mijn.services.ai.azure.com/openai/v1');
  assert.equal(azureBase('https://mijn.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21'), 'https://mijn.openai.azure.com/openai/v1');
  const acct = 'a'.repeat(32);
  const srv = await serve([
    { path: '/openai/v1/chat/completions', sse: [{ choices: [{ index: 0, delta: { content: 'azure' }, finish_reason: 'stop' }] }, '[DONE]'] },
    { path: `/client/v4/accounts/${acct}/ai/models/search`, body: { success: true, result: [{ name: '@cf/openai/gpt-oss-120b', task: { name: 'Text Generation' }, properties: [{ property_id: 'context_window', value: '128000' }, { property_id: 'function_calling', value: 'true' }, { property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.35, currency: 'USD' }, { unit: 'per M output tokens', price: 0.75, currency: 'USD' }] }] }] } },
  ]);
  try {
    const az = kinds.get('azure')!.create(cfgFor('azure', { base_url: srv.url }), 'az-key', {} as any);
    const r = await az.chat!(req({ model: 'mijn-deployment', maxTokens: 10 }), sig(), noop);
    assert.equal(r.text, 'azure');
    assert.equal(srv.seen[0].headers['api-key'], 'az-key');
    assert.equal(srv.seen[0].headers.authorization, undefined);
    assert.equal(srv.seen[0].body.max_completion_tokens, 10);
    const cfDef = PROVIDERS.find((p) => p.id === 'cloudflare')!;
    const models = await cfDef.listModels!({ base: `${srv.url}/client/v4/accounts/${acct}/ai/v1`, headers: async () => ({}) });
    assert.deepEqual(models[0], { id: '@cf/openai/gpt-oss-120b', context: 128000, tools: true, price: [0.35, 0.75] });
  } finally {
    await srv.close();
  }
  const cf = await kinds.get('cloudflare')!.create(cfgFor('cloudflare'), 'tok', {} as any).test();
  assert.equal(cf.ok, false);
  assert.match(cf.detail, /Account-ID/);
});

// ---------------------------------------------------------------------------------------------------------------
// Local servers: each fingerprint only matches its own server (several share a port).

test('local servers are told apart by their fingerprints (llama.cpp vs LocalAI on 8080, vLLM vs Lemonade, ...)', async () => {
  const servers: Record<string, Route[]> = {
    ollama: [{ path: '/api/version', body: { version: '0.40.15' }, repeat: true }, { path: '/v1/models', body: { object: 'list', data: [{ id: 'qwen3.6', owned_by: 'library' }] }, repeat: true }],
    lmstudio: [{ path: '/api/v1/models', body: { models: [{ key: 'qwen3' }] }, repeat: true }, { path: '/v1/models', body: { data: [{ id: 'qwen3', owned_by: 'organization_owner' }] }, repeat: true }],
    llamacpp: [{ path: '/props', body: { default_generation_settings: {}, build_info: 'b7000-abc' }, repeat: true }, { path: '/v1/models', body: { data: [{ id: 'm.gguf', owned_by: 'llamacpp' }] }, repeat: true }],
    localai: [{ path: '/version', body: { version: 'LocalAI v3.9.0' }, repeat: true }, { path: '/v1/models', body: { data: [{ id: 'phi', object: 'model' }] }, repeat: true }],
    vllm: [{ path: '/v1/models', body: { data: [{ id: 'Qwen/Qwen3-8B', owned_by: 'vllm', max_model_len: 32768 }] }, repeat: true }, { path: '/version', body: { version: '0.18.0' }, repeat: true }],
    lemonade: [{ path: '/v1/models', body: { data: [{ id: 'Qwen3-4B-GGUF', owned_by: 'lemonade', checkpoint: 'x', recipe: 'llamacpp' }] }, repeat: true }],
    koboldcpp: [{ path: '/api/extra/version', body: { result: 'KoboldCpp', version: '1.110' }, repeat: true }, { path: '/v1/models', body: { data: [{ id: 'koboldcpp/m' }] }, repeat: true }],
    'textgen-webui': [{ path: '/v1/internal/model/info', body: { model_name: 'm', lora_names: [] }, repeat: true }, { path: '/v1/models', body: { data: [{ id: 'm' }] }, repeat: true }],
  };
  const running: Record<string, Awaited<ReturnType<typeof serve>>> = {};
  for (const [id, routes] of Object.entries(servers)) running[id] = await serve(routes);
  try {
    for (const [server, s] of Object.entries(running)) {
      for (const probe of Object.keys(servers)) {
        const base = probe === 'lemonade' || server === 'lemonade' ? `${s.url}/v1` : `${s.url}/v1`;
        const got = (await localDetect(probe, [base])()).installed;
        assert.equal(got, probe === server, `${probe} probe on a ${server} server`);
      }
    }
    // Found on an older default address: detect reports where.
    const d = await localDetect('llamacpp', ['http://127.0.0.1:9/v1', `${running.llamacpp.url}/v1`])();
    assert.equal(d.baseUrl, `${running.llamacpp.url}/v1`);
    assert.equal(d.version, 'b7000-abc');
  } finally {
    for (const s of Object.values(running)) await s.close();
  }
  assert.ok(Object.keys(LOCAL_PROBES).length >= 10);
});

// ---------------------------------------------------------------------------------------------------------------
// Prices and catalogue hygiene

test('prices: own > live list > dated table; every table row has a date; free models are free', () => {
  clearListPrices();
  assert.equal(estimateCost('openai', 'gpt-6-luna', 1_000_000, 1_000_000), 0.6);
  assert.equal(estimateCost('openai', 'gpt-6-luna', 1_000_000, 0, 0, { prices: { 'gpt-6-luna': [1, 1] } }), 1, 'own price wins');
  assert.equal(estimateCost('anthropic', 'claude-opus-5-5', 1_000_000, 0, 1_000_000), 0.2, 'cache reads at the published cache price');
  assert.equal(estimateCost('bedrock', 'eu.anthropic.claude-sonnet-5-5', 1_000_000, 0), 2, 'Bedrock/Vertex ids map to the plain model');
  assert.equal(estimateCost('zai', 'glm-4.7-flash', 1e6, 1e6), 0);
  assert.equal(estimateCost('openrouter', 'x/y:free', 1e6, 1e6), 0);
  assert.equal(estimateCost('lemonade', 'any', 1e6, 1e6), 0);
  assert.equal(estimateCost('together', 'unknown/model', 1e6, 1e6), null, 'unknown stays unknown');
  rememberListPrices('together', [{ id: 'unknown/model', price: [0.2, 0.6] }]);
  assert.equal(estimateCost('together', 'unknown/model', 1e6, 1e6), 0.8);
  for (const r of builtinPriceTable()) {
    assert.match(r.checked, /^\d{4}-\d{2}-\d{2}$/, r.model);
    assert.match(r.src, /^https:\/\//, r.model);
  }
  clearListPrices();
});

test('catalogue: every provider and CLI is complete, honest about costs and dated', () => {
  const ids = new Set<string>();
  for (const p of PROVIDERS) {
    assert.ok(!ids.has(p.id), `duplicate ${p.id}`);
    ids.add(p.id);
    assert.ok(['free', 'subscription', 'local', 'key'].includes(p.section), p.id);
    assert.ok(p.costNote.length > 10 && /^\d{4}-\d{2}-\d{2}$/.test(p.costCheckedAt), `${p.id}: cost note with a date`);
    if (p.needsKey && !p.retired) assert.match(p.keyUrl || '', /^https:\/\//, `${p.id}: where to get a key`);
    if (p.section !== 'local' && !p.retired && p.id !== 'openai-compatible') assert.match(p.pricingUrl || '', /^https:\/\//, `${p.id}: price page`);
  }
  assert.ok(PROVIDERS.length >= 34);
  for (const want of ['google', 'groq', 'cerebras', 'mistral', 'openrouter', 'cloudflare', 'huggingface', 'together', 'fireworks', 'deepinfra', 'perplexity', 'xai', 'deepseek', 'moonshot', 'qwen', 'zai', 'minimax', 'azure', 'bedrock', 'vertex', 'anthropic', 'openai', 'ollama', 'lmstudio', 'llamacpp', 'vllm', 'jan', 'localai']) assert.ok(ids.has(want), want);
  assert.equal(PROVIDERS.find((p) => p.id === 'github')!.retired, '2026-07-30', 'GitHub Models stopped');
  for (const d of CLI_DEFS) {
    if (d.custom) continue;
    assert.ok(d.bins.length && d.docsUrl.startsWith('https://') && d.login && d.description && d.billingNote, d.id);
    if (d.engine === 'acp') assert.ok(Array.isArray(d.acpArgs), `${d.id}: ACP launch arguments`);
    assert.ok(Object.keys(d.install).length > 0, `${d.id}: install instructions`);
  }
  for (const want of ['claude-code', 'codex-cli', 'opencode', 'gemini-cli', 'qwen-code', 'copilot-cli', 'cursor-cli', 'kimi-code', 'grok-build', 'cline-cli', 'goose', 'amp-acp', 'pi-agent', 'devin-cli', 'hermes-agent', 'antigravity', 'auggie', 'factory-droid', 'mistral-vibe', 'junie-cli', 'kiro-cli', 'kilo-code', 'acp-custom']) assert.ok(CLI_DEFS.some((d) => d.id === want), want);
  assert.equal(CLI_DEFS.find((d) => d.id === 'goose')!.acpEnv!.GOOSE_MODE, 'approve', 'Goose asks before acting');
  assert.ok(CLI_DEFS.find((d) => d.id === 'pi-agent')!.unsupported);
});

// ---------------------------------------------------------------------------------------------------------------
// Through the app: key check before connecting, required fields, retired provider, reserve engines.

test('app: "Sleutel controleren" returns live models with a recommended default; wrong key → Dutch hint; required fields', async () => {
  const srv = await serve([
    { path: '/v1/models', body: { data: [{ id: 'model-a' }, { id: 'model-b' }] } },
    { path: '/v1/models', status: 401, body: { error: { message: 'Invalid API key' } } },
  ]);
  const t = await startTestApp({ modules: [] });
  try {
    const ok = await t.api('POST', '/provider-kinds/openai-compatible/check', { base_url: srv.url + '/v1' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.models.map((m: any) => m.id), ['model-a', 'model-b']);
    const bad = await t.api('POST', '/provider-kinds/openai-compatible/check', { base_url: srv.url + '/v1', apiKey: 'x' });
    assert.equal(bad.ok, false);
    assert.equal(bad.category, 'auth');
    assert.match(bad.hint, /API-sleutel/);
    const kindsView = await t.api('GET', '/provider-kinds');
    const cf = kindsView.find((k: any) => k.id === 'cloudflare');
    assert.equal(cf.section, 'free');
    assert.match(cf.costNote, /10\.000/);
    assert.equal(cf.recommend, undefined, 'regexes stay on the server');
    const res = await fetch(`${t.app.url}/api/providers`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'cloudflare', apiKey: 'x' }) });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).error, /Account-ID/);
    const gh = await fetch(`${t.app.url}/api/providers`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'github', apiKey: 'x' }) });
    assert.equal(gh.status, 400);
    assert.match(((await gh.json()) as any).error, /gestopt/);
  } finally {
    await t.close();
    await srv.close();
  }
});

test('app: no credit (402) and a vanished model (404) switch to the reserve engine, and say why', async () => {
  const srv = await serve([
    { path: '/v1/chat/completions', status: 402, body: { error: { code: 402, message: 'Insufficient credits' } } },
    { path: '/v1/chat/completions', status: 404, body: { error: { code: 404, message: 'No endpoints found for some/model:free.' } } },
  ]);
  const t = await startTestApp({ modules: [] });
  try {
    const main = await t.api('POST', '/providers', { kind: 'openai-compatible', name: 'Hoofd', base_url: srv.url + '/v1' });
    const reserve = await t.api('POST', '/providers', { kind: 'mock', name: 'Reserve' });
    const a = await t.agent({ provider_id: main.id, model: 'some/model:free', settings: { fallbacks: [{ provider_id: reserve.id, model: 'mock-1' }] } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'reserve antwoordt' });
    await t.say(th.id, 'hallo');
    const events = t.app.ctx.store.messages(th.id).filter((m: any) => m.role === 'event').map((m: any) => m.content);
    assert.ok(events.some((e: string) => /Hoofd.* heeft zijn gebruikslimiet bereikt.*Overgeschakeld naar reserve: Reserve/.test(e)), events.join(' | '));
    assert.equal(t.app.ctx.store.messages(th.id).filter((m: any) => m.role === 'assistant').at(-1)!.content, 'reserve antwoordt');
    t.app.ctx.services.runner.limited.clear();
    t.script.push({ text: 'weer de reserve' });
    await t.say(th.id, 'nog een');
    const ev2 = t.app.ctx.store.messages(th.id).filter((m: any) => m.role === 'event').map((m: any) => m.content);
    assert.ok(ev2.some((e: string) => /Hoofd.* kon niet starten.*Overgeschakeld naar reserve/.test(e)), ev2.join(' | '));
  } finally {
    await t.close();
    await srv.close();
  }
});
