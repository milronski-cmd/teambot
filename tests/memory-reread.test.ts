/**
 * 0.4.4 reread.ts: a dossier whose content changes is read again. A new version of a document replaces the old one
 * (old one in the history, no longer searched; the same text again changes nothing); facts the new text still states
 * are confirmed, the others are re-read with a free model (changed → new version, gone → no longer holds) or, without
 * one, become "te controleren"; NU drops what no longer holds. Debounced, and every step can be undone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, startTestApp, type TestApp } from './helpers.js';
import { setShortCallFake } from '../server/agent/short-call.js';
import { rereadDue } from '../server/modules/memory/reread.js';

const V1 = ['Afspraken met De Vries Fietsen 2026.', 'De levering van de twintig frames is op 12 maart.', 'De Vries krijgt 5 procent korting op de eerste bestelling.', 'Betaling binnen 30 dagen na de levering.'].join('\n\n');
const V2 = ['Afspraken met De Vries Fietsen 2026, bijgewerkt.', 'De levering van de twintig frames is op 19 maart.', 'Betaling binnen 30 dagen na de levering.'].join('\n\n');
const FACTS = ['De levering van de twintig frames is op 12 maart', 'De Vries krijgt 5 procent korting op de eerste bestelling', 'Betaling binnen 30 dagen na de levering'];
const SUMMARY = 'De Vries Fietsen bestelt twintig frames. De levering van de twintig frames is op 12 maart. De Vries krijgt 5 procent korting op de eerste bestelling.';

async function setup(t: TestApp) {
  const mem = t.app.ctx.services.memory;
  const u = t.app.ctx.auth.owner()!.id;
  const d = (await t.api('POST', '/memory/dossiers', { title: 'Klant De Vries Fietsen' })).dossier;
  const src = await t.api('POST', `/memory/dossiers/${d.id}/sources`, { kind: 'note', title: 'Afspraken De Vries', text: V1 });
  const ids = FACTS.map((f, i) => mem.remember(u, { content: f, scope: 'dossier', dossierId: d.id, source: { kind: 'file', ref: src.id, excerpt: f, trust: 'system' }, createdBy: 'user', idemKey: `rr-${i}` }).item!.id);
  await t.api('PATCH', `/memory/dossiers/${d.id}`, { summary: SUMMARY });
  await rereadDue(mem.svc, { force: true, choice: null });
  return { d, src, ids, u };
}

test('a new version of a document: replaces the old one; without a model the facts it still states are confirmed, the rest "te controleren"; NU drops them', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const { d, src, ids } = await setup(t);
    const svc = t.app.ctx.services.memory.svc;
    // The same text again: nothing changes.
    const same = await t.api('POST', `/memory/dossiers/${d.id}/sources`, { kind: 'note', title: 'Afspraken De Vries', text: V1 });
    assert.equal(same.id, src.id);
    const v2 = await t.api('POST', `/memory/dossiers/${d.id}/sources`, { kind: 'note', title: 'Afspraken De Vries', text: V2 });
    assert.notEqual(v2.id, src.id);
    assert.equal(t.app.ctx.store.get<any>('memory_sources', src.id).status, 'superseded', 'the old version is history');
    assert.ok(t.app.ctx.store.get<any>('memory_dossiers', d.id).changed_at, 'the dossier is marked as changed');
    // Debounced: not read right away …
    assert.equal((await rereadDue(svc, { choice: null })).length, 0);
    // … and then once.
    const [r] = await rereadDue(svc, { force: true, choice: null });
    assert.equal(r.confirmed, 1, 'the payment term is still in the new version');
    assert.equal(r.check, 2);
    const item = (id: string) => t.app.ctx.store.get<any>('memory_items', id);
    assert.equal(item(ids[2]).source_ref, v2.id, 'a confirmed fact points to the new version');
    assert.ok((item(ids[0]).flags || []).includes('check') && (item(ids[1]).flags || []).includes('check'), 'never a silent change without a model');
    const dossier = t.app.ctx.store.get<any>('memory_dossiers', d.id);
    assert.doesNotMatch(dossier.summary, /12 maart|5 procent/, 'NU no longer says what must be checked');
    assert.match(dossier.summary, /twintig frames/);
    // The old version is not searched any more.
    const hits = svc.chunkMatch([t.app.ctx.auth.owner()!.id], 'levering frames maart', null, 10, d.id);
    const texts = hits.map((h: any) => t.app.ctx.store.one<any>('SELECT text FROM memory_chunks WHERE id = ?', h.rid)?.text).join(' ');
    assert.match(texts, /19 maart/);
    assert.doesNotMatch(texts, /12 maart/);
    // Read once: nothing more to do.
    assert.equal((await rereadDue(svc, { force: true, choice: null })).length, 0);
  } finally {
    await t.close();
  }
});

test('with a free model: changed → a new version from the new text, gone → no longer holds (with a reason, undoable), NU rewritten', async () => {
  const t = await startTestApp();
  try {
    t.app.ctx.providers.registerKind({ id: 'mock-local', label: 'Lokaal testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'test', models: ['lokaal-1'], defaultModel: 'lokaal-1', create: () => mockAdapter(t.script, t.requests) });
    await t.api('POST', '/providers', { kind: 'mock-local' });
    const { d, ids } = await setup(t);
    let prompts = 0;
    setShortCallFake((system, prompt) => {
      if (/nieuwe versie/.test(system) && /<feit>/.test(prompt)) {
        prompts++;
        if (/12 maart/.test(prompt)) return JSON.stringify({ status: 'changed', new: 'De levering van de twintig frames is op 19 maart', quote: 'De levering van de twintig frames is op 19 maart' });
        if (/5 procent/.test(prompt)) return JSON.stringify({ status: 'gone', quote: '' });
        return JSON.stringify({ status: 'same', quote: 'iets dat er niet staat' });
      }
      if (/blok "NU"/.test(system)) return JSON.stringify({ summary: 'De Vries Fietsen bestelt twintig frames, levering op 19 maart. Betaling binnen 30 dagen.' });
      return '{}';
    });
    await t.api('POST', `/memory/dossiers/${d.id}/sources`, { kind: 'note', title: 'Afspraken De Vries', text: V2 });
    await t.app.ctx.services.memory.drain();
    const item = (id: string) => t.app.ctx.store.get<any>('memory_items', id);
    assert.equal(prompts, 2, 'only the facts the new text does not state are re-read (delta)');
    assert.equal(item(ids[0]).status, 'superseded');
    const neu = t.app.ctx.store.one<any>("SELECT * FROM memory_items WHERE supersedes_id = ? AND status = 'active'", ids[0]);
    assert.match(neu.content, /19 maart/, 'changed: the new version');
    assert.equal(item(ids[1]).status, 'superseded', 'gone: no longer holds');
    assert.match(item(ids[1]).invalid_reason, /staat niet meer/);
    assert.equal(item(ids[2]).status, 'active');
    assert.match(t.app.ctx.store.get<any>('memory_dossiers', d.id).summary, /19 maart/);
    // Undo of the "gone" step brings the fact back.
    const ch = t.app.ctx.store.one<any>("SELECT id FROM memory_changes WHERE record_id = ? AND op = 'invalidate'", ids[1]);
    await t.api('POST', `/memory/changes/${ch.id}/undo`);
    assert.equal(item(ids[1]).status, 'active');
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test('a note, a record or a closed action marks the dossier as changed; a reread does not mark it again', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const svc = t.app.ctx.services.memory.svc;
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Project Zolder' })).dossier;
    const changed = () => t.app.ctx.store.get<any>('memory_dossiers', d.id).changed_at;
    const rec = (await t.api('POST', `/memory/dossiers/${d.id}/records`, { kind: 'action', title: 'Offerte aannemer opvragen' })).record;
    assert.ok(changed());
    await rereadDue(svc, { force: true, choice: null });
    const read = t.app.ctx.store.get<any>('memory_dossiers', d.id).reread_at;
    assert.ok(read >= changed(), 'read');
    await new Promise((r) => setTimeout(r, 5));
    await t.api('PATCH', `/memory/records/${rec.id}`, { status: 'done' });
    assert.ok(changed() > read, 'a closed action changes the dossier');
  } finally {
    await t.close();
  }
});
