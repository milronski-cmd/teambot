import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { clampEffort, claudeInfo, reasoningLevels, withCapabilities } from '../server/providers/capabilities.js';
import { decorateModels } from '../server/api/providers.js';
import { estimateCost } from '../server/providers/pricing.js';
import { openaiResponses } from '../server/providers/openai-responses.js';
import { chosenContext, ensureLmstudioContext, kvBytesPerToken, ollamaThink } from '../server/providers/localmodels.js';
import { codexEfforts } from '../server/modules/cli-agents/codex.js';
import { registerAttachment } from '../server/tools/builtin/files.js';
import { startTestApp } from './helpers.js';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents-fake-claude.mjs');

async function server(handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void) {
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => handler(req, b ? JSON.parse(b) : null, res));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => s.close(() => r())) };
}

test('Claude levels per model (C-11): xhigh/max where the model has them, none for models without effort', () => {
  assert.deepEqual(claudeInfo('claude-opus-5-5')!.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(claudeInfo('opus')!.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max'], 'Claude Code alias → its current model');
  assert.deepEqual(claudeInfo('claude-sonnet-4-6')!.reasoningLevels, ['low', 'medium', 'high', 'max'], 'no xhigh before Opus 4.7');
  assert.deepEqual(claudeInfo('claude-haiku-4-5')!.reasoningLevels, [], 'Haiku 4.5 takes no effort');
  assert.equal(claudeInfo('claude-haiku-4-5')!.context, 200_000);
  assert.equal(claudeInfo('sonnet[1m]')!.context, 1_000_000);
  assert.equal(claudeInfo('us.anthropic.claude-opus-5-5-v1:0')!.defaultReasoning, 'medium');
  assert.equal(clampEffort(claudeInfo('claude-opus-4-6')!.reasoningLevels, 'xhigh'), 'high', 'a level the model lacks drops to the next lower one');
  assert.equal(clampEffort([], 'high'), undefined);
  assert.equal(clampEffort(undefined, 'high'), 'high', 'unknown model: unchanged');
  // Codex: the efforts its own model/list reports.
  assert.deepEqual(codexEfforts({ supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, 'high', 'xhigh', 'turbo'] }), ['low', 'medium', 'high', 'xhigh']);
});

test('model facts (C-01): tools, vision, context and levels from the dated table, "onbekend" stays unknown', () => {
  const k = { id: 'openai', reasoningStyle: 'effort', label: 'OpenAI', type: 'api' } as any;
  const [luna, old, other] = decorateModels(k, [{ id: 'gpt-6-luna' }, { id: 'gpt-4.1-mini' }, { id: 'raar-model' }]);
  assert.deepEqual(luna.reasoningLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'the levels on its own model page');
  assert.equal(luna.priceSource, 'catalogus', 'price from the models.dev catalogue (the hand table only keeps overrides)');
  assert.ok(luna.priceChecked);
  assert.deepEqual(old.reasoningLevels, [], 'the 4-series does not reason: no levels shown');
  assert.equal(other.reasoningLevels, undefined, 'unknown model: levels unknown');
  assert.equal(other.context, undefined);
  assert.equal(other.price, undefined);
  const a = withCapabilities('anthropic', null, { id: 'claude-opus-5-5' });
  assert.equal(a.context, 1_000_000);
  assert.equal(a.vision, true);
  assert.match(a.capSource!, /claude\.com/);
  // A provider without a reasoning parameter never shows levels.
  assert.deepEqual(reasoningLevels('groq-nothing', null, { id: 'x' }), []);
});

// Acceptance round 4 (C-01): all 47 models of a real OpenAI key showed "onbekend" for tools, images and context.
test('OpenAI API models (C-01): context, images, tools, levels and price from their own pages (checked 2026-11-07)', async () => {
  const k = { id: 'openai', reasoningStyle: 'effort', label: 'OpenAI', type: 'api' } as any;
  const ids = ['gpt-6.1-terra', 'gpt-5.4-mini', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini', 'gpt-4.1-2025-04-14', 'gpt-4o-mini', 'chatgpt-4o-latest', 'gpt-onbekend'];
  const m = Object.fromEntries(decorateModels(k, ids.map((id) => ({ id }))).map((x) => [x.id, x]));
  assert.equal(m['gpt-6.1-terra'].context, 1_050_000);
  assert.equal(m['gpt-6.1-terra'].vision, true);
  assert.equal(m['gpt-6.1-terra'].tools, true);
  assert.equal(m['gpt-6.1-terra'].defaultReasoning, 'medium');
  assert.equal(m['gpt-6.1-terra'].capSource, 'https://developers.openai.com/api/docs/models/gpt-6.1-terra');
  assert.equal(m['gpt-6.1-terra'].capChecked, '2026-11-07');
  assert.deepEqual(m['gpt-5.4-mini'].reasoningLevels, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(m['gpt-5.4-mini'].context, 400_000);
  assert.deepEqual(m['gpt-5'].reasoningLevels, ['minimal', 'low', 'medium', 'high']);
  assert.equal(m['gpt-5-mini'].context, 400_000, 'facts on its page');
  assert.deepEqual(m['gpt-5-mini'].reasoningLevels, ['minimal', 'low', 'medium', 'high'], 'its page lists no effort values: the ones models.dev lists (0.4.4; before: the family rule)');
  assert.equal(m['o3'].vision, true);
  assert.equal(m['o3-mini'].vision, false, 'text only');
  assert.equal(m['gpt-4.1-2025-04-14'].context, 1_047_576, 'a dated snapshot has the facts of its model');
  assert.equal(m['gpt-4o-mini'].context, 128_000);
  assert.equal(m['chatgpt-4o-latest'].tools, false);
  assert.deepEqual(m['gpt-4o-mini'].price, [0.15, 0.6]);
  assert.equal(m['gpt-onbekend'].context, undefined, 'not on a page: stays "onbekend"');
  assert.equal(m['gpt-onbekend'].tools, undefined);
  assert.equal(m['gpt-onbekend'].price, undefined);
  // Cached input as OpenAI bills it (gpt-4o: half the input price, not the default 10 %).
  assert.equal(estimateCost('openai', 'gpt-4o', 1_000_000, 0, 1_000_000), 1.25);
  // Another engine that lists the same name (Azure deployment, OpenRouter …) does not get OpenAI's facts.
  assert.equal(withCapabilities('azure', 'effort', { id: 'gpt-6.1-terra' }).context, undefined);

  // The Responses route sends xhigh and max where the model's page lists them, and high elsewhere.
  const bodies: any[] = [];
  const srv = await server((req, body, res) => {
    bodies.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
  });
  try {
    const ad = openaiResponses({ label: 'OpenAI', baseUrl: srv.url, key: 'sk-test', fallback: {} as any });
    for (const [model, reasoning] of [['gpt-6.1-terra', 'max'], ['gpt-5.4-mini', 'xhigh'], ['gpt-5.4-mini', 'max'], ['gpt-4o', 'xhigh']] as const) {
      await ad.chat!({ model, system: '', messages: [{ role: 'user', content: 'hoi' }], tools: [], reasoning }, new AbortController().signal, () => {});
    }
    assert.deepEqual(bodies.map((b) => b.reasoning?.effort), ['max', 'xhigh', 'high', 'high']);
  } finally {
    await srv.close();
  }
});

test('Ollama (C-01, C-11, C-13): abilities from Ollama, num_ctx and think per chat, cancel stops the stream', async () => {
  const chats: any[] = [];
  const compat: any[] = [];
  const info = { 'general.architecture': 'llama', 'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096, 'llama.context_length': 131072 };
  const srv = await server((req, body, res) => {
    const send = (o: any) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    if (req.url === '/api/version') return send({ version: '0.40.15' });
    if (req.url === '/api/tags')
      return send({
        models: [
          { name: 'denker:latest', digest: 'a', details: { parameter_size: '8B', quantization_level: 'Q4_K_M', context_length: 131072 }, capabilities: ['completion', 'tools', 'thinking'] },
          { name: 'kijker:latest', digest: 'b', details: { context_length: 8192 }, capabilities: ['completion', 'vision'] },
          { name: 'embed:latest', digest: 'c', details: {}, capabilities: ['embedding'] },
        ],
      });
    if (req.url === '/api/ps') return send({ models: [{ name: 'denker:latest', context_length: 16384 }] });
    if (req.url === '/api/show') return send({ model_info: body.model === 'denker:latest' ? info : {}, capabilities: [] });
    if (req.url === '/v1/models') return send({ data: [{ id: 'denker:latest' }] });
    if (req.url === '/v1/chat/completions') {
      compat.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Via de OpenAI-laag.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (req.url === '/api/chat') {
      chats.push(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (/traag/.test(JSON.stringify(body.messages))) {
        res.write(JSON.stringify({ message: { content: 'Ik begin…' }, done: false }) + '\n');
        return; // never finishes: the caller has to cancel
      }
      if (body.tools?.length && !body.messages.some((m: any) => m.role === 'tool')) {
        res.write(JSON.stringify({ message: { thinking: 'even kijken' }, done: false }) + '\n');
        res.write(JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'memory_remember', arguments: { content: 'blauw' } } }] }, done: false }) + '\n');
      } else res.write(JSON.stringify({ message: { content: 'Klaar.' }, done: false }) + '\n');
      return res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 120, eval_count: 7 }) + '\n');
    }
    res.writeHead(404);
    res.end('{}');
  });
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: 'ollama', base_url: srv.url + '/v1' });
    const models = await t.api('GET', `/providers/${p.id}/models`);
    assert.deepEqual(models.map((m: any) => m.id), ['denker:latest', 'kijker:latest'], 'embedding-only models are not offered for chat');
    const [denker, kijker] = models;
    assert.equal(denker.tools, true);
    assert.equal(denker.vision, false);
    assert.equal(denker.context, 131072);
    assert.deepEqual(denker.reasoningLevels, ['none', 'on'], 'a thinking model: on/off');
    assert.equal(denker.loadedContext, 16384, 'what Ollama loaded it with now');
    assert.equal(denker.memPerToken, kvBytesPerToken(info));
    assert.equal(denker.memPerToken, 32 * 8 * 256 * 2, 'layers × kv-heads × (k+v) × 2 bytes');
    assert.equal(denker.free, true);
    assert.deepEqual(kijker.reasoningLevels, [], 'no thinking: no levels');
    assert.equal(kijker.vision, true);

    // Context window per model: saved on the provider, sent as num_ctx; thinking off with "none".
    assert.equal((await t.api('PUT', `/providers/${p.id}/context-window`, { model: 'denker:latest', tokens: 32768 })).tokens, 32768);
    await assert.rejects(t.api('PUT', `/providers/${p.id}/context-window`, { model: 'denker:latest', tokens: 12 }), /Ongeldig contextvenster/);
    await assert.rejects(t.api('PUT', `/providers/${t.providerId}/context-window`, { model: 'mock-1', tokens: 8192 }), /alleen in voor Ollama en LM Studio/);
    assert.equal(chosenContext(t.app.ctx.providers.config(p.id)!.config, 'denker:latest'), 32768);
    const a = await t.api('POST', '/agents', { name: 'Lokaal', provider_id: p.id, model: 'denker:latest', reasoning: 'none', access_mode: 'auto', tool_groups: ['memory'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'onthoud: mijn kleur is blauw');
    assert.equal(chats[0].options.num_ctx, 32768);
    assert.equal(chats[0].think, false);
    assert.ok(chats[0].tools.some((x: any) => x.function.name === 'memory_search') && chats[0].tools.some((x: any) => x.function.name === 'tools_call'), 'tools go to Ollama natively');
    const msgs = t.app.ctx.store.messages(th.id);
    assert.ok(msgs.some((m) => m.role === 'tool' && m.parts.toolResult?.name === 'memory_remember'), 'the tool call ran');
    assert.equal(msgs.filter((m) => m.role === 'assistant').at(-1)!.content, 'Klaar.');
    assert.equal(msgs.filter((m) => m.role === 'assistant')[0].usage?.input, 120);
    // A model without thinking never gets "think" (Ollama would refuse it). With "Vanzelf" (no window chosen) the chat
    // still goes natively, with a window that fits the bot: Ollama's own default (4K) would cut TeamBot's
    // instructions (acceptance 12 Nov: "Het model gaf geen antwoord").
    await t.api('PUT', `/providers/${p.id}/context-window`, { model: 'denker:latest', tokens: null });
    await t.api('PATCH', `/agents/${a.id}`, { model: 'kijker:latest', reasoning: 'high' });
    const nativeBefore = chats.length;
    const compatBefore = compat.length;
    await t.say(th.id, 'hoi');
    assert.equal(chats.length, nativeBefore + 1, 'the native chat, with a window');
    assert.equal(compat.length, compatBefore, "not Ollama's OpenAI layer, which cannot carry a window");
    assert.equal(chats.at(-1).model, 'kijker:latest');
    assert.equal(chats.at(-1).options.num_ctx, 16384);
    assert.equal(chats.at(-1).think, undefined);
    assert.equal(t.app.ctx.store.messages(th.id).filter((m) => m.role === 'assistant').at(-1)!.content, 'Klaar.');
    assert.equal(ollamaThink('high', ['low', 'medium', 'high']), 'high');
    assert.equal(ollamaThink('max', ['low', 'medium', 'high']), 'high');
    assert.equal(ollamaThink('medium', ['none', 'on']), true);

    // Cancel during a slow answer on the native path: the run stops and the stream is closed.
    await t.api('PATCH', `/agents/${a.id}`, { model: 'denker:latest', reasoning: 'none' });
    const before = chats.length;
    const th2 = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', `/threads/${th2.id}/messages`, { content: 'traag antwoord graag' });
    const start = Date.now();
    while (chats.length === before) {
      if (Date.now() - start > 5000) throw new Error('geen antwoord gestart');
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 300)); // the first words have arrived
    await t.api('POST', `/threads/${th2.id}/stop`);
    await t.waitIdle(th2.id);
    const last = t.app.ctx.store.messages(th2.id).filter((m) => m.role === 'assistant').at(-1)!;
    assert.equal(chats.length, before + 1, 'the slow answer came from the native chat');
    assert.equal(last.status, 'cancelled');
    assert.match(last.content, /Ik begin/, 'what was streamed before the stop stays');
  } finally {
    await t.close();
    await srv.close();
  }
});

