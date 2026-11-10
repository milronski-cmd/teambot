import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { startTestApp, type TestApp } from './helpers.js';
import { failureText, isFreeLimit } from '../server/agent/fallback.js';

/**
 * The free path (acceptance round 4: OpenCode's free tier sat at its daily limit all day; a new user without a
 * subscription was stuck at once). A local Ollama with a chat model becomes the reserve of bots made with
 * "Gratis starten"; a bot without a reserve gets a one-click switch on its failed answer; one notification per limit;
 * plain words, no model codes. Everything local: the fake OpenCode (ACP, 2.x) and a fake Ollama — never the Ollama
 * that may run on this computer.
 */

const FAKE_ACP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents-fake-acp.mjs');

async function fakeOllama(o: { models?: boolean } = {}) {
  const chats: any[] = [];
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      const send = (x: any) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
      if (req.url === '/api/version') return send({ version: '0.40.15' });
      if (req.url === '/api/tags')
        return send({
          models:
            o.models === false
              ? [{ name: 'nomic-embed-text:latest', digest: 'e', details: {}, capabilities: ['embedding'] }]
              : [
                  { name: 'nomic-embed-text:latest', digest: 'e', details: {}, capabilities: ['embedding'] },
                  // (sorted first, can use tools, but not loaded: the loaded qwen3:4b is the better reserve)
                  { name: 'llama3.2:3b', digest: 'l', details: { parameter_size: '3B', context_length: 131072 }, capabilities: ['completion', 'tools'] },
                  { name: 'qwen3:4b', digest: 'q', details: { parameter_size: '4B', context_length: 40960 }, capabilities: ['completion', 'tools'] },
                ],
        });
      if (req.url === '/api/ps') return send({ models: o.models === false ? [] : [{ name: 'qwen3:4b', context_length: 8192 }] });
      if (req.url === '/api/show') return send({ model_info: {}, capabilities: [] });
      if (req.url === '/v1/models') return send({ data: o.models === false ? [] : [{ id: 'qwen3:4b' }] });
      if (req.url === '/v1/chat/completions') {
        chats.push(body);
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

/** Local engines are found at the fake (Ollama) or nowhere (LM Studio …), never at this computer's own ports. */
function localAt(t: TestApp, ollamaUrl: string | null) {
  for (const k of t.app.ctx.providers.kinds.values()) {
    if (k.billing !== 'local' || !k.detect) continue;
    k.detect = async () => (k.id === 'ollama' && ollamaUrl ? { installed: true, baseUrl: ollamaUrl + '/v1', detail: 'test' } : { installed: false, detail: 'test' });
  }
}

const events = (t: TestApp, id: string) => t.app.ctx.store.messages(id).filter((m) => m.role === 'event').map((m) => m.content);
const answers = (t: TestApp, id: string) => t.app.ctx.store.messages(id).filter((m) => m.role === 'assistant');
const notes = (t: TestApp) => t.app.ctx.store.all<any>('SELECT kind, title, body, link FROM notifications ORDER BY created_at');

test('free limit texts: plain, the free limit as such, the engine and model in words', () => {
  const free = 'OpenCode gaf een fout: Internal error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.';
  assert.equal(isFreeLimit(free), true);
  assert.equal(isFreeLimit('Rate limit reached. Try again in 5 minutes.'), false);
  assert.equal(failureText({ engine: 'OpenCode (Big Pickle)', provider: 'OpenCode', kind: 'limit', error: free }), 'De gratis limiet van OpenCode is bereikt');
  assert.equal(failureText({ engine: 'Codex', provider: 'Codex', kind: 'limit', error: 'usage limit reached' }), 'Codex heeft zijn gebruikslimiet bereikt');
});

test('"Gratis starten" with Ollama on this computer: it becomes the reserve of new OpenCode bots, and takes over at the free limit with one notification', async () => {
  const ol = await fakeOllama();
  const t = await startTestApp();
  localAt(t, ol.url);
  try {
    await t.api('PUT', '/cli-agents/paths/opencode', { path: FAKE_ACP });
    const r = await t.api('POST', '/cli-agents/free-start', {});
    assert.equal(r.status, 'ready');
    assert.equal(r.model, 'opencode/big-pickle');
    assert.ok(r.reserve, 'a local reserve was set up');
    assert.equal(r.reserve.model, 'qwen3:4b', 'a chat model (not the embedding model), the one loaded right now');
    assert.equal(r.reserve.label, 'Ollama (lokaal) · qwen3:4b');
    const ollama = (await t.api('GET', '/providers')).find((p: any) => p.kind === 'ollama');
    assert.ok(ollama, 'Ollama was connected by "Gratis starten"');
    assert.equal(r.reserve.provider_id, ollama.id);
    // …with that model as its own, so "Maak een profiel" and new bots on Ollama use a model that is there (round 5).
    assert.equal(ollama.config.defaultModel, 'qwen3:4b');
    // "Maak een profiel" with Ollama chosen, while the default engine is another one with its own default model:
    // Ollama gets its own model, not the other engine's ("default" → "Model bestaat niet").
    await t.api('PUT', '/settings', { defaultProvider: r.provider.id, defaultModel: 'default' });
    const before = ol.chats.length;
    await t.api('POST', '/agents/generate', { description: 'Een bot die recepten voorstelt.', provider_id: ollama.id }).catch(() => null);
    assert.equal(ol.chats.length, before + 1);
    assert.equal(ol.chats.at(-1).model, 'qwen3:4b');

    // The new bot on OpenCode (the welcome screen makes it like this) gets Ollama as reserve engine.
    const a = await t.api('POST', '/agents', { name: 'Gratis', provider_id: r.provider.id, model: '', access_mode: 'ask' });
    assert.deepEqual(a.settings.fallbacks, [{ provider_id: ollama.id, model: 'qwen3:4b' }]);
    // A bot on another engine, or with its own reserves, is left as it is.
    assert.equal((await t.agent()).settings?.fallbacks, undefined);

    // OpenCode at its free limit: the reserve answers, said once and in words.
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'Wat is de hoofdstad van Italië? SCENARIO:freelimit', 30_000);
    assert.equal(answers(t, th.id).at(-1)!.content, 'Rome, van het lokale model.');
    // C-06: the OpenCode attempt with only "OpenCode-sessie gestart" leaves no empty "1 stap" block behind.
    assert.equal(answers(t, th.id).length, 1, JSON.stringify(answers(t, th.id).map((m) => m.parts.activity)));
    const ev = events(t, th.id);
    assert.ok(ev.includes('De gratis limiet van OpenCode is bereikt. Overgeschakeld naar reserve: Ollama (lokaal) · qwen3:4b.'), ev.join(' | '));
    assert.ok(!ev.some((e) => /opencode\/|big-pickle|:latest/.test(e)), 'no model codes: ' + ev.join(' | '));
    const n = notes(t);
    assert.equal(n.filter((x) => x.kind === 'limit').length, 1, JSON.stringify(n));
    assert.equal(n.find((x) => x.kind === 'limit').title, 'De gratis limiet van OpenCode is bereikt');
    assert.match(n.find((x) => x.kind === 'limit').body, /^Nog niet bekend wanneer het weer kan\. Bots met een reserve-engine gaan daarop verder\.$/);
    assert.equal(n.find((x) => x.kind === 'limit').link, `#/t/${th.id}`, 'opens the chat where it happened');
    assert.ok(!n.some((x) => /liep vast/.test(x.title)), 'no second notification');
  } finally {
    await t.close();
    await ol.close();
  }
});

test('a bot without a reserve at the free limit: one notification, and a one-click switch to the local model that answers and stays as reserve', async () => {
  const ol = await fakeOllama();
  const t = await startTestApp();
  localAt(t, ol.url);
  try {
    const oc = await t.api('POST', '/providers', { kind: 'opencode', config: { path: FAKE_ACP, defaultModel: 'opencode/big-pickle' } });
    const ollama = await t.api('POST', '/providers', { kind: 'ollama', base_url: ol.url + '/v1' });
    // "Maak een profiel" at the free limit: the error says it is a limit (code), so the page offers the local model.
    const res = await fetch(t.app.url + '/api/agents/generate', {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Een receptenbot. SCENARIO:freelimit', provider_id: oc.id }),
    });
    const body: any = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.code, 'limit');
    assert.match(body.error, /^Profiel maken mislukt: De gratis limiet van OpenCode is bereikt\./);
    // …and with that local model the profile is made (no other error gets the code).
    const before = ol.chats.length;
    await t.api('POST', '/agents/generate', { description: 'Een receptenbot.', provider_id: ollama.id }).catch(() => null);
    assert.equal(ol.chats.length, before + 1);
    const other: any = await (await fetch(t.app.url + '/api/agents/generate', { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ description: '', provider_id: oc.id }) })).json();
    assert.equal(other.code, undefined);

    // With the default chain on (package D2) the bot switches to the local model by itself (tests/engine-chain.test.ts);
    // the one-click offer is what the owner gets with the chain turned off, or when the chain has nothing left.
    await t.api('PUT', '/engine-chain/settings', { enabled: false });
    const a = await t.api('POST', '/agents', { name: 'Zonder reserve', provider_id: oc.id, model: '', access_mode: 'ask' });
    assert.equal(a.settings?.fallbacks, undefined, '"Gratis starten" was not used here: no reserve set up behind the owner\'s back');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'Hoofdstad van Italië? SCENARIO:freelimit', 30_000);
    const failed = answers(t, th.id).at(-1)!;
    assert.equal(failed.status, 'error');
    assert.match(failed.parts.error!, /^De gratis limiet van OpenCode is bereikt\./);
    assert.deepEqual(failed.parts.switchTo, [{ provider_id: ollama.id, model: 'qwen3:4b', label: 'Ollama (lokaal) · qwen3:4b', kind: 'local' }]);
    // Only "OpenCode-sessie gestart" happened: no "1 stap" block above the error (as with a reserve, C-06).
    assert.equal(failed.parts.activity, undefined, JSON.stringify(failed.parts.activity));
    const ev = events(t, th.id);
    const said = ev.find((e) => /^De gratis limiet van OpenCode is bereikt\. Nog niet bekend wanneer het weer kan\. Zonder reserve probeert het rond \d\d:\d\d automatisch opnieuw\.$/.test(e));
    assert.ok(said, ev.join(' | '));
    let n = notes(t);
    assert.equal(n.length, 1, 'one limit, one notification: ' + JSON.stringify(n));
    assert.equal(n[0].kind, 'limit');
    // The notification and the chat say the same: when is not known, and when the bot tries again.
    const retryLine = said!.match(/Zonder reserve probeert het rond \d\d:\d\d automatisch opnieuw\./)![0];
    assert.equal(n[0].body, `Nog niet bekend wanneer het weer kan. ${retryLine} Bots met een reserve-engine gaan daarop verder.`);

    // One click: the local model answers the same message now and becomes the bot's reserve.
    const sw = await t.api('POST', `/threads/${th.id}/switch-engine`, { agentId: a.id, providerId: ollama.id, model: 'qwen3:4b' });
    assert.ok(sw.run);
    await t.waitIdle(th.id, 20_000);
    assert.equal(answers(t, th.id).at(-1)!.content, 'Rome, van het lokale model.');
    assert.equal(ol.chats.length, before + 2, 'the profile above, then this answer');
    assert.deepEqual(t.app.ctx.store.agent(a.id)!.settings.fallbacks, [{ provider_id: ollama.id, model: 'qwen3:4b' }]);
    // The chat said it would retry by itself at the reset; after the switch it says that is no longer needed (Q-12).
    assert.ok(events(t, th.id).includes('Zonder reserve gaat verder met Ollama (lokaal) · qwen3:4b; dat is nu ook zijn reserve-engine. Automatisch opnieuw proberen is niet meer nodig.'), events(t, th.id).join(' | '));
    assert.equal(t.app.ctx.store.message(failed.id)!.parts.switchTo, undefined, 'the offer is gone once used');
    const waiting = t.app.ctx.store.run(failed.run_id!)!;
    assert.equal(waiting.meta?.limitRetried, true, 'the automatic retry for that message is dropped');
    n = notes(t);
    assert.equal(n.length, 1, 'still one notification: ' + JSON.stringify(n));

    // Next message: OpenCode is still at its limit, the new reserve answers by itself.
    await t.say(th.id, 'En van Frankrijk?', 30_000);
    assert.equal(answers(t, th.id).at(-1)!.content, 'Rome, van het lokale model.');
    assert.ok(events(t, th.id).some((e) => /zit nog tot ongeveer .* aan zijn gebruikslimiet; deze beurt draait op Ollama \(lokaal\) · qwen3:4b/.test(e)));
    assert.ok(!notes(t).some((x) => /liep vast/.test(x.title)));
  } finally {
    await t.close();
    await ol.close();
  }
});

