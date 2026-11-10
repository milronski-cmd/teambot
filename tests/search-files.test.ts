import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { ripgrepPath, searchFiles, setRipgrepForTests } from '../server/tools/builtin/search.js';

/** search_files with ripgrep: same answer as before, never blocks the server, a bot's regex is safe (time limit, limits). */

function folder() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-search-'));
  fs.mkdirSync(path.join(d, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(d, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(d, 'notities.txt'), 'eerste regel\nDe OFFERTE is verstuurd\nderde regel\n');
  fs.writeFileSync(path.join(d, 'src', 'app.ts'), 'export const offerte = 1;\n');
  fs.writeFileSync(path.join(d, 'src', 'deep', 'lang.md'), 'a'.repeat(40) + 'b\n');
  fs.writeFileSync(path.join(d, 'node_modules', 'x', 'index.js'), 'offerte in een pakket\n');
  fs.writeFileSync(path.join(d, '.env'), 'OFFERTE_KEY=geheim\n');
  fs.writeFileSync(path.join(d, 'plaatje.bin'), Buffer.from([0, 1, 2, 0x6f, 0x66, 0x66, 0x65, 0x72, 0x74, 0x65]));
  return d;
}

const names = (r: { hits: { file: string; line: number }[] }, root: string) => r.hits.map((h) => `${path.relative(root, h.file).replace(/\\/g, '/')}:${h.line}`).sort();

test('ripgrep is bundled for this platform and finds what the old walk found', async (t) => {
  if (!ripgrepPath()) return t.skip('no ripgrep binary for this platform');
  const d = folder();
  try {
    const r = await searchFiles({ root: d, query: 'offerte' });
    assert.equal(r.engine, 'ripgrep');
    // Case-insensitive, skips node_modules, binary files and secret files.
    assert.deepEqual(names(r, d), ['notities.txt:2', 'src/app.ts:1']);
    assert.equal(r.hits.find((h) => h.line === 2)!.text, 'De OFFERTE is verstuurd');
    assert.deepEqual(names(await searchFiles({ root: d, query: 'offerte', glob: '*.TS' }), d), ['src/app.ts:1']);
    assert.deepEqual(names(await searchFiles({ root: d, query: 'off.rte\\b', regex: true }), d), ['notities.txt:2', 'src/app.ts:1']);
    // A literal search with regex characters is literal.
    assert.deepEqual(names(await searchFiles({ root: d, query: '(a+)+' }), d), []);
    // A pattern that makes a backtracking engine hang (catastrophic backtracking) is instant here.
    const t0 = Date.now();
    const bad = await searchFiles({ root: d, query: '^(a+)+$', regex: true });
    assert.deepEqual(bad.hits, []);
    assert.ok(Date.now() - t0 < 5000);
    const wrong = await searchFiles({ root: d, query: '([a-', regex: true });
    assert.match(wrong.error || '', /regex parse error/);
    // Hit limit.
    fs.writeFileSync(path.join(d, 'veel.txt'), 'offerte\n'.repeat(500));
    const many = await searchFiles({ root: d, query: 'offerte', max: 50 });
    assert.equal(many.hits.length, 50);
    assert.equal(many.truncated, true);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('the server keeps running while a big folder is searched', async (t) => {
  if (!ripgrepPath()) return t.skip('no ripgrep binary for this platform');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-search-big-'));
  try {
    for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), `regel ${i}\n`.repeat(200) + (i === 1499 ? 'naald\n' : ''));
    let ticks = 0;
    const iv = setInterval(() => ticks++, 1);
    const r = await searchFiles({ root: d, query: 'naald' });
    clearInterval(iv);
    assert.deepEqual(names(r, d), ['f1499.txt:201']);
    assert.ok(ticks > 0, 'timers ran during the search');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('without ripgrep: the walk runs in a worker with a time limit (a catastrophic regex is stopped)', async () => {
  const d = folder();
  setRipgrepForTests(null);
  try {
    const r = await searchFiles({ root: d, query: 'offerte' });
    assert.equal(r.engine, 'js');
    assert.deepEqual(names(r, d), ['notities.txt:2', 'src/app.ts:1']);
    let ticks = 0;
    const iv = setInterval(() => ticks++, 5);
    const t0 = Date.now();
    fs.writeFileSync(path.join(d, 'src', 'deep', 'lang.md'), 'a'.repeat(34) + 'b\n');
    const slow = await searchFiles({ root: d, query: '^(a+)+$', regex: true, timeoutMs: 600 });
    clearInterval(iv);
    assert.equal(slow.timedOut, true);
    assert.ok(Date.now() - t0 < 3000, 'stopped at the time limit');
    assert.ok(ticks > 3, 'the event loop was free while the regex ran');
    assert.match((await searchFiles({ root: d, query: '([a-', regex: true })).error || '', /Invalid regular expression/);
  } finally {
    setRipgrepForTests(undefined);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('search_files tool: bestand:regel: inhoud, relative to the work folder, honest about errors', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Zoeker' });
    fs.mkdirSync(path.join(a.workspace, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(a.workspace, 'docs', 'plan.md'), '# Plan\nBel de klant over de offerte\n');
    fs.writeFileSync(path.join(a.workspace, '.env'), 'OFFERTE=geheim\n');
    const run = async (args: any) => {
      const th = await t.api('POST', '/threads', { agentId: a.id });
      t.script.push({ toolCalls: [{ name: 'search_files', args }] }, { text: 'ok' });
      const msgs = await t.say(th.id, 'zoek');
      return msgs.find((m: any) => m.role === 'tool')!.content as string;
    };
    assert.equal(await run({ query: 'offerte' }), `docs${path.sep}plan.md:2: Bel de klant over de offerte`);
    assert.equal(await run({ query: 'bestaat-niet' }), 'Geen resultaten.');
    assert.match(await run({ query: '([a-', regex: true }), /^Deze zoekopdracht kan niet: /);
  } finally {
    await t.close();
  }
});
