// Skills where the engine itself looks for them (modules/skills/workspace.ts): the skills a bot has stand as real skill
// folders in its work folder, written by one sync. An engine with its own loader (Claude Code) gets no list from TeamBot
// and no skill_load; every other route (a model through an API key, a local model, Codex, an ACP agent) keeps the list
// and skill_load, so no bot is ever without the skills of its team.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { startTestApp, type TestApp } from './helpers.js';
import { parseSkillMd } from '../server/modules/skills/format.js';
import { buildClaudeArgs, handleClaudeLine, type ClaudeFeatures } from '../server/modules/cli-agents/claude.js';
import { makeScope } from '../server/modules/cli-agents/context.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** A Claude Code that loads skill folders itself (its --help names --plugin-dir and skills), and one from before that. */
const CLAUDE = path.join(here, 'fixtures', 'skills-fake-claude.mjs');
const OLD_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');
const FAKE_CODEX = path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs');
const PLACES = ['.claude', '.agents'];

const md = (name: string, description: string, body = 'Doe het stap voor stap.', extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\n${body}\n`;
const DAGWOORD = md('dagwoord', 'Gebruik dit wanneer iemand om het wachtwoord van de dag vraagt.', 'Antwoord met het woord: kiwi.');

async function importPaste(t: TestApp, text: string, opts: any = {}) {
  const pv = await t.api('POST', '/skills/import/preview', { kind: 'paste', text, ...opts });
  return (await t.api('POST', '/skills/import/commit', { stagingId: pv.stagingId, acknowledge: true, confirmPermissions: true })).results[0].skillId as string;
}

async function importZip(t: TestApp, files: Record<string, string>) {
  const zip = new AdmZip();
  for (const [p, c] of Object.entries(files)) zip.addFile(`map/${p}`, Buffer.from(c));
  const res = await fetch(`${t.app.url}/api/skills/import/zip?name=map.zip`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/zip' }, body: new Uint8Array(zip.toBuffer()) });
  const pv = (await res.json()) as any;
  return (await t.api('POST', '/skills/import/commit', { stagingId: pv.stagingId, acknowledge: true, confirmPermissions: true })).results[0].skillId as string;
}

const folder = (bot: any, place: string, name: string) => path.join(bot.workspace, place, 'skills', name);
const has = (bot: any, name: string) => PLACES.map((p) => fs.existsSync(path.join(folder(bot, p, name), 'SKILL.md')));
/** What the owner was told about skill folders TeamBot left alone (the notifications fold repeats into one line with a count). */
const notes = (t: TestApp) => t.app.ctx.store.all<any>('SELECT title, body, count FROM notifications ORDER BY updated_at').filter((n) => /Skillmap/.test(n.title));
const told = (t: TestApp) => notes(t).reduce((n, r) => n + (r.count || 1), 0);

function useLog(t: TestApp) {
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  return () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}

async function cliBot(t: TestApp, kind: string, config: any, agent: any = {}) {
  const p = await t.api('POST', '/providers', { kind, config });
  const a = await t.api('POST', '/agents', { name: 'CliBot', provider_id: p.id, model: '', access_mode: 'ask', ...agent });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  return { p, a, th };
}

const flag = (argv: string[], f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

// ------------------------------------------------------------------ the folders

test('one click: an installed skill stands as a skill folder in the work folder of every bot of the team, and follows every change', async () => {
  const t = await startTestApp();
  try {
    const een = await t.agent({ name: 'Een' });
    const twee = await t.agent({ name: 'Twee' });
    // A skill as it comes from outside: frontmatter an engine would act on, and a line it would run while loading.
    const id = await importZip(t, {
      'SKILL.md': md('rapport-maken', 'Maakt een weekrapport.', 'Stand van zaken: !`git status`\n\n```!\ngit log -3\n```\n\nZie checklist.md.', 'allowed-tools: Bash(git:*) Read\nmodel: opus\nhooks:\n  PreToolUse: []\n'),
      'checklist.md': 'CHECKLIST',
      'voorbeelden/een.md': 'VOORBEELD',
    });
    for (const bot of [een, twee]) {
      for (const place of PLACES) {
        const dir = folder(bot, place, 'rapport-maken');
        assert.equal(fs.readFileSync(path.join(dir, 'checklist.md'), 'utf8'), 'CHECKLIST', `${bot.name} ${place}`);
        assert.equal(fs.readFileSync(path.join(dir, 'voorbeelden', 'een.md'), 'utf8'), 'VOORBEELD');
        const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
        const parsed = parseSkillMd(text);
        assert.deepEqual(parsed.errors, []);
        // What an engine needs to find the skill, and nothing it would act on by itself.
        assert.deepEqual(Object.keys(parsed.frontmatter).sort(), ['description', 'name']);
        assert.deepEqual([parsed.meta.name, parsed.meta.description], ['rapport-maken', 'Maakt een weekrapport.']);
        assert.match(parsed.body, /Stand van zaken: `git status`/);
        assert.ok(!text.includes('!`') && !/```!/.test(text), 'no line an engine runs while loading the skill');
        const list = JSON.parse(fs.readFileSync(path.join(bot.workspace, place, 'skills', '.teambot-skills.json'), 'utf8'));
        assert.deepEqual([list.managedBy, list.skills['rapport-maken'].id, Object.keys(list.skills['rapport-maken'].files).sort()], ['TeamBot', id, ['SKILL.md', 'checklist.md', 'voorbeelden/een.md']]);
      }
    }
    // In the library the skill is as it was imported.
    assert.match(t.app.ctx.services.skills.library.readSkillMd(t.app.ctx.services.skills.library.get(een.user_id, id)), /allowed-tools: Bash\(git:\*\) Read/);

    // A bot made later has it at once.
    const drie = await t.agent({ name: 'Drie' });
    assert.deepEqual(has(drie, 'rapport-maken'), [true, true]);

    // A new version (a file changed, one gone, one new) is in every work folder.
    await t.api('PUT', `/skills/${id}/content`, { files: { 'checklist.md': 'CHECKLIST 2', 'voorbeelden/een.md': null, 'nieuw.md': 'NIEUW' } });
    for (const bot of [een, twee, drie]) {
      for (const place of PLACES) {
        const dir = folder(bot, place, 'rapport-maken');
        assert.equal(fs.readFileSync(path.join(dir, 'checklist.md'), 'utf8'), 'CHECKLIST 2');
        assert.equal(fs.readFileSync(path.join(dir, 'nieuw.md'), 'utf8'), 'NIEUW');
        assert.equal(fs.existsSync(path.join(dir, 'voorbeelden')), false, 'a file that left the skill left the folder');
      }
    }

    // Switched off by the owner: gone everywhere; on again: back. Removed: nothing of TeamBot is left.
    await t.api('PATCH', `/skills/${id}`, { status: 'disabled' });
    for (const bot of [een, twee, drie]) assert.deepEqual(has(bot, 'rapport-maken'), [false, false]);
    await t.api('PATCH', `/skills/${id}`, { status: 'active' });
    for (const bot of [een, twee, drie]) assert.deepEqual(has(bot, 'rapport-maken'), [true, true]);
    await t.api('DELETE', `/skills/${id}`);
    for (const bot of [een, twee, drie]) for (const place of PLACES) assert.equal(fs.existsSync(path.join(bot.workspace, place)), false, `${bot.name}: ${place} is gone`);
  } finally {
    await t.close();
  }
});

