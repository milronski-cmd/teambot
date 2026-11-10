/**
 * 0.4 F2: search by meaning for everyone, with the model TeamBot brings itself (builtin-embed.ts). Tests never download
 * the real 135 MB or load ONNX Runtime: a local file server stands in for Hugging Face (with real SHA-256 checks) and a
 * small stand-in runtime gives each concept its own direction (tests/memory-fake-ollama.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { startTestApp, type TestApp } from './helpers.js';
import { fakeVector, startFakeOllama } from './memory-fake-ollama.js';
import { BUILTIN, BUILTIN_FILES, builtinBytes, clsPool, isBuiltinId, meanPool, runtimeProblem, setBuiltinForTests } from '../server/modules/memory/builtin-embed.js';
import { family, scoreSims } from '../server/modules/memory/semantic.js';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** A stand-in for huggingface.co: three small files; `bad` serves other bytes than promised for one of them. */
async function fileServer() {
  const files: Record<string, Buffer> = { 'model.onnx': Buffer.from('onnx-weights-for-test'.repeat(50)), 'tokenizer.json': Buffer.from('{"t":1}'), 'tokenizer_config.json': Buffer.from('{}') };
  const state = { bad: false, hits: 0 };
  const srv = http.createServer((req, res) => {
    const name = (req.url || '').replace(/^\//, '');
    state.hits++;
    const body = files[name];
    if (!body) return void (res.writeHead(404), res.end());
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(state.bad && name === 'model.onnx' ? Buffer.from('tampered'.repeat(10)) : body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const list = Object.entries(files).map(([name, b]) => ({ name, url: `${url}/${name}`, size: b.length, sha256: sha(b) }));
  return { list, state, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** The stand-in runtime: concept vectors (prefixes are words too, as in the real model). */
const fakeLoader = async () => ({
  embed: async (texts: string[]) => texts.map((t) => {
    const v = fakeVector(t);
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return Float32Array.from(v.map((x) => x / n));
  }),
  close() {},
});

const svcOf = (t: TestApp) => t.app.ctx.services.memory.svc;
const vectors = (t: TestApp) => t.app.ctx.store.all<any>('SELECT kind, rid, model FROM memory_vectors');

test('built-in model: pinned files with hashes, CLS pooling, relative scores in a soft band, the old model still means "built-in"', () => {
  assert.equal(BUILTIN_FILES.length, 3);
  for (const f of BUILTIN_FILES) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.size > 0);
    assert.match(f.url, /^https:\/\/huggingface\.co\/ibm-granite\/granite-embedding-97m-multilingual-r2\/resolve\/[0-9a-f]{40}\//, 'one pinned revision');
  }
  assert.equal(BUILTIN.license, 'Apache-2.0');
  assert.ok(builtinBytes() < 130_000_000, 'smaller than the model before 0.4.4');
  // CLS pooling: the first token of each text, unit length (granite-embedding); mean pooling stays for other models.
  const [c] = clsPool([3, 4, 100, 100], [1, 2, 2]);
  assert.ok(Math.abs(c[0] - 0.6) < 1e-6 && Math.abs(c[1] - 0.8) < 1e-6, 'only the first token');
  const [v] = meanPool([1, 0, 3, 0, 100, 100], [1, 3, 2], [1n, 1n, 0n]);
  assert.ok(Math.abs(v[0] - 1 / Math.sqrt(1 + 0)) < 1e-6 && Math.abs(v[1]) < 1e-6, 'padding token left out');
  // A soft band around the best hit: the best scores 1, a hit 3·tau below it no longer counts, nothing below the floor.
  const s = scoreSims(BUILTIN.id, [['a', 0.86], ['b', 0.845], ['c', 0.79], ['d', 0.4]]);
  assert.equal(s.get('a'), 1);
  assert.ok(s.get('b')! > 0.3 && s.get('b')! < 1);
  assert.equal(s.has('c'), false, 'far below the best hit');
  assert.equal(s.has('d'), false, 'below the floor');
  assert.ok(family(BUILTIN.id).gate! > 0.7, 'a measured gate for the per-turn block');
  assert.equal(family(BUILTIN.id).query, undefined, 'granite has no query prefix');
  assert.ok(isBuiltinId('builtin:multilingual-e5-small') && isBuiltinId(BUILTIN.id), 'a saved choice for the old built-in model means the built-in model');
});

test('built-in model: an installation that said yes to the old model gets the new one, and the old files go', async () => {
  const files = await fileServer();
  setBuiltinForTests({ files: files.list, loader: fakeLoader });
  const t = await startTestApp();
  try {
    const sem = svcOf(t).semantic;
    const legacy = sem.builtin.dir.replace(BUILTIN.name, 'multilingual-e5-small');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(`${legacy}/model.onnx`, 'old');
    t.app.ctx.store.setSetting('', 'memory.builtin', { consent: true, at: new Date().toISOString() });
    await t.api('PUT', '/memory/settings', { semanticModel: 'builtin:multilingual-e5-small' });
    assert.equal(sem.builtin.legacyPresent(), true);
    sem.upgradeBuiltin();
    for (let i = 0; i < 100 && (sem.builtinStatus().state === 'downloading' || sem.builtin.legacyPresent()); i++) await new Promise((r) => setTimeout(r, 30));
    assert.equal(sem.builtinStatus().state, 'ready', 'downloaded without asking again (the yes was for the built-in model)');
    assert.equal(fs.existsSync(legacy), false, 'the old files are removed');
    const s = await t.api('GET', '/memory/semantic?fresh=1');
    assert.equal(s.engine, 'builtin');
    assert.equal(s.model, BUILTIN.id);
  } finally {
    setBuiltinForTests({ files: null, loader: null });
    await t.close();
    await files.close();
  }
});

test('slim zoeken for everyone: one card, one yes, a checked download, then "bolide" finds "auto" without Ollama; remove', async () => {
  const files = await fileServer();
  setBuiltinForTests({ files: files.list, loader: fakeLoader });
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const car = (await t.api('POST', '/memory/items', { content: 'Mijn auto is een blauwe Volvo', scope: 'about_you' })).item;
    await t.api('POST', '/memory/items', { content: 'Ik drink graag koffie', scope: 'about_you' });
    let s = await t.api('GET', '/memory/semantic?fresh=1');
    assert.equal(s.state, 'no-ollama');
    assert.equal(s.builtin.state, 'absent');
    assert.equal(s.offer, true, 'the one-time card is offered');
    assert.ok(s.builtin.mb >= 0);
    // Nothing is downloaded before the owner says yes.
    assert.equal(files.state.hits, 0);
    assert.equal((await t.api('GET', '/memory/search?q=bolide')).items.length, 0, 'words only for now');

    // "Niet nu" hides the card (Opslag keeps the button).
    await t.api('POST', '/memory/semantic/builtin', { action: 'later' });
    assert.equal((await t.api('GET', '/memory/semantic')).offer, false);

    // Yes: downloaded once, every file checked, then the model is used (Ollama is not needed).
    await t.api('POST', '/memory/semantic/builtin', { action: 'enable' });
    for (let i = 0; i < 100 && (await t.api('GET', '/memory/semantic')).builtin.state === 'downloading'; i++) await new Promise((r) => setTimeout(r, 30));
    s = await t.api('GET', '/memory/semantic?fresh=1');
    assert.equal(s.builtin.state, 'ready');
    assert.equal(s.state, 'on');
    assert.equal(s.engine, 'builtin');
    assert.equal(s.model, BUILTIN.id);
    const dir = svcOf(t).semantic.builtin.dir;
    assert.ok(dir.startsWith(t.dir), 'stored in the data folder');
    assert.ok(fs.existsSync(`${dir}/verified.json`));
    await t.app.ctx.services.memory.drain();
    assert.equal(vectors(t).filter((v) => v.model === BUILTIN.id).length, 2);
    const hit = (await t.api('GET', '/memory/search?q=bolide')).items[0];
    assert.equal(hit?.id, car.id);
    assert.equal(hit.meaning, true, 'found by meaning');
    // The notification says it is on.
    const note = t.app.ctx.store.all<any>("SELECT * FROM notifications WHERE title LIKE 'Slim zoeken%'");
    if (note.length) assert.match(note[0].title, /Slim zoeken staat aan/);

    // The same in the bot's context and its search tool.
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Blauw.' });
    const msgs = await t.say(th.id, 'Welke kleur heeft mijn bolide?');
    const ctx = String(msgs.find((m: any) => m.role === 'user')?.parts?.context || '');
    assert.match(ctx, new RegExp(`\\[m:${car.ref}\\]`));

    // Forget: the vector goes with the record (derived store).
    await t.api('POST', `/memory/items/${car.id}/forget`, { alsoSource: false });
    assert.equal(vectors(t).filter((v) => v.rid === car.id).length, 0);

    // Remove the model: files and its vectors gone, words as before.
    await t.api('POST', '/memory/semantic/builtin', { action: 'remove' });
    assert.equal(fs.existsSync(dir), false);
    assert.equal(vectors(t).length, 0);
    assert.equal((await t.api('GET', '/memory/semantic?fresh=1')).builtin.state, 'absent');
  } finally {
    setBuiltinForTests({ files: null, loader: null });
    await t.close();
    await files.close();
  }
});

test('built-in model: a file that does not match its hash is never used; Ollama with an embedding model stays first unless the owner picks the built-in one', async () => {
  const files = await fileServer();
  files.state.bad = true;
  setBuiltinForTests({ files: files.list, loader: fakeLoader });
  const t = await startTestApp();
  const o = await startFakeOllama({ embedModels: ['bge-m3:latest'] });
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    await t.api('POST', '/memory/items', { content: 'Mijn auto is een blauwe Volvo', scope: 'about_you' });
    await t.api('POST', '/memory/semantic/builtin', { action: 'enable' });
    for (let i = 0; i < 100 && (await t.api('GET', '/memory/semantic')).builtin.state === 'downloading'; i++) await new Promise((r) => setTimeout(r, 30));
    let s = await t.api('GET', '/memory/semantic?fresh=1');
    assert.equal(s.builtin.state, 'error');
    assert.match(s.builtin.error, /controle/);
    assert.equal(fs.existsSync(`${svcOf(t).semantic.builtin.dir}/model.onnx`), false, 'the wrong file is not kept');
    assert.equal(s.state, 'no-ollama');

    // A good download now; then an Ollama with bge-m3 on this computer: Ollama is used (as in 0.4 F) …
    files.state.bad = false;
    await t.api('POST', '/memory/semantic/builtin', { action: 'enable' });
    for (let i = 0; i < 100 && (await t.api('GET', '/memory/semantic')).builtin.state === 'downloading'; i++) await new Promise((r) => setTimeout(r, 30));
    t.app.ctx.providers.create(t.app.ctx.auth.owner()!.id, { kind: 'ollama', base_url: `${o.url}/v1` });
    svcOf(t).semantic.forgetInfo();
    s = await t.api('GET', '/memory/semantic?fresh=1');
    assert.equal(s.engine, 'ollama');
    assert.ok(s.models.includes(BUILTIN.id), 'the built-in model can be chosen');
    // … unless the owner chooses the built-in one.
    await t.api('PUT', '/memory/settings', { semanticModel: BUILTIN.id });
    s = await t.api('GET', '/memory/semantic?fresh=1');
    assert.equal(s.engine, 'builtin');
    await t.app.ctx.services.memory.drain();
    assert.ok(vectors(t).every((v) => v.model === BUILTIN.id));
  } finally {
    setBuiltinForTests({ files: null, loader: null });
    await t.close();
    await o.close();
    await files.close();
  }
});

test('without the runtime in this build: said plainly, no card, no download, words (with synonyms) as before', async () => {
  setBuiltinForTests({ files: null, loader: null });
  if (!runtimeProblem()) return; // onnxruntime-node is installed here: covered by the tests above with the real files
  const t = await startTestApp();
  try {
    const s = await t.api('GET', '/memory/semantic?fresh=1');
    assert.equal(s.builtin.state, 'no-runtime');
    assert.equal(s.offer, false);
    await assert.rejects(t.api('POST', '/memory/semantic/builtin', { action: 'enable' }), /kan in deze versie/);
    const car = (await t.api('POST', '/memory/items', { content: 'Mijn auto is een blauwe Volvo', scope: 'about_you' })).item;
    assert.equal((await t.api('GET', '/memory/search?q=wagen')).items[0]?.id, car.id, 'synonyms in the word index');
  } finally {
    await t.close();
  }
});
