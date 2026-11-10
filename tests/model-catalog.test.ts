// models.dev as the model catalogue (TeamBot 0.4.4): a trimmed, dated snapshot ships with TeamBot; context windows,
// prices and capabilities come from it after the provider's own live list; the hand tables keep only overrides; the
// optional daily refresh is off by default, never blocks and keeps working offline. No test reaches models.dev.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheFile, catalogInfo, catalogStatus, loadCachedCatalog, refreshCatalog, trimCatalog, useCatalog } from '../server/providers/models-dev.js';
import { clearListPrices, estimateCost, priceInfo, rememberListPrices } from '../server/providers/pricing.js';
import { withCapabilities } from '../server/providers/capabilities.js';
import { startTestApp } from './helpers.js';

/** A few entries in models.dev's own api.json shape. */
const API = {
  openai: { id: 'openai', models: { 'gpt-6-luna': { id: 'gpt-6-luna', tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }], modalities: { input: ['text', 'image'] }, limit: { context: 1_050_000, output: 128_000 }, cost: { input: 0.1, output: 0.5, cache_read: 0.01 } } } },
  deepseek: { id: 'deepseek', models: { 'deepseek-v4': { id: 'deepseek-v4', tool_call: true, reasoning: true, modalities: { input: ['text'] }, limit: { context: 256_000, output: 64_000 }, cost: { input: 0.3, output: 1.2 } } } },
  groq: { id: 'groq', models: { 'qwen/qwen3.8-27b': { id: 'qwen/qwen3.8-27b', tool_call: true, reasoning: true, modalities: { input: ['text'] }, limit: { context: 131_072 }, cost: { input: 0.29, output: 0.59 } } } },
  zai: { id: 'zai', models: { 'glm-5.3': { id: 'glm-5.3', tool_call: true, reasoning: true, reasoning_options: [{ type: 'toggle' }], limit: { context: 200_000 }, cost: { input: 1.4, output: 4.4, cache_read: 0.26 } } } },
  'amazon-bedrock': { id: 'amazon-bedrock', models: { 'anthropic.claude-opus-5-5-v1:0': { id: 'anthropic.claude-opus-5-5-v1:0', tool_call: true, limit: { context: 1_000_000 }, cost: { input: 4.4, output: 22 } } } },
  togetherai: { id: 'togetherai', models: { 'free/model': { id: 'free/model', tool_call: false, limit: { context: 8192 }, cost: { input: 0, output: 0 } } } },
  'not-mapped': { id: 'not-mapped', models: { x: { id: 'x', limit: { context: 1 } } } },
};

test('trim: only mapped providers and the facts TeamBot uses; 0/0 is never taken as "free"', () => {
  const c = trimCatalog(API, '2026-11-09');
  assert.equal(c.source, 'models.dev');
  assert.equal(c.fetched, '2026-11-09');
  assert.equal(c.providers['not-mapped'], undefined);
  assert.deepEqual(c.providers.openai['gpt-6-luna'], { c: 1_050_000, o: 128_000, p: [0.1, 0.5], cr: 0.01, t: true, v: true, r: true, e: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] });
  assert.deepEqual(c.providers.togetherai['free/model'], { c: 8192, t: false }, 'no price from 0/0');
});