test('taken away from one bot: gone in its work folder only; a skill of one team stands only with the bots of that team', async () => {
  const t = await startTestApp();
  try {
    const een = await t.agent({ name: 'Een' });
    const twee = await t.agent({ name: 'Twee' });
    const id = await importPaste(t, DAGWOORD);
    const other = await importPaste(t, md('offerte', 'Schrijft een offerte.'));
    assert.deepEqual([has(een, 'dagwoord'), has(twee, 'dagwoord')], [[true, true], [true, true]]);

    // Through the skills screen of the bot…
    await t.api('PUT', `/skills/agents/${een.id}`, { skillIds: [other] });
    assert.deepEqual([has(een, 'dagwoord'), has(een, 'offerte'), has(twee, 'dagwoord')], [[false, false], [true, true], [true, true]]);
    await t.api('PUT', `/skills/agents/${een.id}`, { skillIds: [other, id] });
    assert.deepEqual(has(een, 'dagwoord'), [true, true], 'given back');
    // …and through the bot editor, which saves the list with the bot. Also its last skill.
    await t.api('PATCH', `/agents/${een.id}`, { skills: [] });
    assert.deepEqual([has(een, 'dagwoord'), has(een, 'offerte'), has(twee, 'dagwoord'), has(twee, 'offerte')], [[false, false], [false, false], [true, true], [true, true]]);
    for (const place of PLACES) assert.equal(fs.existsSync(path.join(een.workspace, place)), false);
    await t.api('PATCH', `/agents/${een.id}`, { skills: [id] });
    assert.deepEqual([has(een, 'dagwoord'), has(een, 'offerte')], [[true, true], [false, false]]);

    // Two teams: a skill installed for one team is in the work folders of that team's bots, not in the other team's.
    const owner = een.user_id;
    const team = t.app.ctx.services.teams.create(owner, { name: 'Tweede team' });
    const ver = await t.agent({ name: 'Ver' });
    t.app.ctx.services.teams.setHome(owner, team.id, ver.id);
    assert.deepEqual(has(ver, 'dagwoord'), [false, false], 'moved to another team: the first team\'s skill left its folder');
    await importPaste(t, md('alleen-team-twee', 'Voor het tweede team.'), { teamId: team.id });
    assert.deepEqual([has(ver, 'alleen-team-twee'), has(twee, 'alleen-team-twee')], [[true, true], [false, false]]);
  } finally {
    await t.close();
  }
});

