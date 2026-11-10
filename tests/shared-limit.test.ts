// 0.4.3: a usage limit counts for the account, not for one connection. With two OpenCode connections the free chain
// tried the second one (same login, same free daily limit) before going to the next real option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, mockAdapter } from './helpers.js';
import { limitAccount } from '../server/agent/fallback.js';

test('limitAccount: one CLI login per computer, an API key per address, nothing shared without a key or locally', () => {
  const cli = { type: 'cli', billing: 'free' };
  const api = { type: 'api', billing: 'free', baseUrl: 'https://api.groq.com/openai/v1' };
  assert.equal(limitAccount({ kind: 'opencode', config: {} }, cli), limitAccount({ kind: 'opencode', config: { defaultModel: 'opencode/big-pickle' } }, cli), 'two OpenCode connections share the limit');
  assert.notEqual(limitAccount({ kind: 'opencode', config: {} }, cli), limitAccount({ kind: 'kilo-code', config: {} }, cli), 'another CLI is another account');
  assert.notEqual(limitAccount({ kind: 'qwen-code', config: { authMethod: 'openai' } }, cli), limitAccount({ kind: 'qwen-code', config: { authMethod: 'qwen-oauth' } }, cli), 'another sign-in is another account');
  assert.equal(limitAccount({ kind: 'groq', base_url: '' }, api, 'abc'), limitAccount({ kind: 'groq', base_url: 'https://api.groq.com/openai/v1/' }, api, 'abc'), 'the same key at the same address');
  assert.notEqual(limitAccount({ kind: 'groq' }, api, 'abc'), limitAccount({ kind: 'groq' }, api, 'def'), 'another key is another account');
  assert.equal(limitAccount({ kind: 'groq' }, api, null), null, 'without a key nothing is shared');
  assert.equal(limitAccount({ kind: 'ollama' }, { type: 'api', billing: 'local' }, 'x'), null, 'a local model has no usage limit');
});

test('runner: when one OpenCode connection hits its limit, the other one is skipped and the next real option answers', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    // A free CLI engine in the role of OpenCode (two connections of the same kind = one login on this computer).
    ctx.providers.registerKind({ id: 'freecli', label: 'Gratis CLI', type: 'cli', billing: 'free', needsKey: false, description: 'test', models: ['free-1'], defaultModel: 'free-1', create: () => mockAdapter(t.script, t.requests) });
    const owner = ctx.auth.owner()!;
    const one = ctx.providers.create(owner.id, { kind: 'freecli', name: 'OpenCode' });
    const two = ctx.providers.create(owner.id, { kind: 'freecli', name: 'OpenCode (2)' });
    const next = await t.api('POST', '/providers', { kind: 'mock', name: 'Volgende optie' });
    const a = await t.agent({ settings: { fallbacks: [{ provider_id: one.id, model: 'free-1' }, { provider_id: two.id, model: 'free-1' }, { provider_id: next.id, model: 'mock-1' }] } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push(
      { error: { message: 'Rate limit reached. Try again in 30 minutes.', status: 429 } },
      { error: { message: 'Free usage limit reached. Try again in 3 hours.', status: 429 } },
      { text: 'antwoord van de volgende optie' },
    );
    await t.say(th.id, 'hallo');
    const ans = ctx.store.messages(th.id).filter((m: any) => m.role === 'assistant');
    assert.equal(ans.at(-1)!.content, 'antwoord van de volgende optie');
    const run = ctx.store.run(ans.at(-1)!.run_id!)!;
    assert.equal(run.meta?.engine?.provider_id, next.id, 'the next real option answers, not the second OpenCode connection');
    const runner = ctx.services.runner;
    assert.ok(runner.limited.get(two.id)?.until > Date.now(), 'the second connection is at the same limit');
    assert.equal(runner.limited.get(two.id)?.until, runner.limited.get(one.id)?.until, 'until the same reset');
    const ev = ctx.store.messages(th.id).filter((m: any) => m.role === 'event').map((m: any) => m.content);
    assert.ok(ev.some((x: string) => /OpenCode.*Overgeschakeld naar reserve: Volgende optie/.test(x)), ev.join(' | '));
    assert.ok(!ev.some((x: string) => /Overgeschakeld naar reserve: OpenCode \(2\)/.test(x)), 'never switched to the second connection: ' + ev.join(' | '));
    // A connection of another kind keeps its own limit: the main engine's limit did not mark the free CLI.
    assert.ok(runner.limited.get(t.providerId), 'the main engine is at its limit');
    assert.ok(!runner.limited.get(next.id), 'the next option (another connection of the main kind, no key) is not marked');
  } finally {
    await t.close();
  }
});
