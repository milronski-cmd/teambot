import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { parseJsonObject } from '../server/agent/short-call.js';
import { claudeOneShotArgs, codexOneShotArgs, openCodeOneShot, pickEngine, setBackoff } from '../server/modules/memory/engine.js';
import { parseLearnAnswer, groundedShare } from '../server/modules/memory/learn.js';

test('engine: Claude Code one-shot has no tools, no session, no user settings/MCP and our own system prompt', () => {
  const help = '--tools <tools...> --no-session-persistence --safe-mode --disable-slash-commands --permission-mode (choices: "acceptEdits", "dontAsk", "plan") --permission-prompts --system-prompt[-file]';
  const a = claudeOneShotArgs({ model: 'haiku', systemFile: 'C:/x/system.md', help });
  const i = a.indexOf('--tools');
  assert.equal(a[i + 1], '', 'empty tool list');
  for (const f of ['-p', '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(a.includes(f), f);
  assert.deepEqual(a.slice(a.indexOf('--output-format'), a.indexOf('--output-format') + 2), ['--output-format', 'json']);
  assert.deepEqual(a.slice(a.indexOf('--max-turns'), a.indexOf('--max-turns') + 2), ['--max-turns', '1']);
  assert.deepEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk']);
  assert.deepEqual(a.slice(a.indexOf('--system-prompt-file'), a.indexOf('--system-prompt-file') + 2), ['--system-prompt-file', 'C:/x/system.md']);
  assert.deepEqual(a.slice(-2), ['--model', 'haiku']);
  // Older CLI without --tools: every tool is denied instead.
  const old = claudeOneShotArgs({ model: 'default', systemFile: 'x', help: '' });
  assert.ok(old[old.indexOf('--disallowedTools') + 1].includes('Bash'));
  assert.ok(!old.includes('--model'));
});

test('engine: Codex one-shot is ephemeral, ignores the user config, read-only, shell and app features off', () => {
  const a = codexOneShotArgs({ model: 'default', cwd: 'C:/tmp/run', features: 'shell_tool  stable  true\nunified_exec  stable  true\napps  stable  true\nbrowser_use  stable  true' });
  for (const f of ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('-s') + 1], 'read-only');
  const disabled = a.flatMap((x, k) => (x === '--disable' ? [a[k + 1]] : []));
  assert.deepEqual(disabled.sort(), ['apps', 'browser_use', 'shell_tool', 'unified_exec']);
  assert.equal(a[a.length - 1], '-');
});

test('engine: OpenCode runs standalone with its own HOME/XDG (never the owner’s OpenCode data) and every tool denied', () => {
  const home = path.join(os.tmpdir(), 'tb-data', 'memory', 'opencode');
  const o = openCodeOneShot({ home, model: 'opencode/big-pickle', system: 'Alleen JSON.' });
  assert.ok(o.args.includes('--standalone'), 'private server, not the shared background service');
  assert.deepEqual(o.args.slice(o.args.indexOf('-m'), o.args.indexOf('-m') + 2), ['-m', 'opencode/big-pickle']);
  for (const k of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'HOME', 'USERPROFILE']) assert.ok(o.env[k].startsWith(home), k);
  const real = path.join(os.homedir(), '.local', 'share', 'opencode');
  assert.ok(!Object.values(o.env).some((v) => v.startsWith(real)));
  const cfg = JSON.parse(o.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(cfg.permission, { '*': 'deny' });
  assert.deepEqual(cfg.tools, { '*': false });
  assert.equal(cfg.agent.teambot_geheugen.prompt, 'Alleen JSON.');
});

test('engine choice: the bot’s own subscription CLI first; a paid login, a paid key or a limited engine is skipped', async () => {
  const t = await startTestApp();
  try {
    const me = t.app.ctx.auth.owner()!.id;
    const svc = t.app.ctx.services.memory.svc;
    let billing = 'subscription';
    t.app.ctx.services['cli-agents'] = { status: async (kind: string) => ({ installed: true, loggedIn: true, path: process.execPath, billing: kind === 'opencode' ? 'unknown' : billing }) };
    const claude = await t.api('POST', '/providers', { kind: 'claude-code' });
    const oc = await t.api('POST', '/providers', { kind: 'opencode', config: { defaultModel: 'openai/gpt-5' } });
    const bot = await t.agent({ provider_id: claude.id, model: 'opus' });
    let c = await pickEngine(svc, me, t.app.ctx.store.agent(bot.id), 'free');
    assert.equal(c?.providerKind, 'claude-code');
    assert.equal(c?.source, 'own');
    assert.equal(c?.model, 'opus', "the bot's model");
    assert.equal(c?.billing, 'subscription');
    // Claude Code logged in with an API key costs money → skipped; OpenCode is used, with a free model (not the paid default).
    billing = 'api';
    c = await pickEngine(svc, me, t.app.ctx.store.agent(bot.id), 'free');
    assert.equal(c?.providerKind, 'opencode');
    assert.equal(c?.model, 'opencode/big-pickle');
    // Free-tier limit reached → backed off → nothing free left → patterns.
    setBackoff(oc.id, 3600_000, 'Free usage limit reached');
    c = await pickEngine(svc, me, t.app.ctx.store.agent(bot.id), 'free');
    assert.equal(c, null);
    // A mock API key bot is "paid": only with explicit opt-in.
    const paidBot = await t.agent();
    assert.equal((await pickEngine(svc, me, t.app.ctx.store.agent(paidBot.id), 'model'))?.billing, 'paid');
    const opts = await t.api('GET', '/memory/engine?options=1');
    assert.ok(opts.options.some((o: any) => o.providerId === oc.id && o.available === false), 'limited engine is shown as unavailable');
  } finally {
    await t.close();
  }
});

test('learn answer parsing is strict; grounding measures how much comes from the owner', () => {
  assert.deepEqual(parseJsonObject('Hier: ```json\n{"a":{"b":"}"}}\n``` klaar {x}'), { a: { b: '}' } });
  assert.equal(parseJsonObject('geen json'), null);
  assert.equal(parseJsonObject('[1,2]'), null);
  const p = parseLearnAnswer('{"items":[{"content":"Ik woon in Zwolle","type":"weird","evidence":"ik woon in Zwolle","msg":"x1","replaces":"DROP TABLE"},{"content":"x","evidence":"y"},"rommel"]}');
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].type, 'fact');
  assert.equal(p.items[0].replaces, null);
  assert.equal(p.items[0].msg, '1');
  assert.equal(parseLearnAnswer('kapot').ok, false);
  assert.ok(groundedShare('Ik woon in Amersfoort', 'ik woon niet meer in Utrecht maar in Amersfoort') === 1);
  assert.ok(groundedShare('Ik ben getrouwd met de koning van Spanje', 'ik woon in Utrecht') < 0.3);
  assert.ok(groundedShare('Antwoord voortaan kort', 'voortaan wil ik kortere antwoorden') >= 0.6, 'stemming slack');
});
