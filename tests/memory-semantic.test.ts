/**
 * Search by meaning (plan 0.4 F): a fact stored in other words is found ("wagen" → "auto") with a local Ollama
 * embedding model; without one, word search works exactly as before and the status says why. Vectors are derived
 * data: never for sensitive items, gone with forget/trash, rebuilt by reindex, checked after a restore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { startFakeOllama, type FakeOllama } from './memory-fake-ollama.js';
import { dot, family, isLoopback, normalizeVec } from '../server/modules/memory/semantic.js';

const ctxOf = (m: any): string => m?.parts?.context ?? '';
const userMsg = (msgs: any[]) => msgs.filter((m) => m.role === 'user').at(-1);

async function withOllama(t: TestApp, o: FakeOllama, base = `${o.url}/v1`) {
  const owner = t.app.ctx.auth.owner()!.id;
  const p = t.app.ctx.providers.create(owner, { kind: 'ollama', base_url: base });
  // Learning stays on the fixed patterns here (the fake chat endpoint is no learning model).
  await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
  return p;
}
const drain = (t: TestApp) => t.app.ctx.services.memory.drain();
const vectors = (t: TestApp, kind = 'item') => t.app.ctx.store.all<any>('SELECT * FROM memory_vectors WHERE kind = ?', kind);

test('meaning helpers: unit vectors, cosine, floors per model, loopback only', () => {
  const a = normalizeVec([3, 4]);
  assert.ok(Math.abs(a[0] - 0.6) < 1e-6 && Math.abs(a[1] - 0.8) < 1e-6);
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-6);
  assert.equal(family('bge-m3:latest').floor, 0.55);
  assert.equal(family('nomic-embed-text').query, 'search_query: ');
  assert.ok(isLoopback('http://127.0.0.1:11434') && isLoopback('http://localhost:11434') && isLoopback('http://[::1]:11434'));
  assert.ok(!isLoopback('http://192.168.1.20:11434') && !isLoopback('https://ollama.example.com'));
});

test('a fact stored in other words is found by meaning: search page, per-turn context and memory_search', async () => {
  const t = await startTestApp();
  const o = await startFakeOllama();
  try {
    await withOllama(t, o);
    const car = (await t.api('POST', '/memory/items', { content: 'Mijn auto is een blauwe Volvo', scope: 'about_you' })).item;
    const coffee = (await t.api('POST', '/memory/items', { content: 'Ik drink mijn koffie zwart', scope: 'about_you' })).item;
    await drain(t);
    assert.equal(vectors(t).length, 2, 'both items embedded');
    assert.equal(vectors(t)[0].model, 'bge-m3:latest');
    assert.equal(vectors(t)[0].dim, 32);

    // "wagen" shares no word with "auto": found by meaning only.
    const r = await t.api('GET', '/memory/search?q=' + encodeURIComponent('wagen'));
    assert.deepEqual(r.items.map((i: any) => i.id), [car.id]);
    assert.equal(r.items[0].meaning, true);
    const list = await t.api('GET', '/memory/items?q=' + encodeURIComponent('voertuig'));
    assert.deepEqual(list.items.map((i: any) => i.id), [car.id]);
    // By words still works and ranks first when words and meaning agree.
    const both = await t.api('GET', '/memory/search?q=' + encodeURIComponent('koffie'));
    assert.equal(both.items[0].id, coffee.id);

    // The bot's per-turn context: the car (by meaning), not the coffee.
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Blauw.' });
    const ctx1 = ctxOf(userMsg(await t.say(th.id, 'Welke kleur heeft mijn wagen?')));
    assert.match(ctx1, new RegExp(`\\[m:${car.ref}\\]`));
    assert.doesNotMatch(ctx1, new RegExp(`\\[m:${coffee.ref}\\]`));

    // The bot's own search tool.
    t.script.push({ toolCalls: [{ name: 'memory_search', args: { query: 'bolide' } }] }, { text: 'ok' });
    const msgs = await t.say(th.id, 'Zoek eens op wat ik rijd');
    const out = msgs.filter((m: any) => m.role === 'tool').at(-1)!.content;
    assert.match(out, new RegExp(`\\[m:${car.ref}\\]`));

    // Without meaning (switched off): word search as before, and the vectors go (derived data).
    await t.api('PUT', '/memory/settings', { semantic: 'off' });
    assert.equal(vectors(t).length, 0);
    assert.equal((await t.api('GET', '/memory/search?q=bolide')).items.length, 0);
    assert.equal((await t.api('GET', '/memory/search?q=auto')).items[0].id, car.id, 'words still work');
    // (0.4 F2) Word search knows everyday synonyms itself: "wagen" finds "auto" without any model.
    assert.equal((await t.api('GET', '/memory/search?q=wagen')).items[0]?.id, car.id, 'synonyms in the word index');
    assert.equal((await t.api('GET', '/memory/semantic')).state, 'off');
    await t.api('PUT', '/memory/settings', { semantic: 'auto' });
    await drain(t);
    assert.equal(vectors(t).length, 2);
  } finally {
    await o.close();
    await t.close();
  }
});

test('vectors follow the record: never for sensitive items, gone with forget (and its tombstone) and trash, rebuilt by reindex', async () => {
  const t = await startTestApp();
  const o = await startFakeOllama();
  try {
    await withOllama(t, o);
    const car = (await t.api('POST', '/memory/items', { content: 'Mijn auto is een rode Volvo', scope: 'about_you' })).item;
    const dog = (await t.api('POST', '/memory/items', { content: 'Mijn hond heet Bram', scope: 'about_you' })).item;
    const secret = (await t.api('POST', '/memory/items', { content: 'Ik slik medicijnen voor diabetes', scope: 'about_you' })).item;
    assert.equal(secret.sensitivity, 'sensitive');
    await drain(t);
    assert.deepEqual(vectors(t).map((v: any) => v.rid).sort(), [car.id, dog.id].sort(), 'no vector for the sensitive item');

    // An edit with new text: the old vector goes at once, the new one comes from the indexer.
    await t.api('PATCH', `/memory/items/${dog.id}`, { content: 'Mijn hond heet Bram en is een labrador' });
    assert.ok(!vectors(t).some((v: any) => v.rid === dog.id), 'stale vector removed in the same change');
    await drain(t);
    assert.ok(vectors(t).some((v: any) => v.rid === dog.id));

    // Trash: no vector; restore: back after indexing.
    await t.api('POST', `/memory/items/${dog.id}/trash`);
    assert.ok(!vectors(t).some((v: any) => v.rid === dog.id));
    await t.api('POST', `/memory/items/${dog.id}/restore`);
    await drain(t);
    assert.ok(vectors(t).some((v: any) => v.rid === dog.id));

    // Forget: vector gone, not findable by meaning, re-learning blocked by the tombstone (so never re-embedded).
    await t.api('POST', `/memory/items/${car.id}/forget`, {});
    assert.ok(!vectors(t).some((v: any) => v.rid === car.id));
    assert.equal((await t.api('GET', '/memory/search?q=wagen')).items.length, 0);
    await assert.rejects(t.api('POST', '/memory/items', { content: 'Mijn auto is een rode Volvo', scope: 'about_you' }), /eerder op verzoek vergeten|409/);
    await drain(t);
    assert.ok(!vectors(t).some((v: any) => v.rid === car.id));

    // Reindex: everything again (Ollama is asked again for every item).
    const before = o.calls.texts;
    const ri = await t.api('POST', '/memory/reindex', {});
    assert.equal(ri.meaning, 'rebuilding');
    assert.equal(vectors(t).length, 0);
    await drain(t);
    assert.deepEqual(vectors(t).map((v: any) => v.rid), [dog.id]);
    assert.ok(o.calls.texts > before);

    // Delete all: vectors too.
    await t.api('POST', '/memory/delete-all', { confirm: 'WISSEN' });
    assert.equal(t.app.ctx.store.all('SELECT * FROM memory_vectors').length, 0);
  } finally {
    await o.close();
    await t.close();
  }
});

test('without a usable Ollama: words only, never a wait, and the status says why', async () => {
  const t = await startTestApp();
  const o = await startFakeOllama({ embedModels: [] });
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const car = (await t.api('POST', '/memory/items', { content: 'Mijn auto is een blauwe Volvo', scope: 'about_you' })).item;
    assert.equal((await t.api('GET', '/memory/semantic?fresh=1')).state, 'no-ollama');
    assert.equal((await t.api('GET', '/memory/search?q=bolide')).items.length, 0);
    assert.equal((await t.api('GET', '/memory/search?q=auto')).items[0].id, car.id);

    // An Ollama elsewhere on the network is never used for this (memory stays on this computer).
    const owner = t.app.ctx.auth.owner()!.id;
    const remote = t.app.ctx.providers.create(owner, { kind: 'ollama', base_url: 'http://192.168.77.77:11434/v1' });
    assert.equal((await t.api('GET', '/memory/semantic?fresh=1')).state, 'remote');
    t.app.ctx.store.exec('DELETE FROM providers WHERE id = ?', remote.id);

    // A local Ollama without an embedding model: words only, with the hint to download one.
    t.app.ctx.providers.create(owner, { kind: 'ollama', base_url: `${o.url}/v1` });
    const s = await t.api('GET', '/memory/semantic?fresh=1');
    assert.equal(s.state, 'no-model');
    assert.equal(s.suggested, 'bge-m3');
    await t.app.ctx.services.memory.drain();
    assert.equal(t.app.ctx.store.all('SELECT * FROM memory_vectors').length, 0);

    // Downloading (the owner's choice): progress, then search by meaning is on and the memory gets indexed.
    const notes: any[] = [];
    t.app.ctx.events.on('notification', (e: any) => notes.push(e.data));
    const p = await t.api('POST', '/memory/semantic/pull', { model: 'bge-m3' });
    assert.ok(p.pull && ['running', 'done'].includes(p.pull.status));
    await assert.rejects(t.api('POST', '/memory/semantic/pull', { model: 'iets-anders' }), /voorgestelde modellen/);
    for (let i = 0; i < 50 && (await t.api('GET', '/memory/semantic')).pull?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    const after = await t.api('GET', '/memory/semantic?fresh=1');
    assert.equal(after.pull.status, 'done');
    assert.equal(after.state, 'on');
    assert.equal(after.model, 'bge-m3:latest');
    assert.ok(notes.some((n) => n.title === 'Zoeken op betekenis staat aan'), JSON.stringify(notes));
    await t.app.ctx.services.memory.drain();
    assert.equal((await t.api('GET', '/memory/semantic')).counts.items.done, 1);
    assert.equal((await t.api('GET', '/memory/search?q=wagen')).items[0].id, car.id);

    // Ollama stops: the turn still works at once with words; the status says it does not answer.
    await o.close();
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Een Volvo.' });
    const started = Date.now();
    const ctx1 = ctxOf(userMsg(await t.say(th.id, 'Welke auto heb ik?')));
    assert.ok(Date.now() - started < 3000, 'no long wait for a stopped Ollama');
    assert.match(ctx1, new RegExp(`\\[m:${car.ref}\\]`), 'found by words');
    assert.equal((await t.api('GET', '/memory/semantic?fresh=1')).state, 'unreachable');
  } finally {
    await o.close().catch(() => {});
    await t.close();
  }
});

test('after a restore the vectors are checked against their records (stale ones dropped, the rest re-embedded)', async () => {
  const t = await startTestApp();
  const o = await startFakeOllama();
  try {
    await withOllama(t, o);
    const dog = (await t.api('POST', '/memory/items', { content: 'Mijn hond heet Bram', scope: 'about_you' })).item;
    await drain(t);
    const svc = t.app.ctx.services.memory.svc;
    // A database copy whose vector no longer matches its record, plus an orphan vector.
    t.app.ctx.store.exec("UPDATE memory_items SET content = 'Mijn hond heet Max' WHERE id = ?", dog.id);
    t.app.ctx.store.exec("INSERT INTO memory_vectors (kind, rid, user_id, model, dim, text_hash, vec, created_at) VALUES ('item', 'mem_gone', ?, 'bge-m3:latest', 1, 'x', x'00000000', '2026-01-01')", dog.user_id);
    svc.reindex(undefined, { vectors: 'verify' });
    assert.equal(vectors(t).length, 0, 'stale and orphan vectors dropped');
    await drain(t);
    assert.deepEqual(vectors(t).map((v: any) => v.rid), [dog.id]);
    const r = await t.api('GET', '/memory/search?q=' + encodeURIComponent('viervoeter'));
    assert.equal(r.items[0].id, dog.id);
  } finally {
    await o.close();
    await t.close();
  }
});
