import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

test('profile changes are versioned and can be restored (restore itself is versioned)', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent({ name: 'Versie', instructions: 'Eerste instructies' });
    await t.api('PATCH', `/agents/${a.id}`, { instructions: 'Tweede instructies', model: 'mock-1' });
    await t.api('PATCH', `/agents/${a.id}`, { name: 'Versie 3' });
    // A no-op patch creates no version.
    await t.api('PATCH', `/agents/${a.id}`, { name: 'Versie 3' });
    let versions = await t.api('GET', `/agents/${a.id}/versions`);
    assert.equal(versions.length, 2);
    assert.deepEqual(versions[0].changed, ['name']);
    assert.deepEqual(versions[1].changed, ['instructions']);
    assert.equal(versions[1].data.instructions, 'Eerste instructies');

    const restored = await t.api('POST', `/agents/${a.id}/versions/${versions[1].id}/restore`);
    assert.equal(restored.instructions, 'Eerste instructies');
    assert.equal(restored.name, 'Versie');
    versions = await t.api('GET', `/agents/${a.id}/versions`);
    assert.equal(versions[0].reason, 'restore');
    assert.equal(versions[0].data.instructions, 'Tweede instructies');

    // Another user cannot read or restore.
    const other = t.app.ctx.auth.createUser({ name: 'Ander', email: 'ander@test.local', password: 'geheim1234', role: 'member' });
    const s = t.app.ctx.auth.createSession(other.id, 'web', 'test');
    const res = await fetch(`${t.app.url}/api/agents/${a.id}/versions`, { headers: { authorization: `Bearer ${s.token}` } });
    assert.equal(res.status, 404);

    // Deleting the bot removes its history.
    await t.api('DELETE', `/agents/${a.id}`);
    assert.equal(t.app.ctx.store.all('SELECT id FROM agent_versions WHERE agent_id = ?', a.id).length, 0);
  } finally {
    await t.close();
  }
});
