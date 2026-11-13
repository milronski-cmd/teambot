import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRA_ARGS, accessLevels, accessOn, aiKind, aiPick, busyShown, changedRows, guardLine, rowWorks, stepsOf, switchAi, withSteps, withoutKeptAccess, type AiFacts, type RowId } from '../ui/src/pages/agentRows.js';
import { CLI_DEFS } from '../server/modules/cli-agents/catalog.js';

/**
 * The bot page per kind of AI (ui/src/pages/agentRows.ts): which row is shown on which AI, and what happens to the
 * values of a bot that moves to another AI. The page itself is checked in a browser by tests/e2e/agent-page-per-ai.mjs.
 */

/** Every AI here is a stored one, so it has an id. */
type Ai = AiFacts & { id: string };
const api: Ai = { id: 'p-api', type: 'api', kind: 'anthropic', billing: 'paid' };
const ollama: Ai = { id: 'p-ollama', type: 'api', kind: 'ollama', billing: 'local' };
const lmstudio: Ai = { id: 'p-lms', type: 'api', kind: 'lmstudio' };
const llamacpp: Ai = { id: 'p-llama', type: 'api', kind: 'llamacpp' };
const claude: Ai = { id: 'p-cc', type: 'cli', kind: 'claude-code' };
const codex: Ai = { id: 'p-cx', type: 'cli', kind: 'codex-cli' };
const opencode: Ai = { id: 'p-oc', type: 'cli', kind: 'opencode' };
const gemini: Ai = { id: 'p-gem', type: 'cli', kind: 'gemini-cli' };
const copilot: Ai = { id: 'p-cop', type: 'cli', kind: 'copilot-cli' };
const ALL = { api, ollama, lmstudio, llamacpp, claude, codex, opencode, gemini, copilot };

const where = (row: RowId, o: { access?: string } = {}) =>
  Object.entries(ALL)
    .filter(([, p]) => rowWorks(row, p, o))
    .map(([k]) => k);

test('five kinds of AI', () => {
  assert.equal(aiKind(api), 'api');
  assert.equal(aiKind(ollama), 'local');
  assert.equal(aiKind(llamacpp), 'local', 'a local engine by its kind, also without billing "local"');
  assert.equal(aiKind(claude), 'claude');
  assert.equal(aiKind(codex), 'codex');
  for (const p of [opencode, gemini, copilot, { type: 'cli' as const, kind: 'acp-custom' }]) assert.equal(aiKind(p), 'acp');
  assert.equal(aiKind(undefined), 'api');
});

test('each row shows only on the AI that reads it', () => {
  assert.deepEqual(where('chat'), ['api', 'ollama', 'lmstudio', 'llamacpp', 'claude']);
  assert.deepEqual(where('steer'), ['api', 'ollama', 'lmstudio', 'llamacpp']);
  assert.deepEqual(where('reasoning'), ['api', 'ollama', 'lmstudio', 'llamacpp', 'claude', 'codex'], 'never on an ACP program');
  assert.deepEqual(where('steps'), ['api', 'ollama', 'lmstudio', 'llamacpp', 'claude']);
  assert.deepEqual(where('time'), ['claude', 'codex', 'opencode', 'gemini', 'copilot']);
  assert.deepEqual(where('silence'), ['claude', 'codex', 'opencode', 'gemini', 'copilot']);
  assert.deepEqual(where('ownApps'), ['claude', 'codex']);
  assert.deepEqual(where('ownSettings'), ['claude']);
  assert.deepEqual(where('alwaysDeny'), ['claude']);
  assert.deepEqual(where('extraArgs'), ['claude', 'codex', 'gemini', 'copilot']);
  assert.deepEqual(where('contextWindow'), ['ollama', 'lmstudio'], 'llama.cpp fixes its window when the server starts');
  assert.deepEqual(where('writeInstructions'), ['api', 'ollama', 'lmstudio', 'llamacpp', 'claude', 'codex', 'opencode']);
  assert.deepEqual(where('loopIdle'), ['api', 'ollama', 'lmstudio', 'llamacpp']);
});

test('Claude Code takes the always-allowed rules only at "Vraagt toestemming" and "Automatisch"', () => {
  for (const access of ['ask', 'auto']) assert.deepEqual(where('alwaysAllow', { access }), ['claude'], access);
  for (const access of ['chat', 'readonly', 'full', undefined]) assert.deepEqual(where('alwaysAllow', { access }), [], String(access));
});

