import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { werkplekScope } from '../ui/src/modules/folders/werkplekScope.js';
import { wholeComputer } from '../server/tools/builtin/files.js';

/**
 * The line under "Werkplek:" (first-bot screen and bot page) follows the bot's real access level. A checker found it
 * said "Daarbuiten vraagt de bot eerst toestemming" on "Volledige toegang", where the bot works on the whole computer
 * without asking. The decision per level is held against the server's own rules (broker and wholeComputer).
 */

test('werkplek line: one meaning per access level', () => {
  assert.equal(werkplekScope({ access_mode: 'full', settings: { fullAccessExternal: true } }), 'whole');
  assert.equal(werkplekScope({ access_mode: 'full', settings: { ownFoldersOnly: true } }), 'own');
  assert.equal(werkplekScope({ access_mode: 'auto' }), 'own');
  assert.equal(werkplekScope({ access_mode: 'ask' }), 'asks');
  assert.equal(werkplekScope({ access_mode: 'readonly' }), 'read');
  assert.equal(werkplekScope({ access_mode: 'chat' }), 'chat');
});

test('werkplek line: "whole computer, without asking" exactly where the server gives it, "asks" where it asks', async () => {
  const t = await startTestApp();
  try {
    const levels: [string, Record<string, any>][] = [
      ['full', {}],
      ['full', { ownFoldersOnly: true }],
      ['auto', {}],
      ['ask', {}],
      ['readonly', {}],
      ['chat', {}],
    ];
    for (const [access_mode, settings] of levels) {
      const a = await t.agent({ name: `Bot ${access_mode}${settings.ownFoldersOnly ? ' eigen' : ''}`, access_mode, settings });
      const label = `${access_mode} ${JSON.stringify(settings)}`;
      const scope = werkplekScope(a);
      // The whole computer, as the file tools and the gate hold it.
      assert.equal(scope === 'whole', !!wholeComputer(a), label);
      // Writing in its own werkplek: asked on "Vraagt toestemming", refused on read-only and chat, free otherwise.
      const write = t.app.ctx.broker.decide(a, { name: 'file_write', risk: 'write' });
      const want = scope === 'asks' ? 'ask' : scope === 'read' || scope === 'chat' ? 'deny' : 'allow';
      assert.equal(write, want, label);
    }
  } finally {
    await t.close();
  }
});
