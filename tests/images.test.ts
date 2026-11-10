import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startTestApp } from './helpers.js';

/**
 * Afbeeldingen maken: the tool generate_image over the OpenAI images protocol, against a small local server that
 * answers like such a service (a real HTTP call, no real provider). The image lands in the bot's folder and in the
 * chat; without a service, with a refused key, past the daily maximum and with a link to a private address the bot
 * gets a plain sentence.
 */

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// Padding so the file is a believable size (the module refuses answers under 100 bytes).
const PNG_BIG = Buffer.concat([PNG, Buffer.alloc(200)]);

async function fakeService() {
  const seen: { url: string; auth: string; body: any }[] = [];
  let mode: 'b64' | 'url' | '401' = 'b64';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (code: number, body: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
      if (req.url === '/v1/models') return json(200, { data: [{ id: 'chat-large' }, { id: 'flux-schnell' }, { id: 'gpt-image-1' }] });
      if (req.url === '/v1/images/generations' && req.method === 'POST') {
        seen.push({ url: req.url, auth: String(req.headers.authorization || ''), body: JSON.parse(raw || '{}') });
        if (mode === '401') return json(401, { error: { message: 'Incorrect API key provided' } });
        if (mode === 'url') return json(200, { data: [{ url: 'http://127.0.0.1:9/private.png' }] });
        return json(200, { data: [{ b64_json: PNG_BIG.toString('base64') }] });
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  return { base: `http://127.0.0.1:${port}/v1`, seen, set: (m: typeof mode) => (mode = m), close: () => new Promise((r) => server.close(r)) };
}

test('generate_image: without an image service the bot hears what to connect', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const bot = await t.agent({ name: 'Ada' });
    const st = await t.api('GET', '/images/status');
    assert.deepEqual(st.sources, []);
    assert.equal(st.chosen, null);
    const thread = t.app.ctx.chat.threadForAgent(owner.id, bot.id);
    t.script.push({ toolCalls: [{ name: 'generate_image', args: { prompt: 'een rode fiets' } }] }, { text: 'Dat kan nog niet.' });
    const msgs = await t.say(thread.id, 'Maak een plaatje van een rode fiets');
    const result = JSON.stringify(t.requests.at(-1)!.messages);
    assert.match(result, /nog geen AI-dienst gekoppeld die afbeeldingen kan maken/);
    assert.equal(msgs.some((m: any) => m.parts?.attachments?.length), false);
    await assert.rejects(t.api('POST', '/images/test', {}), /nog geen AI-dienst/);
  } finally {
    await t.close();
  }
});

test('generate_image: a connected service makes the image; it lands in the folder and the chat; limits and errors are plain', async () => {
  const svc = await fakeService();
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const prov = await t.api('POST', '/providers', { kind: 'openai-compatible', name: 'Mijn beeldserver', base_url: svc.base, apiKey: 'sk-test-123' });
    const bot = await t.agent({ name: 'Ada' });

    // The service's own model list is offered (only the ones that make images); nothing is chosen for you without one.
    let st = await t.api('GET', '/images/status');
    assert.deepEqual(st.sources.map((s: any) => s.name), ['Mijn beeldserver']);
    assert.deepEqual(st.models, ['flux-schnell', 'gpt-image-1']);
    assert.equal(st.chosen.model, '');
    await assert.rejects(t.api('POST', '/images/test', {}), /Kies bij Instellingen/);
    await assert.rejects(t.api('PUT', '/images/settings', { provider: t.providerId }), /kan geen afbeeldingen maken/);
    st = await t.api('PUT', '/images/settings', { provider: prov.id, model: 'flux-schnell', dailyMax: 2 });
    assert.equal(st.chosen.model, 'flux-schnell');
    assert.equal(st.settings.dailyMax, 2);

    // The bot makes an image: the file is in its folder and attached to the chat.
    const thread = t.app.ctx.chat.threadForAgent(owner.id, bot.id);
    t.script.push({ toolCalls: [{ name: 'generate_image', args: { prompt: 'Een rode stadsfiets, productfoto', shape: 'landscape', name: 'Banner Winteractie!' } }] }, { text: 'Hier is de banner.' });
    const msgs = await t.say(thread.id, 'Maak een banner');
    assert.deepEqual(svc.seen[0].body, { model: 'flux-schnell', prompt: 'Een rode stadsfiets, productfoto', n: 1, size: '1536x1024', response_format: 'b64_json' });
    assert.equal(svc.seen[0].auth, 'Bearer sk-test-123');
    const att = msgs.flatMap((m: any) => m.parts?.attachments || []);
    assert.equal(att.length, 1);
    assert.match(att[0].name, /^banner-winteractie-\d{14}\.png$/);
    assert.equal(att[0].mime, 'image/png');
    const folder = path.join(t.app.ctx.store.agent(bot.id)!.workspace, 'afbeeldingen');
    const files = fs.readdirSync(folder);
    assert.equal(files.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(folder, files[0])), PNG_BIG);
    assert.match(JSON.stringify(t.requests.at(-1)!.messages), /Afbeelding gemaakt met Mijn beeldserver \(flux-schnell\)/);
    assert.equal(JSON.stringify(t.requests.at(-1)!.messages).includes('sk-test-123'), false, 'the key never reaches the model');

    // "Proefafbeelding" from the settings page counts too; the third one of the day is refused.
    const proof = await t.api('POST', '/images/test', {});
    assert.equal(proof.mime, 'image/png');
    assert.equal(Buffer.from(proof.data, 'base64').length, PNG_BIG.length);
    assert.equal((await t.api('GET', '/images/status')).madeToday, 2);
    await assert.rejects(t.api('POST', '/images/test', {}), /maximum van 2 afbeeldingen per dag/);
    assert.equal(svc.seen.length, 2, 'past the maximum the service is not called');

    // gpt-image models refuse response_format: it is left out for them.
    await t.api('PUT', '/images/settings', { model: 'gpt-image-1', dailyMax: 50 });
    await t.api('POST', '/images/test', { prompt: 'x' });
    assert.equal('response_format' in svc.seen.at(-1)!.body, false);

    // A refused key and a link to a private address: plain sentences, no image.
    svc.set('401');
    await assert.rejects(t.api('POST', '/images/test', {}), /de sleutel wordt geweigerd \(Incorrect API key provided\)/);
    svc.set('url');
    await assert.rejects(t.api('POST', '/images/test', {}), /niet mag of kan openen/);
    assert.equal((await t.api('GET', '/images/status')).madeToday, 3, 'a failed image does not count');
  } finally {
    await t.close();
    await svc.close();
  }
});
