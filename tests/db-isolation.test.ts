// server/core/db.ts keeps no state that leaks from one database into another: a transaction on a second database
// inside a transaction on the first is a real transaction, and the column list of a table is per database and follows
// a migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { all, insert, migrate, tx } from '../server/core/db.js';

const ids = (db: DatabaseSync) => all<{ id: string }>(db, 'SELECT id FROM t ORDER BY id').map((r) => r.id);
const mem = (sql: string) => {
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  return db;
};

test('a transaction on another database inside a transaction is rolled back as a whole', () => {
  const a = mem('CREATE TABLE t (id TEXT PRIMARY KEY)');
  const b = mem('CREATE TABLE t (id TEXT PRIMARY KEY)');
  tx(a, () => {
    insert(a, 't', { id: 'a1' });
    assert.throws(() =>
      tx(b, () => {
        insert(b, 't', { id: 'b1' });
        throw new Error('halverwege');
      }),
    );
  });
  assert.deepEqual(ids(a), ['a1']);
  assert.deepEqual(ids(b), [], 'nothing half-written in the second database');
  // Nested on the same database: one transaction, rolled back together.
  assert.throws(() =>
    tx(a, () => {
      tx(a, () => insert(a, 't', { id: 'a2' }));
      throw new Error('toch niet');
    }),
  );
  assert.deepEqual(ids(a), ['a1']);
});

test('columns are known per database, and a migration that adds one is seen at once', () => {
  const a = mem('CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT)');
  const b = mem('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)');
  insert(a, 'notes', { id: '1', title: 'A', body: 'niet hier' });
  insert(b, 'notes', { id: '1', title: 'niet hier', body: 'B' });
  assert.deepEqual({ ...all(a, 'SELECT * FROM notes')[0] }, { id: '1', title: 'A' });
  assert.deepEqual({ ...all(b, 'SELECT * FROM notes')[0] }, { id: '1', body: 'B' });
  migrate(a, [{ id: 'notes-body', sql: 'ALTER TABLE notes ADD COLUMN body TEXT' }]);
  insert(a, 'notes', { id: '2', title: 'A2', body: 'nu wel' });
  assert.equal(all<{ body: string }>(a, "SELECT body FROM notes WHERE id = '2'")[0].body, 'nu wel');
});
