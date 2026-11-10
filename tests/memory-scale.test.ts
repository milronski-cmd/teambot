/**
 * Writing many customer dossiers stays linear (0.4.5; docs/quality/memory-bench.md: 100 customers 18 s, 300 customers
 * 138 s). Two causes, each read the whole memory per write: the duplicate check ran an FTS query (the new text's words
 * joined with OR) over all of the owner's notes before keeping the bucket's, and the index update deleted the old FTS
 * row on UNINDEXED columns (a scan of memory_fts). Now a small bucket is compared through its own index and FTS rows
 * are removed by rowid (memory_fts_rows).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { writeCandidate } from '../server/modules/memory/pipeline.js';
import { consolidateFacts } from '../server/modules/memory/consolidate.js';

test('a write into a customer dossier reads neither the whole FTS index nor all notes; the FTS rows stay one per record', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const svc = ctx.services.memory.svc;
    const userId = ctx.auth.owner()!.id;
    const bot = await t.agent({ name: 'Klantenservice', tool_groups: ['memory'] });
    const write = (dossierId: string, content: string, k: string) =>
      writeCandidate(svc, { userId, content, scope: 'dossier', dossierId, source: { kind: 'message', trust: 'user', excerpt: content }, origin: 'model', createdBy: 'agent', createdByAgent: bot.id, idemKey: k, ownStatement: true, consolidate: false });
    for (let i = 0; i < 30; i++) {
      const d = (await t.api('POST', '/memory/dossiers', { title: `Klant ${i}`, kind: 'client' })).dossier;
      for (let k = 0; k < 10; k++) write(d.id, `Klant ${i} heeft een fiets met framemaat ${48 + k} en accu ${400 + i}`, `s-${i}-${k}`);
    }
    const last = (await t.api('POST', '/memory/dossiers', { title: 'Klant Nieuw', kind: 'client' })).dossier;

    // Every SQL statement of the next writes.
    const seen: string[] = [];
    const store = ctx.store as any;
    const orig = { all: store.all, one: store.one, exec: store.exec };
    for (const k of ['all', 'one', 'exec'] as const) store[k] = function (sql: string, ...p: any[]) {
      seen.push(sql);
      return orig[k].call(this, sql, ...p);
    };
    try {
      for (let k = 0; k < 10; k++) assert.equal(write(last.id, `Klant Nieuw woont in Zwolle en rijdt ${k + 5} kilometer`, `n-${k}`).action, 'inserted');
    } finally {
      Object.assign(store, orig);
    }
    assert.ok(!seen.some((s) => /memory_fts MATCH/.test(s)), 'the duplicate check of a small bucket uses no FTS over all notes');
    assert.ok(!seen.some((s) => /DELETE FROM memory_fts WHERE kind/.test(s)), 'the FTS row goes by rowid, not by a scan');

    // One FTS row per record, also after a change of the text; search finds the new words only.
    const fts = () => ctx.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_fts')!.n;
    const map = () => ctx.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_fts_rows')!.n;
    assert.equal(fts(), map());
    const it = ctx.store.one<any>("SELECT * FROM memory_items WHERE dossier_id = ? AND status = 'active' LIMIT 1", last.id);
    await t.api('PATCH', `/memory/items/${it.id}`, { content: 'Klant Nieuw woont nu in Deventer' });
    assert.equal(fts(), map(), 'still one row per record');
    const hits = (q: string) => ctx.store.all<any>("SELECT rid FROM memory_fts WHERE memory_fts MATCH ? AND kind = 'item'", q).map((r) => r.rid);
    assert.ok(hits('Deventer').length >= 1);
    assert.equal(ctx.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM memory_fts WHERE kind = 'item' AND rid = ?", it.id)!.n, 1);

    // The background re-read of a changed dossier checks its new notes against that dossier (consolidate.ts), not by
    // searching the owner's whole memory or reading all of it newest first (that made every customer cost more).
    const fresh = ctx.store.one<any>("SELECT * FROM memory_items WHERE dossier_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1", last.id);
    const sql2: string[] = [];
    const before2 = { all: store.all, one: store.one };
    for (const k of ['all', 'one'] as const) store[k] = function (sql: string, ...p: any[]) {
      sql2.push(sql);
      return before2[k].call(this, sql, ...p);
    };
    try {
      await consolidateFacts(svc, { userId, agent: null, facts: [{ row: ctx.store.decode('memory_items', fresh), trust: 'agent' }], choice: null });
    } finally {
      Object.assign(store, before2);
    }
    assert.ok(!sql2.some((s) => /memory_fts MATCH/.test(s)), 'no word search over all notes for a dossier note');
    assert.ok(!sql2.some((s) => /ORDER BY i\.updated_at DESC LIMIT 300/.test(s)), 'no scan of all notes for open tasks');
  } finally {
    await t.close();
  }
});
