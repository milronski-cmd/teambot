import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { safeFolderName, WERKPLEK_SETTING } from '../server/modules/folders/werkplek.js';
import { resolveInWorkspace } from '../server/tools/builtin/files.js';
import type { Agent } from '../server/core/types.js';

/** "Eigen werkplek" (0.4.5): every new bot gets its own folder under the team folder, and works there by default. */

async function withTeamFolder(fn: (t: TestApp, team: string) => Promise<void>) {
  const t = await startTestApp();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-werkplek-'));
  const team = path.join(base, 'Teammap');
  try {
    await t.api('PUT', '/folders/team', { path: team, create: true });
    await fn(t, team);
  } finally {
    await t.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const agentOf = (t: TestApp, id: string) => t.app.ctx.store.agent(id) as Agent;

test('werkplek: folder names that work everywhere', () => {
  assert.equal(safeFolderName('Mila'), 'Mila');
  assert.equal(safeFolderName('  Mail/Agenda: hulp? '), 'Mail-Agenda- hulp-');
  assert.equal(safeFolderName('...'), 'Bot');
  assert.equal(safeFolderName(''), 'Bot');
  assert.equal(safeFolderName('CON'), 'CON-bot');
  assert.ok(safeFolderName('x'.repeat(200)).length <= 60);
});

test('werkplek: a new bot gets its own folder under the team folder; a taken name gets "(2)"', async () => {
  await withTeamFolder(async (t, team) => {
    const a = await t.agent({ name: 'Mila' });
    assert.equal(path.resolve(a.workspace), path.resolve(team, 'Mila'));
    assert.ok(fs.statSync(a.workspace).isDirectory(), 'the folder exists right away');
    const b = await t.agent({ name: 'Mila' });
    assert.equal(path.resolve(b.workspace), path.resolve(team, 'Mila (2)'));
    // a folder of the team that already exists is never taken over
    fs.mkdirSync(path.join(team, 'Noor'));
    fs.writeFileSync(path.join(team, 'Noor', 'van-de-eigenaar.txt'), 'x');
    const c = await t.agent({ name: 'Noor' });
    assert.equal(path.resolve(c.workspace), path.resolve(team, 'Noor (2)'));
    // a folder the owner chose himself stays his choice
    const own = path.join(path.dirname(team), 'eigen');
    const d = await t.agent({ name: 'Eigen', workspace: own });
    assert.equal(path.resolve(d.workspace), path.resolve(own));
    // a copy gets its own werkplek too
    const copy = await t.api('POST', `/agents/${a.id}/duplicate`);
    assert.equal(path.resolve(copy.workspace), path.resolve(team, 'Mila (kopie)'));
  });
});

test('werkplek: without a team folder (or switched off) a bot keeps its folder in TeamBot\'s data folder', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Mila' });
    assert.ok(path.resolve(a.workspace).startsWith(path.resolve(t.dir)), a.workspace);
  } finally {
    await t.close();
  }
  await withTeamFolder(async (t) => {
    t.app.ctx.store.setSetting(t.app.ctx.auth.owner()!.id, WERKPLEK_SETTING, false);
    const a = await t.agent({ name: 'Mila' });
    assert.ok(path.resolve(a.workspace).startsWith(path.resolve(t.dir)), a.workspace);
  });
});

test('werkplek: a colleague\'s werkplek is readable, never writable; the team folder and the own werkplek are', async () => {
  await withTeamFolder(async (t, team) => {
    const mila = agentOf(t, (await t.agent({ name: 'Mila' })).id);
    const noor = agentOf(t, (await t.agent({ name: 'Noor' })).id);
    fs.writeFileSync(path.join(noor.workspace, 'plan.md'), 'van Noor');
    // reading Noor's file is fine
    assert.equal(resolveInWorkspace(mila, path.join(noor.workspace, 'plan.md')), path.join(noor.workspace, 'plan.md'));
    // writing there is not
    assert.throws(() => resolveInWorkspace(mila, path.join(noor.workspace, 'plan.md'), { write: true }), /werkplek van Noor/);
    // the shared team folder and the own werkplek are writable
    assert.ok(resolveInWorkspace(mila, path.join(team, 'gedeeld.md'), { write: true }));
    assert.ok(resolveInWorkspace(mila, 'eigen.md', { write: true }).startsWith(mila.workspace));
    // the owner gave Mila Noor's folder on purpose (read-write extra folder): then she may
    const given = t.app.ctx.store.updateAgent(mila.id, { settings: { ...mila.settings, folders: [{ path: noor.workspace, mode: 'rw', label: 'Map van Noor' }] } });
    assert.ok(resolveInWorkspace(given, path.join(noor.workspace, 'plan.md'), { write: true }));
    // through the real file tool as well
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: path.join(noor.workspace, 'notitie.md'), content: 'hallo' } }] }, { text: 'klaar' });
    const th = t.app.ctx.chat.threadForAgent(t.app.ctx.auth.owner()!.id, noor.id);
    const other = agentOf(t, (await t.agent({ name: 'Sam' })).id);
    const th2 = t.app.ctx.chat.threadForAgent(t.app.ctx.auth.owner()!.id, other.id);
    await t.say(th2.id, 'schrijf een notitie bij Noor');
    assert.equal(fs.existsSync(path.join(noor.workspace, 'notitie.md')), false, 'Sam cannot write on Noor\'s desk');
    assert.ok(th);
  });
});