test('the sync only reads which team a bot has: it never gives a bot its team, and does nothing for a bot that is removed or archived', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const first = await t.agent({ name: 'Een' });
    const owner = first.user_id;
    const teams = ctx.services.teams;
    const two = teams.create(owner, { name: 'Tweede team' });
    await importPaste(t, md('van-team-een', 'Voor het eerste team.'), { teamId: teams.defaultTeam(owner).id });
    await importPaste(t, md('van-team-twee', 'Voor het tweede team.'), { teamId: two.id });
    const row = (id: string) => ctx.store.one<{ team_id: string }>('SELECT team_id FROM team_bots WHERE agent_id = ?', id)?.team_id ?? null;

    // A bot made for the second team lands there (the teams module decides, after this module's turn), with that team's skills.
    const made = await t.agent({ name: 'Voor twee', settings: { homeTeam: two.id } });
    assert.equal(row(made.id), two.id, 'in the team it was made for');
    assert.deepEqual([has(made, 'van-team-twee'), has(made, 'van-team-een')], [[true, true], [false, false]]);

    // A bot nobody gave a team yet (made without the event that lets the teams module place it): every way into the
    // sync leaves it without one, and writes nothing.
    const loose = ctx.store.createAgent(owner, { name: 'Los' });
    ctx.services.skills.sync(loose);
    assert.equal(row(loose.id), null, 'before a run');
    ctx.services.skills.defaults.offerAll(owner);
    assert.equal(row(loose.id), null, 'the list keeper');
    ctx.events.emit(owner, 'teams.changed', {});
    assert.equal(row(loose.id), null, 'a change in the teams');
    await importPaste(t, md('later', 'Later geïnstalleerd, voor alle teams.'), { teamId: '*' });
    assert.equal(row(loose.id), null, 'the sync did not choose a team for it');
    assert.deepEqual([has(loose, 'later'), ctx.store.agent(loose.id)!.skills], [[false, false], []]);
    // The teams module places it: brought up to date from then on.
    teams.setHome(owner, two.id, loose.id);
    assert.deepEqual([row(loose.id), has(loose, 'later'), has(loose, 'van-team-twee')], [two.id, [true, true], [true, true]]);

    // Archived: left alone. Removed: no team row comes back, so its team can be emptied and removed.
    await t.api('PATCH', `/agents/${made.id}`, { archived: true });
    await importPaste(t, md('na-archief', 'Na het archiveren geïnstalleerd.'), { teamId: '*' });
    assert.deepEqual(has(made, 'na-archief'), [false, false]);
    for (const id of [made.id, loose.id]) {
      await t.api('DELETE', `/agents/${id}`);
      assert.equal(row(id), null, 'no team row after the bot is gone');
    }
    assert.deepEqual(teams.botsOf(two.id), []);
    await t.api('DELETE', `/teams/${two.id}`);
    assert.equal(teams.team(two.id), null);
  } finally {
    await t.close();
  }
});

test('a folder the owner made or changed himself is never written over, and he is told once', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Een' });
    // His own skills, made by hand: one with a name of its own, one with the name of a skill that is installed next.
    for (const name of ['eigen', 'dagwoord']) {
      fs.mkdirSync(folder(bot, '.claude', name), { recursive: true });
      fs.writeFileSync(path.join(folder(bot, '.claude', name), 'SKILL.md'), md(name, 'Van de eigenaar zelf.', 'EIGEN WERK'));
    }
    const id = await importPaste(t, DAGWOORD);
    assert.match(fs.readFileSync(path.join(folder(bot, '.claude', 'dagwoord'), 'SKILL.md'), 'utf8'), /EIGEN WERK/, 'his folder with the same name is his');
    assert.match(fs.readFileSync(path.join(folder(bot, '.claude', 'eigen'), 'SKILL.md'), 'utf8'), /EIGEN WERK/);
    assert.match(fs.readFileSync(path.join(folder(bot, '.agents', 'dagwoord'), 'SKILL.md'), 'utf8'), /kiwi/, 'the other place has TeamBot\'s');
    assert.equal(told(t), 1);
    assert.match(notes(t)[0].body, /In de werkmap van Een is de map \.claude\/skills\/dagwoord zelf gemaakt of aangepast\. TeamBot laat die staan/);
    // Told once: later changes do not say it again.
    await importPaste(t, md('offerte', 'Schrijft een offerte.'));
    t.app.ctx.services.skills.sync(t.app.ctx.store.agent(bot.id)!);
    assert.equal(told(t), 1);

    // A folder TeamBot wrote and the owner then changed: a new version of the skill does not write over his change.
    const mine = path.join(folder(bot, '.agents', 'dagwoord'), 'SKILL.md');
    fs.writeFileSync(mine, 'MIJN VERSIE');
    await t.api('PUT', `/skills/${id}/content`, { skillMd: md('dagwoord', 'Gebruik dit wanneer iemand om het wachtwoord van de dag vraagt.', 'Antwoord met het woord: mango.') });
    assert.equal(fs.readFileSync(mine, 'utf8'), 'MIJN VERSIE');
    assert.equal(told(t), 2);
    assert.match(notes(t).at(-1)!.body, /\.agents\/skills\/dagwoord/);
    await t.api('PUT', `/skills/${id}/content`, { skillMd: md('dagwoord', 'Gebruik dit wanneer iemand om het wachtwoord van de dag vraagt.', 'Antwoord met het woord: peer.') });
    assert.equal(fs.readFileSync(mine, 'utf8'), 'MIJN VERSIE');
    assert.equal(told(t), 2, 'told once');

    // He removes his folder: TeamBot's version comes back at the next change.
    fs.rmSync(folder(bot, '.agents', 'dagwoord'), { recursive: true });
    t.app.ctx.services.skills.sync(t.app.ctx.store.agent(bot.id)!);
    assert.match(fs.readFileSync(mine, 'utf8'), /peer/);

    // Uninstall: what TeamBot wrote goes, what he made or changed stays.
    fs.writeFileSync(mine, 'WEER VAN MIJ');
    await t.api('DELETE', `/skills/${id}`);
    assert.equal(fs.readFileSync(mine, 'utf8'), 'WEER VAN MIJ');
    assert.match(fs.readFileSync(path.join(folder(bot, '.claude', 'dagwoord'), 'SKILL.md'), 'utf8'), /EIGEN WERK/);
    assert.match(fs.readFileSync(path.join(folder(bot, '.claude', 'eigen'), 'SKILL.md'), 'utf8'), /EIGEN WERK/);
    assert.deepEqual(has(bot, 'offerte'), [true, true]);
  } finally {
    await t.close();
  }
});

