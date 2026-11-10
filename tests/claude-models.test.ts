import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { parseModelCommand, clearClaudeModels } from '../server/modules/cli-agents/claude-models.js';

/** The Claude Code model picker (aliases and full ids from Claude Code itself) and the real model under a message. */

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');

function useLog(t: TestApp) {
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  return () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}

const flag = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);

test('Claude Code model list from its own /model command: standard, aliases and the full ids, no cost', async () => {
  clearClaudeModels();
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const list = await t.api('GET', `/providers/${p.id}/models`);
    const ids = list.map((m: any) => m.id);
    assert.deepEqual(ids, ['default', 'sonnet', 'opus', 'haiku', 'opus[1m]', 'claude-sonnet-9-9', 'claude-opus-9-9', 'claude-haiku-9-9']);
    assert.match(list[0].label, /Standaard van Claude Code \(nu Opus 9\.9\)/);
    assert.equal(list.find((m: any) => m.id === 'opus').label, 'Opus · altijd de nieuwste (nu Opus 9.9)');
    assert.match(list.find((m: any) => m.id === 'opus[1m]').label, /1M context/);
    assert.equal(list.find((m: any) => m.id === 'claude-opus-9-9').label, 'Opus 9.9 · vaste versie (claude-opus-9-9)');
    assert.ok(list.every((m: any) => m.billing === 'subscription'), 'subscription login');
    assert.ok(logs().filter((l) => l.mode === 'model').every((l) => l.argv.includes('--no-session-persistence') && flag(l.argv, '--tools') === ''), 'no tools, nothing saved');
    assert.deepEqual(parseModelCommand('Current model: `Opus 5.5` (effort: xhigh)\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.'), {
      name: 'Opus 5.5',
      aliases: ['sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan', 'default'],
    });

    // Under the answer: the model Claude Code really used, not "default".
    const a = await t.api('POST', '/agents', { name: 'Modelbot', provider_id: p.id, model: 'default', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'Hallo');
    const m = t.app.ctx.store.messages(th.id).filter((x) => x.role === 'assistant').at(-1)!;
    assert.equal(m.parts.model, 'fake-sonnet');
  } finally {
    await t.close();
  }
});
