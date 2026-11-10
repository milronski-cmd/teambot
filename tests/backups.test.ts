import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { applyPendingRestore } from '../server/modules/backups/restore.js';
import backupsModule from '../server/modules/backups/index.js';

test('backup, staged restore and safety copy', async () => {
  const t = await startTestApp({ modules: [backupsModule] });
  try {
    const a = await t.agent({ name: 'Voor back-up' });
    const b = (await t.api('POST', '/backups', { wait: true })).backup;
    assert.match(b.name, /^teambot-\d{8}-\d{6}\.db$/);
    await t.api('PATCH', `/agents/${a.id}`, { name: 'Na back-up' });
    const list = await t.api('GET', '/backups');
    assert.equal(list.items.length, 1);
    // Path traversal in names is rejected.
    await assert.rejects(t.api('POST', '/backups/..%2Fteambot.db/restore'), /400|404/);
    await t.api('POST', `/backups/${b.name}/restore`);
    assert.ok((await t.api('GET', '/backups')).pending, 'a restore is staged');
    // Members cannot see backups.
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@test.local', password: 'geheim1234', role: 'member' });
    const s = t.app.ctx.auth.createSession(m.id, 'web', 'test');
    assert.equal((await fetch(`${t.app.url}/api/backups`, { headers: { authorization: `Bearer ${s.token}` } })).status, 403);
    await t.app.close();
    const safety = applyPendingRestore(t.dir);
    assert.ok(safety && fs.existsSync(safety));
    assert.ok(!fs.existsSync(path.join(t.dir, 'restore-pending.db')));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(t.dir, 'teambot.db'));
    const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(a.id) as any;
    db.close();
    assert.equal(row.name, 'Voor back-up');
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('team databases travel with a backup and come back on restore (current ones kept as safety copy)', async () => {
  const t = await startTestApp({ modules: [backupsModule] });
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const team = path.join(t.dir, 'teamdata');
    fs.mkdirSync(team, { recursive: true });
    const put = (v: string) => {
      const db = new DatabaseSync(path.join(team, 'u_test.db'));
      db.exec('CREATE TABLE IF NOT EXISTS taken (id INTEGER PRIMARY KEY, titel TEXT)');
      db.prepare('INSERT INTO taken (titel) VALUES (?)').run(v);
      db.close();
    };
    put('voor back-up');
    const b = (await t.api('POST', '/backups', { wait: true })).backup;
    const side = path.join(t.dir, 'backups', b.name.replace(/\.db$/, '.teamdata'));
    assert.ok(fs.existsSync(path.join(side, 'u_test.db')), 'team database copied next to the backup');
    put('na back-up');
    await t.api('POST', `/backups/${b.name}/restore`);
    await t.app.close();
    const safety = applyPendingRestore(t.dir)!;
    const rows = (() => {
      const db = new DatabaseSync(path.join(team, 'u_test.db'), { readOnly: true });
      const r = db.prepare('SELECT titel FROM taken ORDER BY id').all().map((x: any) => x.titel);
      db.close();
      return r;
    })();
    assert.deepEqual(rows, ['voor back-up']);
    assert.ok(fs.existsSync(path.join(safety.replace(/\.db$/, '.teamdata'), 'u_test.db')), 'current team database kept as safety copy');
    assert.ok(!fs.existsSync(path.join(t.dir, 'restore-pending.teamdata')));
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('the safety copy of a restore keeps changes that were still in the write-ahead log (TeamBot stopped hard)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-wal-live-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-wal-'));
  try {
    // The live databases in WAL mode, with the last change only in the WAL (no checkpoint, as after a crash).
    const open = (file: string) => {
      const db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
      return db;
    };
    const db = open(path.join(live, 'teambot.db'));
    db.exec("CREATE TABLE agents (id TEXT, name TEXT); INSERT INTO agents VALUES ('a1', 'Voor de back-up'); PRAGMA wal_checkpoint(TRUNCATE);");
    fs.copyFileSync(path.join(live, 'teambot.db'), path.join(dir, 'restore-pending.db'));
    db.exec("INSERT INTO agents VALUES ('a2', 'Na de back-up')");
    fs.mkdirSync(path.join(live, 'teamdata'));
    const team = open(path.join(live, 'teamdata', 'u_test.db'));
    team.exec("CREATE TABLE taken (titel TEXT); INSERT INTO taken VALUES ('in de WAL');");
    // What is on disk at a hard stop: the files plus their WAL (copied while they are still open).
    fs.mkdirSync(path.join(dir, 'teamdata'));
    for (const f of ['teambot.db', 'teambot.db-wal', 'teamdata/u_test.db', 'teamdata/u_test.db-wal']) fs.copyFileSync(path.join(live, f), path.join(dir, f));
    db.close();
    team.close();
    fs.mkdirSync(path.join(dir, 'restore-pending.teamdata'));
    const safety = applyPendingRestore(dir)!;
    const col = (file: string, sql: string) => {
      const d = new DatabaseSync(file, { readOnly: true });
      const r = d.prepare(sql).all().map((x: any) => Object.values(x)[0]);
      d.close();
      return r;
    };
    assert.deepEqual(col(safety, 'SELECT name FROM agents ORDER BY id'), ['Voor de back-up', 'Na de back-up'], 'the safety copy has the change that was only in the WAL');
    assert.deepEqual(col(path.join(dir, 'teambot.db'), 'SELECT name FROM agents ORDER BY id'), ['Voor de back-up'], 'the restored database is the back-up');
    assert.deepEqual(col(path.join(safety.replace(/\.db$/, '.teamdata'), 'u_test.db'), 'SELECT titel FROM taken'), ['in de WAL'], 'the safety copy of a team database too');
  } finally {
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