test('scripts: in the work folder while they are on (from the install); what runs is what the owner installed; the copies of before this version are cleared', async () => {
  const t = await startTestApp();
  try {
    // "Volledige toegang" runs a script without a card, so the test needs no approval; trust is still what puts the script there for other bots.
    const bot = await t.agent({ name: 'Een', tool_groups: ['skills'] });
    const full = await t.agent({ name: 'Vol', access_mode: 'full', tool_groups: ['skills'] });
    // A copy as TeamBot made it before this version, next to something of the owner and a script's own home folder.
    const old = path.join(full.workspace, '.skills', 'groet');
    fs.mkdirSync(path.join(old, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(old, 'scripts', 'zeg.mjs'), 'oud');
    fs.writeFileSync(path.join(old, 'notitie.txt'), 'van mij');
    fs.writeFileSync(path.join(old, '.teambot-skill.json'), JSON.stringify({ managedBy: 'TeamBot', skillId: 'skl_oud', files: ['scripts/zeg.mjs'] }));
    fs.mkdirSync(path.join(full.workspace, '.skills', '.thuis', 'groet'), { recursive: true });
    fs.writeFileSync(path.join(full.workspace, '.skills', '.thuis', 'groet', 'stand.txt'), 'bewaard');

    const id = await importZip(t, { 'SKILL.md': md('groet', 'Zegt hallo met een script.', 'Voer scripts/zeg.mjs uit.'), 'scripts/zeg.mjs': 'console.log("UIT-HET-SCRIPT");\n' });
    assert.equal(fs.existsSync(path.join(old, 'scripts', 'zeg.mjs')), false, 'the old copy is cleared');
    assert.equal(fs.existsSync(path.join(old, '.teambot-skill.json')), false);
    assert.equal(fs.readFileSync(path.join(old, 'notitie.txt'), 'utf8'), 'van mij');
    assert.equal(fs.readFileSync(path.join(full.workspace, '.skills', '.thuis', 'groet', 'stand.txt'), 'utf8'), 'bewaard');

    // Installed: the script is there at once. Switched off by the owner: not with the bot that asks; a bot on "Volledige
    // toegang" may run any command, also this one. On again: there again.
    for (const place of PLACES) assert.match(fs.readFileSync(path.join(folder(bot, place, 'groet'), 'scripts', 'zeg.mjs'), 'utf8'), /UIT-HET-SCRIPT/);
    await t.api('POST', `/skills/${id}/trust`, { trusted: false });
    for (const place of PLACES) assert.equal(fs.existsSync(path.join(folder(bot, place, 'groet'), 'scripts', 'zeg.mjs')), false);
    await t.api('POST', `/skills/${id}/trust`, { trusted: true });
    for (const place of PLACES) assert.match(fs.readFileSync(path.join(folder(bot, place, 'groet'), 'scripts', 'zeg.mjs'), 'utf8'), /UIT-HET-SCRIPT/);

    const th = await t.api('POST', '/threads', { agentId: full.id });
    const run = async () => {
      t.script.push({ toolCalls: [{ name: 'skill_run_script', args: { name: 'groet', script: 'scripts/zeg.mjs' } }] }, { text: 'ok' });
      return (await t.say(th.id, 'zeg hallo', 20_000)).filter((m: any) => m.role === 'tool').at(-1)!.content as string;
    };
    assert.match(await run(), /UIT-HET-SCRIPT/);
    // Changed in the work folder (by the bot, or by anyone): what runs is still what the owner trusts, from TeamBot's own copy.
    for (const place of PLACES) fs.writeFileSync(path.join(folder(full, place, 'groet'), 'scripts', 'zeg.mjs'), 'console.log("IETS-ANDERS");\n');
    const again = await run();
    assert.match(again, /UIT-HET-SCRIPT/);
    assert.ok(!again.includes('IETS-ANDERS'));
    assert.ok(fs.existsSync(path.join(t.dir, 'skill-runs', full.id, 'groet', 'scripts', 'zeg.mjs')), 'run from a copy in TeamBot\'s own data');
    // The bot is removed: the copy its scripts ran from goes with it.
    await t.api('DELETE', `/agents/${full.id}`);
    assert.equal(fs.existsSync(path.join(t.dir, 'skill-runs', full.id)), false);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------------ every route

async function fakeOllama(steps: any[]) {
  const chats: any[] = [];
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const send = (x: any) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
      if (req.url === '/api/version') return send({ version: '0.40.15' });
      if (req.url === '/api/tags') return send({ models: [{ name: 'qwen3:4b', digest: 'q', details: { parameter_size: '4B', context_length: 40960 }, capabilities: ['completion', 'tools'] }] });
      if (req.url === '/api/ps') return send({ models: [{ name: 'qwen3:4b', context_length: 32768 }] });
      if (req.url === '/api/show') return send({ model_info: {}, capabilities: ['completion', 'tools'] });
      if (req.url === '/v1/models') return send({ data: [{ id: 'qwen3:4b' }] });
      if (req.url === '/v1/chat/completions') {
        chats.push(b ? JSON.parse(b) : null);
        const step = steps.shift() || { content: 'klaar' };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: step }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, chats, close: () => new Promise<void>((r) => s.close(() => r())) };
}

const LIST = /## Skills\n[^\n]*`skill_load`[^\n]*\n- dagwoord: Gebruik dit wanneer iemand om het wachtwoord van de dag vraagt\./;

test('a model through an API key and a local model: the list of skills in the instructions and skill_load, as before', async () => {
  const ol = await fakeOllama([{ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'skill_load', arguments: '{"name":"dagwoord"}' } }] }, { content: 'Het woord is kiwi.' }]);
  const t = await startTestApp();
  try {
    await importPaste(t, DAGWOORD);
    // Through an API key (the scripted provider of the tests).
    const api = await t.agent({ name: 'Api' });
    const th = await t.api('POST', '/threads', { agentId: api.id });
    t.script.push({ toolCalls: [{ name: 'skill_load', args: { name: 'dagwoord' } }] }, { text: 'kiwi' });
    const msgs = await t.say(th.id, 'Wat is het wachtwoord van de dag?');
    assert.match(t.requests[0].system, LIST);
    assert.ok(t.requests[0].tools.some((x) => x.name === 'skill_load'));
    assert.match(msgs.find((m) => m.role === 'tool')!.content, /Antwoord met het woord: kiwi\./);
    assert.deepEqual(has(api, 'dagwoord'), [true, true], 'the folders are there too, for when this bot runs on an engine that reads them');

    // A local model (Ollama), through its real adapter.
    const prov = await t.api('POST', '/providers', { kind: 'ollama', base_url: ol.url + '/v1' });
    const local = await t.api('POST', '/agents', { name: 'Lokaal', provider_id: prov.id, model: 'qwen3:4b', access_mode: 'auto' });
    const lth = await t.api('POST', '/threads', { agentId: local.id });
    const lmsgs = await t.say(lth.id, 'Wat is het wachtwoord van de dag?', 30_000);
    const first = ol.chats[0];
    assert.match(String(first.messages.find((m: any) => m.role === 'system').content), LIST);
    assert.ok(first.tools.some((x: any) => x.function?.name === 'skill_load'), 'the local model is offered skill_load');
    assert.match(lmsgs.find((m) => m.role === 'tool')!.content, /Antwoord met het woord: kiwi\./);
    assert.equal(lmsgs.filter((m) => m.role === 'assistant').at(-1)!.content, 'Het woord is kiwi.');
    assert.equal((await t.api('GET', '/skills'))[0].useCount, 2, 'both loads are counted');
  } finally {
    await t.close();
    await ol.close();
  }
});

