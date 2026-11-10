import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { resolveInWorkspace, wholeComputer } from '../server/tools/builtin/files.js';
import { commandPaths } from '../server/tools/builtin/command-risk.js';
import { gate } from '../server/modules/cli-agents/permissions.js';
import type { Agent } from '../server/core/types.js';

/**
 * "Volledige toegang" = the whole computer (10 nov): the owner's hoofdbot could not leave its work folder and asked for
 * every step. Keys, TeamBot's own data and the folders the owner closed stay shut; every other level stays in its folders.
 */

const pending = async (t: any) => {
  for (let i = 0; i < 40; i++) {
    const x = (await t.api('GET', '/approvals')).find((y: any) => y.status === 'pending');
    if (x) return x;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
};

test('whole computer: a full bot reads and writes outside its folders without a card; other levels stay inside', async () => {
  const t = await startTestApp();
  const elders = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-elders-'));
  try {
    fs.writeFileSync(path.join(elders, 'notitie.txt'), 'van de eigenaar');
    const full = await t.agent({ access_mode: 'full', tool_groups: ['files', 'shell'] });
    const auto = await t.agent({ access_mode: 'auto', tool_groups: ['files', 'shell'] });
    const A = (id: string) => t.app.ctx.store.agent(id) as Agent;
    assert.ok(wholeComputer(A(full.id)), 'full = whole computer');
    assert.equal(wholeComputer(A(auto.id)), null, 'auto stays in its folders');
    assert.equal(wholeComputer({ ...A(full.id), settings: { ownFoldersOnly: true } } as Agent), null, 'the owner can keep a full bot in its folders');
    assert.equal(wholeComputer({ ...A(full.id), settings: { sharedRun: true } } as Agent), null, 'never a shared run');

    assert.equal(resolveInWorkspace(A(full.id), path.join(elders, 'notitie.txt')), path.join(elders, 'notitie.txt'));
    assert.equal(resolveInWorkspace(A(full.id), path.join(elders, 'nieuw.txt'), { write: true }), path.join(elders, 'nieuw.txt'));
    assert.throws(() => resolveInWorkspace(A(auto.id), path.join(elders, 'notitie.txt')), /buiten de toegestane werkmap/);
    // a relative path is still the bot's own work folder
    assert.equal(resolveInWorkspace(A(full.id), 'a.txt'), path.resolve(full.workspace, 'a.txt'));

    // in a real turn: read and write elsewhere, no approval card
    const th = await t.api('POST', '/threads', { agentId: full.id });
    t.script.push(
      { toolCalls: [{ name: 'read_file', args: { path: path.join(elders, 'notitie.txt') } }] },
      { toolCalls: [{ name: 'write_file', args: { path: path.join(elders, 'antwoord.txt'), content: 'gelezen' } }] },
      { text: 'Klaar.' },
    );
    await t.say(th.id, 'lees de notitie en schrijf een antwoord');
    assert.equal(fs.readFileSync(path.join(elders, 'antwoord.txt'), 'utf8'), 'gelezen');
    assert.equal((await t.api('GET', '/approvals')).length, 0, 'no card');

    // the bot is told, or it never tries
    const sys = String(t.requests[0].system);
    assert.match(sys, /volledige toegang tot deze computer/);
  } finally {
    await t.close();
    fs.rmSync(elders, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('whole computer: keys, TeamBot\'s own data and the folders the owner closed stay shut', async () => {
  const t = await startTestApp();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dicht-'));
  const dicht = path.join(base, 'Sleutels');
  const open = path.join(base, 'Werk');
  try {
    fs.mkdirSync(dicht);
    fs.mkdirSync(open);
    fs.writeFileSync(path.join(dicht, 'BANK_KEY'), 'geheim');
    await assert.rejects(t.api('PUT', '/settings', { closedFolders: ['relatief'] }), /400/);
    await t.api('PUT', '/settings', { closedFolders: [dicht] });
    const a = await t.agent({ access_mode: 'full', tool_groups: ['files', 'shell'] });
    const agent = t.app.ctx.store.agent(a.id) as Agent;
    const data = t.app.ctx.config.dataDir;

    assert.throws(() => resolveInWorkspace(agent, path.join(dicht, 'BANK_KEY')), /dicht voor bots/);
    assert.throws(() => resolveInWorkspace(agent, path.join(data, 'teambot.db')), /dicht voor bots/);
    assert.throws(() => resolveInWorkspace(agent, path.join(data, 'master.key')), /beschermd/);
    assert.throws(() => resolveInWorkspace(agent, path.join(base, '.ssh', 'id_rsa')), /beschermd/);
    assert.throws(() => resolveInWorkspace(agent, path.join(base, 'project', '.env'), { write: true }), /beschermd/);
    assert.throws(() => resolveInWorkspace(agent, path.join(base, 'Chrome', 'Login Data')), /beschermd/);
    // its own work folder lies in TeamBot's data and stays its own
    assert.ok(resolveInWorkspace(agent, path.join(a.workspace, 'x.txt'), { write: true }));

    // commands: an ordinary folder elsewhere no longer counts as "outside"; closed folders and keys are refused
    const whole = wholeComputer(agent);
    const o = { roots: [a.workspace], dataDir: data, whole };
    assert.deepEqual(commandPaths(`Get-ChildItem "${open}"`, o), { outside: [], keys: [] });
    assert.equal(commandPaths(`Get-Content "${path.join(dicht, 'BANK_KEY')}"`, o).keys.length, 1);
    assert.equal(commandPaths(`Get-Content "${path.join(data, 'local-token')}"`, o).keys.length, 1);
    assert.equal(commandPaths(`type "${path.join(os.homedir(), '.ssh', 'id_rsa')}"`, o).keys.length, 1);
    // without the whole computer the same folder is "outside" (asks)
    assert.equal(commandPaths(`Get-ChildItem "${path.join(os.homedir(), 'Documents', 'werk')}"`, { roots: [a.workspace], dataDir: data }).outside.length, 1);

    // the CLI gate: a command elsewhere runs, a closed folder is refused, no card either way
    const gs = { ctx: t.app.ctx, agent, thread: null, run: null, userId: a.user_id, signal: new AbortController().signal, ns: 'claude-code' };
    assert.equal((await gate(gs, { tool: 'Bash', risk: 'exec', summary: 'x', input: {}, command: `Get-ChildItem "${open}"` })).allow, true);
    assert.equal((await gate(gs, { tool: 'Write', risk: 'write', summary: 'x', input: {}, paths: [path.join(open, 'a.txt')] })).allow, true);
    const shut = await gate(gs, { tool: 'Bash', risk: 'exec', summary: 'x', input: {}, command: `Get-Content "${path.join(dicht, 'BANK_KEY')}"` });
    assert.equal(shut.allow, false);
    assert.match(shut.message, /beschermde map/);
    assert.equal((await gate(gs, { tool: 'Read', risk: 'read', summary: 'x', input: {}, paths: [path.join(dicht, 'BANK_KEY')] })).allow, false);
    assert.equal(await pending(t), null, 'nothing asked');

    // TeamBot's own terminal tool: the closed folder is refused before anything runs
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'run_command', args: { command: `Get-Content "${path.join(dicht, 'BANK_KEY')}"` } }] }, { text: 'Kan niet.' });
    await t.say(th.id, 'lees de sleutel');
    const msgs = t.app.ctx.store.messages(th.id, { limit: 40 });
    assert.match(JSON.stringify(msgs), /beschermde map of beschermd bestand/);
    assert.doesNotMatch(JSON.stringify(msgs), /geheim"/);
  } finally {
    await t.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('owner rules: the reviewer only checks the rules, not whether the step fits the last message; an unreadable answer is retried', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'full', tool_groups: ['files'] });
    const r = await t.api('POST', '/bot-rules', { agentId: a.id, text: 'Vraag altijd eerst voordat je geld uitgeeft of een advertentiebudget verhoogt' });
    assert.equal(r.review, true);
    const th = await t.api('POST', '/threads', { agentId: a.id });
    // a greeting as last message, ongoing work: the step runs (first answer unreadable, second says allow)
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'notities.md', content: 'verder met het plan' } }] }, { text: '' }, { text: '{"verdict":"allow","reason":"Geen geld mee gemoeid"}' }, { text: 'Klaar.' });
    await t.say(th.id, 'Yo');
    assert.equal((await t.api('GET', '/approvals')).length, 0, 'no card for a file that has nothing to do with the rule');
    assert.equal(fs.readFileSync(path.resolve(a.workspace, 'notities.md'), 'utf8'), 'verder met het plan');
    const reviews = t.requests.filter((q: any) => /regels van de eigenaar/.test(String(q.system)));
    assert.equal(reviews.length, 2, 'asked again after an unreadable answer');
    assert.doesNotMatch(String(reviews[0].system), /volgt niet duidelijk uit de opdracht/);
    assert.match(JSON.stringify(reviews[0].messages), /geld uitgeeft/);
    assert.doesNotMatch(JSON.stringify(reviews[0].messages), /Opdracht van de gebruiker/);
    assert.equal(reviews[0].reasoning, 'low');
    assert.ok((reviews[0].maxTokens || 0) >= 1000, 'room for the answer next to the thinking');
    // twice unreadable: fails closed with a reason that says so
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'b.md', content: 'x' } }] }, { text: 'geen json' }, { text: '' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'ga door' });
    const card = await pending(t);
    assert.ok(card, 'asks');
    assert.match(card.summary, /gaf geen leesbaar antwoord/);
    await t.api('POST', `/approvals/${card.id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
  } finally {
    await t.close();
  }
});
