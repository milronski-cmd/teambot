// The first screen's "Ik heb Claude of ChatGPT" (TeamBot 0.4.2): GET /api/cli-agents/subscriptions says, for Claude
// Code and Codex only, whether the vendor's program is here, logged in and connected, and whether TeamBot can install
// its own copy. A login done in the vendor's own window is seen with fresh=1. Owner only; never an email or org name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');

test('subscriptions: not logged in, then logged in (fresh), connect, the provider is known; owner only', async () => {
  const t = await startTestApp();
  const loginFile = path.join(t.dir, 'claude-login');
  process.env.FAKE_CLAUDE_LOGIN_FILE = loginFile;
  try {
    // The owner's own Claude Code and Codex are never looked at: both point at a test program (Codex: a missing file).
    await t.api('PUT', '/cli-agents/paths/claude-code', { path: FAKE_CLAUDE });
    t.app.ctx.store.setSetting(t.app.ctx.auth.owner()!.id, 'cliAgents', { paths: { 'claude-code': FAKE_CLAUDE, 'codex-cli': path.join(t.dir, 'geen-codex.exe') }, unsafe: {} });
    const s1 = await t.api('GET', '/cli-agents/subscriptions?fresh=1');
    assert.equal(s1.canUse, true);
    assert.deepEqual(
      s1.items.map((i: any) => i.id),
      ['claude-code', 'codex-cli'],
    );
    const c1 = s1.items[0];
    assert.equal(c1.installed, true);
    assert.equal(c1.loggedIn, false);
    assert.equal(c1.providerId, null);
    assert.match(c1.loginCommand, /auth login$/);
    assert.equal(typeof c1.runtime?.supported, 'boolean');
    const x1 = s1.items[1];
    assert.equal(x1.installed, false, 'a path that does not exist is not "installed"');

    // The person logs in in the vendor's window (here: the test program writes its login file).
    fs.writeFileSync(loginFile, 'ingelogd');
    const cached = await t.api('GET', '/cli-agents/subscriptions');
    assert.equal(cached.items[0].loggedIn, false, 'without fresh the cached answer stays (cheap to ask often)');
    const s2 = await t.api('GET', '/cli-agents/subscriptions?fresh=1&only=claude-code');
    assert.equal(s2.items[0].loggedIn, true);
    assert.equal(s2.items[0].billing, 'subscription');
    assert.ok(!JSON.stringify(s2).includes('geheim@example.com') && !JSON.stringify(s2).includes('Geheime Org'), 'no email or org name');

    // "Gebruiken": connect, and the first screen knows the provider from then on.
    const con = await t.api('POST', '/cli-agents/claude-code/connect', {});
    const s3 = await t.api('GET', '/cli-agents/subscriptions');
    assert.equal(s3.items[0].providerId, con.provider.id);

    // A member of a server install never uses the owner's subscription.
    const friend = t.app.ctx.auth.createUser({ name: 'Vriend', role: 'member' });
    const { token } = t.app.ctx.auth.createSession(friend.id);
    const r = await fetch(t.app.url + '/api/cli-agents/subscriptions', { headers: { authorization: `Bearer ${token}` } });
    const j = await r.json();
    assert.equal(j.canUse, false);
    assert.deepEqual(j.items, []);
  } finally {
    delete process.env.FAKE_CLAUDE_LOGIN_FILE;
    await t.close();
  }
});