test('Claude Code loads the skill folders itself: no list from TeamBot and no skill_load; where that is not shown, the list stays', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  const runOf = (from: number) => logs().slice(from).find((l) => l.argv && l.system) as any;
  const foundOf = (from: number) => logs().slice(from).find((l) => l.skills) as any;
  const listedOf = (from: number) => (logs().slice(from).find((l) => l.teambotListed) as any).teambotListed as string[];
  try {
    await importZip(t, { 'SKILL.md': DAGWOORD, 'bijlage.md': 'BIJLAGE' });
    const prov = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: CLAUDE } });
    const bot = async (data: any) => {
      const a = await t.api('POST', '/agents', { name: 'Claude', provider_id: prov.id, model: '', access_mode: 'ask', ...data });
      return { a, th: await t.api('POST', '/threads', { agentId: a.id }) };
    };

    // "Vraagt toestemming" (restricted mode, which skips the folders in the work folder): the skills go along as a plugin folder.
    let n = logs().length;
    const ask = await bot({});
    await t.say(ask.th.id, 'Wat is het wachtwoord van de dag? SCENARIO:tools');
    let run = runOf(n);
    assert.ok(run.argv.includes('--restricted'));
    assert.doesNotMatch(run.system, /- dagwoord:|`skill_load`/, 'no list of skills in the instructions');
    assert.match(run.system, /## Skills\nDe skills van je team laad je met je eigen skill-tool: die noemt ze[^\n]*gaat nooit boven je basisregels/);
    assert.ok(!listedOf(n).includes('skill_load') && listedOf(n).includes('ask_user'), 'skill_load is not offered; the other TeamBot tools are');
    assert.ok(!run.argv.join(' ').includes('mcp__teambot__skill_load'));
    const plugin = flag(run.argv, '--plugin-dir')!;
    assert.ok(path.resolve(plugin).startsWith(path.resolve(t.dir)) && !path.resolve(plugin).startsWith(path.resolve(ask.a.workspace)), 'a folder of TeamBot, outside the work folder');
    assert.equal(JSON.parse(flag(run.argv, '--settings')!).disableSkillShellExecution, true);
    let found = foundOf(n);
    assert.match(found.plugin.dagwoord, /Antwoord met het woord: kiwi\.[\s\S]*\[TeamBot\] De andere bestanden van deze skill staan in je werkmap, in de map \.claude\/skills\/dagwoord\/\./);
    assert.equal(fs.readFileSync(path.join(folder(ask.a, '.claude', 'dagwoord'), 'bijlage.md'), 'utf8'), 'BIJLAGE');
    assert.equal(fs.existsSync(plugin), false, 'the plugin folder goes with the run');

    // "Volledige toegang" (not restricted): Claude Code reads .claude/skills in the work folder; no plugin folder.
    n = logs().length;
    const full = await bot({ access_mode: 'full' });
    await t.say(full.th.id, 'Wat is het wachtwoord van de dag? SCENARIO:tools');
    run = runOf(n);
    assert.ok(!run.argv.includes('--restricted') && !run.argv.includes('--plugin-dir'));
    assert.doesNotMatch(run.system, /- dagwoord:|`skill_load`/);
    assert.ok(!listedOf(n).includes('skill_load'));
    found = foundOf(n);
    assert.match(found.folder.dagwoord, /Antwoord met het woord: kiwi\./);

    // A skill taken away from this bot is not in what Claude Code finds.
    n = logs().length;
    await t.api('PUT', `/skills/agents/${ask.a.id}`, { skillIds: [] });
    await t.say(ask.th.id, 'En nu?');
    assert.deepEqual([flag(runOf(n).argv, '--plugin-dir'), foundOf(n).folder], [undefined, {}]);

    // Read-only (not shown with a real run): TeamBot's list and skill_load, as on every other route.
    n = logs().length;
    const ro = await bot({ access_mode: 'readonly' });
    await t.say(ro.th.id, 'Wat is het wachtwoord van de dag? SCENARIO:tools');
    assert.match(runOf(n).system, LIST);
    assert.ok(listedOf(n).includes('skill_load') && !runOf(n).argv.includes('--plugin-dir'));

    // A Claude Code from before it loaded skill folders: the list and skill_load too.
    n = logs().length;
    const old = await cliBot(t, 'claude-code', { path: OLD_CLAUDE });
    await t.say(old.th.id, 'Wat is het wachtwoord van de dag? SCENARIO:tools');
    assert.match(runOf(n).system, LIST);
    assert.ok(listedOf(n).includes('skill_load') && !runOf(n).argv.includes('--plugin-dir'));
  } finally {
    await t.close();
  }
});

