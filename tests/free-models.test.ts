// Free models (package D1): free provider kinds, quota per account, the catalogue with a bounded tool probe, privacy
// labels, answer checks and ctx.services.freeModels. No network: a local HTTP server answers with recorded model lists
// (tests/fixtures/free-models, captured 2026-11-09 from the public lists, GET without key) and with answers built from
// each provider's documentation (URL per case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatRequest, StreamEvent } from '../server/core/types.js';
import { startTestApp, type TestApp } from './helpers.js';
import freeModels from '../server/modules/free-models/index.js';
import type { FreeModelsService } from '../server/modules/free-models/service.js';
import { openaiCompat } from '../server/providers/openai-compat.js';
import { errorInAnswer } from '../server/providers/answer-check.js';
import { ProviderError } from '../server/providers/common.js';
import { classifyEngineError } from '../server/agent/fallback.js';
import { builtinKinds } from '../server/providers/kinds.js';
import { PROVIDERS } from '../server/providers/catalog.js';
import { groqLimits, limitCooldown, limitWindow, nextUtcMidnight, openrouterFree, openrouterReset, parseDuration } from '../server/modules/free-models/quota.js';
import { familyOf } from '../server/modules/free-models/family.js';
import { PRIVACY_TEXT, privacyLabel } from '../server/modules/free-models/privacy.js';
import { privacyLabel as netPrivacy } from '../server/modules/network/privacy.js';
import { FREE_SOURCES, cardSources, sourceDef } from '../server/modules/free-models/sources.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'free-models');
const recorded = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8')).body;
const sig = () => new AbortController().signal;
const ask = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: 'm', system: 'kort', messages: [{ role: 'user', content: 'hallo' }], tools: [], ...over });
const ACCOUNT = 'a'.repeat(32);

// ---------------------------------------------------------------------------------------------------------------
// Fixture server and a fetch shim that sends the providers' real hosts to it.

interface Route {
  method?: string;
  path: string | RegExp;
  status?: number;
  headers?: Record<string, string>;
  body?: any;
  /** SSE events: objects are JSON, strings are sent as `data: <string>`. */
  sse?: (string | object)[];
  /** Keep the connection open after the events (a stalled stream). */
  hang?: boolean;
  repeat?: boolean;
  used?: boolean;
}