test('no local model (none running, or Ollama without a chat model): no reserve, nothing remembered, no offer to switch to it', async () => {
  const ol = await fakeOllama({ models: false });
  const t = await startTestApp();
  localAt(t, null);
  try {
    // The CLI page shows "Ollama instellen" only while no local model is connected or runs here (C-7, round 5).
    assert.equal((await t.api('GET', '/cli-agents/status')).localModel, false);
    localAt(t, ol.url);
    assert.equal((await t.api('GET', '/cli-agents/status')).localModel, true, 'Ollama runs here, not connected yet');
    localAt(t, null);
    await t.api('PUT', '/cli-agents/paths/opencode', { path: FAKE_ACP });
    const r = await t.api('POST', '/cli-agents/free-start', {});
    assert.equal(r.status, 'ready');
    assert.equal(r.reserve, null);
    assert.equal(t.app.ctx.store.getSetting(t.app.ctx.auth.owner()!.id, 'freeReserve', 'x'), null);
    const a = await t.api('POST', '/agents', { name: 'Gratis', provider_id: r.provider.id, model: '', access_mode: 'ask' });
    assert.equal(a.settings?.fallbacks, undefined);
    // An Ollama with only an embedding model is no chat reserve either.
    localAt(t, ol.url);
    assert.equal((await t.api('POST', '/providers/free-reserve')).reserve, null);
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'SCENARIO:freelimit', 30_000);
    assert.equal(answers(t, th.id).at(-1)!.parts.switchTo, undefined, 'nothing to switch to');
  } finally {
    await t.close();
    await ol.close();
  }
});