test('the extra flags per program are the ones the server accepts', () => {
  const server = Object.fromEntries(CLI_DEFS.filter((d) => d.extraArgs && Object.keys(d.extraArgs).length).map((d) => [d.id, Object.keys(d.extraArgs!)]));
  assert.deepEqual(Object.keys(EXTRA_ARGS).sort(), Object.keys(server).sort());
  for (const [kind, shown] of Object.entries(EXTRA_ARGS)) for (const f of shown) assert.ok(server[kind].includes(f.split(' ')[0]), `${kind}: ${f}`);
});

test('"Wat mag de bot?": only the levels this AI can be held to', () => {
  assert.deepEqual(accessLevels(claude), ['chat', 'readonly', 'ask', 'auto', 'full']);
  assert.deepEqual(accessLevels(codex), ['readonly', 'ask', 'auto', 'full']);
  assert.deepEqual(accessLevels(opencode), ['readonly', 'ask', 'auto', 'full']);
  assert.equal(accessOn(codex, 'chat'), 'readonly');
  assert.equal(accessOn(codex, 'auto'), 'auto');
  assert.equal(accessOn(api, 'chat'), 'chat');
});

test('"Als de bot bezig is": Bijsturen on a program is what it does there, the queue', () => {
  assert.equal(busyShown(api, 'steer'), 'steer');
  assert.equal(busyShown(claude, 'steer'), 'queue');
  assert.equal(busyShown(codex, 'interrupt'), 'interrupt');
  assert.equal(busyShown(ollama, undefined), 'queue');
});

test('one step limit: the bot’s own, and on Claude Code the lower of that and the one typed at the program', () => {
  assert.equal(stepsOf({ maxTurns: 25 }, api), 25);
  assert.equal(stepsOf({ cli: { maxTurns: 30 } }, claude), 30);
  assert.equal(stepsOf({ cli: { maxTurns: 30 } }, api), undefined, 'the program’s own number is not read by TeamBot’s loop');
  assert.equal(stepsOf({ maxTurns: 25, cli: { maxTurns: 30 } }, claude), 25);
  assert.equal(stepsOf({ maxTurns: 50, cli: { maxTurns: 30 } }, claude), 30);
  assert.deepEqual(withSteps({ maxTurns: 25, cli: { maxTurns: 30, timeoutMin: 9 } }, 12), { maxTurns: 12, cli: { timeoutMin: 9 } });
  assert.deepEqual(withSteps({ maxTurns: 25, onLimit: 'wait' }, undefined), { onLimit: 'wait' });
});

test('Claude Code → Codex → Claude Code: what does not apply is put aside and comes back', () => {
  const bot = {
    provider_id: claude.id,
    model: 'opus',
    access_mode: 'chat',
    settings: { onLimit: 'wait', maxTurns: 25, cli: { timeoutMin: 90, loadUserSettings: true, allowedTools: ['Bash(npm test)'], extraArgs: ['--fallback-model', 'haiku'] } },
  };
  const onCodex = switchAi(bot, claude, codex);
  assert.equal(onCodex.provider_id, codex.id);
  assert.equal(onCodex.model, '', 'Codex starts on its own default model');
  assert.equal(onCodex.access_mode, 'readonly', 'the nearest level Codex can be held to');
  assert.equal(onCodex.settings.cli.extraArgs, undefined, 'Codex would refuse Claude Code’s flags');
  assert.deepEqual(onCodex.settings.cli.allowedTools, ['Bash(npm test)'], 'a value Codex does not read stays where it is');
  assert.equal(onCodex.settings.cli.timeoutMin, 90, 'a value Codex reads too stays in use');
  assert.equal(onCodex.settings.maxTurns, 25);
  assert.equal(onCodex.settings.onLimit, 'wait');
  assert.deepEqual(onCodex.settings.kept, { access: 'chat', models: { [claude.id]: 'opus' }, extraArgs: { 'claude-code': ['--fallback-model', 'haiku'] } });

  const back = switchAi({ ...bot, ...onCodex }, codex, claude);
  assert.equal(back.model, 'opus');
  assert.equal(back.access_mode, 'chat');
  assert.deepEqual(back.settings.cli.extraArgs, ['--fallback-model', 'haiku']);
  assert.equal(back.settings.kept, undefined, 'nothing left aside');
  assert.deepEqual(back.settings, bot.settings);
});