// 12 nov: an image sent to a local model that cannot look at images was refused as a whole ("Multimodal data
// provided…"), and the turn died. Such a model gets the text on the image (OCR) or a note that there is an image.
test('an image for a model that cannot look at images: its text instead, and the turn works; a model that can gets the image', async () => {
  const chats: any[] = [];
  const caps: Record<string, string[]> = { 'tekst:latest': ['completion', 'tools'], 'kijker:latest': ['completion', 'tools', 'vision'] };
  const srv = await server((req, body, res) => {
    const send = (o: any, status = 200) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    if (req.url === '/api/version') return send({ version: '0.40.15' });
    if (req.url === '/api/tags') return send({ models: Object.entries(caps).map(([name, c], i) => ({ name, digest: String(i), details: { context_length: 32768 }, capabilities: c })) });
    if (req.url === '/api/ps') return send({ models: [] });
    if (req.url === '/api/show') return send({ model_info: {}, capabilities: caps[body?.model] || [] });
    if (req.url === '/api/chat') {
      chats.push(body);
      // As Ollama does: a model without vision refuses any image in the request.
      if (!caps[body.model]?.includes('vision') && body.messages.some((m: any) => m.images?.length)) return send({ error: 'Multimodal data provided, but model does not support multimodal requests' }, 500);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'Klaar.' }, done: false }) + '\n');
      return res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 2 }) + '\n');
    }
    res.writeHead(404);
    res.end('{}');
  });
  const t = await startTestApp();
  const dir = fs.mkdtempSync(path.join(t.dir, 'beeld-'));
  try {
    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!;
    // The text recognition on this computer (modules/folders/ocr.ts), without its language data from the internet.
    const read: number[] = [];
    let ocrReady = true;
    ctx.services.ocr = {
      ensure: async () => ocrReady,
      problem: () => 'De taaldata kon nu niet worden opgehaald.',
      recognize: async (b: Buffer) => (read.push(b.length), 'Factuur 2026-118\nTotaal: 249,95 euro'),
    };
    const p = await t.api('POST', '/providers', { kind: 'ollama', base_url: srv.url + '/v1' });
    const a = await t.api('POST', '/agents', { name: 'Lezer', provider_id: p.id, model: 'tekst:latest', access_mode: 'auto', tool_groups: ['memory'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const image = (name: string, head: string) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, Buffer.concat([Buffer.from(head, 'hex'), Buffer.alloc(300)]));
      return registerAttachment(ctx, owner.id, th.id, f, name).id;
    };
    const turn = async (content: string, attachments: string[] = []) => {
      const from = chats.length;
      await t.api('POST', `/threads/${th.id}/messages`, { content, attachments });
      await t.waitIdle(th.id, 15_000);
      const answer = ctx.store.messages(th.id).filter((m) => m.role === 'assistant').at(-1)!;
      const sent = chats.slice(from);
      const asked = sent.at(-1)?.messages.filter((m: any) => m.role === 'user').at(-1);
      return { answer, sent, asked };
    };

    // A text-only model: no image in any call, the text on it in the message, and the turn finishes.
    const one = await turn('Wat is het totaal op deze factuur?', [image('factuur.png', '89504e470d0a1a0a')]);
    assert.equal(one.answer.status, 'done', String(one.answer.parts?.error || ''));
    assert.equal(one.answer.content, 'Klaar.');
    assert.deepEqual(one.sent.map((c) => c.model), ['tekst:latest'], 'one call, not a refused one first');
    assert.ok(!one.sent.some((c) => c.messages.some((m: any) => m.images?.length)), 'no image sent to a model without vision');
    assert.match(one.asked.content, /<bijlage naam="factuur\.png" pad="[^"]+" soort="afbeelding; dit is de tekst erop, gelezen met tekstherkenning[^"]*">\nFactuur 2026-118\nTotaal: 249,95 euro\n<\/bijlage>/);
    assert.equal(read.length, 1);

    // Read once: the next turn has the text in its history without reading the image again.
    const two = await turn('En het factuurnummer?');
    assert.equal(two.answer.status, 'done');
    assert.match(JSON.stringify(two.sent.at(-1).messages), /Totaal: 249,95 euro/);
    assert.equal(read.length, 1, 'not read again');

    // Text recognition not available now (no internet for its language data): a note, never a dead end.
    ocrReady = false;
    const three = await turn('Wat zie je hierop?', [image('foto.jpg', 'ffd8ffe0')]);
    assert.equal(three.answer.status, 'done', String(three.answer.parts?.error || ''));
    assert.ok(!three.sent.some((c) => c.messages.some((m: any) => m.images?.length)));
    assert.match(three.asked.content, /\[bijlage: foto\.jpg \(image\/jpeg, 0 kB\) — een afbeelding, staat in je werkmap als [^\]]+\. Je kunt het beeld niet bekijken; staat er tekst op, lees die met read_document\./);
    assert.equal(read.length, 1);

    // A model that can look at images gets the image itself (and nothing is read for it).
    ocrReady = true;
    await t.api('PATCH', `/agents/${a.id}`, { model: 'kijker:latest' });
    const four = await turn('En deze?', [image('kaart.png', '89504e470d0a1a0a')]);
    assert.equal(four.answer.status, 'done', String(four.answer.parts?.error || ''));
    assert.equal(four.asked.images?.length, 1, 'the image goes along');
    assert.match(four.asked.content, /\[afbeelding bijgevoegd: kaart\.png/);
    assert.equal(read.length, 1);
  } finally {
    await t.close();
    await srv.close();
  }
});

