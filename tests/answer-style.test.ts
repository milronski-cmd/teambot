// "Antwoordstijl: Natuurlijk / Zakelijk" per bot (OpenBot 0.65 parity): part of the bot's instructions for every
// engine; the default adds nothing (the prompt bots always had).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';
import { answerStyle, answerStyleNote, STYLE_HEADING } from '../server/agent/style.js';
import { languageSection } from '../server/agent/language.js';
import { sessionInstructions } from '../server/modules/cli-agents/context.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');

test('answer style: natural is the default and adds nothing; business adds one section', () => {
  assert.equal(answerStyle(null), 'natural');
  assert.equal(answerStyle({ settings: {} }), 'natural');
  assert.equal(answerStyle({ settings: { answerStyle: 'iets' } }), 'natural');
  assert.equal(answerStyleNote({ settings: { answerStyle: 'natural' } }), '');
  const note = answerStyleNote({ settings: { answerStyle: 'business' } });
  assert.ok(note.startsWith(`${STYLE_HEADING}\n`));
  assert.match(note, /kopjes en opsommingen/);
  assert.match(note, /eigen instructies om een andere vorm/, 'what the user or the bot\'s own instructions ask goes first');
  // CLI sessions (Codex, ACP): the style stays, the language rule stays last.
  const sys = `Je bent Ada.\n\n## Jouw instructies\nWees kort.\n\n${note}\n\n## Taal\n- Antwoord in de taal van de gebruiker.`;
  const full = sessionInstructions(sys, '## TeamBot-tools\nNaast je eigen tools …');
  assert.ok(full.includes(note));
  assert.ok(full.trimEnd().endsWith(languageSection(sys)));
});

test('every API bot gets its answer style in the system prompt, just before the language rule', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Ada' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const runner = t.app.ctx.services.runner;
    const sysOf = async () => runner.systemPrompt(t.app.ctx.store.agent(a.id)!, t.app.ctx.store.thread(th.id)!);
    const before = await sysOf();
    assert.ok(!before.includes(STYLE_HEADING), 'default: the prompt bots always had');
    await assert.rejects(t.api('PATCH', `/agents/${a.id}`, { settings: { answerStyle: 'grappig' } }), /Ongeldige antwoordstijl/);
    await t.api('PATCH', `/agents/${a.id}`, { settings: { ...t.app.ctx.store.agent(a.id)!.settings, answerStyle: 'business' } });
    const sys = await sysOf();
    const i = sys.indexOf(STYLE_HEADING);
    assert.ok(i > sys.indexOf('## Jouw instructies') || i > 0);
    assert.ok(i > 0 && i < sys.lastIndexOf('## Taal'), 'style before the language rule, which stays last');
    t.script.push({ text: 'ok' });
    await t.say(th.id, 'Vergelijk twee laptops');
    assert.ok(t.requests.at(-1)!.system!.includes(STYLE_HEADING), 'the model gets it');
    // Back to natural: nothing extra again (same prompt as before, so caches stay valid).
    const { answerStyle: _x, ...rest } = t.app.ctx.store.agent(a.id)!.settings as any;
    await t.api('PATCH', `/agents/${a.id}`, { settings: rest });
    assert.equal(await sysOf(), before);
    // A template carries the style with the bot.
    await t.api('PATCH', `/agents/${a.id}`, { settings: { ...rest, answerStyle: 'business' } });
    const tpl = await t.api('GET', `/agents/${a.id}/export`);
    assert.equal(tpl.settings.answerStyle, 'business');
  } finally {
    await t.close();
  }
});

test('a CLI engine (Claude Code) gets the answer style with its instructions', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  const logs = () => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.prompt !== undefined);
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a = await t.api('POST', '/agents', { name: 'CcBot', provider_id: p.id, model: '', access_mode: 'ask', settings: { answerStyle: 'business' } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'Wat zijn de voordelen?');
    const L = logs().at(-1);
    assert.ok(L.system.includes(STYLE_HEADING), 'in the appended system prompt');
    assert.ok(L.system.indexOf(STYLE_HEADING) < L.system.lastIndexOf('## Taal'), 'language rule still last');
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});