test('Codex, OpenCode and another ACP agent: the folders are in the work folder, and the list with skill_load stays until a real run shows they load them', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  try {
    await importPaste(t, DAGWOORD);
    const codex = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, { access_mode: 'readonly' });
    await t.say(codex.th.id, 'Wat is het wachtwoord van de dag?');
    assert.match(logs().find((l) => l.cli === 'codex' && l.argv && l.prompt)!.prompt, /<teambot_instructies>[\s\S]*## Skills\n[^\n]*`skill_load`[^\n]*\n- dagwoord:/);
    assert.deepEqual(has(codex.a, 'dagwoord'), [true, true]);

    for (const [kind, config] of [
      ['acp-custom', { command: FAKE_ACP, args: [] }],
      ['opencode', { path: FAKE_ACP }],
    ] as const) {
      const n = logs().length;
      const acp = await cliBot(t, kind, config);
      await t.say(acp.th.id, 'Wat is het wachtwoord van de dag?', 30_000);
      const prompt = logs().slice(n).find((l) => l.method === 'session/prompt')!.params.text as string;
      assert.match(prompt, /<teambot_instructies>[\s\S]*## Skills\n[^\n]*`skill_load`[^\n]*\n- dagwoord:/, kind);
      assert.deepEqual(has(acp.a, 'dagwoord'), [true, true], kind);
    }
  } finally {
    delete process.env.CODEX_HOME;
    await t.close();
  }
});

