import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { startTestApp } from './helpers.js';

// The full-text index is kept in sync through a rowid map (core-002-fts-map). Correctness + no full-index scans.
test('search index follows new, edited, deleted messages and deleted conversations; inserts stay fast', async () => {
  const t = await startTestApp();
  try {
    const s = t.app.ctx.store;
    const owner = t.app.ctx.auth.owner()!;
    const a = await t.agent();
    const th = s.createThread({ user_id: owner.id, agent_id: a.id });
    const other = s.createThread({ user_id: owner.id, agent_id: a.id });
    const m = s.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: owner.id, author_name: 'Ik', content: 'De zeppelin landt morgen' });
    s.createMessage({ thread_id: other.id, role: 'user', author_type: 'user', author_id: owner.id, author_name: 'Ik', content: 'Nog een zeppelin' });
    const hits = (q: string) => s.search(owner.id, q).map((h: any) => h.message_id);
    assert.deepEqual(hits('landt'), [m.id]);
    assert.equal(hits('zeppelin').length, 2);

    s.updateMessage(m.id, { content: 'De luchtballon stijgt' });
    assert.deepEqual(hits('landt'), []);
    assert.deepEqual(hits('luchtballon'), [m.id]);
    assert.equal(s.one<any>('SELECT COUNT(*) n FROM messages_fts_map WHERE message_id = ?', m.id).n, 1);

    s.updateMessage(m.id, { deleted: true });
    assert.deepEqual(hits('luchtballon'), []);
    assert.equal(s.one<any>('SELECT COUNT(*) n FROM messages_fts_map WHERE message_id = ?', m.id).n, 0);

    s.deleteThread(other.id);
    assert.deepEqual(hits('zeppelin'), []);
    assert.equal(s.one<any>('SELECT COUNT(*) n FROM messages_fts_map WHERE thread_id = ?', other.id).n, 0);
    // FTS rows and map rows stay one-to-one.
    assert.equal(s.one<any>('SELECT COUNT(*) n FROM messages_fts').n, s.one<any>('SELECT COUNT(*) n FROM messages_fts_map').n);

    // No longer O(total messages) per insert: the last 1000 of 6000 are not much slower than the first 1000.
    const timed = (n: number) => {
      const t0 = performance.now();
      s.tx(() => {
        for (let i = 0; i < n; i++) s.createMessage({ thread_id: th.id, role: 'assistant', author_type: 'agent', author_id: a.id, author_name: 'Bot', content: `antwoord nummer ${i} over planning` });
      });
      return performance.now() - t0;
    };
    const first = timed(1000);
    timed(4000);
    const last = timed(1000);
    assert.ok(last < first * 4 + 50, `inserts slowed down: first ${first.toFixed(0)} ms, last ${last.toFixed(0)} ms`);
  } finally {
    await t.close();
  }
});

test('migration core-002 rebuilds the search index of an existing database', async () => {
  const { createApp } = await import('../server/app.js');
  const t = await startTestApp();
  const s = t.app.ctx.store;
  const owner = t.app.ctx.auth.owner()!;
  const a = await t.agent();
  const th = s.createThread({ user_id: owner.id, agent_id: a.id });
  const m = s.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: owner.id, author_name: 'Ik', content: 'oude database met kangoeroe' });
  s.createMessage({ thread_id: th.id, role: 'tool', author_type: 'system', author_name: 'tool', content: 'toolregel kangoeroe' });
  // Make it look like a database from before the migration: no map, FTS rows with arbitrary rowids.
  s.exec('DROP TABLE messages_fts_map');
  s.exec("DELETE FROM _migrations WHERE id = 'core-002-fts-map'");
  s.exec('DELETE FROM messages_fts');
  s.exec("INSERT INTO messages_fts (rowid, content, message_id, thread_id, user_id) VALUES (999, 'oude database met kangoeroe', ?, ?, ?)", m.id, th.id, owner.id);
  const dir = t.dir;
  await t.app.close();
  const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  try {
    const st = app.ctx.store;
    assert.deepEqual(st.search(owner.id, 'kangoeroe').map((h: any) => h.message_id), [m.id]);
    assert.equal(st.one<any>('SELECT COUNT(*) n FROM messages_fts_map').n, 1);
    st.updateMessage(m.id, { content: 'nieuwe tekst over wombats' });
    assert.deepEqual(st.search(owner.id, 'kangoeroe'), []);
    assert.deepEqual(st.search(owner.id, 'wombats').map((h: any) => h.message_id), [m.id]);
  } finally {
    await app.close();
    await t.close().catch(() => {});
  }
});