test('the bundled snapshot is dated, covers the main providers and loads without network', () => {
  useCatalog();
  const s = catalogStatus();
  assert.match(s.fetched, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(s.origin, 'snapshot');
  assert.ok(s.providers >= 20 && s.models > 1000, `${s.providers} providers, ${s.models} models`);
  for (const [kind, model] of [['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-6-luna'], ['openrouter', 'openai/gpt-oss-120b'], ['groq', 'openai/gpt-oss-120b']]) assert.ok(catalogInfo(kind, model)?.c, `${kind} ${model}`);
  assert.equal(catalogInfo('ollama', 'qwen3:8b'), null, 'local servers are not in the catalogue');
});

test('prices: own → free → live list → override table → models.dev → onbekend; our free labels stay', () => {
  useCatalog(trimCatalog(API, '2026-11-09'));
  clearListPrices();
  try {
    const luna = priceInfo('openai', 'gpt-6-luna')!;
    assert.deepEqual([luna.price, luna.source, luna.checked, luna.cache], [[0.1, 0.5], 'catalogus', '2026-11-09', 0.01]);
    assert.equal(estimateCost('openai', 'gpt-6-luna', 1e6, 1e6, 1e6), 0.5 + 0.01, 'cache reads at the listed cache price');
    assert.equal(priceInfo('openai', 'gpt-6-luna-2026-10-01')!.source, 'catalogus', 'dated snapshot id');
    assert.equal(priceInfo('deepseek', 'deepseek-v4')!.cache, 0.3, 'no cache price listed: cached input is not cheaper');
    assert.deepEqual(priceInfo('bedrock', 'anthropic.claude-opus-5-5-v1:0')!.price, [4.4, 22], "Bedrock's own entry first");
    assert.deepEqual(priceInfo('bedrock', 'eu.anthropic.claude-sonnet-5-5')!, { price: [2, 10], source: 'tabel', checked: '2026-10-06', cache: 0.2 }, 'override where models.dev differs');
    assert.equal(priceInfo('vertex', 'claude-opus-5-5'), null, "not in this catalogue's Vertex nor Anthropic entries: onbekend");
    assert.equal(priceInfo('groq', 'qwen/qwen3.8-27b'), null, "Groq's free plan: the paid plan's price is not counted");
    assert.equal(priceInfo('together', 'free/model'), null, '0/0 in models.dev is not "free"');
    assert.equal(priceInfo('zai', 'glm-4.7-flash')!.source, 'gratis', 'our free models stay free');
    assert.equal(priceInfo('ollama', 'anything')!.source, 'gratis');
    assert.equal(priceInfo('openai', 'gpt-6-luna', { prices: { 'gpt-6-luna': [9, 9] } })!.source, 'eigen');
    rememberListPrices('deepseek', [{ id: 'deepseek-v4', price: [0.25, 1] }]);
    assert.equal(priceInfo('deepseek', 'deepseek-v4')!.source, 'lijst', "the provider's live list wins");
  } finally {
    clearListPrices();
    useCatalog();
  }
});

test('capabilities: what the engine says first, the Claude/OpenAI tables next, models.dev for the rest, dated', () => {
  useCatalog(trimCatalog(API, '2026-11-09'));
  try {
    const d = withCapabilities('deepseek', 'deepseek', { id: 'deepseek-v4' });
    assert.deepEqual([d.context, d.tools, d.vision, d.reasoning, d.capSource, d.capChecked], [256_000, true, false, true, 'models.dev', '2026-11-09']);
    assert.deepEqual(d.reasoningLevels, ['none', 'low', 'high', 'max'], 'reasoning known: the levels the request format carries');
    const own = withCapabilities('deepseek', 'deepseek', { id: 'deepseek-v4', context: 128_000, tools: false });
    assert.deepEqual([own.context, own.tools], [128_000, false], "the engine's own list is never overwritten");
    const z = withCapabilities('zai', 'zai', { id: 'glm-5.3' });
    assert.deepEqual(z.reasoningLevels, ['none', 'on']);
    const unknown = withCapabilities('deepseek', 'deepseek', { id: 'raar-model' });
    assert.equal(unknown.context, undefined, 'not in the catalogue: onbekend');
    assert.equal(unknown.capSource, undefined);
  } finally {
    useCatalog();
  }
});

test('refresh: downloads, trims and keeps a copy; a failure or no network keeps what there was', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-catalog-'));
  try {
    useCatalog();
    const before = catalogStatus().fetched;
    const offline = await refreshCatalog(dir, { fetch: (async () => { throw new TypeError('fetch failed'); }) as any });
    assert.equal(offline.ok, false);
    assert.equal(catalogStatus().fetched, before, 'offline: the snapshot stays');
    assert.match(catalogStatus().error!, /fetch failed/);
    const bad = await refreshCatalog(dir, { fetch: (async () => new Response('{"only": {}}')) as any });
    assert.equal(bad.ok, false, 'too little in it: not taken');
    const big = { ...API, anthropic: { models: { a: { id: 'a', limit: { context: 1 } } } }, google: { models: { g: { id: 'g', limit: { context: 2 } } } } };
    const ok = await refreshCatalog(dir, { fetch: (async () => new Response(JSON.stringify(big))) as any, now: new Date('2099-01-02T10:00:00Z') });
    assert.equal(ok.ok, true);
    assert.deepEqual([catalogStatus().fetched, catalogStatus().origin, catalogStatus().error], ['2099-01-02', 'refresh', null]);
    assert.ok(fs.existsSync(cacheFile(dir)));
    useCatalog();
    assert.equal(await loadCachedCatalog(dir), true, 'next start: the newer copy from the data folder');
    assert.equal(catalogStatus().fetched, '2099-01-02');
    useCatalog();
    fs.writeFileSync(cacheFile(dir), 'kapot');
    assert.equal(await loadCachedCatalog(dir), false, 'a broken copy is ignored');
    assert.equal(catalogStatus().origin, 'snapshot');
  } finally {
    useCatalog();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('module: status for everyone, the daily refresh off by default and only the owner turns it on', async () => {
  const t = await startTestApp();
  const realFetch = globalThis.fetch;
  try {
    const s = await t.api('GET', '/model-catalog');
    assert.equal(s.refresh, false, 'whatever leaves the pc is off until the owner turns it on');
    assert.equal(s.source, 'models.dev');
    assert.equal(s.canEdit, true);
    let asked = 0;
    globalThis.fetch = (async (url: any, init?: any) => (String(url).startsWith('https://models.dev/') ? (asked++, Promise.reject(new TypeError('offline'))) : realFetch(url, init))) as any;
    const on = await t.api('PUT', '/model-catalog', { refresh: true });
    assert.equal(on.refresh, true);
    const after = await t.api('POST', '/model-catalog/refresh');
    assert.ok(asked >= 1, 'the refresh goes to models.dev');
    assert.equal(after.origin, 'snapshot', 'offline: the snapshot stays in use');
    assert.match(after.error, /offline/);
    await assert.rejects(t.api('PUT', '/model-catalog', { refresh: 'ja' }));
  } finally {
    globalThis.fetch = realFetch;
    useCatalog();
    await t.close();
  }
});
