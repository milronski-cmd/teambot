// Full app backup and restore (package N, plan F "Back-up en terugzetten", Instellingen › Back-ups): back-up →
// change data → restore brings the data back (database, data files), forgotten memory stays forgotten, the derived
// search indexes are rebuilt, caches and models are never in a backup, work folders only when chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestApp } from './helpers.js';
import { createApp } from '../server/app.js';
import memory from '../server/modules/memory/index.js';
import history from '../server/modules/history/index.js';
import backups from '../server/modules/backups/index.js';
import { parseChangelog, plainMarkdown, whatsNew } from '../server/modules/backups/changelog.js';

const write = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
};
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

test('backup → change → restore: data and files come back, forgotten stays forgotten, indexes are rebuilt', async () => {
  const mods = [memory, history, backups];
  const t = await startTestApp({ modules: mods });
  const dir = t.dir;
  const owner = t.app.ctx.auth.owner()!.id;
  let forgottenId = '';
  let keptId = '';
  let agentId = '';
  let backupName = '';
  const att = path.join(dir, 'attachments', owner, 'notitie.txt');
  const work = (id: string) => path.join(dir, 'workspaces', id, 'werk.txt');
  try {
    const a = await t.agent({ name: 'Voor back-up' });
    agentId = a.id;
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'Het codewoord is appelflap');
    const r1 = await t.api('POST', '/memory/items', { content: 'Ik eet op zondag altijd pasta bij oma', scope: 'about_you' });
    forgottenId = r1.item?.id || r1.id || r1.row?.id;
    const r2 = await t.api('POST', '/memory/items', { content: 'Mijn fiets is knalgeel', scope: 'about_you' });
    keptId = r2.item?.id || r2.id || r2.row?.id;
    assert.ok(forgottenId && keptId);
    write(att, 'voor');
    write(path.join(dir, 'skills', owner, 'mijn-skill', 'SKILL.md'), '# Mijn skill');
    write(work(a.id), 'werk voor');
    // Caches, downloaded models, browser profiles, programs: never in a backup.
    write(path.join(dir, 'cache', 'mcp-registry', 'x.json'), '{}');
    write(path.join(dir, 'voice', 'models', 'stem.onnx'), 'model');
    write(path.join(dir, 'browser', 'profiel', 'Cookies'), 'koekjes');
    write(path.join(dir, 'runtimes', 'opencode', 'current.json'), '{}');

    const plan = (await t.api('GET', '/backups?fresh=1')).plan;
    const part = (id: string) => plan.find((p: any) => p.id === id);
    assert.equal(part('attachments').kind, 'always');
    assert.equal(part('workspaces').kind, 'optional');
    assert.ok(part('workspaces').bytes > 0, 'work folders are measured (size-aware)');
    for (const id of ['cache', 'voice', 'browser', 'runtimes', 'backups']) assert.equal(part(id).kind, 'excluded', id);

    const b = (await t.api('POST', '/backups', { wait: true })).backup;
    backupName = b.name;
    assert.match(b.name, /^teambot-\d{8}-\d{6}\.db$/);
    const set = path.join(dir, 'backups', b.name.replace(/\.db$/, ''));
    assert.ok(fs.existsSync(set + '.db') && fs.existsSync(set + '.json'));
    assert.equal(read(path.join(set + '.files', 'attachments', owner, 'notitie.txt')), 'voor');
    assert.ok(fs.existsSync(path.join(set + '.files', 'skills', owner, 'mijn-skill', 'SKILL.md')));
    for (const id of ['workspaces', 'cache', 'voice', 'browser', 'runtimes', 'logs', 'backups']) assert.ok(!fs.existsSync(path.join(set + '.files', id)), `${id} not in the backup`);
    const manifest = JSON.parse(fs.readFileSync(set + '.json', 'utf8'));
    assert.equal(manifest.version, t.app.ctx.config.version);
    assert.equal(manifest.includesWork, false);
    assert.ok(manifest.leftOut.some((x: any) => x.id === 'workspaces' && x.reason === 'niet gekozen'));
    const listed = (await t.api('GET', '/backups')).items.find((x: any) => x.name === b.name);
    assert.equal(listed.kind, 'manual');
    assert.equal(listed.legacy, false);

    // A derived index that is out of date in the backup is rebuilt after the restore.
    const bdb = new DatabaseSync(set + '.db');
    bdb.exec('DELETE FROM messages_fts; DELETE FROM messages_fts_map; DELETE FROM memory_fts;');
    bdb.close();

    // Change everything.
    await t.api('PATCH', `/agents/${a.id}`, { name: 'Na back-up' });
    await t.api('POST', `/memory/items/${forgottenId}/forget`, {});
    write(att, 'na');
    write(path.join(dir, 'attachments', owner, 'nieuw.txt'), 'nieuw');
    write(work(a.id), 'werk na');

    const st = await t.api('POST', `/backups/${b.name}/restore`);
    assert.equal(st.restartNeeded, true);
    assert.equal((await t.api('GET', '/backups')).pending.name, b.name.replace(/\.db$/, ''));
    await t.app.close();
  } catch (e) {
    await t.app.close().catch(() => {});
    throw e;
  }

  const app2 = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: mods });
  try {
    const ctx = app2.ctx;
    assert.equal(ctx.store.agent(agentId)?.name, 'Voor back-up', 'database is back');
    // Forgotten memory never comes back.
    const row = ctx.store.one<any>('SELECT status, content FROM memory_items WHERE id = ?', forgottenId);
    assert.ok(!row || row.status === 'forgotten', 'forgotten again');
    assert.ok(!row || !String(row.content || '').includes('oma'), 'content scrubbed');
    assert.equal(ctx.services.memory.search(owner, 'oma').length, 0, 'not findable');
    // The rest is findable again: the indexes were rebuilt from the data.
    assert.ok(ctx.services.memory.search(owner, 'knalgeel').length >= 1, 'memory index rebuilt');
    assert.ok(ctx.store.search(owner, 'appelflap').length >= 1, 'message index rebuilt');
    // Files: back as they were; what came later is kept aside in the safety copy, nothing is lost.
    assert.equal(read(att), 'voor');
    assert.equal(read(path.join(dir, 'attachments', owner, 'nieuw.txt')), null);
    const safety = fs.readdirSync(path.join(dir, 'backups')).find((f) => /-replaced\.files$/.test(f));
    assert.ok(safety, 'safety copy of the replaced files');
    assert.equal(read(path.join(dir, 'backups', safety!, 'attachments', owner, 'nieuw.txt')), 'nieuw');
    // Work folders were not in this backup: left as they are.
    assert.equal(read(work(agentId)), 'werk na');
    assert.ok(!fs.existsSync(path.join(dir, 'restore-pending.json')) && !fs.existsSync(path.join(dir, 'restore-applied.json')));
    const tok = ctx.auth.ensureLocalOwner();
    const info = await (await fetch(`${app2.url}/api/backups`, { headers: { authorization: `Bearer ${tok}` } })).json();
    assert.equal(info.lastRestore.name, backupName.replace(/\.db$/, ''));
    assert.deepEqual(info.lastRestore.rebuilt.sort(), ['memory', 'messages']);
    assert.ok(info.lastRestore.parts.includes('attachments'));
    assert.match(info.keys.text, /versleuteld/);
  } finally {
    await app2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('work folders only when chosen, keep N automatic backups, a newer backup is refused, members see nothing', async () => {
  const t = await startTestApp({ modules: [backups] });
  try {
    const svc = t.app.ctx.services.backups.service;
    const a = await t.agent({ name: 'Werker' });
    write(path.join(t.dir, 'workspaces', a.id, 'rapport.md'), '# Rapport');
    write(path.join(t.dir, 'rooms', 'room_x', 'files', 'plan.txt'), 'plan');

    const w = (await t.api('POST', '/backups', { includeWork: true, wait: true })).backup;
    assert.equal(w.includesWork, true);
    const files = path.join(t.dir, 'backups', w.name.replace(/\.db$/, '.files'));
    assert.equal(read(path.join(files, 'workspaces', a.id, 'rapport.md')), '# Rapport');
    assert.equal(read(path.join(files, 'rooms', 'room_x', 'files', 'plan.txt')), 'plan');

    // Automatic backups: only the newest N stay; manual ones are never removed by that.
    const s = await t.api('PUT', '/backups/settings', { keep: 2, auto: true });
    assert.equal(s.keep, 2);
    for (let i = 0; i < 3; i++) await svc.make({ kind: 'auto' });
    const items = (await t.api('GET', '/backups')).items;
    assert.equal(items.filter((x: any) => x.kind === 'auto').length, 2);
    assert.ok(items.some((x: any) => x.name === w.name), 'manual backup kept');
    assert.equal((await t.api('PUT', '/backups/settings', { keep: 0 })).keep, 1, 'keep is at least 1');

    // The backup before an update: database, team databases and key only (fast).
    const u = await t.app.ctx.services.backups.beforeUpdate({ from: '0.4.0', to: '0.4.1' });
    assert.equal(u.kind, 'update');
    assert.equal(u.dataOnly, true);
    assert.equal(u.label, 'Voor de update naar 0.4.1');
    assert.ok(!fs.existsSync(path.join(t.dir, 'backups', u.name.replace(/\.db$/, '.files'), 'workspaces')));

    // A backup made by a newer TeamBot cannot be restored into this one.
    const mf = path.join(t.dir, 'backups', w.name.replace(/\.db$/, '.json'));
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    fs.writeFileSync(mf, JSON.stringify({ ...m, version: '99.0.0' }));
    await assert.rejects(t.api('POST', `/backups/${w.name}/restore`), /nieuwere versie/);
    // Names are checked.
    await assert.rejects(t.api('POST', '/backups/..%2Fteambot.db/restore'), /400|404/);
    // Stage and cancel.
    fs.writeFileSync(mf, JSON.stringify(m));
    await t.api('POST', `/backups/${w.name}/restore`);
    assert.ok(fs.existsSync(path.join(t.dir, 'restore-pending.json')));
    await t.api('DELETE', '/backups/pending');
    assert.ok(!fs.existsSync(path.join(t.dir, 'restore-pending.db')) && !fs.existsSync(path.join(t.dir, 'restore-pending.json')));
    // Delete a set: all of its parts go.
    await t.api('DELETE', `/backups/${w.name}`);
    assert.ok(!fs.existsSync(files) && !fs.existsSync(mf));

    const mem = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@test.local', password: 'geheim1234', role: 'member' });
    const ses = t.app.ctx.auth.createSession(mem.id, 'web', 'test');
    assert.equal((await fetch(`${t.app.url}/api/backups`, { headers: { authorization: `Bearer ${ses.token}` } })).status, 403);
  } finally {
    await t.close();
  }
});

test('what is new: the changelog in plain words, per version', () => {
  const md = `# Changelog

## [0.4.1] — 2026-12-01

Kleine fixes.

### Opgelost
- Een **back-up** zet ook \`bijlagen\` terug, zie [de handleiding](https://x.example).
- Lange regel die
  doorloopt op de volgende regel.

## [0.4.0] — 2026-11-20

### Toegevoegd

**Back-ups**
- Een back-up met één klik.

### Gewijzigd
- *Rustiger* scherm.

## [0.3.0] — 2026-11-08

### Toegevoegd
- Iets ouds.
`;
  const all = parseChangelog(md);
  assert.deepEqual(all.map((r) => r.version), ['0.4.1', '0.4.0', '0.3.0']);
  assert.equal(all[0].intro, 'Kleine fixes.');
  assert.deepEqual(all[0].sections[0].groups[0].items, ['Een back-up zet ook bijlagen terug, zie de handleiding.', 'Lange regel die doorloopt op de volgende regel.']);
  assert.equal(all[1].sections[0].groups[0].title, 'Back-ups');
  assert.equal(all[1].sections[1].groups[0].items[0], 'Rustiger scherm.');
  // From 0.3.0 to 0.4.1: both newer releases, newest first; 0.3.0 itself not.
  assert.deepEqual(whatsNew('0.4.1', '0.3.0', md).map((r) => r.version), ['0.4.1', '0.4.0']);
  assert.deepEqual(whatsNew('0.4.0', undefined, md).map((r) => r.version), ['0.4.0']);
  assert.equal(plainMarkdown('**a** *b* `c` [d](e)'), 'a b c d');
  // The real changelog parses, without markdown marks in the items.
  const real = whatsNew('0.3.0');
  assert.equal(real[0]?.version, '0.3.0');
  assert.ok(real[0].sections.length >= 2);
  for (const s of real[0].sections) for (const g of s.groups) for (const it of g.items) assert.doesNotMatch(it, /\*\*|`/);
});

test('what is in a backup speaks plainly: the trash and the health samples have a name, the local address is never in it', async () => {
  const { planParts, restorable } = await import('../server/modules/backups/files.js');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-parts-'));
  try {
    write(path.join(dir, 'trash', 'u1', 'a.bin'), 'oud');
    write(path.join(dir, 'health', 'samples.jsonl'), '{}\n');
    write(path.join(dir, 'local-url'), 'http://127.0.0.1:4747');
    write(path.join(dir, 'nieuwe-module', 'x.json'), '{}');
    const parts = await planParts(dir);
    const by = (id: string) => parts.find((p) => p.id === id);
    assert.equal(by('trash')?.kind, 'always');
    assert.match(by('trash')!.label, /^Prullenbak/);
    assert.equal(by('health')?.kind, 'excluded');
    assert.ok(by('health')?.reason);
    assert.equal(by('local-url'), undefined, 'the local address belongs to this installation');
    assert.equal(restorable('local-url'), false);
    // A folder of a module TeamBot does not know yet is still kept (and named as such).
    assert.equal(by('nieuwe-module')?.label, 'Overige gegevens (nieuwe-module)');
    assert.ok(!parts.some((p) => /^Overige gegevens \((trash|health|local-url)\)$/.test(p.label)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
