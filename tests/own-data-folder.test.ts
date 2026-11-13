// A TeamBot with a data folder of its own (TEAMBOT_DATA, a test, a trial install, a server in Docker) keeps its
// Teammap and the werkplekken of its bots inside that data folder: it never touches the owner's real Documents. The
// installed app keeps them under Documents, as before. A new team folder starts empty: a folder an earlier install
// left behind is never handed to the bots of a fresh one (and nothing in it is moved or deleted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { standardDataDir } from '../server/core/config.js';
import { documentsFor, suggestTeamFolder } from '../server/modules/folders/index.js';
import { resolveInWorkspace } from '../server/tools/builtin/files.js';
import type { Agent } from '../server/core/types.js';

// Stands in for the user's real Documents in this test process: whatever the code does, the owner's files stay out.
const DOCS = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-docs-'));
process.env.XDG_DOCUMENTS_DIR = DOCS;
process.on('exit', () => fs.rmSync(DOCS, { recursive: true, force: true }));

const inside = (p: string, dir: string) => {
  const r = path.relative(path.resolve(dir), path.resolve(p));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
};
const tree = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);

test('own data folder: the Teammap and every werkplek stay inside it; the real Documents get nothing', async () => {
  const before = tree(DOCS);
  const t = await startTestApp();
  try {
    // What the first screen does (welcome/FirstBot.tsx): ask for the suggestion and make it.
    const st = await t.api('GET', '/folders/team');
    assert.ok(inside(st.suggestion, t.dir), `the suggestion lies in the data folder: ${st.suggestion}`);
    assert.equal(path.resolve(st.suggestion), path.resolve(t.dir, 'Documents', 'TeamBot', 'Teammap'));
    await t.api('PUT', '/folders/team', { path: st.suggestion, create: true, label: 'Teammap' });
    assert.ok(fs.statSync(st.suggestion).isDirectory());

    const mila = await t.agent({ name: 'Mila', tool_groups: ['files'] });
    const noor = await t.agent({ name: 'Noor', tool_groups: ['files'] });
    assert.equal(path.resolve(mila.workspace), path.resolve(st.suggestion, 'Mila'), 'a werkplek under that Teammap');
    assert.ok(fs.statSync(mila.workspace).isDirectory());

    // Another team gets its own folder, in the same run.
    const home = await t.api('POST', '/teams', { name: 'Thuis' });
    const other = await t.api('GET', `/folders/team?teamId=${home.id}`);
    assert.ok(inside(other.suggestion, t.dir), other.suggestion);

    // A werkplek in that Teammap is a desk like any other: the own one and the team folder writable, a colleague's not.
    const m = t.app.ctx.store.agent(mila.id) as Agent;
    assert.ok(resolveInWorkspace(m, path.join(mila.workspace, 'plan.md'), { write: true }));
    assert.ok(resolveInWorkspace(m, path.join(st.suggestion, 'samen.md'), { write: true }));
    assert.throws(() => resolveInWorkspace(m, path.join(noor.workspace, 'plan.md'), { write: true }), /werkplek van Noor/);

    // What a bot deletes there comes back from the Prullenbak, as in any team folder.
    fs.writeFileSync(path.join(mila.workspace, 'offerte.md'), 'Prijs: 1200 euro');
    const th = await t.api('POST', '/threads', { agentId: mila.id });
    t.script.push({ toolCalls: [{ name: 'delete_file', args: { path: 'offerte.md' } }] }, { text: 'Opgeruimd.' });
    await t.say(th.id, 'ruim offerte.md op');
    assert.equal(fs.existsSync(path.join(mila.workspace, 'offerte.md')), false);
    const item = (await t.api('GET', '/folders/trash')).items[0];
    assert.equal((await t.api('POST', `/folders/trash/${item.id}/restore`, {})).ok, true);
    assert.equal(fs.readFileSync(path.join(mila.workspace, 'offerte.md'), 'utf8'), 'Prijs: 1200 euro');

    // A folder of TeamBot's own data is still never shared.
    await assert.rejects(t.api('PUT', '/folders/team', { path: path.join(t.dir, 'skills'), create: true }), /gegevensmap van TeamBot/);
  } finally {
    await t.close();
  }
  assert.deepEqual(tree(DOCS), before, 'nothing new in the (stand-in) real Documents');
});

test('the installed app keeps its Teammap under Documents; a new one starts empty and never takes over an old one', () => {
  const normal = { config: { dataDir: standardDataDir() } } as any;
  assert.equal(path.resolve(documentsFor(normal)), path.resolve(DOCS), 'the installed app: the user\'s Documents');
  const own = path.join(os.tmpdir(), 'tb-eigen-data');
  assert.equal(path.resolve(documentsFor({ config: { dataDir: own } } as any)), path.resolve(own, 'Documents'));

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-start-leeg-'));
  try {
    const map = path.join(base, 'TeamBot', 'Teammap');
    assert.equal(suggestTeamFolder(base), map, 'nothing there yet');
    fs.mkdirSync(map, { recursive: true });
    fs.writeFileSync(path.join(map, 'desktop.ini'), '');
    assert.equal(suggestTeamFolder(base), map, 'an empty folder (only what the system puts there) is used');
    // An earlier install left the werkplek of its bot: a fresh install gets a new, empty folder beside it.
    fs.mkdirSync(path.join(map, 'Mila'));
    fs.writeFileSync(path.join(map, 'Mila', 'notities.md'), 'van eerder');
    assert.equal(suggestTeamFolder(base), `${map} (2)`);
    fs.mkdirSync(`${map} (2)`);
    assert.equal(suggestTeamFolder(base), `${map} (2)`, 'made but still empty: that one');
    fs.writeFileSync(path.join(`${map} (2)`, 'x.md'), 'x');
    assert.equal(suggestTeamFolder(base), `${map} (3)`);
    assert.equal(fs.readFileSync(path.join(map, 'Mila', 'notities.md'), 'utf8'), 'van eerder', 'nothing of the old folder is touched');
    assert.equal(suggestTeamFolder(base, 'Thuis'), path.join(base, 'TeamBot', 'Thuis'), 'another team: its own folder');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a fresh run whose Teammap already holds an earlier run\'s bots gets a new, empty one: its bots never get the old folders', async () => {
  const t = await startTestApp();
  try {
    const old = path.join(t.dir, 'Documents', 'TeamBot', 'Teammap', 'Oude bot');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'geheim.md'), 'van een eerdere installatie');
    const st = await t.api('GET', '/folders/team');
    assert.equal(path.resolve(st.suggestion), path.resolve(t.dir, 'Documents', 'TeamBot', 'Teammap (2)'));
    await t.api('PUT', '/folders/team', { path: st.suggestion, create: true });
    const bot = t.app.ctx.store.agent((await t.agent({ name: 'Nieuw', tool_groups: ['files'] })).id) as Agent;
    assert.equal(path.resolve(path.dirname(bot.workspace)), path.resolve(st.suggestion));
    assert.throws(() => resolveInWorkspace(bot, path.join(old, 'geheim.md')), 'the old folder is not one of its folders');
    assert.equal(fs.readFileSync(path.join(old, 'geheim.md'), 'utf8'), 'van een eerdere installatie', 'and it is left as it was');
  } finally {
    await t.close();
  }
});