test('each program keeps its own flags; the step limit typed at Claude Code becomes the bot’s', () => {
  const bot = { provider_id: codex.id, model: '', access_mode: 'auto', settings: { cli: { extraArgs: ['--oss'] } } };
  const onClaude = switchAi(bot, codex, claude);
  assert.equal(onClaude.settings.cli, undefined);
  const withFlag = { ...bot, ...onClaude, settings: { ...onClaude.settings, cli: { extraArgs: ['--agent', 'x'], maxTurns: 30 } } };
  const backToCodex = switchAi(withFlag, claude, codex);
  assert.deepEqual(backToCodex.settings.cli, { extraArgs: ['--oss'] });
  assert.equal(backToCodex.settings.maxTurns, 30, 'one step limit for the bot, read again on the next AI that has steps');
  assert.deepEqual(backToCodex.settings.kept.extraArgs, { 'claude-code': ['--agent', 'x'] });
  assert.equal(backToCodex.access_mode, 'auto');
});

test('choosing a level yourself drops the one put aside', () => {
  assert.deepEqual(withoutKeptAccess({ kept: { access: 'chat', models: { a: 'm' } }, x: 1 }), { kept: { models: { a: 'm' } }, x: 1 });
  assert.deepEqual(withoutKeptAccess({ kept: { access: 'chat' } }), {});
});

test('a pick from the chat’s model switcher puts aside the same way, with the model that was picked', () => {
  const bot = { provider_id: claude.id, model: 'opus', access_mode: 'chat', settings: { cli: { extraArgs: ['--agent', 'x'] } } };
  const providers = Object.values(ALL);
  assert.deepEqual(aiPick(bot, providers, { provider_id: claude.id, model: 'sonnet' }), { provider_id: claude.id, model: 'sonnet' }, 'the same AI: only the model');
  const p = aiPick(bot, providers, { provider_id: codex.id, model: 'gpt-5.5' });
  assert.equal(p.model, 'gpt-5.5');
  assert.ok('access_mode' in p && p.access_mode === 'readonly');
  assert.ok('settings' in p && p.settings.kept.access === 'chat' && p.settings.kept.models[claude.id] === 'opus' && !p.settings.cli);
  const back = aiPick({ ...bot, ...p }, providers, { provider_id: claude.id, model: '' });
  assert.ok('settings' in back);
  assert.equal(back.model, '', 'the pick wins over the model kept for that AI');
  assert.equal(back.access_mode, 'chat');
  assert.deepEqual(back.settings.cli, { extraArgs: ['--agent', 'x'] });
});

test('the line about guarding the hard blocks: only where the server says TeamBot cannot', () => {
  const guards = { full: { guarded: false, text: 'Niet bewaakt door TeamBot: op deze AI houdt TeamBot sleutelbestanden en dichte mappen niet tegen.' }, auto: { guarded: true, text: 'Bewaakt.' } };
  assert.match(guardLine(guards, 'full'), /^Niet bewaakt/);
  assert.equal(guardLine(guards, 'auto'), '');
  assert.equal(guardLine(guards, 'ask'), '');
  assert.equal(guardLine(null, 'full'), '');
  assert.equal(guardLine(undefined, undefined), '');
});

test('unsaved: the length of a turn and the program are two rows', () => {
  assert.deepEqual(changedRows({ cli: { timeoutMin: 9 } }, { cli: { timeoutMin: 10 } }), { turn: true, program: false });
  assert.deepEqual(changedRows({ maxTurns: 5 }, { maxTurns: 6 }), { turn: true, program: false });
  assert.deepEqual(changedRows({ cli: { useUserMcp: false } }, { cli: { useUserMcp: true } }), { turn: false, program: true });
  assert.deepEqual(changedRows({ cli: { extraArgs: ['--oss'] } }, { cli: {} }), { turn: false, program: true });
  assert.deepEqual(changedRows({ onLimit: 'wait' }, { onLimit: 'stop' }), { turn: false, program: false });
});