test('a bot that works in a folder of the owner or of another program: TeamBot writes nothing there, and the bot still has its skills', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-buiten-'));
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  const tree = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name + '/', ...tree(path.join(dir, e.name)).map((x) => `${e.name}/${x}`)] : [e.name])).sort();
  try {
    fs.mkdirSync(path.join(outside, '.claude', 'skills', 'van-het-project'), { recursive: true });
    fs.writeFileSync(path.join(outside, '.claude', 'skills', 'van-het-project', 'SKILL.md'), md('van-het-project', 'Hoort bij dit project.'));
    fs.writeFileSync(path.join(outside, 'README.md'), 'een project van iemand anders');
    const before = tree(outside);
    // Bots pointed at that folder before and after the skill is installed, on three kinds of engine.
    const api = await t.agent({ name: 'Api', workspace: outside });
    const id = await importZip(t, { 'SKILL.md': DAGWOORD, 'bijlage.md': 'BIJLAGE' });
    const claude = await cliBot(t, 'claude-code', { path: CLAUDE }, { name: 'Claude', workspace: outside });
    const claudeFull = await t.api('POST', '/agents', { name: 'Vol', provider_id: claude.p.id, model: '', access_mode: 'full', workspace: outside });
    const codex = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, { name: 'Codex', access_mode: 'readonly', workspace: outside });
    assert.deepEqual(tree(outside), before, 'nothing written at install or when a bot is made');

    // A model through an API key: the list and skill_load.
    const th = await t.api('POST', '/threads', { agentId: api.id });
    t.script.push({ toolCalls: [{ name: 'skill_load', args: { name: 'dagwoord' } }] }, { text: 'kiwi' });
    assert.match((await t.say(th.id, 'Wat is het wachtwoord van de dag?')).find((m) => m.role === 'tool')!.content, /kiwi/);
    assert.match(t.requests[0].system, LIST);

    // Claude Code: the skills from a folder of TeamBot (a plugin folder), in restricted mode and without it.
    for (const [bot, thread] of [
      [claude.a, claude.th],
      [claudeFull, await t.api('POST', '/threads', { agentId: claudeFull.id })],
    ]) {
      const n = logs().length;
      await t.say(thread.id, 'Wat is het wachtwoord van de dag? SCENARIO:tools');
      const run = logs().slice(n).find((l) => l.argv && l.system)!;
      assert.equal(path.resolve(run.cwd).toLowerCase(), path.resolve(outside).toLowerCase(), bot.name);
      assert.ok(path.resolve(flag(run.argv, '--plugin-dir')!).startsWith(path.resolve(t.dir)), `${bot.name}: a plugin folder of TeamBot`);
      assert.doesNotMatch(run.system, /- dagwoord:|`skill_load`/);
      const found = logs().slice(n).find((l) => l.skills)!;
      assert.match(found.plugin.dagwoord, /Antwoord met het woord: kiwi\.[\s\S]*\[TeamBot\] De andere bestanden van deze skill \(bijlage\.md\) lees je met de TeamBot-tool skill_read_file \(naam: dagwoord\)\./);
      assert.deepEqual(Object.keys(found.folder), ['van-het-project'], 'the project keeps its own skills, and only those');
      assert.ok(!logs().slice(n).find((l) => l.teambotListed)!.teambotListed.includes('skill_load'));
    }

    // Codex (no way shown to hand it a folder of TeamBot): the list and skill_load.
    await t.say(codex.th.id, 'Wat is het wachtwoord van de dag?');
    assert.match(logs().find((l) => l.cli === 'codex' && l.argv && l.prompt)!.prompt, /## Skills\n[^\n]*`skill_load`[^\n]*\n- dagwoord:/);

    // Changes to the skill, taking it away and removing it: still nothing in that folder.
    await t.api('PUT', `/skills/${id}/content`, { files: { 'bijlage.md': 'BIJLAGE 2' } });
    await t.api('PUT', `/skills/agents/${api.id}`, { skillIds: [] });
    await t.api('DELETE', `/skills/${id}`);
    assert.deepEqual(tree(outside), before, 'after runs and changes the folder holds no file from TeamBot');
    assert.equal(fs.readFileSync(path.join(outside, 'README.md'), 'utf8'), 'een project van iemand anders');
  } finally {
    delete process.env.CODEX_HOME;
    await t.close();
    fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ------------------------------------------------------------------ a later conversation, a colleague, the count

test('a bot writes a skill: it has it in a later conversation, and so has a colleague in its next turn — on an API model and on Claude Code', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const maker = await t.agent({ name: 'Maker' });
    const colleague = await t.agent({ name: 'Collega' });
    const claude = await cliBot(t, 'claude-code', { path: CLAUDE }, { name: 'Claude' });
    const th = await t.api('POST', '/threads', { agentId: maker.id });
    t.script.push({ toolCalls: [{ name: 'skill_save', args: { name: 'dagwoord', description: 'Gebruik dit wanneer iemand om het wachtwoord van de dag vraagt.', instructions: 'Antwoord met het woord: kiwi.' } }] }, { text: 'Vastgelegd.' });
    const saved = (await t.say(th.id, 'Leg vast hoe je het wachtwoord van de dag geeft.')).find((m) => m.role === 'tool')!;
    assert.match(saved.content, /Skill "dagwoord" is opgeslagen en meteen actief voor alle bots van je team\./);

    // The maker, in a new conversation.
    t.requests.length = 0;
    const later = await t.api('POST', '/threads', { agentId: maker.id });
    t.script.push({ toolCalls: [{ name: 'skill_load', args: { name: 'dagwoord' } }] }, { text: 'kiwi' });
    const again = await t.say(later.id, 'Wat is het wachtwoord van de dag?');
    assert.match(t.requests[0].system, LIST);
    assert.match(again.find((m) => m.role === 'tool')!.content, /Antwoord met het woord: kiwi\./);
    // A colleague in the same team, on an API model.
    t.requests.length = 0;
    const cth = await t.api('POST', '/threads', { agentId: colleague.id });
    t.script.push({ toolCalls: [{ name: 'skill_load', args: { name: 'dagwoord' } }] }, { text: 'kiwi' });
    const theirs = await t.say(cth.id, 'Wat is het wachtwoord van de dag?');
    assert.match(t.requests[0].system, LIST);
    assert.match(theirs.find((m) => m.role === 'tool')!.content, /Antwoord met het woord: kiwi\./);
    // A colleague on Claude Code: the skill is in what Claude Code finds, with nobody having switched anything on.
    assert.deepEqual(has(claude.a, 'dagwoord'), [true, true], 'in its work folder as soon as the skill was written');
    await t.say(claude.th.id, 'Wat is het wachtwoord van de dag?');
    const found = logs().find((l) => l.skills)!;
    assert.match(found.plugin.dagwoord, /Antwoord met het woord: kiwi\./);
    assert.match(found.folder.dagwoord, /Antwoord met het woord: kiwi\./);
  } finally {
    await t.close();
  }
});

