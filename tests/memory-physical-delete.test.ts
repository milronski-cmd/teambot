import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import memory from '../server/modules/memory/index.js';

// A-47: forgetting memory must remove the text from the files on disk, not only from the tables. The database runs
// with secure_delete, and after a forget / "alles wissen" the search index is merged and the WAL emptied.

/** Every way the text can sit in the raw bytes: as typed, lower case (FTS tokens) and as UTF-16 (just in case). */
function rawHits(dir: string, words: string[]) {
  const files = ['teambot.db', 'teambot.db-wal'].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
  const hits: string[] = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    for (const w of words) {
      for (const v of [w, w.toLowerCase()]) {
        if (buf.includes(Buffer.from(v, 'utf8')) || buf.includes(Buffer.from(v, 'utf16le'))) hits.push(`${path.basename(f)}: ${v}`);
      }
    }
  }
  return hits;
}

test('secure_delete is on for the main database', async () => {
  const t = await startTestApp({ modules: [memory] });
  try {
    const r = t.app.ctx.db.prepare('PRAGMA secure_delete').get() as any;
    assert.equal(Number(Object.values(r)[0]), 1);
  } finally {
    await t.close();
  }
});

test('a forgotten memory is no longer in the database file or the WAL', async () => {
  const t = await startTestApp({ modules: [memory] });
  try {
    const words = ['Kwartelkoning', 'Zebedeusbloem'];
    const keep = await t.api('POST', '/memory/items', { content: 'Mijn fiets is blauw en heeft een mand', scope: 'about_you' });
    const r = await t.api('POST', '/memory/items', { content: `Mijn geheime bijnaam is ${words[0]} van de ${words[1]}`, scope: 'about_you' });
    const id = r.item?.id || r.id;
    assert.ok(id && keep);
    // It really is on disk first (DB or WAL), otherwise the check below proves nothing.
    assert.ok(rawHits(t.dir, words).length > 0, 'text is on disk before forgetting');
    await t.api('POST', `/memory/items/${id}/forget`, {});
    assert.deepEqual(rawHits(t.dir, words), [], 'forgotten text gone from teambot.db and teambot.db-wal');
    const wal = path.join(t.dir, 'teambot.db-wal');
    assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'WAL emptied after the forget');
    // The rest of memory still works and is still findable.
    const hits = t.app.ctx.services.memory.search(t.app.ctx.auth.owner()!.id, 'fiets');
    assert.ok(hits.length >= 1, 'other memories stay');
  } finally {
    await t.close();
  }
});

test('bulk forget and "alles wissen" leave no trace of the text in the files', async () => {
  const t = await startTestApp({ modules: [memory] });
  try {
    const a = await t.api('POST', '/memory/items', { content: 'Mijn oom Huibrecht Parelvisser woont in Zierikzee', scope: 'about_you' });
    const b = await t.api('POST', '/memory/items', { content: 'De kat van de buren heet Quirijntje', scope: 'about_you' });
    await t.api('POST', '/memory/items/bulk', { action: 'forget', ids: [a.item?.id || a.id, b.item?.id || b.id] });
    assert.deepEqual(rawHits(t.dir, ['Parelvisser', 'Quirijntje']), []);

    await t.api('POST', '/memory/items', { content: 'Mijn lievelingsboek is Wolkenkrabberdroom', scope: 'about_you' });
    await t.api('POST', '/memory/items', { content: 'Ik spaar voor een reis naar Tasmanieboog', scope: 'about_you' });
    assert.ok(rawHits(t.dir, ['Wolkenkrabberdroom']).length > 0);
    await t.api('POST', '/memory/delete-all', { confirm: 'WISSEN' });
    assert.deepEqual(rawHits(t.dir, ['Wolkenkrabberdroom', 'Tasmanieboog']), [], 'gone after alles wissen');
  } finally {
    await t.close();
  }
});
