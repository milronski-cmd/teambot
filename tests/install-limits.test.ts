import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

async function post(url: string, p: string, body: any, headers: Record<string, string> = {}) {
  const r = await fetch(`${url}/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

// Unattended / managed installs: TEAMBOT_SETUP_TOKEN guards the first-run owner setup, TEAMBOT_MAX_USERS the seats.
test('setup token guards first-run setup; seat limit applies to every way of adding people', async () => {
  const t = await startTestApp({ mode: 'server' });
  const prev = { token: process.env.TEAMBOT_SETUP_TOKEN, max: process.env.TEAMBOT_MAX_USERS };
  try {
    // Fresh server: remove the owner the helper created so setup is open again.
    const s = t.app.ctx.store;
    s.exec('DELETE FROM sessions');
    s.exec('DELETE FROM agents');
    s.exec('DELETE FROM providers');
    s.exec('DELETE FROM users');
    process.env.TEAMBOT_SETUP_TOKEN = 'eenmalig-geheim';
    const form = { name: 'Eigenaar', email: 'eigenaar@test.local', password: 'eigenaar-wachtwoord-2026' };
    assert.equal((await post(t.app.url, '/public/setup', form)).status, 403);
    assert.equal((await post(t.app.url, '/public/setup', { ...form, setupToken: 'fout' })).status, 403);
    assert.equal((await post(t.app.url, '/public/setup', form, { 'x-teambot-setup-token': 'eenmalig-geheim-x' })).status, 403);
    const ok = await post(t.app.url, '/public/setup', form, { 'x-teambot-setup-token': 'eenmalig-geheim' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.role, 'owner');

    // Seats: owner + 1 member allowed, the third person is refused (invite signup, admin-created, SSO/SCIM all use createUser).
    process.env.TEAMBOT_MAX_USERS = '2';
    const auth = t.app.ctx.auth;
    auth.createUser({ name: 'Lid', email: 'lid@test.local', password: 'wachtwoord123', role: 'member' });
    assert.throws(() => auth.createUser({ name: 'Te veel', email: 'teveel@test.local', password: 'wachtwoord123', role: 'member' }), /maximaal 2 gebruikers/);
    // Blocking someone frees a seat.
    s.exec("UPDATE users SET disabled = 1 WHERE email = 'lid@test.local'");
    assert.ok(auth.createUser({ name: 'Nieuw', email: 'nieuw@test.local', password: 'wachtwoord123', role: 'member' }));
  } finally {
    if (prev.token === undefined) delete process.env.TEAMBOT_SETUP_TOKEN;
    else process.env.TEAMBOT_SETUP_TOKEN = prev.token;
    if (prev.max === undefined) delete process.env.TEAMBOT_MAX_USERS;
    else process.env.TEAMBOT_MAX_USERS = prev.max;
    await t.close();
  }
});
