import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestApp } from './helpers.js';
import { createApp } from '../server/app.js';
import { applyPendingRestore } from '../server/modules/backups/restore.js';
import backupsModule from '../server/modules/backups/index.js';
import memory from '../server/modules/memory/index.js';

test('forgotten memory stays forgotten after restoring an older backup', async () => {
  const t = await startTestApp({ modules: [memory, backupsModule] });
  const dir = t.dir;
  const owner = t.app.ctx.auth.owner()!.id;
  let itemId = '';
  try {
    const r = await t.api('POST', '/memory/items', { content: 'Ik eet op zondag altijd pasta bij oma', scope: 'about_you' });
    itemId = r.item?.id || r.id || r.row?.id;
    assert.ok(itemId, 'item created: ' + JSON.stringify(r).slice(0, 200));
    const b = (await t.api('POST', '/backups', { wait: true })).backup;
    await t.api('POST', `/memory/items/${itemId}/forget`, {});
    await t.api('POST', `/backups/${b.name}/restore`);
    await t.app.close();
  } catch (e) {
    await t.app.close().catch(() => {});
    throw e;
  }
  assert.ok(applyPendingRestore(dir));
  assert.ok(fs.existsSync(`${dir}/restore-tombstones.json`), 'tombstones carried over');
  const app2 = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: [memory] });
  try {
    const row = app2.ctx.store.one<any>('SELECT status, content FROM memory_items WHERE id = ?', itemId);
    assert.ok(!row || row.status === 'forgotten', 'item from the old backup is forgotten again');
    assert.ok(!row || !String(row.content || '').includes('oma'), 'content scrubbed');
    assert.ok((app2.ctx.store.one<any>("SELECT COUNT(*) n FROM memory_tombstones WHERE user_id = ? AND kind = 'forget'", owner)?.n || 0) >= 1, 'tombstone restored');
    assert.ok(!fs.existsSync(`${dir}/restore-tombstones.json`), 'carry-over file consumed');
    const hits = app2.ctx.services.memory.search(owner, 'oma');
    assert.equal(hits.length, 0, 'not findable');
  } finally {
    await app2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