test('welcome screen with only Ollama on this computer: "Koppelen en eerste bot maken" connects it with a chat model, so the first bot answers', async () => {
  const ol = await fakeOllama();
  const t = await startTestApp();
  // Only the fake Ollama is "on this computer": no CLI from PATH, no other local server.
  for (const k of t.app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => (k.id === 'ollama' ? { installed: true, baseUrl: ol.url + '/v1', detail: 'test' } : { installed: false, detail: 'test' });
  try {
    const { added } = await t.api('POST', '/providers/autodetect');
    const ollama = added.find((p: any) => p.kind === 'ollama');
    assert.ok(ollama, 'Ollama was connected');
    assert.equal(ollama.config.defaultModel, 'qwen3:4b', 'a chat model that is there (the loaded one), not the embedding model');
    // The welcome screen makes the first bot on that engine without a model of its own ("Standaard van de engine").
    const a = await t.api('POST', '/agents', { name: 'Assistent', provider_id: ollama.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'Wat is de hoofdstad van Italië?', 20_000);
    const last = answers(t, th.id).at(-1)!;
    assert.equal(last.status === 'error' ? last.parts.error : last.content, 'Rome, van het lokale model.');
    assert.equal(ol.chats.at(-1).model, 'qwen3:4b');
  } finally {
    await t.close();
    await ol.close();
  }
});
