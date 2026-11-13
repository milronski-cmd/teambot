/**
 * Re-tests of what was repaired after 0.3.0 but not tested again (STATUS "Nog na te lopen"):
 *  - sources from memory with local models: an answer by a local model (Ollama) that uses a memory without citing it
 *    still gets its source under the answer (A-42), now through the real Ollama adapter instead of the mock;
 *  - the notice when memory is full (A-46): learned with patterns, learned with a model, said explicitly, and the new
 *    "ja, doe maar" — never silently lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, startTestApp, type TestApp } from './helpers.js';
import { startFakeOllama } from './memory-fake-ollama.js';
import { setShortCallFake } from '../server/agent/short-call.js';

/** A free (local) learning engine; its answers come from setShortCallFake. */
async function freeEngine(t: TestApp) {
  t.app.ctx.providers.registerKind({ id: 'mock-local', label: 'Lokaal testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'test', models: ['lokaal-1'], defaultModel: 'lokaal-1', create: () => mockAdapter(t.script, t.requests) });
  return t.api('POST', '/providers', { kind: 'mock-local' });
}

const ctxOf = (m: any): string => m?.parts?.context ?? '';
const lastUser = (msgs: any[]) => msgs.filter((m) => m.role === 'user').at(-1);

test('a local model (Ollama) uses a memory without citing it: the source is still shown under its answer', async () => {
  const t = await startTestApp();
  const o = await startFakeOllama({ embedModels: [] });
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const p = t.app.ctx.providers.create(t.app.ctx.auth.owner()!.id, { kind: 'ollama', base_url: `${o.url}/v1` });
    const a = await t.api('POST', '/agents', { name: 'Lokaal', provider_id: p.id, model: 'qwen-test:latest', access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    o.chat.push('Genoteerd!', 'Genoteerd!');
    await t.say(th.id, 'Onthoud dat mijn hond Bram heet.', 20_000);
    await t.say(th.id, 'Onthoud dat mijn kat Mo heet.', 20_000);
    const all = (await t.api('GET', '/memory/items?scope=about_you')).items;
    const dog = all.find((i: any) => /Bram/.test(i.content));
    const cat = all.find((i: any) => /\bMo\b/.test(i.content));
    assert.ok(dog && cat, JSON.stringify(all.map((i: any) => i.content)));

    const th2 = await t.api('POST', '/threads', { agentId: a.id });
    o.chat.push('Je hond heet Bram.');
    const msgs = await t.say(th2.id, 'Hoe heet mijn hond?', 20_000);
    // The local model got the memory with its id in the request (Ollama's chat endpoint), and answered without it.
    const sent = JSON.stringify(o.chatRequests.at(-1).messages);
    assert.match(sent, new RegExp(`\\[m:${dog.ref}\\]`));
    const answer = msgs.filter((m: any) => m.role === 'assistant').at(-1);
    assert.equal(answer.content, 'Je hond heet Bram.');
    assert.equal(answer.parts?.providerId, p.id);
    const r = await t.api('GET', `/memory/thread/${th2.id}/answer-sources`);
    assert.deepEqual((r.byMessage[answer.id] || []).map((c: any) => c.id), [dog.id], 'the dog is the source; the cat (also in the context) is not');
  } finally {
    await o.close();
    await t.close();
  }
});

async function fill(t: TestApp, scope: 'about_you' | 'agent' | 'shared', agentId?: string) {
  await t.api('PUT', '/memory/settings', { quotas: { [scope]: { items: 10, bytes: 100_000 } } });
  for (let i = 0; i < 10; i++) await t.api('POST', '/memory/items', { content: `Vulregel ${i} met unieke inhoud ${i * 7919} ${scope}`, scope, agentId });
}

test('memory full: notes over their quota → said in the chat right there; a full dossier → what the review found goes to its archive, one notice per dossier per day', async () => {
  const t = await startTestApp();
  const notes: any[] = [];
  t.app.ctx.events.on('notification', (e: any) => notes.push(e.data));
  const full = () => notes.filter((n) => n?.title === 'Geheugen vol');
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const a = await t.agent();
    await fill(t, 'about_you');
    const th = await t.api('POST', '/threads', { agentId: a.id });

    // 1. Notes full, but the bot can still put it in the text of the owner's dossier: no "memory is full" for it (it
    //    would wrongly say nothing can be kept); nothing was dropped, so no notice either.
    t.script.push({ text: 'Leuk!' });
    const leiden = lastUser(await t.say(th.id, 'Ik woon in Leiden.'));
    assert.doesNotMatch(ctxOf(leiden), /Het geheugen is vol/);
    assert.equal(full().length, 0, JSON.stringify(notes));

    // 2. Said explicitly in the chat: the outcome is under the owner's message and the bot hears it (no extra notice).
    t.script.push({ text: 'Dat lukt niet, het geheugen is vol.' });
    const m1 = lastUser(await t.say(th.id, 'Onthoud dat ik van jazz hou.'));
    assert.match(ctxOf(m1), /Het quotum voor Over jou is vol \(10\/10 items\)/);
    const cap = await t.api('GET', `/memory/message/${m1.id}`);
    assert.equal(cap.outcomes[0].action, 'quota');
    // 3. "Ja, doe maar" on the bot's proposal: the same, in the chat.
    t.script.push({ text: 'Zal ik onthouden dat je hond Bram heet?' }, { text: 'Helaas, vol.' });
    await t.say(th.id, 'We hebben een pup.');
    const yes = lastUser(await t.say(th.id, 'Ja, doe maar'));
    assert.match(ctxOf(yes), /De gebruiker zei ja op je voorstel om dit te onthouden\. Het quotum voor Over jou is vol/);
    assert.equal(full().length, 0);

    // 4. The review (a free model) finds a work agreement for the team while the team's overview is full: the line is
    //    kept in the dossier's archive (found with search), and the owner gets one notice for that dossier.
    await freeEngine(t);
    await t.api('PUT', '/memory/settings', { extractor: 'free' });
    const ov = (await t.api('GET', '/memory/dossiers')).find((d: any) => d.core === 'overview');
    const filler = Array.from({ length: 70 }, (_, i) => `- Regel ${i} over een lopend project met genoeg woorden om het dossier te vullen, nummer ${i * 7}.`).join('\n').slice(0, ov.body_limit - 10);
    await t.api('PATCH', `/memory/dossiers/${ov.id}`, { body: filler });
    setShortCallFake((system) => (/Je bent het geheugen van TeamBot/.test(system) ? 'Overzicht: Offertes gaan altijd via Jan\nSamenvatting: Over offertes.' : ''));
    t.script.push({ text: 'Begrepen.' });
    await t.say(th.id, 'Voor de duidelijkheid: offertes gaan altijd via Jan.');
    const res = await t.api('POST', `/memory/thread/${th.id}/learn`, { agentId: a.id });
    assert.equal(res.method, 'model');
    assert.doesNotMatch(String(t.app.ctx.store.get<any>('memory_dossiers', ov.id).body), /Offertes gaan altijd via Jan/);
    assert.ok(t.app.ctx.store.all<any>("SELECT body FROM memory_records WHERE dossier_id = ? AND kind = 'event'", ov.id).some((r) => /Offertes gaan altijd via Jan/.test(r.body)), 'kept in the archive');
    assert.equal(full().length, 1, JSON.stringify(full()));
    assert.match(full()[0].body, /Dossier “Overzicht” is vol/);
    t.script.push({ text: 'Ok.' });
    await t.say(th.id, 'En de facturen gaan ook altijd via Jan.');
    setShortCallFake((system) => (/Je bent het geheugen van TeamBot/.test(system) ? 'Overzicht: Facturen gaan altijd via Jan' : ''));
    await t.api('POST', `/memory/thread/${th.id}/learn`, { agentId: a.id });
    assert.equal(full().length, 1, 'not again the same day for the same dossier');
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});
