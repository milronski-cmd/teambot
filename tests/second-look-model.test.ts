/** The second look before "klaar" runs on another model than the one that did the work, when that costs nothing extra. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { checkEngineOf, familyOf, setCheckEngineForAll } from '../server/modules/quality/engine.js';

test('families of engines; the check stays on the own engine without another one, and the owner sets one for all bots', async () => {
  assert.equal(familyOf('claude-code'), familyOf('anthropic'));
  assert.equal(familyOf('codex'), familyOf('openai'));
  assert.notEqual(familyOf('claude-code'), familyOf('openai'));
  assert.notEqual(familyOf('ollama'), familyOf('deepseek'));

  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const userId = ctx.auth.owner()!.id;
    const a = ctx.store.agent((await t.agent({ name: 'Pen' })).id)!;
    const b = await t.agent({ name: 'Bo' });
    // One engine connected: the check runs on the bot's own.
    assert.equal(checkEngineOf(ctx, a)?.providerId, a.provider_id);
    // The owner picks an engine for the second look of all his bots (a paid one only ever this way).
    const other = await t.api('POST', '/providers', { kind: 'ollama', name: 'Tweede model', config: { baseUrl: 'http://127.0.0.1:11434' } });
    const out = await t.api('PUT', '/quality/check-engine', { providerId: other.id, model: 'kimi' });
    assert.equal(out.bots, 2);
    for (const id of [a.id, b.id]) assert.deepEqual(checkEngineOf(ctx, ctx.store.agent(id)!), { providerId: other.id, model: 'kimi' });
    // Back to the default, and an engine that is not connected is refused.
    assert.equal(setCheckEngineForAll(ctx, userId, null, null), 2);
    assert.equal(ctx.store.agent(a.id)!.settings?.quality?.checkProviderId, undefined);
    await assert.rejects(t.api('PUT', '/quality/check-engine', { providerId: 'prv_bestaatniet' }), /niet gekoppeld/);
  } finally {
    await t.close();
  }
});