test('werkplek: the terminal works in the werkplek; outside it asks first (every mode), key folders are refused', async () => {
  await withTeamFolder(async (t, team) => {
    const a = agentOf(t, (await t.agent({ name: 'Mila', tool_groups: ['files', 'shell'], access_mode: 'auto' })).id);
    const tool = t.app.ctx.tools.get('run_command')!;
    const thread = t.app.ctx.chat.threadForAgent(a.user_id, a.id);
    const ctxOf = { agent: a, thread, userId: a.user_id };
    const outside = process.platform === 'win32' ? 'C:\\Users\\Public\\Documents\\x.txt' : '/home/someone/x.txt';
    // inside: an ordinary command
    assert.equal(tool.riskFor!({ command: 'dir' }, ctxOf), 'exec');
    assert.equal(tool.riskFor!({ command: `type "${path.join(a.workspace, 'a.txt')}"` }, ctxOf), 'exec');
    assert.equal(tool.riskFor!({ command: `type "${path.join(team, 'gedeeld.txt')}"` }, ctxOf), 'exec', 'the team folder is part of the bot\'s folders');
    // outside: asks, with the reason on the card
    assert.equal(tool.riskFor!({ command: `Get-Content "${outside}"` }, ctxOf), 'danger');
    // a `..` escape out of the folders (this test's werkplek lives in the temp folder, which programs may use: go to the root)
    const up = ('..' + path.sep).repeat(12);
    assert.equal(tool.riskFor!({ command: `Get-Content ${up}buiten-de-werkplek${path.sep}x.txt` }, ctxOf), 'danger');
    assert.match(tool.summarize!({ command: `Get-Content "${outside}"` }, { agent: a }), /buiten de werkplek van de bot/);
    const impact = typeof tool.impact === 'function' ? tool.impact({ command: `Get-Content "${outside}"` }, a) : tool.impact;
    assert.equal(impact, 'external', 'also "Volledige toegang" asks for work outside the werkplek');
    assert.equal(t.app.ctx.broker.decide(a, { name: 'run_command', risk: 'danger', impact: 'external' }), 'ask');
    assert.equal(t.app.ctx.broker.decide({ ...a, access_mode: 'full' }, { name: 'run_command', risk: 'danger', impact: 'external' }), 'ask');
    // key folders: refused before any card
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    assert.match(tool.refuse!({ command: `type "${path.join(home, '.ssh', 'id_ed25519')}"` }, ctxOf) || '', /beschermde map/);
    assert.match(tool.refuse!({ command: `type "${path.join(t.dir, 'teambot.db')}"` }, ctxOf) || '', /gegevens van TeamBot/);
    assert.equal(tool.refuse!({ command: 'dir' }, ctxOf), null);
    // the real path through the runner: in "Automatisch" a command outside the werkplek waits for the owner
    t.script.push({ toolCalls: [{ name: 'run_command', args: { command: `Get-Content "${outside}"` } }] }, { text: 'klaar' });
    await t.api('POST', `/threads/${thread.id}/messages`, { content: 'lees dat bestand' });
    let pending: any[] = [];
    for (let i = 0; i < 100 && !pending.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pending = t.app.ctx.store.all<any>("SELECT * FROM approvals WHERE status = 'pending' AND agent_id = ?", a.id);
    }
    assert.equal(pending.length, 1, 'an approval card for the command outside the werkplek');
    assert.match(pending[0].summary, /buiten de werkplek/);
    t.app.ctx.runs.stopAll(a.user_id);
  });
});

test('werkplek: renamed right after it was made, the bot takes its still-empty folder along (never one with files)', async () => {
  await withTeamFolder(async (t, team) => {
    const a = await t.agent({ name: 'Assistent' });
    await t.api('PATCH', `/agents/${a.id}`, { name: 'Mila' });
    const r = await t.api('POST', `/folders/werkplek/${a.id}/follow-name`, {});
    assert.equal(r.moved, true);
    assert.equal(path.resolve(r.workspace), path.resolve(team, 'Mila'));
    assert.equal(path.resolve(agentOf(t, a.id).workspace), path.resolve(team, 'Mila'));
    assert.equal(fs.existsSync(path.join(team, 'Assistent')), false);
    // with a file in it, the folder stays where it is
    fs.writeFileSync(path.join(team, 'Mila', 'werk.txt'), 'x');
    await t.api('PATCH', `/agents/${a.id}`, { name: 'Noor' });
    const r2 = await t.api('POST', `/folders/werkplek/${a.id}/follow-name`, {});
    assert.equal(r2.moved, false);
    assert.equal(path.resolve(agentOf(t, a.id).workspace), path.resolve(team, 'Mila'));
    // a folder in TeamBot's data folder never moves
    t.app.ctx.store.setSetting(t.app.ctx.auth.owner()!.id, WERKPLEK_SETTING, false);
    const b = await t.agent({ name: 'Sam' });
    await t.api('PATCH', `/agents/${b.id}`, { name: 'Sanne' });
    assert.equal((await t.api('POST', `/folders/werkplek/${b.id}/follow-name`, {})).moved, false);
  });
});