test('LM Studio (C-13): the model is (re)loaded with the chosen window; an old LM Studio gets a plain note', async () => {
  const loads: any[] = [];
  let canLoad = true;
  const srv = await server((req, body, res) => {
    const send = (code: number, o: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    if (req.url === '/api/v0/models') return send(200, { data: [{ id: 'qwen', type: 'llm', state: 'loaded', max_context_length: 32768, loaded_context_length: 4096, capabilities: ['tool_use'] }] });
    if (req.url === '/api/v1/models/load') {
      loads.push(body);
      return canLoad ? send(200, { instance_id: 'qwen' }) : send(404, { error: 'not found' });
    }
    send(404, {});
  });
  try {
    assert.equal(await ensureLmstudioContext(srv.url + '/v1', 'qwen', 16384), undefined);
    assert.deepEqual(loads[0], { model: 'qwen', context_length: 16384 });
    assert.equal(await ensureLmstudioContext(srv.url + '/v1', 'qwen', 4096), undefined, 'already loaded like that');
    assert.equal(loads.length, 1);
    canLoad = false;
    assert.match((await ensureLmstudioContext(srv.url + '/v1', 'qwen', 8192))!, /Context Length.*8192/);
  } finally {
    await srv.close();
  }
});

test('Claude Code gets only a level its model has (xhigh → high on Opus 4.6), and the CLI hard time-out stops a slow run', async () => {
  const t = await startTestApp();
  const log = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = log;
  const argv = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.argv).at(-1).argv as string[];
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a = await t.api('POST', '/agents', { name: 'CC', provider_id: p.id, model: 'claude-opus-4-6', reasoning: 'xhigh', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'hallo');
    assert.equal(argv()[argv().indexOf('--effort') + 1], 'high');
    await t.api('PATCH', `/agents/${a.id}`, { model: 'opus', reasoning: 'max' });
    await t.say(th.id, 'nog eens');
    assert.equal(argv()[argv().indexOf('--effort') + 1], 'max');
    await t.api('PATCH', `/agents/${a.id}`, { model: 'claude-haiku-4-5', reasoning: 'high' });
    await t.say(th.id, 'kort');
    assert.ok(!argv().includes('--effort'), 'a model without effort gets no --effort');
    // Hard time-out (Max. duur) on a CLI that keeps going.
    await t.api('PATCH', `/agents/${a.id}`, { settings: { cli: { timeoutMin: 0.02 } } });
    await t.say(th.id, 'SCENARIO:hang', 15_000);
    const m = t.app.ctx.store.messages(th.id).filter((x) => x.role === 'assistant').at(-1)!;
    assert.equal(m.status, 'error');
    assert.match(m.parts.error!, /Time-out|langer dan/);
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});
