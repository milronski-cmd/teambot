import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';
import { ACCOUNT_NOTE, CHAT_ONLY_NOTE, buildClaudeArgs, ownerMemoryExcludes, type ClaudeFeatures } from '../server/modules/cli-agents/claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');
const F: ClaudeFeatures = { partial: true, appendFile: true, restricted: true, permissionPrompts: true, tools: true, effort: true, modes: ['default', 'plan', 'acceptEdits', 'dontAsk'], settingSources: true, settings: true };
const base = { maxTurns: 10, addDirs: [], allowedTools: [], disallowedTools: [], extraArgs: [], loadUserSettings: false, useUserMcp: false };
const flag = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);

test("Claude Code bots don't get the owner's own Claude Code context, unless the bot opts in", () => {
  const cwd = path.resolve('/tb/data/workspaces/ag_1');
  const home = path.resolve('/home/eigenaar');
  const a = buildClaudeArgs(F, { ...base, mode: 'ask', cwd, home });
  assert.equal(flag(a, '--setting-sources'), 'project,local', 'no user settings and no claude.ai skills');
  const ex: string[] = JSON.parse(flag(a, '--settings')!).claudeMdExcludes;
  const has = (p: string) => ex.includes(p) || ex.includes(p.replace(/\\/g, '/'));
  assert.ok(has(path.join(home, '.claude', 'CLAUDE.md')) && has(path.join(home, '.claude', 'rules', '**')), "the owner's user memory");
  assert.ok(has(path.join(path.dirname(cwd), 'CLAUDE.md')) && has(path.join(path.resolve('/tb'), 'AGENTS.md')), 'memory files in the folders above the bot');
  assert.ok(!has(path.join(cwd, 'CLAUDE.md')), "the bot's own folder keeps its CLAUDE.md");
  assert.ok(a.includes('--restricted'));

  const own = buildClaudeArgs(F, { ...base, mode: 'ask', cwd, home, loadUserSettings: true });
  assert.ok(!own.includes('--setting-sources') && !own.includes('--settings') && !own.includes('--restricted'), 'opt-in: the owner\'s own settings and memory');
  const old = buildClaudeArgs({ ...F, settingSources: false, settings: false }, { ...base, mode: 'ask', cwd, home });
  assert.ok(!old.includes('--setting-sources') && !old.includes('--settings'), 'an older Claude Code without the flags still starts');
  assert.ok(ownerMemoryExcludes(cwd, home).length > 6);
});

test('Claude Code run: auto-memory off, the account e-mail is not who the bot talks to; opt-in keeps the owner context', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  const logs = () => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.prompt !== undefined);
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a = await t.api('POST', '/agents', { name: 'CcBot', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'Hoe heet ik?');
    let L = logs().at(-1);
    assert.equal(L.autoMemoryOff, true);
    assert.equal(flag(L.argv, '--setting-sources'), 'project,local');
    assert.ok(JSON.parse(flag(L.argv, '--settings')!).claudeMdExcludes.length > 0);
    assert.ok(L.system.includes(ACCOUNT_NOTE), 'the bot is told the userEmail is the subscription login, not the user');

    await t.api('PATCH', `/agents/${a.id}`, { settings: { cli: { loadUserSettings: true } } });
    await t.say(th.id, 'En nu?');
    L = logs().at(-1);
    assert.equal(L.autoMemoryOff, false);
    assert.ok(!L.argv.includes('--setting-sources'));
    assert.ok(!L.system.includes(ACCOUNT_NOTE));
    assert.ok(!L.system.includes(CHAT_ONLY_NOTE), 'only in "Alleen chat"');

    // Acceptance round 3 (A-16): in "Alleen chat" (--tools "") Claude Code stalled when asked to write a file; the bot
    // is now told plainly that it has no tools.
    await t.api('PATCH', `/agents/${a.id}`, { access_mode: 'chat' });
    await t.say(th.id, 'Maak een bestand');
    L = logs().at(-1);
    assert.equal(flag(L.argv, '--tools'), '');
    assert.ok(L.system.includes(CHAT_ONLY_NOTE));
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});
