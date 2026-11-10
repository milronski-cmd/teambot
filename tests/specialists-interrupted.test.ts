// A learning round that was running when TeamBot stopped. Live in 0.4.4: two such rounds stayed "running" for ever
// (the bot's last round kept saying it was busy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

test('a learning round left "running" by a restart is closed at start, and the bot learns again', async () => {
  const t = await startTestApp();
  try {
    const a = await t.api('POST', '/agents', { name: 'Sem', provider_id: t.providerId, model: 'mock' });
    const ctx = t.app.ctx;
    const svc = ctx.services.specialists.svc;
    const row = (id: string) => ctx.store.get<any>('specialist_rounds', id);
    ctx.store.insert('specialist_rounds', { id: 'spr_stuck', agent_id: a.id, user_id: a.user_id, trigger: 'auto', run_id: null, status: 'running', engine: null, stats: {}, lines: [], started_at: '2026-11-09T23:00:30.710Z' });
    ctx.store.insert('specialist_rounds', { id: 'spr_done', agent_id: a.id, user_id: a.user_id, trigger: 'auto', run_id: null, status: 'done', engine: null, stats: {}, lines: [], started_at: '2026-11-08T23:00:30.710Z', finished_at: '2026-11-08T23:01:00.000Z' });

    // A round that really runs in this process is left alone.
    svc.running.set(a.id, Promise.resolve());
    assert.equal(svc.closeInterrupted(), 0);
    assert.equal(row('spr_stuck').status, 'running');
    svc.running.delete(a.id);

    assert.equal(svc.closeInterrupted(), 1);
    const r = row('spr_stuck');
    assert.equal(r.status, 'error');
    assert.match(r.error, /Onderbroken/);
    assert.ok(r.finished_at, 'it has an end');
    assert.equal(row('spr_done').status, 'done');
    assert.equal(svc.closeInterrupted(), 0, 'once');
  } finally {
    await t.close();
  }
});
