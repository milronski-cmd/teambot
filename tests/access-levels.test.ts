import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessUnsupported } from '../ui/src/lib/access.js';

/** "Alleen chat" is only offered where the engine can enforce it (checklist A-16: disabled with a reason, never silently failing). */
test('chat-only is not offered for Codex or ACP engines; every other level is', () => {
  for (const kind of ['codex-cli', 'opencode', 'gemini-cli', 'acp-custom']) assert.equal(accessUnsupported('chat', { type: 'cli', kind }), true, kind);
  assert.equal(accessUnsupported('chat', { type: 'cli', kind: 'claude-code' }), false);
  assert.equal(accessUnsupported('chat', { type: 'api', kind: 'openai' }), false);
  for (const mode of ['readonly', 'ask', 'auto', 'full']) assert.equal(accessUnsupported(mode, { type: 'cli', kind: 'codex-cli' }), false, mode);
  assert.equal(accessUnsupported('chat', undefined), false);
});

test('the server refuses chat-only for Codex at run time with the same explanation', async () => {
  const { runCodex } = await import('../server/modules/cli-agents/codex.js');
  const r = await runCodex({ agent: { access_mode: 'chat' } } as any, {} as any);
  assert.match(String(r.error), /Chatmodus \(zonder tools\) kan bij Codex niet/);
});