test('a skill that Claude Code loads itself is counted where skill_load counts', async () => {
  const t = await startTestApp();
  try {
    const id = await importPaste(t, DAGWOORD);
    const { a, th, p } = await cliBot(t, 'claude-code', { path: CLAUDE });
    const s = makeScope(t.app.ctx, { id: p.id, kind: 'claude-code' } as any, { agentId: a.id, threadId: th.id, runId: 'run_x', userId: a.user_id, prompt: '' } as any, new AbortController().signal, () => {});
    const st: any = { text: '', reasoning: '', streamedMsgs: new Set(), currentMsg: null, needSep: false, tools: new Map(), open: new Set(), result: null, initSeen: false };
    const use = (tu: string, name: string, input: any) => handleClaudeLine(s, st, JSON.stringify({ type: 'assistant', message: { id: 'm' + tu, content: [{ type: 'tool_use', id: tu, name, input }] }, parent_tool_use_id: null }));
    const result = (tu: string, isError = false) => handleClaudeLine(s, st, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tu, content: 'x', is_error: isError }] }, parent_tool_use_id: null }));
    const count = async () => (await t.api('GET', `/skills/${id}`)).useCount;
    // As a plugin's skill (restricted mode) and as a skill of the work folder.
    use('t1', 'Skill', { skill: 'team:dagwoord' });
    assert.equal(await count(), 0, 'counted when the skill was really loaded');
    result('t1');
    use('t2', 'Skill', { skill: 'dagwoord' });
    result('t2');
    assert.equal(await count(), 2);
    // A load that failed, a skill that is not TeamBot's, another tool: not counted.
    use('t3', 'Skill', { skill: 'dagwoord' });
    result('t3', true);
    use('t4', 'Skill', { skill: 'eigen-skill-van-de-eigenaar' });
    result('t4');
    use('t5', 'Read', { file_path: 'x' });
    result('t5');
    assert.equal(await count(), 2);
    assert.ok((await t.api('GET', `/skills/${id}`)).lastUsedAt);
    assert.equal(t.app.ctx.store.all("SELECT id FROM audit WHERE kind = 'skill.loaded' AND agent_id = ?", a.id).length, 2);
  } finally {
    await t.close();
  }
});

test('Claude Code start options: a plugin folder only with the skills of the bot, never in chat mode', () => {
  const F: ClaudeFeatures = { partial: true, appendFile: true, restricted: true, permissionPrompts: true, tools: true, effort: true, settings: true, settingSources: true, skills: true, modes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] };
  const base = { maxTurns: 10, addDirs: [], allowedTools: [], disallowedTools: [], extraArgs: [], loadUserSettings: false, useUserMcp: false };
  const withPlugin = buildClaudeArgs(F, { ...base, mode: 'ask', pluginDir: 'C:/x/skills' });
  assert.equal(flag(withPlugin, '--plugin-dir'), 'C:/x/skills');
  assert.ok(withPlugin.includes('--restricted') && flag(withPlugin, '--tools')!.split(',').includes('Skill'));
  assert.equal(JSON.parse(flag(withPlugin, '--settings')!).disableSkillShellExecution, true);
  const without = buildClaudeArgs(F, { ...base, mode: 'ask' });
  assert.ok(!without.includes('--plugin-dir') && !without.join(' ').includes('disableSkillShellExecution'));
  assert.ok(!buildClaudeArgs(F, { ...base, mode: 'chat', pluginDir: 'C:/x/skills' }).includes('--plugin-dir'));
});
