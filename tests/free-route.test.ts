import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';
import { acpModelEnv, modelBilling } from '../server/modules/cli-agents/index.js';
import { defById } from '../server/modules/cli-agents/catalog.js';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents-fake-claude.mjs');

test('free/subscription/paid labels: OpenCode free models, local models, kinds', async () => {
  assert.equal(modelBilling('opencode/big-pickle'), 'free');
  assert.equal(modelBilling('opencode/deepseek-v4.1-flash-free'), 'free');
  assert.equal(modelBilling('opencode/claude-sonnet-5'), undefined, 'paid OpenCode Zen models are not labelled free');
  assert.equal(modelBilling('ollama/qwen3.6:latest'), 'local');
  assert.equal(modelBilling('openai/gpt-5.4-mini'), undefined);
  const oc = JSON.parse(acpModelEnv(defById('opencode')!, 'opencode/big-pickle').OPENCODE_CONFIG_CONTENT);
  assert.equal(oc.model, 'opencode/big-pickle', 'the bot model goes into the inline OpenCode config');
  assert.deepEqual(oc.permission, { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' }, 'permissions stay');
  assert.deepEqual(acpModelEnv(defById('opencode')!, 'default'), {});
  const t = await startTestApp();
  try {
    const kinds = await t.api('GET', '/provider-kinds');
    const by = (id: string) => kinds.find((k: any) => k.id === id);
    assert.equal(by('claude-code').billing, 'subscription');
    assert.equal(by('codex-cli').billing, 'subscription');
    assert.equal(by('opencode').billing, 'free');
    assert.equal(by('ollama').billing, 'local');
    assert.equal(by('openai').billing, 'paid');
  } finally {
    await t.close();
  }
});

test('default engine for new bots prefers the subscription CLI over an API key, until the user picks one', async () => {
  const t = await startTestApp();
  try {
    assert.equal(t.app.ctx.store.getSetting(t.app.ctx.auth.owner()!.id, 'defaultProvider', null), t.providerId, 'first provider becomes the default');
    const cli = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const s1 = await t.api('GET', '/settings');
    assert.equal(s1.defaultProvider, cli.id, 'Claude Code on a subscription wins over an API provider');
    const a = await t.api('POST', '/agents', { name: 'Nieuw' });
    assert.equal(a.provider_id, cli.id, 'a new bot without a choice gets the preferred engine');
    await t.api('PUT', '/settings', { defaultProvider: t.providerId });
    await t.api('POST', '/providers', { kind: 'mock', name: 'nog een' });
    assert.equal((await t.api('GET', '/settings')).defaultProvider, t.providerId, 'an explicit choice is kept');
  } finally {
    await t.close();
  }
});
