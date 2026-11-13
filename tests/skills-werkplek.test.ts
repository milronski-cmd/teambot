// An installed skill is a folder in the work folder of every bot that has it, wherever that work folder is: also in
// the werkplek every bot made in the screens or through the API gets in the team folder (Teammap\<bot>), on every
// engine (a model through an API key, Codex, an ACP agent such as OpenCode). Removing the skill removes it there.
// A folder of the owner (the team folder itself, a folder he gave several bots) still gets nothing from TeamBot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');
const FAKE_CODEX = path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs');
const PLACES = ['.claude', '.agents'];
const SKILL = `---\nname: dagwoord\ndescription: Gebruik dit wanneer iemand om het woord van de dag vraagt.\n---\n\n# dagwoord\n\nAntwoord met het woord: kiwi.\n`;

async function importPaste(t: TestApp, text: string) {
  const pv = await t.api('POST', '/skills/import/preview', { kind: 'paste', text });
  return (await t.api('POST', '/skills/import/commit', { stagingId: pv.stagingId, acknowledge: true, confirmPermissions: true })).results[0].skillId as string;
}
const has = (bot: any, name: string) => PLACES.map((p) => fs.existsSync(path.join(bot.workspace, p, 'skills', name, 'SKILL.md')));
const cliBot = async (t: TestApp, kind: string, config: any, name: string, access_mode = 'ask') => {
  const p = await t.api('POST', '/providers', { kind, config });
  return t.api('POST', '/agents', { name, provider_id: p.id, model: '', access_mode });
};

test('a skill stands as a folder in the werkplek of every bot of the team in the Teammap, on every engine, and goes with the skill', async () => {
  const t = await startTestApp();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-werkplek-skills-'));
  const team = path.join(base, 'Teammap');
  try {
    await t.api('PUT', '/folders/team', { path: team, create: true });
    const api = await t.agent({ name: 'Mila' });
    const codex = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, 'Codex');
    const open = await cliBot(t, 'acp-custom', { command: FAKE_ACP, args: [] }, 'Open');
    for (const b of [api, codex, open]) assert.equal(path.resolve(path.dirname(b.workspace)), path.resolve(team), `${b.name}: a werkplek in the Teammap`);

    const id = await importPaste(t, SKILL);
    for (const b of [api, codex, open]) assert.deepEqual(has(b, 'dagwoord'), [true, true], `${b.name}: .claude/skills and .agents/skills`);
    const list = JSON.parse(fs.readFileSync(path.join(api.workspace, '.agents', 'skills', '.teambot-skills.json'), 'utf8'));
    assert.equal(list.skills.dagwoord.id, id, 'written by TeamBot, on its list');

    // A bot made after the install has it at once; so does a copy.
    const later = await t.agent({ name: 'Later' });
    const copy = await t.api('POST', `/agents/${api.id}/duplicate`);
    for (const b of [later, copy]) assert.deepEqual(has(b, 'dagwoord'), [true, true], b.name);

    // Folders of the owner: the team folder itself, and one folder he gave two bots. TeamBot writes nothing there.
    const shared = path.join(team, 'Project');
    fs.mkdirSync(shared);
    const p1 = await t.agent({ name: 'Een', workspace: shared });
    const p2 = await t.agent({ name: 'Twee', workspace: shared });
    const whole = await t.agent({ name: 'Heel', workspace: team });
    for (const b of [p1, p2, whole]) assert.deepEqual(has(b, 'dagwoord'), [false, false], `${b.name}: nothing in a folder of the owner`);

    // Removed: gone in every werkplek, and nothing of TeamBot is left; the werkplek itself stays.
    await t.api('DELETE', `/skills/${id}`);
    for (const b of [api, codex, open, later, copy]) {
      for (const place of PLACES) assert.equal(fs.existsSync(path.join(b.workspace, place)), false, `${b.name}: ${place} is gone`);
      assert.ok(fs.statSync(b.workspace).isDirectory());
    }
  } finally {
    await t.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Codex in its werkplek finds the skill folder there when it starts', async () => {
  const t = await startTestApp();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-werkplek-codex-'));
  const log = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = log;
  process.env.CODEX_HOME = t.dir;
  try {
    await t.api('PUT', '/folders/team', { path: path.join(base, 'Teammap'), create: true });
    const codex = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, 'Codex', 'readonly');
    await importPaste(t, SKILL);
    // Taken out by hand (as if never written): the start of a run writes it again, before the engine runs.
    fs.rmSync(path.join(codex.workspace, '.agents'), { recursive: true, force: true });
    const th = await t.api('POST', '/threads', { agentId: codex.id });
    await t.say(th.id, 'Wat is het woord van de dag?', 20_000);
    const run = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.cli === 'codex' && l.cwd);
    assert.equal(path.resolve(run.cwd).toLowerCase(), path.resolve(codex.workspace).toLowerCase(), 'Codex runs in the werkplek');
    assert.deepEqual(has(codex, 'dagwoord'), [true, true]);
  } finally {
    delete process.env.FAKE_CLI_LOG;
    delete process.env.CODEX_HOME;
    await t.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