async function serve(routes: Route[]) {
  const seen: { method: string; path: string; body: any; headers: http.IncomingHttpHeaders }[] = [];
  const open = new Set<http.ServerResponse>();
  const srv = http.createServer((rq, rs) => {
    let data = '';
    rq.on('data', (c) => (data += c));
    rq.on('end', () => {
      const url = rq.url || '/';
      let body: any = data;
      try {
        body = data ? JSON.parse(data) : undefined;
      } catch {
        /* text */
      }
      seen.push({ method: rq.method || 'GET', path: url, body, headers: rq.headers });
      const r = routes.find((x) => !x.used && (!x.method || x.method === rq.method) && (typeof x.path === 'string' ? url.split('?')[0] === x.path : x.path.test(url)));
      if (!r) {
        rs.writeHead(404, { 'content-type': 'application/json' });
        return rs.end(JSON.stringify({ error: { message: `no fixture for ${rq.method} ${url}` } }));
      }
      if (!r.repeat) r.used = true;
      if (r.sse) {
        rs.writeHead(r.status ?? 200, { 'content-type': 'text/event-stream', ...(r.headers || {}) });
        for (const ev of r.sse) rs.write(typeof ev === 'string' ? `data: ${ev}\n\n` : `data: ${JSON.stringify(ev)}\n\n`);
        if (r.hang) {
          open.add(rs);
          return;
        }
        return rs.end();
      }
      rs.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...(r.headers || {}) });
      rs.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  return {
    url,
    seen,
    chats: () => seen.filter((s) => s.method === 'POST' && /chat\/completions$/.test(s.path)),
    close: () =>
      new Promise<void>((r) => {
        for (const rs of open) rs.destroy();
        srv.closeAllConnections?.();
        srv.close(() => r());
      }),
  };
}

const realFetch = globalThis.fetch;
/** Requests to the providers' real addresses go to the fixture server (prefix per provider). */
function shim(base: string) {
  const map: [string, string][] = [
    ['https://api.groq.com', `${base}/groq`],
    ['https://openrouter.ai', `${base}/openrouter`],
    ['https://ai-gateway.kilo.ai', `${base}/kilo`],
    ['https://api.cloudflare.com', `${base}/cf`],
    ['https://api.z.ai', `${base}/zai`],
  ];
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [from, to] of map) if (url.startsWith(from)) return realFetch(to + url.slice(from.length), init);
    return realFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

const chunk = (delta: any, finish: string | null = null, model = 'm') => ({ id: 'c1', object: 'chat.completion.chunk', created: 1794000000, model, choices: [{ index: 0, delta, finish_reason: finish }] });
const textSSE = (text: string, model = 'm') => [chunk({ role: 'assistant', content: text }, null, model), chunk({}, 'stop', model), '[DONE]'];
const toolSSE = (name: string, args: any, model = 'm') => [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null, model), chunk({}, 'tool_calls', model), '[DONE]'];

/** Groq GET /openai/v1/models (shape from https://console.groq.com/docs/models). */
const GROQ_MODELS = {
  object: 'list',
  data: [
    { id: 'openai/gpt-oss-120b', object: 'model', created: 1754408224, owned_by: 'OpenAI', active: true, context_window: 131072, public_apps: null, max_completion_tokens: 65536 },
    { id: 'qwen/qwen3.8-27b', object: 'model', created: 1790000000, owned_by: 'Alibaba Cloud', active: true, context_window: 131072, public_apps: null, max_completion_tokens: 16384 },
    { id: 'whisper-large-v3', object: 'model', created: 1693721698, owned_by: 'OpenAI', active: true, context_window: 448, public_apps: null, max_completion_tokens: 448 },
  ],
};
/** Groq rate-limit headers (https://console.groq.com/docs/rate-limits): requests = per day, tokens = per minute. */
const groqHeaders = (remainingRequests: number, resetRequests = '2m59.56s') => ({
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-remaining-requests': String(remainingRequests),
  'x-ratelimit-reset-requests': resetRequests,
  'x-ratelimit-limit-tokens': '8000',
  'x-ratelimit-remaining-tokens': '7900',
  'x-ratelimit-reset-tokens': '7.66s',
});

async function app(): Promise<TestApp & { svc: FreeModelsService; reports: any[] }> {
  const t = await startTestApp({ modules: [freeModels] });
  const reports: any[] = [];
  // The usage bar's source report (agent E) is feature-detected: a stand-in records what it would get.
  t.app.ctx.services.usage = { reportSource: (r: any) => reports.push(r) };
  const svc = t.app.ctx.services.freeModels.service as FreeModelsService;
  // Every probe in these tests is sent on purpose (the routes would otherwise send due probes in the background).
  svc.autoProbe = false;
  return Object.assign(t, { svc, reports });
}

const cfgOf = (t: TestApp, kind: string) => t.app.ctx.providers.list(t.app.ctx.auth.owner()!.id).find((c) => c.kind === kind)!;

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers: quota signals, families, labels, answer checks.

test('quota signals: Groq durations and headers, OpenRouter counter and reset, daily reset at 00:00 UTC, guessed waits double', () => {
  assert.equal(parseDuration('2m59.56s'), 179_560);
  assert.equal(parseDuration('7.66s'), 7660);
  assert.equal(parseDuration('450ms'), 450);
  assert.equal(parseDuration('1h0m0s'), 3_600_000);
  assert.equal(parseDuration('12'), 12_000);
  assert.equal(parseDuration(''), null);
  const now = Date.UTC(2026, 10, 9, 21, 30);
  const g = groqLimits(new Headers(groqHeaders(0)), now);
  assert.deepEqual(g.requests, { limit: 1000, remaining: 0, resetAt: now + 179_560 });
  assert.equal(g.tokens!.resetAt, now + 7660);
  const groq = sourceDef('groq')!;
  assert.deepEqual(limitCooldown(groq, { message: 'Rate limit reached for model on requests per day (RPD)', groq: g, now }), { until: now + 179_560, scope: 'model', known: true, reason: 'Daglimiet van dit model bereikt' }, 'Groq: limits per model, reset from the headers');
  // OpenRouter (https://openrouter.ai/docs/api/reference/limits): per-day counter per UTC day for the whole account.
  const or = sourceDef('openrouter')!;
  assert.equal(nextUtcMidnight(now), Date.UTC(2026, 10, 10));
  const perDay = limitCooldown(or, { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', now });
  assert.deepEqual(perDay, { until: Date.UTC(2026, 10, 10), scope: 'account', known: true, reason: 'Daglimiet bereikt' });
  const reset = now + 3_600_000;
  const body = JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day', metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) } } } });
  assert.equal(openrouterReset(body), reset);
  assert.equal(limitCooldown(or, { message: 'Rate limit exceeded: free-models-per-day', body, now }).until, reset, 'the reset OpenRouter sends wins');
  assert.equal(limitWindow('Rate limit exceeded: free-models-per-min. Add 10 credits to unlock 1000 free model requests per day'), 'minute');
  const perMin = limitCooldown(or, { message: 'Rate limit exceeded: free-models-per-min.', now });
  assert.equal(perMin.until, now + 60_000);
  assert.equal(perMin.known, false);
  assert.equal(limitCooldown(or, { message: 'Rate limit exceeded: free-models-per-min.', hits: 2, now }).until, now + 240_000, 'a guess doubles while it keeps failing');
  assert.equal(limitCooldown(or, { message: 'too many', retryAfter: 30, now }).until, now + 30_000, 'Retry-After');
  // Cloudflare (https://developers.cloudflare.com/workers-ai/platform/pricing/): 10.000 neurons per day, reset 00:00 UTC.
  assert.equal(limitCooldown(sourceDef('cloudflare')!, { message: 'you have used up your daily free allocation of 10,000 neurons', now }).until, Date.UTC(2026, 10, 10));
  // Kilo without a key: 200 per hour per IP.
  assert.deepEqual(limitCooldown(sourceDef('kilo')!, { message: 'Too Many Requests', keyless: true, now }), { until: now + 3_600_000, scope: 'account', known: false, reason: 'Uurlimiet bereikt' });
  assert.deepEqual(openrouterFree({ data: { free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } } }), { used: 50, limit: 50, remaining: 0 });
  assert.equal(openrouterFree({ data: {} }), null);
});

test('families and privacy labels: the same model at another provider, three labels from the terms', () => {
  assert.equal(familyOf('openai/gpt-oss-120b'), 'gpt-oss');
  assert.equal(familyOf('@cf/openai/gpt-oss-120b'), 'gpt-oss');
  assert.equal(familyOf('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), 'llama');
  assert.equal(familyOf('nvidia/nemotron-3-ultra-550b-a55b:free'), 'nemotron');
  assert.equal(familyOf('glm-4.7-flash'), 'glm');
  assert.equal(familyOf('opencode/big-pickle'), 'big-pickle');
  assert.equal(familyOf('google/gemma-4-31b-it:free'), 'gemma');
  assert.equal(privacyLabel('ollama').label, 'blijft op je pc');
  assert.equal(privacyLabel('cloudflare').label, 'bewaart niets');
  assert.equal(privacyLabel('groq').level, 'no-store');
  assert.equal(privacyLabel('openrouter').label, 'kan trainen');
  assert.equal(privacyLabel('kilo').label, 'kan trainen');
  assert.equal(privacyLabel('zai').level, 'may-train', 'terms not found: assume the worst');
  assert.equal(privacyLabel('opencode', 'opencode/glm-5.3-flash-free').level, 'no-store', 'OpenCode: zero retention for this free model');
  assert.equal(privacyLabel('opencode', 'opencode/big-pickle').level, 'may-train');
  assert.equal(privacyLabel('iets-onbekends').level, 'may-train');
  assert.deepEqual(Object.values(PRIVACY_TEXT), ['blijft op je pc', 'bewaart niets', 'kan trainen']);
});

test('privacy labels of the network module (P): the terms of Kilo and Z.ai come in through registerPrivacyRule, its own checked rules stay, and they go again at stop', async () => {
  const before = { kilo: netPrivacy('kilo', 'nvidia/nemotron-3-ultra-550b-a55b:free'), groq: netPrivacy('groq', 'openai/gpt-oss-120b'), cloudflare: netPrivacy('cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast') };
  assert.equal(before.kilo.level, 'unknown', 'without this module the network module does not know Kilo');
  const t = await startTestApp({ modules: [freeModels] });
  try {
    const kilo = netPrivacy('kilo', 'nvidia/nemotron-3-ultra-550b-a55b:free');
    assert.equal(kilo.level, 'may-train');
    assert.equal(kilo.label, 'Kan trainen', "in the network module's own words");
    assert.equal(kilo.receiver, 'Kilo Gateway');
    assert.equal(kilo.detail, privacyLabel('kilo').note);
    assert.equal(kilo.policyUrl, privacyLabel('kilo').source);
    assert.match(kilo.checkedAt, /^\d{4}-\d\d-\d\d$/);
    const zai = netPrivacy('zai', 'glm-4.7-flash');
    assert.equal(zai.level, 'may-train');
    assert.equal(zai.receiver, 'Z.ai GLM');
    // What the network module checked itself is not overwritten.
    assert.deepEqual(netPrivacy('groq', 'openai/gpt-oss-120b'), before.groq);
    assert.deepEqual(netPrivacy('cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'), before.cloudflare);
    assert.equal(netPrivacy('opencode', 'opencode/crouton-free').level, 'no-train', "OpenCode's per-model rule of the network module");
    assert.equal(netPrivacy('ollama', 'qwen3:8b', { baseUrl: 'http://192.168.1.40:11434/v1' }).level, 'lan');
  } finally {
    await t.close();
  }
  assert.equal(netPrivacy('kilo', 'x:free').level, 'unknown', 'the rules go again when the module stops');
});

test('catalogue: free sources with sign-up page, limits, terms and a date; no Gemini; Kilo works without a key', () => {
  const ids = FREE_SOURCES.map((d) => d.kind);
  for (const want of ['groq', 'openrouter', 'cloudflare', 'zai', 'kilo', 'opencode', 'ollama']) assert.ok(ids.includes(want), want);
  assert.ok(!ids.includes('google'), 'Gemini free tier: not allowed in apps for EEA users');
  for (const d of cardSources()) {
    assert.match(d.signupUrl || '', /^https:\/\//, `${d.kind}: sign-up page`);
    assert.match(d.docs.limits, /^https:\/\//, `${d.kind}: limits page`);
    assert.match(d.docs.terms, /^https:\/\//, `${d.kind}: terms page`);
    assert.equal(d.docs.checked, '2026-11-09');
    assert.ok(d.limitNote.length > 20);
    assert.ok(privacyLabel(d.kind).note && privacyLabel(d.kind).source, `${d.kind}: privacy note with its source`);
    assert.ok(d.probesPerDay > 0 && d.probesPerDay <= 6, `${d.kind}: probes stay a small part of the free quota`);
    assert.equal(PROVIDERS.find((p) => p.id === d.kind)?.answerCheck, true, `${d.kind}: answers are checked`);
  }
  assert.equal(sourceDef('opencode')!.engine, 'cli', 'OpenCode Zen only through the OpenCode CLI');
  assert.equal(sourceDef('opencode')!.probesPerDay, 0, 'never spends OpenCode free quota on probes');
  const kilo = PROVIDERS.find((p) => p.id === 'kilo')!;
  assert.equal(kilo.baseUrl, 'https://ai-gateway.kilo.ai/api/v1');
  assert.equal(kilo.needsKey, false);
  assert.equal(kilo.keyOptional, true);
});

test('answer checks: an error text in a "successful" answer is found, a normal answer is not', () => {
  assert.equal(errorInAnswer('Error: not enough credits. Please upgrade your plan.'), 'quota');
  assert.equal(errorInAnswer('⚠️ Not enough pollen: this model needs paid Pollen. Please upgrade.'), 'quota');
  assert.equal(errorInAnswer('{"error":{"message":"Rate limit exceeded: free-models-per-day","code":429}}'), 'rate_limit');
  assert.equal(errorInAnswer('<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>Bad Gateway</body></html>'), 'overloaded');
  assert.equal(errorInAnswer('[error] upstream error: provider unavailable, try again later'), 'overloaded');
  assert.equal(errorInAnswer('<!DOCTYPE html><html><head><title>429 Too Many Requests</title></head><body>' + 'x'.repeat(3000) + '</body></html>'), 'rate_limit', 'a long proxy page too');
  assert.equal(errorInAnswer('<!DOCTYPE html>\n<html><head><title>Mijn webshop</title></head><body><h1>Welkom</h1></body></html>'), null, 'a page the model wrote is an answer');
  assert.equal(errorInAnswer('Hallo! Hoe kan ik je vandaag helpen?'), null);
  assert.equal(errorInAnswer('Te veel verzoeken (too many requests) betekent dat je even moet wachten.'), null, 'an answer about an error is no error');
  assert.equal(errorInAnswer('Error handling in TypeScript works with try/catch. ' + 'Uitleg. '.repeat(100)), null, 'long answers are never checked');
  assert.equal(errorInAnswer(''), null);
});

// ---------------------------------------------------------------------------------------------------------------
// The OpenAI-compatible adapter with answer checks (as the free kinds use it).

test('adapter: 200 with an error text, a cut-off stream, a silent stream and an empty answer are failures the reserve logic understands', async () => {
  const srv = await serve([
    { method: 'POST', path: '/v1/chat/completions', sse: textSSE('Error: not enough credits. Please upgrade your plan.') },
    { method: 'POST', path: '/v1/chat/completions', sse: textSSE('{"error":{"message":"Rate limit exceeded: free-models-per-day","code":429}}') },
    { method: 'POST', path: '/v1/chat/completions', sse: [chunk({ role: 'assistant', content: 'Hallo, ik ben' })] },
    { method: 'POST', path: '/v1/chat/completions', sse: [chunk({ role: 'assistant', content: 'Hallo, ik ben' })], hang: true },
    { method: 'POST', path: '/v1/chat/completions', sse: [], hang: true },
    { method: 'POST', path: '/v1/chat/completions', sse: [chunk({ role: 'assistant', content: '' }), chunk({}, 'stop'), '[DONE]'] },
    { method: 'POST', path: '/v1/chat/completions', sse: textSSE('Hallo! Hoe kan ik je helpen?') },
    { method: 'POST', path: '/v1/chat/completions', sse: [chunk({ role: 'assistant', content: 'Hallo, ik ben' })] },
  ]);
  try {
    const a = openaiCompat({ kind: 'kilo', label: 'Kilo Gateway', baseUrl: srv.url + '/v1', key: null, answerCheck: true, stallMs: { first: 400, idle: 150 } });
    const run = async () => {
      const events: StreamEvent[] = [];
      try {
        const r = await a.chat!(ask(), sig(), (e) => events.push(e));
        return { r, events, err: null as any };
      } catch (err: any) {
        return { r: null, events, err };
      }
    };
    const shown = (ev: StreamEvent[]) => ev.filter((e) => e.type === 'text').map((e: any) => e.delta).join('');

    const credits = await run();
    assert.ok(credits.err instanceof ProviderError);
    assert.equal(credits.err.category, 'quota');
    assert.equal(classifyEngineError(credits.err), 'limit', 'no credit: the reserve takes over');
    assert.match(credits.err.message, /^Kilo Gateway: 200 Geen tegoed/);
    assert.equal(shown(credits.events), '', 'the error text never reached the chat');

    const limited = await run();
    assert.equal(limited.err.category, 'rate_limit');
    assert.equal(classifyEngineError(limited.err), 'limit');

    const cut = await run();
    assert.equal(cut.err.category, 'overloaded');
    assert.match(cut.err.message, /brak af/);
    assert.equal(classifyEngineError(cut.err), 'outage', 'a cut-off answer is no "klaar"');

    const t0 = Date.now();
    const stalled = await run();
    assert.equal(stalled.err.category, 'overloaded');
    assert.match(stalled.err.message, /halverwege stil/);
    assert.ok(Date.now() - t0 < 3000, 'a silent stream is stopped, not waited for');

    const silent = await run();
    assert.match(silent.err.message, /geen antwoord binnen/);
    assert.equal(classifyEngineError(silent.err), 'outage');

    const empty = await run();
    assert.match(empty.err.message, /leeg/);

    const fine = await run();
    assert.equal(fine.err, null);
    assert.equal(fine.r!.text, 'Hallo! Hoe kan ik je helpen?');
    assert.equal(shown(fine.events), 'Hallo! Hoe kan ik je helpen?', 'a good answer is shown once, whole');

    // Providers without answerCheck keep their old behaviour.
    const plain = openaiCompat({ kind: 'x', label: 'X', baseUrl: srv.url + '/v1', key: null });
    const r = await plain.chat!(ask(), sig(), () => {});
    assert.equal(r.text, 'Hallo, ik ben');
  } finally {
    await srv.close();
  }
});

test('adapter: a long answer streams on after the first 600 characters; a tool call is never held back', async () => {
  const long = 'Dit is een lang antwoord. '.repeat(40);
  const srv = await serve([
    { method: 'POST', path: '/v1/chat/completions', sse: [...long.match(/.{1,50}/gs)!.map((p) => chunk({ content: p })), chunk({}, 'stop'), '[DONE]'] },
    { method: 'POST', path: '/v1/chat/completions', sse: toolSSE('ping', { text: 'ok' }) },
  ]);
  try {
    const a = openaiCompat({ kind: 'groq', label: 'Groq', baseUrl: srv.url + '/v1', key: 'k', answerCheck: true });
    const deltas: string[] = [];
    const r = await a.chat!(ask(), sig(), (e) => e.type === 'text' && deltas.push(e.delta));
    assert.equal(r.text, long);
    assert.equal(deltas.join(''), long);
    assert.ok(deltas.length > 2 && deltas[0].length >= 600, 'held until it is clearly no error message, then streamed');
    const t = await a.chat!(ask({ tools: [{ name: 'ping', description: 'p', parameters: { type: 'object' } }] }), sig(), () => {});
    assert.deepEqual(t.toolCalls.map((c) => [c.name, c.args]), [['ping', { text: 'ok' }]]);
  } finally {
    await srv.close();
  }
});

test('Kilo Gateway (recorded list): without a key only the free models; with a key all of them', async () => {
  const body = recorded('kilo-models');
  const srv = await serve([{ path: '/v1/models', body, repeat: true }]);
  try {
    const kind = builtinKinds().find((k) => k.id === 'kilo')!;
    const cfg = { id: 'p', user_id: 'u', kind: 'kilo', name: 'Kilo Gateway', base_url: srv.url + '/v1', secret_id: null, config: {}, enabled: true, shared: false, created_at: '' };
    const anon = await kind.create(cfg, null, null as any).listModels();
    assert.deepEqual(anon.map((m) => m.id), ['kilo-auto/free', 'liquid/lfm-3-1.7b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-super-vl:free']);
    assert.ok(anon.every((m) => m.free && m.tools));
    assert.equal(anon.find((m) => m.id === 'nvidia/nemotron-3-ultra-550b-a55b:free')!.context, 1_000_000);
    assert.equal(srv.seen[0].headers.authorization, undefined, 'no key sent');
    const keyed = await kind.create(cfg, 'kilo-key', null as any).listModels();
    assert.equal(keyed.length, 6);
    assert.equal(srv.seen[1].headers.authorization, 'Bearer kilo-key');
    const test1 = await kind.create(cfg, null, null as any).test();
    assert.equal(test1.ok, true);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Through the app.

test('a 429 cools the whole OpenRouter account down until its reset; another provider comes first; the usage bar hears it', async () => {
  const reset = Date.now() + 5 * 3_600_000;
  const srv = await serve([
    { path: '/openrouter/api/v1/models', body: recorded('openrouter-models'), repeat: true },
    { path: '/openrouter/api/v1/key', body: { data: { label: 'sk-or-v1-abc...', is_free_tier: true, usage: 0, limit: null, limit_remaining: null, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } } },
    { path: '/openrouter/api/v1/key', body: { data: { is_free_tier: true, free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } } }, repeat: true },
    { path: '/kilo/api/v1/models', body: recorded('kilo-models'), repeat: true },
    {
      method: 'POST',
      path: '/openrouter/api/v1/chat/completions',
      status: 429,
      body: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) } } } },
    },
  ]);
  const restore = shim(srv.url);
  const t = await app();
  try {
    await t.api('POST', '/providers', { kind: 'openrouter', apiKey: 'sk-or-v1-test' });
    await t.api('PUT', '/free-models/sources/kilo', { on: true });
    const v = await t.api('POST', '/free-models/refresh');
    const or = v.sources.find((x: any) => x.kind === 'openrouter');
    assert.equal(or.status, 'available');
    assert.deepEqual(or.models.map((m: any) => m.id).sort(), ['google/gemma-4-31b-it:free', 'liquid/lfm-3-1.7b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'], 'only ":free", never the random router or a paid model');
    assert.deepEqual(or.remaining, { remaining: 47, limit: 50, resetsAt: nextUtcMidnight() }, 'read from /api/v1/key');
    assert.equal(or.privacy.label, 'kan trainen');
    assert.ok(!JSON.stringify(v).includes('sk-or-v1-test'), 'the key never comes back');

    const cfg = cfgOf(t, 'openrouter');
    await assert.rejects(t.app.ctx.providers.adapterFor(cfg).chat!(ask({ model: 'nvidia/nemotron-3-ultra-550b-a55b:free' }), sig(), () => {}), /Limiet bereikt/);
    const c = t.app.ctx.services.freeModels.candidates();
    const orC = c.filter((x: any) => x.providerKind === 'openrouter');
    assert.equal(orC.length, 3);
    assert.ok(orC.every((x: any) => !x.available && x.availableAt === reset), 'every model of the account waits: quota counts per account, not per model');
    assert.equal(c[0].providerKind, 'kilo', 'an available other provider comes first');
    assert.ok(c.findIndex((x: any) => x.providerKind === 'openrouter') > c.findLastIndex((x: any) => x.providerKind === 'kilo'));
    const dot = t.reports.filter((r) => r.id === 'openrouter').at(-1);
    assert.equal(dot.status, 'limited');
    assert.equal(dot.resetsAt, reset);
    assert.equal(dot.providerId, cfg.id);
    // After the reset it is offered again by itself.
    t.svc.now = () => reset + 1000;
    assert.ok(t.app.ctx.services.freeModels.candidates().filter((x: any) => x.providerKind === 'openrouter').every((x: any) => x.available));
  } finally {
    await t.close();
    restore();
    await srv.close();
  }
});

test('a 404 removes a model from the catalogue: logged, no error for the user, and a ghost entry stays out', async () => {
  const srv = await serve([
    { path: '/kilo/api/v1/models', body: recorded('kilo-models'), repeat: true },
    { method: 'POST', path: '/kilo/api/v1/chat/completions', status: 404, body: { error: { message: 'Model nvidia/nemotron-3.5-super-vl:free not found', code: 404 } } },
  ]);
  const restore = shim(srv.url);
  const t = await app();
  const seenEvents: string[] = [];
  t.app.ctx.events.subscribe((e: any) => seenEvents.push(e.type));
  try {
    await t.api('PUT', '/free-models/sources/kilo', { on: true });
    const cfg = cfgOf(t, 'kilo');
    assert.equal(cfg.secret_id, null, 'Kilo runs without a key');
    const gone = 'nvidia/nemotron-3.5-super-vl:free';
    assert.ok(t.app.ctx.services.freeModels.candidates().some((x: any) => x.model === gone));
    await assert.rejects(t.app.ctx.providers.adapterFor(cfg).chat!(ask({ model: gone }), sig(), () => {}));
    assert.ok(!t.app.ctx.services.freeModels.candidates().some((x: any) => x.model === gone), 'gone from the chain');
    const v = await t.api('GET', '/free-models');
    const kilo = v.sources.find((x: any) => x.kind === 'kilo');
    assert.deepEqual(kilo.gone.map((g: any) => g.id), [gone]);
    assert.equal(kilo.status, 'available', 'the source itself is fine');
    assert.ok(!seenEvents.includes('notification'), 'no message to the user');
    assert.ok(t.app.ctx.store.all("SELECT * FROM audit WHERE kind = 'free_models.model_gone'").length === 1, 'logged once');
    // The provider still lists it the next day: it stays out until a probe shows it works again.
    t.svc.now = () => Date.now() + 25 * 3_600_000;
    await t.api('POST', '/free-models/refresh');
    assert.ok(!t.app.ctx.services.freeModels.candidates().some((x: any) => x.model === gone));
  } finally {
    await t.close();
    restore();
    await srv.close();
  }
});

test('probe: one tool call labels "tools werken" or "alleen tekst", at most once per model per day, within the daily budget', async () => {
  const srv = await serve([
    { path: '/groq/openai/v1/models', body: GROQ_MODELS, repeat: true },
    { method: 'POST', path: '/groq/openai/v1/chat/completions', headers: groqHeaders(998), sse: toolSSE('ping', { text: 'ok' }, 'openai/gpt-oss-120b') },
    { method: 'POST', path: '/groq/openai/v1/chat/completions', headers: groqHeaders(997), sse: textSSE('ok', 'qwen/qwen3.8-27b') },
    { method: 'POST', path: '/groq/openai/v1/chat/completions', headers: groqHeaders(996), sse: toolSSE('ping', { text: 'ok' }, 'openai/gpt-oss-120b') },
  ]);
  const restore = shim(srv.url);
  const t = await app();
  try {
    await t.api('PUT', '/free-models/sources/groq', { apiKey: 'gsk_test', on: true });
    const cfg = cfgOf(t, 'groq');
    // What the background work does: one due probe per source, the recommended untested model first.
    await t.svc.refreshUser(t.app.ctx.auth.owner()!.id, { probe: true });
    assert.equal(srv.chats().length, 1, 'one probe per source per round');
    let v = (await t.api('GET', '/free-models')).sources.find((x: any) => x.kind === 'groq');
    assert.deepEqual(v.models.map((m: any) => m.id), ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'], 'speech models are no chat models');
    assert.equal(v.models[0].tools, 'tools');
    assert.equal(srv.chats()[0].body.tools[0].function.name, 'ping', 'the probe offers exactly one tool');
    assert.ok(srv.chats()[0].body.max_tokens <= 512, 'a small request');
    assert.equal(await t.svc.probe(cfg, 'qwen/qwen3.8-27b'), true);
    v = (await t.api('GET', '/free-models')).sources.find((x: any) => x.kind === 'groq');
    assert.equal(v.models.find((m: any) => m.id === 'qwen/qwen3.8-27b').tools, 'text', 'answered without the tool');
    assert.equal(v.counts.tools, 1);
    assert.equal(v.counts.text, 1);
    assert.equal(v.privacy.label, 'bewaart niets');
    // Same day: no second probe of the same model, also when asked again.
    const before = srv.chats().length;
    assert.equal(await t.svc.probe(cfg, 'openai/gpt-oss-120b'), false);
    assert.equal(await t.svc.probe(cfg, 'qwen/qwen3.8-27b'), false);
    await t.api('POST', '/free-models/refresh');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.chats().length, before, 'no probe request at all');
    // A day later the model may be probed once more.
    t.svc.now = () => Date.now() + 25 * 3_600_000;
    assert.equal(await t.svc.probe(cfg, 'openai/gpt-oss-120b'), true);
    assert.equal(srv.chats().length, before + 1);
    // Groq said what is left today for that model (x-ratelimit headers).
    const row = t.app.ctx.store.one<any>("SELECT data FROM free_models WHERE model = 'openai/gpt-oss-120b'");
    assert.equal(JSON.parse(row.data).remaining.requests.remaining, 996);
    assert.ok(!JSON.stringify(await t.api('GET', '/free-models')).includes('gsk_test'));
  } finally {
    await t.close();
    restore();
    await srv.close();
  }
});

test('Groq: an empty daily limit of one model (headers) blocks only that model; probes never run while a source waits', async () => {
  const srv = await serve([
    { path: '/groq/openai/v1/models', body: GROQ_MODELS, repeat: true },
    {
      method: 'POST',
      path: '/groq/openai/v1/chat/completions',
      status: 429,
      headers: { ...groqHeaders(0, '3h0m0s'), 'retry-after': '10800' },
      body: { error: { message: 'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 3h0m0s.', type: 'requests', code: 'rate_limit_exceeded' } },
    },
  ]);
  const restore = shim(srv.url);
  const t = await app();
  try {
    const p = await t.api('POST', '/providers', { kind: 'groq', apiKey: 'gsk_test' });
    await t.svc.refreshUser(t.app.ctx.auth.owner()!.id, { force: true, probe: false });
    const cfg = t.app.ctx.providers.config(p.id)!;
    await assert.rejects(t.app.ctx.providers.adapterFor(cfg).chat!(ask({ model: 'openai/gpt-oss-120b' }), sig(), () => {}));
    const c = t.app.ctx.services.freeModels.candidates();
    const oss = c.find((x: any) => x.model === 'openai/gpt-oss-120b');
    const qwen = c.find((x: any) => x.model === 'qwen/qwen3.8-27b');
    assert.equal(oss.available, false);
    assert.ok(Math.abs(oss.availableAt - (Date.now() + 3 * 3_600_000)) < 5000, 'until the reset Groq gave');
    assert.equal(qwen.available, true, 'Groq counts per model: the other model still works');
    assert.equal(await t.svc.probe(cfg, 'openai/gpt-oss-120b'), false, 'no probe on a model that waits for its reset');
  } finally {
    await t.close();
    restore();
    await srv.close();
  }
});

test('candidates(): other provider first, same family first, tools filter, privacy filter, local last, one account per provider', async () => {
  const srv = await serve([
    { path: '/groq/openai/v1/models', body: GROQ_MODELS, repeat: true },
    { path: '/openrouter/api/v1/models', body: recorded('openrouter-models'), repeat: true },
    { path: '/openrouter/api/v1/key', body: { data: { free_model_daily_requests: { used: 1, limit: 50, remaining: 49 } } }, repeat: true },
    { path: '/kilo/api/v1/models', body: recorded('kilo-models'), repeat: true },
    { path: '/vllm/v1/models', body: { object: 'list', data: [{ id: 'Qwen/Qwen3-8B', object: 'model', max_model_len: 32768 }] }, repeat: true },
  ]);
  const restore = shim(srv.url);
  const t = await app();
  try {
    const uid = t.app.ctx.auth.owner()!.id;
    const groq1 = await t.api('POST', '/providers', { kind: 'groq', apiKey: 'gsk_een' });
    const groq2 = await t.api('POST', '/providers', { kind: 'groq', apiKey: 'gsk_twee', name: 'Groq 2' });
    await t.api('POST', '/providers', { kind: 'openrouter', apiKey: 'sk-or-v1-x' });
    await t.api('PUT', '/free-models/sources/kilo', { on: true });
    await t.api('POST', '/providers', { kind: 'vllm', base_url: srv.url + '/vllm/v1' });
    await t.svc.refreshUser(uid, { force: true, probe: false });
    const fm = t.app.ctx.services.freeModels;
    const kilo = cfgOf(t, 'kilo');
    // Labels as the probes would have set them.
    const tools = (pid: string, model: string) => fm.report({ providerId: pid, model }, { ok: true, usedTools: true, toolCalls: 1 });
    tools(groq1.id, 'openai/gpt-oss-120b');
    fm.report({ providerId: groq1.id, model: 'qwen/qwen3.8-27b' }, { ok: true, noTools: true });
    const or = cfgOf(t, 'openrouter');
    for (const m of ['nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free']) tools(or.id, m);
    for (const m of ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-super-vl:free', 'liquid/lfm-3-1.7b:free']) tools(kilo.id, m);

    const all = fm.candidates();
    assert.ok(all.every((x: any) => x.providerId !== groq2.id), 'never a second account of the same provider');
    assert.equal(all.at(-1).engine, 'local', 'local models at the end of the chain');
    assert.equal(all.at(-1).privacy.label, 'blijft op je pc');

    const c = fm.candidates({ exclude: [{ providerId: kilo.id, model: 'nvidia/nemotron-3-ultra-550b-a55b:free' }], family: 'nemotron', needTools: true });
    const ids = c.map((x: any) => `${x.providerKind}:${x.model}`);
    assert.equal(ids[0], 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', 'the same family at another provider first');
    assert.ok(!ids.includes('kilo:nvidia/nemotron-3-ultra-550b-a55b:free'), 'what failed is left out');
    assert.ok(!ids.includes('groq:qwen/qwen3.8-27b'), '"alleen tekst" is left out when tools are needed');
    const lastOther = Math.max(...c.map((x: any, i: number) => (x.providerKind !== 'kilo' && x.engine !== 'local' ? i : -1)));
    const firstKilo = c.findIndex((x: any) => x.providerKind === 'kilo');
    assert.ok(firstKilo > lastOther, 'the provider that just failed comes after the others (quota per account)');
    assert.equal(c[firstKilo].model, 'nvidia/nemotron-3.5-super-vl:free', 'and within it, the same family first');
    const testedFirst = c.filter((x: any) => x.providerKind === 'openrouter');
    assert.ok(testedFirst.findIndex((x: any) => x.tools === 'unknown') > testedFirst.findIndex((x: any) => x.tools === 'tools'), '"tools werken" before "nog niet getest"');
    for (const x of c) assert.ok(x.privacy.label && typeof x.available === 'boolean' && 'availableAt' in x && 'resetsAt' in x);

    const priv = fm.candidates({ privacy: 'no-store' });
    assert.deepEqual([...new Set(priv.map((x: any) => x.providerKind))].sort(), ['groq', 'vllm'], 'private work: only "bewaart niets" and this computer');
    assert.deepEqual([...new Set(fm.candidates({ privacy: 'local' }).map((x: any) => x.engine))], ['local']);
    assert.ok(!fm.candidates({ includeLocal: false }).some((x: any) => x.engine === 'local'));
    assert.ok(!fm.candidates({ exclude: [or.id] }).some((x: any) => x.providerId === or.id), 'a provider id leaves it out entirely');

    const v = await t.api('GET', '/free-models');
    assert.equal(v.sources.find((x: any) => x.kind === 'groq').extraAccounts, 1);
    assert.deepEqual(v.engines.map((x: any) => x.kind), ['ollama', 'vllm'], 'Ollama is always listed (with Aanzetten or Installeren), vLLM because it is connected');
    const api = await t.api('GET', '/free-models/candidates?needTools=1&privacy=no-store');
    assert.ok(api.every((x: any) => x.toolsText && x.privacyText));

    // Switched off in "Gratis modellen": out of the chain, the connection itself stays.
    await t.api('PUT', '/free-models/sources/groq', { on: false });
    assert.ok(!fm.candidates().some((x: any) => x.providerKind === 'groq'));
    assert.ok((await t.api('GET', '/providers')).some((p: any) => p.id === groq1.id));
  } finally {
    await t.close();
    restore();
    await srv.close();
  }
});

test('OpenCode free models come in through the OpenCode CLI only: labelled, never probed', async () => {
  const t = await app();
  try {
    t.app.ctx.providers.registerKind({
      id: 'opencode',
      label: 'OpenCode',
      type: 'cli',
      needsKey: false,
      description: 'test',
      create: () => ({
        kind: 'opencode',
        async listModels() {
          return [
            { id: 'opencode/big-pickle', billing: 'free' as const, tools: true },
            { id: 'opencode/glm-5.3-flash-free', billing: 'free' as const, tools: true },
            { id: 'anthropic/claude-sonnet-5-5', tools: true },
          ];
        },
        async test() {
          return { ok: true, detail: '' };
        },
        async runAgent() {
          throw new Error('not in this test');
        },
      }),
    });
    const p = await t.api('POST', '/providers', { kind: 'opencode' });
    await t.svc.refreshUser(t.app.ctx.auth.owner()!.id, { force: true });
    const c = t.app.ctx.services.freeModels.candidates();
    assert.deepEqual(c.map((x: any) => x.model).sort(), ['opencode/big-pickle', 'opencode/glm-5.3-flash-free'], 'only the free ones');
    assert.ok(c.every((x: any) => x.engine === 'cli' && x.tools === 'tools'));
    assert.equal(c.find((x: any) => x.model === 'opencode/glm-5.3-flash-free').privacy.label, 'bewaart niets');
    assert.equal(c.find((x: any) => x.model === 'opencode/big-pickle').privacy.label, 'kan trainen');
    assert.equal(await t.svc.probe(t.app.ctx.providers.config(p.id)!, 'opencode/big-pickle'), false, 'never a probe on OpenCode');
    // A limit the runner saw on OpenCode (reported by the free chain): the CLI waits, the order says so.
    t.app.ctx.services.freeModels.report(p.id, { limit: true, resetAt: Date.now() + 3_600_000, message: 'free usage limit' });
    assert.ok(t.app.ctx.services.freeModels.candidates().every((x: any) => !x.available && x.availableAt > Date.now()));
  } finally {
    await t.close();
  }
});

test('card: OpenCode and Ollama are always listed, with Aanzetten when here and Installeren when not; on and off work in one click', async () => {
  const t = await app();
  try {
    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!.id;
    // A stand-in OpenCode CLI (the cli-agents module is not loaded here): free models from its own list, never probed.
    ctx.providers.registerKind({
      id: 'opencode',
      label: 'OpenCode',
      type: 'cli',
      needsKey: false,
      description: 'test',
      create: () => ({
        kind: 'opencode',
        async listModels() {
          return [
            { id: 'opencode/big-pickle', billing: 'free' as const, tools: true },
            { id: 'anthropic/claude-sonnet-5-5', tools: true },
          ];
        },
        async test() {
          return { ok: true, detail: '' };
        },
        async runAgent() {
          throw new Error('not in this test');
        },
      }),
    });
    // Ollama on "this computer" without touching the real one: detect and the model list are scripted.
    let ollamaHere = false;
    const ollama = ctx.providers.kind('ollama')!;
    ctx.providers.registerKind({ ...ollama, detect: async () => ({ installed: ollamaHere }), create: () => ({ kind: 'ollama', listModels: async () => [{ id: 'qwen3:4b', tools: true }], test: async () => ({ ok: true, detail: '' }), chat: async () => ({ text: '', toolCalls: [] }) as any }) });
    // What cli-agents tells about OpenCode on this computer, and its "Verbinden" (connects on a free model).
    let cliHere: any = { installed: false };
    const connects: string[] = [];
    ctx.services['cli-agents'] = {
      status: async () => cliHere,
      connect: async (userId: string, id: string) => {
        connects.push(id);
        const p = ctx.providers.create(userId, { kind: id, config: { defaultModel: 'opencode/big-pickle' } });
        return { provider: ctx.providers.view(p, userId), created: true };
      },
    };
    const engine = (v: any, kind: string) => v.engines.find((x: any) => x.kind === kind);

    // Nothing connected: both are still there, OpenCode with a one-click install, Ollama with steps.
    let v = await t.api('GET', '/free-models');
    assert.deepEqual(v.engines.map((x: any) => x.kind), ['opencode', 'ollama'], 'OpenCode first, then Ollama; nothing hidden');
    assert.deepEqual([engine(v, 'opencode').configured, engine(v, 'opencode').on], [false, false]);
    assert.deepEqual(engine(v, 'opencode').setup, { installed: false, canInstall: true });
    assert.equal(engine(v, 'ollama').setup.installed, false);
    assert.ok(engine(v, 'ollama').setup.steps.some((x: string) => /ollama pull/.test(x)), 'clear steps for Ollama');
    assert.equal(engine(v, 'opencode').limitNote.length > 0, true, 'says what it is');
    await assert.rejects(t.api('PUT', '/free-models/sources/ollama', { on: true }), /draait niet op deze computer/);

    // OpenCode only inside another app (OpenBot): still "Installeren" (TeamBot's own copy), and the card says why.
    cliHere = { installed: true, pathSource: 'andere-app', pathApp: 'OpenBot' };
    v = await t.api('GET', '/free-models');
    assert.deepEqual([engine(v, 'opencode').setup.installed, engine(v, 'opencode').setup.canInstall, engine(v, 'opencode').setup.otherApp], [false, true, 'OpenBot']);

    // Installed: Aanzetten connects it on a free model and puts it in the chain.
    cliHere = { installed: true, pathSource: 'teambot' };
    v = await t.api('GET', '/free-models');
    assert.equal(engine(v, 'opencode').setup.installed, true);
    v = await t.api('PUT', '/free-models/sources/opencode', { on: true, apiKey: 'sk-never-stored-for-a-cli' });
    assert.deepEqual(connects, ['opencode']);
    assert.deepEqual([engine(v, 'opencode').configured, engine(v, 'opencode').on, engine(v, 'opencode').setup], [true, true, null]);
    assert.equal(engine(v, 'opencode').hasKey, false, 'a CLI never gets a key through this card');
    assert.deepEqual(engine(v, 'opencode').models.map((m: any) => m.id), ['opencode/big-pickle'], 'only the free model');
    assert.ok(ctx.services.freeModels.candidates().some((c: any) => c.providerKind === 'opencode' && c.model === 'opencode/big-pickle'));

    // Uitzetten: out of the chain, still on the card (Aanzetten again), the connection stays; Aanzetten brings it back.
    v = await t.api('PUT', '/free-models/sources/opencode', { on: false });
    assert.deepEqual([engine(v, 'opencode').configured, engine(v, 'opencode').on], [true, false]);
    assert.ok(!ctx.services.freeModels.candidates().some((c: any) => c.providerKind === 'opencode'));
    v = await t.api('PUT', '/free-models/sources/opencode', { on: true });
    assert.equal(engine(v, 'opencode').on, true);
    assert.deepEqual(connects, ['opencode'], 'the existing connection is reused, not made twice');

    // A connection that was switched off at AI-diensten: Aanzetten switches the connection itself on again.
    const oc = cfgOf(t, 'opencode');
    ctx.providers.updateConfig(oc.id, owner, { enabled: false });
    v = await t.api('GET', '/free-models');
    assert.deepEqual([engine(v, 'opencode').configured, engine(v, 'opencode').on], [true, false]);
    v = await t.api('PUT', '/free-models/sources/opencode', { on: true });
    assert.equal(engine(v, 'opencode').on, true);
    assert.equal(ctx.providers.config(oc.id)!.enabled, true);

    // Ollama running: Aanzetten connects it; its models come in as local candidates.
    ollamaHere = true;
    v = await t.api('GET', '/free-models');
    assert.equal(engine(v, 'ollama').setup.installed, true);
    v = await t.api('PUT', '/free-models/sources/ollama', { on: true });
    assert.deepEqual([engine(v, 'ollama').configured, engine(v, 'ollama').on], [true, true]);
    assert.ok(ctx.services.freeModels.candidates().some((c: any) => c.providerKind === 'ollama' && c.engine === 'local' && c.model === 'qwen3:4b'));

    // An unknown or paid kind cannot be switched on through this card.
    await assert.rejects(t.api('PUT', '/free-models/sources/mock', { on: true }), /Onbekende gratis bron/);
  } finally {
    await t.close();
  }
});

test('runner: a "successful" answer that is an error makes the bot switch to its reserve, without showing the error text', async () => {
  const srv = await serve([
    { path: '/kilo/api/v1/models', body: recorded('kilo-models'), repeat: true },
    { method: 'POST', path: '/kilo/api/v1/chat/completions', sse: textSSE('Error: not enough credits. Please upgrade your plan to use this model.', 'liquid/lfm-3-1.7b:free') },
  ]);
  const restore = shim(srv.url);
  const t = await app();
  try {
    await t.api('PUT', '/free-models/sources/kilo', { on: true });
    const kilo = cfgOf(t, 'kilo');
    const a = await t.agent({ provider_id: kilo.id, model: 'liquid/lfm-3-1.7b:free', settings: { fallbacks: [{ provider_id: t.providerId, model: 'mock-1' }] } });
    t.script.push({ text: 'Antwoord van de reserve' });
    const thread = await t.api('POST', '/threads', { agentId: a.id });
    const msgs = await t.say(thread.id, 'Hallo');
    const visible = msgs.filter((m: any) => !m.deleted);
    assert.ok(visible.some((m: any) => m.role === 'assistant' && m.content === 'Antwoord van de reserve'), 'the reserve answered');
    assert.ok(visible.some((m: any) => /Overgeschakeld naar reserve/.test(m.content || '')), 'the switch is said in the chat');
    assert.ok(!visible.some((m: any) => /not enough credits/i.test(m.content || '')), 'the error text was never shown as an answer');
    const kv = (await t.api('GET', '/free-models')).sources.find((x: any) => x.kind === 'kilo');
    assert.equal(kv.status, 'limited', 'the tracker counts it as a limit of that source');
  } finally {
    await t.close();
    restore();
    await srv.close();
  }
});

test('settings card API: a key is needed where the provider needs one, the Cloudflare account is checked, keys never come back', async () => {
  const srv = await serve([
    { path: `/cf/client/v4/accounts/${ACCOUNT}/ai/models/search`, body: { success: true, result: [{ name: '@cf/openai/gpt-oss-120b', properties: [{ property_id: 'context_window', value: '128000' }, { property_id: 'function_calling', value: 'true' }] }, { name: '@cf/zai-org/glm-5.3', properties: [] }] }, repeat: true },
  ]);
  const restore = shim(srv.url);
  const t = await app();
  try {
    await assert.rejects(t.api('PUT', '/free-models/sources/groq', { on: true }), /Vul eerst je sleutel van Groq in/);
    await assert.rejects(t.api('PUT', '/free-models/sources/cloudflare', { apiKey: 'cf-token', accountId: 'nee' }), /32 tekens/);
    await assert.rejects(t.api('PUT', '/free-models/sources/cloudflare', { apiKey: 'cf-token' }), /Account-ID/);
    await assert.rejects(t.api('PUT', '/free-models/sources/google', { on: true }), /Onbekende gratis bron/);
    const v = await t.api('PUT', '/free-models/sources/cloudflare', { apiKey: 'cf-token', accountId: ACCOUNT, on: true });
    const cf = v.sources.find((x: any) => x.kind === 'cloudflare');
    assert.equal(cf.on, true);
    assert.equal(cf.hasKey, true);
    assert.deepEqual(cf.models.map((m: any) => m.id), ['@cf/openai/gpt-oss-120b'], 'models that need Workers Paid are left out');
    assert.equal(cf.privacy.label, 'bewaart niets');
    assert.match(cf.signupUrl, /^https:\/\/dash\.cloudflare\.com/);
    assert.ok(!JSON.stringify(v).includes('cf-token'));
    const off = await t.api('GET', '/free-models');
    assert.deepEqual(off.sources.map((x: any) => x.kind), ['groq', 'openrouter', 'cloudflare', 'zai', 'kilo']);
    assert.ok(off.sources.filter((x: any) => x.kind !== 'cloudflare').every((x: any) => x.status === 'off' && !x.on), 'everything that leaves the pc is off until you switch it on');
  } finally {
    await t.close();
    restore();
    await srv.close();
  }
});
